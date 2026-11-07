// Blip: server entry point (loadConfig() → createApp() → wait for the database → listen, with graceful shutdown).
import { loadConfig } from './config.js';
import { createApp, describeDatabaseFailure, redactSecrets } from './app.js';
import { databaseFailureHint, describeDatabaseUrl } from './db.js';

const SHUTDOWN_GRACE_MS = 5_000;

let config;
try {
  config = loadConfig();
} catch (err) {
  // The message never quotes a value that could hold credentials; the mask is a second line of defence.
  console.error(`[blip] ${redactSecrets(err.message)}`);
  process.exit(1);
}

if (!config.mongodbUri) {
  console.error(`[blip] ${config.databaseProblem}`);
  process.exit(1);
}

const database = `${describeDatabaseUrl(config.mongodbUri)}, database ${config.mongodbDb}`;
const { app, close, endStreams, ready } = createApp({ config });

try {
  await ready;
} catch (err) {
  // The message names the cluster's hosts and the database, never the credentials, then what to check.
  console.error(`[blip] Could not open the database ${describeDatabaseFailure(err, config)}`);
  if (!databaseFailureHint(err)) console.error("[blip] Check MONGODB_URI (host, user name and password) and the cluster's IP Access List in Atlas (Network Access).");
  await close();
  process.exit(1);
}

const server = app.listen(config.port, config.host, () => {
  const { port } = server.address();
  const listening = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`;
  console.log(`[blip] Tiny links with big personality. Ready at ${config.baseUrl}`);
  if (!config.baseUrl.startsWith(listening)) console.log(`[blip] (listening on ${listening})`);
  console.log(`[blip] database: ${database}${config.allowDemoTraffic ? ' · demo traffic enabled' : ''}`);
  if (config.trustProxy === true) {
    console.warn('[blip] warning: TRUST_PROXY=true trusts client-supplied X-Forwarded-For; use a hop count (e.g. 1) or your proxy\'s address so rate limits can\'t be bypassed');
  }
});

server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[blip] Port ${config.port} is already in use. Set PORT to use another one.`);
  else console.error('[blip] server error:', err);
  await close();
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[blip] ${signal} received, shutting down...`);
  const force = setTimeout(() => {
    console.error('[blip] forced exit after timeout');
    close().finally(() => process.exit(1));
  }, SHUTDOWN_GRACE_MS);
  force.unref();
  server.close(() => {
    close()
      .catch((err) => console.error('[blip] error while closing the database:', err))
      .finally(() => {
        console.log('[blip] Stopped. Bye!');
        process.exit(0);
      });
  });
  endStreams(); // live dashboards hold connections open; end them so close() can finish
  server.closeIdleConnections?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
