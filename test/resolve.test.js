import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardingTarget, isShareLink, resolveArticleUrl, fullTextUrl } from '../src/resolve.js';
import { assessArticle, bodyWordCount } from '../src/cli.js';

const APPLE_NEWS = `<!DOCTYPE html><html><head><title>Trump Meant It Literally — The Atlantic</title>
<script>
  function redirectToUrl(url) { window.location = url }
  function redirectToUrlAfterTimeout(url, timeout) { setTimeout(function() { redirectToUrl(url) }, timeout) }
  window.location = "applenewss:///AO2hZXoB8QpCgyvUs7uIaKw";
  redirectToUrlAfterTimeout("https://www.theatlantic.com/ideas/2026/09/trump-venezuela-oil-revenue/688486/?utm_source=apple_news", 0)
</script></head><body><p>Opening story…</p><a onclick='redirectToUrl("https://www.theatlantic.com/ideas/2026/09/trump-venezuela-oil-revenue/688486/?utm_source=apple_news")'>Tap here if the story doesn’t open after a few seconds.</a></body></html>`;

function fakeFetch(routes) {
  return async (url) => {
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return { url: route.finalUrl ?? url, headers: { get: () => 'text/html' }, async text() { return route.html ?? ''; } };
  };
}

test('recognizes share hosts', () => {
  assert.equal(isShareLink('https://apple.news/AO2hZXoB8QpCgyvUs7uIaKw'), true);
  assert.equal(isShareLink('https://t.co/abc'), true);
  assert.equal(isShareLink('https://www.theatlantic.com/ideas/2026/09/x/'), false);
});

test('extracts Apple News forwarding target, ignoring the app-scheme location', () => {
  assert.equal(forwardingTarget(APPLE_NEWS, 'https://apple.news/AO2hZXoB8QpCgyvUs7uIaKw'), 'https://www.theatlantic.com/ideas/2026/09/trump-venezuela-oil-revenue/688486/?utm_source=apple_news');
});

test('extracts meta refresh and cross-host canonical forwards', () => {
  assert.equal(forwardingTarget('<meta http-equiv="refresh" content="0; url=https://pub.example/story">', 'https://short.example/x'), 'https://pub.example/story');
  assert.equal(forwardingTarget('<link rel="canonical" href="https://pub.example/story">', 'https://short.example/x'), 'https://pub.example/story');
  assert.equal(forwardingTarget('<link rel="canonical" href="https://pub.example/story">', 'https://pub.example/story?utm=1'), null, 'same-host canonical is not a forward');
});

test('resolves Apple News links to the publisher article', async () => {
  const fetchImpl = fakeFetch({ 'https://apple.news/AO2hZXoB8QpCgyvUs7uIaKw': { html: APPLE_NEWS } });
  const result = await resolveArticleUrl('https://apple.news/AO2hZXoB8QpCgyvUs7uIaKw', { fetchImpl });
  assert.equal(result.url, 'https://www.theatlantic.com/ideas/2026/09/trump-venezuela-oil-revenue/688486/?utm_source=apple_news');
  assert.deepEqual(result.hops, ['https://apple.news/AO2hZXoB8QpCgyvUs7uIaKw', result.url]);
});

test('follows HTTP redirects from shorteners and stops at the publisher', async () => {
  const fetchImpl = fakeFetch({ 'https://t.co/abc': { finalUrl: 'https://pub.example/story', html: '<html><body><article>Story</article></body></html>' } });
  const result = await resolveArticleUrl('https://t.co/abc', { fetchImpl });
  assert.equal(result.url, 'https://pub.example/story');
});

test('leaves publisher URLs alone without fetching', async () => {
  const result = await resolveArticleUrl('https://pub.example/story', { fetchImpl: async () => { throw new Error('should not fetch'); } });
  assert.deepEqual(result, { url: 'https://pub.example/story', hops: [] });
});

