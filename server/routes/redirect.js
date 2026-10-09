// Blip: GET /:slug visits (redirects, teasers, bot previews and self-destructed pages, SPEC §4.4).
import express from 'express';
import { consumeVisitAndRecordClick, findLinkById, findLinkBySlug, insertClick, lastConsumedClickTs } from '../db.js';
import { isBotUA, parseUserAgent, referrerHost, visitorHash } from '../analytics.js';
import { linkStatus } from '../links.js';
import { SLUG_RE, normalizeSlug } from '../slugs.js';
import { GEO_TIMEOUT_MS, cleanIp } from '../geo.js';
import { wake } from '../bus.js';
import { pickTrivia } from '../data/trivia.js';
import { teaserThemeId } from '../themes.js';

const PREVIEW_TITLE = 'Open this Blip link in your browser';
const EXPIRED_TITLE = 'This Blip has self-destructed';
/**
 * How long a visit that consumes nothing (a blocked attempt, a bot) waits for its click row before it
 * answers anyway. A round trip normally takes milliseconds; when the database stalls, the visitor still
 * gets their page and the row is stored late or, at worst, lost (it is analytics only).
 */
export const CLICK_WRITE_BUDGET_MS = 1500;

/** Resolve `promise` or give up with null after `ms`; never rejects. */
function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise).catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** Headers shared by every /:slug response. */
export function setVisitHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
}

/** 404 page for unknown slugs (also used for any unmatched non-API path). */
export async function sendNotFound(ctx, res, requested) {
  const raw = String(requested ?? '');
  const slug = normalizeSlug(raw.length > 200 ? raw.slice(0, 200) : raw);
  setVisitHeaders(res);
  const html = await ctx.renderView('not-found', { SLUG: slug, DATA: { slug } });
  res.status(404).type('html').send(html);
}

