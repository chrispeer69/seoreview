'use strict';
// One test per fix from the Capital Towing crawl (engine 9fbd449). Everything runs against in-memory routes.
const test = require('node:test');
const assert = require('node:assert');
const { engine, page, ld, check, words, same, doc } = require('./helpers');

const ROOT = 'https://cap.example';
const biz = { '@context': 'https://schema.org', '@type': 'AutoRepair', '@id': ROOT + '/#biz', name: 'Capital Towing', telephone: '614-555-0100',
  address: { '@type': 'PostalAddress', streetAddress: '100 Main St', addressLocality: 'Columbus', addressRegion: 'OH' },
  openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', dayOfWeek: 'Monday', opens: '00:00', closes: '23:59' }] };
const html = (title, h1, extra) => page({ title, head: ld(biz), body: '<h1>' + h1 + '</h1><a href="tel:+16145550100">Call</a><p>' + words(400) + '</p>' + (extra || '') });

// A small site: homepage links to a service-in-city page, a KML map, a PDF served without an extension and an RSS feed.
function capitalSite() {
  const links = '<a href="/flatbed-towing-in-columbus-oh/">Flatbed</a><a href="/locations.kml">Map</a><a href="/brochure">Brochure</a><a href="/feed/">RSS</a>';
  return {
    [ROOT + '/']: { body: html('Capital Towing | Columbus, OH', 'Capital Towing Columbus', links) },
    [ROOT + '/flatbed-towing-in-columbus-oh/']: { body: html('Flatbed Towing in Columbus, OH | Capital Towing', 'Flatbed Towing in Columbus') },
    [ROOT + '/locations.kml']: { body: '<?xml version="1.0"?><kml></kml>', contentType: 'application/vnd.google-earth.kml+xml' },
    [ROOT + '/brochure']: { body: '%PDF-1.4', contentType: 'application/pdf' },
    [ROOT + '/feed/']: { body: '<rss></rss>', contentType: 'application/rss+xml' },
    [ROOT + '/robots.txt']: { body: 'User-agent: *\nAllow: /' },
  };
}

test('1. GBP lookup query renders as text, never "[object Object]"', async () => {
  const SEO = engine(capitalSite());
  assert.strictEqual(SEO.gbpQueryText({ name: 'Capital Towing', phone: '(614) 555-0100', address: null }), 'Capital Towing · (614) 555-0100');
  assert.strictEqual(SEO.gbpQueryText('Capital Towing'), 'Capital Towing', 'older saved results stored a string');
  const res = await SEO.crawlSite(ROOT + '/', { max: 10, concurrency: 2, industry: 'towing' });
  res.local = { found: false, query: { name: 'Capital Towing', phone: '(614) 555-0100', address: '100 Main St, Columbus, OH' } };
  const out = SEO.siteReportHTML(res);
  assert.ok(!/\[object Object\]/.test(out), 'no [object Object] in the report');
  assert.match(out, /Capital Towing · \(614\) 555-0100 · 100 Main St/);
});

test('2. Only text/html is audited; KML, PDF and feeds are listed under "Non-HTML files found"', async () => {
  const SEO = engine(capitalSite());
  const res = await SEO.crawlSite(ROOT + '/', { max: 10, concurrency: 2, industry: 'towing' });
  const audited = res.pages.map(p => p.url);
  assert.ok(!audited.some(u => /kml|brochure|feed/.test(u)), 'non-HTML never audited: ' + audited.join(', '));
  same(res.nonHtml.map(x => x.url.replace(ROOT, '')).sort(), ['/brochure', '/locations.kml']); // /feed/ links are dropped at extraction
  assert.match(SEO.siteReportHTML(res), /Non-HTML files found \(2\)/);
  assert.ok(SEO.isNonHtml(ROOT + '/feed/') && SEO.isNonHtml(ROOT + '/blog/rss'), 'feeds reached another way are skipped too');
  assert.ok(SEO.isNonHtml(ROOT + '/sitemap.xml') && SEO.isNonHtml(ROOT + '/logo.png') && SEO.isNonHtml(ROOT + '/x', 'application/pdf'));
  assert.ok(!SEO.isNonHtml(ROOT + '/towing/', 'text/html; charset=utf-8'));
  assert.ok(!(res.findings || SEO.allFindings(res)).some(f => /kml|brochure|feed/.test(JSON.stringify(f.urls || []))), 'never in findings');
});

test('3. "<service>-in-<city>" is a service page in the primary city; a location page only when the city differs AND it is city-led', async () => {
  const SEO = engine({});
  const t = (u, ctx) => SEO.classifyPage(ROOT + u, [], ctx);
  assert.strictEqual(t('/towing-in-columbus-oh/', { primaryCity: 'Columbus' }), 'service');
  assert.strictEqual(t('/towing-in-dublin/', { primaryCity: 'Columbus', h1: 'Towing in Dublin' }), 'service', 'service-led slug and H1');
  assert.strictEqual(t('/towing-in-dublin/', { primaryCity: 'Columbus', h1: 'Dublin Towing & Roadside' }), 'location', 'other city, H1 city-led');
  // The primary city comes from the page's own schema address in a real audit.
  const S2 = engine(capitalSite());
  const r = await S2.auditOne(ROOT + '/flatbed-towing-in-columbus-oh/');
  assert.strictEqual(r.pageType, 'service');
  // …and the service coverage matrix counts it as covered.
  const res = await S2.crawlSite(ROOT + '/', { max: 10, concurrency: 2, industry: 'towing' });
  const sc = (res.siteFindings.find(f => f.matrix) || {}).matrix;
  const row = sc && sc.rows.find(x => x.service === 'Flatbed towing');
  assert.strictEqual(row.status, 'covered', '✓ in the matrix'); assert.match(row.url, /flatbed-towing-in-columbus-oh/);
});

test('4. "Title names the place": case/punctuation-blind, suggestion from THIS page\'s own service + city', () => {
  const { _x } = engine({});
  const u = ROOT + '/towing-in-grove-city-ohio/';
  ['Towing in Grove City, OH | Capital', 'TOWING grove city ohio | Capital', 'Towing Grove City | Capital'].forEach(title =>
    assert.strictEqual(_x.titleQualityCheck(title, u, 'service').status, 'pass', title));
  const bad = _x.titleQualityCheck('Towing | Capital Towing', u, 'service');
  assert.strictEqual(bad.status, 'fail'); assert.match(bad.problem, /does not name the place \(Grove City\)/);
  assert.match(bad.fix, /"Towing in Grove City \| Your Business Name"/);
  const other = _x.titleQualityCheck('Capital Towing', ROOT + '/jump-start-in-hilliard/', 'service');
  assert.match(other.fix, /Jump Start in Hilliard/); assert.ok(!/Grove City/.test(other.fix), 'never another page\'s slug');
});

// A page result with just the checks allFindings reads.
const pg = (url, checks, extra) => Object.assign({ url, checks }, extra || {});
const lb = detail => ({ cat: 'Local SEO', label: 'LocalBusiness structured data', points: 12, status: /missing/.test(detail) ? 'warn' : 'fail', detail,
  fix: /missing/.test(detail) ? 'Add ' + detail.split('missing ')[1] + ' to the AutoRepair JSON-LD.' : 'Add JSON-LD LocalBusiness with name, address, telephone.',
  evidence: [{ snippet: detail }] });

test('5+6. Aggregated finding: headline = most common variant with its count; fix and evidence from that variant; noindex never headlines', () => {
  const SEO = engine({});
  const res = { pages: [
    pg(ROOT + '/a', [lb('No LocalBusiness schema (found: WebPage)')]), pg(ROOT + '/b', [lb('No LocalBusiness schema (found: WebPage)')]),
    pg(ROOT + '/c', [lb('No LocalBusiness schema (found: WebPage)')]), pg(ROOT + '/d', [lb('AutoRepair schema — missing address')]),
    pg(ROOT + '/e', [lb('AutoRepair schema — missing address')], { noindex: true }), pg(ROOT + '/f', [lb('AutoRepair schema — missing address')], { noindex: true }),
    pg(ROOT + '/g', [lb('AutoRepair schema — missing address')], { noindex: true }),
  ] };
  const f = SEO.allFindings(res).find(x => x.check === 'LocalBusiness structured data');
  assert.strictEqual(f.title, 'No LocalBusiness schema — 3 pages');
  assert.match(f.fix, /^Add JSON-LD LocalBusiness/, 'fix from the missing-schema variant');
  assert.match(f.evidence.snippet, /No LocalBusiness schema/, 'evidence from the same variant');
  assert.strictEqual(f.pagesAffected, 4, 'noindex pages are not counted');
  assert.ok(!f.urls.some(u => /\/[efg]$/.test(u)));
  // Numbers vary within one variant: the headline shows the range.
  const thin = n => ({ cat: 'On-Page Content', label: 'Unique content', points: 25, status: 'warn', detail: n + ' unique words', issue: 'Thin content: ' + n + ' unique words', fix: 'Write more.', evidence: [] });
  const r2 = { pages: [pg(ROOT + '/x', [thin(153)]), pg(ROOT + '/y', [thin(728)]), pg(ROOT + '/z', [thin(400)])] };
  assert.strictEqual(SEO.allFindings(r2).find(x => x.check === 'Unique content').title, 'Thin content: 153–728 unique words — 3 pages');
});

test('7. Tap-to-call passes in the first ~20% of the body, in header/nav, or in a sticky/fixed bar', () => {
  const { _x } = engine({});
  const tel = '<a href="tel:+16145550100">Call now</a>';
  const s = b => _x.callAboveFoldCheck(doc('<body>' + b + '</body>'), 'service').status;
  assert.strictEqual(s('<div class="hero"><p>' + words(20) + '</p>' + tel + '</div><p>' + words(900) + '</p>'), 'pass', 'first 20%');
  assert.strictEqual(s('<nav>' + tel + '</nav><p>' + words(900) + '</p>'), 'pass', 'nav');
  assert.strictEqual(s('<p>' + words(900) + '</p><div class="elementor-sticky">' + tel + '</div>'), 'pass', 'sticky class');
  assert.strictEqual(s('<p>' + words(900) + '</p><div style="position: fixed; bottom:0">' + tel + '</div>'), 'pass', 'fixed style');
  assert.strictEqual(s('<p>' + words(900) + '</p><footer>' + tel + '</footer>'), 'fail', 'only in the footer');
});

test('8. Intentional noindex (privacy, terms, careers, applications, feedback, /page/N/, archives): no finding, not in the page average', async () => {
  const SEO = engine({});
  ['/privacy-policy/', '/terms/', '/careers/', '/employment-application/', '/feedback/', '/blog/page/2/', '/thank-you/'].forEach(p =>
    assert.ok(SEO.intentionalNoindex(ROOT + p, 'other'), p));
  assert.ok(SEO.intentionalNoindex(ROOT + '/category/news/', 'archive'));
  assert.ok(!SEO.intentionalNoindex(ROOT + '/towing-in-columbus-oh/', 'service'));
  const noidx = '<meta name="robots" content="noindex">';
  const S = engine({ [ROOT + '/careers/']: { body: page({ title: 'Careers | Capital', head: noidx, body: '<h1>Careers</h1>' + words(300) }) },
    [ROOT + '/towing/']: { body: page({ title: 'Towing | Capital', head: noidx, body: '<h1>Towing</h1>' + words(300) }) } });
  const c = await S.auditOne(ROOT + '/careers/');
  assert.strictEqual(check(c, 'Page is indexable').status, 'na');
  assert.ok(!S.score(c).penalty, 'no noindex penalty');
  assert.strictEqual(check(await S.auditOne(ROOT + '/towing/'), 'Page is indexable').status, 'fail', 'a money page still fails');
});

test('9. Page weight names the failing resource type and its largest file', () => {
  const { _x } = engine({});
  const a = { scripts: [], css: [], images: [], inlineJs: 0 };
  const css = _x.weightCheck(40000, a, { js: 100000, css: 1.8e6, img: 200000, top: [],
    topByType: { css: { url: 'https://cap.example/wp-content/style.css', bytes: 874 * 1024 } }, topByTypeList: { css: [{ url: 'https://cap.example/wp-content/style.css', bytes: 874 * 1024 }] } });
  assert.strictEqual(css.status, 'warn');
  assert.match(css.problem, /^CSS too heavy: .* \(largest file: style\.css, 874 KB\) — page total/);
  assert.match(css.evidence[0].snippet, /^CSS: https:\/\/cap\.example\/wp-content\/style\.css — 874 KB/);
  const img = _x.weightCheck(40000, a, { js: 0, css: 0, img: 2.5e6, top: [], topByType: { img: { url: 'https://cap.example/hero.jpg', bytes: 1.2e6 } } });
  assert.match(img.problem, /^Images too heavy: .*largest file: hero\.jpg/); assert.match(img.fix, /Compress/);
});

test('10. Crawl fetches go only through our server; a bot challenge backs off, retries once, then falls back to ScrapingBee', async () => {
  const challenge = { status: 403, body: '<html><title>Just a moment...</title><div id="cf-chl-widget"></div></html>', headers: { 'x-proxy-reason': 'bot-protection' } };
  const good = '<!doctype html><html><head><title>Towing | Capital</title></head><body><h1>Towing</h1>' + words(200) + '</body></html>';
  let routes = { [ROOT + '/']: challenge, render: () => good };
  let SEO = engine(routes); SEO._x.setBackoff(10);
  assert.strictEqual(SEO.PROXIES.length, 1); assert.match(SEO.PROXIES[0].build(ROOT), /^\/api\/proxy\?url=/, 'no third-party CORS proxy');
  assert.strictEqual(await SEO.fetchHtml(ROOT + '/'), good);
  same(routes.renderCalls, [ROOT + '/']);
  // Challenge clears on the retry after the pause: no ScrapingBee call.
  routes = { [ROOT + '/']: { seq: [challenge, { status: 200, body: good }] }, render: () => null };
  SEO = engine(routes); SEO._x.setBackoff(10);
  assert.strictEqual(await SEO.fetchHtml(ROOT + '/'), good);
  assert.ok(!routes.renderCalls, 'no render needed');
  // Still blocked everywhere: a "blocked" error the report lists.
  SEO = engine({ [ROOT + '/']: challenge, render: () => null }); SEO._x.setBackoff(10);
  await assert.rejects(SEO.fetchHtml(ROOT + '/'), e => e.blocked === true && e.challenged === true && /ScrapingBee/.test(e.reason));
  // A plain 404 is not retried or rendered.
  routes = { [ROOT + '/x']: { status: 404 }, render: () => good };
  SEO = engine(routes);
  await assert.rejects(SEO.fetchHtml(ROOT + '/x'), /HTTP 404/); assert.ok(!routes.renderCalls);
});

test('11. NAP: 2+ consistent addresses = "Multiple locations detected" (info); only a street on a few pages is an inconsistency', () => {
  const { _x } = engine({});
  const nap = (streets, schemaStreets) => ({ tel: ['6145550100'], visible: [], streets, schema: { names: ['Capital Towing'], phones: ['6145550100'], streets: schemaStreets || [] } });
  const both = ['100 main st', '9 oak ave'];
  const pages = Array.from({ length: 10 }, (_, i) => ({ url: ROOT + '/p' + i, nap: nap(both, i === 0 ? both : []) }));
  let r = _x.napIssues(pages);
  same(r.multiLocation.map(v => v.value).sort(), both);
  assert.ok(!r.inconsistent.includes('address'), 'two footer addresses on every page are two locations');
  // A third street on one page, next to the consistent ones, is the inconsistency.
  pages[7] = { url: ROOT + '/p7', nap: nap(both.concat(['55 old rd'])) };
  pages[8] = { url: ROOT + '/p8', nap: nap(both.concat(['55 old rd'])) };
  r = _x.napIssues(pages);
  assert.ok(r.inconsistent.includes('address'));
  assert.ok(r.addressIssue.some(v => v.value === '55 old rd' && v.pages === 2));
  // Single location, one stray street on 2 of 10 pages: still flagged.
  const one = Array.from({ length: 10 }, (_, i) => ({ url: ROOT + '/q' + i, nap: nap(i < 2 ? ['100 main st', '55 old rd'] : ['100 main st']) }));
  r = _x.napIssues(one);
  same(r.multiLocation, []); assert.ok(r.inconsistent.includes('address'));
  // The report shows the info line, not the NAP problem.
  const SEO = engine({});
  const out = SEO.siteReportHTML({ root: ROOT, siteScore: 80, pages: [], crossPage: { nap: _x.napIssues(pages.slice(0, 7)) }, coverage: { discovered: 7, audited: 7 } });
  assert.match(out, /Multiple locations detected \(2\) — info/);
  assert.ok(!/Inconsistent business name/.test(out));
});
