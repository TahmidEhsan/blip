import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, UA, blipData, startServer } from './helpers.js';

describe('visits (GET /:slug)', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.stop());

  const clickCount = (slug) => s.db.prepare('SELECT click_count AS n FROM links WHERE slug = ?').get(slug).n;
  const clickRows = (slug) => s.db.prepare('SELECT c.* FROM clicks c JOIN links l ON l.id = c.link_id WHERE l.slug = ? ORDER BY c.id').all(slug);

  it('instant links answer 302 with no-store and noindex', async () => {
    await s.createLink({ targetUrl: 'https://example.com/landing?utm=blip', slug: 'instant' });
    const res = await s.visit('instant');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/landing?utm=blip');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(clickCount('instant'), 1);
    const [row] = clickRows('instant');
    assert.equal(row.outcome, 'redirect');
    assert.equal(row.device, 'desktop');
    assert.equal(row.browser, 'Chrome');
    assert.equal(row.is_unique, 1);
    assert.match(row.visitor_hash, /^[0-9a-f]{24}$/);
    // Never store raw IPs: no column anywhere contains the client address.
    for (const value of Object.values(row)) assert.ok(!String(value).includes('127.0.0.1'));
    // Slugs are case-insensitive.
    assert.equal((await s.visit('INSTANT')).status, 302);
  });

  it('unknown slugs get the playful 404 page', async () => {
    const res = await s.visit('nothing-here-yet');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(blipData(res.text), { slug: 'nothing-here-yet' });
    const weird = await s.visit('Bad%20Slug%3Cscript%3E');
    assert.equal(weird.status, 404);
    assert.ok(!weird.text.includes('<script>'), 'requested slug is never reflected unescaped');
    assert.deepEqual(blipData(weird.text), { slug: 'bad-slugscript' });
    const deep = await s.request('GET', '/a/b/c');
    assert.equal(deep.status, 404);
    assert.match(deep.headers.get('content-type'), /text\/html/);
  });

  it('teaser links render the teaser page with safely escaped data', async () => {
    const evilTitle = '<script>alert("title")</script>';
    const evilMessage = '</script><img src=x onerror=alert(1)>';
    await s.createLink({
      targetUrl: 'https://example.com/?q="><script>alert(2)</script>',
      slug: 'teased',
      title: evilTitle,
      redirectMode: 'teaser',
      teaser: { style: 'brand', message: evilMessage, seconds: 7, theme: 'paper' },
    });
    const res = await s.visit('teased');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = res.text;
    assert.ok(!html.includes(evilTitle), 'title must be escaped');
    assert.ok(!html.includes('<img src=x'), 'message must be escaped');
    assert.ok(!html.includes('<script>alert'), 'no injected script tags');
    assert.ok(html.includes('&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;'));
    assert.ok(html.includes('data-theme="paper"'));
    assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>/.test(html), 'only external or JSON script tags (CSP)');
    const data = blipData(html);
    assert.equal(data.slug, 'teased');
    assert.equal(data.title, evilTitle);
    assert.equal(data.message, evilMessage);
    assert.equal(data.seconds, 7);
    assert.equal(data.style, 'brand');
    assert.equal(data.theme, 'paper');
    assert.equal(data.targetHost, 'example.com');
    assert.equal(data.targetUrl, 'https://example.com/?q=%22%3E%3Cscript%3Ealert(2)%3C/script%3E');
    assert.equal(typeof data.fact, 'string');
    assert.equal(clickRows('teased')[0].outcome, 'teaser');
    assert.equal(clickCount('teased'), 1);
  });

  it('teaser pages use the new theme id for links stored with a first-release theme', async () => {
    await s.createLink({ targetUrl: 'https://example.com/themed', slug: 'old-theme', redirectMode: 'teaser', teaser: { style: 'countdown' } });
    for (const [legacy, current] of [['aurora', 'hero'], ['sunset', 'caption'], ['ocean', 'sky'], ['neon', 'noir'], ['candy', 'paper'], ['plaid', 'hero']]) {
      s.db.prepare('UPDATE links SET teaser_theme = ? WHERE slug = ?').run(legacy, 'old-theme');
      const res = await s.visit('old-theme');
      assert.equal(res.status, 200);
      assert.ok(res.text.includes(`data-theme="${current}"`), `${legacy} renders as ${current}`);
      assert.ok(!res.text.includes(`data-theme="${legacy}"`));
      assert.equal(blipData(res.text).theme, current);
    }
  });

  it('expires by time → 410 self-destructed page', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/timed', slug: 'timed', expiresInSeconds: 3600 });
    assert.equal((await s.visit('timed')).status, 302);
    s.advance(HOUR + 1000);
    const res = await s.visit('timed');
    assert.equal(res.status, 410);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(!res.text.includes('https://example.com/timed'), 'target is not revealed');
    const data = blipData(res.text);
    assert.equal(data.slug, 'timed');
    assert.equal(data.reason, 'time');
    assert.equal(data.clickCount, 1);
    assert.equal(data.maxClicks, null);
    assert.equal(data.expiredAt, new Date(s.clock.t - 1000).toISOString());
    const outcomes = clickRows('timed').map((r) => r.outcome);
    assert.deepEqual(outcomes, ['redirect', 'expired']);
    assert.equal(clickCount('timed'), 1, 'blocked attempts are not counted');
    const { json } = await s.request('GET', '/api/links/timed', { token: manageToken });
    assert.equal(json.link.status, 'expired');
    assert.equal(json.link.expiredReason, 'time');
  });

  it('maxClicks = 1 → first visit 302, second 410 (burn after reading)', async () => {
    await s.createLink({ targetUrl: 'https://example.com/secret', slug: 'burn', maxClicks: 1 });
    assert.equal((await s.visit('burn')).status, 302);
    const second = await s.visit('burn', { ua: UA.iphone });
    assert.equal(second.status, 410);
    const data = blipData(second.text);
    assert.equal(data.reason, 'clicks');
    assert.equal(data.clickCount, 1);
    assert.equal(data.maxClicks, 1);
    assert.equal(data.expiredAt, new Date(s.clock.t).toISOString());
    assert.equal(clickCount('burn'), 1);
  });

  it('bots never consume limited links and never see the target', async () => {
    await s.createLink({ targetUrl: 'https://example.com/very-secret-target', slug: 'unfurl', maxClicks: 1 });
    for (const ua of [UA.slackbot, UA.googlebot, 'WhatsApp/2.23.20.0', '']) {
      const res = await s.visit('unfurl', { ua });
      assert.equal(res.status, 200, ua);
      assert.ok(!res.text.includes('very-secret-target'), 'preview must not reveal the target');
      assert.ok(!res.text.includes('example.com'), 'preview must not reveal the target host');
    }
    assert.equal(clickCount('unfurl'), 0);
    const rows = clickRows('unfurl');
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.outcome === 'bot-preview' && r.is_bot === 1));
    assert.equal((await s.visit('unfurl')).status, 302, 'the human still gets through');
    assert.equal((await s.visit('unfurl')).status, 410);
  });

  it('bots on unlimited links are redirected and logged, but never counted', async () => {
    await s.createLink({ targetUrl: 'https://example.com/open', slug: 'open-door' });
    const res = await s.visit('open-door', { ua: UA.googlebot });
    assert.equal(res.status, 302);
    assert.equal(clickCount('open-door'), 0);
    const [row] = clickRows('open-door');
    assert.equal(row.is_bot, 1);
    assert.equal(row.device, 'bot');
    assert.equal(row.is_unique, 0);
  });

  it('HEAD requests never record or consume', async () => {
    await s.createLink({ targetUrl: 'https://example.com/head', slug: 'heady', maxClicks: 1 });
    for (let i = 0; i < 3; i += 1) {
      const head = await s.visit('heady', { method: 'HEAD' });
      assert.equal(head.status, 302, 'same status as GET');
      assert.equal(head.headers.get('location'), null, 'a HEAD never uses a click, so it must not reveal a limited target');
      assert.equal(head.headers.get('cache-control'), 'no-store');
      assert.equal(head.text, '');
    }
    assert.equal(clickCount('heady'), 0);
    assert.equal(clickRows('heady').length, 0);
    assert.equal((await s.visit('heady')).status, 302);
    assert.equal((await s.visit('heady', { method: 'HEAD' })).status, 410);
    assert.equal((await s.visit('missing-head', { method: 'HEAD' })).status, 404);
    assert.equal(clickRows('heady').length, 1);
    await s.createLink({ targetUrl: 'https://example.com/limited', slug: 'head-bot', expiresInSeconds: 600 });
    assert.equal((await s.visit('head-bot', { method: 'HEAD', ua: UA.slackbot })).status, 200);
    assert.equal(clickRows('head-bot').length, 0);
  });

  it('HEAD still reveals the target of unlimited links (a GET would anyway) and never of limited teasers', async () => {
    await s.createLink({ targetUrl: 'https://example.com/open-head', slug: 'open-head' });
    const open = await s.visit('open-head', { method: 'HEAD' });
    assert.equal(open.status, 302);
    assert.equal(open.headers.get('location'), 'https://example.com/open-head');
    assert.equal(clickRows('open-head').length, 0);

    await s.createLink({ targetUrl: 'https://secret.example.com/teased-burn', slug: 'teased-burn', maxClicks: 1, redirectMode: 'teaser' });
    const teaser = await s.visit('teased-burn', { method: 'HEAD' });
    assert.equal(teaser.status, 200);
    assert.equal(teaser.text, '');
    for (const [name, value] of teaser.headers) assert.ok(!value.includes('secret.example.com'), `header ${name} must not leak the target`);
    assert.equal(clickCount('teased-burn'), 0);
    assert.equal((await s.visit('teased-burn')).status, 200, 'the one real visit is still available');
    assert.equal((await s.visit('teased-burn')).status, 410);
  });

  it('concurrent visits never consume more than maxClicks', async () => {
    await s.createLink({ targetUrl: 'https://example.com/race', slug: 'race', maxClicks: 3 });
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => s.visit('race', { ua: `${UA.windowsChrome} r${i}` })));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((code) => code === 302).length, 3);
    assert.equal(statuses.filter((code) => code === 410).length, 27);
    assert.equal(clickCount('race'), 3);
    const outcomes = clickRows('race').map((r) => r.outcome);
    assert.equal(outcomes.filter((o) => o === 'redirect').length, 3);
    assert.equal(outcomes.filter((o) => o === 'expired').length, 27);
  });

  it('destroyed links show the manual self-destruct page until revived', async () => {
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/boom', slug: 'boom' });
    await s.request('POST', '/api/links/boom/destroy', { token: manageToken, body: {} });
    const res = await s.visit('boom');
    assert.equal(res.status, 410);
    const data = blipData(res.text);
    assert.equal(data.reason, 'manual');
    assert.equal(data.expiredAt, new Date(s.clock.t).toISOString());
    await s.request('POST', '/api/links/boom/revive', { token: manageToken, body: {} });
    assert.equal((await s.visit('boom')).status, 302);
  });

  it('records referrer host, device and unique visitors', async () => {
    await s.createLink({ targetUrl: 'https://example.com/ref', slug: 'refs' });
    await s.visit('refs', { ua: UA.iphone, headers: { Referer: 'https://www.twitter.com/someone/status/1' } });
    await s.visit('refs', { ua: UA.iphone });
    await s.visit('refs', { ua: UA.ipad, headers: { 'cf-ipcountry': 'GB', 'cf-ipcity': 'London', 'cf-iplatitude': '51.5074', 'cf-iplongitude': '-0.1278' } });
    const rows = clickRows('refs');
    assert.deepEqual(rows.map((r) => r.referrer_host), ['twitter.com', null, null]);
    assert.deepEqual(rows.map((r) => r.device), ['mobile', 'mobile', 'tablet']);
    assert.deepEqual(rows.map((r) => r.is_unique), [1, 0, 1]);
    assert.deepEqual([rows[2].country, rows[2].city, rows[2].lat, rows[2].lon], ['GB', 'London', 51.5, -0.1]);
    assert.equal(rows[0].country, null, 'loopback visitors are never geolocated');
  });
});

