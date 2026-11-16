# Plan: Autopilot own state, mechanical runs, brief diet (R6r-ii)

**Change**: 261116-rxic-autopilot-own-state-mechanical-runs
**Intake**: `intake.md`

> Design authority: `fab/plans/sahil/26-11-16-operator-autopilot-restructure.md` (§ Decisions,
> § Engine model incl. § Escalations are notes / § Engine state file / § Loop, § R6r-ii brief,
> § Brief migration, § State-file keys, § Rules for the operator). All paths below are relative to
> the repo root; Go paths are under `app/backend/`.

## Requirements

### Autopilot: Engine state file

#### R1: Engine-owned state file
The engine's stored state SHALL live in `<state>/hexokit/operator/<slug>.autopilot.yaml`, derived
from `Env.StatePath` the same way `passLockPath` derives `<slug>.autopilot.lock`. The file MUST be
written with mode `0600` through `internal/fsatomic`, and ONLY by `rk operator autopilot` verbs
while holding the pass lock (`queue`, `step`, `merge`, `stop`, `rm`, `resume`). It SHALL carry a
`version: 1` field, an ordered list of queue items and an ordered list of PR items (order = today's
ledger order, which drives execution order), each keyed by id, holding every stored key of plan
§ State-file keys (`queue`, `merge_mode`, `task`/`change`/`bare`, `repo`, `stop_stage`,
`depends_on`, `paused`, `spawning`, `respawned`, `skipped`, spawn binding `pane`/`session`/
`branch`/`worktree`, `projected`, `done_at`, `escalated`; for PR items `item`, `repo`, `nwo`,
`pr`, `url`, `branch`, `change`, `merge_seq`, `merge_mode`, `depends_on`, `deferred`, `halted`,
`done_at`, `escalated`). Reads SHALL be tolerant (unknown fields ignored); a missing file SHALL
read as an empty engine. Non-monotone facts (`armed`, `direct`, mergeable, checks, base, head)
MUST NOT be stored.

- **GIVEN** a server with no `<slug>.autopilot.yaml`
- **WHEN** `rk operator autopilot status` runs
- **THEN** it reports an empty queue without error and creates no file
- **AND** after `rk operator autopilot queue` writes items, the file exists with mode `0600`

- **GIVEN** a pass holds the pass lock
- **WHEN** any engine-file write happens
- **THEN** it happens inside that lock (no engine-file write path exists outside a lock-holding verb; `--dry-run` writes nothing)

#### R2: One-time move of engine keys out of the ledger
Every lock-holding verb SHALL first run an idempotent migration: ledger items that are queue work
(the R6a `IsQueueItem` predicate — `scope.queue`, or a non-null legacy `scope.merge_mode`, or a
pane↔pane `depends_on` edge) or sequence PR items (`kind: github-pr` with `scope.merge_seq`) have
their engine keys and `depends_on` copied into the engine file, where an id already present in the
engine file keeps the engine file's values. The engine file MUST be written first; THEN, in one
locked ledger write, the engine keys are stripped from those ledger items and their `depends_on`
set to `[]`. A migrated queue item with no pane is removed from the ledger unless it carries notes,
in which case it remains as an identity-only projection. A crash between the two writes MUST be
repaired by the next verb without data loss. A ledger with no engine keys SHALL produce no write.

- **GIVEN** a ledger written by R6r-i holding a spawned queue item `a1` (with `queue`, `merge_mode`, `respawned`, `escalated`, `pane`) and a PR item `pr-41` (with `merge_seq`, `item`, `halted`)
- **WHEN** `rk operator autopilot step` runs
- **THEN** the engine file holds `a1` and `pr-41` with those keys and dependencies
- **AND** the ledger items `a1` and `pr-41` keep only projection keys (`pane`, `session`, `repo`, `change`, `branch`, `stop_stage`, `spawned_by` / `repo`, `pr`, `change`), their notes and their `check` fields, with `depends_on: []`

- **GIVEN** the engine file was written but the process died before the ledger strip
- **WHEN** the next verb runs
- **THEN** the move repeats, the engine file's values win, and the ledger ends stripped

#### R3: Projection items
The ledger SHALL hold only projection items for engine work: a `pane` item (id = queue item id)
added when `spawn`/`respawn` attaches a pane, carrying `pane`, `session`, `repo`, `change`,
`branch`, `stop_stage`, `spawned_by`; and a `github-pr` item (id `pr-<n>` with the existing
collision rule) added by `track-pr` or when `merge` starts a sequence, carrying `repo`, `pr`,
`change`. Projection items MUST carry no engine key and `depends_on: []`. After a successful
projection write the engine SHALL record `projected: true` on the engine item; a spawned/tracked
engine item with `projected` unset and no ledger item SHALL be re-projected (idempotent) on the
next pass. `check`'s fields (`reported`, `last`, `checked_at`, `done_at`, conditions) are read by
the engine as facts and never written by it. The engine MUST NOT read a ledger item's `scope` for
a decision beyond the projection keys (rule 7).

