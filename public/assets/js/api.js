// Blip — shared browser helpers: API client, local link store, toasts, DOM builder.
// Every page imports from here; see SPEC.md §5 for the endpoints.

export class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message || code || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'error';
    this.field = field || null;
  }
}

async function request(method, path, { body, token, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Manage-Token'] = token;

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Network error — is the Blip server running?');
  }

  if (res.status === 204) return null;
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const e = data?.error || {};
    const retry = res.headers.get('Retry-After');
    const message = e.message || (res.status === 429 && retry ? `Slow down — try again in ${retry}s.` : `Request failed (${res.status})`);
    throw new ApiError(res.status, e.code, message, e.field);
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  health: () => request('GET', '/api/health'),
  config: () => request('GET', '/api/config'),
  checkSlug: (slug, opts) => request('GET', `/api/slugs/check?slug=${enc(slug)}`, opts),
  suggestSlugs: (phrase = '', count = 6, opts) =>
    request('GET', `/api/slugs/suggest?count=${count}${phrase ? `&phrase=${enc(phrase)}` : ''}`, opts),
  domainIdeas: (keyword, opts) => request('GET', `/api/domains/ideas?keyword=${enc(keyword)}`, opts),

  createLink: (body) => request('POST', '/api/links', { body }),
  batch: (items) => request('POST', '/api/links/batch', { body: { items } }),
  getLink: (slug, token) => request('GET', `/api/links/${enc(slug)}`, { token }),
  updateLink: (slug, token, patch) => request('PATCH', `/api/links/${enc(slug)}`, { token, body: patch }),
  deleteLink: (slug, token) => request('DELETE', `/api/links/${enc(slug)}`, { token }),
  destroyLink: (slug, token) => request('POST', `/api/links/${enc(slug)}/destroy`, { token, body: {} }),
  reviveLink: (slug, token) => request('POST', `/api/links/${enc(slug)}/revive`, { token, body: {} }),
  stats: (slug, token, { range = '7d', tz = new Date().getTimezoneOffset(), signal } = {}) =>
    request('GET', `/api/links/${enc(slug)}/stats?range=${enc(range)}&tz=${tz}`, { token, signal }),
  simulate: (slug, token, count = 12) => request('POST', `/api/links/${enc(slug)}/simulate`, { token, body: { count } }),
  clearSimulated: (slug, token) => request('DELETE', `/api/links/${enc(slug)}/simulated`, { token }),

  /**
   * Live click stream (SSE parsed from a fetch body so the token stays in a header).
   * Reconnects with backoff until close() is called.
   * @returns {{ close(): void }}
   */
  stream(slug, token, { onEvent, onStatus } = {}) {
    let closed = false;
    let controller = null;
    let attempt = 0;
    const setStatus = (s) => { try { onStatus?.(s); } catch (e) { console.error(e); } };

    const connect = async () => {
      if (closed) return;
      controller = new AbortController();
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        const res = await fetch(`/api/links/${enc(slug)}/stream`, {
          headers: { 'X-Manage-Token': token, Accept: 'text/event-stream' },
          signal: controller.signal,
          cache: 'no-store',
        });
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          setStatus('denied');
          closed = true;
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        attempt = 0;
        setStatus('open');
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value.replace(/\r\n/g, '\n');
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = 'message';
            const dataLines = [];
            for (const line of raw.split('\n')) {
              if (!line || line.startsWith(':')) continue;
              const colon = line.indexOf(':');
              const field = colon === -1 ? line : line.slice(0, colon);
              const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
              if (field === 'event') event = val;
              else if (field === 'data') dataLines.push(val);
            }
            if (!dataLines.length) continue;
            let data;
            try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }
            try { onEvent?.(event, data); } catch (e) { console.error(e); }
          }
        }
        if (!closed) throw new Error('stream ended');
      } catch (err) {
        if (closed || err?.name === 'AbortError') return;
        attempt += 1;
        setStatus('reconnecting');
        const delay = Math.min(15000, 600 * 2 ** Math.min(attempt, 5)) + Math.random() * 400;
        setTimeout(connect, delay);
      }
    };

    connect();
    return {
      close() {
        closed = true;
        controller?.abort();
        setStatus('closed');
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Local link store — manage tokens live only in this browser.
// ---------------------------------------------------------------------------
const STORE_KEY = 'blip.links.v1';

function readStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.slug === 'string' && typeof x.token === 'string') : [];
  } catch {
    return [];
  }
}

function writeStore(items) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items));
    window.dispatchEvent(new CustomEvent('blip:links-changed'));
    return true;
  } catch {
    return false;
  }
}

export const linkStore = {
  /** @returns {{slug: string, token: string, createdAt: number}[]} newest first */
  all() {
    return readStore().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  },
  get(slug) {
    return readStore().find((x) => x.slug === slug) || null;
  },
  tokenFor(slug) {
    return this.get(slug)?.token || null;
  },
  add({ slug, token, createdAt = Date.now() }) {
    const items = readStore().filter((x) => x.slug !== slug);
    items.push({ slug, token, createdAt });
    return writeStore(items);
  },
  remove(slug) {
    return writeStore(readStore().filter((x) => x.slug !== slug));
  },
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Safe element builder. Strings become text nodes (never parsed as HTML).
 * el('a', { href, class: 'btn', dataset: { slug }, on: { click: fn }, 'aria-label': 'x' }, 'text', childNode)
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'on') for (const [evt, fn] of Object.entries(value)) node.addEventListener(evt, fn);
    else if (key === 'text') node.textContent = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Lucide icon placeholder; call refreshIcons() after inserting. */
export function icon(name, attrs = {}) {
  return el('i', { 'data-lucide': name, 'aria-hidden': 'true', ...attrs });
}

export function refreshIcons(root) {
  try {
    window.lucide?.createIcons?.(root ? { root } : undefined);
  } catch (e) {
    console.warn('lucide', e);
  }
}

let toastRegion = null;
/** toast('Copied!', { type: 'success' | 'error' | 'info', timeout: 2800 }) */
export function toast(message, { type = 'info', timeout = 2800 } = {}) {
  if (!toastRegion || !document.body.contains(toastRegion)) {
    toastRegion = el('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const glyph = type === 'success' ? '✓' : type === 'error' ? '⚠' : '✦';
  const node = el('div', { class: `toast toast--${type}` }, el('span', { class: 'toast__icon', 'aria-hidden': 'true' }, glyph), el('span', {}, message));
  toastRegion.append(node);
  const remove = () => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 260);
  };
  setTimeout(remove, timeout);
  node.addEventListener('click', remove);
  return remove;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const nf = new Intl.NumberFormat();
export const formatNumber = (n) => nf.format(n ?? 0);

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
/** "just now", "3 minutes ago", "in 2 hours" */
export function formatRelative(date, now = Date.now()) {
  const t = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 10) return 'just now';
  const units = [
    ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1],
  ];
  for (const [unit, secs] of units) {
    if (abs >= secs || unit === 'second') return rtf.format(Math.round(diff / secs), unit);
  }
  return '';
}

/** "2d 4h", "5m 12s" — for countdowns */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 🇬🇧 from "GB" */
export function flagEmoji(code) {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '🌐';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

export function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
