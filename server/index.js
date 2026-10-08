// Blip: server entry point (loadConfig() → createApp() → listen, with graceful shutdown).
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const SHUTDOWN_GRACE_MS = 5_000;

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[blip] ${err.message}`);
  process.exit(1);
}

const { app, close, endStreams } = createApp({ config });
const server = app.listen(config.port, config.host, () => {
  const { port } = server.address();
  const listening = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`;
  console.log(`[blip] Tiny links with big personality. Ready at ${config.baseUrl}`);
  if (!config.baseUrl.startsWith(listening)) console.log(`[blip] (listening on ${listening})`);
  console.log(`[blip] database: ${config.dbPath}${config.allowDemoTraffic ? ' · demo traffic enabled' : ''}`);
  if (config.trustProxy === true) {
    console.warn('[blip] warning: TRUST_PROXY=true trusts client-supplied X-Forwarded-For; use a hop count (e.g. 1) or your proxy\'s address so rate limits can\'t be bypassed');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[blip] Port ${config.port} is already in use. Set PORT to use another one.`);
  else console.error('[blip] server error:', err);
  try { close(); } catch { /* already closed */ }
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[blip] ${signal} received, shutting down...`);
  const force = setTimeout(() => {
    console.error('[blip] forced exit after timeout');
    try { close(); } catch { /* ignore */ }
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  force.unref();
  server.close(() => {
    try { close(); } catch (err) { console.error('[blip] error while closing the database:', err); }
    console.log('[blip] Stopped. Bye!');
    process.exit(0);
  });
  endStreams(); // live dashboards hold connections open; end them so close() can finish
  server.closeIdleConnections?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
