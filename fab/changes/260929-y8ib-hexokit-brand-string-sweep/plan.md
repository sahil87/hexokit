# Plan: HexoKit Brand-String Sweep (Phase 4 T1)

**Change**: 260929-y8ib-hexokit-brand-string-sweep
**Intake**: `intake.md`

## Requirements

Global boundary for every requirement below (from intake § What Changes, rules D2/D8/D11): present-truth **identity strings** change; **substrate identifiers never change** — the `rk` binary and `rk …` commands, `RK_*`, `@rk_*`, `rk-*` sockets/sessions/CSS classes/settings keys, `rk.*` code-bridge settings keys, the Go module `rk`, the `docs/memory/run-kit/` domain folder and its `# run-kit …` headings, palette/command **ids** (`run-kit-restart`, `run-kit-version`, …), code identifiers (`singleRunKit`, `SELF_TOOL_NAMES` — which keeps `run-kit` as a legacy self-row name — `runKitTool`, test function names), the help-topic `tool: "run-kit"` discriminator, agent-hook on-disk file names (`hooks/run-kit.json`, `plugins/run-kit.js`), legacy-migration constants (`LEGACY_HOME_DIR_NAME`, `legacyAssetPrefix`, `legacyAppBundleName`), Electron `appId: ai.shll.run-kit`, and code-bridge `publisher: run-kit` + `name: rk-code-bridge`. Historical text (fab archives, `log.md`/`log.seed.md`, change-ID citations, past-tense Design Decisions, old PR links) stays.

### Web UI: Wordmark and identity strings

#### R1: Wordmark and home label read HexoKit
The top-bar and sidebar wordmark text SHALL read `HexoKit`, and the brand anchor's accessible label SHALL be `HexoKit home` (both top-bar sites in `app/frontend/src/components/top-bar.tsx`; mobile nav wordmark in `sidebar/index.tsx`). Unit and e2e selectors keyed on `RunKit home` / `RunKit` SHALL move in the same change.

- **GIVEN** the dashboard at `/`
- **WHEN** the top bar renders
- **THEN** the brand link has accessible name `HexoKit home` and shows the text `HexoKit`
- **AND** no element carries `aria-label="RunKit home"`

#### R2: Browser title and PWA identity read HexoKit
`document.title` on the dashboard SHALL be `HexoKit` / `HexoKit — {hostname}` (`hooks/use-browser-title.ts`); `index.html` `<title>` SHALL be `HexoKit`; `public/manifest.json` `name` and `short_name` SHALL be `HexoKit` (backend `api/pwa_test.go` and e2e `pwa-assets.spec.ts` follow).

- **GIVEN** a dashboard route with hostname `box`
- **WHEN** the browser title hook runs
- **THEN** `document.title` is `HexoKit — box`

#### R3: Notification default title is HexoKit
Every notification default title SHALL be `HexoKit`: `public/sw.js` `DEFAULT_TITLE`, `lib/push.ts` test notification, `lib/shell-notifications.ts` empty-title fallback, `hooks/use-push-subscription.ts` test notification, and backend `app/backend/api/push.go` default title (with `push_test.go` / `sse_test.go` assertions of the default).

- **GIVEN** a shell notification payload with an empty title
- **WHEN** it is shown
- **THEN** the OS notification title is `HexoKit`

#### R4: Version and update rows read HexoKit
The overflow-menu and sidebar-footer version row SHALL read `HexoKit v{version}` (plain `HexoKit` when unknown), the single-self-row update row `HexoKit v{current} → v{latest} ⬆`, the sidebar version button's label `HexoKit {version} (copy)`, the sidebar tooltip `Connected — HexoKit {version}`, update labels `Update HexoKit: v… → v…`, and in-flight labels `Updating HexoKit` (`top-bar-overflow-menu.tsx`, `top-bar.tsx` update chip, `sidebar/index.tsx`).

- **GIVEN** daemon version `0.6.2`
- **WHEN** the overflow menu opens
- **THEN** it shows a `HexoKit v0.6.2` row and clicking it copies `v0.6.2`

