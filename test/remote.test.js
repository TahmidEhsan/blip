// A remote database over HTTP, the way production talks to Turso: @libsql/client/web against a local
// Hrana server (test/hrana-shim.js). Covers the full create, visit, stats and live-stream round trip,
// how many round trips a visit costs, and what visitors get while the database fails or stops answering.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATABASE_UNAVAILABLE_MESSAGE, createApp } from '../server/app.js';
import { insertLink, isDatabaseUnavailable, isUniqueViolation } from '../server/db.js';
import { CLICK_WRITE_BUDGET_MS } from '../server/routes/redirect.js';
import { UA, assertPlainCopy, blipData, openStream, removeTempDir, startServer } from './helpers.js';
import { loadNodeSqlite, startHranaServer } from './hrana-shim.js';

const sqlite = await loadNodeSqlite();
const skip = sqlite ? false : 'node:sqlite is not available in this Node build';
const TOKEN = 'remote-test-token-123';
const PAGE = { Accept: 'text/html', 'User-Agent': UA.windowsChrome };

/** Statements that write or take the write lock. */
const WRITE_RE = /^(BEGIN IMMEDIATE|CREATE|INSERT|UPDATE|DELETE)\b/i;

describe('a remote libSQL database over HTTP', { skip }, () => {
  let dir;
  let shim;
  let s;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-remote-'));
    shim = await startHranaServer({ file: path.join(dir, 'remote.db'), sqlite });
    s = await startServer({ config: { databaseUrl: shim.url, databaseAuthToken: TOKEN }, databaseTimeoutMs: 400 });
  });
  after(async () => {
    shim.state.mode = 'ok';
    shim.state.hangWhen = null;
    await s?.stop();
    await shim?.close();
    await removeTempDir(dir);
  });

  it('sends the auth token and creates the schema over HTTP', () => {
    assert.equal(s.db.local, false);
    assert.equal(shim.state.authorization, `Bearer ${TOKEN}`);
    assert.ok(shim.state.sql.some((sql) => /^CREATE TABLE IF NOT EXISTS links/.test(sql)));
  });

  it('creates, visits and counts links, in two round trips per visit', async () => {
    const { link, manageToken } = await s.createLink({ targetUrl: 'https://example.com/remote', slug: 'remote' });
    assert.equal(link.slug, 'remote');
    const words = await s.createLink({ targetUrl: 'https://example.com/words' });
    assert.match(words.link.slug, /^[a-z]+-[a-z]+$/, 'a word slug, checked for availability over HTTP');

    const before = shim.state.pipelines;
    const res = await s.visit('remote');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/remote');
    assert.equal(shim.state.pipelines - before, 2, 'look up, then consume and store the click in one batch');

    const stats = await s.request('GET', '/api/links/remote/stats?range=all', { token: manageToken });
    assert.equal(stats.status, 200);
    assert.equal(stats.json.totals.clicks, 1);
    assert.equal(stats.json.recent.length, 1);
    assert.ok(stats.json.throughClickId >= stats.json.recent[0].id, 'the snapshot covers the stored click');

    const batch = await s.request('POST', '/api/links/batch', { body: { items: [{ slug: 'remote', token: manageToken }, { slug: words.link.slug, token: 'nope' }] } });
    assert.deepEqual(batch.json.results.map((r) => r.error), [null, 'forbidden']);
  });

  it('lets exactly one visit take the last click', async () => {
    await s.createLink({ targetUrl: 'https://example.com/once', slug: 'once', maxClicks: 1 });
    const visits = await Promise.all([s.visit('once'), s.visit('once'), s.visit('once')]);
    assert.deepEqual(visits.map((v) => v.status).sort(), [302, 410, 410]);
    const rows = await s.db.all("SELECT outcome FROM clicks WHERE link_id = (SELECT id FROM links WHERE slug = 'once') ORDER BY id");
    assert.deepEqual(rows.map((r) => r.outcome).sort(), ['expired', 'expired', 'redirect'], 'a lost race stores its blocked attempt only');
    const page = await s.visit('once', { headers: { Accept: 'text/html' } });
    assert.equal(page.status, 410);
    assert.equal(blipData(page.text).reason, 'clicks');
  });

  it('reports a duplicate slug as a unique violation over HTTP', async () => {
    const created = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/dupe', slug: 'remote' } });
    assert.equal(created.status, 409);
    assert.equal(created.json.error.code, 'slug_taken');
    const row = {
      slug: 'remote', domain: 'localhost:3030', target_url: 'https://example.com/x', manage_token_hash: 'x', redirect_mode: 'instant',
      teaser_seconds: 5, teaser_style: 'countdown', teaser_theme: 'hero', created_at: 1, updated_at: 1,
    };
    await assert.rejects(insertLink(s.db, row), (err) => isUniqueViolation(err) && !isDatabaseUnavailable(err));
  });

  it('streams a visit to the live dashboard', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/live', slug: 'live-remote' });
    const stream = await openStream(s.base, 'live-remote', manageToken);
    try {
      assert.equal(stream.status, 200);
      const hello = await stream.next((e) => e.event === 'hello');
      assert.equal(hello.data.totals.clicks, 0);
      assert.equal((await s.visit('live-remote', { ua: UA.iphone })).status, 302);
      const click = await stream.next((e) => e.event === 'click');
      assert.equal(click.data.device, 'mobile');
      assert.equal(click.data.totals.clicks, 1);
    } finally {
      stream.close();
    }
  });

  it('answers 503 while the database returns errors, without leaking the token, then recovers', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/flaky', slug: 'flaky' });
    shim.state.mode = 'fail';
    try {
      const page = await s.visit('flaky', { headers: PAGE });
      assert.equal(page.status, 503);
      assert.match(page.headers.get('content-type'), /^text\/html/);
      assert.equal(page.headers.get('retry-after'), '5');
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.equal(page.headers.get('x-robots-tag'), 'noindex');
      assert.match(page.text, /Blip can’t reach its database right now/);
      assertPlainCopy(page.text, 'the 503 page');

      const stats = await s.request('GET', '/api/links/flaky/stats', { token: manageToken });
      assert.equal(stats.status, 503);
      assert.equal(stats.headers.get('retry-after'), '5');
      assert.deepEqual(stats.json, { error: { code: 'unavailable', message: DATABASE_UNAVAILABLE_MESSAGE } });
    } finally {
      shim.state.mode = 'ok';
    }
    const logged = errors.mock.calls.map((c) => c.arguments.join(' '));
    assert.ok(logged.length >= 2);
    assert.ok(logged.every((line) => /database request failed \(http:\/\/127\.0\.0\.1:\d+\)/.test(line)), logged.join('\n'));
    assert.ok(logged.every((line) => !line.includes(TOKEN)));
    assert.equal((await s.visit('flaky')).status, 302, 'the next request after the outage works');
  });

  it('gives up on a database that stops answering instead of hanging the visit', async (t) => {
    t.mock.method(console, 'error', () => {});
    await s.createLink({ targetUrl: 'https://example.com/stall', slug: 'stall' });
    shim.state.mode = 'hang';
    try {
      const started = performance.now();
      await assert.rejects(s.db.get('SELECT 1 AS x'), (err) => err.name === 'TimeoutError' && isDatabaseUnavailable(err));
      const page = await s.visit('stall', { headers: PAGE });
      const elapsed = performance.now() - started;
      assert.equal(page.status, 503);
      assert.match(page.text, /Blip can’t reach its database right now/);
      assert.ok(elapsed < 3000, `took ${elapsed.toFixed(0)} ms`);
    } finally {
      shim.state.mode = 'ok';
    }
    assert.equal((await s.visit('stall')).status, 302, 'the client is still usable afterwards');
  });
});

