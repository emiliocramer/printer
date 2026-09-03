import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

function browserError(error) {
  const message = String(error?.message ?? error);
  if (/executable|chromium|browserType\.launch/i.test(message)) {
    return Object.assign(new Error('Chromium is unavailable. Run `npx playwright install chromium` and try again.'), { code: 'BROWSER_MISSING', cause: error });
  }
  return Object.assign(new Error(`Could not load page: ${message}`), { code: 'PAGE_INACCESSIBLE', cause: error });
}
function looksLikeInterstitial(html) {
  return /just a moment|verify you are human|checking your browser|enable javascript and cookies|access denied|request blocked|error\s*403|robot check/i.test(String(html ?? '').slice(0, 20000));
}
export async function waitForReadablePage(page, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let html = await page.content();
  while (looksLikeInterstitial(html) && Date.now() < deadline) {
    await page.waitForTimeout(intervalMs);
    html = await page.content();
  }
  if (looksLikeInterstitial(html)) throw new Error('The page still shows an access challenge after client verification.');
  return html;
}

async function directArticleFetch(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'printer/1.0 (reader)' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return { html: await response.text(), finalUrl: response.url || url };
  } finally { clearTimeout(timer); }
}

async function launchReadableBrowser(chromium, options = {}) {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true, ...options });
  } catch {
    return await chromium.launch(options);
  }
}

export async function captureRenderedPage(url, { assetsDir, playwright, stabilityMs = 150 } = {}) {
  let chromium;
  try {
    ({ chromium } = playwright ?? await import('playwright'));
    const browser = await launchReadableBrowser(chromium);
    try {
      const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(Math.min(Math.max(Number(stabilityMs) || 0, 0), 2000));
      let html = await page.content();
      let finalUrl = await page.url();
      let usedFallback = false;
      if (looksLikeInterstitial(html)) {
        try {
          html = await waitForReadablePage(page, { timeoutMs: 6000 });
          finalUrl = await page.url();
        } catch {
          const fallback = await directArticleFetch(finalUrl || url);
          if (fallback && !looksLikeInterstitial(fallback.html)) {
            html = fallback.html;
            finalUrl = fallback.finalUrl;
            usedFallback = true;
          }
          if (looksLikeInterstitial(html)) throw new Error('The page returned an access interstitial instead of article content.');
        }
      }
      if (!usedFallback) html = await prepareVisuals(page, html, assetsDir);
      return { html, finalUrl, title: await page.title() };
    } finally { await browser.close(); }
  } catch (error) { throw browserError(error); }
}
async function askUser(message, prompt) {
  if (prompt) return prompt(message);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try { return await readline.question(message); } finally { readline.close(); }
}

/**
 * Visible browser with a persistent profile. Used for access challenges and
 * for signing in to publishers; `review` lets the caller inspect a capture
 * and ask for another pass (for example after the reader logs in).
 */
export async function captureClientPage(url, { assetsDir, playwright, prompt, review, maxAttempts = 3, profileDir = path.join(process.env.HOME || '.', 'Library', 'Application Support', 'printer', 'browser-profile') } = {}) {
  let chromium;
  try {
    ({ chromium } = playwright ?? await import('playwright'));
    const context = await chromium.launchPersistentContext(profileDir, { headless: false });
    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(500);
      let html;
      if (looksLikeInterstitial(await page.content())) {
        try {
          html = await waitForReadablePage(page, { timeoutMs: 8000 });
        } catch {
          await askUser('Complete the browser verification, then press Enter here to continue. ', prompt);
          html = await waitForReadablePage(page);
        }
      } else {
        html = await waitForReadablePage(page);
      }
      for (let attempt = 1; ; attempt += 1) {
        const finalUrl = await page.url();
        const captured = { html: await prepareVisuals(page, html, assetsDir), finalUrl, title: await page.title() };
        const objection = review ? await review(captured) : null;
        if (!objection || attempt >= maxAttempts) return captured;
        await askUser(`${objection}\nSign in or dismiss the barrier in the browser window, then press Enter here to capture again. `, prompt);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(500);
        html = await waitForReadablePage(page);
      }
    } finally { await context.close(); }
  } catch (error) { throw browserError(error); }
}

async function prepareVisuals(page, html, assetsDir) {
  try {
    await settleLazyMedia(page);
    await annotateVisuals(page);
  } catch { return assetsDir ? localizeAssets(page, html, assetsDir) : html; }
  const annotated = await page.content();
  return assetsDir ? localizeAssets(page, annotated, assetsDir) : annotated;
}

/**
 * Force lazy-loaded media to resolve. Many publishers only assign the real
 * image URL when the element scrolls into view, so we walk the page once and
 * promote the common data-* lazy attributes before asking the browser to load.
 */
