'use strict';
// Fixes finished for the three-site calibration batch: homepage audited after a bare-domain redirect, weighted page
// average, coverage cap under 5 money pages, PropertyValueSpecification, brand-only H1, tighter pricing, unverified
// sitemap lastmod, SVG <title> ignored, soft-404 threshold.
const test = require('node:test');
const assert = require('node:assert');
const { engine, page, ld, check, words } = require('./helpers');

const BARE = 'https://cap.example', WWW = 'https://www.cap.example';
const biz = { '@context': 'https://schema.org', '@type': 'AutoRepair', name: 'Cap Towing', telephone: '614-555-0100',
  address: { '@type': 'PostalAddress', streetAddress: '1 Main St', addressLocality: 'Columbus', addressRegion: 'OH' } };

test('Homepage is audited when the bare domain redirects to www (same page, other host)', async () => {
  const SEO = engine({
    [BARE + '/']: { status: 301, location: WWW + '/' },
    [WWW + '/']: { body: page({ title: 'Towing in Columbus | Cap Towing', head: ld(biz), body: '<h1>Towing in Columbus</h1><a href="/towing/">Towing</a><p>' + words(300) + '</p>' }) },
    [WWW + '/towing/']: { body: page({ title: 'Towing | Cap Towing', body: '<h1>Towing</h1><p>' + words(300) + '</p>' }) },
    [BARE + '/robots.txt']: { body: 'User-agent: *\nAllow: /' },
  });
  const res = await SEO.crawlSite(BARE + '/', { max: 10, concurrency: 2 });
  const home = res.pages.find(p => !p.error && p.pageType === 'home');
  assert.ok(home, 'homepage audited: ' + res.pages.map(p => p.url).join(', '));
  assert.strictEqual(home.url, WWW + '/');
  assert.ok(res.pages.some(p => p.url === WWW + '/towing/'), 'its links were followed');
});

test('Page average is weighted by page type; under 5 money pages caps the site at 70', async () => {
  const SEO = engine({
    [WWW + '/']: { body: page({ title: 'Towing in Columbus | Cap Towing', head: ld(biz), body: '<h1>Towing in Columbus</h1><a href="/towing/">T</a><a href="/privacy-policy/">P</a><p>' + words(400) + '</p>' }) },
    [WWW + '/towing/']: { body: page({ title: 'Towing | Cap Towing', body: '<h1>Towing</h1><p>' + words(400) + '</p>' }) },
    [WWW + '/privacy-policy/']: { body: page({ title: 'Privacy | Cap Towing', body: '<h1>Privacy</h1><p>' + words(40) + '</p>' }) },
    [WWW + '/robots.txt']: { body: 'User-agent: *\nAllow: /' },
  });
  const res = await SEO.crawlSite(WWW + '/', { max: 10, concurrency: 2 });
  const w = { home: 3, service: 2, location: 2, utility: 0.5, archive: 0.5 };
  const scored = res.pages.filter(p => !p.error && p._score);
  const expect = Math.round(scored.reduce((a, p) => a + (w[p.pageType] || 1) * p._score.score, 0) / scored.reduce((a, p) => a + (w[p.pageType] || 1), 0));
  assert.strictEqual(res.siteBreakdown.pageAverage, expect);
  const cap = res.siteBreakdown.caps.find(c => c.max === 70);
  assert.ok(cap && /Only 1 service\/location page \(under 5\)/.test(cap.reason), JSON.stringify(res.siteBreakdown.caps));
  assert.ok(res.siteScore <= 70);
});

test('PropertyValueSpecification (SearchAction query-input) is a valid schema.org type', () => {
  const { _x } = engine({});
  const site = { '@type': 'WebSite', potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: 'https://x/?s={q}' },
    'query-input': { '@type': 'PropertyValueSpecification', valueRequired: true, valueName: 'q' } } };
  const r = _x.schemaTypesCheck([site, site.potentialAction, site.potentialAction.target, site.potentialAction['query-input']]);
  assert.strictEqual(r.status, 'pass', r.detail);
});

