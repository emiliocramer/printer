import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractArticle } from '../src/extract.js';

const SOURCE_URL = 'https://example.com/news/2026/story/index.html?ref=home';

const ARTICLE_FIXTURE = `<!doctype html>
<html>
  <head>
    <title>Fallback document title</title>
    <meta property="og:title" content="The OpenGraph Article">
    <meta property="og:site_name" content="Example News">
    <meta name="author" content="Fallback Author">
    <meta property="article:published_time" content="2026-08-30T12:30:00Z">
    <link rel="canonical" href="/features/the-article">
    <style>.hidden { display: none }</style>
    <script>globalThis.compromised = true</script>
  </head>
  <body>
    <!-- tracking comment -->
    <nav><a href="/sections">Sections</a></nav>
    <main>
      <article>
        <header>
          <h1>The Article Heading</h1>
          <p class="byline" rel="author">By Ada Lovelace</p>
        </header>
        <p>Opening prose with an <a href="../background?utm_source=story#details" onclick="steal()">essential link</a>.</p>
        <h2>Evidence</h2>
        <blockquote cite="/sources/interview"><p>A preserved quotation.</p></blockquote>
        <ul><li>First finding</li><li>Second finding</li></ul>
        <pre><code>const answer = 42;</code></pre>
        <table><caption>Measured results</caption><thead><tr><th>Year</th><th>Value</th></tr></thead><tbody><tr><td>2026</td><td>42</td></tr></tbody></table>
        <figure data-track-id="figure-1">
          <picture>
            <source srcset="../../media/chart-small.png 1x, /media/chart-large.png 2x" type="image/png">
            <img src="../../media/chart.png" srcset="../../media/chart.png 400w, //cdn.example.com/chart.png 800w" alt="A chart" width="800" height="400" loading="lazy" onerror="steal()">
          </picture>
          <figcaption>Results over time</figcaption>
        </figure>
        <svg viewBox="0 0 100 50" role="img" aria-label="Inline diagram">
          <title>Inline diagram</title>
          <a href="../details"><image href="../../media/diagram.png" x="0" y="0" width="100" height="50"></image></a>
        </svg>
        <video controls poster="../../media/poster.jpg"><source src="../../media/explanation.mp4" type="video/mp4"></video>
        <iframe src="https://player.example.org/embed/123" title="Interactive chart" allowfullscreen></iframe>
        <form><input name="email"><button>Subscribe</button></form>
        <aside class="advertisement"><p>Buy this now</p></aside>
        <script>alert('article script')</script>
      </article>
    </main>
    <footer>Site footer</footer>
  </body>
</html>`;

function parseFragment(content) {
  return JSDOM.fragment(`<section id="root">${content}</section>`).querySelector('#root');
}

test('extracts normalized metadata using article and head fallbacks', () => {
  const result = extractArticle(ARTICLE_FIXTURE, SOURCE_URL, '2026-08-31');

  assert.deepEqual(result.metadata, {
    title: 'The OpenGraph Article',
    author: 'Ada Lovelace',
    published: '2026-08-30T12:30:00Z',
    sourceUrl: 'https://example.com/features/the-article',
    retrieved: '2026-08-31',
    estimatedReadingTime: 1,
  });
  assert.equal(typeof result.content, 'string');
  assert.match(result.content, /Opening prose with an/);
});

test('preserves semantic article and native visual content', () => {
  const { content } = extractArticle(ARTICLE_FIXTURE, SOURCE_URL, '2026-08-31');
  const root = parseFragment(content);

  for (const selector of [
    'h2', 'p', 'a', 'blockquote', 'ul > li', 'pre > code',
    'table caption', 'table thead th', 'figure picture source',
    'figure img', 'figcaption', 'svg title', 'svg image',
    'video source', 'iframe[title="Interactive chart"]',
  ]) {
    assert.ok(root.querySelector(selector), `expected preserved ${selector}`);
  }

  assert.equal(root.querySelector('blockquote').textContent.trim(), 'A preserved quotation.');
  assert.equal(root.querySelector('figcaption').textContent, 'Results over time');
  assert.equal(root.querySelector('pre code').textContent, 'const answer = 42;');
});

