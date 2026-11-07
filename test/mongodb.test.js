// What Blip relies on MongoDB for, with no transactions: the atomic consume, first visits, id sequences,
// the delete cascade, index use, what a visit costs, what visitors get while the database fails or stalls
// (through a TCP proxy in front of the test server), and live streams that never lose or repeat a click.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MongoNetworkError, MongoNetworkTimeoutError, MongoServerError, MongoServerSelectionError } from 'mongodb';
import { DATABASE_UNAVAILABLE_MESSAGE, createApp } from '../server/app.js';
import { buildStats, liveStreamPoll, liveStreamSnapshot, liveTotals } from '../server/analytics.js';
import { wake } from '../server/bus.js';
import {
  COUNTED_CLICK_FILTER, allocateIds, consumeVisit, deleteLink, deleteSyntheticClicks, insertClick, insertClicks, insertLink, isDatabaseUnavailable, isUniqueViolation,
} from '../server/db.js';
import { STREAM_OVERLAP_IDS } from '../server/live.js';
import { LINK_DEFAULTS } from '../server/links.js';
import { CLICK_WRITE_BUDGET_MS } from '../server/routes/redirect.js';
import {
  UA, assertPlainCopy, clickRowsOf, closeTestDatabase, dropTestDatabase, freshDatabaseName, isLocalMongoUri, openStream, openTestDatabase, startServer, testAdminClient,
  testMongoUri,
} from './helpers.js';
import { startTcpProxy } from './tcp-proxy.js';

const PAGE = { Accept: 'text/html', 'User-Agent': UA.windowsChrome };
const LINK = { ...LINK_DEFAULTS, domain: 'localhost:3030', target_url: 'https://example.com/', manage_token_hash: 'abc', created_at: 1, updated_at: 1 };
const click = (link, extra = {}) => ({ link_id: link.id, ts: 1000, visitor_hash: 'someone', device: 'desktop', outcome: 'redirect', ...extra });

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** Run `check` until it answers something truthy (a recovering client needs a moment to find its server again). */
async function eventually(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition');
    await sleep(50);
  }
}

const DATA_COMMANDS = new Set(['aggregate', 'count', 'createIndexes', 'delete', 'find', 'findAndModify', 'getMore', 'insert', 'listIndexes', 'update']);

/** Which collection each $lookup of an aggregation reads, in pipeline order. */
const lookupsOf = (command) => command.pipeline.filter((stage) => stage.$lookup).map((stage) => `${stage.$lookup.from} as ${stage.$lookup.as}`);

/** A duplicate-key error as the server reports one for insertOne (`keyPattern` names the index's fields). */
const duplicateKey = (collection, field, value) => new MongoServerError({
  message: `E11000 duplicate key error collection: blip.${collection} index: ${field}_unique dup key: { ${field}: ${JSON.stringify(value)} }`,
  code: 11000,
  keyPattern: { [field]: 1 },
  keyValue: { [field]: value },
});

/** Client options that record every data command as `<command> <collection>`, with the commands themselves in `.raw`. */
function commandLog() {
  const log = {
    names: [],
    raw: [],
    clientOptions: { monitorCommands: true },
    onClient(client) {
      client.on('commandStarted', (event) => {
        if (!DATA_COMMANDS.has(event.commandName)) return;
        log.names.push(`${event.commandName} ${event.command[event.commandName]}`);
        log.raw.push(event.command);
      });
    },
    reset() {
      log.names.length = 0;
      log.raw.length = 0;
    },
  };
  return log;
}

/** Make one method of one collection behave differently until the returned function is called. */
function replaceCollectionMethod(db, collectionName, method, behaviour) {
  const real = Object.getPrototypeOf(db).collection.bind(db);
  db.collection = (name) => {
    const collection = real(name);
    if (name !== collectionName) return collection;
    return new Proxy(collection, {
      get(target, prop) {
        if (prop === method) return behaviour;
        return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
      },
    });
  };
  return () => {
    delete db.collection;
  };
}

