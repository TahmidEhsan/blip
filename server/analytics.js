// Blip: click analytics (UA parsing, bot detection, visitor hashing, ClickEvents and StatsDTO, SPEC §5.4).
import crypto from 'node:crypto';
import uaParser from 'ua-parser-js';
// The package's main entry registers the names of all 78 languages it ships; Blip only shows English,
// so it loads the core and the English names alone (a faster cold start and a smaller function).
import countries from 'i18n-iso-countries/index.js';
import englishCountryNames from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import { CLICKS_EPOCH_KEY, COUNTED_CLICK_SQL } from './db.js';

countries.registerLocale(englishCountryNames);

export const BOT_UA_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|quora link|whatsapp|telegram|discord|slack|skype|linkedin|vkshare|pinterest|bitly|curl|wget|python-requests|httpclient|headless/i;

export const DEVICE_TYPES = Object.freeze(['desktop', 'mobile', 'tablet', 'console', 'tv', 'wearable', 'bot', 'other']);
export const STATS_RANGES = Object.freeze(['24h', '7d', '30d', 'all']);

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Range `all` uses daily buckets for up to this many days, then weekly ones, then monthly ones. */
const ALL_RANGE_MAX_DAYS = 365;
const ALL_RANGE_MAX_WEEKS = 520;
const TOP_N = 8;
const MAX_POINTS = 300;
const RECENT_MAX = 25;

/** Empty UA or any known crawler / unfurler / CLI client. */
export function isBotUA(ua) {
  return !ua || !String(ua).trim() || BOT_UA_RE.test(String(ua));
}

const BROWSER_ALIASES = {
  'Mobile Safari': 'Safari',
  'Mobile Chrome': 'Chrome',
  'Mobile Firefox': 'Firefox',
  'Chrome Headless': 'Chrome',
  'Chrome WebView': 'Chrome WebView',
};
const OS_ALIASES = { 'Mac OS': 'macOS', 'Chromium OS': 'ChromeOS', 'Chrome OS': 'ChromeOS' };
const DEVICE_ALIASES = { mobile: 'mobile', tablet: 'tablet', console: 'console', smarttv: 'tv', wearable: 'wearable', embedded: 'other', xr: 'other' };

/**
 * @param {string} ua
 * @returns {{ device: string, browser: string|null, os: string|null }}
 */
export function parseUserAgent(ua) {
  const raw = typeof ua === 'string' ? ua.slice(0, 512) : '';
  const r = uaParser(raw);
  const browserName = r.browser?.name ? (BROWSER_ALIASES[r.browser.name] ?? r.browser.name) : null;
  const osName = r.os?.name ? (OS_ALIASES[r.os.name] ?? r.os.name) : null;
  let device;
  if (isBotUA(raw)) device = 'bot';
  else if (r.device?.type) device = DEVICE_ALIASES[r.device.type] ?? 'other';
  else device = browserName || osName ? 'desktop' : 'other';
  return { device, browser: browserName ? browserName.slice(0, 40) : null, os: osName ? osName.slice(0, 40) : null };
}

/** sha256(salt + ip + ua), first 24 hex chars: the only per-visitor identifier we keep. */
export function visitorHash(salt, ip, ua) {
  return crypto.createHash('sha256').update(`${salt}\n${ip || ''}\n${ua || ''}`).digest('hex').slice(0, 24);
}

/** Hostname of an http(s) Referer (leading "www." dropped), or null for direct visits. */
export function referrerHost(referer) {
  if (!referer || typeof referer !== 'string') return null;
  try {
    const url = new URL(referer);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return host ? host.slice(0, 120) : null;
  } catch {
    return null;
  }
}

// Friendlier short names where the ISO official name is a mouthful.
const COUNTRY_NAME_OVERRIDES = {
  US: 'United States', RU: 'Russia', IR: 'Iran', TW: 'Taiwan', TZ: 'Tanzania', CZ: 'Czechia', LA: 'Laos',
  MD: 'Moldova', SY: 'Syria', VE: 'Venezuela', BO: 'Bolivia', KR: 'South Korea', KP: 'North Korea',
  VN: 'Vietnam', CD: 'DR Congo', BN: 'Brunei', FM: 'Micronesia', PS: 'Palestine', VA: 'Vatican City',
};

/** `{ code, numeric, name }` for an alpha-2 code (unknown codes keep their code as name). */
export function countryInfo(code) {
  if (!code || !/^[A-Z]{2}$/.test(code)) return { code: null, numeric: null, name: null };
  const numeric = countries.alpha2ToNumeric(code) ?? null;
  const name = COUNTRY_NAME_OVERRIDES[code] ?? countries.getName(code, 'en') ?? code;
  return { code, numeric: numeric ? String(numeric).padStart(3, '0') : null, name };
}

