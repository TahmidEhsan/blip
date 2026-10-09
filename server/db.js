// Blip: storage through @libsql/client (SPEC §3). By default a local SQLite file (DB_PATH); with
// TURSO_DATABASE_URL (or DATABASE_URL / LIBSQL_URL) a hosted libSQL database such as Turso.
//
// Every helper is async and returns plain objects, with numbers (never BigInt) for counts and ids.
// Rules that keep a remote database correct, where each request may run on a different connection:
//  - nothing relies on per-connection PRAGMAs: journal mode and busy timeout are local-file tuning only,
//    and foreign keys may be off, so a link's clicks are deleted explicitly (deleteLink) and a click is
//    only inserted while its link still exists (insertClick);
//  - multi-statement work that must be atomic goes through one `batch(..., 'write')`. Interactive
//    `client.transaction()` is never used: on a local file it opens a second connection, and on
//    `:memory:` (one connection only) every other query is rejected while it is open;
//  - the schema version lives in the `meta` table (key `schema_version`), and every migration step is
//    idempotent and guarded, so two instances cold-starting at once can both run them.
//
// @libsql/client notes (verified with 0.18.0 on Node 22.17):
//  - named parameters are sent with their `:` prefix (the local driver strips it, a server matches it);
//  - `undefined` cannot be bound (we bind null) and JS numbers bind as REAL, which INTEGER columns store
//    as integers;
//  - a local `INSERT/UPDATE/DELETE ... RETURNING` reports rowsAffected 0, so it is normalised to the
//    number of returned rows; lastInsertRowid comes back as a BigInt (or undefined) and is normalised too;
//  - local files get one pooled connection (`concurrency: 1`) and a 3 s busy timeout on every connection
//    the pool opens (the `timeout` option, in ms);
//  - a server (libsql:, https:, wss:) is reached through `@libsql/client/web`, which is plain JavaScript
//    (the same HTTP client the default entry picks for libsql: and https: URLs). The default entry loads
//    the native `libsql` binary as soon as it is imported, and Vercel's file tracer can't follow that
//    binary's platform-specific require, so it is only imported, lazily, when a local file is opened;
//  - the HTTP client sends its requests without any time limit of its own (undici's defaults are 300 s,
//    as long as a Vercel function may run), so every round trip to a server gets REMOTE_QUERY_TIMEOUT_MS
//    through a `fetch` wrapper. A query that runs out of time rejects with a `TimeoutError` (not wrapped
//    in a LibsqlError) and the client stays usable. A write that timed out may still have been applied.
//    isDatabaseUnavailable() tells these failures (and the server's own 5xx answers) apart from bugs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient as createRemoteClient } from '@libsql/client/web';
import { fileUrlFromPath } from './config.js';
import { DEFAULT_TEASER_THEME, LEGACY_QR_PRESETS, LEGACY_TEASER_THEMES, TEASER_THEMES, upgradeLegacyQrStyle } from './themes.js';

/**
 * Schema versions (stored in meta.schema_version; databases made by the node:sqlite builds kept it in
 * PRAGMA user_version, which is read once as a fallback):
 *   1  initial schema
 *   2  teaser themes and QR presets renamed for the comic redesign (migrateLegacyThemeIds)
 */
export const SCHEMA_VERSION = 2;

/** SQL fragment: a click that counts toward totals (real visit, not a bot, not blocked). */
export const COUNTED_CLICK_SQL = `outcome IN ('redirect','teaser') AND is_bot = 0`;

const LOCAL_BUSY_TIMEOUT_MS = 3000;
/** Longest one HTTP round trip to a database server may take (request and response body). */
export const REMOTE_QUERY_TIMEOUT_MS = 8000;
const RETURNING_RE = /\bRETURNING\b/i;
const IN_LIST_CHUNK = 500;

