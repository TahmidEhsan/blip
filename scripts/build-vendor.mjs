// Copy every /vendor file Blip's pages load into public/vendor, at the same URL (`npm run build`).
//
// Locally the server serves /vendor/* straight from node_modules (server/app.js). On Vercel only
// public/** reaches the CDN (express.static and these routes never run there), so the build puts the
// files there instead. The list is not hand-kept: the script scans the pages, stylesheets and scripts
// (public/**/*.html, *.css, *.js and server/views/*.html) for /vendor/ URLs, maps each one to its
// package through server/vendor.js, and follows the relative url()s inside the font stylesheets to the
// font files. A reference it can't resolve fails the build, so a page never ships a broken /vendor link.
//
// Usage: node scripts/build-vendor.mjs [--out <dir>]   (default: public; files land in <dir>/vendor)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendorSource } from '../server/vendor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VIEWS_DIR = path.join(ROOT, 'server', 'views');

const VENDOR_URL_RE = /\/vendor\/[^\s"'`()<>?#,;\\]+/g;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function walk(dir, exts, skip, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (skip(p)) continue;
    if (entry.isDirectory()) walk(p, exts, skip, out);
    else if (exts.includes(path.extname(entry.name))) out.push(p);
  }
  return out;
}

/** Every /vendor/ URL the shipped pages, stylesheets and scripts mention, with the files that mention it. */
export function findVendorReferences({ publicDir = PUBLIC_DIR, viewsDir = VIEWS_DIR } = {}) {
  const generated = path.join(publicDir, 'vendor');
  const isGenerated = (p) => p === generated || p.startsWith(generated + path.sep);
  const files = [
    ...walk(publicDir, ['.html', '.css', '.js'], isGenerated),
    ...walk(viewsDir, ['.html'], () => false),
  ];
  const refs = new Map();
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(VENDOR_URL_RE)) {
      const url = match[0].replace(/[.:]+$/, '');
      if (!refs.has(url)) refs.set(url, new Set());
      refs.get(url).add(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
  return refs;
}

/** Relative url()s of a stylesheet, as absolute URL paths (data: and absolute URLs skipped). */
function cssDependencies(cssUrl, css) {
  const out = [];
  for (const [, , ref] of css.matchAll(CSS_URL_RE)) {
    const value = ref.trim();
    if (!value || /^(data:|[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) continue;
    out.push(new URL(value, `http://blip.invalid${cssUrl}`).pathname);
  }
  return out;
}

/**
 * Copy the referenced vendor files (and the fonts their stylesheets load) into `<outDir>/vendor`,
 * replacing whatever an earlier build left there.
 * @returns {{ files: string[], bytes: number }} the URLs written
 */
export function buildVendor({ outDir = PUBLIC_DIR, nodeModules = NODE_MODULES, refs = findVendorReferences() } = {}) {
  const vendorDir = path.join(outDir, 'vendor');
  fs.rmSync(vendorDir, { recursive: true, force: true });
  const problems = [];
  const written = new Set();
  let bytes = 0;
  const queue = [...refs.keys()].map((url) => ({ url, from: [...refs.get(url)].join(', ') }));
  while (queue.length) {
    const { url, from } = queue.shift();
    if (written.has(url)) continue;
    const source = vendorSource(url);
    const abs = source && path.join(nodeModules, ...source.split('/'));
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      problems.push(`${url} (used in ${from}) ${source ? `points at node_modules/${source}, which is missing` : 'has no vendor route in server/vendor.js'}`);
      continue;
    }
    const target = path.join(vendorDir, ...url.slice('/vendor/'.length).split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(abs, target);
    written.add(url);
    bytes += fs.statSync(target).size;
    if (url.endsWith('.css')) {
      for (const dep of cssDependencies(url, fs.readFileSync(abs, 'utf8'))) queue.push({ url: dep, from: url });
    }
  }
  if (problems.length) {
    throw new Error(`Could not copy ${problems.length} vendor file(s):\n  ${problems.join('\n  ')}`);
  }
  return { files: [...written].sort(), bytes };
}

// Run only as a script (`node scripts/build-vendor.mjs`), never on import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex !== -1 && process.argv[outIndex + 1] ? path.resolve(process.argv[outIndex + 1]) : PUBLIC_DIR;
  try {
    const { files, bytes } = buildVendor({ outDir });
    const where = path.relative(ROOT, path.join(outDir, 'vendor')).replace(/\\/g, '/') || 'vendor';
    console.log(`[build] copied ${files.length} vendor files (${Math.round(bytes / 1024)} kB) into ${where}`);
  } catch (err) {
    console.error(`[build] ${err.message}`);
    process.exit(1);
  }
}
