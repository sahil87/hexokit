# Plan: Latch Well — Recessed On-State for Latched Controls

**Change**: 260916-e3sg-latch-well
**Intake**: `intake.md`

## Requirements

### Themes: derived well tokens

#### R1: Three palette-derived UI colors
`deriveUIColors` in `app/frontend/src/themes.ts` MUST return three additional `UIColors` keys, each derived from the palette (never a hand-picked hex), and `COLOR_CSS_MAP` MUST map them to `--color-bg-well`, `--color-accent-green-ink`, `--color-border-pressed`:

- `bgWell` — the chrome ground stepped **toward mid-gray** in OKLab lightness: `WELL_L_DELTA_LIGHT = 0.06` down on light (`L = chromeL − 0.06`, clamped at 0), `WELL_L_DELTA_DARK = 0.09` UP on dark (clearing the `bgChromeRaised` hover fill by ≥ 0.05 L), keeping the chrome's chroma and hue (`chromeChroma`, `bgLch.hueDeg`), gamut-clamped via `oklchToHexInGamut`.
- `accentGreenInk` — `adjustBorderForContrast(palette.ansi[2], bgWell, isDark, BORDER_MIN_CONTRAST)`: the palette green moved in OKLab L (darker on light, lighter on dark) until it clears 3 : 1 against `bgWell`; unchanged where it already clears.
- `borderPressed` — the `border` token stepped **down** in OKLab lightness by `PRESSED_BORDER_L_DELTA = 0.12` (a/b preserved, L clamped at 0): darker than `border` on both categories.

- **GIVEN** the default light palette
- **WHEN** `deriveUIColors(palette, "light")` runs
- **THEN** `bgWell` has lower OKLab L than `bgChrome`, `contrastRatio(accentGreenInk, bgWell) ≥ 3.0`, and `borderPressed` has lower OKLab L than `border`
- **AND** for the default dark palette `bgWell` has higher OKLab L than `bgChrome` and `accentGreenInk === palette.ansi[2]` (already ≥ 3 : 1)

- **GIVEN** every one of the 70 bundled themes
- **WHEN** the three keys are derived
- **THEN** each is a valid 6-digit hex, `bgWell` L < `bgChrome` L on light and > `bgChrome` L on dark, `accentGreenInk` clears 3 : 1 on `bgWell`, and `borderPressed` L < `border` L

### CSS: tokens, static defaults, well shadow

#### R2: Tokens reach the stylesheet and the first paint
`app/frontend/src/globals.css` MUST declare the three `--color-*` vars in the `@theme` block (dark defaults) and in both `html[data-theme="dark"]` / `html[data-theme="light"]` blocks, with static values equal to the `deriveUIColors` output for the two default palettes (extending the existing drift-pin test in `themes.test.ts` to cover them). It MUST add three per-category shadow tokens `--ctl-well-shadow`, `--ctl-well-shadow-hover`, `--ctl-well-lip` (dark values in the theme-independent `:root { --ctl-* }` block as the default and in the dark block; light values in the light block; the light lip is a fully transparent shadow, never `none`), and one utility `.rk-latch-well` beside `.rk-glint` that paints `box-shadow: var(--ctl-well-shadow), var(--ctl-well-lip)` at rest and the `-hover` pair on `:hover`, transitioning `box-shadow` alongside the colour properties over `--ctl-duration`.

Values (from the study):

```css
/* dark (default) */
--ctl-well-shadow:       inset 0 1.5px 2.5px rgb(0 0 0 / .60);
--ctl-well-shadow-hover: inset 0 2px 3.5px rgb(0 0 0 / .78);
--ctl-well-lip:          inset 0 -1px 0 rgb(255 255 255 / .05);
/* light */
--ctl-well-shadow:       inset 0 1px 2px rgb(0 0 0 / .28), inset 0 0 0 1px rgb(0 0 0 / .04);
--ctl-well-shadow-hover: inset 0 1.5px 3px rgb(0 0 0 / .36), inset 0 0 0 1px rgb(0 0 0 / .05);
--ctl-well-lip:          inset 0 -1px 0 rgb(255 255 255 / 0);
```

