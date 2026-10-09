// Design-rule audit for Blip (see DESIGN.md). Scans the shipped UI for "vibe coded" tells, and checks
// colour contrast: theme token text pairs, COMIC_PALETTE against the tokens, and every stock QR preset.
// Usage: node scripts/audit-design.mjs            (exit 1 when anything is flagged)
//        node scripts/audit-design.mjs --json
// A line can opt out of a rule with a same-line comment containing "audit-ok: <reason>",
// e.g. halftone dots drawn with radial-gradient. Reasons are printed in the summary.
// The opacity-fade rule has no opt-out: DESIGN.md section 7 never allows fading a disabled, inactive or
// unselected control. It flags opacity strictly between 0 and 1; opacity: 0 hides (a visually hidden input).
// Importing this file runs nothing; it exports cssBlockFindings() for the tests.
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, extname, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => relative(root, p).replace(/\\/g, '/');

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.includes(extname(name))) out.push(p);
  }
  return out;
}

const ALLOWED_HEX = new Set([
  '#fbf3df', '#efe3c4', '#fffdf7', '#111111', '#111', '#33302b', '#55504a',
  '#d62828', '#a91d1d', '#1f5fad', '#174a88', '#f2b705', '#d29f00', '#237a35', '#e8590c', '#7a1414',
  '#ffffff', '#fff', '#000000', '#000',
]);

const EM_DASH = '\u2014'; // escaped, so this file holds no em dash itself
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
const FONT = /["']Inter( Variable)?["']|fonts?\/inter\b|@fontsource(-variable)?\/inter\b|Geist|Space ?Grotesk|space-grotesk/i;
const COPY_CONTRAST = /\bit'?s not (just )?[^.!?]{1,50}[,;:]\s*it'?s\b|\bnot just [^.!?]{1,50}(,|;)?\s*but\b|\bisn'?t (just )?[^.!?]{1,40}[,;]\s*it'?s\b/i;
const SPARKLE = /sparkle|wand-sparkles|party-popper|magic-wand|confetti|twinkle/i;
const MARKETING = /testimonial|pricing|per month|\/mo\b|traffic-light|terminal-window|class="[^"]*\bterminal\b/i;

/** The reason of an "audit-ok: <reason>" marker in text, or null. */
function okReason(text) {
  const m = text.match(/audit-ok:\s*([^*>\n]*)/);
  return m ? m[1].trim() : null;
}

/** Values of the CSS declarations on a line whose property matches props, e.g. "border-radius: 0" gives ['0']. */
function declValues(line, props) {
  const out = [];
  const re = new RegExp(`(?:^|[;{\\s])(?:${props})\\s*:\\s*([^;}]+)`, 'g');
  for (const m of line.matchAll(re)) out.push(m[1].trim().replace(/\s*!important$/, ''));
  return out;
}

/** Top-level tracks of a grid-template-columns value; "auto minmax(0, 1fr)" is two tracks, not three. */
function gridTracks(value) {
  const tracks = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && /\s/.test(ch)) {
      if (current) tracks.push(current);
      current = '';
    } else current += ch;
  }
  if (current) tracks.push(current);
  return tracks;
}

/**
 * Three tracks that can hold three cards side by side. A row whose outer tracks size to their
 * content, such as "auto minmax(0, 1fr) auto" (icon, text, action), is one item's inner layout.
 */
const threeCardTracks = (value) => {
  const tracks = gridTracks(value);
  const contentSized = tracks.filter((t) => /^(auto|min-content|max-content|fit-content\(.*\))$/.test(t)).length;
  return tracks.length === 3 && contentSized < 2;
};

/**
 * Splits a selector into its :not(...) groups and the rest, e.g. ".chip:not(.is-active):hover" gives
 * { rest: ".chip:hover", groups: [".is-active"] }. Nested groups stay inside their parent group.
 */
