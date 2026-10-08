import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_SECURITY_POLICY } from '../server/app.js';
import { HOUR, DAY, assertPlainCopy, startServer } from './helpers.js';
import { QR_PRESETS } from '../public/assets/js/qr-shared.js';

describe('API', () => {
  let s;
  before(async () => {
    s = await startServer({ config: { domains: ['cat.ly', 'go.to', 'p.wrk'], liveDomains: ['go.to'] } });
  });
  after(() => s.stop());

  describe('meta endpoints', () => {
    it('GET /api/health', async () => {
      const res = await s.request('GET', '/api/health');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true });
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    it('sends security headers on every response', async () => {
      for (const path of ['/api/health', '/nope-nope', '/api/unknown']) {
        const res = await s.request('GET', path);
        assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY, path);
        assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-frame-options'), 'DENY');
        assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
        assert.equal(res.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
        assert.equal(res.headers.get('x-powered-by'), null);
      }
    });

    it('GET /api/config', async () => {
      const { status, json } = await s.request('GET', '/api/config');
      assert.equal(status, 200);
      assert.equal(json.baseUrl, 'http://localhost:3030');
      assert.equal(json.baseHost, 'localhost:3030');
      assert.equal(json.defaultDomain, 'localhost:3030');
      assert.deepEqual(json.domains[0], { domain: 'localhost:3030', live: true, isBase: true });
      assert.deepEqual(json.domains.slice(1), [
        { domain: 'cat.ly', live: false, isBase: false },
        { domain: 'go.to', live: true, isBase: false },
        { domain: 'p.wrk', live: false, isBase: false },
      ]);
      assert.equal(json.allowDemoTraffic, true);
      assert.deepEqual(json.teaser, {
        minSeconds: 3, maxSeconds: 15, defaultSeconds: 5, styles: ['countdown', 'trivia', 'brand'], themes: ['hero', 'caption', 'noir', 'sky', 'paper'],
      });
      assert.deepEqual(json.limits, { slugMax: 64, titleMax: 120, messageMax: 280, maxClicksMax: 1000000, urlMax: 2048 });
    });

    it('unknown /api routes answer JSON 404', async () => {
      const res = await s.request('GET', '/api/does/not/exist');
      assert.equal(res.status, 404);
      assert.equal(res.json.error.code, 'not_found');
      const put = await s.request('PUT', '/api/links', { body: {} });
      assert.equal(put.status, 404);
    });

    it('rejects malformed JSON bodies', async () => {
      const res = await s.request('POST', '/api/links', { body: '{"targetUrl": ', raw: true });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'invalid_json');
      const huge = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', title: 'x'.repeat(20_000) } });
      assert.equal(huge.status, 413);
      assert.equal(huge.json.error.code, 'payload_too_large');
    });
  });

  describe('slugs & domain ideas', () => {
    it('checks slugs', async () => {
      const res = await s.request('GET', `/api/slugs/check?slug=${encodeURIComponent('Summer Sale!')}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { input: 'Summer Sale!', normalized: 'summer-sale', valid: true, available: true, reason: null });
      await s.createLink({ targetUrl: 'https://example.com', slug: 'summer-sale' });
      const again = await s.request('GET', '/api/slugs/check?slug=summer-sale');
      assert.equal(again.json.reason, 'taken');
      assert.equal(again.json.available, false);
      assert.equal((await s.request('GET', '/api/slugs/check?slug=admin')).json.reason, 'reserved');
      assert.equal((await s.request('GET', '/api/slugs/check')).json.reason, 'empty');
    });

    it('suggests valid, available, unique slugs', async () => {
      const res = await s.request('GET', '/api/slugs/suggest?phrase=Summer%20Sale&count=7');
      assert.equal(res.status, 200);
      const { suggestions } = res.json;
      assert.equal(suggestions.length, 7);
      assert.equal(new Set(suggestions).size, 7);
      assert.ok(!suggestions.includes('summer-sale'));
      for (const slug of suggestions) {
        const check = await s.request('GET', `/api/slugs/check?slug=${slug}`);
        assert.equal(check.json.available, true, slug);
      }
      const plain = await s.request('GET', '/api/slugs/suggest');
      assert.equal(plain.json.suggestions.length, 6);
      assert.equal((await s.request('GET', '/api/slugs/suggest?count=13')).status, 400);
      assert.equal((await s.request('GET', '/api/slugs/suggest?count=0')).json.error.field, 'count');
    });

    it('generates domain ideas', async () => {
      const res = await s.request('GET', '/api/domains/ideas?keyword=delicious');
      assert.equal(res.status, 200);
      assert.equal(res.json.keyword, 'delicious');
      assert.ok(res.json.ideas.some((i) => i.domain === 'delicio.us' && i.kind === 'hack'));
      assert.ok(res.json.ideas.length <= 12);
      const missing = await s.request('GET', '/api/domains/ideas');
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error.field, 'keyword');
      assert.equal((await s.request('GET', `/api/domains/ideas?keyword=${'a'.repeat(41)}`)).status, 400);
      assert.equal((await s.request('GET', '/api/domains/ideas?keyword=!!!')).status, 400);
    });
  });

  describe('create', () => {
    it('creates a link with a custom slug and returns the manage token once', async () => {
      const res = await s.request('POST', '/api/links', {
        body: { targetUrl: 'example.com/sale', slug: 'Back To School!', title: '  Back to school  ' },
      });
      assert.equal(res.status, 201);
      const { link, manageToken } = res.json;
      assert.match(manageToken, /^[A-Za-z0-9_-]{32}$/);
      assert.equal(link.slug, 'back-to-school');
      assert.equal(link.domain, 'localhost:3030');
      assert.equal(link.domainLive, true);
      assert.equal(link.shortUrl, 'http://localhost:3030/back-to-school');
      assert.equal(link.workingUrl, 'http://localhost:3030/back-to-school');
      assert.equal(link.qrUrl, link.shortUrl);
      assert.equal(link.targetUrl, 'https://example.com/sale');
      assert.equal(link.title, 'Back to school');
      assert.equal(link.redirectMode, 'instant');
      assert.deepEqual(link.teaser, { seconds: 5, style: 'countdown', message: null, theme: 'hero' });
      assert.equal(link.expiresAt, null);
      assert.equal(link.maxClicks, null);
      assert.equal(link.clickCount, 0);
      assert.equal(link.clicksRemaining, null);
      assert.equal(link.status, 'active');
      assert.equal(link.expiredReason, null);
      assert.equal(link.qrStyle, null);
      assert.equal(link.createdAt, new Date(s.clock.t).toISOString());
      assert.equal(link.updatedAt, link.createdAt);
      // The token is never stored in plain text.
      const row = s.db.prepare('SELECT manage_token_hash FROM links WHERE slug = ?').get('back-to-school');
      assert.notEqual(row.manage_token_hash, manageToken);
      assert.match(row.manage_token_hash, /^[0-9a-f]{64}$/);
    });

    it('defaults to a word slug, or a random one on request', async () => {
      const words = await s.createLink({ targetUrl: 'https://example.com/a' });
      assert.match(words.link.slug, /^[a-z]+-[a-z]+$/);
      const random = await s.createLink({ targetUrl: 'https://example.com/b', slugStyle: 'random' });
      assert.match(random.link.slug, /^[abcdefghjkmnpqrstuvwxyz23456789]{7}$/);
      const bad = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', slugStyle: 'emoji' } });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.field, 'slugStyle');
    });

    it('rejects taken, reserved and invalid slugs', async () => {
      await s.createLink({ targetUrl: 'https://example.com', slug: 'only-once' });
      const taken = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', slug: 'Only Once' } });
      assert.equal(taken.status, 409);
      assert.deepEqual([taken.json.error.code, taken.json.error.field], ['slug_taken', 'slug']);
      for (const reserved of ['dashboard', 'API', 'qr', 'well-known']) {
        const res = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', slug: reserved } });
        assert.equal(res.status, 400, reserved);
        assert.equal(res.json.error.code, 'slug_reserved');
        assert.equal(res.json.error.field, 'slug');
      }
      const invalid = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', slug: '!!!' } });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.json.error.code, 'slug_invalid');
      const objectSlug = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', slug: { a: 1 } } });
      assert.equal(objectSlug.status, 400);
    });

    it('validates target URLs', async () => {
      const cases = [
        ['javascript:alert(1)', 'unsupported_protocol'],
        ['data:text/html,hi', 'unsupported_protocol'],
        ['http://localhost:3030/loop', 'redirect_loop'],
        ['https://cat.ly/loop', 'redirect_loop'],
        // Other names for this server on its own port (it listens on 127.0.0.1:3030 by config).
        ['http://127.0.0.1:3030/loop', 'redirect_loop'],
        ['http://2130706433:3030/loop', 'redirect_loop'],
        ['http://blip.localhost:3030/loop', 'redirect_loop'],
        ['https://user:pw@example.com', 'invalid_url'],
        ['', 'invalid_url'],
      ];
      for (const [targetUrl, code] of cases) {
        const res = await s.request('POST', '/api/links', { body: { targetUrl } });
        assert.equal(res.status, 400, targetUrl);
        assert.equal(res.json.error.code, code, targetUrl);
        assert.equal(res.json.error.field, 'targetUrl');
      }
      const otherPort = await s.createLink({ targetUrl: 'http://127.0.0.1:5173/dev' });
      assert.equal(otherPort.link.targetUrl, 'http://127.0.0.1:5173/dev', 'local dev servers on other ports are fine');
      const missing = await s.request('POST', '/api/links', { body: {} });
      assert.equal(missing.json.error.code, 'invalid_url');
      const notObject = await s.request('POST', '/api/links', { body: [1, 2] });
      assert.equal(notObject.status, 400);
    });

    it('supports vanity domains (branded short URL, working URL for QR until live)', async () => {
      const vanity = await s.createLink({ targetUrl: 'https://example.com', slug: 'meow', domain: 'CAT.LY' });
      assert.equal(vanity.link.domain, 'cat.ly');
      assert.equal(vanity.link.domainLive, false);
      assert.equal(vanity.link.shortUrl, 'https://cat.ly/meow');
      assert.equal(vanity.link.workingUrl, 'http://localhost:3030/meow');
      assert.equal(vanity.link.qrUrl, 'http://localhost:3030/meow');
      const live = await s.createLink({ targetUrl: 'https://example.com', slug: 'woof', domain: 'go.to' });
      assert.equal(live.link.domainLive, true);
      assert.equal(live.link.qrUrl, 'https://go.to/woof');
      const unknown = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', domain: 'evil.example' } });
      assert.equal(unknown.status, 400);
      assert.deepEqual([unknown.json.error.code, unknown.json.error.field], ['validation', 'domain']);
    });

    it('validates teaser options and requires a brand message for brand teasers', async () => {
      const brandless = await s.request('POST', '/api/links', {
        body: { targetUrl: 'https://example.com', redirectMode: 'teaser', teaser: { style: 'brand', message: '   ' } },
      });
      assert.equal(brandless.status, 400);
      assert.deepEqual([brandless.json.error.code, brandless.json.error.field], ['validation', 'teaser.message']);
      const ok = await s.createLink({
        targetUrl: 'https://example.com', redirectMode: 'teaser', teaser: { style: 'brand', message: 'Fresh drops every Friday', seconds: 8, theme: 'noir' },
      });
      assert.deepEqual(ok.link.teaser, { seconds: 8, style: 'brand', message: 'Fresh drops every Friday', theme: 'noir' });
      const enumCases = [
        [{ redirectMode: 'slow' }, 'redirectMode'],
        [{ teaser: { style: 'opera' } }, 'teaser.style'],
        [{ teaser: { theme: 'plaid' } }, 'teaser.theme'],
        [{ teaser: { theme: 'constructor' } }, 'teaser.theme'],
        [{ teaser: { theme: 'HERO' } }, 'teaser.theme'],
        [{ teaser: { seconds: 2 } }, 'teaser.seconds'],
        [{ teaser: { seconds: 16 } }, 'teaser.seconds'],
        [{ teaser: { message: 'x'.repeat(281) } }, 'teaser.message'],
        [{ title: 'x'.repeat(121) }, 'title'],
        [{ teaser: 'nope' }, 'teaser'],
      ];
      for (const [extra, field] of enumCases) {
        const res = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', ...extra } });
        assert.equal(res.status, 400, JSON.stringify(extra));
        assert.equal(res.json.error.code, 'validation');
        assert.equal(res.json.error.field, field);
      }
    });

    it('validates expiry and click limits', async () => {
      const now = s.clock.t;
      const timed = await s.createLink({ targetUrl: 'https://example.com', expiresInSeconds: 3600, maxClicks: 10 });
      assert.equal(timed.link.expiresAt, new Date(now + HOUR).toISOString());
      assert.equal(timed.link.maxClicks, 10);
      assert.equal(timed.link.clicksRemaining, 10);
      const iso = new Date(now + DAY).toISOString();
      assert.equal((await s.createLink({ targetUrl: 'https://example.com', expiresAt: iso })).link.expiresAt, iso);
      assert.equal((await s.createLink({ targetUrl: 'https://example.com', expiresAt: now + DAY })).link.expiresAt, iso);
      const bad = [
        [{ expiresAt: new Date(now - 1000).toISOString() }, 'expiresAt'],
        [{ expiresAt: now + 6 * 365 * DAY }, 'expiresAt'],
        [{ expiresAt: 'next tuesday' }, 'expiresAt'],
        [{ expiresAt: iso, expiresInSeconds: 600 }, 'expiresAt'],
        [{ expiresInSeconds: 30 }, 'expiresInSeconds'],
        [{ expiresInSeconds: 157_680_001 }, 'expiresInSeconds'],
        [{ maxClicks: 0 }, 'maxClicks'],
        [{ maxClicks: 1_000_001 }, 'maxClicks'],
        [{ maxClicks: 2.5 }, 'maxClicks'],
      ];
      for (const [extra, field] of bad) {
        const res = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', ...extra } });
        assert.equal(res.status, 400, JSON.stringify(extra));
        assert.equal(res.json.error.field, field, JSON.stringify(extra));
      }
    });

    it('validates and whitelists qrStyle', async () => {
      const created = await s.createLink({
        targetUrl: 'https://example.com',
        qrStyle: { preset: 'sky', dotType: 'dots', dotColor: '#1F5FAD', dotColor2: null, margin: 12, transparentBg: false, caption: ' Scan me ', sneaky: '<script>' },
      });
      assert.deepEqual(created.link.qrStyle, { preset: 'sky', dotType: 'dots', dotColor: '#1f5fad', dotColor2: null, margin: 12, transparentBg: false, caption: 'Scan me' });
      const bad = [
        [{ dotColor: 'red' }, 'qrStyle.dotColor'],
        [{ dotType: 'hearts' }, 'qrStyle.dotType'],
        [{ preset: 'rainbow' }, 'qrStyle.preset'],
        [{ preset: 'toString' }, 'qrStyle.preset'],
        [{ margin: 99 }, 'qrStyle.margin'],
        [{ gradientRotation: -1 }, 'qrStyle.gradientRotation'],
        [{ logo: 'https://evil.example/logo.png' }, 'qrStyle.logo'],
        [{ caption: 'x'.repeat(41) }, 'qrStyle.caption'],
        [{ transparentBg: 'yes' }, 'qrStyle.transparentBg'],
      ];
      for (const [qrStyle, field] of bad) {
        const res = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', qrStyle } });
        assert.equal(res.status, 400, JSON.stringify(qrStyle));
        assert.equal(res.json.error.field, field);
      }
      const tooBig = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', qrStyle: { junk: 'x'.repeat(3000) } } });
      assert.equal(tooBig.json.error.field, 'qrStyle');
    });

    it('accepts every current teaser theme and QR preset id', async () => {
      for (const theme of ['hero', 'caption', 'noir', 'sky', 'paper']) {
        const { link } = await s.createLink({ targetUrl: 'https://example.com', redirectMode: 'teaser', teaser: { theme } });
        assert.equal(link.teaser.theme, theme);
      }
      for (const preset of ['ink', 'hero', 'caption', 'sky', 'pop', 'press', 'noir', 'custom']) {
        const { link } = await s.createLink({ targetUrl: 'https://example.com', qrStyle: { preset } });
        assert.deepEqual(link.qrStyle, { preset });
      }
    });

    it('maps first-release theme and preset ids to their comic replacements before storing them', async () => {
      const storedRow = (slug) => s.db.prepare('SELECT teaser_theme, qr_style FROM links WHERE slug = ?').get(slug);
      const themes = { aurora: 'hero', sunset: 'caption', ocean: 'sky', neon: 'noir', candy: 'paper' };
      for (const [legacy, current] of Object.entries(themes)) {
        const { link } = await s.createLink({ targetUrl: 'https://example.com', redirectMode: 'teaser', teaser: { theme: legacy } });
        assert.equal(link.teaser.theme, current, legacy);
        assert.equal(storedRow(link.slug).teaser_theme, current, `${legacy} is stored under its new id`);
      }
      const presets = { aurora: 'hero', sunset: 'pop', ocean: 'sky', neon: 'noir', mono: 'ink', candy: 'caption', forest: 'press' };
      for (const [legacy, current] of Object.entries(presets)) {
        const { link } = await s.createLink({ targetUrl: 'https://example.com', qrStyle: { preset: legacy, dotColor: '#111111' } });
        assert.deepEqual(link.qrStyle, { preset: current, dotColor: '#111111' }, legacy);
        assert.equal(JSON.parse(storedRow(link.slug).qr_style).preset, current, `${legacy} is stored under its new id`);
      }
    });
  });

  describe('manage', () => {
    let link;
    let token;
    before(async () => {
      ({ link, manageToken: token } = await s.createLink({ targetUrl: 'https://example.com/manage', slug: 'manage-me' }));
    });

    it('requires the manage token (401 / 403 / 404)', async () => {
      const missing = await s.request('GET', `/api/links/${link.slug}`);
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error.code, 'unauthorized');
      const wrong = await s.request('GET', `/api/links/${link.slug}`, { token: 'not-the-token' });
      assert.equal(wrong.status, 403);
      assert.equal(wrong.json.error.code, 'forbidden');
      const unknown = await s.request('GET', '/api/links/no-such-link', { token });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json.error.code, 'not_found');
      for (const [method, path] of [['PATCH', ''], ['DELETE', ''], ['POST', '/destroy'], ['POST', '/revive'], ['GET', '/stats'], ['GET', '/stream'], ['POST', '/simulate'], ['DELETE', '/simulated']]) {
        const res = await s.request(method, `/api/links/${link.slug}${path}`, method === 'GET' || method === 'DELETE' ? {} : { body: {} });
        assert.equal(res.status, 401, `${method} ${path}`);
      }
      const ok = await s.request('GET', `/api/links/${link.slug.toUpperCase()}`, { token });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.link.slug, 'manage-me');
    });

    it('PATCH updates fields, merges teaser options and clears limits with null', async () => {
      s.advance(1000);
      const res = await s.request('PATCH', `/api/links/${link.slug}`, {
        token,
        body: {
          targetUrl: 'https://example.org/new', title: 'New title', redirectMode: 'teaser', teaser: { style: 'trivia', theme: 'caption' },
          maxClicks: 5, expiresInSeconds: 600, qrStyle: { preset: 'ink', dotColor: '#111111' }, domain: 'p.wrk',
        },
      });
      assert.equal(res.status, 200);
      const updated = res.json.link;
      assert.equal(updated.targetUrl, 'https://example.org/new');
      assert.equal(updated.title, 'New title');
      assert.equal(updated.redirectMode, 'teaser');
      assert.deepEqual(updated.teaser, { seconds: 5, style: 'trivia', message: null, theme: 'caption' });
      assert.equal(updated.maxClicks, 5);
      assert.equal(updated.expiresAt, new Date(s.clock.t + 600_000).toISOString());
      assert.deepEqual(updated.qrStyle, { preset: 'ink', dotColor: '#111111' });
      assert.equal(updated.domain, 'p.wrk');
      assert.equal(updated.shortUrl, 'https://p.wrk/manage-me');
      assert.equal(updated.updatedAt, new Date(s.clock.t).toISOString());

      const partial = await s.request('PATCH', `/api/links/${link.slug}`, { token, body: { teaser: { seconds: 9 } } });
      assert.deepEqual(partial.json.link.teaser, { seconds: 9, style: 'trivia', message: null, theme: 'caption' });

      const cleared = await s.request('PATCH', `/api/links/${link.slug}`, {
        token, body: { maxClicks: null, expiresAt: null, qrStyle: null, title: null, domain: null },
      });
      assert.equal(cleared.json.link.maxClicks, null);
      assert.equal(cleared.json.link.expiresAt, null);
      assert.equal(cleared.json.link.qrStyle, null);
      assert.equal(cleared.json.link.title, null);
      assert.equal(cleared.json.link.domain, 'localhost:3030');
    });

    it('PATCH maps first-release theme and preset ids too', async () => {
      const res = await s.request('PATCH', `/api/links/${link.slug}`, { token, body: { teaser: { theme: 'ocean' }, qrStyle: { preset: 'forest' } } });
      assert.equal(res.status, 200);
      assert.equal(res.json.link.teaser.theme, 'sky');
      assert.deepEqual(res.json.link.qrStyle, { preset: 'press' });
      const back = await s.request('PATCH', `/api/links/${link.slug}`, { token, body: { teaser: { theme: 'hero' }, qrStyle: null } });
      assert.equal(back.json.link.teaser.theme, 'hero');
    });

    it('serves links stored with first-release ids under the new ids', async () => {
      const { link: stored, manageToken } = await s.createLink({ targetUrl: 'https://example.com/stored', slug: 'stored-legacy' });
      const write = (theme, qrStyle) => s.db.prepare('UPDATE links SET teaser_theme = ?, qr_style = ? WHERE slug = ?').run(theme, qrStyle, stored.slug);
      // As if written by the first release after the migration ran (or by hand).
      write('neon', JSON.stringify({ preset: 'mono', dotColor: '#111111', dotColor2: null }));
      const one = await s.request('GET', `/api/links/${stored.slug}`, { token: manageToken });
      assert.equal(one.json.link.teaser.theme, 'noir');
      const { label, ...inkLook } = QR_PRESETS.ink;
      assert.deepEqual(one.json.link.qrStyle, { ...inkLook, caption: null }, 'a stored legacy style is served as the flat look of its replacement preset');
      const batch = await s.request('POST', '/api/links/batch', { body: { items: [{ slug: stored.slug, token: manageToken }] } });
      assert.equal(batch.json.results[0].link.teaser.theme, 'noir');
      assert.equal(batch.json.results[0].link.qrStyle.preset, 'ink');
      // Values that were never valid fall back to the default theme and the "custom" preset.
      write('plaid', JSON.stringify({ preset: 'rainbow', margin: 4 }));
      const odd = await s.request('GET', `/api/links/${stored.slug}`, { token: manageToken });
      assert.equal(odd.json.link.teaser.theme, 'hero');
      assert.deepEqual(odd.json.link.qrStyle, { preset: 'custom', margin: 4 });
      write('hero', JSON.stringify([1, 2]));
      assert.equal((await s.request('GET', `/api/links/${stored.slug}`, { token: manageToken })).json.link.qrStyle, null);
    });

    it('PATCH validates like create and keeps slugs immutable', async () => {
      const cases = [
        [{ slug: 'something-else' }, 'slug'],
        [{ targetUrl: 'javascript:alert(1)' }, 'targetUrl'],
        [{ expiresAt: new Date(s.clock.t - 1).toISOString() }, 'expiresAt'],
        [{ redirectMode: 'teaser', teaser: { style: 'brand' } }, 'teaser.message'],
        [{ domain: 'nope.example' }, 'domain'],
        [{ qrStyle: { bgColor: '#12345' } }, 'qrStyle.bgColor'],
      ];
      for (const [body, field] of cases) {
        const res = await s.request('PATCH', `/api/links/${link.slug}`, { token, body });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.json.error.field, field, JSON.stringify(body));
      }
      const same = await s.request('PATCH', `/api/links/${link.slug}`, { token, body: { slug: 'manage-me' } });
      assert.equal(same.status, 200);
      const sameUnnormalized = await s.request('PATCH', `/api/links/${link.slug}`, { token, body: { slug: 'Manage Me' } });
      assert.equal(sameUnnormalized.status, 200);
      const empty = await s.request('PATCH', `/api/links/${link.slug}`, { token });
      assert.equal(empty.status, 200);
    });

    it('destroy and revive toggle the status', async () => {
      const destroyed = await s.request('POST', `/api/links/${link.slug}/destroy`, { token, body: {} });
      assert.equal(destroyed.status, 200);
      assert.equal(destroyed.json.link.status, 'destroyed');
      assert.equal(destroyed.json.link.expiredReason, 'manual');
      const revived = await s.request('POST', `/api/links/${link.slug}/revive`, { token, body: {} });
      assert.equal(revived.json.link.status, 'active');
      assert.equal(revived.json.link.expiredReason, null);
    });

    it('batch returns links in order with per-item errors', async () => {
      const other = await s.createLink({ targetUrl: 'https://example.com/other' });
      const res = await s.request('POST', '/api/links/batch', {
        body: {
          items: [
            { slug: other.link.slug, token: other.manageToken },
            { slug: 'definitely-missing', token: 'x' },
            { slug: link.slug, token: other.manageToken },
            { slug: link.slug.toUpperCase(), token },
            null,
          ],
        },
      });
      assert.equal(res.status, 200);
      const { results } = res.json;
      assert.equal(results.length, 5);
      assert.equal(results[0].link.slug, other.link.slug);
      assert.equal(results[0].error, null);
      assert.deepEqual(results[1], { slug: 'definitely-missing', link: null, error: 'not_found' });
      assert.deepEqual(results[2], { slug: link.slug, link: null, error: 'forbidden' });
      assert.equal(results[3].link.slug, link.slug);
      assert.deepEqual(results[4], { slug: '', link: null, error: 'not_found' });
      const tooMany = await s.request('POST', '/api/links/batch', { body: { items: Array.from({ length: 101 }, () => ({ slug: 'a', token: 'b' })) } });
      assert.equal(tooMany.status, 400);
      assert.equal(tooMany.json.error.field, 'items');
      assert.equal((await s.request('POST', '/api/links/batch', { body: {} })).status, 400);
    });

    it('DELETE removes the link and its clicks', async () => {
      const temp = await s.createLink({ targetUrl: 'https://example.com/temp', slug: 'delete-me' });
      await s.visit('delete-me');
      const linkId = s.db.prepare('SELECT id FROM links WHERE slug = ?').get('delete-me').id;
      assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM clicks WHERE link_id = ?').get(linkId).n, 1);
      const res = await s.request('DELETE', '/api/links/delete-me', { token: temp.manageToken });
      assert.equal(res.status, 204);
      assert.equal(res.text, '');
      assert.equal((await s.request('GET', '/api/links/delete-me', { token: temp.manageToken })).status, 404);
      assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM clicks WHERE link_id = ?').get(linkId).n, 0);
      assert.equal((await s.visit('delete-me')).status, 404);
    });
  });

  describe('copy (DESIGN.md §11)', () => {
    it('error messages shown in the UI have no em dashes, emoji or "it\'s not X, it\'s Y" lines', async () => {
      const { manageToken: token } = await s.createLink({ targetUrl: 'https://example.com', slug: 'copy-taken' });
      const create = (extra) => s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com', ...extra } });
      const cases = [
        ['slug_invalid', await create({ slug: '!!!' })],
        ['slug_reserved', await create({ slug: 'dashboard' })],
        ['slug_taken', await create({ slug: 'Copy Taken' })],
        ['validation', await create({ domain: 'evil.example' })],
        ['validation', await create({ teaser: { seconds: 99 } })],
        ['validation', await create({ teaser: { theme: 'plaid' } })],
        ['validation', await create({ qrStyle: { preset: 'rainbow' } })],
        ['validation', await create({ expiresInSeconds: 5 })],
        ['redirect_loop', await create({ targetUrl: 'http://localhost:3030/loop' })],
        ['redirect_loop', await create({ targetUrl: 'http://127.0.0.1:3030/loop' })],
        ['unsupported_protocol', await create({ targetUrl: 'javascript:alert(1)' })],
        ['validation', await s.request('GET', `/api/domains/ideas?keyword=${'a'.repeat(41)}`)],
        ['validation', await s.request('GET', '/api/slugs/suggest?count=99')],
        ['unauthorized', await s.request('GET', '/api/links/copy-taken')],
        ['forbidden', await s.request('GET', '/api/links/copy-taken', { token: 'nope' })],
        ['not_found', await s.request('GET', '/api/links/nothing-here', { token: 'nope' })],
        ['validation', await s.request('PATCH', '/api/links/copy-taken', { token, body: { slug: 'something-else' } })],
        ['not_found', await s.request('GET', '/api/nope')],
      ];
      for (const [code, res] of cases) {
        assert.ok(res.status >= 400, `${code}: ${res.status}`);
        assert.equal(res.json.error.code, code);
        assertPlainCopy(res.json.error.message, `${code} message`);
      }
    });

    it('domain idea notes and /api/config follow the copy rules', async () => {
      for (const keyword of ['delicious', 'catly', 'summer', 'io', 'go', 'link']) {
        const { json } = await s.request('GET', `/api/domains/ideas?keyword=${keyword}`);
        assert.ok(json.ideas.length > 0, keyword);
        for (const idea of json.ideas) assertPlainCopy(idea.note, `${idea.domain} note`);
      }
      assertPlainCopy((await s.request('GET', '/api/config')).text, '/api/config');
    });
  });
});

describe('API rate limiting', () => {
  let s;
  before(async () => {
    s = await startServer({ rateLimits: null });
  });
  after(() => s.stop());

  it('POST /api/links allows 20 per minute, then 429 with Retry-After', async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await s.request('POST', '/api/links', { body: { targetUrl: `https://example.com/${i}` } });
      assert.equal(res.status, 201, `request ${i + 1}`);
    }
    const limited = await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/21' } });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, 'rate_limited');
    assert.equal(limited.headers.get('retry-after'), '60');
    // Lookups have their own, separate budget.
    assert.equal((await s.request('GET', '/api/slugs/check?slug=hello')).status, 200);
    s.advance(60_000);
    assert.equal((await s.request('POST', '/api/links', { body: { targetUrl: 'https://example.com/again' } })).status, 201);
  });

  it('lookups are limited to 120 per minute', async () => {
    s.advance(60_000);
    let last;
    for (let i = 0; i < 121; i += 1) last = await s.request('GET', '/api/domains/ideas?keyword=cat');
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
  });

  it('simulated traffic is limited to 30 calls per minute', async () => {
    s.advance(60_000);
    const { link, manageToken: token } = await s.createLink({ targetUrl: 'https://example.com/sim-limit' });
    for (let i = 0; i < 30; i += 1) {
      const res = await s.request('POST', `/api/links/${link.slug}/simulate`, { token, body: { count: 1 } });
      assert.equal(res.status, 200, `call ${i + 1}`);
    }
    const limited = await s.request('POST', `/api/links/${link.slug}/simulate`, { token, body: { count: 1 } });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM clicks WHERE is_synthetic = 1').get().n, 30);
  });
});

describe('API rate limiting behind a proxy (TRUST_PROXY=1)', () => {
  let s;
  before(async () => {
    s = await startServer({ config: { trustProxy: 1 }, rateLimits: { createLink: 2 } });
  });
  after(() => s.stop());

  const create = (forwardedFor) => s.request('POST', '/api/links', {
    body: { targetUrl: 'https://example.com/proxied' }, headers: { 'X-Forwarded-For': forwardedFor },
  });

  it('a spoofed left-most X-Forwarded-For entry does not buy a fresh bucket', async () => {
    // The proxy appends the real client address; with a hop count only that last entry is trusted.
    const statuses = [];
    for (let i = 1; i <= 5; i += 1) statuses.push((await create(`10.9.0.${i}, 203.0.113.7`)).status);
    assert.deepEqual(statuses, [201, 201, 429, 429, 429]);
    assert.equal((await create('10.9.0.1, 203.0.113.8')).status, 201, 'a different real client has its own budget');
  });

  it('IPv6 clients share one bucket per /64', async () => {
    s.advance(60_000);
    assert.equal((await create('2001:db8:1:2::a')).status, 201);
    assert.equal((await create('2001:db8:1:2:ffff:ffff:ffff:1')).status, 201);
    assert.equal((await create('2001:db8:1:2::beef')).status, 429, 'rotating addresses inside the /64 does not help');
    assert.equal((await create('2001:db8:1:3::a')).status, 201, 'a neighbouring /64 is a different client');
  });
});
