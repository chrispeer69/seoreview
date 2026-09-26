'use strict';
// Unit tests for the audit engine's scoring rules (node --test test/). Pages are built in memory and fetched
// through a stub, so nothing touches the network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Load seo-engine.js into a jsdom window whose fetch() answers from `routes` (proxy pages, /api/linkcheck).
function engine(routes) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.fetch = async (input, init) => {
    const u = String(input);
    const resp = (status, body, headers) => ({ ok: status >= 200 && status < 300, status, headers: { get: h => (headers || {})[h.toLowerCase()] || null },
      text: async () => body, json: async () => JSON.parse(body) });
    if (u.startsWith('/api/proxy')) {
      const t = new URL(u, 'http://x').searchParams.get('url');
      const r = routes[t];
      return r ? resp(r.status || 200, r.body || '', { 'x-final-url': t }) : resp(404, '');
    }
    if (u === '/api/linkcheck') {
      const urls = JSON.parse(init.body).urls;
      return resp(200, JSON.stringify({ results: urls.map(x => Object.assign({ url: x, status: (routes[x] && routes[x].status) || 404, location: routes[x] && routes[x].location || null, noindex: !!(routes[x] && /noindex/.test(routes[x].body || '')) })) }));
    }
    return resp(502, '');
  };
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'seo-engine.js'), 'utf8'));
  return w.SEO;
}
const page = ({ title = 'Towing in Dublin, OH | Test Co', head = '', body = '', canonical } = {}) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width">`
  + (canonical ? `<link rel="canonical" href="${canonical}">` : '') + head + `</head><body><main>${body}</main></body></html>`;
const ld = o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const check = (r, label) => r.checks.find(c => c.label === label);
// Engine values come from the jsdom realm, so compare structurally via JSON.
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
const words = n => Array.from({ length: n }, (_, i) => 'word' + i).join(' ');

test('AI crawlers: only search/answer bots are scored; training bots are info', () => {
  const SEO = engine({});
  const s = SEO.aiCrawlerStatus('User-agent: GPTBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: *\nAllow: /');
  same(s.blocked, []);
  same(s.trainingBlocked, ['GPTBot', 'CCBot']);
  const all = SEO.aiCrawlerStatus('User-agent: *\nDisallow: /');
  assert.ok(all.blocked.includes('Googlebot') && all.blocked.includes('OAI-SearchBot'));
  const own = SEO.aiCrawlerStatus('User-agent: *\nDisallow: /\n\nUser-agent: PerplexityBot\nAllow: /');
  assert.ok(!own.blocked.includes('PerplexityBot'), 'a bot with its own group follows that group, not *');
});