describe('the data rules', () => {
  let db;
  before(async () => {
    db = await openTestDatabase();
  });
  after(() => closeTestDatabase(db));

  it('30 racing visits for 3 remaining clicks consume exactly 3', async () => {
    const link = await insertLink(db, { ...LINK, slug: 'race-3', max_clicks: 3 });
    const results = await Promise.all(Array.from({ length: 30 }, () => consumeVisit(db, link.id, 5000)));
    const consumed = results.filter((r) => r.consumed);
    assert.equal(consumed.length, 3);
    assert.deepEqual(consumed.map((r) => r.link.click_count).sort(), [1, 2, 3], 'each returned the link right after its own visit');
    assert.ok(results.filter((r) => !r.consumed).every((r) => r.link === null));
    assert.ok(consumed.every((r) => !('_id' in r.link) && r.link.updated_at === 5000));
    assert.equal((await db.collection('links').findOne({ id: link.id })).click_count, 3);
  });

  it('consumes only while the link is active', async () => {
    const consume = async (fields, now = 5000) => {
      const link = await insertLink(db, { ...LINK, slug: `guard-${Math.random().toString(36).slice(2)}`, ...fields });
      if ('destroyed_at' in fields) await db.collection('links').updateOne({ id: link.id }, { $set: { destroyed_at: fields.destroyed_at } });
      return (await consumeVisit(db, link.id, now)).consumed;
    };
    assert.equal(await consume({}), true, 'no limits');
    assert.equal(await consume({ max_clicks: 1 }), true);
    assert.equal(await consume({ expires_at: 5001 }), true, 'one millisecond left');
    assert.equal(await consume({ expires_at: 5000 }), false, 'expired at exactly now');
    assert.equal(await consume({ destroyed_at: 4000 }), false);
    assert.equal((await consumeVisit(db, 999_999, 5000)).consumed, false, 'a deleted link');
    const full = await insertLink(db, { ...LINK, slug: 'guard-full', max_clicks: 1 });
    assert.equal((await consumeVisit(db, full.id, 5000)).consumed, true);
    assert.equal((await consumeVisit(db, full.id, 5000)).consumed, false, 'used up');
    await db.collection('links').updateOne({ id: full.id }, { $set: { max_clicks: null } });
    assert.equal((await consumeVisit(db, full.id, 5000)).consumed, true, 'no longer limited');
  });

  it('25 racing first visits by one visitor make exactly one of them unique', async () => {
    const link = await insertLink(db, { ...LINK, slug: 'race-first' });
    const rows = await Promise.all(Array.from({ length: 25 }, () => insertClick(db, click(link))));
    assert.equal(rows.filter((r) => r.is_unique === 1).length, 1);
    assert.equal(new Set(rows.map((r) => r.id)).size, 25, 'every click got its own id');
    assert.equal(await db.collection('visitors').countDocuments({ link_id: link.id }), 1);
    assert.equal((await liveTotals(db, link.id)).uniqueVisitors, 1);
  });

  it('a batch of clicks decides first visits in row order, and against what is stored', async () => {
    const link = await insertLink(db, { ...LINK, slug: 'batch' });
    await insertClick(db, click(link, { visitor_hash: 'already-here' }));
    const rows = await insertClicks(db, [
      click(link, { visitor_hash: 'a' }), click(link, { visitor_hash: 'b' }), click(link, { visitor_hash: 'a' }), click(link, { visitor_hash: 'already-here' }),
      click(link, { visitor_hash: 'bot', is_bot: 1 }), click(link, { visitor_hash: null }), click(link, { visitor_hash: 'c', outcome: 'expired' }), click(link, { visitor_hash: 'c' }),
    ]);
    assert.deepEqual(rows.map((r) => r.is_unique), [1, 1, 0, 0, 0, 0, 0, 1]);
    for (let i = 1; i < rows.length; i += 1) assert.equal(rows[i].id, rows[i - 1].id + 1, 'consecutive ids in row order');
    assert.ok(rows.every((r) => !('_id' in r)));
    assert.deepEqual(await insertClicks(db, []), []);
    const again = await insertClicks(db, [click(link, { visitor_hash: 'a' }), click(link, { visitor_hash: 'd' })]);
    assert.deepEqual(again.map((r) => r.is_unique), [0, 1]);
  });

  it('a batch for a link that is gone stores nothing', async () => {
    const link = await insertLink(db, { ...LINK, slug: 'batch-gone' });
    await deleteLink(db, link.id);
    assert.deepEqual(await insertClicks(db, [click(link), click(link, { visitor_hash: 'other' })]), []);
    assert.equal(await db.collection('clicks').countDocuments({ link_id: link.id }), 0);
    assert.equal(await db.collection('visitors').countDocuments({ link_id: link.id }), 0);
  });

  it('a click that lands while its link is being deleted is removed, whichever comes first', async () => {
    for (let round = 0; round < 10; round += 1) {
      const link = await insertLink(db, { ...LINK, slug: `delete-race-${round}` });
      const results = await Promise.allSettled([
        insertClick(db, click(link)),
        deleteLink(db, link.id),
        insertClick(db, click(link, { visitor_hash: 'other' })),
      ]);
      assert.equal(results[1].status, 'fulfilled');
      assert.equal(await db.collection('clicks').countDocuments({ link_id: link.id }), 0, `round ${round}`);
      assert.equal(await db.collection('visitors').countDocuments({ link_id: link.id }), 0, `round ${round}`);
    }
  });

  it('id sequences hand out every id once, even on their very first racing upserts', async () => {
    const ids = await Promise.all(Array.from({ length: 40 }, () => allocateIds(db, 'race-test')));
    assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1));
    assert.equal(await allocateIds(db, 'race-test', 5), 41, 'the first id of a block');
    assert.equal(await allocateIds(db, 'race-test'), 46, 'and the next one follows it');
    assert.equal(await allocateIds(db, 'another-sequence'), 1, 'each sequence counts on its own');
  });

  it('a sequence that fell behind its collection catches up, so inserts carry on under free ids', async () => {
    const fresh = await openTestDatabase();
    try {
      const resetSequence = (name) => fresh.collection('counters').deleteOne({ _id: name }); // as if counters were emptied in Atlas
      const first = await insertLink(fresh, { ...LINK, slug: 'seq-first' });
      const second = await insertLink(fresh, { ...LINK, slug: 'seq-second' });
      await resetSequence('links');
      const third = await insertLink(fresh, { ...LINK, slug: 'seq-third' });
      assert.equal(third.id, second.id + 1, 'the next id above the stored ones');
      assert.equal((await fresh.collection('links').findOne({ slug: 'seq-third' })).id, third.id);
      assert.equal((await insertLink(fresh, { ...LINK, slug: 'seq-fourth' })).id, third.id + 1, 'and the sequence carries on from there');
      await assert.rejects(insertLink(fresh, { ...LINK, slug: 'seq-first' }), (err) => isUniqueViolation(err, 'slug'), 'a taken slug is still refused');

      const rows = [];
      for (let i = 0; i < 5; i += 1) rows.push(await insertClick(fresh, click(first, { visitor_hash: `seq-${i}` })));
      await resetSequence('clicks');
      const late = await insertClick(fresh, click(first, { visitor_hash: 'seq-late' }));
      assert.equal(late.id, rows.at(-1).id + 1);
      assert.equal(late.is_unique, 1);

      // A block whose first ids are free (their clicks were deleted) stores those, then numbers the rest anew.
      await fresh.collection('clicks').deleteMany({ id: { $in: [rows[0].id, rows[1].id] } });
      await resetSequence('clicks');
      const batch = await insertClicks(fresh, Array.from({ length: 4 }, (_, i) => click(second, { visitor_hash: `seq-batch-${i}` })));
      assert.deepEqual(batch.map((r) => r.id), [rows[0].id, rows[1].id, late.id + 1, late.id + 2]);
      const stored = await fresh.collection('clicks').find({ link_id: second.id }, { projection: { _id: 0, id: 1 } }).sort({ id: 1 }).toArray();
      assert.deepEqual(stored.map((r) => r.id), batch.map((r) => r.id), 'every row stored once, under the id it reports');
      const ids = (await fresh.collection('clicks').find({}, { projection: { _id: 0, id: 1 } }).toArray()).map((r) => r.id);
      assert.equal(ids.length, 8, 'three of the first five, the late one and the batch of four');
      assert.equal(new Set(ids).size, ids.length, 'no id is used twice');
    } finally {
      await closeTestDatabase(fresh);
    }
  });

  it('clearing simulated clicks removes them and their visitors, leaves real ones, and moves the epoch', async () => {
    const link = await insertLink(db, { ...LINK, slug: 'clear' });
    await insertClick(db, click(link, { visitor_hash: 'real' }));
    await insertClicks(db, [click(link, { visitor_hash: 's1', is_synthetic: 1 }), click(link, { visitor_hash: 's2', is_synthetic: 1 })]);
    const epoch = async () => (await db.collection('meta').findOne({ _id: 'clicks_epoch' }))?.value ?? null;
    const before1 = await epoch();
    assert.equal(await deleteSyntheticClicks(db, link.id), 2);
    assert.equal(await epoch(), (before1 ?? 0) + 1);
    assert.deepEqual((await clickRowsOf(db, 'clear')).map((r) => r.visitor_hash), ['real']);
    assert.deepEqual((await db.collection('visitors').find({ link_id: link.id }).toArray()).map((r) => r.visitor_hash), ['real']);
    const [again] = await insertClicks(db, [click(link, { visitor_hash: 's1', is_synthetic: 1 })]);
    assert.equal(again.is_unique, 1, 'a cleared visitor is new again');
  });

  it('unique indexes refuse a taken slug, a reused click id and a second visitor document', async () => {
    const link = await insertLink(db, { ...LINK, slug: 'taken' });
    const refused = (err) => isUniqueViolation(err) && !isDatabaseUnavailable(err);
    await assert.rejects(insertLink(db, { ...LINK, slug: 'taken' }), refused);
    const row = await insertClick(db, click(link));
    await assert.rejects(db.collection('clicks').insertOne({ ...row }), refused);
    await assert.rejects(db.collection('visitors').insertOne({ link_id: link.id, visitor_hash: 'someone' }), refused);
    await assert.rejects(db.collection('links').insertOne({ id: link.id, slug: 'another' }), refused);
  });
});

describe('a poll of the live stream', () => {
  let db;
  let link;
  let rows;
  before(async () => {
    db = await openTestDatabase();
    link = await insertLink(db, { ...LINK, slug: 'polled' });
    const other = await insertLink(db, { ...LINK, slug: 'other' });
    await insertClick(db, click(other));
    rows = await insertClicks(db, Array.from({ length: 5 }, (_, i) => click(link, { visitor_hash: `v${i}` })));
    await insertClick(db, click(other));
  });
  after(() => closeTestDatabase(db));

  const poll = (options) => liveStreamPoll(db, link.id, { afterId: 0, exclude: [], limit: 200, ...options });

  it('reads the link and its clicks in id order, never those of another link', async () => {
    const snap = await poll();
    assert.deepEqual(snap.rows.map((r) => r.id), rows.map((r) => r.id));
    assert.ok(snap.rows.every((r) => r.link_id === link.id && !('_id' in r)));
    assert.equal(snap.link.slug, 'polled');
    assert.equal(snap.link.id, link.id);
    assert.ok(!('_id' in snap.link) && !('rows' in snap.link) && !('epoch' in snap.link));
    assert.equal(snap.epoch, null);
  });

  it('pages, leaves out what it was told to, and reads the epoch', async () => {
    const page = await poll({ limit: 2 });
    assert.deepEqual(page.rows.map((r) => r.id), rows.slice(0, 2).map((r) => r.id));
    const skipping = await poll({ afterId: rows[0].id, exclude: [rows[2].id, rows[4].id] });
    assert.deepEqual(skipping.rows.map((r) => r.id), [rows[1].id, rows[3].id]);
    await deleteSyntheticClicks(db, link.id);
    assert.equal((await poll()).epoch, 1);
  });

  it('reports a deleted link', async () => {
    const gone = await insertLink(db, { ...LINK, slug: 'polled-gone' });
    await deleteLink(db, gone.id);
    assert.deepEqual(await liveStreamPoll(db, gone.id, { afterId: 0, exclude: [], limit: 200 }), { rows: [], link: null, epoch: null });
  });
});

