// Blip: runtime configuration (SPEC §2).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_DOMAINS = 'blip.to,cat.ly,go.to,p.wrk';

/** Live dashboards poll the database this often (ms) for new clicks and status changes (STREAM_POLL_MS). */
export const DEFAULT_STREAM_POLL_MS = 2_000;
/** On Vercel a live stream ends cleanly after this long (STREAM_MAX_MS), before the function's 300 s limit cuts it. */
export const VERCEL_STREAM_MAX_MS = 250_000;

/** Why a Vercel deployment has no database (logged once per instance; never contains a URL or password). */
export const VERCEL_NO_DATABASE_PROBLEM = "No database is configured. Add MONGODB_URI (the cluster's connection string from MongoDB Atlas) to this project's environment variables in Vercel, then redeploy. Production uses the database blip and Preview blip_preview, so previews never change production data (MONGODB_DB overrides the name).";
/** Why a local run has no database (`npm start` prints it and exits). */
export const LOCAL_NO_DATABASE_PROBLEM = 'No database is configured. Put your MongoDB connection string in a file named .env in the project folder, as a line MONGODB_URI=mongodb+srv://... (or set MONGODB_URI in your shell), then run npm start again. Local runs use the database blip_dev.';

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

/**
 * A setting's value as an error message shows it: quoted, unless it could hold a user name or password
 * (anything with an '@', such as a connection string pasted into the wrong variable). Then the message
 * names only the variable, as checkMongoUri does. URL credentials always end at a literal '@'.
 */
const shown = (value) => (String(value ?? '').includes('@') ? '' : ` "${String(value ?? '').trim()}"`);

