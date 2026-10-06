# Plan: rk riff — wt v0.1.7 flag names + git-repo precondition

**Change**: 261006-htbe-riff-wt-flags-git-precondition
**Intake**: `intake.md`

## Requirements

### run-kit/rk-riff: wt create argv

#### R1: Current wt create flag names
`buildWtCreateArgs` (`app/backend/internal/riff/riff.go`) SHALL emit `--name <n>` (worktree mode, non-empty `WorktreeName`) and `--open skip` instead of the deprecated `--worktree-name` / `--worktree-open` aliases, using the long forms. The argv shape MUST be `create [--name <n>] --non-interactive --open skip <passthrough…>`. Comments describing this argv (`Options.WorktreeName`, `EffectiveSpec.WorktreeName`, the `Spawn` isolation doc, `buildWtCreateArgs`, `runWtCreate`) MUST name the new flags. `buildWtDeleteArgs` is unchanged.

- **GIVEN** an `EffectiveSpec` in worktree mode with `WorktreeName: "my-agent"` and passthrough `--base main`
- **WHEN** `buildWtCreateArgs` runs
- **THEN** it returns `create --name my-agent --non-interactive --open skip --base main`

- **GIVEN** an empty `WorktreeName` (or checkout mode)
- **WHEN** `buildWtCreateArgs` runs
- **THEN** it returns `create --non-interactive --open skip` with no `--name` element

### run-kit/rk-riff: CLI preconditions

#### R2: Git-repository precondition
The `rk riff` CLI SHALL fail fast with `ExitPrecondition` (exit 1) and the message `run-kit riff: not inside a git repository — cd into a repo or pass --repo <path>` when the resolved repo root is empty (no `--repo`, non-git cwd). The check MUST live in `checkPreconditions` (`app/backend/cmd/rk/riff.go`), ordered after `$TMUX` and `wt`-on-PATH, and MUST run before any subprocess (`wt`, `tmux`, `fab agent`). `--list-presets` MUST still short-circuit before preconditions. Under `--json` the failure MUST yield the existing `operational` error envelope. Help text (`Prerequisites`, `Exit codes`) and the `checkPreconditions` / `riffRepoRoot` / file-header / `runRiff` step-list comments MUST reflect the new check.

- **GIVEN** a non-git cwd, no `--repo`, `-L scratch` (waives `$TMUX`), and `wt` on PATH
- **WHEN** `rk riff` runs
- **THEN** it returns `ExitCodeError{Code: ExitPrecondition}` whose message names "not inside a git repository" and `--repo`
- **AND** `wt` is never invoked

- **GIVEN** the same setup with `--json`
- **WHEN** `rk riff` runs as a process
- **THEN** it exits 1 and stdout carries one `ok:false` envelope with code `operational` naming the precondition

- **GIVEN** `$TMUX` unset and no `-L`, in a non-git cwd
- **WHEN** `rk riff` runs
- **THEN** the `$TMUX` precondition fires first (order preserved)

### run-kit/rk-riff: References

#### R3: Old flag names removed from present-truth references
User-facing help, README, docs-site, and code comments SHALL teach `--name` instead of `--worktree-name` for `wt create`: the `Long` passthrough sentence and example in `app/backend/cmd/rk/riff.go`, `README.md` line ~94, `docs/site/workflows.md` line ~92, and the `ValidateWorktreeName` comment in `app/backend/internal/validate/validate.go`. Historical records (`docs/memory/**/log*.md`, `fab/changes/**`) and the `wt delete` deprecation notes (still accurate — `wt delete --worktree-name` remains deprecated) MUST NOT change.

- **GIVEN** the change is applied
- **WHEN** `grep -rn -e worktree-name -e worktree-open` runs over `app/`, `scripts/`, `README.md`, `docs/site/`
- **THEN** the only hits are the `wt delete` deprecation notes (`buildWtDeleteArgs` comment and `TestBuildWtDeleteArgs`) and the unrelated e2e window-name string

### Non-Goals

- Rewriting user passthrough tokens (`rk riff -- --worktree-name x` still forwards verbatim) — passthrough is documented as verbatim
- A minimum-wt-version gate — `--name`/`--open` exist since wt v0.1.0
- Any change to the HTTP/MCP `riff.Spawn` path, checkout mode, or fork — they always pass an explicit `RepoRoot`

### Design Decisions

#### Git-repo check is a CLI precondition, not wt-error rewriting
**Decision**: Reject an empty resolved repo root in `checkPreconditions` (exit 1), before any subprocess.
**Why**: The condition is fully knowable up front and is the same operational class as `$TMUX` unset / `wt` missing; the engine has no precondition step and the daemon path always supplies `RepoRoot`.
**Rejected**: Parsing wt's stderr to rewrite its `exit status 3` failure — brittle and couples rk to wt's message text.
*Introduced by*: 261006-htbe-riff-wt-flags-git-precondition

## Tasks

### Phase 2: Core Implementation

