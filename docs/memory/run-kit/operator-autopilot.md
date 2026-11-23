---
type: memory
description: "The Go queue engine behind `rk operator autopilot` in `internal/autopilot`: pass-locked queue-only engine file, pane projections in the ledger, derived queue statuses, the X0/X1/Q1–Q5 rule table, readiness (including the merge-auto merged-PR barrier), three-mode SHA-pinned spawn with per-entry `plain`/`base`, one respawn, completion, and escalations as notes plus notify. PR work belongs to the operator run."
---
# Operator Autopilot

**Domain**: run-kit

## Overview

`internal/autopilot` (`app/backend/internal/autopilot`, CLI in `cmd/rk/operator_autopilot.go` and `operator_autopilot_admin.go`) is the operator's deterministic queue engine: the readiness, fetch-first spawn, one respawn and completion choreography that has exactly one right answer. The engine owns its intent in its own file, `<slug>.autopilot.yaml` beside the operator ledger, written only by `rk operator autopilot` verbs while they hold the pass lock. The ledger ([operator-state](/run-kit/operator-state.md)) holds only **projection items** for engine work: the pane binding and identity a user sees in `track list`, the notes, and the facts `rk operator check` records. Every pass re-derives what to do from the engine file, the projections and facts read from tmux, git and GitHub, then acts. Statuses are derived, never stored; behaviour is a row in one data table. The operator-loop wrapper runs a pass before any model call ([operator-loop](/run-kit/operator-loop.md)), and chat runs the same verbs; the daemon never runs one. An escalation is a `by: run` note on the item's projection plus a notification.

The engine does queue work only. Readying, arming, merging and restacking PRs and fixing red CI or conflicts are the operator run's work; a queue's merge mode shapes how the engine spawns each item and tells the run its merge authority (§ Merge mode).

## Requirements

### Requirement: Verbs and exit codes

`rk operator autopilot` has seven children, each with `-L/--server` (default: the caller's server from `$TMUX`) and `--json` (the shared `{"ok":true,"result":{…}}` envelope): `queue`, `step`, `stop`, `status`, `rm`, `resume`, `pause`. `queue` takes a JSON array on stdin; `rm <id>`, `resume <id>` and `pause <id>` take one engine item id. `queue`, `step`, `stop`, `rm`, `resume` and `pause` take the pass lock; `status` takes none and writes nothing; `queue --dry-run` and `step --dry-run` read but neither write nor lock. No verb waits for CI. Exit codes: 0 ok (a `busy` result included, except `queue`), 1 operational (state file busy or unreadable, a state write failed, a gh lookup failed, `queue` finding the lock held), 2 usage or invalid input. Human output caps every list at 20 entries with an exact total, a truncation notice and `--all`; `--json` is always complete. `step --dry-run` prints each decided row as an action `dry-run: <action> <item> (<row>)` (e.g. `dry-run: spawn ab12 (Q2)`) and lists no waits. Help text states exactly what the implementation does, pinned by CLI tests.

`Env` is the engine's seam set: a `Runner` (argv-slice `exec.CommandContext` with a per-class timeout — fetch 60s, other git/gh/wt 30s, fab 10s), a `Spawner`, a `Panes` snapshot (`Snapshot` and `PID`), a `Session` resolver, the state path, a clock, and `Notify func(ctx, title, body)`. The engine never injects text into a pane. `cmd/rk` builds one production Env for `step`, `queue`, `stop`, `rm`, `resume`, `pause` and the run wrapper, wiring `Notify` to `sendNotify`; tests may pass nil. Git behaviour is tested against real temp repos (bare origin plus clones) with a hermetic git identity pinned by `main_test.go`; `gh` and `fab` go through a scripted runner fake.

### Requirement: Engine state file

The engine's stored state lives in `<state>/hexokit/operator/<slug>.autopilot.yaml`, derived from `Env.StatePath` the way `<slug>.autopilot.lock` is. It is written with mode `0600` through `internal/fsatomic`, and only by the lock-holding verbs (`queue`, `step`, `stop`, `rm`, `resume`, `pause`); no write path exists outside a held lock, and `--dry-run` writes nothing. The file carries `version: 1`, `migrated` once the one-time move has completed, and one ordered list, `queue`, whose order is execution order. A **queue item** is keyed by `id` and carries `queue` (the queue id), `merge_mode`, `task` | `change` | `bare`, `plain`, `base`, `repo`, `stop_stage`, `depends_on`, `paused`, `spawning`, `respawned`, `skipped`, the spawn binding `pane`/`session`/`branch`/`worktree`, `spawned_by`, `projected`, `done_at`, `escalated`, `added_at` and `updated_at`.

Reads are tolerant: unknown fields are ignored and a missing file reads as an empty engine; `status` on a server with no file reports an empty queue and creates nothing. A file that still carries `prs:` or `fixes:` lists, or item keys no longer in the schema, loads without error and the next locked write drops them. Non-monotone facts — PR state, merged, checks — are never stored; they are read fresh every pass. Writes are durable before a verb returns (Constitution II). Engine decisions read a ledger item only for the projection facts below, never its `scope` for anything else. `OwnedIDs` returns queue item ids only, so any other ledger item — a `github-pr` item named `pr-<n>` included — is an ordinary ledger item that `track` verbs and the judgment set treat as such.

**One-time move.** Every lock-holding verb runs the migration until it has completed once; the engine file's `migrated: true` marks completion, and from then on a ledger scope key written later (`queue`, `merge_mode`) never creates engine work. The move absorbs ledger `pane` items carrying `scope.queue` or a non-null `scope.merge_mode`; an ordinary pane item with a `depends_on` edge is never absorbed, and a `github-pr` item stays in the ledger untouched whatever its scope. Their engine keys and `depends_on` are copied into the engine file (an id already present keeps the engine file's values), the engine file is written first, then one locked ledger write strips the engine keys, sets `depends_on: []`, and drops a migrated queue item that has no pane and no notes. A crash between the two writes is repaired by the next verb; a ledger with nothing to move writes nothing to it.

