// Blip teaser interstitial: a comic panel with the countdown in a burst, a segmented progress bar,
// the trivia / brand / countdown narration box, Go now + Cancel/Continue, then
// location.replace(targetUrl). Data comes from the #blip-data JSON block.
import { el, hostOf, prefersReducedMotion, setIcon } from './api.js';

const STYLES = ['countdown', 'trivia', 'brand'];
const THEMES = ['hero', 'caption', 'noir', 'sky', 'paper'];
// Links created before the comic redesign may still carry the old theme ids.
const LEGACY_THEMES = { aurora: 'hero', sunset: 'caption', ocean: 'sky', neon: 'noir', candy: 'paper' };
const MAX_SEGMENTS = 15;
const QUIPS = [
  'Warming up the engines...',
  'Polishing the pixels on the other side...',
  'Untangling the internet tubes...',
  'Rolling out the red carpet...',
  'Buckling up for a tiny trip...',
  'Checking the map one last time...',
  'Teaching the hamsters to run faster...',
];

function readData() {
  const node = document.getElementById('blip-data');
  try {
    const parsed = JSON.parse(node?.textContent || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const $ = (id) => document.getElementById(id);

/** New theme id for anything the server or an older link might send; unknown values fall back to hero. */
function resolveTheme(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (THEMES.includes(id)) return id;
  return LEGACY_THEMES[id] || 'hero';
}

const data = readData();
const targetUrl = typeof data.targetUrl === 'string' ? data.targetUrl.trim() : '';
const isSafeTarget = /^https?:\/\//i.test(targetUrl);
const targetHost = (typeof data.targetHost === 'string' && data.targetHost.trim()) || (isSafeTarget ? hostOf(targetUrl) : '');
const totalSeconds = clamp(Math.round(Number(data.seconds)) || 5, 1, 60);
const totalMs = totalSeconds * 1000;
const reducedMotion = prefersReducedMotion();

document.body.dataset.theme = resolveTheme(document.body.dataset.theme || data.theme);

const els = {
  card: $('teaser-card'),
  burst: $('countdown'),
  num: $('count-num'),
  unit: $('count-unit'),
  pausedTag: $('paused-tag'),
  bar: $('countdown-bar'),
  host: $('target-host'),
  linkTitle: $('link-title'),
  url: $('target-url'),
  noteTrivia: $('note-trivia'),
  triviaText: $('trivia-text'),
  noteBrand: $('note-brand'),
  brandText: $('brand-text'),
  noteCountdown: $('note-countdown'),
  quipText: $('quip-text'),
  go: $('go-now'),
  cancel: $('cancel'),
  cancelIcon: $('cancel-icon'),
  cancelLabel: $('cancel-label'),
  status: $('teaser-status'),
};

// ---------------------------------------------------------------------------
// Static content
// ---------------------------------------------------------------------------
function factText(fact) {
  if (typeof fact === 'string') return fact.trim();
  if (fact && typeof fact === 'object') {
    const value = fact.text ?? fact.fact ?? '';
    return typeof value === 'string' ? value.trim() : '';
  }
  return '';
}

function renderContent() {
  els.host.textContent = targetHost || 'your destination';
  // A real hostname reads in the URL face; Bangers only has capitals.
  els.host.classList.toggle('teaser-host--url', Boolean(targetHost));

  const title = typeof data.title === 'string' ? data.title.trim() : '';
  if (title) {
    els.linkTitle.textContent = title;
    els.linkTitle.hidden = false;
  }

  if (isSafeTarget) {
    els.url.textContent = targetUrl;
    els.url.title = targetUrl;
  } else {
    els.url.hidden = true;
  }

  const requested = STYLES.includes(data.style) ? data.style : 'countdown';
  const fact = factText(data.fact);
  const message = typeof data.message === 'string' ? data.message.trim() : '';
  let style = 'countdown';

  if (requested === 'trivia' && fact) {
    els.triviaText.textContent = fact;
    els.noteTrivia.hidden = false;
    style = 'trivia';
  } else if (requested === 'brand' && message) {
    els.brandText.textContent = message;
    els.noteBrand.hidden = false;
    style = 'brand';
  } else {
    els.quipText.textContent = QUIPS[Math.floor(Math.random() * QUIPS.length)];
    els.noteCountdown.hidden = false;
  }
  els.card.dataset.style = style;
}

function setStatus(text, { error = false } = {}) {
  els.status.textContent = text;
  els.status.classList.toggle('is-error', error);
}

// ---------------------------------------------------------------------------
// Segmented progress bar (decorative; the burst is the accessible timer)
// ---------------------------------------------------------------------------
const segmentCount = Math.min(totalSeconds, MAX_SEGMENTS);
const segments = Array.from({ length: segmentCount }, () => {
  const fill = el('span', { class: 'countdown-bar__fill' });
  els.bar.append(el('span', { class: 'countdown-bar__seg' }, fill));
  return { fill, value: 0 };
});

function renderBar(elapsedFraction) {
  const scaled = clamp(elapsedFraction, 0, 1) * segmentCount;
  for (let i = 0; i < segments.length; i += 1) {
    const value = Math.round(clamp(scaled - i, 0, 1) * 1000) / 1000;
    if (value !== segments[i].value) {
      segments[i].value = value;
      segments[i].fill.style.transform = `scaleX(${value})`;
    }
  }
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------
let remainingMs = totalMs;
let running = false;
let navigating = false;
let autoPaused = false;
let startedAt = 0;
let startRemaining = totalMs;
let rafId = 0;
let timeoutId = 0;
let lastSecond = null;

function renderCountdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  // Reduced motion: the bar moves in whole-second steps instead of draining smoothly.
  renderBar(reducedMotion ? (totalSeconds - seconds) / totalSeconds : 1 - ms / totalMs);

  if (seconds !== lastSecond) {
    lastSecond = seconds;
    els.num.textContent = String(seconds);
    els.unit.textContent = seconds === 1 ? 'second' : 'seconds';
    if (!reducedMotion) {
      els.burst.classList.remove('is-tick');
      void els.burst.offsetWidth; // restart the pop animation
      els.burst.classList.add('is-tick');
    }
  }
}

function setPausedLook(paused) {
  els.burst.classList.toggle('is-paused', paused);
  els.pausedTag.hidden = !paused;
}

function clearTimers() {
  cancelAnimationFrame(rafId);
  clearTimeout(timeoutId);
  rafId = 0;
  timeoutId = 0;
}

function currentRemaining() {
  return Math.max(0, startRemaining - (performance.now() - startedAt));
}

function frame() {
  if (!running) return;
  remainingMs = currentRemaining();
  renderCountdown(remainingMs);
  if (remainingMs <= 0) {
    go();
    return;
  }
  rafId = requestAnimationFrame(frame);
}

function start() {
  if (running || navigating || !isSafeTarget) return;
  running = true;
  startedAt = performance.now();
  startRemaining = remainingMs;
  setPausedLook(false);
  // The timeout guarantees the redirect even if animation frames are throttled.
  timeoutId = setTimeout(go, remainingMs);
  rafId = requestAnimationFrame(frame);
}

function stop() {
  if (!running) return;
  remainingMs = currentRemaining();
  running = false;
  clearTimers();
  renderCountdown(remainingMs);
  setPausedLook(true);
}

function setPausedUi(paused) {
  els.cancel.dataset.paused = paused ? 'true' : 'false';
  els.cancelLabel.textContent = paused ? 'Continue' : 'Cancel';
  setIcon(els.cancelIcon, paused ? 'play' : 'x');
}

function go() {
  if (navigating) return;
  if (!isSafeTarget) {
    showUnsafe();
    return;
  }
  navigating = true;
  running = false;
  clearTimers();
  remainingMs = 0;
  renderCountdown(0);
  setPausedLook(false);
  els.num.textContent = 'Go!';
  els.unit.hidden = true;
  els.go.disabled = true;
  els.cancel.disabled = true;
  setStatus(`Opening ${targetHost}...`);
  window.location.replace(targetUrl);

  // If the browser stays here (e.g. the destination is a download), let the visitor retry.
  setTimeout(() => {
    navigating = false;
    els.go.disabled = false;
    setStatus('Still here? Press Go now to try again.');
  }, 6000);
}

function showUnsafe() {
  running = false;
  clearTimers();
  setPausedLook(true);
  els.pausedTag.hidden = true;
  els.go.disabled = true;
  els.cancel.hidden = true;
  setStatus("This link's destination isn't a regular web address, so Blip won't open it.", { error: true });
}

function toggleCancel() {
  if (navigating) return;
  // While auto-paused (tab hidden) the button still reads "Cancel", so treat a press as cancel too.
  // Otherwise it would start the countdown it claims to stop.
  if (running || autoPaused) {
    stop();
    autoPaused = false;
    setPausedLook(true);
    setPausedUi(true);
    setStatus('Countdown stopped. Take your time, then press Continue or Go now when you are ready.');
  } else {
    setPausedUi(false);
    start();
    setStatus(`Countdown resumed. Heading to ${targetHost} shortly.`);
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
renderContent();
renderCountdown(remainingMs);
setPausedUi(false);

els.go.addEventListener('click', go);
els.cancel.addEventListener('click', toggleCancel);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && running) {
    event.preventDefault();
    toggleCancel();
  }
});

// Background tabs (e.g. middle-clicked links) pause until the teaser is actually seen.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) {
    stop();
    autoPaused = true;
  } else if (!document.hidden && autoPaused) {
    autoPaused = false;
    start();
  }
});

if (isSafeTarget) {
  setStatus(`Redirecting to ${targetHost} in ${totalSeconds} ${totalSeconds === 1 ? 'second' : 'seconds'}. Press Cancel or Escape to stop.`);
  if (document.hidden) autoPaused = true;
  else start();
} else {
  showUnsafe();
}
