'use strict';
// Fetch reliability: retries, the plain-header fallback, per-host limits, failure classification, the root
// resolver (moved / parked / dead sites) and the engine's render fallback. All network is mocked.
const test = require('node:test');
const assert = require('assert');
const { makeResilientFetch, classifyError, classifyStatus, isParkedHost, PLAIN_HEADERS } = require('../fetch-resilient');
const apiV1 = require('../api-v1');
const { engine } = require('./helpers');

const BROWSER = { 'User-Agent': 'Chrome-ish' };
const res = (status, body, headers, url) => { const r = new Response(body == null ? '' : body, { status, headers: headers || {} }); Object.defineProperty(r, 'url', { value: url || '' }); return r; };
const quick = { backoff: () => 5, gapMs: 0 };

test('retries a transient 503, then succeeds', async () => {
  const seen = [];
  const f = makeResilientFetch(async (t, o) => { seen.push(o.headers); return seen.length < 3 ? res(503, 'busy') : res(200, 'ok'); }, BROWSER, quick);
  const r = await f('https://a.test/', {});
  assert.strictEqual(r.status, 200); assert.strictEqual(seen.length, 3);
});

test('honours Retry-After on a 429', async () => {
  let n = 0; const t0 = Date.now();
  const f = makeResilientFetch(async () => (++n === 1 ? res(429, '', { 'retry-after': '1' }) : res(200, 'ok')), BROWSER, quick);
  const r = await f('https://a.test/', {});
  assert.strictEqual(r.status, 200); assert.ok(Date.now() - t0 >= 900, 'waited about a second');
});

test('a 403 that is not a challenge page is retried once with plain headers (the UA/TLS mismatch WAF)', async () => {
  const seen = [];
  const f = makeResilientFetch(async (t, o) => { seen.push(o.headers); return o.headers === PLAIN_HEADERS ? res(200, '<html>ok</html>') : res(403, '<title>403 - Forbidden</title>'); }, BROWSER, quick);
  const r = await f('https://noebull.test/', { headers: BROWSER });
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(seen, [BROWSER, PLAIN_HEADERS]);
});

test('a Cloudflare challenge 403 is returned as is (the engine backs off and renders)', async () => {
  let n = 0;
  const f = makeResilientFetch(async () => { n++; return res(403, '<title>Just a moment...</title><div id="cf-chl-widget">'); }, BROWSER, quick);
  const r = await f('https://cf.test/', {});
  assert.strictEqual(r.status, 403); assert.strictEqual(n, 1);
});

test('a 404 and a dead domain are not retried; failures are classified in plain words', async () => {
  let n = 0;
  const f404 = makeResilientFetch(async () => { n++; return res(404, 'gone'); }, BROWSER, quick);
  assert.strictEqual((await f404('https://a.test/x', {})).status, 404); assert.strictEqual(n, 1);
  let calls = 0;
  const dns = makeResilientFetch(async () => { calls++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, BROWSER, quick);
  await assert.rejects(dns('https://gone.test/', {}), e => e.fetchFailure.kind === 'dns' && /no longer resolves/.test(e.fetchFailure.label));
  assert.strictEqual(calls, 1, 'DNS failure is not retried');
  let resets = 0;
  const reset = makeResilientFetch(async () => { resets++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }, BROWSER, quick);
  await assert.rejects(reset('https://flaky.test/', {}), e => e.fetchFailure.kind === 'network');
  assert.strictEqual(resets, 3, 'connection resets are retried (1 + 2)');
  assert.strictEqual(classifyError({ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }), 'tls');
  assert.strictEqual(classifyError({ name: 'AbortError' }), 'timeout');
  assert.strictEqual(classifyStatus(500, 'err'), 'server_error');
  assert.strictEqual(classifyStatus(404, ''), 'not_found');
  assert.strictEqual(classifyStatus(403, 'Just a moment...'), 'blocked');
  assert.ok(isParkedHost('www.hugedomains.com') && isParkedHost('expireddomains.com') && !isParkedHost('capitaltowing.com'));
});

test('never more than 2 requests at a time to one host', async () => {
  let active = 0, peak = 0;
  const f = makeResilientFetch(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 20)); active--; return res(200, 'ok'); }, BROWSER, quick);
  await Promise.all(Array.from({ length: 8 }, (_, i) => f('https://one.test/p' + i, {})));
  assert.strictEqual(peak, 2);
});

