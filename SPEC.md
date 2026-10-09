# Blip: build spec (integration contract)

Blip is a playful URL shortener. **Tagline:** "Tiny links with big personality."
This document is the functional contract every part of the codebase is built against. If code and spec disagree, the spec wins unless the spec is clearly wrong (then fix both).
**[DESIGN.md](DESIGN.md) is binding for everything visual and for all copy** (the comic panel theme, tokens, components, layout, motion, loading states and wording). Where this spec and DESIGN.md disagree on look or wording, DESIGN.md wins.

Runtime: **Node 22.13 or newer** (`engines` in package.json; `.nvmrc` says `22`; developed and tested on 22.17), ESM (`"type": "module"`), Express 5, `@libsql/client` (SQLite through libSQL, async: a local SQLite file by default, or a hosted libSQL database such as Turso, §3), vanilla HTML/CSS/JS frontend (ES modules, no build step; `npm run build` only copies vendor files for Vercel, §7.6). Deployable to Vercel as one Express function with a Turso database (§7.6). Tests use the built-in `node:test` runner + global `fetch` against `app.listen(0)`.

Dependencies already installed (do **not** add others without a strong reason):
`express@5`, `@libsql/client` (the data layer, §3; its native `libsql` binary is only loaded for local files), `ua-parser-js@1` (CJS, `const { UAParser } = require(...)` or `import uaParser from 'ua-parser-js'`), `i18n-iso-countries` (alpha2 → numeric/name), `qr-code-styling` (browser UMD → global `QRCodeStyling`), `d3@7`, `topojson-client@3`, `world-atlas@2`, `@fontsource/bangers` and `@fontsource/comic-neue` (self-hosted fonts, §7.2), `@phosphor-icons/core` (source of the icon sprite; only `npm run icons` reads it), optional `fast-geoip` (async `lookup(ip)` → `{country, region, city, ll:[lat,lon], ...}` or `null`).

> **Warning:** `fast-geoip` returns bogus data for loopback/private IPs (e.g. `127.0.0.1` → JP). **Never** look up loopback, private (10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10, ::1), CGNAT (100.64/10) or unspecified addresses. Strip `::ffff:` IPv4-mapped prefixes first.

## 1. File layout & ownership

```
blip/
  package.json, .nvmrc, SPEC.md, DESIGN.md, README.md, .gitignore
  server.js             Vercel entry (§7.6): imports express, `export default createVercelApp(process.env).app`; never listens
  vercel.json           Vercel settings (§7.6)
  server/
    index.js            local entry: loadConfig() → createApp() → await ready → listen; graceful shutdown
    vercel.js           export function createVercelApp(env) → createApp() result; never throws, never listens (§7.6)
    app.js              export function createApp(options) → { app, db, ready, close, endStreams, config, bus }
    config.js           export function loadConfig(env = process.env) → Config
    vendor.js           VENDOR_FILES / VENDOR_DIRS: the /vendor URLs and their node_modules sources (§7.2)
    live.js             serveLiveStream(): the polled SSE stream (§7.4)
    db.js               libSQL client wrapper (query/all/get/run/batch), versioned migrations, async query helpers
    themes.js           teaser theme + QR preset ids and the legacy (first-release) ids they replace (§6, §8)
    slugs.js            normalizeSlug, validateSlug, RESERVED_SLUGS, randomSlug, wordSlug, suggestSlugs
    words.js            ADJECTIVES, NOUNS (family-friendly, ≥150 each)
    urls.js             normalizeTargetUrl
    domains.js          domainOptions(config), domainIdeas(keyword)
    analytics.js        parseUserAgent, isBotUA, visitorHash, recordClick helpers, buildStats
    geo.js              lookupGeo(ip, headers) → {country, region, city, lat, lon} | null
    bus.js              in-process wake-ups for live streams (§7.4)
    render.js           renderView(name, vars): template substitution + escaping
    ratelimit.js        in-memory fixed-window limiter middleware factory
    routes/api.js       /api/* router
    routes/redirect.js  /:slug handler
    data/trivia.js      export const TRIVIA = [...] (≥60 short, true, fun facts)
    data/cities.js      real world cities for simulated traffic (§7.5)
    views/teaser.html   server templates (see §6)
    views/expired.html
    views/not-found.html
    views/preview.html
    views/unavailable.html  503 page when there is no database or it can't be reached (§2)
  public/
    index.html          home: create links + feature buttons + "My links"
    dashboard.html      live analytics for one link (slug in location.hash)
    qr.html             QR studio for one link (slug in location.hash)
    favicon.svg
    assets/icons.svg       SHARED Phosphor icon sprite (generated, see §9)
    assets/css/theme.css   SHARED design system (tokens + components from DESIGN.md; extend only in page css)
    assets/css/app.css, dashboard.css, qr.css, pages.css
    assets/css/edit-settings.css  SHARED styles of the Edit settings dialog (classes prefixed .edit-, §10.1)
    assets/js/api.js       SHARED API client + linkStore + toast + icon helpers (already written)
    assets/js/qr-shared.js SHARED QR presets/builder (already written)
    assets/js/edit-settings.js    SHARED Edit settings dialog + Bring back flow: openEditSettings() (§10.1, §10.2)
    assets/js/app.js (+ home/), dashboard.js (+ dashboard/), qr.js (+ qr/), teaser.js, expired.js, not-found.js
  scripts/
    audit-design.mjs    design-rule checker (`npm run audit:design`, must report 0 findings; `npm test` runs it too)
    build-icons.mjs     icon sprite builder (`npm run icons`)
    build-vendor.mjs    copies every /vendor file the pages use into public/vendor (`npm run build`, §7.6)
  test/*.test.js
  data/                 runtime SQLite DB (gitignored)
```

## 2. Config (`server/config.js`)

| env | default | meaning |
|---|---|---|
| `PORT` | `3030` | listen port |
| `HOST` | `127.0.0.1` | listen host |
| `BASE_URL` | `http://localhost:${PORT}`; on Vercel `https://` + `VERCEL_PROJECT_PRODUCTION_URL` when `VERCEL_ENV=production`, else `VERCEL_BRANCH_URL` (or `VERCEL_URL`) | the URL that **actually** serves links today (no trailing slash) |
| `DOMAINS` | `blip.to,cat.ly,go.to,p.wrk` | playful vanity domains offered in the UI |
| `LIVE_DOMAINS` | *(empty)* | subset of `DOMAINS` whose DNS really points at this server |
| `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` | *(unset)* | hosted libSQL database (Turso; the Vercel Marketplace integration sets both). Takes priority over everything below |
| `DATABASE_URL` + `DATABASE_AUTH_TOKEN` | *(unset)* | used when `TURSO_DATABASE_URL` is unset; must be a libSQL URL (`libsql:`, `https:`, `http:`, `wss:`, `ws:` or `file:`), anything else (e.g. `postgres:`) is a startup error that names the variable and scheme, never the URL |
| `LIBSQL_URL` + `LIBSQL_AUTH_TOKEN` | *(unset)* | third choice, same rules |
| `DB_PATH` | `./data/blip.db` (relative to project root) | local SQLite file used when none of the URLs above is set (turned into a `file:` URL); `:memory:` allowed. Never used on Vercel |
| `IP_HASH_SALT` | *(auto)* | if unset, generate 32 random bytes once and persist in `meta` table |
| `ALLOW_DEMO_TRAFFIC` | `true` unless `NODE_ENV=production`; always `true` on Vercel | enables the "Simulate traffic" endpoints |
| `TRUST_PROXY` | `false`; `1` on Vercel | passed to `app.set('trust proxy', ...)` (`true`/`false`/number/string). Behind a proxy use a hop count (usually `1`) or the proxy's address/subnet. `true` trusts a client-supplied `X-Forwarded-For` (rate limits become bypassable), so the server warns at startup. |
| `STREAM_POLL_MS` | `2000` | how often a live stream polls the database (§7.4), 50 to 60000 |
| `STREAM_MAX_MS` | `0` (never); `250000` on Vercel | a live stream ends cleanly after this long (§7.4), 0 to 86400000 |
| `VERCEL` | *(set by Vercel)* | any value but `0`/`false` switches on the Vercel defaults in this table (`onVercel`) |

