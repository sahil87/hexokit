---
type: memory
description: "The Go autopilot core behind `rk operator autopilot` verbs (queue, step, merge, stop, status) (`internal/autopilot`): the observe → derive → decide → execute pass, derived queue and PR statuses, the data rule table (Q1–Q7, P1–P7, explicit waits), armed and repo auto-merge read from GitHub, three-mode spawn with the `spawning` marker, the single-writer pass lock and `busy`, `recovery needed` escalations, and what stacked-prs merge-all (R6b) and PR recovery (R6c) still own."
---
# Operator Autopilot

**Domain**: run-kit

## Overview

`internal/autopilot` (`app/backend/internal/autopilot`, CLI in `cmd/rk/operator_autopilot.go`) is the operator's deterministic queue engine: the git, gh, wt and fab choreography that used to be prose a model re-derived on every run. It owns no state. A queue is N `pane` tracked items chained by `depends_on`, a merge sequence is a chain of `github-pr` items, and every pass re-derives what to do from the operator state file ([operator-state](/run-kit/operator-state.md)) plus facts read from tmux, git and GitHub, acts, and writes back through `operator.Mutate`. Statuses are derived, never stored; behaviour is a row in one data table. Runs and chat call it; the daemon does not. The engine never notifies: a failure or halt is an `Escalation{item, reason}` in the result plus a note on the item, and the caller turns each escalation into `rk notify`. The scope is **R6a** (queue, readiness gate, spawn for all three modes, `cherry-pick-ladder` merge-all and `merge-auto`) restructured as **R6r-i** (derived status and the rule table). The `stacked-prs` merge-all path is R6b and PR recovery is R6c; until they land the run brief keeps that text ([operator-brief](/run-kit/operator-brief.md)).

## Requirements

### Requirement: Verbs and exit codes

