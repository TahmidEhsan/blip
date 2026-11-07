import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  INDEXES, SCHEMA_VERSION, createDatabase, deleteLink, ensureIndexes, ensureIpHashSalt, insertClick, insertLink, prepareDatabase,
} from '../server/db.js';
import { resolveConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { LINK_DEFAULTS, effectiveDomain, toLinkDto } from '../server/links.js';
import {
  START_TIME, assertPlainCopy, closeTestDatabase, dropTestDatabase, freshDatabaseName, openTestDatabase, startServer, testMongoUri,
} from './helpers.js';
import { QR_PRESETS } from '../public/assets/js/qr-shared.js';

/** The flat comic look a preset id stands for, as a stored qrStyle (no label). */
const flatLook = (id, extra = {}) => {
  const { label, ...look } = QR_PRESETS[id];
  return { ...look, caption: null, ...extra };
};

const schemaVersion = async (db) => (await db.collection('meta').findOne({ _id: 'schema_version' }))?.value ?? null;

/** Every index by name, per collection (the ones INDEXES names, plus MongoDB's own `_id_`). */
async function indexNames(db) {
  const names = {};
  for (const collection of Object.keys(INDEXES)) {
    names[collection] = (await db.collection(collection).indexes()).map((index) => index.name).sort();
  }
  return names;
}

const EXPECTED_INDEXES = {
  links: ['_id_', 'id_unique', 'slug_unique'],
  clicks: ['_id_', 'id_unique', 'link_id', 'link_real_ts', 'link_ts_id'],
  visitors: ['_id_', 'link_visitor_unique'],
};

/** Everything preparing a database could touch: its indexes, meta and every link. */
const snapshot = async (db) => ({
  indexes: await indexNames(db),
  meta: await db.collection('meta').find({}).sort({ _id: 1 }).toArray(),
  links: await db.collection('links').find({}).sort({ id: 1 }).toArray(),
});

const LINK = {
  ...LINK_DEFAULTS, domain: 'localhost:3030', target_url: 'https://example.com/', manage_token_hash: 'abc', created_at: 1, updated_at: 1,
};

describe('preparing a database', () => {
  it('reopening an existing database is idempotent and keeps data, indexes and the salt', async () => {
    const uri = await testMongoUri();
    const dbName = freshDatabaseName();
    const open = async () => {
      const db = createDatabase({ uri, dbName });
      await prepareDatabase(db);
      return db;
    };
    const first = await open();
    const salt = await ensureIpHashSalt(first, null);
    await insertLink(first, { ...LINK, slug: 'kept' });
    await first.close();

    for (let i = 0; i < 2; i += 1) {
      const again = await open();
      try {
        assert.equal(await schemaVersion(again), SCHEMA_VERSION);
        assert.deepEqual(await indexNames(again), EXPECTED_INDEXES);
        assert.equal(await again.collection('links').countDocuments({}), 1);
        assert.equal(await ensureIpHashSalt(again, null), salt, 'the generated salt is persisted once');
      } finally {
        await again.close();
      }
    }
    await dropTestDatabase(dbName);
  });

  it('running it twice in a row is a no-op', async () => {
    const db = createDatabase({ uri: await testMongoUri(), dbName: freshDatabaseName() });
    try {
      assert.deepEqual(await ensureIndexes(db), { from: 0, to: SCHEMA_VERSION });
      await insertLink(db, { ...LINK, slug: 'present' });
      const once1 = await snapshot(db);
      assert.deepEqual(once1.indexes, EXPECTED_INDEXES);
      assert.deepEqual(await ensureIndexes(db), { from: SCHEMA_VERSION, to: SCHEMA_VERSION }, 'the second run finds nothing to do');
      assert.deepEqual(await snapshot(db), once1, 'and changes nothing');
    } finally {
      await closeTestDatabase(db);
    }
  });

  it('a collection dropped since the last start gets its indexes back on the next one', async () => {
    const uri = await testMongoUri();
    const dbName = freshDatabaseName();
    const first = createDatabase({ uri, dbName });
    try {
      await prepareDatabase(first);
      const link = await insertLink(first, { ...LINK, slug: 'reset-analytics' });
      await insertClick(first, { link_id: link.id, ts: 1, visitor_hash: 'v1', device: 'desktop', outcome: 'redirect' });
      // Analytics reset by hand in Atlas: both collections dropped, and clicks created again by the next
      // write, with nothing but its `_id_` index.
      await first.collection('clicks').drop();
      await first.collection('visitors').drop();
      await first.collection('clicks').insertOne({ id: 99, link_id: link.id, ts: 2 });
      assert.deepEqual((await first.collection('clicks').indexes()).map((index) => index.name), ['_id_']);
    } finally {
      await first.close();
    }

    const created = [];
    const again = createDatabase({
      uri,
      dbName,
      clientOptions: { monitorCommands: true },
      onClient: (client) => client.on('commandStarted', (e) => {
        if (e.commandName === 'createIndexes') created.push(e.command.createIndexes);
      }),
    });
    try {
      assert.deepEqual(await prepareDatabase(again), { from: SCHEMA_VERSION, to: SCHEMA_VERSION }, 'the schema version was current all along');
      assert.deepEqual(await indexNames(again), EXPECTED_INDEXES);
      assert.deepEqual(created.sort(), ['clicks', 'visitors'], 'only the collections that lacked indexes');
      created.length = 0;
      await prepareDatabase(again);
      assert.deepEqual(created, [], 'and the start after that only reads');
      await assert.rejects(again.collection('visitors').insertMany([{ link_id: 1, visitor_hash: 'x' }, { link_id: 1, visitor_hash: 'x' }]), /duplicate key/, 'the first-visit rule has its unique index again');
    } finally {
      await again.close();
      await dropTestDatabase(dbName);
    }
  });

  it('several instances starting at once all succeed and agree on the salt', async () => {
    const uri = await testMongoUri();
    const dbName = freshDatabaseName();
    const instances = Array.from({ length: 5 }, () => createDatabase({ uri, dbName }));
    try {
      const results = await Promise.all(instances.map(ensureIndexes));
      for (const result of results) assert.equal(result.to, SCHEMA_VERSION);
      assert.deepEqual(await indexNames(instances[0]), EXPECTED_INDEXES);
      assert.equal(await schemaVersion(instances[0]), SCHEMA_VERSION);
      const salts = await Promise.all(instances.map((db) => ensureIpHashSalt(db, null)));
      assert.equal(new Set(salts).size, 1, 'the first salt written wins and every instance uses it');
      assert.match(salts[0], /^[0-9a-f]{64}$/);
    } finally {
      await Promise.all(instances.map((db) => db.close()));
      await dropTestDatabase(dbName);
    }
  });

  it('a configured salt is used as it is and never stored', async () => {
    const db = await openTestDatabase();
    try {
      assert.equal(await ensureIpHashSalt(db, 'from-the-environment'), 'from-the-environment');
      assert.equal(await db.collection('meta').findOne({ _id: 'ip_hash_salt' }), null);
    } finally {
      await closeTestDatabase(db);
    }
  });

  it('new links default teaser_theme to hero', async () => {
    const db = await openTestDatabase();
    try {
      const { teaser_theme: theme } = await insertLink(db, { slug: 'fresh', domain: 'localhost:3030', target_url: 'https://example.com/', manage_token_hash: 'abc', created_at: 1, updated_at: 1 });
      assert.equal(theme, 'hero');
      assert.equal((await db.collection('links').findOne({ slug: 'fresh' })).teaser_theme, 'hero');
    } finally {
      await closeTestDatabase(db);
    }
  });
});

describe('links across restarts', () => {
  it('links made under an old base URL keep a working short URL after PORT/BASE_URL changes', async () => {
    const dbName = freshDatabaseName();
    const original = await startServer({ dbName, config: { baseUrl: 'http://localhost:3030', domains: ['cat.ly'] } });
    const moved = await original.createLink({ targetUrl: 'https://example.com/moved', slug: 'moved' });
    const meow = await original.createLink({ targetUrl: 'https://example.com/meow', slug: 'meow', domain: 'cat.ly' });
    assert.equal(moved.link.domain, 'localhost:3030');
    await original.stop();

    const s = await startServer({ dbName, config: { baseUrl: 'http://localhost:4000', domains: ['go.to'] } });
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

      // Clients that echo the stored legacy domain back get a 200, and the document is normalised.
      const echoed = await s.request('PATCH', '/api/links/moved', { token: moved.manageToken, body: { domain: 'localhost:3030', title: 'Moved' } });
      assert.equal(echoed.status, 200);
      assert.equal(echoed.json.link.domain, 'localhost:4000');
      assert.equal(echoed.json.link.title, 'Moved');
      assert.equal((await s.db.collection('links').findOne({ slug: 'moved' })).domain, 'localhost:4000');
      // But an unknown domain that isn't the link's own stored one is still rejected.
      const unknown = await s.request('PATCH', '/api/links/moved', { token: moved.manageToken, body: { domain: 'localhost:3030' } });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.json.error.field, 'domain');
      const newVanity = await s.request('PATCH', '/api/links/meow', { token: meow.manageToken, body: { domain: 'go.to' } });
      assert.equal(newVanity.json.link.shortUrl, 'https://go.to/meow');

      assert.equal((await s.visit('moved')).status, 302, 'the link itself kept working all along');
    } finally {
      await s.stop();
      await dropTestDatabase(dbName);
    }
  });
});