test('normalizes safe article, image, media, and SVG URLs', () => {
  const { content } = extractArticle(ARTICLE_FIXTURE, SOURCE_URL, '2026-08-31');
  const root = parseFragment(content);

  assert.equal(root.querySelector('p a').getAttribute('href'), 'https://example.com/news/2026/background?utm_source=story#details');
  assert.equal(root.querySelector('blockquote').getAttribute('cite'), 'https://example.com/sources/interview');
  assert.equal(root.querySelector('img').getAttribute('src'), 'https://example.com/news/media/chart.png');
  assert.equal(root.querySelector('img').getAttribute('srcset'), 'https://example.com/news/media/chart.png 400w, https://cdn.example.com/chart.png 800w');
  assert.equal(root.querySelector('picture source').getAttribute('srcset'), 'https://example.com/news/media/chart-small.png 1x, https://example.com/media/chart-large.png 2x');
  assert.equal(root.querySelector('svg a').getAttribute('href'), 'https://example.com/news/2026/details');
  assert.equal(root.querySelector('svg image').getAttribute('href'), 'https://example.com/news/media/diagram.png');
  assert.equal(root.querySelector('video').getAttribute('poster'), 'https://example.com/news/media/poster.jpg');
  assert.equal(root.querySelector('video source').getAttribute('src'), 'https://example.com/news/media/explanation.mp4');
});

test('removes navigation, executable markup, forms, ads, comments, and tracking attributes', () => {
  const hostileFixture = ARTICLE_FIXTURE.replace(
    '<p>Opening prose',
    '<p data-track="reader" style="color:red">Opening prose <a href="javascript:alert(1)">unsafe</a> <img src="data:text/html,evil" alt="unsafe">',
  );
  const { content } = extractArticle(hostileFixture, SOURCE_URL, '2026-08-31');
  const root = parseFragment(content);

  for (const selector of ['nav', 'script', 'style', 'form', 'input', 'button', 'aside', '.advertisement']) {
    assert.equal(root.querySelector(selector), null, `expected removed ${selector}`);
  }
  assert.doesNotMatch(content, /tracking comment|Buy this now|compromised|article script/);
  assert.equal(root.querySelector('[onclick], [onerror], [style], [data-track], [data-track-id]'), null);
  assert.equal(root.querySelector('a[href^="javascript:"]'), null);
  assert.equal(root.querySelector('img[src^="data:"]'), null);
});

test('falls back to document metadata when OpenGraph and article fields are absent', () => {
  const html = `<!doctype html><html><head>
    <title>  Plain title  </title>
    <meta name="author" content="  Grace Hopper  ">
    <meta name="date" content="2026-08-29">
  </head><body><article><p>${'Useful article prose. '.repeat(20)}</p></article></body></html>`;

  const { metadata } = extractArticle(html, 'https://example.com/plain', '2026-08-31T09:00:00Z');

  assert.deepEqual(metadata, {
    title: 'Plain title',
    author: 'Grace Hopper',
    published: '2026-08-29',
    sourceUrl: 'https://example.com/plain',
    retrieved: '2026-08-31T09:00:00Z',
    estimatedReadingTime: 1,
  });
});

