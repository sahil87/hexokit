---
type: memory
description: "The screen-break Easter eggs — a one-shot, whole-viewport event layer clipping the .app-root glass with a real evenodd hole, a seeded crack web plus flickering dead-pixel LCD lines, falling shards, and a slow 12 s timeline; a green fist on PR merged (smash), an eye on update available (peek). The `easter_eggs` setting (default on) gates the automatic occasions; the two palette entries bypass it. Triggers fire once per identity; reduced motion never mounts; viewports < 640 px no-op."
---
# run-kit UI — Screen-Break Easter Eggs

**Domain**: run-kit/ui

## Overview

The screen-break Easter eggs are the product's one-shot, whole-viewport **event layer**: when an occasion fires, the screen cracks open — a web of tapered, branching cracks that creeps in over seconds, plus a handful of flickering dead-pixel LCD lines — 8–10 glass shards fall away, a creature appears in (or punches out of) the hole, and 12 s later the UI is whole again. It is the viewport-scoped counterpart of the row-scoped flair catalogue ([visual-design](/run-kit/ui/visual-design.md) § Character Flair Overlays) — NOT a 17th flair. The mechanism is documented end-to-end in two self-contained, runnable design studies (open in a browser): the event layer itself at `docs/wiki/screen-break-easter-egg-studies.html`, and the crack realism, dead-pixel lines, and 12 s pacing at `docs/wiki/screen-break-crack-realism-studies.html`. (kp2l, 23xd)

Two eggs ship (kp2l):

- **`smash` — the green fist.** Fires when the PR of the *viewed window* flips to **merged**. The fist emerges through the hole and is *released* in front of the app with a drop shadow.
- **`peek` — the eye.** Fires when the top-bar UpdateChip lights (update available). The eye stays clipped inside the hole the whole flight, blinks twice, and its pupil follows the pointer.

Both sprites are original inline SVG — an allusion, never a name or face (the `spidey`/`ironman` IP posture; `app/frontend/src/components/screen-break-sprites.tsx`). The eye's iris gradient reads the instance accent via `var(--color-accent, #5b8af0)`.

## Mount and the glass contract

`<ScreenBreakController />` (the `<ScreenBreak />` layer plus `useScreenBreakTriggers()`) mounts exactly once in `AppLayoutContent` (`app/frontend/src/app.tsx`), as a **sibling of the `.app-root` div** beside `<LayoutCommandPalette />` — never inside `.app-root` and never per route. While idle the layer renders `null` and registers no listeners beyond its store subscription. (kp2l)

The **glass** is the `.app-root` div itself (top bar + routed content + quake drawer + settings dialog). The layout exposes it via a ref callback into the store — `registerGlass(el | null)` / `getGlass()` in `lib/screen-break-store.ts` — never a DOM query by class. While an egg is in flight the layer applies exactly these inline mutations to it:

- `style.clipPath = "url(#rk-sb-appclip)"` — the evenodd hole; the real UI is *removed* inside the hole, not painted over
- the shake `style.transform` (a decaying ±5/±4 px jitter for `t < 0.025`, `"none"` after)
- `style.position = "relative"` — only when its computed position is `static` (under `html.fullbleed` it is already `fixed`) — plus `style.zIndex = "1"`, so the fixed below-group can paint under it

Every mutation is cleared (empty strings) on finish, on unmount, and on cancel; a flight on a route where the glass ref is unregistered (`null`) is a safe no-op.

## Layer stack and clip paths

The layer renders two `position: fixed; inset: 0; pointer-events: none` groups around the glass, all `aria-hidden="true"`, all below the `z-50` palette/toast layers:

| Group | z-index | Contents |
|---|---|---|
| below group | 0 | the dark inside-ground (`#03040a` in both themes) with a radial glow at the impact point in the creature's color; the hole-clipped creature |
| `.app-root` (glass) | 1 (inline, flight-only) | the whole app, clipped by the evenodd hole + shaken |
| above group | 2 | in order: the dead-pixel LCD lines `<svg>` (`.rk-sb-lcd`), the cracks `<svg>` — first child a frost circle over the crushed zone, then the dark crack cores and the offset white highlights (the SVG is clipped by the same evenodd path, so no crack draws inside the hole), the released creature, the shards `<svg>`, the flash overlay |

The LCD SVG sits below the cracks SVG because dead pixels read as the panel underneath; both share the app clip and the same per-frame fade. Line colour is an inline `stroke` attribute per line, so the LCD layer needs no theme variant — dead pixels are emissive in both themes. (23xd)

The layer's `<defs>` holds two `<clipPath clipPathUnits="objectBoundingBox">` elements sharing **one hole string written once per frame** and assigned to both paths, plus the frost fill:

