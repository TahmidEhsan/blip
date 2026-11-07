// Blip: synthetic demo traffic for previewing the dashboard (SPEC §7.5).
// Synthetic clicks are flagged `is_synthetic = 1`, never touch `click_count`, and can be wiped at any time.
import crypto from 'node:crypto';
import { CITIES } from './data/cities.js';
import { insertClicks } from './db.js';

const DAY = 86_400_000;
// The dashboard's default "7d" range is 7 local calendar days ending today, so it starts at local
// midnight six days ago, i.e. never later than now − 6 days in any time zone. Spreading synthetic
// clicks over the last 6 days keeps every one of them inside that default view.
export const SIMULATE_SPREAD_MS = 6 * DAY;

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
 * Insert synthetic clicks, all at once in one insert, before the response goes out. Nothing is
 * scheduled afterwards: open dashboards pick the rows up from the database and play them back a
 * little apart (server/live.js), whichever server instance they are connected to.
 * @param {{ db: import('./db.js').Database, link: object, count: number, now: number, random: () => number }} opts
 * @returns {Promise<number>} rows inserted (0 when the link was deleted meanwhile)
 */
export async function simulateTraffic({ db, link, count, now, random }) {
  const outcome = link.redirect_mode === 'teaser' ? 'teaser' : 'redirect';
  const rows = generateSyntheticClicks({ linkId: link.id, outcome, count, now, random });
  return (await insertClicks(db, rows)).length;
}
