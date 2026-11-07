import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  INDEXES, SCHEMA_VERSION, createDatabase, databaseFailureHint, deleteLink, ensureIndexes, ensureIpHashSalt, indexConflictHint, insertClick, insertLink,
  prepareDatabase,
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

/**
 * Prepare a database, then leave it the way changes made by hand in Atlas can, so that two of its indexes
 * can't be built: two links share a slug (slug_unique was dropped first), and the fields of
 * link_visitor_unique sit under another name. On clicks, link_ts_id is gone (nothing stands in its way), and
 * `link_id` was made again on other fields: an index of that name is there, so it is left as it is.
 */
async function standInTheWay(uri, dbName) {
  const db = createDatabase({ uri, dbName });
  try {
    await prepareDatabase(db);
    await db.collection('links').dropIndex('slug_unique');
    await db.collection('links').insertMany([{ id: 50, slug: 'twin' }, { id: 51, slug: 'twin' }]);
    await db.collection('clicks').dropIndex('link_ts_id');
    await db.collection('clicks').dropIndex('link_id');
    await db.collection('clicks').createIndex({ link_id: 1, ts: -1 }, { name: 'link_id' });
    await db.collection('visitors').dropIndex('link_visitor_unique');
    await db.collection('visitors').createIndex({ link_id: 1, visitor_hash: 1 }, { name: 'by_hand', unique: true });
  } finally {
    await db.close();
  }
}
/** `[collection, index, server code]` of what standInTheWay leaves unbuildable: a duplicate key, and IndexOptionsConflict. */
const STOOD_IN_THE_WAY = [['links', 'slug_unique', 11000], ['visitors', 'link_visitor_unique', 85]];

/**
 * Prepare a database, then give two of its links one id, the way only changes made by hand in Atlas can
 * (id_unique dropped first, then documents copied in). Returns the slugs of the two.
 */
