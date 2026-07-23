// Blue Collar AI — SEO & AI Search Audit server
// - Serves the public audit tool
// - /api/proxy: server-side fetch (no flaky public CORS proxies)
// - Team zone: Google login (team whitelist) + Postgres-backed saved reports
// - Lead capture + optional Google Places reviews
//
// Everything degrades gracefully: with no DATABASE_URL / GOOGLE_* env vars the
// server still serves the public tool + proxy, and the team UI stays hidden.
'use strict';
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const cfg = {
  db: !!process.env.DATABASE_URL,
  google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  places: !!process.env.PLACES_API_KEY,
  email: !!process.env.RESEND_API_KEY,
  geocode: !!(process.env.GOOGLE_MAPS_API_KEY || process.env.PLACES_API_KEY),
  stripe: !!process.env.STRIPE_SECRET_KEY,
  teamEmails: (process.env.TEAM_EMAILS || '').split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean),
};
const REPORT_PRICE_CENTS = parseInt(process.env.REPORT_PRICE_CENTS || '4900', 10);
const teamEnabled = cfg.db && cfg.google;

app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));

// ---------- Database ----------
let pool = null;
if (cfg.db) {
  const { Pool } = require('pg');
  const dbUrl = process.env.DATABASE_URL;
  // Railway's internal network (…railway.internal) speaks plain TCP — forcing SSL
  // there breaks the connection. Auto-detect; override with PGSSL=require|disable.
  const internal = /railway\.internal|localhost|127\.0\.0\.1/.test(dbUrl || '');
  const ssl = process.env.PGSSL === 'require' ? { rejectUnauthorized: false }
            : process.env.PGSSL === 'disable' ? false
            : (internal ? false : { rejectUnauthorized: false });
  pool = new Pool({ connectionString: dbUrl, ssl });
  pool.on('error', e => console.error('PG pool error:', e.message));
}
async function migrate() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      google_sub TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      last_login TIMESTAMPTZ
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_runs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      customer TEXT,
      urls TEXT[],
      results JSONB NOT NULL,
      summary JSONB,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_report_runs_created ON report_runs (created_at DESC);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      email TEXT,
      url TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );`);
  // ---- CRM ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_businesses (
      id SERIAL PRIMARY KEY,
      name TEXT,
      domain TEXT UNIQUE,
      website TEXT,
      industry TEXT,
      address TEXT, city TEXT, state TEXT, zip TEXT,
      lat DOUBLE PRECISION, lng DOUBLE PRECISION,
      phone TEXT, email TEXT,
      latest_score INT, latest_grade TEXT, last_audit_at TIMESTAMPTZ,
      status TEXT DEFAULT 'new',
      follow_up DATE,
      notes TEXT,
      comments JSONB DEFAULT '[]'::jsonb,
      memberships JSONB DEFAULT '[]'::jsonb,
      tags JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_state ON crm_businesses (state);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_city ON crm_businesses (city);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_industry ON crm_businesses (industry);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_grade ON crm_businesses (latest_grade);`);
  await pool.query(`ALTER TABLE crm_businesses
     ADD COLUMN IF NOT EXISTS owner_name TEXT, ADD COLUMN IF NOT EXISTS owner_phone TEXT, ADD COLUMN IF NOT EXISTS owner_email TEXT,
     ADD COLUMN IF NOT EXISTS manager_name TEXT, ADD COLUMN IF NOT EXISTS manager_phone TEXT, ADD COLUMN IF NOT EXISTS manager_email TEXT,
     ADD COLUMN IF NOT EXISTS last_report JSONB, ADD COLUMN IF NOT EXISTS alliance_status TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_members (
      id SERIAL PRIMARY KEY,
      association TEXT NOT NULL,
      domain TEXT,
      name TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_members_domain ON crm_members (domain);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS geocache (
      q TEXT PRIMARY KEY,
      lat DOUBLE PRECISION, lng DOUBLE PRECISION,
      created_at TIMESTAMPTZ DEFAULT now()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_reports (
      token TEXT PRIMARY KEY,
      name TEXT,
      report JSONB NOT NULL,
      summary JSONB,
      paid BOOLEAN DEFAULT false,
      stripe_session TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );`);
}