- **GIVEN** the app before `applyThemeToDOM` runs
- **WHEN** a latched control paints
- **THEN** `bg-bg-well` / `text-accent-green-ink` / `border-border-pressed` resolve to the default-palette derived values (no undefined-token fallback to transparent/black)

- **GIVEN** a light theme is active
- **WHEN** a latched control is hovered
- **THEN** its box-shadow is the light `-hover` pair and the lip contributes nothing visible

### Control primitive: one well recipe

#### R3: The three green arms become one well
`app/frontend/src/components/control.tsx` MUST replace `LATCHED_ARM`, `LATCHED_ARM_RINGED`, `LATCHED_ARM_FLUSH` with:

```ts
const LATCHED_WELL = "rk-latch-well bg-bg-well text-accent-green-ink";
const LATCHED_WELL_BORDERED = `${LATCHED_WELL} border-border-pressed`;
```

composed through the existing REST-swap (`BASE + (arm | REST)`, never stacked): `icon` (square and `box:"height"`) → bordered; `chip` → bordered, `chip` + `ringed` → plain; `toggle` → bordered, `toggle` + `ringed` → plain, `onBorder` still prepends `border `; `segment` → bordered, `segment` + `flush` → plain; `menu-row` unchanged. `KBD_BASE` MUST drop `border-border` (keeping `border`) and `KBD_REST` MUST become `border-border hover:border-text-secondary`, so the pressed border colour never ties with a base colour. `ringed` / `flush` stay accepted and select the plain well; doc comments describe the well (no ring language, no change IDs). `open` keeps sharing the pressed arm.

- **GIVEN** `controlClass({ variant: "toggle", base: "b", rest: "r", ringed: true, pressed: true })`
- **WHEN** composed
- **THEN** the output is `b rk-latch-well bg-bg-well text-accent-green-ink` and contains no `ring-`, `bg-accent-green/15`, or `hover:text-text-primary`

- **GIVEN** `controlClass({ variant: "chip", pressed: true })`
- **WHEN** composed
- **THEN** the output ends with `rk-latch-well bg-bg-well text-accent-green-ink border-border-pressed` and its base carries `border` but not `border-border`

### Tests and baselines

