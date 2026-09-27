'use strict';
// Fixture assertions (node --test test/fixtures.test.js): replay the cached crawls of broadandjames.com and
// columbusroadsidetowing.com (industry "towing") and check the engine finds exactly what those sites really have.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const headless = require('../headless-audit');

async function crawl(domain, root, override) {
  const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', domain + '.json.gz'))).toString('utf8'));
  const get = k => { if (k in fx.calls) return fx.calls[k]; throw Object.assign(new Error('not in fixture: ' + k), { code: 502 }); };
  const deps = { renderEnabled: false, placesEnabled: false, proxyFetch: async t => get('proxy:' + t), linkCheck: async t => get('check:' + t),
    directFetch: async u => get('direct:' + String(u).replace(/([?&])key=[^&]*/, '$1key=_')), renderFetch: async () => null, placesLookup: async () => null };
  Object.assign(deps, (override && override(deps, get)) || {});
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

// Single-page mode (the public tool's Run Audit, API mode "page", the CRM's audits) runs every page-level check.
test('Single-page audit: all Phase 2–8 page checks, banner first, AI never above 95%', async () => {
  const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'columbusroadsidetowing.com.json.gz'))).toString('utf8'));
  const get = k => { if (k in fx.calls) return fx.calls[k]; throw Object.assign(new Error('miss'), { code: 502 }); };
  const deps = { proxyFetch: async t => get('proxy:' + t), linkCheck: async t => get('check:' + t), directFetch: async u => get('direct:' + String(u).replace(/([?&])key=[^&]*/, '$1key=_')),
    renderFetch: async () => null, placesLookup: async () => null };
  const out = await headless.auditPage(deps, 'https://www.columbusroadsidetowing.com/', { speed: false, industry: 'towing' });
  const labels = out.result.checks.map(c => c.label);
  ['Title quality', 'Specific H1', 'Years-in-business claims current', 'No placeholder text', 'Schema NAP matches the page', 'One business entity with a stable @id',
    'FAQ schema matches the visible FAQ', // Breadcrumb (non-home) and Service schema (service pages) are page-type checks 'License / registration numbers shown', 'Pricing transparency', 'Insurance mentioned',
    'Question headings with direct answers', 'Citable facts', 'Click-to-call at the top (mobile)', 'Image efficiency', 'Viewport allows zoom', 'Soft 404', 'Heading hierarchy',
    'JSON-LD syntax valid', 'Valid schema.org types', 'Reasonable page weight'].forEach(l => assert.ok(labels.includes(l), 'missing in single-page mode: ' + l));
  assert.ok(out.result.checks.length >= 55, out.result.checks.length + ' checks');
  assert.match(out.result.checks.find(c => c.label === 'Reasonable page weight').detail, /^Total /, 'asset sizes measured in single-page mode');
  const text = out.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.ok(text.startsWith('Homepage snapshot — full-site audit available'), 'banner is the first thing: ' + text.slice(0, 60));
  (text.match(/AI Search[^%]{0,40}%/g) || []).forEach(m => assert.ok(+(m.match(/(\d+)%$/) || [0, 0])[1] <= 95, m));
});

test('Engine version: results carry it and every report footer prints it', async () => {
  const v = require('../engine-version').engineVersion();
  assert.match(v, /^[\w]+-[0-9a-f]{8}$/);
  assert.strictEqual(rs.engineVersion, v);
  assert.ok(rs.pages.filter(p => !p.error).every(p => p.engineVersion === v));
  const w = require('jsdom'); const { JSDOM } = w;
  const win = new JSDOM('', { runScripts: 'outside-only' }).window; win.eval(require('../engine-version').engineSource());
  assert.strictEqual(win.SEO.ENGINE_VERSION, v);
  assert.match(win.SEO.siteReportHTML(rs), new RegExp('Audit engine v' + v));
  assert.match(win.SEO.reportHTML(rs.pages.find(p => !p.error)), new RegExp('Audit engine v' + v));
  assert.match(win.SEO.siteReportHTML(Object.assign({}, rs, { engineVersion: 'old-12345678' })), /Audit engine vold-12345678/, 'a saved report shows the engine that produced it');
});