async function shareAnId(uri, dbName, id) {
  const db = createDatabase({ uri, dbName });
  try {
    await prepareDatabase(db);
    await db.collection('links').dropIndex('id_unique');
    await db.collection('links').insertMany([{ id, slug: `twin-${id}-a` }, { id, slug: `twin-${id}-b` }]);
    return [`twin-${id}-a`, `twin-${id}-b`];
  } finally {
    await db.close();
  }
}

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
      assert.deepEqual(await ensureIndexes(db), { from: 0, to: SCHEMA_VERSION, conflicts: [] });
      await insertLink(db, { ...LINK, slug: 'present' });
      const once1 = await snapshot(db);
      assert.deepEqual(once1.indexes, EXPECTED_INDEXES);
      assert.deepEqual(await ensureIndexes(db), { from: SCHEMA_VERSION, to: SCHEMA_VERSION, conflicts: [] }, 'the second run finds nothing to do');
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
        if (e.commandName === 'createIndexes') created.push(`${e.command.createIndexes} ${e.command.indexes.map((index) => index.name).join(' ')}`);
      }),
    });
    try {
      assert.deepEqual(await prepareDatabase(again), { from: SCHEMA_VERSION, to: SCHEMA_VERSION, conflicts: [] }, 'the schema version was current all along');
      assert.deepEqual(await indexNames(again), EXPECTED_INDEXES);
      assert.deepEqual(
        created.sort(),
        ['clicks id_unique link_id link_ts_id link_real_ts', 'links id_unique', 'visitors link_visitor_unique'],
        'only the collections that lacked indexes, and the essential index every start confirms',
      );
      created.length = 0;
      await prepareDatabase(again);
      assert.deepEqual(created, ['links id_unique'], 'and the start after that only reads, apart from that one');
      await assert.rejects(again.collection('visitors').insertMany([{ link_id: 1, visitor_hash: 'x' }, { link_id: 1, visitor_hash: 'x' }]), /duplicate key/, 'the first-visit rule has its unique index again');
    } finally {
      await again.close();
      await dropTestDatabase(dbName);
    }
  });

  it('a visitors collection that racing visits filled twice for one visitor keeps one and gets its unique index back', async () => {
    const uri = await testMongoUri();
    const dbName = freshDatabaseName();
    const first = createDatabase({ uri, dbName });
    let link;
    try {
      await prepareDatabase(first);
      link = await insertLink(first, { ...LINK, slug: 'raced-reset' });
      // Analytics reset by hand while an instance kept serving: with link_visitor_unique gone along with the
      // collection, two racing first visits by one visitor each stored a document.
      await first.collection('visitors').drop();
      await first.collection('visitors').insertMany([
        { link_id: link.id, visitor_hash: 'twice', is_synthetic: 0 },
        { link_id: link.id, visitor_hash: 'twice', is_synthetic: 0 },
        { link_id: link.id, visitor_hash: 'once', is_synthetic: 0 },
        { link_id: link.id + 1, visitor_hash: 'twice', is_synthetic: 0 },
      ]);
    } finally {
      await first.close();
    }
    const again = createDatabase({ uri, dbName });
    try {
      const [oldest] = await again.collection('visitors').find({ link_id: link.id, visitor_hash: 'twice' }).sort({ _id: 1 }).toArray();
      assert.deepEqual(await prepareDatabase(again), { from: SCHEMA_VERSION, to: SCHEMA_VERSION, conflicts: [] }, 'nothing left in the way');
      assert.deepEqual(await indexNames(again), EXPECTED_INDEXES);
      const left = await again.collection('visitors').find({}).sort({ link_id: 1, visitor_hash: 1 }).toArray();
      assert.deepEqual(left.map((v) => [v.link_id - link.id, v.visitor_hash]), [[0, 'once'], [0, 'twice'], [1, 'twice']], 'one document per link and visitor');
      assert.deepEqual(left[1]._id, oldest._id, 'the oldest one stays');
    } finally {
      await again.close();
      await dropTestDatabase(dbName);
    }
  });

  it('two links that share an id fail the start-up instead of being served, and the first start after the fix builds the index', async () => {
    const uri = await testMongoUri();
    const dbName = freshDatabaseName();
    const [, second] = await shareAnId(uri, dbName, 70);
    const again = createDatabase({ uri, dbName });
    try {
      await assert.rejects(prepareDatabase(again), (err) => {
        assert.equal(err.code, 'ESSENTIAL_INDEX');
        assert.equal(err.cause.code, 11000);
        assert.match(err.message, /^could not create the index id_unique of links, which Blip can't run without: .*E11000 duplicate key error .*dup key: \{ id: 70 \}/);
        assert.match(databaseFailureHint(err), /^Two links share an id, .* Blip can't start until then; on Vercel, every request that needs the database \(the API and short links\) answers 503 and tries again\.$/);
        assertPlainCopy(databaseFailureHint(err), 'the hint');
        return true;
      });
      assert.equal(await again.collection('links').countDocuments({ id: 70 }), 2, 'no link is ever removed to make room');
      assert.ok(!(await indexNames(again)).links.includes('id_unique'));

      await again.collection('links').updateOne({ slug: second }, { $set: { id: 71 } });
      assert.deepEqual((await prepareDatabase(again)).conflicts, []);
      assert.deepEqual((await indexNames(again)).links, EXPECTED_INDEXES.links);
    } finally {
      await again.close();
      await dropTestDatabase(dbName);
    }
  });

  it('the check of id_unique waits for its answer even when the connection string asks for no acknowledgement', async () => {
    const uri = await testMongoUri();
    const dbName = freshDatabaseName();
    await shareAnId(uri, dbName, 75);
    // w=0 makes the driver send a write and report success without a reply; the check must not be one.
    const again = createDatabase({ uri, dbName, clientOptions: { writeConcern: { w: 0 } } });
    try {
      await assert.rejects(prepareDatabase(again), (err) => err.code === 'ESSENTIAL_INDEX' && err.cause.code === 11000);
    } finally {
      await again.close();
      await dropTestDatabase(dbName);
    }
  });

  it('a start-up step waits for all of its commands, and names the essential index when another one failed too', async () => {
    const uri = await testMongoUri();
    const dbName = freshDatabaseName();
    await shareAnId(uri, dbName, 76);
    const again = createDatabase({ uri, dbName });
    // The read of the schema version fails too, after the essential index was refused: the step must wait
    // for it, and still report the refusal, which is what a person has to fix.
    let readSettled = false;
    const real = again.collection.bind(again);
    again.collection = (name) => {
      const collection = real(name);
      if (name !== 'meta') return collection;
      return new Proxy(collection, {
        get(target, prop) {
          if (prop === 'findOne') {
            return () => new Promise((resolve, reject) => {
              setTimeout(() => {
                readSettled = true;
                reject(Object.assign(new Error('the schema version could not be read'), { code: 'TEST_SLOW_FAILURE' }));
              }, 300);
            });
          }
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    try {
      await assert.rejects(prepareDatabase(again), (err) => {
        assert.equal(err.code, 'ESSENTIAL_INDEX', 'the refusal, not the other failure');
        assert.equal(readSettled, true, 'thrown only once every command of the step had settled');
        return true;
      });
    } finally {
      delete again.collection;
      await again.close();
      await dropTestDatabase(dbName);
    }
  });

  it('an index made by hand in the way of id_unique fails the start-up too, under that name or another', async () => {
    const uri = await testMongoUri();
    // listIndexes would show `id_unique` in the first case, so only the server can tell it isn't Blip's index:
    // not unique, no id would ever be refused. The second already keeps ids unique, under the name Atlas
    // suggests, and still stands in the way of Blip's own (85); dropping it is all the hint asks.
    const cases = [
      { name: 'id_unique', options: {}, code: 86 },
      { name: 'id_1', options: { unique: true }, code: 85 },
    ];
    for (const { name, options, code } of cases) {
      const dbName = freshDatabaseName();
      const first = createDatabase({ uri, dbName });
      try {
        await prepareDatabase(first);
        await first.collection('links').dropIndex('id_unique');
        await first.collection('links').createIndex({ id: 1 }, { name, ...options });
        await first.collection('links').insertMany([{ id: 90, slug: 'only-one' }, { id: 91, slug: 'another-one' }]);
      } finally {
        await first.close();
      }
      const again = createDatabase({ uri, dbName });
      try {
        await assert.rejects(prepareDatabase(again), (err) => {
          assert.equal(err.code, 'ESSENTIAL_INDEX', name);
          assert.equal(err.cause.code, code, name);
          assert.match(err.message, /^could not create the index id_unique of links, which Blip can't run without: /);
          assert.match(databaseFailureHint(err), /^An index made by hand stands in its way \(the message names it\): drop that one in Atlas\. Blip can't start until then; /);
          return true;
        });
        await again.collection('links').dropIndex(name);
        assert.deepEqual((await prepareDatabase(again)).conflicts, [], `${name}: the start after it is dropped builds Blip's own`);
        assert.deepEqual((await indexNames(again)).links, EXPECTED_INDEXES.links);
      } finally {
        await again.close();
        await dropTestDatabase(dbName);
      }
    }
  });

  it('an index the data or a hand-made index stands in the way of is reported, and every other one is built', async () => {
    const uri = await testMongoUri();
    const dbName = freshDatabaseName();
    await standInTheWay(uri, dbName);
    const sent = [];
    const again = createDatabase({
      uri,
      dbName,
      clientOptions: { monitorCommands: true },
      onClient: (client) => client.on('commandStarted', (e) => {
        if (e.commandName === 'createIndexes') sent.push(`${e.command.createIndexes} ${e.command.indexes.map((index) => index.name).join(' ')}`);
      }),
    });
    try {
      const { from, to, conflicts } = await prepareDatabase(again);
      assert.deepEqual([from, to], [SCHEMA_VERSION, SCHEMA_VERSION]);
      assert.deepEqual(conflicts.map((c) => [c.collection, c.index, c.error.code]).sort(), STOOD_IN_THE_WAY);
      assert.deepEqual(
        sent.sort(),
        ['clicks link_ts_id', 'links id_unique', 'links slug_unique', 'visitors link_visitor_unique'],
        'each sent once: a lone index that was refused is not built a second time',
      );
      const hint = (index) => indexConflictHint(conflicts.find((c) => c.index === index).error);
      assert.match(hint('slug_unique'), /remove the extra ones in Atlas, keeping one of each/);
      assert.match(hint('link_visitor_unique'), /An index made by hand stands in its way/);
      for (const index of ['slug_unique', 'link_visitor_unique']) assertPlainCopy(hint(index), 'the hint');
      const names = await indexNames(again);
      assert.ok(names.clicks.includes('link_ts_id'), 'the index nothing stood in the way of was built');
      assert.deepEqual((await again.collection('clicks').indexes()).find((index) => index.name === 'link_id').key, { link_id: 1, ts: -1 }, 'and one Blip did not make is left alone');
      assert.equal(await again.collection('links').countDocuments({ slug: 'twin' }), 2, 'no link is ever removed to make room');

      // Once the way is clear, the next start builds them.
      await again.collection('links').deleteOne({ id: 51 });
      await again.collection('visitors').dropIndex('by_hand');
      assert.deepEqual((await prepareDatabase(again)).conflicts, []);
      const rebuilt = await indexNames(again);
      assert.deepEqual([rebuilt.links, rebuilt.visitors], [EXPECTED_INDEXES.links, EXPECTED_INDEXES.visitors]);
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

  it('an index it cannot build is logged once, and Blip serves without building it on every request', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const uri = await testMongoUri();
    const mongodbDb = freshDatabaseName();
    await standInTheWay(uri, mongodbDb);
    let builds = 0;
    // Like a new instance on Vercel: the first request opens the database.
    const instance = createApp({
      config: { mongodbUri: uri, mongodbDb },
      connectOnFirstRequest: true,
      mongoClientOptions: { monitorCommands: true },
      onDatabaseClient: (client) => client.on('commandStarted', (e) => {
        if (e.commandName === 'createIndexes') builds += 1;
      }),
    });
    const { server, base } = await listen(instance);
    try {
      assert.equal((await fetch(`${base}/api/slugs/check?slug=after-the-reset`)).status, 200, 'not a 503');
      const afterStart = builds;
      assert.ok(afterStart > 0);
      const created = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUrl: 'https://example.com/still', slug: 'still-here' }) });
      assert.equal(created.status, 201);
      assert.equal((await fetch(`${base}/still-here`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0' } })).status, 302);
      assert.equal(builds, afterStart, 'later requests build nothing');
      const logged = errors.mock.calls.map((c) => String(c.arguments[0]));
      assert.equal(logged.length, STOOD_IN_THE_WAY.length, logged.join('\n'));
      for (const [collection, index] of STOOD_IN_THE_WAY) {
        assert.ok(logged.some((line) => line.startsWith(`[blip] could not create the index ${index} of ${collection} (database ${mongodbDb}): `) && line.endsWith('Until then Blip runs without it.')), `${index}: ${logged.join('\n')}`);
      }
      assert.ok(logged.every((line) => !/could not open the database/.test(line)));
    } finally {
      server.close();
      await instance.close();
      await dropTestDatabase(mongodbDb);
    }
  });

  it('an app whose links share an id answers 503 and says why on every request, and serves once they are fixed', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const uri = await testMongoUri();
    const mongodbDb = freshDatabaseName();
    const [first, second] = await shareAnId(uri, mongodbDb, 80);
    // Like a new instance on Vercel: the first request opens the database.
    const instance = createApp({ config: { mongodbUri: uri, mongodbDb }, connectOnFirstRequest: true });
    const { server, base } = await listen(instance);
    try {
      for (let i = 0; i < 2; i += 1) {
        const res = await fetch(`${base}/api/slugs/check?slug=anything`);
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('retry-after'), '5');
        assert.equal((await res.json()).error.code, 'unavailable');
      }
      const visit = await fetch(`${base}/${first}`, { redirect: 'manual', headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0' } });
      assert.equal(visit.status, 503, 'a visit never reaches either link');
      const logged = errors.mock.calls.map((c) => String(c.arguments[0]));
      assert.equal(logged.length, 3, `once for each request, which each try again: ${logged.join('\n')}`);
      for (const line of logged) {
        assert.ok(line.startsWith(`[blip] could not open the database (mongodb://127.0.0.1:`), line);
        assert.match(line, new RegExp(`database ${mongodbDb}\\): could not create the index id_unique of links, which Blip can't run without: .*E11000 duplicate key error .*\\. Two links share an id, `));
      }

      const fix = createDatabase({ uri, dbName: mongodbDb });
      try {
        await fix.collection('links').updateOne({ slug: second }, { $set: { id: 81 } });
      } finally {
        await fix.close();
      }
      assert.equal((await fetch(`${base}/api/slugs/check?slug=anything`)).status, 200, 'the next request builds the index and serves');
      assert.equal(errors.mock.calls.length, 3, 'and logs nothing more');
    } finally {
      server.close();
      await instance.close();
      await dropTestDatabase(mongodbDb);
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