// ---------- Auth (Google OAuth) ----------
let passport = null;
if (teamEnabled) {
  const session = require('express-session');
  const PgSession = require('connect-pg-simple')(session);
  passport = require('passport');
  const GoogleStrategy = require('passport-google-oauth20').Strategy;

  app.use(session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret-set-SESSION_SECRET',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: BASE_URL.startsWith('https'),
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600 * 1000,
    },
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: BASE_URL + '/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = ((profile.emails && profile.emails[0] && profile.emails[0].value) || '').toLowerCase();
      if (!email) return done(null, false);
      if (cfg.teamEmails.length && !cfg.teamEmails.includes(email)) return done(null, false, { message: 'not_authorized' });
      const name = profile.displayName || '';
      await pool.query(
        `INSERT INTO users (email, name, google_sub, last_login) VALUES ($1,$2,$3, now())
         ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, google_sub=EXCLUDED.google_sub, last_login=now()`,
        [email, name, profile.id]);
      return done(null, { email, name });
    } catch (e) { return done(e); }
  }));
  passport.serializeUser((u, d) => d(null, u.email));
  passport.deserializeUser((email, d) => d(null, { email }));

  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get('/auth/google/callback', (req, res, next) => {
    passport.authenticate('google', (err, user, info) => {
      if (err) { console.error('OAuth callback error:', err && err.stack ? err.stack : err); return res.status(500).send('Login error: ' + (err && err.message ? err.message : String(err))); }
      if (!user) { return res.redirect('/web-analyzer-siteV7.html?login=denied'); }
      req.logIn(user, (e) => {
        if (e) { console.error('session logIn error:', e && e.stack ? e.stack : e); return res.status(500).send('Session error: ' + (e && e.message ? e.message : String(e))); }
        return res.redirect('/web-analyzer-siteV7.html?login=ok');
      });
    })(req, res, next);
  });
  app.get('/auth/logout', (req, res) => { req.logout(() => res.redirect('/web-analyzer-siteV7.html')); });
}

function loggedIn(req) { return !!(passport && req.isAuthenticated && req.isAuthenticated()); }
function requireAuth(req, res, next) {
  if (loggedIn(req)) return next();
  return res.status(401).json({ error: 'auth_required' });
}

// ---------- Public API: config ----------
app.get('/api/config', (req, res) => {
  res.json({
    teamEnabled,
    placesEnabled: cfg.places,
    geocodeEnabled: cfg.geocode,
    emailEnabled: cfg.email,
    stripeEnabled: cfg.stripe,
    reportPriceCents: REPORT_PRICE_CENTS,
    crmEnabled: teamEnabled,
    renderEnabled: !!process.env.RENDER_API_KEY,
    user: loggedIn(req) ? req.user : null,
  });
});

// ---------- SSRF-hardened server-side fetch ----------
const dns = require('dns').promises;
const net = require('net');
function ipIsPrivate(ipRaw) {
  let s = String(ipRaw || '').toLowerCase();
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) s = m[1]; // IPv4-mapped IPv6
  if (net.isIPv4(s)) {
    const p = s.split('.').map(Number);
    if (p.some(n => isNaN(n) || n < 0 || n > 255)) return true;
    if (p[0] === 0 || p[0] === 127 || p[0] === 10) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;              // link-local + cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;
    if (p[0] >= 224) return true;                                // multicast / reserved
    return false;
  }
  if (net.isIPv6(s)) {
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
    return false;
  }
  return true; // not a parseable IP → unsafe
}
// Block hostnames that are non-standard IP encodings (integer/hex/octal) used to slip past string checks.
function isBlockedHostname(hRaw) {
  const h = String(hRaw || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d+$/.test(h)) return true;                       // decimal integer IP (e.g. 2130706433 -> 127.0.0.1)
  if (/^0x[0-9a-f.]+$/i.test(h)) return true;             // hex
  if (/^0[0-7]/.test(h) && /^[0-7.]+$/.test(h)) return true; // octal dotted
  return false;
}
// Fast string-level gate (kept for the pre-fetch 403).
function isPrivateHost(hRaw) {
  if (isBlockedHostname(hRaw)) return true;
  const h = String(hRaw || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return ipIsPrivate(h);
  return false;
}
// Resolve the host and ensure EVERY resolved address is public (defeats "public-looking name → private IP").
async function assertPublicHost(hostname) {
  if (isBlockedHostname(hostname)) throw Object.assign(new Error('blocked host'), { code: 403 });
  if (net.isIP(hostname)) { if (ipIsPrivate(hostname)) throw Object.assign(new Error('blocked host'), { code: 403 }); return; }
  let addrs; try { addrs = await dns.lookup(hostname, { all: true }); } catch (e) { throw Object.assign(new Error('dns failed'), { code: 502 }); }
  if (!addrs.length || addrs.some(a => ipIsPrivate(a.address))) throw Object.assign(new Error('blocked host'), { code: 403 });
}
// Fetch that validates the initial host AND the final (post-redirect) host — blocks redirect-to-internal
// SSRF / cloud-metadata exfiltration. Residual: DNS rebinding between check and connect (follow-up: pin IP at connect).
async function guardedFetch(target, fetchOpts) {
  let u; try { u = new URL(target); } catch (e) { throw Object.assign(new Error('bad url'), { code: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('only http/https allowed'), { code: 400 });
  await assertPublicHost(u.hostname);
  const r = await fetch(u.href, Object.assign({ redirect: 'follow' }, fetchOpts || {}));
  try { const fu = new URL(r.url || u.href); if (fu.hostname !== u.hostname) await assertPublicHost(fu.hostname); }
  catch (e) { throw Object.assign(new Error('blocked host (redirect)'), { code: 403 }); }
  return r;
}
// ---------- tiny in-memory per-IP rate limiter (no dependency) ----------
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return function (req, res, next) {
    const now = Date.now(); const k = req.ip || 'anon';
    let e = hits.get(k);
    if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; hits.set(k, e); }
    e.count++;
    if (hits.size > 5000) { for (const [kk, vv] of hits) { if (now > vv.reset) hits.delete(kk); } } // opportunistic prune
    if (e.count > max) { res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000))); return res.status(429).send('rate limited — slow down'); }
    next();
  };
}
app.get('/api/proxy', rateLimit({ windowMs: 60000, max: 60 }), async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('missing url');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await guardedFetch(target, {
      signal: ctrl.signal,
      headers: {
        // Present as a real Chrome browser so header-based bot filters pass.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
      },
    });
    const body = await r.text();
    res.set('Access-Control-Allow-Origin', '*');
    // Detect interstitial bot-challenge pages (Cloudflare et al.) so the client
    // shows an accurate message rather than a generic proxy error.
    const challenged = (r.status === 403 || r.status === 503) &&
      /just a moment|cf-chl|challenge-platform|cf-mitigated|enable javascript and cookies/i.test(body);
    if (challenged) res.set('X-Proxy-Reason', 'bot-protection');
    res.status(challenged ? 502 : r.status).type('text/plain; charset=utf-8').send(body);
  } catch (e) {
    const code = e && e.code ? e.code : 502;
    res.status(code).send(code === 403 ? 'blocked host' : code === 400 ? 'bad url' : 'fetch failed: ' + (e && e.name ? e.name : 'error'));
  } finally { clearTimeout(t); }
});

