# Blip design rules (comic panel theme)

This file overrides SPEC.md on anything visual or copy related. Every rule is a hard rule: if a component
can't follow one, change the component, not the rule. `node scripts/audit-design.mjs` checks most of them
automatically and must report **0 findings** (intentional exceptions carry a same-line `audit-ok: <reason>` comment).

## 1. What the owner asked for (verbatim intent)

The first version "looked too vibe coded". The redesign must:

1. Drop the harsh gradients and all rainbow colouring.
2. Replace the lucide icons (now Phosphor, see section 5).
3. Use a comic animated theme with a "Spider-Man comic textbox" vibe: narration caption boxes, ink outlines, halftone print.
   Use the *style* only: no Spider-Man (or any other real character, logo, publisher or trademark) names or imagery.
4. Drop the shadows (all of them: box-shadow, text-shadow, drop-shadow, glows, offset "brutalist" shadows).
5. Never put three feature cards in a row.
6. Drop all emojis (including symbol glyphs used as icons: check marks, stars, warning signs, sparkles, flags).
7. Drop liquid glass (translucent panels, backdrop blur).
8. Drop em dashes from every user-facing string and from code comments in shipped files.
9. Do not use Inter, Geist or Space Grotesk.
10. No coloured stripes on widgets (no accent left/top borders, no coloured bars down the side of list items).
11. No fake testimonials, fake stats or fake sample data dressed up as real.
12. No bento grids (mosaics of mixed-size tiles).
13. No terminal-window mock-ups.
14. No "it's not X, it's Y" (or "not just X, but Y") copy.
15. No checkmark bullets.
16. No pricing tiers.
17. Sharp corners on every widget (radius 0): panels, inputs, buttons, chips, badges, dialogs, toasts, skeletons, switches, swatches.
    The only round shapes allowed: the small live status dot and data marks inside charts (map points, line markers).
18. Skeleton loaders wherever data loads.
19. No radial orbs (blurred blobs, glowing circles, spotlight effects).
20. No sparkle icons (sparkles, magic wand, confetti, party popper, twinkling stars).
21. No animated arrows.
22. Hover animation only on important interactive elements. Everything else changes colour instantly, with no movement.
23. Colours are bold, flat, comic-book print colours. No neon, no pastels.

## 2. The look

Ink on newsprint. A comic page: thick black outlines, flat fills, yellow narration caption boxes, Ben-Day halftone dots,
and big hand-lettered sound effects in jagged bursts for the fun moments (link created, link destroyed, 404).
Professional underneath: clear hierarchy, generous spacing, one primary action per view, honest copy.

## 3. Tokens (defined in public/assets/css/theme.css; use the variables, never raw hex)

| Token | Value | Use |
|---|---|---|
| `--paper` | `#fbf3df` | page background (newsprint) |
| `--paper-2` | `#efe3c4` | hover fill, skeleton base, table heads, zero on the map |
| `--panel` | `#fffdf7` | panel interiors |
| `--ink` | `#111111` | text, every outline |
| `--ink-2` / `--muted` | `#33302b` / `#55504a` | secondary / tertiary text |
| `--red` / `--red-dark` | `#d62828` / `#a91d1d` | the primary action, destructive states, expired |
| `--blue` / `--blue-dark` | `#1f5fad` / `#174a88` | links, focus outline, live, single-hue charts |
| `--yellow` / `--yellow-dark` | `#f2b705` / `#d29f00` | caption boxes, selected state (ink text on it) |
| `--green` | `#237a35` | success, active (white text 5.4:1, green text 4.9:1 on paper) |
| `--orange` | `#e8590c` | warnings, map heat |
| `--heat-0..4` | paper-2, yellow, orange, red, `#7a1414` | map choropleth ramp |

Text on red, blue, green or ink is white. Text on yellow, paper or panel is ink. Secondary text on a yellow fill
(a selected tile, a copied row) uses `--ink-2`, never `--muted`, which is only 4.4:1 on yellow. Every token text pair
keeps WCAG AA (4.5:1); the audit checks them.
In JavaScript (d3, canvas) read colours with `getComputedStyle(document.documentElement).getPropertyValue('--blue')`
or use one of the hex values above. The audit rejects any other hex, `rgb()` or `hsl()` colour outside theme.css
(rgba of ink `17,17,17` for translucent ink is allowed).

Lines: `--line` (3px ink) for panels, inputs and buttons; `--line-thin` (2px) for chips, badges, small boxes;
`--line-hair` (1px) for chart gridlines and table rules.

## 4. Typography

- Display: **Bangers** (`--font-display`) for headings, panel titles, button labels, big numbers, sound effects.
- Text: **Comic Neue** 400/700 (`--font-body`) for everything else. Labels and captions are uppercase 700 with letter-spacing.
- Code, URLs, slugs: `--font-mono` (system monospace), also inside Bangers headings: Bangers only has capitals, so a hostname or
  `/slug` in a heading, dialog title or button goes in a mono span with `text-transform: none` and `letter-spacing: 0`.