describe('how the queries use the indexes', () => {
  const log = commandLog();
  let db;
  let link;
  before(async () => {
    db = await openTestDatabase({ clientOptions: log.clientOptions, onClient: log.onClient });
    link = await insertLink(db, { ...LINK, slug: 'planned', created_at: 1 });
    const other = await insertLink(db, { ...LINK, slug: 'neighbour', created_at: 1 });
    const rows = [];
    for (let i = 0; i < 600; i += 1) {
      rows.push(click(i % 3 === 0 ? other : link, {
        ts: 1000 + i * 1000, visitor_hash: `v${i % 50}`, country: 'GB', lat: 51.5, lon: -0.1, outcome: i > 400 ? 'expired' : 'redirect',
      }));
    }
    await insertClicks(db, rows.filter((r) => r.link_id === link.id));
    await insertClicks(db, rows.filter((r) => r.link_id === other.id));
  });
  after(() => closeTestDatabase(db));

  /** Explain the aggregation `run` sends, on the same pipeline it really uses. */
  async function explainAggregation(run) {
    log.reset();
    await run();
    const command = log.raw.find((c) => c.aggregate);
    const admin = await testAdminClient();
    const { stages } = await admin.db(db.name).command({ explain: { aggregate: command.aggregate, pipeline: command.pipeline, cursor: {} }, verbosity: 'executionStats' });
    return stages;
  }

  const assertNoScans = (stages) => {
    const cursor = stages.find((stage) => stage.$cursor).$cursor;
    assert.ok(!JSON.stringify(cursor.queryPlanner.winningPlan).includes('COLLSCAN'), 'the first stage uses an index');
    const lookups = stages.filter((stage) => stage.$lookup);
    for (const stage of lookups) assert.equal(stage.collectionScans, 0, `lookup ${stage.$lookup.as} uses an index`);
    return Object.fromEntries(lookups.map((stage) => [stage.$lookup.as, stage]));
  };

  /** The execution summary of a find: which plan stages ran, and how much it had to read. */
  async function planOf(cursor) {
    const explained = await cursor.explain('executionStats');
    const plan = JSON.stringify(explained.queryPlanner.winningPlan);
    return {
      stages: [...plan.matchAll(/"stage":"([A-Z_]+)"/g)].map((m) => m[1]),
      indexes: [...plan.matchAll(/"indexName":"([a-z_]+)"/g)].map((m) => m[1]),
      docs: explained.executionStats.totalDocsExamined,
    };
  }

  it('the stats read the window through an index, and what lies outside it without walking the history', async () => {
    const stages = await explainAggregation(() => buildStats(db, link, { range: 'all', now: 1_000_000 }));
    const lookups = assertNoScans(stages);
    assert.deepEqual(Object.keys(lookups), ['last24h', 'first', 'recent', 'mark']);
    assert.ok(lookups.recent.totalDocsExamined <= 25, 'the newest 25 clicks without a blocking sort');
    assert.equal(lookups.first.totalDocsExamined, 0, 'covered by the index');
    assert.equal(lookups.mark.totalDocsExamined, 0, 'covered by the index');
  });

  it('a poll that finds nothing new reads no click documents, however many ids it re-checks', async () => {
    const seen = (await db.collection('clicks').find({ link_id: link.id }, { projection: { _id: 0, id: 1 } }).toArray()).map((r) => r.id);
    const stages = await explainAggregation(() => liveStreamPoll(db, link.id, { afterId: 0, exclude: seen, limit: 200 }));
    const lookups = assertNoScans(stages);
    assert.equal(lookups.rows.totalDocsExamined, 0);
    assert.deepEqual(lookups.rows.indexesUsed, ['link_id']);
  });

  it("a stream's snapshot reads the link, the epoch and then the link's clicks, each through an index", async () => {
    const stages = await explainAggregation(() => liveStreamSnapshot(db, link.id, 1_000_000, STREAM_OVERLAP_IDS));
    const lookups = assertNoScans(stages);
    assert.deepEqual(Object.keys(lookups), ['epoch', 'snapshot', 'last24h'], 'the epoch before the clicks');
    const snap = await liveStreamSnapshot(db, link.id, 1_000_000, STREAM_OVERLAP_IDS);
    assert.equal(snap.link.slug, 'planned');
    assert.ok(!['_id', 'epoch', 'snapshot', 'last24h'].some((key) => key in snap.link));
    assert.equal(snap.totals.clicks, (await liveTotals(db, link.id)).clicks);
    assert.equal(snap.ids.length, (await db.collection('clicks').countDocuments({ link_id: link.id })), 'fewer clicks than the window: all of them');
    assert.deepEqual(await liveStreamSnapshot(db, 999_999, 1_000_000, STREAM_OVERLAP_IDS), {
      totals: { clicks: 0, uniqueVisitors: 0, botClicks: 0, blockedAfterExpiry: 0, expiredBotClicks: 0, last24h: 0, syntheticClicks: 0 },
      ids: [],
      link: null,
      epoch: null,
    }, 'a deleted link');
  });

  it('a link with many blocked attempts finds its last real visit without walking them', async () => {
    const plan = await planOf(db.collection('clicks').find({ link_id: link.id, ...COUNTED_CLICK_FILTER, is_synthetic: 0 }).sort({ ts: -1 }).limit(1).project({ _id: 0, ts: 1 }));
    assert.deepEqual(plan.indexes, ['link_real_ts']);
    assert.equal(plan.docs, 0);
    assert.ok(!plan.stages.includes('SORT'));
  });

  it('the link lookups are all on an index', async () => {
    for (const cursor of [
      db.collection('links').find({ slug: 'planned' }),
      db.collection('links').find({ slug: { $in: ['planned', 'neighbour', 'missing'] } }),
      db.collection('links').find({ id: link.id }),
    ]) {
      const plan = await planOf(cursor);
      assert.ok(plan.indexes.length === 1 && !plan.stages.includes('COLLSCAN'), JSON.stringify(plan));
    }
  });
});

describe('what a request costs', () => {
  const log = commandLog();
  let s;
  before(async () => {
    s = await startServer({ mongoClientOptions: log.clientOptions, onDatabaseClient: log.onClient, config: { streamPollMs: 50 } });
  });
  after(() => s.stop());

  it('a counted visit: look up, consume, id and visitor together, insert, check', async () => {
    await s.createLink({ targetUrl: 'https://example.com/costed', slug: 'costed', maxClicks: 5 });
    log.reset();
    assert.equal((await s.visit('costed')).status, 302);
    const { names } = log;
    assert.deepEqual(names.slice(0, 2), ['find links', 'findAndModify links']);
    assert.deepEqual(names.slice(2, 4).sort(), ['findAndModify counters', 'update visitors']);
    assert.deepEqual(names.slice(4), ['insert clicks', 'find links']);
  });

  it('a repeat visit costs the same, and a bot on an unlimited link never touches visitors or click_count', async () => {
    await s.createLink({ targetUrl: 'https://example.com/costed-bot', slug: 'costed-bot' });
    log.reset();
    assert.equal((await s.visit('costed-bot', { ua: UA.googlebot })).status, 302);
    assert.deepEqual(log.names, ['find links', 'findAndModify counters', 'insert clicks', 'find links']);
  });

  it('a HEAD and an unknown slug are one read', async () => {
    await s.createLink({ targetUrl: 'https://example.com/costed-head', slug: 'costed-head', maxClicks: 5 });
    log.reset();
    assert.equal((await s.visit('costed-head', { method: 'HEAD' })).status, 302);
    assert.deepEqual(log.names, ['find links']);
    log.reset();
    assert.equal((await s.visit('no-such-link')).status, 404);
    assert.deepEqual(log.names, ['find links']);
  });

  it('the stats are one aggregation after the token check', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/costed-stats', slug: 'costed-stats' });
    await s.visit('costed-stats');
    log.reset();
    assert.equal((await s.request('GET', '/api/links/costed-stats/stats?range=7d', { token: manageToken })).status, 200);
    assert.deepEqual(log.names, ['find links', 'aggregate clicks']);
  });

  it('a live stream makes one aggregation per poll, re-reading only ids it has not seen', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/costed-stream', slug: 'costed-stream' });
    await s.visit('costed-stream');
    log.reset();
    const stream = await openStream(s.base, 'costed-stream', manageToken);
    try {
      await stream.next((e) => e.event === 'hello');
      const [snapshot] = log.raw.filter((command) => command.aggregate);
      assert.equal(log.names[log.raw.indexOf(snapshot)], 'aggregate links', 'the snapshot is one aggregation too');
      // A Clear simulated deletes rows before it moves the epoch, so reading the epoch first can only ever
      // pair an old epoch with new rows, which the next poll recounts.
      assert.deepEqual(lookupsOf(snapshot), ['meta as epoch', 'clicks as snapshot', 'clicks as last24h'], 'the snapshot reads the epoch before the clicks');
      log.reset();
      await sleep(200);
      assert.ok(log.names.length >= 2, 'it polled');
      assert.deepEqual([...new Set(log.names)], ['aggregate links']);
      const poll = log.raw.at(-1);
      assert.deepEqual(lookupsOf(poll), ['meta as epoch', 'clicks as rows'], 'every poll reads the epoch before the clicks');
      const { $match } = poll.pipeline.find((stage) => stage.$lookup?.as === 'rows').$lookup.pipeline[0];
      assert.equal($match.id.$nin.length, 1, 'the click from before the stream opened is left out');
    } finally {
      stream.close();
    }
  });

  it('racing creates for one slug: one wins, the others get the same 409 as a taken slug', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/raced', slug: 'raced' } })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
    for (const res of results.filter((r) => r.status === 409)) {
      assert.deepEqual([res.json.error.code, res.json.error.field], ['slug_taken', 'slug']);
      assertPlainCopy(res.json.error.message, 'the slug_taken message');
    }
  });
});

