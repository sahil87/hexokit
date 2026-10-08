# Plan: Linux Desktop App — `rk desktop` Installs, Updates, and Integrates the AppImage

**Change**: 260917-ot32-linux-desktop-appimage-install
**Intake**: `intake.md`

## Requirements

### CLI: `rk desktop` platform gate and Linux asset selection

#### R1: The `rk desktop` family runs on Linux
`desktopCmd`'s `PersistentPreRunE` MUST accept `desktopGOOS` ∈ {`darwin`, `linux`} and MUST refuse every other value with the operational (exit 1) error `rk desktop supports macOS and Linux (the shell is packaged as a macOS .app and a Linux AppImage)`. All subcommands MUST stay registered on every platform (help-dump platform stability). Release resolution on Linux MUST select the asset `run-kit-desktop-<v>-<label>.AppImage` where GOARCH `amd64 → x86_64` and `arm64 → arm64`; darwin MUST keep `amd64 → x64` / `arm64 → arm64` with the `.dmg` suffix. An unsupported GOARCH MUST fail before any HTTP request.

- **GIVEN** `desktopGOOS = "linux"` and GOARCH `amd64`
- **WHEN** `rk desktop install` resolves the latest release
- **THEN** it selects the asset whose name matches `run-kit-desktop-*-x86_64.AppImage`
- **AND** on `desktopGOOS = "windows"` any `rk desktop` subcommand exits 1 with the new error text while `rk help-dump` still lists `desktop` with its children

### Installer: Linux layout and version derivation

#### R2: The Linux install root is `~/.rk/desktop` with a `current` symlink
`Installer` MUST carry a `GOOS` field (default `runtime.GOOS`) that selects the platform strategy. On linux `DefaultInstallDir` MUST resolve to `<home>/.rk/desktop` through an `os.UserHomeDir` seam; on darwin it stays `/Applications`. The layout MUST be `<root>/<version>/` (one extracted AppImage per version), `<root>/current` (symlink → `<version>`, flipped via a temp symlink + `os.Rename`), and `<root>/.staging-*` for `MkdirTemp` staging. `InstalledVersion` on linux MUST return the `current` symlink's target basename, `("", nil)` when the symlink is absent, and MUST never consult a state file. `AppPath()` on linux MUST be `<root>/current`.

- **GIVEN** `<root>/current → 3.20.8`
- **WHEN** `InstalledVersion` runs on linux
- **THEN** it returns `"3.20.8"`
- **AND** with no `current` symlink it returns `""` and a nil error

### Installer: Linux install flow

#### R3: Download, digest gate, extract once, validate the tree
On linux `Install` MUST download the AppImage into a staging dir under the root while hashing, MUST refuse when the release supplies no sha256 digest (`release vX supplied no sha256 digest for <asset> — refusing to install an unverified binary`) and on a mismatch (discarding the download), and only after the digest passes MUST `chmod 0700` the file and run it with `--appimage-extract` via `exec.CommandContext` (argv slice, 5-minute bound) with the working directory set to the staging dir. It MUST validate the extracted `squashfs-root`: `AppRun`, an executable regular `run-kit-desktop`, `resources/app.asar`, `run-kit-desktop.desktop` whose `X-AppImage-Version=` equals the release version, and an icon at `usr/share/icons/hicolor/<size>/apps/run-kit-desktop.png`; it MUST refuse any symlink in the tree resolving outside the tree. Any refusal MUST leave the install target untouched and remove the staging dir. The mac DMG flow MUST remain byte-identical in behavior.

- **GIVEN** a release whose AppImage asset carries no digest
- **WHEN** `rk desktop install` runs on linux
- **THEN** it exits non-zero with the refusal message, nothing is executed, and `<root>` holds no new version dir
- **AND** given a digest-verified AppImage whose extracted `.desktop` says `X-AppImage-Version=3.20.7` for release `3.20.8`, the install is refused and the staging dir is removed

