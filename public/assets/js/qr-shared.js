// Blip — shared QR styling: presets, preset logos and the qrStyle → QRCodeStyling mapping.
// Requires the UMD build at /vendor/qr-code-styling.js (global `QRCodeStyling`) for createQr().

export const DOT_TYPES = ['square', 'dots', 'rounded', 'classy', 'classy-rounded', 'extra-rounded'];
export const CORNER_SQUARE_TYPES = ['square', 'dot', 'extra-rounded', 'rounded', 'dots', 'classy', 'classy-rounded'];
export const CORNER_DOT_TYPES = ['square', 'dot', 'rounded', 'dots', 'classy', 'classy-rounded', 'extra-rounded'];
export const GRADIENT_TYPES = ['linear', 'radial'];

const svgUri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Preset centre logos (ids are what the server accepts in qrStyle.logo). */
export const LOGOS = {
  none: { label: 'None', src: null },
  blip: {
    label: 'Blip',
    src: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset=".55" stop-color="#ec4899"/><stop offset="1" stop-color="#fb923c"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="url(#g)"/><circle cx="25" cy="34" r="9" fill="#fff"/><circle cx="44" cy="22" r="5" fill="#fff" opacity=".85"/></svg>`),
  },
  heart: {
    label: 'Heart',
    src: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#fff"/><path d="M32 50S12 38 12 25a10 10 0 0 1 20-3 10 10 0 0 1 20 3c0 13-20 25-20 25z" fill="#ec4899"/></svg>`),
  },
  star: {
    label: 'Star',
    src: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#fff"/><path d="M32 10l6.5 14.2 15.5 1.7-11.6 10.4 3.3 15.3L32 43.8l-13.7 7.8 3.3-15.3L10 25.9l15.5-1.7z" fill="#fbbf24"/></svg>`),
  },
  bolt: {
    label: 'Bolt',
    src: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#111827"/><path d="M36 8L16 36h14l-4 20 22-30H34z" fill="#facc15"/></svg>`),
  },
  cat: {
    label: 'Cat',
    src: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#fff"/><path d="M14 22l6-12 9 9h6l9-9 6 12v14c0 10-8 18-20 18S14 46 14 36z" fill="#8b5cf6"/><circle cx="25" cy="33" r="3.2" fill="#fff"/><circle cx="39" cy="33" r="3.2" fill="#fff"/><path d="M29 41h6l-3 3z" fill="#f9a8d4"/></svg>`),
  },
  link: {
    label: 'Link',
    src: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#22d3ee"/><g fill="none" stroke="#0b0820" stroke-width="5" stroke-linecap="round"><path d="M28 36a8 8 0 0 0 11.3 0l7-7a8 8 0 0 0-11.3-11.3l-2 2"/><path d="M36 28a8 8 0 0 0-11.3 0l-7 7a8 8 0 0 0 11.3 11.3l2-2"/></g></svg>`),
  },
};

/** Ready-made looks. Each is a complete qrStyle (minus caption). */
export const QR_PRESETS = {
  aurora: { label: 'Aurora', preset: 'aurora', dotType: 'rounded', dotColor: '#7c3aed', dotColor2: '#db2777', gradientType: 'linear', gradientRotation: 45, bgColor: '#ffffff', transparentBg: false, cornerSquareType: 'extra-rounded', cornerSquareColor: '#5b21b6', cornerDotType: 'dot', cornerDotColor: '#db2777', logo: 'blip', margin: 12 },
  sunset: { label: 'Sunset', preset: 'sunset', dotType: 'classy-rounded', dotColor: '#ea580c', dotColor2: '#be185d', gradientType: 'linear', gradientRotation: 90, bgColor: '#fff7ed', transparentBg: false, cornerSquareType: 'extra-rounded', cornerSquareColor: '#c2410c', cornerDotType: 'dot', cornerDotColor: '#be185d', logo: 'heart', margin: 12 },
  ocean: { label: 'Ocean', preset: 'ocean', dotType: 'dots', dotColor: '#0e7490', dotColor2: '#1d4ed8', gradientType: 'radial', gradientRotation: 0, bgColor: '#ecfeff', transparentBg: false, cornerSquareType: 'extra-rounded', cornerSquareColor: '#155e75', cornerDotType: 'dot', cornerDotColor: '#1d4ed8', logo: 'link', margin: 12 },
  neon: { label: 'Neon', preset: 'neon', dotType: 'extra-rounded', dotColor: '#22d3ee', dotColor2: '#a3e635', gradientType: 'linear', gradientRotation: 135, bgColor: '#0b0820', transparentBg: false, cornerSquareType: 'extra-rounded', cornerSquareColor: '#f472b6', cornerDotType: 'dot', cornerDotColor: '#22d3ee', logo: 'bolt', margin: 12 },
  mono: { label: 'Mono', preset: 'mono', dotType: 'square', dotColor: '#111111', dotColor2: null, gradientType: 'linear', gradientRotation: 0, bgColor: '#ffffff', transparentBg: false, cornerSquareType: 'square', cornerSquareColor: '#111111', cornerDotType: 'square', cornerDotColor: '#111111', logo: 'none', margin: 12 },
  candy: { label: 'Candy', preset: 'candy', dotType: 'dots', dotColor: '#db2777', dotColor2: '#7c3aed', gradientType: 'linear', gradientRotation: 315, bgColor: '#fdf2f8', transparentBg: false, cornerSquareType: 'dot', cornerSquareColor: '#9d174d', cornerDotType: 'dot', cornerDotColor: '#7c3aed', logo: 'star', margin: 12 },
  forest: { label: 'Forest', preset: 'forest', dotType: 'classy', dotColor: '#166534', dotColor2: '#0f766e', gradientType: 'linear', gradientRotation: 60, bgColor: '#f0fdf4', transparentBg: false, cornerSquareType: 'extra-rounded', cornerSquareColor: '#14532d', cornerDotType: 'square', cornerDotColor: '#15803d', logo: 'cat', margin: 12 },
};

export const DEFAULT_QR_STYLE = Object.freeze({ ...QR_PRESETS.aurora, caption: null });

const HEX = /^#[0-9a-f]{6}$/i;
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const color = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback);
const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Fill in defaults and coerce anything invalid. Always returns a complete qrStyle (no `label`). */
export function normalizeQrStyle(style) {
  const s = style && typeof style === 'object' ? style : {};
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
  const p = QR_PRESETS[id] || QR_PRESETS.aurora;
  const { label, ...rest } = p;
  return normalizeQrStyle({ ...rest, caption });
}

/** Only the keys the server accepts (SPEC §8) — use when PATCHing / creating. */
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
  const dotsOptions = { type: s.dotType, color: s.dotColor };
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
    imageOptions: { crossOrigin: 'anonymous', margin: Math.max(2, Math.round(size / 90)), imageSize: 0.36, hideBackgroundDots: true },
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
    console.warn('QRCodeStyling not loaded — include /vendor/qr-code-styling.js');
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
