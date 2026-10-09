// Blip: live analytics dashboard (dashboard.html#<slug>). See SPEC.md section 11 and DESIGN.md.
// Data: GET /api/links/:slug, GET /api/links/:slug/stats and the live SSE stream, all through api.js.
// Each section shows a skeleton shaped like its final layout while its data loads.
import {
  api,
  ApiError,
  linkStore,
  el,
  icon,
  toast,
  copyText,
  formatNumber,
  formatRelative,
  formatDuration,
  formatDateTime,
  syncNavCount,
} from './api.js';
import { openEditSettings, announceSaved, syncEditSettingsLink } from './edit-settings.js';
import { createTimeseriesChart, bucketLabel, wallClock } from './dashboard/timeseries.js';
import { createWorldMap } from './dashboard/worldmap.js';
import { renderBars, renderDevices, renderCountries, referrerLead, referrerLabel } from './dashboard/lists.js';
import { createFeed } from './dashboard/feed.js';
import { radioGroup, tabs, setLoading, createDebounce } from './dashboard/ui.js';
import { RANGES, RANGE_LABELS, RANGE_SHORT, BUCKET_ADVERBS, bucketOf, SLUG_RE, isCountedClick, d3Ready } from './dashboard/constants.js';
import { loadLib } from './dashboard/vendor.js';

const $ = (id) => document.getElementById(id);
const RANGE_KEY = 'blip.dashboard.range';
const SIM_KEY = 'blip.dashboard.simCount';
const TAB_KEY = 'blip.dashboard.tab';
const SIM_COUNTS = ['10', '25', '50'];
const TABS = ['devices', 'browsers', 'os', 'referrers', 'countries'];
const DAY = 86_400_000;
const VIEWS = ['boot', 'gate', 'error', 'app'];
const DEFAULT_TITLE = 'Live dashboard · Blip';
const MAP_SUB_DEFAULT = 'Countries shaded by clicks, live clicks pop up as they land';

function readPref(key, allowed, fallback) {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode or blocked): the preference just won't persist */
  }
}

const plural = (n, one, many) => `${formatNumber(n)} ${n === 1 ? one : many}`;

const state = {
  configPromise: null,
  config: null,
  gen: 0,
  slug: null,
  token: null,
  link: null,
  stats: null,
  statsTz: 0, // the `tz` the stats on screen were requested with: their bucket starts are local times in it
  editing: false, // the Edit settings dialog is open (live status toasts wait for it)
  allTime: null, // { clicks, uniqueVisitors, syntheticClicks }: all-time, from the stream
  // `stats.throughClickId` is the highest click id stored when the stats were read: a live click event
  // with an id up to it is already in `stats` and must not be counted again (a visit on another server
  // instance reaches the stream up to 2 s late, and simulated rows are stored up front while their
  // events trickle in over several seconds).
  range: readPref(RANGE_KEY, RANGES, '7d'),
  simCount: readPref(SIM_KEY, SIM_COUNTS, '25'),
  stream: null,
  liveStatus: 'idle',
  statsCtrl: null,
  lifeTimer: 0,
  feedTimer: 0,
  expiryCheck: null, // { expiresAt, attempt, nextAt } while the local clock says expired but the server hasn't confirmed
  failedRange: null, // range whose stats failed to load (offered again by the Retry button)
  catchUp: false, // fetch once more when the stream says hello, to cover the gap before it connected
};

let charts = null;
let rangeControl = null;

// ---------------------------------------------------------------------------
// Views and loading states
// ---------------------------------------------------------------------------
function showView(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  document.body.dataset.view = name;
}

/** Sections fed by the stats endpoint (they show skeletons on first load and on range changes). */
const statsSections = () => [$('kpi-clicks'), $('kpi-unique'), $('kpi-24h'), $('kpi-bots'), $('sec-ts'), $('sec-map'), $('sec-breakdown')];
/** Sections fed by the link itself. */
const linkSections = () => [$('link-panel'), $('kpi-life')];

function setAllLoading(on) {
  setLoading([...linkSections(), ...statsSections(), $('sec-feed')], on);
}

function ensureCharts() {
  if (charts) return charts;
  charts = {
    ts: createTimeseriesChart($('ts-chart')),
    map: createWorldMap($('map'), { legend: $('map-legend-scale') }),
    feed: createFeed($('feed'), { emptyNode: $('feed-empty'), countNode: $('feed-count') }),
  };
  return charts;
}

// ---------------------------------------------------------------------------
// Routing (dashboard.html#<slug>)
// ---------------------------------------------------------------------------
function slugFromHash() {
  let raw = location.hash.replace(/^#/, '');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* keep the raw value; it fails validation below */
  }
  return raw.trim().toLowerCase();
}