/** DB row → ClickEvent (SPEC §5.4). */
export function clickEventFromRow(row) {
  const info = countryInfo(row.country);
  return {
    id: row.id,
    ts: new Date(row.ts).toISOString(),
    country: info.code,
    countryName: info.name,
    numeric: info.numeric,
    city: row.city ?? null,
    lat: row.lat ?? null,
    lon: row.lon ?? null,
    device: row.device,
    browser: row.browser ?? null,
    os: row.os ?? null,
    referrer: row.referrer_host ?? null,
    isBot: Boolean(row.is_bot),
    isSynthetic: Boolean(row.is_synthetic),
    isUnique: Boolean(row.is_unique),
    outcome: row.outcome,
  };
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/** The two statements behind computeTotals (so buildStats can batch them with its other reads). */
function totalsStatements(linkId, { start = 0, end = Number.MAX_SAFE_INTEGER, now }) {
  return [
    {
      sql: `
        SELECT
          COALESCE(SUM(CASE WHEN ${COUNTED_CLICK_SQL} THEN 1 ELSE 0 END), 0) AS clicks,
          COUNT(DISTINCT CASE WHEN ${COUNTED_CLICK_SQL} THEN visitor_hash END) AS uniqueVisitors,
          COALESCE(SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END), 0) AS botClicks,
          COALESCE(SUM(CASE WHEN outcome = 'expired' THEN 1 ELSE 0 END), 0) AS blockedAfterExpiry,
          COALESCE(SUM(CASE WHEN is_bot = 1 AND outcome = 'expired' THEN 1 ELSE 0 END), 0) AS expiredBotClicks,
          COALESCE(SUM(CASE WHEN ${COUNTED_CLICK_SQL} AND is_synthetic = 1 THEN 1 ELSE 0 END), 0) AS syntheticClicks
        FROM clicks WHERE link_id = :linkId AND ts >= :start AND ts < :end
      `,
      args: { linkId, start, end },
    },
    {
      sql: `SELECT COUNT(*) AS n FROM clicks WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts > :since AND ts <= :now`,
      args: { linkId, since: now - DAY, now },
    },
  ];
}

function totalsFromResults(main, last24h) {
  const row = main.rows[0];
  return {
    clicks: row.clicks,
    uniqueVisitors: row.uniqueVisitors,
    botClicks: row.botClicks,
    blockedAfterExpiry: row.blockedAfterExpiry,
    expiredBotClicks: row.expiredBotClicks,
    last24h: last24h.rows[0].n,
    syntheticClicks: row.syntheticClicks,
  };
}

/**
 * Totals for clicks with `start <= ts < end` (SPEC §5.4) plus a rolling `last24h`, in one round trip.
 * `botClicks` and `blockedAfterExpiry` overlap (a bot hitting an expired link is both);
 * `expiredBotClicks` is that overlap, so "bots & blocked" = botClicks + blockedAfterExpiry − expiredBotClicks.
 * @returns {Promise<{ clicks: number, uniqueVisitors: number, botClicks: number, blockedAfterExpiry: number, expiredBotClicks: number, last24h: number, syntheticClicks: number }>}
 */
export async function computeTotals(db, linkId, { start = 0, end = Number.MAX_SAFE_INTEGER, now }) {
  const [main, last24h] = await db.batch(totalsStatements(linkId, { start, end, now }), 'read');
  return totalsFromResults(main, last24h);
}

/** The live `{ clicks, uniqueVisitors }` of a link: every counted click, or only those up to `throughId`. */
function liveTotalsStatement(linkId, throughId = null) {
  return {
    sql: `
      SELECT COUNT(*) AS clicks, COUNT(DISTINCT visitor_hash) AS uniqueVisitors
      FROM clicks WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL}${throughId === null ? '' : ' AND id <= :throughId'}
    `,
    args: throughId === null ? { linkId } : { linkId, throughId },
  };
}

/** All-time `{ clicks, uniqueVisitors }` attached to live `click` events (a full recount). */
export async function liveTotals(db, linkId) {
  const row = await db.get(liveTotalsStatement(linkId));
  return { clicks: row.clicks, uniqueVisitors: row.uniqueVisitors };
}

/** `{ clicks, uniqueVisitors }` counting only clicks with `id <= throughId` (a live stream's recount). */
export async function liveTotalsThrough(db, linkId, throughId) {
  const row = await db.get(liveTotalsStatement(linkId, throughId));
  return { clicks: row.clicks, uniqueVisitors: row.uniqueVisitors };
}

/** Mirrors COUNTED_CLICK_SQL for a stored row. */
export function isCountedClick(row) {
  return (row.outcome === 'redirect' || row.outcome === 'teaser') && !row.is_bot;
}

// ---------------------------------------------------------------------------
// Time buckets
// ---------------------------------------------------------------------------

/**
 * Parse the `tz` query value (JS getTimezoneOffset minutes: UTC − local).
 * @returns {number|null} null when invalid
 */
export function parseTzOffset(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < -840 || n > 840) return null;
  return n;
}

