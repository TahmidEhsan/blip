// Running on Vercel: the root server.js entry, vercel.json, the vendor build, and the app's behaviour
// with Vercel's settings (no database yet, invalid settings, Turso, proxy and geo headers).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATABASE_NOT_CONFIGURED_MESSAGE, SECURITY_HEADERS } from '../server/app.js';
import { PROJECT_ROOT, VERCEL_NO_DATABASE_PROBLEM, VERCEL_STREAM_MAX_MS } from '../server/config.js';
import { MISCONFIGURED_MESSAGE, createVercelApp } from '../server/vercel.js';
import { VENDOR_FILES, vendorSource } from '../server/vendor.js';
import { buildVendor, findVendorReferences } from '../scripts/build-vendor.mjs';
import { UA, assertPlainCopy, removeTempDir } from './helpers.js';
import { loadNodeSqlite, startHranaServer } from './hrana-shim.js';

const sqlite = await loadNodeSqlite();

/** Only what a child node process needs, so no database variable leaks in from this shell. */
const baseEnv = () => Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

describe('vercel.json', () => {
  const config = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'vercel.json'), 'utf8'));

  it('picks the Express preset and runs the vendor build', () => {
    assert.equal(config.framework, 'express');
    assert.equal(config.buildCommand, 'npm run build');
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.build, 'node scripts/build-vendor.mjs');
  });

  it('runs the app as one Fluid compute function that hears about cancelled requests', () => {
    assert.equal(config.fluid, true);
    // Vercel's Express preset builds the function under the name index.js whatever the entry file is
    // called, and matches `functions` keys against that name (a "server.js" key is accepted and silently
    // ignored, checked with `vercel build`). The pattern also names the entry file, for builders that use it.
    assert.deepEqual(Object.keys(config.functions), ['{index,server}.js']);
    const fn = config.functions['{index,server}.js'];
    // Without cancellation a closed dashboard is never reported, and its stream runs until STREAM_MAX_MS.
    assert.equal(fn.supportsCancellation, true);
    assert.equal(fn.maxDuration, 300);
    assert.ok(VERCEL_STREAM_MAX_MS < fn.maxDuration * 1000, 'live streams end before the function limit');
  });

  it("sends the app's security headers on files Vercel's CDN serves itself", () => {
    const all = config.headers.find((h) => h.source === '/(.*)');
    assert.ok(all, 'a rule for every path');
    assert.deepEqual(Object.fromEntries(all.headers.map((h) => [h.key, h.value])), { ...SECURITY_HEADERS });
  });

  it('keeps the build output out of git, and the vendor copies in it', () => {
    const ignored = fs.readFileSync(path.join(PROJECT_ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignored.includes('/.vercel/'));
    assert.ok(!ignored.some((line) => line.includes('public/vendor')), 'Vercel lists static files before the build, so they must be committed');
  });
});

describe('vendor build (npm run build)', () => {
  let out;
  let result;
  before(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-vendor-'));
    result = buildVendor({ outDir: out });
  });
  after(() => fs.rmSync(out, { recursive: true, force: true }));

  it('matches the copies committed in public/vendor, every one tracked by git', () => {
    // Vercel lists a clean checkout's static files BEFORE it runs the build, so an untracked copy never
    // reaches its CDN and that URL falls through to the function.
    const listed = spawnSync('git', ['ls-files', 'public/vendor'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assert.equal(listed.status, 0);
    const tracked = new Set(listed.stdout.split(/\r?\n/).filter(Boolean));
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const built = walk(path.join(out, 'vendor'));
    assert.ok(built.length > 0);
    for (const file of built) {
      const rel = path.relative(out, file).split(path.sep).join('/');
      assert.ok(tracked.has(`public/${rel}`), `public/${rel} is committed`);
      assert.ok(fs.readFileSync(file).equals(fs.readFileSync(path.join(PROJECT_ROOT, 'public', rel))), `public/${rel} is up to date (run npm run build)`);
    }
  });

  it('copies every /vendor URL the pages, views, styles and scripts use, at the same path', () => {
    const refs = findVendorReferences();
    for (const url of ['/vendor/fonts/bangers/latin-400.css', '/vendor/fonts/comic-neue/latin-400.css', '/vendor/fonts/comic-neue/latin-700.css']) {
      assert.ok(refs.has(url), `${url} is referenced`);
    }
    for (const url of refs.keys()) {
      assert.ok(result.files.includes(url), `${url} was copied`);
      const copied = path.join(out, ...url.split('/').filter(Boolean));
      const original = path.join(PROJECT_ROOT, 'node_modules', ...vendorSource(url).split('/'));
      assert.ok(fs.readFileSync(copied).equals(fs.readFileSync(original)), `${url} is an exact copy`);
    }
    for (const url of Object.keys(VENDOR_FILES)) assert.ok(result.files.includes(url), `${url} (a vendor route) is shipped`);
  });

  it('follows the font stylesheets to their font files', () => {
    for (const url of result.files.filter((f) => f.endsWith('.css'))) {
      const css = fs.readFileSync(path.join(out, ...url.split('/').filter(Boolean)), 'utf8');
      const fonts = [...css.matchAll(/url\(\.\/(files\/[^)]+)\)/g)].map((m) => m[1]);
      assert.ok(fonts.length >= 1, `${url} loads font files`);
      for (const font of fonts) {
        const fontUrl = new URL(font, `http://x${url}`).pathname;
        assert.ok(result.files.includes(fontUrl), `${fontUrl} was copied`);
      }
    }
  });

  it('fails on a /vendor URL it cannot resolve, and replaces an earlier build', () => {
    fs.writeFileSync(path.join(out, 'vendor', 'stale.js'), 'old');
    buildVendor({ outDir: out });
    assert.equal(fs.existsSync(path.join(out, 'vendor', 'stale.js')), false, 'leftovers are removed');
    const refs = new Map([['/vendor/lucide.min.js', new Set(['public/index.html'])]]);
    assert.throws(() => buildVendor({ outDir: out, refs }), /\/vendor\/lucide\.min\.js \(used in public\/index\.html\) has no vendor route/);
  });
});