#### R4: Swap boundary, running-app handling, relaunch
Steps up to validation MUST run while the app may be live. At the swap boundary the installer MUST probe `AppRunning` = `pgrep -f <root>/<installed-version>/run-kit-desktop` (resolving `current` before the flip; any error reads as not running). When running it MUST send SIGTERM to the oldest matching PID (`pgrep -o -f …`) through a signal seam, wait via the existing `QuitWait`/`QuitPoll` loop, and abort without swapping when the bound expires. It MUST then `os.RemoveAll` a leftover `<root>/<version>`, rename `squashfs-root → <root>/<version>`, flip `current` atomically, remove every other version dir under the root, and, when the app was running, relaunch `<root>/current/AppRun` detached (Setsid, stdio discarded, no `--no-sandbox` flag) as a non-fatal step. `InstallResult.Restarted` MUST be true only when the relaunch succeeded.

- **GIVEN** `current → 3.20.7` and the app running from that dir
- **WHEN** installing `3.20.8`
- **THEN** pgrep sees the 3.20.7 path, SIGTERM goes to the oldest PID, the flip happens after the probe reports gone, `3.20.7/` is removed, `current → 3.20.8`, and `AppRun` is started detached
- **AND** when the app never exits within `QuitWait`, the error names the bound, `current` still points at `3.20.7`, and the staged tree is gone

### Installer: desktop integration and uninstall

#### R5: The installer writes user-scope desktop integration
After a successful flip on linux the installer MUST write `~/.local/share/applications/run-kit-desktop.desktop` (`Name=Run Kit`, `Exec="<root>/current/AppRun" %U`, `Terminal=false`, `Type=Application`, `Icon=run-kit-desktop`, `StartupWMClass=Run Kit`, `Categories=Development;`, the shipped `Comment`), copy the icon to `~/.local/share/icons/hicolor/<size>/apps/run-kit-desktop.png` mirroring the size dir found in the tree, run `update-desktop-database ~/.local/share/applications` only when `exec.LookPath` finds it (30 s bound, failure = chatter note), and replace the symlink `~/.local/bin/run-kit-desktop → <root>/current/AppRun` atomically (creating `~/.local/bin`). Integration failures after the flip MUST be `Progress` warnings, not install errors.

- **GIVEN** a successful flip
- **WHEN** integration runs
- **THEN** the desktop entry, icon, and `~/.local/bin` symlink exist with the contents above
- **AND** a missing `update-desktop-database` produces a chatter note and a zero exit

#### R6: `rk desktop uninstall` exists and is Linux-only
A new `uninstall` subcommand MUST be registered everywhere, accept `--path`, refuse on darwin with `rk desktop uninstall is Linux-only — on macOS drag "Run Kit.app" to the Trash` (exit 1), refuse when nothing is installed (`Run Kit is not installed at <root>/current`), refuse while the app is running (`Run Kit is running — quit it, then re-run this command`), and otherwise remove every version dir and `current` (then the root when empty), the `~/.local/bin/run-kit-desktop` symlink only when it points into the root, the desktop entry, and the icon(s). Electron user data MUST be untouched. The outcome line `Uninstalled Run Kit from <root>` is data (stdout).

- **GIVEN** an installed app that is not running
- **WHEN** `rk desktop uninstall` runs on linux
- **THEN** the root, symlink, desktop entry, and icon are gone and the data line prints
- **AND** with the app running the command exits 1 and removes nothing

### CLI: flag defaults, update, status, umbrella leg

#### R7: `--path` resolves its default per platform without platform-dependent help text
The `--path` flag on `install`/`update`/`status`/`uninstall` MUST have the cobra default `""` and the usage string `install directory (default: /Applications on macOS, ~/.rk/desktop on Linux)`; when `Flags().Changed("path")` is false the command MUST use the platform default; an explicit `--path ""` MUST remain a usage error (exit 2). `desktopCmd.Short` MUST read `Install and update the Run Kit desktop app (macOS, Linux)` and every `Long:` block MUST describe both platforms without any platform-conditional text.

- **GIVEN** linux and no `--path`
- **WHEN** `rk desktop status` runs
- **THEN** it reads `<home>/.rk/desktop/current`
- **AND** `rk desktop install --path ""` exits 2