#### R5: Lowercase UI brand strings read HexoKit
User-visible lowercase `run-kit` brand strings in `app/frontend/src` SHALL read `HexoKit`: palette labels (`lib/palette/update.ts` — Dismiss Update Notice, Update Now, Restart Daemon, Check for Updates (+ incl. patches); `lib/palette/version.ts` `HexoKit: Version — …`; `lib/palette/server-adopt.ts` `Server: Adopt {name} into HexoKit`), overflow `Help — HexoKit docs`, `server-dialogs.tsx` copy, `system-card.tsx` (`aria-label="HexoKit system"`, visible label, restart-failure toast), `host-overview-page.tsx` version line, `sidebar/server-card.tsx` `external — not started by HexoKit`, `iframe-window.tsx` `proxied through HexoKit`, plus any other user-visible literal found by sweep. Palette/command ids stay unchanged.

- **GIVEN** the command palette is open
- **WHEN** the user types `Restart`
- **THEN** the entry reads `HexoKit: Restart Daemon` and its id is still `run-kit-restart`

#### R6: Help links point at hexokit.com
`HELP_URL` (`components/global-chrome.tsx`) SHALL be `https://hexokit.com/docs/`; `lib/help-topics.ts` run-kit topic URLs SHALL be `https://hexokit.com/docs/<topic>/` and fab-kit topic URLs `https://hexokit.com/fab-kit/<topic>/`. Any display-form expectations (e.g. `help-topics.spec.ts` tab title `shll.ai/run-kit/cron-schedule-kinds/`) SHALL follow.

- **GIVEN** the overflow menu
- **WHEN** the user inspects the `Help — HexoKit docs` row
- **THEN** its `href` is `https://hexokit.com/docs/`

#### R7: Tutorial mock and control gallery
`public/tutorial/tutorial.html` mock wordmarks SHALL read `HexoKit`. The `/__controls` gallery SHALL be re-verified: it renders no wordmark, so its baselines stay; if `control-gallery.spec.ts` shows a diff, baselines SHALL be regenerated and the PNG diff reviewed before commit.

- **GIVEN** the tutorial page
- **WHEN** it renders its mock top bar
- **THEN** the chip text reads `HexoKit`

### Docs: Install doc and docs/site (D2)

#### R8: docs/site command examples use rk and the new bootstrap arg
`docs/site/install.md` command examples SHALL use `rk <verb>` (never `run-kit <verb>`), the bootstrap SHALL read `curl -fsSL https://hexokit.com/install | sh -s -- hexokit` (both occurrences), the binary prose SHALL name `hexokit` as the full binary with `rk` as the short name, and the Releases link SHALL be `github.com/sahil87/hexokit/releases`. `install.md` SHALL state that the legacy `sh -s -- run-kit` still works (shll ≥ v0.1.34 alias; shll ≤ v0.1.33 native), without implying otherwise. Other `docs/site/*.md` pages SHALL follow the same rule (`agent-hooks.md` `rk agent setup` / `rk update`; `skill.md` "`hexokit` is the full binary name"; `notifications.md` UI strings). Agent-hook file paths and the historical "Coming from an older formula name?" note stay.

