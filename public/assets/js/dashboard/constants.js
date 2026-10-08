// Blip dashboard: shared labels, icons, ranges and colour lookups.
// Colours always come from the theme tokens in theme.css (DESIGN.md section 3), never from raw values here.

export const DEVICE_ORDER = ['mobile', 'desktop', 'tablet', 'console', 'tv', 'wearable', 'bot', 'other'];

export const DEVICE_LABELS = {
  mobile: 'Mobile',
  desktop: 'Desktop',
  tablet: 'Tablet',
  console: 'Console',
  tv: 'TV',
  wearable: 'Wearable',
  bot: 'Bot',
  other: 'Other',
};

/** Device type to sprite icon id (public/assets/icons.svg). */
export const DEVICE_ICONS = {
  mobile: 'smartphone',
  desktop: 'monitor',
  tablet: 'tablet',
  console: 'gamepad-2',
  tv: 'tv',
  wearable: 'watch',
  bot: 'bot',
  other: 'circle-question-mark',
};

export const deviceLabel = (name) => DEVICE_LABELS[name] || (name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Unknown');
export const deviceIcon = (name) => DEVICE_ICONS[name] || DEVICE_ICONS.other;

export const RANGES = ['24h', '7d', '30d', 'all'];
export const RANGE_LABELS = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  all: 'all time',
};
export const RANGE_SHORT = {
  '24h': '24h',
  '7d': '7 days',
  '30d': '30 days',
  all: 'all time',
};

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Outcome of a ClickEvent for the feed and the map: a counted click, a bot, or blocked after self-destruct. */
export function clickKind(evt) {
  if (evt?.outcome === 'expired') return 'blocked';
  if (evt?.isBot || evt?.outcome === 'bot-preview') return 'bot';
  return 'click';
}

/** A click that counts toward totals: a real redirect or teaser view by a non-bot. */
export function isCountedClick(evt) {
  return (evt?.outcome === 'redirect' || evt?.outcome === 'teaser') && !evt?.isBot;
}

export const d3Ready = () => typeof window !== 'undefined' && Boolean(window.d3);

/** Value of a theme.css custom property, with the documented token value as a fallback. */
export function cssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/** The theme colours d3 needs as attribute values, read from the CSS variables. */
export function readPalette() {
  return {
    ink: cssVar('--ink', '#111111'),
    paper: cssVar('--paper', '#fbf3df'),
    paper2: cssVar('--paper-2', '#efe3c4'),
    panel: cssVar('--panel', '#fffdf7'),
    blue: cssVar('--blue', '#1f5fad'),
    red: cssVar('--red', '#d62828'),
    yellow: cssVar('--yellow', '#f2b705'),
    heat: [
      cssVar('--heat-0', '#efe3c4'),
      cssVar('--heat-1', '#f2b705'),
      cssVar('--heat-2', '#e8590c'),
      cssVar('--heat-3', '#d62828'),
      cssVar('--heat-4', '#7a1414'),
    ],
  };
}