// ---------- Headless rendering (JS sites) — key stays server-side; off until RENDER_API_KEY is set ----------
app.get('/api/render', rateLimit({ windowMs: 60000, max: 12 }), async (req, res) => {
  const key = process.env.RENDER_API_KEY;
  if (!key) return res.status(503).send('render_not_configured');
  const target = req.query.url;
  if (!target) return res.status(400).send('missing url');
  let u; try { u = new URL(target); } catch (e) { return res.status(400).send('bad url'); }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).send('only http/https allowed');
  if (isPrivateHost(u.hostname)) return res.status(403).send('blocked host');
  const provider = (process.env.RENDER_PROVIDER || 'scrapingbee').toLowerCase();
  const api = provider === 'scraperapi'
    ? 'https://api.scraperapi.com/?api_key=' + encodeURIComponent(key) + '&render=true&url=' + encodeURIComponent(u.href)
    : 'https://app.scrapingbee.com/api/v1/?api_key=' + encodeURIComponent(key) + '&render_js=true&url=' + encodeURIComponent(u.href);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(api, { signal: ctrl.signal });
    const body = await r.text();
    res.set('Access-Control-Allow-Origin', '*');
    res.status(r.ok ? 200 : 502).type('text/plain; charset=utf-8').send(body);
  } catch (e) {
    res.status(502).send('render failed');
  } finally { clearTimeout(t); }
});

// ---------- Email (Resend) ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function sendEmail({ to, subject, html, text, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true };
  const from = process.env.MAIL_FROM || 'Blue Collar AI <onboarding@resend.dev>';
  try {
    const body = { from, to: Array.isArray(to) ? to : [to], subject, html, reply_to: replyTo };
    if (text) body.text = text;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('email send failed', r.status, t); return { ok: false, status: r.status, body: t }; }
    return { ok: true };
  } catch (e) { console.error('email error', e.message); return { ok: false, error: e.message }; }
}

