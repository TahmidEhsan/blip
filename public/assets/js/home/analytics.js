// Blip home page: "Live analytics" feature (plain explainer + call to action; analytics is always on).

import { el, icon, linkStore, prefersReducedMotion } from '../api.js';
import { state } from './state.js';
import { byId } from './dom.js';

export function createAnalyticsFeature() {
  const cta = byId('analyticsCta');

  const note = (text) => el('p', { class: 'analytics-cta__note' }, icon('info'), el('span', {}, text));
  const dashButton = (slug) => el('a', { class: 'btn btn--blue', href: `/dashboard.html#${encodeURIComponent(slug)}` },
    icon('activity'), el('span', { class: 'truncate' }, `Open live dashboard for /${slug}`));

  function render() {
    const link = state.currentLink;
    const stored = linkStore.all();
    const saved = stored.length;
    const nodes = [];
    if (link) {
      nodes.push(dashButton(link.slug));
    } else if (saved > 0) {
      nodes.push(note('Every link in My links has its own live dashboard. Here is your newest one:'));
      nodes.push(dashButton(stored[0].slug));
    } else {
      nodes.push(note('Create a link first, then open its dashboard to watch the clicks roll in.'));
    }
    nodes.push(el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      on: {
        click: () => document.getElementById('my-links')?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }),
      },
    }, icon('list'), saved > 0 ? `See my links (${saved})` : 'See my links'));
    cta.replaceChildren(...nodes);
  }

  render();
  window.addEventListener('blip:links-changed', render);

  return {
    id: 'analytics',
    label: 'live analytics',
    render,
    isActive: () => true,
    chip: () => null,
    stateText: () => 'Always on',
    apply() {},
    showError() {},
    reset() {},
  };
}
