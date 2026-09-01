import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { normalizeMetadata } from './model.js';

const REMOVE = new Set(['script','style','noscript','template','nav','form','input','button','select','textarea','option','aside','footer','dialog']);
const ALLOWED = new Set(['article','section','div','header','span','main','h1','h2','h3','h4','h5','h6','p','a','blockquote','ul','ol','li','pre','code','table','caption','thead','tbody','tfoot','tr','th','td','figure','figcaption','img','picture','source','svg','g','path','circle','ellipse','line','polyline','polygon','rect','title','desc','text','tspan','defs','clippath','lineargradient','radialgradient','stop','marker','mask','pattern','video','audio','track','iframe','embed','object','br','hr','strong','em','b','i','small','sub','sup','mark','time','math','mrow','mi','mo','mn','msup','msub','mfrac','munderover','semantics','annotation','use','image']);
const GLOBAL = new Set(['id','class','title','lang','dir','role','aria-label','aria-labelledby','aria-describedby']);
const ATTRS = {
  a: new Set(['href','target','rel','download','hreflang','type']), blockquote: new Set(['cite']),
  img: new Set(['src','srcset','alt','width','height','loading','decoding','sizes','referrerpolicy']), source: new Set(['src','srcset','sizes','type','media']),
  video: new Set(['src','poster','controls','width','height','preload','playsinline','muted']), audio: new Set(['src','controls','preload']), track: new Set(['src','kind','srclang','label','default']),
  iframe: new Set(['src','title','width','height','loading','allow','allowfullscreen','referrerpolicy']), embed: new Set(['src','type','width','height']), object: new Set(['data','type','width','height']),
  th: new Set(['colspan','rowspan','scope','headers']), td: new Set(['colspan','rowspan','headers']),
  math: new Set(['display','xmlns','mathvariant']), annotation: new Set(['encoding']),
  svg: new Set(['viewbox','preserveaspectratio','xmlns','width','height','role','focusable','version','x','y']),
  g: new Set(['transform','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','opacity','clip-path','mask','fill-rule','clip-rule']),
  path: new Set(['d','fill','stroke','stroke-width','fill-rule','clip-rule','transform','opacity','vector-effect']),
  circle: new Set(['cx','cy','r','fill','stroke','stroke-width','transform','opacity']), ellipse: new Set(['cx','cy','rx','ry','fill','stroke','stroke-width','transform','opacity']),
  line: new Set(['x1','x2','y1','y2','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','transform','opacity']),
  polyline: new Set(['points','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','transform','opacity']), polygon: new Set(['points','fill','stroke','stroke-width','transform','opacity']),
  rect: new Set(['x','y','width','height','rx','ry','fill','stroke','stroke-width','transform','opacity','clip-path']),
  text: new Set(['x','y','dx','dy','text-anchor','dominant-baseline','font-family','font-size','font-weight','fill','stroke','transform','opacity','letter-spacing']),
  tspan: new Set(['x','y','dx','dy','text-anchor','dominant-baseline','font-family','font-size','font-weight','fill','stroke','transform']),
  defs: new Set([]), desc: new Set([]), title: new Set([]),
  clippath: new Set(['clippathunits','transform']), lineargradient: new Set(['x1','x2','y1','y2','gradientunits','gradienttransform']), radialgradient: new Set(['cx','cy','r','fx','fy','gradientunits','gradienttransform']),
  stop: new Set(['offset','stop-color','stop-opacity']), marker: new Set(['markerheight','markerwidth','orient','refx','refy','viewbox','markerunits']), mask: new Set(['x','y','width','height','maskunits','maskcontentunits']), pattern: new Set(['x','y','width','height','patternunits','patterncontentunits','patterntransform']),
  use: new Set(['href','xlink:href','x','y','width','height','preserveaspectratio']), image: new Set(['href','xlink:href','x','y','width','height','preserveaspectratio']), time: new Set(['datetime']),
};
const URL_ATTRS = new Set(['href','src','poster','cite','data','xlink:href']);
const CHROME_TOKENS = /(?:^|[-_\s])(subscribe|subscription|paywall|comment|comments|discussion|share|sharing|social|reaction|related|recommendation|recommendations|footer|legal|avatar|masthead|publication-header|main-menu|portable-archive|post-ufi|like-button|ready-for-more|channel-frame|session-attribution|visitedsurfacesiframe|post-label)(?:$|[-_\s])/i;
const CHROME_HEADING = /^(subscribe|join|discussion|comments?|related posts?|recommended|recommendations|more from|you may also like|ready for more)\b/i;
const SAFE_DATA_ATTRS = new Set(['data-footnote-ref','data-footnote-backref','data-src','data-srcset']);
const HIDDEN_CLASS = /(?:^|[-_\s])(sr[-_]?only|screen[-_]?reader[-_\s]?only|visually[-_\s]?hidden)(?:$|[-_\s])/i;
function isHiddenElement(element) {
  return element.hasAttribute('hidden') || element.hasAttribute('inert') ||
    element.getAttribute('aria-hidden') === 'true' || HIDDEN_CLASS.test(String(element.className || ''));
}