/** Accepts a bare slug, a short URL (cat.ly/x, http://localhost:3030/x) or a dashboard/QR URL (...#x). */
function extractSlug(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  const hashAt = s.indexOf('#');
  if (hashAt !== -1) {
    s = s.slice(hashAt + 1);
  } else {
    s = s.replace(/[?].*$/, '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const parts = s.split('/').filter(Boolean);
    s = parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
  }
  try {
    s = decodeURIComponent(s);
  } catch {
    /* leave as-is */
  }
  return s.trim().toLowerCase();
}

function loadConfig() {
  if (!state.configPromise) {
    state.configPromise = api.config().catch((err) => {
      console.warn('Blip config unavailable', err);
      state.configPromise = null;
      return null;
    });
  }
  return state.configPromise;
}

async function route() {
  stopLive();
  const gen = ++state.gen;
  resetLinkState();

  const slug = slugFromHash();
  if (!slug) {
    showGate('pick');
    return;
  }
  if (!SLUG_RE.test(slug)) {
    showGate('invalid', { slug });
    return;
  }
  state.slug = slug;
  const token = linkStore.tokenFor(slug);
  if (!token) {
    showGate('token', { slug });
    return;
  }
  state.token = token;
  showView('app');
  setAllLoading(true);

  try {
    // d3 is a deferred script after this module: wait for it here (a failed load is retried once,
    // and again on every Retry) so the gate never waits on it.
    const [config, res] = await Promise.all([
      loadConfig(),
      api.getLink(slug, token),
      loadLib('d3').catch((err) => console.error(err)),
    ]);
    if (gen !== state.gen) return;
    if (!d3Ready()) throw new Error('charts-unavailable');
    state.config = config;
    state.link = res.link;
    ensureCharts();
    setLoading(linkSections(), false);
    renderLink();
    setupDemoControls();
    renderRangeText();
    await loadStats({ throwOnError: true });
    if (gen !== state.gen) return;
    state.catchUp = true;
    openStream();
    startTimers();
  } catch (err) {
    if (gen !== state.gen) return;
    handleLoadError(err);
  }
}

function resetLinkState() {
  state.slug = null;
  state.token = null;
  state.link = null;
  state.stats = null;
  state.allTime = null;
  state.expiryCheck = null;
  state.failedRange = null;
  state.catchUp = false;
  $('stats-error').hidden = true;
  $('empty-banner').hidden = true;
  $('sim-notice').hidden = true;
  if (charts) {
    charts.feed.reset([]);
    charts.map.clearPings();
  }
  for (const id of ['kpi-clicks-value', 'kpi-unique-value', 'kpi-24h-value', 'kpi-bots-value']) $(id).textContent = '0';
  $('map-sub').textContent = MAP_SUB_DEFAULT;
  $('nav-dashboard').href = '/dashboard.html';
  $('nav-qr').href = '/qr.html';
}

/** Close the stream and stop timers and requests for the current link. */
function stopLive() {
  state.stream?.close();
  state.stream = null;
  state.statsCtrl?.abort();
  state.statsCtrl = null;
  scheduleRefresh.cancel();
  clearInterval(state.lifeTimer);
  clearInterval(state.feedTimer);
  state.lifeTimer = 0;
  state.feedTimer = 0;
}

function handleLoadError(err) {
  stopLive();
  const slug = state.slug;
  if (err instanceof ApiError) {
    if (err.status === 404 && slug) {
      linkStore.remove(slug);
      showGate('missing', { slug });
      return;
    }
    if (err.status === 401 || err.status === 403) {
      showGate('token', {
        slug,
        error: err.status === 403 ? 'The manage key saved in this browser no longer matches this link. Paste the right one to continue.' : '',
      });
      return;
    }
  }
  let text = err?.message || 'Something went wrong while loading the dashboard.';
  if (err?.message === 'charts-unavailable') text = "The chart library didn't load. Check your connection and try again.";
  showError(text);
}

function showError(text) {
  showView('error');
  $('error-text').textContent = text;
  document.title = DEFAULT_TITLE;
}

// ---------------------------------------------------------------------------
// Gate: pick a link or paste a manage key
// ---------------------------------------------------------------------------
function setGateError(message, field = null) {
  const node = $('gate-error');
  node.textContent = message || '';
  node.hidden = !message;
  $('gate-slug').setAttribute('aria-invalid', field === 'slug' ? 'true' : 'false');
  $('gate-token').setAttribute('aria-invalid', field === 'token' ? 'true' : 'false');
}

function renderGateLinks(currentSlug) {
  const links = linkStore.all().filter((l) => SLUG_RE.test(l.slug));
  $('gate-links').hidden = links.length === 0;
  $('gate-links-list').replaceChildren(
    ...links.map((l) => el(
      'li',
      {},
      el(
        'a',
        { class: 'gate-link', href: `#${l.slug}`, 'aria-current': l.slug === currentSlug ? 'page' : null },
        el('span', { class: 'gate-link__icon', 'aria-hidden': 'true' }, icon('activity', { class: 'icon icon--sm' })),
        el('span', { class: 'gate-link__slug' }, l.slug),
        el('span', { class: 'gate-link__when' }, l.createdAt ? formatRelative(l.createdAt) : ''),
        el('span', { class: 'gate-link__go', 'aria-hidden': 'true' }, icon('arrow-right', { class: 'icon icon--sm' })),
      ),
    )),
  );
}

function showGate(mode, { slug = '', error = '' } = {}) {
  showView('gate');
  document.title = DEFAULT_TITLE;
  const title = $('gate-title');
  const text = $('gate-text');
  $('gate-slug').value = slug;
  $('gate-token').value = '';
  document.body.dataset.gate = mode;

  if (mode === 'token') {
    title.textContent = 'Unlock this dashboard';
    text.textContent = `Dashboards are private. Paste the manage key for "${slug}" (use Copy key on the result card, or the key button in My links, on the device where you made it). It stays in this browser only.`;
  } else if (mode === 'missing') {
    title.textContent = 'This Blip has vanished';
    text.textContent = `There's no link at "${slug}" any more. It may have been deleted. Pick another link or make a new one.`;
  } else if (mode === 'invalid') {
    title.textContent = "That doesn't look like a Blip link";
    text.textContent = 'Slugs use lowercase letters, numbers and dashes. Paste a short URL or slug below.';
  } else {
    title.textContent = 'Open a live dashboard';
    text.textContent = 'Every Blip link gets its own live analytics. Dashboards are private: your browser keeps the manage key for each link you create.';
  }
  setGateError(error, error ? 'token' : null);
  renderGateLinks(slug);

  if (mode === 'token') $('gate-token').focus();
  else if (mode === 'invalid') $('gate-slug').focus();
}

async function onTokenSubmit(event) {
  event.preventDefault();
  const slug = extractSlug($('gate-slug').value);
  const token = $('gate-token').value.trim();
  if (!slug) {
    setGateError("Enter the link's slug or short URL.", 'slug');
    $('gate-slug').focus();
    return;
  }
  if (!SLUG_RE.test(slug)) {
    setGateError('Slugs use lowercase letters, numbers and dashes (for example summer-sale-2026).', 'slug');
    $('gate-slug').focus();
    return;
  }
  if (!token) {
    setGateError('Paste the manage key for this link.', 'token');
    $('gate-token').focus();
    return;
  }

  const button = $('gate-submit');
  setBusy(button, true);
  setGateError('');
  try {
    const { link } = await api.getLink(slug, token);
    const saved = linkStore.add({ slug, token, createdAt: Date.parse(link?.createdAt) || Date.now() });
    toast(saved ? 'Manage key saved in this browser.' : "Unlocked, but this browser couldn't save the manage key, so you'll need it again next time.", { type: saved ? 'success' : 'info' });
    if (slugFromHash() === slug) route();
    else location.hash = slug;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) setGateError("That manage key doesn't match this link. Check you copied all of it.", 'token');
    else if (err instanceof ApiError && err.status === 404) setGateError(`No Blip link uses "${slug}".`, 'slug');
    else setGateError(err?.message || 'Something went wrong. Try again.');
  } finally {
    setBusy(button, false);
  }
}

