---
type: memory
description: "The Go autopilot core behind `rk operator autopilot` verbs (queue, step, merge, stop, status) (`internal/autopilot`): queue model over tracked items, readiness gate, three-mode spawn with the `spawning` marker, cherry-pick-ladder merge-all and merge-auto, the single-writer pass lock and `busy`, `recovery needed` escalations, durable disarm retry, and what stacked-prs merge-all (R6b) and PR recovery (R6c) still own."
---
# Operator Autopilot

**Domain**: run-kit

## Overview

`internal/autopilot` (`app/backend/internal/autopilot`, CLI in `cmd/rk/operator_autopilot.go`) is the operator's deterministic queue engine: the git, gh, wt and fab choreography that used to be prose a model re-derived on every run. It owns no state. A queue is N `pane` tracked items chained by `depends_on`, a merge sequence is a chain of `github-pr` items, and every verb re-derives what to do from the operator state file ([operator-state](/run-kit/operator-state.md)), acts, and writes back through `operator.Mutate`. Runs and chat call it; the daemon does not. The engine never notifies: a failure or halt is an `Escalation{item, reason}` in the result plus a note on the item, and the caller turns each escalation into `rk notify`. The scope is **R6a**: queue, readiness gate, spawn for all three modes, `cherry-pick-ladder` merge-all and `merge-auto`. The `stacked-prs` merge-all path is R6b and PR recovery is R6c; until they land the run brief keeps that text ([operator-brief](/run-kit/operator-brief.md)).

## Requirements

### Requirement: Verbs and exit codes

