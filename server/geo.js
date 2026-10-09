// Blip: privacy-friendly visitor geolocation (SPEC §4.4).
// 1. CDN/edge country headers, 2. the optional offline `fast-geoip` database.
// On Vercel only Vercel's own x-vercel-ip-* headers count (its edge sets them on every request, while
// any other CDN's header would come straight from the visitor), and fast-geoip is never loaded: its
// 159 MB of data would not fit in a function, so it is imported through a specifier Vercel's file
// tracer can't follow (see importOptional).
// Coordinates are rounded to 1 decimal; raw IPs are never stored or logged.
import net from 'node:net';

export const GEO_TIMEOUT_MS = 150;

const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country', 'x-country-code'];
const CITY_HEADERS = ['cf-ipcity', 'x-vercel-ip-city', 'cloudfront-viewer-city'];
const REGION_HEADERS = ['cf-region-code', 'x-vercel-ip-country-region', 'cloudfront-viewer-country-region'];
const LAT_HEADERS = ['cf-iplatitude', 'x-vercel-ip-latitude', 'cloudfront-viewer-latitude'];
const LON_HEADERS = ['cf-iplongitude', 'x-vercel-ip-longitude', 'cloudfront-viewer-longitude'];
const IGNORED_COUNTRIES = new Set(['XX', 'T1', 'ZZ', 'EU', 'AP']);

/** The headers Vercel's edge sets on every request (the city is URI-encoded). */
export const VERCEL_GEO_HEADERS = Object.freeze({
  country: ['x-vercel-ip-country'],
  city: ['x-vercel-ip-city'],
  region: ['x-vercel-ip-country-region'],
  lat: ['x-vercel-ip-latitude'],
  lon: ['x-vercel-ip-longitude'],
});
const ANY_CDN_HEADERS = Object.freeze({
  country: COUNTRY_HEADERS,
  city: CITY_HEADERS,
  region: REGION_HEADERS,
  lat: LAT_HEADERS,
  lon: LON_HEADERS,
});

/** Strip an IPv6 zone id and an IPv4-mapped `::ffff:` prefix. */
export function cleanIp(ip) {
  if (typeof ip !== 'string') return '';
  let v = ip.trim();
  if (v.startsWith('[') && v.includes(']')) v = v.slice(1, v.indexOf(']'));
  const zone = v.indexOf('%');
  if (zone !== -1) v = v.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (mapped) v = mapped[1];
  return v;
}

function ipv4Octets(ip) {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

/** Expand an IPv6 address into its first two 16-bit groups (enough for the prefixes we check). */
function ipv6Head(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::') return [0, 0];
  const [head] = lower.split('::');
  const groups = head ? head.split(':') : [];
  const a = groups[0] ? parseInt(groups[0], 16) : 0;
  const b = groups[1] ? parseInt(groups[1], 16) : 0;
  return [a, b];
}

/**
 * True only for globally routable addresses. Loopback, private, CGNAT, link-local,
 * unique-local, multicast and unspecified addresses are never looked up
 * (fast-geoip happily returns bogus data for them, e.g. 127.0.0.1 → JP).
 */
export function isPublicIp(rawIp) {
  const ip = cleanIp(rawIp);
  const family = net.isIP(ip);
  if (family === 4) {
    const o = ipv4Octets(ip);
    if (!o) return false;
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127) return false; // unspecified / private / loopback
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // private 172.16/12
    if (a === 192 && b === 168) return false; // private
    if (a === 192 && b === 0 && o[2] === 2) return false; // TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51 && o[2] === 100) return false; // TEST-NET-2
    if (a === 203 && b === 0 && o[2] === 113) return false; // TEST-NET-3
    if (a >= 224) return false; // multicast + reserved + broadcast
    return true;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    const [g0, g1] = ipv6Head(lower);
    if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((g0 & 0xff00) === 0xff00) return false; // multicast
    if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
    if (g0 === 0 && !lower.startsWith('::ffff:')) return false; // ::/16-ish compat/reserved space
    return true;
  }
  return false;
}

