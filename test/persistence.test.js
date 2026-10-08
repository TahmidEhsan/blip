import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureIpHashSalt, migrateLegacyThemeIds, openDatabase } from '../server/db.js';
import { resolveConfig } from '../server/config.js';
import { effectiveDomain, toLinkDto } from '../server/links.js';
import { START_TIME, startServer } from './helpers.js';
import { QR_PRESETS } from '../public/assets/js/qr-shared.js';

/** The flat comic look a preset id stands for, as a stored qrStyle (no label). */
const flatLook = (id, extra = {}) => {
  const { label, ...look } = QR_PRESETS[id];
  return { ...look, caption: null, ...extra };
};

const EXPECTED_INDEXES = ['idx_clicks_link_counted', 'idx_clicks_link_real_ts', 'idx_clicks_link_ts', 'idx_clicks_link_visitor'];

describe('file databases', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blip-test-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reopening an existing database is idempotent and keeps data, indexes and the salt', () => {
    const file = path.join(dir, 'nested', 'reopen.db');
    const first = openDatabase(file);
    const salt = ensureIpHashSalt(first, null);
    first.prepare(`INSERT INTO links (slug, domain, target_url, manage_token_hash, created_at, updated_at)
                   VALUES ('kept', 'localhost:3030', 'https://example.com/', 'abc', 1, 1)`).run();
    first.close();

    for (let i = 0; i < 2; i += 1) {
      const again = openDatabase(file);
      try {
        assert.equal(again.prepare('PRAGMA user_version').get().user_version, 2);
        assert.equal(again.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
        assert.equal(again.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        const indexes = again.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'clicks' AND name LIKE 'idx_%' ORDER BY name").all();
        assert.deepEqual(indexes.map((r) => r.name), EXPECTED_INDEXES);
        assert.equal(again.prepare('SELECT COUNT(*) AS n FROM links').get().n, 1);
        assert.equal(ensureIpHashSalt(again, null), salt, 'the generated salt is persisted once');
      } finally {
        again.close();
      }
    }
  });

  it('migrates a first-release database to the comic theme and preset ids, once', () => {
    const file = path.join(dir, 'first-release.db');
    // Rows as the first release stored them, in a database still at schema version 1.
    const v1 = openDatabase(file);
    v1.exec('PRAGMA user_version = 1');
    const insert = v1.prepare(`INSERT INTO links (slug, domain, target_url, manage_token_hash, teaser_theme, qr_style, created_at, updated_at)
                               VALUES (?, 'localhost:3030', 'https://example.com/', 'abc', ?, ?, 1, 1)`);
    const style = (preset, extra = {}) => JSON.stringify({ preset, dotColor: '#111111', ...extra });
    const rows = [
      // slug, stored theme, stored qr_style, expected theme, expected preset (undefined = qr_style untouched)
      ['a', 'aurora', style('aurora', { dotColor2: '#d62828', gradientType: 'linear' }), 'hero', 'hero'],
      ['b', 'sunset', style('sunset'), 'caption', 'pop'],
      ['c', 'ocean', style('ocean'), 'sky', 'sky'],
      ['d', 'neon', style('mono'), 'noir', 'ink'],
      ['e', 'candy', style('candy'), 'paper', 'caption'],
      ['f', 'hero', style('forest'), 'hero', 'press'],
      ['g', 'plaid', null, 'hero', undefined],
      ['h', 'sky', '{not json', 'sky', undefined],
      ['i', 'noir', style('custom'), 'noir', undefined],
      ['j', 'paper', style('neon'), 'paper', 'noir'],
      // A caption and a centre logo the user picked survive; the preset's own old logo becomes the new preset's.
      ['k', 'hero', style('aurora', { dotType: 'rounded', logo: 'cat', caption: 'Scan me' }), 'hero', 'hero'],
      ['l', 'noir', style('neon', { logo: 'bolt' }), 'noir', 'noir'],
    ];
    const expectedStyle = {
      k: flatLook('hero', { logo: 'cat', caption: 'Scan me' }),
      l: flatLook('noir', { logo: 'star' }),
    };
    for (const [slug, theme, qrStyle] of rows) insert.run(slug, theme, qrStyle);
    v1.close();

    const db = openDatabase(file);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      for (const [slug, , qrStyle, theme, preset] of rows) {
        const row = db.prepare('SELECT teaser_theme, qr_style, updated_at FROM links WHERE slug = ?').get(slug);
        assert.equal(row.teaser_theme, theme, `${slug}: teaser theme`);
        if (preset === undefined) assert.equal(row.qr_style, qrStyle, `${slug}: qr_style untouched`);
        else assert.deepEqual(JSON.parse(row.qr_style), expectedStyle[slug] || flatLook(preset), `${slug}: the old look becomes the new preset's flat look`);
        assert.equal(row.updated_at, 1, `${slug}: a migration is not an edit`);
      }
      assert.deepEqual(migrateLegacyThemeIds(db), { teaserThemes: 0, qrPresets: 0 }, 'running it again changes nothing');
    } finally {
      db.close();
    }
    const reopened = openDatabase(file);
    try {
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 2);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM links WHERE teaser_theme NOT IN ('hero','caption','noir','sky','paper')").get().n, 0);
    } finally {
      reopened.close();
    }
  });

  it('new databases default teaser_theme to hero', () => {
    const db = openDatabase(':memory:');
    try {
      db.prepare(`INSERT INTO links (slug, domain, target_url, manage_token_hash, created_at, updated_at)
                  VALUES ('fresh', 'localhost:3030', 'https://example.com/', 'abc', 1, 1)`).run();
      assert.equal(db.prepare('SELECT teaser_theme FROM links').get().teaser_theme, 'hero');
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    } finally {
      db.close();
    }
  });

  it('links made under an old base URL keep a working short URL after PORT/BASE_URL changes', async () => {
    const dbPath = path.join(dir, 'moved.db');
    const original = await startServer({ config: { dbPath, baseUrl: 'http://localhost:3030', domains: ['cat.ly'] } });
    const moved = await original.createLink({ targetUrl: 'https://example.com/moved', slug: 'moved' });
    const meow = await original.createLink({ targetUrl: 'https://example.com/meow', slug: 'meow', domain: 'cat.ly' });
    assert.equal(moved.link.domain, 'localhost:3030');
    await original.stop();

    const s = await startServer({ config: { dbPath, baseUrl: 'http://localhost:4000', domains: ['go.to'] } });
    try {
      const { json } = await s.request('GET', '/api/links/moved', { token: moved.manageToken });
      assert.equal(json.link.domain, 'localhost:4000');
      assert.equal(json.link.domainLive, true);
      assert.equal(json.link.shortUrl, 'http://localhost:4000/moved');
      assert.equal(json.link.workingUrl, 'http://localhost:4000/moved');
      assert.equal(json.link.qrUrl, 'http://localhost:4000/moved');

      // A vanity domain dropped from DOMAINS falls back the same way (no https URL to a host we don't serve).
      const batch = await s.request('POST', '/api/links/batch', { body: { items: [{ slug: 'meow', token: meow.manageToken }] } });
      const vanity = batch.json.results[0].link;
      assert.equal(vanity.domain, 'localhost:4000');
      assert.equal(vanity.shortUrl, 'http://localhost:4000/meow');
      assert.equal(vanity.domainLive, true);

      // Clients that echo the stored legacy domain back get a 200, and the row is normalised.
      const echoed = await s.request('PATCH', '/api/links/moved', { token: moved.manageToken, body: { domain: 'localhost:3030', title: 'Moved' } });
      assert.equal(echoed.status, 200);
      assert.equal(echoed.json.link.domain, 'localhost:4000');
      assert.equal(echoed.json.link.title, 'Moved');
      assert.equal(s.db.prepare('SELECT domain FROM links WHERE slug = ?').get('moved').domain, 'localhost:4000');
      // But an unknown domain that isn't the link's own stored one is still rejected.
      const unknown = await s.request('PATCH', '/api/links/moved', { token: moved.manageToken, body: { domain: 'localhost:3030' } });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.json.error.field, 'domain');
      const newVanity = await s.request('PATCH', '/api/links/meow', { token: meow.manageToken, body: { domain: 'go.to' } });
      assert.equal(newVanity.json.link.shortUrl, 'https://go.to/meow');

      assert.equal((await s.visit('moved')).status, 302, 'the link itself kept working all along');
    } finally {
      await s.stop();
    }
  });
});

