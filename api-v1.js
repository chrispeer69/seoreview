'use strict';
// /api/v1 — machine-auth SEO audit API for other Blue Collar AI systems (Review Intelligence Terminal, CRM…).
// Contract: chrispeer69/google-review-site/docs/seo-engine-api.md. Full docs for this side: API.md.
//
//   POST /api/v1/audits                 request a whole-site audit (idempotent per domain for 30 days)
//   GET  /api/v1/audits/latest?domain=  newest audit for a domain
//   GET  /api/v1/audits/:id             poll one audit
//   POST /api/v1/audits/status          batch poll  { audit_ids: [...] }
//   GET  /api/v1/audits/:id/report      branded HTML report (API key)
//   GET  /report/:id?t=<token>          same report, shareable link (no API key)
//   GET  /api/v1/ping                   key check + feature flags
//
// Auth: X-API-Key (or Authorization: Bearer) = SEO_API_KEY. Callbacks are signed with SEO_WEBHOOK_SECRET.
// Audits run in-process through headless-audit.js (the public tool's own engine, in jsdom). Results persist
// in Postgres (seo_audits) when DATABASE_URL is set, otherwise in memory (lost on restart).
const crypto = require('crypto');
const headless = require('./headless-audit');

const API_KEY = process.env.SEO_API_KEY || '';
const WEBHOOK_SECRET = process.env.SEO_WEBHOOK_SECRET || API_KEY;
const REUSE_DAYS = Math.max(0, parseInt(process.env.SEO_API_REUSE_DAYS || '30', 10) || 0);
const MAX_PAGES = Math.max(5, Math.min(300, parseInt(process.env.SEO_API_MAX_PAGES || '100', 10) || 100));
const CONCURRENCY = Math.max(1, parseInt(process.env.SEO_API_CONCURRENCY || '2', 10) || 1);
const JOB_TIMEOUT_MS = Math.max(60, parseInt(process.env.SEO_API_TIMEOUT_SEC || '600', 10) || 600) * 1000;

let deps = null;
let store = null;

// ---------- helpers ----------
const newId = () => 'a_' + crypto.randomBytes(8).toString('hex');
const newToken = () => crypto.randomBytes(12).toString('hex');
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const iso = d => (d ? new Date(d).toISOString() : null);

function normalizeDomain(v) {
  let s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.+$/, '');
  return s;
}
function validDomain(s) {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(s);
}

// ---------- storage ----------
const COLS = 'id,domain,external_id,callback_url,status,error,result,report_html,view_token,progress,created_at,started_at,finished_at';
const PATCHABLE = new Set(['external_id', 'status', 'error', 'result', 'report_html', 'progress', 'started_at', 'finished_at']);

function memStore() {
  const m = new Map();
  return {
    async init() {},
    async create(j) { m.set(j.id, j); return j; },
    async get(id) { return m.get(id) || null; },
    async update(id, patch) { const j = m.get(id); if (!j) return null; for (const k of Object.keys(patch)) if (PATCHABLE.has(k)) j[k] = patch[k]; return j; },
    async getMany(ids) { return ids.map(i => m.get(i)).filter(Boolean); },
    async latest(domain, statuses) {
      return [...m.values()].filter(j => j.domain === domain && (!statuses || statuses.includes(j.status)))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
    },
    async byStatus(st) { return [...m.values()].filter(j => j.status === st); },
  };
}

