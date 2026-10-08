// Blip: synthetic demo traffic for previewing the dashboard (SPEC §7.5).
// Synthetic clicks are flagged `is_synthetic = 1`, never touch `click_count`, and can be wiped at any time.
import crypto from 'node:crypto';
import { CITIES } from './data/cities.js';
import { insertClick, transaction } from './db.js';
import { clickEventFromRow, createLiveTotalsTracker } from './analytics.js';
import { linkChannel, publish } from './bus.js';

const DAY = 86_400_000;
// The dashboard's default "7d" range is 7 local calendar days ending today, so it starts at local
// midnight six days ago, i.e. never later than now − 6 days in any time zone. Spreading synthetic
// clicks over the last 6 days keeps every one of them inside that default view.
export const SIMULATE_SPREAD_MS = 6 * DAY;
export const SIMULATE_STAGGER_MS = 150;

const DEVICE_MIX = [['mobile', 55], ['desktop', 38], ['tablet', 7]];
const PLATFORM_MIX = {
  mobile: [
    ['iOS', 55, [['Safari', 72], ['Chrome', 22], ['Firefox', 6]]],
    ['Android', 45, [['Chrome', 70], ['Samsung Internet', 22], ['Firefox', 8]]],
  ],
  desktop: [
    ['Windows', 55, [['Chrome', 64], ['Edge', 26], ['Firefox', 10]]],
    ['macOS', 35, [['Safari', 46], ['Chrome', 44], ['Firefox', 10]]],
    ['Linux', 10, [['Firefox', 55], ['Chrome', 45]]],
  ],
  tablet: [
    ['iOS', 70, [['Safari', 82], ['Chrome', 18]]],
    ['Android', 30, [['Chrome', 85], ['Samsung Internet', 15]]],
  ],
};
const REFERRER_MIX = [
  [null, 30], ['twitter.com', 14], ['instagram.com', 15], ['news.ycombinator.com', 9],
  ['reddit.com', 12], ['linkedin.com', 8], ['google.com', 12],
];
const CITY_MIX = CITIES.map((c) => [c, c.weight]);

/** Weighted choice from `[value, weight, ...]` tuples. */
export function weightedPick(entries, random) {
  const total = entries.reduce((sum, e) => sum + e[1], 0);
  let r = random() * total;
  for (const entry of entries) {
    r -= entry[1];
    if (r < 0) return entry;
  }
  return entries[entries.length - 1];
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Generate `count` plausible synthetic click rows (oldest first). Pure apart from `random`.
 * @param {{ linkId: number, outcome: 'redirect'|'teaser', count: number, now: number, random: () => number }} opts
 */
export function generateSyntheticClicks({ linkId, outcome, count, now, random }) {
  const visitorPool = [];
  const recentCount = Math.min(count, Math.max(1, Math.ceil(count / 6)));
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const [device] = weightedPick(DEVICE_MIX, random);
    const [os, , browsers] = weightedPick(PLATFORM_MIX[device], random);
    const [browser] = weightedPick(browsers, random);
    const [referrer] = weightedPick(REFERRER_MIX, random);
    const [place] = weightedPick(CITY_MIX, random);
    let visitorHash;
    if (visitorPool.length && random() < 0.2) {
      visitorHash = visitorPool[Math.floor(random() * visitorPool.length)];
    } else {
      visitorHash = crypto.createHash('sha256').update(`synthetic\n${linkId}\n${now}\n${i}\n${random()}`).digest('hex').slice(0, 24);
      visitorPool.push(visitorHash);
    }
    const isRecent = i >= count - recentCount;
    const ts = isRecent ? now : Math.floor(now - SIMULATE_SPREAD_MS + random() * (SIMULATE_SPREAD_MS - 60_000));
    rows.push({
      link_id: linkId,
      ts,
      visitor_hash: visitorHash,
      country: place.country,
      region: null,
      city: place.city,
      lat: round1(place.lat),
      lon: round1(place.lon),
      device,
      browser,
      os,
      referrer_host: referrer,
      is_bot: 0,
      is_synthetic: 1,
      outcome,
    });
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

/**
 * Insert synthetic clicks and, when a live dashboard is listening, schedule staggered `click` events.
 * @param {{
 *   db: import('node:sqlite').DatabaseSync, bus: import('node:events').EventEmitter, link: object, count: number,
 *   now: number, random: () => number, timers: Set<NodeJS.Timeout>,
 *   liveTotals?: ReturnType<typeof createLiveTotalsTracker>,
 * }} opts `liveTotals` is the app's shared running-totals tracker (a throwaway one is used when omitted)
 * @returns {number} rows inserted
 */
export function simulateTraffic({ db, bus, link, count, now, random, timers, liveTotals = createLiveTotalsTracker(db) }) {
  const outcome = link.redirect_mode === 'teaser' ? 'teaser' : 'redirect';
  const rows = generateSyntheticClicks({ linkId: link.id, outcome, count, now, random });
  const listening = bus.listenerCount(linkChannel(link.id)) > 0;
  // Seed the running totals BEFORE inserting, so advancing once per row below lands on the right numbers.
  if (listening) liveTotals.ensure(link.id);
  const stored = transaction(db, () => rows.map((row) => insertClick(db, row)));
  if (!listening) {
    // Nobody is watching: the rows are already in the stats, and a dashboard that opens later
    // gets them through its `hello` totals and stats fetch.
    liveTotals.forget(link.id);
    return stored.length;
  }

  stored.forEach((row, i) => {
    // is_unique was computed against the DB as rows were inserted (oldest first), in this same order.
    const payload = { ...clickEventFromRow(row), totals: liveTotals.advance(link.id, row) };
    const timer = setTimeout(() => {
      timers.delete(timer);
      publish(bus, link.id, 'click', payload);
    }, i * SIMULATE_STAGGER_MS);
    timer.unref?.();
    timers.add(timer);
  });
  return stored.length;
}