- **GIVEN** a pending queue item `a1`
- **WHEN** the spawn executor opens its window
- **THEN** `spawning` then the binding are written to the engine file, a `pane` ledger item `a1` with the binding/identity keys appears, and `projected: true` is recorded
- **AND** the ledger item has no `queue`, `merge_mode`, `spawning`, `respawned`, `skipped`, `escalated` key

#### R4: Projection facts observed by the engine
The engine SHALL observe projection items as external facts:
- a **removed** projection (engine item has `projected: true`, ledger has no item of that id) SHALL
  escalate once (notify + result line, no ledger note); the engine keeps managing the item from
  its own state and SHALL NOT re-add the projection;
- a **paused** queue projection SHALL derive queue status `paused` (same as engine-file `paused`);
- a **paused** PR projection SHALL derive a new PR status `paused`, ordered after `merged` and
  before `halted`, whose only outcome is an explicit `wait` (no ready/arm/merge; no disarm);
- an escalation on a queue item with no projection yet SHALL first add an identity-only `pane`
  projection (no `pane` key) to hold the note; a later spawn binds the pane onto that same item.
Pane liveness for queue statuses (`spawned`, `dead`, `spawn-unknown`) SHALL read the engine file's
own binding; completion SHALL read rk's pane map and the projection's `done_at`.

- **GIVEN** a merged-auto PR item `pr-41` whose projection the user paused (`track pause pr-41`)
- **WHEN** a pass runs and the PR is green and not armed
- **THEN** its status is `paused` and no `merge`/`arm`/`ready` action is decided for it

- **GIVEN** a spawned queue item whose projection the user removed with `track rm`
- **WHEN** a pass runs twice
- **THEN** one escalation (`projection removed: …`) is notified on the first pass only, and no projection is re-added

- **GIVEN** a pending queue item whose dependency cherry-pick conflicts
- **WHEN** the spawn executor escalates
- **THEN** a ledger `pane` item `a1` without `pane` exists carrying the `escalated: …` note, and a later successful spawn binds `pane`/`session`/`branch` onto it

#### R5: Allow-list removed from the ledger CLI
The R6a scope allow-list SHALL be deleted: `internal/operator/ownership.go` + `ownership_test.go`,
`internal/autopilot/ownership_test.go` and `scopekeys_test.go`; `AddSpec.Force`,
`UpdateSpec.Force`, the `--force` flag on `rk operator track add|update|rm`; the `track rm` refusal
of a not-done sequence PR item. `track add --scope` and `track update --scope` SHALL merge any key
(no unknown-key, owner or identity-immutability refusal); `scope.memo` validation and per-member
merge (null deletes a member, null clears the map) SHALL be kept. `track add --mode` SHALL be
removed: passing it is a usage error (exit 2) naming `rk operator autopilot queue`. The `Scope*`
engine-key constants SHALL no longer be exported from `internal/operator`.

- **GIVEN** a tracked item `x`
- **WHEN** `rk operator track update x --scope '{"foo":1,"spawning":"t"}'` runs
- **THEN** it exits 0 and `scope.foo` and `scope.spawning` are set on the ledger item (the engine never reads them)

- **GIVEN** any `rk operator track` verb
- **WHEN** `--force` is passed
- **THEN** cobra reports an unknown flag (usage error)

#### R6: Executors on the engine file
Executors SHALL read and write engine state through the engine file. Before each action the
executor SHALL re-read the item (engine file, plus its projection for paused/removed/done facts)
and skip it if it changed or vanished since observe. Non-idempotent actions SHALL keep writing
their intent first (`spawning`; `respawned` + `spawning`). Behaviour of every R6r-i row not named
in this plan SHALL be unchanged.

- **GIVEN** a decided `spawn` for `a1`
- **WHEN** the user pauses `a1`'s projection between observe and execute
- **THEN** the executor skips `a1` this pass

### Autopilot: Verbs

#### R7: `queue` writes under the pass lock
`rk operator autopilot queue` SHALL take the pass lock, run the migration, write the new items to
the engine file (not the ledger), and then run one pass. When another pass holds the lock the queue
MUST NOT be written: it prints `busy: another autopilot pass is running on this server; queue not written, retry`
and exits 1. `--dry-run` takes no lock and writes nothing, as today. Validation (ids, repos,
dependency order, misfits, mode resolution) is unchanged, but id uniqueness SHALL be checked
against both the engine file and the ledger.