function pgStore(pool) {
  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS seo_audits (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          external_id TEXT,
          callback_url TEXT,
          status TEXT NOT NULL,
          error TEXT,
          result JSONB,
          report_html TEXT,
          view_token TEXT,
          progress JSONB,
          created_at TIMESTAMPTZ DEFAULT now(),
          started_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ
        );`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_seo_audits_domain ON seo_audits (domain, created_at DESC);');
    },
    async create(j) {
      await pool.query(`INSERT INTO seo_audits (id,domain,external_id,callback_url,status,view_token,progress,created_at)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [j.id, j.domain, j.external_id, j.callback_url, j.status, j.view_token, j.progress ? JSON.stringify(j.progress) : null, j.created_at]);
      return j;
    },
    async get(id) { const { rows } = await pool.query(`SELECT ${COLS} FROM seo_audits WHERE id=$1`, [id]); return rows[0] || null; },
    async update(id, patch) {
      const keys = Object.keys(patch).filter(k => PATCHABLE.has(k));
      if (!keys.length) return this.get(id);
      const sets = keys.map((k, i) => `${k}=$${i + 2}`);
      const vals = keys.map(k => ((k === 'result' || k === 'progress') && patch[k] != null ? JSON.stringify(patch[k]) : patch[k]));
      const { rows } = await pool.query(`UPDATE seo_audits SET ${sets.join(', ')} WHERE id=$1 RETURNING ${COLS}`, [id, ...vals]);
      return rows[0] || null;
    },
    async getMany(ids) { const { rows } = await pool.query(`SELECT ${COLS} FROM seo_audits WHERE id = ANY($1)`, [ids]); return rows; },
    async latest(domain, statuses) {
      const { rows } = await pool.query(
        `SELECT ${COLS} FROM seo_audits WHERE domain=$1 AND ($2::text[] IS NULL OR status = ANY($2::text[])) ORDER BY created_at DESC LIMIT 1`,
        [domain, statuses || null]);
      return rows[0] || null;
    },
    async byStatus(st) { const { rows } = await pool.query(`SELECT ${COLS} FROM seo_audits WHERE status=$1 ORDER BY created_at`, [st]); return rows; },
  };
}