describe('server.js (the Vercel entry)', () => {
  it('imports express, exports the app and never listens', () => {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'server.js'), 'utf8');
    assert.match(source, /import\s*['"]express['"]/, "Vercel's detection looks for an express import");
    assert.match(source, /export default /);
    assert.doesNotMatch(source, /\.listen\(|process\.exit/);

    const probe = `
      const mod = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'server.js')).href)});
      const app = mod.default;
      const resources = process.getActiveResourcesInfo();
      console.log(JSON.stringify({ isApp: typeof app === 'function' && typeof app.handle === 'function', listening: resources.includes('TCPServerWrap') }));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: PROJECT_ROOT,
      env: { ...baseEnv(), VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'blip-test.vercel.app' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(run.status, 0, `the import exits on its own: ${run.stderr}`);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
    assert.deepEqual(result, { isApp: true, listening: false });
    assert.match(run.stderr, /No database is configured/, 'the missing database is logged');
  });
});

describe('on Vercel without a database', () => {
  let blip;
  let server;
  let base;
  let errors;
  before(async () => {
    const original = console.error;
    errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    try {
      blip = createVercelApp({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'blip.example.app' });
    } finally {
      console.error = original;
    }
    ({ server, base } = await listen(blip.app));
  });
  after(async () => {
    server.close();
    await blip.close();
  });

  it('logs one clear error and never opens a database', async () => {
    assert.deepEqual(errors, [`[blip] ${VERCEL_NO_DATABASE_PROBLEM}`]);
    assert.equal(blip.db, null);
    await assert.rejects(blip.ready, (err) => err.code === 'DATABASE_NOT_CONFIGURED');
  });

  it('answers every /api route with 503 database_not_configured', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/health'], ['GET', '/api/config'], ['POST', '/api/links', { targetUrl: 'https://example.com' }],
      ['GET', '/api/links/some-slug/stats'], ['GET', '/api/nope'],
    ]) {
      const res = await fetch(base + url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(res.status, 503, `${method} ${url}`);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await res.json(), { error: { code: 'database_not_configured', message: DATABASE_NOT_CONFIGURED_MESSAGE } });
    }
  });

  it('answers short links with a short 503 page that says the same', async () => {
    const res = await fetch(`${base}/brave-otter`, { headers: { Accept: 'text/html', 'User-Agent': UA.iphone } });
    assert.equal(res.status, 503);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.equal(res.headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy']);
    const html = await res.text();
    assert.ok(html.includes(DATABASE_NOT_CONFIGURED_MESSAGE));
    assertPlainCopy(html, 'the 503 page');
    for (const [, url] of html.matchAll(/<(?:link|script|img|use)\b[^>]*?\s(?:href|src)="(\/[^"/][^"]*)"/g)) {
      const asset = await fetch(base + url.replace(/#.*$/, ''));
      assert.equal(asset.status, 200, `${url} exists`);
      await asset.arrayBuffer();
    }
    assert.equal((await fetch(`${base}/brave-otter`, { method: 'HEAD', headers: { Accept: 'text/html' } })).status, 503);
  });

  it('still serves the pages and their files', async () => {
    for (const url of ['/', '/dashboard.html', '/favicon.svg', '/vendor/d3.min.js']) {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, url);
      await res.arrayBuffer();
    }
  });

  it('refuses a local database file, which a deployed function cannot use', () => {
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    let local;
    try {
      local = createVercelApp({ VERCEL: '1', TURSO_DATABASE_URL: 'file:/tmp/blip.db' });
    } finally {
      console.error = original;
    }
    assert.equal(local.db, null);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /Invalid TURSO_DATABASE_URL: a local database \(a file: URL\) can't be used on Vercel/);
    assert.ok(logged[0].endsWith(VERCEL_NO_DATABASE_PROBLEM));
    local.close();
  });

  it('treats a database URL Blip cannot use as not configured, without crashing or leaking it', () => {
    const secret = 'hunter2-not-for-logs';
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    let other;
    try {
      other = createVercelApp({ VERCEL: '1', DATABASE_URL: `postgres://blip:${secret}@db.example.com/blip` });
    } finally {
      console.error = original;
    }
    assert.equal(other.db, null);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /Invalid DATABASE_URL: "postgres:" URLs are not supported/);
    assert.ok(!logged[0].includes(secret));
    other.close();
  });

  it('answers 503 misconfigured when a setting is invalid, instead of crashing every request', async () => {
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    let broken;
    try {
      broken = createVercelApp({ VERCEL: '1', BASE_URL: 'ftp://blip.example.com', TURSO_DATABASE_URL: 'libsql://blip.turso.io' });
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    assert.match(logged[0], /Invalid BASE_URL "ftp:\/\/blip\.example\.com"/);
    const { server: s2, base: b2 } = await listen(broken.app);
    try {
      const res = await fetch(`${b2}/api/config`);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: { code: 'misconfigured', message: MISCONFIGURED_MESSAGE } });
      const page = await fetch(`${b2}/some-link`, { headers: { Accept: 'text/html' } });
      assert.equal(page.status, 503);
      assert.ok((await page.text()).includes(MISCONFIGURED_MESSAGE));
    } finally {
      s2.close();
      await broken.close();
    }
  });
});

