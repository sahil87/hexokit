# Operator autopilot — restructure R6, migration plan for the remaining steps

> Plan doc, written 2026-11-16. It amends step **R6** of
> `fab/plans/sahil/26-11-10-operator-to-hexokit.md` (the parent plan) and re-plans every step
> still open after C1: R6, R7, M1, F2. The parent plan's "Decisions already taken" table and its
> "Rules for the operator executing this plan" still bind, except where this doc replaces them.

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

## Decisions (binding for R6a–R7)

| Decision | Choice | Why |
|---|---|---|
| Concurrency model | **Single writer.** `rk operator autopilot step`, `merge` and `stop` take an exclusive, non-blocking, per-server pass lock (`flock` on `<state>/hexokit/operator/<slug>.autopilot.lock`) for the whole pass. A second caller exits 0 with result `busy` and does nothing | Removes the whole "two passes overlap" class (spawn/respawn/recovery claims, CAS snapshots). The R5 loop already runs one run at a time per server. The OS releases a `flock` when the process dies, so a crash never leaves the lock held (Constitution II) |
| State-file lock | Unchanged. The store's sidecar lock is still never held across a subprocess, and writes still merge by item id (external writes win) | The pass lock serialises autopilot passes only. `rk operator track`, `rk operator check` and the daemon keep writing concurrently |
| Split | R6 becomes **R6a** (core), **R6b** (stacked-prs merge-all) and **R6c** (PR recovery) | Each lands and is reviewable on its own. R6b and R6c can run in parallel after R6a |
| Brief migration | Each step **replaces the brief section it covers in the same PR**, with "run `rk operator autopilot step` and act on its escalations". R7 then only deletes the emptied file | No window where the brief and the engine both claim the same job; the run calls the engine as soon as a part exists |
| Review bar | **Must-fix**: anything that can merge, arm, push, force-push or delete the wrong thing; lose or corrupt state-file data; launch a duplicate agent *under the single-writer rule*; crash the CLI; or break a requirement in the step's plan. **Should-fix** (does not block): failure cases the pass lock rules out, tmux pane-id reuse, missing escalations for read-only probes, and cosmetics | The R6 reviews were correct but unbounded. A written bar lets review converge. Each step's intake carries this bar as an explicit non-goal list, and each review dispatch prompt quotes it |
| `merge_mode` location | Unchanged from R6 intake: rk settings key `operator.merge_mode`; fab's `autopilot.merge_mode` is never read | Decided with the user at R6 intake |
| Prior work | Kept, not thrown away. The full-scope engine is preserved on local branch **`261114-8w1x-r6-full-reference`** (commit `e99ca698`). R6a shrinks that code in place; R6b and R6c **port** their parts from it (read, adapt to the single-writer model, re-test), never cherry-pick blind | About 70 % of the code is reusable. The rest was written for the concurrency model this doc drops |
| Daemon-driven `step` | Still a non-goal. Candidate step R8, decided after M1's numbers | Unchanged from R6 intake |

---

## Current state (verified 2026-11-16)