- `#rk-sb-appclip` — one `<path clip-rule="evenodd" d="M0 0H1V1H0Z {hole}">` (outer rect + hole polygon, normalized 0–1)
- `#rk-sb-hole` — `<path d="{hole}">`
- `radialGradient#rk-sb-frost` — `gradientUnits="userSpaceOnUse"` at the impact point with `r = 1.5R`, stops `rgba(255,255,255,0.16)` at 0.6 → transparent at 1; the frost `<circle>` (same centre and radius) is the cracks SVG's first child and carries its opacity inline

The fist's release (losing the clip alone is not enough — an unclipped element in the below group still paints under the glass) is implemented as **two stacked creature slots**: a hole-clipped slot in the below group and an unclipped slot in the above group, sharing the same per-frame transform, swapping visibility at the release threshold.

Static styling lives in the `§ Screen break` block of `globals.css` (`rk-sb-*` classes — the two fixed groups, ground/flash, crack stroke colours and caps with their light-theme variant via `html[data-theme="light"]`); every per-frame value (opacities, dash offsets, transforms, the hole `d`, the glass mutations) is written **inline** by the layer. The crack CSS rules deliberately set no `stroke-width` — taper widths are per-piece presentation attributes on the paths (see § Design Decisions).

## Seeded geometry

`app/frontend/src/lib/screen-break-geometry.ts` is a pure, dependency-free port of the crack-realism study's `buildBreak` (no DOM, no React); every tuning number (step ranges, drift, widths, timing windows, radii multipliers, line colours) lives in named constants at the top of the module. `buildBreak({ W, H, P, R, seed = 7 })` runs a fixed-seed LCG (`s = (s·1664525 + 1013904223) >>> 0`) consumed in exactly this order — primaries → branches and depth-1 sub-branches (tips collected) → partial arcs → micro-cracks → hole/shards → dead-pixel lines — and returns `{ P, R, W, H, n, strokes, lines, shards, holePts }` with `BreakStroke = { d, w, lw, start, dur, s0, s1, ease: "smooth" | "out" }` and `BreakLine = { x1, y1, x2, y2, color, w, op, start, flick }`: (23xd)

- **n = 8–10 primaries** at jittered near-even angles (jitter ±0.45 of the even spacing, sorted); ~65 % run to `maxD` (farthest viewport corner from P + 80 px), the rest stop at 0.3–0.7·maxD. Each is a random walk with 16–46 px steps, ±0.11 rad drift per step, and a 10 % chance of a ±0.3 rad kink, with every point re-keyed to its true distance from P. Each primary emits **three tapered pieces** split at 30 %/62 % of its length (core widths 3.0/1.9/1.0 px, highlights 1.1/0.8/0.5 px, `ease: "smooth"`) sharing the primary's `start = 0.025–0.075` and `dur = 0.12–0.18`, with `s0`/`s1` = each piece's cumulative fractional span so the three pieces draw back-to-back as one crack.
- **Branches**: 1–3 per primary, starting at `max(1.25R, 25–75 % of the parent length)` (skipped past 90 % of the parent or off-screen — a skip still counts toward the branch count), heading `±(0.35–0.85 rad)` off the parent's local heading, two tapered pieces split at 45 % (cores 1.5/0.8, highlights 0.6/0.4, `ease: "out"`, `start = 0.17–0.52`, `dur = 0.06–0.18`); 35 % of branches grow one depth-1 sub-branch (cores 0.9/0.5, highlights 0.4/0.3, `start = parent.start + 0.6·parent.dur + 0–0.1`). On-screen branch tips farther than 1.4R from P are collected as dead-pixel line sources.
- **Partial arcs** at `[1.35, 2.1, 3.2, 4.6, 6.5]·R` stitch ~50 % of adjacent primary pairs (radius jitter 0.92–1.08 at each end, 3–5 jittered intermediate points, skipped when a primary is too short or both ends are off-screen), `w = 1.0 − 0.06·mult`, `lw = 0.5`, `start = 0.17–0.57`, `dur = 0.04–0.12`, `ease: "out"`.
- **Crushed zone**: 26 micro-cracks (5–17 px) in the 1.02–1.42R annulus (`w = 0.8`, `lw = 0.4`, `start = 0.01–0.07`, `dur = 0.04`). The frost disc is not geometry — the layer renders it from P/R.
- **a 2n-vertex jagged hole** — `holePts(h)` alternates primary vertices at `R·h·j` (`j ∈ [0.82, 1.18]`) and mid-angle vertices at `R·h·k` (`k ∈ [0.5, 0.75]`), `R·h` floored at 0.02.
- **n shard sectors** (one per primary) between adjacent primaries — polygon `[at(c, 0.2R), hole[2i], hole[2i+1], hole[2i+2], at(c2, 0.24R)]` — each with centroid, unit radial `dir`, `speed ∈ [90, 260]` px, `spin ∈ ±260°`.
- **5–8 dead-pixel lines** sourced from branch tips (fallback when tips < 5: primary points at `min(0.7·len, 2.5R)` with `start 0.2`), 60 % vertical, half edge-to-edge through the source and half source-to-far-edge, colours from `['#ff3ad6', '#ff3ad6', '#35e8ff', '#35e8ff', '#62ff6a', '#ffffff', '#ffd23d']`, 70 % hairlines (`w = 1`, `op = .9`) and 30 % bands (`w = 2–4`, `op = .45`), `start ∈ [0.17, 0.55]`, `flick ∈ [0, 100)`. Every endpoint lies inside `[0, W] × [0, H]` by construction.

