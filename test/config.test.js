import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DEFAULT_STREAM_POLL_MS, PROJECT_ROOT, VERCEL_NO_DATABASE_PROBLEM, VERCEL_STREAM_MAX_MS, fileUrlFromPath, isVercel, loadConfig,
  parseTrustProxy, resolveConfig,
} from '../server/config.js';
import { describeDatabaseUrl, filePathFromUrl } from '../server/db.js';

describe('config', () => {
  it('has sensible defaults', () => {
    const c = loadConfig({});
    assert.equal(c.port, 3030);
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.baseUrl, 'http://localhost:3030');
    assert.equal(c.baseHost, 'localhost:3030');
    assert.deepEqual(c.domains, ['blip.to', 'cat.ly', 'go.to', 'p.wrk']);
    assert.deepEqual(c.liveDomains, []);
    assert.equal(c.dbPath, path.join(PROJECT_ROOT, 'data', 'blip.db'));
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
    assert.equal(loadConfig({ DB_PATH: ':memory:' }).dbPath, ':memory:');
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
    assert.equal(resolveConfig({ dbPath: ':memory:' }).dbPath, ':memory:');
    assert.equal(resolveConfig({ dbPath: ':memory:' }).databaseUrl, ':memory:', 'the database URL follows dbPath');
  });
});

