// Blip: the shared "Edit settings" dialog for one link (destination, title, domain, teaser page, self-destruct
// rules), which also brings expired and destroyed links back. One <dialog class="modal edit-dialog"> per page,
// built on first use, so pages need no extra markup. Styles: /assets/css/edit-settings.css.
//
//   import { openEditSettings } from '/assets/js/edit-settings.js';
//   const saved = await openEditSettings(link, token, { config, focus: 'destruct', onSaved: (l) => render(l) });
//
// Resolves to the saved LinkDTO, or null when the dialog closes without saving anything. A save sends one
// PATCH /api/links/:slug with only the changed fields (SPEC 5.2), then POST /revive when "Undo Destroy now"
// is ticked. onSaved(link) runs after each request that succeeds. The caller confirms a finished save with
// announceSaved(before, after) (the dialog itself only toasts "Nothing to save"). A page with a live feed
// (the dashboard) passes fresh click and status counts with syncEditSettingsLink(link) while the dialog is open.

import { api, el, icon, toast, formatDateTime, formatNumber } from './api.js';

const SECTIONS = ['general', 'domain', 'teaser', 'destruct'];
/** Groups of controls tracked separately, so a background refresh never overwrites what the user edited. */
const GROUPS = ['target', 'title', 'domain', 'teaser', 'time', 'clicks', 'revive'];

const STYLES = [
  { value: 'countdown', label: 'Countdown', icon: 'hourglass', word: 'countdown' },
  { value: 'trivia', label: 'Trivia', icon: 'circle-question-mark', word: 'trivia' },
  { value: 'brand', label: 'Brand message', icon: 'megaphone', word: 'brand message' },
];
const THEMES = [
  { value: 'hero', label: 'Hero' },
  { value: 'caption', label: 'Caption' },
  { value: 'noir', label: 'Noir' },
  { value: 'sky', label: 'Sky' },
  { value: 'paper', label: 'Paper' },
];
const TIME_CHOICES = [
  { value: 'keep', label: 'Keep current' },
  { value: 'none', label: 'No time limit' },
  { value: 'hour', label: '1 hour', seconds: 3600 },
  { value: 'day', label: '24 hours', seconds: 86_400 },
  { value: 'week', label: '7 days', seconds: 604_800 },
  { value: 'custom', label: 'Custom date' },
];
const CLICK_CHOICES = [
  { value: 'keep', label: 'Keep current' },
  { value: 'none', label: 'No click limit' },
  { value: 'more', label: 'Allow more clicks' },
];
const DEFAULT_MORE_CLICKS = 10;
const MAX_EXPIRY_MS = 157_680_000 * 1000; // 5 years, the server's limit
const FALLBACK_LIMITS = { titleMax: 120, messageMax: 280, maxClicksMax: 1_000_000, urlMax: 2048 };
const FALLBACK_TEASER = { minSeconds: 3, maxSeconds: 15, defaultSeconds: 5 };
const VANITY_TIP = "Point this domain's DNS at your Blip server to make it live.";
/** API error codes that belong to a field even when the reply names none. */
const CODE_FIELDS = { invalid_url: 'targetUrl', unsupported_protocol: 'targetUrl', redirect_loop: 'targetUrl', too_long: 'targetUrl' };

const ID = (name) => `editSettings-${name}`;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;
const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
/** "all 10 clicks", or "its only click" for a one-click limit. */
const allClicks = (n) => (n === 1 ? 'its only click' : `all ${plural(n, 'click')}`);
const cleanTitle = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const cleanMessage = (value) => String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

class FieldError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'FieldError';
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Config (/api/config): passed in by the page, or fetched once and cached here
// ---------------------------------------------------------------------------
let configCache = null;
let configRequest = null;

function normalizeConfig(raw) {
  if (!isObject(raw)) return null;
  const baseHost = typeof raw.baseHost === 'string' && raw.baseHost ? raw.baseHost : window.location.host;
  const domains = (Array.isArray(raw.domains) ? raw.domains : [])
    .filter((d) => isObject(d) && typeof d.domain === 'string' && d.domain)
    .map((d) => ({ domain: d.domain, live: Boolean(d.live), isBase: Boolean(d.isBase) || d.domain === baseHost }));
  if (!domains.some((d) => d.domain === baseHost)) domains.unshift({ domain: baseHost, live: true, isBase: true });
  return {
    baseHost,
    domains,
    limits: { ...FALLBACK_LIMITS, ...(isObject(raw.limits) ? raw.limits : {}) },
    teaser: { ...FALLBACK_TEASER, ...(isObject(raw.teaser) ? raw.teaser : {}) },
  };
}

function fetchConfig() {
  if (configCache) return Promise.resolve(configCache);
  if (!configRequest) {
    configRequest = api.config()
      .then((raw) => {
        const config = normalizeConfig(raw);
        if (!config) throw new Error('Unexpected config reply');
        configCache = config;
        return config;
      })
      .finally(() => { configRequest = null; });
  }
  return configRequest;
}

const limitsOf = (s) => s?.config?.limits ?? FALLBACK_LIMITS;
const teaserLimitsOf = (s) => s?.config?.teaser ?? FALLBACK_TEASER;

// ---------------------------------------------------------------------------
// URL rules (client-side mirror of SPEC 4.2; the server stays authoritative)
// ---------------------------------------------------------------------------
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i;

function withScheme(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (SCHEME.test(value) && !HOST_PORT.test(value)) return value;
  return `https://${value}`;
}

function checkTargetUrl(raw, { ownHosts, maxLength }) {
  const value = String(raw ?? '').trim();
  const tooLong = `That link is too long. Keep it under ${formatNumber(maxLength)} characters.`;
  if (!value) return { ok: false, message: 'Add the destination people should land on.' };
  if (value.length > maxLength) return { ok: false, message: tooLong };
  let url;
  try {
    url = new URL(withScheme(value));
  } catch {
    return { ok: false, message: "That doesn't look like a link. Try something like example.com/page." };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, message: 'Only http:// and https:// links can be shortened.' };
  if (url.username || url.password) return { ok: false, message: "Links with a username or password inside can't be shortened." };
  if (!(url.hostname.includes('.') || url.hostname === 'localhost')) {
    return { ok: false, message: "That doesn't look like a full web address. Did you mean something like example.com?" };
  }
  if (ownHosts.includes(url.host.toLowerCase())) return { ok: false, message: "That's already a Blip link. No infinite loops, please!" };
  if (url.href.length > maxLength) return { ok: false, message: tooLong };
  return { ok: true, url: url.href };
}