// ---------- CRM helpers ----------
function normDomain(u) {
  if (!u) return '';
  let s = String(u).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return s;
}
async function geocode(query) {
  if (!query || !pool) return null;
  const norm = String(query).trim().toLowerCase();
  if (!norm) return null;
  try {
    const c = await pool.query('SELECT lat, lng FROM geocache WHERE q=$1', [norm]);
    if (c.rows.length) return { lat: c.rows[0].lat, lng: c.rows[0].lng };
  } catch (e) {}
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.PLACES_API_KEY;
  if (!key) return null;
  try {
    const j = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${key}`).then(r => r.json());
    const loc = j.results && j.results[0] && j.results[0].geometry && j.results[0].geometry.location;
    if (!loc) return null;
    try { await pool.query('INSERT INTO geocache (q, lat, lng) VALUES ($1,$2,$3) ON CONFLICT (q) DO NOTHING', [norm, loc.lat, loc.lng]); } catch (e) {}
    return { lat: loc.lat, lng: loc.lng };
  } catch (e) { return null; }
}
async function membershipsFor(domain) {
  if (!pool || !domain) return [];
  try {
    const r = await pool.query('SELECT DISTINCT association FROM crm_members WHERE domain=$1', [domain]);
    return r.rows.map(x => x.association);
  } catch (e) { return []; }
}

// ---------- Lead capture (public) ----------
app.post('/api/lead', rateLimit({ windowMs: 600000, max: 5 }), async (req, res) => {
  const { email, url, meta } = req.body || {};
  if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: 'valid email required' });
  const clean = email.trim().toLowerCase();
  let stored = false;
  if (pool) {
    try { await pool.query('INSERT INTO leads (email, url, meta) VALUES ($1,$2,$3)', [clean, url || null, meta ? JSON.stringify(meta) : null]); stored = true; }
    catch (e) { console.error('lead store failed', e.message); }
  }
  let emailed = false;
  if (process.env.RESEND_API_KEY) {
    const sites = (meta && Array.isArray(meta.summary))
      ? meta.summary.map(s => `${escapeHtml(s.domain)}: ${s.error ? '—' : (escapeHtml(s.grade) + ' (' + s.score + ')')}`).join('<br>')
      : escapeHtml(url || '');
    // A) Alert the team of a new lead
    const n = await sendEmail({
      to: process.env.LEAD_NOTIFY_TO || clean,
      replyTo: clean,
      subject: `New audit lead: ${clean}`,
      html: `<h2>New SEO audit lead</h2><p><b>Email:</b> ${escapeHtml(clean)}<br><b>Requested:</b> ${escapeHtml(url || '')}</p><p><b>Scores:</b><br>${sites}</p>`,
    });
    emailed = !!(n && n.ok);
    // B) Thank the prospect (requires a verified sending domain in Resend)
    await sendEmail({
      to: clean,
      replyTo: process.env.LEAD_NOTIFY_TO || undefined,
      subject: 'Your SEO & AI Search audit — Blue Collar AI',
      html: `<h2>Thanks for running an audit</h2>
        <p>Here's a snapshot of what we found:</p>
        <p>${sites}</p>
        <p>Every issue in your report is fixable — usually faster than you'd think. Blue Collar AI helps local businesses turn audits like this into more calls and higher rankings in both Google <i>and</i> the new AI search tools.</p>
        <p>Just reply and we'll walk you through your results and a plan — no obligation.</p>
        <p style="color:#64748b;font-size:13px">Blue Collar AI, Inc. · AI-Powered Local SEO · www.bluecollarai.online</p>`,
    });
  }
  res.json({ ok: true, stored, emailed });
});

// ---------- Google Places reviews (server-side, optional) ----------
app.get('/api/places', rateLimit({ windowMs: 60000, max: 20 }), async (req, res) => {
  if (!cfg.places) return res.status(503).json({ error: 'places_not_configured' });
  const query = (req.query.q || req.query.name || '').trim();
  if (!query) return res.status(400).json({ error: 'q_required' });
  const key = process.env.PLACES_API_KEY;
  try {
    const ts = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${key}`).then(r => r.json());
    const first = ts.results && ts.results[0];
    if (!first) return res.json({ found: false });
    const det = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${first.place_id}&fields=name,rating,user_ratings_total,url,formatted_address,formatted_phone_number,reviews&key=${key}`).then(r => r.json());
    const d = det.result || {};
    res.json({
      found: true,
      name: d.name, rating: d.rating, reviews: d.user_ratings_total,
      address: d.formatted_address, phone: d.formatted_phone_number, mapsUrl: d.url,
      recent: (d.reviews || []).slice(0, 3).map(x => ({ author: x.author_name, rating: x.rating, text: x.text, when: x.relative_time_description })),
    });
  } catch (e) { res.status(502).json({ error: 'places_failed' }); }
});

// ---------- Team reports API (protected) ----------
app.get('/api/reports', requireAuth, async (req, res) => {
  const raw = (req.query.q || '').trim();
  const q = '%' + raw + '%';
  try {
    const { rows } = await pool.query(
      `SELECT id, name, customer, created_by, created_at, summary,
              COALESCE(array_length(urls,1),0) AS count
         FROM report_runs
        WHERE $1 = '' OR name ILIKE $2 OR COALESCE(customer,'') ILIKE $2
           OR COALESCE(array_to_string(urls,' '),'') ILIKE $2
        ORDER BY created_at DESC
        LIMIT 300`, [raw, q]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'list_failed' }); }
});
app.post('/api/reports', requireAuth, async (req, res) => {
  const { name, customer, reports, summary } = req.body || {};
  if (!name || !Array.isArray(reports) || !reports.length) return res.status(400).json({ error: 'name_and_reports_required' });
  const urls = reports.map(r => r.url || r.domain || '').filter(Boolean);
  const sum = Array.isArray(summary) ? summary : reports.map(r => ({ domain: r.domain, error: !!r.error }));
  try {
    const { rows } = await pool.query(
      `INSERT INTO report_runs (name, customer, urls, results, summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, customer || null, urls, JSON.stringify(reports), JSON.stringify(sum), req.user.email]);
    res.json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: 'save_failed' }); }
});
app.get('/api/reports/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM report_runs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'get_failed' }); }
});
app.delete('/api/reports/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM report_runs WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'delete_failed' }); }
});

