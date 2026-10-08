# Intake: Screen-break Easter eggs — the screen cracks open and something comes out of the monitor

**Change**: 260915-kp2l-screen-break-easter-eggs
**Created**: 2026-09-15

## Origin

Conversational. The idea was explored live with the user over a design study that already exists as an untracked file (`docs/wiki/screen-break-easter-egg-studies.html`, 52 KB, self-contained — the mock IS the mechanism, not a picture of it). Every product decision below was taken in that conversation; this intake was created by `/fab-proceed`'s promptless dispatch, so nothing was asked again — the decisions are encoded as Certain/Confident assumptions citing the discussion, and any residual choice is recorded rather than asked.

> **Title idea**: Screen-break Easter eggs — the run-kit screen cracks open and something comes out of the monitor. Two full-page one-shot eggs: a green fist on PR merged, an eye on update available.
>
> **What it is.** A new one-shot, whole-viewport "event" layer (NOT a 17th row flair — flairs are row-scoped, ambient, persistent CSS overlays keyed by `@rk_win_flair`/`@rk_ses_flair`; this is viewport-scoped, ~4.2 s, then gone). A single `<ScreenBreak />` component mounted once at the app-shell root (sibling of the toast layer), rendered only while an egg is in flight and unmounted at the end. It owns: a fixed dark "inside the monitor" ground with a radial glow at the impact point in the creature's color; a cracks `<svg>`; a shards `<svg>`; the creature sprite; and an SVG `<defs>` with two `<clipPath clipPathUnits="objectBoundingBox">` elements. The app shell itself receives only an inline `style.clipPath` (the evenodd hole) and a short shake transform. Discipline copied from `FlairOverlay`: `aria-hidden`, `pointer-events: none`, transforms/opacity/SVG-attribute updates only, one `requestAnimationFrame` loop for the flight, no other JS timers. Under `prefers-reduced-motion` (use the existing `prefersReducedMotion()` helper in `app/frontend/src/lib/motion.ts` that `logo-spinner.tsx` uses) the layer NEVER mounts — no static fallback frame (a non-animating crack reads as a broken UI). No sound. No pixel capture (no html2canvas): the hole is real because the shell is clipped; the shards are glass-tinted polygons, not UI copies.
>
> **Mechanism** (the design study is the reference; the change MUST commit it and add its row to the `## Wiki` table of `docs/specs/index.md` following the existing row pattern — "Self-contained; open in a browser"). Layer stack top→bottom: (6) shards svg; (5) creature once released (in front of the app, with a drop shadow); (4) cracks svg, clipped by the same evenodd path as the app so no cracks draw inside the hole; (3) the app shell = the glass, `clip-path: url(#appclip)` whose single path is the outer rect `M0 0H1V1H0Z` plus the hole polygon with `clip-rule="evenodd"`, plus the 160 ms shake; (2) creature while inside, clipped to the hole-only clipPath; (1) inside ground. The released creature must ALSO move above the shell in stacking order (z-index), not merely lose its clip — this was a bug found while building the study. Geometry is generated from ONE impact point with a seeded LCG (fixed seed; vary the impact point per run, not the seed): 9 radial crack polylines from the impact point to past the viewport edge (step 24–64 px, angular jitter ±0.14 rad), two jittered ring cracks at ~1.7R and ~2.7R, a jagged hole polygon of 18 vertices (alternating crack-vertex at R·j, j∈[0.82,1.18], and mid-angle vertex at R·k, k∈[0.5,0.75]), and 9 glass shards = sectors between adjacent cracks from 0.2R to the final hole. Cracks draw in via `stroke-dasharray = length`, `stroke-dashoffset = length·(1−progress)`, a dark 2.4 px stroke plus a 0.9 px white stroke offset (0.8, 0.8). Shards per frame: translate along the radial × speed(90–260 px), plus gravity 420·s², plus spin (±260°), fading after half the flight. Hole radius R ≈ 76 px at a 720 px-wide design frame — scale proportionally with the viewport (≈10.5 % of viewport width). Timeline (t∈[0,1] over 4.2 s): flash `t<0.05`; shake `t<0.16`; crack progress `easeOut(t/0.2)`, rings `easeOut((t−0.05)/0.22)`; hole open `easeOut((t−0.05)/0.15)·(1−easeIn((t−0.76)/0.16))`; shards `clamp((t−0.07)/0.45)`; emerge `smooth((t−0.22)/0.3)·(1−smooth((t−0.6)/0.2))`; cracks fade `1−clamp((t−0.88)/0.12)`. Impact point: random per run within the central region of the viewport (the study used the terminal area).
>
> **The two eggs (user decision).**
> 1. **Green fist** — SVG sprite (~12 shapes: rounded fist body, four curled fingers with knuckle highlights, thumb, wrist), an allusion to the Hulk without a face or name (same IP posture as the existing `spidey`/`ironman` flairs). Punches out toward the viewer: scale `0.1 + 1.15·em`, rotate `(1−em)·−28°`, released in front when `em > 0.4`. Occasion: a sidebar PR flips to **merged** for the window the user is viewing. Palette entry: `Easter egg: Smash`.
> 2. **The eye** — SVG sprite (~8 shapes: sclera ellipse, a few red veins, iris with radial gradient in the instance accent blue, pupil, highlight). Never released — stays clipped to the hole the whole time, fills the hole (scale so the sclera is ~1.5× the hole), blinks twice (scaleY dips at t≈0.40 and t≈0.585), and the pupil follows the pointer (offset clamped to ±22 px x / ±14 px y, drifting sinusoidally when there is no pointer). Occasion: the UpdateChip transitions from **no update** to **update available**. Palette entry: `Easter egg: Peek`.
> The **brand cube** variant (the nine `logo-spinner.tsx` polygons tumbling out) is PARKED — not built. The **row-scale micro version** (shatter a sidebar row on Ctrl+click force kill) is explicitly NOT built — user decision: go directly to the full-page eggs.
>
> **Triggers (user decisions).**
> - Both automatic occasions are **derived transitions detected client-side** on data the frontend already receives over SSE (previous→next state comparison). No backend change, no new `rk` verb, no new API route, no tmux option, no trigger file. Rejected: a trigger file under `$XDG_STATE_HOME/run-kit/` (a hand-rolled event queue — Constitution II/X), an `rk tab smash` CLI one-shot (no ephemeral event channel exists; flairs are persistent state), a Konami code on the terminal (keys go to the tmux pane).
> - Automatic triggers fire **once per event identity**, stored per viewer in `localStorage`: the PR number for the fist, the version string for the eye. No daily cap (it would misfire: two merges in a day both deserve the fist). A page reload with the UpdateChip already showing must NOT fire (the stored version makes it idempotent; "update available" is a state, the trigger is the transition into it).
> - **Palette entries are never rate limited** (an explicit action that silently does nothing reads as a bug). Two entries, one per egg (they are different eggs). Every user-facing action must be in the palette (Constitution V) — the palette IS the chord; no separate keyboard chord.
> - **Re-entrancy guard**: a trigger arriving while an egg is in flight is dropped, not queued (covers palette spamming and two PRs merging seconds apart). One mount, one in-flight flag.
> - Mobile/coarse: skip the eggs below 640 px viewport width (the shards need room to fall) — the study's lean; treat as Confident.
> - Theme: the inside-the-monitor ground is dark in both light and dark themes (study default) — Confident.
>
> **Known risk to verify during apply.** `clip-path` on the element that contains the xterm canvases may force the terminals to repaint every frame. Fallback if it stutters: clip a fixed dark "glass" overlay drawn above the shell instead of the shell itself (the hole then reveals the ground rather than removing the UI); the shake and shards still sell it. Decide by measuring on the real app, prefer the shell clip.
>
> **Testing expectations.** Vitest: the trigger reducer/hook (transition detection for PR merged and update-available, once-per-key persistence in localStorage, reload-with-chip-showing does not fire, in-flight drop), palette registration of both entries, `prefersReducedMotion` → no mount, seeded geometry determinism (same impact point ⇒ same paths). Playwright e2e (`just test-e2e <name>.spec`, single spec): palette entry mounts the overlay (`data-testid`) and it unmounts after the flight; with `reducedMotion: 'reduce'` emulation nothing mounts. Adding palette entries may change the exact palette-entry-count assertion in `app/frontend/tests/e2e/operator-compose.spec.ts` — run that spec. Every new Playwright `test()` needs the Proves/Steps JSDoc intent comment per the constitution. Frontend gate is the full `just test-frontend`, not a scoped run.

