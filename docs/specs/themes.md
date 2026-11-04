# Theme System

## Architecture

Each theme stores a full **22-color ANSI terminal palette** — the canonical color set used by terminal emulators. Three consumers derive from this single palette:

| Consumer | What it uses | How applied |
|----------|-------------|-------------|
| **Web UI** (CSS) | 11 derived colors (bg, chrome, text, border, accent) | `document.documentElement.style` inline CSS custom properties |
| **xterm.js** (terminal canvas) | All 22 colors (fg, bg, cursor, selection, 16 ANSI) | `terminal.options.theme = deriveXtermTheme(palette)` |
| **tmux** (status bar, pane borders) | ANSI colour indices in static tmux.conf | Automatic — xterm.js controls what `colour0`–`colour15` look like |

The key insight: tmux renders its chrome as escape sequences that xterm.js interprets. By using `colour0`–`colour15` indices in `configs/tmux/default.conf` instead of hardcoded hex, tmux chrome auto-themes when the xterm.js palette changes. No runtime `tmux set -g` calls needed.

## Palette Structure

```typescript
type ThemePalette = {
  foreground: string;         // Default text
  background: string;         // Default background
  cursorColor: string;        // Cursor appearance
  cursorText: string;         // Text under cursor
  selectionBackground: string; // Selection highlight
  selectionForeground: string; // Text in selection
  ansi: readonly [            // ANSI 0-15
    string, string, string, string,   // black, red, green, yellow
    string, string, string, string,   // blue, magenta, cyan, white
    string, string, string, string,   // bright variants...
    string, string, string, string,
  ];
};
```

### ANSI Semantic Roles

| Index | Name | Semantic role in HexoKit |
|-------|------|------------------------|
| 0 | black | Deep background, text-on-accent fallback |
| 1 | red | Errors |
| 2 | green | Success, active indicators → CSS `accentGreen` |
| 3 | yellow | Warnings, worktree badge in tmux |
| 4 | blue | Accent, links, active states → CSS `accent` |
| 5 | magenta | Highlights |
| 6 | cyan | Info |
| 7 | white | Primary text (in terminal) |
| 8 | bright black | Secondary/dim text → CSS `textSecondary`, tmux inactive borders |
| 9–14 | bright colors | Bright variants of 1–6 |
| 15 | bright white | Text on colored backgrounds (tmux pane headings) |

### UI Color Derivation

The 11 CSS custom properties are derived, not stored:

| CSS property | Derived from |
|-------------|-------------|
| `--color-bg-primary` | `palette.background` |
| `--color-bg-card` | `lighten(background, 8%)` dark / `darken(background, 3%)` light |
| `--color-bg-inset` | `darken(background, 5%)` dark / `darken(background, 6%)` light |
| `--color-bg-chrome` | `oklch(L ± 0.045, C × 0.6, h)` of `background` — up on dark (floored at L 0.16 so pure-black palettes still lift), down on light; gamut-reduced by chroma |
| `--color-bg-chrome-raised` | one further `0.035` L step in the same direction, same chroma — the row-hover step above the chrome |
| `--color-text-primary` | `palette.foreground` |
| `--color-text-secondary` | `blend(foreground, ansi[8], 0.3)`, then OKLab L nudged (lighter on dark, darker on light) until ≥ 4.5:1 against `--color-bg-chrome` — the surface secondary text mostly sits on, and the binding case in both categories |
| `--color-border` | `blend(foreground, background, 0.25)` |
| `--color-accent` | `palette.ansi[4]` (blue) |
| `--color-accent-green` | `palette.ansi[2]` (green) |

(The eleventh, `--color-accent-bright`, is `lighten(accent, 25%)` dark /
`saturate(darken(accent, 12%), ×1.15)` light.)

## Row Color System — Owned Palette + Axis Split

Sidebar rows and server tiles carry a user-assignable color. Rather than deriving
that color from the active theme's ANSI palette (which made a "orange" label read
tan-gray on one theme and brownish-pink on another, and capped the set at what
ANSI offers), HexoKit owns **10 fixed hue families** and *adapts* them to the
theme so hue identity stays stable while the colors still feel native.

### Owned hue families