function parsePort(value, fallback) {
  if (isBlank(value)) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid PORT${shown(value)}: expected an integer between 0 and 65535.`);
  }
  return n;
}

/** A whole number of milliseconds between `min` and `max` (blank gives `fallback`). */
function parseMilliseconds(value, fallback, { name, min, max }) {
  if (isBlank(value)) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}${shown(value)}: expected a whole number of milliseconds between ${min} and ${max}.`);
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
    throw new Error(`Invalid BASE_URL${shown(value)}: expected something like http://localhost:3030`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid BASE_URL${shown(value)}: only http and https are supported.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid BASE_URL${shown(value)}: it must not contain credentials, a query or a hash.`);
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

const MONGODB_SCHEME_RE = /^mongodb(\+srv)?:\/\//i;

/** True when a connection string carries a user name of its own (`scheme://user[:password]@hosts`). */
export function uriHasCredentials(uri) {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(String(uri ?? ''));
}

/**
 * Validate a connection string: it must start with mongodb+srv:// or mongodb:// (a scheme written in
 * capitals is lowercased, as the driver accepts only lowercase). The error messages name the variable
 * and at most the scheme, never the string itself, which carries credentials. A scheme is only named
 * when `://` follows it, so the user name of a string pasted without its scheme ("user:pass@host") is
 * never mistaken for one.
 */
function checkMongoUri(value, name = 'MONGODB_URI') {
  const uri = String(value).trim();
  if (MONGODB_SCHEME_RE.test(uri)) {
    if (/<db_password>|<password>/i.test(uri)) {
      throw new Error(`Invalid ${name}: it still holds the <db_password> placeholder from Atlas. Put the database user's password there (percent-encoded if it has special characters), or take the user name and password out of ${name} and set MONGODB_USERNAME and MONGODB_PASSWORD.`);
    }
    return uri.replace(MONGODB_SCHEME_RE, (scheme) => scheme.toLowerCase());
  }
  if (/^["']/.test(uri)) throw new Error(`Invalid ${name}: remove the quotes around the connection string.`);
  const scheme = /^([a-z][a-z0-9+.-]{0,30}):\/\//i.exec(uri)?.[1]?.toLowerCase();
  if (scheme) {
    throw new Error(`Invalid ${name}: "${scheme}://" connection strings are not supported. Blip needs a MongoDB connection string, which starts with mongodb+srv:// or mongodb://.`);
  }
  throw new Error(`Invalid ${name}: expected a MongoDB connection string, which starts with mongodb+srv:// or mongodb://.`);
}

/**
 * The database a deployment uses when MONGODB_DB doesn't name one, so data never mixes: Vercel
 * production gets `blip`, Vercel previews `blip_preview`, and everything else (a local run, `vercel dev`,
 * Vercel's development environment) `blip_dev`. Only a deployment Vercel marks as production ever
 * defaults to the production database.
 */
export function defaultDatabaseName(env) {
  if (!isVercel(env)) return 'blip_dev';
  const deployment = String(env.VERCEL_ENV ?? '').trim();
  if (deployment === 'production') return 'blip';
  return deployment === 'preview' ? 'blip_preview' : 'blip_dev';
}

/** MongoDB's own databases: Blip never stores links in them. */
const SYSTEM_DATABASES = new Set(['admin', 'local', 'config']);

/** MONGODB_DB (blank gives `fallback`), by MongoDB's rules for database names. */
function parseDatabaseName(value, fallback) {
  if (isBlank(value)) return fallback;
  const name = String(value).trim();
  if (MONGODB_SCHEME_RE.test(name)) {
    throw new Error('Invalid MONGODB_DB: it holds a connection string, which belongs in MONGODB_URI. MONGODB_DB is only the name of the database, such as blip.');
  }
  if (!/^[^/\\. "$*<>:|?\0]{1,63}$/.test(name)) {
    throw new Error(`Invalid MONGODB_DB${shown(name)}: a database name has 1 to 63 characters, without spaces or any of / \\ . " $ * < > : | ?`);
  }
  if (SYSTEM_DATABASES.has(name.toLowerCase())) {
    throw new Error(`Invalid MONGODB_DB${shown(name)}: admin, local and config are MongoDB's own databases. Pick another name, such as blip.`);
  }
  return name;
}

const trimmedOrNull = (value) => (isBlank(value) ? null : String(value).trim());

/**
 * MONGODB_USERNAME and MONGODB_PASSWORD go together. They only matter for a connection string without
 * credentials of its own (one with them wins), so a half-set pair is an error only then.
 */
function checkCredentialPair(uri, username, password) {
  if (uriHasCredentials(uri) || Boolean(username) === Boolean(password)) return;
  const [set, missing] = username ? ['MONGODB_USERNAME', 'MONGODB_PASSWORD'] : ['MONGODB_PASSWORD', 'MONGODB_USERNAME'];
  throw new Error(`${set} is set but ${missing} is not. Set both, or put the user name and password in MONGODB_URI.`);
}

/**
 * Where the data lives: the cluster at MONGODB_URI, in the database MONGODB_DB. MONGODB_USERNAME and
 * MONGODB_PASSWORD are used when the URI carries no credentials of its own. With no URI, `mongodbUri` is
 * null and `databaseProblem` says what to do, so a deployment still starts and answers 503
 * `database_not_configured` (a local `npm start` prints it and exits). A setting Blip can't use throws,
 * everywhere: createVercelApp turns that into 503 `misconfigured`.
 * @returns {{ mongodbUri: string|null, mongodbDb: string, mongodbUsername: string|null, mongodbPassword: string|null, databaseProblem: string|null }}
 */
function resolveDatabase(env, onVercel) {
  const settings = {
    mongodbUri: null,
    mongodbDb: parseDatabaseName(env.MONGODB_DB, defaultDatabaseName(env)),
    mongodbUsername: trimmedOrNull(env.MONGODB_USERNAME),
    mongodbPassword: trimmedOrNull(env.MONGODB_PASSWORD),
    databaseProblem: onVercel ? VERCEL_NO_DATABASE_PROBLEM : LOCAL_NO_DATABASE_PROBLEM,
  };
  if (isBlank(env.MONGODB_URI)) return settings;
  const mongodbUri = checkMongoUri(env.MONGODB_URI);
  checkCredentialPair(mongodbUri, settings.mongodbUsername, settings.mongodbPassword);
  return { ...settings, mongodbUri, databaseProblem: null };
}

/**
 * Read configuration from an env-like object.
 * On Vercel (VERCEL set) the defaults change: BASE_URL follows the deployment's public URL, TRUST_PROXY
 * is 1 (Vercel's edge is the one proxy in front), demo traffic is on, live streams end after
 * VERCEL_STREAM_MAX_MS, and the default database follows the deployment. Explicit variables still win.
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
  return {
    port,
    host,
    baseUrl,
    baseHost,
    domains,
    liveDomains,
    ...resolveDatabase(env, onVercel),
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
  merged.onVercel = Boolean(merged.onVercel);
  merged.mongodbDb = parseDatabaseName(merged.mongodbDb, defaults.mongodbDb);
  // A databaseProblem means "no database" (see resolveDatabase). Otherwise the URI needs to be there.
  if (partial?.databaseProblem) {
    merged.mongodbUri = null;
    merged.databaseProblem = String(partial.databaseProblem);
  } else if (partial?.mongodbUri !== undefined && partial.mongodbUri !== null) {
    merged.mongodbUri = checkMongoUri(partial.mongodbUri, 'mongodbUri');
    checkCredentialPair(merged.mongodbUri, merged.mongodbUsername, merged.mongodbPassword);
    merged.databaseProblem = null;
  } else {
    merged.mongodbUri = null;
    merged.databaseProblem = merged.onVercel ? VERCEL_NO_DATABASE_PROBLEM : LOCAL_NO_DATABASE_PROBLEM;
  }
  const given = (key) => partial?.[key] !== undefined && partial[key] !== null;
  merged.allowDemoTraffic = parseBoolean(merged.allowDemoTraffic, merged.onVercel || merged.nodeEnv !== 'production');
  merged.trustProxy = !given('trustProxy') && merged.onVercel ? 1 : parseTrustProxy(merged.trustProxy);
  merged.streamPollMs = parseStreamPollMs(merged.streamPollMs);
  merged.streamMaxMs = parseStreamMaxMs(given('streamMaxMs') ? partial.streamMaxMs : null, merged.onVercel ? VERCEL_STREAM_MAX_MS : 0);
  merged.ipHashSalt = merged.ipHashSalt ? String(merged.ipHashSalt) : null;
  return merged;
}