describe('toLinkDto with a legacy stored domain', () => {
  const row = {
    id: 1, slug: 'legacy', domain: 'localhost:3030', target_url: 'https://example.com/', title: null, manage_token_hash: 'x',
    redirect_mode: 'instant', teaser_seconds: 5, teaser_style: 'countdown', teaser_message: null, teaser_theme: 'aurora',
    expires_at: null, max_clicks: null, click_count: 0, destroyed_at: null, qr_style: null, created_at: START_TIME, updated_at: START_TIME,
  };

  it('maps an unknown stored domain to the current base host', () => {
    const config = resolveConfig({ baseUrl: 'http://localhost:4000', dbPath: ':memory:', domains: ['cat.ly'], liveDomains: [] });
    const dto = toLinkDto(row, config, START_TIME);
    assert.equal(dto.domain, 'localhost:4000');
    assert.equal(dto.domainLive, true);
    assert.equal(dto.shortUrl, 'http://localhost:4000/legacy');
    assert.equal(dto.shortUrl, dto.workingUrl);
    assert.equal(dto.qrUrl, dto.workingUrl);
    assert.equal(effectiveDomain({ domain: 'cat.ly' }, config), 'cat.ly', 'configured vanity domains are kept');
    assert.equal(toLinkDto({ ...row, domain: 'cat.ly' }, config, START_TIME).shortUrl, 'https://cat.ly/legacy');
  });

  it('reports first-release theme and preset ids under their new names', () => {
    const config = resolveConfig({ dbPath: ':memory:' });
    const dto = toLinkDto({ ...row, qr_style: JSON.stringify({ preset: 'candy', logo: 'heart' }) }, config, START_TIME);
    assert.equal(dto.teaser.theme, 'hero', 'aurora is served as hero');
    assert.deepEqual(dto.qrStyle, flatLook('caption', { logo: 'heart' }), 'candy becomes the flat caption look, keeping the logo the user picked');
    assert.equal(toLinkDto({ ...row, teaser_theme: 'candy' }, config, START_TIME).teaser.theme, 'paper');
    assert.equal(toLinkDto({ ...row, teaser_theme: 'sky' }, config, START_TIME).teaser.theme, 'sky');
    assert.equal(toLinkDto({ ...row, qr_style: '{"logo":"cat"}' }, config, START_TIME).qrStyle.preset, undefined, 'a style without a preset stays without one');
  });
});

describe('shutdown', () => {
  it('close() closes the database, and tolerates one that is already closed', async () => {
    const s = await startServer();
    await s.stop();
    assert.throws(() => s.db.prepare('SELECT 1'), /not open/i, 'the database is closed');
    assert.doesNotThrow(() => s.close(), 'a second close() is a no-op');

    const closedElsewhere = await startServer();
    closedElsewhere.db.close();
    await assert.doesNotReject(closedElsewhere.stop());
  });
});