// ---------- engine result -> contract body ----------
const SEV_RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };
function severityOf(c) {
  if (c.status === 'fail') return (c.points || 0) >= 6 ? 'critical' : 'serious';
  if (c.status === 'warn') return (c.points || 0) >= 4 ? 'moderate' : 'minor';
  return null;
}
const codeOf = label => String(label || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const gradeOf = s => (s == null ? null : s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 55 ? 'D' : 'F');
const relPath = u => { try { const x = new URL(String(u)); return (x.pathname || '/') + (x.search || ''); } catch (e) { return String(u || '/'); } };

function summarize(res) {
  const root = res.root || '';
  const all = res.pages || [];
  const ok = all.filter(p => !p.error);
  const N = ok.length;
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const agg = {};

  const pages = ok.map(p => {
    const sc = p._score || {};
    const issues = (p.checks || []).map(c => {
      const sev = severityOf(c);
      if (!sev) return null;
      counts[sev]++;
      const code = codeOf(c.label);
      const detail = String(c.detail || '').trim();
      const a = agg[code] || (agg[code] = { code, label: c.label, severity: sev, category: c.cat, points: c.points || 0, pages: new Set(), details: {} });
      a.pages.add(p.url);
      if (detail) a.details[detail] = (a.details[detail] || 0) + 1;
      if (SEV_RANK[sev] < SEV_RANK[a.severity]) a.severity = sev;
      const out = { code, severity: sev, category: c.cat, check: c.label, message: detail ? `${c.label}: ${detail}` : c.label };
      if (c.fix) out.fix = c.fix;
      return out;
    }).filter(Boolean).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    return { url: p.url, path: relPath(p.url), title: p.title || null, grade: sc.grade || gradeOf(sc.score), score: sc.score == null ? null : sc.score,
      words: p.words == null ? null : p.words, response_ms: p.loadMs == null ? null : p.loadMs, js_rendered: !!p.jsShell, issues };
  }).sort((a, b) => ((a.score == null ? 101 : a.score) - (b.score == null ? 101 : b.score)) || (b.issues.length - a.issues.length));

  const failed = all.filter(p => p.error).map(p => ({ url: p.url, path: relPath(p.url), title: null, grade: null, score: null, error: String(p.error),
    issues: [{ code: 'fetch_failed', severity: 'serious', message: 'Page could not be fetched — ' + String(p.error) }] }));

  // Site-wide findings only a crawl can see (duplicates etc.). Thin / JS-only / missing-H1 are already per-page checks.
  const cp = res.crossPage || {};
  const sumUrls = g => (g || []).reduce((a, x) => a + ((x.urls || []).length), 0);
  const site = [];
  const addSite = (code, severity, pagesCount, message) => { if (!pagesCount) return; counts[severity]++; site.push({ code, severity, message, pages: pagesCount, site_wide: true, weight: 1000 + pagesCount }); };
  if ((cp.duplicateBodies || []).length) addSite('duplicate_body_content', 'critical', sumUrls(cp.duplicateBodies),
    `${sumUrls(cp.duplicateBodies)} pages share near-identical body content (${cp.duplicateBodies.length} duplicate group${cp.duplicateBodies.length === 1 ? '' : 's'})`);
  if ((cp.duplicateTitles || []).length) addSite('duplicate_titles', 'serious', sumUrls(cp.duplicateTitles),
    `${sumUrls(cp.duplicateTitles)} pages share a title tag (e.g. "${cp.duplicateTitles[0].value}")`);
  if ((cp.duplicateH1 || []).length) addSite('duplicate_h1', 'moderate', sumUrls(cp.duplicateH1),
    `${sumUrls(cp.duplicateH1)} pages share the same H1 heading (e.g. "${cp.duplicateH1[0].value}")`);
  if ((cp.titleBodyMismatch || []).length) addSite('title_body_mismatch', 'moderate', cp.titleBodyMismatch.length,
    `${cp.titleBodyMismatch.length} page${cp.titleBodyMismatch.length === 1 ? ' has' : 's have'} a title that does not match the page content`);
  (res.siteChecks || []).forEach(c => { const sev = severityOf(c); if (sev) addSite(codeOf(c.label), sev, N, `${c.label}: ${c.detail || 'problem found'}`); });

  const perPage = Object.values(agg).map(a => {
    const detail = Object.keys(a.details).sort((x, y) => a.details[y] - a.details[x])[0] || a.label;
    const where = N > 1 && a.pages.size === N ? `every audited page (${N})` : `${a.pages.size} of ${N} page${N === 1 ? '' : 's'}`;
    return { code: a.code, severity: a.severity, category: a.category, check: a.label, message: `${a.label}: ${detail} — ${where}`, pages: a.pages.size, weight: a.points * a.pages.size };
  });
  const top_issues = site.concat(perPage)
    .sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (b.weight - a.weight))
    .slice(0, 5).map(x => { const o = Object.assign({}, x); delete o.weight; return o; });

  // Category percentages across the site (same math as the branded report).
  const catAgg = {};
  ok.forEach(p => { const bc = (p._score && p._score.byCat) || {}; Object.keys(bc).forEach(c => { catAgg[c] = catAgg[c] || { e: 0, t: 0 }; catAgg[c].e += bc[c].e; catAgg[c].t += bc[c].t; }); });
  const pct = c => (catAgg[c] && catAgg[c].t ? Math.round(100 * catAgg[c].e / catAgg[c].t) : null);
  const categories = {}; Object.keys(catAgg).forEach(c => { categories[c] = pct(c); });

  // Homepage-level checks feed the optional local + AI blocks.
  const home = ok.find(p => p.url === root + '/' || p.url === root) || ok[0] || null;
  const siteChecks = res.siteChecks || []; // robots.txt / sitemap / AI-crawler / llms.txt, run once per site
  const chk = re => siteChecks.find(x => re.test(x.label)) || (home && (home.checks || []).find(x => re.test(x.label))) || null;
  const passed = c => (c ? (c.status === 'pass' ? true : c.status === 'info' ? null : false) : null);
  const loc = res.local || null;
  const local = {
    gbp_found: loc ? !!loc.found : null,
    name: loc && loc.found ? (loc.name || null) : null,
    rating: loc && loc.found && loc.rating != null ? loc.rating : null,
    review_count: loc && loc.found && loc.reviews != null ? loc.reviews : null,
    address: loc && loc.found ? (loc.address || null) : null,
    phone: loc && loc.found ? (loc.phone || null) : null,
    maps_url: loc && loc.found ? (loc.mapsUrl || null) : null,
    schema_localbusiness: passed(chk(/LocalBusiness structured data/i)),
    review_schema: passed(chk(/Review \/ rating schema/i)),
    click_to_call: passed(chk(/Click-to-call/i)),
    map_reference: passed(chk(/Map \/ location reference/i)),
    local_seo_score: pct('Local SEO'),
  };
  const aiCrawlers = chk(/AI search crawlers allowed/i);
  let crawlers_blocked = null;
  if (aiCrawlers) {
    if (aiCrawlers.status === 'pass') crawlers_blocked = [];
    else if (aiCrawlers.status === 'fail') crawlers_blocked = ['*'];
    else if (aiCrawlers.status === 'warn') crawlers_blocked = ((aiCrawlers.detail || '').match(/Blocking:\s*(.+)$/) || [, ''])[1].split(/,\s*/).filter(Boolean);
  }
  const jsPages = (cp.jsRendered || []).length;
  const ai_visibility = {
    score: pct('AI Search & Answer Engines'),
    crawlers_blocked,
    llms_txt: passed(chk(/llms\.txt/i)),
    faq_schema: passed(chk(/FAQ structured data/i)),
    organization_schema: passed(chk(/Organization \/ entity data/i)),
    readable_without_js: passed(chk(/readable without JavaScript/i)),
    js_only_pages: jsPages,
    notes: (jsPages ? `${jsPages} page${jsPages === 1 ? ' is' : 's are'} JavaScript-only and invisible to AI answer engines. ` : '')
      + 'Score = the "AI Search & Answer Engines" category across audited pages (crawler access, llms.txt, FAQ/Organization schema, readable content). Live AI-answer citations are not checked.',
  };

  const pf = res.perf || null;
  const server_speed = !pf ? null : {
    avg_ms: pf.avg, median_ms: pf.median, max_ms: pf.max, pages_measured: pf.count,
    verdict: pf.avg < 800 ? 'fast' : pf.avg < 1800 ? 'moderate' : 'slow',
    slowest: (pf.slow || []).slice(0, 5).map(o => ({ url: o.url, ms: o.ms })),
  };
  const cov = res.coverage || {};
  return {
    pages_crawled: N,
    grade: gradeOf(res.siteScore),
    score: res.siteScore == null ? null : res.siteScore,
    summary: counts,
    top_issues,
    pages: pages.concat(failed),
    categories,
    local,
    ai_visibility,
    server_speed,
    coverage: { discovered: cov.discovered, audited: cov.audited, failed: cov.failed, capped: !!cov.capped, cap: cov.cap, discovered_via: cov.via, js_rendered: cov.rendered || 0, render_available: !!cov.renderAvailable },
  };
}

