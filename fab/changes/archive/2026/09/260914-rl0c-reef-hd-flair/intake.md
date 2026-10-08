# Intake: Reef — an HD vector sibling to the aquarium flair

**Change**: 260914-rl0c-reef-hd-flair
**Created**: 2026-09-14

## Origin

Interactive, one-shot brief via `/fab-new`, followed by one SRAD clarification on art scope.

> Build an HD/high-quality version of the `aquarium` tab flair as a NEW flair (suggested name: `reef`) -- same underwater scene, smooth vector art instead of pixel art. Leave the existing `aquarium` flair untouched so both ship side by side in the picker.
>
> WHY IT LOOKS PIXELATED: it is already SVG, so this is NOT a resolution problem. The art is deliberately drawn as pixel art -- stacks of 1px-tall `<rect>` scanlines (app/frontend/src/globals.css, the block at ~line 986-1045, commented "the asciiquarium homage"). HD means REDRAWING with bezier bodies, gradient shading and soft caustics -- not upscaling.
>
> PREFERRED APPROACH -- the DOM-child path, not the background-sheet path. FlairOverlay (app/frontend/src/components/flair-overlay.tsx) already renders per-flair child markup for `cube` (nested wrappers + 6 faces) and `warp` (3 starfield planes). Follow that precedent: render real `<span>` fish and animate TRANSFORMS, which buys smooth eased swimming, per-fish parallax depth and filter:blur() on the back layer. Reason: CSS animation inside an SVG data URI used as background-image does not run in Chrome/Safari, which is exactly what forces the current jerky 2-frame step-end tail flap. Transform-driven children inherit the existing uniform drag guard and the prefers-reduced-motion gate for free.
>
> SIZING: the strip is 22px tall but the current fish occupy only ~7px of it (y=7..14). Let the HD fish use more of the band, or the extra fidelity will not read.
>
> CLOSED CATALOGUE -- a new flair must be registered in all of these: themes.ts (FLAIR_STATES) + themes.test.ts; types.ts (two doc comments); globals.css (new CSS block, the catalogue comment ~line 628, the reduced-motion block ~line 1695); validate.go (flairTokens + doc comment) + validate_test.go; tab_flair.go (help text); operator.go (~line 514) + operator_test.go; swatch-popover.tsx + swatch-popover.test.tsx -- a 16th named state fills the 2-row column-flow grid to 8 clean columns (currently 15 leaves a half column), and the walked-sequence assertion shifts parity. Also swatch-popover.tsx line 41 says "14 named" where line 74 says 15 -- stale comment, fix while in there.
>
> PIPELINE: after this intake completes, run /fab-ff -- implement, sub-agent review, hydrate. STOP THERE. Do NOT run ship and do NOT open a PR. The user will review first.
>
> THEN MAKE IT LIVE: this box is a cloud VM and the user is testing from their local browser, so the change must be visible on the daemon they load. The Vite dist is embedded into the Go binary via embed.FS, so a CSS/TSX-only change still needs a full rebuild -- rebuild frontend + Go binary, then restart the serving daemon and confirm it is actually serving the new build. Report the URL to load and the flair name to set.
>
> ENV GOTCHAS on this box: prefix pnpm/frontend test commands with PNPM_CONFIG_STRICT_DEP_BUILDS=false (pnpm 11 fails with ERR_PNPM_IGNORED_BUILDS otherwise), and export PATH=$PATH:~/go/bin before anything that needs `air`.

