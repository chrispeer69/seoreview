'use strict';
// Headless runner for the public tool's audit engine.
//
// The SEO / AI-search engine lives inside web-analyzer-siteV7.html and runs in the browser. To let other
// systems request audits over an API, this module loads that same page into jsdom on the server, swaps the
// page's fetch() for a shim that routes /api/proxy, /api/render and /api/places to in-process helpers, and
// calls the page's own crawlSite() / siteReportHTML(). One engine, one set of results — no second copy.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = path.join(__dirname, 'web-analyzer-siteV7.html');
let cached = null;
function pageSource() {
  if (!cached) {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
    cached = { html, css };
  }
  return cached;
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Minimal Response look-alikes — the engine only uses ok / status / headers.get / text() / json().
function textResponse(status, body, headers) {
  headers = headers || {};
  return { ok: status >= 200 && status < 300, status, headers: { get(h) { return headers[String(h).toLowerCase()] || null; } },
    text: async () => body, json: async () => JSON.parse(body) };
}
function jsonResponse(status, obj) { const body = JSON.stringify(obj); const r = textResponse(status, body); r.json = async () => obj; return r; }

// jsdom's AbortSignal is a different class than Node's; undici rejects it. Bridge abort events across.
function bridgeSignal(sig) {
  if (!sig) return undefined;
  const ac = new AbortController();
  if (sig.aborted) ac.abort(); else sig.addEventListener('abort', () => ac.abort(), { once: true });
  return ac.signal;
}

function makeFetch(deps) {
  return async function shimFetch(input, init) {
    const u = String(input); init = init || {};
    const signal = bridgeSignal(init.signal);
    if (u.startsWith('/')) {
      let rel; try { rel = new URL(u, 'http://internal.local'); } catch (e) { return textResponse(400, ''); }
      const p = rel.pathname;
      if (p === '/api/proxy') {
        const target = rel.searchParams.get('url');
        if (!target) return textResponse(400, 'missing url');
        try {
          const r = await deps.proxyFetch(target, signal);
          if (r.challenged) return textResponse(502, r.body, { 'x-proxy-reason': 'bot-protection' });
          return textResponse(r.status, r.body);
        } catch (e) { return textResponse((e && e.code) || 502, ''); }
      }
      if (p === '/api/render') {
        const target = rel.searchParams.get('url');
        try { const r = await deps.renderFetch(target); return r && r.ok ? textResponse(200, r.body) : textResponse(502, ''); }
        catch (e) { return textResponse((e && e.code) || 502, ''); }
      }
      if (p === '/api/places') {
        const q = rel.searchParams.get('q') || rel.searchParams.get('name') || '';
        if (!q) return jsonResponse(400, { error: 'q_required' });
        try { return jsonResponse(200, await deps.placesLookup(q)); } catch (e) { return jsonResponse(502, { error: 'places_failed' }); }
      }
      if (p === '/api/config') return jsonResponse(200, { teamEnabled: false, placesEnabled: false, geocodeEnabled: false, emailEnabled: false, stripeEnabled: false, crmEnabled: false, renderEnabled: false, user: null });
      return jsonResponse(404, { error: 'not_found' });
    }
    // Absolute URLs. The page's public CORS-proxy fallbacks are skipped on the server (our own proxy already
    // fetched the page directly — a third-party proxy would not do better and adds a dependency).
    if (/allorigins\.win|corsproxy\.io|corsfix\.com/i.test(u)) return textResponse(502, '');
    try { const r = await fetch(u, { signal }); return textResponse(r.status, await r.text()); }
    catch (e) { return textResponse(502, ''); }
  };
}

function createWindow(deps) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { errors.push(String((e && e.message) || e)); });
  const dom = new JSDOM(pageSource().html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    url: 'http://localhost/web-analyzer-siteV7.html',
    beforeParse(w) {
      w.fetch = makeFetch(deps);
      w.alert = () => {}; w.confirm = () => true; w.prompt = () => null; w.scrollTo = () => {};
      w.open = () => ({ document: { write() {}, close() {} } });
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.HTMLElement.prototype.scrollIntoView = function () {};
      if (!w.TextEncoder) w.TextEncoder = TextEncoder;
      if (!w.TextDecoder) w.TextDecoder = TextDecoder;
      w.BCAI_PSI_KEY = '';
    },
  });
  return { dom, errors };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Crawl + grade a whole site with the page's own crawlSite(). Returns { result, html } where result is a plain
