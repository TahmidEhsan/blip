// Blip: Express application factory (SPEC §2, §7).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PROJECT_ROOT, resolveConfig } from './config.js';
import {
  QUERY_TIMEOUT_MS, createDatabase, databaseFailureHint, describeDatabaseUrl, ensureIpHashSalt, isDatabaseUnavailable, prepareDatabase, withDeadline,
} from './db.js';
import { HttpError, errorBody } from './errors.js';
import { createBus } from './bus.js';
import { createGeoLookup } from './geo.js';
import { createViewRenderer } from './render.js';
import { cryptoRandom } from './slugs.js';
import { createApiRouter } from './routes/api.js';
import { createRedirectRouter, sendNotFound, setVisitHeaders } from './routes/redirect.js';
import { VENDOR_DIRS, VENDOR_FILES } from './vendor.js';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export const DEFAULT_RATE_LIMITS = Object.freeze({ createLink: 20, simulate: 30, lookup: 120 });
/** Concurrent live streams (SSE) allowed per link and per client (IPv4 address or IPv6 /64). */
export const DEFAULT_STREAM_LIMITS = Object.freeze({ perLink: 10, perClient: 20 });

const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
// A literal path on purpose: it is what makes Vercel's file tracer bundle the page into the function
// (the "includeFiles" setting is ignored for Express projects).
const HOME_PAGE = fileURLToPath(new URL('../public/index.html', import.meta.url));
const NODE_MODULES = path.join(PROJECT_ROOT, 'node_modules');

/** Sent on every response (SPEC §7.1). vercel.json repeats them for the files Vercel's CDN serves itself. */
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

function securityHeaders(req, res, next) {
  res.set(SECURITY_HEADERS);
  next();
}

export const DATABASE_UNAVAILABLE_MESSAGE = 'Blip can’t reach its database right now. Please try again in a moment.';
export const DATABASE_NOT_CONFIGURED_MESSAGE = "Blip is not connected to its database yet. Add MONGODB_URI to this project's environment variables in Vercel and redeploy.";
const NOT_CONFIGURED_TITLE = 'Blip is not connected to its database yet';
/** The 503 page and error for a configured database that could not be opened (it is retried on the next request). */
const UNREACHABLE = Object.freeze({ code: 'unavailable', message: DATABASE_UNAVAILABLE_MESSAGE, title: 'Blip can’t reach its database right now' });
/**
 * Longest a start-up attempt (indexes and salt) may take. Each operation already has its own limits
 * (QUERY_TIMEOUT_MS, SERVER_SELECTION_TIMEOUT_MS); this bounds the whole attempt, so requests waiting for
 * it get a 503 and the next one tries again instead of all of them waiting on one slow start.
 */
export const STARTUP_TIMEOUT_MS = 15_000;

/**
 * The user name and password inside a connection string, as written and decoded: everything before the
 * last '@' (so a password with an unescaped '@' or '/' is found whole), split at its first ':'. Plus the
 * user name as the driver reads it (up to the first ':' or '@'), which its MongoParseError quotes for a
 * user name with a '/' in it.
 */
function uriCredentials(uri) {
  const rest = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/is.exec(String(uri ?? ''))?.[1];
  if (!rest) return [];
  const found = new Set();
  const add = (part) => {
    if (!part) return;
    found.add(part);
    try {
      found.add(decodeURIComponent(part));
    } catch {
      // not percent-encoded
    }
  };
  const userinfo = rest.slice(0, Math.max(0, rest.lastIndexOf('@')));
  if (userinfo) {
    const colon = userinfo.indexOf(':');
    add(userinfo);
    add(colon === -1 ? userinfo : userinfo.slice(0, colon));
    if (colon !== -1) add(userinfo.slice(colon + 1));
    add(/^[^:@]*/.exec(userinfo)[0]);
  }
  return [...found];
}

