'use strict';
// "Handle this for me" CTA: on full-crawl, snapshot and both compare reports (top, after the fixes, footer), call/text
// to the assigned rep, the three packages, and a tracked tap per report link.
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const { engine, page, ld, words } = require('./helpers');
const { ctaTap, ctaLinkKey } = require('../cta');

const ROOT = 'https://cta.example';
const biz = { '@context': 'https://schema.org', '@type': 'AutoRepair', name: 'CTA Towing', telephone: '614-555-0100',
  address: { '@type': 'PostalAddress', streetAddress: '1 Main St', addressLocality: 'Columbus', addressRegion: 'OH' } };
const site = () => ({ [ROOT + '/']: { body: page({ title: 'CTA Towing | Columbus', head: ld(biz), body: '<h1>CTA Towing</h1><a href="/towing/">Towing</a><p>' + words(300) + '</p>' }) },
  [ROOT + '/towing/']: { body: page({ title: 'Towing | CTA Towing', head: ld(biz), body: '<h1>Towing</h1><p>' + words(300) + '</p>' }) },
  [ROOT + '/robots.txt']: { body: 'User-agent: *\nAllow: /' } });
const blocks = html => [...html.matchAll(/data-handle-it="(\w+)"/g)].map(m => m[1]);

test('CTA appears top, after the fixes and in the footer of every report type', async () => {
  const SEO = engine(site());
  const crawl = await SEO.crawlSite(ROOT + '/', { max: 5, concurrency: 2 });
  const full = SEO.siteReportHTML(crawl);
  assert.deepStrictEqual(blocks(full), ['top', 'fixes', 'footer']);
  assert.ok(full.indexOf('data-handle-it="fixes"') > full.indexOf('Top 10 fixes') || !/Top 10 fixes/.test(full), 'full block follows the Top 10 fixes');
  const snap = SEO.reportHTML(await SEO.auditOne(ROOT + '/'));
  assert.deepStrictEqual(blocks(snap), ['top', 'fixes', 'footer']);
  assert.deepStrictEqual(blocks(SEO.siteComparisonHTML([crawl, crawl])), ['top', 'fixes', 'footer']);
  const r = await SEO.auditOne(ROOT + '/');
  assert.deepStrictEqual(blocks(SEO.comparisonHTML([{ name: 'A', report: r }, { name: 'B', report: r }])), ['top', 'fixes', 'footer']);
});

test('"What we\'ll do": three packages with names, one-line scope and "from $___" placeholders', async () => {
  const SEO = engine(site());
  const html = SEO.siteReportHTML(await SEO.crawlSite(ROOT + '/', { max: 5, concurrency: 2 }));
  assert.strictEqual(SEO.PACKAGES.length, 3);
  SEO.PACKAGES.forEach(p => { assert.ok(html.includes(p.name), p.name); assert.match(p.price, /^from \$___/); assert.ok(p.scope.length > 20); });
  assert.match(html, /What we’ll do/);
});

test('Assigned rep: default Chris; res.rep = Dustin; call and text links dial that rep', async () => {
  const SEO = engine(site());
  const r = await SEO.auditOne(ROOT + '/');
  const chris = SEO.reportHTML(r);
  assert.match(chris, /href="tel:\+16146337935"/); assert.match(chris, /href="sms:\+16146337935\?&amp;body=Hi%20Chris/);
  r.rep = 'Dustin';
  const dustin = SEO.reportHTML(r);
  assert.match(dustin, /href="tel:\+16142063606"/); assert.match(dustin, /Call <span data-cta-name>Dustin<\/span>/);
  assert.ok(!/tel:\+16146337935"[^>]*data-cta=/.test(dustin), 'no CTA dials the other rep');
});

// Load a rendered report as a real page (scripts on), with a stubbed sendBeacon.
function hosted(html, url) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { url, runScripts: 'dangerously' });
  const sent = [];
  dom.window.navigator.sendBeacon = (u, body) => { sent.push({ u, body: JSON.parse(body) }); return true; };
  return { dom, sent };
}

test('A stored report switches to ?rep=dustin on load (name, phone, tel and sms links)', async () => {
  const SEO = engine(site());
  const html = SEO.siteReportHTML(await SEO.crawlSite(ROOT + '/', { max: 5, concurrency: 2 }));
  const { dom } = hosted(html, 'https://seoreview.example/report/abc?t=tok&rep=dustin');
  const d = dom.window.document;
  const links = [...d.querySelectorAll('a[data-cta]')];
  assert.strictEqual(links.length, 6);
  links.forEach(a => { assert.strictEqual(a.getAttribute('data-cta-rep'), 'Dustin'); assert.match(a.getAttribute('href'), /^(tel|sms):\+16142063606/); });
  assert.match(links.find(a => a.dataset.cta === 'text').getAttribute('href'), /body=Hi%20Dustin/);
  assert.ok([...d.querySelectorAll('[data-cta-name]')].every(s => s.textContent === 'Dustin'));
  assert.ok([...d.querySelectorAll('[data-cta-phone]')].every(s => s.textContent === '614-206-3606'));
});

test('Every tap is beaconed with the report link, kind, placement and rep', async () => {
  const SEO = engine(site());
  const html = SEO.reportHTML(await SEO.auditOne(ROOT + '/'));
  const link = 'https://crmcolumbus.example/r/tok123';
  const { dom, sent } = hosted(html, link);
  const d = dom.window.document;
  d.querySelector('[data-handle-it="fixes"] a[data-cta="text"]').dispatchEvent(new dom.window.MouseEvent('click', { cancelable: true }));
  d.querySelector('[data-handle-it="top"] a[data-cta="call"]').dispatchEvent(new dom.window.MouseEvent('click', { cancelable: true }));
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[0].u, SEO.CTA_TRACK_URL);
  assert.deepStrictEqual(sent.map(s => [s.body.link, s.body.kind, s.body.where, s.body.rep]), [[link, 'text', 'fixes', 'Chris'], [link, 'call', 'top', 'Chris']]);
});

test('Tap validation: http(s) link, known kind/placement only; link key ignores the query', () => {
  assert.deepStrictEqual(ctaTap('{"link":"https://x.example/report/1?t=a","kind":"call","where":"top","rep":"Chris"}'),
    { link: 'https://x.example/report/1?t=a', kind: 'call', where: 'top', rep: 'Chris' });
  assert.strictEqual(ctaTap('{"link":"javascript:alert(1)","kind":"call"}'), null);
  assert.strictEqual(ctaTap('not json'), null);
  assert.strictEqual(ctaTap({ link: 'https://x.example/r/1', kind: 'drop table', where: 'side' }).kind, null);
  assert.strictEqual(ctaLinkKey('https://x.example/r/1?t=secret'), 'x.example/r/1');
});