// JSON clone of the engine's crawl result and html is the branded siteReportHTML() body.
async function crawlSite(deps, root, opts) {
  opts = opts || {};
  const { dom, errors } = createWindow(deps);
  const w = dom.window;
  try {
    await sleep(100); // let the page's boot scripts settle
    if (typeof w.crawlSite !== 'function' || typeof w.siteReportHTML !== 'function') {
      throw new Error('audit engine did not load' + (errors.length ? ' — ' + errors[0] : ''));
    }
    const res = await w.crawlSite(root, {
      max: opts.maxPages || 100,
      concurrency: opts.concurrency || 4,
      render: deps.renderEnabled ? (u => w.fetch('/api/render?url=' + encodeURIComponent(u)).then(r => (r.ok ? r.text() : null)).catch(() => null)) : null,
      places: deps.placesEnabled ? (q => w.fetch('/api/places?q=' + encodeURIComponent(q)).then(r => (r.ok ? r.json() : null)).catch(() => null)) : null,
      onProgress: opts.onProgress || function () {},
    });
    if (!res || res.error) return { result: res || { error: 'crawl returned nothing' }, html: null };
    const html = w.siteReportHTML(res);
    // Site-level checks the single-page audit adds (robots.txt, sitemap, AI-crawler access, llms.txt). The
    // crawl skips them per page; run them once for the site on a scratch record so site scoring is unchanged.
    let siteChecks = [];
    try {
      const home = (res.pages || []).find(p => !p.error && p.origin) || null;
      if (home && typeof w.addAux === 'function') { const scratch = { origin: home.origin, checks: [] }; await w.addAux(scratch); siteChecks = scratch.checks; }
    } catch (e) { /* best effort */ }
    const result = JSON.parse(JSON.stringify(res));
    result.siteChecks = JSON.parse(JSON.stringify(siteChecks));
    return { result, html, engineErrors: errors.slice(0, 5) };
  } finally {
    try { w.close(); } catch (e) {}
  }
}

// The public tool's "Run Audit" on one URL (the homepage): the page's own auditOne() + addAux() (robots.txt,
// sitemap, AI-crawler access, llms.txt) + addSpeed() (PageSpeed mobile + desktop) and the single-site branded
// renderReport(). Same score and same report the browser gives for that page.
async function auditPage(deps, url, opts) {
  opts = opts || {};
  const { dom, errors } = createWindow(deps);
  const w = dom.window;
  try {
    await sleep(100);
    if (typeof w.auditOne !== 'function' || typeof w.renderReport !== 'function') {
      throw new Error('audit engine did not load' + (errors.length ? ' — ' + errors[0] : ''));
    }
    const render = deps.renderEnabled ? (u => w.fetch('/api/render?url=' + encodeURIComponent(u)).then(r => (r.ok ? r.text() : null)).catch(() => null)) : null;
    let r;
    try { r = await w.auditOne(url); }
    catch (e1) {                                   // one retry, then the rendered page - as the crawl does
      try { r = await w.auditOne(url); }
      catch (e2) {
        const html = render ? await render(url) : null;
        if (!html) throw new Error((e2 && e2.reason) || (e2 && e2.message) || 'page could not be fetched');
        r = await w.auditOne(url, html); r._rendered = true;
      }
    }
    if (r.jsShell && render) { try { const html = await render(url); if (html) { r = await w.auditOne(url, html); r._rendered = true; } } catch (e) {} }
    try { await w.addAux(r); } catch (e) { /* best effort, as in the tool */ }
    if (opts.speed) { try { await w.addSpeed(r, opts.psiKey || ''); } catch (e) {} }
    r._score = w.score(r);
    w.__pageResult = r;
    w.eval('reports=[window.__pageResult]');       // the page's own top-level `let reports`
    w.renderReport();
    const html = w.document.getElementById('printArea').innerHTML;
    return { result: JSON.parse(JSON.stringify(r)), html, engineErrors: errors.slice(0, 5) };
  } finally {
    try { w.close(); } catch (e) {}
  }
}

// Wrap a report body in a standalone page using the public tool's own stylesheet.
function reportPage({ bodyHtml, title, subtitle }) {
  const css = pageSource().css;
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><title>' + esc(title) + '</title>'
    + '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">'
    + '<style>' + css + '</style><style>#reportView{display:block}</style></head><body>'
    + '<div id="reportView"><div class="toolbar no-print"><div><b>' + esc(title) + '</b>' + (subtitle ? ' <span style="color:#64748b;font-size:13px">' + esc(subtitle) + '</span>' : '') + '</div>'
    + '<button class="btnPrint" onclick="window.print()">Print / Save as PDF</button></div>'
    + '<div class="docPad"><div class="printArea">' + bodyHtml + '</div></div></div></body></html>';
}

module.exports = { crawlSite, auditPage, reportPage };
