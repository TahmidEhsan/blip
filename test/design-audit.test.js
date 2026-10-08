// The design audit (scripts/audit-design.mjs, rules from DESIGN.md) runs with the tests, so npm test
// fails on any finding, plus unit tests for the CSS block rules it applies.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cssBlockFindings } from '../scripts/audit-design.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Run the audit like `npm run audit:design -- --json`; it exits 1 when anything is flagged. */
function runAudit() {
  const args = [path.join('scripts', 'audit-design.mjs'), '--json'];
  try {
    const stdout = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, report: JSON.parse(stdout) };
  } catch (err) {
    if (typeof err.stdout !== 'string' || !err.stdout.trim()) throw err;
    return { status: err.status, report: JSON.parse(err.stdout) };
  }
}

describe('design audit', () => {
  it('reports 0 findings for the shipped UI, server copy and README', () => {
    const { status, report } = runAudit();
    const listed = Object.values(report.byRule).flat().map((f) => `  ${f.rule}  ${f.file}:${f.line}  ${f.text}`);
    assert.equal(report.total, 0, `node scripts/audit-design.mjs found ${report.total} problem(s):\n${listed.join('\n')}`);
    assert.equal(status, 0);
  });
});

describe('audit CSS block rules', () => {
  const flagged = (css) => cssBlockFindings(css).findings.map((f) => `${f.rule}@${f.line}`);

  it('opacity-fade flags disabled and inactive states faded with opacity', () => {
    assert.deepEqual(flagged('.btn:disabled { opacity: .5; }'), ['opacity-fade@1']);
    assert.deepEqual(flagged('.qr-color.is-disabled { opacity: 0.5; cursor: not-allowed; }'), ['opacity-fade@1']);
    assert.deepEqual(flagged('.chip[aria-disabled="true"] {\n  color: var(--muted);\n  opacity: 40%;\n}'), ['opacity-fade@3'], 'points at the declaration');
    assert.deepEqual(flagged('.tab.is-inactive { filter: opacity(0.6); }'), ['opacity-fade@1']);
    assert.deepEqual(flagged('.field,\n.field[disabled] { opacity: 0.99 !important; }'), ['opacity-fade@2'], 'any selector in the list');
    assert.deepEqual(flagged('.a { color: var(--ink); }\n@media (max-width: 600px) {\n  .seg input:disabled + label { opacity: 0.4 }\n}'), ['opacity-fade@3']);
    assert.deepEqual(flagged('.x.is-disabled { opacity: var(--fade); }'), ['opacity-fade@1'], 'a variable is not provably opaque');
  });

  it('opacity-fade flags off and unselected states, including a :not() of a selected or active state', () => {
    const faded = [
      '.chip:not(.is-active) { opacity: .5; }',
      '.seg button:not([aria-checked="true"]) { opacity: 0.45; }',
      ".chip:not([aria-pressed='true']):hover { opacity: 0.8; }",
      '.tabs [role="tab"]:not([aria-selected="true"]) { opacity: .6; }',
      '.site-nav a:not([aria-current]) { opacity: .7; }',
      '.segmented input:not(:checked) + label { opacity: .5; }',
      '.chip:not(.is-selected, .is-pressed) { opacity: .5; }',
      '.btn:not(:enabled) { opacity: .5; }',
      '.x:not(:not([disabled])) { opacity: .5; }',
      '[inert] { opacity:.5 }',
      '.toggle.is-off { opacity:.5 }',
      '.live-dot--off { opacity: 0.5; }',
      '.tab[aria-selected="false"] { opacity: .6; }',
      '.option.is-unselected { opacity: .6; }',
    ];
    for (const css of faded) assert.deepEqual(flagged(css), ['opacity-fade@1'], css);
  });

  it('opacity-fade leaves the flat disabled style, opaque values and unrelated rules alone', () => {
    const ok = [
      // theme.css: the approved disabled look (flat fill, muted text, dashed outline).
      '/* Disabled: never faded with opacity. */\n.btn:not(.is-loading):is([disabled], [aria-disabled="true"]) {\n  --btn-bg: var(--paper-2); --btn-fg: var(--muted);\n  border-style: dashed; cursor: not-allowed;\n}',
      '.btn--primary:hover:not([disabled]) { opacity: 0.8; }', // a :not(disabled) group says nothing about disabled controls
      '.btn:hover:not(:disabled):not([aria-disabled="true"]) { opacity: 0.9; }',
      '.chip:not(.is-inactive):hover { opacity: 0.9; }', // is-inactive is not is-active
      '.btn[aria-disabled="false"] { opacity: .5; }', // explicitly enabled
      '.btn:disabled { opacity: 1; }',
      '.btn[disabled] { opacity: 100%; }',
      '.btn[disabled] { opacity: 1 /* fully opaque */; }',
      // opacity 0 hides rather than fades, like theme.css's visually hidden .switch input.
      '.switch input:disabled { position: absolute; opacity: 0; }',
      '.chip:not(.is-active) .chip__tick { opacity: 0%; }',
      '.seg input[aria-checked="false"] { filter: opacity(0); }',
      '.legend .is-inactive { stroke-opacity: 0.14; fill-opacity: 0.5; }',
      '/* disabled inputs are hidden below */\n.switch input { position: absolute; opacity: 0; }',
      '.result__qr.is-busy { opacity: 0.7; }',
      '.slug-check:not([data-state]) { opacity: 0.5; }',
      '.url-field__input:not(:placeholder-shown) ~ .kbd { opacity: 0.5; }',
      '.icon-row:not(.is-loading) { opacity: 0.8; }',
      '@keyframes blink { 50% { opacity: 0.25; } }',
    ];
    for (const css of ok) assert.deepEqual(flagged(css), [], css);
  });

  it('keeps the hover-motion, animated-arrow and stripe rules and their audit-ok opt-out', () => {
    assert.deepEqual(flagged('.card:hover { transform: translateY(-2px); }'), ['hover-motion@1']);
    assert.deepEqual(flagged('.btn--primary:hover { transform: scale(1.03); }'), []);
    assert.deepEqual(flagged('.next-arrow { animation: nudge 1s infinite; }'), ['animated-arrow@1']);
    assert.deepEqual(flagged('.row { border-left: 4px solid var(--red); }'), ['coloured-stripe@1']);
    const optOut = cssBlockFindings('.tile:hover { transform: rotate(1deg); /* audit-ok: hover wobble on the sticker */ }');
    assert.deepEqual(optOut.findings, []);
    assert.deepEqual(optOut.allowed, ['hover wobble on the sticker']);
  });
});