describe('visits with a slow geo provider', () => {
  let s;
  before(async () => {
    s = await startServer({ geoLookup: () => new Promise(() => {}) });
  });
  after(() => s.stop());

  it('caps the geo lookup so redirects stay fast', async () => {
    await s.createLink({ targetUrl: 'https://example.com/fast', slug: 'fast' });
    const started = performance.now();
    const res = await s.visit('fast');
    const elapsed = performance.now() - started;
    assert.equal(res.status, 302);
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
    const row = s.db.prepare('SELECT country FROM clicks').get();
    assert.equal(row.country, null);
  });
});

describe('analytics failures never break a visit', () => {
  let s;
  let mode = 'ok';
  before(async () => {
    s = await startServer({
      geoLookup: async () => {
        if (mode === 'throw') throw new Error('geo provider exploded');
        if (mode === 'delete') s.db.prepare('DELETE FROM links WHERE slug = ?').run('gone'); // deleted mid-visit
        return null;
      },
    });
  });
  after(() => s.stop());

  it('a link deleted while its visit is being recorded still redirects the consumed visit', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    await s.createLink({ targetUrl: 'https://example.com/gone', slug: 'gone', maxClicks: 5 });
    mode = 'delete';
    const res = await s.visit('gone');
    mode = 'ok';
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/gone');
    assert.equal(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0].arguments[0]), /could not record a visit to \/gone/);
    assert.equal((await s.visit('gone')).status, 404);
  });

  it('a geo provider that throws just means "no location"', async () => {
    await s.createLink({ targetUrl: 'https://example.com/geo-throws', slug: 'geo-throws', redirectMode: 'teaser' });
    mode = 'throw';
    const res = await s.visit('geo-throws');
    mode = 'ok';
    assert.equal(res.status, 200);
    const rows = s.db.prepare('SELECT c.outcome, c.country FROM clicks c JOIN links l ON l.id = c.link_id WHERE l.slug = ?').all('geo-throws');
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ outcome: 'teaser', country: null }]);
  });
});

describe('visits with an injected geo provider', () => {
  let s;
  const seen = [];
  before(async () => {
    s = await startServer({
      geoLookup: async (ip, headers) => {
        seen.push({ ip, hasHeaders: typeof headers === 'object' });
        return { country: 'JP', region: '13', city: 'Tokyo', lat: 35.7, lon: 139.7 };
      },
    });
  });
  after(() => s.stop());

  it('stores the injected geo result', async () => {
    await s.createLink({ targetUrl: 'https://example.com/geo', slug: 'geo' });
    await s.visit('geo');
    const row = s.db.prepare('SELECT country, region, city, lat, lon FROM clicks').get();
    assert.deepEqual({ ...row }, { country: 'JP', region: '13', city: 'Tokyo', lat: 35.7, lon: 139.7 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ip, '127.0.0.1', 'IPv4-mapped prefix stripped before lookup');
    assert.equal(seen[0].hasHeaders, true);
  });
});