// The partial indexes below reuse COUNTED_CLICK_SQL verbatim: SQLite only picks a partial index when
// the query's WHERE clause contains the index's WHERE terms, so the text must match the queries exactly.
// The schema runs (idempotently) on every start, so existing databases pick up new indexes without a migration.
// `ON DELETE CASCADE` is kept for databases that enforce foreign keys, but nothing depends on it.
export const SCHEMA_STATEMENTS = Object.freeze([
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS links (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  domain            TEXT NOT NULL,
  target_url        TEXT NOT NULL,
  title             TEXT,
  manage_token_hash TEXT NOT NULL,
  redirect_mode     TEXT NOT NULL DEFAULT 'instant' CHECK (redirect_mode IN ('instant','teaser')),
  teaser_seconds    INTEGER NOT NULL DEFAULT 5,
  teaser_style      TEXT NOT NULL DEFAULT 'countdown' CHECK (teaser_style IN ('countdown','trivia','brand')),
  teaser_message    TEXT,
  teaser_theme      TEXT NOT NULL DEFAULT 'hero',
  expires_at        INTEGER,
  max_clicks        INTEGER,
  click_count       INTEGER NOT NULL DEFAULT 0,
  destroyed_at      INTEGER,
  qr_style          TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS clicks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id       INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  visitor_hash  TEXT,
  is_unique     INTEGER NOT NULL DEFAULT 0,
  country       TEXT,
  region        TEXT,
  city          TEXT,
  lat           REAL,
  lon           REAL,
  device        TEXT NOT NULL DEFAULT 'desktop',
  browser       TEXT,
  os            TEXT,
  referrer_host TEXT,
  is_bot        INTEGER NOT NULL DEFAULT 0,
  is_synthetic  INTEGER NOT NULL DEFAULT 0,
  outcome       TEXT NOT NULL DEFAULT 'redirect' CHECK (outcome IN ('redirect','teaser','expired','bot-preview'))
)`,
  'CREATE INDEX IF NOT EXISTS idx_clicks_link_ts ON clicks(link_id, ts)',
  'CREATE INDEX IF NOT EXISTS idx_clicks_link_visitor ON clicks(link_id, visitor_hash)',
  `CREATE INDEX IF NOT EXISTS idx_clicks_link_counted ON clicks(link_id, visitor_hash) WHERE ${COUNTED_CLICK_SQL}`,
  `CREATE INDEX IF NOT EXISTS idx_clicks_link_real_ts ON clicks(link_id, ts) WHERE ${COUNTED_CLICK_SQL} AND is_synthetic = 0`,
]);

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------
export const isMemoryUrl = (url) => url === ':memory:' || /^file::memory:/i.test(String(url));
/** A local SQLite file (not `:memory:`, not a server). */
export const isFileUrl = (url) => /^file:/i.test(String(url)) && !isMemoryUrl(url);

/** The filesystem path a `file:` URL points at (the same parsing @libsql/client applies). */
export function filePathFromUrl(url) {
  const match = /^file:(?:\/\/[^/?#]*)?([^?#]*)/i.exec(String(url));
  let p = decodeURIComponent(match ? match[1] : '');
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

/** A log-safe description of a database URL: no credentials, no query string (it can carry a token). */
export function describeDatabaseUrl(url) {
  if (!url) return '(none)';
  if (isMemoryUrl(url)) return 'in memory';
  if (isFileUrl(url)) return path.resolve(filePathFromUrl(url));
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^/?#]*)/i.exec(String(url));
  return m ? `${m[1].toLowerCase()}://${m[2]}` : 'a remote database';
}

// ---------------------------------------------------------------------------
// The database handle
// ---------------------------------------------------------------------------
const closedError = () => Object.assign(new Error('The database is closed.'), { code: 'CLIENT_CLOSED' });

// Error codes that mean "the database could not be reached or is busy", not "this query is wrong":
// LibsqlError codes from the HTTP client (a 5xx answer is SERVER_ERROR, a broken stream HRANA_*), our
// own closed handle, and a local file that stayed locked past the busy timeout.
const UNAVAILABLE_CODES = new Set([
  'SERVER_ERROR', 'CLIENT_CLOSED', 'HRANA_CLOSED_ERROR', 'HRANA_WEBSOCKET_ERROR', 'HRANA_PROTO_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED',
]);
const NETWORK_CODE_RE = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/;

/**
 * True when a query failed because the database could not be reached (a timeout, a network error, a
 * 5xx from the server, a locked local file), as opposed to a bug or a constraint violation. Such
 * failures are transient: Blip answers them with 503 `unavailable` and tries again on the next request.
 * Looks through `cause` chains, because the HTTP client passes network errors on as they are (a
 * `TypeError: fetch failed` with the socket error as its cause) or wraps them in a closed-stream error.
 */
export function isDatabaseUnavailable(err) {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 5; e = e.cause, depth += 1) {
    if (typeof e.code === 'string' && (UNAVAILABLE_CODES.has(e.code) || NETWORK_CODE_RE.test(e.code))) return true;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
    if (e instanceof TypeError && /fetch failed/i.test(e.message || '')) return true;
  }
  return false;
}

