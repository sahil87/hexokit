# Plan: Reef — an HD vector sibling to the aquarium flair

**Change**: 260914-rl0c-reef-hd-flair
**Intake**: `intake.md`

## Requirements

### Flair catalogue: the `reef` token

#### R1: `reef` is a registered member of the closed flair catalogue
The flair token `reef` SHALL be accepted everywhere the closed flair set is enumerated, and SHALL be inserted **immediately after `aquarium`** in every ordered enumeration. The resulting ordered set of 16 named states is:

```
rain, scan, nyan, naruto, onepiece, pacman, matrix, aquarium, reef,
roadrunner, invaders, cube, warp, spidey, ironman, noon
```

- **GIVEN** a caller writes `@rk_win_flair=reef` through `POST /api/windows/{windowId}/options`, `POST /api/sessions/{session}/flair`, or `rk tab flair reef`
- **WHEN** the value reaches `validate.ValidateFlairValue`
- **THEN** it validates (empty error string) and the tmux option is written
- **AND** `FlairValues` contains `reef`, `flairTokens` lists it after `aquarium`, and the generated `"Flair must be one of: …"` error copy names it in that position

#### R2: The frontend flair vocabulary carries `reef`
`FLAIR_STATES` in `app/frontend/src/themes.ts` SHALL contain `"reef"` immediately after `"aquarium"`, and every doc comment in `app/frontend/src/types.ts` that enumerates the union SHALL list it in the same position.

- **GIVEN** the `FLAIR_STATES` const
- **WHEN** `themes.test.ts`'s exact-array assertion runs
- **THEN** the array equals the 16-element ordered list in R1 with a leading `""`
- **AND** `FlairState` resolves `"reef"` as a valid member

#### R3: The backend help and operator surfaces name `reef`
`app/backend/cmd/rk/tab_flair.go`'s `Long` help text and `app/backend/api/operator.go`'s `@rk_win_flair` value listing SHALL both name `reef` in catalogue position.

- **GIVEN** a user runs `rk tab flair --help`
- **WHEN** the accepted-values line renders
- **THEN** `reef` appears between `aquarium` and `roadrunner`
- **AND** `operator_test.go`'s value-list substring assertion is updated to the new full list, because inserting after `aquarium` breaks the previous `… spidey ironman` prefix match

### Flair rendering: the reef treatment

#### R4: `FlairOverlay` renders reef's child markup
`app/frontend/src/components/flair-overlay.tsx` SHALL render a `reef` branch beside the existing
`cube` and `warp` branches, emitting the manta's nested wrappers — `rk-reef-manta` →
`rk-reef-manta-rise` → `rk-reef-manta-depth` → `rk-reef-manta-bank`, holding the two cross-faded
views: `rk-reef-manta-side` (holding `rk-reef-manta-wing-far`, `rk-reef-manta-body` and
`rk-reef-manta-wing-near` in that DOM (paint) order) and `rk-reef-manta-back` — plus one
`rk-reef-weed` holding three `rk-reef-blade` spans. Bubbles ride the overlay's `::before`.

- **GIVEN** `<FlairOverlay flair="reef" />`
- **WHEN** it renders
- **THEN** the overlay span carries class `rk-flair-reef`
- **AND** it contains exactly one manta (with its three side-view art layers inside the rise/depth/bank wrappers, beside the back-view layer) and one weed of three blades
- **AND** no fish elements exist
- **AND** when `hidden` is true the whole overlay returns `null` (the existing uniform drag guard, unchanged)

#### R5: The reef art is smooth vector art, not pixel art
The `.rk-flair-reef` CSS block in `app/frontend/src/globals.css` SHALL draw the manta with bezier `<path>` art and gradient shading (`<linearGradient>` and/or `<radialGradient>`), and SHALL NOT use the stacked 1px-tall `<rect>` scanline construction that defines `.rk-flair-aquarium`.

- **GIVEN** the `.rk-flair-reef` block
- **WHEN** its SVG data URIs are inspected
- **THEN** the manta's layers are `<path>` elements with curve commands, shaded by gradient definitions
- **AND** no part of the art is composed of a stack of `height='1'` `<rect>` elements

#### R6: Motion is transform-driven on child spans with eased timing
Reef's manta and its parts SHALL animate via `transform` on the child spans only — never on the row pseudos and never on the row root. Every **articulation** (wing flap, blade sway) and the rise/bank SHALL use an eased timing function, never `step-end`. The **traversal is a carve-out**: because the crossing spans the whole loop with no off-screen dwell (R17b), it SHALL be `linear` — an eased traversal would decelerate into the wrap and snap back to speed in view, and a constant-speed glide also suits the animal. `step-end` remains forbidden everywhere.

- **GIVEN** a row carrying `flair=reef`
- **WHEN** its keyframes run
- **THEN** every keyframe that moves the manta or one of its parts animates `transform`
- **AND** no articulation uses `linear`; only the traversal and the ambient bubble tile do
- **AND** no `animation-timing-function: step-end` appears anywhere in the reef block
- **AND** the wing stroke runs on a duration incommensurate with the traversal and the path period

#### R7: The scene is a single manta over aquarium's ambience
Reef's cast SHALL be ONE manta ray plus aquarium's ambient elements — the seaweed clump anchored near
the left edge and the rising bubbles. The two fish SHALL be removed: their markup, art, keyframes and
rules deleted, not merely hidden.

- **GIVEN** a row carrying `flair=reef`
- **WHEN** it renders
- **THEN** exactly one creature crosses the band — the manta
- **AND** no fish markup, art, keyframes, rules, selectors or tests remain anywhere in the codebase
- **AND** the seaweed and bubbles are unchanged from their current form

#### R16: Reef is aquarium's scene, matched exactly — only the art and the fin motion are HD
The manta is scrapped. Reef SHALL reproduce `aquarium`'s scene **measurement for measurement**: same
cast, same sprite sizes, same traversal speeds, same off-screen timing, same fin cadence. The ONLY
differences SHALL be fidelity (bezier bodies with gradient shading instead of 1px `<rect>` scanline
stacks) and motion quality (continuous articulated fins instead of a 2-frame `step-end` toggle).

Values to match, read from `.rk-flair-aquarium`:

| Element | Aquarium value reef must match |
|---------|-------------------------------|
| Orange fish | 18px-wide box, art at y=7..14; crosses LEFT→RIGHT **once** per 22s loop, from `-18px` to `calc(100% + 22px)`, linear |
| Blue fish | 16px-wide box, art at y=7..14; crosses RIGHT→LEFT **twice** per loop, from `calc(100% + 20px)` to `-16px`, with the mid-loop teleport at 50% / 50.01% between fully-off-screen positions |
| Seaweed | 10px-wide, anchored at a constant **6px** from the left edge |
| Bubbles | 36×44 tile drifting up exactly one tile per **5s** |
| Fin cadence | orange **2.5 flips/sec**, blue **5 flips/sec**, seaweed **2.5 flips/sec** |
| Strip | 22px tall, centred, `opacity: 0.92` |

