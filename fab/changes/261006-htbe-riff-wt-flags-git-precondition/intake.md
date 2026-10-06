# Intake: rk riff — wt v0.1.7 flag names + git-repo precondition

**Change**: 261006-htbe-riff-wt-flags-git-precondition
**Created**: 2026-10-06

## Origin

Conversational — a `/fab-discuss` session. The user reported:

> Go this error in rk riff:
>
> ```
> ❯ rk riff
> run-kit riff: wt create failed: exit status 3
> Flag --worktree-open has been deprecated, use --open instead
> ```
>
> Can you ensure we are working fine with the latest version of wt?

Investigation (in-session, reproduced against the installed `wt v0.1.7`):

- The deprecated flags are **not** the cause. In a git repo, `wt create --non-interactive --worktree-open skip` and `wt create --worktree-name bar --non-interactive --open skip` both print a `Flag --worktree-… has been deprecated, use --… instead` line and **exit 0** with a normal `Path:` line.
- Exit status 3 is wt's `ExitGitError` (`src/internal/worktree/errors.go` in sahil87/wt: `ExitGitError = 3`), raised by `wt create`'s `ValidateGitRepo` check. Reproduced from a non-git directory:

  ```
  Flag --worktree-open has been deprecated, use --open instead
  Error: Not a git repository
    Why: This command requires a git repository
    Fix: Navigate to a git repository and try again
  exit=3
  ```

  The user's paste omitted the `Error:` lines, so the deprecation warning read as the cause.
- The user confirmed they ran `rk riff` **from outside a git repo**.
- `--name`/`-n` and `--open`/`-o` were introduced in wt's "Intuitive Flag Names" change (wt #36, 2026-07-18), first tagged **v0.1.0**; the old names have been `MarkDeprecated` aliases since then. Switching costs nothing for any wt ≥ v0.1.0.

The agent proposed three changes; the user replied "yes proceed for all 3".

## Why

1. **Unhelpful failure outside a repo.** With no `--repo` and a non-git cwd, `riffRepoRoot()` (`app/backend/cmd/rk/riff.go:404`) returns `""` (`config.FindGitRoot` walks up and finds no `.git`) and tolerates it ("empty tolerated, as before"). The engine then runs `wt create` in the inherited cwd and wraps the failure as `run-kit riff: wt create failed: exit status 3` (`SubprocessErr`, exit 3). The real reason only shows in wt's output, and the deprecation warning printed first hides it. The CLI can detect this before calling any subprocess, and should, with an actionable message.
2. **Deprecated wt flags.** `buildWtCreateArgs` (`app/backend/internal/riff/riff.go:577`) emits `--worktree-name` and `--worktree-open skip`. Every successful `rk riff` therefore carries a deprecation line in its captured output, and riff will break outright once wt drops the aliases. User-facing docs and help text also teach `--worktree-name` as the passthrough example, steering users toward a deprecated flag.
3. **Why fail fast in the CLI rather than improve the wt error wrapping:** the condition is fully knowable before any subprocess runs (`repoRoot == ""`). It is an operational precondition of the same kind as "`$TMUX` unset" and "`wt` not on PATH", which `checkPreconditions` already owns (exit 1, `ExitPrecondition`). Parsing wt's stderr to rewrite the message was rejected as brittle.

## What Changes

### 1. wt create argv — new flag names (`app/backend/internal/riff/riff.go`)

`buildWtCreateArgs(spec, passthrough)` changes from:

```go
argv := []string{"create"}
if spec.Where != whereCheckout && spec.WorktreeName != "" {
    argv = append(argv, "--worktree-name", spec.WorktreeName)
}
argv = append(argv, "--non-interactive", "--worktree-open", "skip")
return append(argv, passthrough...)
```

to:

```go
argv := []string{"create"}
if spec.Where != whereCheckout && spec.WorktreeName != "" {
    argv = append(argv, "--name", spec.WorktreeName)
}
argv = append(argv, "--non-interactive", "--open", "skip")
return append(argv, passthrough...)
```

Use the long forms (`--name`, `--open`), not `-n`/`-o`, so the argv stays self-describing. Update the doc comments on `buildWtCreateArgs` (line ~571) and `runWtCreate` (line ~586), plus the `Options`/`EffectiveSpec` `WorktreeName` field comments (lines ~139 and ~178) that say `wt create --worktree-name`.

`runWtDelete` (`wt delete --non-interactive <name>`) is unchanged: `--non-interactive` is still current in wt v0.1.7.

### 2. Git-repo precondition in the CLI (`app/backend/cmd/rk/riff.go`)

The `rk riff` CLI is worktree-only: it never sets `Where`, so it always runs `wt create`. Checkout mode and the same-worktree fork live on the HTTP/MCP `riff.Spawn` path, which always passes an explicit `RepoRoot`, so they are untouched.

