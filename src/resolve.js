/**
 * Share links (Apple News, Google News, link shorteners) point at an
 * interstitial that forwards to the publisher. Printing the interstitial is
 * never what anyone wants, so follow the forward before capture begins.
 */

const SHARE_HOSTS = /(?:^|\.)(apple\.news|news\.google\.com|t\.co|lnkd\.in|flip\.it|bit\.ly|buff\.ly|ow\.ly|tinyurl\.com|goo\.gl|trib\.al|dlvr\.it|ift\.tt|feedproxy\.google\.com|l\.facebook\.com|lm\.facebook\.com|out\.reddit\.com|link\.medium\.com|substack\.com\/redirect)$/i;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function decodeEntities(value) {
  return String(value ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function httpUrl(value, base) {
  try {
    const url = new URL(decodeEntities(value).trim(), base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/** Pull a forwarding target out of interstitial HTML. Exported for tests. */
export function forwardingTarget(html, base) {
  const source = String(html ?? '');
  const patterns = [
    /redirectToUrl(?:AfterTimeout)?\(\s*["']([^"']+)["']/i,
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*?url=([^"'>\s]+)/i,
    /<meta[^>]+content=["'][^"']*?url=([^"'>\s]+)[^>]+http-equiv=["']?refresh["']?/i,
    /(?:window\.|document\.|top\.)?location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i,
    /location\.(?:replace|assign)\(\s*["'](https?:\/\/[^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    const target = match && httpUrl(match[1], base);
    if (target && new URL(target).href !== new URL(base).href) return target;
  }
  const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(source) || /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i.exec(source);
  const canonicalUrl = canonical && httpUrl(canonical[1], base);
  if (canonicalUrl && new URL(canonicalUrl).hostname !== new URL(base).hostname) return canonicalUrl;
  return null;
}

export function isShareLink(url) {
  try { const parsed = new URL(url); return SHARE_HOSTS.test(parsed.hostname) || SHARE_HOSTS.test(`${parsed.hostname}${parsed.pathname}`); } catch { return false; }
}

async function fetchInterstitial(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal, headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': BROWSER_UA } });
    const finalUrl = response.url || url;
    const type = response.headers?.get?.('content-type') || '';
    const html = /html|xml/i.test(type) || !type ? await response.text() : '';
    return { finalUrl, html: html.slice(0, 200000) };
  } finally { clearTimeout(timer); }
}

/**
 * Resolve a share link to the publisher URL. Returns the input unchanged when
 * it is already a publisher page or the forward cannot be determined.
 */
export async function resolveArticleUrl(input, { fetchImpl = globalThis.fetch, maxHops = 4, timeoutMs = 10000, always = false } = {}) {
  let current = String(input);
  const hops = [current];
  if (!always && !isShareLink(current)) return { url: current, hops: [] };
  for (let hop = 0; hop < maxHops; hop += 1) {
    let page;
    try { page = await fetchInterstitial(current, fetchImpl, timeoutMs); } catch { break; }
    const landed = page.finalUrl || current;
    const forwarded = forwardingTarget(page.html, landed);
    const next = forwarded || (landed !== current ? landed : null);
    if (!next || hops.includes(next)) break;
    hops.push(next);
    current = next;
    // Once we are on a publisher page the browser capture takes over.
    if (!isShareLink(current)) break;
  }
  return { url: current, hops: hops.length > 1 ? hops : [] };
}
