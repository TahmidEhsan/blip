// Blip: storage on MongoDB through the official driver (SPEC §3).
//
// Collections: links, clicks, visitors (one document per link and visitor, which decides is_unique),
// counters (the numeric id sequences) and meta (salt, schema version, clicks epoch). Documents keep the
// column names and the plain values the rest of the code expects: numbers for ids and timestamps, 0/1
// for is_bot, is_synthetic and is_unique, null for "no value", and `_id` never leaves this layer.
//
// Rules that keep this correct across several instances of the function, with no transactions:
//  - click and link ids come from a counters document ($inc, so they only grow) and are allocated before
//    the row is inserted, so ids can land out of order: a live stream re-reads a window below its cursor
//    (server/live.js). An insert that finds its id taken (the counters document was removed, say) raises
//    the sequence to the highest stored id and tries once more under a new one;
//  - consuming a visit is one guarded findOneAndUpdate, so racing visits can never exceed max_clicks. The
//    click row is written after it: a crash in between loses that row (analytics), and never lets a
//    visit through that was not consumed;
//  - insertClick and insertClicks check that the link still exists after the insert, and deleteLink removes
//    the link before its rows. Whichever order they interleave in, no row of a deleted link stays behind;
//  - everything that runs at start-up is idempotent and safe when several cold starts race.
//
// One MongoClient per Database, which createApp builds once per process. It is created on first use, so
// a malformed URI surfaces as a rejected `ready` instead of a crash at import time. isDatabaseUnavailable()
// tells transport failures apart from bugs, and those become a 503.
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { uriHasCredentials } from './config.js';

/**
 * Bumped whenever INDEXES changes (stored in meta under `schema_version`). A start-up that finds this
 * version and every index in place only reads, apart from confirming links.id_unique (which changes
 * nothing); otherwise it creates what is missing (see ensureIndexes).
 */
export const SCHEMA_VERSION = 1;

/** A click that counts toward totals (a real visit, not a bot, not blocked). */
export const COUNTED_CLICK_FILTER = Object.freeze({ outcome: Object.freeze({ $in: Object.freeze(['redirect', 'teaser']) }), is_bot: 0 });

/**
 * Longest one attempt at an operation may wait on its socket. The driver retries a failed read or write
 * once (it is what makes a dropped connection or a failover invisible), so an operation can take about twice
 * this on a stalled database: what a visitor waits for has its own limit (see withDeadline).
 */
export const QUERY_TIMEOUT_MS = 8000;
/** Longest an operation may wait for a usable server. */
export const SERVER_SELECTION_TIMEOUT_MS = 5000;

/**
 * The limit for a write Blip can't simply repeat (using up a click, storing a new link, storing simulated
 * clicks): the first attempt's socket timeout, then the server selection and the socket timeout of the
 * driver's retry. A limit of one socket timeout would end the wait just as the driver sends its retry, and
 * when that retry goes through, the write is applied while the caller is told 503 (see `writeInTime` in
 * app.js). WRITE_TIMEOUT_MS is 21 s.
 * @param {number} [socketTimeoutMs] the socket timeout of one attempt (tests use small ones)
 */
export function writeTimeoutFor(socketTimeoutMs = QUERY_TIMEOUT_MS) {
  return 2 * socketTimeoutMs + Math.min(socketTimeoutMs, SERVER_SELECTION_TIMEOUT_MS);
}
export const WRITE_TIMEOUT_MS = writeTimeoutFor(QUERY_TIMEOUT_MS);
/** Longest the server may work on an aggregation: it gives up, and answers so, before the socket gives up on it. */
export const AGGREGATION_TIME_LIMIT_MS = QUERY_TIMEOUT_MS - 1000;
const MAX_POOL_SIZE = 20;
/** Connections idle this long are closed, so a quiet instance holds none open against the cluster's limit. */
const MAX_IDLE_TIME_MS = 60_000;

const NO_ID = Object.freeze({ _id: 0 });

/**
 * Every index Blip's queries need:
 *  - clicks.id_unique: the highest id of any link (throughClickId), and a guard on the id sequence;
 *  - clicks.link_id: a live stream's poll, which reads one link's rows after a cursor;
 *  - clicks.link_ts_id: the stats windows, the first click, and `recent` (newest by ts, then id) without
 *    a blocking sort. It is `{ link_id, ts, id }` and not `{ link_id, ts }` for that sort;
 *  - clicks.link_real_ts: the last real visit, which an exhausted link looks up on every blocked attempt
 *    (only real counted clicks are in it, so the blocked rows after them are never walked).
 */