#### R4: Arm-derived assertions and the gallery baselines follow the recipe
`control.test.tsx`'s oracle constants and the arm-derived assertions in `top-bar.test.tsx` (surface-toggle latched cell), `bottom-bar.test.tsx` (scroll-lock chip; F▴ open-latch), `surface-layout.test.tsx` (un-zoom verb ring), `compose-strip.test.tsx` (the Send button is a `toggle` latched while the draft has text), and `gui-toolbar.test.tsx` (the capture verb's ringed latch) MUST assert the well classes. Assertions on `border-accent-green` that are NOT arm-derived (tile focus borders, board-pane focus, quake textarea/launcher engaged borders, the update chip's always-green `rest` override, `SWITCH_TRACK_ON`, `INPUT_FOCUS`) MUST NOT change. The two control-gallery PNG baselines MUST be regenerated with `just test-e2e "control-gallery"` and the diff reviewed: only pressed / open / ringed-pressed / flush-pressed cells change.

- **GIVEN** `just test-frontend` (full Vitest) and `npx tsc --noEmit`
- **WHEN** run after the change
- **THEN** both pass with zero failures

- **GIVEN** the regenerated fine and coarse gallery PNGs
- **WHEN** compared with the committed baselines
- **THEN** rest, disabled, danger, checked-row cells are pixel-identical and the latched cells show the well

### Docs

#### R5: The study ships with the change
`docs/wiki/toggle-depth-studies.html` MUST be committed as-is and `docs/specs/index.md` § Wiki MUST gain its row in the existing shape (Self-contained; open in a browser), noting the § 5 C → C′ light-theme diagnosis.

- **GIVEN** `docs/specs/index.md`
- **WHEN** the Wiki table is read
- **THEN** a `Toggle Depth Studies` row links `../wiki/toggle-depth-studies.html`

### Non-Goals
- `open` composing a neutral-ink well (follow-up: first divergence of `open` from `pressed`).
- The global `:active` press snap painting the well instead of `bg-bg-card` (follow-up).
- Exclusive-group idiom split (surface toggles vs activity tabs) and retiring `ringed` (follow-ups).
- `SWITCH_TRACK_*`, `MENU_ROW_CHECKED`, `SELECTED_FILL`, the gui meta chip label — non-arm vocabularies, unchanged.
- Call-site divider tinting after a down segment — a call-site edit, contrary to the no-call-site-edits rule.

### Design Decisions

#### Well tokens are derived, not reused from `bgInset` / `accentGreen`
**Decision**: The latch well floor, ink and pressed border are three new `deriveUIColors` outputs — an OKLab step from the chrome ground toward mid-gray (0.09 up on dark, 0.06 down on light), a 3 : 1 contrast-driven green, an OKLab step below the border — rather than reusing `bgInset` and `accentGreen`.
**Why**: `bgInset` is an sRGB percentage step that sits at 0.000 OKLab ΔL from the chrome on light palettes (0.068 on dark), and `accentGreen` is 2.7 : 1 on light against 4.0 : 1 for the neutral off glyph — every channel that carries the well in dark vanishes or inverts in light. The chrome derivation already proved the OKLab-step approach reads the same on every palette.
**Rejected**: Hand-pinned light hexes (drift per palette; the study values are what the formula produces for the default palette anyway); mixing `border` toward `textSecondary` for the pressed border (lighter than `border` on dark, so it cannot go darker on both categories).
*Introduced by*: 260916-e3sg-latch-well

#### The well shadow is one `.rk-latch-well` utility, not a Tailwind arbitrary shadow
**Decision**: The arm carries the literal class `rk-latch-well`; `globals.css` owns the rest/hover `box-shadow` pair over the `--ctl-well-*` tokens.
**Why**: Tailwind's arbitrary `shadow-[var(--a),var(--b)]` is ambiguous between shadow value and shadow colour and composes through `--tw-shadow`; a single unlayered utility mirrors the `rk-glint` precedent, keeps the per-category values in CSS where the other `--ctl-*` tokens live, and gives the hover-deepen one home.
**Rejected**: `shadow-[…]` + `hover:shadow-[…]` arbitrary utilities (fragile value-type inference, two long literals per arm).
*Introduced by*: 260916-e3sg-latch-well

#### KBD chips carry their border colour on the rest arm
**Decision**: `KBD_BASE` keeps the `border` width only; `KBD_REST` owns `border-border`, matching `TOP_BAR_BUTTON_BASE` / `TOP_BAR_BUTTON_REST`.
**Why**: The pressed arm now sets a border colour (`border-border-pressed`); a colour on the base would tie with it and be decided by compiled order.
**Rejected**: Relying on Tailwind's utility ordering to let `border-border-pressed` win.
*Introduced by*: 260916-e3sg-latch-well

### Deprecated Requirements

#### Ring-inset latch border-axis
**Reason**: The latch no longer paints a border axis of its own; the well's inset shadow is the depth cue and `ringed` selects the plain well.
**Migration**: `LATCHED_ARM_RINGED` → `LATCHED_WELL`; the visual-design memory decision "Ring-inset as the borderless latch border-axis" is superseded at hydrate.

#### Unified latch fills /15 rest, /25 hover-deepen
**Reason**: There is no wash in the well; hover deepens the shadow (`--ctl-well-shadow-hover`) instead of the fill.
**Migration**: `bg-accent-green/15 … hover:bg-accent-green/25` → `rk-latch-well bg-bg-well`; the memory decision is superseded at hydrate.

## Tasks

### Phase 1: Setup

- [x] T001 Derive the three well tokens in `app/frontend/src/themes.ts` (`WELL_L_DELTA`, `PRESSED_BORDER_L_DELTA` constants beside the chrome constants; `bgWell`, `accentGreenInk`, `borderPressed` on `UIColors` + `COLOR_CSS_MAP`) and add the derivation tests to `app/frontend/src/themes.test.ts` (per-theme invariants, default-dark ink unchanged, default-light values, the 11→14-key count updates); run `npx vitest run src/themes.test.ts` <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 `app/frontend/src/globals.css`: add the three `--color-*` vars to `@theme` and both theme blocks (values = derived defaults, printed from T001's formula), the `--ctl-well-*` tokens (dark in `:root` + dark block, light in the light block), and the `.rk-latch-well` utility beside `.rk-glint`; extend the `globals.css static fallbacks` drift-pin test in `themes.test.ts` to the three colour vars <!-- R2 -->
- [x] T003 `app/frontend/src/components/control.tsx`: replace the three arms with `LATCHED_WELL` / `LATCHED_WELL_BORDERED`, split `KBD_BASE`/`KBD_REST` border colour, rewrite the header and option doc comments (well language, no ring, no change IDs); update `app/frontend/src/components/control.test.tsx` oracle constants and expectations; run `npx vitest run src/components/control.test.tsx` <!-- R3 -->

### Phase 3: Integration & Edge Cases

- [x] T004 Move the arm-derived assertions in `top-bar.test.tsx`, `bottom-bar.test.tsx`, `surface-layout.test.tsx` to the well classes (leave every non-arm `border-accent-green` assertion untouched); regenerate the two control-gallery baselines with `just test-e2e "control-gallery"` (`--update-snapshots` via `just pw`/the recipe's passthrough as the spec documents) and review the PNG diff — only latched cells change <!-- R4 -->

### Phase 4: Polish

- [x] T005 Add the `Toggle Depth Studies` row to `docs/specs/index.md` § Wiki (the HTML is already in `docs/wiki/`, committed as-is); run the gates: `cd app/frontend && npx tsc --noEmit`, `just test-frontend`, `just build` <!-- R5 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `deriveUIColors` returns `bgWell`, `accentGreenInk`, `borderPressed` for every theme, mapped in `COLOR_CSS_MAP` to `--color-bg-well`, `--color-accent-green-ink`, `--color-border-pressed`
- [x] A-002 R2: `globals.css` declares the three colour vars in `@theme`, dark and light blocks, plus `--ctl-well-shadow`, `--ctl-well-shadow-hover`, `--ctl-well-lip` per category, and the `.rk-latch-well` utility
- [x] A-003 R3: `control.tsx` exports no `LATCHED_ARM*` constants; every pressed/open composition emits `rk-latch-well bg-bg-well text-accent-green-ink`, bordered variants adding `border-border-pressed`
- [x] A-004 R5: `docs/specs/index.md` § Wiki links `../wiki/toggle-depth-studies.html` and the HTML is tracked

### Behavioral Correctness

- [x] A-005 R1: On every bundled theme `bgWell` is below `bgChrome` in OKLab L (or clamped), `accentGreenInk` clears 3 : 1 on `bgWell`, `borderPressed` is below `border` in OKLab L; default-dark `accentGreenInk` equals `ansi[2]`
- [x] A-006 R2: The static `--color-bg-well` / `--color-accent-green-ink` / `--color-border-pressed` literals in `globals.css` equal the derived default-palette values (drift-pin test extended and passing)
- [x] A-007 R3: `ringed` and `flush` select the plain well; `onBorder` prepends `border`; `KBD_BASE` carries `border` without `border-border`, `KBD_REST` carries `border-border`; `menu-row` output is unchanged

### Removal Verification

- [x] A-008 R3: No `ring-accent-green`, `bg-accent-green/15 … hover:bg-accent-green/25` latch wash, or `border-accent-green` remains in `control.tsx`

### Scenario Coverage

- [x] A-009 R4: `control.test.tsx`, `top-bar.test.tsx`, `bottom-bar.test.tsx`, `surface-layout.test.tsx` assert the well classes on latched controls and pass
- [x] A-010 R4: Both control-gallery PNG baselines are regenerated; only pressed / open / ringed-pressed / flush-pressed cells differ from the previous baselines

### Edge Cases & Error Handling

- [x] A-011 R1: Pure-black-background themes derive a valid `bgWell` (clamped, no NaN/invalid hex) and `accentGreenInk` still clears 3 : 1
- [x] A-012 R2: The light `--ctl-well-lip` is a transparent shadow so the two-shadow list stays valid CSS

### Code Quality

- [x] A-013 Pattern consistency: new derivation constants and helpers follow the chrome-derivation shape (named `*_L_DELTA` constants with intent comments; helpers reused, none duplicated)
- [x] A-014 No unnecessary duplication: `adjustBorderForContrast`, `hexToOklch`, `oklchToHexInGamut`, `hexToOklab`, `oklabToHex` are reused; no new colour math
- [x] A-015 Comments state constraints, not history: no change IDs or "previously/was" narration in `control.tsx`, `themes.ts`, `globals.css`
- [x] A-016 Tests cover the added behaviour (`themes.test.ts`, `control.test.tsx`) and the full `just test-frontend` + `tsc` gates pass
- [x] A-017 Tailwind literal-class contract: the new utilities appear literally in `control.tsx` and the `--color-*` tokens exist in `@theme`

## Notes

- Memory (`docs/memory/run-kit/ui/visual-design.md` § Color Tokens, § Latch vocabulary, § Hover Buttons row, § The Control Primitive, § Design Decisions) is the hydrate stage's work, driven by the intake's Affected Memory and the Design Decisions above.
- Check items as you review: `- [x]`

## Deletion Candidates

None — this change replaces the three latch arms in place and makes no existing code redundant (the `ringed` option's retirement is a planned follow-up already recorded in the intake's Out of scope, not a discovered candidate).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `borderPressed` = OKLab L step of 0.12 down from `border`, a/b preserved (resolves intake #9) | Only formula that is darker-than-border on both categories and lands near both study targets (#9ca3af light, #2a3040-class dark) | S:80 R:85 A:85 D:85 |
| 2 | Confident | The well shadow ships as a `.rk-latch-well` utility in `globals.css` rather than Tailwind arbitrary `shadow-[…]` classes | Avoids arbitrary-value type ambiguity and `--tw-shadow` composition; mirrors `rk-glint` (intake #8 named this substitute) | S:70 R:85 A:80 D:75 |
| 3 | Certain | `bgWell` L is clamped at 0 before `oklchToHexInGamut`; no separate floor | Intake #10; the step direction is down on both categories so only the 0 clamp can bind | S:85 R:90 A:90 D:85 |
| 4 | Certain | `KBD_BASE` loses `border-border`, `KBD_REST` gains it | Intake R3 note; the top-bar pair is the existing precedent | S:85 R:90 A:90 D:85 |
| 5 | Confident | Static `@theme` / theme-block literals are pinned to the formula's default-palette output and covered by the extended drift-pin test, so the exact hexes are read from the implementation rather than copied from the study | The study values were the formula's output for the default palettes within hex rounding; the drift-pin test is the existing precedent for `--color-bg-chrome` | S:75 R:90 A:85 D:80 |
| 6 | Certain | Five tasks; the change runs in the light lane (inline apply/hydrate/ship, dispatched review) | Task count ≤ 5 by honest decomposition: one derivation unit, one stylesheet unit, one primitive unit, one test/baseline unit, one docs+gates unit | S:85 R:90 A:90 D:85 |
| 7 | Certain | Dark well floor steps UP 0.09 toward gray (light stays 0.06 down); dark shade gains a 20% 1px inner edge | User review of the shipped dark rail: the toward-black floor read as unpressed; a dark shade on a near-black floor paints nothing, and 0.09 clears the hover fill by ≥ 0.05 L (0.06 would sit 0.025 above it) | S:90 R:85 A:90 D:90 |

7 assumptions (5 certain, 2 confident, 0 tentative).