Every stroke satisfies `start ≥ 0`, `dur > 0`, `start + dur ≤ 1`. Plus `normalizeHole(pts, W, H)` (the 0–1 path string), `holePathAt(geo, h)`, `pickImpact(W, H)`, `radiusFor(W)`, and the easing helpers `clamp`/`smooth`/`easeOut`/`easeIn`. **Determinism contract**: identical `{W, H, P, R}` ⇒ byte-identical output (unit-tested); the seed is fixed and only the impact point varies per run.

At fire time the controller picks the impact point uniformly inside the central viewport box (`x ∈ [0.25W, 0.75W]`, `y ∈ [0.25H, 0.75H]`) and `R = clamp(0.105·W, 64, 160)` (~10.5 % of viewport width; sprites scale by `R / 76`). Geometry is generated once per flight; the SVGs use `viewBox="0 0 W H"` + `preserveAspectRatio="none"`, so a mid-flight resize stretches rather than regenerates.

## The 12 s timeline

One `requestAnimationFrame` loop drives `t = clamp((now − startedAt) / 12000, 0, 1)`; there are no `setTimeout`/`setInterval` timers. Per frame (fractions of the flight; seconds in brackets): (23xd)

```
flash = t < 0.025 ? 1 − t/0.025 : 0   (flash overlay opacity = flash·0.7)               [0–0.3 s]
shake = t < 0.025 ? 1 − t/0.025 : 0   (glass translate(sin(t·840)·5·shake, cos(t·660)·4·shake), "none" after)
frost = 0.9 · easeOut((t − 0.008)/0.045)   (frost circle opacity)                       [0.1–0.6 s]
hole  = easeOut((t − 0.17)/0.1) · (1 − easeIn((t − 0.76)/0.1))   → hole open amount [opens 2.0–3.2 s, closes 9.1–10.3 s]; ground opacity = min(1, hole·1.6)
sp    = clamp((t − 0.18)/0.25)        → shards; visible once t > 0.17                   [2.2–5.2 s]
em    = smooth((t − 0.3)/0.14) · (1 − smooth((t − 0.64)/0.12))   → the creature's emerge amount [in 3.6–5.3 s, hold, out 7.7–9.1 s]
fade  = 1 − clamp((t − 0.87)/0.13)    → cracks svg AND lcd svg opacity                  [10.4–12 s]
```

**Per-stroke draw rule**: `p = (ease === "smooth" ? smooth : easeOut)((t − start)/dur)` is the whole crack's progress; `q = clamp((p − s0)/(s1 − s0 || 1))` is this piece's share; `stroke-dashoffset = len·(1 − q)` is written to BOTH the dark core and the white highlight path, so the tapered pieces of one crack draw back-to-back as a single travelling crack. Dash arrays seed from one `getTotalLength()` per path at mount (jsdom fallback 1). Each stroke renders as two stacked paths: a dark core plus a white highlight translated (0.7, 0.7), each carrying its own `stroke-width` attribute (the taper is per piece — the CSS rules set colour and caps only).

**Per-line flicker rule**: `on = t ≥ start` (lines pop in instantly, no ramp); `flick = on ? (sin(t·900 + flick) > 0.92 ? 0.55 : 1) : 0`; core opacity `on ? op·flick : 0`, glow opacity `on ? 0.22·flick : 0`. Each line renders as a glow `<line>` (stroke-width `w + 2.5`) under a core `<line>` (stroke-width `w`).