describe('two instances on one database', () => {
  const dbName = freshDatabaseName();
  let a;
  let b;
  before(async () => {
    [a, b] = await Promise.all([startServer({ dbName }), startServer({ dbName })]);
  });
  after(async () => {
    await a?.stop();
    await b?.stop();
    await dropTestDatabase(dbName);
  });

  it('share the salt, so one visitor is one visitor on both', async () => {
    const { manageToken } = await a.createLink({ targetUrl: 'https://example.com/shared', slug: 'shared' });
    await a.visit('shared', { ua: UA.iphone });
    await b.visit('shared', { ua: UA.iphone });
    const { json } = await b.request('GET', '/api/links/shared/stats?range=all', { token: manageToken });
    assert.equal(json.totals.clicks, 2);
    assert.equal(json.totals.uniqueVisitors, 1);
    assert.deepEqual((await clickRowsOf(a.db, 'shared')).map((r) => r.is_unique), [1, 0]);
  });

  it('together consume exactly the clicks a link has left, and never reuse an id', async () => {
    await a.createLink({ targetUrl: 'https://example.com/split', slug: 'split', maxClicks: 3 });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).visit('split', { ua: `${UA.windowsChrome} r${i}` })));
    assert.equal(results.filter((r) => r.status === 302).length, 3);
    assert.equal(results.filter((r) => r.status === 410).length, 27);
    const rows = await clickRowsOf(b.db, 'split');
    assert.equal(rows.filter((r) => r.outcome === 'redirect').length, 3);
    assert.equal(rows.filter((r) => r.outcome === 'expired').length, 27);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
    assert.equal((await b.db.collection('links').findOne({ slug: 'split' })).click_count, 3);
  });
});

describe('ids that fell behind the stored documents', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.stop());

  /** As if the counters collection had been emptied in Atlas, or the documents copied in without it. */
  const resetSequence = (name) => s.db.collection('counters').deleteOne({ _id: name });

  it('a create still gets its free slug, a taken slug is still a 409, and clicks keep being stored', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/stored', slug: 'stored-first' });
    await resetSequence('links');
    const created = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/free', slug: 'definitely-free' } });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.link.slug, 'definitely-free');
    const taken = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/again', slug: 'stored-first' } });
    assert.deepEqual([taken.status, taken.json.error.code], [409, 'slug_taken']);

    assert.equal((await s.visit('stored-first')).status, 302);
    await resetSequence('clicks');
    assert.equal((await s.visit('stored-first', { ua: UA.iphone })).status, 302);
    await resetSequence('clicks');
    assert.equal((await s.request('POST', '/api/links/stored-first/simulate', { token: manageToken, body: { count: 5 } })).json.inserted, 5);
    const { json } = await s.request('GET', '/api/links/stored-first/stats?range=all', { token: manageToken });
    assert.equal(json.totals.clicks, 7, 'both visits and the simulated clicks were stored');
    assert.equal(json.totals.syntheticClicks, 5);
    const ids = (await clickRowsOf(s.db, 'stored-first')).map((r) => r.id);
    assert.equal(new Set(ids).size, 7);
  });

  it('a duplicate id that will not go away is an error, never a taken slug', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const restore = replaceCollectionMethod(s.db, 'links', 'insertOne', async () => {
      throw duplicateKey('links', 'id', 1);
    });
    let res;
    try {
      res = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/stuck', slug: 'stuck-id' } });
    } finally {
      restore();
    }
    assert.equal(res.status, 500);
    assert.equal(res.json.error.code, 'internal');
    assert.match(errors.mock.calls.map((c) => c.arguments.join(' ')).join('\n'), /unhandled error/);
    assert.equal((await s.request('GET', '/api/slugs/check?slug=stuck-id')).json.available, true, 'the slug was never taken');
  });
});

describe('a warm start', () => {
  it('only reads', async () => {
    const dbName = freshDatabaseName();
    const config = { mongodbUri: await testMongoUri(), mongodbDb: dbName };
    const first = createApp({ config });
    await first.ready;
    await first.close();

    const log = commandLog();
    const second = createApp({ config, mongoClientOptions: log.clientOptions, onDatabaseClient: log.onClient });
    await second.ready;
    await second.close();
    assert.deepEqual(
      log.names.slice(0, 4).sort(),
      ['find meta', 'listIndexes clicks', 'listIndexes links', 'listIndexes visitors'],
      'the schema version and every index list, sent together',
    );
    assert.deepEqual(log.names.slice(4), ['find meta'], 'then the salt, and no index builds');
    await dropTestDatabase(dbName);
  });
});

