# Plan: HexoKit Repo URL Sweep

**Change**: 260928-n031-hexokit-repo-url-sweep
**Intake**: `intake.md`

## Requirements

### Repo links: README badges

#### R1: Badge row targets sahil87/hexokit
The README badge row (line 5) SHALL reference `sahil87/hexokit` in every shields.io badge image URL and every link target (release, downloads, stars). No other README line SHALL change.

- **GIVEN** the README badge row
- **WHEN** it is rendered on GitHub or any mirror
- **THEN** the release/downloads/stars badges query `sahil87/hexokit` and link to `github.com/sahil87/hexokit/releases` / `/stargazers`

### Repo links: desktop package metadata

#### R2: Desktop homepage targets sahil87/hexokit
`app/desktop/package.json` `homepage` SHALL be `https://github.com/sahil87/hexokit`; the file SHALL remain valid JSON with no other field changed.

- **GIVEN** the desktop package manifest
- **WHEN** electron-builder or any tooling reads `homepage`
- **THEN** it gets `https://github.com/sahil87/hexokit`

### Repo links: Homebrew formula template

#### R3: Formula homepage and download URLs target sahil87/hexokit
`.github/formula-template.rb` SHALL set `homepage "https://github.com/sahil87/hexokit"` and all four `url` lines SHALL be `https://github.com/sahil87/hexokit/releases/download/v#{version}/rk-<os>-<arch>.tar.gz`, keeping the `rk-*` tarball names, the `#{version}` interpolation, and every placeholder (`VERSION_PLACEHOLDER`, `SHA_*`) unchanged.

- **GIVEN** the release workflow renders the template into `Formula/hexokit.rb`
- **WHEN** a user runs `brew info` / `brew install sahil87/tap/hexokit`
- **THEN** the homepage shows `github.com/sahil87/hexokit` and the tarball downloads straight from `sahil87/hexokit` releases without a rename redirect

### Non-Goals

- Other `sahil87/run-kit` mentions (README raw image/blob links, `internal/desktop` `DefaultRepo`, `internal/push` `vapidSubscriber`, frontend doc-link constants, `docs/site` back-links, tests, `docs/memory`, `fab/` history) — outside the operator-scoped R2(d) surfaces
- `go.mod` module path and any `RK_*` / `@rk_*` / `rk-*` identifier — substrate (D2)
- The plan doc R2 row — owned by the operator, touched by parallel R2(b)/(c) agents

## Tasks

### Phase 2: Core Implementation

- [x] T001 [P] Swap `sahil87/run-kit` → `sahil87/hexokit` on the badge row (line 5) of `README.md` only <!-- R1 -->
- [x] T002 [P] Update `homepage` in `app/desktop/package.json` to `https://github.com/sahil87/hexokit` <!-- R2 -->
- [x] T003 [P] Update `homepage` and the four release-download `url` lines in `.github/formula-template.rb` to `sahil87/hexokit` <!-- R3 -->

### Phase 3: Integration & Edge Cases

- [x] T004 Verify: `git grep sahil87/run-kit` returns nothing in `.github/formula-template.rb` / `app/desktop/package.json` and only non-badge lines in `README.md`; `jq . app/desktop/package.json` parses; `ruby -c .github/formula-template.rb` passes when ruby is available; the diff touches only the seven intended lines <!-- R3 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: README line 5 names `sahil87/hexokit` in all three badge images and all three link targets, with no `sahil87/run-kit` left on that line
- [x] A-002 R2: `app/desktop/package.json` `homepage` is `https://github.com/sahil87/hexokit` and the file parses as JSON
- [x] A-003 R3: `.github/formula-template.rb` has zero `sahil87/run-kit` occurrences; homepage and all four download URLs name `sahil87/hexokit`

### Edge Cases & Error Handling

- [x] A-004 R3: Tarball names (`rk-darwin-arm64`, `rk-darwin-amd64`, `rk-linux-arm64`, `rk-linux-amd64`), `#{version}` interpolation, and every `VERSION_PLACEHOLDER` / `SHA_*` placeholder are byte-identical to before, so `release.yml`'s substitution still works
- [x] A-005 R1: No README line other than line 5 changed

### Code Quality

- [x] A-006 Pattern consistency: URL form matches the existing badge/formula shapes exactly (only the repo path segment differs)
- [x] A-007 No unnecessary duplication: N/A-shaped change — pure string swaps, no new code
- [x] A-008 Scope discipline: diff touches exactly three files, none of them substrate identifiers, tests, memory, or the plan doc

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | No test changes needed | No code path reads these three strings; release.yml substitutes placeholders only (verified: line 167 renders the template via sed on placeholders) | S:90 R:90 A:90 D:90 |
| 2 | Confident | Verification is grep + JSON/ruby syntax checks, not a test suite run | Pure string edits in non-code files; the Go/Vitest suites cannot observe them | S:80 R:90 A:85 D:85 |

2 assumptions (1 certain, 1 confident, 0 tentative).
