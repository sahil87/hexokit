# Plan: Desktop Shell Demo Recordings

**Change**: 261008-4v1f-desktop-shell-demo-recording
**Intake**: `intake.md`

## Requirements

### Demo Harness: Lane Routing

#### R1: Spec location selects the lane
`scripts/demo.sh <name>` SHALL resolve the recording lane from which spec file exists, with no new flag: `app/frontend/tests/demo/<name>.demo.ts` → web lane (behavior unchanged), `app/desktop/tests/demo/<name>.demo.ts` → shell lane, both → both lanes in one invocation (web first, then shell) with one combined Markdown block and one attach line. When neither exists it MUST fail before any rig starts, listing the available demos from both directories, each tagged with its lane. `just demo` SHALL remain the single entry point (the `justfile` recipe stays the one-liner `scripts/demo.sh {{args}}`).

- **GIVEN** only `app/desktop/tests/demo/web-tile-native.demo.ts` exists
- **WHEN** `just demo web-tile-native` runs
- **THEN** only the shell lane records and `.demo/web-tile-native-shell.webm` is produced
- **AND** no web Playwright project runs

- **GIVEN** a name with no spec in either directory
- **WHEN** `just demo nope` runs
- **THEN** it exits non-zero before starting a rig and lists `window-switch (web)` and `web-tile-native (shell)`

