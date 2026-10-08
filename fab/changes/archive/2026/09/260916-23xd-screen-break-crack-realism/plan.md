# Plan: Screen-break Easter eggs phase 2 — realistic cracks, dead-pixel lines, and a slow 12 s flight

**Change**: 260916-23xd-screen-break-crack-realism
**Intake**: `intake.md`

> The approved mock is the spec. Apply reads it from `docs/wiki/screen-break-crack-realism-studies.html` once T001 has copied it (source: `/tmp/claude-1001/-home-sahil-code-sahil87-run-kit-worktrees-molten-cheetah/6a18a7b2-5b1a-446c-a819-3d867d54a4ec/scratchpad/crack-realism-mock.html`). Its `buildBreak`, `Breaker`, and `Screen.apply` carry the exact numbers; the intake § What Changes restates them in full.

## Requirements

### Geometry: seeded generator

#### R1: Deterministic generator with the new return shape
`buildBreak({ W, H, P, R, seed = 7 })` in `app/frontend/src/lib/screen-break-geometry.ts` MUST stay pure (no DOM, no React) and deterministic: one fixed-seed LCG stream (`s = (s·1664525 + 1013904223) >>> 0`), consumed in the intake's generation order (primaries → branches → arcs → micro-cracks → hole/shards → lines), so identical `{W, H, P, R}` yield byte-identical output. The `n` and `rings` parameters and the `crackDs`/`ringDs` fields are removed. The return type MUST be `{ P, R, W, H, n, strokes: BreakStroke[], lines: BreakLine[], shards: BreakShard[], holePts }` with `BreakStroke = { d, w, lw, start, dur, s0, s1, ease: "smooth" | "out" }` and `BreakLine = { x1, y1, x2, y2, color, w, op, start, flick }`. `clamp`/`smooth`/`easeOut`/`easeIn`, `normalizeHole`, `holePathAt`, `pickImpact`, `radiusFor` are unchanged. Tuning numbers (step ranges, drift, widths, timing windows, radii multipliers, colours) SHALL live in named constants at the top of the module, not inline literals.

- **GIVEN** the fixture `{ W: 1280, H: 800, P: { x: 640, y: 400 }, R: 134 }`
- **WHEN** `buildBreak` runs twice
- **THEN** both results serialize identically, including `holePts(0)`, `holePts(0.5)`, `holePts(1)`
- **AND** `n ∈ [8, 10]`, `shards.length === n`, `holePts(1).length === 2n`

#### R2: Primaries — uneven, tapered, slow
`n = 8 + floor(rand·3)` primaries at angles `base + i·2π/n + (rand − 0.5)·0.9·(2π/n)` (sorted); ~65 % run to `maxD` (farthest corner + 80), the rest stop at `maxD·(0.3 + rand·0.4)`; each walks with step 16–46 px, drift ±0.11 rad, 10 % chance of a ±0.3 rad kink, then re-keys every point's `r` to its true distance from P. Each primary MUST be emitted as three tapered pieces split at 30 % / 62 % of its polyline `r` with core widths `[3.0, 1.9, 1.0]`, highlight widths `[1.1, 0.8, 0.5]`, `ease: "smooth"`, `start = 0.025 + rand·0.05`, `dur = 0.12 + rand·0.06`, and `s0`/`s1` = the piece's cumulative fractional span so the three pieces draw back-to-back as one crack.

- **GIVEN** the generated strokes for the fixture
- **WHEN** the `ease: "smooth"` strokes are grouped by identical `(start, dur)`
- **THEN** there are exactly `n` groups of three, each chaining `s0 = 0 → s1 = 1` in order

