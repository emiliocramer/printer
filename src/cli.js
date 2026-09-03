#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extractArticle } from './extract.js';
import { renderDocument } from './render.js';
import { captureRenderedPage, captureClientPage, startPreviewServer, printPdf, openPreview, inspectPdf } from './browser.js';

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
  const browser = options.browser ?? { capture: captureRenderedPage, captureClient: captureClientPage, startPreview: startPreviewServer, pdf: printPdf, open: openPreview, inspect: inspectPdf };
  await mkdir(paths.assetsDir, { recursive: true });
  let preview;
  try {
    const extract = options.extract ?? extractArticle;
    const readable = (article) => Boolean(String(article?.content ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()) && article?.metadata?.title !== 'Untitled article';
    const attempt = async (capture) => {
      const captured = await capture();
      const article = await extract(captured.html, captured.finalUrl ?? url, options.retrievedDate);
      return { captured, article };
    };
    // Sites that fingerprint headless browsers sometimes answer with an empty
    // shell instead of an error, so an empty extraction gets the same second
    // chance as a hard failure before we give up.
    const headless = () => browser.capture(url, { assetsDir: paths.assetsDir, playwright: options.playwright });
    const client = typeof browser.captureClient === 'function' ? () => browser.captureClient(url, { assetsDir: paths.assetsDir, playwright: options.playwright }) : null;
    let result;
    try {
      result = await attempt(headless);
      if (!readable(result.article)) result = await attempt(headless);
      if (!readable(result.article) && client) result = await attempt(client);
    } catch (error) {
      if (error?.code !== 'PAGE_INACCESSIBLE' || !client) throw error;
      result = await attempt(client);
    }
    const { article } = result;
    if (!readable(article)) throw new CliError('The page loaded without readable article content.');
    const html = options.render ? options.render(article) : renderDocument(article);
    await writeFile(paths.htmlPath, html);
    const styles = await readFile(new URL('./styles.css', import.meta.url));
    await writeFile(paths.stylesPath, styles);
    preview = await browser.startPreview({ directory: paths.documentDir });
    const audit = await browser.pdf(preview.url, paths.pdfPath, { playwright: options.playwright }) ?? {};
    const inspection = typeof browser.inspect === 'function' ? await browser.inspect(paths.pdfPath).catch(() => null) : null;
    const report = summarizeRun(article, audit, inspection);
    if (!options.noPreview) await browser.open(preview.url);
    return { paths, previewUrl: preview.url, report };
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

/** Turn the render audit and PDF inspection into something worth reading in a terminal. */
export function summarizeRun(article, audit = {}, inspection = null) {
  const words = String(article?.content ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  const figures = Number(audit.images ?? 0);
  const warnings = [...(inspection?.warnings ?? [])];
  if (audit.removedBrokenImages) warnings.push(`${audit.removedBrokenImages} image${audit.removedBrokenImages === 1 ? '' : 's'} could not be loaded and ${audit.removedBrokenImages === 1 ? 'was' : 'were'} left out`);
  if (inspection && inspection.pageCount > 2) {
    const imageOnly = inspection.pages.filter((page) => !page.blank && page.characters < 12 && page.images > 0).map((page) => page.number);
    if (imageOnly.length) warnings.push(`page${imageOnly.length > 1 ? 's' : ''} ${imageOnly.join(', ')} contain${imageOnly.length > 1 ? '' : 's'} only graphics`);
  }
  return { pages: inspection?.pageCount ?? null, words, figures, blankPages: inspection?.blankPages ?? [], warnings };
}

const USAGE = 'Usage: printer print <URL> [--no-preview] [--keep-source]';
export function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  if (args.shift() !== 'print') throw new CliError(USAGE);
  const unknown = args.find((arg) => arg.startsWith('--') && !['--no-preview', '--keep-source'].includes(arg));
  if (unknown) throw new CliError(`Unknown option ${unknown}. ${USAGE}`);
  const noPreview = args.includes('--no-preview');
  const keepSource = args.includes('--keep-source');
  const url = args.find((arg) => !arg.startsWith('--'));
  if (!url) throw new CliError(USAGE);
  return { url, noPreview, keepSource };
}

function describeReport(report) {
  if (!report) return '';
  const parts = [];
  if (report.pages) parts.push(`${report.pages} page${report.pages === 1 ? '' : 's'}`);
  if (report.words) parts.push(`${report.words.toLocaleString('en-US')} words`);
  parts.push(`${report.figures} figure${report.figures === 1 ? '' : 's'}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

export async function main(argv = process.argv.slice(2), { runPrint: execute = runPrint, log = console.log, error = console.error } = {}) {
  try {
    const args = parseArgs(argv);
    const result = await execute(args.url, { ...args, keepSource: Boolean(args.keepSource) });
    log(`Wrote ${result.paths.pdfPath}${describeReport(result.report)}`);
    for (const warning of result.report?.warnings ?? []) error(`printer: warning: ${warning}`);
    if (args.keepSource) log(`Kept source files in ${result.paths.documentDir}`);
    return 0;
  } catch (cause) {
    error(`printer: ${cause.message}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
