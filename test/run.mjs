// `npm test`: starts one in-process MongoDB for the whole run and runs every suite against it through
// `node --test` (each suite in its own process, each app in its own database). Arguments go on to
// `node --test`, for example `npm test -- --test-reporter=spec test/stats.test.js`. A suite started on its
// own with `node --test test/stats.test.js` starts a server of its own instead (test/helpers.js).
// Tests never touch the network or .env: this process runs without --env-file, and any MONGODB_* variable
// set in the shell is removed before the suites start.
//
// A run always ends: every suite's process exits once its tests are done, even if something it opened is
// still alive (--test-force-exit), and a suite file or test still running after TEST_TIMEOUT_MS fails
// (--test-timeout, which an argument given to npm test overrides).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMongoServer } from './mongo-server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Far above the slowest suite file (a few seconds), so only a hang reaches it. */
const TEST_TIMEOUT_MS = 120_000;

const args = process.argv.slice(2);
// Only a file (or a glob of files) names suites. An option's value given as its own argument, such as
// `--test-name-pattern redirect`, does not: without suites, node --test would fall back to its default
// patterns, which also match the helpers and this file.
const namesSuites = args.some((arg) => !arg.startsWith('-') && /\.[cm]?js$/i.test(arg));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('MONGODB_')));

const mongo = await startMongoServer();
const suites = spawn(process.execPath, [
  '--test', '--test-force-exit', `--test-timeout=${TEST_TIMEOUT_MS}`, ...args, ...(namesSuites ? [] : ['test/*.test.js']),
], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...env, BLIP_TEST_MONGODB_URI: mongo.uri },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => suites.kill(signal));
const exitCode = await new Promise((resolve) => {
  suites.on('close', (code) => resolve(code ?? 1));
});
await mongo.stop();
process.exit(exitCode);
