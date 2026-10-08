// Blip 404 page: shows the address the visitor typed, checks whether it is up for grabs and,
// when they only mistyped an existing Blip (e.g. /summer_sale for /summer-sale), points them at it.
import { api, el, setIcon } from './api.js';

const SLUG_INPUT_MAX = 200;
const DISPLAY_MAX = 80;
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const STATE_ICONS = {
  available: 'circle-check',
  suggest: 'corner-down-right',
  unavailable: 'triangle-alert',
  tidy: 'info',
  error: 'wifi-off',
};

function readData() {
  const node = document.getElementById('blip-data');
  try {
    const parsed = JSON.parse(node?.textContent || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** The single path segment the visitor actually requested (decoded), or '' if there isn't exactly one. */
function requestedSegment() {
  const segments = window.location.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return '';
  try {
    return decodeURIComponent(segments[0]);
  } catch {
    return segments[0];
  }
}

const shorten = (text) => (text.length > DISPLAY_MAX ? `${text.slice(0, DISPLAY_MAX - 1)}…` : text);

const $ = (id) => document.getElementById(id);
const data = readData();
// The server sends the normalized slug; the URL bar holds what the visitor really typed.
const slug = typeof data.slug === 'string' ? data.slug.slice(0, SLUG_INPUT_MAX) : '';
const typed = (slug && requestedSegment().slice(0, SLUG_INPUT_MAX)) || slug;
const typedPath = `/${shorten(typed)}`;

const copy = $('notfound-copy');
const claimLink = $('claim-link');
const claimLabel = $('claim-label');
const skeleton = $('slug-check-skeleton');
const check = $('slug-check');
const checkIcon = $('slug-check-icon');
const checkText = $('slug-check-text');
const retry = $('slug-retry');

const pill = (text) => el('code', { class: 'slug-pill' }, text);

function setCopy(...parts) {
  copy.replaceChildren(...parts);
}

/**
 * Point the primary button somewhere. The label is a verb plus an optional slug path; the slug is
 * set in monospace so it keeps its real lowercase spelling inside the all-caps comic lettering.
 */
function setAction(intent, href, verb, path = '') {
  claimLink.dataset.intent = intent;
  claimLink.href = href;
  if (path) claimLabel.replaceChildren(`${verb} `, el('span', { class: 'claim-btn__slug' }, path));
  else claimLabel.textContent = verb;
  // Long slugs get ellipsized on narrow screens; keep the full label available on hover.
  const full = path ? `${verb} ${path}` : verb;
  if (full.length > 32) claimLink.title = full;
  else claimLink.removeAttribute('title');
}

/** Primary button: home page with the slug pre-filled (or a blank form). */
function setClaim(value, verb, path) {
  setAction('claim', value ? `/?slug=${encodeURIComponent(value)}` : '/', verb, path);
}

/** Primary button: the existing Blip itself. */
function setGo(value, verb) {
  setAction('go', `/${encodeURIComponent(value)}`, verb, `/${value}`);
}

function setLoading(loading) {
  skeleton.hidden = !loading;
}

function showCheck(state, text) {
  check.dataset.state = state;
  setIcon(checkIcon, STATE_ICONS[state] || 'info');
  checkText.textContent = text;
}

function clearCheck() {
  delete check.dataset.state;
  checkText.textContent = '';
}

async function checkAvailability() {
  if (!slug) {
    setLoading(false);
    setCopy("There's no Blip at this address. Good news: you can make your own in about five seconds.");
    setClaim('', 'Create a Blip');
    return;
  }
  setClaim(slug, 'Claim this Blip');

  let result;
  try {
    result = await api.checkSlug(slug);
  } catch {
    // Offline or rate limited: the claim button and the hedged copy still hold.
    setLoading(false);
    showCheck('error', `Couldn't check whether /${slug} is free right now.`);
    retry.hidden = false;
    return;
  }
  setLoading(false);
  retry.hidden = true;
  const normalized = typeof result?.normalized === 'string' && SLUG_SHAPE.test(result.normalized) ? result.normalized : '';

  if (result?.valid && result?.available && normalized) {
    setCopy('Nobody has claimed ', pill(typedPath), ' so far. Good news: it could be yours in about five seconds.');
    setClaim(normalized, 'Claim', `/${normalized}`);
    showCheck('available', normalized === typed
      ? `/${normalized} is up for grabs.`
      : `Available as /${normalized}. We tidied it up for you.`);
    return;
  }

  if (result?.reason === 'taken' && normalized) {
    if (typed.toLowerCase() !== normalized) {
      // The typed address only normalizes to an existing Blip: they almost certainly meant that one.
      setCopy("There's no Blip at ", pill(typedPath), ', but a Blip with almost the same name exists.');
      setGo(normalized, 'Go to');
      showCheck('suggest', `Did you mean /${normalized}?`);
    } else {
      // Exact match: it was created between this page rendering and the availability check.
      setCopy('Plot twist: someone claimed ', pill(typedPath), ' while this page was loading.');
      setGo(normalized, 'Open');
      showCheck('unavailable', `/${normalized} exists now. Open it, or head home to make your own.`);
    }
    return;
  }

  if (result?.reason === 'reserved' && normalized) {
    const variation = `${normalized}-hq`;
    setCopy(pill(typedPath), ' is reserved for Blip itself, so nobody can claim it.');
    setClaim(variation, 'Try', `/${variation}`);
    showCheck('unavailable', `/${normalized} is a reserved word. Add a twist, like /${variation}.`);
    return;
  }

  setCopy("There's no Blip at ", pill(typedPath), '.');
  setClaim('', 'Create a Blip');
  showCheck('tidy', 'That address has no usable letters or numbers. Pick a fresh one on the home page.');
}

retry.addEventListener('click', async () => {
  if (retry.getAttribute('aria-disabled') === 'true') return;
  // Keep the button (and keyboard focus) in place while the check runs again.
  retry.setAttribute('aria-disabled', 'true');
  clearCheck();
  setLoading(true);
  await checkAvailability();
  retry.removeAttribute('aria-disabled');
  if (retry.hidden && document.activeElement === document.body) claimLink.focus();
});

checkAvailability();