#### R2: Shell demo lane on the shared rig
`scripts/test-e2e.sh` SHALL gain a single-rig `RK_E2E_LANE=shell-demo` lane (one worker, `PLAYWRIGHT_DIR=app/desktop`, `--config playwright.demo.config.ts`), and `app/desktop/playwright.demo.config.ts` SHALL define a single `shell` project over `./tests/demo` (`*.demo.ts`, timeout 120 s, retries 0, workers 1, outputDir `test-results-demo`, the frontend's `global-teardown.ts`, no `webServer`/`baseURL`). The existing `desktop` e2e lane MUST NOT pick up demo specs and the shell demo lane MUST NOT pick up e2e specs.

- **GIVEN** the shell demo lane
- **WHEN** `just test-desktop-e2e` runs
- **THEN** only `tests/e2e/*.spec.ts` run; no `*.demo.ts` is collected

### Demo Harness: Shell Recording

#### R3: Private Xvfb display, always
The shell lane MUST run under its own private Xvfb via `xvfb-run -a -s "-screen 0 1280x800x24"` even when `DISPLAY` is already set, so x11grab can never capture a developer's real desktop. Before any rig starts, the shell lane MUST fail fast with a message naming what is missing when not on Linux, when `xvfb-run`/`Xvfb` is absent, or when `ffmpeg` is absent or lacks the `x11grab` input device; the message SHALL state that shell recording is Linux/Xvfb-only in v1.

- **GIVEN** a box with `DISPLAY=:0` set
- **WHEN** a shell demo records
- **THEN** ffmpeg grabs the xvfb-run display, not `:0`

- **GIVEN** `ffmpeg` is not on PATH
- **WHEN** `just demo web-tile-native` runs
- **THEN** it exits non-zero before any rig starts with a message naming ffmpeg

#### R4: Fixture-owned ffmpeg x11grab recorder
`app/desktop/tests/demo/_demo.ts` SHALL extend `test` with per-test fixtures for an isolated seeded `XDG_CONFIG_HOME`, the launched shell, the host page, and an ffmpeg x11grab recorder spawned with an argument array (never a shell string). Recording SHALL start after the host SPA is ready, and teardown SHALL stop ffmpeg gracefully (`q` on stdin, SIGINT fallback, never SIGKILL as the first resort) and wait for exit so the WebM is finalized, pass or fail. The output path SHALL be `${DEMO_OUT_DIR}/${DEMO_NAME}[-${DEMO_VARIANT}]-shell.webm`; when `DEMO_OUT_DIR`/`DEMO_NAME` are unset the recorder SHALL NOT run. Teardown SHALL close the app and remove the temp config home even after a mid-test failure. The fixture MUST NOT import the frontend's `_ready.ts` or `_demo.ts` (two Playwright copies per process are refused). It SHALL export `beat(page, ms = 1_000)` with the web fixture's semantics, and SHALL provide slowMo-like pacing (Electron launch has no `slowMo`) so shell demos match the web lane's ~250 ms action rhythm.

- **GIVEN** a shell demo whose body throws midway
- **WHEN** the test ends
- **THEN** a playable (finalized) partial WebM exists at the shell output path and the Electron app is closed

#### R5: Output naming, sweep scoping, hand-off
Shell recordings SHALL be named `.demo/<name>[-before|-after]-shell.webm` with no mobile variant. The pre-run sweep MUST be scoped to exactly the lanes × variants × projects this invocation records, built as explicit paths (no `<name>-*` glob), so a web run never deletes a shell recording and vice versa. The post-run walk SHALL include the `shell` entry so the recorded list, the Markdown block (label `**Desktop shell**`, after the web Desktop/Mobile entries, under Before/After headings with `--before`, each video in its own paragraph) and the single `gh pr edit --attach …` line cannot disagree. `--mp4` SHALL convert shell WebMs exactly as web ones.

- **GIVEN** `.demo/foo-shell.webm` from an earlier shell run and a web-only `foo` spec run now
- **WHEN** `just demo foo` (web) finishes
- **THEN** `.demo/foo-shell.webm` still exists

#### R6: `--before` for the shell lane
With `--before`, when a shell lane is recorded, `demo.sh` SHALL install and compile `app/desktop` in the temporary base worktree and run the before pass with both `RK_E2E_APP_ROOT=<before_wt>` and a shell app-dir override env var (`DEMO_SHELL_APP_DIR=<before_wt>/app/desktop`). `launchShell` in `app/desktop/tests/e2e/_shell.ts` SHALL accept an optional app-dir override that launches that tree's compiled shell with that tree's own Electron binary; with no override its behavior MUST be unchanged. A web-only `--before` MUST NOT install or compile `app/desktop`. A failing shell before pass (no `app/desktop` at the base, install/compile failure, demo failure) SHALL be reported, not fatal; only the after pass's status is the exit code.

- **GIVEN** `--before` and a shell-only spec
- **WHEN** the base tree's desktop compile fails
- **THEN** the after pass still records and the summary prints the before-failed NOTE

#### R7: Viewport flags only narrow the web lane
`--desktop-only`/`--mobile-only` SHALL narrow only the web lane. On a shell-only spec they MUST exit 2 with a clear error before any rig starts; on a both-lanes spec they narrow the web half and the shell recording still happens.

- **GIVEN** a shell-only spec
- **WHEN** `just demo web-tile-native --mobile-only` runs
- **THEN** it exits 2 with an error saying the flag narrows only the web lane

### Demo Harness: Selection Rule

#### R8: Non-blocking shell-path warning
When an invocation records no shell lane and the diff from the resolved base (the same merge-base resolution `--before` uses) to the working tree (`git diff --name-only <mb>`, so uncommitted edits count) touches a shell path, `demo.sh` SHALL print a stderr WARNING listing the touched shell paths and pointing at `app/desktop/tests/demo/<name>.demo.ts`, and SHALL NOT change the exit status. The shell path set SHALL be one named array constant (`app/desktop/src/`, `app/frontend/src/lib/shell.ts`, `app/frontend/src/lib/shell-*.ts`, `app/frontend/src/hooks/use-shell-servers.ts`, `app/frontend/src/components/desktop-shell/`, `app/frontend/src/components/web-frame-native.tsx`, `app/frontend/src/lib/popout.ts`, `app/frontend/src/hooks/use-popout.ts`, `app/frontend/src/components/popout-states.tsx`), excluding `*.test.ts(x)`. When no base resolves the warning SHALL be skipped silently. There is no reverse warning.

- **GIVEN** an uncommitted edit to `app/desktop/src/web-views.ts`
- **WHEN** `just demo window-switch` runs
- **THEN** stderr carries the WARNING naming `app/desktop/src/web-views.ts` and the exit status is the after pass's

### Demo Harness: Example Shell Demo

#### R9: `web-tile-native` example demo
`app/desktop/tests/demo/web-tile-native.demo.ts` SHALL record a native web tile opening over the SPA: seed a tmux session/window whose web tab points at a spec-owned, visually distinct guest stub (full-bleed colour + large title), navigate the host page to the window, show the guest, open the command palette (guest hides), close it (guest reappears), with `beat()` pauses; `afterAll` cleans up the session and stub. It SHALL carry the file header plus **Proves:**/**Steps:** JSDoc shape of `window-switch.demo.ts`, without change IDs or PR numbers. Running it SHALL also settle the per-page-video premise: the outcome (does Playwright per-page video include the native guest?) is recorded for hydrate.

- **GIVEN** the rig and a compiled shell
- **WHEN** `just demo web-tile-native` runs
- **THEN** `.demo/web-tile-native-shell.webm` shows the coloured guest composited over the SPA and hiding under the palette

### Project Docs

#### R10: Constitution, project docs, ignores
Constitution § PR Evidence SHALL replace the desktop-shell exemption with the selection rule (shell recording REQUIRED for diffs touching `app/desktop/src/` or shell-only SPA paths; BOTH when engines differ; no mobile variant for the shell) and a narrowed exemption for macOS-only shell behavior (`No recording: macOS-only shell behavior not recordable by just demo`), version 2.0.0 → 2.1.0, `Last Amended` 2026-10-08. `fab/project/context.md` § Testing SHALL document the shell lane; `fab/project/code-quality.md`'s PR Evidence bullet SHALL mention shell recordings; the `justfile` `demo` doc comment SHALL name both spec locations; `.gitignore` SHALL ignore `app/desktop/test-results-demo/`; `demo.sh`'s header/usage SHALL document routing, the shell output, the platform requirement, and the warning.

- **GIVEN** the amended constitution
- **WHEN** a PR touches `app/desktop/src/`
- **THEN** § PR Evidence requires a shell recording and no longer offers the blanket desktop-shell exemption

### Non-Goals

- macOS/Windows shell recording — v1 is Linux/Xvfb only; macOS-only behavior keeps an exemption.
- CI gating of demos — demos stay on demand.
- Any product-code change (`app/desktop/src/`, `app/frontend/src/`, backend).

### Design Decisions

#### Record the composited X display, not per-page video
**Decision**: The shell lane records a private Xvfb display with `ffmpeg -f x11grab`, started/stopped by the desktop demo fixture.
**Why**: The shell composites the host SPA and native web-tile guests as separate `WebContentsView`s in one window and opens popouts as separate windows; Playwright video is per page, so only a display grab shows what a user sees.
**Rejected**: Playwright `recordVideo` on `_electron.launch` — per-page; would miss the composited guest, popout windows, and native menus.
*Introduced by*: 261008-4v1f-desktop-shell-demo-recording

#### Route by spec location
**Decision**: The lane is chosen by whether the spec lives under `app/frontend/tests/demo/` or `app/desktop/tests/demo/` (both → both lanes); no `--shell` flag.
**Why**: The desktop fixture must live under `app/desktop/` anyway (no second Playwright copy per process), so location already identifies the lane.
**Rejected**: A `--shell` flag — redundant with location and easy to forget.
*Introduced by*: 261008-4v1f-desktop-shell-demo-recording

## Tasks

### Phase 1: Setup

- [x] T001 Run `just setup` (frontend deps, Playwright browsers) and install `app/desktop` deps (`cd app/desktop && pnpm install`); confirm from `app/desktop/node_modules/playwright-core` types whether `_electron.launch` accepts `slowMo` and record the answer in `## Assumptions`. <!-- R4 -->
- [x] T002 [P] Add the `shell-demo` lane to `scripts/test-e2e.sh` (case arm: `E2E_WORKERS=1`, `PLAYWRIGHT_DIR="app/desktop"`, `PLAYWRIGHT_CONFIG_ARGS=(--config playwright.demo.config.ts)`) and update both lane-listing comments. <!-- R2 -->
- [x] T003 [P] Create `app/desktop/playwright.demo.config.ts` (single `shell` project, testDir `./tests/demo`, testMatch `*.demo.ts`, timeout 120 s, retries 0, workers 1, fullyParallel false, outputDir `test-results-demo`, globalTeardown `../frontend/tests/e2e/global-teardown.ts`, no webServer/baseURL; header comment in the style of the two sibling configs). Add `app/desktop/test-results-demo/` to `.gitignore`. <!-- R2 --> <!-- R10 -->

### Phase 2: Core Implementation

- [x] T004 In `app/desktop/tests/e2e/_shell.ts`, give `launchShell` an optional app-dir override (`launchShell(configHome, { appDir? })` → `cwd: appDir`, `executablePath` = that tree's `node_modules/electron` binary) with the default path unchanged; document the constraint in the module header. <!-- R6 -->
- [x] T005 Create `app/desktop/tests/demo/_demo.ts`: extended `test` with fixtures for temp seeded config home, launched app (honouring `DEMO_SHELL_APP_DIR`), host page (ready-gated), and the ffmpeg x11grab recorder (argument-array spawn on `process.env.DISPLAY`, 1280x800, `-draw_mouse 0`, WebM/VP9 output to the § R4 path, graceful `q` → SIGINT stop with bounded wait, skipped when `DEMO_OUT_DIR`/`DEMO_NAME` unset); `beat()`; a slowMo-like pacing helper; local `READY_TIMEOUT`/`openPalette` mirrors; never imports frontend `_ready.ts`/`_demo.ts`. File header comment stating the constraints. <!-- R4 --> <!-- R3 -->
- [x] T006 Rework `scripts/demo.sh` routing: resolve web/shell spec existence per R1 (both → both lanes), the two-directory "unknown demo" listing with lane tags, R7 flag validation (exit 2 on shell-only), the R3 platform guard (only when a shell lane is recorded), and a `run_shell_pass` that compiles `app/desktop` (shared helper with `scripts/test-desktop-e2e.sh` if it reads cleaner) then runs `xvfb-run -a -s "-screen 0 1280x800x24" env … RK_E2E_LANE=shell-demo scripts/test-e2e.sh <name>.demo.ts`. <!-- R1 --> <!-- R3 --> <!-- R7 -->
- [x] T007 In `scripts/demo.sh`, scope the pre-run sweep to explicit lane × variant × project paths, and extend the post-run walk (recorded list, `--mp4`, Markdown with `**Desktop shell**` label, attach line) with the `shell` entry. <!-- R5 -->

### Phase 3: Integration & Edge Cases

- [x] T008 In `scripts/demo.sh` `--before`: when a shell lane is recorded, install + compile `app/desktop` in the temp worktree and run the shell before pass with `RK_E2E_APP_ROOT` and `DEMO_SHELL_APP_DIR`; failures reported, not fatal; web-only `--before` untouched. <!-- R6 -->
- [x] T009 In `scripts/demo.sh`, add the `SHELL_PATHS` array constant and the non-blocking R8 warning (diff working tree vs the resolved merge-base; skip silently when unresolvable; `*.test.ts(x)` excluded). Factor the base-ref resolution so `--before` and the warning share it. <!-- R8 -->
- [x] T010 Create `app/desktop/tests/demo/web-tile-native.demo.ts` per R9 (visually distinct guest stub, seeded window, palette hide/show, beats, cleanup; header + Proves/Steps JSDoc). Run `just demo web-tile-native`; extract frames with ffmpeg and inspect them to confirm the guest is composited and hides under the palette. Spike: also record the same scene with Playwright per-page video once (throwaway, not committed) and note in `## Assumptions` whether it includes the native guest. <!-- R9 --> <!-- R4 -->
- [x] T011 Verify end to end: `just demo web-tile-native --before` (base lacks a shell demo lane — confirm graceful before pass handling), `just demo window-switch --desktop-only` (web lane unchanged, no shell-file deletion, warning absent on a clean tree, present with a scratch edit to a shell path then reverted), `just demo web-tile-native --mobile-only` (exit 2), an unknown name (both-dir listing), and `just test-desktop-e2e` still collecting only e2e specs. Confirm no temp worktree, Xvfb, ffmpeg, rig socket, or dev server is left behind. `bash -n` both scripts. <!-- R1 --> <!-- R2 --> <!-- R3 --> <!-- R5 --> <!-- R6 --> <!-- R7 --> <!-- R8 -->

### Phase 4: Polish

- [x] T012 Amend `fab/project/constitution.md` § PR Evidence per R10 (2.0.0 → 2.1.0, Last Amended 2026-10-08); update `fab/project/context.md` § Testing (shell lane paragraph + both spec locations), the `fab/project/code-quality.md` PR Evidence bullet, the `justfile` `demo` doc comment, and `scripts/demo.sh` header/usage. <!-- R10 -->

## Execution Order

- T001 precedes T010/T011 (deps needed to run anything).
- T004 blocks T005; T005 blocks T010.
- T006 blocks T007, T008, T009.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `demo.sh` routes by spec location — frontend-only → web, desktop-only → shell, both → both lanes in one invocation with one Markdown block and one attach line; neither → pre-rig failure listing both directories' demos with lane tags
- [x] A-002 R2: `RK_E2E_LANE=shell-demo` exists in `scripts/test-e2e.sh` (single worker, app/desktop, demo config) and `app/desktop/playwright.demo.config.ts` defines one `shell` project over `tests/demo`
- [x] A-003 R3: The shell pass always runs under `xvfb-run -a -s "-screen 0 1280x800x24"` regardless of an ambient `DISPLAY`, and the platform guard fails fast naming the missing piece
- [x] A-004 R4: The desktop `_demo.ts` fixture owns ffmpeg (argument array, starts after SPA ready, graceful stop, finalized WebM pass or fail), writes the R5 path, skips recording without `DEMO_OUT_DIR`/`DEMO_NAME`, and provides `beat()` plus slowMo-like pacing
- [x] A-005 R5: Shell outputs are `.demo/<name>[-before|-after]-shell.webm`; the sweep is explicit-path and lane-scoped; Markdown and attach line include the shell entry; `--mp4` converts it
- [x] A-006 R6: `--before` with a shell lane compiles the base tree's `app/desktop` and launches the base shell via `DEMO_SHELL_APP_DIR`; `launchShell` defaults are unchanged; web-only `--before` does no desktop install
- [x] A-007 R7: `--desktop-only`/`--mobile-only` narrow only the web lane and exit 2 on a shell-only spec
- [x] A-008 R8: The `SHELL_PATHS` constant and non-blocking warning exist; the warning lists touched shell paths and never changes the exit status
- [x] A-009 R9: `web-tile-native.demo.ts` exists with header + Proves/Steps JSDoc and produces a recording showing the composited guest and its palette hide/show
- [x] A-010 R10: Constitution § PR Evidence carries the selection rule and macOS-only exemption at 2.1.0; context.md, code-quality.md, justfile comment, `.gitignore`, and `demo.sh` usage are updated

### Scenario Coverage

- [x] A-011 R1: `just demo web-tile-native` was run and produced `.demo/web-tile-native-shell.webm`; an unknown name was run and listed both lanes
- [x] A-012 R5: A web-only run left a pre-existing same-name `-shell.webm` untouched
- [x] A-013 R8: The warning was observed with a (reverted) scratch edit to a shell path and absent on a clean tree
- [x] A-014 R9: Frames extracted from the shell recording were inspected and show the guest composited over the SPA; the per-page-video spike outcome is recorded in plan `## Assumptions`

### Edge Cases & Error Handling

- [x] A-015 R4: A demo failing mid-body still leaves a finalized partial WebM and no orphaned Electron/ffmpeg/Xvfb process
- [x] A-016 R6: A failing shell before pass (e.g. base without `app/desktop/tests/demo` support) is reported with the NOTE and the after pass still records; the temp worktree is removed
- [x] A-017 R2: `just test-desktop-e2e` collects no `*.demo.ts` and the web demo lane collects no desktop specs

### Code Quality

- [x] A-018 Pattern consistency: New script/fixture code follows the existing `demo.sh`, `test-e2e.sh`, `_shell.ts`, and frontend `_demo.ts` structure and comment style
- [x] A-019 No unnecessary duplication: Rig, launch, seeding, and compile logic are reused (not reimplemented); base-ref resolution is shared between `--before` and the warning
- [x] A-020 Thin Justfile (Constitution VIII): the `demo` recipe remains a one-liner delegating to `scripts/demo.sh`
- [x] A-021 Process execution: ffmpeg and every subprocess are spawned with argument arrays, never shell strings, and waits are bounded
- [x] A-022 Magic values: the shell path set, Xvfb geometry, and pacing interval are named constants
- [x] A-023 Comment discipline: comments state constraints (private display, graceful stop, no second Playwright copy), never narrate or cite change IDs/PR numbers
- [x] A-024 Test intent comments: the new demo spec carries the file header plus Proves/Steps JSDoc

### Security

- [x] A-025 R3: Shell recording never captures a real user display (private Xvfb always), and the demo name/ref validation that guards shell argv is preserved for the new paths

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant. The one pre-existing duplication it touched (the inline desktop install+compile block in `scripts/test-desktop-e2e.sh`) was already factored into the new shared `scripts/compile-desktop.sh` by the change itself.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Lane env name is `shell-demo` and the override env var is `DEMO_SHELL_APP_DIR` | Intake left both names as apply-time details; these follow the existing `RK_E2E_LANE`/`DEMO_*` naming | S:70 R:90 A:80 D:70 |
| 2 | Confident | Verification is by running the demos end to end and inspecting extracted frames, not new unit tests | The shipped web harness was verified the same way; demo.sh/fixtures are harness code exercised by running them | S:65 R:85 A:75 D:65 |
| 3 | Confident | `launchShell`'s override derives `executablePath` from the override tree's `node_modules/electron` | "The base ref's own Electron binary" from the intake; Playwright's `_electron.launch` takes `executablePath` | S:75 R:85 A:70 D:70 |
| 4 | Certain | `_electron.launch` has no `slowMo`; pacing is `beat()` plus a `pace()` helper (`PACE_MS = 250`) in the desktop demo fixture | Verified against the installed playwright-core 1.63.0 types — the `Electron.launch` options object has no `slowMo` key (only `BrowserType.launch`'s `LaunchOptions` does) | S:95 R:90 A:90 D:85 |
| 5 | Confident | The desktop compile step is factored into a shared helper, `scripts/compile-desktop.sh <dir> [frozen]`, used by both `scripts/test-desktop-e2e.sh` (plain) and `scripts/demo.sh` (plain for this tree, `frozen` for the --before temp worktree) | Intake left the factoring as an apply-time call; three inline copies would drift, and the frozen install flavor differs deliberately | S:80 R:90 A:80 D:75 |
| 6 | Confident | ffmpeg flags: `-framerate 25 -draw_mouse 0 -c:v libvpx-vp9 -b:v 0 -crf 34 -deadline realtime -pix_fmt yuv420p`, output WebM | Intake sketched these as the apply-time detail; verified libvpx-vp9 + x11grab present on this box, and the produced WebM plays back cleanly (frame inspection) | S:85 R:90 A:85 D:80 |
| 7 | Certain | Per-page-video spike outcome: Playwright `recordVideo` on `_electron.launch` does NOT include the native guest in the host page's video — the premise holds | Spike ran the web-tile-native scene with `recordVideo` (throwaway spec, deleted): the host page's video shows a blank white rect where the guest is drawn; the guest's own webContents gets a SEPARATE video file; popouts/menus would need more still. x11grab captures all of it in one file | S:95 R:85 A:85 D:85 |

7 assumptions (2 certain, 5 confident, 0 tentative).
