// Blip: JSON API under /api (SPEC §5).
import crypto from 'node:crypto';
import express from 'express';
import {
  deleteLink, deleteSyntheticClicks, findLinkBySlug, findLinksBySlugs, insertLink, isUniqueViolation, sha256Hex,
  slugTaken, updateLink,
} from '../db.js';
import { HttpError, asNumber, asText, errorBody, sendError, validationError } from '../errors.js';
import {
  LIMITS, LINK_DEFAULTS, TEASER_LIMITS, TEASER_STYLES, TEASER_THEMES, isPlainObject, toLinkDto, validateLinkBody,
} from '../links.js';
import {
  SLUG_INPUT_MAX, SLUG_RE, checkSlug, freeRandomSlug, freeWordSlug, normalizeSlug, suggestSlugs, validateSlug,
} from '../slugs.js';
import { KEYWORD_MAX, domainIdeas, domainOptions } from '../domains.js';
import { STATS_RANGES, buildStats, parseTzOffset } from '../analytics.js';
import { clientKey, createRateLimiter } from '../ratelimit.js';
import { wake } from '../bus.js';
import { clientGone, serveLiveStream } from '../live.js';
import { simulateTraffic } from '../simulate.js';

const SSE_RETRY_AFTER_S = 10;
/**
 * A client at its live-stream cap that connects again ends its own oldest stream instead of getting a
 * 429, once that stream is at least this old (two heartbeats). A dashboard that was closed or reloaded
 * without its disconnect reaching the server (a proxy that never reports it) then never blocks the next
 * one, while a client that really has many dashboards open can't make them take turns forever.
 */
export const STREAM_EVICT_AFTER_MS = 30_000;
const BATCH_MAX = 100;
const TOKEN_MAX = 256;

