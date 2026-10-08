// Blip home page entry: wires the shortener panel, feature panels, result panel and "My links".
// See SPEC.md sections 9 and 10 for behaviour and DESIGN.md for the look. Feature modules live in ./home/.

import { api, linkStore, toast, el, icon, hostOf, prefersReducedMotion } from './api.js';
import { state, normalizeConfig, ownHosts, onChange, emitChange, FieldError, friendlyMessage } from './home/state.js';
import { byId, setFieldError, setBusy } from './home/dom.js';
import { validateTargetUrl, withScheme, normalizeSlug } from './home/url.js';
import { createPanels } from './home/panels.js';
import { createSlugFeature } from './home/slug.js';
import { createDomainFeature } from './home/domain.js';
import { createTeaserFeature } from './home/teaser.js';
import { createDestructFeature } from './home/destruct.js';
import { createAnalyticsFeature } from './home/analytics.js';
import { createQrFeature } from './home/qr-panel.js';
import { createResult } from './home/result.js';
import { createLinks } from './home/links.js';
import { confirmDialog, initConfirmDialog } from './home/confirm.js';
import { initSlashShortcut } from './home/effects.js';
import { startCountdownTicker, usableUrl, displayUrl } from './home/format.js';

const FEATURE_ORDER = ['slug', 'domain', 'teaser', 'destruct', 'analytics', 'qr'];
const ERROR_CODE_FIELDS = {
  slug_invalid: 'slug',
  slug_reserved: 'slug',
  slug_taken: 'slug',
  invalid_url: 'targetUrl',
  unsupported_protocol: 'targetUrl',
  redirect_loop: 'targetUrl',
  too_long: 'targetUrl',
};
const OFFLINE_MESSAGE = "We can't reach the Blip server right now, so new links can't be created yet.";

const form = byId('shortenForm');
const urlInput = byId('targetUrl');
const urlError = byId('targetUrlError');
const submitBtn = byId('shortenBtn');
const summaryChips = byId('summaryChips');
const summaryHint = byId('summaryHint');
const navCount = byId('navLinkCount');
const configWarning = byId('configWarning');
const configWarningText = byId('configWarningText');
const configRetry = byId('configRetry');

let submitting = false;
let loadingConfig = false;

const reduced = () => prefersReducedMotion();
const urlOptions = () => ({ ownHosts: ownHosts(), maxLength: state.config.limits.urlMax });

function targetHost() {
  const res = validateTargetUrl(urlInput.value);
  return res.ok ? hostOf(res.url) : '';
}

// ---------------------------------------------------------------------------
// Features + panels
// ---------------------------------------------------------------------------
const features = {};
features.slug = createSlugFeature({ getTargetUrl: () => urlInput.value });
features.domain = createDomainFeature();
features.teaser = createTeaserFeature({ getTargetHost: targetHost });
features.destruct = createDestructFeature();
features.analytics = createAnalyticsFeature();

/** The chosen domain's config entry (falls back to the base host). */
function chosenDomain() {
  return state.config.domains.find((d) => d.domain === state.domain) || state.config.domains[0] || null;
}

features.qr = createQrFeature({
  // Mirror the server's qrUrl rule (SPEC 5.1): the branded URL only when the domain is live,
  // otherwise the working URL on this server, so the preview matches the code you'll get.
  getPreviewUrl: () => {
    const slug = features.slug.currentSlug() || 'your-link';
    const entry = chosenDomain();
    if (!entry || entry.isBase || entry.domain === state.config.baseHost || !entry.live) return `${state.config.baseUrl}/${slug}`;
    return `https://${entry.domain}/${slug}`;
  },
  getPreviewNote: () => {
    const entry = chosenDomain();
    if (!entry || entry.isBase || entry.live) return '';
    return `${entry.domain} isn't live yet, so the code points at the working link.`;
  },
});

const panels = createPanels({
  onToggle: (id, open) => features[id]?.onToggle?.(open),
});

for (const btn of document.querySelectorAll('[data-reset]')) {
  btn.addEventListener('click', () => {
    const feature = features[btn.dataset.reset];
    if (!feature) return;
    feature.reset();
    toast(`Reset ${feature.label} to the defaults.`);
  });
}

