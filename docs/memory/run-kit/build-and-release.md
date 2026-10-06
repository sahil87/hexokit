---
type: memory
description: "Version management (VERSION file + ldflags), build pipeline (Vite dist copied into embed.FS), release flow & CI/CD (GitHub Releases, desktop packages as dependent jobs), Homebrew distribution via prebuilt binaries — including the install_formula unlink→install→link→cleanup ordering and which rk path is live in each upgrade phase."
---
# Build & Release

**Domain**: run-kit

## Version Management

- **Source of truth**: `VERSION` file at repo root — plain semver string (e.g., `0.1.0`), no `v` prefix
- **Build injection**: `scripts/build.sh` reads `VERSION` and passes `-X main.version=$(cat VERSION)` via ldflags
- **Go variable**: `var version = "dev"` in `root.go` — defaults to `"dev"` for local `go build` without ldflags
- **Displayed by**: the `--version`/`-v` global flag (Cobra built-in — there is no `version` subcommand; `rk version` exits 1 `unknown command`); also read by `rk update` (shows current version, compares with latest via `brew info --json=v2`)
- **Version output string**: every invocation name (`rk --version`, `run-kit --version`) prints `hexokit version <v>` (dev builds: `hexokit version dev`). The string flows from Cobra's version template, which prints the root's display name (`Use: "hexokit"`), so it is invocation-name-agnostic — no per-name divergence. The first word is the root command name, which is also the formula (`sahil87/tap/hexokit`) and shll roster name; the shll version standard's `<word> version <rest>` parse is word-agnostic, so probes are unaffected (260709-gidk-swap-canonical-cli-name-run-kit, 260911-mvuv-hexokit-brand-surfaces)
- **Exposed to the web UI over the state socket**: `cmd/rk/serve.go` plumbs the ldflags `main.version` into `*api.Server` via `SetVersion(version)` after `NewRouterAndServer`, which seeds the server-global `version` cached global slot (replayed once after `hello` — the version is fixed for the process lifetime). There is deliberately **no `GET /api/version`** (see § Design Decisions). Also fed to `internal/updatecheck.New(version, selfBrew)` (the running version is the run-kit-row comparison source; `selfBrew` gates its self-match). See § State Socket (global-slot replay), § SSE Hub (`event: version`) and § API Server version/checker wiring below (260713-4zap-update-notify-one-click-upgrade, 260716-qf3j-state-socket)


## Build Pipeline

`scripts/build.sh` encapsulates the full production build (frontend-first for embed):

1. `cd app/frontend && pnpm build` — produces `app/frontend/dist/` from two Vite entries: `index.html` (the SPA) and `viewer.html` (the `/present` document viewer shell — `app/frontend/src/viewer/`, served by the Go backend from the embedded FS; see [api-and-sockets](/run-kit/api-and-sockets.md) § API Layer → `/present/{server}/{roothash}/*`). Chunk splitting: `xterm` chunk for `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`; `router` chunk for `@tanstack/react-router`; plus lazy-loaded component chunks for `CommandPalette`, `ThemeSelector`, `CreateSessionDialog`. The viewer's format code stays in lazy chunks — markdown rendering (markdown-it) with mermaid loaded only when a document carries a ` ```mermaid ` fence, and the excalidraw renderer on the pinned `@excalidraw/utils@0.1.4` utility-only package (exact pin; no editor/React code in its import graph) loaded only for `.excalidraw` URLs. Every viewer asset is same-origin embedded build output — no CDN, no remote fonts: the utils bundle inlines every font family (including the CJK Xiaolai subsets) as base64 woff2 data URIs, which is what makes that lazy chunk ~19.6MB (§ Design Decisions). `zustand` is bundled as a production dependency. (260908-krov-present-viewer-shell)
2. Copy `app/frontend/dist/` → `app/backend/build/frontend/` (Go embed cannot reference `../` paths)
3. Build + package the code-bridge extension (`pnpm install --frozen-lockfile && pnpm run build && pnpm run package -- <version>` in `app/code-bridge/`) and copy the VSIX + a `VERSION` sidecar into `app/backend/build/codebridge/` (see [code-bridge](/run-kit/code-bridge.md) § Distribution)
4. Read version from the latest git tag (`git describe --tags`, fallback `0.0.0-dev`)
5. `CGO_ENABLED=0 go build -ldflags "-X main.version=${VERSION}" -o ../../dist/rk ./cmd/rk`