test('the root resolver follows a moved site, names a parked domain and a dead one', async () => {
  const answers = {
    'https://finelineautobody.com/': { status: 200, body: 'x', finalUrl: 'https://www.finelinewow.com/' },
    'https://614auto.com/': { status: 200, body: 'x', finalUrl: 'https://expireddomains.com/domain/614auto.com' },
    'https://capitaltowing.com/': { status: 200, body: 'x', finalUrl: 'https://www.capitaltowing.com/' },
  };
  apiV1._setDeps({ proxyFetch: async t => {
    if (answers[t]) return Object.assign({ challenged: false, failure: null }, answers[t]);
    if (/ossai/.test(t)) throw Object.assign(new Error('fetch failed'), { fetchFailure: { kind: 'dns' } });
    throw Object.assign(new Error('fetch failed'), { fetchFailure: { kind: 'network' } });
  } });
  const moved = await apiV1.resolveRoot('finelineautobody.com');
  assert.strictEqual(moved.root, 'https://www.finelinewow.com'); assert.strictEqual(moved.movedTo, 'www.finelinewow.com');
  const parked = await apiV1.resolveRoot('614auto.com');
  assert.strictEqual(parked.failure, 'parked'); assert.strictEqual(parked.detail, 'expireddomains.com');
  assert.strictEqual((await apiV1.resolveRoot('capitaltowing.com')).root, 'https://www.capitaltowing.com');
  assert.strictEqual((await apiV1.resolveRoot('ossaitowing.com')).failure, 'dns');
});

test('the engine renders a page the proxy could not fetch (403 / 5xx), never a 404 or a dead domain, once per URL', async () => {
  const ROOT = 'https://shop.test';
  const good = '<!doctype html><html lang="en"><head><title>Auto Repair in Columbus | Shop</title></head><body><main>' + 'Brakes and engines. '.repeat(40) + '</main></body></html>';
  let routes = { [ROOT + '/']: { status: 502 }, render: () => good };
  let SEO = engine(routes); SEO._x.setBackoff(5); SEO._x.resetScan();
  assert.strictEqual(await SEO.fetchHtml(ROOT + '/'), good);
  assert.deepStrictEqual(routes.renderCalls, [ROOT + '/']);
  // a 403 that the server already retried with plain headers: rendered too
  routes = { [ROOT + '/a']: { status: 403, body: '<title>403 - Forbidden</title>' }, render: () => good };
  SEO = engine(routes); SEO._x.resetScan();
  assert.strictEqual(await SEO.fetchHtml(ROOT + '/a'), good);
  // dead domain (the server says why): no render, and the reason is in the error
  routes = { [ROOT + '/b']: { status: 502, headers: { 'x-fetch-failure': 'dns' } }, render: () => good };
  SEO = engine(routes); SEO._x.resetScan();
  await assert.rejects(SEO.fetchHtml(ROOT + '/b'), e => /HTTP 502/.test(e.message) && /no longer resolves/.test(e.message));
  assert.ok(!routes.renderCalls, 'dead domains are not rendered');
  // the render budget: once per URL, and capped per scan
  routes = { [ROOT + '/c']: { status: 500 }, [ROOT + '/d']: { status: 500 }, render: () => null };
  SEO = engine(routes); SEO._x.resetScan(); SEO._x.setRenderCap(1);
  await assert.rejects(SEO.fetchHtml(ROOT + '/c')); await assert.rejects(SEO.fetchHtml(ROOT + '/c')); await assert.rejects(SEO.fetchHtml(ROOT + '/d'));
  assert.deepStrictEqual(routes.renderCalls, [ROOT + '/c']);
});
