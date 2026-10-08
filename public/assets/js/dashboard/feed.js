// Blip dashboard: live feed of ClickEvents. Rows are split by ink rules and the outcome is a badge
// (visit, teaser, blocked, bot). Live arrivals slide in at the top.
import { el, icon, formatRelative, formatNumber } from '../api.js';
import { clickKind, isCountedClick, deviceIcon, deviceLabel } from './constants.js';
import { countryPill } from './lists.js';

const MAX_ITEMS = 60;
const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const fmtTime = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });
const fmtDayTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Static timestamp for assistive tech. The visible relative label ("3 minutes ago") is rewritten every
 * tick, so it is aria-hidden; otherwise the role="log" live region would announce every row again.
 */
function spokenTime(ts) {
  return ts.toDateString() === new Date().toDateString() ? `at ${fmtTime.format(ts)}` : `on ${fmtDayTime.format(ts)}`;
}

function placeLabel(evt) {
  const country = evt.countryName || (evt.country ? String(evt.country).toUpperCase() : '');
  if (evt.city && country) return `${evt.city}, ${country}`;
  return evt.city || country || 'Unknown location';
}

/** The outcome badge first, then at most one qualifier (simulated, or a first-time visitor). */
function badgesFor(evt) {
  const kind = clickKind(evt);
  const out = [];
  if (kind === 'blocked') out.push(['badge--expired', 'Blocked']);
  else if (evt.outcome === 'bot-preview') out.push(['badge--neutral', 'Bot preview']);
  else if (kind === 'bot') out.push(['badge--neutral', 'Bot']);
  else if (evt.outcome === 'teaser') out.push(['badge--teaser', 'Teaser']);
  else out.push(['badge--active', 'Visit']);
  if (evt.isSynthetic) out.push(['badge--synthetic', 'Simulated']);
  else if (evt.isUnique && isCountedClick(evt)) out.push(['badge--live', 'New visitor']);
  return out;
}

function describeOutcome(evt) {
  const kind = clickKind(evt);
  if (kind === 'blocked') return 'Arrived after the self-destruct and saw the expired page';
  if (evt.outcome === 'bot-preview') return 'Link preview bot: the target was kept secret';
  if (kind === 'bot') return 'Bot or crawler, not counted';
  return null;
}

function buildItem(evt) {
  const kind = clickKind(evt);
  const ts = new Date(evt.ts);
  const validTs = Number.isFinite(ts.getTime());
  const metaParts = [evt.browser, evt.os].filter(Boolean);
  const via = evt.referrer ? `via ${evt.referrer}` : 'direct visit';
  const note = describeOutcome(evt);
  const device = evt.device || 'other';

  return el(
    'li',
    { class: `feed-item feed-item--${kind}`, dataset: { id: String(evt.id) } },
    countryPill(evt.country, evt.countryName),
    el(
      'div',
      { class: 'feed-item__body' },
      el('p', { class: 'feed-item__title' }, placeLabel(evt)),
      el(
        'p',
        { class: 'feed-item__meta' },
        el('span', { class: 'feed-item__device' }, icon(kind === 'bot' ? 'bot' : deviceIcon(device), { class: 'icon icon--sm' }), el('span', {}, deviceLabel(device))),
        metaParts.length ? el('span', {}, metaParts.join(', ')) : null,
        el('span', { class: 'feed-item__via' }, via),
      ),
      note ? el('p', { class: 'feed-item__note' }, note) : null,
    ),
    el(
      'div',
      { class: 'feed-item__aside' },
      el('time', { class: 'feed-item__time', datetime: validTs ? ts.toISOString() : '', title: validTs ? fmtFull.format(ts) : '', 'aria-hidden': 'true' }, formatRelative(ts)),
      validTs ? el('span', { class: 'visually-hidden' }, spokenTime(ts)) : null,
      el('span', { class: 'feed-item__badges' }, badgesFor(evt).map(([cls, text]) => el('span', { class: `badge ${cls}` }, text))),
    ),
  );
}

/**
 * @param {HTMLOListElement} list
 * @param {{ emptyNode?: HTMLElement, countNode?: HTMLElement }} [opts]
 */
export function createFeed(list, { emptyNode, countNode } = {}) {
  let items = []; // newest first
  const ids = new Set();
  const fresh = new Set();
  const nodes = new Map(); // id -> <li>, so existing rows are reused (and keep their place) on re-render

  function render() {
    const keep = new Set(items.map((evt) => String(evt.id)));
    for (const [id, node] of nodes) {
      if (!keep.has(id)) {
        node.remove();
        nodes.delete(id);
      }
    }
    let prev = null;
    for (const evt of items) {
      const id = String(evt.id);
      let node = nodes.get(id);
      if (!node) {
        node = buildItem(evt);
        nodes.set(id, node);
        if (fresh.has(evt.id)) {
          node.classList.add('is-new');
          node.addEventListener('animationend', () => node.classList.remove('is-new'), { once: true });
        }
      }
      const want = prev ? prev.nextSibling : list.firstChild;
      if (want !== node) list.insertBefore(node, want);
      prev = node;
    }
    fresh.clear();
    if (emptyNode) emptyNode.hidden = items.length > 0;
    if (countNode) {
      countNode.textContent = formatNumber(items.length);
      countNode.title = `${items.length} recent ${items.length === 1 ? 'event' : 'events'} shown`;
    }
  }

  function trim() {
    if (items.length <= MAX_ITEMS) return;
    for (const dropped of items.slice(MAX_ITEMS)) ids.delete(dropped.id);
    items = items.slice(0, MAX_ITEMS);
  }

  return {
    /** Replace everything (initial load or after switching links). */
    reset(recent = []) {
      items = [];
      ids.clear();
      fresh.clear();
      for (const evt of Array.isArray(recent) ? recent : []) {
        if (evt && evt.id !== undefined && !ids.has(evt.id)) {
          ids.add(evt.id);
          items.push(evt);
        }
      }
      items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
      trim();
      render();
    },
    /** Merge events from a stats refetch (anything the stream missed), keeping live order for the rest. */
    merge(recent = []) {
      let changed = false;
      for (const evt of Array.isArray(recent) ? recent : []) {
        if (!evt || evt.id === undefined || ids.has(evt.id)) continue;
        ids.add(evt.id);
        const t = Date.parse(evt.ts);
        const at = items.findIndex((x) => Date.parse(x.ts) < t);
        if (at === -1) items.push(evt);
        else items.splice(at, 0, evt);
        changed = true;
      }
      if (!changed) return;
      trim();
      render();
    },
    /** A live click from the stream: newest on top, slides in. */
    push(evt) {
      if (!evt || evt.id === undefined || ids.has(evt.id)) return;
      ids.add(evt.id);
      fresh.add(evt.id);
      items.unshift(evt);
      trim();
      render();
    },
    removeWhere(predicate) {
      const before = items.length;
      items = items.filter((evt) => {
        const drop = predicate(evt);
        if (drop) ids.delete(evt.id);
        return !drop;
      });
      if (items.length !== before) render();
    },
    /** Refresh the visible "just now" / "3 minutes ago" labels (aria-hidden, so the log stays quiet). */
    tick() {
      const now = Date.now();
      for (const node of list.querySelectorAll('time.feed-item__time')) {
        const iso = node.getAttribute('datetime');
        if (iso) node.textContent = formatRelative(iso, now);
      }
    },
    get size() {
      return items.length;
    },
  };
}
