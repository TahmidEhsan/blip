// Blip: tiny, escaping-only template renderer for server views (SPEC §6).
//
//   {{text:KEY}}  HTML-escaped text
//   {{attr:KEY}}  HTML-escaped, safe inside double-quoted attributes
//   {{json:KEY}}  JSON for <script type="application/json"> (<, >, &, U+2028, U+2029 escaped)
//
// Anything else ({{raw:…}}, unknown kinds, unknown keys) renders as an empty string.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VIEW_NAMES = Object.freeze(['teaser', 'expired', 'not-found', 'preview', 'unavailable']);
const VIEWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'views');
const PLACEHOLDER_RE = /\{\{\s*([a-z]+)\s*:\s*([A-Za-z0-9_]+)\s*\}\}/g;

// Built from char codes so no raw U+2028/U+2029 ever appears in this source file.
const LINE_SEPARATOR_RE = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR_RE = new RegExp(String.fromCharCode(0x2029), 'g');
const BACKSLASH = String.fromCharCode(92);
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** JSON that is safe to embed inside a <script> element. */
export function safeJson(value) {
  const json = JSON.stringify(value === undefined ? null : value) ?? 'null';
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATOR_RE, `${BACKSLASH}u2028`)
    .replace(PARAGRAPH_SEPARATOR_RE, `${BACKSLASH}u2029`);
}

/**
 * Pure, single-pass substitution: substituted values are never re-scanned for placeholders.
 * @param {string} template
 * @param {Record<string, unknown>} vars
 */
export function renderTemplate(template, vars = {}) {
  return String(template).replace(PLACEHOLDER_RE, (_, kind, key) => {
    const has = Object.prototype.hasOwnProperty.call(vars, key);
    const value = has ? vars[key] : undefined;
    switch (kind) {
      case 'text':
      case 'attr':
        return has ? escapeHtml(value) : '';
      case 'json':
        return has ? safeJson(value) : '';
      default:
        return '';
    }
  });
}

/**
 * Create a view renderer. Templates are cached when `cache` is true (production).
 * @param {{ cache?: boolean, dir?: string }} [opts]
 */
export function createViewRenderer({ cache = process.env.NODE_ENV === 'production', dir = VIEWS_DIR } = {}) {
  const templates = new Map();
  return async function renderView(name, vars = {}) {
    if (!VIEW_NAMES.includes(name)) throw new Error(`Unknown view "${name}"`);
    let template = cache ? templates.get(name) : undefined;
    if (template === undefined) {
      template = await readFile(path.join(dir, `${name}.html`), 'utf8');
      if (cache) templates.set(name, template);
    }
    return renderTemplate(template, vars);
  };
}

/** Render one of the known views (`teaser`, `expired`, `not-found`, `preview`, `unavailable`). */
export const renderView = createViewRenderer();
