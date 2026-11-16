# Operator autopilot — restructure R6, migration plan for the remaining steps

> Plan doc, written 2026-11-16, revised the same day after R6a's reviews. It amends step **R6**
> of `fab/plans/sahil/26-11-10-operator-to-hexokit.md` (the parent plan) and re-plans every step
> still open after C1: R6 (now R6a, R6r-i, R6r-ii, R6b, R6c), M1, F2; R7 and R8 are absorbed.
> The parent plan's "Decisions already taken" table and its "Rules for the operator executing
> this plan" still bind, except where this doc replaces them.

**Problem.** R6 (fab change `261114-8w1x-operator-autopilot-go`, PR #1135) ported the whole of
fab's §6 autopilot to Go in one change: queue, readiness, spawn, dependency code, ordered merge
in all three modes, and PR recovery. It never passed review. Over two `/fab-fff` runs (8 reviews,
6 rework cycles) the must-fix count went 7 → 10 → 2 → 7 → 2 → 5 → 3 → 3. No finding came back
once fixed. Each review read deeper and found a new rare failure case.

Three causes:

1. **Too many failure modes at once.** The engine reached about 3,900 lines plus 4,400 lines of
   tests. It runs destructive git and GitHub actions and tries to survive all of these, in every
   combination: a crash mid-action, two passes running at once, external writers to the state
   file, GitHub calls that time out with an unknown outcome, and tmux reusing pane ids.
2. **Each fix added new code to review.** Claims, markers, rollbacks and retries each brought
   their own failure cases. Five of the last eight findings were about two `step` passes
   overlapping.
3. **Scope bigger than needed.** PR recovery was added to R6 at intake. Most of the concurrency
   handling exists only because `step` may be called by the loop's run and by chat at the same
   moment.

---

## Decisions (binding for R6a–R6c)

| Decision | Choice | Why |
|---|---|---|
| Goal | **A tick costs a model call only when judgment is needed.** Everything mechanical (readiness, spawn, dependency code, arm, merge, restack, recovery, halt, notify) runs in Go; a model run is launched only for the judgment set (§ Loop) | This is why the series exists (parent plan § Goal). R1–R5 made quiet ticks free; every queue event still launches a model run that executes shell commands from prose. The daemon-driven pass is the end state, not an optimisation to decide after M1 |
| Concurrency model | **Single writer.** `rk operator autopilot step`, `merge` and `stop` take an exclusive, non-blocking, per-server pass lock (`flock` on `<state>/hexokit/operator/<slug>.autopilot.lock`) for the whole pass. A second caller exits 0 with result `busy` and does nothing | Removes the whole "two passes overlap" class (spawn/respawn/recovery claims, CAS snapshots). The R5 loop already runs one run at a time per server. The OS releases a `flock` when the process dies, so a crash never leaves the lock held (Constitution II) |
| Engine state file (from R6r-ii) | **The engine's state is its own file**, `<state>/hexokit/operator/<slug>.autopilot.yaml`, written only by `rk operator autopilot` verbs holding the pass lock. External influence goes through verbs (`queue`, `merge`, `stop`, `rm`, `resume`), never field edits. The tracked ledger holds projection items only (§ Engine state file) and no engine key. R6a's scope allow-list (its R28–R33: ownership list, `--force`, drift test, key registry) is deleted | Every design finding in R6a's five reviews was another writer changing an engine field between a pass's read and its act. The pass lock cannot cover writers that are not passes; an allow-list on a shared map covers them by enumeration, with an escape hatch. A file nobody else writes removes the class by construction. Constitution II still holds: it is a plain durable file, written before the verb returns |
| State-file lock | Unchanged for the tracked ledger. The store's sidecar lock is still never held across a subprocess, and writes still merge by item id (external writes win) | `rk operator track`, `rk operator check` and the daemon keep writing the ledger concurrently; from R6r-ii the engine writes only projection items there |
| Split | R6 becomes **R6a** (core), **R6r-i** (status and rule table), **R6r-ii** (own state file, daemon-launched mechanical pass, judgment-only model runs, brief diet), **R6b** (stacked-prs merge-all) and **R6c** (PR recovery) | Each lands and is reviewable on its own. R6r-i restructures R6a after it merges, not inside it: R6a shipped on the imperative shape, and reopening it would have restarted its review loop. R6r-ii moves the state and the launcher, which every executor reads through, so R6b and R6c start after it and run in parallel |
| Engine shape (from R6r-i) | **Observe → derive → decide → execute.** Each pass derives a status for every queue and PR item from durable and external sources; a fixed rule table maps each status to at most one typed action; executors do the work. See "Engine model" below | Most findings that survived the pass lock were stored markers disagreeing with GitHub (halted-and-armed, uncertain arm outcome). Deriving the status removes those markers. Rule selection becomes a pure function, tested by table without git or `gh` fakes. R6b and R6c become new rows plus executors, not new branches inside `driveHead` and `directMerge` |
| Stored vs derived | Store only underivable intent: membership and structure, user stops, budgets spent, timers started, actions in flight. Derive everything else every pass. A derived fact may be cached on disk only when it is monotone (`done_at` on a done item or a merged PR). A non-monotone fact (auto-merge armed, mergeable, checks, base, head) is never stored | Constitution II (external writes win) and X (derivation wins). A cached monotone fact cannot go stale; a cached non-monotone fact is exactly what drifted in R6 |
| Rule authorship | Rules and actions are **internal Go**, compiled from the queue and its merge mode. They are never authored by users or runs. `depends_on` is the edge set rules read; `done_when` and `then` are unchanged and stay the run-facing trigger layer (a done item hands its `then` text to the model run) | Actions merge, push and force-push; every path must pass the review bar. The rows need time and counter comparisons (30 minutes, `unchanged ≥ 3`) and cross-item reads that the equality-only `done_when` grammar deliberately leaves out to stay LLM-safe |
| Brief diet (from R6r-ii) | **The model run loses the mechanical job in one change.** R6r-ii deletes `brief_autopilot.md`, its embed and the "Interim autopilot" section, and removes `wt create`, `rk tab new`, `rk riff`, `git cherry-pick`, `git rebase`, `git push`, `gh pr ready`, `gh pr merge` and `fab status set-base-branch` from the run's allowed tools. R6a's section swap is the only interim. Until R6b and R6c land, `step` escalates the stacked restack and PR recovery as notes plus `rk notify`; nobody performs them unattended | A model following prose unattended is less predictable than a tested rule table, and a model that cannot force-push cannot force-push the wrong thing. Spreading the swap over four PRs keeps two owners of the same job alive for months |
| Model run trigger (from R6r-ii) | The loop launches a model run only when the **judgment set** (§ Loop) is non-empty after the mechanical pass. A changed set the pass fully handled launches nothing | The goal row. Today every detected change launches a run |
| Review bar | **Must-fix**: anything that can merge, arm, push, force-push or delete the wrong thing; lose or corrupt state-file data; launch a duplicate agent *under the single-writer rule*; crash the CLI; or break a requirement in the step's plan. **Should-fix** (does not block): failure cases the pass lock rules out, tmux pane-id reuse, missing escalations for read-only probes, and cosmetics. From R6r-ii, a finding that needs an external write to the engine file (a hand edit) is out of scope | The R6 reviews were correct but unbounded. A written bar lets review converge. Each step's intake carries this bar as an explicit non-goal list, and each review dispatch prompt quotes it |
| `merge_mode` location | Unchanged from R6 intake: rk settings key `operator.merge_mode`; fab's `autopilot.merge_mode` is never read | Decided with the user at R6 intake |
| Prior work | Kept, not thrown away. The full-scope engine is preserved on branch **`261114-8w1x-r6-full-reference`** (local and `origin`, commit `e99ca698`). R6a shrank that code in place; R6b and R6c **port** their executor bodies from it (read, adapt to the single-writer model, the engine file and the rule table, re-test), never cherry-pick blind | About 70 % of the code is reusable. The rest was written for the concurrency model this doc drops, or decides inside the action what R6r-i moves into rows |
| Unattended destructive actions | **Accepted.** The daemon arms, merges, restacks and force-pushes with no human and no model in the loop, within the rule table | This is already the design: a model does the same today from prose, unattended. The protections are unchanged: `merge_mode` is chosen per queue by the user, every destructive row has a halt-and-escalate branch, `autopilot stop` disarms durably, and `step --dry-run` shows what a pass would do |

---

## Engine model: derived status and rule table (binding from R6r-i)

R6r-i introduces this shape with R6a's behaviour only. R6r-ii moves the state and the launcher
(§ Engine state file, § Loop). R6b and R6c extend the tables. The tables below are the draft
each step's intake starts from. A step may rename a status or split a row; it may not add
behaviour outside a row.

### Pass

1. Take the pass lock.
2. Load the engine state once (R6r-i: the tracked ledger's engine keys; R6r-ii: the engine
   file, plus the ledger read-only for pane facts). Observe facts only for items that can act:
   unspawned and spawned queue items, and each merge sequence's head PR plus its predecessor.
   One fact read per item per pass.
3. Derive every item's status. `decide` picks at most one row per item, the first match in table
   order. `decide` is a pure function of (state, facts, now). `step --dry-run` prints its output
   and executes nothing.
4. Execute the chosen actions in ledger order. Before each one, re-read the item under the store
   lock and skip it if it changed or vanished since step 2 (external writes win). A
   non-idempotent action writes its intent first. An idempotent action writes nothing and the
   next pass observes its result.
5. No action sees another action's effect in the same pass. A successor acts on the next pass.

Rows only act on an item whose upstream items are all done or merged, and a halt only affects
downstream items, which are blocked by construction. So deciding from one snapshot cannot pick
two conflicting actions. The one case that cannot wait a pass is an armed item being halted:
the `halt` executor disarms that item itself right after writing `halted`. Row P3 covers every
other armed item in the cone and every failed disarm, on every pass, until GitHub reports it
disarmed.

Crash safety follows from the action kind. Idempotent actions (`arm`, `disarm`, `ready`,
`merge`, `restack`, the `record-*` writes) need no marker: a crash at any point is re-derived
next pass. Non-idempotent actions (`spawn`, `respawn`, `fix-request`, `recovery-spawn`, the
conflict `rebase`) write their intent first. An intent found without its evidence is escalated
(`spawning` without a pane) or counted as spent (respawn and recovery budgets). A crash can lose
a budget; it never spends one twice.

### Queue item status (kind `pane`, `scope.queue` set; first match)

| Status | Derived from |
|---|---|
| `done` | `done_at` set, or completion observed: fab `ship` done or `stop_stage` reached (rk's pane map); a plain agent's branch PR merged, or open with required checks green |
| `paused` | `paused` (user, or `stop`) |
| `skipped` | stored `skipped` |
| `held` | a `depends_on` item is not satisfied: not done; or a same-repo dependency without `stop_stage` has no PR; or, in `merge-auto`, the dependency's PR item has not merged |
| `pending` | no pane and no `spawning` |
| `spawn-unknown` | `spawning` set, no pane |
| `spawned` | pane alive |
| `dead` | pane recorded, not alive |

### PR item status (kind `github-pr`, `scope.merge_seq` set; first match)

| Status | Derived from | Step |
|---|---|---|
| `merged` | `gh` state `MERGED`, or `done_at` set | R6r-i |
| `halted` | stored `halted` on the item or on any item it transitively `depends_on` (the cone is derived, not written) | R6r-i |
| `closed` | `gh` state `CLOSED` | R6r-i |
| `deferred` | stored `deferred` (its repo's `merge` not started) | R6r-i |
| `blocked` | an upstream PR item has not merged | R6r-i |
| `stale-base` | `stacked-prs`, and the base is not the default branch or the predecessor's `mergeCommit` is not an ancestor of the head | R6b |
| `draft` | `isDraft` | R6r-i |
| `fixing` | `ci-fix` round spent and head equals `fix_head` | R6c |
| `failed` | a required check is `FAILURE` | R6r-i |
| `conflicting` | `mergeable == CONFLICTING` and `unchanged ≥ 3` | R6r-i |
| `green` | required checks pass (or none are required) and `mergeable == MERGEABLE` | R6r-i |
| `waiting` | anything else (checks pending, `mergeable` `UNKNOWN`) | R6r-i |

Facts read each pass besides the status inputs: `autoMergeRequest` (armed or not), the repo's
`autoMergeAllowed`, `headRefOid`, the authoring pane (rk's pane-to-change lookup), and `now`.

### Rule table

| # | Item · status | Guard | Action | Intent written first | Step |
|---|---|---|---|---|---|
| Q1 | queue · `done` | `done_at` unset | `record-done` | — | R6r-i |
| Q2 | queue · `pending` | readiness facts pass | `spawn` | `spawning` | R6r-i |
| Q3 | queue · `spawn-unknown` | not yet escalated | `escalate` | dedupe key | R6r-i |
| Q4 | queue · `dead` | respawn unspent | `respawn` | `respawned`, `spawning` | R6r-i |
| Q5 | queue · `dead` | respawn spent | `skip` + `escalate` | `skipped` | R6r-i |
| Q6 | queue · `spawned` | stage unchanged 30 min, or queue open 2 h | `escalate` once | dedupe key | R6r-i |
| Q7 | queue · `done`, `merge-auto` | no PR item | `track-pr` | — (the item write is the action) | R6r-i |
| P1 | PR · `merged` | `done_at` unset | `record-merged` (+ unreviewed report) | — | R6r-i |
| P2 | PR · `closed` | — | `halt` | `halted` | R6r-i |
| P3 | PR · `halted` | armed | `disarm` | — | R6r-i |
| B1 | PR · `stale-base` | predecessor merged | `restack`: verify or perform the retarget, `rebase --onto`, `--force-with-lease`; a conflict halts | — | R6b |
| P4 | PR · `draft` | — | `ready` | — | R6r-i |
| C1 | PR · `fixing` | `recovery_at` older than 30 min | `halt` | `halted` | R6c |
| C2 | PR · `failed` | `ci-fix` round unspent, authoring pane alive | `fix-request` | `ci-fix` round spent, `fix_head`, `recovery_at` | R6c |
| C3 | PR · `failed` | `ci-fix` round unspent, no authoring pane | `recovery-spawn` | as C2, plus `fix_item` | R6c |
| C4 | PR · `failed` | `ci-fix` round spent (head ≠ `fix_head`) | `halt` | `halted` | R6c |
| C5 | PR · `conflicting` | `rebase` round unspent | `rebase` onto default + `--force-with-lease`; a conflict halts | `rebase` round spent | R6c |
| C6 | PR · `conflicting` | `rebase` round spent | `halt` | `halted` | R6c |
| P5 | PR · `failed` or `conflicting` | (rows C2–C6 absent) | `escalate` `recovery needed` once per head | dedupe key | R6r-i; removed by R6c |
| P6 | PR · `waiting` | not `stacked-prs`, repo allows auto-merge, not armed | `arm` | — | R6r-i |
| P7 | PR · `green` | not armed | `merge` (squash) | — | R6r-i (`stacked-prs`: R6b) |
| F1 | fix item | parent merged or halted, or head ≠ `fix_head` and `green` | `untrack` | — | R6c |

Every other status is an explicit `wait`. Consequences of the table, binding:

- **Armed is derived.** `stop` and `halt` disarm every armed PR in the halted cone, whoever armed
  it. P3 is the retry until GitHub agrees. The stored `armed` key is no longer read.
- **Repos without auto-merge** are a fact (`autoMergeAllowed`), not the stored `direct` key. P7
  merges them on green. P7 also replaces the "clean status" arm fallback.
- **A halt writes one item.** Clearing `halted` on that item resumes its whole cone.
- **Re-arm after a recovery rebase** is P6 on the next pass, not code inside C5.
- **Stacked restack needs no `prepared` key.** B1's guard turns false once the predecessor's
  squash commit is an ancestor of the head, so the restack never repeats.
- **`merged` wins** over an open fix round. F1 cleans up the fix item.
- **Each recovery kind has its own one-round budget** (`ci-fix`, `rebase`). The reference engine
  kept one overwritten `recovery` value, which let a later failure of the other kind reset it.

### Action vocabulary (fixed, typed)

`record-done`, `spawn`, `respawn`, `skip`, `escalate`, `track-pr`, `record-merged`, `halt`,
`disarm`, `ready`, `arm`, `merge` (R6r-i); `restack` (R6b); `fix-request`, `recovery-spawn`,
`rebase`, `untrack` (R6c). The verbs `queue`, `merge` and `stop` write intent only (items, PR
chains, `deferred`, `halted`, `paused`) and then run one pass.

### Where the model stops

- **Executors stay imperative.** `spawn` is one action: fetch, SHA pin, the `cherry-pick-ladder`
  prune and squash cherry-pick with abort, the `stacked-prs` base and `set-base-branch`, the
  prompt table, launch, attach. `restack` and `rebase` are the same. The table decides *when*;
  each executor's failure handling (abort, worktree cleanup, rollback of an unopened launch) is
  reviewed on its own.
- **Status is derived, never one stored enum.** A stored status would duplicate GitHub and drift.
- **Time and counter guards** (30 min, 2 h, `unchanged ≥ 3`) are Go comparisons. They are not
  the `done_when` grammar.
- **Structure comes from verbs**, not rows: queue membership, PR chains and `deferred` start from
  the user.
- **One action per item per pass** adds one pass per PR to a sequence. CI time dominates.
- **Escalate-once** needs a stored dedupe key (R6a's `stall_seen`, generalised). Losing it only
  repeats a notification.

### Escalations are notes (from R6r-ii)

An `escalate` action appends a note (`by: run`, text prefixed `escalated: `) to the item's
ledger entry and sends `rk notify`. The pass's return value is for the CLI caller only; nothing
downstream depends on it. The note is what the model run's brief shows, what the drawer shows,
and what the judgment set reads. The dedupe key stays in the engine file.

### Engine state file (from R6r-ii)

`<state>/hexokit/operator/<slug>.autopilot.yaml`, mode `0600`, written through `fsatomic` by
`rk operator autopilot` verbs holding the pass lock, and by nothing else. It holds the queue
items and PR items of every sequence with the stored keys from § State-file keys, keyed by item
id, plus the per-sequence structure (`merge_seq` order, mode). Reads are tolerant; a missing
file is an empty engine.

The tracked ledger (`<slug>.yaml`) keeps what `check`, the brief and the drawer need, as
**projection items** the engine adds and removes:

| Ledger item | Written by the engine when | Carries |
|---|---|---|
| `pane` item, id = the queue item id | `spawn` / `respawn` attaches a pane | `pane`, `session`, `repo`, `change`, `branch`, `stop_stage`, `spawned_by` — binding and identity only |
| `github-pr` item, id = `pr-<n>` | `track-pr`, or `merge` starts a sequence | `repo`, `pr`, `change` |

Projection items carry no engine key. `check` watches them and writes its own fields
(`reported`, `last`, `checked_at`, `done_at`); the engine reads those as facts and never writes
them. `track update`, `track rm`, `pause` and notes on a projection item are external facts the
next pass observes: a removed projection item is an escalation (Q3's shape), a paused one is
`paused`, a user note is shown in the brief. There is no allow-list, no `--force`, no key
registry: the ledger has no engine-owned field to protect.

External influence on the engine goes through verbs, each taking the pass lock and then running
one pass: `queue` (add items), `merge` (start a sequence), `stop` (pause every unspawned item,
halt every sequence, disarm), `rm <id>` (drop a queue item that has not spawned, or a halted
sequence), `resume <id>` (clear `halted` or `skipped` on one item). `status` is read-only.

### Loop (from R6r-ii)

The operator loop's decision order ([operator-loop](docs/memory/run-kit/operator-loop.md)
§ Runner decision order) gains a mechanical phase between `Check` and the model run:

1. Busy gate, `operator.Check` — unchanged. `Changed == false` ⇒ `no change`, nothing launched.
2. Changed ⇒ the daemon persists the run record (with the changed list) and opens the run window
   as today. The wrapper (`rk operator run-exec`) first runs the **mechanical pass**
   in-process — `autopilot.Step` under the pass lock — and records its outcome in the run
   record (`pass: {actions, escalations, busy}`). A `busy` pass (chat holds the lock) is
   recorded and the wrapper continues; the chat pass owns those actions.
3. The wrapper computes the **judgment set** from the changed list, the pass result and the
   ledger: changed items whose reasons include `agent_state` (`waiting`/`idle`), `due`, `stale`,
   `paused`, `unknown_dep`, a `done` with a non-empty `then`, or a pane condition
   (`pane_death`, `pane_mismatch`, `agent_exited`) on an item the engine does not own; plus
   every item the pass escalated; plus any item with a `by: user` or `by: chat` note newer than
   its last `by: run` note. Reasons the rows own (`stage_advance`, `review_fail`, `changed` on a
   PR item, a queue item's `pane_death`, a `done` without `then`) are not judgment.
4. Empty judgment set ⇒ the wrapper exits 0 with `outcome: mechanical · <n> actions`; no
   launcher runs, no model is called. Non-empty ⇒ the wrapper renders the brief **now**
   (`operator.RenderBrief` with the judgment set as the changed list, so the brief shows the
   post-pass state) and runs the launcher as today.

Transcription gains one line shape, `ran · mechanical · <n> actions · <duration>`, and the
record gains the `pass` block. Retention is unchanged (newest 50). The brief's allowed tools
lose every git/gh write (§ Decisions, Brief diet). `rk operator autopilot step` from chat still
runs the same `autopilot.Step`; it is the one way to force a pass between ticks.

Why in the wrapper, not the daemon: a pass fetches, cherry-picks and pushes, which can take
minutes and must not block the tick or sit under tmux's timeout budget; the wrapper already
lives in a tmux window that survives a daemon restart (Constitution II, VI), already owns the
run's end state, and already has the run's `$TMUX` and run log. The daemon stays a launcher.

---

## Current state (verified 2026-11-16)

- **Merged to `main`**: R1 State Engine (#1120), R2 Check (#1129), R3 Operator Tasks (#1130), R4 Run
  Brief + Chat Skill (#1128), R5 Operator Loop (#1132), plus #1134 (explicit server for runs).
- **C1**: complete (per the user, 2026-11-14). F1 shipped as part of C1's release.
- **M1**: not verified from this repo. Check the measurement notes before scheduling F2. Record
  the "model runs per queue event" baseline **before R6r-ii lands** — it cannot be collected
  afterwards.
- **R6a**: change `261114-8w1x-operator-autopilot-go`, branch of the same name, PR #1135.
  Re-scoped from R6 by this doc on 2026-11-16 and run through `/fab-fff` the same day: five
  reviews (4 → 3 → 3 → 1 → 2 must-fix, nothing returning once fixed; reviews 1–3 were all
  "another writer changed an engine field mid-pass", solved by the scope allow-list R28–R33;
  reviews 4–5 were spec-precision findings), then review passed on the user's authority after
  the two review-5 fixes. Shipping was in progress when this doc was last updated — check
  `.status.yaml` and PR #1135. It ships on the imperative shape with the allow-list; R6r-i and
  R6r-ii replace both.
- **Reference branch**: `origin/261114-8w1x-r6-full-reference` (commit `e99ca698`), the full-scope
  engine after the second review run, with its `plan.md` (requirements R1–R28, tasks T001–T032).
- **Interim brief**: `app/backend/internal/operator/brief_autopilot.md` after R6a's section
  swap (stacked-prs merge-all and PR recovery remain as prose) is what runs execute until
  R6r-ii deletes it.
- **CI**: the Backend job needs git identity in tests. `internal/autopilot/main_test.go` already
  pins a hermetic git environment. Keep it in every step.
- **Known host-only test failure**: `cmd/rk` `TestPortPinRowRealPolicyValues` fails on clean
  `HEAD` on loom2 and passes in CI. `rk/api` `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`
  is a load-timing flake. Neither blocks a step.

---

## Rules for the operator executing this plan

1. The parent plan's rules 1–5 still apply (workers build in their own worktrees, user gates
   stop and ask, cross-repo dependencies mean merged **and released**, one fab change per step).
2. Every step's intake copies the **review bar** above into its non-goals, and every review
   dispatch quotes it.
3. A step that reaches its third failed review stops and reports to the user with the findings
   grouped by class; it does not start a fourth run on its own.
4. R6b and R6c read the reference branch with
   `git fetch origin 261114-8w1x-r6-full-reference && git show "origin/261114-8w1x-r6-full-reference:<path>"`
   (quoted — in zsh an unquoted `$R:path` is a modifier). They never merge or cherry-pick that
   branch. Delete it, local and remote, once both have merged; no step owns that chore.
5. R6r-ii proves the brief diet: a test renders the brief and asserts there is no autopilot
   section and the allowed-tool list names no git/gh write.
6. From R6r-i on, autopilot behaviour is added only as a status case, a rule row and an executor.
   A `decide` table test enumerates every reachable (item kind, merge mode, status) and asserts
   the row that fires, or an explicit `wait`. A behaviour outside the table, or a reachable
   combination with no outcome, is must-fix.
7. From R6r-ii on, the engine file is written only under the pass lock. A step never adds an
   engine key to a ledger item, and never reads a ledger item's `scope` for a decision beyond
   the projection keys listed in § Engine state file.

---

## Picking this up (hand-off for the next agent)

Everything below is reproducible from this file, the parent plan, `main` after R6a and the
reference branch. No conversation context is needed.

### Where things stand

| Item | State |
|---|---|
| R6a | Change `261114-8w1x-operator-autopilot-go`, PR #1135; see "Current state". If it is not yet on `main`, finish its pipeline first (`fab status` in `hexokit.worktrees/r6-autopilot-go` on loom2) |
| Next step | **R6r-i**, a new change (`/fab-new`, brief below, this file's path). Start it from `main` with R6a merged |
| Code R6r-i starts from | `app/backend/internal/autopilot/` as shipped by R6a (about 3,300 lines plus 4,300 of tests; `merge.go` ≈ 970 lines is the imperative driver R6r-i dissolves), `cmd/rk/operator_autopilot.go`, `internal/operator/ownership.go` + `scopekeys_test.go` (the allow-list R6r-ii deletes), `docs/memory/run-kit/operator-autopilot.md` |

### Decisions from R6 intake that carry into R6a

| Decision | Source |
|---|---|
| `merge_mode` lives in rk settings as `operator.merge_mode`; fab's `autopilot.merge_mode` is never read | User, R6 intake |
| Mode resolution `--mode` > setting > `cherry-pick-ladder`, resolved once at `queue` and stamped on every item; an invalid value is an error | Parent plan + R6 intake |
| Verbs `rk operator autopilot` `queue` / `step` / `merge` / `stop` / `status`; `queue` takes a JSON array on stdin; `step` is one idempotent pass and no verb waits for CI | User, R6 clarify |
| `stacked-prs` spawns cut the dependent's branch from the SHA of `origin/<dep-branch>`, never `wt create --checkout` | User, R6 clarify |
| Engine is called by runs and chat; the daemon does not call it — **superseded by R6r-ii** (the run wrapper calls it before any model run) | R6 intake |
| Spawn reuses `internal/riff` in-process; no MCP tools. "The engine never notifies (returns escalations)" is **superseded by R6r-ii** (escalations are notes plus `rk notify`) | R6 intake |
| Git tested against real temp repos; `gh`/`fab` through a scripted runner fake; `main_test.go` pins git identity | R6 intake + CI fix |

### What the last R6 review left open (all addressed by the R6a brief)

1. Pane liveness keyed only by tmux pane id (recycled ids). R6a: **accepted** under the review bar.
2. A transient disarm failure leaves a PR `halted` and `armed`, and later passes skip it. R6a:
   **must fix**. The halt path and `stop` retry the disarm until it is durable.
3. `operator.RecordPanePID` has no callers. R6a: **delete it**.

### Steps for the agent picking up R6r-i

```sh
cd <fresh hexokit worktree off main, R6a merged>
/fab-new <the R6r-i brief below, plus "plan: fab/plans/sahil/26-11-16-operator-autopilot-restructure.md">
# intake: carry the review bar and rules 6–7 into the non-goals; then
/fab-fff <change>
```

Pipeline notes from R6 and R6a:

- **Review** resolves to `codex` / `gpt-5.6-sol` at `xhigh` on the pane rung. Quote the review bar
  in the dispatch prompt. Two review panes died without a result during R6 (state `orphaned`).
  The one automatic `fab dispatch restart` recovered both times.
- **Apply on codex** (optional, what the second R6 run used): prefix the dispatch with
  `FAB_AGENT_WORKERS=codex`, e.g. `FAB_AGENT_WORKERS=codex fab dispatch open 8w1x apply`. It
  resolves to `gpt-6-astra` at `high`, scoped to that one dispatch, with no config change.
- **Gates**: `just test-backend` plus
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1`
  (CI has no git identity). The two known host-only failures under "Current state" do not block.
- **PR evidence**: R6r-ii changes what the Operator Tasks drawer shows (mechanical run lines,
  escalation notes) — desktop + mobile per Constitution § PR Evidence. Everything else is
  `No recording: internal CLI/engine behavior`.
- **Review convergence**: R6a's design findings stopped once the "other writer" class was
  closed. Quote rule 7 in R6r-ii's and later dispatches so reviewers do not reopen it.

R6r-i, R6r-ii, R6b and R6c start as new changes with `/fab-new`, using their brief below as the
description and this file's path. R6r-i starts once R6a has merged; R6r-ii once R6r-i has;
R6b and R6c once R6r-ii has.

---

## Steps and dependencies

| ID | Repo | Step | Depends on | Size | Gate |
|---|---|---|---|---|---|
| **R6a** | run-kit | Autopilot core: queue, readiness, spawn (all three modes), dependency code, merge-all for `cherry-pick-ladder`, `merge-auto`, `stop`, `status`, single-writer pass lock; brief swap for the sections it covers | C1 | L | — |
| **R6r-i** | run-kit | Status and rule table: restructure `step` into observe → derive → decide (pure rule table) → execute (typed actions); R6a's behaviour moves onto rows; armed and repo auto-merge become derived facts; the halt cone becomes derived. No new behaviour, no brief change | R6a | M | — |
| **R6r-ii** | run-kit | Own engine state file + projection items (delete the allow-list R28–R33); escalations as notes + `rk notify`; the run wrapper runs the mechanical pass before any model run; judgment-only model runs; brief diet (delete `brief_autopilot.md`, drop git/gh write tools); `rm`/`resume` verbs | R6r-i | M | — |
| **R6b** | run-kit | `stacked-prs` merge-all: status `stale-base`, row B1 and the `restack` executor (base retarget, `rebase --onto` + force-push), P7 for stacked PRs; replaces the interim `restack needed` escalation | R6r-ii | M | — |
| **R6c** | run-kit | PR recovery: rows C1–C6 and F1 and their executors (`ci-failed` fix round, `conflicting` rebase, recovery spawn), replacing P5 | R6r-ii | M | — |
| **M1** | — | Measure one week vs baseline (unchanged from the parent plan), plus model runs per queue event before and after R6r-ii | C1 | S | — |
| **F2** | fab-kit | Delete fab's operator code, skill and docs (unchanged), and retire fab's `autopilot.merge_mode` key | C1 + 1 release, R6b, R6c, M1 | M | **user gate** |

R7 (delete the brief) is absorbed by R6r-ii; R8 (daemon-driven `step`) is absorbed by R6r-ii
and is no longer a candidate. The reference branch is deleted by hand once R6b and R6c merge.

```
C1 ──┬── R6a ── R6r-i ── R6r-ii ──┬── R6b ──┐
     │                            └── R6c ──┴── F2
     └── M1 ────────────────────────────────┘
```

R6b and R6c share only the status derivation and the rule table, and each adds its own rows
there. Their executors live in separate files. Neither touches the other's code path, so they
can merge in either order (the reference engine's `directMerge` called recovery code; P7 does
not).

### Brief migration

| `brief_autopilot.md` section | Replaced by | Interim behaviour until then |
|---|---|---|
| Items and readiness · Spawning a queue item · ladder and `merge-auto` merging · non-recovery Failures and timing | R6a's section swap ("run `rk operator autopilot step` and act on its escalations") | — |
| Everything that remains (stacked-prs merge-all, PR recovery, recovery rows) and the file itself | **R6r-ii** deletes the file, the embed and the brief section, and removes the git/gh write tools from the run's allowed list | Between R6r-ii and R6b/R6c: `step` escalates `restack needed: <PR>` / `recovery needed: <reason>` as a note + `rk notify` and leaves the PR unarmed; the model run reports it, never performs it; the user does it by hand or waits for R6b/R6c |

### State-file keys

Through R6r-i, engine keys live in tracked items' opaque `scope`. From R6r-ii they live in the
engine file (§ Engine state file); R6r-ii moves the keys of every queue and PR item once, under
the pass lock, and strips them from the ledger. Reads are tolerant. Keys a step stops using are
ignored by later code, never rewritten.

From R6r-i, every key the engine reads is intent it cannot derive. Keys marked *not read from
R6r-i* stay tolerated on disk, and their facts are derived instead.

| Key | Introduced by | Meaning | From R6r-i |
|---|---|---|---|
| `queue` | R6a | Queue id stamped by `autopilot queue`; queue membership | Stored (structure) |
| `merge_mode` | R1 (existing) | Mode stamped on every queue item; null reads as `cherry-pick-ladder` | Stored (structure) |
| `merge_seq`, `item` | R6a | Repo sequence id on `github-pr` items; the queue item a PR item belongs to | Stored (structure) |
| `deferred` | R6a | The repo's `merge` has not been started | Stored (user intent) |
| `spawning` | R6a | Intent marker written before a launch; a pass that finds it without a pane escalates and never relaunches on its own | Stored (in flight) |
| `respawned`, `skipped` | R6a | The one respawn has been spent; the item died again after it | Stored (budget) |
| `halted` | R6a | Sequence halted | Stored on the failing item only (or every unmerged PR item on `stop`); the cone is derived through `depends_on` |
| `armed` | R6a | Auto-merge armed (written before `gh pr merge --auto`) | *Not read from R6r-i*, and no longer written: derived from `autoMergeRequest` |
| `direct` | R6a | Repo has auto-merge disabled; merge step by step | *Not read from R6r-i*: derived from the repo's `autoMergeAllowed` |
| `stall_seen` | R6a | `recovery needed` already escalated for this reason and head | Generalised to the dedupe key of every escalate-once row |
| `recovery`, `fix_head`, `recovery_at`, `fix_item` | R6c | Recovery rounds spent (`ci-fix`, `rebase`), head and time of the fix request, the recovery spawn's item | Stored (budget, timer, link) |

R6b adds no key: the reference engine's `prepared` marker is replaced by B1's derived guard.

---

## Briefs

### R6a — Autopilot core (run-kit) — re-scopes change `261114-8w1x-operator-autopilot-go`

Keep, simplify and finish the existing branch. Do not start a new change.

- **Pass lock.** Add the per-server pass lock to `step`, `merge` and `stop`, and delete the
  concurrency machinery it replaces: `internal/autopilot/claim.go`, the snapshot CAS, the
  claim tokens and the overlapping-pass tests. Keep crash-safety through the `spawning` intent
  marker: write it before launching, write the pane right after, and when a later pass finds
  `spawning` without a pane, escalate and do not relaunch.
- **Keep**: queue (`scope.queue` stamp, mode ladder, implicit chaining, forward/cyclic dependency
  rejection, misfit-safe live call, dry-run-first chat flow); readiness gate (required checks
  only, same-repo PR-exists rule, `branch_map`); spawn sequence (fetch-first SHA pin, failed fetch
  stops, confidence gate, two-axis prompt table, `stacked-prs` base from the SHA of
  `origin/<dep-branch>` plus `set-base-branch`, one respawn); dependency code (`cherry-pick-ladder`
  prune + squash cherry-pick, conflict abort + escalate); explicit queue membership (bare tracked
  panes are never respawned); `branch` and repo validation before any mutation.
- **Merge**: `cherry-pick-ladder` merge-all with the five Auto-Merge rules. Write `armed` before
  arming. Unknown `gh` outcomes keep the marker. `stop` and the halt path retry a disarm until it
  is durable (the halted-and-armed finding from the last R6 review). `merge-auto` arm-on-ship
  with the next spawn deferred until the merge is verified. A failed check or `CONFLICTING` is an
  escalation (`recovery needed`), not an action.
- **Move out**: the `stacked-prs` merge path (`stackedStep`, `prepareStacked`, the retarget and
  rebase code) and all of `recovery.go`, with their tests. `merge` refuses a `stacked-prs`
  sequence with a pointer to the brief.
- **CLI**: `rk operator autopilot queue|step|merge|stop|status`, bounded human lists with `--all`,
  `busy` result when the pass lock is held, and exit codes that match the help.
- **Brief swap**: replace "Items and readiness", "Spawning a queue item", the ladder and
  `merge-auto` parts of "Merging", and the non-recovery rows of "Failures and timing" with the
  `step` instruction.
- **Accepted, not blocking** (review bar): pane-id reuse; races the pass lock rules out.
- **Settings**: `operator.merge_mode` stays as built. Its settings row needs the PR's
  desktop + mobile screenshot evidence (Constitution § PR Evidence).
- **Shape**: keep the imperative structure as built. Do not refactor toward the rule table
  inside R6a; R6r-i does that after R6a merges. *(R6a shipped on this brief.)*

### R6r-i — Status and rule table (run-kit)

Restructure the merged R6a engine into the shape in "Engine model". Behaviour stays R6a's,
apart from the deltas listed here. State stays in the ledger's `scope` for this step.

- **Split `step`** into observe (one fact read per actionable item), derive (status per item),
  `decide` (pure: state, facts, now → at most one action per item) and execute (one executor
  per action). `step --dry-run` prints `decide`'s output. `merge` and `stop` write their intent,
  then run one pass.
- **Rows**: Q1–Q7, P1–P7 as drafted. The existing spawn, respawn, arm, disarm, ready and merge
  code becomes executor bodies with their decisions moved out. Delete the in-pass sequence
  loop (`advanceSeq`'s guard loop), `retryDisarms` (now row P3), the arm-rejection fallbacks
  to direct merge (now P7) and the stored `direct` path.
- **Intentional deltas**, each with a test: armed is read from `autoMergeRequest` and `stop`
  and `halt` disarm every armed PR in the halted cone; repo auto-merge is read from
  `autoMergeAllowed`; a halt writes `halted` on one item and the cone is derived; a failed or
  conflicting PR is not armed first; a sequence advances one PR per pass.
- **Tests**: a `decide` table test per rule 6 (no git, no `gh`); executor tests against real temp
  repos and the scripted runner fake. R6a's behaviour tests stay green, changed only where they
  assert one of the deltas.
- **Resolved**: the engine stops writing `armed` (nothing outside it reads the key);
  `autopilot status` shows the derived status names from "Engine model"; derived statuses are
  not exposed to `done_when` (`status` is the read surface).
- **No brief change**, no new verb, no new key. R6a's `recovery needed` escalation (P5) and the
  `stacked-prs` refusal in `merge` stay.
- **Docs**: `docs/memory/run-kit/operator-autopilot.md` (added by R6a) describes the status
  tables, the rule table and the stored-vs-derived split.

### R6r-ii — Own state, mechanical runs, brief diet (run-kit)

Make the mechanical half free and the model's job small. Four parts, one change:

- **Engine state file** per § Engine state file: the store, the one-time move of engine keys
  out of the ledger under the pass lock, projection items, the `rm` and `resume` verbs. Delete
  `internal/operator/ownership.go`, `scopekeys_test.go`, the `--force` flag on `track update`
  / `track add` / `track rm` and the armed-PR `track rm` refusal (R6a's R28–R33): the ledger
  has no engine field left to protect. `track update --scope` goes back to merging any key.
- **Escalations are notes** per § Escalations are notes: `escalate` appends the note and calls
  `rk notify`; the `StepResult.Escalations` return stays for the CLI's output only. Interim
  escalations for the parts R6b/R6c own: `restack needed: PR #<n>` (a `stacked-prs` sequence
  whose predecessor merged; replaces `merge`'s stacked-prs refusal) and R6a's `recovery needed`.
- **Mechanical pass in the run wrapper** per § Loop: `operatorloop.Exec` runs `autopilot.Step`
  before the launcher, records the `pass` block, computes the judgment set, exits without a
  launcher when it is empty, else renders the brief post-pass and launches. The transcription
  line `ran · mechanical · …`, the drawer's rendering of it, and the Go integration test on an
  isolated socket (R5's) extended with one mechanical-only run.
- **Brief diet**: delete `brief_autopilot.md`, its embed and the "Interim autopilot" section;
  cut the git/gh write tools and the queue-spawn tools from `brief_rules.md`'s allowed list and
  its direct-action allowlist; the bounded-retries table loses its cherry-pick, rebase, pane
  death and PR recovery rows. The chat skill (`rk skill operator`) keeps its queue-creation
  text but points at `rk operator autopilot` verbs for every mechanical action. Rule 5's test.
- **Docs**: `operator-loop.md` (decision order, wrapper, record, transcription),
  `operator-brief.md` (layout, allowed tools), `operator-state.md` (projection items, no
  allow-list), `operator-autopilot.md` (engine file, verbs, judgment set).
- **PR evidence**: Operator Tasks drawer with a mechanical run line and an escalation note,
  desktop + mobile.

### R6b — `stacked-prs` merge-all (run-kit)

- Add the `stale-base` status, row B1 and the `restack` executor. Port the executor body from the
  reference branch's `prepareStacked` (fetch, verify or perform the retarget, `rebase --onto` +
  `--force-with-lease`, conflict abort), with its tests from `merge.go` and `merge_test.go`,
  minus the claim code and the `prepared` marker. The executor starts from `origin/<branch>`,
  never a local branch, so a crash between the rebase and the push repeats cleanly.
- Behaviour per fab-operator §6 Ordered Merge, as rows: a stacked PR never matches P6 (never
  armed); P4 readies a draft; P7 merges only on `green`, which is derived on the *current* head
  each pass; B1 fires after the predecessor merges and its guard turns false once the
  predecessor's squash commit is an ancestor of the head, so a restack never repeats and the merge
  waits for the next pass by construction. A rebase conflict halts and escalates, never skips.
- Remove the interim `restack needed` escalation. No brief change (R6r-ii deleted it).
- Single-writer model throughout; no claim machinery; no new engine-file key.

### R6c — PR recovery (run-kit)

- Add the `fixing` status, rows C1–C6 and F1, and the `fix-request`, `recovery-spawn`, `rebase`
  and `untrack` executors. Port the executor bodies from the reference branch's `recovery.go`
  minus the claim code. Recovery cases in `lifecycle_test.go`, `merge_test.go`,
  `escalation_test.go` and `revised_rules_test.go` become `decide` table cases where they test a
  decision, and executor tests where they test git, `gh` or pane effects.
- `ci-failed`: one `ci-fix` round per PR, recorded with `fix_head` and `recovery_at` before acting;
  fix request to the authoring pane (rk's own pane-to-change lookup) or one recovery spawn when
  it is gone; `fixing` waits while the head is unchanged; red on a new head (C4), or 30 minutes
  with no push (C1), halts and disarms.
- `conflicting`: one `rebase` round onto the default branch + `--force-with-lease`; the re-arm is
  row P6 on the next pass; `CONFLICTING` again (C6), or a rebase conflict, halts and escalates.
- Remove row P5 (`recovery needed`). No brief change (R6r-ii deleted it). The fix request to
  the authoring pane is the one raw send into a fab-project agent and is sent by the executor,
  not by a model.

### M1 — Measure

Unchanged from the parent plan, plus two measurements: run tokens on queue ticks before and
after R6a (queue work is where the brief swap should cut cost), and **model runs per queue
event** before and after R6r-ii (the goal row's metric: after R6r-ii a merged PR or a stage
advance should launch no model run). Capture the "before" of both now.

### F2 — Delete fab's operator (fab-kit, user gate)

Unchanged from the parent plan, plus: retire fab's `autopilot.merge_mode` config key (rk owns
`operator.merge_mode` now) with a migration note in `src/kit/migrations/` that spells out the
manual step — fab cannot write rk's settings, so anyone who set the fab key must run
`rk settings set operator.merge_mode <value>` or silently fall back to `cherry-pick-ladder`.

---

## Open decisions

| Step | Question |
|---|---|
| R6a | Exit code for a `busy` pass: 0 with `busy` in the result (as shipped), or a distinct non-zero class |
| R6r-ii | Whether `busy` in the wrapper's mechanical phase (chat holds the lock) should wait up to a bound for the lock (proposed: no — record `busy` and continue; the chat pass's escalations become notes the next check sees) |
| R6r-ii | Whether a mechanical-only run record counts toward the newest-50 retention (proposed: yes, same retention, simpler) |
| R6r-ii | Whether R6a's `merge` verb survives as a user command that writes `deferred: false` and runs a pass (proposed: yes, unchanged) or merge-start becomes a `queue` flag |
