# SEO Review Engine — machine API (`/api/v1`)

Lets another system (the Review Intelligence Terminal, the CRM, scripts) request a **whole-site SEO & AI-search
audit** and read the graded result as JSON. Implements the contract in
`chrispeer69/google-review-site/docs/seo-engine-api.md`.

Audits run on the server through the public tool's own engine (`web-analyzer-siteV7.html` loaded in jsdom —
see `headless-audit.js`), so API grades match what the browser tool's "Crawl entire site" produces.

## Setup (Railway variables on the seoreview service)

| Variable | Required | Meaning |
|---|---|---|
| `SEO_API_KEY` | yes | The shared key callers send as `X-API-Key`. Unset = `/api/v1` answers `503 api_not_configured`. |
| `SEO_WEBHOOK_SECRET` | no | HMAC secret for signed callbacks. Defaults to `SEO_API_KEY`. |
| `SEO_API_MAX_PAGES` | no | Pages graded per audit (default 100, 5–300). |
| `SEO_API_REUSE_DAYS` | no | Reuse window for repeat requests on a domain (default 30; 0 = always re-crawl). |
| `SEO_API_CONCURRENCY` | no | Audits crawled at once (default 2). Each crawl fetches 4 pages in parallel. |
| `SEO_API_TIMEOUT_SEC` | no | Per-audit time limit (default 600). |
| `DATABASE_URL` | recommended | Audits persist in Postgres table `seo_audits`. Without it they live in memory and vanish on restart. |
| `PLACES_API_KEY` | no | Enables the `local` block (Google Business Profile match, rating, review count). |
| `RENDER_API_KEY` | no | Enables JS rendering for JavaScript-only sites (ScrapingBee). |

## Auth

Every `/api/v1/*` request: `X-API-Key: <SEO_API_KEY>` (or `Authorization: Bearer <SEO_API_KEY>`).
Missing/wrong → `401 {"error":"unauthorized"}`. No cookies involved.

```bash
curl -s https://seoreview-production.up.railway.app/api/v1/ping -H "X-API-Key: $SEO_API_KEY"
```

## Endpoints

### `POST /api/v1/audits` — request an audit
```json
{ "domain": "speedytowingservice.com",
  "external_id": "rit:103",
  "callback_url": "https://<tracker>/api/webhooks/seo",
  "force": false }
```
* `domain` — bare domain or full URL; normalized (lower-case, no `www.`, no path).
* `external_id` — echoed back in every response for this audit.
* `callback_url` — optional; must be a public `http(s)` URL. The finished audit is POSTed there (see Callback).
* `force` — `true` re-crawls even if a recent audit exists.

Responses (body is always the full audit object below, plus `reused`):
* `202` `status: queued` — new audit started (`reused: false`).
* `202` `status: queued|running` — an audit for this domain is already in flight; you are attached to it (`reused: true`).
* `200` `status: done`, `reused: true` — a finished audit newer than `SEO_API_REUSE_DAYS` exists and `force` was not set.
* `400` `domain_required` / `invalid_domain` / `invalid_callback_url`.

Failed audits are never reused — a new request re-crawls.

### `GET /api/v1/audits/{audit_id}` — poll
`200` with the audit object; `404 {"error":"not_found"}`.

### `GET /api/v1/audits/latest?domain=…`
Newest **done** audit for the domain (or, if none is done yet, the newest of any status). `404 {"error":"no_audit"}`.

### `POST /api/v1/audits/status` — batch poll
`{ "audit_ids": ["a_1","a_2"] }` → `{ "audits": [ …audit objects without pages[]… ] }`. Unknown ids come back as `{"audit_id":"a_x","status":"not_found"}`. Max 100 ids.

### `GET /api/v1/audits/{audit_id}/report` — branded HTML report (API key)
### `GET /report/{audit_id}?t={token}` — same report, shareable link (no API key)
This is the `report_url` in every finished audit. The token is per-audit; without it the page answers 401.

### `GET /api/v1/ping`
`{ ok, storage: "postgres"|"memory", features: { render, places }, limits: {…}, queue: {…} }`.

## The audit object

