// Blip: JSON API under /api (SPEC §5).
import crypto from 'node:crypto';
import express from 'express';
import {
  deleteLink, deleteSyntheticClicks, findLinkById, findLinkBySlug, insertLink, isUniqueViolation, sha256Hex,
  slugTaken, updateLink,
} from '../db.js';
import { HttpError, errorBody, sendError, validationError } from '../errors.js';
import {
  LIMITS, LINK_DEFAULTS, TEASER_LIMITS, TEASER_STYLES, TEASER_THEMES, isPlainObject, linkStatus, statusPayload,
  toLinkDto, validateLinkBody,
} from '../links.js';
import {
  SLUG_INPUT_MAX, SLUG_RE, checkSlug, normalizeSlug, randomSlug, suggestSlugs, validateSlug, wordSlug,
} from '../slugs.js';
import { KEYWORD_MAX, domainIdeas, domainOptions } from '../domains.js';
import { STATS_RANGES, allTimeTotals, buildStats, parseTzOffset } from '../analytics.js';
import { clientKey, createRateLimiter } from '../ratelimit.js';
import { linkChannel, publish } from '../bus.js';
import { simulateTraffic } from '../simulate.js';

const SSE_HEARTBEAT_MS = 15_000;
const SSE_RETRY_AFTER_S = 10;
const BATCH_MAX = 100;
const TOKEN_MAX = 256;