Shards keep their kinematics: `translate(dir·speed·sp + (0, 420·sp²)) rotate(spin·sp about centroid)`, opacity `1 − smooth((sp − 0.45)/0.55)` once `t > 0.17` (else 0). They are glass-tinted polygons (`rgba(226,232,255,.22)` fill; the light theme swaps to `rgba(255,255,255,.75)` / `rgba(30,41,59,.55)`), never UI copies — there is no pixel capture.

At `t ≥ 1` the loop stops, the glass mutations clear, `finish()` empties the store, and the layer returns to its idle `null` render.

**Dismiss — click the creature.** The creature sprite is the layer's ONE click target: `.rk-sb-sprite svg *` re-enables hit-testing (`pointer-events: visiblePainted; cursor: pointer`) on the painted shapes only, while both fixed groups stay `pointer-events: none`, so the cracks and the rest of the viewport remain transparent to the pointer. Each frame writes the inactive creature slot `visibility: hidden` (opacity 0 still hit-tests; visibility does not), so only the visible fist or eye can be clicked, and the hole clip on the inside slot clips hit-testing too. A click calls `dismiss()`; from the next frame the loop runs a compressed timeline: `raw = clamp((now − startedAt)/12000)`, `td = clamp((dismissedAt − startedAt)/12000)`, `v0 = dismissOrigin(td)`, `t = clamp(v0 + (raw − td)·3)` (`DISMISS_SPEED = 3`), where `dismissOrigin` resumes on the creature's retreat at the point with the same emerge amount (`td ≥ 0.64 → td`; `0.44 ≤ td < 0.64 → 0.64`; else `0.64 + 0.12·(1 − clamp((td − 0.3)/0.14))` — the smoothstep is symmetric, so the sprite's size never jumps). Retreat, hole close, and fade then play in ~1.4 s instead of ~4.3 s; nothing cuts. Keyboard has no dismiss (keys belong to the tmux pane), and the setting is the switch for people who never want the eggs. (hn6s)

### `smash` — the fist's per-frame rule

`scale = (0.1 + 1.15·em)·(R/76)`, `rotate = (1−em)·−28°`, opacity `1` once `em > 0` and the hole has opened (or it is released); **released at `em > 0.4`** — the inside slot hides, the above slot shows, and both sprites gain `drop-shadow(0 16·em px 20·em px rgba(0,0,0,.65))`. Ground glow: `rgba(34,197,94,.3)`.

### `peek` — the eye's per-frame rule

Never released — clipped to `#rk-sb-hole` for the whole flight, above slot always hidden. `scale = 0.78·(R/76)` (sclera ≈ 1.5× the hole) with `scaleY(1 − b)` where `b = max(blink(0.47), blink(0.58))` and `blink(c) = |t−c| < 0.03 ? 1 − |t−c|/0.03 : 0`; both blink centres fall inside `em`'s plateau (0.44–0.64) so the eye is fully open around each blink. The pupil (`data-part="pupil"`) follows the pointer — offset `clamp((px − P.x)/260, −1, 1)·22` / `clamp((py − P.y)/180, −1, 1)·14` — drifting sinusoidally (`sin(t·9)·16, cos(t·6)·8`) when no pointer has been seen. The pointer comes from the layer's one permitted event listener: a passive `pointermove` on `window` registered only while the eye is in flight, writing a ref, removed on finish. Opacity: `hole > 0.02 ? min(1, hole·2) : 0`. Ground glow: `rgba(192,132,252,.25)`.

## The store — gates and once-per-identity

`app/frontend/src/lib/screen-break-store.ts` is a dependency-free module store: `fire(egg, opts?): boolean`, `subscribe(listener)` (consumed via `useSyncExternalStore`), `getState()` (`{ flight: null | { egg, startedAt, P, R, W, H, dismissedAt? } }`), `finish()`, `dismiss(): boolean` (stamps `dismissedAt` on the live flight once — a no-op without a flight or when already stamped — and notifies; the layer turns the stamp into the fast heal below), `registerGlass`/`getGlass`, the key constants `SMASH_KEY = "hexokit-egg-smash"` / `PEEK_KEY = "hexokit-egg-peek"`, and the **enabled gate** — module state defaulting to `true` behind `setEasterEggsEnabled(v)` (the seam's committed flip) / `seedEasterEggsEnabled(v)` (the controller's mount-fetch seed, which loses to a committed flip that landed while the fetch was in flight) / `easterEggsEnabled()` (reset by `_resetForTests()`), fed from the `easter_eggs` registry setting (§ Triggers). `fire` returns `false` with no side effects when:

- `prefersReducedMotion()` is true (the `lib/motion.ts` helper) — the layer never mounts, nothing is written; **no static fallback**
- `window.innerWidth < 640` — the shards need room to fall
- a flight is already in progress — dropped, never queued (palette spam and back-to-back merges both drop)
- the store is disabled and the fire is not forced — the gate sits after the in-flight check and before the identity block, and writes **no identity**: the triggers fire only on observed transitions, so nothing needs consuming and re-enabling later cannot replay an old occasion (§ Design Decisions)
- a non-force `identity` equals the value stored under the egg's key

A non-force fire with an identity **writes the identity to localStorage BEFORE the flight starts** (try/catch; storage failure still fires). `force: true` (the palette) bypasses the identity check AND the enabled gate and **writes nothing**. Storage access is try/catch-wrapped; absence (private mode) degrades to "fire". A flight already in progress when the setting flips off is not cancelled — the gate governs starting, not running. (hn6s)

## Triggers — client-side derived transitions

`useScreenBreakTriggers()` (`hooks/use-screen-break-triggers.ts`, mounted inside `ScreenBreakController`) derives both occasions from data the frontend already receives — no backend change, no `rk` verb, no API route, no tmux option, no trigger file.

The enabled gate's value is seeded once per page load: `ScreenBreakController` runs one `getSettingsEntries()` in a mount effect and calls `seedEasterEggsEnabled(entry === undefined || entry.value !== false)` — a missing key or a rejected fetch keeps the store enabled (the default-on posture), a resolution arriving after unmount is dropped, and a seed arriving after a committed flip changes nothing. The triggers themselves mount only once that read has settled (a `seeded` state gates the hook's wrapper component), so an occasion already observable at page load — a lit update chip — cannot outrun a persisted off value. A same-browser flip applies immediately through the settings seam's `easter_eggs` commit case ([dialogs-and-state](/run-kit/ui/dialogs-and-state.md) § Settings Dialog → the registry seam's write routing); other browsers pick the value up on their next reload. No polling, no SSE. (hn6s)