/** An error message that is safe to log: the connection string and every database credential are masked. */
export function redactSecrets(message, config) {
  let text = String(message ?? '');
  const secrets = [config?.mongodbUri, ...uriCredentials(config?.mongodbUri), config?.mongodbPassword, config?.mongodbUsername]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length); // longest first, so a part never splits a longer secret
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text.replace(/(mongodb(?:\+srv)?:\/\/)[^\s"'/]*@/gi, '$1[redacted]@');
}

/** A log line about a database failure: where (no credentials), the masked message, and what to check. */
export function describeDatabaseFailure(err, config) {
  const hint = databaseFailureHint(err);
  const message = redactSecrets(err?.message || err, config).trim();
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  return `(${describeDatabaseUrl(config?.mongodbUri)}, database ${config?.mongodbDb}): ${sentence}${hint ? ` ${hint}` : ''}`;
}

/**
 * Build the Blip app. Synchronous: the database connects and is prepared in the background, `ready`
 * resolves once that is done, and every request that reaches the API or a short link waits for it
 * (a cold start just waits). If that fails, those requests get a 503 and the next one tries again.
 *
 * Without a database (`config.databaseProblem` set, as when MONGODB_URI is missing) the app still
 * starts and serves its pages. The problem is logged once, `ready` rejects, and everything that needs
 * data answers 503: `/api/*` with JSON `{ error: { code: 'database_not_configured', message } }` and
 * other pages (`/:slug`) with a short HTML page saying the same. `options.unavailable` replaces that
 * code and message (createVercelApp in server/vercel.js uses it when the settings themselves are invalid).
 * @param {{
 *   config?: Partial<ReturnType<typeof import('./config.js').loadConfig>>,
 *   now?: () => number,
 *   random?: () => number,
 *   geoLookup?: (ip: string, headers: object) => Promise<object|null>,
 *   rateLimits?: Partial<typeof DEFAULT_RATE_LIMITS>,
 *   streamLimits?: Partial<typeof DEFAULT_STREAM_LIMITS>,
 *   unavailable?: { code: string, message: string, title?: string },
 *   databaseTimeoutMs?: number,
 *   startupTimeoutMs?: number,
 *   mongoClientOptions?: import('mongodb').MongoClientOptions,
 *   onDatabaseClient?: (client: import('mongodb').MongoClient) => void,
 *   waitUntil?: (promise: Promise<unknown>) => void,
 *   deferClickWrites?: boolean,
 *   connectOnFirstRequest?: boolean,
 * }} [options] `databaseTimeoutMs` and `startupTimeoutMs` override QUERY_TIMEOUT_MS and STARTUP_TIMEOUT_MS
 *   (tests use small values). `mongoClientOptions` are merged over the driver settings in db.js.
 *   `onDatabaseClient` runs right after the one MongoClient is created, and `waitUntil` receives work that
 *   may outlive its response: on Vercel these are attachDatabasePool and waitUntil from @vercel/functions
 *   (server/vercel.js). `deferClickWrites` answers a visit without waiting for its click row, which
 *   `waitUntil` then keeps alive; without it a visit waits for the row (up to CLICK_WRITE_BUDGET_MS), so
 *   stats read right after a visit always include it. `connectOnFirstRequest` leaves the database alone
 *   until a request (or a read of `ready`) needs it, instead of connecting while the module loads: a
 *   serverless instance can be frozen as soon as no request is running, so start-up work is started by one.
 * @returns {{ app: import('express').Express, db: import('./db.js').Database|null, ready: Promise<void>, close: () => Promise<void>, endStreams: () => void, config: object, bus: import('node:events').EventEmitter }}
 */
export function createApp(options = {}) {
  const config = resolveConfig(options.config);
  const unavailable = config.mongodbUri ? null : {
    code: options.unavailable?.code ?? 'database_not_configured',
    message: options.unavailable?.message ?? DATABASE_NOT_CONFIGURED_MESSAGE,
    title: options.unavailable?.title ?? NOT_CONFIGURED_TITLE,
  };
  const db = unavailable ? null : createDatabase({
    uri: config.mongodbUri,
    dbName: config.mongodbDb,
    username: config.mongodbUsername,
    password: config.mongodbPassword,
    timeoutMs: options.databaseTimeoutMs,
    clientOptions: options.mongoClientOptions,
    onClient: options.onDatabaseClient,
  });
  const startupTimeoutMs = Number(options.startupTimeoutMs) > 0 ? Number(options.startupTimeoutMs) : STARTUP_TIMEOUT_MS;
  const queryTimeoutMs = Number(options.databaseTimeoutMs) > 0 ? Number(options.databaseTimeoutMs) : QUERY_TIMEOUT_MS;
  const bus = createBus();
  let closed = false;

  const ctx = {
    db,
    config,
    bus,
    now: options.now ?? Date.now,
    random: options.random ?? cryptoRandom,
    geoLookup: options.geoLookup ?? createGeoLookup({ vercel: config.onVercel }),
    salt: null, // set by initialize(), before any request is served
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...(options.rateLimits || {}) },
    streamLimits: { ...DEFAULT_STREAM_LIMITS, ...(options.streamLimits || {}) },
    renderView: createViewRenderer({ cache: config.nodeEnv === 'production' }),
    streams: new Set(),
    isClosed: () => closed,
    redact: (message) => redactSecrets(message, config),
    waitUntil: options.waitUntil ?? (() => {}),
    deferClickWrites: Boolean(options.deferClickWrites),
    /** What someone is waiting for gets one limit, however long the driver keeps retrying the operation. */
    answerInTime: (operation) => withDeadline(operation, queryTimeoutMs, 'The database took too long to answer.'),
  };

  // ---- database start-up: indexes + salt, shared by every request that arrives meanwhile ----
  let initialized = false;
  let attempt = null;
  const reported = new WeakSet();
  function initialize() {
    if (unavailable) {
      const failed = Promise.reject(Object.assign(new Error(config.databaseProblem || unavailable.message), { code: 'DATABASE_NOT_CONFIGURED' }));
      failed.catch(() => {}); // nobody has to await it
      return failed;
    }
    if (!attempt) {
      const opening = (async () => {
        await prepareDatabase(db);
        ctx.salt = await ensureIpHashSalt(db, config.ipHashSalt);
        initialized = true;
      })();
      const current = withDeadline(opening, startupTimeoutMs, `Opening the database took longer than ${startupTimeoutMs / 1000} s.`);
      opening.catch(() => {}); // its failure is reported through `current`
      attempt = current;
      // A failed attempt is not cached: the next request tries again (a cold database or network blip).
      current.catch(() => {
        if (attempt === current) attempt = null;
      });
    }
    return attempt;
  }
  if (unavailable) console.error(`[blip] ${redactSecrets(config.databaseProblem || unavailable.message, config)}`);
  // On a server, start-up begins now, so a database problem shows before the first visitor. On Vercel
  // (connectOnFirstRequest) the first request starts it, inside that request.
  let ready = options.connectOnFirstRequest && !unavailable ? null : initialize();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  // The home page never needs the database. On Vercel the function owns "/", so the CDN's copy of
  // index.html is never used for it and the function serves it here.
  app.get('/', (req, res, next) => {
    res.sendFile(HOME_PAGE, (err) => {
      if (err && !res.headersSent) next(err.status === 404 || err.code === 'ENOENT' ? undefined : err);
    });
  });

  // Vendor libraries straight from node_modules (no CDN, because the CSP only allows 'self'). They come
  // before the static site so a local run always serves the installed versions. The committed copies in
  // public/vendor are for Vercel, whose CDN serves public/** itself and never sends those requests here.
  const vendorOptions = { maxAge: config.nodeEnv === 'production' ? '7d' : 0 };
  for (const [route, file] of Object.entries(VENDOR_FILES)) {
    const abs = path.join(NODE_MODULES, file);
    app.get(route, (req, res, next) => {
      res.sendFile(abs, vendorOptions, (err) => {
        if (err && !res.headersSent) next(err.status === 404 || err.code === 'ENOENT' ? undefined : err);
      });
    });
  }
  for (const [route, dir] of Object.entries(VENDOR_DIRS)) {
    app.use(route, express.static(path.join(NODE_MODULES, dir), { ...vendorOptions, index: false }));
  }

  // Static site (/dashboard → dashboard.html, hence the reserved slugs).
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: ['index.html'] }));

  // Nothing below runs before the database is ready (static files above never touch it).
  app.use(async (req, res, next) => {
    if (unavailable) {
      await sendUnavailable(req, res);
      return;
    }
    if (initialized) {
      next();
      return;
    }
    const current = initialize();
    ready ??= current;
    try {
      await current;
    } catch (err) {
      if (!reported.has(current) && !closed) {
        reported.add(current);
        console.error(`[blip] could not open the database ${describeDatabaseFailure(err, config)}`);
      }
      res.set('Retry-After', '5');
      // A visitor opening a short link gets the HTML page, everything else the JSON error.
      if (isPageRequest(req)) {
        await sendUnavailable(req, res, UNREACHABLE);
        return;
      }
      throw new HttpError(503, 'unavailable', DATABASE_UNAVAILABLE_MESSAGE);
    }
    next();
  });

  app.use('/api', createApiRouter(ctx));
  app.use('/', createRedirectRouter(ctx));

  // Anything else: friendly HTML 404 for pages, JSON for everything else.
  app.use(async (req, res) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && req.accepts(['html', 'json']) === 'html') {
      const segments = req.path.split('/').filter(Boolean);
      await sendNotFound(ctx, res, segments.length === 1 ? segments[0] : '');
      return;
    }
    res.status(404).json(errorBody('not_found', 'Nothing here.'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use(async (err, req, res, next) => {
    if (res.headersSent) {
      res.destroy?.();
      return;
    }
    if (!(err instanceof HttpError) && isDatabaseUnavailable(err)) {
      // The database stopped answering after start-up (server selection, a network error, a timeout, a
      // failover): the same 503 as during start-up, and the next request simply tries again.
      if (!closed) console.error(`[blip] database request failed ${describeDatabaseFailure(err, config)}`);
      res.set('Retry-After', '5');
      await sendUnavailable(req, res, UNREACHABLE);
      return;
    }
    let status = 500;
    let code = 'internal';
    let message = 'Something went wrong on our side. Please try again.';
    let field;
    if (err instanceof HttpError) {
      ({ status, code, message } = err);
      field = err.field ?? undefined;
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      code = 'invalid_json';
      message = 'The request body must be valid JSON.';
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      code = 'payload_too_large';
      message = 'The request body is too large (max 16 kB).';
    } else if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
      status = err.status;
      code = status === 404 ? 'not_found' : 'bad_request';
      message = err.expose && err.message ? err.message : 'Bad request.';
    } else {
      console.error('[blip] unhandled error:', redactSecrets(err?.stack || err, config));
    }
    res.status(status).set('Cache-Control', 'no-store').json(errorBody(code, message, field));
  });

  /** A page a visitor opens in a browser (such as `/:slug`), as opposed to an API or asset request. */
  function isPageRequest(req) {
    return req.path !== '/api' && !req.path.startsWith('/api/')
      && (req.method === 'GET' || req.method === 'HEAD') && req.accepts(['json', 'html']) === 'html';
  }

  /**
   * 503 without a usable database: JSON for the API and other non-page requests, a short HTML page for pages.
   * `state` is `unavailable` (no database configured, or invalid settings) or UNREACHABLE (configured, but
   * it could not be reached).
   */
  async function sendUnavailable(req, res, state = unavailable) {
    res.status(503).set('Cache-Control', 'no-store');
    if (!isPageRequest(req)) {
      res.json(errorBody(state.code, state.message));
      return;
    }
    setVisitHeaders(res);
    res.type('html').send(await ctx.renderView('unavailable', { TITLE: state.title, MESSAGE: state.message }));
  }

  function endStreams() {
    for (const stream of [...ctx.streams]) stream.end();
  }

  /**
   * End live streams and close the database. Idempotent, safe while `ready` is still
   * pending (start-up then stops with a "closed" error) and safe on a database closed elsewhere.
   * The promise resolves once the database's sockets are closed, so a process can exit.
   */
  function close() {
    if (!closed) {
      closed = true;
      endStreams();
      bus.removeAllListeners();
    }
    return db ? db.close() : Promise.resolve();
  }

  return {
    app,
    db,
    /** Resolves once the database is ready. With connectOnFirstRequest, reading it starts the database. */
    get ready() {
      ready ??= initialize();
      return ready;
    },
    close,
    endStreams,
    config,
    bus,
  };
}