/** Sync each tile's pressed state and state tag, and the summary chips under the URL box. */
function renderFeatureState() {
  const chips = [];
  for (const id of FEATURE_ORDER) {
    const feature = features[id];
    const btn = panels.button(id);
    const active = feature.isActive();
    btn?.classList.toggle('is-active', active);
    // aria-pressed means "this extra is switched on"; aria-expanded (panels.js) means "its panel is open".
    btn?.setAttribute('aria-pressed', String(active));
    const stateEl = document.getElementById(`featureState-${id}`);
    if (stateEl) {
      const text = feature.stateText();
      stateEl.textContent = text;
      stateEl.title = text;
    }
    const chip = feature.chip();
    if (chip) {
      chips.push(el('button', {
        type: 'button',
        class: 'chip summary-chip',
        dataset: { feature: id },
        title: `Edit ${feature.label}`,
        on: { click: () => panels.open(id, { scroll: true, focus: true }) },
      }, icon(chip.icon), el('span', { class: 'summary-chip__text' }, chip.text)));
    }
  }
  summaryChips.replaceChildren(...chips);
  summaryChips.hidden = chips.length === 0;
  summaryHint.hidden = chips.length > 0;
}

onChange((source) => {
  renderFeatureState();
  if (source === 'slug' || source === 'domain' || source === 'config') features.qr.refreshPreview();
});

// ---------------------------------------------------------------------------
// URL input
// ---------------------------------------------------------------------------
function showUrlError(message) {
  setFieldError(urlInput, urlError, message);
  urlInput.focus();
}

urlInput.addEventListener('input', () => {
  if (urlInput.hasAttribute('aria-invalid')) setFieldError(urlInput, urlError, '');
  features.teaser.refreshPreview();
});

urlInput.addEventListener('blur', () => {
  const value = urlInput.value.trim();
  if (!value) {
    setFieldError(urlInput, urlError, '');
    return;
  }
  const prefixed = withScheme(value);
  if (prefixed !== urlInput.value) urlInput.value = prefixed;
  const res = validateTargetUrl(urlInput.value, urlOptions());
  setFieldError(urlInput, urlError, res.ok ? '' : res.message);
  features.teaser.refreshPreview();
});

// ---------------------------------------------------------------------------
// Errors routed to the right field
// ---------------------------------------------------------------------------
function ownerOf(field) {
  if (!field) return null;
  if (field === 'targetUrl') return 'url';
  if (field === 'slug' || field === 'slugStyle' || field === 'title') return 'slug';
  if (field === 'domain') return 'domain';
  if (field === 'redirectMode' || field.startsWith('teaser')) return 'teaser';
  if (field === 'expiresAt' || field === 'expiresInSeconds' || field === 'maxClicks') return 'destruct';
  if (field.startsWith('qrStyle')) return 'qr';
  return null;
}

function showFieldError(field, message) {
  const owner = ownerOf(field);
  if (owner === 'url') {
    showUrlError(message);
    return true;
  }
  if (owner && features[owner]) {
    panels.open(owner, { scroll: true });
    features[owner].showError(field, message);
    return true;
  }
  return false;
}

function handleCreateError(err) {
  const message = friendlyMessage(err, "Couldn't create your link. Please try again.");
  const field = err?.field || ERROR_CODE_FIELDS[err?.code] || null;
  if ((err?.status === 400 || err?.status === 409) && showFieldError(field, message)) return;
  if (err?.code === 'network') {
    configWarning.hidden = false;
    configWarningText.textContent = OFFLINE_MESSAGE;
  }
  toast(message, { type: 'error', timeout: 4500 });
}

// ---------------------------------------------------------------------------
// Link actions shared by the result panel and "My links"
// ---------------------------------------------------------------------------
let result = null;
let links = null;

function forget(slug) {
  expiryChecks.delete(slug);
  linkStore.remove(slug);
  links.remove(slug);
  if (result.currentSlug() === slug) result.hide();
  features.analytics.render();
}

function handleManageError(err, slug, fallback) {
  if (err?.status === 404) {
    forget(slug);
    toast(`/${slug} no longer exists, so we tidied it away.`);
    return;
  }
  if (err?.status === 401 || err?.status === 403) {
    toast(`This browser's key for /${slug} was rejected, so it can't be managed from here.`, { type: 'error' });
    return;
  }
  toast(friendlyMessage(err, fallback), { type: 'error' });
}

function tokenOrWarn(slug) {
  const token = linkStore.tokenFor(slug);
  if (!token) toast(`This browser doesn't have the key for /${slug} any more.`, { type: 'error' });
  return token;
}

const reloadTimers = new Map();
/**
 * Countdowns that reached zero and are being followed up: slug to { expiresAt, attempt }.
 * If this device's clock runs ahead of the server's, the server still says "active" for a while;
 * re-rendered countdowns would then fire again on every tick, so instead we re-check with backoff.
 */
const expiryChecks = new Map();
const EXPIRY_RECHECK_BASE_MS = 1500;
const EXPIRY_RECHECK_MAX_MS = 30_000;

