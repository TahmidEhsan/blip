// Blip: runtime configuration (SPEC §2).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_DOMAINS = 'blip.to,cat.ly,go.to,p.wrk';

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  if (v === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parsePort(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid PORT "${value}": expected an integer between 0 and 65535.`);
  }
  return n;
}

/** `TRUST_PROXY` → value for `app.set('trust proxy', …)`. */
export function parseTrustProxy(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const v = String(value).trim();
  if (v === '' || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/** Validate and canonicalise a base URL (http/https, no trailing slash, no query/hash). */
export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error(`Invalid BASE_URL "${value}": expected something like http://localhost:3030`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid BASE_URL "${value}": only http and https are supported.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid BASE_URL "${value}": it must not contain credentials, a query or a hash.`);
  }
  // WHATWG URL already lowercases the host and drops default ports.
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** Host (with port when non-default) of a base URL, e.g. `localhost:3030`. */
export function hostOfBaseUrl(baseUrl) {
  return new URL(baseUrl).host.toLowerCase();
}

/** Lowercase, trim, dedupe and drop invalid entries and the base host. */
export function normalizeDomainList(value, baseHost = '') {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const d = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!d || !DOMAIN_RE.test(d) || d === baseHost || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

function resolveDbPath(value) {
  const v = value === undefined || value === null || String(value).trim() === '' ? './data/blip.db' : String(value).trim();
  if (v === ':memory:') return v;
  return path.resolve(PROJECT_ROOT, v);
}

/**
 * Read configuration from an env-like object.
 * @param {Record<string, string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ? String(env.NODE_ENV) : 'development';
  const port = parsePort(env.PORT, 3030);
  const host = env.HOST && String(env.HOST).trim() ? String(env.HOST).trim() : '127.0.0.1';
  const baseUrl = normalizeBaseUrl(env.BASE_URL && String(env.BASE_URL).trim() ? env.BASE_URL : `http://localhost:${port}`);
  const baseHost = hostOfBaseUrl(baseUrl);
  const domains = normalizeDomainList(env.DOMAINS === undefined ? DEFAULT_DOMAINS : env.DOMAINS, baseHost);
  const liveDomains = normalizeDomainList(env.LIVE_DOMAINS ?? '', baseHost).filter((d) => domains.includes(d));
  return {
    port,
    host,
    baseUrl,
    baseHost,
    domains,
    liveDomains,
    dbPath: resolveDbPath(env.DB_PATH),
    ipHashSalt: env.IP_HASH_SALT && String(env.IP_HASH_SALT).length ? String(env.IP_HASH_SALT) : null,
    allowDemoTraffic: parseBoolean(env.ALLOW_DEMO_TRAFFIC, nodeEnv !== 'production'),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    nodeEnv,
  };
}

/**
 * Merge a partial config over the defaults and recompute derived fields
 * (baseHost, normalised domain lists) so overrides stay consistent.
 * @param {Partial<ReturnType<typeof loadConfig>>} partial
 */
export function resolveConfig(partial = {}) {
  const defaults = loadConfig({});
  const merged = { ...defaults, ...Object.fromEntries(Object.entries(partial || {}).filter(([, v]) => v !== undefined)) };
  if (partial?.baseUrl === undefined && partial?.port !== undefined) {
    merged.baseUrl = `http://localhost:${partial.port}`;
  }
  merged.port = parsePort(merged.port, 3030);
  merged.baseUrl = normalizeBaseUrl(merged.baseUrl);
  merged.baseHost = hostOfBaseUrl(merged.baseUrl);
  merged.domains = normalizeDomainList(merged.domains, merged.baseHost);
  merged.liveDomains = normalizeDomainList(merged.liveDomains, merged.baseHost).filter((d) => merged.domains.includes(d));
  merged.dbPath = resolveDbPath(merged.dbPath);
  merged.allowDemoTraffic = parseBoolean(merged.allowDemoTraffic, merged.nodeEnv !== 'production');
  merged.trustProxy = parseTrustProxy(merged.trustProxy);
  merged.ipHashSalt = merged.ipHashSalt ? String(merged.ipHashSalt) : null;
  return merged;
}
