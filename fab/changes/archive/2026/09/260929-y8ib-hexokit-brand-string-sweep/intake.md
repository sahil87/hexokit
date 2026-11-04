# Intake: HexoKit Brand-String Sweep (Phase 4 T1)

**Change**: 260929-y8ib-hexokit-brand-string-sweep
**Created**: 2026-09-29

## Origin

Phase 4 of the HexoKit rebrand, plan row **T1** in
`fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` (rules table D2/D8/D9/D11/D14/D15 bind). Sahil gave explicit go-ahead for T1 ∥ T2 from `main`; A3 (the announce) is treated as done. The user prompt (operator-relayed):

> Every remaining Brand-tier "RunKit"/"run-kit" identity string and repo URL, per the plan row's 5 numbered groups … Hard guardrails: no substrate renames anywhere (rk binary, RK_*, @rk_*, rk-* sockets/settings-keys, Go module `rk`). Historical/past-tense narrative text stays as-is (rule D11) — only present-truth identity strings change. … Do not merge the PR yourself.

Interaction was conversational; two scope decisions were put to the user during intake (both answered, see Assumptions #2 and #3):

1. **Scope widened (user chose "Include both")**: the row's Web UI list missed a second tier of live, user-visible lowercase `run-kit` strings (palette labels, overflow Help row, system card, update labels, server dialogs, sidebar tooltip) and the help URLs pointing at the `shll.ai` redirect host. Both are in scope.
2. **Desktop package rename (user: "No one is using linux package right now — its a good time to rename it — both the package and executable")**: `run-kit-desktop` → `hexokit-desktop` is done **fully**, including the Linux AppImage executable / `.desktop` / icon names and every Go/TS site that keys on them. No legacy-name fallback is needed for Linux installs.

## Why

The rebrand's Phases 0–3 renamed the command (`hexokit`), the formula, the repo (`sahil87/hexokit`), the homes, and the docs — but the web UI a user actually looks at still says **RunKit** (top-bar wordmark, tab title, PWA name, notification titles, version row), the palette says `run-kit: …`, the install doc tells people to type `run-kit …` and `sh -s -- run-kit`, the code-bridge shows up in VS Code as "run-kit Code Bridge", the constitution is titled "run-kit Constitution", and ~20 live files link `sahil87/run-kit` (working only through GitHub's rename redirect). X3 (memory hydrate) deliberately left the UI-describing memory lines matching the code's `RunKit`, so memory and code must move together here.

If not done: the product presents two names at once to every user after the announce, docs teach the legacy command name against rule D2, and repo links depend on a redirect GitHub only keeps while no new repo takes the old name.

Approach: one sweep PR, grouped by surface, strictly Brand-tier — identity *strings* change, substrate *identifiers* never do (D2). History is not renamed (D11).

## What Changes

Global rule for every group: **change present-truth identity strings only.** Never rename: the `rk` binary / `rk …` commands, `RK_*` env vars, `@rk_*` tmux options, `rk-*` sockets/sessions/CSS classes/settings keys, `rk.*` code-bridge settings keys, the Go module `rk`, the `docs/memory/run-kit/` domain folder and its `# run-kit …` headings, palette/command **ids** (e.g. `run-kit-restart`, `run-kit-version` stay), code identifiers (`singleRunKit`, `SELF_TOOL_NAMES` — which must keep matching `run-kit` as a legacy self-row name — `runKitTool`, Go/TS test function names), the help-topic `tool: "run-kit"` discriminator in `lib/help-topics.ts`, on-disk file names rk writes for agent hooks (`$COPILOT_HOME/hooks/run-kit.json`, `~/.config/opencode/plugins/run-kit.js`), `LEGACY_HOME_DIR_NAME = 'run-kit'` and other legacy-migration constants, the Electron `appId: ai.shll.run-kit` (D8), and code-bridge `publisher: run-kit` + `name: rk-code-bridge`. Historical text (fab archives, `log.md`/`log.seed.md`, change-ID citations, Design Decisions narrating the past, old PR links) stays.

### 1. Web UI (app/frontend + backend defaults)

Wordmark and identity strings `RunKit` → `HexoKit`:

- `src/components/top-bar.tsx`: wordmark `<span>RunKit</span>` (both the ~L347 and ~L1450 sites) → `HexoKit`; both `aria-label="RunKit home"` → `aria-label="HexoKit home"`; comment mentions of the label follow.
- `src/components/sidebar/index.tsx`: mobile nav wordmark `<span>RunKit</span>` (~L2069) → `HexoKit`; version button `aria-label={\`RunKit ${versionText} (copy)\`}` → `HexoKit …`; tooltip `` `Connected — run-kit ${displayVersion(daemonVersion)}` `` → `Connected — HexoKit …`; comments naming the labels follow.
- `src/components/top-bar-overflow-menu.tsx`: version row `` `RunKit ${displayVersion(daemonVersion)}` `` / plain `"RunKit"` → `HexoKit`; update row `` `RunKit v${current} → v${latest} ⬆` `` → `HexoKit v… → v… ⬆`; `aria-label` fallbacks; `Update run-kit: v… → v…` → `Update HexoKit: v… → v…`; `"Updating run-kit"` → `"Updating HexoKit"`; `Help — run-kit docs` → `Help — HexoKit docs`.
- `src/components/top-bar.tsx` update chip (~L2844/2859): `Update run-kit: v… → v…` → `Update HexoKit: …`, `"Updating run-kit"` → `"Updating HexoKit"`.
- `src/hooks/use-browser-title.ts`: `` `RunKit${suffix}` `` → `` `HexoKit${suffix}` `` (dashboard title `HexoKit — {hostname}`); doc comment follows. `index.html` `<title>RunKit</title>` → `<title>HexoKit</title>`.
- `public/manifest.json`: `name` and `short_name` `RunKit` → `HexoKit`. Backend `app/backend/api/pwa_test.go` expects the manifest name → update to `HexoKit`.
- Notification default titles `RunKit` → `HexoKit`: `public/sw.js` (`DEFAULT_TITLE` + header comment), `src/lib/push.ts` (`showNotification("RunKit", …)`), `src/lib/shell-notifications.ts` (`rawTitle?.trim() || "RunKit"`), `src/hooks/use-push-subscription.ts` (`new Notification("RunKit", …)`), backend `app/backend/api/push.go` (`title = "RunKit"` default) + `push_test.go` / `sse_test.go` fixtures asserting it.
- Lowercase UI brand strings (scope widened by the user) `run-kit` → `HexoKit`:
  - `src/lib/palette/update.ts` labels: `run-kit: Dismiss Update Notice`, `run-kit: Update Now`, `run-kit: Restart Daemon`, `run-kit: Check for Updates`, `run-kit: Check for Updates (incl. patches)` → `HexoKit: …` (ids unchanged).
  - `src/lib/palette/version.ts`: `` `run-kit: Version — …` `` → `` `HexoKit: Version — …` `` (id `run-kit-version` unchanged).
  - `src/lib/palette/server-adopt.ts`: `` `Server: Adopt ${s.name} into run-kit` `` → `… into HexoKit`.
  - `src/components/server-dialogs.tsx`: `"Failed to restart run-kit"`, `hosts the run-kit daemon serving this dashboard`, `Adopt server into run-kit?`, `Adopt server … into run-kit? run-kit's tmux config is …`, `Restart run-kit` → HexoKit.
  - `src/components/system-card.tsx`: `aria-label="run-kit system"` → `"HexoKit system"`, visible `run-kit` label → `HexoKit`, `"Failed to restart run-kit"` → HexoKit. `src/components/host-overview-page.tsx` version line `run-kit {displayVersion(...)}` → `HexoKit …`.
  - `src/components/sidebar/server-card.tsx`: `external — not started by run-kit` → `… by HexoKit`.
  - `src/components/iframe-window.tsx` hint copy `proxied through run-kit` → `proxied through HexoKit`.
  - Sweep any other JSX/string-literal user-visible `run-kit`/`RunKit` in `app/frontend/src` found at apply time with the same rule (comments may follow but are not required).
