# Blip

**Tiny links with big personality.**

Blip is a self-hosted URL shortener with a comic-book look. On top of the usual "long link in, short link out", every link can have a memorable word slug, a quirky vanity domain, a teaser page before the redirect, a live analytics dashboard with a world map, a self-destruct timer, and a styled QR code.

It's a single Node.js process: Express 5, the built-in `node:sqlite` database, and a vanilla HTML/CSS/JS frontend with no build step.

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

Updates are pushed over Server-Sent Events: a new click shows up on the dashboard while the visitor is being redirected.

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

Requires **Node.js 22.13 or newer**, the first release with the built-in `node:sqlite` available without a flag (`engines` in `package.json` says the same). The repo's `.nvmrc` asks for Node 22, so `nvm use` picks a suitable version.

```bash
npm install
npm run dev        # → http://localhost:3030 (restarts on file changes)
```

`npm start` runs the server without the file watcher. The SQLite database is created at `./data/blip.db` on first run. The fonts, charts, map data and QR engine are served from `node_modules` and the icons from the bundled sprite, so Blip works offline and needs no CDN.

| Script | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run the server and restart it when files change |
| `npm test` | Run every test suite, including the design audit (it fails on any finding) |
| `npm run audit:design` | Check the UI, server copy and this README against the rules in [DESIGN.md](DESIGN.md). Prints each finding with its file and line, and exits with an error until there are 0 findings |
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

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3030` | Listen port |
| `HOST` | `127.0.0.1` | Listen address (`0.0.0.0` to accept outside connections) |
| `BASE_URL` | `http://localhost:${PORT}` | The public URL that actually serves links today (no trailing slash) |
| `DOMAINS` | `blip.to,cat.ly,go.to,p.wrk` | Vanity domains offered in the UI (comma-separated) |
| `LIVE_DOMAINS` | *(empty)* | The subset of `DOMAINS` whose DNS really points at this server |
| `DB_PATH` | `./data/blip.db` | SQLite file (relative to the project root), or `:memory:` |
| `IP_HASH_SALT` | *(auto)* | Salt for visitor hashes; if unset, 32 random bytes are generated once and stored in the database |
| `ALLOW_DEMO_TRAFFIC` | `true` unless `NODE_ENV=production` | Enables the "Simulate traffic" endpoints |
| `TRUST_PROXY` | `false` | Express `trust proxy` setting. Behind a reverse proxy or CDN, set it to the number of proxies in front of Blip (`1` for a single one) or to the proxy's address/subnet (`loopback`, or a list such as `10.0.0.0/8`) so client IPs and rate limits are correct. **Avoid `true`**: it trusts the client-supplied left-most `X-Forwarded-For` entry, which lets anyone bypass the per-IP rate limits and fake visitor counts (Blip logs a warning at startup) |
| `NODE_ENV` | `development` | `production` caches view templates and vendor files and disables demo traffic by default |

Example:

```bash
PORT=8080 BASE_URL=https://blip.example.com DOMAINS=cat.ly,go.to LIVE_DOMAINS=cat.ly TRUST_PROXY=1 npm start
```

## Making a vanity domain live

1. **Buy the domain** from any registrar.
2. **Point its DNS at your Blip server.** Use an `A`/`AAAA` record to the server's IP, or a `CNAME` to its hostname.
3. **Terminate TLS** in front of Blip with a reverse proxy such as Caddy, nginx or a CDN, so `https://cat.ly/<slug>` reaches the Node process. Blip answers on any `Host`, so no extra routing is needed.
4. **List it in both variables:** `DOMAINS=cat.ly,...` and `LIVE_DOMAINS=cat.ly`. Set `TRUST_PROXY` to the number of proxies in front of Blip (usually `1`).
5. Restart Blip.

The domain is then marked **live**: `domainLive` becomes `true`, and QR codes encode the branded `https://cat.ly/<slug>` instead of the working URL.

All domains share one slug namespace, so `/<slug>` resolves the same link on every domain that points at the server.

Links remember the domain they were created on. If that domain stops being served here (you change `PORT` or `BASE_URL`, or remove a vanity domain from `DOMAINS`), the link isn't broken: the API reports it under the current base host, with a working `shortUrl`, until you pick another domain for it.

## Architecture

