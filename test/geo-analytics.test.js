import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanIp, geoFromHeaders, isPublicIp, lookupGeo } from '../server/geo.js';
import {
  countryInfo, isBotUA, parseTzOffset, parseUserAgent, rangeWindow, referrerHost, visitorHash,
} from '../server/analytics.js';
import { createRateLimiter } from '../server/ratelimit.js';
import { UA } from './helpers.js';

describe('geo', () => {
  it('cleans IPv4-mapped and zoned addresses', () => {
    assert.equal(cleanIp('::ffff:8.8.8.8'), '8.8.8.8');
    assert.equal(cleanIp('::FFFF:127.0.0.1'), '127.0.0.1');
    assert.equal(cleanIp('fe80::1%eth0'), 'fe80::1');
    assert.equal(cleanIp('[2001:4860::8888]'), '2001:4860::8888');
    assert.equal(cleanIp(undefined), '');
  });

  it('never treats loopback, private, CGNAT, link-local or unspecified addresses as public', () => {
    const notPublic = [
      '127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20',
      '::ffff:192.168.1.5', '169.254.10.10', '100.64.0.1', '100.127.255.254', '0.0.0.0', '::', 'fc00::1', 'fd12:3456::1',
      'fe80::1', 'febf::1', 'ff02::1', '224.0.0.1', '255.255.255.255', 'not-an-ip', '', '2001:db8::1',
    ];
    for (const ip of notPublic) assert.equal(isPublicIp(ip), false, ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '81.2.69.142', '172.32.0.1', '100.128.0.1', '2a03:2880:f12f:83:face:b00c::25de', '::ffff:8.8.4.4']) {
      assert.equal(isPublicIp(ip), true, ip);
    }
  });

  it('prefers CDN country headers and ignores unknown codes', () => {
    assert.deepEqual(geoFromHeaders({ 'cf-ipcountry': 'gb' }), { country: 'GB', region: null, city: null, lat: null, lon: null });
    assert.deepEqual(
      geoFromHeaders({ 'x-vercel-ip-country': 'US', 'x-vercel-ip-city': 'San%20Francisco', 'x-vercel-ip-latitude': '37.7749', 'x-vercel-ip-longitude': '-122.4194', 'x-vercel-ip-country-region': 'ca' }),
      { country: 'US', region: 'CA', city: 'San Francisco', lat: 37.8, lon: -122.4 },
    );
    assert.equal(geoFromHeaders({ 'cf-ipcountry': 'XX' }), null);
    assert.equal(geoFromHeaders({ 'cf-ipcountry': 'T1' }), null);
    assert.equal(geoFromHeaders({ 'cf-ipcountry': 'Germany' }), null);
    assert.equal(geoFromHeaders({}), null);
  });

  it('lookupGeo returns null for private IPs (never the bogus fast-geoip answer)', async () => {
    assert.equal(await lookupGeo('127.0.0.1', {}), null);
    assert.equal(await lookupGeo('::1', {}), null);
    assert.equal(await lookupGeo('::ffff:10.0.0.7', {}), null);
    assert.equal(await lookupGeo('100.64.1.1', {}), null);
    assert.equal((await lookupGeo('127.0.0.1', { 'cf-ipcountry': 'FR' })).country, 'FR');
  });

  it('lookupGeo resolves public IPs through the optional fast-geoip database', async (t) => {
    const available = await import('fast-geoip').then(() => true, () => false);
    if (!available) {
      t.skip('fast-geoip not installed');
      return;
    }
    const geo = await lookupGeo('8.8.8.8', {}, { timeoutMs: 5000 });
    assert.equal(geo?.country, 'US');
    if (geo.lat !== null) assert.equal(geo.lat, Math.round(geo.lat * 10) / 10, 'coordinates rounded to 1 decimal');
  });
});

