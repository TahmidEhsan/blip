// Blip: click analytics (UA parsing, bot detection, visitor hashing, ClickEvents and StatsDTO, SPEC §5.4).
import crypto from 'node:crypto';
import uaParser from 'ua-parser-js';
// The package's main entry registers the names of all 78 languages it ships; Blip only shows English,
// so it loads the core and the English names alone (a faster cold start and a smaller function).
import countries from 'i18n-iso-countries/index.js';
import englishCountryNames from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import { AGGREGATION_TIME_LIMIT_MS, CLICKS_EPOCH_KEY, COUNTED_CLICK_FILTER } from './db.js';

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

/** COUNTED_CLICK_FILTER as an aggregation expression. */
const COUNTED_EXPR = { $and: [{ $in: ['$outcome', COUNTED_CLICK_FILTER.outcome.$in] }, { $eq: ['$is_bot', COUNTED_CLICK_FILTER.is_bot] }] };
const IS_BOT_EXPR = { $eq: ['$is_bot', 1] };
const IS_BLOCKED_EXPR = { $eq: ['$outcome', 'expired'] };
const countIf = (expr) => ({ $sum: { $cond: [expr, 1, 0] } });

/** The $facet members behind the totals: every total of the clicks flowing into the $facet except `last24h`. */
const TOTALS_FACETS = Object.freeze({
  counters: [{
    $group: {
      _id: null,
      clicks: countIf(COUNTED_EXPR),
      botClicks: countIf(IS_BOT_EXPR),
      blockedAfterExpiry: countIf(IS_BLOCKED_EXPR),
      expiredBotClicks: countIf({ $and: [IS_BOT_EXPR, IS_BLOCKED_EXPR] }),
      syntheticClicks: countIf({ $and: [COUNTED_EXPR, { $eq: ['$is_synthetic', 1] }] }),
    },
  }],
  visitors: [{ $match: { ...COUNTED_CLICK_FILTER, visitor_hash: { $ne: null } } }, { $group: { _id: '$visitor_hash' } }, { $count: 'n' }],
});

/** After the $facet: the rolling `last24h`, which no window covers exactly, read through the index on its own. */
const last24hLookup = (linkId, now) => ({
  $lookup: {
    from: 'clicks',
    pipeline: [{ $match: { link_id: linkId, ...COUNTED_CLICK_FILTER, ts: { $gt: now - DAY, $lte: now } } }, { $count: 'n' }],
    as: 'last24h',
  },
});

/**
 * Totals (SPEC §5.4) from one aggregation's result, see TOTALS_FACETS and last24hLookup.
 * `botClicks` and `blockedAfterExpiry` overlap (a bot hitting an expired link is both);
 * `expiredBotClicks` is that overlap, so "bots & blocked" = botClicks + blockedAfterExpiry − expiredBotClicks.
 * @returns {{ clicks: number, uniqueVisitors: number, botClicks: number, blockedAfterExpiry: number, expiredBotClicks: number, last24h: number, syntheticClicks: number }}
 */
function totalsFromResult(result) {
  const counters = result.counters[0];
  return {
    clicks: counters?.clicks ?? 0,
    uniqueVisitors: result.visitors[0]?.n ?? 0,
    botClicks: counters?.botClicks ?? 0,
    blockedAfterExpiry: counters?.blockedAfterExpiry ?? 0,
    expiredBotClicks: counters?.expiredBotClicks ?? 0,
    last24h: result.last24h[0]?.n ?? 0,
    syntheticClicks: counters?.syntheticClicks ?? 0,
  };
}

/** The live `{ clicks, uniqueVisitors }` of the counted clicks matching `filter`, in one pass. */
async function countLiveTotals(db, filter) {
  const [row] = await db.collection('clicks').aggregate([
    { $match: { ...filter, ...COUNTED_CLICK_FILTER } },
    { $group: { _id: '$visitor_hash', clicks: { $sum: 1 } } },
    { $group: { _id: null, clicks: { $sum: '$clicks' }, uniqueVisitors: { $sum: { $cond: [{ $eq: ['$_id', null] }, 0, 1] } } } },
  ], { maxTimeMS: AGGREGATION_TIME_LIMIT_MS }).toArray();
  return { clicks: row?.clicks ?? 0, uniqueVisitors: row?.uniqueVisitors ?? 0 };
}

