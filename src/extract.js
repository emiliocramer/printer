import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { normalizeMetadata } from './model.js';

const REMOVE = new Set(['script','style','noscript','template','nav','form','input','button','select','textarea','option','aside','footer','header','dialog']);
const ALLOWED = new Set(['article','section','div','main','h1','h2','h3','h4','h5','h6','p','a','blockquote','ul','ol','li','pre','code','table','caption','thead','tbody','tfoot','tr','th','td','figure','figcaption','img','picture','source','svg','g','path','circle','ellipse','line','polyline','polygon','rect','title','desc','video','audio','track','iframe','embed','object','br','hr','strong','em','b','i','small','sub','sup','mark','dl','dt','dd','details','summary','time','use','image']);
const GLOBAL = new Set(['id','class','title','lang','dir','role','aria-label','aria-labelledby','aria-describedby']);
const ATTRS = {
  a: new Set(['href','target','rel','download','hreflang','type']), blockquote: new Set(['cite']),
  img: new Set(['src','srcset','alt','width','height','loading','decoding','sizes','referrerpolicy']), source: new Set(['src','srcset','sizes','type','media']),
  video: new Set(['src','poster','controls','width','height','preload','playsinline','muted']), audio: new Set(['src','controls','preload']), track: new Set(['src','kind','srclang','label','default']),
  iframe: new Set(['src','title','width','height','loading','allow','allowfullscreen','referrerpolicy']), embed: new Set(['src','type','width','height']), object: new Set(['data','type','width','height']),
  svg: new Set(['viewbox','preserveaspectratio','xmlns','width','height']), path: new Set(['d','fill','stroke','stroke-width','fill-rule','clip-rule']),
  circle: new Set(['cx','cy','r','fill','stroke','stroke-width']), ellipse: new Set(['cx','cy','rx','ry','fill','stroke','stroke-width']), line: new Set(['x1','x2','y1','y2','fill','stroke','stroke-width']),
  polyline: new Set(['points','fill','stroke','stroke-width']), polygon: new Set(['points','fill','stroke','stroke-width']), rect: new Set(['x','y','width','height','rx','ry','fill','stroke','stroke-width']),
  use: new Set(['href','xlink:href','x','y','width','height']), image: new Set(['href','xlink:href','x','y','width','height','preserveaspectratio']), time: new Set(['datetime']),
};
const URL_ATTRS = new Set(['href','src','poster','cite','data','xlink:href']);

function safeUrl(value, base) {
  const raw = String(value).trim();
  if (!raw || raw.startsWith('#')) return raw;
  try { const parsed = new URL(raw, base); return ['http:','https:','mailto:','tel:'].includes(parsed.protocol) ? parsed.href : null; } catch { return null; }
}
function normalizeSrcset(value, base) {
  return value.split(',').map((part) => { const match = part.trim().match(/^(\S+)(\s+.*)?$/); if (!match) return null; const url = safeUrl(match[1], base); return url ? `${url}${match[2] ?? ''}` : null; }).filter(Boolean).join(', ');
}
function sanitize(root, base) {
  for (const child of [...root.childNodes]) {
    if (child.nodeType === 8) { child.remove(); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.localName.toLowerCase();
    if (REMOVE.has(tag) || child.getAttribute('role')?.toLowerCase() === 'dialog' || child.matches('[class*="advert" i], [id*="advert" i], [class*="sponsor" i], [id*="sponsor" i], [class*="modal" i], [class*="backdrop" i], [class*="overlay" i], [class*="subscribe" i], [class*="share" i], [class*="social" i]')) { child.remove(); continue; }
    if (!ALLOWED.has(tag)) { sanitize(child, base); while (child.firstChild) root.insertBefore(child.firstChild, child); child.remove(); continue; }
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      if (!(GLOBAL.has(name) || ATTRS[tag]?.has(name)) || name.startsWith('on') || name.startsWith('data-') || name === 'style' || name === 'srcdoc') { child.removeAttribute(attr.name); continue; }
      if (name === 'srcset') { const normalized = normalizeSrcset(attr.value, base); if (normalized) child.setAttribute(attr.name, normalized); else child.removeAttribute(attr.name); }
      else if (URL_ATTRS.has(name)) { const normalized = safeUrl(attr.value, base); if (normalized) child.setAttribute(attr.name, normalized); else child.removeAttribute(attr.name); }
    }
    sanitize(child, base);
  }
}
function meta(document, selectors) { for (const selector of selectors) { const value = document.querySelector(selector)?.getAttribute('content')?.trim(); if (value) return value; } return null; }
function parseStructuredMetadata(document) {
  const values = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent);
      values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // Ignore malformed structured data and continue with visible metadata.
    }
  }
  const candidates = values.flatMap((value) => Array.isArray(value?.['@graph']) ? value['@graph'] : [value]).filter(Boolean);
  const item = candidates.find((value) => /article|newsarticle|blogposting/i.test(String(value['@type']))) || candidates[0] || {};
  const author = Array.isArray(item.author) ? item.author[0] : item.author;
  return {
    title: typeof item.headline === 'string' ? item.headline.trim() : null,
    author: typeof author === 'string' ? author.trim() : author?.name?.trim() || null,
    published: typeof item.datePublished === 'string' ? item.datePublished.trim() : typeof item.dateModified === 'string' ? item.dateModified.trim() : null,
  };
}

