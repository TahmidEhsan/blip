// Blip: QR studio (qr.html#<slug>). Live-styled QR codes with presets, shapes, colours,
// logos, captions, PNG/SVG export, clipboard copy and saving qrStyle back to the link.
import { api, ApiError, linkStore, toast, el, icon, setIcon, copyText, hostOf, syncNavCount } from './api.js';
import { openEditSettings, announceSaved } from './edit-settings.js';
import {
  QR_PRESETS,
  LOGOS,
  DOT_TYPES,
  CORNER_SQUARE_TYPES,
  CORNER_DOT_TYPES,
  DEFAULT_QR_STYLE,
  normalizeQrStyle,
  presetStyle,
  serializeQrStyle,
  qrContrast,
  contrastRatio,
  buildQrOptions,
} from './qr-shared.js';
import { dotThumb, cornerSquareThumb, cornerDotThumb, presetSwatch } from './qr/thumbs.js';
import { newQr, composePng, composeSvg, downloadBlob, canCopyImages, copyPng } from './qr/export.js';
import { readLogoFile, logoStore, LogoError } from './qr/logo.js';
import { surpriseStyle, partnerColour } from './qr/surprise.js';

const PREVIEW_SIZE = 600;

const DOT_LABELS = {
  square: 'Square',
  dots: 'Dots',
  rounded: 'Rounded',
  classy: 'Classy',
  'classy-rounded': 'Classy round',
  'extra-rounded': 'Extra round',
};
const CORNER_SQUARE_LABELS = {
  square: 'Square',
  dot: 'Circle',
  'extra-rounded': 'Extra round',
  rounded: 'Rounded',
  dots: 'Dotted',
  classy: 'Classy',
  'classy-rounded': 'Classy round',
};
const CORNER_DOT_LABELS = {
  square: 'Square',
  dot: 'Circle',
  rounded: 'Rounded',
  dots: 'Dotted',
  classy: 'Classy',
  'classy-rounded': 'Classy round',
  'extra-rounded': 'Extra round',
};

/** Sprite icon for each empty / error state (ids from public/assets/icons.svg). */
const EMPTY_ICONS = {
  pick: 'scan-qr-code',
  token: 'key-round',
  missing: 'circle-question-mark',
  denied: 'shield-ban',
  offline: 'cloud-off',
};

const $ = (id) => document.getElementById(id);
const dom = {
  navDashboard: $('nav-dashboard'),
  linkSkeleton: $('qr-link-skeleton'),
  linkLine: $('qr-link-line'),
  shortUrl: $('qr-short-url'),
  statusBadge: $('qr-status-badge'),
  target: $('qr-target'),
  editSettings: $('qr-edit-settings'),
  loading: $('qr-loading'),
  empty: $('qr-empty'),
  emptyKicker: $('qr-empty-kicker'),
  emptyIcon: $('qr-empty-icon'),
  emptyTitle: $('qr-empty-title'),
  emptyText: $('qr-empty-text'),
  emptyHome: $('qr-empty-home'),
  retry: $('qr-retry'),
  emptyLinks: $('qr-empty-links'),
  emptyChips: $('qr-empty-chips'),
  studio: $('qr-studio'),
  card: $('qr-card'),
  canvas: $('qr-canvas'),
  captionPreview: $('qr-caption-preview'),
  meter: $('qr-meter'),
  meterValue: $('qr-meter-value'),
  meterLabel: $('qr-meter-label'),
  meterFill: $('qr-meter-fill'),
  warning: $('qr-warning'),
  warningText: $('qr-warning-text'),
  invertNote: $('qr-invert-note'),
  transparentNote: $('qr-transparent-note'),
  statusNote: $('qr-status-note'),
  statusNoteText: $('qr-status-note-text'),
  bringBack: $('qr-bring-back'),
  downloadPng: $('qr-download-png'),
  downloadSvg: $('qr-download-svg'),
  copyImage: $('qr-copy-image'),
  encodedUrl: $('qr-encoded-url'),
  copyUrl: $('qr-copy-url'),
  openUrl: $('qr-open-url'),
  confirm: $('qr-confirm'),
  confirmTitle: $('qr-confirm-title'),
  confirmText: $('qr-confirm-text'),
  encodesNote: $('qr-encodes-note'),
  save: $('qr-save'),
  surprise: $('qr-surprise'),
  reset: $('qr-reset'),
  saveState: $('qr-save-state'),
  presets: $('qr-presets'),
  dotTypes: $('qr-dot-types'),
  cornerSquareTypes: $('qr-corner-square-types'),
  cornerDotTypes: $('qr-corner-dot-types'),
  dotColor: $('qr-dot-color'),
  dotColorHex: $('qr-dot-color-hex'),
  cornerSquareColor: $('qr-corner-square-color'),
  cornerSquareColorHex: $('qr-corner-square-color-hex'),
  cornerDotColor: $('qr-corner-dot-color'),
  cornerDotColorHex: $('qr-corner-dot-color-hex'),
  gradientToggle: $('qr-gradient-toggle'),
  gradientOpts: $('qr-gradient-opts'),
  dotColor2: $('qr-dot-color-2'),
  dotColor2Hex: $('qr-dot-color-2-hex'),
  gradientType: $('qr-gradient-type'),
  rotationField: $('qr-rotation-field'),
  rotation: $('qr-gradient-rotation'),
  rotationOut: $('qr-gradient-rotation-out'),
  bgColor: $('qr-bg-color'),
  bgColorHex: $('qr-bg-color-hex'),
  transparentToggle: $('qr-transparent-toggle'),
  logos: $('qr-logos'),
  logoFile: $('qr-logo-file'),
  logoUpload: $('qr-logo-upload'),
  logoRemove: $('qr-logo-remove'),
  logoError: $('qr-logo-error'),
  margin: $('qr-margin'),
  marginOut: $('qr-margin-out'),
  caption: $('qr-caption'),
  captionCount: $('qr-caption-count'),
};