`rk operator autopilot` has five children, each with `-L/--server` (default: the caller's server from `$TMUX`) and `--json` (the shared `{"ok":true,"result":{…}}` envelope). `queue` takes a JSON array on stdin. `step`, `merge` and `stop` take the pass lock; `queue` and `status` do not, and `step --dry-run` reads but neither writes nor locks. No verb waits for CI. Exit codes: 0 ok (a `busy` result included), 1 operational (state file busy or unreadable, a gh lookup failed, `merge` on incomplete or `stacked-prs` queues), 2 usage or invalid input. Human output caps every list at 20 entries with an exact total, a truncation notice and `--all`; `--json` is always complete. `step --dry-run` prints each decided row as an action `dry-run: <action> <item> (<row>)` (e.g. `dry-run: spawn ab12 (Q2)`) and lists no waits. Help text states exactly what the implementation does, pinned by CLI tests.

`Env` is the engine's seam set: a `Runner` (argv-slice `exec.CommandContext` with a per-class timeout — fetch 60s, other git/gh/wt 30s, fab 10s), a `Spawner`, a `Panes` snapshot, the state path, a clock. Git behaviour is tested against real temp repos (bare origin plus clones) with a hermetic git identity pinned by `main_test.go`; `gh` and `fab` go through a scripted runner fake.

### Requirement: Single-writer pass lock

`Step`, `StartMerge` and `Stop` each take an exclusive, non-blocking `flock` (`LOCK_EX|LOCK_NB`) on `<state dir>/<slug>.autopilot.lock` — beside the state file, same directory and `cron.FabOperatorSlug` slug — for the whole pass. A caller that finds it held does nothing and returns `Busy: true`: exit 0, one human line saying another autopilot pass is running on this server and to retry later, `"busy":true` in `--json`. The OS releases a `flock` when the process dies, so a crash never leaves the lock held. The lock is per server: a held lock for one server does not block another. The state file's sidecar lock is unchanged and never held across a subprocess; every write loads fresh state under it and merges by item id, so `rk operator track`, `rk operator check` and the daemon keep writing concurrently and external writes win. The pass lock serialises autopilot passes only.

- **GIVEN** a process holds the lock **WHEN** `step`, `merge` or `stop` runs **THEN** it returns `busy`, makes no state write and runs no git/gh/wt/fab/tmux mutation
- **GIVEN** a pass returned, normally or with an error **WHEN** the next pass runs **THEN** it acquires the lock

### Requirement: Pass shape

`Step` (and the pass inside `merge` and `stop`) runs four stages under the pass lock:

1. **Observe** — load the ledger, take one pane snapshot, and read facts only for items that can act: completion for each unfinished queue item with a pane (a fab item's pane stage reaching `ship` or its `stop_stage`; a plain agent's branch PR merged, or open with required checks not pending); the same-repo dependency PR's existence for each item that may be held; per merge sequence the head (first not-done PR item) unless it is `deferred` or blocked, and every not-done PR item of a halted cone. A PR fact is `gh pr view <n> --repo <nwo> --json number,url,state,isDraft,mergedAt,mergeable,headRefOid,autoMergeRequest` plus `gh pr checks <n> --required --json name,state,link` (only when the status reaches the check statuses); the repo fact is `gh repo view <nwo> --json autoMergeAllowed`, cached per repo per pass and read only for a `waiting`, unarmed, non-`stacked-prs` PR. A failed read escalates (`gh pr view failed: …`, `gh pr checks failed: …`, `repo auto-merge lookup failed: …`) and the item is `waiting` for the pass; no other item is blocked. A sequence head's polled `state`/`mergedAt`/`mergeable` is written through `operator.Observe` (the `unchanged` clock; skipped under `--dry-run`), and the decision snapshot is reloaded after that write. A sequence head's predecessor is not read.
2. **Derive** — a queue status per queue item and a PR status per sequence PR item: first match, pure.
3. **Decide** — `decide(ledger, facts, now)` is pure (no I/O, no `ctx`) and walks the package-level rule table; at most one decision per item, first matching row in table order, in ledger order. Every (item kind, status) has a row or an explicit entry in the wait table; a combination with neither is reported as `unmatched` and never acted on (a table test enumerates every kind × merge mode × status).
4. **Execute** — one executor per typed action (`record-done`, `spawn`, `respawn`, `skip`, `escalate`, `track-pr`, `record-merged`, `halt`, `disarm`, `ready`, `arm`, `merge`) in ledger order. No action sees another's effect through a status: a successor acts on the next pass (a sequence advances one PR per pass). A hard error in one executor does not stop later actions (a failed record must not skip a later disarm); the errors are joined.

**Executors act on a re-read item.** Before acting, an executor re-reads its item under the store lock (or, for a non-writing action, immediately before the `gh` call) and skips it with `item <id> changed externally; skipped` (PR items: `PR item <id> changed externally; skipped`) when it vanished or its decision-input fingerprint changed since observe. The fingerprint covers identity, probe, `depends_on`, `paused`, `done_at` and every scope key except the check-owned `stage`, `agent`, `pane_pid` and `escalated`; it excludes `updated_at`, `last`, `unchanged`, `checked_at`, `failures`, `seen` and `notes`, so observe's own writes never invalidate a decision. Writes that record a decision (`done_at`, `skipped`, `halted`, the `track-pr` append, the escalate-once record) are applied under the lock against that fingerprint, so a stale decision never writes. A non-idempotent action (`spawn`, `respawn`, `skip`, `halt`, `escalate`) writes its intent first; an idempotent one (`record-*`, `arm`, `disarm`, `ready`, `merge`) writes nothing the next pass cannot re-derive. Every `gh` mutation targets the pinned `owner/name` and a digits-only PR number from the re-read item; a PR item without a pinned name is never acted on.

### Requirement: Derived statuses

Statuses are derived every pass, never stored.

**Queue item status** (`operator.IsQueueItem`), first match: `done` (`done_at` set, or completion observed this pass) › `paused` › `skipped` › `held` (a dependency not satisfied) › `pending` (no pane, no `spawning`) › `spawn-unknown` (`spawning` set and no live pane, including a stale dead pane id left by a crashed respawn) › `spawned` (pane alive) › `dead` (pane recorded, not alive). `held` precedes `dead`. Dependency satisfaction is the readiness gate below.

**PR item status** (a `github-pr` item with `scope.merge_seq`), first match: `merged` (`gh` state `MERGED`, or `done_at`) › `halted` › `closed` (`CLOSED`) › `deferred` (stored) › `blocked` (a `depends_on` item is not done, or names no ledger item) › `draft` › `failed` (a required check is `FAILURE`) › `conflicting` (`mergeable == CONFLICTING` and `unchanged ≥ 3`) › `green` (no required check failing or pending, `mergeable == MERGEABLE`) › `waiting` (anything else, including a failed or unread fact). `merged` beats `halted`.

**Halted is derived over a cone.** A PR item is `halted` when `scope.halted` is set on it or on any not-done item it transitively `depends_on`. A halt writes `halted` on one item only; clearing it there resumes everything behind it. An upstream observed merged (stored `done_at`, or `MERGED` this pass) holds nothing back, so a stale `halted` on a hand-merged PR does not propagate.

**Armed is derived.** A PR is armed when `autoMergeRequest` is non-null in `gh pr view`, whoever armed it. **Repo auto-merge** is `autoMergeAllowed` from `gh repo view`. `scope.armed`, `scope.direct` and `scope.stall_seen` are never read or written by the engine; values already on disk are tolerated and left alone (a source-scan test asserts it).

### Requirement: Rule table

The rule table is the whole of autopilot behaviour. A behaviour is a status case, a row and an executor; nothing else acts. Rows, in table order:

| Row | Item · status | Guard | Action |
|---|---|---|---|
| Q1 | queue · `done` | `done_at` unset | `record-done` |
| Q2 | queue · `pending` | — | `spawn` (writes `spawning`) |
| Q3 | queue · `spawn-unknown` | not yet escalated | `escalate` `spawn interrupted: …` |
| Q4 | queue · `dead` | respawn unspent | `respawn` (writes `respawned` and `spawning`) |
| Q5 | queue · `dead` | respawn spent | `skip` (writes `skipped`, then escalates) |
| Q6a | queue · `spawned` | stage unchanged 30 min, not yet escalated | `escalate` once |
| Q7 | queue · `done` | `merge-auto`, not bare, `done_at` set, no PR item yet | `track-pr` |
| Q6b | the oldest unfinished queue item (any status but `done`, after every other row for it) | queue open 2 h, not yet escalated | `escalate` `queue open for over 2h0m0s` once |
| P1 | PR · `merged` | `done_at` unset | `record-merged` |
| P2 | PR · `closed` | — | `halt` |
| P3 | PR · `halted` | armed | `disarm` |
| P4 | PR · `draft` | not `stacked-prs` | `ready` |
| P5 | PR · `failed` / `conflicting` | not `stacked-prs`, not yet escalated for this head | `escalate` `recovery needed: <ci-failed|conflicting> — PR #<n> (<repo>)` |
| P6 | PR · `waiting` | not `stacked-prs`, not armed, repo allows auto-merge, required checks read | `arm` (`--auto --squash`) |
| P7 | PR · `green` | not `stacked-prs`, not armed, head commit observed | `merge` (`--squash --match-head-commit <observed head>`) |

Q1 precedes Q7, so a `merge-auto` item newly observed done is recorded on one pass and its one-PR sequence is created on the next. Q6b is split from Q6a because Q6a only covers a spawned item while Q6b reports a stuck queue whatever its oldest item's status (a skipped or held oldest item included). Every other (item kind, status) is an explicit wait (a declared entry with a reason): queue `done` after Q1/Q7, `paused`, `skipped`, `held`, `spawn-unknown` after Q3, `spawned`; PR `merged`, `halted` not armed, `deferred`, `blocked`, `draft` under `stacked-prs`, `failed`/`conflicting` already escalated, `green` armed (GitHub merges it) or without an observed head, `waiting` while checks are pending, the PR is armed or the repo has no auto-merge. A `stacked-prs` PR gets P1–P3 and waits only (its arm/merge/retarget is R6b). A halted, failed or conflicting PR is never armed or merged. A PR's status is derived before any arm, so a failing PR matches P5, never P6.

**Escalate-once** rows (Q3, Q6a, Q6b, P5) guard on and write the structured `scope.escalated` map keyed by reason (P5: reason plus head SHA), so a PR failing on head `X` escalates once, and again if it still fails on head `Y`. Note text is written for humans and the brief but never read by an engine decision.

### Requirement: Queue

`rk operator autopilot queue [--mode <m>] [--by user|run|chat] [--dry-run] < entries.json` persists N pending `pane` items in one locked write. Entries are `id`, `repo`, `change` | `task` | neither (bare), optional `depends_on` and `stop_stage`.

- **Stamping**: every item gets `scope.queue` (the queue id) and `scope.merge_mode`, resolved once as `--mode` > rk setting `operator.merge_mode` > `cherry-pick-ladder`; the receipt prints `mode: <name> (flag|setting|default)`. An invalid setting value is an error naming the valid set. fab's `autopilot.merge_mode` is never read.
- **Chaining**: each entry after the first depends on the nearest earlier same-repo entry, else the previous entry (cross-repo is ordering-only); explicit `depends_on` replaces it. In `merge-auto`, each entry depends on the previous entry as an ordering barrier only.
- **Rejected before any write**: forward and cyclic dependencies, dependencies on bare entries, duplicate or already-tracked ids, repos that are not absolute git roots, invalid branches.
- **Misfit-safe live call**: a live `queue` whose receipt has a misfit (`merge-auto` with explicit same-repo `depends_on`) and no explicit `--mode` writes nothing and errors naming the misfit. The chat flow is `queue --dry-run`, confirm mode and misfits with the user, then exactly one live call.
- **Explicit membership**: an item is queue work iff it carries `scope.queue`, or (legacy) a non-null `scope.merge_mode`, or has a `depends_on` edge with another queue-eligible item (`operator.IsQueueItem`, shared with the ownership rules). A pane tracked with `rk operator track add` is never spawned, respawned or listed by `status`.

### Requirement: Readiness gate

The queue status derivation above is the one readiness derivation: `status`, `spawn` and `respawn` all use it, and a null stored mode reads `cherry-pick-ladder`. A dependency (any unsatisfied one holds the item, even one with a pane) is satisfied when done:

- a fab item: `done_at`, `.status.yaml` `ship` done or skipped, or `stop_stage` reached;
- a change-less item: its branch has an open PR whose **required** checks pass (`gh pr checks <n> --required`; none required passes; optional checks never block) or a merged PR, persisted as `done_at`;
- a same-repo dependency with null `stop_stage` additionally needs its PR to exist. Tracking, a `branch_map` entry or a minted branch is not satisfaction. A dependency surviving only in `branch_map` passes; an unknown dependency id is unsatisfied;
- in `merge-auto`, the dependency's one-PR sequence item must have merged.

Every branch read from shared state (item scope, `branch_map`) passes `safeBranch` before any fetch, worktree, push or gh call on that path; an invalid branch is an escalation with no mutation. A `github-pr` item always carries an explicit `owner/name`, and every PR mutation (merge, arm, disarm, ready, view) targets that pinned name, never one re-derived from mutable `scope.repo`; executors act only on the re-read item (§ Pass shape).

### Requirement: Spawn

For each `pending`, unpaused queue item in queue order the engine:

1. targets `scope.repo` and runs `git fetch origin` first — **a failed fetch stops the spawn** (item stays `pending`, escalation, `rev-parse` never consulted). The default branch resolves through verified `origin/HEAD` → `gh repo view` → a `main`/`master` probe; the base is the **SHA** of `origin/<default>`, never a ref, so the new branch has no upstream tracking.
2. applies the confidence gate: an existing fab change whose `.status.yaml` score is below 3.0 is not spawned (escalation); raw-text entries skip it.
3. writes `scope.spawning` (RFC 3339), then opens the worktree and tab through `internal/riff` in-process ([rk-riff](/run-kit/rk-riff.md)): `WorktreeName` = item id, `WorktreeBase` = the SHA, role-aware landing session, window marked `auto` with note `"<id> · <stage>"`.
4. adds dependency code for the same-repo dependency subset (cross-repo is gate-only):
   - **`cherry-pick-ladder`**: the dependency branch comes from `scope.branch`, else `branch_map` (missing → escalate, no spawn). Dependencies whose branch is an ancestor of another dependency's branch are pruned, those already ancestors of `HEAD` skipped, then `git cherry-pick --no-commit origin/<default>..<dep-branch>` and `git commit -m "operator: cherry-pick <dep> dependency"`. A conflict runs `git cherry-pick --abort`, rolls the worktree back, escalates and opens no tab.
   - **`stacked-prs`**: the new branch is cut from the SHA of `origin/<dep-branch>` (never `wt create --checkout`). The base is recorded by `fab status set-base-branch <change> <dep-branch>` in the new worktree for an existing change, by a trailing prompt instruction to run it after `/fab-new` for a raw-text fab entry, or by naming the dependency branch as the PR base for a non-fab plain agent.
   - **`merge-auto`**: no chaining; the base is `origin/<default>` independently.
5. activates the pointer for an existing change (`fab change switch <change>`, fail-soft).
6. builds the prompt from the two-axis table (fab present × task given) using the **target** repo's `fab agent default` command and skill prefix: existing change → `<prefix>fab-fff <change>`; raw text → `<prefix>fab-new <text>`; no `fab/` with a task → the task plus "Commit on this branch, push, and open a draft PR against <base>."; bare → no prompt token. Never `fab init`, never raw implementation text to a fab-project agent.
7. attaches: `scope.pane`, `session`, `branch` and `branch_map[<change-or-id>]` in one locked write merged by id, which clears `spawning`. The branch recorded is the one the launch created, including for raw-task and bare launches.

**`spawning` marker.** The intent marker is written before the launch and cleared by the attach. A pass that finds `spawning` set with no `scope.pane` never relaunches: it escalates `spawn interrupted: <id> — check for an orphaned window, then clear scope.spawning with rk operator track update --force <id> --scope '{"spawning":null}'` and leaves the item alone. A launch that fails before a window exists (fetch failure, confidence gate, cherry-pick conflict with the worktree rolled back) clears `spawning` again. If the attach write fails the pass escalates naming the pane and leaves `spawning` set. If the item was removed (`track rm`) after the pass read it, the attach writes nothing, re-creates no item and escalates the orphan pane by id.

**Respawn.** A spawned queue item whose pane is gone and that is not done gets exactly one existing-branch respawn; `scope.respawned: true` is written before acting, together with `spawning`. Afterwards (row Q5) the item is marked `skipped` before the escalation is reported and its dependents stay held. Pane liveness is keyed by tmux pane id; id reuse is accepted.

### Requirement: Merge — cherry-pick-ladder and merge-auto

`rk operator autopilot merge [--repo <path>]` starts the ordered merge on the user's "merge all" (one in-chat confirm for the whole sequence). It writes intent — validation, the per-repo chains of `github-pr` items (`scope {repo, pr, change, merge_seq}`, `depends_on` the previous PR, base-first, cross-repo barriers preserved; an unresolvable `owner/name` creates no item and escalates), lifting `deferred` — then runs one pass; it has no advance loop of its own. It refuses while queue items are not done, is a no-op for `merge-auto` items, and **refuses a `stacked-prs` queue** with an operational error (exit 1) pointing at the run brief's stacked-prs merge text — nothing is written and no gh mutation runs. Later `step` passes advance the sequences through rows P1–P7. The Auto-Merge rules hold for `cherry-pick-ladder`:

1. **Sequential, one PR per pass** — only the sequence head is observed and acted on. P1 records a merge (`done_at`), which is what unblocks the successor, so PR_n is acted on the pass after PR_{n-1}'s merge is recorded, never in the same pass.
2. **Action shapes** — a draft is readied first (`gh pr ready`, P4). A green unarmed PR is merged directly (`gh pr merge --squash --match-head-commit <observed head>`, P7): this covers "already clean" (no required checks) and repos with auto-merge disabled (`autoMergeAllowed` false), so there are no arm-rejection fallbacks and no failed `--auto` attempt. While checks are pending and the repo allows auto-merge, the PR is armed (`gh pr merge --auto --squash`, P6), only after its required checks were read; GitHub then merges it and a later pass records it. The head pin means a head pushed after the check read is never merged unverified. Arm and merge failures escalate (`arming PR #n failed: …`, `merging PR #n failed: …`); the next pass re-observes `autoMergeRequest` and decides again. An already-armed or already-merged response counts as success.
3. **Stall is an escalation, not an action** — a failed required check, or `unchanged ≥ 3` with no failed check and `mergeable == CONFLICTING`, yields `recovery needed: <ci-failed|conflicting> — PR #<n> (<repo>)` once per head SHA and reason (P5). The engine does not arm or merge such a PR and takes no fix request, rebase, re-arm or recovery spawn; a PR a person already armed stays as it is.
4. **The items are the sequence** — a restarted run resumes from the state file alone.
5. **Halt disarms the cone** — a PR closed without merging (P2) halts its item: `halted` is written on that one item, with an escalation, and the item itself is disarmed if armed. P3 disarms every armed PR in the halted cone (the failing repo's sub-sequence plus repos with a transitive cross-repo `depends_on` into it), whoever armed it, retried every pass until GitHub reports it disarmed (`gh pr merge --disable-auto`; a PR already merged or closed counts as disarmed). A failed disarm escalates `disarming PR #n failed — it may still merge: …`. Independent sequences continue. The pass that writes `halted` disarms the halted item; the rest of the cone is observed and disarmed on the next pass. A halted head is never re-armed or merged. `stop` is global.

**`merge-auto`** arms on ship: when a queue item ships, the next pass records it done (Q1) and the one after creates its one-PR sequence (Q7: it finds the PR by branch and appends the `github-pr` item), which P4–P7 then ready, arm or merge. The next queue item stays `held` until that PR item has merged, then spawns on the advanced `origin/<default>` tip through the normal fetch and SHA pin. A halt disarms that PR and escalates; the next spawn stays deferred.

**Persist before acknowledge.** Markers that acknowledge an action (`halted`, `done_at`, stop's pause and halt) are written before the action is reported. Where the write fails, the result carries an escalation, never a success line. Merge lines carry repo and position (`ab12: merged (foo 1/2)`); a PR merged with no non-`PENDING` review is marked `· unreviewed` and summarised once per pass as `merged without review: #n (<change>), …`.

### Requirement: Stop and status

`stop` is the global user stop and is intent then one pass: it writes only `halted` on every not-done PR item and `paused` on every unspawned unfinished queue item (live panes are untouched), then runs the full pass, in which P3 disarms every armed PR in the halted cones, whoever armed it. It never reads an armed marker. `stop` returns an error when a halted PR's armed state could not be read (no pinned name, bad number, failed view) or a disarm failed, rather than claiming a disarm it could not place; a later `step` or `stop` retries. To resume a halted item the user clears `halted` with `rk operator track update --force` on the one item that carries it.

`status` is read-only — no pass lock, no escalations, no writes, live gh probes — and runs the same observe and derive stages as `step`. It shows the derived queue status name in `state` (`done`, `paused`, `skipped`, `held`, `pending`, `spawn-unknown`, `spawned`, `dead`) with mode, repo and branch, and for a row with a PR item the PR item's status and position (`PR #12 · green · 1/3`); `--json` keeps `state` and adds `pr_status`. A failed pane snapshot reads recorded panes as alive instead of failing, and a plain agent with no PR yet is not a warning. When every item is done it adds the Queue Completion Summary. Derived statuses are not exposed to `done_when`.

### Requirement: Escalations

A `step` pass reports its decided actions in ledger order: `spawned`, `respawned`, `cherry-picked`, `armed`, `merged` (P7 and P1 both), `readied`, `disarmed`, `paused`, `done`, `pr-tracked`, merge report lines and escalations. Escalation repeat-suppression is the structured `scope.escalated` map (reason key → first-seen time). The escalate-once record is written under the item's fingerprint, so a note and key never land on an item that changed since observe. Escalation notes carry the pass's `--by` author (default `run`).

### Requirement: Scope ownership

The engine's scope keys are defined once as constants in `internal/operator` and used by `internal/autopilot`; a drift test fails when the engine writes a scope key outside the registered set. The keys it writes are `queue`, `merge_mode`, `merge_seq`, `item`, `url`, `spawning`, `respawned`, `skipped`, `halted`, `deferred` and `escalated`; `armed`, `direct` and `stall_seen` stay registered (hand writes refused, old values tolerated on disk) but the engine neither reads nor writes them. The ownership table that refuses hand writes to them is in [operator-state](/run-kit/operator-state.md) § Scope ownership. `scope.memo` is the free-form area for AI and people; no engine path reads it.

### Requirement: Out of scope

- **`stacked-prs` merge-all** (direct merge, base retarget, `rebase --onto` plus `--force-with-lease`) is R6b. `merge` refuses it; the brief's stacked-prs text stays.
- **PR recovery** (the `ci-failed` fix round, the `conflicting` rebase and re-arm, the recovery spawn) is R6c. `step` only escalates `recovery needed` (P5); the brief's PR-recovery text drives the recovery and writes `scope.recovery` / `fix_head`.
- `brief_autopilot.md` is deleted in R7. Daemon-driven `step` and MCP tools for the verbs do not exist.
- No code in the engine claims, leases or compare-and-sets work: the pass lock and `spawning` marker are the whole concurrency model, and pane identity is recorded only by the spawn's attach write (there is no separate pane-pid fingerprint helper).

## Design Decisions

### Single-writer pass lock instead of claims
**Decision**: Serialise `step`/`merge`/`stop` per server with a non-blocking `flock` on `<slug>.autopilot.lock`; a second caller returns `busy` and exits 0. Crash safety rests on the `spawning` intent marker, which never auto-relaunches.
**Why**: Removes the overlapping-pass failure class wholesale; durable claims with leases and compare-and-set snapshots kept generating new failure cases. `flock` is released by the OS on process death, so the lock cannot leak (Constitution II).
**Rejected**: Durable claims with leases and CAS snapshots — correct but an unbounded review surface; a blocking lock — a stuck pass would hang runs and chat.
*Introduced by*: 261114-8w1x-operator-autopilot-go

### Stall is an escalation until PR recovery lands
**Decision**: A failed required check or a `CONFLICTING` stall yields `recovery needed: <reason>` (row P5) once per head SHA; the engine neither arms nor merges the PR and takes no other action.
**Why**: PR recovery is R6c; the run follows the brief's recovery text meanwhile.
**Rejected**: Disarming on stall — would turn a recoverable PR into a halted one before recovery exists.
*Introduced by*: 261114-8w1x-operator-autopilot-go

### Armed is derived, never stored
**Decision**: Armed is read from `autoMergeRequest` every pass and repo auto-merge from `autoMergeAllowed`; the engine writes no `armed`, `direct` or `stall_seen` and tolerates old values on disk. A halt disarms every armed PR in its cone, whoever armed it, retried every pass until GitHub reports it disarmed; a `merge_seq` PR item is protected from `track rm` instead of an `armed` marker.
**Why**: Most review findings against the stored-marker design were a marker disagreeing with GitHub (halted-and-armed, uncertain arm outcome, stale `direct`); deriving removes the marker and the code that protected it, and an unknown arm outcome resolves itself on the next observe.
**Rejected**: Keeping `armed` for `track rm` only — contradicts the stored-vs-derived rule; clearing a marker on any error — orphans an armed PR; a single disarm attempt — the armed PR would merge once checks go green.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

### One pure `decide` over a data rule table
**Decision**: Row selection is a pure function over a package-level table of `{id, kind, status, guard, action}` rows plus an explicit wait table; executors never decide, and a test enumerates every (kind, mode, status) for the row that fires or the wait.
**Why**: Table tests need no git or `gh` fakes, and R6b and R6c add rows plus executors rather than branches in a driver loop; a combination with neither row nor wait is visible as `unmatched` instead of silently acted on.
**Rejected**: Imperative per-phase loops (`driveHead`, `directMerge`, `retryDisarms`) tested through fakes — each new behaviour re-opens the same review loop.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

### One PR per pass
**Decision**: A sequence head is observed and acted on once per pass; P1 records a merge and the successor is observed and armed or merged on the next pass.
**Why**: No action reads the effect of another in the same pass, so statuses stay a pure function of one snapshot and the arm/merge of PR_n can never rest on a merge that was only just requested.
**Rejected**: Re-observing and chaining within a pass — reintroduces the guard loops the table replaced.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

### Executors re-read and guard their writes
**Decision**: Each executor re-reads its item and skips it (escalating `changed externally; skipped`) when its decision-input fingerprint changed; records of a decision are written under the lock against that fingerprint; P7 pins the merge with `--match-head-commit` and P6 requires the checks to have been read.
**Why**: External writes win over the engine's snapshot, and a head pushed between the check read and the merge must not merge unverified code.
**Rejected**: Trusting the observe snapshot until execute — a hand edit or a new push could make the engine merge, arm or write against the wrong thing.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

### Fetch-first SHA pin
**Decision**: A spawn fetches first, stops on fetch failure, and bases the worktree on the SHA of `origin/<default>` (or `origin/<dep-branch>` for `stacked-prs`).
**Why**: A stale local ref would start the branch behind; a ref start point sets upstream tracking.
**Rejected**: `wt create --checkout` for stacked dependents; a base ref instead of a SHA.
*Introduced by*: 261114-8w1x-operator-autopilot-go

### Merge mode is an rk setting, resolved once at queue time
**Decision**: `operator.merge_mode` lives in rk settings and is read only by `queue`, then stamped on every item.
**Why**: Later passes must not change a queue's mode when a setting flips; fab's `autopilot.merge_mode` is never read, so there is no dual-read.
**Rejected**: Reading the mode on every pass; falling back to fab's key.
*Introduced by*: 261114-8w1x-operator-autopilot-go
