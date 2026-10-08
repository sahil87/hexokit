# Intake: Flairs Stay Composited With a Terminal Mounted

**Change**: 260917-cfzm-flair-composited-with-terminal
**Created**: 2026-09-17

## Origin

One-shot `/fab-new` invocation, seeded from the follow-up plan `fab/plans/sahil/26-09-17-idle-cpu-followups.md` § Change 6 (read in full: Standing context, Decisions of record, R6 pre-intake research, § Change 6 tasks). The user's raw input:

> Idle CPU follow-ups — Change 6 (flair-composited-with-terminal): flair overlays stay composited when a terminal is mounted, no per-frame style recalc on a tty route, every flair's look unchanged. Read fab/plans/sahil/26-09-17-idle-cpu-followups.md in full (Standing context, Decisions of record, R6 pre-intake research with its four ranked hypotheses, and § Change 6's tasks) before writing the intake. Depends on change 5 (perf-idle-cpu-renderer-headed, already cherry-picked into this worktree — its renderer-aware instrument is available). Research-first: R6 is this change's first task; the fix follows the winning hypothesis, no fix is prescribed upfront. Lane: full (research phase).

Key decisions carried from the plan's **Decisions of record** (no conversation preceded this invocation; the plan is the discussion):

- **Change 6 is research-first.** The flair animations start composited on both routes (Blink trace: `compositeFailed=0` at start) yet tick the main thread at 60/s whenever an xterm is mounted, with either renderer. The mechanism is unknown; the change's first task finds it with the recalc oracle, and the fix follows the finding — no fix is prescribed here.
- **The instrument must say which xterm renderer it measured** — hence change 5 (`260917-lhr5-perf-idle-cpu-renderer-headed`, merged and cherry-picked into this worktree at `7ad559d3`) is a prerequisite, not a nicety.
- **Selection method unchanged**: measured A/B delta against the 3-point floor.
- **The fallback is a product change.** If no hypothesis composites with a terminal mounted, the fallback is `animation-play-state: paused` on flair overlays while a tty tile is mounted and the row is not hovered. That needs the user's yes before it is built.

Post-plan correction picked up from change 5's hydrate (`docs/memory/run-kit/architecture/testing.md` § Performance probes): on this dev box the full Chromium build in new-headless mode **does** expose software WebGL via SwiftShader, so plain headless tty rows read `xterm-renderer=webgl`; the deliberate DOM-renderer row is `--no-webgl`. The plan's "headed = WebGL, headless = DOM" framing is superseded; the intent (prove the fix on both renderers) stands.

## Why

