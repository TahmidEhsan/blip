// Blip home page: "Self-destruct" feature (presets, custom date / click limit, human summary).

import { formatDateTime, formatNumber } from '../api.js';
import { state, emitChange, FieldError } from './state.js';
import { byId, radioGroup, setFieldError } from './dom.js';
import { plural } from './format.js';

const HOUR = 3600;
// `state` is the short tag on the feature tile, `chip` the summary chip under the URL box.
const PRESETS = {
  never: { chip: null, state: 'Never' },
  click1: { maxClicks: 1, chip: '1 click', state: '1 click' },
  click10: { maxClicks: 10, chip: '10 clicks', state: '10 clicks' },
  hour1: { expiresInSeconds: HOUR, chip: '1 hour', state: '1 hour' },
  day1: { expiresInSeconds: 24 * HOUR, chip: '24 hours', state: '24 hours' },
  week1: { expiresInSeconds: 7 * 24 * HOUR, chip: '7 days', state: '7 days' },
};
const MIN_LEAD_MS = 60_000;
const MAX_AHEAD_MS = 157_680_000 * 1000; // 5 x 365 days, the server's ceiling

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const shortTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const shortDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function createDestructFeature() {
  const custom = byId('destructCustom');
  const at = byId('destructAt');
  const atError = byId('destructAtError');
  const clicks = byId('destructClicks');
  const clicksError = byId('destructClicksError');
  const summary = byId('destructSummary');
  const summaryBox = byId('destructSummaryBox');
  let refreshTimer = 0;

  const group = radioGroup(byId('destructPresets'), {
    onChange: (value) => {
      if (value === 'custom') openCustom();
      else custom.hidden = true;
      clearErrors();
      render();
      emitChange('destruct');
    },
  });

  const preset = () => group.value || 'never';
  const maxClicksLimit = () => state.config.limits.maxClicksMax;

  function parseAt() {
    if (!at.value) return null;
    const ms = new Date(at.value).getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }

  function parseClicks() {
    const raw = clicks.value.trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : NaN;
  }

  function openCustom() {
    custom.hidden = false;
    const now = Date.now();
    at.min = toLocalInput(new Date(now + 2 * 60_000));
    at.max = toLocalInput(new Date(now + MAX_AHEAD_MS - 24 * HOUR * 1000));
    clicks.max = String(maxClicksLimit());
    if (!at.value && !clicks.value) {
      const tomorrow = new Date(now + 24 * HOUR * 1000);
      tomorrow.setMinutes(0, 0, 0);
      tomorrow.setHours(tomorrow.getHours() + 1);
      at.value = toLocalInput(tomorrow);
    }
  }

  function clearErrors() {
    setFieldError(at, atError, '');
    setFieldError(clicks, clicksError, '');
  }

  function customParts() {
    const atMs = parseAt();
    const n = parseClicks();
    return {
      atMs: Number.isFinite(atMs) ? atMs : null,
      n: Number.isInteger(n) && n > 0 ? n : null,
    };
  }

  function describe() {
    const now = Date.now();
    switch (preset()) {
      case 'click1': return 'Burn after reading: it self-destructs right after the first visit.';
      case 'click10': return 'Vanishes after 10 clicks. The eleventh visitor finds a pile of smoking pixels.';
      case 'hour1': return `Vanishes in 1 hour, around ${shortTime(now + HOUR * 1000)}.`;
      case 'day1': return `Vanishes in 24 hours, on ${formatDateTime(now + 24 * HOUR * 1000)}.`;
      case 'week1': return `Vanishes in 7 days, on ${formatDateTime(now + 7 * 24 * HOUR * 1000)}.`;
      case 'custom': {
        const { atMs, n } = customParts();
        if (atMs && n) return `Vanishes after ${plural(n, 'click')} or on ${formatDateTime(atMs)}, whichever comes first.`;
        if (atMs) return `Vanishes on ${formatDateTime(atMs)}.`;
        if (n) return `Vanishes after ${plural(n, 'click')}.`;
        return 'Pick a date, a click limit, or both.';
      }
      default: return 'Lives forever, or until you hit Destroy now.';
    }
  }

  function render() {
    // A polite live region refreshed every 30 s: only touch it when the words actually change.
    const text = describe();
    if (summary.textContent !== text) summary.textContent = text;
    summaryBox.dataset.armed = String(isActive());
  }

  function isActive() {
    if (preset() === 'never') return false;
    if (preset() !== 'custom') return true;
    const { atMs, n } = customParts();
    return Boolean(atMs || n);
  }

  function chipText() {
    const p = preset();
    if (p === 'never') return null;
    if (p !== 'custom') return PRESETS[p].chip;
    const { atMs, n } = customParts();
    const parts = [];
    if (n) parts.push(plural(n, 'click'));
    if (atMs) parts.push(shortDate(atMs));
    return parts.length ? parts.join(' · ') : null;
  }

  at.addEventListener('input', () => {
    setFieldError(at, atError, '');
    render();
    emitChange('destruct');
  });
  clicks.addEventListener('input', () => {
    setFieldError(clicks, clicksError, '');
    render();
    emitChange('destruct');
  });

  render();

  return {
    id: 'destruct',
    label: 'self-destruct',
    isActive,
    chip: () => {
      const text = chipText();
      if (!text) return null;
      return { icon: preset().startsWith('click') || (preset() === 'custom' && !customParts().atMs) ? 'flame' : 'timer', text };
    },
    stateText: () => (preset() === 'custom' ? chipText() || 'Custom' : PRESETS[preset()].state),
    onToggle(open) {
      clearInterval(refreshTimer);
      if (open) {
        render();
        refreshTimer = setInterval(render, 30_000);
      }
    },
    apply(body) {
      const p = preset();
      if (p === 'never') return;
      if (p !== 'custom') {
        const { maxClicks, expiresInSeconds } = PRESETS[p];
        if (maxClicks) body.maxClicks = maxClicks;
        if (expiresInSeconds) body.expiresInSeconds = expiresInSeconds;
        return;
      }
      const atMs = parseAt();
      const n = parseClicks();
      if (atMs === null && n === null) throw new FieldError('expiresAt', 'Set a date, a click limit, or both. Or choose Never.');
      if (atMs !== null) {
        if (!Number.isFinite(atMs)) throw new FieldError('expiresAt', 'That date doesn’t look right. Pick one from the calendar.');
        if (atMs < Date.now() + MIN_LEAD_MS) throw new FieldError('expiresAt', 'Pick a time at least a minute from now.');
        if (atMs > Date.now() + MAX_AHEAD_MS) throw new FieldError('expiresAt', 'That is a bit far away. Keep it within 5 years.');
        body.expiresAt = new Date(atMs).toISOString();
      }
      if (n !== null) {
        const max = maxClicksLimit();
        if (!Number.isInteger(n) || n < 1 || n > max) throw new FieldError('maxClicks', `Use a whole number from 1 to ${formatNumber(max)}.`);
        body.maxClicks = n;
      }
    },
    showError(field, message) {
      const p = preset();
      if (p !== 'custom') {
        // A preset was rejected: carry its values into the custom fields so the user can adjust them.
        const def = PRESETS[p] || {};
        at.value = def.expiresInSeconds ? toLocalInput(new Date(Date.now() + def.expiresInSeconds * 1000)) : '';
        clicks.value = def.maxClicks ? String(def.maxClicks) : '';
        group.set('custom');
        openCustom();
      }
      const control = field === 'maxClicks' ? clicks : at;
      const errorEl = field === 'maxClicks' ? clicksError : atError;
      setFieldError(control, errorEl, message);
      control.focus();
      render();
    },
    reset() {
      group.set('never');
      custom.hidden = true;
      at.value = '';
      clicks.value = '';
      clearErrors();
      render();
      emitChange('destruct');
    },
  };
}
