# Intake: Screen-break Easter eggs phase 2 — realistic cracks, dead-pixel lines, and a slow 12 s flight

**Change**: 260916-23xd-screen-break-crack-realism
**Created**: 2026-09-16

## Origin

Conversational — a `/fab-discuss` session on 2026-09-16 following the shipped phase-1 eggs (260915-kp2l-screen-break-easter-eggs, PR #985), dispatched promptless via `/fab-proceed`. The user's raw ask:

> The easter eggs are a great hit. Now for the 2nd phase - make the cracks look real - as if my actual monitor cracked. Make it grow more slowly than it does now - so we see it for much longer.

Four candidates were mocked in one self-contained page (A glass only, B glass + ink, C glass + dead-pixel lines, D glass + ink + lines), plus a slow 12 s pacing, plus a reference-photo rework of the hole. Decisions made with the user, in order:

1. **Variant C — glass realism + dead-pixel lines — is chosen.** The user: "C yes. My recommendation too." **Ink (liquid-crystal bleed blobs and tongues) is rejected and must NOT ship** — it is the weaker cue on dark themes and blots out terminal text on light themes. The mock keeps ink behind an off-by-default toggle for comparison only; the port drops it entirely.
2. **The 12 s flight from the mock is approved** ("The speed is better"). The user explicitly wants the start slow so the cracks stay visible much longer.
3. **A reference-photo rework — an organic lobed hole, a bright pulverized ring of ~90 glass chips, 36 hairline radials, glass dust — was tried and REJECTED by the user as "looks worse".** The shipped crack geometry is kept: the 18-vertex jagged hole and the sector shards are UNCHANGED. This is recorded in the study and in memory as a rejected alternative.
4. The two global palette entries (`Easter egg: Smash`, `Easter egg: Peek`) stay and keep working exactly as today. Triggers, store gates, and both sprites are unchanged. The `peek` egg rides the new geometry and timeline.
5. A separate follow-up change adds an `easter_eggs` settings-registry bool (default true). That setting is **out of scope** here and is mentioned only as the follow-up in the study's decisions section.

The approved mock is the spec: its `buildBreak` (generator), `Breaker` (rendering) and `Screen.apply` (timeline) are the exact code to port, and its numbers are authoritative. It lives at `/tmp/claude-1001/-home-sahil-code-sahil87-run-kit-worktrees-molten-cheetah/6a18a7b2-5b1a-446c-a819-3d867d54a4ec/scratchpad/crack-realism-mock.html` during this session and is copied verbatim into `docs/wiki/screen-break-crack-realism-studies.html` by this change (see § Docs), so downstream stages read it from the repo.

## Why

**The pain point.** Phase 1 proved the mechanism — a real evenodd hole in the app glass, shards, a creature — but its crack *drawing* is a diagram of a break, not a break: nine evenly spaced radials of uniform 2.4 px width that all run to the edge, two complete concentric rings, and the whole web drawn in under a second. Real tempered-glass and LCD breaks have uneven radials that taper and sometimes stop mid-pane, branches forking off the radials, partial arcs stitching neighbours rather than full rings, a crushed frosted zone hugging the impact, and — on a monitor — dead-pixel rows and columns shooting from crack tips to the screen edge. And the whole 4.2 s flight is over before the viewer has taken the crack in.

**The consequence of not doing it.** The eggs are the product's one celebratory moment (the fist on a merged PR) and its one "something new is here" beat (the eye on an update). A crack that reads as a sticker undercuts both, and a 4.2 s flight means most viewers catch only the shards and the creature, never the crack itself.

**Why this approach.** Everything stays SVG strokes and transforms on a handful of elements — no pixel capture, no backdrop-filter refraction — so the realism comes purely from better geometry (uneven, tapered, branching, partial) and better pacing (every stroke carries its own `{start, dur}` window on the flight so the web *creeps in over seconds* instead of snapping in). The dead-pixel lines are the one new layer, and they are what makes it read as *a monitor* cracking rather than a pane of glass: bright magenta/cyan/green lines that pop in instantly and flicker. The hole and shards — the parts the user already likes — are untouched; the reference-photo rework that touched them was rejected. The slow flight keeps the shipped beats (flash, hole, shards, creature, heal) in the same order at 12 s.

## What Changes

### 1. Geometry — `app/frontend/src/lib/screen-break-geometry.ts`

A pure, DOM-free port of the mock's `buildBreak`. The **determinism contract is kept**: fixed seed 7, one LCG stream (`s = (s·1664525 + 1013904223) >>> 0`), identical `{W, H, P, R}` ⇒ byte-identical output, unit-tested. Only the impact point varies per run. The public helpers `clamp`/`smooth`/`easeOut`/`easeIn`, `normalizeHole`, `holePathAt`, `pickImpact`, `radiusFor` are unchanged.

**Signature.** `buildBreak({ W, H, P, R, seed = 7 })` — the `n` and `rings` parameters are removed (`n` is now seed-derived; the two full rings are replaced by partial arcs). The return shape becomes:

```ts
export type BreakStroke = {
  d: string;      // SVG path data, px space
  w: number;      // dark core stroke width, px
  lw: number;     // white highlight stroke width, px
  start: number;  // fraction of the flight at which this crack starts drawing
  dur: number;    // fraction of the flight the whole crack takes to draw
  s0: number;     // this piece's fractional span of its parent crack …
  s1: number;     // … so tapered pieces draw sequentially as ONE crack
  ease: "smooth" | "out";
};

export type BreakLine = {
  x1: number; y1: number; x2: number; y2: number;
  color: string;  // one of the LCD palette below
  w: number;      // 1 (hairline) or 2–4 (band)
  op: number;     // .9 (hairline) or .45 (band)
  start: number;  // fraction of the flight; pops in instantly
  flick: number;  // flicker phase, 0–100
};

export type BreakGeometry = {
  P: BreakPoint; R: number; W: number; H: number;
  n: number;                 // primaries = shards, 8–10
  strokes: BreakStroke[];    // primaries (3 pieces each) + branches + sub-branches + arcs + micro-cracks
  lines: BreakLine[];        // dead-pixel lines, 5–8
  shards: BreakShard[];      // n sector shards (unchanged shape)
  holePts: (h: number) => BreakPoint[];
};
```

**Generation order (the LCG stream is consumed in exactly this order — reordering changes every pattern):**

1. `maxD` = farthest viewport corner from P + 80. `inView(p)` = `p.x > −40 && p.x < W + 40 && p.y > −40 && p.y < H + 40`. Helpers `at(crack, r)` (point at radial distance `r`, linear interpolation, carries `r`), `dirAt(crack, r)` (local heading of the segment containing `r`; last segment's heading past the end), and the random walk `walk(from, a, len, [stepBase, stepRand], drift, kink)`: repeat while `r < len`: `r += stepBase + rand·stepRand; a += (rand − 0.5)·drift; if rand < 0.1 then a += (rand − 0.5)·kink;` push the point advanced by `(r − prev.r)` along `a`.
2. **Primaries.** `n = 8 + floor(rand·3)` (8–10). `base = rand·2π`. Angles `base + i·2π/n + (rand − 0.5)·0.9·(2π/n)` (jitter ±0.45 of the even spacing), sorted ascending. For each angle: `full = rand < 0.65`; `len = full ? maxD : maxD·(0.3 + rand·0.4)` (~65 % run past the viewport, ~35 % stop at 0.3–0.7 of `maxD`); `pts = walk(P, a0, len, [16, 30], 0.22, 0.6)` (step 16–46 px, drift ±0.11 rad, 10 % chance of a ±0.3 rad kink); then every point's `r` is recomputed as its true distance from P (`hypot`). Record `{ pts, len: lastPt.r, j: 0.82 + rand·0.36, k: 0.5 + rand·0.25, start: 0.025 + rand·0.05, dur: 0.12 + rand·0.06 }`. Each primary is emitted as **three tapered pieces** split at 30 % / 62 % of its polyline `r` (`split(pts, [0.3, 0.62])`: walk the points, close a piece when `pts[i].r ≥ total·cut`, the closing point starts the next piece): core widths `[3.0, 1.9, 1.0]`, highlight widths `[1.1, 0.8, 0.5]`, `ease: "smooth"` (ease-in-out — the "cracks travel slowly" beat), each piece carrying the primary's `start`/`dur` and its `s0`/`s1` = cumulative fractional span (`(seg.last.r − seg.first.r) / total`).
3. **Branches.** For each primary (depth 0): `nb = 1 + floor(rand·3)` (1–3). For each: `startR = max(1.25·R, parentLen·(0.25 + rand·0.5))`; skip if `startR ≥ 0.9·parentLen`; `p0 = at(parent, startR)`; skip if `!inView(p0)`; `side = rand < 0.5 ? −1 : 1`; `a = dirAt(parent, startR) + side·(0.35 + rand·0.5)`; `remaining = parentLen − startR`; `blen = max(28, remaining·(0.15 + rand·0.35))`; `pts = walk(p0, a, blen, [12, 22], 0.25, 0.5)`; `start = 0.17 + rand·0.35`; `dur = 0.06 + rand·0.12`; emit two tapered pieces (`split` at 45 %) with core `[1.5, 0.8]`, highlight `[0.6, 0.4]`, `ease: "out"`. If the branch tip is `inView` and farther than `1.4·R` from P, push `{ x, y, start: start + dur }` onto `tips` (the dead-pixel line sources). Then recurse once (depth 1) on the branch: `nb = rand < 0.35 ? 1 : 0`; same rules except `blen = max(28, remaining·(0.3 + rand·0.3))`, `start = parent.start + 0.6·parent.dur + rand·0.1`, core `[0.9, 0.5]`, highlight `[0.4, 0.3]`; depth-1 tips are also collected; no depth 2. **Note** the skip via `continue` inside the `for b` loop still counts toward `nb` (a skipped branch is not retried).
4. **Partial arcs** (replace the two full rings). For each multiplier in `[1.35, 2.1, 3.2, 4.6, 6.5]`, `rr = mult·R`; for each `i` in `0..n−1`: `if rand > 0.5 continue` (~50 % occupancy); `c1 = primaries[i]`, `c2 = primaries[(i+1) % n]`; `r1 = rr·(0.92 + rand·0.16)`, `r2 = rr·(0.92 + rand·0.16)`; skip if `c1.len < r1 || c2.len < r2`; `v1 = at(c1, r1)`, `v2 = at(c2, r2)`; skip if neither is `inView`; angles `a1`, `a2` from P (`a2 += 2π` if `a2 < a1`); `m = 3 + floor(rand·3)` intermediate steps: for `k = 1..m−1`, `f = k/m`, `a = a1 + (a2 − a1)·f`, `r = (r1 + (r2 − r1)·f)·(0.95 + rand·0.1)`; one stroke `{ d, w: 1.0 − 0.06·mult, lw: 0.5, start: 0.17 + rand·0.4, dur: 0.04 + rand·0.08, s0: 0, s1: 1, ease: "out" }`.
5. **Crushed zone.** 26 micro-cracks: `a = rand·2π`, `r0 = R·(1.02 + rand·0.4)`, `l = 5 + rand·12`, direction `d = rand·2π`; a two-point path from `(P + r0∠a)` of length `l` along `d`; `{ w: 0.8, lw: 0.4, start: 0.01 + rand·0.06, dur: 0.04, s0: 0, s1: 1, ease: "out" }`. The frost disc is not geometry — it is rendered by the layer (§ 2) from `P`/`R`.
6. **Hole and shards — the shipped rule, keyed to the new primaries.** `holePts(h)`: `Rt = max(R·h, 0.02)`; for each `i`, `v1 = at(primaries[i], Rt·j_i)`, `v2 = at(primaries[i+1], Rt·j_{i+1})`, mid-angle vertex at `Rt·k_i` — 2n vertices (16–20, was fixed 18). Shards: for each `i`, polygon `[at(c, 0.2R), hole[2i], hole[2i+1], hole[2i+2 mod 2n], at(c2, 0.24R)]`, centroid, unit `dir`, `speed = 90 + rand·170`, `spin = (rand − 0.5)·520` — `n` shards (8–10, was 9). Shard kinematics in the layer are the shipped ones (see § 2).
7. **Dead-pixel lines (the LCD layer).** `COLORS = ['#ff3ad6', '#ff3ad6', '#35e8ff', '#35e8ff', '#62ff6a', '#ffffff', '#ffd23d']`. `sources = tips.length ≥ 5 ? tips : [...tips, ...primaries.map(c => ({ ...at(c, min(0.7·c.len, 2.5·R)), start: 0.2 }))]`. `nl = 5 + floor(rand·4)` (5–8). Loop `i < nl` while sources remain: splice a random source; if `!inView(s)` retry (`i--`, break when sources are exhausted); `vertical = rand < 0.6`, `full = rand < 0.5`, `band = rand < 0.3`; `x = clamp(s.x, 0, W)`, `y = clamp(s.y, 0, H)`; vertical: `x1 = x2 = x`, full ⇒ `y1 = 0, y2 = H`, else from the source to the far edge (`s.y < P.y` ⇒ `y1 = 0, y2 = y`; else `y1 = y, y2 = H`); horizontal mirrors this on x. `{ color: COLORS[floor(rand·7)], w: band ? 2 + rand·2 : 1, op: band ? 0.45 : 0.9, start: max(0.17, min(0.55, (s.start ?? 0.2) + rand·0.1)), flick: rand·100 }`. Every line endpoint lies inside `[0, W] × [0, H]` by construction.

**Timing envelope (for the unit test):** every stroke has `0 ≤ start`, `dur > 0`, and `start + dur ≤ 1` — the worst case is a sub-branch: `0.52 + 0.6·0.18 + 0.1 + 0.18 = 0.908`. Every line has `start ∈ [0.17, 0.55]`.

**The draw rule each stroke record implies** (implemented in the layer, stated here because `s0`/`s1` exist for it): `p = ease((t − start) / dur)` is the whole crack's progress; `q = clamp((p − s0) / (s1 − s0))` is this piece's share; `stroke-dashoffset = len·(1 − q)`. The three tapered pieces of a primary therefore draw back-to-back as one continuous crack.

### 2. The layer — `app/frontend/src/components/screen-break.tsx`

`FLIGHT_MS` 4200 → **12000**. The per-frame rule becomes (fractions of the flight; seconds in brackets):

```
flash  = t < 0.025 ? 1 − t/0.025 : 0                 (flash opacity = flash·0.7)            [0–0.3 s]
shake  = t < 0.025 ? 1 − t/0.025 : 0                 (glass translate(sin(t·840)·5·shake, cos(t·660)·4·shake) px; "none" after)
hole   = easeOut((t − 0.17)/0.1) · (1 − easeIn((t − 0.76)/0.1))   [opens 2.0–3.2 s, closes 9.1–10.3 s]; ground opacity = min(1, hole·1.6)
sp     = clamp((t − 0.18)/0.25)                        shards; visible once t > 0.17         [2.2–5.2 s]
em     = smooth((t − 0.3)/0.14) · (1 − smooth((t − 0.64)/0.12))   creature: in 3.6–5.3 s, hold, out 7.7–9.1 s
fade   = 1 − clamp((t − 0.87)/0.13)                    cracks svg AND lcd svg opacity          [10.4–12 s]
frost  = 0.9 · easeOut((t − 0.008)/0.045)              frost circle opacity                   [0.1–0.6 s]
per stroke: p = (ease === "smooth" ? smooth : easeOut)((t − start)/dur); q = clamp((p − s0)/(s1 − s0 || 1)); dashoffset = len·(1 − q)  — written to BOTH the dark and the highlight path
per line:   on = t ≥ start; flick = on ? (sin(t·900 + flick) > 0.92 ? 0.55 : 1) : 0; core opacity = on ? op·flick : 0; glow opacity = on ? 0.22·flick : 0
```

- **Shards** keep the shipped kinematics: `translate(dir·speed·sp + (0, 420·sp²)) rotate(spin·sp about centroid)`, opacity `1 − smooth((sp − 0.45)/0.55)` once `t > 0.17` (else 0). The mock's `setShards` multiplies the x component by 1.3; the port does NOT adopt that factor — shards are "unchanged" in both the user discussion and the mock's own comparison table.
- **Fist (`smash`)**: release threshold `em > 0.4`, `scale = (0.1 + 1.15·em)·(R/76)`, `rotate = (1 − em)·−28°`, drop shadow `drop-shadow(0 16·em px 20·em px rgba(0,0,0,.65))` when released, two-slot release — all unchanged; only `em`'s window moved.
- **Eye (`peek`)**: never released, clipped to `#rk-sb-hole` the whole flight, `scale = 0.78·(R/76)`, opacity `hole > 0.02 ? min(1, hole·2) : 0`, pupil-follow and idle drift unchanged. The two **blink centres move into the new hold window: 0.47 and 0.58** (was 0.40 / 0.585), same `±0.03` half-width (`blink(c) = |t − c| < 0.03 ? 1 − |t − c|/0.03 : 0`). Both fall inside `em`'s plateau (0.44–0.64) so the eye is fully open around each blink.
- **Cracks SVG** (`rk-sb-cracks`, above group, clipped by `#rk-sb-appclip`, as today): FIRST child a `<circle class="rk-sb-frost" cx=P.x cy=P.y r=1.5R fill="url(#rk-sb-frost)">` (opacity written per frame), then the dark group `<g class="rk-sb-crack-dark">` and the highlight group `<g class="rk-sb-crack-lite" transform="translate(0.7 0.7)">` (was 0.8 0.8). Each stroke record renders ONE `<path d=… stroke-width=w>` in the dark group and ONE `<path d=… stroke-width=lw>` in the highlight group — the per-piece width is written on the element, not by a class. The `<defs>` gains `<radialGradient id="rk-sb-frost" gradientUnits="userSpaceOnUse" cx=P.x cy=P.y r=1.5R>` with stops `offset=0.6 stop-color="rgba(255,255,255,0.16)"` and `offset=1 stop-color="rgba(255,255,255,0)"`. `getTotalLength()` per path at mount (jsdom fallback 1 as today) seeds `stroke-dasharray = len` / `stroke-dashoffset = len`. The `ringDs` render path and the `rk-sb-ring` class go away.
- **New LCD SVG** `<svg class="rk-sb-lcd" viewBox="0 0 W H" preserveAspectRatio="none" style={{ clipPath: "url(#rk-sb-appclip)" }}>` in the **above group, rendered BEFORE (below) the cracks SVG**, holding one `<g class="rk-sb-lines">` with, per line, a glow `<line … stroke=color stroke-width=(w + 2.5)>` then a core `<line … stroke=color stroke-width=w>`, both starting at `opacity: 0`; per frame the layer writes only the two opacities. Line colour is an inline `stroke` attribute (per line), so no theme variant is needed for the LCD layer — dead pixels are emissive in both themes.
- **Fade** writes the same `fade` opacity to both the cracks SVG and the LCD SVG.
- Everything else — the two fixed groups, the glass mutations (`clipPath`, `transform`, `position` when static, `zIndex`) and their clearing on finish/unmount, the ground glow per egg, the passive `pointermove` listener for the eye only, `finish()` at `t ≥ 1`, `key={flight.startedAt}` remount, `ScreenBreakController` — unchanged. Still one rAF loop, no timers, `aria-hidden`, `pointer-events: none`, per-frame writes limited to opacity/transform/filter/SVG attributes.

### 3. CSS — `app/frontend/src/globals.css` § Screen break

- `.rk-sb-crack-dark path` / `.rk-sb-crack-lite path`: **remove the `stroke-width` declarations** (a CSS rule beats an SVG presentation attribute regardless of specificity, so the per-piece `stroke-width` attributes only take effect if no class rule sets the property). Keep `fill: none`, colours, round caps/joins. Highlight stroke `rgba(255,255,255,.55)` → `rgba(255,255,255,.62)` (the mock's value).
- Light theme: `html[data-theme="light"] .rk-sb-crack-dark path { stroke: #1f2937; }` (drop its `stroke-width: 2`), `html[data-theme="light"] .rk-sb-crack-lite path { stroke: rgba(255,255,255,.95); }`. Shards' light variant unchanged.
- **Remove** `.rk-sb-crack-dark path.rk-sb-ring { … }`.
- **Add** `.rk-sb-lcd` to the `.rk-sb-cracks, .rk-sb-shards` positioning rule (absolute, inset 0, 100 %, overflow visible) and `.rk-sb-lcd line { stroke-linecap: butt; }`. The frost circle needs no static rule (fill via the gradient URL attribute; opacity inline).
- The block's header comment updates its layer list (LCD SVG below the cracks) and its flight length; the reduced-motion posture (never mounts, no CSS gate) is unchanged.

### 4. Tests

- `app/frontend/src/lib/screen-break-geometry.test.ts` — rewrite for the new shape (fixture `{ W: 1280, H: 800, P: { x: 640, y: 400 }, R: 134 }`, no `rings`): determinism (two builds serialize identically, including `holePts(0/0.5/1)`); `n ∈ [8, 10]` and `shards.length === n` and `holePts(1).length === 2n`; exactly three `ease: "smooth"` pieces per primary (`3n` smooth strokes) whose `s0`/`s1` chain from 0 to 1 per primary; every stroke `start ≥ 0`, `dur > 0`, `start + dur ≤ 1`, `w > 0`, `lw > 0`; `lines.length ∈ [5, 8]` with every endpoint inside `[0, W] × [0, H]` and `start ∈ [0.17, 0.55]` and `color ∈ COLORS`; shard `dir` unit, `speed ∈ [90, 260]`, `|spin| ≤ 260`; `normalizeHole`/`holePathAt`/`pickImpact`/`radiusFor` cases kept (the hole vertex count assertion becomes `2n`).
- `app/frontend/src/components/screen-break.test.tsx` — keep every existing case, retimed to 12 s: "reaches t = 1" steps to `startedAt + 12100`; the fist-released / eye-clipped probes step to `startedAt + 6000` (t = 0.5, inside `em`'s plateau); add: the LCD svg (`.rk-sb-lcd`) mounts with `2 × lines.length` `<line>` children; the cracks svg carries the frost `<circle>` and a `radialGradient#rk-sb-frost` in defs; every crack `<path>` carries a `stroke-width` attribute; cleanup still clears the glass on finish and on mid-flight unmount.
- `app/frontend/tests/e2e/screen-break.spec.ts` — the mount test's detach assertion becomes `toHaveCount(0, { timeout: 15_000 })` (12 s flight + margin) with `test.setTimeout(30_000)` at the top of the test body (the config's per-test default is 10 s locally / 30 s on CI — the existing idiom in `boards-pin-flow.spec.ts` and `code-surface.spec.ts`); its JSDoc `Proves:`/`Steps:` update to "the ~12 s flight" and "detaches within 15 s" (Test Intent Comments rule — no PR numbers or change IDs). The reduced-motion never-mounts test is unchanged.
- Gates: `just test-frontend` (the full Vitest run, not a scoped file list) and `just test-e2e screen-break.spec` (single spec).

### 5. Performance gate

Re-measure with the phase-1 recipe — headless Chromium via the worktree's Playwright, 1280×800, a route with a full-width terminal tile, frame times sampled over the whole 12 s flight (a `requestAnimationFrame` delta logger injected before firing `Easter egg: Smash` from the palette) — against the **32 ms** threshold. The element count rises from ~60 to ~150, with per-frame dash-offset writes on ~120 paths (two per stroke record) plus ~16 line opacities. If any frame exceeds 32 ms: first drop the 26 micro-cracks (step 5 of the generator — keep the frost disc), re-measure; if still failing, halve the arc occupancy (`rand > 0.5` → `rand > 0.75`), re-measure. Record the measured numbers (frame count, median, p95, max) and the branch taken in the memory's Design Decisions either way (hydrate writes them from apply's result notes).

### 6. Docs

- **New** `docs/wiki/screen-break-crack-realism-studies.html`: the approved mock copied **verbatim** (retitled `<title>Screen Break Crack Realism Studies</title>` / `<h1>`), with one short `<h2>4. Decisions</h2>` section appended before the closing script: C chosen 2026-09-16 (glass realism + dead-pixel lines); ink rejected (weaker cue on dark themes, blots terminal text on light); the reference-photo rework (organic lobed hole + pulverized chip ring + 36 hairline radials + glass dust) tried and rejected as "looks worse" — the shipped 18-vertex hole and sector shards stay; 12 s pacing approved; the `easter_eggs` settings-registry bool (default true) deferred to a follow-up change. The mock's ink toggle stays in the page as the comparison artefact it is.
- `docs/specs/index.md` § Wiki: one new row for the page, modelled on the existing `Screen Break Easter Egg Studies` row.
- `docs/wiki/screen-break-easter-egg-studies.html` § 7: one pointer line after the table — "Phase 2 (crack realism, dead-pixel lines, 12 s flight): see `screen-break-crack-realism-studies.html`."
- `docs/memory/run-kit/ui/screen-break-eggs.md` is **rewritten at hydrate** (frontmatter description, § Seeded geometry, § The 4.2 s timeline → 12 s, § Layer stack, § Tests, plus Design Decisions for variant C / ink rejected / reference-photo rework rejected / 12 s pacing / shard kinematics kept / the measured performance numbers). Apply does not touch memory.

### Out of scope

The `easter_eggs` registry setting (a follow-up change); any change to the triggers hook, the store and its gates (reduced motion never mounts, < 640 px no-op, in-flight drop, once-per-identity), the palette entries, the sprites, the mobile gate or the reduced-motion posture; ink / LCD bleed; pixel capture or `backdrop-filter` refraction; the mock's 1.3× horizontal shard stretch.

### Constraints

Constitution V (the palette is the chord — no new shortcut); the flair discipline (`aria-hidden`, `pointer-events: none`, one rAF loop, per-frame writes limited to transforms/opacity/filter/SVG attributes, no timers); Test Intent Comments for the e2e spec; no comment narration citing PR numbers or change IDs in code; tests through `just` recipes only.

## Affected Memory

- `run-kit/ui/screen-break-eggs`: (modify) new seeded geometry (8–10 tapered branching primaries, partial arcs, crushed zone + frost, 5–8 dead-pixel lines), the 12 s timeline, the LCD SVG in the layer stack, the retimed tests, and Design Decisions for variant C, the rejected ink and reference-photo rework, the kept shard kinematics, and the re-measured performance gate

## Impact

- `app/frontend/src/lib/screen-break-geometry.ts` — generator rewrite (new return shape; `n`/`rings` params removed)
- `app/frontend/src/lib/screen-break-geometry.test.ts` — rewritten assertions
- `app/frontend/src/components/screen-break.tsx` — `FLIGHT_MS`, timeline, per-stroke draw rule, frost circle + gradient, LCD SVG, blink centres
- `app/frontend/src/components/screen-break.test.tsx` — retimed steps, LCD/frost/stroke-width probes
- `app/frontend/src/globals.css` § Screen break — stroke-width removal, `.rk-sb-lcd`, ring rule removal, highlight alpha
- `app/frontend/tests/e2e/screen-break.spec.ts` — 15 s detach window + `test.setTimeout(30_000)` + intent comment
- `docs/wiki/screen-break-crack-realism-studies.html` (new), `docs/wiki/screen-break-easter-egg-studies.html` (§ 7 pointer), `docs/specs/index.md` (Wiki row)
- Untouched: `screen-break-store.ts`, `use-screen-break-triggers.ts`, `screen-break-sprites.tsx`, `lib/palette/easter-eggs.ts`, `app.tsx`, backend
- Runtime: ~150 SVG elements for 12 s per flight; one-time `getTotalLength()` over ~120 paths at mount

## Open Questions

- None blocking. The performance re-measure decides between the full geometry and the two documented fallbacks (drop micro-cracks, then halve arc occupancy); the outcome is recorded, not asked.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Variant C (glass realism + dead-pixel lines) ships; ink blobs/tongues are dropped from the port entirely | Discussed — user chose C ("C yes. My recommendation too.") and rejected ink as weaker on dark / text-blotting on light | S:100 R:70 A:100 D:100 |
| 2 | Certain | The 12 s flight (`FLIGHT_MS = 12000`) with the mock's fraction table | Discussed — user approved the mock's pacing ("The speed is better") and asked for a slow start | S:100 R:90 A:100 D:100 |
| 3 | Certain | The shipped hole rule (2n-vertex jagged `holePts`) and sector shards are kept; the reference-photo rework (organic lobed hole, pulverized chip ring, 36 hairlines, dust) is a recorded rejected alternative | Discussed — user rejected the rework as "looks worse" | S:100 R:80 A:100 D:100 |
| 4 | Certain | The mock's `buildBreak` / `Breaker` / `Screen.apply` numbers are the spec; the generator consumes the LCG stream in the mock's order | Dispatch instruction: "treat its numbers as the spec"; the intake reproduces them in full | S:100 R:85 A:100 D:100 |
| 5 | Certain | Triggers, store gates, palette entries, sprites, mobile gate and reduced-motion posture are unchanged; the `easter_eggs` setting is a separate follow-up | Discussed — explicit scope boundary from the user session | S:100 R:90 A:100 D:100 |
| 6 | Certain | Performance fallback ladder: drop the 26 micro-cracks first, then halve arc occupancy; numbers recorded in memory either way | Given verbatim in the discussion synthesis | S:95 R:90 A:95 D:95 |
| 7 | Confident | Shard kinematics keep the shipped rule (no 1.3× horizontal factor from the mock's `setShards`) | Description states shards "unchanged" twice and the mock's own comparison table lists hole/shards as unchanged; the factor is a one-constant reversal if wanted | S:60 R:95 A:70 D:65 |
| 8 | Certain | Eye blink centres move to 0.47 and 0.58 (±0.03) | Both fall inside `em`'s plateau (0.44–0.64); the discussion offered these as the example values | S:70 R:95 A:90 D:80 |
| 9 | Certain | `buildBreak` drops the `n` and `rings` parameters and `crackDs`/`ringDs`; returns `{ n, strokes, lines, shards, holePts }` | The mock's generator derives `n` from the seed and has no rings; the layer is the only consumer and is rewritten in the same change | S:75 R:80 A:90 D:80 |
| 10 | Certain | Crack CSS rules drop `stroke-width` so per-piece `stroke-width` attributes take effect; the light-theme dark rule drops its `stroke-width: 2` | CSS rules override SVG presentation attributes; the mock's CSS sets no stroke-width on crack paths for this reason | S:70 R:95 A:95 D:90 |
| 11 | Certain | The e2e mount test uses `test.setTimeout(30_000)` and a 15 s detach window | `playwright.config.ts` per-test default is 10 s locally; nine existing specs use `test.setTimeout` for long flows | S:80 R:95 A:95 D:90 |
| 12 | Certain | LCD lines get no light-theme colour variant; the frost gradient/circle needs no static CSS beyond positioning | Dead pixels are emissive in both themes (the mock's Light-app toggle shows the same lines); fill/opacity are attribute/inline writes | S:65 R:95 A:85 D:80 |
| 13 | Certain | The lines count contract (5–8) is asserted on the fixed unit fixture; the generator may emit fewer than 5 only when in-view sources are exhausted (n primaries always add ≥ 8 fallback sources) | Mock behaviour reproduced; the edge case is documented rather than padded with synthetic sources, which would change the approved look | S:70 R:90 A:85 D:75 |
| 14 | Certain | Memory rewrite is hydrate's job; apply touches only the wiki page, the § 7 pointer, and the specs-index row | Pipeline contract (`_pipeline` hydrate owns `docs/memory/`) | S:95 R:95 A:100 D:100 |

14 assumptions (13 certain, 1 confident, 0 tentative, 0 unresolved).
