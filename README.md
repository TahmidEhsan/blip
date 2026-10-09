# Blip

**Tiny links with big personality.**

Blip is a self-hosted URL shortener with a comic-book look. On top of the usual "long link in, short link out", every link can have a memorable word slug, a quirky vanity domain, a teaser page before the redirect, a live analytics dashboard with a world map, a self-destruct timer, and a styled QR code.

It's a single Node.js app: Express 5, SQLite through libSQL (a local file by default, or a hosted Turso database), and a vanilla HTML/CSS/JS frontend with no build step. It runs on your machine with no account, or on Vercel with a Turso database (see [Deploy to Vercel](#deploy-to-vercel)).

---

## The look

Blip is drawn like a page from a comic book. Every screen sits on newsprint paper with slowly drifting halftone dots, and every panel, field and button has a thick ink outline and square corners. Section kickers, notices and tags are yellow narration caption boxes ("Meanwhile, in your links..."). Colour is flat print colour: red for the one main action on each screen, blue for links and live data, yellow for captions and selected options, and green for success.

- **Type:** headings, buttons and big numbers are lettered in **Bangers**; everything else is set in **Comic Neue**. Both are served from `node_modules`, so no font CDN is involved. URLs and slugs use the system monospace font.
- **Icons:** Phosphor "bold" icons, bundled into one SVG sprite at `public/assets/icons.svg`.
- **Sound effects:** a few moments get a jagged comic burst: **BLIP!** when a link is created, **KA-BOOM!** on a self-destructed link and **WHOOPS!** on the 404 page.
- **Loading:** every view that fetches data shows halftone skeleton placeholders shaped like the final layout, then either the data, an empty state with one line of guidance, or an error with a Retry button.
- **Motion:** only the background drift, skeletons, live indicators, the teaser countdown and the sound-effect bursts move. The main action button is the only control with a hover animation, and everything stops when your system asks for reduced motion.

The full rule set (colour tokens, components, layout, motion and copy) lives in [DESIGN.md](DESIGN.md). It rules out gradients, shadows, translucent "glass" panels, rounded widgets, emoji, em dashes, coloured accent stripes, three-across card grids, disabled or unselected controls faded with opacity and decorative fake content. `npm run audit:design` checks the shipped UI against those rules and must report 0 findings, and `npm test` runs the same check.

---

## The six features

### 1. Custom and word-based slugs
Type any phrase and Blip turns it into a clean slug: `Summer Sale 2026!` → `/summer-sale-2026`, `Café_Menu` → `/cafe-menu`. Accents are stripped, spaces and punctuation become dashes, and `&` becomes `and`. Slugs are lowercase, 1 to 64 characters, and case-insensitive when visited.

- If you leave the slug empty you get a memorable **word slug** like `brave-otter`, built from about 190 family-friendly adjectives and 190 nouns. You can ask for a random 7-character slug (`slugStyle: "random"`) instead. Random slugs skip look-alike characters such as `l`, `1`, `0` and `o`.
- **Suggest from phrase** offers options that are valid, free and unique, e.g. `summer-sale-2026`, `glowing-summer-sale`, `summer-sale-go` or `summer-sale-hq`.
- Availability is checked live, and the check tells you why a slug fails: `empty`, `invalid`, `reserved` or `taken`. App routes such as `api`, `dashboard` and `qr` are reserved.

### 2. Playful vanity domains
Each link can be branded with a short domain such as `cat.ly`, `go.to` or `p.wrk` (configurable). A link always has two URLs:

- `shortUrl` is the branded URL, e.g. `https://cat.ly/meow`.
- `workingUrl` is the URL that works right now on this server, e.g. `http://localhost:3030/meow`.

Until a vanity domain's DNS points at your server, the UI labels it a "vanity preview" and QR codes encode the working URL. See [Making a vanity domain live](#making-a-vanity-domain-live).

The **domain idea generator** runs entirely offline. It suggests domain hacks (`delicious` → `delicio.us`, `catly` → `cat.ly`), short names (`summer.ly`, or the vowel-free `smmr.ly`) and playful ones (`gosummer.to`, `summer.link`, `heysummer.co`). It only uses real short TLDs. Blip can't buy domains, so each idea links to an ICANN lookup where you can check availability.

### 3. Landing-page teasers
A link can show a full-screen teaser page before forwarding the visitor. The page shows a 3 to 15 second countdown inside a comic burst, the destination host ("Taking you to **example.com**"), and **Go now** and **Cancel** buttons. Five flat colour themes are available: **hero** (red), **caption** (yellow), **noir** (ink), **sky** (blue) and **paper** (newsprint). Each link picks one of three teaser styles:

- **Countdown**: just the countdown.
- **Trivia**: a short, true fun fact, chosen from about 80.
- **Brand message**: your own message of up to 280 characters.

Without JavaScript, a `<noscript>` meta refresh still forwards the visitor.

### 4. Live click analytics and maps
Every link gets a live dashboard (`/dashboard.html#<slug>`). It shows:

- one strip of key numbers: clicks, unique visitors, the last 24 hours and the link's remaining lifetime, plus bots and blocked attempts
- clicks over time, bucketed by hour, day, week or month in *your* time zone. **All time** covers every click since the link was made: by day for its first year, then by week (starting Monday), and by calendar month once it is past 520 weeks (about ten years)
- a world map shaded by clicks, with city markers and a "hit" marker for each live click
- horizontal bar breakdowns of devices, browsers, operating systems, referrers and countries
- a live feed of visits

Updates are pushed over Server-Sent Events: a new click shows up on the dashboard while the visitor is being redirected (on Vercel, within about two seconds).

Bots are detected and counted separately. If you want to see the dashboard in action, **Simulate traffic** inserts realistic demo clicks from about 47 real cities. Simulated clicks are clearly labelled as demo data and can be cleared with one click.

### 5. Self-destructing links
A link can expire after a number of clicks, at a set time, or both, whichever comes first. Presets include "burn after reading" (1 click), 10 clicks, 1 hour, 24 hours and 7 days. You can also hit **Destroy now** to end a link immediately.

A stopped link can always come back. **Bring back** opens its self-destruct settings and says why it stopped: set a new time (or Never) for a link whose timer ran out, raise or remove the click limit for one that used up its clicks, or undo a Destroy now (that switch is already on when Bring back opens, so saving is all it takes).

A dead link answers **410** with a "KA-BOOM!" self-destructed page whose wording matches the reason: clicks, time or manual.

Click consumption is a single atomic SQL `UPDATE`, so two visitors racing for the last click can't both get through. Link-preview bots (Slack, WhatsApp, Discord and friends) get a neutral preview page that never reveals the destination. They never use up a limited link.

### 6. Interactive QR codes
Each link has a QR studio (`/qr.html#<slug>`). It offers:

- seven flat presets: ink, hero, caption, sky, pop, press and noir
- dot and corner styles, colours, an optional two-tone dot fill and a transparent background
- centre logos, or your own uploaded logo, which stays in your browser
- a margin control and a caption

You can download a 1024 px PNG or an SVG, copy the image, save the style to the link, or hit **Surprise me** for a random style. A contrast check warns you when a style might not scan.

### Change any setting later

Everything you picked when creating a link stays editable. **Edit settings** opens one dialog with four sections:

- **General:** the title and the destination URL.
- **Domain:** the base host or any of the vanity domains. The slug stays the same.
- **Teaser:** on or off, the style, the countdown seconds, the brand message and the theme.
- **Self-destruct:** the time limit (a preset, a custom date and time, or Never) and the click limit, shown next to the clicks already used. For a destroyed link it also has an **Undo Destroy now** switch.

The dialog is on the result panel, on every row of My links, on the live dashboard and in the QR studio. Only the fields you change are saved, so editing a title never restarts a self-destruct timer. Problems are explained right next to the field that caused them. Open dashboards pick up a status change (stopped or brought back) at once.

---

## Quick start

Requires **Node.js 22.13 or newer** (`engines` in `package.json` says the same). The repo's `.nvmrc` asks for Node 22, so `nvm use` picks a suitable version. Local development needs no database server and no account.

```bash
npm install
npm run dev        # → http://localhost:3030 (restarts on file changes)
```