export const INDEXES = Object.freeze({
  links: [
    { key: { slug: 1 }, name: 'slug_unique', unique: true },
    { key: { id: 1 }, name: 'id_unique', unique: true },
  ],
  clicks: [
    { key: { id: 1 }, name: 'id_unique', unique: true },
    { key: { link_id: 1, id: 1 }, name: 'link_id' },
    { key: { link_id: 1, ts: 1, id: 1 }, name: 'link_ts_id' },
    {
      key: { link_id: 1, ts: 1 },
      name: 'link_real_ts',
      partialFilterExpression: { outcome: { $in: ['redirect', 'teaser'] }, is_bot: 0, is_synthetic: 0 },
    },
  ],
  visitors: [
    { key: { link_id: 1, visitor_hash: 1 }, name: 'link_visitor_unique', unique: true },
  ],
});

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** A log-safe description of a connection string: scheme and hosts, no credentials, no query string. */
export function describeDatabaseUrl(url) {
  if (!url) return '(none)';
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(String(url));
  if (!m) return 'a remote database';
  const afterCredentials = m[2].slice(m[2].lastIndexOf('@') + 1);
  return `${m[1].toLowerCase()}://${afterCredentials.split(/[/?#]/)[0]}`;
}


// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
const closedError = () => Object.assign(new Error('The database is closed.'), { code: 'CLIENT_CLOSED' });

// Driver errors that mean "the database could not be reached right now", as opposed to "this query is wrong".
const UNAVAILABLE_ERROR_NAMES = new Set([
  'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongoTopologyClosedError',
  'MongoServerClosedError', 'MongoClientClosedError', 'MongoNotConnectedError', 'MongoPoolClosedError',
  'MongoPoolClearedError', 'PoolClearedOnNetworkError', 'MongoWaitQueueTimeoutError', 'MongoOperationTimeoutError',
  'MongoStalePrimaryError', 'MongoWriteConcernError', 'MongoExpiredSessionError', 'TimeoutError', 'AbortError',
]);
// Server error codes for the same thing: a failover or a node going down, a stalled operation, and
// credentials or a tier that stopped working (AtlasError 8000 covers bad auth and an exceeded quota).
const UNAVAILABLE_CODES = new Set([
  6, 7, 13, 18, 50, 64, 89, 91, 133, 134, 189, 262, 391, 8000, 9001, 10058, 10107, 11600, 11602, 13435, 13436,
]);
const NETWORK_CODE_RE = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|ERR_SSL_|ERR_TLS_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/;

/**
 * An error and the errors it wraps, outermost first: its `cause` chain, and for a bulk write the error in
 * `errorResponse` (a failed insertMany or bulkWrite throws a MongoBulkWriteError that keeps the network or
 * server-selection error it failed with there, with no `code` and no `cause` of its own).
 */
function errorChain(err) {
  const chain = [];
  for (let e = err; e && typeof e === 'object' && chain.length < 5 && !chain.includes(e);) {
    chain.push(e);
    e = e.cause ?? (e.errorResponse instanceof Error ? e.errorResponse : undefined);
  }
  return chain;
}

/**
 * True when an operation failed because the database could not be reached (server selection, a network
 * error, a timeout, a failover, credentials it no longer accepts), as opposed to a bug or a constraint
 * violation. Such failures are transient: Blip answers them with 503 `unavailable` and tries again on the
 * next request. Looks through the errors it wraps (errorChain), because the driver wraps socket errors.
 */
export function isDatabaseUnavailable(err) {
  return errorChain(err).some((e) => UNAVAILABLE_ERROR_NAMES.has(e.name)
    || (typeof e.code === 'number' && UNAVAILABLE_CODES.has(e.code))
    || (typeof e.code === 'string' && (e.code === 'CLIENT_CLOSED' || NETWORK_CODE_RE.test(e.code)))
    || (typeof e.hasErrorLabel === 'function' && e.hasErrorLabel('RetryableWriteError')));
}

/**
 * What to check when the database can't be opened or used, for the failures people run into while setting
 * Blip up. It goes into the log right after the driver's message and never contains a setting's value.
 * @returns {string|null} null when there is nothing more specific to say than the error itself
 */