```json
{
  "audit_id": "a_09e25d9656c27239",
  "external_id": "rit:103",
  "domain": "speedytowingservice.com",
  "status": "done",                       // queued | running | done | failed
  "error": null,
  "created_at": "2026-09-12T13:30:21Z", "started_at": "…", "finished_at": "…",
  "progress": { "done": 12, "total": 40, "current": "https://…" },   // only while running
  "pages_crawled": 21,                    // pages that were graded
  "grade": "C", "score": 79,              // site grade = average of page scores; A≥90 B≥80 C≥70 D≥55 else F
  "summary": { "critical": 47, "serious": 21, "moderate": 43, "minor": 70 },
  "top_issues": [                         // 5 findings that matter most, site-wide, worst first
    { "code": "canonical_url_set", "severity": "critical", "category": "Indexability & Crawlability",
      "check": "Canonical URL set", "message": "Canonical URL set: No canonical link — every audited page (21)", "pages": 21 },
    { "code": "duplicate_titles", "severity": "serious", "message": "6 pages share a title tag (e.g. \"home\")", "pages": 6, "site_wide": true }
  ],
  "pages": [                              // one per crawled page, worst first; failed fetches last with grade null
    { "url": "https://…/contact-us", "path": "/contact-us", "title": "Contact Us", "grade": "C", "score": 72,
      "words": 310, "response_ms": 258, "js_rendered": false,
      "issues": [ { "code": "canonical_url_set", "severity": "critical", "category": "…", "check": "Canonical URL set",
                    "message": "Canonical URL set: No canonical link", "fix": "Add <link rel=canonical …>" } ] }
  ],
  "categories": { "Local SEO": 34, "AI Search & Answer Engines": 68, "On-Page Content": 96, "…": 100 },
  "local": { "gbp_found": true, "name": "…", "rating": 4.6, "review_count": 212, "address": "…", "phone": "…", "maps_url": "…",
             "schema_localbusiness": false, "review_schema": false, "click_to_call": true, "map_reference": false, "local_seo_score": 34 },
  "ai_visibility": { "score": 68, "crawlers_blocked": [], "llms_txt": false, "faq_schema": true, "organization_schema": false,
                     "readable_without_js": true, "js_only_pages": 0, "notes": "…" },
  "server_speed": { "avg_ms": 292, "median_ms": 257, "max_ms": 686, "pages_measured": 21, "verdict": "fast", "slowest": [] },
  "coverage": { "discovered": 21, "audited": 21, "failed": 0, "capped": false, "cap": 100, "discovered_via": "sitemap", "js_rendered": 0, "render_available": true },
  "report_url": "https://seoreview-production.up.railway.app/report/a_09e25d9656c27239?t=…"
}
```

Guarantees the tracker relies on: `grade` and `score` are always set when `status = done`; `pages[]` is sorted
worst-first; `pages_crawled` is the number of graded pages; domains match case-insensitively without `www.`.

**Severity mapping** (from the engine's check status + weight): failed check worth ≥6 points → `critical`,
other failed → `serious`, warning worth ≥4 → `moderate`, other warning → `minor`. `summary` counts every
page-level issue across all graded pages plus site-wide findings.

**Optional blocks.** `local.gbp_found` and the Google fields are `null` when `PLACES_API_KEY` is not set. Boolean
checks are `null` when the engine could not verify them. `ai_visibility` reflects the engine's AI-search
readiness checks (robots.txt crawler access, llms.txt, FAQ/Organization schema, readable content); it does **not**
query AI assistants for live citations.

## Callback

When `callback_url` was given, the finished audit object (status `done` or `failed`) is POSTed as JSON with
headers `X-Signature: <hex HMAC-SHA256 of the raw body using SEO_WEBHOOK_SECRET>` and `X-Audit-Id`.
Non-2xx or network failure → retried after 5 s and again after 30 s (3 attempts total).

Verify in Python (FastAPI):
```python
import hmac, hashlib
def verify(raw_body: bytes, signature: str | None, secret: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, (signature or "").strip())

@app.post("/api/webhooks/seo")
async def seo_webhook(request: Request):
    raw = await request.body()
    if not verify(raw, request.headers.get("x-signature"), SEO_WEBHOOK_SECRET):
        raise HTTPException(401, "bad signature")
    audit = json.loads(raw)          # same object as GET /api/v1/audits/{id}
    ...
    return {"ok": True}
```

## Operational notes

* A 100-page crawl typically takes 10–60 s (4 pages in parallel, one retry per page, no PageSpeed calls).
  The tracker should poll every few seconds or rely on the callback.
* One crawl per domain at a time; later requests attach to the in-flight audit.
* If the server restarts mid-crawl the audit is marked `failed` ("server restarted…"); queued audits are re-queued.
* Sites that block automated access (Cloudflare challenge pages) or have no reachable pages fail with a clear `error`.
* Audits are also written to `crm_businesses.latest_score / latest_grade / last_audit_at` when the domain is a known
  CRM business, so the team CRM view stays current.
