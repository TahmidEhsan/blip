// Blip: runtime configuration (SPEC §2).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_DOMAINS = 'blip.to,cat.ly,go.to,p.wrk';

/** Live dashboards poll the database this often (ms) for new clicks and status changes (STREAM_POLL_MS). */
export const DEFAULT_STREAM_POLL_MS = 2_000;
/** On Vercel a live stream ends cleanly after this long (STREAM_MAX_MS), before the function's 300 s limit cuts it. */
export const VERCEL_STREAM_MAX_MS = 250_000;

/** Why a Vercel deployment has no database (logged once per instance; never contains a URL or token). */
export const VERCEL_NO_DATABASE_PROBLEM = 'No database is configured. Add Turso from the Vercel Marketplace and connect a database to this project (it sets TURSO_DATABASE_URL and TURSO_AUTH_TOKEN; give Preview its own database so previews never change production data), then redeploy.';

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

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

function parsePort(value, fallback) {
  if (isBlank(value)) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid PORT "${value}": expected an integer between 0 and 65535.`);
  }
  return n;
}

/** A whole number of milliseconds between `min` and `max` (blank gives `fallback`). */
function parseMilliseconds(value, fallback, { name, min, max }) {
  if (isBlank(value)) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name} "${value}": expected a whole number of milliseconds between ${min} and ${max}.`);
  }
  return n;
}

const parseStreamPollMs = (value) => parseMilliseconds(value, DEFAULT_STREAM_POLL_MS, { name: 'STREAM_POLL_MS', min: 50, max: 60_000 });
/** 0 means a stream never ends on its own. */
const parseStreamMaxMs = (value, fallback) => parseMilliseconds(value, fallback, { name: 'STREAM_MAX_MS', min: 0, max: 86_400_000 });

/** Vercel sets VERCEL=1 in its builds and functions (`vercel dev` does not, so it gets the local defaults). */
export function isVercel(env) {
  return !isBlank(env?.VERCEL) && !['0', 'false'].includes(String(env.VERCEL).trim().toLowerCase());
}

/**
 * The public URL of a Vercel deployment: the project's production domain in production, the branch URL
 * (or the deployment's own URL) in preview. Null when Vercel didn't say (system variables not exposed).
 */
export function vercelBaseUrl(env) {
  const names = String(env.VERCEL_ENV ?? '').trim() === 'production'
    ? ['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL']
    : ['VERCEL_BRANCH_URL', 'VERCEL_URL'];
  for (const name of names) {
    if (isBlank(env[name])) continue;
    const host = String(env[name]).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (host) return /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) ? `http://${host}` : `https://${host}`;
  }
  return null;
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
 * `file:` URL for a database file, as @libsql/client expects it. Relative paths resolve against the
 * project root (like DB_PATH always has). Windows paths keep their drive letter (`C:\blip\x.db` gives
 * `file:///C:/blip/x.db`); every path segment is percent-encoded, so spaces, `#`, `?` and `%` survive.
 * @param {string} filePath
 * @param {typeof path} [pathApi] path.win32 or path.posix (defaults to this platform's)
 */
export function fileUrlFromPath(filePath, pathApi = path) {
  const absolute = pathApi.resolve(PROJECT_ROOT, String(filePath));
  const segments = absolute.split(pathApi.sep).map((segment, i) => (
    i === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)
  ));
  const urlPath = segments.join('/');
  // POSIX "/var/x.db" → "file:///var/x.db"; Windows "C:/x.db" → "file:///C:/x.db"; UNC "//host/share" → "file:////host/share".
  return urlPath.startsWith('/') ? `file://${urlPath}` : `file:///${urlPath}`;
}

/** DB_PATH (already resolved) → the libSQL URL for it; `:memory:` stays in memory. */
export function databaseUrlFromPath(dbPath) {
  return dbPath === ':memory:' ? ':memory:' : fileUrlFromPath(dbPath);
}

/** Environment variables naming a hosted libSQL database, in priority order, with their token variable. */
export const DATABASE_URL_VARIABLES = Object.freeze([
  ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'],
  ['DATABASE_URL', 'DATABASE_AUTH_TOKEN'],
  ['LIBSQL_URL', 'LIBSQL_AUTH_TOKEN'],
]);

const LIBSQL_SCHEMES = new Set(['libsql', 'https', 'http', 'wss', 'ws', 'file']);

/**
 * Validate a database URL from the environment. Error messages name the variable and the scheme only,
 * never the URL itself (it can carry credentials). With `serverOnly` (on Vercel) a local database
 * (`file:` or `:memory:`) is refused too: the function's files are read-only, every instance would get
 * its own copy, and the native driver a local file needs is not part of the deployed function.
 */
export function checkDatabaseUrl(value, name = 'DATABASE_URL', { serverOnly = false } = {}) {
  const url = String(value).trim();
  const scheme = url === ':memory:' ? 'memory' : /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (serverOnly && (scheme === 'file' || scheme === 'memory')) {
    throw new Error(`Invalid ${name}: a local database (${scheme === 'file' ? 'a file: URL' : ':memory:'}) can't be used on Vercel. Blip needs a hosted libSQL database such as Turso (libsql:// or https://).`);
  }
  if (url === ':memory:') return url;
  if (!scheme) throw new Error(`Invalid ${name}: expected a libsql://, https:// or file: URL.`);
  if (!LIBSQL_SCHEMES.has(scheme)) {
    throw new Error(`Invalid ${name}: "${scheme}:" URLs are not supported. Blip needs a libSQL database such as Turso (libsql://, https:// or file:).`);
  }
  return url;
}