// ---------------------------------------------------------------------------
// Link header + lifetime cell
// ---------------------------------------------------------------------------
const STATUS_TEXT = { active: 'Active', expired: 'Expired', destroyed: 'Self-destructed' };

function workingUrl(link) {
  return link?.qrUrl || link?.workingUrl || '';
}

function setSafeHref(anchor, url) {
  if (/^https?:\/\//i.test(url || '')) anchor.href = url;
  else anchor.removeAttribute('href');
}

/** An active link with a click limit: every real visit, the owner's own included, uses one up. */
function isClickLimited(link) {
  return Boolean(link) && link.status === 'active' && link.maxClicks !== null && link.maxClicks !== undefined;
}

function clicksLeft(link) {
  return link.clicksRemaining ?? Math.max(0, link.maxClicks - (link.clickCount || 0));
}

/** Visible note (and accessible description) on the controls that visit the counted short URL. */
function renderOpenHint() {
  const link = state.link;
  const limited = isClickLimited(link);
  const hint = $('open-hint');
  hint.hidden = !limited;
  if (limited) {
    const left = clicksLeft(link);
    $('open-hint-text').textContent = left <= 1
      ? 'Opening it yourself uses its last click, and then it self-destructs'
      : `Opening it yourself uses 1 of its ${formatNumber(left)} remaining clicks`;
  }
  for (const id of ['btn-open', 'link-working-url']) {
    if (limited) $(id).setAttribute('aria-describedby', 'open-hint');
    else $(id).removeAttribute('aria-describedby');
  }
  $('btn-open').title = limited
    ? 'Open the short link in a new tab (asks first, because a visit uses up a click)'
    : 'Open the short link in a new tab';
}

/**
 * Click or middle-click on a control that visits the short URL. Unlimited (or already expired) links open
 * normally; for click-limited links the owner confirms first, as on the home page.
 */
async function guardedOpen(event) {
  const link = state.link;
  if (!isClickLimited(link)) return;
  if (event.type === 'auxclick' && event.button !== 1) return;
  const url = event.currentTarget.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(url)) return;
  event.preventDefault();

  const left = clicksLeft(link);
  const ok = await confirmDialog({
    title: 'Use up a click?',
    text: left <= 1
      ? `Opening it yourself counts as a visit, and this is its last click (of ${formatNumber(link.maxClicks)}). Once it's used, the link self-destructs for everyone else.`
      : `Opening it yourself counts as a visit: ${formatNumber(left)} of ${formatNumber(link.maxClicks)} left. When they're gone, the link self-destructs.`,
    confirmLabel: 'Open anyway',
    tone: 'primary',
    iconName: 'mouse-pointer-click',
  });
  if (!ok) return;
  const gen = state.gen;
  window.open(url, '_blank', 'noopener,noreferrer');
  // The stream reports the visit; without it, fetch again once the visit has had time to land.
  setTimeout(() => {
    if (gen === state.gen && state.liveStatus !== 'open') refresh();
  }, 2500);
}