- **GIVEN** a chat pass holds the pass lock
- **WHEN** a run pipes one entry to `rk operator autopilot queue`
- **THEN** it exits 1 with the busy message and neither file changes

#### R8: `rm <id>`
`rk operator autopilot rm <id>` SHALL take the pass lock and drop either (a) a queue item that has
not spawned (no `pane`, no `spawning`) — removing it and its identity-only projection; `rm` SHALL
refuse a queue item that another not-done queue item depends on (usage error naming the
dependents), since dropping the edge would let the dependent spawn without its dependency; or
(b) a halted sequence, named by any of its PR item ids or its `merge_seq` — removing every PR item
of the sequence from the engine file and their projections. Anything else SHALL be a usage error
(exit 2) naming why (spawned, spawning, not halted, unknown id). It then runs one pass.

- **GIVEN** pending `a2` with no dependents
- **WHEN** `rm a2` runs
- **THEN** `a2` is gone from the engine file and the ledger, and the result reports it

- **GIVEN** spawned `a1`
- **WHEN** `rm a1` runs
- **THEN** exit 2 with a message that it has spawned

#### R9: `resume <id>`
`rk operator autopilot resume <id>` SHALL take the pass lock, clear `halted`, `skipped` or
`paused` on that one engine item (a usage error, exit 2, when none is set or the id is unknown),
and run one pass. Clearing `halted` on the item that carries it resumes its derived cone.

- **GIVEN** `stop` paused unspawned `a3` and halted `pr-41`
- **WHEN** `resume a3` and `resume pr-41` run
- **THEN** `a3` is pending again and `pr-41`'s sequence advances on later passes

#### R10: `merge`, `stop`, `status` on the engine file
`merge` SHALL keep its surface (writes `deferred: false`, builds PR chains, runs a pass) on the
engine file and SHALL accept `stacked-prs` sequences (the refusal is removed). `stop` SHALL write
`paused` on every unspawned unfinished queue item and `halted` on every not-done PR item in the
engine file, then run one pass. `status` SHALL read the engine file and ledger facts, take no lock
and write nothing. All verb help texts and exit-code lists SHALL describe the engine file and the
new verbs, and drop every `track update --force` recipe.

- **GIVEN** a complete `stacked-prs` queue
- **WHEN** `rk operator autopilot merge` runs
- **THEN** PR chain items are created (engine file + projections) instead of a refusal

### Autopilot: Escalations are notes

#### R11: Escalation note and notify
An `escalate` SHALL, on the first sighting of its dedupe key only, append a note `by: run` with text
`escalated: <reason>` (capped at `operator.NoteTextCap`) to the item's ledger entry and send a
fail-silent notification through a new `Env.Notify func(ctx context.Context, title, body string)`
seam (title = item id, or `autopilot` for an item-less escalation; body = reason). Notes SHALL be
`by: run` regardless of `Env.By`. The dedupe map (`escalated`) SHALL live on the engine item.
An escalation with no ledger entry able to hold it (item `""`, or a removed projection) SHALL be
notify + `StepResult.Escalations` only. `StepResult.Escalations` SHALL remain for CLI output.
`cmd/rk` SHALL wire `Notify` to `sendNotify` for every verb; tests MAY pass nil.

- **GIVEN** a `spawn-unknown` item escalated on pass 1
- **WHEN** pass 2 sees the same condition
- **THEN** exactly one note and exactly one notification exist, and both passes list the escalation in their results

- **GIVEN** chat runs `step` (`By: chat`)
- **WHEN** it escalates
- **THEN** the note's `by` is `run`

#### R12: Interim rows for stacked-prs and recovery
A new interim row **B0** SHALL fire for a `stacked-prs` PR item whose upstream PR item has merged
and which is not itself merged/closed/halted/paused: action `escalate` with reason
`restack needed: PR #<n>`, once per PR (dedupe key includes the PR number). For `stacked-prs` PR
items only P1, P2, P3 and B0 SHALL fire; every other status SHALL be an explicit `wait` (no
`ready`, `arm` or `merge`). P5 (`recovery needed`) SHALL remain and now escalate as a note +
notify. The `decide` table test SHALL enumerate every reachable (item kind, merge mode, status),
including `stacked-prs` PR items and the `paused` PR status, and assert the row or the explicit
`wait` (rule 6).

- **GIVEN** a `stacked-prs` sequence `pr-1 → pr-2` where `pr-1` merged and `pr-2` is green
- **WHEN** a pass runs
- **THEN** `pr-2` gets B0 (`restack needed: PR #2`) and is never merged, readied or armed

### Operator loop: Mechanical runs