// The client's time zone arrives as a fixed offset `shift` (ms, UTC − local), so local wall-clock
// time is `utc − shift`. Every helper below returns UTC epoch ms of a local boundary.

/** Start of the local hour/day (`size`) containing `ts`. */
const floorLocal = (ts, size, shift) => Math.floor((ts - shift) / size) * size + shift;

/** Start of the local week (Monday 00:00) containing `ts`. */
function localWeekStart(ts, shift) {
  const day = floorLocal(ts, DAY, shift);
  const dayNumber = Math.round((day - shift) / DAY); // local days since 1970-01-01, a Thursday
  return day - ((((dayNumber + 3) % 7) + 7) % 7) * DAY;
}

/** Local calendar month containing `ts`, as `year * 12 + monthIndex`. */
function localMonthNumber(ts, shift) {
  const local = new Date(ts - shift);
  return local.getUTCFullYear() * 12 + local.getUTCMonth();
}

/** Start of the local calendar month numbered `n` (see localMonthNumber). */
const localMonthStart = (n, shift) => Date.UTC(Math.floor(n / 12), n % 12, 1) + shift;

/** `count` equal buckets of `size` ms, the last one starting at `currentStart`. */
function uniformWindow(bucket, size, currentStart, count) {
  const start = currentStart - (count - 1) * size;
  const starts = Array.from({ length: count }, (_, i) => start + i * size);
  return { bucket, size, starts, start, end: currentStart + size, count };
}

/**
 * Bucket layout for a range, aligned to the client's local time.
 * `24h`: 24 hours; `7d`/`30d`: 7/30 days; `all`: every bucket from the one holding `earliestTs`
 * to the current one, by day for up to ALL_RANGE_MAX_DAYS days, else by week (starting Monday)
 * for up to ALL_RANGE_MAX_WEEKS weeks, else by calendar month.
 * `size` is the bucket length in ms (null for months, which vary); `starts` holds every bucket's start.
 * @returns {{ bucket: 'hour'|'day'|'week'|'month', size: number|null, starts: number[], start: number, end: number, count: number }}
 */
export function rangeWindow(range, now, tzOffsetMinutes, earliestTs) {
  const shift = tzOffsetMinutes * 60_000;
  if (range === '24h') return uniformWindow('hour', HOUR, floorLocal(now, HOUR, shift), 24);
  if (range === '7d' || range === '30d') return uniformWindow('day', DAY, floorLocal(now, DAY, shift), range === '7d' ? 7 : 30);

  const first = Math.min(earliestTs ?? now, now);
  const today = floorLocal(now, DAY, shift);
  const days = Math.round((today - floorLocal(first, DAY, shift)) / DAY) + 1;
  if (days <= ALL_RANGE_MAX_DAYS) return uniformWindow('day', DAY, today, days);

  const thisWeek = localWeekStart(now, shift);
  const weeks = Math.round((thisWeek - localWeekStart(first, shift)) / WEEK) + 1;
  if (weeks <= ALL_RANGE_MAX_WEEKS) return uniformWindow('week', WEEK, thisWeek, weeks);

  const firstMonth = localMonthNumber(first, shift);
  const count = localMonthNumber(now, shift) - firstMonth + 1;
  const starts = Array.from({ length: count }, (_, i) => localMonthStart(firstMonth + i, shift));
  return { bucket: 'month', size: null, starts, start: starts[0], end: localMonthStart(firstMonth + count, shift), count };
}

/** Index of the bucket in `starts` (ascending) that holds `ts`, which must be >= starts[0]. */
function bucketIndex(starts, ts) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Counted clicks per `unit` (an hour for range 24h, else a local day, the finest unit any bucket is
 * made of), numbered from `origin`, which is a local hour or midnight at or before every timestamp
 * it covers. Weeks and months start at local midnight, so each day folds into exactly one bucket.
 */
