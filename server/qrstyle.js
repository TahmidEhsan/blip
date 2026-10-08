// Blip: server-side validation of the flat `qrStyle` object (SPEC §8).
import { validationError } from './errors.js';
import { QR_PRESETS, canonicalQrPreset, qrPresetId, upgradeLegacyQrStyle } from './themes.js';

export const QR_STYLE_MAX_BYTES = 2048;
const HEX_RE = /^#[0-9a-f]{6}$/i;

const ENUMS = {
  preset: QR_PRESETS,
  dotType: ['square', 'dots', 'rounded', 'classy', 'classy-rounded', 'extra-rounded'],
  gradientType: ['linear', 'radial'],
  cornerSquareType: ['square', 'dot', 'extra-rounded', 'rounded', 'dots', 'classy', 'classy-rounded'],
  cornerDotType: ['square', 'dot', 'rounded', 'dots', 'classy', 'classy-rounded', 'extra-rounded'],
  logo: ['none', 'blip', 'heart', 'star', 'bolt', 'cat', 'link'],
};
const COLORS = ['dotColor', 'bgColor', 'cornerSquareColor', 'cornerDotColor'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function numberIn(key, value, lo, hi) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) {
    throw validationError(`qrStyle.${key}`, `qrStyle.${key} must be a number between ${lo} and ${hi}.`);
  }
  return Math.round(n);
}

/**
 * Validate and whitelist a qrStyle. Unknown keys are dropped; invalid values throw 400 `validation`.
 * @param {unknown} input
 * @returns {object|null} the cleaned style, or null to clear it
 */
export function validateQrStyle(input) {
  if (input === null) return null;
  if (!isPlainObject(input)) throw validationError('qrStyle', 'qrStyle must be an object or null.');
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(input), 'utf8');
  } catch {
    throw validationError('qrStyle', 'qrStyle must be plain JSON.');
  }
  if (size > QR_STYLE_MAX_BYTES) throw validationError('qrStyle', 'qrStyle is too large (max 2 kB).');

  const out = {};
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (input[key] === undefined) continue;
    // Preset ids from the first release (aurora, mono, ...) are accepted and saved under their new names.
    const value = key === 'preset' ? canonicalQrPreset(input[key]) : input[key];
    if (!allowed.includes(value)) {
      throw validationError(`qrStyle.${key}`, `qrStyle.${key} must be one of: ${allowed.join(', ')}.`);
    }
    out[key] = value;
  }
  for (const key of COLORS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || !HEX_RE.test(input[key])) {
      throw validationError(`qrStyle.${key}`, `qrStyle.${key} must be a #rrggbb colour.`);
    }
    out[key] = input[key].toLowerCase();
  }
  if (input.dotColor2 !== undefined) {
    if (input.dotColor2 === null) out.dotColor2 = null;
    else if (typeof input.dotColor2 === 'string' && HEX_RE.test(input.dotColor2)) out.dotColor2 = input.dotColor2.toLowerCase();
    else throw validationError('qrStyle.dotColor2', 'qrStyle.dotColor2 must be a #rrggbb colour or null.');
  }
  if (input.gradientRotation !== undefined) out.gradientRotation = numberIn('gradientRotation', input.gradientRotation, 0, 360);
  if (input.margin !== undefined) out.margin = numberIn('margin', input.margin, 0, 40);
  if (input.transparentBg !== undefined) {
    if (typeof input.transparentBg !== 'boolean') throw validationError('qrStyle.transparentBg', 'qrStyle.transparentBg must be true or false.');
    out.transparentBg = input.transparentBg;
  }
  if (input.caption !== undefined) {
    if (input.caption === null) out.caption = null;
    else if (typeof input.caption === 'string') {
      // eslint-disable-next-line no-control-regex
      const caption = input.caption.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (caption.length > 40) throw validationError('qrStyle.caption', 'qrStyle.caption must be 40 characters or fewer.');
      out.caption = caption || null;
    } else throw validationError('qrStyle.caption', 'qrStyle.caption must be a string or null.');
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A qrStyle read back from the database. A style still saved under a first-release preset id is
 * that preset's old look, so it is served as the replacement preset's flat look (caption and a
 * user-picked logo kept, see upgradeLegacyQrStyle). Unknown preset ids become "custom".
 * Anything that is not a plain object is treated as "no style".
 * @param {unknown} style parsed qr_style column
 * @returns {object|null}
 */
export function storedQrStyle(style) {
  if (!isPlainObject(style)) return null;
  if (style.preset === undefined) return style;
  const upgraded = upgradeLegacyQrStyle(style);
  return { ...upgraded, preset: qrPresetId(upgraded.preset) };
}
