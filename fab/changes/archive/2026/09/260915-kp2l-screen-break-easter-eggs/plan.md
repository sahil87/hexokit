# Plan: Screen-break Easter eggs — the screen cracks open and something comes out of the monitor

**Change**: 260915-kp2l-screen-break-easter-eggs
**Intake**: `intake.md`

## Requirements

### Frontend: the `<ScreenBreak />` event layer

#### R1: One idle-null layer mounted once at the layout root
A single `<ScreenBreak />` controller SHALL mount exactly once in `AppLayoutContent` (`app/frontend/src/app.tsx`), as a sibling of the `.app-root` div beside `<ServerDialogs />` / `<LayoutCommandPalette />` — NEVER inside `.app-root` (a clipped/transformed ancestor would clip or re-anchor the layer's fixed fragments). While no egg is in flight it MUST render `null` and register no listeners except the store subscription. It MUST NOT be mounted per route.

- **GIVEN** the app on any route (terminal, board, host, server)
- **WHEN** no egg is in flight
- **THEN** the DOM contains no `[data-testid="screen-break"]` element and the `.app-root` element carries no inline `clip-path` or `transform`

#### R2: The glass is `.app-root`, mutated inline and cleaned up
The `.app-root` div SHALL be exposed to the layer through a ref callback registered into the screen-break store (`registerGlass(el | null)`), not a DOM query by class. While an egg is in flight the layer applies exactly these inline mutations to it: `style.clipPath = "url(#rk-sb-appclip)"`, the shake `style.transform`, and — only when its computed `position` is `static` — `style.position = "relative"` plus `style.zIndex` so the fixed below-group paints under it. Every mutation MUST be removed on finish, on unmount, and when the flight is cancelled.

- **GIVEN** an egg in flight
- **WHEN** `t` reaches 1, or the controller unmounts mid-flight
- **THEN** `.app-root`'s inline `clip-path`, `transform`, `position`, and `z-index` are all cleared (empty strings)

#### R3: Layer stack and stacking order
The layer SHALL render two `position: fixed; inset: 0; pointer-events: none` fragments, both `aria-hidden="true"`: a **below group** (`z-index: 0` — the dark ground with the radial glow, and the inside-clipped creature) and an **above group** (`z-index: 2` — the cracks `<svg>` clipped by `url(#rk-sb-appclip)`, the released creature, and the shards `<svg>`), with `.app-root` given `z-index: 1` for the flight. Both groups stay below the palette and toast layers (`z-50`). A released creature MUST both lose its clip AND move to the above group (or otherwise rise above the glass) in the same frame.

- **GIVEN** the fist egg at `em > 0.4`
- **WHEN** the frame renders
- **THEN** the fist paints over the `.app-root` content and over the cracks, unclipped, with its drop shadow

#### R4: The two clip paths share one hole string
An SVG `<defs>` inside the layer SHALL hold `<clipPath id="rk-sb-appclip" clipPathUnits="objectBoundingBox">` with one `<path clip-rule="evenodd" d="M0 0H1V1H0Z {hole}">` and `<clipPath id="rk-sb-hole" clipPathUnits="objectBoundingBox">` with `<path d="{hole}">`, where `{hole}` is the normalized (0–1) hole polygon string written once per frame and assigned to both paths.

- **GIVEN** a frame with hole amount `h`
- **WHEN** the paths update
- **THEN** both `d` attributes contain the identical hole substring for that `h`

#### R5: Discipline — transforms, opacity, SVG attributes, one rAF
All per-frame updates MUST be transforms, opacity, `filter`, `clip-path`, or SVG attribute/`style` writes — no layout properties. One `requestAnimationFrame` loop drives `t = clamp((now − start) / 4200, 0, 1)`; there are no `setTimeout`/`setInterval` timers. The only event listener the layer may add is a passive `pointermove` on `window` while the eye egg is in flight (writing a ref, never state), removed on finish. No sound. No pixel capture.

- **GIVEN** the layer's source
- **WHEN** reviewed
- **THEN** no `setTimeout`/`setInterval`, no `html2canvas`-style capture, no audio API, and at most the one `pointermove` listener exist

### Frontend: seeded geometry

#### R6: `buildBreak` is pure, seeded, and deterministic
`app/frontend/src/lib/screen-break-geometry.ts` SHALL export `buildBreak({ W, H, P, R, n = 9, seed = 7, rings = [] })` porting the study's generator: a fixed-seed LCG (`s = (s * 1664525 + 1013904223) >>> 0`), 9 radial crack polylines from `P` to past the `W×H` box (radial step 24–64 px, angular jitter ±0.14 rad), ring polygons at the given radii (18 vertices, per-vertex radius factor 0.88–1.12, angle jitter ±0.075 rad), an 18-vertex jagged hole (`holePts(h)` alternating crack vertices at `R·h·j`, `j ∈ [0.82, 1.18]`, and mid-angle vertices at `R·h·k`, `k ∈ [0.5, 0.75]`; `R·h` floored at 0.02), and 9 shard sectors (crack `i` at `0.2R`, hole vertices `2i..2i+2`, crack `i+1` at `0.24R`) each with centroid, unit radial `dir`, `speed ∈ [90, 260]`, `spin ∈ [−260°, 260°]`. It SHALL also export `normalizeHole(pts, W, H)` (the 0–1 path string), `holePathAt(geo, h)`, and the easing helpers `clamp`, `smooth`, `easeOut`, `easeIn`. No DOM, no React.

- **GIVEN** two calls with identical `{W, H, P, R}`
- **WHEN** compared
- **THEN** the outputs are deep-equal, with 9 crack paths, the requested ring count, 9 shards, and 18 hole vertices, and every crack's last vertex lies outside the `W×H` box

#### R7: Impact point and radius at fire time
At fire time the controller SHALL pick `P` uniformly in `x ∈ [0.25W, 0.75W]`, `y ∈ [0.25H, 0.75H]` (`W = window.innerWidth`, `H = window.innerHeight`) and `R = clamp(0.105·W, 64, 160)`, generate the geometry once with `rings = [1.7R, 2.7R]`, and never regenerate mid-flight (the two SVGs use `viewBox="0 0 W H"` + `preserveAspectRatio="none"`).

- **GIVEN** a viewport of 1440×900
- **WHEN** an egg fires
- **THEN** `R = 151.2`, `P.x ∈ [360, 1080]`, `P.y ∈ [225, 675]`

### Frontend: the timeline and the two eggs

#### R8: The render timeline
Per frame the layer SHALL compute, from `t`: `flash = t < 0.05 ? 1 − t/0.05 : 0`; `shake = t < 0.16 ? 1 − t/0.16 : 0` (glass transform `translate(sin(t·420)·5·shake px, cos(t·330)·4·shake px)`, `none` after); `cracks = easeOut(t/0.2)`; `rings = easeOut((t−0.05)/0.22)`; `hole = easeOut((t−0.05)/0.15)·(1 − easeIn((t−0.76)/0.16))`; `shards = clamp((t−0.07)/0.45)`; `em = smooth((t−0.22)/0.3)·(1 − smooth((t−0.6)/0.2))`; `cracksFade = 1 − clamp((t−0.88)/0.12)`. Cracks draw in via `stroke-dasharray = len`, `stroke-dashoffset = len·(1 − progress)`, rendered as a dark 2.4 px stroke (rings 1.6 px at .8 opacity) plus a 0.9 px white stroke translated (0.8, 0.8). Each shard: `translate(dir·speed·s + (0, 420·s²)) rotate(spin·s)` about its centroid, opacity `t > 0.06 ? 1 − smooth((s−0.45)/0.55) : 0`. The ground's opacity is `min(1, hole·1.6)`; the flash overlay's opacity is `flash·0.7`.

- **GIVEN** `t = 0.10`
- **WHEN** the frame renders
- **THEN** the radial cracks are half drawn, the hole is open, shards have lifted, and no creature is visible yet (`em = 0`)

#### R9: `smash` — the green fist on PR merged
The fist sprite (original inline SVG, `viewBox 0 0 200 200`, ~12 shapes per the intake's palette) SHALL animate per frame: `s = (0.1 + 1.15·em)·(R/76)`, `rotate((1−em)·−28°)`, `released = em > 0.4` (swap `clip-path` from `url(#rk-sb-hole)` to `none` AND move to the above group), `opacity = (hole > 0.02 || released) && em > 0 ? 1 : 0`, `filter = released ? drop-shadow(0 16·em px 20·em px rgba(0,0,0,.65)) : none`; ground glow `rgba(34,197,94,.3)`.

- **GIVEN** the viewed window's `prState` observed as `"open"` and then `"merged"` with `prNumber = 984`
- **WHEN** the flip is observed
- **THEN** the fist egg fires once with identity `"984"`

#### R10: `peek` — the eye on update available
The eye sprite (original inline SVG, `viewBox 0 0 200 200`, ~8 shapes; iris gradient in the accent blue) SHALL stay clipped to `url(#rk-sb-hole)` for the whole flight in the below group, with `scale = 0.78·(R/76)`, `scaleY(1 − b)` where `b = max(blink(0.40), blink(0.585))`, `blink(c) = |t−c| < 0.03 ? 1 − |t−c|/0.03 : 0`; pupil `<g transform="translate(look)">` with `look = pointer ? { x: clamp((px−P.x)/260, −1, 1)·22, y: clamp((py−P.y)/180, −1, 1)·14 } : { x: sin(t·9)·16, y: cos(t·6)·8 }`; `opacity = hole > 0.02 ? min(1, hole·2) : 0`; ground glow `rgba(192,132,252,.25)`.

- **GIVEN** `useUpdateNotification().showChip` observed `false` and then `true` with `key = "run-kit@3.9.0"`
- **WHEN** the flip is observed
- **THEN** the eye egg fires once with identity `"run-kit@3.9.0"`

### Frontend: triggers and gates

#### R11: The store — `fire`, gates, in-flight drop, once-per-identity
`app/frontend/src/lib/screen-break-store.ts` SHALL be a dependency-free module store exposing `fire(egg: "smash" | "peek", opts?: { force?: boolean; identity?: string }): boolean`, `subscribe(listener)`, `getState()` (`{ flight: null | { egg, startedAt, P, R, W, H } }`), `finish()`, `registerGlass(el)`, `getGlass()`, plus the constants `SMASH_KEY = "runkit-egg-smash"`, `PEEK_KEY = "runkit-egg-peek"`. `fire` returns `false` without side effects when: `prefersReducedMotion()` is true; `window.innerWidth < 640`; a flight is already in progress; or (non-force only) `identity` equals the stored value under the egg's key. On a non-force fire with an identity it writes the identity to localStorage BEFORE starting the flight (try/catch; storage failure still fires). `force: true` bypasses the identity check and writes nothing.

- **GIVEN** `runkit-egg-smash` = `"984"` in localStorage
- **WHEN** `fire("smash", { identity: "984" })` is called
- **THEN** it returns `false` and no flight starts
- **AND** `fire("smash", { force: true })` returns `true` and leaves the key at `"984"`

#### R12: `smash` trigger — observed non-merged → merged flip on the viewed window
`useScreenBreakTriggers()` SHALL resolve the viewed window from the deepest `useMatches()` params (`server`, `window`) against `SessionContext`'s sessions (the same walk `useGlobalPaletteActions` uses), watch `prState` for that `windowId`, and call `fire("smash", { identity: String(prNumber) })` only when the previously observed value for the SAME window was `"open"` or `"closed"` and the new value is `"merged"` with a defined `prNumber`. Changing windows resets the observed-previous; a window first seen as `merged` never fires; non-terminal routes (no `window` param) never fire.

- **GIVEN** the user navigates to a window already `merged`
- **WHEN** the hook first observes it
- **THEN** nothing fires

#### R13: `peek` trigger — the chip transition, identity `key`
The hook SHALL watch `useUpdateNotification()`'s `showChip` and `key`: when `showChip` becomes `true` (from `false` or from first observation) or `key` changes while `true`, call `fire("peek", { identity: key ?? latest ?? "" })`, skipping when the identity is empty. Because the store's once-per-identity rule compares against `runkit-egg-peek`, a reload with the chip already showing observes the stored key and does not fire; a later release (new `key`) fires once. Any route.

- **GIVEN** `runkit-egg-peek` = `"run-kit@3.9.0"` and the app loads with the chip already lit for that key
- **WHEN** the hook first observes `showChip = true`
- **THEN** nothing fires
- **AND** when a later `update-available` with key `"run-kit@3.10.0"` arrives, the eye fires once

#### R14: Two palette entries, never rate limited
`app/frontend/src/lib/palette/easter-eggs.ts` SHALL export `buildEasterEggActions(fire): PaletteAction[]` returning exactly `{ id: "easter-egg-smash", label: "Easter egg: Smash", description: "the screen cracks open", onSelect: () => fire("smash", { force: true }) }` and `{ id: "easter-egg-peek", label: "Easter egg: Peek", description: "something in there is watching", onSelect: () => fire("peek", { force: true }) }`, composed into `useGlobalPaletteActions` so both are available on every route. No keyboard chord.

- **GIVEN** the palette open on the Host page
- **WHEN** the user types `Easter`
- **THEN** both entries are listed, and selecting `Easter egg: Smash` starts the fist flight (subject only to the reduced-motion, viewport, and in-flight gates)

#### R15: Reduced motion never mounts
When `prefersReducedMotion()` is true, `fire()` returns `false`, no flight starts, nothing is written to localStorage, and the layer renders `null`. No static fallback.

- **GIVEN** `(prefers-reduced-motion: reduce)` matches
- **WHEN** `Easter egg: Smash` is selected
- **THEN** the DOM never contains `[data-testid="screen-break"]`

### Docs: the design study

#### R16: The study is committed and indexed
`docs/wiki/screen-break-easter-egg-studies.html` SHALL be committed byte-for-byte as it stands (no edits), and `docs/specs/index.md`'s `## Wiki` table SHALL gain one row in the existing pattern, noting that the row-scale version was not built and the cube is parked.

- **GIVEN** the change's diff
- **WHEN** inspected
- **THEN** the study file is added unmodified and the index has the new row ending "Self-contained; open in a browser"

### Non-Goals

- The brand-cube variant — parked, not built.
- The row-scale sidebar shatter on Ctrl+click kill — explicitly not built (user decision).
- Any backend, API, `rk` verb, tmux option, settings key, route, or trigger file.
- Sound, haptics, a keyboard chord, a daily cap.
- Mobile (< 640 px) support — the eggs no-op there.

### Design Decisions

#### The glass is `.app-root`, and the layer is its sibling
**Decision**: The clipped and shaken element is the `.app-root` div in `AppLayoutContent` (top bar + routed content + quake drawer + settings dialog), exposed via a ref callback into the store; `<ScreenBreak />` mounts as its sibling next to `<LayoutCommandPalette />`.
**Why**: `.app-root` is the one persistent element that contains everything the user perceives as "the screen" while excluding the palette, toasts, and server dialogs (fixed siblings), so the whole visible UI cracks and the egg layer can never be clipped by its own glass. `clip-path` on an ancestor clips fixed descendants and `transform` re-anchors them, so the layer must live outside.
**Rejected**: `.app-shell` (`Shell` in `shell.tsx`) — it excludes the top bar, so the crack would stop at the bar's edge, and it has two consumers (AppShell, BoardPage) to wire. A DOM query by class — the intake forbids it; a ref is explicit.
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

#### Stacking: two fixed groups around a temporarily positioned glass
**Decision**: Below group `z-index: 0`, glass `z-index: 1` (with `position: relative` set inline only if its computed position is `static`; under `html.fullbleed` it is already `fixed`), above group `z-index: 2`. All below the `z-50` palette/toast layers.
**Why**: A fixed ground can only paint under `.app-root` if `.app-root` is positioned with a higher z-index; making it a stacking context for 4.2 s is harmless (its internal z-50 popovers simply sit under the pointer-transparent cracks for the flight).
**Rejected**: `z-[70]` above everything — the eggs should never cover a toast or an open palette; the study's stack has the shell in the middle, not at the bottom.
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

#### Identity is written before the flight, and force writes nothing
**Decision**: A non-force automatic fire records its identity in localStorage synchronously before starting; a palette (`force`) fire never touches storage.
**Why**: Writing first makes a mid-flight reload idempotent (the transition already counted) and keeps the palette a pure "show me" action that cannot consume a future automatic occasion.
**Rejected**: Writing on finish — a reload during the 4.2 s would replay the egg. Having the palette write the identity — pressing Smash would silently eat the next real merge's celebration.
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

#### e2e opts back into motion explicitly
**Decision**: `screen-break.spec.ts` uses `test.use({ contextOptions: { reducedMotion: "no-preference" } })` for the mount test and the default config (`reducedMotion: "reduce"`) for the never-mounts test.
**Why**: `playwright.config.ts` sets `reducedMotion: "reduce"` globally, so the egg's own gate would hide it from every default-context test — the same opt-back-in five existing specs use.
**Rejected**: Disabling the gate under a test flag — the gate is the feature's accessibility contract and must be what the test exercises.
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

#### Shell clip vs overlay clip — measured at apply
**Decision**: Prefer clipping `.app-root` itself. Apply measures rAF frame deltas on the real app with at least one full-width terminal tile during a Smash flight; only sustained frames > 32 ms attributable to xterm repaints switch the design to clipping a fixed dark glass overlay above the shell (hole reveals the ground through the overlay; shake and shards unchanged). Measured 2026-09-16 on the dev rig (headless Chromium — no GPU, so a pessimistic bound; vsync-locked timing may mask sub-frame jank), viewport 1280×800, route `/fabKit/@22` (operator, a full-width terminal tile): 278 frames over the 4.6 s flight window, median 16.70 ms, p95 16.70 ms, max 16.80 ms — no frame above the 32 ms threshold, so the shell clip is KEPT and the overlay-clip fallback is not implemented.
**Why**: Removing the UI is what makes the crack read as real (study Decision 2); the fallback is only ~90 % as good but never stutters.
**Rejected**: Choosing the overlay up front without measuring — it gives up the effect's best quality on an unverified fear.
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

## Tasks

### Phase 1: Setup

- [x] T001 [P] Create `app/frontend/src/lib/screen-break-geometry.ts` — port the study's `buildBreak` (LCG, 9 cracks, rings, 18-vertex hole via `holePts(h)`, 9 shard sectors with centroid/dir/speed/spin), plus `normalizeHole`, `holePathAt`, `pickImpact(W, H, rand)`, `radiusFor(W)`, and the `clamp`/`smooth`/`easeOut`/`easeIn` helpers; no DOM imports <!-- R6, R7 --> <!-- rework: drop the never-read `Crack.a0` field (review nice-to-have) -->
- [x] T002 [P] Create `app/frontend/src/lib/screen-break-geometry.test.ts` — determinism (deep-equal on identical input), counts (9 cracks, N rings, 9 shards, 18 hole vertices), every crack ends outside the box, `normalizeHole` values lie in [0, 1], `radiusFor` clamps at 64/160 <!-- R6, R7 -->
- [x] T003 [P] Create `app/frontend/src/lib/screen-break-store.ts` — module store with `fire`/`subscribe`/`getState`/`finish`/`registerGlass`/`getGlass`, the `SMASH_KEY`/`PEEK_KEY` constants, the reduced-motion gate via `prefersReducedMotion()` from `@/lib/motion`, the 640 px floor, the in-flight drop, the once-per-identity read/write (try/catch), and a `_resetForTests()` helper <!-- R11, R15 --> <!-- rework: un-export MIN_VIEWPORT_WIDTH, consumed only inside the store (review nice-to-have) -->
- [x] T004 [P] Create `app/frontend/src/lib/screen-break-store.test.ts` — gates (reduced motion → false and no write; `innerWidth < 640` → false), in-flight second `fire` → false, same identity twice → false, identity written before flight, `force` bypasses and writes nothing, storage throwing still fires, `finish` clears the flight and notifies subscribers <!-- R11, R15 -->
- [x] T005 [P] Create `app/frontend/src/components/screen-break-sprites.tsx` — `FistSprite` and `EyeSprite` as React SVG components (original art per the intake's shape lists and palette; the eye's pupil group carries `data-part="pupil"`; the iris gradient reads the accent via `var(--color-accent, #5b8af0)`-style stops or the study's literal stops) <!-- R9, R10 --> <!-- rework: SPRITE_VIEWBOX is exported with zero call sites — delete it or use it in both sprites (review must-fix) -->

### Phase 2: Core Implementation

- [x] T006 Create `app/frontend/src/components/screen-break.tsx` — `ScreenBreak` layer: subscribes to the store; on a flight renders the below group (ground + inside creature) and the above group (cracks svg clipped to `#rk-sb-appclip`, released creature slot, shards svg, flash), the `<defs>` with `#rk-sb-appclip`/`#rk-sb-hole`, `data-testid="screen-break"` on the root fragment wrapper; one rAF loop computing the R8 timeline and writing hole `d`, dash offsets, shard transforms/opacity, ground/flash opacity, glass `clip-path`/`transform` (and `position`/`z-index` when static) via `getGlass()`; per-egg update for fist (R9, clip release + group move at `em > 0.4`) and eye (R10, passive window `pointermove` → ref); clears every glass mutation and listener on finish and on unmount <!-- R1, R2, R3, R4, R5, R8, R9, R10 -->
- [x] T007 Create `app/frontend/src/components/screen-break.test.tsx` — renders null when idle; after `fire("smash", { force: true })` (with `matchMedia` stubbed to no-preference, `innerWidth` 1280, a registered glass div) the `data-testid="screen-break"` root and both clipPath ids exist and the glass has inline `clip-path`; advancing the rAF (fake timers / `vi.spyOn(window, "requestAnimationFrame")`) to `t ≥ 1` clears the glass inline styles and unmounts the layer; unmounting mid-flight clears them too; the eye variant keeps `clip-path: url(#rk-sb-hole)` at `t = 0.5` while the fist has `none` <!-- R1, R2, R3, R4, R9, R10 -->
- [x] T008 Create `app/frontend/src/hooks/use-screen-break-triggers.ts` — resolves the viewed window via the deepest-first `useMatches()` params against `useSessionContext()` sessions; tracks `{ windowId, prState }` previous in a ref; fires `smash` on an observed `open|closed → merged` flip with `prNumber`; watches `useUpdateNotification()`'s `showChip`/`key`/`latest` and fires `peek` with identity `key ?? latest` on `false → true` (including first observation) or key change while true <!-- R12, R13 -->
- [x] T009 Create `app/frontend/src/hooks/use-screen-break-triggers.test.tsx` — with `StandaloneSessionContextProvider` and a mocked `useMatches`: `open → merged` fires once with identity `"984"`; `undefined → merged` (first observation) does not; window switch resets previous; board route never fires; `showChip false → true` fires `peek` with the key; stored key present + chip lit on first observation does not fire; new key fires again; `fire` is spied via the store module <!-- R12, R13 -->
- [x] T010 Create `app/frontend/src/lib/palette/easter-eggs.ts` (+ `easter-eggs.test.ts`) — `buildEasterEggActions(fire)` returning the two entries with the exact ids/labels/descriptions; test asserts labels, ids, and that `onSelect` calls `fire` with `{ force: true }` <!-- R14 -->
- [x] T011 Wire the mount and the palette: in `app/frontend/src/app.tsx` add `ref={registerGlass}` on the `.app-root` div and render `<ScreenBreakController />` (the layer + `useScreenBreakTriggers()`) as a sibling beside `<LayoutCommandPalette />`; in `app/frontend/src/hooks/use-global-palette-actions.ts` compose `buildEasterEggActions(fire)` into the global list; extend `use-global-palette-actions.test.tsx` to assert both entries are present <!-- R1, R2, R14 --> <!-- rework: remove the `(kp2l)` change-id citation from the new comment in use-global-palette-actions.ts (review should-fix, code-quality.md) -->

### Phase 3: Integration & Edge Cases

- [x] T012 Add a `§ Screen break` block to `app/frontend/src/globals.css` (before the `@media (prefers-reduced-motion: reduce)` block, per the source-order discipline): the two fixed group classes, crack stroke styles (`.rk-sb-crack-dark`, `.rk-sb-crack-lite`, `.rk-sb-ring`), shard fill/stroke (light-theme variant via `html.light`/the theme attribute the file already uses), the ground and flash; keep every per-frame value inline <!-- R3, R5, R8 -->
- [x] T013 Measure shell-clip performance on the real app (`just dev`, a window with a full-width terminal tile, fire `Easter egg: Smash`, log rAF deltas for the flight); if sustained frames > 32 ms trace to xterm repaints, implement the documented overlay-clip fallback; record the numbers and verdict in `## Requirements → Design Decisions → Shell clip vs overlay clip` <!-- R2, R5 -->
- [x] T014 Create `app/frontend/tests/e2e/screen-break.spec.ts` — file header + Proves/Steps JSDoc per the constitution; (1) with `test.use({ contextOptions: { reducedMotion: "no-preference" } })` and a 1280×800 viewport: open the palette, select `Easter egg: Smash`, expect `[data-testid="screen-break"]` visible, then detached within 6 s and `.app-root` without inline `clip-path`; (2) under the default `reduce` context the same action never mounts it; run `just test-e2e screen-break.spec` <!-- R14, R15, R1 -->
- [x] T015 Run `just test-e2e operator-compose.spec` — the `/^Operator:/` count is not expected to move; fix only if it fails <!-- R14 -->

### Phase 4: Polish

- [x] T016 `git add docs/wiki/screen-break-easter-egg-studies.html` unmodified and add the `## Wiki` row to `docs/specs/index.md` (label "Screen Break Easter Egg Studies", description per the intake's Change area 7, ending "Self-contained; open in a browser") <!-- R16 -->
- [x] T017 Gates: `cd app/frontend && npx tsc --noEmit`, full `just test-frontend` (never scoped), `just build`; fix anything red <!-- R1, R5 -->

## Execution Order

- T001–T005 are independent and parallel; T006 depends on T001, T003, T005; T007 on T006
- T008 depends on T003; T009 on T008; T010 on T003; T011 depends on T006, T008, T010
- T012 can run alongside T006; T013 depends on T011 and T012; T014 depends on T011
- T016 is independent; T017 last

## Acceptance

### Functional Completeness

- [x] A-001 R1: `<ScreenBreakController />` is mounted exactly once in `AppLayoutContent` as a sibling of `.app-root`, and renders null while idle
- [x] A-002 R2: `.app-root` is registered via a ref callback and receives only inline `clip-path`, `transform`, and (when static) `position`/`z-index` during a flight
- [x] A-003 R3: The below group, glass, and above group stack 0 / 1 / 2 and the released fist paints above the glass and cracks
- [x] A-004 R4: `#rk-sb-appclip` (evenodd outer rect + hole) and `#rk-sb-hole` exist in the layer's `<defs>` with `clipPathUnits="objectBoundingBox"` and share the hole string
- [x] A-005 R6: `buildBreak` exists in `lib/screen-break-geometry.ts` with the specified outputs and no DOM/React imports
- [x] A-006 R7: Impact point and radius are chosen at fire time per the 25–75 % box and `clamp(0.105·W, 64, 160)`, and geometry is not regenerated on resize
- [x] A-007 R8: The per-frame timeline constants match the requirement (flash, shake, cracks, rings, hole, shards, em, cracksFade)
- [x] A-008 R9: The fist sprite animates per R9 and is released (clip none + above group) at `em > 0.4`
- [x] A-009 R10: The eye sprite stays hole-clipped, blinks at 0.40 and 0.585, and its pupil follows the pointer or drifts
- [x] A-010 R11: The store exposes `fire`/`subscribe`/`getState`/`finish`/`registerGlass`/`getGlass` and the two localStorage key constants
- [x] A-011 R12: The smash trigger fires only on an observed `open|closed → merged` flip on the viewed window with a `prNumber`
- [x] A-012 R13: The peek trigger fires on `showChip` becoming true (or key change) with identity `key ?? latest`, deduplicated by `runkit-egg-peek`
- [x] A-013 R14: `Easter egg: Smash` and `Easter egg: Peek` are global palette entries with the exact ids and `force: true` selects
- [x] A-014 R16: The study HTML is committed unmodified and `docs/specs/index.md` has its Wiki row

### Behavioral Correctness

- [x] A-015 R2: On finish and on mid-flight unmount, every inline mutation on `.app-root` is cleared (tested)
- [x] A-016 R11: In-flight `fire` returns false and does not queue; same-identity `fire` returns false; `force` bypasses the identity and writes nothing; identity is written before the flight starts (tested)
- [x] A-017 R15: Under reduced motion `fire` returns false, nothing mounts, nothing is written (unit + e2e)
- [x] A-018 R11: Below 640 px viewport width `fire` returns false (tested)

### Scenario Coverage

- [x] A-019 R12: Unit test covers `undefined → merged` (no fire), window switch reset, and non-terminal routes never firing
- [x] A-020 R13: Unit test covers reload-with-chip-lit-and-stored-key (no fire) and a new key firing once
- [x] A-021 R14: e2e `screen-break.spec.ts` proves the palette entry mounts the layer and it detaches within 6 s with the glass cleaned, under `reducedMotion: "no-preference"`
- [x] A-022 R6: Geometry determinism test passes (identical input ⇒ deep-equal output)

### Edge Cases & Error Handling

- [x] A-023 R11: localStorage throwing (private mode) neither blocks the fire nor throws
- [x] A-024 R5: The only event listener added is the passive `pointermove` during the eye flight, and it is removed on finish
- [x] A-025 R2: Firing on a route where the glass ref is unregistered (null) is a safe no-op (no throw)

### Code Quality

- [x] A-026 Pattern consistency: new palette entries come from a pure `lib/palette/*.ts` builder composed by `use-global-palette-actions.ts`; new code follows `FlairOverlay`'s aria-hidden / pointer-events-none discipline and the `runkit-<feature>-<thing>` storage key convention
- [x] A-027 No unnecessary duplication: `prefersReducedMotion()` from `lib/motion.ts` is reused; easing helpers live once in the geometry module; no second reduced-motion or storage helper is introduced
- [x] A-028 Readability over cleverness: the timeline constants are named, and the per-frame update is a small set of focused functions (no god function > 50 lines without reason)
- [x] A-029 Type narrowing over assertions: egg kind and flight state use discriminated unions/literal types, no `as` casts beyond the CSS custom-property style object idiom already used by `FlairOverlay` — the one `as` present (route-params narrowing in `use-screen-break-triggers.ts:36`) is the verbatim idiom R12 mandates copying from `useGlobalPaletteActions`
- [x] A-030 Comments state constraints the code cannot show (why the layer is a sibling of the glass; why identity is written before the flight); no narration, no change-id citations in code
- [x] A-031 Tests included: colocated Vitest for geometry, store, triggers, palette builder, and component; one Playwright spec with Proves/Steps JSDoc and a file header; full `just test-frontend` green
- [x] A-032 No polling from the client, no timers other than the single rAF loop, no new dependencies

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The glass is the `.app-root` div in `AppLayoutContent`, not `.app-shell` | Verified by reading `app.tsx` (~L487) and `shell.tsx` (~L272): `.app-root` contains the top bar + routed content + quake drawer while the palette/toasts/dialogs are fixed siblings; `.app-shell` excludes the top bar and has two consumers. Satisfies the intake's containment rule | S:75 R:90 A:85 D:75 |
| 2 | Confident | Stacking is below `0` / glass `1` / above `2`, with `position: relative` set inline only when the glass computes `static` | The fixed ground can only sit under the glass if the glass is positioned; `html.fullbleed .app-root` is already `fixed`. Values chosen under the existing `z-50` palette/toast ceiling (verified in `toast.tsx`, `command-palette.tsx`) | S:70 R:85 A:80 D:70 |
| 3 | Certain | e2e opts back into motion with `test.use({ contextOptions: { reducedMotion: "no-preference" } })` | `playwright.config.ts` sets `reducedMotion: "reduce"` globally; existing specs use the same opt-back-in | S:90 R:95 A:90 D:90 |
| 4 | Confident | Identity is written to localStorage before the flight; palette `force` fires never write | Makes a mid-flight reload idempotent and keeps the palette from consuming a real occasion (Design Decisions) | S:70 R:90 A:80 D:70 |
| 5 | Confident | `useScreenBreakTriggers` resolves the viewed window from the deepest `useMatches()` params against `SessionContext` | The idiom `useGlobalPaletteActions` and `AppLayoutContent` (zen) already use for layout-level window awareness; `ChromeContext` does not carry the current window | S:75 R:90 A:85 D:75 |
| 6 | Confident | Light-theme shard tint uses the study's light-app variant (`rgba(255,255,255,.75)` / `rgba(30,41,59,.55)`); the ground stays dark in both themes | Intake Assumption #10; the theme hook the CSS already uses selects the variant | S:65 R:90 A:80 D:70 |
| 7 | Confident | The `peek` trigger also fires on first observation of `showChip = true` (not only a `false → true` flip within the tab) | Intake Assumption #16 — the stored key is what makes reload idempotent; an update arriving while the tab was closed still gets its eye once | S:70 R:90 A:80 D:70 |
| 8 | Certain | Palette entry descriptions are short hints ("the screen cracks open", "something in there is watching") | `description` joins the filter haystack (`PaletteAction` type) and the intake permits an optional hint | S:80 R:95 A:90 D:85 |
| 9 | Confident | The fist's release (R3's "lose the clip AND rise above the glass in the same frame") is implemented as TWO stacked creature slots — a hole-clipped one in the below group and an unclipped one in the above group — swapping visibility at `em > 0.4`, rather than moving one node between groups | R3 explicitly allows "or otherwise rise above the glass"; a DOM `appendChild` move between React-managed parents risks unmount `removeChild` errors, and both slots sharing the same per-frame transform makes the swap seamless. ~12 extra SVG shapes stay within the ~30-node budget | S:80 R:90 A:85 D:80 |

9 assumptions (2 certain, 7 confident, 0 tentative).
