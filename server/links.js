// Blip: link status, LinkDTO mapping and create/update body validation (SPEC §4.3, §5.1, §5.2).
import os from 'node:os';
import { HttpError, validationError } from './errors.js';
import { bareHostname, normalizeTargetUrl, URL_MAX } from './urls.js';
import { storedQrStyle, validateQrStyle } from './qrstyle.js';
import { isDomainLive } from './domains.js';
import { SLUG_MAX, normalizeSlug } from './slugs.js';
import { DEFAULT_TEASER_THEME, TEASER_THEMES, canonicalTeaserTheme, teaserThemeId } from './themes.js';

export const REDIRECT_MODES = Object.freeze(['instant', 'teaser']);
export const TEASER_STYLES = Object.freeze(['countdown', 'trivia', 'brand']);
export { TEASER_THEMES };
export const TEASER_LIMITS = Object.freeze({ minSeconds: 3, maxSeconds: 15, defaultSeconds: 5 });
export const LIMITS = Object.freeze({ slugMax: SLUG_MAX, titleMax: 120, messageMax: 280, maxClicksMax: 1_000_000, urlMax: URL_MAX });
export const EXPIRES_IN_MIN_SECONDS = 60;
export const EXPIRES_IN_MAX_SECONDS = 157_680_000; // 5 × 365 days
const MAX_EXPIRY_MS = EXPIRES_IN_MAX_SECONDS * 1000;

/** Column defaults for a new link (mirrors the SQL defaults). */
export const LINK_DEFAULTS = Object.freeze({
  title: null,
  redirect_mode: 'instant',
  teaser_seconds: TEASER_LIMITS.defaultSeconds,
  teaser_style: 'countdown',
  teaser_message: null,
  teaser_theme: DEFAULT_TEASER_THEME,
  expires_at: null,
  max_clicks: null,
  qr_style: null,
});

/**
 * SPEC §4.3.
 * @returns {{ status: 'active'|'expired'|'destroyed', expiredReason: null|'time'|'clicks'|'manual' }}
 */