- **`smash`** resolves the viewed window from the deepest `useMatches()` params (`server`, `window`) against `SessionContext`'s sessions (the same walk `useGlobalPaletteActions` uses) and watches that window's `prState`: only an **observed** `"open"`/`"closed"` → `"merged"` flip with a defined `prNumber` fires, with identity `String(prNumber)`. The first observation of a window never fires (merged is a terminal state visible forever on old windows); switching windows resets the observed-previous; routes without a `window` param never fire.
- **`peek`** watches `useUpdateNotification()`'s `showChip` and `key`: `showChip` becoming true — **including the first observation with the chip already lit** — or a `key` change while lit, fires with identity `key ?? latest ?? ""` (skipped when empty). The stored `hexokit-egg-peek` key is what makes a reload with the chip already showing idempotent; a later release (new key) fires once. Any route.

## Palette entries

Two global entries (every route), built by the pure `buildEasterEggActions(fire)` in `lib/palette/easter-eggs.ts` (the `lib/palette/version.ts` pure-builder pattern) and composed by `use-global-palette-actions.ts`:

| id | label | description | onSelect |
|---|---|---|---|
| `easter-egg-smash` | `Easter egg: Smash` | `the screen cracks open` | `fire("smash", { force: true })` |
| `easter-egg-peek` | `Easter egg: Peek` | `something in there is watching` | `fire("peek", { force: true })` |

Palette fires are `force`: never rate limited, never persisted — the only silent no-ops are the environmental gates (reduced motion, < 640 px, in-flight). They bypass the `easter_eggs` enabled gate too, so the entries keep working while the setting is off. No keyboard chord — the palette IS the chord (Constitution V). A palette-fired flight is dismissed like any other — by clicking the creature (§ The 12 s timeline → Dismiss).

## Tests