function splitNot(selector) {
  let rest = '';
  const groups = [];
  for (let i = 0; i < selector.length; i += 1) {
    if (selector.slice(i, i + 5).toLowerCase() !== ':not(') {
      rest += selector[i];
      continue;
    }
    let depth = 0;
    let j = i + 4; // the "(" of ":not("
    for (; j < selector.length; j += 1) {
      if (selector[j] === '(') depth += 1;
      else if (selector[j] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    groups.push(selector.slice(i + 5, j));
    i = j;
  }
  return { rest, groups };
}

/** `[aria-disabled="false"]` (or `disabled` / `data-disabled` set to false): an enabled control. */
const FALSE_DISABLED_ATTR = String.raw`\[\s*(?:aria-|data-)?disabled\s*=\s*["']?false["']?\s*(?:[is]\s*)?\]`;

/**
 * Disabled, inactive, off or unselected states: :disabled, [disabled], .is-disabled, [aria-disabled="true"],
 * .is-inactive, .is-off, [inert], .is-unselected, [aria-checked="false"], [aria-pressed="false"], [aria-selected="false"].
 * Tested after FALSE_DISABLED_ATTR groups are removed, so [aria-disabled="false"] is not a disabled state.
 */
const INACTIVE_STATE = new RegExp([
  'disabled', 'inactive', 'unselected', 'unchecked',
  String.raw`(?:\.is-|--)off(?![\w-])`,
  String.raw`\[\s*inert\s*(?:=[^\]]*)?\]`,
  String.raw`\[\s*aria-(?:checked|pressed|selected)\s*=\s*["']?false["']?\s*(?:[is]\s*)?\]`,
].join('|'), 'i');

/**
 * Selected, active or enabled states, which fade the rest when negated: .is-active, .is-selected, .is-pressed,
 * .is-on (or the bare and BEM "--" forms), :checked, :active, :enabled, [aria-checked="true"],
 * [aria-pressed="true"], [aria-selected="true"], [aria-current] (any value but false), [data-state="active"],
 * [aria-disabled="false"].
 */
const ACTIVE_STATE = new RegExp([
  String.raw`(?:\.is-|\.|--)(?:active|selected|checked|pressed|current|on|enabled)(?![\w-])`,
  String.raw`:(?:checked|active|enabled)(?![\w-])`,
  String.raw`\[\s*aria-(?:checked|pressed|selected)\s*=\s*["']?true["']?\s*(?:[is]\s*)?\]`,
  String.raw`\[\s*aria-current\s*(?:\]|=\s*(?!["']?false["']?\s*(?:[is]\s*)?\])[^\]]*\])`,
  String.raw`\[\s*data-state\s*=\s*["']?(?:active|on|checked|selected)["']?\s*(?:[is]\s*)?\]`,
  FALSE_DISABLED_ATTR,
].join('|'), 'i');

/**
 * True when a selector (or any selector in a list) targets a disabled, inactive or unselected control:
 * a state named outright (".btn:disabled", ".toggle.is-off", "[inert]") or a :not() of a selected one
 * (".chip:not(.is-active)", ".seg button:not([aria-checked=\"true\"])"). Each :not() flips which kind of
 * state counts, so a :not() of a disabled state (".btn:hover:not([disabled])") says nothing about disabled controls.
 */
function targetsInactive(selector, negated = false) {
  const { rest, groups } = splitNot(selector);
  const state = negated ? ACTIVE_STATE : INACTIVE_STATE;
  if (state.test(negated ? rest : rest.replace(new RegExp(FALSE_DISABLED_ATTR, 'gi'), ''))) return true;
  return groups.some((group) => targetsInactive(group, !negated));
}

/**
 * True when a CSS opacity value fades: anything strictly between 0 and 1, or a value that is not provably
 * fully opaque (1, 100%, a keyword that resets it) or fully transparent (0 hides, e.g. a visually hidden input).
 */
function isFade(value) {
  const v = value.trim().toLowerCase();
  if (v === '' || /^(initial|unset|revert|revert-layer)$/.test(v)) return false;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(v);
  if (!m) return true; // var(), calc() or inherit: not provably opaque or hidden
  const n = Number(m[1]) / (m[2] ? 100 : 1);
  return n > 0 && n < 1;
}

/** Index in a declaration block of the first `opacity` (or `filter: opacity()`) strictly between 0 and 1, or -1. */
function fadeIndex(block) {
  const body = block.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' ')); // keeps offsets and lines
  for (const m of body.matchAll(/(?:^|[;{\s])(opacity\s*:\s*([^;}]+)|filter\s*:[^;}]*?opacity\(\s*([^)]*)\))/g)) {
    const value = (m[2] ?? m[3] ?? '').replace(/\s*!important$/, '');
    if (isFade(value)) return m.index + m[0].indexOf(m[1]);
  }
  return -1;
}

/**
 * Rules that need a whole CSS rule (selector + declarations) rather than one line: hover motion,
 * animated arrows, coloured stripes and faded disabled states.
 * @param {string} src CSS source
 * @returns {{ findings: { rule: string, line: number, text: string }[], allowed: string[] }}
 *          `allowed` lists the audit-ok reasons of the blocks that opted out.
 */