Ten families are defined by fixed **OKLCH hue angle**, placed non-uniformly —
tight through the discriminable red→amber region, with the large gap parked in
teal→blue where human hue discrimination is weakest:

| Family | Hue | Role | Legacy value |
|--------|-----|------|--------------|
| red | 25° | anchor: blocked/urgent | `1` |
| orange | 55° | quiet | `1+3` |
| amber | 90° | anchor: attention/WIP | `3` |
| olive | 120° | quiet | `1+2` |
| green | 150° | anchor: done/good | `2` |
| teal | 185° | quiet | `6` |
| blue | 250° | anchor: default/info | `4` |
| purple | 290° | quiet | `1+4` |
| magenta | 330° | quiet | `5` |
| slate | 250° (chroma-floored) | neutral: parked/archived | `3+4` |

### Theme adaptation

Each family is rendered at the theme's **mean OKLab lightness** and **mean
chroma** over `palette.ansi[1..6]` (chroma floored at 0.05 so near-monochrome
themes stay distinguishable): `family = OKLCH(L_theme, C_theme, ownHue)`. Slate
uses a near-neutral chroma `min(C_theme × 0.2, 0.025)`. Out-of-gamut results are
brought into sRGB by **reducing chroma stepwise** (×0.92, ≤20 iterations) —
never by sRGB channel clamping, which would shift hue and defeat the stable-hue
goal. The helpers (`oklchToHex`, `oklchToHexInGamut`, `themeColorStats`,
`HUE_FAMILIES`) live in `app/frontend/src/themes.ts` and reuse the existing
OKLab conversions. The downstream tint pipeline (saturate ×1.5 → blend into
background → WCAG border guardrail at 3.0) operates on the adapted family hex
unchanged.

### Shade axis (light · normal · dark)

Every family renders in **three shades**: `normal` (the mean-L rendering above —
every pre-existing stored color maps here untouched), `dark` (same hue and
chroma at **mean-L − 0.14**, gamut-reduced), and `light` (the exact mirror —
same hue and chroma at **mean-L + 0.14**, gamut-reduced). Non-normal shades are
stored **verbatim** as `{family}-dark` / `{family}-light` (they have no legacy
numeric form — the legacy vocabulary predates the shade axis — so the
`familyToLegacy` write seam passes them through unchanged), and the backend
validators accept them via the enumerated `colorFamilyNames` closed set. Three
rungs turn a family into a small **ramp** (family = project identity, shade =
sub-grouping — e.g. main repo → normal, worktrees → light, archive → dark). The
light rung reads **faded/desaturated** — raising L at fixed chroma sheds chroma
at the sRGB gamut boundary — an accepted trade that fits its recessive role,
not a defect engineered away. Slate ships the light rung like every family
(three near-neutral grays = the archive ramp). No new guard mechanics were
needed: the existing **bidirectional** border guardrail
(`adjustBorderForContrast`, threshold 3.0 — light themes push L *down*) already
covers light-on-light, so a light shade's guarded border clears 3.0 on both
light and dark themes (unit-test proven).

### Legacy values (zero migration)

Stored color values keep their existing vocabulary. `colorValueToHex` resolves
each legacy descriptor to its family 1:1 per the table above (e.g. `"1+3"` →
orange). Normal-shade picks remain the **legacy vocabulary** end-to-end: the
swatch popover maps each normal pick back to its legacy descriptor on write
(`familyToLegacy`, e.g. orange → `"1+3"`); the backend validators accept the
numeric/blend forms plus the family-name vocabulary (names and their
`-dark`/`-light` shade variants, via the enumerated closed set — see the shade
axis above), so non-normal shade picks store verbatim. Family names
(`"orange"`) are frontend-side read aliases. No storage, API, or migration
change for pre-existing colors.

### Axis split

The row's visual axes are split so labeling and selection never share a channel:

- **Hue = label** — the family color (above).
- **Tint depth = selection** — a selected row deepens to the family tint at 40%
  (rest 14%, hover 22%; uncolored rows use a gray sentinel), plus bold +
  brightened text. There is **no** left selection border (removed in the split).
- **Left-edge label zone = one target opening the combined Label picker** — both
  label axes (color + marker) live here; see below.

The board-pin active-board cue (once a 4px accent left border) now rides the
**persistent filled pin glyph**, rendered accent-colored when the row is pinned
to the board currently being viewed.