function timeseriesStatement(linkId, { origin, end, unit }) {
  return {
    sql: `
      SELECT CAST((ts - :origin) / :unit AS INTEGER) AS idx, COUNT(*) AS clicks
      FROM clicks WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts >= :origin AND ts < :end
      GROUP BY idx
    `,
    args: { linkId, origin, end, unit },
  };
}

/** Fold `{ idx, clicks }` rows (see timeseriesStatement) into the window's buckets. */
function foldTimeseries(rows, win, { origin, unit }) {
  const counts = new Array(win.count).fill(0);
  for (const r of rows) {
    const t = origin + r.idx * unit;
    if (t < win.start || t >= win.end) continue;
    const i = win.size === unit ? Math.round((t - win.start) / unit) : bucketIndex(win.starts, t);
    if (i >= 0 && i < win.count) counts[i] += r.clicks;
  }
  return counts;
}

function topWithOther(rows, n = TOP_N) {
  if (rows.length <= n) return rows;
  const head = rows.slice(0, n);
  const other = rows.slice(n).reduce((sum, r) => sum + r.count, 0);
  const existing = head.find((r) => r.name === 'Other');
  if (existing) existing.count += other;
  else head.push({ name: 'Other', count: other });
  return head;
}

function breakdownStatement(linkId, column, scope, fallback) {
  return {
    sql: `
      SELECT COALESCE(${column}, :fallback) AS name, COUNT(*) AS count
      FROM clicks WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts >= :start AND ts < :end
      GROUP BY 1 ORDER BY count DESC, name ASC
    `,
    args: { linkId, start: scope.start, end: scope.end, fallback },
  };
}

const breakdownRows = (result) => result.rows.map((r) => ({ name: r.name, count: r.count }));

/** Every click a link has ever had: range `all` counts with this, never with its (bucketed) window. */
const ALL_TIME = Object.freeze({ start: 0, end: Number.MAX_SAFE_INTEGER });

/**
 * Build the StatsDTO for one link. Every query is independent of the others, so they all run in one
 * read batch: one round trip (and one consistent snapshot) even on a remote database.
 * @param {import('./db.js').Database} db
 * @param {object} link links row
 * @param {{ range?: string, tz?: number, now: number }} opts
 */
export async function buildStats(db, link, { range = '7d', tz = 0, now }) {
  const isAll = range === 'all';
  const shift = tz * 60_000;
  const unit = range === '24h' ? HOUR : DAY;
  // Range `all` needs the earliest click to lay out its buckets, so its days are counted from a local
  // midnight before any timestamp (shift − 1 day is at most 0) and folded in once that is known.
  const fixed = isAll ? null : rangeWindow(range, now, tz);
  const scope = isAll ? ALL_TIME : { start: fixed.start, end: fixed.end };
  const series = isAll ? { origin: shift - DAY, end: Number.MAX_SAFE_INTEGER, unit } : { origin: fixed.start, end: fixed.end, unit };
  const params = { linkId: link.id, start: scope.start, end: scope.end };

  const results = await db.batch([
    ...totalsStatements(link.id, { ...scope, now }),
    timeseriesStatement(link.id, series),
    breakdownStatement(link.id, 'device', scope, 'other'),
    breakdownStatement(link.id, 'browser', scope, 'Unknown'),
    breakdownStatement(link.id, 'os', scope, 'Unknown'),
    breakdownStatement(link.id, 'referrer_host', scope, 'direct'),
    {
      sql: `
        SELECT country, COUNT(*) AS count FROM clicks
        WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts >= :start AND ts < :end AND country IS NOT NULL
        GROUP BY country ORDER BY count DESC, country ASC
      `,
      args: params,
    },
    {
      sql: `
        SELECT ROUND(lat, 1) AS lat, ROUND(lon, 1) AS lon, MAX(city) AS city, MAX(country) AS country, COUNT(*) AS count
        FROM clicks
        WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts >= :start AND ts < :end AND lat IS NOT NULL AND lon IS NOT NULL
        GROUP BY ROUND(lat, 1), ROUND(lon, 1) ORDER BY count DESC LIMIT ${MAX_POINTS}
      `,
      args: params,
    },
    { sql: `SELECT * FROM clicks WHERE link_id = :linkId ORDER BY ts DESC, id DESC LIMIT ${RECENT_MAX}`, args: { linkId: link.id } },
    MAX_CLICK_ID_SQL,
    ...(isAll ? [{ sql: 'SELECT MIN(ts) AS ts FROM clicks WHERE link_id = :linkId', args: { linkId: link.id } }] : []),
  ], 'read');
  const [main, last24h, timeseries, devices, browsers, os, referrers, countryRows, pointRows, recentRows, mark, firstRow] = results;

  let win = fixed;
  if (isAll) {
    // Simulated clicks can predate the link (they are spread over the past week), so the chart
    // starts at whichever came first.
    const first = firstRow.rows[0]?.ts ?? null;
    win = rangeWindow(range, now, tz, first !== null && first < link.created_at ? first : link.created_at);
  }
  const counts = foldTimeseries(timeseries.rows, win, series);

  return {
    slug: link.slug,
    range,
    generatedAt: new Date(now).toISOString(),
    // The highest click id stored when this snapshot was read: every click with an id up to it (and in
    // range) is counted here, so a live `click` event with a larger id is the only kind still to add.
    throughClickId: mark.rows[0].throughId,
    totals: totalsFromResults(main, last24h),
    timeseries: { bucket: win.bucket, points: counts.map((clicks, i) => ({ t: new Date(win.starts[i]).toISOString(), clicks })) },
    devices: breakdownRows(devices),
    browsers: topWithOther(breakdownRows(browsers)),
    os: topWithOther(breakdownRows(os)),
    referrers: topWithOther(breakdownRows(referrers)),
    countries: countryRows.rows.map((r) => {
      const info = countryInfo(r.country);
      return { code: info.code ?? r.country, numeric: info.numeric, name: info.name ?? r.country, count: r.count };
    }),
    points: pointRows.rows.map((r) => ({ lat: r.lat, lon: r.lon, city: r.city ?? null, country: r.country ?? null, count: r.count })),
    recent: recentRows.rows.map(clickEventFromRow),
  };
}

