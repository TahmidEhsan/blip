// Running on Vercel: the root server.js entry, vercel.json, the vendor build, and the app's behaviour
// with Vercel's settings (no database yet, invalid settings, MongoDB, proxy and geo headers).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { MongoClient } from 'mongodb';
import { DATABASE_NOT_CONFIGURED_MESSAGE, SECURITY_HEADERS, createApp } from '../server/app.js';
import { PROJECT_ROOT, VERCEL_NO_DATABASE_PROBLEM, VERCEL_STREAM_MAX_MS } from '../server/config.js';
import { escapeHtml } from '../server/render.js';
import { MISCONFIGURED_MESSAGE, VERCEL_MONGO_CLIENT_OPTIONS, createVercelApp } from '../server/vercel.js';
import { VENDOR_FILES, vendorSource } from '../server/vendor.js';
import { buildVendor, findVendorReferences } from '../scripts/build-vendor.mjs';
import { UA, assertPlainCopy, dropTestDatabase, freshDatabaseName, openStream, testMongoUri } from './helpers.js';

/** Only what a child node process needs, so no database variable leaks in from this shell. */
const baseEnv = () => Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));

/**
 * Packages the function must never load: the driver's optional peers (native or cloud add-ons Blip does
 * not use, none of them installed), what @vercel/functions only needs for OIDC tokens, and fast-geoip.
 */
const NEVER_LOADED = [
  'kerberos', 'snappy', '@mongodb-js/zstd', 'mongodb-client-encryption', 'gcp-metadata', '@aws-sdk/credential-providers', 'socks',
  'ws', '@vercel/oidc', '@aws-sdk/credential-provider-web-identity', 'fast-geoip',
];

