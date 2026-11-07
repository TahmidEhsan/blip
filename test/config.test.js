import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STREAM_POLL_MS, LOCAL_NO_DATABASE_PROBLEM, VERCEL_NO_DATABASE_PROBLEM, VERCEL_STREAM_MAX_MS, defaultDatabaseName, isVercel, loadConfig,
  parseTrustProxy, resolveConfig, uriHasCredentials,
} from '../server/config.js';
import { describeDatabaseFailure, redactSecrets } from '../server/app.js';
import { databaseFailureHint, describeDatabaseUrl } from '../server/db.js';
import { assertPlainCopy } from './helpers.js';

describe('config', () => {
  it('has sensible defaults', () => {
    const c = loadConfig({});
    assert.equal(c.port, 3030);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.baseUrl, 'http://localhost:3030');
    assert.equal(c.baseHost, 'localhost:3030');
    assert.deepEqual(c.domains, ['blip.to', 'cat.ly', 'go.to', 'p.wrk']);
    assert.deepEqual(c.liveDomains, []);
    assert.equal(c.mongodbUri, null);
    assert.equal(c.mongodbDb, 'blip_dev');
    assert.equal(c.ipHashSalt, null);
    assert.equal(c.allowDemoTraffic, true);
    assert.equal(c.trustProxy, false);
    assert.equal(c.nodeEnv, 'development');
  });

  it('derives BASE_URL from PORT and strips trailing slashes', () => {
    assert.equal(loadConfig({ PORT: '4000' }).baseUrl, 'http://localhost:4000');
    const c = loadConfig({ BASE_URL: 'https://Blip.Example.com/' });
    assert.equal(c.baseUrl, 'https://blip.example.com');
    assert.equal(c.baseHost, 'blip.example.com');
    assert.equal(loadConfig({ BASE_URL: 'https://blip.example.com:443' }).baseHost, 'blip.example.com');
  });

  it('normalises domain lists and never duplicates the base host', () => {
    const c = loadConfig({ DOMAINS: ' Cat.LY, go.to,cat.ly,,localhost:3030, bad domain ', LIVE_DOMAINS: 'GO.TO, not-offered.com' });
    assert.deepEqual(c.domains, ['cat.ly', 'go.to']);
    assert.deepEqual(c.liveDomains, ['go.to']);
  });

  it('parses booleans, proxies and production defaults', () => {
    assert.equal(loadConfig({ NODE_ENV: 'production' }).allowDemoTraffic, false);
    assert.equal(loadConfig({ NODE_ENV: 'production', ALLOW_DEMO_TRAFFIC: 'true' }).allowDemoTraffic, true);
    assert.equal(loadConfig({ ALLOW_DEMO_TRAFFIC: 'off' }).allowDemoTraffic, false);
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('2'), 2);
    assert.equal(parseTrustProxy('loopback'), 'loopback');
    assert.equal(loadConfig({ IP_HASH_SALT: 's3cret' }).ipHashSalt, 's3cret');
  });

  it('rejects invalid ports and base URLs', () => {
    assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: '70000' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ BASE_URL: 'ftp://x.com' }), /Invalid BASE_URL/);
    assert.throws(() => loadConfig({ BASE_URL: 'not a url' }), /Invalid BASE_URL/);
  });

  it('resolveConfig recomputes derived fields from overrides', () => {
    const c = resolveConfig({ baseUrl: 'https://go.to/', domains: ['go.to', 'cat.ly'], liveDomains: ['cat.ly', 'zzz.io'] });
    assert.equal(c.baseHost, 'go.to');
    assert.deepEqual(c.domains, ['cat.ly']);
    assert.deepEqual(c.liveDomains, ['cat.ly']);
    assert.equal(resolveConfig({ port: 5555 }).baseUrl, 'http://localhost:5555');
  });
});

