# Plan: Demo Recordings for PR Evidence

**Change**: 261007-xyk8-demo-recording-pr-evidence
**Intake**: `intake.md`

## Requirements

### Testing: Demo Recording Lane

#### R1: `just demo` runs on the throwaway e2e rig
`just demo <name>` SHALL be a one-line justfile recipe delegating to `scripts/demo.sh`, which MUST run the demo through `scripts/test-e2e.sh` with `RK_E2E_LANE=demo` — inheriting its per-worktree derived ports, isolated `rk-test-e2e-<token>-*` socket family, temp `XDG_STATE_HOME`/`RK_CONFIG_DIR`, worktree lock, and EXIT cleanup. The demo lane MUST be single-rig and MUST NOT run against a live `rk serve` or the user's default tmux server.

- **GIVEN** a worktree after `just setup`
- **WHEN** `just demo window-switch` runs
- **THEN** a dev server comes up on the worktree's derived port triple against the `rk-test-e2e-<token>-0` tmux server, the demo spec runs, and on exit the rig's servers, sockets and temp state are gone

#### R2: Demo specs are separate from the e2e suite
Demo specs SHALL live in `app/frontend/tests/demo/` as `<name>.demo.ts` and run only under `app/frontend/playwright.demo.config.ts`. `just test-e2e` MUST NOT run them, and the demo config MUST NOT pick up `tests/e2e/*.spec.ts`.

- **GIVEN** `tests/demo/window-switch.demo.ts` exists
- **WHEN** `just test-e2e` runs
- **THEN** no demo spec executes (testDir `./tests/e2e` does not reach `tests/demo/`)

#### R3: Recordings are human-watchable on desktop and mobile
The demo config SHALL record video for every test (`video: "on"`, size = viewport), run with `reducedMotion: "no-preference"`, `slowMo` ≈ 250 ms, `retries: 0`, one worker, and generous timeouts. It SHALL define two projects — `desktop` (1280×800) and `mobile` (375×812, `isMobile`, `hasTouch`) — both run by default. `--desktop-only` / `--mobile-only` SHALL narrow to one project. A demo MAY mark itself desktop-only (helper), which skips it in the mobile project.

- **GIVEN** `just demo window-switch` with no viewport flag
- **WHEN** the run completes
- **THEN** both `.demo/window-switch-desktop.webm` and `.demo/window-switch-mobile.webm` exist and show animations (not reduced-motion)

#### R4: Stable output paths
Each demo test SHALL save its video to `<repo>/.demo/<name>[-<variant>]-<project>.webm` — `<variant>` is `before`/`after` only under `--before`. The save is done by a demo fixture (`tests/demo/_demo.ts`) that closes the page and calls `video.saveAs`, driven by env vars `DEMO_OUT_DIR`, `DEMO_NAME`, `DEMO_VARIANT` that `scripts/demo.sh` exports. `.demo/` SHALL be gitignored. A demo file SHOULD contain exactly one test (the path carries no test title).

- **GIVEN** `just demo window-switch --before main --desktop-only`
- **WHEN** it completes
- **THEN** `.demo/window-switch-before-desktop.webm` and `.demo/window-switch-after-desktop.webm` exist

#### R5: Before/after against a base ref
`--before [<ref>]` SHALL record the same demo against `<ref>` and then against the working tree. Default `<ref>`: the merge-base of `HEAD` with the active change's base branch (`fab status get-base-branch`), falling back to `origin/main`, then `main`. Mechanism: a temporary detached `git worktree` at `<ref>` (removed on exit, including on failure), dependencies installed there (`pnpm install --frozen-lockfile --prefer-offline` in `app/frontend`), and the CURRENT tree's `test-e2e.sh` run with `RK_E2E_APP_ROOT=<temp worktree>` so the rig's `just dev` serves the old code while Playwright runs the current tree's demo spec. The two passes run sequentially on the same rig identity.

- **GIVEN** a branch that fixes a visible bug
- **WHEN** `just demo <name> --before` runs
- **THEN** the before video shows the base branch's behavior and the after video shows the fix, both from the identical demo script
- **AND** no temporary worktree remains registered (`git worktree list`) afterwards

