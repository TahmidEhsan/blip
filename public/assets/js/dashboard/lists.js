// Blip dashboard: the Breakdown tab lists. Horizontal bars with a flat --blue fill inside an ink outline
// (square ends), the count and its share. Rows are rebuilt from data on every refresh, without animation.
import { el, icon, formatNumber, countryCode } from '../api.js';
import { deviceIcon, deviceLabel, DEVICE_ORDER } from './constants.js';

const share = (n, total) => (total > 0 ? (n / total) * 100 : 0);
const pctLabel = (n, total) => {
  const v = share(n, total);
  if (v > 0 && v < 1) return '<1%';
  return `${Math.round(v)}%`;
};

/**
 * Render a ranked list of horizontal bars.
 * @param {HTMLOListElement} list
 * @param {{name: string, count: number}[]} items
 * @param {{ emptyNode?: HTMLElement, label?: (item) => string, lead?: (item) => Node|null, unit?: [string, string] }} [opts]
 */
export function renderBars(list, items, { emptyNode, label = (d) => d.name, lead = null, unit = ['click', 'clicks'] } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter((d) => d && d.count > 0);
  const total = rows.reduce((sum, d) => sum + d.count, 0);
  const ranked = rows.filter((d) => d.name !== 'Other');
  const max = Math.max(1, ...(ranked.length ? ranked : rows).map((d) => d.count));
  if (emptyNode) emptyNode.hidden = rows.length > 0;
  list.hidden = rows.length === 0;

  list.replaceChildren(...rows.map((d) => {
    const name = label(d);
    const pct = pctLabel(d.count, total);
    const width = Math.max(2, Math.min(100, (d.count / max) * 100));
    return el(
      'li',
      { class: `hbar${d.name === 'Other' ? ' hbar--other' : ''}` },
      lead ? lead(d) : null,
      el(
        'div',
        { class: 'hbar__main' },
        el(
          'div',
          { class: 'hbar__top' },
          el('span', { class: 'hbar__label', title: name }, name),
          el(
            'span',
            { class: 'hbar__value' },
            el('span', { class: 'hbar__count' }, formatNumber(d.count), el('span', { class: 'visually-hidden' }, ` ${d.count === 1 ? unit[0] : unit[1]},`)),
            el('span', { class: 'hbar__pct' }, pct),
          ),
        ),
        el('div', { class: 'hbar__track', 'aria-hidden': 'true' }, el('span', { class: 'hbar__fill', style: { width: `${width}%` } })),
      ),
    );
  }));
}

/** Device rows: sorted by count, ties in a stable device order, each with its icon. */
export function renderDevices(list, devices, { emptyNode } = {}) {
  const rank = (name) => {
    const i = DEVICE_ORDER.indexOf(name);
    return i === -1 ? DEVICE_ORDER.length : i;
  };
  const items = (Array.isArray(devices) ? devices : [])
    .filter((d) => d && d.count > 0)
    .map((d) => ({ name: String(d.name || 'other'), count: Number(d.count) || 0 }))
    .sort((a, b) => b.count - a.count || rank(a.name) - rank(b.name));
  renderBars(list, items, {
    emptyNode,
    label: (d) => deviceLabel(d.name),
    lead: (d) => el('span', { class: 'hbar__lead', 'aria-hidden': 'true' }, icon(deviceIcon(d.name))),
  });
}

/** Referrer lead: an icon for direct visits and "Other", otherwise the host's first letter. */
export function referrerLead(d) {
  if (d.name === 'direct') return el('span', { class: 'hbar__lead', 'aria-hidden': 'true' }, icon('mouse-pointer-click'));
  if (d.name === 'Other') return el('span', { class: 'hbar__lead', 'aria-hidden': 'true' }, icon('ellipsis'));
  const host = String(d.name).replace(/^www\./i, '');
  const letter = (host.match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();
  return el('span', { class: 'hbar__lead hbar__lead--letter', 'aria-hidden': 'true' }, letter);
}

export const referrerLabel = (d) => (d.name === 'direct' ? 'Direct (no referrer)' : d.name);

/** Two-letter country code pill. The code is the visual; the name sits beside it or in the title. */
export function countryPill(code, name) {
  const cc = countryCode(code);
  const known = cc !== '??';
  return el(
    'span',
    { class: `cc${known ? '' : ' cc--unknown'}`, title: known ? name || cc : 'Unknown location', 'aria-hidden': 'true' },
    cc,
  );
}

/** Country rows: every country, ranked, each led by its code pill. */
export function renderCountries(list, countries, { emptyNode } = {}) {
  const items = (Array.isArray(countries) ? countries : [])
    .filter((c) => c && c.count > 0)
    .map((c) => ({ ...c, name: c.name || (c.code ? countryCode(c.code) : 'Unknown') }));
  renderBars(list, items, {
    emptyNode,
    lead: (c) => el('span', { class: 'hbar__lead hbar__lead--pill', 'aria-hidden': 'true' }, countryPill(c.code, c.name)),
  });
}
