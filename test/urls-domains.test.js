import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHostname, normalizeTargetUrl } from '../server/urls.js';
import { domainIdeas, domainOptions, isDomainLive, normalizeKeyword, vowelless } from '../server/domains.js';
import { resolveConfig } from '../server/config.js';
import { targetUrlOptions } from '../server/links.js';

const own = { ownHosts: ['localhost:3030', 'cat.ly', 'go.to'] };

describe('normalizeTargetUrl', () => {
  it('prefixes https:// when the scheme is missing', () => {
    assert.deepEqual(normalizeTargetUrl('example.com', own), { ok: true, url: 'https://example.com/' });
    assert.deepEqual(normalizeTargetUrl('  example.com/sale?x=1  ', own), { ok: true, url: 'https://example.com/sale?x=1' });
    assert.deepEqual(normalizeTargetUrl('example.com:8080/a', own), { ok: true, url: 'https://example.com:8080/a' });
    assert.deepEqual(normalizeTargetUrl('//cdn.example.org/x', own), { ok: true, url: 'https://cdn.example.org/x' });
    assert.deepEqual(normalizeTargetUrl('http://localhost:5173/dev', own), { ok: true, url: 'http://localhost:5173/dev' });
  });

  it('keeps http and https URLs intact (canonicalised)', () => {
    assert.equal(normalizeTargetUrl('HTTPS://Example.COM/Path?q=1#frag', own).url, 'https://example.com/Path?q=1#frag');
    assert.equal(normalizeTargetUrl('http://example.com', own).url, 'http://example.com/');
  });

  it('rejects dangerous or unsupported schemes', () => {
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>hi</b>', 'ftp://example.com', 'file:///etc/passwd', 'mailto:a@b.com']) {
      const r = normalizeTargetUrl(bad, own);
      assert.equal(r.ok, false, bad);
      assert.equal(r.code, 'unsupported_protocol', bad);
    }
  });

  it('rejects redirect loops to our own hosts', () => {
    for (const loop of ['http://localhost:3030/abc', 'https://cat.ly/x', 'https://CAT.LY:443/x', 'go.to/x']) {
      assert.equal(normalizeTargetUrl(loop, own).code, 'redirect_loop', loop);
    }
    assert.equal(normalizeTargetUrl('https://www.cat.ly/x', own).ok, true);
    assert.equal(normalizeTargetUrl('http://localhost:3031/x', own).ok, true);
  });

  it('rejects other names for this server on its own port (loopback, IP forms, listen address)', () => {
    const self = { ...own, serverPort: 3921, serverHostnames: ['192.168.1.20'] };
    for (const loop of [
      'http://127.0.0.1:3921/loopb', 'http://2130706433:3921/x', 'http://0x7f.1:3921/x', 'http://127.4.5.6:3921/',
      'http://0.0.0.0:3921/', 'http://LOCALHOST.:3921/', 'http://blip.localhost:3921/', 'https://192.168.1.20:3921/x',
    ]) {
      assert.equal(normalizeTargetUrl(loop, self).code, 'redirect_loop', loop);
    }
    // IPv6 literals have no dot in their hostname, so SPEC §4.2 already refuses them outright.
    for (const v6 of ['http://[::1]:3921/', 'http://[::ffff:127.0.0.1]:3921/', 'http://[0:0:0:0:0:0:0:1]:3921/']) {
      assert.equal(normalizeTargetUrl(v6, self).ok, false, v6);
    }
    for (const fine of ['http://127.0.0.1:3922/', 'http://localhost:5173/dev', 'http://192.168.1.20:8080/', 'https://example.com:3921/', 'http://192.168.1.21:3921/']) {
      assert.equal(normalizeTargetUrl(fine, self).ok, true, fine);
    }
    // Default ports count too.
    assert.equal(normalizeTargetUrl('http://localhost/x', { serverPort: 80 }).code, 'redirect_loop');
    assert.equal(normalizeTargetUrl('https://localhost/x', { serverPort: 443 }).code, 'redirect_loop');
    assert.equal(normalizeTargetUrl('https://localhost/x', { serverPort: 80 }).ok, true);
    // Without a server port (or with an ephemeral one) only ownHosts apply.
    assert.equal(normalizeTargetUrl('http://127.0.0.1:3921/x', own).ok, true);
    assert.equal(normalizeTargetUrl('http://127.0.0.1:0/x', { serverPort: 0 }).ok, true);
  });

  it('isLoopbackHostname knows the many spellings of "this machine"', () => {
    for (const h of ['localhost', 'LOCALHOST.', 'app.localhost', '127.0.0.1', '127.255.0.9', '0.0.0.0', '[::1]', '::', '[::ffff:7f00:1]', '::ffff:127.0.0.1', '[::ffff:0:0]']) {
      assert.equal(isLoopbackHostname(h), true, h);
    }
    for (const h of ['example.com', 'localhost.example.com', '128.0.0.1', '10.0.0.1', '[::2]', '[::ffff:a00:1]', '']) {
      assert.equal(isLoopbackHostname(h), false, h);
    }
  });

  it('targetUrlOptions covers the base host, vanity domains and the listen address', () => {
    const specific = targetUrlOptions(resolveConfig({ baseUrl: 'https://blip.example.com', host: '10.1.2.3', port: 8080, domains: ['cat.ly'] }));
    assert.deepEqual(specific, { ownHosts: ['blip.example.com', 'cat.ly'], serverPort: 8080, serverHostnames: ['10.1.2.3'] });
    assert.equal(normalizeTargetUrl('http://10.1.2.3:8080/x', specific).code, 'redirect_loop');
    assert.equal(normalizeTargetUrl('http://127.0.0.1:8080/x', specific).code, 'redirect_loop');
    const wildcard = targetUrlOptions(resolveConfig({ host: '0.0.0.0', port: 3921 }));
    assert.ok(Array.isArray(wildcard.serverHostnames));
    assert.ok(wildcard.serverHostnames.every((h) => typeof h === 'string' && h.length > 0 && !h.includes('%')));
  });

  it('rejects credentials, bare hostnames, empties and very long URLs', () => {
    assert.equal(normalizeTargetUrl('https://user:pass@example.com', own).code, 'invalid_url');
    assert.equal(normalizeTargetUrl('https://user@example.com', own).code, 'invalid_url');
    assert.equal(normalizeTargetUrl('intranet', own).code, 'invalid_url');
    assert.equal(normalizeTargetUrl('', own).code, 'invalid_url');
    assert.equal(normalizeTargetUrl('   ', own).code, 'invalid_url');
    assert.equal(normalizeTargetUrl(null, own).code, 'invalid_url');
    assert.equal(normalizeTargetUrl(42, own).code, 'invalid_url');
    assert.equal(normalizeTargetUrl('http://exa mple.com', own).code, 'invalid_url');
    assert.equal(normalizeTargetUrl(`https://example.com/${'a'.repeat(2050)}`, own).code, 'too_long');
  });
});

