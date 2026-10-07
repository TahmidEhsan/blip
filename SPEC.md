# Blip — Build Spec (integration contract)

Blip is a playful URL shortener. **Tagline:** "Tiny links with big personality."
This document is the contract every part of the codebase is built against. If code and spec disagree, the spec wins unless the spec is clearly wrong (then fix both).

Runtime: **Node 22.17 (ESM, `"type": "module"`)**, Express 5, `node:sqlite` (`DatabaseSync`, built in — no native modules), vanilla HTML/CSS/JS frontend (ES modules, no build step). Tests use the built-in `node:test` runner + global `fetch` against `app.listen(0)`.

Dependencies already installed (do **not** add others without a strong reason):
`express@5`, `ua-parser-js@1` (CJS, `const { UAParser } = require(...)` or `import uaParser from 'ua-parser-js'`), `i18n-iso-countries` (alpha2 → numeric/name), `qr-code-styling` (browser UMD → global `QRCodeStyling`), `d3@7`, `topojson-client@3`, `world-atlas@2`, `lucide` (browser UMD → global `lucide`), `@fontsource-variable/inter`, `@fontsource-variable/space-grotesk`, optional `fast-geoip` (async `lookup(ip)` → `{country, region, city, ll:[lat,lon], ...}` or `null`).

> ⚠ `fast-geoip` returns bogus data for loopback/private IPs (e.g. `127.0.0.1` → JP). **Never** look up loopback, private (10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10, ::1), CGNAT (100.64/10) or unspecified addresses. Strip `::ffff:` IPv4-mapped prefixes first.

## 1. File layout & ownership

```
blip/
  package.json, SPEC.md, README.md, .gitignore
  server/
    index.js            entry: loadConfig() → createApp() → listen; graceful shutdown
    app.js              export function createApp(options) → { app, db, close }
    config.js           export function loadConfig(env = process.env) → Config
    db.js               open DB, run migrations, export query helpers
    slugs.js            normalizeSlug, validateSlug, RESERVED_SLUGS, randomSlug, wordSlug, suggestSlugs
    words.js            ADJECTIVES, NOUNS (family-friendly, ≥150 each)
    urls.js             normalizeTargetUrl
    domains.js          domainOptions(config), domainIdeas(keyword)
    analytics.js        parseUserAgent, isBotUA, visitorHash, recordClick helpers, buildStats
    geo.js              lookupGeo(ip, headers) → {country, region, city, lat, lon} | null
    bus.js              EventEmitter for live click events
    render.js           renderView(name, vars) — template substitution + escaping
    ratelimit.js        in-memory fixed-window limiter middleware factory
    routes/api.js       /api/* router
    routes/redirect.js  /:slug handler
    data/trivia.js      export const TRIVIA = [...] (≥60 short, true, fun facts)
    views/teaser.html   server templates (see §6)
    views/expired.html
    views/not-found.html
    views/preview.html
  public/
    index.html          home: create links + feature buttons + "My links"
    dashboard.html      live analytics for one link (slug in location.hash)
    qr.html             QR studio for one link (slug in location.hash)
    favicon.svg
    assets/css/theme.css   SHARED design system (already written — use it, extend only in page css)
    assets/css/app.css, dashboard.css, qr.css, pages.css
    assets/js/api.js       SHARED API client + linkStore + toast + helpers (already written)
    assets/js/qr-shared.js SHARED QR presets/builder (already written)
    assets/js/app.js, dashboard.js, qr.js, teaser.js, expired.js
  test/*.test.js
  data/                 runtime SQLite DB (gitignored)
```

## 2. Config (`server/config.js`)

| env | default | meaning |
|---|---|---|
| `PORT` | `3030` | listen port |
| `HOST` | `127.0.0.1` | listen host |
| `BASE_URL` | `http://localhost:${PORT}` | the URL that **actually** serves links today (no trailing slash) |
| `DOMAINS` | `blip.to,cat.ly,go.to,p.wrk` | playful vanity domains offered in the UI |
| `LIVE_DOMAINS` | *(empty)* | subset of `DOMAINS` whose DNS really points at this server |
| `DB_PATH` | `./data/blip.db` (relative to project root) | SQLite file; `:memory:` allowed |
| `IP_HASH_SALT` | *(auto)* | if unset, generate 32 random bytes once and persist in `meta` table |
| `ALLOW_DEMO_TRAFFIC` | `true` unless `NODE_ENV=production` | enables the "Simulate traffic" endpoints |
| `TRUST_PROXY` | `false` | passed to `app.set('trust proxy', …)` (`true`/`false`/number/string) |

`Config` object shape (camelCase): `{ port, host, baseUrl, baseHost, domains: string[], liveDomains: string[], dbPath, ipHashSalt|null, allowDemoTraffic, trustProxy, nodeEnv }`. `baseHost` = host (with port if non-default) of `baseUrl`, e.g. `localhost:3030`. Domains are lowercased, trimmed, deduped; `baseHost` is never duplicated into `domains`.

