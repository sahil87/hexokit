# Intake: Operator Autopilot Core (R6a)

**Change**: 261114-8w1x-operator-autopilot-go
**Created**: 2026-11-14 (re-scoped to R6a 2026-11-16)

## Origin

> Execute step R6a of fab/plans/sahil/26-11-16-operator-autopilot-restructure.md: rewrite intake.md for the R6a scope (carry the listed decisions, put the review bar in the non-goals), git rm the old plan.md, score and advance intake, then run /fab-fff. Quote the review bar in every review dispatch. If a third review fails, stop and report the findings grouped by class; do not start a fourth run. Do not start R6b, R6c or R7.

This change started as **R6** of `fab/plans/sahil/26-11-10-operator-to-hexokit.md` (the parent plan): a Go port of fab's whole §6 autopilot (queue, readiness, spawn, dependency code, ordered merge in all three modes, PR recovery). It ran two `/fab-fff` runs (8 reviews, 6 rework cycles) without passing review. The restructure plan `fab/plans/sahil/26-11-16-operator-autopilot-restructure.md` re-scopes this change to **R6a (autopilot core)** and moves the `stacked-prs` merge-all to R6b and PR recovery to R6c (both new changes, later). Its "Decisions (binding for R6a–R7)" table is binding here and is not reopened. The parent plan's "Decisions already taken" table still binds except where the restructure plan replaces it.

The branch already carries the full-scope engine (commit `e99ca698`, also preserved on `261114-8w1x-r6-full-reference`). R6a **keeps, simplifies and finishes** that code in place; it does not start over. The previous full-scope `plan.md` (R1–R28, T001–T032) is deleted so apply regenerates the plan from this intake.

Decisions confirmed by the user at the original R6 intake/clarify that carry into R6a (binding):

| Decision | Source |
|---|---|
| `merge_mode` lives in rk settings as `operator.merge_mode`; fab's `autopilot.merge_mode` is never read (no fallback, no dual-read) | User, R6 intake |
| Mode resolution `--mode` > setting > `cherry-pick-ladder`, resolved once at `queue` and stamped on every item; an invalid value is an error | Parent plan + R6 intake |
| Verbs `rk operator autopilot` `queue` / `step` / `merge` / `stop` / `status`; `queue` takes a JSON array on stdin; `step` is one idempotent pass and no verb waits for CI | User, R6 clarify |
| `stacked-prs` spawns cut the dependent's branch from the SHA of `origin/<dep-branch>`, never `wt create --checkout` | User, R6 clarify |
| Engine is called by runs and chat; the daemon does not call it (R8 candidate) | R6 intake |
| Spawn reuses `internal/riff` in-process; the engine never notifies (returns escalations); no MCP tools | R6 intake |
| Git tested against real temp repos; `gh`/`fab` through a scripted runner fake; `main_test.go` pins a hermetic git identity | R6 intake + CI fix |

The R6 decision "port PR Recovery in R6" is **superseded** by the restructure plan's split: recovery is R6c.

## Why

