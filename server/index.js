// Blip: server entry point (loadConfig() → createApp() → wait for the database → listen, with graceful shutdown).
import { loadConfig } from './config.js';
import { createApp, redactSecrets } from './app.js';
import { describeDatabaseUrl } from './db.js';

const SHUTDOWN_GRACE_MS = 5_000;

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[blip] ${err.message}`);
  process.exit(1);
}

if (!config.databaseUrl) {
  // Only on Vercel settings (VERCEL set) without a database URL; a local run always has DB_PATH.
  console.error(`[blip] ${config.databaseProblem}`);
  process.exit(1);
}

const database = describeDatabaseUrl(config.databaseUrl);
const { app, close, endStreams, ready } = createApp({ config });

try {
  await ready;
} catch (err) {
  console.error(`[blip] Could not open the database (${database}): ${redactSecrets(err?.message || err, config)}`);
  if (config.databaseUrl.startsWith('file:')) {
    console.error('[blip] Check that DB_PATH points at a folder Blip can write to, or set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to use a hosted database.');
  } else {
    console.error('[blip] Check the database URL and its auth token (TURSO_DATABASE_URL and TURSO_AUTH_TOKEN).');
  }
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
