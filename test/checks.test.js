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

// ---------------- Phase 3 — on-page ----------------
test('Title quality: stacked/trailing separators or missing place fail; clean money-page title passes', () => {
  const { _x } = engine();
  const bad = _x.titleQualityCheck('Gallery | Broad & James | Towing | Roadside Assistance | Columbus |', 'https://t/gallery/', 'other');
  assert.strictEqual(bad.status, 'fail'); assert.match(bad.detail, /separators/); assert.match(bad.evidence[0].snippet, /<title>/);
  assert.strictEqual(_x.titleQualityCheck('Roadside Assistance | Co', 'https://t/service-area/dublin', 'location').status, 'fail');
  assert.strictEqual(_x.titleQualityCheck('Towing Dublin OH | Roadside Towing', 'https://t/service-area/dublin', 'location').status, 'pass');
  assert.ok(_x.titlePixels('W'.repeat(40)) > 580);
});

test('Specific H1: "GALLERY" / "PAY NOW" fail; a descriptive H1 passes', () => {
  const { _x } = engine();
  assert.strictEqual(_x.genericH1Check('GALLERY').status, 'fail');
  assert.strictEqual(_x.genericH1Check(' Pay Now ').status, 'fail');
  assert.strictEqual(_x.genericH1Check('24/7 Towing in Dublin, OH').status, 'pass');
});

test('Meta description equal to title warns; distinct passes', () => {
  const { _x } = engine();
  assert.strictEqual(_x.descEqualsTitleCheck('Towing | Co', 'towing | co').status, 'warn');
  assert.strictEqual(_x.descEqualsTitleCheck('Towing | Co', '24/7 towing in Columbus. Call now.').status, 'pass');
});

test('Generic anchors: "Read more" to a service page warns; descriptive anchor passes', () => {
  const { _x } = engine();
  assert.strictEqual(_x.genericAnchorCheck([{ url: 'https://t/services/flatbed-towing', text: 'Read more', href: '/services/flatbed-towing' }]).status, 'warn');
  assert.strictEqual(_x.genericAnchorCheck([{ url: 'https://t/services/flatbed-towing', text: 'Flatbed towing', href: '/services/flatbed-towing' }]).status, 'pass');
  assert.strictEqual(_x.genericAnchorCheck([{ url: 'https://t/blog/post', text: 'Read more', href: '/blog/post' }]).status, 'pass', 'blog links are not money pages');
});

test('Link health: weakly linked money pages deduct 1 each; internal nofollow warns', () => {
  const { _x } = engine();
  const pages = [{ url: 'https://t/services/a', pageType: 'service', inlinks: 1, clickDepth: 2, _anchors: [{ href: '/x', text: 'x', nofollow: true }] },
    { url: 'https://t/services/b', pageType: 'service', inlinks: 9, clickDepth: 5, _anchors: [] }, { url: 'https://t/services/c', pageType: 'service', inlinks: 9, clickDepth: 1, _anchors: [] }];
  const f = _x.onPageLinkFindings(pages);
  const weak = f.find(x => x.label === 'Money pages well linked');
  assert.strictEqual(weak.status, 'fail'); assert.strictEqual(weak.points, 2); assert.strictEqual(weak.evidence.length, 2);
  assert.strictEqual(f.find(x => x.label === 'No internal nofollow links').status, 'warn');
  const clean = _x.onPageLinkFindings([pages[2]]);
  assert.strictEqual(clean.find(x => x.label === 'Money pages well linked').status, 'pass');
  assert.strictEqual(clean.find(x => x.label === 'No internal nofollow links').status, 'pass');
});

// ---------------- Phase 4 — content ----------------
test('Stale years claim: "51 years" + "since 1973" fails in 2026; a matching claim passes; no claims = info', () => {
  const { _x } = engine();
  const bad = _x.yearClaims('Family owned and operated since 1973. 51 Years of Experience serving Columbus.');
  bad.founded.forEach(f => { f.url = 'https://t/'; });
  const c = _x.staleClaimsCheck(bad, null);
  assert.ok(c.status === 'fail' || new Date().getUTCFullYear() - 1973 - 51 <= 1, c.detail);
  const goodYears = new Date().getUTCFullYear() - 1973;
  const good = _x.yearClaims('Since 1973 — ' + goodYears + ' years in business.'); good.founded.forEach(f => { f.url = 'https://t/'; });
  assert.strictEqual(_x.staleClaimsCheck(good, null).status, 'pass');
  assert.strictEqual(_x.staleClaimsCheck(_x.yearClaims('We tow cars.'), null).status, 'info');
});

