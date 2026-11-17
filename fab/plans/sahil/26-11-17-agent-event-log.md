# Agent event log — observe transitions at the source, stop reconstructing them

> Plan doc, written 2026-11-17 from the operator debugging session of the same day (PRs #1143–#1146
> and the engine-view fix that ships with this plan). Facts below were verified against run-kit
> `main` at 5cc19ac3: `cmd/rk/agent_hook.go`, `internal/tmux/agent_codex.go`, `internal/cron/wake.go`,
> `internal/operator/check_pane.go`, `internal/operator/check_conditions.go`,
> `internal/autopilot/enginefile.go`, and the live `fab_kit` operator records.

**Problem.** Every agent transition is observed exactly once, at its source: the harness hook
(`rk agent hook`) fires on each lifecycle event. The hook then discards the event — it writes a
level, `@rk_pane_agent_state = <state>:<write-time>[:<pid>]`, last write wins. Everything
downstream reconstructs the event from levels sampled later:

- the clock's wake fingerprints the levels at tick time and diffs against the last fingerprint
  (`internal/cron/wake.go`, 60 s debounce);
- the check diffs the level against its own baseline (`scope.agent`) and keeps `reported` keys to
  manufacture edges (`check_pane.go` `trackAgent`, `check.go` `applyCheck`);
- the run reads the check's reconstructed reasons;
- the engine keeps a third copy of pane facts, written at spawn, with a few fields overlaid from
  the ledger at view time.

Three consequences, all seen on `fab_kit` on 2026-11-17:

1. **Transitions between two observations do not exist.** idle → active → idle inside one check
   gap reads as "still idle": no change, no run. Same for a stage round trip.