function followUpExpiry(slug, link) {
  const check = expiryChecks.get(slug);
  if (!check) return;
  // Settled: it expired, its expiry changed, or this device's clock no longer says it's due
  // (the re-rendered countdown will fire again when it is).
  if (link && (link.status !== 'active' || link.expiresAt !== check.expiresAt || Date.parse(link.expiresAt) > Date.now())) {
    expiryChecks.delete(slug);
    return;
  }
  check.attempt += 1;
  actions.reload(slug, Math.min(EXPIRY_RECHECK_MAX_MS, EXPIRY_RECHECK_BASE_MS * 2 ** check.attempt));
}

const actions = {
  applyLink(link) {
    links.update(link);
    result.update(link);
  },

  /** Re-fetch one link (after a countdown hits zero, or after opening a limited link). */
  reload(slug, delay = 900) {
    clearTimeout(reloadTimers.get(slug));
    reloadTimers.set(slug, setTimeout(async () => {
      reloadTimers.delete(slug);
      const token = linkStore.tokenFor(slug);
      if (!token) {
        expiryChecks.delete(slug);
        return;
      }
      try {
        const { link } = await api.getLink(slug, token);
        // Schedule any follow-up first: applyLink re-renders countdowns, which may fire again.
        followUpExpiry(slug, link);
        actions.applyLink(link);
      } catch (err) {
        if (err?.status === 404) forget(slug);
        else followUpExpiry(slug, null);
      }
    }, delay));
  },

  /** A countdown for this link reached zero: fetch it once, then back off while the server disagrees. */
  expiryReached(slug, expiresAt) {
    if (!slug) return;
    const check = expiryChecks.get(slug);
    if (check && check.expiresAt === expiresAt) return;
    expiryChecks.set(slug, { expiresAt, attempt: 0 });
    actions.reload(slug);
  },

  async destroy(slug) {
    const ok = await confirmDialog({
      title: `Self-destruct /${slug}?`,
      slug,
      message: 'Anyone who opens it will see the “this link has self-destructed” page instead of your destination. You can revive it later.',
      confirmLabel: 'Destroy now',
      tone: 'danger',
      iconName: 'bomb',
    });
    if (!ok) return;
    const token = tokenOrWarn(slug);
    if (!token) return;
    try {
      const { link } = await api.destroyLink(slug, token);
      actions.applyLink(link);
      toast(`Boom! /${slug} has self-destructed.`, { type: 'success' });
    } catch (err) {
      handleManageError(err, slug, "Couldn't destroy that link.");
    }
  },

  async revive(slug) {
    const token = tokenOrWarn(slug);
    if (!token) return;
    try {
      const { link } = await api.reviveLink(slug, token);
      actions.applyLink(link);
      if (link.status === 'active') {
        toast(`/${slug} is back from the dead!`, { type: 'success' });
      } else {
        const why = link.expiredReason === 'clicks' ? 'its click limit is already used up' : 'its timer has already run out';
        toast(`/${slug} is revived, but ${why}, so visitors still see the self-destructed page.`, { timeout: 5000 });
      }
    } catch (err) {
      handleManageError(err, slug, "Couldn't revive that link.");
    }
  },

  async remove(slug) {
    const ok = await confirmDialog({
      title: `Delete /${slug} forever?`,
      slug,
      message: 'This removes the link and all of its analytics. It cannot be undone.',
      confirmLabel: 'Delete forever',
      tone: 'danger',
      iconName: 'trash',
    });
    if (!ok) return;
    const token = linkStore.tokenFor(slug);
    if (!token) {
      forget(slug);
      return;
    }
    try {
      await api.deleteLink(slug, token);
      forget(slug);
      toast(`Deleted /${slug}.`, { type: 'success' });
    } catch (err) {
      handleManageError(err, slug, "Couldn't delete that link.");
    }
  },

  /** PATCH the target URL; throws so the inline editor can show the message. */
  async editTarget(slug, targetUrl) {
    const token = linkStore.tokenFor(slug);
    if (!token) throw new Error("This browser doesn't have the key for this link any more.");
    const { link } = await api.updateLink(slug, token, { targetUrl });
    return link;
  },

  /** Open the working link in a new tab, warning first when a visit uses up a limited click. */
  async open(link) {
    const url = usableUrl(link);
    const limited = link.status === 'active' && link.maxClicks !== null && link.maxClicks !== undefined;
    if (limited) {
      const ok = await confirmDialog({
        title: 'Use up a click?',
        message: `Opening it yourself counts as a visit: ${link.clicksRemaining} of ${link.maxClicks} left. When they're gone, the link self-destructs.`,
        confirmLabel: 'Open anyway',
        tone: 'primary',
        iconName: 'mouse-pointer-click',
      });
      if (!ok) return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    if (limited || link.redirectMode === 'teaser') actions.reload(link.slug, 2500);
  },
};

result = createResult({
  actions,
  onAnother: () => {
    result.hide();
    urlInput.value = '';
    setFieldError(urlInput, urlError, '');
    features.teaser.refreshPreview();
    features.analytics.render();
    urlInput.focus({ preventScroll: true });
    form.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
  },
});

links = createLinks({
  actions,
  onCountChange: (n) => {
    navCount.textContent = String(n);
    navCount.hidden = n === 0;
  },
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
function onCreated(link, manageToken) {
  const saved = linkStore.add({ slug: link.slug, token: manageToken });
  if (!saved) {
    toast("Heads up: this browser won't remember the manage key, so copy it from the panel below before you leave.", { type: 'error', timeout: 7000 });
  }
  features.slug.afterCreate();
  links.add(link, manageToken);
  result.show(link, manageToken);
  features.analytics.render();
  if (!link.domainLive) {
    toast(`${link.domain} is a vanity preview. Share ${displayUrl(link.workingUrl)} until its DNS points here.`, { timeout: 5000 });
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;

  const check = validateTargetUrl(urlInput.value, urlOptions());
  if (!check.ok) {
    showUrlError(check.message);
    return;
  }
  if (check.display !== urlInput.value.trim()) urlInput.value = check.display;
  setFieldError(urlInput, urlError, '');

  const body = { targetUrl: check.url };
  try {
    for (const id of FEATURE_ORDER) features[id].apply(body);
  } catch (err) {
    if (err instanceof FieldError) {
      showFieldError(err.field, err.message);
      return;
    }
    toast(friendlyMessage(err), { type: 'error' });
    return;
  }

  submitting = true;
  setBusy(submitBtn, true);
  try {
    const res = await api.createLink(body);
    if (!res?.link || !res?.manageToken) throw new Error('The server sent an unexpected reply. Please try again.');
    onCreated(res.link, res.manageToken);
  } catch (err) {
    handleCreateError(err);
  } finally {
    submitting = false;
    setBusy(submitBtn, false);
  }
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
async function loadConfig() {
  if (loadingConfig) return;
  loadingConfig = true;
  setBusy(configRetry, true);
  try {
    const raw = await api.config();
    state.config = normalizeConfig(raw);
    configWarning.hidden = true;
  } catch (err) {
    configWarning.hidden = false;
    configWarningText.textContent = err?.code === 'network'
      ? OFFLINE_MESSAGE
      : friendlyMessage(err, "Blip's settings didn't load, so some options may be missing.");
  } finally {
    loadingConfig = false;
    setBusy(configRetry, false);
  }
  if (!state.config.domains.some((d) => d.domain === state.domain)) {
    state.domain = state.config.defaultDomain || state.config.baseHost;
  }
  urlInput.maxLength = state.config.limits.urlMax;
  features.domain.renderDomains();
  features.teaser.applyConfig();
  emitChange('config');
}

configRetry.addEventListener('click', loadConfig);

// ---------------------------------------------------------------------------
// Misc wiring
// ---------------------------------------------------------------------------
byId('emptyCreateBtn').addEventListener('click', () => {
  urlInput.focus({ preventScroll: true });
  form.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
});

/** /?slug=<x> (from the 404 page): pre-open the Custom slug panel with that value. */
function applySlugParam() {
  const params = new URLSearchParams(window.location.search);
  const wanted = params.get('slug');
  if (!wanted) return;
  params.delete('slug');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  const normalized = normalizeSlug(wanted);
  if (!normalized) return;
  panels.open('slug');
  features.slug.setValue(normalized);
  urlInput.focus({ preventScroll: true });
  toast(`Claim /${normalized}: paste where it should go, then hit Shorten.`, { timeout: 4500 });
}

function boot() {
  initConfirmDialog();
  renderFeatureState();
  startCountdownTicker();
  initSlashShortcut(urlInput);
  applySlugParam();
  loadConfig();
  const linksLoaded = links.refresh();
  // Deep links to /#my-links (dashboard and QR studio nav): the page grows once the list renders,
  // so land on the list again after it has.
  if (window.location.hash === '#my-links') {
    linksLoaded.finally(() => byId('my-links').scrollIntoView({ block: 'start' }));
  }
  document.documentElement.classList.add('is-ready');
}

boot();
