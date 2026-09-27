'use strict';
// Shared test helpers: load seo-engine.js into jsdom with a fetch() answering from an in-memory route table.
//   routes[url] = { status, body, headers, seq:[{status,body,headers}…], location, canonical, bytes, contentType }
//   (pages via /api/proxy, statuses via /api/linkcheck), routes.render = url => html|null for /api/render (ScrapingBee),
//   routes.psi = url => json string, routes.config = { towing: {...} } for /config/industries.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

function engine(routes) {
  routes = routes || {};
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  const resp = (status, body, headers) => ({ ok: status >= 200 && status < 300, status, headers: { get: h => (headers || {})[h.toLowerCase()] || null },
    text: async () => body, json: async () => JSON.parse(body) });
  w.fetch = async (input, init) => {
    const u = String(input);
    if (u.startsWith('/api/proxy')) {
      const t = new URL(u, 'http://x').searchParams.get('url'); const r = routes[t];
      if (r && r.delays && r.delays.length) await new Promise(res => setTimeout(res, r.delays.shift())); // per-call latency
      if (r && r.seq) { const x = r.seq.length > 1 ? r.seq.shift() : r.seq[0]; return resp(x.status || 200, x.body || '', Object.assign({ 'x-final-url': t }, x.headers || {})); } // per-call answers
      return r && (r.status || 200) === 200 ? resp(200, r.body || '', Object.assign({ 'x-final-url': t }, r.headers || {})) : resp((r && r.status) || 404, (r && r.body) || '', (r && r.headers) || {});
    }
    if (u === '/api/linkcheck') {
      const urls = JSON.parse(init.body).urls;
      return resp(200, JSON.stringify({ results: urls.map(x => { const r = routes[x];
        if (!r) return { url: x, status: 404 };
        const body = r.body || '';
        const canon = (body.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1];
        return { url: x, status: r.status || 200, location: r.location || null, noindex: /noindex/.test(body), bytes: r.bytes || body.length || null,
          contentType: r.contentType || 'text/html', canonical: r.canonical || (canon ? new URL(canon, x).href : null) }; }) }));
    }
    if (u.startsWith('/config/industries/')) {
      const name = u.split('/').pop().replace(/\.json$/, '');
      const cfg = (routes.config || {})[name] || (name === 'towing' ? JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'industries', 'towing.json'), 'utf8')) : null);
      return cfg ? resp(200, JSON.stringify(cfg)) : resp(404, '{}');
    }
    if (u.startsWith('/api/render')) { const t = new URL(u, 'http://x').searchParams.get('url'); (routes.renderCalls = routes.renderCalls || []).push(t);
      const h = routes.render && routes.render(t); return h ? resp(200, h) : resp(502, ''); }
    if (/pagespeedonline/.test(u) && routes.psi) return resp(200, routes.psi(u));
    return resp(502, '');
  };
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'seo-engine.js'), 'utf8'));
  return w.SEO;
}
const page = ({ title = 'Towing in Dublin, OH | Test Co', head = '', body = '', canonical, lang = 'en' } = {}) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width">`
  + (canonical ? `<link rel="canonical" href="${canonical}">` : '') + head + `</head><body><main>${body}</main></body></html>`;
const ld = o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const check = (r, label) => r.checks.find(c => c.label === label);
const words = n => Array.from({ length: n }, (_, i) => 'word' + i).join(' ');
// Engine values come from the jsdom realm, so compare structurally via JSON.
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
const doc = html => new JSDOM(html).window.document;
module.exports = { engine, page, ld, check, words, same, doc };