const state = {
  slug: '',
  token: '',
  link: null,
  style: normalizeQrStyle(DEFAULT_QR_STYLE),
  saved: normalizeQrStyle(DEFAULT_QR_STYLE),
  customLogo: null, // { dataUrl, name } remembered for this slug in this browser
  useCustomLogo: false,
  savedUseCustomLogo: false,
  lastDotColor2: null,
  qr: null,
  saving: false,
  editing: false,
  controlsBuilt: false,
  dirtyShown: null,
  renderFrame: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function slugFromHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

const isHttpUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);
const sameStyle = (a, b) => JSON.stringify(serializeQrStyle(a)) === JSON.stringify(serializeQrStyle(b));
const isDirty = () => Boolean(state.link) && !sameStyle(state.style, state.saved);
const activeCustomLogo = () => (state.useCustomLogo && state.customLogo ? state.customLogo.dataUrl : null);
const fileBase = () => `blip-${state.slug}-qr`;
const effectiveBg = (style) => (style.transparentBg ? '#ffffff' : style.bgColor);

/** Relative brightness proxy: contrast against black grows with luminance. */
const brightness = (hex) => contrastRatio(hex, '#000000');

function setBusy(button, busy) {
  button.classList.toggle('is-loading', busy);
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

function setPressed(container, matches) {
  for (const button of container.querySelectorAll('button[aria-pressed]')) {
    button.setAttribute('aria-pressed', String(matches(button)));
  }
}

function setColorInput(input, hexLabel, value) {
  if (input.value.toLowerCase() !== value) input.value = value;
  hexLabel.textContent = value.toUpperCase();
}

/** Show one of the three views: skeletons while loading, the empty/error panel, or the studio. */
function showView(view) {
  dom.loading.hidden = view !== 'loading';
  dom.linkSkeleton.hidden = view !== 'loading';
  dom.empty.hidden = view !== 'empty';
  dom.studio.hidden = view !== 'studio';
}

function apiErrorMessage(err, action) {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return `Blip rejected this browser's manage key, so it couldn't ${action}.`;
    if (err.status === 404) return 'This link no longer exists.';
    return err.message;
  }
  return err?.message || `Couldn't ${action}.`;
}

// ---------------------------------------------------------------------------
// Empty, no-token and error states
// ---------------------------------------------------------------------------
/** A slug inside a Bangers heading, set in the URL face so it keeps its real (lowercase) spelling. */
const slugText = (slug) => el('span', { class: 'qr-empty__slug' }, `/${slug}`);

/** title is a string, or an array of strings and nodes (see slugText). */
function showEmpty({ kind = 'pick', kicker, title, text, retry = false }) {
  dom.emptyKicker.textContent = kicker;
  setIcon(dom.emptyIcon, EMPTY_ICONS[kind] || EMPTY_ICONS.pick);
  dom.emptyTitle.replaceChildren(...[].concat(title));
  dom.emptyText.textContent = text;
  // One primary action per view: Retry when the failure is temporary, otherwise Go home.
  dom.retry.hidden = !retry;
  dom.retry.classList.toggle('btn--primary', retry);
  dom.emptyHome.classList.toggle('btn--primary', !retry);
  dom.linkLine.hidden = true;
  dom.navDashboard.href = '/dashboard.html';

  // The list item is a wrapper, so each anchor keeps its native link role for screen readers.
  const others = linkStore.all().filter((item) => item.slug !== state.slug).slice(0, 8);
  dom.emptyChips.replaceChildren(
    ...others.map((item) =>
      el('span', { class: 'qr-empty__chip-item', role: 'listitem' },
        el('a', { class: 'chip', href: `#${encodeURIComponent(item.slug)}` }, icon('qr-code'), `/${item.slug}`),
      ),
    ),
  );
  dom.emptyLinks.hidden = others.length === 0;
  showView('empty');
}