**The pain.** Change 1 of the first idle-CPU plan (#1003) made every flair animation compositor-only, and it holds on the server page: `/runKit` with 37 flair animations dropped from 15–19% renderer / 1803 recalcs per 30 s to 6% / 297. But the moment a terminal is mounted on the page — any tty route, either xterm renderer — the same flairs tick style recalc at 60/s again:

| Scenario (2026-09-17, live daemon) | Renderer | Main | Recalcs |
|---|---|---|---|
| `/runKit` server page, 37 flair animations | 6.1% | 2.0% | 297 / 30 s |
| `/runKit/@109` tty+code, DOM renderer | 17.2–18.8% | 11.2–11.7% | 1803–1823 / 30 s |
| `/runKit/@109` all flairs paused (inject) | 6.6% | 2.8% | 230 / 30 s |
| `/runKit/@109` `.xterm` removed (inject) | 11.3% | 4.6% | 342 / 30 s |
| xvfb `/runKit/@109` WebGL renderer | 15.6% | 11.2% | 1199 / 20 s |
| xvfb `/runKit/@109` WebGL, flairs paused | 1.7% | 1.0% | 119 / 20 s |
| xvfb `/runKit/@99` single tty, WebGL | 11.5% | 6.9% | 1200 / 20 s |

Change 5's own verification rows (same box, `/rK/@109`, 7 running animations, 10 s samples) show the ticker even at that small animation count: `recalcs=598–617` headless WebGL, `651` headless `--no-webgl` (DOM), `602–610` headed WebGL — versus `70–96` on the server route and on the same tty route with `.xterm` removed.

The terminal route is where a user spends most of the day, so the server-page win is largely theoretical for real usage. With one terminal open, flairs cost ~10 renderer points and ~9 main-thread points of one core, continuously, for decoration.

**What we know is NOT the cause** (measured, so the research does not repeat it): caret blink off, xterm rows hidden, canvas hidden, `contain: strict` on the terminal, terminal blurred (all still ~1800 / 30 s); removing the code iframe (1813 / 30 s); the xterm renderer (ticks on both); container-query units alone (ph9x falsified "cq units block compositing" directly; pausing only nemo leaves the ticker). Removing `.xterm` or pausing every flair kills it. The Blink trace says the flair keyframes report `compositeFailed=0` at start on both `/runKit` and `/runKit/@99`; style-recalc trace events run 107 vs 468 over the same window. **So the demotion happens after start, or the per-frame recalc has another trigger that exists only with a mounted terminal.**

**If we don't fix it.** Every flaired row costs main-thread time on every terminal route, forever; laptop users on battery pay for it; the compositor-only discipline documented in `ui/visual-design.md` (“Flairs must not tick the main thread”) is true only on routes without a terminal, which the memory does not say.

**Why research-first over a prescribed fix.** Four plausible mechanisms remain (below), each with a different fix (layer isolation vs. stopping a style-element rewrite vs. removing a container-unit dependence vs. moving an animated pseudo onto a span). Building the wrong one costs an apply cycle and proves nothing; the recalc oracle plus a Blink trace can discriminate them in an hour. The fallback (pause flairs beside a terminal) changes the product's ambient-motion promise, so it is the last resort and only with the user's consent.

## What Changes

### 1. Research phase — R6, the change's first task (mandatory, recorded in `plan.md`)

Find why composited flairs tick the main thread when an xterm is mounted. Test the four hypotheses **in the plan's rank order**, stopping when one is confirmed, but record a row for every hypothesis tested. Each hypothesis gets a **per-renderer** recalc measurement (WebGL row and DOM row, 30 s each, terminal mounted) plus the trace evidence named below.

**Rig.** The live `:3000` daemon has no flaired servers any more (`runKit` was renamed `rK`; `/rK/@109` runs only 7 animations). Reproduce the flair scenario on a throwaway tmux server, per `architecture/testing.md` § The reproducible flair rig:

```sh
tmux -L rk-perf-flair new-session -d -s perf -n nemo1 -c /tmp 'sleep 100000'
for w in nemo2 aquarium1 aquarium2 cube1; do tmux -L rk-perf-flair new-window -t perf -n $w -c /tmp 'sleep 100000'; done
tmux -L rk-perf-flair set-option -w -t perf:nemo1 @rk_win_flair nemo
tmux -L rk-perf-flair set-option -w -t perf:nemo2 @rk_win_flair nemo
tmux -L rk-perf-flair set-option -w -t perf:aquarium1 @rk_win_flair aquarium
tmux -L rk-perf-flair set-option -w -t perf:aquarium2 @rk_win_flair aquarium
tmux -L rk-perf-flair set-option -w -t perf:cube1 @rk_win_flair cube
```

The daemon lists the server within seconds. The research route is a **tty window on that server** (`/rk-perf-flair/@<N>` — the sidebar rows carry the five flairs and the tile mounts an xterm), the comparator is `/rk-perf-flair` (server page, same rows, no terminal). Pass `--url http://127.0.0.1:3000` explicitly (`rk url` in this worktree reports the worktree's derived port). Kill with `tmux -L rk-perf-flair kill-server` when done. The user's own servers and the `:3000` daemon are **read-only** for measurement.

**Instrument** (change 5's version): `just perf-idle-cpu <path> [seconds] [--headed] [--no-webgl] [--reduced-motion] [--inject <js>] [--then <path>] [--json <file>] [--url <base>]`. Route `--inject` through `scripts/perf-idle-cpu.sh` directly when the JS contains parentheses. One instance at a time. Noise floor ≈ 3 renderer points. Read `recalcs=`, `anims=`, `xterm=`, `xterm-renderer=`; ignore the GPU column under Xvfb.

**Renderer pairing.** WebGL row = plain headless (this box's full Chromium exposes SwiftShader WebGL; confirm `xterm-renderer=webgl` on the row) or `--headed`; DOM row = `--no-webgl` (confirm `xterm-renderer=dom`). A row whose summary carries `xterm=0` is not a terminal measurement and is discarded.

**Hypotheses and the test for each:**

| # | Hypothesis | Test | Evidence to record |
|---|---|---|---|
| 1 | **Late demotion** — the animations composite at start, then lose their layer when the terminal's layers appear (squashing or overlap with the xterm canvas or its `will-change` layers). | Chromium trace via Playwright CDP (`Tracing.start` with categories `blink.animations,disabled-by-default-cc.debug,disabled-by-default-blink.debug.layout`) started **before** navigation and running across the terminal mount (+3 s); read `compositeFailed` / `Animation::` events after mount. Also `LayerTree.enable` + `LayerTree.layerTreeDidChange` snapshots before and after `.xterm` mounts: do the flair child spans still own their own layers? | trace file path, count of flair animations with a non-zero `compositeFailed` after mount, layer ownership before/after, recalcs per 30 s (both renderers) |
| 2 | **A second invalidator, not demotion** — something in xterm's subtree changes style every frame **only while the compositor is animating**, e.g. xterm's dynamic `<style>` elements (`_dimensionsStyleElement`, the theme style) being rewritten, invalidating the document. | `--inject` a `MutationObserver` on `document.head` and on `.xterm` (`{ subtree: true, attributes: true, childList: true, characterData: true }`) that counts mutations for 5 s and stores the total + a histogram by target/attribute on `window.__rkMut`; run once with flairs on and once with the flairs-paused override style (`.rk-flair-nemo *, … { animation-play-state: paused !important }`); read the counter through a second `--inject` or from the JSON. | mutation counts flairs-on vs paused, the mutating node/attribute names, recalcs per 30 s (both renderers) |
| 3 | **`cqw`-dependent keyframes re-resolve when a container changes** — nemo's swim uses `100cqw`; the tty route may resize a container every frame (xterm fit → ResizeObserver → …). | Already measured: pausing only nemo leaves the ticker, so hypothesis 3 alone is not it. Complete it: grep the flair keyframes for every `cq*` consumer (aquarium, cube, warp, scan band), pause exactly those and re-measure; log `ResizeObserver` callbacks on `.rk-flair-*` for 5 s with the terminal mounted. | list of cq-unit consumers, recalcs with those paused, ResizeObserver callback count per 5 s |
| 4 | **Animation on `::before`/`::after` inside a `container-type: size` overlay** while a sibling subtree paints every frame. | Inventory: `grep -n -e "::before" -e "::after" app/frontend/src/globals.css` within the flair block — ph9x moved animations to real spans, so the expected inventory is empty or static-only; for any animated pseudo left, `--inject` a style override that moves the animation onto a real span (or disables the pseudo) and re-measure. | the inventory, recalcs with the pseudo animation disabled |

Record the results as a table in `plan.md` (hypothesis, renderer, recalcs / 30 s terminal mounted, renderer %, evidence pointer, verdict) with the trace files' paths (under the session scratchpad; not committed). The research is complete when one hypothesis explains the ~1500-recalc delta between the server page and the tty route, or all four are eliminated.

If the four hypotheses are all eliminated, widen once: bisect by `--inject` (a) `display: none` on the flair overlays but not the rows, (b) `isolation: isolate` / `contain: paint` / `will-change: transform` on the **tty tile** wrapper, (c) `position: fixed; z-index` shuffling that takes the xterm out of the flair rows' stacking context, and record which, if any, removes the ticker — that is the mechanism even if unnamed.

### 2. Fix — follows the winning hypothesis

One fix, the one the evidence names. Candidates by hypothesis (not a menu; only the winner is built):

- **H1 (late demotion)**: layer isolation so the flair spans and the xterm layers cannot squash or overlap — e.g. `isolation: isolate` / `contain: paint` / `will-change: transform` on the flair overlay, or on the tty tile container, or `z-index` re-ordering so the terminal layer sits below the sidebar's stacking context. Prefer the change on the **flair overlay** (`.rk-flair-*` in `globals.css`, or the overlay `className` in `flair-overlay.tsx`) over the terminal container; touch `terminal-client.tsx` only if the terminal side is the only place it works.
- **H2 (style-element churn)**: stop the per-frame rewrite. If the writer is inside xterm.js, this is an upstream issue — **file it** (repo `xtermjs/xterm.js`, with the MutationObserver evidence and versions) and work around locally: e.g. `contain: style` on the terminal container if it isolates the invalidation, or debouncing the trigger on our side (the fit/resize path in `terminal-client.tsx` ~`:353–365`). No vendoring or patching of `node_modules`.
- **H3 (cq re-resolution)**: remove the container-unit dependence on the affected keyframes — replace `100cqw`/`100cqh` with the `--rk-flair-w`-driven `calc()` form the pixel-art traversals already use (the `ResizeObserver` in `flair-overlay.tsx` maintains it), which is what the plan calls "removing container-unit dependence". The container-units-allowed Design Decision in `ui/visual-design.md` is then revised, not deleted (it was true without a terminal).
- **H4 (animated pseudo)**: move the animated pseudo onto a real child span rendered by `FlairOverlay` (the ph9x pattern; `flair-overlay.tsx` `LAYERS` + `globals.css`), update `flair-overlay.test.tsx` for the new markup.

**Constraints on the fix:**

- **Every flair's look is unchanged**: same geometry, cadence, quantization, colors. No frame-rate reduction, no pausing, no per-row opt-out. If the fix touches a pixel-art traversal, re-check the distinct-color count on that row (ph9x's 7-colors check) so nothing goes bilinear.
- No new route, setting, or settings-surface key (Constitution IV). No `--trace` flag or other instrument change in this change — the research tooling stays ad hoc in the scratchpad.
- No change-ID or PR citations in code comments; comments state the constraint (what the terminal does to the flair layer and why the rule exists).
- Live-daemon etiquette: the `:3000` daemon and the user's tmux servers are read-only. A changed build is measured on this worktree's own rig (`RK_CODE_SERVER_PORT=<spare> just dev`, or the worktree `rk` binary serving `app/frontend/dist` on a spare port per the same-server A/B rig) with BEFORE and AFTER from the **same** build type, or by `--inject`ing the changed CSS over the live page when the fix is CSS-only.

### 3. The fallback — a product change that needs the user's yes

If no hypothesis yields a fix that composites with a terminal mounted, the apply worker **stops** and reports: the R6 table, the eliminated mechanisms, and the proposal — `animation-play-state: paused` on flair overlays while a tty tile is mounted on the page and the row is not hovered (ambient motion then lives on the server page and boards, not beside a terminal). It is **not built** in that run. The change goes back to the user; if they say yes, `/fab-clarify` records the decision and apply resumes with the fallback as the fix (then `ui/visual-design.md` "Flair animation is always-on ambient" gains the terminal-route exception).

### 4. Acceptance (both renderers, recorded in `plan.md`)

On the same rig and build, with the flair scenario above and a tty window of that server:

| Check | Command | Pass |
|---|---|---|
| WebGL row | `scripts/perf-idle-cpu.sh /rk-perf-flair/@<N> 30 --url <rig>` (confirm `xterm-renderer=webgl`; `--headed` if headless lands on `dom`) | `recalcs=` within **200** of the flairs-paused `--inject` run on the same route and build; `renderer=` within **3 points** of it |
| DOM row | same with `--no-webgl` (confirm `xterm-renderer=dom`) | same bounds |
| Flairs still run | `--json` → `## animations` (or `document.getAnimations()` via `--inject`) | every flair animation on the page reports `running`; `anims=` unchanged vs BEFORE |
| Server page | `scripts/perf-idle-cpu.sh /rk-perf-flair 30 --url <rig>` | no regression: `recalcs=` and `renderer=` within noise of BEFORE (≈ 130–300 / 30 s, ≈ 3–6%) |
| Look | paused-`currentTime` screenshot pairs BEFORE/AFTER for each touched flair (ph9x's parity method), plus the distinct-color count on any touched pixel-art row | pixel-identical or the colour count unchanged (7 on nyan) |

BEFORE rows (unfixed build) and AFTER rows go into `plan.md` verbatim, both renderers, plus the flairs-paused comparator for each.

### 5. Tests

- **Vitest**: `app/frontend/src/components/flair-overlay.test.tsx` updated for any markup change in `flair-overlay.tsx` (H4 or H3 span changes); a unit test for any new helper (e.g. a `--rk-flair-w` consumer). If the fix is CSS-only, no new unit test is required, but the existing suite runs.
- **No e2e for motion** (per plan). If the fix touches `terminal-client.tsx`, run the scoped e2e specs that already cover the terminal tile (e.g. `just test-e2e "e2e/terminal-…"` one spec per run), never the full suite as a gate.
- Gates: `cd app/frontend && npx tsc --noEmit`; `just test-frontend` (Vitest); the instrument before/after above.

### 6. Memory and docs (hydrate)

- `docs/memory/run-kit/ui/visual-design.md` § Flair overlays: add the **terminal-route rule** (flairs composite with a terminal mounted; the mechanism found; the guard that keeps it so) as a Design Decision in the four-field shape; revise "Container-query units stay allowed in flair keyframes" only if H3 wins; add the terminal-route exception to "Flair animation is always-on ambient" only if the fallback is built.
- `docs/memory/run-kit/architecture/testing.md` § Performance probes: the sentence "A tty route with flairs on the page ticks at 60/s with either xterm renderer (≈ 600 / 10 s …, 2026-09-17)" becomes history — replace with the post-fix expectation and keep the R6 mechanism as the explanation for why a regression would show up as ≈ 1800 / 30 s on tty routes.
- `docs/memory/run-kit/ui/terminal.md`: only if H2 wins (xterm's style-element churn and the local workaround, plus the upstream issue link).

## Affected Memory

- `run-kit/ui/visual-design`: (modify) § Flair overlays — terminal-route compositing rule + the R6 mechanism as a Design Decision; conditional revisions to the cq-units and always-on decisions per the winning hypothesis / fallback
- `run-kit/architecture/testing`: (modify) § Performance probes — retire the "ticks at 60/s with either renderer" observation; record the post-fix tty-route expectation and the R6 mechanism as the regression signature
- `run-kit/ui/terminal`: (modify, conditional on H2) xterm dynamic style-element churn, the local workaround, the upstream issue

## Impact

- **Frontend**: `app/frontend/src/globals.css` (§ Flair overlays, lines ~730–1900: the `container-type: size` block at ~809, the `--rk-flair-dpr` media block, the per-flair keyframes), `app/frontend/src/components/flair-overlay.tsx` (overlay `className` at :141, `LAYERS`, the shared `ResizeObserver` writing `--rk-flair-w`), `app/frontend/src/components/flair-overlay.test.tsx`; possibly `app/frontend/src/components/terminal-client.tsx` (container at :304–305, fit/resize path ~:353–365, WebglAddon block) if the terminal side is the only place the fix works. Possibly the tty tile wrapper in `surface-layout.tsx` for an isolation rule.
- **Backend**: none.
- **Instrument**: none (consumes change 5's `scripts/perf-idle-cpu.{sh,mjs}` as-is).
- **Upstream**: an xterm.js issue if H2 wins.
- **Dependencies**: `260917-lhr5-perf-idle-cpu-renderer-headed` (merged; cherry-picked here at `7ad559d3`). Independent of change 7 (`server-not-found-render-loop`, file-disjoint).
- **Scale**: research-heavy; the code diff is expected to be small (tens of lines of CSS and/or a markup change in one component), with the evidence and measurements in `plan.md`.

## Open Questions

- **R0 Mac baseline** (user task, non-blocking): `just perf-idle-cpu /<server> 30 --url <rk url>` and `just perf-idle-cpu /<server>/@<tty> 30 --url <rk url>` on the Mac (real WebGL, no xvfb). If the tty line shows recalcs ≈ 300 / 30 s, the ticker is Linux/SwiftShader-specific and this change shrinks to a memory note; ≈ 1800 means it is real on hardware. Paste both summary lines into this intake or `plan.md` when available. Until then the change proceeds as written (the ticker reproduces here on WebGL under Xvfb and on SwiftShader headless, and on the DOM renderer).
- **Fallback consent** — only if R6 eliminates every hypothesis: build `animation-play-state: paused` beside a mounted tty tile? Asked at that moment, not now (see § 3).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Research-first: R6 (four hypotheses in the plan's rank order, per-renderer recalc rows + trace evidence in `plan.md`) is task 1; the fix is whichever the evidence names; nothing is prescribed upfront | Stated verbatim in the user's input and the plan's Decisions of record | S:95 R:85 A:90 D:95 |
| 2 | Certain | Change 5 (`lhr5`) is the prerequisite and is already in this worktree; `xterm-renderer=`, `--headed`, `--no-webgl`, the tty-route guard are consumed as-is; no instrument changes here | Cherry-picked at `7ad559d3`; `scripts/perf-idle-cpu.mjs` carries the flags; plan sequencing 5 → 6 | S:90 R:90 A:95 D:90 |
| 3 | Certain | Acceptance: 30 s samples on the same rig and build; `recalcs=` within 200 of the flairs-paused `--inject` comparator on the same route, `renderer=` within 3 points, every flair still `running`, server page unchanged within noise | Plan § Change 6 task 3, standing-context noise floor and recalc oracle | S:95 R:80 A:90 D:90 |
| 4 | Confident | Renderer pairing: the WebGL row is plain headless (SwiftShader WebGL on this box) or `--headed`; the DOM row is `--no-webgl`; each row's `xterm-renderer=` is checked rather than assumed | Change 5's hydrate corrected the plan's headed-vs-headless framing; the intent (both renderers) is unchanged | S:65 R:90 A:85 D:60 |
| 5 | Confident | Measurement rig: throwaway `rk-perf-flair` tmux server (nemo, nemo, aquarium, aquarium, cube) with a tty window of that server as the route and `/rk-perf-flair` as the comparator; changed builds on the worktree's own dev rig or the worktree `rk` binary on a spare port; `--inject` for CSS-only A/B | Live daemon lost its flaired servers (`/rK/@109` runs 7 animations); the rig is documented in `architecture/testing.md` § The reproducible flair rig | S:70 R:90 A:80 D:70 |
| 6 | Certain | Live-daemon etiquette: the user's `:3000` daemon and tmux servers are read-only for measurement | Plan standing context (from 07pj's intake) | S:90 R:95 A:95 D:95 |
| 7 | Certain | The pause-beside-a-terminal fallback is a product change: if every hypothesis is eliminated, apply stops and reports the proposal; it is never built without the user's explicit yes | Plan R6 closing paragraph and Decisions of record | S:95 R:70 A:90 D:95 |
| 8 | Certain | Non-goals: no new flairs, no flair removal, no ambient-motion setting, no new route or settings key, no instrument flag | Plan § Change 6 non-goals; Constitution IV | S:95 R:90 A:95 D:95 |
| 9 | Certain | Verification: `npx tsc --noEmit`, Vitest for any `flair-overlay.tsx` markup change, scoped e2e only where an existing spec covers a touched surface, never the full suite as a gate; instrument BEFORE/AFTER rows in `plan.md` | Plan standing context "Verification per change"; code-quality.md test rules | S:90 R:90 A:90 D:90 |
| 10 | Confident | Memory targets: `ui/visual-design` § Flair overlays (terminal-route rule + mechanism), `architecture/testing` § Performance probes (retire the 60/s-with-either-renderer sentence), `ui/terminal` only if H2 wins | Plan names the first and third; the testing.md sentence was found stale-after-fix during intake | S:75 R:85 A:80 D:75 |
| 11 | Confident | Change type is `fix` (a measured performance defect on tty routes), pinned explicit so intake wording cannot re-infer it | The wording contains "fix" and "redesign"-adjacent terms; an explicit pin survives `fab status refresh` | S:60 R:95 A:80 D:70 |
| 12 | Confident | "Look unchanged" is verified with ph9x's paused-`currentTime` screenshot parity pairs per touched flair plus the distinct-colour count on any touched pixel-art row; no e2e for motion | Precedent in `ui/visual-design.md` and the ph9x rig notes; the plan says no e2e for motion | S:40 R:80 A:50 D:40 |
| 13 | Confident | R0 (Mac baseline) is absent; the change proceeds as written and shrinks to a memory note only if the Mac tty line later reads ≈ 300 recalcs / 30 s | Plan: R0 "blocks nothing but sharpens change 6's target"; the ticker reproduces here on both renderers | S:70 R:85 A:70 D:75 |
| 14 | Confident | Research tooling (CDP tracing, LayerTree snapshots, MutationObserver counters) is ad hoc under the session scratchpad and not committed; commands and evidence paths go into `plan.md`; no `--trace` flag | Constitution IV; the plan's standing context lists no instrument change for change 6 | S:60 R:90 A:75 D:65 |
| 15 | Certain | If H2 wins and the writer is inside xterm.js: file an upstream issue with the evidence and work around locally without patching `node_modules` | Plan § Change 6 task 2 | S:90 R:80 A:85 D:90 |
| 16 | Confident | The live `/rK/@109` route (7 animations, ticker present at ≈ 600 / 10 s) may serve read-only for BEFORE traces during research; the acceptance pair itself runs on the flair rig and one build | Change 5's rows show the ticker at that count; the acceptance needs the 5-flair scenario for a meaningful delta | S:70 R:90 A:80 D:70 |

16 assumptions (8 certain, 8 confident, 0 tentative, 0 unresolved).