- Load fonts with:
  ```html
  <link rel="stylesheet" href="/vendor/fonts/bangers/latin-400.css">
  <link rel="stylesheet" href="/vendor/fonts/comic-neue/latin-400.css">
  <link rel="stylesheet" href="/vendor/fonts/comic-neue/latin-700.css">
  ```
- Never Inter, Geist or Space Grotesk. Remove every reference to `/vendor/fonts/inter` and `/vendor/fonts/space-grotesk`.

## 5. Icons

Phosphor "bold" icons served as one sprite, `public/assets/icons.svg` (built by `node scripts/build-icons.mjs`; ids and the
Phosphor glyph behind each are listed in that script). Lucide is gone: delete every `data-lucide` attribute,
`/vendor/lucide.min.js` script tag and `window.lucide` reference.

- In JS: `import { icon, setIcon } from '/assets/js/api.js'` then `icon('copy')` returns an `<svg class="icon">`.
  `setIcon(svgEl, 'eye-off')` swaps a glyph in place. `refreshIcons()` still exists as a no-op; remove calls when convenient.
- In HTML: `<svg class="icon" aria-hidden="true" focusable="false"><use href="/assets/icons.svg#copy"></use></svg>`.
- Need an icon that isn't in the sprite? Add `'id': 'phosphor-name'` to `ICONS` in scripts/build-icons.mjs (check
  `node_modules/@phosphor-icons/core/assets/bold/<name>-bold.svg` exists) and rerun the script. Only the lead's shared-file
  owner edits that script during a parallel build (see your task for ownership); otherwise pick an existing id.
- Banned ids/concepts: sparkles, wand-sparkles, magic wand, confetti, party popper, twinkles, stars and 3D cubes. The sprite
  has no `star` symbol (the QR logo id `star` is drawn by qr-shared.js as a burst, not from the sprite); the audit checks this.
- Icons label things; an icon-only button needs `aria-label`.

## 6. Shape, depth, background

- Radius 0 everywhere (theme.css resets it; never add `border-radius` except the status dot and chart marks).
- No shadows of any kind. Depth comes from 3px ink outlines and flat fills only.
- No glass: panels are opaque `--panel`. No `backdrop-filter`, no translucent white panels.
- Background markup on every page and server view, right after `<body>`:
  ```html
  <div class="bg" aria-hidden="true"><div class="bg-dots"></div><div class="bg-dots bg-dots--red"></div><div class="bg-dots bg-dots--blue"></div></div>
  ```
  (newsprint with slowly drifting halftone dots; red and blue halftone fades in two corners). Remove the old blob/grid/noise markup.
- `.rays` (hard-edged splash rays in the two flat print yellows, `--yellow` and `--yellow-dark`, slow spin) may be used inside
  **one** bordered hero/splash panel per page (`position: relative; overflow: hidden` on the panel). Never fade them with
  opacity, `color-mix` or rgba: a tinted yellow is a pastel.
- `.halftone`, `.halftone--red`, `.halftone--blue` fill an area with print dots (chart areas, splash panels).

## 7. Components (theme.css)

- `.panel` / `.card`: opaque panel with 3px ink border. `.panel--yellow`, `.panel--paper` variants.
- `.caption`: **the signature element**. A yellow narration box with uppercase bold lettering. Use it for section kickers
  ("Add some personality", "Meanwhile, in your links"), panel tags, notices. `.caption--corner` pins it over a panel's
  top-left border. Variants `--blue`, `--red`, `--ink`, `--paper`.
- `.btn` (Bangers label, 3px border). `.btn--primary` (red) is the ONE important action per view and the only button that
  animates on hover. Others: default (panel), `--blue`, `--yellow`, `--danger` (ink, turns red on hover), `--ghost`, `--sm`, `--lg`, `--icon`, `--block`, `.is-loading`.
  A disabled button is a flat `--paper-2` fill with `--muted` text and a dashed outline, never faded with opacity (a faded red
  or blue is a pastel). A busy `.is-loading` button keeps its colours and shows the spinner.
- `.feature-btn` (home): grid tile with icon box, Bangers label, description and a state tag (`.feature-btn__state`).
  `.feature-grid` is 1 column on phones and 2 from 640px. Never 3.