test('LocalBusiness: subtype with address+telephone+openingHoursSpecification passes; Organization-only warns; missing fields named', async () => {
  const u = 'https://t.example/';
  const full = { '@context': 'https://schema.org', '@type': 'AutoRepair', name: 'T', address: { '@type': 'PostalAddress', streetAddress: '1 Main St' }, telephone: '614-555-0100', openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', dayOfWeek: 'Monday' }] };
  let SEO = engine({ [u]: { body: page({ head: ld(full), body: '<h1>x</h1>' + words(300) }) } });
  assert.strictEqual(check(await SEO.auditOne(u), 'LocalBusiness structured data').status, 'pass');
  SEO = engine({ [u]: { body: page({ head: ld({ '@type': 'Organization', name: 'T' }), body: words(300) }) } });
  assert.strictEqual(check(await SEO.auditOne(u), 'LocalBusiness structured data').status, 'warn');
  SEO = engine({ [u]: { body: page({ head: ld({ '@graph': [{ '@type': 'LocalBusiness', name: 'T', telephone: '1' }] }), body: words(300) }) } });
  const c = check(await SEO.auditOne(u), 'LocalBusiness structured data');
  assert.strictEqual(c.status, 'warn'); assert.match(c.detail, /address/); assert.match(c.detail, /openingHoursSpecification/);
});

test('Review schema: 0 points; warns only when on the business entity', async () => {
  const u = 'https://t.example/';
  const SEO = engine({ [u]: { body: page({ head: ld({ '@type': 'LocalBusiness', name: 'T', aggregateRating: { '@type': 'AggregateRating', ratingValue: 5 } }), body: words(300) }) } });
  const c = check(await SEO.auditOne(u), 'Review / rating schema (stars)');
  assert.strictEqual(c.points, 0); assert.strictEqual(c.status, 'warn');
});

test('llms.txt is info, 0 points', async () => {
  const SEO = engine({ 'https://t.example/robots.txt': { body: 'User-agent: *\nAllow: /' }, 'https://t.example/llms.txt': { body: '# T\n\nA towing company in Columbus.' } });
  const r = { origin: 'https://t.example', checks: [] };
  await SEO.addAux(r);
  const c = check(r, 'llms.txt AI guide file');
  assert.strictEqual(c.points, 0); assert.strictEqual(c.status, 'info');
});

test('Canonical: fails on a redirecting or noindex target, passes on a 200 indexable one', async () => {
  const u = 'https://t.example/a';
  const mk = canonical => engine({ [u]: { body: page({ canonical, body: words(300) }) }, 'https://t.example/r': { status: 301, location: 'https://t.example/a' },
    'https://t.example/n': { status: 200, body: '<meta name="robots" content="noindex">' }, 'https://t.example/ok': { status: 200, body: '<p>ok</p>' } });
  assert.strictEqual(check(await mk('/r').auditOne(u), 'Canonical URL set').status, 'fail');
  assert.strictEqual(check(await mk('/n').auditOne(u), 'Canonical URL set').status, 'fail');
  assert.strictEqual(check(await mk('/ok').auditOne(u), 'Canonical URL set').status, 'pass');
  assert.strictEqual(check(await mk('/a').auditOne(u), 'Canonical URL set').status, 'pass', 'self-canonical on a clean 200');
});

test('Unique content: linear 100->500 words for service pages, exempt for utility pages', async () => {
  const svc = 'https://t.example/services/towing', util = 'https://t.example/privacy-policy';
  const SEO = engine({ [svc]: { body: page({ body: '<p>' + words(300) + '</p>' }) }, [util]: { body: page({ body: '<p>' + words(50) + '</p>' }) } });
  const c = check(await SEO.auditOne(svc), 'Unique content');
  assert.strictEqual(c.points, 25); assert.ok(Math.abs(c.frac - 0.5) < 0.02, 'frac ' + c.frac);
  const u = check(await SEO.auditOne(util), 'Unique content');
  assert.strictEqual(u.status, 'info'); assert.strictEqual(u.points, 0);
});

test('Gates: presence points lowered; no title -10, no HTTPS -20, noindex on a service page -20', async () => {
  const u = 'http://t.example/services/towing';
  const SEO = engine({ [u]: { body: page({ title: '', head: '<meta name="robots" content="noindex">', body: '<p>' + words(600) + '</p>' }) } });
  const r = await SEO.auditOne(u);
  assert.strictEqual(check(r, 'Page is indexable').points, 4);
  assert.strictEqual(check(r, 'Page is indexable').penalty, 20);
  assert.strictEqual(check(r, 'Served over HTTPS').penalty, 20);
  assert.strictEqual(check(r, 'Title tag present').penalty, 10);
  assert.strictEqual(SEO.score(r).penalty, 50);
});

test('Page types from URLs', () => {
  const SEO = engine({});
  const t = u => SEO.classifyPage('https://t.example' + u, []);
  assert.strictEqual(t('/'), 'home');
  assert.strictEqual(t('/service-area/dublin'), 'location');
  assert.strictEqual(t('/towing-dublin-oh'), 'location');
  assert.strictEqual(t('/services/flatbed-towing'), 'service');
  assert.strictEqual(t('/towing/'), 'service');
  assert.strictEqual(t('/quote/ev-tesla'), 'utility');
  assert.strictEqual(t('/privacy-policy/'), 'utility');
  assert.strictEqual(t('/2018/01/10/tire-pressure/'), 'blog');
  assert.strictEqual(t('/category/uncategorized/'), 'archive');
  assert.strictEqual(t('/blog'), 'archive');
  assert.strictEqual(t('/service-areas'), 'hub');
});

test('Local detail and count-claim extraction', () => {
  const SEO = engine({});
  const e = SEO.localEntities('We serve Bridge Park, Tuttle Crossing, I-270 & US-33 near Frantz Road and Exit 17B. Our Service Center is open.');
  ['bridge park', 'tuttle crossing', 'i-270', 'us-33', 'frantz rd', 'exit 17b'].forEach(x => assert.ok(e.includes(x), x + ' in ' + e));
  assert.ok(!e.some(x => /service center/.test(x)), 'generic words are not landmarks');
  same([...SEO.localEntities('Yes. Polaris Fashion Place is off E. Main Street and E. Main St.')].sort(), ['e main st', 'polaris fashion pl']);
  const c = SEO.countClaims('See all 34 Central Ohio service areas. We offer 13 services in Dublin. Open 24 hours.');
  same(c.map(x => [x.kind, x.n]), [['location', 34], ['service', 13]]);
});

test('H1 words run together and SMS labels on tel: links', () => {
  const SEO = engine({});
  const d = new JSDOM('<h1><span>Towing</span><span>Columbus</span></h1><h1>Towing <b>Columbus</b></h1><a href="tel:+16145550100">Text us</a>').window.document;
  const h = d.querySelectorAll('h1');
  assert.strictEqual(SEO.h1Glued(h[0]), 'TowingColumbus');
  assert.strictEqual(SEO.h1Glued(h[1]), null);
  same(SEO.smsLabelTelLinks(d), ['Text us']);
});
