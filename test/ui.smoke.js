'use strict';
// Smoke test of the public scanner page (node test/ui.smoke.js): loads web-analyzer-siteV7.html with the engine in
// jsdom, answers every request from the cached fixtures, and drives the real buttons — homepage snapshot, full-site
// crawl, deep compare — checking the email gate (summary first, full report after an email) and the progress line.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const calls = {};
['columbusroadsidetowing.com', 'broadandjames.com'].forEach(d => {
  Object.assign(calls, JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', d + '.json.gz'))).toString('utf8')).calls);
});
const resp = (status, body, headers) => ({ ok: status >= 200 && status < 300, status, headers: { get: h => (headers || {})[String(h).toLowerCase()] || null },
  text: async () => body, json: async () => JSON.parse(body) });

function load() {
  const engine = fs.readFileSync(path.join(ROOT, 'seo-engine.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const html = fs.readFileSync(path.join(ROOT, 'web-analyzer-siteV7.html'), 'utf8').replace('<script src="seo-engine.js"></script>', () => '<script>' + engine + '</script>');
  const errors = []; const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(String(e && e.message || e)));
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/web-analyzer-siteV7.html',
    beforeParse(w) {
      w.alert = () => {}; w.confirm = () => true; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = function () {};
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.fetch = async (input, init) => {
        const u = String(input); init = init || {};
        if (u.startsWith('/api/proxy')) { const t = new URL(u, 'http://x').searchParams.get('url'); const c = calls['proxy:' + t];
          return c ? resp(c.status, c.body, { 'x-final-url': c.finalUrl || t }) : resp(502, ''); }
        if (u === '/api/linkcheck') { const urls = JSON.parse(init.body).urls; return resp(200, JSON.stringify({ results: urls.map(x => Object.assign({ url: x }, calls['check:' + x] || { status: 0 })) })); }
        if (u === '/api/lead') return resp(200, JSON.stringify({ ok: true, emailed: false }));
        if (u.startsWith('/api/config')) return resp(200, JSON.stringify({ teamEnabled: false, user: null }));
        if (u.startsWith('/api/')) return resp(404, '{}');
        return resp(502, '');
      };
    } });
  return { w: dom.window, errors };
}
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 60000)) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
const $ = (w, id) => w.document.getElementById(id);

(async () => {
  // 1) Homepage snapshot: banner + sitemap line + top 3 issues, full report locked until an email is given.
  let { w, errors } = load();
  await new Promise(r => setTimeout(r, 100));
  $(w, 'urls').value = 'https://broadandjames.com/'; $(w, 'psiOn').checked = false;
  const progressSeen = [];
  const obs = new w.MutationObserver(() => { const t = $(w, 'progress').textContent; if (t) progressSeen.push(t); }); obs.observe($(w, 'progress'), { childList: true, subtree: true });
  w.runScan();
  assert.ok(await until(() => !w.eval('scanning')), 'snapshot finished');
  const res = $(w, 'results').textContent;
  assert.match(res, /Homepage snapshot — full-site audit available/);
  assert.match(res, /Top 3 issues/);
  assert.match(res, /Sitemap: \d+ pages/);
  assert.strictEqual($(w, 'leadBox').style.display, 'block', 'email gate shown');
  assert.strictEqual($(w, 'actionRow').style.display, 'none', 'full report locked');
  assert.ok(progressSeen.some(t => /Site 1 of 1/.test(t) && /Estimated time/.test(t)), 'progress + estimate: ' + progressSeen[0]);
  assert.match($(w, 'leadBox').textContent, /Email me the full report/);
  $(w, 'leadEmail').value = 'owner@example.com'; await w.submitLead();
  assert.strictEqual($(w, 'leadBox').style.display, 'none', 'gate gone after email');
  assert.strictEqual($(w, 'actionRow').style.display, 'flex', 'full report unlocked');
  assert.match($(w, 'results').textContent, /What's working/);
  w.openReport();
  assert.match($(w, 'printArea').textContent, /Homepage snapshot — full-site audit available/);
  const aiBits = $(w, 'printArea').textContent.match(/AI Search[^%]{0,40}%/g) || []; console.log('  AI mentions:', aiBits.map(x => x.slice(-30)));
  assert.ok(!aiBits.some(x => /100%$/.test(x)), 'AI Search never 100');
  console.log('snapshot: OK', errors.length ? errors : '');

  // 2) Full-site crawl of the first site (+ snapshot of the second), locked -> summary with top 3 issues.
  ({ w, errors } = load()); await new Promise(r => setTimeout(r, 100));
  w.sessionStorage.clear();
  $(w, 'urls').value = 'https://broadandjames.com\nhttps://www.columbusroadsidetowing.com/'; $(w, 'psiOn').checked = false;
  assert.match($(w, 'crawlBtn').textContent, /Full-site crawl \(first site only\)/);
  const seen2 = []; new w.MutationObserver(() => seen2.push($(w, 'progress').textContent)).observe($(w, 'progress'), { childList: true, subtree: true });
  w.runCrawl();
  assert.ok(await until(() => !w.eval('scanning'), 120000), 'crawl finished');
  assert.match($(w, 'siteResults').textContent, /Full-site crawl · \d+ pages audited/);
  assert.match($(w, 'siteResults').textContent, /Top issues/);
  assert.match($(w, 'results').textContent, /Homepage snapshot/, 'second site got a snapshot');
  assert.ok(seen2.some(t => /crawling pages \(\d+\/\d+\)/.test(t)) && seen2.some(t => /checking links/.test(t)), 'crawl steps shown');
  $(w, 'leadEmail').value = 'owner@example.com'; await w.submitLead();
  assert.match($(w, 'siteResults').textContent, /Link health/, 'full crawl report after email');
  console.log('full-site crawl: OK', errors.length ? errors : '');

  // 3) Compare: PageSpeed defaults on; deep compare crawls every site and ranks them, engine stated per row.
  ({ w, errors } = load()); await new Promise(r => setTimeout(r, 100));
  $(w, 'psiOn').checked = false; $(w, 'compareOn').checked = true; w.onCompareChange();
  assert.strictEqual($(w, 'psiOn').checked, true, 'PageSpeed on in compare mode');
  $(w, 'psiOn').checked = false;
  $(w, 'urls').value = 'https://broadandjames.com\nhttps://www.columbusroadsidetowing.com';
  w.runScan();
  assert.ok(await until(() => !w.eval('scanning'), 180000), 'deep compare finished');
  assert.match($(w, 'siteResults').textContent, /Full-site comparison — 2 sites ranked/);
  console.log('deep compare: OK', errors.length ? errors : '');

  // 4) Snapshot compare states the engine per row and shows the sitemap columns.
  ({ w, errors } = load()); await new Promise(r => setTimeout(r, 100));
  w.eval("leadUnlocked=true");
  $(w, 'compareOn').checked = true; w.onCompareChange(); $(w, 'deepOn').checked = false; $(w, 'psiOn').checked = false;
  $(w, 'urls').value = 'https://broadandjames.com/\nhttps://www.columbusroadsidetowing.com/';
  w.runScan();
  assert.ok(await until(() => !w.eval('scanning'), 120000), 'snapshot compare finished');
  w.openReport();
  const pa = $(w, 'printArea').textContent;
  assert.match(pa, /Pages \(sitemap\)/); assert.match(pa, /Homepage snapshot/);
  console.log('snapshot compare: OK', errors.length ? errors : '');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