function contractBody(j, opts) {
  opts = opts || {};
  const r = j.result || {};
  const body = {
    audit_id: j.id,
    external_id: opts.external_id || j.external_id || null,
    domain: j.domain,
    status: j.status,
    error: j.error || null,
    created_at: iso(j.created_at),
    started_at: iso(j.started_at),
    finished_at: iso(j.finished_at),
    pages_crawled: r.pages_crawled == null ? null : r.pages_crawled,
    grade: r.grade == null ? null : r.grade,
    score: r.score == null ? null : r.score,
    summary: r.summary || null,
    top_issues: r.top_issues || [],
    pages: opts.slim ? undefined : (r.pages || []),
    categories: r.categories || null,
    local: r.local || null,
    ai_visibility: r.ai_visibility || null,
    server_speed: r.server_speed || null,
    coverage: r.coverage || null,
    report_url: j.status === 'done' ? `${deps.BASE_URL}/report/${j.id}?t=${j.view_token}` : null,
  };
  if (j.status === 'running' && j.progress) body.progress = j.progress;
  if (opts.reused != null) body.reused = !!opts.reused;
  return body;
}

// ---------- queue ----------
const queue = [];
let running = 0;
function enqueue(id) { queue.push(id); pump(); }
function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift();
    running++;
    runJob(id).catch(e => console.error('[api v1] job crashed', id, e && e.message)).finally(() => { running--; pump(); });
  }
}

// Follow the domain's redirects once so the crawl starts on the real origin (www vs bare, http vs https).
async function resolveRoot(domain) {
  for (const scheme of ['https://', 'http://']) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await deps.proxyFetch(scheme + domain + '/', ctrl.signal).finally(() => clearTimeout(t));
      if (r.challenged) continue;
      const fu = new URL(r.finalUrl || scheme + domain + '/');
      const fh = fu.hostname.toLowerCase();
      if (fh === domain || fh === 'www.' + domain || fh.endsWith('.' + domain)) return fu.origin;
      return scheme + domain;
    } catch (e) { /* try next scheme */ }
  }
  return 'https://' + domain;
}

