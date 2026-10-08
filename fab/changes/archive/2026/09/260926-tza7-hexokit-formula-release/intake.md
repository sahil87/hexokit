# Intake: HexoKit Formula Release

**Change**: 260926-tza7-hexokit-formula-release
**Created**: 2026-09-26

## Origin

> Phase 3 of the HexoKit rebrand, plan row R1 step (b) only
> (`fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`). R1(a) just merged: homebrew-tap now has
> `Formula/hexokit.rb` (installs `hexokit` binary + `rk`/`xk`/`run-kit` symlinks), `formula_renames.json`
> chains `rk -> run-kit -> hexokit`. Update `.github/formula-template.rb` (class `Hexokit`, install block
> matching the merged tap formula, test block asserting all four names print a version) and
> `.github/workflows/release.yml` (write `Formula/hexokit.rb`, commit `hexokit ${version}`, never touch the
> tap's `run-kit.rb`). Grep the repo for other places still assuming the published formula/binary name is
> `run-kit`; apply the plan's rules table (substrate never renamed, public brand renamed; keep correct
> mentions of the `rk`/`xk`/`run-kit` symlink names). Do NOT touch shll (R1c) or hexokit-site (R1d).

One-shot from the orchestrator, preceded by a codebase investigation in the same session. Key findings
from that investigation (encoded below as decisions):

- The merged tap formula (`curl …/homebrew-tap/main/Formula/hexokit.rb`, version 3.20.21) has
  `bin.install "rk" => "hexokit"` + three `bin.install_symlink bin/"hexokit" => …` lines (`rk`, `xk`,
  `run-kit`), and its test asserts `"run-kit version"` for all four names — correct only for the pre-R0
  3.20.21 binary.
- Post-R0 the binary's cobra root is `Use: "hexokit"` (static, not argv0-dynamic), so `--version` prints
  `hexokit version vX` for every invocation name (`root_test.go` asserts `"hexokit version dev"`). The
  template's test must therefore assert `"hexokit version"`, or `brew test hexokit` fails on the next release.
- `internal/selfpath` hardcodes `CellarMarker = "/Cellar/run-kit/"` and `StableFor` → `<prefix>/bin/run-kit`.
  A hexokit-formula install resolves to `<prefix>/Cellar/hexokit/<ver>/bin/hexokit`, so without a fix
  `IsBrewInstalled` is false (both `rk update` and `POST /api/update` refuse "not installed via Homebrew")
  and `StableFor` returns the version-pinned Cellar path (reintroducing the stale-`RK_BIN` bug fixed in #928).
- `cmd/rk/upgrade.go` runs `brew info --json=v2 sahil87/tap/run-kit` / `brew upgrade sahil87/tap/run-kit`
  and prints a `brew install sahil87/tap/run-kit` hint; `api/update.go`'s 409 body has the same hint; the
  desktop interstitial and welcome page show it too.

## Why

R1 renames the published Homebrew formula from `run-kit` to `hexokit`. The tap side (R1a) is done, but this
repo's release job still regenerates `Formula/run-kit.rb` with `class RunKit` — the next release would
write a stale file into the tap the rename just retired, and `Formula/hexokit.rb` would stay frozen at
3.20.21 forever. The next release is also the first one whose binary is installed from the `hexokit` keg,
so every runtime assumption that the keg is called `run-kit` (brew-install detection, stable bin path,
`brew info`/`upgrade` targets, install hints) must ship in the same release — otherwise self-update breaks
on exactly the installs that followed the rename. Doing this with the formula change, rather than after,
is the only order that never ships a binary that cannot update itself.

## What Changes

### 1. `.github/formula-template.rb`

- `class RunKit < Formula` → `class Hexokit < Formula`.
- `def install` becomes exactly (matches tap `Formula/hexokit.rb`):

  ```ruby
  def install
    bin.install "rk" => "hexokit"
    bin.install_symlink bin/"hexokit" => "rk"
    bin.install_symlink bin/"hexokit" => "xk"
    bin.install_symlink bin/"hexokit" => "run-kit"
  end
  ```

- `test do` asserts all four names:

  ```ruby
  test do
    assert_match "hexokit version", shell_output("#{bin}/hexokit --version")
    assert_match "hexokit version", shell_output("#{bin}/rk --version")
    assert_match "hexokit version", shell_output("#{bin}/xk --version")
    assert_match "hexokit version", shell_output("#{bin}/run-kit --version")
  end
  ```

- Everything else unchanged: `desc`, `homepage` (repo URL — R2), `version "VERSION_PLACEHOLDER"`, license,
  the tmux `depends_on` + its comment, the code-server comment, the four `on_macos`/`on_linux` url + sha
  placeholder blocks (tarballs stay `rk-<os>-<arch>.tar.gz` — substrate, D2).

### 2. `.github/workflows/release.yml` (formula-publish step, ~line 159–174)

- sed output path `/tmp/homebrew-tap/Formula/run-kit.rb` → `/tmp/homebrew-tap/Formula/hexokit.rb`.
- `git add Formula/run-kit.rb` → `git add Formula/hexokit.rb`; commit message `"run-kit ${version}"` →
  `"hexokit ${version}"`.
- The step never deletes or touches the tap's `Formula/run-kit.rb` (R1a removed it in the tap's own PR).