`Config` object shape (camelCase): `{ port, host, baseUrl, baseHost, domains: string[], liveDomains: string[], dbPath, databaseUrl|null, databaseAuthToken|null, databaseProblem|null, ipHashSalt|null, allowDemoTraffic, trustProxy, streamPollMs, streamMaxMs, onVercel, nodeEnv }`. Explicit variables always win over the Vercel defaults. `databaseUrl` is the first URL variable that is set, else `fileUrlFromPath(dbPath)` (`file:///C:/...` on Windows, `file:///var/...` on POSIX, every path segment percent-encoded), else `:memory:`. `resolveConfig()` keeps an explicit `databaseUrl` and otherwise derives it from `dbPath`, so `{ dbPath: ':memory:' }` is enough for tests. **On Vercel there is no file fallback:** with no URL variable set, `databaseUrl` is `null` and `databaseProblem` says what to do (add Turso from the Vercel Marketplace, connect a database, with a separate one for Preview, redeploy); a URL Blip can't use (e.g. `postgres:`, or a local `file:` / `:memory:` database, which a deployed function can't open: read-only files, a copy per instance and no native driver in the bundle) is skipped with its reason (variable and scheme only) added to `databaseProblem`, instead of the startup error it is elsewhere. `resolveConfig({ databaseProblem })` keeps "no database". `baseHost` = host (with port if non-default) of `baseUrl`, e.g. `localhost:3030`. Domains are lowercased, trimmed, deduped; `baseHost` is never duplicated into `domains`.

`createApp(options)` accepts `{ config?: Partial<Config>, now?: () => number /* epoch ms, default Date.now */, geoLookup?: fn, random?: fn }` and merges with `loadConfig({})` defaults so tests can do `createApp({ config: { dbPath: ':memory:' } })`. It stays synchronous and returns `{ app, db, ready, close }`: `ready` resolves once migrations ran and the salt is loaded, and a middleware in front of `/api` and `/:slug` awaits it, so requests during a cold start just wait (static files never do). If the database can't be opened, `ready` rejects, those requests get **503** `unavailable` (`Retry-After: 5`, the failure is logged once per attempt without credentials; JSON for `/api/*` and other non-page requests, the `unavailable` view titled "Blip can’t reach its database right now" for a page request such as `/:slug`) and the next request tries again. Against a database server a start-up attempt also has an overall deadline (`REMOTE_STARTUP_TIMEOUT_MS`, 15 s), so one stalled attempt never holds every request: it fails, and the next request starts a new one. **A query that fails later because the database can't be reached** gets the same 503 `unavailable` response from the error handler (`Retry-After: 5`, the HTML view for page requests and JSON otherwise, logged as "database request failed" without credentials): `isDatabaseUnavailable(err)` in `server/db.js` recognises a timed-out request (`TimeoutError`), an undici `fetch failed` `TypeError` or a socket error code (`ECONNRESET`, `ENOTFOUND` and the like), a `LibsqlError` with code `SERVER_ERROR` (a 5xx from Turso) or `HRANA_*`, a closed client, and `SQLITE_BUSY` / `SQLITE_LOCKED` on a local file, looking through `cause` chains. Every other unexpected error stays **500** `internal`, logged with credentials masked. `createApp({ databaseTimeoutMs, startupTimeoutMs })` overrides both limits (tests). `server/index.js` awaits `ready` before `listen` and exits with a clear message when it rejects.
**Without a database** (`databaseUrl` null) no `Database` is created (`db` is `null`), `databaseProblem` is logged once, `ready` rejects with code `DATABASE_NOT_CONFIGURED` (already handled, so nobody has to await it), static files are still served, and the gate answers **503** for everything else with `Cache-Control: no-store`: `/api/*` (and any non-page request) gets `{ error: { code: 'database_not_configured', message: 'Blip is not connected to its database yet. Add Turso from the Vercel Marketplace and redeploy.' } }`, and a page request (`GET`/`HEAD` preferring HTML, such as `/:slug`) gets the `unavailable` view (§6) saying the same. `createApp({ unavailable: { code, message, title } })` replaces the code and wording; `createVercelApp` uses it for `misconfigured` when `loadConfig` throws (e.g. an invalid `BASE_URL`). `close()` returns a promise, is idempotent, and is safe while `ready` is pending or when the database was closed elsewhere. Everything time-dependent (expiry, stats ranges, timestamps) **must** use the injected `now()`.

## 3. Database (`@libsql/client`)

One small async wrapper (`server/db.js`, class `Database`) is used everywhere: `execute`, `all`, `get`, `run` and `batch(statements, 'write'|'read')`. It returns plain objects, numbers (never BigInt) for counts and ids, and normalised `rowsAffected` / `lastInsertRowid` (a local `... RETURNING` reports 0 rows affected, so it is counted from the returned rows). Named parameters are written `:name` and bound with the prefix, which both the local driver and a server accept.

- **Local file** (`file:` URL, the default): one pooled connection with a 3 s busy timeout (the client's `timeout` option, applied to every connection it opens) and `PRAGMA journal_mode = WAL` once at start-up. The folder is created if missing. `:memory:` is one connection by design.
- **Remote** (`libsql:`/`https:`, e.g. Turso), through `@libsql/client/web` (plain JavaScript, the same HTTP client the default entry uses for these URLs). The default `@libsql/client` entry loads the native `libsql` binary on import, and Vercel's file tracer can't follow its platform-specific require, so it is imported lazily, only when a local file or `:memory:` is opened. Every request may use a different connection, so correctness never depends on per-connection PRAGMAs. Foreign keys may not be enforced: `deleteLink` deletes the link's clicks and the link in one `batch(..., 'write')`, and `insertClick` inserts only `WHERE EXISTS` the link (so a visit recorded after its link was deleted stores nothing and is logged). `ON DELETE CASCADE` stays in the DDL as a backstop only. The HTTP client sets no time limit of its own (undici waits up to 300 s, as long as a Vercel function may run), so `Database` passes it a `fetch` that gives every round trip `REMOTE_QUERY_TIMEOUT_MS` (8 s, request and response body) through `AbortSignal.timeout`. A query that runs out of time rejects with a `TimeoutError` (not wrapped in a `LibsqlError`) and the client stays usable. A write that timed out may still have been applied on the server; that is accepted, because the visitor gets a prompt 503 instead of a 300 s wait.
- Start-up (`migrate`) first reads, in one read batch, whether every table and index exists and `meta.schema_version`; when both are current it is done without taking the write lock. Otherwise the DDL (all `IF NOT EXISTS`) and the version read run in one write batch as before, so a table or index added to the schema is created on the next start.
- Multi-statement work that must be atomic uses `batch(..., 'write')`. `client.transaction()` is not used: with @libsql/client 0.18 it opens a second connection on a local file, and on `:memory:` every other query is rejected while one is open.
- `is_unique` is decided inside the click `INSERT` (`NOT EXISTS` an earlier counted click with the same visitor hash), so concurrent visits can't both be first.
- `deleteSyntheticClicks` deletes and bumps `meta.clicks_epoch` (`CLICKS_EPOCH_KEY`) in one write batch, so live streams on every instance know to recount (§7.4).

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
  teaser_theme      TEXT NOT NULL DEFAULT 'hero',      -- see §6
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

**Migrations.** The schema version is stored in `meta` under `schema_version` (written as text, never lowered). Databases made by the node:sqlite builds kept it in `PRAGMA user_version`; that is read once, only when `meta` has no `schema_version` yet, and left as it was. The schema DDL also runs (idempotently, in one write batch) on every start. Every step is idempotent and safe when two instances cold-start at once: the theme migration rewrites a QR style only while the row still holds the value it read (compare-and-set) and writes everything plus the version bump in one batch, and the IP hash salt is inserted with `ON CONFLICT DO NOTHING` and read back, so both instances use the same one.
- **1**: initial schema.
- **2**: comic redesign ids. Opening a version-1 database runs `migrateLegacyThemeIds(db)`, whose writes and the version bump form one atomic batch: stored `teaser_theme` values are rewritten from the legacy ids to the new ones (§6; any other unknown value becomes `hero`), and `qr_style` JSON whose `preset` is a legacy id becomes the new preset's flat look (§8; the caption and a centre logo the user picked are kept). `updated_at` is not touched. The function is idempotent (a second run changes nothing).
- Databases created at version 1 keep `DEFAULT 'aurora'` on `teaser_theme`, because SQLite cannot change a column default without rebuilding the table. It never takes effect: every insert sets `teaser_theme` explicitly, and reads map legacy values anyway (§5.1).

## 4. Domain rules

### 4.1 Slugs (`server/slugs.js`)
- `normalizeSlug(input)`: NFKD + strip diacritics → lowercase → `&` → `and` → whitespace/underscores/dots/slashes → `-` → drop every char not `[a-z0-9-]` → collapse `-+` → trim leading/trailing `-` → truncate to 64 (re-trim trailing `-`). `"Summer Sale 2026!"` → `"summer-sale-2026"`, `"Café_Menu"` → `"cafe-menu"`.
- Valid: `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` (1 to 64 chars).
- `RESERVED_SLUGS` (exported Set): `api assets vendor static public health healthz admin dashboard qr new create login logout signup about help terms privacy expired preview teaser index favicon robots sitemap well-known`.
- `checkSlug(db, input)` → Promise of `{ input, normalized, valid, available, reason }` with `reason ∈ null|'empty'|'invalid'|'reserved'|'taken'`.
- `randomSlug()`: 7 chars from `abcdefghjkmnpqrstuvwxyz23456789`, crypto-random, retry on collision.
- `wordSlug()`: `adjective-noun` (e.g. `brave-otter`), falling back to `adjective-noun-NN` / `adjective-adjective-noun` on collision.
- Both take a synchronous `isTaken`; `freeRandomSlug()` and `freeWordSlug()` try the same candidates in the same order with an async `isTaken` (one database lookup per candidate tried).
- `suggestSlugs(db, phrase, count=6)`: if phrase given → normalized phrase, phrase + current year, phrase + short word (`-go`, `-now`, `-hq`), `adjective-<phrase>`, ... then word slugs to fill. All returned suggestions must be valid + available + unique. Without phrase → word slugs only. Async: candidates are checked in bulk (`slug IN (...)`), one round trip per round.

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
3. **HEAD** requests: respond like GET status-wise but never record or consume. A HEAD on a click-limited **instant** link answers 302 **without** a `Location` header (it uses no click, so it must not reveal the target); unlimited links keep their `Location`; teaser HEADs send no body.
4. If link not active → log click with `outcome='expired'` (not counted in click totals), respond **410** `expired` view.
5. If bot **and** link has `max_clicks` or `expires_at` → log `outcome='bot-preview'` (is_bot=1, does NOT consume), respond **200** `preview` view (must not reveal the target URL).
6. Otherwise build the click row (UA → device/browser/os; geo; referrer host; visitor hash) and consume atomically, **in the same write batch** as the click insert (`consumeVisitAndRecordClick`):
   `UPDATE links SET click_count = click_count + 1, updated_at=? WHERE id=? AND destroyed_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (max_clicks IS NULL OR click_count < max_clicks) RETURNING *`, then the click `INSERT ... SELECT ... WHERE changes() = 1 AND EXISTS (the link)`. `changes()` is the UPDATE's row count on the batch's connection, so the click row (uniqueness included) is stored exactly when the visit was consumed. The batch is one round trip and atomic: a cancelled request can never consume a visit without its row. A visit therefore makes at most **two** database round trips (look up, then consume + insert).
   Bots on unlimited links are recorded with `is_bot=1` but **do not** increment `click_count`. If no row was updated (lost a race, or the link was stopped meanwhile) → re-read the link and treat as step 4 (its blocked attempt is stored); if the re-read finds **no row** (the link was deleted meanwhile, for example on another instance) → **404** `not-found` view and nothing is stored.
7. Wake this instance's live streams for the link on the bus (§7.4).
8. `redirect_mode='instant'` → **302** `Location: target`. `'teaser'` → **200** `teaser` view (outcome `'teaser'`).
- A visit that consumes nothing (steps 4 and 5, and bots on unlimited links) stores its row with one `insertClick` and waits for it at most `CLICK_WRITE_BUDGET_MS` (1.5 s): a slower write is logged and left to finish on its own, so a stalled database never holds the page back for long (at worst one analytics row is lost). A failing write is logged and the visitor still gets their page.
- All `/:slug` responses: `Cache-Control: no-store`, `X-Robots-Tag: noindex`. Keep the default referrer policy on 302s (do **not** send `Referrer-Policy: unsafe-url`).
- Geo lookup must not delay the redirect noticeably: country headers first (`cf-ipcountry`, `x-vercel-ip-country`, `cloudfront-viewer-country`, `x-country-code`; ignore `XX`/`T1`), else `fast-geoip` (dynamic `import()` once, cached; if import fails geo is just `null`). The `import()` takes its specifier from a variable (`importOptional(GEOIP_PACKAGE)`), so Vercel's file tracer never bundles the 159 MB package. **On Vercel** (`createGeoLookup({ vercel: true })`) only `x-vercel-ip-country`, `x-vercel-ip-city` (URI-encoded), `x-vercel-ip-country-region`, `x-vercel-ip-latitude` and `x-vercel-ip-longitude` are read (other CDNs' headers would come from the visitor) and `fast-geoip` is never loaded. It's fine to insert the click row after a short await of geo (cap with a 150 ms timeout → null).