/** First string value of a query parameter (Express may hand back arrays). */
function queryString(req, name) {
  const v = req.query?.[name];
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

/** Constant-time comparison of sha256(token) with the stored hash. */
export function tokenMatches(token, storedHash) {
  if (typeof token !== 'string' || !token || token.length > TOKEN_MAX || typeof storedHash !== 'string') return false;
  const a = Buffer.from(sha256Hex(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * @param {object} ctx shared app context (db, config, now, random, bus, liveTotals, timers, streams, rateLimits, streamLimits)
 */
export function createApiRouter(ctx) {
  const { db, config, bus } = ctx;
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
  function requireManage(req, res, next) {
    const token = req.get('x-manage-token');
    if (!token) {
      sendError(res, 401, 'unauthorized', 'This action needs the link’s manage token (X-Manage-Token header).');
      return;
    }
    const slug = String(req.params.slug ?? '').toLowerCase();
    const link = SLUG_RE.test(slug) ? findLinkBySlug(db, slug) : null;
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
  const publishStatus = (link, now) => publish(bus, link.id, 'status', statusPayload(link, now));

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
  router.get('/slugs/check', lookupLimiter, (req, res) => {
    res.json(checkSlug(db, queryString(req, 'slug') ?? ''));
  });

  router.get('/slugs/suggest', lookupLimiter, (req, res) => {
    const phrase = queryString(req, 'phrase') ?? '';
    if (phrase.length > SLUG_INPUT_MAX) throw validationError('phrase', `phrase must be ${SLUG_INPUT_MAX} characters or fewer.`);
    const rawCount = queryString(req, 'count');
    let count = 6;
    if (rawCount !== undefined && rawCount !== '') {
      count = Number(rawCount);
      if (!Number.isInteger(count) || count < 1 || count > 12) throw validationError('count', 'count must be between 1 and 12.');
    }
    res.json({ suggestions: suggestSlugs(db, phrase, count, { random: ctx.random, now: ctx.now }) });
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
  router.post('/links', createLimiter, (req, res) => {
    const body = req.body ?? {};
    if (!isPlainObject(body)) throw validationError(null, 'Request body must be a JSON object.');
    const now = ctx.now();
    const fields = validateLinkBody(body, { mode: 'create', config, now, current: LINK_DEFAULTS });

    const isTaken = (s) => slugTaken(db, s);
    let slug;
    const rawSlug = body.slug;
    if (rawSlug !== undefined && rawSlug !== null && String(rawSlug).trim() !== '') {
      if (typeof rawSlug !== 'string' && typeof rawSlug !== 'number') throw validationError('slug', 'slug must be a string.');
      const input = String(rawSlug);
      slug = input.length > SLUG_INPUT_MAX ? '' : normalizeSlug(input);
      const reason = validateSlug(slug);
      if (reason === 'empty' || reason === 'invalid') {
        throw new HttpError(400, 'slug_invalid', 'Slugs need at least one letter or number (a-z, 0-9 and dashes).', 'slug');
      }
      if (reason === 'reserved') throw new HttpError(400, 'slug_reserved', `“${slug}” is reserved. Pick another slug.`, 'slug');
      if (isTaken(slug)) throw new HttpError(409, 'slug_taken', `“${slug}” is already taken. Try a suggestion.`, 'slug');
    } else {
      const style = body.slugStyle ?? 'words';
      if (style !== 'words' && style !== 'random') throw validationError('slugStyle', 'slugStyle must be "words" or "random".');
      slug = style === 'random' ? randomSlug({ isTaken }) : wordSlug({ isTaken, random: ctx.random });
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
    let id;
    try {
      id = insertLink(db, row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'slug_taken', `“${slug}” is already taken. Try a suggestion.`, 'slug');
      throw err;
    }
    res.status(201).json({ link: dto(findLinkById(db, id), now), manageToken });
  });

  router.post('/links/batch', (req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length > BATCH_MAX) {
      throw validationError('items', `items must be an array of at most ${BATCH_MAX} { slug, token } objects.`);
    }
    const now = ctx.now();
    const results = items.map((item) => {
      const inputSlug = typeof item?.slug === 'string' ? item.slug : '';
      const slug = inputSlug.toLowerCase();
      const link = SLUG_RE.test(slug) ? findLinkBySlug(db, slug) : null;
      if (!link) return { slug: inputSlug, link: null, error: 'not_found' };
      if (!tokenMatches(item?.token, link.manage_token_hash)) return { slug: inputSlug, link: null, error: 'forbidden' };
      return { slug: inputSlug, link: dto(link, now), error: null };
    });
    res.json({ results });
  });

  router.get('/links/:slug', requireManage, (req, res) => {
    res.json({ link: dto(res.locals.link) });
  });

  router.patch('/links/:slug', requireManage, (req, res) => {
    const link = res.locals.link;
    const now = ctx.now();
    const before = linkStatus(link, now);
    const fields = validateLinkBody(req.body ?? {}, { mode: 'update', config, now, current: link });
    if (Object.keys(fields).length) updateLink(db, link.id, { ...fields, updated_at: now });
    const updated = findLinkById(db, link.id);
    const after = linkStatus(updated, now);
    if (before.status !== after.status || before.expiredReason !== after.expiredReason) publishStatus(updated, now);
    res.json({ link: dto(updated, now) });
  });

  router.delete('/links/:slug', requireManage, (req, res) => {
    const link = res.locals.link;
    deleteLink(db, link.id);
    ctx.liveTotals.forget(link.id);
    publish(bus, link.id, 'deleted', { slug: link.slug });
    res.status(204).end();
  });

  router.post('/links/:slug/destroy', requireManage, (req, res) => {
    const link = res.locals.link;
    const now = ctx.now();
    if (link.destroyed_at === null) {
      updateLink(db, link.id, { destroyed_at: now, updated_at: now });
    }
    const updated = findLinkById(db, link.id);
    publishStatus(updated, now);
    res.json({ link: dto(updated, now) });
  });

  router.post('/links/:slug/revive', requireManage, (req, res) => {
    const link = res.locals.link;
    const now = ctx.now();
    if (link.destroyed_at !== null) {
      updateLink(db, link.id, { destroyed_at: null, updated_at: now });
    }
    const updated = findLinkById(db, link.id);
    publishStatus(updated, now);
    res.json({ link: dto(updated, now) });
  });

  router.get('/links/:slug/stats', requireManage, (req, res) => {
    const range = queryString(req, 'range') ?? '7d';
    if (!STATS_RANGES.includes(range)) throw validationError('range', `range must be one of: ${STATS_RANGES.join(', ')}.`);
    const tz = parseTzOffset(queryString(req, 'tz'));
    if (tz === null) throw validationError('tz', 'tz must be a whole number of minutes between -840 and 840.');
    res.json(buildStats(db, res.locals.link, { range, tz, now: ctx.now() }));
  });

  // Open live streams per link id and per client key, so one client (or a leaked token) can't
  // pin an unbounded number of long-lived connections.
  const openStreams = { byLink: new Map(), byClient: new Map() };
  const bump = (map, key, delta) => {
    const n = (map.get(key) ?? 0) + delta;
    if (n > 0) map.set(key, n);
    else map.delete(key);
  };

  router.get('/links/:slug/stream', requireManage, (req, res) => {
    const link = res.locals.link;
    const channel = linkChannel(link.id);
    const client = clientKey(req.ip);
    const { perLink, perClient } = ctx.streamLimits;
    if ((openStreams.byLink.get(link.id) ?? 0) >= perLink || (openStreams.byClient.get(client) ?? 0) >= perClient) {
      res.set('Retry-After', String(SSE_RETRY_AFTER_S));
      sendError(res, 429, 'rate_limited', 'Too many live dashboards are open. Close one and try again.');
      return;
    }
    bump(openStreams.byLink, link.id, 1);
    bump(openStreams.byClient, client, 1);
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    req.socket?.setNoDelay?.(true);

    const write = (chunk) => {
      if (!res.writableEnded && !res.destroyed) res.write(chunk);
    };
    const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let closed = false;
    const stream = {
      end() {
        cleanup();
        if (!res.writableEnded) res.end();
      },
    };
    const onEvent = ({ type, data }) => {
      if (type === 'deleted') stream.end();
      else send(type, data);
    };
    const heartbeat = setInterval(() => write(': ping\n\n'), SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      bus.off(channel, onEvent);
      ctx.streams.delete(stream);
      bump(openStreams.byLink, link.id, -1);
      bump(openStreams.byClient, client, -1);
      // Running live totals are only kept while someone is watching this link.
      if (bus.listenerCount(channel) === 0) ctx.liveTotals.forget(link.id);
    }

    bus.on(channel, onEvent);
    ctx.streams.add(stream);
    // `res` 'close' fires when the client disconnects or we end the stream.
    res.on('close', cleanup);
    req.on('close', () => {
      if (res.destroyed || req.socket?.destroyed) cleanup();
    });
    // Computed synchronously right after subscribing, so these totals also seed the running
    // counters that later `click` events advance (no rescan on the first click).
    const totals = allTimeTotals(db, link, ctx.now());
    ctx.liveTotals.seed(link.id, totals);
    send('hello', { slug: link.slug, totals });
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
    (req, res) => {
      const body = req.body ?? {};
      if (!isPlainObject(body)) throw validationError(null, 'Request body must be a JSON object.');
      let count = 12;
      if (body.count !== undefined && body.count !== null) {
        count = Number(body.count);
        if (!Number.isInteger(count) || count < 1 || count > 50) throw validationError('count', 'count must be between 1 and 50.');
      }
      const inserted = simulateTraffic({
        db, bus, link: res.locals.link, count, now: ctx.now(), random: ctx.random, timers: ctx.timers, liveTotals: ctx.liveTotals,
      });
      res.json({ inserted });
    },
  );

  router.delete('/links/:slug/simulated', requireManage, (req, res) => {
    const deleted = deleteSyntheticClicks(db, res.locals.link.id);
    ctx.liveTotals.forget(res.locals.link.id); // re-seeded from the database on the next live click
    res.json({ deleted });
  });

  // Unknown /api routes → JSON 404 (never fall through to the slug handler).
  router.use((req, res) => {
    res.status(404).json(errorBody('not_found', `No API route for ${req.method} ${req.baseUrl}${req.path}.`));
  });

  return router;
}
