import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { captureRenderedPage, captureClientPage, populatePortraitPanels, waitForReadablePage } from '../src/browser.js';
import {
  CliError,
  resolveOutputPaths,
  runPrint,
  slugForUrl,
  validateUrl,
} from '../src/cli.js';

test('captureRenderedPage returns stabilized rendered HTML and final URL', async () => {
  const fakePage = {
    async goto() {},
    async waitForTimeout() {},
    async content() { return '<html><body><img src="https://cdn.example.test/a.png"></body></html>'; },
    async url() { return 'https://example.test/final'; },
    async title() { return 'Captured'; },
    async evaluate() { return []; },
  };
  let closed = false;
  const result = await captureRenderedPage('https://example.test/start', {
    playwright: { chromium: { async launch() { return { async newPage() { return fakePage; }, async close() { closed = true; } }; } } },
  });
  assert.equal(result.finalUrl, 'https://example.test/final');
  assert.equal(result.title, 'Captured');
  assert.match(result.html, /<img/);
  assert.equal(closed, true);
});


test('captureRenderedPage does not hang on pages with persistent network activity', async () => {
  const waits = [];
  const page = {
    async goto(_url, options) {
      waits.push(options.waitUntil);
      if (options.waitUntil === 'networkidle') throw new Error('network never idles');
    },
    async waitForTimeout(ms) { waits.push(ms); },
    async content() { return '<html><body>stable</body></html>'; },
    url() { return 'https://example.test/stable'; },
    async title() { return 'Stable'; },
    async evaluate() { return []; },
  };
  const browser = { async newPage() { return page; }, async close() {} };
  const result = await captureRenderedPage('https://example.test/stable', {
    playwright: { chromium: { async launch() { return browser; } } },
    stabilityMs: 20,
  });
  assert.equal(result.finalUrl, 'https://example.test/stable');
  assert.deepEqual(waits, ['domcontentloaded', 20]);
});

test('captureRenderedPage collects SVG image hrefs without invalid selectors', async () => {
  const assetsDir = await temporaryOutput();
  const page = {
    async goto() {},
    async waitForTimeout() {},
    async content() { return '<html><body><svg><image href="https://example.test/chart.svg"></image></svg></body></html>'; },
    url() { return 'https://example.test/chart'; },
    async title() { return 'Chart'; },
    async evaluate(fn) {
      if (String(fn).includes('xlink\\\\:href')) throw new Error('Invalid selector');
      return String(fn).includes('querySelectorAll') ? ['https://example.test/chart.svg'] : undefined;
    },
  };
  const response = { ok: true, async arrayBuffer() { return new TextEncoder().encode('<svg/>').buffer; } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    const result = await captureRenderedPage('https://example.test/chart', {
      assetsDir,
      playwright: { chromium: { async launch() { return { async newPage() { return page; }, async close() {} }; } } },
    });
    assert.match(result.html, /chart\.svg/);
    assert.ok((await stat(path.join(assetsDir, 'chart.svg'))).isFile());
  } finally { globalThis.fetch = originalFetch; }
});
async function temporaryOutput() {
  return mkdtemp(path.join(tmpdir(), 'printer-cli-'));
}

test('main returns numeric success status for clean process exit', async () => {
  const { main } = await import('../src/cli.js');
  const result = await main(['print', 'https://example.test/story'], {
    runPrint: async () => ({ paths: { pdfPath: '/tmp/story.pdf' } }),
    log: () => {},
    error: () => {},
  });
  assert.equal(result, 0);
});