- **GIVEN** reef and aquarium side by side
- **WHEN** both run
- **THEN** the two scenes are in step — same sizes, same positions, same speeds, same off-screen gaps
- **AND** reef differs only in being drawn with bezier art and moving its fins continuously
- **AND** no manta, and no element aquarium does not have

#### R20: The flair token is `nemo`, not `reef`
The flair SHALL be named **`nemo`**. `reef` described a scene that no longer exists (there is no coral
or reef structure — two tropical fish over seaweed and bubbles), and the catalogue's dominant
convention is a short character-flavoured token with original art behind it (`nyan`, `naruto`,
`onepiece`, `pacman`, `spidey`, `ironman`). The rename covers the token, every CSS class
(`rk-flair-reef` → `rk-flair-nemo`, `rk-reef-*` → `rk-nemo-*`), every keyframe name, and all prose —
except the English phrase "reef-species", which refers to the animals and stays.

Catalogue position is unchanged (immediately after `aquarium`), so the picker's column-flow parity and
walk assertions are unaffected.

- **GIVEN** the source tree after the rename
- **WHEN** it is grepped for `reef`
- **THEN** the only match is the English phrase "reef-species" in a comment
- **AND** the token, classes, keyframes and help text all read `nemo`
- **AND** the catalogue order and picker walk assertions are unchanged

#### R19: The two fish carry real reef-species colouring
The fish SHALL be coloured as the two species the user named — an **ocellaris clownfish** (the orange
one) and a **regal blue tang** (the blue one) — drawn from the ANIMALS' documented colouring, not from
any studio's character artwork. The flair channel's standing rule is original art with no copyrighted
assets, and a species colour pattern is a fact about the animal.

Clownfish (`Amphiprion ocellaris`): bright orange body; **three vertical white bands edged in fine
black** — one just behind the eye, one mid-body that **widens forward toward the head**, one around the
caudal peduncle; all fins edged in fine black; black iris.

Blue tang (`Paracanthurus hepatus`): **royal blue** body; the black **"palette" marking** curving up
from the eye, running back along the upper body and hooking down toward the tail; **canary yellow**
caudal fin.

- **GIVEN** either fish at rendered size
- **WHEN** it swims past
- **THEN** the clownfish shows three black-edged white bands with the middle one widening forward
- **AND** the blue tang shows a royal blue body, the hooked black palette marking, and a yellow tail
- **AND** both remain legible at the 22px row height — the markings are bold enough to read at 12x7px
- **AND** the art is original: species colouring only, no character likeness

#### R17: Fins and tails articulate continuously at aquarium's cadence
Each fish's tail and pectoral fin SHALL be separate elements animated with `transform`, hinged where
they meet the body, on an eased loop matching that fish's aquarium flip rate. No `step-end`.

- **GIVEN** either fish
- **WHEN** it swims
- **THEN** its tail and fin move continuously at that fish's aquarium cadence
- **AND** each part's tip travels enough to be visible at the rendered size

#### R8: The manta uses the band generously
The manta SHALL occupy a substantial share of the 22px band vertically, so its shape and wing sweep
are legible at row size.

- **GIVEN** the manta at rest mid-band
- **WHEN** it renders
- **THEN** its silhouette spans materially more than aquarium's ~7px fish extent

#### R9: The treatment is box-agnostic
Reef SHALL fill whatever box mounts it — a 22px window row, a 36px coarse-pointer row, an 18px picker preview cell, and a full SERVER tile — using the established fixed-px strip geometry with static centering, or container query units (`container-type: size` + `100cqw`/`100cqh`) where sizing must follow the container.

- **GIVEN** the same `reef` overlay mounted in an 18px picker cell and in a full SERVER tile
- **WHEN** each renders
- **THEN** neither clips the scene to an unreadable sliver nor leaves the box mostly empty
- **AND** no rule depends on a row-height assumption other than the documented fixed-px strip pattern

#### R10: Reef is fully hidden under `prefers-reduced-motion`
The `prefers-reduced-motion` block in `globals.css` SHALL hide every reef element (`animation: none; display: none`), because flairs are motion-only ambient decoration with no static label cue.

- **GIVEN** a viewer with `prefers-reduced-motion: reduce`
- **WHEN** a row carrying `flair=reef` renders
- **THEN** no reef pseudo or child span is displayed — no partial scene, no static residue
- **AND** the reef selectors sit inside the reduced-motion block, whose base rules precede it in source order so the equal-specificity overrides win

#### R11: Original art, no external requests
Reef's art SHALL be original inline SVG data URIs and/or CSS gradients only — no external requests, no copyrighted assets, no WebGL.

- **GIVEN** the reef block
- **WHEN** a row renders
- **THEN** the network panel shows zero requests attributable to the flair
- **AND** no `canvas`/WebGL context is created

### Picker: the 16th cell

#### R12: The flair band squares to 8 clean columns
With 16 named states, the swatch popover's 2-row column-flow flair band SHALL fill to 8 columns with no ragged half column. The derived `FLAIR_NAMED` / `FLAIR_ROW_1` / `FLAIR_ROW_2` logic SHALL remain derived — no hardcoded counts introduced.

- **GIVEN** the full-variant picker
- **WHEN** the flair band renders
- **THEN** row 1 holds `rain, nyan, onepiece, matrix, reef, invaders, warp, ironman` and row 2 holds `scan, naruto, pacman, aquarium, roadrunner, cube, spidey, noon`
- **AND** every one of the 16 cells is a live preview carrying its own `.rk-flair-*` overlay, reef included

#### R13: The keyboard-walk assertions are recomputed, not patched
`swatch-popover.test.tsx`'s column-flow walk expectations SHALL be recomputed from the new 16-element arrays, because inserting `reef` at index 8 of `FLAIR_NAMED` flips even/odd parity for every state from `roadrunner` onward.

- **GIVEN** the arrow-key walk tests
- **WHEN** they run against the 16-state band
- **THEN** the row-1 walk sequence and the row-1 → row-2 down-move expectations match the arrays in R12
- **AND** the "row 1 walks 8 columns and row 2 walks 7" test becomes 8 and 8

#### R14: Stale comments are corrected
Three stale comments SHALL be corrected: `swatch-popover.tsx` ~L41 ("14 named" → 16), `swatch-popover.tsx` ~L74 ("15 named" → 16), and the `globals.css` reduced-motion prose ("all fourteen named states" → "all sixteen named states"). `swatch-popover.test.tsx`'s "14 named flair states" comment and its stale test names ("15 flairs", "the 14 states … ironman last") SHALL be corrected in the same pass.