Output: `dist/rk` — single static binary with embedded frontend assets, the code-bridge VSIX, tmux config, and baked-in version.

`justfile` recipes: `build` delegates to `scripts/build.sh`, `release` delegates to `scripts/release.sh`; `setup` also installs the `app/code-bridge` pnpm deps alongside the frontend's.

**Desktop-shell build** — a separate, self-contained pipeline for the Electron viewer shell (`app/desktop`, see [desktop-shell](/run-kit/desktop-shell.md)), independent of `scripts/build.sh` and the Go binary: `just dev-desktop` → `scripts/dev-desktop.sh` (pnpm install when `node_modules` is missing, tsc compile, `pnpm exec electron .`; `RK_DESKTOP_URL=http://…` loads a URL directly without persisting it) and `just build-desktop [mac|win|linux]` → `scripts/build-desktop.sh` (target from the optional argument, else derived from `uname -s`; verifies the committed `app/desktop/build/icon.png` exists, `pnpm install --frozen-lockfile`, compile, `electron-builder --mac|--win|--linux --publish never --config.extraMetadata.version=$VERSION` with `$VERSION` from `git describe --tags --abbrev=0`, fallback `0.0.0-dev`), producing ad-hoc-signed per-arch DMGs, an NSIS installer, or AppImages (x64 + arm64 — the sole Linux format) in `app/desktop/release/` (gitignored). Each platform's package can only be built on that platform's host. The scripts are the *local* path; releases build the same artifacts on native runners through the `desktop-macos`/`desktop-linux`/`desktop-windows` jobs with inline steps rather than `scripts/build-desktop.sh` (see § Release Flow & CI/CD).


## Release Flow & CI/CD

**Release script** (`scripts/release.sh`): accepts bump level (`patch`/`minor`/`major`), increments `VERSION` file semver, commits with message `v{version}`, creates git tag `v{version}`, pushes commit + tag. Tag push triggers CI.

