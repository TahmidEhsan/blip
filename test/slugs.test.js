import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RANDOM_ALPHABET, RESERVED_SLUGS, SLUG_RE, checkSlug, freeRandomSlug, freeWordSlug, normalizeSlug, randomSlug, suggestSlugs,
  validateSlug, wordSlug,
} from '../server/slugs.js';
import { ADJECTIVES, NOUNS } from '../server/words.js';
import { insertLink } from '../server/db.js';
import { LINK_DEFAULTS } from '../server/links.js';
import { closeTestDatabase, openTestDatabase } from './helpers.js';

describe('slugs', () => {
  let db;
  const addLink = (slug) => insertLink(db, {
    ...LINK_DEFAULTS, slug, domain: 'localhost:3030', target_url: 'https://example.com/', manage_token_hash: 'x', created_at: 1, updated_at: 1,
  });

  before(async () => {
    db = await openTestDatabase();
  });
  after(() => closeTestDatabase(db));

  it('normalizes per SPEC §4.1', () => {
    assert.equal(normalizeSlug('Summer Sale 2026!'), 'summer-sale-2026');
    assert.equal(normalizeSlug('Café_Menu'), 'cafe-menu');
    assert.equal(normalizeSlug('Rock & Roll'), 'rock-and-roll');
    assert.equal(normalizeSlug('  --a//b..c--  '), 'a-b-c');
    assert.equal(normalizeSlug('Crème Brûlée'), 'creme-brulee');
    assert.equal(normalizeSlug('ÉTÉ   2026'), 'ete-2026');
    assert.equal(normalizeSlug(`emoji ${String.fromCodePoint(0x1F389)} party`), 'emoji-party');
    assert.equal(normalizeSlug('!!!'), '');
    assert.equal(normalizeSlug(null), '');
    assert.equal(normalizeSlug(12345), '12345');
    const long = normalizeSlug(`${'a'.repeat(63)} b`);
    assert.equal(long, 'a'.repeat(63));
    assert.ok(SLUG_RE.test(normalizeSlug('x'.repeat(100))));
    assert.equal(normalizeSlug('x'.repeat(100)).length, 64);
  });

  it('validates shape and reserved words', () => {
    assert.equal(validateSlug('ok-slug'), null);
    assert.equal(validateSlug(''), 'empty');
    assert.equal(validateSlug('-bad'), 'invalid');
    assert.equal(validateSlug('Bad'), 'invalid');
    assert.equal(validateSlug('a'.repeat(65)), 'invalid');
    for (const r of ['api', 'dashboard', 'qr', 'well-known', 'favicon', 'expired']) {
      assert.ok(RESERVED_SLUGS.has(r));
      assert.equal(validateSlug(r), 'reserved');
    }
  });

  it('checkSlug reports empty / invalid / reserved / taken / available', async () => {
    await addLink('taken-one');
    assert.deepEqual(await checkSlug(db, ''), { input: '', normalized: '', valid: false, available: false, reason: 'empty' });
    assert.equal((await checkSlug(db, '!!!')).reason, 'invalid');
    assert.equal((await checkSlug(db, 'x'.repeat(201))).reason, 'invalid');
    assert.equal((await checkSlug(db, 'API')).reason, 'reserved');
    const taken = await checkSlug(db, 'Taken One');
    assert.equal(taken.normalized, 'taken-one');
    assert.equal(taken.valid, true);
    assert.equal(taken.available, false);
    assert.equal(taken.reason, 'taken');
    assert.deepEqual(await checkSlug(db, 'Fresh Idea'), { input: 'Fresh Idea', normalized: 'fresh-idea', valid: true, available: true, reason: null });
  });

  it('randomSlug uses 7 unambiguous characters and avoids collisions', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const s = randomSlug({ isTaken: (x) => seen.has(x) });
      assert.equal(s.length, 7);
      assert.ok([...s].every((ch) => RANDOM_ALPHABET.includes(ch)), s);
      assert.ok(!seen.has(s));
      seen.add(s);
    }
    // When every 7-char candidate collides it grows.
    assert.ok(randomSlug({ isTaken: (x) => x.length === 7 }).length > 7);
  });

  it('wordSlug makes adjective-noun slugs and falls back on collision', () => {
    const s = wordSlug();
    const [adj, noun] = s.split('-');
    assert.ok(ADJECTIVES.includes(adj), s);
    assert.ok(NOUNS.includes(noun), s);
    const withNumber = wordSlug({ isTaken: (x) => x.split('-').length === 2 });
    assert.match(withNumber, /^[a-z]+-[a-z]+-\d{2}$/);
    const triple = wordSlug({ isTaken: (x) => x.split('-').length === 2 || /\d/.test(x) });
    assert.equal(triple.split('-').length, 3);
    assert.ok(SLUG_RE.test(triple));
  });

  it('freeWordSlug and freeRandomSlug take an async isTaken and pick the same slugs', async () => {
    const seeded = (seed) => () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const takenTwoPart = (x) => x.split('-').length === 2;
    assert.equal(
      await freeWordSlug({ isTaken: async (x) => takenTwoPart(x), random: seeded(7) }),
      wordSlug({ isTaken: takenTwoPart, random: seeded(7) }),
      'same candidates, same order, same draws from random',
    );
    const asked = [];
    const free = await freeRandomSlug({ isTaken: async (x) => { asked.push(x); return asked.length < 3; } });
    assert.equal(asked.length, 3, 'one lookup per candidate until a free one');
    assert.equal(free, asked[2]);
    assert.equal(free.length, 7);
  });

  it('suggestSlugs returns valid, available, unique suggestions', async () => {
    await addLink('summer-sale');
    const now = () => Date.parse('2026-10-07T12:00:00Z');
    const list = await suggestSlugs(db, 'Summer Sale', 8, { now });
    assert.equal(list.length, 8);
    assert.equal(new Set(list).size, 8);
    assert.ok(!list.includes('summer-sale'), 'taken slug must not be suggested');
    assert.equal(list[0], 'summer-sale-2026');
    assert.ok(list.includes('summer-sale-go'));
    for (const s of list) assert.equal((await checkSlug(db, s)).available, true, s);

    const words = await suggestSlugs(db, '', 5);
    assert.equal(words.length, 5);
    for (const s of words) assert.match(s, /^[a-z]+-[a-z]+(-[a-z0-9]+)?$/);

    assert.equal((await suggestSlugs(db, 'api')).includes('api'), false, 'reserved never suggested');
    assert.equal((await suggestSlugs(db, 'x', 50)).length, 12, 'count is capped at 12');
  });

  it('word lists are big, unique and family-friendly shaped', () => {
    for (const list of [ADJECTIVES, NOUNS]) {
      assert.ok(list.length >= 150, `only ${list.length} words`);
      assert.equal(new Set(list).size, list.length, 'duplicates');
      for (const w of list) assert.match(w, /^[a-z]{2,10}$/);
    }
  });
});