Colocated Vitest covers the geometry determinism and shape contracts (`screen-break-geometry.test.ts` — two builds serialize identically including `holePts(0/0.5/1)`, `n ∈ [8, 10]`, `shards.length === n`, `holePts(1).length === 2n`, exactly n groups of three `ease: "smooth"` pieces chaining `s0 = 0 → s1 = 1`, the per-stroke timing envelope `start ≥ 0 ∧ dur > 0 ∧ start + dur ≤ 1`, 5–8 lines with in-bounds endpoints and palette colours, shard `dir`/`speed`/`spin` bounds, plus the `normalizeHole`/`holePathAt`/`pickImpact`/`radiusFor` cases), the store's gates/identity semantics (`screen-break-store.test.ts` — including `dismiss()` stamping once and no-oping without a flight, and the enabled gate: a disabled non-force fire returns `false` with no identity write, `force` bypasses the gate, re-enabling fires and writes the identity normally, `_resetForTests()` restores enabled, and the seed/flip precedence: a committed flip wins over a later seed, a seed applies when nothing was committed), the layer's mount/cleanup/clip behavior retimed to the 12 s flight (`screen-break.test.tsx` — t = 1 at `startedAt + 12100`, the fist-released / eye-clipped probes at `startedAt + 6000` inside `em`'s plateau, plus DOM probes: the LCD SVG carries `2 × lines.length` `<line>` children, the frost circle is the cracks SVG's first child with `radialGradient#rk-sb-frost` in defs, and every crack path carries a `stroke-width` attribute, and the dismiss case: at t = 0.5 the released fist's slot is `visibility: visible` and the inside slot `hidden`, a click on one of its painted shapes stamps `dismissedAt`, and 1.5 s later the compressed heal has unmounted the layer with the glass clean — plus the `ScreenBreakController` mount-fetch cases with `getSettingsEntries` mocked: an `easter_eggs: false` entry disables the store, a missing entry or a rejected fetch keeps it enabled, and the deferred triggers — a lit update chip fires nothing while the seed read pends, then respects the seeded value either way), the trigger flips (`use-screen-break-triggers.test.tsx`), and the palette builder (`easter-eggs.test.ts`). The seam's `easter_eggs` commit case (POST then store mirror; `null` re-enables the store AND mirrors the registry default into the entry; a mount fetch resolving after a commit does not overwrite the committed value) lives in `settings-registry-seam.test.tsx`, the General-tab row in `settings-dialog.test.tsx`, and `tests/e2e/settings-dialog.spec.ts` round-trips the `Easter eggs` toggle through `GET /api/settings` (negating the read initial value, then restoring it). (hn6s) The e2e spec `app/frontend/tests/e2e/screen-break.spec.ts` proves the palette's Smash entry mounts `[data-testid="screen-break"]` and that it detaches within 15 s with `.app-root` left clean — the mount test sets `test.setTimeout(30_000)` — under `test.use({ contextOptions: { reducedMotion: "no-preference" } })`, since `playwright.config.ts` sets `reducedMotion: "reduce"` globally — that clicking a painted shape of the released fist (`[data-part="creature-above"] svg *`, via `dispatchEvent("click")`) detaches the layer within 4 s, and that under the default reduce context the same action never mounts the layer. (kp2l, 23xd, hn6s)

## Design Decisions

### The glass is `.app-root`, and the layer is its sibling
**Decision**: The clipped and shaken element is the `.app-root` div in `AppLayoutContent` (top bar + routed content + quake drawer + settings dialog), exposed via a ref callback into the store; `<ScreenBreak />` mounts as its sibling next to `<LayoutCommandPalette />`.
**Why**: `.app-root` is the one persistent element that contains everything the user perceives as "the screen" while excluding the palette, toasts, and server dialogs (fixed siblings), so the whole visible UI cracks and the egg layer can never be clipped by its own glass. `clip-path` on an ancestor clips fixed descendants and `transform` re-anchors them, so the layer must live outside.
**Rejected**: `.app-shell` (`Shell` in `shell.tsx`) — it excludes the top bar, so the crack would stop at the bar's edge, and it has two consumers (AppShell, BoardPage) to wire. A DOM query by class — a ref is explicit.
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

### Stacking: two fixed groups around a temporarily positioned glass
**Decision**: Below group `z-index: 0`, glass `z-index: 1` (with `position: relative` set inline only when the glass computes `static`; under `html.fullbleed` it is already `fixed`), above group `z-index: 2`. All below the `z-50` palette/toast layers.
**Why**: A fixed ground can only paint under `.app-root` if `.app-root` is positioned with a higher z-index; making it a stacking context for the flight is harmless (its internal z-50 popovers simply sit under the pointer-transparent cracks for the duration).
**Rejected**: `z-[70]` above everything — the eggs should never cover a toast or an open palette; the study's stack has the shell in the middle, not at the bottom.
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

### Identity is written before the flight, and force writes nothing
**Decision**: A non-force automatic fire records its identity in localStorage synchronously before starting; a palette (`force`) fire never touches storage.
**Why**: Writing first makes a mid-flight reload idempotent (the transition already counted) and keeps the palette a pure "show me" action that cannot consume a future automatic occasion.
**Rejected**: Writing on finish — a reload mid-flight would replay the egg. Having the palette write the identity — pressing Smash would silently eat the next real merge's celebration.
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

### Shell clip over overlay clip — kept on measurement
**Decision**: The shell clip is kept. Measured 2026-09-16 on the dev rig (headless Chromium — no GPU, so a pessimistic bound; vsync-locked timing may mask sub-frame jank), viewport 1280×800, on a route with a full-width terminal tile: 278 frames over the flight window, median 16.70 ms, p95 16.70 ms, max 16.80 ms — no frame above the 32 ms threshold that would have switched the design to the documented fallback (a fixed dark glass overlay above the shell receives the evenodd clip instead; the hole then reveals the ground through the overlay; shake and shards unchanged). The fallback is not implemented. Re-measured on the same rig over the full 12 s flight with the crack-realism geometry (748 frames, median 16.7 ms, p95 16.8 ms, max 50.1 ms): the frames over 32 ms reproduce identically in a no-egg baseline at the same offsets (the rig's periodic snapshot work), so they are environmental rather than flight cost and the full geometry ships — the documented fallbacks were exercised for evidence (dropping the 26 micro-cracks left the profile identical, so the drop was reverted) and arc occupancy was never touched. (23xd)
**Why**: Removing the UI is what makes the crack read as real; the fallback is only ~90 % as good but never stutters.
**Rejected**: Choosing the overlay up front without measuring — it gives up the effect's best quality on an unverified fear.
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

### e2e opts back into motion explicitly
**Decision**: `screen-break.spec.ts` uses `test.use({ contextOptions: { reducedMotion: "no-preference" } })` for the mount test and the default config (`reducedMotion: "reduce"`) for the never-mounts test.
**Why**: `playwright.config.ts` sets `reducedMotion: "reduce"` globally, so the egg's own gate would hide it from every default-context test — the same opt-back-in five existing specs use.
**Rejected**: Disabling the gate under a test flag — the gate is the feature's accessibility contract and must be what the test exercises.
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

### A one-shot event layer, not a 17th flair
**Decision**: The eggs are a viewport-scoped, one-shot layer mounted at the app root — not another entry in the row-scoped flair catalogue. What carries over from `FlairOverlay` is the *discipline*: `aria-hidden`, `pointer-events: none`, per-frame writes limited to transforms/opacity/filter/SVG attributes, one rAF loop, and a reduced-motion posture of never mounting (no static fallback — a non-animating crack reads as a broken UI).
**Why**: Flairs are row-scoped, persistent, CSS-only, keyed by a tmux option — the wrong shape for a 12 s viewport event. The eggs are motion-only, so under `prefers-reduced-motion: reduce` they simply do not exist — the same hide-entirely posture the flairs take.
**Rejected**: A 17th flair keyed by `@rk_win_flair`/`@rk_ses_flair` — flairs are ambient and persistent; the eggs are one-shot and viewport-scoped, and a tmux option is persistent state that would leave the egg "on".
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

### Triggers are derived transitions, never a pushed channel
**Decision**: Both automatic occasions are previous→next comparisons on data the frontend already has (the viewed window's `prState`; the UpdateChip's `showChip`/`key`), fired once per event identity stored per viewer in localStorage. There is no daily cap.
**Why**: A trigger file under `$XDG_STATE_HOME/run-kit/` would be a hand-rolled event queue with a watcher and a consume-once contract — exactly what Constitution II (no state store) and X (hooks carry only the underivable) exist to prevent. A daily cap misfires in the wrong direction: two merges in a day both deserve the fist.
**Rejected**: A trigger file under `$XDG_STATE_HOME/run-kit/`; an `rk tab smash` CLI one-shot (no ephemeral event channel exists — flairs are persistent state and would leave the egg "on"); a Konami code on the terminal (the keys go to the tmux pane); a daily cap.
*Introduced by*: 260915-kp2l-screen-break-easter-eggs

### Variant C — glass realism plus dead-pixel lines, no ink
**Decision**: The crack realism ships as tapered/branching glass geometry with a dead-pixel line layer; ink blobs and tongues (liquid-crystal bleed) are not part of the design.
**Why**: The coloured lines carry the "my actual monitor" beat with zero legibility cost; ink is nearly invisible on dark themes and blots terminal text on light ones.
**Rejected**: Glass + ink, and glass + ink + lines — occlusion of the terminal during a celebration; glass only — too playful to read as damage.
*Introduced by*: 260916-23xd-screen-break-crack-realism

### The shipped hole and shards stay
**Decision**: The hole is the 2n-vertex jagged `holePts` rule and the shards are the sector polygons; a reference-photo rework (organic lobed hole, ~90-chip pulverized ring, 36 hairline radials, glass dust) is rejected.
**Why**: The rework was tried side by side and judged "looks worse"; the hole and shards are the parts of the event layer that already read well.
**Rejected**: The organic spline hole with a chip ring — denser, ~500 SVG nodes, and visually worse in context.
*Introduced by*: 260916-23xd-screen-break-crack-realism

### Per-stroke timing windows over a global draw-in
**Decision**: Every stroke record carries `{start, dur, ease, s0, s1}`; the layer evaluates each stroke's own window per frame.
**Why**: This is what lets primaries travel slowly (ease-in-out over 1.4–2.2 s) while branches, arcs and lines keep arriving for seconds afterwards — the web visibly creeps in — with one rAF loop and no timers.
**Rejected**: A single global draw-in curve — everything would still snap in together, only later.
*Introduced by*: 260916-23xd-screen-break-crack-realism

### Stroke width as a presentation attribute, not a class
**Decision**: Each crack `<path>` carries its own `stroke-width` attribute; the CSS crack rules set colour and caps only.
**Why**: Taper is per piece (three widths per primary, two per branch), and a CSS `stroke-width` declaration would override every attribute regardless of specificity.
**Rejected**: One class per width bucket — five classes for a value the record already carries.
*Introduced by*: 260916-23xd-screen-break-crack-realism

### Shard kinematics without a horizontal stretch
**Decision**: Shards fly on `translate(dir·speed·sp + (0, 420·sp²))` with no horizontal scaling factor.
**Why**: The shards were already approved as-is, and the crack-realism study's own comparison table lists them as unchanged; a stretch factor from the study's mock is an undocumented artefact and would be a one-constant change if ever wanted.
**Rejected**: Adopting the mock's 1.3× horizontal factor silently.
*Introduced by*: 260916-23xd-screen-break-crack-realism

### A per-instance registry key, not a per-viewer preference
**Decision**: The off switch for the automatic occasions is the `easter_eggs` key in the `internal/settings` registry (bool, default `true`, behavior category, ui + live), stored in `config.yaml` and exposed as a General → This host row in the settings dialog.
**Why**: "Someone finds it distracting" is a property of the box, and Constitution IV allows exactly one registry-driven settings surface — only registry keys get a row there.
**Rejected**: A localStorage toggle — invisible in Settings and per browser.
*Introduced by*: 260916-hn6s-easter-eggs-setting

### Palette fires bypass the enabled gate
**Decision**: Only the automatic occasions are gated; `Easter egg: Smash`/`Peek` keep firing while the setting is off because they already pass `force: true`.
**Why**: Typing "Easter egg" into the palette is explicit intent, and the force-bypass design already treats `force` as "skip the automatic-occasion bookkeeping" — the enabled gate is one more piece of that bookkeeping. Keeping the entries also keeps the palette the complete action registry (Constitution V).
**Rejected**: Hiding the palette entries when off — changes the palette registry and its e2e counts for no benefit.
*Introduced by*: 260916-hn6s-easter-eggs-setting

### Disabled fires write no identity
**Decision**: A gated non-force fire returns `false` before the identity block; nothing is consumed.
**Why**: Triggers fire only on observed previous→next transitions (the first observation of a merged window never fires; the peek chip fires on `showChip` going true or a key change), so a merge that happened while eggs were off is never replayed later and nothing needs consuming to prevent it — the gate is a pure early return.
**Rejected**: Recording the identity anyway — it would silently eat a future automatic occasion that never showed.
*Introduced by*: 260916-hn6s-easter-eggs-setting

### Dismiss by clicking the creature, not the layer
**Decision**: The fist or eye is the layer's only click target; a single click calls `dismiss()` and the frame loop compresses the remaining timeline into a ~1.4 s heal that resumes on the retreat curve at the sprite's current emerge amount.
**Why**: The layer must stay pointer-transparent so the app keeps working under the cracks for the 12 s flight; a click that lands on the creature is unambiguous intent, and a fast heal reads as the egg leaving rather than a glitch.
**Rejected**: A double click (a zoom gesture on touch, and it doubles the intercepted input for no gain); a whole-layer click target (it would swallow 12 s of clicks); Escape (keys belong to the tmux pane, and swallowing Escape hurts vim users); an instant cut on click (reads as a glitch).
*Introduced by*: 260916-hn6s-easter-eggs-setting

### One mount GET plus a write-side seam hook, no SSE
**Decision**: `ScreenBreakController` seeds the store with one `getSettingsEntries()` at mount (missing key or rejected fetch ⇒ enabled); the settings seam's `easter_eggs` commit case mirrors the committed value into the store after its POST; other browsers pick the flip up on reload.
**Why**: Mirrors the theme context's mount-fetch posture (`deduplicatedFetch` shares a concurrent settings-dialog fetch); an SSE event for a rarely flipped cosmetic key is surface without payoff.
**Rejected**: A `setInterval` re-read (client-polling anti-pattern); a `POST /api/settings` side effect broadcasting the key.
*Introduced by*: 260916-hn6s-easter-eggs-setting