- Forms: `.field`, `.label`, `.hint`, `.input`, `.textarea`, `.select`, `.input-group` (+ `__prefix`/`__suffix`), `.switch`,
  `.segmented` (checked = ink fill, yellow text; options grow to fill each row, separated by 2px ink rules, so a wrapped
  control reads as a ruled grid), `.chip` (pressed = yellow), `input[type=range].range` (square red thumb on a flat
  ink-outlined track; never the browser's round default).
- `.badge` + `--active` (green), `--expired`/`--destroyed` (red), `--live` (blue), `--vanity` (yellow), `--teaser` (ink), `--neutral`, `--synthetic` (dashed).
- `.live-dot` (+ `--warn`, `--off`): blinking status dot.
- `.skeleton` (+ `--text`, `--title`, `--block`): halftone placeholder blocks.
- `.empty` + `.empty__art` (an icon in a yellow square, never an emoji).
- `.burst` + `.burst__inner` (+ `--red`, `--blue`, `.is-popping`): jagged starburst for sound-effect lettering. Size via `--burst-size`.
- `.toast` (from `toast()`): caption-box toasts with a sprite icon. `dialog.modal`.
- `.grid-2`: the only multi-column grid for card-like collections (1 then 2 columns).

## 8. Layout

- No bento grids. Content sections stack in one column at full container width. Inside a panel, use at most two
  equal columns (`.grid-2`) or a list.
- Card-like collections (feature buttons, idea cards, option tiles, link rows, stat cells) are 1 or 2 per row, or a list.
  Never 3 per row at any viewport width. Avoid `repeat(auto-fit, minmax(...))` for card-like content because it lands on
  three columns at some widths; use explicit 1/2 column breakpoints. Small swatch pickers (colour/theme/preset chips
  under ~90px with no description text) may wrap freely.
- Stats: one KPI strip panel with cells separated by 2px ink rules: 4 cells across on desktop, 2 across on phones.
  Not separate floating tiles.
- Charts: no donut or pie charts for categories; use horizontal bars (flat fill, ink outline, square ends).
  A chart shows at most five hues; non-semantic series use one colour (`--blue`) or ink.
- No terminal mock-ups, testimonials, pricing tiers, logo walls, fake metrics, fake sample links or decorative illustrations.
- Works from 360px wide with 16px gutters and no horizontal scroll.

## 9. Motion

Allowed animation:
- Background halftone drift and the hero `.rays` spin (slow, decorative, stops under reduced motion).
- Skeleton drift, button spinner, live status dot blink.
- One-shot "sound effect" bursts: BLIP! when a link is created, KA-BOOM! on the self-destructed page, WHOOPS! on the 404.
- The teaser countdown, new live-feed rows sliding in, map "hit" markers on live clicks, toasts and dialogs appearing,
  option panels opening/closing.
- Hover motion on `.btn--primary` only.

Not allowed: hover lifts, tilts, scale or slide on anything that isn't the primary action; 3D tilt on the QR preview;
cursor-following spotlights; animated or nudging arrows; rotating/cycling headline words; twinkling stars; confetti;
count-up number animations on KPIs (just show the number). Every `transition` declaration needs an `audit-ok` reason.
Everything stops under `prefers-reduced-motion: reduce`.

## 10. Loading, empty and error states

Every view that fetches data renders a skeleton matching the final layout while loading, an error state with a short
explanation and a Retry button on failure, and an empty state with one sentence of guidance. Lists (My links, live feed,
domain ideas, slug suggestions, breakdown bars) get row skeletons; charts and the map get block skeletons; the QR studio
gets a square skeleton for the preview and line skeletons for the controls until the link loads.

## 11. Copy

- No emojis or decorative symbol glyphs anywhere. Use sprite icons or words.
- No em dashes. Use a comma, colon, period or parentheses. Ranges: "3 to 15" or "3-15".
- No "it's not X, it's Y" / "not just X but Y" constructions. State what the thing does.
- Sentence case in source for labels, buttons and headings (Bangers renders it comic style). Short, specific, friendly.
  Comic narration flavour is welcome in captions ("Meanwhile, in your links...", "Moments later...") but keep it brief.
- Vanity domains and simulated traffic stay clearly explained and labelled.

## 12. Renamed theme and preset ids (server + client)

Teaser themes: `hero` (red, white text), `caption` (yellow, ink text), `noir` (ink, white text), `sky` (blue, white text),
`paper` (newsprint, ink text). Legacy ids map: aurora to hero, sunset to caption, ocean to sky, neon to noir, candy to paper.
Theme colours: `--theme-<id>-bg` / `--theme-<id>-fg` in theme.css.

QR presets (public/assets/js/qr-shared.js): `ink`, `hero`, `caption`, `sky`, `pop`, `press`, `noir`, all flat colours, and every
colour in a preset keeps at least 4.5:1 against its background so no stock look trips the studio's scannability warning.
`COMIC_PALETTE` there mirrors the theme.css tokens. Preset centre logos are flat plates with ink outlines; the `star` logo id
is kept for stored styles but draws the comic burst (label "Burst"), never a star glyph.
`LEGACY_PRESETS` maps aurora to hero, sunset to pop, ocean to sky, neon to noir, mono to ink, candy to caption, forest to press.
The QR studio may keep a "two-tone dots" option (the qrStyle gradient fields) because it styles the user's own code,
but it is off in every preset and off by default.

## 13. Checks before you finish

```bash
node scripts/audit-design.mjs        # must print "0 finding(s)." (also checks token contrast, COMIC_PALETTE and QR presets)
npm test                             # all green
node --check <every js file you touched>
```