test('Placeholder text: "Lorem ipsum" fails; real copy passes', () => {
  const { _x } = engine();
  assert.strictEqual(_x.placeholderCheck('Lorem ipsum dolor sit amet, consectetur.').status, 'fail');
  assert.strictEqual(_x.placeholderCheck('We tow cars across Columbus every day.').status, 'pass');
});

test('Default WordPress privacy policy fails on the privacy page only', () => {
  const { _x } = engine();
  assert.strictEqual(_x.defaultPrivacyCheck('https://t/privacy-policy/', 'Suggested text: Our website address is: https://t.').status, 'fail');
  assert.strictEqual(_x.defaultPrivacyCheck('https://t/privacy-policy/', 'We collect your name and phone when you request a tow.').status, 'pass');
  assert.strictEqual(_x.defaultPrivacyCheck('https://t/about/', 'Suggested text:'), null);
});

test('Blog dates: all posts on one day fail; spread dates pass. Copyright year behind warns', () => {
  const { _x } = engine();
  const mk = (d, i) => ({ url: 'https://t/b' + i, pageType: 'blog', datePublished: d });
  const one = _x.contentFreshnessFindings([0, 1, 2].map(i => mk('2018-01-10T00:00:00Z', i)).concat([{ url: 'https://t/', pageType: 'home', _html: '<footer>© 2019 Co</footer>' }]));
  assert.strictEqual(one.find(f => f.label === 'Blog posts have their own dates').status, 'fail');
  assert.strictEqual(one.find(f => f.label === 'Copyright year current').status, 'warn');
  const spread = _x.contentFreshnessFindings(['2025-01-01', '2025-03-01', '2025-06-01'].map(mk).concat([{ url: 'https://t/', pageType: 'home', _html: '<footer>© ' + new Date().getUTCFullYear() + ' Co</footer>' }]));
  assert.strictEqual(spread.find(f => f.label === 'Blog posts have their own dates').status, 'pass');
  assert.strictEqual(spread.find(f => f.label === 'Copyright year current').status, 'pass');
});

test('Contradictions: 20–40 vs 30–60 min for the same area fails; metro vs outer and job durations pass; office hours next to 24/7 pass', () => {
  const { _x } = engine();
  const pg = (u, t, type) => ({ url: u, pageType: type || 'service', _blocks: [t] });
  const clash = _x.contradictionFindings([pg('https://t/a', 'Most calls are reached in 20–40 minutes.'), pg('https://t/b', 'We arrive in 30–60 minutes.')]);
  const eta = clash.find(f => f.label === 'Consistent arrival-time claims');
  assert.strictEqual(eta.status, 'fail'); assert.strictEqual(eta.evidence.length, 2);
  const fine = _x.contradictionFindings([pg('https://t/a', 'Most metro calls are reached in 20–40 minutes and outer communities in 40–60 minutes. A lockout takes 5–15 minutes.'),
    pg('https://t/c', 'Dispatch runs 24/7; the office is open Monday to Friday, 8 AM to 6 PM.')]);
  assert.strictEqual(fine.find(f => f.label === 'Consistent arrival-time claims').status, 'pass');
  assert.strictEqual(fine.find(f => f.label === 'Consistent hours claims').status, 'pass');
  const hrs = _x.contradictionFindings([pg('https://t/a', 'Open 24/7 for towing.'), pg('https://t/b', 'Hours: Monday - Friday 9 AM - 5 PM')]);
  assert.strictEqual(hrs.find(f => f.label === 'Consistent hours claims').status, 'fail');
});

