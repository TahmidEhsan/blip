// Blip on Vercel: builds the app that /server.js hands to Vercel (one function on Fluid compute).
// Nothing here listens or exits: Vercel calls the exported app for every request its CDN doesn't
// answer from public/. Settings come from the environment (see loadConfig for the Vercel defaults).
//
// Vercel can run several instances of the function at once, and suspends one as soon as no request is
// running on it. So the database is opened by the first request rather than while this module loads,
// each instance keeps a small connection pool whose idle connections are closed before it is suspended
// (attachDatabasePool), and a visit's click row is stored after the response (waitUntil keeps the
// function running until it is written).
import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { describeDatabaseUrl } from './db.js';

export const MISCONFIGURED_TITLE = 'Blip is not set up correctly yet';
export const MISCONFIGURED_MESSAGE = 'Blip is not set up correctly yet. Check its environment variables in Vercel and redeploy.';

/**
 * Driver settings on Vercel, over the ones in server/db.js (whose timeouts stay: 5 s to find a server or
 * connect, 8 s per operation). Every instance has its own pool, and they all count against the cluster's
 * connection limit (500 on Atlas's free tier), so each keeps a small one. attachDatabasePool keeps an
 * instance running for maxIdleTimeMS (plus 100 ms) after each connection checkout, by which time the pool
 * has closed the idle connections, so a short idle time means an instance is kept for about 5 s after its
 * last query, not a minute. The driver's monitoring connections are not pooled and stay open.
 */
export const VERCEL_MONGO_CLIENT_OPTIONS = Object.freeze({ maxPoolSize: 10, maxIdleTimeMS: 5_000 });

/** The parts of @vercel/functions Blip uses (a test passes its own). */
const VERCEL_FUNCTIONS = Object.freeze({ attachDatabasePool, waitUntil });

/**
 * The Blip app for a Vercel function. It never throws: a setting Blip can't use (such as an invalid
 * BASE_URL or MONGODB_URI) is logged and the app answers 503 `misconfigured`, and a missing database is
 * logged and answered with 503 `database_not_configured` (createApp), while the pages are still served.
 * @param {Record<string, string|undefined>} [env]
 * @param {{ attachDatabasePool: (client: import('mongodb').MongoClient) => void, waitUntil: (promise: Promise<unknown>) => void }} [functions]
 * @returns {ReturnType<typeof createApp>}
 */
export function createVercelApp(env = process.env, functions = VERCEL_FUNCTIONS) {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    const reason = /[.!?]$/.test(err.message) ? err.message : `${err.message}.`; // some config messages end on a URL
    return createApp({
      config: { databaseProblem: `${reason} Fix it in the project's environment variables, then redeploy.` },
      unavailable: { code: 'misconfigured', message: MISCONFIGURED_MESSAGE, title: MISCONFIGURED_TITLE },
    });
  }
  if (!config.onVercel) {
    // Vercel sets VERCEL only while its system environment variables are exposed to the deployment.
    // `vercel dev` never sets it, so there this is expected.
    console.warn('[blip] VERCEL is not set, so Blip uses its local defaults (BASE_URL on localhost, the blip_dev database, click rows stored before the response). On a Vercel deployment, switch on "Automatically expose System Environment Variables" in the project settings and redeploy.');
  }
  const blip = createApp({
    config,
    mongoClientOptions: VERCEL_MONGO_CLIENT_OPTIONS,
    // On Vercel only (`vercel dev` behaves like a local run). Called once, right after the client is
    // created; a pool Vercel can't release costs connections, never a request.
    onDatabaseClient: config.onVercel ? (client) => {
      try {
        functions.attachDatabasePool(client);
      } catch (err) {
        console.error(`[blip] could not hand the database pool to Vercel (${err?.message || err}); idle connections stay open while an instance is suspended`);
      }
    } : undefined,
    waitUntil: functions.waitUntil,
    deferClickWrites: config.onVercel,
    connectOnFirstRequest: true,
  });
  if (config.mongodbUri) {
    console.log(`[blip] serving ${config.baseUrl} · database: ${describeDatabaseUrl(config.mongodbUri)}, ${config.mongodbDb} (opened by the first request)${config.allowDemoTraffic ? ' · demo traffic enabled' : ''}`);
  }
  return blip;
}
