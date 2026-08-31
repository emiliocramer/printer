import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { renderDocument } from '../src/render.js';

const DOCUMENT = {
  metadata: {
    title: 'A measured history',
    author: 'Ada Lovelace',
    published: '2026-08-30',
    sourceUrl: 'https://example.com/features/history?edition=print&lang=en',
    retrieved: '2026-08-31',
    estimatedReadingTime: 7,
  },
  content: '<p>Opening prose remains <em>exactly readable</em>.</p><img src="https://cdn.example.com/lead.jpg" alt="Lead image"><a href="https://example.com/evidence">Evidence</a>',
  figures: [
    {
      id: 'ordinary-photo',
      type: 'photo',
      width: 900,
      height: 700,
      caption: 'An ordinary figure',
      html: '<img src="https://cdn.example.com/photo.jpg" alt="Portrait">',
    },
    {
      id: 'history-timeline',
      semanticType: 'timeline',
      width: 2400,
      height: 800,
      caption: 'Events across the century',
      html: '<svg viewBox="0 0 2400 800" aria-label="History timeline"><text>1900—2000</text></svg>',
    },
  ],
};

function parse(html) {
  return new JSDOM(html).window.document;
}

test('renders a complete provenance page before the article', () => {
  const html = renderDocument(DOCUMENT);
  const document = parse(html);
  const provenance = document.querySelector('[data-page="provenance"]');
  const article = document.querySelector('article[data-page="article"]');

  assert.match(html, /^<!doctype html>/i);
  assert.ok(provenance);
  assert.ok(article);
  assert.equal(
    provenance.compareDocumentPosition(article) & document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal(provenance.querySelector('h1').textContent, 'A measured history');
  assert.match(provenance.textContent, /Ada Lovelace/);
  assert.match(provenance.textContent, /2026-08-30/);
  assert.match(provenance.textContent, /2026-08-31/);
  assert.match(provenance.textContent, /7 minutes/);
  assert.ok(provenance.querySelector('[data-print-page-estimate]'));
  assert.equal(provenance.querySelector('a.source-url').href, DOCUMENT.metadata.sourceUrl);
  assert.equal(document.querySelector('link[rel="stylesheet"]').getAttribute('href'), './styles.css');
});

test('preserves supplied article prose and asset URLs', () => {
  const html = renderDocument(DOCUMENT);
  const article = parse(html).querySelector('.article-content');

  assert.match(article.innerHTML, /Opening prose remains <em>exactly readable<\/em>\./);
  assert.equal(article.querySelector('img').getAttribute('src'), 'https://cdn.example.com/lead.jpg');
  assert.equal(article.querySelector('a').getAttribute('href'), 'https://example.com/evidence');
  assert.equal((html.match(/https:\/\/cdn\.example\.com\/photo\.jpg/g) ?? []).length, 1);
});

test('keeps source provenance while inline article links print without URL suffixes', () => {
  const html = renderDocument(DOCUMENT);
  const document = parse(html);
  const source = document.querySelector('[data-page="provenance"] .source-url');
  const inlineLink = document.querySelector('.article-content a[href]');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.equal(source.textContent, DOCUMENT.metadata.sourceUrl);
  assert.equal(source.getAttribute('href'), DOCUMENT.metadata.sourceUrl);
  assert.equal(inlineLink.textContent, 'Evidence');
  assert.doesNotMatch(css, /\.article-content[^{]*::after\s*\{[^}]*attr\(href\)/s);
  assert.match(css, /\.article-content a\[href\]\s*\{[^}]*text-decoration:\s*underline/s);
});

test('escapes metadata in text and attribute contexts', () => {
  const html = renderDocument({
    metadata: {
      title: '<img src=x onerror="attack()">',
      author: 'A & B </dd><script>attack()</script>',
      published: '"quoted" <date>',
      sourceUrl: 'https://example.com/?q=" onmouseover="attack()&x=<tag>',
      retrieved: '<time>today</time>',
      estimatedReadingTime: 3,
    },
    content: '<p>Trusted extracted prose.</p>',
  });
  const document = parse(html);

  assert.equal(document.querySelectorAll('script, [onerror], [onmouseover]').length, 0);
  assert.equal(document.querySelector('.provenance-title').textContent, '<img src=x onerror="attack()">');
  assert.match(document.querySelector('.provenance-details').textContent, /A & B <\/dd><script>attack\(\)<\/script>/);
  assert.equal(document.querySelector('.source-url').getAttribute('href'), 'https://example.com/?q=%22%20onmouseover=%22attack()&x=%3Ctag%3E');
  assert.match(html, /&lt;img src=x onerror=&quot;attack\(\)&quot;&gt;/);
});

test('renders wide timelines as deterministic stacked portrait panels', () => {
  const html = renderDocument(DOCUMENT);
  const document = parse(html);
  const wide = document.querySelector('figure[data-figure-treatment="stacked-portrait-panels"]');
  const panels = [...wide.querySelectorAll(':scope > .figure-panels > .figure-panel')];

  assert.equal(wide.dataset.figureId, 'history-timeline');
  assert.equal(wide.dataset.panelCount, '3');
  assert.equal(panels.length, 3);
  assert.equal(panels[0].dataset.panelRole, 'source');
  assert.equal(panels[0].dataset.panelIndex, '1');
  assert.ok(panels[0].querySelector('svg[aria-label="History timeline"]'));
  assert.equal((html.match(/1900—2000/g) ?? []).length, 1);
  assert.equal(panels[1].dataset.panelRole, 'continuation');
  assert.equal(panels[1].dataset.populateFrom, 'history-timeline');
  assert.equal(panels[1].querySelector('.continuation-label').textContent, 'Events across the century — continued (2 of 3)');
  assert.equal(panels[2].querySelector('.continuation-label').textContent, 'Events across the century — continued (3 of 3)');
});

test('keeps ordinary figures intact without panel wrappers', () => {
  const ordinary = parse(renderDocument(DOCUMENT)).querySelector('figure[data-figure-id="ordinary-photo"]');

  assert.equal(ordinary.dataset.figureTreatment, 'normal');
  assert.equal(ordinary.querySelectorAll('.figure-panel').length, 0);
  assert.equal(ordinary.querySelector('img').getAttribute('src'), 'https://cdn.example.com/photo.jpg');
  assert.equal(ordinary.querySelector('figcaption').textContent, 'An ordinary figure');
});