export function databaseFailureHint(err) {
  const chain = errorChain(err);
  const essential = chain.find((e) => e.code === 'ESSENTIAL_INDEX');
  if (essential) return essential.hint;
  const any = (test) => chain.some((e) => test(e, String(e.message ?? '')));
  if (any((e) => e.name === 'MongoParseError')) {
    return 'Check MONGODB_URI: copy the connection string again from Atlas (Connect, then Drivers), and percent-encode special characters in the password.';
  }
  if (any((e, message) => e.code === 18 || /bad auth|authentication failed/i.test(message))) {
    return 'The cluster refused the user name or password: compare MONGODB_URI (or MONGODB_USERNAME and MONGODB_PASSWORD) with the database user under Database Access in Atlas.';
  }
  if (any((e, message) => e.code === 13 || /not allowed to do action|not authorized/i.test(message))) {
    return 'The database user may not use this database: give it the readWrite role on it under Database Access in Atlas.';
  }
  if (any((e, message) => e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' || /^query(srv|txt)\b/i.test(message))) {
    return "The cluster's host name was not found: check the host in MONGODB_URI, and this machine's internet connection.";
  }
  if (any((e) => ['MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError', 'TimeoutError'].includes(e.name))) {
    return "No server answered in time: check that the cluster is running and that its IP Access List (Network Access in Atlas) allows this address. Vercel's addresses change, so a deployment needs 0.0.0.0/0 there.";
  }
  return null;
}

/**
 * The fields of the unique index a duplicate-key error is about: the server names them in `keyPattern`
 * (and `keyValue`), and for a bulk write only in its message ("... index: id_unique dup key: { id: 7 }").
 */
function duplicateKeyFields(e) {
  const key = e.keyPattern ?? e.keyValue;
  if (key && typeof key === 'object') return Object.keys(key);
  const fields = /dup key: \{(.*)\}/.exec(String(e.errmsg ?? e.message ?? ''))?.[1] ?? '';
  return [...fields.matchAll(/(?:^|,)\s*([^\s:,]+):/g)].map((m) => m[1]);
}

/**
 * A write lost to a unique index (a taken slug, a racing upsert). With `field`, only a duplicate on an
 * index of that field counts: `isUniqueViolation(err, 'slug')` is a taken slug, `'id'` an id that was
 * already stored.
 */
export function isUniqueViolation(err, field = null) {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; e = e.cause, depth += 1) {
    if (e.code === 11000 || e.code === 11001) return typeof field !== 'string' || duplicateKeyFields(e).includes(field);
  }
  return false;
}

/**
 * `promise`, or a rejection with a TimeoutError once `ms` have passed (isDatabaseUnavailable knows it). A
 * write it gives up on may still be applied. That is accepted for a write that can be repeated with the
 * same result; one that can't waits writeTimeoutFor() instead, long enough for the driver's own retry.
 */
export function withDeadline(promise, ms, message) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { name: 'TimeoutError' })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// The database handle
// ---------------------------------------------------------------------------

/** One database on one MongoClient. Nothing connects until the first operation. */
export class Database {
  #client = null;
  #closing = null;
  #uri;
  #dbName;
  #clientOptions;
  #onClient;

  /**
   * @param {{
   *   uri: string,
   *   dbName: string,
   *   username?: string|null,
   *   password?: string|null,
   *   timeoutMs?: number,
   *   clientOptions?: import('mongodb').MongoClientOptions,
   *   onClient?: (client: MongoClient) => void,
   * }} options `username` and `password` apply when the URI carries no credentials. `timeoutMs` replaces
   *   QUERY_TIMEOUT_MS (and caps the time to find a server). `onClient` runs right after the client is
   *   created (on Vercel, for attachDatabasePool).
   */
  constructor({ uri, dbName, username = null, password = null, timeoutMs, clientOptions = {}, onClient = null }) {
    const socketTimeoutMS = Number(timeoutMs) > 0 ? Number(timeoutMs) : QUERY_TIMEOUT_MS;
    const selectionTimeoutMS = Math.min(socketTimeoutMS, SERVER_SELECTION_TIMEOUT_MS);
    this.#uri = uri; // private (it carries credentials), so logging or serialising the handle never shows it
    this.#dbName = dbName;
    this.#onClient = onClient;
    this.#clientOptions = {
      appName: 'blip',
      socketTimeoutMS,
      serverSelectionTimeoutMS: selectionTimeoutMS,
      connectTimeoutMS: selectionTimeoutMS,
      waitQueueTimeoutMS: selectionTimeoutMS,
      maxPoolSize: MAX_POOL_SIZE,
      maxIdleTimeMS: MAX_IDLE_TIME_MS,
      ...(username && password && !uriHasCredentials(uri) ? { auth: { username, password } } : {}),
      ...clientOptions,
    };
  }

  /** The database's name on the cluster. */
  get name() {
    return this.#dbName;
  }

  get closed() {
    return this.#closing !== null;
  }

  #getClient() {
    if (this.closed) throw closedError(); // the driver itself would quietly reconnect
    if (!this.#client) {
      this.#client = new MongoClient(this.#uri, this.#clientOptions);
      this.#onClient?.(this.#client);
    }
    return this.#client;
  }

  /** A collection of this database. Throws once the handle is closed. */
  collection(name) {
    return this.#getClient().db(this.#dbName).collection(name);
  }

  /**
   * Connect, or join a connection attempt in progress. An operation would connect by itself, but when that
   * first connection fails the driver's client keeps answering "Topology is closed" for good, while
   * calling this again starts over. So start-up goes through here until it succeeds; once connected,
   * the driver follows the cluster through network failures and failovers on its own.
   */
  async connect() {
    await this.#getClient().connect();
  }

  /** Close the client. Idempotent; operations after this reject. Resolves once its sockets are closed. */
  close() {
    if (!this.#closing) {
      const client = this.#client;
      this.#client = null;
      this.#closing = client ? client.close().catch(() => {}) : Promise.resolve();
    }
    return this.#closing;
  }
}