describe('database location', () => {
  const secret = 'p4ssw0rd-not-for-logs';
  const URI = `mongodb+srv://blip-user:${secret}@cluster0.example.mongodb.net/?retryWrites=true`;

  it('reads the connection string and the database name', () => {
    const c = loadConfig({ MONGODB_URI: ` ${URI} `, MONGODB_DB: ' my_links ' });
    assert.equal(c.mongodbUri, URI);
    assert.equal(c.mongodbDb, 'my_links');
    assert.equal(c.databaseProblem, null);
    assert.equal(loadConfig({ MONGODB_URI: 'mongodb://127.0.0.1:27017' }).mongodbUri, 'mongodb://127.0.0.1:27017');
  });

  it('has no database and says so without a connection string, pointing at .env', () => {
    for (const env of [{}, { MONGODB_URI: '  ' }, { MONGODB_DB: 'my_links' }]) {
      const c = loadConfig(env);
      assert.equal(c.mongodbUri, null);
      assert.equal(c.databaseProblem, LOCAL_NO_DATABASE_PROBLEM);
    }
    assert.equal(resolveConfig({}).mongodbUri, null);
    assert.equal(resolveConfig({}).databaseProblem, LOCAL_NO_DATABASE_PROBLEM);
    assert.match(LOCAL_NO_DATABASE_PROBLEM, /MONGODB_URI/);
    assert.match(LOCAL_NO_DATABASE_PROBLEM, /\.env/);
    for (const problem of [LOCAL_NO_DATABASE_PROBLEM, VERCEL_NO_DATABASE_PROBLEM]) assertPlainCopy(problem, 'the no-database message');
  });

  it('picks the database by environment, so data never mixes, and MONGODB_DB always wins', () => {
    assert.equal(defaultDatabaseName({}), 'blip_dev');
    assert.equal(defaultDatabaseName({ VERCEL_ENV: 'production' }), 'blip_dev', 'VERCEL_ENV alone is not Vercel');
    assert.equal(defaultDatabaseName({ VERCEL: '1', VERCEL_ENV: 'production' }), 'blip');
    assert.equal(defaultDatabaseName({ VERCEL: '1', VERCEL_ENV: ' production ' }), 'blip');
    assert.equal(defaultDatabaseName({ VERCEL: '1', VERCEL_ENV: 'preview' }), 'blip_preview');
    for (const env of [{ VERCEL: '1' }, { VERCEL: '1', VERCEL_ENV: 'development' }, { VERCEL: '1', VERCEL_ENV: 'Production' }, { VERCEL: '0', VERCEL_ENV: 'production' }]) {
      assert.equal(defaultDatabaseName(env), 'blip_dev', JSON.stringify(env));
    }
    const vercel = { VERCEL: '1', MONGODB_URI: URI };
    assert.equal(loadConfig({ ...vercel, VERCEL_ENV: 'production' }).mongodbDb, 'blip');
    assert.equal(loadConfig({ ...vercel, VERCEL_ENV: 'preview' }).mongodbDb, 'blip_preview');
    assert.equal(loadConfig({ ...vercel, VERCEL_ENV: 'development' }).mongodbDb, 'blip_dev');
    assert.equal(loadConfig({ MONGODB_URI: URI }).mongodbDb, 'blip_dev', 'a local run');
    assert.equal(loadConfig({ ...vercel, VERCEL_ENV: 'production', MONGODB_DB: 'elsewhere' }).mongodbDb, 'elsewhere', 'MONGODB_DB always wins');
    assert.equal(loadConfig({ MONGODB_URI: URI, MONGODB_DB: 'blip_ci_local' }).mongodbDb, 'blip_ci_local');
  });

  it("refuses a database name MongoDB would refuse, and MongoDB's own databases", () => {
    for (const name of ['with space', 'dotted.name', 'a/b', 'x'.repeat(64), 'admin', 'local', 'config', 'Admin']) {
      assert.throws(() => loadConfig({ MONGODB_DB: name }), /Invalid MONGODB_DB/, name);
      assert.throws(() => resolveConfig({ mongodbDb: name }), /Invalid MONGODB_DB/, name);
    }
    assert.throws(() => loadConfig({ MONGODB_DB: 'dotted.name' }), (err) => err.message.startsWith('Invalid MONGODB_DB "dotted.name": '), 'a plain name is quoted');
    assert.equal(loadConfig({ MONGODB_DB: 'x'.repeat(63) }).mongodbDb, 'x'.repeat(63));
  });

  it('never prints a value that could hold credentials, whichever variable it was pasted into', () => {
    for (const [env, name] of [
      [{ MONGODB_DB: URI }, 'MONGODB_DB'],
      [{ MONGODB_URI: URI, MONGODB_DB: URI }, 'MONGODB_DB'],
      [{ MONGODB_DB: 'mongodb://127.0.0.1:27017' }, 'MONGODB_DB'],
      [{ BASE_URL: URI }, 'BASE_URL'],
      [{ BASE_URL: `https://blip-user:${secret}@blip.example.com` }, 'BASE_URL'],
      [{ BASE_URL: `blip-user:${secret}@blip.example.com` }, 'BASE_URL'],
      [{ PORT: URI }, 'PORT'],
      [{ STREAM_POLL_MS: URI }, 'STREAM_POLL_MS'],
      [{ STREAM_MAX_MS: URI }, 'STREAM_MAX_MS'],
      [{ MONGODB_DB: `blip-user:${secret}@cluster0` }, 'MONGODB_DB'],
    ]) {
      for (const load of [() => loadConfig(env), () => loadConfig({ VERCEL: '1', VERCEL_ENV: 'production', ...env })]) {
        assert.throws(load, (err) => {
          assert.ok(err.message.startsWith(`Invalid ${name}: `), err.message);
          for (const leak of [secret, 'blip-user', 'cluster0']) assert.ok(!err.message.includes(leak), `${leak} stays out of: ${err.message}`);
          assertPlainCopy(err.message, 'a configuration error');
          return true;
        });
      }
    }
    const pasted = (err) => /^Invalid MONGODB_DB: it holds a connection string, which belongs in MONGODB_URI\. MONGODB_DB is only the name of the database, such as blip\.$/.test(err.message);
    assert.throws(() => loadConfig({ MONGODB_DB: URI }), pasted);
    assert.throws(() => resolveConfig({ mongodbDb: URI }), pasted);
    assert.throws(() => loadConfig({ BASE_URL: 'ftp://blip.example.com' }), (err) => err.message.startsWith('Invalid BASE_URL "ftp://blip.example.com": '), 'a value without credentials is still quoted');
    assert.throws(() => loadConfig({ PORT: 'abc' }), (err) => err.message.startsWith('Invalid PORT "abc": '));
  });

  it('keeps separate credentials for a connection string without its own', () => {
    const c = loadConfig({ MONGODB_URI: 'mongodb+srv://cluster0.example.mongodb.net', MONGODB_USERNAME: 'blip-user', MONGODB_PASSWORD: secret });
    assert.equal(c.mongodbUsername, 'blip-user');
    assert.equal(c.mongodbPassword, secret);
    const resolved = resolveConfig(c);
    assert.equal(resolved.mongodbUsername, 'blip-user');
    assert.equal(resolved.mongodbPassword, secret);
    assert.equal(uriHasCredentials(URI), true);
    assert.equal(uriHasCredentials('mongodb+srv://cluster0.example.mongodb.net/?appName=blip'), false);
  });

  it('wants both separate credentials, unless the connection string has its own', () => {
    const bare = 'mongodb+srv://cluster0.example.mongodb.net';
    for (const [env, message] of [
      [{ MONGODB_URI: bare, MONGODB_USERNAME: 'blip-user' }, /MONGODB_USERNAME is set but MONGODB_PASSWORD is not/],
      [{ MONGODB_URI: bare, MONGODB_PASSWORD: secret }, /MONGODB_PASSWORD is set but MONGODB_USERNAME is not/],
    ]) {
      assert.throws(() => loadConfig(env), (err) => message.test(err.message) && !err.message.includes(secret));
    }
    assert.doesNotThrow(() => loadConfig({ MONGODB_URI: URI, MONGODB_USERNAME: 'ignored' }), 'the connection string has credentials, so the variables do not matter');
    assert.throws(() => resolveConfig({ mongodbUri: bare, mongodbPassword: secret }), /MONGODB_PASSWORD is set but MONGODB_USERNAME is not/);
  });

  it('rejects anything but a MongoDB connection string, naming at most its scheme', () => {
    const cases = [
      [`postgres://user:${secret}@db.example.com/blip`, /^Invalid MONGODB_URI: "postgres:\/\/" connection strings are not supported\. Blip needs a MongoDB connection string, which starts with mongodb\+srv:\/\/ or mongodb:\/\/\.$/],
      [`libsql://blip-${secret}.turso.io`, /^Invalid MONGODB_URI: "libsql:\/\/" connection strings are not supported/],
      ['file:///tmp/blip.db', /"file:\/\/" connection strings are not supported/],
      ['not a url', /^Invalid MONGODB_URI: expected a MongoDB connection string, which starts with mongodb\+srv:\/\/ or mongodb:\/\/\.$/],
      // Pasted without its scheme: the user name before the colon is not a scheme, and is never printed.
      [`blip-user:${secret}@cluster0.example.mongodb.net/?retryWrites=true`, /^Invalid MONGODB_URI: expected a MongoDB connection string/],
      [`mongodb:/blip-user:${secret}@cluster0.example.mongodb.net`, /^Invalid MONGODB_URI: expected a MongoDB connection string/],
      [`"${URI}"`, /^Invalid MONGODB_URI: remove the quotes around the connection string\.$/],
      [`mongodb+srv://blip-user:<db_password>@cluster0.example.mongodb.net/?appName=Cluster0`, /still holds the <db_password> placeholder from Atlas/],
    ];
    for (const [value, expected] of cases) {
      assert.throws(() => loadConfig({ MONGODB_URI: value }), (err) => {
        assert.match(err.message, expected, value);
        for (const leak of [secret, 'blip-user', 'cluster0', 'turso.io', 'tmp/blip']) assert.ok(!err.message.includes(leak), `${leak} stays out of: ${err.message}`);
        assertPlainCopy(err.message, 'a configuration error');
        return true;
      });
      assert.throws(() => loadConfig({ VERCEL: '1', MONGODB_URI: value }), (err) => expected.test(err.message), 'the same on Vercel');
    }
    assert.throws(() => resolveConfig({ mongodbUri: 'file:/tmp/blip.db' }), (err) => err.message.startsWith('Invalid mongodbUri: '));
  });

  it('accepts both schemes, and lowercases one written in capitals', () => {
    assert.equal(loadConfig({ MONGODB_URI: 'MongoDB+SRV://cluster0.example.mongodb.net/?appName=Blip' }).mongodbUri, 'mongodb+srv://cluster0.example.mongodb.net/?appName=Blip');
    assert.equal(loadConfig({ MONGODB_URI: 'MONGODB://127.0.0.1:27017/' }).mongodbUri, 'mongodb://127.0.0.1:27017/');
    assert.equal(loadConfig({ MONGODB_URI: `mongodb+srv://Blip-User:${secret}@cluster0.example.mongodb.net` }).mongodbUri, `mongodb+srv://Blip-User:${secret}@cluster0.example.mongodb.net`, 'only the scheme changes');
  });

  it('describes a connection string without credentials or options', () => {
    assert.equal(describeDatabaseUrl(URI), 'mongodb+srv://cluster0.example.mongodb.net');
    assert.equal(describeDatabaseUrl(`mongodb://u:${secret}@a.example.net:27017,b.example.net:27018/blip?replicaSet=rs0&tls=true`), 'mongodb://a.example.net:27017,b.example.net:27018');
    assert.equal(describeDatabaseUrl('mongodb://127.0.0.1:27017'), 'mongodb://127.0.0.1:27017');
    assert.equal(describeDatabaseUrl(`mongodb://user:pa@ss/word${secret}@host.example.net/x`), 'mongodb://host.example.net', 'even with an unencoded @ or / in the password');
    assert.equal(describeDatabaseUrl(null), '(none)');
    assert.equal(describeDatabaseUrl('whatever'), 'a remote database');
  });

  it('masks the connection string and every credential in a log line', () => {
    const encoded = 'p%40ss%2Fword';
    const config = resolveConfig({ mongodbUri: `mongodb+srv://blip-user:${encoded}@cluster0.example.mongodb.net`, mongodbUsername: 'other-user', mongodbPassword: 'other-password' });
    const line = redactSecrets(
      `failed: ${config.mongodbUri} and mongodb://x:y@z.example.net/db for blip-user, ${encoded}, p@ss/word, other-user, other-password`,
      config,
    );
    for (const leak of [encoded, 'p@ss/word', 'blip-user', 'other-user', 'other-password', 'x:y@']) assert.ok(!line.includes(leak), `${leak} in: ${line}`);
    assert.ok(line.includes('z.example.net'), line);
    assert.equal(redactSecrets('nothing to hide', config), 'nothing to hide');
    assert.equal(redactSecrets('nothing to hide', null), 'nothing to hide');
  });

  it("masks credentials the driver quotes from a string it can't parse", () => {
    // The driver's MongoParseError says "Username contains unescaped characters <user>" for a user name
    // with a '/', which no simple user:password pattern finds.
    const config = resolveConfig({ mongodbUri: 'mongodb://team/blip:pass/word@cluster0.example.mongodb.net/' });
    const line = redactSecrets('Username contains unescaped characters team/blip, then pass/word', config);
    assert.ok(!line.includes('team/blip') && !line.includes('pass/word'), line);
    const unencodedAt = resolveConfig({ mongodbUri: 'mongodb+srv://blip-user:p@ss@cluster0.example.mongodb.net/' });
    const atLine = redactSecrets('auth for blip-user with p@ss failed', unencodedAt);
    assert.ok(!atLine.includes('blip-user') && !atLine.includes('p@ss'), atLine);
  });

  it('describes a database failure with where it happened and what to check, never a credential', () => {
    const config = resolveConfig({ mongodbUri: `mongodb+srv://blip-user:${secret}@cluster0.example.mongodb.net/?appName=Blip`, mongodbDb: 'blip' });
    const authFailed = Object.assign(new Error(`bad auth : authentication failed for blip-user (${config.mongodbUri})`), { name: 'MongoServerError', code: 8000 });
    const line = describeDatabaseFailure(authFailed, config);
    assert.match(line, /^\(mongodb\+srv:\/\/cluster0\.example\.mongodb\.net, database blip\): bad auth : authentication failed for \[redacted\]/);
    assert.match(line, /The cluster refused the user name or password/);
    assert.ok(!line.includes(secret) && !line.includes('blip-user'), line);
    assertPlainCopy(line, 'a database failure log line');
  });

  it('says what to check for the failures people hit while setting up', () => {
    const named = (name, message, extra = {}) => Object.assign(new Error(message), { name, ...extra });
    const hints = [
      [named('MongoServerError', 'Authentication failed.', { code: 18 }), /refused the user name or password/],
      [named('MongoServerError', 'bad auth : authentication failed', { code: 8000 }), /refused the user name or password/],
      [named('MongoServerError', 'user is not allowed to do action [createIndexes] on [blip.links]', { code: 8000 }), /readWrite role/],
      [named('MongoServerError', 'not authorized on blip to execute command', { code: 13 }), /readWrite role/],
      [Object.assign(new Error('querySrv ENOTFOUND _mongodb._tcp.cluster0.nope.mongodb.net'), { code: 'ENOTFOUND' }), /host name was not found/],
      [named('MongoServerSelectionError', 'Server selection timed out after 5000 ms'), /IP Access List .* 0\.0\.0\.0\/0/],
      [named('MongoServerSelectionError', 'connect ECONNREFUSED 127.0.0.1:9', { cause: named('MongoNetworkError', 'connect ECONNREFUSED') }), /IP Access List/],
      [named('TimeoutError', 'Opening the database took longer than 15 s.'), /No server answered in time/],
      [named('MongoParseError', 'Password contains unescaped characters'), /percent-encode special characters/],
      [new Error('wrapped', { cause: named('MongoServerError', 'bad auth : authentication failed', { code: 8000 }) }), /refused the user name or password/],
    ];
    for (const [err, expected] of hints) {
      const hint = databaseFailureHint(err);
      assert.match(hint ?? '', expected, err.message);
      assertPlainCopy(hint, 'a database hint');
    }
    for (const err of [new Error('boom'), named('MongoServerError', 'E11000 duplicate key error', { code: 11000 }), null, undefined]) {
      assert.equal(databaseFailureHint(err), null, String(err?.message ?? err));
    }
  });
});