function renderLink() {
  const link = state.link;
  if (!link) return;
  const display = String(link.shortUrl || '').replace(/^https?:\/\//i, '');
  // A long URL wraps after the domain's slash: the slug moves to the next line as one piece.
  const cut = display.lastIndexOf('/') + 1;
  $('link-short').replaceChildren(
    ...(cut > 0 && cut < display.length ? [display.slice(0, cut), el('span', { class: 'link-panel__slug' }, display.slice(cut))] : [display]),
  );
  $('link-title').title = link.shortUrl || '';
  document.title = `${display} · Live dashboard · Blip`;

  const name = $('link-name');
  name.textContent = link.title || '';
  name.hidden = !link.title;

  const status = $('link-status');
  status.className = `badge badge--${link.status === 'active' ? 'active' : link.status === 'destroyed' ? 'destroyed' : 'expired'}`;
  status.textContent = STATUS_TEXT[link.status] || link.status;

  const domain = $('link-domain');
  domain.className = `badge ${link.domainLive ? 'badge--live' : 'badge--vanity'}`;
  domain.textContent = link.domainLive ? 'Live domain' : 'Vanity domain';
  domain.title = link.domainLive ? `${link.domain} serves this link` : `Point ${link.domain}'s DNS at your Blip server to make it live`;

  const teaser = $('link-teaser');
  teaser.hidden = link.redirectMode !== 'teaser';
  if (link.redirectMode === 'teaser' && link.teaser) {
    const style = { countdown: 'countdown', trivia: 'trivia', brand: 'brand message' }[link.teaser.style] || link.teaser.style;
    teaser.textContent = `Teaser: ${link.teaser.seconds}s ${style}`;
  }

  const created = $('link-created');
  created.dateTime = link.createdAt;
  created.textContent = formatRelative(link.createdAt);
  created.title = formatDateTime(link.createdAt);

  const target = $('link-target');
  target.textContent = link.targetUrl;
  setSafeHref(target, link.targetUrl);

  const working = $('link-working');
  working.hidden = Boolean(link.domainLive);
  if (!link.domainLive) {
    const a = $('link-working-url');
    a.textContent = String(link.workingUrl || '').replace(/^https?:\/\//i, '');
    setSafeHref(a, link.workingUrl);
  }

  const gone = $('link-gone');
  gone.hidden = link.status === 'active';
  if (link.status !== 'active') {
    let text;
    let how;
    if (link.status === 'destroyed' || link.expiredReason === 'manual') {
      text = 'Self-destructed by its owner. Visitors now see the self-destruct page, and blocked attempts still show up here.';
      how = 'Undo Destroy now, and change its time or click limit if you like';
    } else if (link.expiredReason === 'clicks') {
      text = `It used up ${link.maxClicks === 1 ? 'its only click' : `all ${plural(link.maxClicks ?? 0, 'click', 'clicks')}`}. Visitors now see the self-destruct page.`;
      how = 'Raise or remove its click limit so it works again';
    } else {
      text = `Its timer ran out on ${formatDateTime(link.expiresAt)}. Visitors now see the self-destruct page.`;
      how = 'Give it a new self-destruct time, or none, so it works again';
    }
    $('link-gone-text').textContent = text;
    $('btn-bring-back').title = how;
  }

  setSafeHref($('btn-open'), workingUrl(link));
  renderOpenHint();
  $('btn-qr').href = `/qr.html#${link.slug}`;
  $('nav-dashboard').href = `/dashboard.html#${link.slug}`;
  $('nav-qr').href = `/qr.html#${link.slug}`;

  renderLifeKpi();
}

function renderLifeKpi() {
  const link = state.link;
  if (!link) return;
  const cell = $('kpi-life');
  const label = $('kpi-life-label');
  const value = $('kpi-life-value');
  const sub = $('kpi-life-sub');
  const meter = $('kpi-life-meter');
  const fill = $('kpi-life-meter-fill');
  const now = Date.now();
  const expiresAt = link.expiresAt ? Date.parse(link.expiresAt) : null;
  const hasMax = link.maxClicks !== null && link.maxClicks !== undefined;
  let meterPct = null;
  let meterText = '';

  cell.dataset.state = link.status;
  if (link.status === 'destroyed' || (link.status === 'expired' && link.expiredReason === 'manual')) {
    label.textContent = 'Self-destructed';
    value.textContent = 'Gone';
    sub.textContent = 'The owner hit Destroy now';
  } else if (link.status === 'expired') {
    label.textContent = 'Self-destructed';
    value.textContent = 'Expired';
    sub.textContent = link.expiredReason === 'clicks'
      ? `Hit its ${plural(link.maxClicks ?? 0, 'click', 'click')} limit`
      : `Timer ran out ${formatDateTime(link.expiresAt)}`;
    meterPct = 100;
    meterText = 'Used up';
  } else if (hasMax) {
    const remaining = clicksLeft(link);
    label.textContent = 'Clicks remaining';
    value.textContent = formatNumber(remaining);
    sub.textContent = `of ${formatNumber(link.maxClicks)}${expiresAt ? `, or ${formatDuration(expiresAt - now)} left` : ''}`;
    meterPct = link.maxClicks > 0 ? ((link.maxClicks - remaining) / link.maxClicks) * 100 : 100;
    meterText = `${formatNumber(link.maxClicks - remaining)} of ${formatNumber(link.maxClicks)} clicks used`;
  } else if (expiresAt) {
    label.textContent = 'Expires in';
    value.textContent = formatDuration(expiresAt - now);
    sub.textContent = formatDateTime(link.expiresAt);
    const created = Date.parse(link.createdAt);
    meterPct = Number.isFinite(created) && expiresAt > created ? ((now - created) / (expiresAt - created)) * 100 : 0;
    meterText = `${Math.round(Math.min(100, Math.max(0, meterPct)))}% of its lifetime used`;
  } else {
    label.textContent = 'Lifetime';
    value.textContent = 'Forever';
    sub.textContent = 'Never self-destructs';
  }

  meter.hidden = meterPct === null;
  if (meterPct !== null) {
    const p = Math.round(Math.min(100, Math.max(0, meterPct)));
    fill.style.width = `${p}%`;
    meter.setAttribute('aria-valuenow', String(p));
    meter.setAttribute('aria-valuetext', meterText);
    meter.dataset.level = p >= 85 ? 'high' : p >= 60 ? 'mid' : 'low';
  }
}

// ---------------------------------------------------------------------------
// Edit settings and Bring back (the shared dialog, SPEC 10.1 and 10.2)
// ---------------------------------------------------------------------------
/** A save in the dialog: the header, Lifetime cell and open hint follow the new link, and the stats refresh. */
function applySavedLink(link) {
  state.link = link;
  state.expiryCheck = null;
  renderLink();
  scheduleRefresh.cancel();
  loadStats();
}

/** Usable focus target: still in the page and rendered (a hidden Bring back button is not). */
const isFocusable = (node) => Boolean(node && node !== document.body && node.isConnected && node.getClientRects().length > 0);

/**
 * Open Edit settings for the link on screen. focus: 'general' | 'domain' | 'teaser' | 'destruct'
 * (Bring back opens at 'destruct'). Live status toasts wait while the dialog is open, because its own
 * confirmation (announceSaved) reports the outcome of a save.
 */
async function editSettings(focus = 'general') {
  const link = state.link;
  const token = state.token;
  if (!link || !token || state.editing) return;
  const gen = state.gen;
  // The dialog keeps its own copy: live clicks update state.link while it is open.
  const before = structuredClone(link);
  state.editing = true;
  let saved = null;
  try {
    saved = await openEditSettings(before, token, {
      config: state.config || undefined,
      focus,
      onSaved: (updated) => {
        if (gen === state.gen) applySavedLink(updated);
      },
    });
  } finally {
    state.editing = false;
  }
  if (gen !== state.gen) return;
  if (saved) announceSaved(before, saved);
  else if (state.link && state.link.status !== before.status) announceStatus(state.link.status);
  // Bring back hides once the link works again: hand focus to Edit settings rather than lose it.
  if (!isFocusable(document.activeElement) && !$('view-app').hidden) $('btn-edit').focus();
}

/** Re-check delays once the local clock says a timed link has run out (then every 30 s). */
const EXPIRY_RECHECK_MS = [3000, 6000, 12000, 24000, 30000];

function tickLife() {
  const link = state.link;
  if (!link || link.status !== 'active' || !link.expiresAt) {
    state.expiryCheck = null;
    return;
  }
  const now = Date.now();
  if (Date.parse(link.expiresAt) > now) {
    state.expiryCheck = null;
    renderLifeKpi();
    return;
  }
  // The local timer has run out but the server hasn't reported the link as expired yet. Ask once
  // right away, then back off: a device clock that runs ahead must not turn into a request loop.
  // The chain stops when the status changes, the expiry moves, or the clock no longer says it's due.
  let check = state.expiryCheck;
  if (!check || check.expiresAt !== link.expiresAt) {
    check = { expiresAt: link.expiresAt, attempt: 0, nextAt: now };
    state.expiryCheck = check;
  }
  if (now < check.nextAt) return;
  check.nextAt = now + EXPIRY_RECHECK_MS[Math.min(check.attempt, EXPIRY_RECHECK_MS.length - 1)];
  check.attempt += 1;
  refresh();
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
/**
 * Fetch stats for the selected range. `skeleton` swaps the stats sections for their skeletons while the
 * request runs (first load and range changes); live refreshes keep the current numbers on screen.
 */
async function loadStats({ skeleton = false, throwOnError = false } = {}) {
  if (!state.slug || !state.token) return;
  const gen = state.gen;
  state.statsCtrl?.abort();
  const ctrl = new AbortController();
  state.statsCtrl = ctrl;
  const range = state.range;
  if (skeleton) {
    setLoading(statsSections(), true);
    // Labels name the range being loaded, never the one whose numbers just went behind the skeletons.
    renderRangeText(range);
    $('map-sub').textContent = MAP_SUB_DEFAULT;
  }
  const tz = new Date().getTimezoneOffset();
  try {
    const stats = await api.stats(state.slug, state.token, { range, tz, signal: ctrl.signal });
    if (gen !== state.gen || ctrl.signal.aborted) return;
    state.stats = stats;
    state.statsTz = tz;
    state.failedRange = null;
    $('stats-error').hidden = true;
    // Reveal first so the charts measure their real size when they draw.
    setLoading([...statsSections(), $('sec-feed')], false);
    renderStats();
  } catch (err) {
    if (err?.name === 'AbortError' || gen !== state.gen) return;
    if (throwOnError) throw err;
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
      handleLoadError(err);
      return;
    }
    // A background refresh can replace a range-change request; if the skeletons are still up, treat
    // its failure like a failed range change so the sections never stay stuck on skeletons.
    if (skeleton || $('sec-ts').classList.contains('is-loading')) showStatsError(range, err);
    else toast(err?.message || "Couldn't refresh the stats.", { type: 'error' });
  } finally {
    if (state.statsCtrl === ctrl) state.statsCtrl = null;
  }
}

/** A range change failed: put the previous range (still on screen) back and offer a retry. */
function showStatsError(range, err) {
  const shown = state.stats?.range || '7d';
  state.failedRange = range;
  state.range = shown;
  rangeControl?.set(shown);
  writePref(RANGE_KEY, shown);
  renderRangeText();
  renderMapSub();
  setLoading(statsSections(), false);
  // API and network messages are full sentences already; give a bare one its full stop.
  const reason = String(err?.message || 'Something went wrong.').trim();
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  const what = (r) => (r === 'all' ? 'all-time stats' : `the ${RANGE_LABELS[r] || r}`);
  $('stats-error-text').textContent = `Couldn't load ${what(range)}. ${sentence} Still showing ${what(shown)}.`;
  $('stats-error').hidden = false;
}

function retryStats() {
  const range = state.failedRange;
  $('stats-error').hidden = true;
  if (range && RANGES.includes(range) && range !== state.range) {
    rangeControl?.set(range, { notify: true }); // the range control's handler loads it
    return;
  }
  loadStats({ skeleton: true });
}

/** Fetch link + stats again (after live clicks, status changes, clears, expiry). */
async function refresh() {
  if (!state.slug || !state.token) return;
  const gen = state.gen;
  const [linkRes] = await Promise.allSettled([api.getLink(state.slug, state.token), loadStats()]);
  if (gen !== state.gen) return;
  if (linkRes.status === 'fulfilled' && linkRes.value?.link) {
    state.link = linkRes.value.link;
    renderLink();
  }
}

const scheduleRefresh = createDebounce(() => { refresh(); }, 1500);

function rangeStart() {
  const s = state.stats;
  if (!s || s.range === 'all') return -Infinity;
  const first = s.timeseries?.points?.[0]?.t;
  const t = first ? Date.parse(first) : NaN;
  if (Number.isFinite(t)) return t;
  return Date.now() - ({ '24h': 1, '7d': 7, '30d': 30 }[s.range] || 7) * DAY;
}

/**
 * Range wording in the KPI labels and section subtitles. Defaults to the range of the stats on screen;
 * a range change passes the range it is loading.
 */
function renderRangeText(range = state.stats?.range || state.range) {
  const shown = state.stats?.range === range ? state.stats.timeseries?.bucket : null;
  let sub;
  if (range === 'all') {
    // All time has no cap: the server buckets by day, week or month depending on the link's age, so
    // the bucket is only named once those stats are on screen.
    sub = shown ? `${BUCKET_ADVERBS[bucketOf(shown)]}, every click since the link was made` : 'Every click since the link was made';
  } else {
    sub = `${BUCKET_ADVERBS[shown ? bucketOf(shown) : range === '24h' ? 'hour' : 'day']}, ${RANGE_LABELS[range] || range}`;
  }
  $('ts-sub').textContent = sub;
  $('kpi-clicks-label').textContent = `Clicks, ${RANGE_SHORT[range] || range}`;
  $('kpi-unique-label').textContent = `Unique visitors, ${RANGE_SHORT[range] || range}`;
  $('bd-sub').textContent = `Who clicked, on what, and from where (${RANGE_LABELS[range] || range})`;
}

function renderKpis() {
  const t = state.stats?.totals;
  if (!t) return;
  const range = state.stats.range;
  $('kpi-clicks-value').textContent = formatNumber(t.clicks);
  const clicksSub = $('kpi-clicks-sub');
  if (range !== 'all' && state.allTime) clicksSub.textContent = `${formatNumber(state.allTime.clicks)} all time`;
  else if (t.syntheticClicks > 0) clicksSub.textContent = `Includes ${formatNumber(t.syntheticClicks)} simulated`;
  else clicksSub.textContent = range === 'all' ? 'Since the link was made' : 'Real visits, bots left out';

  $('kpi-unique-value').textContent = formatNumber(t.uniqueVisitors);
  $('kpi-unique-sub').textContent = t.uniqueVisitors > 0
    ? `${(t.clicks / t.uniqueVisitors).toFixed(1)} clicks per visitor`
    : 'Hashed IDs, never IP addresses';

  $('kpi-24h-value').textContent = formatNumber(t.last24h);

  // botClicks (is_bot=1) and blockedAfterExpiry (outcome='expired') overlap: a bot hitting an expired
  // link is in both. Count each request once (as blocked) using the overlap the API reports.
  const bots = Math.max(0, Number(t.botClicks) || 0);
  const blocked = Math.max(0, Number(t.blockedAfterExpiry) || 0);
  const overlap = Math.min(bots, blocked, Math.max(0, Number(t.expiredBotClicks) || 0));
  const liveBots = bots - overlap;
  $('kpi-bots-value').textContent = formatNumber(liveBots + blocked);
  $('kpi-bots-sub').textContent = `${plural(liveBots, 'bot', 'bots')}, ${formatNumber(blocked)} blocked after self-destruct. Not counted as clicks.`;
}

function renderTsTable() {
  const s = state.stats;
  const bucket = bucketOf(s.timeseries?.bucket);
  const points = Array.isArray(s.timeseries?.points) ? s.timeseries.points : [];
  $('ts-caption').textContent = `Clicks per ${bucket}, ${RANGE_LABELS[s.range] || s.range}, newest first`;
  $('ts-table-body').replaceChildren(
    ...points.slice().reverse().map((p) => el(
      'tr',
      {},
      el('th', { scope: 'row' }, bucketLabel(wallClock(p.t, state.statsTz), bucket)),
      el('td', { class: 'num' }, formatNumber(p.clicks)),
    )),
  );
}

function renderStats() {
  const s = state.stats;
  if (!s || !charts) return;
  renderRangeText();
  renderKpis();

  charts.ts.update(s.timeseries?.points || [], s.timeseries?.bucket, { rangeLabel: RANGE_LABELS[s.range] || '', tz: state.statsTz });
  renderTsTable();

  charts.map.update(s.countries, s.points);
  renderMapSub();

  renderDevices($('devices-list'), s.devices, { emptyNode: $('devices-empty') });
  renderBars($('browsers-list'), s.browsers, { emptyNode: $('browsers-empty') });
  renderBars($('os-list'), s.os, { emptyNode: $('os-empty') });
  renderBars($('ref-list'), s.referrers, { emptyNode: $('ref-empty'), label: referrerLabel, lead: referrerLead });
  renderCountries($('countries-list'), s.countries, { emptyNode: $('countries-empty') });

  charts.feed.merge(s.recent);
  renderSynthetic();
  renderEmptyBanner();
}

/** Map subtitle: how many countries and places the stats on screen cover. */
function renderMapSub() {
  const s = state.stats;
  const located = (s?.countries || []).filter((c) => c?.code && c.count > 0).length;
  const places = (s?.points || []).length;
  $('map-sub').textContent = located
    ? `${plural(located, 'country', 'countries')} and ${plural(places, 'place', 'places')}, live clicks pop up as they land`
    : MAP_SUB_DEFAULT;
}

function renderEmptyBanner() {
  const s = state.stats;
  const t = s?.totals;
  const banner = $('empty-banner');
  const none = Boolean(t) && !t.clicks && !t.botClicks && !t.blockedAfterExpiry;
  banner.hidden = !none;
  if (!none) return;
  const allow = Boolean(state.config?.allowDemoTraffic);
  const olderClicks = s.range !== 'all' && (state.allTime?.clicks || 0) > 0;
  $('empty-title').textContent = olderClicks ? `No clicks in the ${RANGE_LABELS[s.range]}` : 'No clicks yet';
  $('empty-text').textContent = olderClicks
    ? 'This link has older clicks. Switch to all time to see them.'
    : allow
      ? 'Share your link, or simulate some traffic to preview the dashboard.'
      : 'Share your link. Visits show up here the moment someone opens it.';
  $('empty-simulate').hidden = !allow || olderClicks;
  $('empty-all').hidden = !olderClicks;
}

// ---------------------------------------------------------------------------
// Simulated (demo) traffic
// ---------------------------------------------------------------------------
function setupDemoControls() {
  $('demo-controls').hidden = !state.config?.allowDemoTraffic;
  renderSynthetic();
}

function renderSynthetic() {
  const inRange = state.stats?.totals?.syntheticClicks || 0;
  const allTime = state.allTime?.syntheticClicks || 0;
  const has = inRange > 0 || allTime > 0;
  $('sim-notice').hidden = !has;
  $('sim-chip-text').textContent = inRange > 0
    ? `Includes ${plural(inRange, 'simulated click', 'simulated clicks')}`
    : `${plural(allTime, 'simulated click', 'simulated clicks')} outside this range`;
}

function setBusy(button, busy) {
  if (!button) return;
  button.classList.toggle('is-loading', busy);
  button.disabled = busy;
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

async function simulate(button) {
  if (!state.slug || !state.token) return;
  const count = Number(state.simCount) || 25;
  setBusy(button, true);
  try {
    const res = await api.simulate(state.slug, state.token, count);
    const inserted = Number(res?.inserted ?? count);
    toast(`Simulating ${plural(inserted, 'demo click', 'demo clicks')}. Watch them land on the map.`, { type: 'success' });
    if (state.liveStatus !== 'open') scheduleRefresh();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      toast("Simulated traffic isn't available: demo traffic is turned off on this server.", { type: 'error' });
      if (state.config) state.config.allowDemoTraffic = false;
      setupDemoControls();
      renderEmptyBanner();
    } else {
      toast(err?.message || "Couldn't simulate traffic.", { type: 'error' });
    }
  } finally {
    setBusy(button, false);
  }
}

/** Promise<boolean> confirm on the page's <dialog>. tone: 'danger' | 'primary' styles the confirm button. */
function confirmDialog({ title, text, confirmLabel, tone = 'danger', iconName = 'eraser' }) {
  const dialog = $('confirm-dialog');
  if (typeof dialog.showModal !== 'function') return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  if (dialog.open) return Promise.resolve(false);
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  const ok = $('confirm-ok');
  ok.className = `btn ${tone === 'primary' ? 'btn--primary' : 'btn--danger'}`;
  ok.replaceChildren(icon(iconName), el('span', { id: 'confirm-ok-label' }, confirmLabel));
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    const form = dialog.querySelector('form');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      form?.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('close', onClose);
      resolve(value);
    };
    // Settle on the button press itself, so a follow-up window.open() still runs inside that user
    // gesture (the dialog's `close` event is dispatched later, with the next rendered frame).
    // Escape and older browsers without `submitter` fall back to `close`.
    const onSubmit = (event) => {
      if (event.submitter) finish(event.submitter.value === 'confirm');
    };
    const onClose = () => {
      // A late `close` from an earlier round can arrive after the dialog was opened again: ignore it.
      if (!dialog.open) finish(dialog.returnValue === 'confirm');
    };
    form?.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose);
  });
}