test('removes rendered subscription chrome before choosing the long article', () => {
  const dialogCopy = 'Follow this publication on Substack. Sign in or enter your email to subscribe. '.repeat(35);
  const articleCopy = 'The observatory recorded a distinct signal whose shape changed across the entire winter survey. '.repeat(45);
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="Winter Signals">
    <meta name="author" content="Mira Chen">
  </head><body>
    <div class="site-chrome">
      <nav>Home Archive About</nav>
      <dialog open class="pencraft pc-reset follow-dialog">
        <h2>Follow on Substack</h2>
        <p>${dialogCopy}</p>
        <form><input type="email"><button>Subscribe</button></form>
      </dialog>
    </div>
    <main><article>
      <header><h1>Winter Signals</h1><p class="byline">By Mira Chen</p></header>
      <p data-article-marker="true">${articleCopy}</p>
      <p>The research team published the complete measurements after independent review.</p>
    </article></main>
  </body></html>`;

  const { content, metadata } = extractArticle(html, 'https://example.com/winter-signals', '2026-08-31');

  assert.match(content, /observatory recorded a distinct signal/);
  assert.match(content, /complete measurements after independent review/);
  assert.doesNotMatch(content, /Follow on Substack|enter your email|Subscribe/);
  assert.equal(metadata.title, 'Winter Signals');
  assert.equal(metadata.author, 'Mira Chen');
});

test('ignores page-wide comment authors when selecting article metadata', () => {
  const html = `<!doctype html><html><head>
    <title>Field Notes</title>
    <meta name="author" content="Meta Reporter">
    <meta property="og:site_name" content="The Daily Ledger">
  </head><body>
    <section class="comments"><article class="comment"><p class="author">Wrong Commenter</p><p>A reader comment.</p></article></section>
    <main><article class="story">
      <header><h1>Field Notes</h1><p class="byline">By Correct Reporter</p></header>
      <p>${'Long-form reporting from the field with verified observations and primary-source context. '.repeat(30)}</p>
    </article></main>
  </body></html>`;

  const { metadata, content } = extractArticle(html, 'https://example.com/field-notes', '2026-08-31');

  assert.equal(metadata.author, 'Correct Reporter');
  assert.match(content, /Long-form reporting from the field/);
  assert.doesNotMatch(content, /A reader comment/);
});

test('uses author meta before site name and site name only as a last fallback', () => {
  const article = `<article><h1>Fallbacks</h1><p>${'Substantive reporting provides enough prose for deterministic extraction. '.repeat(25)}</p></article>`;
  const withAuthor = `<!doctype html><html><head><meta name="author" content="Meta Author"><meta property="og:site_name" content="Publisher Name"></head><body>${article}</body></html>`;
  const siteOnly = `<!doctype html><html><head><meta property="og:site_name" content="Publisher Name"></head><body>${article}</body></html>`;

  assert.equal(extractArticle(withAuthor, 'https://example.com/with-author').metadata.author, 'Meta Author');
  assert.equal(extractArticle(siteOnly, 'https://example.com/site-only').metadata.author, 'Publisher Name');
});

test('removes role-dialog subscription overlays during final sanitization', () => {
  const html = `<!doctype html><html><body>
    <div role="dialog" class="modal-backdrop subscribe-overlay"><h2>Follow on Substack</h2><p>Subscribe now</p></div>
    <main><article><h1>Reported findings</h1><p>${'The report documents independently verified evidence from the field. '.repeat(30)}</p></article></main>
  </body></html>`;
  const { content } = extractArticle(html, 'https://example.com/report');
  assert.match(content, /independently verified evidence/);
  assert.doesNotMatch(content, /Follow on Substack|Subscribe now/);
});

test('uses a distinct masthead h1 as conservative author fallback', () => {
  const html = `<!doctype html><html><head><title>Article title</title></head><body>
    <header><h1>The Daily Ledger</h1></header>
    <main><article><h1>Article title</h1><p>${'A careful account with enough detail to establish a real article body. '.repeat(25)}</p></article></main>
  </body></html>`;
  const { metadata } = extractArticle(html, 'https://example.com/article');
  assert.equal(metadata.title, 'Article title');
  assert.equal(metadata.author, 'The Daily Ledger');
});

test('uses valid JSON-LD article metadata after explicit fields', () => {
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: 'JSON-LD Headline',
      author: { '@type': 'Person', name: 'Structured Reporter' },
      datePublished: '2026-08-28',
      dateModified: '2026-08-29',
    })}</script>
  </head><body><main><article><h1>JSON-LD Headline</h1><p>${'Structured reporting with verified details and context. '.repeat(25)}</p></article></main></body></html>`;
  const { metadata } = extractArticle(html, 'https://example.com/structured', '2026-08-31');
  assert.equal(metadata.title, 'JSON-LD Headline');
  assert.equal(metadata.author, 'Structured Reporter');
  assert.equal(metadata.published, '2026-08-28');
});