export function cssBlockFindings(src) {
  const findings = [];
  const allowed = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const selector = m[1].trim().split('\n').pop().trim();
    const body = m[2];
    const line = src.slice(0, m.index).split('\n').length + m[1].split('\n').length - 1;
    const summary = (sel) => `${sel} { ${body.trim().replace(/\s+/g, ' ')} }`;
    const add = (rule, at = line, sel = selector) => findings.push({ rule, line: at, text: summary(sel) });

    // A disabled control is a flat --paper-2 fill with --muted text and a dashed outline, and an unselected
    // chip or segment keeps its full colours: never a fade. The whole selector list counts (minus comments
    // and any at-rule before it).
    const fullSelector = m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').split(';').pop().replace(/\s+/g, ' ').trim();
    if (targetsInactive(fullSelector)) {
      const at = fadeIndex(body);
      if (at >= 0) add('opacity-fade', line + (body.slice(0, at).match(/\n/g) || []).length, fullSelector);
    }

    if (/audit-ok:[^*\n]*(hover|motion|arrow|stripe)/i.test(m[0])) {
      allowed.push(okReason(m[0]));
      continue;
    }
    if (/:hover/.test(selector) && /(transform|translate|scale|rotate|animation)\s*:/.test(body) && !/btn--primary/.test(selector)) {
      add('hover-motion');
    }
    if (/arrow/i.test(selector) && /animation\s*:|transform\s*:/.test(body)) {
      add('animated-arrow');
    }
    if (/(^|\s|,)[^,]*(stripe|accent-bar|::before|::after)/.test(selector) && /(^|;)\s*(width|inline-size)\s*:\s*[1-6]px/.test(body) && /(height|block-size)\s*:\s*100%|inset\s*:\s*0|top\s*:\s*0[^;]*;[^}]*bottom\s*:\s*0/.test(body)) {
      add('coloured-stripe');
    }
    if (/border-(left|right|top|bottom|inline-start|inline-end|block-start|block-end)(-color)?\s*:\s*[^;]*var\(--(red|blue|yellow|green|orange|accent|viz-\d)/.test(body)) {
      add('coloured-stripe');
    }
  }
  return { findings, allowed };
}

const isCss = (f) => f.endsWith('.css');