// ---------------------------------------------------------------------------
// Link info
// ---------------------------------------------------------------------------
/** Why scans of a stopped link land on the self-destruct page, and what Bring back offers ({ text, how }). */
function statusCopy(link) {
  if (link.status === 'destroyed' || (link.status === 'expired' && link.expiredReason === 'manual')) {
    return {
      text: 'This link was destroyed, so scans land on the self-destruct page until you bring it back.',
      how: 'Undo Destroy now, and change its time or click limit if you like',
    };
  }
  if (link.status === 'expired') {
    return link.expiredReason === 'clicks'
      ? {
        text: 'This link has used up all its clicks, so scans land on the self-destruct page. Give it more clicks to bring it back.',
        how: 'Raise or remove its click limit so it works again',
      }
      : {
        text: "This link's timer ran out, so scans land on the self-destruct page. Give it more time to bring it back.",
        how: 'Give it a new self-destruct time, or none, so it works again',
      };
  }
  return null;
}

function renderLinkInfo() {
  const { link, slug } = state;
  dom.shortUrl.textContent = link.shortUrl;
  dom.statusBadge.className = `badge badge--${['active', 'expired', 'destroyed'].includes(link.status) ? link.status : 'neutral'}`;
  dom.statusBadge.textContent = link.status;
  dom.target.textContent = hostOf(link.targetUrl);
  dom.target.title = link.targetUrl;
  dom.linkLine.hidden = false;

  dom.navDashboard.href = `/dashboard.html#${encodeURIComponent(slug)}`;

  dom.encodedUrl.textContent = link.qrUrl;
  dom.encodedUrl.title = link.qrUrl;
  if (isHttpUrl(link.qrUrl)) {
    dom.openUrl.href = link.qrUrl;
    dom.openUrl.hidden = false;
  } else {
    dom.openUrl.hidden = true;
  }
  const openLabel = isClickLimited(link)
    ? `Open the encoded URL in a new tab (uses 1 of its ${clicksLeft(link)} remaining clicks)`
    : 'Open the encoded URL in a new tab';
  dom.openUrl.setAttribute('aria-label', openLabel);
  dom.openUrl.title = isClickLimited(link) ? 'Open (uses up a click)' : 'Open';

  if (link.domainLive) {
    dom.encodesNote.replaceChildren(
      link.shortUrl === link.qrUrl
        ? 'Scans open your branded link directly.'
        : 'Scans open your link on this Blip server.',
    );
  } else {
    dom.encodesNote.replaceChildren(
      'Your branded link ',
      el('strong', {}, link.shortUrl),
      ' is a vanity preview: ',
      el('strong', {}, link.domain),
      " doesn't point at this Blip server yet, so the code encodes the working URL instead. Once that domain's DNS points here, new codes use the branded link.",
    );
  }

  const note = statusCopy(link);
  dom.statusNoteText.textContent = note?.text ?? '';
  dom.bringBack.title = note?.how ?? '';
  dom.statusNote.hidden = !note;

  document.title = `QR studio · /${slug} · Blip`;
}

// ---------------------------------------------------------------------------
// Opening the encoded URL (a counted visit)
// ---------------------------------------------------------------------------
const isClickLimited = (link) => Boolean(link) && link.status === 'active' && link.maxClicks !== null && link.maxClicks !== undefined;
const clicksLeft = (link) => link.clicksRemaining ?? Math.max(0, link.maxClicks - (link.clickCount || 0));

/** Promise<boolean> confirm on the page's <dialog>. */
function confirmDialog({ title, text }) {
  const dialog = dom.confirm;
  if (typeof dialog?.showModal !== 'function') return Promise.resolve(window.confirm(`${title}\n\n${text}`));
  if (dialog.open) return Promise.resolve(false);
  dom.confirmTitle.textContent = title;
  dom.confirmText.textContent = text;
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
    // Settle on the button press itself, so the window.open() that follows still runs inside that
    // user gesture (Chromium dispatches the dialog's `close` event later, with the next rendered frame).
    // Escape and browsers without `submitter` fall back to `close`.
    const onSubmit = (event) => {
      if (event.submitter) finish(event.submitter.value === 'confirm');
    };
    const onClose = () => {
      // A late `close` from an earlier round can arrive after the dialog was re-opened: ignore it.
      if (!dialog.open) finish(dialog.returnValue === 'confirm');
    };
    form?.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose);
  });
}