- **Merged to `main`**: R1 State Engine (#1120), R2 Check (#1129), R3 Operator Tasks (#1130), R4 Run
  Brief + Chat Skill (#1128), R5 Operator Loop (#1132), plus #1134 (explicit server for runs).
- **C1**: complete (per the user, 2026-11-14). F1 shipped as part of C1's release.
- **M1**: not verified from this repo. Check the measurement notes before scheduling F2.
- **R6**: change `261114-8w1x-operator-autopilot-go`, branch of the same name, draft PR #1135.
  Re-scoped to **R6a** by this doc. Its `.status.yaml` has been reset to `intake: active`, but
  its `intake.md` and `plan.md` still describe the full R6 scope. Rewriting them is the first
  R6a task (see "Picking this up" below). The branch carries the full-scope code; R6a removes
  what moves to R6b/R6c.
- **Reference branch**: `origin/261114-8w1x-r6-full-reference` (commit `e99ca698`), the full-scope
  engine after the second review run, with its `plan.md` (requirements R1–R28, tasks T001–T032).
- **Interim brief**: `app/backend/internal/operator/brief_autopilot.md` (sections: Items and
  readiness · Spawning a queue item · Merging · PR recovery · Failures and timing) is still what
  runs execute.
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
   `git fetch origin 261114-8w1x-r6-full-reference && git show origin/261114-8w1x-r6-full-reference:<path>`.
   They never merge or cherry-pick that branch. Delete it (local and remote) after R7 merges.
5. Each step proves its brief swap: a test renders the brief and asserts the replaced section is
   gone and the `step` instruction is present.

---

## Picking this up (hand-off for the next agent)

Everything below is reproducible from this file, the parent plan, the R6 PR branch and the
reference branch. No conversation context is needed.

### Where things stand

| Item | State |
|---|---|
| Change | `fab/changes/261114-8w1x-operator-autopilot-go/` on branch `261114-8w1x-operator-autopilot-go` (worktree `hexokit.worktrees/r6-autopilot-go` on loom2) |
| Pipeline | `intake: active`; every later stage `pending` |
| `intake.md` | Still the full R6 scope, with a `## Clarifications` section of decisions the user confirmed. Those decisions still hold (see table below) |
| `plan.md` | Still the full R6 plan (R1–R28, T001–T032). Delete it so apply regenerates it from the re-scoped intake |
| Code on the branch | Full-scope engine: `app/backend/internal/autopilot/` (about 3,900 lines plus 4,360 of tests), `cmd/rk/operator_autopilot.go`, `internal/settings` `operator.merge_mode`, `internal/riff` additions, `internal/operator/export.go`, chat-skill text in `cmd/rk/skill/operator.md` and `docs/site/skill/operator.md` |
| PR #1135 | Draft. Its title and body describe the full scope; retitle once R6a's intake is rewritten |

### Decisions from R6 intake that carry into R6a

| Decision | Source |
|---|---|
| `merge_mode` lives in rk settings as `operator.merge_mode`; fab's `autopilot.merge_mode` is never read | User, R6 intake |
| Mode resolution `--mode` > setting > `cherry-pick-ladder`, resolved once at `queue` and stamped on every item; an invalid value is an error | Parent plan + R6 intake |
| Verbs `rk operator autopilot` `queue` / `step` / `merge` / `stop` / `status`; `queue` takes a JSON array on stdin; `step` is one idempotent pass and no verb waits for CI | User, R6 clarify |
| `stacked-prs` spawns cut the dependent's branch from the SHA of `origin/<dep-branch>`, never `wt create --checkout` | User, R6 clarify |
| Engine is called by runs and chat; the daemon does not call it (R8 candidate) | R6 intake |
| Spawn reuses `internal/riff` in-process; the engine never notifies (returns escalations); no MCP tools | R6 intake |
| Git tested against real temp repos; `gh`/`fab` through a scripted runner fake; `main_test.go` pins git identity | R6 intake + CI fix |

### What the last R6 review left open (all addressed by the R6a brief)

1. Pane liveness keyed only by tmux pane id (recycled ids). R6a: **accepted** under the review bar.
2. A transient disarm failure leaves a PR `halted` and `armed`, and later passes skip it. R6a:
   **must fix**. The halt path and `stop` retry the disarm until it is durable.
3. `operator.RecordPanePID` has no callers. R6a: **delete it**.

### Steps for the agent picking up R6a

```sh
cd <hexokit worktree on branch 261114-8w1x-operator-autopilot-go>
fab change switch 261114-8w1x-operator-autopilot-go
# 1. rewrite intake.md for the R6a scope (brief below), keeping the carried decisions
#    and the review bar as explicit non-goals
# 2. remove the full-scope plan so apply regenerates it
git rm fab/changes/261114-8w1x-operator-autopilot-go/plan.md
fab score --stage intake 8w1x
fab status advance 8w1x intake
# 3. run the pipeline
/fab-fff 261114-8w1x-operator-autopilot-go
```

Pipeline notes from R6:

- **Review** resolves to `codex` / `gpt-5.6-sol` at `xhigh` on the pane rung. Quote the review bar
  in the dispatch prompt. Two review panes died without a result during R6 (state `orphaned`).
  The one automatic `fab dispatch restart` recovered both times.
- **Apply on codex** (optional, what the second R6 run used): prefix the dispatch with
  `FAB_AGENT_WORKERS=codex`, e.g. `FAB_AGENT_WORKERS=codex fab dispatch open 8w1x apply`. It
  resolves to `gpt-6-astra` at `high`, scoped to that one dispatch, with no config change.
- **Gates**: `just test-backend` plus
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 go test -race ./internal/autopilot/ -count=1`
  (CI has no git identity). The two known host-only failures under "Current state" do not block.
- **PR evidence**: the `operator.merge_mode` row renders on the settings surface. Capture
  desktop + mobile screenshots per Constitution § PR Evidence; everything else is
  `No recording: internal CLI/engine behavior`.

R6b and R6c start as new changes with `/fab-new`, using their brief below as the description
and this file's path.

---

## Steps and dependencies

| ID | Repo | Step | Depends on | Size | Gate |
|---|---|---|---|---|---|
| **R6a** | run-kit | Autopilot core: queue, readiness, spawn (all three modes), dependency code, merge-all for `cherry-pick-ladder`, `merge-auto`, `stop`, `status`, single-writer pass lock; brief swap for the sections it covers | C1 | L | — |
| **R6b** | run-kit | `stacked-prs` merge-all: step-driven direct merge, base retarget, `rebase --onto` + force-push; brief swap | R6a | M | — |
| **R6c** | run-kit | PR recovery: `ci-failed` fix round, `conflicting` rebase + re-arm, recovery spawn; brief swap | R6a | M | — |
| **R7** | run-kit | Delete the emptied `brief_autopilot.md`, its embed and brief section; delete the reference branch | R6b, R6c | S | — |
| **M1** | — | Measure one week vs baseline (unchanged from the parent plan) | C1 | S | — |
| **F2** | fab-kit | Delete fab's operator code, skill and docs (unchanged), and retire fab's `autopilot.merge_mode` key | C1 + 1 release, R7 | M | **user gate** |
| *R8* | run-kit | *Candidate:* the daemon loop calls `step` before deciding to launch a model run | M1, R7 | S | **user gate** |

```
C1 ──┬── R6a ──┬── R6b ──┐
     │         └── R6c ──┴── R7 ──┐
     └── M1 ─────────────────────┴── F2
                                  └── R8 (candidate, after M1)
```

### Brief section migration

| `brief_autopilot.md` section | Replaced by | Interim behaviour until then |
|---|---|---|
| Items and readiness | R6a | — |
| Spawning a queue item (all three modes, incl. the `stacked-prs` base and `set-base-branch`) | R6a | — |
| Merging: `cherry-pick-ladder` merge-all, `merge-auto` arm-on-ship | R6a | — |
| Merging: `stacked-prs` merge-all | R6b | The run follows the brief text; `rk operator autopilot merge` refuses `stacked-prs` sequences with a message pointing at it |
| PR recovery | R6c | `step` reports a failed required check or `CONFLICTING` as an escalation `recovery needed: <reason>` and leaves the PR armed; the run follows the brief text |
| Failures and timing | R6a (all rows except the recovery ones), R6c (recovery rows) | — |

### State-file keys

All new keys live in tracked items' opaque `scope`. Reads are tolerant and nothing is moved on
disk, so no data migration is needed between steps. Keys a step stops using are ignored by
later code, never rewritten.

| Key | Introduced by | Meaning |
|---|---|---|
| `queue` | R6a | Queue id stamped by `autopilot queue`; queue membership |
| `merge_mode` | R1 (existing) | Mode stamped on every queue item; null reads as `cherry-pick-ladder` |
| `spawning` | R6a | Intent marker written before a launch; a pass that finds it without a pane escalates and never relaunches on its own |
| `respawned` | R6a | The one respawn has been spent |
| `armed`, `halted` | R6a | Auto-merge armed (written before `gh pr merge --auto`); sequence halted |
| `merge_seq` | R6a | Repo sequence id on `github-pr` items |
| `prepared` | R6b | Stacked successor retargeted and rebased; merge waits for the next pass |
| `recovery`, `fix_head`, `fix_item` | R6c | Recovery round markers |

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

### R6b — `stacked-prs` merge-all (run-kit)

- Port from the reference branch: `stackedStep`, `prepareStacked`, the retarget and
  `rebase --onto` + `--force-with-lease` code, and their tests (`merge.go`, `merge_test.go`).
- Behaviour per fab-operator §6 Ordered Merge: never arm a stacked PR; ready a draft; direct-merge
  only when required checks are green on the *current* head; after a squash merge, verify or
  perform the base retarget, then rebase the next branch and force-push; merge waits for the next
  pass after any mutation (`prepared`). A rebase conflict halts and escalates, never skips.
- Remove `merge`'s stacked-prs refusal; brief swap for the stacked part of "Merging".
- Single-writer model throughout; no claim machinery.

### R6c — PR recovery (run-kit)

- Port from the reference branch: `recovery.go` and its tests (`lifecycle_test.go`, the recovery
  cases in `merge_test.go`, `escalation_test.go`, `revised_rules_test.go`).
- `ci-failed`: one fix round per PR, `recovery`/`fix_head` written before acting, fix request to
  the authoring pane (found through rk's own pane-to-change lookup) or one recovery spawn when it
  is gone; the round stays open while required checks are pending or the head is unchanged;
  red on a new head, or 30 minutes with no push, halts the cone and disarms.
- `conflicting`: one rebase onto the default branch + `--force-with-lease` + idempotent re-arm;
  `CONFLICTING` again, or a rebase conflict, halts and escalates.
- Replace R6a's `recovery needed` escalation with the actions; brief swap for "PR recovery" and
  the recovery rows of "Failures and timing".

### R7 — Delete the interim brief (run-kit)

- Delete `brief_autopilot.md`, its `//go:embed` and the "Interim autopilot" section in
  `operator.RenderBrief`; update `docs/memory/run-kit/operator-brief.md`.
- Delete the local `261114-8w1x-r6-full-reference` branch.

### M1 — Measure

Unchanged from the parent plan. Add one measurement: run tokens on queue ticks before and after
R6a, since queue work is where the brief swap should cut cost.

### F2 — Delete fab's operator (fab-kit, user gate)

Unchanged from the parent plan, plus: retire fab's `autopilot.merge_mode` config key (rk owns
`operator.merge_mode` now) with a migration note in `src/kit/migrations/`.

### R8 — Daemon-driven `step` (candidate, user gate)

Only if M1 shows queue ticks are a material share of run cost: the loop calls
`autopilot.Step` before deciding to launch a model run, and launches a run only for escalations.
Decide after M1.

---

## Open decisions

| Step | Question |
|---|---|
| R6a | Exit code for a `busy` pass: 0 with `busy` in the result (proposed), or a distinct non-zero class |
| R8 | Whether the daemon may spawn agents and arm PRs without a model run at all |
