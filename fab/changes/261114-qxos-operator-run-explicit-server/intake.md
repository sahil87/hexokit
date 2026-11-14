# Intake: Operator Run Explicit Server

**Change**: 261114-qxos-operator-run-explicit-server
**Created**: 2026-11-14

## Origin

> Operator runs on a non-default tmux server hit 'tmux socket error' on rk mux capture (loom run 20261114T111009-e2mv, logs under ~/.local/state/hexokit/operator/runs/tmp-tmux--1000-loom/). Fix: (1) have the run brief's rk mux/rk operator commands pass -L <server> explicitly, (2) make the run log record tool output and error text so a failure like this is diagnosable, (3) check whether the headless launcher (rk operator run-exec, claude -p) loses TMUX or the socket path and fix that if so. Also the run said the tracker had no step6a item though its brief listed it; check whether a run can read a stale or wrong ledger. Relevant code: app/backend/internal/operatorloop/runner.go, app/backend/cmd/rk/operator_run_exec.go, internal/operator (RenderBrief).

Started with `/fab-new` (one-shot). Before writing this intake the agent investigated the run's files and the code and confirmed the root cause (below). It asked the user one question, about how fix (2) should capture tool output. **The user chose "rk self-logs"**: `rk operator run-exec` exports a run-log env var to the launcher, and every `rk` invocation inside the run appends its argv, exit code and stderr to the run log. The alternatives were rejected: `--output-format stream-json` rendering for Claude launchers (Claude-only, and it breaks the provider-opaque launcher rule), both together (largest change), and a brief-contract-only rule (depends on the model complying).

### Investigation findings (evidence)

Run files under `~/.local/state/hexokit/operator/runs/tmp-tmux--1000-loom/`:

- `20261114T111009-e2mv.json`: `server: loom`, `changed: [step6a]`, `exit_code: 0`, outcome `"step6a idle with no commits or PR yet; pane capture failed (tmux socket error) and the tracker has no step6a item, so no note or send was possible; user notified, step6b stays held."`
- `20261114T111009-e2mv.log`: only the model's final prose and the `outcome:` line, 325 bytes. It holds **no** tool call, command or error text, because plain `claude -p` prints only its final message, so the actual `rk mux capture` error is lost.
- `20261114T111009-e2mv.brief.md`: the header says `server: loom`, but every command in Rules / Interim autopilot / Exit contract is bare (`rk mux capture <pane> …`, `rk operator track list --json`, `rk operator track note <id> … --by run`) with no `-L`.
- `~/.local/state/hexokit/operator/default.yaml.lock` has mtime **2026-11-14 11:10:25 UTC**, inside the run's 11:10:09–11:10:31 window. There is no `default.yaml`, and no tmux server named `default` exists (`/tmp/tmux-1000/` holds `code fab_kit hexokit hexokit2 loom rk-daemon`). **This proves the run's `rk operator track …` calls resolved to the `default` ledger, not loom's.**

### Root cause chain

1. `internal/tmux/tmux.go` `init()` runs `os.Unsetenv("TMUX")` process-wide in every rk binary. The original value is saved in `tmux.OriginalTMUX`.
2. The run window lives on the loom server (`_rk-operator` session), so the pane's environment has `TMUX=/tmp/tmux-1000/loom,…`. The wrapper `rk operator run-exec` is an rk binary, so `TMUX` is stripped from its process env on start.
3. `operatorloop.Exec` → `runLauncher` builds `exec.CommandContext(ctx, opts.Argv[0], …)` and **never sets `cmd.Env`**, so the launcher (`sh -c 'claude -p …'`) inherits the stripped env. **The headless launcher loses `TMUX`** (fix 3 is confirmed necessary).
4. Inside the run, bare `rk mux capture %27` → `muxServer()` (`cmd/rk/mux.go:154`) sees no `$TMUX` and resolves to `"default"`. No `default` server is running, so the capture fails ("tmux socket error").
5. Bare `rk operator track list --json` / `track note` → `operatorServer()` (`cmd/rk/operator_track.go:338`) → `cliServerLabel("")` = `"default"` → `operatorStateTarget` → `operator.StatePath(operator.ServerSocketPath(ctx, "default"))`. The socket query fails, so `ServerSocketPath` returns `""` → `cron.FabOperatorSlug("")` = `default` → `default.yaml`. The file is missing, so `Load` returns an empty state, and the run concludes "the tracker has no step6a item". **So yes, a run can read the wrong ledger:** the CLI path silently falls back to the `default` slug when the socket path is unknown, while the daemon path (`operatorloop/record.go` `statePathFn`) correctly refuses (`"tmux socket path for server %q unavailable"`). The ledger was not stale. It was a different server's ledger.

## Why

