// Blip home page: small delights (one-shot sound-effect bursts and the "/" shortcut).

import { prefersReducedMotion } from '../api.js';
import { isTypingTarget } from './dom.js';

/**
 * Replay the one-shot pop on a .burst (theme.css .is-popping). Under prefers-reduced-motion
 * the pop is skipped and the burst simply shows, holding still.
 */
export function popBurst(node) {
  if (!node) return;
  node.classList.remove('is-popping');
  if (prefersReducedMotion()) return;
  void node.offsetWidth; // restart the animation when it is already showing
  node.classList.add('is-popping');
}

/** Press "/" anywhere (outside text fields) to jump to the URL box. */
export function initSlashShortcut(input) {
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.defaultPrevented || isTypingTarget(event.target) || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    input.select();
    input.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });
}