describe('a slow analytics write on a remote database', { skip }, () => {
  let dir;
  let shim;
  let s;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-remote-slow-'));
    shim = await startHranaServer({ file: path.join(dir, 'remote.db'), sqlite });
    s = await startServer({ config: { databaseUrl: shim.url }, databaseTimeoutMs: 5000 });
  });
  after(async () => {
    shim.state.hangWhen = null;
    await s?.stop();
    await shim?.close();
    await removeTempDir(dir);
  });

  it('never holds back a blocked visit for longer than its budget', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    await s.createLink({ targetUrl: 'https://example.com/gone-time', slug: 'gone-time', expiresInSeconds: 60 });
    s.advance(120_000);
    shim.state.hangWhen = (texts) => texts.some((sql) => /INSERT INTO clicks/.test(sql));
    const started = performance.now();
    const res = await s.visit('gone-time', { headers: PAGE });
    const elapsed = performance.now() - started;
    shim.state.hangWhen = null;
    assert.equal(res.status, 410);
    assert.ok(elapsed >= CLICK_WRITE_BUDGET_MS - 50 && elapsed < CLICK_WRITE_BUDGET_MS + 2000, `took ${elapsed.toFixed(0)} ms`);
    assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), /recording a visit to \/gone-time is slow/);
  });
});

describe('starting up against a remote database', { skip }, () => {
  let dir;
  let shim;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-remote-start-'));
    shim = await startHranaServer({ file: path.join(dir, 'remote.db'), sqlite });
  });
  after(async () => {
    shim.state.mode = 'ok';
    await shim?.close();
    await removeTempDir(dir);
  });

  async function listen(instance) {
    const server = instance.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  }

  it('gives up on a start-up that takes too long, answers 503 and tries again on the next request', async (t) => {
    t.mock.method(console, 'error', () => {});
    shim.state.mode = 'hang';
    const started = performance.now();
    const instance = createApp({ config: { databaseUrl: shim.url }, databaseTimeoutMs: 10_000, startupTimeoutMs: 300 });
    const { server, base } = await listen(instance);
    try {
      await assert.rejects(instance.ready, (err) => err.name === 'TimeoutError' && isDatabaseUnavailable(err));
      assert.ok(performance.now() - started < 2000);
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, 'unavailable');
      shim.state.mode = 'ok';
      assert.equal((await fetch(`${base}/api/health`)).status, 200, 'the next attempt runs once the database answers');
    } finally {
      shim.state.mode = 'ok';
      server.closeAllConnections();
      server.close();
      await instance.close();
    }
  });

  it('only reads when the schema is already up to date', async () => {
    const first = createApp({ config: { databaseUrl: shim.url } });
    await first.ready;
    await first.close();
    const from = shim.state.sql.length;
    const second = createApp({ config: { databaseUrl: shim.url } });
    try {
      await second.ready;
      const run = shim.state.sql.slice(from);
      assert.ok(run.length > 0);
      assert.deepEqual(run.filter((sql) => WRITE_RE.test(sql)), [], 'no write lock and no DDL on a warm start');
    } finally {
      await second.close();
    }
  });
});
