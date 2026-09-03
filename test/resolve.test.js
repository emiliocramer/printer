import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardingTarget, isShareLink, resolveArticleUrl } from '../src/resolve.js';
import { assessArticle } from '../src/cli.js';

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