// Send a finished report to a client (team-only — protects sending reputation)
app.post('/api/send-report', requireAuth, async (req, res) => {
  const { to, subject, html, text } = req.body || {};
  if (!to || !/.+@.+\..+/.test(to) || !html) return res.status(400).json({ error: 'to_and_html_required' });
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'email_not_configured' });
  const r = await sendEmail({ to, subject: subject || 'Your SEO Audit', html, text, replyTo: req.user.email });
  if (r && r.ok) return res.json({ ok: true });
  return res.status(502).json({ error: 'send_failed', detail: (r && (r.body || r.error)) || null });
});

// ---------- CRM API (team-only) ----------
app.post('/api/crm/businesses/bulk', requireAuth, async (req, res) => {
  const items = Array.isArray(req.body && req.body.businesses) ? req.body.businesses : [];
  if (!items.length) return res.status(400).json({ error: 'no_businesses' });
  let imported = 0, skipped = 0;
  for (const b of items) {
    const domain = normDomain(b.website || b.domain || '');
    if (!domain) { skipped++; continue; }
    let lat = (b.lat != null && b.lat !== '') ? Number(b.lat) : null;
    let lng = (b.lng != null && b.lng !== '') ? Number(b.lng) : null;
    if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
      const q = [b.address, b.city, b.state, b.zip].filter(Boolean).join(', ');
      const g = q ? await geocode(q) : null;
      if (g) { lat = g.lat; lng = g.lng; } else { lat = lat == null || isNaN(lat) ? null : lat; lng = lng == null || isNaN(lng) ? null : lng; }
    }
    const memberships = await membershipsFor(domain);
    try {
      await pool.query(
        `INSERT INTO crm_businesses (name,domain,website,industry,address,city,state,zip,lat,lng,phone,email,memberships,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
         ON CONFLICT (domain) DO UPDATE SET
           name=COALESCE(EXCLUDED.name,crm_businesses.name),
           website=COALESCE(EXCLUDED.website,crm_businesses.website),
           industry=COALESCE(EXCLUDED.industry,crm_businesses.industry),
           address=COALESCE(EXCLUDED.address,crm_businesses.address),
           city=COALESCE(EXCLUDED.city,crm_businesses.city),
           state=COALESCE(EXCLUDED.state,crm_businesses.state),
           zip=COALESCE(EXCLUDED.zip,crm_businesses.zip),
           lat=COALESCE(EXCLUDED.lat,crm_businesses.lat),
           lng=COALESCE(EXCLUDED.lng,crm_businesses.lng),
           phone=COALESCE(EXCLUDED.phone,crm_businesses.phone),
           email=COALESCE(EXCLUDED.email,crm_businesses.email),
           memberships=EXCLUDED.memberships,
           updated_at=now()`,
        [b.name || null, domain, b.website || ('https://' + domain), b.industry || null, b.address || null,
         b.city || null, b.state || null, b.zip || null, lat, lng, b.phone || null, b.email || null, JSON.stringify(memberships)]);
      imported++;
    } catch (e) { console.error('crm import row', e.message); skipped++; }
  }
  res.json({ ok: true, imported, skipped });
});

app.get('/api/crm/businesses', requireAuth, async (req, res) => {
  try {
    const { state, city, industry, status, q, grades, association, member, center, radiusMi } = req.query;
    const cond = []; const p = [];
    const push = (sql, val) => { p.push(val); cond.push(sql.replace('?', '$' + p.length)); };
    if (state) push('state ILIKE ?', state);
    if (city) push('city ILIKE ?', city);
    if (industry) push('industry ILIKE ?', industry);
    if (status) push('status = ?', status);
    if (q) { p.push('%' + q + '%'); const idx = '$' + p.length; cond.push(`(name ILIKE ${idx} OR domain ILIKE ${idx})`); }
    if (grades) { const gs = String(grades).split(',').map(s => s.trim().toUpperCase()).filter(Boolean); if (gs.length) push('(latest_grade = ANY(?) OR latest_grade IS NULL)', gs); }
    if (association) {
      if (member === 'no') push('NOT (memberships @> ?::jsonb)', JSON.stringify([association]));
      else if (member === 'yes') push('memberships @> ?::jsonb', JSON.stringify([association]));
    }
    let distSel = '', order = 'ORDER BY updated_at DESC';
    if (center && radiusMi) {
      const g = await geocode(center);
      if (g) {
        p.push(g.lat); const la = '$' + p.length;
        p.push(g.lng); const lo = '$' + p.length;
        p.push(Number(radiusMi)); const rd = '$' + p.length;
        const hav = `(3959*acos(LEAST(1, cos(radians(${la}))*cos(radians(lat))*cos(radians(lng)-radians(${lo}))+sin(radians(${la}))*sin(radians(lat)))))`;
        distSel = `, ${hav} AS dist_mi`;
        cond.push('lat IS NOT NULL AND lng IS NOT NULL');
        cond.push(`${hav} <= ${rd}`);
        order = 'ORDER BY dist_mi ASC';
      }
    }
    const whereSql = cond.length ? ('WHERE ' + cond.join(' AND ')) : '';
    const sql = `SELECT id,name,domain,website,industry,address,city,state,zip,lat,lng,phone,email,latest_score,latest_grade,last_audit_at,status,follow_up,notes,memberships,alliance_status${distSel}
                 FROM crm_businesses ${whereSql} ${order} LIMIT 2000`;
    const { rows } = await pool.query(sql, p);
    res.json(rows);
  } catch (e) { console.error('crm list', e.message); res.status(500).json({ error: 'list_failed' }); }
});

