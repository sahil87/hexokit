# Plan: Desktop E2E Lane + Web Tile Docs

**Change**: 260917-m3a9-desktop-e2e-lane-web-docs
**Intake**: `intake.md`

## Requirements

### Desktop E2E: The Electron Playwright lane

#### R1: A Playwright project exists in `app/desktop`
`app/desktop` MUST carry a Playwright Electron test project: `@playwright/test` as a devDependency (the frontend's pin `^1.59.1`), a `test:e2e` script, `playwright.config.ts` with `testDir: ./tests/e2e`, `workers: 1`, `fullyParallel: false`, `retries: 1`, `trace: "on-first-retry"`, a per-test timeout of 60 s under `CI` and 30 s locally, and `globalTeardown` pointing at the frontend's `tests/e2e/global-teardown.ts`. It MUST NOT declare a `webServer` or a `baseURL` (the harness manages the rig; specs build URLs from `E2E_PORT` with the fail-closed `3333` fallback). `tsconfig.json` MUST keep `include: ["src"]` so the shell's compile never touches the specs. No file under `app/desktop/src/` changes.

- **GIVEN** a checkout with `app/desktop/node_modules` installed
- **WHEN** `cd app/desktop && pnpm exec playwright test --list` runs
- **THEN** the seven `web-native.spec.ts` tests are listed and `pnpm run compile` still compiles only `src/`

#### R2: Each test launches an isolated shell over a seeded two-host `hosts.json`
The fixture module `app/desktop/tests/e2e/_shell.ts` MUST launch the shell per test with `_electron.launch({ args: [".", "--no-sandbox"], cwd: <app/desktop>, env: { ...process.env, XDG_CONFIG_HOME: <mkdtemp dir> } })` after writing `<dir>/run-kit-desktop/hosts.json` = `{ version: 1, activeId: "e2e-a", hosts: [ {id: "e2e-a", name: "e2e A", url: "http://localhost:<E2E_PORT>"}, {id: "e2e-b", name: "e2e B", url: "http://127.0.0.1:<E2E_PORT>"} ] }`. It MUST NOT set `RK_DESKTOP_URL`. It MUST expose helpers to find the host Page by origin and read the window's view tree (`viewTree`: for each `win.contentView.children` entry the webContents id, URL, `getVisible()`, `getBounds()`, in child order) through `electronApp.evaluate` over Electron's own objects — no test hook is added to `main.ts`. It MUST start one `node:http` stub on an ephemeral loopback port serving `<title>rk e2e guest</title>` and close it in `afterAll`. Temp dirs are removed in `afterEach`.

- **GIVEN** the rig is up on `E2E_PORT`
- **WHEN** a test's `beforeEach` runs
- **THEN** exactly one shell window opens on `http://localhost:<E2E_PORT>` (host `e2e-a`), the developer's real `~/.config/run-kit-desktop/` is untouched, and a second shell instance already running on the box is not disturbed

#### R3: The smoke set proves assertions (a)–(g) against the live registry
`app/desktop/tests/e2e/web-native.spec.ts` MUST contain seven independent tests, each seeding its own tmux window (`@rk_win_web_1` = the stub URL, `@rk_win_web_active 1`, `@rk_win_layout single:web`) through the frontend fixtures imported by relative path (`../../../frontend/tests/e2e/_tmux`, `_ready`) and navigating the host Page to `/<TMUX_SERVER>/<windowId>`:

- (a) after `[data-testid="web-native-placeholder"]` is visible, `viewTree()` holds exactly one child at the stub origin, `visible === true`, and its bounds match `placeholder.boundingBox()` on every field within 1 px;
- (b) `Shift+Control+k` on the host Page opens the palette and the guest's `visible` polls to `false`; `Escape` polls it back to `true`;
- (c) the tab strip's `[data-testid="web-tab"]` text contains `rk e2e guest`;
- (d) `Control+k` pressed on the guest Page (up to 3 attempts) opens the palette on the host Page;
- (e) `runkitShell.servers.switch("e2e-b")` from the host Page ⇒ the `e2e-b` host child is present and the guest's `visible` polls to `false`; `switch("e2e-a")` ⇒ the guest's `visible` polls to `true` AND its index in `contentView.children` is greater than the `e2e-a` host child's index;
- (f) after a keep-alive `new BrowserWindow({show:false})` is created in main, closing the shell window ⇒ `webContents.getAllWebContents()` polls to no longer contain the guest's id;
- (g) with the palette open, `runkitShell.web.bounds(tabKey, …)` from the host Page with a rect distinct from the current one ⇒ the guest's `visible` stays `false` and its `bounds` equal the pre-call read.

If Playwright does not surface the host/guest webContents as Pages, the same assertions MUST be made through `electronApp.evaluate` (`webContents.fromId(id).executeJavaScript` for reads and clicks, `sendInputEvent` keyDown/keyUp for (d)); the assertion set is unchanged.

- **GIVEN** `just test-desktop-e2e` on a box with a display or `xvfb-run`
- **WHEN** the seven tests run
- **THEN** all seven pass, and disabling the attach plan's re-add in `attachHostView` would fail (e), disabling the park rule in `web:bounds` would fail (g)

#### R4: Every desktop e2e test carries a Test Intent Comment
Each `test()` in `web-native.spec.ts` MUST carry a `/** Proves: … Steps: … */` JSDoc block and the file MUST open with a header describing the shared setup (rig env vars, `XDG_CONFIG_HOME` seeding, the stub server, per-test launch/close). Comments SHALL NOT cite change IDs or PR numbers. `fab/project/constitution.md` § Test Intent Comments MUST name `app/desktop/tests/e2e/*.spec.ts` beside the frontend path, with **Version** bumped to 1.12.1 and **Last Amended** set to 2026-09-17.

- **GIVEN** the constitution's Test Intent Comments rule
- **WHEN** a reviewer reads `web-native.spec.ts`
- **THEN** every test's intent and steps are readable without Playwright knowledge, and the rule's path list covers the file

### Harness: one rig, two lanes

#### R5: `scripts/test-e2e.sh` gains the `RK_E2E_LANE` knob and a desktop entrypoint drives it
`scripts/test-e2e.sh` MUST read `RK_E2E_LANE` (`web` default, `desktop`) at exactly two sites: after `E2E_WORKERS` is derived (`desktop` forces `E2E_WORKERS=1`) and in `run_playwright` (`cd app/frontend` becomes `cd "$PLAYWRIGHT_DIR"`, `app/desktop` for `desktop`), with every exported variable unchanged. `scripts/test-desktop-e2e.sh` (new) MUST re-exec itself under `xvfb-run -a` when `DISPLAY` is unset and `xvfb-run` exists, then `pnpm install` (when `node_modules` is absent) and `pnpm run compile` in `app/desktop`, then `RK_E2E_LANE=desktop exec scripts/test-e2e.sh "$@"`. The `justfile` MUST gain a one-line `test-desktop-e2e *args` recipe delegating to it (Constitution VIII). `scripts/test-all.sh` (`just test`) MUST NOT gain a desktop phase.

- **GIVEN** a worktree with no display
- **WHEN** `just test-desktop-e2e` runs
- **THEN** the run holds the worktree's e2e lock, starts the derived rig, runs `app/desktop`'s Playwright project under xvfb with one worker, and the EXIT trap reaps the rig; `just test-e2e web-tabs.spec` still runs the frontend project unchanged

### CI: the Desktop job

#### R6: `ci.yml` runs the desktop unit tests and the Electron lane as a hard gate
`.github/workflows/ci.yml` MUST add a `desktop` job (`name: Desktop (node --test + electron e2e)`, `ubuntu-latest`) that: checks out; sets up Go from `app/backend/go.mod`; sets up pnpm from `app/desktop/package.json` and Node 22 (the package's `engines` floor) with the pnpm cache keyed on `app/desktop/pnpm-lock.yaml`; installs just and tmux (the e2e job's bounded apt block, verbatim); caches/installs air and adds the go bin dir to PATH (the e2e job's three steps, verbatim); caches Playwright browsers and runs `just setup`; runs `cd app/desktop && pnpm install --frozen-lockfile`, `pnpm run compile`, `pnpm test`; runs `xvfb-run -a just test-desktop-e2e`; and uploads `app/desktop/playwright-report/` + `app/desktop/test-results/` on failure (7-day retention). `ci-gate` MUST list `desktop` in `needs`, echo its result, and fail unless it is `success`; the gate's comment names five hard gates. Pinned action SHAs match the existing jobs.

- **GIVEN** a pull request
- **WHEN** CI runs
- **THEN** the Desktop job appears beside the four existing jobs and a failing desktop lane fails `CI gate`

### Specs: two engines behind one chrome

#### R7: The spec web rows are engine-blind and point at the engine contract
`docs/specs/window-views.md` § The View Registry `web` row's Renderer cell MUST read "`IframeWindow` chrome over an engine: `iframe` (browsers, PWAs, phones) or native `WebContentsView` (the desktop shell) — § Engines", and a `### Engines [current]` note MUST follow the registry table describing two engines behind the `WebFrameEngine` contract, the capability-driven chrome, the selection rule (shell `web` bridge present × per-viewer opt-out), and pointing at `docs/wiki/web-tile-native-browser-studies.html` and the memory (`docs/memory/run-kit/ui/lenses-and-layout.md` § Web Tile, `docs/memory/run-kit/desktop-shell.md` § Web Views). `docs/specs/surface-layout.md`'s two "live iframe" phrasings and `docs/specs/right-panel.md` § Surface Registry's `web` row MUST say the live page renders through the tile's engine (iframe or native). Availability semantics are unchanged.

- **GIVEN** the three spec files
- **WHEN** `grep -n "live iframe" docs/specs/{window-views,surface-layout,right-panel}.md` runs
- **THEN** no web-row match remains, and window-views.md has a § Engines note

### Non-Goals

- Any change under `app/desktop/src/`, `app/frontend/src/`, or `app/backend/` — the lane tests shipped code; a bug it finds is its own change.
- A multi-rig desktop lane; macOS/Windows CI runners for the lane; adding the lane to `just test`.
- The macOS sibling-layering manual check (owed to the user, PR-body checklist) and the 3f/4 manual matrix (a post-pipeline report).
- Memory hydration (`docs/memory/**`) — the hydrate stage owns it.

### Design Decisions

#### The desktop lane reads z-order from Electron, not from a test seam
**Decision**: Registry claims (z-order, visibility, bounds, ownership) are asserted by reading `win.contentView.children`, `View.getVisible()`, `View.getBounds()` and `webContents.getURL()` through `electronApp.evaluate`; `main.ts` exports nothing for tests.
**Why**: The registry's whole job is to control Electron's view tree; asserting on the tree itself is the only end-to-end proof, and a hook would test the hook.
**Rejected**: An env-gated `globalThis.__rkE2e` exposing `webViews`/`views` — a production seam that mirrors the registry it should verify.
*Introduced by*: 260917-m3a9-desktop-e2e-lane-web-docs

#### The lane isolates userData through XDG_CONFIG_HOME
**Decision**: Each test launches the shell with `XDG_CONFIG_HOME` pointing at a fresh temp dir seeded with a two-host `hosts.json` (`localhost` and `127.0.0.1` on the rig port); `RK_DESKTOP_URL` is not used.
**Why**: Linux Electron derives `appData` from `XDG_CONFIG_HOME`, so the shell's single-instance lock and stores are hermetic with no production knob; the sentinel is single-host and cannot exercise a host switch.
**Rejected**: An `RK_DESKTOP_USER_DATA` env override in `main.ts` (a production seam); Chromium's `--user-data-dir` (not honored by Electron's `app.getPath`).
*Introduced by*: 260917-m3a9-desktop-e2e-lane-web-docs

#### The desktop lane rides the web harness through one lane knob
**Decision**: `scripts/test-desktop-e2e.sh` compiles the shell and delegates to `scripts/test-e2e.sh` with `RK_E2E_LANE=desktop`, which only forces one worker and redirects the Playwright phase's directory.
**Why**: One rig identity, one per-worktree lock, one stale-kill, one seed, one cleanup — the web and desktop lanes share the rig and must serialize on it.
**Rejected**: A second rig starter in the desktop script (~150 duplicated lines of lock/seed/cleanup choreography).
*Introduced by*: 260917-m3a9-desktop-e2e-lane-web-docs

#### The desktop lane is not a `just test` phase
**Decision**: `just test-desktop-e2e` is its own recipe and CI job; `scripts/test-all.sh` keeps backend/frontend/e2e.
**Why**: The lane needs an Electron binary download and a display (or xvfb), which `just test` never required of a developer box.
**Rejected**: A fourth `just test` phase gated on `xvfb-run` presence — a silently skipped phase is worse than a separate recipe.
*Introduced by*: 260917-m3a9-desktop-e2e-lane-web-docs

## Tasks

### Phase 1: Setup

- [x] T001 Add `@playwright/test` (`^1.59.1`) to `app/desktop/package.json` devDependencies and a `"test:e2e": "playwright test"` script; run `pnpm install` in `app/desktop` so `pnpm-lock.yaml` updates (Electron's binary postinstall runs — a fresh worktree needs it for the lane anyway) <!-- R1 --> <!-- rework: pin `@playwright/test` at `^1.59.1` directly (no `link:` into the frontend tree); re-run pnpm install so the lockfile records the real package -->
- [x] T002 [P] Create `app/desktop/playwright.config.ts` (testDir `./tests/e2e`, CI 60 s / local 30 s timeout, retries 1, fullyParallel false, workers 1, `globalTeardown: "../frontend/tests/e2e/global-teardown.ts"`, `use: { trace: "on-first-retry" }`, no webServer/baseURL) with a header comment stating why there is no webServer and why workers is 1 <!-- R1 --> <!-- rework: update the header comment — no `link:` dep; the single-copy rule is honoured by not importing `_ready.ts` -->
- [x] T003 [P] Add the `RK_E2E_LANE` knob to `scripts/test-e2e.sh` at exactly two sites: force `E2E_WORKERS=1` for `desktop` right after the workers derivation, and switch `run_playwright`'s directory via `PLAYWRIGHT_DIR` (`app/frontend` / `app/desktop`); update the header comment; `bash -n scripts/test-e2e.sh` <!-- R5 -->
- [x] T004 [P] Create `scripts/test-desktop-e2e.sh` (executable; xvfb self-wrap when `DISPLAY` is unset; `pnpm install` if no `node_modules`; `pnpm run compile`; `RK_E2E_LANE=desktop exec test-e2e.sh "$@"`) and add the `test-desktop-e2e *args` one-liner recipe to `justfile` under `# ─── Test ───` <!-- R5 -->

### Phase 2: Core Implementation

- [x] T005 Create `app/desktop/tests/e2e/_shell.ts`: `E2E_PORT` read with the `3333` fallback, `hostOrigins()` (`localhost` / `127.0.0.1`), `seedHosts(configHome)` writing `run-kit-desktop/hosts.json`, `launchShell(configHome)` (`args: [".", "--no-sandbox"]`, cwd `app/desktop`, `XDG_CONFIG_HOME`), `pageByOrigin(app, origin)` (existing windows first, then `waitForEvent("window")`), `viewTree(app)` over `win.contentView.children`, `startGuestStub()` (`node:http` on `127.0.0.1:0`, titled page, returns `{ server, origin }`), and a file header stating the XDG isolation and no-seam constraints <!-- R2 --> <!-- rework: launch without `executablePath` or the hand-prepended internal `-r …/lib/server/electron/loader.js`; let Playwright resolve `electron` itself (pnpm hoists it to `node_modules/.pnpm/node_modules`); only fall back to `executablePath` if that resolution is proven to fail, and then report why -->
- [x] T006 Create `app/desktop/tests/e2e/web-native.spec.ts` with the file header, `beforeAll` (tmux session via the frontend `_tmux` fixtures + the guest stub), `afterAll` (kill session, close stub), `beforeEach`/`afterEach` (fresh `configHome` + launch / `electronApp.close()` + rm), a `seedWindow(name)` helper (newWindow, `resolveWindow`, `stampWebTab`, `@rk_win_layout single:web`, host `page.goto` to the window route, wait for the placeholder), and tests (a) bounds-match, (b) palette hides/shows, (c) title reaches the tab strip, (g) parked bounds while hidden — each with its Proves/Steps JSDoc <!-- R3 --> <!-- rework: stop importing `../../../frontend/tests/e2e/_ready` — it is the only frontend fixture that loads `@playwright/test`, which forces a second Playwright copy into the process; define `READY_TIMEOUT` and a bounded `openPalette` locally with a comment stating the single-copy rule; keep importing `_tmux` (node builtins only) -->
- [x] T007 Add tests (d) ⌘K from inside the guest (guest Page keyboard, ≤ 3 attempts; fallback `sendInputEvent` via `electronApp.evaluate` if the guest is not surfaced as a Page) and (e) host switch two-assertion z-order check via `runkitShell.servers.switch` <!-- R3 -->
- [x] T008 Add test (f) window close destroys the guest (keep-alive hidden `BrowserWindow` created in main, `win.close()`, poll `webContents.getAllWebContents()` for the guest id's absence) <!-- R3 -->
- [x] T009 Run `just test-desktop-e2e` on this VM (xvfb self-wrap; expect all seven green, fix spec-side flakes with readiness polls, never with `main.ts` edits; if Playwright does not surface WebContentsView pages, switch the affected helpers to the `executeJavaScript`/`sendInputEvent` fallback and record it in the spec header) <!-- R3 --> <!-- rework: re-run the lane green after the dependency change -->

### Phase 3: Integration & Edge Cases

- [x] T010 Add the `desktop` job to `.github/workflows/ci.yml` (steps per R6, pinned action SHAs copied from the existing jobs, the tmux/air blocks verbatim) and extend `ci-gate` (`needs`, echo, check, comment: five hard gates) <!-- R6 -->
- [x] T011 [P] Edit `docs/specs/window-views.md` (web row Renderer cell + `### Engines [current]` note after the registry), `docs/specs/surface-layout.md` (both "live iframe" phrasings), `docs/specs/right-panel.md` (§ Surface Registry web row); update the window-views row in `docs/specs/index.md` only if its description no longer fits <!-- R7 -->
- [x] T012 [P] Add every `test()` in `web-native.spec.ts` its Proves/Steps JSDoc (verify none is missing after T006–T008) and amend `fab/project/constitution.md` § Test Intent Comments to name `app/desktop/tests/e2e/*.spec.ts`; bump Version 1.12.0 → 1.12.1, Last Amended 2026-09-17 <!-- R4 -->

### Phase 4: Polish

- [x] T013 Verification: `cd app/desktop && pnpm run compile && pnpm test` (src untouched, tests still green); `bash -n scripts/test-e2e.sh scripts/test-desktop-e2e.sh`; `just --list | grep test-desktop-e2e`; `just test-e2e web-tabs.spec` (the web lane is unchanged by the knob — one scoped spec, one run at a time in this worktree); `git diff --stat` shows no `app/desktop/src/`, `app/frontend/src/`, or `app/backend/` file <!-- R1 --> <!-- rework: re-run the verification gates after the dependency change -->

## Execution Order

- T001 blocks T005–T009 (Playwright must be installed in `app/desktop`); T002–T004 are independent of each other and of T001.
- T003 and T004 block T009 (the harness must exist before the lane can run).
- T009 blocks T013; T010–T012 are independent of T009 but T012 depends on T006–T008 existing.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `app/desktop/package.json` carries `@playwright/test` and `test:e2e`; `pnpm-lock.yaml` is updated; `playwright.config.ts` matches R1 (workers 1, no webServer/baseURL, frontend global teardown); `pnpm run compile` compiles only `src/`. (Re-verified after the rework: the dep is now the literal registry range `^1.59.1`, resolved 1.63.0 in `pnpm-lock.yaml` — no `link:` deviation remains. The two-copy hazard is instead avoided by never importing `_ready.ts`; the shared `global-teardown.ts` and `_tmux.ts` import node builtins only, so the frontend's Playwright copy never loads. `pnpm exec playwright test --list` lists the seven tests; compile passes with `include: ["src"]` unchanged.)
- [x] A-002 R2: `_shell.ts` launches with `--no-sandbox` and a per-test `XDG_CONFIG_HOME`, seeds the two-host `hosts.json`, never sets `RK_DESKTOP_URL`, and reads the view tree from Electron objects only — `app/desktop/src/` is byte-identical to `main`.
- [x] A-003 R3: `web-native.spec.ts` contains exactly the seven tests (a)–(g) with the assertions listed in R3, (e) as two assertions (hidden after switch-away; visible AND above its host view after switch-back), (g) asserting `visible === false` and unchanged bounds after a hidden-time `web:bounds`. ((d) uses the plan-sanctioned `sendInputEvent` fallback: a CDP-synthesized keypress never reaches Electron's `before-input-event`, so the guest Page cannot drive the chord; assertion set unchanged.)
- [x] A-004 R4: Every `test()` has a Proves/Steps JSDoc, the file has a shared-setup header, and the constitution's Test Intent Comments path list names the desktop lane with Version 1.12.1 / Last Amended 2026-09-17.
- [x] A-005 R5: `scripts/test-e2e.sh` consults `RK_E2E_LANE` at exactly the two sites (one read right after the `E2E_WORKERS` derivation sets both knobs; `run_playwright` consumes `PLAYWRIGHT_DIR`); `scripts/test-desktop-e2e.sh` exists, is executable, self-wraps in `xvfb-run -a` only when `DISPLAY` is unset, compiles the shell, and delegates; `justfile` has the one-line recipe; `scripts/test-all.sh` is unchanged.
- [x] A-006 R6: `ci.yml` has the `desktop` job with the R6 steps and pinned SHAs matching the existing jobs; `ci-gate` requires it.
- [x] A-007 R7: The three spec files carry engine-blind web rows and window-views.md has the `### Engines [current]` note pointing at the study and the two memory sections.

### Behavioral Correctness

- [x] A-008 R3: `just test-desktop-e2e` passes all seven tests on this VM under xvfb (evidence: the run's summary line in the apply result). (Re-reviewer re-ran the lane on this VM after the rework: `7 passed (9.5s)`, xvfb self-wrap engaged, rig reaped by the EXIT trap.)
- [x] A-009 R5: `just test-e2e web-tabs.spec` still runs the frontend project (the knob's default lane) and passes. (Re-reviewer ran `just test-e2e "e2e/web-tabs"` after the rework: 17 passed (30.9s).)

### Scenario Coverage

- [x] A-010 R3: (e) reads z-order as the guest's index vs. the `e2e-a` host child's index in `contentView.children`, not from any registry export.
- [x] A-011 R2: A test that fails mid-way still tears down its shell and temp dir (`afterEach` runs `electronApp.close()` in a try/finally or equivalent) and the rig sockets are swept by the shared trap/global teardown.

### Edge Cases & Error Handling

- [x] A-012 R3: (d) tolerates the chord-table upload latency with a bounded retry (≤ 3 presses), never an unbounded loop; (f) keeps the app alive with a hidden window so `window-all-closed` cannot quit before the assertion.
- [x] A-013 R5: With `DISPLAY` set (CI's `xvfb-run`, a developer desktop) the desktop script does not wrap again.

### Code Quality

- [x] A-014 Pattern consistency: spec helpers follow the frontend `_*.ts` fixture idiom (underscore prefix, `execFileSync` argv arrays, `expect.poll` readiness), the config mirrors `app/frontend/playwright.config.ts`'s comment style, and the shell scripts follow `test-e2e.sh`'s `set -euo pipefail` + explanatory-comment posture.
- [x] A-015 No unnecessary duplication: tmux seeding (`_tmux.ts`) comes from the frontend fixtures by import; no copied helper; no second rig starter. (Re-verified after the rework: `_ready.ts` is deliberately NOT imported — it is the one fixture that loads `@playwright/test` — so `READY_TIMEOUT` and a bounded `openPalette` are local mirrors with a stated single-copy constraint comment in the spec and config; everything else is imported, nothing else copied.)
- [x] A-016 Comment discipline: comments state constraints (XDG isolation, no-seam rule, sandbox flag, why workers is 1), never history or change IDs.
- [x] A-017 Tests included: the change IS the test coverage; every assertion in R3 maps to a `test()`.

### Security

- [x] A-018 R2: `--no-sandbox` appears only in the test launcher (`_shell.ts`), never in `scripts/dev-desktop.sh`, `electron-builder.yml`, or `src/`; no new subprocess shell strings (argv arrays only).

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds a new e2e lane, a CI job, and engine-blind spec wording without making any existing code redundant; the only replaced text is spec prose (wording, not code), and no file, function, or config block loses its last consumer. (Re-reviewed after the rework cycle: the rework removed only this change's own prior scaffolding — the `link:` dep form and the `executablePath`/loader launch workaround in `_shell.ts` — not any pre-existing code.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Playwright's `_electron` launch resolves the `electron` binary from `app/desktop/node_modules` when `cwd` is `app/desktop` and `args[0]` is `"."` | Playwright's documented default (`require("electron")` from cwd); `package.json` `main` is `dist/main.js` | S:85 R:90 A:90 D:90 |
| 2 | Certain | `pnpm install` in `app/desktop` (not `--frozen-lockfile`) is how the lockfile gains `@playwright/test`; CI then uses `--frozen-lockfile` | The repo's other packages follow the same install-then-freeze convention | S:80 R:95 A:95 D:95 |
| 3 | Confident | The shell's default window size is left as created; assertions never hard-code geometry | The tile rect is measured, not assumed; a default-size window is what a user gets | S:60 R:90 A:80 D:75 |
| 4 | Confident | Host and guest webContents surface as Playwright Pages; the `executeJavaScript`/`sendInputEvent` fallback is written only if T009 proves otherwise | Playwright attaches every CDP page target in the Electron context | S:50 R:85 A:45 D:55 |
| 5 | Confident | The guest stub URL is stamped as an absolute loopback URL (`http://127.0.0.1:<stubport>/`), which the SPA loads through `/proxy/<stubport>/` on the host origin; the title relay is unaffected by the proxy hop | `toProxySrc` maps loopback URLs; the rig's Go backend proxies to the stub; the address kind matches how users add local ports | S:65 R:85 A:80 D:70 |
| 6 | Confident | CI's `just setup` (frontend deps + Chromium cache) is reused for the rig rather than a trimmed install | Consistency with the e2e job; the browser cache keeps it fast; trimming is a follow-up if job time matters | S:55 R:90 A:75 D:65 |

6 assumptions (2 certain, 4 confident, 0 tentative).
