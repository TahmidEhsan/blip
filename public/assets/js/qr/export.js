// Blip QR studio: QRCodeStyling instances for this page, PNG/SVG export and clipboard copy.
import { buildQrOptions, normalizeQrStyle } from '../qr-shared.js';

export const PNG_SIZE = 1024;
const FRAME_PAD = 56; // space between the frame edge and the code
const FRAME_LINE = 12; // ink outline, the 3px panel line at print scale
const CAPTION_BAND = 150;
const INK = '#111111';
const CAPTION_FAMILY = '"Bangers"';
const CAPTION_FONT = `${CAPTION_FAMILY}, Impact, "Arial Black", sans-serif`;
const FONT_WAIT_MS = 2500;

/** A QRCodeStyling instance, or null when the vendor script failed to load. */
export function newQr(options) {
  const Ctor = window.QRCodeStyling;
  return Ctor ? new Ctor(options) : null;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))), 'image/png');
  });
}

async function blobToDrawable(blob) {
  if (typeof window.createImageBitmap === 'function') {
    try {
      return await window.createImageBitmap(blob);
    } catch {
      /* fall back to <img> below */
    }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  return img;
}

/**
 * Wait (briefly) for the Bangers webfont so the caption is lettered in it rather than in a
 * fallback. A canvas only draws with fonts that have already loaded.
 */
async function ensureCaptionFont() {
  const fonts = document.fonts;
  if (!fonts?.load) return;
  const timeout = new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS));
  try {
    await Promise.race([Promise.all([fonts.load(`80px ${CAPTION_FAMILY}`), fonts.ready]), timeout]);
  } catch {
    /* the fallback face is fine */
  }
}

async function renderQrPng(data, style, size, customLogo) {
  const qr = newQr(buildQrOptions(data, style, { size, type: 'svg', customLogo }));
  if (!qr) throw new Error('The QR library did not load. Refresh the page and try again.');
  const raw = await qr.getRawData('png');
  if (!raw) throw new Error('Could not render the QR code.');
  return blobToDrawable(raw);
}

function drawCaption(ctx, style, width, top, bottom) {
  const maxWidth = width - FRAME_PAD * 2 - 24;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
  let fontSize = 88;
  for (;;) {
    ctx.font = `400 ${fontSize}px ${CAPTION_FONT}`;
    if (ctx.measureText(style.caption).width <= maxWidth || fontSize <= 36) break;
    fontSize -= 2;
  }
  ctx.fillStyle = style.dotColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(style.caption, width / 2, top + (bottom - top) / 2 - 14, maxWidth);
}

/**
 * 1024 px wide PNG laid out like a comic panel: a sharp ink outline around the background
 * colour, the code, and the caption lettered underneath in Bangers (when set).
 * Transparent styles skip the panel so the PNG stays see-through.
 */
export async function composePng({ data, style, customLogo = null }) {
  const s = normalizeQrStyle(style);
  const qrSize = PNG_SIZE - FRAME_PAD * 2;
  const [code] = await Promise.all([renderQrPng(data, s, qrSize, customLogo), s.caption ? ensureCaptionFont() : null]);

  const canvas = document.createElement('canvas');
  canvas.width = PNG_SIZE;
  canvas.height = PNG_SIZE + (s.caption ? CAPTION_BAND : 0);
  const ctx = canvas.getContext('2d');

  if (!s.transparentBg) {
    ctx.fillStyle = s.bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = FRAME_LINE;
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = INK;
    ctx.strokeRect(FRAME_LINE / 2, FRAME_LINE / 2, canvas.width - FRAME_LINE, canvas.height - FRAME_LINE);
  }

  ctx.drawImage(code, FRAME_PAD, FRAME_PAD, qrSize, qrSize);
  if (typeof code.close === 'function') code.close();
  if (s.caption) drawCaption(ctx, s, canvas.width, FRAME_PAD + qrSize, canvas.height);
  return canvasToBlob(canvas);
}

/** Vector download: the code only (captions are a PNG feature). */
export async function composeSvg({ data, style, customLogo = null }) {
  const qr = newQr(buildQrOptions(data, normalizeQrStyle(style), { size: PNG_SIZE, type: 'svg', customLogo }));
  if (!qr) throw new Error('The QR library did not load. Refresh the page and try again.');
  const blob = await qr.getRawData('svg');
  if (!blob) throw new Error('Could not render the QR code.');
  return blob;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function canCopyImages() {
  return Boolean(window.isSecureContext && window.ClipboardItem && navigator.clipboard?.write);
}

/**
 * Copy a PNG to the clipboard. The ClipboardItem is created synchronously with a promise
 * (needed by Safari to keep the user gesture); browsers that only accept blobs get a retry.
 */
export async function copyPng(makeBlob) {
  const pending = makeBlob();
  pending.catch(() => {}); // surfaced below if the fallback path needs it
  try {
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': pending })]);
  } catch (err) {
    if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') throw err;
    const blob = await pending;
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
  }
}
