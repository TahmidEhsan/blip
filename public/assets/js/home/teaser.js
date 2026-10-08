// Blip home page: "Teaser page" feature (switch, style, seconds, brand message, theme, live mini preview).

import { prefersReducedMotion, toast } from '../api.js';
import { state, emitChange, FieldError, TEASER_STYLES, TEASER_THEMES } from './state.js';
import { byId, radioGroup, setFieldError } from './dom.js';
import { teaserStyleWord } from './format.js';

// Sample facts for the preview only; the real teaser page picks from the server's trivia list.
const SAMPLE_FACTS = [
  'Octopuses have three hearts and blue blood.',
  'A group of flamingos is called a flamboyance.',
  "Bananas are berries, but strawberries aren't.",
  'Honey never spoils. Archaeologists have found edible honey in ancient tombs.',
  'Wombat poop is cube-shaped.',
];
const STYLE_TAGS = { countdown: 'Countdown', trivia: 'Trivia', brand: 'Brand' };

export function createTeaserFeature({ getTargetHost }) {
  const enabled = byId('teaserEnabled');
  const seconds = byId('teaserSeconds');
  const secondsOut = byId('teaserSecondsOut');
  const messageField = byId('teaserMessageField');
  const message = byId('teaserMessage');
  const messageCount = byId('teaserMessageCount');
  const messageError = byId('teaserMessageError');
  const preview = byId('teaserPreview');
  const count = byId('teaserPreviewCount');
  const kicker = byId('teaserPreviewKicker');
  const main = byId('teaserPreviewMain');
  const dest = byId('teaserPreviewDest');

  let panelOpen = false;
  let ticker = 0;
  let remaining = Number(seconds.value);
  let factIndex = 0;

  const styleGroup = radioGroup(byId('teaserStyle'), {
    onChange: (value) => {
      if (value === 'trivia') factIndex = (factIndex + 1) % SAMPLE_FACTS.length;
      turnOn();
      syncMessageField();
      changed();
    },
  });
  const themeGroup = radioGroup(byId('teaserThemes'), {
    onChange: () => {
      turnOn();
      changed();
    },
  });

  const secs = () => Number(seconds.value) || state.config.teaser.defaultSeconds;
  const style = () => (TEASER_STYLES.includes(styleGroup.value) ? styleGroup.value : 'countdown');
  const theme = () => (TEASER_THEMES.includes(themeGroup.value) ? themeGroup.value : TEASER_THEMES[0]);

  function turnOn() {
    if (!enabled.checked) enabled.checked = true;
  }

  function syncMessageField() {
    messageField.hidden = style() !== 'brand';
  }

  function updateCounter() {
    const max = Number(message.maxLength) > 0 ? Number(message.maxLength) : state.config.limits.messageMax;
    const len = message.value.length;
    messageCount.textContent = `${len}/${max}`;
    messageCount.dataset.level = len >= max ? 'full' : len >= max * 0.9 ? 'near' : 'ok';
  }

  function drawCount() {
    count.textContent = String(Math.max(0, remaining));
  }

  function renderPreview() {
    const host = getTargetHost() || 'your-site.com';
    preview.dataset.theme = theme();
    preview.dataset.style = style();
    preview.dataset.enabled = String(enabled.checked);

    switch (style()) {
      case 'trivia':
        kicker.textContent = 'Did you know?';
        main.textContent = SAMPLE_FACTS[factIndex];
        dest.textContent = `Taking you to ${host}`;
        break;
      case 'brand':
        kicker.textContent = 'A quick word';
        main.textContent = message.value.trim() || 'Your brand message appears here.';
        main.classList.toggle('is-placeholder', !message.value.trim());
        dest.textContent = `Taking you to ${host}`;
        break;
      default:
        kicker.textContent = 'Taking you to';
        main.textContent = host;
        dest.textContent = '';
    }
    if (style() !== 'brand') main.classList.remove('is-placeholder');
    secondsOut.textContent = `${secs()}s`;
  }

  function stopTicker() {
    clearInterval(ticker);
    ticker = 0;
  }

  /** The preview counts down while its panel is open (a still number under reduced motion). */
  function restartTicker() {
    stopTicker();
    remaining = secs();
    drawCount();
    if (!panelOpen || !enabled.checked || prefersReducedMotion()) return;
    ticker = setInterval(() => {
      remaining -= 1;
      if (remaining < 0) remaining = secs();
      drawCount();
    }, 1000);
  }

  function changed() {
    setFieldError(message, messageError, '');
    renderPreview();
    restartTicker();
    emitChange('teaser');
  }

  enabled.addEventListener('change', changed);
  seconds.addEventListener('input', () => {
    turnOn();
    changed();
  });
  message.addEventListener('input', () => {
    updateCounter();
    renderPreview();
    if (message.value.trim()) setFieldError(message, messageError, '');
    emitChange('teaser');
  });

  /** Apply teaser limits from /api/config. */
  function applyConfig() {
    const t = state.config.teaser;
    seconds.min = String(t.minSeconds);
    seconds.max = String(t.maxSeconds);
    if (!enabled.checked && Number(seconds.value) === 5) seconds.value = String(t.defaultSeconds);
    message.maxLength = state.config.limits.messageMax;
    updateCounter();
    renderPreview();
    restartTicker();
  }

  syncMessageField();
  updateCounter();
  renderPreview();
  drawCount();

  return {
    id: 'teaser',
    label: 'teaser page',
    applyConfig,
    refreshPreview: renderPreview,
    isActive: () => enabled.checked,
    chip: () => (enabled.checked ? { icon: 'clapperboard', text: `${secs()}s ${teaserStyleWord(style())}` } : null),
    stateText: () => (enabled.checked ? `${STYLE_TAGS[style()]} ${secs()}s` : 'Instant'),
    onToggle(open) {
      panelOpen = open;
      if (open) renderPreview();
      restartTicker();
    },
    apply(body) {
      if (!enabled.checked) return;
      const teaser = { seconds: secs(), style: style(), theme: theme() };
      if (teaser.style === 'brand') {
        const text = message.value.trim();
        if (!text) throw new FieldError('teaser.message', 'Brand message teasers need a message. What should visitors read?');
        teaser.message = text;
      }
      body.redirectMode = 'teaser';
      body.teaser = teaser;
    },
    showError(field, msg) {
      if (field === 'teaser.message') {
        if (style() !== 'brand') styleGroup.set('brand');
        syncMessageField();
        setFieldError(message, messageError, msg);
        message.focus();
        return;
      }
      toast(msg, { type: 'error' });
      if (field === 'teaser.seconds') {
        seconds.focus();
      } else if (field === 'teaser.theme') {
        themeGroup.focus();
      } else if (field === 'teaser.style' || field === 'redirectMode') {
        styleGroup.focus();
      } else {
        enabled.focus();
      }
    },
    reset() {
      enabled.checked = false;
      styleGroup.set('countdown');
      themeGroup.set(TEASER_THEMES[0]);
      seconds.value = String(state.config.teaser.defaultSeconds);
      message.value = '';
      updateCounter();
      syncMessageField();
      changed();
    },
  };
}