async function clearSimulated() {
  if (!state.slug || !state.token) return;
  const n = Math.max(state.allTime?.syntheticClicks || 0, state.stats?.totals?.syntheticClicks || 0);
  const ok = await confirmDialog({
    title: 'Clear simulated clicks?',
    text: `This removes ${n ? plural(n, 'simulated click', 'simulated clicks') : 'all simulated clicks'} from this link's stats. Real clicks stay untouched.`,
    confirmLabel: 'Clear simulated',
  });
  if (!ok) return;
  const button = $('btn-clear-sim');
  setBusy(button, true);
  try {
    const res = await api.clearSimulated(state.slug, state.token);
    const deleted = Number(res?.deleted ?? 0);
    toast(deleted ? `Cleared ${plural(deleted, 'simulated click', 'simulated clicks')}.` : 'There were no simulated clicks to clear.', { type: 'success' });
    if (state.allTime) {
      state.allTime.clicks = Math.max(0, state.allTime.clicks - deleted);
      state.allTime.syntheticClicks = 0;
    }
    charts?.feed.removeWhere((evt) => evt.isSynthetic);
    scheduleRefresh.cancel();
    await refresh();
  } catch (err) {
    toast(err?.message || "Couldn't clear simulated clicks.", { type: 'error' });
  } finally {
    setBusy(button, false);
  }
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------
// caption: the caption box variant; dot: the .live-dot modifier.
const LIVE_STATES = {
  idle: { caption: 'paper', dot: 'off', label: 'Offline', state: 'offline', hint: 'Not connected' },
  connecting: { caption: 'paper', dot: 'warn', label: 'Connecting', state: 'connecting', hint: 'Connecting to the live click stream' },
  open: { caption: '', dot: '', label: 'Live', state: 'open', hint: 'Connected: new clicks appear instantly' },
  reconnecting: { caption: 'paper', dot: 'warn', label: 'Reconnecting', state: 'reconnecting', hint: 'The connection dropped. Retrying.' },
  denied: { caption: 'paper', dot: 'off', label: 'Offline', state: 'offline', hint: 'Live updates stopped: the link or its manage key changed' },
  closed: { caption: 'paper', dot: 'off', label: 'Offline', state: 'offline', hint: 'Live updates paused' },
};

function setLiveStatus(status) {
  const prev = state.liveStatus;
  state.liveStatus = status;
  const s = LIVE_STATES[status] || LIVE_STATES.idle;
  const box = $('live-indicator');
  box.className = `caption live-caption${s.caption ? ` caption--${s.caption}` : ''}`;
  box.dataset.state = s.state;
  box.title = s.hint;
  $('live-dot').className = `live-dot${s.dot ? ` live-dot--${s.dot}` : ''}`;
  $('live-label').textContent = s.label;
  if (status === 'open' && prev === 'reconnecting') scheduleRefresh();
  if (status === 'denied' && prev !== 'denied') {
    toast('Live updates stopped. This link may have been deleted, or its manage key changed.', { type: 'error', timeout: 4200 });
  }
}

function openStream() {
  if (!state.slug || !state.token) return;
  state.stream?.close();
  const gen = state.gen;
  state.stream = api.stream(state.slug, state.token, {
    onEvent: (type, data) => {
      if (gen === state.gen) handleStreamEvent(type, data);
    },
    onStatus: (status) => {
      if (gen === state.gen) setLiveStatus(status);
    },
  });
}

function handleStreamEvent(type, data) {
  if (!data || typeof data !== 'object') return;
  if (type === 'hello') {
    const t = data.totals || {};
    state.allTime = {
      clicks: Number(t.clicks) || 0,
      uniqueVisitors: Number(t.uniqueVisitors) || 0,
      syntheticClicks: Number(t.syntheticClicks) || 0,
    };
    renderKpis();
    renderSynthetic();
    renderEmptyBanner();
    // Clicks or a status change that landed between the first fetch and the stream connecting were
    // never streamed to us: fetch once more so the snapshot catches up.
    if (state.catchUp) {
      state.catchUp = false;
      refresh();
    }
  } else if (type === 'click') {
    handleLiveClick(data);
  } else if (type === 'status') {
    handleLiveStatus(data);
  }
}

function handleLiveClick(evt) {
  const counted = isCountedClick(evt);
  const ts = Date.parse(evt.ts);

  if (!state.allTime) state.allTime = { clicks: 0, uniqueVisitors: 0, syntheticClicks: 0 };
  const runningTotal = Number(evt.totals?.clicks);
  const hasRunningTotal = evt.totals && Number.isFinite(runningTotal);
  // A click stored before the stats snapshot was read is already in `stats` (and in the link's count).
  const statsThrough = Number(state.stats?.throughClickId);
  const alreadyCounted = Number.isFinite(statsThrough) && Number(evt.id) <= statsThrough;
  if (hasRunningTotal) {
    // Running totals of staggered events can lag behind what `hello` reported: never move backwards.
    state.allTime.clicks = Math.max(state.allTime.clicks, runningTotal);
    const uniques = Number(evt.totals.uniqueVisitors);
    if (Number.isFinite(uniques)) state.allTime.uniqueVisitors = Math.max(state.allTime.uniqueVisitors, uniques);
  } else if (counted) {
    state.allTime.clicks += 1;
  }
  // Every streamed click came after the stream's `hello`, so the all-time numbers always take it.
  if (counted && evt.isSynthetic) state.allTime.syntheticClicks += 1;

  const t = alreadyCounted ? null : state.stats?.totals;
  if (t) {
    const inRange = Number.isFinite(ts) ? ts >= rangeStart() : true;
    if (counted && inRange) {
      t.clicks += 1;
      if (evt.isUnique) t.uniqueVisitors += 1;
      if (evt.isSynthetic) t.syntheticClicks = (t.syntheticClicks || 0) + 1;
    }
    if (counted && Number.isFinite(ts) && Date.now() - ts < DAY) t.last24h += 1;
    // Mirror the server's (overlapping) counters; renderKpis() counts a blocked bot only once.
    const blockedAttempt = evt.outcome === 'expired';
    if (inRange && (evt.isBot || blockedAttempt)) {
      if (evt.isBot) t.botClicks = (t.botClicks || 0) + 1;
      if (blockedAttempt) t.blockedAfterExpiry = (t.blockedAfterExpiry || 0) + 1;
      if (evt.isBot && blockedAttempt) t.expiredBotClicks = (t.expiredBotClicks || 0) + 1;
    }
  }
  renderKpis();
  renderSynthetic();
  renderEmptyBanner();

  const link = state.link;
  if (counted && !alreadyCounted && !evt.isSynthetic && link && link.status === 'active') {
    link.clickCount = (link.clickCount || 0) + 1;
    if (link.maxClicks !== null && link.maxClicks !== undefined) {
      link.clicksRemaining = Math.max(0, (link.clicksRemaining ?? link.maxClicks) - 1);
      renderLifeKpi();
      renderOpenHint();
    }
    // An open Edit settings dialog counts "N more clicks" and its After saving line from these.
    if (state.editing) syncEditSettingsLink(link);
  }

  charts?.feed.push(evt);
  charts?.map.ping(evt);
  scheduleRefresh();
}

function handleLiveStatus(data) {
  const link = state.link;
  if (!link) return;
  const prev = link.status;
  if (data.status) link.status = data.status;
  if ('expiredReason' in data) link.expiredReason = data.expiredReason;
  if (Number.isFinite(Number(data.clickCount))) link.clickCount = Number(data.clickCount);
  if ('clicksRemaining' in data) link.clicksRemaining = data.clicksRemaining;
  renderLink();
  if (state.editing) syncEditSettingsLink(link);
  // While Edit settings is open, its save confirmation (or editSettings() on close) speaks for it.
  if (prev !== link.status && !state.editing) announceStatus(link.status);
  scheduleRefresh();
}

function announceStatus(status) {
  if (status === 'expired') toast('This link just self-destructed. New visitors will see the expired page.', { timeout: 4200 });
  else if (status === 'destroyed') toast('Self-destruct triggered. The link is gone.', { timeout: 4200 });
  else if (status === 'active') toast('The link is back from the dead.', { type: 'success' });
}

// ---------------------------------------------------------------------------
// Timers and lifecycle
// ---------------------------------------------------------------------------
function startTimers() {
  clearInterval(state.feedTimer);
  clearInterval(state.lifeTimer);
  state.feedTimer = setInterval(() => {
    charts?.feed.tick();
    const link = state.link;
    if (link) $('link-created').textContent = formatRelative(link.createdAt);
  }, 20_000);
  state.lifeTimer = setInterval(tickLife, 1000);
}

async function copyLink() {
  const url = workingUrl(state.link);
  if (!url) return;
  const ok = await copyText(url);
  toast(ok ? `Copied ${url.replace(/^https?:\/\//i, '')}` : "Copy didn't work. Select the link and copy it by hand.", { type: ok ? 'success' : 'error' });
}

/** Table toggle: one fixed label ("Show clicks as a table"); aria-pressed says whether the table is showing. */
function toggleTable() {
  const button = $('ts-table-toggle');
  const on = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(on));
  $('ts-table-wrap').hidden = !on;
  $('ts-chart').hidden = on;
  if (!on) charts?.ts.render();
}