/** The npm packages behind every CommonJS module loaded so far, from a require.cache. */
function loadedPackages(cache) {
  const marker = `${path.sep}node_modules${path.sep}`;
  return [...new Set(Object.keys(cache).filter((file) => file.includes(marker)).map((file) => {
    const [first, second] = file.slice(file.lastIndexOf(marker) + marker.length).split(path.sep);
    return first.startsWith('@') ? `${first}/${second}` : first;
  }))].sort();
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

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

  it('keeps .env files and the old database file out of a deployment made with the Vercel CLI', () => {
    // The CLI ignores neither on its own (its list only has .env.local and .env.*.local), and .env holds
    // the real connection string. `/data` and not `/data/`, which would still upload an empty folder.
    const ignored = fs.readFileSync(path.join(PROJECT_ROOT, '.vercelignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignored.includes('.env*'));
    assert.ok(ignored.includes('/data'));
    assert.ok(!ignored.some((line) => /^\/?(public|server|scripts)\b|^server\.js$|^vercel\.json$|^package/.test(line)), 'nothing the deployment needs');
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
      import { createRequire } from 'node:module';
      import path from 'node:path';
      ${loadedPackages.toString()}
      const mod = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'server.js')).href)});
      const app = mod.default;
      const resources = process.getActiveResourcesInfo();
      const packages = loadedPackages(createRequire(import.meta.url).cache);
      console.log(JSON.stringify({ isApp: typeof app === 'function' && typeof app.handle === 'function', listening: resources.includes('TCPServerWrap'), packages }));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: PROJECT_ROOT,
      env: { ...baseEnv(), VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'blip-test.vercel.app' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(run.status, 0, `the import exits on its own: ${run.stderr}`);
    const { packages, ...result } = JSON.parse(run.stdout.trim().split('\n').at(-1));
    assert.deepEqual(result, { isApp: true, listening: false });
    assert.match(run.stderr, /No database is configured/, 'the missing database is logged');

    // What Vercel's tracer bundles is what these imports reach. The driver loads its optional peers
    // (kerberos, snappy, zstd, client-side encryption, AWS and GCP credentials, SOCKS) only inside the
    // functions that use them, in a try/catch, so they are neither installed nor needed.
    for (const name of ['express', 'mongodb', 'bson', '@vercel/functions']) assert.ok(packages.includes(name), `${name} is loaded`);
    for (const name of NEVER_LOADED) assert.ok(!packages.includes(name), `${name} is not loaded`);
    const require = createRequire(path.join(PROJECT_ROOT, 'package.json'));
    for (const name of NEVER_LOADED.filter((n) => !['@vercel/oidc', 'fast-geoip'].includes(n))) {
      assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' }, `${name} is not installed`);
    }
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
    assert.ok(html.includes(`<p class="visit-copy">${escapeHtml(DATABASE_NOT_CONFIGURED_MESSAGE)}</p>`), 'the page says what to do');
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

  it('says exactly what to do, with nothing else in the message', () => {
    assert.equal(DATABASE_NOT_CONFIGURED_MESSAGE, "Blip is not connected to its database yet. Add MONGODB_URI to this project's environment variables in Vercel and redeploy.");
    assertPlainCopy(DATABASE_NOT_CONFIGURED_MESSAGE, 'the not-connected message');
  });

  it('answers 503 misconfigured for a MONGODB_URI it cannot use, naming only the variable and the scheme', async () => {
    const secret = 'hunter2-not-for-logs';
    for (const [uri, named] of [
      [`postgres://blip:${secret}@db.example.com/blip`, /Invalid MONGODB_URI: "postgres:\/\/" connection strings are not supported/],
      [`blip:${secret}@cluster0.example.mongodb.net`, /Invalid MONGODB_URI: expected a MongoDB connection string/],
    ]) {
      const original = console.error;
      const logged = [];
      console.error = (...args) => logged.push(args.join(' '));
      let broken;
      try {
        broken = createVercelApp({ VERCEL: '1', VERCEL_ENV: 'production', MONGODB_URI: uri });
      } finally {
        console.error = original;
      }
      assert.equal(broken.db, null, 'no database is opened');
      assert.equal(logged.length, 1);
      assert.match(logged[0], named);
      assert.match(logged[0], /Fix it in the project's environment variables, then redeploy\.$/);
      for (const leak of [secret, 'db.example.com', 'cluster0']) assert.ok(!logged[0].includes(leak), `${leak} in: ${logged[0]}`);
      const { server: s2, base: b2 } = await listen(broken.app);
      try {
        const res = await fetch(`${b2}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUrl: 'https://example.com' }) });
        assert.equal(res.status, 503);
        const text = await res.text();
        assert.deepEqual(JSON.parse(text), { error: { code: 'misconfigured', message: MISCONFIGURED_MESSAGE } });
        const page = await fetch(`${b2}/brave-otter`, { headers: { Accept: 'text/html' } });
        assert.equal(page.status, 503);
        const html = await page.text();
        assert.ok(html.includes(MISCONFIGURED_MESSAGE));
        for (const body of [text, html]) assert.ok(!body.includes(secret) && !body.includes('MONGODB_URI'), 'visitors never see the setting');
        assert.equal((await fetch(`${b2}/`)).status, 200, 'the home page still loads');
      } finally {
        s2.close();
        await broken.close();
      }
    }
  });

  it('answers 503 misconfigured for a connection string pasted into MONGODB_DB, and never logs it', async () => {
    const secret = 'hunter2-not-for-logs';
    const uri = `mongodb+srv://blip-user:${secret}@cluster0.example.mongodb.net/?retryWrites=true`;
    for (const env of [{ MONGODB_DB: uri }, { MONGODB_URI: uri, MONGODB_DB: uri }]) {
      const original = console.error;
      const logged = [];
      console.error = (...args) => logged.push(args.join(' '));
      let broken;
      try {
        broken = createVercelApp({ VERCEL: '1', VERCEL_ENV: 'production', ...env });
      } finally {
        console.error = original;
      }
      assert.equal(broken.db, null, 'no database is opened');
      assert.equal(logged.length, 1);
      assert.match(logged[0], /Invalid MONGODB_DB: it holds a connection string, which belongs in MONGODB_URI\./);
      assert.match(logged[0], /Fix it in the project's environment variables, then redeploy\.$/);
      for (const leak of [secret, 'blip-user', 'cluster0']) assert.ok(!logged[0].includes(leak), `${leak} in: ${logged[0]}`);
      assertPlainCopy(logged[0], 'the misconfigured log line');
      const { server: s2, base: b2 } = await listen(broken.app);
      try {
        const res = await fetch(`${b2}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUrl: 'https://example.com' }) });
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { error: { code: 'misconfigured', message: MISCONFIGURED_MESSAGE } });
      } finally {
        s2.close();
        await broken.close();
      }
    }
  });

  it('answers 503 misconfigured when a setting is invalid, instead of crashing every request', async () => {
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    let broken;
    try {
      broken = createVercelApp({ VERCEL: '1', BASE_URL: 'ftp://blip.example.com', MONGODB_URI: 'mongodb+srv://blip.example.net' });
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

describe('on Vercel with MongoDB (the in-process server of this test run)', () => {
  const dbName = freshDatabaseName();
  // Stand-ins for @vercel/functions: what Blip hands to attachDatabasePool and waitUntil.
  const attached = [];
  const kept = [];
  const functions = { attachDatabasePool: (client) => attached.push(client), waitUntil: (promise) => kept.push(promise) };
  let blip;
  let server;
  let base;
  let logged;
  before(async () => {
    const original = console.log;
    logged = [];
    console.log = (...args) => logged.push(args.join(' '));
    try {
      blip = createVercelApp({
        VERCEL: '1',
        VERCEL_ENV: 'preview',
        VERCEL_BRANCH_URL: 'blip-git-main-team.vercel.app',
        MONGODB_URI: await testMongoUri(),
        MONGODB_DB: dbName,
      }, functions);
    } finally {
      console.log = original;
    }
    ({ server, base } = await listen(blip.app));
  });
  after(async () => {
    server?.close();
    await blip?.close();
    await dropTestDatabase(dbName);
  });

  it('opens the database with the first request, in a small pool handed to attachDatabasePool', async () => {
    assert.equal(attached.length, 0, 'loading the function opens nothing: an instance can be suspended between requests');
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal(attached.length, 1, 'the client is handed over as soon as it exists');
    const [client] = attached;
    assert.ok(client instanceof MongoClient);
    assert.equal(client.options.maxPoolSize, VERCEL_MONGO_CLIENT_OPTIONS.maxPoolSize);
    assert.ok(client.options.maxPoolSize <= 10);
    assert.equal(client.options.maxIdleTimeMS, VERCEL_MONGO_CLIENT_OPTIONS.maxIdleTimeMS);
    assert.ok(client.options.maxIdleTimeMS > 0 && client.options.maxIdleTimeMS <= 10_000, 'idle connections are closed soon, so an instance is not kept for long');
    for (const option of ['serverSelectionTimeoutMS', 'connectTimeoutMS', 'socketTimeoutMS', 'waitQueueTimeoutMS']) {
      assert.ok(client.options[option] > 0 && client.options[option] <= 8000, `${option} is bounded: ${client.options[option]}`);
    }
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal(attached.length, 1, 'one client per instance');
    await blip.ready;
  });

  it('uses the database it was given and logs where it is, nothing more', async () => {
    assert.equal(blip.db.name, dbName);
    assert.equal(blip.config.mongodbDb, dbName);
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(`database: mongodb://127\\.0\\.0\\.1:\\d+, ${dbName}`));
  });

  it('logs a connection string without its credentials', async () => {
    const original = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    let other;
    try {
      other = createVercelApp({ VERCEL: '1', MONGODB_URI: 'mongodb://blip-user:hunter2-not-for-logs@127.0.0.1:9/?directConnection=true', MONGODB_DB: 'blip_test_unused' }, functions);
    } finally {
      console.log = original;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /database: mongodb:\/\/127\.0\.0\.1:9, blip_test_unused/);
    assert.ok(!lines[0].includes('hunter2') && !lines[0].includes('blip-user'));
    await other.close();
    assert.equal(attached.length, 1, 'an instance nobody sent a request to never connected');
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
    kept.length = 0;
    const first = await visit('203.0.113.7', { 'x-vercel-ip-country': 'BR', 'x-vercel-ip-city': 'S%C3%A3o%20Paulo', 'cf-ipcountry': 'FR' });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get('location'), 'https://example.com/on-vercel');
    assert.equal((await visit('198.51.100.9')).status, 302);

    // Each click row is stored after its redirect, and handed to waitUntil, which keeps the function
    // running until it is written.
    assert.equal(kept.length, 2, 'one write per visit, kept alive by waitUntil');
    assert.deepEqual(await Promise.all(kept), [true, true], 'and both are stored');
    const stats = await (await fetch(`${base}/api/links/on-vercel/stats?range=all`, { headers: { 'X-Manage-Token': manageToken } })).json();
    assert.equal(stats.totals.clicks, 2);
    assert.equal(stats.totals.uniqueVisitors, 2, 'two forwarded client IPs are two visitors');
    assert.deepEqual(stats.countries.map((c) => c.code), ['BR']);
    assert.equal(stats.recent.find((c) => c.country === 'BR').city, 'São Paulo');
    assert.equal((await fetch(`${base}/api/links/on-vercel`, { headers: { 'X-Manage-Token': manageToken } }).then((r) => r.json())).link.clickCount, 2);
  });

  it('needs none of the driver optional packages to connect, write and read', () => {
    const packages = loadedPackages(createRequire(import.meta.url).cache);
    assert.ok(packages.includes('mongodb') && packages.includes('@vercel/functions'));
    for (const name of NEVER_LOADED) assert.ok(!packages.includes(name), `${name} is not loaded`);
  });
});

describe('createVercelApp under vercel dev (VERCEL not set)', () => {
  it('behaves like a local run: rows stored before the answer, the pool left alone', async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const attached = [];
    const kept = [];
    const dbName = freshDatabaseName();
    const blip = createVercelApp({ MONGODB_URI: await testMongoUri(), MONGODB_DB: dbName }, { attachDatabasePool: (client) => attached.push(client), waitUntil: (promise) => kept.push(promise) });
    const { server, base } = await listen(blip.app);
    try {
      assert.match(String(warnings.mock.calls[0]?.arguments[0]), /VERCEL is not set, so Blip uses its local defaults/);
      const created = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUrl: 'https://example.com/dev', slug: 'on-vercel-dev' }) });
      const { manageToken } = await created.json();
      assert.equal((await fetch(`${base}/on-vercel-dev`, { redirect: 'manual', headers: { 'User-Agent': UA.iphone } })).status, 302);
      const stats = await (await fetch(`${base}/api/links/on-vercel-dev/stats?range=all`, { headers: { 'X-Manage-Token': manageToken } })).json();
      assert.equal(stats.totals.clicks, 1, 'the row was stored before the redirect');
      assert.equal(kept.length, 1, 'the row was still handed to waitUntil, which has no request to extend here');
      assert.equal(attached.length, 0, 'attachDatabasePool is for Vercel only');
      assert.equal(blip.config.onVercel, false);
    } finally {
      server.close();
      await blip.close();
      await dropTestDatabase(dbName);
    }
  });
});

describe('createVercelApp with the real @vercel/functions', () => {
  it('hands the pool over without complaint, and does nothing more off Vercel', async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const errors = t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
    const dbName = freshDatabaseName();
    const blip = createVercelApp({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'blip-test.vercel.app', MONGODB_URI: await testMongoUri(), MONGODB_DB: dbName });
    const { server, base } = await listen(blip.app);
    try {
      const created = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUrl: 'https://example.com/real', slug: 'real-functions' }) });
      assert.equal(created.status, 201);
      assert.equal((await fetch(`${base}/real-functions`, { redirect: 'manual', headers: { 'User-Agent': UA.iphone } })).status, 302);
      // Off Vercel's runtime waitUntil has no request to extend, and the row is stored all the same.
      const deadline = Date.now() + 5000;
      while (await blip.db.collection('clicks').countDocuments({}) === 0) {
        assert.ok(Date.now() < deadline, 'the click row is stored');
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      assert.equal(errors.mock.callCount(), 0, errors.mock.calls.map((c) => c.arguments.join(' ')).join('\n'));
      assert.equal(warnings.mock.callCount(), 0, 'attachDatabasePool accepted the MongoClient');
    } finally {
      server.close();
      await blip.close();
      await dropTestDatabase(dbName);
    }
  });
});