describe('analytics helpers', () => {
  it('detects bots and empty user agents', () => {
    for (const ua of ['', '   ', null, UA.slackbot, UA.googlebot, 'curl/8.4.0', 'Wget/1.21', 'python-requests/2.31', 'facebookexternalhit/1.1',
      'WhatsApp/2.23', 'TelegramBot (like TwitterBot)', 'Discordbot/2.0', 'LinkedInBot/1.0', 'Mozilla/5.0 HeadlessChrome/120.0']) {
      assert.equal(isBotUA(ua), true, String(ua));
    }
    for (const ua of [UA.iphone, UA.windowsChrome, UA.ipad, UA.macFirefox]) assert.equal(isBotUA(ua), false, ua);
  });

  it('parses user agents into device / browser / os', () => {
    assert.deepEqual(parseUserAgent(UA.iphone), { device: 'mobile', browser: 'Safari', os: 'iOS' });
    assert.deepEqual(parseUserAgent(UA.windowsChrome), { device: 'desktop', browser: 'Chrome', os: 'Windows' });
    assert.deepEqual(parseUserAgent(UA.ipad), { device: 'tablet', browser: 'Safari', os: 'iOS' });
    assert.deepEqual(parseUserAgent(UA.macFirefox), { device: 'desktop', browser: 'Firefox', os: 'macOS' });
    assert.equal(parseUserAgent(UA.googlebot).device, 'bot');
    assert.equal(parseUserAgent('Mozilla/5.0 (PlayStation 5 3.11) AppleWebKit/605.1.15 (KHTML, like Gecko)').device, 'console');
    assert.equal(parseUserAgent('Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1').device, 'tv');
    assert.equal(parseUserAgent('node').device, 'other');
  });

  it('hashes visitors without exposing the IP', () => {
    const a = visitorHash('salt', '203.0.113.9', UA.iphone);
    assert.match(a, /^[0-9a-f]{24}$/);
    assert.equal(a, visitorHash('salt', '203.0.113.9', UA.iphone));
    assert.notEqual(a, visitorHash('other-salt', '203.0.113.9', UA.iphone));
    assert.notEqual(a, visitorHash('salt', '203.0.113.10', UA.iphone));
    assert.ok(!a.includes('203'));
  });

  it('extracts referrer hostnames', () => {
    assert.equal(referrerHost('https://www.Twitter.com/some/path?x=1'), 'twitter.com');
    assert.equal(referrerHost('https://news.ycombinator.com/item?id=1'), 'news.ycombinator.com');
    assert.equal(referrerHost('android-app://com.slack'), null);
    assert.equal(referrerHost('garbage'), null);
    assert.equal(referrerHost(undefined), null);
  });

  it('maps country codes to numeric ids and names', () => {
    assert.deepEqual(countryInfo('GB'), { code: 'GB', numeric: '826', name: 'United Kingdom' });
    assert.deepEqual(countryInfo('US'), { code: 'US', numeric: '840', name: 'United States' });
    assert.equal(countryInfo('AU').numeric, '036', 'numeric ids are zero-padded like world-atlas');
    assert.deepEqual(countryInfo(null), { code: null, numeric: null, name: null });
  });

  it('parses tz offsets', () => {
    assert.equal(parseTzOffset(undefined), 0);
    assert.equal(parseTzOffset('-330'), -330);
    assert.equal(parseTzOffset('60'), 60);
    assert.equal(parseTzOffset('abc'), null);
    assert.equal(parseTzOffset('1.5'), null);
    assert.equal(parseTzOffset('9999'), null);
  });

  it('aligns buckets to the client time zone', () => {
    const now = Date.parse('2026-10-07T23:30:00.000Z');
    const utc = rangeWindow('7d', now, 0);
    assert.equal(utc.count, 7);
    assert.equal(new Date(utc.start).toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(new Date(utc.end).toISOString(), '2026-10-08T00:00:00.000Z');
    const plusOne = rangeWindow('7d', now, -60); // UTC+1: it's already Oct 8 locally
    assert.equal(new Date(plusOne.end - plusOne.size).toISOString(), '2026-10-07T23:00:00.000Z');
    const india = rangeWindow('24h', now, -330);
    assert.equal(india.bucket, 'hour');
    assert.equal(india.count, 24);
    assert.equal(new Date(india.end - india.size).toISOString(), '2026-10-07T23:30:00.000Z');
    const all = rangeWindow('all', now, 0, now - 3 * 86_400_000);
    assert.equal(all.count, 4);
    assert.equal(all.starts.length, 4);
    assert.equal(all.starts[3], all.end - all.size);
  });

  it('range all switches from days to weeks to months as a link gets older', () => {
    const DAY_MS = 86_400_000;
    const now = Date.parse('2026-10-07T23:30:00.000Z'); // a Wednesday
    const yearOfDays = rangeWindow('all', now, 0, now - 364 * DAY_MS);
    assert.equal(yearOfDays.bucket, 'day');
    assert.equal(yearOfDays.count, 365);

    const overAYear = rangeWindow('all', now, 0, now - 365 * DAY_MS);
    assert.equal(overAYear.bucket, 'week');
    assert.equal(overAYear.size, 7 * DAY_MS);
    assert.equal(new Date(overAYear.starts.at(-1)).toISOString(), '2026-10-05T00:00:00.000Z', 'weeks start on Monday');
    assert.equal(overAYear.end, Date.parse('2026-10-12T00:00:00.000Z'));
    assert.equal(overAYear.starts[0], overAYear.start);
    assert.ok(overAYear.start <= now - 365 * DAY_MS);

    const thisMonday = Date.parse('2026-10-05T00:00:00.000Z');
    const maxWeeks = rangeWindow('all', now, 0, thisMonday - 519 * 7 * DAY_MS);
    assert.equal(maxWeeks.bucket, 'week');
    assert.equal(maxWeeks.count, 520);
    const months = rangeWindow('all', now, 0, thisMonday - 519 * 7 * DAY_MS - 1);
    assert.equal(months.bucket, 'month');
    assert.equal(months.size, null);
    assert.equal(new Date(months.start).toISOString(), '2016-10-01T00:00:00.000Z', 'calendar months: Oct 2016 to Oct 2026');
    assert.equal(new Date(months.starts.at(-1)).toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(new Date(months.end).toISOString(), '2026-11-01T00:00:00.000Z');
    assert.equal(months.count, 121);
  });

  it('weekly and monthly buckets follow the client time zone on both sides of UTC', () => {
    const DAY_MS = 86_400_000;
    // Sunday 23:30 UTC: already Monday east of UTC, still Sunday to the west.
    const sunday = Date.parse('2026-10-11T23:30:00.000Z');
    const created = Date.parse('2024-10-09T12:00:00.000Z');
    const weekStarts = (tz) => rangeWindow('all', sunday, tz, created).starts.map((t) => new Date(t).toISOString());
    assert.equal(weekStarts(0).at(-1), '2026-10-05T00:00:00.000Z');
    assert.equal(weekStarts(-60).at(-1), '2026-10-11T23:00:00.000Z', 'UTC+1: Monday Oct 12 has begun');
    assert.equal(weekStarts(300).at(-1), '2026-10-05T05:00:00.000Z', 'UTC-5: still the week of Oct 5');
    assert.equal(weekStarts(-330).at(-1), '2026-10-11T18:30:00.000Z');
    for (const tz of [0, -60, 300, -330, -840, 840]) {
      const win = rangeWindow('all', sunday, tz, created);
      assert.equal(win.bucket, 'week', `tz=${tz}`);
      for (const t of win.starts) {
        const local = new Date(t - tz * 60_000);
        assert.equal(local.getUTCDay(), 1, `tz=${tz}: ${new Date(t).toISOString()} is a local Monday`);
        assert.equal(local.getUTCHours() + local.getUTCMinutes(), 0, `tz=${tz}: weeks start at local midnight`);
      }
      assert.ok(win.start <= created && sunday < win.end, `tz=${tz}: the window covers both ends`);
      assert.equal(win.end - win.start, win.count * 7 * DAY_MS);
    }

    // Sep 30 22:30 UTC: October has begun in UTC+2 but not in UTC-5.
    const lastDay = Date.parse('2026-09-30T22:30:00.000Z');
    const decadeOld = Date.parse('2014-10-01T02:00:00.000Z');
    const utc = rangeWindow('all', lastDay, 0, decadeOld);
    assert.equal(utc.bucket, 'month');
    assert.equal(utc.count, 144);
    assert.equal(new Date(utc.start).toISOString(), '2014-10-01T00:00:00.000Z');
    const east = rangeWindow('all', lastDay, -120, decadeOld);
    assert.equal(east.count, 145);
    assert.equal(new Date(east.starts.at(-1)).toISOString(), '2026-09-30T22:00:00.000Z', 'UTC+2: October 1 local');
    const west = rangeWindow('all', lastDay, 300, decadeOld);
    assert.equal(west.count, 145);
    assert.equal(new Date(west.start).toISOString(), '2014-09-01T05:00:00.000Z', 'UTC-5: the first visit was still in September');
    assert.equal(new Date(west.starts.at(-1)).toISOString(), '2026-09-01T05:00:00.000Z');
    for (const [tz, win] of [[0, utc], [-120, east], [300, west]]) {
      for (const t of [...win.starts, win.end]) {
        const local = new Date(t - tz * 60_000);
        assert.equal(local.getUTCDate(), 1, `tz=${tz}: months start on the 1st`);
        assert.equal(local.getUTCHours() + local.getUTCMinutes(), 0, `tz=${tz}: at local midnight`);
      }
    }
  });
});

describe('rate limiter', () => {
  it('allows max requests per window then answers 429 with Retry-After', () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000, now: () => t, keyFn: (req) => req.ip });
    const call = (ip) => {
      const res = {
        headers: {}, statusCode: 200, body: null,
        set(k, v) { this.headers[k] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
      };
      let passed = false;
      limiter({ ip }, res, () => { passed = true; });
      return { passed, res };
    };
    assert.equal(call('a').passed, true);
    assert.equal(call('a').passed, true);
    const blocked = call('a');
    assert.equal(blocked.passed, false);
    assert.equal(blocked.res.statusCode, 429);
    assert.equal(blocked.res.body.error.code, 'rate_limited');
    assert.equal(blocked.res.headers['Retry-After'], '60');
    assert.equal(call('b').passed, true, 'other clients are unaffected');
    t += 45_000;
    assert.equal(call('a').res.headers['Retry-After'], '15');
    t += 15_000;
    assert.equal(call('a').passed, true, 'new window');
  });
});