#### R3: Branches, partial arcs, crushed zone
Branches: 1–3 per primary from `max(1.25R, len·(0.25–0.75))` (skipped past 90 % of the parent or off-screen), heading `dirAt ± (0.35–0.85 rad)`, length `max(28, remaining·(0.15–0.5))`, two pieces split at 45 % (core `[1.5, 0.8]`, highlight `[0.6, 0.4]`, `ease: "out"`, `start = 0.17 + rand·0.35`, `dur = 0.06 + rand·0.12`); 35 % of branches get one depth-1 sub-branch (`remaining·(0.3–0.6)`, core `[0.9, 0.5]`, highlight `[0.4, 0.3]`, `start = parent.start + 0.6·parent.dur + rand·0.1`); on-screen tips farther than `1.4R` from P are collected as line sources with `start + dur`. Partial arcs replace the rings: at `[1.35, 2.1, 3.2, 4.6, 6.5]·R`, ~50 % of adjacent primary pairs get an arc (`r·(0.92–1.08)` at each end, 3–5 jittered intermediate points, skipped when a primary is too short or both ends are off-screen) with `w = 1.0 − 0.06·mult`, `lw = 0.5`, `start = 0.17 + rand·0.4`, `dur = 0.04 + rand·0.08`. Crushed zone: 26 micro-cracks (5–17 px) in the `1.02–1.42R` annulus, `w = 0.8`, `lw = 0.4`, `start = 0.01 + rand·0.06`, `dur = 0.04`.

- **GIVEN** the generated strokes for the fixture
- **WHEN** every stroke's timing is inspected
- **THEN** `start ≥ 0`, `dur > 0`, `start + dur ≤ 1`, `w > 0`, `lw > 0` for all of them

#### R4: Hole and shards — the shipped rule, keyed to the new primaries
`holePts(h)` MUST keep the shipped rule (`Rt = max(R·h, 0.02)`; per primary a vertex at `Rt·j_i` and a mid-angle vertex at `Rt·k_i`, `j ∈ [0.82, 1.18]`, `k ∈ [0.5, 0.75]`) over the `n` primaries. Shards MUST keep the shipped sector rule (`[at(c, 0.2R), hole[2i], hole[2i+1], hole[2i+2], at(c2, 0.24R)]`, centroid, unit `dir`, `speed ∈ [90, 260]`, `spin ∈ ±260°`), one per primary.

- **GIVEN** the fixture
- **WHEN** shards are inspected
- **THEN** every `dir` is unit length, `speed ∈ [90, 260]`, `|spin| ≤ 260`, and `holePathAt(geo, 1)` has `2n` coordinate pairs all within `[0, 1]`

#### R5: Dead-pixel lines
5–8 lines sourced from branch tips (fallback: primary points at `min(0.7·len, 2.5R)` with `start 0.2`), 60 % vertical, 50 % edge-to-edge through the source and 50 % from the source to the far edge, colours from `['#ff3ad6', '#ff3ad6', '#35e8ff', '#35e8ff', '#62ff6a', '#ffffff', '#ffd23d']`, 70 % hairlines (`w = 1`, `op = .9`) and 30 % bands (`w = 2–4`, `op = .45`), `start = clamp(source.start + rand·0.1, 0.17, 0.55)`, `flick = rand·100`. Every endpoint MUST lie inside `[0, W] × [0, H]`.

- **GIVEN** the fixture
- **WHEN** `lines` is inspected
- **THEN** `5 ≤ lines.length ≤ 8`, every endpoint is in bounds, every `start ∈ [0.17, 0.55]`, every `color` is in the palette

### Layer: `screen-break.tsx`

