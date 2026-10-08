import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clientKey, createRateLimiter } from '../server/ratelimit.js';

/** Minimal Express-like req/res pair for driving the middleware directly. */
function call(limiter, ip) {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let passed = false;
  limiter({ ip }, res, () => {
    passed = true;
  });
  return { passed, res };
}

describe('clientKey', () => {
  it('keeps IPv4 addresses and unwraps IPv4-mapped IPv6', () => {
    assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
    assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(clientKey('::FFFF:127.0.0.1'), '127.0.0.1');
  });

  it('groups IPv6 addresses by their /64 prefix', () => {
    const key = '2001:db8:1:2::/64';
    assert.equal(clientKey('2001:db8:1:2::a'), key);
    assert.equal(clientKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff'), key);
    assert.equal(clientKey('[2001:db8:1:2::beef]'), key);
    assert.notEqual(clientKey('2001:db8:1:3::a'), key);
    assert.equal(clientKey('::1'), '0:0:0:0::/64');
    assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(clientKey('64:ff9b::192.0.2.33'), '64:ff9b:0:0::/64');
  });

  it('falls back to "unknown" when there is no address', () => {
    assert.equal(clientKey(''), 'unknown');
    assert.equal(clientKey(undefined), 'unknown');
  });
});

describe('createRateLimiter', () => {
  it('limits per key per window and sends Retry-After', () => {
    const clock = { t: 1_000_000 };
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000, now: () => clock.t });
    assert.equal(call(limiter, '198.51.100.1').passed, true);
    assert.equal(call(limiter, '198.51.100.1').passed, true);
    const blocked = call(limiter, '198.51.100.1');
    assert.equal(blocked.passed, false);
    assert.equal(blocked.res.statusCode, 429);
    assert.equal(blocked.res.body.error.code, 'rate_limited');
    assert.equal(blocked.res.headers['Retry-After'], '60');
    assert.equal(call(limiter, '198.51.100.2').passed, true, 'other clients are unaffected');
    clock.t += 60_000;
    assert.equal(call(limiter, '198.51.100.1').passed, true, 'a new window starts fresh');
  });

  it('never tracks more than maxKeys clients, evicting the oldest windows first', () => {
    const clock = { t: 0 };
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, now: () => clock.t, maxKeys: 3 });
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      call(limiter, ip);
      clock.t += 1;
    }
    assert.equal(call(limiter, '10.0.0.3').passed, false, 'still limited while tracked');
    assert.equal(limiter.size(), 3);
    assert.equal(call(limiter, '10.0.0.4').passed, true);
    assert.equal(limiter.size(), 3, 'the cap holds');
    assert.equal(call(limiter, '10.0.0.2').passed, false, 'newer windows survive');
    assert.equal(call(limiter, '10.0.0.1').passed, true, 'the oldest window was evicted');
  });

  it('sweeps expired windows at most once per window', () => {
    const clock = { t: 0 };
    const limiter = createRateLimiter({ max: 5, windowMs: 1000, now: () => clock.t });
    for (let i = 0; i < 50; i += 1) call(limiter, `10.1.0.${i}`);
    assert.equal(limiter.size(), 50);
    clock.t = 1000;
    call(limiter, '10.2.0.1');
    assert.equal(limiter.size(), 1, 'expired windows are dropped by the sweep');
    clock.t = 1500;
    call(limiter, '10.2.0.2');
    assert.equal(limiter.size(), 2);
  });

  it('validates its options', () => {
    assert.throws(() => createRateLimiter({ max: 0 }), /max must be/);
    assert.throws(() => createRateLimiter({ max: 1, maxKeys: 0 }), /maxKeys must be/);
  });
});