**GitHub Actions** (`.github/workflows/release.yml`): two triggers — `v*` tag push (allowed from any ref) and `workflow_dispatch` with a `bump` choice input (guarded to `main` by the `release` job's `if:`). Four jobs: `release` (ubuntu) plus three desktop-packaging jobs — `desktop-macos` (macOS), `desktop-linux` (ubuntu), and `desktop-windows` (Windows).

**`release` job** steps: checkout → setup Go (from `go.mod`) → setup Node 20 + pnpm → install frontend deps → build frontend → copy dist to backend → build and package the code-bridge extension with the release version → copy the VSIX + `VERSION` sidecar into `app/backend/build/codebridge/` → cross-compile 4 targets → create GitHub Release with tarballs → update Homebrew tap. The PR CI workflow (`.github/workflows/ci.yml`) carries a `Code bridge (tsc + node --test)` job (`pnpm install --frozen-lockfile`, `npx tsc --noEmit`, `pnpm test` in `app/code-bridge/`) wired into the ci-gate's required-jobs list (`needs: [backend, frontend, e2e, code-bridge]`).

Cross-compile targets: `darwin/arm64`, `darwin/amd64`, `linux/arm64`, `linux/amd64`. Each target built with `CGO_ENABLED=0` and ldflags. Output: `rk-{os}-{arch}.tar.gz` tarballs uploaded to GitHub Release via `softprops/action-gh-release`.

**Job-level `tag`/`version` outputs**: the `release` job promotes its `Extract version from tag` step (`id: version`) outputs to job outputs — `tag: ${{ steps.version.outputs.tag }}`, `version: ${{ steps.version.outputs.version }}`. That step already resolves both trigger paths (tag-push via `${GITHUB_REF#refs/tags/}`, workflow_dispatch via `steps.create_tag.outputs.tag` — the tag `scripts/release.sh` just created), so downstream jobs get the authoritative tag/version regardless of how the run started.

**Desktop-packaging jobs** — `desktop-macos`, `desktop-linux`, `desktop-windows`, all `needs: release`, appended after the `release` job. Each packages the Electron viewer shell (`app/desktop`, see [desktop-shell](/run-kit/desktop-shell.md)) on a **native runner** (no wine cross-compilation) and attaches its artifacts to the release the `release` job just published:

| Job | Runner | Build flag | Artifacts uploaded |
|-----|--------|-----------|--------------------|
| `desktop-macos` | macos-latest | `--mac` (+ `CSC_IDENTITY_AUTO_DISCOVERY: "false"`) | `release/*.dmg` |
| `desktop-linux` | ubuntu-latest | `--linux` | `release/*.AppImage` |
| `desktop-windows` | windows-latest | `--win` | `release/*.exe` |

**Desktop artifact naming**: the packages carry electron-builder's global `artifactName` `hexokit-desktop-${version}-${arch}.${ext}` (see [desktop-shell](/run-kit/desktop-shell.md) § Packaging), and the upload globs are extension-based (`*.dmg` / `*.AppImage` / `*.deb` / `*.exe`), so the workflow is indifferent to the prefix. `rk desktop`'s release resolution matches `hexokit-desktop-` first and falls back to the legacy `run-kit-desktop-` prefix, so a release carrying either naming installs (260911-mvuv-hexokit-brand-surfaces).

The **shared step shape** (identical across all three, same pinned action SHAs):

1. **Checkout at `ref: ${{ needs.release.outputs.tag }}`** — never `github.ref`. On workflow_dispatch the tag is created *inside* the `release` job, so the triggering ref points at pre-bump `main`; the desktop jobs must check out the tag they are packaging. No `fetch-depth: 0` — the version rides the job output, so no step needs git history.
2. **setup-node 22 + pnpm 9**, on the same pinned action SHAs the `release` job uses (checkout v4, setup-node v4, pnpm/action-setup v4). Node 22 (not the 20 the frontend jobs pin) is required by the desktop package itself: `app/desktop/package.json` declares `engines.node >=22.12.0`, matched by the lockfile's `electron@43` / `@electron/rebuild@4` constraints. pnpm only *warns* on an engine mismatch (nothing sets `engine-strict`), so a node-20 runner would fail late — after the release and tap have published.
3. **`pnpm install --frozen-lockfile` → `pnpm run compile`** in `app/desktop`.
4. **`pnpm exec electron-builder --<platform> --publish never --config.extraMetadata.version="${{ needs.release.outputs.version }}"`**. The version comes from the release job's output rather than `git describe` (which a shallow CI checkout cannot be trusted for), so every desktop artifact's version equals the server-binary version by construction.
5. **`gh release upload "${{ needs.release.outputs.tag }}" <glob> --clobber`** with `GH_TOKEN: ${{ github.token }}` — appends to the release `softprops` already created, without touching the generated notes. The workflow-level `permissions: contents: write` covers it, and `gh` is preinstalled on all three GitHub-hosted runner images.

**Per-job specifics:**

- **`desktop-macos` signing + verification.** `identity: null` in `electron-builder.yml` makes electron-builder skip signing; the `afterPack: ./after-pack.js` hook supplies the ad-hoc signature (`codesign --force --deep --sign -` on the packed `.app`, before the DMG is assembled); the `CSC_IDENTITY_AUTO_DISCOVERY: "false"` env var keeps electron-builder from hunting for signing certs on the runner. The job then hard-gates on **`codesign --verify --deep --strict` + `codesign -dv` over `app/desktop/release/mac*/*.app`** — the signature lives on the `.app` bundle, not the DMG container. An unsigned arm64 app is killed at launch, so a build that silently loses its ad-hoc signature fails the job loudly. The strict verify matters: a bare `-dv` accepts the Electron prebuilt's residual linker signature (no sealed resources), which is exactly the state `identity: null` ships without the afterPack hook — the v3.12.2 run failed here, catching the unsigned x64 app. **This gate is mac-only by design**: Windows ships unsigned (SmartScreen friction accepted) and Linux needs no signing, so there is no launch-blocking invariant to assert on either — the win/linux jobs each carry an inline comment saying so, and the `after-pack.js` hook self-guards on `electronPlatformName !== "darwin"` so those packs never reach `codesign` at all.
- **`desktop-windows` shell.** `defaults.run.shell: bash` at job level so the shared `cd app/desktop && …` step bodies work byte-identically on a Windows runner (bash ships on `windows-latest`); without it the default PowerShell would fork the step shape.

None of the three carries an extra `if:` (skip propagates through `needs: release` when the release job's `main` guard skips it) or `continue-on-error` — a packaging failure turns the workflow red *after* the release and tap have published, by design. The Homebrew tap step is untouched and continues to reference only the server binaries.

**Help-tree publish to shll.ai — pull, not push:** the release job does not publish the help tree. shll.ai's integration model is **pull**: shll.ai runs `rk help-dump` itself on a schedule and captures the output; there is no push step in CI (see § Design Decisions). CI carries no `SHLLAI_TOKEN` reference. (260603-iak3-teardown-shllai-publish-ci) The hidden `rk help-dump` subcommand is the single contract surface shll.ai pulls from (see `## CLI Subcommands`). The `release` job's final step is **Update Homebrew tap**.

**Homebrew tap update** (the **final** step in the `release` job): computes SHA256 for all 4 tarballs, clones `sahil87/homebrew-tap` via the `HOMEBREW_TAP_TOKEN` secret (exported as `TAP_TOKEN`), generates `Formula/hexokit.rb` from `.github/formula-template.rb` (placeholder substitution via `sed`), stages only that file, commits with message `hexokit ${version}`, and pushes. The output path/filename and commit message follow the `hexokit` formula name; the step never writes or deletes `Formula/run-kit.rb` (the tap retired it in its own repo). Tarball artifact names are `rk-{os}-{arch}.tar.gz` with a single `rk` member (the physical binary keeps its `rk` name; the formula renames it at install time). (260709-gidk-swap-canonical-cli-name-run-kit, 260926-tza7-hexokit-formula-release)


## Homebrew Distribution

**Formula**: `Formula/hexokit.rb` in `sahil87/homebrew-tap` (generated by CI from `.github/formula-template.rb`; the formula class is `Hexokit` and the file/name are `hexokit`). (260926-tza7-hexokit-formula-release) Public repo — plain URL downloads, no auth token needed. Platform detection via `on_macos`/`on_linux` + `on_arm`/`on_intel`. Version and SHA256 values substituted by CI. **Sequencing dependency** (out of this repo's scope, but binding): `sahil87/homebrew-tap` carries `formula_renames.json` chaining `"rk": "run-kit"` and `"run-kit": "hexokit"`, with no `Formula/rk.rb` or `Formula/run-kit.rb`, so existing `rk` and `run-kit` installs upgrade via brew's rename redirect.

Install flow: `brew install sahil87/tap/hexokit` (fully qualified — the shll meta-CLI always installs qualified, so the unqualified-`brew install`-core-collision constraint does not apply). Update: `rk update`.

**The formula declares no runtime `depends_on`.** code-server backs the `code` lens, but rk owns that install itself — a digest-verified standalone tarball under `<state>/code-server/bin/` (`<state>` = the state home, `${XDG_STATE_HOME:-~/.local/state}/hexokit/`), acquired on first daemon start via the `rk-jobs` install window or manually via `rk code-server install` (§ Daemon Lifecycle → the `rk-code-server` sibling session) — so the formula does not depend on Homebrew's code-server formula (see § Design Decisions). The managed install is one `<version>/` directory per release plus a relative `current` symlink; after `rk code-server install`/`update` flips `current`, `internal/versionprune` prunes the bin root to the flipped-to version plus the previous one (the pre-flip `current` target; with no flip history, the highest semver strictly below current) — best-effort, non-version entries ignored, the previous version kept as rollback headroom. tmux is likewise undeclared — a host-provides assumption. (260813-oid2-own-code-server-install, 3ht0)

**Command names — `hexokit` long name, `rk` canonical short name**: the formula's real binary is `hexokit`; `rk` is the canonical short name docs use, `xk` a second alias, and `run-kit` the legacy long alias — all fully interchangeable (rationale in § Design Decisions). What the naming model entails:

- **Formula real-vs-alias**: `def install` does `bin.install "rk" => "hexokit"` then `bin.install_symlink bin/"hexokit" => "rk"`, `=> "xk"`, and `=> "run-kit"` — the tarball's `rk` member is **installed under the name `hexokit`** (the real binary), and `rk`, `xk`, `run-kit` become symlinks back. The formula class is `Hexokit`, published as `Formula/hexokit.rb`; the `test do` block asserts all four of `#{bin}/hexokit`, `rk`, `xk`, `run-kit` `--version` match `"hexokit version"` (the `--version` flag, NOT a `version` subcommand; see § Version Management).
- **Cobra root**: `Use: "hexokit"` + matching `Short` (static string, not argv[0]-dynamic — see § Design Decisions). Version output prints `hexokit version <v>` for every invocation name.
- **help-dump**: `tool` follows the root name (`hexokit`; `schema_version` stays `1`) — see § CLI Subcommands (`help-dump` row).
- **Brew keg detection is hexokit-primary with a legacy `run-kit` keg**: `internal/selfpath.BrewKegs` is `hexokit`, `run-kit` — a resolved path under either `/Cellar/<keg>/` is a brew install, and the daemon-restart / `RK_BIN` stable path is that keg's own `<prefix>/bin/<keg>`. `rk update` queries and upgrades `selfpath.BrewFormula` (`sahil87/tap/hexokit`); the retired `/Cellar/rk/` keg is not recognized (see § Design Decisions).
- **Shell completion binds all four invocation names** (zsh/bash): cobra generates completion for the root name `hexokit` only, so `shell_init.go` appends `compdef _hexokit rk` / `xk` / `run-kit` (zsh) and `complete … -F __start_hexokit rk` / `… xk` / `… run-kit` lines (bash) so every invocation name — `rk`, the `xk` alias (D16), and the legacy `run-kit` — keeps tab completion. fish/powershell keep cobra's single-name binding.

**Invariants — internals stay `rk`**: the Go module path (`module rk`), `cmd/rk/` directory, `RK_*` env vars, `rk-daemon` socket/session names, `dist/rk`/`bin/rk` build outputs, and release-artifact/tarball names (`rk-{os}-{arch}.tar.gz`, single `rk` member — the physical binary keeps its `rk` name; the formula renames at install time) are all `rk`. `rk` is a real on-PATH executable name **indefinitely** — installed `rk agent setup` hooks embed `/opt/homebrew/bin/rk` and fab-kit skills gate on `command -v rk`. All invocation names are fully interchangeable for every subcommand; the tap-repo `formula_renames.json` chain (`rk` → `run-kit` → `hexokit`) is what lets pre-existing installs upgrade (see § Homebrew Distribution).
**Upgrade-window path liveness** — Homebrew's `install_formula` phases are: **unlink** the old keg FIRST, then the network-dependent install phase (tap "newer version available" lookup, `compute_dependencies`/`install_dependencies`, pour — Homebrew 6 makes an un-timed `api.github.com` call inside tap upgrades, so this phase is minutes, not milliseconds), **link** the new keg in `finish`, and delete the old keg in **cleanup**, after the new link. Which rk path is live in each phase is the fact every `internal/selfpath` resolver audience derives from: the brew-prefix stable symlink (`<prefix>/bin/<keg>`) **dangles for the whole install phase**, while the old keg's Cellar binary keeps working **until cleanup** — so the rk-owned launcher (Cellar-targeted) is live exactly when the stable symlink is not, and the stable symlink covers the gap between cleanup and the daemon's next launcher re-point. The hook wrapper and code-server's `RK_BIN` therefore exec the launcher first with the stable path as fallback (see [agent-state](/run-kit/agent-state.md) § `rk agent setup` → Hook command, and [backend-packages](/run-kit/architecture/backend-packages.md) § `internal/selfpath`).


## Design Decisions

### Prebuilt binaries over build-from-source Homebrew formula
**Decision**: Ship cross-compiled binaries via GitHub Release.
**Why**: Zero build dependencies on the user's machine (no Go, Node.js, pnpm). Faster install.
**Rejected**: Build-from-source formula (like tu), which requires all build tools.
*Introduced by*: 260317-ukyz-homebrew-deployment

### Desktop packages ride the release train as dependent jobs, not a separate workflow
**Decision**: `desktop-macos`, `desktop-linux`, and `desktop-windows` all sit in `release.yml` behind `needs: release`, consume the release job's `tag`/`version` outputs, and upload to the release the same run created. Steps are inline rather than a call to `scripts/build-desktop.sh`.
**Why**: One trigger surface and one version source keeps every desktop artifact's version identical to the server-binary version by construction, and `needs:` supplies both the ordering guarantee (the GitHub Release exists before upload) and free skip-propagation when the release job's `main` guard skips it. Inline steps because the script derives its version from `git describe`, which a shallow CI checkout cannot be trusted for, and its icon-existence check is redundant against a committed icon.
**Rejected**: A standalone desktop workflow (needs its own trigger, its own tag resolution, and a way to wait for the release to exist); `continue-on-error` on the jobs (a silently missing artifact is worse than a red run — the server artifacts and tap have already published either way, and neither is ever rolled back).
*Introduced by*: 260729-5uae-desktop-shell-release-ci

### One job per desktop platform on a native runner, sharing a single step shape
**Decision**: Three sibling jobs rather than one matrix job or a wine cross-compile from the ubuntu runner; `desktop-windows` sets `defaults.run.shell: bash` so the shared `cd app/desktop && …` step bodies are byte-identical across all three.
**Why**: The jobs are only *mostly* alike — mac adds a signing env var and the `codesign --verify --deep --strict` hard gate, and each uploads a different artifact glob — so a matrix would need per-leg conditionals for the mac-only steps, which is the shape a matrix is supposed to remove. Native runners keep each platform's packaging on its own toolchain with no emulation layer to debug, and runner minutes are not a constraint here.
**Rejected**: A `strategy.matrix` over runner+flag (the mac-only signing/verify steps force `if:` conditionals per leg); wine cross-compilation of the Windows target from ubuntu (one fewer job, a whole extra failure surface); PowerShell on the Windows job (forks the step bodies from its two siblings).
*Introduced by*: 260730-ler1-desktop-windows-linux-packaging

### `embed.FS` with copy step over restructuring repo
**Decision**: Copy `app/frontend/dist/` into `app/backend/build/frontend/` at build time.
**Why**: Go's `//go:embed` cannot reference files outside the package directory. Simple build-time operation.
**Rejected**: Colocating frontend output with Go source (breaks dev workflow).
*Introduced by*: 260317-ukyz-homebrew-deployment

### Static `exportToSvg` over the interactive excalidraw viewer
**Decision**: `.excalidraw` documents render to a static SVG via the pinned `@excalidraw/utils@0.1.4` `exportToSvg` export in a lazy chunk; the compile-time contract is a locally declared typed adapter (`ExcalidrawUtils`/`ExcalidrawSceneInput`) because the package's own d.ts references unresolvable sibling type packages.
**Why**: The viewer is read-only; the editor bundle is heavy and adds interactivity nobody asked for, and the exact-version pin plus local adapter keep the runtime signature fixed. The built graph contains zero editor code (no React/radix), and the upgrade path to an interactive viewer stays open.
**Rejected**: The full `@excalidraw/excalidraw` editor/viewer embed — weight and scope. (The registry `latest` dist-tag points at a test build; 0.1.4 is the pinned stable.)
*Introduced by*: 260908-krov-present-viewer-shell

### Viewer assets fully embedded — inlined fonts, no CDN
**Decision**: Everything the viewer loads is same-origin embedded build output; the excalidraw utils bundle's fonts (including CJK Xiaolai unicode-range subsets) ride as base64 woff2 data URIs inside the lazy chunk, making it ~19.6MB.
**Why**: Remote hosts and the desktop shell must work offline, and the intake's all-assets-same-origin constraint admits no CDN fallback. The size is acceptable because the chunk loads only for `.excalidraw` URLs via dynamic import — markdown and the SPA never pay it.
**Rejected**: CDN font fallbacks (violates the offline contract); shipping font files through `public/` copies plus an asset-path mechanism (extra build wiring for assets the bundle already carries); a hard bundle-size budget (none exists).
*Introduced by*: 260908-krov-present-viewer-shell

### VERSION file + ldflags over Go constant
**Decision**: Version sourced from the `VERSION` file, injected via `-X main.version=...`.
**Why**: Shell scripts can read/write plain text. No code changes for version bumps.
**Rejected**: Go constant (requires code change per release).
*Introduced by*: 260317-ukyz-homebrew-deployment

### Version rides the state socket; no `GET /api/version`
**Decision**: The ldflags version is seeded into the server-global `version` slot and replayed once after `hello` over the state socket; there is no dedicated HTTP endpoint.
**Why**: The socket connect is the moment the client needs it, and the reconnect after a `rk update`-driven daemon restart delivers a *different* version, which is exactly the signal the frontend's auto-reload guard keys on.
**Rejected**: A `GET /api/version` endpoint; the SSE stream as the transport (the state socket carries it).
*Introduced by*: 260713-4zap-update-notify-one-click-upgrade, 260716-qf3j-state-socket

### Help-tree publish to shll.ai is pull, not push
**Decision**: shll.ai runs `rk help-dump` itself on a schedule; the release job carries no publish step and no `SHLLAI_TOKEN`.
**Why**: A push step would be redundant work and a redundant attack surface — dual writers to `help/run-kit.json` could race.
**Rejected**: A push step in which each toolkit CLI produces its help JSON in CI and PRs it into shll.ai.
*Introduced by*: 260603-iak3-teardown-shllai-publish-ci

### Formula declares no runtime `depends_on`
**Decision**: Neither code-server nor tmux is a formula dependency; rk installs code-server itself (digest-verified standalone tarball under `<state>/code-server/bin/`), tmux is host-provided.
**Why**: Homebrew's code-server formula is deprecated and pinned upstream since it bundles non-FOSS `@github/copilot` from 4.113.0; depending on it would make `brew install run-kit` itself fail when upstream disables it.
**Rejected**: `depends_on "code-server"` in the formula.
*Introduced by*: 260813-oid2-own-code-server-install

### Command names: `hexokit` real binary, `rk` canonical short name
**Decision**: `hexokit` is the long command name (formula `Formula/hexokit.rb`, class `Hexokit`, real binary `hexokit`, with `rk`, `xk`, `run-kit` symlinks); `rk` is the canonical, permanently-supported short name. Internals (module path, `cmd/rk/`, `RK_*`, socket/session names, build outputs, tarball names) stay `rk`.
**Why**: The Homebrew-core unqualified-install conflict that would otherwise force the short name does not apply — the shll meta-CLI always installs fully qualified. `rk` stays on PATH indefinitely because installed `rk agent setup` hooks embed `/opt/homebrew/bin/rk` and fab-kit skills gate on `command -v rk`.
**Rejected**: Keeping `rk` as the canonical name; dropping the `rk` alias.
*Introduced by*: 260926-tza7-hexokit-formula-release, 260709-gidk-swap-canonical-cli-name-run-kit, 260707-ook7-run-kit-command-alias

### Static Cobra `Use` string, not argv[0]-dynamic
**Decision**: `Use: "hexokit"` + matching `Short` are static strings.
**Why**: help-dump determinism — shll.ai regenerates the help JSON on a schedule and its output must not depend on which name invoked the CLI.
**Rejected**: argv[0]-dynamic `Use`.
*Introduced by*: 260709-gidk-swap-canonical-cli-name-run-kit

### Hexokit-primary keg detection with a legacy `run-kit` keg fallback
**Decision**: `internal/selfpath` recognizes the `hexokit` keg first and the `run-kit` keg as a fallback, each mapping to its own `<prefix>/bin/<keg>` stable symlink; `rk update` targets `sahil87/tap/hexokit`. The `/Cellar/rk/` keg is not recognized.
**Why**: The binary ships only in the `hexokit` formula, so the hexokit keg is what it must recognize. The `run-kit` keg is kept because a binary stranded there by an incomplete brew rename migration would otherwise lose self-update and hand out a version-pinned `RK_BIN`. `/Cellar/rk/` needs nothing: an old binary runs its own old logic and brew's `formula_renames` redirects its upgrade.
**Rejected**: An exclusive `/Cellar/hexokit/` marker — a few lines cheaper, but an unmigrated keg would silently lose self-update.
*Introduced by*: 260926-tza7-hexokit-formula-release, 260709-gidk-swap-canonical-cli-name-run-kit
