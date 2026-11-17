---
type: memory
description: "The Go autopilot behind `rk operator autopilot` in `internal/autopilot`: pass-locked engine state, ledger projections, derived queue/PR/fix statuses, the X/Q/P/B/C/F rule table, bounded CI-fix and rebase recovery, the stacked-prs `stale-base` status and `restack` executor, direct merge of stacked chains, three-mode spawn, and escalations as notes plus notify."
---
# Operator Autopilot

**Domain**: run-kit

## Overview

`internal/autopilot` (`app/backend/internal/autopilot`, CLI in `cmd/rk/operator_autopilot.go` and `operator_autopilot_admin.go`) is the operator's deterministic queue engine: the git, gh, wt and fab choreography a model once re-derived on every run. The engine owns its intent in its own file, `<slug>.autopilot.yaml` beside the operator ledger, written only by `rk operator autopilot` verbs while they hold the pass lock. The ledger ([operator-state](/run-kit/operator-state.md)) holds only **projection items** for engine work: the pane binding and identity a user sees in `track list`, the notes, and the facts `rk operator check` records. Every pass re-derives what to do from the engine file, the projections and facts read from tmux, git and GitHub, then acts. Statuses are derived, never stored; behaviour is a row in one data table. The operator-loop wrapper runs a pass before any model call ([operator-loop](/run-kit/operator-loop.md)), and chat runs the same verbs; the daemon never runs one. An escalation is a `by: run` note on the item's projection plus a notification. The engine covers queue/readiness/spawn, ordered merge in all three modes (a stacked chain is restacked and merged directly), its own state file and mechanical runs, plus bounded PR recovery.

## Requirements

### Requirement: Verbs and exit codes

`rk operator autopilot` has seven children, each with `-L/--server` (default: the caller's server from `$TMUX`) and `--json` (the shared `{"ok":true,"result":{…}}` envelope). `queue` takes a JSON array on stdin; `rm <id>`, `resume <id>` and `pause <id>` take one engine item id. `queue`, `step`, `merge`, `stop`, `rm`, `resume` and `pause` take the pass lock; `status` takes none and writes nothing; `queue --dry-run` and `step --dry-run` read but neither write nor lock. No verb waits for CI. Exit codes: 0 ok (a `busy` result included, except `queue`), 1 operational (state file busy or unreadable, a state write failed, a gh lookup failed, `merge` on an incomplete queue, `queue` finding the lock held, `rm` of a sequence with an armed or unreadable PR), 2 usage or invalid input. Human output caps every list at 20 entries with an exact total, a truncation notice and `--all`; `--json` is always complete. `step --dry-run` prints each decided row as an action `dry-run: <action> <item> (<row>)` (e.g. `dry-run: spawn ab12 (Q2)`) and lists no waits. Help text states exactly what the implementation does, pinned by CLI tests.

`Env` is the engine's seam set: a `Runner` (argv-slice `exec.CommandContext` with a per-class timeout — fetch 60s, other git/gh/wt 30s, fab 10s), a `Spawner`, a `Panes` snapshot plus busy-aware `Send`, the state path, a clock, and `Notify func(ctx, title, body)`. `Send` returns `ErrPaneBusy` for an active or waiting agent; otherwise it uses the sanitized mux injection engine with Enter. `cmd/rk` builds one production Env for `step`, `queue`, `merge`, `stop`, `rm`, `resume` and the run wrapper, wiring `Notify` to `sendNotify`; tests may pass nil. Git behaviour is tested against real temp repos (bare origin plus clones) with a hermetic git identity pinned by `main_test.go`; `gh` and `fab` go through a scripted runner fake.

### Requirement: Engine state file

The engine's stored state lives in `<state>/hexokit/operator/<slug>.autopilot.yaml`, derived from `Env.StatePath` the way `<slug>.autopilot.lock` is. It is written with mode `0600` through `internal/fsatomic`, and only by the lock-holding verbs (`queue`, `step`, `merge`, `stop`, `rm`, `resume`); no write path exists outside a held lock, and `--dry-run` writes nothing. The file carries `version: 1`, `migrated` once the one-time move has completed, and three ordered lists — `queue`, `prs` and `fixes` — whose order is execution order. Items are keyed by `id`:

- **Queue item**: `queue` (the queue id), `merge_mode`, `task` | `change` | `bare`, `repo`, `stop_stage`, `depends_on`, `paused`, `spawning`, `respawned`, `skipped`, the spawn binding `pane`/`session`/`branch`/`worktree`, `spawned_by`, `projected`, `pr_dropped`, `done_at`, `escalated`.
- **PR item** (a merge-sequence PR): `item` (the owning queue item), `repo`, `nwo`, `pr`, `url`, `branch`, `change`, `merge_seq`, `merge_mode`, `depends_on`, `deferred`, `halted`, `projected`, `done_at`, `escalated`, plus the recovery fields `recovery` (the spent `ci-fix` and `rebase` rounds as a set), `fix_head`, `recovery_at` and `fix_item`.
- **Fix item** (a recovery-spawn agent): identity and binding only — `id`, `repo`, `branch`, `change`, `pane`, `session`, `spawning`, `projected`, `escalated`, timestamps and `spawned_by`. Its parent is the PR whose `fix_item` names it; there is no back-link key. Fix items never join queue derivation, readiness, dependencies or merge sequences, and `OwnedIDs` includes them.

Reads are tolerant: unknown fields are ignored and a missing file reads as an empty engine; `status` on a server with no file reports an empty queue and creates nothing. Non-monotone facts — `armed`, `direct`, mergeable, checks, base and head — are never stored; they are read fresh every pass. Writes are durable before a verb returns (Constitution II). Engine decisions read a ledger item only for the projection facts below, never its `scope` for anything else.

**One-time move.** Every lock-holding verb runs the migration until it has completed once; the engine file's `migrated: true` marks completion, and from then on a ledger scope key written later (`queue`, `merge_mode`, `merge_seq`) never creates engine work. The move absorbs ledger `pane` items carrying `scope.queue` or a non-null `scope.merge_mode`, and `github-pr` items carrying `scope.merge_seq`; an ordinary pane item with a `depends_on` edge is never absorbed. Their engine keys and `depends_on` are copied into the engine file (an id already present keeps the engine file's values), the engine file is written first, then one locked ledger write strips the engine keys, sets `depends_on: []`, and drops a migrated queue item that has no pane and no notes. A crash between the two writes is repaired by the next verb; a ledger with nothing to move writes nothing to it.

#### Scenario: Engine file beside the ledger
- **GIVEN** a server with no `<slug>.autopilot.yaml`
- **WHEN** `rk operator autopilot queue` writes items
- **THEN** the file exists with mode `0600` and the ledger holds no engine key

### Requirement: Projection items