describe('clicks and the links they belong to', () => {
  let db;
  before(async () => {
    db = await openTestDatabase();
  });
  after(() => closeTestDatabase(db));

  it('deleting a link removes its clicks and visitors, and a click arriving afterwards stores nothing', async () => {
    const link = await insertLink(db, { ...LINK, slug: 'short-lived' });
    const other = await insertLink(db, { ...LINK, slug: 'stays' });
    for (let i = 0; i < 3; i += 1) await insertClick(db, { link_id: link.id, ts: i, visitor_hash: `v${i}`, device: 'desktop', outcome: 'redirect' });
    await insertClick(db, { link_id: other.id, ts: 1, visitor_hash: 'v0', device: 'desktop', outcome: 'redirect' });
    const count = (name, filter) => db.collection(name).countDocuments(filter);
    assert.equal(await count('clicks', { link_id: link.id }), 3);
    assert.equal(await count('visitors', { link_id: link.id }), 3);

    assert.equal(await deleteLink(db, link.id), 1);
    assert.equal(await count('links', { id: link.id }), 0);
    assert.equal(await count('clicks', { link_id: link.id }), 0, 'no orphaned clicks are left behind');
    assert.equal(await count('visitors', { link_id: link.id }), 0, 'no orphaned visitors either');
    assert.equal(await count('clicks', { link_id: other.id }), 1, 'other links keep theirs');
    assert.equal(await count('visitors', { link_id: other.id }), 1);
    assert.equal(await deleteLink(db, link.id), 0, 'deleting it again finds nothing');

    // A visit recorded after its link is gone stores nothing either.
    await assert.rejects(insertClick(db, { link_id: link.id, ts: 9, visitor_hash: 'late', outcome: 'redirect' }), /no longer exists/);
    assert.equal(await count('clicks', { link_id: link.id }), 0);
    assert.equal(await count('visitors', { link_id: link.id }), 0);
  });

  it('a repeat visitor is only ever unique once, and only a counted click can be first', async () => {
    const link = await insertLink(db, { ...LINK, slug: 'repeat' });
    const visit = (hash, extra = {}) => insertClick(db, { link_id: link.id, ts: 1, visitor_hash: hash, device: 'desktop', outcome: 'redirect', ...extra });
    const first = await visit('same');
    const second = await visit('same');
    const bot = await visit('bot-first', { is_bot: 1 });
    const blocked = await visit('blocked-first', { outcome: 'expired' });
    const other = await visit('other');
    const anonymous = await visit(null);
    assert.deepEqual([first, second, bot, blocked, other, anonymous].map((r) => r.is_unique), [1, 0, 0, 0, 1, 0]);
    assert.ok([first, other].every((r) => Number.isInteger(r.id) && typeof r.ts === 'number' && !('_id' in r)), 'plain numbers, and no _id');
    assert.equal((await visit('bot-first')).is_unique, 1, 'a bot or a blocked attempt before does not use up the first visit');
    assert.equal((await visit('blocked-first')).is_unique, 1);
  });
});