describe('a visit on a database that stops answering', () => {
  let s;
  before(async () => {
    s = await startServer({ databaseTimeoutMs: 300 });
  });
  after(() => s.stop());

  // A promise that never settles: no socket timeout or driver retry can end the wait, only the visit's own limit.
  const never = () => new Promise(() => {});

  for (const [what, collection, method, status] of [['the lookup', 'links', 'findOne', 503], ['the consume', 'links', 'findOneAndUpdate', 503]]) {
    it(`gets the 503 page within its limit when ${what} hangs`, async (t) => {
      t.mock.method(console, 'error', () => {});
      const slug = `hung-${method.toLowerCase()}`;
      await s.createLink({ targetUrl: 'https://example.com/hung', slug });
      const restore = replaceCollectionMethod(s.db, collection, method, never);
      const started = performance.now();
      const res = await s.visit(slug, { headers: PAGE });
      const elapsed = performance.now() - started;
      restore();
      assert.equal(res.status, status);
      assert.equal(res.headers.get('retry-after'), '5');
      assert.match(res.text, /Blip can’t reach its database right now/);
      assert.ok(elapsed >= 250 && elapsed < 2500, `took ${elapsed.toFixed(0)} ms`);
    });
  }

  it('gets the 503 page within its limit when the "expired at" lookup of a used-up link hangs', async (t) => {
    t.mock.method(console, 'error', () => {});
    await s.createLink({ targetUrl: 'https://example.com/hung-used-up', slug: 'hung-used-up', maxClicks: 1 });
    assert.equal((await s.visit('hung-used-up')).status, 302);
    const restore = replaceCollectionMethod(s.db, 'clicks', 'findOne', never);
    const res = await s.visit('hung-used-up', { headers: PAGE });
    restore();
    assert.equal(res.status, 503);
  });

  // Every database call an API request waits for has the same limit: one attempt may wait 8 s on its
  // socket and the driver retries a timed-out read or write once, so without it these would take 16 s.
  const neverFound = () => ({ toArray: never });
  let made = 0;
  /** A link of its own, made before anything hangs, and its token. */
  const freshLink = async ({ destroyed = false } = {}) => {
    made += 1;
    const slug = `hung-api-${made}`;
    const { manageToken } = await s.createLink({ targetUrl: `https://example.com/${slug}`, slug });
    if (destroyed) assert.equal((await s.request('POST', `/api/links/${slug}/destroy`, { token: manageToken })).status, 200);
    return { slug, token: manageToken };
  };
  for (const [what, collection, method, behaviour, send, setup = {}] of [
    ['a create checks its slug', 'links', 'findOne', never, () => s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/hung', slug: 'hung-create' } })],
    ['a create looks for a free word slug', 'links', 'findOne', never, () => s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/hung' } })],
    ['a create stores its link', 'links', 'insertOne', never, () => s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/hung', slug: 'hung-insert' } })],
    ['a slug check', 'links', 'findOne', never, () => s.request('GET', '/api/slugs/check?slug=anything')],
    ['slug suggestions', 'links', 'find', neverFound, () => s.request('GET', '/api/slugs/suggest?phrase=summer')],
    ['the batch lookup of My links', 'links', 'find', neverFound, ({ slug, token }) => s.request('POST', '/api/links/batch', { body: { items: [{ slug, token }] } }), { link: true }],
    ['a PATCH', 'links', 'findOneAndUpdate', never, ({ slug, token }) => s.request('PATCH', `/api/links/${slug}`, { token, body: { title: 'Stalled' } }), { link: true }],
    ['Destroy now', 'links', 'findOneAndUpdate', never, ({ slug, token }) => s.request('POST', `/api/links/${slug}/destroy`, { token }), { link: true }],
    ['Bring back', 'links', 'findOneAndUpdate', never, ({ slug, token }) => s.request('POST', `/api/links/${slug}/revive`, { token }), { link: true, destroyed: true }],
    ['a delete', 'links', 'deleteOne', never, ({ slug, token }) => s.request('DELETE', `/api/links/${slug}`, { token }), { link: true }],
    ['Simulate traffic', 'clicks', 'insertMany', never, ({ slug, token }) => s.request('POST', `/api/links/${slug}/simulate`, { token, body: { count: 3 } }), { link: true }],
    ['Clear simulated', 'clicks', 'deleteMany', never, ({ slug, token }) => s.request('DELETE', `/api/links/${slug}/simulated`, { token }), { link: true }],
  ]) {
    it(`answers 503 within its limit when ${what} hangs`, { timeout: 10_000 }, async (t) => {
      t.mock.method(console, 'error', () => {});
      const link = setup.link ? await freshLink(setup) : null;
      const restore = replaceCollectionMethod(s.db, collection, method, behaviour);
      let res;
      const started = performance.now();
      try {
        res = await send(link);
      } finally {
        restore();
      }
      const elapsed = performance.now() - started;
      assert.equal(res.status, 503, res.text);
      assert.deepEqual(res.json, { error: { code: 'unavailable', message: DATABASE_UNAVAILABLE_MESSAGE } });
      assert.equal(res.headers.get('retry-after'), '5');
      assert.ok(elapsed >= 250 && elapsed < 2500, `took ${elapsed.toFixed(0)} ms`);
    });
  }
});

describe('when the click write fails', () => {
  let s;
  const waited = [];
  before(async () => {
    s = await startServer({ waitUntil: (promise) => waited.push(promise) });
  });
  after(() => s.stop());

  it('a visit that has used up a click still gets through', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    await s.createLink({ targetUrl: 'https://example.com/write-fails', slug: 'write-fails', maxClicks: 1 });
    const restore = replaceCollectionMethod(s.db, 'clicks', 'insertOne', async () => {
      throw new MongoNetworkError('read ECONNRESET');
    });
    try {
      const res = await s.visit('write-fails');
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), 'https://example.com/write-fails');
    } finally {
      restore();
    }
    assert.equal((await s.db.collection('links').findOne({ slug: 'write-fails' })).click_count, 1, 'the click stays used up');
    assert.equal(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0].arguments[0]), /could not record a visit to \/write-fails/);
    assert.equal((await s.visit('write-fails')).status, 410);
  });

  it('a visit that fails to consume gets the 503 page, with nothing stored', async (t) => {
    t.mock.method(console, 'error', () => {});
    await s.createLink({ targetUrl: 'https://example.com/consume-fails', slug: 'consume-fails', maxClicks: 2 });
    const restore = replaceCollectionMethod(s.db, 'links', 'findOneAndUpdate', async () => {
      throw new MongoNetworkError('read ECONNRESET');
    });
    try {
      const res = await s.visit('consume-fails', { headers: PAGE });
      assert.equal(res.status, 503);
      assert.match(res.text, /Blip can’t reach its database right now/);
    } finally {
      restore();
    }
    assert.deepEqual(await clickRowsOf(s.db, 'consume-fails'), []);
  });

  for (const [what, slug, extra, expected] of [
    ['a consumed visit', 'stalled-consumed', { maxClicks: 2 }, 302],
    ['a blocked attempt', 'stalled-blocked', { expiresInSeconds: 60 }, 410],
  ]) {
    it(`${what} waits for a stalled click write no longer than its budget, and the write is left to finish`, async (t) => {
      const errors = t.mock.method(console, 'error', () => {});
      await s.createLink({ targetUrl: `https://example.com/${slug}`, slug, ...extra });
      if (expected === 410) s.advance(120_000);
      let finish;
      const restore = replaceCollectionMethod(s.db, 'clicks', 'insertOne', () => new Promise((resolve) => {
        finish = resolve;
      }));
      waited.length = 0;
      const started = performance.now();
      const res = await s.visit(slug, { headers: PAGE });
      const elapsed = performance.now() - started;
      restore();
      assert.equal(res.status, expected);
      assert.ok(elapsed >= CLICK_WRITE_BUDGET_MS - 50 && elapsed < CLICK_WRITE_BUDGET_MS + 2000, `took ${elapsed.toFixed(0)} ms`);
      assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), new RegExp(`recording a visit to /${slug} is slow`));
      assert.equal(waited.length, 1, 'waitUntil keeps the function alive for the write');
      finish();
      assert.equal(await waited[0], true, 'it finishes on its own');
    });
  }
});

describe('on Vercel, where a visit answers before its click row is stored', () => {
  let s;
  const kept = [];
  before(async () => {
    s = await startServer({ deferClickWrites: true, waitUntil: (promise) => kept.push(promise), databaseTimeoutMs: 300 });
  });
  after(() => s.stop());

  /** Hold every click insert until `release()`, then let it through to the real collection. */
  function holdClickInserts() {
    const realClicks = s.db.collection('clicks');
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const restore = replaceCollectionMethod(s.db, 'clicks', 'insertOne', async (doc, options) => {
      await gate;
      return realClicks.insertOne(doc, options);
    });
    return () => {
      restore();
      release();
    };
  }

  it('a counted visit answers once its click is used up, without waiting for the row', async () => {
    await s.createLink({ targetUrl: 'https://example.com/deferred', slug: 'deferred', maxClicks: 2 });
    kept.length = 0;
    const release = holdClickInserts();
    try {
      const started = performance.now();
      const res = await s.visit('deferred');
      const elapsed = performance.now() - started;
      assert.equal(res.status, 302);
      assert.ok(elapsed < CLICK_WRITE_BUDGET_MS / 2, `answered in ${elapsed.toFixed(0)} ms`);
      assert.equal((await s.db.collection('links').findOne({ slug: 'deferred' })).click_count, 1, 'the click was used up before the answer');
      assert.deepEqual(await clickRowsOf(s.db, 'deferred'), [], 'its row is still on its way');
      assert.equal(kept.length, 1, 'waitUntil keeps the function running for it');
    } finally {
      release();
    }
    assert.equal(await kept[0], true, 'and it is stored');
    const rows = await clickRowsOf(s.db, 'deferred');
    assert.deepEqual(rows.map((r) => [r.outcome, r.is_unique]), [['redirect', 1]]);
  });

  it('a blocked attempt and a bot preview answer without waiting for their rows either', async () => {
    await s.createLink({ targetUrl: 'https://example.com/deferred-expired', slug: 'deferred-expired', expiresInSeconds: 60 });
    await s.createLink({ targetUrl: 'https://example.com/deferred-bot', slug: 'deferred-bot', maxClicks: 5 });
    kept.length = 0;
    const release = holdClickInserts();
    try {
      const preview = await s.visit('deferred-bot', { ua: UA.slackbot });
      assert.equal(preview.status, 200);
      assert.ok(!preview.text.includes('example.com/deferred-bot'));
      s.advance(120_000);
      const started = performance.now();
      const expired = await s.visit('deferred-expired', { headers: PAGE });
      assert.equal(expired.status, 410);
      assert.ok(performance.now() - started < CLICK_WRITE_BUDGET_MS / 2);
      assert.equal(kept.length, 2);
    } finally {
      release();
    }
    assert.deepEqual(await Promise.all(kept), [true, true]);
    assert.deepEqual((await clickRowsOf(s.db, 'deferred-bot')).map((r) => r.outcome), ['bot-preview']);
    assert.deepEqual((await clickRowsOf(s.db, 'deferred-expired')).map((r) => r.outcome), ['expired']);
    assert.equal((await s.db.collection('links').findOne({ slug: 'deferred-bot' })).click_count, 0, 'a bot never uses up a click');
  });

  it('the consume is still awaited: one that hangs holds the visit until its limit, and no row is written', async (t) => {
    t.mock.method(console, 'error', () => {});
    await s.createLink({ targetUrl: 'https://example.com/deferred-hung', slug: 'deferred-hung', maxClicks: 1 });
    kept.length = 0;
    const restore = replaceCollectionMethod(s.db, 'links', 'findOneAndUpdate', () => new Promise(() => {}));
    try {
      const res = await s.visit('deferred-hung', { headers: PAGE });
      assert.equal(res.status, 503, 'nobody gets through on a click that was never used up');
      assert.match(res.text, /Blip can’t reach its database right now/);
    } finally {
      restore();
    }
    assert.equal(kept.length, 0, 'nothing is stored for a visit that was not consumed');
    assert.equal((await s.visit('deferred-hung')).status, 302, 'the click is still there for the next visitor');
  });

  it('a row that fails to store is logged, and the visit got through anyway', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    await s.createLink({ targetUrl: 'https://example.com/deferred-fails', slug: 'deferred-fails' });
    kept.length = 0;
    const restore = replaceCollectionMethod(s.db, 'clicks', 'insertOne', async () => {
      throw new MongoNetworkError('read ECONNRESET');
    });
    try {
      assert.equal((await s.visit('deferred-fails')).status, 302);
      assert.equal(await kept[0], false);
    } finally {
      restore();
    }
    assert.equal(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0].arguments[0]), /could not record a visit to \/deferred-fails: read ECONNRESET/);
  });

  it('a row slower than the budget is logged after the answer, and still stored', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    await s.createLink({ targetUrl: 'https://example.com/deferred-slow', slug: 'deferred-slow' });
    kept.length = 0;
    const release = holdClickInserts();
    try {
      assert.equal((await s.visit('deferred-slow')).status, 302);
      assert.equal(errors.mock.callCount(), 0, 'nothing to report when the answer goes out');
      await eventually(() => errors.mock.callCount() > 0, CLICK_WRITE_BUDGET_MS + 2000);
      assert.match(String(errors.mock.calls[0].arguments[0]), /recording a visit to \/deferred-slow is slow \(over 1500 ms\); still waiting for it after the response/);
    } finally {
      release();
    }
    assert.equal(await kept[0], true);
    assert.equal((await clickRowsOf(s.db, 'deferred-slow')).length, 1);
  });
});

