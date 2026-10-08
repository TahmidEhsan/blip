// Blip: Express application factory (SPEC §2, §7).
import path from 'node:path';
import express from 'express';
import { PROJECT_ROOT, resolveConfig } from './config.js';
import { ensureIpHashSalt, openDatabase } from './db.js';
import { HttpError, errorBody } from './errors.js';
import { createBus } from './bus.js';
import { createLiveTotalsTracker } from './analytics.js';
import { lookupGeo } from './geo.js';
import { createViewRenderer } from './render.js';
import { cryptoRandom } from './slugs.js';
import { createApiRouter } from './routes/api.js';
import { createRedirectRouter, sendNotFound } from './routes/redirect.js';

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
const NODE_MODULES = path.join(PROJECT_ROOT, 'node_modules');

const VENDOR_FILES = {
  '/vendor/qr-code-styling.js': 'qr-code-styling/lib/qr-code-styling.js',
  '/vendor/d3.min.js': 'd3/dist/d3.min.js',
  '/vendor/topojson-client.min.js': 'topojson-client/dist/topojson-client.min.js',
  '/vendor/countries-110m.json': 'world-atlas/countries-110m.json',
};
/** Self-hosted fonts: Bangers for comic lettering, Comic Neue for text (see DESIGN.md §4). */
const VENDOR_DIRS = {
  '/vendor/fonts/bangers': '@fontsource/bangers',
  '/vendor/fonts/comic-neue': '@fontsource/comic-neue',
};

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
}

/**
 * Build the Blip app.
 * @param {{
 *   config?: Partial<ReturnType<typeof import('./config.js').loadConfig>>,
 *   now?: () => number,
 *   random?: () => number,
 *   geoLookup?: (ip: string, headers: object) => Promise<object|null>,
 *   rateLimits?: Partial<typeof DEFAULT_RATE_LIMITS>,
 *   streamLimits?: Partial<typeof DEFAULT_STREAM_LIMITS>,
 * }} [options]
 * @returns {{ app: import('express').Express, db: import('node:sqlite').DatabaseSync, close: () => void, endStreams: () => void, config: object, bus: import('node:events').EventEmitter, liveTotals: ReturnType<typeof createLiveTotalsTracker> }}
 */
export function createApp(options = {}) {
  const config = resolveConfig(options.config);
  const db = openDatabase(config.dbPath);
  const bus = createBus();
  let closed = false;

  const ctx = {
    db,
    config,
    bus,
    now: options.now ?? Date.now,
    random: options.random ?? cryptoRandom,
    geoLookup: options.geoLookup ?? lookupGeo,
    salt: ensureIpHashSalt(db, config.ipHashSalt),
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...(options.rateLimits || {}) },
    streamLimits: { ...DEFAULT_STREAM_LIMITS, ...(options.streamLimits || {}) },
    renderView: createViewRenderer({ cache: config.nodeEnv === 'production' }),
    liveTotals: createLiveTotalsTracker(db),
    timers: new Set(),
    streams: new Set(),
    isClosed: () => closed,
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  // Static site (/dashboard → dashboard.html, hence the reserved slugs).
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: ['index.html'] }));

  // Vendor libraries straight from node_modules (no CDN, because the CSP only allows 'self').
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
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      res.destroy?.();
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
      console.error('[blip] unhandled error:', err);
    }
    res.status(status).set('Cache-Control', 'no-store').json(errorBody(code, message, field));
  });

  function endStreams() {
    for (const stream of [...ctx.streams]) stream.end();
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const timer of ctx.timers) clearTimeout(timer);
    ctx.timers.clear();
    endStreams();
    bus.removeAllListeners();
    if (db.isOpen) db.close();
  }

  return { app, db, close, endStreams, config, bus, liveTotals: ctx.liveTotals };
}
