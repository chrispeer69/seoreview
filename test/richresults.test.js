'use strict';
// Rich results eligibility: Google's published required/recommended properties per rich-result type, the same rules its
// Rich Results Test applies (it has no public API). Required missing = invalid (fail); recommended missing = warning.
const test = require('node:test');
const assert = require('node:assert');
const { engine, page, ld, check, words } = require('./helpers');

const U = 'https://t.example/towing/';
const rr = (SEO, nodes) => SEO._x.richResultsCheck(nodes, U);

test('Valid local business + breadcrumb pass, with recommended fields listed as warnings', () => {
  const SEO = engine({});
  const r = rr(SEO, [
    { '@type': 'AutoRepair', name: 'Cap Towing', address: { '@type': 'PostalAddress', streetAddress: '1 Main St', addressLocality: 'Columbus' }, telephone: '614-555-0100' },
    { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: 'https://t.example/' }, { '@type': 'ListItem', position: 2, name: 'Towing' }] },
  ]);
  assert.strictEqual(r.status, 'pass', r.detail);
  assert.match(r.detail, /Local business, Breadcrumb eligible/);
  const lb = r.evidence.find(e => /^Local business/.test(e.snippet)).snippet;
  assert.match(lb, /valid · warnings: .*geo \(recommended\)/);
  assert.match(lb, /address\.postalCode \(recommended\)|openingHoursSpecification \(recommended\)/);
  assert.match(r.evidence[r.evidence.length - 1].snippet, /search\.google\.com\/test\/rich-results\?url=https%3A%2F%2Ft\.example%2Ftowing%2F/);
});

test('A missing required property makes the item invalid (fail) and names the property', () => {
  const SEO = engine({});
  const r = rr(SEO, [{ '@type': 'LocalBusiness', name: 'Cap Towing', telephone: '1' },
    { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', name: 'Home', item: 'https://t.example/' }, { '@type': 'ListItem', position: 2, name: 'Towing' }] }]);
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(r.problem, 'Invalid rich-result markup: Local business, Breadcrumb');
  assert.match(r.detail, /Local business \(address missing\)/);
  assert.match(r.detail, /ListItem 1 has no position/);
  assert.match(r.fix, /address missing/);
});

test('@id references are followed (Yoast-style graph)', () => {
  const SEO = engine({});
  const r = rr(SEO, [
    { '@type': 'AutoRepair', '@id': 'https://t.example/#biz', name: 'Cap', address: { '@id': 'https://t.example/#addr' } },
    { '@type': 'PostalAddress', '@id': 'https://t.example/#addr', streetAddress: '1 Main St', addressLocality: 'Columbus', addressRegion: 'OH', postalCode: '43215', addressCountry: 'US' },
  ]);
  assert.strictEqual(r.status, 'pass', r.detail);
  assert.ok(!/address\.postalCode/.test(JSON.stringify(r.evidence)));
});

test('Self-serving business stars are not eligible; retired features and FAQ limits are noted, not penalised', () => {
  const SEO = engine({});
  const biz = { '@type': 'LocalBusiness', name: 'Cap', address: { '@type': 'PostalAddress', streetAddress: '1 Main' }, aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.9, reviewCount: 120 } };
  const nodes = [biz, biz.aggregateRating, { '@type': 'HowTo', name: 'x' }, { '@type': 'SearchAction', target: 'x' },
    { '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } }] }];
  const r = rr(SEO, nodes);
  assert.strictEqual(r.status, 'pass', r.detail);
  const ev = r.evidence.map(e => e.snippet).join('\n');
  assert.match(ev, /Review snippet: not eligible - rating is on the business itself/);
  assert.match(ev, /How-to: Google stopped showing/);
  assert.match(ev, /Sitelinks search box: Google retired/);
  assert.match(ev, /FAQ \(FAQPage\): valid .*government and health sites/);
  // only retired/ineligible items: informational, 0 points
  const only = rr(SEO, [{ '@type': 'HowTo', name: 'x' }]);
  assert.strictEqual(only.status, 'info'); assert.strictEqual(only.points, 0);
});

test('Job posting and event requirements', () => {
  const SEO = engine({});
  const job = rr(SEO, [{ '@type': 'JobPosting', title: 'Tow driver', description: 'Drive', datePosted: '2026-09-01', hiringOrganization: { '@type': 'Organization', name: 'Cap' } }]);
  assert.strictEqual(job.status, 'fail'); assert.match(job.detail, /jobLocation missing/);
  const ev = rr(SEO, [{ '@type': 'Event', name: 'Car show', startDate: '2026-10-01', location: { '@type': 'Place', name: 'Lot' } }]);
  assert.strictEqual(ev.status, 'pass', ev.detail);
});

test('Wired into the page audit; no rich-result types = N/A', async () => {
  const biz = { '@context': 'https://schema.org', '@type': 'AutoRepair', name: 'Cap' };
  const SEO = engine({ [U]: { body: page({ head: ld(biz), body: '<h1>Towing</h1>' + words(300) }) } });
  const c = check(await SEO.auditOne(U), 'Rich results eligible');
  assert.strictEqual(c.status, 'fail'); assert.match(c.detail, /address missing/);
  const S2 = engine({ [U]: { body: page({ head: ld({ '@context': 'https://schema.org', '@type': 'WebPage', name: 'x' }), body: words(300) }) } });
  assert.strictEqual(check(await S2.auditOne(U), 'Rich results eligible').status, 'na');
});
