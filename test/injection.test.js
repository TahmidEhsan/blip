// Request values that are not what they claim to be: MongoDB operator objects ($ne, $gt, $regex), arrays,
// prototype keys, fields the client must never set, bracketed or repeated query keys, and JSON values that
// String() and Number() throw on. None of them may reach a query as they are or end in a 500: every request
// answers 4xx (or the documented coercion), and nothing stored changes. Several layers keep it that way
// today (type checks, String() in every lookup of db.js, SLUG_RE, Express 5's "simple" query parser);
// these tests fail when any one of them is dropped.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import {
  findLinkBySlug, findLinksBySlugs, sha256Hex, slugTaken, takenSlugs,
} from '../server/db.js';
import { UA, startServer } from './helpers.js';

/**
 * A JSON array nested `depth` deep around `core`. String() and Number() run out of stack joining 7000 levels
 * (RangeError); a {"toString":1} core makes them throw even where the stack is deep enough to get there.
 */
const deepArray = (depth, core = '') => `${'['.repeat(depth)}${core}${']'.repeat(depth)}`;
/** JSON values String() throws on ({"toString":1} has no callable toString), and ones Number() throws on. */
const NO_STRING = ['{"toString":1}', '[{"toString":1}]', '{"toString":null,"valueOf":null}', deepArray(7000, '{"toString":1}')];
const NO_NUMBER = ['{"valueOf":1,"toString":1}', deepArray(7000, '{"toString":1}')];