test('Brand-only H1 fails; a descriptive H1 passes', async () => {
  const { _x } = engine({});
  const brands = ['Capital Towing & Recovery, LLC'];
  assert.strictEqual(_x.genericH1Check('Capital Towing & Recovery', brands).status, 'fail');
  assert.strictEqual(_x.genericH1Check('Welcome to Capital Towing &amp; Recovery', brands).status, 'fail');
  assert.strictEqual(_x.genericH1Check('Capital Towing & Recovery', brands).problem, 'H1 is only the business name');
  assert.strictEqual(_x.genericH1Check('Capital Towing & Recovery — 24/7 Towing in Columbus, OH', brands).status, 'pass');
  assert.strictEqual(_x.genericH1Check('Towing in Columbus', []).status, 'pass');
  // wired into the page audit from the schema name
  const u = 'https://t.example/';
  const SEO = engine({ [u]: { body: page({ title: 'Capital Towing & Recovery', head: ld({ '@type': 'AutoRepair', name: 'Capital Towing & Recovery' }), body: '<h1>Capital Towing &amp; Recovery</h1><p>' + words(300) + '</p>' }) } });
  assert.strictEqual(check(await SEO.auditOne(u), 'Specific H1').status, 'fail');
});

test('Pricing: a dollar amount counts only in a pricing context; "first-rate" is not a pricing link', () => {
  const { _x } = engine({});
  assert.strictEqual(_x.findPrice('Get $50 off your first tow this month!'), null);
  assert.strictEqual(_x.findPrice('We carry $1,000,000 in liability coverage.'), null);
  assert.strictEqual(_x.findPrice('Now hiring drivers, $25/hr plus bonus.'), null);
  assert.strictEqual(_x.findPrice('Hook-up fee starts at $75, then $4 per mile.')[0], '$75');
  assert.ok(!_x.isPricingLink({ url: 'https://t/about/', text: 'first-rate service' }));
  assert.ok(!_x.isPricingLink({ url: 'https://t/services/', text: 'cost-effective towing' }));
  assert.ok(_x.isPricingLink({ url: 'https://t/pricing/', text: 'See more' }));
  assert.ok(_x.isPricingLink({ url: 'https://t/p?id=3', text: 'Our rates' }));
  const off = _x.pricingCheck('Get $50 off your first tow. Affordable rates!', [], 'service', new Set());
  assert.strictEqual(off.status, 'fail', 'a discount is not a price; the "affordable rates" claim stands unbacked');
  assert.strictEqual(_x.pricingCheck('Flatbed tows start at $95 within 10 miles.', [], 'service', new Set()).status, 'pass');
});

test('Sitemap lastmod is used for freshness but labelled unverified', () => {
  const { _x } = engine({});
  const pages = [{ url: 'https://t/a', pageType: 'service' }, { url: 'https://t/b', pageType: 'service' }];
  const f = _x.freshnessScore(pages, { 'https://t/a': '2026-09-01', 'https://t/b': '2026-06-01' }, Date.parse('2026-09-27'));
  assert.strictEqual(f.newest, '2026-09-01');
  assert.match(f.source, /sitemap lastmod \(unverified/);
  const onPage = _x.freshnessScore([{ url: 'https://t/a', pageType: 'blog', datePublished: '2026-09-10' }], {}, Date.parse('2026-09-27'));
  assert.strictEqual(onPage.source, 'publish dates on the pages');
});

test('An inline SVG <title> is not a page title', async () => {
  const u = 'https://t.example/towing/';
  const svg = '<svg><title>Phone icon</title><path d="M0 0"/></svg>';
  const SEO = engine({ [u]: { body: page({ title: 'Towing in Columbus | Cap', body: '<h1>Towing in Columbus</h1>' + svg + svg + '<p>' + words(300) + '</p>' }) } });
  const r = await SEO.auditOne(u);
  assert.strictEqual(r.title, 'Towing in Columbus | Cap');
  assert.ok(!r.checks.some(c => c.label === 'Single title tag' && c.status === 'warn'), 'two SVG titles are not extra page titles');
  // no <title> in the head: an SVG title must not stand in for it
  const S2 = engine({ [u]: { body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><main><h1>Towing</h1>' + svg + '<p>' + words(300) + '</p></main></body></html>' } });
  assert.strictEqual(check(await S2.auditOne(u), 'Title tag present').status, 'fail');
});

test('Soft 404: under 25 words (or a not-found title) fails; a short real page does not', () => {
  const { _x } = engine({});
  assert.strictEqual(_x.soft404Check('other', 'Contact | Co', 'Contact us', 40).status, 'pass');
  assert.strictEqual(_x.soft404Check('service', 'Flatbed | Co', 'Flatbed', 12).status, 'fail');
  assert.strictEqual(_x.soft404Check('service', 'Oops! That page can’t be found. | Co', '', 300).status, 'fail');
});
