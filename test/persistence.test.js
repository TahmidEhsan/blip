import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatabase, deleteLink, ensureIpHashSalt, insertClick, migrate, migrateLegacyThemeIds, openDatabase, sha256Hex,
} from '../server/db.js';
import { PROJECT_ROOT, loadConfig, resolveConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { effectiveDomain, toLinkDto } from '../server/links.js';
import { START_TIME, assertPlainCopy, removeTempDir, startServer } from './helpers.js';
import { QR_PRESETS } from '../public/assets/js/qr-shared.js';

/** The flat comic look a preset id stands for, as a stored qrStyle (no label). */
const flatLook = (id, extra = {}) => {
  const { label, ...look } = QR_PRESETS[id];
  return { ...look, caption: null, ...extra };
};

const EXPECTED_INDEXES = ['idx_clicks_link_counted', 'idx_clicks_link_real_ts', 'idx_clicks_link_ts', 'idx_clicks_link_visitor'];
const schemaVersion = async (db) => (await db.get("SELECT value FROM meta WHERE key = 'schema_version'"))?.value ?? null;
const count = async (db, sql, args) => (await db.get(sql, args)).n;

/** Everything a migration could touch: the schema, meta and every link row. */
const snapshot = async (db) => ({
  schema: await db.all("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"),
  meta: await db.all('SELECT key, value FROM meta ORDER BY key'),
  links: await db.all('SELECT * FROM links ORDER BY id'),
});

/** A database at schema version 1 as the first release left it: no meta.schema_version, user_version 1. */
async function makeFirstReleaseDatabase(file, rows) {
  const v1 = await openDatabase(file);
  await v1.batch([
    "DELETE FROM meta WHERE key = 'schema_version'",
    ...rows.map(([slug, theme, qrStyle]) => ({
      sql: `INSERT INTO links (slug, domain, target_url, manage_token_hash, teaser_theme, qr_style, created_at, updated_at)
            VALUES (?, 'localhost:3030', 'https://example.com/', 'abc', ?, ?, 1, 1)`,
      args: [slug, theme, qrStyle],
    })),
  ], 'write');
  await v1.execute('PRAGMA user_version = 1');
  v1.close();
}

describe('file databases', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-test-'));
  });
  after(() => removeTempDir(dir));

  it('reopening an existing database is idempotent and keeps data, indexes and the salt', async () => {
    const file = path.join(dir, 'nested', 'reopen.db');
    const first = await openDatabase(file);
    const salt = await ensureIpHashSalt(first, null);
    await first.run(`INSERT INTO links (slug, domain, target_url, manage_token_hash, created_at, updated_at)
                     VALUES ('kept', 'localhost:3030', 'https://example.com/', 'abc', 1, 1)`);
    first.close();

    for (let i = 0; i < 2; i += 1) {
      const again = await openDatabase(file);
      try {
        assert.equal(await schemaVersion(again), '2');
        assert.equal((await again.get('PRAGMA journal_mode')).journal_mode, 'wal');
        const indexes = await again.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'clicks' AND name LIKE 'idx_%' ORDER BY name");
        assert.deepEqual(indexes.map((r) => r.name), EXPECTED_INDEXES);
        assert.equal(await count(again, 'SELECT COUNT(*) AS n FROM links'), 1);
        assert.equal(await ensureIpHashSalt(again, null), salt, 'the generated salt is persisted once');
      } finally {
        again.close();
      }
    }
  });

  it('migrates a first-release database to the comic theme and preset ids, once', async () => {
    const file = path.join(dir, 'first-release.db');
    const style = (preset, extra = {}) => JSON.stringify({ preset, dotColor: '#111111', ...extra });
    const rows = [
      // slug, stored theme, stored qr_style, expected theme, expected preset (undefined = qr_style untouched)
      ['a', 'aurora', style('aurora', { dotColor2: '#d62828', gradientType: 'linear' }), 'hero', 'hero'],
      ['b', 'sunset', style('sunset'), 'caption', 'pop'],
      ['c', 'ocean', style('ocean'), 'sky', 'sky'],
      ['d', 'neon', style('mono'), 'noir', 'ink'],
      ['e', 'candy', style('candy'), 'paper', 'caption'],
      ['f', 'hero', style('forest'), 'hero', 'press'],
      ['g', 'plaid', null, 'hero', undefined],
      ['h', 'sky', '{not json', 'sky', undefined],
      ['i', 'noir', style('custom'), 'noir', undefined],
      ['j', 'paper', style('neon'), 'paper', 'noir'],
      // A caption and a centre logo the user picked survive; the preset's own old logo becomes the new preset's.
      ['k', 'hero', style('aurora', { dotType: 'rounded', logo: 'cat', caption: 'Scan me' }), 'hero', 'hero'],
      ['l', 'noir', style('neon', { logo: 'bolt' }), 'noir', 'noir'],
    ];
    const expectedStyle = {
      k: flatLook('hero', { logo: 'cat', caption: 'Scan me' }),
      l: flatLook('noir', { logo: 'star' }),
    };
    await makeFirstReleaseDatabase(file, rows);

    const db = await openDatabase(file);
    try {
      assert.equal(await schemaVersion(db), '2');
      for (const [slug, , qrStyle, theme, preset] of rows) {
        const row = await db.get('SELECT teaser_theme, qr_style, updated_at FROM links WHERE slug = ?', [slug]);
        assert.equal(row.teaser_theme, theme, `${slug}: teaser theme`);
        if (preset === undefined) assert.equal(row.qr_style, qrStyle, `${slug}: qr_style untouched`);
        else assert.deepEqual(JSON.parse(row.qr_style), expectedStyle[slug] || flatLook(preset), `${slug}: the old look becomes the new preset's flat look`);
        assert.equal(row.updated_at, 1, `${slug}: a migration is not an edit`);
      }
      assert.deepEqual(await migrateLegacyThemeIds(db), { teaserThemes: 0, qrPresets: 0 }, 'running it again changes nothing');
    } finally {
      db.close();
    }
    const reopened = await openDatabase(file);
    try {
      assert.equal(await schemaVersion(reopened), '2');
      assert.equal(await count(reopened, "SELECT COUNT(*) AS n FROM links WHERE teaser_theme NOT IN ('hero','caption','noir','sky','paper')"), 0);
    } finally {
      reopened.close();
    }
  });

  it('running the migrations twice in a row is a no-op', async () => {
    const file = path.join(dir, 'twice.db');
    await makeFirstReleaseDatabase(file, [['legacy', 'aurora', JSON.stringify({ preset: 'sunset' })], ['fine', 'sky', null]]);
    const db = createDatabase({ url: loadConfig({ DB_PATH: file }).databaseUrl });
    try {
      assert.deepEqual(await migrate(db), { from: 1, to: 2 });
      const once = await snapshot(db);
      assert.deepEqual(await migrate(db), { from: 2, to: 2 }, 'the second run finds nothing to do');
      assert.deepEqual(await snapshot(db), once, 'and changes nothing');
      assert.equal(once.meta.find((m) => m.key === 'schema_version').value, '2');
      assert.equal(once.links.find((l) => l.slug === 'legacy').teaser_theme, 'hero');
    } finally {
      db.close();
    }
  });

  it('two instances migrating the same database at once apply each change once and agree on the salt', async () => {
    const file = path.join(dir, 'cold-start.db');
    const legacy = [['p', 'aurora', JSON.stringify({ preset: 'aurora' })], ['q', 'neon', JSON.stringify({ preset: 'mono' })], ['r', 'sky', null]];
    await makeFirstReleaseDatabase(file, legacy);
    const url = loadConfig({ DB_PATH: file }).databaseUrl;
    const a = createDatabase({ url });
    const b = createDatabase({ url });
    try {
      // Both read the same legacy rows before either writes; the guarded writes keep the second one a no-op.
      const [ra, rb] = await Promise.all([migrateLegacyThemeIds(a), migrateLegacyThemeIds(b)]);
      assert.equal(ra.teaserThemes + rb.teaserThemes, 2, 'each legacy theme is rewritten once');
      assert.equal(ra.qrPresets + rb.qrPresets, 2, 'each legacy QR style is rewritten once');
      const [ma, mb] = await Promise.all([migrate(a), migrate(b)]);
      assert.equal(ma.to, 2);
      assert.equal(mb.to, 2);
      const [saltA, saltB] = await Promise.all([ensureIpHashSalt(a, null), ensureIpHashSalt(b, null)]);
      assert.equal(saltA, saltB, 'the first salt written wins and both instances use it');
      assert.match(saltA, /^[0-9a-f]{64}$/);
      const rows = await a.all('SELECT slug, teaser_theme, qr_style FROM links ORDER BY slug');
      assert.deepEqual(rows.map((r) => r.teaser_theme), ['hero', 'noir', 'sky']);
      assert.deepEqual(rows.map((r) => r.qr_style && JSON.parse(r.qr_style).preset), ['hero', 'ink', null]);
      assert.equal(await schemaVersion(b), '2');
    } finally {
      a.close();
      b.close();
    }
  });

  it('new databases default teaser_theme to hero', async () => {
    const db = await openDatabase(':memory:');
    try {
      await db.run(`INSERT INTO links (slug, domain, target_url, manage_token_hash, created_at, updated_at)
                    VALUES ('fresh', 'localhost:3030', 'https://example.com/', 'abc', 1, 1)`);
      assert.equal((await db.get('SELECT teaser_theme FROM links')).teaser_theme, 'hero');
      assert.equal(await schemaVersion(db), '2');
    } finally {
      db.close();
    }
  });

  it('DB_PATH works as an absolute path and as a path relative to the project', async () => {
    const absolute = path.join(dir, 'odd #1 folder', 'abs path.db');
    const relative = path.relative(PROJECT_ROOT, path.join(dir, 'relative', 'rel.db'));
    for (const [dbPath, expected] of [[absolute, absolute], [relative, path.join(dir, 'relative', 'rel.db')]]) {
      const config = loadConfig({ DB_PATH: dbPath });
      assert.match(config.databaseUrl, /^file:\/\/\//, dbPath);
      const s = await startServer({ config: { dbPath: config.dbPath } });
      try {
        assert.equal(s.config.databaseUrl, config.databaseUrl);
        await s.createLink({ targetUrl: 'https://example.com/where', slug: 'where' });
        assert.ok(fs.existsSync(expected), `the database file is at ${expected}`);
      } finally {
        await s.stop();
      }
    }
  });

  it('links made under an old base URL keep a working short URL after PORT/BASE_URL changes', async () => {
    const dbPath = path.join(dir, 'moved.db');
    const original = await startServer({ config: { dbPath, baseUrl: 'http://localhost:3030', domains: ['cat.ly'] } });
    const moved = await original.createLink({ targetUrl: 'https://example.com/moved', slug: 'moved' });
    const meow = await original.createLink({ targetUrl: 'https://example.com/meow', slug: 'meow', domain: 'cat.ly' });
    assert.equal(moved.link.domain, 'localhost:3030');
    await original.stop();

    const s = await startServer({ config: { dbPath, baseUrl: 'http://localhost:4000', domains: ['go.to'] } });
    try {
      const { json } = await s.request('GET', '/api/links/moved', { token: moved.manageToken });
      assert.equal(json.link.domain, 'localhost:4000');
      assert.equal(json.link.domainLive, true);
      assert.equal(json.link.shortUrl, 'http://localhost:4000/moved');
      assert.equal(json.link.workingUrl, 'http://localhost:4000/moved');
      assert.equal(json.link.qrUrl, 'http://localhost:4000/moved');

      // A vanity domain dropped from DOMAINS falls back the same way (no https URL to a host we don't serve).
      const batch = await s.request('POST', '/api/links/batch', { body: { items: [{ slug: 'meow', token: meow.manageToken }] } });
      const vanity = batch.json.results[0].link;
      assert.equal(vanity.domain, 'localhost:4000');
      assert.equal(vanity.shortUrl, 'http://localhost:4000/meow');
      assert.equal(vanity.domainLive, true);

      // Clients that echo the stored legacy domain back get a 200, and the row is normalised.
      const echoed = await s.request('PATCH', '/api/links/moved', { token: moved.manageToken, body: { domain: 'localhost:3030', title: 'Moved' } });
      assert.equal(echoed.status, 200);
      assert.equal(echoed.json.link.domain, 'localhost:4000');
      assert.equal(echoed.json.link.title, 'Moved');
      assert.equal((await s.db.get('SELECT domain FROM links WHERE slug = ?', ['moved'])).domain, 'localhost:4000');
      // But an unknown domain that isn't the link's own stored one is still rejected.
      const unknown = await s.request('PATCH', '/api/links/moved', { token: moved.manageToken, body: { domain: 'localhost:3030' } });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.json.error.field, 'domain');
      const newVanity = await s.request('PATCH', '/api/links/meow', { token: meow.manageToken, body: { domain: 'go.to' } });
      assert.equal(newVanity.json.link.shortUrl, 'https://go.to/meow');

      assert.equal((await s.visit('moved')).status, 302, 'the link itself kept working all along');
    } finally {
      await s.stop();
    }
  });
});