- [x] T001 Switch `buildWtCreateArgs` to `--name` / `--open skip` and update the argv comments in `app/backend/internal/riff/riff.go` (`Options`/`EffectiveSpec` `WorktreeName`, `Spawn` isolation doc, `buildWtCreateArgs`, `runWtCreate`); update `TestBuildWtCreateArgs` expectations + doc comment in `app/backend/internal/riff/riff_test.go` <!-- R1 -->
- [x] T002 Add the git-repo check to `checkPreconditions(server, repoRoot)` in `app/backend/cmd/rk/riff.go`, pass `repoRoot` at the call site, and update the file-header, `runRiff` step list, `riffRepoRoot`, and `checkPreconditions` comments plus the `Long` help `Prerequisites` and `Exit codes` <!-- R2 -->
- [x] T003 Add CLI tests in `app/backend/cmd/rk/riff_test.go`: in-process `runRiff` from a non-git temp cwd with `-L scratch` and a stub `wt` that records invocation (assert exit 1, message, wt not run), plus a `--json` re-exec variant asserting the `operational` envelope <!-- R2 -->

### Phase 4: Polish

- [x] T004 [P] Replace `--worktree-name` with `--name` in `app/backend/cmd/rk/riff.go` `Long` help (passthrough sentence + example, keeping `#` alignment), `app/backend/internal/validate/validate.go` `ValidateWorktreeName` comment, `README.md`, and `docs/site/workflows.md`; add the git-repo requirement to the README and docs-site Prerequisites, a README Troubleshooting entry, and the `ExitPrecondition` comments in `app/backend/internal/riff/riff.go`; check the help/README/docs edits against `shll standards` <!-- R3 -->
- [x] T005 Run `go test ./internal/riff/ ./cmd/rk/ ./internal/validate/` then `just test-backend`, and the grep sweep from R3 <!-- R1 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `buildWtCreateArgs` emits `create [--name <n>] --non-interactive --open skip <passthrough…>`; no `--worktree-name`/`--worktree-open` token remains in the create argv
- [x] A-002 R2: `checkPreconditions` rejects an empty repo root with `ExitPrecondition` and the specified message, after the `$TMUX` and `wt` checks
- [x] A-003 R3: Help text, README, docs-site, and the validate comment name `--name`; the grep sweep shows only the allowed hits

### Behavioral Correctness

- [x] A-004 R2: `--list-presets` still works outside a git repo (short-circuits before preconditions); a valid `--repo` still bypasses the new check
- [x] A-005 R2: Help `Exit codes` row 1 lists "not in a git repository"; `Prerequisites` lists the git-repo requirement

### Scenario Coverage

- [x] A-006 R1: `TestBuildWtCreateArgs` covers no-name, name, name+passthrough, and checkout-ignores-name with the new flags
- [x] A-007 R2: A CLI test asserts exit 1, the message (naming `--repo`), and that `wt` was not invoked; a `--json` variant asserts the `operational` envelope

### Edge Cases & Error Handling

- [x] A-008 R2: No subprocess (`wt`, `tmux`, `fab`) runs when the git-repo precondition fires
- [x] A-009 R3: `wt delete` deprecation notes and historical records are untouched

### Code Quality

- [x] A-010 Pattern consistency: The new precondition mirrors the existing `checkPreconditions` branches (same `riff.ExitCodeError` shape, `run-kit riff:` message prefix)
- [x] A-011 No unnecessary duplication: Tests reuse `chdir`, `testutil.WriteStub`, and the `RK_RIFF_SUBPROC` re-exec pattern
- [x] A-012 New features and bug fixes include tests covering the changed behavior
- [x] A-013 Comment narration: New/edited comments state constraints, not history or change IDs
- [x] A-014 Subprocess calls keep `exec.CommandContext` with timeouts (no new subprocess paths introduced)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change swaps deprecated flag names and adds a precondition; no existing code was made redundant or unused

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Leave the `buildWtDeleteArgs` comment and `TestBuildWtDeleteArgs` `--worktree-name` mentions as-is | `wt delete --help` on v0.1.7 still lists `--worktree-name (deprecated)`; the notes describe the delete path accurately | S:85 R:95 A:95 D:90 |
| 2 | Confident | Test the precondition in-process via `runRiff` with `-L scratch` (waives `$TMUX`) and a non-git temp cwd, plus a re-exec `--json` variant | Mirrors `TestRiffPassthroughBoundary` and `TestRiffJSONPreconditionEnvelope`; `-L` keeps the test independent of whether the suite runs in tmux | S:80 R:90 A:85 D:75 |
| 3 | Confident | Update the `Spawn` isolation doc comment (`riff.go` ~228) too, though the intake's list omits it | It describes the same create argv (`optionally --worktree-name`); R3's grep sweep would flag it | S:75 R:95 A:90 D:85 |
| 4 | Confident | Extend R3's reference sweep to the README/docs-site Prerequisites, a README Troubleshooting entry, and the `ExitPrecondition` constant comments | Present-truth listings of riff's preconditions/exit-1 class would otherwise be stale; the troubleshooting entry targets the exact confusion in the original report | S:70 R:95 A:85 D:80 |

4 assumptions (1 certain, 3 confident, 0 tentative).
