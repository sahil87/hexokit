# Intake: Latch Well — Recessed On-State for Latched Controls

**Change**: 260916-e3sg-latch-well
**Created**: 2026-09-16

## Origin

Promptless create-intake dispatch from `/fab-proceed` (synthesized from a design discussion; no questions asked — every would-be question is a `Deferred — promptless dispatch` row in `## Assumptions`).

> **Latch well** — latched toggle controls press *into* the ground instead of lighting up with a green ring.
>
> The user looked at the sidebar section rail (four icon toggles, two on) and asked for the on-state to feel *pressed in* rather than lit with a border. A design study — `docs/wiki/toggle-depth-studies.html`, already present untracked in this worktree — compared seven treatments (B depth-only · C well on existing tokens · C′ well on derived tokens · D keycap · E inverse video · F wash-only · G underbar) across the five latching families (sidebar section rail, top-bar icon square, bottom-bar kbd chips, flush surface-toggle segments, tile-header verb). The user approved option **C′**: a recessed well with a per-palette derived floor, ink, and pressed border.

Decisions carried from the discussion (all user-approved via the study):

1. Keep scheme C — accent-green means *state*, never hover; hover stays hue-free. What changes is the **shape** of the on-state: subtractive (a well the button sits in) instead of additive (ring + wash).
2. The on-state recipe: background = a new **well floor** token; glyph ink = a new **green ink** token; `box-shadow` = an inset top shade (per theme category) plus, on dark / pure-black, a faint 1px lighter bottom lip; **no ring, no wash**. Bordered controls keep their border, but it changes to a new **pressed border** token that darkens toward secondary text. Hover on a latched control: ink holds, the shade deepens one step. Focus keeps the existing green `outline`.
3. The three tokens are **derived per palette in `deriveUIColors`**, not hand-picked, because the existing tokens fail on light (§ Why).
4. The three arms in `control.tsx` are replaced by **one well recipe** through the existing REST-swap structure; all latch sites move because they compose the arm — no call-site edits.
5. Switches, checked menu rows, the open-latch idiom's *sharing* of the pressed arm, the global `:active` press snap, and the exclusive-group idiom split are **out of scope** (the study's recommendation rows 3–5 are follow-ups).
6. The study HTML is committed in this change and indexed in `docs/specs/index.md` § Wiki; memory hydrate updates `docs/memory/run-kit/ui/visual-design.md`.

## Why

**The pain point.** Every latched/on control state today composes one additive green algebra owned by the Control primitive (`app/frontend/src/components/control.tsx`):

```ts
const LATCHED_ARM =
  "bg-accent-green/15 border-accent-green text-accent-green hover:bg-accent-green/25";
const LATCHED_ARM_RINGED =
  "bg-accent-green/15 ring-1 ring-inset ring-accent-green text-accent-green hover:bg-accent-green/25";
const LATCHED_ARM_FLUSH =
  "bg-accent-green/15 text-accent-green hover:bg-accent-green/25";
```

A latched control *lights up*: a green border (or inset ring for borderless controls) plus a 15% green wash. On the sidebar section rail, with several icon toggles on at once, the row reads as a set of lit lamps rather than keys that are down. The user wants "on" to read as **depressed** — the button sitting in a well — while keeping the hue channel (green = state) that scheme C reserves.

**Why not just recolor the existing tokens (option C).** The study's § 5 measured the two tokens a naive well would reuse and both fail on light palettes:

| Token | Dark (default palette) | Light (default palette) | Failure on light |
|-------|------------------------|-------------------------|------------------|
| `bgInset` = sRGB darken 5% (dark) / 6% (light) of `palette.background` | 0.068 OKLab ΔL from the chrome ground | **0.000** OKLab ΔL from the chrome ground | the well floor vanishes |
| `accentGreen` = `palette.ansi[2]` | 7.6 : 1 against the chrome | **2.7 : 1** against the chrome (the neutral *off* glyph is 4.0 : 1) | the on glyph is fainter than the off glyph — hierarchy inverted |

`bgInset` is the same sRGB-percentage asymmetry the sidebar-material study measured for the chrome ground (visible on one theme category, invisible on the other); `accentGreen` was derived as a fill/track color and the ring has been hiding its weak contrast on light. Every channel that carries the well in dark is absent or inverted in light. So C′ derives three new tokens the way the chrome material is derived — an OKLab step plus WCAG floors — and the light values in the study are simply what the formula produces for the default palette.