describe('toLinkDto with a legacy stored domain', () => {
  const row = {
    id: 1, slug: 'legacy', domain: 'localhost:3030', target_url: 'https://example.com/', title: null, manage_token_hash: 'x',
    redirect_mode: 'instant', teaser_seconds: 5, teaser_style: 'countdown', teaser_message: null, teaser_theme: 'aurora',
    expires_at: null, max_clicks: null, click_count: 0, destroyed_at: null, qr_style: null, created_at: START_TIME, updated_at: START_TIME,
  };

  it('maps an unknown stored domain to the current base host', () => {
    const config = resolveConfig({ baseUrl: 'http://localhost:4000', domains: ['cat.ly'], liveDomains: [] });
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
    const config = resolveConfig({});
    const dto = toLinkDto({ ...row, qr_style: JSON.stringify({ preset: 'candy', logo: 'heart' }) }, config, START_TIME);
    assert.equal(dto.teaser.theme, 'hero', 'aurora is served as hero');
    assert.deepEqual(dto.qrStyle, flatLook('caption', { logo: 'heart' }), 'candy becomes the flat caption look, keeping the logo the user picked');
    assert.equal(toLinkDto({ ...row, teaser_theme: 'candy' }, config, START_TIME).teaser.theme, 'paper');
    assert.equal(toLinkDto({ ...row, teaser_theme: 'sky' }, config, START_TIME).teaser.theme, 'sky');
    assert.equal(toLinkDto({ ...row, qr_style: '{"logo":"cat"}' }, config, START_TIME).qrStyle.preset, undefined, 'a style without a preset stays without one');
  });

  it('serves every first-release theme and QR style found in storage under the comic ids', () => {
    const config = resolveConfig({});
    const style = (preset, extra = {}) => JSON.stringify({ preset, dotColor: '#111111', ...extra });
    const stored = [
      // stored theme, stored qr_style, expected theme, expected qrStyle (undefined = kept as stored)
      ['aurora', style('aurora', { dotColor2: '#d62828', gradientType: 'linear' }), 'hero', flatLook('hero')],
      ['sunset', style('sunset'), 'caption', flatLook('pop')],
      ['ocean', style('ocean'), 'sky', flatLook('sky')],
      ['neon', style('mono'), 'noir', flatLook('ink')],
      ['candy', style('candy'), 'paper', flatLook('caption')],
      ['hero', style('forest'), 'hero', flatLook('press')],
      ['plaid', null, 'hero', null],
      ['sky', '{not json', 'sky', null],
      ['noir', style('custom'), 'noir', undefined],
      ['paper', style('neon'), 'paper', flatLook('noir')],
      // A caption and a centre logo the user picked survive; the preset's own old logo becomes the new preset's.
      ['hero', style('aurora', { dotType: 'rounded', logo: 'cat', caption: 'Scan me' }), 'hero', flatLook('hero', { logo: 'cat', caption: 'Scan me' })],
      ['noir', style('neon', { logo: 'bolt' }), 'noir', flatLook('noir', { logo: 'star' })],
    ];
    for (const [theme, qrStyle, expectedTheme, expectedStyle] of stored) {
      const dto = toLinkDto({ ...row, teaser_theme: theme, qr_style: qrStyle }, config, START_TIME);
      assert.equal(dto.teaser.theme, expectedTheme, `${theme}: teaser theme`);
      assert.deepEqual(dto.qrStyle, expectedStyle === undefined ? JSON.parse(qrStyle) : expectedStyle, `${qrStyle}: QR style`);
    }
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
    const mongodbDb = freshDatabaseName();
    const instance = createApp({ config: { mongodbUri: await testMongoUri(), mongodbDb } });
    const { server, base } = await listen(instance);
    try {
      const res = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUrl: 'https://example.com/cold' }) });
      assert.equal(res.status, 201);
      await instance.ready;
    } finally {
      server.close();
      await instance.close();
      await dropTestDatabase(mongodbDb);
    }
  });

  it('a database that cannot be reached rejects `ready` and answers 503 until it can', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    // Nothing listens on the discard port, so every attempt fails as soon as its time to find a server is up.
    const instance = createApp({ config: { mongodbUri: 'mongodb://127.0.0.1:9/?directConnection=true', mongodbDb: 'blip_test_unreachable' }, databaseTimeoutMs: 100 });
    await assert.rejects(instance.ready, (err) => err.name === 'MongoServerSelectionError');
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
    }
  });

  it('a malformed connection string answers 503 too, instead of crashing on start-up', async (t) => {
    t.mock.method(console, 'error', () => {});
    const instance = createApp({ config: { mongodbUri: 'mongodb://', mongodbDb: 'blip_test_malformed' } });
    await assert.rejects(instance.ready);
    const { server, base } = await listen(instance);
    try {
      assert.equal((await fetch(`${base}/api/health`)).status, 503);
    } finally {
      server.close();
      await instance.close();
    }
  });
});

describe('shutdown', () => {
  it('close() closes the database, and tolerates one that is already closed', async () => {
    const s = await startServer();
    const { db } = s;
    await s.stop();
    assert.equal(db.closed, true);
    assert.throws(() => db.collection('links'), /closed/i, 'the database is closed');
    await assert.doesNotReject(s.close(), 'a second close() is a no-op');

    const closedElsewhere = await startServer();
    await closedElsewhere.db.close();
    await assert.doesNotReject(closedElsewhere.stop());
  });

  it('close() is safe while the database is still starting up', async () => {
    const instance = createApp({ config: { mongodbUri: await testMongoUri(), mongodbDb: freshDatabaseName() } });
    await instance.close();
    await assert.rejects(instance.ready, /closed/i, 'start-up stops instead of using a closed database');
    await assert.doesNotReject(instance.close());
  });
});
