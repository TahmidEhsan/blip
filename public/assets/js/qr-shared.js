// Blip: shared QR styling (presets, preset logos and the qrStyle to QRCodeStyling mapping).
// Requires the UMD build at /vendor/qr-code-styling.js (global `QRCodeStyling`) for createQr().

export const DOT_TYPES = ['square', 'dots', 'rounded', 'classy', 'classy-rounded', 'extra-rounded'];
export const CORNER_SQUARE_TYPES = ['square', 'dot', 'extra-rounded', 'rounded', 'dots', 'classy', 'classy-rounded'];
export const CORNER_DOT_TYPES = ['square', 'dot', 'rounded', 'dots', 'classy', 'classy-rounded', 'extra-rounded'];
export const GRADIENT_TYPES = ['linear', 'radial'];

const svgUri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Preset centre logos (ids are what the server accepts in qrStyle.logo). Flat comic style: square plates, ink outlines. */
const plate = (fill, body) => svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="3" y="3" width="58" height="58" fill="${fill}" stroke="#111111" stroke-width="6"/>${body}</svg>`);
export const LOGOS = {
  none: { label: 'None', src: null },
  blip: {
    label: 'Blip',
    src: plate('#d62828', `<text x="32" y="47" text-anchor="middle" font-family="Impact, 'Arial Black', sans-serif" font-size="40" fill="#ffffff">B</text>`),
  },
  heart: {
    label: 'Heart',
    src: plate('#fffdf7', `<path d="M32 51S12 39 12 26a10 10 0 0 1 20-3 10 10 0 0 1 20 3c0 13-20 25-20 25z" fill="#d62828" stroke="#111111" stroke-width="4" stroke-linejoin="round"/>`),
  },
  // The id stays `star` (stored styles and server validation use it); it draws the comic sound-effect
  // burst from theme.css .burst, a yellow blast around a red core, so no star glyph ships.
  star: {
    label: 'Burst',
    // Four nested copies of the .burst outline (ink, yellow, ink, red), drawn as fills like the CSS burst.
    src: plate('#fffdf7', [
      ['#111111', '32,10 36,17.5 43.9,12.6 43,21.4 52.2,19.7 47,27.2 54,32 47,36.8 52.2,44.3 43,42.6 43.9,51.4 36,46.5 32,54 28,46.5 20.1,51.4 21,42.6 11.8,44.3 17,36.8 10,32 17,27.2 11.8,19.7 21,21.4 20.1,12.6 28,17.5'],
      ['#f2b705', '32,14.5 35.1,20.4 41.5,16.6 40.8,23.6 48.1,22.2 43.9,28.1 49.5,32 43.9,35.8 48.1,41.8 40.8,40.4 41.5,47.4 35.1,43.5 32,49.5 28.9,43.5 22.5,47.4 23.3,40.4 15.9,41.8 20.1,35.8 14.5,32 20.1,28.1 15.9,22.2 23.3,23.6 22.5,16.6 28.9,20.4'],
      ['#111111', '32,20.5 34.1,24.4 38.2,21.9 37.8,26.5 42.6,25.6 39.8,29.5 43.5,32 39.8,34.5 42.6,38.4 37.8,37.5 38.2,42.1 34.1,39.6 32,43.5 29.9,39.6 25.8,42.1 26.3,37.5 21.4,38.4 24.2,34.5 20.5,32 24.2,29.5 21.4,25.6 26.3,26.5 25.8,21.9 29.9,24.4'],
      ['#d62828', '32,24.5 33.4,27.1 36,25.4 35.8,28.4 38.9,27.8 37.1,30.4 39.5,32 37.1,33.6 38.9,36.2 35.8,35.6 36,38.6 33.4,37 32,39.5 30.6,37 27.9,38.6 28.3,35.6 25.1,36.2 26.9,33.6 24.5,32 26.9,30.4 25.1,27.8 28.3,28.4 27.9,25.4 30.6,27.1'],
    ].map(([fill, points]) => `<polygon points="${points}" fill="${fill}"/>`).join('')),
  },
  bolt: {
    label: 'Bolt',
    src: plate('#111111', `<path d="M37 8L16 37h14l-4 19 22-30H35z" fill="#f2b705"/>`),
  },
  cat: {
    label: 'Cat',
    src: plate('#fffdf7', `<path d="M14 23l6-12 9 9h6l9-9 6 12v13c0 10-8 18-20 18S14 46 14 36z" fill="#111111"/><rect x="22" y="30" width="6" height="6" fill="#f2b705"/><rect x="36" y="30" width="6" height="6" fill="#f2b705"/><path d="M29 41h6l-3 4z" fill="#d62828"/>`),
  },
  link: {
    label: 'Link',
    src: plate('#1f5fad', `<g fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="square"><path d="M28 36a8 8 0 0 0 11.3 0l7-7a8 8 0 0 0-11.3-11.3l-2 2"/><path d="M36 28a8 8 0 0 0-11.3 0l-7 7a8 8 0 0 0 11.3 11.3l2-2"/></g>`),
  },
};

/**
 * The comic print colours as hex (the same values as the theme.css tokens). QR codes are drawn by a
 * library and exported as PNG/SVG, so they need real colour values rather than CSS variables.
 */
export const COMIC_PALETTE = Object.freeze({
  ink: '#111111',
  red: '#d62828',
  blue: '#1f5fad',
  yellow: '#f2b705',
  green: '#237a35',
  orange: '#e8590c',
  paper: '#fbf3df',
  paper2: '#efe3c4',
  panel: '#fffdf7',
  white: '#ffffff',
});

const C = COMIC_PALETTE;
/** One flat look: square corners, a single dot colour (two-tone off), 12px quiet zone. */
const look = (preset, label, { dotType = 'square', dot, bg, cornerSquare, cornerDot, logo }) => ({
  label, preset, dotType, dotColor: dot, dotColor2: null, gradientType: 'linear', gradientRotation: 0,
  bgColor: bg, transparentBg: false, cornerSquareType: 'square', cornerSquareColor: cornerSquare,
  cornerDotType: 'square', cornerDotColor: cornerDot, logo, margin: 12,
});

/**
 * Ready-made looks in the comic palette. Flat colours (no gradients); each is a complete qrStyle minus caption.
 * Every colour in a preset keeps at least 4.5:1 against its background (qrContrast), so no stock look trips the
 * studio's low-contrast warning; scripts/audit-design.mjs checks this.
 */
export const QR_PRESETS = {
  ink: look('ink', 'Ink', { dot: C.ink, bg: C.white, cornerSquare: C.ink, cornerDot: C.ink, logo: 'none' }),
  hero: look('hero', 'Hero', { dot: C.red, bg: C.white, cornerSquare: C.blue, cornerDot: C.blue, logo: 'blip' }),
  caption: look('caption', 'Caption', { dot: C.ink, bg: C.yellow, cornerSquare: C.ink, cornerDot: C.ink, logo: 'bolt' }),
  sky: look('sky', 'Sky', { dotType: 'dots', dot: C.blue, bg: C.white, cornerSquare: C.ink, cornerDot: C.blue, logo: 'link' }),
  pop: look('pop', 'Pop', { dotType: 'classy', dot: C.ink, bg: C.paper, cornerSquare: C.red, cornerDot: C.red, logo: 'heart' }),
  press: look('press', 'Press', { dotType: 'dots', dot: C.ink, bg: C.paper2, cornerSquare: C.blue, cornerDot: C.ink, logo: 'cat' }),
  noir: look('noir', 'Noir', { dot: C.panel, bg: C.ink, cornerSquare: C.yellow, cornerDot: C.yellow, logo: 'star' }),
};

/** Preset ids from the first release, mapped to their comic replacements. */
export const LEGACY_PRESETS = Object.freeze({ aurora: 'hero', sunset: 'pop', ocean: 'sky', neon: 'noir', mono: 'ink', candy: 'caption', forest: 'press' });
/** The centre logo each first-release preset came with, to tell a logo the user picked apart from the preset's own. */
const LEGACY_PRESET_LOGOS = Object.freeze({ aurora: 'blip', sunset: 'heart', ocean: 'link', neon: 'bolt', mono: 'none', candy: 'star', forest: 'cat' });

/**
 * Upgrade a qrStyle saved under a first-release preset id. The first studio switched the preset to
 * "custom" on every colour or shape edit, so a style that still carries an old id is that preset's
 * look (gradient dots, rounded corners, off-palette colours). It becomes the replacement preset's
 * flat look, keeping the caption and any centre logo the user chose instead of the preset's own.
 * Any other value is returned unchanged.
 * @param {unknown} style
 */
export function upgradeLegacyQrStyle(style) {
  if (!style || typeof style !== 'object' || typeof style.preset !== 'string' || !Object.hasOwn(LEGACY_PRESETS, style.preset)) return style;
  const { label, ...flat } = QR_PRESETS[LEGACY_PRESETS[style.preset]];
  const ownLogo = typeof style.logo === 'string' && style.logo !== LEGACY_PRESET_LOGOS[style.preset];
  return { ...flat, logo: ownLogo ? style.logo : flat.logo, caption: style.caption ?? null };
}

export const DEFAULT_QR_STYLE = Object.freeze({ ...QR_PRESETS.hero, caption: null });

const HEX = /^#[0-9a-f]{6}$/i;
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const color = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback);
const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Fill in defaults and coerce anything invalid. Always returns a complete qrStyle (no `label`). */
export function normalizeQrStyle(style) {
  const upgraded = upgradeLegacyQrStyle(style);
  const s = upgraded && typeof upgraded === 'object' ? upgraded : {};
  const d = DEFAULT_QR_STYLE;
  return {
    preset: pick(s.preset, [...Object.keys(QR_PRESETS), 'custom'], 'custom'),
    dotType: pick(s.dotType, DOT_TYPES, d.dotType),
    dotColor: color(s.dotColor, d.dotColor),
    dotColor2: s.dotColor2 === null ? null : color(s.dotColor2, s.dotColor2 === undefined ? d.dotColor2 : null),
    gradientType: pick(s.gradientType, GRADIENT_TYPES, 'linear'),
    gradientRotation: clampInt(s.gradientRotation, 0, 360, 0),
    bgColor: color(s.bgColor, d.bgColor),
    transparentBg: Boolean(s.transparentBg),
    cornerSquareType: pick(s.cornerSquareType, CORNER_SQUARE_TYPES, d.cornerSquareType),
    cornerSquareColor: color(s.cornerSquareColor, d.cornerSquareColor),
    cornerDotType: pick(s.cornerDotType, CORNER_DOT_TYPES, d.cornerDotType),
    cornerDotColor: color(s.cornerDotColor, d.cornerDotColor),
    logo: pick(s.logo, Object.keys(LOGOS), 'none'),
    margin: clampInt(s.margin, 0, 40, 12),
    caption: typeof s.caption === 'string' && s.caption.trim() ? s.caption.trim().slice(0, 40) : null,
  };
}

/** A qrStyle built from a preset id (keeps caption if given). */
export function presetStyle(id, caption = null) {
  const key = Object.hasOwn(LEGACY_PRESETS, id) ? LEGACY_PRESETS[id] : id;
  const p = Object.hasOwn(QR_PRESETS, key) ? QR_PRESETS[key] : QR_PRESETS.hero;
  const { label, ...rest } = p;
  return normalizeQrStyle({ ...rest, caption });
}

/** Only the keys the server accepts (SPEC §8). Use when PATCHing or creating. */
export function serializeQrStyle(style) {
  const s = normalizeQrStyle(style);
  return { ...s };
}

/**
 * Map a qrStyle to QRCodeStyling options.
 * @param {string} data URL to encode (use link.qrUrl)
 * @param {object} style qrStyle
 * @param {{size?: number, type?: 'svg'|'canvas', customLogo?: string|null}} opts
 */
export function buildQrOptions(data, style, { size = 280, type = 'svg', customLogo = null } = {}) {
  const s = normalizeQrStyle(style);
  const image = customLogo || LOGOS[s.logo]?.src || undefined;
  // `gradient` is always present (undefined when solid): QRCodeStyling#update() deep-merges
  // options, so switching from a gradient look to a solid one must clear the old gradient.
  const dotsOptions = { type: s.dotType, color: s.dotColor, gradient: undefined };
  if (s.dotColor2) {
    dotsOptions.gradient = {
      type: s.gradientType,
      rotation: (s.gradientRotation * Math.PI) / 180,
      colorStops: [{ offset: 0, color: s.dotColor }, { offset: 1, color: s.dotColor2 }],
    };
  }
  return {
    width: size,
    height: size,
    type,
    data,
    margin: Math.round((s.margin / 280) * size),
    qrOptions: { errorCorrectionLevel: image ? 'H' : 'Q' },
    image,
    // saveAsBlob: false. By default the library re-downloads the logo with XMLHttpRequest, which
    // the CSP (connect-src 'self') blocks for data: URLs, so the draw would never finish. Every
    // logo here (presets and uploads) is already a data: URL, so nothing is lost.
    imageOptions: { crossOrigin: 'anonymous', margin: Math.max(2, Math.round(size / 90)), imageSize: 0.36, hideBackgroundDots: true, saveAsBlob: false },
    dotsOptions,
    backgroundOptions: { color: s.transparentBg ? 'rgba(0,0,0,0)' : s.bgColor },
    cornersSquareOptions: { type: s.cornerSquareType, color: s.cornerSquareColor },
    cornersDotOptions: { type: s.cornerDotType, color: s.cornerDotColor },
  };
}

/** Create a QRCodeStyling instance, or null if the vendor script isn't loaded. */
export function createQr(data, style, opts) {
  const Ctor = window.QRCodeStyling;
  if (!Ctor) {
    console.warn('QRCodeStyling not loaded. Include /vendor/qr-code-styling.js');
    return null;
  }
  return new Ctor(buildQrOptions(data, style, opts));
}

// ---- Colour maths for scannability warnings ----
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrastRatio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Worst-case contrast between the dot colours and the background (transparent bg assumes white). */
export function qrContrast(style) {
  const s = normalizeQrStyle(style);
  const bg = s.transparentBg ? '#ffffff' : s.bgColor;
  const fgs = [s.dotColor, s.dotColor2, s.cornerSquareColor, s.cornerDotColor].filter(Boolean);
  return Math.min(...fgs.map((c) => contrastRatio(c, bg)));
}
