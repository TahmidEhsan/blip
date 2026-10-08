// Blip self-destructed page: reason-specific copy, the details list and a "Replay the boom" button.
// The Ka-boom burst itself is CSS (theme.css .burst.is-popping); this fills in text from #blip-data.
import { formatNumber, prefersReducedMotion } from './api.js';

const POP_MS = 700;

function readData() {
  const node = document.getElementById('blip-data');
  try {
    const parsed = JSON.parse(node?.textContent || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const $ = (id) => document.getElementById(id);
const toCount = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

function formatWhen(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const data = readData();
const reason = ['time', 'clicks', 'manual'].includes(data.reason) ? data.reason : null;
const maxClicks = toCount(data.maxClicks);
const clickCount = toCount(data.clickCount);
const when = formatWhen(data.expiredAt);
const slug = typeof data.slug === 'string' ? data.slug : '';

function reasonCopy() {
  switch (reason) {
    case 'clicks':
      if (maxClicks === 1) return 'It was set to vanish after 1 click, and someone got here first.';
      if (maxClicks) return `It was set to vanish after ${formatNumber(maxClicks)} clicks, and all ${formatNumber(maxClicks)} have been used up.`;
      return 'It was set to vanish after a set number of clicks, and every one has been used up.';
    case 'time':
      return when ? `Its timer ran out on ${when}.` : 'Its timer ran out.';
    case 'manual':
      return 'Its owner hit Destroy now.';
    default:
      return "This Blip has vanished and can't take you anywhere anymore.";
  }
}

function triggerLabel() {
  switch (reason) {
    case 'clicks':
      if (maxClicks === 1) return 'Burn after reading (1 click)';
      return maxClicks ? `Click limit (${formatNumber(maxClicks)} clicks)` : 'Click limit';
    case 'time':
      return 'Timer ran out';
    case 'manual':
      return 'Destroyed by its owner';
    default:
      return null;
  }
}

function render() {
  $('expired-reason').textContent = reasonCopy();

  const trigger = triggerLabel();
  if (!slug && !trigger) return;

  $('fact-slug').textContent = slug ? `/${slug}` : 'Unknown';
  $('fact-trigger').textContent = trigger || 'Self-destruct';

  if (maxClicks !== null || (clickCount !== null && clickCount > 0)) {
    $('fact-clicks').textContent = maxClicks !== null
      ? `${formatNumber(clickCount ?? 0)} of ${formatNumber(maxClicks)}`
      : formatNumber(clickCount);
    $('fact-clicks-row').hidden = false;
  }
  if (when) {
    $('fact-when').textContent = when;
    $('fact-when-row').hidden = false;
  }
  $('expired-facts').hidden = false;
}

// Replays the one-shot burst by restarting its CSS animation. Under reduced motion the burst
// rests at its end state, so the button has nothing to replay and stays hidden.
function setupReplay() {
  const button = $('replay');
  const burst = $('boom-burst');
  if (!button || !burst) return;
  if (prefersReducedMotion()) {
    button.hidden = true;
    return;
  }
  // Presses during a pop are ignored instead of disabling the button, so keyboard focus stays put.
  let popping = false;
  button.addEventListener('click', () => {
    if (popping) return;
    popping = true;
    burst.classList.remove('is-popping');
    void burst.offsetWidth; // restart the animation
    burst.classList.add('is-popping');
    setTimeout(() => { popping = false; }, POP_MS);
  });
}

render();
setupReplay();