export async function settleLazyMedia(page, { maxScrollSteps = 80, stepDelayMs = 60, imageTimeoutMs = 6000 } = {}) {
  await page.evaluate(async ({ maxScrollSteps, stepDelayMs }) => {
    const lazySrc = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-image'];
    const lazySrcset = ['data-srcset', 'data-lazy-srcset'];
    for (const img of document.querySelectorAll('img')) {
      img.setAttribute('loading', 'eager');
      const current = img.getAttribute('src') || '';
      const replacement = lazySrc.map((name) => img.getAttribute(name)).find(Boolean);
      if (replacement && (!current || /^data:|^about:blank$/i.test(current))) img.setAttribute('src', replacement);
      const replacementSet = lazySrcset.map((name) => img.getAttribute(name)).find(Boolean);
      if (replacementSet && !img.getAttribute('srcset')) img.setAttribute('srcset', replacementSet);
    }
    for (const source of document.querySelectorAll('picture source')) {
      const replacementSet = lazySrcset.map((name) => source.getAttribute(name)).find(Boolean);
      if (replacementSet && !source.getAttribute('srcset')) source.setAttribute('srcset', replacementSet);
    }
    const step = Math.max(window.innerHeight, 400);
    const total = document.documentElement.scrollHeight;
    for (let y = 0, count = 0; y < total && count < maxScrollSteps; y += step, count += 1) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    }
    window.scrollTo(0, 0);
  }, { maxScrollSteps, stepDelayMs });
  await page.evaluate((timeoutMs) => Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
    setTimeout(resolve, timeoutMs);
  })))), imageTimeoutMs);
}

/**
 * Record how each visual actually rendered so extraction can distinguish
 * article figures from interface icons without guessing from markup alone.
 */
export async function annotateVisuals(page) {
  await page.evaluate(() => {
    const box = (element) => { const rect = element.getBoundingClientRect(); return `${Math.round(rect.width)}x${Math.round(rect.height)}`; };
    for (const element of document.querySelectorAll('img, svg, picture, figure, video, iframe, canvas')) element.setAttribute('data-printer-box', box(element));
    for (const img of document.images) {
      img.setAttribute('data-printer-natural', `${img.naturalWidth}x${img.naturalHeight}`);
      if (img.currentSrc && !/^data:/i.test(img.currentSrc)) img.setAttribute('data-printer-src', img.currentSrc);
    }
  });
}

function assetFilename(assetUrl, contentType = '') {
  let base = 'asset';
  try { base = path.basename(decodeURIComponent(new URL(assetUrl).pathname)) || 'asset'; } catch {}
  base = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'asset';
  if (!path.extname(base)) {
    const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/avif': '.avif' }[contentType.split(';')[0].trim()];
    if (extension) base += extension;
  }
  return base.length > 120 ? `${base.slice(0, 80)}-${createHash('sha256').update(base).digest('hex').slice(0, 8)}${path.extname(base)}` : base;
}

async function fetchAsset(page, assetUrl) {
  if (page?.request?.get) {
    try {
      const response = await page.request.get(assetUrl, { timeout: 15000 });
      if (response.ok()) return { body: Buffer.from(await response.body()), contentType: response.headers()['content-type'] || '' };
    } catch {}
  }
  const response = await fetch(assetUrl);
  if (!response.ok) return null;
  return { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers?.get?.('content-type') || '' };
}