#### R8: `update`, `status`, and the umbrella `rk update` desktop leg work on Linux
`runDesktopUpdate`, `runDesktopStatus`, and `desktopUpdateToLatest` MUST work unchanged through the platform-seamed installer. `runUpdateDesktopLeg` MUST gate on `desktopGOOS` ∈ {darwin, linux}, look only at the platform default root, skip silently (exit 0) when nothing is installed, and its `Long:` text MUST say "the platform's default install root" instead of `/Applications` only.

- **GIVEN** linux with `current → 3.20.7` and latest `3.20.8`
- **WHEN** `rk update` runs
- **THEN** the desktop leg installs 3.20.8 and prints the shared `Updated Run Kit v3.20.7 -> v3.20.8 (<root>/3.20.8)` data line
- **AND** with no `current` symlink the leg prints nothing and the command's exit is governed by the other legs

### Shell: Linux badge identity and Restart-to-Update

#### R9: The shell names its desktop entry and shows Restart-to-Update on Linux
On `process.platform === "linux"` `main.ts` MUST call `app.setDesktopName("run-kit-desktop.desktop")` before `app.whenReady()` resolves. `refreshUpdateMenu()` MUST return early only when the platform is neither darwin nor linux. The update item group (label `Restart to Update (v<latest> available)…` or the disabled `Updating…`, followed by a separator) MUST be produced by one electron-free pure function in `update-check.ts` consumed by both `macAppMenu` and `fileMenu`; `fileMenu` MUST render the group directly above `Quit`/`Exit`, and `buildMenu` MUST pass `update` to it. The item MUST carry no accelerator. `update === null` MUST render no item on any platform.

- **GIVEN** `process.platform = "linux"` and `update = { latestVersion: "3.21.0", updating: false }`
- **WHEN** the File menu is built
- **THEN** it contains `New Window`, separator, `Restart to Update (v3.21.0 available)…`, separator, `Quit`, with no accelerator on the update item
- **AND** with `update = null` the File menu is `New Window`, separator, `Quit`

### Packaging and docs

#### R10: AppImage is the only Linux package
`electron-builder.yml` MUST list only the `AppImage` target (x64 + arm64) under `linux`, with no `deb` target and no `maintainer` line; the `release.yml` `desktop-linux` job MUST build and upload `*.AppImage` only, with its step name saying `AppImage, x64 + arm64`. `scripts/build-desktop.sh` MUST be unchanged.

- **GIVEN** the release workflow runs
- **WHEN** the `desktop-linux` job uploads
- **THEN** the glob is `app/desktop/release/*.AppImage` and no deb is produced

#### R11: README and install guide describe the Linux path
`README.md` and `docs/site/install.md` MUST rename `Desktop app (macOS)` to `Desktop app`, update the in-repo anchors (`#desktop-app-macos` → `#desktop-app`), describe `rk desktop install`/`update`/`status` for both platforms, add a Linux paragraph (curl script installs the CLI, `rk desktop install` extracts the AppImage into `~/.rk/desktop` and writes a launcher entry plus `~/.local/bin/run-kit-desktop`, `rk desktop uninstall` removes it) and the manual fallback (download the AppImage, `chmod +x`, `--appimage-extract-and-run` when libfuse2 is missing). The README CLI table row for `rk desktop` MUST drop "macOS".

- **GIVEN** a Linux reader of the install guide
- **WHEN** they follow the Desktop app section
- **THEN** the recommended path is the curl script then `run-kit desktop install`, and no dangling `#desktop-app-macos` anchor remains in either file

### Non-Goals

- snap, Flatpak, rpm, deb, apt/dnf repositories — rejected in the intake
- electron-updater or any in-app auto-update
- Windows changes (`rk desktop` stays refused there; no Windows menu update item)
- Authenticode / notarization; changes to the hexokit.com curl installer (shll repo)
- A macOS `rk desktop uninstall` (deferred — intake row 24)
- Electron user-data cleanup on uninstall

### Design Decisions

