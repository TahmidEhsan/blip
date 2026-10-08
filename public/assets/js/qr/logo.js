// Blip QR studio: custom centre logos. Uploads never leave the browser: the file is
// validated, normalised to a data URL and remembered in localStorage per slug.

export const LOGO_MAX_BYTES = 512 * 1024;
const MAX_DIMENSION = 512;
const STORE_PREFIX = 'blip.qrLogo.v1:';
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };
const ALLOWED_MIME = new Set(Object.values(MIME_BY_EXT));

export class LogoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LogoError';
  }
}

function mimeFor(file) {
  if (ALLOWED_MIME.has(file.type)) return file.type;
  if (file.type) return null;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name || '')?.[1]?.toLowerCase();
  return MIME_BY_EXT[ext] || null;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new LogoError("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new LogoError("That image couldn't be opened. Is the file damaged?"));
    img.src = src;
  });
}

/**
 * Redraw the logo on a canvas so it is at most 512 px on its longest side and so SVGs
 * become plain bitmaps (predictable size inside the QR, nothing executable).
 * Returns the original data URL when re-encoding isn't possible or needed.
 */
function normalise(img, dataUrl, mime) {
  const naturalW = img.naturalWidth || 0;
  const naturalH = img.naturalHeight || 0;
  const isSvg = mime === 'image/svg+xml';
  if (!isSvg && naturalW <= MAX_DIMENSION && naturalH <= MAX_DIMENSION && naturalW > 0) return dataUrl;

  const w0 = naturalW || MAX_DIMENSION;
  const h0 = naturalH || MAX_DIMENSION;
  const longest = Math.max(w0, h0);
  // Vectors are rendered at full size for crispness; bitmaps are only ever scaled down.
  const scale = isSvg ? MAX_DIMENSION / longest : Math.min(1, MAX_DIMENSION / longest);
  const width = Math.max(1, Math.round(w0 * scale));
  const height = Math.max(1, Math.round(h0 * scale));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    return mime === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL('image/png');
  } catch {
    return dataUrl;
  }
}

/** Validate and load an uploaded logo. Resolves to { dataUrl, name }. Throws LogoError. */
export async function readLogoFile(file) {
  if (!file) throw new LogoError('No file selected.');
  const mime = mimeFor(file);
  if (!mime) throw new LogoError('Logos must be PNG, JPG or SVG images.');
  if (file.size > LOGO_MAX_BYTES) {
    throw new LogoError(`That file is ${Math.ceil(file.size / 1024)} kB. Logos can be up to 512 kB.`);
  }
  if (file.size === 0) throw new LogoError('That file is empty.');

  let dataUrl = await readAsDataUrl(file);
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new LogoError("Couldn't read that file.");
  // Make sure the data URL carries the real image type (files without a type come through as octet-stream).
  dataUrl = `data:${mime};base64,${dataUrl.slice(comma + 1)}`;

  const img = await loadImage(dataUrl);
  const normalised = normalise(img, dataUrl, mime);
  const name = String(file.name || 'logo').slice(0, 80);
  return { dataUrl: normalised, name };
}

/** Per-slug memory of the uploaded logo: { dataUrl, name, active }. */
export const logoStore = {
  key(slug) {
    return `${STORE_PREFIX}${slug}`;
  },
  get(slug) {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.key(slug)) || 'null');
      if (parsed && typeof parsed.dataUrl === 'string' && /^data:image\/(png|jpeg|svg\+xml)[;,]/.test(parsed.dataUrl)) {
        return { dataUrl: parsed.dataUrl, name: typeof parsed.name === 'string' ? parsed.name : 'logo', active: Boolean(parsed.active) };
      }
    } catch {
      /* fall through */
    }
    return null;
  },
  set(slug, value) {
    try {
      localStorage.setItem(this.key(slug), JSON.stringify({ dataUrl: value.dataUrl, name: value.name, active: Boolean(value.active) }));
      return true;
    } catch {
      return false;
    }
  },
  setActive(slug, active) {
    const current = this.get(slug);
    if (!current) return false;
    return this.set(slug, { ...current, active });
  },
  remove(slug) {
    try {
      localStorage.removeItem(this.key(slug));
      return true;
    } catch {
      return false;
    }
  },
};