`createApp(options)` accepts `{ config?: Partial<Config>, now?: () => number /* epoch ms, default Date.now */, geoLookup?: fn, random?: fn }` and merges with `loadConfig({})` defaults so tests can do `createApp({ config: { dbPath: ':memory:' } })`. Return `{ app, db, close }`. Everything time-dependent (expiry, stats ranges, timestamps) **must** use the injected `now()`.

## 3. Database (`node:sqlite` DatabaseSync)

`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;` (skip WAL for `:memory:`). Create the `data/` dir if missing.

```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS links (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,              -- always lowercase
  domain            TEXT NOT NULL,                      -- baseHost or one of DOMAINS
  target_url        TEXT NOT NULL,
  title             TEXT,
  manage_token_hash TEXT NOT NULL,                      -- sha256 hex of the manage token
  redirect_mode     TEXT NOT NULL DEFAULT 'instant' CHECK (redirect_mode IN ('instant','teaser')),
  teaser_seconds    INTEGER NOT NULL DEFAULT 5,
  teaser_style      TEXT NOT NULL DEFAULT 'countdown' CHECK (teaser_style IN ('countdown','trivia','brand')),
  teaser_message    TEXT,
  teaser_theme      TEXT NOT NULL DEFAULT 'aurora',
  expires_at        INTEGER,                            -- epoch ms, NULL = never
  max_clicks        INTEGER,                            -- NULL = unlimited
  click_count       INTEGER NOT NULL DEFAULT 0,         -- consumed (real, non-bot, non-synthetic) visits
  destroyed_at      INTEGER,                            -- manual self-destruct
  qr_style          TEXT,                               -- JSON (see §8)
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clicks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id       INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  visitor_hash  TEXT,                 -- sha256(salt + ip + ua) hex, first 24 chars. NEVER store raw IPs.
  is_unique     INTEGER NOT NULL DEFAULT 0,   -- first time this visitor_hash hit this link
  country       TEXT,                 -- ISO alpha-2 uppercase, NULL = unknown
  region        TEXT,
  city          TEXT,
  lat           REAL,                 -- rounded to 1 decimal (privacy)
  lon           REAL,
  device        TEXT NOT NULL DEFAULT 'desktop',  -- desktop|mobile|tablet|console|tv|wearable|bot|other
  browser       TEXT,
  os            TEXT,
  referrer_host TEXT,                 -- hostname only, NULL = direct
  is_bot        INTEGER NOT NULL DEFAULT 0,
  is_synthetic  INTEGER NOT NULL DEFAULT 0,
  outcome       TEXT NOT NULL DEFAULT 'redirect' CHECK (outcome IN ('redirect','teaser','expired','bot-preview'))
);
CREATE INDEX IF NOT EXISTS idx_clicks_link_ts ON clicks(link_id, ts);
CREATE INDEX IF NOT EXISTS idx_clicks_link_visitor ON clicks(link_id, visitor_hash);
```

## 4. Domain rules

### 4.1 Slugs (`server/slugs.js`)
- `normalizeSlug(input)`: NFKD + strip diacritics → lowercase → `&` → `and` → whitespace/underscores/dots/slashes → `-` → drop every char not `[a-z0-9-]` → collapse `-+` → trim leading/trailing `-` → truncate to 64 (re-trim trailing `-`). `"Summer Sale 2026!"` → `"summer-sale-2026"`, `"Café_Menu"` → `"cafe-menu"`.
- Valid: `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` (1–64 chars).
- `RESERVED_SLUGS` (exported Set): `api assets vendor static public health healthz admin dashboard qr new create login logout signup about help terms privacy expired preview teaser index favicon robots sitemap well-known`.
- `checkSlug(db, input)` → `{ input, normalized, valid, available, reason }` with `reason ∈ null|'empty'|'invalid'|'reserved'|'taken'`.
- `randomSlug()`: 7 chars from `abcdefghjkmnpqrstuvwxyz23456789`, crypto-random, retry on collision.
- `wordSlug()`: `adjective-noun` (e.g. `brave-otter`), falling back to `adjective-noun-NN` / `adjective-adjective-noun` on collision.
- `suggestSlugs(db, phrase, count=6)`: if phrase given → normalized phrase, phrase + current year, phrase + short word (`-go`, `-now`, `-hq`), `adjective-<phrase>`… then word slugs to fill. All returned suggestions must be valid + available + unique. Without phrase → word slugs only.