#### Extract the AppImage once at install time
**Decision**: `rk desktop install` runs the downloaded file with `--appimage-extract` into staging and installs the extracted tree; the launcher, symlink, and relaunch all target `<root>/current/AppRun`.
**Why**: Removes the libfuse2 runtime dependency (absent by default on Ubuntu 22.04+), gives the running-state probe a stable absolute binary path, and keeps the version dir + `current` symlink layout identical to `internal/codeserver`. `AppRun` sets `LD_LIBRARY_PATH` to the bundled `usr/lib` and adds `--no-sandbox` only when unprivileged user namespaces are unavailable, so launching it (not the raw ELF) keeps the sandbox where it works.
**Rejected**: Keeping the AppImage as a single file (needs FUSE or `--appimage-extract-and-run` on every launch, and no stable helper-process path to probe); launching the raw `run-kit-desktop` ELF (loses the bundled libraries and the conditional sandbox flag); hardcoding `--no-sandbox` (disables the sandbox on hosts where it works).
*Introduced by*: 260917-ot32-linux-desktop-appimage-install

#### Digest is the only hard gate on Linux, and a missing digest refuses
**Decision**: On linux `Install` refuses a release asset without a sha256 digest and refuses on mismatch; the mac note-and-continue posture is unchanged.
**Why**: Linux has no codesign second gate, so the digest is the only verification the installer can perform before executing the downloaded file's own extractor. `internal/codeserver` already refuses on a missing digest.
**Rejected**: Warning and continuing as on mac (would execute unverified bytes).
*Introduced by*: 260917-ot32-linux-desktop-appimage-install

#### Update-menu items come from one electron-free pure function
**Decision**: `update-check.ts` exports `updateMenuItems(update)` returning the item-group model; `macAppMenu` and `fileMenu` both render it.
**Why**: `menu.ts` imports `electron`, so the win/linux menu contract cannot run under plain `node --test`; the pure-model split is the established `local-daemon.ts` → `daemonMenuModel` pattern and keeps the two platform menus from drifting.
**Rejected**: Duplicating the item literal in `fileMenu`; a mocked `electron` module loader for `menu.js` in the test suite.
*Introduced by*: 260917-ot32-linux-desktop-appimage-install

## Tasks

### Phase 1: Setup

- [x] T001 Add the platform seams to `app/backend/internal/desktop/desktop.go`: `Installer.GOOS` (default `runtime.GOOS`), `Installer.UserHome func() (string, error)` (default `os.UserHomeDir`), `Installer.RunInDir func(ctx, dir, name string, args ...string) ([]byte, error)` (default `exec.CommandContext` with `cmd.Dir`, stderr folded into the error like `runCommand`), `Installer.Signal func(pid int, sig syscall.Signal) error` (default `syscall.Kill`); make `DefaultInstallDir` a function `DefaultInstallDirFor(goos, home string) string` (darwin `/Applications`, linux `<home>/.rk/desktop`) and add `ins.effectiveInstallDir()` used by `AppPath()`; keep the exported `DefaultInstallDir` constant only if still referenced, otherwise remove it and update callers <!-- R2 -->
- [x] T002 [P] Rework `archLabel` in `app/backend/internal/desktop/release.go` to `archLabel(goos, goarch string) (label, suffix string, err error)` (darwin: `x64`/`arm64` + `.dmg`; linux: `x86_64`/`arm64` + `.AppImage`); update `ResolveRelease` to use the suffix and to name the asset kind in the not-found error; update `release_test.go` for both platforms <!-- R1 -->

### Phase 2: Core Implementation