function pruneForReadability(document) {
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
  const candidates = visualRoot.querySelectorAll('figure, svg, img');
  const seenAlt = new Set([...contentRoot.querySelectorAll('img[alt]')].map((img) => img.alt.trim().toLowerCase()).filter(Boolean));
  const seenBase = new Set([...contentRoot.querySelectorAll('img[src]')].map((img) => img.src.split(/[?#]/)[0].split('/').pop().toLowerCase()));
  for (const candidate of candidates) {
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
    const alt = image?.getAttribute('alt')?.trim().toLowerCase();
    const baseName = image?.getAttribute('src')?.split(/[?#]/)[0].split('/').pop().toLowerCase();
    if ((alt && seenAlt.has(alt)) || (baseName && seenBase.has(baseName))) continue;
    const identity = candidate.matches('img') ? candidate.getAttribute('src') : candidate.matches('svg') ? candidate.getAttribute('id') || candidate.outerHTML : image?.getAttribute('src');
    const duplicate = candidate.matches('svg') ? [...contentRoot.querySelectorAll('svg')].some((svg) => identity && (svg.id === identity || svg.outerHTML === candidate.outerHTML)) : [...contentRoot.querySelectorAll('img')].some((img) => identity && img.getAttribute('src') === identity);
    if (duplicate) continue;
    if (alt) seenAlt.add(alt);
    if (baseName) seenBase.add(baseName);
    contentRoot.appendChild(contentRoot.ownerDocument.importNode(candidate, true));
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

export function extractArticle(html, url, retrievedDate = null) {
  const sourceUrl = new URL(url).href;
  const dom = new JSDOM(String(html ?? ''), { url: sourceUrl, runScripts: 'outside-only' });
  const { document } = dom.window;
  const ogTitle = meta(document, ['meta[property="og:title"]','meta[name="twitter:title"]']);
  const structured = parseStructuredMetadata(document);
  const published = meta(document, ['meta[property="article:published_time"]','meta[name="date"]','meta[name="pubdate"]','meta[name="datePublished"]']);
  const canonical = document.querySelector('link[rel="canonical"]')?.href || sourceUrl;
  const readabilityDocument = document.cloneNode(true);
  pruneForReadability(readabilityDocument);
  const article = new Readability(readabilityDocument).parse();
  const articleDom = new JSDOM(`<body>${article?.content ?? document.body?.innerHTML ?? ''}</body>`, { url: sourceUrl });
  const contentRoot = articleDom.window.document.body;
  for (const selector of ['iframe', 'embed', 'object']) {
    if (!contentRoot.querySelector(selector)) {
      for (const visual of document.querySelectorAll(`article ${selector}, main ${selector}`)) contentRoot.appendChild(visual.cloneNode(true));
    }
  }
  const visualDocument = document.cloneNode(true);
  pruneForReadability(visualDocument);
  mergeVisuals(contentRoot, visualDocument, sourceUrl);
  removeRecommendationContent(contentRoot);
  sanitize(contentRoot, sourceUrl);
  const articleByline = document.querySelector('main > article header [rel="author"], main > article header .byline, article:not(.comment) > header [rel="author"], article:not(.comment) > header .byline, main > article [rel="author"], main > article .byline')?.textContent?.replace(/^\s*by\s+/i, '');
  const authorMeta = meta(document, ['meta[property="article:author"]','meta[name="author"]','meta[name="byline"]']);
  const fallbackAuthor = authorMeta || meta(document, ['meta[property="og:site_name"]']);
  const title = ogTitle || article?.title || structured.title || document.title;
  const mastheadAuthor = mastheadFallback(document, title);
  const metadata = normalizeMetadata({
    title,
    author: articleByline || authorMeta || structured.author || (article?.byline && !/comment/i.test(article?.byline) ? article.byline : fallbackAuthor || mastheadAuthor),
    published: published || structured.published || article?.publishedTime,
    sourceUrl: canonical,
    retrieved: retrievedDate,
    text: contentRoot.textContent,
  });
  return { metadata, content: contentRoot.innerHTML };
}