describe('request values that are not what they claim to be', () => {
  let s;
  let token;
  let errors;
  before(async () => {
    s = await startServer();
    ({ manageToken: token } = await s.createLink({ targetUrl: 'https://example.com/victim', slug: 'victim', maxClicks: 3 }));
    await s.createLink({ targetUrl: 'https://example.com/other', slug: 'other' });
  });
  after(() => s.stop());

  /** The `victim` link as stored, without `_id`. */
  const victim = () => s.db.collection('links').findOne({ slug: 'victim' }, { projection: { _id: 0 } });
  /** Send a raw JSON body. */
  const send = (method, path, json, opts = {}) => s.request(method, path, { body: json, raw: true, ...opts });
  /** Watch console.error for the rest of the test: a 500 logs "unhandled error". */
  const watchErrors = (t) => {
    errors = t.mock.method(console, 'error', () => {});
  };
  const unhandled = () => errors.mock.calls.map((c) => c.arguments.join(' ')).filter((line) => /unhandled error/.test(line));

  it('answers 400 for values String() and Number() throw on, naming the field, and logs nothing', async (t) => {
    watchErrors(t);
    const before1 = await victim();
    const cases = [
      ...NO_STRING.map((v) => ['create slug', 'POST', '/api/links', `{"targetUrl":"https://example.com","slug":${v}}`, 'slug']),
      ...NO_STRING.map((v) => ['create domain', 'POST', '/api/links', `{"targetUrl":"https://example.com","domain":${v}}`, 'domain']),
      ...NO_STRING.map((v) => ['PATCH domain', 'PATCH', '/api/links/victim', `{"domain":${v}}`, 'domain']),
      ...NO_STRING.map((v) => ['PATCH slug', 'PATCH', '/api/links/victim', `{"slug":${v}}`, 'slug']),
      ...NO_NUMBER.map((v) => ['simulate count', 'POST', '/api/links/victim/simulate', `{"count":${v}}`, 'count']),
    ];
    for (const [what, method, path, json, field] of cases) {
      const res = await send(method, path, json, { token: method === 'POST' && path === '/api/links' ? undefined : token });
      const label = `${what} = ${json.slice(0, 40)}`;
      assert.equal(res.status, 400, `${label}: ${res.text.slice(0, 200)}`);
      assert.equal(res.json.error.field, field, label);
    }
    assert.deepEqual(unhandled(), [], 'no 500, no stack trace in the log');
    assert.deepEqual(await victim(), before1, 'and the link is untouched');
    assert.equal(await s.db.collection('clicks').countDocuments({}), 0, 'no simulated click was stored');
  });

  it('still coerces the values it always accepted', async () => {
    // A number slug is its digits, a blank one asks for a word slug, a domain is matched as text, and a
    // count may be a numeric string.
    const numeric = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/n', slug: 12345 } });
    assert.deepEqual([numeric.status, numeric.json.link.slug], [201, '12345']);
    const blank = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/b', slug: '   ' } });
    assert.equal(blank.status, 201);
    assert.match(blank.json.link.slug, /^[a-z]+(-[a-z0-9]+)+$/);
    const vanity = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/v', slug: 'vanity', domain: ' CAT.LY ' } });
    assert.deepEqual([vanity.status, vanity.json.link.domain], [201, 'cat.ly']);
    const counted = await s.request('POST', '/api/links/victim/simulate', { token, body: { count: '2' } });
    assert.deepEqual([counted.status, counted.json], [200, { inserted: 2 }]);
    assert.deepEqual((await s.request('DELETE', '/api/links/victim/simulated', { token })).json, { deleted: 2 });
  });

  it('never lets an operator object, an array or a prototype key into a create', async (t) => {
    watchErrors(t);
    const refused = [
      { targetUrl: { $ne: null } },
      { targetUrl: ['https://example.com'] },
      { targetUrl: 'https://example.com', slug: { $ne: null } },
      { targetUrl: 'https://example.com', slug: { $gt: '' } },
      { targetUrl: 'https://example.com', slug: { $regex: '.*' } },
      { targetUrl: 'https://example.com', slug: ['victim'] },
      { targetUrl: 'https://example.com', slug: true },
      { targetUrl: 'https://example.com', slugStyle: { $ne: 'x' } },
      { targetUrl: 'https://example.com', domain: { $ne: null } },
      { targetUrl: 'https://example.com', title: { $set: { x: 1 } } },
      { targetUrl: 'https://example.com', redirectMode: { $in: ['teaser'] } },
      { targetUrl: 'https://example.com', teaser: { seconds: { $gt: 0 } } },
      { targetUrl: 'https://example.com', teaser: { theme: '__proto__' } },
      { targetUrl: 'https://example.com', expiresAt: { $gt: 0 } },
      { targetUrl: 'https://example.com', expiresInSeconds: { $lt: 1 } },
      { targetUrl: 'https://example.com', maxClicks: { $lt: 5 } },
      { targetUrl: 'https://example.com', maxClicks: [5] },
      { targetUrl: 'https://example.com', qrStyle: { margin: { $gt: 1 } } },
      { targetUrl: 'https://example.com', qrStyle: { preset: 'hasOwnProperty' } },
      [{ targetUrl: 'https://example.com' }],
    ];
    for (const body of refused) {
      const res = await s.request('POST', '/api/links', { body });
      assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text.slice(0, 160)}`);
    }

    // Fields only the server sets are ignored, and a __proto__ key changes nothing.
    const internal = await s.request('POST', '/api/links', {
      body: { targetUrl: 'https://example.com/internal', slug: 'internal', click_count: 99, manage_token_hash: 'x', id: 1, destroyed_at: 5, max_clicks: 1, _id: 'evil' },
    });
    assert.equal(internal.status, 201);
    const stored = await s.db.collection('links').findOne({ slug: 'internal' });
    assert.ok(stored._id instanceof ObjectId);
    assert.notEqual(stored.id, 1);
    assert.deepEqual([stored.click_count, stored.max_clicks, stored.destroyed_at], [0, null, null]);
    assert.equal(stored.manage_token_hash, sha256Hex(internal.json.manageToken));
    const proto = await send('POST', '/api/links', '{"__proto__":{"targetUrl":"https://evil.example"},"targetUrl":"https://example.com/proto","slug":"proto-top"}');
    assert.equal(proto.status, 201);
    assert.equal((await s.db.collection('links').findOne({ slug: 'proto-top' })).target_url, 'https://example.com/proto');
    assert.deepEqual(unhandled(), []);
  });

  it('never lets one into a token check, the batch or a PATCH', async (t) => {
    watchErrors(t);
    const before1 = await victim();
    const batch = async (items) => (await s.request('POST', '/api/links/batch', { body: { items } }));
    assert.equal((await s.request('POST', '/api/links/batch', { body: { items: { $ne: null } } })).status, 400);
    const results = async (items) => (await batch(items)).json.results.map((r) => r.error);
    assert.deepEqual(await results([{ slug: { $ne: null }, token: { $ne: null } }]), ['not_found']);
    assert.deepEqual(await results([{ slug: { $regex: '.' }, token }]), ['not_found']);
    assert.deepEqual(await results([{ slug: ['victim'], token: [token] }]), ['not_found']);
    assert.deepEqual(await results([{ slug: 'victim', token: { $ne: null } }]), ['forbidden']);
    assert.deepEqual(await results([{ slug: 'victim', token: [token] }]), ['forbidden']);
    assert.deepEqual(await results([{ slug: 'other', token }]), ['forbidden'], "one link's token never opens another");

    assert.equal((await s.request('GET', '/api/links/victim', { token: '{"$ne":null}' })).status, 403);
    assert.equal((await s.request('GET', '/api/links/victim', { token: 'x'.repeat(300) })).status, 403);

    for (const body of [{ slug: { $ne: null } }, { maxClicks: { $inc: 1 } }, { title: { $ne: null } }, { domain: { $ne: null } }, { targetUrl: { $ne: null } }, [{ title: 'x' }]]) {
      assert.equal((await s.request('PATCH', '/api/links/victim', { token, body })).status, 400, JSON.stringify(body));
    }
    // Fields a PATCH can't set are ignored: nothing changes, and the answer says so.
    const ignored = await s.request('PATCH', '/api/links/victim', {
      token, body: { click_count: 999, manage_token_hash: 'x', id: 77, destroyed_at: 5, updated_at: 0, $set: { max_clicks: null }, slug: 'victim' },
    });
    assert.equal(ignored.status, 200);
    assert.deepEqual([ignored.json.link.clickCount, ignored.json.link.maxClicks, ignored.json.link.status], [0, 3, 'active']);
    assert.equal((await s.request('POST', '/api/links/victim/simulate', { token, body: { count: { $gt: 0 } } })).status, 400);
    assert.deepEqual(await victim(), before1, 'the stored link kept every field');
    assert.deepEqual(unhandled(), []);
  });

  it('never lets one in through a query string', async (t) => {
    watchErrors(t);
    const get = (path, opts) => s.request('GET', path, opts);
    // Express 5's simple parser keeps `slug[$ne]` as a key of its own, so `slug` itself is missing.
    assert.equal((await get('/api/slugs/check?slug[$ne]=x')).json.reason, 'empty');
    assert.equal((await get('/api/slugs/check?slug[]=victim')).json.reason, 'empty');
    assert.equal((await get('/api/slugs/check?slug=victim&slug[$gt]=')).json.reason, 'taken');
    assert.equal((await get('/api/slugs/check?slug=%24ne')).status, 200);
    assert.equal((await get('/api/slugs/suggest?phrase[$regex]=.')).status, 200);
    assert.equal((await get('/api/slugs/suggest?count=3&count=99')).json.suggestions.length, 3, 'a repeated key counts once');
    assert.equal((await get('/api/domains/ideas?keyword[]=x')).status, 400);
    const stats = (query) => get(`/api/links/victim/stats${query}`, { token });
    const odd = await stats('?range[]=all&tz[$gt]=1');
    assert.deepEqual([odd.status, odd.json.range], [200, '7d'], 'unknown keys are ignored');
    assert.equal((await stats('?range=all&range=24h')).json.range, 'all');
    for (const query of ['?range=__proto__', '?range=toString', '?range=constructor', '?tz=Infinity']) assert.equal((await stats(query)).status, 400, query);
    for (const path of ['/%7B%24ne%7D', '/%24where', '/a.b']) {
      assert.equal((await s.visit(path.slice(1), { ua: UA.windowsChrome, headers: { Accept: 'text/html' } })).status, 404, path);
    }
    assert.deepEqual(unhandled(), []);
  });

  it('stores links whose fields keep their types', async () => {
    const links = await s.db.collection('links').find({}, { projection: { _id: 0 } }).toArray();
    const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    const expected = {
      id: ['number'], slug: ['string'], domain: ['string'], target_url: ['string'], title: ['string', 'null'], manage_token_hash: ['string'],
      redirect_mode: ['string'], teaser_seconds: ['number'], teaser_style: ['string'], teaser_message: ['string', 'null'], teaser_theme: ['string'],
      expires_at: ['number', 'null'], max_clicks: ['number', 'null'], click_count: ['number'], destroyed_at: ['number', 'null'], qr_style: ['string', 'null'],
      created_at: ['number'], updated_at: ['number'],
    };
    assert.ok(links.length > 3);
    for (const link of links) {
      assert.deepEqual(Object.keys(link).sort(), Object.keys(expected).sort(), link.slug);
      for (const [field, types] of Object.entries(expected)) assert.ok(types.includes(typeOf(link[field])), `${link.slug}.${field} is ${typeOf(link[field])}`);
    }
  });

  it('the lookups of db.js compare whatever they are given as a plain value', async () => {
    assert.equal(await findLinkBySlug(s.db, { $ne: null }), null);
    assert.equal(await findLinkBySlug(s.db, { $regex: '^v' }), null);
    assert.equal(await slugTaken(s.db, { $gt: '' }), false);
    assert.equal((await findLinksBySlugs(s.db, [{ $ne: null }, { $regex: '.' }])).size, 0);
    assert.equal((await takenSlugs(s.db, [{ $regex: '.' }, { $gt: '' }])).size, 0);
    assert.equal((await findLinkBySlug(s.db, 'victim')).slug, 'victim', 'while a real slug is found');
  });
});

describe('a sweep of hostile JSON over every body field', () => {
  let s;
  let token;
  before(async () => {
    s = await startServer();
    ({ manageToken: token } = await s.createLink({ targetUrl: 'https://example.com/swept', slug: 'swept' }));
  });
  after(() => s.stop());

  const VALUES = [
    'null', 'true', '0', '-1', '1e309', '1.5', '""', '" "', '"\\u0000"', '[]', '{}', '[null]', '["a","b"]', '[1]',
    '{"$ne":null}', '{"$gt":""}', '{"$regex":".*"}', '{"$where":"1"}', '{"__proto__":{"x":1}}', '{"constructor":{"prototype":{}}}',
    '{"a.b":1,"$set":{"x":1}}', ...NO_STRING, ...NO_NUMBER, deepArray(7000), `${'{"a":'.repeat(1500)}1${'}'.repeat(1500)}`,
  ];
  const FIELDS = {
    create: ['targetUrl', 'slug', 'slugStyle', 'domain', 'title', 'redirectMode', 'teaser', 'expiresAt', 'expiresInSeconds', 'maxClicks', 'qrStyle'],
    patch: ['targetUrl', 'slug', 'domain', 'title', 'redirectMode', 'teaser', 'expiresAt', 'expiresInSeconds', 'maxClicks', 'qrStyle'],
    teaser: ['seconds', 'style', 'message', 'theme'],
    qrStyle: ['preset', 'dotType', 'logo', 'dotColor', 'gradientRotation', 'margin', 'transparentBg', 'caption'],
  };

  it('never answers 5xx', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const failures = [];
    const send = async (label, method, path, json, withToken) => {
      const res = await s.request(method, path, { body: json, raw: true, token: withToken ? token : undefined });
      if (res.status >= 500) failures.push(`${label}: ${res.status}`);
    };
    for (const v of VALUES) {
      const short = v.slice(0, 24);
      for (const f of FIELDS.create) await send(`create ${f}=${short}`, 'POST', '/api/links', f === 'targetUrl' ? `{"targetUrl":${v}}` : `{"targetUrl":"https://example.com","${f}":${v}}`);
      for (const f of FIELDS.patch) await send(`patch ${f}=${short}`, 'PATCH', '/api/links/swept', `{"${f}":${v}}`, true);
      for (const f of FIELDS.teaser) await send(`patch teaser.${f}=${short}`, 'PATCH', '/api/links/swept', `{"teaser":{"${f}":${v}}}`, true);
      for (const f of FIELDS.qrStyle) await send(`patch qrStyle.${f}=${short}`, 'PATCH', '/api/links/swept', `{"qrStyle":{"${f}":${v}}}`, true);
      await send(`batch items=${short}`, 'POST', '/api/links/batch', `{"items":${v}}`);
      await send(`batch item=${short}`, 'POST', '/api/links/batch', `{"items":[${v}]}`);
      await send(`batch slug=${short}`, 'POST', '/api/links/batch', `{"items":[{"slug":${v},"token":"x"}]}`);
      await send(`batch token=${short}`, 'POST', '/api/links/batch', `{"items":[{"slug":"swept","token":${v}}]}`);
      await send(`simulate count=${short}`, 'POST', '/api/links/swept/simulate', `{"count":${v}}`, true);
      await send(`create body=${short}`, 'POST', '/api/links', v);
      await send(`patch body=${short}`, 'PATCH', '/api/links/swept', v, true);
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(errors.mock.calls.map((c) => String(c.arguments[0])).filter((line) => /unhandled error/.test(line)), []);
  });
});