#### R6: The 12 s flight
`FLIGHT_MS` MUST be 12000 and the per-frame rule MUST follow the intake's table: flash/shake `t < 0.025` (shake `translate(sin(t·840)·5·shake, cos(t·660)·4·shake)`), `hole = easeOut((t − 0.17)/0.1)·(1 − easeIn((t − 0.76)/0.1))`, shards `sp = clamp((t − 0.18)/0.25)` visible once `t > 0.17` with the shipped kinematics (`translate(dir·speed·sp + (0, 420·sp²))`, no horizontal factor), creature `em = smooth((t − 0.3)/0.14)·(1 − smooth((t − 0.64)/0.12))`, `fade = 1 − clamp((t − 0.87)/0.13)` written to both the cracks SVG and the LCD SVG, frost opacity `0.9·easeOut((t − 0.008)/0.045)`, per stroke `p = (ease === "smooth" ? smooth : easeOut)((t − start)/dur)`, `q = clamp((p − s0)/(s1 − s0 || 1))`, `dashoffset = len·(1 − q)` on both the dark and highlight paths, per line `on = t ≥ start`, `flick = on ? (sin(t·900 + flick) > 0.92 ? 0.55 : 1) : 0`, core opacity `op·flick`, glow opacity `0.22·flick`. The fist's release threshold, scale, rotation and shadow rules are unchanged; the eye's blink centres MUST move to 0.47 and 0.58 (`±0.03`). One rAF loop, no timers, `aria-hidden`, `pointer-events: none`, per-frame writes limited to opacity/transform/filter/SVG attributes; the glass mutations and their clearing on finish/unmount are unchanged.

- **GIVEN** a `smash` flight started at `startedAt`
- **WHEN** the rAF callback runs at `startedAt + 6000` (t = 0.5)
- **THEN** the fist is in the released above-glass slot and the inside slot is hidden
- **GIVEN** a `peek` flight at `startedAt + 6000`
- **THEN** the eye stays in the hole-clipped below-glass slot and the above slot stays hidden
- **GIVEN** any flight
- **WHEN** the callback runs at `startedAt + 12100`
- **THEN** the layer unmounts, `finish()` empties the store, and `.app-root` carries no inline `clip-path`, `transform`, `position`, or `z-index`

#### R7: Render structure — per-piece widths, frost, LCD layer
The cracks SVG (above group, clipped by `#rk-sb-appclip`) MUST render, in order: a `<circle class="rk-sb-frost" cx=P.x cy=P.y r=1.5R fill="url(#rk-sb-frost)">` (opacity inline), the dark group with one `<path d stroke-width={w}>` per stroke, and the highlight group `transform="translate(0.7 0.7)"` with one `<path d stroke-width={lw}>` per stroke. `<defs>` MUST carry `<radialGradient id="rk-sb-frost" gradientUnits="userSpaceOnUse" cx cy r=1.5R>` with stops `0.6 → rgba(255,255,255,0.16)` and `1 → rgba(255,255,255,0)`. A new `<svg class="rk-sb-lcd" viewBox preserveAspectRatio="none" style={{ clipPath: "url(#rk-sb-appclip)" }}>` MUST sit in the above group BEFORE (below) the cracks SVG, holding one `<g class="rk-sb-lines">` with, per line, a glow `<line stroke={color} stroke-width={w + 2.5}>` then a core `<line stroke={color} stroke-width={w}>`, both starting at opacity 0. Dash arrays are seeded from `getTotalLength()` at mount (jsdom fallback 1). The `ringDs` render path goes away.

- **GIVEN** a mounted flight
- **WHEN** the DOM is inspected
- **THEN** `.rk-sb-lcd` exists with `2 × lines.length` `<line>` children, the cracks SVG's first child is the frost circle, `radialGradient#rk-sb-frost` is in defs, and every crack `<path>` carries a `stroke-width` attribute

### CSS: `globals.css` § Screen break

#### R8: Attribute widths win; LCD rules; ring rule gone
`.rk-sb-crack-dark path` and `.rk-sb-crack-lite path` MUST NOT declare `stroke-width` (a CSS declaration would override the per-piece presentation attribute); the highlight stroke becomes `rgba(255,255,255,.62)`; the light-theme dark rule keeps `stroke: #1f2937` and drops its `stroke-width: 2`; the light-theme highlight becomes `rgba(255,255,255,.95)`. The `.rk-sb-crack-dark path.rk-sb-ring` rule MUST be removed. `.rk-sb-lcd` MUST join the `.rk-sb-cracks, .rk-sb-shards` positioning rule and gain `.rk-sb-lcd line { stroke-linecap: butt; }`. The block's header comment updates its layer list and flight length; the reduced-motion posture is unchanged (no CSS gate — the layer never mounts).