/** @param {ConstructorParameters<typeof Database>[0]} options */
export function createDatabase(options) {
  return new Database(options);
}

/**
 * An upsert on a unique key can lose a race with another one: the loser gets a duplicate-key error, and
 * by then the document exists, so running it again finds it.
 */
async function retryOnDuplicateKey(operation, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= attempts || !isUniqueViolation(err)) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

/** The names of a collection's indexes; none for a collection that does not exist (yet). */
async function indexNames(db, name) {
  try {
    return new Set((await db.collection(name).listIndexes().toArray()).map((index) => index.name));
  } catch (err) {
    if (err?.code === 26) return new Set(); // NamespaceNotFound: MongoDB creates a collection on its first write
    throw err;
  }
}

/**
 * Server codes of an index build that the stored documents, or an index made by hand, stand in the way of:
 * a duplicate key under a unique index (11000, 11001), the same fields under another name
 * (IndexOptionsConflict, 85) and this name on other fields (IndexKeySpecsConflict, 86; only names that are
 * missing are built, so it takes an index made by hand in the meantime). Building it again changes nothing
 * until someone changes the data or the indexes.
 */
const INDEX_CONFLICT_CODES = new Set([11000, 11001, 85, 86]);
const isIndexConflict = (err) => errorChain(err).some((e) => INDEX_CONFLICT_CODES.has(e.code));

/** What to do about an index ensureIndexes could not build. Goes into the log after the server's message. */
export function indexConflictHint(err) {
  if (isUniqueViolation(err)) {
    return 'Some of its documents share a value this index keeps unique: remove the extra ones in Atlas, keeping one of each, then restart Blip (on Vercel, redeploy), which builds it.';
  }
  return 'An index made by hand stands in its way (the message names it): drop that one in Atlas, then restart Blip (on Vercel, redeploy), which builds it.';
}

/**
 * Indexes Blip never runs without, whatever stands in their way. Every change to a link finds it by its id
 * (updateLink, consumeVisit, deleteLink, and its clicks and visitors by link_id), so two links sharing an id
 * could change each other, across owners. Every start sends them to the server (confirmEssentialIndexes),
 * and a conflict on one fails the start-up (essentialIndexError) the way any start-up failure does: Blip
 * doesn't start, and on Vercel every request that needs the database answers 503 and tries again.
 */
const ESSENTIAL_INDEXES = new Set(['links.id_unique']);
const isEssential = (name, index) => ESSENTIAL_INDEXES.has(`${name}.${index.name}`);

/** The start-up failure for an essential index that can't be built: the server's error as `cause`, and what to do. */
function essentialIndexError(collection, index, err) {
  const hint = isUniqueViolation(err)
    ? 'Two links share an id, and every change to a link finds it by its id: in Atlas, give all but one of them an id no other link has (their clicks and visitors refer to it as link_id), or remove them.'
    : 'An index made by hand stands in its way (the message names it): drop that one in Atlas.';
  return Object.assign(new Error(`could not create the index ${index} of ${collection}, which Blip can't run without: ${err?.message ?? err}`, { cause: err }), {
    code: 'ESSENTIAL_INDEX',
    hint: `${hint} Blip can't start until then; on Vercel, every request that needs the database (the API and short links) answers 503 and tries again.`,
  });
}

/**
 * Send each essential index to the server, listed or not. Its name in listIndexes proves nothing: the list
 * also holds a build still in progress (another instance's, which fails if two links share an id) and an
 * index made by hand under that name with other fields or options. createIndexes tells them apart: it does
 * nothing for the finished index; it waits for a build in progress, then does nothing if that build
 * succeeded, or builds the index again itself (refused the same way) if it failed; and it refuses an index
 * made by hand under that name (86, or 85 when only options such as `hidden` differ). It is sent
 * acknowledged (w: 1), so a connection string with w=0 can't make it fire and forget.
 */
async function confirmEssentialIndexes(db) {
  for (const [name, indexes] of Object.entries(INDEXES)) {
    for (const index of indexes.filter((spec) => isEssential(name, spec))) {
      try {
        await db.collection(name).createIndexes([index], { writeConcern: { w: 1 } });
      } catch (err) {
        throw isIndexConflict(err) ? essentialIndexError(name, index.name, err) : err;
      }
    }
  }
}

/**
 * Promise.all that settles only once every promise has, so each step of a start-up attempt waits for all of
 * its commands before the next step (a start-up deadline in app.js, or a socket timeout, can still leave one
 * running on the server, which is harmless: each is safe to repeat). With several failures it throws the
 * essential-index one, since that is the one a person has to fix.
 */
async function settleAll(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failed.length) throw failed.find((err) => err?.code === 'ESSENTIAL_INDEX') ?? failed[0];
  return results.map((result) => result.value);
}