export function linkStatus(link, now) {
  if (link.destroyed_at !== null && link.destroyed_at !== undefined) return { status: 'destroyed', expiredReason: 'manual' };
  if (link.expires_at !== null && link.expires_at !== undefined && now >= link.expires_at) return { status: 'expired', expiredReason: 'time' };
  if (link.max_clicks !== null && link.max_clicks !== undefined && link.click_count >= link.max_clicks) return { status: 'expired', expiredReason: 'clicks' };
  return { status: 'active', expiredReason: null };
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

function parseQrStyleColumn(value) {
  if (!value) return null;
  try {
    return storedQrStyle(JSON.parse(value));
  } catch {
    return null;
  }
}

export function clicksRemaining(link) {
  return link.max_clicks === null || link.max_clicks === undefined ? null : Math.max(0, link.max_clicks - link.click_count);
}

/** Is `domain` one this server offers today (its base host or a configured vanity domain)? */
export const isKnownDomain = (config, domain) => domain === config.baseHost || config.domains.includes(domain);

/**
 * The domain a link is served under today. `links.domain` stores the base host as it was when the
 * link was made (e.g. `localhost:3030`); after a PORT/BASE_URL change, or once a vanity domain is
 * dropped from DOMAINS, that stored value is no longer served here, so the link falls back to the
 * current base host instead of advertising a dead URL. Stored data is never rewritten.
 */
export function effectiveDomain(link, config) {
  return isKnownDomain(config, link.domain) ? link.domain : config.baseHost;
}

/** links row → LinkDTO (SPEC §5.1). */
export function toLinkDto(link, config, now) {
  const domain = effectiveDomain(link, config);
  const domainLive = isDomainLive(config, domain);
  const workingUrl = `${config.baseUrl}/${link.slug}`;
  const shortUrl = domain === config.baseHost ? workingUrl : `https://${domain}/${link.slug}`;
  const { status, expiredReason } = linkStatus(link, now);
  return {
    slug: link.slug,
    domain,
    domainLive,
    shortUrl,
    workingUrl,
    qrUrl: domainLive ? shortUrl : workingUrl,
    targetUrl: link.target_url,
    title: link.title ?? null,
    redirectMode: link.redirect_mode,
    teaser: {
      seconds: link.teaser_seconds,
      style: link.teaser_style,
      message: link.teaser_message ?? null,
      theme: teaserThemeId(link.teaser_theme),
    },
    expiresAt: iso(link.expires_at),
    maxClicks: link.max_clicks ?? null,
    clickCount: link.click_count,
    clicksRemaining: clicksRemaining(link),
    status,
    expiredReason,
    qrStyle: parseQrStyleColumn(link.qr_style),
    createdAt: iso(link.created_at),
    updatedAt: iso(link.updated_at),
  };
}

/** `{ status, expiredReason, clickCount, clicksRemaining }`: the payload of SSE `status` events. */
export function statusPayload(link, now) {
  const { status, expiredReason } = linkStatus(link, now);
  return { status, expiredReason, clickCount: link.click_count, clicksRemaining: clicksRemaining(link) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const WILDCARD_LISTEN_HOSTS = new Set(['', '0.0.0.0', '::']);

/** Every address of this machine's network interfaces (used when listening on all of them). */
function interfaceAddresses() {
  try {
    return Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => String(i.address).replace(/%.*$/, ''));
  } catch {
    return [];
  }
}

/**
 * normalizeTargetUrl options that reject every way of pointing a link back at this server:
 * its base host and vanity domains, plus loopback names and its listen address(es) on its port.
 */
export function targetUrlOptions(config) {
  const listenHost = bareHostname(config.host);
  return {
    ownHosts: [config.baseHost, ...config.domains],
    serverPort: config.port,
    serverHostnames: WILDCARD_LISTEN_HOSTS.has(listenHost) ? interfaceAddresses() : [listenHost],
  };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function cleanText(value, field, max, { multiline = false } = {}) {
  if (value === null) return null;
  if (typeof value !== 'string') throw validationError(field, `${field} must be a string.`);
  let text = value.replace(CONTROL_CHARS, ' ');
  text = multiline ? text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : text.replace(/\s+/g, ' ');
  text = text.trim();
  if (text.length > max) throw validationError(field, `${field} must be ${max} characters or fewer.`);
  return text || null;
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw validationError(field, `${field} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function integerIn(value, lo, hi, field, message) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) {
    throw validationError(field, message || `${field} must be a whole number between ${lo} and ${hi}.`);
  }
  return n;
}

/** ISO string or epoch ms → epoch ms, or throws. */
function parseInstant(value, field) {
  let ms;
  if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && /^\d{10,16}$/.test(value.trim())) ms = Number(value.trim());
  else if (typeof value === 'string' && value.trim()) ms = Date.parse(value.trim());
  else ms = Number.NaN;
  if (!Number.isFinite(ms)) throw validationError(field, `${field} must be an ISO date string or epoch milliseconds.`);
  return Math.round(ms);
}

/**
 * Validate a CreateBody / UpdateBody and return the snake_case columns to write.
 * Slug handling for creation lives in the route (it needs the database).
 * @param {object} body
 * @param {{ mode: 'create'|'update', config: object, now: number, current: object }} ctx
 *        `current` = existing row (update) or LINK_DEFAULTS (create)
 */
export function validateLinkBody(body, { mode, config, now, current }) {
  if (!isPlainObject(body)) throw validationError(null, 'Request body must be a JSON object.');
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
  const out = {};

  if (mode === 'create' || has('targetUrl')) {
    const result = normalizeTargetUrl(body.targetUrl, targetUrlOptions(config));
    if (!result.ok) throw new HttpError(400, result.code, result.message, 'targetUrl');
    out.target_url = result.url;
  }

  if (has('title')) out.title = cleanText(body.title, 'title', LIMITS.titleMax);

  if (has('domain')) {
    const domain = body.domain === null || body.domain === '' ? config.baseHost : String(body.domain).trim().toLowerCase();
    if (!isKnownDomain(config, domain)) {
      // A client echoing back the link's own legacy stored domain (an old base host, or a vanity
      // domain no longer offered) means "keep it as it is": normalise to the current base host.
      if (mode === 'update' && domain === current.domain) {
        out.domain = config.baseHost;
      } else {
        throw validationError('domain', `Unknown domain. Choose one of: ${[config.baseHost, ...config.domains].join(', ')}.`);
      }
    } else {
      out.domain = domain;
    }
  }

  if (has('redirectMode')) out.redirect_mode = oneOf(body.redirectMode, REDIRECT_MODES, 'redirectMode');

  if (has('teaser') && body.teaser !== null) {
    const t = body.teaser;
    if (!isPlainObject(t)) throw validationError('teaser', 'teaser must be an object.');
    if (t.seconds !== undefined) {
      out.teaser_seconds = integerIn(t.seconds, TEASER_LIMITS.minSeconds, TEASER_LIMITS.maxSeconds, 'teaser.seconds',
        `The teaser countdown must be between ${TEASER_LIMITS.minSeconds} and ${TEASER_LIMITS.maxSeconds} seconds.`);
    }
    if (t.style !== undefined) out.teaser_style = oneOf(t.style, TEASER_STYLES, 'teaser.style');
    if (t.message !== undefined) out.teaser_message = cleanText(t.message, 'teaser.message', LIMITS.messageMax, { multiline: true });
    // Theme ids from the first release (aurora, sunset, ...) are still accepted and stored under their new names.
    if (t.theme !== undefined) out.teaser_theme = oneOf(canonicalTeaserTheme(t.theme), TEASER_THEMES, 'teaser.theme');
  }

  const hasExpiresAt = has('expiresAt') && body.expiresAt !== null;
  const hasExpiresIn = has('expiresInSeconds') && body.expiresInSeconds !== null;
  if (hasExpiresAt && hasExpiresIn) {
    throw validationError('expiresAt', 'Send either expiresAt or expiresInSeconds, not both.');
  }
  if (hasExpiresIn) {
    const seconds = integerIn(body.expiresInSeconds, EXPIRES_IN_MIN_SECONDS, EXPIRES_IN_MAX_SECONDS, 'expiresInSeconds',
      'expiresInSeconds must be between 60 seconds and 5 years.');
    out.expires_at = now + seconds * 1000;
  } else if (hasExpiresAt) {
    const at = parseInstant(body.expiresAt, 'expiresAt');
    if (at <= now) throw validationError('expiresAt', 'The self-destruct time must be in the future.');
    if (at > now + MAX_EXPIRY_MS) throw validationError('expiresAt', 'The self-destruct time can be at most 5 years away.');
    out.expires_at = at;
  } else if (has('expiresAt') || has('expiresInSeconds')) {
    out.expires_at = null; // explicit null clears the timer
  }

  if (has('maxClicks')) {
    out.max_clicks = body.maxClicks === null
      ? null
      : integerIn(body.maxClicks, 1, LIMITS.maxClicksMax, 'maxClicks', `maxClicks must be between 1 and ${LIMITS.maxClicksMax.toLocaleString('en-US')}.`);
  }

  if (has('qrStyle')) {
    const style = validateQrStyle(body.qrStyle);
    out.qr_style = style ? JSON.stringify(style) : null;
  }

  if (mode === 'update' && has('slug')) {
    if (normalizeSlug(body.slug) !== current.slug) {
      throw validationError('slug', 'Slugs can’t be changed. Create a new link instead.');
    }
  }

  const merged = { ...current, ...out };
  if (merged.redirect_mode === 'teaser' && merged.teaser_style === 'brand' && !merged.teaser_message) {
    throw validationError('teaser.message', 'Add a brand message to show on the teaser page.');
  }
  return out;
}