## 5. HTTP API (`/api`, JSON, `server/routes/api.js`)

- JSON body limit 16 kb. Errors: `{ "error": { "code": string, "message": string, "field"?: string } }`.
- Error `message`s are shown in the UI as they are, so they follow DESIGN.md §11: no em dashes, no emoji, no "it's not X, it's Y" phrasing. Use a comma, colon, period or parentheses, and "1 to 40" style ranges.
- Auth for management endpoints: header **`X-Manage-Token: <token>`**. Missing → 401 `unauthorized`; wrong → 403 `forbidden`; unknown slug → 404 `not_found`. Compare sha256 hashes with `crypto.timingSafeEqual`.
- Manage token: `crypto.randomBytes(24).toString('base64url')`; only its sha256 hex is stored. Returned **once** at creation.
- Rate limits (per client IP, fixed window): `POST /api/links` 20/min; `POST /api/links/:slug/simulate` 30/min; `GET /api/slugs/*` & `/api/domains/ideas` 120/min. 429 `rate_limited` + `Retry-After` header.
- Every `/api` response: `Cache-Control: no-store`.

### 5.1 LinkDTO
```jsonc
{
  "slug": "summer-sale-2026",
  "domain": "cat.ly",                           // effective domain: a stored domain this server no longer serves (old base host, removed vanity) is reported as baseHost
  "domainLive": false,                         // domain === baseHost || liveDomains.includes(domain)
  "shortUrl": "https://cat.ly/summer-sale-2026",   // branded; for baseHost use baseUrl + '/' + slug
  "workingUrl": "http://localhost:3030/summer-sale-2026", // baseUrl + '/' + slug (always works)
  "qrUrl": "http://localhost:3030/summer-sale-2026",      // shortUrl if domainLive else workingUrl
  "targetUrl": "https://example.com/sale",
  "title": "Summer sale" | null,
  "redirectMode": "instant" | "teaser",
  "teaser": { "seconds": 5, "style": "countdown"|"trivia"|"brand", "message": string|null, "theme": "hero"|"caption"|"noir"|"sky"|"paper" },
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
`teaser.theme` and `qrStyle.preset` are always current ids: a legacy id still found in storage is mapped on the way out (§6, §8), an unknown stored theme is reported as `hero` and an unknown stored preset as `custom`. A stored `qr_style` that is not a JSON object is reported as `null`.

### 5.2 Endpoints
| Method & path | Auth | Body / query | Response |
|---|---|---|---|
| `GET /api/health` | no | none | `{ ok: true }` |
| `GET /api/config` | no | none | `{ baseUrl, baseHost, domains: [{ domain, live, isBase }], defaultDomain: baseHost, allowDemoTraffic, teaser: { minSeconds: 3, maxSeconds: 15, defaultSeconds: 5, styles: ['countdown','trivia','brand'], themes: ['hero','caption','noir','sky','paper'] }, limits: { slugMax: 64, titleMax: 120, messageMax: 280, maxClicksMax: 1000000, urlMax: 2048 } }`. `domains[0]` is always the base host (`isBase: true, live: true`). |
| `GET /api/slugs/check?slug=` | no | none | `{ input, normalized, valid, available, reason }` |
| `GET /api/slugs/suggest?phrase=&count=` | no | count 1 to 12 (default 6) | `{ suggestions: string[] }` |
| `GET /api/domains/ideas?keyword=` | no | keyword 1 to 40 chars | `{ keyword, ideas: [{ domain, kind: 'hack'|'short'|'playful', note }] }` (≤12; see §5.3) |
| `POST /api/links` | no | CreateBody | **201** `{ link: LinkDTO, manageToken }`; 400 validation; 409 `slug_taken`; 429 |
| `POST /api/links/batch` | tokens in body | `{ items: [{ slug, token }] }` (≤100) | `{ results: [{ slug, link: LinkDTO|null, error: null|'not_found'|'forbidden' }] }` (same order) |
| `GET /api/links/:slug` | yes | none | `{ link }` |
| `PATCH /api/links/:slug` | yes | UpdateBody | `{ link }` |
| `DELETE /api/links/:slug` | yes | none | **204** (deletes link + clicks) |
| `POST /api/links/:slug/destroy` | yes | none | `{ link }` (sets `destroyed_at=now`; publishes `status` event) |
| `POST /api/links/:slug/revive` | yes | none | `{ link }` (clears `destroyed_at`; time/click expiry must be changed via PATCH) |
| `GET /api/links/:slug/stats?range=&tz=` | yes | `range ∈ 24h|7d|30d|all` (default 7d); `tz` = `Date#getTimezoneOffset()` minutes (default 0) | StatsDTO (§5.4) |
| `GET /api/links/:slug/stream` | yes (header) | none | `text/event-stream` (§7.4) |
| `POST /api/links/:slug/simulate` | yes | `{ count: 1 to 50 }` (default 12) | `{ inserted }`; 404 `not_found` when demo traffic is disabled |
| `DELETE /api/links/:slug/simulated` | yes | none | `{ deleted }` |

