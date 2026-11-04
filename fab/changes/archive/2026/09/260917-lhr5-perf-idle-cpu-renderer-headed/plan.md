# Plan: perf-idle-cpu reports the xterm renderer and runs headed

**Change**: 260917-lhr5-perf-idle-cpu-renderer-headed
**Intake**: `intake.md`

## Requirements

### Instrument: xterm renderer reporting

#### R1: The summary line and JSON name the xterm renderer the page used
`scripts/perf-idle-cpu.mjs` MUST read `window.__rkRenderer` at inventory time and emit `xterm-renderer=<kind>` on the summary line immediately after `xterm=<n>`, where kind is `none` (no `.xterm`), `webgl` (all registry values `webgl`), `dom` (all `canvas`), `mixed` (both), or `unknown` (an `.xterm` with an empty registry). The existing `renderer=<n>%` CPU field MUST keep its name, order and meaning. The `--json` output MUST carry `inventory.xtermRenderer` and `inventory.rendererRegistry`; `## page` MUST show an `xterm renderer` row. `--help` MUST list the field.

- **GIVEN** a run on `/rK/@N` with a mounted terminal
- **WHEN** the report prints
- **THEN** the summary line contains `xterm=1 xterm-renderer=<webgl|dom>` matching the registry
- **AND** the JSON has `inventory.xtermRenderer` and a registry map with one `webgl` or `canvas` entry

- **GIVEN** a run on `/runKit` (no terminal)
- **WHEN** the report prints
- **THEN** the summary line contains `xterm=0 xterm-renderer=none`

#### R2: The change-4 console line is captured as a cross-check, never as the source
The script MUST attach a `console` listener before navigation, keep only messages starting `rk: xterm WebGL` (count + first line verbatim), print a `webgl warnings <count>[ — <first line>]` row in `## page`, and write `webglConsole: { count, first }` to the JSON. When the count disagrees with the registry kind (`dom`/`mixed` with 0 lines, or `webgl` with ≥ 1) the row MUST append ` (registry says <kind> — mismatch)`. The renderer kind MUST NOT be derived from the console lines.

- **GIVEN** a run where xterm fell to the DOM renderer (e.g. `--no-webgl`)
- **WHEN** the page loads
- **THEN** `webgl warnings` reads 1 with the first line, and no mismatch note appears

### Instrument: tty-route guard

#### R3: A tty route without a mounted terminal is flagged and still exits 0
The route sampled (the `--then` target when given, else `<path>`, query string stripped) SHALL count as a tty route when it matches `^/[^/]+/@?\d+/?$` and does not start with `/board/` or equal `/__controls`. When the route is a tty route AND the `.xterm` count is 0 at sample end, the script MUST print to stderr, after the report, `perf-idle-cpu: warning: no terminal mounted on <route> — not a tty measurement (xterm=0; the sidebar/server numbers are still valid)`, MUST record `ttyRoute: true` and `warnings: [...]` in the JSON, and MUST exit 0. Non-tty routes MUST print no warning and record `ttyRoute: false`, `warnings: []`.

- **GIVEN** `just perf-idle-cpu /runKit/@99 5 --inject '<remove .xterm>'`
- **WHEN** the run ends
- **THEN** stderr carries the warning, the summary line reads `xterm=0 xterm-renderer=none`, exit code is 0

- **GIVEN** `just perf-idle-cpu /runKit 5`
- **WHEN** the run ends
- **THEN** no warning is printed and the JSON has `ttyRoute: false`

### Instrument: headed mode

#### R4: `--headed` launches headed Chromium with WebGL flags; headless launch is unchanged
`scripts/perf-idle-cpu.mjs` MUST accept `--headed` (boolean). When set, `launchChromium` MUST use `{ headless: false, channel: "chromium", args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }`; when unset the launch options MUST remain exactly `{ headless: true, channel: "chromium" }`. `headed: true|false` MUST be recorded in the JSON, shown as a `## page` row, and appended to the summary line as a trailing `headed` token (after `reduced-motion` when both apply). `--help` MUST document the flag and say when it is needed (a real display, or a box whose headless Chromium lacks WebGL).