#### R6: A failing before-run is reported, not hidden
If the demo fails against the base (e.g. a selector introduced by the change does not exist there), `scripts/demo.sh` SHALL print a clear `before: demo failed against <ref>` notice, still run the after pass, and exit non-zero only if the after pass fails — the before failure is reported in the summary so the agent can decide to record a different before script or state why in the PR body.

- **GIVEN** a demo whose selectors only exist after the change
- **WHEN** `--before` runs
- **THEN** the summary flags the before failure and the after recording is still produced

#### R7: PR hand-off output
On completion `scripts/demo.sh` SHALL print (a) each recorded file with size, (b) a Markdown block for the PR body — `### Before` / `### After` headings when `--before`, `**Desktop**` / `**Mobile**` labels, each video reference (`![](.demo/<file>)`) alone in its own paragraph — and (c) one `gh pr edit --attach … ` line listing every file (gh rewrites the local-path references in place). `--mp4` SHALL additionally convert each WebM to MP4 via ffmpeg and print the MP4 paths instead.

- **GIVEN** a successful two-viewport run
- **WHEN** the script ends
- **THEN** stdout carries the Markdown block with two standalone video paragraphs and a single `gh pr edit --attach .demo/…-desktop.webm --attach .demo/…-mobile.webm` line

#### R8: Example demo proves the pipeline
`app/frontend/tests/demo/window-switch.demo.ts` SHALL seed a session with three windows on the rig's tmux server, then switch between them — via the sidebar on desktop and the mobile navigation drawer on mobile — with deliberate pauses, and carry the Proves/Steps intent comment and file header required for Playwright tests by the constitution.

- **GIVEN** the rig is up
- **WHEN** the demo runs in both projects
- **THEN** both videos show at least two window switches with visible terminal content changes

### Project Docs

#### R9: Project context documents the lane
`fab/project/context.md` § Testing SHALL list `just demo` alongside the other `just` test recipes, including `--before`, viewport flags, and the `.demo/` output, and point at Constitution § PR Evidence.

- **GIVEN** an agent loading the always-load layer
- **WHEN** it reaches § Testing
- **THEN** it learns how to produce PR recordings without reading `scripts/demo.sh`

### Non-Goals

- CI integration — demos are produced on demand by the agent preparing a PR, not in CI.
- Auto-attaching from `/git-pr` — the agent runs the printed `gh pr edit --attach` line; changing fab-kit's git-pr skill is out of scope.
- Desktop-shell (Electron) recordings — the desktop lane has its own harness; a demo lane there is a follow-up.
- Multi-rig parallel demos.

### Design Decisions

#### Demo lane rides test-e2e.sh
**Decision**: Add `RK_E2E_LANE=demo` to `scripts/test-e2e.sh` (mirroring the existing `desktop` lane set by `scripts/test-desktop-e2e.sh`) instead of a new rig script.
**Why**: The rig — derived identity, lock, process-group isolation, socket sweep, temp state — is ~500 lines of hard-won edge cases; a second copy would drift.
**Rejected**: Extracting a sourced rig library (larger refactor of a load-bearing script for no behavior gain); a standalone demo rig (duplication).
*Introduced by*: 261007-xyk8-demo-recording-pr-evidence

#### Before pass serves old code, runs new script
**Decision**: The before pass runs the current tree's harness and demo spec against a dev server launched from a temporary worktree at the base ref (`RK_E2E_APP_ROOT`).
**Why**: Before and after must follow the identical script; the base ref has no demo spec, and possibly no demo lane at all.
**Rejected**: Running the base tree's own harness (no demo lane / spec there); symlinking `node_modules` into the temp worktree (Vite resolves real paths outside the root and the lockfile may differ).
*Introduced by*: 261007-xyk8-demo-recording-pr-evidence

#### Fixture saves video to a computed path
**Decision**: A `_demo.ts` fixture closes the page and `saveAs`es the video to `.demo/<name>[-variant]-<project>.webm`.
**Why**: Deterministic names without scraping Playwright's hashed output directories.
**Rejected**: Post-run globbing of `test-results-demo/**/video.webm` (directory names are title hashes; fragile).
*Introduced by*: 261007-xyk8-demo-recording-pr-evidence