Extend `checkPreconditions` so it also receives the resolved `repoRoot`, and fail when it is empty. Keep the fast-fail order **`$TMUX` → `wt` on PATH → git repo**:

```go
func checkPreconditions(server, repoRoot string) error {
    if server == "" && tmux.OriginalTMUX == "" { ... }          // unchanged
    if _, err := exec.LookPath("wt"); err != nil { ... }        // unchanged
    if repoRoot == "" {
        return &riff.ExitCodeError{Code: riff.ExitPrecondition, Msg: "run-kit riff: not inside a git repository — cd into a repo or pass --repo <path>"}
    }
    return nil
}
```

- Exit code **1** (`ExitPrecondition`), the same class as the other CLI preconditions. Under `--json` it yields the existing `operational` error envelope through `runRiffWithExitCode`, with no new envelope code.
- No subprocess runs (no `wt`, no `tmux`, no `fab agent`) when the precondition fires. Today `riff.ResolveAgent(ctx, repoRoot, "")` runs at Step 5, after preconditions, so it is also skipped.
- `--list-presets` still short-circuits **before** preconditions, so it keeps working outside a repo.
- `--repo` behavior is unchanged: a non-toplevel `--repo` is still a usage error (exit 2) from `riffRepoRoot()`. A valid `--repo` makes `repoRoot` non-empty, so this precondition never fires for it.
- Update `riffRepoRoot`'s doc comment, which says "empty tolerated, as before — the engine then runs subprocesses in the inherited cwd". After this change, an empty root is rejected by `checkPreconditions`.
- Update the command's `Long` help:
  - **Prerequisites:** add a bullet such as `- You must be inside a git repository (or pass --repo <path>).`
  - **Exit codes:** change `1  precondition failure ($TMUX unset, wt not found)` to `1  precondition failure ($TMUX unset, wt not found, not in a git repository)`.
- Update the `checkPreconditions` doc comment to list the third check.

### 3. References to the old flag names

| File | Location | Change |
|------|----------|--------|
| `app/backend/cmd/rk/riff.go` | `Long` help, ~line 76 | `wt create (e.g., --worktree-name, --base, --reuse)` → `wt create (e.g., --name, --base, --reuse)` |
| `app/backend/cmd/rk/riff.go` | `Long` examples, ~line 116 | `run-kit riff -- --worktree-name pacing-canyon` → `run-kit riff -- --name pacing-canyon` (keep column alignment of the `#` comments) |
| `app/backend/internal/riff/riff_test.go` | `TestBuildWtCreateArgs` (~lines 513–546) | Expected argv → `create [--name <n>] --non-interactive --open skip [...]`; update the test's doc comment (`--worktree-name passthrough`) |
| `app/backend/internal/validate/validate.go` | line ~436 comment on `ValidateWorktreeName` | `wt create --worktree-name` → `wt create --name`. The leading-hyphen rejection stays; it is still correct |
| `README.md` | line 94 | `(e.g. \`--base\`, \`--worktree-name\`)` → `(e.g. \`--base\`, \`--name\`)` |
| `docs/site/workflows.md` | line ~92 | `rk riff -- --worktree-name pacing-canyon   # name the worktree` → `rk riff -- --name pacing-canyon   # name the worktree` |

Grep sweep at apply time: `grep -rn -e worktree-name -e worktree-open` over `app/`, `scripts/`, `README.md`, `docs/site/`. Leave historical records alone: `docs/memory/run-kit/log.md`, `log.seed.md`, `fab/changes/**` intakes, and archives.

Any other tests that assert the wt argv, such as stub `wt` scripts logging `$*` in `cmd/rk/riff_test.go` (`TestRiffPassthroughBoundary`) or `internal/riff/deliver_test.go`, must be checked and updated if they pin the old flag strings.

### 4. Tests

- `TestBuildWtCreateArgs`: updated expectations (above).
- New CLI test for the git-repo precondition. In `cmd/rk/riff_test.go`, run `rk riff` with a non-git cwd (a `t.TempDir()` outside any repo; `t.Chdir` or the existing RK_RIFF_SUBPROC re-exec pattern used by `TestRiffJSONPreconditionEnvelope`), `$TMUX` satisfied or `-L` given, and a stub `wt` on PATH that fails the test if invoked. Assert:
  - exit code 1 (`ExitPrecondition`);
  - the message contains `not inside a git repository` and mentions `--repo`;
  - `wt` was not invoked.
  A `--json` variant asserting the `operational` envelope is welcome if cheap, mirroring `TestRiffJSONPreconditionEnvelope`.
