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
      if (assetsDir && !usedFallback) html = await localizeAssets(page, html, assetsDir);
      return { html, finalUrl, title: await page.title() };
    } finally { await browser.close(); }
  } catch (error) { throw browserError(error); }
}
export async function captureClientPage(url, { assetsDir, playwright, profileDir = path.join(process.env.HOME || '.', 'Library', 'Application Support', 'printer', 'browser-profile') } = {}) {
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
          const readline = createInterface({ input: process.stdin, output: process.stdout });
          try { await readline.question('Complete the browser verification, then press Enter here to continue. '); } finally { readline.close(); }
          html = await waitForReadablePage(page);
        }
      } else {
        html = await waitForReadablePage(page);
      }
      const finalUrl = await page.url();
      return { html: assetsDir ? await localizeAssets(page, html, assetsDir) : html, finalUrl, title: await page.title() };
    } finally { await context.close(); }
  } catch (error) { throw browserError(error); }
}

async function localizeAssets(page, html, assetsDir) {
  await mkdir(assetsDir, { recursive: true });
  const urls = await page.evaluate(() => [...document.querySelectorAll('img[src], source[src], svg image[href], svg image')].map((node) => { const value = node.getAttribute('href') || node.getAttribute('xlink:href') || node.getAttribute('src') || node.src || node.href?.baseVal; try { return new URL(value, document.baseURI).href; } catch { return value; } }).filter(Boolean));
  const replacements = {};
  for (const assetUrl of [...new Set(urls)]) {
    try {
      const response = await fetch(assetUrl);
      if (!response.ok) continue;
      const body = Buffer.from(await response.arrayBuffer());
      const base = path.basename(new URL(assetUrl).pathname) || 'asset';
      const safeBase = base.replace(/[^A-Za-z0-9._-]/g, '-');
      let filename = safeBase;
      try {
        await writeFile(path.join(assetsDir, filename), body, { flag: 'wx' });
      } catch {
        const extension = path.extname(safeBase);
        const stem = extension ? safeBase.slice(0, -extension.length) : safeBase;
        filename = `${stem}-${createHash('sha256').update(assetUrl).digest('hex').slice(0, 10)}${extension}`;
        try { await writeFile(path.join(assetsDir, filename), body, { flag: 'wx' }); } catch { continue; }
      }
      replacements[assetUrl] = `./assets/${filename}`;
    } catch { /* retain remote URL when localization fails */ }
  }
  if (!Object.keys(replacements).length) return html;
  await page.evaluate((mapping) => {
    for (const node of document.querySelectorAll('img[src], source[src], svg image[href], svg image')) {
      const raw = node.getAttribute('href') || node.getAttribute('xlink:href') || node.getAttribute('src') || node.src || node.href?.baseVal;
      let value;
      try { value = new URL(raw, document.baseURI).href; } catch { value = raw; }
      if (mapping[value]) {
        if (node.tagName.toLowerCase() === 'image') node.setAttribute('href', mapping[value]);
        else node.setAttribute('src', mapping[value]);
      }
    }
  }, replacements);
  return await page.content();
}


export function startPreviewServer({ directory, port = 0 } = {}) {
  const server = createServer(async (request, response) => {
    const requested = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    const file = path.resolve(directory, relative);
    if (!file.startsWith(path.resolve(directory) + path.sep)) { response.writeHead(403); response.end('Forbidden'); return; }
    try {
      const body = await readFile(file);
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': type }); response.end(body);
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

export async function printPdf(url, outputPath, { playwright } = {}) {
  try {
    const { chromium } = playwright ?? await import('playwright');
    const browser = await launchReadableBrowser(chromium);
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(250);
      await populatePortraitPanels(page);
      await page.pdf({ path: outputPath, format: 'Letter', printBackground: true });
    } finally { await browser.close(); }
  } catch (error) { throw browserError(error); }
}

export async function openPreview(url) {
  const { exec } = await import('node:child_process');
  return new Promise((resolve, reject) => exec(`open ${JSON.stringify(url)}`, (error) => error ? reject(error) : resolve()));
}