describe('a database behind a failing network', () => {
  const USER = 'blip_test_user';
  const PASSWORD = 'hunter2-not-for-logs';
  const dbName = freshDatabaseName();
  let proxy;
  let s;
  before(async () => {
    const target = await testMongoUri();
    proxy = await startTcpProxy(target);
    await (await testAdminClient()).db(dbName).command({ createUser: USER, pwd: PASSWORD, roles: [{ role: 'readWrite', db: dbName }] });
    s = await startServer({
      dbName,
      config: { mongodbUri: `mongodb://${USER}:${PASSWORD}@127.0.0.1:${proxy.port}/?directConnection=true&authSource=${dbName}` },
      databaseTimeoutMs: 400,
    });
  });
  after(async () => {
    proxy.setMode('ok');
    await s?.stop();
    await proxy?.close();
    const admin = await testAdminClient();
    await admin.db(dbName).command({ dropAllUsersFromDatabase: 1 });
    await dropTestDatabase(dbName);
  });

  const recovered = (slug) => eventually(async () => (await s.visit(slug)).status === 302);

  it('works through the proxy, signed in with the credentials in its connection string', async () => {
    await s.createLink({ targetUrl: 'https://example.com/through', slug: 'through' });
    assert.equal((await s.visit('through')).status, 302);
  });

  it('answers 503 while the network fails, without leaking the credentials, then recovers', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/flaky', slug: 'flaky' });
    proxy.setMode('reset');
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
      proxy.setMode('ok');
    }
    const logged = errors.mock.calls.map((c) => c.arguments.join(' '));
    assert.ok(logged.length >= 2);
    assert.ok(logged.every((line) => line.includes(`database request failed (mongodb://127.0.0.1:${proxy.port}, database ${dbName}): `)), logged.join('\n'));
    assert.ok(logged.every((line) => /IP Access List/.test(line)), 'and what to check');
    assert.ok(logged.every((line) => !line.includes(PASSWORD) && !line.includes(USER)));
    await recovered('flaky');
  });

  it('gives up on a database that stops answering instead of hanging the visit', async (t) => {
    t.mock.method(console, 'error', () => {});
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/stall', slug: 'stall' });
    proxy.setMode('hang');
    try {
      const started = performance.now();
      await assert.rejects(s.db.collection('links').findOne({ slug: 'stall' }), isDatabaseUnavailable);
      const page = await s.visit('stall', { headers: PAGE });
      assert.equal(page.status, 503);
      assert.match(page.text, /Blip can’t reach its database right now/);
      const api = await s.request('POST', '/api/links/stall/simulate', { token: manageToken, body: { count: 1 } });
      assert.equal(api.status, 503);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 8000, `took ${elapsed.toFixed(0)} ms`);
    } finally {
      proxy.setMode('ok');
    }
    await recovered('stall');
  });

  it('streams a visit to the live dashboard', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/live-proxied', slug: 'live-proxied' });
    const stream = await openStream(s.base, 'live-proxied', manageToken);
    try {
      assert.equal(stream.status, 200);
      const hello = await stream.next((e) => e.event === 'hello');
      assert.equal(hello.data.totals.clicks, 0);
      assert.equal((await s.visit('live-proxied', { ua: UA.iphone })).status, 302);
      const firstClick = await stream.next((e) => e.event === 'click');
      assert.equal(firstClick.data.device, 'mobile');
      assert.equal(firstClick.data.totals.clicks, 1);
    } finally {
      stream.close();
    }
  });
});

describe('a live stream behind a failing network', () => {
  const dbName = freshDatabaseName();
  let proxy;
  let s;
  before(async () => {
    proxy = await startTcpProxy(await testMongoUri());
    s = await startServer({ dbName, config: { mongodbUri: proxy.uri, streamPollMs: 50 }, databaseTimeoutMs: 150 });
  });
  after(async () => {
    proxy.setMode('ok');
    await s?.stop();
    await proxy?.close();
    await dropTestDatabase(dbName);
  });

  it('ends after three failed polls, logging once, so the dashboard reconnects', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/failing-stream', slug: 'failing-stream' });
    const stream = await openStream(s.base, 'failing-stream', manageToken);
    try {
      await stream.next((e) => e.event === 'hello');
      proxy.setMode('reset');
      await Promise.race([
        stream.ended,
        sleep(8000).then(() => {
          throw new Error('the stream did not end');
        }),
      ]);
      assert.equal(errors.mock.callCount(), 1);
      assert.match(String(errors.mock.calls[0].arguments[0]), /live stream for \/failing-stream could not poll the database/);
    } finally {
      proxy.setMode('ok');
      stream.close();
    }
  });
});