describe('config on Vercel', () => {
  const secret = 'p4ssw0rd-not-for-logs';
  const VERCEL = {
    VERCEL: '1',
    NODE_ENV: 'production',
    VERCEL_PROJECT_PRODUCTION_URL: 'blip.example.app',
    VERCEL_BRANCH_URL: 'blip-git-feature-team.vercel.app',
    VERCEL_URL: 'blip-abc123-team.vercel.app',
    MONGODB_URI: `mongodb+srv://blip-user:${secret}@cluster0.example.mongodb.net`,
  };

  it('stays off without VERCEL, so local runs keep their defaults', () => {
    const c = loadConfig({});
    assert.equal(c.onVercel, false);
    assert.equal(c.streamPollMs, DEFAULT_STREAM_POLL_MS);
    assert.equal(c.streamMaxMs, 0, 'local streams never end on their own');
    assert.equal(isVercel({ VERCEL: '0' }), false);
    assert.equal(isVercel({ VERCEL: '1' }), true);
  });

  it('uses the production domain in production and the branch URL in preview', () => {
    const production = loadConfig({ ...VERCEL, VERCEL_ENV: 'production' });
    assert.equal(production.baseUrl, 'https://blip.example.app');
    assert.equal(production.baseHost, 'blip.example.app');
    assert.equal(loadConfig({ ...VERCEL, VERCEL_ENV: 'preview' }).baseUrl, 'https://blip-git-feature-team.vercel.app');
    assert.equal(loadConfig({ ...VERCEL, VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: '' }).baseUrl, 'https://blip-abc123-team.vercel.app');
    assert.equal(loadConfig({ ...VERCEL, VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: '' }).baseUrl, 'https://blip-abc123-team.vercel.app');
    assert.equal(loadConfig({ VERCEL: '1', VERCEL_ENV: 'development', VERCEL_URL: 'localhost:3972', MONGODB_URI: VERCEL.MONGODB_URI }).baseUrl, 'http://localhost:3972');
    assert.equal(loadConfig({ ...VERCEL, VERCEL_ENV: 'production', BASE_URL: 'https://go.example.com/' }).baseUrl, 'https://go.example.com', 'BASE_URL still wins');
  });

  it('trusts one proxy, allows demo traffic and ends streams before the function limit, unless told otherwise', () => {
    const c = loadConfig({ ...VERCEL, VERCEL_ENV: 'production' });
    assert.equal(c.onVercel, true);
    assert.equal(c.trustProxy, 1);
    assert.equal(c.allowDemoTraffic, true, 'even with NODE_ENV=production');
    assert.equal(c.streamMaxMs, VERCEL_STREAM_MAX_MS);
    assert.ok(VERCEL_STREAM_MAX_MS < 300_000, 'ends before the default 300 s maximum duration');
    const custom = loadConfig({ ...VERCEL, TRUST_PROXY: 'false', ALLOW_DEMO_TRAFFIC: 'false', STREAM_MAX_MS: '60000', STREAM_POLL_MS: '5000' });
    assert.equal(custom.trustProxy, false);
    assert.equal(custom.allowDemoTraffic, false);
    assert.equal(custom.streamMaxMs, 60_000);
    assert.equal(custom.streamPollMs, 5_000);
    assert.throws(() => loadConfig({ STREAM_POLL_MS: '10' }), /Invalid STREAM_POLL_MS/);
    assert.throws(() => loadConfig({ STREAM_MAX_MS: '-1' }), /Invalid STREAM_MAX_MS/);
    // resolveConfig keeps all of it (createApp runs every config through it).
    const resolved = resolveConfig(c);
    assert.deepEqual(
      [resolved.onVercel, resolved.trustProxy, resolved.allowDemoTraffic, resolved.streamMaxMs, resolved.baseUrl, resolved.mongodbDb],
      [true, 1, true, VERCEL_STREAM_MAX_MS, 'https://blip.example.app', 'blip'],
    );
  });

  it('uses MONGODB_URI, in a database that follows the deployment', () => {
    const production = loadConfig({ ...VERCEL, VERCEL_ENV: 'production' });
    assert.equal(production.mongodbUri, VERCEL.MONGODB_URI);
    assert.equal(production.mongodbDb, 'blip');
    assert.equal(loadConfig({ ...VERCEL, VERCEL_ENV: 'preview' }).mongodbDb, 'blip_preview');
    assert.equal(loadConfig({ ...VERCEL, VERCEL_ENV: 'development' }).mongodbDb, 'blip_dev');
    const none = loadConfig({ VERCEL: '1' });
    assert.equal(none.mongodbUri, null);
    assert.equal(none.databaseProblem, VERCEL_NO_DATABASE_PROBLEM);
    const resolved = resolveConfig(none);
    assert.equal(resolved.mongodbUri, null, 'resolveConfig keeps "no database"');
    assert.equal(resolved.databaseProblem, VERCEL_NO_DATABASE_PROBLEM);
  });

  it('treats a connection string Blip cannot use as a setting to fix, as it does locally', () => {
    // createVercelApp turns this error into 503 `misconfigured` (test/vercel.test.js).
    for (const [value, scheme] of [[`postgres://user:${secret}@db.example.com/blip`, 'postgres'], ['file:///tmp/blip.db', 'file'], [`libsql://blip-${secret}.turso.io`, 'libsql']]) {
      assert.throws(() => loadConfig({ VERCEL: '1', VERCEL_ENV: 'production', MONGODB_URI: value }), (err) => {
        assert.ok(err.message.startsWith(`Invalid MONGODB_URI: "${scheme}://" connection strings are not supported.`), err.message);
        assert.ok(!err.message.includes(secret));
        return true;
      });
    }
  });
});