// The v2 schema exactly as the node:sqlite builds created it (frozen here on purpose).
const NODE_SQLITE_V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, domain TEXT NOT NULL, target_url TEXT NOT NULL,
  title TEXT, manage_token_hash TEXT NOT NULL,
  redirect_mode TEXT NOT NULL DEFAULT 'instant' CHECK (redirect_mode IN ('instant','teaser')),
  teaser_seconds INTEGER NOT NULL DEFAULT 5,
  teaser_style TEXT NOT NULL DEFAULT 'countdown' CHECK (teaser_style IN ('countdown','trivia','brand')),
  teaser_message TEXT, teaser_theme TEXT NOT NULL DEFAULT 'hero', expires_at INTEGER, max_clicks INTEGER,
  click_count INTEGER NOT NULL DEFAULT 0, destroyed_at INTEGER, qr_style TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, visitor_hash TEXT, is_unique INTEGER NOT NULL DEFAULT 0, country TEXT, region TEXT, city TEXT,
  lat REAL, lon REAL, device TEXT NOT NULL DEFAULT 'desktop', browser TEXT, os TEXT, referrer_host TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0, is_synthetic INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'redirect' CHECK (outcome IN ('redirect','teaser','expired','bot-preview'))
);
CREATE INDEX IF NOT EXISTS idx_clicks_link_ts ON clicks(link_id, ts);
CREATE INDEX IF NOT EXISTS idx_clicks_link_visitor ON clicks(link_id, visitor_hash);
CREATE INDEX IF NOT EXISTS idx_clicks_link_counted ON clicks(link_id, visitor_hash) WHERE outcome IN ('redirect','teaser') AND is_bot = 0;
CREATE INDEX IF NOT EXISTS idx_clicks_link_real_ts ON clicks(link_id, ts) WHERE outcome IN ('redirect','teaser') AND is_bot = 0 AND is_synthetic = 0;
`;

// Runs in a child process with the old engine, opened the way the old openDatabase() did. The files are
// copied while the database is still open, like copying a running server's data folder: everything
// written so far is still in blip.db-wal, and blip.db holds little more than its header.
const NODE_SQLITE_WRITER = `
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.BLIP_FIXTURE_DIR;
const live = path.join(dir, 'live', 'blip.db');
fs.mkdirSync(path.dirname(live), { recursive: true });
const db = new DatabaseSync(live);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
db.exec(process.env.BLIP_FIXTURE_SCHEMA);
db.exec('PRAGMA user_version = 2');
db.prepare("INSERT INTO meta (key, value) VALUES ('ip_hash_salt', 'salt-from-node-sqlite')").run();
const { lastInsertRowid: id } = db.prepare(
  "INSERT INTO links (slug, domain, target_url, manage_token_hash, teaser_theme, max_clicks, click_count, created_at, updated_at) " +
  "VALUES ('old-friend', 'localhost:3030', 'https://example.com/old', ?, 'sky', 10, 2, ?, ?)"
).run(process.env.BLIP_FIXTURE_TOKEN_HASH, Number(process.env.BLIP_FIXTURE_TS), Number(process.env.BLIP_FIXTURE_TS));
const click = db.prepare("INSERT INTO clicks (link_id, ts, visitor_hash, is_unique, device, browser, outcome) VALUES (?, ?, 'aaaaaaaaaaaaaaaaaaaaaaaa', ?, 'desktop', 'Chrome', 'redirect')");
click.run(id, Number(process.env.BLIP_FIXTURE_TS), 1);
click.run(id, Number(process.env.BLIP_FIXTURE_TS) + 1000, 0);
for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(live + suffix, path.join(dir, 'blip.db' + suffix));
db.close();
`;

describe('a database written by the node:sqlite build', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-old-'));
  });
  after(() => removeTempDir(dir));

  it('opens a v2 copy (data still in its WAL) without losing anything', async (t) => {
    const token = 'old-manage-token';
    const written = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', NODE_SQLITE_WRITER], {
      env: {
        ...process.env,
        BLIP_FIXTURE_DIR: dir,
        BLIP_FIXTURE_SCHEMA: NODE_SQLITE_V2_SCHEMA,
        BLIP_FIXTURE_TOKEN_HASH: sha256Hex(token),
        BLIP_FIXTURE_TS: String(START_TIME - 3_600_000),
      },
      encoding: 'utf8',
    });
    if (written.status !== 0 && /ERR_UNKNOWN_BUILTIN_MODULE/.test(written.stderr)) {
      t.skip('node:sqlite is not available in this Node.js');
      return;
    }
    assert.equal(written.status, 0, written.stderr);
    const file = path.join(dir, 'blip.db');
    assert.ok(fs.statSync(`${file}-wal`).size > fs.statSync(file).size, 'most of the copy is still in blip.db-wal');

    const s = await startServer({ config: { dbPath: file } });
    try {
      const { status, json } = await s.request('GET', '/api/links/old-friend', { token });
      assert.equal(status, 200);
      assert.equal(json.link.targetUrl, 'https://example.com/old');
      assert.equal(json.link.teaser.theme, 'sky');
      assert.equal(json.link.clickCount, 2);
      assert.equal(json.link.clicksRemaining, 8);
      const stats = await s.request('GET', '/api/links/old-friend/stats?range=all', { token });
      assert.equal(stats.json.totals.clicks, 2);
      assert.equal(stats.json.totals.uniqueVisitors, 1);
      assert.equal((await s.visit('old-friend')).status, 302);
      assert.equal((await s.db.get("SELECT value FROM meta WHERE key = 'ip_hash_salt'")).value, 'salt-from-node-sqlite', 'the salt is kept, so visitor hashes still match');
      assert.equal(await schemaVersion(s.db), '2', 'the version moved from PRAGMA user_version into meta');
      assert.equal((await s.db.get('PRAGMA user_version')).user_version, 2, 'user_version is left as it was');
    } finally {
      await s.stop();
    }

    const again = await startServer({ config: { dbPath: file } });
    try {
      const { json } = await again.request('GET', '/api/links/old-friend', { token });
      assert.equal(json.link.clickCount, 3, 'the visit made after the switch was saved');
      assert.equal(await count(again.db, 'SELECT COUNT(*) AS n FROM clicks'), 3);
    } finally {
      await again.stop();
    }
  });
});

describe('remote-safe data rules', () => {
  it('deleting a link removes its clicks without relying on foreign keys', async () => {
    const db = await openDatabase(':memory:');
    try {
      await db.execute('PRAGMA foreign_keys = OFF'); // as on a connection that does not enforce them
      const link = await db.get(`INSERT INTO links (slug, domain, target_url, manage_token_hash, created_at, updated_at)
                                 VALUES ('short-lived', 'localhost:3030', 'https://example.com/', 'abc', 1, 1) RETURNING id`);
      for (let i = 0; i < 3; i += 1) await insertClick(db, { link_id: link.id, ts: i, visitor_hash: `v${i}`, device: 'desktop', outcome: 'redirect' });
      assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM clicks'), 3);
      assert.equal(await deleteLink(db, link.id), 1);
      assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM links'), 0);
      assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM clicks'), 0, 'no orphaned clicks are left behind');
      // A visit recorded after its link is gone stores nothing either.
      await assert.rejects(insertClick(db, { link_id: link.id, ts: 9, visitor_hash: 'late', outcome: 'redirect' }), /no longer exists/);
      assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM clicks'), 0);
    } finally {
      db.close();
    }
  });

  it('decides is_unique inside the insert, so a repeat visitor is never unique twice', async () => {
    const db = await openDatabase(':memory:');
    try {
      const link = await db.get(`INSERT INTO links (slug, domain, target_url, manage_token_hash, created_at, updated_at)
                                 VALUES ('repeat', 'localhost:3030', 'https://example.com/', 'abc', 1, 1) RETURNING id`);
      const visit = (hash, extra = {}) => insertClick(db, { link_id: link.id, ts: 1, visitor_hash: hash, device: 'desktop', outcome: 'redirect', ...extra });
      const rows = await Promise.all([visit('same'), visit('same'), visit('same', { is_bot: 1 }), visit('other'), visit(null)]);
      assert.deepEqual(rows.map((r) => r.is_unique), [1, 0, 0, 1, 0]);
      assert.ok(rows.every((r) => Number.isInteger(r.id) && typeof r.ts === 'number'), 'plain numbers, never BigInt');
    } finally {
      db.close();
    }
  });
});

describe('toLinkDto with a legacy stored domain', () => {
  const row = {
    id: 1, slug: 'legacy', domain: 'localhost:3030', target_url: 'https://example.com/', title: null, manage_token_hash: 'x',
    redirect_mode: 'instant', teaser_seconds: 5, teaser_style: 'countdown', teaser_message: null, teaser_theme: 'aurora',
    expires_at: null, max_clicks: null, click_count: 0, destroyed_at: null, qr_style: null, created_at: START_TIME, updated_at: START_TIME,
  };

  it('maps an unknown stored domain to the current base host', () => {
    const config = resolveConfig({ baseUrl: 'http://localhost:4000', dbPath: ':memory:', domains: ['cat.ly'], liveDomains: [] });
    const dto = toLinkDto(row, config, START_TIME);
    assert.equal(dto.domain, 'localhost:4000');
    assert.equal(dto.domainLive, true);
    assert.equal(dto.shortUrl, 'http://localhost:4000/legacy');
    assert.equal(dto.shortUrl, dto.workingUrl);
    assert.equal(dto.qrUrl, dto.workingUrl);
    assert.equal(effectiveDomain({ domain: 'cat.ly' }, config), 'cat.ly', 'configured vanity domains are kept');
    assert.equal(toLinkDto({ ...row, domain: 'cat.ly' }, config, START_TIME).shortUrl, 'https://cat.ly/legacy');
  });

  it('reports first-release theme and preset ids under their new names', () => {
    const config = resolveConfig({ dbPath: ':memory:' });
    const dto = toLinkDto({ ...row, qr_style: JSON.stringify({ preset: 'candy', logo: 'heart' }) }, config, START_TIME);
    assert.equal(dto.teaser.theme, 'hero', 'aurora is served as hero');
    assert.deepEqual(dto.qrStyle, flatLook('caption', { logo: 'heart' }), 'candy becomes the flat caption look, keeping the logo the user picked');
    assert.equal(toLinkDto({ ...row, teaser_theme: 'candy' }, config, START_TIME).teaser.theme, 'paper');
    assert.equal(toLinkDto({ ...row, teaser_theme: 'sky' }, config, START_TIME).teaser.theme, 'sky');
    assert.equal(toLinkDto({ ...row, qr_style: '{"logo":"cat"}' }, config, START_TIME).qrStyle.preset, undefined, 'a style without a preset stays without one');
  });
});

describe('start-up', () => {
  /** Listen on an ephemeral port without waiting for `ready`, like a cold serverless start. */
  async function listen(instance) {
    const server = instance.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  }

  it('requests that arrive before the database is ready wait for it', async () => {
    const instance = createApp({ config: { dbPath: ':memory:' } });
    const { server, base } = await listen(instance);
    try {
      const res = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUrl: 'https://example.com/cold' }) });
      assert.equal(res.status, 201);
      await instance.ready;
    } finally {
      server.close();
      await instance.close();
    }
  });

  it('a database that cannot be opened rejects `ready` and answers 503 until it can', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-broken-'));
    const blocker = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocker, 'a file where the data folder should be');
    const errors = t.mock.method(console, 'error', () => {});
    const instance = createApp({ config: { dbPath: path.join(blocker, 'blip.db') } });
    await assert.rejects(instance.ready);
    const { server, base } = await listen(instance);
    try {
      for (let i = 0; i < 2; i += 1) {
        const res = await fetch(`${base}/api/health`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('retry-after'), '5');
        const body = await res.json();
        assert.equal(body.error.code, 'unavailable');
        assertPlainCopy(body.error.message, 'the 503 message');
      }
      assert.equal(errors.mock.callCount(), 2, 'each failed attempt is logged once');
      assert.match(String(errors.mock.calls[0].arguments[0]), /could not open the database/);
      assert.equal((await fetch(`${base}/favicon.svg`)).status, 200, 'static files never wait for the database');
      const page = await fetch(`${base}/some-short-link`, { headers: { Accept: 'text/html' } });
      assert.equal(page.status, 503, 'a visitor opening a short link gets the 503 page');
      assert.equal(page.headers.get('retry-after'), '5');
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.match(page.headers.get('content-type'), /^text\/html/);
      assert.match(await page.text(), /Blip can’t reach its database right now/);
    } finally {
      server.close();
      await instance.close();
      await removeTempDir(dir);
    }
  });
});

describe('shutdown', () => {
  it('close() closes the database, and tolerates one that is already closed', async () => {
    const s = await startServer();
    await s.stop();
    await assert.rejects(s.db.get('SELECT 1'), /closed/i, 'the database is closed');
    await assert.doesNotReject(s.close(), 'a second close() is a no-op');

    const closedElsewhere = await startServer();
    closedElsewhere.db.close();
    await assert.doesNotReject(closedElsewhere.stop());
  });

  it('close() is safe while the database is still starting up', async () => {
    const instance = createApp({ config: { dbPath: ':memory:' } });
    await instance.close();
    await assert.rejects(instance.ready, /closed/i, 'start-up stops instead of using a closed database');
    await assert.doesNotReject(instance.close());
  });
});