/** Totals for range `all`, as carried by the SSE `hello` event. */
export async function allTimeTotals(db, link, now) {
  return computeTotals(db, link.id, { ...ALL_TIME, now });
}

// ---------------------------------------------------------------------------
// Live streams (server/live.js): one snapshot on connect, then cheap polls
// ---------------------------------------------------------------------------
const MAX_CLICK_ID_SQL = 'SELECT COALESCE(MAX(id), 0) AS throughId FROM clicks';
const CLICKS_EPOCH_SQL = `SELECT value FROM meta WHERE key = '${CLICKS_EPOCH_KEY}'`;
const linkRowStatement = (linkId) => ({ sql: 'SELECT * FROM links WHERE id = :linkId', args: { linkId } });

/**
 * What a live stream starts from, read in one snapshot: the `hello` totals (range `all`), `throughId`
 * (the highest click id stored, which those totals include), the link row (or null once it is deleted)
 * and the clicks epoch (CLICKS_EPOCH_KEY). Click ids only grow, so every later click has a larger id.
 * @returns {Promise<{ totals: ReturnType<typeof totalsFromResults>, throughId: number, link: object|null, epoch: string|null }>}
 */
export async function liveStreamSnapshot(db, linkId, now) {
  const [main, last24h, mark, link, epoch] = await db.batch([
    ...totalsStatements(linkId, { ...ALL_TIME, now }),
    MAX_CLICK_ID_SQL,
    linkRowStatement(linkId),
    CLICKS_EPOCH_SQL,
  ], 'read');
  return {
    totals: totalsFromResults(main, last24h),
    throughId: mark.rows[0].throughId,
    link: link.rows[0] ?? null,
    epoch: epoch.rows[0]?.value ?? null,
  };
}

/**
 * One live-stream poll, in one snapshot (one round trip): the link's clicks stored after `afterId`, in id
 * order (at most `limit`), the highest click id stored now, the link row (null once deleted) and the
 * clicks epoch. `+link_id` keeps SQLite on the primary key, so a poll reads only the rows stored since
 * the last one (from every link) and never the link's whole history.
 * @returns {Promise<{ rows: object[], throughId: number, link: object|null, epoch: string|null }>}
 */
export async function liveStreamPoll(db, linkId, afterId, limit) {
  const [mark, clicks, link, epoch] = await db.batch([
    MAX_CLICK_ID_SQL,
    {
      sql: `SELECT * FROM clicks WHERE id > :afterId AND +link_id = :linkId ORDER BY id LIMIT ${Number(limit)}`,
      args: { afterId, linkId },
    },
    linkRowStatement(linkId),
    CLICKS_EPOCH_SQL,
  ], 'read');
  return { rows: clicks.rows, throughId: mark.rows[0].throughId, link: link.rows[0] ?? null, epoch: epoch.rows[0]?.value ?? null };
}