app.post('/api/crm/geocode-missing', requireAuth, async (req, res) => {
  if (!cfg.geocode) return res.status(503).json({ error: 'geocode_not_configured' });
  let done = 0, failed = 0;
  try {
    const { rows } = await pool.query(
      `SELECT id, address, city, state, zip FROM crm_businesses
        WHERE (lat IS NULL OR lng IS NULL) AND (city IS NOT NULL OR address IS NOT NULL OR zip IS NOT NULL) LIMIT 500`);
    for (const b of rows) {
      const q = [b.address, b.city, b.state, b.zip].filter(Boolean).join(', ');
      const g = q ? await geocode(q) : null;
      if (g) { await pool.query('UPDATE crm_businesses SET lat=$1, lng=$2, updated_at=now() WHERE id=$3', [g.lat, g.lng, b.id]); done++; }
      else failed++;
    }
    res.json({ ok: true, geocoded: done, failed });
  } catch (e) { console.error('geocode-missing', e.message); res.status(500).json({ error: 'backfill_failed' }); }
});

app.get('/api/crm/facets', requireAuth, async (req, res) => {
  try {
    const states = (await pool.query(`SELECT DISTINCT state FROM crm_businesses WHERE state IS NOT NULL AND state<>'' ORDER BY state`)).rows.map(r => r.state);
    const industries = (await pool.query(`SELECT DISTINCT industry FROM crm_businesses WHERE industry IS NOT NULL AND industry<>'' ORDER BY industry`)).rows.map(r => r.industry);
    const associations = (await pool.query(`SELECT DISTINCT association FROM crm_members ORDER BY association`)).rows.map(r => r.association);
    res.json({ states, industries, associations });
  } catch (e) { res.status(500).json({ error: 'facets_failed' }); }
});

