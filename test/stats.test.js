import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { insertClick } from '../server/db.js';
import { liveTotals } from '../server/analytics.js';
import { DAY, HOUR, MINUTE, UA, openStream, startServer } from './helpers.js';

function seededRandom(seed = 42) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

const GB = { 'cf-ipcountry': 'GB', 'cf-ipcity': 'London', 'cf-iplatitude': '51.5074', 'cf-iplongitude': '-0.1278' };
const US = { 'cf-ipcountry': 'US', 'cf-ipcity': 'New York', 'cf-iplatitude': '40.7128', 'cf-iplongitude': '-74.006' };

describe('stats', () => {
  let s;
  let token;
  const slug = 'stats-link';
  // 23:30 UTC: late enough that UTC+1 is already "tomorrow".
  const start = Date.parse('2026-10-07T23:30:00.000Z');

  before(async () => {
    s = await startServer({ startTime: start - 2 * DAY, random: seededRandom(7) });
    ({ manageToken: token } = await s.createLink({ targetUrl: 'https://example.com/stats', slug }));
    // Two days ago: one desktop visit from New York.
    await s.visit(slug, { ua: UA.windowsChrome, headers: { ...US, Referer: 'https://news.ycombinator.com/item?id=1' } });
    // Now: two mobile visits (same person) + one tablet from London, one bot, one expired-link attempt elsewhere.
    s.clock.t = start;
    await s.visit(slug, { ua: UA.iphone, headers: { ...GB, Referer: 'https://twitter.com/x' } });
    await s.visit(slug, { ua: UA.iphone, headers: GB });
    await s.visit(slug, { ua: UA.ipad, headers: GB });
    await s.visit(slug, { ua: UA.googlebot });
  });
  after(() => s.stop());

  const stats = (query = '') => s.request('GET', `/api/links/${slug}/stats${query}`, { token });

  it('returns the StatsDTO shape', async () => {
    const res = await stats();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = res.json;
    assert.deepEqual(Object.keys(body).sort(), ['browsers', 'countries', 'devices', 'generatedAt', 'os', 'points', 'range', 'recent', 'referrers', 'slug', 'timeseries', 'totals'].sort());
    assert.equal(body.slug, slug);
    assert.equal(body.range, '7d');
    assert.equal(body.generatedAt, new Date(start).toISOString());
    assert.deepEqual(Object.keys(body.totals).sort(), ['blockedAfterExpiry', 'botClicks', 'clicks', 'expiredBotClicks', 'last24h', 'syntheticClicks', 'uniqueVisitors'].sort());
  });

  it('counts clicks, uniques, bots and breakdowns', async () => {
    const { json } = await stats('?range=7d');
    assert.deepEqual(json.totals, { clicks: 4, uniqueVisitors: 3, botClicks: 1, blockedAfterExpiry: 0, expiredBotClicks: 0, last24h: 3, syntheticClicks: 0 });
    assert.deepEqual(json.devices, [{ name: 'mobile', count: 2 }, { name: 'desktop', count: 1 }, { name: 'tablet', count: 1 }]);
    assert.deepEqual(json.browsers, [{ name: 'Safari', count: 3 }, { name: 'Chrome', count: 1 }]);
    assert.deepEqual(json.os, [{ name: 'iOS', count: 3 }, { name: 'Windows', count: 1 }]);
    assert.deepEqual(json.referrers, [{ name: 'direct', count: 2 }, { name: 'news.ycombinator.com', count: 1 }, { name: 'twitter.com', count: 1 }]);
    assert.deepEqual(json.countries, [
      { code: 'GB', numeric: '826', name: 'United Kingdom', count: 3 },
      { code: 'US', numeric: '840', name: 'United States', count: 1 },
    ]);
    assert.deepEqual(json.points, [
      { lat: 51.5, lon: -0.1, city: 'London', country: 'GB', count: 3 },
      { lat: 40.7, lon: -74, city: 'New York', country: 'US', count: 1 },
    ]);
    assert.equal(json.recent.length, 5);
    assert.equal(json.recent[0].isBot, true, 'newest first (the bot came last)');
    const event = json.recent[1];
    assert.deepEqual(Object.keys(event).sort(), ['browser', 'city', 'country', 'countryName', 'device', 'id', 'isBot', 'isSynthetic', 'isUnique', 'lat', 'lon', 'numeric', 'os', 'outcome', 'referrer', 'ts'].sort());
    assert.equal(event.country, 'GB');
    assert.equal(event.countryName, 'United Kingdom');
    assert.equal(event.numeric, '826');
    assert.equal(event.device, 'tablet');
    assert.equal(event.outcome, 'redirect');
    assert.equal(event.ts, new Date(start).toISOString());
  });

  it('builds daily buckets aligned to the client time zone', async () => {
    const utc = (await stats('?range=7d&tz=0')).json.timeseries;
    assert.equal(utc.bucket, 'day');
    assert.equal(utc.points.length, 7);
    assert.equal(utc.points[6].t, '2026-10-07T00:00:00.000Z');
    assert.equal(utc.points[0].t, '2026-10-01T00:00:00.000Z');
    assert.equal(utc.points[6].clicks, 3);
    assert.equal(utc.points[4].clicks, 1, 'the visit two days ago');
    assert.equal(utc.points.reduce((sum, p) => sum + p.clicks, 0), 4);

    // UTC+1 (getTimezoneOffset() = -60): 23:30Z is already 00:30 on Oct 8 locally.
    const plusOne = (await stats('?range=7d&tz=-60')).json.timeseries;
    assert.equal(plusOne.points.length, 7);
    assert.equal(plusOne.points[6].t, '2026-10-07T23:00:00.000Z');
    assert.equal(plusOne.points[6].clicks, 3);
    assert.equal(plusOne.points[4].clicks, 1);

    // UTC−5 (offset 300): 18:30 local on Oct 7.
    const minusFive = (await stats('?range=30d&tz=300')).json.timeseries;
    assert.equal(minusFive.points.length, 30);
    assert.equal(minusFive.points[29].t, '2026-10-07T05:00:00.000Z');
    assert.equal(minusFive.points[29].clicks, 3);
  });

  it('builds hourly buckets for 24h and daily buckets since creation for all', async () => {
    const day = (await stats('?range=24h')).json;
    assert.equal(day.timeseries.bucket, 'hour');
    assert.equal(day.timeseries.points.length, 24);
    assert.equal(day.timeseries.points[23].t, '2026-10-07T23:00:00.000Z');
    assert.equal(day.timeseries.points[23].clicks, 3);
    assert.equal(day.totals.clicks, 3, 'range totals only cover the window');
    const india = (await stats('?range=24h&tz=-330')).json.timeseries;
    assert.equal(india.points[23].t, '2026-10-07T23:30:00.000Z');
    const all = (await stats('?range=all')).json;
    assert.equal(all.timeseries.points.length, 3, 'from creation day (Oct 5) to today');
    assert.equal(all.timeseries.points[0].t, '2026-10-05T00:00:00.000Z');
    assert.equal(all.totals.clicks, 4);
  });

  it('validates range and tz', async () => {
    const badRange = await stats('?range=1y');
    assert.equal(badRange.status, 400);
    assert.equal(badRange.json.error.field, 'range');
    const badTz = await stats('?tz=lots');
    assert.equal(badTz.status, 400);
    assert.equal(badTz.json.error.field, 'tz');
  });

  it('counts blocked attempts after expiry', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/once', slug: 'stats-once', maxClicks: 1 });
    await s.visit('stats-once');
    await s.visit('stats-once');
    await s.visit('stats-once');
    const { json } = await s.request('GET', '/api/links/stats-once/stats', { token: manageToken });
    assert.equal(json.totals.clicks, 1);
    assert.equal(json.totals.blockedAfterExpiry, 2);
    assert.equal(json.totals.expiredBotClicks, 0);
    assert.deepEqual(json.recent.map((e) => e.outcome), ['expired', 'expired', 'redirect']);
  });

  it('reports the bot/blocked overlap so "bots & blocked" never double-counts', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/overlap', slug: 'stats-overlap', maxClicks: 1 });
    await s.visit('stats-overlap', { ua: UA.googlebot }); // bot preview: bot, not blocked
    await s.visit('stats-overlap'); // consumes the only click
    await s.visit('stats-overlap', { ua: UA.googlebot }); // bot on an expired link: bot AND blocked
    await s.visit('stats-overlap'); // person on an expired link: blocked only
    const { json } = await s.request('GET', '/api/links/stats-overlap/stats', { token: manageToken });
    assert.equal(json.totals.clicks, 1);
    assert.equal(json.totals.botClicks, 2);
    assert.equal(json.totals.blockedAfterExpiry, 2);
    assert.equal(json.totals.expiredBotClicks, 1);
    const botsAndBlocked = json.totals.botClicks + json.totals.blockedAfterExpiry - json.totals.expiredBotClicks;
    assert.equal(botsAndBlocked, 3, 'three distinct non-counted requests');
  });

  it('simulated traffic is flagged, never consumes clicks and can be cleared', async () => {
    const before = (await s.request('GET', `/api/links/${slug}`, { token })).json.link.clickCount;
    const res = await s.request('POST', `/api/links/${slug}/simulate`, { token, body: { count: 30 } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { inserted: 30 });
    const after = (await s.request('GET', `/api/links/${slug}`, { token })).json.link.clickCount;
    assert.equal(after, before, 'click_count untouched');

    const all = (await stats('?range=all')).json;
    assert.equal(all.totals.syntheticClicks, 30);
    assert.equal(all.totals.clicks, 34);
    const devices = Object.fromEntries(all.devices.map((d) => [d.name, d.count]));
    assert.ok(devices.mobile > 0 && devices.desktop > 0);
    assert.ok(all.countries.length >= 2);
    assert.ok(all.points.length >= 2);
    for (const p of all.points) {
      assert.ok(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
      assert.equal(p.lat, Math.round(p.lat * 10) / 10);
    }
    const synthetic = s.db.prepare('SELECT MIN(ts) AS lo, MAX(ts) AS hi, COUNT(*) AS n FROM clicks WHERE is_synthetic = 1').get();
    assert.equal(synthetic.n, 30);
    assert.ok(synthetic.lo >= start - 7 * DAY);
    assert.equal(synthetic.hi, start, 'the last few land at now()');
    assert.ok(all.referrers.every((r) => ['direct', 'twitter.com', 'instagram.com', 'news.ycombinator.com', 'reddit.com', 'linkedin.com', 'google.com', 'Other'].includes(r.name)));

    const bad = await s.request('POST', `/api/links/${slug}/simulate`, { token, body: { count: 51 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.field, 'count');
    const defaults = await s.request('POST', `/api/links/${slug}/simulate`, { token, body: {} });
    assert.deepEqual(defaults.json, { inserted: 12 });

    const cleared = await s.request('DELETE', `/api/links/${slug}/simulated`, { token });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.json, { deleted: 42 });
    const afterClear = (await stats('?range=all')).json.totals;
    assert.equal(afterClear.syntheticClicks, 0);
    assert.equal(afterClear.clicks, 4);
  });
});

describe('breakdowns', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.stop());

  it('keeps the top 8 browsers, OSes and referrers and folds the rest into "Other"', async () => {
    const { link, manageToken } = await s.createLink({ targetUrl: 'https://example.com/many', slug: 'many' });
    const linkId = s.db.prepare('SELECT id FROM links WHERE slug = ?').get(link.slug).id;
    // 11 distinct values with counts 12, 11, …, 2 (and a bot + a blocked row that must not count).
    for (let i = 0; i < 11; i += 1) {
      for (let n = 0; n < 12 - i; n += 1) {
        insertClick(s.db, {
          link_id: linkId, ts: s.clock.t, visitor_hash: `v${i}-${n}`, device: 'desktop',
          browser: `Browser ${String.fromCharCode(65 + i)}`, os: `OS ${String.fromCharCode(65 + i)}`,
          referrer_host: i === 0 ? null : `site${i}.example`, is_bot: 0, is_synthetic: 0, outcome: 'redirect',
        });
      }
    }
    insertClick(s.db, { link_id: linkId, ts: s.clock.t, device: 'bot', browser: 'Browser Z', is_bot: 1, outcome: 'redirect' });
    insertClick(s.db, { link_id: linkId, ts: s.clock.t, device: 'desktop', browser: 'Browser Y', outcome: 'expired' });

    const { json } = await s.request('GET', `/api/links/${link.slug}/stats`, { token: manageToken });
    assert.equal(json.totals.clicks, 77);
    for (const list of [json.browsers, json.os, json.referrers]) {
      assert.equal(list.length, 9);
      assert.deepEqual(list.map((r) => r.count), [12, 11, 10, 9, 8, 7, 6, 5, 9]);
      assert.equal(list[8].name, 'Other');
      assert.equal(list.reduce((sum, r) => sum + r.count, 0), 77);
    }
    assert.equal(json.browsers[0].name, 'Browser A');
    assert.equal(json.referrers[0].name, 'direct');
    assert.ok(!json.browsers.some((b) => b.name === 'Browser Z' || b.name === 'Browser Y'), 'bots and blocked visits are excluded');
    assert.deepEqual(json.devices, [{ name: 'desktop', count: 77 }], 'devices are never folded');
  });
});