/** `fetch` for the HTTP client with a time limit on each request, response body included. */
function boundedFetch(timeoutMs) {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, signal });
  };
}

/** `{ sql, args }` with `:`-prefixed names, null for undefined and 1/0 for booleans. */
function toStatement(input, args) {
  let sql;
  let values;
  if (typeof input === 'string') {
    sql = input;
    values = args;
  } else if (Array.isArray(input)) {
    [sql, values] = input;
  } else {
    ({ sql, args: values } = input);
  }
  const bind = (v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  };
  if (values === undefined || values === null) return { sql, args: [] };
  if (Array.isArray(values)) return { sql, args: values.map(bind) };
  const named = {};
  for (const [key, value] of Object.entries(values)) named[/^[:@$]/.test(key) ? key : `:${key}`] = bind(value);
  return { sql, args: named };
}

/** A libSQL ResultSet → `{ rows: plain objects, columns, rowsAffected, lastInsertRowid }` with numbers only. */
function normalizeResult(sql, result) {
  const columns = [...result.columns];
  const rows = result.rows.map((row) => {
    const out = {};
    columns.forEach((column, i) => {
      if (Object.hasOwn(out, column)) return; // duplicate names: the first column wins, like libSQL's own rows
      const value = row[i];
      out[column] = typeof value === 'bigint' ? Number(value) : value;
    });
    return out;
  });
  const reported = Number(result.rowsAffected ?? 0);
  const rowsAffected = reported === 0 && rows.length > 0 && RETURNING_RE.test(sql) ? rows.length : reported;
  const id = result.lastInsertRowid;
  return { rows, columns, rowsAffected, lastInsertRowid: id === undefined || id === null ? null : Number(id) };
}

let localDriver = null;
/** The default @libsql/client entry, with the native driver for local files (imported once, on first use). */
function loadLocalDriver() {
  localDriver ??= import('@libsql/client').catch((err) => {
    localDriver = null;
    throw err;
  });
  return localDriver;
}

/**
 * One database: a thin, async wrapper around a libSQL client.
 * The client is created on first use, so a bad URL or an unreachable file surfaces as a rejected
 * query (and so as a rejected `ready` in createApp) instead of a crash at import time.
 */
export class Database {
  #client = null;
  #opening = null; // the local client while its driver loads
  #url;
  #authToken;
  #timeoutMs;
  #closed = false;

  /**
   * @param {{ url: string, authToken?: string|null, timeoutMs?: number }} options `timeoutMs` limits each
   *   round trip to a server (REMOTE_QUERY_TIMEOUT_MS by default; local databases have no such limit)
   */
  constructor({ url, authToken = null, timeoutMs = REMOTE_QUERY_TIMEOUT_MS }) {
    this.#url = url; // private (a URL can carry a token), so logging or serialising the handle never shows it
    this.#authToken = authToken || undefined;
    this.#timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : REMOTE_QUERY_TIMEOUT_MS;
    this.memory = isMemoryUrl(url);
    this.file = isFileUrl(url);
    /** A database in this process (a file or memory), as opposed to a server such as Turso. */
    this.local = this.memory || this.file;
  }

  /** The libSQL URL (may carry credentials: describe it with describeDatabaseUrl() before logging). */
  get url() {
    return this.#url;
  }

  get closed() {
    return this.#closed;
  }