- **GIVEN** the stylesheet
- **WHEN** the § Screen break block is read
- **THEN** no rule under `.rk-sb-crack-dark` / `.rk-sb-crack-lite` sets `stroke-width`, no `rk-sb-ring` rule exists, and `.rk-sb-lcd` is positioned like the cracks SVG

### Tests

#### R9: Retimed and extended tests
`screen-break-geometry.test.ts` MUST be rewritten for the new shape (R1–R5 scenarios; `normalizeHole`/`holePathAt`/`pickImpact`/`radiusFor` cases kept). `screen-break.test.tsx` MUST keep every existing case retimed to 12 s (t = 1 at `+12100`, t = 0.5 probes at `+6000`) and add the R7 DOM probes. `screen-break.spec.ts` MUST widen the detach assertion to `toHaveCount(0, { timeout: 15_000 })` with `test.setTimeout(30_000)` at the top of that test body and update its `Proves:`/`Steps:` intent comment (no PR numbers or change IDs); the reduced-motion test is unchanged. Gates: `just test-frontend` (full Vitest) and `just test-e2e screen-break.spec` (single spec) MUST pass.

- **GIVEN** the worktree after apply
- **WHEN** `just test-frontend` and `just test-e2e screen-break.spec` run
- **THEN** both report all tests passed

### Performance

#### R10: The 32 ms frame gate, re-measured
The flight MUST be re-measured with the phase-1 recipe — headless Chromium via the worktree's Playwright, viewport 1280×800, a route with a full-width terminal tile, an injected `requestAnimationFrame` delta logger, `Easter egg: Smash` fired from the palette, frame deltas sampled over the whole 12 s — against a 32 ms threshold. If any frame exceeds 32 ms: drop the 26 micro-cracks (keep the frost disc) and re-measure; if still failing, halve the arc occupancy (`rand > 0.5` → `rand > 0.75`) and re-measure. **Baseline exception**: a frame above 32 ms that reproduces in a no-egg baseline on the same rig at the same offset is environmental rig noise, not flight cost — such frames are exempt from the fallback ladder, and the baseline run MUST be recorded alongside the flight numbers. The measured numbers (frame count, median, p95, max) and the branch taken MUST be recorded under `## Notes` → **Performance measurement** in this plan so hydrate can lift them into memory.

- **GIVEN** the finished implementation on the dev rig
- **WHEN** the measurement script runs one full flight
- **THEN** the max frame delta is ≤ 32 ms once environmental spikes (frames reproducing in the recorded no-egg baseline) are excluded, or the fallback ladder was applied until it is, and the numbers are in `## Notes`

### Docs

#### R11: The study page, its index row, and the phase-1 pointer
`docs/wiki/screen-break-crack-realism-studies.html` MUST be the approved mock copied verbatim, retitled (`<title>` and `<h1>` → "Screen Break Crack Realism Studies"), with a `<h2>4. Decisions</h2>` section appended before the closing `<script>` recording: variant C chosen 2026-09-16; ink rejected (weaker on dark, blots terminal text on light — the toggle stays as the comparison artefact); the reference-photo rework (organic lobed hole, pulverized chip ring, 36 hairline radials, glass dust) tried and rejected as "looks worse", the shipped hole and shards kept; the 12 s pacing approved; the `easter_eggs` settings-registry bool deferred to a follow-up change. `docs/specs/index.md` § Wiki MUST gain one row for it modelled on the `Screen Break Easter Egg Studies` row. `docs/wiki/screen-break-easter-egg-studies.html` § 7 MUST gain one pointer line after its table. Apply MUST NOT touch `docs/memory/`.