**If we don't do it.** The rail keeps its lit-lamp reading, and any future "pressed" treatment built on `bgInset`/`accentGreen` ships a light-theme regression (invisible floor, inverted glyph hierarchy) that dark-theme review would never catch.

**Alternatives rejected** (study § 6, recorded for the plan's Design Decisions):

| Option | Verdict | Why |
|--------|---------|-----|
| B — depth only, neutral ink | rejected | drops the state hue; kept only as the future *open-latch* idea (follow-up) |
| C — well on the existing tokens | superseded by C′ | right shape, wrong tokens — fails on light as measured above |
| D — keycap with 1px glyph drop | rejected | glyph jitter at 24px |
| E — inverse video | rejected | too loud; a third vocabulary |
| F — wash only (drop the ring) | rejected | still additive |
| G — underbar | parked | says "current", not "on" — fine only for exclusive lens groups (follow-up row 5) |

## What Changes

### 1. Three derived UI colors in `deriveUIColors` (`app/frontend/src/themes.ts`)

`UIColors` gains three keys, each derived from the palette next to the existing chrome derivation (which already floors the chrome at `CHROME_MIN_L` and keeps `CHROME_CHROMA_KEEP` of the background's chroma). Names are the study's proposals; the plan may refine spelling but MUST keep the three roles distinct.

| Key | Derivation | Default dark (≈) | Default light (≈) |
|-----|------------|------------------|-------------------|
| `bgWell` | the chrome ground (`bgChrome`) minus an OKLab lightness step `WELL_L_DELTA ≈ 0.06` in the **recess direction — darker on both categories** (`L = chromeL − 0.06`), chroma kept the way the chrome derivation keeps it (`chromeChroma`, same hue), gamut-clamped via `oklchToHexInGamut`. Where the step runs out of room (pure-black palettes) it clamps to the ground and the lip (§ 3) carries the rim. | `#0a0c12`-class | `#d6d6d6` |
| `accentGreenInk` | the palette green `palette.ansi[2]` driven in OKLab lightness until it reaches **≥ 3 : 1 WCAG contrast against `bgWell`** (the non-text UI floor, `BORDER_MIN_CONTRAST`); unchanged where it already clears (the default dark palette). Reuse `adjustBorderForContrast(palette.ansi[2], bgWell, isDark, BORDER_MIN_CONTRAST)` — it pushes darker on light, lighter on dark, preserving hue and chroma. | `#22c55e` (unchanged) | `#15803d` (4.2 : 1 on the chrome, 3.5 : 1 on the well) |
| `borderPressed` | the `border` token moved toward `textSecondary` so that pressed goes **darker than `border` in every channel on both categories** (a lighter border reads as *disabled*). See Assumptions #9 for the open mechanism question — the target values are fixed, the formula is the plan's call. | `#2a3040`-class (darker than `#454d66`) | `#9ca3af` (darker than `#d1d5db`) |

Existing helpers to reuse, not duplicate: `hexToOklch` / `oklchToHexInGamut` / `hexToOklab` / `oklabToHex` / `contrastRatio` / `adjustBorderForContrast` / `blendHex` in `themes.ts`. Add derivation tests in `app/frontend/src/themes.test.ts` beside the `deriveUIColors` describe block, over every bundled theme:

- `bgWell` OKLab L is **strictly below** `bgChrome` L on every palette, except where it is gamut-clamped (then it equals the clamp and the test asserts the clamp);
- `contrastRatio(accentGreenInk, bgWell) ≥ 3.0` on every palette;
- `accentGreenInk === palette.ansi[2]` for the default dark palette (unchanged where it already clears);
- `borderPressed` is darker than `border` (lower OKLab L) on every palette;
- the default light palette produces the study values within a small tolerance (`#d6d6d6`, `#15803d`, `#9ca3af`).

### 2. Tokens flow into CSS

- `COLOR_CSS_MAP` (`themes.ts`) gains `bgWell: "--color-bg-well"`, `accentGreenInk: "--color-accent-green-ink"`, `borderPressed: "--color-border-pressed"`. The theme context (`app/frontend/src/contexts/theme-context.tsx`) already iterates `COLOR_CSS_MAP` and sets every key on `:root`, so the three vars are injected per active theme with no further wiring.
- `app/frontend/src/globals.css`: the `@theme` block and both `html[data-theme="dark"]` / `html[data-theme="light"]` blocks gain static defaults for the three `--color-*` vars (dark: the `#0a0c12`-class floor, `#22c55e`, `#2a3040`-class; light: `#d6d6d6`, `#15803d`, `#9ca3af` — the plan pins the exact hexes to what `deriveUIColors` produces for the two default palettes, mirroring how `--color-bg-chrome` was pinned). Declaring them in `@theme` is what makes `bg-bg-well`, `text-accent-green-ink`, and `border-border-pressed` exist as Tailwind utilities.
- The `--ctl-*` custom-property family gains three shadow tokens, **per theme category** (today's `:root { --ctl-* }` block is theme-independent geometry, so these live in the two `html[data-theme=…]` blocks — with the dark values also as the `@theme`/default so an un-stamped root paints correctly):

```css
/* dark */
--ctl-well-shadow:       inset 0 1.5px 2.5px rgb(0 0 0 / .60);
--ctl-well-shadow-hover: inset 0 2px 3.5px rgb(0 0 0 / .78);
--ctl-well-lip:          inset 0 -1px 0 rgb(255 255 255 / .05);

/* light */
--ctl-well-shadow:       inset 0 1px 2px rgb(0 0 0 / .28), inset 0 0 0 1px rgb(0 0 0 / .04);
--ctl-well-shadow-hover: inset 0 1.5px 3px rgb(0 0 0 / .36), inset 0 0 0 1px rgb(0 0 0 / .05);
--ctl-well-lip:          inset 0 -1px 0 rgb(255 255 255 / 0);   /* "no lip" — MUST be a transparent shadow, not `none` (see Assumptions #6) */
```

  The pure-black study variant (shadow `.90`/`.95`, lip `.12`) is a study preset, not a theme category the app has; the app ships exactly the dark and light values.

### 3. One well recipe in `control.tsx`

Replace `LATCHED_ARM`, `LATCHED_ARM_RINGED`, and `LATCHED_ARM_FLUSH` with one well arm plus a bordered composition, keeping the structural REST-swap (`BASE + (arm | REST)`, never stacked):

```ts
/** The one latched/on arm (scheme C: green = state, expressed as a recessed
 *  well): derived floor + glyph-safe green ink + the per-theme inset shade,
 *  deepening one step on hover. No ring, no wash. */
const LATCHED_WELL =
  "bg-bg-well text-accent-green-ink shadow-[var(--ctl-well-shadow),var(--ctl-well-lip)] hover:shadow-[var(--ctl-well-shadow-hover),var(--ctl-well-lip)]";
/** Bordered controls keep their border; pressed darkens it. */
const LATCHED_WELL_BORDERED = `${LATCHED_WELL} border-border-pressed`;
```

Composition per variant (behavior contract; exact constant names are the plan's):

| Variant | Today | After |
|---------|-------|-------|
| `icon` (square and `box: "height"`) | `LATCHED_ARM` | bordered well (`TOP_BAR_BUTTON_BASE` carries `border`) |
| `chip` (kbd) | `LATCHED_ARM` | bordered well (`KBD_BASE` carries `border border-border` — the arm's `border-border-pressed` must win; REST-swap keeps `KBD_BASE`'s `border-border`, so the plan verifies the pressed color wins on compiled order or moves `border-border` into `KBD_REST`) |
| `chip` with `ringed` | `LATCHED_ARM_RINGED` | plain well (no border axis) |
| `toggle` | `LATCHED_ARM` (or `_RINGED` with `ringed`) | bordered well; `ringed` ⇒ plain well; `onBorder` still prepends the `border` width utility (on-state = `border` + bordered well) |
| `segment` | `LATCHED_ARM` (or `_FLUSH` with `flush`) | bordered well; `flush` ⇒ plain well (the wrapper owns the outline) |
| `menu-row` | `MENU_ROW_CHECKED` | **unchanged** |

`ringed: true` no longer has a ring to paint. The option stays **accepted** (no call-site churn — ~20 sites compose it) and emits the plain well, identical to `flush`; its doc comment changes from "ring-inset state arm" to "borderless latch — the arm paints no border axis". Retiring the option is a follow-up. The `open` prop keeps sharing the pressed arm (`pressed || open`) in this change.

Header comment updates in `control.tsx`: the `chip`/`toggle` bullets no longer describe a ring; the "one latched/on state arm" comment describes the well and names the three tokens; comments state constraints only (no change IDs, no history).

### 4. Tests and baselines

- `app/frontend/src/components/control.test.tsx`: the `LATCHED_*` expectation constants (lines 19–23 today) become the well recipe; the variant × state expectations follow. Keep the test that a `rest` override carrying `border-accent-green` is not the latch (`expect(...).not.toContain("border-accent-green")` at line 197 stays meaningful).
- Unit tests asserting the old arm **on latched controls** move to the new classes (`bg-bg-well` / `text-accent-green-ink` / `border-border-pressed`). Candidates, to be confirmed by the plan as arm-derived (some `border-accent-green` assertions are unrelated non-primitive uses — tile focus borders in `surface-layout.test.tsx`, the quake textarea focus border, the quake-launcher engaged border, an always-green `rest` override — and MUST NOT change):
  - `top-bar.test.tsx` ~1977–1981 (surface-toggle segments: `bg-accent-green/15` on the latched cell);
  - `bottom-bar.test.tsx` ~199–213 (scroll-lock chip latch) and ~347–350 (F▴ trigger open-latch);
  - `surface-layout.test.tsx` ~510 (`ring-accent-green` on the un-zoom verb).
  - e2e: `tests/e2e/shortcut-registry.spec.ts` asserts `border-accent-green` on **tiles** (focus border, not a latch) — unchanged.
- `/__controls` gallery: `app/frontend/tests/e2e/control-gallery.spec.ts-snapshots/control-gallery-{fine,coarse}-chromium-linux.png` are regenerated (`just test-e2e "control-gallery"`), both pointer classes, and the PNG diff is reviewed: only the pressed / open / flush-pressed cells change; rest, disabled, danger, and checked-row cells are pixel-identical.
- Gates (`fab/project/code-quality.md`): `just test-frontend` (full Vitest, not touched-files-only), `cd app/frontend && npx tsc --noEmit`, the control-gallery e2e, `just build`.

### 5. Docs

- Commit `docs/wiki/toggle-depth-studies.html` (currently untracked; committed as-is) and add its row to `docs/specs/index.md` § Wiki, in the existing row shape: `| [Toggle Depth Studies](../wiki/toggle-depth-studies.html) | Design study for the latched-toggle on-state (260916 discussion) — today annotated, seven treatments across the five latching families, the press-vs-latch depth ladder, exclusive-group idioms, the per-family handling table, the § 5 theme-derivation diagnosis (why C works in dark and not in light → C′), rejected/parked options, and the five-row recommendation. Self-contained; open in a browser |`.
- Memory hydrate (`docs/memory/run-kit/ui/visual-design.md`):
  - § Color Tokens: three new rows (`--color-bg-well`, `--color-accent-green-ink`, `--color-border-pressed`) with derivation + usage, and the `--color-accent-green` row's usage narrows (latched controls now use the ink token; activity/focus/menu ✓ stay on accent-green); the `--ctl-*` mention gains the three well-shadow tokens.
  - § Global Control-State Rules → Latch vocabulary: "one green algebra, three shapes" becomes the one well recipe (bordered / plain), hover = shade deepens one step, `ringed` = plain well.
  - § Hover-Animation Vocabulary → Buttons row and § The Control Primitive: the `/15 → /25` fill-deepen language and the `LATCHED_ARM/_RINGED/_FLUSH` constant list update.
  - § Design Decisions: "Ring-inset as the borderless latch border-axis" and "Unified latch fills: /15 rest, /25 hover-deepen" are superseded (a new entry records the well and *why the tokens are derived rather than reusing `bgInset`/`accentGreen`* — the § Why table); "Flush latch is a distinct segment arm" is rewritten (flush now selects the plain well, same as `ringed`).

### Out of scope (explicit follow-ups, study § 7 rows 3–5)

- `open` composing the well with **neutral** ink (the first place `open` and `pressed` would diverge).
- The global `:active` press snap painting the well (`bg-bg-well` + shade) instead of `bg-bg-card`.
- Exclusive groups choosing an idiom (surface toggles stay on the well; terminal activity tabs to the underbar).
- Retiring the `ringed` option.
- `SWITCH_TRACK_*`, `MENU_ROW_CHECKED`, `SELECTED_FILL` (settings pickers), and the gui header's latched meta chip label (`bg-accent-green/15 text-accent-green`) — non-arm vocabularies, unchanged.
- Call-site divider tinting after a down segment (the study's `.sg.on + .sg { border-left-color }`) — a call-site edit, contrary to decision 4.

## Affected Memory

- `run-kit/ui/visual-design`: (modify) § Color Tokens (three derived tokens + `--ctl-well-*`), § Latch vocabulary (the well recipe replaces the three green arms), § Hover-Animation Vocabulary Buttons row, § The Control Primitive constant list, § Design Decisions (ring-inset and unified-fills entries superseded; new well entry recording why the tokens are derived).

## Impact

- **Frontend source**: `app/frontend/src/themes.ts` (3 `UIColors` keys, `COLOR_CSS_MAP`, derivation), `app/frontend/src/globals.css` (`@theme` + two theme blocks: 3 color vars, 3 `--ctl-well-*` vars), `app/frontend/src/components/control.tsx` (arm constants + composition + header comments). No call-site edits; ~20 latch sites move through the arm.
- **Tests**: `themes.test.ts` (new derivation assertions), `control.test.tsx`, and the arm-derived assertions in `top-bar.test.tsx` / `bottom-bar.test.tsx` / `surface-layout.test.tsx`; two regenerated control-gallery PNG baselines.
- **Docs**: `docs/wiki/toggle-depth-studies.html` (new, committed), `docs/specs/index.md` (one Wiki row), memory hydrate of `ui/visual-design.md`.
- **Constraints**: constitution § V keyboard-first unaffected (visual only; focus ring unchanged); Tailwind scans literal classes, so the new utilities must appear literally in `control.tsx` and the `--color-*` tokens must exist in `@theme`; comments state constraints, not history; `just test-frontend` full run + `tsc` + control-gallery baselines are the gates. Non-latch `accent-green` uses (focus ring, live-input focus border, activity indicators, `MENU_ROW_CHECK_MARK`, tile focus border) are untouched.

## Open Questions

- `borderPressed` mechanism: the description says "the `border` token mixed toward `textSecondary`" AND "darker than `border` on both categories"; a 50% mix reproduces the light target (`#9ca3af`) but on dark `textSecondary` (`#7a8394`) is *lighter* than `border` (`#454d66`), so a mix toward it cannot produce the dark target (`#2a3040`). Which single derivation should hit both targets (an OKLab L step down from `border`, a category-split rule, or a contrast-driven darken)? Deferred (Assumptions #9).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scheme C holds: accent-green = state, hover hue-free; the change is the on-state's shape (subtractive well), not its hue channel | Discussed — user approved C′ over B (neutral ink) explicitly to keep the state hue | S:95 R:70 A:95 D:95 |
| 2 | Certain | Tokens are derived per palette in `deriveUIColors` (OKLab step + WCAG floors), not hand-picked hexes | Discussed — study § 5 measured `bgInset` ΔL 0.000 and `accentGreen` 2.7:1 on light; matches the chrome-material derivation precedent in memory | S:95 R:75 A:95 D:95 |
| 3 | Certain | The three `control.tsx` arms collapse into one well recipe composed via the existing REST-swap; no call-site edits | Discussed — decision 4; the primitive's structure already guarantees BASE + (arm or REST) | S:95 R:75 A:95 D:95 |
| 4 | Certain | Switches, checked menu rows, `open` sharing the pressed arm, the `:active` snap, and the exclusive-group split stay unchanged (follow-ups) | Discussed — decision 5 and study § 7 rows 3–5 | S:95 R:90 A:95 D:95 |
| 5 | Certain | Key names `bgWell` / `accentGreenInk` / `borderPressed` and CSS names `--color-bg-well` / `--color-accent-green-ink` / `--color-border-pressed` are used as given; the plan may refine spelling but keeps three distinct roles | Description marks the names as proposals; existing `COLOR_CSS_MAP` naming pattern makes the mapping mechanical | S:75 R:90 A:85 D:80 |
| 6 | Certain | The light "no lip" is a fully transparent shadow (`inset 0 -1px 0 rgb(255 255 255 / 0)`), not `none`, and the arm composes `shadow-[var(--ctl-well-shadow),var(--ctl-well-lip)]` | CSS `box-shadow` is either `none` or a `<shadow>` list — a list containing `none` is invalid and the whole declaration drops; three separate tokens are wanted, so the lip must stay list-safe | S:70 R:90 A:90 D:80 |
| 7 | Certain | `--ctl-well-shadow*` live in the two `html[data-theme=…]` blocks (with dark also as the default), not the theme-independent `:root { --ctl-* }` geometry block | The `:root` block is documented as theme-independent geometry; the colors' own per-theme blocks are the existing precedent for category-split values | S:70 R:90 A:85 D:80 |
| 8 | Confident | The well arm is expressed as Tailwind arbitrary utilities (`shadow-[var(--…)]`, `hover:shadow-[…]`) inside `control.tsx` rather than a new `.rk-*` class in `globals.css` | Keeps the primitive's "literal classes in control.tsx" contract and the REST-swap structure; a globals.css utility is an acceptable plan-level substitute if Tailwind rejects the comma list | S:60 R:90 A:75 D:65 |
| 9 | Confident | `borderPressed` derivation: the plan picks one formula that yields **darker-than-`border` on both categories** and reproduces the study targets (light `#9ca3af`, dark `#2a3040`-class); recommendation: an OKLab L step down from `border` (same visible step on every palette, the chrome precedent), with "mix toward `textSecondary`" understood as a light-only description | Deferred — promptless dispatch. The description's mechanism and its invariant conflict on dark (`textSecondary` is lighter than `border` there); the targets are fixed, only the formula is open | S:40 R:80 A:50 D:35 |
| 10 | Confident | `bgWell` is gamut-clamped only (OKLab L ≥ 0 via `oklchToHexInGamut`); it may sit below `palette.background` on dark, and "clamps to the ground on pure black" is the emergent behavior when the step runs out of room, not a separate floor | Description says "gamut-clamped"; the chrome derivation's `CHROME_MIN_L` floor exists for the opposite direction | S:65 R:85 A:75 D:70 |
| 11 | Certain | `accentGreenInk` reuses `adjustBorderForContrast(ansi[2], bgWell, isDark, BORDER_MIN_CONTRAST)` — pushes darker on light, lighter on dark, unchanged where ≥ 3:1 already | Description names the helper family and the 3:1 floor; the helper's direction rule matches "driven down" on light | S:80 R:90 A:90 D:85 |
| 12 | Certain | `ringed: true` stays accepted and emits the plain well (identical to `flush`); its doc comment is rewritten; retirement is a follow-up | Discussed — decision 4 second half | S:90 R:90 A:90 D:90 |
| 13 | Confident | `onBorder` toggles keep prepending the `border` width utility; the on-state becomes `border` + bordered well | The option exists for bases with no rest border (compose-strip history chip); the description says bordered controls keep a (pressed) border | S:60 R:90 A:80 D:75 |
| 14 | Confident | `SELECTED_FILL` (settings pickers) and the gui meta chip's latched-label fill stay on `bg-accent-green/15 text-accent-green` | Memory records them as shape-matched label/picker fills distinct from a latched CONTROL; the description scopes the change to the primitive's three arms | S:55 R:85 A:70 D:70 |
| 15 | Certain | `border-accent-green` test assertions on tile focus borders, the quake textarea focus border, the quake-launcher engaged border, and always-green `rest` overrides are NOT latch arms and stay untouched; only arm-derived assertions move | Those classes come from call-site literals, not `controlClass` arms; the plan confirms each candidate by reading the component | S:70 R:90 A:85 D:80 |
| 16 | Certain | Static `@theme` / theme-block defaults for the three colors are pinned to what `deriveUIColors` produces for the two default palettes | Precedent: `--color-bg-chrome` defaults were pinned the same way; the study's light values are the formula's output | S:75 R:90 A:85 D:85 |
| 17 | Certain | The wiki row in `docs/specs/index.md` § Wiki is a new row following the existing "Self-contained; open in a browser" shape, noting § 5's C→C′ diagnosis | Discussed — decision 6; the table's row shape is uniform | S:85 R:95 A:95 D:90 |
| 18 | Certain | Change type is `feat` (pinned explicit) | New tokens + a new on-state recipe; the dispatch pinned it to prevent a docs/refactor re-inference from the wiki/memory mentions | S:90 R:95 A:95 D:95 |

18 assumptions (13 certain, 5 confident, 0 tentative, 0 unresolved). Deferred (promptless): #9.