The operator loop exists to act unattended on non-default servers (loom is a real one). Today **every run on a non-default server is blind**. It can't capture or send to panes. It reads an empty ledger. Its `track note` exit-contract writes either fail or land in `default.yaml`, so they vanish from the real ledger. The run still exits 0 with a plausible `outcome:`, so the wrapper's failure-note contract never fires and the loop looks healthy. If nothing changes:

- Queues on non-default servers never advance from runs (no spawns, no answers, no nudges).
- Notes that runs think they wrote are lost or misfiled, which corrupts the "notes are the memory" contract the next run relies on.
- When something does go wrong, the run log can't tell anyone why: 325 bytes of prose and no error text.

Fixes are layered on purpose:

- **(3) env restore** fixes the root cause for every bare command, including tools rk doesn't own that rely on `$TMUX` (`fab pane map --all-sessions`, any bare `tmux`).
- **(1) explicit `-L`** in the brief removes the run's dependence on ambient env, so a future env regression can't silently retarget a run.
- **(4) no silent `default` fallback** for a named server turns a wrong-ledger read into a loud error.
- **(2) rk self-logging** makes the next failure of this kind diagnosable from the run log alone.

Any one layer alone leaves a silent-failure path.

## What Changes

### 1. Launcher environment keeps the run's tmux server (`internal/operatorloop/exec.go`)

`runLauncher` SHALL set `cmd.Env` to the process env with the captured `TMUX` restored, following the existing `cliChildEnv` pattern (`cmd/rk/agent_kickoff.go:67`), which restores `tmux.OriginalTMUX` because `internal/tmux`'s `init()` strips it:

```go
env := os.Environ()
if tmux.OriginalTMUX != "" {
    env = append(env, "TMUX="+tmux.OriginalTMUX)
}
env = append(env, operatorloop.RunLogEnv+"="+logPath) // see §3
cmd.Env = env
```

`internal/operatorloop` already imports `internal/tmux`. The helper may be shared or duplicated per code-quality's owner rule. The apply agent decides, preferring a single owner if `cliChildEnv` can move to a package both can import without a cycle.

The wrapper SHALL write one diagnostic header line to the run log (and the window) before starting the launcher, so a run log always records what the launcher was handed:

```
run-exec: server=loom run=20261114T111009-e2mv tmux=/tmp/tmux-1000/loom cwd=/home/sahil launcher=sh -c claude -p --dangerously-skip-permissions
```

(`tmux=` shows only the socket part of `TMUX`, before the first comma, or `unset`.) When the socket basename of the restored `TMUX` does not match `--server` (`default` ↔ empty/`default`), the header line SHALL add ` WARNING: TMUX socket does not match --server`. This is not fatal, because the brief's explicit `-L` (§2) still targets the right server.

### 2. Brief commands carry `-L <server>` (`internal/operator/brief.go`, `brief_rules.md`, `brief_autopilot.md`)

Every server-addressed `rk` command in the rendered brief SHALL pass the run's server explicitly: `rk mux …`, `rk operator track …`, `rk operator brief`, `rk tab new …`, `rk riff …`. This covers the Rules section, the Interim autopilot section, and the Exit contract (`briefExitContract`'s `rk operator track note <id> "<text>" --by run`). `rk notify` takes no server and stays as is.

Mechanism: the embedded markdown files carry a placeholder token where the flag goes. `RenderBrief` substitutes the token with `-L <server>`, where `<server>` is `BriefInput.Server`, or `default` when empty (matching `writeBriefHeader`). Example rendered lines for server `loom`:

```
- Re-derive state before acting: the brief is a snapshot. Re-read an item with
  `rk operator track list -L loom --json` and a pane with `rk mux capture -L loom` before you act on either.
...
1. Classify: `rk mux capture -L loom <pane> --lines 40 --classify --json`.
...
    rk operator track note -L loom <id> "<text>" --by run
```

The Rules section SHALL also gain one rendered line near the top of "Role" or "Allowed tools":

> Every `rk mux`, `rk tab`, `rk riff` and `rk operator` command in this run passes `-L loom`, exactly as written here. Never drop it or rely on `$TMUX`.

Constraints:
- Output stays byte-identical for identical input (golden test `internal/operator/testdata/brief_golden.md` is regenerated).
- The rules+autopilot embedded files stay ≤ 40 960 bytes (existing test-enforced cap, measured on the raw files).
- The `-L` placement must parse for each verb. `-L/--server` is a persistent flag on `muxCmd` and `tabCmd`, a local flag on `riffCmd`, and `operatorServer` reads `server` for operator verbs. The apply agent verifies each rendered form actually parses (a test that runs each rendered command shape through cobra flag parsing is ideal).
- The static `rk skill operator` chat topic is session-agnostic and is NOT changed.
- `rk operator brief`'s manual render passes its resolved server through the same path, so `rk operator brief -L loom` shows the `-L loom` commands too.