- Check that the existing CLI tests (`TestRiffTargetingFlagsJSONReceipt`, `TestRiffPassthroughBoundary`, `TestRiffFanOutFlagRejected`, `TestRiffCountShortForm`) still pass. Any that run with a non-git cwd and no `--repo` now hit the new precondition and must pass `--repo` or run from a git dir. Fix the test setup, not the implementation (Constitution: Test Integrity).
- Run via `just test-backend`.

## Affected Memory

- `run-kit/rk-riff`: (modify) § Worktree-Name Passthrough: the flag becomes `--name` and the argv `wt create [--name <n>] --non-interactive --open skip <passthrough…>`; rename the section heading from `(\`--worktree-name\`)` to `(\`--name\`)`. § Workflow Step Order step 2 (Preconditions): add "inside a git repository (resolved repo root non-empty)" to the `$TMUX` → `wt` order, still exit 1, CLI-only. Exit-code table row `1 / —`: add "not in a git repository". `--repo` flag row: note that without `--repo`, a non-git cwd is now a precondition failure rather than being tolerated.

## Impact

- **Code:** `app/backend/internal/riff/riff.go` (argv builder + comments), `app/backend/cmd/rk/riff.go` (precondition, help text, comments), `app/backend/internal/validate/validate.go` (comment only).
- **Tests:** `app/backend/internal/riff/riff_test.go`, `app/backend/cmd/rk/riff_test.go`, plus any stub-`wt` argv assertions found by the sweep.
- **Docs:** `README.md`, `docs/site/workflows.md` (Toolkit Standards: CLI help/README/docs-site edits are covered by `shll standards`; these are wording-only flag-name updates).
- **Unaffected:** the HTTP `POST /api/riff` handler and MCP `riff` tool (they pass explicit `RepoRoot`/`--repo`), checkout mode, the fork endpoint, and `wt delete` rollback.
- **Compatibility:** requires wt ≥ v0.1.0 (where `--name`/`--open` were added, 2026-07-18). Users on a pre-v0.1.0 wt would get an unknown-flag failure. Accepted: v0.1.0 is months old and wt self-updates via `wt update`/Homebrew.
- **User passthrough:** tokens after `rk riff --` are still forwarded verbatim. A user passing `--worktree-name` there still sees wt's deprecation warning, and rk deliberately does not rewrite passthrough.

## Open Questions

- None blocking.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Root cause of the reported error is the non-git cwd (wt `ExitGitError` 3), not the deprecated flag | Reproduced in-session: old flags exit 0 in a repo; non-git cwd exits 3 with "Not a git repository"; user confirmed they ran from outside a repo | S:95 R:90 A:95 D:95 |
| 2 | Certain | Do all three: migrate flags, add a fail-fast git precondition, update references | Discussed — user: "yes proceed for all 3" | S:95 R:85 A:90 D:95 |
| 3 | Certain | Use `--name` / `--open skip` (long forms) | `wt create --help` on v0.1.7 lists `-n, --name` and `-o, --open`; long forms keep argv self-describing | S:90 R:90 A:90 D:85 |
| 4 | Confident | The git-repo check is a CLI precondition in `checkPreconditions`, exit 1 (`ExitPrecondition`), ordered after `$TMUX` and `wt` | Same operational class as the existing CLI preconditions; the engine has no precondition step and the daemon path always supplies RepoRoot | S:80 R:85 A:85 D:75 |
| 5 | Confident | Error message: `run-kit riff: not inside a git repository — cd into a repo or pass --repo <path>` | Proposed in discussion, unopposed; mirrors the `$TMUX` precondition's phrasing ("— start tmux first (or pass -L …)") | S:75 R:95 A:85 D:70 |
| 6 | Confident | Checkout mode / fork are unaffected: they run only via `riff.Spawn` (HTTP/MCP), which always passes an explicit RepoRoot | Memory `rk-riff.md`: "The CLI is worktree-only … never sets `Where`"; `Spawn` requires `opts.RepoRoot` | S:85 R:90 A:90 D:85 |
| 7 | Confident | Do not rewrite user passthrough tokens (`--worktree-name` after `--` stays verbatim) | Passthrough is documented as verbatim; rewriting would be a hidden translation layer | S:70 R:90 A:85 D:80 |
| 8 | Confident | No minimum-wt-version gate needed | `--name`/`--open` exist since wt v0.1.0 (2026-07-18); verified via wt git history | S:75 R:80 A:80 D:80 |
| 9 | Certain | Historical records (memory `log.md`/`log.seed.md`, prior change intakes, archives) are not edited | They record history, not present truth | S:90 R:95 A:95 D:95 |
| 10 | Confident | `--list-presets` keeps working outside a git repo | It already short-circuits before `checkPreconditions`; listing presets is not repo-scoped | S:80 R:95 A:90 D:85 |

10 assumptions (4 certain, 6 confident, 0 tentative, 0 unresolved).
