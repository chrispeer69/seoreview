'use strict';
// Resilient server-side fetching for the audit (/api/proxy, /api/linkcheck, the headless API).
//
// Why: small-business sites that open fine in a browser failed the audit. Measured causes (Sept 2026 Columbus runs):
//   - A hosting WAF answers 403 to a full Chrome User-Agent sent from a non-browser TLS client (the UA and the TLS
//     fingerprint disagree), but serves the page to a plain "Mozilla/5.0" (noebull.com, milexcompleteautocare.com,
//     urbanautorepairs.com). -> one retry with plain headers.
//   - Transient 5xx / 429 / connection resets under the crawl's parallel requests to one small origin, never retried.
//     -> retry with backoff (Retry-After honoured), and at most 2 requests at a time per host with a short gap.
//   - Dead sites reported as a generic "proxy HTTP 502" (the domain no longer resolves, a bad certificate, a 404
//     homepage, a domain that now redirects to a for-sale page). -> each failure carries a plain classification.
// The grading is untouched: this only decides how a page is fetched and how a failure is named.

const PLAIN_HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
const RE_CHALLENGE = /just a moment|cf-chl|challenge-platform|cf-mitigated|enable javascript and cookies|attention required|ddos-guard/i;
// Domain marketplaces / parking: a site that now redirects here has expired or is for sale.
const RE_PARKED_HOST = /(^|\.)(hugedomains|expireddomains|sedo|sedoparking|dan|afternic|parkingcrew|bodis|above|uniregistry|undeveloped|domainmarket|buydomains|namebright|parklogic|domainnamesales|brandbucket|atom)\.(com|net|io)$/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- failure classification ----------
// kind: dns | tls | not_found | server_error | blocked | rate_limited | timeout | network | parked
const LABELS = {
  dns: 'Domain gone - the web address no longer resolves (no DNS record)',
  tls: 'Bad security certificate - the site\'s HTTPS certificate is invalid (browsers warn visitors too)',
  not_found: 'Page not found - the site answers 404 for its homepage',
  server_error: 'Site down - the site\'s own server returns an error',
  blocked: 'Blocked by bot protection - the site refuses automated visits',
  rate_limited: 'Rate-limited - the site asked us to slow down; try again later',
  timeout: 'Timed out - the site did not answer in time',
  network: 'Could not connect to the site',
  parked: 'Domain expired or for sale - the address now redirects to a domain-sale page',
};
function classifyError(e) {
  const c = (e && e.cause) || e || {};
  const code = String(c.code || (e && e.code) || '');
  const msg = String((c && c.message) || (e && e.message) || '');
  if (/ENOTFOUND|EAI_AGAIN|ENODATA|dns failed/i.test(code + ' ' + msg)) return 'dns';
  if (/CERT|SSL|TLS|self.signed|UNABLE_TO_VERIFY|ERR_TLS/i.test(code + ' ' + msg)) return 'tls';
  if ((e && e.name === 'AbortError') || /ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|timeout/i.test(code + ' ' + msg)) return 'timeout';
  return 'network';
}
function classifyStatus(status, body) {
  if (status === 404 || status === 410) return 'not_found';
  if (status === 429) return 'rate_limited';
  if ((status === 403 || status === 503) && RE_CHALLENGE.test(String(body || '').slice(0, 20000))) return 'blocked';
  if (status === 403 || status === 401) return 'blocked';
  if (status >= 500) return 'server_error';
  return null;
}
function describe(kind, detail) { return (LABELS[kind] || 'Fetch failed') + (detail ? ' (' + detail + ')' : ''); }
function isParkedHost(host) { return RE_PARKED_HOST.test(String(host || '').toLowerCase()); }
// Transient: worth another try on the same headers.
const TRANSIENT = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const RETRYABLE_ERR = new Set(['timeout', 'network']);