#### R13: Run record carries changes with reasons; daemon does not render the brief
The daemon's launch (`operatorloop` `launch`/`persistRun`) SHALL persist the run record before the
window opens as today, adding the changed items with their reasons (e.g. `changes: [{id, reasons}]`,
keeping `changed` ids), and SHALL NOT render the brief. Launch failure notes and lost-run handling
stay unchanged.

- **GIVEN** a check reporting `a1: stage_advance apply→review` and `w1: due 5m`
- **WHEN** the daemon launches the run
- **THEN** the record holds both ids with those reason strings and no brief file exists yet

#### R14: Mechanical pass in the wrapper
`operatorloop.Exec` SHALL, after recording the start, run the mechanical pass through a new
`ExecOptions.Pass` seam before any launcher, and record `pass: {actions, escalations, busy, error}`
in the run record. `cmd/rk/operator_run_exec.go` SHALL wire `Pass` to `autopilot.Step` with the
production Env (same Runner/Spawner/Panes/Session/Notify wiring as `operator_autopilot.go`,
`By: operator.ByRun`). A `busy` pass SHALL be recorded and the wrapper SHALL continue (no wait);
a pass error SHALL be recorded and the wrapper SHALL continue.

- **GIVEN** chat holds the pass lock when a run starts
- **WHEN** the wrapper runs
- **THEN** the record's `pass.busy` is true and judgment-set evaluation proceeds

#### R15: Judgment set
The wrapper SHALL compute the judgment set as: changed items whose reasons include `agent_state`
(to `waiting`/`idle`), `due`, `stale`, `paused`, `unknown_dep`, a `done` (completion) with a
non-empty `then`, or a pane condition (`pane_death`, `pane_mismatch`, `agent_exited`) on an item
whose id is not in the engine file; PLUS every item the pass escalated; PLUS every ledger item with
a `by: user` or `by: chat` note newer than its last `by: run` note. `stage_advance`, `review_fail`,
`changed` on a PR item, a queue item's `pane_death`, and a `done` without `then` SHALL NOT be
judgment. The function SHALL be pure and table-tested.

- **GIVEN** a changed list of only `a1: stage_advance` and `pr-41: changed state` (both engine-owned), and no new user notes
- **WHEN** the judgment set is computed
- **THEN** it is empty

#### R16: Mechanical-only and judgment runs
An empty judgment set SHALL end the run with outcome `mechanical · <n> actions` (n = pass actions),
exit code 0, and no launcher started and no model called. A non-empty set SHALL render the brief
then — `operator.RenderBrief` from a fresh ledger load with the judgment set as the changed list —
write it to the run's brief path, and run the launcher as today (failure-note contract
unchanged).

- **GIVEN** an empty judgment set after a pass with 2 actions
- **WHEN** the wrapper finishes
- **THEN** the record has `outcome: mechanical · 2 actions`, `exit_code: 0`, and the launcher was never invoked

#### R17: Transcription, retention, drawer
A mechanical run SHALL transcribe as `ran · mechanical · <n> actions · <duration>`. Retention SHALL
stay newest-50 with mechanical runs counted. The Operator Tasks drawer / cron log SHALL render the
mechanical line and escalation notes legibly (frontend changed only if the existing rendering does
not; covered by a test either way).

- **GIVEN** a finished mechanical run record
- **WHEN** the tick transcribes it
- **THEN** exactly one line `ran · mechanical · 2 actions · <dur>` is appended

#### R18: Isolated-socket integration test
R5's operator-loop integration test on an isolated tmux socket SHALL gain one mechanical-only run
(changed set fully handled ⇒ no launcher, mechanical outcome, transcription line).

- **GIVEN** the isolated-socket rig
- **WHEN** a tick fires with only engine-owned changes
- **THEN** the run window exits without invoking the stub launcher and the cron log gains the mechanical line

### Operator brief: Brief diet

#### R19: Brief without autopilot prose or git/gh writes
`internal/operator/brief_autopilot.md`, its `//go:embed`/var and the "Interim autopilot" section
SHALL be deleted. `brief_rules.md` SHALL: drop from Allowed tools `rk tab new`, `rk riff`,
`wt create`, `git fetch`, `git cherry-pick`, `git rebase`, `git commit`, `git push`,
`gh pr ready`, `gh pr merge`, `fab status set-base-branch` (keeping read-only git/gh, `fab pane map`,
`.status.yaml` reads, `fab agent … -o yaml`, the `rk operator track` verbs, `rk mux
capture|send|inventory`, `rk notify`, and `rk operator autopilot queue|step|status`); drop queue
spawns/cherry-picks/merge-auto merge and "(queue items only) PR recovery" from the direct-action
allowlist; drop rebase/cherry-pick from Recoverable and the merge-auto merge exception from the
tiers; drop the cherry-pick, rebase, pane-death and PR-recovery rows from Bounded retries; drop the
allow-list wording from the memo rule; make the agent-probe spawn rule "queue it" (queue runs a
pass) without pointing at an autopilot section; add one line that `escalated: …` notes are the
engine's — report them, never perform the restack/recovery they name. A test SHALL render the brief
and assert there is no autopilot section and the allowed-tool list names no git/gh write (rule 5).