- **GIVEN** the touched files after the change
- **WHEN** their comments are read
- **THEN** no comment states a flair count other than 16
- **AND** no test name claims `ironman` is last (it is `noon`)

### Non-Goals

- **Inventing scene content aquarium does not have** — no coral, anemones, light shafts, parallax depth layers or blurred back layer. Reef is a fidelity and motion-quality upgrade of the SAME scene; an enriched composition was explicitly rejected by the user after seeing it.
- **Changing `aquarium` in any way** — it stays byte-for-byte identical; the two ship side by side as an A/B in the picker.
- **A Playwright e2e spec for reef** — there are zero e2e tests referencing flair today; the channel is unit-covered and this change follows that precedent.
- **Regenerating the control-gallery PNG baselines** — `control-gallery.tsx` contains no flair or swatch cells, so the drift guard's changed-surface rule does not fire.
- **Any API, route, tmux-option or dependency change** — the endpoints already accept an open-ended token validated against a closed set.
- **Ship / PR** — this run terminates at hydrate by explicit user direction.

### Design Decisions

#### HD flair art uses the DOM-child transform path, not a higher-detail background sheet

**Decision**: Reef renders its moving parts — the manta's two wings and body, and the seaweed blades — as real `<span>` children of the flair overlay, emitted by `FlairOverlay` and animated with CSS `transform`, while the ambient bubble tile stays on the overlay's `::before` — a deliberate hybrid.

**Why**: A CSS animation inside an SVG data URI used as `background-image` does not run in Chrome or Safari. That is precisely what limits `aquarium` to animating the outer `background-position` pair, forcing its 2-frame `step-end` tail flap. Only real DOM children can carry per-element eased motion, independent per-fish phase, genuine parallax, and `filter: blur()` on a far layer. `cube` and `warp` already establish this path in the same component, and `globals.css` documents it as the sanctioned exception to the row transform ban; child-span transforms inherit the uniform drag guard and the reduced-motion gate for free.

**Rejected**: (a) Redrawing `aquarium`'s sheets at higher detail — keeps the data-URI animation ban, so the motion stays a `step-end` toggle no matter how good the art is; it would buy fidelity and lose half the complaint. (b) Animating transforms on the row pseudos or row root — banned, because an animated transform range grows the compositor layer beyond the row box and the HTML5 drag-ghost snapshot then carries a sliver of the neighboring row. (c) WebGL — previously rejected for this channel because browsers cap live contexts per page (~8–16) and every flaired row would need one.

*Introduced by*: 260914-rl0c-reef-hd-flair

#### Reef is a faithful HD port of aquarium's scene, not an enriched one

**Decision**: Reef keeps aquarium's ambience verbatim — the seaweed clump near the left edge and the rising bubbles — and replaces its cast with a single manta ray drawn to a user-supplied reference: an oblique rear-quarter view travelling sideways across the band, wings articulated as separate counter-phased elements.

**Why**: The flair began as a faithful HD port of aquarium's two fish, which isolated the improvement to fidelity and motion quality. The user then chose a single manta as the subject instead, so reef is now a different creature over the same ambience — the HD claim is carried by the manta's bezier art and its articulated, measured-perceptible wing stroke rather than by matching aquarium's cast.

**Rejected**: (a) A fuller reef scene — 6 fish across 3 parallax depth layers with a blurred far layer, a coral floor and caustic light shafts — rejected on sight as inventing content rather than drawing the existing scene better. (b) Keeping the two fish alongside the manta: the 22px band cannot carry three creatures legibly, and the manta only becomes large and slow enough to read once it has the band to itself. (c) Front-on and top-down manta views: a manta's disc is 2.2x wider than long, so in a top-down view the wingspan runs perpendicular to travel and cannot fit a 22px strip — which is why the first attempts read as a swept-wing aircraft. The oblique rear-quarter view puts the long axis along the band.

*Introduced by*: 260914-rl0c-reef-hd-flair

#### An HD variant ships as a new catalogue slot rather than replacing the original

**Decision**: `reef` is added as a 16th named flair inserted immediately after `aquarium`; `aquarium` is left untouched.

**Why**: The pixel-art aquarium is a deliberate asciiquarium homage with its own design record — replacing it would destroy a shipped aesthetic and remove user choice. Adjacency in the ordered catalogue makes the two read as an A/B pair in the picker and in every help listing. The slot is also free in a structural sense: at 15 named states the picker's 2-row column-flow grid left a ragged half column, and a 16th squares it to 8 clean columns.

**Rejected**: Appending `reef` at the end of the catalogue — cheaper (it would leave `operator_test.go`'s substring assertion and the picker's row-1 parity untouched) but it separates the HD sibling from its original in every user-facing listing, which is the whole point of shipping them together.

*Introduced by*: 260914-rl0c-reef-hd-flair

## Tasks

### Phase 1: Catalogue registration

- [x] T001 [P] Insert `"reef"` after `"aquarium"` in `FLAIR_STATES` in `app/frontend/src/themes.ts`, and mirror the 16-element array in the exact-array assertion in `app/frontend/src/themes.test.ts` <!-- R2 -->
- [x] T002 [P] Add `"reef"` in catalogue position to both flair-union doc comments in `app/frontend/src/types.ts` (~L90-91 and ~L167-168) <!-- R2 -->
- [x] T003 [P] Insert `"reef"` after `"aquarium"` in `flairTokens` in `app/backend/internal/validate/validate.go` (~L212) and in the `ValidateFlairValue` doc comment's slash-separated list (~L277-278); update the `valid` slice and its "the 15 named states" comment in `app/backend/internal/validate/validate_test.go` (~L540) to 16, and add `"Reef"`/`"REEF"` to the `invalid` slice for case-sensitivity parity with the other tokens <!-- R1 -->
- [x] T004 [P] Add `reef` in catalogue position to the accepted-values list in the `Long` help text of `app/backend/cmd/rk/tab_flair.go` (~L20-21) <!-- R3 -->
- [x] T005 [P] Add `reef` in catalogue position to the `@rk_win_flair` value list in `app/backend/api/operator.go` (~L514), and update the corresponding substring assertion in `app/backend/api/operator_test.go` (~L1076) — the insertion breaks its previous `… spidey ironman` prefix match <!-- R3 -->
- [x] T006 [P] Add `reef` to the flair catalogue comment's inline vocabulary list in `app/frontend/src/globals.css` (~L628) <!-- R1 -->

### Phase 2: Core Implementation — the reef treatment