**CreateBody**: `{ targetUrl (required), slug?, slugStyle?: 'words'|'random' (used only when slug empty; default 'words'), domain? (default baseHost; must be baseHost or in DOMAINS), title? (≤120), redirectMode?, teaser?: { seconds?, style?, message?, theme? }, expiresAt? (ISO string or epoch ms; must be in the future and ≤ 5 years out), expiresInSeconds? (60 to 157680000; alternative to expiresAt), maxClicks? (1 to 1 000 000), qrStyle? }`.
If `slug` is provided it is normalized; invalid → 400 `slug_invalid`, reserved → 400 `slug_reserved`, taken → 409 `slug_taken` (field `slug`). `teaser.message` is required (non-empty) when `style='brand'` → else 400 `validation` field `teaser.message`. Unknown enum values → 400 `validation` with the field name.
`teaser.theme` also accepts the legacy ids from the first release (`aurora`, `sunset`, `ocean`, `neon`, `candy`) and stores their replacements (§6); `qrStyle.preset` does the same for legacy preset ids (§8). Error messages list only the current ids.

**UpdateBody**: any of `targetUrl, title, domain, redirectMode, teaser (partial merge: only the keys sent change), expiresAt (null clears), expiresInSeconds (counted from now; null clears), maxClicks (null clears), qrStyle (null clears)`. Slug is immutable. Same validation (and the same legacy id mapping) as create, except `expiresAt` may not be in the past.
- Send only what changed: re-sending `expiresInSeconds` restarts the timer from now.
- A `maxClicks` at or below the current `clickCount` expires the link at once (reason `clicks`); raising it above `clickCount`, clearing it, or moving `expiresAt` into the future brings a time- or click-expired link back to `active`. A destroyed link stays destroyed until `/revive`.
- Whenever a PATCH changes `status` or `expiredReason`, the server publishes a `status` event (§7.4).
- The brand-message rule is checked against the merged result, so switching `teaser.style` to `brand` needs a stored message or one in the same request.
- Validation errors carry `field`: `targetUrl`, `title`, `domain`, `redirectMode`, `teaser`, `teaser.seconds`, `teaser.style`, `teaser.message`, `teaser.theme`, `expiresAt` (also used when both expiry fields are sent), `expiresInSeconds`, `maxClicks`, `qrStyle.<key>` or `slug`. The client's `ApiError` exposes it as `.field`.

### 5.3 Domain ideas (`server/domains.js`)
Pure function, no network. Use only real short TLDs: `ly to me io co gg sh is it at be so im es us in al am fm tv cc ai ws la vc st nu ink link`.
- **hack**: keyword ends with a TLD → split it (`delicious` → `delicio.us`, `catly` → `cat.ly`, `bitsy` → `bit.sy` only if `sy` is in the list).
- **short**: keyword (≤12 chars) or its vowel-less abbreviation (`summer` → `smmr`) + `.ly/.to/.gg/.sh/.co`.
- **playful**: `go<kw>.to`, `<kw>.link`, `hey<kw>.co`, `<kw>hq.io`, `<first-letter>.<kw-if-tld>`.
Dedupe, cap 12, each with a short human `note` ("Domain hack: the TLD finishes the word"). Notes follow the same copy rules as error messages. Keyword is normalized to `[a-z0-9-]`.

### 5.4 StatsDTO
```jsonc
{
  "slug": "...", "range": "7d", "generatedAt": "ISO", "throughClickId": 0,
  "totals": { "clicks": 0, "uniqueVisitors": 0, "botClicks": 0, "blockedAfterExpiry": 0, "expiredBotClicks": 0, "last24h": 0, "syntheticClicks": 0 },
  "timeseries": { "bucket": "hour"|"day"|"week"|"month", "points": [{ "t": "ISO bucket start (in the client's tz)", "clicks": 0 }] },
  "devices":   [{ "name": "mobile", "count": 3 }],
  "browsers":  [{ "name": "Chrome", "count": 3 }],
  "os":        [{ "name": "Windows", "count": 3 }],
  "referrers": [{ "name": "direct" | "twitter.com", "count": 3 }],
  "countries": [{ "code": "GB", "numeric": "826", "name": "United Kingdom", "count": 3 }],
  "points":    [{ "lat": 51.5, "lon": -0.1, "city": "London", "country": "GB", "count": 2 }],
  "recent":    [ClickEvent, ...]    // newest first, max 25
}
```
- "clicks" = rows with `outcome IN ('redirect','teaser') AND is_bot = 0` (synthetic included; `syntheticClicks` shows how many of them are synthetic). `botClicks` = rows with `is_bot=1`. `blockedAfterExpiry` = `outcome='expired'`. These two overlap (a bot on an expired link is both); `expiredBotClicks` = `is_bot=1 AND outcome='expired'` is that overlap, so the dashboard's "Bots & blocked" = `botClicks + blockedAfterExpiry − expiredBotClicks`.
- `24h` → 24 hourly buckets ending at the current hour; `7d`/`30d` → 7/30 daily buckets ending today.
- `all` → one bucket for every step from the link's first moment (its creation, or an earlier click, since simulated clicks are spread over the past week) to now, sized by that span:
  - `day` while it covers at most **365** local days;
  - else `week` while it covers at most **520** weeks; weeks start on **Monday 00:00** local time;
  - else `month`: calendar months starting on the **1st at 00:00** local time (buckets differ in length).
- Buckets are aligned in the client's tz using `tz` (minutes, JS sign convention: UTC − local, so local time = UTC − `tz` minutes; east of UTC is negative). `tz` is a fixed offset, so `t` is the UTC instant of the local bucket start (e.g. `tz=-60`: Monday Oct 12 00:00 local is `2026-10-11T23:00:00.000Z`). Empty buckets present with `clicks: 0`.
- Totals, `uniqueVisitors`, breakdowns, `countries` and `points` cover the range's window: the last 24 hours, 7 or 30 local days, or, for `all`, **every click the link has ever had** (the same totals as the SSE `hello` event). `last24h` is always the rolling last 24 hours.
- `buildStats()` runs all of its queries (totals, last 24 hours, time series, breakdowns, countries, map points, recent clicks and, for `all`, the earliest click) in one `batch(..., 'read')`: one round trip and one consistent snapshot, even on a remote database. Range `all` counts its time series per local day from a local midnight before any timestamp and folds the days into its day, week or month buckets once the earliest click is known.
- Breakdown lists sorted desc, top 8 + `"Other"` aggregate for browsers/os/referrers; countries all (sorted desc); points grouped by rounded lat/lon (max 300).
- `uniqueVisitors` = distinct `visitor_hash` among counted clicks in range.
- `throughClickId` = the highest click id stored (any link) when the snapshot was read, from the same read batch. Writes are serialised and ids only grow, so every click with an id up to it is in the snapshot: the dashboard skips live `click` events with `id <= throughClickId` instead of counting them twice (a visit served by another instance reaches a stream up to `streamPollMs` late, often after a refresh already counted it).

**ClickEvent**: `{ id, ts: "ISO", country: "GB"|null, countryName: "United Kingdom"|null, numeric: "826"|null, city: string|null, lat, lon, device, browser, os, referrer: string|null, isBot, isSynthetic, isUnique, outcome }`.

## 6. Server-rendered views (`server/views/*.html`, `server/render.js`)

Templates are full HTML documents with placeholders; `renderView(name, vars)` reads the file (cache in production) and substitutes:
- `{{text:KEY}}` → HTML-escaped (`& < > " '`) string.
- `{{attr:KEY}}` → same escaping (safe inside double-quoted attributes).
- `{{json:KEY}}` → `JSON.stringify(value)` with `<`, `>` and `&` written as `\u003c`, `\u003e` and `\u0026`, and U+2028/U+2029 escaped. Only used inside `<script type="application/json" id="blip-data">...</script>`.
- `{{raw:KEY}}` is **not** supported. Unknown placeholders render as empty string.

Views must not contain inline `<script>` code (CSP); they load `/assets/js/teaser.js`, `/assets/js/expired.js` or `/assets/js/not-found.js` as `<script type="module" src>`. Like every page they load the fonts, `theme.css` + `pages.css`, the icon sprite and the shared background markup described in §9 and DESIGN.md, and follow DESIGN.md's copy rules (tests check that every rendered view is free of em dashes and emoji and only references assets that exist).