### 3. rk self-logs into the run log (`cmd/rk/root.go` `execute()`, `internal/operatorloop`)

The user chose this design. The wrapper exports `RK_OPERATOR_RUN_LOG=<absolute path of <run-id>.log>` to the launcher (§1). When `RK_OPERATOR_RUN_LOG` is set, **every `rk` invocation** appends one record to that file when it finishes. That covers mux, operator, tab, riff, notify and any other verb, inherited by any child process of the run.

Record format (plain text, one block per invocation, appended with a single `O_APPEND` write so concurrent rk processes don't interleave mid-record):

```
--- rk 2026-11-14T11:10:20Z pid=12345 exit=1
argv: rk mux capture -L loom %27 --lines 40 --classify --json
stderr: tmux socket error: no server running on /tmp/tmux-1000/default
stdout: {"ok":false,"error":{"code":"…","message":"…"}}
```

Rules:
- `argv` is the full `os.Args` with `argv[0]` shown as `rk`, joined by `shellq` quoting so it can be copy-pasted.
- `exit` is the process's exit code (0 on success; `exitCode(err)` on failure). Hook it in `execute()` around `rootCmd.ExecuteC()` so every path goes through it, including usage errors and the JSON error envelope.
- `stderr` and `stdout` are tees of what the command wrote through cobra's streams (`rootCmd.SetErr`/`SetOut`; stdout already goes through `writeTracker`). Each is capped: stderr last 4 KiB, stdout last 2 KiB. A truncated stream is prefixed with `…[truncated]`, and an empty stream's line is omitted. Output written straight to `os.Stderr` (slog) that bypasses cobra streams is best-effort. The apply agent may also tee `os.Stderr` if that's simple and safe.
- Logging is **fail-silent**: an unopenable or unwritable path never changes rk's exit code or output. Paths must be absolute. A relative or empty value disables logging.
- The variable is only set by `run-exec`, so interactive rk use is unaffected. Name the constant once (e.g. `operatorloop.RunLogEnv = "RK_OPERATOR_RUN_LOG"`) and reference it from both sides. If importing `operatorloop` into `root.go` is undesirable, keep the constant in a small shared package instead.
- Long-running verbs (`rk serve`, `rk mux await`) log at exit like any other. Nothing special is needed, since `serve` never runs inside a run.

Combined with §1's header line, the e2mv failure would have shown its exact `rk mux capture` argv, the resolved-to-`default` server in the error text, and `tmux=unset` in the header.

### 4. No silent `default` ledger for a named server (`cmd/rk/operator_track.go` / `internal/operator/store.go`)

When the resolved server label is **not** `default` and its socket path cannot be queried (`operator.ServerSocketPath` returns `""`), `operatorStateTarget` SHALL fail with an operational error (exit 1). The message names the server and gives the cause, e.g. `tmux socket path for server "loom" unavailable (is the server running?)`. Today it silently resolves to `default.yaml`. This matches the daemon-side `operatorloop` `statePathFn` rule. The `default` label keeps today's fallback, so `rk operator track …` outside tmux with no default server still uses `default.yaml`, and the existing contract for plain-shell use is preserved. Apply this to every caller of `operatorStateTarget`: `rk operator track *` and `rk operator brief`. The `--state <path>` override on `rk operator brief` bypasses resolution and is unaffected.

### 5. Tests

- `internal/operatorloop/exec_test.go`: the launcher sees `TMUX` restored (stub launcher prints `printenv TMUX` and `RK_OPERATOR_RUN_LOG`). The header line is written to the log, and the mismatch warning appears when `TMUX` names another socket.
- `internal/operator/brief_test.go`: the golden brief is regenerated with `-L <server>`. A test asserts that no `rk mux`/`rk operator`/`rk tab`/`rk riff` command in the rendered brief lacks `-L`, and that an empty server renders `-L default`.
- `cmd/rk`: execute-level test that a command run with `RK_OPERATOR_RUN_LOG` set appends a record with argv, exit code, and the capped stderr. A failing command records the non-zero exit. An unwritable path leaves the exit code and output unchanged.
- `cmd/rk/operator_track_test.go`: a named server with a failing socket query exits 1 and names the server. `default` with a failing query still resolves to `default.yaml`.
- The existing isolated-socket integration test (`operatorloop` restart/loop tests) keeps passing. If cheap, extend its stub run to assert `TMUX` reaches the launcher.

## Affected Memory

- `run-kit/operator-loop`: (modify) Wrapper requirement. The launcher env restores `TMUX` (from `tmux.OriginalTMUX`) and exports `RK_OPERATOR_RUN_LOG`. The run-log header line and mismatch warning. The run log now also holds rk self-log records. Add a design decision on why the env is restored.
- `run-kit/operator-brief`: (modify) Embedded run rules. Every server-addressed rk command renders with `-L <server>` via placeholder substitution, plus the new "always pass -L" rule line. The Exit contract note command carries `-L`.
- `run-kit/operator-state`: (modify) CLI state-path resolution. A named non-`default` server with an unknown socket path is an error, with no `default.yaml` fallback. `default` keeps its fallback.
- `run-kit/architecture/cli`: (modify) The process-wide `RK_OPERATOR_RUN_LOG` self-logging hook in `execute()`: record format, caps, fail-silent.

## Impact

- `app/backend/internal/operatorloop/exec.go`: launcher `cmd.Env`, header line, `RunLogEnv` constant.
- `app/backend/internal/operator/brief.go`, `brief_rules.md`, `brief_autopilot.md`, `testdata/brief_golden.md`, `brief_test.go`.
- `app/backend/cmd/rk/root.go` (`execute()` self-log hook); possibly `cmd/rk/agent_kickoff.go` (`cliChildEnv` reuse/move).
- `app/backend/cmd/rk/operator_track.go` (`operatorStateTarget`), `cmd/rk/operator_brief.go`; possibly `internal/operator/store.go` (an error-returning socket-path variant).
- No API, frontend or config changes. The run file layout is unchanged (same `<run-id>.log`, with richer content).
- Interacts with the cron operator-loop entry only through the run's behavior. The daemon, records, transcription and the failure-note contract are untouched.

## Open Questions

- Does `claude -p`'s Bash tool pass `TMUX` through to the shell it spawns? The agent believes it does (env is inherited). After the fix, a live loom run should confirm `rk mux capture` succeeds without the explicit `-L`, but §2 makes that belt-and-braces either way.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Root cause: `internal/tmux` init strips `TMUX`, `Exec` never sets `cmd.Env`, so the launcher has no `TMUX` and bare rk resolves to `default` | Verified in code (`tmux.go:301`, `exec.go` runLauncher, `mux.go:154`, `cliServerLabel`) and by the `default.yaml.lock` mtime 11:10:25 inside the run window | S:95 R:90 A:95 D:95 |
| 2 | Certain | The "no step6a" report was a wrong ledger (default.yaml, empty), not a stale one | `operatorStateTarget` → `ServerSocketPath("default")` = "" → `default` slug; lock file created mid-run; no default.yaml exists | S:90 R:90 A:95 D:90 |
| 3 | Certain | Fix (2) uses rk self-logging via a run-exec-exported env var, not stream-json or brief-only | Asked — user chose "rk self-logs (Recommended)" | S:95 R:70 A:90 D:95 |
| 4 | Certain | Restore `TMUX` in the launcher env by reusing the `cliChildEnv`/`OriginalTMUX` pattern | The established repo pattern for exactly this problem; one obvious fix | S:85 R:85 A:85 D:80 |
| 5 | Confident | Brief `-L` is rendered by placeholder substitution in `RenderBrief`, not by asking the model to substitute | The renderer already knows `Server`; deterministic and golden-testable; model substitution is what failed in spirit | S:80 R:85 A:80 D:70 |
| 6 | Confident | A named non-`default` server with an unknown socket path errors in the CLI state-path resolution; `default` keeps its fallback | Mirrors the daemon-side `statePathFn` rule; keeps plain-shell `rk operator track` working; turns the wrong-ledger read loud | S:70 R:75 A:75 D:65 |
| 7 | Certain | The run log gets a `run-exec:` header line (server, run, TMUX socket, cwd, launcher) plus a mismatch warning | Directly serves the "diagnosable" goal at negligible cost; the wrapper already writes to the log | S:70 R:90 A:80 D:75 |
| 8 | Confident | Self-log record format: `--- rk <time> pid= exit=` / `argv:` / `stderr:` (last 4 KiB) / `stdout:` (last 2 KiB), one O_APPEND write, fail-silent, hooked in `execute()` | Format and caps are agent-chosen; the user picked the approach, not the shape | S:55 R:85 A:65 D:50 |
| 9 | Confident | Env var name `RK_OPERATOR_RUN_LOG`, set only by run-exec; absolute path required | Follows the `RK_*` env naming in the repo; name is agent-chosen | S:50 R:85 A:70 D:55 |
| 10 | Certain | `rk notify` stays without `-L`; the static `rk skill operator` chat topic is unchanged | notify is server-independent; the chat topic is session-agnostic by contract (operator-brief memory) | S:75 R:90 A:85 D:80 |

10 assumptions (6 certain, 4 confident, 0 tentative, 0 unresolved).