async function localizeAssets(page, html, assetsDir) {
  await mkdir(assetsDir, { recursive: true });
  const urls = await page.evaluate(() => [...document.querySelectorAll('img, source[src], svg image[href], svg image')].map((node) => {
    const value = node.getAttribute('data-printer-src') || node.getAttribute('href') || node.getAttribute('xlink:href') || node.getAttribute('src') || node.currentSrc || node.src || node.href?.baseVal;
    if (!value || /^data:/i.test(value)) return null;
    try { return new URL(value, document.baseURI).href; } catch { return value; }
  }).filter(Boolean));
  const replacements = {};
  for (const assetUrl of [...new Set(Array.isArray(urls) ? urls : [])]) {
    try {
      if (!/^https?:/i.test(assetUrl)) continue;
      const asset = await fetchAsset(page, assetUrl);
      if (!asset || !asset.body.length) continue;
      const safeBase = assetFilename(assetUrl, asset.contentType);
      let filename = safeBase;
      try {
        await writeFile(path.join(assetsDir, filename), asset.body, { flag: 'wx' });
      } catch {
        const extension = path.extname(safeBase);
        const stem = extension ? safeBase.slice(0, -extension.length) : safeBase;
        filename = `${stem}-${createHash('sha256').update(assetUrl).digest('hex').slice(0, 10)}${extension}`;
        try { await writeFile(path.join(assetsDir, filename), asset.body, { flag: 'wx' }); } catch { continue; }
      }
      replacements[assetUrl] = filename;
    } catch { /* retain remote URL when localization fails */ }
  }
  if (!Object.keys(replacements).length) return html;
  await page.evaluate((mapping) => {
    for (const node of document.querySelectorAll('img, source[src], svg image[href], svg image')) {
      const raw = node.getAttribute('data-printer-src') || node.getAttribute('href') || node.getAttribute('xlink:href') || node.getAttribute('src') || node.currentSrc || node.src || node.href?.baseVal;
      let value;
      try { value = new URL(raw, document.baseURI).href; } catch { value = raw; }
      const filename = mapping[value];
      if (!filename) continue;
      if (node.tagName.toLowerCase() === 'image') node.setAttribute('href', `./assets/${filename}`);
      else if (node.tagName.toLowerCase() === 'source') node.setAttribute('src', `./assets/${filename}`);
      else {
        // Keep the remote URL as src so readability heuristics still see a real
        // image; extraction swaps in the local copy from data-printer-asset.
        node.setAttribute('data-printer-asset', filename);
        if (!node.getAttribute('src') || /^data:/i.test(node.getAttribute('src'))) node.setAttribute('src', value);
      }
    }
  }, replacements);
  return await page.content();
}


const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
/** Chromium will not paint an SVG image served as an octet stream, so types matter here. */
export function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function startPreviewServer({ directory, port = 0 } = {}) {
  const server = createServer(async (request, response) => {
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    const file = path.resolve(directory, relative);
    if (!file.startsWith(path.resolve(directory) + path.sep)) { response.writeHead(403); response.end('Forbidden'); return; }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': contentTypeFor(file) }); response.end(body);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({ url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

export async function populatePortraitPanels(page) {
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll('figure')];
    for (const figure of candidates) {
      if (figure.dataset.figureTreatment) continue;
      const source = figure.querySelector(':scope > img, :scope > svg');
      const hint = `${figure.className} ${figure.getAttribute('alt') || ''} ${figure.textContent || ''}`.toLowerCase();
      const semantic = /timeline|time line|chronology|chart|graph|diagram|architecture|roadmap|process|flow/.test(hint);
      const width = source?.naturalWidth || source?.viewBox?.baseVal?.width || source?.width?.baseVal?.value || source?.width || 0;
      const height = source?.naturalHeight || source?.viewBox?.baseVal?.height || source?.height?.baseVal?.value || source?.height || 0;
      if (source && semantic && width > 0 && height > 0 && width / height >= 1.6) figure.dataset.figureTreatment = 'stacked-portrait-panels';
    }
    const figures = document.querySelectorAll('figure[data-figure-treatment="stacked-portrait-panels"]');
    for (const figure of figures) {
      if (figure.dataset.portraitPanelsPopulated === 'true') continue;
      const source = figure.querySelector('.figure-panel[data-panel-role="source"] img, .figure-panel[data-panel-role="source"] svg, :scope > img, :scope > svg');
      if (!source) continue;

      let width;
      let height;
      if (source.tagName.toLowerCase() === 'img') {
        width = source.naturalWidth || source.width || source.getBoundingClientRect().width;
        height = source.naturalHeight || source.height || source.getBoundingClientRect().height;
      } else {
        const viewBox = source.viewBox?.baseVal;
        width = viewBox?.width || source.width?.baseVal?.value || source.getBoundingClientRect().width;
        height = viewBox?.height || source.height?.baseVal?.value || source.getBoundingClientRect().height;
      }
      if (!(width > 0 && height > 0 && width / height >= 1.6)) continue;

      const count = width / height >= 2.4 ? 3 : 2;
      const sliceWidth = width / count;
      const caption = figure.querySelector('figcaption')?.textContent?.trim() || 'Figure';
      let wrapper = figure.querySelector(':scope > .figure-panels');
      if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'figure-panels';
        figure.insertBefore(wrapper, figure.querySelector('figcaption'));
      }
      wrapper.replaceChildren();
      wrapper.dataset.panelStrategy = 'clipped-portrait';

      for (let index = 0; index < count; index += 1) {
        const panel = document.createElement('div');
        panel.className = 'figure-panel';
        panel.dataset.panelIndex = String(index + 1);
        panel.dataset.panelRole = index === 0 ? 'source' : 'continuation';
        panel.style.overflow = 'hidden';
        panel.style.width = '100%';
        if (index > 0) {
          const label = document.createElement('span');
          label.className = 'continuation-label';
          label.textContent = `${caption} — continued (${index + 1} of ${count})`;
          panel.appendChild(label);
        }

        const visual = index === 0 ? source : source.cloneNode(true);
        visual.style.maxWidth = 'none';
        if (visual.tagName.toLowerCase() === 'svg' && visual.viewBox?.baseVal) {
          const viewBox = visual.viewBox.baseVal;
          visual.setAttribute('viewBox', `${viewBox.x + sliceWidth * index} ${viewBox.y} ${sliceWidth} ${viewBox.height}`);
          visual.style.width = `${sliceWidth}px`;
        } else {
          visual.style.width = `${width}px`;
          visual.style.transform = `translateX(-${sliceWidth * index}px)`;
          visual.style.transformOrigin = 'top left';
        }
        panel.appendChild(visual);
        wrapper.appendChild(panel);
      }
      figure.dataset.panelCount = String(count);
      figure.dataset.portraitPanelsPopulated = 'true';
    }
  });
}

