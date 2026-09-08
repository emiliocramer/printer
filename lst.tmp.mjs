import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const p = await b.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
for (const u of process.argv.slice(2)) {
  console.log('==', u);
  try {
    await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }); await p.waitForTimeout(2500);
    const items = await p.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => [a.href, a.textContent.replace(/\s+/g,' ').trim()]).filter(([h,t]) => t.length > 25 && t.length < 160 && /2026|\/posts\/|\/blog\/|\/doi\/|\/content\/|\/articles\/|\/research\//.test(h)));
    const seen = new Set(); for (const [h,t] of items) { if (seen.has(h)) continue; seen.add(h); console.log('  ', h.slice(0,110), '|', t.slice(0,80)); if (seen.size >= 15) break; }
  } catch (e) { console.log('  ERR', e.message.slice(0,80)); }
}
await b.close();