- **GIVEN** `--headed` on a tty route with a display available
- **WHEN** the run ends
- **THEN** the summary line ends with `headed` and reads `xterm-renderer=webgl` with 0 webgl warnings

#### R5: The wrapper supplies a display for `--headed`
`scripts/perf-idle-cpu.sh` MUST scan its arguments for `--headed`. When present: if `DISPLAY` is set, exec `node` directly; if `DISPLAY` is unset and `xvfb-run` is on PATH, exec `xvfb-run -a -s "-screen 0 1920x1080x24" node <script> "$@"`; if `DISPLAY` is unset and `xvfb-run` is absent, print `perf-idle-cpu: --headed needs a display — set DISPLAY or install xvfb (apt install xvfb) for xvfb-run` to stderr and exit 1. Without `--headed` the wrapper's behavior MUST be unchanged. The justfile recipe MUST NOT change.

- **GIVEN** `env -u DISPLAY scripts/perf-idle-cpu.sh /runKit/@99 5 --headed` with `xvfb-run` installed
- **WHEN** the wrapper runs
- **THEN** Chromium launches under Xvfb and the run completes

- **GIVEN** `env -u DISPLAY PATH=<no xvfb-run> scripts/perf-idle-cpu.sh /runKit 5 --headed`
- **WHEN** the wrapper runs
- **THEN** it exits 1 with the install hint and never starts node

### Instrument: R5 inventory gap

#### R6: The `xterm=0` inventory is explained, and fixed if it is the instrument's fault
Apply MUST reproduce or attempt to reproduce the `xterm=0` reading on a tty route, test the three candidates from the intake (frame/redirect via requested-vs-landed href and visibilityState; profiler starvation; settle racing the mount), record the finding under `## Notes` in this plan, and — if the instrument is at fault — fix it in `scripts/perf-idle-cpu.mjs`. Diagnostic JSON fields (`xtermMountedAfterMs`, landed href vs requested) MAY be kept only when they earned their keep; they MUST NOT join the summary line.

- **GIVEN** the R5 investigation
- **WHEN** apply finishes
- **THEN** `## Notes` states the cause (or the best-supported hypothesis with evidence) and which fix, if any, landed

### Instrument: forced DOM renderer

#### R7: `--no-webgl` produces a deliberate DOM-renderer row
`scripts/perf-idle-cpu.mjs` MUST accept `--no-webgl` (boolean, combinable with `--headed`). When set, the Chromium launch args MUST include `--disable-webgl --disable-webgl2` so xterm's WebglAddon fails at load and the page takes the DOM renderer. `noWebgl` MUST be recorded in the JSON, shown as a `## page` row, appended to the summary line as a trailing `no-webgl` token (after `headed`), and documented in `--help`. Without the flag the launch args MUST be unchanged.

- **GIVEN** `--no-webgl` on a tty route
- **WHEN** the run ends
- **THEN** the summary line reads `xterm-renderer=dom` and ends with `no-webgl`, and `webgl warnings` reads 1 with the `unavailable at load` line

### Non-Goals
- Changing the headless launch flags — every earlier headless row must stay comparable
- New tests or e2e — the instrument is excluded from `just test` and CI by design
- Memory edits — hydrate owns `architecture/testing.md` and `ui/terminal.md`

### Design Decisions