/**
 * Final pass in the print browser: wait for every image to resolve, then drop
 * anything that would print as a broken-image glyph or an empty block.
 */
export async function auditRenderedDocument(page, { imageTimeoutMs = 15000 } = {}) {
  return page.evaluate(async (timeoutMs) => {
    await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, timeoutMs);
    }))));
    if (document.fonts?.ready) await document.fonts.ready;
    const report = { images: 0, removedBrokenImages: 0, removedEmptyBlocks: 0 };
    const isEmptyFigure = (figure) => figure && !figure.classList.contains('reconstructed-timeline') && !figure.querySelector('img, svg, video, table, pre');
    for (const img of [...document.images]) {
      if (!img.isConnected) continue;
      if (img.complete && img.naturalWidth > 0) { report.images += 1; continue; }
      const figure = img.closest('figure');
      const picture = img.closest('picture');
      (picture || img).remove();
      report.removedBrokenImages += 1;
      if (isEmptyFigure(figure)) figure.remove();
    }
    const article = document.querySelector('.article-content');
    if (article) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const element of [...article.querySelectorAll('p, div, span, section, picture, figure, ul, ol, blockquote, header')]) {
          if (!element.isConnected || element.classList.contains('reconstructed-timeline')) continue;
          if (element.textContent.trim()) continue;
          if (element.querySelector('img, svg, video, table, hr, pre, canvas')) continue;
          element.remove();
          report.removedEmptyBlocks += 1;
          changed = true;
        }
      }
    }
    return report;
  }, imageTimeoutMs);
}

export async function printPdf(url, outputPath, { playwright } = {}) {
  try {
    const { chromium } = playwright ?? await import('playwright');
    const browser = await launchReadableBrowser(chromium);
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(250);
      const audit = await auditRenderedDocument(page);
      await populatePortraitPanels(page);
      await page.pdf({ path: outputPath, format: 'Letter', printBackground: true, preferCSSPageSize: true });
      return audit;
    } finally { await browser.close(); }
  } catch (error) { throw browserError(error); }
}

/**
 * Read the finished PDF back and report anything a reader would notice on
 * paper: blank pages, pages that carry nothing but a figure, total length.
 */
export async function inspectPdf(pdfPath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(pdfPath));
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const document = await task.promise;
  const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageXObjectRepeat]);
  const drawOps = new Set([pdfjs.OPS.fill, pdfjs.OPS.eoFill, pdfjs.OPS.stroke, pdfjs.OPS.fillStroke, pdfjs.OPS.eoFillStroke, pdfjs.OPS.closeFillStroke, pdfjs.OPS.closeStroke]);
  const pages = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const text = (await page.getTextContent()).items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').replace(/Page \d+ of \d+/g, '').trim();
    const operators = (await page.getOperatorList()).fnArray;
    const images = operators.filter((op) => imageOps.has(op)).length;
    const drawings = operators.filter((op) => drawOps.has(op)).length;
    pages.push({ number, characters: text.length, images, drawings, blank: text.length < 12 && images === 0 && drawings < 4 });
  }
  await task.destroy();
  const blankPages = pages.filter((page) => page.blank).map((page) => page.number);
  return { pageCount: pages.length, pages, blankPages, imageCount: pages.reduce((sum, page) => sum + page.images, 0), warnings: blankPages.length ? [`page${blankPages.length > 1 ? 's' : ''} ${blankPages.join(', ')} appear${blankPages.length > 1 ? '' : 's'} blank`] : [] };
}

export async function openPreview(url) {
  const { exec } = await import('node:child_process');
  return new Promise((resolve, reject) => exec(`open ${JSON.stringify(url)}`, (error) => error ? reject(error) : resolve()));
}