describe('simulated traffic and the default 7d view', () => {
  let s;
  // 00:30 UTC: early in the UTC day, when the 7d window's first local midnight is closest to now − 7 days.
  const start = Date.parse('2026-10-07T00:30:00.000Z');
  before(async () => {
    s = await startServer({ startTime: start, random: seededRandom(3) });
  });
  after(() => s.stop());

  it('every simulated click shows up in the 7d range, in any time zone', async () => {
    const { link, manageToken } = await s.createLink({ targetUrl: 'https://example.com/sim-window', slug: 'sim-window' });
    for (let i = 0; i < 4; i += 1) {
      const res = await s.request('POST', `/api/links/${link.slug}/simulate`, { token: manageToken, body: { count: 50 } });
      assert.deepEqual(res.json, { inserted: 50 });
    }
    for (const tz of [0, -60, -330, -840, 300, 720]) {
      const { json } = await s.request('GET', `/api/links/${link.slug}/stats?range=7d&tz=${tz}`, { token: manageToken });
      assert.equal(json.totals.syntheticClicks, 200, `tz=${tz}`);
      assert.equal(json.timeseries.points.reduce((sum, p) => sum + p.clicks, 0), 200, `tz=${tz}`);
    }
    const span = s.db.prepare('SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM clicks WHERE is_synthetic = 1').get();
    assert.ok(span.lo >= start - 6 * DAY);
    assert.equal(span.hi, start);
  });
});

