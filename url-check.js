'use strict';
// URL status check used by /api/linkcheck (server.js) and the calibration harness: redirects are NOT followed, and
// the result carries what the audit engine needs per URL (status, Location, noindex, canonical, bytes, headers).
// CRMColumbus/server.js keeps an identical copy (separate repo) - change both.
function makeLinkCheck(guardedFetch, BROWSER_HEADERS) {
  return async function linkCheck(target) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await guardedFetch(target, { signal: ctrl.signal, headers: BROWSER_HEADERS, redirect: 'manual' });
      const status = r.status;
      let location = r.headers.get('location') || null;
      if (location) { try { location = new URL(location, target).href; } catch (e) { /* keep raw */ } }
      let noindex = /noindex/i.test(r.headers.get('x-robots-tag') || '');
      let challenged = false, canonical = null;
      const contentType = r.headers.get('content-type') || '';
      const headers = pickHeaders(r.headers);
      let bytes = Number(r.headers.get('content-length')) || null;
      const html = /html|xml/i.test(contentType) || !contentType;
      if ((status === 200 && html) || status === 403 || status === 503) {
        const body = await r.text();
        bytes = bytes || Buffer.byteLength(body);
        const head = body.slice(0, 400000);
        if (status === 200 && /<meta[^>]+name=["']?(robots|googlebot)["']?[^>]*content=["'][^"']*noindex/i.test(head)) noindex = true;
        if (status === 200) { const m = head.match(/<link[^>]+rel=["']?canonical["']?[^>]*>/i); const h = m && m[0].match(/href=["']([^"']+)["']/i); if (h) { try { canonical = new URL(h[1], target).href; } catch (e) { canonical = h[1]; } } }
        challenged = status !== 200 && /just a moment|cf-chl|challenge-platform|cf-mitigated|enable javascript and cookies/i.test(head);
      } else if (status === 200 && !bytes) {
        // Assets without a Content-Length (images, scripts): count the bytes, up to 20 MB.
        const reader = r.body && r.body.getReader ? r.body.getReader() : null; let n = 0;
        if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > 20e6) { try { await reader.cancel(); } catch (e) { /* ignore */ } break; } } }
        bytes = n || null;
      } else { try { await r.body?.cancel(); } catch (e) { /* ignore */ } }
      return { url: target, status, location, noindex, challenged, contentType, bytes, canonical, headers };
    } catch (e) {
      return { url: target, status: 0, location: null, noindex: false, challenged: false, error: (e && e.code) === 403 ? 'blocked host' : 'fetch failed' };
    } finally { clearTimeout(t); }
  };
}
// Response headers worth keeping per URL (hosting / CDN / caching / indexing signals).
const KEEP_HEADERS = ['server', 'x-powered-by', 'cf-ray', 'cf-cache-status', 'x-vercel-id', 'x-nf-request-id', 'x-amz-cf-id', 'x-served-by', 'x-cache',
  'via', 'x-kinsta-cache', 'x-wpe-backend', 'wpe-backend', 'x-litespeed-cache', 'x-sucuri-id', 'x-github-request-id', 'x-wix-request-id', 'x-shopify-stage',
  'x-squarespace-served-by', 'cache-control', 'last-modified', 'x-robots-tag', 'strict-transport-security', 'content-type', 'content-length', 'content-encoding', 'link'];
function pickHeaders(h) { const o = {}; KEEP_HEADERS.forEach(k => { const v = h.get(k); if (v) o[k] = String(v).slice(0, 300); }); return o; }
module.exports = { makeLinkCheck, pickHeaders };
