// Blip dashboard: one floating caption-box tooltip per chart container.
// Content is always set with textContent (labels come from link data and must never be parsed as HTML).
import { el } from '../api.js';

/**
 * @param {HTMLElement} container positioned (relative) element the tooltip floats inside
 * @returns {{ show(x: number, y: number, content: {value: string, label?: string, sub?: string}): void, hide(): void, node: HTMLElement }}
 */
export function createTooltip(container) {
  const labelNode = el('span', { class: 'chart-tip__label' });
  const valueNode = el('span', { class: 'chart-tip__value' });
  const subNode = el('span', { class: 'chart-tip__sub' });
  const node = el('div', { class: 'chart-tip', 'aria-hidden': 'true', hidden: true }, labelNode, valueNode, subNode);
  container.append(node);

  function show(x, y, { value, label = '', sub = '' } = {}) {
    labelNode.textContent = label;
    labelNode.hidden = !label;
    valueNode.textContent = value ?? '';
    subNode.textContent = sub;
    subNode.hidden = !sub;
    node.hidden = false;

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const gap = 14;
    let left = x + gap;
    if (left + w > cw - 4) left = x - w - gap;
    left = Math.max(4, Math.min(left, cw - w - 4));
    let top = y - h - gap;
    if (top < 4) top = Math.min(y + gap, ch - h - 4);
    top = Math.max(4, top);
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }

  function hide() {
    node.hidden = true;
  }

  return { show, hide, node };
}
