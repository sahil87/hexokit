# Plan: Flairs Stay Composited With a Terminal Mounted

**Change**: 260917-cfzm-flair-composited-with-terminal
**Intake**: `intake.md`

> Research-first change. Phase 2 (R6) decides which fix Phase 3 builds; the fix candidates are listed per hypothesis in `intake.md` § 2 and are NOT a menu — only the mechanism the evidence names is built. Every measurement row goes into `## Measurements` / `## R6 Findings` at the end of this file, verbatim summary lines.

## Requirements

### Flair overlays: mechanism of the terminal-route ticker

#### R1: The mechanism is identified with the recalc oracle and trace evidence
The apply run MUST test the four R6 hypotheses in the plan's rank order (H1 late layer demotion, H2 a second per-frame invalidator in xterm's subtree, H3 container-unit re-resolution, H4 an animated pseudo inside a size container), stopping at the first confirmed one but recording a row for every hypothesis tested. Each row MUST carry `RecalcStyleCount` per 30 s with the terminal mounted for BOTH xterm renderers (`xterm-renderer=webgl` and `xterm-renderer=dom`), the renderer %, and a pointer to the trace or counter evidence. If all four are eliminated, the run MUST widen once (bisect by `--inject`: overlays hidden; isolation / `contain: paint` / `will-change` on the tty tile wrapper; stacking-context separation) and record which, if any, removes the ticker.

- **GIVEN** the `rk-perf-flair` rig (five flaired windows: nemo, nemo, aquarium, aquarium, cube) listed by the live daemon
- **WHEN** `scripts/perf-idle-cpu.sh /rk-perf-flair/@<N> 30 --url http://127.0.0.1:3000` runs with and without a flairs-paused `--inject`, headless (WebGL) and `--no-webgl` (DOM)
- **THEN** the BEFORE rows show the ticker (recalcs ≈ 1200–1800 / 30 s with flairs on, ≈ 130–300 with flairs paused) and `## R6 Findings` names one mechanism with evidence, or records that all four hypotheses plus the widen-once bisect were eliminated

#### R2: Flair overlays composite while a terminal is mounted
With the fix applied, a tty route with flaired sidebar rows SHALL cost the same as the server page: `recalcs=` within 200 of the flairs-paused `--inject` comparator on the same route, build and renderer, and `renderer=` within 3 points of it — for both `xterm-renderer=webgl` and `xterm-renderer=dom` rows, 30 s samples, same rig and build for BEFORE and AFTER.

- **GIVEN** the fixed build served by the worktree's own rig (the worktree `rk` binary serving `app/frontend/dist`, or `just dev`) and the same `rk-perf-flair` tmux server
- **WHEN** the tty route is measured headless (WebGL) and with `--no-webgl` (DOM), each beside its flairs-paused comparator
- **THEN** both AFTER rows satisfy the 200-recalc and 3-point bounds, and the BEFORE rows on the same rig (HEAD source) do not

#### R3: Every flair still runs and looks the same
The fix MUST NOT pause, slow, hide, or re-time any flair. `document.getAnimations()` (the instrument's `## animations` block / `anims=`) SHALL report the same running flair animations AFTER as BEFORE on the tty route. Any flair whose CSS or markup the fix touches SHALL be shown pixel-identical by paused-`currentTime` screenshot pairs (BEFORE vs AFTER, same viewport, same animation time), and any touched pixel-art traversal SHALL keep its distinct-colour count (7 on the nyan row).

- **GIVEN** the AFTER build on the worktree rig
- **WHEN** the tty route is sampled and the touched flairs are screenshotted at a fixed `currentTime` on both builds
- **THEN** `anims=` is unchanged, every flair animation is `running`, and the screenshot pairs match (or the colour count is unchanged)

#### R4: The server page does not regress
`scripts/perf-idle-cpu.sh /rk-perf-flair 30` on the AFTER build SHALL read within noise of the BEFORE build on the same rig: recalcs within 100 and renderer within 3 points.

- **GIVEN** the same rig, BEFORE and AFTER builds
- **WHEN** the server page is sampled 30 s on each
- **THEN** the two rows are within the bounds above

#### R5: The pause fallback is never built without consent
If no hypothesis and no widen-once bisect yields a fix that composites with a terminal mounted, the apply run MUST stop with `status: failure`, `failed_task: T009`, `reason: fallback-needs-consent — <one line>`, and the completed `## R6 Findings` table. `animation-play-state: paused` beside a mounted tty tile (or any other change to the always-on ambient rule) SHALL NOT be implemented in that run.

- **GIVEN** every hypothesis eliminated
- **WHEN** T009 would otherwise pick a fix
- **THEN** the worker returns the failure result above and touches no flair CSS

#### R6: Constraints on the fix
The fix SHALL live in `app/frontend/src/globals.css` (§ Flair overlays) and/or `app/frontend/src/components/flair-overlay.tsx`; `terminal-client.tsx` or the tty tile wrapper in `surface-layout.tsx` MAY be touched only if the evidence shows the terminal side is the only place the isolation works. No new route, setting, settings-registry key, or instrument flag. No change-ID or PR citations in code comments — comments state the constraint (what a mounted terminal does to the flair layers and why the rule exists). No `node_modules` patching; if H2 names a writer inside xterm.js, the upstream issue text is DRAFTED into `## Upstream Issue Draft` in this file (title, body, versions, evidence) and NOT posted — the user posts it.

- **GIVEN** the winning hypothesis
- **WHEN** the fix is implemented
- **THEN** `git status --short` shows only the allowed files (plus `plan.md`, tests, and `docs/` untouched), and the diff carries no change IDs in comments

#### R7: Gates
`cd app/frontend && npx tsc --noEmit` and `just test-frontend` SHALL pass; `flair-overlay.test.tsx` SHALL cover any markup change in `flair-overlay.tsx`. If `terminal-client.tsx` or `surface-layout.tsx` is touched, ONE existing e2e spec covering the tty tile SHALL be run via `just test-e2e "e2e/<spec>"` (one spec per run). The full `just test` suite is NEVER run as a gate in this change.

- **GIVEN** the fixed tree
- **WHEN** the gates run
- **THEN** all pass, and the summary line lists them

#### R8: Live-daemon etiquette and cleanup
The `:3000` daemon and the user's tmux servers are read-only for measurement (loading a tty route selects that window in its session — use the rig server's windows only). The `rk-perf-flair` server, any spare-port `rk serve`, and any scratch `dist` swap SHALL be torn down at the end, leaving `git status` with only the change's files.