describe('simulated traffic disabled', () => {
  let s;
  before(async () => {
    s = await startServer({ config: { allowDemoTraffic: false } });
  });
  after(() => s.stop());

  it('POST /simulate answers 404 not_found and /api/config says so', async () => {
    const { link, manageToken } = await s.createLink({ targetUrl: 'https://example.com/x' });
    const res = await s.request('POST', `/api/links/${link.slug}/simulate`, { token: manageToken, body: { count: 5 } });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'not_found');
    assert.equal((await s.request('GET', '/api/config')).json.allowDemoTraffic, false);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM clicks').get().n, 0);
  });
});

describe('live stream (SSE)', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.stop());

  it('requires a token', async () => {
    const res = await s.request('GET', '/api/links/whatever/stream');
    assert.equal(res.status, 401);
  });

  it('sends hello, click and status events', async () => {
    const { link, manageToken } = await s.createLink({ targetUrl: 'https://example.com/live', slug: 'live', maxClicks: 2 });
    await s.visit('live', { ua: UA.macFirefox });
    const stream = await openStream(s.base, 'live', manageToken);
    try {
      assert.equal(stream.status, 200);
      assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      assert.equal(stream.headers.get('cache-control'), 'no-store');
      assert.equal(stream.headers.get('x-accel-buffering'), 'no');

      const hello = await stream.next((e) => e.event === 'hello');
      assert.equal(hello.data.slug, link.slug);
      assert.deepEqual(hello.data.totals, { clicks: 1, uniqueVisitors: 1, botClicks: 0, blockedAfterExpiry: 0, expiredBotClicks: 0, last24h: 1, syntheticClicks: 0 });

      await s.visit('live', { ua: UA.iphone, headers: { 'cf-ipcountry': 'DE' } });
      const click = await stream.next((e) => e.event === 'click');
      assert.equal(click.data.country, 'DE');
      assert.equal(click.data.countryName, 'Germany');
      assert.equal(click.data.device, 'mobile');
      assert.equal(click.data.outcome, 'redirect');
      assert.equal(click.data.isUnique, true);
      assert.deepEqual(click.data.totals, { clicks: 2, uniqueVisitors: 2 });

      // That was the last allowed click → status event.
      const status = await stream.next((e) => e.event === 'status');
      assert.deepEqual(status.data, { status: 'expired', expiredReason: 'clicks', clickCount: 2, clicksRemaining: 0 });

      // Blocked attempts are streamed too.
      await s.visit('live');
      const blocked = await stream.next((e) => e.event === 'click');
      assert.equal(blocked.data.outcome, 'expired');

      await s.request('POST', '/api/links/live/destroy', { token: manageToken, body: {} });
      const destroyed = await stream.next((e) => e.event === 'status');
      assert.equal(destroyed.data.status, 'destroyed');
      assert.equal(destroyed.data.expiredReason, 'manual');
      await s.request('POST', '/api/links/live/revive', { token: manageToken, body: {} });
      const revived = await stream.next((e) => e.event === 'status');
      assert.equal(revived.data.status, 'expired', 'revive clears the manual destroy; the click limit still applies');
    } finally {
      stream.close();
    }
  });

  it('streams simulated clicks staggered with running totals', async () => {
    const { link, manageToken } = await s.createLink({ targetUrl: 'https://example.com/sim', slug: 'sim-live' });
    const stream = await openStream(s.base, link.slug, manageToken);
    try {
      await stream.next((e) => e.event === 'hello');
      const started = Date.now();
      const res = await s.request('POST', `/api/links/${link.slug}/simulate`, { token: manageToken, body: { count: 3 } });
      assert.deepEqual(res.json, { inserted: 3 });
      const events = [];
      for (let i = 0; i < 3; i += 1) events.push(await stream.next((e) => e.event === 'click'));
      assert.ok(Date.now() - started >= 250, 'events are staggered ~150 ms apart');
      assert.ok(events.every((e) => e.data.isSynthetic === true));
      assert.deepEqual(events.map((e) => e.data.totals.clicks), [1, 2, 3]);
    } finally {
      stream.close();
    }
  });

  it('PATCHing limits re-expires or revives a link and streams the status change', async () => {
    const { link, manageToken: token } = await s.createLink({ targetUrl: 'https://example.com/patchy', slug: 'patchy', maxClicks: 5 });
    await s.visit(link.slug);
    await s.visit(link.slug, { ua: UA.iphone });
    const stream = await openStream(s.base, link.slug, token);
    try {
      await stream.next((e) => e.event === 'hello');

      const lowered = await s.request('PATCH', `/api/links/${link.slug}`, { token, body: { maxClicks: 1 } });
      assert.equal(lowered.status, 200);
      assert.equal(lowered.json.link.status, 'expired');
      assert.equal(lowered.json.link.expiredReason, 'clicks');
      assert.equal(lowered.json.link.clicksRemaining, 0);
      const expired = await stream.next((e) => e.event === 'status');
      assert.deepEqual(expired.data, { status: 'expired', expiredReason: 'clicks', clickCount: 2, clicksRemaining: 0 });
      assert.equal((await s.visit(link.slug)).status, 410);

      const raised = await s.request('PATCH', `/api/links/${link.slug}`, { token, body: { maxClicks: 10 } });
      assert.equal(raised.json.link.status, 'active');
      const active = await stream.next((e) => e.event === 'status');
      assert.deepEqual(active.data, { status: 'active', expiredReason: null, clickCount: 2, clicksRemaining: 8 });
      assert.equal((await s.visit(link.slug)).status, 302);

      // A PATCH that doesn't change the status sends no status event.
      await s.request('PATCH', `/api/links/${link.slug}`, { token, body: { title: 'Still going' } });
      await assert.rejects(stream.next((e) => e.event === 'status', 200), /Timed out/);
    } finally {
      stream.close();
    }

    const { manageToken: timedToken } = await s.createLink({ targetUrl: 'https://example.com/timed-patch', slug: 'timed-patch', expiresInSeconds: 60 });
    s.advance(MINUTE + 1000);
    assert.equal((await s.visit('timed-patch')).status, 410);
    const timedStream = await openStream(s.base, 'timed-patch', timedToken);
    try {
      await timedStream.next((e) => e.event === 'hello');
      const extended = await s.request('PATCH', '/api/links/timed-patch', { token: timedToken, body: { expiresInSeconds: 3600 } });
      assert.equal(extended.json.link.status, 'active');
      assert.equal(extended.json.link.expiresAt, new Date(s.clock.t + HOUR).toISOString());
      const revived = await timedStream.next((e) => e.event === 'status');
      assert.deepEqual(revived.data, { status: 'active', expiredReason: null, clickCount: 0, clicksRemaining: null });
      assert.equal((await s.visit('timed-patch')).status, 302);
    } finally {
      timedStream.close();
    }
  });

  it('live totals stay exact across real, repeat, bot, blocked and simulated clicks', async () => {
    const { link, manageToken: token } = await s.createLink({ targetUrl: 'https://example.com/tally', slug: 'tally', maxClicks: 4 });
    const linkId = s.db.prepare('SELECT id FROM links WHERE slug = ?').get('tally').id;
    await s.visit('tally', { ua: UA.macFirefox });
    assert.equal(s.liveTotals.has(linkId), false, 'no running totals while nobody is watching');

    const stream = await openStream(s.base, link.slug, token);
    const nextClick = () => stream.next((e) => e.event === 'click');
    try {
      const hello = await stream.next((e) => e.event === 'hello');
      assert.equal(hello.data.totals.clicks, 1);
      assert.equal(s.liveTotals.has(linkId), true, 'seeded from the hello totals');

      await s.visit('tally', { ua: UA.iphone });
      assert.deepEqual((await nextClick()).data.totals, { clicks: 2, uniqueVisitors: 2 });
      await s.visit('tally', { ua: UA.iphone }); // same visitor again
      assert.deepEqual((await nextClick()).data.totals, { clicks: 3, uniqueVisitors: 2 });
      await s.visit('tally', { ua: UA.slackbot }); // bot preview: logged, not counted
      const bot = await nextClick();
      assert.equal(bot.data.outcome, 'bot-preview');
      assert.deepEqual(bot.data.totals, { clicks: 3, uniqueVisitors: 2 });

      const sim = await s.request('POST', `/api/links/${link.slug}/simulate`, { token, body: { count: 4 } });
      assert.deepEqual(sim.json, { inserted: 4 });
      const simulated = [];
      for (let i = 0; i < 4; i += 1) simulated.push((await nextClick()).data.totals.clicks);
      assert.deepEqual(simulated, [4, 5, 6, 7]);

      await s.visit('tally', { ua: UA.ipad }); // last real click (4 of 4)
      const last = await nextClick();
      assert.equal(last.data.totals.clicks, 8);
      await s.visit('tally', { ua: UA.windowsChrome }); // blocked: not counted
      const blocked = await nextClick();
      assert.equal(blocked.data.outcome, 'expired');
      assert.deepEqual(blocked.data.totals, liveTotals(s.db, linkId), 'running totals equal a full recount');

      // Clearing simulated clicks drops the running totals; the next event recounts from the database.
      await s.request('DELETE', `/api/links/${link.slug}/simulated`, { token });
      assert.equal(s.liveTotals.has(linkId), false);
      await s.visit('tally', { ua: UA.iphone });
      const afterClear = await nextClick();
      assert.deepEqual(afterClear.data.totals, { clicks: 4, uniqueVisitors: 3 });
      assert.deepEqual(afterClear.data.totals, liveTotals(s.db, linkId));
    } finally {
      stream.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(s.liveTotals.has(linkId), false, 'forgotten when the last dashboard disconnects');
  });

  it('ends the stream when the link is deleted and stops listening on disconnect', async () => {
    const { link, manageToken } = await s.createLink({ targetUrl: 'https://example.com/bye', slug: 'bye' });
    const first = await openStream(s.base, link.slug, manageToken);
    await first.next((e) => e.event === 'hello');
    const listenersBefore = s.bus.listenerCount('link:' + s.db.prepare('SELECT id FROM links WHERE slug = ?').get('bye').id);
    assert.equal(listenersBefore, 1);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const id = s.db.prepare('SELECT id FROM links WHERE slug = ?').get('bye').id;
    assert.equal(s.bus.listenerCount(`link:${id}`), 0, 'listener removed after client disconnect');

    const second = await openStream(s.base, link.slug, manageToken);
    await second.next((e) => e.event === 'hello');
    await s.request('DELETE', `/api/links/${link.slug}`, { token: manageToken });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(s.bus.listenerCount(`link:${id}`), 0, 'stream ended on delete');
    second.close();
  });
});