test('survives network failure by returning the original link', async () => {
  const result = await resolveArticleUrl('https://apple.news/x', { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.url, 'https://apple.news/x');
});

test('assessArticle refuses interstitials, paywall previews, and stubs', () => {
  const meta = { title: 'Real title' };
  assert.equal(assessArticle({ metadata: meta, content: `<p>${'Full article prose. '.repeat(200)}</p>` }), null);
  assert.equal(assessArticle({ metadata: meta, content: '<p>Opening story… Tap here if the story doesn’t open after a few seconds.</p>' })?.reason, 'interstitial');
  assert.equal(assessArticle({ metadata: meta, content: `<p>${'Preview prose. '.repeat(80)}</p><p>This article is exclusive to subscribers. Start your free trial.</p>` })?.reason, 'paywall');
  assert.match(assessArticle({ metadata: meta, content: `<p>${'Preview prose. '.repeat(80)}</p><p>Already a subscriber? Log in</p>` }).message, /--client/);
  assert.equal(assessArticle({ metadata: meta, content: '<p>Too little.</p>' })?.reason, 'short');
  assert.equal(assessArticle({ metadata: { title: 'Untitled article' }, content: '<p>x</p>' })?.reason, 'empty');
  assert.equal(assessArticle({ metadata: meta, content: `<p>${'Preview prose. '.repeat(120)}</p>`, access: { gated: true, tier: 'metered', signals: ['content-tier'] } })?.reason, 'paywall');
  assert.equal(assessArticle({ metadata: meta, content: `<p>${'Full prose. '.repeat(1200)}</p>`, access: { gated: true, tier: 'metered', signals: ['content-tier'] } }), null, 'gated but fully served is printable');
  // A long article that merely mentions subscriptions is not a paywall.
  assert.equal(assessArticle({ metadata: meta, content: `<p>${'Long essay prose. '.repeat(600)}</p><p>Already a subscriber? Log in.</p>` }), null);
});

test('arXiv abstract pages resolve to the HTML full text when it exists', async () => {
  const big = '<html>' + 'x'.repeat(30000) + '</html>';
  const okFetch = async (url) => ({ ok: url === 'https://arxiv.org/html/2609.05036', url, headers: { get: () => 'text/html' }, async text() { return url === 'https://arxiv.org/html/2609.05036' ? big : ''; } });
  assert.equal(await fullTextUrl('https://arxiv.org/abs/2609.05036', { fetchImpl: okFetch }), 'https://arxiv.org/html/2609.05036');
  assert.equal(await fullTextUrl('https://arxiv.org/pdf/2609.05036v2', { fetchImpl: okFetch }), 'https://arxiv.org/pdf/2609.05036v2', 'no HTML for that version -> unchanged');
  const missing = async (url) => ({ ok: true, url, headers: { get: () => 'text/html' }, async text() { return '<html>HTML is not available for this paper</html>'; } });
  assert.equal(await fullTextUrl('https://arxiv.org/abs/2609.05036', { fetchImpl: missing }), 'https://arxiv.org/abs/2609.05036');
  const result = await resolveArticleUrl('https://arxiv.org/abs/2609.05036', { fetchImpl: okFetch });
  assert.equal(result.url, 'https://arxiv.org/html/2609.05036');
});

test('a reference list cannot disguise a paywalled abstract as a full article', () => {
  const refs = Array.from({ length: 60 }, (_, i) => `<li>Author ${i}, Another. A long reference title with many words in it. Journal of Things ${2000 + i}.</li>`).join('');
  const content = `<h2>Abstract</h2><p>${'Abstract sentence words here. '.repeat(40)}</p><h2>Access options</h2><p>Access through your institution. Buy this article.</p><h2>Data availability</h2><p>Data are available.</p><h2>References</h2><ol>${refs}</ol>`;
  assert.ok(bodyWordCount(content) < 300, `body words ${bodyWordCount(content)}`);
  const verdict = assessArticle({ metadata: { title: 'Paper' }, content, access: { gated: true, tier: null, signals: ['access-no', 'schema-not-free'] } });
  assert.equal(verdict?.reason, 'paywall');
  const full = `<h2>Abstract</h2><p>${'Abstract words. '.repeat(40)}</p><h2>Main</h2><p>${'Body prose words. '.repeat(900)}</p><h2>References</h2><ol>${refs}</ol>`;
  assert.equal(assessArticle({ metadata: { title: 'Paper' }, content: full, access: { gated: true, tier: null, signals: ['access-no'] } }), null);
});
