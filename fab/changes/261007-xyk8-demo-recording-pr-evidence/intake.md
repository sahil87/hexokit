# Intake: Demo Recordings for PR Evidence

**Change**: 261007-xyk8-demo-recording-pr-evidence
**Created**: 2026-10-08

## Origin

> Add a video for every feature / bug you work on (where applicable) to the PR body so I can check it before merging — if you want to create a quick playwright based tool to be able to set up a harness and throwaway tmux servers for your tests — do that.

Conversational (`/fab-discuss` session). The same discussion also reframed Constitution II: the user clarified that "no state of its own" was always shorthand for *recoverability* — the daemon must survive dying — not a ban on in-memory state. Both constitution amendments were applied via `/fab-setup constitution` in the working tree before this change was created and ship with it (v1.15.3 → 2.0.0).

Key decisions from the conversation:
- Recordings go **directly into the PR body as GitHub attachments**, not into any repo. Verified online and locally: `gh` ≥ 2.99.0 (2026-09-01) added `--attach` to `gh pr create|edit|comment` (and the `gh issue` equivalents); local `gh` is 2.101.0. Supported: PNG/JPEG/GIF/WebP/SVG/MP4/MOV/WebM. A body reference to the local path (e.g. `![](./demo.webm)`) is rewritten in place to the uploaded asset; unreferenced attachments are appended. Video renders as a player only when its reference stands alone in its paragraph. Requires push access.
- Rejected: a separate `sahil87/hexokit-media` repo, a `pr-media` prerelease, an orphan branch — all made moot by `gh --attach`.
- The throwaway harness largely exists (`just test-e2e` / `scripts/e2e-env.sh`): per-worktree derived ports, isolated `rk-test-e2e-<token>-*` tmux socket family, per-run temp `XDG_STATE_HOME`. The new tool reuses it rather than building a new one.
- Existing e2e specs are NOT reused as demos: they run fast under `reducedMotion: "reduce"` with 10 s timeouts — unwatchable and they hide the very transitions a reviewer needs to see.

## Why