### Left-edge label zone (single target) + `@rk_win_marker`

Each **window** row (windows only — session rows and server tiles are out of
scope) devotes the **entire 26px to the left of the status dot** (12px group
indent + 14px marker-stripe zone) to a **single click target** that opens the
banded **Label picker** (color · marker · flair). The target never selects the
row (`stopPropagation`) and coexists with drag-reorder; the status dot and window
name keep their exact x-positions (the 26px repurposes the existing indent +
gutter — no content shift). The cursor is `pointer` (menu-opener semantics). The
interactive zone is **fine-pointer-only**: on coarse pointers only the
display-only marker stripe renders, and the row flyout card's `Change color…`
action row is the touch path to the picker.

A hover-revealed **palette icon** (the shipped `PaletteIcon`, ~11px) in the 12px
icon zone makes the target discoverable using the same affordance grammar as the
right cluster: hovering the row fades the icon in (~65%) and glows the whole zone
~12% in the row's guarded family color; hovering the zone itself raises the icon
to full opacity and the glow to ~24%. The icon is family-tinted on colored rows,
inherited monochrome on uncolored rows. The **marker stripe is display-only**,
rendered in the guarded family color (gray for uncolored rows).

The **marker axis** holds 8 states — `""` plus `pipe`, `dotted`, `dashed`,
`solid`, `double`, `thick`, `hatch`, `block` — and grows by the **categorical
rule**: new states are new pattern *classes* (a 1px hairline, 45° diagonals,
heavy block dashes), never a new weight between existing ones, because an ordinal
weight ladder cannot encode categorical phases. Markers are **fully static** —
the motion split: *markers mean something and hold still; flairs mean nothing
and move*. Exactly one texture pairing exists: `hatch` (the in-progress marker)
carries the static hazard-wedge weave; `thick` (completed) is deliberately
quiet, and `double` is a plain twin stripe. Suggested semantics (`hatch` =
in-progress, `thick` = completed, `double` = review, `pipe` = parked, `block` =
archived) are **label conventions only** — no wiring to `@rk_pane_agent_state` or the
status pyramid.

The **banded Label picker** (~190px wide, constant height regardless of any
axis's growth) stacks the three axes as horizontal bands under a live
**composite preview row**: the row's actual resting look — color tint, marker
stripe + texture, live flair overlay, the row's name — with a combo caption
underneath (`teal · hatch · scan`, `∅` for unset axes). Each band carries a
green-bracket `[ axis ]` header whose right-aligned **− clear cell** (a neutral minus in the ✕ treatment — ✕ closes the panel, − clears the axis; ringed
when the axis is unset) clears only that axis. The panel header row (preview + ✕)
carries its own **− clear-all** under the same scope grammar — its row names the
whole label, so it clears every axis the caller offers, and rings when the label
is fully unset. The color band is a 3-shade-row (light/normal/dark — the rows
ARE the lightness axis, light on top) ×
10-family column-flow **horizontal scroll strip** — color only ever scrolls
horizontally; vertical would break the shade pairing. The marker band is a
single unscrolled row of the 8 states (semantic states never hide behind a
scroll); the flair band is a 2-row column-flow strip of the 12 flairs. Selection
never dismisses the picker (combo iteration is the point); ✕ / outside-click /
Escape close it. Color selection writes through the `familyToLegacy` seam
(stored vocabulary stays legacy); marker and flair selections write the exact
state. Keyboard: bands are plain grids, each header − is row 0 of its band, and
arrow moves scroll cells into view, keeping the scroll strip invisible to the
grid model. The `Window: Label` command-palette action opens the picker for the
current window's row via the imperative `label-popover:open` event (Constitution
V keyboard path). The right-side hover cluster is therefore **actions-only**
(pin + kill) on window rows; session rows and server tiles keep their right-side
color affordance.

**Motion lives on the flair axis**: the 12-state flair catalogue includes `rain`
(two-lane data rain) and `scan` (CRT scanlines + crawl + refresh band) — both
always-on, composable with any marker, and fully hidden under
`prefers-reduced-motion` like every flair.

