// Blip: click analytics (UA parsing, bot detection, visitor hashing, ClickEvents and StatsDTO, SPEC §5.4).
import crypto from 'node:crypto';
import uaParser from 'ua-parser-js';
import countries from 'i18n-iso-countries';
import { COUNTED_CLICK_SQL, statement } from './db.js';

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

/**
 * Totals for clicks with `start <= ts < end` (SPEC §5.4) plus a rolling `last24h`.
 * `botClicks` and `blockedAfterExpiry` overlap (a bot hitting an expired link is both);
 * `expiredBotClicks` is that overlap, so "bots & blocked" = botClicks + blockedAfterExpiry − expiredBotClicks.
 * @returns {{ clicks: number, uniqueVisitors: number, botClicks: number, blockedAfterExpiry: number, expiredBotClicks: number, last24h: number, syntheticClicks: number }}
 */
export function computeTotals(db, linkId, { start = 0, end = Number.MAX_SAFE_INTEGER, now }) {
  const row = statement(db, `
    SELECT
      COALESCE(SUM(CASE WHEN ${COUNTED_CLICK_SQL} THEN 1 ELSE 0 END), 0) AS clicks,
      COUNT(DISTINCT CASE WHEN ${COUNTED_CLICK_SQL} THEN visitor_hash END) AS uniqueVisitors,
      COALESCE(SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END), 0) AS botClicks,
      COALESCE(SUM(CASE WHEN outcome = 'expired' THEN 1 ELSE 0 END), 0) AS blockedAfterExpiry,
      COALESCE(SUM(CASE WHEN is_bot = 1 AND outcome = 'expired' THEN 1 ELSE 0 END), 0) AS expiredBotClicks,
      COALESCE(SUM(CASE WHEN ${COUNTED_CLICK_SQL} AND is_synthetic = 1 THEN 1 ELSE 0 END), 0) AS syntheticClicks
    FROM clicks WHERE link_id = :linkId AND ts >= :start AND ts < :end
  `).get({ linkId, start, end });
  const last24h = statement(db, `
    SELECT COUNT(*) AS n FROM clicks WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts > :since AND ts <= :now
  `).get({ linkId, since: now - DAY, now }).n;
  return {
    clicks: row.clicks,
    uniqueVisitors: row.uniqueVisitors,
    botClicks: row.botClicks,
    blockedAfterExpiry: row.blockedAfterExpiry,
    expiredBotClicks: row.expiredBotClicks,
    last24h,
    syntheticClicks: row.syntheticClicks,
  };
}

/** All-time `{ clicks, uniqueVisitors }` attached to live `click` events. */
export function liveTotals(db, linkId) {
  const row = statement(db, `
    SELECT COUNT(*) AS clicks, COUNT(DISTINCT visitor_hash) AS uniqueVisitors
    FROM clicks WHERE link_id = ? AND ${COUNTED_CLICK_SQL}
  `).get(linkId);
  return { clicks: row.clicks, uniqueVisitors: row.uniqueVisitors };
}

/** Mirrors COUNTED_CLICK_SQL for a stored row. */
export function isCountedClick(row) {
  return (row.outcome === 'redirect' || row.outcome === 'teaser') && !row.is_bot;
}

/**
 * Running all-time `{ clicks, uniqueVisitors }` per link, kept only while a live dashboard listens,
 * so a visit never rescans the link's whole click history. Each entry is seeded once from the
 * database (or from the stream's `hello` totals) and then advanced row by row; `is_unique` is
 * computed by insertClick against the same rows COUNT(DISTINCT visitor_hash) sees, so the running
 * numbers stay identical to liveTotals(). Callers must `forget()` a link whenever its clicks are
 * deleted, and when its last listener goes away.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createLiveTotalsTracker(db) {
  const entries = new Map();
  return {
    /** Seed from totals that were just computed from the database (no-op when already tracked). */
    seed(linkId, { clicks, uniqueVisitors }) {
      if (!entries.has(linkId)) entries.set(linkId, { clicks, uniqueVisitors });
    },
    /** Seed from the database when not tracked yet (call before inserting a batch that will be advanced row by row). */
    ensure(linkId) {
      if (!entries.has(linkId)) entries.set(linkId, liveTotals(db, linkId));
      return { ...entries.get(linkId) };
    },
    /**
     * Account for a click row that was just inserted and return the link's all-time totals.
     * Must run synchronously after the insert so a first-time seed already includes the row.
     */
    advance(linkId, row) {
      const entry = entries.get(linkId);
      if (!entry) {
        const fresh = liveTotals(db, linkId);
        entries.set(linkId, fresh);
        return { ...fresh };
      }
      if (isCountedClick(row)) {
        entry.clicks += 1;
        if (row.is_unique) entry.uniqueVisitors += 1;
      }
      return { ...entry };
    },
    forget(linkId) {
      entries.delete(linkId);
    },
    has(linkId) {
      return entries.has(linkId);
    },
    get size() {
      return entries.size;
    },
  };
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
 * Counted clicks per bucket. SQL groups by hour (range 24h) or local day, the finest unit any
 * bucket is made of; weeks and months start at local midnight, so each day folds into exactly one.
 */