test('linked executable runs the CLI through its symlink path', async () => {
  const directory = await temporaryOutput();
  const executable = path.join(directory, 'printer');
  await symlink(fileURLToPath(new URL('../src/cli.js', import.meta.url)), executable);

  const { spawn } = await import('node:child_process');
  const result = await new Promise((resolve) => {
    const child = spawn(executable, ['print', 'not-a-url'], { env: { ...process.env, PRINTER_OUTPUT_DIR: directory } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /valid url/i);
  assert.equal(result.stdout, '');
});

test('captureRenderedPage falls back to direct article fetch for interstitial HTML', async () => {
  const page = {
    async goto() {},
    async waitForTimeout() {},
    async content() { return '<html><head><title>Just a moment...</title></head><body>Verify you are human</body></html>'; },
    url() { return 'https://example.test/article'; },
    async title() { return 'Just a moment...'; },
    async evaluate() { return []; },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, url: 'https://example.test/article', async text() { return '<html><body><article><h1>Readable story</h1></article></body></html>'; } });
  try {
    const result = await captureRenderedPage('https://example.test/article', {
      playwright: { chromium: { async launch() { return { async newPage() { return page; }, async close() {} }; } } },
    });
    assert.match(result.html, /Readable story/);
    assert.equal(result.finalUrl, 'https://example.test/article');
  } finally { globalThis.fetch = originalFetch; }
});

test('waitForReadablePage waits for a challenge page to resolve', async () => {
  let attempts = 0;
  const page = {
    async content() {
      attempts += 1;
      return attempts < 3 ? '<body>Verify you are human</body>' : '<body><article>Readable article</article></body>';
    },
    async waitForTimeout() {},
  };
  const html = await waitForReadablePage(page, { timeoutMs: 100, intervalMs: 1 });
  assert.match(html, /Readable article/);
  assert.equal(attempts, 3);
});

test('populatePortraitPanels clips a wide timeline into readable continuation panels', async () => {
  const dom = new JSDOM('<figure data-figure-treatment=\"stacked-portrait-panels\"><figcaption>Model timeline</figcaption><img class=\"timeline-chart\" src=\"timeline.png\"></figure>');
  const image = dom.window.document.querySelector('img');
  Object.defineProperties(image, { naturalWidth: { value: 2400 }, naturalHeight: { value: 900 } });
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    await populatePortraitPanels({ async evaluate(fn) { return fn(); } });
  } finally { globalThis.document = previousDocument; }

  const panels = [...dom.window.document.querySelectorAll('.figure-panel')];
  assert.equal(panels.length, 3);
  assert.equal(panels[0].querySelector('img'), image);
  assert.equal(panels[1].querySelector('.continuation-label').textContent, 'Model timeline — continued (2 of 3)');
  assert.equal(panels[2].querySelector('.continuation-label').textContent, 'Model timeline — continued (3 of 3)');
  for (const panel of panels) {
    const visual = panel.querySelector('img');
    assert.ok(visual);
    assert.equal(visual.style.maxWidth, 'none');
    assert.match(visual.style.width, /px$/);
    assert.equal(panel.style.overflow, 'hidden');
  }
});

test('validateUrl accepts only usable public HTTP(S) URLs', () => {
  assert.equal(validateUrl('https://Example.COM/articles/print?q=1#part').href, 'https://example.com/articles/print?q=1#part');
  assert.equal(validateUrl('http://example.com/').href, 'http://example.com/');

  for (const value of [
    '',
    'example.com/article',
    'file:///tmp/article.html',
    'javascript:alert(1)',
    'https://user:secret@example.com/article',
    'https://localhost/article',
    'https://127.0.0.1/article',
  ]) {
    assert.throws(() => validateUrl(value), (error) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /public http|https|valid url/i);
      return true;
    });
  }
});

test('slug and output names are deterministic and filesystem-safe', () => {
  const url = 'https://Docs.Example.com:8443/guides/Print This/?edition=one#overview';
  assert.equal(slugForUrl(url), 'docs-example-com-8443-guides-print-this-edition-one');
  assert.equal(slugForUrl(url), slugForUrl(url));

  const paths = resolveOutputPaths(url, { outputDir: '/var/tmp/printer-output' });
  assert.deepEqual(paths, {
    rootDir: '/var/tmp/printer-output',
    slug: 'docs-example-com-8443-guides-print-this-edition-one',
    documentDir: '/var/tmp/printer-output/docs-example-com-8443-guides-print-this-edition-one',
    assetsDir: '/var/tmp/printer-output/docs-example-com-8443-guides-print-this-edition-one/assets',
    htmlPath: '/var/tmp/printer-output/docs-example-com-8443-guides-print-this-edition-one/index.html',
    stylesPath: '/var/tmp/printer-output/docs-example-com-8443-guides-print-this-edition-one/styles.css',
    pdfPath: '/var/tmp/printer-output/docs-example-com-8443-guides-print-this-edition-one.pdf',
  });
});