Marker state persists as the `@rk_win_marker` **window user option** (`""` plus the
8 tokens above — additive growth, stored values never rewritten), written
through the unified `POST /api/windows/{id}/options` endpoint (the same
allowlist + validate-all path as `@rk_win_color`), read back through the sessions
enrichment onto the window payload as `marker`, and wired into the SSE-hub wake
seam so the mutation repaints in one poll pass rather than the 12s safety tick.
Marker, color, and flair are fully independent axes — a window may be any
combination.

## File Layout

```
configs/themes.json                          # Theme palette definitions (data only)
app/frontend/src/themes.ts                   # Types, derivation functions, re-exports THEMES
app/frontend/scripts/import-theme.ts         # Import script for adding themes
app/frontend/src/contexts/theme-context.tsx   # React context (state, preview, persistence)
app/frontend/src/components/theme-selector.tsx # Theme picker UI
configs/tmux/default.conf                     # tmux config using ANSI colour indices
```

## Theme Data Source

Theme palettes are sourced from [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (Windows Terminal JSON format). Each theme entry in `configs/themes.json` has a `source` field for provenance:

- `"source": "iterm2:Dracula"` — fetched from iTerm2-Color-Schemes
- `"source": "custom"` — hand-defined (Default Dark, Default Light)

The canonical mapping from Windows Terminal JSON to our format:

| WT JSON key | Our field |
|-------------|-----------|
| `background` | `palette.background` |
| `foreground` | `palette.foreground` |
| `cursorColor` | `palette.cursorColor` |
| *(not provided)* | `palette.cursorText` = background |
| `selectionBackground` | `palette.selectionBackground` |
| *(not provided)* | `palette.selectionForeground` = foreground |
| `black` | `palette.ansi[0]` |
| `red` | `palette.ansi[1]` |
| `purple` | `palette.ansi[5]` (= magenta) |
| ... | ... |

## Adding Themes

### Import Script

```bash
# Search available themes (485+ in the repo)
npx tsx app/frontend/scripts/import-theme.ts --search "night"

# Import a theme (auto-detects dark/light from background luminance)
npx tsx app/frontend/scripts/import-theme.ts "Catppuccin Frappe"

# Import with explicit ID or category
npx tsx app/frontend/scripts/import-theme.ts "Night Owl" --id night-owl --category dark

# List all available themes
npx tsx app/frontend/scripts/import-theme.ts --list
```

The script:
1. Fetches the Windows Terminal JSON from GitHub
2. Auto-detects `dark`/`light` category from background luminance
3. Generates a kebab-case ID from the theme name
4. Fills in `cursorText` (= background) and `selectionForeground` (= foreground) defaults
5. Inserts into `configs/themes.json` in the right position (dark before light)
6. Sets `source` to `"iterm2:{name}"` for provenance

### Manual Themes

For themes not in iTerm2-Color-Schemes, add an entry directly to `configs/themes.json` with `"source": "custom"` and the full 22-color palette.

## tmux Colour Index Mapping

`configs/tmux/default.conf` uses these semantic mappings:

| tmux element | colour index | Semantic |
|-------------|-------------|----------|
| Status bar bg | `colour0` | Black/deep bg |
| Status bar fg | `colour7` | White/primary text |
| Session name | `colour4` | Blue/accent |
| Active window tab bg | `colour4` | Blue/accent |
| Active window tab fg | `colour15` | Bright white (high contrast on accent) |
| Pane border (inactive) | `colour8` | Bright black/dim |
| Pane border (active) | `colour4` | Blue/accent |
| Pane heading active bg | `colour4` | Blue/accent |
| Pane heading active fg | `colour15` | Bright white |
| Path segment bg | `colour8` | Bright black/dim |
| Git branch | `colour4` | Blue/accent |
| Worktree badge bg | `colour3` | Yellow/warning |
| Worktree badge fg | `colour15` | Bright white |
| Inactive pane text | `colour8` | Bright black/dim |

## Persistence

Theme preference is stored in two places:

1. **Backend** (canonical): `~/.config/hexokit/config.yaml` via `GET/PUT /api/settings/theme`
2. **Frontend** (cache): `localStorage` key `"hexokit-theme"` for instant reads before API responds

On init, the frontend calls the API. If it fails, falls back to localStorage, then to `"system"`. The `"system"` value auto-selects Default Dark or Default Light based on OS `prefers-color-scheme`.
