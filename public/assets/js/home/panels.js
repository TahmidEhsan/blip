// Blip home page: feature toggle tiles and their option panels (several may be open at once).
// Panels own aria-expanded; aria-pressed ("this extra is on") is driven by app.js renderFeatureState().

import { prefersReducedMotion } from '../api.js';

/** Matches the open/close transition on .feature-panel in app.css (var(--dur-3)). */
const TRANSITION_MS = 320;

export function createPanels({ onToggle } = {}) {
  const entries = new Map();

  for (const btn of document.querySelectorAll('.feature-btn[data-feature]')) {
    const panel = document.getElementById(btn.getAttribute('aria-controls'));
    if (!panel) continue;
    const entry = { id: btn.dataset.feature, btn, panel, open: false, hideTimer: 0, scrollTimer: 0 };
    entries.set(entry.id, entry);
    panel.inert = true;

    btn.addEventListener('click', () => {
      if (entry.open) close(entry.id);
      else open(entry.id, { scroll: true });
    });
    for (const closer of panel.querySelectorAll('[data-close]')) {
      closer.addEventListener('click', () => close(entry.id));
    }
  }

  function open(id, { scroll = false, focus = false } = {}) {
    const entry = entries.get(id);
    if (!entry) return;
    clearTimeout(entry.hideTimer);
    clearTimeout(entry.scrollTimer);
    const wasOpen = entry.open;
    entry.open = true;
    entry.btn.setAttribute('aria-expanded', 'true');
    entry.panel.hidden = false;
    entry.panel.inert = false;
    if (!wasOpen) void entry.panel.offsetHeight; // commit the closed state so the transition runs
    entry.panel.classList.add('is-open');
    if (!wasOpen) onToggle?.(id, true);

    if (focus) {
      const target = entry.panel.querySelector('[data-autofocus]')
        || entry.panel.querySelector('input:not([type="hidden"]), textarea, button:not([data-close]):not([data-reset])');
      target?.focus({ preventScroll: true });
    }
    if (scroll) {
      const reduced = prefersReducedMotion();
      entry.scrollTimer = setTimeout(() => {
        entry.panel.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
      }, reduced || wasOpen ? 0 : TRANSITION_MS);
    }
  }

  function close(id) {
    const entry = entries.get(id);
    if (!entry || !entry.open) return;
    clearTimeout(entry.scrollTimer);
    const hadFocus = entry.panel.contains(document.activeElement);
    entry.open = false;
    entry.btn.setAttribute('aria-expanded', 'false');
    entry.panel.classList.remove('is-open');
    entry.panel.inert = true;
    if (hadFocus) entry.btn.focus({ preventScroll: true });
    entry.hideTimer = setTimeout(() => {
      if (!entry.open) entry.panel.hidden = true;
    }, prefersReducedMotion() ? 0 : TRANSITION_MS);
    onToggle?.(id, false);
  }

  return {
    open,
    close,
    isOpen: (id) => Boolean(entries.get(id)?.open),
    button: (id) => entries.get(id)?.btn ?? null,
  };
}