async function runJob(id) {
  let job = await store.get(id);
  if (!job || job.status !== 'queued') return;
  job = await store.update(id, { status: 'running', started_at: new Date(), progress: { done: 0, total: 0 } });
  let lastSave = 0;
  try {
    const root = await resolveRoot(job.domain);
    const work = headless.crawlSite(deps, root, {
      maxPages: MAX_PAGES, concurrency: 4,
      onProgress: (done, total, current) => {
        const now = Date.now();
        if (now - lastSave > 1500) { lastSave = now; store.update(id, { progress: { done, total, current: String(current || '').slice(0, 200) } }).catch(() => {}); }
      },
    });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('audit timed out after ' + Math.round(JOB_TIMEOUT_MS / 1000) + 's')), JOB_TIMEOUT_MS));
    const out = await Promise.race([work, timeout]);
    if (!out || !out.result || out.result.error) throw new Error((out && out.result && out.result.error) || 'crawl failed');
    const result = summarize(out.result);
    if (result.pages_crawled === 0) throw new Error('No page could be audited — the site may block automated access or is unavailable.');
    job = await store.update(id, { status: 'done', finished_at: new Date(), result, report_html: out.html, progress: null, error: null });
    console.log(`[api v1] audit ${id} ${job.domain}: ${result.grade} ${result.score} (${result.pages_crawled} pages)`);
    syncCrm(job).catch(() => {});
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    console.warn(`[api v1] audit ${id} failed: ${msg}`);
    job = await store.update(id, { status: 'failed', finished_at: new Date(), error: msg, progress: null });
  }
  if (job && job.callback_url) sendCallback(job).catch(() => {});
}

// Keep the CRM's quick-glance columns in sync when the audited domain is a known business.
async function syncCrm(job) {
  if (!deps.pool || !job.result) return;
  await deps.pool.query('UPDATE crm_businesses SET latest_score=$1, latest_grade=$2, last_audit_at=now(), updated_at=now() WHERE domain=$3',
    [job.result.score, job.result.grade, job.domain]);
}

async function sendCallback(job) {
  const body = JSON.stringify(contractBody(job));
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  const delays = [0, 5000, 30000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await deps.guardedFetch(job.callback_url, {
        method: 'POST', signal: ctrl.signal, body,
        headers: { 'Content-Type': 'application/json', 'X-Signature': sig, 'X-Audit-Id': job.id, 'User-Agent': 'seoreview-api/1.0' },
      });
      if (r.ok) { console.log(`[api v1] callback delivered for ${job.id} -> ${r.status}`); return true; }
      console.warn(`[api v1] callback for ${job.id} returned ${r.status} (attempt ${i + 1})`);
    } catch (e) {
      console.warn(`[api v1] callback for ${job.id} failed: ${e && e.message} (attempt ${i + 1})`);
    } finally { clearTimeout(t); }
  }
  return false;
}

// ---------- express ----------
function apiKeyOk(req) {
  if (!API_KEY) return false;
  let k = req.get('x-api-key') || '';
  if (!k) { const a = req.get('authorization') || ''; if (/^bearer\s+/i.test(a)) k = a.replace(/^bearer\s+/i, '').trim(); }
  return !!k && safeEq(k, API_KEY);
}
function requireKey(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!API_KEY) return res.status(503).json({ error: 'api_not_configured', hint: 'set SEO_API_KEY on the server' });
  if (!apiKeyOk(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
}
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error('[api v1]', req.method, req.path, e && e.stack || e); if (!res.headersSent) res.status(500).json({ error: 'server_error' }); });