- **GIVEN** `docs/site/*.md`
- **WHEN** grepped for `` `run-kit `` followed by a subcommand or for `sh -s -- run-kit`
- **THEN** only intentional legacy/compat mentions remain

### Packages

#### R9: Frontend package renamed
`app/frontend/package.json` `name` SHALL be `hexokit-frontend`; any reference to the old name (lockfile importer, scripts, docs) SHALL follow.

- **GIVEN** the frontend workspace
- **WHEN** `pnpm install --frozen-lockfile` runs
- **THEN** it succeeds with the renamed package

#### R10: Desktop package and Linux executable renamed
`app/desktop/package.json` `name` SHALL be `hexokit-desktop`, which renames the Linux AppImage tree to `hexokit-desktop` (ELF), `hexokit-desktop.desktop`, and `usr/share/icons/hicolor/*/apps/hexokit-desktop.png`. Every consumer SHALL follow with no legacy Linux fallback: `app/backend/internal/desktop/linux.go` (running-app probe regexp, tree validation, `.desktop` read, icon glob + refusal message, layout comment), `integrate.go` (`linuxDesktopEntryName`, `Icon=`, icon src/dst, `~/.local/bin/hexokit-desktop` link on install and uninstall, uninstall icon glob, comments), `install.go` temp patterns, `app/desktop/src/main.ts` `setDesktopName("hexokit-desktop.desktop")`, `app/desktop/tests/e2e/_shell.ts` `APP_DATA_DIR = "hexokit-desktop"`, and Go tests in `internal/desktop`. `legacyAssetPrefix = "run-kit-desktop-"` and `legacyAppBundleName = "Run Kit.app"` stay.

- **GIVEN** an extracted AppImage tree containing `AppRun`, `hexokit-desktop`, `hexokit-desktop.desktop`, and a hicolor `hexokit-desktop.png`
- **WHEN** `rk desktop install` validates it on Linux
- **THEN** validation passes, the `.desktop` entry is written as `~/.local/share/applications/hexokit-desktop.desktop` with `Icon=hexokit-desktop`, and `~/.local/bin/hexokit-desktop` links to it
- **AND** `main.ts`'s desktop name equals `linuxDesktopEntryName`

#### R11: Code-bridge display strings renamed, extension ID kept
`app/code-bridge/package.json` `displayName` and `contributes.configuration.title` SHALL be `HexoKit Code Bridge`, every command `category` SHALL be `HexoKit`, and present-tense descriptions naming run-kit SHALL name HexoKit. `src/extension.ts` output channel SHALL be `HexoKit Code Bridge` and error toasts `HexoKit: …`; `src/actions.ts` notify title SHALL be `HexoKit`. `publisher: run-kit` and `name: rk-code-bridge` MUST NOT change (installed extension ID `run-kit.rk-code-bridge`, globbed by `internal/codeserver/extension.go`).

- **GIVEN** the packaged `.vsix`
- **WHEN** code-server lists it
- **THEN** its ID is still `run-kit.rk-code-bridge` and its palette commands show under category `HexoKit`

#### R12: Desktop user-visible copy reads HexoKit
Desktop shell user-visible strings (`src/interstitial/interstitial.ts|html`, `src/welcome/welcome.ts|html`, `src/main.ts` dialog/error messages — e.g. `run-kit is not installed`, `run-kit is not responding`, `Restart run-kit`, `Start run-kit`, `<h1>run-kit</h1>`, `Stop the local run-kit daemon?`, `update run-kit and retry`) SHALL read `HexoKit`; desktop unit/e2e assertions follow.

- **GIVEN** the local daemon is not installed
- **WHEN** the interstitial shows
- **THEN** the headline reads `HexoKit is not installed`

### Governance: Constitution

#### R13: Constitution renamed by PATCH amendment
`fab/project/constitution.md` title SHALL be `# HexoKit Constitution`; present-tense identity prose (`run-kit SHALL NOT …` in II and III, `run-kit SHOULD derive …` in VII) SHALL name HexoKit; Self-Improvement Safety's `run-kit serve --restart` / `run-kit serve` SHALL read `rk serve --restart` / `rk serve`; substrate identifiers stay; Governance SHALL read `**Version**: 1.15.2 | **Ratified**: 2026-03-02 | **Last Amended**: 2026-09-29`.

- **GIVEN** the constitution
- **WHEN** grepped for `run-kit`
- **THEN** no present-tense identity mention remains, and the version is 1.15.2

### Repo URLs

#### R14: Live repo URLs point at sahil87/hexokit
Live identity URLs SHALL use `sahil87/hexokit`: `README.md` raw image URLs and the `agent-state.md` blob link; `internal/desktop/desktop.go` `DefaultRepo` (+ `release_test.go` request paths); `internal/push/send.go` `vapidSubscriber` (VAPID `sub` only); `global-chrome.tsx` and `sidebar/row-flyout-card.tsx` doc-link constants (+ `row-flyout.spec.ts` L304 expectation); `docs/site/*.md` back-links, the status-pyramid spec link and raw image URL, and `install.md`'s Releases link; live memory pointers (`toolkit-standards.md`, `architecture/backend-packages.md`). Test fixture data and historical citations stay (intake § 5 "Stay" list).

- **GIVEN** the repo after the change
- **WHEN** `git grep sahil87/run-kit` runs outside `fab/changes`, `fab/plans`, and the listed fixture/history files
- **THEN** it returns nothing

### Memory and specs

#### R15: Memory and design spec match the new strings
Memory files listed in intake § Affected Memory and `docs/specs/design.md` SHALL describe the new strings (present-tense lines only; D11 history stays). `design.md` mockup wordmark `{logo} Run Kit` → `{logo} HexoKit` and `RunKit hex logo` → `HexoKit hex logo`; `run-kit` used as an example *session name* in mockups stays. (Memory updates happen at hydrate; `design.md` at apply.)

- **GIVEN** `docs/memory/run-kit/ui/top-bar.md`
- **WHEN** it describes the brand anchor
- **THEN** it names `HexoKit home` and the `HexoKit` wordmark

### Non-Goals

- CLI help text, Go error messages, and backend log strings that name `run-kit` (e.g. `run-kit operator: fab not found on PATH`) — CLI identity was R0's scope; not swept here.
- Retiring `legacyAssetPrefix` / legacy desktop bundle fallbacks — separate cleanup.
- A code-bridge extension-ID migration — only worth it if the extension is ever published.
- Windows NSIS naming verification — Windows is not an `rk desktop` install target.

### Design Decisions

#### Desktop Linux tree renamed without a legacy fallback
**Decision**: Rename `run-kit-desktop` → `hexokit-desktop` for the npm package and every derived Linux AppImage name (ELF, `.desktop`, icon, `~/.local/bin` link), updating the Go installer's validation to the new names only.
**Why**: The user confirmed no one uses the Linux desktop package yet, so this is the cheapest moment; a dual-name validator would carry permanent complexity for zero users.
**Rejected**: Keeping `run-kit-desktop` (a code-bridge-style carve-out) — leaves a permanent legacy name in the tree; pinning `executableName: run-kit-desktop` — renames only the invisible string while keeping the visible one.
*Introduced by*: 260929-y8ib-hexokit-brand-string-sweep

#### Code-bridge extension ID kept
**Decision**: Change only display strings (`displayName`, configuration title, command category, descriptions); keep `publisher: run-kit` + `name: rk-code-bridge`.
**Why**: The pair is the installed extension ID; rk installs the private `.vsix` per user and `internal/codeserver/extension.go` globs the old ID, so renaming would install a second extension beside the old one.
**Rejected**: Full ID rename — needs a real migration (uninstall old, install new, settings carry) that only pays off if the extension is published.
*Introduced by*: 260929-y8ib-hexokit-brand-string-sweep

## Tasks

### Phase 1: Setup

- [x] T001 In a fresh worktree run `pnpm install --frozen-lockfile` in `app/frontend` and `app/desktop` (and `app/code-bridge` if it has its own lockfile) and `just _ensure-tmux-conf`, so the later test gates can run <!-- R9 -->

### Phase 2: Core Implementation

- [x] T002 [P] Rename the wordmark text and `RunKit home` label in `app/frontend/src/components/top-bar.tsx` (both sites) and `app/frontend/src/components/sidebar/index.tsx`; update comments naming the label <!-- R1 -->
- [x] T003 [P] Update `app/frontend/src/hooks/use-browser-title.ts`, `app/frontend/index.html` `<title>`, `app/frontend/public/manifest.json` `name`/`short_name`, and `app/backend/api/pwa_test.go` <!-- R2 -->
- [x] T004 [P] Update notification default titles in `app/frontend/public/sw.js`, `app/frontend/src/lib/push.ts`, `app/frontend/src/lib/shell-notifications.ts`, `app/frontend/src/hooks/use-push-subscription.ts`, `app/backend/api/push.go` (+ `push_test.go`, `sse_test.go` default-title assertions) <!-- R3 -->
- [x] T005 [P] Update version/update rows and labels in `app/frontend/src/components/top-bar-overflow-menu.tsx`, `app/frontend/src/components/top-bar.tsx` update chip, and `app/frontend/src/components/sidebar/index.tsx` (version button label, `Connected — HexoKit …` tooltip) <!-- R4 -->
- [x] T006 [P] Update lowercase UI brand strings in `app/frontend/src/lib/palette/update.ts`, `lib/palette/version.ts`, `lib/palette/server-adopt.ts`, `components/top-bar-overflow-menu.tsx` (`Help — HexoKit docs`), `components/server-dialogs.tsx`, `components/system-card.tsx`, `components/host-overview-page.tsx`, `components/sidebar/server-card.tsx`, `components/iframe-window.tsx`; then sweep `app/frontend/src` (non-test) for any remaining user-visible `run-kit`/`RunKit` literal and apply the same rule (ids/identifiers untouched) <!-- R5 -->
- [x] T007 [P] Point `HELP_URL` in `app/frontend/src/components/global-chrome.tsx` at `https://hexokit.com/docs/` and the topic URLs in `app/frontend/src/lib/help-topics.ts` at `https://hexokit.com/docs/<topic>/` / `https://hexokit.com/fab-kit/<topic>/`; check any display-form/host special-casing of `shll.ai` in `app/frontend/src/lib` that these URLs flow through <!-- R6 -->
- [x] T008 [P] Update mock wordmarks in `app/frontend/public/tutorial/tutorial.html`; confirm `app/frontend/src/components/control-gallery.tsx` renders no wordmark <!-- R7 -->
- [x] T009 [P] Rewrite `docs/site/install.md` per R8 (rk examples, `sh -s -- hexokit` ×2, hexokit binary prose, legacy-arg note, Releases link); apply the same rule to `docs/site/agent-hooks.md`, `docs/site/skill.md`, `docs/site/notifications.md`, and any other `docs/site/*.md` with `run-kit <verb>` examples or `RunKit` UI strings <!-- R8 -->
- [x] T010 [P] Rename `app/frontend/package.json` `name` → `hexokit-frontend` and update any lockfile/reference to the old name <!-- R9 -->
- [x] T011 Rename `app/desktop/package.json` `name` → `hexokit-desktop` (+ `app/desktop/pnpm-lock.yaml` importer if it records the name); update `app/backend/internal/desktop/linux.go`, `integrate.go`, `install.go` and their `_test.go` files to the `hexokit-desktop` tree/entry/icon/link names (no legacy Linux fallback; keep `legacyAssetPrefix` and `legacyAppBundleName`); update `app/desktop/src/main.ts` `setDesktopName` and `app/desktop/tests/e2e/_shell.ts` `APP_DATA_DIR` + comments <!-- R10 -->
- [x] T012 [P] Update `app/code-bridge/package.json` `displayName`, configuration `title`, all command `category` values, and descriptions naming run-kit; update `app/code-bridge/src/extension.ts` output channel + error toasts and `src/actions.ts` notify title, with their tests; leave `publisher` and `name` untouched <!-- R11 -->
- [x] T013 [P] Update desktop user-visible copy in `app/desktop/src/interstitial/interstitial.ts`, `interstitial.html`, `app/desktop/src/welcome/welcome.ts`, `welcome.html`, `app/desktop/src/main.ts` (dialogs/errors) and their unit/e2e assertions <!-- R12 -->
- [x] T014 [P] Amend `fab/project/constitution.md` per R13 (title, II/III/VII prose, `rk serve` examples, Governance 1.15.2 / 2026-09-29) <!-- R13 -->
- [x] T015 [P] Replace live `sahil87/run-kit` URLs per R14: `README.md`, `app/backend/internal/desktop/desktop.go` `DefaultRepo` + `release_test.go`, `app/backend/internal/push/send.go` `vapidSubscriber`, `app/frontend/src/components/global-chrome.tsx`, `app/frontend/src/components/sidebar/row-flyout-card.tsx` + `app/frontend/tests/e2e/row-flyout.spec.ts` L304, `docs/site/cron-schedule-kinds.md`, `gui.md`, `notifications.md`, `status-dot.md`, `install.md` <!-- R14 -->
- [x] T016 [P] Update `docs/specs/design.md` wordmark mentions per R15 (mockup session name `run-kit` stays) <!-- R15 -->

### Phase 3: Integration & Edge Cases

- [x] T017 Update every frontend unit test keyed on changed strings — at least `top-bar.test.tsx`, `top-bar.update-chip.test.tsx`, `top-bar-overflow-menu.test.tsx`, `sidebar/index.test.tsx`, `host-overview-page.test.tsx`, `hooks/use-browser-title.test.ts`, `lib/shell-notifications.test.ts`, `lib/palette/update.test.ts`, `hooks/use-update-check.test.tsx`, `contexts/session-context.test.tsx`, system-card / server-dialog / help-topics / palette version / server-adopt tests — leaving fixture data (`tool: "run-kit"` legacy rows, repo paths) as is <!-- R1 -->
- [x] T018 Update e2e specs keyed on changed strings — `full-height-sidebar.spec.ts`, `top-bar-persistence.spec.ts`, `tooltips.spec.ts`, `top-bar-overflow.spec.ts` (version regex, `Help — HexoKit docs`, `href` `https://hexokit.com/docs/`), `sidebar-footer.spec.ts`, `pwa-assets.spec.ts`, `host-system-card.spec.ts`, `help-topics.spec.ts`, `row-flyout.spec.ts`, and any palette-label or operator-compose count assertion affected; keep every spec's JSDoc Proves/Steps block accurate (constitution Test Intent Comments) <!-- R1 -->
- [x] T019 Run the gates and fix failures: `cd app/frontend && pnpm exec tsc --noEmit` (or the project's typecheck recipe) and `just test-frontend` (full Vitest); `env -u TMUX -u TMUX_PANE go test ./...` in `app/backend`; `pnpm compile && pnpm test` in `app/desktop`; code-bridge tests (`app/code-bridge` test script); then the touched e2e specs one at a time with `just test-e2e <name>.spec` (never the full suite — the orchestrator runs that), including `control-gallery.spec.ts` <!-- R7 -->
- [x] T020 If feasible in this sandbox, package a Linux AppImage directory build for `app/desktop` (e.g. `pnpm exec electron-builder --linux dir` after `pnpm compile`) and confirm the unpacked tree names `hexokit-desktop` and its `.desktop`/icon names match what `internal/desktop/linux.go` validates; record the result (or "unverified: <reason>") in `## Notes` <!-- R10 -->

### Phase 4: Polish

- [x] T021 Final sweep: `git grep -n 'RunKit\|sahil87/run-kit\|run-kit-desktop\|run-kit-frontend'` and `git grep -n 'run-kit' -- app/frontend/src app/desktop/src app/code-bridge docs/site README.md fab/project/constitution.md` outside tests/fixtures; every remaining hit is either a substrate identifier, a legacy/compat constant, fixture data, or history (D11) — list any intentional survivors in `## Notes` <!-- R14 -->

## Execution Order

- T001 precedes T019/T020 (deps installed).
- T002–T016 are independent edits; T017/T018 follow them; T019 follows T017/T018; T020 follows T011; T021 last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: Top-bar and sidebar wordmarks render `HexoKit`; the brand anchor's label is `HexoKit home`; no `RunKit home` remains in src or tests
- [x] A-002 R2: Dashboard title is `HexoKit` / `HexoKit — {hostname}`; `index.html` title and manifest `name`/`short_name` are `HexoKit`
- [x] A-003 R3: All five notification default-title sites (sw.js, push.ts, shell-notifications.ts, use-push-subscription.ts, backend push.go) use `HexoKit`
- [x] A-004 R4: Version row `HexoKit v{version}` / plain `HexoKit`, update row `HexoKit v… → v… ⬆`, `Update HexoKit: …`, `Updating HexoKit`, sidebar `HexoKit … (copy)` and `Connected — HexoKit …`
- [x] A-005 R5: Palette labels, Help row, server dialogs, system card, host-overview version line, server card, iframe hint read HexoKit; palette/command ids unchanged
- [x] A-006 R6: `HELP_URL` and all help-topic URLs point at hexokit.com (`/docs/…`, `/fab-kit/…`); no `shll.ai` URL remains in `app/frontend/src` non-test code
- [x] A-007 R7: Tutorial mock wordmarks read HexoKit; control-gallery spec passes with unchanged baselines (or regenerated + reviewed)
- [x] A-008 R8: `docs/site/*.md` examples use `rk`, bootstrap uses `sh -s -- hexokit`, install.md notes the legacy `run-kit` arg still works; hook file paths untouched
- [x] A-009 R9: Frontend package is `hexokit-frontend`; frozen-lockfile install succeeds
- [x] A-010 R10: Desktop package is `hexokit-desktop`; `linux.go`/`integrate.go`/`install.go`, `main.ts` setDesktopName, and `_shell.ts` APP_DATA_DIR all use `hexokit-desktop` names; desktop Go tests pass
- [x] A-011 R11: Code-bridge displayName/title `HexoKit Code Bridge`, categories `HexoKit`, output channel/toasts/notify title HexoKit; `publisher` `run-kit` and `name` `rk-code-bridge` unchanged
- [x] A-012 R12: Desktop interstitial/welcome/main dialog copy reads HexoKit
- [x] A-013 R13: Constitution titled `# HexoKit Constitution`, identity prose HexoKit, `rk serve` examples, version 1.15.2, Last Amended 2026-09-29
- [x] A-014 R14: No live `sahil87/run-kit` URL remains outside the intake's fixture/history stay-list
- [x] A-015 R15: `docs/specs/design.md` wordmark mentions read HexoKit

### Behavioral Correctness

- [x] A-016 R5: `SELF_TOOL_NAMES` still contains `run-kit` (legacy self-row recognition unchanged); updatecheck behavior unchanged
- [x] A-017 R10: `main.ts` desktop name equals `integrate.go` `linuxDesktopEntryName` (`hexokit-desktop.desktop`)

### Scenario Coverage

- [x] A-018 R1: Unit tests and e2e specs assert the new labels (`HexoKit home`, `HexoKit v…`, `HexoKit system`, help href) and pass: full Vitest, Go tests, desktop tests, code-bridge tests, touched e2e specs
- [x] A-019 R10: The desktop package build tree names were verified by a local Linux dir build, or recorded as unverified with a reason

### Edge Cases & Error Handling

- [x] A-020 R4: Unknown daemon version shows plain `HexoKit` (no `vundefined`) and copy is a no-op
- [x] A-021 R10: Tree validation refuses a tree lacking the `hexokit-desktop` icon with a message naming `hexokit-desktop`

### Code Quality

- [x] A-022 Pattern consistency: Renamed strings follow the surrounding code's existing literal/constant style; no new abstractions introduced for a string swap
- [x] A-023 No unnecessary duplication: Shared constants (e.g. `HELP_URL`, `DEFAULT_TITLE`) are edited at their single definition rather than duplicated
- [x] A-024 Substrate untouched: no rename of `rk`, `RK_*`, `@rk_*`, `rk-*`, `rk.*`, Go module, palette ids, memory domain folder, or code-bridge extension ID (diff inspection)
- [x] A-025 Test Intent Comments: every edited Playwright test keeps an accurate JSDoc Proves/Steps block

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

### T020 — Linux AppImage tree verification: VERIFIED

`pnpm compile` + `pnpm exec electron-builder --linux AppImage` in `app/desktop`, extracted with `--appimage-extract`. The tree contains exactly what `internal/desktop/linux.go` validates: `AppRun`, `hexokit-desktop` (ELF x86-64), `hexokit-desktop.desktop` (`Icon=hexokit-desktop`, `StartupWMClass=HexoKit`, `X-AppImage-Version` stamp), `usr/share/icons/hicolor/1024x1024/apps/hexokit-desktop.png`, `.DirIcon` symlink. Artifact name `hexokit-desktop-0.0.0-test-x86_64.AppImage` matches `assetPrefix`. Windows NSIS naming remains unverified (not an `rk desktop` target).

### T021 — final sweep: intentional survivors

`git grep 'RunKit\|sahil87/run-kit\|run-kit-desktop\|run-kit-frontend'` and the scoped `run-kit` sweep leave only:

- **Substrate identifiers / legacy constants (guardrail-kept)**: palette ids (`run-kit-restart`, `run-kit-version`, …), `SELF_TOOL_NAMES` containing `"run-kit"`, `singleRunKit`/`runKitTool` identifiers, help-topic `tool: "run-kit"` discriminator, code-bridge `publisher: "run-kit"` + `name: rk-code-bridge`, `LEGACY_HOME_DIR_NAME`, `legacyAssetPrefix = "run-kit-desktop-"`, `legacyAppBundleName = "Run Kit.app"`, Electron `appId: ai.shll.run-kit`, legacy localStorage keys `runkit-theme`/`runkit-instance-color`, `docs/memory/run-kit/` paths (memory untouched at apply).
- **Compat notes (intentional present-truth)**: `docs/site/install.md` legacy `sh -s -- run-kit` bootstrap note and "Coming from an older formula name?" history; `README.md` "`run-kit` is an alias too" (true via shll); `app/desktop/src/local-daemon.ts` parser comment matching real `rk --version` output (`run-kit version v…` — CLI output format is R0's scope).
- **Fixture data**: `internal/prstatus/*_test.go`, `framecheck_test.go`, frontend status-panel/status-bar/terminal-client/web-frame-iframe/web-url/format/session-row tests, `window-open.test.ts`, `pane-register-panel.spec.ts`, `row-flyout.spec.ts` path fixtures, `test-utils/fixtures.ts`, updatecheck `tool: "run-kit"` legacy rows and toasts composed from them, `sse_test.go` explicit-title broadcast payload, `internal/desktop` legacy-prefix asset fixtures (`run-kit-desktop-3.12.2-…` exercising the legacy fallback), `docs/specs/api.md`/`code-bridge.md` example local paths, `docs/specs/design.md` example session names + decision-record row 24 (history, D11).
- **Comments**: code comments narrating internal concepts as "run-kit's …" (allowed to follow; not required to move).
- **Beyond-scope flags for review**: `tests/e2e/echo-latency.spec.ts` dev-facing perf label `run-kit tax`; `tests/e2e/gui-perf.spec.ts` fixture HTML `<h1>run-kit GUI smoothness page</h1>` — both fixture/perf terminology, left as-is.

## Deletion Candidates

- None — this change is a pure identity-string substitution (418 insertions / 418 deletions, zero net lines, no new symbols or branches); it makes no existing code redundant. The legacy constants it touches (`legacyAssetPrefix`, `legacyAppBundleName`, `LEGACY_HOME_DIR_NAME`, the `run-kit` entry in `SELF_TOOL_NAMES`) are deliberately retained per the plan's guardrails, and retiring `legacyAssetPrefix` is a declared Non-Goal (separate cleanup).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | CLI help/Go error strings naming run-kit are out of scope (Non-Goal) | T1 row groups are UI/docs/packages/constitution/URLs; CLI identity was R0 | S:75 R:90 A:85 D:80 |
| 2 | Confident | Help-topic `tool: "run-kit"` discriminator stays as an identifier | It gates a per-tool badge in the overflow menu, not displayed text | S:65 R:90 A:80 D:70 |
| 3 | Certain | e2e gating is per-spec in the worker; the orchestrator owns the single full e2e run | Memory: one full e2e run per worktree; workers run single specs only | S:70 R:95 A:85 D:80 |
| 4 | Certain | Design.md mockups keep `run-kit` where it is an example session name | It is fixture-like example data, not the product name | S:70 R:95 A:80 D:70 |

4 assumptions (3 certain, 1 confident, 0 tentative).