function ownHostsOf(s) {
  const hosts = new Set([window.location.host.toLowerCase()]);
  if (s.config) {
    hosts.add(s.config.baseHost.toLowerCase());
    for (const d of s.config.domains) hosts.add(d.domain.toLowerCase());
  }
  if (s.link?.domain) hosts.add(String(s.link.domain).toLowerCase());
  return [...hosts];
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------
function statusBadge(status, reason) {
  if (status === 'active') return el('span', { class: 'badge badge--active' }, 'Active');
  if (status === 'destroyed') return el('span', { class: 'badge badge--destroyed', title: 'Destroyed by its owner' }, 'Destroyed');
  return reason === 'clicks'
    ? el('span', { class: 'badge badge--expired', title: 'All of its clicks are used up' }, 'Burned')
    : el('span', { class: 'badge badge--expired', title: 'Its timer ran out' }, 'Expired');
}

const timeIsUp = (link, now = Date.now()) => Boolean(link.expiresAt) && Date.parse(link.expiresAt) <= now;
const clicksAreUp = (link) => link.maxClicks !== null && link.maxClicks !== undefined && (link.clickCount ?? 0) >= link.maxClicks;

/** "8 of 10 clicks used, no time limit": the link's self-destruct rule as it stands. */
function ruleText(link) {
  const used = link.clickCount ?? 0;
  const hasLimit = link.maxClicks !== null && link.maxClicks !== undefined;
  let time = 'no time limit';
  if (link.expiresAt) time = timeIsUp(link) ? `timer ended ${formatDateTime(link.expiresAt)}` : `vanishes ${formatDateTime(link.expiresAt)}`;
  if (!hasLimit && !link.expiresAt) return used ? `${plural(used, 'click')} so far, no time or click limit` : 'No time or click limit';
  const clicks = hasLimit
    ? `${formatNumber(used)} of ${plural(link.maxClicks, 'click')} used`
    : `${used ? `${plural(used, 'click')} so far, ` : ''}no click limit`;
  return capitalize(`${clicks}, ${time}`);
}

/** Why an expired or destroyed link is down, and what brings it back. */
function noticeCopy(link) {
  if (link.status === 'destroyed') {
    const timeUp = timeIsUp(link);
    const clicksUp = clicksAreUp(link);
    let also = '';
    if (timeUp && clicksUp) also = ' Its timer and its clicks have run out too, so give it more time and clicks as well.';
    else if (timeUp) also = ' Its timer has run out too, so give it more time as well.';
    else if (clicksUp) also = ` It has used ${allClicks(link.maxClicks)} too, so give it more clicks as well.`;
    return {
      kicker: 'Destroyed',
      icon: 'bomb',
      text: `Its owner hit Destroy now, so visitors see the self-destructed page. Save with Undo Destroy now switched on to bring it back.${also}`,
    };
  }
  let timeUp = timeIsUp(link);
  let clicksUp = clicksAreUp(link);
  if (!timeUp && !clicksUp) {
    // This device's clock disagrees with the server's: trust the server's reason.
    timeUp = link.expiredReason !== 'clicks';
    clicksUp = link.expiredReason === 'clicks';
  }
  const reasons = [];
  if (timeUp) reasons.push(link.expiresAt ? `time ran out on ${formatDateTime(link.expiresAt)}` : 'its time ran out');
  if (clicksUp) reasons.push(`it used ${allClicks(link.maxClicks ?? link.clickCount ?? 0)}`);
  const what = timeUp && clicksUp ? 'more time and clicks' : timeUp ? 'more time' : 'more clicks';
  return {
    kicker: link.expiredReason === 'clicks' ? 'Burned' : 'Expired',
    icon: 'clock-alert',
    text: `${capitalize(reasons.join(' and '))}, so visitors see the self-destructed page. Give it ${what} below to bring it back.`,
  };
}

function friendlyError(err, fallback = "Couldn't save your changes. Please try again.") {
  if (!err) return fallback;
  if (err.code === 'network') return "Can't reach Blip right now. Check your connection and try again.";
  if (err.status === 404) return "This link doesn't exist any more, so there's nothing left to change.";
  if (err.status === 401 || err.status === 403) return "This browser's key for this link was rejected, so it can't change its settings.";
  if (err.status === 429) return err.message && !/^Request failed/.test(err.message) ? err.message : 'Whoa, speedy! Give it a few seconds and try again.';
  if (err.status >= 500) return 'Blip hiccuped on the server side. Please try again in a moment.';
  if (err.message && !/^Request failed/.test(err.message)) return err.message;
  return fallback;
}

/** datetime-local value ("2026-10-09T14:05") for an epoch ms, in this device's time zone. */
function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Suggested custom date: the current timer if it is still ahead, otherwise this time tomorrow. */
function suggestedCustomMs(link) {
  const at = link.expiresAt ? Date.parse(link.expiresAt) : NaN;
  if (Number.isFinite(at) && at > Date.now() + 60_000) return at;
  const next = Date.now() + 86_400_000;
  return Math.ceil(next / 300_000) * 300_000;
}

// ---------------------------------------------------------------------------
// Accessible single-choice group (buttons with role="radio", roving tabindex, arrow keys)
// ---------------------------------------------------------------------------
function radioGroup(container, onSelect) {
  const items = () => [...container.querySelectorAll('[role="radio"]')];
  const checkedItem = () => items().find((it) => it.getAttribute('aria-checked') === 'true') ?? null;

  function select(item, { focus = false, emit = true } = {}) {
    for (const it of items()) {
      const on = it === item;
      it.setAttribute('aria-checked', String(on));
      it.tabIndex = on ? 0 : -1;
    }
    if (focus) item.focus();
    if (emit) onSelect?.(item.dataset.value);
  }

  container.addEventListener('click', (event) => {
    const item = event.target.closest('[role="radio"]');
    if (item && container.contains(item) && !item.disabled) select(item);
  });
  container.addEventListener('keydown', (event) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const list = items().filter((it) => !it.disabled);
    const current = list.indexOf(document.activeElement);
    if (current === -1) return;
    event.preventDefault();
    let next = current;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % list.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + list.length) % list.length;
    else if (event.key === 'Home') next = 0;
    else next = list.length - 1;
    select(list[next], { focus: true });
  });

  return {
    get value() { return checkedItem()?.dataset.value ?? null; },
    checkedItem,
    /** Select by value without firing onSelect. */
    set(value) {
      const item = items().find((it) => it.dataset.value === value);
      if (item) select(item, { emit: false });
      else this.refresh();
    },
    /** Re-apply the roving tabindex after the items were re-rendered. */
    refresh() {
      const list = items();
      const on = checkedItem() || list[0];
      for (const it of list) it.tabIndex = it === on ? 0 : -1;
    },
  };
}

// ---------------------------------------------------------------------------
// The dialog (built once per page)
// ---------------------------------------------------------------------------
let ui = null;
/** The open editing session: { link, token, config, configState, onSaved, resolve, saved, touched, saving, domain, customPrefill, opener }. */
let session = null;

function errorText(name) {
  return el('p', { class: 'error-text edit-error', id: ID(`${name}-error`), hidden: true });
}

function section(name, title, iconName, ...children) {
  return el('section', { class: 'edit-section', id: ID(`section-${name}`), 'aria-labelledby': ID(`heading-${name}`), dataset: { section: name } },
    el('div', { class: 'edit-section__head' },
      el('span', { class: 'edit-section__icon', 'aria-hidden': 'true' }, icon(iconName)),
      el('h3', { class: 'edit-section__title', id: ID(`heading-${name}`), tabindex: '-1' }, title)),
    ...children);
}