#### Renderer kind comes from the frontend registry, not the console
**Decision**: `xterm-renderer=` is derived from `window.__rkRenderer`; the `rk: xterm WebGL` console lines are captured and reported as a cross-check with an explicit mismatch note.
**Why**: The registry is written by the same code path at the exact moment WebGL loads or fails, so it is a direct observation; the console line is the same fact one step removed and would silently break on a wording change.
**Rejected**: Console-only derivation (the plan's original wording) — indirect, and silent on a `webgl` page where nothing is logged.
*Introduced by*: 260917-lhr5-perf-idle-cpu-renderer-headed

#### Field named `xterm-renderer=`, not `renderer=`
**Decision**: The new summary field is `xterm-renderer=<kind>` placed after `xterm=<n>`.
**Why**: `renderer=<n>%` already means renderer-process CPU and is a documented fixed-order grep contract.
**Rejected**: Reusing `renderer=` — breaks every existing grep and every pasted row.
*Introduced by*: 260917-lhr5-perf-idle-cpu-renderer-headed

#### `--no-webgl` exists because headless Chromium here has WebGL
**Decision**: A `--no-webgl` switch disables WebGL in Chromium so a DOM-renderer row can be produced on demand, in headless or headed mode.
**Why**: Verification showed full-build Chromium 147 (chromium-1217) gets software WebGL headless on this box — every plain headless tty row reads `xterm-renderer=webgl`, so the plan's assumption that headless rows are DOM rows "for free" does not hold, and change 6's both-renderers acceptance needs a way to force the fallback.
**Rejected**: Leaving the DOM renderer unmeasurable (change 6 could not prove its fix for both renderers); a frontend switch (Constitution IV — no new settings surface, and the instrument must not change the page it measures).
*Introduced by*: 260917-lhr5-perf-idle-cpu-renderer-headed

## Tasks

### Phase 1: Core Implementation

- [x] T001 `scripts/perf-idle-cpu.mjs`: add `--headed` to `parseCli` + `USAGE`; branch `launchChromium` on `opts.headed` (headed adds `--enable-unsafe-swiftshader --ignore-gpu-blocklist`, headless unchanged); carry `headed` into `result`, the summary trailing token, `## page`, and JSON <!-- R4 -->
- [x] T002 `scripts/perf-idle-cpu.mjs`: console capture of `rk: xterm WebGL` lines (count + first); read `window.__rkRenderer` in `collectInventory`; derive `xtermRenderer` per the R1 table; add `xterm-renderer=` after `xterm=` in `summaryLine`, the `xterm renderer` + `webgl warnings` rows (with mismatch note) in `report`, and `inventory.xtermRenderer` / `inventory.rendererRegistry` / `webglConsole` in JSON; update `USAGE` Output paragraph <!-- R1, R2 -->
- [x] T003 `scripts/perf-idle-cpu.mjs`: tty-route detection on the sampled route (`--then` target else `<path>`, query stripped, `/board/` + `/__controls` excluded); stderr warning after the report when `.xterm` count is 0; `ttyRoute` + `warnings[]` in JSON; exit code unchanged <!-- R3 -->
- [x] T004 `scripts/perf-idle-cpu.sh`: scan `"$@"` for `--headed`; `DISPLAY` set → exec node; unset + `xvfb-run` → exec `xvfb-run -a -s "-screen 0 1920x1080x24" node …`; unset + none → stderr hint, exit 1; update the header comment <!-- R5 -->

- [x] T007 `scripts/perf-idle-cpu.mjs`: `--no-webgl` flag (`--disable-webgl --disable-webgl2` launch args, combinable with `--headed`), `noWebgl` in result/JSON, trailing `no-webgl` summary token, `## page` row, `USAGE` entry <!-- R7 -->

### Phase 2: Investigation & Verification

- [x] T005 R5: reproduce `xterm=0` on tty routes against the live daemon (`--url http://127.0.0.1:3000`, read-only); test the three candidates (requested-vs-landed href + visibilityState, profiler off, mount-time poll); record the finding in `## Notes`; fix `scripts/perf-idle-cpu.mjs` if the instrument is at fault <!-- R6 -->
- [x] T006 Verification: `node --check`, `bash -n`, `--help` smoke, the no-xvfb error path, one headless + one headed (`DISPLAY=:60` and `env -u DISPLAY`) run on the same tty route, a `/runKit` run, a forced no-terminal tty run, and a `--json` field check — summary lines pasted into `## Notes` <!-- R1, R3, R4, R5 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: The summary line carries `xterm-renderer=<kind>` right after `xterm=<n>`; `renderer=<n>%` is unchanged
- [x] A-002 R1: `--json` carries `inventory.xtermRenderer` and `inventory.rendererRegistry`; `## page` shows `xterm renderer`
- [x] A-003 R2: `rk: xterm WebGL` console lines are counted with the first line kept; `webgl warnings` row and `webglConsole` JSON present
- [x] A-004 R3: Tty-route detection matches `/$server/@N` and `/$server/N`, excludes `/board/…` and `/__controls`, strips the query string, and uses the `--then` target when present
- [x] A-005 R4: `--headed` is parsed, documented in `--help`, and switches the launch options exactly as specified
- [x] A-006 R5: The wrapper's `--headed` branch implements the three DISPLAY/xvfb-run cases with the specified message and exit 1
- [x] A-007 R6: `## Notes` records the R5 finding and the fix (or the reasoned no-fix)

### Behavioral Correctness

- [x] A-008 R1: Headless and headed runs on the same tty route each record their renderer kind on the summary line; a `--no-webgl` run on the same route reads `dom` (all lines recorded in `## Notes`)
- [x] A-009 R2: The mismatch note appears only when the console count disagrees with the registry kind
- [x] A-010 R3: A tty route with no `.xterm` at sample end prints the stderr warning after the report and exits 0; `/runKit` prints none
- [x] A-011 R4: The headless launch options are byte-identical to the pre-change `{ headless: true, channel: "chromium" }`

### Scenario Coverage

- [x] A-012 R4: The summary line's trailing `headed` token appears only on headed runs, after `reduced-motion` when both apply
- [x] A-013 R5: `env -u DISPLAY … --headed` runs under `xvfb-run`; with `DISPLAY` set no wrapping occurs

### Edge Cases & Error Handling

- [x] A-014 R1: `mixed` and `unknown` are reachable and distinct from `dom`
- [x] A-015 R5: Missing `xvfb-run` with `DISPLAY` unset exits 1 with the install hint before node starts
- [x] A-016 R3: The exit-code contract (0 / 1 / 2) is unchanged by the guard
- [x] A-021 R7: `--no-webgl` yields `xterm-renderer=dom` with one `unavailable at load` warning and no mismatch note; the trailing `no-webgl` token appears only on such runs

### Code Quality

- [x] A-017 Pattern consistency: new flags follow `parseArgs` + `USAGE` conventions; constants are named (no magic strings for the console prefix, xvfb geometry, or the route regex)
- [x] A-018 No unnecessary duplication: the `--headed` arg scan reuses the wrapper's existing `--url` loop shape; no second launch helper
- [x] A-019 Comments state constraints, not narration; no change-ID or PR citations in code comments
- [x] A-020 Justfile unchanged (Constitution VIII); no frontend or backend edits

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

### Verification (2026-09-17, live daemon :3000, Chromium 147.0.7727.15 = chromium-1217, window `@109` on server `rK`)

Gates: `node --check scripts/perf-idle-cpu.mjs` ok · `bash -n scripts/perf-idle-cpu.sh` ok · `just perf-idle-cpu --help` lists `--headed`, `--no-webgl`, `xterm-renderer=` · `env -u DISPLAY PATH=<node+bash+dirname only> scripts/perf-idle-cpu.sh /rK 5 --headed` → `perf-idle-cpu: --headed needs a display — set DISPLAY or install xvfb (apt install xvfb) for xvfb-run`, exit 1, node never started · the same PATH without `--headed` runs normally.

Summary lines (10 s idle unless noted):

```
headless           perf-idle-cpu /rK/@109 10.1s renderer=7.2% gpu=20.8% browser=0.1% main=5% recalcs=610 layouts=1 anims=7 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/terminals]=1.2msg/s,3.2kB/s ws[/ws/state]=0.3msg/s,3.7kB/s
headless (again)   perf-idle-cpu /rK/@109 10.2s renderer=10.7% gpu=9.6% browser=0% main=9.4% recalcs=598 layouts=1 anims=7 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/terminals]=0.8msg/s,2.1kB/s ws[/ws/state]=0.3msg/s,3.7kB/s
headless, no DISPLAY  perf-idle-cpu /rK/@109 10.2s renderer=7.3% gpu=14.6% browser=0% main=5.2% recalcs=617 layouts=1 anims=7 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/terminals]=1.2msg/s,3.1kB/s ws[/ws/state]=0.3msg/s,3.7kB/s
headed, DISPLAY=:60   perf-idle-cpu /rK/@109 10.1s renderer=6.9% gpu=180.6% browser=0.2% main=3.7% recalcs=602 layouts=1 anims=7 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/state]=0.4msg/s,4.1kB/s ws[/ws/terminals]=0msg/s,0kB/s headed
headed, xvfb-run      perf-idle-cpu /rK/@109 10.1s renderer=7.2% gpu=182.9% browser=0.2% main=3.8% recalcs=610 layouts=1 anims=7 xterm=1 xterm-renderer=webgl iframes=0 ws[/ws/terminals]=0.8msg/s,2.1kB/s ws[/ws/state]=0.3msg/s,3.7kB/s headed
headless --no-webgl   perf-idle-cpu /rK/@109 10.1s renderer=7.8% gpu=2.7% browser=0.1% main=3.5% recalcs=651 layouts=8 anims=7 xterm=1 xterm-renderer=dom iframes=0 ws[/ws/terminals]=2.1msg/s,5.3kB/s ws[/ws/state]=0.4msg/s,4.1kB/s no-webgl
headed --no-webgl     perf-idle-cpu /rK/@109 10.1s renderer=11.8% gpu=192.4% browser=0.2% main=5.8% recalcs=681 layouts=39 anims=7 xterm=1 xterm-renderer=dom iframes=0 ws[/ws/terminals]=19.6msg/s,51.8kB/s ws[/ws/state]=0.3msg/s,3.7kB/s headed no-webgl
server route          perf-idle-cpu /rK 8.1s renderer=4.4% gpu=1.6% browser=0% main=2.1% recalcs=70 layouts=2 anims=7 xterm=0 xterm-renderer=none iframes=0 ws[/ws/state]=0.4msg/s,4.6kB/s            (no warning, ttyRoute=false)
missing window        perf-idle-cpu /rK/@99 8.1s renderer=4.7% gpu=1.6% browser=0.1% main=2.4% recalcs=83 layouts=2 anims=7 xterm=0 xterm-renderer=none iframes=0 ws[/ws/state]=0.4msg/s,4.6kB/s ws[/ws/terminals]=0msg/s,0kB/s
   stderr: perf-idle-cpu: warning: no terminal mounted on /rK/@99 (page landed on /rK — the window probably does not exist) — not a tty measurement (xterm=0; the sidebar/server numbers are still valid)   exit 0
.xterm removed        perf-idle-cpu /rK/@109 8.1s renderer=5.9% gpu=2.2% browser=0.1% main=2.7% recalcs=96 layouts=1 anims=7 xterm=0 xterm-renderer=none iframes=0 ws[/ws/terminals]=1msg/s,2.6kB/s ws[/ws/state]=0.4msg/s,4.6kB/s   (--inject via scripts/perf-idle-cpu.sh; warning printed, exit 0)
```

`--no-webgl` runs show `webgl warnings  1 — rk: xterm WebGL unavailable at load for rK/@109 — using the DOM renderer (1 terminal mounted)` with registry `{"@109":"canvas"}` and no mismatch note; webgl runs show `0` warnings with registry `{"@109":"webgl"}`. JSON carries `headed`, `noWebgl`, `chromium`, `ttyRoute`, `xtermMountedAfterMs` (3–13 ms on every mounted run), `warnings`, `inventory.xtermRenderer`, `inventory.rendererRegistry`, `inventory.visibilityState`, `webglConsole`.

### Finding: headless Chromium on this box HAS WebGL

Three plain headless runs (with and without `DISPLAY`) read `xterm-renderer=webgl`, registry `webgl`, zero fallback warnings, GPU process 10–21 % (SwiftShader working). The plan's errata ("headless Playwright Chromium on the dev box has no WebGL … every headless launch gets the DOM renderer") does not hold for the instrument's launch (`channel: "chromium"`, the full build in new-headless mode, chromium-1217 / 147.0.7727.15). The e2e rig's default `chromium_headless_shell` is a different binary and may well lack WebGL — that is where change 4's console line "fired on every load". Consequence: a headless tty row is NOT automatically a DOM row; the renderer must be read per run (which this change makes mechanical), and a DOM row needs `--no-webgl`. The `--headed` path still matters for the Mac-comparable real-WebGL case and for any box whose headless Chromium lacks WebGL.

### R5 finding: the `xterm=0` inventory was a missing window, not an instrument fault

Loading `/rK/@99` (a window id the daemon does not have) makes the frontend land on `/rK` — the server page — and the run prints exactly the R5 signature: `xterm=0 iframes=0 ws[/ws/terminals]=0msg/s`, recalcs ≈ 80 per 8 s (≈ 300 per 30 s), renderer ≈ 5–6 %. None of the three windows named in R5 (`@99`, `@4`, `@79`) exists on the daemon today, and the two later runs that read `xterm=1` (`@4`, `@109`) came when those windows did exist. The inventory ran in the right frame (`.xterm` lives in the main frame; `visibilityState` was `visible` on every run) and the profiler/settle candidates were not needed: mount time on a live window is 3–13 ms after load. The instrument now says so itself — the guard's warning names the landed path and the JSON records `xtermMountedAfterMs: null`. No fix to the inventory was required; the guard is the permanent answer.

### Acceptance-text correction during apply

A-008 originally asserted "headless reads `dom`, headed reads `webgl`" — a premise the environment disproved. It was reworded to what the instrument must guarantee (each run records its kind; `--no-webgl` yields `dom`) before review, and R7/T007/A-021 were added for the `--no-webgl` switch. Recorded here so review sees the plan edit as deliberate.

## Deletion Candidates

None — this change adds new functionality to a standalone instrument script without making existing code redundant.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Memory edits are hydrate's, not apply tasks | Pipeline contract: apply writes code, hydrate writes `docs/memory/` | S:90 R:95 A:100 D:95 |
| 2 | Confident | The console listener stores only `rk: xterm WebGL`-prefixed messages | Intake § 1 says nothing else on the console is stored; keeps the JSON small and the contract narrow | S:80 R:95 A:90 D:85 |
| 3 | Confident | The stderr warning prints after the full report so stdout line 1 stays the summary | Intake § 2; the summary line is a grep contract | S:80 R:95 A:90 D:85 |
| 4 | Confident | `--no-webgl` (Chromium `--disable-webgl --disable-webgl2`) is added beyond the intake's flag list | Verification showed headless Chromium here has WebGL, so the intake's assumed free DOM row does not exist; change 6's both-renderers gate needs one. Small, additive, reversible; flagged in the pipeline report | S:60 R:90 A:80 D:70 |
| 5 | Confident | Diagnostic fields (`xtermMountedAfterMs`, `visibilityState`, `chromium`) stay in JSON and `## page` only, never on the summary line | Intake § 4: keep only if they earn their keep; mount time and landed href explained R5, the Chromium version makes rows comparable across installs | S:75 R:95 A:85 D:80 |
| 6 | Certain | The plain headless launch passes no `args` key at all (not an empty array) | Byte-identical launch options to before, per R4 | S:85 R:95 A:95 D:90 |

6 assumptions (2 certain, 4 confident).
