# Intake: Operator check — idle defined (same-window worker + 3-min floor), stage baseline seeded

**Change**: 261120-9ypa-operator-check-idle-floor-stage-seed
**Created**: 2026-11-20

## Origin

> Execute step T1 (Check: idle defined (same-window worker + 3-min floor); stage baseline seeded) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first (Decisions and Rules bind you), then implement only the T1 Brief.

One-shot `/fab-new` from the operator executing the plan `fab/plans/sahil/26-11-20-operator-triggers.md` (in-repo copy at the same relative path). The plan's **Decisions already taken** table and **Rules for the operator executing this plan** bind this change and are not reopened here. The T1 Brief, verbatim:

> - **Idle.** In `operator.Check`'s pane join (`check_pane.go` `trackAgent`), the `agent:idle` condition
>   requires both: no other pane **in the same tmux window** whose reconciled agent state is `active`; and
>   the idle state's epoch at least `idleFloor` (3 min, a named constant) old. Until both hold the baseline
>   (`scope.agent`) still advances silently — no condition, no `agent_state` delta — so resume does not
>   fire a burst. `agent:waiting` is unchanged (immediate); `agent:idle:aged` / `agent:waiting:aged:<n>`
>   unchanged. The pane snapshot already lists every pane with its window id; no new tmux call. The first
>   idle that passes the floor emits the `agent_state` delta with the real `duration`.
> - **Stage.** `trackStage`: when `scope.stage` is empty and the snapshot resolved a stage, write it as the
>   baseline (no event); diffs behave as today from the next check on. Projections written by the engine
>   still carry no `stage` — the check seeds it on first look.
> - Tests: idle table cases (worker-active / floor-not-reached / both-pass / waiting-unaffected); stage
>   seeds without an event, then `stage_advance` and `review_fail` report; the existing edge-trigger and
>   aged tests stay green.
> - Docs: `operator-state.md` § Pane state and § Conditions; a Design Decision "Idle means the work stopped".

Plan decision row (binding): *Idle — `agent:idle` is a condition only when no other pane in the same window is `active` **and** the idle state has held ≥ `idleFloor` (3 min). `waiting` stays immediate. The 30-min `aged` conditions are unchanged. Why: 48 of 56 no-op runs fired on an idle under 60 s with a worker pane active in the same window; both facts are in the one snapshot the check already takes (Constitution X).*

Plan open decision for T1, resolved here: *Whether "same window" should also include "same worktree in another window" — start with same window; widen only if the data shows the gap.* → **same window only.**

## Why

1. **75 % of operator model runs do nothing.** Live data 2026-11-14 → 11-20 across four tmux servers: 59 of 79 clean `claude -p` runs ended "idle only briefly mid-run, worker active, sent nothing". A `/fab-fff` parent agent goes idle for ~30 s between every pipeline stage while its pane-worker (a sibling pane in the **same tmux window**, opened by `fab dispatch open`) runs the stage. `operator.Check` reports `agent:idle` as a fresh edge-triggered condition the moment the parent's reconciled state flips to `idle`, so the loop launches a paid model run whose only possible conclusion is "not stuck". Median idle age at those runs: 32 s.
2. **The stage channel is dead.** `trackStage` (`app/backend/internal/operator/check_pane.go`) only diffs against an existing `scope.stage` baseline and never seeds one. Pane items are created with `stage: null` (the eleven pinned pane scope keys seed as null) and the autopilot engine's projections never write `stage`, so every tracked pane reads `stage: null` forever: `stage_advance` and `review_fail` never fire, and the engine's Q6a escalated "stage (unknown) over 30m" on agents running normally.

If not fixed: the operator keeps spending ≈ 200K input tokens per no-op run several times an hour per active `/fab-fff` parent, and the stage events the operator's judgment set and brief depend on (review failing back to apply, a stage advancing) stay invisible.

Why this approach: both facts needed for a correct idle verdict — which panes share a window, and how long the idle state has held — are already in the single pane snapshot `operator.Check` takes (`tmux.ListWindowsStrict` gives each pane's window; the reconciled `AgentStateEpoch` gives the state's start). No hook payload, no new tmux call, no new state (Constitution X: derivation wins). Rejected alternatives (from the plan): a model-side "ignore short idles" rule (still pays for the run); a debounce in the cron wake path (the check is the gate that decides whether a run launches; the wake only decides when to look).