**Intake-time verification of the brief's pointers** (read, not guessed):

- `docs/wiki/screen-break-easter-egg-studies.html` exists, untracked, `<title>Screen Break Easter Egg Studies</title>`. Its § 6 trigger table and § 7 decisions match the brief. Its **Decision 7 ("Build the row-scale version first") and the cube variant are superseded by the live conversation** — not built / parked. The study's own open-questions list (light-theme ground tone, mobile skip, cube landing beat) is closed by the decisions in this intake.
- `app/frontend/src/lib/motion.ts` exports `prefersReducedMotion()` (matchMedia-guarded for jsdom); used by `logo-spinner.tsx`, `top-bar.tsx`, `typed-label.tsx`, `quake-terminal.tsx`.
- `app/frontend/src/components/flair-overlay.tsx` — the discipline reference (`aria-hidden`, `pointer-events-none`, transforms on child spans only); `globals.css § Flair overlays` (line ~625) documents the row-transform ban and the reduced-motion gate (line ~1929 block, "motion-only … hidden entirely").
- PR state reaches the frontend as `WindowInfo.prState?: "open" | "merged" | "closed"` plus `prNumber?: number` (`app/frontend/src/types.ts` ~L200–212), attached by the SSE hub for change-bound windows; consumers: `components/pr-status-model.ts`, `sidebar/registers.ts`, `sidebar/icons.tsx`, `lib/palette/selection.ts`.
- Update state: `SessionContext.updateAvailable: UpdateAvailable | null` (`{ tools, key, current, latest }`, from server-global `event: update-available`) and the derived `useUpdateNotification()` hook (`contexts/session-context.tsx` ~L1421) returning `showChip`, `key`, `latest`, … — the exact boolean the UpdateChip renders from (`top-bar-overflow-menu.tsx`, `top-bar.tsx`). The dismiss feature already persists a per-version identity in localStorage (`runkit-update-dismissed`, keyed by `key`).
- Palette: `PaletteAction { id, label, description?, shortcut?, onSelect, … }` (`components/command-palette.tsx` L31); global entries are composed in `hooks/use-global-palette-actions.ts` from pure builders in `lib/palette/*.ts` (pattern: `lib/palette/version.ts`); existing unit test `hooks/use-global-palette-actions.test.tsx`.
- Root mount: `RootWrapper` in `app/frontend/src/app.tsx` (~L302) nests `ThemeProvider > ToastProvider > … > SessionProvider > … > <Outlet />`; the toast viewport is `fixed bottom-4 right-4 z-50 pointer-events-none` (`components/toast.tsx` L72).
- **Correction to the brief**: the `operator-compose.spec.ts` count assertion is `getByRole("option", { name: /^Operator:/ })` → `toHaveCount(6)` (L236) — it is prefix-scoped to `Operator:`; `Easter egg:` labels do not match it. The spec still runs as a gate (Assumption #12) but is not expected to need a change.
- localStorage key convention is `runkit-<feature>-<thing>` (40 existing keys, e.g. `runkit-update-dismissed`, `runkit-terminal-font-size`).

## Why

**The pain point.** run-kit's only decorative channel today is the flair catalogue — sixteen row-scoped, ambient, always-on treatments. There is no *moment* in the UI: nothing celebrates a PR merging, nothing greets a new release beyond the UpdateChip quietly lighting. Both events are the two "good news" transitions the dashboard already receives over SSE, and both currently pass with a glyph recoloring. The user wants the product to have a personality beat — a one-shot egg where the screen physically cracks open and something inside the monitor reacts — and wants it done without adding state, verbs, routes, or a backend channel.

**What happens if we don't build it.** Nothing breaks; the product stays sober. The cost is the missed easter-egg culture the flairs started (nyan, pacman, spidey, ironman, nemo…) never getting a full-page counterpart, and the design study (a complete, working mechanism) rotting untracked in the worktree instead of being committed as a wiki page like every other study.

**Why this approach over the alternatives** (all decided in the discussion):

- **A new one-shot event layer, not a 17th flair.** Flairs are row-scoped, persistent, CSS-only, keyed by a tmux option — the wrong shape for a 4.2 s viewport event. What carries over is the *discipline* (aria-hidden, pointer-events none, transforms/opacity only, reduced-motion gate), not the mount or the catalogue.
- **Client-side derived transitions, not a pushed event.** Both occasions are previous→next comparisons on data the frontend already has (`prState` on the viewed window; the UpdateChip's shown state). A trigger file under `$XDG_STATE_HOME/run-kit/` would be a hand-rolled event queue with a watcher and a consume-once contract — exactly what Constitution II (no state store) and X (hooks carry only the underivable) exist to prevent. An `rk tab smash` one-shot has no ephemeral channel to ride (flair options are persistent state and would leave the egg "on"). A Konami code on the terminal competes with xterm for keys. The palette is the chord.
- **A real evenodd clip on the shell, not a drawn hole.** A hole painted on top of an intact UI reads as a sticker; removing the UI is what makes it "cracked open". Pixel capture (html2canvas) is out — CSP, cost, the xterm canvases — so the shards are glass-tinted polygons, which keeps the whole thing at ~30 DOM nodes.
- **Seeded geometry from one impact point.** Reproducible frames make a storyboard, a screenshot, and a determinism unit test possible. The impact point is the only input that varies.
- **Once per event identity, palette never limited, in-flight drops.** A daily cap misfires in the wrong direction (two merges in a day both deserve the fist); a palette action that silently no-ops reads as a bug; a queue would replay two eggs back-to-back after a burst of merges.
- **Reduced motion never mounts.** A static crack frame is indistinguishable from a broken UI; the eggs are motion-only, so under `prefers-reduced-motion: reduce` they simply do not exist — the same posture the flairs take (hidden entirely).

## What Changes

### Change area 1 — the `<ScreenBreak />` event layer (new component)

A single component, mounted **once** at the app root (`RootWrapper` in `app/frontend/src/app.tsx`, inside `SessionProvider` so its trigger hook can read session/update state, as a sibling of the routed `<Outlet />` content — never per-route, never inside `.app-shell`). It renders **nothing** while idle. While an egg is in flight it renders:

| Layer (top→bottom) | Element | Clip | Notes |
|---|---|---|---|
| 6 | shards `<svg>` | none, `overflow: visible` | nine glass polygons cut from the final hole (sectors between adjacent cracks, 0.2R → hole edge) |
| 5 | creature, **released** | none | fist only; `filter: drop-shadow(0 16·em px 20·em px rgba(0,0,0,.65))`; **must also rise above the shell in z-order** (the study bug: losing the clip alone is not enough) |
| 4 | cracks `<svg>` | the app's evenodd path (`url(#appclip)`) | no cracks render inside the hole |
| 3 | **the app shell** (the glass) | `clip-path: url(#appclip)` | the shell also carries the 160 ms shake transform; layers 1–2 do not shake ("behind the monitor") |
| 2 | creature, **inside** | hole-only path (`url(#hole)`) | only what shows through the opening renders |
| 1 | inside ground | none | `position: fixed; inset: 0`, dark ground with a radial glow at the impact point in the creature's color; opacity rides the hole's open amount |

**Stacking requirement**: ground and inside-creature stack *below* the shell; cracks, released creature and shards stack *above* it; everything stays below the toast viewport (`z-50`). The ScreenBreak layer therefore renders two fixed fragments around the shell (a below group and an above group) — apply picks the concrete `z-index` values and, if needed, gives the shell element a positioned stacking level only while in flight.

**The shell element** receives exactly two inline mutations while in flight — `style.clipPath = "url(#appclip)"` and the shake `style.transform` — both **removed on finish and on unmount** (route change, provider unmount, or a `prefers-reduced-motion` flip mid-flight all clean up). The element is the persistent layout element that contains top bar + sidebar + terminal/board content and does NOT contain the ScreenBreak layer or the toast viewport — apply locates it (the `--app-height` consumer in `AppLayout`, or the route's `.app-shell`, whichever satisfies the containment rule) and exposes it through a ref/id, not a DOM query by class.

**`<defs>`** inside the layer holds two `<clipPath clipPathUnits="objectBoundingBox">`:
- `#appclip` — one `<path clip-rule="evenodd" d="M0 0H1V1H0Z {hole}">` (outer rect + hole polygon, normalized 0–1)
- `#hole` — `<path d="{hole}">`
The hole polygon string is written **once per frame** and used by both paths. Ids must be unique per page (only one mount exists, so fixed ids are acceptable; a suffix is fine if apply prefers).

**Discipline** (copied from `FlairOverlay`): `aria-hidden="true"`, `pointer-events: none` on every layer, updates are transforms / opacity / SVG attribute+style updates only (no layout properties), one `requestAnimationFrame` loop drives the whole 4.2 s (`t = clamp((now − start) / 4200, 0, 1)`), no `setTimeout`/`setInterval`. On `t ≥ 1` the loop stops, the shell mutations are cleared, and the component returns to its idle (null) render. **No sound.**

**Impact point**: chosen at fire time, uniformly random inside the central region of the viewport — the box `x ∈ [0.25·W, 0.75·W]`, `y ∈ [0.25·H, 0.75·H]` (`W = window.innerWidth`, `H = window.innerHeight`). The seed is fixed; only the impact point varies per run.

**Hole radius**: `R = clamp(0.105·W, 64, 160)` px (the study used R = 76 at a 720 px design frame ≈ 10.5 %). Sprites scale by `R / 76` on top of their own emerge scale so proportions hold at any viewport.

**Viewport resize mid-flight**: geometry is generated once in px at fire time and normalized; the two SVGs use `viewBox="0 0 W H"` + `preserveAspectRatio="none"`, so a resize stretches the frame slightly rather than regenerating. Acceptable — no regeneration.

### Change area 2 — seeded geometry (pure module)

A dependency-free module (e.g. `app/frontend/src/lib/screen-break-geometry.ts`) porting the study's `buildBreak` verbatim in shape:

```ts
// LCG: s = (s * 1664525 + 1013904223) >>> 0; next = s / 2^32
export function buildBreak(input: { W: number; H: number; P: { x: number; y: number }; R: number; n?: 9; seed?: 7 }): {
  P; R; W; H;
  holeD: string;        // 18-vertex jagged polygon (px), alternating crack-vertex at R·j (j∈[0.82,1.18]) and mid-angle vertex at R·k (k∈[0.5,0.75])
  crackDs: string[];    // 9 radial polylines from P past the viewport edge; step 24–64 px, angular jitter ±0.14 rad
  ringDs: string[];     // 2 jittered ring cracks at ~1.7R and ~2.7R (per-vertex radius factor 0.88–1.12, angle jitter ±0.075 rad)
  shards: { points: string; cx; cy; dir: {x,y}; speed: number /* 90–260 px */; spin: number /* ±260° */ }[]; // 9 sectors
};
```

Plus a `normalizeHole(holeD, W, H)` helper producing the 0–1 path string for the `objectBoundingBox` clip paths. **Determinism contract**: identical `{W,H,P,R}` ⇒ byte-identical output (the unit test).

### Change area 3 — the render timeline (per frame, `t ∈ [0,1]`)

```
easeOut(x) = 1 − (1 − clamp(x))³      easeIn(x) = clamp(x)³      smooth(x) = c·c·(3 − 2c), c = clamp(x)
flash      = t < 0.05  (a brief full-viewport white/creature-tint flash, opacity fades to 0 by 0.05)
shake      = t < 0.16  (shell transform: small ±px jitter decaying over the 160 ms; 0 after)
cracks     = easeOut(t / 0.2)               → stroke-dashoffset = len · (1 − cracks) on the 9 radial polylines
rings      = easeOut((t − 0.05) / 0.22)     → same on the 2 ring paths
hole       = easeOut((t − 0.05) / 0.15) · (1 − easeIn((t − 0.76) / 0.16))   → hole polygon scaled about P by `hole`; ground opacity rides it
shards     = clamp((t − 0.07) / 0.45)       → per shard: translate(dir · speed · s + (0, 420 · s²)) rotate(spin · s); opacity = s > 0 ? 1 − smooth((s − 0.45) / 0.55) : 0
em         = smooth((t − 0.22) / 0.3) · (1 − smooth((t − 0.6) / 0.2))       → the creature's emerge amount
cracksFade = 1 − clamp((t − 0.88) / 0.12)   → cracks svg opacity
```

Cracks render as two stacked path sets per geometry string: a dark 2.4 px stroke (rings 1.6 px, opacity .8) and a 0.9 px white highlight stroke translated by (0.8, 0.8). Shard fill/stroke: `rgba(226,232,255,.22)` / `rgba(255,255,255,.65)` at 0.8 px (the study's light-app variant `rgba(255,255,255,.75)` / `rgba(30,41,59,.55)` may be used under the light theme; the ground stays dark in both themes — Assumption #10).

### Change area 4 — the two eggs (sprites + per-egg update)

Both sprites are original inline SVG (no external assets, no copyrighted likeness — the same IP posture as `spidey`/`ironman`: an allusion, not a name or face). The study's SVG markup (its `FIST` and `EYE` constants) is the reference and may be ported as-is.

**`smash` — the green fist.** `viewBox 0 0 200 200`, ~12 shapes: wrist ellipse (`#1f7a3c`), rounded fist body (`#3fb950`, rx 28), four curled fingers (`#4ade80`, rx 13) with knuckle highlight ellipses (`#86efac`) and crease strokes (`#14532d`), a rotated thumb, a palm crease. Per frame:

```
s        = (0.1 + 1.15 · em) · (R / 76)
rotate   = (1 − em) · −28°
released = em > 0.4          // swap clip hole → none AND move to the above-shell group (layer 5)
opacity  = (hole > 0.02 || released) && em > 0 ? 1 : 0
filter   = released ? drop-shadow(0 16·em px 20·em px rgba(0,0,0,.65)) : none
glow     = rgba(34,197,94,.3)   // the ground's radial glow color
```

**`peek` — the eye.** `viewBox 0 0 200 200`, ~8 shapes: sclera ellipse (`#e9e4d4`, rx 96 ry 60), four red vein paths (`#c0392b`, .55 opacity), iris circle r 36 with a radial gradient in the **instance accent blue** (`#9dbcff → #5b8af0 → #1e3a8a` in the study; apply should read the accent from the instance-accent CSS variable where the palette allows, falling back to the study's stops), pupil r 16 (`#050508`), highlight r 5.5. Never released — clipped to `#hole` for the whole flight, stays in the below-shell group. Per frame:

```
blink(c) = |t − c| < 0.03 ? 1 − |t − c| / 0.03 : 0 ;  b = max(blink(0.40), blink(0.585))
scale    = 0.78 · (R / 76)   with scaleY(1 − b)          // sclera ≈ 1.5× the hole
look     = pointer ? { x: clamp((px − P.x) / 260, −1, 1) · 22, y: clamp((py − P.y) / 180, −1, 1) · 14 }
                   : { x: sin(t · 9) · 16, y: cos(t · 6) · 8 }     // pupil <g transform="translate(look)">
opacity  = hole > 0.02 ? min(1, hole · 2) : 0
glow     = rgba(192,132,252,.25)
```

The pointer position comes from a passive `pointermove` listener on `window` registered only while the eye is in flight (removed on finish) — the one permitted event listener; it writes a ref, never state.

### Change area 5 — triggers (client-side derived transitions)

A trigger hook (e.g. `useScreenBreakTriggers()`) lives with the ScreenBreak controller and reads only data the frontend already has. It exposes an imperative `fire(egg: "smash" | "peek", opts?: { force?: boolean })` through a tiny module-level store/context so the palette can call it from anywhere.

**Shared rules**
- **Re-entrancy**: one in-flight flag; `fire()` while in flight returns without queuing (palette spam and back-to-back merges both drop).
- **Reduced motion**: `fire()` is a no-op when `prefersReducedMotion()` is true — the layer never mounts, nothing is stored.
- **Viewport floor**: `fire()` is a no-op when `window.innerWidth < 640`.
- **Once per identity** (automatic triggers only): identity is persisted per viewer in localStorage — `runkit-egg-smash` holds the last-fired PR number as a string, `runkit-egg-peek` the last-fired update identity. An identity equal to the stored value never fires again. `force: true` (palette) bypasses the identity check and does not write it. Storage access is try/catch-wrapped (private mode); absence degrades to "fire".
- **First observation is not a transition**: a state seen for the first time in this tab (previous value `undefined`) never counts as a flip for the fist; the eye's first observation IS its arrival (see below — the identity guard is what makes reload idempotent, per the user's stated mechanism).

**`smash` — PR merged for the viewed window.** Source: the viewed window's `WindowInfo` (route `$window` param on the terminal route → the window entry the sidebar renders from `SessionContext`). Watch `prState` for that window: a flip from an observed non-`merged` value (`"open"` or `"closed"`) to `"merged"` with a defined `prNumber` fires `fire("smash")` with identity `String(prNumber)`. Switching windows resets the observed-previous (a window first seen as `merged` never fires). Not on board/host/server routes (there is no viewed window).

**`peek` — the UpdateChip lights.** Source: `useUpdateNotification()` — the exact boolean the chip renders from. Watch `showChip`: a flip `false → true`, or a `key` change while `true`, fires `fire("peek")` with identity `key` (falling back to `latest` when `key` is null). A reload with the chip already showing observes the same `key` as stored → no fire. A later release (new `key`) fires again once. Any route.

### Change area 6 — palette entries

Two global entries (available on every route), built by a pure builder module (`app/frontend/src/lib/palette/easter-eggs.ts`, following `lib/palette/version.ts`) and composed into `hooks/use-global-palette-actions.ts`:

| id | label | onSelect |
|---|---|---|
| `easter-egg-smash` | `Easter egg: Smash` | `fire("smash", { force: true })` |
| `easter-egg-peek` | `Easter egg: Peek` | `fire("peek", { force: true })` |

Never rate limited; the only silent no-ops are the two environmental gates (reduced motion, viewport < 640 px) and the in-flight drop. No keyboard chord — the palette is the chord (Constitution V). Optional `description` text may hint at the occasion ("the screen cracks open").

### Change area 7 — the design study becomes a wiki page

- `git add docs/wiki/screen-break-easter-egg-studies.html` — committed **byte-for-byte as it stands** (it is the design record, including its now-superseded Decision 7 and the parked cube).
- `docs/specs/index.md` `## Wiki` table gains one row in the existing pattern, e.g.:

```markdown
| [Screen Break Easter Egg Studies](../wiki/screen-break-easter-egg-studies.html) | Design study for the one-shot, whole-viewport screen-break Easter eggs (260915 discussion) — the live crack → shatter → emerge → heal mock (seeded geometry from one impact point, a real evenodd `clip-path` hole on the app shell, nine glass shards under gravity, the six-layer stack), the three candidates (green fist on PR merged · the eye on update available · brand cube parked), the six-frame storyboard, the trigger table with rejected channels (trigger file, `rk tab smash`, Konami code), and the recorded decisions. The § 5 row-scale sidebar version was NOT built (user decision: straight to the full-page eggs) and the study's "build row-scale first" row is superseded. Self-contained; open in a browser |
```

### Change area 8 — tests

**Vitest** (colocated `*.test.ts(x)`):
- geometry: `buildBreak` determinism (same input ⇒ deep-equal output), 9 cracks / 2 rings / 9 shards / 18 hole vertices, every crack polyline ends outside the `W×H` box.
- triggers: `open → merged` on the viewed window fires once with identity; `undefined → merged` does not; same identity twice does not (localStorage); window switch resets previous; `showChip false → true` fires with `key`; reload-with-chip-showing (stored key) does not; new key fires; in-flight second `fire()` is dropped; `force` bypasses identity and does not write it; reduced motion ⇒ no mount, no write; `innerWidth < 640` ⇒ no mount.
- palette: both entries registered with the exact labels/ids; selecting calls `fire` with `force`.
- component: mounts `data-testid="screen-break"` on fire, clears the shell's `clipPath`/`transform` on finish and on unmount.

**Playwright** (`app/frontend/tests/e2e/screen-break.spec.ts`, run as `just test-e2e screen-break.spec`): (1) palette → `Easter egg: Smash` mounts `[data-testid="screen-break"]`, and it detaches within ~6 s; (2) with `reducedMotion: "reduce"` emulation the same action mounts nothing. File header + Proves/Steps JSDoc per the constitution. Also run `just test-e2e operator-compose.spec` — its `/^Operator:/` count is not expected to move (Assumption #12); fix only if it fails.

**Gates**: full `just test-frontend` (never scoped), `tsc --noEmit`, the two single e2e specs above, `just build`.

### Change area 9 — the apply-time performance decision (shell clip vs overlay clip)

Measure on the real app with at least one full-width terminal tile (and ideally a two-tile layout): fire `Easter egg: Smash` and watch frame timing (DevTools Performance / `requestAnimationFrame` deltas) for the 4.2 s. **Prefer the shell clip.** If the shell clip visibly stutters (sustained frames > 32 ms attributable to xterm canvas repaints), switch to the documented fallback: a fixed dark "glass" overlay drawn above the shell receives the evenodd clip instead of the shell (the hole then reveals the ground *through the overlay* rather than removing the UI); shake and shards are unchanged. Record the measurement and the decision in the plan's Design Decisions so hydrate can lift it into memory.

## Affected Memory

- `run-kit/ui/screen-break-eggs`: (new) The one-shot whole-viewport event layer — `<ScreenBreak />` mount + layer stack + the shell clip contract, seeded geometry module, the 4.2 s timeline, the two eggs (smash/peek) with their occasions and identities, the trigger rules (derived transitions, once-per-identity localStorage keys `runkit-egg-smash`/`runkit-egg-peek`, in-flight drop, reduced-motion never-mount, 640 px floor), the palette entries, the shell-clip vs overlay-clip performance verdict, and the rejected channels.
- `run-kit/ui/keyboard-and-palette`: (modify) Add the `Easter egg:` pair (`Easter egg: Smash`, `Easter egg: Peek`) to the palette action registry inventory (global entries, no chord).
- `run-kit/ui/updates-and-notifications`: (modify) One pointer under § Update Notification: the UpdateChip's `showChip false → true` transition (identity `key`) feeds the Peek egg — see `ui/screen-break-eggs`.
- `run-kit/ui/status-signals`: (modify) One pointer under § PR Status: the viewed window's `prState` open → merged flip feeds the Smash egg — see `ui/screen-break-eggs`.
- `run-kit/ui/visual-design`: (modify) Motion vocabulary: beside the row-scoped flairs, a viewport-scoped one-shot event layer with the same discipline and a never-mount reduced-motion posture — pointer to `ui/screen-break-eggs`.

## Impact

**Frontend only** (`app/frontend/`). No Go, no API, no tmux option, no `rk` verb, no settings key, no route.

- New: `src/components/screen-break.tsx` (layer + controller), `src/lib/screen-break-geometry.ts`, `src/lib/screen-break-store.ts` (or context; the `fire` seam + in-flight flag), `src/hooks/use-screen-break-triggers.ts`, `src/lib/palette/easter-eggs.ts`, their `*.test.ts(x)`, `tests/e2e/screen-break.spec.ts`.
- Modified: `src/app.tsx` (mount in `RootWrapper`; shell element ref/id), `src/hooks/use-global-palette-actions.ts` (compose the two entries), possibly `src/globals.css` (a small `§ Screen break` block for the fixed layers; keep transforms inline), `docs/specs/index.md` (wiki row).
- Committed as-is: `docs/wiki/screen-break-easter-egg-studies.html`.
- Runtime cost: zero while idle (component renders null; the trigger hook is two cheap comparisons per SSE update). ~30 DOM nodes and one rAF loop for 4.2 s while in flight. Risk: shell `clip-path` forcing xterm repaints — measured at apply (Change area 9).
- Accessibility: `aria-hidden`, `pointer-events: none`, never mounts under reduced motion, no focus changes, no sound.
- Dependencies: none added.

## Open Questions

- None left open by the conversation. Residual implementation choices (identity = `key` for the eye, the 25–75 % impact box, `R = clamp(0.105·W, 64, 160)`, the exact shell element) are recorded below as Confident assumptions so `/fab-clarify` can flip any of them.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | A new one-shot, whole-viewport event layer (`<ScreenBreak />`, mounted once at the app root, null while idle) — NOT a 17th flair and NOT wired to `@rk_*` options | Discussed — user chose the event layer over a flair; flairs are row-scoped/persistent/CSS-only. The discipline (aria-hidden, pointer-events none, transforms/opacity only, one rAF, reduced-motion gate) is copied from `FlairOverlay`, not the mount | S:95 R:80 A:90 D:95 |
| 2 | Certain | Two eggs only: green fist on PR merged (`Easter egg: Smash`) and the eye on update available (`Easter egg: Peek`). Brand cube parked; the row-scale sidebar micro version is NOT built | Discussed — user chose fist + eye, parked the cube, and explicitly skipped the row-scale version ("go directly to the full-page eggs"); supersedes the study's Decision 7 | S:95 R:85 A:90 D:95 |
| 3 | Certain | Both automatic occasions are client-side derived transitions on SSE-delivered state; no backend change, verb, route, tmux option, or trigger file | Discussed — user rejected a `$XDG_STATE_HOME` trigger file (Constitution II/X), `rk tab smash` (no ephemeral channel), and a Konami code (keys go to tmux) | S:95 R:80 A:95 D:95 |
| 4 | Certain | Automatic triggers fire once per event identity, persisted per viewer in localStorage (fist: PR number; eye: the pending update's identity); no daily cap; reload with the chip already showing does not fire | Discussed — user's explicit rule and reasoning ("two merges in a day both deserve the fist"; the stored version makes reload idempotent). Per-viewer state in localStorage is Constitution IV's home for it | S:90 R:90 A:90 D:90 |
| 5 | Certain | Palette entries are never rate limited (bypass identity; only the environmental gates apply); two entries, one per egg; no separate keyboard chord — the palette is the chord | Discussed — user's rule ("an explicit action that silently does nothing reads as a bug"); Constitution V puts every action in the palette | S:95 R:95 A:95 D:95 |
| 6 | Certain | Re-entrancy: a trigger arriving while an egg is in flight is dropped, never queued (one mount, one in-flight flag) | Discussed — covers palette spamming and back-to-back merges; a queue would replay eggs after a burst | S:90 R:95 A:90 D:90 |
| 7 | Certain | Under `prefers-reduced-motion: reduce` the layer never mounts and nothing is stored — no static fallback frame; gate via the existing `prefersReducedMotion()` in `lib/motion.ts` | Discussed — user's rule (a non-animating crack reads as a broken UI); the helper exists and is the pattern `logo-spinner.tsx`/`top-bar.tsx` use; flairs take the same hide-entirely posture in `globals.css` | S:95 R:95 A:95 D:95 |
| 8 | Certain | The hole is a real evenodd `clip-path` on the shell with seeded geometry from one impact point (fixed seed, impact varies); shards are glass polygons; no pixel capture; no sound | Discussed — study Decisions 2/3/4/8, confirmed by the user; the study code is the reference implementation | S:95 R:85 A:90 D:95 |
| 9 | Certain | Skip the eggs entirely below 640 px viewport width (both automatic and palette triggers no-op) | The study's stated lean ("the shards need room to fall"); the user said to treat it as Confident. Trivially adjustable constant | S:70 R:95 A:80 D:75 |
| 10 | Confident | The inside-the-monitor ground is dark in both light and dark themes (study default); shard tint may use the study's light-app variant under the light theme | User said to treat the dark ground as Confident; the study's open question on a warm-grey light ground is closed by that call. One CSS value if revisited | S:65 R:95 A:80 D:70 |
| 11 | Confident | Shell clip is the primary design; apply measures frame timing on the real app with xterm tiles and falls back to clipping a fixed dark glass overlay only on measured stutter (sustained > 32 ms frames), recording the verdict in plan Design Decisions | Discussed — user: "Decide by measuring on the real app, prefer the shell clip"; the fallback is the study's § 4 documented alternative | S:80 R:70 A:75 D:70 |
| 12 | Certain | `operator-compose.spec.ts` is run as a gate but is not expected to change: its count assertion is `getByRole("option", { name: /^Operator:/ })` → 6, prefix-scoped, and `Easter egg:` labels do not match it | Verified by reading the spec (L236) — corrects the brief's expectation that the assertion must move. Running the spec keeps the gate honest | S:85 R:95 A:90 D:85 |
| 13 | Certain | The study HTML is committed byte-for-byte unmodified; its superseded Decision 7 (row-scale first) and the parked cube are noted in the `docs/specs/index.md` wiki row description rather than by editing the study | Every other wiki study is committed as a design record and the index row carries later-state notes (e.g. the Cron Clock row's "superseded" notes); editing a study to match a later call would erase the record | S:70 R:95 A:80 D:70 |
| 14 | Confident | localStorage keys `runkit-egg-smash` / `runkit-egg-peek`, each holding the single last-fired identity string; access try/catch-wrapped, absence degrades to "fire" | Follows the `runkit-<feature>-<thing>` convention (40 existing keys, `runkit-update-dismissed` is the same per-version shape). Merged is terminal per PR and update identities are monotonic, so last-only suffices; a set would be over-engineering | S:60 R:95 A:85 D:65 |
| 15 | Certain | The eye's identity is `useUpdateNotification().key` (falling back to `latest` when null), and the trigger is `showChip false → true` (or a key change while true) — the exact boolean the UpdateChip renders from | The user said "the version string"; `key` is the codebase's canonical per-version identity for exactly this purpose (`runkit-update-dismissed` persists it) and covers multi-tool updates. `showChip` already folds in dev-mode, dismissal and the manual-check feed, so watching it is "the UpdateChip transitions" literally | S:70 R:95 A:85 D:70 |
| 16 | Certain | The eye fires on its first observation of an un-stored identity (including a first-ever load with the chip already lit); the fist requires an observed non-merged → merged flip on the viewed window in this tab (first observation never fires) and only on the terminal route | The user's stated idempotency mechanism for the eye is the stored version (so arrival counts once per release); merged is a terminal state visible forever on old windows, so the fist needs the observed flip or every first visit to a merged window would celebrate. Different data shapes, different rules | S:75 R:90 A:80 D:70 |
| 17 | Confident | Impact point uniform in the central box `x ∈ [0.25W, 0.75W]`, `y ∈ [0.25H, 0.75H]`; `R = clamp(0.105·W, 64, 160)` px; sprites scale by `R/76` on top of their emerge scale | The user specified "random within the central region" and "≈10.5 % of viewport width"; the box and clamp make those concrete without biasing to a tile the layout may not have (board/host routes, multi-tile layouts). Constants, trivially tuned at apply | S:65 R:95 A:80 D:65 |
| 18 | Certain | Geometry lives in a pure, dependency-free TS module (`buildBreak` LCG port of the study) with a determinism unit test; palette entries come from a pure builder in `lib/palette/` composed by `use-global-palette-actions.ts` | Mirrors the established `lib/palette/version.ts`/`update.ts` pure-builder pattern and the project's colocated Vitest convention; the study's decision 4 exists precisely to make this testable | S:80 R:90 A:90 D:85 |
| 19 | Certain | Tests: Vitest for geometry/triggers/palette/component + one Playwright spec `screen-break.spec.ts` (mount on palette action + detach; `reducedMotion: "reduce"` ⇒ nothing) with Proves/Steps JSDoc; gate is the full `just test-frontend` | Project rules (code-quality "MUST include tests", "UI changes SHOULD include Playwright e2e"; constitution Test Intent Comments) and the user's explicit testing expectations; five existing specs already use `reducedMotion` emulation | S:85 R:90 A:90 D:85 |
| 20 | Confident | The shell element that receives the clip/shake is the persistent layout element containing top bar + sidebar + route content, exposed via a ref/id, chosen by apply under the containment rule (must not contain the ScreenBreak layer or the toast viewport) | The brief says "the app shell"; `RootWrapper`/`AppLayout` nesting (app.tsx ~L302) and the per-route `.app-shell` are both candidates and only the containment rule decides — a pointer, per the brief's "do not guess in the intake" | S:70 R:85 A:80 D:70 |

20 assumptions (15 certain, 5 confident, 0 tentative, 0 unresolved).
