# Blip

**Tiny links with big personality.**

Blip is a self-hosted URL shortener with a comic-book look. On top of the usual "long link in, short link out", every link can have a memorable word slug, a quirky vanity domain, a teaser page before the redirect, a live analytics dashboard with a world map, a self-destruct timer, and a styled QR code.

It's a single Node.js app: Express 5, MongoDB through the official `mongodb` driver, and a vanilla HTML/CSS/JS frontend with no build step. The data lives in a MongoDB database: a free MongoDB Atlas cluster works, as does MongoDB 6.0 or newer on your own machine. It runs on your machine, or on Vercel with MongoDB Atlas (see [Deploy to Vercel](#deploy-to-vercel)).

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

Using up a click is one atomic MongoDB update that only succeeds while the link still has clicks left, so two visitors racing for the last click can't both get through, even when different server instances handle them. Link-preview bots (Slack, WhatsApp, Discord and friends) get a neutral preview page that never reveals the destination. They never use up a limited link.

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

Requires **Node.js 22.13 or newer** (`engines` in `package.json` says the same) and a **MongoDB database**: a free MongoDB Atlas cluster, or MongoDB 6.0 or newer running on your machine. The repo's `.nvmrc` asks for Node 22, so `nvm use` picks a suitable version.

1. **Get a connection string.** In Atlas, open your cluster's **Connect** dialog, choose **Drivers** and copy the `mongodb+srv://...` string, putting your database user's password where it says `<db_password>` (percent-encode special characters in it: `@` is `%40`, `:` is `%3A`, `/` is `%2F`). Under **Network Access**, add your current IP address. For MongoDB on your own machine the string is `mongodb://127.0.0.1:27017`.
2. **Put it in a file named `.env`** in the project folder (Git ignores it):

   ```bash
   MONGODB_URI=mongodb+srv://blip-dev:your-password@cluster0.example.mongodb.net/?retryWrites=true&w=majority
   ```

3. **Install and run:**

   ```bash
   npm install
   npm run dev        # → http://localhost:3030 (restarts on file changes)
   ```

`npm start` runs the server without the file watcher. A local run uses the database `blip_dev` on that cluster (`MONGODB_DB` picks another), and Blip creates its collections and indexes on the first start. Without `MONGODB_URI`, `npm start` stops with a message saying to put it in `.env`; when the database can't be opened, it says what to check (see [Troubleshooting](#troubleshooting)). Either way it exits with code 1. The fonts, charts, map data and QR engine are served from `node_modules` and the icons from the bundled sprite, so the pages need no CDN.

| Script | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run the server and restart it when files change |
| `npm test` | Run every test suite, including the design audit (it fails on any finding) |
| `npm run audit:design` | Check the UI, server copy and this README against the rules in [DESIGN.md](DESIGN.md). Prints each finding with its file and line, and exits with an error until there are 0 findings |
| `npm run build` | Copy the `/vendor` files the pages load (fonts, charts, map data, QR engine) from `node_modules` into `public/vendor`. The copies are committed, so run it and commit after changing a vendor package; a test fails if they go stale. Local runs don't need it |
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

The API still accepts the old ids and saves them under the new names. An old id that turns up in stored data is served under its new name, and a QR style saved under an old preset gets the new preset's flat look (its caption and any logo you picked stay). So older clients and saved browser state keep working.

### Moving to MongoDB

