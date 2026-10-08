// Blip home page: shared presentation helpers for LinkDTOs (badges, countdowns, wording).

import { el, formatNumber, formatDuration, formatDateTime } from '../api.js';
import { canonicalTheme } from './state.js';

export const displayUrl = (url) => String(url ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

export const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

const STYLE_WORDS = { countdown: 'countdown', trivia: 'trivia', brand: 'brand message' };
export const teaserStyleWord = (style) => STYLE_WORDS[style] || style;

const THEME_NAMES = { hero: 'Hero', caption: 'Caption', noir: 'Noir', sky: 'Sky', paper: 'Paper' };
/** Display name for a teaser theme id, including ids from the first release ("aurora" reads as "Hero"). */
export const themeWord = (theme) => THEME_NAMES[canonicalTheme(theme)];

/** The URL that really works today for this link (branded if live, else the working one). */
export const usableUrl = (link) => (link.domainLive ? link.shortUrl : link.workingUrl);

export function statusBadge(link) {
  if (link.status === 'active') {
    return el('span', { class: 'badge badge--active' }, 'Active');
  }
  if (link.status === 'destroyed') {
    return el('span', { class: 'badge badge--destroyed', title: 'Destroyed by its owner' }, 'Destroyed');
  }
  const title = link.expiredReason === 'clicks' ? 'All of its clicks are used up' : 'Its timer ran out';
  return el('span', { class: 'badge badge--expired', title }, link.expiredReason === 'clicks' ? 'Burned' : 'Expired');
}

/**
 * Live-updating "Vanishes in 2h 3m" element; ticked by tickCountdowns().
 * It opts out of live regions explicitly (not just via role="timer"), so a screen reader
 * never reads the ticking value aloud, whatever container it ends up in.
 */
export function countdownEl(expiresAt, prefix = 'Vanishes in ') {
  const node = el('span', { class: 'countdown', role: 'timer', 'aria-live': 'off', dataset: { expiresAt } },
    prefix, el('span', { class: 'countdown__value' }, ''));
  updateCountdown(node, Date.now());
  return node;
}

function updateCountdown(node, now) {
  const ms = new Date(node.dataset.expiresAt).getTime() - now;
  const value = node.querySelector('.countdown__value');
  if (value) value.textContent = formatDuration(ms);
  node.classList.toggle('is-urgent', ms > 0 && ms < 3600_000);
  if (ms <= 0 && node.isConnected && !node.classList.contains('is-done')) {
    node.classList.add('is-done');
    node.dispatchEvent(new CustomEvent('blip:countdown-done', { bubbles: true, detail: { expiresAt: node.dataset.expiresAt } }));
  }
}

export function tickCountdowns() {
  const now = Date.now();
  for (const node of document.querySelectorAll('.countdown[data-expires-at]')) updateCountdown(node, now);
}

let tickerStarted = false;
export function startCountdownTicker() {
  if (tickerStarted) return;
  tickerStarted = true;
  setInterval(tickCountdowns, 1000);
}

/** One-line description of how and when a link expires. */
export function expiryWords(link) {
  if (link.status === 'destroyed') return 'Destroyed by its owner';
  if (link.status === 'expired') {
    if (link.expiredReason === 'clicks') return `Used up all ${plural(link.maxClicks ?? link.clickCount, 'click')}`;
    return link.expiresAt ? `Expired ${formatDateTime(link.expiresAt)}` : 'Expired';
  }
  return null;
}

export function clicksWords(link) {
  const total = plural(link.clickCount ?? 0, 'click');
  if (link.maxClicks === null || link.maxClicks === undefined) return total;
  return `${total} · ${formatNumber(link.clicksRemaining ?? 0)} of ${formatNumber(link.maxClicks)} left`;
}