- **GIVEN** the repo after apply
- **WHEN** the three doc files are read
- **THEN** the new page opens standalone in a browser with the mock's live break and filmstrip, the Wiki table lists it, and the phase-1 page points at it

### Non-Goals

- The `easter_eggs` registry setting — a follow-up change
- Triggers, store gates, palette entries, sprites, the < 640 px and reduced-motion gates — untouched
- Ink / liquid-crystal bleed — rejected
- Pixel capture or `backdrop-filter` refraction; the mock's 1.3× horizontal shard stretch

### Design Decisions

#### Variant C — glass realism plus dead-pixel lines, no ink
**Decision**: Ship the tapered/branching glass geometry with the dead-pixel line layer; drop the ink blobs and tongues.
**Why**: The coloured lines carry the "my actual monitor" beat with zero legibility cost; ink is nearly invisible on dark themes and blots terminal text on light ones.
**Rejected**: B (glass + ink) and D (glass + ink + lines) — occlusion of the terminal during a celebration; A (glass only) — too playful to read as damage.
*Introduced by*: 260916-23xd-screen-break-crack-realism

#### The shipped hole and shards stay
**Decision**: Keep the 2n-vertex jagged `holePts` rule and the sector shards; the reference-photo rework (organic lobed hole, ~90-chip pulverized ring, 36 hairlines, dust) is rejected.
**Why**: The user judged the rework "looks worse" side by side; the hole and shards are the parts of phase 1 that already read well.
**Rejected**: The organic spline hole with a chip ring — denser, ~500 SVG nodes, and visually worse in context.
*Introduced by*: 260916-23xd-screen-break-crack-realism

#### Per-stroke timing windows over a global draw-in
**Decision**: Every stroke record carries `{start, dur, ease, s0, s1}`; the layer evaluates each stroke's own window per frame.
**Why**: This is what lets primaries travel slowly (ease-in-out over 1.4–2.2 s) while branches, arcs and lines keep arriving for seconds afterwards — the "grow more slowly" ask — with one rAF loop and no timers.
**Rejected**: Scaling the phase-1 global `cracks = easeOut(t/0.2)` curve — everything would still snap in together, only later.
*Introduced by*: 260916-23xd-screen-break-crack-realism

#### Stroke width as a presentation attribute, not a class
**Decision**: Each crack `<path>` carries its own `stroke-width` attribute; the CSS crack rules set colour and caps only.
**Why**: Taper is per piece (three widths per primary, two per branch), and a CSS `stroke-width` declaration would override every attribute regardless of specificity.
**Rejected**: One class per width bucket — five classes for a value the record already carries.
*Introduced by*: 260916-23xd-screen-break-crack-realism

#### Shard kinematics unchanged
**Decision**: Keep `translate(dir·speed·sp + (0, 420·sp²))` without the mock's 1.3× horizontal factor.
**Why**: The discussion and the mock's own comparison table both list shards as unchanged; the factor is an undocumented mock artefact and is a one-constant reversal if ever wanted.
**Rejected**: Adopting the factor silently.
*Introduced by*: 260916-23xd-screen-break-crack-realism

## Tasks

### Phase 1: Setup

- [x] T001 [P] Create `docs/wiki/screen-break-crack-realism-studies.html`: copy the approved mock verbatim from `/tmp/claude-1001/-home-sahil-code-sahil87-run-kit-worktrees-molten-cheetah/6a18a7b2-5b1a-446c-a819-3d867d54a4ec/scratchpad/crack-realism-mock.html`, retitle `<title>`/`<h1>` to "Screen Break Crack Realism Studies", append `<h2>4. Decisions</h2>` (C chosen 2026-09-16 · ink rejected, toggle kept for comparison · reference-photo rework rejected as "looks worse", shipped hole/shards kept · 12 s pacing approved · `easter_eggs` setting deferred to a follow-up) before the closing `<script>`; open it headlessly once to confirm no page errors <!-- R11 -->
- [x] T002 [P] Add the Wiki-table row in `docs/specs/index.md` (model: the `Screen Break Easter Egg Studies` row) and the one-line phase-2 pointer after the § 7 table in `docs/wiki/screen-break-easter-egg-studies.html` <!-- R11 -->