/** All-time `{ clicks, uniqueVisitors }` attached to live `click` events (a full recount). */
export function liveTotals(db, linkId) {
  return countLiveTotals(db, { link_id: linkId });
}

/**
 * `{ clicks, uniqueVisitors }` counting only the clicks a live stream has accounted for: everything at or
 * below `floor`, and the ids in `seen` above it (a stream's recount, server/live.js). A click still on its
 * way, or stored but not read yet, is in neither, so it is counted once, when the stream reads it.
 */
export function liveTotalsThrough(db, linkId, { floor, seen }) {
  return countLiveTotals(db, { link_id: linkId, $or: [{ id: { $lte: floor } }, { id: { $in: seen } }] });
}

/** Mirrors COUNTED_CLICK_FILTER for a stored row. */
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
function timeseriesFacet({ origin, unit }) {
  return [
    { $match: COUNTED_CLICK_FILTER },
    { $group: { _id: { $floor: { $divide: [{ $subtract: ['$ts', origin] }, unit] } }, clicks: { $sum: 1 } } },
  ];
}

/** Fold `{ _id: index, clicks }` rows (see timeseriesFacet) into the window's buckets. */
function foldTimeseries(rows, win, { origin, unit }) {
  const counts = new Array(win.count).fill(0);
  for (const r of rows) {
    const t = origin + r._id * unit;
    if (t < win.start || t >= win.end) continue;
    const i = win.size === unit ? Math.round((t - win.start) / unit) : bucketIndex(win.starts, t);
    if (i >= 0 && i < win.count) counts[i] += r.clicks;
  }
  return counts;
}

/** Counted clicks per value of `field` (`fallback` when it has none). */
const breakdownGroup = (field, fallback) => [
  { $match: COUNTED_CLICK_FILTER },
  { $group: { _id: { $ifNull: [`$${field}`, fallback] }, count: { $sum: 1 } } },
];

/** Every value of `field`, most clicks first (ties by name). */
const fullBreakdownFacet = (field, fallback) => [
  ...breakdownGroup(field, fallback),
  { $sort: { count: -1, _id: 1 } },
];

/**
 * The top values of `field` and the sum and number of all of them. Only those leave the database: a link
 * can have any number of referrer hosts, and a $facet's whole result has to fit in one 16 MB document.
 */
const topBreakdownFacet = (field, fallback) => [
  ...breakdownGroup(field, fallback),
  {
    $group: {
      _id: null,
      rows: { $topN: { n: TOP_N, sortBy: { count: -1, _id: 1 }, output: { name: '$_id', count: '$count' } } },
      total: { $sum: '$count' },
      distinct: { $sum: 1 },
    },
  },
];

/** The top values (see topBreakdownFacet), with the rest folded into "Other". */
function topWithOther(result) {
  const [{ rows, total, distinct } = { rows: [], total: 0, distinct: 0 }] = result;
  if (distinct <= TOP_N) return rows;
  const other = total - rows.reduce((sum, r) => sum + r.count, 0);
  const existing = rows.find((r) => r.name === 'Other');
  if (existing) existing.count += other;
  else rows.push({ name: 'Other', count: other });
  return rows;
}

/** Every click a link has ever had: range `all` counts with this, never with its (bucketed) window. */
const ALL_TIME = Object.freeze({ start: 0, end: Number.MAX_SAFE_INTEGER });

/** The fields of a click the stats need: everything flowing through a $facet counts toward its size limits. */
const STATS_FIELDS = Object.freeze({
  _id: 0, ts: 1, visitor_hash: 1, outcome: 1, is_bot: 1, is_synthetic: 1, device: 1, browser: 1, os: 1, referrer_host: 1, country: 1, city: 1, lat: 1, lon: 1,
});

