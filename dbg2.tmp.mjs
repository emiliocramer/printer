import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { readFileSync } from 'node:fs';
const html = readFileSync('/var/folders/kr/7zfr5sf53g10rq1lsrlbx9gh0000gn/T/opencode/anth.html','utf8');
const url='https://www.anthropic.com/research/formalizing-fermats-last-theorem';
const raw = new JSDOM(html,{url}).window.document;
console.log('raw post-text paras:', raw.querySelectorAll('p.post-text').length, 'in article:', raw.querySelectorAll('main article p.post-text').length);
const a = new Readability(raw.cloneNode(true)).parse();
console.log('plain readability words:', a.textContent.split(/\s+/).length, a.textContent.slice(0,120));
// check what our prune does
const mod = await import('./src/extract.js');
const src = readFileSync('./src/extract.js','utf8');
// emulate: find classes matching CHROME_TOKENS on ancestors of post-text
const CHROME_TOKENS = /(?:^|[-_\s])(subscribe|subscription|paywall|comment|comments|discussion|share|sharing|social|reaction|related|recommendation|recommendations|footer|legal|avatar|masthead|publication-header|main-menu|portable-archive|post-ufi|like-button|ready-for-more|channel-frame|session-attribution|visitedsurfacesiframe|post-label)(?:$|[-_\s])/i;
const CHROME_FRAGMENTS = /InContentBarrier|SkipLink|skip-link|skiplink|ChannelCloud|paywall|regwall|piano-|breadcrumb|TagCloud|tag-cloud|taglist|tag-list|ArticleTags|ArticleBio|author-bio|AuthorBio|Recirc|recirculation|MostPopular|most-popular|Leaflet|RelatedContent|related-content|ExploreMore|explore-more/i;
let el = raw.querySelector('p.post-text');
while (el) { const id=`${el.id||''} ${el.className||''} ${el.getAttribute('role')||''}`; if (CHROME_TOKENS.test(id)||CHROME_FRAGMENTS.test(id)) console.log('CHROME MATCH on ancestor:', el.localName, id.slice(0,150)); el = el.parentElement; }
for (const h of raw.querySelectorAll('h2,h3,h4')) { const t=h.textContent.trim(); if (/^(subscribe|join|discussion|comments?|related posts?|recommended|recommendations|more from|you may also like|ready for more|explore more|most popular|most read|trending|up next|read next|further reading|about the author)\b/i.test(t)) { const c=h.closest('section, aside, div'); console.log('HEADING', JSON.stringify(t), '-> removes', c.localName, c.className.slice(0,80), 'contains post-text?', !!c.querySelector('p.post-text')); } }