test('merges meaningful visual assets omitted by Readability', () => {
  const prose = 'The architecture uses independently verified layers and measured boundaries. '.repeat(35);
  const html = `<!doctype html><html><body><main>
    <article><h1>Architecture review</h1><p>${prose}</p></article>
    <figure class="architecture-diagram"><img src="/assets/architecture.png" alt="System architecture"><figcaption>System architecture</figcaption></figure>
    <svg class="architecture-chart" viewBox="0 0 10 10"><path d="M0 0h10v10z"></path></svg>
    <div class="share-icons"><img src="/assets/share.png" alt="Share"></div>
  </main></body></html>`;
  const { content } = extractArticle(html, 'https://example.com/review/index.html');
  const root = parseFragment(content);
  assert.equal(root.querySelectorAll('figure').length, 1);
  assert.equal(root.querySelector('figure img').getAttribute('src'), 'https://example.com/assets/architecture.png');
  assert.equal(root.querySelector('figcaption').textContent, 'System architecture');
  assert.ok(root.querySelector('svg.architecture-chart'));
  assert.equal(root.querySelector('img[src*="share"]'), null);
});

test('deduplicates visual recovery and excludes recommendation thumbnails', () => {
  const prose = 'The measured architecture remained stable across repeated observations. '.repeat(35);
  const html = `<!doctype html><html><body><main>
    <article><h1>Architecture</h1><p>${prose}</p></article>
    <figure><img src="/assets/architecture.png" alt="Architecture diagram"><figcaption>Architecture diagram</figcaption></figure>
    <section class="duplicate-figure"><figure><img src="/assets/architecture-large.png" alt="Architecture diagram"><figcaption>Architecture diagram</figcaption></figure></section>
    <section class="recommendations"><h2>Other posts of interest</h2><article><img src="/assets/other-post.png" alt="Other post"></article></section>
  </main></body></html>`;
  const { content } = extractArticle(html, 'https://example.com/review');
  const root = parseFragment(content);
  assert.equal(root.querySelectorAll('figure').length, 2);
  assert.equal(root.querySelectorAll('img[alt="Architecture diagram"]').length, 2);
  assert.equal(root.querySelector('img[alt="Other post"]'), null);
  assert.doesNotMatch(content, /Other posts of interest/);
});

test('removes flat recommendation siblings after a recommendation heading', () => {
  const prose = 'The article contains primary research and detailed evidence. '.repeat(35);
  const html = `<!doctype html><html><body><main><article><h1>Research</h1><p>${prose}</p></article>
    <h2>More from this publication</h2>
    <div class="card"><img src="/thumb-a.jpg" alt="More from author"></div>
    <figure><img src="/thumb-b.jpg" alt="Recommended reading"></figure>
  </main></body></html>`;
  const { content } = extractArticle(html, 'https://example.com/research');
  const root = parseFragment(content);
  assert.match(content, /primary research/);
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.doesNotMatch(content, /More from this publication|Recommended reading/);
});

test('filters linked recommendation visuals by article pathname', () => {
  const prose = 'The in-article evidence is detailed and independently sourced. '.repeat(35);
  const html = `<!doctype html><html><body><main>
    <article><h1>Evidence</h1><p>${prose}</p>
      <a href="/evidence"><figure><img src="/assets/in-article.png" alt="Evidence diagram"></figure></a>
    </article>
    <div class="card"><a href="/other-story"><img src="/assets/recommendation.png" alt="Related story"></a></div>
  </main></body></html>`;
  const { content } = extractArticle(html, 'https://example.com/evidence');
  const root = parseFragment(content);
  assert.equal(root.querySelector('img[alt="Evidence diagram"]') !== null, true);
  assert.equal(root.querySelector('img[alt="Related story"]'), null);
});