/** Re-read the link after our own visit so the status note and click count stay honest. */
async function refreshLink(slug) {
  if (slug !== state.slug || !state.link) return;
  try {
    const { link } = await api.getLink(slug, state.token);
    if (slug !== state.slug || !state.link) return;
    state.link = link;
    renderLinkInfo();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) toast('This link no longer exists.', { type: 'error' });
  }
}

/**
 * Click / middle-click on "Open": unlimited (or already expired) links open normally; for a
 * click-limited link the owner confirms first, because opening it consumes one of its clicks.
 */
async function guardedOpen(event) {
  const link = state.link;
  if (!isClickLimited(link)) return;
  if (event.type === 'auxclick' && event.button !== 1) return;
  const url = dom.openUrl.getAttribute('href') || '';
  if (!isHttpUrl(url)) return;
  event.preventDefault();

  const left = clicksLeft(link);
  const ok = await confirmDialog({
    title: 'Use up a click?',
    text: left <= 1
      ? `Opening it yourself counts as a visit, and this is its last click (of ${link.maxClicks}). Once it's used, the link and this QR code self-destruct for everyone else.`
      : `Opening it yourself counts as a visit: ${left} of ${link.maxClicks} left. When they're gone, the link self-destructs and this code shows the self-destruct page.`,
  });
  if (!ok) return;
  const slug = state.slug;
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => refreshLink(slug), 2500);
}

// ---------------------------------------------------------------------------
// Edit settings and Bring back (the shared dialog, SPEC 10.1 and 10.2)
// ---------------------------------------------------------------------------
/**
 * A save in the dialog: the link line, status note and encoded URL follow the new link, and the preview
 * re-encodes its qrUrl. The QR style is left alone, whether it was saved with Save style or not.
 */
function applySavedLink(link) {
  state.link = link;
  renderLinkInfo();
  scheduleRender();
}