describe('starting up behind a failing network', () => {
  let proxy;
  before(async () => {
    proxy = await startTcpProxy(await testMongoUri());
  });
  after(async () => {
    proxy.setMode('ok');
    await proxy?.close();
  });

  async function listen(instance) {
    const server = instance.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  }

  it('gives up on a start-up that takes too long, answers 503 and tries again on the next request', async (t) => {
    t.mock.method(console, 'error', () => {});
    proxy.setMode('hang');
    const mongodbDb = freshDatabaseName();
    const started = performance.now();
    const instance = createApp({ config: { mongodbUri: proxy.uri, mongodbDb }, databaseTimeoutMs: 10_000, startupTimeoutMs: 300 });
    const { server, base } = await listen(instance);
    try {
      await assert.rejects(instance.ready, (err) => err.name === 'TimeoutError' && isDatabaseUnavailable(err));
      assert.ok(performance.now() - started < 2000);
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, 'unavailable');
      proxy.setMode('ok');
      assert.equal(res.headers.get('retry-after'), '5');
      await eventually(async () => (await fetch(`${base}/api/health`)).status === 200);
    } finally {
      proxy.setMode('ok');
      server.closeAllConnections();
      server.close();
      await instance.close();
      await dropTestDatabase(mongodbDb);
    }
  });

  it('a database that was down at start-up is picked up by a later request', async (t) => {
    t.mock.method(console, 'error', () => {});
    proxy.setMode('reset');
    const mongodbDb = freshDatabaseName();
    const instance = createApp({ config: { mongodbUri: proxy.uri, mongodbDb }, databaseTimeoutMs: 200 });
    const { server, base } = await listen(instance);
    try {
      await assert.rejects(instance.ready, isDatabaseUnavailable);
      assert.equal((await fetch(`${base}/api/config`)).status, 503);
      proxy.setMode('ok');
      await eventually(async () => (await fetch(`${base}/api/config`)).status === 200);
      const created = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetUrl: 'https://example.com/late-start' }) });
      assert.equal(created.status, 201);
    } finally {
      proxy.setMode('ok');
      server.closeAllConnections();
      server.close();
      await instance.close();
      await dropTestDatabase(mongodbDb);
    }
  });

  it('credentials the database refuses are a 503 too, and stay out of the log', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const password = 'wrong-password-not-for-logs';
    const instance = createApp({
      config: { mongodbUri: `${(await testMongoUri()).split('//')[0]}//nobody:${password}@${(await testMongoUri()).split('//')[1]}`, mongodbDb: freshDatabaseName() },
      databaseTimeoutMs: 1000,
    });
    const { server, base } = await listen(instance);
    try {
      await assert.rejects(instance.ready);
      assert.equal((await fetch(`${base}/api/health`)).status, 503);
      assert.ok(errors.mock.callCount() >= 1);
      for (const call of errors.mock.calls) assert.ok(!call.arguments.join(' ').includes(password));
    } finally {
      server.close();
      await instance.close();
    }
  });
});

describe('credentials from their own variables', () => {
  it('are used when the connection string has none', async () => {
    const dbName = freshDatabaseName();
    const admin = await testAdminClient();
    await admin.db(dbName).command({ createUser: 'blip_env_user', pwd: 'env-password', roles: [{ role: 'readWrite', db: dbName }] });
    const uri = `${await testMongoUri()}${(await testMongoUri()).includes('?') ? '&' : '/?'}authSource=${dbName}`;
    const refused = createApp({ config: { mongodbUri: uri, mongodbDb: dbName, mongodbUsername: 'blip_env_user', mongodbPassword: 'not-the-password' }, databaseTimeoutMs: 2000 });
    const accepted = createApp({ config: { mongodbUri: uri, mongodbDb: dbName, mongodbUsername: 'blip_env_user', mongodbPassword: 'env-password' } });
    try {
      await assert.rejects(refused.ready, isDatabaseUnavailable);
      await accepted.ready;
      assert.equal(await accepted.db.collection('links').countDocuments({}), 0);
    } finally {
      await refused.close();
      await accepted.close();
      await admin.db(dbName).command({ dropAllUsersFromDatabase: 1 });
      await dropTestDatabase(dbName);
    }
  });
});

describe('late clicks on a live stream', () => {
  let s;
  before(async () => {
    s = await startServer({ config: { streamPollMs: 50 } });
  });
  after(() => s.stop());

  /** A click row stored by hand under an id reserved earlier: an insert that was slower than the ones after it. */
  const landLate = (link, id, extra = {}) => s.db.collection('clicks').insertOne({
    id, link_id: link.id, ts: s.clock.t, visitor_hash: `late-${id}`, is_unique: 1, country: null, region: null, city: null, lat: null, lon: null,
    device: 'desktop', browser: null, os: null, referrer_host: null, is_bot: 0, is_synthetic: 0, outcome: 'redirect', ...extra,
  });

  const linkRow = (slug) => s.db.collection('links').findOne({ slug });

  it('a click landing behind newer ones is sent once, counted once, and never sent again', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/late', slug: 'late' });
    const link = await linkRow('late');
    await s.visit('late', { ua: UA.macFirefox });
    const stream = await openStream(s.base, 'late', manageToken);
    try {
      const hello = await stream.next((e) => e.event === 'hello');
      assert.equal(hello.data.totals.clicks, 1);

      const lateId = await allocateIds(s.db, 'clicks'); // reserved first, its insert is slow...
      await s.visit('late', { ua: UA.iphone }); // ...so this newer click lands, and the stream moves past it
      const newer = await stream.next((e) => e.event === 'click');
      assert.ok(newer.data.id > lateId);
      assert.deepEqual(newer.data.totals, { clicks: 2, uniqueVisitors: 2 });

      await landLate(link, lateId);
      const late = await stream.next((e) => e.event === 'click');
      assert.equal(late.data.id, lateId, 'it is not lost');
      assert.deepEqual(late.data.totals, { clicks: 3, uniqueVisitors: 3 });
      assert.deepEqual(late.data.totals, await liveTotals(s.db, link.id), 'running totals equal a full recount');

      await assert.rejects(stream.next((e) => e.event === 'click', 300), /Timed out/, 'nothing is sent twice');
    } finally {
      stream.close();
    }
  });

  it('the clicks a stream started with are never sent, even within the overlap window', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/started', slug: 'started' });
    for (const ua of [UA.macFirefox, UA.iphone, UA.ipad]) await s.visit('started', { ua });
    const stream = await openStream(s.base, 'started', manageToken);
    try {
      const hello = await stream.next((e) => e.event === 'hello');
      assert.equal(hello.data.totals.clicks, 3);
      await assert.rejects(stream.next((e) => e.event === 'click', 300), /Timed out/);
    } finally {
      stream.close();
    }
  });

  it('a recount (clicks were cleared) leaves out a late click until it is sent, so it counts once', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/recount', slug: 'recount' });
    const link = await linkRow('recount');
    await s.visit('recount', { ua: UA.macFirefox });
    const stream = await openStream(s.base, 'recount', manageToken);
    try {
      await stream.next((e) => e.event === 'hello');
      const lateId = await allocateIds(s.db, 'clicks');
      await s.visit('recount', { ua: UA.iphone });
      await stream.next((e) => e.event === 'click');

      // Both reach the same poll: the late click lands, and the epoch has moved.
      await Promise.all([landLate(link, lateId), deleteSyntheticClicks(s.db, link.id)]);
      wake(s.bus, link.id);
      const late = await stream.next((e) => e.event === 'click');
      assert.equal(late.data.id, lateId);
      assert.deepEqual(late.data.totals, { clicks: 3, uniqueVisitors: 3 });
      assert.deepEqual(late.data.totals, await liveTotals(s.db, link.id));
    } finally {
      stream.close();
    }
  });

  it('a recount that fails is tried again by the next poll, so cleared clicks never come back', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/recount-fails', slug: 'recount-fails' });
    const link = await linkRow('recount-fails');
    assert.equal((await s.request('POST', '/api/links/recount-fails/simulate', { token: manageToken, body: { count: 10 } })).json.inserted, 10);
    const stream = await openStream(s.base, 'recount-fails', manageToken);
    // The next recount (the only aggregation on clicks whose first $match has an $or) fails once, the way
    // one over a long history can at its time limit, or on a dropped connection.
    const realClicks = s.db.collection('clicks');
    let failed = 0;
    const restore = replaceCollectionMethod(s.db, 'clicks', 'aggregate', (pipeline, options) => {
      if (!failed && pipeline[0]?.$match?.$or) {
        failed += 1;
        return { toArray: () => Promise.reject(new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' })) };
      }
      return realClicks.aggregate(pipeline, options);
    });
    try {
      assert.equal((await stream.next((e) => e.event === 'hello')).data.totals.clicks, 10);
      assert.deepEqual((await s.request('DELETE', '/api/links/recount-fails/simulated', { token: manageToken })).json, { deleted: 10 });
      await eventually(() => failed === 1 && errors.mock.callCount() === 1);
      assert.match(String(errors.mock.calls[0].arguments[0]), /live stream for \/recount-fails could not poll the database/);
      await s.visit('recount-fails', { ua: UA.iphone });
      const real = await stream.next((e) => e.event === 'click');
      assert.equal(real.data.isSynthetic, false);
      assert.deepEqual(real.data.totals, { clicks: 1, uniqueVisitors: 1 }, 'the ten cleared clicks are not counted again');
      assert.deepEqual(real.data.totals, await liveTotals(s.db, link.id), 'running totals equal a full recount');
      assert.equal(failed, 1);
    } finally {
      restore();
      stream.close();
    }
  });

  it('a late bot or blocked attempt goes out with its outcome and leaves the totals alone', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/late-bot', slug: 'late-bot' });
    const link = await linkRow('late-bot');
    const stream = await openStream(s.base, 'late-bot', manageToken);
    try {
      await stream.next((e) => e.event === 'hello');
      const [botId, blockedId] = [await allocateIds(s.db, 'clicks'), await allocateIds(s.db, 'clicks')];
      await s.visit('late-bot', { ua: UA.iphone });
      await stream.next((e) => e.event === 'click');
      await landLate(link, botId, { is_bot: 1, device: 'bot', outcome: 'redirect', is_unique: 0 });
      await landLate(link, blockedId, { outcome: 'expired', is_unique: 0 });
      const events = [await stream.next((e) => e.event === 'click'), await stream.next((e) => e.event === 'click')];
      assert.deepEqual(events.map((e) => e.data.id), [botId, blockedId]);
      assert.equal(events[0].data.isBot, true);
      assert.equal(events[1].data.outcome, 'expired');
      assert.deepEqual(events[1].data.totals, { clicks: 1, uniqueVisitors: 1 });
    } finally {
      stream.close();
    }
  });
});