test('removes publication and engagement chrome around article prose', () => {
  const prose = 'The interview develops its argument through detailed examples and careful reasoning. '.repeat(30);
  const html = `<!doctype html><html><body>
    <header class="publication-header"><h1>Ideas Journal</h1><nav>Home Podcast Archive</nav></header>
    <main><article>
      <header class="post-meta"><h1>A Serious Conversation</h1><div class="author-avatar">Avatar</div><p class="byline">By Jane Writer</p><time>August 31</time><div class="share-buttons">Share Like React</div></header>
      <p>${prose}</p><blockquote><p>Legitimate quoted prose.</p></blockquote><ul><li>Legitimate evidence</li></ul>
      <section class="newsletter-signup"><h2>Subscribe to Ideas Journal</h2><button>Subscribe</button></section>
    </article>
    <section class="discussion"><h2>Discussion</h2><p>Reader comment text</p></section>
    <section class="related-posts"><h2>Related posts</h2><p>Another story card</p></section>
    <footer><a href="/privacy">Privacy</a><span>Terms and legal</span></footer>
  </main></body></html>`;
  const { content, metadata } = extractArticle(html, 'https://example.com/conversation');
  const root = parseFragment(content);
  assert.equal(metadata.title, 'A Serious Conversation');
  assert.equal(metadata.author, 'Jane Writer');
  assert.match(content, /interview develops its argument/);
  assert.match(content, /Legitimate quoted prose/);
  assert.equal(root.querySelectorAll('blockquote').length, 1);
  assert.equal(root.querySelectorAll('ul > li').length, 1);
  assert.doesNotMatch(content, /Home Podcast Archive|Avatar|Share Like React|Subscribe to|Reader comment text|Another story card|Privacy|Terms and legal/);
});

test('uses visible publication date when metadata omits it', () => {
  const { metadata } = extractArticle('<html><body><main><article><h1>Visible date</h1><time datetime="2026-08-26">August 26, 2026</time><p>' + 'Readable article prose. '.repeat(30) + '</p></article></main></body></html>', 'https://example.com/story');
  assert.equal(metadata.published, '2026-08-26');
});