### Phase 2: Core Implementation

- [x] T003 Rewrite `app/frontend/src/lib/screen-break-geometry.ts`: new `BreakStroke`/`BreakLine`/`BreakGeometry` types, tuning constants at the top, `buildBreak({ W, H, P, R, seed })` porting the mock's generator in its exact LCG consumption order (primaries with three tapered pieces → branches + depth-1 sub-branches with tip collection → partial arcs → 26 micro-cracks → `holePts`/shards over the n primaries → dead-pixel lines); keep `clamp`/`smooth`/`easeOut`/`easeIn`/`normalizeHole`/`holePathAt`/`pickImpact`/`radiusFor`; `npx tsc --noEmit` clean from `app/frontend` <!-- R1 R2 R3 R4 R5 -->
- [x] T004 Rewrite `app/frontend/src/lib/screen-break-geometry.test.ts` for the new shape: determinism over `strokes`/`lines`/`shards`/`holePts(0|0.5|1)`; `n ∈ [8,10]`, `shards.length === n`, `holePts(1).length === 2n`; exactly n groups of three `smooth` pieces chaining `s0 = 0 → s1 = 1`; every stroke `start ≥ 0`, `dur > 0`, `start + dur ≤ 1`, `w > 0`, `lw > 0`; `lines.length ∈ [5,8]`, endpoints in `[0,W]×[0,H]`, `start ∈ [0.17,0.55]`, colours in the palette; shard `dir`/`speed`/`spin` bounds; `holePathAt` has `2n` pairs in `[0,1]`; keep `pickImpact`/`radiusFor` cases <!-- R1 R2 R3 R4 R5 -->
- [x] T005 Rewrite the flight in `app/frontend/src/components/screen-break.tsx`: `FLIGHT_MS = 12000`; the R6 per-frame rule (flash/shake, hole, shards with shipped kinematics, `em`, `fade` to both SVGs, frost opacity, per-stroke eased dash rule on both paths, per-line flicker opacities, blink centres 0.47/0.58); the R7 DOM (frost circle + `radialGradient#rk-sb-frost` in defs, one dark + one highlight `<path stroke-width>` per stroke, highlight group `translate(0.7 0.7)`, the new `.rk-sb-lcd` SVG below the cracks SVG with glow+core `<line>` pairs); remove the `ringDs` path; keep the two-slot fist release, ground glow, pointer listener, cleanup, `key={startedAt}` remount and `ScreenBreakController`; update the file header comment for the 12 s flight and the LCD layer <!-- R6 R7 -->
- [x] T006 Update `app/frontend/src/globals.css` § Screen break: drop `stroke-width` from `.rk-sb-crack-dark path` / `.rk-sb-crack-lite path` and from the light-theme dark rule; highlight `rgba(255,255,255,.62)` (light: `.95`); delete the `.rk-sb-ring` rule; add `.rk-sb-lcd` to the positioning rule and `.rk-sb-lcd line { stroke-linecap: butt; }`; refresh the block's header comment (layer list, 12 s) <!-- R8 -->

### Phase 3: Integration & Edge Cases

