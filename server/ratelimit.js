// Blip: in-memory fixed-window rate limiter (SPEC §5).
// Keys are client IPs held only in memory for the length of one window; nothing is persisted.
import net from 'node:net';
import { errorBody } from './errors.js';
import { cleanIp } from './geo.js';

/** Upper bound on tracked clients per limiter; beyond it the oldest windows are evicted first. */
export const RATE_LIMIT_MAX_KEYS = 50_000;

/** The 8 16-bit groups of a valid IPv6 address (handles `::` and a trailing dotted IPv4 part). */
function ipv6Groups(ip) {
  let v = ip.toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    v = `${v.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = v.split('::');
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const fill = rest === undefined ? [] : new Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

/**
 * Rate-limit bucket for a client address. IPv4 (including IPv4-mapped IPv6) addresses are used
 * as-is; IPv6 addresses are reduced to their /64 prefix, because a single client typically controls
 * a whole /64 and could otherwise rotate through fresh addresses to dodge the limit.
 */
export function clientKey(rawIp) {
  const ip = cleanIp(rawIp);
  if (net.isIPv6(ip)) {
    const groups = ipv6Groups(ip);
    if (groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)) {
      return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
    }
  }
  return ip || 'unknown';
}

/**
 * @param {{ max: number, windowMs?: number, now?: () => number, keyFn?: (req) => string, message?: string, maxKeys?: number }} opts
 * @returns {import('express').RequestHandler & { reset(): void, size(): number }}
 */
export function createRateLimiter({
  max, windowMs = 60_000, now = Date.now, keyFn = (req) => clientKey(req.ip), message, maxKeys = RATE_LIMIT_MAX_KEYS,
} = {}) {
  if (!Number.isFinite(max) || max < 1) throw new Error('createRateLimiter: max must be >= 1');
  if (!Number.isFinite(maxKeys) || maxKeys < 1) throw new Error('createRateLimiter: maxKeys must be >= 1');
  // Insertion order == window start order (entries are re-inserted when their window restarts),
  // so the first keys are always the oldest windows.
  const hits = new Map();
  let lastSweep = 0;

  /** Drop expired windows, at most once per window however many keys there are. */
  const sweep = (t) => {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
  };

  const middleware = (req, res, next) => {
    const t = now();
    sweep(t);
    const key = keyFn(req);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      hits.delete(key);
      // Cap memory when a flood of distinct clients arrives within one window.
      for (const oldest of hits.keys()) {
        if (hits.size < maxKeys) break;
        hits.delete(oldest);
      }
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset', String(resetSeconds));
    if (entry.count > max) {
      res.set('Retry-After', String(resetSeconds));
      res.status(429).json(errorBody('rate_limited', message || `Whoa, slow down! Try again in ${resetSeconds}s.`));
      return;
    }
    next();
  };
  middleware.reset = () => hits.clear();
  middleware.size = () => hits.size;
  return middleware;
}
