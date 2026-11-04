# Plan: HexoKit brand surfaces (plan row C3)

**Change**: 260911-mvuv-hexokit-brand-surfaces
**Intake**: `intake.md`

> Read `intake.md` § What Changes first — it carries the per-file edit lists and the token
> classification rule (product noun in prose → HexoKit; command/formula/roster tokens, paths,
> URLs, payload values, mockups, historical text → keep). This plan does not restate those lists.

> **Split 2026-09-12 (plan row R0).** This change now carries only the app-identity half — cobra root name + completions, help-dump/upgrade strings, Electron productName/artifactName/userData carry-forward, `rk desktop` bundle + asset prefix, `fab/project/config.yaml`. The prose half (README, docs/site, skill H1s, specs, prose-scoped memory) moved to `260911-mljj-hexokit-brand-prose` (run-kit#952, row C3a). PR #950 stays the R0 PR and is deferred to Phase 3; sections and tasks below that describe the prose half are historical.

> **Rebuilt 2026-09-26 (Phase 3, R0).** The branch was 130 commits behind `main`, so it was rebuilt fresh from `main` (1a43927b) by 3-way patch-applying the old app-identity diff (`8a0f0d8c..6193071d`, change artifacts excluded). Two material additions ride the rebuild: **(a) `xk` alias (D16)** — shell completion now registers under all four names (`hexokit`, `rk`, `xk`, `run-kit`); **(b) Linux desktop merge** — `main` gained Linux AppImage install/update/uninstall (260917-ot32) since the old diff, so the rename now also covers the Linux arm: the desktop entry's `Name=`/`StartupWMClass=` → `HexoKit` (Electron's WM class follows `productName`), `rk desktop uninstall` strings, the AppImage asset-prefix legacy fallback, and the legacy-bundle helpers resolve the install root via `effectiveInstallDir` (an empty `InstallDir` now means the platform default). The inner AppImage names (`run-kit-desktop` ELF, `.desktop`, icon) stay — they derive from `package.json` `name`, which is unchanged.

## Requirements

### README: head and identity prose

#### R1: README head conforms to the revised readme-extraction standard
`README.md` MUST keep the order H1 → toolkit blockquote → contiguous badge lines → tagline. The H1 SHALL read `HexoKit` (logo `alt="HexoKit logo"`, logo `src` URL unchanged). The blockquote SHALL be exactly `> Part of [HexoKit](https://hexokit.com) — see all projects there.`. The three badge lines MUST be byte-identical to today (`sahil87/run-kit` URLs).

- **GIVEN** the rebranded README
- **WHEN** lines 1–5 are read
- **THEN** line 1 is the HexoKit H1 with the unchanged logo URL, line 3 is the mandated blockquote, and the badge line is unchanged