describe('live stream limits', () => {
  let s;
  before(async () => {
    s = await startServer({ streamLimits: { perLink: 2, perClient: 3 } });
  });
  after(() => s.stop());

  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  it('caps concurrent streams per link and per client with 429 + Retry-After, and frees slots on disconnect', async () => {
    const a = await s.createLink({ targetUrl: 'https://example.com/cap-a', slug: 'cap-a' });
    const b = await s.createLink({ targetUrl: 'https://example.com/cap-b', slug: 'cap-b' });
    const open = [];
    try {
      for (let i = 0; i < 2; i += 1) {
        const stream = await openStream(s.base, 'cap-a', a.manageToken);
        open.push(stream);
        assert.equal(stream.status, 200);
        await stream.next((e) => e.event === 'hello');
      }
      const tooManyForLink = await s.request('GET', '/api/links/cap-a/stream', { token: a.manageToken });
      assert.equal(tooManyForLink.status, 429);
      assert.equal(tooManyForLink.json.error.code, 'rate_limited');
      assert.ok(Number(tooManyForLink.headers.get('retry-after')) > 0);

      // Another link still has room until this client's overall cap (3) is reached.
      const third = await openStream(s.base, 'cap-b', b.manageToken);
      open.push(third);
      assert.equal(third.status, 200);
      await third.next((e) => e.event === 'hello');
      const tooManyForClient = await s.request('GET', '/api/links/cap-b/stream', { token: b.manageToken });
      assert.equal(tooManyForClient.status, 429);

      // Unauthorised requests are rejected before the cap is consulted.
      assert.equal((await s.request('GET', '/api/links/cap-b/stream', { token: 'nope' })).status, 403);

      // Closing one frees a slot.
      open.shift().close();
      await settle();
      const again = await openStream(s.base, 'cap-a', a.manageToken);
      open.push(again);
      assert.equal(again.status, 200);
      await again.next((e) => e.event === 'hello');
    } finally {
      for (const stream of open) stream.close();
    }
    await settle();
    // Every slot is released once all dashboards disconnect.
    const fresh = await openStream(s.base, 'cap-b', b.manageToken);
    try {
      assert.equal(fresh.status, 200);
    } finally {
      fresh.close();
    }
  });
});

