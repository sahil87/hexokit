# Intake: Operator Check — probe runner + diff as an in-daemon function

**Change**: 261111-zm04-operator-check-probe-diff
**Created**: 2026-11-11

## Origin

> Plan step R2 (Check: probe runner + diff as an in-daemon function, plus rk operator check) from the plan at /home/sahil/code/sahil87/hexokit.worktrees/arcing-fjord/fab/plans/sahil/26-11-10-operator-to-hexokit.md — read that file (Rules, Decisions, and that step's brief) first. R1 (the operator state engine in internal/operator/) is merged on main; build on it. Do not touch or restart the live rk daemon or installed binaries.

One-shot `/fab-new`, dispatched by the plan's operator. The plan (`fab/plans/sahil/26-11-10-operator-to-hexokit.md`, in the `arcing-fjord` worktree; not on this branch) moves the operator from one long-lived chat that cron types `operator tick` into, to a loop owned by HexoKit: **clock → check (Go, no AI) → nothing changed → stop, $0; changed → fresh headless AI run → note**. R2 is the "check" box. The plan's R2 brief, verbatim:

> - Port `tick-start --diff` as a Go function the daemon calls: probe runner (shell argv, github-pr via `internal/ghprobe`, pane state from rk's own pane/agent-state data, `agent_exited` liveness), field-scoped comparison against `seen`/`last`, output = list of changed items.
> - `rk operator check [--json]` exposes it for debugging; it writes the baseline exactly as the daemon call does.
> - Linear/Slack `probe: agent` items: the check marks them due by `check_every`; the run does the query.
> - Out of scope: launching runs.

Decisions the plan fixes (not reopened here): the gate is a deterministic Go check before any model call; next-check timing is rk's backoff + wake-on-agent-state-change, never model-chosen; runs execute in their own tmux window (R5); notes are the memory; the live operator keeps running on the **installed** fab/rk binaries until cutover C1 — this change never touches the live daemon, `brew`, or `fab sync`.

**Decided in this session** (asked via `/fab-new`): standing conditions are **edge-triggered** — the check reports a standing condition (done, pane death, agent exited, probe paused, stale, agent item due, …) as a change **once**, when it first appears or changes, and lists it as "open" afterwards. The user chose this over porting fab's level-triggered re-emission, because under R5 every reported change launches a paid run, and a run that leaves a dead pane or done item in place would otherwise be re-launched on every fire.

## Why

1. **The problem.** Measured on a live operator (149 h, 1,563 ticks, ≈ $451): 76 % of ticks made one `fab operator tick-start --diff` call and printed "no change", and ≈ 90 % of the cost was the model re-reading its own history to get there. The question "did anything change?" is mechanical and needs no model.
2. **If we don't.** R5 (the loop) has nothing to gate on, so every cron fire would have to start a model run — the cost problem the whole plan exists to remove. The check is also the only way rk can watch tracked items without fab: today the diff lives in fab's binary and reads fab's file, while rk's own state file (R1) is read by nothing.
3. **Why this approach.** fab's `tick-start --diff` (`fab-kit/src/go/fab/cmd/fab/operator_tick_start.go`, ≈ 1,230 lines + ≈ 2,000 test lines in `operator_tick_diff_test.go`) is battle-tested against live data and R1 already ported its schema, so porting its delta semantics keeps behavior identical where it matters. Three things change on the way in, each because the consumer changes from a chat LLM to a cost gate:
   - **Edge triggering** (above) — the gate must not stay open forever on a standing condition.
   - **Probes run outside the state-file lock.** fab probed inside its mutation (up to a 60 s budget). R1's `Mutate` lock polls for at most 5 s before `ErrBusy`, and the operator chat, a run, and the daemon all write the file — a check holding the lock across `gh` calls would make `rk operator track note` fail.
   - **Pane data comes from rk itself** (tmux pane listing with rk's reconciled `@rk_agent_state`, the `.fab-status.yaml` derivation rk already does for the sessions payload, rk's process-tree walk), not from fab's `pane map`, so fab is not required (plan Goal: "Without fab, the operator still watches panes, PRs and shell probes").
   The LLM-facing parts of fab's output (`tick_count`, `last_tick_at`, `--quiet`, `fleet_summary`, the rendered `items:` rows, `candidates:`) are not ported: they were a render frame for a chat model; R4/R5 build the run brief from the check result plus the items themselves.

## What Changes

### 1. `operator.Check` — the in-daemon function (`app/backend/internal/operator/check.go`, new)

A library function in `internal/operator` that the daemon (R5) and the CLI both call in-process. R2 adds no daemon caller, no HTTP route, and no cron entry.

```go
// Check probes every due item, diffs against the stored baselines, writes the
// new baselines in one locked write, and returns what changed.
func Check(ctx context.Context, server string, opts CheckOptions) (CheckResult, error)
```

- `server` is the tmux server label (`""` = default), used for the pane listing and resolved to the state path with `StatePathForServer` (R1).
- `CheckOptions` carries the probe budget (default 60 s, fab's `trackTickBudget`) and nothing else user-facing; test seams are package-level vars, R1-style (`probeRunnerFn`, `paneSnapshotFn`, `panePIDsFn`, `agentAliveFn`, `ghAvailableFn`, `gitBranchFn`), plus R1's existing `clock`.
- An empty `tracked` list is a first-class no-op: no pane listing, no probes, `changed: false`; it still writes `last_check_at` (§5).

**Two phases** (the lock rule):

1. **Observe, lock-free.** `Load` the file (R1: lock-free read, atomic-rename guarantees a complete file). If any pane-probe item has a non-null `scope.pane`, take ONE pane snapshot of the server (§2). Run every due shell probe (§3) sequentially until the budget deadline. Nothing is written in this phase.
2. **Apply, under `Mutate`.** Re-read inside the lock (external writes win), then for each item **still present by id**: apply the probe outcome only if the item's `probe.argv` and `checked_at` are unchanged since phase 1 (otherwise someone observed/updated it meanwhile — discard this probe result); apply pane baselines; compute conditions and edge verdicts (§4); write `done_at`, `reported`, `branch_map`, `last_check_at`. Items added during phase 1 are evaluated without a probe this round (no probe result exists for them). One atomic write; success returned only after the rename.

Two concurrent checks (CLI + daemon) serialize in phase 2; the second sees the first's `reported` and so reports no duplicate edges, and its stale probe results are discarded by the `checked_at` guard.

### 2. Pane state from rk's own data

Ported from fab's `diffPaneItems`, sourced from rk:

| fab source | rk source |
|---|---|
| `fab pane map` row (pane, cwd, command, agent_state, durations, change, stage, display_state, repo) | `tmux.ListSessions`/`ListWindows` on the server → `tmux.PaneInfo` (`PaneID`, `Cwd`, `Command`, `PanePID`, reconciled `AgentState`, `AgentStateEpoch`, `AgentPID`); change/stage/display_state from the `.fab-status.yaml` walk-up rk already does in `internal/sessions/fabstate.go` |
| `pane.ListPanePIDs` (one `tmux list-panes -a`) | `PaneInfo.PanePID` from the same listing (no second call) |
| `has_agent` tri-state + `paneAgentAlive` walk | rk's reconciled agent state, then `paneHasAgent` (`cmd/rk/mux_process.go`) only for a shell-foreground pane with no live agent pid |
| `git -C <cwd> branch --show-current` (branch_map) | same argv, `exec.CommandContext` with the 10 s probe timeout |

**Package moves required** (the operator package must not import `internal/sessions`, which R3 will make import `operator`; and `cmd/rk` is package `main`):

- Move the fab-state derivation (`locateFabStatusLink`, `parseFabStatusLink`, `parseProgressStates`, `fabDisplayStage`, the per-call memo) out of `internal/sessions/fabstate.go` into a small exported package (e.g. `internal/fabstatus`: `Derive(cwd) State{Change, Stage, DisplayState}` + a memo type). `internal/sessions` keeps its behavior by calling it; its tests move or stay as appropriate.
- Move the process-tree walk (`paneHasAgent`, `hasAgentInTree`, the per-OS discovery in `mux_process_linux.go`/`_darwin.go`, the agent-name set from the agent setup registry) into an internal package (e.g. `internal/proctree`). `rk mux process` and `rk mux panes` call it unchanged; their output stays byte-identical.

**Per pane item** (`probe.mode == pane`, non-null `scope.pane`, no `done_at`), in fab's order, first match wins:

- **pane_death** — the pane id is absent from the snapshot. Baseline untouched.
- **pane_mismatch** — `scope.pane_pid` is recorded, non-zero, and differs from the pane's current `PanePID` (tmux recycled `%N` across a server restart). `found` = the pane's observed change id or null. A null recorded pid joins on pane id alone.
- **agent_exited** — the pane's foreground `Command` is a shell (`IsShellCommand`) and no live agent is found: reconciled `AgentState` empty / `AgentPID` 0 and the process-tree walk finds no agent. An agent TUI owning the tty is never "exited". `command` = the foreground command.
- **Clean join** — then, in order:
  - **change appear/switch**: observed change id non-empty and ≠ `scope.change` → a `changed` delta with `fields: {change: {from, to}}`; baseline `scope.change` ← observed. An unresolved observation leaves the baseline alone (sticky).
  - **branch_map**: an observed change with no `branch_map` entry and a non-empty `scope.repo` gains `{branch, repo}` from `git -C <cwd> branch --show-current`; an empty result (detached HEAD) or failure skips it and a later check retries.
  - **built-in completion** (only when `scope.change` is non-null and the stage is resolved): `stop_stage` null → done at `ship` with display state `done`/`skipped`; `stop_stage` set → done when past the stop stage in order (`intake, apply, review, hydrate, ship, review-pr`), or at it with `done`/`skipped`. Persist `done_at` in the same write so the verdict survives the pane disappearing.
  - **stage_advance / review_fail**: resolved stage ≠ non-empty `scope.stage` → delta with `pane, from, to`; `review → apply` is `review_fail`; baseline `scope.stage` ← observed. No baseline stage diffs against nothing.
  - **agent state**: `scope.agent` ← observed agent state verbatim (null when unknown). A transition **into** `waiting` or `idle` (from anything else) is a new `agent_state` delta with `pane, from, to, duration` (duration since `AgentStateEpoch`, rk's `FormatAgentDuration`). `→ active` and `→ unknown` update the baseline silently (mirrors `internal/cron/wake.go`'s classification). This replaces fab's level `candidates:` list.

### 3. Probe runner — shell and github-pr

Ported from fab's `runDueProbesUntil` / `runOneProbe`:

- **Due rule**: `probe.mode == shell`, not paused, not done, and `checked_at` null or `now − checked_at ≥ check_every` (an unparsable `checked_at` is due; a missing `check_every` uses 5 m).
- **Runner**: argv-only `exec.CommandContext` with R1's 10 s `probeTimeout`, the caller's environment inherited, `exec.LookPath(argv[0])` first (Constitution I). Errors compose to one line: `exit <n>: <first stderr line>`, `timeout after 10s`, or the lookup error.
- **github-pr**: before running a `kind: github-pr` item's probe, call `ghprobe.Available(ctx, timeout)`. When gh is missing or logged out, the item is **skipped**: `checked_at` and `failures` untouched, reported as a non-gating notice `{id, reason: "gh unavailable"}`. (`ghprobe` memoizes, so this costs at most one `gh auth status` per check.) Other shell items run regardless.
- **Outcome**: `checked_at` ← now on every completed run. Failure (non-zero exit, timeout, or stdout not a JSON object) → `failures++`; at `failures ≥ 3` set `paused`. Success → `failures = 0`; extract `probe.fields` (dotted paths, absent ⇒ null) with R1's `extractProbeFields` + `normalizeJSONNumbers`; equal to `last` → `unchanged++`; different → a `changed` delta with per-field `{from, to}` (fab's `fieldChanges`), `unchanged = 0`, `last` ← new, `updated_at` ← now.
- **Budget**: items still due when the deadline passes are skipped as a notice `skipped (check budget)` with `failures` untouched.

### 4. Conditions, the `reported` field, and edge verdicts

Every check derives each item's **current condition set** (string keys) and compares it with the item's stored `reported` list:

| Condition key | When it holds |
|---|---|
| `done` | `done_at` set, built-in completion fired this check, or `done_when` holds against `last` |
| `pane_death`, `pane_mismatch`, `agent_exited` | §2 |
| `agent:waiting`, `agent:idle` | clean join with that observed agent state |
| `paused` | `paused` and `failures ≥ 3` (the probe-failure pause) |
| `stale` | agent item, `now − (checked_at ?? added_at) > 2 × check_every` (R1's `itemStale`) |
| `due@<checked_at ?? added_at>` | agent item (`linear`/`slack`), not paused, not done, past `check_every` — keyed by the base timestamp so it fires once per due period |
| `unknown_dep:<id>` | a `depends_on` id missing from the list |

- A done item yields only `done` (inert otherwise, as in fab); a user-paused item (below the failure cap) yields nothing but `done`/`unknown_dep`.
- A condition in the current set but **not** in `reported` is **new** → it goes into `changes`. One already in `reported` goes into `open`. After evaluation `reported` ← the current set (sorted), so a condition that clears and returns fires again.
- **Event deltas** (`changed` probe fields, change appear/switch, `stage_advance`, `review_fail`, `agent_state` transition) are always new — they are consumed by their baseline update in the same write, exactly as fab's consumed-on-read deltas.
- **Non-gating notices**: a single probe failure below the cap, a budget skip, and `gh unavailable` appear in `notices` and never set `changed`. Reaching the cap produces the gating `paused` condition.
- `changed` = `len(changes) > 0`.

**Schema addition** (R1's `TrackedItem`): `Reported []string \`yaml:"reported,omitempty" json:"reported,omitempty"\``, placed after `notes`. It is written only by `Check`. `track list --json` shows it; adopt never sets it (an adopted item reports its standing conditions once on the first check). `normalizeItem` and the typed write treat it like `seen`.

### 5. `last_check_at` (top-level key)

Every successful check writes a top-level `last_check_at: <RFC3339 UTC>` (typed alongside `tracked`/`branch_map`, so it is not lost as an "extra" key). It gives R3's drawer a liveness stamp in place of fab's `last_tick_at` and lets R5/debugging see when the gate last ran. No `tick_count`.

### 6. Result shape

```go
type CheckResult struct {
    CheckedAt string        `json:"checked_at"`
    Changed   bool          `json:"changed"`
    Changes   []CheckDelta  `json:"changes"`  // new since the last check — the gate
    Open      []CheckDelta  `json:"open"`     // standing conditions already reported
    Notices   []CheckNotice `json:"notices"`  // never gate: probe failure under cap, budget skip, gh unavailable
}
```

`CheckDelta` keeps fab's per-kind field sets: `kind, id` plus `pane` (pane kinds), `fields` (`changed`), `then` (`done`, verbatim item `then` or null), `age` (`stale`, `due`), `instruction` (`due`), `error/failures/paused` (`paused`), `found` (`pane_mismatch`), `command` (`agent_exited`), `from/to` (`stage_advance`, `review_fail`, `agent_state`), `duration` (`agent_state`), `dep` (`unknown_dep`). Kinds: `changed, done, pane_death, pane_mismatch, agent_exited, stage_advance, review_fail, agent_state, paused, stale, due, unknown_dep`. Lists are ordered by item list order, then emission order; empty lists marshal as `[]`.

### 7. `rk operator check [--json] [-L <server>]` (`app/backend/cmd/rk/operator_check.go`, new)

A child of `operatorCmd`, same `-L/--server` resolution as `operator track` (caller's own server from `$TMUX`, else default; validated with `validate.ValidateServerName`). Calls `operator.Check` in-process — no daemon needed — and **writes the baselines exactly as the daemon call will** (it consumes edges; that is the documented behavior).

Human output (example):

```
changed 3, open 1, notices 1
  new   pr-1120        changed        state: "OPEN" → "MERGED"
  new   r2-check       stage_advance  %12 apply → review
  new   linear-inbox   due            12m — check the Linear inbox for new issues
  open  old-pane       pane_death     %7
  note  ci-probe       probe_error    exit 1: HTTP 502 (failures 1)
```

and `no change` when nothing is new (open/notice lines still print below it). `--json` emits `CheckResult` through the shared `outputSink` envelope. Exit codes: 0 success (change or no change), 1 operational (state file unreadable/busy, tmux listing failure), 2 usage. Help text follows the toolkit conventions (Examples + Exit codes sections, no backticks in flag help); `rk help-dump` picks it up from the cobra tree. Not added to the MCP allowlist.

### 8. Tests

Port the relevant cases from fab's `operator_tick_diff_test.go` (≈ 2,000 lines) to `internal/operator/check_test.go`, adapted to the edge model and rk seams: each pane delta and its precedence; sticky change/stage baselines; built-in completion with and without `stop_stage`; `review → apply`; branch_map write/skip/retry; probe success/unchanged/changed/failure/pause-at-3/non-JSON; dotted fields; budget skip; done items not re-probed; unknown dependency. New cases: a standing condition is new on the first check and open on the second; a cleared-then-returning condition fires again; `due@` fires once per period; `agent_state` fires on → waiting/idle only; a probe result is discarded when `checked_at`/argv changed between phases; an item removed during phase 1 is ignored; gh unavailable skips github-pr without counting a failure; concurrent `track note` succeeds while probes run (no lock held in phase 1); empty list is a no-op that still writes `last_check_at`. CLI tests in `cmd/rk/operator_check_test.go` (human + `--json`, server flag, exit codes). The moved fabstate/proctree code keeps its existing tests passing (`rk mux process`/`panes` output unchanged).

## Affected Memory

- `run-kit/operator-state`: (modify) add the check — `operator.Check` two-phase contract, pane/probe delta semantics, condition keys and the `reported` field, `last_check_at`, the result shape, and `rk operator check`; note the new schema field
- `run-kit/tmux-sessions`: (modify) references to `internal/sessions/fabstate.go` / `fabStateMemo` now point at `internal/fabstatus`
- `run-kit/agent-messaging`: (modify) references to `classifyProcess` / `hasAgentInTree` in `cmd/rk` now point at `internal/proctree` (names injected via `SetAgentCommNames`); `sessions.FormatAgentDuration` is now `tmux.FormatAgentDuration`
- `run-kit/agent-state`: (modify) reference to `internal/sessions/fabstate.go` now points at `internal/fabstatus`
- `run-kit/architecture/backend-packages`: (modify) fabstate reference updated; `formatAgentDuration` moved from `internal/sessions` to `internal/tmux` (`FormatAgentDuration`); add `internal/fabstatus` and `internal/proctree` to the package inventory
- `run-kit/architecture/overview`: (modify) reference to `internal/sessions/fabstate.go` now points at `internal/fabstatus`

## Impact

- **New**: `app/backend/internal/operator/check.go` (+ `check_test.go`), `app/backend/cmd/rk/operator_check.go` (+ test), a shared fab-state package and a shared process-tree package under `app/backend/internal/`.
- **Modified**: `internal/operator/schema.go` (`Reported`), `store.go` (typed `last_check_at`, `normalizeItem`), `internal/sessions/fabstate.go` (delegates to the moved derivation), `cmd/rk/mux_process*.go` / `mux_panes.go` (call the moved walk), `cmd/rk/operator.go` (register `check`).
- **Not touched**: the cron ticker/daemon (R5), `internal/cron/watchlist.go` and the sessions payload's operator reads (R3), the run brief (R4), fab-kit. The live rk daemon and installed binaries are not touched; verification runs `go test` and a throwaway build only.
- **Evidence**: nothing observable in the web UI or desktop shell → PR body states `No recording: CLI/internal backend only`.
- **Subprocesses**: tmux (pane listing, existing helpers), `gh` (via shell probes, gated by `ghprobe`), `git branch --show-current`, user-declared probe argv — all `exec.CommandContext` with timeouts, argv-only.

## Open Questions

- None blocking. R5 decides how the daemon schedules `Check` and turns `changes` into a run; R4 decides how `open`/`notices` appear in the brief.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Standing conditions are edge-triggered: reported once in `changes`, then listed in `open` until they clear | Asked — user chose edge over fab's level re-emission, because every change launches a paid run under R5 | S:95 R:70 A:90 D:90 |
| 2 | Certain | Scope is the plan's R2 brief: check function + `rk operator check`; no daemon wiring, run launch, drawer, or brief | Plan step table and brief; "Out of scope: launching runs" | S:95 R:85 A:95 D:95 |
| 3 | Certain | `Check` is an `internal/operator` library function called in-process by both CLI and (later) the daemon; the CLI writes baselines exactly as the daemon will | Plan brief wording; R1's verbs are in-process library calls with the same lock | S:85 R:80 A:85 D:85 |
| 4 | Confident | Two-phase check: probes and pane listing run lock-free, results applied in one `Mutate` keyed by id with a `checked_at`/argv guard | R1's lock waits 5 s max while fab's probe budget is 60 s; chat/run writes must not hit `ErrBusy`; Constitution II external-writes-win | S:60 R:70 A:80 D:75 |
| 5 | Certain | Pane data from rk's tmux `PaneInfo` + `.fab-status.yaml` derivation + process-tree walk; fab not required | Plan brief "pane state from rk's own pane/agent-state data"; plan Goal "without fab" | S:85 R:75 A:85 D:80 |
| 6 | Confident | Move fabstate derivation and the process-tree walk into shared internal packages so `operator` imports neither `sessions` nor `cmd/rk` | `cmd/rk` is package main; R3 will make `sessions` import `operator` (cycle); package names left to apply | S:60 R:75 A:80 D:70 |
| 7 | Confident | github-pr probes gated by `ghprobe.Available`; gh unavailable ⇒ skip without counting a failure, as a non-gating notice | Plan brief "github-pr via internal/ghprobe"; ghprobe's package doc says unavailability is a silent no-op for callers | S:70 R:85 A:80 D:75 |
| 8 | Confident | Agent-state transition into waiting/idle (vs `scope.agent`) is a new `agent_state` delta; → active/unknown update silently | Replaces fab's level `candidates:` under the edge model; mirrors `internal/cron/wake.go` classification | S:55 R:80 A:75 D:70 |
| 9 | Confident | New `reported []string` field on `TrackedItem` (omitempty, after `notes`) stores the last-reported condition keys; `due@<base timestamp>` fires once per due period | Edge model needs durable per-item memory (Constitution II: files only); a per-item field keeps it with the item and survives `rm` cleanly | S:55 R:65 A:75 D:65 |
| 10 | Confident | Single probe failures below the pause cap, budget skips and gh-unavailable are non-gating notices; reaching the cap is the gating `paused` condition | A transient 502 should not wake a paid run; the cap is the existing "needs attention" signal | S:50 R:85 A:75 D:65 |
| 11 | Certain | fab's LLM render frame (`tick_count`, `last_tick_at`, `--quiet`, `fleet_summary`, `items:` rows, `candidates:`) is not ported | Consumer changes from chat model to gate; R4/R5 own the brief | S:70 R:85 A:85 D:80 |
| 12 | Certain | Port fab's delta semantics otherwise verbatim (pane precedence, sticky baselines, built-in completion, review_fail, branch_map, probe bookkeeping, 60 s budget, sequential probes) | Battle-tested on live data; R1 already ported the schema; plan says "Port tick-start --diff" | S:80 R:75 A:85 D:80 |
| 13 | Certain | `rk operator check` exit 0 on both change and no change; 1 operational; 2 usage; human + `--json` envelope; not in MCP allowlist | Matches R1's `track`/`adopt` CLI conventions and toolkit standards | S:60 R:90 A:85 D:80 |
| 14 | Confident | Write a typed top-level `last_check_at` on every check | Useful liveness stamp for R3's drawer and R5 debugging in place of fab's `last_tick_at`; not in the brief, cheap to drop | S:35 R:85 A:55 D:55 |
| 15 | Confident | No `--dry-run` on `rk operator check` | Brief says the CLI writes the baseline exactly as the daemon does; `track list --json` already gives a read-only view | S:60 R:90 A:70 D:70 |

15 assumptions (7 certain, 8 confident, 0 tentative, 0 unresolved).