### 3. `internal/selfpath` — recognize the `hexokit` keg

- Brew-install detection matches `/Cellar/hexokit/` (primary) **and** `/Cellar/run-kit/` (legacy keg —
  defensive, e.g. a keg brew's rename migration left unmigrated). Replace the single `CellarMarker` const
  with an ordered set (e.g. keg name list `hexokit`, `run-kit`); keep `IsBrewInstalled(resolved)`'s signature.
- `StableFor` maps each keg to **its own** brew-prefix symlink: `…/Cellar/hexokit/<v>/bin/hexokit` →
  `<prefix>/bin/hexokit`; `…/Cellar/run-kit/<v>/bin/run-kit` → `<prefix>/bin/run-kit` (unchanged).
  Non-Cellar paths unchanged. Still a pure string derivation (never stats).
- Update the package doc comments; extend `selfpath_test.go` with hexokit linuxbrew + macOS cases, and
  keep the run-kit cases.
- Callers (`cmd/rk/upgrade.go`, `api/update.go`, daemon code-server/gui RK_BIN) need no signature change;
  their comments that name `/Cellar/run-kit/` / `<prefix>/bin/run-kit` get updated. Existing caller tests
  using `/Cellar/run-kit/…` paths keep passing (legacy keg still recognized); add at least one
  `/Cellar/hexokit/…` case on the upgrade path (restart uses `<prefix>/bin/hexokit`) and the
  `/api/update` self-update path.

### 4. `cmd/rk/upgrade.go` + `api/update.go` — brew targets and hints

- `brew info --json=v2 sahil87/tap/run-kit` → `sahil87/tap/hexokit`; `brew upgrade sahil87/tap/run-kit` →
  `sahil87/tap/hexokit`.
- Not-brew guidance `brew install sahil87/tap/run-kit` → `brew install sahil87/tap/hexokit` (CLI leg) and
  the `api/update.go` 409 body likewise. The user-facing product name in those messages follows the brand
  (`hexokit`/`HexoKit`) where it currently says `run-kit`.
- Update `upgrade_test.go` / `update_test.go` assertions on those strings/argv.

### 5. Public-facing install hints and stale comments

- `app/desktop/src/interstitial/interstitial.ts` and `app/desktop/src/welcome/welcome.html`:
  `brew install sahil87/tap/run-kit` → `brew install sahil87/tap/hexokit` (plus any desktop test asserting it).
- `README.md` line 17: the formula installs `hexokit`, with `rk` as the documented short name and
  `xk`/`run-kit` as aliases (D2: docs use `rk`; `xk` mentioned once).
- `docs/site/install.md` "Coming from the old `rk` formula?" note: cover the rename chain
  `rk → run-kit → hexokit` (brew follows it on `brew upgrade`; a leftover keg under an old name can be
  removed with a benign `brew uninstall`; `brew install sahil87/tap/hexokit` if the command is gone).
- Comments naming `brew upgrade run-kit` (`cmd/rk/agent_hook.go`, `cmd/rk/serve.go`) → `hexokit`.

### Explicitly out of scope (keep)

- Substrate (D2): the `rk` binary inside the tarball and tarball names, `RK_*`, `@rk_*`, `rk-*` sockets, the
  Go module, `rk-code-bridge`; `selfpath.LauncherFor`'s `run-kit` launcher name and
  `exec.LookPath("run-kit")` in `resolveRkPath` (the `run-kit` symlink stays in the formula).
- `internal/updatecheck/testdata` `formula: run-kit` — shll roster output, flips in R1c.
- `shll install run-kit`, install-script `sh -s -- run-kit` mentions — R1c/R1d.
- `homepage`/url repo paths `sahil87/run-kit` — R2.
- History (D11): `fab/` archives, memory narrative/log entries, old PR titles.
- The broad `run-kit <verb>` command examples in `docs/site/install.md` (D2 drift, not formula-related).
- Cutting the release (workflow_dispatch patch) — done by the orchestrator after merge, not in apply.

## Affected Memory

- `run-kit/build-and-release`: (modify) formula file/class/install/test now `Formula/hexokit.rb` / `Hexokit`
  / real binary `hexokit` + `rk`/`xk`/`run-kit` symlinks; tap-update step writes `hexokit.rb`; the
  "`upgrade.go` uses `run-kit` markers exclusively" decision is superseded by the hexokit-primary +
  legacy-run-kit keg detection.
- `run-kit/architecture/backend-packages`: (modify) `internal/selfpath` row — keg-name set, per-keg stable path.
- `run-kit/architecture/cli`: (modify) `update` row — brew targets `sahil87/tap/hexokit`.
- `run-kit/desktop-shell`: (modify) not-installed hint `brew install sahil87/tap/hexokit`.
- `run-kit/toolkit-standards`: (modify) present-tense conformance lines quoting `sahil87/tap/run-kit`.
- `run-kit/api-and-sockets`: (modify) `/api/update` 409 hint, if it quotes the formula.

## Impact

- CI/release: `.github/formula-template.rb`, `.github/workflows/release.yml` — exercised only by the next
  release run (the orchestrator cuts it post-merge and verifies the tap push).
- Backend Go: `internal/selfpath`, `cmd/rk/upgrade.go`, `api/update.go` (+ tests), comment-only touches in
  `cmd/rk/agent_hook.go`, `cmd/rk/serve.go`.
- Desktop: two static hint strings.
- Docs: README line 17, `docs/site/install.md` rename note.
- No API shape change; no frontend change.

## Open Questions

None blocking.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Template install block matches tap `Formula/hexokit.rb` exactly (hexokit real + rk/xk/run-kit symlinks) | User instruction; tap file fetched and read | S:95 R:90 A:95 D:95 |
| 2 | Certain | Formula test asserts `"hexokit version"`, not the tap's `"run-kit version"` | Post-R0 cobra `Use: "hexokit"` is static; `root_test.go` wants `hexokit version dev`; the tap string only fits 3.20.21 | S:90 R:90 A:95 D:90 |
| 3 | Certain | release.yml writes only `Formula/hexokit.rb`, commit `hexokit ${version}`; never touches `run-kit.rb` | User instruction | S:95 R:85 A:95 D:95 |
| 4 | Confident | selfpath recognizes `/Cellar/hexokit/` primary plus `/Cellar/run-kit/` legacy, each mapping to its own `<prefix>/bin/<keg>` | Required or self-update breaks on hexokit installs; legacy kept defensively because the brew rename is unverified (it is the R1c gate) — supersedes the 260709 exclusive-marker decision | S:80 R:80 A:80 D:75 |
| 5 | Certain | `rk update` targets `sahil87/tap/hexokit` for `brew info`/`upgrade`; install hints say `sahil87/tap/hexokit` | The new binary only ships in the hexokit formula; formula_renames covers old-name callers | S:85 R:85 A:90 D:85 |
| 6 | Certain | Substrate (rk tarball member, RK_*, launcher `run-kit` name, `LookPath("run-kit")`) untouched | Plan rule D2; the run-kit symlink stays in the formula | S:95 R:90 A:95 D:95 |
| 7 | Certain | shll roster data, install-script arg, repo URLs, history untouched | R1c/R1d/R2/D11 scope boundaries | S:95 R:90 A:95 D:95 |
| 8 | Confident | README line 17 and install.md rename note updated; broad `run-kit <verb>` examples left alone | Formula-name places only; the verb-example drift is unrelated D2 cleanup | S:80 R:90 A:80 D:80 |

8 assumptions (6 certain, 2 confident, 0 tentative, 0 unresolved).