- **GIVEN** any ledger
- **WHEN** `operator.RenderBrief` renders
- **THEN** the output contains no `## Interim autopilot` and none of `git cherry-pick`, `git rebase`, `git push`, `git commit`, `git fetch`, `gh pr merge`, `gh pr ready`, `wt create`, `rk riff`, `rk tab new`, `fab status set-base-branch`

#### R20: Chat skill points at autopilot verbs
`docs/site/skill/operator.md` SHALL keep its queue-creation text, point every mechanical action at
`rk operator autopilot` verbs (`queue`, `step`, `merge`, `stop`, `rm`, `resume`, `status`), and drop
`--force` recipes and allow-list gotchas; `app/backend/cmd/rk/skill/operator.md` SHALL be
re-synced with `scripts/sync-skill.sh` so the two stay identical.

- **GIVEN** the chat skill bundle
- **WHEN** `rk skill operator` prints it
- **THEN** it mentions `autopilot rm` / `autopilot resume` and no `--force`

### Non-Goals

Binding, copied verbatim from the plan (every review quotes them):

- **Review bar** — **Must-fix**: anything that can merge, arm, push, force-push or delete the wrong
  thing; lose or corrupt state-file data; launch a duplicate agent *under the single-writer rule*;
  crash the CLI; or break a requirement in the step's plan. **Should-fix** (does not block):
  failure cases the pass lock rules out, tmux pane-id reuse, missing escalations for read-only
  probes, and cosmetics. From R6r-ii, a finding that needs an external write to the engine file (a
  hand edit) is out of scope.
- **Rule 6** — From R6r-i on, autopilot behaviour is added only as a status case, a rule row and an
  executor. A `decide` table test enumerates every reachable (item kind, merge mode, status) and
  asserts the row that fires, or an explicit `wait`. A behaviour outside the table, or a reachable
  combination with no outcome, is must-fix.
- **Rule 7** — From R6r-ii on, the engine file is written only under the pass lock. A step never
  adds an engine key to a ledger item, and never reads a ledger item's `scope` for a decision beyond
  the projection keys listed in § Engine state file.
- `stacked-prs` merge-all (`stale-base`, B1, `restack`, P4/P7 for stacked) — R6b; PR recovery
  (C1–C6, F1; removing P5) — R6c.
- Hardening against hand edits of the engine file; races the pass lock rules out; pane-id reuse.
- `stop` returning `busy` while another pass holds the lock (pre-existing).
- `docs/memory/` updates — done at hydrate, not apply.
- PR screenshot evidence — captured after ship, not by apply.

### Design Decisions

#### Engine state in its own file
**Decision**: The engine stores intent in `<slug>.autopilot.yaml`, written only under the pass lock; the ledger holds projection items with no engine key.
**Why**: Every R6a design finding was another writer changing an engine field between a pass's read and act; a file nobody else writes removes the class by construction and retires the allow-list.
**Rejected**: Keeping engine keys in the ledger behind a deny-by-default allow-list with `--force` — covers writers by enumeration, with an escape hatch, and grows with every new key.
*Introduced by*: 261116-rxic-autopilot-own-state-mechanical-runs

