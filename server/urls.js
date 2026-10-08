// Blip: destination URL validation (SPEC §4.2).
import net from 'node:net';

export const URL_MAX = 2048;

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):(.*)$/is;
// "example.com:8080/path" looks like a scheme to SCHEME_RE but is really host:port.
const PORT_AFTER_COLON_RE = /^\d{1,5}(?:[/?#]|$)/;

const fail = (code, message) => ({ ok: false, code, message });

/** Hostname without IPv6 brackets or a trailing dot, lowercased. */
export function bareHostname(hostname) {
  return String(hostname ?? '').toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

/**
 * True for names that always mean "this machine" to the client that opens them: `localhost`,
 * `*.localhost`, 127.0.0.0/8, ::1, the unspecified addresses and their IPv4-mapped IPv6 forms.
 * (WHATWG URL parsing has already canonicalised integer/hex IPv4 forms like `2130706433`.)
 */
export function isLoopbackHostname(hostname) {
  const h = bareHostname(hostname);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return h.startsWith('127.') || h === '0.0.0.0';
  if (net.isIPv6(h)) {
    if (h === '::1' || h === '::') return true;
    const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
    if (dotted) return isLoopbackHostname(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      return (hi >> 8) === 127 || (hi === 0 && parseInt(hex[2], 16) === 0);
    }
  }
  return false;
}

/** Port a URL actually connects to (explicit, or the scheme default). */
const effectivePort = (url) => (url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80);

/**
 * Normalise a user-supplied destination URL.
 * @param {unknown} input
 * @param {{ ownHosts?: string[], serverPort?: number|null, serverHostnames?: string[] }} [opts]
 *   `ownHosts`: hosts (with port when non-default) that serve Blip links (base host + vanity domains);
 *   `serverPort`: the port this server listens on (loopback targets on it would loop back into Blip);
 *   `serverHostnames`: other addresses this server listens on (checked together with `serverPort`).
 * @returns {{ ok: true, url: string } | { ok: false, code: 'invalid_url'|'unsupported_protocol'|'redirect_loop'|'too_long', message: string }}
 */
export function normalizeTargetUrl(input, { ownHosts = [], serverPort = null, serverHostnames = [] } = {}) {
  if (typeof input !== 'string') return fail('invalid_url', 'Enter the URL you want to shorten.');
  let value = input.trim();
  if (!value) return fail('invalid_url', 'Enter the URL you want to shorten.');
  if (value.length > URL_MAX) return fail('too_long', `That URL is longer than ${URL_MAX} characters.`);

  if (value.startsWith('//')) {
    value = `https:${value}`;
  } else {
    const scheme = SCHEME_RE.exec(value);
    if (!scheme || PORT_AFTER_COLON_RE.test(scheme[2])) value = `https://${value}`;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return fail('invalid_url', "That doesn't look like a valid URL.");
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('unsupported_protocol', 'Only http:// and https:// links can be shortened.');
  }
  if (url.username || url.password) {
    return fail('invalid_url', "URLs with a username or password in them can't be shortened.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || (hostname !== 'localhost' && !hostname.includes('.'))) {
    return fail('invalid_url', 'That URL needs a real domain name, like example.com.');
  }
  const own = new Set(ownHosts.filter(Boolean).map((h) => String(h).toLowerCase()));
  const host = url.host.toLowerCase().replace(/\.(?=:|$)/, '');
  if (own.has(host)) {
    return fail('redirect_loop', "That's already a Blip link. Shortening it again would loop forever.");
  }
  // Other names for this very server (127.0.0.1, [::1], its listen address…) on its own port.
  if (Number.isInteger(serverPort) && serverPort > 0 && effectivePort(url) === serverPort) {
    const bare = bareHostname(url.hostname);
    const listenNames = new Set(serverHostnames.filter(Boolean).map(bareHostname));
    if (isLoopbackHostname(bare) || listenNames.has(bare)) {
      return fail('redirect_loop', 'That address points back at this Blip server, so following it would loop forever.');
    }
  }
  if (url.href.length > URL_MAX) return fail('too_long', `That URL is longer than ${URL_MAX} characters.`);
  return { ok: true, url: url.href };
}