function segmented(name, choices, describedBy) {
  return el('div', {
    class: 'segmented edit-seg',
    id: ID(name),
    role: 'radiogroup',
    'aria-labelledby': ID(`${name}-label`),
    'aria-describedby': describedBy,
  }, ...choices.map((c) => el('button', { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', dataset: { value: c.value } },
    c.icon ? icon(c.icon, { class: 'icon icon--sm' }) : null, c.label)));
}

function switchControl(input, text) {
  return el('label', { class: 'switch edit-switch' }, input, el('span', { class: 'switch__track', 'aria-hidden': 'true' }), el('span', {}, text));
}

function build() {
  const r = {};

  // ---- header: title, status, close, and (for a stopped link) why it stopped. The header never scrolls
  // (except on short screens, see edit-settings.css), so the reason stays in view whichever section the dialog
  // opens at. The reason is also the dialog's accessible description (renderLinkState), so it is read on open. ----
  r.noticeIcon = el('span', { class: 'edit-notice__icon', 'aria-hidden': 'true' });
  r.noticeKicker = el('span', {});
  r.noticeText = el('span', {});
  r.noticeBtn = el('button', {
    type: 'button',
    class: 'btn btn--sm edit-notice__btn',
    on: { click: () => focusSection('destruct') },
  }, icon('arrow-down'), 'Show me');
  r.notice = el('div', { class: 'edit-notice', hidden: true },
    el('p', { class: 'edit-notice__text', id: ID('notice') }, el('span', { class: 'edit-notice__kicker' }, r.noticeIcon, r.noticeKicker), ' ', r.noticeText),
    r.noticeBtn);

  r.slug = el('span', { class: 'edit-slug' });
  r.badge = el('span', { class: 'edit-head__badge' });
  r.closeBtn = el('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm btn--icon edit-head__close',
    'aria-label': 'Close without saving',
    title: 'Close without saving',
    on: { click: () => requestClose() },
  }, icon('x'));
  const head = el('header', { class: 'edit-head' },
    el('div', { class: 'edit-head__row' },
      el('div', { class: 'edit-head__text' },
        el('h2', { class: 'edit-head__title', id: ID('title') }, 'Edit settings ', r.slug),
        r.badge),
      r.closeBtn),
    r.notice);

  // ---- alert: save problems that belong to no single field ----
  r.alertText = el('p', { class: 'edit-alert__text' });
  r.alert = el('div', { class: 'edit-alert', role: 'alert', hidden: true },
    el('span', { class: 'edit-alert__icon', 'aria-hidden': 'true' }, icon('triangle-alert')), r.alertText);

  // ---- General ----
  r.target = el('input', {
    class: 'input edit-input--mono',
    id: ID('target'),
    type: 'text',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'aria-required': 'true',
    'aria-describedby': `${ID('target-hint')} ${ID('target-error')}`,
  });
  r.targetError = errorText('target');
  r.title = el('input', {
    class: 'input',
    id: ID('name'),
    type: 'text',
    autocomplete: 'off',
    placeholder: 'Summer sale landing page',
    'aria-describedby': `${ID('name-hint')} ${ID('name-error')}`,
  });
  r.titleCount = el('span', { class: 'edit-counter' });
  r.titleError = errorText('name');
  const general = section('general', 'General', 'link',
    el('div', { class: 'field' },
      el('label', { class: 'label', for: ID('target') }, 'Destination URL'),
      r.target,
      el('p', { class: 'hint', id: ID('target-hint') }, 'Where visitors end up. We add https:// if you leave it off.'),
      r.targetError),
    el('div', { class: 'field' },
      el('div', { class: 'edit-field-row' },
        el('label', { class: 'label', for: ID('name') }, 'Title ', el('span', { class: 'edit-optional' }, '(optional)')),
        r.titleCount),
      r.title,
      el('p', { class: 'hint', id: ID('name-hint') }, 'Shown on teaser pages and in My links.'),
      r.titleError));

  // ---- Domain ----
  r.domains = el('div', {
    class: 'chip-group edit-chips',
    id: ID('domains'),
    role: 'radiogroup',
    'aria-labelledby': ID('domains-label'),
    'aria-describedby': `${ID('domain-note')} ${ID('domains-error')}`,
  });
  r.domainNote = el('p', { class: 'hint', id: ID('domain-note') });
  r.domainError = errorText('domains');
  r.domainRetry = el('button', { type: 'button', class: 'btn btn--sm', on: { click: () => session && loadConfigFor(session) } }, icon('refresh-cw'), 'Retry');
  r.domainProblem = el('div', { class: 'edit-problem', hidden: true },
    el('span', { class: 'edit-problem__icon', 'aria-hidden': 'true' }, icon('cloud-off')),
    el('p', {}, "We couldn't load the domains this server offers, so only the current one is shown."),
    r.domainRetry);
  const domain = section('domain', 'Domain', 'globe',
    el('div', { class: 'field' },
      el('span', { class: 'label', id: ID('domains-label') }, 'Short link domain'),
      r.domains,
      r.domainNote,
      r.domainError,
      r.domainProblem),
    el('p', { class: 'hint' }, 'Changing the domain changes the short link and QR code you share. The slug stays the same, and vanity domains are clearly labelled.'));

  // ---- Teaser ----
  r.teaserOn = el('input', { type: 'checkbox', id: ID('teaser-on'), 'aria-describedby': `${ID('teaser-hint')} ${ID('teaser-on-error')}` });
  r.teaserHint = el('p', { class: 'hint', id: ID('teaser-hint') });
  r.teaserError = errorText('teaser-on');
  r.style = segmented('style', STYLES, ID('style-error'));
  r.styleError = errorText('style');
  r.seconds = el('input', { class: 'range', id: ID('seconds'), type: 'range', min: '3', max: '15', step: '1', 'aria-describedby': ID('seconds-error') });
  r.secondsOut = el('output', { class: 'edit-range-out', for: ID('seconds'), 'aria-hidden': 'true' });
  r.secondsError = errorText('seconds');
  r.message = el('textarea', {
    class: 'textarea',
    id: ID('message'),
    rows: '3',
    placeholder: 'Summer sale: 30% off everything this week!',
    'aria-describedby': ID('message-error'),
  });
  r.messageCount = el('span', { class: 'edit-counter' });
  r.messageError = errorText('message');
  r.messageField = el('div', { class: 'field', hidden: true },
    el('div', { class: 'edit-field-row' },
      el('label', { class: 'label', for: ID('message') }, 'Brand message ', el('span', { class: 'edit-req' }, 'required')),
      r.messageCount),
    r.message,
    r.messageError);
  r.themes = el('div', {
    class: 'edit-swatches',
    id: ID('theme'),
    role: 'radiogroup',
    'aria-labelledby': ID('theme-label'),
    'aria-describedby': ID('theme-error'),
  }, ...THEMES.map((t) => el('button', { type: 'button', role: 'radio', class: 'edit-swatch', 'aria-checked': 'false', tabindex: '-1', dataset: { value: t.value } },
    el('span', { class: 'edit-swatch__chip', 'aria-hidden': 'true' }, 'Aa'),
    el('span', { class: 'edit-swatch__label' }, t.label))));
  r.themeError = errorText('theme');
  const teaser = section('teaser', 'Teaser', 'clapperboard',
    el('div', { class: 'field' }, switchControl(r.teaserOn, 'Show a teaser before redirecting'), r.teaserHint, r.teaserError),
    el('div', { class: 'field' }, el('span', { class: 'label', id: ID('style-label') }, 'Style'), r.style, r.styleError),
    el('div', { class: 'field' },
      el('div', { class: 'edit-field-row' }, el('label', { class: 'label', for: ID('seconds') }, 'Seconds before forwarding'), r.secondsOut),
      r.seconds,
      r.secondsError),
    r.messageField,
    el('div', { class: 'field' }, el('span', { class: 'label', id: ID('theme-label') }, 'Theme'), r.themes, r.themeError));

  // ---- Self-destruct ----
  r.rule = el('span', { class: 'edit-rule__text' });
  r.time = segmented('time', TIME_CHOICES, `${ID('time-hint')} ${ID('time-error')}`);
  r.timeError = errorText('time');
  r.customAt = el('input', { class: 'input edit-date', id: ID('custom-at'), type: 'datetime-local', 'aria-describedby': ID('custom-at-error') });
  r.customAtError = errorText('custom-at');
  r.customField = el('div', { class: 'edit-sub', hidden: true },
    el('label', { class: 'label', for: ID('custom-at') }, 'Vanish on ', el('span', { class: 'edit-optional' }, '(your local time)')),
    r.customAt,
    r.customAtError);
  r.clicks = segmented('clicks', CLICK_CHOICES, ID('clicks-error'));
  r.clicksError = errorText('clicks');
  r.more = el('input', {
    class: 'input edit-number',
    id: ID('more'),
    type: 'number',
    min: '1',
    max: String(FALLBACK_LIMITS.maxClicksMax),
    step: '1',
    inputmode: 'numeric',
    'aria-describedby': `${ID('more-hint')} ${ID('more-error')}`,
  });
  r.moreHint = el('p', { class: 'hint', id: ID('more-hint') });
  r.moreError = errorText('more');
  r.moreField = el('div', { class: 'edit-sub', hidden: true },
    el('label', { class: 'label', for: ID('more') }, 'How many more clicks?'),
    r.more,
    r.moreHint,
    r.moreError);
  r.revive = el('input', { type: 'checkbox', id: ID('revive'), 'aria-describedby': `${ID('revive-hint')} ${ID('revive-error')}` });
  r.reviveError = errorText('revive');
  r.reviveRow = el('div', { class: 'edit-revive', hidden: true },
    switchControl(r.revive, 'Undo Destroy now'),
    el('p', { class: 'hint', id: ID('revive-hint') }, 'A destroyed link stays down, whatever its time and clicks, until you undo it.'),
    r.reviveError);
  const destruct = section('destruct', 'Self-destruct', 'bomb',
    el('p', { class: 'edit-rule' },
      el('span', { class: 'edit-rule__icon', 'aria-hidden': 'true' }, icon('timer')),
      el('span', { class: 'edit-rule__body' }, el('span', { class: 'edit-rule__label' }, 'Right now'), r.rule)),
    r.reviveRow,
    el('div', { class: 'field' },
      el('span', { class: 'label', id: ID('time-label') }, 'Time'),
      r.time,
      el('p', { class: 'hint', id: ID('time-hint') }, '1 hour, 24 hours and 7 days count from the moment you save.'),
      r.timeError,
      r.customField),
    el('div', { class: 'field' },
      el('span', { class: 'label', id: ID('clicks-label') }, 'Clicks'),
      r.clicks,
      r.clicksError,
      r.moreField));

  // ---- footer: live "After saving" line and the actions ----
  r.afterLabel = el('span', { class: 'edit-after__label' });
  r.afterBadge = el('span', { class: 'edit-after__badge' });
  r.afterText = el('span', { class: 'edit-after__text' });
  r.after = el('p', { class: 'edit-after', 'aria-live': 'polite', 'aria-atomic': 'true' }, r.afterLabel, r.afterBadge, r.afterText);
  r.cancelBtn = el('button', { type: 'button', class: 'btn btn--ghost', on: { click: () => requestClose() } }, 'Cancel');
  r.saveBtn = el('button', { type: 'submit', class: 'btn btn--primary edit-save' }, icon('save'), 'Save changes');
  const foot = el('footer', { class: 'edit-foot' }, r.after, el('div', { class: 'edit-foot__actions' }, r.cancelBtn, r.saveBtn));

  r.foot = foot;
  r.sections = { general, domain, teaser, destruct };
  r.body = el('div', { class: 'edit-body' }, r.alert, general, domain, teaser, destruct);
  r.form = el('form', { class: 'edit-form', novalidate: true, on: { submit: onSubmit } }, head, r.body, foot);
  r.dialog = el('dialog', { class: 'modal edit-dialog', 'aria-labelledby': ID('title') }, r.form);
  document.body.append(r.dialog);

  // ---- behaviour ----
  r.domainGroup = radioGroup(r.domains, (value) => {
    if (!session) return;
    session.domain = value;
    touch('domain');
    renderDomainNote();
  });
  r.styleGroup = radioGroup(r.style, (value) => {
    r.teaserOn.checked = true;
    syncVisibility();
    touch('teaser');
    if (value === 'brand') revealInBody(r.messageField);
  });
  r.themeGroup = radioGroup(r.themes, () => {
    r.teaserOn.checked = true;
    touch('teaser');
  });
  r.timeGroup = radioGroup(r.time, (value) => {
    syncVisibility();
    touch('time');
    if (value === 'custom') revealInBody(r.customField);
  });
  r.clicksGroup = radioGroup(r.clicks, (value) => {
    syncVisibility();
    touch('clicks');
    if (value === 'more') revealInBody(r.moreField);
  });

  r.target.addEventListener('input', () => touch('target'));
  r.target.addEventListener('blur', () => {
    const value = r.target.value.trim();
    if (!value) return;
    const prefixed = withScheme(value);
    if (prefixed !== r.target.value) {
      r.target.value = prefixed;
      update();
    }
  });
  r.title.addEventListener('input', () => {
    updateCounters();
    touch('title');
  });
  r.teaserOn.addEventListener('change', () => touch('teaser'));
  r.seconds.addEventListener('input', () => {
    r.teaserOn.checked = true;
    touch('teaser');
  });
  r.message.addEventListener('input', () => {
    updateCounters();
    touch('teaser');
  });
  r.customAt.addEventListener('input', () => touch('time'));
  r.more.addEventListener('input', () => touch('clicks'));
  r.revive.addEventListener('change', () => touch('revive'));

  r.dialog.addEventListener('cancel', (event) => {
    // Escape closes without saving, except while a save is on its way.
    const s = session;
    if (!s) return;
    if (s.saving) {
      event.preventDefault();
      return;
    }
    // The dialog closes right after this event; settle then, without waiting for the `close` event.
    setTimeout(() => {
      if (!r.dialog.open) finish(s);
    }, 0);
  });
  r.dialog.addEventListener('close', () => {
    // Escape: Chromium dispatches `close` with the next rendered frame. A close left over from a previous
    // round can land after the dialog was re-opened, so ignore it then.
    const s = session;
    if (r.dialog.open || !s) return;
    // A second Escape with no click in between closes a dialog without a cancelable `cancel` event. During a
    // save, onSubmit settles once the reply is in (or opens the dialog again to show why it failed).
    if (s.saving) return;
    finish(s);
  });
  return r;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const validStyle = (style) => (STYLES.some((s) => s.value === style) ? style : 'countdown');
const validTheme = (theme) => (THEMES.some((t) => t.value === theme) ? theme : 'hero');

function clampSeconds(value) {
  const t = teaserLimitsOf(session);
  const n = Number(value);
  if (!Number.isFinite(n)) return t.defaultSeconds;
  return Math.min(t.maxSeconds, Math.max(t.minSeconds, Math.round(n)));
}

function applyLimits() {
  const limits = limitsOf(session);
  const t = teaserLimitsOf(session);
  ui.target.maxLength = limits.urlMax;
  ui.title.maxLength = limits.titleMax;
  ui.message.maxLength = limits.messageMax;
  ui.seconds.min = String(t.minSeconds);
  ui.seconds.max = String(t.maxSeconds);
  ui.more.max = String(limits.maxClicksMax);
  ui.more.min = '1';
}

/** Put the link's values into the controls (all groups, or only the ones in `only`). */
function populate(link, only = null) {
  const want = (group) => !only || only.has(group);
  if (want('target')) ui.target.value = link.targetUrl || '';
  if (want('title')) ui.title.value = link.title ?? '';
  if (want('domain')) {
    session.domain = link.domain;
    renderDomains();
  }
  if (want('teaser')) {
    ui.teaserOn.checked = link.redirectMode === 'teaser';
    ui.styleGroup.set(validStyle(link.teaser?.style));
    ui.seconds.value = String(clampSeconds(link.teaser?.seconds));
    ui.message.value = link.teaser?.message ?? '';
    ui.themeGroup.set(validTheme(link.teaser?.theme));
  }
  if (want('time')) {
    ui.timeGroup.set('keep');
    const suggested = suggestedCustomMs(link);
    const value = toLocalInput(suggested);
    ui.customAt.value = value;
    // The field only holds whole minutes. Remember what was written, so saving it untouched keeps the exact timer
    // (customIsPrefill) instead of pulling it up to 59.999 s earlier.
    session.customPrefill = {
      value,
      expiresAt: link.expiresAt ?? null,
      fromLink: Boolean(link.expiresAt) && suggested === Date.parse(link.expiresAt),
    };
  }
  if (want('clicks')) {
    ui.clicksGroup.set('keep');
    ui.more.value = String(DEFAULT_MORE_CLICKS);
  }
  // Bring back (opened at Self-destruct) on a destroyed link starts with Undo Destroy now on: that is what it is for.
  if (want('revive')) ui.revive.checked = session.reviveByDefault && link.status === 'destroyed';
  syncVisibility();
  updateCounters();
}

/** Header, notice, current rule and the revive control: everything that follows the saved link itself. */
function renderLinkState() {
  const link = session.link;
  ui.slug.textContent = `/${link.slug}`;
  ui.badge.replaceChildren(statusBadge(link.status, link.expiredReason));
  if (link.status === 'active') {
    ui.notice.hidden = true;
    ui.dialog.removeAttribute('aria-describedby');
  } else {
    const copy = noticeCopy(link);
    ui.noticeIcon.replaceChildren(icon(copy.icon));
    ui.noticeKicker.textContent = copy.kicker;
    ui.noticeText.textContent = copy.text;
    ui.noticeBtn.setAttribute('aria-label', link.status === 'destroyed' ? 'Show me Undo Destroy now' : 'Show me the self-destruct settings');
    ui.notice.hidden = false;
    // Bring back moves focus straight to a control below, so the dialog's description carries the reason.
    ui.dialog.setAttribute('aria-describedby', ID('notice'));
  }
  ui.rule.textContent = ruleText(link);
  ui.reviveRow.hidden = link.status !== 'destroyed';
  ui.customAt.min = toLocalInput(Date.now());
}

function renderDomains() {
  const s = session;
  if (!s) return;
  if (s.configState === 'loading') {
    ui.domains.setAttribute('aria-busy', 'true');
    ui.domains.replaceChildren(...Array.from({ length: 3 }, () => el('span', { class: 'skeleton edit-chip-skeleton', 'aria-hidden': 'true' })));
    ui.domainNote.textContent = 'Loading the domains this server offers...';
    ui.domainProblem.hidden = true;
    return;
  }
  ui.domains.removeAttribute('aria-busy');
  const list = s.config ? s.config.domains.map((d) => ({ ...d })) : [];
  if (!list.some((d) => d.domain === s.link.domain)) {
    list.push({ domain: s.link.domain, live: Boolean(s.link.domainLive), isBase: s.link.shortUrl === s.link.workingUrl });
  }
  if (!list.some((d) => d.domain === s.domain)) s.domain = s.link.domain;
  ui.domains.replaceChildren(...list.map((d) => el('button', {
    type: 'button',
    role: 'radio',
    class: 'chip edit-domain-chip',
    'aria-checked': String(d.domain === s.domain),
    tabindex: d.domain === s.domain ? '0' : '-1',
    title: d.live ? 'Live: links on this domain work right now' : VANITY_TIP,
    dataset: { value: d.domain, live: String(d.live), base: String(d.isBase) },
  },
  el('span', { class: 'edit-domain-chip__name' }, d.domain),
  el('span', { class: `badge ${d.live ? 'badge--live' : 'badge--vanity'}` }, d.live ? 'live' : 'vanity'))));
  ui.domainGroup.refresh();
  ui.domainProblem.hidden = s.configState !== 'error';
  renderDomainNote();
}

function renderDomainNote() {
  const chip = ui.domainGroup.checkedItem();
  if (!chip) {
    ui.domainNote.textContent = '';
    return;
  }
  const name = chip.dataset.value;
  if (chip.dataset.base === 'true') {
    ui.domainNote.textContent = `${name} is this server's own address, so the link works right away.`;
  } else if (chip.dataset.live === 'true') {
    ui.domainNote.textContent = `${name} is live: its DNS points at this Blip server, so the branded link works right away.`;
  } else {
    ui.domainNote.textContent = `${name} is a vanity preview: you get a branded link to show off, and the working link on this server redirects today. ${VANITY_TIP}`;
  }
}

function syncVisibility() {
  const brand = ui.styleGroup.value === 'brand';
  ui.messageField.hidden = !brand;
  ui.message.setAttribute('aria-required', String(brand));
  ui.customField.hidden = ui.timeGroup.value !== 'custom';
  ui.moreField.hidden = ui.clicksGroup.value !== 'more';
}

function updateCounters() {
  const limits = limitsOf(session);
  const counter = (node, len, max) => {
    node.textContent = `${len}/${max}`;
    node.dataset.level = len >= max ? 'full' : len >= max * 0.9 ? 'near' : 'ok';
  };
  counter(ui.titleCount, ui.title.value.length, limits.titleMax);
  counter(ui.messageCount, ui.message.value.length, limits.messageMax);
}

/** A control changed: remember the group as edited, clear its errors and refresh the live summaries. */
function touch(group) {
  if (!session) return;
  session.touched.add(group);
  clearErrors(group);
  update();
}

function update() {
  if (!session) return;
  const seconds = clampSeconds(ui.seconds.value);
  ui.secondsOut.textContent = `${seconds}s`;
  ui.seconds.setAttribute('aria-valuetext', `${seconds} seconds`);
  const styleWord = STYLES.find((st) => st.value === ui.styleGroup.value)?.word ?? 'countdown';
  ui.teaserHint.textContent = ui.teaserOn.checked
    ? `Visitors see a ${seconds}-second ${styleWord} page, then head to the destination.`
    : 'Off: visitors go straight to the destination.';

  const used = session.link.clickCount ?? 0;
  const n = Number(ui.more.value);
  ui.moreHint.textContent = Number.isInteger(n) && n >= 1
    ? `The limit becomes ${plural(used + n, 'click')} (${formatNumber(used)} used so far).`
    : `${plural(used, 'click')} used so far.`;
  renderAfter();
}

/** What the time and click rules will be once saved, without throwing on half-typed input. */
function pendingRule() {
  const link = session.link;
  const now = Date.now();
  let at = link.expiresAt ? Date.parse(link.expiresAt) : null;
  let atProblem = null;
  const timeChoice = TIME_CHOICES.find((c) => c.value === ui.timeGroup.value);
  if (timeChoice?.value === 'none') at = null;
  else if (timeChoice?.seconds) at = now + timeChoice.seconds * 1000;
  else if (timeChoice?.value === 'custom' && !customIsPrefill(session)) {
    const v = ui.customAt.value ? new Date(ui.customAt.value).getTime() : NaN;
    if (!Number.isFinite(v)) atProblem = 'pick a date and time';
    else if (v <= now) atProblem = 'pick a time in the future';
    else at = v;
  }
  let max = link.maxClicks ?? null;
  let maxProblem = null;
  if (ui.clicksGroup.value === 'none') max = null;
  else if (ui.clicksGroup.value === 'more') {
    const n = Number(ui.more.value);
    if (!Number.isInteger(n) || n < 1) maxProblem = 'enter how many more clicks';
    else max = (link.clickCount ?? 0) + n;
  }
  const destroyed = link.status === 'destroyed' && !ui.revive.checked;
  return { now, at, atProblem, max, maxProblem, destroyed, used: link.clickCount ?? 0 };
}

/**
 * The footer's "After saving" line. It is a polite, atomic live region, so it works out every value first and
 * writes only what changed: typing a title or moving the seconds slider stays silent, while a new status or a
 * new time or click summary is read out once.
 */
function renderAfter() {
  const s = session;
  let changes = 0;
  let unfinished = false;
  try {
    changes = Object.keys(buildPatch(s)).length + (wantsRevive(s) ? 1 : 0);
  } catch {
    unfinished = true;
  }
  const label = changes || unfinished ? 'After saving' : 'No changes yet';

  const p = pendingRule();
  const timeUp = p.at !== null && p.at <= p.now;
  const clicksUp = p.max !== null && p.used >= p.max;
  const status = p.destroyed ? 'destroyed' : timeUp || clicksUp ? 'expired' : 'active';
  const reason = status === 'expired' ? (timeUp ? 'time' : 'clicks') : null;

  let text;
  if (p.destroyed) {
    text = 'Visitors see the self-destructed page until you undo Destroy now.';
  } else {
    let time;
    if (p.atProblem) time = p.atProblem;
    else if (p.at === null) time = 'no time limit';
    else time = timeUp ? `timer ended ${formatDateTime(p.at)}` : `vanishes ${formatDateTime(p.at)}`;
    let clicks;
    if (p.maxProblem) clicks = p.maxProblem;
    else if (p.max === null) clicks = 'no click limit';
    else clicks = clicksUp ? `${allClicks(p.max)} used` : `${formatNumber(p.max - p.used)} of ${plural(p.max, 'click')} left`;
    text = capitalize(`${time}, ${clicks}`);
  }

  // Compared with the live DOM, so nothing stale carries over between sessions.
  if (ui.afterLabel.textContent !== label) ui.afterLabel.textContent = label;
  const badgeKey = `${status}|${reason ?? ''}`;
  if (ui.afterBadge.dataset.key !== badgeKey) {
    ui.afterBadge.dataset.key = badgeKey;
    ui.afterBadge.replaceChildren(statusBadge(status, reason));
  }
  if (ui.afterText.textContent !== text) ui.afterText.textContent = text;
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------
const wantsRevive = (s) => s.link.status === 'destroyed' && ui.revive.checked;

/** True when the destination field still says the saved destination (as typed, or once https:// is added). */
function sameTarget(raw, stored) {
  const value = String(raw ?? '').trim();
  if (!value || !stored) return false;
  if (value === stored) return true;
  try {
    return new URL(withScheme(value)).href === stored;
  } catch {
    return false;
  }
}

/** Custom date still holds the minute-rounded current timer that populate() wrote: that means "keep it". */
function customIsPrefill(s) {
  const pre = s?.customPrefill;
  if (!pre || !pre.fromLink || ui.customAt.value !== pre.value) return false;
  const at = s.link.expiresAt ? Date.parse(s.link.expiresAt) : NaN;
  return pre.expiresAt === s.link.expiresAt && Number.isFinite(at) && at > Date.now();
}

/** The UpdateBody for everything that differs from the saved link. Throws FieldError on invalid input. */
function buildPatch(s) {
  const link = s.link;
  const limits = limitsOf(s);
  const patch = {};

  // An unchanged destination is neither checked nor sent: the server only checks targetUrl when it arrives, and
  // the own-host list can grow after the link was made (a new vanity domain), which must not block other edits.
  if (!sameTarget(ui.target.value, link.targetUrl)) {
    const url = checkTargetUrl(ui.target.value, { ownHosts: ownHostsOf(s), maxLength: limits.urlMax });
    if (!url.ok) throw new FieldError('targetUrl', url.message);
    if (url.url !== link.targetUrl) patch.targetUrl = url.url;
  }

  const title = cleanTitle(ui.title.value);
  if (title.length > limits.titleMax) throw new FieldError('title', `Keep the title to ${formatNumber(limits.titleMax)} characters or fewer.`);
  if (title !== (link.title ?? '')) patch.title = title || null;

  if (s.domain && s.domain !== link.domain) patch.domain = s.domain;

  const on = ui.teaserOn.checked;
  const mode = on ? 'teaser' : 'instant';
  if (mode !== link.redirectMode) patch.redirectMode = mode;
  const teaser = {};
  const style = validStyle(ui.styleGroup.value);
  const seconds = clampSeconds(ui.seconds.value);
  const theme = validTheme(ui.themeGroup.value);
  if (style !== link.teaser?.style) teaser.style = style;
  if (seconds !== link.teaser?.seconds) teaser.seconds = seconds;
  if (theme !== link.teaser?.theme) teaser.theme = theme;
  if (style === 'brand') {
    const message = cleanMessage(ui.message.value);
    if (on && !message) throw new FieldError('teaser.message', 'Brand message teasers need a message. What should visitors read?');
    if (message.length > limits.messageMax) throw new FieldError('teaser.message', `Keep the message to ${formatNumber(limits.messageMax)} characters or fewer.`);
    if (message !== (link.teaser?.message ?? '')) teaser.message = message || null;
  }
  if (Object.keys(teaser).length) patch.teaser = teaser;

  const timeChoice = TIME_CHOICES.find((c) => c.value === ui.timeGroup.value);
  if (timeChoice?.value === 'none') {
    if (link.expiresAt) patch.expiresAt = null;
  } else if (timeChoice?.seconds) {
    patch.expiresInSeconds = timeChoice.seconds;
  } else if (timeChoice?.value === 'custom' && !customIsPrefill(s)) {
    const at = ui.customAt.value ? new Date(ui.customAt.value).getTime() : NaN;
    if (!Number.isFinite(at)) throw new FieldError('expiresAt', 'Pick the date and time it should vanish.');
    if (at <= Date.now()) throw new FieldError('expiresAt', 'The self-destruct time must be in the future.');
    if (at > Date.now() + MAX_EXPIRY_MS) throw new FieldError('expiresAt', 'The self-destruct time can be at most 5 years away.');
    const iso = new Date(at).toISOString();
    if (iso !== link.expiresAt) patch.expiresAt = iso;
  }

  if (ui.clicksGroup.value === 'none') {
    if (link.maxClicks !== null && link.maxClicks !== undefined) patch.maxClicks = null;
  } else if (ui.clicksGroup.value === 'more') {
    const n = Number(ui.more.value);
    const max = limits.maxClicksMax;
    if (!ui.more.value.trim() || !Number.isInteger(n) || n < 1 || n > max) {
      throw new FieldError('maxClicks', `Enter a whole number of clicks from 1 to ${formatNumber(max)}.`);
    }
    const total = (link.clickCount ?? 0) + n;
    if (total > max) throw new FieldError('maxClicks', `That makes the limit ${formatNumber(total)}, but a link can have at most ${formatNumber(max)} clicks.`);
    if (total !== link.maxClicks) patch.maxClicks = total;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
/** Each group's controls and error lines, so a change clears only its own messages. */
function errorPairs(group) {
  const pairs = {
    target: [[ui.target, ui.targetError]],
    title: [[ui.title, ui.titleError]],
    domain: [[ui.domains, ui.domainError]],
    teaser: [[ui.teaserOn, ui.teaserError], [ui.style, ui.styleError], [ui.seconds, ui.secondsError], [ui.message, ui.messageError], [ui.themes, ui.themeError]],
    time: [[ui.time, ui.timeError], [ui.customAt, ui.customAtError]],
    clicks: [[ui.clicks, ui.clicksError], [ui.more, ui.moreError]],
    revive: [[ui.revive, ui.reviveError]],
  };
  return group ? pairs[group] ?? [] : Object.values(pairs).flat();
}

function setFieldError(control, errorEl, message) {
  if (message) {
    control.setAttribute('aria-invalid', 'true');
    errorEl.textContent = message;
    errorEl.hidden = false;
  } else {
    control.removeAttribute('aria-invalid');
    errorEl.textContent = '';
    errorEl.hidden = true;
  }
}

function clearErrors(group = null) {
  for (const [control, errorEl] of errorPairs(group)) setFieldError(control, errorEl, '');
}

/** Where an UpdateBody field's error is shown: { control, error, focus?, reveal? }. */
function fieldTarget(field) {
  switch (field) {
    case 'targetUrl': return { control: ui.target, error: ui.targetError };
    case 'title': return { control: ui.title, error: ui.titleError };
    case 'domain': return { control: ui.domains, error: ui.domainError, focus: ui.domainGroup.checkedItem() };
    case 'redirectMode': return { control: ui.teaserOn, error: ui.teaserError };
    case 'teaser':
    case 'teaser.style': return { control: ui.style, error: ui.styleError, focus: ui.styleGroup.checkedItem() };
    case 'teaser.seconds': return { control: ui.seconds, error: ui.secondsError };
    case 'teaser.theme': return { control: ui.themes, error: ui.themeError, focus: ui.themeGroup.checkedItem() };
    case 'teaser.message':
      return {
        control: ui.message,
        error: ui.messageError,
        reveal: () => {
          if (ui.styleGroup.value !== 'brand') ui.styleGroup.set('brand');
          syncVisibility();
        },
      };
    case 'expiresAt':
    case 'expiresInSeconds':
      return ui.timeGroup.value === 'custom'
        ? { control: ui.customAt, error: ui.customAtError }
        : { control: ui.time, error: ui.timeError, focus: ui.timeGroup.checkedItem() };
    case 'maxClicks':
      return ui.clicksGroup.value === 'more'
        ? { control: ui.more, error: ui.moreError }
        : { control: ui.clicks, error: ui.clicksError, focus: ui.clicksGroup.checkedItem() };
    default: return null;
  }
}

function showFieldError(field, message) {
  const target = fieldTarget(field);
  if (!target) return false;
  target.reveal?.();
  setFieldError(target.control, target.error, message);
  const focusEl = target.focus || target.control;
  // A switch's checkbox is visually hidden: centre its visible label instead.
  scrollIntoBody(target.control.closest('.switch') || target.control, { align: 'center' });
  focusEl.focus({ preventScroll: true });
  return true;
}

let alertTimer = 0;

function showAlert(message) {
  clearTimeout(alertTimer);
  ui.alertText.textContent = '';
  ui.alert.hidden = false;
  // Set just after un-hiding so screen readers announce it, even when the same message repeats.
  alertTimer = setTimeout(() => { ui.alertText.textContent = message; }, 60);
  // On short screens the header scrolls with the form, so scroll to the alert itself rather than to the top.
  scrollIntoBody(ui.alert);
}

function hideAlert() {
  clearTimeout(alertTimer);
  ui.alert.hidden = true;
  ui.alertText.textContent = '';
}

// ---------------------------------------------------------------------------
// Scrolling and focus
// ---------------------------------------------------------------------------
/** What scrolls: the body, or the whole form on short screens (edit-settings.css), where the header scrolls away. */
function scroller() {
  return getComputedStyle(ui.body).overflowY === 'visible' ? ui.form : ui.body;
}

/** The part of the scroller that the sticky footer does not cover. */
function viewBox(sc) {
  const box = sc.getBoundingClientRect();
  const bottom = sc === ui.form ? Math.min(box.bottom, ui.foot.getBoundingClientRect().top) : box.bottom;
  return { top: box.top, bottom, height: bottom - box.top };
}

/** Scroll the dialog (never the page behind it) so `node` is in view. Instant: no scroll animation. */
function scrollIntoBody(node, { align = 'start' } = {}) {
  const sc = scroller();
  const view = viewBox(sc);
  const rect = node.getBoundingClientRect();
  const offset = rect.top - view.top + sc.scrollTop;
  const top = align === 'center' ? offset - Math.max(12, (view.height - rect.height) / 2) : offset - 12;
  sc.scrollTop = Math.max(0, top);
}

/** Scroll just enough to show `node` whole (a field a choice has just revealed, or a newly focused control). */
function revealInBody(node) {
  const sc = scroller();
  const view = viewBox(sc);
  const rect = node.getBoundingClientRect();
  if (rect.bottom > view.bottom - 8) sc.scrollTop += Math.min(rect.bottom - view.bottom + 12, rect.top - view.top - 12);
  else if (rect.top < view.top + 8) sc.scrollTop -= view.top - rect.top + 12;
}

function firstControl(name) {
  const link = session.link;
  switch (name) {
    case 'domain':
      return ui.domainGroup.checkedItem() || (ui.domainProblem.hidden ? null : ui.domainRetry);
    case 'teaser':
      return ui.teaserOn;
    case 'destruct':
      if (link.status === 'destroyed') return ui.revive;
      if (link.status === 'expired' && (link.expiredReason === 'clicks' || (clicksAreUp(link) && !timeIsUp(link)))) return ui.clicksGroup.checkedItem();
      return ui.timeGroup.checkedItem();
    default:
      return ui.target;
  }
}

function focusSection(name) {
  const sectionName = SECTIONS.includes(name) ? name : 'general';
  const sc = scroller();
  if (sectionName === 'general') sc.scrollTop = 0;
  else scrollIntoBody(ui.sections[sectionName], { align: 'start' });
  const control = firstControl(sectionName) || ui.sections[sectionName].querySelector('.edit-section__title');
  if (!control) return;
  control.focus({ preventScroll: true });
  // Show the visible wrapper (a switch's checkbox is a hidden 1px box), clear of the footer.
  revealInBody(control.closest('.switch, [role="radiogroup"]') || control);
}

/** Remember the element that opened the dialog, and enough about it to find its replacement after a re-render. */
function rememberOpener() {
  const node = document.activeElement;
  if (!node || node === document.body || ui?.dialog.contains(node)) return null;
  const scope = node.parentElement?.closest('[id]');
  return { node, id: node.id || null, action: node.dataset?.action || null, scopeId: scope?.id || null };
}

function restoreFocus(info) {
  if (!info) return;
  const usable = (n) => Boolean(n && n.isConnected && !n.disabled && n.getClientRects().length > 0);
  let target = usable(info.node) ? info.node : null;
  if (!target && info.id) {
    const sameId = document.getElementById(info.id);
    if (usable(sameId)) target = sameId;
  }
  const scope = info.scopeId ? document.getElementById(info.scopeId) : null;
  if (!target && scope && info.action) {
    target = [...scope.querySelectorAll(`[data-action="${CSS.escape(info.action)}"]`)].find(usable) || null;
  }
  if (!target && scope) {
    target = [...scope.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].find(usable) || null;
  }
  target?.focus();
}

// ---------------------------------------------------------------------------
// Open, save, close
// ---------------------------------------------------------------------------
function settle(s) {
  if (!s || s.settled) return;
  s.settled = true;
  s.resolve(s.saved);
}

/** End a session: settle its promise and hand focus back to the page. Runs once per session. */
function finish(s) {
  if (session !== s) return;
  session = null;
  settle(s);
  restoreFocus(s.opener);
}

/** Close from Cancel, the close button or a finished save: settle right away rather than wait for `close`. */
function requestClose() {
  const s = session;
  if (!s || s.saving) return;
  if (ui.dialog.open) ui.dialog.close();
  finish(s);
}

function setSaving(s, saving) {
  s.saving = saving;
  ui.saveBtn.classList.toggle('is-loading', saving);
  if (saving) {
    ui.saveBtn.setAttribute('aria-busy', 'true');
    ui.saveBtn.setAttribute('aria-disabled', 'true');
  } else {
    ui.saveBtn.removeAttribute('aria-busy');
    ui.saveBtn.removeAttribute('aria-disabled');
  }
}

function loadConfigFor(s) {
  s.configState = 'loading';
  renderDomains();
  fetchConfig()
    .then((config) => {
      if (session !== s) return;
      s.config = config;
      s.configState = 'ready';
      const waiting = document.activeElement === ui.sections.domain.querySelector('.edit-section__title');
      applyLimits();
      renderDomains();
      updateCounters();
      update();
      // Opened at the Domain section before the chips existed: hand focus to the chosen chip now.
      if (waiting) ui.domainGroup.checkedItem()?.focus({ preventScroll: true });
    })
    .catch(() => {
      if (session !== s) return;
      s.configState = 'error';
      renderDomains();
    });
}

/** Re-read the link in the background (clicks may have landed since the page loaded it). */
function refreshLink(s) {
  api.getLink(s.link.slug, s.token)
    .then((res) => {
      const fresh = res?.link;
      if (session !== s || s.saving || !isObject(fresh)) return;
      const old = s.link;
      if (fresh.updatedAt === old.updatedAt && fresh.clickCount === old.clickCount && fresh.status === old.status) return;
      s.link = fresh;
      populate(fresh, new Set(GROUPS.filter((g) => !s.touched.has(g))));
      renderLinkState();
      update();
    })
    .catch((err) => {
      if (session !== s) return;
      if (err?.status === 404 || err?.status === 401 || err?.status === 403) showAlert(friendlyError(err));
    });
}

/** A request succeeded: it becomes the new baseline, and the page hears about it. */
function commit(s, link, { keepRevive = false } = {}) {
  if (!isObject(link) || typeof link.slug !== 'string') throw new Error('The server sent an unexpected reply. Please try again.');
  s.link = link;
  s.saved = link;
  try {
    s.onSaved?.(link);
  } catch (err) {
    console.error(err);
  }
  if (session !== s) return;
  s.touched.clear();
  populate(link, new Set(GROUPS.filter((g) => !(keepRevive && g === 'revive'))));
  renderLinkState();
  update();
}

/** The server-owned counters of a link, which visitors change while the dialog is open. */
const COUNTERS = ['clickCount', 'clicksRemaining', 'status', 'expiredReason'];

/** Copy the counters (only those `fresh` has) onto the session's link, never the fields the user edits. */
function adoptCounters(s, fresh, keys = COUNTERS) {
  const next = { ...s.link };
  for (const key of keys) if (key in fresh) next[key] = fresh[key];
  s.link = next;
}

/**
 * Live pages (the dashboard) pass the link here on every click or status event while the dialog is open, so
 * "N used so far", the "After saving" line and the new click limit follow visitors' clicks. Only the counters
 * are taken; nothing the user is editing changes.
 */
export function syncEditSettingsLink(live) {
  const s = session;
  if (!s || s.saving || !isObject(live) || s.link.slug !== live.slug) return;
  // Clicks only ever go up: a lower count is older than the dialog's own re-read, so it changes nothing.
  if (Number(live.clickCount) < Number(s.link.clickCount ?? 0)) return;
  adoptCounters(s, live);
  renderLinkState();
  update();
}

/**
 * Re-read the counters just before "Allow more clicks" is saved, so N more counts from the clicks used now,
 * not from when the dialog opened. Returns false (keep the patch as built) when the read fails or the dialog
 * moved on to another link; the save itself then reports any real problem.
 */
async function rebaseClicks(s) {
  let fresh;
  try {
    fresh = (await api.getLink(s.link.slug, s.token))?.link;
  } catch {
    return false;
  }
  if (session !== s || !isObject(fresh)) return false;
  adoptCounters(s, fresh, [...COUNTERS, 'maxClicks']);
  renderLinkState();
  update();
  return true;
}

/** The save's reply shows visitors used up the new clicks between the re-read and the save. */
const burnedByClicks = (link) => isObject(link) && link.status === 'expired' && link.expiredReason === 'clicks'
  && link.maxClicks !== null && link.maxClicks !== undefined && link.maxClicks <= (link.clickCount ?? 0);

/** Saved LinkDTO to { base, patch }: what the save started from and what it sent, for announceSaved(). */
const saveNotes = new WeakMap();

function expiredCopy(path, base, after, patch) {
  if (base.status !== 'active') return `Saved. ${path} is still expired, so visitors see the self-destructed page.`;
  const byClicks = after.expiredReason === 'clicks';
  const changedRule = !patch || (byClicks ? 'maxClicks' in patch : 'expiresAt' in patch || 'expiresInSeconds' in patch);
  if (changedRule) return `Saved. With these settings ${path} has already expired, so visitors see the self-destructed page.`;
  return byClicks
    ? `Saved. Meanwhile visitors used up the last clicks on ${path}, so it shows the self-destructed page.`
    : `Saved. Meanwhile the timer on ${path} ran out, so visitors see the self-destructed page.`;
}

/**
 * The confirmation toast for a finished edit (SPEC 10.2: the caller confirms). Call it once with the link as it was
 * before openEditSettings() and the LinkDTO it resolved with, so every page words it the same way. The dialog's own
 * record of what the save started from takes precedence over `before`, which can predate clicks that landed while
 * the dialog was open: those are reported as visitors' doing, not as the result of the new settings.
 */
export function announceSaved(before, after) {
  if (!isObject(after) || typeof after.slug !== 'string') return;
  const path = `/${after.slug}`;
  const note = saveNotes.get(after);
  const base = note?.base ?? (isObject(before) ? before : after);
  if (base.status !== 'active' && after.status === 'active') {
    toast(`${path} is back in action.`, { type: 'success' });
  } else if (after.status === 'expired') {
    toast(expiredCopy(path, base, after, note?.patch), { timeout: 5000 });
  } else if (after.status === 'destroyed') {
    toast(`Saved. ${path} stays destroyed until you undo Destroy now.`, { timeout: 5000 });
  } else {
    toast(`Saved changes to ${path}.`, { type: 'success' });
  }
}

/** Keep the user's "Allow more clicks" choice after a partial save, so pressing Save again is enough. */
function keepMoreClicks(s, n) {
  if (session !== s) return;
  ui.clicksGroup.set('more');
  ui.more.value = String(n);
  syncVisibility();
  s.touched.add('clicks');
  update();
}

/** A save that failed after Escape closed the dialog mid-save: open it again, edits intact, to show why. */
function reopen(s) {
  if (session === s && !ui.dialog.open) ui.dialog.showModal();
}

/** A FieldError (or anything else) found while building the patch: show it and stay open. */
function showBuildError(err) {
  if (err instanceof FieldError && showFieldError(err.field, err.message)) return;
  showAlert(friendlyError(err));
}

async function onSubmit(event) {
  event.preventDefault();
  const s = session;
  if (!s || s.saving) return;
  clearErrors();
  hideAlert();

  let patch;
  try {
    patch = buildPatch(s);
  } catch (err) {
    showBuildError(err);
    return;
  }
  let revive = wantsRevive(s);
  if (!Object.keys(patch).length && !revive) {
    requestClose();
    toast('Nothing to save.');
    return;
  }

  const slug = s.link.slug;
  // buildPatch() has checked it: a whole number from 1 to the click limit.
  const moreClicks = ui.clicksGroup.value === 'more' ? Number(ui.more.value) : 0;
  let stage = 'update';
  setSaving(s, true);
  try {
    if (moreClicks && await rebaseClicks(s)) {
      try {
        patch = buildPatch(s);
      } catch (err) {
        setSaving(s, false);
        reopen(s);
        showBuildError(err);
        return;
      }
      revive = wantsRevive(s);
      if (!Object.keys(patch).length && !revive) {
        setSaving(s, false);
        requestClose();
        toast(`Nothing to change: /${slug} already has ${plural(moreClicks, 'click')} left.`);
        return;
      }
    }

    const base = s.link;
    if (Object.keys(patch).length) {
      const first = (await api.updateLink(slug, s.token, patch))?.link;
      let link = first;
      // Visitors used up the new clicks between the re-read and the save: count N more from the real total, once.
      const total = moreClicks && burnedByClicks(first) ? (first.clickCount ?? 0) + moreClicks : 0;
      if (total && total <= limitsOf(s).maxClicksMax) {
        try {
          link = (await api.updateLink(slug, s.token, { maxClicks: total }))?.link ?? first;
        } catch (err) {
          commit(s, first, { keepRevive: revive });
          stage = 'top-up';
          throw err;
        }
      }
      commit(s, link, { keepRevive: revive });
    }
    if (revive) {
      stage = 'revive';
      const res = await api.reviveLink(slug, s.token);
      commit(s, res?.link);
    }
    if (s.saved) saveNotes.set(s.saved, { base, patch });
  } catch (err) {
    setSaving(s, false);
    if (session !== s) return;
    reopen(s);
    const message = friendlyError(err);
    if (stage === 'top-up') {
      keepMoreClicks(s, moreClicks);
      showAlert(`Saved, but visitors used up the new clicks while it saved, so /${slug} is out of clicks again. ${message}`);
      return;
    }
    if (stage === 'revive') {
      const text = s.saved ? `Your other changes are saved, but Undo Destroy now didn't go through. ${message}` : message;
      setFieldError(ui.revive, ui.reviveError, text);
      showAlert(text);
      return;
    }
    const field = err?.status === 400 ? err.field || CODE_FIELDS[err.code] || null : null;
    if (!showFieldError(field, message)) showAlert(message);
    return;
  }
  setSaving(s, false);
  if (session === s) requestClose();
}

/**
 * Open the Edit settings dialog for a link.
 * @param {object} link the current LinkDTO
 * @param {string} token the link's manage key
 * @param {{ config?: object, focus?: 'general'|'domain'|'teaser'|'destruct', onSaved?: (link: object) => void }} [options]
 * @returns {Promise<object|null>} the saved LinkDTO, or null when nothing was saved
 */
export async function openEditSettings(link, token, { config, focus = 'general', onSaved } = {}) {
  if (!isObject(link) || typeof link.slug !== 'string' || !token) return null;
  if (!ui) ui = build();
  if (typeof ui.dialog.showModal !== 'function') {
    toast("This browser can't open the settings editor. Please update it and try again.", { type: 'error' });
    return null;
  }

  // Opening again while open: the earlier call settles with whatever it saved.
  const opener = session ? session.opener : rememberOpener();
  if (session) {
    const previous = session;
    session = null;
    settle(previous);
  }
  if (ui.dialog.open) ui.dialog.close();

  let resolve;
  const done = new Promise((res) => { resolve = res; });
  const given = config ? normalizeConfig(config) : null;
  const s = {
    link,
    token,
    config: given || configCache,
    configState: given || configCache ? 'ready' : 'loading',
    onSaved,
    resolve,
    saved: null,
    settled: false,
    saving: false,
    touched: new Set(),
    domain: link.domain,
    customPrefill: null,
    reviveByDefault: focus === 'destruct',
    opener,
  };
  session = s;

  setSaving(s, false);
  hideAlert();
  clearErrors();
  applyLimits();
  populate(link);
  renderLinkState();
  update();

  ui.dialog.showModal();
  focusSection(focus);

  if (s.configState === 'loading') loadConfigFor(s);
  refreshLink(s);
  return done;
}