**Problem.** After C1 the operator runs as short headless runs (R5's loop) driven by a run brief (R4). Autopilot still exists only as interim prose in `app/backend/internal/operator/brief_autopilot.md`, which every run that touches a queue re-interprets. That prose drives destructive git/gh operations (cherry-picks, `gh pr merge --auto --squash`, `gh pr merge --disable-auto`) whose correctness depends on sharp edges a model can get wrong: pass the base as a SHA, never a ref; a failed `git fetch` must stop the spawn; prune ancestor deps before cherry-picking; arm at most one PR per repo sequence; disarm only the halted cone. It also inflates every run's brief.

**Why R6 did not converge.** Three causes (restructure plan): (1) too many failure modes at once — about 3,900 lines of engine plus 4,400 of tests surviving crashes mid-action, two overlapping passes, external state writers, unknown-outcome GitHub timeouts and tmux pane-id reuse in every combination; (2) each fix (claims, markers, rollbacks, retries) added new code with new failure cases — five of the last eight findings were about two `step` passes overlapping; (3) scope bigger than needed (PR recovery, `stacked-prs` merge-all).

**Why this approach.** A **single-writer pass lock** removes the whole "two passes overlap" class, so the claim/CAS machinery can be deleted rather than hardened. Splitting off `stacked-prs` merge-all (R6b) and PR recovery (R6c) leaves a core that can land and be reviewed on its own. A **written review bar** (in Non-Goals below) bounds review so it converges. Each part replaces the brief section it covers in the same PR, so there is never a window where brief and engine both claim the same job.

**If we don't.** R7 and F2 stay blocked, every queue keeps paying model tokens to re-derive deterministic choreography, and a misread of the prose can merge the wrong PR or leave an orphaned armed PR.

## What Changes

The engine is `app/backend/internal/autopilot/` with the CLI in `app/backend/cmd/rk/operator_autopilot.go`, both already on the branch. The state model is unchanged: queue state is the tracked items themselves (`internal/operator` `TrackedItem`, `State`, `BranchMap`), all new keys live in the items' opaque `scope`, reads are tolerant, nothing is migrated on disk.

### 1. Single-writer pass lock (new) and removal of claim machinery

- `rk operator autopilot step`, `merge` and `stop` take an **exclusive, non-blocking, per-server pass lock** for the whole pass: `flock` (`LOCK_EX|LOCK_NB`) on `<state dir>/<slug>.autopilot.lock`, where `<state dir>/<slug>` is the same directory and `cron.FabOperatorSlug` slug the operator state file `<slug>.yaml` uses (`operator.StatePath*`). The OS releases a `flock` when the process dies, so a crash never leaves the lock held (Constitution II).
- A second caller that finds the lock held **does nothing and exits 0** with result `busy` (`{"ok":true,"result":{"busy":true,…}}` in `--json`; a one-line human message saying another autopilot pass is running on this server and to retry). `queue` and `status` do not take the pass lock (`queue` is a single locked state write; `status` is read-only).
- The **state-file lock is unchanged**: the store's sidecar lock is still never held across a subprocess, and writes still merge by item id with external writes winning. `rk operator track`, `rk operator check` and the daemon keep writing concurrently; the pass lock serialises autopilot passes only.
- **Delete** the concurrency machinery the pass lock replaces: `internal/autopilot/claim.go` (`claimSpawn`, `claimWork`, claim tokens, `rollbackClaim`, `releaseClaim`, `reconcileClaim`, claim leases), the snapshot compare-and-set, `claim_test.go`, and every overlapping-pass test (e.g. `TestOverlappingStepsClaimOnlyOneRespawn`, `TestStaleRecoverySnapshotCannotClaim`). Launch logic that used the claim becomes straight-line code.
- **Keep crash safety through the `spawning` intent marker** (`scope.spawning`, a timestamp): written (one locked write) **before** the launch; the launched pane (`scope.pane`, `session`, `branch` + `branch_map`) is written **right after** the launch, clearing `spawning`. A later pass that finds `spawning` set **without** a pane does **not** relaunch: it escalates (`spawn interrupted: <id> — check for an orphaned window, then clear with rk operator track update`) and leaves the item alone. The same marker guards the one respawn.
- **Delete** `operator.RecordPanePID` (`internal/operator/export.go`) — it has no callers — together with any `scope.pane_pid` fingerprint code that exists only for it.

### 2. Queue (keep)

`rk operator autopilot queue [--mode <m>] [--by user|run|chat] [--dry-run] [--json] < entries.json` persists N pending `pane` items in one locked write, as built:

- Entries are a JSON array on stdin (`id`, `repo`, `change` | `task` | neither = bare, optional `depends_on`, `stop_stage`).
- Every item gets `scope.queue` (the queue id — explicit queue membership) and `scope.merge_mode`, resolved by `--mode` > `operator.merge_mode` > `cherry-pick-ladder`; the receipt prints `mode: <name> (flag|setting|default)`. An invalid setting value is an error naming the valid set.
- Implicit chaining: each entry after the first depends on the nearest earlier same-repo entry, else the previous entry (cross-repo = ordering-only). Explicit `depends_on` replaces it. In `merge-auto`, each entry depends on the previous entry as an ordering barrier only.
- Rejected before any write: forward and cyclic dependencies, deps on bare entries, duplicate or already-tracked ids, repos that are not absolute git roots, invalid branches.
- **Misfit-safe live call**: a live `queue` whose receipt has a misfit (`merge-auto` with explicit same-repo `depends_on`) and no explicit `--mode` writes nothing and errors naming the misfit. The chat flow is dry-run first: `queue --dry-run`, confirm mode and misfits with the user, then exactly one live call.
- **Explicit queue membership**: an item is queue work iff it carries `scope.queue`, or (legacy) a non-null `scope.merge_mode`, or it has a `depends_on` edge with another queue-eligible item. A bare pane tracked with `rk operator track add` is never queue work and is never respawned.

### 3. Readiness gate (keep)

- Derived state per item, strict precedence: `done` › `paused` › `held` (any `depends_on` unsatisfied) › `pending` (unspawned, deps satisfied) › `spawned`. Stored null mode reads as `cherry-pick-ladder`.
- A dependency is satisfied when done: fab item → `done_at` / `.status.yaml` `ship` done/skipped or `stop_stage` reached; change-less item → its branch has an open PR whose **required** checks pass (`gh pr checks <n> --required`; "no required checks" passes; optional checks never block) or a merged PR, persisted as `done_at`.
- Same-repo dep with null `stop_stage`: its PR must also exist. Tracking, a `branch_map` entry or a minted branch are not satisfaction. A dep surviving only in `branch_map` passes; an unknown dep id is unsatisfied.
- Every branch read from shared state (item scope, `branch_map`) is validated (`safeBranch`) before any fetch, worktree, push or gh call on that path; invalid → escalation, no mutation.

### 4. Spawn — all three modes (keep)

For each `pending`, unpaused queue item, in queue order:

1. Target repo = `scope.repo`. `git fetch origin` first; **a failed fetch stops** the spawn (item stays `pending`, escalation; `rev-parse` never consulted). Default branch: verified `origin/HEAD` → `gh repo view` → `main`/`master` probe. Base = **SHA** of `origin/<default>` (no upstream tracking).
2. Confidence gate: an existing fab change whose `.status.yaml` score is below 3.0 is not spawned (escalation). Raw-text entries skip the gate.
3. Write `scope.spawning`, then open the worktree + tab through `internal/riff` in-process (`WorktreeName` = item id, `WorktreeBase` = the SHA; role-aware landing session; window marked `auto` with note `"<id> · <stage>"`).
4. Dependency code for the same-repo subset (cross-repo = gate only):
   - **`cherry-pick-ladder`**: dep branch from `scope.branch`, else `branch_map`; missing → escalate, no spawn. Prune deps whose branch is an ancestor of another dep's branch; skip deps already ancestors of `HEAD`; `git cherry-pick --no-commit origin/<default>..<dep-branch>` + `git commit -m "operator: cherry-pick <dep> dependency"`. On conflict: `git cherry-pick --abort`, roll the worktree back, escalate, open no tab.
   - **`stacked-prs`**: cut the new branch from the SHA of `origin/<dep-branch>` (never `--checkout`). Record the base: existing fab change → `fab status set-base-branch <change> <dep-branch>` in the new worktree; raw-text fab entry → trailing prompt instruction to run it after `/fab-new`; non-fab plain agent → the PR instruction names the dep branch as base.
   - **`merge-auto`**: no chaining; base on `origin/<default>` independently.
5. Pointer activation (existing fab change, fail-soft): `fab change switch <change>` in the new worktree.
6. Prompt by the two-axis table (fab present × task given): existing change → `<prefix>fab-fff <change>`; raw text → `<prefix>fab-new <text>`; no `fab/` + task → task + "Commit on this branch, push, and open a draft PR against <base>."; bare → no prompt token. Agent command/prefix from the **target** repo's `fab agent default`. Never `fab init`; never raw implementation text to a fab-project agent.
7. Attach: `scope.pane`, `session`, `branch` and `branch_map[<change-or-id>]` in one locked write merged by id; clears `spawning`.

**Respawn**: a spawned queue item whose pane is gone and that is not done gets **one** existing-branch respawn, `scope.respawned: true` written before acting; afterwards it is skipped with an escalation and dependents stay held. Pane liveness keyed by tmux pane id is accepted (see review bar).

### 5. Merge — `cherry-pick-ladder` merge-all and `merge-auto` (keep, with one fix)

`rk operator autopilot merge [--repo <path>] [--json]` starts the ordered merge on the user's "merge all" (one in-chat confirm for the sequence). It refuses while queue items are not done, is a no-op for `merge-auto` items, and **refuses a `stacked-prs` sequence** with a message pointing at the brief's stacked-prs merge text (R6b ports that path). Sequences are chains of `github-pr` items (`scope {repo, pr, change, merge_seq}`, `depends_on` the previous PR), per repo, base-first; a `github-pr` item always carries an explicit `owner/name` repo (unresolvable → no item, escalation). Later `step` passes advance them.

The five Auto-Merge rules for `cherry-pick-ladder`:

1. **Sequential arming**: at most one armed PR per repo sequence; PR_n armed only after PR_{n-1}'s merge is verified (its item done, `state == MERGED`).
2. **Arming shapes**: ready a draft first (`gh pr ready`); always pass `--squash`; "already clean" (no required checks) → `gh pr merge --squash` directly; auto-merge disabled on the repo → step-driven direct merge for that sequence (merge when required checks are green and `MERGEABLE`).
3. **Stall rule → escalation, not action**: a failed required check, or `unchanged ≥ 3` with no failed check and `mergeable == CONFLICTING`, produces the escalation `recovery needed: <ci-failed|conflicting> — <pr> (<repo>)` and leaves the PR **armed**. No fix request, rebase, re-arm or recovery spawn (R6c).
4. **The items are the sequence**: a restarted run resumes from the state file alone.
5. **Disarm on halt** (`gh pr merge --disable-auto`) over the halted cone only (failing repo's sub-sequence plus repos with a transitive cross-repo `depends_on` into it); independent sequences continue. `stop` is global.

Arming durability:

- `scope.armed` is written **before** `gh pr merge --auto`. Only a definitive rejection from a closed, tested list (auto-merge not allowed, PR not armable, "clean status" → direct merge) clears it; timeouts, network/5xx and unrecognised errors **keep** the marker and escalate `arm outcome uncertain`.
- **Fix from the last R6 review (must fix)**: a transient disarm failure must not leave a PR `halted` and `armed` with later passes skipping it. The halt path and `stop` **retry the disarm until it is durable**: a PR item with `halted` (or a global stop) and `armed` still set is retried on every later `step`/`stop` pass until `--disable-auto` succeeds (or reports already-disabled / PR merged or closed), and only then is `armed` cleared. Each failed attempt escalates.
- Markers that acknowledge an action (`halted`, merged completion, stop) are persisted before the action is reported done; a failed write is an escalation, never a success line.
- Merges with no non-`PENDING` review are reported `· unreviewed` plus one summary line `merged without review: #n (<change>), …`. Report lines carry repo + position, e.g. `ab12: merged (foo 1/2)`.

**`merge-auto`** (arm-on-ship): when a queue item ships, the next `step` creates its one-PR `github-pr` sequence and arms it per rule 2. The next queue item stays `held` until that merge is **verified**, then spawns on the advanced `origin/<default>` tip via the normal fetch + SHA pin. A halt disarms that one PR and escalates; the next spawn stays deferred.

### 6. Stop and status (keep)

- `stop`: global user stop — disarm every armed PR (retried until durable, above) and pause every unspawned queue item (`paused: true`); live panes untouched.
- `status`: read-only per-item view (derived state, mode, repo, branch, PR, merge position) plus the Queue Completion Summary when all items are done. No pass lock, no escalations.

### 7. Move out to R6b / R6c

Remove from the branch, with their tests:

- **`stacked-prs` merge path** → R6b: `stackedStep`, `prepareStacked`, the base-retarget (`retarget` in `idempotent.go`) and `rebase --onto` + `--force-with-lease` code, `scope.prepared`, and stacked merge tests (`merge_test.go` stacked cases, `TestStackedPushWriteFailureDoesNotReportRebased`, `TestStackedRejectsMalformedCurrentAndPredecessorBranches`, the retarget part of `TestAlreadyAppliedReadyArmAndRetarget`).
- **PR recovery** → R6c: all of `recovery.go` (`ci-failed` fix round, `conflicting` rebase + re-arm, recovery spawn, authoring-pane lookup, `scope.recovery`/`fix_head`/`fix_item`, `<change>-fix` items) and its tests (recovery cases in `lifecycle_test.go`, `merge_test.go`, `escalation_test.go`, `revised_rules_test.go`, e.g. `TestFixRound*`, `TestConflictingRejectsMalformedSharedBranch`, `TestRecoveryCleanupFailuresEscalate`, `TestWorktreeLookupFailurePreventsRecoverySpawn`).

Tests that cover R6a behaviour in those files stay (adapted to the single-writer model). Helpers left with no caller after the removal are deleted, not kept for R6b/R6c (they port from the reference branch).

### 8. CLI (keep, finish)

`rk operator autopilot queue|step|merge|stop|status`, each with `-L/--server` (default: caller's server from `$TMUX`) and `--json` (`{"ok":true,"result":{…}}`). `step [--dry-run]` reports the plan with no side effects (and takes no pass lock in dry-run). Human output caps each list per the shll toolkit P9 list-cap standard with an exact total, a truncation notice and an `--all` flag; `--json` stays complete. Exit codes: 0 ok (including `busy`), 1 operational, 2 usage/invalid — and the help text states exactly what the implementation does (pinned by CLI tests). Help conforms to the shll toolkit standards.

`step` order: (a) persist newly observed `done_at` for change-less items; (b) advance merge sequences (verify merges, arm next, `merge-auto` create + arm, retry pending disarms); (c) stall detection → `recovery needed` escalations; (d) spawn/respawn eligible queue items in queue order; (e) emit escalations (`spawned`, `cherry-picked`, `armed`, `merged`, `disarmed` actions + escalation lines). The engine never notifies; the caller turns escalations into `rk notify`.

### 9. Brief swap (new in R6a)

In `app/backend/internal/operator/brief_autopilot.md`, replace these sections with the `step` instruction ("run `rk operator autopilot step -L <server>` and act on its escalations: send `rk notify` for each; never run the spawn/arm choreography by hand"):

- "Items and readiness"
- "Spawning a queue item"
- the `cherry-pick-ladder` and `merge-auto` parts of "Merging" (the `stacked-prs` merge-all text stays until R6b, and the run is told `rk operator autopilot merge` refuses it)
- the non-recovery rows of "Failures and timing" (the recovery rows — CI fix round, conflicting rebase — stay until R6c)

"PR recovery" stays in full until R6c, and the brief notes that `step` reports these cases as `recovery needed: <reason>` escalations. The file's header line is updated (no longer "replaced by the R6 autopilot engine" as a whole). A test renders the brief (`operator.RenderBrief`) and asserts the replaced sections are gone, the `rk operator autopilot step` instruction is present, and the stacked-prs merge and PR recovery text remain. The chat-skill topic (`cmd/rk/skill/operator.md` and its `docs/site/skill/operator.md` mirror) is kept consistent: "merge all" on a `stacked-prs` queue follows the brief text, not `merge`.

### 10. Settings: `operator.merge_mode` (keep as built)

Registry enum key `operator.merge_mode` (`cherry-pick-ladder | stacked-prs | merge-auto`, default absent → `cherry-pick-ladder` source `default`), read only at `queue`. It renders on the settings surface, so the PR needs desktop + mobile screenshot evidence of that row (Constitution § PR Evidence); everything else is `No recording: internal CLI/engine behavior`.

### 11. Tests

Git behaviour against real temp repos (bare origin + clones); `gh`/`fab` through the scripted runner fake; `internal/autopilot/main_test.go` keeps the hermetic git environment. Coverage: pass lock (a second `step`/`merge`/`stop` while the lock is held returns `busy`, does nothing, exit 0; the lock is released on return and on process death), `spawning` without a pane escalates and never relaunches, stale base / fetch failure / upstream tracking / default-branch chain, ancestor pruning and cherry-pick conflict rollback, readiness rules, mode ladder and misfit, stacked-prs spawn base + `set-base-branch`, the five Auto-Merge rules, `recovery needed` escalation leaving the PR armed, uncertain arm outcome keeps `armed`, halted-and-armed disarm retried until durable, `merge` refusing `stacked-prs`, merge-auto deferral, bounded human lists, exit codes, and the brief-swap render test.

Gates: `just test-backend` plus `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1` (from `app/backend`). Known host-only failures that do not block: `cmd/rk` `TestPortPinRowRealPolicyValues` (fails on clean HEAD on loom2, passes in CI) and `rk/api` `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath` (load-timing flake).

## Non-Goals

**Review bar (binding — copied verbatim from the restructure plan; every review dispatch quotes it):**

> **Must-fix**: anything that can merge, arm, push, force-push or delete the wrong thing; lose or corrupt state-file data; launch a duplicate agent *under the single-writer rule*; crash the CLI; or break a requirement in the step's plan. **Should-fix** (does not block): failure cases the pass lock rules out, tmux pane-id reuse, missing escalations for read-only probes, and cosmetics.

Explicitly out of scope for R6a (not findings against it):

- **Failure cases the pass lock rules out** — two overlapping `step`/`merge`/`stop` passes, claim races, snapshot CAS. Accepted under the single-writer rule; should-fix at most.
- **tmux pane-id reuse** — pane liveness keyed only by tmux pane id (recycled ids). Accepted; should-fix at most.
- **Missing escalations for read-only probes** and **cosmetics** — should-fix, never blocking.
- **`stacked-prs` merge-all** (direct merge, base retarget, `rebase --onto` + force-push) — R6b. `merge` refuses it.
- **PR recovery** (`ci-failed` fix round, `conflicting` rebase + re-arm, recovery spawn) — R6c. `step` only escalates `recovery needed`.
- **Deleting `brief_autopilot.md`** and its embed/section — R7. Deleting the reference branch — R7.
- **Daemon-driven `step`** — candidate R8, decided after M1.
- **MCP tools** for the verbs.
- Reading fab's `autopilot.merge_mode` (retired in F2).

## Affected Memory

- `run-kit/operator-autopilot`: (new) the Go autopilot core: queue model over tracked items and explicit membership, readiness gate, spawn sequence (fetch-first SHA pin, two-axis prompt table, three-mode dependency code, `spawning` marker, one respawn), `cherry-pick-ladder` merge-all + Auto-Merge rules, `merge-auto`, `recovery needed` escalations, single-writer pass lock and `busy`, `rk operator autopilot` verbs, the merge-mode ladder, and what R6b/R6c still own.
- `run-kit/operator-state`: (modify) scope keys `queue`, `merge_mode` (queue-stamped), `spawning`, `respawned`, `armed`, `halted`, `merge_seq`; `done_at` persistence for change-less items; the per-server `<slug>.autopilot.lock` pass lock beside the state file; removal of `RecordPanePID`.
- `run-kit/operator-brief`: (modify) the interim autopilot section now delegates readiness, spawning, ladder/merge-auto merging and non-recovery failures to `rk operator autopilot step`; stacked-prs merge and PR recovery text remain until R6b/R6c; chat-skill topic routes queues through the verbs.
- `run-kit/configuration`: (modify) the `operator.merge_mode` settings-registry key; rk never reads fab's `autopilot.merge_mode`.
- `run-kit/rk-riff`: (modify) the additive spawn-engine extensions the engine uses.
- `run-kit/toolkit-standards`: (modify) the help-dump / P9 list-cap coverage of `rk operator autopilot`.
- `run-kit/architecture/cli`: (modify) the `rk operator autopilot` subcommand family.

## Impact

- **Modified (already on the branch, shrunk/finished here)**: `app/backend/internal/autopilot/` (delete `claim.go`, `recovery.go` and the stacked merge path; add the pass lock and `spawning` marker; disarm retry), `cmd/rk/operator_autopilot.go` (+ tests: `busy`, `merge` stacked refusal, exit codes), `internal/operator/export.go` (delete `RecordPanePID`), `internal/operator/brief_autopilot.md` + `brief_test.go` (brief swap), `cmd/rk/skill/operator.md` + `docs/site/skill/operator.md` (chat text consistency).
- **Kept as built**: `internal/settings` `operator.merge_mode`, `internal/riff` additions, the rest of `internal/operator/export.go`.
- **Untouched**: `internal/operatorloop` (daemon), MCP policy table, `operator.RenderBrief`'s section structure (R7).
- **External tools**: `git`, `gh`, `wt`, `fab` (`fab agent -o yaml`, `fab status set-base-branch`, `fab resolve`, `fab change switch`, `.status.yaml` reads). Every exec is an argv slice through `exec.CommandContext` with a timeout.
- **PR #1135**: retitle and rewrite the body for the R6a scope once this intake is in.
- **Risk**: destructive git/gh actions. Mitigated by the single-writer lock, confirm-in-chat, explicit `--squash`, cone-scoped disarm with durable retry, `armed` written before arming, and real-git tests.

## Open Questions

- None blocking. The restructure plan lists the `busy` exit code as open with "0 with `busy` in the result" proposed, and its binding decision table already states it; this intake takes that answer (Assumption 6).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `merge_mode` lives in rk settings `operator.merge_mode`; fab's `autopilot.merge_mode` is never read | Asked at R6 intake — user chose rk setting; restructure plan keeps it | S:95 R:70 A:90 D:95 |
| 2 | Certain | R6 is re-scoped to R6a; `stacked-prs` merge-all moves to R6b and PR recovery to R6c; this change keeps and shrinks the existing branch code | Restructure plan binding Split + Prior-work decisions | S:95 R:75 A:95 D:95 |
| 3 | Certain | Single-writer pass lock: non-blocking `flock` on `<state dir>/<slug>.autopilot.lock` for `step`/`merge`/`stop`; claim machinery and overlap tests deleted; state-file lock unchanged | Restructure plan binding Concurrency + State-file-lock decisions | S:95 R:75 A:90 D:90 |
| 4 | Certain | Review bar copied verbatim into Non-Goals and quoted in every review dispatch | Restructure plan binding Review-bar decision + rule 2 | S:100 R:90 A:100 D:100 |
| 5 | Certain | Brief swap in this PR for readiness, spawning, ladder/merge-auto merging and non-recovery failures, proven by a render test | Restructure plan Brief-migration decision, rule 5 and migration table | S:95 R:80 A:90 D:90 |
| 6 | Confident | A `busy` pass exits 0 with `busy: true` in the result | Binding decision table says "exits 0 with result busy"; plan's open-decisions row proposes the same | S:85 R:85 A:80 D:75 |
| 7 | Certain | Mode ladder `--mode` > setting > `cherry-pick-ladder`, resolved once at `queue`, stamped on every item; invalid value errors | Parent plan + R6 intake, carried | S:90 R:75 A:90 D:90 |
| 8 | Certain | Verbs `queue`/`step`/`merge`/`stop`/`status`; JSON-array stdin for `queue`; `step` is one idempotent pass; no verb waits for CI | Clarified at R6 — user confirmed; carried | S:95 R:60 A:85 D:85 |
| 9 | Certain | `stacked-prs` spawns cut from the SHA of `origin/<dep-branch>`, never `--checkout`; spawn for all three modes stays in R6a | Clarified at R6 — user confirmed; restructure R6a brief keeps all three spawn modes | S:95 R:60 A:85 D:85 |
| 10 | Certain | Spawn reuses `internal/riff` in-process; engine never notifies (escalations only); no MCP tools; daemon does not call `step` | R6 intake decisions carried + restructure non-goal | S:95 R:75 A:85 D:85 |
| 11 | Certain | Crash safety via `scope.spawning` written before launch and the pane right after; `spawning` without a pane escalates and never relaunches | Restructure R6a brief + State-file keys table | S:95 R:70 A:90 D:90 |
| 12 | Certain | Halt path and `stop` retry `--disable-auto` on every later pass until durable; `armed` cleared only after a confirmed disarm | Restructure plan: last R6 review finding 2, marked must-fix | S:95 R:70 A:85 D:85 |
| 13 | Certain | `armed` written before `gh pr merge --auto`; unknown outcomes keep the marker; only a closed list of definitive rejections clears it | Restructure R6a Merge brief | S:95 R:70 A:90 D:90 |
| 14 | Certain | A failed required check or `CONFLICTING` stall is the escalation `recovery needed: <reason>`, PR stays armed, no action | Restructure R6a Merge brief + Brief-migration interim behaviour | S:95 R:80 A:90 D:90 |
| 15 | Certain | `merge` refuses a `stacked-prs` sequence with a pointer to the brief text | Restructure R6a Move-out brief + migration table | S:95 R:85 A:90 D:90 |
| 16 | Certain | Delete `operator.RecordPanePID` (no callers) | Restructure plan: last R6 review finding 3 | S:95 R:90 A:95 D:95 |
| 17 | Certain | Git tested against real temp repos; gh/fab via scripted fake; `main_test.go` hermetic git env kept | R6 intake + CI fix, carried; restructure Current-state note | S:95 R:85 A:90 D:90 |
| 18 | Confident | `queue` and `status` do not take the pass lock; `step --dry-run` does not either | `queue` is one state-locked write and `status`/dry-run have no side effects; the binding decision names only `step`, `merge`, `stop` | S:75 R:85 A:80 D:70 |
| 19 | Confident | Helpers left without callers after moving out stacked/recovery code are deleted, not kept for R6b/R6c | Restructure rule 4: R6b/R6c port from the reference branch, never rely on leftovers | S:80 R:85 A:80 D:75 |
| 20 | Confident | Chat-skill text is adjusted only for consistency (stacked-prs "merge all" follows the brief); otherwise kept as built | R6 already routed queue/merge/stop through the verbs; R6a only changes merge's stacked behaviour | S:80 R:85 A:80 D:75 |

20 assumptions (16 certain, 4 confident, 0 tentative, 0 unresolved).