describe('database location', () => {
  const secret = 'eyJhbGciOiJFZERTQSJ9.c2VjcmV0';

  it('defaults to the local file data/blip.db as a file: URL, with no token', () => {
    const c = loadConfig({});
    assert.equal(c.databaseUrl, fileUrlFromPath(path.join(PROJECT_ROOT, 'data', 'blip.db')));
    assert.match(c.databaseUrl, /^file:\/\/\/.*\/data\/blip\.db$/);
    assert.equal(c.databaseAuthToken, null);
    assert.equal(loadConfig({ DB_PATH: ':memory:' }).databaseUrl, ':memory:');
  });

  it('turns Windows and POSIX paths into file: URLs that keep spaces, # and %', () => {
    assert.equal(fileUrlFromPath('C:\\Users\\me\\blip data\\x#1%.db', path.win32), 'file:///C:/Users/me/blip%20data/x%231%25.db');
    assert.equal(fileUrlFromPath('D:\\blip.db', path.win32), 'file:///D:/blip.db');
    assert.equal(fileUrlFromPath('\\\\server\\share\\blip.db', path.win32), 'file:////server/share/blip.db');
    assert.equal(fileUrlFromPath('/var/lib/blip/blip.db', path.posix), 'file:///var/lib/blip/blip.db');
    assert.equal(fileUrlFromPath('/srv/my data/blip.db', path.posix), 'file:///srv/my%20data/blip.db');
  });

  it('resolves a relative DB_PATH against the project root and an absolute one as given', () => {
    const relative = loadConfig({ DB_PATH: 'tmp/other.db' });
    assert.equal(relative.dbPath, path.join(PROJECT_ROOT, 'tmp', 'other.db'));
    assert.equal(relative.databaseUrl, fileUrlFromPath(path.join(PROJECT_ROOT, 'tmp', 'other.db')));
    assert.equal(path.resolve(filePathFromUrl(relative.databaseUrl)), relative.dbPath, 'the URL points back at the same file');

    const absolutePath = path.join(PROJECT_ROOT, '..', 'blip data #2', 'blip.db');
    const absolute = loadConfig({ DB_PATH: absolutePath });
    assert.equal(path.resolve(filePathFromUrl(absolute.databaseUrl)), path.resolve(absolutePath));
    if (process.platform === 'win32') assert.match(absolute.databaseUrl, /^file:\/\/\/[A-Z]:\//, 'the drive letter is kept');
    assert.equal(describeDatabaseUrl(absolute.databaseUrl), path.resolve(absolutePath));
  });

  it('prefers TURSO_DATABASE_URL, then DATABASE_URL, then LIBSQL_URL, each with its own token', () => {
    const all = {
      TURSO_DATABASE_URL: 'libsql://blip-turso.example.io', TURSO_AUTH_TOKEN: secret,
      DATABASE_URL: 'libsql://blip-db.example.io', DATABASE_AUTH_TOKEN: 'db-token',
      LIBSQL_URL: 'https://blip-libsql.example.io', LIBSQL_AUTH_TOKEN: 'libsql-token',
      DB_PATH: './data/ignored.db',
    };
    assert.deepEqual(pick(loadConfig(all)), { databaseUrl: 'libsql://blip-turso.example.io', databaseAuthToken: secret });
    assert.deepEqual(pick(loadConfig({ ...all, TURSO_DATABASE_URL: ' ' })), { databaseUrl: 'libsql://blip-db.example.io', databaseAuthToken: 'db-token' });
    assert.deepEqual(pick(loadConfig({ LIBSQL_URL: all.LIBSQL_URL, LIBSQL_AUTH_TOKEN: 'libsql-token' })), { databaseUrl: all.LIBSQL_URL, databaseAuthToken: 'libsql-token' });
    assert.deepEqual(pick(loadConfig({ TURSO_DATABASE_URL: 'libsql://x.example.io' })), { databaseUrl: 'libsql://x.example.io', databaseAuthToken: null });
    // An explicit URL survives resolveConfig (createApp), and dbPath alone never overrides it.
    assert.deepEqual(pick(resolveConfig(loadConfig(all))), { databaseUrl: 'libsql://blip-turso.example.io', databaseAuthToken: secret });
  });

  it('rejects URLs libSQL cannot open without printing them', () => {
    const postgres = `postgres://user:${secret}@db.example.com/blip`;
    assert.throws(() => loadConfig({ DATABASE_URL: postgres }), (err) => {
      assert.match(err.message, /Invalid DATABASE_URL: "postgres:" URLs are not supported/);
      assert.ok(!err.message.includes(secret), 'the URL (and its password) stays out of the message');
      return true;
    });
    assert.throws(() => loadConfig({ TURSO_DATABASE_URL: 'not a url' }), /Invalid TURSO_DATABASE_URL/);
  });

  it('describes remote databases without credentials or tokens', () => {
    assert.equal(describeDatabaseUrl(`libsql://blip-me.turso.io?authToken=${secret}`), 'libsql://blip-me.turso.io');
    assert.equal(describeDatabaseUrl(`https://user:${secret}@db.example.io/path`), 'https://db.example.io');
    assert.equal(describeDatabaseUrl(':memory:'), 'in memory');
  });
});

const pick = ({ databaseUrl, databaseAuthToken }) => ({ databaseUrl, databaseAuthToken });

describe('config on Vercel', () => {
  const secret = 'eyJhbGciOiJFZERTQSJ9.dmVyY2Vs';
  const VERCEL = {
    VERCEL: '1',
    NODE_ENV: 'production',
    VERCEL_PROJECT_PRODUCTION_URL: 'blip.example.app',
    VERCEL_BRANCH_URL: 'blip-git-feature-team.vercel.app',
    VERCEL_URL: 'blip-abc123-team.vercel.app',
    TURSO_DATABASE_URL: 'libsql://blip-team.turso.io',
    TURSO_AUTH_TOKEN: secret,
  };

  it('stays off without VERCEL, so local runs keep their defaults', () => {
    const c = loadConfig({});
    assert.equal(c.onVercel, false);
    assert.equal(c.streamPollMs, DEFAULT_STREAM_POLL_MS);
    assert.equal(c.streamMaxMs, 0, 'local streams never end on their own');
    assert.equal(c.databaseProblem, null);
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
    assert.equal(loadConfig({ VERCEL: '1', VERCEL_ENV: 'development', VERCEL_URL: 'localhost:3972', TURSO_DATABASE_URL: 'libsql://x.turso.io' }).baseUrl, 'http://localhost:3972');
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
      [resolved.onVercel, resolved.trustProxy, resolved.allowDemoTraffic, resolved.streamMaxMs, resolved.baseUrl],
      [true, 1, true, VERCEL_STREAM_MAX_MS, 'https://blip.example.app'],
    );
  });

  it('uses the Turso variables and never falls back to a file', () => {
    assert.deepEqual(pick(loadConfig(VERCEL)), { databaseUrl: 'libsql://blip-team.turso.io', databaseAuthToken: secret });
    const none = loadConfig({ VERCEL: '1', DB_PATH: './data/blip.db' });
    assert.equal(none.databaseUrl, null, 'DB_PATH is not used on Vercel');
    assert.equal(none.databaseProblem, VERCEL_NO_DATABASE_PROBLEM);
    const resolved = resolveConfig(none);
    assert.equal(resolved.databaseUrl, null, 'resolveConfig keeps "no database"');
    assert.equal(resolved.databaseProblem, VERCEL_NO_DATABASE_PROBLEM);
  });

  it('skips a database URL Blip cannot use instead of crashing, and says which one', () => {
    const postgres = `postgres://user:${secret}@db.example.com/blip`;
    const c = loadConfig({ VERCEL: '1', DATABASE_URL: postgres });
    assert.equal(c.databaseUrl, null);
    assert.match(c.databaseProblem, /Invalid DATABASE_URL: "postgres:" URLs are not supported/);
    assert.ok(c.databaseProblem.endsWith(VERCEL_NO_DATABASE_PROBLEM));
    assert.ok(!c.databaseProblem.includes(secret));
    // A usable URL further down the list still wins.
    assert.equal(loadConfig({ VERCEL: '1', DATABASE_URL: postgres, LIBSQL_URL: 'libsql://ok.turso.io' }).databaseUrl, 'libsql://ok.turso.io');
  });

  it('refuses a local database (file: or :memory:), which a deployed function cannot use', () => {
    for (const [value, what] of [['file:/tmp/blip.db', 'a file: URL'], ['file:./data/blip.db', 'a file: URL'], [':memory:', ':memory:']]) {
      const c = loadConfig({ VERCEL: '1', TURSO_DATABASE_URL: value });
      assert.equal(c.databaseUrl, null, value);
      assert.ok(c.databaseProblem.startsWith(`Invalid TURSO_DATABASE_URL: a local database (${what}) can't be used on Vercel.`), c.databaseProblem);
      assert.ok(c.databaseProblem.endsWith(VERCEL_NO_DATABASE_PROBLEM));
    }
    // Locally the same URL is fine.
    assert.equal(loadConfig({ TURSO_DATABASE_URL: 'file:/tmp/blip.db' }).databaseUrl, 'file:/tmp/blip.db');
  });
});
