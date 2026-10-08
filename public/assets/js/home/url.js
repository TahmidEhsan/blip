// Blip home page: client-side mirrors of the server's URL and slug rules (SPEC §4.1, §4.2).
// The server stays authoritative; these give instant, friendly feedback.

import { formatNumber } from '../api.js';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// "localhost:3000/x" or "example.com:8080" look like a scheme but are really host:port.
const HOST_PORT = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i;

/** Add https:// when the user typed a bare host ("example.com/page"). */
export function withScheme(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (SCHEME.test(value) && !HOST_PORT.test(value)) return value;
  return `https://${value}`;
}

/**
 * @returns {{ ok: true, url: string, display: string } | { ok: false, message: string }}
 */
export function validateTargetUrl(raw, { ownHosts = [], maxLength = 2048 } = {}) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, message: 'Paste a link to shorten first.' };
  if (value.length > maxLength) return { ok: false, message: `That link is too long. Keep it under ${formatNumber(maxLength)} characters.` };
  const candidate = withScheme(value);
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, message: "That doesn't look like a link. Try something like example.com/page." };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'Only http:// and https:// links can be shortened.' };
  }
  if (url.username || url.password) {
    return { ok: false, message: "Links with a username or password inside can't be shortened." };
  }
  if (!(url.hostname.includes('.') || url.hostname === 'localhost')) {
    return { ok: false, message: "That doesn't look like a full web address. Did you mean something like example.com?" };
  }
  if (ownHosts.includes(url.host.toLowerCase())) {
    return { ok: false, message: "That's already a Blip link. No infinite loops, please!" };
  }
  if (url.href.length > maxLength) return { ok: false, message: `That link is too long. Keep it under ${formatNumber(maxLength)} characters.` };
  return { ok: true, url: url.href, display: candidate };
}

/** Mirror of server normalizeSlug(): "Summer Sale 2026!" becomes "summer-sale-2026". */
export function normalizeSlug(input) {
  let s = String(input ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\s_./\\]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > 64) s = s.slice(0, 64).replace(/-+$/g, '');
  return s;
}

/** A phrase worth suggesting slugs from, guessed from a target URL ("example.com/summer-sale" gives "summer sale"). */
export function phraseFromUrl(raw) {
  const res = validateTargetUrl(raw);
  if (!res.ok) return '';
  const url = new URL(res.url);
  const segments = url.pathname.split('/').filter(Boolean).map((seg) => {
    let decoded = seg;
    try { decoded = decodeURIComponent(seg); } catch { decoded = seg; }
    return decoded.replace(/\.[a-z0-9]{1,5}$/i, '');
  });
  const meaningful = segments.reverse().find((seg) => /[a-z]{3,}/i.test(seg) && !/^\d+$/.test(seg));
  if (meaningful) return meaningful.replace(/[-_+.]+/g, ' ').trim().slice(0, 40);
  const parts = url.hostname.replace(/^www\./, '').split('.');
  return (parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0]).slice(0, 40);
}
