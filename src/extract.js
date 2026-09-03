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
const PRINTER_ATTRS = new Set(['data-printer-box','data-printer-natural','data-printer-src','data-printer-asset']);
const SAFE_DATA_ATTRS = new Set(['data-footnote-ref','data-footnote-backref','data-src','data-srcset', ...PRINTER_ATTRS]);
const DECORATIVE_NAME = /(?:^|[^a-z])(logo|logos|icon|icons|avatar|avatars|emoji|badge|spinner|loader|loading|placeholder|pixel|tracker|tracking|sprite|arrow|chevron|caret|bullet|divider|separator|accent|ornament|thumb|thumbnail|favicon|profile)(?:$|[^a-z])/i;
const SEMANTIC_NAME = /chart|graph|diagram|figure|plot|map|timeline|illustration|visual|infographic|screenshot|table/i;
const MEDIA_HOSTS = /(?:^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|spotify\.com|soundcloud\.com|twitter\.com|x\.com|loom\.com|wistia\.com|wistia\.net|streamable\.com|tiktok\.com|instagram\.com|codepen\.io|observablehq\.com|dwcdn\.net|flourish\.studio|substack\.com)$/i;
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre';

function parseDimensions(value) {
  const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(String(value ?? '').trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}
/** Best available size for a visual: rendered box, then natural size, then attributes. */
export function visualSize(element) {
  const box = parseDimensions(element.getAttribute('data-printer-box'));
  if (box && box[0] > 0 && box[1] > 0) return { width: box[0], height: box[1], known: true };
  const natural = parseDimensions(element.getAttribute('data-printer-natural'));
  if (natural && natural[0] > 0 && natural[1] > 0) return { width: natural[0], height: natural[1], known: true };
  const width = Number.parseFloat(element.getAttribute('width'));
  const height = Number.parseFloat(element.getAttribute('height'));
  if (width > 0 && height > 0) return { width, height, known: true };
  if (width > 0) return { width, height: width, known: true };
  if (height > 0) return { width: height, height, known: true };
  return { width: 0, height: 0, known: false };
}
function visualName(element) {
  return `${element.getAttribute('alt') || ''} ${element.getAttribute('src') || ''} ${element.getAttribute('data-printer-src') || ''} ${element.getAttribute('class') || ''} ${element.getAttribute('id') || ''} ${element.getAttribute('aria-label') || ''}`;
}
/**
 * Interface icons, logos, avatars and other visuals that carry no article
 * information. Judged from how the element actually rendered when possible.
 */
export function isDecorativeVisual(element, { lenient = false } = {}) {
  const figure = element.closest('figure');
  const captioned = Boolean(figure?.querySelector('figcaption')?.textContent?.trim());
  if (element.matches('svg') && element.closest('a[href], button')) return true;
  if (element.matches('svg') && !element.querySelector('path, circle, ellipse, line, polyline, polygon, rect, image, text')) return true;
  const size = visualSize(element);
  const largest = Math.max(size.width, size.height);
  if (size.known && largest <= 48) return true;
  if (captioned) return false;
  const name = visualName(element);
  if (DECORATIVE_NAME.test(name) && (!size.known || largest <= 240)) return true;
  if (element.matches('svg') && !element.querySelector('text') && !lenient) {
    if (size.known && largest < 120) return true;
    if (!size.known && !SEMANTIC_NAME.test(name) && !figure) return true;
  }
  return false;
}
function removeDecorativeVisuals(root) {
  for (const element of [...root.querySelectorAll('img, svg')]) {
    if (!element.isConnected || element.closest('.reconstructed-timeline')) continue;
    if (!isDecorativeVisual(element)) continue;
    const picture = element.closest('picture');
    const figure = element.closest('figure');
    (picture || element).remove();
    if (figure && !figure.querySelector('img, svg, video, table, pre')) figure.remove();
  }
  for (const img of [...root.querySelectorAll('img')]) if (!img.getAttribute('src')) (img.closest('picture') || img).remove();
}
/** Spec-style srcset parsing: URLs may contain commas, descriptors never contain whitespace. */
export function parseSrcset(value) {
  const tokens = String(value ?? '').trim().split(/\s+/).filter(Boolean)
    .flatMap((token) => { const split = /^(\d+(?:\.\d+)?[wxh],)(\S+)$/i.exec(token); return split ? [split[1], split[2]] : [token]; });
  const candidates = [];
  for (let index = 0; index < tokens.length;) {
    let url = tokens[index++];
    const descriptors = [];
    if (/,$/.test(url)) url = url.replace(/,+$/, '');
    else {
      while (index < tokens.length && /^\d+(?:\.\d+)?[wxh],?$/i.test(tokens[index])) {
        const token = tokens[index++];
        descriptors.push(token.replace(/,+$/, ''));
        if (/,$/.test(token)) break;
      }
    }
    if (url) candidates.push({ url, descriptor: descriptors.join(' ') });
  }
  return candidates;
}
function stripPrinterAttributes(root) {
  for (const element of [root, ...root.querySelectorAll('*')]) for (const name of PRINTER_ATTRS) element.removeAttribute?.(name);
}
/** Once an image has a local copy, responsive alternatives only add ways to break. */
function localizeImages(root) {
  for (const img of [...root.querySelectorAll('img')]) {
    const asset = img.getAttribute('data-printer-asset');
    if (!asset || !/^[A-Za-z0-9._-]+$/.test(asset)) continue;
    img.setAttribute('src', `./assets/${asset}`);
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    const picture = img.closest('picture');
    if (picture) picture.replaceWith(img);
  }
  for (const picture of [...root.querySelectorAll('picture')]) if (!picture.querySelector('img')) picture.remove();
}
function embedNote(element, base) {
  const source = element.getAttribute('src') || element.getAttribute('data') || element.querySelector?.('source[src]')?.getAttribute('src') || '';
  const url = source ? safeUrl(source, base) : null;
  if (!url || !/^https?:/i.test(url)) return null;
  let host = '';
  try { host = new URL(url).hostname; } catch { return null; }
  if (!MEDIA_HOSTS.test(host) && !element.matches('video, audio')) return null;
  const title = element.getAttribute('title')?.trim() || element.getAttribute('aria-label')?.trim() || '';
  const kind = element.matches('video') || /youtu|vimeo|loom|wistia|streamable|tiktok/i.test(host) ? 'Video' : element.matches('audio') || /spotify|soundcloud/i.test(host) ? 'Audio' : 'Embedded content';
  const fragment = JSDOM.fragment(`<p class="embed-note"><span class="embed-kind">${htmlText(kind)}</span>${title ? `: ${htmlText(title)}` : ''} <span class="embed-url">${htmlText(url)}</span></p>`);
  return element.ownerDocument.importNode(fragment.firstChild, true);
}
/** Paper cannot play media. Keep a poster frame when one exists and always keep the address. */
function replaceEmbeds(root, base) {
  for (const element of [...root.querySelectorAll('iframe, embed, object, video, audio')]) {
    if (!element.isConnected) continue;
    const note = embedNote(element, base);
    const poster = element.matches('video') ? safeUrl(element.getAttribute('poster') || '', base) : null;
    const replacement = [];
    if (poster && /^https?:|^\.\/assets\//i.test(poster)) { const img = element.ownerDocument.createElement('img'); img.setAttribute('src', poster); img.setAttribute('alt', element.getAttribute('title') || 'Video poster frame'); replacement.push(img); }
    if (note) replacement.push(note);
    if (replacement.length) element.replaceWith(...replacement); else element.remove();
  }
}
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
  return parseSrcset(value).map(({ url, descriptor }) => { const normalized = safeUrl(url, base); return normalized ? `${normalized}${descriptor ? ` ${descriptor}` : ''}` : null; }).filter(Boolean).join(', ');
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
function normalizedText(element) {
  return element.textContent.replace(/\s+/g, ' ').trim();
}
function imageIdentity(image, base) {
  if (!image) return '';
  const asset = image.getAttribute('data-printer-asset');
  if (asset) return asset.toLowerCase();
  const raw = image.getAttribute('data-printer-src') || image.getAttribute('src') || image.getAttribute('data-src') || '';
  const resolved = raw ? safeUrl(raw, base) || raw : '';
  return resolved.split(/[?#]/)[0].toLowerCase();
}
const INLINE_CONTAINERS = new Set(['li','ul','ol','dl','dt','dd','a','span','em','strong','b','i','small','sup','sub','code','pre','table','thead','tbody','tfoot','tr','td','th','caption','label']);
/** Climb out of lists and inline wrappers so a figure lands between real blocks. */
function blockAnchor(element, root) {
  let current = element;
  while (current.parentElement && current.parentElement !== root && INLINE_CONTAINERS.has(current.parentElement.localName)) current = current.parentElement;
  return current.parentElement ? current : null;
}
/**
 * Locate where a recovered visual belongs by finding the nearest surrounding
 * prose in the source page that survived into the extracted article.
 */
function findVisualAnchor(candidate, sourceBlocks, textIndex, contentRoot) {
  const index = sourceBlocks.indexOf(candidate);
  if (index === -1) return null;
  const lookup = (block) => {
    if (block.contains(candidate) || candidate.contains(block) || block.matches('figure, picture, img, svg')) return null;
    const match = textIndex.get(normalizedText(block));
    return match ? blockAnchor(match, contentRoot) : null;
  };
  for (let cursor = index - 1; cursor >= 0 && cursor >= index - 16; cursor -= 1) {
    const element = lookup(sourceBlocks[cursor]);
    if (element) return { element, before: false };
  }
  for (let cursor = index + 1; cursor < sourceBlocks.length && cursor <= index + 16; cursor += 1) {
    const element = lookup(sourceBlocks[cursor]);
    if (element) return { element, before: true };
  }
  return null;
}
function mergeVisuals(contentRoot, sourceDocument, sourceUrl) {
  const visualRoot = sourceDocument.querySelector('main') || sourceDocument.querySelector('article') || sourceDocument.body;
  if (!visualRoot) return;
  const candidates = [...visualRoot.querySelectorAll('figure, picture, svg, img')].filter((element) => !element.parentElement?.closest('figure, picture, svg'));
  const identities = new Set([...contentRoot.querySelectorAll('img')].map((img) => imageIdentity(img, sourceUrl)).filter(Boolean));
  const svgSignatures = new Set([...contentRoot.querySelectorAll('svg')].map((svg) => svg.getAttribute('id') || svg.outerHTML));
  const textIndex = new Map();
  for (const block of contentRoot.querySelectorAll(BLOCK_SELECTOR)) {
    const text = normalizedText(block);
    if (text.length >= 30 && !textIndex.has(text)) textIndex.set(text, block);
  }
  const sourceBlocks = [...visualRoot.querySelectorAll(`${BLOCK_SELECTOR}, figure, picture, img, svg`)];
  const proseIndexes = sourceBlocks.map((block, index) => (!block.matches('figure, picture, img, svg') && textIndex.has(normalizedText(block)) ? index : -1)).filter((index) => index >= 0);
  const firstProse = proseIndexes[0] ?? -1;
  const lastProse = proseIndexes.at(-1) ?? -1;
  for (const candidate of candidates) {
    if (candidate.closest('nav, footer, aside, button, form, [role="button"], [role="navigation"], [role="contentinfo"], [aria-hidden="true"], [hidden]')) continue;
    if (candidate.closest('header') && !candidate.closest('article')) continue;
    if (candidate.closest('[class*="share" i], [class*="social" i], [class*="comment" i], [class*="recommend" i], [class*="related" i], [class*="subscribe" i], [class*="avatar" i], [class*="byline" i], [class*="profile" i], [class*="author" i]')) continue;
    if (candidate.closest('[class*="featured" i], [class*="teaser" i], [class*="promo" i], [class*="newsletter" i], [class*="widget" i], [class*="sidebar" i], [class*="cta" i], [class*="banner" i], [class*="carousel" i], [class*="slider" i], [class*="popular" i], [class*="trending" i], [class*="tab-pane" i], [id*="related" i], [id*="recommend" i]')) continue;
    const linked = candidate.closest('a[href]');
    if (linked) {
      try {
        const target = new URL(linked.href, sourceUrl);
        const current = new URL(sourceUrl);
        if (target.origin === current.origin && target.pathname !== current.pathname) continue;
      } catch {}
    }
    const image = candidate.matches('img') ? candidate : candidate.querySelector('img');
    const visual = image || (candidate.matches('svg') ? candidate : candidate.querySelector('svg'));
    if (!visual) continue;
    if (/share|social|recommended|more[- ]from|other[- ]post/i.test(`${visual.getAttribute('alt') || ''} ${visual.getAttribute('src') || ''}`)) continue;
    if (isDecorativeVisual(visual)) continue;
    const captioned = Boolean(candidate.querySelector?.('figcaption')?.textContent?.trim());
    const size = visualSize(visual);
    if (!captioned && size.known && Math.max(size.width, size.height) < 120) continue;
    if (!captioned && !size.known && image && !candidate.matches('figure')) continue;
    // Anything after the article's last paragraph is site furniture unless it
    // is a captioned figure; anything before the first paragraph must be a
    // real hero image rather than a thumbnail.
    const position = sourceBlocks.indexOf(candidate);
    const semantic = SEMANTIC_NAME.test(`${candidate.getAttribute('class') || ''} ${visual.getAttribute('alt') || ''} ${visual.getAttribute('class') || ''}`);
    if (!captioned && !semantic && lastProse >= 0 && position > lastProse) continue;
    if (!captioned && firstProse >= 0 && position < firstProse && (!size.known || size.width < 300)) continue;
    if (image) {
      const identity = imageIdentity(image, sourceUrl);
      if (!identity || identities.has(identity)) continue;
      identities.add(identity);
    } else {
      const signature = candidate.getAttribute('id') || candidate.outerHTML;
      if (svgSignatures.has(signature)) continue;
      svgSignatures.add(signature);
    }
    const clone = contentRoot.ownerDocument.importNode(candidate, true);
    const anchor = findVisualAnchor(candidate, sourceBlocks, textIndex, contentRoot);
    if (anchor?.before) anchor.element.parentNode.insertBefore(clone, anchor.element);
    else if (anchor) anchor.element.parentNode.insertBefore(clone, anchor.element.nextSibling);
    else contentRoot.appendChild(clone);
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
    const visual = figure.querySelector('img, svg, canvas, video, table, pre, .embed-note');
    if (!visual || (visual.matches('canvas') && !visual.getAttribute('data-url') && !visual.getAttribute('data-src'))) figure.remove();
  }
}
function cardVisual(card) {
  // Responsive pages often ship the same card twice (mobile and desktop);
  // prefer whichever copy the browser actually loaded and we captured locally.
  const visual = card.querySelector('img[data-printer-asset]') || card.querySelector('img[data-printer-src]') || card.querySelector('img, svg');
  if (!visual) return '';
  if (visual.matches('svg') && !visual.querySelector('path, circle, ellipse, line, polyline, polygon, rect, image, text, use')) return '';
  if (visual.matches('img') && !(visual.getAttribute('src') || visual.getAttribute('data-src'))) return '';
  if (isDecorativeVisual(visual, { lenient: true })) return '';
  return visual.outerHTML;
}
function componentNodes(root, kind) {
  const nodes = [...root.querySelectorAll('*')].filter((element) => [...element.classList].some((token) => (token.endsWith(`-${kind}`) || token.endsWith(`_${kind}`)) && (element === root || element.closest('[class*="EventTimeline" i]'))));
  return [...new Set(nodes)];
}
function reconstructTimeline(sourceDocument, contentRoot, sourceUrl) {
  const candidates = [...sourceDocument.querySelectorAll('[class*="EventTimeline" i]')];
  const source = candidates.find((element) => componentNodes(element, 'day').length) || candidates[0];
  if (!source) return;
  const entries = [...componentNodes(source, 'day'), ...componentNodes(source, 'gap')].sort((left, right) => left.compareDocumentPosition(right) & 4 ? -1 : 1);
  if (!entries.length) return;
  const sections = [];
  const seenDays = new Set();
  const seenGaps = new Set();
  const seenCards = new Set();
  const cardKey = (card) => card.getAttribute('data-event-id') || `${textFrom(card, '[class*="timestamp"], time')}|${textFrom(card, '[class*="title"]')}|${textFrom(card, '[class*="description"]')}`;
  // Duplicate responsive copies of a card may differ only in which image the
  // browser loaded, so pick the best visual across all copies up front.
  const bestVisual = new Map();
  for (const entry of entries) {
    if (entry.matches('[class*="gap" i]')) continue;
    for (const card of componentNodes(entry, 'card')) {
      const key = cardKey(card);
      const visual = cardVisual(card);
      const current = bestVisual.get(key);
      if (!current || (!/data-printer-asset=/.test(current) && /data-printer-asset=/.test(visual)) || (!current && visual)) bestVisual.set(key, visual);
    }
  }
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
      const key = cardKey(card);
      if (seenCards.has(key)) return '';
      seenCards.add(key);
      const category = textFrom(card, '[class*="category"]') || dayCategory;
      const reasoning = textFrom(card, '[class*="reasoning__text"], [class*="reasoning-text"]');
      return `<article class="timeline-event">${bestVisual.get(key) || ''}<header><span class="timeline-category">${htmlText(category)}</span><time datetime="${htmlText(timestamp)}">${htmlText(timestamp)}</time><span class="timeline-step">${htmlText(step)}</span></header><h3 class="timeline-event-title">${htmlText(title)}</h3><p class="timeline-description">${htmlText(description)}</p>${reasoning ? `<blockquote class="timeline-reasoning">${htmlText(reasoning)}</blockquote>` : ''}</article>`;
    }).join('');
    sections.push(`<section class="timeline-day"><h2>${htmlText(date)}</h2>${events}</section>`);
  }
  const timeline = contentRoot.ownerDocument.importNode(JSDOM.fragment(`<figure class="reconstructed-timeline"><figcaption>Incident timeline</figcaption>${sections.join('')}</figure>`).firstChild, true);
  const existing = contentRoot.querySelector('[class*="EventTimeline"]');
  if (existing) {
    // Replace the component root itself. Ancestors can be the article's entire
    // content section, so walking to a generic section/div truncates siblings.
    existing.replaceWith(timeline);
  } else {
    const heading = [...contentRoot.querySelectorAll('h2,h3,section,div')].find((element) => /^incident timeline$/i.test(element.textContent.trim()));
    if (heading) heading.replaceWith(timeline);
    else contentRoot.appendChild(timeline);
  }
  // Card visuals were copied from the raw page, so they still need the same
  // URL normalization and local asset mapping as the rest of the article.
  if (sourceUrl) { sanitize(timeline, sourceUrl); localizeImages(timeline); }
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
  mergeVisuals(contentRoot, document, sourceUrl);
  removeChrome(contentRoot);
  sanitize(contentRoot, sourceUrl);
  localizeImages(contentRoot);
  removeDecorativeVisuals(contentRoot);
  replaceEmbeds(contentRoot, sourceUrl);
  removeEmptyVisuals(contentRoot);
  reconstructTimeline(document, contentRoot, sourceUrl);
  const xInfo = xSourceInfo(document, sourceUrl);
  cleanXArticle(contentRoot, xInfo);
  normalizeTextBoundaries(contentRoot);
  stripPrinterAttributes(contentRoot);
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