describe('domains', () => {
  it('domainOptions lists the base host first and flags live domains', () => {
    const config = resolveConfig({ baseUrl: 'http://localhost:3030', domains: ['cat.ly', 'go.to'], liveDomains: ['go.to'] });
    assert.deepEqual(domainOptions(config), [
      { domain: 'localhost:3030', live: true, isBase: true },
      { domain: 'cat.ly', live: false, isBase: false },
      { domain: 'go.to', live: true, isBase: false },
    ]);
    assert.equal(isDomainLive(config, 'localhost:3030'), true);
    assert.equal(isDomainLive(config, 'go.to'), true);
    assert.equal(isDomainLive(config, 'cat.ly'), false);
  });

  it('finds domain hacks', () => {
    const { ideas } = domainIdeas('delicious');
    const hack = ideas.find((i) => i.domain === 'delicio.us');
    assert.ok(hack, JSON.stringify(ideas));
    assert.equal(hack.kind, 'hack');
    assert.match(hack.note, /TLD finishes the word/);
    assert.ok(domainIdeas('catly').ideas.some((i) => i.domain === 'cat.ly' && i.kind === 'hack'));
    assert.ok(domainIdeas('summit').ideas.some((i) => i.domain === 'summ.it'));
    assert.ok(domainIdeas('drink').ideas.some((i) => i.domain === 'dr.ink'));
    assert.equal(domainIdeas('bitsy').ideas.some((i) => i.kind === 'hack'), false, '.sy is not in the TLD list');
  });

  it('generates short and playful ideas, deduped and capped at 12', () => {
    const { keyword, ideas } = domainIdeas('Summer');
    assert.equal(keyword, 'summer');
    const domains = ideas.map((i) => i.domain);
    for (const d of ['summer.ly', 'smmr.ly', 'gosummer.to', 'summer.link', 'heysummer.co', 'summerhq.io']) assert.ok(domains.includes(d), d);
    assert.ok(ideas.length <= 12);
    assert.equal(new Set(domains).size, domains.length);
    for (const idea of ideas) {
      assert.ok(['hack', 'short', 'playful'].includes(idea.kind));
      assert.ok(idea.note.length > 5);
      assert.match(idea.domain, /^[a-z0-9-]+\.[a-z]+$/);
    }
    assert.ok(domainIdeas('link').ideas.some((i) => i.domain === 'l.link'), 'first-letter flex when keyword is a TLD');
  });

  it('normalises keywords and handles empties', () => {
    assert.equal(normalizeKeyword(' Délicious Café! '), 'delicious-cafe');
    assert.equal(vowelless('summer'), 'smmr');
    assert.deepEqual(domainIdeas('!!!'), { keyword: '', ideas: [] });
    const long = domainIdeas('abcdefghijklmnop');
    assert.ok(long.ideas.every((i) => i.kind !== 'short' || i.domain.split('.')[0].length <= 12));
  });
});
