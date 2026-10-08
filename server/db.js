// Blip: SQLite storage via the built-in node:sqlite DatabaseSync (SPEC §3).
//
// node:sqlite notes (verified on Node 22.17):
//  - named parameters bind from bare object keys (`:slug` ← `{ slug }`); a MISSING key
//    silently binds NULL and an EXTRA key throws, so callers pass exact objects;
//  - booleans and `undefined` cannot be bound, so use 0/1 and null;
//  - run() returns `{ changes, lastInsertRowid }` as plain numbers;
//  - rows are null-prototype objects.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_TEASER_THEME, LEGACY_QR_PRESETS, LEGACY_TEASER_THEMES, TEASER_THEMES, upgradeLegacyQrStyle } from './themes.js';

/**
 * PRAGMA user_version history:
 *   1  initial schema
 *   2  teaser themes and QR presets renamed for the comic redesign (migrateLegacyThemeIds)
 */
const SCHEMA_VERSION = 2;

/** SQL fragment: a click that counts toward totals (real visit, not a bot, not blocked). */
export const COUNTED_CLICK_SQL = `outcome IN ('redirect','teaser') AND is_bot = 0`;

// The partial indexes below reuse COUNTED_CLICK_SQL verbatim: SQLite only picks a partial index when
// the query's WHERE clause contains the index's WHERE terms, so the text must match the queries exactly.
// SCHEMA runs (idempotently) on every open, so existing databases pick up new indexes without a migration.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS links (
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
);
CREATE TABLE IF NOT EXISTS clicks (
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
);
CREATE INDEX IF NOT EXISTS idx_clicks_link_ts ON clicks(link_id, ts);
CREATE INDEX IF NOT EXISTS idx_clicks_link_visitor ON clicks(link_id, visitor_hash);
CREATE INDEX IF NOT EXISTS idx_clicks_link_counted ON clicks(link_id, visitor_hash) WHERE ${COUNTED_CLICK_SQL};
CREATE INDEX IF NOT EXISTS idx_clicks_link_real_ts ON clicks(link_id, ts) WHERE ${COUNTED_CLICK_SQL} AND is_synthetic = 0;
`;

/**
 * Open (creating if needed) the database and run migrations.
 * @param {string} dbPath file path or ':memory:'
 * @returns {DatabaseSync}
 */
export function openDatabase(dbPath) {
  const inMemory = dbPath === ':memory:';
  if (!inMemory) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version >= SCHEMA_VERSION) {
    db.exec(SCHEMA); // idempotent safety net
    return;
  }
  transaction(db, () => {
    db.exec(SCHEMA);
    if (version < 2) migrateLegacyThemeIds(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Rewrite stored teaser themes and QR presets from the first release's ids (aurora, sunset, ...)
 * to the comic redesign's ids. A QR style saved under an old preset id is that preset's old look
 * (gradients, rounded shapes), so it is replaced with the new preset's flat look; the caption and
 * a centre logo the user picked are kept (upgradeLegacyQrStyle in public/assets/js/qr-shared.js).
 * Idempotent: a second run finds nothing to change. A teaser theme that is neither current nor
 * legacy falls back to the default theme. `updated_at` is left alone because nobody edited the link.
 * @returns {{ teaserThemes: number, qrPresets: number }} rows changed
 */
export function migrateLegacyThemeIds(db) {
  const cases = Object.entries(LEGACY_TEASER_THEMES).map(([from, to]) => `WHEN ${sqlString(from)} THEN ${sqlString(to)}`).join(' ');
  const { changes: teaserThemes } = db.prepare(`
    UPDATE links SET teaser_theme = CASE teaser_theme ${cases} ELSE ${sqlString(DEFAULT_TEASER_THEME)} END
    WHERE teaser_theme NOT IN (${TEASER_THEMES.map(sqlString).join(', ')})
  `).run();

  let qrPresets = 0;
  const rewrite = db.prepare('UPDATE links SET qr_style = ? WHERE id = ?');
  for (const row of db.prepare(`SELECT id, qr_style FROM links WHERE qr_style LIKE '%"preset"%'`).all()) {
    let style;
    try {
      style = JSON.parse(row.qr_style);
    } catch {
      continue; // unreadable styles are already ignored when links are serialised
    }
    const legacy = style && typeof style === 'object' && typeof style.preset === 'string' ? LEGACY_QR_PRESETS[style.preset] : undefined;
    if (!legacy) continue;
    qrPresets += rewrite.run(JSON.stringify(upgradeLegacyQrStyle(style)), row.id).changes;
  }
  return { teaserThemes: Number(teaserThemes), qrPresets };
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
const statementCache = new WeakMap();

/** Prepare once per database and reuse. */
export function statement(db, sql) {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

const openTransactions = new WeakSet();

/** Run `fn` inside BEGIN IMMEDIATE ... COMMIT, rolling back on error. Nested calls join the outer transaction. */
export function transaction(db, fn) {
  if (openTransactions.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  openTransactions.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  } finally {
    openTransactions.delete(db);
  }
}

export function isUniqueViolation(err) {
  return Boolean(err) && (err.errcode === 2067 || err.errcode === 1555 || /UNIQUE constraint failed/i.test(err.message || ''));
}

export const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------
export function getMeta(db, key) {
  return statement(db, 'SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  statement(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

/** The configured salt, or one generated once and persisted in `meta`. */
export function ensureIpHashSalt(db, configured) {
  if (configured) return String(configured);
  const existing = getMeta(db, 'ip_hash_salt');
  if (existing) return existing;
  const salt = crypto.randomBytes(32).toString('hex');
  setMeta(db, 'ip_hash_salt', salt);
  return salt;
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------
export function findLinkBySlug(db, slug) {
  return statement(db, 'SELECT * FROM links WHERE slug = ?').get(String(slug)) ?? null;
}

export function findLinkById(db, id) {
  return statement(db, 'SELECT * FROM links WHERE id = ?').get(id) ?? null;
}

export function slugTaken(db, slug) {
  return Boolean(statement(db, 'SELECT 1 AS x FROM links WHERE slug = ?').get(String(slug)));
}

/**
 * @param {object} link snake_case column values (without id/click_count)
 * @returns {number} new link id
 */
export function insertLink(db, link) {
  const { lastInsertRowid } = statement(db, `
    INSERT INTO links (slug, domain, target_url, title, manage_token_hash, redirect_mode, teaser_seconds, teaser_style,
                       teaser_message, teaser_theme, expires_at, max_clicks, qr_style, created_at, updated_at)
    VALUES (:slug, :domain, :target_url, :title, :manage_token_hash, :redirect_mode, :teaser_seconds, :teaser_style,
            :teaser_message, :teaser_theme, :expires_at, :max_clicks, :qr_style, :created_at, :updated_at)
  `).run({
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
  return Number(lastInsertRowid);
}

const UPDATABLE_COLUMNS = new Set([
  'domain', 'target_url', 'title', 'redirect_mode', 'teaser_seconds', 'teaser_style', 'teaser_message',
  'teaser_theme', 'expires_at', 'max_clicks', 'qr_style', 'destroyed_at', 'updated_at',
]);

/** Update whitelisted columns of one link. */
export function updateLink(db, id, fields) {
  const cols = Object.keys(fields).filter((k) => UPDATABLE_COLUMNS.has(k));
  if (!cols.length) return 0;
  const sql = `UPDATE links SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id`;
  const params = { id };
  for (const c of cols) params[c] = fields[c] ?? null;
  return statement(db, sql).run(params).changes;
}

export function deleteLink(db, id) {
  return statement(db, 'DELETE FROM links WHERE id = ?').run(id).changes;
}

/**
 * Atomically consume one visit (SPEC §4.4 step 6).
 * @returns {number} 1 when consumed, 0 when the link is no longer active.
 */
export function consumeVisit(db, id, now) {
  return statement(db, `
    UPDATE links SET click_count = click_count + 1, updated_at = :now
    WHERE id = :id AND destroyed_at IS NULL
      AND (expires_at IS NULL OR expires_at > :now)
      AND (max_clicks IS NULL OR click_count < max_clicks)
  `).run({ id, now }).changes;
}

// ---------------------------------------------------------------------------
// clicks
// ---------------------------------------------------------------------------
const CLICK_COLUMNS = [
  'link_id', 'ts', 'visitor_hash', 'is_unique', 'country', 'region', 'city', 'lat', 'lon', 'device',
  'browser', 'os', 'referrer_host', 'is_bot', 'is_synthetic', 'outcome',
];

/** Has this visitor already produced a counted click on this link? */
export function visitorSeen(db, linkId, visitorHash) {
  if (!visitorHash) return false;
  return Boolean(statement(db, `SELECT 1 AS x FROM clicks WHERE link_id = ? AND visitor_hash = ? AND ${COUNTED_CLICK_SQL} LIMIT 1`).get(linkId, visitorHash));
}

/**
 * Insert one click row. `is_unique` is computed here for counted clicks.
 * @returns {object} the stored row (with id)
 */
export function insertClick(db, click) {
  const row = {};
  for (const c of CLICK_COLUMNS) row[c] = click[c] ?? null;
  row.is_bot = click.is_bot ? 1 : 0;
  row.is_synthetic = click.is_synthetic ? 1 : 0;
  row.device = click.device || 'other';
  row.outcome = click.outcome || 'redirect';
  const counted = (row.outcome === 'redirect' || row.outcome === 'teaser') && row.is_bot === 0;
  row.is_unique = counted && row.visitor_hash && !visitorSeen(db, row.link_id, row.visitor_hash) ? 1 : 0;
  const { lastInsertRowid } = statement(db, `
    INSERT INTO clicks (${CLICK_COLUMNS.join(', ')})
    VALUES (${CLICK_COLUMNS.map((c) => `:${c}`).join(', ')})
  `).run(row);
  return { id: Number(lastInsertRowid), ...row };
}

export function deleteSyntheticClicks(db, linkId) {
  return statement(db, 'DELETE FROM clicks WHERE link_id = ? AND is_synthetic = 1').run(linkId).changes;
}

/** Timestamp of the last real consumed visit (used for "expired at" on click-limited links). */
export function lastConsumedClickTs(db, linkId) {
  return statement(db, `SELECT MAX(ts) AS ts FROM clicks WHERE link_id = ? AND ${COUNTED_CLICK_SQL} AND is_synthetic = 0`).get(linkId)?.ts ?? null;
}