function mount(app, d) {
  deps = d;
  store = d.pool ? pgStore(d.pool) : memStore();

  app.use('/api/v1', requireKey);

  app.get('/api/v1/ping', (req, res) => res.json({
    ok: true, version: 1, storage: d.pool ? 'postgres' : 'memory',
    features: { render: !!d.renderEnabled, places: !!d.placesEnabled },
    limits: { max_pages: MAX_PAGES, reuse_days: REUSE_DAYS, concurrency: CONCURRENCY, timeout_sec: JOB_TIMEOUT_MS / 1000 },
    queue: { queued: queue.length, running },
  }));

  app.post('/api/v1/audits', d.rateLimit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
    const b = req.body || {};
    const domain = normalizeDomain(b.domain || b.url);
    if (!domain) return res.status(400).json({ error: 'domain_required' });
    if (!validDomain(domain) || d.isPrivateHost(domain)) return res.status(400).json({ error: 'invalid_domain', domain });
    const external_id = b.external_id == null ? null : String(b.external_id).slice(0, 120);
    const force = b.force === true || b.force === 'true';
    let callback_url = null;
    if (b.callback_url) {
      try {
        const cu = new URL(String(b.callback_url));
        if (!/^https?:$/.test(cu.protocol) || d.isPrivateHost(cu.hostname)) throw new Error('bad');
        callback_url = cu.href;
      } catch (e) { return res.status(400).json({ error: 'invalid_callback_url' }); }
    }

    // One crawl per domain at a time: attach to the in-flight audit rather than start a second.
    const active = await store.latest(domain, ['queued', 'running']);
    if (active) {
      if (external_id && !active.external_id) await store.update(active.id, { external_id });
      return res.status(202).json(contractBody(active, { reused: true, external_id, slim: true }));
    }
    if (!force && REUSE_DAYS > 0) {
      const done = await store.latest(domain, ['done']);
      if (done && Date.now() - new Date(done.created_at).getTime() < REUSE_DAYS * 86400000) {
        return res.status(200).json(contractBody(done, { reused: true, external_id }));
      }
    }
    const job = { id: newId(), domain, external_id, callback_url, status: 'queued', error: null, result: null, report_html: null,
      view_token: newToken(), progress: null, created_at: new Date(), started_at: null, finished_at: null };
    await store.create(job);
    enqueue(job.id);
    res.status(202).json(contractBody(job, { reused: false }));
  }));

  app.get('/api/v1/audits/latest', wrap(async (req, res) => {
    const domain = normalizeDomain(req.query.domain);
    if (!domain) return res.status(400).json({ error: 'domain_required' });
    const job = (await store.latest(domain, ['done'])) || (await store.latest(domain, null));
    if (!job) return res.status(404).json({ error: 'no_audit', domain });
    res.json(contractBody(job));
  }));

  app.post('/api/v1/audits/status', wrap(async (req, res) => {
    const ids = Array.isArray((req.body || {}).audit_ids) ? req.body.audit_ids.map(String).slice(0, 100) : [];
    if (!ids.length) return res.status(400).json({ error: 'audit_ids_required' });
    const found = await store.getMany(ids);
    const byId = new Map(found.map(j => [j.id, j]));
    res.json({ audits: ids.map(id => (byId.has(id) ? contractBody(byId.get(id), { slim: true }) : { audit_id: id, status: 'not_found' })) });
  }));

  app.get('/api/v1/audits/:id', wrap(async (req, res) => {
    const job = await store.get(String(req.params.id));
    if (!job) return res.status(404).json({ error: 'not_found' });
    res.json(contractBody(job));
  }));

  const sendReport = (job, res) => {
    res.set('Cache-Control', 'private, max-age=300');
    res.type('html').send(headless.reportPage({
      bodyHtml: job.report_html,
      title: 'Full-Site SEO & AI Search Audit — ' + job.domain,
      subtitle: `Grade ${job.result.grade} · ${job.result.score}/100 · ${job.result.pages_crawled} pages · ${iso(job.finished_at).slice(0, 10)}`,
    }));
  };
  app.get('/api/v1/audits/:id/report', wrap(async (req, res) => {
    const job = await store.get(String(req.params.id));
    if (!job) return res.status(404).json({ error: 'not_found' });
    if (job.status !== 'done' || !job.report_html) return res.status(409).json({ error: 'not_ready', status: job.status });
    sendReport(job, res);
  }));
  // Shareable report link (the report_url in every audit body). No API key: the per-audit token is the secret.
  app.get('/report/:id', wrap(async (req, res) => {
    const job = await store.get(String(req.params.id));
    if (!job || job.status !== 'done' || !job.report_html) return res.status(404).type('text').send('Report not found');
    const t = String(req.query.t || '');
    if (!((t && job.view_token && safeEq(t, job.view_token)) || apiKeyOk(req))) return res.status(401).type('text').send('Report link is missing its token');
    sendReport(job, res);
  }));
}

async function migrate(pool) {
  if (!pool) return;
  await pgStore(pool).init();
}

// Called once the server listens: re-queue audits that were waiting when the process last stopped and fail
// the ones that were mid-crawl (their in-memory state is gone).
async function start() {
  if (!store) return;
  if (!API_KEY) { console.log('[api v1] disabled — set SEO_API_KEY to enable /api/v1'); return; }
  try {
    for (const j of await store.byStatus('running')) {
      await store.update(j.id, { status: 'failed', finished_at: new Date(), error: 'server restarted during the audit — request it again', progress: null });
      if (j.callback_url) sendCallback(await store.get(j.id)).catch(() => {});
    }
    const queued = await store.byStatus('queued');
    queued.forEach(j => enqueue(j.id));
    console.log(`[api v1] ready — max ${MAX_PAGES} pages, reuse ${REUSE_DAYS}d, concurrency ${CONCURRENCY}${queued.length ? `, re-queued ${queued.length}` : ''}`);
  } catch (e) { console.error('[api v1] start:', e.message); }
}

module.exports = { mount, migrate, start, summarize, normalizeDomain };
