// `npm start` (server/index.js) on a machine: what it says, and how it exits, without a database, with a
// setting it can't use, with credentials the database refuses, and with a database it can open. The
// server is started without --env-file and with only a few system variables, so .env is never read.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { LOCAL_NO_DATABASE_PROBLEM, PROJECT_ROOT } from '../server/config.js';
import { assertPlainCopy, dropTestDatabase, freshDatabaseName, testMongoUri } from './helpers.js';

const baseEnv = () => Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));

/**
 * Run server/index.js until it exits or prints `until`, then stop it.
 * @returns {Promise<{ code: number|null, output: string }>}
 */
function runServer(env, { until, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.js'], { cwd: PROJECT_ROOT, env: { ...baseEnv(), ...env } });
    let output = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve({ code, output });
    };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server/index.js was still running after ${timeoutMs} ms:\n${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      if (until && output.includes(until)) finish(null);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => finish(code));
  });
}

/** No stack trace, no "at file:line" frames: one clear message is the whole output. */
function assertNoStack(output) {
  assert.doesNotMatch(output, /^\s+at /m, `no stack trace in: ${output}`);
  assert.doesNotMatch(output, /node:internal|Error:/, output);
}

describe('npm start', () => {
  const dbName = freshDatabaseName();
  after(() => dropTestDatabase(dbName));

  it('without MONGODB_URI, says to put it in .env and exits with 1', async () => {
    const { code, output } = await runServer({});
    assert.equal(code, 1);
    assert.equal(output.trim(), `[blip] ${LOCAL_NO_DATABASE_PROBLEM}`);
    assert.match(output, /MONGODB_URI/);
    assert.match(output, /\.env/);
    assertNoStack(output);
    assertPlainCopy(output, 'the start-up message');
  });

  it('with a connection string that is not MongoDB, names the variable and the scheme only', async () => {
    const secret = 'hunter2-not-for-logs';
    const { code, output } = await runServer({ MONGODB_URI: `postgres://blip:${secret}@db.example.com/blip` });
    assert.equal(code, 1);
    assert.match(output.trim(), /^\[blip\] Invalid MONGODB_URI: "postgres:\/\/" connection strings are not supported\./);
    for (const leak of [secret, 'db.example.com', 'blip:']) assert.ok(!output.includes(leak), `${leak} in: ${output}`);
    assertNoStack(output);
  });

  it('with a database name MongoDB would refuse, says so', async () => {
    const { code, output } = await runServer({ MONGODB_URI: 'mongodb://127.0.0.1:9/', MONGODB_DB: 'admin' });
    assert.equal(code, 1);
    assert.match(output, /Invalid MONGODB_DB "admin"/);
    assertNoStack(output);
  });

  it('with the connection string pasted into MONGODB_DB, names the variable and never prints the string', async () => {
    const secret = 'hunter2-not-for-logs';
    const uri = `mongodb+srv://blip-user:${secret}@cluster0.example.mongodb.net/?retryWrites=true`;
    const { code, output } = await runServer({ MONGODB_URI: 'mongodb://127.0.0.1:9/', MONGODB_DB: uri });
    assert.equal(code, 1);
    assert.match(output.trim(), /^\[blip\] Invalid MONGODB_DB: it holds a connection string, which belongs in MONGODB_URI\./);
    for (const leak of [secret, 'blip-user', 'cluster0']) assert.ok(!output.includes(leak), `${leak} in: ${output}`);
    assertNoStack(output);
    assertPlainCopy(output, 'the start-up message');
  });

  it('with credentials the database refuses, says where and what to check, without them', async () => {
    const user = 'blip-nobody';
    const password = 'wrong-password-not-for-logs';
    const uri = (await testMongoUri()).replace('mongodb://', `mongodb://${user}:${password}@`);
    const { code, output } = await runServer({ MONGODB_URI: uri, MONGODB_DB: dbName });
    assert.equal(code, 1);
    assert.match(output, new RegExp(`^\\[blip\\] Could not open the database \\(mongodb://127\\.0\\.0\\.1:\\d+, database ${dbName}\\): Authentication failed\\. The cluster refused the user name or password`, 'm'));
    for (const leak of [user, password]) assert.ok(!output.includes(leak), `${leak} in: ${output}`);
    assertNoStack(output);
  });

  it('with a database it can open, starts and says which one', async () => {
    const { code, output } = await runServer({ MONGODB_URI: await testMongoUri(), MONGODB_DB: dbName, PORT: '0' }, { until: '[blip] database:' });
    assert.equal(code, null, `it keeps running: ${output}`);
    assert.match(output, /Tiny links with big personality\. Ready at http:\/\/localhost:0/);
    assert.match(output, new RegExp(`\\[blip\\] database: mongodb://127\\.0\\.0\\.1:\\d+, database ${dbName}`));
  });
});
