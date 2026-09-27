'use strict';
// One true positive and one true negative per extended check (node --test test/checks.test.js).
const test = require('node:test');
const assert = require('node:assert');
const { engine, page, ld, words, same, doc } = require('./helpers');

// ---------------- Phase 2 — technical ----------------
test('Soft 404: "page not found" or <25 words fails; a real service page passes; home is exempt', () => {
  const { _x } = engine();
  assert.strictEqual(_x.soft404Check('service', 'Page Not Found | Co', '', 400).status, 'fail');
  assert.strictEqual(_x.soft404Check('other', 'Gallery', 'Gallery', 20).status, 'fail');
  assert.strictEqual(_x.soft404Check('service', 'Flatbed Towing | Co', 'Flatbed Towing', 600).status, 'pass');
  assert.strictEqual(_x.soft404Check('home', 'Home', '', 10).status, 'na');
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
  assert.strictEqual(_x.genericAnchorCheck([{ url: 'https://t/blog/post', text: 'Read more', href: '/blog/post' }]).status, 'na', 'no links to money pages = N/A');
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
  assert.strictEqual(_x.staleClaimsCheck(_x.yearClaims('We tow cars.'), null).status, 'na');
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
  assert.strictEqual(_x.callAboveFoldCheck(doc('<body></body>'), 'blog').status, 'na');
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

// ---------------- Phase 6 — structured data ----------------
const nodesOf = (SEO, html) => SEO.ldNodes(doc(html));
test('JSON-LD syntax: a trailing comma fails with evidence; valid JSON passes', () => {
  const { _x } = engine();
  const bad = _x.jsonLdSyntaxCheck(doc('<script type="application/ld+json">{"@type":"LocalBusiness","name":"X",}</script>'));
  assert.strictEqual(bad.status, 'fail'); assert.ok(bad.evidence[0].snippet.includes('LocalBusiness'));
  assert.strictEqual(_x.jsonLdSyntaxCheck(doc('<script type="application/ld+json">{"@type":"LocalBusiness","name":"X"}</script>')).status, 'pass');
});

test('Business entity: two unlinked entities warn; one @id (or linked via parentOrganization) passes', () => {
  const SEO = engine();
  const two = nodesOf(SEO, ld({ '@graph': [{ '@type': 'LocalBusiness', '@id': 'https://t/#b', name: 'Co' }, { '@type': 'Organization', '@id': 'https://t/#o', name: 'Co' }] }));
  assert.strictEqual(SEO._x.businessEntityCheck(two).status, 'warn');
  const linked = nodesOf(SEO, ld({ '@graph': [{ '@type': 'LocalBusiness', '@id': 'https://t/#b', name: 'Co', parentOrganization: { '@id': 'https://t/#o' } }, { '@type': 'Organization', '@id': 'https://t/#o', name: 'Co' }] }));
  assert.strictEqual(SEO._x.businessEntityCheck(linked).status, 'pass');
  assert.strictEqual(SEO._x.businessEntityCheck(nodesOf(SEO, ld({ '@type': 'AutoRepair', '@id': 'https://t/#b', name: 'Co' }))).status, 'pass');
});

test('Schema NAP: schema phone not on the page fails; matching phone passes', () => {
  const { _x } = engine();
  assert.strictEqual(_x.schemaNapCheck({ tel: ['(614) 555-0100'], visible: [], streets: [], schema: { names: [], phones: ['(614) 555-0199'], streets: [] } }).status, 'fail');
  assert.strictEqual(_x.schemaNapCheck({ tel: ['(614) 555-0100'], visible: [], streets: [], schema: { names: [], phones: ['(614) 555-0100'], streets: [] } }).status, 'pass');
});

test('Schema hours: page says 24/7 but schema lists 8–5 warns; schema 00:00–23:59 all week passes', () => {
  const SEO = engine();
  const set = nodesOf(SEO, ld({ '@type': 'LocalBusiness', name: 'Co', openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday'], opens: '08:00', closes: '17:00' }] }));
  assert.strictEqual(SEO._x.openingHoursCheck(set, 'We tow 24/7.').status, 'warn');
  const all = nodesOf(SEO, ld({ '@type': 'LocalBusiness', name: 'Co', openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], opens: '00:00', closes: '23:59' }] }));
  assert.strictEqual(SEO._x.openingHoursCheck(all, 'We tow 24/7.').status, 'pass');
});

test('Service / Breadcrumb schema: missing warns on service / inner pages; present passes', () => {
  const SEO = engine();
  assert.strictEqual(SEO._x.serviceSchemaCheck([], 'service').status, 'warn');
  assert.strictEqual(SEO._x.serviceSchemaCheck(nodesOf(SEO, ld({ '@type': 'Service', name: 'Towing' })), 'service').status, 'pass');
  assert.strictEqual(SEO._x.serviceSchemaCheck([], 'blog'), null);
  assert.strictEqual(SEO._x.breadcrumbCheck([], 'service').status, 'warn');
  assert.strictEqual(SEO._x.breadcrumbCheck(nodesOf(SEO, ld({ '@type': 'BreadcrumbList' })), 'service').status, 'pass');
});

test('FAQ schema must match visible text: reworded question fails; exact passes', () => {
  const SEO = engine();
  const faq = q => nodesOf(SEO, ld({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: 'Usually 20 to 40 minutes.' } }] }));
  const page = 'FAQ How fast can you get to me? Usually 20 to 40 minutes.';
  assert.strictEqual(SEO._x.faqMatchCheck(faq('How quickly will a truck arrive?'), page).status, 'fail');
  assert.strictEqual(SEO._x.faqMatchCheck(faq('How fast can you get to me?'), page).status, 'pass');
});