- Help URLs (`shll.ai` is a permanent redirect host; mapping verified 2026-09-29 by fetching each page's meta-refresh/canonical): `src/components/global-chrome.tsx` `HELP_URL = "https://shll.ai/run-kit"` → `"https://hexokit.com/docs/"`; `src/lib/help-topics.ts` run-kit topics `https://shll.ai/run-kit/<topic>/` → `https://hexokit.com/docs/<topic>/` (status-dot, cron-schedule-kinds, boards, notifications, gui), fab-kit topics `https://shll.ai/fab-kit/<topic>/` → `https://hexokit.com/fab-kit/<topic>/` (merge-topologies, fkf). Check any URL→display-form helpers/tests that special-case the `shll.ai` host (e.g. tab titles showing `shll.ai/run-kit/cron-schedule-kinds/` in `tests/e2e/help-topics.spec.ts`) and move them with it.
- `public/tutorial/tutorial.html`: the mock wordmark `RunKit` spans → `HexoKit`.
- **Tests move in the same change** (unit + e2e): every assertion/selector keying on the old strings — at least `top-bar.test.tsx`, `top-bar.update-chip.test.tsx`, `top-bar-overflow-menu.test.tsx`, `sidebar/index.test.tsx`, `host-overview-page.test.tsx`, `use-browser-title.test.ts`, `shell-notifications.test.ts`, `lib/palette/update.test.ts`, `use-update-check.test.tsx`, `session-context.test.tsx`, system-card/server-dialog tests, help-topics tests; e2e `full-height-sidebar.spec.ts`, `top-bar-persistence.spec.ts`, `tooltips.spec.ts`, `top-bar-overflow.spec.ts` (version row regex `/RunKit/`, `Help — run-kit docs`, `href` `https://shll.ai/run-kit`), `sidebar-footer.spec.ts` (`/RunKit .*\(copy\)/`), `pwa-assets.spec.ts`, `host-system-card.spec.ts` (`run-kit system`), `help-topics.spec.ts`. Test **fixture data** that happens to contain `run-kit` (repo paths `/home/user/code/run-kit`, `monitoredRepo`, the updatecheck `tool: "run-kit"` legacy row, operator error text echoing a backend message) stays.
- `/__controls`: the control gallery (`src/components/control-gallery.tsx`) renders no wordmark (it imports only `controls`/`control`), so **no baseline regeneration is expected**; apply re-verifies by grepping the gallery and running `control-gallery.spec.ts` — if it does change, regenerate `control-gallery-{fine,coarse}-chromium-linux.png` and review the PNG diff before committing.

### 2. Install doc and other docs/site pages (rule D2: docs use `rk`)

- `docs/site/install.md`: every command example `run-kit <verb>` → `rk <verb>` (daemon start/restart/stop, riff, desktop install/update/status, update, agent setup, doctor, notify, …); prose "puts the `run-kit` binary on your `PATH`" → `hexokit` binary (with `rk` as the interchangeable short name — mention `xk` once as an alias per D2 only if the sentence already enumerates aliases); bootstrap `curl -fsSL https://hexokit.com/install | sh -s -- run-kit` → `… sh -s -- hexokit` (both occurrences); the "Coming from an older formula name?" historical note stays; `shll setup agent` "delegates to `run-kit agent setup`" → `rk agent setup`; GitHub Releases link → `sahil87/hexokit`; the Linux manual AppImage fallback text follows the desktop rename (group 3).
- **Finding to record in the doc change and the PR body — does the old arg still work?** Yes: `sh -s -- run-kit` keeps working — shll ≥ v0.1.34 resolves `run-kit` as a target alias (`note: run-kit is now hexokit`, verified locally on shll v0.1.35) and shll ≤ v0.1.33 knows `run-kit` natively. Caveat: the *new* explicit `sh -s -- hexokit` fails on a box that already has a stale shll ≤ v0.1.33 installed, because hexokit.com's stale-shll guard only rewrites the **no-arg** default (verified by reading the live `https://hexokit.com/install` epilogue) and the bootstrap does not upgrade an installed shll — closed by T2(a) (`brew upgrade sahil87/tap/shll` before `shll install`). Fresh boxes are unaffected.
- `docs/site/agent-hooks.md`: `run-kit agent setup` / `run-kit update` → `rk …`. Hook file paths `hooks/run-kit.json` / `plugins/run-kit.js` are on-disk names — unchanged.
- `docs/site/skill.md`: "`rk` is the short alias; `run-kit` is the full binary name" → `hexokit` is the full binary name.
- `docs/site/notifications.md`: UI `RunKit` strings follow group 1; back-link follows group 5.
- Sweep the remaining `docs/site/*.md` for `run-kit <verb>` command examples and `RunKit` UI strings with the same rule.

### 3. Package names

- `app/frontend/package.json` `"name": "run-kit-frontend"` → `"hexokit-frontend"` (+ any lockfile/workspace/filter reference; none found at intake besides the package.json itself).
- **Desktop — full rename (user decision)**: `app/desktop/package.json` `"name": "run-kit-desktop"` → `"hexokit-desktop"`. electron-builder derives the Linux `executableName` from the package name, so the extracted AppImage tree becomes `AppRun`, `hexokit-desktop` (ELF), `hexokit-desktop.desktop`, `usr/share/icons/hicolor/*/apps/hexokit-desktop.png`. Every consumer moves with it:
  - `app/backend/internal/desktop/linux.go`: running-app probe regexp (`…/<version>/run-kit-desktop`), tree validation list (`{"run-kit-desktop", true}`, `{"run-kit-desktop.desktop", false}`), the `.desktop` read, the hicolor icon glob + its refusal message, the layout doc comment.
  - `app/backend/internal/desktop/integrate.go`: `linuxDesktopEntryName = "run-kit-desktop.desktop"` → `hexokit-desktop.desktop`, `Icon=run-kit-desktop` → `Icon=hexokit-desktop`, icon src/dst `run-kit-desktop.png`, `~/.local/bin/run-kit-desktop` link (install + uninstall paths + comments), uninstall icon glob, the `~/.config/run-kit-desktop` user-data comment (unpackaged dev userData only; packaged userData is keyed on productName `HexoKit`).
  - `app/backend/internal/desktop/install.go`: temp-file patterns `run-kit-desktop-*.dmg` / `run-kit-desktop-mnt-` → `hexokit-desktop-…` (cosmetic, same sweep).
  - Keep `legacyAssetPrefix = "run-kit-desktop-"` (release-asset fallback for pre-rename releases) and `legacyAppBundleName = "Run Kit.app"` — legacy constants, not identity.
  - `app/desktop/src/main.ts`: `app.setDesktopName("run-kit-desktop.desktop")` → `"hexokit-desktop.desktop"` (must match `linuxDesktopEntryName`).
  - `app/desktop/tests/e2e/_shell.ts`: `APP_DATA_DIR = "run-kit-desktop"` → `"hexokit-desktop"` (unpackaged `electron .` userData follows the package name) + doc comments.
  - Go tests in `internal/desktop` seeding tree names/paths move with it.
  - **No legacy Linux fallback** — the user confirmed no one uses the Linux package yet. Consequence to state in the PR: an rk ≤ v3.20.23 will refuse to install a desktop release built after this change on Linux (tree validation expects the old names); `rk update` to the matching release fixes it. macOS (DMG, `HexoKit.app`) and packaged userData are unaffected. Windows NSIS naming derived from the package name is not verified (Windows is not a shipped `rk desktop` target).
  - Apply SHOULD verify the derived names by packaging a Linux AppImage locally (or `--dir` target) and listing the tree, if the build is feasible in the sandbox; otherwise record it as unverified.
- `app/code-bridge/package.json`: `displayName` `"run-kit Code Bridge"` → `"HexoKit Code Bridge"`; `contributes.configuration.title` → `"HexoKit Code Bridge"`; every command `"category": "run-kit"` → `"HexoKit"`; present-tense `description` strings naming run-kit (package description, `rk.bridge.enabled` / tab / server setting descriptions) → HexoKit. **KEEP `"publisher": "run-kit"` and `"name": "rk-code-bridge"`** — together the installed extension ID `run-kit.rk-code-bridge`; `internal/codeserver/extension.go` globs it on disk and a renamed ID would install a second extension beside the old one. Add nothing that changes the ID.
  - `app/code-bridge/src/extension.ts`: output channel `'run-kit Code Bridge'` → `'HexoKit Code Bridge'`, error toasts `'run-kit: …'` → `'HexoKit: …'`; `src/actions.ts` notify `--title run-kit` → `HexoKit`; tests follow. `state-dir.ts` `LEGACY_HOME_DIR_NAME = 'run-kit'` stays.
  - Desktop user-visible strings (same brand tier, surfaced at intake): `src/interstitial/interstitial.ts|html`, `src/welcome/welcome.ts|html`, `src/main.ts` dialog/error messages — `run-kit is not installed`, `run-kit is not responding`, `Restart run-kit`, `Start run-kit`, `<h1>run-kit</h1>`, `Stop the local run-kit daemon?`, `update run-kit and retry`, etc. → HexoKit; desktop unit/e2e assertions follow.

### 4. Constitution amendment

`fab/project/constitution.md`:
- Title `# run-kit Constitution` → `# HexoKit Constitution`.
- Present-tense identity prose `run-kit SHALL NOT …` (II, III), `run-kit SHOULD derive …` (VII) → `HexoKit …`.
- Self-Improvement Safety: `run-kit serve --restart` … `run-kit serve` → `rk serve --restart` / `rk serve` (D2: docs name commands with `rk`).
- Substrate identifiers in principle text unchanged (`RK_PORT`, `@rk_*`, `internal/settings`, paths).
- Governance line: wording-only amendment → **PATCH** bump per the `/fab-setup` amendment convention (Modify → "wording clarification" = PATCH; precedent C4 bumped 1.15.0 → 1.15.1 for a path rename): `**Version**: 1.15.1 | **Ratified**: 2026-03-02 | **Last Amended**: 2026-09-26` → `**Version**: 1.15.2 | **Ratified**: 2026-03-02 | **Last Amended**: 2026-09-29`. The constitution has no separate changelog section.

### 5. Repo URL sweep `sahil87/run-kit` → `sahil87/hexokit`

Live identity URLs only:
- `README.md`: raw image URLs (`raw.githubusercontent.com/sahil87/run-kit/main/assets/logo.svg`, `docs/img/dashboard-agent-session.webp`, `docs/img/status-dot-reference.svg`) and the `blob/main/docs/specs/agent-state.md` link.
- `app/backend/internal/desktop/desktop.go` `DefaultRepo = "sahil87/run-kit"` → `"sahil87/hexokit"`; `release_test.go` expected request paths `/repos/sahil87/hexokit/releases/…`.
- `app/backend/internal/push/send.go` `vapidSubscriber = "https://github.com/sahil87/run-kit"` → `…/sahil87/hexokit` (VAPID JWT `sub` contact claim only; keys and subscriptions are unaffected).
- `src/components/global-chrome.tsx` notifications doc link and `src/components/sidebar/row-flyout-card.tsx` status-dot doc link → `github.com/sahil87/hexokit/blob/main/docs/site/…`; e2e `row-flyout.spec.ts` L304 assertion follows.
- `docs/site/*.md` back-links (`cron-schedule-kinds.md`, `gui.md`, `notifications.md`, `status-dot.md` incl. its `docs/specs/status-pyramid.md` link and raw image URL) and `install.md`'s Releases link.
- Live memory/spec pointers: `docs/memory/run-kit/toolkit-standards.md`, `docs/memory/run-kit/architecture/backend-packages.md` (DefaultRepo / vapidSubscriber facts).
- **Stay (fixture data / history, D11)**: `internal/prstatus/*_test.go` origin/PR fixtures, frontend `status-panel`/`status-bar`/`terminal-client`/`web-frame-iframe`/`web-url`/`format` test URLs and `~/code/sahil87/run-kit` local paths, `framecheck_test.go`, `app/desktop/src/window-open.test.ts`, `pane-register-panel.spec.ts` paths, `docs/specs/api.md`/`code-bridge.md` example local paths, `prstatus_branch.go` doc-comment example, `fab/backlog.md`, `docs/findings/*`, `docs/wiki/*` study pages, old PR links.

## Affected Memory

- `run-kit/ui/top-bar`: (modify) wordmark `HexoKit`, `HexoKit home` label, overflow version/update/help rows, update-chip labels, HELP_URL → hexokit.com/docs/
- `run-kit/ui/sidebar`: (modify) mobile nav wordmark, version button label, `Connected — HexoKit v…` tooltip
- `run-kit/ui/updates-and-notifications`: (modify) version row / update labels / palette labels / notification default title
- `run-kit/ui/routes-and-shell`: (modify) wordmark text, document.title
- `run-kit/pwa-and-push`: (modify) manifest name/short_name, notification default titles, vapidSubscriber URL
- `run-kit/ui/visual-design`: (modify) wordmark mentions, if present-tense
- `run-kit/ui/boards`: (modify) wordmark/brand mention, if present-tense
- `run-kit/ui/lenses-and-layout`: (modify) help-topic URLs → hexokit.com
- `run-kit/desktop-shell`: (modify) package name `hexokit-desktop`, Linux AppImage tree / `.desktop` / icon / `~/.local/bin` names, setDesktopName, e2e userData dir, interstitial/welcome copy
- `run-kit/architecture/backend-packages`: (modify) `DefaultRepo`, `vapidSubscriber`, desktop package names
- `run-kit/architecture/cli`: (modify) `rk desktop` Linux artifact names
- `run-kit/architecture/testing`: (modify) desktop e2e userData dir name
- `run-kit/build-and-release`: (modify) desktop package / executable names
- `run-kit/code-bridge`: (modify) displayName / palette category / output channel `HexoKit Code Bridge`; publisher/name kept (extension ID rationale)
- `run-kit/toolkit-standards`: (modify) repo URL

## Impact

- **Frontend** (`app/frontend/src`, `public/`, `index.html`, `tests/e2e`): many string + test edits; e2e selectors keyed on `RunKit home` / version-row regexes are the main breakage risk. Gate: `just test-frontend` (full Vitest — see memory note: scoped Vitest missed cross-file `getByText`), `tsc`, and the touched e2e specs via `just test-e2e <name>.spec`, then a full e2e run once.
- **Backend** (`app/backend/api`, `internal/push`, `internal/desktop`): Go string constants + tests; gate `env -u TMUX -u TMUX_PANE go test ./...` (after `just _ensure-tmux-conf` in a fresh worktree).
- **Desktop** (`app/desktop`): package rename, setDesktopName, UI copy, e2e userData constant; gate `pnpm compile && pnpm test` and `just test-desktop-e2e`.
- **Code-bridge** (`app/code-bridge`): manifest strings + src strings + tests; extension ID unchanged.
- **Docs**: README, `docs/site/*`, `docs/specs/design.md`, constitution, memory.
- **Compatibility**: Linux desktop tree names change with no legacy fallback (user-accepted); VAPID `sub` change does not invalidate keys/subscriptions; help URLs move off the redirect host; the old `run-kit` bootstrap arg keeps working.
- CI lanes: Backend, Frontend, Code-bridge, E2E, Desktop.

## Open Questions

- None blocking. Windows NSIS artifact/install naming derived from the desktop package name is not verified (Windows is not an `rk desktop` install target) — record as unverified in the PR.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Brand strings change, substrate identifiers never (rk, RK_*, @rk_*, rk-*, rk.*, Go module, palette/command ids, memory domain folder) | Plan rules D2/D11 are Certain per the pickup protocol; user restated both guardrails | S:95 R:80 A:95 D:95 |
| 2 | Certain | Include lowercase UI `run-kit` strings and move help URLs off shll.ai to hexokit.com/docs/… and hexokit.com/fab-kit/… | Asked — user chose "Include both"; URL mapping verified from shll.ai meta-refresh/canonical | S:95 R:85 A:90 D:90 |
| 3 | Confident | Full desktop rename: package + Linux executable/.desktop/icon names, all Go/TS consumers, no legacy Linux fallback | Asked — user: "No one is using linux package right now — rename both the package and executable" | S:90 R:60 A:85 D:90 |
| 4 | Certain | Keep code-bridge `publisher: run-kit` + `name: rk-code-bridge` | Plan row states it explicitly (installed extension ID) | S:95 R:70 A:95 D:95 |
| 5 | Certain | Constitution amendment is PATCH 1.15.1 → 1.15.2, Last Amended 2026-09-29 | /fab-setup convention: wording clarification = PATCH; C4 precedent | S:85 R:90 A:90 D:85 |
| 6 | Certain | Docs bootstrap uses `sh -s -- hexokit`; record that `run-kit` still works and the stale-shll caveat until T2(a) | Plan row prescribes the new arg; behaviour verified against live install script and local shll | S:85 R:90 A:80 D:75 |
| 7 | Confident | Test fixture data and historical citations containing `sahil87/run-kit` or `run-kit` paths stay | D11 + fixtures are arbitrary data, not identity; changing them adds churn with no user-visible effect | S:70 R:90 A:80 D:70 |
| 8 | Certain | No control-gallery baseline regen needed | Gallery imports no wordmark component; apply re-verifies with the spec | S:75 R:90 A:85 D:85 |
| 9 | Certain | Constitution `run-kit serve --restart` examples become `rk serve …` | D2: docs/examples use `rk`; present-tense command text | S:70 R:90 A:85 D:75 |
| 10 | Confident | Keep legacy `legacyAssetPrefix = "run-kit-desktop-"` release-asset fallback while renaming the tree names | It serves pre-rename releases' asset names (history), independent of the tree rename; removal is separate cleanup | S:55 R:80 A:65 D:55 |

10 assumptions (7 certain, 3 confident, 0 tentative, 0 unresolved).