Earlier builds kept everything in a database file, `./data/blip.db`. This build stores everything in MongoDB and never opens that file: it stays on disk untouched, and nothing in it is copied over. Short links made before the switch answer 404 until you create them again, and **My links** drops them the first time it loads, because the server no longer knows them. Blip reads no database settings other than the `MONGODB_*` variables below, so any left over from an earlier setup can be removed.

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3030` | Listen port |
| `HOST` | `127.0.0.1` | Listen address (`0.0.0.0` to accept outside connections) |
| `BASE_URL` | `http://localhost:${PORT}` (on Vercel, the deployment's public URL) | The public URL that actually serves links today (no trailing slash) |
| `DOMAINS` | `blip.to,cat.ly,go.to,p.wrk` | Vanity domains offered in the UI (comma-separated) |
| `LIVE_DOMAINS` | *(empty)* | The subset of `DOMAINS` whose DNS really points at this server |
| `MONGODB_URI` | *(required)* | The connection string of your MongoDB cluster: `mongodb+srv://...` (Atlas) or `mongodb://...`. Anything else (another kind of URL, quotes around it, Atlas's `<db_password>` placeholder still in it) stops Blip with an error that names the variable and at most the scheme, never the string. Without it a local run exits, and Vercel answers `503 database_not_configured`; an unusable one there answers `503 misconfigured` |
| `MONGODB_DB` | `blip` on Vercel Production, `blip_preview` on Vercel Preview, `blip_dev` everywhere else | The database on that cluster. The defaults keep production, previews and local runs apart (see [Where the data lives](#where-the-data-lives)). MongoDB's own `admin`, `local` and `config` are refused, and so is a connection string pasted here by mistake (without printing it) |
| `MONGODB_USERNAME`, `MONGODB_PASSWORD` | *(empty)* | The database user, for a connection string without a user name and password of its own (when it has them, they win and these are ignored). Set both or neither |
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

`npm start` and `npm run dev` also read these settings from a `.env` file in the project folder when one exists (one `NAME=value` per line, as in [Quick start](#quick-start)). Variables already set in your shell take priority. Git ignores every `.env*` file, a `.env.example` included, so the repo ships none. `.vercelignore` keeps them and `data/` out of deployments made with the Vercel CLI from this folder: the CLI doesn't use `.gitignore`, and its own list skips only `.env.local` and `.env.*.local`, so without that file `vercel deploy` would upload `.env`. The deployed app never reads `.env`: set values for the live site in the project's environment variables. `npm test` never reads it either.

## Where the data lives

All of Blip's data lives in one database on the MongoDB cluster at `MONGODB_URI`. Which database depends on where Blip runs, so the environments never share data:

| Where Blip runs | Database (unless `MONGODB_DB` names another) |
|---|---|
| Vercel, Production | `blip` |
| Vercel, Preview | `blip_preview` |
| Your machine, `vercel dev`, Vercel's Development environment | `blip_dev` |

Each database holds five collections: `links`, `clicks`, `visitors` (one document per link and visitor hash, which is what decides the unique-visitor count), `counters` (the link and click id sequences) and `meta` (the visitor-hash salt, the schema version, and a counter that tells live dashboards to recount after simulated clicks are cleared). The first start against an empty database creates the indexes; later starts only read the schema version, the index lists and the salt, and create any index that has gone missing (after a collection was dropped in Atlas, for example). Every start-up step is safe to repeat and safe when several server instances start at once. If the link or click ids ever fall behind the stored documents (the `counters` collection was emptied, or documents were copied in without it), the next insert moves them past the highest stored id and carries on.

The `./data/blip.db` file of earlier builds stays on disk, unused (see [Moving to MongoDB](#moving-to-mongodb)).

If the database can't be reached, `npm start` stops with a message saying so; a server that is already running answers `503` and tries again on the next request. Every database operation a request waits for is given up after 8 seconds (5 to find a server), and on Vercel the start-up that a new instance runs inside its first request is given up after 15, so a stalled database means a quick `503` (for a visitor, the "can't reach its database" page) rather than a request that hangs. The logs name the cluster's hosts and the database, never the user name or password.

## Deploy to Vercel

Blip runs on Vercel as one Express function on Fluid compute, with its data in MongoDB Atlas and its pages, scripts, fonts and vendor files on Vercel's CDN. The repo carries everything Vercel needs: `server.js` (the entry Vercel detects; it exports the app and never listens), `vercel.json` (the Express preset, `npm run build` as the build command, Fluid compute with request cancellation and a 300 s limit for the function, and the same security headers the app sends) and `scripts/build-vendor.mjs`.

1. **Import the repo** into a Vercel project. `vercel.json` picks the Express preset, so a project created with the "Other" preset needs no settings changes. Node 22 or newer works; with `engines` at `>=22.13` Vercel builds on its newest Node (24 today).
2. **Put the cluster where the function runs.** Unless the project's **Settings > Functions** says otherwise, the function runs in `iad1` (Washington, D.C.), so create the Atlas cluster on AWS in `us-east-1` (N. Virginia). A visit waits for two database round trips before its redirect (find the link, use up a click) and its click row adds three more after it, so a cluster on another continent adds a few hundred milliseconds to every click. For scale, from a laptop to an Atlas cluster over the internet, a counted visit took about 150 ms when it waited for its row (all five round trips) and about 75 ms with Vercel's settings (two), against about 10 ms with MongoDB on the same machine.
3. **Create a database user just for Blip.** In Atlas, under **Database Access**, add a user with password authentication and a long generated password, and under its privileges choose **Specific Privileges**: `readWrite` on the database `blip` and on `blip_preview` (and `blip_dev` if you also run Blip locally with this user), nothing else. Don't use your Atlas account's password or an admin user. Stronger still: one user with `readWrite` on `blip` for Production and another with `readWrite` on `blip_preview` for Preview, so a preview can't touch production data even if a setting is wrong.
4. **Allow Vercel to connect.** Under **Network Access**, add `0.0.0.0/0` (**Allow access from anywhere**). Vercel functions have no fixed outbound IP addresses (they change between instances and deployments), so any narrower list blocks them at random. The tradeoff: anyone on the internet can now reach the cluster's sign-in, and what protects the data is the user name and password alone (Atlas always uses TLS, so they never cross the network in the clear). That is why step 3 matters: a dedicated user, a strong password used nowhere else, and access to the Blip databases only. If the password ever leaks, change it in Atlas and in Vercel, then redeploy. On a Pro or Enterprise plan, Vercel's Static IPs give the function fixed outbound addresses to list here instead.
5. **Add `MONGODB_URI` to Vercel.** In the project's **Settings > Environment Variables**, add `MONGODB_URI` for **Production** and for **Preview** (each with its own user, if you made two), with the connection string as its value: the real password in place of `<db_password>`, percent-encoded, and no quotes around it. Mark it **Sensitive**. Blip picks the database from the environment (`blip` for Production, `blip_preview` for Preview), so `MONGODB_DB` is only needed for other names. A connection string without a user name and password works too, with `MONGODB_USERNAME` and `MONGODB_PASSWORD` next to it. Blip reads no other database variables, so any left from an earlier setup can be deleted.
6. **Redeploy.** Environment variables only reach deployments made after they were added. The first request to a new instance opens the database, and the first one ever creates the indexes.
7. **Check it:** `/api/health` answers `{ "ok": true }` once the database is open (it waits for it, so this proves the connection). Then create a link, open it, and open its live dashboard. If anything answers `503`, the function's log says why (see [Troubleshooting](#troubleshooting)).

**Custom domains.** In production `BASE_URL` follows `VERCEL_PROJECT_PRODUCTION_URL`, which Vercel sets to the project's *shortest* production domain. As soon as you add a custom domain, set `BASE_URL` for Production (for example `https://blip.example.com`) and redeploy, so that adding a short vanity domain later can't change the domain every new link gets (see [Making a vanity domain live](#making-a-vanity-domain-live)). Blip recognises Vercel by its `VERCEL` variable, which Vercel only sets while **Automatically expose System Environment Variables** (Settings > Environment Variables) is on. It is on by default, and Blip logs a warning when the variable is missing.

Until `MONGODB_URI` is set, the deployment still serves its pages, every `/api` request answers `503` with `{ "error": { "code": "database_not_configured", "message": "Blip is not connected to its database yet. Add MONGODB_URI to this project's environment variables in Vercel and redeploy." } }` (the home page shows that message), short links show a short "not connected yet" page saying the same, and the function logs one line saying what is missing. A `MONGODB_URI` Blip can't use (not a `mongodb+srv://` or `mongodb://` string, wrapped in quotes, or still holding Atlas's `<db_password>` placeholder) answers `503 misconfigured` instead of crashing the function, as does any other invalid setting such as a malformed `BASE_URL`. Visitors only see "Blip is not set up correctly yet"; the log line names the variable and what is wrong with it, and quotes its value only when it can't hold a user name or password (never a connection string).

**What changes on Vercel** (any variable you set yourself still wins):

| Setting | On Vercel |
|---|---|
| `BASE_URL` | Optional at first. Production uses the project's shortest production domain (`VERCEL_PROJECT_PRODUCTION_URL`); previews use their branch URL (`VERCEL_BRANCH_URL`, else `VERCEL_URL`). Set it for Production once the project has a custom domain, or when links should carry another domain |
| `MONGODB_DB` | `blip` in Production and `blip_preview` in Preview (from `VERCEL_ENV`), so a preview never changes production data; `blip_dev` in Vercel's Development environment |
| `TRUST_PROXY` | `1`: Vercel's edge is the one proxy in front of the function, so visitor counts and rate limits use the client address it forwards |
| `ALLOW_DEMO_TRAFFIC` | `true`, so **Simulate traffic** can fill the map for a demo. To turn it off, add `ALLOW_DEMO_TRAFFIC=false` in the project's environment variables and redeploy |
| `STREAM_MAX_MS` | `250000`: a live stream ends after about four minutes, before Vercel's 300 s function limit cuts it, and the dashboard reconnects |
| Database connection | Opened by the first request an instance gets, never while the function loads: Vercel can suspend an instance whenever no request is running on it, so start-up work always runs inside a request. Each instance keeps a pool of at most 10 connections and closes one after 5 seconds without use. The pool is handed to `attachDatabasePool` from `@vercel/functions`, which keeps the instance running for about 5 seconds past the last connection it handed out, so its pooled connections are closed before it is suspended (one whose query ran longer than about 100 ms can still be open then). The driver's monitoring connections, one to each server of the cluster, stay open while an instance is suspended |
| Click rows | A visit answers as soon as its click is used up. Its click row is stored after the response, and `waitUntil` from `@vercel/functions` keeps the function running until the row is written, so a visit never waits for analytics. On your own server the visit waits for the row instead (at most 1.5 seconds), which keeps local stats and the tests exact the moment a visit returns |
| Location | Read only from Vercel's `x-vercel-ip-*` headers (another CDN's header could only come from the visitor). The offline `fast-geoip` database is never loaded or bundled |

**What is per instance.** Vercel can run several instances of the function at once, each with its own memory:

- Rate limits (20 links created, 30 simulations and 120 lookups per client per minute) and the live-stream caps (10 per link, 20 per client) are counted per instance, so the effective ceiling can be a few times higher.
- Each instance has its own MongoDB client: up to 10 pooled connections plus the driver's monitoring connection to each server of the cluster. Together they count toward the cluster's connection limit (500 on Atlas's free tier), so a busy deployment with many instances can reach it.
- `vercel.json` switches on request cancellation for the function, so closing or reloading a dashboard ends its stream at once, as it does locally. If a disconnect is ever missed, a client at its cap that opens another dashboard ends its own oldest stream (one at least 30 seconds old) instead of being refused.
- Live dashboards work across instances. Every open stream asks the database for new clicks and status changes every 2 seconds (`STREAM_POLL_MS`), so a visit handled by any instance shows up within about 2 seconds, and at once when it lands on the dashboard's own instance. Simulated traffic is stored in one go and played back on the dashboard about 120 ms apart. A stream ends after `STREAM_MAX_MS` and the dashboard reconnects on its own, so the Live caption says "Reconnecting" for a second or two every few minutes.
- Everything else lives in the database and is shared: links, clicks, the visitor-hash salt (each instance reads it once), and the counters that hand out link and click ids.

**Static and vendor files.** Vercel's CDN serves `public/` itself, and `express.static` never runs there. `npm run build` copies every `/vendor/...` file the pages load into `public/vendor/` at the same URL: it scans the pages, views, styles and scripts for `/vendor/` references, follows the font stylesheets to their font files, and fails the build when a reference has no source. `public/vendor/` is committed, because Vercel lists a clean checkout's static files before it runs the build. `.vercel/` is gitignored. The function owns `/` on Vercel, so it serves `index.html` itself, before the database gate. `/dashboard` and `/qr` are rewritten to their `.html` pages, as the local server does.

**Function settings.** `vercel.json` sets `maxDuration` (300 s) and `supportsCancellation` under the key `{index,server}.js`. Vercel's Express preset builds the app under the name `index.js`, whatever the entry file is called, and only applies `functions` settings whose key matches that name (a plain `server.js` key is accepted but ignored), so the pattern names both.

**What the function bundles.** `server.js`, `server/**` (views included), `public/index.html` and the packages they import: the `mongodb` driver (most of the bundle) with its plain JavaScript dependencies (`bson`, `mongodb-connection-string-url`, `@mongodb-js/saslprep`), Express, `ua-parser-js`, `i18n-iso-countries` (English names only) and `@vercel/functions`. The driver's optional add-ons (`kerberos`, `snappy`, `@mongodb-js/zstd`, client-side encryption, the AWS and GCP credential providers and `socks`) are not installed and never loaded: the driver only asks for each one inside the feature that needs it (Kerberos sign-in, snappy compression, a SOCKS proxy and so on), which Blip doesn't use. So keep `compressors=snappy` out of the connection string. `fast-geoip` stays out of the bundle, as before.

**Trying it locally.** `npx vercel build` writes the output Vercel would deploy to `.vercel/output` (one function of a few MB, plus the static files), and `npx vercel dev` runs it. `vercel dev` does not set `VERCEL`, so Blip behaves like a local run there (and logs a warning saying so): it needs `MONGODB_URI` in the shell, uses `blip_dev`, and stores click rows before answering. Add `VERCEL=1` to try the Vercel defaults; without `VERCEL_ENV=production` or `preview` the database is still `blip_dev`, never a deployment's.

## Troubleshooting

Blip writes one line per problem to its log, starting with `[blip]`, and never prints the user name or password of a connection string. On your machine the log is the terminal running `npm start` (which prints the same lines and exits with code 1 instead of serving 503s). On Vercel, open the project's **Logs** tab (or a deployment's runtime logs) and search for `[blip]`. A database problem reads like this, with the cluster's hosts, the database, the driver's message and then what to check:

```text
[blip] could not open the database (mongodb+srv://cluster0.example.mongodb.net, database blip): bad auth : authentication failed. The cluster refused the user name or password: compare MONGODB_URI (or MONGODB_USERNAME and MONGODB_PASSWORD) with the database user under Database Access in Atlas.
```

| The line says | What to do |
|---|---|
| `No database is configured.` | `MONGODB_URI` isn't set where Blip runs. On Vercel, add it for that environment (Production or Preview) and redeploy; on your machine, put it in `.env` |
| `Invalid MONGODB_URI: ...` | The value isn't a MongoDB connection string; the line says why (another kind of URL, quotes around it, the `<db_password>` placeholder still in it). Vercel answers `503 misconfigured` until the variable is fixed and the project redeployed |
| `Invalid MONGODB_DB: it holds a connection string` | The connection string went into `MONGODB_DB`. Move it to `MONGODB_URI`, and give `MONGODB_DB` a database name such as `blip` (or remove it to use the default). If the logs ever showed a password, change it in Atlas |
| `bad auth : authentication failed` or `Authentication failed.` | A wrong user name or password, or special characters in the password that aren't percent-encoded (`@` is `%40`, `:` is `%3A`, `/` is `%2F`). Check the user under **Database Access**, or give it a new password and update the variable |
| `Server selection timed out`, `connection ... closed`, `connect ETIMEDOUT` | No server let the connection in. Almost always the IP Access List: on Vercel, `0.0.0.0/0` must be listed under **Network Access**; on your machine, your current IP address. It also happens while a cluster is paused, being created or out of connections |
| `querySrv ENOTFOUND _mongodb._tcp...` | The cluster's host name in `MONGODB_URI` has a typo (or the machine is offline) |
| `user is not allowed to do action [...] on [blip.links]` | The user lacks `readWrite` on that database. Compare the database named in the line with the user's privileges |
| `database request failed (...)` | The database stopped answering after start-up (a failover, a network blip, a cluster at its limits). Visitors get the `503` "can't reach its database" page with `Retry-After: 5`, and the next request tries again |
| `recording a visit to /<slug> is slow` | A click row took more than 1.5 seconds to store. The visitor got their page anyway (on Vercel without waiting for it at all); it points at a slow or distant cluster |

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
  index.js          local entry: loadConfig() → createApp() → await ready → listen; graceful SIGINT/SIGTERM shutdown;
                    exits with code 1 and one clear line when MONGODB_URI is missing or invalid or the database can't be opened
  vercel.js         createVercelApp(env): the app for a Vercel function (never throws, never listens): database opened by the
                    first request, a 10-connection pool handed to attachDatabasePool, click rows kept alive with waitUntil
  app.js            createApp({ config, now, random, geoLookup, rateLimits, streamLimits, unavailable, mongoClientOptions,
                    onDatabaseClient, waitUntil, deferClickWrites, connectOnFirstRequest }) → { app, db, ready, close, endStreams }
                    security headers (strict CSP), /vendor/* from node_modules, static files, wait for the database
                    (or 503 when there is none), /api, /:slug, errors; log lines with credentials masked
  vendor.js         the /vendor URLs and the node_modules files behind them (read by app.js and the vendor build)
  config.js         env parsing + normalisation (MONGODB_URI checked, the database picked by environment, Vercel defaults)
  db.js             the MongoDB layer on the official driver: one client per app, indexes, the guarded consume, click rows,
                    id sequences, the delete cascade, time limits, isDatabaseUnavailable (which failures become a 503) and
                    databaseFailureHint (what to check, in the log)
  themes.js         teaser theme and QR preset ids, and the first-release ids they replaced
  slugs.js words.js slug normalisation/validation, word & random slugs, suggestions
  urls.js           destination URL validation (http/https only, no credentials, no redirect loops)
  domains.js        domain options + offline domain-idea generator
  links.js          link status, LinkDTO mapping, create/update validation
  qrstyle.js        qrStyle whitelist validation
  analytics.js      UA parsing, bot detection, visitor hashing, ClickEvent + StatsDTO builder
  geo.js            CDN country headers → optional offline fast-geoip (150 ms cap, private IPs skipped; on Vercel only x-vercel-ip-*)
  simulate.js       synthetic demo clicks (data/cities.js), stored in one insert
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
  run.mjs           npm test: one in-process MongoDB for the whole run, then every suite
  mongo-server.js   that MongoDB (mongodb-memory-server-core, a one-member replica set on 127.0.0.1)
  helpers.js        startServer() and friends: a fresh database per app, local connection strings only
  tcp-proxy.js      a TCP proxy that resets or stalls connections, for the failure tests
```

**Vendor routes** (served straight from `node_modules`, because the CSP only allows `'self'`): `/vendor/fonts/bangers/` and `/vendor/fonts/comic-neue/` (Fontsource packages; pages load `latin-400.css`, plus `latin-700.css` for Comic Neue), `/vendor/d3.min.js`, `/vendor/topojson-client.min.js`, `/vendor/countries-110m.json` and `/vendor/qr-code-styling.js`. They come before the static site, so a local run serves the installed versions even after a build. On Vercel the same URLs are the static copies `npm run build` makes in `public/vendor/`.

**What happens on a visit (`GET /:slug`):**

1. Look up the link. An unknown slug gets a 404 page.
2. If the link is expired or destroyed, log a "blocked" attempt and answer 410.
3. A link-preview bot on a limited link gets the preview page (200), and nothing is consumed.
4. Otherwise, use up one click with one atomic update that only succeeds while the link is active and has clicks left. If the link was deleted a moment earlier (on any instance), the visitor gets the 404 page.
5. Store the click row: device/browser/OS, referrer host, coarse location and visitor hash. Its id and its first-visit check go together, then the insert, then a check that the link still exists. On a server the visit waits for this (at most 1.5 seconds); on Vercel it answers first and the row is stored after the response.
6. Wake the live dashboards open on this server instance. Every dashboard reads the click (and any status change) from the database: at once on this instance, at its next poll (every 2 seconds) on any other.
7. Answer with a 302 redirect or the teaser page.

`HEAD` requests get the same status codes but are never recorded or counted. Because they never use up a click, a `HEAD` to a click-limited link answers `302` without a `Location` header, so it can't be used to peek at a "burn after reading" destination.

A counted visit sends six database commands in five round trips, one after the other: the lookup, the consume, the row's id and visitor together, the insert and the existence check. On Vercel only the first two come before the answer. Using up a click and storing its row are two separate writes, and the click is used up first: a crash between them loses one analytics row and can never let an extra visitor through. A visitor whose click was used up always gets through, even when the row's write fails or takes more than 1.5 seconds (both are logged), and recording a visit that uses up nothing (a blocked attempt or a bot) can never break it either.

Live dashboards never rescan a link's history on a visit. Each stream counts its totals once when it connects, in one aggregation, then every poll is one aggregation that reads the link and only its rows the stream hasn't seen. Click ids are handed out before their rows are stored, so a slow row can land behind newer ones: each poll also looks up to 512 ids back, skipping the ones it has seen without reading them, so a late click is still sent and counted once. When simulated clicks are cleared, a counter in `meta` moves and every open stream recounts once, so the totals stay exact. Very rarely a `status` event (the click count changed) arrives one poll before the `click` event of the same visit.

The stats endpoint is one aggregation, given up after 7 seconds of database time: **All time** on a link of about 400,000 clicks whose details are all different is near that limit, and would answer `503` above it. Stats also return the highest click id stored when they were read (`throughClickId`), so the dashboard never counts a live click twice when the click reaches its stream after a refresh already included it. A click whose row was still on its way can land below that id, and the refetch the dashboard makes after every live click (1.5 seconds later) counts it. If deleting a link fails after the link itself is gone, its rows stay behind where nothing can see them.

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

The suites use the built-in `node:test` runner and `assert/strict`; the one test dependency is `mongodb-memory-server-core`. `npm test` runs `test/run.mjs`, which starts one MongoDB 8.0 server for the whole run (a replica set of one member, so writes behave as on Atlas, listening on 127.0.0.1 only) and then every suite with `node --test`, each suite in its own process and each app in a fresh database that is dropped afterwards. A run always ends: a suite's process exits once its tests are done even if something it opened is still running, and a suite or test that hangs fails after two minutes. The first run on a machine downloads that server once (an archive of about 760 MB; the `mongod` binary is kept in `~/.cache/mongodb-binaries`), and nothing is downloaded at `npm install`. The tests never reach a real cluster: `npm test` doesn't read `.env`, removes every `MONGODB_*` variable before the suites start, and the helpers refuse any connection string that could reach another machine (a user name in it, an `+srv` name, or any host of its seed list off 127.0.0.1, `[::1]` and localhost). HTTP tests start an isolated app on an ephemeral port with a mutable injected clock, so expiry and time-bucket tests are instant and deterministic. There are 306 tests in 80 suites. They cover:

- slug rules and suggestions, URL validation and domain ideas
- the template escaping, including XSS attempts
- create/update/delete validation, token auth (401/403/404) and the batch endpoint
- the comic theme and preset ids, the old ids still accepted on input, and old ids found in storage served under the new ones
- 302/410/404 responses, teaser pages, bot previews and `HEAD` handling (including that `HEAD` never reveals a click-limited target)
- expiry by time and by clicks, 30 concurrent visitors racing for 3 clicks, destroy/revive, and limits changed by `PATCH` (with the matching live `status` events)
- analytics failures (a throwing geo provider, a link deleted while a blocked attempt is recorded) never breaking the visit, and a link deleted mid-visit answering 404 instead of "self-destructed"
- database failures after start-up (a failover, a network failure, a server that can't be found) answering `503` with the "can't reach its database" page or JSON, logged with the cluster and the database, while any other error stays a `500`
- stats totals (including the bot and blocked overlap behind the "Bots & blocked" count), buckets (including time zones) and top-8 + "Other" breakdowns, simulated traffic (stored before the response, played back about 120 ms apart), the SSE stream, its running totals (including after simulated clicks are cleared), the status events for every click-count change, and its per-link/per-client connection caps (and a client's own stale streams making room, never another client's)
- **All time** stats over long spans: clicks years apart all count, and the chart switches to weeks (starting Monday) after a year and to calendar months after 520 weeks, aligned to time zones east and west of UTC
- redirect-loop protection (base host, vanity domains, loopback and listen addresses on Blip's port)
- the data layer on MongoDB: 30 racing visits for 3 clicks consuming exactly 3 (on one instance and across two), one visitor's racing first visits counted unique once, id sequences that never hand out an id twice and that catch up when their counter falls behind the stored documents (a create then still gets its free slug, and only a taken slug is a `409`), the delete cascade whichever way it races an arriving click, index creation that changes nothing the second time and that several instances can run at once, the indexes of a dropped collection created again on the next start, every query on an index (checked with `explain`), the commands a visit, a stats request and a stream poll cost, a warm start that only reads, credentials in the connection string or in their own variables, requests waiting for a database that is still starting, and `503` for one that can't be opened
- a database that stops answering: a visit, the stats and every other API request that waits for it (a create, slug checks and suggestions, My links, saving, destroying, bringing back or deleting a link, simulating traffic and clearing it) answer `503` within their limit
- failures through a TCP proxy in front of the test server: reset connections and a server that stops answering get a prompt `503` (logged without credentials) and the app recovers; a start-up that takes too long is given up and retried; credentials the server refuses; a live stream that ends after three failed polls; late clicks that land behind newer ones sent and counted once; a recount after cleared clicks that fails once and is tried again, so the cleared clicks are never counted back; the snapshot and every poll reading the clear counter before the clicks
- click rows: off Vercel a visit waits for its row at most 1.5 seconds, and with Vercel's settings it answers once its click is used up while the row is stored after the response (handed to `waitUntil`), a consume that hangs still holds the visit, and a failing or slow row is logged
- configuration: the database picked by environment, `MONGODB_URI` checked without its value (or a user name) in any message, a connection string pasted into `MONGODB_DB`, `BASE_URL`, `PORT` or a stream setting never printed either, half-set credentials, MongoDB's own database names refused, credentials masked in every log line, and what the log suggests for each kind of failure
- `npm start` (`server/index.js`): without `MONGODB_URI` it says to put it in `.env` and exits with 1, a bad setting names the variable and the scheme only, a connection string in `MONGODB_DB` is named without being printed, refused credentials say what to check without printing them, and a good database starts the server; none of them prints a stack trace
- the old backend: nothing in `server/`, the pages and their scripts, `README.md` or `SPEC.md` mentions it, and it is no dependency
- links surviving a `PORT`/`BASE_URL` change
- rate limiting (per-route budgets, `TRUST_PROXY` hop counts, IPv6 /64 grouping, the client cap) and security headers
- the Bangers and Comic Neue font routes, and that the first release's icon library and font routes now answer 404
- copy rules: API error messages, trivia facts, domain idea notes and every rendered view are free of em dashes and emoji, and the views only load assets that exist
- the design audit: `test/design-audit.test.js` runs `scripts/audit-design.mjs` and requires 0 findings, and unit-tests its CSS rules (such as disabled or unselected controls faded with opacity)
- shutdown: closing the app closes the database, even if it was already closed or is still starting up
- live streams across instances: two apps sharing one database, where a visit, simulated clicks, a cleared simulation, a limit change and a deletion handled by one reach the other's dashboard by polling alone, and a stream that ends cleanly after `STREAM_MAX_MS`
- Vercel: `server.js` imports express, exports the app and never listens, and importing it loads none of the driver's optional packages (none of them is installed), nor `@vercel/oidc` or `fast-geoip`; `vercel.json` (Fluid compute, request cancellation, the 300 s limit) and its security headers; the Vercel defaults (base URL per environment, the database per environment, `TRUST_PROXY=1`, demo traffic, stream time limit); `503 database_not_configured` JSON and the "not connected yet" page without a database, `503 misconfigured` for an unusable `MONGODB_URI`, a connection string in `MONGODB_DB` (logged without it) or another invalid setting; the database opened by the first request, in a pool of 10 handed to `attachDatabasePool`, and a pool Vercel can't take logged without failing a request; and a full create, visit and stats round trip with each click row handed to `waitUntil`; with the real `@vercel/functions` and a request context like Vercel's, every connection checkout keeping its own request alive, and a live stream's polls keeping the stream's request alive whichever visit or `PATCH` woke them; `.vercelignore` keeping `.env*` and `data/` out of CLI deployments; Vercel's geo headers, with other CDNs' headers ignored and `fast-geoip` never imported
- the vendor build: every `/vendor/` URL the pages use is copied byte for byte, with the font files behind each font stylesheet, and an unknown one fails the build

Each suite runs in its own process (`test/helpers.js` is shared setup, not a suite). Run some of them with, for example, `npm test -- test/redirect.test.js` (options such as `--test-name-pattern` go on to `node --test` too, and without a suite file every suite runs), or one on its own with `node --test test/redirect.test.js`, which starts a MongoDB server of its own.
