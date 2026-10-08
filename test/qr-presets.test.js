// Stock QR looks (DESIGN.md section 12): flat comic colours that stay scannable, legacy ids that map
// onto them, and a palette that mirrors the theme.css tokens. scripts/audit-design.mjs checks the same
// contrast and palette rules; this keeps them in the test run too.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COMIC_PALETTE,
  DEFAULT_QR_STYLE,
  LEGACY_PRESETS,
  LOGOS,
  QR_PRESETS,
  presetStyle,
  qrContrast,
} from '../public/assets/js/qr-shared.js';

const theme = readFileSync(new URL('../public/assets/css/theme.css', import.meta.url), 'utf8');
const rootBlock = theme.match(/:root\s*\{([^}]*)\}/)?.[1] || '';
const token = (name) => rootBlock.match(new RegExp(String.raw`--${name}\s*:\s*(#[0-9a-f]{6})\b`, 'i'))?.[1].toLowerCase();

describe('QR presets', () => {
  it('ships the seven comic presets', () => {
    assert.deepEqual(Object.keys(QR_PRESETS).sort(), ['caption', 'hero', 'ink', 'noir', 'pop', 'press', 'sky']);
  });

  it('keeps every preset colour at 4.5:1 or better against its background', () => {
    for (const id of Object.keys(QR_PRESETS)) {
      const ratio = qrContrast(presetStyle(id));
      assert.ok(ratio >= 4.5, `preset "${id}" is ${ratio.toFixed(2)}:1`);
    }
  });

  it('draws every preset flat: one dot colour, opaque background, a known logo', () => {
    for (const [id, preset] of Object.entries(QR_PRESETS)) {
      assert.equal(preset.dotColor2, null, `${id} has two-tone dots off`);
      assert.equal(preset.transparentBg, false, `${id} has an opaque background`);
      assert.ok(Object.hasOwn(LOGOS, preset.logo), `${id} logo "${preset.logo}" exists`);
    }
    assert.equal(DEFAULT_QR_STYLE.dotColor2, null, 'two-tone dots are off by default');
  });

  it('maps every legacy preset id onto a current preset', () => {
    for (const [legacy, current] of Object.entries(LEGACY_PRESETS)) {
      assert.ok(Object.hasOwn(QR_PRESETS, current), `${legacy} maps to an existing preset`);
      assert.deepEqual(presetStyle(legacy), presetStyle(current), `${legacy} renders as ${current}`);
    }
  });

  it('keeps the star logo id, drawn as the comic burst', () => {
    assert.ok(Object.hasOwn(LOGOS, 'star'));
    assert.equal(LOGOS.star.label, 'Burst');
  });
});

describe('COMIC_PALETTE', () => {
  it('mirrors the theme.css colour tokens', () => {
    const pairs = { ink: 'ink', red: 'red', blue: 'blue', yellow: 'yellow', green: 'green', orange: 'orange', paper: 'paper', paper2: 'paper-2', panel: 'panel' };
    for (const [key, name] of Object.entries(pairs)) {
      assert.equal(COMIC_PALETTE[key].toLowerCase(), token(name), `COMIC_PALETTE.${key} matches --${name}`);
    }
  });
});