function init() {
  rangeControl = radioGroup($('range-control'), 'range', (value) => {
    if (!RANGES.includes(value) || value === state.range) return;
    state.range = value;
    writePref(RANGE_KEY, value);
    $('stats-error').hidden = true;
    if (state.link) loadStats({ skeleton: true }); // also relabels everything for the new range
    else renderRangeText(value);
  });
  rangeControl.set(state.range);

  const simControl = radioGroup($('sim-count'), 'count', (value) => {
    state.simCount = value;
    writePref(SIM_KEY, value);
  });
  simControl.set(state.simCount);

  tabs($('bd-tabs'), { onChange: (name) => writePref(TAB_KEY, name) }).select(readPref(TAB_KEY, TABS, 'devices'));

  for (const id of ['btn-open', 'link-working-url']) {
    $(id).addEventListener('click', guardedOpen);
    $(id).addEventListener('auxclick', guardedOpen);
  }
  $('btn-copy').addEventListener('click', copyLink);
  $('btn-edit').addEventListener('click', () => editSettings('general'));
  $('btn-bring-back').addEventListener('click', () => editSettings('destruct'));
  $('empty-copy').addEventListener('click', copyLink);
  $('btn-simulate').addEventListener('click', (e) => simulate(e.currentTarget));
  $('empty-simulate').addEventListener('click', (e) => simulate(e.currentTarget));
  $('empty-all').addEventListener('click', () => rangeControl.set('all', { notify: true }));
  $('btn-clear-sim').addEventListener('click', clearSimulated);
  $('stats-retry').addEventListener('click', retryStats);
  $('ts-table-toggle').addEventListener('click', toggleTable);
  $('token-form').addEventListener('submit', onTokenSubmit);
  $('btn-retry').addEventListener('click', () => route());
  $('gate-slug').addEventListener('input', () => setGateError(''));
  $('gate-token').addEventListener('input', () => setGateError(''));

  window.addEventListener('hashchange', () => route());
  window.addEventListener('pagehide', () => {
    scheduleRefresh.cancel();
    state.stream?.close();
    state.stream = null;
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && state.link && !state.stream) {
      openStream();
      refresh();
    }
  });

  syncNavCount();
  route();
}

init();
