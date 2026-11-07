// Blip: teaser theme and QR preset ids (SPEC §6, §8), plus the ids used by the first release.
// The first release had gradient themes (aurora, sunset, ...). The comic redesign renamed them;
// requests that still send an old id are accepted and stored under the new name, and a stored old id
// (say, from imported data) is mapped on the way out.

// QR preset looks live in the browser module shared with the pages, so the ids, the legacy map and
// the flat colours have one source of truth for the server and the client.
import { LEGACY_PRESETS, QR_PRESETS as QR_PRESET_LOOKS, upgradeLegacyQrStyle } from '../public/assets/js/qr-shared.js';

export { upgradeLegacyQrStyle };

/** Build a lookup table that cannot be fooled by inherited keys such as "constructor". */
const table = (entries) => Object.freeze(Object.assign(Object.create(null), entries));

export const TEASER_THEMES = Object.freeze(['hero', 'caption', 'noir', 'sky', 'paper']);
export const DEFAULT_TEASER_THEME = 'hero';
export const LEGACY_TEASER_THEMES = table({ aurora: 'hero', sunset: 'caption', ocean: 'sky', neon: 'noir', candy: 'paper' });

/** ink, hero, caption, sky, pop, press, noir and custom (a look the user styled by hand). */
export const QR_PRESETS = Object.freeze([...Object.keys(QR_PRESET_LOOKS), 'custom']);
/** aurora to hero, sunset to pop, ocean to sky, neon to noir, mono to ink, candy to caption, forest to press. */
export const LEGACY_QR_PRESETS = table(LEGACY_PRESETS);

/** Map a legacy id to its replacement; any other value is returned unchanged (validation happens elsewhere). */
export function canonicalTeaserTheme(value) {
  return typeof value === 'string' && LEGACY_TEASER_THEMES[value] ? LEGACY_TEASER_THEMES[value] : value;
}

export function canonicalQrPreset(value) {
  return typeof value === 'string' && LEGACY_QR_PRESETS[value] ? LEGACY_QR_PRESETS[value] : value;
}

/** A stored teaser_theme as a current id. Unknown values fall back to the default theme. */
export function teaserThemeId(stored) {
  const id = canonicalTeaserTheme(stored);
  return TEASER_THEMES.includes(id) ? id : DEFAULT_TEASER_THEME;
}

/** A stored qrStyle.preset as a current id. Unknown values become "custom", like the browser does. */
export function qrPresetId(stored) {
  const id = canonicalQrPreset(stored);
  return QR_PRESETS.includes(id) ? id : 'custom';
}
