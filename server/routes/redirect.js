// Blip: GET /:slug visits (redirects, teasers, bot previews and self-destructed pages, SPEC §4.4).
import express from 'express';
import { consumeVisit, findLinkById, findLinkBySlug, insertClick, lastConsumedClickTs } from '../db.js';
import { clickEventFromRow, isBotUA, parseUserAgent, referrerHost, visitorHash } from '../analytics.js';
import { linkStatus, statusPayload } from '../links.js';
import { SLUG_RE, normalizeSlug } from '../slugs.js';
import { GEO_TIMEOUT_MS, cleanIp } from '../geo.js';
import { linkChannel, publish } from '../bus.js';
import { pickTrivia } from '../data/trivia.js';
import { teaserThemeId } from '../themes.js';

const PREVIEW_TITLE = 'Open this Blip link in your browser';
const EXPIRED_TITLE = 'This Blip has self-destructed';

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

  async function sendExpired(res, link, reason) {
    let expiredAt = null;
    if (reason === 'time') expiredAt = link.expires_at;
    else if (reason === 'manual') expiredAt = link.destroyed_at;
    else if (reason === 'clicks') expiredAt = lastConsumedClickTs(db, link.id) ?? link.updated_at;
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

  const hasListeners = (linkId) => bus.listenerCount(linkChannel(linkId)) > 0;

  /**
   * Store one click row (no raw IP) and push it to live dashboards. Analytics never blocks the
   * visit: any failure here (a geo provider that throws, the link deleted while geo was pending,
   * a SQLite error) is logged and swallowed so the visitor still gets their redirect or page.
   */
  async function recordClick(req, link, { outcome, isBot, now }) {
    try {
      const ua = req.get('user-agent') || '';
      const ip = cleanIp(req.ip || req.socket?.remoteAddress || '');
      const geo = await settleWithin(Promise.resolve().then(() => ctx.geoLookup(ip, req.headers)), GEO_TIMEOUT_MS);
      if (ctx.isClosed()) return;
      const { device, browser, os } = parseUserAgent(ua);
      const row = insertClick(db, {
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
      });
      // Totals are only computed (incrementally) when a dashboard is actually listening.
      if (hasListeners(link.id)) {
        publish(bus, link.id, 'click', { ...clickEventFromRow(row), totals: ctx.liveTotals.advance(link.id, row) });
      } else {
        ctx.liveTotals.forget(link.id); // never leave a running total behind that this row didn't advance
      }
    } catch (err) {
      console.error(`[blip] could not record a visit to /${link.slug}: ${err?.message || err}`);
    }
  }

  router.get('/:slug', async (req, res) => {
    const now = ctx.now();
    setVisitHeaders(res);
    const requested = String(req.params.slug ?? '');
    const slug = requested.toLowerCase();
    const link = SLUG_RE.test(slug) ? findLinkBySlug(db, slug) : null;
    if (!link) {
      await sendNotFound(ctx, res, requested);
      return;
    }

    const isHead = req.method === 'HEAD';
    const isBot = isBotUA(req.get('user-agent'));
    const state = linkStatus(link, now);

    // 4. Expired / destroyed → logged as a blocked attempt, never counted.
    if (state.status !== 'active') {
      if (!isHead) await recordClick(req, link, { outcome: 'expired', isBot, now });
      await sendExpired(res, link, state.expiredReason);
      return;
    }

    // 5. Link-preview bots must not burn limited links (or learn the target).
    if (isBot && (link.max_clicks !== null || link.expires_at !== null)) {
      if (!isHead) await recordClick(req, link, { outcome: 'bot-preview', isBot: true, now });
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

    // 6. Consume atomically (bots on unlimited links are logged but never consume).
    if (!isBot && consumeVisit(db, link.id, now) === 0) {
      const fresh = findLinkById(db, link.id) ?? link;
      const lost = linkStatus(fresh, now);
      await recordClick(req, fresh, { outcome: 'expired', isBot, now });
      await sendExpired(res, fresh, lost.expiredReason ?? 'clicks');
      return;
    }

    // 7. Record + publish, then 8. respond.
    await recordClick(req, link, { outcome: link.redirect_mode === 'teaser' ? 'teaser' : 'redirect', isBot, now });
    if (!isBot && link.max_clicks !== null && !ctx.isClosed() && hasListeners(link.id)) {
      const fresh = findLinkById(db, link.id);
      if (fresh && linkStatus(fresh, now).status !== 'active') publish(bus, link.id, 'status', statusPayload(fresh, now));
    }
    await sendActive(res, link);
  });

  return router;
}