/** First string value of a query parameter (Express may hand back arrays). */
function queryString(req, name) {
  const v = req.query?.[name];
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

/** The link was deleted while this request was working on it. */
const linkGone = () => new HttpError(404, 'not_found', 'There’s no Blip link with that slug.');

/** Constant-time comparison of sha256(token) with the stored hash. */
export function tokenMatches(token, storedHash) {
  if (typeof token !== 'string' || !token || token.length > TOKEN_MAX || typeof storedHash !== 'string') return false;
  const a = Buffer.from(sha256Hex(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * @param {object} ctx shared app context (db, config, now, random, bus, streams, rateLimits, streamLimits, redact)
 */
export function createApiRouter(ctx) {
  const { answerInTime, writeInTime, db, config, bus } = ctx;
  const router = express.Router();

  const limiter = (max) => createRateLimiter({ max, windowMs: 60_000, now: ctx.now });
  const createLimiter = limiter(ctx.rateLimits.createLink);
  const simulateLimiter = limiter(ctx.rateLimits.simulate);
  const lookupLimiter = limiter(ctx.rateLimits.lookup);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.json({ limit: '16kb' }));

  /** Loads the link named by :slug and checks X-Manage-Token (401 / 404 / 403). */
  async function requireManage(req, res, next) {
    const token = req.get('x-manage-token');
    if (!token) {
      sendError(res, 401, 'unauthorized', 'This action needs the link’s manage token (X-Manage-Token header).');
      return;
    }
    const slug = String(req.params.slug ?? '').toLowerCase();
    const link = SLUG_RE.test(slug) ? await answerInTime(findLinkBySlug(db, slug)) : null;
    if (!link) {
      sendError(res, 404, 'not_found', 'There’s no Blip link with that slug.');
      return;
    }
    if (!tokenMatches(token, link.manage_token_hash)) {
      sendError(res, 403, 'forbidden', 'That manage token doesn’t match this link.');
      return;
    }
    res.locals.link = link;
    next();
  }

  const dto = (link, now = ctx.now()) => toLinkDto(link, config, now);
  /** Open dashboards on this instance re-read the link now (the others notice at their next poll). */
  const notify = (link) => wake(bus, link.id);

  // ---- meta ----------------------------------------------------------------
  router.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  router.get('/config', (req, res) => {
    res.json({
      baseUrl: config.baseUrl,
      baseHost: config.baseHost,
      domains: domainOptions(config),
      defaultDomain: config.baseHost,
      allowDemoTraffic: config.allowDemoTraffic,
      teaser: { ...TEASER_LIMITS, styles: [...TEASER_STYLES], themes: [...TEASER_THEMES] },
      limits: { ...LIMITS },
    });
  });

  // ---- slugs & domains -----------------------------------------------------
  // Every database call a request waits for goes through answerInTime: one attempt waits at most
  // QUERY_TIMEOUT_MS on its socket and the driver retries a timed-out read or write once, so without its own
  // deadline a stalled cluster would hold the request about twice as long. A 503 for a write that was
  // applied anyway is harmless where repeating it gives the same result (PATCH, destroy, revive, delete,
  // clear). The two writes here that can't be repeated, a create's insert and simulated traffic, go through
  // writeInTime instead, whose limit leaves room for the driver's retry (app.js).
  router.get('/slugs/check', lookupLimiter, async (req, res) => {
    res.json(await answerInTime(checkSlug(db, queryString(req, 'slug') ?? '')));
  });

  router.get('/slugs/suggest', lookupLimiter, async (req, res) => {
    const phrase = queryString(req, 'phrase') ?? '';
    if (phrase.length > SLUG_INPUT_MAX) throw validationError('phrase', `phrase must be ${SLUG_INPUT_MAX} characters or fewer.`);
    const rawCount = queryString(req, 'count');
    let count = 6;
    if (rawCount !== undefined && rawCount !== '') {
      count = Number(rawCount);
      if (!Number.isInteger(count) || count < 1 || count > 12) throw validationError('count', 'count must be between 1 and 12.');
    }
    res.json({ suggestions: await answerInTime(suggestSlugs(db, phrase, count, { random: ctx.random, now: ctx.now })) });
  });

  router.get('/domains/ideas', lookupLimiter, (req, res) => {
    const keyword = (queryString(req, 'keyword') ?? '').trim();
    if (!keyword || keyword.length > KEYWORD_MAX) {
      throw validationError('keyword', `Enter a keyword of 1 to ${KEYWORD_MAX} characters.`);
    }
    const result = domainIdeas(keyword);
    if (!result.keyword) throw validationError('keyword', 'Use some letters or numbers in your keyword.');
    res.json(result);
  });

  // ---- links ---------------------------------------------------------------
  router.post('/links', createLimiter, async (req, res) => {
    const body = req.body ?? {};
    if (!isPlainObject(body)) throw validationError(null, 'Request body must be a JSON object.');
    const now = ctx.now();
    const fields = validateLinkBody(body, { mode: 'create', config, now, current: LINK_DEFAULTS });

    const isTaken = (s) => answerInTime(slugTaken(db, s));
    let slug;
    const rawSlug = body.slug;
    // asText, not String(): a JSON value String() throws on (such as {"toString":1}) is no slug either.
    const rawText = asText(rawSlug);
    if (rawSlug !== undefined && rawSlug !== null && rawText?.trim() !== '') {
      if (typeof rawSlug !== 'string' && typeof rawSlug !== 'number') throw validationError('slug', 'slug must be a string.');
      const input = rawText;
      slug = input.length > SLUG_INPUT_MAX ? '' : normalizeSlug(input);
      const reason = validateSlug(slug);
      if (reason === 'empty' || reason === 'invalid') {
        throw new HttpError(400, 'slug_invalid', 'Slugs need at least one letter or number (a-z, 0-9 and dashes).', 'slug');
      }
      if (reason === 'reserved') throw new HttpError(400, 'slug_reserved', `“${slug}” is reserved. Pick another slug.`, 'slug');
      if (await isTaken(slug)) throw new HttpError(409, 'slug_taken', `“${slug}” is already taken. Try a suggestion.`, 'slug');
    } else {
      const style = body.slugStyle ?? 'words';
      if (style !== 'words' && style !== 'random') throw validationError('slugStyle', 'slugStyle must be "words" or "random".');
      slug = style === 'random' ? await freeRandomSlug({ isTaken }) : await freeWordSlug({ isTaken, random: ctx.random });
    }

    const manageToken = crypto.randomBytes(24).toString('base64url');
    const row = {
      ...LINK_DEFAULTS,
      ...fields,
      slug,
      domain: fields.domain ?? config.baseHost,
      manage_token_hash: sha256Hex(manageToken),
      created_at: now,
      updated_at: now,
    };
    let stored;
    try {
      stored = await writeInTime(insertLink(db, row));
    } catch (err) {
      // Someone else took the slug between the check above and this insert. Only a duplicate slug says so:
      // insertLink handles an id that was already stored itself.
      if (isUniqueViolation(err, 'slug')) throw new HttpError(409, 'slug_taken', `“${slug}” is already taken. Try a suggestion.`, 'slug');
      throw err;
    }
    res.status(201).json({ link: dto(stored, now), manageToken });
  });

  router.post('/links/batch', async (req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length > BATCH_MAX) {
      throw validationError('items', `items must be an array of at most ${BATCH_MAX} { slug, token } objects.`);
    }
    const now = ctx.now();
    const slugOf = (item) => (typeof item?.slug === 'string' ? item.slug : '').toLowerCase();
    const found = await answerInTime(findLinksBySlugs(db, items.map(slugOf).filter((slug) => SLUG_RE.test(slug)))); // one round trip
    const results = items.map((item) => {
      const inputSlug = typeof item?.slug === 'string' ? item.slug : '';
      const slug = inputSlug.toLowerCase();
      const link = SLUG_RE.test(slug) ? found.get(slug) ?? null : null;
      if (!link) return { slug: inputSlug, link: null, error: 'not_found' };
      if (!tokenMatches(item?.token, link.manage_token_hash)) return { slug: inputSlug, link: null, error: 'forbidden' };
      return { slug: inputSlug, link: dto(link, now), error: null };
    });
    res.json({ results });
  });

  router.get('/links/:slug', requireManage, (req, res) => {
    res.json({ link: dto(res.locals.link) });
  });

  router.patch('/links/:slug', requireManage, async (req, res) => {
    const link = res.locals.link;
    const now = ctx.now();
    const fields = validateLinkBody(req.body ?? {}, { mode: 'update', config, now, current: link });
    const updated = Object.keys(fields).length ? await answerInTime(updateLink(db, link.id, { ...fields, updated_at: now })) : link;
    if (!updated) throw linkGone();
    // A stream sends `status` only when the status, reason or click numbers actually changed.
    if (Object.keys(fields).length) notify(updated);
    res.json({ link: dto(updated, now) });
  });

  router.delete('/links/:slug', requireManage, async (req, res) => {
    const link = res.locals.link;
    await answerInTime(deleteLink(db, link.id));
    notify(link); // its streams end
    res.status(204).end();
  });

  router.post('/links/:slug/destroy', requireManage, async (req, res) => {
    const link = res.locals.link;
    const now = ctx.now();
    const updated = link.destroyed_at === null ? await answerInTime(updateLink(db, link.id, { destroyed_at: now, updated_at: now })) : link;
    if (!updated) throw linkGone();
    notify(updated);
    res.json({ link: dto(updated, now) });
  });

  router.post('/links/:slug/revive', requireManage, async (req, res) => {
    const link = res.locals.link;
    const now = ctx.now();
    const updated = link.destroyed_at !== null ? await answerInTime(updateLink(db, link.id, { destroyed_at: null, updated_at: now })) : link;
    if (!updated) throw linkGone();
    notify(updated);
    res.json({ link: dto(updated, now) });
  });

  router.get('/links/:slug/stats', requireManage, async (req, res) => {
    const range = queryString(req, 'range') ?? '7d';
    if (!STATS_RANGES.includes(range)) throw validationError('range', `range must be one of: ${STATS_RANGES.join(', ')}.`);
    const tz = parseTzOffset(queryString(req, 'tz'));
    if (tz === null) throw validationError('tz', 'tz must be a whole number of minutes between -840 and 840.');
    res.json(await answerInTime(buildStats(db, res.locals.link, { range, tz, now: ctx.now() })));
  });

  // Open live streams per link id and per client key, so one client (or a leaked token) can't pin an
  // unbounded number of long-lived connections. Counted per server instance. Each is a Set of entries
  // `{ stream, linkId, client, openedAt }` in the order they opened, so the first one is the oldest.
  const openStreams = { byLink: new Map(), byClient: new Map() };
  const track = (map, key, entry) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(entry);
  };
  const untrack = (map, key, entry) => {
    const set = map.get(key);
    set?.delete(entry);
    if (set && !set.size) map.delete(key);
  };
  const oldest = (set, pred) => {
    for (const entry of set ?? []) if (pred(entry)) return entry;
    return null;
  };

  router.get('/links/:slug/stream', requireManage, async (req, res) => {
    // A client that left during the token check needs no stream, and must not end an older one of its own.
    if (clientGone(req, res)) return;
    const link = res.locals.link;
    const client = clientKey(req.ip);
    const { perLink, perClient } = ctx.streamLimits;
    const now = ctx.now();
    // Only this client's own streams can make room, and only ones old enough (STREAM_EVICT_AFTER_MS):
    // a leaked token can never end the owner's dashboards.
    const evictable = (entry) => entry.client === client && entry.stream && now - entry.openedAt >= STREAM_EVICT_AFTER_MS;
    const evict = [];
    const forLink = openStreams.byLink.get(link.id);
    if ((forLink?.size ?? 0) >= perLink) evict.push(oldest(forLink, evictable));
    const forClient = openStreams.byClient.get(client);
    if ((forClient?.size ?? 0) - evict.length >= perClient) evict.push(oldest(forClient, (entry) => evictable(entry) && !evict.includes(entry)));
    if (evict.includes(null)) {
      res.set('Retry-After', String(SSE_RETRY_AFTER_S));
      sendError(res, 429, 'rate_limited', 'Too many live dashboards are open. Close one and try again.');
      return;
    }
    for (const entry of evict) entry.stream.end(); // its onClose releases the slot

    const entry = { stream: null, linkId: link.id, client, openedAt: now };
    track(openStreams.byLink, link.id, entry);
    track(openStreams.byClient, client, entry);
    await serveLiveStream(ctx, req, res, link, {
      onOpen(stream) {
        entry.stream = stream;
      },
      onClose() {
        untrack(openStreams.byLink, link.id, entry);
        untrack(openStreams.byClient, client, entry);
      },
    });
  });

  router.post(
    '/links/:slug/simulate',
    (req, res, next) => {
      if (!config.allowDemoTraffic) {
        sendError(res, 404, 'not_found', 'Simulated traffic is turned off on this server.');
        return;
      }
      next();
    },
    simulateLimiter,
    requireManage,
    async (req, res) => {
      const body = req.body ?? {};
      if (!isPlainObject(body)) throw validationError(null, 'Request body must be a JSON object.');
      let count = 12;
      if (body.count !== undefined && body.count !== null) {
        count = asNumber(body.count);
        if (!Number.isInteger(count) || count < 1 || count > 50) throw validationError('count', 'count must be between 1 and 50.');
      }
      const link = res.locals.link;
      const inserted = await writeInTime(simulateTraffic({ db, link, count, now: ctx.now(), random: ctx.random }));
      notify(link);
      res.json({ inserted });
    },
  );

  router.delete('/links/:slug/simulated', requireManage, async (req, res) => {
    const link = res.locals.link;
    // Also bumps the clicks epoch, so every open dashboard (on any instance) recounts its live totals.
    const deleted = await answerInTime(deleteSyntheticClicks(db, link.id));
    notify(link);
    res.json({ deleted });
  });

  // Unknown /api routes → JSON 404 (never fall through to the slug handler).
  router.use((req, res) => {
    res.status(404).json(errorBody('not_found', `No API route for ${req.method} ${req.baseUrl}${req.path}.`));
  });

  return router;
}