describe('the overlap window of a live stream', () => {
  const log = commandLog();
  let s;
  before(async () => {
    s = await startServer({ mongoClientOptions: log.clientOptions, onDatabaseClient: log.onClient, config: { streamPollMs: 50 } });
  });
  after(() => s.stop());

  it('stays bounded on a link with a long history, and looks no further back', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/busy', slug: 'busy' });
    const link = await s.db.collection('links').findOne({ slug: 'busy' });
    const total = STREAM_OVERLAP_IDS + 100;
    await insertClicks(s.db, Array.from({ length: total }, (_, i) => click(link, { ts: s.clock.t, visitor_hash: `v${i}` })));
    const { seq: newestId } = await s.db.collection('counters').findOne({ _id: 'clicks' });

    const stream = await openStream(s.base, 'busy', manageToken);
    try {
      const hello = await stream.next((e) => e.event === 'hello');
      assert.equal(hello.data.totals.clicks, total);
      log.reset();
      await sleep(150);
      const lastPoll = log.raw.filter((c) => c.aggregate === 'links').at(-1);
      const { $match } = lastPoll.pipeline.find((stage) => stage.$lookup?.as === 'rows').$lookup.pipeline[0];
      assert.equal($match.id.$gt, newestId - STREAM_OVERLAP_IDS);
      assert.equal($match.id.$nin.length, STREAM_OVERLAP_IDS, 'the seen-set never holds more than the window');
      assert.equal(Math.min(...$match.id.$nin), newestId - STREAM_OVERLAP_IDS + 1);
      await assert.rejects(stream.next((e) => e.event === 'click', 100), /Timed out/, 'and nothing it counted in `hello` is sent');

      await s.visit('busy', { ua: UA.iphone });
      const next = await stream.next((e) => e.event === 'click');
      assert.equal(next.data.totals.clicks, total + 1);
    } finally {
      stream.close();
    }
  });
});

describe('the tests themselves', () => {
  it('refuse to run against anything but a local MongoDB', async () => {
    const saved = process.env.BLIP_TEST_MONGODB_URI;
    try {
      for (const remote of [
        'mongodb+srv://someone:something@cluster.example.net',
        // "localhost" is the user name here, and the host is a remote cluster
        'mongodb://localhost:x@cluster0.abcd.mongodb.net/',
        // a seed list whose first member is local and whose second is not
        'mongodb://127.0.0.1:27017,cluster0-shard-00-00.abcd.mongodb.net:27017/',
        'mongodb://cluster0.abcd.mongodb.net:27017/?directConnection=true',
        'mongodb://someone:something@127.0.0.1:27017/',
        'mongodb+srv://localhost/',
      ]) {
        assert.equal(isLocalMongoUri(remote), false, remote);
        process.env.BLIP_TEST_MONGODB_URI = remote;
        await assert.rejects(testMongoUri(), /only run against a local MongoDB/, remote);
      }
    } finally {
      if (saved === undefined) delete process.env.BLIP_TEST_MONGODB_URI;
      else process.env.BLIP_TEST_MONGODB_URI = saved;
    }
    for (const local of ['mongodb://127.0.0.1:27017/?replicaSet=testset', 'mongodb://localhost:27017', 'mongodb://[::1]:27017/', 'mongodb://127.0.0.1:1,localhost:2/']) {
      assert.equal(isLocalMongoUri(local), true, local);
    }
    assert.equal(isLocalMongoUri(await testMongoUri()), true, "this run's own server");
  });
});

describe('telling failures apart', () => {
  it('recognises what means "the database could not be reached"', () => {
    const unavailable = [
      new MongoNetworkError('read ECONNRESET'),
      new MongoNetworkTimeoutError('connection 1 to 127.0.0.1:27017 timed out'),
      new MongoServerSelectionError('Server selection timed out after 5000 ms', {}),
      new MongoServerError({ message: 'not primary', code: 10107 }),
      new MongoServerError({ message: 'node is shutting down', code: 91 }),
      new MongoServerError({ message: 'operation exceeded time limit', code: 50 }),
      new MongoServerError({ message: 'bad auth : authentication failed', code: 8000 }),
      new MongoServerError({ message: 'Authentication failed.', code: 18 }),
      Object.assign(new Error('Opening the database took longer than 15 s.'), { name: 'TimeoutError' }),
      Object.assign(new Error('The database is closed.'), { code: 'CLIENT_CLOSED' }),
      Object.assign(new Error('Topology is closed'), { name: 'MongoTopologyClosedError' }),
      Object.assign(new Error('Timed out while checking out a connection'), { name: 'MongoWaitQueueTimeoutError' }),
      new Error('wrapped', { cause: new MongoNetworkError('socket hang up') }),
      new Error('wrapped', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }),
    ];
    for (const err of unavailable) assert.equal(isDatabaseUnavailable(err), true, err.message);
  });

  it('leaves bugs, bad queries and a taken slug alone', () => {
    const others = [
      new Error('boom'),
      new TypeError('x is not a function'),
      new MongoServerError({ message: 'E11000 duplicate key error', code: 11000 }),
      new MongoServerError({ message: 'unknown operator: $nope', code: 2 }),
      null,
      undefined,
      'a string',
    ];
    for (const err of others) assert.equal(isDatabaseUnavailable(err), false, String(err?.message ?? err));
  });

  it('recognises a duplicate key, directly or wrapped', () => {
    assert.equal(isUniqueViolation(new MongoServerError({ message: 'E11000 duplicate key error', code: 11000 })), true);
    assert.equal(isUniqueViolation(new Error('wrapped', { cause: new MongoServerError({ message: 'E11000', code: 11000 }) })), true);
    assert.equal(isUniqueViolation(new MongoNetworkError('read ECONNRESET')), false);
    assert.equal(isUniqueViolation(null), false);
  });

  it('tells which field a duplicate key is about', () => {
    const slug = duplicateKey('links', 'slug', 'taken');
    const id = duplicateKey('links', 'id', 7);
    assert.deepEqual([isUniqueViolation(slug, 'slug'), isUniqueViolation(slug, 'id')], [true, false]);
    assert.deepEqual([isUniqueViolation(id, 'id'), isUniqueViolation(id, 'slug')], [true, false]);
    // A bulk write names the key only in its message.
    const bulk = new MongoServerError({ message: 'E11000 duplicate key error collection: blip.clicks index: id_unique dup key: { id: 12 }', code: 11000 });
    assert.deepEqual([isUniqueViolation(bulk, 'id'), isUniqueViolation(bulk, 'slug')], [true, false]);
    const visitor = new MongoServerError({ message: 'E11000 duplicate key error collection: blip.visitors index: link_visitor_unique dup key: { link_id: 3, visitor_hash: "abc" }', code: 11000 });
    assert.deepEqual([isUniqueViolation(visitor, 'visitor_hash'), isUniqueViolation(visitor, 'link_id'), isUniqueViolation(visitor, 'id')], [true, true, false]);
    assert.equal(isUniqueViolation(new Error('wrapped', { cause: slug }), 'slug'), true);
    assert.equal(isUniqueViolation(new MongoNetworkError('read ECONNRESET'), 'slug'), false);
    assert.ok([slug, id].every(isUniqueViolation), 'as a callback, the index argument is no field');
  });
});