#### R2: README identity prose names HexoKit; tokens stay
Every prose occurrence of `run-kit` as the product noun in `README.md` (the intake's enumerated lines: tagline, "Why" heading and table header, hooks/HTTPS/desktop paragraphs, the command-table descriptions) SHALL read `HexoKit`. Command tokens, formula/alias facts (`rk` … alias of `run-kit`), completion names, and every `github.com/sahil87/run-kit` / `shll.ai/run-kit/commands/` URL MUST be unchanged.

- **GIVEN** the rebranded README
- **WHEN** `grep -nP '(?<![\`/\w.-])run-kit(?![\`/\w-])' README.md` runs
- **THEN** the only remaining prose hits are command/formula/completion tokens in code spans or the two intentional formula facts, and no heading or sentence names run-kit as the product

#### R3: README install section links the centralized location
Per the revised install-composition Policy B, the install one-liner SHALL be `curl -fsSL https://hexokit.com/install | sh` and the following sentence SHALL say "Installs the entire HexoKit toolkit …". The command-reference link `https://shll.ai/run-kit/commands/` MUST stay.

- **GIVEN** the Install section
- **WHEN** read
- **THEN** the curl host is `hexokit.com`, the toolkit noun is HexoKit, and the commands link is unchanged

### docs/site: identity lines and skill bundles

#### R4: docs/site pages flip identity prose and keep tokens, links, and paths
Every `docs/site/*.md` and `docs/site/skill/*.md` page SHALL apply the classification rule to the lines the intake enumerates: prose product mentions → HexoKit; `run-kit <verb>` command lines, `sh -s -- run-kit`, `~/.config/run-kit/…` paths, the line-56 formula-history note in install.md, and every GitHub/shll.ai URL unchanged. install.md line 10's curl host SHALL become `hexokit.com`; line 24's bundle name SHALL become **HexoKit.app**; cron-schedule-kinds.md's eyebrow SHALL read `HexoKit · rk cron`.

- **GIVEN** the rebranded docs/site tree
- **WHEN** the prose-only grep from R2 runs over `docs/site/`
- **THEN** no hit names run-kit as the product; every `run-kit` token that remains is a command, formula/roster argument, path, or URL
- **AND** readme-extraction conformance holds: no relative images, no reserved page names, README → docs/site links unchanged

#### R5: Skill bundle H1s flip and the embedded copies stay byte-identical
`docs/site/skill.md` H1 SHALL be `# HexoKit skill`; each `docs/site/skill/<topic>.md` H1 SHALL be `# HexoKit skill: <topic>`; their prose product mentions → HexoKit. After editing, `scripts/sync-skill.sh` MUST be run so `app/backend/cmd/rk/skill/*.md` match byte-for-byte, and every page MUST stay ≤150 lines.

- **GIVEN** the edited canonical pages and a run of `scripts/sync-skill.sh`
- **WHEN** `go test ./cmd/rk/ -run 'Skill'` runs in `app/backend`
- **THEN** every `TestSkill*EmbedMatchesCanonical` and line-budget test passes

### Electron desktop shell (D8)

#### R6: productName and artifactName flip; appId is kept
`app/desktop/electron-builder.yml` SHALL set `productName: HexoKit` and `artifactName: "hexokit-desktop-${version}-${arch}.${ext}"` and MUST keep `appId: ai.shll.run-kit`. `app/desktop/src/main.ts` `PRODUCT_NAME` SHALL be `"HexoKit"`. `package.json` `description` prose → HexoKit; its `name` and `homepage` MUST be unchanged. `window-registry.test.ts` fixtures follow.

- **GIVEN** the desktop package
- **WHEN** `pnpm run compile && pnpm test` runs in `app/desktop`
- **THEN** tests pass and the builder config carries the new productName/artifactName with the old appId

#### R7: userData carry-forward preserves hosts.json and windows.json across the rename
On startup, before the first `loadHosts`/`loadWindows`, the shell SHALL compute the legacy userData dir as the sibling of `app.getPath("userData")` named `Run Kit`. If the new dir has no `hosts.json` and the legacy dir has one, it SHALL copy `hosts.json` and, if present, `windows.json` into the new dir (copy, never move; never overwrite an existing new-dir file; log-and-ignore failures). The logic SHALL live in a small pure function taking `(newDir, legacyDir)` so it is unit-testable with temp dirs under `node --test`.

- **GIVEN** a legacy `…/Run Kit/hosts.json` and an empty `…/HexoKit/`
- **WHEN** the shell starts
- **THEN** `…/HexoKit/hosts.json` (and `windows.json` when present) exist with identical content and the legacy files remain
- **GIVEN** `…/HexoKit/hosts.json` already exists
- **WHEN** the shell starts
- **THEN** nothing is copied or overwritten

### `rk desktop` (Go) follows D8

#### R8: Bundle name and asset prefix flip with legacy detection
`internal/desktop/desktop.go` SHALL define `AppBundleName = "HexoKit.app"`, `legacyAppBundleName = "Run Kit.app"`, `assetPrefix = "hexokit-desktop-"`, `legacyAssetPrefix = "run-kit-desktop-"`. `release.go` SHALL match `assetPrefix` first, then `legacyAssetPrefix` (error message names both). `InstalledVersion`/`AppRunning`/`AppPath`-based status SHALL read `HexoKit.app` first and fall back to `Run Kit.app`, reporting the legacy bundle as the installed (older) version. `Install` SHALL validate the mounted bundle as `HexoKit.app`, install to `<InstallDir>/HexoKit.app`, and after a successful swap remove `<InstallDir>/Run Kit.app` when present. `restart.go` SHALL quit whichever of `HexoKit`/`Run Kit` is running before the swap.

- **GIVEN** a release whose only DMG assets are `hexokit-desktop-3.20.0-arm64.dmg` / `-x64.dmg`
- **WHEN** the release is resolved for either arch
- **THEN** the matching asset is selected
- **GIVEN** a release carrying only `run-kit-desktop-*` assets
- **WHEN** resolved
- **THEN** the legacy asset is selected
- **GIVEN** `/Applications/Run Kit.app` installed at v3.12.2 and a newer release
- **WHEN** `rk desktop update` runs
- **THEN** it reports the legacy install as v3.12.2, installs `HexoKit.app`, and `Run Kit.app` is gone afterwards

#### R9: `rk desktop` user-facing strings name HexoKit
`cmd/rk/desktop.go` `Short`/`Long` text and output strings ("Installed Run Kit v…", "Run Kit was running — restarted…", "Run Kit is not installed at …", "Run Kit v%s is already installed") SHALL say `HexoKit`. `desktop_test.go` assertions follow.

- **GIVEN** `rk desktop install` succeeds
- **WHEN** stdout is read
- **THEN** it contains `Installed HexoKit v<version>`

### Cobra root: the `hexokit` command name

#### R10: Root command name is `hexokit`; derived surfaces follow
`cmd/rk/root.go` SHALL set `Use: "hexokit"` and `Short: "hexokit — tmux session manager with web UI"`. Consequently `rk --version` prints `hexokit version v<semver>` (or `hexokit version dev`), `rk --help` shows `Usage: hexokit …`, and `rk help-dump` emits `tool: hexokit`, `root.name: hexokit`, `root.path: hexokit`. `exit_code.go`'s `unknownCommandPrefix` match MUST remain name-independent (verify; no change expected). Tests in `root_test.go` and `help_dump_test.go` follow.

- **GIVEN** the rebuilt binary
- **WHEN** `rk --version` runs
- **THEN** the first line is `hexokit version v<semver>` — parseable by the shll version standard's `<word> version <rest>` rule, by `internal/remote/ssh.go` `versionPattern`, and by `app/desktop/src/local-daemon.ts` `parseRkVersion`
- **GIVEN** `rk bogus`
- **WHEN** it runs
- **THEN** stderr says `unknown command "bogus" for "hexokit"` and the exit code is 2 (usage class)

#### R11: Shell completion works for `hexokit`, `rk`, `xk`, and `run-kit`
`cmd/rk/shell_init.go` SHALL emit cobra's generated registration for the root name `hexokit` and append registrations of the same function for **each of** `rk`, `xk` (D16 alias), and the legacy `run-kit`: zsh `compdef _hexokit rk` / `xk` / `run-kit`; bash `complete -o default -F __start_hexokit rk` / `… xk` / `… run-kit` (mirroring the existing compopt-conditional block for all three names). The banner comment SHALL read `# hexokit(1) <shell> completion`; the rc hint inside the output SHALL use `rk shell-init <shell>`. The no-shell-function-wrapper rule (no `run-kit()` / `rk()` / `hexokit()` function) holds. `shell_init_test.go` follows.

- **GIVEN** `rk shell-init zsh`
- **WHEN** the output is read
- **THEN** it contains `compdef _hexokit hexokit`, `compdef _hexokit rk`, `compdef _hexokit xk`, and `compdef _hexokit run-kit`, and defines no shell function wrapper for any of the four names
- **GIVEN** `rk shell-init bash`
- **WHEN** read
- **THEN** it registers `__start_hexokit` for `rk`, `xk`, and `run-kit` in both compopt branches

#### R15: The Linux desktop arm follows the rename
The Linux AppImage flow (added on `main` after the original diff) SHALL follow D8 the same way the darwin flow does: the user-scope desktop entry (`integrate.go`) writes `Name=HexoKit` and `StartupWMClass=HexoKit` (Electron derives the X11/Wayland WM class from `productName`); `rk desktop uninstall` refusals and its outcome line name HexoKit (the macOS refusal points at `HexoKit.app`); release resolution for `.AppImage` assets prefers `hexokit-desktop-` and falls back to `run-kit-desktop-`. The AppImage-internal names (`run-kit-desktop` ELF, `run-kit-desktop.desktop`, `run-kit-desktop.png`, `~/.local/bin/run-kit-desktop`) stay — they derive from `package.json` `name`, which is unchanged. The darwin legacy-bundle helpers resolve the root through `effectiveInstallDir`, never the raw `InstallDir` field.

- **GIVEN** a Linux install via `rk desktop install`
- **WHEN** the launcher entry is written
- **THEN** it carries `Name=HexoKit` and `StartupWMClass=HexoKit`
- **GIVEN** a release that carries only `run-kit-desktop-*-x86_64.AppImage`
- **WHEN** `ResolveRelease` runs on linux/amd64
- **THEN** it resolves the legacy asset; with neither prefix present the error names both

#### R12: Roster- and substrate-coupled names are unchanged
`internal/updatecheck` `runKitTool = "run-kit"`, the frontend `RUN_KIT_TOOL`, `resolveRkPath()`'s LookPath order (`run-kit`, `rk`), `guiPointerPath`, every `$XDG_STATE_HOME/run-kit/` and `~/.config/run-kit/` path, `internal/mcp` `Implementation.Name`, the `"run-kit riff: …"` error prefixes, and the non-desktop subcommands' `Short`/`Long` prose MUST NOT change in this change.

- **GIVEN** the final diff
- **WHEN** `git diff --stat` is inspected
- **THEN** no file under `internal/updatecheck`, `internal/mcp`, `internal/riff`, `internal/settings`, `internal/cron`, `internal/gui`, `internal/codeworkspace`, `internal/prstatus`, or `app/frontend/` is touched, and `agent_setup.go` is untouched

### Specs and project config

#### R13: Spec identity lines flip; paths, payloads, tables, and mockups stay
`docs/specs/*.md` and `docs/specs/index.md` SHALL apply the classification rule to the ~77 prose candidates the intake enumerates: H1s (`api`, `design`, `architecture`, `project-plan`), intro blockquotes, and "run-kit is/renders/owns…" sentences → HexoKit. `cmd/run-kit`/`bin/run-kit` build paths, JSON payload values, the `[run-kit request]` envelope tag, repo-column table cells (cli-layering, agent-messaging execution tables), ASCII mockups, and every `docs/memory/run-kit/…` link MUST be unchanged.

- **GIVEN** the rebranded specs
- **WHEN** the prose-only grep from R2 runs over `docs/specs/`
- **THEN** every remaining hit is a path, payload value, wire token, repo-column cell, or mockup frame, and every spec H1 names HexoKit where it named run-kit

#### R14: fab project name
`fab/project/config.yaml` `project.name` SHALL be `hexokit`; `description`, the constitution H1, and `context.md` MUST be unchanged.

- **GIVEN** the edited config
- **WHEN** `fab preflight mvuv` runs
- **THEN** it succeeds (config still parses) and `project.name` reads `hexokit`

### Non-Goals

- GitHub repo rename, tap formula, `release.yml` / `formula-template.rb` edits — R1/R2 rows of the plan doc.
- On-disk home moves (`~/.config/run-kit`, `$XDG_STATE_HOME/run-kit`, `runkit-*` localStorage) — C4. The Electron userData carry-forward (R7) is the one exception because this change causes that move.
- Frontend `RunKit` strings, MCP server name, private npm names, non-desktop subcommand help prose — unassigned brand-tier cluster, surfaced in the intake's Open Questions for a new plan row.
- Rewriting `run-kit <verb>` command examples to `rk <verb>` — tokens stay valid until R1.
- Memory/plan/archive rewrites (D11).

### Design Decisions

#### Root name flip instead of a cobra alias
**Decision**: Set `rootCmd.Use = "hexokit"`; keep `run-kit` working through the formula symlink plus explicit completion registration for `run-kit` and `rk`.
**Why**: Cobra has no alias mechanism for a root command — the binary answers to whatever argv[0] invokes it. The only name-derived surfaces are the version line, help usage, help-dump envelope, and the generated completion function name, and the last is the only one that needs an explicit legacy registration.
**Rejected**: Keeping `Use: "run-kit"` and adding a hidden `hexokit` subcommand — a subcommand is not an invocation name and would put `hexokit` in the command tree where it means nothing.
*Introduced by*: 260911-mvuv-hexokit-brand-surfaces

#### Electron userData carry-forward
**Decision**: Copy `hosts.json`/`windows.json` from the legacy `Run Kit` userData dir on first start when the new dir has none; leave the legacy dir in place for one release.
**Why**: Electron keys `userData` on the app name, so the productName flip silently moves the stores — the one user-visible regression D9 exists to prevent. Copy-not-move keeps a downgrade safe.
**Rejected**: `app.setPath("userData", <legacy>)` pins the old directory forever and contradicts D9's direction; doing nothing loses every desktop user's host list.
*Introduced by*: 260911-mvuv-hexokit-brand-surfaces

#### `rk desktop` dual-name detection
**Decision**: Prefer `HexoKit.app` / `hexokit-desktop-`, fall back to `Run Kit.app` / `run-kit-desktop-`, and remove the legacy bundle after a successful install.
**Why**: The same rk-installed app under a new name; leaving both yields two Dock entries, and an old-prefix fallback costs two lines while covering any release carrying either naming.
**Rejected**: Hard flip with no fallback — `rk desktop status` would report a healthy legacy install as "not installed".
*Introduced by*: 260911-mvuv-hexokit-brand-surfaces

## Tasks

### Phase 1: Setup

- [x] T001 Edit `fab/project/config.yaml`: `project.name: run-kit` → `hexokit` (nothing else in the file). Run `fab preflight mvuv` to confirm it still parses. <!-- R14 -->

### Phase 2: Core Implementation

- [x] T002 [P] Cobra root name: in `app/backend/cmd/rk/root.go` set `Use: "hexokit"` and `Short: "hexokit — tmux session manager with web UI"`; refresh the `displayVersion` doc comment example. Verify `app/backend/cmd/rk/exit_code.go` `unknownCommandPrefix` is name-independent (no change expected). Update `app/backend/cmd/rk/root_test.go` (`want := "hexokit version dev"` ×2, the `unknown command "bogus" for "hexokit"` fixture, comments) and `app/backend/cmd/rk/help_dump_test.go` (`tool`, `root.name`, `root.path` → `hexokit`). <!-- R10 -->
- [x] T003 [P] Shell completion: in `app/backend/cmd/rk/shell_init.go` rename the generated-function references to `_hexokit` / `__start_hexokit`, change `zshAliasCompdef` to append `compdef _hexokit run-kit` and `compdef _hexokit rk`, change `bashAliasComplete` to register `__start_hexokit` for both `run-kit` and `rk` in both compopt branches, set the banner to `# hexokit(1) %s completion`, and make the rc hint use `rk shell-init %s`. Update `app/backend/cmd/rk/shell_init_test.go` accordingly (banner, three compdef lines, bash registrations, the no-wrapper check extended to `hexokit()`). <!-- R11 -->
- [x] T004 [P] Go desktop constants + release matching: in `app/backend/internal/desktop/desktop.go` set `AppBundleName = "HexoKit.app"`, add `legacyAppBundleName = "Run Kit.app"`, set `assetPrefix = "hexokit-desktop-"`, add `legacyAssetPrefix = "run-kit-desktop-"`, update the package doc comment. In `release.go` match `assetPrefix` then `legacyAssetPrefix`; error names both. Update `release_test.go` fixtures: add a `hexokit-desktop-3.13.0-*` release case and keep one legacy-only case. <!-- R8 -->
- [x] T005 Go desktop legacy handling (after T004): in `app/backend/internal/desktop/installed.go` make `InstalledVersion` and `AppRunning` read `HexoKit.app` first and fall back to `legacyAppBundleName` (expose a helper such as `installedBundlePath()` returning the path that exists, preferring the new name); in `install.go` after the successful `os.Rename(staged, dest)` remove `filepath.Join(ins.InstallDir, legacyAppBundleName)` if present (log a progress line); in `restart.go` quit/wait on whichever app name is running (`HexoKit`, then `Run Kit`). Update `installed_test.go` (fixture helper for both bundle names; a legacy-only fixture reports its version) and add an install test asserting the legacy bundle is removed. <!-- R8 -->
- [x] T006 `rk desktop` strings: in `app/backend/cmd/rk/desktop.go` flip every `Run Kit` in `Short`/`Long`/output strings (`desktopRestartAnnouncement`, "Installed … v", "Updated …", "… is already installed", "… is not installed at") to `HexoKit`; update `app/backend/cmd/rk/desktop_test.go` assertions and its `run-kit-desktop-%s-*.dmg` release fixtures to `hexokit-desktop-%s-*.dmg`, and its bundle fixture helper to `HexoKit.app`. <!-- R9 -->
- [x] T007 [P] Electron builder + product name: in `app/desktop/electron-builder.yml` set `productName: HexoKit` and `artifactName: "hexokit-desktop-${version}-${arch}.${ext}"`, keep `appId: ai.shll.run-kit` (add a comment: kept per D8 so installed apps keep their OS identity). In `app/desktop/src/main.ts` set `PRODUCT_NAME = "HexoKit"`. In `app/desktop/package.json` change only the `description` prose to "HexoKit desktop viewer shell — …". Update `app/desktop/src/window-registry.test.ts` (`PRODUCT`, the two `"Run Kit"` title/label fixtures). <!-- R6 -->
- [x] T008 Electron userData carry-forward (after T007): add `app/desktop/src/user-data-migration.ts` exporting `carryForwardLegacyUserData(newDir: string, legacyDir: string): { copied: string[] }` — if `join(newDir,"hosts.json")` is absent and `join(legacyDir,"hosts.json")` exists, `mkdirSync(newDir,{recursive:true})` and `copyFileSync` `hosts.json` and (if present) `windows.json` with `COPYFILE_EXCL`; never overwrite; swallow and return on errors. In `main.ts`, call it once before the first `loadHosts(userDataDir())` with `legacyDir = join(dirname(userDataDir()), "Run Kit")`, logging the copied files. Add `app/desktop/src/user-data-migration.test.ts` (node --test, temp dirs): copies when new is empty; copies windows.json only when present; no-op when new has hosts.json; no-op when legacy absent. <!-- R7 -->

### Phase 3: Content surfaces

- [x] T009 [P] README: apply intake § What Changes 1 to `README.md` — H1 (`alt="HexoKit logo"`, `HexoKit`), blockquote, tagline and every enumerated prose line, `## Why HexoKit?` + table header, install one-liner host → `hexokit.com` and "HexoKit toolkit". Leave badges, all GitHub/shll.ai URLs, the `rk` alias-of-`run-kit` formula fact, the completion-names sentence, and the commands link untouched. Verify with `grep -nP '(?<![\`/\w.-])run-kit(?![\`/\w-])' README.md`. <!-- R1, R2, R3 -->
- [x] T010 [P] docs/site pages: apply intake § What Changes 2 to `docs/site/install.md`, `agent-hooks.md`, `customizing-tmux.md`, `workflows.md`, `cron-schedule-kinds.md` (eyebrow only). Keep every `run-kit <verb>` command line, `sh -s -- run-kit`, paths, URLs, and the install.md line-56 formula note. install.md line 10 host → `hexokit.com`; line 24 → **HexoKit.app**. Verify with the prose-only grep over `docs/site/*.md`. <!-- R4 -->
- [x] T011 [P] Skill bundles: flip the H1 and prose product mentions in `docs/site/skill.md` and `docs/site/skill/{code,cron,display,gui,messaging,mux,tutorial}.md` (keep `rk skill <topic>` tokens, `../skill.md` links, gate commands in code spans). Run `scripts/sync-skill.sh`, then in `app/backend` run `go test ./cmd/rk/ -run 'Skill'` and confirm every page is still ≤150 lines. <!-- R5 -->
- [x] T012 [P] Specs: apply intake § What Changes 6 to `docs/specs/*.md` and `docs/specs/index.md` — the four H1s, intro blockquotes, and identity sentences; keep build paths, payload values, the `[run-kit request]` tag, repo-column cells, mockups, and `docs/memory/run-kit/` links. Verify with the prose-only grep over `docs/specs/` and review each remaining hit against the classification rule. <!-- R13 -->

### Phase 3b: Rebuild additions (2026-09-26)

- [x] T014 `xk` alias (D16): extend `zshAliasCompdef` / `bashAliasComplete` in `app/backend/cmd/rk/shell_init.go` to `rk`, `xk`, `run-kit`; refresh the banner/help/comment name lists; `shell_init_test.go` loops a shared `shellInitAliasNames` over both shells (line-exact matches) and the no-wrapper check. Memory: cli.md root paragraph + shell-init row + decision, build-and-release.md completion bullet. <!-- R11 -->
- [x] T015 Linux desktop merge: `integrate.go` `Name=`/`StartupWMClass=` + uninstall errors → HexoKit; `cmd/rk/desktop.go` uninstall `Short`/`Long`/refusal/outcome; `release.go` legacy-prefix loop over the platform `assetSuffix`; `installed.go` legacy helpers via `legacyAppPath()` (effective root) with `installedAppName()` returning the product name on linux; `install.go` legacy removal under `root`; `restart.go` keeps a package `appName` for the Linux messages. Tests: darwin-pinned `GOOS` on the carried-over legacy tests; Linux fixtures (`linux_test.go`, `release_test.go`, `cmd/rk/desktop_test.go`) on `hexokit-desktop-`; expectation strings. Memory: desktop-shell.md, backend-packages.md, cli.md; `docs/site/install.md` manual AppImage filename. <!-- R15 -->

### Phase 4: Verification

- [x] T013 Run the gates: `just test-backend` (or `cd app/backend && go test ./...`); `cd app/desktop && pnpm run compile && pnpm test`; `cd app/frontend && npx tsc --noEmit` (no frontend edits expected — confirm `git diff --stat` touches nothing under `app/frontend/`); `just build`. Then run `bin/rk --version`, `bin/rk --help | head -3`, `bin/rk help-dump | head -c 200`, `bin/rk shell-init zsh | grep compdef`, and `bin/rk bogus; echo $?` and confirm R10/R11 outputs. Confirm R12 by inspecting `git diff --stat`. <!-- R10, R11, R12 -->

## Execution Order

- T004 blocks T005 and T006 (constants first).
- T007 blocks T008 (PRODUCT_NAME and builder config before the migration wiring).
- T013 runs last, after every other task.

## Acceptance

### Functional Completeness

- [x] A-001 R1: README lines 1–5 are H1 (`HexoKit`, `alt="HexoKit logo"`, unchanged logo URL) → mandated HexoKit blockquote → unchanged badge line
- [x] A-002 R2: Every enumerated README prose mention reads HexoKit; the remaining `run-kit` tokens are commands, formula/completion facts, or URLs
- [x] A-003 R3: README install one-liner uses `https://hexokit.com/install`, the noun is "HexoKit toolkit", and the `shll.ai/run-kit/commands/` link is unchanged
- [x] A-004 R4: docs/site pages carry no prose product mention of run-kit; command lines, paths, URLs, and the formula-history note are unchanged; install.md has the hexokit.com host and **HexoKit.app**
- [x] A-005 R5: skill.md H1 is `# HexoKit skill`, each topic H1 is `# HexoKit skill: <topic>`, embedded copies match byte-for-byte, all pages ≤150 lines
- [x] A-006 R6: electron-builder.yml has `productName: HexoKit`, `artifactName: "hexokit-desktop-…"`, and `appId: ai.shll.run-kit`; main.ts `PRODUCT_NAME` is `HexoKit`; package.json `name`/`homepage` unchanged
- [x] A-007 R7: `carryForwardLegacyUserData` copies hosts.json (and windows.json when present) only when the new dir has no hosts.json; legacy files remain; existing new-dir files are never overwritten
- [x] A-008 R8: Go desktop constants define both bundle names and both asset prefixes; release matching prefers the new prefix and falls back to legacy
- [x] A-009 R8: status/installed-version reads prefer HexoKit.app and fall back to Run Kit.app; install removes the legacy bundle after a successful swap; restart quits either running name
- [x] A-010 R9: `rk desktop` help and output strings say HexoKit
- [x] A-011 R10: `rootCmd.Use` is `hexokit`; `--version`, `--help`, and `help-dump` reflect it
- [x] A-012 R11: shell-init registers completion for `hexokit`, `rk`, `xk`, and `run-kit` in zsh and bash with no shell function wrapper
- [x] A-013 R12: No changes under `internal/updatecheck`, `internal/mcp`, `internal/riff`, settings/cron/gui/codeworkspace/prstatus path packages, `agent_setup.go`, or `app/frontend/`
- [x] A-014 R13: Spec H1s and identity lines read HexoKit; build paths, payload values, wire tokens, repo-column cells, mockups, and memory links are unchanged
- [x] A-015 R14: `fab/project/config.yaml` `project.name` is `hexokit`; description, constitution, context.md unchanged

### Behavioral Correctness

- [x] A-016 R10: `rk --version` first line is `hexokit version v<semver>`/`hexokit version dev` and still parses under `internal/remote/ssh.go` `versionPattern` and `local-daemon.ts` `parseRkVersion` (existing token tests pass)
- [x] A-017 R10: `rk bogus` still exits 2 with the cobra unknown-command message
- [x] A-018 R8: A release with only `run-kit-desktop-*` assets still resolves (legacy fallback)

### Scenario Coverage

- [x] A-019 R7: Unit tests cover copy-when-empty, windows.json-only-when-present, no-op-when-new-has-hosts, no-op-when-legacy-absent
- [x] A-020 R8: Tests cover new-prefix selection, legacy-prefix fallback, legacy-bundle version read, and legacy-bundle removal on install
- [x] A-021 R11: shell_init tests assert all four zsh compdef lines and the three appended bash registrations in both compopt branches

### Edge Cases & Error Handling

- [x] A-022 R7: Carry-forward failures (unreadable legacy dir, permission error) are swallowed and the app proceeds as a fresh install
- [x] A-023 R8: A release carrying neither prefix errors with a message naming both prefixes

### Code Quality

- [x] A-024 Pattern consistency: New Go and TS code follows surrounding naming and structure (constants block in desktop.go, injected-dir seam in the desktop stores)
- [x] A-025 No unnecessary duplication: legacy-name handling reuses the existing `AppPath`/`InstalledVersion` seams rather than duplicating plist parsing
- [x] A-026 Tests alongside: every behavior change (root name, completion, desktop constants, carry-forward) has a co-located test update or addition
- [x] A-027 No comment narration: new comments state constraints (why appId is kept, why copy-not-move, why the legacy prefix stays one release), never change IDs or "renamed X→Y" history
- [x] A-029 R15: Linux desktop entry writes `Name=HexoKit` / `StartupWMClass=HexoKit`; uninstall strings name HexoKit; AppImage resolution prefers `hexokit-desktop-` with legacy fallback; AppImage-internal names unchanged
- [x] A-030 R15: legacy-bundle helpers (`legacyAppPath`, install's legacy removal) resolve the root via `effectiveInstallDir` — an empty `InstallDir` never resolves against the CWD
- [x] A-028 Go subprocess safety: any new `exec` in restart/install uses `exec.CommandContext` with a timeout via the existing `ins.Run` seam

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before hydrate
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Legacy `Run Kit.app` is removed after a successful `HexoKit.app` install (not left beside it) | Same rk-installed app; two Dock entries is the worse outcome; removal happens only after the new bundle is in place | S:60 R:75 A:80 D:70 |
| 2 | Confident | The userData carry-forward lives in a new `user-data-migration.ts` module with a pure `(newDir, legacyDir)` signature | Matches the injected-directory seam hosts.ts/windows.ts already use for testability | S:65 R:90 A:85 D:80 |
| 3 | Confident | Root `Short` keeps the lowercase binary form `hexokit — …` | Mirrors the existing `run-kit — …` pattern; the site's commands page shows the short verbatim | S:55 R:95 A:80 D:70 |
| 4 | Certain | `release.yml` is not edited | Uploads by extension glob; verified at intake | S:90 R:95 A:95 D:95 |

4 assumptions (1 certain, 3 confident, 0 tentative).
