import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PROJECT_ROOT, loadConfig, parseTrustProxy, resolveConfig } from '../server/config.js';

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
  });
});
