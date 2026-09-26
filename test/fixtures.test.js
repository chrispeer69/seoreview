'use strict';
// Fixture assertions (node --test test/fixtures.test.js): replay the cached crawls of broadandjames.com and
// columbusroadsidetowing.com (industry "towing") and check the engine finds exactly what those sites really have.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const headless = require('../headless-audit');

async function crawl(domain, root) {
  const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', domain + '.json.gz'))).toString('utf8'));
  const get = k => { if (k in fx.calls) return fx.calls[k]; throw Object.assign(new Error('not in fixture: ' + k), { code: 502 }); };
  const deps = { renderEnabled: false, placesEnabled: false, proxyFetch: async t => get('proxy:' + t), linkCheck: async t => get('check:' + t),
    directFetch: async u => get('direct:' + String(u).replace(/([?&])key=[^&]*/, '$1key=_')), renderFetch: async () => null, placesLookup: async () => null };
  const out = await headless.crawlSite(deps, root, { maxPages: 150, concurrency: 4, psiKey: 'x', now: fx.recorded, industry: 'towing' });
  return out.result;
}
const pageAt = (res, p) => res.pages.find(x => !x.error && x.url.replace(res.root, '') === p);
const chk = (page, label) => page.checks.find(c => c.label === label);
const siteF = (res, label) => res.siteFindings.find(f => f.label === label);

let bj, rs;
test('replay broadandjames.com', async () => { bj = await crawl('broadandjames.com', 'https://broadandjames.com'); assert.ok(bj.pages.length > 10); });
test('replay columbusroadsidetowing.com', async () => { rs = await crawl('columbusroadsidetowing.com', 'https://www.columbusroadsidetowing.com'); assert.ok(rs.pages.length > 50); });

test('B&J: all blog posts dated 2018-01-10', () => {
  const f = siteF(bj, 'Blog posts have their own dates');
  assert.strictEqual(f.status, 'fail'); assert.match(f.detail, /2018-01-10/);
});
test('B&J: "51 Years" vs "since 1973" is a stale claim', () => {
  const c = chk(pageAt(bj, '/'), 'Years-in-business claims current');
  assert.strictEqual(c.status, 'fail'); assert.match(c.detail, /51 years/i); assert.match(c.detail, /1973/);
});
test('B&J: default WordPress privacy policy', () => {
  assert.strictEqual(chk(pageAt(bj, '/privacy-policy/'), 'Real privacy policy (not the WordPress default)').status, 'fail');
});
test('B&J: generic H1s GALLERY, INQUIRE, PAY NOW', () => {
  const h1s = bj.pages.filter(p => !p.error).map(p => chk(p, 'Specific H1')).filter(c => c && c.status === 'fail').map(c => c.detail).join(' | ');
  ['GALLERY', 'INQUIRE', 'PAY NOW'].forEach(h => assert.match(h1s, new RegExp('"' + h + '"')));
});
test('B&J: service coverage near 0 vs the towing taxonomy', () => {
  const m = siteF(bj, 'Service coverage vs Towing & roadside services').matrix;
  assert.ok(m.score <= 10, 'coverage ' + m.score + '%');
});
test('B&J: Beaver Builder + GeneratePress + Gravity Forms + WonderPlugin Carousel; Towbook + PayPal + CardPointe', () => {
  const s = bj.stack;
  assert.ok(s.builders.includes('Beaver Builder')); assert.ok(s.theme.includes('generatepress'));
  assert.ok(s.plugins.some(p => p.name === 'Gravity Forms')); assert.ok(s.plugins.some(p => p.name === 'WonderPlugin Carousel'));
  ['Towbook'].forEach(t => assert.ok(s.opsTools.includes(t))); ['PayPal', 'CardPointe'].forEach(t => assert.ok(s.payments.includes(t)));
});
test('B&J: JPG images over 150 KB flagged', () => {
  const heavy = bj.pages.filter(p => !p.error).map(p => chk(p, 'Image efficiency')).filter(c => c && c.status === 'warn' && (c.evidence || []).some(e => /\.jpe?g/i.test(e.snippet) && /— (\d+) KB|MB/.test(e.snippet) && (/MB/.test(e.snippet) || +(e.snippet.match(/— (\d+) KB/) || [])[1] > 150)));
  assert.ok(heavy.length >= 1);
});
test('Roadside: PUCO #650256 and USDOT #03560921 detected', () => {
  const l = rs.stack.licenses.join(' ');
  assert.match(l, /PUCO[^,]*650256/); assert.match(l, /USDOT #?03560921/);
});
test('Roadside: 24/7 claims listed with URLs', () => {
  const f = siteF(rs, 'Consistent hours claims');
  assert.ok(f.claims24_7.length > 10); assert.ok(f.claims24_7.every(u => /^https:\/\/www\.columbusroadsidetowing\.com/.test(u)));
});
test('Every failing/warning site finding carries evidence', () => {
  [bj, rs].forEach(res => res.siteFindings.filter(f => (f.status === 'fail' || f.status === 'warn') && f.points).forEach(f => assert.ok((f.evidence || []).length, 'no evidence: ' + f.label)));
});