>
> **SUPERSEDED — read `plan.md` § Design Decisions for the shipped scope.** The fuller-reef answer
> recorded below was built, shown to the user, and rejected on sight ("nope just use the same
> Aquarium as a base and do not create something like a coral"). Reef shipped as a FAITHFUL HD port
> of aquarium's exact cast — 2 fish + 1 seaweed clump + bubbles, no coral, no light shafts, no
> parallax depth layers. The text below is historical record only.

**Clarification asked and answered (art scope)**: the brief simultaneously said "same underwater scene" and "let the HD fish use more of the band", which pull apart. Two options were put to the user — a faithful HD port of aquarium's exact three elements, versus a fuller reef scene. **The user chose the fuller reef scene**: 5–6 fish across 3 parallax depth layers (back layer blurred), a coral/anemone floor silhouette, caustic light shafts, and bubbles, using the full 22px band. That answer is binding on the art direction below and is NOT a Tentative guess.

## Why

**The problem.** `aquarium` is the only underwater flair and it is deliberately drawn as pixel art — stacks of 1px-tall `<rect>` scanlines inside SVG data URIs used as `background-image`. That style was a constraint, not purely a choice: a `background-image` data URI cannot run CSS animation in Chrome or Safari, so per-element motion (a tail flap, an eased swim) is impossible inside the sprite. The only animation channel left is the outer `background-position` pair, which is why the current fish flap on a 2-frame `step-end` cadence at 2.5 flips/second and read as jerky. The fish also occupy only ~7px (y=7..14) of the 22px strip, so more than two-thirds of the available band is empty.

**The consequence of not fixing it.** The flair catalogue is the project's most visible design surface (it is the one decorative channel, mounted on window rows, session rows, server group headers and SERVER tiles), and the underwater entry is its weakest-looking member. Users get one aquatic option and it looks low-fidelity next to transform-driven treatments like `cube` and `warp`, which already animate smoothly. Upscaling the existing art fixes nothing, because the pixelation is intentional geometry, not a resolution shortfall.

**Why this approach over the alternatives.**

- **Rejected — edit `aquarium` in place.** The pixel-art aquarium is a deliberate asciiquarium homage with its own design record in `docs/memory/run-kit/ui/visual-design.md`. Replacing it destroys a shipped aesthetic and gives users no choice. Shipping `reef` alongside it makes the two an A/B in the picker and costs one catalogue slot — which the picker grid actively wants (see below).
- **Rejected — a higher-detail background sheet.** Keeps the data-URI animation ban, so the tail flap stays a `step-end` toggle no matter how smooth the vector art is. It would buy fidelity and lose the motion quality, which is half the complaint.
- **Chosen — the DOM-child transform path.** `FlairOverlay` already renders per-flair child markup for `cube` (nested wrappers + 6 faces) and `warp` (3 starfield planes), and `globals.css` already documents this as "the sanctioned exception" to the row transform ban. Real `<span>` fish animating `transform` buy eased swimming with independent per-element timing, genuine parallax depth, and `filter: blur()` on the far layer. They inherit the uniform drag guard (the overlay is hidden while its row is the drag source) and the `prefers-reduced-motion` gate for free.
- **Bonus — the picker grid.** The flair band is a 2-row `grid-flow-col` strip. At 15 named states row 1 holds 8 cells and row 2 holds 7, leaving a ragged half column. A 16th state squares it to 8 clean columns.

## What Changes

### Change area 1 — the `reef` token enters the closed catalogue

`reef` is inserted **immediately after `aquarium`** in every ordered enumeration, so the HD sibling sits next to the original in the picker and in every help listing. This is a deliberate choice over appending at the end; see Assumptions #2. Insertion (rather than append) is what shifts the picker's column-flow parity and what breaks `operator_test.go`'s substring assertion — both are expected and both are in scope.

The resulting ordered list of 16 named states:

```
rain, scan, nyan, naruto, onepiece, pacman, matrix, aquarium, reef,
roadrunner, invaders, cube, warp, spidey, ironman, noon
```

Registration sites, all of which must land in one change (the catalogue is closed — a token missing from any one of these is a runtime or test failure, not a cosmetic gap):

| File | Edit |
|------|------|
| `app/frontend/src/themes.ts:477` | `FLAIR_STATES` — insert `"reef"` after `"aquarium"` |
| `app/frontend/src/themes.test.ts:480` | exact-array assertion — mirror the new 16-element array |
| `app/frontend/src/types.ts:90-91`, `:167-168` | two doc comments enumerating the union — add `"reef"` in position |
| `app/frontend/src/globals.css:~628` | the `Flair overlays` catalogue comment's inline list — add `reef` |
| `app/frontend/src/globals.css` | NEW `.rk-flair-reef` CSS block (see change area 3) |
| `app/frontend/src/globals.css:~1682` | reduced-motion block: the prose says "all fourteen named states" (already stale at 15 → make it **sixteen**) and the selector list gains the reef child-span selectors |
| `app/backend/internal/validate/validate.go:212` | `flairTokens` — insert `"reef"` after `"aquarium"` |
| `app/backend/internal/validate/validate.go:277-278` | the `ValidateFlairValue` doc comment's slash-separated list |
| `app/backend/internal/validate/validate_test.go:540` | the `valid` slice + its "the 15 named states" comment → 16 |
| `app/backend/cmd/rk/tab_flair.go:20-21` | the `Long` help text's accepted-values list |
| `app/backend/api/operator.go:514` | the operator prompt's `@rk_win_flair` value list |
| `app/backend/api/operator_test.go:1076` | the substring assertion (currently ends at `... spidey ironman`) — must be updated because insertion after `aquarium` breaks the prefix match |
| `app/frontend/src/components/swatch-popover.tsx` | stale comments (see change area 4) |
| `app/frontend/src/components/swatch-popover.test.tsx` | count/order/walk assertions (see change area 4) |

`validate.go`'s error copy is **generated** from `flairTokens` by `validateClosedSet`, so the user-facing `"Flair must be one of: …"` message updates itself — no separate string to edit. `validate_test.go`'s `invalid` slice does not need a new entry, though adding a near-miss like `"Reef"`/`"REEF"` for case-sensitivity parity with the other tokens is consistent with the existing list.

### Change area 2 — `FlairOverlay` renders reef's child markup

`app/frontend/src/components/flair-overlay.tsx` gains a third per-flair branch beside `cube` and `warp`. It renders the depth layers and the fish spans; the CSS owns all geometry, art and motion.

Proposed markup contract (the exact class names and counts are the contract the CSS block depends on — plan and implementation must keep them in sync):

```tsx
{flair === "reef" && (
  <>
    <span className="rk-reef-shafts" />
    <span className="rk-reef-layer rk-reef-far">
      <span className="rk-reef-fish" />
      <span className="rk-reef-fish" />
    </span>
    <span className="rk-reef-layer rk-reef-mid">
      <span className="rk-reef-fish" />
      <span className="rk-reef-fish" />
    </span>
    <span className="rk-reef-layer rk-reef-near">
      <span className="rk-reef-fish" />
      <span className="rk-reef-fish" />
    </span>
    <span className="rk-reef-floor" />
  </>
)}
```

Six fish across three depth layers is the working composition (the user's answer said 5–6 across 3 layers). The component's existing doc comment enumerates the per-flair child markup ("cube's nested wrappers + 6-face cube spans, warp's three starfield planes") and must be extended to name reef's layers.

`app/frontend/src/components/flair-overlay.test.tsx` currently asserts the bare-span shape for `["nyan", "spidey", "ironman"]` and the child shapes for cube/warp. It gains a reef case asserting the layer/fish counts.

### Change area 3 — the `.rk-flair-reef` CSS block

A new block in `app/frontend/src/globals.css`, placed among the other flair blocks (order matters: all flair base rules must PRECEDE the `prefers-reduced-motion` block so its equal-specificity `display: none` overrides win by source order).

**Art direction** (settled by the user's clarification):

- **Vector, not pixel.** Fish bodies are bezier `<path>` shapes with `<linearGradient>`/`<radialGradient>` shading (belly-to-dorsal lightening, a soft specular highlight), rounded fins and tails, and a proper eye. No 1px `<rect>` scanline stacks anywhere in this block — that construction is what defines `aquarium` and must not be copied.
- **Band usage.** Fish occupy roughly 12–18px of the 22px strip depending on depth layer (near largest, far smallest), against aquarium's ~7px. The composition fills the band vertically: shafts/caustics at the top, fish through the middle, coral floor silhouette at the bottom, bubbles rising throughout.
- **Three parallax depth layers.** `rk-reef-far` is small, low-opacity and carries `filter: blur(...)` — the whole point of the DOM-child path; `rk-reef-mid` is intermediate; `rk-reef-near` is largest, sharpest and fastest. Layers traverse at different speeds so depth reads as motion parallax, not just as scale.
- **Smooth swimming.** Traversal is `transform: translateX(...)` on the layer or fish spans with an eased (not `linear`, not `step-end`) timing function, plus a gentle independent bob (`translateY` / slight `rotate`) per fish on an incommensurate duration so no two fish are in phase. Tail motion, if present, is a real CSS animation on a child element — never a 2-frame sprite toggle.
- **Soft caustics and light shafts.** `rk-reef-shafts` carries the angled light shafts; caustics can ride the overlay's `::before` as a soft, low-opacity drifting tile (a gradient/blur treatment, not hard-edged rects). The existing `::before`/`::after` pseudos remain available for ambience — the DOM-child path is for the elements that need per-element transforms, and a hybrid is correct.
- **Coral floor.** `rk-reef-floor` is a bottom-anchored silhouette (coral/anemone forms) with a slow sway, sitting behind the fish layers.
- **Bubbles.** Retained from aquarium's vocabulary — rising, seamless, displaced by an exact tile multiple per loop so the wrap is invisible.

**Constraints inherited from the flair channel** (documented in the `globals.css` catalogue comment and non-negotiable):

- Transforms ride the CHILD SPANS only, never the row pseudos and never the row root. This is the sanctioned `cube`/`warp` exception and the reason reef is safe.
- Original art only — inline SVG data URIs or CSS gradients. No external requests, no copyrighted assets.
- The treatment must be **box-agnostic**: it fills whatever box mounts it — a 22px window-row strip, a 36px coarse-pointer row, an 18px picker preview cell, and a full SERVER tile. Fixed-px geometry is the established way this holds (the existing strips are fixed 22px with static centering); anything sized off the container must use container query units the way `cube` does (`container-type: size` + `100cqw`/`100cqh`).
- WebGL is rejected by prior decision (browsers cap live contexts per page; every flaired row would need one).
- Seamless loops: any repeating tile is displaced by an exact integer multiple of its own period per loop.

**Reduced motion.** The `prefers-reduced-motion` block hides flairs entirely (`animation: none; display: none`) because they are motion-only ambient decoration with no static label cue. Reef's child-span selectors join that list:

```css
  .rk-flair-reef::before,
  .rk-flair-reef::after,
  .rk-flair-reef .rk-reef-shafts,
  .rk-flair-reef .rk-reef-layer,
  .rk-flair-reef .rk-reef-fish,
  .rk-flair-reef .rk-reef-floor,
```

and the block's prose comment ("all fourteen named states") is corrected to **sixteen** — it is already stale at fifteen today.

### Change area 4 — the swatch popover grid and its stale comments

`app/frontend/src/components/swatch-popover.tsx`:

- **Line ~41** (the `onSelectFlair` prop doc) says *"a 2-row column-flow strip of the 14 named FLAIR_STATES"* — stale even before this change (there are 15). → **16**.
- **Line ~74** (the `FLAIR_NAMED` doc) says *"the 15 named states"* → **16**.
- No structural change is needed: `FLAIR_NAMED = FLAIR_STATES.slice(1)` and the even/odd row split are already derived, so the grid fills to 8 clean columns automatically once `FLAIR_STATES` has 16 entries.

`app/frontend/src/components/swatch-popover.test.tsx` — these assertions are order- and count-sensitive and all shift:

- **Line ~30** comment "The 14 named flair states" → 16.
- **Line ~357** test name `"full variant: 30 colors + 15 flairs + 2 header − + panel − + ✕ = 49 options"` → 16 flairs, 50 options; the assertion body follows.
- **Line ~393** test name `"the flair band lists the 14 states in display order, rain/scan leading, ironman last"` — doubly stale (15 states, `noon` is last today) → 16 states, `noon` last.
- **Lines ~605-660** the keyboard-walk assertions. With `reef` inserted at index 8 (0-based within `FLAIR_NAMED`), the even/odd parity flips for every state from `roadrunner` onward. Row 1 (even indices) becomes `rain, nyan, onepiece, matrix, reef, invaders, warp, ironman`; row 2 (odd indices) becomes `scan, naruto, pacman, aquarium, roadrunner, cube, spidey, noon`. The existing expectations — including the `["nyan", "onepiece", "matrix", "roadrunner", "cube", "spidey", "noon", "noon"]` walk at ~line 650 and the `noon → ironman` down-move at ~line 655-659 — must be recomputed against the new arrays, not patched by hand.
- The "flair row 1 walks 8 columns and row 2 walks 7" test name (~line 642) becomes 8 and 8.

`app/frontend/src/components/sidebar/index.test.tsx:2218` asserts an `ironman` cell exists and is unaffected.

### Change area 5 — not in scope for the pipeline, but required afterwards

The pipeline stops at hydrate. **No ship, no PR.** After hydrate, the change must be made visible to the user's browser: the Vite dist is embedded into the Go binary via `embed.FS`, so a CSS/TSX-only change is invisible until both the frontend and the Go binary are rebuilt and the serving daemon is restarted. The follow-up must confirm the restarted daemon is actually serving the new build (not a cached or stale binary) and report the URL to load plus the flair token to set.

## Affected Memory

- `run-kit/ui/visual-design.md`: (modify) § flair vocabulary list (line ~294) gains `reef`; a new `.rk-flair-reef` per-flair description entry beside the `.rk-flair-aquarium` one (line ~308); a Design Decisions entry recording the DOM-child-over-background-sheet choice for HD flair art and the ship-alongside-rather-than-replace choice
- `run-kit/ui/sidebar.md`: (modify) § Row Flair — the enumerated value list (line ~476) gains `reef`
- `run-kit/tmux-sessions.md`: (modify) the server-scoped user-option registry — `@rk_win_flair` (line ~375, "one universal set of fifteen named states" → sixteen) and `@rk_ses_flair` (line ~356) value enumerations
- `run-kit/architecture/backend-packages.md`: (modify) `internal/validate` row — the `FlairValues` closed-set enumeration and the generated error copy (line ~41)
- `run-kit/architecture/overview.md`: (modify) the `@rk_win_flair` bullet's value enumeration (line ~30)
- `run-kit/api-and-sockets.md`: (modify) `/api/sessions/:session/flair` and `/api/windows/{windowId}/options` value enumerations (lines ~38-39)

## Impact

**Frontend** (`app/frontend/src/`): `themes.ts`, `themes.test.ts`, `types.ts`, `globals.css` (the largest single edit — a new flair block plus three touch-ups), `components/flair-overlay.tsx`, `components/flair-overlay.test.tsx`, `components/swatch-popover.tsx`, `components/swatch-popover.test.tsx`.

**Backend** (`app/backend/`): `internal/validate/validate.go`, `internal/validate/validate_test.go`, `cmd/rk/tab_flair.go`, `api/operator.go`, `api/operator_test.go`.

**Not affected**: no API shape change (the endpoints already accept an open-ended token validated against a closed set), no new route, no new tmux option, no dependency change, no database (there isn't one). `app/frontend/src/components/control-gallery.tsx` contains no flair or swatch cells, so the committed control-gallery PNG screenshot baselines are **not** changed surface and do not need regeneration — verified by grep during intake. There are currently **zero** Playwright e2e tests referencing flair, so the existing unit-test-only precedent holds.

**Verification gates** (from `fab/project/code-quality.md`, adjusted for this box's env gotchas):

1. `cd app/backend && go test ./...`
2. `cd app/frontend && npx tsc --noEmit`
3. `PNPM_CONFIG_STRICT_DEP_BUILDS=false just test-frontend`
4. `export PATH=$PATH:~/go/bin` before anything invoking `air` (`just dev`, `just test-e2e`)

**Risks.** (a) The swatch-popover keyboard-walk assertions are the most error-prone edit — they encode a column-flow parity that the insertion point flips; they must be recomputed, not patched. (b) `filter: blur()` on an always-on overlay mounted on every flaired row is a compositor cost; keep the blur radius small and the blurred layer's element count low. (c) The reduced-motion gate must hide reef completely — a half-hidden aquatic scene is worse than none.

## Open Questions

None outstanding. The one genuine ambiguity (art scope: faithful HD port versus fuller reef scene) was asked and answered during intake — see Origin.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The new flair token is `reef`, added as a 16th named state; `aquarium` is left byte-for-byte untouched and both ship side by side | Named explicitly in the brief ("suggested name: `reef`", "Leave the existing `aquarium` flair untouched so both ship side by side in the picker") | S:95 R:85 A:95 D:95 |
| 2 | Confident | `reef` is inserted immediately AFTER `aquarium` in every ordered enumeration, not appended at the end | Two valid placements. Insertion groups the HD sibling with its original in the picker, and the brief's own expectations confirm it: it predicts "the walked-sequence assertion shifts parity" (append leaves row 1 untouched) and lists `operator_test.go` as a site to change (append leaves its `…spidey ironman` substring assertion passing). Both only hold under insertion | S:70 R:85 A:75 D:60 |
| 3 | Certain | Fish and depth layers are real `<span>` DOM children rendered by `FlairOverlay`, animated with `transform`; the background-sheet path is not used for them | Specified in the brief with its rationale (CSS animation does not run inside an SVG data URI used as `background-image`, which is what forces the current `step-end` flap). The `cube`/`warp` precedent exists in the same component and `globals.css` already documents it as the sanctioned exception to the row transform ban | S:95 R:80 A:90 D:95 |
| 4 | Certain | Art scope is the FULLER reef scene — 6 fish across 3 parallax depth layers (far layer blurred), coral floor silhouette, caustic light shafts, bubbles — using the full 22px band rather than aquarium's ~7px | Asked as an explicit SRAD question during intake because the brief pulled both ways ("same underwater scene" vs. "let the HD fish use more of the band"); the user selected the fuller scene. Not a guess | S:95 R:75 A:90 D:95 |
| 5 | Confident | A hybrid construction is correct: DOM children for anything needing per-element transforms (fish, depth layers, floor, shafts), the overlay's `::before`/`::after` pseudos for ambient tiles (caustics, bubbles) | The brief mandates the DOM-child path for the fish specifically and gives the reason; it does not ban the pseudos, and every existing flair uses them for ambience. Using children for a static drifting tile would add cost for nothing | S:60 R:90 A:80 D:70 |
| 6 | Confident | Tests are unit tests only (Vitest + Go) — no new Playwright e2e spec | `code-quality.md` says UI changes SHOULD include e2e "where possible", but there are currently ZERO e2e tests referencing flair (verified by grep); the whole channel is covered by unit tests. Following precedent beats inventing a rig for ambient decoration | S:55 R:90 A:85 D:70 |
| 7 | Certain | The control-gallery PNG screenshot baselines are NOT regenerated | `control-gallery.tsx` contains no flair or swatch-popover cells (grep returned 0 matches), so the gallery drift guard's changed-surface rule does not fire | S:80 R:85 A:95 D:90 |
| 8 | Certain | Three stale comments are corrected in passing: `swatch-popover.tsx` ~L41 ("14 named" → 16), ~L74 ("15 named" → 16), and the `globals.css` reduced-motion prose ("all fourteen named states" → sixteen) | The first two are called out in the brief; the third is the same class of staleness found during intake at `globals.css` ~L1682. All three are one-line comment fixes inside files the change already edits | S:85 R:95 A:95 D:90 |
| 9 | Confident | The composition is 6 fish in 3 layers of 2, with the far layer blurred and each layer traversing at its own speed | The user's answer specified "5–6 fish · 3 depth layers"; 6 splits evenly into 3 layers of 2, which keeps the markup contract symmetric and the CSS selectors simple. The exact count is trivially adjustable at implementation if the density reads wrong at 22px | S:65 R:95 A:75 D:65 |
| 10 | Certain | The pipeline runs `/fab-ff` (implement → sub-agent review → hydrate) and STOPS. No ship stage, no PR. A separate rebuild-and-restart follow-up then makes the change visible to the user's browser | Stated unambiguously in the brief, twice ("STOP THERE. Do NOT run ship and do NOT open a PR") | S:95 R:90 A:95 D:95 |

10 assumptions (6 certain, 4 confident, 0 tentative, 0 unresolved).
