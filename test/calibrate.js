'use strict';
// Calibration of the audit engine against cached real sites (test/fixtures/<domain>.json.gz).
//
//   node test/calibrate.js                    replay the cached fixtures (no network) and assert each site's score -
//                                             and each reference page's - is within ±3 of its recorded score
//                                             (test/fixtures/expected.json). This is the only mode `npm test` runs.
//   node test/calibrate.js --record <site>    on purpose only: fetch <site> live (pages, checks, PageSpeed), rewrite its
//                                             fixture and its recorded scores. One named site per run; never all.
//   node test/calibrate.js --accept [<site>]  an intended engine change moved the scores: replay and store the new
//                                             scores as recorded (the fixtures themselves are untouched)
//   node test/calibrate.js --live [<site>]    crawl live and print the scores next to the recorded ones.
//                                             Informational: writes nothing and never fails.
//   --verbose                                 also print the per-page scores and site-wide findings
//   --only=<domain>[,<domain>]                limit a replay / --accept / --live run to these sites
//
// Replay is deterministic: every network call the engine makes (pages, robots/sitemaps, link checks, PageSpeed) is
// answered from the fixture; a request the fixture doesn't hold is answered as a network failure and counted.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const headless = require('../headless-audit');

const SITES = [
  // `pages`: reference pages whose own scores are asserted too.
  { domain: 'columbusroadsidetowing.com', root: 'https://www.columbusroadsidetowing.com', industry: 'towing',
    pages: ['/service-area/whitehall', '/service-area/lewis-center'] },
  { domain: 'broadandjames.com', root: 'https://broadandjames.com', industry: 'towing' },
  // Capital starts at the bare domain, which redirects to www: the homepage must still be audited.
  { domain: 'capitaltowing.com', root: 'https://capitaltowing.com', industry: 'towing' },
  { domain: 'jaestowing.com', root: 'https://www.jaestowing.com', industry: 'towing' },
  { domain: 'protow.guardianfleetservice.com', root: 'https://protow.guardianfleetservice.com', industry: 'towing' },
];
const TOLERANCE = 3;
const argAfter = flag => { const i = process.argv.indexOf(flag); const v = i >= 0 ? process.argv[i + 1] : null; return v && !v.startsWith('--') ? v : null; };
const RECORD_SITE = argAfter('--record');
const RECORD = process.argv.includes('--record');
const LIVE = process.argv.includes('--live');
const ACCEPT = process.argv.includes('--accept');
const ONLY = ((process.argv.find(a => a.startsWith('--only=')) || '').slice(7)).split(',').filter(Boolean)
  .concat(RECORD_SITE ? [RECORD_SITE] : [], argAfter('--live') ? [argAfter('--live')] : [], argAfter('--accept') ? [argAfter('--accept')] : []);