#### Scenario: Engine file beside the ledger
- **GIVEN** a server with no `<slug>.autopilot.yaml`
- **WHEN** `rk operator autopilot queue` writes items
- **THEN** the file exists with mode `0600` and the ledger holds no engine key

#### Scenario: Legacy engine file
- **GIVEN** an engine file with a queue item carrying `halted: true` and `recovery: [ci-fix]`, a `prs:` list with `pr-41` and a `fixes:` list with `fix-1`
- **WHEN** `step` runs
- **THEN** it succeeds, the queue item is managed normally, the rewritten file holds no `prs`, `fixes` or removed keys, and `OwnedIDs` contains neither `pr-41` nor `fix-1`

### Requirement: Projection items

The ledger holds only projections of engine work. A `pane` projection (id = the queue item id) is added when a spawn or respawn attaches a pane, carrying `pane`, `session`, `repo`, `change`, `branch`, `stop_stage`, `spawned_by`, and no engine key, with `depends_on: []`. The engine's view of an item (`engineView`) overlays onto the engine record the pane facts only the check learns (`overlayPaneFacts`): the `change` a raw-task spawn acquired from `/fab-new`, the `stage`, and the branch `branch_map[<change>]` records — `/fab-new` renames the spawn-time branch to the change name, so the engine's own `branch` goes stale and every reader (respawn, cherry-pick sources, status, the projection write-back) takes the view's. After a successful projection write the engine records `projected: true` on its item; a spawned engine item with `projected` unset and no ledger item is re-projected idempotently (row X1). The engine writes nothing to a ledger item except the projection keys and escalation notes. `rk operator check` fields (`reported`, `done_at`, conditions) are facts the engine reads and never writes.

The engine observes projections as external facts:

- **Removed** — an engine item with `projected: true` and no ledger item escalates once (`projection removed: <id>`, notify and result line, no ledger note, row X0). The engine keeps managing the item from its own state and never re-adds the projection, including on `respawn`, which records the new binding in the engine file only. A removed projection on a done item is routine cleanup and does not escalate.
- **Paused** — a paused queue projection derives queue status `paused`; queue `paused` is the engine's `paused` OR the projection's, so a projection never clears the engine's pause (`stop`'s pause holds for an item with an identity-only projection), and a view-only overlay value is never written back into an engine item — except that a queue item's next guarded write stores the overlaid `change` and `branch` (`engineItemFromTracked` copies them from the view), which is what keys the projection write-back's `branch_map` entry by change; `stage` is never stored.
- **Identity-only** — an escalation on a queue item with no projection yet first adds a `pane` projection with no `pane` key to hold the note; the later spawn binds the pane onto that same item.
- **Completion** — pane liveness for `spawned`, `dead` and `spawn-unknown` reads the engine file's own binding; completion reads rk's pane map and the projection's `done_at`. An observed completion from either source is cached as `done_at` in the engine file, and Q1's guard keys on the engine file's own `done_at`, never on the overlaid view, so removing a projection after its pane closed never turns a finished item into `dead` or respawns it.

#### Scenario: Removed projection
- **GIVEN** a spawned queue item whose projection the user removed with `track rm`
- **WHEN** a pass runs twice
- **THEN** one `projection removed: …` escalation is notified on the first pass only, and no projection is re-added

### Requirement: Single-writer pass lock

`Step`, `Enqueue`, `Stop`, `Remove`, `Resume` and `Pause` each take an exclusive, non-blocking `flock` (`LOCK_EX|LOCK_NB`) on `<state dir>/<slug>.autopilot.lock` — beside the state file, same directory and `cron.FabOperatorSlug` slug — for the whole verb, the migration included. A caller that finds it held writes nothing and returns `Busy: true`: exit 0, one human line saying another autopilot pass is running on this server and to retry later, `"busy":true` in `--json`. `queue` is the exception: it prints `busy: another autopilot pass is running on this server; queue not written, retry` and exits 1, so a caller never mistakes an unwritten queue for a queued one. The OS releases a `flock` when the process dies, so a crash never leaves the lock held. The lock is per server. The ledger's sidecar lock is separate and never held across a subprocess; every ledger write loads fresh state under it and merges by item id, so `rk operator track`, `rk operator check` and the daemon keep writing the ledger concurrently and external writes win. The pass lock serialises engine passes and is what makes the engine file single-writer.