app.post('/api/crm/businesses', requireAuth, async (req, res) => {
  const b = req.body || {};
  const domain = normDomain(b.website || b.domain || '') || null;
  let lat = null, lng = null;
  const q = [b.address, b.city, b.state, b.zip].filter(Boolean).join(', ');
  if (q) { const g = await geocode(q); if (g) { lat = g.lat; lng = g.lng; } }
  const memberships = domain ? await membershipsFor(domain) : [];
  try {
    const { rows } = await pool.query(
      `INSERT INTO crm_businesses (name,domain,website,industry,address,city,state,zip,lat,lng,phone,email,
         owner_name,owner_phone,owner_email,manager_name,manager_phone,manager_email,memberships,alliance_status,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now())
       ON CONFLICT (domain) DO UPDATE SET
         name=EXCLUDED.name, website=EXCLUDED.website, industry=EXCLUDED.industry, address=EXCLUDED.address,
         city=EXCLUDED.city, state=EXCLUDED.state, zip=EXCLUDED.zip,
         lat=COALESCE(EXCLUDED.lat,crm_businesses.lat), lng=COALESCE(EXCLUDED.lng,crm_businesses.lng),
         phone=EXCLUDED.phone, email=EXCLUDED.email,
         owner_name=EXCLUDED.owner_name, owner_phone=EXCLUDED.owner_phone, owner_email=EXCLUDED.owner_email,
         manager_name=EXCLUDED.manager_name, manager_phone=EXCLUDED.manager_phone, manager_email=EXCLUDED.manager_email,
         alliance_status=EXCLUDED.alliance_status, updated_at=now()
       RETURNING id`,
      [b.name || null, domain, b.website || null, b.industry || null, b.address || null, b.city || null, b.state || null, b.zip || null,
       lat, lng, b.phone || null, b.email || null, b.owner_name || null, b.owner_phone || null, b.owner_email || null,
       b.manager_name || null, b.manager_phone || null, b.manager_email || null, JSON.stringify(memberships), b.alliance_status || null]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { console.error('crm create', e.message); res.status(500).json({ error: 'create_failed' }); }
});

app.post('/api/crm/businesses/:id/report', requireAuth, async (req, res) => {
  const { report, score, grade } = req.body || {};
  if (!report) return res.status(400).json({ error: 'report_required' });
  try {
    await pool.query('UPDATE crm_businesses SET last_report=$1, latest_score=$2, latest_grade=$3, last_audit_at=now(), updated_at=now() WHERE id=$4',
      [JSON.stringify(report), (score == null ? null : score), grade || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('crm attach', e.message); res.status(500).json({ error: 'attach_failed' }); }
});

// Upsert a business by website and attach a just-run report (field workflow)
app.post('/api/crm/attach', requireAuth, async (req, res) => {
  const { website, name, report, score, grade } = req.body || {};
  const domain = normDomain(website || '');
  if (!domain || !report) return res.status(400).json({ error: 'website_and_report_required' });
  const memberships = await membershipsFor(domain);
  try {
    const { rows } = await pool.query(
      `INSERT INTO crm_businesses (name,domain,website,memberships,last_report,latest_score,latest_grade,last_audit_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
       ON CONFLICT (domain) DO UPDATE SET
         name=COALESCE(crm_businesses.name, EXCLUDED.name),
         website=COALESCE(crm_businesses.website, EXCLUDED.website),
         last_report=EXCLUDED.last_report, latest_score=EXCLUDED.latest_score,
         latest_grade=EXCLUDED.latest_grade, last_audit_at=now(), updated_at=now()
       RETURNING id, (xmax = 0) AS inserted`,
      [name || domain, domain, website || ('https://' + domain), JSON.stringify(memberships),
       JSON.stringify(report), (score == null ? null : score), grade || null]);
    const row = rows[0];
    res.json({ ok: true, id: row.id, created: row.inserted });
    // Notify admin to complete the profile for brand-new field saves
    if (row.inserted && process.env.RESEND_API_KEY) {
      const adminTo = process.env.LEAD_NOTIFY_TO || cfg.teamEmails[0] || req.user.email;
      sendEmail({
        to: adminTo, replyTo: req.user.email,
        subject: `New field audit — ${domain} needs a CRM profile`,
        html: `<p><b>${escapeHtml(name || domain)}</b> (${escapeHtml(domain)}) was audited in the field by ${escapeHtml(req.user.email)}.</p>
          <p>Result: <b>Grade ${escapeHtml(grade || '—')}${score != null ? (' · ' + score + '/100') : ''}</b></p>
          <p>Please complete the profile — owner/manager contacts, address, industry, alliance status.</p>
          <p><a href="${BASE_URL}">Open the CRM</a> → <b>Leads</b> → search "${escapeHtml(domain)}".</p>`,
        text: `New field audit: ${name || domain} (${domain}) by ${req.user.email}. Grade ${grade || '—'}${score != null ? (' ' + score + '/100') : ''}. Complete the CRM profile: ${BASE_URL} (Leads > search ${domain}).`,
      }).catch(() => {});
    }
  } catch (e) { console.error('crm attach-new', e.message); res.status(500).json({ error: 'attach_failed' }); }
});

app.get('/api/crm/businesses/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM crm_businesses WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'get_failed' }); }
});

app.patch('/api/crm/businesses/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const sets = []; const p = []; let i = 1;
  for (const f of ['name', 'website', 'industry', 'phone', 'email', 'address', 'city', 'state', 'zip', 'status', 'notes', 'follow_up',
                   'owner_name', 'owner_phone', 'owner_email', 'manager_name', 'manager_phone', 'manager_email', 'alliance_status']) {
    if (f in b) { sets.push(`${f}=$${i++}`); p.push(b[f] === '' ? null : b[f]); }
  }
  try {
    if (b.comment) {
      const c = { text: String(b.comment), by: req.user.email, at: new Date().toISOString() };
      sets.push(`comments = COALESCE(comments,'[]'::jsonb) || $${i++}::jsonb`); p.push(JSON.stringify([c]));
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    sets.push('updated_at=now()');
    p.push(req.params.id);
    const { rows } = await pool.query(`UPDATE crm_businesses SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, p);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { console.error('crm patch', e.message); res.status(500).json({ error: 'update_failed' }); }
});

app.delete('/api/crm/businesses/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM crm_businesses WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'delete_failed' }); }
});

app.post('/api/crm/members/import', requireAuth, async (req, res) => {
  const association = ((req.body && req.body.association) || '').trim();
  const members = Array.isArray(req.body && req.body.members) ? req.body.members : [];
  if (!association || !members.length) return res.status(400).json({ error: 'association_and_members_required' });
  let n = 0;
  for (const m of members) {
    const domain = normDomain(m.website || m.domain || '');
    if (!domain && !m.name) continue;
    try { await pool.query('INSERT INTO crm_members (association, domain, name) VALUES ($1,$2,$3)', [association, domain || null, m.name || null]); n++; } catch (e) {}
  }
  try {
    await pool.query(
      `UPDATE crm_businesses b SET memberships = b.memberships || to_jsonb($1::text), updated_at=now()
        WHERE b.domain IN (SELECT domain FROM crm_members WHERE association=$1 AND domain IS NOT NULL)
          AND NOT (b.memberships @> to_jsonb($1::text))`, [association]);
  } catch (e) { console.error('crm retag', e.message); }
  res.json({ ok: true, imported: n });
});

// ---------- Shared paid report (DIY $49 flow) ----------
const crypto = require('crypto');
async function stripeCreateCheckout(token, name) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const p = new URLSearchParams();
  p.set('mode', 'payment');
  p.set('success_url', BASE_URL + '/r/' + token + '?session_id={CHECKOUT_SESSION_ID}');
  p.set('cancel_url', BASE_URL + '/r/' + token);
  p.set('client_reference_id', token);
  p.set('line_items[0][quantity]', '1');
  p.set('line_items[0][price_data][currency]', 'usd');
  p.set('line_items[0][price_data][unit_amount]', String(REPORT_PRICE_CENTS));
  p.set('line_items[0][price_data][product_data][name]', 'Full SEO & AI Search Report' + (name ? (' — ' + name) : ''));
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: p.toString(),
    });
    if (!r.ok) { console.error('stripe checkout', r.status, await r.text().catch(() => '')); return null; }
    return (await r.json()).url;
  } catch (e) { console.error('stripe checkout err', e.message); return null; }
}
async function stripeSessionPaid(sessionId) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !sessionId) return false;
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId), { headers: { 'Authorization': 'Bearer ' + key } });
    if (!r.ok) return false;
    return (await r.json()).payment_status === 'paid';
  } catch (e) { return false; }
}
// Team creates a shareable report link
app.post('/api/shared', requireAuth, async (req, res) => {
  const { report, name, summary } = req.body || {};
  if (!report) return res.status(400).json({ error: 'report_required' });
  const token = crypto.randomBytes(9).toString('hex');
  try {
    await pool.query('INSERT INTO shared_reports (token,name,report,summary) VALUES ($1,$2,$3,$4)',
      [token, name || null, JSON.stringify(report), summary ? JSON.stringify(summary) : null]);
    res.json({ token, url: BASE_URL + '/r/' + token, buy: BASE_URL + '/buy/' + token });
  } catch (e) { console.error('share', e.message); res.status(500).json({ error: 'share_failed' }); }
});
// Public: fetch a shared report (full report only if paid)
app.get('/api/shared/:token', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'not_configured' });
  try {
    const { rows } = await pool.query('SELECT name,report,summary,paid FROM shared_reports WHERE token=$1', [req.params.token]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const row = rows[0];
    res.json({ name: row.name, paid: row.paid, summary: row.summary, report: row.paid ? row.report : null, stripeEnabled: cfg.stripe });
  } catch (e) { res.status(500).json({ error: 'load_failed' }); }
});
// Public: after Stripe returns, verify + unlock
app.post('/api/shared/:token/claim', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'not_configured' });
  try {
    const paid = await stripeSessionPaid((req.body || {}).session_id);
    if (!paid) return res.json({ paid: false });
    await pool.query('UPDATE shared_reports SET paid=true, stripe_session=$1 WHERE token=$2', [(req.body || {}).session_id || null, req.params.token]);
    const { rows } = await pool.query('SELECT name,report,summary FROM shared_reports WHERE token=$1', [req.params.token]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ paid: true, name: rows[0].name, report: rows[0].report, summary: rows[0].summary });
  } catch (e) { res.status(500).json({ error: 'claim_failed' }); }
});
// Public: start checkout
app.get('/buy/:token', async (req, res) => {
  if (!pool) return res.status(503).send('Not configured');
  try {
    const { rows } = await pool.query('SELECT name FROM shared_reports WHERE token=$1', [req.params.token]);
    if (!rows.length) return res.status(404).send('Report not found');
    if (!cfg.stripe) return res.redirect('/r/' + req.params.token + '?nostripe=1');
    const url = await stripeCreateCheckout(req.params.token, rows[0].name);
    return url ? res.redirect(url) : res.redirect('/r/' + req.params.token + '?payerr=1');
  } catch (e) { res.status(500).send('error'); }
});
// Public: the hosted report page (app HTML handles render/teaser by token)
app.get('/r/:token', (req, res) => res.sendFile(path.join(__dirname, 'web-analyzer-siteV7.html')));

app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));
// DB connectivity check (no secrets) — helps diagnose login/session failures
app.get('/healthz/db', async (req, res) => {
  if (!pool) return res.json({ db: false });
  try { await pool.query('SELECT 1'); res.json({ db: true, ok: true }); }
  catch (e) { res.status(500).json({ db: true, ok: false, error: e.message }); }
});

// ---------- Static public tool ----------
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Log the real error behind any 500 (e.g. failed login/session writes)
app.use((err, req, res, next) => {
  console.error('Unhandled error on', req.method, req.path, '-', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).send('Internal Server Error');
});

(async () => {
  try { await migrate(); if (pool) console.log('DB ready'); }
  catch (e) { console.error('DB migrate failed (team features may be off):', e.message); }
  app.listen(PORT, () => {
    console.log(`SEO audit server on :${PORT} | team=${teamEnabled} places=${cfg.places} email=${cfg.email} whitelist=${cfg.teamEmails.length}`);
  });
})();
