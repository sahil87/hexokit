# Intake: Autopilot status and rule table (R6r-i)

**Change**: 261116-qtgq-autopilot-status-rule-table
**Created**: 2026-11-16
**Plan**: `fab/plans/sahil/26-11-16-operator-autopilot-restructure.md` (step **R6r-i**; binding sections: "Decisions", "Engine model: derived status and rule table", "Rules for the operator executing this plan", "State-file keys", "Briefs › R6r-i")

## Origin

> Implement step R6r-i (Status and rule table) of fab/plans/sahil/26-11-16-operator-autopilot-restructure.md: read that plan (sections "Engine model", "Rule table", "R6r-i" brief, Decisions, Rules for the operator) and restructure the merged R6a autopilot engine in app/backend/internal/autopilot/ into observe -> derive -> decide (pure rule table) -> execute, exactly per the R6r-i brief. State stays in the ledger scope. Copy the review bar and rules 6-7 into the intake non-goals. After the intake, stop and report; the operator will send /fab-fff.

One-shot invocation from the operator executing the plan. No prior design conversation in this session; every decision below comes from the plan doc (binding) or from reading the code as merged on `main` at `35c84db3` (R6a = PR #1135, plan doc = PR #1137). The plan doc is the source of truth; where this intake and the plan disagree, the plan wins unless an Assumption row below says otherwise and why.

## Why

R6a (`261114-8w1x-operator-autopilot-go`) shipped the autopilot engine on an **imperative shape**: `step` is four phases (`observeDone`, `advance`, `spawnPending`, `flagSlow`) that each re-load the ledger, read GitHub, decide and act inline. `merge.go` (≈970 lines) holds the merge driver: `advanceSeq` loops up to 64 times per sequence (verify merge → `continue` → arm next) and `driveHead` / `arm` / `directMerge` / `stall` / `haltCone` / `retryDisarms` decide inside the action. Decisions rest on **stored markers that duplicate GitHub**: `scope.armed` (written before `gh pr merge --auto`, kept on unknown outcomes, cleared by a closed rejection list), `scope.direct` (written when the repo refuses auto-merge), `scope.stall_seen` (the `recovery needed` head marker), and `halted` written on every PR item of a whole cone of sequences.

1. **The problem.** Most R6 review findings that survived the pass lock were a stored marker disagreeing with GitHub (halted-and-armed, uncertain arm outcome, stale `direct`). Every new behaviour (R6b's stacked restack, R6c's recovery) would be another branch inside `driveHead` and `directMerge`, and each would need git/`gh` fakes to test a decision.
2. **If we don't.** R6b and R6c land as new imperative branches in the same driver; each review reads deeper into interleaved decide-and-act code and the unbounded review loop of R6 repeats. R6r-ii (own state file, daemon-launched mechanical pass) needs a pure `decide` to run the mechanical half without a model.
3. **Why this approach.** The plan's binding decision "Engine shape (from R6r-i)": **observe → derive → decide → execute**. Status is derived every pass from durable intent plus external facts; a fixed rule table maps each status to at most one typed action; executors do the work. Stored-vs-derived rule: store only underivable intent (structure, user stops, budgets spent, timers, actions in flight); derive everything else; never store a non-monotone fact (armed, mergeable, checks, base, head). `decide` becomes a pure function tested by table with no git or `gh`.

## What Changes

Behaviour stays R6a's, apart from the five **intentional deltas** listed in § Intentional deltas, each with its own test. State stays in the tracked ledger's `scope` (no engine state file — that is R6r-ii). No brief change, no new verb, no new scope key.

### 1. Pass shape (`internal/autopilot/`)

`Step` keeps its signature (`func Step(ctx, env) (*StepResult, error)`) and the pass lock (`passLocked`, unchanged). The body becomes four stages:

1. **Observe** — load the ledger once (`operator.Load`). Take one pane snapshot (`env.Panes.Snapshot`). Read external facts **only for items that can act**: unspawned and spawned queue items (pane liveness, pane stage/display-state from rk's pane map, plain-agent branch PR state + required checks, same-repo-dependency PR existence for readiness), and for PR items: each merge sequence's **head** (first not-done PR item) plus its **predecessor**, plus every unmerged PR item in a halted cone (so P3 can disarm any armed one — see Assumption 8). One fact read per item per pass. PR facts: `gh pr view <n> --repo <nwo> --json number,url,state,isDraft,mergedAt,mergeable,headRefOid,autoMergeRequest` and `gh pr checks <n> --required --json name,state,link`; repo facts: `gh repo view <nwo> --json autoMergeAllowed` cached per repo per pass (in `repoMeta`). A failed fact read escalates as today (`gh pr view failed: …`) and the item's status is `waiting`/unknown → no action that pass. Observe keeps R6a's `operator.Observe` write of the head's polled `state`/`mergedAt`/`mergeable` (it is the `unchanged` clock the `conflicting` status needs); it is skipped under `--dry-run`.
2. **Derive** — a status per item, per the two status tables below (first match). Pure function of (state, facts).
3. **Decide** — `decide(state, facts, now) []Decision`: pure, no I/O, no `ctx`; walks the rule table in order and picks **at most one row per item** (first match). Every reachable (item kind, merge mode, status) maps to a row or an explicit `wait`. `step --dry-run` prints `decide`'s output and executes nothing (and takes no lock, as today).
4. **Execute** — run the chosen actions in **ledger order**, one executor per action kind. Before each, re-read the item under the store lock and **skip it if it changed or vanished** since observe (external writes win); "changed" compares a fingerprint of the item's decision inputs, not `updated_at`/`last`/`unchanged`/`checked_at` (so observe's own write does not invalidate it). A non-idempotent action writes its intent first; an idempotent one writes nothing and the next pass observes its result. No action sees another action's effect in the same pass — a successor acts on the next pass.

Suggested shape (names are the apply agent's call; the separation is binding):

```go
type QueueStatus string // done, paused, skipped, held, pending, spawn-unknown, spawned, dead
type PRStatus string    // merged, halted, closed, deferred, blocked, draft, failed, conflicting, green, waiting
type ActionKind string  // record-done, spawn, respawn, skip, escalate, track-pr, record-merged, halt, disarm, ready, arm, merge

type Decision struct {
    Item   string     // ledger item id
    Row    string     // "Q2", "P6", … or "" for wait
    Action ActionKind // "" == wait
    Reason string     // escalation text / human detail
}

func decide(st snapshot, facts facts, now time.Time) []Decision // pure
```

The rule table is data (a slice of `{id, kind, status, guard, action}`), so the table test can iterate it.

### 2. Queue item status (kind `pane`, queue item per `operator.IsQueueItem`; first match)

| Status | Derived from |
|---|---|
| `done` | `done_at` set, or completion observed: fab `ship` done or `stop_stage` reached (`operator.BuiltInCompleted` over rk's pane map row); a plain agent's branch PR `MERGED`, or `OPEN` with required checks not pending (R6a's `plainAgentDone`) |
| `paused` | `paused` (user, or `stop`) |
| `skipped` | stored `skipped` |
| `held` | a `depends_on` item is not satisfied: not done; or a same-repo dependency without `stop_stage` has no PR; or, in `merge-auto`, the dependency's PR item has not merged (R6a's `gate` + `mergeAutoBarrier`; `branch_map` deps count as satisfied) |
| `pending` | no pane and no `spawning` |
| `spawn-unknown` | `spawning` set, no pane |
| `spawned` | pane alive (present in the snapshot) |
| `dead` | pane recorded, not alive |

### 3. PR item status (kind `github-pr`, `scope.merge_seq` set; first match)

| Status | Derived from |
|---|---|
| `merged` | `gh` state `MERGED`, or `done_at` set |
| `halted` | stored `halted` on the item **or on any item it transitively `depends_on`** (cone derived, never written) |
| `closed` | `gh` state `CLOSED` |
| `deferred` | stored `deferred` (its repo's `merge` not started) |
| `blocked` | an upstream PR item (`depends_on`) has not merged |
| `draft` | `isDraft` |
| `failed` | a required check is `FAILURE` |
| `conflicting` | `mergeable == CONFLICTING` and item `unchanged ≥ 3` (`stallUnchanged`) |
| `green` | required checks pass (or none are required) and `mergeable == MERGEABLE` |
| `waiting` | anything else (checks pending, `mergeable` `UNKNOWN`, fact read failed) |

`stale-base` (R6b) and `fixing` (R6c) are **not** added in this step.

Facts read besides the status inputs: `autoMergeRequest` (armed iff non-null), the repo's `autoMergeAllowed`, `headRefOid`, and `now`.

### 4. Rule table (R6r-i rows only; first match per item; table order)

| # | Item · status | Guard | Action | Intent written first |
|---|---|---|---|---|
| Q1 | queue · `done` | `done_at` unset | `record-done` | — |
| Q2 | queue · `pending` | readiness facts pass | `spawn` | `spawning` |
| Q3 | queue · `spawn-unknown` | not yet escalated | `escalate` (`spawn interrupted: …`, R6a text) | dedupe key |
| Q4 | queue · `dead` | respawn unspent | `respawn` | `respawned`, `spawning` |
| Q5 | queue · `dead` | respawn spent | `skip` + `escalate` | `skipped` |
| Q6 | queue · `spawned` | stage unchanged 30 min, or queue open 2 h | `escalate` once | dedupe key |
| Q7 | queue · `done`, `merge-auto` | no PR item | `track-pr` | — (the item write is the action) |
| P1 | PR · `merged` | `done_at` unset | `record-merged` (+ unreviewed report) | — |
| P2 | PR · `closed` | — | `halt` | `halted` |
| P3 | PR · `halted` | armed | `disarm` | — |
| P4 | PR · `draft` | not `stacked-prs` | `ready` | — |
| P5 | PR · `failed` or `conflicting` | not yet escalated for this head | `escalate` `recovery needed: <ci-failed\|conflicting> — PR #<n> (<repo>)` once per head | dedupe key |
| P6 | PR · `waiting` | not `stacked-prs`, repo allows auto-merge, not armed | `arm` | — |
| P7 | PR · `green` | not `stacked-prs`, not armed | `merge` (squash) | — |

Every other (item, status) is an explicit **`wait`**. Q1 precedes Q7, so a newly done `merge-auto` item records `done_at` one pass and tracks its PR the next. For the Q6 "queue open 2 h" half, see Assumption 9.

Consequences (binding, from the plan):

- **Armed is derived** from `autoMergeRequest`. `stop` and `halt` disarm every armed PR in the halted cone, whoever armed it. P3 retries every pass until GitHub agrees. The stored `armed` key is no longer read and **no longer written**.
- **Repos without auto-merge** are the `autoMergeAllowed` fact, not the stored `direct` key. P7 merges them on green. P7 also replaces the "clean status" arm fallback (a PR with no required checks and `MERGEABLE` is `green` → merged directly).
- **A halt writes one item.** Clearing `halted` on that item resumes its whole cone.
- **Escalate-once** uses the existing `scope.escalated` dedupe map (R6a's R29) for every escalate-once row; `stall_seen` folds into it (P5's key includes the head SHA, e.g. `recovery needed: ci-failed @<headRefOid>` or equivalent). `stall_seen` is no longer written or read.

### 5. Executors (decisions moved out)

Existing code becomes executor bodies; the decide-inside-the-action branches are deleted.

| Action | Executor body from | Notes |
|---|---|---|
| `record-done` | `observeDone`'s `patch(DoneAt)` | idempotent; act `done` |
| `spawn` | `spawnItem` (validate branches/repo, fetch-first SHA pin, confidence gate, `cherry-pick-ladder` prune + squash cherry-pick with abort, `stacked-prs` base + `set-base-branch`, two-axis prompt table, `launch`, `attach`) | non-idempotent: writes `spawning` first (unchanged); every refusal escalates and leaves the item pending |
| `respawn` | `respawn` (existing-branch respawn, stacked base rebuild) | writes `respawned` + `spawning` first (unchanged) |
| `skip` | `respawn`'s spent branch | writes `skipped`, then escalates `pane died after its one respawn: skipped, dependents stay held` |
| `escalate` | `escalate` / `recordEscalation` | dedupe map + note (unchanged mechanics) |
| `track-pr` | `createMergeAutoPRs` (one item) | discovers the PR by branch, `newPRItem`, `addPRItems` |
| `record-merged` | `markMerged` (minus the `armed=false` write) | report line `ab12: merged (foo 1/2)` + `· unreviewed`; `merged without review:` summary once per pass |
| `halt` | new, small: write `halted` on **this one item**, escalate `halted: <reason>`, then disarm this item itself if armed | replaces `haltCone`'s cone-wide write |
| `disarm` | `disarm` (minus marker write) | `gh pr merge --disable-auto`; already-disabled or PR merged/closed counts as done; else escalate `disarming PR #n failed — it may still merge` |
| `ready` | `readyDraft` | `gh pr ready`; next pass arms/merges |
| `arm` | `arm` minus marker writes and rejection fallbacks | `gh pr merge --auto --squash`; `alreadyApplied(arm)` is success; any other error escalates `arming PR #n failed: …` and the next pass re-observes `autoMergeRequest` |
| `merge` | `mergeNow` | `gh pr merge --squash`; `alreadyApplied(merge)` is success |

PR-identity safety stays: `pin` (pinned owner/name from the probe's `--repo`) and the execute-time re-read (replaces `stillNamesSamePR` / `patchPR`'s identity check — the fingerprint covers `identityOf`).

**Delete**: `advanceSeq`'s guard loop and `driveHead`, `retryDisarms` (→ P3), `directMerge` and the arm-rejection fallbacks to direct merge (`"clean status"` → `mergeNow`, `"auto merge is not allowed"` → `direct`), the stored `direct` path, `markArmed` and every `scope.armed` write, `definitiveArmRejection` (no marker left to protect), `stall` and `scope.stall_seen` writes, `haltCone`'s cone-wide `halted` write, `flagSlow` / `observeDone` / `spawnPending` / `respawnDead` / `escalateInterrupted` as phase loops (their logic lives in derive, rows and executors). Keep tolerated-on-disk: old `armed`, `direct`, `stall_seen` values are ignored, never rewritten.

### 6. Verbs

- **`step`**: one pass as above.
- **`merge`** (`StartMerge`): keeps its validation (`--repo`, not-done refusal, the **`stacked-prs` refusal** with `errStackedMerge`) and writes its intent only — the PR chains (`buildPRChains`, `addPRItems`) and lifting `deferred` (`startChains`) — then runs **one pass** (the same observe/derive/decide/execute). It no longer calls `advance`.
- **`stop`**: writes intent only — `halted` on every unmerged PR item, `paused` on every unspawned unfinished queue item — then runs **one pass**, in which P3 disarms every armed PR in the halted set. It no longer collects `targets` from the `armed` marker.
- **`status`**: read-only, no lock, no writes, no escalations (as today). It runs observe + derive and shows the **derived status names** from the tables above: queue item rows use the queue status (`done`, `paused`, `skipped`, `held`, `pending`, `spawn-unknown`, `spawned`, `dead`), and a row with a PR item also shows that PR item's status (e.g. `PR #12 · green · 1/3`). The JSON keeps `state` (now the queue status name) and adds the PR status field. Completion summary unchanged. Derived statuses are **not** exposed to `done_when`.
- **`queue`**: unchanged.

`StepResult` keeps its JSON shape (`actions`, `escalations`, `report`, `busy`, `dry_run`). Executed actions keep R6a's past-tense kinds (`spawned`, `respawned`, `cherry-picked`, `armed`, `merged`, `disarmed`, `paused`, `done`, `pr-tracked`); under `--dry-run` each `Decision` is rendered as an action carrying the row id and the typed action name (e.g. `dry-run: spawn ab12 (Q2)`; waits are not listed).

### 7. Intentional deltas (each with a test)

1. **Armed is derived** from `autoMergeRequest`; `stop` and `halt` disarm **every** armed PR in the halted cone, including one armed by a person (R6a disarmed only PRs carrying its own marker).
2. **Repo auto-merge** is read from `autoMergeAllowed`; a repo without it merges on `green` via P7 (no `direct` key, no failed arm attempt first, no `auto-merge is disabled on this repo` escalation).
3. **A halt writes `halted` on one item**; the cone is derived through `depends_on`, so clearing `halted` on that one item resumes the cone.
4. **A failed or conflicting PR is not armed first**: status is derived before any arm, so P5 escalates without arming (R6a armed, then escalated on a later pass and left it armed).
5. **A sequence advances one PR per pass**: P1 records a merge; the successor is observed and armed/merged on the next pass (R6a's `continue` loop merged-then-armed within one pass).

### 8. `track rm` refusal of armed PR items (`internal/operator/ownership.go`)

`armedPRItem` refuses `track rm` of a `github-pr` item whose `scope.armed` is true. Once the engine stops writing `armed`, that refusal would silently go inert. Proposed (see Assumption 7): widen it to refuse `track rm` of any not-done `github-pr` item with `scope.merge_seq` set (an engine sequence PR that may be armed), `--force` still overrides, message names `gh pr merge --disable-auto`. R6r-ii deletes the refusal with the allow-list.
<!-- assumed: widen the track-rm armed refusal to any not-done sequence PR item — the plan's "nothing outside it reads the key" is false (ownership.go armedPRItem reads it) -->

### 9. Tests

- **`decide` table test (rule 6)** — no git, no `gh`, no tmux: enumerates every reachable (item kind × merge mode {`cherry-pick-ladder`, `merge-auto`, `stacked-prs`} × status) plus each guard's true/false side, and asserts the row that fires or an explicit `wait`. A reachable combination with no outcome fails the test (e.g. the test iterates every status constant, so adding a status without a row/wait fails).
- **Derive tests** — status precedence per table (e.g. `merged` beats `halted`; halted cone through cross-repo `depends_on`; `conflicting` needs `unchanged ≥ 3`).
- **Executor tests** — against real temp repos (spawn, cherry-pick ladder, respawn) and the scripted runner fake (`gh`, `fab`), as today.
- **Delta tests** — one per § 7 item.
- **R6a behaviour tests stay green** (`lifecycle_test.go`, `merge_test.go`, `escalation_test.go`, `revised_rules_test.go`, `spawn_test.go`, `spawning_test.go`, `gate_test.go`, `queue_test.go`, `durability_test.go`, `passlock_test.go`, `ownership_test.go`, `scopekeys_test.go`, `cmd/rk/operator_autopilot_test.go`), changed **only** where they assert one of the deltas, or a deleted marker (`armed`/`direct`/`stall_seen` writes) or multi-PR-per-pass advance. Scripted `gh pr view` fixtures gain `autoMergeRequest`; `gh repo view` fixtures gain `autoMergeAllowed`.
- `scopekeys_test.go`'s drift test keeps passing: no new key is written.
- Gates: `just test-backend` plus `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1` (from `app/backend`). Known host-only failures (`cmd/rk` `TestPortPinRowRealPolicyValues`, `rk/api` `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`) do not block.

### 10. Non-goals (review bar and plan rules 6–7, copied verbatim per plan rule 2)

**Review bar** (quote it in every review dispatch prompt):

> **Must-fix**: anything that can merge, arm, push, force-push or delete the wrong thing; lose or corrupt state-file data; launch a duplicate agent *under the single-writer rule*; crash the CLI; or break a requirement in the step's plan. **Should-fix** (does not block): failure cases the pass lock rules out, tmux pane-id reuse, missing escalations for read-only probes, and cosmetics. From R6r-ii, a finding that needs an external write to the engine file (a hand edit) is out of scope.

**Plan rule 6**:

> From R6r-i on, autopilot behaviour is added only as a status case, a rule row and an executor. A `decide` table test enumerates every reachable (item kind, merge mode, status) and asserts the row that fires, or an explicit `wait`. A behaviour outside the table, or a reachable combination with no outcome, is must-fix.

**Plan rule 7**:

> From R6r-ii on, the engine file is written only under the pass lock. A step never adds an engine key to a ledger item, and never reads a ledger item's `scope` for a decision beyond the projection keys listed in § Engine state file.

(Rule 7 binds from R6r-ii; for R6r-i its live half is: no new engine key on a ledger item.)

**Out of scope for R6r-i**:

- Engine state file, projection items, `rm` / `resume` verbs, deleting the scope allow-list (R28–R33), escalations-as-notes + `rk notify`, the mechanical pass in the run wrapper, judgment-only model runs, brief diet — all **R6r-ii**.
- `stale-base` status, row B1, `restack` executor, P7 for `stacked-prs` — **R6b**. The `stacked-prs` refusal in `merge` stays.
- `fixing` status, rows C1–C6, F1, `fix-request` / `recovery-spawn` / `rebase` / `untrack` — **R6c**. P5's `recovery needed` escalation stays.
- Any change to `brief_autopilot.md`, `brief_rules.md` or the chat skill. No new verb, no new scope key, no new CLI flag.
- Concurrency handling beyond the pass lock (overlapping passes, claims, CAS) and tmux pane-id reuse (accepted).
- Exposing derived statuses to `done_when`.

## Affected Memory

- `run-kit/operator-autopilot`: (modify) replace "Merge — cherry-pick-ladder and merge-auto" arm-durability / durable-disarm-retry / "Step order and escalations" text with the pass shape (observe → derive → decide → execute), the queue and PR status tables, the rule table (Q1–Q7, P1–P7 + explicit wait), the stored-vs-derived split (which `scope` keys are read; `armed`/`direct`/`stall_seen` tolerated on disk but not read or written), `merge`/`stop` as intent-then-one-pass, `status` showing derived status names, the five intentional deltas; supersede the "Unknown arm outcomes keep the marker" and "Disarm is retried until durable" design decisions with "Armed is derived" (new DD), and add DDs for the rule table / pure `decide` and one-PR-per-pass
- `run-kit/operator-state`: (modify) `track rm` refusal of an armed PR item → refusal of a not-done sequence PR item (if Assumption 7 holds); Scope ownership row notes `armed`, `direct`, `stall_seen` are no longer written by the engine

## Impact

- **Code**: `app/backend/internal/autopilot/` — `step.go`, `merge.go` (dissolved into derive/decide/executors; expect it to shrink substantially), `gate.go` (status derivation), `spawn.go` (loops removed, `spawnItem`/`respawn` become executors), `autopilot.go` (action/decision types), new files for the status derivation, the rule table + `decide`, and executors (file split is the apply agent's call). `app/backend/cmd/rk/operator_autopilot.go` — `renderStep` dry-run rendering, `status` line with PR status. `app/backend/internal/operator/ownership.go` — `armedPRItem` (Assumption 7).
- **Tests**: new `decide` table test and derive tests; existing autopilot tests adjusted only for the deltas; `gh` fixtures gain `autoMergeRequest` / `autoMergeAllowed`.
- **External calls**: one extra `gh repo view --json autoMergeAllowed` per repo per pass (cached); `autoMergeRequest` added to the existing `gh pr view` field list; `gh pr checks` now read for the head before arming (it was read only after arming).
- **No** UI, API, settings, brief, or CLI-surface change beyond `status`/`--dry-run` output text. PR evidence: `No recording: internal CLI/engine behavior`.
- **Reference**: `origin/261114-8w1x-r6-full-reference` is not needed for this step (R6b/R6c only).

## Open Questions

- `track rm` of a PR item: the plan says "nothing outside [the engine] reads the `armed` key", but `internal/operator/ownership.go` `armedPRItem` does (the `track rm` refusal). Widen the refusal (Assumption 7), let it go inert until R6r-ii deletes it, or keep writing `armed` solely for that refusal (contradicts the plan)?
- Q6's "queue open 2 h" half: R6a flags the oldest unfinished queue item whatever its state; the plan's Q6 only matches `spawned`. Assumption 9 picks a row split that keeps R6a's behaviour.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Engine shape observe → derive → decide (pure) → execute; one row per item per pass, first match; `step --dry-run` prints `decide`'s output | Binding plan decision "Engine shape" and § Pass | S:95 R:70 A:95 D:95 |
| 2 | Certain | Rows Q1–Q7, P1–P7 exactly as drafted; R6b/R6c rows and statuses (`stale-base`, `fixing`, B1, C1–C6, F1) not added | R6r-i brief "Rows: Q1–Q7, P1–P7 as drafted"; rule table's Step column | S:95 R:75 A:95 D:90 |
| 3 | Certain | State stays in ledger `scope`; no new key, verb, flag or brief change; `armed` no longer read or written; `direct` and `stall_seen` no longer read/written (tolerated on disk) | User instruction + R6r-i brief "Resolved" and "No brief change"; State-file keys table | S:95 R:80 A:90 D:90 |
| 4 | Certain | Review bar and plan rules 6–7 copied verbatim into non-goals and quoted in every review dispatch | User instruction + plan rule 2 | S:100 R:90 A:100 D:100 |
| 5 | Certain | The five intentional deltas (derived armed + cone-wide disarm, `autoMergeAllowed`, one-item halt with derived cone, no arm before failed/conflicting, one PR per pass), each with a test; other R6a tests stay green | R6r-i brief "Intentional deltas" and "Tests" | S:95 R:75 A:95 D:90 |
| 6 | Certain | `merge` and `stop` write intent then run one full pass; `merge` keeps its validations and the `stacked-prs` refusal; `stop` no longer depends on the armed marker | R6r-i brief "merge and stop write their intent, then run one pass"; refusal stays per brief | S:85 R:75 A:85 D:80 |
| 7 | Tentative | Widen `track rm`'s armed-PR refusal (`ownership.go` `armedPRItem`) to any not-done `github-pr` item with `merge_seq`, `--force` overrides; update `operator-state` memory | Plan claims nothing outside the engine reads `armed`, but the `track rm` guard does; letting it go inert would let a person drop an armed PR the engine could no longer disarm (review-bar "merge the wrong thing"). R6r-ii deletes the guard anyway | S:40 R:65 A:40 D:40 |
| 8 | Confident | Observe reads facts for each sequence head + predecessor **and** every unmerged PR item in a halted cone, so P3 can disarm any armed PR there each pass | Plan § Pass: "Row P3 covers every other armed item in the cone … on every pass, until GitHub reports it disarmed" requires observing them; cost bounded by queue size | S:70 R:75 A:75 D:65 |
| 9 | Confident | Split Q6: Q6a `spawned` + stage unchanged 30 min → escalate once; Q6b the oldest unfinished queue item (any non-terminal status, after every other queue row) + open 2 h → escalate once — keeps R6a's `flagSlow` behaviour | Plan allows splitting a row; drafted Q6 matches only `spawned`, which would drop R6a's flag for a held/pending oldest item ("behaviour stays R6a's") | S:45 R:85 A:55 D:40 |
| 10 | Confident | Observe keeps R6a's `operator.Observe` write of the head's `state`/`mergedAt`/`mergeable` (the `unchanged` clock); skipped under dry-run; the execute-time "changed" check fingerprints decision inputs, excluding `updated_at`/`last`/`unchanged`/`checked_at` | `conflicting` needs `unchanged ≥ 3`, which only that write advances; without the exclusion every observed item would self-invalidate | S:60 R:75 A:75 D:70 |
| 11 | Confident | `stacked-prs` PR items (unreachable via verbs: `merge` refuses) get P1–P3 normally and an explicit `wait` for every other status (P4/P6/P7 exclude `stacked-prs`) | R6b owns stacked merge; never act destructively on a stacked PR; rule 6 needs an explicit outcome for every combination | S:65 R:80 A:75 D:65 |
| 12 | Confident | Escalate-once rows use the existing `scope.escalated` map; P5's dedupe key includes the head SHA; Q3 now escalates once instead of every pass | State-file keys table: `escalated` becomes every escalate-once row's key, `stall_seen` folds into it | S:75 R:85 A:80 D:75 |
| 13 | Confident | `StepResult` JSON shape unchanged; executed actions keep R6a's past-tense kinds; dry-run renders each decision as an action with typed action + row id; waits not listed | No new CLI surface per brief; the interim brief tells runs to act on `step` output, so keep its vocabulary | S:60 R:85 A:70 D:65 |
| 14 | Confident | `status` shows queue status names in `state` and adds the PR item's derived status; JSON adds a PR-status field | R6r-i brief "`autopilot status` shows the derived status names" | S:75 R:85 A:80 D:70 |
| 15 | Certain | `arm` failure of any kind escalates and relies on next-pass observation; `definitiveArmRejection` and the rejection fallbacks are deleted | Armed is derived, so no marker to keep or clear; P7 replaces the fallbacks per brief | S:80 R:75 A:85 D:80 |
| 16 | Confident | No change to `brief_autopilot.md` text even though its `conflicting` row says the PR "stays armed" (now it may never have been armed) | Brief explicitly "No brief change"; R6r-ii deletes the brief | S:70 R:85 A:75 D:70 |

16 assumptions (7 certain, 8 confident, 1 tentative, 0 unresolved).