function isChromeElement(element) {
  const identity = `${element.id || ''} ${element.className || ''} ${element.getAttribute?.('role') || ''}`;
  if (CHROME_TOKENS.test(identity)) return true;
  if (/^(navigation|contentinfo|dialog)$/.test(element.getAttribute?.('role') || '')) return true;
  return /^(H2|H3|H4)$/.test(element.tagName) && CHROME_HEADING.test(element.textContent.trim());
}

function removeChrome(root) {
  for (const element of [...root.querySelectorAll('*')]) {
    if (!element.isConnected || !isChromeElement(element)) continue;
    if (element.matches('header') && element.closest('article')) continue;
    const container = element.matches('h2, h3, h4') ? element.closest('section, aside, div') : element;
    (container || element).remove();
  }
  for (const header of root.querySelectorAll('article header')) {
    for (const ui of header.querySelectorAll('time, .byline, [rel="author"], [class*="avatar" i], [class*="share" i], [class*="social" i], [class*="reaction" i]')) ui.remove();
  }
}

function safeUrl(value, base) {
  const raw = String(value).trim();
  if (!raw || raw.startsWith('#')) return raw;
  if (/^(?:\.\/)?assets\//i.test(raw)) return raw.startsWith('./') ? raw : `./${raw}`;
  try { const parsed = new URL(raw, base); return ['http:','https:','mailto:','tel:'].includes(parsed.protocol) ? parsed.href : null; } catch { return null; }
}
function meta(document, selectors) { for (const selector of selectors) { const value = document.querySelector(selector)?.getAttribute('content')?.trim(); if (value) return value; } return null; }
function normalizeSrcset(value, base) {
  return value.split(',').map((part) => { const match = part.trim().match(/^(\S+)(\s+.*)?$/); if (!match) return null; const url = safeUrl(match[1], base); return url ? `${url}${match[2] ?? ''}` : null; }).filter(Boolean).join(', ');
}
function sanitize(root, base) {
  for (const child of [...root.childNodes]) {
    if (child.nodeType === 8) { child.remove(); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.localName.toLowerCase();
    if (isHiddenElement(child)) { child.remove(); continue; }
    if ((tag === 'img' || tag === 'source') && child.getAttribute('data-src')?.match(/^(?:\.\/)?assets\//i)) child.setAttribute('src', child.getAttribute('data-src').startsWith('./') ? child.getAttribute('data-src') : `./${child.getAttribute('data-src')}`);
    if ((tag === 'img' || tag === 'source') && !child.hasAttribute('src') && child.getAttribute('data-src')) child.setAttribute('src', child.getAttribute('data-src'));
    if (tag === 'a') cleanAnchor(child);
    if (REMOVE.has(tag) || child.getAttribute('role')?.toLowerCase() === 'dialog' || child.matches('[class*="advert" i], [id*="advert" i], [class*="sponsor" i], [id*="sponsor" i], [class*="modal" i], [class*="backdrop" i], [class*="overlay" i], [class*="subscribe" i], [class*="share" i], [class*="social" i], img[alt*="avatar" i], img[alt*="profile" i]')) { child.remove(); continue; }
    if (!ALLOWED.has(tag)) { sanitize(child, base); while (child.firstChild) root.insertBefore(child.firstChild, child); child.remove(); continue; }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      if (!(GLOBAL.has(name) || ATTRS[tag]?.has(name) || SAFE_DATA_ATTRS.has(name)) || name.startsWith('on') || (name.startsWith('data-') && !SAFE_DATA_ATTRS.has(name)) || name === 'style' || name === 'srcdoc') { child.removeAttribute(attr.name); continue; }
      if (name === 'srcset') { const normalized = normalizeSrcset(attr.value, base); if (normalized) child.setAttribute(name, normalized); else child.removeAttribute(name); }
      else if (URL_ATTRS.has(name)) { const normalized = safeUrl(attr.value, base); if (normalized) child.setAttribute(name, normalized); else child.removeAttribute(name); }
    }
    sanitize(child, base);
  }
}
function parseStructuredMetadata(document) {
  const values = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent);
      values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {}
  }
  const candidates = values.flatMap((value) => Array.isArray(value?.['@graph']) ? value['@graph'] : [value]).filter(Boolean);
  const item = candidates.find((value) => /article|newsarticle|blogposting/i.test(String(value['@type']))) || candidates[0] || {};
  const author = Array.isArray(item.author) ? item.author[0] : item.author;
  return { title: typeof item.headline === 'string' ? item.headline.trim() : null, author: typeof author === 'string' ? author.trim() : author?.name?.trim() || null, published: typeof item.datePublished === 'string' ? item.datePublished.trim() : typeof item.dateModified === 'string' ? item.dateModified.trim() : null };
}
function pruneForReadability(document) {
  removeChrome(document);
  for (const element of document.querySelectorAll('[hidden], [inert], [aria-hidden="true"], [class]')) {
    if (isHiddenElement(element)) element.remove();
  }
  for (const element of document.querySelectorAll('dialog, nav, form, [role="dialog"], [class*="modal" i], [class*="overlay" i], [class*="subscribe" i], [class*="substack" i]')) {
    if (!element.closest('article') || element.matches('dialog, [role="dialog"], [class*="modal" i], [class*="overlay" i], [class*="subscribe" i], [class*="substack" i]')) element.remove();
  }
  for (const heading of document.querySelectorAll('h2, h3, h4')) {
    if (/other posts of interest|recommended|recommendations|you may also like/i.test(heading.textContent)) (heading.closest('section, aside, div') || heading).remove();
  }
}
function mergeVisuals(contentRoot, sourceDocument, sourceUrl) {
  const visualRoot = sourceDocument.querySelector('main') || sourceDocument.querySelector('article') || sourceDocument.body;
  if (!visualRoot) return;
  const candidates = visualRoot.querySelectorAll('figure, picture, svg, img');
  const seenAlt = new Set([...contentRoot.querySelectorAll('img[alt]')].map((img) => img.alt.trim().toLowerCase()).filter(Boolean));
  const seenBase = new Set([...contentRoot.querySelectorAll('img[src]')].map((img) => img.src.split(/[?#]/)[0].split('/').pop().toLowerCase()));
  for (const candidate of candidates) {
    if (candidate.matches('svg') && candidate.closest('figure')) continue;
    const linked = candidate.closest('a[href]');
    if (linked) {
      try {
        const target = new URL(linked.href, sourceUrl);
        const current = new URL(sourceUrl);
        if (target.origin === current.origin && target.pathname !== current.pathname) continue;
      } catch {}
    }
    if (candidate.matches('img') && /share|social/i.test(`${candidate.getAttribute('alt') || ''} ${candidate.getAttribute('src') || ''}`)) continue;
    const image = candidate.matches('img') ? candidate : candidate.querySelector('img');
    if (image && /recommended|more[- ]from|other[- ]post/i.test(`${image.getAttribute('alt') || ''} ${image.getAttribute('src') || ''}`)) continue;
    const alt = image?.getAttribute('alt')?.trim().toLowerCase();
    const sourceIdentity = image?.getAttribute('src') ? (safeUrl(image.getAttribute('src'), sourceUrl) || image.getAttribute('src')).split(/[?#]/)[0] : '';
    if (sourceIdentity && [...contentRoot.querySelectorAll('img[src]')].some((img) => (safeUrl(img.getAttribute('src'), sourceUrl) || img.getAttribute('src')).split(/[?#]/)[0] === sourceIdentity)) continue;
    const identity = candidate.matches('img') ? candidate.getAttribute('src') : candidate.matches('svg') ? candidate.getAttribute('id') || candidate.outerHTML : image?.getAttribute('src');
    const duplicate = candidate.matches('svg') ? [...contentRoot.querySelectorAll('svg')].some((svg) => identity && (svg.id === identity || svg.outerHTML === candidate.outerHTML)) : [...contentRoot.querySelectorAll('img')].some((img) => identity && img.getAttribute('src') === identity);
    if (duplicate) continue;
    contentRoot.appendChild(contentRoot.ownerDocument.importNode(candidate, true));
  }
}
function htmlText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}
function mergeMissingProse(contentRoot, sourceDocument) {
  const sourceArticle = sourceDocument.querySelector('main > article, article:not(.comment), main');
  if (!sourceArticle) return;
  const existingText = contentRoot.textContent.replace(/\s+/g, ' ');
  for (const node of sourceArticle.querySelectorAll(':scope > h2, :scope > h3, :scope > p, :scope > section > h2, :scope > section > h3, :scope > section > p')) {
    if (node.closest('[class*="EventTimeline"]')) continue;
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    if (!text || existingText.includes(text)) continue;
    contentRoot.appendChild(contentRoot.ownerDocument.importNode(node, true));
  }
}
function restoreCompleteSource(contentRoot, sourceDocument) {
  const sourceRoot = sourceDocument.querySelector('[data-toc-content="true"]');
  if (!sourceRoot) return;
  const sourceTextLength = sourceRoot.textContent.replace(/\s+/g, ' ').trim().length;
  const extractedTextLength = contentRoot.textContent.replace(/\s+/g, ' ').trim().length;
  if (sourceTextLength < 200 || sourceTextLength <= extractedTextLength * 1.25) return;
  const staging = contentRoot.ownerDocument.createElement('div');
  for (const node of sourceRoot.childNodes) staging.appendChild(contentRoot.ownerDocument.importNode(node, true));
  for (const timeline of [...staging.querySelectorAll('[class*="EventTimeline"]')]) {
    if (timeline.parentElement?.closest('[class*="EventTimeline"]')) continue;
    timeline.remove();
  }
  for (const heading of [...staging.querySelectorAll('h2, h3')]) {
    if (!/^incident timeline$/i.test(heading.textContent.trim())) continue;
    let sibling = heading.nextSibling;
    while (sibling && (sibling.nodeType !== 1 || /timeline/i.test(`${sibling.className || ''} ${sibling.id || ''}`))) {
      const next = sibling.nextSibling;
      sibling.remove();
      sibling = next;
    }
  }
  contentRoot.replaceChildren(...staging.childNodes);
}
function cleanAnchor(anchor) {
  for (const child of [...anchor.querySelectorAll('[class*="new-window" i], [class*="external-link" i], [aria-label*="new window" i]')]) child.remove();
  const walker = anchor.ownerDocument.createTreeWalker(anchor, 4);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    node.data = node.data.replace(/\u200b|\u200c|\u200d|\ufeff/g, '').replace(/\s*\(opens in a new window\)\s*/gi, ' ');
    if (!node.data.trim()) node.remove();
  }
  const lastText = nodes.filter((node) => node.isConnected && node.data.trim()).at(-1);
  if (lastText) {
    lastText.data = lastText.data.replace(/\s+$/, '');
    const next = anchor.nextSibling;
    if (next?.nodeType === 1 && next.localName === 'a' || next?.nodeType === 3 && /^\w/.test(next.data)) anchor.appendChild(anchor.ownerDocument.createTextNode(' '));
  }
}
function normalizeTextBoundaries(root) {
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (element.closest?.('.reconstructed-timeline')) continue;
    const children = [...element.childNodes];
    for (let index = 0; index < children.length - 1; index += 1) {
      const left = children[index];
      const right = children[index + 1];
      if (left.nodeType === 3 && right.nodeType === 3 && /[\p{L}\p{N}]$/u.test(left.data) && /^[\p{L}\p{N}]/u.test(right.data)) left.data += ' ';
    }
  }
}

function textFrom(root, selector) {
  return root.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() || '';
}
function removeEmptyVisuals(root) {
  for (const svg of [...root.querySelectorAll('svg')]) {
    if (!svg.querySelector('path, circle, ellipse, line, polyline, polygon, rect, image, text, use')) svg.remove();
  }
  for (const figure of [...root.querySelectorAll('figure')]) {
    if (figure.matches('.reconstructed-timeline')) continue;
    const visual = figure.querySelector('img, svg, canvas, video');
    if (!visual || (visual.matches('canvas') && !visual.getAttribute('data-url') && !visual.getAttribute('data-src'))) figure.remove();
  }
}
function cardVisual(card) {
  const visual = card.querySelector('picture, img, svg');
  if (!visual) return '';
  if (visual.matches('svg') && !visual.querySelector('path, circle, ellipse, line, polyline, polygon, rect, image, text, use')) return '';
  if (visual.matches('img') && !(visual.getAttribute('src') || visual.getAttribute('data-src'))) return '';
  return visual.outerHTML;
}
function componentNodes(root, kind) {
  const nodes = [...root.querySelectorAll('*')].filter((element) => [...element.classList].some((token) => (token.endsWith(`-${kind}`) || token.endsWith(`_${kind}`)) && (element === root || element.closest('[class*="EventTimeline" i]'))));
  return [...new Set(nodes)];
}
function reconstructTimeline(sourceDocument, contentRoot) {
  const candidates = [...sourceDocument.querySelectorAll('[class*="EventTimeline" i]')];
  const source = candidates.find((element) => componentNodes(element, 'day').length) || candidates[0];
  if (!source) return;
  const entries = [...componentNodes(source, 'day'), ...componentNodes(source, 'gap')].sort((left, right) => left.compareDocumentPosition(right) & 4 ? -1 : 1);
  if (!entries.length) return;
  const sections = [];
  const seenDays = new Set();
  const seenGaps = new Set();
  const seenCards = new Set();
  for (const entry of entries) {
    if (entry.matches('[class*="gap" i]')) {
      const gap = entry.textContent.replace(/\s+/g, ' ').trim();
      if (gap && !seenGaps.has(gap)) { seenGaps.add(gap); sections.push(`<p class="timeline-gap">${htmlText(gap)}</p>`); }
      continue;
    }
    const date = textFrom(entry, '[class*="day__label"], h3');
    if (seenDays.has(date)) continue;
    seenDays.add(date);
    const dayCategory = [...entry.children].find((child) => child.matches('span') && !child.matches('[class*="card"]'))?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const events = componentNodes(entry, 'card').map((card) => {
      const timestamp = textFrom(card, '[class*="timestamp"], time');
      const step = textFrom(card, '[class*="step"]');
      const title = textFrom(card, '[class*="title"]');
      const description = textFrom(card, '[class*="description"]');
      const key = card.getAttribute('data-event-id') || `${timestamp}|${title}|${description}`;
      if (seenCards.has(key)) return '';
      seenCards.add(key);
      const category = textFrom(card, '[class*="category"]') || dayCategory;
      const reasoning = textFrom(card, '[class*="reasoning__text"], [class*="reasoning-text"]');
      return `<article class="timeline-event">${cardVisual(card)}<header><span class="timeline-category">${htmlText(category)}</span><time datetime="${htmlText(timestamp)}">${htmlText(timestamp)}</time><span class="timeline-step">${htmlText(step)}</span></header><h3 class="timeline-event-title">${htmlText(title)}</h3><p class="timeline-description">${htmlText(description)}</p>${reasoning ? `<blockquote class="timeline-reasoning">${htmlText(reasoning)}</blockquote>` : ''}</article>`;
    }).join('');
    sections.push(`<section class="timeline-day"><h2>${htmlText(date)}</h2>${events}</section>`);
  }
  const timeline = `<figure class="reconstructed-timeline"><figcaption>Incident timeline</figcaption>${sections.join('')}</figure>`;
  const existing = contentRoot.querySelector('[class*="EventTimeline"]');
  if (existing) {
    // Replace the component root itself. Ancestors can be the article's entire
    // content section, so walking to a generic section/div truncates siblings.
    existing.replaceWith(JSDOM.fragment(timeline).firstChild);
  } else {
    const heading = [...contentRoot.querySelectorAll('h2,h3,section,div')].find((element) => /^incident timeline$/i.test(element.textContent.trim()));
    if (heading) heading.replaceWith(JSDOM.fragment(timeline).firstChild);
    else contentRoot.appendChild(JSDOM.fragment(timeline).firstChild);
  }
}

function removeRecommendationContent(root) {
  const elements = [...root.querySelectorAll('*')];
  const headings = elements.filter((element) => /^(H2|H3|H4)$/.test(element.tagName));
  const recommendation = /other posts of interest|recommended|recommendations|more from|you may also like/i;
  for (const heading of headings) {
    if (!recommendation.test(heading.textContent)) continue;
    const container = heading.closest('section, aside, [class*="recommend" i], [class*="related" i]');
    if (container && container !== root) container.remove();
    else heading.remove();
  }
  for (const visual of [...root.querySelectorAll('figure, img')]) {
    const index = elements.indexOf(visual);
    const preceding = headings.filter((heading) => elements.indexOf(heading) < index).at(-1);
    const image = visual.matches('img') ? visual : visual.querySelector('img');
    if ((preceding && recommendation.test(preceding.textContent)) || (image && /recommended|more[- ]from|other[- ]post/i.test(`${image.alt} ${image.src}`))) visual.remove();
  }
}


function mastheadFallback(document, articleTitle) {
  const candidates = [...document.querySelectorAll('h1')].filter((heading) => !heading.closest('article'));
  if (document.querySelectorAll('h1').length < 2 || !candidates.length) return null;
  const value = candidates[0].textContent.trim();
  return value && value !== articleTitle ? value : null;
}
function xSourceInfo(document, sourceUrl) {
  if (!/^(?:www\.)?(?:x|twitter)\.com$/i.test(new URL(sourceUrl).hostname)) return null;
  const handle = new URL(sourceUrl).pathname.split('/').filter(Boolean)[0] || null;
  const description = meta(document, ['meta[property="og:description"]', 'meta[name="description"]']);
  return { handle: handle ? `@${handle}` : null, title: description };
}
function cleanXArticle(contentRoot, info) {
  if (!info) return;
  for (const paragraph of [...contentRoot.querySelectorAll('p')]) {
    if (/^(?:authors?:|note:\s*the interactive version)/i.test(paragraph.textContent.trim())) paragraph.remove();
  }
  const visual = contentRoot.querySelector('figure, img, picture, svg');
  if (visual) contentRoot.prepend(visual);
}

export function extractArticle(html, url, retrievedDate = null) {
  const sourceUrl = new URL(url).href;
  const dom = new JSDOM(String(html ?? ''), { url: sourceUrl, runScripts: 'outside-only' });
  const { document } = dom.window;
  const ogTitle = meta(document, ['meta[property="og:title"]','meta[name="twitter:title"]']);
  const structured = parseStructuredMetadata(document);
  const published = meta(document, ['meta[property="article:published_time"]','meta[name="date"]','meta[name="pubdate"]','meta[name="datePublished"]']);
  const visibleTextDate = [...document.querySelectorAll('h1')].map((heading) => heading.parentElement?.querySelector('p')?.textContent?.trim()).find((text) => /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/.test(text || '')) || null;
  const visiblePublished = visibleTextDate || document.querySelector('time[datetime], [itemprop="datePublished"]')?.getAttribute('datetime') || document.querySelector('time')?.textContent?.trim() || null;
  const canonical = document.querySelector('link[rel="canonical"]')?.href || sourceUrl;
  const readabilityDocument = document.cloneNode(true);
  pruneForReadability(readabilityDocument);
  const article = new Readability(readabilityDocument).parse();
  const articleDom = new JSDOM(`<body>${article?.content ?? document.body?.innerHTML ?? ''}</body>`, { url: sourceUrl });
  const contentRoot = articleDom.window.document.body;
  restoreCompleteSource(contentRoot, readabilityDocument);
  for (const selector of ['iframe', 'embed', 'object']) {
    if (!contentRoot.querySelector(selector)) {
      for (const visual of document.querySelectorAll(`article ${selector}, main ${selector}`)) contentRoot.appendChild(visual.cloneNode(true));
    }
  }
  mergeVisuals(contentRoot, document, sourceUrl);
  removeChrome(contentRoot);
  sanitize(contentRoot, sourceUrl);
  removeEmptyVisuals(contentRoot);
  reconstructTimeline(document, contentRoot);
  const xInfo = xSourceInfo(document, sourceUrl);
  cleanXArticle(contentRoot, xInfo);
  normalizeTextBoundaries(contentRoot);
  const rawArticleByline = document.querySelector('main > article header [rel="author"], main > article header .byline, article:not(.comment) > header [rel="author"], article:not(.comment) > header .byline, main > article [rel="author"], main > article .byline')?.textContent?.replace(/^\s*by\s+/i, '')?.trim() || null;
  const articleByline = rawArticleByline && !/^(first|last) message board entry$/i.test(rawArticleByline) ? rawArticleByline : null;
  const authorMeta = meta(document, ['meta[property="article:author"]','meta[name="author"]','meta[name="byline"]']);
  const articleHeading = document.querySelector('main > article h1, article:not(.comment) h1, main h1')?.textContent?.trim() || null;
  const fallbackAuthor = authorMeta || meta(document, ['meta[property="og:site_name"]']) || (/openai\.com/i.test(sourceUrl) ? 'OpenAI' : null);
  const title = xInfo?.title || ogTitle || articleHeading || article?.title || structured.title || document.title;
  const mastheadAuthor = mastheadFallback(document, title);
  const metadata = normalizeMetadata({
    title,
    author: xInfo?.handle || articleByline || authorMeta || structured.author || (article?.byline && !/comment|first message board entry|last message board entry/i.test(article.byline) ? article.byline : fallbackAuthor || mastheadAuthor),
    published: published || structured.published || article?.publishedTime || visiblePublished,
    sourceUrl: canonical,
    retrieved: retrievedDate,
    text: contentRoot.textContent,
  });
  return { metadata, content: contentRoot.innerHTML };
}
