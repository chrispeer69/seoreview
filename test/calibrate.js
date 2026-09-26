'use strict';
// Calibration run of the audit engine against cached real sites (test/fixtures/<domain>.json.gz).
//
//   node test/calibrate.js              replay the fixtures offline and check each site's score is in its target band
//   node test/calibrate.js --record     fetch the sites live (and PageSpeed), then rewrite the fixtures
//   node test/calibrate.js --verbose    also print the per-page scores and site-wide findings
//
// Replay is deterministic: every network call the engine makes (pages, robots/sitemaps, link checks, PageSpeed) is
// answered from the fixture; a request the fixture doesn't hold is answered as a network failure and counted.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const headless = require('../headless-audit');

const SITES = [
  // Site bands, plus page bands for pages whose score is a known reference point.
  { domain: 'columbusroadsidetowing.com', root: 'https://www.columbusroadsidetowing.com', target: [88, 95], industry: 'towing',
    pages: { '/service-area/whitehall': [60, 80], '/service-area/lewis-center': [90, 100] } },
  { domain: 'broadandjames.com', root: 'https://broadandjames.com', target: [45, 65], industry: 'towing' },
];
const RECORD = process.argv.includes('--record');
// --record-missing: replay the fixture, fetch live only what it lacks (new checks), and add that to the fixture.
// --refresh-checks: re-fetch every URL status check (e.g. after linkcheck starts returning more fields).
const RECORD_MISSING = process.argv.includes('--record-missing');
const REFRESH_CHECKS = process.argv.includes('--refresh-checks');
const { makeLinkCheck } = require('../url-check');
const liveLinkCheck = makeLinkCheck((u, o) => fetch(u, o), HEADERS_FOR_CHECKS());
const VERBOSE = process.argv.includes('--verbose');
// Fixtures are pinned to the day they were recorded so freshness math does not drift as real time passes.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const fixturePath = d => path.join(__dirname, 'fixtures', d + '.json.gz');
const load = d => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(fixturePath(d))).toString('utf8')); } catch (e) { return null; } };
const save = (d, fx) => fs.writeFileSync(fixturePath(d), zlib.gzipSync(JSON.stringify(fx), { level: 9 }));
const psiKey = () => { try { return (fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8').match(/'(AIza[^']+)'/) || [])[1] || ''; } catch (e) { return ''; } };
const stripKey = u => String(u).replace(/([?&])key=[^&]*/, '$1key=_');

// Keep only what fetchPSI() reads from a PageSpeed response (the full one is ~0.5 MB).
function trimPsi(body) {
  try {
    const j = JSON.parse(body); const lh = j.lighthouseResult; if (!lh) return body;
    const keep = ['largest-contentful-paint', 'cumulative-layout-shift', 'total-blocking-time'];
    const audits = {}; keep.forEach(k => { if (lh.audits && lh.audits[k]) audits[k] = { numericValue: lh.audits[k].numericValue, displayValue: lh.audits[k].displayValue }; });
    return JSON.stringify({ lighthouseResult: { categories: { performance: lh.categories && lh.categories.performance }, audits },
      loadingExperience: j.loadingExperience ? { overall_category: j.loadingExperience.overall_category } : undefined });
  } catch (e) { return body; }
}

async function liveGet(u, redirect) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(u, { headers: HEADERS, redirect: redirect || 'follow', signal: ctrl.signal });
    return { status: r.status, body: await r.text(), finalUrl: r.url || u, location: r.headers.get('location') || null, xRobots: r.headers.get('x-robots-tag') || null };
  } finally { clearTimeout(t); }
}

function HEADERS_FOR_CHECKS() { return { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }; }
function makeDeps(fx) {
  const misses = [];
  fx.dirty = false;
  const get = async (key, live) => {
    const refresh = REFRESH_CHECKS && key.startsWith('check:') && !(fx.refreshed || (fx.refreshed = new Set())).has(key);
    if (RECORD || refresh || (RECORD_MISSING && !(key in fx.calls))) { const v = await live(); fx.calls[key] = v; fx.dirty = true; if (refresh) fx.refreshed.add(key); return v; }
    if (key in fx.calls) return fx.calls[key];
    misses.push(key); throw Object.assign(new Error('not in fixture'), { code: 502 });
  };
  const deps = {
    renderEnabled: false, placesEnabled: false,
    proxyFetch: (target) => get('proxy:' + target, async () => { const r = await liveGet(target); return { status: r.status, body: r.body, finalUrl: r.finalUrl, challenged: false }; }),
    linkCheck: (target) => get('check:' + target, () => liveLinkCheck(target)),
    directFetch: (u) => get('direct:' + stripKey(u), async () => { const r = await liveGet(u); return { status: r.status, body: trimPsi(r.body) }; }),
    renderFetch: async () => { throw Object.assign(new Error('render off'), { code: 503 }); },
    placesLookup: async () => null,
  };
  return { deps, misses };
}