function timeseriesCounts(db, linkId, win) {
  const unit = win.bucket === 'hour' ? HOUR : DAY;
  const rows = statement(db, `
    SELECT CAST((ts - :start) / :unit AS INTEGER) AS idx, COUNT(*) AS clicks
    FROM clicks WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts >= :start AND ts < :end
    GROUP BY idx
  `).all({ linkId, start: win.start, end: win.end, unit });
  const counts = new Array(win.count).fill(0);
  for (const r of rows) {
    const i = win.size === unit ? r.idx : bucketIndex(win.starts, win.start + r.idx * unit);
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

function breakdown(db, linkId, column, scope, fallback) {
  const rows = statement(db, `
    SELECT COALESCE(${column}, :fallback) AS name, COUNT(*) AS count
    FROM clicks WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts >= :start AND ts < :end
    GROUP BY 1 ORDER BY count DESC, name ASC
  `).all({ linkId, start: scope.start, end: scope.end, fallback });
  return rows.map((r) => ({ name: r.name, count: r.count }));
}

/** Every click a link has ever had: range `all` counts with this, never with its (bucketed) window. */
const ALL_TIME = Object.freeze({ start: 0, end: Number.MAX_SAFE_INTEGER });

/**
 * Build the StatsDTO for one link.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} link links row
 * @param {{ range?: string, tz?: number, now: number }} opts
 */
export function buildStats(db, link, { range = '7d', tz = 0, now }) {
  let earliest = link.created_at;
  if (range === 'all') {
    // Simulated clicks can predate the link (they are spread over the past week), so the chart
    // starts at whichever came first.
    const first = statement(db, 'SELECT MIN(ts) AS ts FROM clicks WHERE link_id = ?').get(link.id).ts;
    if (first !== null && first < earliest) earliest = first;
  }
  const win = rangeWindow(range, now, tz, earliest);
  const scope = range === 'all' ? ALL_TIME : { start: win.start, end: win.end };
  const params = { linkId: link.id, start: scope.start, end: scope.end };

  const totals = computeTotals(db, link.id, { ...scope, now });

  const counts = timeseriesCounts(db, link.id, win);
  const points = counts.map((clicks, i) => ({ t: new Date(win.starts[i]).toISOString(), clicks }));

  const devices = breakdown(db, link.id, 'device', scope, 'other');
  const browsers = topWithOther(breakdown(db, link.id, 'browser', scope, 'Unknown'));
  const os = topWithOther(breakdown(db, link.id, 'os', scope, 'Unknown'));
  const referrers = topWithOther(breakdown(db, link.id, 'referrer_host', scope, 'direct'));

  const countryRows = statement(db, `
    SELECT country, COUNT(*) AS count FROM clicks
    WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts >= :start AND ts < :end AND country IS NOT NULL
    GROUP BY country ORDER BY count DESC, country ASC
  `).all(params);
  const countriesList = countryRows.map((r) => {
    const info = countryInfo(r.country);
    return { code: info.code ?? r.country, numeric: info.numeric, name: info.name ?? r.country, count: r.count };
  });

  const pointRows = statement(db, `
    SELECT ROUND(lat, 1) AS lat, ROUND(lon, 1) AS lon, MAX(city) AS city, MAX(country) AS country, COUNT(*) AS count
    FROM clicks
    WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts >= :start AND ts < :end AND lat IS NOT NULL AND lon IS NOT NULL
    GROUP BY ROUND(lat, 1), ROUND(lon, 1) ORDER BY count DESC LIMIT ${MAX_POINTS}
  `).all(params);
  const mapPoints = pointRows.map((r) => ({ lat: r.lat, lon: r.lon, city: r.city ?? null, country: r.country ?? null, count: r.count }));

  const recent = statement(db, `SELECT * FROM clicks WHERE link_id = ? ORDER BY ts DESC, id DESC LIMIT ${RECENT_MAX}`)
    .all(link.id)
    .map(clickEventFromRow);

  return {
    slug: link.slug,
    range,
    generatedAt: new Date(now).toISOString(),
    totals,
    timeseries: { bucket: win.bucket, points },
    devices,
    browsers,
    os,
    referrers,
    countries: countriesList,
    points: mapPoints,
    recent,
  };
}

/** Totals for range `all`, as carried by the SSE `hello` event. */
export function allTimeTotals(db, link, now) {
  return computeTotals(db, link.id, { ...ALL_TIME, now });
}