- **GIVEN** a process holds the lock **WHEN** `step`, `stop`, `rm` or `resume` runs **THEN** it returns `busy`, makes no state write and runs no git/gh/wt/fab/tmux mutation
- **GIVEN** a pass returned, normally or with an error **WHEN** the next pass runs **THEN** it acquires the lock

### Requirement: Pass shape

`Step` (and the pass inside every other lock-holding verb) runs four stages under the pass lock:

1. **Observe** — load the engine file and the ledger, take one pane snapshot, and read facts only for items that can act. Completion, for each unfinished queue item with a pane: a fab item's pane stage reaching `ship` or its `stop_stage`; a plain agent's (a task queued `plain`, or any task in a repo without `fab/`) branch PR merged, or open with required checks not pending (`gh pr view <branch> --json url,state`, then `gh pr checks <n> --required --json state`). Readiness, for each unfinished, unpaused queue item with dependencies: a same-repo dependency with null `stop_stage` needs its PR to exist (`gh pr view <branch> --json url`), and a merge-auto barrier dependency needs its PR `MERGED` (`gh pr view <branch> --json url,state` in the dependency's own repo). Both are per-pass facts on the item's `queueFacts`. A branch with no PR is a normal held state ("no pull requests found"); any other failed read escalates (`dependency <id> PR lookup failed: …`, `completion PR lookup failed: …`, `completion checks lookup failed: …`) and the item is held or not done for the pass, with no other item blocked; a dependency with no recorded branch escalates `dependency <id> has no branch recorded`. The read-only `status` view runs the same reads and stays silent on "no pull requests found".
2. **Derive** — a queue status per engine queue item: first match, pure.
3. **Decide** — `decide(state, facts)` is pure (no I/O, no `ctx`) and walks the package-level rule table; at most one decision per item, first matching row in table order, in engine order. Every (merge mode, queue status) has a row or an explicit entry in the wait table; a combination with neither is reported as `unmatched` and never acted on (a table test enumerates every reachable combination).
4. **Execute** — one executor per typed action (`record-done`, `spawn`, `respawn`, `skip`, `escalate`, `re-project`) in engine order. No action sees another's effect through a status: a successor acts on the next pass. A hard error in one executor does not stop later actions; the errors are joined.

**Executors act on a re-read item.** Before acting, an executor re-reads the engine item and its projection (for paused, removed and done facts) and skips it with `item <id> changed externally; skipped` when it vanished or changed since observe. A non-idempotent action (`spawn`, `respawn`, `skip`, `escalate`) writes its intent to the engine file first (`spawning`; `respawned` with `spawning`; `skipped`; the `escalated` key). An idempotent one (`record-done`, `re-project`) writes nothing the next pass cannot re-derive.

### Requirement: Derived statuses

Statuses are derived every pass, never stored. **Queue item status** (an item in the engine file's `queue`), first match: `done` (`done_at` set in the engine file, or completion observed this pass) › `paused` (engine or projection) › `skipped` › `held` (a dependency not satisfied) › `pending` (no pane, no `spawning`) › `spawn-unknown` (`spawning` set and no live pane, including a stale dead pane id left by a crashed respawn) › `spawned` (pane alive) › `dead` (pane recorded, not alive). `held` precedes `dead`. Dependency satisfaction is the readiness gate below.

### Requirement: Rule table

The rule table is the whole of autopilot behaviour. A behaviour is a status case, a row and an executor; nothing else acts. Every row is of kind queue. Rows, in table order:

| Row | Status | Guard | Action |
|---|---|---|---|
| X0 | any | engine item `projected: true`, no ledger item, not done, not yet escalated | `escalate` `projection removed: <id>` |
| X1 | any | engine item has a pane binding, `projected` unset, no ledger item | `re-project` |
| Q1 | `done` | engine `done_at` unset | `record-done` |
| Q2 | `pending` | — | `spawn` (writes `spawning`) |
| Q3 | `spawn-unknown` | not yet escalated | `escalate` `spawn interrupted: …` |
| Q4 | `dead` | respawn unspent | `respawn` (writes `respawned` and `spawning`) |
| Q5 | `dead` | respawn spent | `skip` (writes `skipped`, then escalates) |

Every other status is an explicit wait: `done` once recorded, `paused`, `skipped`, `held`, `spawn-unknown` after Q3, and `spawned` (the agent is working; no age or queue-duration condition escalates it — stuck agents surface through `operator.Check`'s `agent_aged`, [operator-state](/run-kit/operator-state.md)).

**Escalate-once** rows (X0, Q3) guard on and write the engine item's `escalated` map keyed by reason. A persisting condition decides an explicit `wait` on later passes and appears in `StepResult.Escalations` only on its first sighting. Note text is written for humans and the brief but never read by an engine decision.

### Requirement: Escalations

An `escalate` action, on the first sighting of its dedupe key only, appends a note `by: run` with text `escalated: <reason>` (capped at `operator.NoteTextCap`) to the item's projection and sends a fail-silent notification through `Env.Notify` (title = the item id, or `autopilot` for an item-less escalation; body = the reason). Notes are always `by: run`; there is no `--by` flag on `queue` or `step`. An escalation with no ledger item able to hold it (item `""`, or a removed projection) is notify plus `StepResult.Escalations` only. The dedupe map lives on the engine item, so a note and its key never land on an item that changed since observe. `StepResult.Escalations` remains for CLI output and for the wrapper's judgment set ([operator-loop](/run-kit/operator-loop.md)).

A `step` pass reports its decided actions in engine order: `spawned`, `respawned`, `cherry-picked`, `paused`, `done`, `removed`, `resumed`, and escalations.

### Requirement: Queue

`rk operator autopilot queue [--mode <m>] [--dry-run] < entries.json` takes the pass lock, runs the migration, writes N pending queue items to the engine file in one write, and then runs one pass. Entries are `id`, `repo`, `change` | `task` | neither (bare), optional `plain`, `base`, `depends_on`, `stop_stage` and `paused` (`true` queues the entry held until `resume` — a plan step behind a user gate). Unknown keys are a usage error. A lock held by another pass writes nothing and exits 1 with the busy line (§ Single-writer pass lock). Once the engine write succeeded, an error in the follow-up pass does not fail the queue: the receipt reports the queued items plus the pass's actions and escalations (the pass error as an escalation) and the command exits 0.

- **Stamping**: every item gets `queue` (the queue id) and `merge_mode`, resolved once as `--mode` > rk setting `operator.merge_mode` > `cherry-pick-ladder`; the receipt prints `mode: <name> (flag|setting|default)`. An invalid setting value is an error naming the valid set. fab's `autopilot.merge_mode` is never read.
- **Chaining**: each entry after the first depends on the nearest earlier same-repo entry, else the previous entry (cross-repo is ordering-only); explicit `depends_on` replaces it. In `merge-auto`, each entry depends on the previous entry as an ordering barrier only.
- **Rejected before any write** (usage error, `--dry-run` included): forward and cyclic dependencies, dependencies on bare entries, duplicate ids (checked against both the engine file and the ledger), repos that are not absolute git roots, invalid branches, and the `plain` and `base` cases below.
- **`plain`**: `plain: true` with a `task` runs the task as a plain agent even in a fab repo (§ Spawn step 6) and is stored only when a task is present. `plain` with a `change` or a non-empty `stop_stage` is refused (a plain agent has no pipeline stages). `plain` without a `task` is the bare agent.
- **`base`**: the branch the worktree starts from and the PR targets, for a `change` or a `task` entry; unset means the repo's default branch. It must pass `safeBranch` and exist on the entry repo's `origin`, probed with `git ls-remote --exit-code --heads origin refs/heads/<base>` through the runner (exit 2 → `base <b> is not a branch on origin`; any other failure → `cannot verify base <b> on origin`). Mixed bases across a same-repo dependency (implicit chaining or explicit `depends_on`, in-queue or already tracked): in `stacked-prs` an entry with a `base` and a same-repo dependency is refused (it bases on the dependency's branch; a `base` on a stacked first entry is accepted); in `cherry-pick-ladder` an entry whose effective base (`base`, or the default branch when unset) differs from a same-repo dependency's is refused, since the cherry-pick range `origin/<base>..<dep>` would carry the dependency's whole history; in `merge-auto` a barrier across different bases is accepted and only orders the two, the dependent starting from its own base.
- **Explicit `depends_on` in `merge-auto` is the barrier**: an explicit same-repo dependency is kept as-is and behaves exactly like the implicit predecessor barrier — the dependent is `held` until the dependency's PR reads `MERGED`, then spawns off the advanced default branch (§ Readiness gate). The receipt's `misfits` list exists for the `--json` shape and is empty; no entry shape is a misfit today. The chat flow is `queue --dry-run`, confirm the mode with the user, then exactly one live call.
- **Explicit membership**: queue work is exactly what the engine file's `queue` list holds. A pane tracked with `rk operator track add` is never spawned, respawned or listed by `status`, whatever its `depends_on`; `track add` refuses an id that names an engine item.

### Requirement: Remove, pause, resume and stop

`rk operator autopilot rm <id>` takes the pass lock and drops an **unspawned queue item** (no `pane`, no `spawning`), removing it and its identity-only projection, then runs one pass. It refuses (usage error, exit 2, naming the dependents) a queue item another not-done queue item depends on, since dropping the edge would let the dependent spawn without its dependency. Any other id — a spawned item, an unknown id, a former `pr-<n>` projection — is a usage error (exit 2) naming why.

`rk operator autopilot pause <id>` takes the pass lock and sets `paused` on one unspawned queue item (no `pane`, no `spawning`, not done); a spawned, done or non-queue id is a usage error (exit 2) and an already-paused one a no-op. It runs no pass — there is nothing to advance.

`rk operator autopilot resume <id>` takes the pass lock, clears `skipped` or `paused` (the projection's pause included) on that one queue item, and runs one pass. An item with neither flag set, or an unknown id, is a usage error (exit 2) that writes nothing.

`stop` is the global user stop and is intent then one pass: it writes `paused` on every unspawned, unfinished queue item in the engine file (live panes are untouched), then runs the full pass. It reads no PR. To release a paused item the user runs `resume <id>`; `rm` drops what is not wanted.

#### Scenario: Spawned item is not removable
- **GIVEN** spawned `a1`
- **WHEN** `rm a1` runs
- **THEN** it exits 2 with a message that it has spawned

#### Scenario: Former PR id
- **GIVEN** a ledger `github-pr` item `pr-41` that is not in the engine file
- **WHEN** `rm pr-41` or `resume pr-41` runs
- **THEN** the command exits 2 naming an unknown id and writes nothing

### Requirement: Readiness gate

The queue status derivation above is the one readiness derivation: `status`, `spawn` and `respawn` all use it, and a null stored mode reads `cherry-pick-ladder`. A dependency (any unsatisfied one holds the item, even one with a pane) is satisfied when done:

- a fab item: `done_at`, `.status.yaml` `ship` done or skipped, or `stop_stage` reached;
- a change-less item (a bare or plain agent, or a task in a repo without `fab/`): its branch has an open PR whose **required** checks pass (`gh pr checks <n> --required`; none required passes; optional checks never block) or a merged PR, persisted as `done_at` in the engine file;
- a same-repo dependency with null `stop_stage` additionally needs its PR to exist. Tracking, a `branch_map` entry or a minted branch is not satisfaction. A dependency surviving only in `branch_map` passes; an unknown dependency id is unsatisfied;
- in `merge-auto`, a dependency that is itself a `merge-auto` queue item additionally needs its branch's PR observed `MERGED` this pass, so a successor never spawns off an unmerged base. The merge itself is the operator run's work; the engine only waits for it.

Every branch read from shared state (engine item, `branch_map`) passes `safeBranch` before any fetch, worktree, push or gh call on that path; an invalid branch is an escalation with no mutation.

#### Scenario: merge-auto barrier
- **GIVEN** two merge-auto queue items `a`→`b`, `a` done and its PR `OPEN`
- **WHEN** a pass runs
- **THEN** `b` is `held` and not spawned
- **AND** once `a`'s PR reads `MERGED`, the next pass spawns `b`

### Requirement: Spawn

For each `pending`, unpaused queue item in queue order the engine:

1. targets the item's `repo` and runs `git fetch origin` first — **a failed fetch stops the spawn** (item stays `pending`, escalation, `rev-parse` never consulted). The default branch resolves through verified `origin/HEAD` → `gh repo view` → a `main`/`master` probe; the base is the **SHA** of `origin/<base>` — the item's `base`, else the default branch — never a ref, so the new branch has no upstream tracking.
2. applies the confidence gate: an existing fab change whose `.status.yaml` score is below 3.0 is not spawned (escalation); raw-text entries skip it.
3. writes `spawning` (RFC 3339) to the engine file, then opens the worktree and tab through `internal/riff` in-process ([rk-riff](/run-kit/rk-riff.md)): `WorktreeName` = item id, `WorktreeBase` = the SHA, role-aware landing session, window marked `auto` with note `"<id> · <stage>"`.
4. adds dependency code for the same-repo dependency subset (cross-repo is gate-only):
   - **`cherry-pick-ladder`**: the dependency branch comes from the engine item's `branch`, else `branch_map` (missing → escalate, no spawn). Dependencies whose branch is an ancestor of another dependency's branch are pruned, those already ancestors of `HEAD` skipped, then `git cherry-pick --no-commit origin/<base>..<dep-branch>` (`<base>` as in step 1) and `git commit -m "operator: cherry-pick <dep> dependency"`. A conflict runs `git cherry-pick --abort`, rolls the worktree back, escalates and opens no tab. A dependency whose stored `base` differs from the item's escalates with nothing spawned.
   - **`stacked-prs`**: the new branch is cut from the SHA of `origin/<dep-branch>` (never `wt create --checkout`). The base is recorded by `fab status set-base-branch <change> <dep-branch>` in the new worktree for an existing change, by a trailing prompt instruction to run it after `/fab-new` for a raw-text fab entry, or by naming the dependency branch as the PR base for a plain agent. A stacked item that also carries a `base` escalates with nothing spawned.
   - **`merge-auto`**: no chaining; the base is `origin/<base>` independently (the default branch when unset).
5. activates the pointer for an existing change (`fab change switch <change>`, fail-soft). An existing change whose base is not the default branch (the item's `base`, or the stacked dependency branch) has it recorded by `fab status set-base-branch <change> <base>` in the new worktree.
6. builds the prompt from the request and the repo (fab present, task given, `plain`) using the **target** repo's `fab agent default` command and skill prefix: existing change → `<prefix>fab-fff <change>`; raw text in a fab repo → `<prefix>fab-new <text>`, with the trailing `set-base-branch <new-change> <base>` instruction when the item has a stacked or item base; a `plain` task, or any task in a repo without `fab/` → the task plus "Commit on this branch, push, and open a draft PR against <pr-base>."; bare → no prompt token. `<pr-base>` is the stacked dependency branch, else the item's `base`, else the default branch. A plain item gets no `/fab-new`, no `fab change switch` and no `set-base-branch`. Never `fab init`; a fab-repo task reaches an agent as raw text only when the entry is `plain`. `respawn` builds its prompt with the same precedence.
7. attaches: `pane`, `session`, `branch` and `branch_map[<change-or-id>]` in the engine file and the `pane` projection, which clears `spawning` and records `projected: true`. The branch recorded is the one the launch created, including for raw-task and bare launches.

**`spawning` marker.** The intent marker is written to the engine file before the launch and cleared by the attach. A pass that finds `spawning` set with no pane never relaunches: it escalates `spawn interrupted: <id> — check for an orphaned window before resuming or removing the queue item` once and leaves the item alone. A launch that fails before a window exists (fetch failure, confidence gate, cherry-pick conflict with the worktree rolled back) clears `spawning` again. If the attach write fails the pass escalates naming the pane and leaves `spawning` set. If the item left the engine file after the pass read it, the attach writes nothing and escalates the orphan pane by id. A pre-spawn escalation adds the identity-only projection that holds its note.

**Respawn.** A spawned queue item whose pane is gone and that is not done gets exactly one existing-branch respawn; `respawned: true` is written before acting, together with `spawning`. The new binding is recorded in the engine file, and the projection only when one still exists. Afterwards (row Q5) the item is marked `skipped` before the escalation is reported and its dependents stay held. Pane liveness is keyed by tmux pane id; id reuse is accepted.

### Requirement: Merge mode

A queue's merge mode (`cherry-pick-ladder`, `stacked-prs`, `merge-auto`) has two halves. It shapes **spawn** (§ Spawn: ladder cherry-pick, stacked base with `set-base-branch`, merge-auto unchained with the merged-PR barrier), and it tells the **operator run** its merge authority: `merge-auto` means merge green PRs without asking; the other two mean merge only on the user's word. The engine acts on the first half only. The setting description in `operator.merge_mode` states both halves ([configuration](/run-kit/configuration.md)).

### Requirement: Status

`status` is read-only — no pass lock, no escalations, no writes, live gh probes — and runs the same observe and derive stages as `step`. It lists engine queue items only; ledger `github-pr` items are left to `rk operator track list`. It shows the derived queue status name in `state` (`done`, `paused`, `skipped`, `held`, `pending`, `spawn-unknown`, `spawned`, `dead`) with mode, repo and branch; `--json` keeps `state`, `merge_mode`, repo and branch and adds the entry's `task`, `change`, `stop_stage`, `plain` and `base` (each omitted when unset) so a judgment run can compare an intake with what was asked, and carries no `pr_status` and no `fixes` list. The human table has no PR column and appends ` · plain` and ` · base <b>` to an item's row when set. A failed pane snapshot reads recorded panes as alive instead of failing, and a plain agent with no PR yet is not a warning. When every queue item is done it adds the Queue Completion Summary. Derived statuses are not exposed to `done_when`.

### Requirement: Out of scope

- Readying, arming, merging, restacking and rebasing PRs, CI-fix and conflict recovery, and fix items do not exist in the engine, behind a flag or otherwise; the operator run does that work.
- Daemon-driven passes and MCP tools for the verbs do not exist; the pass runs in the run wrapper and in CLI verbs.
- Hardening against hand edits of the engine file is out of scope: the file has one writer by contract.
- No code in the engine claims, leases or compare-and-sets work: the pass lock and `spawning` marker are the whole concurrency model, and pane identity is recorded only by the spawn's attach write.

## Design Decisions

### PR work returned to the operator
**Decision**: The engine keeps only queue work (X0, X1, Q1–Q5: readiness, SHA-pinned spawn with the three modes' chaining, one respawn, completion). Readying, arming, merging, restacking, CI-fix and conflict recovery belong to the operator run; a merge mode keeps shaping spawn and becomes the run's merge authority. The deleted PR half is recoverable only from git history.
**Why**: The PR rows never armed a PR on gh 2.103 (`autoMergeAllowed` is not a field there), and their escalations became model runs that could only re-explain them. The PR half has the widest outcome space (conflicts, red CI, retargets), which is where judgment pays; the queue half has one right answer, and keeping it in Go is what makes "item done → next starts" free. With both halves active, the engine and a run would also fight over the same PRs once the run holds merge authority (`fab/plans/sahil/26-11-20-operator-triggers.md`).
**Rejected**: Fixing `autoMergeAllowed` in place and keeping the table — keeps the widest outcome space in fixed rows; keeping the executors behind a flag or dormant path — the plan's Rule 7, deleting code is the point; slow-stage and queue-open escalations — noise with no action behind them, since `operator.Check` already reports stuck agents.
*Introduced by*: 261120-7uqm-engine-rescope-pr-work-to-operator

### merge-auto barrier reads the dependency's PR directly
**Decision**: A merge-auto successor waits until its dependency is done and the dependency branch's PR reads `MERGED` via `gh pr view <branch> --json url,state` in the dependency's repo, a per-pass fact beside the PR-exists read; the read reuses the engine's `viewPR` and `noPRFound` helpers.
**Why**: The engine holds no PR items, so without its own read a successor would spawn off an unmerged base the moment its predecessor shipped.
**Rejected**: Storing a merged marker in the engine file — non-monotone facts are read fresh, never stored.
*Introduced by*: 261120-7uqm-engine-rescope-pr-work-to-operator

### Single-writer pass lock instead of claims
**Decision**: Serialise every writing verb per server with a non-blocking `flock` on `<slug>.autopilot.lock`; a second caller returns `busy` and exits 0 (`queue` exits 1). Crash safety rests on the `spawning` intent marker, which never auto-relaunches.
**Why**: Removes the overlapping-pass failure class wholesale; durable claims with leases and compare-and-set snapshots kept generating new failure cases. `flock` is released by the OS on process death, so the lock cannot leak (Constitution II).
**Rejected**: Durable claims with leases and CAS snapshots — correct but an unbounded review surface; a blocking lock — a stuck pass would hang runs and chat.
*Introduced by*: 261114-8w1x-operator-autopilot-go

### Engine state in its own file
**Decision**: The engine stores intent in `<slug>.autopilot.yaml`, written only under the pass lock; the ledger holds projection items with no engine key.
**Why**: Every earlier design finding was another writer changing an engine field between a pass's read and act; a file nobody else writes removes the class by construction and retires the scope allow-list and its `--force` escape hatch.
**Rejected**: Keeping engine keys in the ledger behind a deny-by-default allow-list with `--force` — covers writers by enumeration, with an escape hatch, and grows with every new key.
*Introduced by*: 261116-rxic-autopilot-own-state-mechanical-runs

### Projection removal is a fact, not a repair
**Decision**: A removed projection escalates once and is never re-added; a paused projection derives `paused`; a completion seen on the projection is cached in the engine file.
**Why**: The ledger is the user's view, so a user edit to it is an instruction or a fact the engine reads, never state it overwrites; caching `done_at` in the engine file keeps a finished item finished when its projection disappears.
**Rejected**: Re-adding a removed projection every pass (undoes the user's `track rm`); reading completion only from the overlaid view (a removed projection turns a done item into `dead`).
*Introduced by*: 261116-rxic-autopilot-own-state-mechanical-runs

### Escalations are notes plus notify
**Decision**: An escalation is a `by: run` `escalated: …` note on the item's projection plus `rk notify`, once per dedupe key kept in the engine file.
**Why**: The note is what the brief, the drawer and the judgment set read; nothing depends on the pass's return value, and a pass launched by a wrapper has no caller to act on a returned list.
**Rejected**: Returning escalations for the caller to notify — a mechanical pass has no caller to act on them.
*Introduced by*: 261116-rxic-autopilot-own-state-mechanical-runs

### One pure `decide` over a data rule table
**Decision**: Row selection is a pure function over a package-level table of `{id, status, guard, action}` rows plus an explicit wait table; executors never decide, and a test enumerates every (merge mode, queue status) for the row that fires or the wait.
**Why**: Table tests need no git or `gh` fakes, and new behaviour adds rows plus executors rather than branches in a driver loop; a combination with neither row nor wait is visible as `unmatched` instead of silently acted on.
**Rejected**: Imperative per-phase loops tested through fakes — each new behaviour re-opens the same review loop.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

### Executors re-read and guard their writes
**Decision**: Each executor re-reads its engine item and projection and skips it (`changed externally; skipped`) when it changed or vanished.
**Why**: A user can pause, remove or edit a projection between observe and execute, and the engine must not spawn or respawn against a stale view.
**Rejected**: Trusting the observe snapshot until execute — a projection edit could make the engine act against the wrong thing.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

### `rm` drops only what cannot lose work
**Decision**: `rm` removes an unspawned queue item with no unfinished dependents and nothing else.
**Why**: Dropping a dependency edge would let a dependent spawn without its dependency's code; removing a spawned item would orphan a live agent.
**Rejected**: Removing a spawned item; dropping the edge on `rm`; letting `track rm` remove engine work.
*Introduced by*: 261116-rxic-autopilot-own-state-mechanical-runs

### Fetch-first SHA pin
**Decision**: A spawn fetches first, stops on fetch failure, and bases the worktree on the SHA of `origin/<base>` (the item's `base`, else the default branch; `origin/<dep-branch>` for `stacked-prs` with a dependency).
**Why**: A stale local ref would start the branch behind; a ref start point sets upstream tracking.
**Rejected**: `wt create --checkout` for stacked dependents; a base ref instead of a SHA.
*Introduced by*: 261114-8w1x-operator-autopilot-go

### Merge mode is an rk setting, resolved once at queue time
**Decision**: `operator.merge_mode` lives in rk settings and is read only by `queue`, then stamped on every item.
**Why**: Later passes must not change a queue's mode when a setting flips; fab's `autopilot.merge_mode` is never read, so there is no dual-read.
**Rejected**: Reading the mode on every pass; falling back to fab's key.
*Introduced by*: 261114-8w1x-operator-autopilot-go

### The engine's view derives pane facts; the engine file keeps intent
**Decision**: `engineView` overlays `change`, `stage` and the real branch (from `branch_map[<change>]`) from the ledger projection onto queue items. The overlay does not write the engine file, but the item's next guarded write stores the overlaid `change` and `branch`; the stored change then takes precedence, branch re-derives from `branch_map` on every view, and `stage` is never stored. Removing that side effect is step E4 of `fab/plans/sahil/26-11-17-agent-event-log.md`.
**Why**: A raw-task spawn's respawn failed with `Branch 'pins-f1' not found` because `/fab-new` had renamed the branch to the change id — the check had recorded the real branch under the change id, but the engine read its own spawn-time copy. When a fact is available both ways, derivation wins (Constitution X), and resolving once in the view keeps the projection write-back from restoring the stale branch into `branch_map`.
**Rejected**: writing the renamed branch back into the engine file on each pass (a second writer of a derived fact); changing `depBranch`'s lookup order only (the write-back would still overwrite `branch_map[<change>]` with the stale name).
*Introduced by*: PR #1147 (direct change, no fab intake)

### A plan's user gate is a paused queue entry
**Decision**: A queue entry may start `"paused": true`, and `rk operator autopilot pause <id>` holds any unspawned entry later; `resume` releases either. The chat queues a plan's user-gate steps paused.
**Why**: A queued entry has no ledger record until it spawns, so `rk operator track pause` cannot hold it, and `stop` pauses every unspawned entry; without a per-entry pause the engine spawned a gated step the moment its dependencies finished, and the run's intake rule then advanced it past the gate.
**Rejected**: queuing gated steps in a later `queue` call only (works, but the gate is then invisible in `status` until the user remembers); a `gate` field with its own semantics (paused already derives the status and `resume` already clears it).
*Introduced by*: PR #1150 (direct change, no fab intake)

### An explicit same-repo dependency in merge-auto is not a misfit
**Decision**: `queue` no longer reports `misfit: merge-auto with same-repo depends_on …` nor refuses a live call over it; an explicit same-repo `depends_on` is the merged-PR barrier, the same as the implicit one.
**Why**: The misfit text ("each entry is based on the default branch independently, so the dependency's code never reaches it") was true in R6a and false since the merged-PR barrier (#1166): the dependent waits for the dependency's PR to merge and spawns off the advanced base, so the code does reach it. The stale receipt made the chat ask the user to pick a mode for the one shape that was already correct (the wt plan's W1 → W2).
**Rejected**: rewording the misfit as an informational line (there is nothing to decide); keeping the refusal for a future misfit (no producer exists; add it with the producer).
*Introduced by*: PR (direct change, no fab intake) — merge-auto-same-repo-barrier

### The request, not the repo, picks the pipeline
**Decision**: A queue entry's `plain: true` selects the plain-agent prompt (the task plus "open a draft PR against `<base>`") even in a fab repo; without it a fab repo with a task still gets `/fab-new`. A `base` entry field picks the start point and PR base explicitly, and its mixed-base cases are refused where the mode would carry the wrong code (`stacked-prs` with a same-repo dependency, `cherry-pick-ladder` across differing bases) and accepted as ordering-only under `merge-auto`.
**Why**: Every repo the operator serves has `fab/`, so a repo-chosen pipeline made a tracked plain agent impossible; the guard against raw text reaching a pipeline agent should not forbid choosing a plain agent on purpose. The engine took its base from the default branch or a stacked dependency only, so a long-lived integration branch could not be targeted although `wt` takes any ref. The ladder cherry-picks `origin/<base>..<dep>`, so mixed bases would spawn the wrong code; `merge-auto` is unchained by design, and refusing there would block serial queues that target different branches.
**Rejected**: Inferring "plain" from task wording (unreliable, silent); untracked `rk riff` spawns as the plain path (loses tracking, completion and dependency chaining); a repo-level setting (the choice is per request, not per repo); refusing mixed bases in every mode.
*Introduced by*: 261123-ostd-plain-spawn-base-field