describe('time range edge cases', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.stop());

  it('clicks older than the window are excluded and last24h is rolling', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/old', slug: 'old-clicks' });
    await s.visit('old-clicks');
    s.advance(25 * HOUR);
    await s.visit('old-clicks', { ua: UA.iphone });
    const day = (await s.request('GET', '/api/links/old-clicks/stats?range=24h', { token: manageToken })).json;
    assert.equal(day.totals.clicks, 1);
    assert.equal(day.totals.last24h, 1);
    const week = (await s.request('GET', '/api/links/old-clicks/stats?range=7d', { token: manageToken })).json;
    assert.equal(week.totals.clicks, 2);
    assert.equal(week.totals.last24h, 1);
  });
});

describe('range all on long-lived links', () => {
  const WEEK = 7 * DAY;

  /** Create a link at `created`, visit it then and again at `later`, and return a stats reader. */
  async function twoVisits(created, later, slug) {
    const s = await startServer({ startTime: created });
    const { manageToken: token } = await s.createLink({ targetUrl: `https://example.com/${slug}`, slug });
    await s.visit(slug, { ua: UA.windowsChrome, headers: { ...US, Referer: 'https://news.ycombinator.com/item?id=2' } });
    s.clock.t = later;
    await s.visit(slug, { ua: UA.iphone, headers: GB });
    const stats = async (query) => (await s.request('GET', `/api/links/${slug}/stats${query}`, { token })).json;
    return { s, stats };
  }

  const sum = (points) => points.reduce((total, p) => total + p.clicks, 0);

  it('counts every click since creation and buckets two years by week', async () => {
    // Created on a Wednesday; the second visit lands on a Sunday at 23:30 UTC, two years later.
    const { s, stats } = await twoVisits(Date.parse('2024-10-09T12:00:00.000Z'), Date.parse('2026-10-11T23:30:00.000Z'), 'two-years');
    try {
      const all = await stats('?range=all');
      assert.equal(all.totals.clicks, 2, 'the visit from two years ago still counts');
      assert.equal(all.totals.uniqueVisitors, 2);
      assert.deepEqual(all.devices, [{ name: 'desktop', count: 1 }, { name: 'mobile', count: 1 }]);
      assert.deepEqual(all.browsers, [{ name: 'Chrome', count: 1 }, { name: 'Safari', count: 1 }]);
      assert.deepEqual(all.referrers, [{ name: 'direct', count: 1 }, { name: 'news.ycombinator.com', count: 1 }]);
      assert.deepEqual(all.countries.map((c) => [c.code, c.count]), [['GB', 1], ['US', 1]]);
      assert.deepEqual(all.points.map((p) => p.city).sort(), ['London', 'New York']);

      const ts = all.timeseries;
      assert.equal(ts.bucket, 'week');
      assert.equal(ts.points.length, 105);
      assert.equal(ts.points[0].t, '2024-10-07T00:00:00.000Z', 'the Monday of the creation week');
      assert.equal(ts.points.at(-1).t, '2026-10-05T00:00:00.000Z', 'the Monday of this week');
      assert.equal(ts.points[0].clicks, 1);
      assert.equal(ts.points.at(-1).clicks, 1);
      assert.equal(sum(ts.points), 2);
      for (let i = 1; i < ts.points.length; i += 1) {
        assert.equal(Date.parse(ts.points[i].t) - Date.parse(ts.points[i - 1].t), WEEK);
      }

      const week = await stats('?range=7d');
      assert.equal(week.totals.clicks, 1, 'shorter ranges still cover only their window');
      assert.equal(week.timeseries.bucket, 'day');

      // UTC+1: Monday Oct 12 has already begun, so the latest visit opens a new week.
      const east = (await stats('?range=all&tz=-60')).timeseries;
      assert.equal(east.bucket, 'week');
      assert.equal(east.points.length, 106);
      assert.equal(east.points[0].t, '2024-10-06T23:00:00.000Z');
      assert.equal(east.points.at(-1).t, '2026-10-11T23:00:00.000Z');
      assert.equal(east.points.at(-1).clicks, 1);
      assert.equal(east.points.at(-2).clicks, 0);
      assert.equal(sum(east.points), 2);

      // UTC-5: still Sunday evening, in the week of Oct 5.
      const west = (await stats('?range=all&tz=300')).timeseries;
      assert.equal(west.points.length, 105);
      assert.equal(west.points[0].t, '2024-10-07T05:00:00.000Z');
      assert.equal(west.points.at(-1).t, '2026-10-05T05:00:00.000Z');
      assert.equal(west.points.at(-1).clicks, 1);
      assert.equal(sum(west.points), 2);
    } finally {
      await s.stop();
    }
  });

  it('switches to calendar months for a twelve-year span, aligned to the client time zone', async () => {
    // First visit at 02:00 UTC on Oct 1 (still Sep 30 in UTC-5); the latest at 22:30 UTC on Sep 30 (already Oct 1 in UTC+2).
    const { s, stats } = await twoVisits(Date.parse('2014-10-01T02:00:00.000Z'), Date.parse('2026-09-30T22:30:00.000Z'), 'twelve-years');
    try {
      const all = await stats('?range=all');
      assert.equal(all.totals.clicks, 2);
      assert.equal(all.totals.uniqueVisitors, 2);
      assert.equal(all.countries.length, 2);
      assert.equal(all.timeseries.bucket, 'month');
      const utc = all.timeseries.points;
      assert.equal(utc.length, 144, 'Oct 2014 to Sep 2026');
      assert.equal(utc[0].t, '2014-10-01T00:00:00.000Z');
      assert.equal(utc[1].t, '2014-11-01T00:00:00.000Z');
      assert.equal(utc.at(-1).t, '2026-09-01T00:00:00.000Z');
      assert.equal(utc[0].clicks, 1);
      assert.equal(utc.at(-1).clicks, 1);
      assert.equal(sum(utc), 2);

      const east = (await stats('?range=all&tz=-120')).timeseries;
      assert.equal(east.bucket, 'month');
      assert.equal(east.points.length, 145);
      assert.equal(east.points[0].t, '2014-09-30T22:00:00.000Z');
      assert.equal(east.points.at(-1).t, '2026-09-30T22:00:00.000Z', 'October 1 at local midnight');
      assert.equal(east.points.at(-1).clicks, 1);
      assert.equal(east.points.at(-2).clicks, 0);

      const west = (await stats('?range=all&tz=300')).timeseries;
      assert.equal(west.points.length, 145);
      assert.equal(west.points[0].t, '2014-09-01T05:00:00.000Z');
      assert.equal(west.points[0].clicks, 1, 'the first visit was on Sep 30 local time');
      assert.equal(west.points[1].clicks, 0);
      assert.equal(west.points.at(-1).t, '2026-09-01T05:00:00.000Z');
      assert.equal(sum(west.points), 2);
    } finally {
      await s.stop();
    }
  });
});