- [x] T007 Update `app/frontend/src/components/screen-break.test.tsx`: retime t = 1 to `startedAt + 12100` and the two t = 0.5 probes to `startedAt + 6000`; add probes for `.rk-sb-lcd` with `2 × lines.length` lines, the frost circle as the cracks SVG's first child, `radialGradient#rk-sb-frost` in defs, and a `stroke-width` attribute on every crack path; keep the idle/mount/cleanup/reduced-motion cases <!-- R6 R7 R9 -->
- [x] T008 Update `app/frontend/tests/e2e/screen-break.spec.ts`: `test.setTimeout(30_000)` at the top of the mount test's body, detach assertion `toHaveCount(0, { timeout: 15_000 })`, JSDoc `Proves:`/`Steps:` retimed to the ~12 s flight and 15 s detach (no PR numbers or change IDs); leave the reduced-motion test as is <!-- R9 -->
- [x] T009 Run the gates from the repo root: `just test-frontend` (full Vitest — never a scoped file list) then `just test-e2e screen-break.spec` (single spec; a trailing ` ELIFECYCLE  Command failed.` after the rig's "see you again~" teardown is not a test failure — gate on the `N passed` line); fix and re-run until both are green <!-- R9 -->
- [x] T010 Measure the frame budget per R10 on this worktree's dev rig (`just dev` in the background, then an ad-hoc `@playwright/test` script with `NODE_PATH=app/frontend/node_modules` against the rig's derived port: 1280×800, a `/{server}/{window}` route, inject an rAF delta logger, fire `Easter egg: Smash` from the palette, sample 12.5 s); apply the fallback ladder only if a frame exceeds 32 ms; record frame count / median / p95 / max and the branch taken under `## Notes` → **Performance measurement** below; stop the dev rig afterwards <!-- R10 -->

## Execution Order

- T001 and T002 are independent of the code tasks and may run first or in parallel with them
- T003 blocks T004 and T005; T005 blocks T006's verification and T007; T003–T008 block T009; T009 blocks T010

## Acceptance

### Functional Completeness

- [x] A-001 R1: `buildBreak` is deterministic on the fixture and returns `{ n, strokes, lines, shards, holePts }` with no `crackDs`/`ringDs`; tuning values are named constants
- [x] A-002 R2: the fixture yields n primaries as three-piece tapered `smooth` strokes with the intake's widths and `start`/`dur` windows
- [x] A-003 R3: branches, sub-branches, partial arcs at the five radii, and 26 micro-cracks are generated with their timing windows, and branch tips feed the line sources
- [x] A-004 R4: `holePts` and shards follow the shipped rule over the n primaries
- [x] A-005 R5: 5–8 dead-pixel lines with in-bounds endpoints, the seven-colour palette, hairline/band split, and `start ∈ [0.17, 0.55]`
- [x] A-006 R6: `FLIGHT_MS = 12000` and every per-frame formula matches the R6 table, including the moved blink centres and the shipped shard kinematics
- [x] A-007 R7: the frost circle + gradient, per-piece `stroke-width` attributes, and the `.rk-sb-lcd` SVG below the cracks SVG render as specified
- [x] A-008 R8: the CSS block sets no `stroke-width` on crack paths, has no ring rule, positions `.rk-sb-lcd`, and uses the new highlight alphas
- [x] A-009 R11: the new wiki page (verbatim mock + retitle + § 4 Decisions), the specs-index row, and the § 7 pointer exist; `docs/memory/` is untouched by apply

### Behavioral Correctness

- [x] A-010 R6: at t = 0.5 the fist is released above the glass and the eye stays hole-clipped below it; at t = 1 the layer unmounts and the glass is clean
- [x] A-011 R6: the cracks SVG and the LCD SVG fade together over 10.4–12 s; lines are invisible before their `start` and pop in without a ramp

### Removal Verification

- [x] A-012 R1: no reference to `crackDs`, `ringDs`, `rings`, or `rk-sb-ring` remains in `app/frontend/src` or `globals.css`

### Scenario Coverage

- [x] A-013 R9: `screen-break-geometry.test.ts` covers R1–R5's scenarios and `screen-break.test.tsx` covers R6–R7's; `just test-frontend` passes in full
- [x] A-014 R9: `screen-break.spec.ts` passes via `just test-e2e screen-break.spec` with the 15 s detach window and `test.setTimeout(30_000)`, and its intent comment describes the 12 s flight