// ---------------------------------------------------------------------------
// Lookups shared by the aggregations below
// ---------------------------------------------------------------------------

/** The highest click id of any link (the descending end of its index), into `mark`. */
const MAX_CLICK_ID_LOOKUP = Object.freeze({
  $lookup: { from: 'clicks', pipeline: [{ $sort: { id: -1 } }, { $limit: 1 }, { $project: { _id: 0, id: 1 } }], as: 'mark' },
});
const CLICKS_EPOCH_LOOKUP = Object.freeze({ $lookup: { from: 'meta', pipeline: [{ $match: { _id: CLICKS_EPOCH_KEY } }], as: 'epoch' } });

/**
 * Build the StatsDTO for one link in one aggregation, so one round trip: a $facet computes everything about
 * the range's window from one pass over its clicks (the $match uses the index, and only the needed fields
 * flow on), and the lookups after it read what lies outside the window through their own indexes. The
 * highest click id is read last, so it is never below a click these results include.
 * @param {import('./db.js').Database} db
 * @param {object} link the link
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
  const series = isAll ? { origin: shift - DAY, unit } : { origin: fixed.start, unit };
  const linkClicks = { $match: { link_id: link.id } };

  const [result] = await db.collection('clicks').aggregate([
    { $match: { link_id: link.id, ts: { $gte: scope.start, $lt: scope.end } } },
    { $project: STATS_FIELDS },
    {
      $facet: {
        ...TOTALS_FACETS,
        timeseries: timeseriesFacet(series),
        devices: fullBreakdownFacet('device', 'other'),
        browsers: topBreakdownFacet('browser', 'Unknown'),
        os: topBreakdownFacet('os', 'Unknown'),
        referrers: topBreakdownFacet('referrer_host', 'direct'),
        countries: [
          { $match: { ...COUNTED_CLICK_FILTER, country: { $ne: null } } },
          { $group: { _id: '$country', count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
        ],
        points: [
          { $match: { ...COUNTED_CLICK_FILTER, lat: { $ne: null }, lon: { $ne: null } } },
          {
            $group: {
              _id: { lat: { $round: ['$lat', 1] }, lon: { $round: ['$lon', 1] } },
              city: { $max: '$city' },
              country: { $max: '$country' },
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1, '_id.lat': 1, '_id.lon': 1 } },
          { $limit: MAX_POINTS },
        ],
      },
    },
    last24hLookup(link.id, now),
    { $lookup: { from: 'clicks', pipeline: [linkClicks, { $sort: { ts: 1 } }, { $limit: 1 }, { $project: { _id: 0, ts: 1 } }], as: 'first' } },
    { $lookup: { from: 'clicks', pipeline: [linkClicks, { $sort: { ts: -1, id: -1 } }, { $limit: RECENT_MAX }, { $project: { _id: 0 } }], as: 'recent' } },
    MAX_CLICK_ID_LOOKUP,
  ], { maxTimeMS: AGGREGATION_TIME_LIMIT_MS }).toArray();

  let win = fixed;
  if (isAll) {
    // Simulated clicks can predate the link (they are spread over the past week), so the chart
    // starts at whichever came first.
    const first = result.first[0]?.ts ?? null;
    win = rangeWindow(range, now, tz, first !== null && first < link.created_at ? first : link.created_at);
  }
  const counts = foldTimeseries(result.timeseries, win, series);

  return {
    slug: link.slug,
    range,
    generatedAt: new Date(now).toISOString(),
    // The highest click id stored when this snapshot was read: a live `click` event with a larger id is
    // not in it. One that was on its way at that moment can land below this id, and the dashboard's
    // refetch after every `click` event then counts it.
    throughClickId: result.mark[0]?.id ?? 0,
    totals: totalsFromResult(result),
    timeseries: { bucket: win.bucket, points: counts.map((clicks, i) => ({ t: new Date(win.starts[i]).toISOString(), clicks })) },
    devices: result.devices.map((r) => ({ name: r._id, count: r.count })),
    browsers: topWithOther(result.browsers),
    os: topWithOther(result.os),
    referrers: topWithOther(result.referrers),
    countries: result.countries.map((r) => {
      const info = countryInfo(r._id);
      return { code: info.code ?? r._id, numeric: info.numeric, name: info.name ?? r._id, count: r.count };
    }),
    points: result.points.map((r) => ({ lat: r._id.lat, lon: r._id.lon, city: r.city ?? null, country: r.country ?? null, count: r.count })),
    recent: result.recent.map(clickEventFromRow),
  };
}

// ---------------------------------------------------------------------------
// Live streams (server/live.js): one snapshot on connect, then cheap polls
// ---------------------------------------------------------------------------

// Both read the clicks epoch BEFORE the clicks. An aggregation without snapshot read concern reads each
// stage as the data is when that stage runs, and Clear simulated deletes the rows first and moves the epoch
// second (deleteSyntheticClicks). Read in this order, a clear that lands mid-read leaves the older epoch
// beside rows that may still include the deleted clicks, so the stream's next poll sees the epoch move and
// recounts; the other order could pair the new epoch with the old rows, and nothing would ever recount them.

/**
 * What a live stream starts from, in one aggregation (one round trip): the link (or null once it is
 * deleted), the clicks epoch, the `hello` totals (range `all`) and the ids of the link's clicks those
 * totals include (the highest ones, at most `overlap`). Totals and ids come from one pass over the same
 * rows, so they agree whatever is being written meanwhile.
 * @returns {Promise<{ totals: ReturnType<typeof totalsFromResult>, ids: number[], link: object|null, epoch: number|null }>} `ids` newest first
 */