| view | status | vars |
|---|---|---|
| `teaser` | 200 | `TITLE` (text), `TARGET` (attr, for the `<noscript>` link and `<meta http-equiv="refresh" content="{{attr:REFRESH}}">`), `REFRESH` = `"<seconds+1>;url=<target>"`, `THEME` (attr, for `<body data-theme>`), `DATA` (json: `{ slug, title, targetUrl, targetHost, seconds, style, message, theme, fact }`) |
| `expired` | 410 | `TITLE`, `DATA` (json: `{ slug, reason: 'time'|'clicks'|'manual', expiredAt: ISO|null, clickCount, maxClicks }`) |
| `not-found` | 404 | `SLUG` (text), `DATA` (json: `{ slug }`) |
| `preview` | 200 | `TITLE`: generic "Open this Blip link in your browser" page; never includes the target |
| `unavailable` | 503 | `TITLE`, `MESSAGE` (text): the "not connected yet" page served when there is no database, or the database can't be reached (§2); no script |

**Teaser themes** (`server/themes.js`, `TEASER_THEMES`): `hero` (red, white text), `caption` (yellow, ink text), `noir` (ink, white text), `sky` (blue, white text), `paper` (newsprint, ink text); default `hero`. Colours come from `--theme-<id>-bg` / `--theme-<id>-fg` in theme.css. Legacy ids map `aurora` → `hero`, `sunset` → `caption`, `ocean` → `sky`, `neon` → `noir`, `candy` → `paper` (`LEGACY_TEASER_THEMES`). `THEME` and `DATA.theme` are always a current id (`teaserThemeId()`: legacy values mapped, anything unknown becomes `hero`).

Teaser page requirements: full-screen page in the link's theme (`data-theme`), the seconds counting down inside a comic burst (`role="timer"`) with a countdown bar, style-specific narration caption (trivia "Did you know?" fact / the brand message / a short "Meanwhile..." line for pure countdown), destination host shown ("Taking you to **example.com**"), **Go now** (the primary button) and **Cancel** (stops the countdown) buttons, after the countdown `location.replace(targetUrl)`. Respect `prefers-reduced-motion`.
Expired page: a "KA-BOOM!" sound-effect burst and the heading "This link has self-destructed", with reason-specific copy ("It was set to vanish after 1 click, and someone got here first." / "Its timer ran out on <date>." / "Its owner hit Destroy now."), and a "Make your own Blip" button → `/`.
Not-found page: playful 404 with a "WHOOPS!" burst ("This Blip doesn't exist (yet)"), which checks the slug with `/api/slugs/check` and offers a button to `/?slug=<slug>` to claim it.

## 7. Security & platform behaviour