`rk operator autopilot` has five children, each with `-L/--server` (default: the caller's server from `$TMUX`) and `--json` (the shared `{"ok":true,"result":{…}}` envelope). `queue` takes a JSON array on stdin. `step`, `merge` and `stop` take the pass lock; `queue` and `status` do not, and `step --dry-run` reads but neither writes nor locks. No verb waits for CI. Exit codes: 0 ok (a `busy` result included), 1 operational (state file busy or unreadable, a gh lookup failed, `merge` on incomplete or `stacked-prs` queues), 2 usage or invalid input. Human output caps every list at 20 entries with an exact total, a truncation notice and `--all`; `--json` is always complete. Help text states exactly what the implementation does, pinned by CLI tests.

`Env` is the engine's seam set: a `Runner` (argv-slice `exec.CommandContext` with a per-class timeout — fetch 60s, other git/gh/wt 30s, fab 10s), a `Spawner`, a `Panes` snapshot, the state path, a clock. Git behaviour is tested against real temp repos (bare origin plus clones) with a hermetic git identity pinned by `main_test.go`; `gh` and `fab` go through a scripted runner fake.

### Requirement: Single-writer pass lock

`Step`, `StartMerge` and `Stop` each take an exclusive, non-blocking `flock` (`LOCK_EX|LOCK_NB`) on `<state dir>/<slug>.autopilot.lock` — beside the state file, same directory and `cron.FabOperatorSlug` slug — for the whole pass. A caller that finds it held does nothing and returns `Busy: true`: exit 0, one human line saying another autopilot pass is running on this server and to retry later, `"busy":true` in `--json`. The OS releases a `flock` when the process dies, so a crash never leaves the lock held. The lock is per server: a held lock for one server does not block another. The state file's sidecar lock is unchanged and never held across a subprocess; every write loads fresh state under it and merges by item id, so `rk operator track`, `rk operator check` and the daemon keep writing concurrently and external writes win. The pass lock serialises autopilot passes only.

- **GIVEN** a process holds the lock **WHEN** `step`, `merge` or `stop` runs **THEN** it returns `busy`, makes no state write and runs no git/gh/wt/fab/tmux mutation
- **GIVEN** a pass returned, normally or with an error **WHEN** the next pass runs **THEN** it acquires the lock

### Requirement: Queue

`rk operator autopilot queue [--mode <m>] [--by user|run|chat] [--dry-run] < entries.json` persists N pending `pane` items in one locked write. Entries are `id`, `repo`, `change` | `task` | neither (bare), optional `depends_on` and `stop_stage`.

- **Stamping**: every item gets `scope.queue` (the queue id) and `scope.merge_mode`, resolved once as `--mode` > rk setting `operator.merge_mode` > `cherry-pick-ladder`; the receipt prints `mode: <name> (flag|setting|default)`. An invalid setting value is an error naming the valid set. fab's `autopilot.merge_mode` is never read.
- **Chaining**: each entry after the first depends on the nearest earlier same-repo entry, else the previous entry (cross-repo is ordering-only); explicit `depends_on` replaces it. In `merge-auto`, each entry depends on the previous entry as an ordering barrier only.
- **Rejected before any write**: forward and cyclic dependencies, dependencies on bare entries, duplicate or already-tracked ids, repos that are not absolute git roots, invalid branches.
- **Misfit-safe live call**: a live `queue` whose receipt has a misfit (`merge-auto` with explicit same-repo `depends_on`) and no explicit `--mode` writes nothing and errors naming the misfit. The chat flow is `queue --dry-run`, confirm mode and misfits with the user, then exactly one live call.
- **Explicit membership**: an item is queue work iff it carries `scope.queue`, or (legacy) a non-null `scope.merge_mode`, or has a `depends_on` edge with another queue-eligible item (`operator.IsQueueItem`, shared with the ownership rules). A pane tracked with `rk operator track add` is never spawned, respawned or listed by `status`.

### Requirement: Readiness gate

Derived state, strict precedence: `done` › `paused` › `held` (any dependency unsatisfied, even with a pane) › `pending` (unspawned, dependencies satisfied) › `spawned`; a null stored mode reads `cherry-pick-ladder`. `status`, `spawn` and `respawn` all use this one derivation. A dependency is satisfied when done:

- a fab item: `done_at`, `.status.yaml` `ship` done or skipped, or `stop_stage` reached;
- a change-less item: its branch has an open PR whose **required** checks pass (`gh pr checks <n> --required`; none required passes; optional checks never block) or a merged PR, persisted as `done_at`;
- a same-repo dependency with null `stop_stage` additionally needs its PR to exist. Tracking, a `branch_map` entry or a minted branch is not satisfaction. A dependency surviving only in `branch_map` passes; an unknown dependency id is unsatisfied.

Every branch read from shared state (item scope, `branch_map`) passes `safeBranch` before any fetch, worktree, push or gh call on that path; an invalid branch is an escalation with no mutation. A `github-pr` item always carries an explicit `owner/name`, and every PR mutation (merge, arm, disarm, ready, view) targets that pinned name, never one re-derived from mutable `scope.repo`; marker writes verify the item still names the same PR number and name as the pass snapshot.

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

**Respawn.** A spawned queue item whose pane is gone and that is not done gets exactly one existing-branch respawn; `scope.respawned: true` is written before acting, together with `spawning`. Afterwards the item is skipped with an escalation and its dependents stay held. Pane liveness is keyed by tmux pane id; id reuse is accepted.

### Requirement: Merge — cherry-pick-ladder and merge-auto

`rk operator autopilot merge [--repo <path>]` starts the ordered merge on the user's "merge all" (one in-chat confirm for the whole sequence). It refuses while queue items are not done, is a no-op for `merge-auto` items, and **refuses a `stacked-prs` queue** with an operational error (exit 1) pointing at the run brief's stacked-prs merge text — nothing is written and no gh mutation runs. Sequences are per-repo chains of `github-pr` items (`scope {repo, pr, change, merge_seq}`, `depends_on` the previous PR), base-first, cross-repo barriers preserved; an unresolvable `owner/name` creates no item and escalates. Later `step` passes advance them. The five Auto-Merge rules hold for `cherry-pick-ladder`:

1. **Sequential arming** — at most one armed PR per repo sequence; PR_n is armed only after PR_{n-1}'s merge is verified (its item done, `state == MERGED`).
2. **Arming shapes** — a draft is readied first (`gh pr ready`); `--squash` always; "already clean" (no required checks) → `gh pr merge --squash` directly; auto-merge disabled on the repo → a step-driven direct merge when required checks are green and the PR is `MERGEABLE`.
3. **Stall is an escalation, not an action** — a failed required check, or `unchanged ≥ 3` with no failed check and `mergeable == CONFLICTING`, yields `recovery needed: <ci-failed|conflicting> — PR #<n> (<repo>)` once per head SHA and reason, and leaves the PR **armed**. No fix request, rebase, re-arm or recovery spawn.
4. **The items are the sequence** — a restarted run resumes from the state file alone.
5. **Disarm on halt** — `gh pr merge --disable-auto` over the halted cone only: the failing repo's sub-sequence plus repos with a transitive cross-repo `depends_on` into it. Independent sequences continue. `stop` is global.

**`merge-auto`** arms on ship: when a queue item ships, the next `step` creates its one-PR sequence and arms it by rule 2. The next queue item stays `held` until that merge is verified, then spawns on the advanced `origin/<default>` tip through the normal fetch and SHA pin. A halt disarms that PR and escalates; the next spawn stays deferred.

**Arm durability.** `scope.armed` is written before `gh pr merge --auto`. Only a definitive rejection from a closed list (auto-merge not allowed on the repo, PR not in a state to enable auto-merge, "clean status" → direct merge) clears it. Timeouts, network/5xx and unrecognised errors keep the marker and escalate `arm outcome uncertain`, so `stop` can still disarm.

**Durable disarm retry.** A PR item with `halted` (a cone halt, or `stop`) and `armed` still set is retried with `--disable-auto` on every later `step` and `stop` pass until the disarm succeeds, reports already-disabled, or the PR is merged or closed; only then is `armed` cleared. Every failed attempt escalates. A halted head is never re-armed or merged by the engine.

**Persist before acknowledge.** Markers that acknowledge an action (`halted`, merged-completion `done_at`, stop's pause and halt) are written before the action is reported. Where the external action must come first and the write fails, the result carries an escalation, never a success line. Merge lines carry repo and position (`ab12: merged (foo 1/2)`); a PR merged with no non-`PENDING` review is marked `· unreviewed` and summarised once per pass as `merged without review: #n (<change>), …`.

### Requirement: Stop and status

`stop` is the global user stop: it halts unfinished PR items, disarms every armed PR (retried until durable) and pauses every unspawned queue item (`paused: true`); live panes are untouched. To resume a halted item the user clears `halted` with `rk operator track update --force`. `status` is read-only — no pass lock, no escalations, no writes, live gh probes for readiness — and lists per queue item the derived state, mode, repo, branch, PR and merge position, plus the Queue Completion Summary when every item is done.

### Requirement: Step order and escalations

One `step` is one idempotent pass: (a) persist newly observed `done_at` for change-less items; (b) advance merge sequences (verify merges, arm next, create and arm `merge-auto` PRs, retry pending disarms) and stall detection; (c) spawn or respawn eligible queue items in queue order; (d) flag slow work (a spawned item's stage unchanged over 30 minutes, a queue open over 2 hours). The result lists actions (`spawned`, `respawned`, `cherry-picked`, `armed`, `merged`, `disarmed`, `paused`, `done`, `pr-tracked`), merge report lines and escalations. Escalation repeat-suppression is the structured `scope.escalated` map (reason key → first-seen time); note text is written for humans and the brief but never read by an engine decision. Escalation notes carry the pass's `--by` author (default `run`).

### Requirement: Scope ownership

The engine's scope keys (`queue`, `merge_mode`, `merge_seq`, `item`, `url`, `spawning`, `respawned`, `skipped`, `armed`, `halted`, `direct`, `stall_seen`, `deferred`, `escalated`) are defined once as constants in `internal/operator` and used by `internal/autopilot`; a drift test fails when the engine writes a scope key outside the registered set. The ownership table that refuses hand writes to them is in [operator-state](/run-kit/operator-state.md) § Scope ownership. `scope.memo` is the free-form area for AI and people; no engine path reads it.

### Requirement: Out of scope

- **`stacked-prs` merge-all** (direct merge, base retarget, `rebase --onto` plus `--force-with-lease`) is R6b. `merge` refuses it; the brief's stacked-prs text stays.
- **PR recovery** (the `ci-failed` fix round, the `conflicting` rebase and re-arm, the recovery spawn) is R6c. `step` only escalates `recovery needed`; the brief's PR-recovery text drives the recovery and writes `scope.recovery` / `fix_head`.
- `brief_autopilot.md` is deleted in R7. Daemon-driven `step` and MCP tools for the verbs do not exist.
- No code in the engine claims, leases or compare-and-sets work: the pass lock and `spawning` marker are the whole concurrency model, and pane identity is recorded only by the spawn's attach write (there is no separate pane-pid fingerprint helper).

## Design Decisions

### Single-writer pass lock instead of claims
**Decision**: Serialise `step`/`merge`/`stop` per server with a non-blocking `flock` on `<slug>.autopilot.lock`; a second caller returns `busy` and exits 0. Crash safety rests on the `spawning` intent marker, which never auto-relaunches.
**Why**: Removes the overlapping-pass failure class wholesale; durable claims with leases and compare-and-set snapshots kept generating new failure cases. `flock` is released by the OS on process death, so the lock cannot leak (Constitution II).
**Rejected**: Durable claims with leases and CAS snapshots — correct but an unbounded review surface; a blocking lock — a stuck pass would hang runs and chat.
*Introduced by*: 261114-8w1x-operator-autopilot-go

### Stall is an escalation until PR recovery lands
**Decision**: A failed required check or a `CONFLICTING` stall yields `recovery needed: <reason>` and leaves the PR armed.
**Why**: PR recovery is R6c; the run follows the brief's recovery text meanwhile.
**Rejected**: Disarming on stall — would turn a recoverable PR into a halted one before recovery exists.
*Introduced by*: 261114-8w1x-operator-autopilot-go

### Unknown arm outcomes keep the marker
**Decision**: `armed` is written before `gh pr merge --auto` and cleared only by a definitive rejection from a closed, tested list.
**Why**: A timeout may have armed the PR; keeping the marker lets `stop` and the disarm retry reach it, while a cleared marker would leave an armed PR with nothing pointing at it.
**Rejected**: Clearing on any error — orphans an armed PR; never clearing — blocks the direct-merge fallbacks.
*Introduced by*: 261114-8w1x-operator-autopilot-go

### Disarm is retried until durable
**Decision**: A halted PR with `armed` still set is re-disarmed on every later `step` and `stop` until `--disable-auto` succeeds or the PR is merged or closed.
**Why**: One transient failure must not leave a PR both `halted` and armed with later passes skipping it.
**Rejected**: A single attempt with an escalation — the armed PR would merge once checks go green.
*Introduced by*: 261114-8w1x-operator-autopilot-go

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