## Tasks

### Phase 1: Setup

- [x] T001 Add the `demo` lane and `RK_E2E_APP_ROOT` to `scripts/test-e2e.sh`: `RK_E2E_LANE=demo` → single rig, `PLAYWRIGHT_DIR=app/frontend`, and `run_playwright` passes `--config playwright.demo.config.ts`; the single-rig `just dev` launch `cd`s into `${RK_E2E_APP_ROOT:-$REPO_ROOT}` first. Update the header comment. <!-- R1 --> <!-- R5 -->
- [x] T002 [P] Create `app/frontend/playwright.demo.config.ts` (testDir `./tests/demo`, testMatch `*.demo.ts`, desktop + mobile projects, video on at viewport size, `reducedMotion: "no-preference"`, `slowMo: 250`, timeout 120 s, retries 0, workers 1, outputDir `test-results-demo`, reuse `globalTeardown` and the external `webServer` probe via `harnessPort()`). Add `.demo/` and `app/frontend/test-results-demo/` to `.gitignore`. <!-- R2 --> <!-- R3 --> <!-- R4 -->

### Phase 2: Core Implementation

- [x] T003 Create `app/frontend/tests/demo/_demo.ts`: an extended `test` whose auto fixture saves the page video to `${DEMO_OUT_DIR}/${DEMO_NAME}[-${DEMO_VARIANT}]-${project}.webm` after the test; `beat(page, ms?)` pause helper; `desktopOnly()` that skips in the mobile project; re-export `expect`. <!-- R3 --> <!-- R4 -->
- [x] T004 Create `scripts/demo.sh`: parse `<name>`, `--before [<ref>]`, `--desktop-only`, `--mobile-only`, `--mp4`; validate `app/frontend/tests/demo/<name>.demo.ts` exists; export `DEMO_OUT_DIR`/`DEMO_NAME`/`DEMO_VARIANT`; run each pass via `RK_E2E_LANE=demo scripts/test-e2e.sh <name>.demo.ts [--project …]`; for `--before`, resolve the default ref, create a detached temp worktree, install frontend deps there, run the before pass with `RK_E2E_APP_ROOT`, remove the worktree on EXIT; report a failed before pass without aborting the after pass. <!-- R1 --> <!-- R5 --> <!-- R6 -->
- [x] T005 In `scripts/demo.sh`, emit the hand-off: file list with sizes, the Markdown block (Before/After headings, Desktop/Mobile labels, standalone video paragraphs), the single `gh pr edit --attach …` line; `--mp4` converts via ffmpeg first. Add the one-line `demo *args:` recipe to `justfile` next to `test-e2e`. <!-- R7 --> <!-- R1 -->

### Phase 3: Integration & Edge Cases

- [x] T006 Create `app/frontend/tests/demo/window-switch.demo.ts` (file header + Proves/Steps comment; seed three windows with distinct visible output via `_tmux.ts`; desktop: switch via sidebar rows; mobile: open the navigation drawer and pick windows; pauses between steps). Verify end to end: `just demo window-switch` (both viewports) and `just demo window-switch --before main --desktop-only`; confirm the files, the printed hand-off, and that no temp worktree, rig socket, or dev server is left behind. <!-- R8 --> <!-- R3 --> <!-- R5 -->

- [x] T008 In `scripts/demo.sh`: before recording, delete this run's prior outputs for `<name>` (every variant × project, `.webm` and `.mp4`) so a failed pass can never surface a stale video from an earlier run as current; scope `--mp4` conversion to the files this run recorded (not a `<name>*` glob); reject a `--before` ref that starts with `-` and pass `--` before the ref to `git worktree add`. Re-verify with a forced failing before pass that no stale before file is listed or attached. <!-- R4 --> <!-- R6 --> <!-- R7 -->

### Phase 4: Polish