/**
 * Remove all but the oldest visitors document of each link and visitor. Two only exist after racing first
 * visits found link_visitor_unique missing (the collection was dropped, and visits created it again), and
 * one per visitor is all the first-visit rule ever needs, so nothing is lost.
 * @returns {Promise<number>} documents removed
 */
async function removeDuplicateVisitors(db) {
  const visitors = db.collection('visitors');
  const groups = await visitors.aggregate([
    { $group: { _id: { link_id: '$link_id', visitor_hash: '$visitor_hash' }, keep: { $min: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ], { maxTimeMS: AGGREGATION_TIME_LIMIT_MS }).toArray();
  if (!groups.length) return 0;
  const { deletedCount } = await visitors.bulkWrite(groups.map(({ _id: key, keep }) => ({
    deleteMany: { filter: { link_id: key.link_id, visitor_hash: key.visitor_hash, _id: { $ne: keep } } },
  })), { ordered: false });
  return deletedCount;
}

/**
 * Build one index, or start from the refusal its build already got (`refused`). The visitors index, refused
 * for duplicates, is built again once they are removed.
 */
async function buildIndex(db, name, index, refused = null) {
  try {
    if (refused) throw refused;
    await db.collection(name).createIndexes([index]);
  } catch (err) {
    if (name !== 'visitors' || !isUniqueViolation(err)) throw err;
    let removed = 0;
    try {
      removed = await removeDuplicateVisitors(db);
    } catch {
      // could not clean up: the index is reported as it is
    }
    if (!removed) throw err;
    await db.collection(name).createIndexes([index]);
  }
}

/**
 * Create the missing indexes of one collection, in one command. When something stands in the way of one of
 * them (isIndexConflict), they are built one at a time, so the others still are. A single missing index is
 * not sent again: its refusal is already known.
 * @returns {Promise<{ collection: string, index: string, error: Error }[]>} the ones that could not be built
 */
async function createMissingIndexes(db, name, indexes) {
  if (!indexes.length) return [];
  let refused;
  try {
    await db.collection(name).createIndexes(indexes);
    return [];
  } catch (err) {
    if (!isIndexConflict(err)) throw err;
    refused = err;
  }
  const conflicts = [];
  for (const index of indexes) {
    try {
      await buildIndex(db, name, index, indexes.length === 1 ? refused : null);
    } catch (err) {
      if (!isIndexConflict(err)) throw err;
      conflicts.push({ collection: name, index: index.name, error: err });
    }
  }
  return conflicts;
}

/**
 * Create the indexes this build needs. Running it again is a no-op, and several cold starts running it at
 * once is safe: creating an index that exists does nothing. In one round trip it reads the stored schema
 * version and the index names of every collection in INDEXES, and sends the essential indexes
 * (confirmEssentialIndexes); when the version is current and every other index is listed (the usual cold
 * start), that is all it does. Otherwise it creates each index that is missing: a collection dropped in Atlas
 * comes back on its next write with only `_id_`, and gets its indexes back on the next start. An index that
 * the data or an index made by hand stands in the way of is returned in `conflicts` instead of failing the
 * start-up (which would fail the same way on every request until someone fixed it): Blip runs without it and
 * says so (app.js), and the next start tries again. The exception is an essential index (ESSENTIAL_INDEXES,
 * links.id_unique), whose conflict fails the start-up. Each step waits for all of its commands (settleAll).
 * An older version is raised last, so a start-up that stops halfway is finished by the next one.
 * @returns {Promise<{ from: number, to: number, conflicts: { collection: string, index: string, error: Error }[] }>}
 *   the version found, the version left behind, and the indexes that could not be built
 */
export async function ensureIndexes(db) {
  const meta = db.collection('meta');
  const collections = Object.keys(INDEXES);
  const [version, , ...present] = await settleAll([
    meta.findOne({ _id: 'schema_version' }),
    confirmEssentialIndexes(db),
    ...collections.map((name) => indexNames(db, name)),
  ]);
  const from = Number(version?.value) || 0;
  // The essential indexes are built or confirmed by now, whatever the lists say.
  const missing = collections.map((name, i) => INDEXES[name].filter((index) => !isEssential(name, index) && !present[i].has(index.name)));
  if (from >= SCHEMA_VERSION && missing.every((indexes) => !indexes.length)) return { from, to: from, conflicts: [] };
  const conflicts = (await settleAll(collections.map((name, i) => createMissingIndexes(db, name, missing[i])))).flat();
  if (from >= SCHEMA_VERSION) return { from, to: from, conflicts };
  await retryOnDuplicateKey(() => meta.updateOne({ _id: 'schema_version' }, { $max: { value: SCHEMA_VERSION } }, { upsert: true }));
  return { from, to: SCHEMA_VERSION, conflicts };
}

/**
 * Everything a database needs before it serves requests. Safe to run again after a failure, and from
 * several instances at once.
 * @param {Database} db
 */
export async function prepareDatabase(db) {
  await db.connect();
  return ensureIndexes(db);
}

/**
 * The configured salt, or the one stored in `meta`, generating it on first use. When two instances start
 * at once, the first upsert wins and both read that same salt back.
 */
export async function ensureIpHashSalt(db, configured) {
  if (configured) return String(configured);
  const meta = db.collection('meta');
  const existing = await meta.findOne({ _id: 'ip_hash_salt' });
  if (existing) return existing.value;
  const salt = crypto.randomBytes(32).toString('hex');
  const stored = await retryOnDuplicateKey(() => meta.findOneAndUpdate(
    { _id: 'ip_hash_salt' },
    { $setOnInsert: { value: salt } },
    { upsert: true, returnDocument: 'after' },
  ));
  return stored.value;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
export const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * Reserve `count` ids of a sequence (the `links` or the `clicks` ids). They only grow and are never reused.
 * @returns {Promise<number>} the first id of the block
 */
export async function allocateIds(db, sequence, count = 1) {
  const { seq } = await retryOnDuplicateKey(() => db.collection('counters').findOneAndUpdate(
    { _id: sequence },
    { $inc: { seq: count } },
    { upsert: true, returnDocument: 'after' },
  ));
  return seq - count + 1;
}

/**
 * Raise a sequence to the highest id stored in its collection (each sequence is named after its
 * collection). Its counters document only falls behind when the data was changed outside Blip: the
 * document was removed, or documents were copied in without it.
 */
async function catchUpSequence(db, sequence) {
  const [newest] = await db.collection(sequence).find({}, { projection: { _id: 0, id: 1 } }).sort({ id: -1 }).limit(1).toArray();
  if (!newest) return;
  await retryOnDuplicateKey(() => db.collection('counters').updateOne({ _id: sequence }, { $max: { seq: newest.id } }, { upsert: true }));
}

/**
 * Insert documents numbered from their sequence (`docs[i].id`, collection and sequence share a name), in
 * order: `one` sends the single document with insertOne, otherwise one ordered insertMany. When an id is
 * already stored, the sequence has fallen behind (see catchUpSequence): it catches up, and the documents
 * not stored yet are numbered again from a new block and inserted once more. A taken slug or any other
 * failure is thrown as it is.
 */
async function insertNumbered(db, name, docs, { one = false } = {}) {
  const insert = (batch) => (one ? db.collection(name).insertOne(batch[0]) : db.collection(name).insertMany(batch, { ordered: true }));
  try {
    await insert(docs);
  } catch (err) {
    if (!isUniqueViolation(err, 'id')) throw err;
    const rest = docs.slice(err.result?.insertedCount ?? 0); // an ordered insert stops at the first taken id
    await catchUpSequence(db, name);
    const first = await allocateIds(db, name, rest.length);
    rest.forEach((doc, i) => {
      doc.id = first + i;
    });
    await insert(rest);
  }
}

/** A stored document as the rest of the code sees it: without `_id`. */
const stripId = ({ _id, ...row }) => row;

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------
export async function findLinkBySlug(db, slug) {
  return db.collection('links').findOne({ slug: String(slug) }, { projection: NO_ID });
}

export async function findLinkById(db, id) {
  return db.collection('links').findOne({ id }, { projection: NO_ID });
}

/** Documents for many slugs in one round trip: Map slug → link. */
export async function findLinksBySlugs(db, slugs) {
  const rows = await db.collection('links').find({ slug: { $in: [...new Set(slugs.map(String))] } }, { projection: NO_ID }).toArray();
  return new Map(rows.map((row) => [row.slug, row]));
}

export async function slugTaken(db, slug) {
  return Boolean(await db.collection('links').findOne({ slug: String(slug) }, { projection: { _id: 0, slug: 1 } }));
}

/** Which of these slugs are taken, in one round trip. */
export async function takenSlugs(db, slugs) {
  const rows = await db.collection('links').find({ slug: { $in: [...new Set(slugs.map(String))] } }, { projection: { _id: 0, slug: 1 } }).toArray();
  return new Set(rows.map((row) => row.slug));
}

/**
 * @param {object} link snake_case fields (without id/click_count)
 * @returns {Promise<object>} the stored link
 * @throws a duplicate-key error (`isUniqueViolation(err, 'slug')`) when the slug is taken. An id that is
 *   already stored never is one: the id sequence catches up and the link gets the next free id.
 */
export async function insertLink(db, link) {
  const doc = {
    id: await allocateIds(db, 'links'),
    slug: link.slug,
    domain: link.domain,
    target_url: link.target_url,
    title: link.title ?? null,
    manage_token_hash: link.manage_token_hash,
    redirect_mode: link.redirect_mode ?? 'instant',
    teaser_seconds: link.teaser_seconds ?? 5,
    teaser_style: link.teaser_style ?? 'countdown',
    teaser_message: link.teaser_message ?? null,
    teaser_theme: link.teaser_theme ?? 'hero',
    expires_at: link.expires_at ?? null,
    max_clicks: link.max_clicks ?? null,
    click_count: 0,
    destroyed_at: null,
    qr_style: link.qr_style ?? null,
    created_at: link.created_at,
    updated_at: link.updated_at,
  };
  await insertNumbered(db, 'links', [doc], { one: true });
  return stripId(doc);
}

const UPDATABLE_FIELDS = new Set([
  'domain', 'target_url', 'title', 'redirect_mode', 'teaser_seconds', 'teaser_style', 'teaser_message',
  'teaser_theme', 'expires_at', 'max_clicks', 'qr_style', 'destroyed_at', 'updated_at',
]);

/**
 * Update whitelisted fields of one link.
 * @returns {Promise<object|null>} the updated link (the current one when no field applies), or null when the link is gone
 */
export async function updateLink(db, id, fields) {
  const names = Object.keys(fields).filter((k) => UPDATABLE_FIELDS.has(k));
  if (!names.length) return findLinkById(db, id);
  const $set = Object.fromEntries(names.map((name) => [name, fields[name] ?? null]));
  return db.collection('links').findOneAndUpdate({ id }, { $set }, { returnDocument: 'after', projection: NO_ID });
}

/** Remove every click and visitor of a link that no longer exists. Safe to repeat. */
async function sweepLinkRows(db, linkId) {
  await Promise.all([
    db.collection('clicks').deleteMany({ link_id: linkId }),
    db.collection('visitors').deleteMany({ link_id: linkId }),
  ]);
}

/**
 * Delete a link, then its clicks and visitors: with the link gone first, no new click can land (see
 * insertClick for one already on its way).
 * @returns {Promise<number>} links deleted (0 or 1)
 */
export async function deleteLink(db, id) {
  const { deletedCount } = await db.collection('links').deleteOne({ id });
  await sweepLinkRows(db, id);
  return deletedCount;
}

/**
 * Atomically consume one visit (SPEC §4.4 step 6): one guarded findOneAndUpdate, which changes the link
 * only while it is active, so 30 racing visits for 3 remaining clicks consume exactly 3.
 * @returns {Promise<{ consumed: boolean, link: object|null }>} the link as it is right after the visit was consumed
 */
export async function consumeVisit(db, id, now) {
  const link = await db.collection('links').findOneAndUpdate(
    {
      id,
      destroyed_at: null,
      $and: [
        { $or: [{ expires_at: null }, { expires_at: { $gt: now } }] },
        { $or: [{ max_clicks: null }, { $expr: { $lt: ['$click_count', '$max_clicks'] } }] },
      ],
    },
    { $inc: { click_count: 1 }, $set: { updated_at: now } },
    { returnDocument: 'after', projection: NO_ID },
  );
  return { consumed: link !== null, link };
}

// ---------------------------------------------------------------------------
// clicks
// ---------------------------------------------------------------------------

/** The stored shape of a click (everything but `id` and `is_unique`). */
function clickFields(click) {
  return {
    link_id: click.link_id,
    ts: click.ts,
    visitor_hash: click.visitor_hash ?? null,
    country: click.country ?? null,
    region: click.region ?? null,
    city: click.city ?? null,
    lat: click.lat ?? null,
    lon: click.lon ?? null,
    device: click.device || 'other',
    browser: click.browser ?? null,
    os: click.os ?? null,
    referrer_host: click.referrer_host ?? null,
    is_bot: click.is_bot ? 1 : 0,
    is_synthetic: click.is_synthetic ? 1 : 0,
    outcome: click.outcome || 'redirect',
  };
}

/** Does this click decide a first visit? Only a counted click with a visitor hash does. */
const decidesFirstVisit = (row) => (row.outcome === 'redirect' || row.outcome === 'teaser') && row.is_bot === 0 && Boolean(row.visitor_hash);

/**
 * True when this is the visitor's first counted click on the link. The upsert decides: exactly one of any
 * number of racing visits inserts the document, and a loser's duplicate-key error means "not first".
 */
async function recordFirstVisit(db, row) {
  if (!decidesFirstVisit(row)) return false;
  try {
    const { upsertedCount } = await db.collection('visitors').updateOne(
      { link_id: row.link_id, visitor_hash: row.visitor_hash },
      { $setOnInsert: { is_synthetic: row.is_synthetic } },
      { upsert: true },
    );
    return upsertedCount === 1;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

const linkExists = async (db, linkId) => Boolean(await db.collection('links').findOne({ id: linkId }, { projection: { _id: 0, id: 1 } }));

const linkGone = (linkId) => Object.assign(new Error(`link ${linkId} no longer exists`), { code: 'LINK_GONE' });

/**
 * Insert one click; `is_unique` is decided through the visitors collection. The link is checked after
 * the insert: deleteLink removes the link before its rows, so a row that lands after that sweep finds the
 * link gone here and removes itself, and a row that lands before it is swept.
 * @returns {Promise<object>} the stored click (with id)
 * @throws when the link was deleted meanwhile (nothing stays stored)
 */
export async function insertClick(db, click) {
  const row = clickFields(click);
  const [id, first] = await Promise.all([allocateIds(db, 'clicks'), recordFirstVisit(db, row)]);
  const doc = { id, ...row, is_unique: first ? 1 : 0 };
  await insertNumbered(db, 'clicks', [doc], { one: true });
  if (!(await linkExists(db, row.link_id))) {
    await sweepLinkRows(db, row.link_id);
    throw linkGone(row.link_id);
  }
  return stripId(doc);
}

/**
 * The first visits among rows of one link, in row order (each row sees the ones before it).
 * @returns {Promise<Set<number>>} indexes of the rows that are a visitor's first counted click
 */
async function recordFirstVisits(db, rows) {
  const firstRowOf = new Map();
  rows.forEach((row, i) => {
    if (decidesFirstVisit(row) && !firstRowOf.has(row.visitor_hash)) firstRowOf.set(row.visitor_hash, i);
  });
  if (!firstRowOf.size) return new Set();
  const candidates = [...firstRowOf.values()];
  const operations = candidates.map((i) => ({
    updateOne: {
      filter: { link_id: rows[i].link_id, visitor_hash: rows[i].visitor_hash },
      update: { $setOnInsert: { is_synthetic: rows[i].is_synthetic } },
      upsert: true,
    },
  }));
  let result;
  try {
    result = await db.collection('visitors').bulkWrite(operations, { ordered: false });
  } catch (err) {
    // Racing upserts lose with a duplicate key ("not first"). Anything else is a real failure: a write
    // error of another kind, a write concern error, or a failure below the writes themselves (a dropped
    // connection, no server), which the driver throws as a MongoBulkWriteError with no write errors at all.
    const writeErrors = [err.writeErrors ?? []].flat();
    const lostRaces = Boolean(err.result) && writeErrors.length > 0 && writeErrors.every((e) => isUniqueViolation(e))
      && !err.result.getWriteConcernError?.();
    if (!lostRaces) throw err;
    ({ result } = err);
  }
  return new Set(Object.keys(result.upsertedIds).map((operation) => candidates[Number(operation)]));
}

/**
 * Insert many clicks of one link in order (each sees the ones before it, so `is_unique` works across the
 * batch): their ids and visitors first, then all rows in one insert, then the same check as insertClick.
 * @returns {Promise<object[]>} the stored clicks (none when the link is gone)
 */
export async function insertClicks(db, clicks) {
  if (!clicks.length) return [];
  const rows = clicks.map(clickFields);
  const linkId = rows[0].link_id;
  const [firstId, firsts] = await Promise.all([allocateIds(db, 'clicks', rows.length), recordFirstVisits(db, rows)]);
  const docs = rows.map((row, i) => ({ id: firstId + i, ...row, is_unique: firsts.has(i) ? 1 : 0 }));
  await insertNumbered(db, 'clicks', docs);
  if (!(await linkExists(db, linkId))) {
    await sweepLinkRows(db, linkId);
    return [];
  }
  return docs.map(stripId);
}

/**
 * `meta` key counting deletions of clicks from links that still exist. Live streams keep running totals
 * (server/live.js) and read this with every poll: when it moves, they recount instead of advancing
 * totals that now include deleted rows. Deleting a whole link needs no bump (its streams end).
 */
export const CLICKS_EPOCH_KEY = 'clicks_epoch';

/**
 * Delete a link's simulated clicks and their visitors, then bump CLICKS_EPOCH_KEY. In that order: a
 * stream that sees the new epoch recounts rows that are already gone.
 * @returns {Promise<number>} clicks deleted
 */
export async function deleteSyntheticClicks(db, linkId) {
  const [{ deletedCount }] = await Promise.all([
    db.collection('clicks').deleteMany({ link_id: linkId, is_synthetic: 1 }),
    db.collection('visitors').deleteMany({ link_id: linkId, is_synthetic: 1 }),
  ]);
  await retryOnDuplicateKey(() => db.collection('meta').updateOne({ _id: CLICKS_EPOCH_KEY }, { $inc: { value: 1 } }, { upsert: true }));
  return deletedCount;
}

/** Timestamp of the last real consumed visit (used for "expired at" on click-limited links). */
export async function lastConsumedClickTs(db, linkId) {
  const row = await db.collection('clicks').findOne(
    { link_id: linkId, ...COUNTED_CLICK_FILTER, is_synthetic: 0 },
    { sort: { ts: -1 }, projection: { _id: 0, ts: 1 } },
  );
  return row?.ts ?? null;
}
