# PROJECT STATE — Blue Collar AI SEO tools (handoff)

**Read this first in any new chat.** Last updated 2026-07-22. Owner: Chris, Blue Collar AI, Inc.
(also US Tow Alliance / US Auto Alliance). Companion: `SEO_ENGINE_SPEC.md` (the v2 spec).

## Two products, two repos, two Railway deploys
1. **Public SEO tool** — repo `chrispeer69/seoreview`, file `web-analyzer-siteV7.html` + `server.js`.
   Live: **https://seoreview-production.up.railway.app/web-analyzer-siteV7.html**
2. **CRM ("Blue Collar AI CRM")** — repo `chrispeer69/CRMColumbus`, `public/index.html` +
   `public/seo-engine.js` + `server.js`. Map-first field-sales CRM with SEO merged in.
   Live: **https://crmcolumbus-production.up.railway.app**

Local paths: seoreview = `C:\Users\chris\OneDrive\Desktop\Website Files\Web Site SEO`;
CRM = `C:\Users\chris\OneDrive\Desktop\CRMColumbus`. Railway auto-deploys on push to `main`.

## The audit engine is DUPLICATED in both repos — keep them in sync
- CRM canonical module: `CRMColumbus/public/seo-engine.js` (exposes `window.SEO`).
- Public tool: same functions embedded inline in `web-analyzer-siteV7.html`.
- **Any engine change must be applied to BOTH files identically.** They have drifted before
  (bland report, missing branding) — always mirror + verify both.

## What the tool does now (both tools, identical)
- **Single-page audit** (public "Run Audit" / CRM "Audit 1 page") → branded report (score, grade,
  Page Speed via PSI, category bars, Why-AI-Search explainer, contacts/CTA). Public also does
  multi-site + competitor **comparison** report.
- **Whole-site crawl** (green "🌐 Crawl entire site" button) → `SEO.crawlSite()`:
  - Page discovery: robots.txt `Sitemap:` + `/sitemap.xml` (index-aware, one retry); falls back to
    homepage link-crawl, **render-assisted** if a JS site has no sitemap.
  - Audits every page concurrently (6), retries a failed page once (slow/throttling origins) then
    render-fallback before marking failed. Skips per-page PageSpeed (that's why it's fast).
  - Cross-page analysis: duplicate titles/H1/bodies, title↔body mismatch, thin pages, JS-rendered
    shells, missing H1.
  - **Server speed panel** (prominent, under site score): per-page response time avg/median/max +
    slowest pages; verdict fast<800ms / moderate<1800ms / slow. (TTFB + crawl-budget signal.)
  - **Local presence** (Phase 2): Google Business Profile found?, rating, review count (low-review
    warning <20), NAP, Maps link — via Places.
  - Branded `siteReportHTML`: header + Why-AI-Search + contacts/CTA; Print (landscape for
    comparison) + Save-as-document (CRM).
- **JS rendering seam** (`opts.render`): pluggable, key server-side. **LIVE** — `RENDER_API_KEY`
  set in both Railway projects (ScrapingBee). Verified: columbusroadsidetowing.com raw 450w →
  rendered 2732w.
- CRM extras: bulk "Audit all / Audit missing-only" per market, Search (filter incl. has-email),
  "Email in Gmail" BCC group send, Compare selected, shop drawer with owner/manager/alliance/
  voice-AI/CC fields, back-button closes drawer (no logout).

## Machine API for other sites (`/api/v1`, public tool only) — added 2026-09-12
- `api-v1.js` + `headless-audit.js`: runs the public tool's engine in **jsdom on the server** (same
  `crawlSite()`/`siteReportHTML()` as the browser, no second copy) and exposes whole-site audits over
  `X-API-Key` auth. Contract lives in `chrispeer69/google-review-site/docs/seo-engine-api.md`; this
  side's docs in `API.md`. Endpoints: `POST /api/v1/audits`, `GET /api/v1/audits/:id`,
  `GET /api/v1/audits/latest?domain=`, `POST /api/v1/audits/status`, `GET /report/:id?t=` (HTML).
- Idempotent per domain for 30 days, signed HMAC callback (`X-Signature`), audits persist in Postgres
  table `seo_audits` (memory fallback without DB). Consumer = Review Intelligence Terminal (google-review-site).
- Verified 2026-09-12 locally: excitecollisionrepair.com → C 79, 21 pages in 6 s; failure path clean.

## Activation / env vars (Railway, per project — NEVER commit secrets)
- Public tool API: `SEO_API_KEY` (required to enable /api/v1), `SEO_WEBHOOK_SECRET` (callback HMAC; defaults
  to the key), optional `SEO_API_MAX_PAGES` (100), `SEO_API_REUSE_DAYS` (30), `SEO_API_CONCURRENCY` (2),
  `SEO_API_TIMEOUT_SEC` (600).
- Shared: `RENDER_API_KEY` (ScrapingBee, SET ✓), optional `RENDER_PROVIDER` (scrapingbee default /
  scraperapi), `PLACES_API_KEY` (Places+Geocoding enabled ✓), `PAGESPEED_KEY`, `RESEND_API_KEY`,
  `MAIL_FROM` (code forces display name "Blue Collar AI"), `STRIPE_SECRET_KEY`, `BASE_URL`.
- CRM auth = shared-password cookie. Public tool = Google OAuth (team) + public audit.
- PageSpeed key baked in committed `config.js` (referrer-restricted) — the one exception.

## Verified proof points
- excitecollisionrepair.com crawl: **13/13 via sitemap, 0 failed** (was 4/14) after discovery+retry fix.
- columbusroadsidetowing.com: 74/74, caught 12 duplicate-body pages + 27 thin (single-page said 98).
- ustowalliance.com: 3,646 sitemap URLs, sampled fast.

## Still TODO
- **Phase 3 — Authority**: backlinks + competitor keyword gaps via a LICENSED data API the owner
  funds (DataForSEO cheapest pay-as-you-go). Build behind the same abstraction; needs provider +
  budget + API key from owner.
- **Alliance-profile tracking (ON HOLD, owner thinking it through)**: towing→ustowalliance.com,
  auto→usautoalliance.com (same DB, diff landing). Want: mark profile-holder → auto-check profile
  exists → if missing, future AI agent creates it. BLOCKER: alliance sites are currently empty
  directory shells (no per-business profile URLs / API). Agreed plan: profile status + URL
  (category-aware) + "needs profile" worklist; confirm = fetch profile URL 200 + name match.
- **Weekly AI prospecting agent** (deferred): auto-discover + import new companies per market.

## Working rules for this owner (important)
- Minimize turns/rework — it costs real money. Batch work; don't over-ask.
- **Never claim "done" on unverified work.** Verify with a real headless-DOM (jsdom) / live run
  before saying it works. Regression harness: `CRMColumbus/_audit_test.js` (git-ignored).
- State scope/limitations up front; a tool doing less than assumed reads as "half-ass work."
- For big builds: spec → approve → build once → prove on real sites.

## Current commit heads
- CRM `CRMColumbus`: `6ce8c57`
- Public `seoreview`: `da6b506`