#### Mechanical pass in the run wrapper, model only for judgment
**Decision**: `rk operator run-exec` runs `autopilot.Step` before any launcher and launches a model only when the judgment set is non-empty.
**Why**: The series goal — a tick costs a model call only when judgment is needed; the wrapper already lives in a restart-surviving tmux window, owns the run's end state and can take minutes without blocking the tick.
**Rejected**: Running the pass in the daemon tick (blocks the tick under tmux's timeout budget) or keeping prose-driven model runs for mechanical work.
*Introduced by*: 261116-rxic-autopilot-own-state-mechanical-runs

#### Escalations are notes plus notify
**Decision**: An escalation is a `by: run` `escalated: …` note on the item's projection plus `rk notify`, once per dedupe key kept in the engine file.
**Why**: The note is what the brief, the drawer and the judgment set read; nothing depends on the pass's return value.
**Rejected**: Returning escalations for the caller to notify (the R6a contract) — a daemon-launched pass has no caller to act on them.
*Introduced by*: 261116-rxic-autopilot-own-state-mechanical-runs

## Tasks

### Phase 1: Engine file foundation

- [x] T001 Add the engine-file store in `app/backend/internal/autopilot/enginefile.go` (+ `enginefile_test.go`): path derivation beside the pass lock, YAML schema (`version: 1`, ordered `queue`/`prs` lists with the R1 fields), tolerant read (missing = empty), fsatomic `0600` write, lookup/upsert/remove helpers; tests for missing file, unknown fields, mode, round-trip order <!-- R1 -->
- [x] T002 Implement the one-time move in `app/backend/internal/autopilot/migrate.go` (+ `migrate_test.go`): R6a queue-work predicate moved here from `operator.IsQueueItem`, copy keys + `depends_on` (engine file wins), write engine file, then strip ledger keys / set `depends_on: []` / drop note-less unspawned queue items in one `operator.Mutate`; no-op when nothing to move; tests for R6r-i ledger, crash-between-writes repeat, notes kept, adopt-shaped legacy items <!-- R2 -->
- [x] T003 Call the migration at the start of every lock-holding verb (`passLocked` path in `app/backend/internal/autopilot/passlock.go` / `step.go`, `merge.go`, `queue.go`) and never under `--dry-run` <!-- R2 -->

### Phase 2: Engine on its own state

- [x] T004 Move engine-key constants from `app/backend/internal/operator/ownership.go` into `app/backend/internal/autopilot` (engine-file field names); relocate `validateMemo`/`mergeScope` into `app/backend/internal/operator/track.go` (or `scope.go`); delete `ownership.go`, `ownership_test.go`, `internal/autopilot/ownership_test.go`, `internal/autopilot/scopekeys_test.go`, keeping memo tests in `track_test.go` <!-- R5 -->
- [x] T005 Rework observe/derive to load the engine file plus the ledger read-only (`app/backend/internal/autopilot/observe.go`, `status.go`): queue/PR membership and stored keys from the engine file; pane liveness from the engine binding; `done_at`, `paused`, removed and notes from projections; new PR status `paused`; removed-projection detection via `projected` <!-- R4, R6 -->
- [x] T006 Extend the rule table in `app/backend/internal/autopilot/rules.go`: `paused` PR status → explicit wait; interim row B0 for `stacked-prs` (`restack needed: PR #<n>`, dedupe per PR); `stacked-prs` PR items get only P1/P2/P3/B0 with every other status an explicit wait; a removed-projection escalate-once row; a re-project row for `projected` unset <!-- R4, R12 -->
- [x] T007 Rewrite executors to write the engine file (`app/backend/internal/autopilot/execute.go`, `spawn.go`, `riffspawn.go` Opened callback, `merge.go` PR-chain creation, `step.go` stop): intent-first to the engine file, re-read engine item + projection before acting, projection add/update via `operator.Mutate` with only projection keys, `projected: true` after a successful projection write, identity-only projection before a pre-spawn escalation <!-- R3, R4, R6 -->
- [x] T008 Escalations as notes in `app/backend/internal/autopilot/autopilot.go`: `Env.Notify` seam; dedupe map on the engine item; note `by: run` + `escalated: ` prefix only on first sighting; notify once per key (title item id or `autopilot`); item-less / removed-projection escalations notify + result only <!-- R11 -->
- [x] T009 Verbs in `app/backend/internal/autopilot/queue.go`, `merge.go`, `step.go` (+ new `rm.go`): `Enqueue` under the pass lock writing the engine file then one pass, busy ⇒ not written (error mapped to exit 1), id uniqueness across both files; `merge` accepts `stacked-prs`; `Stop` on the engine file; new `Remove` (R8 rules incl. dependents refusal) and `Resume` (halted/skipped/paused) each running one pass; `Status` read-only from the engine file <!-- R7, R8, R9, R10 -->
- [x] T010 CLI in `app/backend/cmd/rk/operator_autopilot.go` (+ tests): `rm <id>` and `resume <id>` subcommands with help, exit codes and `--json` envelopes matching the siblings; `queue` busy message + exit 1; `Notify` wired to `sendNotify` in the shared Env builder; help texts drop `--force` recipes and the stacked-prs refusal <!-- R7, R8, R9, R10, R11 -->
- [x] T011 Ledger CLI in `app/backend/internal/operator/track.go` and `app/backend/cmd/rk/operator_track.go` (+ tests): remove `Force` from `AddSpec`/`UpdateSpec` and the `--force` flags/help/examples on add/update/rm; remove the `sequencePRItem` rm refusal; `--scope` merges any key; remove `--mode` from `track add` (usage error naming `rk operator autopilot queue`) <!-- R5 -->

### Phase 3: Loop integration

- [x] T012 Run record + daemon in `app/backend/internal/operatorloop/record.go` and `runner.go` (+ tests): structured `changes` with reasons and a `pass` block on `Record`; `persistRun` stops rendering the brief <!-- R13 -->
- [x] T013 Judgment set in `app/backend/internal/operatorloop/judgment.go` (+ `judgment_test.go`): pure function over (changes, pass result, ledger, engine-owned ids) per R15, table-tested over every reason kind <!-- R15 -->
- [x] T014 Wrapper in `app/backend/internal/operatorloop/exec.go` (+ `exec_test.go`): `ExecOptions.Pass` seam; record `pass`; busy/error continue; empty judgment ⇒ `outcome: mechanical · <n> actions`, exit 0, no launcher; else render brief from a fresh ledger load with the judgment set and launch; wire `Pass` in `app/backend/cmd/rk/operator_run_exec.go` to `autopilot.Step` with the production Env (`By: run`) <!-- R14, R16 -->
- [x] T015 Transcription in `app/backend/internal/operatorloop/transcribe.go` (+ test) produces `ran · mechanical · <n> actions · <dur>`; retention test counts mechanical runs <!-- R17 -->
- [x] T016 Extend the isolated-socket integration test in `app/backend/internal/operatorloop/loop_test.go` with one mechanical-only run <!-- R18 -->
- [x] T017 [P] Drawer: verify `app/frontend/src/components/cron-log.tsx` / `cron-entry-detail-sheet.tsx` / `watched-tasks.tsx` render the mechanical line and an `escalated: …` note; add/adjust unit tests (`cron-log.test.tsx`), change components only if needed <!-- R17 -->

### Phase 4: Brief diet, skill, tests

- [x] T018 Delete `app/backend/internal/operator/brief_autopilot.md`, its embed/var and the Interim autopilot section in `brief.go`; edit `brief_rules.md` per R19; update `testdata/brief_golden.md` and `brief_test.go`; add the rule-5 test (no autopilot section, no git/gh write in allowed tools) <!-- R19 -->
- [x] T019 Update `docs/site/skill/operator.md` per R20 and run `scripts/sync-skill.sh` to refresh `app/backend/cmd/rk/skill/operator.md` <!-- R20 -->
- [x] T020 Extend the `decide` table test (`app/backend/internal/autopilot/rules_test.go`) to enumerate every reachable (kind, mode, status) incl. `stacked-prs` PR items, `paused`, B0, removed-projection and re-project rows; port R6r-i behaviour tests (`merge_test.go`, `spawn_test.go`, `deltas_test.go`, `escalation_test.go`, `lifecycle_test.go`, `harness_test.go`, …) to assert on the engine file + projections <!-- R12, R6 -->
- [x] T021 Run gates from `app/backend`: `go test ./...` (or `just test-backend`) and `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1`; frontend `npx tsc --noEmit` and the touched unit tests; fix failures (known host-only failures `TestPortPinRowRealPolicyValues`, `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath` do not block) <!-- R1 -->

## Execution Order

- T001 → T002 → T003 precede every Phase 2 task.
- T004 before T005–T011 (constants move).
- T005 → T006 → T007 → T008 → T009 → T010; T011 is independent of T005–T010 after T004.
- T012 → T013 → T014 → T015 → T016; T014 needs T008 (Notify) and T009.
- T018–T020 after Phase 2/3; T021 last.

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `<slug>.autopilot.yaml` exists beside the ledger, `0600`, written via fsatomic only inside lock-holding verbs; missing file reads as empty; no `armed`/`direct`/non-monotone fact is stored
- [ ] A-002 R2: The move copies engine keys + `depends_on` into the engine file (engine file wins), then strips the ledger in one locked write; repeated runs are no-ops; a crash between the writes is repaired
- [ ] A-003 R3: Spawn/respawn and track-pr/merge add projection items with only projection keys and `depends_on: []`, and record `projected: true`; an unprojected spawned item is re-projected
- [ ] A-004 R4: Removed projection escalates once and is not re-added; paused queue/PR projections derive `paused`; a pre-spawn escalation creates an identity-only projection later bound by spawn
- [ ] A-005 R5: `ownership.go`, its tests, `scopekeys_test.go`, `--force` on all track verbs, the sequence-PR rm refusal and `track add --mode` are gone; `--scope` merges any key; memo semantics unchanged
- [ ] A-006 R6: Executors read/write the engine file, re-read before acting, write intent first for spawn/respawn
- [ ] A-007 R7: `queue` takes the lock, writes the engine file, runs one pass; busy ⇒ exit 1, nothing written
- [ ] A-008 R8: `rm` drops an unspawned queue item (refusing one with not-done dependents) or a halted sequence, else exit 2
- [ ] A-009 R9: `resume` clears halted/skipped/paused on one item, else exit 2
- [ ] A-010 R10: `merge` accepts stacked-prs; `stop` writes the engine file; `status` is read-only; help texts carry no `--force` recipe
- [ ] A-011 R11: Escalations write one `by: run` `escalated: ` note and one notify per dedupe key; item-less escalations notify only
- [ ] A-012 R12: B0 escalates `restack needed: PR #<n>` once; stacked PR items never get ready/arm/merge; P5 stays
- [ ] A-013 R13: The run record carries changes with reasons and a `pass` block; the daemon renders no brief
- [ ] A-014 R14: The wrapper runs the pass via the `Pass` seam wired to `autopilot.Step` (By run) before any launcher; busy/error are recorded and the wrapper continues
- [ ] A-015 R15: The judgment set matches the R15 rule exactly and is table-tested
- [ ] A-016 R16: Empty judgment ⇒ `mechanical · <n> actions`, exit 0, launcher never invoked; non-empty ⇒ post-pass brief from the judgment set, then launch
- [ ] A-017 R17: Transcription yields `ran · mechanical · <n> actions · <dur>`; retention unchanged; drawer renders the line and escalation notes
- [ ] A-018 R18: The isolated-socket integration test includes a mechanical-only run
- [ ] A-019 R19: Brief has no autopilot section and its allowed tools name no git/gh write or queue-spawn tool; rule-5 test exists
- [ ] A-020 R20: Chat skill points at autopilot verbs, has no `--force`, and both copies are identical

### Behavioral Correctness

- [ ] A-021 R10: `merge` on a stacked-prs queue creates PR items (previously refused)
- [ ] A-022 R11: Escalation notes are `by: run` even when `Env.By` is chat

### Removal Verification

- [ ] A-023 R5: No reference to `checkScopeUpdate`, `checkScopeAdd`, `EngineScopeKeys`, `EngineMayWrite`, `ScopeKeyKnown`, `sequencePRItem` or `Force` remains in `internal/operator` / `cmd/rk/operator_track.go`
- [ ] A-024 R19: `brief_autopilot.md` and `briefAutopilot` are gone; no code embeds them

### Scenario Coverage

- [ ] A-025 R2: Migration tests cover the R6r-i ledger, crash-repeat and notes-kept scenarios
- [ ] A-026 R4: Tests cover removed, paused (queue and PR) and pre-spawn-escalation projections
- [ ] A-027 R12: The `decide` table test enumerates every reachable (kind, mode, status) including stacked-prs and `paused`, asserting a row or explicit wait

### Edge Cases & Error Handling

- [ ] A-028 R7: Concurrent `queue` during a held lock writes nothing to either file
- [ ] A-029 R8: `rm` on spawned, spawning, unhalted, unknown, or depended-on ids exits 2 with a reason
- [ ] A-030 R14: A pass error or busy pass never prevents the judgment run when the judgment set is non-empty

### Code Quality

- [ ] A-031 Pattern consistency: New code follows the naming, error-class and seam patterns of `internal/autopilot`, `internal/operatorloop` and `cmd/rk`
- [ ] A-032 No unnecessary duplication: Env wiring for `step` and the wrapper share one builder; fsatomic and `operator.Mutate` are reused
- [ ] A-033: All subprocess calls keep `exec.CommandContext` with argv slices and per-class timeouts
- [ ] A-034: Disposable daemon — the wrapper (not the daemon) runs the pass; every engine write is durable before the verb returns
- [ ] A-035: New behaviour has Go tests; frontend tests cover any drawer change
- [ ] A-036: No god functions (>50 lines without clear reason) added; no magic strings for reason kinds or statuses (named constants)
- [ ] A-037: Comments state constraints, not narration or change IDs

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `rm` refuses a queue item that a not-done queue item depends on, instead of dropping the edge | Dropping the edge would let a dependent spawn without its dependency's code; refusing is the safe, reversible outcome | S:55 R:80 A:70 D:60 |
| 2 | Confident | The migration runs inside the pass lock at the start of every writing verb, never under `--dry-run` | Rule 7 (engine file only under the lock); dry run must write nothing | S:75 R:80 A:80 D:75 |
| 3 | Confident | Queue id uniqueness is checked against both the engine file and the ledger | A queue id equal to a ledger item id would collide with its future projection | S:65 R:85 A:80 D:75 |
| 4 | Confident | A re-project row handles `projected` unset with a binding present, and a removed-projection escalate-once row handles `projected: true` with no ledger item | Rule 6: projection outcomes must be rows, not ad-hoc code | S:65 R:80 A:75 D:65 |
| 5 | Confident | Memory docs are updated at hydrate, PR evidence after ship — neither is an apply task | Pipeline stages own them | S:80 R:90 A:85 D:85 |

5 assumptions (0 certain, 5 confident, 0 tentative).