test('runPrint captures, extracts, previews, and writes normalized HTML and PDF', async () => {
  const outputDir = await temporaryOutput();
  const calls = [];
  const browser = {
    async capture(url, options) {
      calls.push(['capture', url, options.assetsDir]);
      return {
        html: '<!doctype html><html><head><title>Rendered Story</title></head><body><article><h1>Rendered Story</h1><p>Browser-populated prose for printing.</p></article></body></html>',
        finalUrl: url,
      };
    },
    async startPreview(options) {
      calls.push(['serve', options.directory]);
      return {
        url: 'http://127.0.0.1:45678/',
        async close() { calls.push(['close']); },
      };
    },
    async pdf(url, outputPath) {
      calls.push(['pdf', url, outputPath]);
      await optionsWrite(outputPath, '%PDF-fake');
      return { html: '<!doctype html><html><head><title>Rendered Story</title><link rel="stylesheet" href="./styles.css"></head><body><article data-page="article"><p>Browser-populated prose for printing.</p></article></body></html>' };
    },
    async open(url) { calls.push(['open', url]); },
  };
  const optionsWrite = async (file, value) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, value);
  };

  const result = await runPrint('https://example.com/story', {
    outputDir,
    browser,
    retrievedDate: '2026-08-31',
    minimumWords: 0,
  });

  assert.equal(result.paths.slug, 'example-com-story');
  assert.deepEqual(calls.map(([name]) => name), ['capture', 'serve', 'pdf', 'open', 'close']);
  assert.equal(calls[0][2], path.join(outputDir, 'example-com-story', 'assets'));
  assert.equal(calls[2][1], 'http://127.0.0.1:45678/');
  assert.equal(calls[3][1], 'http://127.0.0.1:45678/');
  assert.match(await readFile(result.paths.htmlPath, 'utf8'), /Browser-populated prose for printing/);
  assert.match(await readFile(result.paths.stylesPath, 'utf8'), /@page/);
  assert.equal(await readFile(result.paths.pdfPath, 'utf8'), '%PDF-fake');
  assert.ok((await stat(result.paths.assetsDir)).isDirectory());
});

test('runPrint suppresses preview opening with noPreview and always closes the server', async () => {
  const outputDir = await temporaryOutput();
  const calls = [];
  const browser = {
    async capture(url) {
      calls.push('capture');
      return { html: '<html><head><title>Quiet</title></head><body><article><p>Quiet article body with enough words for extraction.</p></article></body></html>', finalUrl: url };
    },
    async startPreview() {
      calls.push('serve');
      return { url: 'http://127.0.0.1:40000/', async close() { calls.push('close'); } };
    },
    async pdf(_url, outputPath) {
      calls.push('pdf');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outputPath, '%PDF-fake');
      return {};
    },
    async open() { calls.push('open'); },
  };

  await runPrint('https://example.com/quiet', { outputDir, browser, noPreview: true, minimumWords: 0 });
  assert.deepEqual(calls, ['capture', 'serve', 'pdf', 'close']);
});

test('runPrint reports inaccessible pages and missing Chromium usefully', async () => {
  const outputDir = await temporaryOutput();
  for (const [cause, expected] of [
    [Object.assign(new Error('net::ERR_NAME_NOT_RESOLVED'), { code: 'PAGE_INACCESSIBLE' }), /could not load.*example\.com/i],
    [Object.assign(new Error('Executable does not exist'), { code: 'BROWSER_MISSING' }), /playwright install chromium/i],
  ]) {
    await assert.rejects(
      runPrint('https://example.com/unavailable', {
        outputDir,
        browser: { async capture() { throw cause; } },
      }),
      expected,
    );
  }
});

test('runPrint falls back to client capture after an access challenge', async () => {
  const outputDir = await temporaryOutput();
  const calls = [];
  const inaccessible = Object.assign(new Error('challenge'), { code: 'PAGE_INACCESSIBLE' });
  const browser = {
    async capture() { calls.push('headless'); throw inaccessible; },
    async captureClient(url) { calls.push(['client', url]); return { html: '<html><head><title>Client article</title></head><body><article><h1>Client article</h1><p>Readable article body.</p></article></body></html>', finalUrl: url }; },
    async startPreview() { calls.push('serve'); return { url: 'http://127.0.0.1:40001/', async close() { calls.push('close'); } }; },
    async pdf(_url, outputPath) { calls.push('pdf'); const { writeFile } = await import('node:fs/promises'); await writeFile(outputPath, '%PDF-fake'); },
  };
  await runPrint('https://example.com/challenged', { outputDir, browser, noPreview: true, minimumWords: 0 });
  assert.deepEqual(calls, ['headless', ['client', 'https://example.com/challenged'], 'serve', 'pdf', 'close']);
});