  async #getClient() {
    if (this.#closed) throw closedError();
    if (this.#client) return this.#client;
    if (!this.local) {
      this.#client = createRemoteClient({ url: this.url, authToken: this.#authToken, fetch: boundedFetch(this.#timeoutMs) });
      return this.#client;
    }
    if (!this.#opening) {
      const opening = this.#openLocal();
      this.#opening = opening;
      // A failed open is not cached (the folder may be fixed by the next attempt).
      opening.catch(() => {
        if (this.#opening === opening) this.#opening = null;
      });
    }
    const client = await this.#opening;
    if (this.#closed) throw closedError();
    return client;
  }

  async #openLocal() {
    if (this.file) fs.mkdirSync(path.dirname(path.resolve(filePathFromUrl(this.url))), { recursive: true });
    const { createClient } = await loadLocalDriver();
    const client = this.file
      ? createClient({ url: this.url, concurrency: 1, timeout: LOCAL_BUSY_TIMEOUT_MS })
      : createClient({ url: this.url });
    if (this.#closed) {
      // close() ran while the driver was loading
      try {
        client.close();
      } catch {
        // already closed
      }
      throw closedError();
    }
    this.#client = client;
    return client;
  }

  /**
   * Run one statement.
   * @param {string|{sql: string, args?: any[]|object}|[string, any]} sql
   * @param {any[]|object} [args] positional values, or named values for `:name` placeholders
   * @returns {Promise<{ rows: object[], columns: string[], rowsAffected: number, lastInsertRowid: number|null }>}
   */
  async execute(sql, args) {
    const stmt = toStatement(sql, args);
    const result = await (await this.#getClient()).execute(stmt);
    return normalizeResult(stmt.sql, result);
  }

  /** Every row. */
  async all(sql, args) {
    return (await this.execute(sql, args)).rows;
  }

  /** The first row, or null. */
  async get(sql, args) {
    return (await this.execute(sql, args)).rows[0] ?? null;
  }

  /** `{ rowsAffected, lastInsertRowid }`. */
  async run(sql, args) {
    const { rowsAffected, lastInsertRowid } = await this.execute(sql, args);
    return { rowsAffected, lastInsertRowid };
  }

  /**
   * Run statements in one transaction and one round trip: all of them or none of them.
   * @param {Array<string|{sql: string, args?: any}|[string, any]>} statements
   * @param {'write'|'read'|'deferred'} [mode] 'read' for independent reads that should see one snapshot
   */
  async batch(statements, mode = 'write') {
    const stmts = statements.map((s) => toStatement(s));
    if (!stmts.length) return [];
    const results = await (await this.#getClient()).batch(stmts, mode);
    return results.map((result, i) => normalizeResult(stmts[i].sql, result));
  }

  /** Close the client. Idempotent; queries after this reject. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    const client = this.#client;
    this.#client = null;
    this.#opening = null; // a client still being opened closes itself (see #openLocal)
    try {
      client?.close();
    } catch {
      // already closed
    }
  }
}

/** @param {{ url: string, authToken?: string|null, timeoutMs?: number }} options */
export function createDatabase(options) {
  return new Database(options);
}

/**
 * Tune a local file and run migrations. Safe to run again, and from several instances at once.
 * @param {Database} db
 */
export async function prepareDatabase(db) {
  // WAL is a property of the file, so setting it once is enough (and it is meaningless elsewhere).
  if (db.file) await db.execute('PRAGMA journal_mode = WAL');
  return migrate(db);
}

/**
 * Open a database by URL (`:memory:`, `file:...`, `libsql://...`) or local path (relative paths
 * resolve against the project root, like DB_PATH), with migrations applied.
 * @param {string} target
 * @param {{ authToken?: string|null }} [options]
 */
export async function openDatabase(target, { authToken = null, timeoutMs } = {}) {
  const url = target === ':memory:' || /^[a-z][a-z0-9+.-]+:/i.test(target) ? target : fileUrlFromPath(target);
  const db = createDatabase({ url, authToken, timeoutMs });
  try {
    await prepareDatabase(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// ---------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------
const SCHEMA_VERSION_SQL = "SELECT value FROM meta WHERE key = 'schema_version'";

/** Never lowers a version another instance (or a newer build) already recorded. */
const recordVersionStatement = (version) => ({
  sql: `INSERT INTO meta (key, value) VALUES ('schema_version', :version)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        WHERE CAST(meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
  args: { version: String(version) },
});

/** PRAGMA user_version of a database made by a node:sqlite build (0 when there is none or it can't be read). */
async function legacyUserVersion(db) {
  try {
    const row = await db.get('PRAGMA user_version');
    return Number(row?.user_version ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** The name of every table and index SCHEMA_STATEMENTS creates. */
const SCHEMA_OBJECTS = Object.freeze(SCHEMA_STATEMENTS.map((sql) => /^CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/i.exec(sql)[1]));

/**
 * The stored schema version when every table and index already exists, else null. One read batch, so
 * a cold start on an up-to-date database never takes the write lock. A database that can't be reached
 * rejects; one without a `meta` table yet just needs the full migration (null).
 */
async function currentSchemaVersion(db) {
  try {
    const [objects, version] = await db.batch([
      { sql: `SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN (${SCHEMA_OBJECTS.map(() => '?').join(', ')})`, args: [...SCHEMA_OBJECTS] },
      SCHEMA_VERSION_SQL,
    ], 'read');
    const stored = Number(version.rows[0]?.value);
    return objects.rows[0]?.n === SCHEMA_OBJECTS.length && Number.isInteger(stored) ? stored : null;
  } catch (err) {
    if (isDatabaseUnavailable(err)) throw err;
    return null;
  }
}

/**
 * Create missing tables and indexes, then bring the data up to SCHEMA_VERSION.
 * Running it again is a no-op; two instances running it at once is safe. When the schema is already
 * complete and current (the usual cold start) it only reads; otherwise the DDL (all `IF NOT EXISTS`)
 * runs in one write batch, so a table or index added to SCHEMA_STATEMENTS is picked up on the next start.
 * @returns {Promise<{ from: number, to: number }>} the version found and the version left behind
 */
export async function migrate(db) {
  const current = await currentSchemaVersion(db);
  if (current !== null && current >= SCHEMA_VERSION) return { from: current, to: current };
  const results = await db.batch([...SCHEMA_STATEMENTS, SCHEMA_VERSION_SQL], 'write');
  const stored = results.at(-1).rows[0]?.value;
  // Databases made by the node:sqlite builds have no meta.schema_version yet: their version is in PRAGMA user_version.
  const from = stored === undefined ? await legacyUserVersion(db) : Number(stored) || 0;
  if (from >= SCHEMA_VERSION) {
    if (stored === undefined) await db.batch([recordVersionStatement(from)], 'write');
    return { from, to: from };
  }
  if (from < 2) await migrateLegacyThemeIds(db, { recordVersion: 2 });
  return { from, to: SCHEMA_VERSION };
}

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Rewrite stored teaser themes and QR presets from the first release's ids (aurora, sunset, ...)
 * to the comic redesign's ids. A QR style saved under an old preset id is that preset's old look
 * (gradients, rounded shapes), so it is replaced with the new preset's flat look; the caption and
 * a centre logo the user picked are kept (upgradeLegacyQrStyle in public/assets/js/qr-shared.js).
 * Idempotent: a second run finds nothing to change. A teaser theme that is neither current nor
 * legacy falls back to the default theme. `updated_at` is left alone because nobody edited the link.
 * The QR rewrites only apply while the row still holds the style that was read (compare-and-set), and
 * everything (plus the version bump, when asked) is written in one atomic batch, so a second instance
 * migrating at the same time changes nothing twice.
 * @param {{ recordVersion?: number|null }} [options] also record this schema version in the same batch
 * @returns {Promise<{ teaserThemes: number, qrPresets: number }>} rows changed
 */
export async function migrateLegacyThemeIds(db, { recordVersion = null } = {}) {
  const cases = Object.entries(LEGACY_TEASER_THEMES).map(([from, to]) => `WHEN ${sqlString(from)} THEN ${sqlString(to)}`).join(' ');
  const statements = [`
    UPDATE links SET teaser_theme = CASE teaser_theme ${cases} ELSE ${sqlString(DEFAULT_TEASER_THEME)} END
    WHERE teaser_theme NOT IN (${TEASER_THEMES.map(sqlString).join(', ')})
  `];
  for (const row of await db.all(`SELECT id, qr_style FROM links WHERE qr_style LIKE '%"preset"%'`)) {
    let style;
    try {
      style = JSON.parse(row.qr_style);
    } catch {
      continue; // unreadable styles are already ignored when links are serialised
    }
    const legacy = style && typeof style === 'object' && typeof style.preset === 'string' ? LEGACY_QR_PRESETS[style.preset] : undefined;
    if (!legacy) continue;
    statements.push({
      sql: 'UPDATE links SET qr_style = :next WHERE id = :id AND qr_style = :previous',
      args: { next: JSON.stringify(upgradeLegacyQrStyle(style)), id: row.id, previous: row.qr_style },
    });
  }
  const qrCount = statements.length - 1;
  if (recordVersion !== null) statements.push(recordVersionStatement(recordVersion));
  const results = await db.batch(statements, 'write');
  const qrPresets = results.slice(1, 1 + qrCount).reduce((sum, r) => sum + r.rowsAffected, 0);
  return { teaserThemes: results[0].rowsAffected, qrPresets };
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
export function isUniqueViolation(err) {
  if (!err) return false;
  if (err.extendedCode === 'SQLITE_CONSTRAINT_UNIQUE' || err.extendedCode === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  if (err.rawCode === 2067 || err.rawCode === 1555 || err.errcode === 2067 || err.errcode === 1555) return true;
  if (/UNIQUE constraint failed/i.test(err.message || '')) return true;
  return err.cause && err.cause !== err ? isUniqueViolation(err.cause) : false;
}

export const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------
export async function getMeta(db, key) {
  return (await db.get('SELECT value FROM meta WHERE key = :key', { key }))?.value ?? null;
}

export async function setMeta(db, key, value) {
  await db.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key, value: String(value) });
}

/**
 * The configured salt, or the one stored in `meta`, generating it on first use. When two instances
 * start at once, the first insert wins and both read that same salt back.
 */
export async function ensureIpHashSalt(db, configured) {
  if (configured) return String(configured);
  const existing = await getMeta(db, 'ip_hash_salt');
  if (existing) return existing;
  const [, stored] = await db.batch([
    { sql: "INSERT INTO meta (key, value) VALUES ('ip_hash_salt', :salt) ON CONFLICT(key) DO NOTHING", args: { salt: crypto.randomBytes(32).toString('hex') } },
    "SELECT value FROM meta WHERE key = 'ip_hash_salt'",
  ], 'write');
  return stored.rows[0].value;
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------
export async function findLinkBySlug(db, slug) {
  return db.get('SELECT * FROM links WHERE slug = :slug', { slug: String(slug) });
}

export async function findLinkById(db, id) {
  return db.get('SELECT * FROM links WHERE id = :id', { id });
}

/** Rows for many slugs in one round trip (per 500): Map slug → links row. */
export async function findLinksBySlugs(db, slugs) {
  const unique = [...new Set(slugs.map(String))];
  const found = new Map();
  for (let i = 0; i < unique.length; i += IN_LIST_CHUNK) {
    const chunk = unique.slice(i, i + IN_LIST_CHUNK);
    const rows = await db.all(`SELECT * FROM links WHERE slug IN (${chunk.map(() => '?').join(', ')})`, chunk);
    for (const row of rows) found.set(row.slug, row);
  }
  return found;
}

export async function slugTaken(db, slug) {
  return Boolean(await db.get('SELECT 1 AS x FROM links WHERE slug = :slug', { slug: String(slug) }));
}

/** Which of these slugs are taken, in one round trip (per 500). */
export async function takenSlugs(db, slugs) {
  const unique = [...new Set(slugs.map(String))];
  const taken = new Set();
  for (let i = 0; i < unique.length; i += IN_LIST_CHUNK) {
    const chunk = unique.slice(i, i + IN_LIST_CHUNK);
    const rows = await db.all(`SELECT slug FROM links WHERE slug IN (${chunk.map(() => '?').join(', ')})`, chunk);
    for (const row of rows) taken.add(row.slug);
  }
  return taken;
}

/**
 * @param {object} link snake_case column values (without id/click_count)
 * @returns {Promise<object>} the stored links row
 */
export async function insertLink(db, link) {
  return db.get(`
    INSERT INTO links (slug, domain, target_url, title, manage_token_hash, redirect_mode, teaser_seconds, teaser_style,
                       teaser_message, teaser_theme, expires_at, max_clicks, qr_style, created_at, updated_at)
    VALUES (:slug, :domain, :target_url, :title, :manage_token_hash, :redirect_mode, :teaser_seconds, :teaser_style,
            :teaser_message, :teaser_theme, :expires_at, :max_clicks, :qr_style, :created_at, :updated_at)
    RETURNING *
  `, {
    slug: link.slug,
    domain: link.domain,
    target_url: link.target_url,
    title: link.title ?? null,
    manage_token_hash: link.manage_token_hash,
    redirect_mode: link.redirect_mode,
    teaser_seconds: link.teaser_seconds,
    teaser_style: link.teaser_style,
    teaser_message: link.teaser_message ?? null,
    teaser_theme: link.teaser_theme,
    expires_at: link.expires_at ?? null,
    max_clicks: link.max_clicks ?? null,
    qr_style: link.qr_style ?? null,
    created_at: link.created_at,
    updated_at: link.updated_at,
  });
}

const UPDATABLE_COLUMNS = new Set([
  'domain', 'target_url', 'title', 'redirect_mode', 'teaser_seconds', 'teaser_style', 'teaser_message',
  'teaser_theme', 'expires_at', 'max_clicks', 'qr_style', 'destroyed_at', 'updated_at',
]);

/**
 * Update whitelisted columns of one link.
 * @returns {Promise<object|null>} the updated row (the current row when no column applies), or null when the link is gone
 */
export async function updateLink(db, id, fields) {
  const cols = Object.keys(fields).filter((k) => UPDATABLE_COLUMNS.has(k));
  if (!cols.length) return findLinkById(db, id);
  const params = { id };
  for (const c of cols) params[c] = fields[c] ?? null;
  return db.get(`UPDATE links SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id RETURNING *`, params);
}

/**
 * Delete a link and its clicks atomically, without relying on foreign-key cascades.
 * @returns {Promise<number>} links deleted (0 or 1)
 */
export async function deleteLink(db, id) {
  const [, links] = await db.batch([
    { sql: 'DELETE FROM clicks WHERE link_id = :id', args: { id } },
    { sql: 'DELETE FROM links WHERE id = :id', args: { id } },
  ], 'write');
  return links.rowsAffected;
}

/**
 * Atomically consume one visit (SPEC §4.4 step 6): one guarded UPDATE, checked through rowsAffected.
 * @returns {Promise<{ consumed: boolean, link: object|null }>} the row as it is right after the visit was consumed
 */
export async function consumeVisit(db, id, now) {
  const { rows, rowsAffected } = await db.execute(consumeVisitStatement(id, now));
  return { consumed: rowsAffected === 1, link: rows[0] ?? null };
}

/** The guarded UPDATE behind consumeVisit: it changes (and returns) the row only while the link is active. */
function consumeVisitStatement(id, now) {
  return {
    sql: `
      UPDATE links SET click_count = click_count + 1, updated_at = :now
      WHERE id = :id AND destroyed_at IS NULL
        AND (expires_at IS NULL OR expires_at > :now)
        AND (max_clicks IS NULL OR click_count < max_clicks)
      RETURNING *
    `,
    args: { id, now },
  };
}

/**
 * Consume one visit and store its click row in one write batch: one round trip, and atomic, so a
 * visit is never counted without its click row (or the other way round), even when the request is
 * cancelled halfway. The INSERT only runs when the UPDATE just before it changed the link
 * (`changes() = 1` on the batch's connection), so a lost race stores nothing.
 * @param {object} click the click row (see insertClick), for link `id`
 * @returns {Promise<{ consumed: boolean, link: object|null, click: object|null }>} the link row right
 *   after the visit and the stored click row (both null when the visit was not consumed)
 */
export async function consumeVisitAndRecordClick(db, id, now, click) {
  const insert = insertClickStatement({ ...click, link_id: id });
  const [consumed, stored] = await db.batch([
    consumeVisitStatement(id, now),
    { sql: INSERT_CLICK_AFTER_CONSUME_SQL, args: insert.args },
  ], 'write');
  const ok = consumed.rowsAffected === 1;
  return { consumed: ok, link: ok ? consumed.rows[0] ?? null : null, click: ok ? stored.rows[0] ?? null : null };
}

// ---------------------------------------------------------------------------
// clicks
// ---------------------------------------------------------------------------
const CLICK_COLUMNS = [
  'link_id', 'ts', 'visitor_hash', 'is_unique', 'country', 'region', 'city', 'lat', 'lon', 'device',
  'browser', 'os', 'referrer_host', 'is_bot', 'is_synthetic', 'outcome',
];
const CLICK_VALUE_COLUMNS = CLICK_COLUMNS.filter((c) => c !== 'is_unique');

// One statement, so it is atomic on any connection: `is_unique` is decided against the clicks already
// stored (a counted click whose visitor has no earlier counted click on this link), and nothing is
// inserted when the link no longer exists (whether or not foreign keys are enforced).
const INSERT_CLICK_SQL = `
  INSERT INTO clicks (${CLICK_COLUMNS.join(', ')})
  SELECT :link_id, :ts, :visitor_hash,
         CASE WHEN :check_unique = 1 AND NOT EXISTS (
           SELECT 1 FROM clicks WHERE link_id = :link_id AND visitor_hash = :visitor_hash AND ${COUNTED_CLICK_SQL}
         ) THEN 1 ELSE 0 END,
         ${CLICK_VALUE_COLUMNS.slice(3).map((c) => `:${c}`).join(', ')}
  WHERE EXISTS (SELECT 1 FROM links WHERE id = :link_id)
  RETURNING *
`;

/** INSERT_CLICK_SQL for consumeVisitAndRecordClick: only after the guarded UPDATE before it changed the link. */
const INSERT_CLICK_AFTER_CONSUME_SQL = INSERT_CLICK_SQL.replace('WHERE EXISTS', 'WHERE changes() = 1 AND EXISTS');

/** The insert statement for one click row. */
export function insertClickStatement(click) {
  const args = {};
  for (const c of CLICK_VALUE_COLUMNS) args[c] = click[c] ?? null;
  args.is_bot = click.is_bot ? 1 : 0;
  args.is_synthetic = click.is_synthetic ? 1 : 0;
  args.device = click.device || 'other';
  args.outcome = click.outcome || 'redirect';
  const counted = (args.outcome === 'redirect' || args.outcome === 'teaser') && args.is_bot === 0;
  args.check_unique = counted && args.visitor_hash ? 1 : 0;
  return { sql: INSERT_CLICK_SQL, args };
}

const linkGone = (linkId) => Object.assign(new Error(`link ${linkId} no longer exists`), { code: 'LINK_GONE' });

/**
 * Insert one click row; `is_unique` is computed by the database.
 * @returns {Promise<object>} the stored row (with id)
 * @throws when the link was deleted meanwhile (nothing is stored)
 */
export async function insertClick(db, click) {
  const row = await db.get(insertClickStatement(click));
  if (!row) throw linkGone(click.link_id);
  return row;
}

/**
 * Insert many click rows in order, atomically and in one round trip (each sees the ones before it,
 * so `is_unique` works across the batch).
 * @returns {Promise<object[]>} the stored rows (none when the link is gone)
 */
export async function insertClicks(db, clicks) {
  const results = await db.batch(clicks.map(insertClickStatement), 'write');
  return results.map((r) => r.rows[0]).filter(Boolean);
}

/**
 * `meta` key counting deletions of click rows from links that still exist. Live streams keep running
 * totals (server/live.js) and read this with every poll: when it moves, they recount instead of
 * advancing totals that now include deleted rows. Deleting a whole link needs no bump (its streams end).
 */
export const CLICKS_EPOCH_KEY = 'clicks_epoch';

/** Delete a link's simulated clicks and bump CLICKS_EPOCH_KEY, atomically. @returns {Promise<number>} rows deleted */
export async function deleteSyntheticClicks(db, linkId) {
  const [deleted] = await db.batch([
    { sql: 'DELETE FROM clicks WHERE link_id = :linkId AND is_synthetic = 1', args: { linkId } },
    `INSERT INTO meta (key, value) VALUES ('${CLICKS_EPOCH_KEY}', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  ], 'write');
  return deleted.rowsAffected;
}

/** Timestamp of the last real consumed visit (used for "expired at" on click-limited links). */
export async function lastConsumedClickTs(db, linkId) {
  return (await db.get(`SELECT MAX(ts) AS ts FROM clicks WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND is_synthetic = 0`, { linkId }))?.ts ?? null;
}