The user reviews PRs before merging and cannot see UI behavior from a diff. Agents create PRs autonomously (`/git-pr`, no prompts), so the evidence must be produced by the agent, not dragged in by hand. Without a one-command recorder, the new Constitution § PR Evidence rule is unenforceable in practice — every agent would improvise its own Playwright invocation, against whichever server it finds (risking a live `rk serve` or the user's own tmux server).

A harness-backed recorder gives one blessed path: deterministic, isolated, watchable output at a known location, ready for `gh pr edit --attach`.

## What Changes

### Constitution and project docs (already in working tree)

- `fab/project/constitution.md` → **2.0.0**:
  - Principle II renamed **Disposable Daemon**: the daemon must be killable at any instant and rebuild from durable sources (tmux, filesystem, git, `gh`). In-memory state is allowed for speed under two rules: **durable before acknowledged** (daemon-originated writes reach a durable source before the request succeeds; no write-behind) and **external writes win** (fab-kit, agent hooks, `wt`, user `tmux` commands; the in-memory copy reconciles and yields). Ephemeral process state exempt. No database server / ORM / migrations. Recovery-backup + seed-cache carve-outs and the whose-state paragraph retained. MAJOR bump because Principle II's meaning changed.
  - New Additional Constraint **PR Evidence**: user-visible web UI / desktop changes MUST carry a `just demo` recording against a throwaway rig, attached via `gh pr create --attach` / `gh pr edit --attach`, standalone paragraph; bug fixes MUST show before (base branch) and after where the bug is visible; recordings MUST cover desktop AND mobile viewports unless the surface doesn't render on mobile (e.g. the desktop shell); exempt changes state `No recording: <reason>`.
- `fab/project/context.md` and `fab/project/code-quality.md`: the "no in-memory caches" lines replaced to match; code-quality gains a PR Evidence bullet.

### `just demo <name>` recipe

Thin one-line justfile recipe (Constitution VIII) delegating to `scripts/demo.sh`:

```
# Record a demo spec (tests/demo/<name>.demo.ts) on this worktree's throwaway rig → .demo/<name>.webm
demo *args:
    scripts/demo.sh {{args}}
```

### `scripts/demo.sh`

- Reuses the e2e rig lifecycle from `scripts/test-e2e.sh` / `scripts/e2e-env.sh` (derived ports, isolated tmux socket family, temp `XDG_STATE_HOME`, the per-worktree flock) — factor shared start/stop into a sourced helper if needed rather than duplicating 500 lines. Never touches a live `rk serve` or the user's default tmux server.
- Runs Playwright with a dedicated config (e.g. `app/frontend/playwright.demo.config.ts`) whose `testDir` is `tests/demo/`, so demos never run under `just test-e2e`, and `tests/e2e/` never runs under `just demo`.
- After the run, copies each test's recorded video to a stable gitignored path: `.demo/<name>.webm` (or `.demo/<name>-<test-slug>.webm` when a file has several tests).
- Prints the ready-to-run attach line and the standalone Markdown paragraph, e.g.:
  ```
  Recorded: .demo/window-switch.webm (1.8 MB, 9.4 s)
  Attach:   gh pr edit --attach .demo/window-switch.webm
  ```
- **Viewports**: by default every demo runs twice — `desktop` (1280×800) and `mobile` (375×812, coarse pointer / touch) — as two Playwright projects. `--desktop-only` / `--mobile-only` narrow it (for desktop-shell-only surfaces). A demo spec may also declare itself desktop-only so the default does the right thing.
- **Before/after (`--before [<ref>]`)**: records the same demo against the base (default: merge-base with the change's base branch from `.status.yaml`, else `main`) as well as the working tree. Mechanism: create a temporary detached `git worktree` at `<ref>` (under the scratch/tmp area, removed on exit), bring up a second throwaway rig served from that tree (its own derived ports/socket family — worktree token differs), and run the CURRENT tree's demo spec against it, so before and after execute the identical script. Dependencies in the temp worktree: reuse the current worktree's `app/frontend/node_modules` (symlink) when the lockfile is unchanged between the refs, else run the setup step there; the Go backend builds at `<ref>`. If the base can't run the demo (e.g. the selector it drives doesn't exist yet), the script reports it clearly rather than recording a broken video.
- **Output naming**: `.demo/<name>-{before,after}-{desktop,mobile}.webm` (the `before`/`after` segment present only with `--before`; e.g. `.demo/window-switch-desktop.webm` without it).
- **PR snippet**: the script prints a ready Markdown block — a `### Before` / `### After` heading pair (when `--before`), each with `Desktop` / `Mobile` labels and each video reference alone in its own paragraph — plus the `gh pr edit --attach …` command listing every file, so the local-path references get rewritten in place by gh.
- Optional `--mp4` flag converts via ffmpeg (available on the box) for players that dislike WebM; WebM is the default since `gh --attach` accepts it.

### Demo Playwright config

- `video: "on"` with an explicit size matching the viewport.
- `contextOptions: { reducedMotion: "no-preference" }` — show real transitions.
- Two projects: `desktop` (1280×800) and `mobile` (375×812, `hasTouch`, `isMobile`), both on by default.
- Human pacing: `launchOptions.slowMo` (~250 ms) plus generous timeouts; `retries: 0`, one worker.
- A tiny demo helper (e.g. `tests/demo/_demo.ts`) for pauses/captions between steps, reusing the e2e harness helpers (`_harness.ts`, `_ready.ts`) for seeding tmux sessions.

### Example demo

`app/frontend/tests/demo/window-switch.demo.ts`: seed a session with 2–3 windows on the throwaway tmux server, open the app, switch between windows (sidebar on desktop; the mobile drawer on mobile) with pauses — proves the pipeline end to end on both viewports, and `--before` against `main` proves the before/after path and doubles as the reference for future demos. Carries the same Proves/Steps intent comment shape as e2e tests (Constitution § Test Intent Comments).

### `.gitignore`

Add `.demo/` and Playwright's demo output dir.

## Affected Memory

- `run-kit/architecture/testing`: (modify) document the `just demo` lane — demo config, `tests/demo/`, rig reuse, output path, the `gh --attach` hand-off
- `run-kit/build-and-release`: (modify) only if it documents the justfile recipe inventory — add `demo`

## Impact

- New: `scripts/demo.sh`, `app/frontend/playwright.demo.config.ts`, `app/frontend/tests/demo/` (helper + one demo).
- Modified: `justfile` (one recipe), `.gitignore`, possibly `scripts/test-e2e.sh` (extract shared rig start/stop into a sourced helper), `fab/project/{constitution,context,code-quality}.md` (already done).
- No backend or product UI code changes. No CI change (demos are run on demand by agents, not in CI).

## Open Questions

- None blocking. Exact node_modules reuse heuristic for the `--before` worktree (symlink vs install) is an apply-time detail.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Recordings are attached to the PR body via `gh pr create/edit --attach`, never committed or hosted elsewhere | Discussed — user asked for in-body videos; verified gh 2.101.0 supports `--attach` | S:95 R:85 A:95 D:95 |
| 2 | Certain | Reuse the existing e2e throwaway rig (derived ports, isolated tmux socket family, temp XDG_STATE_HOME) instead of a new harness | Discussed — rig already provides exactly the isolation asked for | S:85 R:75 A:90 D:90 |
| 3 | Confident | Demo specs live in `app/frontend/tests/demo/` under a separate Playwright config, excluded from `just test-e2e` | Discussed — e2e specs run reduced-motion/fast and are unwatchable; separation keeps the test suite unaffected | S:80 R:80 A:80 D:70 |
| 4 | Confident | Default output is WebM at `.demo/<name>.webm` (gitignored); `--mp4` optional via ffmpeg | gh --attach accepts WebM; Playwright records WebM natively; ffmpeg present | S:70 R:90 A:80 D:70 |
| 5 | Certain | Desktop 1280×800 AND mobile 375×812 recorded by default; `--desktop-only`/`--mobile-only` narrow; slowMo ~250 ms, reducedMotion no-preference | Discussed — user: "mobile view wherever applicable"; constitution now requires both unless the surface doesn't render on mobile | S:90 R:85 A:85 D:80 |
| 6 | Confident | Constitution amendment ships in this change as 2.0.0 (MAJOR, Principle II meaning changed) | Discussed — user chose to bundle both amendments; fab-setup rules make a fundamental principle change MAJOR | S:85 R:80 A:85 D:75 |
| 7 | Confident | Shared rig start/stop is factored out of test-e2e.sh into a sourced helper rather than duplicated | Constitution VIII + code-quality anti-duplication; exact seam decided at apply | S:60 R:70 A:70 D:60 |
| 8 | Confident | `--before [<ref>]` is in scope: temp detached worktree at the base ref, second throwaway rig served from it, the current tree's demo spec run against both | Discussed — user: "before and after recording both for bugs"; running the same spec against both guarantees an identical script | S:85 R:70 A:70 D:65 |
| 9 | Confident | One example demo (sidebar window switch) proves the pipeline end to end | Discussed — the jitter investigation makes window-switch the natural first demo | S:75 R:90 A:80 D:75 |

9 assumptions (3 certain, 6 confident, 0 tentative, 0 unresolved).