test('parseArgs accepts --keep-source and rejects unknown options', async () => {
  const { parseArgs } = await import('../src/cli.js');
  assert.deepEqual(parseArgs(['print', 'https://example.test/a', '--keep-source']), { url: 'https://example.test/a', noPreview: false, keepSource: true, client: false });
  assert.equal(parseArgs(['print', 'https://example.test/a', '--client']).client, true);
  assert.throws(() => parseArgs(['print', 'https://example.test/a', '--bogus']), /Unknown option --bogus/);
});

test('summarizeRun reports page count, figures, and reader-visible warnings', async () => {
  const { summarizeRun } = await import('../src/cli.js');
  const article = { content: `<p>${'word '.repeat(400)}</p>` };
  const audit = { images: 3, removedBrokenImages: 1 };
  const inspection = { pageCount: 5, blankPages: [2], warnings: ['page 2 appears blank'], pages: [
    { number: 1, characters: 60, images: 0, blank: false }, { number: 2, characters: 0, images: 0, blank: true },
    { number: 3, characters: 2000, images: 1, blank: false }, { number: 4, characters: 4, images: 2, blank: false }, { number: 5, characters: 900, images: 0, blank: false },
  ] };
  const report = summarizeRun(article, audit, inspection);
  assert.equal(report.pages, 5);
  assert.equal(report.words, 400);
  assert.equal(report.figures, 3);
  assert.deepEqual(report.blankPages, [2]);
  assert.match(report.warnings.join('\n'), /page 2 appears blank/);
  assert.match(report.warnings.join('\n'), /1 image could not be loaded/);
  assert.match(report.warnings.join('\n'), /page 4 contains only graphics/);
});

test('preview server serves image types Chromium will actually paint', async () => {
  const { contentTypeFor } = await import('../src/browser.js');
  assert.equal(contentTypeFor('/tmp/assets/chart.svg'), 'image/svg+xml');
  assert.equal(contentTypeFor('/tmp/assets/photo.JPG'), 'image/jpeg');
  assert.equal(contentTypeFor('/tmp/index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('/tmp/assets/blob'), 'application/octet-stream');
});

test('inspectPdf reads back page structure from a generated PDF', async () => {
  const { inspectPdf } = await import('../src/browser.js');
  const directory = await temporaryOutput();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const pdfPath = path.join(directory, 'sample.pdf');
  try {
    const page = await browser.newPage();
    await page.setContent('<style>@page{size:Letter;margin:1in}section{break-after:page}</style><section><p>First page has prose that should register as text.</p></section><section></section><section><p>Third page carries a normal paragraph of prose.</p></section>');
    await page.pdf({ path: pdfPath, format: 'Letter' });
  } finally { await browser.close(); }
  const report = await inspectPdf(pdfPath);
  assert.equal(report.pageCount, 3);
  assert.deepEqual(report.blankPages, [2]);
  assert.match(report.warnings[0], /page 2 appears blank/);
});

test('captureClientPage asks the reader to sign in and captures again when the review objects', async () => {
  let loads = 0;
  const prompts = [];
  const page = {
    async goto() { loads += 1; },
    async reload() { loads += 1; },
    async waitForTimeout() {},
    async content() { return loads < 2 ? '<html><body><p>Preview only</p></body></html>' : '<html><body><article><p>Full article after sign-in</p></article></body></html>'; },
    url() { return 'https://pub.example/story'; },
    async title() { return 'Story'; },
    async evaluate() { return []; },
  };
  const context = { pages() { return [page]; }, async close() {} };
  const result = await captureClientPage('https://pub.example/story', {
    playwright: { chromium: { async launchPersistentContext() { return context; } } },
    prompt: async (message) => { prompts.push(message); return ''; },
    review: async (captured) => (/Preview only/.test(captured.html) ? 'Only a preview was served.' : null),
  });
  assert.match(result.html, /Full article after sign-in/);
  assert.equal(loads, 2);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Only a preview was served/);
  assert.match(prompts[0], /Sign in/);
});
