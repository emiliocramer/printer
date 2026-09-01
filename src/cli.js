#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { extractArticle } from './extract.js';
import { renderDocument } from './render.js';
import { captureRenderedPage, captureClientPage, startPreviewServer, printPdf, openPreview } from './browser.js';

export class CliError extends Error {}

export function validateUrl(input) {
  let url;
  try { url = new URL(String(input ?? '').trim()); } catch { throw new CliError('Please provide a valid URL using http or https.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || url.hostname === 'localhost' || /^127(?:\.|$)/.test(url.hostname) || url.hostname === '::1') {
    throw new CliError('Please provide a public HTTP or HTTPS URL without credentials.');
  }
  url.hash = url.hash;
  return url;
}

export function slugForUrl(input) {
  const url = validateUrl(input);
  const value = `${url.hostname}${url.port ? `-${url.port}` : ''}${url.pathname}${url.search}`.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/%[0-9a-f]{2}/gi, ' ').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return value || 'article';
}

export function resolveOutputPaths(input, { outputDir = process.env.PRINTER_OUTPUT_DIR || path.join(os.homedir(), 'Documents', 'printer') } = {}) {
  const slug = slugForUrl(input);
  const rootDir = path.resolve(outputDir);
  const documentDir = path.join(rootDir, slug);
  return { rootDir, slug, documentDir, assetsDir: path.join(documentDir, 'assets'), htmlPath: path.join(documentDir, 'index.html'), stylesPath: path.join(documentDir, 'styles.css'), pdfPath: path.join(rootDir, `${slug}.pdf`) };
}
function captureUrl(input) {
  const url = new URL(input);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_[^]+|fbclid|gclid|triedRedirect|r)$/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

export async function runPrint(input, options = {}) {
  const url = captureUrl(validateUrl(input).href);
  const paths = resolveOutputPaths(url, options);
  const browser = options.browser ?? { capture: captureRenderedPage, captureClient: captureClientPage, startPreview: startPreviewServer, pdf: printPdf, open: openPreview };
  await mkdir(paths.assetsDir, { recursive: true });
  let preview;
  try {
    let captured;
    try {
      captured = await browser.capture(url, { assetsDir: paths.assetsDir, playwright: options.playwright });
    } catch (error) {
      if (error?.code !== 'PAGE_INACCESSIBLE' || typeof browser.captureClient !== 'function') throw error;
      captured = await browser.captureClient(url, { assetsDir: paths.assetsDir, playwright: options.playwright });
    }
    const article = options.extract ? await options.extract(captured.html, captured.finalUrl ?? url, options.retrievedDate) : extractArticle(captured.html, captured.finalUrl ?? url, options.retrievedDate);
    const readableText = String(article?.content ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!readableText || article?.metadata?.title === 'Untitled article') throw new CliError('The page loaded without readable article content.');
    const html = options.render ? options.render(article) : renderDocument(article);
    await writeFile(paths.htmlPath, html);
    const styles = await readFile(new URL('./styles.css', import.meta.url));
    await writeFile(paths.stylesPath, styles);
    preview = await browser.startPreview({ directory: paths.documentDir });
    await browser.pdf(preview.url, paths.pdfPath, { playwright: options.playwright });
    if (!options.noPreview) await browser.open(preview.url);
    return { paths, previewUrl: preview.url };
  } catch (error) {
    if (error?.code === 'BROWSER_MISSING') {
      throw Object.assign(new CliError('Chromium is unavailable. Run `npx playwright install chromium` and try again.'), { code: 'BROWSER_MISSING', cause: error });
    }
    if (error?.code === 'PAGE_INACCESSIBLE') {
      throw Object.assign(new CliError(`Could not load ${url}: ${error.message}`), { code: 'PAGE_INACCESSIBLE', cause: error });
    }
    throw error;
  } finally {
    if (preview?.close) await preview.close();
    if (options.keepSource === false) await rm(paths.documentDir, { recursive: true, force: true });
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  if (args.shift() !== 'print') throw new CliError('Usage: printer print <URL> [--no-preview]');
  const noPreview = args.includes('--no-preview');
  const url = args.find((arg) => !arg.startsWith('--'));
  if (!url) throw new CliError('Usage: printer print <URL> [--no-preview]');
  return { url, noPreview };
}

export async function main(argv = process.argv.slice(2), { runPrint: execute = runPrint, log = console.log, error = console.error } = {}) {
  try {
    const args = parseArgs(argv);
    const result = await execute(args.url, { ...args, keepSource: false });
    log(`Wrote ${result.paths.pdfPath}`);
    return 0;
  } catch (cause) {
    error(`printer: ${cause.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) process.exitCode = await main();
