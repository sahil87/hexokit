# Intake: Autopilot own state, mechanical runs, brief diet (R6r-ii)

**Change**: 261116-rxic-autopilot-own-state-mechanical-runs
**Created**: 2026-11-16

## Origin

> Implement step R6r-ii (Own engine state, mechanical runs, brief diet) of
> fab/plans/sahil/26-11-16-operator-autopilot-restructure.md: read that plan (Decisions, "Engine
> model", "Engine state file", "Escalations are notes", "Loop", the R6r-ii brief, Rules for the
> operator) and implement the R6r-ii brief in one change. R6r-i has merged (#1138); start from the
> rule-table engine on main. Copy the review bar (incl. the R6r-ii clause) and rules 6-7 into the
> intake non-goals. After the intake, stop and report; the operator will send /fab-fff.

One-shot `/fab-new` from the operator executing the plan. No prior conversation. The plan doc
(`fab/plans/sahil/26-11-16-operator-autopilot-restructure.md`) is the design authority: its
Decisions table, § Engine model (incl. § Escalations are notes, § Engine state file, § Loop),
§ R6r-ii brief, § Brief migration, § State-file keys and § Rules for the operator bind this
change. The apply agent SHOULD read those sections of the plan directly; this intake restates the
binding parts and records the decisions the plan leaves open or does not cover.

Starting point is `main` at `679cedf0` (R6r-i, #1138): `app/backend/internal/autopilot/` already
has the observe → derive → decide → execute shape (`observe.go`, `status.go`, `rules.go`,
`execute.go`, `spawn.go`, `step.go`, `merge.go`, `queue.go`, `passlock.go`), with engine state
in the tracked ledger's `scope` and the R6a scope allow-list (`internal/operator/ownership.go`).

## Why

1. **Every R6a design finding was "another writer changed an engine field mid-pass."** The pass
   lock serialises passes, but `rk operator track update`, `track rm`, `check` and hand edits all
   write the same ledger the engine stores its intent in. R6a covered that by enumeration — a
   deny-by-default scope allow-list (R28–R33) with a `--force` escape hatch and a drift test. A
   file nobody else writes removes the class by construction, and lets the allow-list go.
2. **Model runs still do mechanical work.** R1–R5 made quiet ticks free, but every detected
   change still launches a model run, and that run still carries `brief_autopilot.md` and an
   allowed-tool list with `git cherry-pick`/`rebase`/`push`, `gh pr merge`, `wt create`,
   `rk riff`. The series goal (plan § Decisions, Goal row): *a tick costs a model call only when
   judgment is needed.* After this change a merged PR or a stage advance that the rule table fully
   handles launches no model.
3. **A model that cannot force-push cannot force-push the wrong thing.** Deleting the prose and
   the git/gh write tools in one change (rather than across R6b/R6c) avoids two owners of the same
   job for months. Until R6b/R6c land, stacked restack and PR recovery are escalated (note +
   `rk notify`) and done by a human.

If not done: the allow-list stays as the only protection of engine state; R6b and R6c would have
to add keys to it; and every queue event keeps costing a model run.

## What Changes

Four parts, one change (plan § R6r-ii brief). Behaviour not listed here stays as R6r-i shipped
it.

### 1. Engine state file

**File**: `<state>/hexokit/operator/<slug>.autopilot.yaml`, beside the ledger (`<slug>.yaml`) and
the pass lock (`<slug>.autopilot.lock`); derive its path from `Env.StatePath` the way
`passLockPath` does. Mode `0600`, written through `internal/fsatomic`, **only** by
`rk operator autopilot` verbs while holding the pass lock. Reads are tolerant (unknown fields
ignored); a missing file is an empty engine. `status` reads it without the lock.

**Content**: the queue items and the PR items of every sequence, keyed by item id, in a stable
order (ledger order today drives execution order — keep an ordered list), plus per-sequence
structure (`merge_seq` order, mode). Every stored key from plan § State-file keys moves here.
Draft shape (apply finalises names; include a `version: 1`):

```yaml
version: 1
queue:
  - id: a1
    queue: a1-20261116T101500Z      # queue id stamped by `autopilot queue`
    repo: /home/u/code/foo
    change: ab12                    # or task: "...", or bare: true
    merge_mode: cherry-pick-ladder
    stop_stage: hydrate
    depends_on: [a0]
    paused: false                   # written by `stop`
    spawning: 2026-11-16T10:16:00Z  # intent marker
    respawned: false
    skipped: false
    pane: "%12"                     # binding, written right after launch
    session: foo
    branch: 261116-ab12-thing
    worktree: /home/u/code/foo.worktrees/swift-fox
    projected: true                 # see § Projection items
    done_at: null                   # monotone cache only
    escalated: {"spawn interrupted": 2026-11-16T10:20:00Z}
prs:
  - id: pr-41
    item: a1
    repo: /home/u/code/foo
    nwo: owner/foo
    pr: 41
    url: https://github.com/owner/foo/pull/41
    branch: 261116-ab12-thing
    change: ab12
    merge_seq: foo-...
    merge_mode: cherry-pick-ladder
    depends_on: [pr-40]
    deferred: false
    halted: false
    done_at: null
    escalated: {}
```

Stored-vs-derived (plan § Decisions) is unchanged: `armed`, `direct`, `stall_seen` are not stored
or read; only monotone `done_at` may be cached.

**One-time move.** Every lock-holding verb (`queue`, `step`, `merge`, `stop`, `rm`, `resume`)
first runs an idempotent migration: ledger items that are queue work (today's
`operator.IsQueueItem` predicate: `scope.queue`, or legacy non-null `scope.merge_mode`, or a
pane↔pane `depends_on` edge) or sequence PR items (`kind: github-pr` with `scope.merge_seq`) get
their engine keys copied into the engine file (an id already in the engine file keeps the engine
file's values — the file wins), the engine file is written (fsatomic), and **then** the engine keys
and `depends_on` are stripped from those ledger items in one locked ledger write. A crash between
the two writes leaves keys in both; the next run repeats the move harmlessly. Ledger items left
after stripping are projection items (below). A migrated unspawned queue item (no pane) is removed
from the ledger unless it has notes, in which case it stays as an identity-only projection so the
notes survive. The migration also absorbs any adopt-imported or hand-made queue items. Keys a step
stops using are ignored, never rewritten (plan § State-file keys).

**Delete the allow-list** (plan R6r-ii brief, R6a's R28–R33):

- `app/backend/internal/operator/ownership.go` and `ownership_test.go`,
  `app/backend/internal/autopilot/ownership_test.go` and `scopekeys_test.go`.
- Keep and relocate what is not allow-list: `validateMemo` and `mergeScope` (the `scope.memo`
  per-member merge, null deletes) move to `track.go` or a small `scope.go`; `IsQueueItem` survives
  only as the migration predicate (inside `internal/autopilot`, not exported from `operator`).
  The `Scope*` constants move to `internal/autopilot` (engine-file field names) — the operator
  package no longer knows engine keys.
- Remove the `--force` flag from `rk operator track add|update|rm` (`cmd/rk/operator_track.go`
  flags, help text, examples; `AddSpec.Force`, `UpdateSpec.Force`, the `force` arg of rm).
- Remove the armed-PR `track rm` refusal (`sequencePRItem`) and its exit-2 usage error.
- `track update --scope` and `track add --scope` go back to merging any key (no unknown-key
  refusal, no identity immutability, no owner refusals); memo semantics unchanged.
- Remove `--mode` from `track add` (usage error pointing at `rk operator autopilot queue`): it is
  the one remaining path that writes an engine key (`merge_mode`) onto a ledger item (rule 7).

### 2. Projection items

The ledger keeps only what `check`, the brief and the drawer need, as projection items the engine
adds and removes (plan § Engine state file table):

| Ledger item | Written by the engine when | Carries |
|---|---|---|
| `pane`, id = queue item id | `spawn` / `respawn` attaches a pane | `pane`, `session`, `repo`, `change`, `branch`, `stop_stage`, `spawned_by` — binding and identity only |
| `github-pr`, id = `pr-<n>` (existing collision rule) | `track-pr`, or `merge` starts a sequence | `repo`, `pr`, `change` |

- Projection items carry **no engine key** and `depends_on: []` — structure lives in the engine
  file.
- `check` keeps writing its own fields (`reported`, `last`, `checked_at`, `done_at`, pane
  conditions); the engine reads them as facts and never writes them. `pause`, `track update`,
  `track rm` and notes on a projection item are external facts the next pass observes:
  - **removed** projection (engine file says `projected: true`, ledger has no item) ⇒ escalate
    once (Q3's shape: note impossible, so `rk notify` + result line); the engine keeps managing
    the item from its own state and does not re-add the projection.
  - **paused** queue projection ⇒ queue status `paused` (same as engine-file `paused`).
  - **paused** PR projection ⇒ new PR status `paused` (after `merged`, before `halted`) ⇒ explicit
    `wait`: no ready, arm or merge; an already-armed PR is not disarmed (use `stop`).
  - **user note** ⇒ shown in the brief; drives the judgment set (§ 4).
- The engine records `projected: true` in the engine file after the projection write succeeds, so
  "never written" (re-project idempotently on the next pass) is distinguishable from "user
  removed" (escalate).
- **Escalation on a queue item with no projection yet** (pending item: fetch failure,
  cherry-pick conflict, readiness gate, `spawn-unknown`): the engine first adds an identity-only
  projection (no `pane`) to carry the note; a later spawn binds the pane onto that same item. This
  is the minimal extension needed for "the note goes on the item's ledger entry" before spawn.
- Pane liveness for queue statuses (`spawned`/`dead`/`spawn-unknown`) reads the engine file's own
  binding (`pane`) plus the pane snapshot; completion (`done`) still reads rk's pane map and the
  projection's `done_at` as facts.

**Executors.** The engine file is single-writer, so executors no longer defend engine fields
against foreign writes. Before each action the executor still re-reads the item (engine file, and
the projection for paused/removed/done facts) and skips it if it changed or vanished since
observe (plan § Pass step 4). Intent-first for non-idempotent actions is unchanged (`spawning`,
`respawned`), now written to the engine file.

### 3. Verbs

`rk operator autopilot` verbs, each taking the pass lock, writing intent to the engine file, then
running one pass (plan § Engine state file, last paragraph; § Action vocabulary):

| Verb | Change |
|---|---|
| `queue` | Now takes the pass lock (it writes the engine file) and runs one pass after writing. On `busy` the queue is **not** written: print `busy: another autopilot pass is running on this server; queue not written, retry` and exit 1 (the existing "operational failure, state busy" class). `--dry-run` takes no lock, as today. |
| `step` | Unchanged surface; reads/writes the engine file. |
| `merge` | Survives unchanged as a user command (writes `deferred: false`, builds PR chains, runs a pass) — the plan's proposed answer. It now **accepts** `stacked-prs` sequences (the refusal is replaced by the interim escalation below). |
| `stop` | Unchanged semantics, now on the engine file: `paused` on every unspawned unfinished queue item, `halted` on every not-done PR item, one pass (P3 disarms). |
| `rm <id>` (new) | Drops a queue item that has not spawned (no `pane`, no `spawning`), or a halted sequence (given any PR item id of it, or its `merge_seq`: removes all its PR items from the engine file and their projections). Anything else is a usage error (exit 2) naming why. Then one pass. |
| `resume <id>` (new) | Clears `halted`, `skipped` or `paused` on one engine item (paused added: `stop`'s pause has no other undo once `track resume` cannot reach engine state). Clearing `halted` on the one item that carries it resumes its cone (derived). Then one pass. |
| `status` | Read-only; engine file + ledger facts; no lock. |

Help text, exit codes and `--json` envelopes follow the existing verbs in
`cmd/rk/operator_autopilot.go`. Memory text that tells users to clear `spawning`/`halted` with
`track update --force` is replaced by `autopilot rm` / `autopilot resume`.

### 4. Escalations are notes

Per plan § Escalations are notes:

- An `escalate` action appends a note `by: run`, text prefixed `escalated: ` (capped at
  `operator.NoteTextCap`, as today) to the item's ledger entry (its projection) and sends
  `rk notify`. Always `by: run`, even when chat invoked `step` — a `by: chat` note would read as a
  user instruction to the judgment set.
- The dedupe key (`escalated` map) moves to the engine file; note and notify happen only on the
  first sighting of a key. Losing the key only repeats a notification.
- `autopilot.Env` gains a fail-silent `Notify func(ctx, title, body string)` seam; `cmd/rk` wires
  it to `sendNotify` (as `operator_run_exec.go` already does); tests pass a recorder or nil. Title
  is the item id (`"autopilot"` for item-less escalations), body the reason.
- An escalation with no ledger entry to hold it (item id `""` such as `step failed: …`, or a
  removed projection) is `rk notify` + `StepResult.Escalations` only.
- `StepResult.Escalations` stays, for the CLI's output only; nothing downstream depends on it.
- **Interim escalations** for what R6b/R6c own:
  - `restack needed: PR #<n>` — new interim row (call it **B0**) for a `stacked-prs` PR item whose
    predecessor PR item has merged: escalate once per PR (dedupe key includes the PR). For
    `stacked-prs` PR items in this step **only** P1 (`record-merged`), P2 (`closed` → `halt`), P3
    (`halted` + armed → `disarm`) and B0 fire; every other status is an explicit `wait` (no ready,
    no arm, no merge — P4/P7 for stacked are R6b). The user restacks/merges by hand or waits for
    R6b.
  - R6a's `recovery needed` (P5) stays, now as note + notify.
- The `decide` table test (rule 6) is extended to enumerate every reachable
  (item kind, merge mode, status) including `stacked-prs` PR items and the new `paused` PR status.

### 5. Mechanical pass in the run wrapper

Per plan § Loop. The daemon side (busy gate, `operator.Check`, `Changed == false` ⇒ `no change`)
is unchanged.

1. **Daemon** (`internal/operatorloop/runner.go` `launch`/`persistRun`): on `Changed`, persist the
   run record and open the run window as today, but **stop rendering the brief** there. The record
   must carry the changed items **with their reasons** (today `Record.Changed` is ids only; add a
   structured field, e.g. `changes: [{id, reasons}]`, keeping `changed` ids for existing readers)
   so the wrapper can compute the judgment set and render the brief.
2. **Wrapper** (`internal/operatorloop/exec.go` `Exec`, hidden `rk operator run-exec`): after
   recording the start, run the **mechanical pass** in-process through a new
   `ExecOptions.Pass func(ctx) (*autopilot.StepResult, error)` seam (or an equivalent operatorloop
   type, to keep the import direction clean); `cmd/rk/operator_run_exec.go` wires it to
   `autopilot.Step` with the production Env (`By: operator.ByRun`, same Runner/Spawner/Panes/
   Session/Notify wiring as `cmd/rk/operator_autopilot.go`). Record `pass: {actions, escalations,
   busy, error}` in the run record. A `busy` pass (chat holds the lock) is recorded and the wrapper
   continues — the chat pass owns those actions (plan's proposed answer; no bounded wait). A pass
   error is recorded and the wrapper continues to step 3 (the error was already escalated).
3. **Judgment set** (plan § Loop step 3, verbatim rule): changed items whose reasons include
   `agent_state` (`waiting`/`idle`), `due`, `stale`, `paused`, `unknown_dep`, a `done` with a
   non-empty `then`, or a pane condition (`pane_death`, `pane_mismatch`, `agent_exited`) on an item
   the engine does not own (id not in the engine file); **plus** every item the pass escalated;
   **plus** any ledger item with a `by: user` or `by: chat` note newer than its last `by: run` note.
   Reasons the rows own (`stage_advance`, `review_fail`, `changed` on a PR item, a queue item's
   `pane_death`, a `done` without `then`) are not judgment.
4. **Empty set** ⇒ write `outcome: mechanical · <n> actions` (n = len(pass actions)) as the
   record's outcome, record the end with exit 0, run **no** launcher, call no model.
   **Non-empty** ⇒ render the brief now (`operator.RenderBrief` with the judgment set as the
   changed list, from a fresh ledger load so it shows the post-pass state), write it to the run's
   brief path, then run the launcher exactly as today (failure-note contract unchanged).
5. **Transcription** (`transcribe.go`): a mechanical run transcribes as
   `ran · mechanical · <n> actions · <duration>` (falls out of the existing
   `ran · <outcome> · <dur>` shape — verify, and add a test). Retention unchanged (newest 50;
   mechanical runs count — plan's proposed answer).
6. **Drawer**: the Operator Tasks drawer / cron log (`app/frontend/src/components/cron-log.tsx`,
   `cron-entry-detail-sheet.tsx`, `watched-tasks.tsx`) must render the mechanical line and show
   escalation notes legibly; adjust only if the existing rendering does not (tests either way).
7. **Integration test**: R5's Go integration test on an isolated tmux socket gains one
   mechanical-only run (changed set fully handled ⇒ no launcher, outcome `mechanical · …`,
   transcription line).

`rk operator autopilot step` from chat still runs the same `autopilot.Step` and is the way to force
a pass between ticks.

### 6. Brief diet

- Delete `app/backend/internal/operator/brief_autopilot.md`, its `//go:embed` + `briefAutopilot`
  var, and the "Interim autopilot" `writeSection` in `brief.go` (and its truncation-protection
  mention). Update `testdata/brief_golden.md`.
- `brief_rules.md`:
  - **Allowed tools** lose every git/gh write and every queue-spawn tool: `rk tab new`,
    `rk riff`, `wt create`, `git fetch`, `git cherry-pick`, `git rebase`, `git commit`,
    `git push`, `gh pr ready`, `gh pr merge`, `fab status set-base-branch`. Keep read-only git
    (`git rev-parse`, `symbolic-ref`, `merge-base`, `log`), `gh pr view|checks`, `gh repo view`,
    `fab pane map`, reading `.status.yaml`, `fab agent … -o yaml`, the `rk operator track` verbs,
    `rk mux capture|send|inventory`, `rk notify`, and `rk operator autopilot queue|step|status`.
  - **Direct-action allowlist** (Role section): drop "queue spawns, dependency cherry-picks and
    the merge-auto merge happen inside it" phrasing for the run and "(queue items only) PR
    recovery"; the run reports escalation notes, never performs them.
  - **Confirmation tiers**: drop "rebase or cherry-pick for dependency resolution" from
    Recoverable and the `merge-auto` merge exception — merges are the engine's.
  - **Bounded retries**: drop the cherry-pick, rebase, pane-death and PR-recovery rows (keep the
    stuck-nudge and send-to-active rows).
  - **Item memo** text: drop "`--scope` accepts only the keys rk defines" and "Autopilot's own
    fields … are not yours to write" (no engine field exists on ledger items).
  - **Agent probes**: a spawn is `rk operator autopilot queue` (which now runs a pass itself);
    drop the pointer to "the autopilot section".
  - Add one short line: escalation notes (`escalated: …`) are the engine's; report them, do not
    perform the restack/recovery they name.
- **Chat skill** (`docs/site/skill/operator.md`, synced to `app/backend/cmd/rk/skill/operator.md`
  by `scripts/sync-skill.sh`): keep the queue-creation text; point every mechanical action at
  `rk operator autopilot` verbs (`queue`, `step`, `merge`, `stop`, `rm`, `resume`, `status`);
  remove `--force` repair recipes and allow-list gotchas.
- **Rule 5 test**: a test renders the brief and asserts there is no autopilot section
  (`## Interim autopilot` absent, no embedded autopilot text) and the allowed-tool list names no
  git/gh write (none of `git cherry-pick`, `git rebase`, `git push`, `git commit`, `git fetch`,
  `gh pr merge`, `gh pr ready`, `wt create`, `rk riff`, `rk tab new`, `fab status set-base-branch`).

### 7. Tests and gates

- `decide` table test per rule 6, extended (stacked-prs PR items, `paused` PR status, B0).
- Engine-file store tests: tolerant read, missing file = empty, `0600`, fsatomic, written only
  under the pass lock; migration tests (keys moved, ledger stripped, idempotent re-run, crash
  between the two writes, unspawned-with-notes kept, file-wins on conflict).
- Projection tests: spawn adds projection; removed projection escalates once; paused projection
  derives `paused`; identity-only projection for a pre-spawn escalation then pane bound on spawn.
- Escalation tests: note `by: run` + `escalated: ` prefix, notify once per key, item-less
  escalation notify-only.
- Verb tests: `queue` busy ⇒ not written, exit 1; `rm` / `resume` happy and refusal paths;
  `merge` accepts stacked-prs.
- `operatorloop` tests: pass recorded, busy continues, empty judgment ⇒ no launcher + outcome,
  non-empty ⇒ brief rendered post-pass with the judgment set, transcription line; the isolated
  socket integration test.
- Track tests updated: no `--force`, any scope key merges, no armed-PR rm refusal, `--mode`
  refused.
- Gates: `just test-backend` plus
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1`
  (from `app/backend`); frontend tests if the drawer changes. Known host-only failures
  (`cmd/rk TestPortPinRowRealPolicyValues`, `rk/api TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`)
  do not block.
- **PR evidence**: Operator Tasks drawer showing a mechanical run line and an escalation note,
  desktop + mobile (Constitution § PR Evidence).

### Non-goals (binding — copied from the plan)

**Review bar** (plan § Decisions, verbatim, incl. the R6r-ii clause) — every review dispatch
quotes it:

> **Must-fix**: anything that can merge, arm, push, force-push or delete the wrong thing; lose or
> corrupt state-file data; launch a duplicate agent *under the single-writer rule*; crash the CLI;
> or break a requirement in the step's plan. **Should-fix** (does not block): failure cases the
> pass lock rules out, tmux pane-id reuse, missing escalations for read-only probes, and cosmetics.
> From R6r-ii, a finding that needs an external write to the engine file (a hand edit) is out of
> scope.

**Rule 6** (plan § Rules for the operator, verbatim):

> From R6r-i on, autopilot behaviour is added only as a status case, a rule row and an executor.
> A `decide` table test enumerates every reachable (item kind, merge mode, status) and asserts the
> row that fires, or an explicit `wait`. A behaviour outside the table, or a reachable combination
> with no outcome, is must-fix.

**Rule 7** (plan § Rules for the operator, verbatim):

> From R6r-ii on, the engine file is written only under the pass lock. A step never adds an engine
> key to a ledger item, and never reads a ledger item's `scope` for a decision beyond the
> projection keys listed in § Engine state file.

Also out of scope for this step:

- `stacked-prs` merge-all (status `stale-base`, row B1, the `restack` executor, P4/P7 for stacked)
  — R6b. PR recovery (rows C1–C6, F1, their executors; removing P5) — R6c.
- Hardening against hand edits of the engine file, races the pass lock rules out, tmux pane-id
  reuse (accepted under the review bar).
- `stop` returning `busy` while another pass holds the lock is pre-existing R6a behaviour and is
  not changed here (see Open Questions).
- Deleting the reference branch `261114-8w1x-r6-full-reference` (no step owns it until R6b+R6c
  merge).

## Affected Memory

- `run-kit/operator-autopilot`: (modify) engine state file, one-time move, projection items,
  `rm`/`resume` verbs, `queue` takes the lock, escalations as notes + notify, interim B0
  `restack needed` row and stacked-prs waits, `paused` PR status, judgment set; remove the
  "Scope ownership" requirement and `--force` recipes; update the out-of-scope list.
- `run-kit/operator-state`: (modify) projection items and engine-owned fields gone from the
  ledger; remove § Scope ownership (allow-list, `--force`, `scope.memo` stays as free scope with
  per-member merge); `track add` without `--mode`; `track rm` without the armed-PR refusal;
  engine file sits beside the ledger and pass lock.
- `run-kit/operator-loop`: (modify) decision order gains the mechanical phase in the wrapper; record
  `pass` block and structured changes; judgment set; brief rendered by the wrapper post-pass;
  `outcome: mechanical · <n> actions`; transcription line `ran · mechanical · <n> actions · <dur>`.
- `run-kit/operator-brief`: (modify) no interim autopilot section; allowed tools and direct-action
  allowlist without git/gh writes and queue-spawn tools; bounded retries trimmed; memo text; chat
  skill pointing at autopilot verbs; brief rendered from the judgment set.

## Impact

- **Backend Go** (`app/backend`): `internal/autopilot/` (new engine-file store + migration;
  `observe`, `status`, `rules`, `execute`, `spawn`, `step`, `merge`, `queue`, `autopilot.go` Env +
  escalation; tests incl. deleting `ownership_test.go`, `scopekeys_test.go`); `internal/operator/`
  (delete `ownership.go`/`ownership_test.go`; `track.go` scope merge, no Force, no rm refusal, no
  `--mode`; `brief.go`, delete `brief_autopilot.md`, edit `brief_rules.md`, golden); 
  `internal/operatorloop/` (`exec.go`, `runner.go`, `record.go`, `transcribe.go`, tests,
  integration test); `cmd/rk/` (`operator_autopilot.go` new verbs + queue busy + Notify wiring,
  `operator_track.go` flags/help, `operator_run_exec.go` Pass wiring).
- **Skill docs**: `docs/site/skill/operator.md` → `app/backend/cmd/rk/skill/operator.md` (sync).
- **Frontend**: possibly `cron-log` / drawer rendering and tests (only if needed).
- **On-disk**: new `<slug>.autopilot.yaml` per server; existing ledgers migrated in place on the
  first lock-holding verb (no manual step).
- **Size**: M per the plan; large diff because of deletions and test moves.
- **Downstream**: R6b and R6c start from this (rows + executors on the engine file).

## Open Questions

- `stop` exits 0 with `busy` when a pass holds the lock. With mechanical passes now running from
  the wrapper on every changed tick, a user `stop` is more likely to land on `busy`. Not changed
  here (pre-existing; review bar treats lock races as should-fix) — worth a follow-up decision
  (bounded wait for `stop`, or a durable stop-request the next pass honours).
- M1 baseline ("model runs per queue event") must be recorded **before** this change lands
  (plan § Current state) — an operator chore outside this change.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is exactly the plan's R6r-ii brief (engine file + projections + `rm`/`resume`, escalations as notes, mechanical pass in the wrapper with judgment-only runs, brief diet, docs, PR evidence) in one change, starting from R6r-i on main | User instruction and plan § R6r-ii brief | S:95 R:70 A:95 D:95 |
| 2 | Certain | Review bar (incl. R6r-ii clause) and rules 6–7 copied verbatim into Non-goals; review dispatches quote them | User instruction; plan rule 2 | S:95 R:90 A:95 D:95 |
| 3 | Certain | Engine file `<state>/hexokit/operator/<slug>.autopilot.yaml`, 0600, fsatomic, written only by autopilot verbs under the pass lock; tolerant read; missing = empty | Plan § Engine state file, § Decisions | S:95 R:70 A:90 D:90 |
| 4 | Certain | Delete ownership.go(+test), autopilot ownership_test/scopekeys_test, `--force` on track add/update/rm, the armed-PR rm refusal; `track update --scope` merges any key; memo merge semantics kept and relocated | Plan R6r-ii brief lists these deletions; memo is not allow-list | S:90 R:75 A:85 D:85 |
| 5 | Certain | Identity-key immutability (part of the allow-list) goes too | Plan: "`track update --scope` goes back to merging any key" | S:85 R:80 A:80 D:80 |
| 6 | Confident | One-time move runs at the start of every lock-holding verb, idempotent: engine file written first (file wins on conflict), then ledger keys + depends_on stripped; unspawned queue items removed from the ledger unless they carry notes | Plan § State-file keys says move once under the lock; ordering gives crash safety without data loss | S:75 R:70 A:80 D:70 |
| 7 | Confident | An escalation on a queue item with no projection creates an identity-only projection (no pane) to hold the note; spawn later binds the pane onto it | Plan names only spawn/respawn as projection triggers but requires escalations to land as ledger notes; pre-spawn escalations need a home | S:50 R:70 A:60 D:55 |
| 8 | Confident | Engine file records `projected: true` after a successful projection write, so a missing projection is re-added (never written) or escalated (user removed) | Plan says a removed projection is an escalation but gives no way to tell it from a failed write | S:55 R:80 A:70 D:60 |
| 9 | Confident | Removed projection ⇒ escalate once via notify + result (no ledger home); engine keeps managing from its own state and does not re-add it | Plan § Engine state file: "a removed projection item is an escalation"; re-adding would fight the user's rm | S:80 R:80 A:75 D:70 |
| 10 | Confident | Paused PR projection ⇒ new PR status `paused` ⇒ explicit wait (no ready/arm/merge, no disarm) | Plan: "a paused one is paused" with no PR-table row; rule 6 requires an outcome; wait is the conservative one | S:55 R:85 A:65 D:55 |
| 11 | Confident | Engine keeps its own spawn binding (pane, session, branch, worktree) in the engine file for liveness; projection mirrors it for check/drawer; done_at and paused read from projections as facts | Rule 7 allows reading projection keys, but engine decisions from its own file avoid depending on an externally editable item | S:65 R:75 A:75 D:65 |
| 12 | Certain | Escalate = note `by: run`, `escalated: ` prefix, + `rk notify`, once per dedupe key (key in engine file); StepResult.Escalations kept for CLI output only | Plan § Escalations are notes | S:90 R:80 A:85 D:85 |
| 13 | Certain | Escalation notes are always `by: run`, even from chat-invoked `step`; item-less escalations are notify + result only; Env gains a fail-silent Notify seam wired to sendNotify | Plan specifies `by: run`; a chat-authored note would enter the judgment set as a user instruction | S:80 R:85 A:80 D:80 |
| 14 | Confident | Interim stacked-prs: `merge` accepts them; only P1, P2, P3 and new row B0 (`restack needed: PR #<n>` once, predecessor merged) fire; every other stacked status is an explicit wait | Plan R6r-ii brief + § Brief migration interim; P4/P7 for stacked are R6b | S:80 R:75 A:75 D:70 |
| 15 | Confident | `queue` takes the pass lock and runs one pass; on busy the queue is not written, prints busy, exits 1 | Plan: every verb takes the lock then runs a pass; rule 7 forbids writing the engine file without it; exit 0 would mislead a run into recording `--seen` | S:75 R:85 A:75 D:70 |
| 16 | Confident | `merge` survives unchanged as a user verb; `rm <id>` drops an unspawned queue item or a halted sequence; `resume <id>` clears halted, skipped or paused | Plan's proposed answer for merge; plan lists rm/resume; paused added because stop's pause has no other undo once engine state leaves the ledger | S:80 R:80 A:75 D:70 |
| 17 | Certain | Wrapper `busy` pass is recorded and the wrapper continues (no bounded wait); mechanical-only runs count toward newest-50 retention | Plan open decisions, proposed answers adopted | S:85 R:85 A:80 D:80 |
| 18 | Confident | Mechanical pass runs through an `ExecOptions.Pass` seam wired in cmd/rk to `autopilot.Step` (By: run); the daemon stops rendering the brief and the record carries changed items with reasons; the wrapper renders the brief post-pass from the judgment set | Plan § Loop steps 2–4; reasons are needed for the judgment set and today's record stores ids only | S:80 R:75 A:80 D:75 |
| 19 | Certain | Judgment set exactly as plan § Loop step 3; empty ⇒ `outcome: mechanical · <n> actions`, no launcher; transcription `ran · mechanical · <n> actions · <dur>` | Plan § Loop | S:90 R:75 A:85 D:85 |
| 20 | Certain | Brief diet: delete brief_autopilot.md, embed, Interim section; strip git/gh write and queue-spawn tools, the allowlist items, the bounded-retry rows; rule 5 test | Plan § Decisions Brief diet, R6r-ii brief, rule 5 | S:90 R:75 A:90 D:85 |
| 21 | Confident | Runs keep `rk operator autopilot` queue, step and status only; `rm`, `resume`, `merge`, `stop` are user/chat verbs not in the run's allowed tools; `git fetch` and `git commit` also leave the list | Plan is silent on run access to the new verbs; least privilege for an unattended run; rule 5 says no git write | S:55 R:85 A:70 D:60 |
| 22 | Confident | `track add --mode` is removed (usage error pointing at `autopilot queue`) | Rule 7: no step adds an engine key to a ledger item; `--mode` writes `merge_mode` on a ledger item; but the plan does not mention it and it removes a user-facing flag | S:50 R:65 A:70 D:60 |
| 23 | Certain | Chat skill edited at `docs/site/skill/operator.md` and synced to `cmd/rk/skill/operator.md` via scripts/sync-skill.sh | Repo layout: the two files are identical and the sync script owns the copy | S:70 R:90 A:80 D:80 |
| 24 | Certain | PR evidence: drawer with a mechanical run line and an escalation note, desktop + mobile | Plan R6r-ii brief + Constitution § PR Evidence | S:80 R:90 A:80 D:80 |
| 25 | Certain | Gates: `just test-backend` + `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1`; the two known host-only failures do not block | Plan pipeline notes | S:80 R:90 A:85 D:85 |

25 assumptions (13 certain, 12 confident, 0 tentative, 0 unresolved).