- **GIVEN** the run finished (success or failure)
- **WHEN** T014 runs
- **THEN** `tmux -L rk-perf-flair list-sessions` reports no server, no spare `rk serve` is listening, and `app/frontend/dist` is the AFTER build or removed

### Non-Goals

- New flairs, removed flairs, an ambient-motion setting, a `--trace` instrument flag — out of scope (intake § Non-goals).
- Changing the instrument (`scripts/perf-idle-cpu.*`) — change 5 shipped what this change needs.
- Memory writes — hydrate's job; this plan's `## Affected memory` guidance is in `intake.md`.
- Widening the backend server-name cap or touching Go — not this change.

### Design Decisions

#### Research before fix
**Decision**: The apply run spends its first phase proving the mechanism (four ranked hypotheses, recalc oracle, Blink trace) and builds only the fix that mechanism names.
**Why**: Four plausible mechanisms have four different fixes; the wrong one costs a cycle and proves nothing, while the oracle discriminates them in under an hour. Measured facts already exclude the renderer, the caret, the canvas, containment on the terminal, the code iframe, and container units alone.
**Rejected**: Prescribing layer isolation upfront (the leading guess, but unproven); the pause fallback (a product change).
*Introduced by*: 260917-cfzm-flair-composited-with-terminal

#### Both renderers, same build
**Decision**: Every acceptance pair is measured on one rig and one build type, once with `xterm-renderer=webgl` (plain headless on this box, or `--headed`) and once with `--no-webgl` (`xterm-renderer=dom`), each beside its flairs-paused comparator.
**Why**: A tty-route number without the renderer field is not comparable (DOM ≈ 2× WebGL); the release daemon and a worktree build differ, so BEFORE/AFTER must share a rig.
**Rejected**: Headed-vs-headless as the renderer split (superseded by change 5's finding that headless exposes SwiftShader WebGL here).
*Introduced by*: 260917-cfzm-flair-composited-with-terminal

#### Upstream issue drafted, not posted
**Decision**: If the cause is inside xterm.js, the worker drafts the issue into this plan; posting is the user's action.
**Why**: Posting to a third-party public repo is outward-facing and not reversible; the draft carries everything the user needs.
**Rejected**: `gh issue create` from the worker.
*Introduced by*: 260917-cfzm-flair-composited-with-terminal

## Tasks

### Phase 1: Setup

- [x] T001 Install the worktree's frontend deps so the instrument can resolve Playwright: `just setup` (or `PNPM_CONFIG_STRICT_DEP_BUILDS=false pnpm install --frozen-lockfile` in `app/frontend`; chromium-1217 is already in `~/.cache/ms-playwright`). Verify `just perf-idle-cpu --help` lists `--headed`, `--no-webgl`, `xterm-renderer=`. <!-- R1 -->
- [x] T002 Build the flair rig: `tmux -L rk-perf-flair new-session -d -s perf -n nemo1 -c /tmp 'sleep 100000'`, then `new-window` for `nemo2 aquarium1 aquarium2 cube1` and `set-option -w -t perf:<win> @rk_win_flair <nemo|nemo|aquarium|aquarium|cube>`. Confirm the daemon lists it (`curl -s http://127.0.0.1:3000/api/servers`), pick one window's `@N` (`tmux -L rk-perf-flair list-windows -t perf -F '#{window_id} #{window_name}'`) and record `/rk-perf-flair/@<N>` in `## Measurements`. <!-- R1 -->
- [x] T003 BEFORE rows on the live daemon (release build), 30 s each, pasted verbatim into `## Measurements`: `/rk-perf-flair` server page; `/rk-perf-flair/@<N>` headless (check `xterm-renderer=webgl`; if it reads `dom`, use `--headed`); the same with `--no-webgl`; and each tty row's flairs-paused comparator via `scripts/perf-idle-cpu.sh … --inject '<style injection: .rk-flair-nemo *, .rk-flair-aquarium *, .rk-flair-cube * { animation-play-state: paused !important }>'` (call the `.sh` directly — `just` mangles parentheses). Discard any row with `xterm=0`. <!-- R1 -->

### Phase 2: Research (R6)

- [x] T004 H1 late demotion: write a scratchpad Playwright script (`createRequire` from `app/frontend`, `chromium.launch({ channel: "chromium" })`) that starts CDP `Tracing.start` (`blink.animations,disabled-by-default-cc.debug,disabled-by-default-blink.debug.layout`) BEFORE navigating to the tty route, waits for `.xterm` + 3 s, stops tracing, and writes the trace; count flair `Animation` events with non-zero `compositeFailed` after the mount. Enable `LayerTree` and snapshot layer ownership of `.rk-flair-* > span` before and after `.xterm` appears. Record verdict + evidence paths in `## R6 Findings`. <!-- R1 -->
- [x] T005 H2 second invalidator: `--inject` a `MutationObserver` on `document.head` and on `.xterm` (`subtree, attributes, childList, characterData`) that counts for 5 s into `window.__rkMut` (total + histogram by target tag/class/attribute); run flairs-on and flairs-paused, DOM and WebGL; read the counter through the `--json` output or a second inject. Name the mutating node(s). Record verdict. <!-- R1 -->
- [x] T006 H3 container-unit re-resolution: inventory every `cq*` consumer in the flair block of `app/frontend/src/globals.css` (nemo `translateY(100cqh)` ~:878, aquarium ~:1870–1880, any cube/warp/scan use); `--inject` a pause of exactly those layers and re-measure; count `ResizeObserver` callbacks on `.rk-flair-*` for 5 s with the terminal mounted. Record verdict. <!-- R1 -->
- [x] T007 H4 animated pseudo: confirm the flair block (`globals.css` lines ~730 to the reduced-motion block) has no animated `::before`/`::after` (expected empty after ph9x); if any remains, `--inject` a disable and re-measure. Record verdict. <!-- R1 -->
- [x] T008 Verdict: if none of T004–T007 confirmed, run the widen-once bisect (`--inject` (a) `.rk-flair-* { display: none }` on overlays only, (b) `isolation: isolate` then `contain: paint` then `will-change: transform` on the tty tile wrapper element in `surface-layout.tsx`'s rendered DOM, (c) `z-index`/stacking separation of the terminal from the sidebar) and record which removes the ticker. Write the winning mechanism as the first line of `## R6 Findings` (`Mechanism: …`) with the fix it implies, or `Mechanism: none found` with every row. <!-- R1 -->

### Phase 3: Fix

- [x] T009 Implement the fix named in `## R6 Findings` — in `app/frontend/src/globals.css` (§ Flair overlays) and/or `app/frontend/src/components/flair-overlay.tsx`; touch `terminal-client.tsx` / `surface-layout.tsx` only if the evidence shows the terminal side is the only workable place. Comment the constraint (why the rule exists, what the terminal does) without change IDs. If `Mechanism: none found`: STOP — return `status: failure`, `failed_task: T009`, `reason: fallback-needs-consent — …` with the findings table; do NOT implement `animation-play-state: paused`. <!-- R2 -->
- [x] T010 Tests and type gates: update `app/frontend/src/components/flair-overlay.test.tsx` for any markup change; `cd app/frontend && npx tsc --noEmit`; `just test-frontend`. If `terminal-client.tsx` or `surface-layout.tsx` changed, run one existing tty-tile e2e via `just test-e2e "e2e/<spec>"`. Never `just test`. <!-- R7 -->
- [x] T011 Same-build A/B on the worktree rig: `cp configs/tmux/default.conf app/backend/build/tmux.conf`, `cd app/backend && CGO_ENABLED=0 go build -o <scratch>/rk-wt ./cmd/rk`, pick a free port (`ss -ltn`), `RK_PORT=<p> RK_HOST=127.0.0.1 RK_CODE_SERVER_PORT=<p+2> <scratch>/rk-wt serve &` (serves `app/frontend/dist` from disk). BEFORE: build `dist` from HEAD source (`git stash` is FORBIDDEN — copy the changed files to scratch, `git show HEAD:<file> > <file>`, `pnpm build`, measure, restore from scratch, `pnpm build`). Rows, 30 s each, `--url http://127.0.0.1:<p>`: tty WebGL, tty `--no-webgl`, each with its flairs-paused comparator, and the server page — BEFORE and AFTER. Paste all rows into `## Measurements` and state pass/fail against R2/R4 bounds. <!-- R2 -->
- [x] T012 Look parity: for each flair whose CSS/markup changed, screenshot the rig's sidebar rows at a fixed paused `currentTime` (`document.getAnimations().forEach(a => { a.pause(); a.currentTime = 4000 })`) on the BEFORE and AFTER builds, same viewport; compare pixel-wise (Playwright `toHaveScreenshot`-style or a node pixel diff); for any touched pixel-art traversal count distinct colours on that row. Confirm `anims=` unchanged and every flair `running` on the AFTER tty row. Record results in `## Measurements`. <!-- R3 -->
- [x] T013 If H2 named a writer inside xterm.js: draft the upstream issue into `## Upstream Issue Draft` (title, body with the MutationObserver evidence, xterm/addon versions from `app/frontend/package.json`, Chromium version) — do NOT post it. Otherwise mark N/A. <!-- R6 -->

### Phase 4: Polish

- [x] T014 Teardown: `tmux -L rk-perf-flair kill-server`; kill the spare `rk-wt serve`; leave `app/frontend/dist` as the AFTER build (or remove it if it was absent before); remove `app/backend/build/tmux.conf` only if it was absent before; `git status --short` shows only the change's files. <!-- R8 -->

## Execution Order

- T001 → T002 → T003 strictly sequential (deps, rig, baseline).
- T004–T007 run in rank order and stop at the first confirmed hypothesis (record every one tested); T008 only when none confirmed.
- T009 blocks T010–T013. T011 needs the AFTER build from T009 and the HEAD-source BEFORE build.
- T014 last, on success or failure.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `## R6 Findings` names one mechanism (or `none found`) with a row per hypothesis tested, each carrying WebGL and DOM recalcs per 30 s with the terminal mounted and an evidence pointer
- [x] A-002 R2: AFTER tty rows (WebGL and DOM) are within 200 recalcs and 3 renderer points of their flairs-paused comparators, on the same rig and build as the BEFORE rows — verified in `## Measurements` pass/fail block (Δ134/Δ122 recalcs, Δ1.4/Δ2.1 points)
- [x] A-003 R3: `anims=` unchanged AFTER vs BEFORE on the tty route and every flair animation `running` — 37 on both AFTER rows; `anims=` counts only running animations
- [x] A-004 R4: AFTER server-page row within 100 recalcs and 3 points of BEFORE — 266 vs 267, 4.3% vs 4.1%
- [x] A-005 R6: the diff touches only `globals.css` / `flair-overlay.tsx` (+ tests, plan.md), or documents in `## R6 Findings` why `terminal-client.tsx` / `surface-layout.tsx` had to change — latter: `## R6 Findings` "Fix consequence" documents why the terminal side is the only workable place; working-tree diff is exactly `terminal-client.tsx`, `surface-layout.tsx` (one prop line), `lib/terminal-visibility.ts` + test
- [x] A-006 R7: `npx tsc --noEmit` and `just test-frontend` pass; a markup change in `flair-overlay.tsx` has a matching `flair-overlay.test.tsx` update — tsc clean; full Vitest suite 244 files / 5185 tests green (one flaky first run, two subsequent full green runs); no `flair-overlay.tsx` markup change

### Behavioral Correctness

- [x] A-007 R2: the BEFORE tty rows show the ticker (recalcs ≥ 1000 / 30 s above the paused comparator) so the AFTER delta is a real change, not noise — 1814/1802 vs 191/202 (Δ≈1600)
- [x] A-008 **N/A**: no flair's CSS or markup changed (the fix is terminal-side), so no screenshot-parity pair or colour count is owed — plan's own R3 pass/fail note records this

### Removal Verification

- [x] A-009 R6: no `animation-play-state: paused` (or any pausing/hiding of flairs beside a terminal) exists in the diff unless the user consented via `/fab-clarify` — zero occurrences in the diff

### Scenario Coverage

- [x] A-010 R1: the H1 trace was started before navigation and spans the terminal mount (`/tmp/cfzm-scratch/h1-trace.json`); the H2 MutationObserver counter ran flairs-on vs paused (`h2-mutations-{on,paused}-webgl.json`), with the both-renderers ticker baseline established by the BEFORE rows and renderer-independence confirmed by the IO probe + server-page generalization
- [x] A-011 **N/A**: mechanism found (xterm's page-level `IntersectionObserver` + continuously-advancing composited animations); the fallback clause was never triggered and no flair CSS changed

### Edge Cases & Error Handling

- [x] A-012 R1: any instrument row with `xterm=0` was discarded, not recorded as a tty measurement — the only `xterm=0` rows in `## Measurements` are server-page rows, legitimately recorded as such
- [x] A-013 R8: the rig server and spare `rk serve` are gone (`tmux -L rk-perf-flair list-sessions` → no server); `git status --short` shows only the change's files; no `git stash` entry was created by this change (the one stash entry predates it: `stash@{0} WIP on main`)

### Code Quality

- [x] A-014 Pattern consistency: comment discipline holds (constraints, no narration, no change IDs) in `terminal-visibility.ts` and the `terminal-client.tsx` hunks; no CSS changed
- [x] A-015 No unnecessary duplication: the shim reuses the document visibility API and the tile layer's existing `hidden` state; no second measurer added
- [x] A-016 Type narrowing over assertions in any TSX change — the TSX hunks carry no assertions (the `as unknown as typeof IntersectionObserver` cast lives in the `.ts` shim, the standard shape for a global stand-in)
- [x] A-017 No comment narration — comments state constraints the code cannot show (duplication across the three sites is tracked as a review should-fix, not a narration violation)
- [x] A-018 Tests cover the changed behaviour where behaviour changed — `terminal-visibility.test.ts` (7 tests) covers the shim; the instrument rows in `## Measurements` cover the CPU behaviour; `terminal-client.test.tsx` (58 tests) green with the shim installed

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- `plan.md` may be extended with `## Measurements`, `## R6 Findings`, `## Upstream Issue Draft` (below); the three parser headings above are the stable contract.

## Deletion Candidates

None — this change adds new functionality (the visibility shim and the `hidden` prop wiring) without making any existing repo code redundant; xterm's own observer lives in `node_modules` and is untouched by design (no vendoring/patching).

## Measurements

Rig: throwaway tmux server `rk-perf-flair` (session `perf`; windows `@0 nemo1` (nemo), `@2 nemo2` (nemo), `@3 aquarium1` (aquarium), `@4 aquarium2` (aquarium), `@5 cube1` (cube)). Research route: `/rk-perf-flair/@0`; comparator route: `/rk-perf-flair`. Flairs-paused comparator inject: `(function(){const s=document.createElement("style");s.textContent=".rk-flair-nemo *, .rk-flair-aquarium *, .rk-flair-cube * { animation-play-state: paused !important }";document.head.appendChild(s)})()` (run through `scripts/perf-idle-cpu.sh` directly).

### BEFORE — live daemon `http://127.0.0.1:3000` (release build), 2026-09-17

Server page, headless:

```
perf-idle-cpu /rk-perf-flair 30.1s renderer=4.3% gpu=2.7% browser=0.1% main=1.3% recalcs=265 layouts=1 anims=37 xterm=0 xterm-renderer=none iframes=0 ws[/ws/state]=0.3msg/s,3.8kB/s
```

Tty route, headless, `xterm-renderer=webgl` (ticker present):

```
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=8.9% gpu=3.7% browser=0.1% main=4.8% recalcs=1813 layouts=2 anims=37 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/state]=0.4msg/s,3.9kB/s ws[/ws/terminals]=0msg/s,0kB/s
```

Tty route, `--no-webgl`, `xterm-renderer=dom` (ticker present):

```
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=9.1% gpu=3.2% browser=0.1% main=4.7% recalcs=1814 layouts=5 anims=37 xterm=1 xterm-renderer=dom iframes=0 ws[/ws/state]=0.4msg/s,3.9kB/s ws[/ws/terminals]=0.1msg/s,0kB/s no-webgl
```

Tty route, flairs-paused comparator, `xterm-renderer=webgl` (ticker gone):

```
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=3.3% gpu=0.4% browser=0.1% main=1.1% recalcs=197 layouts=2 anims=2 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/state]=0.4msg/s,3.8kB/s ws[/ws/terminals]=0msg/s,0kB/s
```

Tty route, flairs-paused comparator, `xterm-renderer=dom` (ticker gone):

```
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=3.6% gpu=0.3% browser=0.1% main=1.2% recalcs=197 layouts=3 anims=2 xterm=1 xterm-renderer=dom iframes=0 ws[/ws/state]=0.4msg/s,4.1kB/s ws[/ws/terminals]=0msg/s,0kB/s no-webgl
```

BEFORE delta vs the paused comparator: ~1616 recalcs / 30 s (≈ 54/s) on both renderers — the ticker reproduces on the rig.

### Research-phase inject rows — live daemon :3000 (release build), all on `/rk-perf-flair/@0`, `xterm-renderer=webgl` unless noted

H3 (pause exactly the cq-consuming animations: nemo swim-orange/blue ×2, cube x/y — ticker stays):

```
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=8% gpu=3.7% browser=0.1% main=4.3% recalcs=1810 layouts=3 anims=31 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/state]=0.4msg/s,3.9kB/s ws[/ws/terminals]=0msg/s,0kB/s
```

H3 variant (`container-type: normal !important` on the three rig overlays — ticker stays):

```
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=8.6% gpu=2.2% browser=0.1% main=4.7% recalcs=1817 layouts=3 anims=37 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/state]=0.4msg/s,3.9kB/s ws[/ws/terminals]=0msg/s,0kB/s
```

H1 fix-candidate probes (ticker stays in all): overlay `isolation: isolate` → recalcs=1824/30 s; child spans `will-change: transform` → recalcs=1814/30 s. Widen bisect, 10 s rows (ticker ≈ 600/10 s): hide `.xterm-viewport` 602 · `.xterm-screen` 603 · `.xterm-helper-textarea` 602 · `.xterm-accessibility` 601 · `.xterm-decoration-overview-ruler` 607 · ALL `.xterm` children 603 · `.xterm` itself `display:none` 611 · `isolation: isolate` on the `.xterm`→`<main>` ancestor chain 602 · `contain: paint` on the chain 612. Only REMOVING the `.xterm` element (JS teardown) ever killed the ticker (plan table: 342/30 s).

Mechanism probe — `window.IntersectionObserver` stubbed before load (addInitScript, `/tmp/cfzm-scratch/r6-io-stub.mjs`): `recalcs/10s=109 runningAnims=37` vs control `recalcs/10s=603 runningAnims=37`. Generalization — server page (no terminal) + one `new IntersectionObserver(()=>{},{threshold:0}).observe(document.body)` injected:

```
perf-idle-cpu /rk-perf-flair 20.1s renderer=8.1% gpu=2.9% browser=0% main=4.2% recalcs=1203 layouts=2 anims=37 xterm=0 xterm-renderer=none iframes=0 ws[/ws/state]=0.3msg/s,3.9kB/s
```

### Same-build A/B — worktree rig `http://127.0.0.1:3910` (worktree `rk` binary serving `app/frontend/dist` from disk), 2026-09-17

BEFORE (dist built from HEAD source via `git show`):

```
perf-idle-cpu /rk-perf-flair 30.1s renderer=4.1% gpu=2.8% browser=0.1% main=1.2% recalcs=267 layouts=2 anims=37 xterm=0 xterm-renderer=none iframes=0 ws[/ws/state]=0.2msg/s,3.5kB/s
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=8.4% gpu=3.9% browser=0.1% main=4.5% recalcs=1814 layouts=3 anims=37 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/state]=0.3msg/s,2.6kB/s ws[/ws/terminals]=0.1msg/s,0kB/s
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=8.7% gpu=3.1% browser=0.1% main=4.5% recalcs=1802 layouts=3 anims=37 xterm=1 xterm-renderer=dom iframes=0 ws[/ws/state]=0.3msg/s,3.7kB/s ws[/ws/terminals]=0msg/s,0kB/s no-webgl
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=2.8% gpu=0.3% browser=0% main=1% recalcs=191 layouts=2 anims=2 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/state]=0.3msg/s,3.6kB/s ws[/ws/terminals]=0msg/s,0kB/s
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=3.1% gpu=0.4% browser=0.1% main=1% recalcs=202 layouts=4 anims=2 xterm=1 xterm-renderer=dom iframes=0 ws[/ws/state]=0.3msg/s,3.9kB/s ws[/ws/terminals]=0.1msg/s,0kB/s no-webgl
```

AFTER (dist built from the fixed tree; the last three rows are the paused comparators and the server page):

```
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=4.7% gpu=3.8% browser=0.1% main=1.7% recalcs=327 layouts=3 anims=37 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/state]=0.3msg/s,3.6kB/s ws[/ws/terminals]=0.1msg/s,0kB/s
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=4.9% gpu=3.1% browser=0.1% main=1.6% recalcs=320 layouts=2 anims=37 xterm=1 xterm-renderer=dom iframes=0 ws[/ws/state]=0.3msg/s,3.8kB/s ws[/ws/terminals]=0msg/s,0kB/s no-webgl
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=3.3% gpu=0.6% browser=0.1% main=1.1% recalcs=193 layouts=3 anims=2 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/state]=0.4msg/s,3.8kB/s ws[/ws/terminals]=0.1msg/s,0kB/s
perf-idle-cpu /rk-perf-flair/@0 30.1s renderer=2.8% gpu=0.4% browser=0.2% main=1% recalcs=198 layouts=3 anims=2 xterm=1 xterm-renderer=dom iframes=0 ws[/ws/state]=0.3msg/s,3.8kB/s ws[/ws/terminals]=0.1msg/s,0kB/s no-webgl
perf-idle-cpu /rk-perf-flair 30.1s renderer=4.3% gpu=2.8% browser=0.1% main=1.3% recalcs=266 layouts=1 anims=37 xterm=0 xterm-renderer=none iframes=0 ws[/ws/state]=0.3msg/s,3.6kB/s
```

Pass/fail against the bounds:

- **R2 WebGL**: AFTER 327 vs paused comparator 193 → Δ134 ≤ 200 ✓; renderer 4.7% vs 3.3% → Δ1.4 ≤ 3 ✓. BEFORE 1814 vs 191 (Δ1623) — fails, so the delta is real (A-007 ✓).
- **R2 DOM**: AFTER 320 vs 198 → Δ122 ≤ 200 ✓; renderer 4.9% vs 2.8% → Δ2.1 ≤ 3 ✓. BEFORE 1802 vs 202 (Δ1600) ✓.
- **R3**: `anims=37` on both AFTER tty rows (= BEFORE), `anims=` counts only `running` animations — every flair still running. No flair CSS/markup changed, so no screenshot-parity pair or colour count is owed (T012 N/A).
- **R4 server page**: AFTER 266 vs BEFORE 267 → Δ1 ≤ 100 ✓; renderer 4.3% vs 4.1% → Δ0.2 ≤ 3 ✓.

## R6 Findings

Mechanism: **xterm.js's `RenderService` registers a page-level `IntersectionObserver` on the terminal's screen element (render-pause when off-screen; unconditional whenever `IntersectionObserver` exists — `@xterm/xterm` 6.0.0). While ANY continuously-advancing composited animation runs on the page (the flairs), Blink recomputes intersections on every compositor frame, which forces a full main-thread style/lifecycle update per frame — re-applying every running animation's style on the main thread (trace: `UpdateLayoutTree` at 60/s with `elementsStyled=37`, `StyleRecalcInvalidationTracking` reason `"Animation"` on each flair span). With no IntersectionObserver registered (server page), composited flairs cost the main thread nothing.** The fix it implies lives on the terminal side: substitute xterm's page-level observer with run-kit-driven visibility (run-kit already knows when a tile is display-hidden), so no page-level `IntersectionObserver` exists on a tty route.

Evidence paths (session scratchpad, not committed): `/tmp/cfzm-scratch/h1-trace.json` (blink.animations trace across the terminal mount), `/tmp/cfzm-scratch/r6-style-trace.json` + `r6-invalidation-trace.json` (per-frame `UpdateLayoutTree` / `StyleRecalcInvalidationTracking` reason "Animation"), `/tmp/cfzm-scratch/h2-mutations-{on,paused}-webgl.json` (MutationObserver histograms), `/tmp/cfzm-scratch/r6-layers-_rk-perf-flair*.json` (layer ownership snapshots). Probe scripts: `/tmp/cfzm-scratch/*.mjs`.

| Hypothesis | Renderer | Recalcs / 30 s (terminal mounted) | Renderer % | Evidence | Verdict |
|---|---|---|---|---|---|
| H1 late demotion | webgl / dom | 1813 / 1814 | 8.9 / 9.1 | `h1-trace.json`: all 37 flair animations `compositeFailed=0` across the mount (only 2 benign `131072`); LayerTree snapshots: 49/49 flair spans own composited layers on BOTH routes (`r6-layers-*.json`) | ELIMINATED — no demotion; layers intact |
| H2 second invalidator in xterm's subtree | webgl | 1813 | 8.9 | MutationObserver 5 s: flairs-on 134 vs paused 75 total mutations (startup focus/class churn only, no per-frame writer); CDP CSS domain: 0 `styleSheetChanged` in 6 s; `CSSStyleDeclaration.setProperty` 0 in 5 s | ELIMINATED — no style/DOM churn |
| H3 `cq*` keyframes re-resolve | webgl | 1810 (only the 6 cq-consuming animations paused) | 8.0 | cq consumers: scan band `100cqh` (globals.css:877), nemo swims `100cqw` (:1870–1875), cube x/y (:2122–2126); pausing exactly those leaves the ticker; ResizeObserver callbacks on `.rk-flair-*`: 0 in 5 s; `container-type: normal` on the overlays: 1817 / 30 s | ELIMINATED — neither container units nor the size container |
| H4 animated pseudo in a size container | webgl / dom | 1813 / 1814 | 8.9 / 9.1 | Inventory of `::before`/`::after` in the flair block: none animated (only static `.rk-hazard::before` outside it) | ELIMINATED — empty inventory |
| Widen (a) overlays hidden | webgl | — | — | subsumed by the flairs-paused comparator (197 / 30 s) | ticker gone (control) |
| Widen (b) tty-tile-wrapper isolation | webgl | 602 / 10 s (`isolation: isolate` on the `.xterm` ancestor chain); 612 / 10 s (`contain: paint`) | 9.1 / 8.2 | instrument `--inject` rows | no effect — not stacking/layers |
| Widen (c) `.xterm` subtree bisect | webgl | 601–607 / 10 s with EACH of `.xterm-viewport`, `.xterm-screen`, `.xterm-helper-textarea`, `.xterm-accessibility`, `.xterm-decoration-overview-ruler` hidden, with ALL children hidden, and with `.xterm` itself `display: none` | 8.1–10.2 | instrument `--inject` rows | no effect — not the rendered terminal; only element REMOVAL (JS-side teardown) ever killed it |
| **IO probe (mechanism)** | webgl | **109 / 10 s with `window.IntersectionObserver` stubbed before load (37 anims still running) vs 603 / 10 s control**; server page (no terminal) + one `new IntersectionObserver(...).observe(document.body)`: 1203 / 20 s (≈ 60/s) vs 265 / 30 s baseline | — | `/tmp/cfzm-scratch/r6-io-stub.mjs` | **CONFIRMED — any registered IntersectionObserver + continuously-advancing composited animations ⇒ per-frame main-thread style lifecycle** |

Why the earlier exclusions all held: caret blink off / rows hidden / canvas hidden / `contain: strict` / blur all leave xterm's observer registered, and only a continuously-varying composited animation drives frames (the caret's step blink changes ~1/s, which is why the flairs-paused comparator reads 197 with `anims=2`).

Fix consequence (terminal side is the only workable place — no flair-side CSS can unregister a page-level observer, and the flair look is invariant): during `terminal.open()`, swap `window.IntersectionObserver` for a shim so xterm's registration binds to run-kit-driven visibility (the tile's `hidden` state ∧ `document.hidden`) instead of a real page-level observer; pause semantics for hidden-mounted tiles (P3 hide-never-unmount) are preserved by `TerminalClient`'s new `hidden` prop. Board panes unmount on `paused` already; their pre-warm off-screen edge panes lose xterm's auto render-pause (bounded: they still get relay-driven data). Upstream: issue drafted below (T013).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Research (T004–T008) precedes the fix (T009); only the mechanism the evidence names is built | Intake § 1–2, user input "no fix is prescribed upfront" | S:95 R:85 A:90 D:95 |
| 2 | Confident | Same-build A/B uses the worktree `rk` binary serving `app/frontend/dist` on a spare port, BEFORE from HEAD source via `git show`, never `git stash` | Documented rig; the shared stash stack is off-limits in worktrees | S:70 R:85 A:80 D:70 |
| 3 | Confident | The upstream xterm.js issue is drafted in plan.md, not posted | Outward-facing action reserved for the user | S:65 R:90 A:80 D:70 |
| 4 | Confident | `just setup` is the first task because the worktree has no `app/frontend/node_modules` | Observed during planning | S:80 R:95 A:95 D:90 |
| 5 | Confident | Screenshot parity at a paused `currentTime` is the look-unchanged check; no e2e for motion | ph9x precedent; intake assumption 12 | S:45 R:80 A:55 D:45 |
| 6 | Confident | The flairs-paused comparator is a `--inject` pausing the rig's three flair classes, not `--reduced-motion` | `--reduced-motion` zeroes the caret blink too (testing.md) | S:70 R:90 A:85 D:80 |

6 assumptions (1 certain, 5 confident, 0 tentative).

## Upstream Issue Draft

**Repo**: xtermjs/xterm.js — **draft only, NOT posted** (posting is the user's action).

**Title**: RenderService's IntersectionObserver forces a per-frame main-thread style lifecycle in Chromium while any composited animation runs on the page

**Body**:

### Summary

`RenderService` registers a page-level `IntersectionObserver` on the terminal's screen element at `open()` to pause rendering while the terminal is off-screen (`_registerIntersectionObserver`, `src/browser/services/RenderService.ts`, still unconditional on master as of 2026-09-17: `if ('IntersectionObserver' in w) { new w.IntersectionObserver(..., { threshold: 0 }).observe(screenElement) }`).

In Chromium, a page with any registered `IntersectionObserver` recomputes intersections on every compositor frame. While any continuously-advancing composited CSS animation runs anywhere on the page, that recompute drags a full main-thread style/layout lifecycle along with it — every running animation's style is re-applied on the main thread every frame. Measured: `Performance.getMetrics().RecalcStyleCount` ≈ 1800 per 30 s (60/s) with a mounted terminal vs ≈ 200 per 30 s without the observer, on an otherwise idle page.

### Reproduction

1. Serve a page with (a) a mounted xterm instance and (b) one or more infinite composited CSS animations (transform/opacity keyframes on child spans — they start fully composited, `compositeFailed=0` in a `blink.animations` trace, and keep their composited layers).
2. Idle the page (no terminal output).
3. Read `RecalcStyleCount` deltas via CDP `Performance.getMetrics` over 30 s: ≈ 1800 with the terminal mounted, ≈ 200 with the terminal's observer absent.
4. The terminal's renderer is irrelevant: identical numbers with the WebGL addon and with the DOM renderer.
5. The animation set is irrelevant: stubbing `window.IntersectionObserver` before load (so `RenderService` never registers) drops the same page from 603 → 109 recalcs per 10 s with all 37 animations still running; conversely, registering a bare `new IntersectionObserver(() => {}, { threshold: 0 }).observe(document.body)` on a terminal-free page with the same animations reproduces the ticker (1203 per 20 s vs 265 per 30 s baseline).

A `devtools.timeline` + `disabled-by-default-devtools.timeline.invalidationTracking` trace shows `UpdateLayoutTree` at 60/s with `elementCount` equal to the number of animated elements and `StyleRecalcInvalidationTracking` reason `"Animation"` on every animated node — the animations are not demoted (layers intact, `compositeFailed=0`); the main thread is simply woken every frame to recompute intersections and applies the animation styles while it is there.

### Impact

Any xterm-embedding app with ambient composited CSS animations pays ~5 renderer-CPU points and ~4 main-thread points of one core, continuously, whenever a terminal is mounted — even completely idle. Apps whose terminals are always visible get no benefit from the observer's pause yet pay this cost; apps that keep hidden terminals mounted (run-kit's hide-never-unmount tile layer) need the pause and cannot simply delete the observer.

### Versions

`@xterm/xterm` 6.0.0, `@xterm/addon-webgl` 0.19.0, Chromium 147.0.7727.15 (headless, SwiftShader WebGL, and `--disable-webgl` DOM-renderer rows; also reproduced headed under Xvfb with WebGL).

### Possible directions

- Gate the registration behind an option (e.g. `pauseRenderingWhenHidden`, default true) so embedders with their own visibility signal can opt out without monkey-patching `window.IntersectionObserver`.
- Or investigate with the Chromium team whether intersection recomputation needs to force a main-thread style lifecycle for compositor-only frames when the observed element's geometry inputs did not change.

### Local workaround (run-kit)

`terminal.open()` runs with `window.IntersectionObserver` temporarily replaced by a shim that reports visibility from the embedder's own knowledge (tile hidden state ∧ `document.hidden`), so no page-level observer exists on the route. Pause semantics for hidden terminals are preserved by the embedder driving `setLocallyVisible`.