The ledger holds only projections of engine work. A `pane` projection (id = the queue or fix item id) is added when a spawn, respawn or recovery spawn attaches a pane, carrying `pane`, `session`, `repo`, `change`, `branch`, `stop_stage`, `spawned_by`; a `github-pr` projection (id `pr-<n>`, with the existing collision rule) is added by `track-pr` or when `merge` starts a sequence, carrying `repo`, `pr`, `change`. A projection carries no engine key and `depends_on: []`. The engine's view of an item (`engineView`) overlays onto the engine record the pane facts only the check learns (`overlayPaneFacts`): the `change` a raw-task spawn acquired from `/fab-new`, the `stage`, and the branch `branch_map[<change>]` records — `/fab-new` renames the spawn-time branch to the change name, so the engine's own `branch` goes stale and every reader (respawn, cherry-pick sources, status, the projection write-back) takes the view's. After a successful projection write the engine records `projected: true` on its item; a spawned or tracked engine item with `projected` unset and no ledger item is re-projected idempotently (row X1). F1 removes a resolved fix item's projection without closing its window. The engine writes nothing to a ledger item except the projection keys, escalation notes, and the PR poll bookkeeping (`last`, `checked_at`, `unchanged`, `failures`) that `operator.Observe` updates for a sequence head, because the `conflicting` stall clock reads `unchanged`. `rk operator check` fields (`reported`, `done_at`, conditions) are facts the engine reads and never writes.

The engine observes projections as external facts:

- **Removed** — an engine item with `projected: true` and no ledger item escalates once (`projection removed: <id>`, notify and result line, no ledger note, row X0). The engine keeps managing the item from its own state and never re-adds the projection, including on `respawn`, which records the new binding in the engine file only. A removed projection on a done item is routine cleanup and does not escalate.
- **Paused** — a paused queue projection derives queue status `paused`; queue `paused` is the engine's `paused` OR the projection's, so a projection never clears the engine's pause (`stop`'s pause holds for an item with an identity-only projection), and a view-only overlay value is never written back into an engine item — except that a queue item's next guarded write stores the overlaid `change` and `branch` (`engineItemFromTracked` copies them from the view), which is what keys the projection write-back's `branch_map` entry by change; `stage` is never stored. A paused PR projection derives PR status `paused`.
- **Identity-only** — an escalation on a queue item with no projection yet first adds a `pane` projection with no `pane` key to hold the note; the later spawn binds the pane onto that same item.
- **Completion** — pane liveness for `spawned`, `dead` and `spawn-unknown` reads the engine file's own binding; completion reads rk's pane map and the projection's `done_at`. An observed completion from either source is cached as `done_at` in the engine file, and Q1's guard keys on the engine file's own `done_at`, never on the overlaid view, so removing a projection after its pane closed never turns a finished item into `dead` or respawns it.

#### Scenario: Removed projection
- **GIVEN** a spawned queue item whose projection the user removed with `track rm`
- **WHEN** a pass runs twice
- **THEN** one `projection removed: …` escalation is notified on the first pass only, and no projection is re-added

#### Scenario: Paused PR projection
- **GIVEN** a merge-auto PR item `pr-41` the user paused with `track pause pr-41`, green and not armed
- **WHEN** a pass runs
- **THEN** its status is `paused` and no `ready`, `arm` or `merge` is decided for it

### Requirement: Single-writer pass lock

`Step`, `Enqueue`, `StartMerge`, `Stop`, `Remove` and `Resume` each take an exclusive, non-blocking `flock` (`LOCK_EX|LOCK_NB`) on `<state dir>/<slug>.autopilot.lock` — beside the state file, same directory and `cron.FabOperatorSlug` slug — for the whole verb, the migration included. A caller that finds it held writes nothing and returns `Busy: true`: exit 0, one human line saying another autopilot pass is running on this server and to retry later, `"busy":true` in `--json`. `queue` is the exception: it prints `busy: another autopilot pass is running on this server; queue not written, retry` and exits 1, so a caller never mistakes an unwritten queue for a queued one. The OS releases a `flock` when the process dies, so a crash never leaves the lock held. The lock is per server. The ledger's sidecar lock is separate and never held across a subprocess; every ledger write loads fresh state under it and merges by item id, so `rk operator track`, `rk operator check` and the daemon keep writing the ledger concurrently and external writes win. The pass lock serialises engine passes and is what makes the engine file single-writer.

- **GIVEN** a process holds the lock **WHEN** `step`, `merge`, `stop`, `rm` or `resume` runs **THEN** it returns `busy`, makes no state write and runs no git/gh/wt/fab/tmux mutation
- **GIVEN** a pass returned, normally or with an error **WHEN** the next pass runs **THEN** it acquires the lock

### Requirement: Pass shape

`Step` (and the pass inside every other lock-holding verb) runs four stages under the pass lock:

1. **Observe** — load the engine file and the ledger, take one pane snapshot, and read facts only for items that can act: completion for each unfinished queue item with a pane (a fab item's pane stage reaching `ship` or its `stop_stage`; a plain agent's branch PR merged, or open with required checks not pending); the same-repo dependency PR's existence for each item that may be held; per merge sequence the head (first not-done PR item) unless it is `deferred` or blocked, and every not-done PR item of a halted cone. A PR fact is `gh pr view <n> --repo <nwo> --json number,url,state,isDraft,mergedAt,mergeable,headRefOid,baseRefName,autoMergeRequest` plus `gh pr checks <n> --required --json name,state,link` (only when the status reaches the check statuses); the repo fact is `gh repo view <nwo> --json autoMergeAllowed`, cached per repo per pass and read only for a `waiting`, unarmed, non-`stacked-prs` PR. A failed read escalates (`gh pr view failed: …`, `gh pr checks failed: …`, `repo auto-merge lookup failed: …`) and the item is `waiting` for the pass; no other item is blocked. A sequence head's polled `state`/`mergedAt`/`mergeable` is written through `operator.Observe` to its projection (the `unchanged` clock; skipped under `--dry-run`), and the decision snapshot is reloaded after that write. A `stacked-prs` sequence head not settled by the statuses before `stale-base` also reads the stale-base facts (§ Derived statuses) before its draft and check statuses, and a head that derives `stale-base` reads no checks; a non-stacked PR pays none of these reads, and the read-only `status` view runs them too. The reads are the repo's default branch (cached per repo per pass), the in-sequence predecessor's merge commit (`gh pr view <pred-n> --repo <nwo> --json mergeCommit`; a null or empty oid is unreadable) and, when the base is the default branch and the merge commit is known, ancestry through the compare API (`gh api repos/<nwo>/compare/<mergeOid>...<headRefOid> --jq .status`: `ahead` or `identical` is an ancestor, `behind` or `diverged` is not, anything else is unreadable). A failed read escalates through the usual dedupe with its own prefix (`predecessor merge commit lookup failed: …`, `ancestry lookup failed: …`). Other sequence predecessors are not read.
2. **Derive** — a queue status per engine queue item, a PR status per engine PR item and a fix status per recovery item: first match, pure.
3. **Decide** — `decide(state, facts, now)` is pure (no I/O, no `ctx`) and walks the package-level rule table; at most one decision per item, first matching row in table order, in engine order. Every (item kind, merge mode, status) has a row or an explicit entry in the wait table; a combination with neither is reported as `unmatched` and never acted on (a table test enumerates every reachable combination, fix items included).
4. **Execute** — one executor per typed action (`record-done`, `spawn`, `respawn`, `skip`, `escalate`, `re-project`, `track-pr`, `record-merged`, `halt`, `disarm`, `ready`, `arm`, `merge`, `fix-request`, `recovery-spawn`, `rebase`, `restack`, `untrack`) in engine order. No action sees another's effect through a status: a successor acts on the next pass (a sequence advances one PR per pass). A hard error in one executor does not stop later actions (a failed record must not skip a later disarm); the errors are joined.