test('does not treat an article section label as the author', () => {
  const { metadata } = extractArticle('<html><head><meta property="og:title" content="Incident"></head><body><main><article><h1>Incident</h1><p class="byline">First message board entry</p><p>' + 'Readable article prose. '.repeat(30) + '</p></article></main></body></html>', 'https://openai.com/index/incident');
  assert.equal(metadata.author, 'OpenAI');
});
test('reconstructs interactive event timelines as readable semantic cards', () => {
  const html = `<!doctype html><html><head><title>Timeline</title></head><body><main><article><h1>Timeline</h1><p>Lead context.</p><h2>Incident timeline</h2><section class="EventTimeline-module__itc"><section class="EventTimeline-module__itc-day"><h3 class="EventTimeline-module__label">May 12</h3><span>Artifactory</span><article class="EventTimeline-module__card"><time class="EventTimeline-module__timestamp">2026-05-12</time><span class="EventTimeline-module__step">01</span><span class="EventTimeline-module__title">First message board entry</span><span class="EventTimeline-module__description">An agent left a note.</span><div class="EventTimeline-module__reasoning"><span class="EventTimeline-module__reasoning-label">Chain of thought</span><span class="EventTimeline-module__reasoning-text">Could communicate by uploading a note.</span></div></article></section><div class="EventTimeline-module__gap">+ 13 days</div><section class="EventTimeline-module__itc-day"><h3>May 26</h3><span>Artifactory</span><article class="EventTimeline-module__card"><time>2026-05-26</time><span>02</span><span>Internet via SSRF</span><span>Internet access.</span></article></section></section><p>Closing context.</p></article></main></body></html>`;
  const result = extractArticle(html, SOURCE_URL);
  const document = new JSDOM(`<body>${result.content}</body>`).window.document;
  const timeline = document.querySelector('.reconstructed-timeline');
  assert.ok(timeline);
  assert.equal(timeline.querySelectorAll('.timeline-event').length, 2);
  assert.equal(timeline.querySelector('.timeline-event-title').textContent, 'First message board entry');
  assert.equal(timeline.querySelector('.timeline-category').textContent, 'Artifactory');
  assert.equal(timeline.querySelector('.timeline-reasoning').textContent, 'Could communicate by uploading a note.');
  assert.equal(timeline.querySelector('.timeline-gap').textContent, '+ 13 days');
  assert.doesNotMatch(timeline.innerHTML, /2026-05-1201First/);
});
test('reconstructs only the timeline wrapper and preserves following article content', () => {
  const html = `<!doctype html><html><head><title>Timeline placement</title></head><body><main><article>
    <h1>Timeline placement</h1>
    <section class="article-story-section">
      <h2>Incident timeline</h2>
      <div class="timeline-shell">
        <div class="EventTimeline-module__itc">
          <section class="EventTimeline-module__itc-day">
            <h3>May 12</h3>
            <article class="EventTimeline-module__card">
              <time>2026-05-12</time><span>01</span><span>First event</span><span>Initial event details.</span>
            </article>
          </section>
        </div>
      </div>
      <p id="post-timeline-prose">Required analysis after the timeline.</p>
      <figure id="post-timeline-figure"><img src="/assets/follow-up.png" alt="Follow-up evidence"><figcaption>Follow-up evidence</figcaption></figure>
    </section>
  </article></main></body></html>`;
  const { content } = extractArticle(html, SOURCE_URL);
  const document = new JSDOM(`<body>${content}</body>`).window.document;

  assert.ok(document.querySelector('.reconstructed-timeline'));
  assert.equal(document.querySelector('[class*="EventTimeline"]'), null);
  assert.equal(document.querySelector('.timeline-shell'), null);
  assert.equal(document.querySelector('#post-timeline-prose')?.textContent, 'Required analysis after the timeline.');
  assert.equal(document.querySelector('#post-timeline-figure img')?.getAttribute('src'), 'https://example.com/assets/follow-up.png');
});

test('keeps visible prose while removing hidden accessibility and animated duplicates', () => {
  const html = `<main><article><h1>Visible report</h1>
    <p class="visible-prose">The visible conclusion is authoritative. ${'The measured result is supported by independent evidence. '.repeat(12)}</p>
    <p>${'Additional context establishes the report with independently checked evidence. '.repeat(30)}</p>
    <p class="sr-only">The visible conclusion is authoritative.</p>
    <p aria-hidden="true">The visible conclusion is authoritative.</p>
    <p hidden>The visible conclusion is authoritative.</p>
    <p class="animated-characters"><span aria-hidden="true">The visible conclusion is authoritative.</span></p>
    <p>Additional context with <a href="/evidence">Evidence <span class="external-link-icon" aria-hidden="true">↗</span><span class="new-window">(opens in a new window)</span></a>.</p>
  </article></main>`;
  const { content } = extractArticle(html, SOURCE_URL);
  const document = new JSDOM(`<body>${content}</body>`).window.document;
  assert.match(document.body.textContent || '', /The visible conclusion is authoritative\./);
  assert.equal((content.match(/The visible conclusion is authoritative\./g) ?? []).length, 1);
  assert.equal(document.querySelector('a')?.textContent, 'Evidence');
  assert.doesNotMatch(content, /opens in a new window|↗/);
});
test('preserves meaningful graphics but omits empty chart placeholders', () => {
  const prose = 'A detailed visual analysis accompanies these findings. '.repeat(35);
  const html = `<main><article><h1>Visual findings</h1><p>${prose}</p>
    <figure class="empty-chart"><svg viewBox="0 0 100 40"></svg><figcaption>Loading chart</figcaption></figure>
    <figure class="real-chart"><svg viewBox="0 0 100 40"><path d="M0 30 L50 10 L100 20"></path></svg><figcaption>Observed trend</figcaption></figure>
  </article></main>`;
  const { content } = extractArticle(html, SOURCE_URL);
  const document = new JSDOM(`<body>${content}</body>`).window.document;
  assert.equal(document.querySelector('.empty-chart'), null);
  assert.ok(document.querySelector('.real-chart svg path'));
  assert.equal(document.querySelector('.real-chart figcaption')?.textContent, 'Observed trend');
});