## What Changes

All code changes are in `app/backend/internal/operator/` (package `operator`). No CLI surface, API, frontend, cron, or engine change.

### 1. Pane snapshot carries the window id

`paneRow` (`check_pane.go`) gains a `WindowID string` field, filled in `defaultPaneSnapshot` from the enclosing `tmux.WindowInfo.WindowID` (tmux `#{window_id}`, e.g. `@3` — unique per tmux server, so grouping across sessions by window id is correct). `defaultPaneSnapshot` already iterates `sessions → windows → w.Panes`; this is one more field on the row, **no new tmux call**.

```go
type paneRow struct {
	PaneID       string
	WindowID     string
	Cwd          string
	...
}
// in defaultPaneSnapshot:
rows[p.PaneID] = paneRow{
	PaneID: p.PaneID, WindowID: w.WindowID, Cwd: p.Cwd, ...
}
```

### 2. Idle is a condition only when the work stopped

New named constant beside `agentAgedAfter` in `check_conditions.go`:

```go
// idleFloor is how long an agent must stay idle before agent:idle is a
// condition: a /fab-fff parent idles ~30 s between stages while its worker
// runs, and that pause is not the work stopping.
const idleFloor = 3 * time.Minute
```

`trackAgent(it, row, now)` gains access to the whole snapshot (e.g. a new parameter `panes map[string]paneRow` from `obs.panes`, passed through `joinPane`) so it can see the pane's window siblings. For `row.AgentState == idle`, the `agent:idle` condition (and its `agent_state` delta) is emitted only when **both** hold:

- **No active sibling** — no *other* pane in the snapshot with the same non-empty `WindowID` whose reconciled `AgentState` is `tmux.AgentStateActive` (`"active"`). Sibling panes need not be tracked items; any pane in the window counts. Panes with an empty/unknown state, `idle`, or `waiting` do not block.
- **Floor reached** — the idle state has held at least `idleFloor`: `now - time.Unix(row.AgentEpoch, 0) >= idleFloor`. When `row.AgentEpoch == 0` (no epoch known), the floor is treated as **reached** (today's behaviour — the existing test `TestCheck_AgentStateFiresOnlyIntoWaitingOrIdle` drives idle with epoch 0 and expects the edge; an unknowable age must not suppress the signal forever).

Until both hold:

- `scope.agent` still advances to `"idle"` (silent baseline move, exactly as `active`/unknown do today);
- no `agent:idle` condition key, so nothing enters `changes`/`open` and `Reported` does not gain the key;
- no `agent_state` delta.

The first check at which both hold emits `agent:idle` as a new condition → the `agent_state` delta in `changes`, with `duration` = `tmux.FormatAgentDuration(now - AgentEpoch)` (the **real** held duration, e.g. `3m`, `12m`), `pane`, `to: "idle"`. Its `from`: the stored baseline before this check; if an earlier suppressed check already advanced `scope.agent` to `idle`, `from` is **null** rather than a self-referential `idle → idle`.

If a sibling becomes active again after `agent:idle` was reported, the condition drops out of the set (key removed from `Reported`, nothing reported — standing conditions are edge-triggered); when the sibling stops, the parent's idle epoch is usually already past the floor, so the next check reports a fresh `agent:idle` edge immediately — the intended "work stopped" moment.

Unchanged:

- `agent:waiting` — immediate, no floor, no sibling rule.
- `agent:idle:aged` (once per stretch) and `agent:waiting:aged:<n>` (per 30-min bucket) — derived exactly as today from `agentAgedAfter` (30 min) and the epoch, independent of the new idle gate (an idle pane with a sibling active for 30+ minutes still gets `agent:idle:aged`, per the brief).
- `active` / unknown — baseline-only.
- `paneConditionKeys`, `openDelta`, `itemConditions`, the edge-trigger mechanics in `applyCheck`.

Sketch of the shape (implementation free to differ):

```go
case tmux.AgentStateIdle:
	key, agedKey = condAgentIdle, condAgentIdleAged
	if !idleStopped(row, panes, now) { key = "" }   // still emit aged below
...
func idleStopped(row paneRow, panes map[string]paneRow, now time.Time) bool {
	if row.AgentEpoch > 0 && now.Sub(time.Unix(row.AgentEpoch, 0)) < idleFloor {
		return false
	}
	for id, p := range panes {
		if id != row.PaneID && row.WindowID != "" && p.WindowID == row.WindowID && p.AgentState == tmux.AgentStateActive {
			return false
		}
	}
	return true
}
```

### 3. Stage baseline seeded on first look

`trackStage(it, row, nowStr)`: when `scope.stage` is empty and `row.Stage` is non-empty (the caller already guards `row.Stage != ""`), write `it.Scope["stage"] = row.Stage` (and `it.UpdatedAt = nowStr`, as other scope writes in the join do) and return **no event**. From the next check on, a differing resolved stage is a `stage_advance` (or `review_fail` for `review → apply`) exactly as today. Engine projections still carry no `stage`; the check seeds it on first look — no engine change.

```go
func trackStage(it *TrackedItem, row paneRow, nowStr string) (CheckDelta, bool) {
	baseline := scopeString(it.Scope, "stage")
	if baseline == "" {
		it.Scope["stage"] = row.Stage
		it.UpdatedAt = nowStr
		return CheckDelta{}, false
	}
	if row.Stage == baseline { return CheckDelta{}, false }
	... // unchanged
}
```

Doc comment updated: "A missing baseline is seeded from the observation without an event."

### 4. Tests (`app/backend/internal/operator/check_pane_test.go`)

Per Test Integrity, existing tests whose expectations the spec changes are updated to the new spec:

- **Idle table** (new, table-driven) — cases:
  - *worker-active*: tracked pane `%1` idle with epoch ≥ 3 min old, sibling `%2` in the same `WindowID` with `AgentState: "active"` → no change, no open, `scope.agent == "idle"`.
  - *floor-not-reached*: idle epoch 30 s old, no active sibling → no change, `scope.agent == "idle"`.
  - *both-pass*: idle epoch ≥ 3 min, sibling idle/absent (and an active pane in a **different** window does not block) → `agent_state` change with the real `duration` (e.g. `"3m"`).
  - *waiting-unaffected*: waiting epoch 30 s old with an active sibling → `agent_state` change immediately.
  - *no-epoch*: idle with epoch 0, no sibling → fires (floor treated as reached).
  - *resume, no burst*: suppressed check(s) followed by the floor passing → exactly one `agent_state` change with `from: null`, then `open` on the next check.
- **Stage** — `TestCheck_StageAdvanceReviewFailAndNoBaseline` flips its `none` case: an item with no baseline stage gets `scope.stage` seeded to the observed stage with **no** event; a following check with an advanced stage reports `stage_advance`, and `review → apply` reports `review_fail`.
- `TestCheck_AgentStateFiresOnlyIntoWaitingOrIdle` and `TestCheck_AgentAged` stay green (adjust fixtures only where the floor now applies, e.g. idle epochs, keeping their intent).
- Whole package and `go test ./...` for the backend stay green apart from the known host-only failures (`cmd/rk` `TestPortPinRowRealPolicyValues`, `rk/api` `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`).

### 5. Memory (hydrate)

`docs/memory/run-kit/operator-state.md`:

- § *Pane state comes from rk's own data* (the "Pane state" section): the snapshot row includes the window id; clause (d) — a missing `scope.stage` is **seeded** from the observed stage without an event (replace "no baseline stage diffs against nothing"); clause (e) — `idle` yields `agent:idle` only when no other pane in the same window is `active` and the idle epoch is ≥ `idleFloor` (3 min; no epoch ⇒ floor reached); until then `scope.agent` advances silently.
- § *Conditions and edge-triggered verdicts* (the conditions table): `agent:idle` row states the two gates; `agent:waiting` immediate.
- New Design Decision **"Idle means the work stopped"** (four-field shape: Decision / Why — 48 of 56 no-op runs fired on an idle under 60 s with a worker active in the same window; both facts are in the one snapshot (Constitution X) / Rejected — same worktree in another window (start narrow; widen only if data shows the gap), a model-side rule (still pays for the run), a wake-path debounce (the check is the gate) / *Introduced by* this change).

### PR evidence

`No recording: internal CLI/engine behavior` — validation is the Go unit tests above.

## Affected Memory

- `run-kit/operator-state`: (modify) § Pane state (window id in the snapshot, stage seeding, idle gates) and § Conditions (`agent:idle` gates); new Design Decision "Idle means the work stopped"

## Impact

- **Code**: `app/backend/internal/operator/check_pane.go` (`paneRow`, `defaultPaneSnapshot`, `joinPane`, `trackStage`, `trackAgent` + helper), `app/backend/internal/operator/check_conditions.go` (`idleFloor`), `app/backend/internal/operator/check_pane_test.go`.
- **Consumers of `CheckResult`** (`internal/operatorloop` judgment set, the brief) are unchanged in shape; they simply see fewer `agent_state → idle` changes and, newly, `stage_advance`/`review_fail` events.
- **Interaction with the cron wake / ladder** (`internal/cron/wake.go`, `loop.go`): a `→ idle` wake still fires the loop's check, which now reports `no change` for an under-floor or worker-active idle; the idle that later passes the floor is picked up by the next scheduled check (ladder backstop, min 3 min). No cron change in this step (T2 owns the clock).
- **Deployment**: the live daemons keep the installed `rk` until plan step R1; nothing here installs a binary or restarts a daemon. Existing ledgers with `stage: null` seed on first check after rollout — no migration.

## Open Questions

- None blocking. (Widening "same window" to "same worktree in another window" is deferred by the plan until data shows the gap.)

## Non-Goals

- **Review bar (from the plan, binding for every review dispatch):** must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.
- No change to `agent:waiting`, the 30-min aged conditions, the cron wake fingerprint, `LoopLadder`, or the autopilot engine (projections still write no `stage`).
- No "same worktree, other window" sibling rule.
- No new tmux call, hook field, or persisted state beyond `scope.stage` / `scope.agent`.
- No other plan step (T2–T7, R1, M1).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Idle gate = no other pane in the same tmux window with reconciled state `active` AND idle epoch ≥ `idleFloor` (3 min, named constant) | Plan Decisions table + T1 Brief, verbatim | S:95 R:85 A:95 D:95 |
| 2 | Certain | "Same window" only — no same-worktree-other-window widening | Plan open decision for T1: start with same window | S:90 R:85 A:90 D:90 |
| 3 | Certain | `agent:waiting` immediate; `agent:idle:aged` / `agent:waiting:aged:<n>` unchanged (aged still fires with an active sibling) | Brief: "unchanged" | S:90 R:85 A:90 D:85 |
| 4 | Certain | Under the gate, `scope.agent` advances silently — no condition, no delta | Brief, verbatim | S:95 R:85 A:90 D:90 |
| 5 | Certain | Window membership from `tmux.WindowInfo.WindowID` added to `paneRow` in `defaultPaneSnapshot`; no new tmux call | Brief; `WindowInfo.WindowID` already populated by `ListWindowsStrict` | S:85 R:90 A:95 D:90 |
| 6 | Certain | Stage: empty `scope.stage` + resolved stage ⇒ seed baseline, no event; diffs as today afterwards | Brief, verbatim | S:95 R:90 A:95 D:95 |
| 7 | Confident | Any pane in the window counts as a sibling (tracked or not); only `active` blocks | Brief says "no other pane in the same tmux window"; untracked worker panes are exactly the case | S:75 R:85 A:75 D:80 |
| 8 | Confident | Epoch 0 (unknown) ⇒ floor treated as reached | Preserves today's signal; existing test drives idle with epoch 0 and expects the edge; aged's "no epoch ⇒ never aged" would here mean never reporting idle at all | S:50 R:85 A:70 D:60 |
| 9 | Confident | `from` is null on the first post-floor `agent_state` delta when a suppressed check already advanced the baseline to `idle` | Baseline advances silently per brief, so the pre-idle state is gone; `idle → idle` would be misleading; null `from` is already the open-listing form | S:40 R:85 A:55 D:45 |
| 10 | Confident | Seeding `scope.stage` also stamps `UpdatedAt`, matching other scope writes in the join | `trackChange`/`trackStage` set `UpdatedAt` on scope writes | S:55 R:90 A:80 D:75 |
| 11 | Certain | Existing tests updated to the new spec where they conflict (`none` stage case flips) | Constitution: Test Integrity — tests conform to spec | S:80 R:90 A:90 D:85 |
| 12 | Certain | PR states `No recording: internal CLI/engine behavior` | Plan Rule 6; constitution PR Evidence exemption for internal behavior | S:95 R:95 A:95 D:95 |

12 assumptions (8 certain, 4 confident, 0 tentative, 0 unresolved).
