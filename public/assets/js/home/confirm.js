// Blip home page: promise-based confirm built on the shared <dialog class="modal">.

import { el, icon } from '../api.js';
import { byId } from './dom.js';

let pending = null;

/**
 * confirmDialog({ title, slug, message, confirmLabel, tone: 'danger' | 'primary', iconName }) resolves to a boolean.
 * When `slug` is given, each "/<slug>" in the title is set in the URL face (Bangers only has capitals).
 */
export function confirmDialog({ title, slug, message, confirmLabel = 'Confirm', tone = 'danger', iconName = 'triangle-alert' }) {
  const dialog = byId('confirmDialog');
  const ok = byId('confirmOk');
  const iconBox = byId('confirmIcon');

  if (typeof dialog.showModal !== 'function') {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  if (pending) pending(false);

  byId('confirmTitle').replaceChildren(...titleParts(title, slug));
  byId('confirmMessage').textContent = message;
  ok.textContent = confirmLabel;
  ok.className = `btn ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}`;
  iconBox.dataset.tone = tone;
  iconBox.replaceChildren(icon(iconName));

  dialog.returnValue = '';
  dialog.showModal();
  byId('confirmCancel').focus();

  return new Promise((resolve) => {
    pending = (value) => {
      pending = null;
      resolve(value);
    };
  });
}

function titleParts(title, slug) {
  if (!slug) return [title];
  const path = `/${slug}`;
  return title.split(path).flatMap((part, i) => (i === 0 ? [part] : [el('span', { class: 'confirm-modal__slug' }, path), part]));
}

/** Wire the dialog's buttons once at boot. */
export function initConfirmDialog() {
  const dialog = byId('confirmDialog');
  // Settle on the button press itself, so a follow-up window.open() still runs inside that user
  // gesture (Chromium only dispatches the dialog's `close` event with the next rendered frame).
  const answer = (value) => {
    pending?.(value);
    dialog.close(value ? 'confirm' : 'cancel');
  };
  byId('confirmOk').addEventListener('click', () => answer(true));
  byId('confirmCancel').addEventListener('click', () => answer(false));
  dialog.addEventListener('click', (event) => {
    // A click on the backdrop lands on the <dialog> element itself.
    if (event.target === dialog) answer(false);
  });
  // Escape (and anything else that closes the dialog) falls back to the `close` event. A late
  // `close` from an earlier round can arrive after the dialog was re-opened, so ignore it then.
  dialog.addEventListener('close', () => {
    if (!dialog.open) pending?.(dialog.returnValue === 'confirm');
  });
}
