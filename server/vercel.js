// Blip on Vercel: builds the app that /server.js hands to Vercel (one function on Fluid compute).
// Nothing here listens or exits: Vercel calls the exported app for every request its CDN doesn't
// answer from public/. Settings come from the environment (see loadConfig for the Vercel defaults).
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { describeDatabaseUrl } from './db.js';

export const MISCONFIGURED_TITLE = 'Blip is not set up correctly yet';
export const MISCONFIGURED_MESSAGE = 'Blip is not set up correctly yet. Check its environment variables in Vercel and redeploy.';

/**
 * The Blip app for a Vercel function. It never throws: a setting Blip can't use (such as an invalid
 * BASE_URL) is logged and the app answers 503 `misconfigured`, and a missing database is logged and
 * answered with 503 `database_not_configured` (createApp), while the pages are still served.
 * @param {Record<string, string|undefined>} [env]
 * @returns {ReturnType<typeof createApp>}
 */
export function createVercelApp(env = process.env) {
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
    console.warn('[blip] VERCEL is not set, so Blip uses its local defaults (a database file, BASE_URL on localhost). On a Vercel deployment, switch on "Automatically expose System Environment Variables" in the project settings and redeploy.');
  }
  const blip = createApp({ config });
  if (config.databaseUrl) {
    console.log(`[blip] ready at ${config.baseUrl} · database: ${describeDatabaseUrl(config.databaseUrl)}${config.allowDemoTraffic ? ' · demo traffic enabled' : ''}`);
  }
  return blip;
}