function header(headers, names) {
  for (const name of names) {
    const raw = headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function decodeHeader(value) {
  if (!value) return null;
  try {
    return decodeURIComponent(value).slice(0, 80);
  } catch {
    return value.slice(0, 80);
  }
}

const round1 = (n) => Math.round(n * 10) / 10;

function coords(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return { lat: null, lon: null };
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return { lat: null, lon: null };
  if (la === 0 && lo === 0) return { lat: null, lon: null }; // "unknown" sentinel in geo databases
  return { lat: round1(la), lon: round1(lo) };
}

/**
 * Geo from trusted edge headers (Cloudflare, Vercel, CloudFront, generic).
 * @param {object} headers request headers
 * @param {{ vercel?: boolean }} [opts] on Vercel, read only the x-vercel-ip-* headers
 */
export function geoFromHeaders(headers, { vercel = false } = {}) {
  const names = vercel ? VERCEL_GEO_HEADERS : ANY_CDN_HEADERS;
  const country = header(headers, names.country)?.toUpperCase();
  if (!country || !/^[A-Z]{2}$/.test(country) || IGNORED_COUNTRIES.has(country)) return null;
  const { lat, lon } = coords(header(headers, names.lat), header(headers, names.lon));
  const region = header(headers, names.region);
  return {
    country,
    region: region && /^[A-Za-z0-9-]{1,10}$/.test(region) ? region.toUpperCase() : null,
    city: decodeHeader(header(headers, names.city)),
    lat,
    lon,
  };
}

/** The optional offline geo database (an optionalDependency, so it may be missing). */
export const GEOIP_PACKAGE = 'fast-geoip';

/**
 * import() of a package named at run time. A file tracer (Vercel's) only follows import() calls whose
 * specifier is written out in the call, so a package loaded through here is never bundled.
 */
function importOptional(specifier) {
  return import(specifier);
}

const importGeoip = (importer) => Promise.resolve()
  .then(() => importer(GEOIP_PACKAGE))
  .then((mod) => {
    const lib = mod?.default ?? mod;
    return typeof lib?.lookup === 'function' ? lib : null;
  })
  .catch(() => null);

let geoipModule;
/** Lazily import the optional fast-geoip package once; null when unavailable. A test's importer is never cached. */
function loadGeoip(importer) {
  if (importer) return importGeoip(importer);
  geoipModule ??= importGeoip(importOptional);
  return geoipModule;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function geoFromDatabase(ip, importer) {
  const lib = await loadGeoip(importer);
  if (!lib) return null;
  const r = await lib.lookup(ip);
  if (!r || typeof r.country !== 'string' || !/^[A-Z]{2}$/i.test(r.country)) return null;
  const [lat, lon] = Array.isArray(r.ll) ? r.ll : [null, null];
  return {
    country: r.country.toUpperCase(),
    region: typeof r.region === 'string' && r.region ? r.region.slice(0, 10) : null,
    city: typeof r.city === 'string' && r.city ? r.city.slice(0, 80) : null,
    ...coords(lat, lon),
  };
}

/**
 * @param {string} ip the client IP (never stored)
 * @param {Record<string, string|string[]|undefined>} headers request headers
 * @param {{ timeoutMs?: number, vercel?: boolean, importer?: (specifier: string) => Promise<any> }} [opts]
 *   `vercel`: trust only Vercel's headers and never load fast-geoip; `importer` replaces import() (tests)
 * @returns {Promise<{country: string, region: string|null, city: string|null, lat: number|null, lon: number|null} | null>}
 */
export async function lookupGeo(ip, headers = {}, { timeoutMs = GEO_TIMEOUT_MS, vercel = false, importer } = {}) {
  const fromHeaders = geoFromHeaders(headers, { vercel });
  if (fromHeaders || vercel) return fromHeaders;
  const clean = cleanIp(ip);
  if (!isPublicIp(clean)) return null;
  try {
    return await withTimeout(geoFromDatabase(clean, importer), timeoutMs);
  } catch {
    return null;
  }
}

/**
 * The geo lookup an app uses: `(ip, headers) => Promise<geo|null>`.
 * @param {{ vercel?: boolean }} [opts] true on Vercel (see lookupGeo)
 */
export function createGeoLookup({ vercel = false } = {}) {
  return (ip, headers) => lookupGeo(ip, headers, { vercel });
}