### 4.2 Target URLs (`server/urls.js`)
`normalizeTargetUrl(input, { ownHosts })` → `{ ok: true, url }` or `{ ok: false, code, message }`:
- trim; reject empty; max 2048 chars.
- If no scheme (`^[a-z][a-z0-9+.-]*:` doesn't match) prepend `https://`.
- Parse with `new URL()`; only `http:`/`https:`; must have a hostname containing a dot **or** be `localhost`; no credentials (`user:pass@`).
- Reject when hostname (+port) equals `baseHost` or any configured domain (redirect loop) → code `redirect_loop`.
- Return `url.href`.
- Error codes: `invalid_url`, `unsupported_protocol`, `redirect_loop`, `too_long`.

### 4.3 Link status
`status(link, now)`: `'destroyed'` if `destroyed_at` set; else `'expired'` if `expires_at !== null && now >= expires_at` (reason `time`) or `max_clicks !== null && click_count >= max_clicks` (reason `clicks`); else `'active'`. `expiredReason ∈ null|'time'|'clicks'|'manual'`.

### 4.4 Visits (`GET /:slug`, `server/routes/redirect.js`)
Mounted **after** static files and `/api`. Flow:
1. Lowercase the slug param. If it isn't a valid slug shape or no link → **404** `not-found` view.
2. Bot detection (`isBotUA`): UA empty, or matches `/bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|quora link|whatsapp|telegram|discord|slack|skype|linkedin|vkshare|pinterest|bitly|curl|wget|python-requests|httpclient|headless/i`.
3. **HEAD** requests: respond like GET status-wise but never record or consume.
4. If link not active → log click with `outcome='expired'` (not counted in click totals), respond **410** `expired` view.
5. If bot **and** link has `max_clicks` or `expires_at` → log `outcome='bot-preview'` (is_bot=1, does NOT consume), respond **200** `preview` view (must not reveal the target URL).
6. Otherwise consume atomically:
   `UPDATE links SET click_count = click_count + 1, updated_at=? WHERE id=? AND destroyed_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (max_clicks IS NULL OR click_count < max_clicks)`
   — bots on unlimited links are recorded with `is_bot=1` but **do not** increment `click_count`. If `changes === 0` (lost a race) → treat as step 4.
7. Record the click (UA → device/browser/os; geo; referrer host; visitor hash; uniqueness), publish on the bus (§7.4).
8. `redirect_mode='instant'` → **302** `Location: target`. `'teaser'` → **200** `teaser` view (outcome `'teaser'`).
- All `/:slug` responses: `Cache-Control: no-store`, `X-Robots-Tag: noindex`. 302s also send `Referrer-Policy: unsafe-url`? **No** — leave referrer policy default.
- Geo lookup must not delay the redirect noticeably: country headers first (`cf-ipcountry`, `x-vercel-ip-country`, `cloudfront-viewer-country`, `x-country-code`; ignore `XX`/`T1`), else `fast-geoip` (dynamic `import()` once, cached; if import fails geo is just `null`). It's fine to insert the click row after a short await of geo (cap with a 150 ms timeout → null).

## 5. HTTP API (`/api`, JSON, `server/routes/api.js`)

- JSON body limit 16 kb. Errors: `{ "error": { "code": string, "message": string, "field"?: string } }`.
- Auth for management endpoints: header **`X-Manage-Token: <token>`**. Missing → 401 `unauthorized`; wrong → 403 `forbidden`; unknown slug → 404 `not_found`. Compare sha256 hashes with `crypto.timingSafeEqual`.
- Manage token: `crypto.randomBytes(24).toString('base64url')`; only its sha256 hex is stored. Returned **once** at creation.
- Rate limits (per client IP, fixed window): `POST /api/links` 20/min; `POST /api/links/:slug/simulate` 30/min; `GET /api/slugs/*` & `/api/domains/ideas` 120/min. 429 `rate_limited` + `Retry-After` header.
- Every `/api` response: `Cache-Control: no-store`.

### 5.1 LinkDTO
```jsonc
{
  "slug": "summer-sale-2026",
  "domain": "cat.ly",
  "domainLive": false,                         // domain === baseHost || liveDomains.includes(domain)
  "shortUrl": "https://cat.ly/summer-sale-2026",   // branded; for baseHost use baseUrl + '/' + slug
  "workingUrl": "http://localhost:3030/summer-sale-2026", // baseUrl + '/' + slug (always works)
  "qrUrl": "http://localhost:3030/summer-sale-2026",      // shortUrl if domainLive else workingUrl
  "targetUrl": "https://example.com/sale",
  "title": "Summer sale" | null,
  "redirectMode": "instant" | "teaser",
  "teaser": { "seconds": 5, "style": "countdown"|"trivia"|"brand", "message": string|null, "theme": "aurora"|"sunset"|"ocean"|"neon"|"candy" },
  "expiresAt": "2026-10-08T12:00:00.000Z" | null,
  "maxClicks": 10 | null,
  "clickCount": 3,
  "clicksRemaining": 7 | null,
  "status": "active" | "expired" | "destroyed",
  "expiredReason": null | "time" | "clicks" | "manual",
  "qrStyle": { ... } | null,
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

### 5.2 Endpoints
| Method & path | Auth | Body / query | Response |
|---|---|---|---|
| `GET /api/health` | – | – | `{ ok: true }` |
| `GET /api/config` | – | – | `{ baseUrl, baseHost, domains: [{ domain, live, isBase }], defaultDomain: baseHost, allowDemoTraffic, teaser: { minSeconds: 3, maxSeconds: 15, defaultSeconds: 5, styles: ['countdown','trivia','brand'], themes: ['aurora','sunset','ocean','neon','candy'] }, limits: { slugMax: 64, titleMax: 120, messageMax: 280, maxClicksMax: 1000000, urlMax: 2048 } }` — `domains[0]` is always the base host (`isBase: true, live: true`). |
| `GET /api/slugs/check?slug=` | – | – | `{ input, normalized, valid, available, reason }` |
| `GET /api/slugs/suggest?phrase=&count=` | – | count 1–12 (default 6) | `{ suggestions: string[] }` |
| `GET /api/domains/ideas?keyword=` | – | keyword 1–40 chars | `{ keyword, ideas: [{ domain, kind: 'hack'|'short'|'playful', note }] }` (≤12; see §5.3) |
| `POST /api/links` | – | CreateBody | **201** `{ link: LinkDTO, manageToken }`; 400 validation; 409 `slug_taken`; 429 |
| `POST /api/links/batch` | tokens in body | `{ items: [{ slug, token }] }` (≤100) | `{ results: [{ slug, link: LinkDTO|null, error: null|'not_found'|'forbidden' }] }` (same order) |
| `GET /api/links/:slug` | ✓ | – | `{ link }` |
| `PATCH /api/links/:slug` | ✓ | UpdateBody | `{ link }` |
| `DELETE /api/links/:slug` | ✓ | – | **204** (deletes link + clicks) |
| `POST /api/links/:slug/destroy` | ✓ | – | `{ link }` (sets `destroyed_at=now`; publishes `status` event) |
| `POST /api/links/:slug/revive` | ✓ | – | `{ link }` (clears `destroyed_at`; time/click expiry must be changed via PATCH) |
| `GET /api/links/:slug/stats?range=&tz=` | ✓ | `range ∈ 24h|7d|30d|all` (default 7d); `tz` = `Date#getTimezoneOffset()` minutes (default 0) | StatsDTO (§5.4) |
| `GET /api/links/:slug/stream` | ✓ (header) | – | `text/event-stream` (§7.4) |
| `POST /api/links/:slug/simulate` | ✓ | `{ count: 1–50 }` (default 12) | `{ inserted }` — 404 `not_found` when demo traffic disabled |
| `DELETE /api/links/:slug/simulated` | ✓ | – | `{ deleted }` |

**CreateBody**: `{ targetUrl (required), slug?, slugStyle?: 'words'|'random' (used only when slug empty; default 'words'), domain? (default baseHost; must be baseHost or in DOMAINS), title? (≤120), redirectMode?, teaser?: { seconds?, style?, message?, theme? }, expiresAt? (ISO string or epoch ms; must be in the future and ≤ 5 years out), expiresInSeconds? (60 … 157680000; alternative to expiresAt), maxClicks? (1 … 1 000 000), qrStyle? }`.
If `slug` is provided it is normalized; invalid → 400 `slug_invalid`, reserved → 400 `slug_reserved`, taken → 409 `slug_taken` (field `slug`). `teaser.message` is required (non-empty) when `style='brand'` → else 400 `validation` field `teaser.message`. Unknown enum values → 400 `validation` with the field name.

**UpdateBody**: any of `targetUrl, title, domain, redirectMode, teaser (partial merge), expiresAt (null clears), expiresInSeconds, maxClicks (null clears), qrStyle (null clears)`. Slug is immutable. Same validation as create, except `expiresAt` may not be in the past.

### 5.3 Domain ideas (`server/domains.js`)
Pure function, no network. Use only real short TLDs: `ly to me io co gg sh is it at be so im es us in al am fm tv cc ai ws la vc st nu ink link`.
- **hack**: keyword ends with a TLD → split it (`delicious` → `delicio.us`, `catly` → `cat.ly`, `bitsy` → `bit.sy`? only if `sy` is in the list).
- **short**: keyword (≤12 chars) or its vowel-less abbreviation (`summer` → `smmr`) + `.ly/.to/.gg/.sh/.co`.
- **playful**: `go<kw>.to`, `<kw>.link`, `hey<kw>.co`, `<kw>hq.io`, `<first-letter>.<kw-if-tld>`.
Dedupe, cap 12, each with a short human `note` ("Domain hack — the TLD finishes the word"). Keyword is normalized to `[a-z0-9-]`.

### 5.4 StatsDTO
```jsonc
{
  "slug": "…", "range": "7d", "generatedAt": "ISO",
  "totals": { "clicks": 0, "uniqueVisitors": 0, "botClicks": 0, "blockedAfterExpiry": 0, "last24h": 0, "syntheticClicks": 0 },
  "timeseries": { "bucket": "hour"|"day", "points": [{ "t": "ISO bucket start (in the client's tz)", "clicks": 0 }] },
  "devices":   [{ "name": "mobile", "count": 3 }],
  "browsers":  [{ "name": "Chrome", "count": 3 }],
  "os":        [{ "name": "Windows", "count": 3 }],
  "referrers": [{ "name": "direct" | "twitter.com", "count": 3 }],
  "countries": [{ "code": "GB", "numeric": "826", "name": "United Kingdom", "count": 3 }],
  "points":    [{ "lat": 51.5, "lon": -0.1, "city": "London", "country": "GB", "count": 2 }],
  "recent":    [ClickEvent, …]    // newest first, max 25
}
```
- "clicks" = rows with `outcome IN ('redirect','teaser') AND is_bot = 0` (synthetic included; `syntheticClicks` shows how many of them are synthetic). `botClicks` = rows with `is_bot=1`. `blockedAfterExpiry` = `outcome='expired'`.
- `24h` → 24 hourly buckets ending at the current hour; `7d`/`30d` → 7/30 daily buckets ending today; `all` → daily from creation day to today (max 365 buckets). Buckets are aligned in the client's tz using `tz` (minutes, JS sign convention: UTC − local). Empty buckets present with `clicks: 0`.
- Breakdown lists sorted desc, top 8 + `"Other"` aggregate for browsers/os/referrers; countries all (sorted desc); points grouped by rounded lat/lon (max 300).
- `uniqueVisitors` = distinct `visitor_hash` among counted clicks in range.

**ClickEvent**: `{ id, ts: "ISO", country: "GB"|null, countryName: "United Kingdom"|null, numeric: "826"|null, city: string|null, lat, lon, device, browser, os, referrer: string|null, isBot, isSynthetic, isUnique, outcome }`.

## 6. Server-rendered views (`server/views/*.html`, `server/render.js`)

Templates are full HTML documents with placeholders; `renderView(name, vars)` reads the file (cache in production) and substitutes:
- `{{text:KEY}}` → HTML-escaped (`& < > " '`) string.
- `{{attr:KEY}}` → same escaping (safe inside double-quoted attributes).
- `{{json:KEY}}` → `JSON.stringify(value)` with `<` → `<`, `>` → `>`, `&` → `&`, U+2028/U+2029 escaped. Only used inside `<script type="application/json" id="blip-data">…</script>`.
- `{{raw:KEY}}` is **not** supported. Unknown placeholders render as empty string.
Views must not contain inline `<script>` code (CSP); they load `/assets/js/teaser.js` / `/assets/js/expired.js` as `<script type="module" src>`. They include the shared background markup (§9) and `theme.css` + `pages.css`.

| view | status | vars |
|---|---|---|
| `teaser` | 200 | `TITLE` (text), `TARGET` (attr — for `<noscript>` link and `<meta http-equiv="refresh" content="{{attr:REFRESH}}">`), `REFRESH` = `"<seconds+1>;url=<target>"`, `THEME` (attr, for `<body data-theme>`), `DATA` (json: `{ slug, title, targetUrl, targetHost, seconds, style, message, theme, fact }`) |
| `expired` | 410 | `TITLE`, `DATA` (json: `{ slug, reason: 'time'|'clicks'|'manual', expiredAt: ISO|null, clickCount, maxClicks }`) |
| `not-found` | 404 | `SLUG` (text), `DATA` (json: `{ slug }`) |
| `preview` | 200 | `TITLE` — generic "Open this Blip link in your browser" page; never includes the target |

Teaser page requirements: themed full-screen background (`data-theme`), big animated countdown ring with seconds, style-specific content (trivia fact card / brand message card / pure countdown), destination host shown ("Taking you to **example.com**"), **Go now** button, **Cancel** (stops countdown) button, after countdown `location.replace(targetUrl)`. Respect `prefers-reduced-motion`.
Expired page: playful "💥 This link has self-destructed" — animated fuse/explosion/smoke + reason-specific copy ("It was set to vanish after 1 click — someone got here first." / "Its timer ran out on <date>." / "Its owner pressed the big red button."), "Make your own Blip" button → `/`.
Not-found page: playful 404 ("This Blip doesn't exist (yet)"), button to `/?slug=<slug>` to claim it.

## 7. Security & platform behaviour

### 7.1 Headers (all responses)
`Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. `app.disable('x-powered-by')`.
→ **No inline scripts or inline event handlers anywhere.** External links opened by the frontend use `rel="noopener noreferrer"`.

### 7.2 Static & vendor routes
- `express.static('public', { extensions: ['html'] })` — so `/dashboard` serves `dashboard.html`. (Hence `dashboard`, `qr` are reserved slugs.)
- `/vendor/qr-code-styling.js` → `node_modules/qr-code-styling/lib/qr-code-styling.js`
- `/vendor/d3.min.js` → `node_modules/d3/dist/d3.min.js`
- `/vendor/topojson-client.min.js` → `node_modules/topojson-client/dist/topojson-client.min.js`
- `/vendor/countries-110m.json` → `node_modules/world-atlas/countries-110m.json` (country `id`s are ISO numeric strings, sometimes zero-padded — compare with `Number(id)`)
- `/vendor/lucide.min.js` → `node_modules/lucide/dist/umd/lucide.min.js`
- `/vendor/fonts/inter/` → `node_modules/@fontsource-variable/inter/` (use `index.css`, family `'Inter Variable'`)
- `/vendor/fonts/space-grotesk/` → `node_modules/@fontsource-variable/space-grotesk/` (use `index.css`, family `'Space Grotesk Variable'`)

### 7.3 Never
- store raw IPs; reflect user input into HTML without escaping; use `innerHTML` with user/link data on the frontend (use `textContent` / the `el()` helper); allow non-http(s) targets; log manage tokens.

### 7.4 Live stream (`GET /api/links/:slug/stream`)
SSE over a normal GET with the `X-Manage-Token` header (the frontend reads it with `fetch` + `ReadableStream`, **not** `EventSource`, so the token never goes in the URL). Headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `Connection: keep-alive`, `X-Accel-Buffering: no`; call `res.flushHeaders()`.
Events (each `event: <name>\ndata: <json>\n\n`):
- `hello` → `{ slug, totals }` (same totals as StatsDTO for range `all`) immediately on connect.
- `click` → ClickEvent + `{ totals: { clicks, uniqueVisitors } }` (all-time counted clicks) whenever a click is recorded (real or synthetic; bot-preview/expired events also sent with their outcome so the feed can show "blocked" attempts).
- `status` → `{ status, expiredReason, clickCount, clicksRemaining }` when the link expires (by clicks), is destroyed or revived.
- comment heartbeat `: ping\n\n` every 15 s.
Unsubscribe on `req.on('close')`. Bus: `bus.emit('link:<id>', { type, data })`.

### 7.5 Simulated traffic
Only when `allowDemoTraffic`. Inserts `count` clicks with `is_synthetic=1`, plausible random (via injected `random`) countries with real city coords (bundle ~40 world cities with country/lat/lon), device mix (~55% mobile, 38% desktop, 7% tablet), browser/os mixes, referrers (`direct`, `twitter.com`, `instagram.com`, `news.ycombinator.com`, `reddit.com`, `linkedin.com`, `google.com`), timestamps spread over the last 7 days except the last few which are `now()`. Synthetic clicks never touch `click_count`. Emit `click` events staggered ~150 ms apart (use `setTimeout`, `unref()` the timers). Response returns immediately after inserting.

## 8. QR style (`qrStyle`)
Flat object, validated server-side (whitelisted keys only, JSON ≤ 2 kB, unknown keys dropped, invalid values → 400 `validation` field `qrStyle.<key>`):
```jsonc
{
  "preset": "aurora"|"sunset"|"ocean"|"neon"|"mono"|"candy"|"forest"|"custom",
  "dotType": "square"|"dots"|"rounded"|"classy"|"classy-rounded"|"extra-rounded",
  "dotColor": "#rrggbb", "dotColor2": "#rrggbb"|null,          // dotColor2 → gradient
  "gradientType": "linear"|"radial", "gradientRotation": 0-360,
  "bgColor": "#rrggbb", "transparentBg": false,
  "cornerSquareType": "square"|"dot"|"extra-rounded"|"rounded"|"dots"|"classy"|"classy-rounded",
  "cornerSquareColor": "#rrggbb",
  "cornerDotType": "square"|"dot"|"rounded"|"dots"|"classy"|"classy-rounded"|"extra-rounded",
  "cornerDotColor": "#rrggbb",
  "logo": "none"|"blip"|"heart"|"star"|"bolt"|"cat"|"link",    // custom uploads are client-only, never sent
  "margin": 0-40,
  "caption": string ≤ 40 chars | null                           // printed under the QR in PNG downloads
}
```
The browser-side presets, logo SVGs and the `buildQrOptions()` mapping live in `public/assets/js/qr-shared.js` (already written — import from it, don't duplicate).

## 9. Frontend conventions
- Every page: `<!doctype html>`, `lang="en"`, viewport meta, `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`, fonts `/vendor/fonts/inter/index.css` + `/vendor/fonts/space-grotesk/index.css`, `/assets/css/theme.css`, then the page css. Scripts as `<script type="module" src="…">` (UMD vendor libs as classic `<script src defer>` placed **before** the module script).
- Background markup right after `<body>`:
  ```html
  <div class="bg" aria-hidden="true"><div class="bg-blob bg-blob--1"></div><div class="bg-blob bg-blob--2"></div><div class="bg-blob bg-blob--3"></div><div class="bg-blob bg-blob--4"></div><div class="bg-grid"></div><div class="bg-noise"></div></div>
  ```
- Shared header: `<header class="site-header container"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">blip</span></a><nav class="site-nav">…</nav></header>`.
- Use `api.js` for **every** API call, `linkStore` for tokens (`localStorage` key `blip.links.v1`), `toast()` for feedback, `el()` for DOM building from data. Icons: `<i data-lucide="name"></i>` + `window.lucide?.createIcons()` after rendering (guard when lucide absent).
- Accessibility: every control keyboard-reachable with visible focus, `aria-pressed` on toggle buttons, `aria-expanded` + `aria-controls` on disclosure buttons, `aria-live="polite"` regions for async results, labels on all inputs, contrast ≥ 4.5:1 for text. Respect `prefers-reduced-motion`. Layout works from 360 px wide (16 px gutters, no horizontal scroll).
- Page hash routing: `dashboard.html#<slug>`, `qr.html#<slug>`. If no token for that slug in `linkStore`, show a friendly empty state with a link home (and on dashboard, a field to paste a manage token which is then saved to `linkStore`).

## 10. Home page (`index.html` + `app.js` + `app.css`)
1. Hero: logo, tagline, headline with gradient text, a big glass "shortener" card: URL input (auto-prefixes `https://` on blur when missing scheme; validates inline) + **Shorten** primary button (Enter submits).
2. **Feature toolbar** — six large toggle buttons (`.feature-btn`, `aria-pressed`, `aria-controls`), each opening its option panel inside the card (multiple may be open). Active features show a small summary chip under the input (e.g. "⏳ 1 click", "🌐 cat.ly"); clicking a chip re-opens the panel.
   1. **Custom slug** (`pencil-line`): text input with live prefix showing chosen domain (`cat.ly/`), live normalization preview ("→ summer-sale-2026"), debounced (300 ms) availability check with ✓/✗ state + reason, **🎲 Word slug** button (calls suggest with no phrase), **Suggest from phrase** → chips of suggestions from `/api/slugs/suggest?phrase=<input or page title>`; clicking a chip fills the slug.
   2. **Playful domain** (`globe`): chip list from `/api/config.domains` (base host labelled "live", others "vanity" + tooltip "Point this domain's DNS at your Blip server to make it live"), plus **Domain idea generator**: keyword input + **Generate** button → idea cards (domain, kind badge, note, "Check availability ↗" link to `https://lookup.icann.org/en/lookup?name=<domain>` opened in a new tab with `rel="noopener noreferrer"`). Clicking an idea copies it (we can't buy domains for the user — say so in a one-line hint).
   3. **Teaser page** (`clapperboard`): switch "Show a teaser before redirecting", style segmented control (Countdown / Trivia / Brand message), seconds slider 3–15, brand message textarea (counter /280; required for Brand), theme swatches (aurora, sunset, ocean, neon, candy), and a mini live preview tile of the teaser.
   4. **Self-destruct** (`timer` / `bomb`): preset buttons: "After 1 click (burn after reading)", "After 10 clicks", "1 hour", "24 hours", "7 days", "Custom…" (datetime-local input + clicks number). Combined summary ("Vanishes after 10 clicks or on Oct 9, 14:00 — whichever comes first"). "Never" resets.
   5. **Live analytics** (`activity`): explains the dashboard; after a link exists, button **Open live dashboard** → `/dashboard.html#<slug>`; before, a note "Every link gets a live dashboard — create one first" and a "See my links" scroll button. (Analytics is always on.)
   6. **QR studio** (`qr-code`): preset swatches (from `QR_PRESETS`) + logo picker (from `LOGOS`) chosen before creation (sent as `qrStyle`); after creation the result card shows the styled QR and **Open QR studio** → `/qr.html#<slug>`.
3. Result card (animated in, `aria-live`): branded short URL big (gradient), "live"/"vanity preview" badge; if vanity and not live, a second row "Works right now: <workingUrl>" with its own copy button. Buttons: **Copy**, **Open**, **QR studio**, **Live dashboard**, **Share** (Web Share API when available), **Destroy now** (confirm), mini styled QR (click → download PNG), summary of options (teaser, expiry, clicks remaining).
4. **My links** section: from `linkStore` via `api.batch`; each row: short URL, target host, status badge (active/expired/destroyed), clicks (and remaining), expiry countdown, actions (copy, dashboard, QR, destroy/revive, delete with confirm, edit target URL inline). Removes entries from `linkStore` if the server says `not_found`. Empty state illustration. Refresh button.
5. Supports `/?slug=<x>` (from the 404 page) → pre-opens the Custom slug panel with that value.
6. Footer: small "Made with Blip" + privacy note ("we never store IP addresses").

## 11. Dashboard (`dashboard.html` + `dashboard.js` + `dashboard.css`)
Header with link info (short URL, target, status badge, created, copy button, back home, QR studio link), **LIVE** pulse indicator (green when stream connected, amber reconnecting), range segmented control (24h/7d/30d/all).
- KPI tiles: Total clicks, Unique visitors, Last 24h, Clicks remaining / expires-in (or "∞"), Bots & blocked.
- Clicks over time: SVG area + line chart drawn with d3 (axes, hover tooltip with value + bucket label, animated transition on range change).
- **World map**: d3 `geoNaturalEarth1` (or `geoEqualEarth`) + `topojson.feature(countries-110m, objects.countries)`; choropleth by click count (sequential scale on the violet→pink brand ramp, zero = neutral surface), city points as glowing circles sized by count, **live click ping** animation (expanding ring) at the coordinates of each incoming click, tooltip on hover (country name + clicks), legend. Responsive (re-render on resize via `ResizeObserver`).
- Device donut (mobile/desktop/tablet/…), Browsers & OS horizontal bars, Top referrers list, Countries table (flag emoji from alpha-2 + name + count + share bar).
- **Live feed**: newest-first list of ClickEvents (flag, city/country, device icon, browser, referrer, relative time "just now"), new items slide in; blocked/expired/bot attempts styled differently.
- Live updates: on `click` events increment KPIs, push into feed, ping on map, and refetch stats (debounced 1.5 s) to refresh charts. On `status` events update badges.
- **Simulate traffic** button (only if `config.allowDemoTraffic`): asks count (10 / 25 / 50 segmented) → POST simulate; a chip "Includes N simulated clicks" + **Clear simulated** button when `syntheticClicks > 0`. Make clear simulated data is for demo purposes.
- Empty states for zero clicks ("No clicks yet — share your link! Or simulate some traffic to preview the dashboard").

## 12. QR studio (`qr.html` + `qr.js` + `qr.css`)
Two-column (stacks on mobile): left = big live preview on a "card stage" with subtle 3D tilt on pointer move (disabled for reduced motion) and the encoded URL under it; right = controls:
- Preset swatch buttons (`QR_PRESETS`), dot style buttons (visual thumbnails), corner square/dot styles, color pickers (dots, gradient end + toggle + linear/radial + rotation, background, transparent toggle, corner colors), logo picker (presets + **Upload logo…** (PNG/JPG/SVG ≤ 512 kB, FileReader → data URL, client-only, remembered in `localStorage` per slug), margin slider, caption input.
- Buttons: **Download PNG** (1024 px, with caption + rounded frame composed on a canvas), **Download SVG**, **Copy image** (Clipboard API when available), **Save style** (PATCH `qrStyle`, toast), **Reset**, **Surprise me** (random harmonious style).
- Shows which URL is encoded (`qrUrl`) and explains vanity domains encode the working URL until the domain is live.
- Scannability warning when contrast between dot color and background is too low (< 3:1) or gradient is too light.

## 13. Tests (`test/*.test.js`, `npm test`)
Use `node:test` + `node:assert/strict`; spin up `createApp({ config: { dbPath: ':memory:', baseUrl: 'http://localhost:3030', allowDemoTraffic: true }, now: () => clock })` with a mutable `clock`, `server = app.listen(0)`, `fetch` with `redirect: 'manual'`. Cover at least: slug normalization & validation & reserved; word/random slugs; suggestions available; URL normalization (scheme prefix, javascript:/data: rejected, loop rejected, credentials rejected); create (custom slug, word slug default, 409 taken, domain validation, brand message required, expiry validation); auth (401/403/404); PATCH/DELETE; instant 302 + `Cache-Control: no-store`; teaser 200 with escaped data (XSS attempt in title/message must not appear unescaped); expiry by time (advance clock) → 410 + expired page; maxClicks=1 → first 302, second 410; bot UA doesn't consume a limited link (200 preview, target not in body); HEAD doesn't consume; destroy/revive; stats shape, counts and buckets (incl. tz); synthetic traffic + clear; simulate disabled → 404; SSE receives `hello` and `click`; domain ideas (`delicious` → `delicio.us` present); rate limiting returns 429; CSP header present; unknown slug → 404; reserved slug creation rejected; batch endpoint.