**Executors act on a re-read item.** Before acting, an executor re-reads the engine item and its projection (for paused, removed and done facts) and skips it with `item <id> changed externally; skipped` (PR items: `PR item <id> changed externally; skipped`) when it vanished or changed since observe. A non-idempotent action (`spawn`, `respawn`, `skip`, `halt`, `escalate`, `fix-request`, `recovery-spawn`) writes its intent to the engine file first (`spawning`; `respawned` with `spawning`; `skipped`; `halted`; recovery round/head/time/fix link). A conflict `rebase` spends its round immediately before the lease-pinned push, or together with `halted` when the rebase fails. `restack` writes no intent marker and no engine key: it is repeatable from `origin/<branch>` and the status it fires on is re-derived each pass; its only engine write is `halted` on a rebase conflict. An idempotent one (`record-*`, `arm`, `disarm`, `ready`, `merge`, `untrack`) writes nothing the next pass cannot re-derive. Every `gh` mutation targets the pinned `owner/name` and a digits-only PR number from the re-read item; a PR item without a pinned name is never acted on.

### Requirement: Derived statuses

Statuses are derived every pass, never stored.

**Queue item status** (an item in the engine file's `queue`), first match: `done` (`done_at` set in the engine file, or completion observed this pass) › `paused` (engine or projection) › `skipped` › `held` (a dependency not satisfied) › `pending` (no pane, no `spawning`) › `spawn-unknown` (`spawning` set and no live pane, including a stale dead pane id left by a crashed respawn) › `spawned` (pane alive) › `dead` (pane recorded, not alive). `held` precedes `dead`. Dependency satisfaction is the readiness gate below.

**PR item status** (an item in the engine file's `prs`), first match: `merged` (`gh` state `MERGED`, or `done_at`) › `paused` (projection) › `halted` › `closed` (`CLOSED`) › `deferred` (stored) › `blocked` (a `depends_on` item is not done, or names no engine item) › `stale-base` › `draft` › `fixing` (`ci-fix` spent and the observed head equals `fix_head`, without reading checks) › `failed` (a required check is `FAILURE`) › `conflicting` (`mergeable == CONFLICTING` and `unchanged ≥ 3`) › `green` (no required check failing or pending, `mergeable == MERGEABLE`) › `waiting` (anything else, including a failed or unread fact). `merged` beats `paused`, `halted` and an open fix round. A new head falls through to the ordinary check statuses.

**`stale-base`** applies to `stacked-prs` PRs only; no other mode ever derives it. A stacked PR is `stale-base` when, with its facts read this pass, its `baseRefName` is not the repo's default branch, or it has an in-sequence predecessor whose merge commit is not an ancestor of its `headRefOid`. The in-sequence predecessor is the `depends_on` entry that is a PR item with the same `merge_seq`; cross-repo barrier entries are not predecessors. Unknown facts never derive `green`: when the head view, the default branch, the predecessor's merge commit or the ancestry could not be read, the PR derives `waiting` (never `stale-base`, `draft`, `failed`, `conflicting` or `green`). The default branch counts as known only when it came from a verified `origin/HEAD` or a non-empty `gh repo view` answer, not from the `main`/`master` probe that spawn still accepts; an unproven default branch or an empty `baseRefName` derives `waiting` and escalates once per text. A stacked PR derives `green` only when this pass established base == default and, with a predecessor, ancestry true.

**Fix item status** (an item in `fixes`), first match: `resolved` (parent missing, merged or halted, or green on a head different from `fix_head`) › `spawn-unknown` (`spawning` set and no live pane) › `working` (anything else, including a dead fix pane while the parent's no-push timer runs). The authoring pane is the lexicographically lowest live pane whose derived change equals the PR's change or contains its id as a `-`-delimited segment; a change-less PR falls back to its queue item's live pane. Active and waiting agents are busy, and an unknown pane snapshot never selects a fix request or spawn.

**Halted is derived over a cone.** A PR item is `halted` when `halted` is set on it or on any not-done item it transitively `depends_on`. A halt writes `halted` on one item only; clearing it with `resume` on that item resumes everything behind it. An upstream observed merged (stored `done_at`, or `MERGED` this pass) holds nothing back, so a stale `halted` on a hand-merged PR does not propagate.

**Armed is derived.** A PR is armed when `autoMergeRequest` is non-null in `gh pr view`, whoever armed it. **Repo auto-merge** is `autoMergeAllowed` from `gh repo view`. Neither is stored.

### Requirement: Rule table

The rule table is the whole of autopilot behaviour. A behaviour is a status case, a row and an executor; nothing else acts. Rows, in table order:

| Row | Item · status | Guard | Action |
|---|---|---|---|
| X0 | queue or PR · any | engine item `projected: true`, no ledger item, not done, not yet escalated | `escalate` `projection removed: <id>` |
| X1 | queue or PR · any | engine item has a binding (or is a PR), `projected` unset, no ledger item | `re-project` |
| Q1 | queue · `done` | engine `done_at` unset | `record-done` |
| Q2 | queue · `pending` | — | `spawn` (writes `spawning`) |
| Q3 | queue · `spawn-unknown` | not yet escalated | `escalate` `spawn interrupted: …` |
| Q4 | queue · `dead` | respawn unspent | `respawn` (writes `respawned` and `spawning`) |
| Q5 | queue · `dead` | respawn spent | `skip` (writes `skipped`, then escalates) |
| Q6a | queue · `spawned` | stage unchanged 30 min, not yet escalated | `escalate` once |
| Q7 | queue · `done` | `merge-auto`, not bare, `done_at` set, `pr_dropped` unset, no PR item yet | `track-pr` |
| Q6b | the oldest unfinished queue item (any status but `done`, after every other row for it) | queue open 2 h, not yet escalated | `escalate` `queue open for over 2h0m0s` once |
| P1 | PR · `merged` | `done_at` unset | `record-merged` |
| P2 | PR · `closed` | — | `halt` |
| P3 | PR · `halted` | armed | `disarm` |
| B1 | PR · `stale-base` | an in-sequence predecessor is merged (stored `done_at` or observed `MERGED`) | `restack` |
| B2 | PR · `stale-base` | no merged in-sequence predecessor, not yet escalated | `escalate` `stacked PR #<n> is based on <base>, not <default>, with no merged predecessor to restack from` |
| P4 | PR · `draft` | — | `ready` |
| C1 | PR · `fixing` | `recovery_at` older than 30 min | `halt` (`no new push 30m0s after the CI fix request`) |
| C2 | PR · `failed` | `ci-fix` unspent, authoring pane known, alive and idle | `fix-request` |
| C3 | PR · `failed` | `ci-fix` unspent, pane snapshot known, no authoring pane | `recovery-spawn` |
| C4 | PR · `failed` | `ci-fix` spent on an older head | `halt` naming the failed check and new head |
| C5 | PR · `conflicting` | `rebase` unspent | `rebase` |
| C6 | PR · `conflicting` | `rebase` spent | `halt` (`CONFLICTING again after the rebase recovery`) |
| P6 | PR · `waiting` | not `stacked-prs`, not armed, repo allows auto-merge, required checks read | `arm` (`--auto --squash`) |
| P7 | PR · `green` | not `stacked-prs`, not armed, head commit observed | `merge` (`--squash --match-head-commit <observed head>`) |
| F1 | fix · `resolved` | — | `untrack` (remove item and projection, clear the parent's `fix_item`, leave the window open) |
| F2 | fix · `spawn-unknown` | not yet escalated | `escalate` once |

Q1 precedes Q7, so a `merge-auto` item newly observed done is recorded on one pass and its one-PR sequence is created on the next. Q6b is split from Q6a because Q6a only covers a spawned item while Q6b reports a stuck queue whatever its oldest item's status. Row order puts B1 and B2 after P3 and before P4, so a stale base is resolved before a draft is readied. Every other (item kind, merge mode, status) is an explicit wait: queue `done` after Q1/Q7, `paused`, `skipped`, `held`, `spawn-unknown` after Q3, `spawned`; PR `merged`, `paused`, `halted` not armed, `deferred`, `blocked`, `stale-base` already escalated (no predecessor to restack from), `fixing` inside the no-push window, `failed` with a busy agent or unknown snapshot, `green` armed or without an observed head, and `waiting` while checks are pending, the PR is armed, the repo has no auto-merge, or the PR is `stacked-prs` (never armed). Fix `working` and already-escalated `spawn-unknown` wait too. C1–C6 and P4/P7 apply in every merge mode; P6 never arms a stacked PR; B1 and B2 exist only for `stacked-prs`, the one mode that derives `stale-base`. A stacked PR reaches `conflicting` only after `stale-base` no longer derives (base is the default branch, the predecessor's squash commit is in its history), so C5's `rebase` onto the default branch fits it and B1 never fires for it. A halted, failed or conflicting PR is never armed or merged in that pass, and a stacked PR is never readied, armed or merged while its base is not the default branch.

**Escalate-once** rows (X0, Q3, Q6a, Q6b, B2, F2) guard on and write the engine item's `escalated` map keyed by reason. A persisting condition decides an explicit `wait` on later passes and appears in `StepResult.Escalations` only on its first sighting. Note text is written for humans and the brief but never read by an engine decision.

### Requirement: Escalations

An `escalate` action, on the first sighting of its dedupe key only, appends a note `by: run` with text `escalated: <reason>` (capped at `operator.NoteTextCap`) to the item's projection and sends a fail-silent notification through `Env.Notify` (title = the item id, or `autopilot` for an item-less escalation; body = the reason). Notes are always `by: run`; there is no `--by` flag on `queue` or `step`. An escalation with no ledger item able to hold it (item `""`, or a removed projection) is notify plus `StepResult.Escalations` only. The dedupe map lives on the engine item, so a note and its key never land on an item that changed since observe. `StepResult.Escalations` remains for CLI output and for the wrapper's judgment set ([operator-loop](/run-kit/operator-loop.md)).

A `step` pass reports its decided actions in engine order: `spawned`, `respawned`, `cherry-picked`, `armed`, `merged` (P7 and P1 both), `readied`, `disarmed`, `paused`, `done`, `pr-tracked`, `removed`, `resumed`, `recovery-sent`, `recovery-spawned`, `rebased`, `retargeted`, `untracked`, merge report lines and escalations.

### Requirement: Queue

`rk operator autopilot queue [--mode <m>] [--dry-run] < entries.json` takes the pass lock, runs the migration, writes N pending queue items to the engine file in one write, and then runs one pass. Entries are `id`, `repo`, `change` | `task` | neither (bare), optional `depends_on`, `stop_stage` and `paused` (`true` queues the entry held until `resume` — a plan step behind a user gate). A lock held by another pass writes nothing and exits 1 with the busy line (§ Single-writer pass lock). Once the engine write succeeded, an error in the follow-up pass does not fail the queue: the receipt reports the queued items plus the pass's actions and escalations (the pass error as an escalation) and the command exits 0.

- **Stamping**: every item gets `queue` (the queue id) and `merge_mode`, resolved once as `--mode` > rk setting `operator.merge_mode` > `cherry-pick-ladder`; the receipt prints `mode: <name> (flag|setting|default)`. An invalid setting value is an error naming the valid set. fab's `autopilot.merge_mode` is never read.
- **Chaining**: each entry after the first depends on the nearest earlier same-repo entry, else the previous entry (cross-repo is ordering-only); explicit `depends_on` replaces it. In `merge-auto`, each entry depends on the previous entry as an ordering barrier only.
- **Rejected before any write**: forward and cyclic dependencies, dependencies on bare entries, duplicate ids (checked against both the engine file and the ledger), repos that are not absolute git roots, invalid branches.
- **Misfit-safe live call**: a live `queue` whose receipt has a misfit (`merge-auto` with explicit same-repo `depends_on`) and no explicit `--mode` writes nothing and errors naming the misfit. The chat flow is `queue --dry-run`, confirm mode and misfits with the user, then exactly one live call.
- **Explicit membership**: queue work is exactly what the engine file's `queue` list holds. A pane tracked with `rk operator track add` is never spawned, respawned or listed by `status`, whatever its `depends_on`; `track add` refuses an id that names an engine item.

### Requirement: Remove and resume

`rk operator autopilot rm <id>` takes the pass lock and drops either:

- an **unspawned queue item** (no `pane`, no `spawning`), removing it and its identity-only projection; it refuses (usage error, exit 2, naming the dependents) a queue item another not-done queue item depends on, since dropping the edge would let the dependent spawn without its dependency; or
- a **halted sequence**, named by any of its PR item ids or its `merge_seq`, removing every PR item of the sequence from the engine file and their projections — but only when a fresh GitHub read in this verb observes every not-done PR of the sequence as not armed. An armed PR or a failed read refuses with exit 1 naming the PR, so the P3 disarm retry is never dropped. Dropping a sequence records `pr_dropped: true` on each owning queue item, and Q7 requires it unset, so the removed PR is never re-tracked, re-armed or merged; `resume` does not clear it, and only `merge` clears it for the queue items it re-chains.

Anything else is a usage error naming why (spawned, spawning, not halted, unknown id). It then runs one pass.

`rk operator autopilot pause <id>` takes the pass lock and sets `paused` on one unspawned queue item (no `pane`, no `spawning`, not done); a spawned, done or non-queue id is a usage error (exit 2) and an already-paused one a no-op. It runs no pass — there is nothing to advance.

`rk operator autopilot resume <id>` takes the pass lock, clears `halted`, `skipped` or `paused` on that one engine item (usage error, exit 2, when none is set or the id is unknown), and runs one pass. Clearing `halted` on the item that carries it resumes its derived cone. Resume never refunds a `ci-fix` or `rebase` round: a persisting condition halts again on that pass, so the human must push a fix, merge by hand or remove the sequence.

#### Scenario: Dropping a halted sequence
- **GIVEN** a done merge-auto queue item `a` whose PR item `pr-1` `stop` halted
- **WHEN** `rm pr-1` runs and later passes run
- **THEN** `pr-1` is gone, `a` carries `pr_dropped: true`, Q7 never re-tracks it and nothing arms or merges PR #1

#### Scenario: Spawned item is not removable
- **GIVEN** spawned `a1`
- **WHEN** `rm a1` runs
- **THEN** it exits 2 with a message that it has spawned

### Requirement: Readiness gate

The queue status derivation above is the one readiness derivation: `status`, `spawn` and `respawn` all use it, and a null stored mode reads `cherry-pick-ladder`. A dependency (any unsatisfied one holds the item, even one with a pane) is satisfied when done:

- a fab item: `done_at`, `.status.yaml` `ship` done or skipped, or `stop_stage` reached;
- a change-less item: its branch has an open PR whose **required** checks pass (`gh pr checks <n> --required`; none required passes; optional checks never block) or a merged PR, persisted as `done_at` in the engine file;
- a same-repo dependency with null `stop_stage` additionally needs its PR to exist. Tracking, a `branch_map` entry or a minted branch is not satisfaction. A dependency surviving only in `branch_map` passes; an unknown dependency id is unsatisfied;
- in `merge-auto`, the dependency's one-PR sequence item must have merged.

Every branch read from shared state (engine item, `branch_map`) passes `safeBranch` before any fetch, worktree, push or gh call on that path; an invalid branch is an escalation with no mutation. A PR item always carries an explicit `owner/name`, and every PR mutation (merge, arm, disarm, ready, view) targets that pinned name; executors act only on the re-read item (§ Pass shape).

### Requirement: Spawn

For each `pending`, unpaused queue item in queue order the engine:

1. targets the item's `repo` and runs `git fetch origin` first — **a failed fetch stops the spawn** (item stays `pending`, escalation, `rev-parse` never consulted). The default branch resolves through verified `origin/HEAD` → `gh repo view` → a `main`/`master` probe; the base is the **SHA** of `origin/<default>`, never a ref, so the new branch has no upstream tracking.
2. applies the confidence gate: an existing fab change whose `.status.yaml` score is below 3.0 is not spawned (escalation); raw-text entries skip it.
3. writes `spawning` (RFC 3339) to the engine file, then opens the worktree and tab through `internal/riff` in-process ([rk-riff](/run-kit/rk-riff.md)): `WorktreeName` = item id, `WorktreeBase` = the SHA, role-aware landing session, window marked `auto` with note `"<id> · <stage>"`.
4. adds dependency code for the same-repo dependency subset (cross-repo is gate-only):
   - **`cherry-pick-ladder`**: the dependency branch comes from the engine item's `branch`, else `branch_map` (missing → escalate, no spawn). Dependencies whose branch is an ancestor of another dependency's branch are pruned, those already ancestors of `HEAD` skipped, then `git cherry-pick --no-commit origin/<default>..<dep-branch>` and `git commit -m "operator: cherry-pick <dep> dependency"`. A conflict runs `git cherry-pick --abort`, rolls the worktree back, escalates and opens no tab.
   - **`stacked-prs`**: the new branch is cut from the SHA of `origin/<dep-branch>` (never `wt create --checkout`). The base is recorded by `fab status set-base-branch <change> <dep-branch>` in the new worktree for an existing change, by a trailing prompt instruction to run it after `/fab-new` for a raw-text fab entry, or by naming the dependency branch as the PR base for a non-fab plain agent.
   - **`merge-auto`**: no chaining; the base is `origin/<default>` independently.
5. activates the pointer for an existing change (`fab change switch <change>`, fail-soft).
6. builds the prompt from the two-axis table (fab present × task given) using the **target** repo's `fab agent default` command and skill prefix: existing change → `<prefix>fab-fff <change>`; raw text → `<prefix>fab-new <text>`; no `fab/` with a task → the task plus "Commit on this branch, push, and open a draft PR against <base>."; bare → no prompt token. Never `fab init`, never raw implementation text to a fab-project agent.
7. attaches: `pane`, `session`, `branch` and `branch_map[<change-or-id>]` in the engine file and the `pane` projection, which clears `spawning` and records `projected: true`. The branch recorded is the one the launch created, including for raw-task and bare launches.

**`spawning` marker.** The intent marker is written to the engine file before the launch and cleared by the attach. A pass that finds `spawning` set with no pane never relaunches: it escalates `spawn interrupted: <id> — check for an orphaned window before resuming or removing the queue item` once and leaves the item alone. A launch that fails before a window exists (fetch failure, confidence gate, cherry-pick conflict with the worktree rolled back) clears `spawning` again. If the attach write fails the pass escalates naming the pane and leaves `spawning` set. If the item left the engine file after the pass read it, the attach writes nothing and escalates the orphan pane by id. A pre-spawn escalation adds the identity-only projection that holds its note.

**Respawn.** A spawned queue item whose pane is gone and that is not done gets exactly one existing-branch respawn; `respawned: true` is written before acting, together with `spawning`. The new binding is recorded in the engine file, and the projection only when one still exists. Afterwards (row Q5) the item is marked `skipped` before the escalation is reported and its dependents stay held. Pane liveness is keyed by tmux pane id; id reuse is accepted.

### Requirement: Merge — cherry-pick-ladder, merge-auto and stacked-prs chains

`rk operator autopilot merge [--repo <path>]` starts the ordered merge on the user's "merge all" (one in-chat confirm for the whole sequence). It writes intent to the engine file — validation, the per-repo chains of PR items (`item`, `repo`, `pr`, `change`, `merge_seq`, `depends_on` the previous PR, base-first, cross-repo barriers preserved; an unresolvable `owner/name` creates no item and escalates), the PR projections, lifting `deferred` and clearing `pr_dropped` on the queue items it re-chains — then runs one pass; it has no advance loop of its own. It refuses while queue items are not done and is a no-op for `merge-auto` items. It accepts a `stacked-prs` queue and builds its PR chain; the stacked rules are the § Restack and direct merge requirement. Later `step` passes advance the other sequences through the rule table. The Auto-Merge rules hold for `cherry-pick-ladder`, and for `stacked-prs` apart from arming:

1. **Sequential, one PR per pass** — only the sequence head is observed and acted on. P1 records a merge (`done_at`), which is what unblocks the successor, so PR_n is acted on the pass after PR_{n-1}'s merge is recorded, never in the same pass.
2. **Action shapes** — a draft is readied first (`gh pr ready`, P4). A green unarmed PR (a stacked one included) is merged directly (`gh pr merge --squash --match-head-commit <observed head>`, P7): this covers "already clean" (no required checks) and repos with auto-merge disabled (`autoMergeAllowed` false), so there are no arm-rejection fallbacks and no failed `--auto` attempt. While checks are pending and the repo allows auto-merge, the PR is armed (`gh pr merge --auto --squash`, P6), only after its required checks were read; GitHub then merges it and a later pass records it. The head pin means a head pushed after the check read is never merged unverified. Arm and merge failures escalate (`arming PR #n failed: …`, `merging PR #n failed: …`); the next pass re-observes `autoMergeRequest` and decides again. An already-armed or already-merged response counts as success.
3. **Bounded PR recovery** — a failed required check starts one `ci-fix` round in every merge mode. C2 records the round, observed head and timestamp before sending the raw fix request to an idle authoring pane; send-time `ErrPaneBusy` restores those fields, while any other send error keeps the round and escalates uncertain delivery. C3 writes the parent and a `fixes:` item with `spawning` in one engine-file write, then launches through the ordinary spawn/attach path; failures leave the marker for F2 and never relaunch. The same head remains `fixing` even when green; a new red head (C4) or 30 minutes without a push (C1) halts and disarms. A green new head or a merge resolves the fix item through F1. Independently, a PR conflicting for three quiet polls gets one `rebase` round (C5): fetch, temporary detached worktree at `origin/<branch>`, rebase onto the default branch, then the round write immediately before `git push --force-with-lease=refs/heads/<branch>:<observed head> origin HEAD:refs/heads/<branch>`. The authoring worktree is untouched and cleanup runs on every exit. A rebase conflict aborts, spends the round and halts; push failure keeps the round. C5 never re-arms: P6 does that on the next pass. Recurrence halts through C6.
4. **The items are the sequence** — a restarted run resumes from the engine file alone.
5. **Halt disarms the cone** — a PR closed without merging (P2) halts its item: `halted` is written on that one item, with an escalation, and the item itself is disarmed if armed. P3 disarms every armed PR in the halted cone (the failing repo's sub-sequence plus repos with a transitive cross-repo `depends_on` into it), whoever armed it, retried every pass until GitHub reports it disarmed (`gh pr merge --disable-auto`; a PR already merged or closed counts as disarmed). A failed disarm escalates `disarming PR #n failed — it may still merge: …`. Independent sequences continue. The pass that writes `halted` disarms the halted item; the rest of the cone is observed and disarmed on the next pass. A halted head is never re-armed or merged. `stop` is global.

**`merge-auto`** arms on ship: when a queue item ships, the next pass records it done (Q1) and the one after creates its one-PR sequence (Q7: it finds the PR by branch, appends the PR item to the engine file and projects it), which P4–P7 then ready, arm or merge. The next queue item stays `held` until that PR item has merged, then spawns on the advanced `origin/<default>` tip through the normal fetch and SHA pin. A halt disarms that PR and escalates; the next spawn stays deferred.

**Persist before acknowledge.** Markers that acknowledge an action (`halted`, `done_at`, stop's pause and halt) are written before the action is reported. Where the write fails, the result carries an escalation, never a success line. Merge lines carry repo and position (`ab12: merged (foo 1/2)`); a PR merged with no non-`PENDING` review is marked `· unreviewed` and summarised once per pass as `merged without review: #n (<change>), …`.

### Requirement: Restack and direct merge of stacked chains

A `stacked-prs` sequence is readied (P4) and merged directly (P7, `--squash --match-head-commit <observed head>`), one PR per pass, and never armed: P6 keeps its `!stacked` guard, so a stacked `waiting` PR waits. After a predecessor merges, its successor derives `stale-base` (base still the predecessor's branch, or the squash commit not an ancestor of its head) and B1 fires the `restack` executor; the PR is merged only on a later pass, once it is green on the restacked head. B2 covers a stale base with no merged predecessor: it escalates once and the PR stays a declared wait, never readied, armed, retargeted or merged. A stacked PR that turns `conflicting` after the restack gets the ordinary C5/C6 rebase round and halt.

The `restack` executor (`restack.go`) runs in this order and writes no engine key:

1. Re-reads the item (`reread`), skipping on change or vanish; validates the head and predecessor branches with `checkedBranch`.
2. Disarms the PR first when it is observed armed (a failed disarm escalates and stops), since GitHub retargeting does not re-run CI.
3. `git fetch origin` in the repo; failure escalates and stops. The default branch comes from `e.defaultBranch`.
4. Verifies `origin/<branch>` resolves to the observed `headRefOid`; otherwise escalates `PR #<n> head moved since observe; restack retried next pass` and stops, before any GitHub mutation.
5. Resolves the rebase upstream (below) from the predecessor PR's `headRefOid` (`gh pr view <pred-n> --repo <nwo> --json headRefOid`). A predecessor head object missing locally after the fetch escalates `cannot find predecessor head <sha> for PR #<n>` and stops without halting.
6. When the observed `baseRefName` is not the default branch, retargets with `gh pr edit <n> --repo <nwo> --base <default>`; an "already" or "base branch was not changed" reply is accepted only when a re-read `baseRefName` equals the default. A failure escalates and stops; success records `retargeted`.
7. Creates a temporary detached worktree (`git worktree add --detach <tmp> <observed headRefOid>`, `<tmp>` from `os.MkdirTemp`), never touching a local `<branch>` or the authoring agent's worktree, and runs `git rebase --onto origin/<default> <upstream>` in it.
8. Checks with `git merge-base --is-ancestor` that the predecessor's merge commit is an ancestor of the rebased `HEAD`; when not (exit 1) it escalates `predecessor merge commit <sha> is not on <default>; PR #<n> not pushed`, and any other error escalates `predecessor ancestry check failed: …`. Neither pushes nor halts, so B1 never churns force-pushes.
9. Pushes `git push --force-with-lease=refs/heads/<branch>:<observed headRefOid> origin HEAD:refs/heads/<branch>`; failure escalates `push after rebase failed: …` and stops without halting, and the next pass repeats from `origin/<branch>`. Success records `rebased` (`<branch> onto <default>`).
10. Always removes the temporary worktree (`git worktree remove --force`, then `git worktree prune`) on a context detached from the pass's cancellation (`context.WithoutCancel` with its own short timeout); a cleanup failure escalates.

**Rebase conflict.** When the rebase fails, the executor collects the conflict files, runs `git rebase --abort` (escalating if the abort fails), writes `halted` on that one item through the guarded write, and escalates `halted: rebase of <branch> onto <default> failed: <files> (cleanup attempted, not skipped): <stderr>`. The halt cone is derived from that one write, so the PR and everything behind it are never merged while halted; the shared `halt` executor is untouched. A rebase failure on a cancelled or timed-out pass instead aborts on the cleanup context and escalates `restack of PR #<n> interrupted: …; retried next pass` without writing `halted`.

**Upstream selection.** `<upstream>` is the newest commit of the head's history that is not the PR's own work, so the rebase drops every inherited predecessor commit at any chain position and never drops one whose change is not already on the default branch. With `mb = git merge-base <predHead> <head>`, candidates are every commit `git cherry <predHead> <head> <mb>` marks `-` (patch-equivalent to a commit in `<head>..<predHead>`), newest first, then `mb` itself. The first candidate `c` whose drop is a no-op on the default branch wins: `git merge-tree --write-tree origin/<default> <c>` exits 0 and its first output line equals `git rev-parse origin/<default>^{tree}`. A candidate whose check fails or errors is skipped, and `mb` is the final fallback; if only `mb` qualifies and the replay conflicts, the conflict path halts rather than merging the wrong thing.

#### Scenario: Restack after a squash merge
- **GIVEN** two stacked PRs where PR1 squash-merged and PR2 still targets PR1's branch
- **WHEN** a pass runs
- **THEN** PR2's base becomes the default branch, `origin/<default>..origin/<branch>` holds exactly PR2's own commits, and PR2 is not merged in that pass

#### Scenario: Restack conflict halts
- **GIVEN** PR2 edits a file that the default branch's squash of PR1 also changed
- **WHEN** B1 runs
- **THEN** PR2 is `halted`, the escalation names the file and says `not skipped`, and nothing behind PR2 is merged

### Requirement: Stop and status

`stop` is the global user stop and is intent then one pass: it writes `halted` on every not-done PR item and `paused` on every unspawned unfinished queue item in the engine file (live panes are untouched), then runs the full pass, in which P3 disarms every armed PR in the halted cones, whoever armed it. It never reads an armed marker. `stop` returns an error when a halted PR's armed state could not be read (no pinned name, bad number, failed view) or a disarm failed, rather than claiming a disarm it could not place; a later `step` or `stop` retries. To resume a paused or halted item the user runs `rk operator autopilot resume <id>` on the one item that carries the flag; `rm` drops what is not wanted.

`status` is read-only — no pass lock, no escalations, no writes, live gh probes — and runs the same observe and derive stages as `step`. It shows the derived queue status name in `state` (`done`, `paused`, `skipped`, `held`, `pending`, `spawn-unknown`, `spawned`, `dead`) with mode, repo and branch, and for a row with a PR item the PR item's status and position (`PR #12 · green · 1/3`); `--json` keeps `state` and adds `pr_status`, plus the entry's `task`, `change` and `stop_stage` (each omitted when unset) so a judgment run can compare an intake with what was asked. Its `fixes` list shows every recovery item with `resolved`, `spawn-unknown` or `working` status. A failed pane snapshot reads recorded panes as alive instead of failing, and a plain agent with no PR yet is not a warning. When every queue item is done it adds the Queue Completion Summary; fix items do not affect completion. Derived statuses are not exposed to `done_when`.

### Requirement: Out of scope

- Arming a stacked PR, cascading a restack into descendants, and any engine key for restack state do not exist.
- Daemon-driven passes and MCP tools for the verbs do not exist; the pass runs in the run wrapper and in CLI verbs.
- Hardening against hand edits of the engine file is out of scope: the file has one writer by contract.
- No code in the engine claims, leases or compare-and-sets work: the pass lock and `spawning` marker are the whole concurrency model, and pane identity is recorded only by the spawn's attach write.

## Design Decisions

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

### Recovery rounds are a set of spent kinds
**Decision**: `recovery` stores the spent kinds (`ci-fix`, `rebase`) as a set on the PR engine item, next to `fix_head`, `recovery_at` and the optional `fix_item` link; each kind has one round, and `resume` never refunds one.
**Why**: Each kind has its own one-round budget, so a later failure of the other kind must not reset it; the intent is written before the send or launch, so a crash never repeats a request or opens a second agent.
**Rejected**: A single overwritten recovery value (a rebase would reset a spent `ci-fix` round); escalation-only recovery, which only reported what the engine can now do.
*Introduced by*: 261116-m8io-autopilot-pr-recovery

### Conflict rebase in a temporary detached worktree with a pinned lease
**Decision**: C5 rebases a temporary detached worktree at `origin/<branch>` and pushes `HEAD:refs/heads/<branch>` with `--force-with-lease` pinned to the observed head; the round is spent just before the push, and a fetch or worktree failure before the rebase spends nothing.
**Why**: It never touches the authoring agent's worktree, a crash repeats cleanly, a concurrent push is never overwritten, and a transient fetch error does not burn the budget.
**Rejected**: Reusing the authoring worktree (a dirty agent tree would halt the PR), spending the round before the fetch, and an unpinned force-push.
*Introduced by*: 261116-m8io-autopilot-pr-recovery

### Fix items in their own engine-file list
**Decision**: Recovery-spawn agents live in the engine file's `fixes:` list, linked from the parent PR's `fix_item`; they carry identity and binding only and derive their own `resolved`/`spawn-unknown`/`working` status.
**Why**: Queue derivation, readiness, dependencies and merge sequences stay untouched, and no back-link key is added (the parent is a reverse lookup on `fix_item`).
**Rejected**: Queue items with a `fix_for` marker — every queue path would need an exclusion.
*Introduced by*: 261116-m8io-autopilot-pr-recovery

### Armed is derived, never stored
**Decision**: Armed is read from `autoMergeRequest` every pass and repo auto-merge from `autoMergeAllowed`; the engine writes no `armed` or `direct`. A halt disarms every armed PR in its cone, whoever armed it, retried every pass until GitHub reports it disarmed; `rm` of a halted sequence reads the armed state fresh and refuses while any PR is armed.
**Why**: Most review findings against the stored-marker design were a marker disagreeing with GitHub (halted-and-armed, uncertain arm outcome, stale `direct`); deriving removes the marker and the code that protected it, and an unknown arm outcome resolves itself on the next observe.
**Rejected**: Keeping `armed` for the ledger's `track rm` refusal — contradicts the stored-vs-derived rule; clearing a marker on any error — orphans an armed PR; a single disarm attempt — the armed PR would merge once checks go green.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

### One pure `decide` over a data rule table
**Decision**: Row selection is a pure function over a package-level table of `{id, kind, status, guard, action}` rows plus an explicit wait table; executors never decide, and a test enumerates every (kind, mode, status) for the row that fires or the wait.
**Why**: Table tests need no git or `gh` fakes, and new behaviour adds rows plus executors rather than branches in a driver loop; a combination with neither row nor wait is visible as `unmatched` instead of silently acted on.
**Rejected**: Imperative per-phase loops (`driveHead`, `directMerge`, `retryDisarms`) tested through fakes — each new behaviour re-opens the same review loop.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

### Stacked ancestry through the GitHub compare API
**Decision**: Observe reads "the predecessor's merge commit is an ancestor of the head" with `gh api repos/<nwo>/compare/<merge>...<head> --jq .status`.
**Why**: Observe stays free of local git mutation (no fetch per pass), works in the read-only status view, and both commits are guaranteed to exist on GitHub.
**Rejected**: `git fetch` plus `git merge-base --is-ancestor` in observe — mutates remote-tracking refs on every pass and needs network git in the read-only view.
*Introduced by*: 261116-hv61-stacked-prs-merge-all

### Restack is a derived status, not a marker
**Decision**: B1 fires on `stale-base`, derived each pass from base and ancestry; no `prepared` key is stored. Unknown stale-base facts derive `waiting`, never `green`.
**Why**: The status turns false once the squash commit is an ancestor of the head, so a restack never repeats and a crash is re-derived; an unread fact cannot be mistaken for a clean base.
**Rejected**: A stored `prepared` marker — a stored non-monotone fact that can drift.
*Introduced by*: 261116-hv61-stacked-prs-merge-all

### Restack in a detached worktree with an explicit-SHA lease
**Decision**: The rebase runs in a temporary detached worktree at the observed head SHA (verified equal to `origin/<branch>`) and pushes `HEAD:refs/heads/<branch>` with `--force-with-lease=refs/heads/<branch>:<observed head>`; the head-moved check and upstream resolution come before any GitHub mutation.
**Why**: The authoring agent's worktree has `<branch>` checked out and must not be touched; starting from the remote makes a crash repeat cleanly; the explicit lease turns a concurrent agent push into a failed push instead of an overwrite, and force-pushing the wrong thing is must-fix.
**Rejected**: Reusing or spawning the agent's worktree under a claim; a bare `--force-with-lease`, which leases against whatever the local tracking ref says.
*Introduced by*: 261116-hv61-stacked-prs-merge-all

### Rebase upstream from patch equivalence, gated by a no-op drop check
**Decision**: `<upstream>` is the newest `git cherry predHead head mb` `-` commit (else `mb`) whose drop is a no-op on the default branch (`git merge-tree --write-tree origin/<default> <c>` yields `origin/<default>^{tree}`).
**Why**: GitHub may delete the merged predecessor branch, and a restacked predecessor's merged head is a rebased copy absent from the successor's history; patch equivalence finds the inherited-commit boundary at every chain position without storing a key, and the tree check proves no own work is discarded (a cherry-picked predecessor fix can sit after own commits).
**Rejected**: `merge-base(predHead, head)` alone — replays predecessors' originals from the third PR on (spurious conflict halts); the newest `-` commit alone — silently drops own commits that precede a cherry-picked fix; storing each PR's pre-restack head — a new engine key; cascading the restack into descendants — acts on items other than the decided one; `merge-tree --merge-base` — needs git 2.40.
*Introduced by*: 261116-hv61-stacked-prs-merge-all

### One PR per pass
**Decision**: A sequence head is observed and acted on once per pass; P1 records a merge and the successor is observed and armed or merged on the next pass.
**Why**: No action reads the effect of another in the same pass, so statuses stay a pure function of one snapshot and the arm/merge of PR_n can never rest on a merge that was only just requested.
**Rejected**: Re-observing and chaining within a pass — reintroduces the guard loops the table replaced.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

### Executors re-read and guard their writes
**Decision**: Each executor re-reads its engine item and projection and skips it (`changed externally; skipped`) when it changed or vanished; P7 pins the merge with `--match-head-commit` and P6 requires the checks to have been read.
**Why**: A user can pause, remove or edit a projection between observe and execute, and a head pushed between the check read and the merge must not merge unverified code.
**Rejected**: Trusting the observe snapshot until execute — a projection edit or a new push could make the engine merge, arm or write against the wrong thing.
*Introduced by*: 261116-qtgq-autopilot-status-rule-table

### `rm` drops only what cannot lose work
**Decision**: `rm` removes an unspawned queue item with no unfinished dependents, or a halted sequence only after a fresh read shows no PR armed, and marks the owning queue items `pr_dropped` so Q7 never re-tracks the dropped PR.
**Why**: Dropping a dependency edge would let a dependent spawn without its dependency's code; dropping an armed PR's item would leave nothing to disarm it; without `pr_dropped` a done merge-auto item would re-create the PR item on the next pass.
**Rejected**: Removing a spawned item (orphans a live agent); dropping the edge on `rm`; letting `track rm` remove engine work.
*Introduced by*: 261116-rxic-autopilot-own-state-mechanical-runs

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

### The engine's view derives pane facts; the engine file keeps intent
**Decision**: `engineView` overlays `change`, `stage` and the real branch (from `branch_map[<change>]`) from the ledger projection onto queue items only (PR items keep their recovery branch verbatim so a malformed one is refused, not masked; fix items keep their fix head). The overlay does not write the engine file, but the item's next guarded write stores the overlaid `change` and `branch`; the stored change then takes precedence, branch re-derives from `branch_map` on every view, and `stage` is never stored. Removing that side effect is step E4 of `fab/plans/sahil/26-11-17-agent-event-log.md`.
**Why**: A raw-task spawn's respawn failed with `Branch 'pins-f1' not found` because `/fab-new` had renamed the branch to the change id — the check had recorded the real branch under the change id, but the engine read its own spawn-time copy; the stall escalation likewise read `stage (unknown)`. When a fact is available both ways, derivation wins (Constitution X), and resolving once in the view keeps the projection write-back from restoring the stale branch into `branch_map`.
**Rejected**: writing the renamed branch back into the engine file on each pass (a second writer of a derived fact); changing `depBranch`'s lookup order only (the write-back would still overwrite `branch_map[<change>]` with the stale name).
*Introduced by*: PR #1147 (direct change, no fab intake)

### A plan's user gate is a paused queue entry
**Decision**: A queue entry may start `"paused": true`, and `rk operator autopilot pause <id>` holds any unspawned entry later; `resume` releases either. The chat queues a plan's user-gate steps paused.
**Why**: A queued entry has no ledger record until it spawns, so `rk operator track pause` cannot hold it, and `stop` pauses every unspawned entry; without a per-entry pause the engine spawned a gated step the moment its dependencies finished, and the run's intake rule then advanced it past the gate.
**Rejected**: queuing gated steps in a later `queue` call only (works, but the gate is then invisible in `status` until the user remembers); a `gate` field with its own semantics (paused already derives the status and `resume` already clears it).
*Introduced by*: PR #1148 (direct change, no fab intake)