export function createRedirectRouter(ctx) {
  const { db, bus } = ctx;
  const router = express.Router();

  /**
   * 410 self-destructed page. `recording` is the blocked attempt being stored (or null for HEAD): it
   * runs alongside the "expired at" lookup, and the page is sent once both are done.
   */
  async function sendExpired(res, link, reason, recording = null) {
    const expiredAtLookup = reason === 'clicks' ? lastConsumedClickTs(db, link.id) : null;
    const [lastClick] = await Promise.all([expiredAtLookup, recording]);
    let expiredAt = null;
    if (reason === 'time') expiredAt = link.expires_at;
    else if (reason === 'manual') expiredAt = link.destroyed_at;
    else if (reason === 'clicks') expiredAt = lastClick ?? link.updated_at;
    const html = await ctx.renderView('expired', {
      TITLE: EXPIRED_TITLE,
      DATA: { slug: link.slug, reason, expiredAt: iso(expiredAt), clickCount: link.click_count, maxClicks: link.max_clicks ?? null },
    });
    res.status(410).type('html').send(html);
  }

  async function sendPreview(res) {
    const html = await ctx.renderView('preview', { TITLE: PREVIEW_TITLE });
    res.status(200).type('html').send(html);
  }

  async function sendActive(res, link) {
    if (link.redirect_mode !== 'teaser') {
      res.redirect(302, link.target_url);
      return;
    }
    const target = link.target_url;
    const targetHost = new URL(target).host;
    const seconds = link.teaser_seconds;
    const theme = teaserThemeId(link.teaser_theme);
    const html = await ctx.renderView('teaser', {
      TITLE: link.title || `Taking you to ${targetHost}`,
      TARGET: target,
      REFRESH: `${seconds + 1};url=${target}`,
      THEME: theme,
      DATA: {
        slug: link.slug,
        title: link.title ?? null,
        targetUrl: target,
        targetHost,
        seconds,
        style: link.teaser_style,
        message: link.teaser_message ?? null,
        theme,
        fact: pickTrivia(ctx.random),
      },
    });
    res.status(200).type('html').send(html);
  }

  /**
   * The click row for this visit (no raw IP): device, browser, OS, referrer host, coarse location and
   * visitor hash. The location lookup is capped at GEO_TIMEOUT_MS, and a failing one means "no
   * location". Never rejects.
   */
  async function clickRow(req, link, { outcome, isBot, now }) {
    const ua = req.get('user-agent') || '';
    const ip = cleanIp(req.ip || req.socket?.remoteAddress || '');
    const geo = await settleWithin(Promise.resolve().then(() => ctx.geoLookup(ip, req.headers)), GEO_TIMEOUT_MS);
    const { device, browser, os } = parseUserAgent(ua);
    return {
      link_id: link.id,
      ts: now,
      visitor_hash: visitorHash(ctx.salt, ip, ua),
      country: geo?.country ?? null,
      region: geo?.region ?? null,
      city: geo?.city ?? null,
      lat: geo?.lat ?? null,
      lon: geo?.lon ?? null,
      device: isBot ? 'bot' : device,
      browser,
      os,
      referrer_host: referrerHost(req.get('referer')),
      is_bot: isBot ? 1 : 0,
      is_synthetic: 0,
      outcome,
    };
  }

  /**
   * Store a click row for a visit that consumed nothing (a blocked attempt or a bot), then wake this
   * instance's live dashboards for the link: they read the row from the database (dashboards on other
   * instances see it at their next poll). Analytics never blocks or breaks the visit: a failure (the link
   * deleted meanwhile, a database error) is logged and swallowed, and a write still pending after
   * CLICK_WRITE_BUDGET_MS is left to finish on its own. Never rejects.
   * @param {Promise<object>|object} row the click row, or a promise of it (from clickRow)
   */
  async function storeClick(link, row) {
    const write = Promise.resolve(row)
      .then((click) => (ctx.isClosed() ? null : insertClick(db, click)))
      .then(() => true, (err) => {
        if (!ctx.isClosed()) console.error(`[blip] could not record a visit to /${link.slug}: ${ctx.redact(err?.message || err)}`);
        return false;
      });
    write.then(() => {
      if (!ctx.isClosed()) wake(bus, link.id);
    });
    if ((await settleWithin(write, CLICK_WRITE_BUDGET_MS)) === null) {
      console.error(`[blip] recording a visit to /${link.slug} is slow; answering without waiting for it`);
    }
  }

  // A visit makes at most two database round trips: look the link up, then consume the visit and
  // store its click row in one write batch. Losing the race for the last click adds a read and the
  // blocked attempt's row; a visit that consumes nothing (expired, bot) stores its row in one INSERT.
  router.get('/:slug', async (req, res) => {
    const now = ctx.now();
    setVisitHeaders(res);
    const requested = String(req.params.slug ?? '');
    const slug = requested.toLowerCase();
    const link = SLUG_RE.test(slug) ? await findLinkBySlug(db, slug) : null;
    if (!link) {
      await sendNotFound(ctx, res, requested);
      return;
    }

    const isHead = req.method === 'HEAD';
    const isBot = isBotUA(req.get('user-agent'));
    const state = linkStatus(link, now);

    // 4. Expired / destroyed → logged as a blocked attempt, never counted.
    if (state.status !== 'active') {
      await sendExpired(res, link, state.expiredReason, isHead ? null : storeClick(link, clickRow(req, link, { outcome: 'expired', isBot, now })));
      return;
    }

    // 5. Link-preview bots must not burn limited links (or learn the target).
    if (isBot && (link.max_clicks !== null || link.expires_at !== null)) {
      if (!isHead) await storeClick(link, clickRow(req, link, { outcome: 'bot-preview', isBot: true, now }));
      await sendPreview(res);
      return;
    }

    // 3. HEAD: same status as GET, nothing recorded or consumed. Because a HEAD never uses up a
    //    click, it must not reveal the target of a click-limited link either (same reason as
    //    step 5): answer the 302 without a Location header. Teaser bodies are dropped for HEAD.
    if (isHead) {
      if (link.redirect_mode !== 'teaser' && link.max_clicks !== null) {
        res.status(302).end();
        return;
      }
      await sendActive(res, link);
      return;
    }

    const outcome = link.redirect_mode === 'teaser' ? 'teaser' : 'redirect';
    if (isBot) {
      // Bots on unlimited links are logged but never consume.
      await storeClick(link, clickRow(req, link, { outcome, isBot, now }));
      await sendActive(res, link);
      return;
    }

    // 6 + 7. Consume atomically and store the click in the same write batch (one round trip, and a
    //        cancelled request can never split them), then wake live dashboards and respond.
    const row = await clickRow(req, link, { outcome, isBot, now });
    const result = await consumeVisitAndRecordClick(db, link.id, now, row);
    if (!result.consumed) {
      // Lost the race (another visitor took the last click, or the link was stopped or deleted meanwhile).
      const fresh = await findLinkById(db, link.id);
      if (!fresh) {
        await sendNotFound(ctx, res, requested);
        return;
      }
      const lost = linkStatus(fresh, now);
      await sendExpired(res, fresh, lost.expiredReason ?? 'clicks', storeClick(fresh, { ...row, outcome: 'expired' }));
      return;
    }
    // Also covers a visit that used up the last click: the stream sends the status change too.
    if (!ctx.isClosed()) wake(bus, link.id);
    await sendActive(res, link);
  });

  return router;
}
