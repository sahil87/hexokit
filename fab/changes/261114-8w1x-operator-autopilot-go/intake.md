# Intake: Operator Autopilot in Go

**Change**: 261114-8w1x-operator-autopilot-go
**Created**: 2026-11-14

## Origin

> R6 from fab/plans/sahil/26-11-10-operator-to-hexokit.md: autopilot in Go (queue, readiness gate, spawn, dependency code, ordered merge, three merge modes cherry-pick-ladder/stacked-prs/merge-auto). Depends on C1, which is complete. Resolve the open decision on where merge_mode lives (rk settings vs reading fab config via the fab CLI) at intake.

Started with `/fab-new` and run interactively. The source plan is `fab/plans/sahil/26-11-10-operator-to-hexokit.md` (step **R6**). Its "Decisions already taken" table is binding and is not reopened here. The behaviour being ported is specified in fab-kit's legacy operator skill (`$(fab kit-path)/skills/_operator-legacy.md` §6: The pane Kind and Spawn Rules, Spawning an Agent, Dependency Resolution, Working a Change, Queues, Ordered Merge, Auto-Merge Choreography, PR Recovery). In this repo it exists only as condensed interim text: `app/backend/internal/operator/brief_autopilot.md`.

Two decisions were put to the user at intake, and both answers are binding:

1. **Where `merge_mode` lives** (the plan's open R6 decision): **an rk settings key**. It is a new `operator.merge_mode` entry in the `internal/settings` registry (`~/.config/hexokit/config.yaml`). rk never reads fab's `autopilot.merge_mode`, with no fallback and no dual-read, so F2 can retire that fab key. Rejected: "rk setting + one-release fab fallback via `fab config show --json`" (extra code plus a temporary fab dependency), and "keep reading fab's key via the fab CLI" (fab would keep a key for a feature it no longer owns, and the setting would do nothing without fab).
2. **PR Recovery scope**: **port it in R6**. The `ci-failed` fix round and the `conflicting` rebase + re-arm become Go actions, so R7 can delete the whole interim autopilot text. This makes R6 larger, accepted knowingly.

## Why

**Problem.** After C1 the operator runs as fresh, short headless runs (R5's loop) driven by a run brief (R4). Autopilot (queues, dependency chaining, spawning, ordered merge, PR recovery) still exists only as ~180 lines of interim prose in `brief_autopilot.md`, and every run that touches a queue re-interprets it. That prose is the riskiest text an LLM run executes:

- It drives **destructive-tier** git/gh operations: cherry-picks, `git push --force-with-lease`, `gh pr merge --auto --squash`, `gh pr edit --base`, `gh pr merge --disable-auto`.
- Its correctness depends on **sharp edges** a model can get subtly wrong. Examples: pass the base as a **SHA, never a ref** (a remote-tracking start point sets upstream tracking); a failed `git fetch` must **stop** the spawn (falling through to `rev-parse` silently returns the stale `origin/<default>`); prune same-repo deps whose branch is an ancestor of another dep's branch before cherry-picking; arm at most one PR per repo sequence; disarm only the halted dependency cone.
- It also inflates every run's brief, against the plan's cold-cache budget of ≈ 10–15K tokens.

**If we don't.** R7 (trim the brief) and F2 (delete fab's operator) stay blocked. Every queue keeps paying model tokens to re-derive deterministic git/gh choreography, and a misread of the prose can merge the wrong PR, cut a stale base, or leave an orphaned armed PR that merges unattended.

**Why this approach.** The plan's Ownership decision puts autopilot in HexoKit: it is git/gh/wt orchestration whose only fab touchpoints are `.status.yaml` reads, `fab status set-base-branch`, and fab skills used as spawn prompts. Run-kit Principle III forbids reimplementing *change management*, not orchestrating branches and PRs. Putting it in Go gives deterministic, unit-tested behaviour for every sharp edge. Runs and chat then call a few verbs instead of executing prose. The queue state stays **the tracked items themselves** (no new queue store), so a fresh daemon or run re-orients from the state file alone (Constitution II).

## What Changes

### 1. New package `app/backend/internal/autopilot`

A deterministic engine over the existing operator state (`internal/operator`: `TrackedItem`, `State`, `BranchMap`, the store's sidecar lock + atomic write). It has no in-memory queue state. Every verb loads the state file, derives what to do, acts, and writes back under the store's lock using the existing tolerant-read/typed-write contract (external writes win). The lock is **never held across a subprocess**, the same discipline `operator.Check` uses (load → release → act → re-lock → merge by item id → write).

Subprocess seams follow `internal/fabsysconfig`: a `Runner` interface (`git`, `gh`, `wt`, `fab`). Every exec is an argv slice through `exec.CommandContext` with a timeout (Constitution I and Process Execution). Suggested bounds: `git fetch` 60 s, other git 30 s, `gh` 30 s, `wt create` 30 s (build-class), `fab` 10 s (matches `fabsysconfig.FabTimeout`). Tests inject a scripted fake runner for gh/fab. Git behaviour is tested against **real temporary git repos** (bare origin + clones) so SHA pinning, upstream tracking, ancestry and cherry-pick conflicts are exercised for real.

#### 1a. Queue model (no new state)

A queue is N `pane` tracked items chained by `depends_on`, as today:

- An item with no `scope.pane` is **unspawned**.
- `scope.merge_mode` is stamped on **every** item of the queue at enqueue time. `null` is read as `cherry-pick-ladder` for backward compatibility with items created before this change by `rk operator track add --mode`.
- Per-item derived state, consistent with `listState` in `internal/operator/track.go`: `done` › `paused` › `held` (any `depends_on` unsatisfied) › `pending` (unspawned, deps satisfied) › `spawned`.

**Implicit chaining** (queue ordering "user-provided"): every entry after the first gets `depends_on: [<nearest earlier entry in the same repo>]`. When no earlier entry shares its repo, it depends on the immediately previous entry, which is cross-repo and therefore ordering-only. Explicit `depends_on` given on an entry replaces the implicit one. In `merge-auto` implicit chaining is **disabled**: each entry depends on the previous entry as an ordering barrier only, its code is based on `origin/<default>` independently, and the next spawn waits for the previous PR's **verified merge** (see §1e).

Worked example: the chain `ab12 (repo foo) → cd34 (repo bar) → ef56 (repo foo)` yields `cd34.depends_on=[ab12]` (cross-repo barrier, no code moves) and `ef56.depends_on=[ab12]` (same-repo, cherry-picked). Queue order still runs `ef56` after `cd34`.

#### 1b. Readiness gate ("dependency satisfied")

A `depends_on` entry is satisfied when the dependency item is **done**:

- **fab change pane item**: `.status.yaml` shows `ship` done/skipped, or the item's `scope.stop_stage` is reached (the existing built-in completion, persisted as `done_at`).
- **Change-less (plain-agent) pane item**: its branch has an **open PR whose required checks pass**, or a merged PR (`gh pr view <branch> --json url,state,statusCheckRollup`). The engine persists `done_at` when it observes this, as durable evidence.

**Plus**, for a **same-repo** dependency with a null `stop_stage`, its PR must exist (`gh pr view <dep-branch> --json url` succeeds). Tracking, a `branch_map` entry, or a minted branch are **not** satisfaction.

A dep that has left the tracked list and survives only in `branch_map` (removed on its own `done`) passes the gate. A dep id found in neither place is unsatisfied, matching today's `heldDep`. A **bare** item (no task) can never satisfy a dependent, so the queue verb rejects any `depends_on` that names a bare entry.

**Repo classification**: a dep is same-repo when its `scope.repo` (or its `branch_map[<id>].repo`) equals the dependent's `scope.repo` after path cleaning. Otherwise it is cross-repo: an ordering-only barrier in every mode, and no code moves across repos.

#### 1c. Spawn sequence (one pending item)

1. **Target repo** = the item's `scope.repo` (an absolute main-worktree root), never the operator's own repo.
2. **Fetch first, pin the base.** In the repo root run `git fetch origin`. **A failed fetch is a hard stop**: no `wt create`, the item stays `pending`, and the result carries an escalation line (retried on the next invocation). Resolve the default branch by the chain `git symbolic-ref --short refs/remotes/origin/HEAD` (accepted only if `refs/remotes/origin/<it>` verifies) → `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` → `main` if `origin/main` exists, else `master`. Then `base_sha=$(git rev-parse origin/<default>)`.
3. **Confidence gate** (existing fab change only): when the change's `.status.yaml` carries a confidence score below fab's flat 3.0 intake gate, do not spawn. The item stays `pending` and the result escalates ("below confidence gate"). Raw-text entries have no score yet and skip the gate.
4. **Worktree.** Reuse `internal/riff` (`riff.Spawn` / `riff.Options`), the existing wt + tmux window + launcher engine, rather than shelling out to `rk tab new`. `WorktreeName` is the item id and `WorktreeBase` is the **SHA**, never the ref name, so the new branch has no upstream tracking. For a fab change the change folder name rides as wt's positional branch argument. riff gains whatever small extensions the engine needs (for example an existing-branch `--checkout` route for respawn and conflict recovery when the worktree is gone, and the spawn-prompt composition below). Those are additions; current riff callers stay byte-identical.
5. **Dependency code**, by mode, for the same-repo subset (the cross-repo subset is gate-only):
   - **`cherry-pick-ladder`**: resolve each dep's branch from the dep item's `scope.branch`, else `branch_map[<dep>].branch`. If any branch is missing, escalate and do not spawn. **Prune** a dep whose branch is an ancestor of another dep's branch (`git merge-base --is-ancestor A B`). For each remaining dep not already an ancestor of `HEAD`, run in the new worktree `git cherry-pick --no-commit origin/<default>..<dep-branch>` followed by `git commit -m "operator: cherry-pick <dep> dependency"`. **On conflict**: `git cherry-pick --abort`, write a note, escalate, and do not open the tab. The created worktree is rolled back (riff already has a rollback delete). Bounded retry is 0.
   - **`stacked-prs`**: no cherry-pick. The new branch is cut from the **SHA of `origin/<dep-branch>`** after the fetch (nearest same-repo predecessor). The dep's branch is not checked out, because the dep's worktree usually still holds that branch and git refuses a second checkout. <!-- clarified: user confirmed — stacked-prs uses --base <SHA of origin/dep-branch> instead of the legacy `wt create --checkout <dep-branch>` route — the dep's worktree normally still has that branch checked out, so --checkout would fail, and a SHA pin keeps the no-upstream-tracking rule --> The base branch is recorded for `/git-pr`. For an **existing** fab change, run `fab status set-base-branch <change> <dep-branch>` in the new worktree right after the worktree step. For a **raw-text** fab entry, append a trailing instruction to the rendered `fab-new` prompt: "after `/fab-new` creates the change, run `fab status set-base-branch <new-change> <dep-branch>`". For a **non-fab** plain agent, the PR instruction names the dep branch as the PR base.
   - **`merge-auto`**: no chaining. Base on `origin/<default>` independently.
6. **Pointer activation** (fab, existing change only, fail-soft): in the new worktree, when `fab resolve --folder <change>` succeeds, run `fab change switch <change>`. A failure logs one line and the spawn continues.
7. **Session command and prompt**: `fab agent default -o yaml --repo <repo>` (via riff's existing `ResolveAgent`) gives `command` and `skill_prefix`. **Always use the target repo's resolution.** Prompt by the two-axis table:

   | | task given | no task (bare) |
   |---|---|---|
   | `fab/` present (`test -d <repo>/fab`) | existing change → `<prefix>fab-fff <change>`; raw text → `<prefix>fab-new <text>` | no prompt token |
   | no `fab/` | `<task>` + `"\n\nCommit on this branch, push, and open a draft PR against <base>."` (`<base>` = the default branch, or the dep branch in `stacked-prs`) | no prompt token |

   Never `fab init`. Never send raw implementation text to a fab-project agent.
8. **Open the tab** via riff in the target tmux server and session. The landing session follows the same role-aware default `rk tab new` uses; reuse that resolver, never the ambient session or a persisted `scope.session`. Mark the window (`@rk_win_*` mark `auto` + note `"<id> · <stage>"`) through the existing tab-mark/note code paths.
9. **Attach**: update the existing pending item's scope (`pane`, `session`, `branch`), and add the `branch_map[<change-or-id>] = {branch, repo}` entry. This is one locked write, merged by item id.

**Respawn**: a spawned item whose pane died (the Check condition `pane_death` / `agent_exited` with the item not done) gets **one** respawn via the existing-branch route, recorded as `scope.respawned: true` before acting. After that it is skipped: note, escalate, and leave dependents held.

#### 1d. Ordered merge (`cherry-pick-ladder` and `stacked-prs`, on explicit user request)

Merging always happens on the user's "merge all" confirmation (the destructive-tier confirm is given once, in chat, for the whole sequence). The verb **starts** a sequence. Later `step` invocations **advance** it, so no CLI call ever foreground-waits for CI. The sequence state is a chain of `github-pr` tracked items, as today:

```
pr-<n>   kind github-pr, scope {repo, pr: n, change: <id>, merge_seq: <repo-seq-id>}, depends_on [pr-<n-1>]
```

These are per-repo sequences. Within a repo the order is base-first in dependency order. Across repos a dependent's PR merges only after its barrier dep's PR is merged.

- **`cherry-pick-ladder`** uses the **Auto-Merge Choreography**, all five rules:
  1. **Sequential arming**: at most one armed PR per repo sequence. PR_n is armed only after PR_{n-1}'s merge is **verified**, meaning its `github-pr` item is done (`state == "MERGED"`).
  2. **Arming-failure shapes**: a draft is readied first (`gh pr ready <n>`). An "already clean" rejection (no required checks) means merge directly with `gh pr merge --squash <n>`. Auto-merge disabled on the repo means fall back to the step-driven direct merge (below) for that sequence. `--squash` is always passed explicitly.
  3. **Stall rule**: a failed required check (`gh pr checks <n> --required --json name,state,link`, any `FAILURE`) means PR Recovery `ci-failed`. `unchanged ≥ 3` with no failed check and `gh pr view <n> --json mergeable` == `CONFLICTING` means PR Recovery `conflicting`.
  4. **The items are the sequence**. A restarted daemon or run resumes from `rk operator track list` alone.
  5. **Disarm on halt** (`gh pr merge --disable-auto <n>`) over the **halted cone only**: the failing repo's sub-sequence plus every repo whose items transitively carry a cross-repo `depends_on` into it. Independent sub-sequences keep going. A user **stop** is global and disarms everything.
- **`stacked-prs`** never arms. An armed stacked PR can merge into its dependency's *branch*, or fire on stale-green checks after a base retarget. A **step-driven direct merge** is used instead. On each `step`, when the next PR's required checks are green and `mergeable` is `MERGEABLE`, run `gh pr merge --squash <n>`. Then, before the next PR in that chain is mergeable:
  1. **Verify the base retarget**. GitHub auto-retargets when the merged base branch was deleted. Otherwise run `gh pr edit <next> --base <default>` (a plain branch name, never a remote ref).
  2. **Rebase after the squash merge**: `git fetch origin && git rebase --onto origin/<default> <merged-dep-branch> <next-branch> && git push --force-with-lease`, in the next change's worktree (the live pane's, else an existing-branch worktree created through `internal/riff`/wt). **A conflict halts and escalates, never skips** (`git rebase --abort`).
- **Unreviewed merges**: for every PR merged during a step with no non-`PENDING` review (`gh pr view <n> --json reviews`), the step's report marks it `· unreviewed` and adds one summary line `merged without review: #n (<change>), …`. This is never silent and never a prompt.
- **Report lines** per merge include the repo and position, e.g. `ab12: merged (foo 1/2)`.

#### 1e. `merge-auto` (merge as you go)

When a queued item ships, the next `step` creates its `github-pr` item and arms it. The arming follows rule 2's shapes; `merge-auto` is a one-PR sequence per item. The next queue item (whose ordering barrier is this item) stays `held` until that PR's merge is **verified**. Only then is it spawned, and its spawn's fetch + SHA pin puts it on the advanced `origin/<default>` tip. There is no separate pre-spawn rebase. A halt in `merge-auto` disarms this one PR and escalates. The next spawn stays deferred until the user acts.

#### 1f. PR Recovery (ported per the user's decision)

There is one bounded action per reason, and the marker is persisted **before** acting (`scope.recovery` on the `github-pr` item, merged per key). That way a restarted run can tell an already-recovered item from a first sighting.

| Reason | Detected by | One action | Then |
|---|---|---|---|
| `ci-failed` | rule 3's failed required check (or the stacked-prs step's red checks) | Write `scope.recovery="ci-fix"` and `scope.fix_head=<headRefOid>`. Then send the **authoring pane** the fix request below through the existing injection engine (the same path `rk mux send` uses). The PR **stays armed**. Pane gone: **one** recovery spawn via the existing-branch route with the same text, tracked as change-less `<change>-fix` (removed when the round resolves) | Green means continue, and the merge report appends `· after CI fix round`. Red on a head ≠ `fix_head`, or 30 min with no new push: halt the cone, disarm (rule 5), escalate with the agent's one-line diagnosis |
| `conflicting` | rule 3's `unchanged ≥ 3`, no failed check, `CONFLICTING` | Write `scope.recovery="rebase"`. In the change's worktree (the live pane's, else an existing-branch worktree): `git fetch origin && git rebase origin/<default> && git push --force-with-lease`, then re-arm `gh pr merge --auto --squash <n>` (an "already enabled" rejection is fine). Recoverable tier: announce, no confirm | `CONFLICTING` again with `recovery == "rebase"`, or the rebase itself conflicts (`git rebase --abort`): disarm, halt the cone, escalate naming the files |

The fix-request text is sent verbatim in one Enter-terminated send with no skill prefix:

```
CI failed on PR #<n> (<repo>): check `<check name>` — run <run link>[, shard S/N].
Diagnose and fix on this branch, push, and report the root cause in one line.
```

The **authoring pane** is found by change, never by memory: the pane whose derived fab change equals the `github-pr` item's `scope.change`. rk already derives a change per pane from cwd + `.status.yaml` (`internal/sessions/fabstate.go`); reuse that and do not call `fab pane map`.

#### 1g. Failures and timing

| Event | Action |
|---|---|
| Review exhausted (fab change parked at review fail) | Escalate; dependents stay held. The user decides (skip = `track rm`) |
| Ship-stage rebase conflict (worker STOPped) | Escalate; in `merge-auto` the queue continues with the next independent item, in chained modes dependents stay held |
| Cherry-pick conflict / `stacked-prs` rebase conflict | Escalate, **never skip** |
| Pane died | One respawn, then skip (escalate) |
| Stage over 30 min / queue over 2 h | Note + escalate (flag only) |

An **escalation** is a structured line in the verb's result (and a note on the item) that the caller (run or chat) turns into `rk notify` per the run rules. The engine itself never notifies.

### 2. CLI: `rk operator autopilot` family (`app/backend/cmd/rk/operator_autopilot.go`)

<!-- clarified: user confirmed — verb family name and shapes — `rk operator autopilot queue|step|merge|stop|status`, JSON-stdin queue entries; plan names the capability, not the CLI -->

All verbs take `-L/--server` (default: the caller's own server from `$TMUX`, as other `rk operator` verbs do) and `--json` (the standard `{"ok":true,"result":{…}}` envelope). Exit codes follow the `rk operator track` classes: 0 ok, 1 operational, 2 usage/invalid. Help text conforms to the shll toolkit standards (help-dump, examples, exit codes).

- **`rk operator autopilot queue [--mode <m>] [--by user|run|chat] [--dry-run] [--json] < entries.json`**
  Persists a queue as N pending `pane` items in one locked write. Entries arrive as a JSON array on stdin; agents are the callers, and the user confirms in chat first:
  ```json
  [
    {"id": "ab12", "repo": "/home/u/code/foo", "change": "ab12"},
    {"id": "fix-login", "repo": "/home/u/code/bar", "task": "fix login after password reset"},
    {"id": "ef56", "repo": "/home/u/code/foo", "change": "ef56", "depends_on": ["ab12"], "stop_stage": null}
  ]
  ```
  It resolves the mode by the ladder **`--mode` flag > `operator.merge_mode` setting > `cherry-pick-ladder`**, stamps it on every item, and prints `mode: <name> (flag|setting|default)`. An **invalid** setting value is an error naming the valid set (destructive tier, no silent fallback). It applies implicit chaining (§1a), validates repos are absolute git roots (Constitution I: validate before exec), rejects deps on bare entries, and rejects duplicate ids. It **reports** (in the receipt, `misfit: …`) the two mode misfits so the caller asks the user: (1) `merge-auto` with explicit same-repo `depends_on` entries; (2) left to the caller, since it is about the user's words.
- **`rk operator autopilot step [--by run|chat] [--dry-run] [--json]`**
  Runs one idempotent pass over the server's tracked items in this order:
  - (a) persist newly observed `done_at` for change-less items
  - (b) advance every in-progress merge sequence (verify merges, arm next, stacked-prs merge/retarget/rebase, `merge-auto` create + arm)
  - (c) detect stalls and run recovery actions
  - (d) spawn every `pending`, unpaused queue item whose gate passes, in queue order
  - (e) emit escalations
  The output lists actions taken (`spawned`, `cherry-picked`, `armed`, `merged`, `retargeted`, `rebased`, `disarmed`, `recovery-sent`) and escalations. `--dry-run` reports the plan with no side effects.
- **`rk operator autopilot merge [--repo <path>] [--json]`**
  Starts the ordered merge for completed `cherry-pick-ladder` / `stacked-prs` queues (all repos, or one repo). It creates the `github-pr` chain items and arms or merges the first PR per sequence. It refuses when queue items are not yet done, and it is a no-op for `merge-auto` items.
- **`rk operator autopilot stop [--json]`**
  Global user stop: disarm every armed PR (`gh pr merge --disable-auto`) and pause every unspawned queue item (`paused: true`). Live panes are left untouched.
- **`rk operator autopilot status [--json]`**
  Read-only queue view: per item the derived state, mode, repo, branch, PR, merge-sequence position and recovery marker, plus the Queue Completion Summary when all items are done:
  ```
  Queue complete. 3 PRs ready for review:
  1. ab12: <PR-URL-1> (~/code/foo, base)
  2. cd34: <PR-URL-2> (~/code/bar, ordering-only after ab12)
  3. ef56: <PR-URL-3> (~/code/foo, depends on ab12)
  Merge per-repo: foo 1→3, bar 2 (after foo:1 reaches main). Or ask me to merge all.
  ```

`rk operator track add --mode` keeps working unchanged (it stores `scope.merge_mode` on one item). The queue verb is the supported way to create queues.

### 3. Settings: `operator.merge_mode`

A new registry entry in `app/backend/internal/settings/settings.go`, next to `gui.*` / `openai_mcp.*`:

```yaml
# ~/.config/hexokit/config.yaml
operator:
  merge_mode: cherry-pick-ladder   # cherry-pick-ladder | stacked-prs | merge-auto
```

- Kind: enum string. Valid values are `operator.MergeModes`. Default unset (absent), which resolves to `cherry-pick-ladder` with source `default`. Registry validation rejects an invalid value on write. A hand-edited invalid value surfaces as the queue verb's error.
- It is read **only at enqueue time** (`queue`). Runs and `step` never resolve config; they read the stamped `scope.merge_mode`. This matches the interim brief rule "a run never resolves config".
- Because the settings surface is registry-driven, the key appears in the existing single settings surface (Constitution IV carve-out, no new page). It is also reachable through the palette's existing settings path if the registry exposes entries there. This is the only UI-visible part of the change.
- `merge-auto` is never a default the engine picks on its own. It is only ever the result of the user's flag, the user's setting, or the user's message (Merge authority decision in the plan).

### 4. Chat skill text (`rk skill operator` topic)

Update the static chat-skill topic so chat creates queues through `rk operator autopilot queue` (confirm upfront, with the mode stated in the confirmation line: "creates PRs — merge after review" / "merges PRs on completion" / "creates stacked PRs — merge after review"). "merge all" maps to `rk operator autopilot merge`, and "stop" to `rk operator autopilot stop`. The mode question (glyphs `▂▄▆` / `░▒▓█` / `▄▀`, the three box diagrams, one-line tradeoffs) is asked only on the two misfits. **The run brief's `brief_autopilot.md` is NOT edited in R6.** R7 replaces it with "call `rk operator autopilot step`".

### 5. Tests (`internal/autopilot/*_test.go`, `cmd/rk/operator_autopilot_test.go`)

Every sharp edge from fab-operator.md §6 is covered. Git tests use real temp repos (bare origin + clone + `wt`-equivalent worktree setup via the runner seam); gh and fab use scripted fakes, so no test reaches a real binary for those.

- **Stale base**: the main checkout's local HEAD lags `origin/<default>`, yet the spawned branch starts at the fetched tip SHA.
- **Fetch failure**: no `wt create` is issued, the item stays `pending`, an escalation is emitted, and `rev-parse` is never consulted.
- **Upstream tracking**: the spawned branch has no `branch.<b>.remote`/`merge` config, proving a SHA was passed, not a ref.
- **Default-branch chain**: dangling `origin/HEAD` → `gh` fallback → `main`/`master` probe; a non-`main` default (e.g. `trunk`).
- **Dep drift / ancestry**: a redundant dep is pruned; a dep already an ancestor of `HEAD` skips its cherry-pick; a transitive chain cherry-picks only the leaf.
- **Cherry-pick conflict**: abort, no tab, worktree rolled back, escalation.
- **Readiness**: a same-repo dep that is done but has no PR stays held; a dep only in `branch_map` passes; a cross-repo dep never cherry-picks; a missing dep branch escalates; a bare dep is rejected at enqueue.
- **Mode ladder**: flag > setting > default with the source printed; an invalid setting errors; `null` stored mode reads as `cherry-pick-ladder`; merge-auto with same-repo deps reports the misfit.
- **stacked-prs**: the branch is cut from the dep's tip SHA; `set-base-branch` is called for an existing change; the raw-text prompt carries the trailing instruction; merge-all retargets when the base branch survives; `rebase --onto` runs after the squash; a rebase conflict halts.
- **Auto-merge rules**: one armed PR per repo sequence; draft→ready; "already clean"→direct merge; auto-merge disabled→direct-merge fallback; disarm only the halted cone with an independent repo continuing; global stop disarms all.
- **merge-auto**: the next spawn is deferred until the merge is verified, then spawns on the advanced tip.
- **PR Recovery**: the marker is persisted before acting; one round per reason; red on a new head → halt; `CONFLICTING` again → halt; pane gone → one recovery spawn.
- **Concurrency**: an external write to the state file between load and write survives (merge by id); the lock is never held across a subprocess.
- **Unreviewed merge** reporting.

## Affected Memory

- `run-kit/operator-autopilot`: (new) the Go autopilot engine: queue model over tracked items, readiness gate, spawn sequence (fetch-first SHA pin, two-axis prompt table), dependency code per mode, ordered merge + Auto-Merge Choreography, merge-auto, PR Recovery, failure table, `rk operator autopilot` verbs, and the merge-mode ladder.
- `run-kit/operator-state`: (modify) the queue-stamped `scope.merge_mode` semantics, the `scope.recovery`/`fix_head`/`respawned`/`merge_seq` scope keys, `done_at` persistence for change-less items, and the pointer to the autopilot engine.
- `run-kit/operator-brief`: (modify) record that the interim autopilot section is now superseded by the engine (it stays in the brief until R7), and that the chat-skill topic routes queues through `rk operator autopilot`.
- `run-kit/configuration`: (modify) the `operator.merge_mode` settings-registry key and the decision that rk does not read fab's `autopilot.merge_mode`.
- `run-kit/rk-riff`: (modify) any spawn-engine extensions the engine needs (the existing-branch checkout route, prompt composition for autopilot spawns).
- `run-kit/toolkit-standards`: (modify) the help-dump/P9 new-surface check now covers `rk operator autopilot`.
- `run-kit/architecture/cli`: (modify) the new `rk operator autopilot` subcommand family.

## Impact

- **New**: `app/backend/internal/autopilot/` (engine, runner seam, tests); `app/backend/cmd/rk/operator_autopilot.go` (+ test). This is the bulk of the change, a large Go port of ≈ 250 lines of operator prose.
- **Modified**:
  - `internal/settings/settings.go` (registry entry + tests).
  - `internal/riff/riff.go` (additive options: an existing-branch checkout route, possibly prompt composition hooks).
  - `internal/operator` (exported helpers the engine needs, such as `heldDep`/`itemDone`/`scopeString` equivalents, scope keys, `done_at` write path).
  - `cmd/rk/operator.go` (register the subcommand).
  - The `rk skill operator` chat topic.
  - `docs/specs` / README CLI docs per the toolkit standards.
- **Untouched**: `internal/operator/brief_autopilot.md` and the run brief (R7), the daemon loop (`internal/operatorloop`, since the daemon does not call the engine autonomously in R6), and the MCP policy table (no new tools; unseeded verbs are allowed, and merge/stop are destructive).
- **External tools**: `git`, `gh`, `wt`, `fab` (only `fab agent -o yaml`, `fab status set-base-branch`, `fab resolve`, `fab change switch`, and `.status.yaml` reads). No fab config reads.
- **Evidence**: the backend/CLI is otherwise invisible in the UI, but the new settings key renders on the settings surface. Per Constitution § PR Evidence that row needs a screenshot (desktop + mobile) of the settings surface through `just demo` or the `just pw` rig. Everything else is `No recording: internal CLI/engine behavior`.
- **Risk**: destructive git/gh actions. Mitigated by the confirm-in-chat contract, explicit `--squash`, `--force-with-lease` only, cone-scoped disarm, and tests against real git.

## Open Questions

- Should the daemon loop call `step` deterministically before deciding to launch a model run? Spawning a `pending` item or arming the next PR needs no model, which would cut runs further. Deferred: R6 ships verbs only, and R7/M1 decide whether the loop drives them.
- Exact landing-session resolution reuse: whether `rk tab new`'s role-aware default resolver is already a shared function or needs extracting from `cmd/rk`. Decide at apply.
- Whether the settings surface auto-renders new registry keys or needs a curated row. Determines the evidence scope; decide at apply by reading the settings UI.

## Clarifications

### Session 2026-11-14

| # | Question | Answer |
|---|----------|--------|
| 7 | CLI shape: `rk operator autopilot queue`/`step`/`merge`/`stop`/`status`, queue entries as JSON on stdin, `step` as the single idempotent advance? | Confirmed as proposed |
| 9 | `stacked-prs` base: cut the dependent's branch from the SHA of `origin/<dep-branch>` instead of `wt create --checkout <dep-branch>`? | Confirmed as proposed |

### Session 2026-11-14 (bulk confirm)

| # | Action | Detail |
|---|--------|--------|
| 6 | Confirmed | — |
| 8 | Confirmed | — |
| 10 | Confirmed | — |
| 11 | Confirmed | — |
| 12 | Confirmed | — |
| 13 | Confirmed | — |
| 14 | Confirmed | — |
| 15 | Confirmed | — |
| 16 | Confirmed | — |

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `merge_mode` lives in a new rk settings-registry key `operator.merge_mode`; fab's `autopilot.merge_mode` is never read (no fallback) | Asked — user chose "rk setting" over rk+fab-fallback and keeping fab's key | S:95 R:70 A:90 D:95 |
| 2 | Certain | PR Recovery (`ci-failed` fix round, `conflicting` rebase+re-arm) is ported to Go in R6 | Asked — user chose "Port it in R6" so R7 can delete all interim text | S:95 R:70 A:90 D:95 |
| 3 | Certain | Mode ladder `--mode` > setting > `cherry-pick-ladder`; invalid value errors; resolved once at enqueue and stamped on every item; runs never resolve config | Plan R6 brief + Merge-authority decision + interim brief rule "a run never resolves config" | S:90 R:75 A:90 D:90 |
| 4 | Certain | Queue state is the tracked items (pane items + `depends_on` + `github-pr` chain); no new queue store | Legacy §6 + interim text + Constitution II plain files; R1 schema already carries it | S:90 R:70 A:95 D:90 |
| 5 | Certain | Spawn fetches first, pins `--base <SHA>`, and a failed fetch stops the spawn leaving the item pending | Plan R6 brief verbatim + legacy §6 sharp edge | S:95 R:80 A:95 D:95 |
| 6 | Confident | Engine is a new `internal/autopilot` package exposed as `rk operator autopilot` verbs that runs and chat call; the daemon loop does not call it in R6 | Clarified — user confirmed | S:95 R:65 A:70 D:60 |
| 7 | Confident | Verb set `queue`, `step`, `merge`, `stop`, `status`; queue entries as JSON on stdin, `step` as the single idempotent advance (no foreground CI waits in any CLI call) | Clarified — user confirmed | S:95 R:55 A:50 D:35 |
| 8 | Confident | Spawn reuses `internal/riff` (wt + tmux window + launcher) in-process, extended additively, instead of shelling out to `rk tab new` | Clarified — user confirmed | S:95 R:70 A:75 D:65 |
| 9 | Confident | `stacked-prs` cuts the dependent's branch from the SHA of `origin/<dep-branch>` rather than the legacy `wt create --checkout <dep-branch>` route | Clarified — user confirmed | S:95 R:55 A:50 D:40 |
| 10 | Confident | Change-less (plain-agent) item is done when its branch has an open PR with green required checks, or is merged; engine persists `done_at` | Clarified — user confirmed | S:95 R:70 A:65 D:60 |
| 11 | Confident | Stacked-prs merge is step-driven direct merge (never armed); cherry-pick-ladder merge-all uses all five Auto-Merge rules | Clarified — user confirmed | S:95 R:60 A:85 D:75 |
| 12 | Confident | Engine never notifies; it returns structured escalations + writes notes, and the caller (run/chat) sends `rk notify` | Clarified — user confirmed | S:95 R:75 A:70 D:65 |
| 13 | Confident | Authoring pane is located via rk's own per-pane fab change derivation (`internal/sessions/fabstate.go`), not `fab pane map` | Clarified — user confirmed | S:95 R:80 A:70 D:70 |
| 14 | Confident | Chat skill topic is updated to route queues/merge/stop through the new verbs; `brief_autopilot.md` and the run brief stay untouched until R7 | Clarified — user confirmed | S:95 R:80 A:75 D:70 |
| 15 | Confident | No MCP tools added; the operator autopilot verbs stay CLI-only in R6 | Clarified — user confirmed | S:95 R:85 A:70 D:70 |
| 16 | Certain | Git behaviour tested against real temp repos; gh/fab through a scripted Runner fake | Clarified — user confirmed | S:95 R:85 A:80 D:75 |
| 17 | Certain | Every exec is argv-slice `exec.CommandContext` with a timeout; repo paths validated before use | Constitution I + Process Execution | S:90 R:90 A:100 D:95 |

17 assumptions (7 certain, 10 confident, 0 tentative, 0 unresolved).