- [x] T003 Create `app/backend/internal/desktop/linux.go` with the layout helpers (`linuxVersionDir`, `linuxCurrentPath`, `linuxStagingPrefix = ".staging-"`), `installedVersionLinux` (symlink target basename, absent → `""`), and `appRunningLinux` (`pgrep -f <root>/<ver>/run-kit-desktop` via `Run`, `probeTimeout`); route `InstalledVersion` and `AppRunning` in `installed.go` by `ins.GOOS` <!-- R2 -->
- [x] T004 In `app/backend/internal/desktop/install.go` make `Install` dispatch by `ins.GOOS` (`installDarwin` = today's body unchanged, `installLinux` new in `linux.go`): staging `MkdirTemp(root, ".staging-")` with deferred `RemoveAll`, download while hashing (reuse `download` with a caller-supplied dest path and the existing `progressPrinter`), digest refusal on missing/mismatch, `chmod 0700`, `RunInDir(staging, <file>, "--appimage-extract")` under `extractTimeout = 5 * time.Minute`, then `validateExtractedTree(dir, version)` checking `AppRun`, executable regular `run-kit-desktop`, `resources/app.asar`, `run-kit-desktop.desktop` with matching `X-AppImage-Version=`, the hicolor icon (returning its size dir), and symlink containment via `filepath.EvalSymlinks` + a local `within` helper (the `internal/codeserver` idiom) <!-- R3 -->
- [x] T005 Add the linux swap + restart path: in `linux.go` after validation probe `appRunningLinux` against the pre-flip `current` target, quit via `Signal(oldestPID, SIGTERM)` where the PID comes from `pgrep -o -f <path>` through `Run`, reuse `waitAppExit` (make it call the platform probe), `RemoveAll(<root>/<version>)`, `os.Rename(squashfs-root, <root>/<version>)`, flip `current` via `current.tmp` + `os.Rename`, remove every other version dir under the root, relaunch `<root>/current/AppRun` detached (a local `startDetached(argv)` with `Setsid: true`, stdio nil, `Start()` + async `Wait`) as non-fatal, and return `InstallResult{Version, Path: <root>/<version>, Restarted}`; add the linux arm of `restart.go`'s doc comments <!-- R4 -->
- [x] T006 Create `app/backend/internal/desktop/integrate.go`: `integrateLinux(home, root, iconSizeDir)` writing `~/.local/share/applications/run-kit-desktop.desktop` (exact keys per R5, quoted `Exec`), copying the icon to `~/.local/share/icons/hicolor/<size>/apps/run-kit-desktop.png`, running `update-desktop-database <dir>` only when `exec.LookPath` finds it (30 s, chatter note on failure/absence), and replacing `~/.local/bin/run-kit-desktop → <root>/current/AppRun` via temp symlink + rename; every failure after the flip is a `Progress` warning. Add `Uninstall(ctx) (UninstallResult, error)` on linux: refuse not-installed / running, remove version dirs + `current` (+ empty root), the `~/.local/bin` symlink only when its target is inside the root, the desktop entry, and the icon(s) <!-- R5, R6 -->
- [x] T007 Update `app/backend/cmd/rk/desktop.go`: gate `desktopGOOS` ∈ {darwin, linux} with the new error text; `Short`/`Long` blocks for parent, `install`, `update`, `status` platform-neutral describing both platforms; `--path` default `""` with the usage string from R7 and a `desktopInstallDir(cmd, ins)` resolver (unchanged flag → `DefaultInstallDirFor(desktopGOOS, home)`, explicit `""` → usage error); add `desktopUninstallCmd` (`Use: "uninstall"`, `Args: cobra.NoArgs`, `--path`, darwin refusal text from R6, data line `Uninstalled Run Kit from <root>`); pass `ins.GOOS = desktopGOOS` in `newDesktopInstallerFn` wiring so tests pin platforms <!-- R1, R6, R7 -->
- [x] T008 Update `app/backend/cmd/rk/upgrade.go`: `runUpdateDesktopLeg` gates on darwin or linux, installer built with the platform default root, `updateCmd.Long` desktop-leg paragraph says "(macOS, Linux)" and "the platform's default install root (/Applications or ~/.rk/desktop)" <!-- R8 -->
- [x] T009 Go tests for the linux installer in `app/backend/internal/desktop/linux_test.go` (+ `install_test.go` helpers): a fake `RunInDir` for `--appimage-extract` that writes a `squashfs-root` fixture (`AppRun`, executable `run-kit-desktop`, `resources/app.asar`, `.desktop` with `X-AppImage-Version`, `usr/share/icons/hicolor/1024x1024/apps/run-kit-desktop.png`), a recorded `Run` for `pgrep`/`pgrep -o`/`update-desktop-database`, a recorded `Signal`; cover: happy install (layout, `current`, integration files, data), missing digest refusal, digest mismatch, missing `.desktop`/version mismatch/missing asar refusals with staging removed, escaping symlink refusal, running app quit → wait → flip → relaunch (`Restarted: true`), never-exits abort with `current` unchanged, prune of an older version dir, `InstalledVersion` absent/present, `Uninstall` happy/not-installed/running/foreign-symlink-left-alone; assert the darwin tests still pass with `GOOS: "darwin"` pinned <!-- R2, R3, R4, R5, R6 -->
- [x] T010 [P] Shell: add `updateMenuItems(update: UpdateMenuInfo | null): UpdateMenuItemModel[]` to `app/desktop/src/update-check.ts` (move `UpdateMenuInfo`, `UPDATING_LABEL`, `restartToUpdateLabel` there; model rows `{ kind: "item", label, enabled }` and `{ kind: "separator" }`), render it in both `macAppMenu` and `fileMenu` in `app/desktop/src/menu.ts` (File: New Window, separator, update group, Quit/Exit), pass `update` to `fileMenu` from `buildMenu`, update the `buildMenu` doc comment; in `app/desktop/src/main.ts` call `app.setDesktopName("run-kit-desktop.desktop")` under `process.platform === "linux"` next to the single-instance lock block, and change `refreshUpdateMenu`'s gate to return only when the platform is neither darwin nor linux (update the section comment); add `update-check.test.ts` cases for `updateMenuItems` (null → `[]`, available → labelled enabled item + separator, updating → disabled `Updating…` + separator) <!-- R9 -->
- [x] T011 [P] Packaging: in `app/desktop/electron-builder.yml` remove the `deb` target and `maintainer` line and reword the linux comment (AppImage sole format; deb/rpm/snap/Flatpak rejected — see memory); in `.github/workflows/release.yml` rename the Linux build step to `Build Linux packages (AppImage, x64 + arm64)` and upload `app/desktop/release/*.AppImage` only <!-- R10 -->

### Phase 3: Integration & Edge Cases

- [x] T012 `app/backend/cmd/rk/desktop_test.go` + `upgrade_test.go`: pin `desktopGOOS = "linux"` with a temp `UserHome`, an httptest release with `x86_64`/`arm64` AppImage assets + digests, and the fake extractor; cover the gate (darwin ok, linux ok, windows refused with the new text and exit 1), `--path` default resolution on both platforms and `--path ""` exit 2, `install`/`update`/`status`/`uninstall` data lines on linux, the umbrella `rk update` desktop leg on linux (installed → updated line; absent → silent skip), and `resetDesktopFlags` covering `uninstall` and the new `""` default <!-- R1, R6, R7, R8 -->
- [x] T013 Verify the help surface: `rk help-dump` (or the existing root test) lists `desktop` with four children; `go run ./cmd/rk desktop --help` and each child's `--help` contain no platform-conditional text; run `gofmt -l` on touched files and `cd app/backend && go test ./internal/desktop/... ./cmd/rk/...` <!-- R7 -->

### Phase 4: Polish

- [x] T014 [P] Docs: `README.md` (rename the section to `Desktop app`, update the two `#desktop-app-macos` anchors, cross-platform install/update text, Linux paragraph + manual fallback, CLI table row without "macOS") and `docs/site/install.md` (same rename and anchor updates at lines 24 and 52, recommended Linux path = curl script then `run-kit desktop install`, manual fallback with `--appimage-extract-and-run`, `run-kit desktop uninstall`) <!-- R11 -->

## Execution Order

- T001 and T002 block T003–T009
- T003 → T004 → T005 → T006 → T009 sequentially (each builds on the previous file's helpers); T007 and T008 after T006; T012 after T007 and T008
- T010, T011, T014 are independent of the Go work

## Acceptance

### Functional Completeness

- [x] A-001 R1: On `desktopGOOS = "linux"` every `rk desktop` subcommand passes the gate; on `"windows"` each exits 1 with `rk desktop supports macOS and Linux (the shell is packaged as a macOS .app and a Linux AppImage)`; `desktop` and its four children remain registered
- [x] A-002 R1: Linux release resolution matches `run-kit-desktop-*-x86_64.AppImage` for amd64 and `-arm64.AppImage` for arm64; darwin still matches `-x64.dmg`/`-arm64.dmg`
- [x] A-003 R2: `DefaultInstallDirFor("linux", home)` is `<home>/.rk/desktop`; `InstalledVersion` on linux returns the `current` target basename or `""` when absent; `AppPath()` is `<root>/current`
- [x] A-004 R3: The linux install refuses a missing or mismatched digest before executing anything, extracts with `--appimage-extract` in the staging dir only after the digest passes, and refuses a tree missing any required file, with a mismatched `X-AppImage-Version`, or with an escaping symlink — each leaving the target untouched and the staging dir removed
- [x] A-005 R4: A running app is SIGTERMed via the signal seam at the oldest `pgrep -o` PID, waited on through `QuitWait`/`QuitPoll`, swapped only after exit, and relaunched via `<root>/current/AppRun` detached; `Restarted` is true only on a successful relaunch; a never-exiting app aborts with `current` unchanged
- [x] A-006 R5: After the flip the desktop entry (exact keys, quoted `Exec`, `StartupWMClass=Run Kit`), the hicolor icon at the mirrored size dir, and the `~/.local/bin/run-kit-desktop` symlink exist; `update-desktop-database` runs only when found; integration failures are warnings
- [x] A-007 R6: `rk desktop uninstall` on linux removes the root contents, the in-root symlink, the desktop entry, and the icon, prints `Uninstalled Run Kit from <root>`, refuses not-installed and running states, and on darwin exits 1 with the Trash message
- [x] A-008 R7: `--path` defaults to `""` with the dual-platform usage string, resolves per platform when unchanged, and `--path ""` exits 2; `Short`/`Long` text names both platforms with no platform-conditional wording
- [x] A-009 R8: `rk desktop update`/`status` work on linux through the seamed installer; `runUpdateDesktopLeg` runs on linux against the default root, skips silently when nothing is installed, and its `Long` text names both roots
- [x] A-010 R9: `main.ts` calls `app.setDesktopName("run-kit-desktop.desktop")` on linux; `refreshUpdateMenu` runs on darwin and linux; `updateMenuItems` is the single source for the item group; `fileMenu` renders it above Quit/Exit with no accelerator; `buildMenu` passes `update` to `fileMenu`
- [x] A-011 R10: `electron-builder.yml` has AppImage (x64 + arm64) as the only linux target, no `maintainer`; `release.yml` uploads `*.AppImage` only with the renamed step
- [x] A-012 R11: README and `docs/site/install.md` carry the renamed section, updated anchors, the Linux paragraph and fallback, and the CLI table row without "macOS"

### Behavioral Correctness

- [x] A-013 R3: The darwin install flow is behaviorally unchanged — the existing mac tests pass with `GOOS: "darwin"` pinned and `hdiutil`/`codesign`/`ditto`/`plutil`/`osascript`/`open` call sequences are identical
- [x] A-014 R4: After a successful linux install exactly one version dir remains under the root and `current` points at it

### Removal Verification

- [x] A-015 R10: No `deb` target, `maintainer` key, or `*.deb` upload glob remains in `electron-builder.yml` or `release.yml`; `scripts/build-desktop.sh` is unchanged

### Scenario Coverage

- [x] A-016 R3: `linux_test.go` exercises the happy path, missing digest, digest mismatch, missing `.desktop`, version mismatch, missing asar, and escaping symlink with a fake extractor writing the `squashfs-root` fixture
- [x] A-017 R4: Tests cover running → quit → flip → relaunch (`Restarted: true`) and the never-exits abort
- [x] A-018 R8: `upgrade_test.go` covers the linux desktop leg installed → updated data line and absent → silent skip
- [x] A-019 R9: `update-check.test.ts` covers `updateMenuItems` for null, available, and updating

### Edge Cases & Error Handling

- [x] A-020 R5: A missing `update-desktop-database` yields a chatter note and exit 0; a failing icon copy after the flip is a warning, not an error
- [x] A-021 R6: `uninstall` leaves a `~/.local/bin/run-kit-desktop` symlink alone when it points outside the root
- [x] A-022 R7: `desktopInstaller` still maps flag errors to usage (exit 2) and operational errors to exit 1

### Code Quality

- [x] A-023 Pattern consistency: seams are struct fields on `Installer` (never package vars); layout helpers mirror `internal/codeserver`; subprocess calls use `exec.CommandContext` with argv slices and timeouts; the shell's pure model follows the `local-daemon.ts` idiom
- [x] A-024 No unnecessary duplication: `download`, `progressPrinter`, `waitAppExit`, `desktopUpdateToLatest`, and `normalizeReleaseTag` are reused, not copied; the update item literal exists once
- [x] A-025 Comments state constraints, not narration; no change IDs or PR numbers in code comments
- [x] A-026 Go tests colocated (`*_test.go`), shell tests as sibling `*.test.ts`; touched Go files are `gofmt`-clean

### Security

- [x] A-027 R3: The downloaded file is executed only after the digest gate passes, with an argv slice and a bounded context; extracted-tree symlinks are containment-checked before any file under the tree is used
- [x] A-028 R6: `uninstall` removes only paths under the root or paths whose symlink target resolves into the root, plus the two named integration files

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds new functionality without making existing code redundant. The two removals it required (the `desktop.DefaultInstallDir` constant in `internal/desktop/desktop.go`, the `deb` target + `maintainer` key in `app/desktop/electron-builder.yml` and the `*.deb` upload glob in `.github/workflows/release.yml`) were performed in the apply diff itself; nothing superseded was left behind.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The update item group becomes a pure `updateMenuItems` model in `update-check.ts` consumed by both menus, instead of a mocked-electron menu test | `menu.ts` imports electron so it cannot run under `node --test`; the `local-daemon.ts` pure-model split is the established idiom | S:70 R:85 A:85 D:80 |
| 2 | Confident | A `RunInDir` seam (name + dir) is added beside `Runner` rather than changing the `Runner` signature | `--appimage-extract` writes into CWD; keeping `Runner` intact leaves every mac test untouched | S:65 R:85 A:80 D:80 |
| 3 | Confident | The detached relaunch uses a local `startDetached` helper in `internal/desktop` rather than importing `internal/gui.StartDetached` | Avoids coupling the installer library to the gui package for a ten-line function; the idiom is copied, not the dependency | S:55 R:80 A:70 D:70 |
| 4 | Certain | `DefaultInstallDir` becomes `DefaultInstallDirFor(goos, home)`; the `--path` cobra default is `""` resolved at runtime | Intake rows 4 and 15; help-dump text must stay platform-neutral | S:80 R:90 A:85 D:85 |
| 5 | Confident | The version dir is named from `rel.Version`; every other version dir is pruned after the flip | Intake rows 16 and 21 | S:60 R:85 A:70 D:70 |
| 6 | Confident | `uninstall` is refused on darwin with the Trash message and never quits a running app | Intake rows 17 and 24 (deferred mac variant) | S:60 R:85 A:70 D:70 |
| 7 | Confident | Unit tests fake `--appimage-extract` through `RunInDir` by writing a `squashfs-root` fixture; the real extractor is exercised only in the manual VM run | The Go test suite runs on every platform without an AppImage; the fake preserves the argv contract | S:65 R:85 A:85 D:80 |
| 8 | Confident | Post-flip housekeeping failures (old-version pruning, desktop integration) are chatter warnings, never install errors | The flip already succeeded — erroring would misreport a completed install (the relaunch-failure posture extended one step earlier) | S:60 R:90 A:75 D:70 |
| 9 | Confident | The detached relaunch uses `exec.Command`, not `CommandContext`: a context kill would murder the just-relaunched app when the CLI's context ends at exit; `Start` is non-blocking so no bound is needed | The `internal/gui.StartDetached` idiom is exactly this shape | S:70 R:80 A:80 D:75 |
| 10 | Confident | `Uninstall`'s usage validation precedes the darwin refusal so `--path ""` stays exit 2 on every platform | The exit-code contract (usage = 2, operational = 1) is platform-independent | S:65 R:90 A:80 D:75 |

10 assumptions (1 certain, 9 confident, 0 tentative).