test('recovers prose sections that Readability drops around interactive components', () => {
  const repeated = 'Detailed analysis establishes the evidence and context for the incident. '.repeat(12);
  const html = `<main><article><h1>Complete incident report</h1>
    <section><h2>What happened</h2><p>${repeated}</p></section>
    <div class="EventTimeline-module__itc"><section class="EventTimeline-module__itc-day"><h3>May 12</h3><article class="EventTimeline-module__card"><time>2026-05-12</time><span>01</span><span>Observed event</span><span>Timeline detail.</span></article></section></div>
    <section><h2>Looking forward</h2><p>${repeated}Further safeguards are planned.</p></section>
  </article></main>`;
  const { content } = extractArticle(html, SOURCE_URL);
  assert.match(content, /What happened/);
  assert.match(content, /Looking forward/);
  assert.match(content, /Further safeguards are planned/);
});

test('preserves localized asset paths during sanitization', () => {
  const html = `<main><article><h1>Localized asset</h1><p>${'The report includes a captured local visual asset. '.repeat(30)}</p><figure><img data-src="./assets/chart.png" alt="Captured chart"></figure></article></main>`;
  const { content } = extractArticle(html, SOURCE_URL);
  const document = new JSDOM(`<body>${content}</body>`).window.document;
  assert.equal(document.querySelector('img')?.getAttribute('src'), './assets/chart.png');
});

test('retains meaningful visuals inside reconstructed timeline events', () => {
  const html = `<main><article><h1>Visual timeline</h1><p>${'Context for the visual incident timeline. '.repeat(30)}</p><div class="EventTimeline-root"><div class="EventTimeline_day"><h3>Day one</h3><div class="EventTimeline_card"><span class="EventTimeline_title">Visual event</span><svg viewBox="0 0 10 10"><path d="M0 0L10 10"></path></svg></div></div></div></article></main>`;
  const { content } = extractArticle(html, SOURCE_URL);
  const document = new JSDOM(`<body>${content}</body>`).window.document;
  assert.equal(document.querySelectorAll('.timeline-event').length, 1);
  assert.ok(document.querySelector('.timeline-event svg path'));
});
test('promotes linked X article metadata and places its media first', () => {
  const html = `<head><meta property="og:title" content="Cerebras (@cerebras) on X"><meta property="og:description" content="How we built our knowledge base"></head><main><article><p>Article</p><p>See new posts</p><p>Authors: @hi_im_isaac_</p><p>note: the interactive version of full technical blog available: https://example.com</p><img alt="Article cover image" src="https://cdn.example.com/cover.jpg"><p>${'Employees ask useful questions. '.repeat(30)}</p></article></main>`;
  const result = extractArticle(html, 'https://x.com/cerebras/status/123');
  const document = new JSDOM(`<body>${result.content}</body>`).window.document;
  assert.equal(result.metadata.title, 'How we built our knowledge base');
  assert.equal(result.metadata.author, '@cerebras');
  assert.equal(document.querySelector('img')?.alt, 'Article cover image');
  assert.doesNotMatch(document.body.textContent, /Authors:|interactive version/);
});

test('preserves equations and table semantics needed by printed reports', () => {
  const result = extractArticle('<main><article><h1>Report</h1><p>Equation <math display="block"><mrow><mi>x</mi><mo>=</mo><mn>42</mn></mrow></math></p><table><thead><tr><th scope="col">Measure</th></tr></thead><tbody><tr><td rowspan="2">Value</td></tr></tbody></table></article></main>', SOURCE_URL);
  assert.match(result.content, /<math[^>]*display="block"/);
  assert.match(result.content, /<mi>x<\/mi>/);
  assert.match(result.content, /<th[^>]*scope="col"/);
  assert.match(result.content, /<td[^>]*rowspan="2"/);
});
