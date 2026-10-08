// Blip QR studio: "Surprise me" draws a random look from the comic palette only, and only
// combinations that keep the code comfortably scannable (every colour at least 4.5:1 against
// the background). Shapes, logos and colours change; margin, caption and blend settings stay.
import { COMIC_PALETTE, CORNER_DOT_TYPES, CORNER_SQUARE_TYPES, DOT_TYPES, LOGOS, contrastRatio, normalizeQrStyle } from '../qr-shared.js';

const MIN_CONTRAST = 4.5;
// The eight print colours a surprise look may use (COMIC_PALETTE in qr-shared.js mirrors the theme.css tokens).
const PALETTE = ['ink', 'red', 'blue', 'yellow', 'green', 'orange', 'paper', 'white'].map((name) => COMIC_PALETTE[name]);
// Weighted towards light paper: dark-on-light codes are the most reliable to scan.
const BACKGROUNDS = ['white', 'white', 'paper', 'paper', 'yellow', 'ink'];
// Preferred order when suggesting a second colour for two-tone dots.
const PARTNER_ORDER = ['red', 'blue', 'ink', 'green', 'orange', 'yellow', 'white', 'paper'].map((name) => COMIC_PALETTE[name]);
const LOGO_IDS = Object.keys(LOGOS).filter((id) => id !== 'none');

/** Palette colours that read on `bg` with at least `min` contrast. */
function readableOn(bg, min = MIN_CONTRAST, colours = PALETTE) {
  return colours.filter((colour) => colour !== bg && contrastRatio(colour, bg) >= min);
}

/**
 * A comic-palette partner for two-tone dots: the first preferred colour that differs from
 * `dot` and still reads on `bg`. Falls back to ink or white, whichever contrasts more.
 */
export function partnerColour(dot, bg) {
  const current = String(dot || '').toLowerCase();
  const background = String(bg || COMIC_PALETTE.white).toLowerCase();
  for (const min of [MIN_CONTRAST, 3]) {
    const match = readableOn(background, min, PARTNER_ORDER).find((colour) => colour !== current);
    if (match) return match;
  }
  return contrastRatio(COMIC_PALETTE.ink, background) >= contrastRatio(COMIC_PALETTE.white, background)
    ? COMIC_PALETTE.ink
    : COMIC_PALETTE.white;
}

const LOOK_KEYS = ['dotType', 'dotColor', 'bgColor', 'cornerSquareType', 'cornerSquareColor', 'cornerDotType', 'cornerDotColor', 'logo'];
const sameLook = (a, b) => LOOK_KEYS.every((key) => a[key] === b[key]);

/**
 * @param {object} base current style (margin, caption and blend settings are kept)
 * @param {() => number} random injectable RNG for tests
 */
export function surpriseStyle(base = {}, random = Math.random) {
  const pick = (list) => list[Math.floor(random() * list.length) % list.length];
  const current = normalizeQrStyle(base);
  let style = current;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bgColor = COMIC_PALETTE[pick(BACKGROUNDS)];
    const inks = readableOn(bgColor);
    const dotColor = pick(inks);
    const cornerSquareColor = random() < 0.45 ? dotColor : pick(inks);
    const cornerDotColor = random() < 0.45 ? cornerSquareColor : pick(inks);
    style = normalizeQrStyle({
      ...current,
      preset: 'custom',
      dotType: pick(DOT_TYPES),
      dotColor,
      dotColor2: null,
      bgColor,
      transparentBg: false,
      cornerSquareType: pick(CORNER_SQUARE_TYPES),
      cornerSquareColor,
      cornerDotType: pick(CORNER_DOT_TYPES),
      cornerDotColor,
      logo: random() < 0.7 ? pick(LOGO_IDS) : 'none',
    });
    if (!sameLook(style, current)) break;
  }
  return style;
}