test('Invalid schema.org type "TowingService" warns; real types pass', () => {
  const SEO = engine();
  const c = SEO._x.schemaTypesCheck(nodesOf(SEO, ld({ '@type': 'TowingService', name: 'Co' })));
  assert.strictEqual(c.status, 'warn'); assert.match(c.evidence[0].snippet, /TowingService/);
  assert.strictEqual(SEO._x.schemaTypesCheck(nodesOf(SEO, ld({ '@type': ['LocalBusiness', 'AutomotiveBusiness'], name: 'Co' }))).status, 'pass');
});

// ---------------- Phase 7 — trust & conversion ----------------
test('License numbers (towing config): PUCO / USDOT found passes; none fails; general industry skips', async () => {
  const SEO = engine(); await SEO._x.loadIndustry('towing');
  const c = SEO._x.licenseCheck('Licensed: PUCO towing certificate 650256, USDOT #03560921.', 'home');
  assert.strictEqual(c.status, 'pass'); assert.match(c.detail, /PUCO towing certificate 650256/); assert.match(c.detail, /USDOT #03560921/);
  assert.strictEqual(SEO._x.licenseCheck('We tow cars.', 'service').status, 'fail');
  await SEO._x.loadIndustry('general');
  assert.strictEqual(SEO._x.licenseCheck('PUCO 650256', 'home'), null);
});

test('Pricing: "no hidden fees" without prices fails; a price or a link to a rate-card page passes', () => {
  const { _x } = engine();
  assert.strictEqual(_x.pricingCheck('Fast towing, no hidden fees.', [], 'service').status, 'fail');
  assert.strictEqual(_x.pricingCheck('Hook-up $80, $4.50 per mile.', [], 'service').status, 'pass');
  assert.strictEqual(_x.pricingCheck('No hidden fees.', [{ url: 'https://t/quote', text: 'Online quote', href: '/quote' }], 'home', new Set(['https://t/quote'])).status, 'pass');
  assert.strictEqual(_x.pricingCheck('We tow cars.', [], 'service').status, 'warn');
});

test('Insurance mention: "fully insured" passes; nothing fails', () => {
  const { _x } = engine();
  assert.strictEqual(_x.insuranceCheck('Licensed and fully insured operators.', 'home').status, 'pass');
  assert.strictEqual(_x.insuranceCheck('We tow cars.', 'home').status, 'fail');
});

test('Trust site findings: about page with owner passes; dead form fails (GET only); privacy policy missing tracking warns', async () => {
  const SEO = engine({ 'https://t/thanks-handler': { status: 404 } });
  const pages = [{ url: 'https://t/about', pageType: 'other', _pageText: 'Owner Jane Smith started the company in 1990.', _html: '' },
    { url: 'https://t/contact', pageType: 'utility', _pageText: '', _html: '<form action="/thanks-handler" method="post"></form>' },
    { url: 'https://t/privacy-policy', pageType: 'utility', _pageText: 'We collect your phone number.', _html: '' }];
  const f = SEO._x.trustFindings(pages, { tracking: ['Google Analytics'] });
  await SEO._x.resolveAsyncFindings(f);
  assert.strictEqual(f.find(x => /About page/.test(x.label)).status, 'pass');
  const form = f.find(x => /Form endpoints/.test(x.label)); assert.strictEqual(form.status, 'fail'); assert.match(form.evidence[0].snippet, /thanks-handler"> → 404/);
  assert.strictEqual(f.find(x => /Privacy policy covers/.test(x.label)).status, 'warn');
  const ok2 = SEO._x.trustFindings([{ url: 'https://t/about', _pageText: 'About our trucks.', _html: '' }, { url: 'https://t/privacy', _pageText: 'We use Google Analytics cookies.', _html: '' }], { tracking: ['Google Analytics'] });
  assert.strictEqual(ok2.find(x => /About page/.test(x.label)).status, 'warn');
  assert.strictEqual(ok2.find(x => /Privacy policy covers/.test(x.label)).status, 'pass');
});

// ---------------- Phase 8 — AI search ----------------
test('Question headings: "?" H2 + short answer passes; long answer warns; none fails', () => {
  const { _x } = engine();
  assert.strictEqual(_x.questionAnswerCheck(doc('<h2>How fast can you get to me?</h2><p>Most calls are reached in 20 to 40 minutes.</p>'), 'service').status, 'pass');
  assert.strictEqual(_x.questionAnswerCheck(doc('<h2>How fast can you get to me?</h2><p>' + words(90) + '</p>'), 'service').status, 'warn');
  assert.strictEqual(_x.questionAnswerCheck(doc('<h2>Our services</h2><p>We tow.</p>'), 'service').status, 'fail');
});

test('Citable facts: licence + hours + prices pass; none fails', async () => {
  const SEO = engine(); await SEO._x.loadIndustry('towing');
  assert.strictEqual(SEO._x.citableFactsCheck('USDOT #03560921. Open 24/7. Hook-up $80.', 'home', []).status, 'pass');
  assert.strictEqual(SEO._x.citableFactsCheck('We are great.', 'home', []).status, 'fail');
});

test('AI site findings: Bingbot-only Disallow fails; name mismatch between schema and title warns', () => {
  const { _x } = engine();
  const home = { url: 'https://t/', title: 'Best Tow Co | Columbus', _html: '<footer>Best Tow Co</footer>', nap: { schema: { names: ['Acme Towing'] } } };
  const f = _x.aiSiteFindings([home], { home, local: null, robots: 'User-agent: bingbot\nDisallow: /\n\nUser-agent: *\nAllow: /', disc: { base: 'https://t' } });
  assert.strictEqual(f.find(x => /Bingbot/.test(x.label)).status, 'fail');
  assert.strictEqual(f.find(x => /One business name/.test(x.label)).status, 'warn');
  const home2 = { url: 'https://t/', title: 'Towing | Acme Towing', _html: '<footer>© Acme Towing</footer>', nap: { schema: { names: ['Acme Towing'] } } };
  const g = _x.aiSiteFindings([home2], { home: home2, local: null, robots: 'User-agent: *\nAllow: /', disc: { base: 'https://t' } });
  assert.strictEqual(g.find(x => /Bingbot/.test(x.label)).status, 'pass');
  assert.strictEqual(g.find(x => /One business name/.test(x.label)).status, 'pass');
});

// ---------------- Phase 9 — stack & agency fingerprint (info only) ----------------
test('Stack fingerprint: WordPress theme/plugins/builder, payments, call tracking, agency credit; plain page finds nothing', async () => {
  const SEO = engine(); await SEO._x.loadIndustry('towing');
  const html = '<meta name="generator" content="WordPress 6.5"><link href="/wp-content/themes/generatepress/style.css?ver=3.4"><script src="/wp-content/plugins/gravityforms/js/x.js?ver=2.8.1"></script>'
    + '<div class="fl-builder-content"></div><script src="https://cdn.callrail.com/companies/1/swap.js"></script><a href="https://www.paypal.com/pay">Pay</a><a href="https://public.towbook.com/x">Impounds</a>'
    + '<footer>Website by Acme Web Co</footer>';
  const st = await SEO._x.stackFingerprint([{ url: 'https://t/', _html: html, _pageText: '', headers: { 'cf-ray': 'x' } }], { home: { url: 'https://t/', title: 'Co', _html: html }, local: null });
  assert.strictEqual(st.cms, 'WordPress'); assert.ok(st.theme.includes('generatepress'));
  assert.ok(st.plugins.some(p => p.name === 'Gravity Forms' && p.version === '2.8.1'));
  assert.ok(st.builders.includes('Beaver Builder')); assert.ok(st.tracking.includes('CallRail'));
  assert.ok(st.payments.includes('PayPal')); assert.ok(st.opsTools.includes('Towbook'));
  assert.ok(st.agency.credits.some(c => /Acme Web Co/.test(c.value))); assert.ok(st.hosting.includes('Cloudflare (CDN)'));
  const plain = await SEO._x.stackFingerprint([{ url: 'https://t/', _html: '<p>Hello</p>', _pageText: 'Hello', headers: null }], { home: { url: 'https://t/', title: 'Co', _html: '<p>Hello</p>' }, local: null });
  assert.strictEqual(plain.cms, null); same([plain.builders, plain.plugins, plain.payments, plain.opsTools, plain.agency.credits, plain.tracking], [[], [], [], [], [], []]);
});

// ---------------- Thin-location caps ----------------
test('Thin location caps: <150 unique words caps at 70, <300 at 80; other page types and rich pages uncapped', () => {
  const { score } = engine();
  const perfect = extra => Object.assign({ checks: [{ cat: 'x', label: 'a', points: 10, status: 'pass' }] }, extra);
  assert.strictEqual(score(perfect({ pageType: 'location', uniqueWords: 120 })).score, 70);
  assert.strictEqual(score(perfect({ pageType: 'location', uniqueWords: 250 })).score, 80);
  assert.strictEqual(score(perfect({ pageType: 'location', uniqueWords: 400 })).score, 100);
  assert.strictEqual(score(perfect({ pageType: 'service', uniqueWords: 120 })).score, 100);
  const low = score({ pageType: 'location', uniqueWords: 120, checks: [{ cat: 'x', label: 'a', points: 10, status: 'fail' }] });
  assert.strictEqual(low.score, 0, 'a cap never raises a score');
});

// ---------------- Live-report fixes ----------------
test('GBP pick: several places — the one with the site phone wins; name match next; never blind', () => {
  const { pickPlace } = require('../places');
  const cands = [{ name: 'Columbus Towing Co', formatted_phone_number: '(614) 555-1111' }, { name: 'Roadside Towing & Recovery Inc', formatted_phone_number: '(740) 812-9489' }];
  assert.strictEqual(pickPlace(cands, { phone: '740-812-9489', name: 'x' }).place.name, 'Roadside Towing & Recovery Inc');
  assert.strictEqual(pickPlace(cands, { phone: '', name: 'Roadside Towing & Recovery Inc' }).matchedBy, 'name');
  assert.strictEqual(pickPlace([], { phone: '1' }), null);
});

test('GBP query uses the business name + phone, never a service+city title', () => {
  const SEO = engine();
  assert.strictEqual(SEO.titleBrand('Towing Columbus OH | Roadside Towing & Recovery Inc'), 'Roadside Towing & Recovery Inc');
  assert.strictEqual(SEO.titleBrand('Towing Columbus OH'), null, 'a title with no brand part gives no name');
  const q = SEO.gbpQuery({ title: 'Towing Columbus OH', nap: { tel: ['(740) 812-9489'], streets: ['1620 harrisburg pike'], schema: { names: ['Roadside Towing & Recovery Inc'], phones: [], streets: [] } } });
  same(q, { name: 'Roadside Towing & Recovery Inc', phone: '(740) 812-9489', address: '1620 harrisburg pike' });
  assert.strictEqual(SEO.gbpQuery({ title: 'Towing Columbus OH', nap: { tel: [], streets: [], schema: { names: [], phones: [], streets: [] } } }).name, null);
});

test('Severity follows the shortfall, not the weight', () => {
  const SEO = engine();
  assert.strictEqual(SEO.checkSeverity({ status: 'warn', points: 2 }), 'Low');          // loses 1
  assert.strictEqual(SEO.checkSeverity({ status: 'fail', points: 3 }), 'Medium');       // loses 3
  assert.strictEqual(SEO.checkSeverity({ status: 'warn', points: 25, frac: 0.9 }), 'Medium'); // loses 2.5 of a heavy check
  assert.strictEqual(SEO.checkSeverity({ status: 'fail', points: 3, penalty: 20 }), 'Critical');
  assert.strictEqual(SEO.checkSeverity({ status: 'warn', points: 25, frac: 0.5, sev: 'High' }), 'High', 'explicit band wins');
});

test('Problem-state titles: JS weight, title length, inlinks, insurance', () => {
  const SEO = engine(); const { _x } = SEO;
  assert.strictEqual(_x.weightCheck(50000, { scripts: [], css: [], images: [], inlineJs: 0 }, { js: 697344, css: 0, img: 0, top: [] }).problem, 'JavaScript too heavy: 681 KB');
  assert.strictEqual(SEO.problemTitle({ label: 'Title length optimal', status: 'warn', detail: '65 characters' }), 'Title too long: 65 chars');
  assert.strictEqual(SEO.problemTitle({ label: 'Insurance mentioned', status: 'fail', detail: 'No mention of insurance' }), 'No insurance mention');
  const f = _x.onPageLinkFindings([{ url: 'https://t/services/a', pageType: 'service', inlinks: 2, clickDepth: 1, _anchors: [] }]).find(x => x.label === 'Money pages well linked');
  assert.match(f.evidence[0].snippet, /2 inlinks/); assert.match(SEO.problemTitle(f), /1 service\/location page has <3 internal links/);
});

test('Nothing to evaluate = N/A (not fail) and N/A is excluded from the score', async () => {
  const u = 'https://t.example/services/towing';
  const SEO = engine({ [u]: { body: page({ body: '<h1>Towing</h1><p>' + words(600) + '</p>' }) } });
  const r = await SEO.auditOne(u);
  ['Images have alt text', 'Images have dimensions', 'Image efficiency'].forEach(l => assert.strictEqual(r.checks.find(c => c.label === l).status, 'na', l));
  const withImg = SEO.score(Object.assign({}, r, { checks: r.checks.map(c => c.label === 'Images have alt text' ? Object.assign({}, c, { status: 'fail' }) : c) }));
  assert.ok(SEO.score(r).score > withImg.score, 'N/A does not cost points');
});

test('Slow pages are retested alone twice; fast retests flag "slow under crawl load only"', async () => {
  const fast = engine({ 'https://t/a': { body: page({ body: words(80) }) } });
  const p1 = { url: 'https://t/a', loadMs: 2600 }; await fast.retestSlowPages([p1]);
  assert.strictEqual(p1.retestMs.length, 2); assert.strictEqual(p1.slowUnderLoadOnly, true);
  const slow = engine({ 'https://t/b': { body: page({ body: words(80) }), delays: [2100, 2100] } });
  const p2 = { url: 'https://t/b', loadMs: 2600 }; await slow.retestSlowPages([p2]);
  assert.ok(p2.retestMs.every(ms => ms >= 2000)); assert.strictEqual(p2.slowUnderLoadOnly, false);
});

test('Citable facts evidence lists the missing facts', async () => {
  const SEO = engine(); await SEO._x.loadIndustry('towing');
  const c = SEO._x.citableFactsCheck('Open 24/7.', 'home', []);
  same(c.evidence.map(e => e.snippet), ['missing: licence #', 'missing: service-area list', 'missing: pricing']);
  assert.match(SEO.problemTitle(c), /Missing citable facts: licence #, service-area list, pricing/);
});