/**
 * Where the data lives: TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN), then DATABASE_URL (+ DATABASE_AUTH_TOKEN),
 * then LIBSQL_URL (+ LIBSQL_AUTH_TOKEN), else the local SQLite file at DB_PATH.
 * On Vercel there is no file to fall back to (the filesystem is read-only and every instance would get
 * its own copy), a `file:` or `:memory:` URL is refused for the same reason, and a URL Blip can't use is
 * skipped rather than fatal: all of these leave `databaseUrl` null and say why in `databaseProblem`, so
 * the app still starts and answers 503 `database_not_configured`.
 * @returns {{ databaseUrl: string|null, databaseAuthToken: string|null, databaseProblem: string|null }}
 */
function resolveDatabase(env, dbPath, onVercel) {
  const problems = [];
  for (const [urlName, tokenName] of DATABASE_URL_VARIABLES) {
    const raw = env[urlName];
    if (isBlank(raw)) continue;
    const token = env[tokenName] && String(env[tokenName]).trim() ? String(env[tokenName]).trim() : null;
    try {
      return { databaseUrl: checkDatabaseUrl(raw, urlName, { serverOnly: onVercel }), databaseAuthToken: token, databaseProblem: null };
    } catch (err) {
      if (!onVercel) throw err;
      problems.push(err.message); // names the variable and scheme only, never the URL
    }
  }
  if (onVercel) {
    return { databaseUrl: null, databaseAuthToken: null, databaseProblem: [...problems, VERCEL_NO_DATABASE_PROBLEM].join(' ') };
  }
  return { databaseUrl: databaseUrlFromPath(dbPath), databaseAuthToken: null, databaseProblem: null };
}

/**
 * Read configuration from an env-like object.
 * On Vercel (VERCEL set) the defaults change: BASE_URL follows the deployment's public URL, TRUST_PROXY
 * is 1 (Vercel's edge is the one proxy in front), demo traffic is on, live streams end after
 * VERCEL_STREAM_MAX_MS, and only a database URL (never DB_PATH) is used. Explicit variables still win.
 * @param {Record<string, string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const onVercel = isVercel(env);
  const nodeEnv = env.NODE_ENV ? String(env.NODE_ENV) : 'development';
  const port = parsePort(env.PORT, 3030);
  const host = env.HOST && String(env.HOST).trim() ? String(env.HOST).trim() : '127.0.0.1';
  const defaultBaseUrl = (onVercel && vercelBaseUrl(env)) || `http://localhost:${port}`;
  const baseUrl = normalizeBaseUrl(env.BASE_URL && String(env.BASE_URL).trim() ? env.BASE_URL : defaultBaseUrl);
  const baseHost = hostOfBaseUrl(baseUrl);
  const domains = normalizeDomainList(env.DOMAINS === undefined ? DEFAULT_DOMAINS : env.DOMAINS, baseHost);
  const liveDomains = normalizeDomainList(env.LIVE_DOMAINS ?? '', baseHost).filter((d) => domains.includes(d));
  const dbPath = resolveDbPath(env.DB_PATH);
  return {
    port,
    host,
    baseUrl,
    baseHost,
    domains,
    liveDomains,
    dbPath,
    ...resolveDatabase(env, dbPath, onVercel),
    ipHashSalt: env.IP_HASH_SALT && String(env.IP_HASH_SALT).length ? String(env.IP_HASH_SALT) : null,
    allowDemoTraffic: parseBoolean(env.ALLOW_DEMO_TRAFFIC, onVercel || nodeEnv !== 'production'),
    trustProxy: isBlank(env.TRUST_PROXY) && onVercel ? 1 : parseTrustProxy(env.TRUST_PROXY),
    streamPollMs: parseStreamPollMs(env.STREAM_POLL_MS),
    streamMaxMs: parseStreamMaxMs(env.STREAM_MAX_MS, onVercel ? VERCEL_STREAM_MAX_MS : 0),
    onVercel,
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
  // A databaseProblem means "no database" (see resolveDatabase). Otherwise an explicit databaseUrl wins,
  // and the URL follows dbPath, so `{ dbPath: ':memory:' }` just works.
  if (partial?.databaseProblem) {
    merged.databaseUrl = null;
    merged.databaseAuthToken = null;
    merged.databaseProblem = String(partial.databaseProblem);
  } else if (partial?.databaseUrl !== undefined && partial.databaseUrl !== null) {
    merged.databaseUrl = checkDatabaseUrl(partial.databaseUrl, 'databaseUrl');
    merged.databaseAuthToken = partial.databaseAuthToken ? String(partial.databaseAuthToken) : null;
    merged.databaseProblem = null;
  } else {
    merged.databaseUrl = databaseUrlFromPath(merged.dbPath);
    merged.databaseAuthToken = null;
    merged.databaseProblem = null;
  }
  merged.onVercel = Boolean(merged.onVercel);
  const given = (key) => partial?.[key] !== undefined && partial[key] !== null;
  merged.allowDemoTraffic = parseBoolean(merged.allowDemoTraffic, merged.onVercel || merged.nodeEnv !== 'production');
  merged.trustProxy = !given('trustProxy') && merged.onVercel ? 1 : parseTrustProxy(merged.trustProxy);
  merged.streamPollMs = parseStreamPollMs(merged.streamPollMs);
  merged.streamMaxMs = parseStreamMaxMs(given('streamMaxMs') ? partial.streamMaxMs : null, merged.onVercel ? VERCEL_STREAM_MAX_MS : 0);
  merged.ipHashSalt = merged.ipHashSalt ? String(merged.ipHashSalt) : null;
  return merged;
}