// ---------- per-host politeness ----------
function makeHostGate(perHost, gapMs) {
  const hosts = new Map(); // host -> { active, waiters: [], last }
  return async function gate(host, fn) {
    let h = hosts.get(host); if (!h) { h = { active: 0, waiters: [], last: 0 }; hosts.set(host, h); }
    if (h.active >= perHost) await new Promise(res => h.waiters.push(res));
    h.active++;
    const wait = h.last + gapMs - Date.now(); if (wait > 0) await sleep(wait);
    h.last = Date.now();
    try { return await fn(); }
    finally { h.active--; const next = h.waiters.shift(); if (next) next(); if (!h.active && !h.waiters.length) hosts.delete(host); }
  };
}

// Wrap guardedFetch(target, opts) -> Response. Same signature; adds per-host limits, retries and a plain-header
// fallback. A thrown error carries e.fetchFailure = { kind, label }. A returned non-OK response is the last answer.
function makeResilientFetch(guardedFetch, BROWSER_HEADERS, o) {
  o = o || {};
  const retries = o.retries != null ? o.retries : 2;
  const backoff = o.backoff || (n => 800 * Math.pow(3, n));          // 0.8s, 2.4s
  const gate = makeHostGate(o.perHost || 2, o.gapMs != null ? o.gapMs : 150);
  const maxRetryAfter = o.maxRetryAfterMs || 15000;
  return async function resilientFetch(target, opts) {
    opts = opts || {};
    let host = ''; try { host = new URL(target).hostname.toLowerCase(); } catch (e) { /* guardedFetch rejects it */ }
    const once = headers => gate(host, () => guardedFetch(target, Object.assign({}, opts, { headers })));
    let headers = opts.headers || BROWSER_HEADERS, triedPlain = false, lastErr = null;
    for (let attempt = 0; attempt <= retries + 1; attempt++) {
      if (opts.signal && opts.signal.aborted) break;
      let r;
      try { r = await once(headers); }
      catch (e) {
        if (e && (e.code === 400 || e.code === 403)) throw e;           // bad url / blocked (private) host: not a site failure
        const kind = (e && e.code === 502 && /dns/i.test(e.message || '')) ? 'dns' : classifyError(e);
        lastErr = Object.assign(e instanceof Error ? e : new Error(String(e)), { fetchFailure: { kind, label: describe(kind) } });
        if (!RETRYABLE_ERR.has(kind) || attempt >= retries) throw lastErr;
        await sleep(backoff(attempt)); continue;
      }
      // A 403 that is not a real challenge page: the UA/TLS mismatch filter. Retry once with plain headers.
      if (r.status === 403 && !triedPlain && headers !== PLAIN_HEADERS) {
        let body = ''; try { body = await r.clone().text(); } catch (e) { /* ignore */ }
        if (!RE_CHALLENGE.test(body.slice(0, 20000))) { triedPlain = true; headers = PLAIN_HEADERS; try { await r.body?.cancel(); } catch (e) { /* ignore */ } continue; }
      }
      if (TRANSIENT.has(r.status) && attempt < retries) {
        let wait = backoff(attempt);
        const ra = r.headers && r.headers.get && r.headers.get('retry-after');
        if (ra) { const s = Number(ra); wait = Number.isFinite(s) ? s * 1000 : Math.max(0, Date.parse(ra) - Date.now()); }
        try { await r.body?.cancel(); } catch (e) { /* ignore */ }
        await sleep(Math.min(Math.max(wait, 200), maxRetryAfter));
        continue;
      }
      return r;
    }
    if (lastErr) throw lastErr;
    throw Object.assign(new Error('fetch aborted'), { name: 'AbortError', fetchFailure: { kind: 'timeout', label: describe('timeout') } });
  };
}

module.exports = { makeResilientFetch, makeHostGate, classifyError, classifyStatus, describe, isParkedHost, PLAIN_HEADERS, LABELS, RE_CHALLENGE };