- [x] T007 Update `fab/project/context.md` § Testing with the `just demo` recipe, flags, output path, and the Constitution § PR Evidence pointer. <!-- R9 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `just demo <name>` exists as a one-line recipe and runs the demo through `test-e2e.sh`'s rig with `RK_E2E_LANE=demo`
- [x] A-002 R2: demo specs live only in `app/frontend/tests/demo/` and run only under `playwright.demo.config.ts`
- [x] A-003 R3: the demo config records video with motion enabled, slowMo pacing, and desktop + mobile projects; `--desktop-only`/`--mobile-only` narrow the run
- [x] A-004 R4: videos land at `.demo/<name>[-before|-after]-<desktop|mobile>.webm`, and `.demo/` is gitignored
- [x] A-005 R5: `--before [<ref>]` records the base via a temp worktree served through `RK_E2E_APP_ROOT`, with the default ref resolved from the change's base branch
- [x] A-006 R7: the script prints the Markdown hand-off block and a single `gh pr edit --attach` line; `--mp4` converts via ffmpeg
- [x] A-007 R8: `window-switch.demo.ts` exists with intent comments and records switching on both viewports
- [x] A-008 R9: `context.md` § Testing documents `just demo`

### Behavioral Correctness

- [x] A-009 R2: `just test-e2e`'s config (testDir `./tests/e2e`) is unchanged and cannot reach `tests/demo/`
- [x] A-010 R1: the default `web` lane and the `desktop` lane of `test-e2e.sh` behave exactly as before (APP_ROOT defaults to REPO_ROOT; demo config only on the demo lane)

### Scenario Coverage

- [x] A-011 R3: an actual `just demo window-switch` run produced both desktop and mobile videos that show switching
- [x] A-012 R5: an actual `--before main` run produced before and after videos

### Edge Cases & Error Handling

- [x] A-013 R5: the temp worktree is removed on success and on failure/interrupt (EXIT trap), and `git worktree list` shows no leftover
- [x] A-014 R6: a failing before pass is reported in the summary and does not prevent the after pass
- [x] A-015 R1: an unknown demo name fails fast with the list of available demos, before any rig starts

- [x] A-021 R6: after a failed before pass, no `-before-` file from an earlier run is listed, put in the Markdown block, or attached — prior outputs for the name are cleared at run start; `--mp4` converts only this run's recordings; a dash-prefixed `--before` ref is rejected

### Code Quality

- [x] A-016 Pattern consistency: `scripts/demo.sh` follows the existing scripts' style (`set -euo pipefail`, SCRIPT_DIR, comments stating constraints) and the justfile recipe is a one-liner (Constitution VIII)
- [x] A-017 No unnecessary duplication: rig lifecycle is reused from `test-e2e.sh`, tmux seeding from `tests/e2e/_tmux.ts`, readiness from `tests/e2e/_ready.ts`
- [x] A-018 Test intent comments: the demo spec carries a file header and a Proves/Steps JSDoc block (Constitution § Test Intent Comments)
- [x] A-019 Comment discipline: no comment narration or change-ID citations in new code

### Security

- [x] A-020 R1: the demo lane never targets a non-test tmux server — the rig's allowlist/family isolation is unchanged and the demo uses `E2E_TMUX_SERVER` only

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Demo lane is added to `test-e2e.sh` (like the `desktop` lane) rather than a new rig | Existing precedent `test-desktop-e2e.sh`; avoids duplicating 500 lines | S:75 R:80 A:85 D:75 |
| 2 | Confident | Before pass: temp detached worktree + `RK_E2E_APP_ROOT`, deps via `pnpm install --frozen-lockfile --prefer-offline` | Identical script both passes; pnpm store makes install cheap; symlinked node_modules risks Vite fs issues | S:70 R:80 A:70 D:65 |
| 3 | Confident | Video saved by a fixture to a computed path, not globbed from output dirs | Deterministic naming | S:70 R:90 A:80 D:70 |
| 4 | Confident | A failing before pass is reported, not fatal | The agent still needs the after video; it can explain in the PR | S:60 R:90 A:70 D:65 |
| 5 | Confident | One test per demo file; the output path carries no test title | Keeps the naming contract simple | S:55 R:90 A:70 D:65 |
| 6 | Confident | Default before ref = merge-base(HEAD, base branch from `.status.yaml`), fallback origin/main, main | Shows exactly what the PR changes | S:65 R:90 A:75 D:70 |

6 assumptions (0 certain, 6 confident, 0 tentative).