if (RECORD && !RECORD_SITE) { console.error('--record needs a site: node test/calibrate.js --record <domain>  (one site, on purpose)'); process.exit(2); }
if (RECORD_SITE && !SITES.some(s => s.domain === RECORD_SITE)) { console.error(`--record ${RECORD_SITE}: not a calibration site (${SITES.map(s => s.domain).join(', ')})`); process.exit(2); }
// Kept for deliberate fixture maintenance only (each rewrites the fixture it touches):
// --record-missing: replay, fetch live only what the fixture lacks (a new check), and add that to the fixture.
// --refresh-checks: re-fetch every URL status check (e.g. after linkcheck starts returning more fields).
const RECORD_MISSING = process.argv.includes('--record-missing');
const REFRESH_CHECKS = process.argv.includes('--refresh-checks');
const EXPECTED_PATH = path.join(__dirname, 'fixtures', 'expected.json');
const loadExpected = () => { try { return JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8')); } catch (e) { return {}; } };
const saveExpected = x => fs.writeFileSync(EXPECTED_PATH, JSON.stringify(x, null, 2) + '\n');
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
    if (LIVE) return live();             // --live: straight to the network, nothing read from or written to the fixture
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
  const expected = loadExpected();
  const mode = RECORD ? 'record' : LIVE ? 'live' : ACCEPT ? 'accept' : 'replay';
  for (const site of SITES) {
    if (ONLY.length && !ONLY.includes(site.domain)) continue;
    let fx;
    if (RECORD) fx = { domain: site.domain, recorded: new Date().toISOString(), calls: {} };
    else if (LIVE) fx = { domain: site.domain, recorded: new Date().toISOString(), calls: {} };
    else fx = load(site.domain);
    if (!fx) { console.log(`${site.domain}: no fixture - record it on purpose: node test/calibrate.js --record ${site.domain}`); failed++; continue; }
    const { deps, misses } = makeDeps(fx);
    const t0 = Date.now();
    const out = await headless.crawlSite(deps, site.root, { maxPages: 150, concurrency: 4, psiKey: psiKey(), now: fx.recorded, industry: site.industry || 'general' });
    if (fx.dirty && !LIVE) { delete fx.dirty; delete fx.refreshed; save(site.domain, fx); console.log(`  (fixture updated: ${Object.keys(fx.calls).length} calls)`); }
    const res = out.result || {};
    if (res.error) { console.log(`${site.domain}: crawl error - ${res.error}`); if (!LIVE) failed++; continue; }
    const s = res.siteScore; const b = res.siteBreakdown || null;
    const pageScore = pth => { const pg = (res.pages || []).find(p => !p.error && p.url.replace(res.root, '') === pth); return pg && pg._score ? pg._score.score : null; };
    const got = { score: s, pages: {} };
    (site.pages || []).forEach(pth => { got.pages[pth] = pageScore(pth); });
    const want = expected[site.domain];
    // ±TOLERANCE against the recorded score: a replay outside it fails; --live only reports.
    const cmp = (label, now, rec) => {
      if (rec == null) return `${label} ${now} (nothing recorded yet)`;
      const d = now == null ? null : now - rec, ok = d != null && Math.abs(d) <= TOLERANCE;
      if (!ok && mode === 'replay') failed++;
      return `${label} ${now == null ? 'not crawled' : now} (recorded ${rec} ±${TOLERANCE}${d ? `, ${d > 0 ? '+' : ''}${d}` : ''}: ${ok ? 'OK' : mode === 'live' ? 'DRIFT (info only)' : 'OUT OF RANGE'})`;
    };
    console.log(`\n${site.domain} [${mode}]: ${cmp('site score', s, want && want.score)}`
      + ` · ${(res.pages || []).filter(p => !p.error).length} pages · ${((Date.now() - t0) / 1000).toFixed(1)}s${misses.length ? ` · ${misses.length} fixture misses` : ''}`);
    // A replay must be answered entirely from the fixture; a miss means the engine now asks for something the
    // fixture never recorded, so the score is not the recorded site's score.
    if (mode === 'replay' && misses.length) { console.log(`  fixture misses (first: ${misses[0]}) - add them on purpose: --record-missing --only=${site.domain}`); failed++; }
    if (b) {
      const t = b.technical || {}, f = b.freshness || {}, l = b.linkHealth || {}, c = b.coverage || {}, d = b.duplication || {};
      console.log(`  pages ${b.pageAverage} | site level ${b.siteLevel} = coverage ${c.score} (${c.service} svc/${c.location} loc) · freshness ${f.score} (${f.newest || 'n/a'}) · links ${l.score} (${l.broken} broken/${l.redirects} redirects/${l.orphans} orphans) · duplication ${d.score} · technical ${t.score} ${JSON.stringify(t.parts || {})}`);
      console.log(`  penalties: ${(b.penalties || []).map(x => '-' + x.points + ' ' + x.reason).join('; ') || 'none'} | caps: ${(b.caps || []).map(x => x.max + ' ' + x.reason).join('; ') || 'none'} | AI Search ${b.aiSearch}`);
    }
    (site.pages || []).forEach(pth => console.log('  ' + cmp('page ' + pth + ':', got.pages[pth], want && want.pages && want.pages[pth])));
    if (mode === 'record' || mode === 'accept') {
      expected[site.domain] = { score: s, pages: got.pages, fixture_recorded: fx.recorded, accepted: new Date().toISOString() };
      saveExpected(expected);
      console.log(`  recorded score saved: ${s}${Object.keys(got.pages).length ? ' · pages ' + JSON.stringify(got.pages) : ''}`);
    }
    // The API summary and the branded report must build from this result.
    const api = require('../api-v1').summarize(res);
    if (api.score !== s) { console.log(`  API score ${api.score} != engine ${s}`); if (!LIVE) failed++; }
    if (!out.html || out.html.length < 5000 || !/Link health/.test(out.html)) { console.log('  report HTML missing or incomplete'); if (!LIVE) failed++; }
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
  if (LIVE) { console.log(`
--live is informational: exit 0 whatever moved${failed ? ` (${failed} issue(s) noted)` : ""}.`); failed = 0; }
  process.exitCode = failed ? 1 : 0; // not process.exit(): on Windows it cuts off output still being piped
})().catch(e => { console.error(e); process.exitCode = LIVE ? 0 : 2; });  // --live never fails
