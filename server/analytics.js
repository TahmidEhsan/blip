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
const MAX_ALL_BUCKETS = 365;
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

/**
 * Bucket layout for a range, aligned to the client's local hours/days.
 * @returns {{ bucket: 'hour'|'day', size: number, start: number, end: number, count: number }}
 */
export function rangeWindow(range, now, tzOffsetMinutes, earliestTs) {
  const shift = tzOffsetMinutes * 60_000; // local = utc − shift
  const size = range === '24h' ? HOUR : DAY;
  const currentStart = Math.floor((now - shift) / size) * size + shift;
  let count;
  if (range === '24h') count = 24;
  else if (range === '7d') count = 7;
  else if (range === '30d') count = 30;
  else {
    const firstStart = Math.floor(((earliestTs ?? now) - shift) / size) * size + shift;
    count = Math.min(MAX_ALL_BUCKETS, Math.max(1, Math.round((currentStart - firstStart) / size) + 1));
  }
  const start = currentStart - (count - 1) * size;
  return { bucket: range === '24h' ? 'hour' : 'day', size, start, end: currentStart + size, count };
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

function breakdown(db, linkId, column, win, fallback) {
  const rows = statement(db, `
    SELECT COALESCE(${column}, :fallback) AS name, COUNT(*) AS count
    FROM clicks WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts >= :start AND ts < :end
    GROUP BY 1 ORDER BY count DESC, name ASC
  `).all({ linkId, start: win.start, end: win.end, fallback });
  return rows.map((r) => ({ name: r.name, count: r.count }));
}

/**
 * Build the StatsDTO for one link.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} link links row
 * @param {{ range?: string, tz?: number, now: number }} opts
 */
export function buildStats(db, link, { range = '7d', tz = 0, now }) {
  let earliest = link.created_at;
  if (range === 'all') {
    const first = statement(db, 'SELECT MIN(ts) AS ts FROM clicks WHERE link_id = ?').get(link.id).ts;
    if (first !== null && first < earliest) earliest = first;
  }
  const win = rangeWindow(range, now, tz, earliest);
  const params = { linkId: link.id, start: win.start, end: win.end };

  const totals = computeTotals(db, link.id, { start: win.start, end: win.end, now });

  const bucketRows = statement(db, `
    SELECT CAST((ts - :start) / :size AS INTEGER) AS idx, COUNT(*) AS clicks
    FROM clicks WHERE link_id = :linkId AND ${COUNTED_CLICK_SQL} AND ts >= :start AND ts < :end
    GROUP BY idx
  `).all({ ...params, size: win.size });
  const counts = new Array(win.count).fill(0);
  for (const r of bucketRows) if (r.idx >= 0 && r.idx < win.count) counts[r.idx] += r.clicks;
  const points = counts.map((clicks, i) => ({ t: new Date(win.start + i * win.size).toISOString(), clicks }));

  const devices = breakdown(db, link.id, 'device', win, 'other');
  const browsers = topWithOther(breakdown(db, link.id, 'browser', win, 'Unknown'));
  const os = topWithOther(breakdown(db, link.id, 'os', win, 'Unknown'));
  const referrers = topWithOther(breakdown(db, link.id, 'referrer_host', win, 'direct'));

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
  return computeTotals(db, link.id, { start: 0, end: Number.MAX_SAFE_INTEGER, now });
}