(async () => {
  let failed = 0;
  for (const site of SITES) {
    let fx = RECORD ? null : load(site.domain);
    if (!fx && !RECORD) { console.log(`${site.domain}: no fixture — run with --record first`); failed++; continue; }
    if (RECORD) fx = { domain: site.domain, recorded: new Date().toISOString(), calls: {} };
    const { deps, misses } = makeDeps(fx);
    const t0 = Date.now();
    const out = await headless.crawlSite(deps, site.root, { maxPages: 150, concurrency: 4, psiKey: psiKey(), now: fx.recorded, industry: site.industry || 'general' });
    if (fx.dirty) { delete fx.dirty; delete fx.refreshed; save(site.domain, fx); console.log(`  (fixture updated: ${Object.keys(fx.calls).length} calls)`); }
    const res = out.result || {};
    if (res.error) { console.log(`${site.domain}: crawl error — ${res.error}`); failed++; continue; }
    const s = res.siteScore; const b = res.siteBreakdown || null;
    const inBand = site.target ? (s >= site.target[0] && s <= site.target[1]) : null;
    if (inBand === false) failed++;
    console.log(`\n${site.domain}: site score ${s}${site.target ? ` (target ${site.target[0]}–${site.target[1]}: ${inBand ? 'OK' : 'OUT OF BAND'})` : ' (no target set)'}`
      + ` · ${(res.pages || []).filter(p => !p.error).length} pages · ${((Date.now() - t0) / 1000).toFixed(1)}s${misses.length ? ` · ${misses.length} fixture misses` : ''}`);
    if (b) {
      const t = b.technical || {}, f = b.freshness || {}, l = b.linkHealth || {}, c = b.coverage || {}, d = b.duplication || {};
      console.log(`  pages ${b.pageAverage} | site level ${b.siteLevel} = coverage ${c.score} (${c.service} svc/${c.location} loc) · freshness ${f.score} (${f.newest || 'n/a'}) · links ${l.score} (${l.broken} broken/${l.redirects} redirects/${l.orphans} orphans) · duplication ${d.score} · technical ${t.score} ${JSON.stringify(t.parts || {})}`);
      console.log(`  penalties: ${(b.penalties || []).map(x => '-' + x.points + ' ' + x.reason).join('; ') || 'none'} | caps: ${(b.caps || []).map(x => x.max + ' ' + x.reason).join('; ') || 'none'} | AI Search ${b.aiSearch}`);
    }
    Object.keys(site.pages || {}).forEach(pth => {
      const [lo, hi] = site.pages[pth];
      const pg = (res.pages || []).find(p => !p.error && p.url.replace(res.root, '') === pth);
      const sc = pg && pg._score ? pg._score.score : null;
      const okp = sc != null && sc >= lo && sc <= hi; if (!okp) failed++;
      console.log(`  page ${pth}: ${sc == null ? 'not crawled' : sc} (target ${lo}–${hi}: ${okp ? 'OK' : 'OUT OF BAND'})`);
    });
    // The API summary and the branded report must build from this result.
    const api = require('../api-v1').summarize(res);
    if (api.score !== s) { console.log(`  API score ${api.score} != engine ${s}`); failed++; }
    if (!out.html || out.html.length < 5000 || !/Link health/.test(out.html)) { console.log('  report HTML missing or incomplete'); failed++; }
    if (process.argv.includes('--html')) fs.writeFileSync(path.join(require('os').tmpdir(), site.domain + '-report.html'), '<meta charset="utf-8">' + out.html);
    if (process.argv.includes('--evidence')) (res.siteFindings || []).filter(f => f.status === 'fail' || f.status === 'warn').forEach(f => console.log('    evidence: ' + f.label + ' => ' + JSON.stringify(f.evidence).slice(0, 600)));
    if (VERBOSE) (res.siteFindings || []).forEach(f => console.log(`    finding ${f.status.padEnd(4)} ${String(f.points).padStart(2)} [${f.component}] ${f.label} — ${String(f.detail || '').slice(0, 120)}${(f.evidence || [])[0] ? ' | ' + String(f.evidence[0].snippet || '').slice(0, 110) : ''}`));
    if (VERBOSE) console.log('  API top issues: ' + api.top_issues.map(x => x.code + '(' + x.severity + ')').join(', '));
    if (out.engineErrors && out.engineErrors.length) console.log('  engine errors:', out.engineErrors);
    if (VERBOSE) {
      const want = (process.argv.find(a => a.startsWith('--page=')) || '').slice(7);
      const home = (res.pages || []).find(p => !p.error && (want ? p.url.replace(res.root, '') === want : (p.url === res.root + '/' || p.url === res.root)));
      if (home) console.log('  crawl data: ' + JSON.stringify({ url: home.url, status: home.httpStatus, finalUrl: home.finalUrl, bytes: home.bytes, rendered: home.rendered, clickDepth: home.clickDepth, inlinks: home.inlinks, anchors: home.inlinkAnchors, headers: home.headers }).slice(0, 700));
      if (home) console.log('  homepage checks:\n' + home.checks.map(c => `    ${c.status.padEnd(4)} ${String(c.points).padStart(3)}${c.frac != null ? ' x' + c.frac.toFixed(2) : ''}${c.penalty ? ' -' + c.penalty : ''}  ${c.label} — ${String(c.detail || '').slice(0, 110)}`).join('\n'));
      (res.siteChecks || []).forEach(c => console.log(`    site ${c.status.padEnd(4)} ${String(c.points).padStart(3)}  ${c.label} — ${String(c.detail || '').slice(0, 110)}`));
      const byType = {};
      (res.pages || []).filter(p => !p.error).forEach(p => { (byType[p.pageType] = byType[p.pageType] || []).push(p); });
      Object.keys(byType).forEach(t => console.log(`  [${t}] ${byType[t].length}: ` + byType[t].slice(0, 40).map(p => (p.url.replace(res.root, '') || '/') + '=' + (p._score && p._score.score)).join('  ')));
      const cp = res.crossPage || {};
      Object.keys(cp).forEach(k => { const v = cp[k]; const n = Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : v); if (n) console.log(`  crossPage.${k}: ${n}`, JSON.stringify(v).slice(0, 300)); });
      if (misses.length) console.log('  misses:', misses.slice(0, 10));
    }
  }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