async function runAudit() {
  const uiFiles = [
    // public/vendor holds third-party copies made by `npm run build` (scripts/build-vendor.mjs), not Blip's UI.
    ...walk(join(root, 'public'), ['.html', '.css', '.js']).filter((f) => !f.endsWith('icons.svg') && !rel(f).startsWith('public/vendor/')),
    ...walk(join(root, 'server', 'views'), ['.html']),
  ];
  const serverText = walk(join(root, 'server'), ['.js']); // user-facing strings (errors, trivia, domain notes)
  const docs = [join(root, 'README.md')];

  const findings = [];
  const okReasons = new Map();
  const flag = (rule, file, line, text) => findings.push({ rule, file: rel(file), line, text: text.trim().slice(0, 160) });
  const allow = (rule, reason) => okReasons.set(`${rule}: ${reason}`, (okReasons.get(`${rule}: ${reason}`) || 0) + 1);

  function lineOk(line, rule) {
    const reason = okReason(line);
    if (reason === null) return false;
    allow(rule, reason);
    return true;
  }

  function scanLines(file, rules) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [rule, test] of rules) {
        if (test(line, file) && !lineOk(line, rule)) flag(rule, file, i + 1, line);
      }
    });
    return lines;
  }

  // ---- line rules for UI files ----
  for (const file of uiFiles) {
    const css = isCss(file);
    scanLines(file, [
      ['em-dash', (l) => l.includes(EM_DASH)],
      ['emoji', (l) => EMOJI.test(l)],
      ['banned-font', (l) => FONT.test(l)],
      ['lucide', (l) => /lucide/i.test(l)],
      ['glass', (l) => /backdrop-filter|-webkit-backdrop-filter/.test(l)],
      ['shadow', (l) => declValues(l, 'box-shadow|text-shadow').some((v) => v !== 'none') || /drop-shadow\(|feDropShadow|boxShadow\s*=\s*['"`](?!none)|textShadow\s*=\s*['"`](?!none)/.test(l)],
      ['blur-orb', (l) => /filter\s*:\s*[^;]*blur\(|feGaussianBlur|stdDeviation/.test(l)],
      ['gradient', (l) => /(linear|radial|conic)-gradient\(|<(linear|radial)Gradient|\b(linear|radial)Gradient\b|createLinearGradient|createRadialGradient/.test(l)],
      ['rounded-corners', (l) => declValues(l, 'border-radius|border-[a-z-]+-radius').some((v) => !/^0(px|%)?$/.test(v)) || /\brx\s*=\s*["']?[1-9]|\.attr\(\s*['"]r[xy]['"]\s*,\s*(?!0\s*\))/.test(l) || /borderRadius\s*=\s*['"`](?!0)/.test(l)],
      ['sparkle', (l) => SPARKLE.test(l)],
      ['marketing-chrome', (l) => MARKETING.test(l)],
      ['copy-contrast', (l) => COPY_CONTRAST.test(l)],
      ['three-across', (l) => css && (/repeat\(\s*(3|auto-fit|auto-fill)\s*,/.test(l) || declValues(l, 'grid-template-columns').some(threeCardTracks))],
      ['transition', (l) => css && declValues(l, 'transition|transition-property|transition-duration').some((v) => v !== 'none' && !/^0(\.\d+)?m?s$/.test(v))],
      ['off-palette-colour', (l, f) => !f.endsWith('theme.css') && (l.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/g) || []).some((h) => !ALLOWED_HEX.has(h.toLowerCase()))],
      ['hsl-rgb-colour', (l, f) => !f.endsWith('theme.css') && /\b(hsla?|rgba?)\(\s*\d/.test(l) && !/rgba?\(\s*(17|0)\s*,\s*(17|0)\s*,\s*(17|0)\s*,/.test(l) && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(l)],
    ]);
  }

  // ---- CSS block rules: hover motion, animated arrows, coloured stripes, faded disabled states ----
  for (const file of uiFiles.filter(isCss)) {
    const { findings: blockFindings, allowed } = cssBlockFindings(readFileSync(file, 'utf8'));
    for (const f of blockFindings) flag(f.rule, file, f.line, f.text);
    for (const reason of allowed) allow('block', reason);
  }

  // ---- server strings and docs: copy rules only ----
  for (const file of [...serverText, ...docs]) {
    scanLines(file, [
      ['em-dash', (l) => l.includes(EM_DASH)],
      ['emoji', (l) => EMOJI.test(l)],
      ['copy-contrast', (l) => COPY_CONTRAST.test(l)],
      ['banned-font', (l) => FONT.test(l)],
      ['lucide', (l) => /lucide/i.test(l)],
    ]);
  }

  // ---- coverage: every data-fetching page shows skeletons while loading ----
  const pages = {
    'home (index.html + js/app.js + js/home/*)': ['public/index.html', 'public/assets/js/app.js', ...walk(join(root, 'public/assets/js/home'), ['.js']).map(rel)],
    'dashboard': ['public/dashboard.html', 'public/assets/js/dashboard.js', ...walk(join(root, 'public/assets/js/dashboard'), ['.js']).map(rel)],
    'qr studio': ['public/qr.html', 'public/assets/js/qr.js', ...walk(join(root, 'public/assets/js/qr'), ['.js']).map(rel)],
  };
  for (const [page, files] of Object.entries(pages)) {
    const text = files.map((f) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return ''; } }).join('\n');
    if (!/skeleton/.test(text)) findings.push({ rule: 'missing-skeleton', file: page, line: 0, text: 'no skeleton loader found' });
  }

  // ---- sprite ids used must exist ----
  const sprite = readFileSync(join(root, 'public/assets/icons.svg'), 'utf8');
  const ids = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((x) => x[1]));
  // Glyphs DESIGN.md section 5 bans must not ship in the sprite at all (sparkles, stars, confetti, 3D cubes).
  const BANNED_GLYPH = /^(star|stars|sparkle|sparkles|wand-sparkles|magic-wand|party-popper|confetti|twinkle|move-3d|cube)$/;
  for (const id of ids) {
    if (BANNED_GLYPH.test(id)) findings.push({ rule: 'banned-icon', file: 'public/assets/icons.svg', line: 0, text: `sprite ships the banned glyph "${id}" (remove it from scripts/build-icons.mjs)` });
  }
  for (const file of uiFiles.filter((f) => !isCss(f))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      for (const mm of l.matchAll(/icons\.svg#([a-z0-9-]+)|\bicon\(\s*['"]([a-z0-9-]+)['"]|setIcon\([^,]+,\s*['"]([a-z0-9-]+)['"]/g)) {
        const id = mm[1] || mm[2] || mm[3];
        if (!ids.has(id)) flag('unknown-icon', file, i + 1, `icon "${id}" is not in public/assets/icons.svg`);
      }
    });
  }

  // ---- colour contrast: theme token text pairs, the QR palette mirror and the stock QR presets ----
  const themeFile = join(root, 'public/assets/css/theme.css');
  const qrFile = join(root, 'public/assets/js/qr-shared.js');
  const qrShared = await import(pathToFileURL(qrFile).href);
  const themeSrc = readFileSync(themeFile, 'utf8');
  const qrSrc = readFileSync(qrFile, 'utf8');
  /** 1-based line of the first match of re in src (0 when absent), so findings point at the declaration. */
  const lineOf = (src, re) => { const i = src.search(re); return i < 0 ? 0 : src.slice(0, i).split('\n').length; };
  const rootBlock = themeSrc.match(/:root\s*\{([^}]*)\}/)?.[1] || '';
  const tokens = Object.fromEntries([...rootBlock.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\b/gi)].map((t) => [t[1], t[2].toLowerCase()]));
  const colourOf = (name) => (name === 'white' ? '#ffffff' : tokens[name]);
  const tokenLine = (name) => lineOf(themeSrc, new RegExp(String.raw`--${name}\s*:`));
  // DESIGN.md section 3: text on red, blue, green or ink is white; text on yellow, paper or panel is ink.
  // Secondary text keeps AA on the light surfaces, and green, dark red and blue also serve as text colours.
  const TEXT_PAIRS = [
    ...['red', 'red-dark', 'blue', 'blue-dark', 'green', 'ink'].map((bg) => ['white', bg]),
    ...['yellow', 'yellow-dark', 'paper', 'paper-2', 'panel'].map((bg) => ['ink', bg]),
    ['yellow', 'ink'], ['ink-2', 'yellow'],
    ...['ink-2', 'muted', 'green', 'red-dark', 'blue'].flatMap((fg) => ['paper', 'panel'].map((bg) => [fg, bg])),
    ['ink-2', 'paper-2'], ['muted', 'paper-2'],
  ];
  for (const [fg, bg] of TEXT_PAIRS) {
    const [a, b] = [colourOf(fg), colourOf(bg)];
    if (!a || !b) { flag('token-contrast', themeFile, 0, `--${!a ? fg : bg} is not a hex token in :root`); continue; }
    const ratio = qrShared.contrastRatio(a, b);
    const at = tokenLine(fg === 'white' ? bg : fg);
    if (ratio < 4.5) flag('token-contrast', themeFile, at, `${fg} text on --${bg} is ${ratio.toFixed(2)}:1 (AA needs 4.5:1)`);
  }
  // COMIC_PALETTE (QR codes are drawn with real hex values) must mirror the theme tokens.
  const PALETTE_TOKENS = { ink: 'ink', red: 'red', blue: 'blue', yellow: 'yellow', green: 'green', orange: 'orange', paper: 'paper', paper2: 'paper-2', panel: 'panel' };
  for (const [key, token] of Object.entries(PALETTE_TOKENS)) {
    if (qrShared.COMIC_PALETTE[key]?.toLowerCase() !== tokens[token]) {
      flag('palette-drift', qrFile, lineOf(qrSrc, new RegExp(String.raw`^\s*${key}\s*:`, 'm')), `COMIC_PALETTE.${key} is ${qrShared.COMIC_PALETTE[key]} but --${token} is ${tokens[token]}`);
    }
  }
  // Stock QR presets stay clear of the studio's low-contrast warning.
  for (const id of Object.keys(qrShared.QR_PRESETS)) {
    const ratio = qrShared.qrContrast(qrShared.presetStyle(id));
    if (ratio < 4.5) flag('qr-preset-contrast', qrFile, lineOf(qrSrc, new RegExp(String.raw`^\s*${id}: look\(`, 'm')), `preset "${id}" has a colour at ${ratio.toFixed(2)}:1 on its background (needs 4.5:1)`);
  }

  const byRule = {};
  for (const f of findings) (byRule[f.rule] = byRule[f.rule] || []).push(f);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ total: findings.length, byRule, allowed: Object.fromEntries(okReasons) }, null, 2));
  } else {
    for (const [rule, list] of Object.entries(byRule)) {
      console.log(`\n${rule} (${list.length})`);
      for (const f of list.slice(0, 60)) console.log(`  ${f.file}:${f.line}  ${f.text}`);
      if (list.length > 60) console.log(`  ... ${list.length - 60} more`);
    }
    console.log(`\n${findings.length} finding(s).`);
    if (okReasons.size) {
      console.log('Allowed by audit-ok markers:');
      for (const [k, v] of okReasons) console.log(`  ${v} x ${k}`);
    }
  }
  process.exitCode = findings.length ? 1 : 0;
}

// Run only as a script (`node scripts/audit-design.mjs`), never on import.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const [a, b] = [realpathSync(resolve(process.argv[1])), realpathSync(fileURLToPath(import.meta.url))];
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}
if (invokedDirectly()) await runAudit();