/** focus: 'domain' for Edit settings (the domain decides the encoded URL), 'destruct' for Bring back. */
async function editSettings(focus) {
  const link = state.link;
  if (!link || !state.token || state.editing) return;
  const slug = state.slug;
  const before = structuredClone(link);
  state.editing = true;
  let saved = null;
  try {
    saved = await openEditSettings(before, state.token, {
      focus,
      onSaved: (updated) => {
        if (slug === state.slug && state.link) applySavedLink(updated);
      },
    });
  } finally {
    state.editing = false;
  }
  if (slug !== state.slug) return;
  if (saved) announceSaved(before, saved);
  // Bring back hides once the link works again: hand focus to Edit settings rather than lose it.
  const active = document.activeElement;
  const usable = active && active !== document.body && active.isConnected && active.getClientRects().length > 0;
  if (!usable && !dom.linkLine.hidden) dom.editSettings.focus();
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function shapeButton(value, label, thumb) {
  return el(
    'button',
    { type: 'button', class: 'qr-shape', 'aria-pressed': 'false', dataset: { value }, title: label },
    el('span', { class: 'qr-shape__thumb' }, thumb),
    el('span', { class: 'qr-shape__label' }, label),
  );
}

function buildPresets() {
  const buttons = Object.entries(QR_PRESETS).map(([id, preset]) =>
    el(
      'button',
      { type: 'button', class: 'qr-preset', 'aria-pressed': 'false', dataset: { preset: id }, title: `${preset.label} preset` },
      el('span', { class: 'qr-preset__swatch' }, presetSwatch(preset)),
      el('span', { class: 'qr-preset__label' }, preset.label),
    ),
  );
  dom.presets.replaceChildren(...buttons);
}

function renderLogos() {
  const buttons = Object.entries(LOGOS).map(([id, logo]) =>
    el(
      'button',
      { type: 'button', class: 'qr-logo', 'aria-pressed': 'false', dataset: { logo: id }, title: logo.label },
      el('span', { class: 'qr-logo__img' }, logo.src ? el('img', { src: logo.src, alt: '', width: 32, height: 32 }) : icon('ban')),
      el('span', { class: 'qr-logo__label' }, logo.label),
    ),
  );
  if (state.customLogo) {
    buttons.push(
      el(
        'button',
        { type: 'button', class: 'qr-logo qr-logo--custom', 'aria-pressed': 'false', dataset: { logo: 'custom' }, title: state.customLogo.name },
        // Halftone behind the upload shows through any transparent areas of the image.
        el('span', { class: 'qr-logo__img halftone' }, el('img', { src: state.customLogo.dataUrl, alt: '', width: 32, height: 32 })),
        el('span', { class: 'qr-logo__label' }, 'Your logo'),
      ),
    );
  }
  dom.logos.replaceChildren(...buttons);
  dom.logoRemove.hidden = !state.customLogo;
  setPressed(dom.logos, logoIsSelected);
}

/** Whether a logo tile matches the current choice (an active upload wins over the preset logo). */
function logoIsSelected(button) {
  return state.useCustomLogo && state.customLogo ? button.dataset.logo === 'custom' : button.dataset.logo === state.style.logo;
}

function buildControls() {
  buildPresets();
  dom.dotTypes.replaceChildren(...DOT_TYPES.map((type) => shapeButton(type, DOT_LABELS[type] || type, dotThumb(type))));
  dom.cornerSquareTypes.replaceChildren(
    ...CORNER_SQUARE_TYPES.map((type) => shapeButton(type, CORNER_SQUARE_LABELS[type] || type, cornerSquareThumb(type))),
  );
  dom.cornerDotTypes.replaceChildren(
    ...CORNER_DOT_TYPES.map((type) => shapeButton(type, CORNER_DOT_LABELS[type] || type, cornerDotThumb(type))),
  );
  bindControls();
  state.controlsBuilt = true;
}

function syncControls() {
  const s = state.style;
  setPressed(dom.presets, (b) => b.dataset.preset === s.preset);
  setPressed(dom.dotTypes, (b) => b.dataset.value === s.dotType);
  setPressed(dom.cornerSquareTypes, (b) => b.dataset.value === s.cornerSquareType);
  setPressed(dom.cornerDotTypes, (b) => b.dataset.value === s.cornerDotType);
  setPressed(dom.logos, logoIsSelected);

  setColorInput(dom.dotColor, dom.dotColorHex, s.dotColor);
  setColorInput(dom.cornerSquareColor, dom.cornerSquareColorHex, s.cornerSquareColor);
  setColorInput(dom.cornerDotColor, dom.cornerDotColorHex, s.cornerDotColor);
  setColorInput(dom.bgColor, dom.bgColorHex, s.bgColor);

  const twoTone = Boolean(s.dotColor2);
  dom.gradientToggle.checked = twoTone;
  dom.gradientOpts.hidden = !twoTone;
  setColorInput(dom.dotColor2, dom.dotColor2Hex, s.dotColor2 || state.lastDotColor2 || partnerColour(s.dotColor, effectiveBg(s)));
  for (const button of dom.gradientType.querySelectorAll('button[role="radio"]')) {
    button.setAttribute('aria-checked', String(button.dataset.value === s.gradientType));
  }
  const radial = s.gradientType === 'radial';
  dom.rotation.disabled = radial;
  dom.rotationField.classList.toggle('is-disabled', radial);
  if (Number(dom.rotation.value) !== s.gradientRotation) dom.rotation.value = String(s.gradientRotation);
  dom.rotationOut.textContent = radial ? 'n/a' : `${s.gradientRotation}°`;

  dom.transparentToggle.checked = s.transparentBg;
  dom.bgColor.disabled = s.transparentBg;
  dom.bgColor.closest('.qr-color')?.classList.toggle('is-disabled', s.transparentBg);

  if (Number(dom.margin.value) !== s.margin) dom.margin.value = String(s.margin);
  dom.marginOut.textContent = String(s.margin);

  if (document.activeElement !== dom.caption) dom.caption.value = s.caption || '';
  dom.captionCount.textContent = `${dom.caption.value.length}/40`;
}

// ---------------------------------------------------------------------------
// Preview + feedback
// ---------------------------------------------------------------------------
function showQrUnavailable() {
  dom.canvas.replaceChildren(
    el('p', { class: 'qr-card__error' }, "The QR engine didn't load. Refresh the page to try again."),
  );
  for (const button of [dom.downloadPng, dom.downloadSvg, dom.copyImage]) button.disabled = true;
}

function updateQr() {
  const options = buildQrOptions(state.link.qrUrl, state.style, {
    size: PREVIEW_SIZE,
    type: 'svg',
    customLogo: activeCustomLogo(),
  });
  if (!state.qr) {
    state.qr = newQr(options);
    if (!state.qr) {
      showQrUnavailable();
      return;
    }
    dom.canvas.replaceChildren();
    state.qr.append(dom.canvas);
  } else {
    state.qr.update(options);
  }
}

/** The preview card mirrors the PNG export: background colour, ink outline, lettered caption. */
function updateCard() {
  const s = state.style;
  dom.card.style.setProperty('--qr-card-bg', s.transparentBg ? 'transparent' : s.bgColor);
  dom.card.style.setProperty('--qr-ink', s.dotColor);
  dom.card.classList.toggle('is-transparent', s.transparentBg);
  dom.captionPreview.textContent = s.caption || '';
  dom.captionPreview.hidden = !s.caption;
  dom.canvas.setAttribute('aria-label', `Styled QR code that opens ${state.link.qrUrl}`);
}

function updateScannability() {
  const s = state.style;
  const ratio = qrContrast(s);
  const [label, tone] = ratio >= 7 ? ['Excellent', 'great'] : ratio >= 4.5 ? ['Great', 'good'] : ratio >= 3 ? ['Okay', 'ok'] : ['Risky', 'bad'];
  dom.meterValue.textContent = `${ratio.toFixed(1)}:1 contrast`;
  dom.meterLabel.textContent = label;
  dom.meter.dataset.tone = tone;
  dom.meterFill.style.width = `${Math.round(Math.min(1, Math.max(0.04, (ratio - 1) / 9)) * 100)}%`;

  if (ratio < 3) {
    const bg = effectiveBg(s);
    const parts = [
      { name: 'dots are', color: s.dotColor },
      { name: 'second dot colour is', color: s.dotColor2 },
      { name: 'outer corners are', color: s.cornerSquareColor },
      { name: 'inner corners are', color: s.cornerDotColor },
    ].filter((part) => part.color);
    const weakest = parts.reduce((a, b) => (contrastRatio(a.color, bg) <= contrastRatio(b.color, bg) ? a : b));
    dom.warningText.textContent = `Low contrast (${ratio.toFixed(1)}:1): the ${weakest.name} too close to the background, so phone cameras may struggle. Aim for at least 3:1 by darkening the dots or lightening the background.`;
    dom.warning.hidden = false;
  } else {
    dom.warning.hidden = true;
  }

  dom.invertNote.hidden = s.transparentBg || brightness(s.bgColor) >= brightness(s.dotColor);
  dom.transparentNote.hidden = !s.transparentBg;
}

function updateDirty() {
  const dirty = isDirty();
  dom.save.classList.toggle('has-changes', dirty);
  if (dirty !== state.dirtyShown) {
    state.dirtyShown = dirty;
    dom.saveState.textContent = dirty ? 'Unsaved changes. Press Save style to keep them.' : 'All changes saved to this link.';
    dom.saveState.classList.toggle('is-dirty', dirty);
  }
}

function render() {
  state.renderFrame = 0;
  if (!state.link) return;
  updateQr();
  syncControls();
  updateCard();
  updateScannability();
  updateDirty();
}

function scheduleRender() {
  if (state.renderFrame) return;
  state.renderFrame = requestAnimationFrame(render);
}

// ---------------------------------------------------------------------------
// Style changes
// ---------------------------------------------------------------------------
function setStyle(patch, { keepPreset = false } = {}) {
  state.style = normalizeQrStyle({ ...state.style, ...patch, preset: keepPreset ? state.style.preset : 'custom' });
  if (state.style.dotColor2) state.lastDotColor2 = state.style.dotColor2;
  scheduleRender();
}

function replaceStyle(next) {
  const style = normalizeQrStyle(next);
  if (state.useCustomLogo && state.customLogo) style.logo = 'none';
  state.style = style;
  if (style.dotColor2) state.lastDotColor2 = style.dotColor2;
  scheduleRender();
}

function applyPreset(id) {
  if (!QR_PRESETS[id]) return;
  replaceStyle(presetStyle(id, state.style.caption));
}

function selectLogo(id) {
  if (id === 'custom') {
    if (!state.customLogo) return;
    state.useCustomLogo = true;
    logoStore.setActive(state.slug, true);
    setStyle({ logo: 'none' });
    return;
  }
  if (!LOGOS[id]) return;
  state.useCustomLogo = false;
  if (state.customLogo) logoStore.setActive(state.slug, false);
  setStyle({ logo: id });
}

async function handleLogoFile(file) {
  dom.logoError.hidden = true;
  setBusy(dom.logoUpload, true);
  try {
    const logo = await readLogoFile(file);
    state.customLogo = logo;
    state.useCustomLogo = true;
    const remembered = logoStore.set(state.slug, { ...logo, active: true });
    renderLogos();
    setStyle({ logo: 'none' });
    toast(remembered ? 'Logo added. It stays in this browser.' : 'Logo added for this visit. Browser storage is full, so it will not be remembered.', {
      type: remembered ? 'success' : 'info',
      timeout: remembered ? 2800 : 4200,
    });
  } catch (err) {
    dom.logoError.textContent = err instanceof LogoError ? err.message : "Couldn't use that image. Try a PNG, JPG or SVG.";
    dom.logoError.hidden = false;
  } finally {
    setBusy(dom.logoUpload, false);
    dom.logoFile.value = '';
  }
}

function forgetLogo() {
  logoStore.remove(state.slug);
  state.customLogo = null;
  state.useCustomLogo = false;
  state.savedUseCustomLogo = false;
  renderLogos();
  scheduleRender();
  toast('Custom logo forgotten.');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function save() {
  if (state.saving || !state.link) return;
  state.saving = true;
  setBusy(dom.save, true);
  try {
    const { link } = await api.updateLink(state.slug, state.token, { qrStyle: serializeQrStyle(state.style) });
    state.link = link;
    state.saved = normalizeQrStyle(link.qrStyle || state.style);
    state.style = { ...state.saved };
    state.savedUseCustomLogo = state.useCustomLogo;
    renderLinkInfo();
    scheduleRender();
    toast('QR style saved. Your link remembers it everywhere.', { type: 'success' });
  } catch (err) {
    toast(apiErrorMessage(err, 'save the style'), { type: 'error', timeout: 4200 });
  } finally {
    state.saving = false;
    setBusy(dom.save, false);
  }
}

function reset() {
  if (!state.link) return;
  state.useCustomLogo = state.savedUseCustomLogo && Boolean(state.customLogo);
  if (state.customLogo) logoStore.setActive(state.slug, state.useCustomLogo);
  state.style = { ...state.saved };
  if (state.style.dotColor2) state.lastDotColor2 = state.style.dotColor2;
  scheduleRender();
  toast('Back to your saved style.');
}

function surprise() {
  if (!state.link) return;
  replaceStyle(surpriseStyle(state.style));
}

const exportInput = () => ({ data: state.link.qrUrl, style: state.style, customLogo: activeCustomLogo() });

async function runExport(button, task) {
  if (!state.link || button.classList.contains('is-loading')) return;
  setBusy(button, true);
  try {
    await task();
  } catch (err) {
    console.error(err);
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    toast(denied ? 'The browser blocked clipboard access. Use Download PNG instead.' : err?.message || 'Export failed.', { type: 'error', timeout: 4200 });
  } finally {
    setBusy(button, false);
  }
}

function downloadPng() {
  runExport(dom.downloadPng, async () => {
    const blob = await composePng(exportInput());
    downloadBlob(blob, `${fileBase()}.png`);
    toast('PNG downloaded: 1024 px and print-ready.', { type: 'success' });
  });
}

function downloadSvg() {
  runExport(dom.downloadSvg, async () => {
    const blob = await composeSvg(exportInput());
    downloadBlob(blob, `${fileBase()}.svg`);
    toast('SVG downloaded. It scales to any size.', { type: 'success' });
  });
}

function copyImage() {
  runExport(dom.copyImage, async () => {
    await copyPng(() => composePng(exportInput()));
    toast('Image copied. Paste it anywhere.', { type: 'success' });
  });
}

async function copyEncodedUrl() {
  if (!state.link) return;
  const ok = await copyText(state.link.qrUrl);
  toast(ok ? 'URL copied.' : "Couldn't copy. Select the URL and copy it manually.", { type: ok ? 'success' : 'error' });
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
function onGroupClick(container, attr, handler) {
  container.addEventListener('click', (event) => {
    const button = event.target.closest(`button[data-${attr}]`);
    if (button && container.contains(button)) handler(button.dataset[attr]);
  });
}

function bindControls() {
  onGroupClick(dom.presets, 'preset', applyPreset);
  onGroupClick(dom.dotTypes, 'value', (value) => setStyle({ dotType: value }));
  onGroupClick(dom.cornerSquareTypes, 'value', (value) => setStyle({ cornerSquareType: value }));
  onGroupClick(dom.cornerDotTypes, 'value', (value) => setStyle({ cornerDotType: value }));
  onGroupClick(dom.logos, 'logo', selectLogo);
  onGroupClick(dom.gradientType, 'value', (value) => setStyle({ gradientType: value }));

  dom.dotColor.addEventListener('input', () => setStyle({ dotColor: dom.dotColor.value }));
  dom.cornerSquareColor.addEventListener('input', () => setStyle({ cornerSquareColor: dom.cornerSquareColor.value }));
  dom.cornerDotColor.addEventListener('input', () => setStyle({ cornerDotColor: dom.cornerDotColor.value }));
  dom.dotColor2.addEventListener('input', () => setStyle({ dotColor2: dom.dotColor2.value }));
  dom.bgColor.addEventListener('input', () => setStyle({ bgColor: dom.bgColor.value }));

  dom.gradientToggle.addEventListener('change', () => {
    if (dom.gradientToggle.checked) {
      setStyle({ dotColor2: state.lastDotColor2 || partnerColour(state.style.dotColor, effectiveBg(state.style)) });
    } else {
      setStyle({ dotColor2: null });
    }
  });
  dom.rotation.addEventListener('input', () => setStyle({ gradientRotation: Number(dom.rotation.value) }));
  dom.transparentToggle.addEventListener('change', () => setStyle({ transparentBg: dom.transparentToggle.checked }));
  dom.margin.addEventListener('input', () => setStyle({ margin: Number(dom.margin.value) }));
  dom.caption.addEventListener('input', () => {
    dom.captionCount.textContent = `${dom.caption.value.length}/40`;
    setStyle({ caption: dom.caption.value }, { keepPreset: true });
  });
  dom.caption.addEventListener('blur', () => scheduleRender());

  dom.logoUpload.addEventListener('click', () => dom.logoFile.click());
  dom.logoFile.addEventListener('change', () => {
    const [file] = dom.logoFile.files || [];
    if (file) handleLogoFile(file);
  });
  dom.logoRemove.addEventListener('click', forgetLogo);

  dom.save.addEventListener('click', save);
  dom.reset.addEventListener('click', reset);
  dom.surprise.addEventListener('click', surprise);
  dom.downloadPng.addEventListener('click', downloadPng);
  dom.downloadSvg.addEventListener('click', downloadSvg);
  dom.copyImage.addEventListener('click', copyImage);
  dom.copyUrl.addEventListener('click', copyEncodedUrl);
  dom.openUrl.addEventListener('click', guardedOpen);
  dom.openUrl.addEventListener('auxclick', guardedOpen);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function setupStudio(link) {
  state.link = link;
  state.saved = normalizeQrStyle(link.qrStyle || DEFAULT_QR_STYLE);
  state.style = { ...state.saved };
  state.lastDotColor2 = state.style.dotColor2;

  const stored = logoStore.get(state.slug);
  state.customLogo = stored ? { dataUrl: stored.dataUrl, name: stored.name } : null;
  state.useCustomLogo = Boolean(stored?.active);
  state.savedUseCustomLogo = state.useCustomLogo;
  state.dirtyShown = null;

  if (!state.controlsBuilt) buildControls();
  renderLogos();
  renderLinkInfo();
  showView('studio');
  render();
}

async function load() {
  state.slug = slugFromHash();
  state.link = null;
  if (!state.slug) {
    showEmpty({
      kind: 'pick',
      kicker: 'No link picked',
      title: 'Pick a link to style',
      text: 'The QR studio designs codes for links you created in this browser. Make one on the home page, or pick one below.',
    });
    return;
  }
  document.title = `QR studio · /${state.slug} · Blip`;

  state.token = linkStore.tokenFor(state.slug) || '';
  if (!state.token) {
    showEmpty({
      kind: 'token',
      kicker: 'Manage key missing',
      title: [slugText(state.slug), " isn't in this browser"],
      text: "Only the person who created a Blip can style its QR code. If that's you, open the studio from the browser you used to create it, where its manage key is saved.",
    });
    return;
  }

  showView('loading');
  try {
    const { link } = await api.getLink(state.slug, state.token);
    setupStudio(link);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      linkStore.remove(state.slug);
      showEmpty({
        kind: 'missing',
        kicker: 'Link not found',
        title: ["We couldn't find ", slugText(state.slug)],
        text: 'It may have been deleted. Make a fresh Blip on the home page in a few seconds.',
      });
    } else if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      showEmpty({
        kind: 'denied',
        kicker: 'Key mismatch',
        title: "This browser's key doesn't match",
        text: `Blip rejected the saved manage key for /${state.slug}. Open the studio from the browser that created the link.`,
      });
    } else {
      showEmpty({
        kind: 'offline',
        kicker: 'Connection trouble',
        title: "Couldn't reach Blip",
        text: err?.message || 'Something went wrong while loading this link.',
        retry: true,
      });
    }
  }
}

/**
 * Pin the preview column (sticky) only when all of it, export buttons included, fits below the
 * 16px top offset. A taller column stays in normal flow so Download, SVG and Copy image can always
 * be scrolled (or tabbed) into view.
 */
function watchPreviewPin() {
  const col = dom.studio.querySelector('.qr-preview-col');
  if (!col) return;
  const wide = window.matchMedia('(min-width: 920px)');
  const update = () => {
    const height = col.offsetHeight; // 0 while the studio is hidden: stay unpinned until it is measured
    dom.studio.classList.toggle('is-pinned', wide.matches && height > 0 && height + 32 <= window.innerHeight);
  };
  // Warnings, notes, the caption and the vanity explanation change the column's height.
  // The observer also fires when showView('studio') first reveals the hidden studio.
  if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(col);
  window.addEventListener('resize', update);
  wide.addEventListener('change', update);
  update();
}

function boot() {
  if (!canCopyImages()) dom.copyImage.hidden = true;
  watchPreviewPin();

  dom.retry.addEventListener('click', load);
  dom.editSettings.addEventListener('click', () => editSettings('domain'));
  dom.bringBack.addEventListener('click', () => editSettings('destruct'));
  window.addEventListener('hashchange', () => {
    if (slugFromHash() !== state.slug) location.reload();
  });
  window.addEventListener('beforeunload', (event) => {
    if (isDirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's' && state.link) {
      event.preventDefault();
      // Ctrl+S saves the QR style, never while a dialog (Edit settings, Use up a click?) is open over it.
      if (!document.querySelector('dialog[open]')) save();
    }
  });

  syncNavCount();
  load();
}

boot();
