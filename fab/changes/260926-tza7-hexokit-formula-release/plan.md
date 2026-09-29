# Plan: HexoKit Formula Release

**Change**: 260926-tza7-hexokit-formula-release
**Intake**: `intake.md`

## Requirements

### Release: Homebrew formula

#### R1: Formula template generates the `hexokit` formula
`.github/formula-template.rb` SHALL declare `class Hexokit < Formula`, install the tarball's `rk` binary as
`hexokit` with `rk`, `xk`, and `run-kit` symlinks (the exact install block of the tap's `Formula/hexokit.rb`),
and its `test do` block SHALL assert that each of the four names prints `hexokit version`. All other
template content (desc, homepage, version/sha placeholders, tmux `depends_on`, code-server comment, url
blocks) SHALL be unchanged.

- **GIVEN** the release job substitutes version and sha placeholders into the template
- **WHEN** Homebrew installs and tests the result
- **THEN** `bin/hexokit` is the real binary, `bin/rk`, `bin/xk`, `bin/run-kit` are symlinks to it
- **AND** `hexokit --version`, `rk --version`, `xk --version`, `run-kit --version` all match `hexokit version`

#### R2: Release job publishes `Formula/hexokit.rb`
The release workflow's tap-update step SHALL write the generated formula to `Formula/hexokit.rb`, stage only
that file, and commit `hexokit ${version}`. It MUST NOT write, stage, or delete `Formula/run-kit.rb`.

- **GIVEN** a release run reaches the Homebrew tap update step
- **WHEN** it commits to `sahil87/homebrew-tap`
- **THEN** the commit touches `Formula/hexokit.rb` only, with message `hexokit <version>`

### Runtime: Homebrew keg detection

#### R3: Brew-install detection and stable path recognize the `hexokit` keg
`internal/selfpath` SHALL treat a resolved path containing `/Cellar/hexokit/` or `/Cellar/run-kit/` as a
Homebrew install. `StableFor` SHALL map `<prefix>/Cellar/hexokit/<v>/bin/…` to `<prefix>/bin/hexokit` and
`<prefix>/Cellar/run-kit/<v>/bin/…` to `<prefix>/bin/run-kit`, and return any other path unchanged, without
touching the filesystem.

- **GIVEN** the daemon binary resolves to `/home/linuxbrew/.linuxbrew/Cellar/hexokit/3.20.22/bin/hexokit`
- **WHEN** `IsBrewInstalled` / `StableFor` run
- **THEN** it is a brew install and the stable path is `/home/linuxbrew/.linuxbrew/bin/hexokit`
- **GIVEN** a legacy keg path `/opt/homebrew/Cellar/run-kit/3.20.21/bin/run-kit`
- **THEN** it is still a brew install with stable path `/opt/homebrew/bin/run-kit`
- **GIVEN** a dev build path such as `/home/u/code/run-kit/app/backend/bin/rk`
- **THEN** it is not a brew install and `StableFor` returns it unchanged

#### R4: `rk update` and the web update target the `hexokit` formula
The CLI update leg SHALL run `brew info --json=v2 sahil87/tap/hexokit` and `brew upgrade sahil87/tap/hexokit`,
restart the daemon via the `StableFor` path, and its not-a-brew-install guidance SHALL end with
`brew install sahil87/tap/hexokit`. The `POST /api/update` self-update 409 body SHALL name
`brew install sahil87/tap/hexokit`.

- **GIVEN** a hexokit-keg brew install with a newer version available
- **WHEN** `rk update` runs
- **THEN** brew is invoked with `upgrade sahil87/tap/hexokit` and the daemon restarts from `<prefix>/bin/hexokit`
- **GIVEN** a non-brew install
- **WHEN** `rk update` runs or `POST /api/update` hits the self-update path
- **THEN** the guidance names `brew install sahil87/tap/hexokit`

### Docs & desktop: install hints

#### R5: Public install hints name the `hexokit` formula
The desktop interstitial and welcome page SHALL show `brew install sahil87/tap/hexokit`. README SHALL state
the formula installs `hexokit` with `rk` as the short name (and `xk`/`run-kit` as aliases). The install
guide's legacy-formula note SHALL describe the `rk → run-kit → hexokit` rename chain. Code comments naming
`brew upgrade run-kit` SHALL name `hexokit`.

- **GIVEN** a desktop user with no local daemon
- **WHEN** the interstitial / welcome page shows the install hint
- **THEN** it reads `brew install sahil87/tap/hexokit`

### Non-Goals

- shll roster, `versions.json`, install-script default (R1c/R1d) — separate gated steps
- Repo URLs `sahil87/run-kit` in homepage/url blocks (R2)
- Substrate: tarball names/`rk` member, `RK_*`, launcher `run-kit` name, `resolveRkPath`'s `LookPath("run-kit")` (the symlink stays)
- `internal/updatecheck/testdata` `formula: run-kit` (shll output fixture)
- Cutting the release — orchestrator, post-merge

### Design Decisions

#### Hexokit-primary keg detection with a legacy `run-kit` keg fallback
**Decision**: `internal/selfpath` recognizes the `hexokit` keg first and the `run-kit` keg as a fallback; each maps to its own `<prefix>/bin/<keg>` stable symlink. `rk update` targets `sahil87/tap/hexokit`.
**Why**: The new binary ships only in the `hexokit` formula, so the hexokit keg is what it must recognize; the legacy keg is kept because brew's rename migration is not yet verified on a real box (the R1c gate), and a binary stranded under `/Cellar/run-kit/` must still self-update and hand out a version-stable `RK_BIN`.
**Rejected**: Exclusive `/Cellar/hexokit/` marker (the 260709 precedent's pattern) — cheaper by a few lines, but an unmigrated keg would silently lose self-update and reintroduce the stale-`RK_BIN` failure.
*Introduced by*: 260926-tza7-hexokit-formula-release

## Tasks

### Phase 1: Release automation

- [x] T001 [P] Update `.github/formula-template.rb` (class `Hexokit`, install + test blocks per R1) and `.github/workflows/release.yml` tap step (write/stage `Formula/hexokit.rb`, commit `hexokit ${version}`) <!-- R1 --> <!-- R2 -->

### Phase 2: Core Implementation

- [x] T002 Replace the single `CellarMarker` in `app/backend/internal/selfpath/selfpath.go` with an ordered keg-name set (`hexokit`, `run-kit`); `IsBrewInstalled` matches any, `StableFor` maps to the matched keg's `<prefix>/bin/<keg>`; update doc comments; extend `selfpath_test.go` with hexokit linuxbrew/macOS cases <!-- R3 -->
- [x] T003 Update `app/backend/cmd/rk/upgrade.go` (brew info/upgrade targets, not-brew guidance) and `app/backend/api/update.go` (409 hint, comments) to `sahil87/tap/hexokit`; update `upgrade_test.go` / `update_test.go` string/argv assertions and add a `/Cellar/hexokit/` case each (restart path `<prefix>/bin/hexokit`; brew gate passes) <!-- R4 -->

### Phase 3: Hints & docs

- [x] T004 [P] Update `app/desktop/src/interstitial/interstitial.ts`, `app/desktop/src/welcome/welcome.html` (+ any desktop test asserting the hint), `README.md` line 17, `docs/site/install.md` legacy-formula note, comments in `app/backend/cmd/rk/agent_hook.go` and `app/backend/cmd/rk/serve.go`; run Go tests (`env -u TMUX -u TMUX_PANE go test ./...`) and the desktop unit tests <!-- R5 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: The template declares `class Hexokit < Formula` with the four-name install block identical to the tap's `Formula/hexokit.rb` and a test asserting `hexokit version` for hexokit/rk/xk/run-kit
- [x] A-002 R2: release.yml writes and stages `Formula/hexokit.rb` and commits `hexokit ${version}`; no reference to `Formula/run-kit.rb` remains
- [x] A-003 R3: `IsBrewInstalled` is true for both `/Cellar/hexokit/` and `/Cellar/run-kit/` paths and false for non-Cellar paths
- [x] A-004 R4: `rk update` brew calls target `sahil87/tap/hexokit`; not-brew guidance and the `/api/update` 409 name `brew install sahil87/tap/hexokit`
- [x] A-005 R5: Desktop interstitial + welcome, README, and install guide name the `hexokit` formula

### Behavioral Correctness

- [x] A-006 R3: `StableFor` maps a hexokit Cellar path to `<prefix>/bin/hexokit` and a run-kit Cellar path to `<prefix>/bin/run-kit`, with a unit test for each
- [x] A-007 R4: An upgrade-path test with a `/Cellar/hexokit/` executable restarts the daemon from `<prefix>/bin/hexokit`

### Scenario Coverage

- [x] A-008 R4: The `/api/update` self-update path accepts a `/Cellar/hexokit/` binary as brew-installed (test)

### Edge Cases & Error Handling

- [x] A-009 R3: Dev-build / non-Cellar paths remain non-brew and pass through `StableFor` unchanged

### Code Quality

- [x] A-010 Pattern consistency: New code follows naming and structural patterns of surrounding code
- [x] A-011 No unnecessary duplication: The keg-name set lives only in `internal/selfpath`; callers do not re-derive Cellar markers
- [x] A-012 No magic strings: keg names and formula refs are named constants where they recur
- [x] A-013 Comments state constraints, not narration or change IDs
- [x] A-014 Substrate untouched: no `RK_*`, `@rk_*`, `rk-*`, Go module, tarball name, or launcher-name changes

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Keg set is ordered `hexokit` then `run-kit`; first match wins | A path can only contain one Cellar keg; order documents primacy | S:80 R:90 A:85 D:85 |
| 2 | Certain | `IsBrewInstalled`/`StableFor` signatures unchanged | Callers and seams (`resolveExeFn`, `resolveSelfPathFn`) need no churn | S:90 R:90 A:90 D:90 |
| 3 | Confident | User-facing product name in update guidance becomes `hexokit` where it said `run-kit` | Public brand per plan rules; command examples keep `rk` (D2) | S:75 R:90 A:80 D:80 |

3 assumptions (1 certain, 2 confident, 0 tentative).