2. **Durations are guesses.** The epoch means "last hook write", not "state began". Claude's
   `idle_prompt` rewrite moves it; the Codex reconciler zeroes it (`agent_codex.go:49`), so a Codex
   agent never ages and never gets its stuck nudge. The `agent_aged` condition (#1144) is built on
   that epoch.
3. **Copies drift.** Four holders of "what is this agent doing" (pane option, ledger scope, engine
   item, brief) are updated at different times by different writers. "not a queue item" (#1146),
   "stage (unknown)" and the `Branch 'pins-f1' not found` respawn failure (fixed with this plan)
   were each a consumer reading the copy nobody updated.

tmux control mode emits no notification when a pane option changes, so the daemon cannot
subscribe. The hook is the only place the edge is visible — and it is already an `rk` process.

---

## Goal

```
harness event ──► rk agent hook ──► append {ts, pane, to, …} to agent-events/<server>.log
                                 └─► set @rk_pane_agent_state (latest value, unchanged)
check ──► fold events since cursor ──► transitions (round trips included), exact state start
wake  ──► log tail moved? ──► fire
```

- **The transition is the durable fact.** The hook appends one line per event; the pane option
  stays as the latest value for display and as the fallback for uninstrumented panes.
- **The check folds events, never diffs levels.** "What changed" is the literal transition list.
  State start is the timestamp of the last event that changed `to`; duration is exact; "aged" is
  `start + 30m`. `agent_aged`, the `scope.agent` baseline and every epoch heuristic are deleted.
- **The engine stores intent only** (task, mode, deps, stop stage) and reads derivable facts
  (change, stage, branch) from the ledger at decision time.

Constitution fit: X (hooks carry only the underivable — a transition is exactly that; the same
fact the hook pushes today, kept instead of overwritten), II (a plain file in the state home; a
fresh daemon rebuilds from it; the daemon only reads), VI (nothing is lost while the daemon is
down, because the hook writes the file, not the daemon).

---

## Decisions already taken (do not reopen at intake)

| Decision | Choice | Why |
|---|---|---|
| Writer | The hook appends to a file; it never POSTs to the daemon | The daemon may be down (II, VI); a file append is one `O_APPEND` write of a line far under `PIPE_BUF`, atomic without a lock |
| Shape | Append-only JSON lines, one file per tmux server, newest-tail trim at a byte cap — the cron log pattern (`cron.AppendLog`/`trimLog`) | Already proven in this repo; readers tolerate a trimmed head |
| File key | The socket-path slug the operator state file uses (`cron.FabOperatorSlug`) | The hook knows the socket (`-S`) and pane, not the server label |
| `from` | Derived by readers from the previous event for the pane, never written by the hook | Writing it needs a read-before-write tmux call per event; the sequence already carries it |
| Pane option | Kept, written exactly as today | The dashboard, `rk mux`, fab-kit and older installs read it; it is the fallback for panes with no events |
| Reconciler corrections | Become events with `source: reconciler`, not epoch rewrites | A correction is a transition the hook could not see; the log is where transitions go |
| Aging | `state start + 30m`, computed by the check from the log; no second condition key | Replaces `agent_aged` (#1144) and the epoch |
| Scope | Pane agent state only. Pipeline stage stays derived from `.status.yaml` (it is on disk and derivable) | X: only the underivable goes through hooks |

---

## Current state (verified 2026-11-17)

- Hook: `cmd/rk/agent_hook.go` `writeAgentState` → one tmux invocation dual-writing the current
  and legacy option names (`dualWritePaneOption`). Seven harnesses in the registry; the per-harness
  event coverage is in `docs/site/agent-hooks.md`.
- Check: `trackAgent` reports `agent:waiting` / `agent:idle` as standing conditions, edge-triggered
  through `TrackedItem.Reported`; `agent:<state>:aged` after `agentAgedAfter` (30 m) from the
  pane's epoch; `DeltaAgentState` / `DeltaAgentAged` feed the judgment set and the brief reasons
  (`agent_state active→idle`, `agent_aged idle 31m`), which `brief_rules.md` names.
- Wake: `cron.Fingerprint` of pane → state, per entry, 60 s debounce.
- Engine view: `enginefile.go` `overlayPaneFacts` copies change, stage and the real branch from
  the ledger projection (this plan's step 0, shipped with it).

---

## Rules for the operator executing this plan

1. One fab change per step, `/fab-new` with the step's Brief; merge mode `cherry-pick-ladder`.
2. The live operator keeps running on the installed binary throughout; nothing here needs a
   cutover. The log starts empty and the level fallback covers every pane until its first event.
3. `brief_rules.md` reason strings are a contract with the model: a step that renames a reason
   updates the rules, the golden brief and `operator-brief.md` memory in the same change.

---

## Steps and dependencies

| ID | Step | Depends on | Size |
|---|---|---|---|
| **E0** | Engine view overlays change/stage/real branch (shipped with this plan) | — | S |
| **E1** | `internal/agentevents`: writer, reader, trim; the hook appends | — | S |
| **E2** | Check folds events: cursor, transitions as changes, exact start, aged from start; delete `agent_aged` and the epoch heuristics; level fallback | E1 | M |
| **E3** | Reconciler emits events; wake keys on the log tail | E1 | S |
| **E4** | Engine stores intent only: stop persisting `branch`/`change` facts the view now derives | E0 | S |
| **M1** | Measure a week: transitions in the log vs changes the old diff would have seen; model runs per day | E2 | S |

```
E0 ── E4
E1 ─┬─ E2 ── M1
    └─ E3
```

---

## Briefs

### E1 — Event log package and hook append (run-kit)

- `internal/agentevents`: `Append(socketPath, Event)`, `ReadSince(socketPath, cursor)`, trim at a
  byte cap (newest tail). Event: `{ts (RFC3339Nano), pane, provider, session_ref, to, pid?, source}`;
  `source` ∈ `hook`, `reconciler`. File: `$XDG_STATE_HOME/hexokit/agent-events/<slug>.log`, 0600.
- `rk agent hook`: after the option write succeeds, append one event. Fail-silent, like the
  option write: a hook must never fail the harness. No new tmux call.
- `rk agent events [-L <server>] [--pane <id>] [--since <ts>]` read verb for debugging, `--json`.
- Tests: concurrent appends keep whole lines; trim keeps the newest tail; a missing dir is created.

### E2 — Check folds events (run-kit)

- Per-server cursor in the operator state file (`events_cursor`, the ts of the last consumed
  event). Phase 1 reads events since the cursor alongside the pane snapshot.
- For a tracked pane: every event since the cursor is a change (`agent_state <from>→<to>` with the
  event ts), so a round trip is two changes. State start = ts of the last event whose `to` differs
  from its predecessor; `duration` from it. A state held 30 m past its start is reported once as
  the existing `agent_aged <state> <duration>` reason — keep the reason string, delete the
  epoch-based key.
- A pane with no events since the cursor and none in the log keeps today's level diff (the
  fallback for uninstrumented harnesses and pre-upgrade panes).
- Delete `scope.agent` as a baseline (keep it as a display field if the drawer reads it).
- Acceptance: idle → active → idle within one check gap yields a run; a Codex pane cleared by the
  reconciler ages; `rk operator check --json` shows the two transitions.

### E3 — Reconciler and wake on the log (run-kit)

- `internal/tmux/agent_codex.go`: when the reconciler replaces `waiting`, append a
  `source: reconciler` event instead of zeroing the epoch.
- `internal/cron/wake.go`: an entry's observation becomes the log's newest ts (per entry, the
  target pane still excluded); the fingerprint stays only as the fallback when the log is absent.

### E4 — Engine stores intent only (run-kit)

- `engineItem` keeps `branch` only as "the branch the engine created" and never reads it for a
  decision once the ledger has a `branch_map` entry for the item's change (E0 made the view do
  this; E4 removes the remaining direct reads and the projection write-back of `branch`).
- Status and the brief read the view; no behaviour change expected — this is deletion.

### M1 — Measure

Count, per server over a week: events appended; transitions the level diff would have missed
(consecutive events with the same `to` as the previous check saw); model runs per day vs the
week before (#1144's `agent_aged` runs). If runs rose, the aged rule is too eager, not the log.

---

## Open decisions (resolve at each step's intake)

| Step | Question |
|---|---|
| E1 | Byte cap (proposal: 512 KB, the cron log's) and whether trim runs in the hook or only in the daemon |
| E1 | Whether `pid` is worth carrying (the option carries it today) |
| E2 | Whether an event for an untracked pane is kept until tracked (so "track %9" sees its history) |
| E3 | Whether the wake's 60 s debounce stays, now that bursts are visible as events |

## Non-goals

- A dashboard history view (a later consumer of the same log).
- Replacing or renaming the pane option.
- Events for harnesses without lifecycle hooks (they keep the level fallback).
- Stage events: the pipeline stage is on disk and stays derived.
