# Intake: Desktop Shell Demo Recordings

**Change**: 261008-4v1f-desktop-shell-demo-recording
**Created**: 2026-10-08

## Origin

> Extend `just demo` PR-evidence recordings to the Electron desktop shell.

Conversational: the design was worked out in a discussion before this change was created, then dispatched promptlessly (`/fab-proceed` → `promptless-defer`). The description passed in was synthesized from that discussion and carried nine agreed decisions, reproduced verbatim in § What Changes and graded in § Assumptions. No questions were asked at intake.

This change builds on the shipped change `261007-xyk8-demo-recording-pr-evidence` (PR #1079), which built the web harness: `scripts/demo.sh`, `app/frontend/playwright.demo.config.ts`, `app/frontend/tests/demo/{_demo.ts,window-switch.demo.ts}`, the `RK_E2E_LANE=demo` lane in `scripts/test-e2e.sh`, `RK_E2E_APP_ROOT` for `--before`, and Constitution § PR Evidence. Decisions inherited from that change and not reopened: recordings go into the PR body as `gh pr create/edit --attach` attachments and are never committed; the throwaway e2e rig is reused, never reimplemented; demos are separate from e2e specs (they run with motion on and human pacing); WebM is the default output, `--mp4` is optional; and before/after runs the current tree's spec against both refs.

Key points from the discussion:
- The user wants a desktop-shell recording harness **for changes that need desktop-level features**. Plain UI changes keep the existing web harness, which is cheaper. Using the shell for simple UI changes would be overkill.
- Capture uses **ffmpeg x11grab on an Xvfb display**, not Playwright `recordVideo`. The rationale is reasoned, not yet verified (see § What Changes 1).
- The lane is chosen by **where the spec lives**. There is no new flag.
- The selection rule is a mechanical path-based floor. Its tradeoff (a frontend change that only breaks in the shell can be missed) was accepted explicitly.
- v1 is **Linux/Xvfb only**. The constitution exemption narrows to macOS-only shell behavior; it does not go away.

## Why

**Problem.** Constitution § PR Evidence requires a `just demo` recording for every user-visible web-UI change, but it exempts desktop-shell changes outright: *"Desktop-shell changes are out of scope until `just demo` gains an Electron recording path; their PRs state `No recording: desktop shell recording not yet supported by just demo`."* So the shell's most visual and error-prone behavior ships with no visual evidence. That covers native web-tile guests composited over the SPA, popout windows, host switching, shell menus, and chord forwarding. The user reviews PRs before merging and cannot see this behavior in a diff. Agents create PRs autonomously, so the evidence has to come from the agent through one blessed command.

**Consequence if we don't.** Shell PRs keep merging unwatched. The exemption also becomes a loophole: any change can claim "shell" to skip a recording, and nothing mechanical says when a shell recording is owed.

**Why this approach.**
- *Reuse the existing Electron e2e lane.* `app/desktop/tests/e2e/_shell.ts` already launches the compiled shell through Playwright `_electron.launch`. It seeds a two-host `hosts.json` under an isolated `XDG_CONFIG_HOME`, passes `--no-sandbox`, and has a `GuestStub`. `scripts/test-desktop-e2e.sh` already runs under `xvfb-run -a` when headless. `RK_E2E_LANE=desktop` already rides the per-worktree throwaway rig (derived ports, isolated tmux socket family, per-run temp state, per-worktree lock, EXIT cleanup). `scripts/demo.sh` already handles `--before`, `--mp4`, and the PR-body/attach hand-off. The missing piece is a recorder that sees what a user sees.
- *Capture the X display, not per-page video.* Playwright video is recorded per webContents/page. The shell composites the host SPA and each native web-tile guest as **separate `WebContentsView` children of one `BrowserWindow`** (`app/desktop/src/main.ts`: one persistent WebContentsView per (window, host); guests in `app/desktop/src/web-views.ts`). Per-page video would therefore capture the SPA without the native guest drawn over it. It would also miss popout windows (a separate `BrowserWindow`) and native menus (OS-level popups). Those are the shell-specific behaviors worth recording. Grabbing the whole Xvfb screen captures the composited result, extra windows, and menus together.
- *Rejected: Playwright `recordVideo` on `_electron.launch`.* It is per-page, as above.
- *Rejected: a new `--shell` flag.* Routing by spec location is required anyway. The shell demo fixture has to live under `app/desktop/` because the desktop lane must never load the frontend's `@playwright/test` copy (Playwright refuses two physical copies in one process, per the comment in `app/desktop/playwright.config.ts`). Once the spec's location identifies the lane, a flag would be redundant.
- *Rejected: using the shell lane for every UI change.* It is slower: it compiles Electron, launches the shell, and runs Xvfb. A browser recording covers plain UI changes just as well.

## What Changes

### 1. Recording mechanism: ffmpeg x11grab on a private Xvfb display

The shell lane records the X display that the Electron shell renders into:

- The shell pass **always** runs under its own private Xvfb via `xvfb-run -a`, even when `DISPLAY` is already set. On a developer box with a real display, x11grab would otherwise record the user's real desktop: other windows, notifications, possibly private content. Recording a private display keeps the output deterministic and private. (`scripts/test-desktop-e2e.sh` only uses xvfb-run when `DISPLAY` is unset. The demo lane deliberately differs.)
- Xvfb screen geometry: `xvfb-run -a -s "-screen 0 1280x800x24"`. This box's xvfb-run defaults to `-screen 0 1280x1024x24`. The shell's default window is 1280×800 (`createWindow` in `app/desktop/src/main.ts`: `width: bounds?.width ?? 1280, height: bounds?.height ?? 800`), and a seeded config home has no `windows.json`, so a cold start opens one 1280×800 window. A screen that matches the window size makes a full-screen grab equal to the window.
- ffmpeg invocation, spawned with an **argument array** (never a shell string), roughly:
  ```
  ffmpeg -y -f x11grab -draw_mouse 0 -framerate 25 -video_size 1280x800 -i "$DISPLAY" \
         -c:v libvpx-vp9 -b:v 0 -crf 34 -deadline realtime -pix_fmt yuv420p <out>.webm
  ```
  libvpx, libvpx-vp9, and libx264 are all available in this box's ffmpeg, and its x11grab device is present. `-draw_mouse 0` is used because Playwright drives input through CDP/`sendInputEvent`, so the X cursor never moves and would just sit as a stray pointer. Exact codec flags are an apply-time detail. The output MUST be WebM so the existing `--mp4` conversion and `gh --attach` work unchanged.
- **Stopping cleanly:** send `q` on ffmpeg's stdin, falling back to SIGINT, and wait for it to exit so the WebM container is finalized. SIGKILL leaves a truncated file. A demo that fails still saves its partial recording, matching the web fixture ("a broken demo still leaves its partial recording").
- **Ownership:** the shell demo fixture (TypeScript, per test) starts and stops ffmpeg, not `scripts/demo.sh`. The fixture knows when the shell window is up and when the test ends, so the recording brackets exactly the demo and excludes rig startup and Electron compile time. This also follows the web fixture's pattern, where the fixture owns the output naming contract. Recording starts once the host view's SPA is ready, followed by one `beat()` before the first action. This avoids a black, pre-launch Xvfb screen at the start of the video.
- **Premise to verify:** the claim that Playwright's per-page `recordVideo` would miss the native guest is reasoned from how Playwright records, not observed. Apply SHOULD run a quick spike: record one native-web-tile scene both ways and compare. The example demo in § 5 is the natural test case. Even if per-page video turned out to include the guest, x11grab is still required for popout windows and native menus, so the decision does not depend on the spike. Record the outcome in the memory hydrate.

### 2. Routing by spec location (no new flag)

- Shell demos live at `app/desktop/tests/demo/<name>.demo.ts`.
- Web demos stay at `app/frontend/tests/demo/<name>.demo.ts`.
- `scripts/demo.sh <name>` resolves the lane from which file exists:
  - Only the frontend spec exists → web lane (today's behavior, unchanged).
  - Only the desktop spec exists → shell lane.
  - **Both exist** (the "record BOTH" case from § 4) → one invocation records both lanes: the web projects first, then the shell. The output is one combined Markdown block and one `gh pr edit --attach …` line.
  - Neither exists → the existing "unknown demo" error, listing available demos from **both** directories, each tagged with its lane.
- **Pre-run sweep scoping (bug to avoid).** Today's script runs `rm -f "$OUT_DIR/$name"-*.webm "$OUT_DIR/$name"-*.mp4` before recording. Two separate invocations could otherwise produce the same name (a web `foo` and a shell `foo`), and the web run's sweep would delete `foo-shell.webm`. The sweep MUST therefore be scoped to the lanes and variants this invocation records. The web lane removes `<name>[-before|-after]-{desktop,mobile}.*`, and the shell lane removes `<name>[-before|-after]-shell.*`. Build the paths explicitly, as the existing post-run walk already does, rather than with a broad glob.
- **New `scripts/test-e2e.sh` lane:** add `RK_E2E_LANE=shell-demo` (name is an apply-time detail), with `E2E_WORKERS=1`, `PLAYWRIGHT_DIR="app/desktop"`, and `PLAYWRIGHT_CONFIG_ARGS=(--config playwright.demo.config.ts)`. This mirrors the existing `demo` lane. Update the header comment that lists the lanes.
- **New `app/desktop/playwright.demo.config.ts`:** `testDir: "./tests/demo"`, `testMatch: "*.demo.ts"`, `timeout: 120_000`, `retries: 0`, `fullyParallel: false`, `workers: 1`, `outputDir: "test-results-demo"`, `globalTeardown: "../frontend/tests/e2e/global-teardown.ts"` (as in the desktop e2e config). It has one project, `shell`, with no `webServer` block and no `baseURL`, consistent with `app/desktop/playwright.config.ts`. `just test-desktop-e2e` keeps `testDir: "./tests/e2e"`, so demos never run in the e2e lane and e2e specs never run under `just demo`.
- **Before the shell pass**, `demo.sh` compiles the shell exactly as `scripts/test-desktop-e2e.sh` does: `( cd app/desktop && { [ -d node_modules ] || pnpm install; } && pnpm run compile )`. Factor this into a small shared helper rather than duplicating it if that reads cleaner (apply-time call).
- **Viewport flags:** `--desktop-only` / `--mobile-only` narrow only the web lane. On a shell-only spec they have nothing to narrow and exit 2 with a clear error. On a both-lanes spec they narrow the web half, and the shell recording still happens.
- **Platform guard:** the shell lane fails fast, before any rig starts, if any of the following holds: not on Linux (`uname -s` ≠ `Linux`); `xvfb-run` or `Xvfb` missing; `ffmpeg` missing or without x11grab. The message names what is missing and says shell recording is Linux/Xvfb-only in v1.

### 3. Output naming: `shell` suffix, no mobile variant

The web harness's `desktop` Playwright project already means the 1280×800 browser viewport, so shell recordings use a distinct suffix:

```
.demo/<name>-shell.webm                 # plain run
.demo/<name>-before-shell.webm          # --before, base ref
.demo/<name>-after-shell.webm           # --before, working tree
```

There is no mobile variant for the shell. The shell fixture writes `${DEMO_OUT_DIR}/${DEMO_NAME}[-${DEMO_VARIANT}]-shell.webm`, reusing the same three env vars `scripts/demo.sh` already exports. When `DEMO_OUT_DIR`/`DEMO_NAME` are unset (an ad-hoc run), the fixture skips the save, as the web fixture does. `--mp4` converts the shell WebM exactly like the web ones.

PR-body Markdown: the shell recording gets the label `**Desktop shell**`. It goes after the web `**Desktop**`/`**Mobile**` entries in the same group, and under the `### Before` / `### After` headings when `--before` is set. Each video reference stands alone in its own paragraph so it renders as a player (Constitution § PR Evidence). The post-run walk that builds `recorded[]`, the Markdown rows, and the attach line is extended with the `shell` entry so the three still cannot disagree. A shell-only demo with `--before` would print:

```
### Before

**Desktop shell**

![](.demo/<name>-before-shell.webm)

### After

**Desktop shell**

![](.demo/<name>-after-shell.webm)

Attach:
  gh pr edit --attach .demo/<name>-before-shell.webm --attach .demo/<name>-after-shell.webm
```

### 4. Selection rule (mechanical floor) and the demo.sh warning

The rule, to be written into the constitution (§ 7) and `fab/project/context.md`:

- A **shell recording is REQUIRED** when the diff touches `app/desktop/src/` or a shell-only SPA code path: the `runkitShell` bridge, the native web-tile engine, or popout.
- Otherwise the **web recording suffices**.
- When a change **behaves differently across engines**, record **BOTH**. Example: a web-tile change renders as an `<iframe>` in the browser (`web-frame-iframe.tsx`) and as a native guest in the shell (`web-frame-native.tsx`). The surface popout is similar: a browser window in the web UI, the `windows.popout` bridge in the shell.
- Accepted tradeoff: a path rule can miss a frontend change that only breaks inside the shell. A missed case costs one missing recording, which is better than leaving the call to judgment.

**`scripts/demo.sh` warning (never blocks).** If this invocation records no shell lane, and the diff against the base touches shell paths, print to stderr:

```
WARNING: this diff touches desktop-shell paths but only a web demo is being recorded.
         Constitution § PR Evidence requires a shell recording too — add
         app/desktop/tests/demo/<name>.demo.ts (or a same-named one to record both).
         Shell paths touched:
           app/desktop/src/web-views.ts
           ...
```

- Base for the diff: the same resolution `resolve_before_ref` already uses (merge-base with the active change's base branch via `fab status get-base-branch`, else `origin/main`, else `main`). Diff the working tree against that merge-base (`git diff --name-only <mb>`) so uncommitted edits count, since demos are usually recorded before the commit. If no base resolves, skip the warning silently. It is advisory.
- Shell path set: one named array constant in `demo.sh`, so it is not a magic list scattered through the script:
  ```bash
  SHELL_PATHS=(
    app/desktop/src/
    app/frontend/src/lib/shell.ts
    app/frontend/src/lib/shell-*.ts
    app/frontend/src/hooks/use-shell-servers.ts
    app/frontend/src/components/desktop-shell/
    app/frontend/src/components/web-frame-native.tsx
    app/frontend/src/lib/popout.ts
    app/frontend/src/hooks/use-popout.ts
    app/frontend/src/components/popout-states.tsx
  )
  ```
  `*.test.ts(x)` files are excluded, since a test-only diff has nothing to record. `top-bar.tsx` also reads the bridge, but it is a general UI file, so it stays on the web rule.
- No warning in the reverse direction (shell recorded, no web recording): the rule sets only a shell floor.

### 5. Shell demo fixture and example demo

**`app/desktop/tests/demo/_demo.ts`**, the shell counterpart of `app/frontend/tests/demo/_demo.ts`:
- Imports from `../e2e/_shell` (`launchShell`, `seedHosts`, `hostOrigins`, `pageByOrigin`, `startGuestStub`, `viewTree`, …) and the frontend's `_tmux` / `_harness` fixtures, which use only node builtins. It MUST NOT import `app/frontend/tests/e2e/_ready.ts` or `app/frontend/tests/demo/_demo.ts`: both import the frontend's `@playwright/test`, and two physical Playwright copies in one process are refused. Anything needed from them, such as `READY_TIMEOUT` or an `openPalette` helper, is mirrored locally, as `web-native.spec.ts` already does.
- Extends `test` with fixtures for:
  - a per-test `mkdtemp` `XDG_CONFIG_HOME`, seeded via `seedHosts`;
  - a launched `ElectronApplication` (`launchShell`);
  - the host `Page` (`pageByOrigin(app, hostOrigins().a, …)`);
  - the ffmpeg recorder, started after the host page is ready and stopped in teardown, pass or fail, with the output saved to the § 3 path.
  
  Teardown closes the app and removes the temp dir even if the test fails mid-way.
- **Pacing:** `beat(page, ms = 1_000)` has the same signature and semantics as the web fixture's. The web lane relies on `launchOptions: { slowMo: 250 }`. Playwright's `_electron.launch` appears to take no `slowMo` option (unverified: `app/desktop/node_modules` is not installed in this worktree). If confirmed, the fixture supplies a slowMo-like dwell instead, for example a small `paced(page)` helper or an explicit ~250 ms dwell after each user-visible action. The goal is a recording with the same rhythm as a web demo. If `slowMo` is supported, use it.
- **`--before` support (fixture side):** `launchShell` hard-codes `DESKTOP_DIR` (this tree's `app/desktop`). Give it an optional app-dir override, for example `launchShell(configHome, { appDir, executablePath })`, fed from an env var that `demo.sh` sets for the before pass (for example `DEMO_SHELL_APP_DIR=<before_wt>/app/desktop`). The before pass then launches the **base ref's compiled shell** with the base ref's own Electron binary, while the current tree's demo spec drives it. With no override, behavior stays exactly as today for the e2e lane.

**Example demo**: `app/desktop/tests/demo/web-tile-native.demo.ts`, which shows a native web tile opening over the SPA. It is the shell-specific scene per-page video cannot capture, so it also serves as the § 1 spike:
1. `beforeAll`: create a tmux session `demo-web-tile-native` on the rig server and start a guest stub serving a **visually distinct** page (a full-bleed coloured background and a large title, unlike the e2e stub's plain `<p>guest</p>`) so the native layer is unmistakable in the video. `afterAll` kills both.
2. Seed a window with the stub URL stamped as its web tab and `@rk_win_layout single:web`, following `web-native.spec.ts`'s `seedWindow` pattern. Resolve window ids tmux-side (`listWindows`) because there is no `baseURL`.
3. Navigate the host page to the window route, wait for `web-native-placeholder`, then `beat()`: the guest renders over the SPA.
4. Open the command palette (⌘K/Ctrl+K). The guest hides under the modal. `beat()`. Close it, and the guest reappears. `beat()`.
5. Optionally switch host (`servers:switch` to e2e-b) and back, showing the guest's z-order and visibility across the switch. `beat()`.

The file carries the same file-header plus **Proves:** / **Steps:** JSDoc shape as `window-switch.demo.ts`. Constitution § Test Intent Comments formally scopes only `tests/e2e/*.spec.ts`, but the demo convention set by the web harness is to follow it. Intent comments do not cite change IDs or PR numbers.

### 6. `--before` for the shell lane

Mirrors the existing before pass in `scripts/demo.sh`:
- The temp detached worktree at the base ref (already created for `--before`) also needs `app/desktop` installed and compiled: `( cd "$before_wt/app/desktop" && pnpm install --frozen-lockfile --prefer-offline && pnpm run compile )`. This is in addition to today's `app/frontend` `pnpm install`. The old Electron build is part of "before".
- The before pass runs with `RK_E2E_APP_ROOT=$before_wt` (so the rig's `just dev` serves the base SPA and backend) **and** the shell app-dir override (so the base shell binary is launched). The current tree's spec and fixture drive both.
- A failing before pass stays **reported, not fatal**. This includes a base ref with no `app/desktop`, an install or compile failure, or a demo failure against the base. The after pass still records, and the summary prints the existing `NOTE: the before pass failed against <ref> …` line. Only the after pass's status is the exit code.
- Install/compile in the before tree happens only when a shell lane is being recorded. A web-only `--before` must not pay for an Electron install.

### 7. Constitution amendment, project docs, justfile, gitignore

**`fab/project/constitution.md` § PR Evidence.** Replace the final sentence ("Desktop-shell changes are out of scope until … `No recording: desktop shell recording not yet supported by just demo`.") with the selection rule and a narrowed exemption, for example:

> Desktop-shell changes — a diff touching `app/desktop/src/` or a shell-only SPA code path (the `runkitShell` bridge, the native web-tile engine, popout) — MUST carry a shell recording: `just demo` with a spec under `app/desktop/tests/demo/`, which records the Electron shell on a private Xvfb display. A change that behaves differently across engines (e.g. a web tile, an `<iframe>` in the browser and a native guest in the shell) MUST carry both the web and the shell recordings. Shell recordings have no mobile variant. Behavior specific to the macOS shell (⌘ chords, traffic lights, the macOS menu bar) cannot be recorded by `just demo`; such PRs state `No recording: macOS-only shell behavior not recordable by just demo`.

The opening sentence ("Every PR that changes user-visible behavior of the web UI …") may need a light touch so it reads as covering the shell too. Version: **2.0.0 → 2.1.0**, a MINOR bump for a materially expanded requirement with no principle redefined. `Last Amended` is set to the apply date.

**`fab/project/context.md` § Testing:**
- Extend the `just demo <name>` bullet to name both spec locations.
- Add a paragraph on the shell lane: routing by spec location; `RK_E2E_LANE=shell-demo`; private Xvfb at 1280×800 plus ffmpeg x11grab; `.demo/<name>[-before|-after]-shell.webm`; no mobile variant; the before pass compiles the base shell; the selection rule and the non-blocking warning; and Linux-only v1.

**`fab/project/code-quality.md`:** the PR Evidence bullet ("User-visible UI changes ship with a `just demo` recording …") gains "— a shell recording for desktop-shell changes".

**`justfile`:** the `demo *args:` recipe body stays the one-liner `scripts/demo.sh {{args}}` (Constitution VIII). Only its doc comment changes, to mention both spec locations.

**`.gitignore`:** add `app/desktop/test-results-demo/`. `.demo/` is already ignored.

**`scripts/demo.sh` usage/header:** document the routing, the `shell` output, the platform requirement, and the warning.

## Affected Memory

- `run-kit/architecture/testing`: (modify) Document the shell demo lane: routing by spec location, `RK_E2E_LANE=shell-demo`, `app/desktop/playwright.demo.config.ts` + `tests/demo/_demo.ts`, private Xvfb + ffmpeg x11grab (and why not per-page `recordVideo`, plus the spike outcome), `-shell` output naming, `--before` compiling the base shell, the scoped pre-run sweep, the selection rule and the non-blocking warning, and Linux-only v1. Update the frontmatter description.
- `run-kit/desktop-shell`: (modify) Add a short pointer: shell behavior is recordable via `just demo` (spec under `app/desktop/tests/demo/`), with the Linux/Xvfb-only scope and the macOS-only exemption. Note that `launchShell` gained an app-dir/executable override.

## Impact

- **New:** `app/desktop/playwright.demo.config.ts`, `app/desktop/tests/demo/_demo.ts`, `app/desktop/tests/demo/web-tile-native.demo.ts`.
- **Modified:**
  - `scripts/demo.sh`: lane routing, shell pass under xvfb-run, desktop compile, before-tree desktop install/compile, scoped sweep, `shell` output walk/Markdown/attach, platform guard, warning.
  - `scripts/test-e2e.sh`: new lane case and header comment.
  - `app/desktop/tests/e2e/_shell.ts`: optional `launchShell` override. Default behavior unchanged, so the e2e lane is unaffected.
  - `justfile`: comment only.
  - `.gitignore`.
  - `fab/project/{constitution,context,code-quality}.md`.
- **Not touched:** product code (`app/desktop/src/`, `app/frontend/src/`), the backend, the web demo lane's behavior (web-only invocations produce identical files and output, apart from the new advisory warning), and CI. Demos stay on demand and are not gated in CI.
- **Dependencies:** none new. ffmpeg (with x11grab and libvpx) and Xvfb/xvfb-run are system tools, already present on this box. Electron and `@playwright/test` are already `app/desktop` devDependencies.
- **Risks:**
  1. Electron under a bare Xvfb with no window manager: windows get no WM decorations, and a popout window may stack over the opener at a default position. Acceptable for v1; verify in the spike.
  2. Rendering differences between headless Xvfb and a real display, such as GPU fallback, may make the recording look slightly different from a user's screen.
  3. ffmpeg must be stopped gracefully, or the WebM is truncated.

## Open Questions

- None blocking. Apply-time details:
  1. The exact lane name (`shell-demo`).
  2. Whether the desktop compile step is factored into a shared helper or called inline.
  3. ffmpeg codec flags.
  4. Whether `_electron.launch` accepts `slowMo`. It decides the pacing mechanism, not the recording.

## Clarifications

### Session 2026-10-08 (bulk confirm)

| # | Action | Detail |
|---|--------|--------|
| 1 | Confirmed | Delegated — user said "auto resolve" |
| 4 | Confirmed | Delegated — user said "auto resolve" |
| 5 | Confirmed | Delegated — user said "auto resolve" |
| 6 | Confirmed | Delegated — user said "auto resolve" |
| 7 | Confirmed | Delegated — user said "auto resolve" |
| 9 | Confirmed | Delegated — user said "auto resolve" |
| 10 | Confirmed | Delegated — user said "auto resolve" |
| 11 | Confirmed | Delegated — user said "auto resolve" |
| 12 | Confirmed | Delegated — user said "auto resolve" |
| 13 | Confirmed | Delegated — user said "auto resolve" |
| 14 | Confirmed | Delegated — user said "auto resolve" |
| 15 | Confirmed | Delegated — user said "auto resolve" |

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Record the shell by grabbing a private Xvfb display with `ffmpeg -f x11grab`, not Playwright per-page `recordVideo` | Clarified — user confirmed (delegated via "auto resolve"). Discussed — the user agreed: per-page video misses native guests (separate WebContentsViews), popout windows, and native menus. The per-page limitation is reasoned, not yet verified; spike at apply. x11grab is still needed for popouts/menus either way | S:95 R:70 A:70 D:75 |
| 2 | Certain | Lane chosen by spec location (`app/desktop/tests/demo/` → shell, `app/frontend/tests/demo/` → web); no new flag; `just demo` stays the single entry point | Discussed and agreed. The desktop fixture must live under app/desktop anyway (Playwright refuses two physical copies per process); Constitution VIII keeps the justfile thin | S:90 R:80 A:85 D:85 |
| 3 | Certain | Shell output is `.demo/<name>[-before or -after]-shell.webm`; no mobile variant | Discussed and agreed: the web harness's `desktop` project already names the browser viewport, so the suffix must differ | S:90 R:85 A:85 D:85 |
| 4 | Confident | Selection rule: shell recording REQUIRED when the diff touches `app/desktop/src/` or shell-only SPA paths; web otherwise; BOTH when engines differ. `demo.sh` warns (never blocks) on shell paths with web-only recording | Clarified — user confirmed (delegated via "auto resolve"). Discussed and agreed. The tradeoff (path rule can miss shell-only breakage) was explicitly accepted | S:95 R:75 A:75 D:70 |
| 5 | Confident | Exact shell-path list for the warning (lib/shell*.ts, use-shell-servers.ts, components/desktop-shell/, web-frame-native.tsx, lib/popout.ts, use-popout.ts, popout-states.tsx; tests excluded; top-bar.tsx left on the web rule) | Clarified — user confirmed (delegated via "auto resolve"). Derived from the discussed categories by grepping current `runkitShell` consumers. The exact membership was not discussed | S:95 R:85 A:55 D:45 |
| 6 | Certain | `--before` installs and compiles `app/desktop` in the temp worktree (only when a shell lane is recorded); a failing before pass stays reported, not fatal | Clarified — user confirmed (delegated via "auto resolve"). Discussed and agreed. Mirrors the existing frontend install in the before pass; web-only `--before` pays no Electron cost | S:95 R:80 A:75 D:75 |
| 7 | Confident | The before pass launches the base tree's compiled shell with the base tree's own Electron binary, through a new optional `launchShell` app-dir/executablePath override fed by an env var | Clarified — user confirmed (delegated via "auto resolve"). Follows from "the old Electron build is part of before". The mechanism (env var plus override, default unchanged) is an inferred design, not discussed | S:95 R:75 A:55 D:50 |
| 8 | Certain | v1 is Linux/Xvfb only; the shell lane fails fast on non-Linux or missing xvfb-run/Xvfb/ffmpeg-x11grab; the constitution exemption narrows to macOS-only shell behavior | Discussed and agreed. ffmpeg (x11grab, libvpx) and Xvfb/xvfb-run were verified present on this box | S:90 R:80 A:85 D:80 |
| 9 | Confident | Constitution § PR Evidence amended to the selection rule plus the narrowed macOS exemption, bumped 2.0.0 → 2.1.0 (MINOR); context.md § Testing and code-quality.md updated; memory testing + desktop-shell updated at hydrate | Clarified — user confirmed (delegated via "auto resolve"). Discussed — the user asked for the amendment and the doc updates. MINOR because a requirement expanded and no principle was redefined | S:95 R:80 A:75 D:70 |
| 10 | Certain | The shell lane always runs under its own `xvfb-run -a -s "-screen 0 1280x800x24"`, even when DISPLAY is set | Clarified — user confirmed (delegated via "auto resolve"). x11grab on a real display would capture the user's desktop (privacy, nondeterminism). 1280×800 matches createWindow's default window size; this box's xvfb-run default is 1280x1024x24 | S:95 R:85 A:80 D:70 |
| 11 | Confident | The shell demo fixture (TypeScript, per test) owns ffmpeg: it starts after the host SPA is ready, stops gracefully (`q`/SIGINT, never SIGKILL) in teardown pass or fail, and owns the naming contract | Clarified — user confirmed (delegated via "auto resolve"). Mirrors the web fixture owning naming and saving partial recordings. Bracketing per test excludes rig/compile time and the black pre-launch screen | S:95 R:80 A:70 D:60 |
| 12 | Confident | A demo name present in BOTH spec dirs records both lanes in one invocation (combined Markdown, one attach line); the pre-run sweep is scoped per lane so separate same-name runs don't delete each other's files | Clarified — user confirmed (delegated via "auto resolve"). Not discussed. Follows from the "record BOTH" rule. Today's broad `rm -f $name-*.webm` sweep would otherwise delete a sibling lane's recording | S:95 R:80 A:60 D:45 |
| 13 | Confident | `--desktop-only`/`--mobile-only` narrow only the web lane and exit 2 on a shell-only spec | Clarified — user confirmed (delegated via "auto resolve"). Not discussed. Failing loudly matches the script's existing flag validation | S:95 R:90 A:60 D:50 |
| 14 | Confident | `_electron.launch` has no `slowMo`; pacing comes from `beat()` plus an explicit ~250 ms dwell helper so rhythm matches the web lane | Clarified — user confirmed (delegated via "auto resolve"). The description says "slowMo-like dwell". The Playwright types could not be checked (no app/desktop/node_modules in this worktree); verify at apply | S:95 R:90 A:45 D:55 |
| 15 | Certain | The example demo is `app/desktop/tests/demo/web-tile-native.demo.ts`: a native web tile over the SPA, the palette hide/show, and optionally a host switch, using a visually distinct guest stub; it doubles as the recordVideo spike | Clarified — user confirmed (delegated via "auto resolve"). Discussed — the user offered "native web tile or popout". The native tile is the scene per-page video can't capture | S:95 R:90 A:75 D:65 |
| 16 | Certain | Recordings stay gitignored under `.demo/` and are attached via `gh pr create/edit --attach`; add `app/desktop/test-results-demo/` to .gitignore | Discussed. Inherited unchanged from the shipped web harness | S:90 R:90 A:90 D:90 |
| 17 | Certain | Reuse the existing rig (`scripts/test-e2e.sh` via a new single-worker lane) and `_shell.ts` launch helpers; never import the frontend's `_ready.ts`/`_demo.ts` from the desktop side | Discussed: "reuse, don't reimplement". The two-Playwright-copies constraint is documented in app/desktop/playwright.config.ts | S:90 R:80 A:90 D:85 |

17 assumptions (8 certain, 9 confident, 0 tentative, 0 unresolved).