// ---------------- Live-report fixes on the real crawls ----------------
test('GBP lookup on Roadside searches its business name + phone (not "Towing Columbus OH")', async () => {
  const calls = [];
  const res = await crawl('columbusroadsidetowing.com', 'https://www.columbusroadsidetowing.com', () => ({ placesEnabled: true,
    placesLookup: async (q, o) => { calls.push({ q, o }); return { found: true, name: 'Roadside Towing & Recovery Inc', phone: '(740) 812-9489', address: '1620 Harrisburg Pike, Columbus, OH 43223', matchedBy: 'phone' }; } }));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].q, 'Roadside Towing & Recovery Inc');
  assert.strictEqual(calls[0].o.phone, '(740) 812-9489');
  assert.ok(!/towing columbus/i.test(calls[0].q));
  assert.strictEqual(res.local.found, true); assert.strictEqual(res.local.matchedBy, 'phone');
});

test('Severity bands on real pages: sibling overlap and unique content', () => {
  [bj, rs].forEach(res => res.pages.filter(p => !p.error).forEach(p => {
    const sib = chk(p, 'Unique vs sibling pages');
    if (sib && sib.points) { const pct = +(sib.detail.match(/^(\d+)%/) || [])[1];
      const want = pct < 40 ? undefined : pct < 60 ? 'Medium' : pct < 80 ? 'High' : 'Critical';
      assert.strictEqual(sib.severity, want, p.url + ' overlap ' + pct + '%'); }
    const uc = chk(p, 'Unique content');
    if (uc && uc.points && uc.status !== 'pass') { const w = +(uc.detail.match(/^(\d+) words/) || [])[1];
      const want = w < 150 ? 'Critical' : w < 300 ? 'High' : w < 500 ? 'Medium' : 'Low';
      assert.strictEqual(uc.severity, want, p.url + ' ' + w + ' words'); }
  }));
});

test('Every warned/failed check has a problem-state title (not its check name)', () => {
  const bad = [];
  [bj, rs].forEach(res => {
    res.pages.filter(p => !p.error).forEach(p => p.checks.filter(c => c.status === 'fail' || c.status === 'warn').forEach(c => {
      if (!c.issue || c.issue === c.label || c.issue.startsWith(c.label + ':') || /undefined|null/.test(c.issue)) bad.push(c.label + ' → ' + c.issue); }));
    const w = require('jsdom'); const win = new w.JSDOM('', { runScripts: 'outside-only' }).window; win.eval(require('../engine-version').engineSource());
    res.siteFindings.filter(f => f.status === 'fail' || f.status === 'warn').forEach(f => { const t = win.SEO.problemTitle(f); if (!t || t === f.label || /undefined|null/.test(t)) bad.push('site: ' + f.label + ' → ' + t); });
  });
  assert.deepStrictEqual([...new Set(bad)], []);
  const js = bj.pages.map(p => chk(p, 'Reasonable page weight')).find(c => c && c.status === 'warn');
  assert.match(js.issue, /^JavaScript too heavy: [\d.]+ (KB|MB)$/);
});

test('Failed-to-load pages are listed with their status and error', async () => {
  const dead = 'https://broadandjames.com/gallery/';
  const res = await crawl('broadandjames.com', 'https://broadandjames.com', (deps, get) => ({ proxyFetch: async t => { if (t === dead) throw Object.assign(new Error('timeout'), { code: 504 }); return get('proxy:' + t); } }));
  const f = res.pages.find(p => p.url === dead);
  assert.ok(f && f.error, 'gallery should fail'); assert.strictEqual(f.status, 200, 'status from the URL check');
  const w = require('jsdom'); const win = new w.JSDOM('', { runScripts: 'outside-only' }).window; win.eval(require('../engine-version').engineSource());
  const html = win.SEO.failedPagesHTML(res); assert.match(html, /Pages that failed to load \(1\)/); assert.match(html, /gallery/);
});

test('One classifier: the sitemap columns and the crawl count the same service / location pages', () => {
  const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'columbusroadsidetowing.com.json.gz'))).toString('utf8'));
  const xml = fx.calls['proxy:https://www.columbusroadsidetowing.com/sitemap.xml'].body;
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
  const w = require('jsdom'); const win = new w.JSDOM('', { runScripts: 'outside-only' }).window; win.eval(require('../engine-version').engineSource());
  const types = Object.values(win.SEO.pageTypesFor(urls));
  const cov = rs.siteBreakdown.coverage;
  assert.strictEqual(types.filter(t => t === 'service').length, cov.service);
  assert.strictEqual(types.filter(t => t === 'location').length, cov.location);
});