- [x] T007 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Add the `reef` branch to `app/frontend/src/components/flair-overlay.tsx`, emitting 1 `rk-reef-fish rk-reef-orange`, 1 `rk-reef-fish rk-reef-blue` and 1 `rk-reef-weed`; bubbles ride the overlay's `::before` (aquarium's own arrangement). Extend the component's doc comment to name reef's children alongside cube's and warp's <!-- R4 -->
- [x] T008 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Draw the reef fish art in `app/frontend/src/globals.css` as original inline SVG data URIs — bezier `<path>` bodies with `<linearGradient>`/`<radialGradient>` shading (belly-to-dorsal lightening, soft specular highlight), rounded fins and tails, a proper eye, in aquarium's orange and blue. No 1px `<rect>` scanline stacks <!-- R5, R11 -->
- [x] T009 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Give the two fish spans their geometry and per-fish timing: orange faces right, blue faces left, each sized to read at 22px, on a shared 22s loop matching aquarium's cadence <!-- R7 -->
- [x] T010 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Add the reef motion keyframes — eased (`ease-in-out`) container-relative `transform: translateX(...)` traversal, orange LEFT→RIGHT once per loop and blue RIGHT→LEFT twice via a mid-loop keyframe pair that resets it while fully off-screen; never `linear`, never `step-end`; transforms ride child spans only <!-- R6, R7 -->
- [x] T011 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Add the reef ambience: the `rk-reef-weed` clump anchored at a constant offset near the left edge with a continuous sway, and the rising-bubble tile on the overlay's `::before` displaced by an exact integer multiple of its own period per loop so the wrap is invisible <!-- R7, R8, R11 -->
- [x] T012 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Size the fish to use more of the 22px band than aquarium's ~7px extent, keeping aquarium's recognisable vertical placement <!-- R8 -->
- [x] T013 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Make the treatment box-agnostic — `container-type: size` on the overlay with `calc(100cqw + Npx)` traversal (a `%` translateX resolves against the fish's own box, never the row); verify it reads in an 18px picker cell, a 22px row, a 36px coarse row and a full SERVER tile <!-- R9 -->
- [x] T021 Split each reef fish into articulated parts in `app/frontend/src/components/flair-overlay.tsx` and `app/frontend/src/globals.css` — a body element plus separate tail and fin elements, each carrying its own SVG art so a transform can act on it; set `transform-origin` at each part's joint so the tail hinges from the body and the fin pivots from its root <!-- R7a -->
- [x] T022 Add continuous eased keyframes for the articulated parts: a tail hinge (rotate, optionally with a slight `scaleX` for the flap's foreshortening) and an independent fin motion, on durations incommensurate with each other, with the two fish out of phase <!-- R7a -->
- [x] T023 Split the seaweed clump into individual blades with base-anchored `transform-origin`, each swaying on its own eased loop with staggered `animation-delay` so the blades move independently rather than the clump rotating rigidly <!-- R7a -->
- [x] T024 Update the `.rk-flair-reef` block header comment and the `prefers-reduced-motion` selector list to cover every new part element, with no dangling selectors <!-- R7a, R10 -->
- [x] T025 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Raise the articulation amplitudes in `app/frontend/src/globals.css` so each part's tip travels at least 4px peak-to-peak at its rendered size — tail hinge, fin pivot, and blade sway — computing the required angle from each part's length about its pivot rather than guessing <!-- R7b -->
- [x] T026 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Raise the articulation cadences so the tail flap approximates aquarium's ~2.5 flips/second, keeping all part durations mutually incommensurate and the two fish out of phase <!-- R7b -->
- [x] T027 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Verify perceptibility by MEASURING rendered movement in a real browser — sample each part's bounding-box position across a full cycle and report peak-to-peak pixel travel, plus a frame diff — never by asserting a transform changed <!-- R7b -->
- [x] T028 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Add the manta's markup to `app/frontend/src/components/flair-overlay.tsx` — a `rk-reef-manta` span with the nested wrappers its compound motion needs (traversal / vertical curve / bank) and separate elements for the wing parts; update the component doc comment <!-- R16 -->
- [x] T029 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Draw the manta in `app/frontend/src/globals.css` as original inline SVG data URIs — bezier `<path>` body with broad triangular pectoral wings, cephalic lobes and a long thin tail, gradient-shaded to match the scene, each independently-moving part in its own element <!-- R16, R5 -->
- [x] T030 <!-- rework: off-screen dwell too long --> <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Compose the curved flight path: container-relative `translateX` traversal on the outer wrapper, a vertical rise-and-fall on an inner wrapper at a period incommensurate with the traversal, and a slight banking rotate — so the path is a smooth non-repeating curve, never a straight line <!-- R16 -->
- [x] T031 <!-- rework: wing beat was fore/aft; needs a vertical component --> <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Animate the wing flap: a slow eased loop with the trailing edge phase-lagged behind the leading edge so the stroke reads as a travelling undulation, markedly slower than the fish tail flick <!-- R16 -->
- [x] T032 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Measure the manta's vertical path excursion and wing-tip travel in a real browser (positional sampling across a full cycle, per R7b) and confirm both clear the 4px floor <!-- R16, R7b -->
- [x] T033 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Add the manta's selectors to the `prefers-reduced-motion` block and a manta case to `app/frontend/src/components/flair-overlay.test.tsx`; update the `.rk-flair-reef` block header comment to describe the manta's construction <!-- R16, R10, R4 -->
- [x] T014 Place the whole `.rk-flair-reef` block among the other flair blocks, strictly BEFORE the `prefers-reduced-motion` block, so that block's equal-specificity overrides win by source order <!-- R10 -->

### Phase 3: Integration & Edge Cases

- [x] T015 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Add reef's selectors (`.rk-flair-reef::before`, `::after`, `.rk-reef-fish`, `.rk-reef-weed`) to the `prefers-reduced-motion` block in `app/frontend/src/globals.css` so reef is hidden entirely, with no dangling selectors for removed elements <!-- R10 -->
- [x] T016 <!-- rework: scene reduced to the manta alone (fish removed) and the manta redrawn to the user-supplied reference — oblique rear-quarter view travelling sideways. --> Add a reef case to `app/frontend/src/components/flair-overlay.test.tsx` asserting the child-markup contract: exactly 2 `.rk-reef-fish` (one orange, one blue) + 1 `.rk-reef-weed`, no depth-layer/shaft/floor elements, and the `hidden` → `null` guard <!-- R4 -->
- [x] T017 Recompute the column-flow expectations in `app/frontend/src/components/swatch-popover.test.tsx` from the new 16-element arrays — the option-count test (~L357: 16 flairs, 50 options), the display-order test (~L393), and every keyboard-walk assertion (~L605-660, including the row-1 walk at ~L650 and the row-1 → row-2 down-move at ~L655-659). Row 1 is `rain, nyan, onepiece, matrix, reef, invaders, warp, ironman`; row 2 is `scan, naruto, pacman, aquarium, roadrunner, cube, spidey, noon` <!-- R13 -->
- [x] T018 Verify `app/frontend/src/components/sidebar/index.test.tsx` (~L2218, the `ironman` cell assertion) still passes unchanged, and that no other test hardcodes a flair count or order <!-- R12 -->

### Phase 4: Polish

- [x] T019 [P] Correct the stale comments: `swatch-popover.tsx` ~L41 ("14 named" → 16) and ~L74 ("15 named" → 16); `globals.css` reduced-motion prose ("all fourteen named states" → "all sixteen named states"); `swatch-popover.test.tsx` ~L30 comment and the stale test names ("15 flairs" → 16; "the 14 states … ironman last" → "the 16 states … noon last") <!-- R14 -->
- [x] T020 Run the verification gates in order: `cd app/backend && go test ./...`; `cd app/frontend && npx tsc --noEmit`; `PNPM_CONFIG_STRICT_DEP_BUILDS=false just test-frontend` <!-- R1, R2, R13 -->

## Execution Order

- Phase 1 tasks T001–T006 are mutually independent `[P]`.
- T007 (markup contract) blocks T008–T014 — the CSS targets the class names T007 emits.
- T008 → T009 → T010 are dependency-ordered (art, then layer geometry, then motion).
- T014 (block placement) must be satisfied before T015 (the reduced-motion entry depends on source order).
- T016 depends on T007; T017 depends on T001.
- T020 runs last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `validate.ValidateFlairValue("reef")` returns an empty error string, `flairTokens` lists `reef` immediately after `aquarium`, and the generated error copy names it in that position
- [x] A-002 R2: `FLAIR_STATES` equals `["", "rain", "scan", "nyan", "naruto", "onepiece", "pacman", "matrix", "aquarium", "reef", "roadrunner", "invaders", "cube", "warp", "spidey", "ironman", "noon"]` and `themes.test.ts` asserts exactly that
- [x] A-003 R3: `rk tab flair --help` and the operator prompt both name `reef` between `aquarium` and `roadrunner`; `operator_test.go`'s substring assertion matches the updated list
- [x] A-004 R4: the manta markup contract is SUPERSEDED by the R16 rewrite (the manta is scrapped; the fish are back). Current contract RE-VERIFIED this review (fresh reviewer, fish round): flair-overlay.tsx:60-78 renders exactly `.rk-reef-fish.rk-reef-orange` then `.rk-reef-fish.rk-reef-blue` — each holding `.rk-reef-tail`, `.rk-reef-fin`, `.rk-reef-body` in paint order — plus one `.rk-reef-weed` of three `.rk-reef-blade` spans; bubbles ride the overlay's `::before`; flair-overlay.test.tsx:37-67 asserts that contract plus ZERO `rk-reef-manta*`/layer/shafts/floor elements, and the `hidden` → `null` guard at :76-81 includes `"reef"`
- [x] A-005 R12: the picker's flair band renders 16 live preview cells filling 8 clean columns, each carrying its own `.rk-flair-*` overlay

### Behavioral Correctness

- [x] A-006 R5: the no-scanline/gradient rule RE-VERIFIED this review (fish round) on the current art: zero `<rect>` anywhere in the reef block (globals.css:1046-1320); every part is a bezier `<path>` with `C` curve commands; both bodies are shaded by a `<linearGradient>` belly-to-dorsal plus a `<radialGradient>` specular, all stops well-formed (:1316, :1319); the thin tail/fin/dorsal slivers are flat fills — a 1-3px part needs no gradient
- [x] A-007 R6: RE-VERIFIED this review via COMPUTED `animation-timing-function` in headless Chromium — `linear` only on the two swim traversals (:1260, :1265) and the 5s bubble tile (:1144), `ease-in-out` on both tails, both fins and all three blades; grep of the reef block finds `step-end` only in prose. The linear-traversal carve-out is now mandatory, not just permitted: aquarium's traversals are linear, so reef's must be to stay in step. R6's manta-stroke incommensurability clause is moot (no manta)
- [x] A-008 R7: **N/A** — superseded by the R16 rewrite: the single-manta cast was itself scrapped at user direction; reef's cast is aquarium's own (orange fish + blue fish + seaweed clump + rising bubbles), verified present in this review's scrubbed renders
- [x] A-009 R8: **N/A** — manta-era (a manta using the band generously); under R16 the fish boxes match aquarium's sheet sizes exactly (18px/16px wide, 22px tall, centred), so band usage matches aquarium by construction
- [x] A-010 R13: the keyboard-walk expectations match the recomputed 16-element row arrays and were regenerated rather than hand-patched — RE-VERIFIED this review: row-1 walk `rain, nyan, onepiece, matrix, reef, invaders, warp, ironman` (clamped at 8), row-2 left-walk from `noon` through `spidey, cube, roadrunner, aquarium, pacman, naruto, scan`, 8-and-8 columns, 50 options

- [x] A-028 R7a: APPLICABLE AGAIN (the fish are back) — RE-VERIFIED this review in headless Chromium (zero-size probe spans pinned at part-local tip/joint px, `getBoundingClientRect()` over full scrubbed cycles): tail and fin are separate elements on calc-derived hinges; orange tail fork tips **3.08px p2p**, blue **3.07px**; hinge drift **≤ 0.01px** on both fish (true hinges); each fin flutters at its fish's cadence on a staggered negative delay (−0.1s orange, −0.05s blue; blue tail −0.13s), so tail and fin never read as one rigid rock
- [x] A-029 R7a: the seaweed blades sway independently with staggered phase and base-anchored pivots — RE-VERIFIED this review (same probe method): blade tips **3.37 / 2.44 / 2.19px p2p**; `transform-origin: bottom center` on each tight blade box (computed `2px 14px` / `1.5px 10px` / `1.5px 9px`); the middle blade is counter-phased (`sway-alt`) with staggered negative delays (0 / −0.13s / −0.27s) — the clump never rotates as one group
- [x] A-030 R7a: reef shows strictly more articulation than aquarium — verified by block comparison this review: aquarium animates a 2-frame `step-end` tail/weed toggle with a static baked-in fin; reef animates continuous eased tails AND pectoral fins on both fish plus three independent eased blades
- [x] A-031 R7a: no part motion uses `step-end`; every articulation is eased — verified this review (computed timing functions + grep; see A-007)

- [x] A-032 R7b: **N/A** — the ≥4px tip-travel floor predates the scene-match rewrite; R16/R17 require AQUARIUM's amplitudes, not a raised floor. Measured this review: tail fork tips 3.08px p2p — deliberately the 3px hop aquarium's second frame gives its tail
- [x] A-033 R7b: **N/A** — same supersession: measured blade tips 3.37 / 2.44 / 2.19px p2p, deliberately ≈ the up-to-3px hop aquarium's sway frame gives its blades
- [x] A-034 R7b: verified on the current basis — tail cadences are aquarium's flip rates exactly: orange 0.4s alternate = 2.5/sec, blue 0.2s alternate = 5/sec (computed durations; measured tip direction-change rates 2.5/sec and 5/sec)
- [x] A-035 R7b: perceptibility evidence is positional or frame-diff based — this review's evidence is WAAPI-scrubbed zero-size probe-span `getBoundingClientRect()` sampling (which already includes transforms), pixel-extent analysis of dsf=2 screenshots at 7 loop phases, and 6× side-by-side renders; no computed-transform assertions used as proof

- [x] A-036 R16/R18(c): **N/A** — manta-era (curved flight path with an 8.4px rise); the manta and its rise/depth/bank wrappers are scrapped. The fish equivalent — traversal position across the loop — is verified under A-039/A-047
- [x] A-037 R16/R18(b): the calc-derived-hinge principle survives the manta and is RE-VERIFIED on the fish this review: the tail/fin `transform-origin`s are `calc(var(--fw) * …) calc(var(--fh) * …)` projections of the viewBox joint coordinates (globals.css:1289, 1294, 1305, 1310 — never literal px); computed values **4.8px 10.5px / 11.2px 10.5px / 8.2px 12.6px / 7.8px 12.6px** are the exact projections of viewBox joints (4.8,10.5)/(11.2,10.5)/(8.2,12.6)/(7.8,12.6); measured hinge drift ≤ 0.01px over full scrubbed cycles — a future box resize cannot desync the hinges
- [x] A-038 R16/R18: **N/A** — manta-era (manta recognisability vs the reference sketch). On the current scene: this review's 6× side-by-side renders show reef's fish reading clearly as HD versions of aquarium's fish — same positions, same box sizes, gradient bodies, eyes, forked tails
- [x] A-039 R16/R17b: the container-relative traversal half is RE-VERIFIED on the fish: `container-type: size` on the overlay (globals.css:1127-1131) with `100cqw` traversals (:1214-1223); measured positions are pixel-identical to aquarium across the full 22s loop at 220px and 500px (max real delta ≤ 0.3px — the one apparent 45.9/171.9px spike was a probe-parser artifact on a bare-`%` computed value at t=9900, not a real divergence). The banking clause is moot (no manta). RE-VERIFIED post-rename this review: WAAPI-scrubbed (`getAnimations({subtree:true})`, paused + fixed currentTime) side-by-side probe at 220px — nemo fish `getBoundingClientRect` left edges vs aquarium's computed `background-position` sheet offsets (percentages resolved against container−image): identical at 9 loop instants across the full 22s (max delta 0.02px rounding); bubble tile computed `background-image` byte-identical (36×44, 5s linear); strip geometry/opacity parity (22px / margin-top −11px / 0.92); weed anchor 6px in both; computed timing functions: `linear` only on the two swims and the bubble tile, `ease-in-out` on both tails, both fins and all three blades

- [x] A-040 R7: the removal requirement now reads against the MANTA (the fish it once demanded removed are the required cast again). RE-VERIFIED this review: repo-wide grep of `app/frontend/src` + `app/backend` for `manta` / `manta-side` / `manta-back` / `wing-far` / `wing-near` / `glide` / `rise` / `depth` / `bank` / `flap-upper` / `flap-lower` finds ZERO source hits outside the one intentional absence-assertion in flair-overlay.test.tsx:60-66 (other matches are git-ignored regenerated build output under `app/backend/build/`); the reef block's keyframes are exactly sway / sway-alt / bubbles / swim-orange / swim-blue / tail / fin; the reduced-motion list carries only current selectors
- [x] A-041 R16: **N/A** — manta-era (silhouette vs the user-supplied reference sketch); the manta and the reference are gone

- [x] A-042 R17a/R18(b): **N/A** — manta-era (wingtip travel ≥4px, vertical-dominant); the fish-part equivalent is A-028 (tail tips 3.08/3.07px p2p = aquarium's 3px hop by design; true hinges)
- [x] A-043 R17b: no pop-in — RE-VERIFIED on the fish this review (own probe + pixel analysis): the orange starts at `translateX(calc(-1 * var(--fw)))` = −18px, its own width off the left edge, and ends with its left edge at `100cqw + 4px`; the blue's 50%/50.01% teleport was measured fully off-screen at BOTH ends (from −16px to 224px at W=220; to 504px at W=500); the pixel probe shows both scenes fish-free at t=0 and identically near-empty at t=21900; the wrap renders as a slide-in with no teleport

- [x] A-044 R18(a): no side/back cross-fade machinery exists in the current construction — RE-VERIFIED this review: zero hits for `manta-side` / `manta-back` / `show-side` / `show-back` / `back-pulse` / `flap-near` / `flap-far` in `app/frontend/src` + `app/backend`; no opacity-animating keyframes anywhere in the reef block; no orphaned keyframes (the block's keyframes are exactly sway / sway-alt / bubbles / swim-orange / swim-blue / tail / fin)
- [x] A-045 R18(c): **N/A** — manta-era (depth scale swing); no depth element exists
- [x] A-046 R18(c)/(d): **N/A** — manta-era (shared 20s rise/depth/bank period, bank-tracks-velocity); the fish traversals are a single linear 22s loop matching aquarium's, verified
- [x] A-047 R17b/R18: the dwell half is RE-VERIFIED on the fish (own probe, 25ms-sampled full 22s loop, both scenes scrubbed to the same instants): the fully-off-screen share per loop is IDENTICAL to aquarium at both widths — orange **1.82% @220px / 0.91% @500px**, blue **1.93% / 1.02%** — and both teleport ends are fully off-screen (A-043). The wing-beat half is N/A (no manta)
- [x] A-048 R18(b): **N/A** — manta-era (in-phase wings); no wings exist

- [x] A-049 R19: VERIFIED this review (colour round) by rendering the actual part SVGs at 20x in headless Chromium: the orange fish (head RIGHT, eye at viewBox x=13.6) shows three white `#fdfdfb` bands with fine `#241108` edging, clipped to the body by `clipPath id='obody'` — one behind the eye (x≈11–12.9), one mid-body whose right edge bulges forward toward the head (pentagon reaching x=10.6 at mid-height), one at the caudal peduncle (x≈4.4–5.9); tail/fin/dorsal edged in `#2a1608`; black iris `#1a0e06`. The blue fish shows the royal-blue gradient (`#4aa3f0→#1f6fd0→#0f3f8c`), the black `#101a28` palette marking curving up from the eye, back along the upper body and hooking down toward the tail (clipped by `id='bbody'`), and a canary-yellow `#ffd23f` tail. Both are the species' documented colouring on the unchanged generic fish geometry — no character-likeness features
- [x] A-050 R19: VERIFIED this review (colour round) with 1x-device-pixel screenshots of a real 22px row and an 18px-high cell plus dsf=2 close-ups: the orange's white bands and the blue's yellow tail + dark palette remain distinguishable at both sizes — markings do not turn to mud

- [x] A-051 R20: VERIFIED this review (re-review after the `"REEF"` → `"NEMO"` fix). `validate_test.go:550`'s `invalid` slice now carries nemo's full case-sensitivity pair `"Nemo", "NEMO"` — parity with every other token restored. A case-INSENSITIVE grep of `app/frontend/src` + `app/backend` (excluding the git-ignored regenerated `build/`) for `reef` matches ONLY the deliberate "reef-species" phrase (globals.css:1053). Every registration site re-verified site by site: `FLAIR_STATES` + themes.test.ts exact array, both types.ts doc comments, `flairTokens` + `ValidateFlairValue` doc comment + validate_test.go valid slice, `tab_flair.go` help, `operator.go` + operator_test.go, globals.css catalogue comment (:628), transform-ban note (:650), the whole `.rk-flair-nemo` block and the reduced-motion list, swatch-popover.test.tsx, flair-overlay.tsx (+ test). Every touched file is a PROVEN pure rename: `git show HEAD:<f> | sed 's/reef/nemo/g;s/Reef/Nemo/g;s/REEF/NEMO/g'` diffs clean against the working tree for all 11 source files, with the single "reef-species" exception — so no over-replacement and no functional edit could hide in the diff
- [x] A-052 R20: VERIFIED this review (rename round) — `nemo` sits immediately after `aquarium` in every ordered enumeration (`FLAIR_STATES`, `flairTokens`, both `types.ts` doc comments, `tab_flair.go` help, `operator.go`, globals.css catalogue comment). The picker walk assertions are UNMODIFIED apart from the token-in-place rename: swatch-popover.test.tsx row-1 walk array changed only `"reef"` → `"nemo"` at the same 4th position (`rain, nyan, onepiece, matrix, nemo, invaders, warp, ironman` clamped at 8); row 2 untouched; 8-and-8 columns and 50 options untouched; sidebar/index.test.tsx's `ironman` cell assertion untouched. All walk tests pass (`just test-frontend`: 226 files / 4804 tests green)

### Scenario Coverage

- [x] A-011 R4: a unit test in `flair-overlay.test.tsx` exercises reef's child-markup contract and the `hidden` → `null` guard — RE-VERIFIED this review (fish round) against the CURRENT contract: flair-overlay.test.tsx:37-67 asserts the overlay's only children are `.rk-reef-fish.rk-reef-orange`, `.rk-reef-fish.rk-reef-blue` (each with tail/fin/body in paint order) and one `.rk-reef-weed` of 3 blades, plus zero `rk-reef-manta*`/layer/shafts/floor elements with an explicit "The manta and the enriched scene were both rejected" comment at :60-61; the hidden→null loop at :76-81 includes `"reef"`
- [x] A-012 R12: `swatch-popover.test.tsx` exercises the 16-cell band, its display order, and both row walks — re-verified this round: the walk sequences match the R12 arrays (row 1 …`reef, invaders, warp, ironman`; row 2 …`roadrunner, cube, spidey, noon`), 8 and 8 columns, 50 options, `noon` last
- [x] A-013 R1: `validate_test.go` exercises `reef` as valid and `"Reef"`/`"REEF"` as invalid

### Edge Cases & Error Handling

- [x] A-014 R10: under `prefers-reduced-motion: reduce` every reef pseudo and child span is hidden (`animation: none; display: none`) — RE-VERIFIED this review (fish round): the gate list (globals.css:1973-1981) covers `::before`, `.rk-reef-fish`, `.rk-reef-orange`, `.rk-reef-blue`, `.rk-reef-tail`, `.rk-reef-fin`, `.rk-reef-body`, `.rk-reef-weed`, `.rk-reef-blade` — every current element, no dangling manta selectors; the reef block (ends :1320) precedes the gate (:1956+) in source order, so the equal-specificity overrides win; the prose reads "all sixteen named states" (:1956). RE-VERIFIED post-rename this review in headless Chromium with `reducedMotion: "reduce"` emulated: every nemo pseudo and child span computes `display: none` (13/13 targets, including the middle blade, whose surviving `animation-name` longhand is inert — a display:none subtree never animates — and is a pre-existing pattern, not rename fallout); zero `rk-reef-*` selectors remain anywhere (case-insensitive grep)
- [x] A-015 R9: reef reads correctly in an 18px picker preview cell, a 22px window row, a 36px coarse-pointer row, and a full SERVER tile — RE-VERIFIED this review: `.rk-flair-reef` is `container-type: size` (globals.css:1127-1131) and both fish traverse in `100cqw` across the whole 22s loop (:1214-1223), so the crossing length follows the container at any mount width — measured correct at 220px and 500px this review; the fixed 22px strip with static centering (`top: 50%` + `margin-top: -11px`, :1247-1252) is the established pattern that holds at 18px/22px/36px and on SERVER tiles; 6× renders show no unreadable sliver and no mostly-empty box
- [x] A-016 R6: the overlay is still hidden entirely while its row is the HTML5 drag source, so the transform-driven children cannot corrupt the drag ghost
- [x] A-017 R11: rendering a reef row issues zero external network requests and creates no WebGL context — re-verified: all art is inline SVG data URIs, no canvas/WebGL

### Removal Verification

- [x] A-018 **N/A**: this change removes no requirements — `aquarium` is explicitly preserved unchanged

### Code Quality

- [x] A-019 Pattern consistency: the reef CSS block follows the surrounding flair blocks' shape — re-verified this review (cycle 6): the block (globals.css:1046-1342) opens with the same prose-comment shape as aquarium/warp (markup contract + construction constraints), keyframes precede rules, all classes/keyframes are `rk-`-prefixed
- [x] A-020 No unnecessary duplication: reef reuses the existing `FlairOverlay` mount, the uniform drag guard, the derived `FLAIR_NAMED` picker logic, and the generated validator error copy — no parallel mechanism, no hardcoded flair counts introduced
- [x] A-021 Comment discipline: **PASSED this review** (fresh reviewer — the reef block header was rewritten from scratch for the fish scene; every sentence re-audited against the code and this review's fresh probe measurements). Verified TRUE sentence by sentence: the cast sentence (orange once L→R per 22s, blue twice R→L, weed 6px from the left, rising bubbles); "no 1px rect scanline stacks" (zero `%3Crect` in the block, grep-verified); the markup-contract sentence vs flair-overlay.tsx:60-78 (orange then blue, tail/fin/body paint order, one weed of three blades, bubbles on ::before); the box claims — 18/16px widths, 22px tall, top:50%/margin-top:−11px, opacity 0.92 (computed: 22px / −11px / 0.92 ✓); the art-band claim "y≈5.6..14.5" vs aquarium's "y=7..14" (measured from the SVG path/rect data: reef 5.6..14.5, aquarium 7..14 ✓ — reef's dorsal fin and pectoral fin reach ~1.4px past aquarium's band, the HD art filling more of the same box); the traversal arithmetic — "calc(100% + 22px) on its 18px sheet and calc(100% + 20px) on its 16px sheet both place the sheet's LEFT edge at 100% + 4px" (W−18+22 = W+4; W−16+20 = W+4 ✓) and "the rules below subtract the sprite width from the copied margins" (:1214-1223 do exactly that, `calc(100cqw + 22px - var(--fw))` / `calc(100cqw + 20px - var(--fw))`); "The result is pixel-identical to aquarium: same speeds, same positions, same off-screen gaps" — MEASURED true this review (max real position delta ≤ 0.3px over the full 22s loop at 220px and 500px; identical speeds; identical off-screen shares); "the 50% / 50.01% keyframe pair teleports it between two fully-off-screen positions" — measured true at both ends; "Both traversals are LINEAR because aquarium's are" ✓ (aquarium-x is linear); the cadence sentence — "rk-flair-aquarium-y runs a 0.8s period on which the orange tail changes frame twice (2.5/sec) and the blue tail four times (5/sec)" — verified against the y-step keyframes with step-end semantics (orange 0→0→−22→−22→−22 = 2 changes including the wrap; blue 0→−22→0→−22→−22 = 4) and the reef durations (0.4s / 0.2s alternate ✓); "aquarium's fin is static — baked into its sheet" (identical dorsal rect in both sheet frames ✓); "The tail's ±22° swing about its body joint moves the fork tips ~3px peak-to-peak" — measured 3.08px, and aquarium's second frame does hop its tail 3px (y=8..10 → 11..13 ✓); "Both transform-origins are DERIVED from --fw/--fh" (calc() forms at :1289/:1294/:1305/:1310; computed projections exact ✓); the weed claims — 6px anchor ✓, band-floor arithmetic 50% + 11px − 15px = margin-top −4px ✓, "0.4s alternate, the 2.5 frame-changes/sec of the 2-frame sheet" ✓, "±7° puts the tall blade's tip at ~3.4px peak-to-peak" — measured 3.367px ✓, "the up-to-3px hop aquarium's sway frame gives its blades" (frame delta up to 3px ✓); the bubble sentence — identical 36×44 tile URI (byte-identical computed background-image), 5s linear, one tile per loop ✓; "The ONLY linear loops in the block are the two fish traversals and this bubble tile" (computed timing functions ✓); "no step-end appears anywhere in it" (grep: prose only ✓). NO manta-era claim (banking, cross-fade, rear view, clipping, dwell, glide, rise, depth, wing, flap) survives anywhere in the block or the component — grep finds none. One should-fix recorded in the findings: the weed's PAINTED footprint sits ~2px right of aquarium's and ~5px shorter (the comment's "keeps its place" claim covers the shell's 6px anchor and floor anchor, both true — the mismatch is code-vs-aquarium under R16, not comment-vs-code)
- [x] A-022 Magic numbers: traversal margins, teleport pair, cadences and band offsets are either self-evident CSS literals in context or carry a comment explaining the constraint they encode — RE-VERIFIED this review (fish round): the sprite-width subtraction in the swim keyframes, the 50%/50.01% teleport pair, the weed's 6px anchor ("aquarium's constant 6px") and band-floor arithmetic ("50% + 11px − 15px height"), the per-part viewBox joint projections, and the ±22°/±18°/±7° amplitudes all carry explaining comments; the remaining literals (22s, 0.4s/0.2s) are the aquarium-derived durations the comments derive
- [x] A-023 Test coverage: the added behavior (catalogue membership, markup contract, picker band, reduced-motion hiding) is covered by unit tests in both the Go and Vitest suites — verified this round for catalogue membership (validate_test.go, themes.test.ts), the CURRENT markup contract (flair-overlay.test.tsx:37-67) and picker band (swatch-popover.test.tsx, sidebar/index.test.tsx); the reduced-motion hiding leg follows the channel-wide precedent — the gate is a CSS selector list and NO flair has a unit test for it (jsdom cannot evaluate the media query), so there is no rig to extend
- [x] A-024 `aquarium` is byte-for-byte unchanged — `git diff` shows no edit inside the `.rk-flair-aquarium` rules or its keyframes

### Verification Gates

- [x] A-025 `cd app/backend && go test ./...` passes — run by THIS review (fish round): exit 0, all packages ok including the touched `internal/validate`, `api`, `cmd/rk`. RE-RUN post-rename by this review: exit 0, 37 packages ok, no failures
- [x] A-026 `cd app/frontend && npx tsc --noEmit` passes — run by THIS review (fish round): exit 0. RE-RUN post-rename by this review: exit 0
- [x] A-027 `PNPM_CONFIG_STRICT_DEP_BUILDS=false just test-frontend` passes — run by THIS review (fish round): 226 files / 4804 tests, all passed (49.6s). RE-RUN post-rename by this review: 4804 passed, exit 0 (49.1s)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- This run terminates at hydrate by explicit user direction — no ship, no PR.

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | *(superseded — the scene is now a single manta; see R4/R16)* Original markup contract was 1 shafts + 3 layers × 2 fish + 1 floor | The intake settled "5–6 fish across 3 depth layers"; 6 splits evenly into 3 layers of 2, keeping the markup symmetric and the CSS selectors simple. Fixed here so the CSS block and the unit test agree on one number | S:70 R:90 A:80 D:70 |
| 2 | Confident | Caustics and bubbles ride the overlay's `::before`/`::after` pseudos; only transform-needing elements become DOM children | The DOM-child mandate is about per-element transforms; a drifting ambient tile needs none, and every existing flair uses pseudos for ambience. Making them children would add compositor cost for nothing | S:65 R:90 A:85 D:70 |
| 3 | Confident | Reef uses the established fixed-px strip geometry rather than container queries, unless a specific element genuinely needs to follow the box | Every sprite flair uses fixed 22px strips with static centering and it holds at 18px/22px/36px and on SERVER tiles; `cube` reaches for `100cqw`/`100cqh` only because it ricochets around the whole box. Reef is a banded scene, so the strip pattern is the closer precedent | S:60 R:85 A:80 D:65 |
| 4 | Confident | `"Reef"`/`"REEF"` are added to `validate_test.go`'s `invalid` slice | Every other token has a case-variant rejection entry there; omitting reef's would leave the newest token as the only one without case-sensitivity coverage. Additive and cheap | S:65 R:95 A:90 D:80 |
| 5 | Certain | `aquarium` is not edited — verified by an explicit acceptance item (A-024) rather than left to reviewer attention | Stated unambiguously in the brief and the intake; making it a checked acceptance item is what stops an incidental edit from slipping through | S:95 R:90 A:95 D:95 |
| 6 | Certain | No Playwright e2e spec and no control-gallery baseline regeneration | Both settled at intake against verified evidence: zero e2e tests reference flair, and `control-gallery.tsx` contains no flair or swatch cells | S:85 R:85 A:95 D:90 |

6 assumptions (2 certain, 4 confident, 0 tentative).
