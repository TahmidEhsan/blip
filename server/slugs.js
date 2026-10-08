// Blip: slug normalisation, validation and generation (SPEC §4.1).
import crypto from 'node:crypto';
import { ADJECTIVES, NOUNS } from './words.js';
import { slugTaken } from './db.js';

export const SLUG_MAX = 64;
/** Raw slug input longer than this is rejected outright instead of being truncated. */
export const SLUG_INPUT_MAX = 200;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const RANDOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export const RESERVED_SLUGS = new Set([
  'api', 'assets', 'vendor', 'static', 'public', 'health', 'healthz', 'admin', 'dashboard', 'qr', 'new',
  'create', 'login', 'logout', 'signup', 'about', 'help', 'terms', 'privacy', 'expired', 'preview',
  'teaser', 'index', 'favicon', 'robots', 'sitemap', 'well-known',
]);

const trimDashes = (s) => s.replace(/^-+|-+$/g, '');

/** "Summer Sale 2026!" → "summer-sale-2026", "Café_Menu" → "cafe-menu". */
export function normalizeSlug(input) {
  if (input === null || input === undefined) return '';
  let s = String(input)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\s_./\\]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-');
  s = trimDashes(s);
  if (s.length > SLUG_MAX) s = s.slice(0, SLUG_MAX).replace(/-+$/, '');
  return s;
}

/** Shape-valid (regex) and not reserved. */
export function isUsableSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

/**
 * Validate an already-normalised slug.
 * @returns {null|'empty'|'invalid'|'reserved'}
 */
export function validateSlug(slug) {
  if (typeof slug !== 'string' || slug.length === 0) return 'empty';
  if (!SLUG_RE.test(slug)) return 'invalid';
  if (RESERVED_SLUGS.has(slug)) return 'reserved';
  return null;
}

/**
 * Full check of user input, as returned by GET /api/slugs/check.
 * @returns {{ input: string, normalized: string, valid: boolean, available: boolean, reason: null|'empty'|'invalid'|'reserved'|'taken' }}
 */
export function checkSlug(db, input) {
  const raw = input === null || input === undefined ? '' : String(input);
  const tooLong = raw.length > SLUG_INPUT_MAX;
  const normalized = tooLong ? '' : normalizeSlug(raw);
  let reason;
  if (!raw.trim()) reason = 'empty';
  else if (tooLong || !normalized) reason = 'invalid';
  else reason = validateSlug(normalized);
  const valid = reason === null;
  if (valid && slugTaken(db, normalized)) reason = 'taken';
  return { input: raw, normalized, valid, available: valid && reason === null, reason };
}

/** Uniform float in [0, 1) from the CSPRNG. */
export function cryptoRandom() {
  // crypto.randomInt requires (max - min) < 2^48.
  return crypto.randomInt(0, 2 ** 47) / 2 ** 47;
}

const pickWord = (list, random) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];

/**
 * 7 crypto-random characters from an unambiguous alphabet; retries on collision
 * (and grows by one character every 10 failed attempts).
 * @param {{ isTaken?: (slug: string) => boolean, length?: number }} [opts]
 */
export function randomSlug({ isTaken = () => false, length = 7 } = {}) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const len = Math.min(SLUG_MAX, length + Math.floor(attempt / 10));
    let slug = '';
    for (let i = 0; i < len; i += 1) slug += RANDOM_ALPHABET[crypto.randomInt(RANDOM_ALPHABET.length)];
    if (isUsableSlug(slug) && !isTaken(slug)) return slug;
  }
  throw new Error('Could not generate a unique random slug');
}

/**
 * `adjective-noun`, falling back to `adjective-noun-NN` and then `adjective-adjective-noun`.
 * @param {{ isTaken?: (slug: string) => boolean, random?: () => number }} [opts]
 */
export function wordSlug({ isTaken = () => false, random = cryptoRandom } = {}) {
  const ok = (s) => isUsableSlug(s) && !isTaken(s);
  for (let i = 0; i < 12; i += 1) {
    const s = `${pickWord(ADJECTIVES, random)}-${pickWord(NOUNS, random)}`;
    if (ok(s)) return s;
  }
  for (let i = 0; i < 12; i += 1) {
    const n = 10 + Math.floor(random() * 90);
    const s = `${pickWord(ADJECTIVES, random)}-${pickWord(NOUNS, random)}-${n}`;
    if (ok(s)) return s;
  }
  for (let i = 0; i < 12; i += 1) {
    const a = pickWord(ADJECTIVES, random);
    let b = pickWord(ADJECTIVES, random);
    if (b === a) b = ADJECTIVES[(ADJECTIVES.indexOf(a) + 1) % ADJECTIVES.length];
    const s = `${a}-${b}-${pickWord(NOUNS, random)}`;
    if (ok(s)) return s;
  }
  // Practically unreachable: append crypto-random characters until unique.
  const base = `${pickWord(ADJECTIVES, random)}-${pickWord(NOUNS, random)}`;
  return `${base}-${randomSlug({ isTaken: (tail) => isTaken(`${base}-${tail}`), length: 4 })}`;
}

function withSuffix(base, suffix) {
  const room = SLUG_MAX - suffix.length - 1;
  const head = base.slice(0, room).replace(/-+$/, '');
  return head ? `${head}-${suffix}` : suffix;
}

function withPrefix(prefix, base) {
  const room = SLUG_MAX - prefix.length - 1;
  const tail = base.slice(0, room).replace(/-+$/, '');
  return tail ? `${prefix}-${tail}` : prefix;
}

/**
 * Up to `count` valid, available, unique slug suggestions.
 * With a phrase: the phrase itself, phrase + year, phrase + short words, adjective-phrase…, then word slugs.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [phrase]
 * @param {number} [count]
 * @param {{ random?: () => number, now?: () => number }} [opts]
 */
export function suggestSlugs(db, phrase = '', count = 6, { random = cryptoRandom, now = Date.now } = {}) {
  const want = Math.max(1, Math.min(12, Math.floor(Number(count)) || 6));
  const isTaken = (s) => slugTaken(db, s);
  const out = [];
  const seen = new Set();
  const offer = (candidate) => {
    if (out.length >= want || !candidate || seen.has(candidate)) return;
    seen.add(candidate);
    if (isUsableSlug(candidate) && !isTaken(candidate)) out.push(candidate);
  };

  const p = typeof phrase === 'string' && phrase.length <= SLUG_INPUT_MAX ? normalizeSlug(phrase) : '';
  if (p) {
    const year = new Date(now()).getUTCFullYear();
    const adjectives = [pickWord(ADJECTIVES, random), pickWord(ADJECTIVES, random), pickWord(ADJECTIVES, random)];
    const candidates = [
      p,
      withSuffix(p, String(year)),
      withPrefix(adjectives[0], p),
      withSuffix(p, 'go'),
      withSuffix(p, 'now'),
      withSuffix(p, 'hq'),
      withPrefix(adjectives[1], p),
      withSuffix(p, pickWord(NOUNS, random)),
      withPrefix('the', p),
      withPrefix('get', p),
      withSuffix(p, 'club'),
      withPrefix(adjectives[2], p),
      withSuffix(p, String(year + 1)),
    ];
    for (const c of candidates) offer(c);
  }
  let guard = 0;
  while (out.length < want && guard < want * 10) {
    guard += 1;
    offer(wordSlug({ isTaken: (s) => seen.has(s) || isTaken(s), random }));
  }
  return out;
}