```
DESIGN.md           visual and copy rules for the comic redesign (overrides SPEC.md on anything visual)
SPEC.md             functional contract: config, database, API, views, behaviours
server/
  index.js          loadConfig() → createApp() → listen; graceful SIGINT/SIGTERM shutdown
  app.js            createApp({ config, now, random, geoLookup, rateLimits, streamLimits }) → { app, db, close, endStreams }
                    security headers (strict CSP), static files, /vendor/* from node_modules, /api, /:slug, errors
  config.js         env parsing + normalisation
  db.js             node:sqlite DatabaseSync, versioned migrations, query helpers (atomic consumeVisit, insertClick)
  themes.js         teaser theme and QR preset ids, and the first-release ids they replaced
  slugs.js words.js slug normalisation/validation, word & random slugs, suggestions
  urls.js           destination URL validation (http/https only, no credentials, no redirect loops)
  domains.js        domain options + offline domain-idea generator
  links.js          link status, LinkDTO mapping, create/update validation
  qrstyle.js        qrStyle whitelist validation
  analytics.js      UA parsing, bot detection, visitor hashing, ClickEvent + StatsDTO builder
  geo.js            CDN country headers → optional offline fast-geoip (150 ms cap, private IPs skipped)
  simulate.js       synthetic demo clicks (data/cities.js)
  bus.js            in-process EventEmitter for live events (link:<id>)
  render.js         escaping-only HTML templates ({{text:}}, {{attr:}}, {{json:}})
  ratelimit.js      in-memory fixed-window limiter
  routes/api.js     JSON API under /api
  routes/redirect.js  GET /:slug: redirect, teaser, bot preview, expired, 404
  views/*.html      teaser, expired, not-found and preview pages
  data/trivia.js    fun facts for trivia teasers
public/             index.html (home), dashboard.html, qr.html + assets (vanilla ES modules)
  assets/js/edit-settings.js  shared Edit settings dialog and Bring back flow (styles in assets/css/edit-settings.css)
  assets/css/theme.css  shared design system: tokens, panels, captions, buttons, forms, skeletons, bursts
  assets/icons.svg      Phosphor icon sprite (generated by scripts/build-icons.mjs)
scripts/
  audit-design.mjs  design-rule checker (npm run audit:design)
  build-icons.mjs   icon sprite builder (npm run icons)
test/               node:test suites (HTTP tests run against app.listen(0) with an injected clock)
```

**Vendor routes** (served straight from `node_modules`, because the CSP only allows `'self'`): `/vendor/fonts/bangers/` and `/vendor/fonts/comic-neue/` (Fontsource packages; pages load `latin-400.css`, plus `latin-700.css` for Comic Neue), `/vendor/d3.min.js`, `/vendor/topojson-client.min.js`, `/vendor/countries-110m.json` and `/vendor/qr-code-styling.js`.

**What happens on a visit (`GET /:slug`):**

1. Look up the link. An unknown slug gets a 404 page.
2. If the link is expired or destroyed, log a "blocked" attempt and answer 410.
3. A link-preview bot on a limited link gets the preview page (200), and nothing is consumed.
4. Otherwise, consume one click atomically.
5. Record the click: device/browser/OS, referrer host, coarse location and visitor hash.
6. Publish it on the event bus, which fans it out to open dashboards over SSE.
7. Answer with a 302 redirect or the teaser page.

`HEAD` requests get the same status codes but are never recorded or counted. Because they never use up a click, a `HEAD` to a click-limited link answers `302` without a `Location` header, so it can't be used to peek at a "burn after reading" destination.

Recording the visit can never break it: if analytics fails (for example the link is deleted while its location is being looked up), the error is logged and the visitor still gets their redirect. Live totals for dashboards are kept as running counters only while a dashboard is open, so a visit never rescans a link's click history.

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
- Live dashboard streams are capped at 10 per link and 20 per client at once; extra connections get `429` with `Retry-After`, and the dashboard reconnects on its own.

## Privacy

- **No raw IP addresses are ever stored or logged.** A visit stores only a visitor hash: the first 24 hex characters of `sha256(salt + ip + user-agent)`. The salt is secret and per-installation. This is enough to count unique visitors without being able to recover who they were.
- **Location is coarse.** It comes from CDN country headers when present (Cloudflare, Vercel, CloudFront), otherwise from the offline `fast-geoip` database. No third-party service is ever called. Coordinates are rounded to 1 decimal place (roughly 10 km). Loopback, private, CGNAT and link-local addresses are never looked up.
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
- analytics failures (a throwing geo provider, a link deleted mid-visit) never breaking the redirect
- stats totals (including the bot and blocked overlap behind the "Bots & blocked" count), buckets (including time zones) and top-8 + "Other" breakdowns, simulated traffic, the SSE stream, its running totals and its per-link/per-client connection caps
- **All time** stats over long spans: clicks years apart all count, and the chart switches to weeks (starting Monday) after a year and to calendar months after 520 weeks, aligned to time zones east and west of UTC
- redirect-loop protection (base host, vanity domains, loopback and listen addresses on Blip's port)
- reopening a file database, and links surviving a `PORT`/`BASE_URL` change
- rate limiting (per-route budgets, `TRUST_PROXY` hop counts, IPv6 /64 grouping, the client cap) and security headers
- the Bangers and Comic Neue font routes, and that the first release's icon library and font routes now answer 404
- copy rules: API error messages, trivia facts, domain idea notes and every rendered view are free of em dashes and emoji, and the views only load assets that exist
- the design audit: `test/design-audit.test.js` runs `scripts/audit-design.mjs` and requires 0 findings, and unit-tests its CSS rules (such as disabled or unselected controls faded with opacity)
- shutdown: closing the app closes the database, even if it was already closed

`npm test` runs `node --test "test/*.test.js"`, so each suite gets its own process (`test/helpers.js` is shared setup, not a suite). Run a single suite with, for example, `node --test test/redirect.test.js`.
