// Blip: the third-party files pages load from /vendor (SPEC §7.2). They come from node_modules (no CDN:
// the CSP only allows 'self'). A local server serves them straight from node_modules (server/app.js).
// On Vercel only public/** reaches the CDN, so `npm run build` copies every one the pages reference into
// public/vendor at the same URL (scripts/build-vendor.mjs). Both read this list.

/** Single files: URL → path inside node_modules. */
export const VENDOR_FILES = Object.freeze({
  '/vendor/qr-code-styling.js': 'qr-code-styling/lib/qr-code-styling.js',
  '/vendor/d3.min.js': 'd3/dist/d3.min.js',
  '/vendor/topojson-client.min.js': 'topojson-client/dist/topojson-client.min.js',
  '/vendor/countries-110m.json': 'world-atlas/countries-110m.json',
});

/** Self-hosted fonts: URL prefix → package folder in node_modules (Bangers and Comic Neue, DESIGN.md §4). */
export const VENDOR_DIRS = Object.freeze({
  '/vendor/fonts/bangers': '@fontsource/bangers',
  '/vendor/fonts/comic-neue': '@fontsource/comic-neue',
});

/**
 * The node_modules path behind a /vendor URL path (no query or hash), or null when no vendor route
 * serves it. Paths that climb out of a font folder are never matched.
 * @param {string} urlPath e.g. `/vendor/fonts/bangers/latin-400.css`
 */
export function vendorSource(urlPath) {
  if (Object.hasOwn(VENDOR_FILES, urlPath)) return VENDOR_FILES[urlPath];
  for (const [prefix, dir] of Object.entries(VENDOR_DIRS)) {
    if (!urlPath.startsWith(`${prefix}/`)) continue;
    const segments = urlPath.slice(prefix.length + 1).split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) return null;
    return `${dir}/${segments.join('/')}`;
  }
  return null;
}