describe('createVercelApp when Vercel cannot take the pool', () => {
  it('logs it once and serves every request all the same', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
    const dbName = freshDatabaseName();
    const kept = [];
    const blip = createVercelApp({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'blip-test.vercel.app', MONGODB_URI: await testMongoUri(), MONGODB_DB: dbName }, {
      attachDatabasePool: () => {
        throw new Error('Unsupported database pool type');
      },
      waitUntil: (promise) => kept.push(promise),
    });
    const { server, base } = await listen(blip.app);
    try {
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
      const created = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUrl: 'https://example.com/pool', slug: 'pool-refused' }) });
      assert.equal(created.status, 201);
      assert.equal((await fetch(`${base}/pool-refused`, { redirect: 'manual', headers: { 'User-Agent': UA.iphone } })).status, 302);
      assert.deepEqual(await Promise.all(kept), [true], 'the click row is stored');
      assert.equal(errors.mock.callCount(), 1);
      assert.equal(errors.mock.calls[0].arguments[0], '[blip] could not hand the database pool to Vercel (Unsupported database pool type); idle connections stay open while an instance is suspended');
    } finally {
      server.close();
      await blip.close();
      await dropTestDatabase(dbName);
    }
  });
});

describe("Vercel's request contexts", () => {
  // Vercel's runtime keeps each request's context (its waitUntil) in async local storage, which
  // @vercel/functions reads through this symbol: attachDatabasePool registers its wait for idle
  // connections with the request that checked a connection out.
  const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

  it("keep each request's connections with that request, and a live stream's polls with the stream, whichever request wakes it", async (t) => {
    t.mock.method(console, 'warn', () => {}); // closing the client checks a connection out outside any request
    const als = new AsyncLocalStorage();
    const saved = { context: globalThis[REQUEST_CONTEXT], url: process.env.VERCEL_URL, region: process.env.VERCEL_REGION };
    globalThis[REQUEST_CONTEXT] = { get: () => als.getStore() };
    // attachDatabasePool only waits on Vercel's runtime, which it recognises by these two.
    process.env.VERCEL_URL = 'blip-test.vercel.app';
    process.env.VERCEL_REGION = 'iad1';
    const registered = []; // the request each waitUntil call was made in
    const dbName = freshDatabaseName();
    const blip = createApp({
      config: { mongodbUri: await testMongoUri(), mongodbDb: dbName, baseUrl: 'http://localhost:3030', streamPollMs: 100 },
      // Vercel's pool, with a shorter idle time, so attachDatabasePool's waits stay short here.
      mongoClientOptions: { ...VERCEL_MONGO_CLIENT_OPTIONS, maxIdleTimeMS: 200 },
      onDatabaseClient: (client) => attachDatabasePool(client),
      waitUntil,
      connectOnFirstRequest: true,
    });
    const server = http.createServer((req, res) => {
      const label = req.headers['x-label'] ?? 'unlabelled';
      als.run({ waitUntil: () => registered.push(label) }, () => blip.app(req, res));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    /** Who the connection checkouts of the next few polls were registered with. */
    const nextPolls = async () => {
      registered.length = 0;
      await sleep(450);
      return [...registered];
    };
    let stream;
    try {
      const created = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-label': 'create' }, body: JSON.stringify({ targetUrl: 'https://example.com/contexts', slug: 'contexts' }) });
      assert.equal(created.status, 201);
      const { manageToken } = await created.json();
      assert.ok(registered.length > 0, 'a checkout keeps its request alive until the pool has closed the idle connection');
      assert.deepEqual([...new Set(registered)], ['create'], 'the start-up and the create, both inside the first request');

      stream = await openStream(base, 'contexts', manageToken, { headers: { 'x-label': 'stream' } });
      await stream.next((e) => e.event === 'hello');
      assert.deepEqual([...new Set(await nextPolls())], ['stream']);

      // A visit on the same instance wakes the stream from inside its own handler...
      const visit = await fetch(`${base}/contexts`, { redirect: 'manual', headers: { 'User-Agent': UA.iphone, 'x-label': 'visit' } });
      assert.equal(visit.status, 302);
      await stream.next((e) => e.event === 'click');
      const afterVisit = await nextPolls();
      assert.ok(afterVisit.length > 0, 'the stream kept polling');
      assert.deepEqual([...new Set(afterVisit)], ['stream'], 'its polls never keep the visit (long answered) alive');

      // ...and so does a PATCH.
      const patched = await fetch(`${base}/api/links/contexts`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Manage-Token': manageToken, 'x-label': 'patch' }, body: JSON.stringify({ maxClicks: 50 }) });
      assert.equal(patched.status, 200);
      await stream.next((e) => e.event === 'status' && e.data.clicksRemaining === 49); // the poll the PATCH woke
      const afterPatch = await nextPolls();
      assert.ok(afterPatch.length > 0);
      assert.deepEqual([...new Set(afterPatch)], ['stream']);
    } finally {
      stream?.close();
      blip.endStreams();
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
      await blip.close();
      if (saved.context === undefined) delete globalThis[REQUEST_CONTEXT];
      else globalThis[REQUEST_CONTEXT] = saved.context;
      for (const [name, value] of [['VERCEL_URL', saved.url], ['VERCEL_REGION', saved.region]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await dropTestDatabase(dbName);
    }
  });
});