### 7.1 Headers (all responses)
`Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. `app.disable('x-powered-by')`.
→ **No inline scripts or inline event handlers anywhere.** External links opened by the frontend use `rel="noopener noreferrer"`.

### 7.2 Static & vendor routes
- `express.static('public', { extensions: ['html'] })`, so `/dashboard` serves `dashboard.html`. (Hence `dashboard`, `qr` are reserved slugs.)
- `/vendor/qr-code-styling.js` → `node_modules/qr-code-styling/lib/qr-code-styling.js`
- `/vendor/d3.min.js` → `node_modules/d3/dist/d3.min.js`
- `/vendor/topojson-client.min.js` → `node_modules/topojson-client/dist/topojson-client.min.js`
- `/vendor/countries-110m.json` → `node_modules/world-atlas/countries-110m.json` (country `id`s are ISO numeric strings, sometimes zero-padded, so compare with `Number(id)`)
- `/vendor/fonts/bangers/` → `node_modules/@fontsource/bangers/` (use `latin-400.css`, family `'Bangers'`)
- `/vendor/fonts/comic-neue/` → `node_modules/@fontsource/comic-neue/` (use `latin-400.css` + `latin-700.css`, family `'Comic Neue'`)
- Font directories are served without directory listings. The first release's `/vendor/lucide.min.js`, `/vendor/fonts/inter/` and `/vendor/fonts/space-grotesk/` routes are gone (they answer 404) and must not be referenced.
- Icons are not a vendor route: they ship as the static sprite `public/assets/icons.svg` (§9).
- The mapping lives in `server/vendor.js`. Vendor routes are mounted before `express.static`, so a local run always serves the installed versions. On Vercel the CDN serves `public/**` and `express.static` never runs, so `npm run build` (`scripts/build-vendor.mjs`) copies every `/vendor/` URL found in `public/**/*.html|css|js` and `server/views/*.html`, plus the files their stylesheets `url()`, into `public/vendor/` at the same path (gitignored), and fails on a reference it can't resolve. The design audit skips `public/vendor/`.

### 7.3 Never
- store raw IPs; reflect user input into HTML without escaping; use `innerHTML` with user/link data on the frontend (use `textContent` / the `el()` helper); allow non-http(s) targets; log manage tokens.

### 7.4 Live stream (`GET /api/links/:slug/stream`)
SSE over a normal GET with the `X-Manage-Token` header (the frontend reads it with `fetch` + `ReadableStream`, **not** `EventSource`, so the token never goes in the URL). Headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `Connection: keep-alive`, `X-Accel-Buffering: no`; call `res.flushHeaders()`.
Events (each `event: <name>\ndata: <json>\n\n`):
- `hello` → `{ slug, totals }` (same totals as StatsDTO for range `all`) immediately on connect.
- `click` → ClickEvent + `{ totals: { clicks, uniqueVisitors } }` (all-time counted clicks) for every click stored after `hello` (real or synthetic; bot-preview/expired events also sent with their outcome so the feed can show "blocked" attempts), in id order.
- `status` → `{ status, expiredReason, clickCount, clicksRemaining }` whenever any of those four changes: the link expires (by clicks or by time), is destroyed or revived, a PATCH moves its limits, or a real visit changes `clickCount`. Sent after the clicks of the same poll.
- comment heartbeat `: ping\n\n` every 15 s.

**Fed by polling, so it works across stateless instances** (`server/live.js`). On connect the stream reads one snapshot (one read batch): the `hello` totals, `throughId` (the highest click id stored), the link row and `meta.clicks_epoch`. Then every `streamPollMs` it runs one read batch: `MAX(id)` of clicks, the link's clicks with `id > cursor` (`+link_id` keeps SQLite on the primary key, so only rows stored since the last poll are read) `ORDER BY id LIMIT 200`, the link row and the epoch. Running totals start from `hello` and add each counted row (`is_unique` adds a unique visitor); the cursor then moves to `MAX(id)` (or the last row, when the page was full and the next poll follows at once). When the epoch moved (simulated clicks were cleared anywhere), the totals are recounted up to the cursor first. Rows of one poll go out `STREAM_STAGGER_MS` (120 ms) apart, with the whole burst spread over at most 6 s, so simulated traffic animates. A deleted link (no row) ends the stream; three failed polls in a row end it too. With `streamMaxMs` > 0 the stream ends cleanly after that long and the client reconnects (fresh `hello`, and the dashboard refetches stats).
The bus (`server/bus.js`) carries no data: visits, PATCH, destroy, revive, delete, simulate and clear call `wake(bus, linkId)`, and streams of that link on the same instance poll at once instead of at their next tick. Unsubscribe on `req.on('close')`.
Concurrent streams are capped (default 10 per link, 20 per client IP, with IPv6 keyed by /64; `createApp({ streamLimits })` overrides). The route keeps each open stream as an entry `{ stream, linkId, client, openedAt }` in `Set`s per link and per client, oldest first (`serveLiveStream`'s `onOpen` hook hands it the stream's handle). A connection that would pass a cap first ends **the same client's** oldest stream that is at least `STREAM_EVICT_AFTER_MS` (30 s, two heartbeats) old: on the link for the per-link cap, on any link for the per-client cap. That clears dashboards whose disconnect never reached the server, while a client with many dashboards really open can't make them take turns. Only when nothing can be ended (the link is full of other clients' streams, or every candidate is younger) does the connection get **429** `rate_limited` + `Retry-After` (the frontend client simply reconnects with backoff), so another client can never end the owner's streams. The caps are counted per server instance.

### 7.5 Simulated traffic
Only when `allowDemoTraffic`. Inserts `count` clicks with `is_synthetic=1`, plausible random (via injected `random`) countries with real city coords (bundle ~40 world cities with country/lat/lon), device mix (~55% mobile, 38% desktop, 7% tablet), browser/os mixes, referrers (`direct`, `twitter.com`, `instagram.com`, `news.ycombinator.com`, `reddit.com`, `linkedin.com`, `google.com`), timestamps spread over `[now − 6 days, now − 60 s]` (so they stay inside the 7-local-day view in every time zone) except the last few which are `now()`. Synthetic clicks never touch `click_count`. All rows are inserted in one write batch before the response; nothing is scheduled after it. Open dashboards receive them through their stream's next poll (woken at once on the same instance), staggered ~120 ms apart (§7.4).

### 7.6 Vercel
One Express function on Fluid compute, data in Turso, static files on Vercel's CDN.
- `server.js` (root) contains `import 'express'` (Vercel's Express detection looks for an import of express in `app`, `index`, `server`, `src/app`, `src/index` or `src/server`) and `export default createVercelApp(process.env).app`. Nothing in its import chain listens or exits; local runs keep using `server/index.js`.
- `vercel.json`: `"framework": "express"` (overrides the project's "Other" preset), `"buildCommand": "npm run build"`, `"fluid": true`, `"functions": { "{index,server}.js": { "maxDuration": 300, "supportsCancellation": true } }`, rewrites `/dashboard` → `/dashboard.html` and `/qr` → `/qr.html` (what `express.static`'s `extensions` does locally), the §7.1 security headers on every path (the CDN serves `public/**` without the app), and `Cache-Control: public, max-age=604800` on `/vendor/*`.
- The `functions` key: Vercel's Express preset builds the app under the source name `index.js` (its build `src`), whatever the entry file is called, and matches `functions` patterns against that name. A `"server.js"` key is accepted but silently ignored (checked with `vercel build` 63.1.0: only a pattern matching `index.js` puts `maxDuration` and `supportsCancellation` into the function's `.vc-config.json`), so the pattern `{index,server}.js` covers that name and the entry file's own, in case a later builder matches the real entry. Request cancellation is opt-in on Vercel: without it a closed dashboard is never reported to the function and its stream runs until `STREAM_MAX_MS`; with it `req`/`res` `close` fire as on a local server. `maxDuration` 300 is the limit `VERCEL_STREAM_MAX_MS` (250 s) stays under.
- The function bundle (about 3 MB) holds `server.js`, `server/**` (views included) and the traced packages: never `fast-geoip` (§4.4) and never a native libSQL binary (§3).
- Defaults on Vercel (§2): `BASE_URL` from the deployment, `TRUST_PROXY=1`, demo traffic on, `STREAM_MAX_MS=250000`, no `DB_PATH` fallback, and 503 `database_not_configured` until Turso's `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` are set.
- Per instance: rate limits and stream caps. Shared through the database: links, clicks, the salt, live streams (by polling).
- `vercel dev` does not set `VERCEL`, so there Blip uses its local defaults unless the shell sets `VERCEL=1` (then it needs a `libsql:`/`https:` URL, as on Vercel). Vercel sets `VERCEL` only while the project's "Automatically expose System Environment Variables" setting is on (the default); `createVercelApp` logs a warning when it is missing.
- `BASE_URL` defaults to `VERCEL_PROJECT_PRODUCTION_URL` in production, which Vercel documents as the project's **shortest** production domain, so once a custom domain (or a short vanity domain) is added to the project, `BASE_URL` should be set explicitly for Production.

## 8. QR style (`qrStyle`)
Flat object, validated server-side (whitelisted keys only, JSON ≤ 2 kB, unknown keys dropped, invalid values → 400 `validation` field `qrStyle.<key>`):
```jsonc
{
  "preset": "ink"|"hero"|"caption"|"sky"|"pop"|"press"|"noir"|"custom",
  "dotType": "square"|"dots"|"rounded"|"classy"|"classy-rounded"|"extra-rounded",
  "dotColor": "#rrggbb", "dotColor2": "#rrggbb"|null,          // dotColor2 → optional two-tone dot fill
  "gradientType": "linear"|"radial", "gradientRotation": 0-360,  // how the two tones blend
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
- **Presets** (`QR_PRESETS` in `public/assets/js/qr-shared.js`, the single source: `server/themes.js` imports it and derives its id list from it): `ink`, `hero`, `caption`, `sky`, `pop`, `press`, `noir` (all flat comic colours) plus `custom`.
- **Legacy preset ids** (`LEGACY_QR_PRESETS`, the same map as `LEGACY_PRESETS` in qr-shared.js): `aurora` → `hero`, `sunset` → `pop`, `ocean` → `sky`, `neon` → `noir`, `mono` → `ink`, `candy` → `caption`, `forest` → `press`. On create and PATCH only the id is renamed (the request's other keys are kept as sent). A style already stored under a legacy id is different: the first-release studio switched to `custom` on every colour or shape edit, so a stored legacy id means the old preset's look (gradients, rounded shapes, off-palette colours). The version-2 migration (§3) and `storedQrStyle()` on read replace it with the new preset's flat look, keeping the caption and any centre logo the user chose instead of the old preset's own (`upgradeLegacyQrStyle()` in qr-shared.js; the browser's `normalizeQrStyle()` applies the same upgrade).
- The two-tone dot fill (`dotColor2` + `gradientType` + `gradientRotation`) styles the user's own code, so the QR studio may offer it, but it is off in every preset and off by default (DESIGN.md §12).
- The browser-side presets, logo SVGs and the `buildQrOptions()` mapping live in `public/assets/js/qr-shared.js` (already written: import from it, don't duplicate).

## 9. Frontend conventions
DESIGN.md is the source of truth for the look; this section only lists the wiring every page shares.
- Every page: `<!doctype html>`, `lang="en"`, viewport meta, `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`, then the fonts, `/assets/css/theme.css` and the page css:
  ```html
  <link rel="stylesheet" href="/vendor/fonts/bangers/latin-400.css">
  <link rel="stylesheet" href="/vendor/fonts/comic-neue/latin-400.css">
  <link rel="stylesheet" href="/vendor/fonts/comic-neue/latin-700.css">
  ```
  Scripts as `<script type="module" src="...">` (UMD vendor libs as classic `<script src defer>`, normally placed **before** the module script so their globals exist when it runs. A page may put its module first only when it waits for the globals itself: the dashboard does this so routing never waits on the d3 download, and `dashboard/vendor.js` waits for, or reloads, d3 and topojson before drawing).
- Background markup right after `<body>` (newsprint with drifting halftone dots; DESIGN.md §6):
  ```html
  <div class="bg" aria-hidden="true"><div class="bg-dots"></div><div class="bg-dots bg-dots--red"></div><div class="bg-dots bg-dots--blue"></div></div>
  ```
- Shared header: a `.skip-link` ("Skip to content", or "Skip to the link box" on home) right after the background, then `<header class="site-header container"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">blip</span></a><nav class="site-nav" aria-label="Main">...</nav></header>`. The app pages (home, dashboard, QR studio) share one nav: Home, My links (with the `#navLinkCount` badge; `syncNavCount()` from `api.js` on the dashboard and QR studio), Dashboard (`#nav-dashboard`) and QR studio (`#nav-qr`), each with a sprite icon, `aria-current="page"` on the current one, and the dashboard and QR links pointing at the open link's `#<slug>`. Below 560 px the nav shows icons only (labels stay for assistive tech). Server views carry the brand and a single "Make your own" link.
- Shared footer: `.site-footer` with `.footer-made` ("Made with Blip. Tiny links with big personality.") and, on the app pages, the `.footer-privacy` line.
- Use `api.js` for **every** API call, `linkStore` for tokens (`localStorage` key `blip.links.v1`), `toast()` for feedback, `el()` for DOM building from data.
- **Icons**: Phosphor "bold" glyphs in the sprite `public/assets/icons.svg`, built by `npm run icons` (`scripts/build-icons.mjs` lists every id and the Phosphor glyph behind it). In HTML: `<svg class="icon" aria-hidden="true" focusable="false"><use href="/assets/icons.svg#copy"></use></svg>`. In JS: `icon('copy')` returns the same element and `setIcon(svg, 'eye-off')` swaps a glyph in place (both from `api.js`). Only use ids that exist in the sprite (`npm run audit:design` flags unknown ones). Icon-only buttons need an `aria-label`. No sparkle, wand, confetti or party icons.
- **Countries**: show the 2-letter code in a small badge (`countryCode()` from `api.js`) next to the country name. Flag emoji are not used anywhere.
- **Loading, empty and error states**: every view that fetches data shows `.skeleton` placeholders shaped like the final layout, then an empty state with one sentence of guidance or an error with a short explanation and a Retry button (DESIGN.md §10).
- **Copy**: no emoji or decorative symbol glyphs, no em dashes, no "it's not X, it's Y" lines (DESIGN.md §11). `npm run audit:design` must report 0 findings.
- Accessibility: every control keyboard-reachable with visible focus (`--blue` outline), `aria-pressed` on toggle buttons, `aria-expanded` + `aria-controls` on disclosure buttons, `aria-live="polite"` regions for async results, labels on all inputs, contrast ≥ 4.5:1 for text (white on red, blue, green and ink; ink on yellow, paper and panel). Focus on stateful tiles (checked radios, pressed/expanded toggles) is drawn with `outline`. Respect `prefers-reduced-motion` (all animation stops). Layout works from 360 px wide (16 px gutters, no horizontal scroll).
- Page hash routing: `dashboard.html#<slug>`, `qr.html#<slug>`. If no token for that slug in `linkStore`, show a friendly empty state with a link home (and on dashboard, a field to paste a manage token which is then saved to `linkStore`).

## 10. Home page (`index.html` + `app.js` + `app.css`)
1. Hero: logo, tagline, a Bangers headline and one bordered "shortener" panel: URL input (auto-prefixes `https://` on blur when missing scheme; validates inline) + **Shorten** primary button (Enter submits).
2. **Feature toolbar**: six large toggle buttons (`.feature-btn` in a `.feature-grid` of 1 column on phones and 2 from 640 px, never 3; `aria-pressed` = the feature is switched on, `aria-expanded` + `aria-controls` = its option panel is open), each opening its option panel inside the panel (multiple may be open). Active features show a small summary chip with a sprite icon under the input (e.g. "1 click", "cat.ly"); clicking a chip re-opens the panel.
   1. **Custom slug** (`pencil-line`): text input with live prefix showing chosen domain (`cat.ly/`), live normalization preview (an `arrow-right` sprite icon, then `cat.ly/summer-sale-2026`), debounced (300 ms) availability check with an available/unavailable state (icon + words) and the reason, **Word slug** button (calls suggest with no phrase), **Suggest from phrase** → chips of suggestions from `/api/slugs/suggest?phrase=<input or page title>`; clicking a chip fills the slug.
   2. **Playful domain** (`globe`): chip list from `/api/config.domains` (base host labelled "live", others "vanity" + tooltip "Point this domain's DNS at your Blip server to make it live"), plus **Domain idea generator**: keyword input + **Generate** button → idea cards, 1 or 2 per row (domain, kind badge, note, "Check availability" link with an `external-link` icon to `https://lookup.icann.org/en/lookup?name=<domain>` opened in a new tab with `rel="noopener noreferrer"`). Clicking an idea copies it (we can't buy domains for the user, so say so in a one-line hint).
   3. **Teaser page** (`clapperboard`): switch "Show a teaser before redirecting", style segmented control (Countdown / Trivia / Brand message), seconds slider 3 to 15, brand message textarea (counter /280; required for Brand), theme swatches (hero, caption, noir, sky, paper), and a mini live preview tile of the teaser.
   4. **Self-destruct** (`timer` / `bomb`): preset buttons: "After 1 click (burn after reading)", "After 10 clicks", "1 hour", "24 hours", "7 days", "Custom..." (datetime-local input + clicks number). Combined summary ("Vanishes after 10 clicks or on Oct 9, 14:00, whichever comes first"). "Never" resets.
   5. **Live analytics** (`activity`): explains the dashboard; after a link exists, button **Open live dashboard** → `/dashboard.html#<slug>`; before, a note "Every link gets a live dashboard. Create one first." and a "See my links" scroll button. (Analytics is always on.)
   6. **QR studio** (`qr-code`): preset swatches (from `QR_PRESETS`) + logo picker (from `LOGOS`) chosen before creation (sent as `qrStyle`); the preview encodes what `qrUrl` will be (branded URL only for a live domain, else the working URL); after creation the result panel shows the styled QR and **Open QR studio** → `/qr.html#<slug>`.
3. Result panel (a one-shot "BLIP!" burst when it appears; announced through a dedicated `role="status"` polite live region outside the panel. The panel itself is not a live region, and countdowns use `role="timer"` + `aria-live="off"` so ticking is never read aloud): branded short URL big, "live"/"vanity preview" badge; if vanity and not live, a second row "Works right now: <workingUrl>" with its own copy button. A **Manage key** row (masked by default, Show/Hide + Copy key) so the token can be backed up and pasted into the dashboard on another device. Buttons: **Copy**, **Open**, **QR studio**, **Live dashboard**, **Share** (Web Share API when available), **Edit settings** (§10.1), **Destroy now** (confirm) on an active link or **Bring back** (§10.2) once it has stopped, mini styled QR (click → download PNG), summary of options (teaser, expiry, clicks remaining). A save in the dialog re-renders the panel (URLs, badges, QR, summary) from the returned LinkDTO.
4. **My links** section: from `linkStore` via `api.batch` (row skeletons while loading); each row: short URL, target host, status badge (active/expired/destroyed), clicks (and remaining), expiry countdown, actions (copy, dashboard, QR, copy manage key, **Edit settings** (§10.1), **Destroy now** on an active link or **Bring back** (§10.2) on an expired or destroyed one, delete with confirm). Keyboard focus follows the row's action across re-renders (Destroy now → Bring back, and back to the row's Edit settings button when the dialog closes) and moves to a neighbour after delete. Removes entries from `linkStore` if the server says `not_found`. Empty state (an icon in a yellow square, never an emoji). Refresh button.
5. Supports `/?slug=<x>` (from the 404 page) → pre-opens the Custom slug panel with that value.
6. Footer: small "Made with Blip" + privacy note ("we never store IP addresses").

### 10.1 Edit settings dialog (shared by §10 to §12)
Every setting picked at creation stays editable afterwards. One module builds the dialog for every page:
```js
// public/assets/js/edit-settings.js
export async function openEditSettings(link, token, { config, focus = 'general', onSaved } = {})
```
- `link` is the current LinkDTO and `token` its manage key. `config` is the `/api/config` payload; when it is omitted the module fetches it once with `api.config()` and caches it.
- `focus` is `'general' | 'domain' | 'teaser' | 'destruct'`: the section scrolled into view, with its first control focused.
- Resolves to the updated LinkDTO after a successful save (or revive), or `null` when the user cancels or closes the dialog without saving. `onSaved(link)` is also called after each successful save, so the page can re-render at once.
- The module builds its own `<dialog class="modal edit-dialog">` with `el()` / `icon()` from `api.js` (one instance, reused), so pages need no extra markup. All of its styles live in `public/assets/css/edit-settings.css` (classes prefixed `.edit-`); a page that uses it adds `<link rel="stylesheet" href="/assets/css/edit-settings.css">` after its own page css.

Sections, saved together through `PATCH /api/links/:slug` with only the fields that changed (§5.2):
1. **General** (`general`): title (up to 120 characters, empty clears it) and destination URL (normalised and loop-checked like on create).
2. **Domain** (`domain`): the domains from `/api/config` (the base host labelled live, the others vanity, as in the Playful domain panel above); the slug itself never changes.
3. **Teaser** (`teaser`): the "Show a teaser before redirecting" switch (`redirectMode`), style (Countdown / Trivia / Brand message), seconds 3 to 15, brand message (counter /280, required for Brand) and theme swatches, sent as a partial `teaser` object.
4. **Self-destruct** (`destruct`): a "Right now" line with the current rule and the clicks already used, then two choices that start at **Keep current** (which sends nothing):
   - **Time**: No time limit (`expiresAt: null`), 1 hour / 24 hours / 7 days (`expiresInSeconds`, counted from the save) or Custom date (a future `datetime-local`, sent as `expiresAt`).
   - **Clicks**: No click limit (`maxClicks: null`) or Allow more clicks ("How many more clicks?", sent as `maxClicks = clickCount + N`). A limit at or below the clicks already used would stop the link at once (§5.2), so the dialog only frames a new limit relative to them.
   - The footer previews the outcome ("After saving": status badge, expiry, clicks left) as the user edits.

Errors: an `ApiError` from the save carries `.field` (`title`, `targetUrl`, `domain`, `teaser.message`, `teaser.seconds`, `expiresAt`, `expiresInSeconds`, `maxClicks`, ...); the dialog shows the message next to that control, scrolls its section into view and focuses it, and stays open. Other failures show an error notice with the message and keep the user's edits. The dialog has one `.btn--primary` (save, `.is-loading` while saving); cancel and close are secondary. It follows DESIGN.md (comic panel, radius 0, no shadows, sprite icons, copy rules) and works from 360 px wide.

### 10.2 Bring back
A link that stopped (expired by time, expired by clicks, or destroyed by hand) is recoverable by its owner. Wherever its owner sees it stopped (the result panel and My links, where **Bring back** takes the place of **Destroy now**, the dashboard header's notice and the QR studio's red status note under the preview), it offers **Bring back**, which opens Edit settings at the Self-destruct section (`focus: 'destruct'`) with a line saying why the link stopped:
- **Destroyed** (`expiredReason: 'manual'`): the section shows an **Undo Destroy now** switch, already on when the dialog opens at `destruct` (Bring back), so Bring back then Save is enough; saving with it on sends any changed limits first (`PATCH`), then `POST /api/links/:slug/revive`, which clears only the manual destroy. A timer or click limit that has also run out is changed in the same save.
- **Expired by time** (`'time'`): pick a new time in the future, or Never.
- **Expired by clicks** (`'clicks'`): raise the click limit above the clicks already used, or remove it.

`openEditSettings` resolves with the revived or saved LinkDTO; the caller re-renders from it (status badge `active`, countdown, clicks remaining) and confirms with a toast. The server publishes the matching `status` event, so open dashboards update too.

## 11. Dashboard (`dashboard.html` + `dashboard.js` + `dashboard.css`)
Header panel with link info (short URL, target, status badge, created, copy button, back home, QR studio link, **Edit settings** (§10.1) and, while the link is expired or destroyed, **Bring back** (§10.2) next to the notice that says why it stopped; a save re-renders the header and the Lifetime cell from the returned LinkDTO), **Live** status caption: a yellow caption with the blinking red live dot while the stream is connected, a paper caption with a yellow dot while connecting or reconnecting, and a grey dot when offline, range segmented control (24h/7d/30d/all).
- One KPI strip panel (cells separated by 2 px ink rules; 4 across on desktop, 2 on phones): Clicks, Unique visitors, Last 24 hours, Lifetime (clicks remaining or time left, or "Never self-destructs"), with "Bots & blocked" in the strip's footer. Numbers are shown as they are (no count-up animation).
- Clicks over time: SVG chart drawn with d3 in one flat colour (axes, hover tooltip with value + bucket label). Labels follow `timeseries.bucket`: hourly, daily, weekly ("Week of Oct 5", weeks start Monday) or monthly ("Oct 2026"). "All time" picks the bucket from the link's age (§5.4).
- **World map**: d3 `geoNaturalEarth1` (or `geoEqualEarth`) + `topojson.feature(countries-110m, objects.countries)`; choropleth by click count on the `--heat-0..4` ramp (zero = `--heat-0`), city markers sized by count, a one-shot "hit" marker at the coordinates of each incoming live click, tooltip on hover (country name + clicks), legend. Responsive (re-render on resize via `ResizeObserver`).
- Breakdowns as horizontal bars (flat fill, ink outline, square ends; no donut or pie charts): devices, browsers, operating systems, referrers, and countries (2-letter code badge + name + count + share bar).
- **Live feed**: newest-first list of ClickEvents (country code, city/country, device icon, browser, referrer, relative time "just now"), new rows slide in; blocked/expired/bot attempts are labelled with a badge.
- Live updates: on `click` events update the KPIs, push into the feed, mark the hit on the map, and refetch stats (debounced 1.5 s) to refresh charts. On `status` events update badges.
- Loading: block skeletons for the charts and map, row skeletons for lists and the feed; an error state with Retry when stats fail to load.
- **Simulate traffic** button (only if `config.allowDemoTraffic`): asks count (10 / 25 / 50 segmented) → POST simulate; a notice "Includes N simulated clicks" + **Clear simulated** button when `syntheticClicks > 0`. Make clear that simulated data is for demo purposes.
- Empty state for zero clicks ("No clicks yet. Share your link, or simulate some traffic to preview the dashboard.").

## 12. QR studio (`qr.html` + `qr.js` + `qr.css`)
Two columns (stacks on mobile): left = big live preview in a bordered panel (no tilt or other pointer effects) with the encoded URL under it; right = controls:
- Preset swatch buttons (`QR_PRESETS`), dot style buttons (visual thumbnails), corner square/dot styles, colour pickers (dots, optional two-tone fill + linear/radial + rotation, background, transparent toggle, corner colours), logo picker (presets + **Upload logo...** (PNG/JPG/SVG ≤ 512 kB, FileReader → data URL, client-only, remembered in `localStorage` per slug), margin slider, caption input.
- Buttons: **Download PNG** (1024 px, with the caption composed on a canvas; any frame has square corners), **Download SVG**, **Copy image** (Clipboard API when available), **Save style** (PATCH `qrStyle`, toast), **Reset**, **Surprise me** (random flat style).
- Loading: a square skeleton for the preview and line skeletons for the controls until the link loads.
- Shows which URL is encoded (`qrUrl`) and explains vanity domains encode the working URL until the domain is live. The link line offers **Edit settings** (§10.1, opened at the Domain section, since the domain decides the encoded URL); while the link is stopped, the red note in the Preview panel that says where scans land offers **Bring back** (§10.2) instead of pointing the owner at the home page; after a save the preview re-encodes the new `qrUrl`, and a style saved with **Save style** is unaffected. Its **Open** control (like the home **Open** and the dashboard's open links) asks "Use up a click?" first on an active click-limited link, because opening it is a counted visit.
- Scannability warning when contrast between dot colour and background is too low (< 3:1) or the two-tone fill is too light.

## 13. Tests (`test/*.test.js`, `npm test`)
Use `node:test` + `node:assert/strict`; spin up `createApp({ config: { dbPath: ':memory:', baseUrl: 'http://localhost:3030', allowDemoTraffic: true }, now: () => clock })` with a mutable `clock`, `await ready`, `server = app.listen(0)`, `fetch` with `redirect: 'manual'`. Cover at least: slug normalization & validation & reserved; word/random slugs; suggestions available; URL normalization (scheme prefix, javascript:/data: rejected, loop rejected, credentials rejected); create (custom slug, word slug default, 409 taken, domain validation, brand message required, expiry validation); auth (401/403/404); PATCH/DELETE; instant 302 + `Cache-Control: no-store`; teaser 200 with escaped data (XSS attempt in title/message must not appear unescaped); expiry by time (advance clock) → 410 + expired page; maxClicks=1 → first 302, second 410; bot UA doesn't consume a limited link (200 preview, target not in body); HEAD doesn't consume; destroy/revive; stats shape, counts and buckets (incl. tz, and range `all` over long spans: every click since creation counted, `week` buckets past 365 days, `month` buckets past 520 weeks, aligned on both sides of UTC); synthetic traffic + clear; simulate disabled → 404; SSE receives `hello` and `click` (with polling, also from a second app instance on the same database file) and ends after `STREAM_MAX_MS` when set small; domain ideas (`delicious` → `delicio.us` present); rate limiting returns 429; CSP header present; unknown slug → 404; reserved slug creation rejected; batch endpoint; `close()` closes the database and tolerates one that is already closed or still starting up; the data layer: `file:` URLs for absolute (Windows drive letter) and relative `DB_PATH`, the URL variables' priority, opening a v2 database written by node:sqlite (data still in its WAL) without loss, deleting a link's clicks with foreign keys off, migrations twice in a row being a no-op and two instances migrating at once, requests waiting for `ready`, and 503 when the database can't be opened; Vercel: `server.js` exports the app without listening, `vercel.json`, the Vercel config defaults, 503 `database_not_configured` (JSON and page) and `misconfigured`, Vercel geo headers without `fast-geoip`, and the vendor build copying every referenced `/vendor/` file; the remote path over HTTP against a local Hrana server (`test/hrana-shim.js`, backed by `node:sqlite`): the auth token, create, visit (two round trips), the race for the last click, stats, the live stream and a duplicate slug, then 503 `unavailable` while the server answers 502 or stops answering (bounded by the query timeout), a slow analytics write held to its budget, the start-up deadline, and a warm start that only reads; 503 for database failures after start-up (server error, `fetch failed`) while other errors stay 500; a link deleted mid-visit answering 404; stale live streams of the same client ended to make room, never another client's; and `throughClickId` in the stats.
Design audit: `test/design-audit.test.js` runs `node scripts/audit-design.mjs --json` and requires 0 findings, so `npm test` fails on any DESIGN.md violation the audit can see; it also unit-tests the audit's CSS block rules (`cssBlockFindings()`, exported by the script), including `opacity-fade` (a selector naming a disabled or inactive state whose block sets `opacity` below 1).
Redesign contract: the current teaser theme and QR preset ids; legacy ids accepted on create and PATCH and stored under the new names; legacy values in storage served under the new ids (API and teaser view); the version-2 migration (rewrites, leaves `updated_at` alone, idempotent); `/vendor/fonts/bangers/` and `/vendor/fonts/comic-neue/` serve their CSS and font files while the lucide, Inter and Space Grotesk routes answer 404; API error messages, trivia facts, domain idea notes and every rendered view are free of em dashes and emoji; rendered views only reference local assets that exist.
