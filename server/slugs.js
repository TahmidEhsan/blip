// Blip: slug normalisation, validation and generation (SPEC §4.1).
import crypto from 'node:crypto';
import { ADJECTIVES, NOUNS } from './words.js';
import { slugTaken, takenSlugs } from './db.js';

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
 * @returns {Promise<{ input: string, normalized: string, valid: boolean, available: boolean, reason: null|'empty'|'invalid'|'reserved'|'taken' }>}
 */
export async function checkSlug(db, input) {
  const raw = input === null || input === undefined ? '' : String(input);
  const tooLong = raw.length > SLUG_INPUT_MAX;
  const normalized = tooLong ? '' : normalizeSlug(raw);
  let reason;
  if (!raw.trim()) reason = 'empty';
  else if (tooLong || !normalized) reason = 'invalid';
  else reason = validateSlug(normalized);
  const valid = reason === null;
  if (valid && await slugTaken(db, normalized)) reason = 'taken';
  return { input: raw, normalized, valid, available: valid && reason === null, reason };
}

/** Uniform float in [0, 1) from the CSPRNG. */
export function cryptoRandom() {
  // crypto.randomInt requires (max - min) < 2^48.
  return crypto.randomInt(0, 2 ** 47) / 2 ** 47;
}

const pickWord = (list, random) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];

/**
 * Random slug candidates: crypto-random characters from an unambiguous alphabet, growing by one
 * character every 10 attempts, 60 attempts in all. Lazy, so only the candidates tried are drawn.
 */
function* randomSlugCandidates(length) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const len = Math.min(SLUG_MAX, length + Math.floor(attempt / 10));
    let slug = '';
    for (let i = 0; i < len; i += 1) slug += RANDOM_ALPHABET[crypto.randomInt(RANDOM_ALPHABET.length)];
    yield slug;
  }
}

/**
 * Word slug candidates: 12 × `adjective-noun`, then 12 × `adjective-noun-NN`, then
 * 12 × `adjective-adjective-noun`, then (practically unreachable) `adjective-noun-<random>`.
 * Lazy, so `random` is only called for the candidates tried.
 */
function* wordSlugCandidates(random) {
  for (let i = 0; i < 12; i += 1) yield `${pickWord(ADJECTIVES, random)}-${pickWord(NOUNS, random)}`;
  for (let i = 0; i < 12; i += 1) {
    const n = 10 + Math.floor(random() * 90);
    yield `${pickWord(ADJECTIVES, random)}-${pickWord(NOUNS, random)}-${n}`;
  }
  for (let i = 0; i < 12; i += 1) {
    const a = pickWord(ADJECTIVES, random);
    let b = pickWord(ADJECTIVES, random);
    if (b === a) b = ADJECTIVES[(ADJECTIVES.indexOf(a) + 1) % ADJECTIVES.length];
    yield `${a}-${b}-${pickWord(NOUNS, random)}`;
  }
  const base = `${pickWord(ADJECTIVES, random)}-${pickWord(NOUNS, random)}`;
  for (const tail of randomSlugCandidates(4)) yield `${base}-${tail}`;
}

function firstFree(candidates, isTaken, kind) {
  for (const slug of candidates) if (isUsableSlug(slug) && !isTaken(slug)) return slug;
  throw new Error(`Could not generate a unique ${kind} slug`);
}

async function firstFreeAsync(candidates, isTaken, kind) {
  for (const slug of candidates) if (isUsableSlug(slug) && !(await isTaken(slug))) return slug;
  throw new Error(`Could not generate a unique ${kind} slug`);
}

/**
 * 7 crypto-random characters from an unambiguous alphabet; retries on collision
 * (and grows by one character every 10 failed attempts).
 * @param {{ isTaken?: (slug: string) => boolean, length?: number }} [opts]
 */
export function randomSlug({ isTaken = () => false, length = 7 } = {}) {
  return firstFree(randomSlugCandidates(length), isTaken, 'random');
}

/**
 * `adjective-noun`, falling back to `adjective-noun-NN` and then `adjective-adjective-noun`.
 * @param {{ isTaken?: (slug: string) => boolean, random?: () => number }} [opts]
 */
export function wordSlug({ isTaken = () => false, random = cryptoRandom } = {}) {
  return firstFree(wordSlugCandidates(random), isTaken, 'word');
}

/**
 * randomSlug with an async `isTaken` (one database lookup per candidate tried; the first one is
 * almost always free).
 * @param {{ isTaken: (slug: string) => Promise<boolean>|boolean, length?: number }} opts
 */
export function freeRandomSlug({ isTaken, length = 7 }) {
  return firstFreeAsync(randomSlugCandidates(length), isTaken, 'random');
}

/**
 * wordSlug with an async `isTaken`: the same candidates, in the same order, drawing `random` the same way.
 * @param {{ isTaken: (slug: string) => Promise<boolean>|boolean, random?: () => number }} opts
 */
export function freeWordSlug({ isTaken, random = cryptoRandom }) {
  return firstFreeAsync(wordSlugCandidates(random), isTaken, 'word');
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
 * Candidates are checked against the database in bulk (one round trip per round, usually one or two).
 * @param {import('./db.js').Database} db
 * @param {string} [phrase]
 * @param {number} [count]
 * @param {{ random?: () => number, now?: () => number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function suggestSlugs(db, phrase = '', count = 6, { random = cryptoRandom, now = Date.now } = {}) {
  const want = Math.max(1, Math.min(12, Math.floor(Number(count)) || 6));
  const out = [];
  const seen = new Set();
  /** Offer candidates in order: new, usable and not taken ones are kept until `want` is reached. */
  const offerAll = async (candidates) => {
    const fresh = [];
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      if (isUsableSlug(candidate)) fresh.push(candidate);
    }
    const taken = await takenSlugs(db, fresh);
    for (const candidate of fresh) if (out.length < want && !taken.has(candidate)) out.push(candidate);
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
    await offerAll(candidates);
  }
  // Fill with word slugs, a round at a time: draw as many as are still missing, then check them together.
  let guard = 0;
  while (out.length < want && guard < want * 10) {
    const round = [];
    while (round.length < want - out.length && guard < want * 10) {
      guard += 1;
      round.push(wordSlug({ isTaken: (s) => seen.has(s) || round.includes(s), random }));
    }
    await offerAll(round);
  }
  return out;
}