describe('on Vercel with Turso (emulated by a local libSQL server over HTTP)', { skip: sqlite ? false : 'node:sqlite is not available in this Node build' }, () => {
  let dir;
  let shim;
  let blip;
  let server;
  let base;
  let logged;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-vercel-'));
    shim = await startHranaServer({ file: path.join(dir, 'turso.db'), sqlite });
    const original = console.log;
    logged = [];
    console.log = (...args) => logged.push(args.join(' '));
    try {
      blip = createVercelApp({
        VERCEL: '1',
        VERCEL_ENV: 'preview',
        VERCEL_BRANCH_URL: 'blip-git-main-team.vercel.app',
        TURSO_DATABASE_URL: shim.url,
        TURSO_AUTH_TOKEN: 'turso-token-for-tests',
      });
    } finally {
      console.log = original;
    }
    await blip.ready;
    ({ server, base } = await listen(blip.app));
  });
  after(async () => {
    server?.close();
    await blip?.close();
    await shim?.close();
    await removeTempDir(dir);
  });

  it('talks to the database over HTTP with its token, and never logs the token', () => {
    assert.equal(blip.db.local, false);
    assert.equal(shim.state.authorization, 'Bearer turso-token-for-tests');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /database: http:\/\/127\.0\.0\.1:\d+/);
    assert.ok(!logged[0].includes('turso-token-for-tests'));
  });

  it('creates, visits and counts links under the deployment URL', async () => {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.baseUrl, 'https://blip-git-main-team.vercel.app');
    assert.equal(config.allowDemoTraffic, true);

    const created = await fetch(`${base}/api/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: 'https://example.com/on-vercel', slug: 'on-vercel' }),
    });
    assert.equal(created.status, 201);
    const { link, manageToken } = await created.json();
    assert.equal(link.shortUrl, 'https://blip-git-main-team.vercel.app/on-vercel');

    // Vercel's edge is the one trusted proxy: the client is the last X-Forwarded-For entry, and the
    // location comes from its x-vercel-ip-* headers (a cf-ipcountry header sent by the visitor is ignored).
    const visit = (ip, headers = {}) => fetch(`${base}/on-vercel`, {
      redirect: 'manual',
      headers: { 'User-Agent': UA.iphone, 'X-Forwarded-For': ip, ...headers },
    });
    const first = await visit('203.0.113.7', { 'x-vercel-ip-country': 'BR', 'x-vercel-ip-city': 'S%C3%A3o%20Paulo', 'cf-ipcountry': 'FR' });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get('location'), 'https://example.com/on-vercel');
    assert.equal((await visit('198.51.100.9')).status, 302);

    const stats = await (await fetch(`${base}/api/links/on-vercel/stats?range=all`, { headers: { 'X-Manage-Token': manageToken } })).json();
    assert.equal(stats.totals.clicks, 2);
    assert.equal(stats.totals.uniqueVisitors, 2, 'two forwarded client IPs are two visitors');
    assert.deepEqual(stats.countries.map((c) => c.code), ['BR']);
    assert.equal(stats.recent.find((c) => c.country === 'BR').city, 'São Paulo');
  });
});