### Edge Cases & Error Handling

- [x] A-015 R3: a branch whose start would fall past 90 % of its parent or off-screen is skipped without consuming a retry, and no stroke has `start + dur > 1`
- [x] A-016 R5: with fewer than five on-screen branch tips the primary fallback sources keep the line count at 5–8 on the fixture; an off-screen source is discarded, never clamped into a degenerate zero-length line
- [x] A-017 R10: the measured max frame delta is ≤ 32 ms after at most the two documented fallbacks — frames above 32 ms that reproduce in the recorded no-egg baseline (same rig, same offsets) are environmental and exempt per R10's baseline exception — and the numbers plus the branch taken are recorded under `## Notes`

### Code Quality

- [x] A-018 Pattern consistency: the generator stays pure and dependency-free; the layer keeps the FlairOverlay discipline (one rAF loop, no timers, `aria-hidden`, `pointer-events: none`, per-frame writes limited to opacity/transform/filter/SVG attributes)
- [x] A-019 No unnecessary duplication: easing helpers and `normalizeHole` are reused, not re-implemented in the layer
- [x] A-020 Type narrowing over assertions: no new `as` casts beyond the existing `instanceof SVGSVGElement` guards
- [x] A-021 No magic numbers: the generator's tuning values are named constants; the layer's timeline fractions are named or table-commented, not bare literals scattered through `applyFrame`
- [x] A-022 Tests accompany the change: geometry, component, and e2e tests updated in the same change; the e2e `test()` carries a current `Proves:`/`Steps:` block and the spec header still describes the shared setup
- [x] A-023 Comment discipline: comments state constraints (why the LCD SVG sits below the cracks SVG, why widths are attributes), never narrate the next line or cite PR numbers / change IDs

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- **Performance measurement**: full geometry shipped — no fallback kept. Flight run on this worktree's dev rig (headless Chromium, 1280×800, `/shll/1`, rAF deltas over the 12.5 s window, `Easter egg: Smash` from the palette): **748 frames, median 16.7 ms, p95 16.8 ms, max 50.1 ms**. The 5 frames over 32 ms (one at ~2.4 s, a cluster at ~10.8–11.1 s) reproduce identically in a no-egg baseline on the same rig and route (743 frames, median 16.7 ms, p95 16.7 ms, max 50.1 ms, spikes at the same offsets — the rig's ~8.3 s periodic snapshot work), so they are environmental, not flight cost. The fallback ladder was exercised for evidence: dropping the 26 micro-cracks left the profile unchanged (750 frames, median 16.7 ms, p95 16.8 ms, max 50 ms, same spike offsets), so the drop was reverted and arc occupancy was never touched.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Tuning values become named constants at the top of the geometry module rather than the mock's inline literals | `fab/project/code-quality.md` lists magic numbers without named constants as an anti-pattern; the values themselves are unchanged | S:85 R:95 A:95 D:90 |
| 2 | Certain | The performance numbers are recorded under this plan's `## Notes` for hydrate to lift into memory | The intake asks for the numbers in memory "from apply's result notes"; apply must not touch `docs/memory/`, so the plan is the hand-off surface | S:80 R:95 A:95 D:90 |
| 3 | Confident | The measurement runs against this worktree's `just dev` rig with an ad-hoc `@playwright/test` script | Phase 1 measured on the dev rig; `just pw` needs a running rig and the bare `playwright` package is not installed here | S:70 R:90 A:80 D:75 |
| 4 | Certain | The phase-1 `stepTo`-style rAF harness in `screen-break.test.tsx` is kept and only retimed | The existing test structure already drives the loop by hand; only the constants move | S:85 R:95 A:95 D:95 |

4 assumptions (3 certain, 1 confident, 0 tentative).