// ---------------- Phase 5 — local SEO ----------------
test('Service coverage vs towing taxonomy: dedicated page = covered, mention = partial, else missing', async () => {
  const SEO = engine(); await SEO._x.loadIndustry('towing');
  const pages = [{ url: 'https://t/services/flatbed-towing', pageType: 'service', title: 'Flatbed Towing | Co', h1text: 'Flatbed Towing', _pageText: 'Flatbed towing' },
    { url: 'https://t/', pageType: 'home', title: 'Co', h1text: 'Co', _pageText: 'We also do lockout help.' }];
  const cfg = require('../config/industries/towing.json');
  const m = SEO._x.serviceCoverage(pages, cfg);
  assert.strictEqual(m.rows.find(r => r.service === 'Flatbed towing').status, 'covered');
  assert.strictEqual(m.rows.find(r => r.service === 'Lockout service').status, 'partial');
  assert.strictEqual(m.rows.find(r => r.service === 'Junk car removal').status, 'missing');
  assert.strictEqual(m.score, Math.round(100 / cfg.services.length));
  assert.strictEqual(SEO._x.serviceCoverage(pages, null), null, 'general industry = no taxonomy check');
});

test('Location coverage only runs with a market city list', () => {
  const { _x } = engine();
  assert.strictEqual(_x.locationCoverage([], null), null);
  const m = _x.locationCoverage([{ url: 'https://t/service-area/dublin', pageType: 'location', title: 'Towing Dublin', h1text: '' }], { cities: ['Dublin', 'Hilliard'] });
  assert.strictEqual(m.covered, 1); assert.strictEqual(m.rows[1].status, 'missing');
});

test('Click-to-call at the top: tel in header passes; tel only far down the page fails', () => {
  const { _x } = engine();
  assert.strictEqual(_x.callAboveFoldCheck(doc('<body><header><a href="tel:+16145550100">Call</a></header><p>' + words(900) + '</p></body>'), 'service').status, 'pass');
  assert.strictEqual(_x.callAboveFoldCheck(doc('<body><p>' + words(900) + '</p><a href="tel:+16145550100">Call</a></body>'), 'service').status, 'fail');
  assert.strictEqual(_x.callAboveFoldCheck(doc('<body></body>'), 'blog').status, 'info');
});

test('Local area code (info): 614 is local for Columbus, 740 is not', () => {
  const { _x } = engine();
  assert.match(_x.areaCodeCheck(doc('<a href="tel:+16145550100">x</a>'), { areaCodes: ['614', '380'] }).detail, /Local number/);
  assert.match(_x.areaCodeCheck(doc('<a href="tel:+17408129489">x</a>'), { areaCodes: ['614', '380'] }).detail, /not a local 614\/380/);
});

test('GBP comparison: site claims 24/7 but GBP hours are not 24 hours fails; matching profile passes', async () => {
  const SEO = engine();
  const ok = [{ url: 'https://t/', pageType: 'home', inlinks: 0, _html: '', nap: { tel: ['(614) 555-0100'], visible: [], streets: ['1 main st'], schema: { names: ['Co'], phones: [], streets: [] } } }];
  const base = { home: ok[0], disc: { base: 'https://t' } };
  const bad = SEO._x.localFindings(ok, Object.assign({ local: { found: true, name: 'Co', phone: '(614) 555-0100', address: '1 Main St, X', website: 'https://t/', hours: { open247: false, weekdayText: ['Monday: 8 AM–5 PM'] } }, claims24_7: ['https://t/'] }, base));
  const g = bad.find(f => f.label === 'Google Business Profile matches the site');
  assert.strictEqual(g.status, 'fail'); assert.match(g.detail, /24\/7/);
  const good = SEO._x.localFindings(ok, Object.assign({ local: { found: true, name: 'Co', phone: '614-555-0100', address: '1 Main Street, X', website: 'https://t/', hours: { open247: true } }, claims24_7: ['https://t/'] }, base));
  assert.strictEqual(good.find(f => f.label === 'Google Business Profile matches the site').status, 'pass');
});

test('Google reviews shown: GBP cid link or widget passes; none warns', () => {
  const { _x } = engine();
  const base = { home: null, disc: { base: 'https://t' }, local: null };
  assert.strictEqual(_x.localFindings([{ url: 'https://t/', pageType: 'home', _html: '<a href="https://www.google.com/maps?cid=123">Reviews</a>' }], base).find(f => /Google reviews/.test(f.label)).status, 'pass');
  assert.strictEqual(_x.localFindings([{ url: 'https://t/', pageType: 'home', _html: '<p>hi</p>' }], base).find(f => /Google reviews/.test(f.label)).status, 'warn');
});