`npm start` runs the server without the file watcher. The SQLite database is created at `./data/blip.db` on first run (see [Where the data lives](#where-the-data-lives) to use Turso instead). The fonts, charts, map data and QR engine are served from `node_modules` and the icons from the bundled sprite, so Blip works offline and needs no CDN.

| Script | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run the server and restart it when files change |
| `npm test` | Run every test suite, including the design audit (it fails on any finding) |
| `npm run audit:design` | Check the UI, server copy and this README against the rules in [DESIGN.md](DESIGN.md). Prints each finding with its file and line, and exits with an error until there are 0 findings |
| `npm run build` | Copy the `/vendor` files the pages load (fonts, charts, map data, QR engine) from `node_modules` into `public/vendor`. Vercel runs it on every deploy; local runs don't need it |
| `npm run icons` | Rebuild `public/assets/icons.svg` from `@phosphor-icons/core`. Icon ids and the Phosphor glyph behind each one are listed in `scripts/build-icons.mjs` |

### A 60-second tour

1. Open **http://localhost:3030** and paste a long URL (the `https://` is added for you).
2. Tap any of the six feature buttons under the box to open its options: **Custom slug**, **Playful domain**, **Teaser page**, **Self-destruct**, **Live analytics** and **QR studio**. Every feature you switch on shows up as a chip under the URL box; click a chip to reopen its panel.
3. Press **Shorten** (or Enter). The result panel shows the branded short link, a "works right now" link for vanity domains, a styled QR code (click it to download a PNG) and buttons for copy, open, share, the QR studio, the live dashboard, **Edit settings** and **Destroy now**.
4. Open the **Live dashboard** and press **Simulate traffic** to watch clicks land on the world map in real time.
5. Every link you create is listed under **My links** on the home page, with status, clicks, an expiry countdown and actions to open its dashboard or QR studio, edit its settings, destroy it or delete it.
6. Changed your mind? Press **Edit settings** to switch on a teaser, swap the domain, point the link somewhere else or change its self-destruct limits.
7. Try a "burn after reading" link: open it once and it self-destructs. Press **Bring back**, raise or remove the click limit, and save: the link works again.

| Page | URL |
|---|---|
| Home (create links, My links) | `/` |
| Live analytics for one link | `/dashboard.html#<slug>` |
| QR studio for one link | `/qr.html#<slug>` |
| A short link | `/<slug>` (302 redirect, teaser page, self-destructed page or friendly 404) |

Manage tokens live only in your browser. Creating a link returns a secret manage token, and Blip stores only its SHA-256 hash. The home page keeps your tokens in `localStorage` (key `blip.links.v1`), which is how "My links", the dashboard and the QR studio know which links are yours. Clearing your browser data means losing the ability to manage those links. The links themselves keep working.

### Upgrading from the first release

The first release used gradient theme names. The comic redesign renamed them, and Blip handles the switch on its own:

- Teaser themes: `aurora` became `hero`, `sunset` became `caption`, `ocean` became `sky`, `neon` became `noir` and `candy` became `paper`.
- QR presets: `aurora` became `hero`, `sunset` became `pop`, `ocean` became `sky`, `neon` became `noir`, `mono` became `ink`, `candy` became `caption` and `forest` became `press`.

On first start, a one-time database migration (schema version 2) rewrites stored theme ids, and QR styles saved under an old preset get the new preset's flat look (their caption and any logo you picked stay). The API still accepts the old ids and saves them under the new names, so older clients and saved browser state keep working.

### Upgrading from the node:sqlite builds

Earlier builds opened the database with Node's built-in `node:sqlite`. Blip now talks to it through libSQL (`@libsql/client`), which reads the very same SQLite file, so an existing `./data/blip.db` (the default `DB_PATH`) keeps all its links, clicks and the visitor-hash salt. The first start records the schema version in the `meta` table (the old builds kept it in `PRAGMA user_version`, which is read once and left alone). If you copy the database somewhere while a server is still running, copy `blip.db-wal` and `blip.db-shm` along with `blip.db`: recent writes can still be in the `-wal` file.

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3030` | Listen port |
| `HOST` | `127.0.0.1` | Listen address (`0.0.0.0` to accept outside connections) |
| `BASE_URL` | `http://localhost:${PORT}` (on Vercel, the deployment's public URL) | The public URL that actually serves links today (no trailing slash) |
| `DOMAINS` | `blip.to,cat.ly,go.to,p.wrk` | Vanity domains offered in the UI (comma-separated) |
| `LIVE_DOMAINS` | *(empty)* | The subset of `DOMAINS` whose DNS really points at this server |
| `TURSO_DATABASE_URL` | *(empty)* | A hosted libSQL database such as Turso (`libsql://...`). When set, it is used instead of `DB_PATH` |
| `TURSO_AUTH_TOKEN` | *(empty)* | The token for `TURSO_DATABASE_URL` |
| `DATABASE_URL`, `DATABASE_AUTH_TOKEN` | *(empty)* | Used when `TURSO_DATABASE_URL` is unset. Must be a libSQL URL (`libsql:`, `https:`, `wss:` or `file:`); any other kind, such as `postgres:`, stops Blip with an error |
| `LIBSQL_URL`, `LIBSQL_AUTH_TOKEN` | *(empty)* | Third choice, same rules |
| `DB_PATH` | `./data/blip.db` | Local SQLite file used when none of the URLs above is set (relative to the project root), or `:memory:`. Not used on Vercel |
| `IP_HASH_SALT` | *(auto)* | Salt for visitor hashes; if unset, 32 random bytes are generated once and stored in the database |
| `ALLOW_DEMO_TRAFFIC` | `true` unless `NODE_ENV=production` (always `true` on Vercel) | Enables the "Simulate traffic" endpoints. Set it to `false` to turn them off |
| `TRUST_PROXY` | `false` (`1` on Vercel) | Express `trust proxy` setting. Behind a reverse proxy or CDN, set it to the number of proxies in front of Blip (`1` for a single one) or to the proxy's address/subnet (`loopback`, or a list such as `10.0.0.0/8`) so client IPs and rate limits are correct. **Avoid `true`**: it trusts the client-supplied left-most `X-Forwarded-For` entry, which lets anyone bypass the per-IP rate limits and fake visitor counts (Blip logs a warning at startup) |
| `STREAM_POLL_MS` | `2000` | How often an open live dashboard checks the database for new clicks and status changes (50 to 60000 ms) |
| `STREAM_MAX_MS` | `0` (never; `250000` on Vercel) | End each live stream after this many ms; the dashboard reconnects on its own. On Vercel it keeps streams inside the function time limit |
| `NODE_ENV` | `development` | `production` caches view templates and vendor files and disables demo traffic by default (except on Vercel) |
| `VERCEL` | *(set by Vercel)* | Switches on the Vercel defaults described in [Deploy to Vercel](#deploy-to-vercel) |

Example:

```bash
PORT=8080 BASE_URL=https://blip.example.com DOMAINS=cat.ly,go.to LIVE_DOMAINS=cat.ly TRUST_PROXY=1 npm start
```

## Where the data lives

- **On your machine (the default):** a SQLite file at `DB_PATH`, `./data/blip.db` unless you change it. The folder and file are created on first run, and nothing else needs installing. Absolute and relative paths both work, Windows drive letters included.
- **On Turso:** create a database (on Vercel, add Turso from the Marketplace, which sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` for you) and Blip uses it instead of the file. It creates its tables on the first request, and every start-up step is safe to repeat and safe when several server instances start at once.
- **On Vercel without a database:** there is no file to fall back to, so Blip keeps serving its pages and answers every `/api` request with `503 database_not_configured` until Turso is connected (see [Deploy to Vercel](#deploy-to-vercel)).

Blip picks the first of `TURSO_DATABASE_URL`, `DATABASE_URL` and `LIBSQL_URL` that is set, each with its own token variable, and falls back to `DB_PATH`. The startup log names the database without its token or password. If the database can't be reached, `npm start` stops with a message saying so; a server that is already running answers `503` and tries again on the next request. A request to a database server that gets no answer within 8 seconds is given up, so a stalled database means a quick `503` (for a visitor, the "can't reach its database" page) rather than a request that hangs.

## Deploy to Vercel

Blip runs on Vercel as one Express function on Fluid compute, with its data in Turso and its pages, scripts, fonts and vendor files on Vercel's CDN. The repo carries everything Vercel needs: `server.js` (the entry Vercel detects; it exports the app and never listens), `vercel.json` (the Express preset, `npm run build` as the build command, Fluid compute with request cancellation and a 300 s limit for the function, and the same security headers the app sends) and `scripts/build-vendor.mjs`.

1. **Import the repo** into a Vercel project. `vercel.json` picks the Express preset, so a project created with the "Other" preset needs no settings changes. Node 22 or newer works; with `engines` at `>=22.13` Vercel builds on its newest Node (24 today).
2. **Add Turso from the Vercel Marketplace** (the project's **Storage** tab), create a database and connect it to this project for **Production** only. That sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Leave the environment variable prefix empty: Blip reads exactly those two names. Create the database in the region closest to the function's region (`aws-us-east-1` for Vercel's default, `iad1`; the project's **Settings > Functions** shows it): a visit makes two round trips to the database before its redirect, so a database on another continent adds a few hundred milliseconds to every click.
3. **Give previews their own database.** Create a second Turso database and connect it for **Preview** (and Development, if you use `vercel env pull`). Blip updates its tables on the first request a new deployment gets, so with one shared database a preview of a branch that changes the schema would change the production data before the branch is merged, and whatever you try on a preview (simulated traffic, deleting links) would land on real links.
4. **Redeploy.** Environment variables only reach deployments made after they were added. Blip creates its tables on the first request.
5. **Check it:** `/api/health` answers `{ "ok": true }`. Then create a link, open it, and open its live dashboard.

**Custom domains.** In production `BASE_URL` follows `VERCEL_PROJECT_PRODUCTION_URL`, which Vercel sets to the project's *shortest* production domain. As soon as you add a custom domain, set `BASE_URL` for Production (for example `https://blip.example.com`) and redeploy, so that adding a short vanity domain later can't change the domain every new link gets (see [Making a vanity domain live](#making-a-vanity-domain-live)). Blip recognises Vercel by its `VERCEL` variable, which Vercel only sets while **Automatically expose System Environment Variables** (Settings > Environment Variables) is on. It is on by default, and Blip logs a warning when the variable is missing.

Until the database is connected, the deployment still serves its pages, every `/api` request answers `503` with `{ "error": { "code": "database_not_configured" } }` (the home page shows its message), short links show a short "not connected yet" page, and the function logs one line saying what is missing. A database URL Blip can't use (such as a `postgres://` `DATABASE_URL` from another integration, or a `file:` URL, which a deployed function can't open) is skipped the same way instead of crashing the function, and an invalid setting such as a malformed `BASE_URL` answers `503 misconfigured`.

**What changes on Vercel** (any variable you set yourself still wins):

| Setting | On Vercel |
|---|---|
| `BASE_URL` | Optional at first. Production uses the project's shortest production domain (`VERCEL_PROJECT_PRODUCTION_URL`); previews use their branch URL (`VERCEL_BRANCH_URL`, else `VERCEL_URL`). Set it for Production once the project has a custom domain, or when links should carry another domain |
| `TRUST_PROXY` | `1`: Vercel's edge is the one proxy in front of the function, so visitor counts and rate limits use the client address it forwards |
| `ALLOW_DEMO_TRAFFIC` | `true`, so **Simulate traffic** can fill the map for a demo. To turn it off, add `ALLOW_DEMO_TRAFFIC=false` in the project's environment variables and redeploy |
| `STREAM_MAX_MS` | `250000`: a live stream ends after about four minutes, before Vercel's 300 s function limit cuts it, and the dashboard reconnects |
| `DB_PATH` | Not used: the filesystem is read-only, and every instance would have its own copy |
| Location | Read only from Vercel's `x-vercel-ip-*` headers (another CDN's header could only come from the visitor). The offline `fast-geoip` database is never loaded or bundled |

**What is per instance.** Vercel can run several instances of the function at once, each with its own memory:

- Rate limits (20 links created, 30 simulations and 120 lookups per client per minute) and the live-stream caps (10 per link, 20 per client) are counted per instance, so the effective ceiling can be a few times higher.
- `vercel.json` switches on request cancellation for the function, so closing or reloading a dashboard ends its stream at once, as it does locally. If a disconnect is ever missed, a client at its cap that opens another dashboard ends its own oldest stream (one at least 30 seconds old) instead of being refused.
- Live dashboards work across instances. Every open stream asks the database for new clicks and status changes every 2 seconds (`STREAM_POLL_MS`), so a visit handled by any instance shows up within about 2 seconds, and at once when it lands on the dashboard's own instance. Simulated traffic is stored in one go and played back on the dashboard about 120 ms apart. A stream ends after `STREAM_MAX_MS` and the dashboard reconnects on its own, so the Live caption says "Reconnecting" for a second or two every few minutes.

**Static and vendor files.** Vercel's CDN serves `public/` itself, and `express.static` never runs there. `npm run build` copies every `/vendor/...` file the pages load into `public/vendor/` at the same URL: it scans the pages, views, styles and scripts for `/vendor/` references, follows the font stylesheets to their font files, and fails the build when a reference has no source. `public/vendor/` and `.vercel/` are gitignored. `/dashboard` and `/qr` are rewritten to their `.html` pages, as the local server does.

**Function settings.** `vercel.json` sets `maxDuration` (300 s) and `supportsCancellation` under the key `{index,server}.js`. Vercel's Express preset builds the app under the name `index.js`, whatever the entry file is called, and only applies `functions` settings whose key matches that name (a plain `server.js` key is accepted but ignored), so the pattern names both.

**Trying it locally.** `npx vercel build` writes the output Vercel would deploy to `.vercel/output` (one function of about 3 MB, plus the static files), and `npx vercel dev` runs it. `vercel dev` does not set `VERCEL`, so Blip behaves like a local run there (and logs a warning saying so): set `TURSO_DATABASE_URL` (a `file:` URL works) or `DB_PATH` in the shell to pick the database, and add `VERCEL=1` to try the Vercel defaults (those need a `libsql://` or `https://` database, as a deployment does).

## Making a vanity domain live

On your own server:

1. **Buy the domain** from any registrar.
2. **Point its DNS at your Blip server.** Use an `A`/`AAAA` record to the server's IP, or a `CNAME` to its hostname.
3. **Terminate TLS** in front of Blip with a reverse proxy such as Caddy, nginx or a CDN, so `https://cat.ly/<slug>` reaches the Node process. Blip answers on any `Host`, so no extra routing is needed.
4. **List it in both variables:** `DOMAINS=cat.ly,...` and `LIVE_DOMAINS=cat.ly`. Set `TRUST_PROXY` to the number of proxies in front of Blip (usually `1`).
5. Restart Blip.

On Vercel:

1. **Add the domain** under the project's **Settings > Domains** and create the DNS records Vercel shows. Vercel issues the certificate, so no proxy is needed.
2. **Set `BASE_URL` for Production** if you haven't yet (see [Custom domains](#deploy-to-vercel)). Without it, a short vanity domain becomes the project's shortest production domain, and with it the base URL of every new link.
3. **List it in both variables,** `DOMAINS` and `LIVE_DOMAINS`, in the project's environment variables (`TRUST_PROXY` is already right on Vercel), and redeploy.

The domain is then marked **live**: `domainLive` becomes `true`, and QR codes encode the branded `https://cat.ly/<slug>` instead of the working URL.

All domains share one slug namespace, so `/<slug>` resolves the same link on every domain that points at the server.

Links remember the domain they were created on. If that domain stops being served here (you change `PORT` or `BASE_URL`, or remove a vanity domain from `DOMAINS`), the link isn't broken: the API reports it under the current base host, with a working `shortUrl`, until you pick another domain for it.

## Architecture

```
DESIGN.md           visual and copy rules for the comic redesign (overrides SPEC.md on anything visual)
SPEC.md             functional contract: config, database, API, views, behaviours
server.js           Vercel entry: imports express (how Vercel detects the app) and exports the app; never listens
vercel.json         Vercel settings: Express preset, npm run build, rewrites for /dashboard and /qr, security headers
server/
  index.js          local entry: loadConfig() → createApp() → await ready → listen; graceful SIGINT/SIGTERM shutdown
  vercel.js         createVercelApp(env): the app for a Vercel function (never throws, never listens)
  app.js            createApp({ config, now, random, geoLookup, rateLimits, streamLimits, unavailable }) → { app, db, ready, close, endStreams }
                    security headers (strict CSP), /vendor/* from node_modules, static files, wait for the database
                    (or 503 when there is none), /api, /:slug, errors
  vendor.js         the /vendor URLs and the node_modules files behind them (read by app.js and the vendor build)
  config.js         env parsing + normalisation (database URL: Turso or other libSQL URL, else DB_PATH as a file: URL; Vercel defaults)
  db.js             @libsql/client wrapper (execute/all/get/run/batch), migrations, async query helpers (consumeVisitAndRecordClick, insertClick),
                    an 8 s limit on every round trip to a server, isDatabaseUnavailable (which failures become a 503)
                    servers through @libsql/client/web (plain JavaScript); the native driver loads only for local files
  themes.js         teaser theme and QR preset ids, and the first-release ids they replaced
  slugs.js words.js slug normalisation/validation, word & random slugs, suggestions
  urls.js           destination URL validation (http/https only, no credentials, no redirect loops)
  domains.js        domain options + offline domain-idea generator
  links.js          link status, LinkDTO mapping, create/update validation
  qrstyle.js        qrStyle whitelist validation
  analytics.js      UA parsing, bot detection, visitor hashing, ClickEvent + StatsDTO builder
  geo.js            CDN country headers → optional offline fast-geoip (150 ms cap, private IPs skipped; on Vercel only x-vercel-ip-*)
  simulate.js       synthetic demo clicks (data/cities.js), stored in one batch
  live.js           live dashboard streams: SSE fed by polling the database, so every instance's clicks reach every dashboard
  bus.js            in-process wake-ups (link:<id>): streams on the same instance poll at once instead of at their next tick
  render.js         escaping-only HTML templates ({{text:}}, {{attr:}}, {{json:}})
  ratelimit.js      in-memory fixed-window limiter
  routes/api.js     JSON API under /api
  routes/redirect.js  GET /:slug: redirect, teaser, bot preview, expired, 404
  views/*.html      teaser, expired, not-found, preview and unavailable (503) pages
  data/trivia.js    fun facts for trivia teasers
public/             index.html (home), dashboard.html, qr.html + assets (vanilla ES modules)
  assets/js/edit-settings.js  shared Edit settings dialog and Bring back flow (styles in assets/css/edit-settings.css)
  assets/css/theme.css  shared design system: tokens, panels, captions, buttons, forms, skeletons, bursts
  assets/icons.svg      Phosphor icon sprite (generated by scripts/build-icons.mjs)
scripts/
  audit-design.mjs  design-rule checker (npm run audit:design)
  build-icons.mjs   icon sprite builder (npm run icons)
  build-vendor.mjs  copies the /vendor files the pages use into public/vendor for Vercel (npm run build)
test/               node:test suites (HTTP tests run against app.listen(0) with an injected clock)
```

**Vendor routes** (served straight from `node_modules`, because the CSP only allows `'self'`): `/vendor/fonts/bangers/` and `/vendor/fonts/comic-neue/` (Fontsource packages; pages load `latin-400.css`, plus `latin-700.css` for Comic Neue), `/vendor/d3.min.js`, `/vendor/topojson-client.min.js`, `/vendor/countries-110m.json` and `/vendor/qr-code-styling.js`. They come before the static site, so a local run serves the installed versions even after a build. On Vercel the same URLs are the static copies `npm run build` makes in `public/vendor/`.

**What happens on a visit (`GET /:slug`):**

1. Look up the link. An unknown slug gets a 404 page.
2. If the link is expired or destroyed, log a "blocked" attempt and answer 410.
3. A link-preview bot on a limited link gets the preview page (200), and nothing is consumed.
4. Otherwise, consume one click atomically and store the click in the same write: device/browser/OS, referrer host, coarse location and visitor hash. If the link was deleted a moment earlier (on any instance), the visitor gets the 404 page.
5. Wake the live dashboards open on this server instance. Every dashboard reads the click (and any status change) from the database: at once on this instance, at its next poll (every 2 seconds) on any other.
6. Answer with a 302 redirect or the teaser page.

`HEAD` requests get the same status codes but are never recorded or counted. Because they never use up a click, a `HEAD` to a click-limited link answers `302` without a `Location` header, so it can't be used to peek at a "burn after reading" destination.

A visit makes at most two database round trips: the lookup, then one write batch that consumes the click and stores its row together, so a visit is never counted without its row, even when the request is cancelled halfway. Recording a visit that consumes nothing (a blocked attempt or a bot) can never break it: if that write fails (for example the link is deleted while its location is being looked up), the error is logged and the visitor still gets their page, and a write that takes longer than 1.5 seconds is left to finish on its own. Live dashboards never rescan a link's history on a visit either: each stream counts its totals once when it connects, together with the newest click id it covers, then adds the clicks it reads after that id, in id order. A poll reads only the rows stored since the previous one (from every link) plus the link itself, in one round trip. When simulated clicks are cleared, a counter in the `meta` table moves and every open stream recounts once, so the totals stay exact. The stats endpoint reads everything it needs in one batch, so a hosted database answers it in one round trip. It also returns the newest click id it covered, so the dashboard never counts a live click twice when the click reaches its stream after a refresh already included it.

**API:** see `SPEC.md` §5 for the full contract. In short:

- `POST /api/links` creates a link and returns `{ link, manageToken }`.
- Management endpoints (`GET/PATCH/DELETE /api/links/:slug`, `/destroy`, `/revive`, `/stats`, `/stream`, `/simulate`, `/simulated`) need the `X-Manage-Token` header.
- `POST /api/links/batch` refreshes many links at once.
- `GET /api/slugs/check`, `/api/slugs/suggest` and `/api/domains/ideas` power the creation form.
- Errors always look like `{ "error": { "code", "message", "field?" } }`. Messages are written to be shown in the UI as they are.

**Security:**

- Every response sends a strict Content-Security-Policy (`script-src 'self'`, with no inline scripts or event handlers anywhere), plus `X-Frame-Options: DENY`, `nosniff`, a referrer policy and a permissions policy.
- Only `http:`/`https:` destinations are accepted. Destinations that point back at Blip itself are rejected as redirect loops: the base host, every configured domain, and loopback or listen addresses on Blip's own port (`127.0.0.1`, `[::1]`, `*.localhost`, the `HOST` address or, when listening on `0.0.0.0`, any local interface address).
- Manage tokens are compared in constant time.
- Link creation, simulated traffic and lookups are rate-limited per client IP (20, 30 and 120 per minute). IPv6 clients are grouped by their /64 prefix, and each limiter tracks at most 50,000 clients at a time. Behind a proxy, set `TRUST_PROXY` to a hop count rather than `true` (see [Configuration](#configuration)).
- Live dashboard streams are capped at 10 per link and 20 per client at once (per server instance). A client at its cap ends its own oldest stream (one at least 30 seconds old) to make room, so dashboards whose disconnect went unnoticed never lock it out, and it can never end another client's streams. Otherwise extra connections get `429` with `Retry-After`, and the dashboard reconnects on its own.

## Privacy

- **No raw IP addresses are ever stored or logged.** A visit stores only a visitor hash: the first 24 hex characters of `sha256(salt + ip + user-agent)`. The salt is secret and per-installation. This is enough to count unique visitors without being able to recover who they were.
- **Location is coarse.** It comes from CDN country headers when present (Cloudflare, Vercel, CloudFront), otherwise from the offline `fast-geoip` database. On Vercel only Vercel's own headers count, and `fast-geoip` is never used. No third-party service is ever called. Coordinates are rounded to 1 decimal place (roughly 10 km). Loopback, private, CGNAT and link-local addresses are never looked up.
- **Referrers are reduced to a hostname,** e.g. `twitter.com`. Full referrer URLs are never stored.
- **Rate limiting** keeps client IPs in memory only, for at most one minute.
- **Manage tokens** are stored as SHA-256 hashes, and only your browser holds the real token.

> Country headers are only trustworthy behind the CDN that sets them. If Blip is exposed directly to the internet, a visitor could spoof them. That would only affect your own analytics.

## Testing

```bash
npm test
```

The suites use the built-in `node:test` runner and `assert/strict`, with no extra dependencies. HTTP tests start an isolated app on an ephemeral port with an in-memory database and a mutable injected clock, so expiry and time-bucket tests are instant and deterministic. They cover:

- slug rules and suggestions, URL validation and domain ideas
- the template escaping, including XSS attempts
- create/update/delete validation, token auth (401/403/404) and the batch endpoint
- the comic theme and preset ids, the old ids still accepted on input, and the one-time migration of stored ids
- 302/410/404 responses, teaser pages, bot previews and `HEAD` handling (including that `HEAD` never reveals a click-limited target)
- expiry by time and by clicks, 30 concurrent visitors racing for 3 clicks, destroy/revive, and limits changed by `PATCH` (with the matching live `status` events)
- analytics failures (a throwing geo provider, a link deleted while a blocked attempt is recorded) never breaking the visit, and a link deleted mid-visit answering 404 instead of "self-destructed"
- database failures after start-up (a server error, a network failure) answering `503` with the "can't reach its database" page or JSON, while any other error stays a `500`
- stats totals (including the bot and blocked overlap behind the "Bots & blocked" count), buckets (including time zones) and top-8 + "Other" breakdowns, simulated traffic (stored before the response, played back about 120 ms apart), the SSE stream, its running totals (including after simulated clicks are cleared), the status events for every click-count change, and its per-link/per-client connection caps (and a client's own stale streams making room, never another client's)
- **All time** stats over long spans: clicks years apart all count, and the chart switches to weeks (starting Monday) after a year and to calendar months after 520 weeks, aligned to time zones east and west of UTC
- redirect-loop protection (base host, vanity domains, loopback and listen addresses on Blip's port)
- the data layer: `DB_PATH` as an absolute (Windows drive letter) or relative path, the priority of the database URL variables, reopening a file database, opening a database written by the `node:sqlite` build with its data still in the `-wal` file, deleting a link's clicks with foreign keys switched off, migrations that change nothing the second time and that two instances can run at once, requests waiting for a database that is still starting, and `503` for one that can't be opened
- links surviving a `PORT`/`BASE_URL` change
- rate limiting (per-route budgets, `TRUST_PROXY` hop counts, IPv6 /64 grouping, the client cap) and security headers
- the Bangers and Comic Neue font routes, and that the first release's icon library and font routes now answer 404
- copy rules: API error messages, trivia facts, domain idea notes and every rendered view are free of em dashes and emoji, and the views only load assets that exist
- the design audit: `test/design-audit.test.js` runs `scripts/audit-design.mjs` and requires 0 findings, and unit-tests its CSS rules (such as disabled or unselected controls faded with opacity)
- shutdown: closing the app closes the database, even if it was already closed or is still starting up
- live streams across instances: two apps sharing one database file, where a visit, simulated clicks, a cleared simulation, a limit change and a deletion handled by one reach the other's dashboard by polling alone, and a stream that ends cleanly after `STREAM_MAX_MS`
- a remote database over HTTP: a small Hrana server in `test/hrana-shim.js` (backed by `node:sqlite`) stands in for Turso, so create, visit (two round trips), the race for the last click, stats, the live stream and duplicate slugs run through the same HTTP client as production; then `503` while it answers errors or stops answering, a slow analytics write held to its budget, the start-up deadline, and a warm start that only reads
- Vercel: `server.js` imports express, exports the app and never listens; `vercel.json` (Fluid compute, request cancellation, the 300 s limit) and its security headers; the Vercel defaults (base URL per environment, `TRUST_PROXY=1`, demo traffic, stream time limit, no file fallback); `503 database_not_configured` JSON and the "not connected yet" page without a database, `503 misconfigured` for an invalid setting, a `file:` URL refused, and a full create, visit and stats round trip against the HTTP stand-in with its token; Vercel's geo headers, with other CDNs' headers ignored and `fast-geoip` never imported
- the vendor build: every `/vendor/` URL the pages use is copied byte for byte, with the font files behind each font stylesheet, and an unknown one fails the build

`npm test` runs `node --test "test/*.test.js"`, so each suite gets its own process (`test/helpers.js` is shared setup, not a suite). Run a single suite with, for example, `node --test test/redirect.test.js`.