export async function liveStreamSnapshot(db, linkId, now, overlap) {
  const [result] = await db.collection('links').aggregate([
    { $match: { id: linkId } },
    { $project: { _id: 0 } },
    CLICKS_EPOCH_LOOKUP,
    {
      $lookup: {
        from: 'clicks',
        pipeline: [
          { $match: { link_id: linkId } },
          { $project: { _id: 0, id: 1, visitor_hash: 1, outcome: 1, is_bot: 1, is_synthetic: 1 } },
          { $facet: { ...TOTALS_FACETS, ids: [{ $sort: { id: -1 } }, { $limit: overlap }, { $project: { id: 1 } }] } },
        ],
        as: 'snapshot',
      },
    },
    last24hLookup(linkId, now),
  ], { maxTimeMS: AGGREGATION_TIME_LIMIT_MS }).toArray();
  if (!result) return { totals: totalsFromResult({ counters: [], visitors: [], last24h: [] }), ids: [], link: null, epoch: null };
  const { epoch, snapshot: [facets], last24h, ...link } = result;
  return {
    totals: totalsFromResult({ ...facets, last24h }),
    ids: facets.ids.map((row) => row.id),
    link,
    epoch: epoch[0]?.value ?? null,
  };
}

/**
 * One live-stream poll, in one aggregation (one round trip): the link (null once deleted), the clicks epoch
 * and the link's clicks with an id above `afterId` that are not in `exclude`, in id order, at most `limit`.
 * The ids in `exclude` are skipped on the index, so re-reading the ones a stream has seen fetches no documents.
 * @returns {Promise<{ rows: object[], link: object|null, epoch: number|null }>}
 */
export async function liveStreamPoll(db, linkId, { afterId, exclude, limit }) {
  const [result] = await db.collection('links').aggregate([
    { $match: { id: linkId } },
    { $project: { _id: 0 } },
    CLICKS_EPOCH_LOOKUP,
    {
      $lookup: {
        from: 'clicks',
        pipeline: [
          { $match: { link_id: linkId, id: { $gt: afterId, $nin: exclude } } },
          { $sort: { id: 1 } },
          { $limit: limit },
          { $project: { _id: 0 } },
        ],
        as: 'rows',
      },
    },
  ], { maxTimeMS: AGGREGATION_TIME_LIMIT_MS }).toArray();
  if (!result) return { rows: [], link: null, epoch: null };
  const { rows, epoch, ...link } = result;
  return { rows, link, epoch: epoch[0]?.value ?? null };
}
