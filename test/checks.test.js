'use strict';
// One true positive and one true negative per extended check (node --test test/checks.test.js).
const test = require('node:test');
const assert = require('node:assert');
const { engine, page, words, same, doc } = require('./helpers');

// ---------------- Phase 2 — technical ----------------
test('Soft 404: "page not found" or <50 words fails; a real service page passes; home is exempt', () => {
  const { _x } = engine();
  assert.strictEqual(_x.soft404Check('service', 'Page Not Found | Co', '', 400).status, 'fail');
  assert.strictEqual(_x.soft404Check('other', 'Gallery', 'Gallery', 20).status, 'fail');
  assert.strictEqual(_x.soft404Check('service', 'Flatbed Towing | Co', 'Flatbed Towing', 600).status, 'pass');
  assert.strictEqual(_x.soft404Check('home', 'Home', '', 10).status, 'info');
});

test('Viewport zoom: user-scalable=no / maximum-scale<2 warn; plain viewport passes', () => {
  const { _x } = engine();
  const c = _x.viewportZoomCheck(doc('<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">'));
  assert.strictEqual(c.status, 'warn'); assert.match(c.evidence[0].snippet, /user-scalable=no/);
  assert.strictEqual(_x.viewportZoomCheck(doc('<meta name="viewport" content="width=device-width, initial-scale=1">')).status, 'pass');
});

test('Heading hierarchy: H2 -> H4 warns; H1 -> H2 -> H3 passes', () => {
  const { _x } = engine();
  const c = _x.headingHierarchyCheck(doc('<h1>A</h1><h2>B</h2><h4>C</h4>'));
  assert.strictEqual(c.status, 'warn'); assert.match(c.evidence[0].snippet, /<h2>B<\/h2> → <h4>C<\/h4>/);
  assert.strictEqual(_x.headingHierarchyCheck(doc('<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2>')).status, 'pass');
});

test('Page weight: JS over 500 KB warns; light page passes', () => {
  const { _x } = engine();
  const a = { scripts: ['https://t/a.js'], css: [], images: [], inlineJs: 1000 };
  assert.strictEqual(_x.weightCheck(50000, a, { js: 600000, css: 0, img: 0, top: [{ url: 'https://t/a.js', bytes: 600000 }] }).status, 'warn');
  assert.strictEqual(_x.weightCheck(50000, a, { js: 100000, css: 20000, img: 300000, top: [] }).status, 'pass');
});

test('Image efficiency: >150 KB or JPG/PNG warns (with evidence); small WebP passes', () => {
  const { _x } = engine();
  const heavy = _x.imageCheck({ images: [{ url: 'https://t/big.jpg', idx: 0, lazy: false }] }, { 'https://t/big.jpg': 400 * 1024 });
  assert.strictEqual(heavy.status, 'warn'); assert.match(heavy.evidence[0].snippet, /big\.jpg — 400 KB/);
  const good = _x.imageCheck({ images: [{ url: 'https://t/a.webp', idx: 0, lazy: false }] }, { 'https://t/a.webp': 40 * 1024, 'ct:https://t/a.webp': 'image/webp' });
  assert.strictEqual(good.status, 'pass');
});

test('robots.txt matching: Disallow /wp-content/ blocks CSS; longest Allow wins', () => {
  const { _x } = engine();
  const r = _x.robotsRulesFor('User-agent: *\nDisallow: /wp-content/\nAllow: /wp-content/uploads/', 'Googlebot');
  assert.strictEqual(_x.robotsAllowed(r, '/wp-content/themes/x/style.css').allowed, false);
  assert.strictEqual(_x.robotsAllowed(r, '/wp-content/uploads/a.jpg').allowed, true);
  assert.strictEqual(_x.robotsAllowed(_x.robotsRulesFor('User-agent: *\nDisallow: /*.js$', 'Googlebot'), '/app.js').allowed, false);
});

test('HTTPS + www: a 2-hop chain fails with the chain as evidence; single 301s pass', async () => {
  const base = 'https://www.t.example';
  const ctx = routes => ({ ok: [], home: { url: base + '/', _assets: { scripts: [], css: [] } }, money: [], disc: { base, sitemapUrls: [], lastmod: {} },
    graph: { chains: [] }, keyOf: u => u, robots: null, speedRuns: [] });
  const bad = engine({ 'http://t.example/': { status: 301, location: 'https://t.example/' }, 'https://t.example/': { status: 301, location: 'https://www.t.example/' },
    'http://www.t.example/': { status: 301, location: 'https://www.t.example/' }, 'https://www.t.example/': { status: 200, body: '<p>x</p>' } });
  const f = (await bad._x.technicalFindings(ctx())).find(x => x.label === 'HTTPS + www redirects');
  assert.strictEqual(f.status, 'fail'); assert.match(f.evidence.map(e => e.snippet).join(' '), /http:\/\/t\.example\/ → 301 → https:\/\/t\.example\/ → 301 → https:\/\/www\.t\.example\//);
  const good = engine({ 'http://t.example/': { status: 301, location: 'https://www.t.example/' }, 'https://t.example/': { status: 301, location: 'https://www.t.example/' },
    'http://www.t.example/': { status: 301, location: 'https://www.t.example/' }, 'https://www.t.example/': { status: 200, body: '<p>x</p>' } });
  assert.strictEqual((await good._x.technicalFindings(ctx())).find(x => x.label === 'HTTPS + www redirects').status, 'pass');
});

test('Sitemap quality: a redirecting sitemap URL fails; identical lastmods warn; clean sitemap passes', async () => {
  const base = 'https://t.example';
  const mk = (urls, lastmod) => ({ ok: [], home: null, money: [], disc: { base, sitemapUrls: urls, lastmod }, graph: { chains: [] }, keyOf: u => u, robots: null, speedRuns: [] });
  const SEO = engine({ 'https://t.example/a': { status: 200, body: '<p>a</p>' }, 'https://t.example/old': { status: 301, location: 'https://t.example/a' },
    'https://t.example/b': { status: 200 }, 'https://t.example/c': { status: 200 }, 'https://t.example/d': { status: 200 }, 'https://t.example/e': { status: 200 } });
  const f1 = await SEO._x.technicalFindings(mk(['https://t.example/a', 'https://t.example/old'], { 'https://t.example/a': '2026-01-01', 'https://t.example/old': '2026-02-01' }));
  assert.strictEqual(f1.find(x => x.label === 'Sitemap lists only live, indexable URLs').status, 'fail');
  const five = ['a', 'b', 'c', 'd', 'e'].map(x => base + '/' + x), lm = {}; five.forEach(u => { lm[u] = '2026-09-20'; });
  const f2 = await SEO._x.technicalFindings(mk(five, lm));
  assert.strictEqual(f2.find(x => x.label === 'Sitemap lastmod dates').status, 'warn');
  assert.strictEqual(f2.find(x => x.label === 'Sitemap lists only live, indexable URLs').status, 'pass');
});

test('Site findings deduct from their component: fail = full points, warn = half', () => {
  const { _x } = engine();
  const comps = { technical: { score: 90 }, linkHealth: { score: 100 } };
  _x.applyDeductions(comps, [{ component: 'technical', status: 'fail', points: 6, label: 'a' }, { component: 'technical', status: 'warn', points: 4, label: 'b' }, { component: 'linkHealth', status: 'pass', points: 5, label: 'c' }]);
  assert.strictEqual(comps.technical.score, 82); assert.strictEqual(comps.linkHealth.score, 100);
});
