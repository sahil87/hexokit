# Intake: Plain spawn in a fab repo — `plain` and `base` queue entry fields

**Change**: 261123-ostd-plain-spawn-base-field
**Created**: 2026-11-23

## Origin

> Execute step T8 (Plain spawn in a fab repo: plain queue entries and base field) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first (Decisions and Rules bind you), then implement only the T8 Brief.

One-shot `/fab-new`, spawned by the operator's queue engine (queue entry `ot-t8`, mode `merge-auto`) in a fresh worktree off `main`. The plan file is the design authority: its **Decisions already taken**, **Rules for the operator executing this plan**, and the **T8 Brief** (§ Briefs → "T8 — Plain spawn in a fab repo (run-kit)", including the `base:` bullet added 2026-11-23) bind this change. Only T8 is in scope — T9 (adopt `wt` v0.1.8: `--fetch --json` receipt), T10 (`--temp`/`--pr` in the run rules) and R2 (roll-out) are separate steps and MUST NOT be pulled in.

## Why

**Problem.** The engine's spawn prompt is chosen by the **repo**, not by the **request**. `app/backend/internal/autopilot/spawn.go` `buildPrompt` applies a two-axis table (fab/ present × task given): with `fab/` present and a task, the prompt is always `/fab-new <task>`, and its comment reads "raw implementation text never goes to a fab-project agent". The chat skill (`docs/site/skill/operator.md` § Spawning agents) mirrors the table and says queues are the only spawn path. Every repo the operator serves has `fab/`, so there is no way to ask for a tracked agent that "just does a task" — it is `/fab-new` or nothing. The rule exists to stop raw implementation text reaching an agent that *should* run the pipeline; it should not forbid the user from choosing a plain agent on purpose.

Second problem (added to the plan 2026-11-23): the engine computes a spawn's base from only two inputs — the repo's default branch, or (in `stacked-prs`) the dependency's branch. A user-chosen base (loom2's `eng-v2` is the motivating case) is neither, so work that belongs on a long-lived integration branch cannot be queued. `wt` already accepts any ref; the engine never asked.

**If we don't fix it:** users who want a quick tracked task on a fab repo either get an unwanted fab pipeline (intake, post-intake review by the run, `/fab-fff`) or route around the engine with untracked hand spawns; work targeting a non-default branch cannot be queued at all.

**Approach (decided in the plan — do not reopen):** two opt-in queue-entry fields. The `/fab-new` default for a fab repo stays; `plain: true` is an explicit request. `base: <branch>` overrides the start point and PR base; omitted, behavior is exactly today's. Design Decision to record: **"The request, not the repo, picks the pipeline."**

## What Changes

### 1. Queue entry field `plain: true` (`autopilot.Entry`)

`app/backend/internal/autopilot/queue.go`:

```go
type Entry struct {
	ID        string    `json:"id"`
	Repo      string    `json:"repo"`
	Change    string    `json:"change,omitempty"`
	Task      string    `json:"task,omitempty"`
	Plain     bool      `json:"plain,omitempty"`   // new
	Base      string    `json:"base,omitempty"`    // new (§2)
	DependsOn *[]string `json:"depends_on,omitempty"`
	StopStage *string   `json:"stop_stage,omitempty"`
	Paused    bool      `json:"paused,omitempty"`
}
```

- `ParseEntries` keeps `DisallowUnknownFields`; its error text `want a JSON array of {id, repo, change|task, depends_on?, stop_stage?, paused?}` gains `plain?, base?`.
- **Validation in `buildQueue` (usage error, before any write, dry-run included):** `plain` with `change` → `entry <id>: plain cannot be combined with a change` (wording free, must be an `operatorInvalid`). `plain` without `task` is accepted and is the existing bare agent (no prompt; nothing may depend on it — `checkDep` unchanged). `plain` with a non-null `stop_stage` is a usage error (a plain item has no pipeline stages to stop at).

- **Spawn prompt:** with `plain` + `task`, `buildPrompt` uses the no-fab prompt shape **even when `fab/` is present**:

  ```
  <task>

  Commit on this branch, push, and open a draft PR against <base>.
  ```

  where `<base>` is (in order) the `stackedBase` dependency branch for a `stacked-prs` item with a same-repo dependency, else the entry's `base` (§2), else the repo default branch — exactly the precedence the no-fab path already uses, extended with `base`. Fresh worktree, SHA-pinned base, tracked, the same `pane` projection — nothing else in the spawn sequence changes. No `fab change switch`, no `set-base-branch` for a plain item (it has no change).
- **Completion:** by the change-less rule that already exists — `gate.go` `isPlainAgent` today returns true only for a task item in a repo **without** `fab/`. It must also return true for a `plain` item regardless of `fab/` (`plainAgentDone`: branch PR merged, or open with required checks not pending). `observe.go` already routes `isPlainAgent` items to `plainAgentDone`; only the predicate changes.
- **Dependency chaining and the three modes' spawn shape are unchanged.** A `stacked-prs` plain entry names the dependency branch as its PR base, as the no-fab path already does; a ladder plain entry gets its dependencies cherry-picked in.
- **Durability (Constitution II — the flag is structure):** `engineItem` (`enginefile.go`) gains `Plain bool yaml:"plain,omitempty" json:"plain,omitempty"`; `engineItemFromTracked` / `tracked()` round-trip it through a scope key (new constant beside `scopeTask`, e.g. `scopePlain = "plain"`). A tolerant read of an older engine file (no `plain` key) reads `false` — today's behavior.
- **`status` / `status --json`:** `StatusItem` (`step.go`) gains `Plain bool json:"plain,omitempty"`; the human table shows `plain` for such an item (e.g. in the mode/kind cell — exact placement free, but it must be visible).

### 2. Queue entry field `base: <branch>`

The start point of the new worktree **and** the PR base.

- **Spawn (today's fetch-first SHA pin, pre-T9):** in `spawnItem`, after `git fetch origin`, `baseRef` becomes `origin/<base>` instead of `origin/<def>` when `base` is set; `git rev-parse` of that ref is the `BaseSHA` handed to riff (worktree start point — no upstream tracking, as today). T9 later replaces the fetch/rev-parse with `wt create --fetch --base origin/<base>`; T8 does NOT touch that machinery.
- **fab item:** the base is recorded with `fab status set-base-branch <change> <base>` — the same mechanism the stacked path uses:
  - existing `change` entry → `prepareWorktree` runs `fab status set-base-branch <change> <base>` in the new worktree (today it does so only for `stacked-prs` with a stacked base; generalize to "the item's effective base when it is not the default branch").
  - raw-task fab entry (`/fab-new <task>`) → the trailing prompt instruction `After /fab-new creates the change, run \`fab status set-base-branch <new-change> <base>\`.` (rendered with the target repo's skill prefix via `riff.RenderSkillRef`, exactly as the stacked path does today).
- **plain item:** the prompt's "open a draft PR against `<base>`".
- **Ladder:** the cherry-pick range `origin/<def>..<dep>` becomes `origin/<base>..<dep>` (`prepareWorktree`'s `git cherry-pick --no-commit`).
- **Validation (before any write — usage error):**
  - the name passes `safeBranch` (same validator every shared-state branch passes);
  - **the branch must exist on `origin`** — checked at queue time (dry-run included) in the entry's repo; a missing branch is `entry <id>: base <b> is not a branch on origin`;
  - `base` with `stacked-prs` **and a same-repo dependency** (implicit chaining or explicit `depends_on`) is a misfit of two bases → refuse (usage error, nothing written). `base` on the first entry of a `stacked-prs` queue (no same-repo dependency) is fine: the stack starts from `base`.
- **`status --json`** shows `base` (`StatusItem.Base string json:"base,omitempty"`); the human table shows it when set.
- **Durability:** `engineItem.Base string yaml:"base,omitempty" json:"base,omitempty"`, round-tripped through a scope key (e.g. `scopeBase = "base"`), absent = default branch.
- **Respawn:** `respawn` rebuilds the prompt through `buildPrompt`, which must apply the same `base` precedence so a respawned plain/raw-task agent names the same PR base.
- **Default:** omitted `base` = the repo's default branch, exactly as today (verified `origin/HEAD` → `gh repo view` → `main`/`master` probe).

### 3. Run brief (`app/backend/internal/operator/brief.go`, `brief_rules.md`)

- `operator.QueueEntry` gains `Plain bool` and `Base string`; `enginefile.go`'s queue-entries export (line ~292, `operator.QueueEntry{Task, Change, StopStage, MergeMode}`) fills them; `briefQueueEntry` renders them on the `queue:` line, e.g. `mode merge-auto; stop_stage null; plain; base eng-v2; task "…"`.
- `brief_rules.md` § "Queue items that finish their intake": the post-intake rule does **not** apply to a `plain` item (it has no intake); a `plain` item is judged like a no-fab item — done when its PR merges or is green; under `merge-auto` its green PR is merged per § Merging like any other.

### 4. Chat skill (`docs/site/skill/operator.md`, synced to `app/backend/cmd/rk/skill/operator.md`)

- § Spawning agents table gains the row: `fab/` present + task + `plain` ⇒ plain agent (the raw task text, then "Commit on this branch, push, and open a draft PR against `<base>`."). The no-fab row's "against the default branch" becomes "against `<base>`" (default branch unless `base` is given).
- A `base:` note: "the work belongs on `<branch>`" ⇒ set `base` on the entry; the branch must exist on origin; not with a `stacked-prs` same-repo dependency.
- The rule: when the user asks for an agent on a tab for a task **without** the fab pipeline, queue it `plain: true` (still tracked, still a fresh engine worktree). When the user **explicitly** asks for an **untracked scratch tab**, `rk riff` / `rk tab new -- <cmd>` is allowed; the skill says it is not tracked and nothing may depend on it. The `/fab-new` default for a fab repo stays. The Principles bullets ("spawning stays with the engine", "Coordinate, don't execute", the direct-action allowlist) get the matching carve-out so the skill does not contradict itself.
- § Queues entry-shape paragraph and the example JSON mention `plain` and `base`.

### 5. CLI help (`app/backend/cmd/rk/operator_autopilot.go`)

`autopilot queue`'s `Long` help documents `plain` and `base` in the entry-shape paragraph (and the example array gains a plain/base entry). Incidental: the same paragraph still says "A merge-auto queue with explicit same-repo depends_on is reported as a misfit. Without an explicit --mode, a live call refuses it without writing." — stale since #1177 (an explicit same-repo `depends_on` in merge-auto is the barrier, not a misfit; memory already says so). Rewrite that sentence while editing the paragraph, and add the new real misfit (`base` + `stacked-prs` + same-repo dependency → refused). Per plan Rule 5 (CLI ⇒ docs + tests): update any `rk help-dump` fixture / help golden that captures this text (none found by a grep of the current help string; re-check at apply).

### 6. Tests

- `buildPrompt` table cases: fab + task + `plain` → no-fab shape against default branch; fab + task + `plain` + `base` → "against eng-v2"; fab + task + `plain` + stacked base → against the dependency branch; no-fab + task + `base`; fab + raw task + `base` → `/fab-new` + `set-base-branch … eng-v2` instruction; `plain` without task → bare (empty prompt).
- `queue` rejects `plain` + `change`; rejects `base` not on origin; rejects `base` + `stacked-prs` + same-repo dependency; accepts `base` on a stacked-prs first entry; dry-run applies the same validation.
- Completion: a `plain` item in a **fab** repo is completed by `plainAgentDone` (merged PR, and open PR with required checks passing).
- Spawn: `base` set → `rev-parse origin/<base>` pins `BaseSHA`; ladder cherry-pick range `origin/<base>..<dep>`; existing-change entry with `base` runs `fab status set-base-branch <change> <base>` in the worktree.
- Engine file round-trip of `plain` and `base`; `status --json` carries both (omitted when unset); brief `queue:` line renders both.
- Existing spawn/respawn/completion/barrier tests stay green.

### 7. Docs (memory)

- `docs/memory/run-kit/operator-autopilot.md`: § Queue (entry fields, the two new rejections, the stale misfit wording is already correct there), § Spawn step 1/4/6 (base override, ladder range, prompt table gains the `plain` row and `<base>`), § Readiness gate (a change-less item includes `plain`), § Status (`plain`, `base` in `--json`), and a new Design Decision **"The request, not the repo, picks the pipeline"** (four-field shape: Decision / Why / Rejected / *Introduced by*).
- `docs/memory/run-kit/operator-brief.md`: the `queue:` line fields and the post-intake rule's `plain` exemption.

### PR evidence

Internal CLI/engine behavior — the PR body states `No recording: internal CLI/engine behavior` and lists the validation (`just test-backend`, the new table cases). Plan Rule 6.

## Affected Memory

- `run-kit/operator-autopilot`: (modify) Entry fields `plain`/`base`, queue rejections, spawn base override and prompt table row, completion of plain items in fab repos, status fields, Design Decision "The request, not the repo, picks the pipeline"
- `run-kit/operator-brief`: (modify) `queue:` line carries `plain`/`base`; post-intake rule does not apply to a plain item; plain judged like a no-fab item

## Impact

- `app/backend/internal/autopilot/`: `queue.go` (Entry, ParseEntries message, buildQueue validation + scope stamping), `spawn.go` (`spawnItem` baseRef, `buildPrompt`, `prepareWorktree`, `respawn`), `gate.go` (`isPlainAgent`), `enginefile.go` (engineItem fields, round-trip, QueueEntry export), `step.go` (`StatusItem`, human table), scope-key constants; tests in `spawn_test.go`, `queue_test.go`, `gate_test.go`, `status_test.go`, `enginefile_test.go`.
- `app/backend/internal/operator/`: `brief.go` (`QueueEntry`, `briefQueueEntry`), `brief_rules.md`, brief golden/render tests.
- `app/backend/cmd/rk/`: `operator_autopilot.go` help; `skill/operator.md` (synced copy).
- `docs/site/skill/operator.md`; `docs/memory/run-kit/operator-autopilot.md`, `operator-brief.md`.
- No frontend, no API, no daemon change. Engine file gains two optional keys; both binary versions read either shape (unknown keys ignored by the older one, absent keys default in the newer).

## Open Questions

- None blocking. Implementation-detail choices (exact origin-existence probe, human-table placement, `plain` + `stop_stage` handling) are recorded as graded assumptions below.

## Non-Goals

- Review bar (plan § Decisions, quoted verbatim per Rule 4): **must-fix** = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. **Should-fix** = everything else.
- No `wt create --fetch --json` / receipt adoption, no removal of the engine's own fetch/`rev-parse` (that is T9).
- No `--temp`/`--pr` run-rule changes (T10); no roll-out, `rk update` or daemon restart (R2, operator chat).
- No change to the `/fab-new` default for a fab repo; no new rule-table rows; no PR executors.
- No change to merge-mode semantics beyond the `base` misfit refusal.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `plain: true` + task uses the no-fab prompt shape even with `fab/` present; `/fab-new` stays the default | Plan T8 Brief verbatim; Decisions table binds | S:95 R:85 A:95 D:95 |
| 2 | Certain | `plain` + `change` is a usage error; `plain` without `task` is the existing bare agent | Plan T8 Brief verbatim | S:95 R:85 A:90 D:90 |
| 3 | Certain | Plain completion reuses the existing change-less rule (`plainAgentDone`), widening `isPlainAgent` to plain items in fab repos | Plan: "completion by the change-less rule that already exists"; code shows the single predicate seam | S:90 R:80 A:90 D:85 |
| 4 | Certain | `base` sets the worktree start SHA (`origin/<base>`), the PR base, `set-base-branch` for fab items, and the ladder range `origin/<base>..<dep>`; omitted = default branch | Plan T8 `base` bullet verbatim | S:95 R:80 A:90 D:90 |
| 5 | Certain | T8 keeps the engine's own `git fetch` + `rev-parse` SHA pin; `wt --fetch --json` is T9 | Plan: "fetch-first SHA pin as today — after T9, wt create --fetch does the fetch and pin"; T9 depends on T8 | S:90 R:85 A:95 D:90 |
| 6 | Certain | `base` + `stacked-prs` + same-repo dependency → refused before any write; `base` on a stacked first entry is allowed | Plan: "a misfit of two bases → refuse"; with no same-repo dep there is only one base | S:85 R:80 A:85 D:80 |
| 7 | Certain | Engine file stores `plain` and `base`; `status --json` shows both; brief `queue:` line carries both | Plan: "The engine file stores the flag (structure, Constitution II)", "status --json shows base"; brief needs them for the post-intake exemption | S:85 R:85 A:90 D:85 |
| 8 | Certain | Chat skill: plain row, `base:` note, untracked scratch tab via `rk riff` / `rk tab new -- <cmd>` only on explicit request, stated untracked | Plan T8 Chat-skill bullet verbatim | S:95 R:90 A:90 D:90 |
| 9 | Confident | Origin-existence check for `base` runs at queue time (dry-run too) in the entry's repo via a network probe (e.g. `git ls-remote --exit-code --heads origin <base>`), with `safeBranch` first | Plan says "must exist on origin (rejected before any write)"; ls-remote is authoritative without trusting a stale remote-tracking ref; the exact probe is an implementation detail | S:70 R:85 A:70 D:65 |
| 10 | Certain | For a fab raw-task entry, `base` is recorded by the same trailing prompt instruction the stacked path uses; for an existing change, by `set-base-branch` in `prepareWorktree` | Plan: "the same mechanism the stacked path uses"; both forms exist in `buildPrompt`/`prepareWorktree` today | S:75 R:85 A:85 D:75 |
| 11 | Certain | Fix the stale "explicit same-repo depends_on in merge-auto is a misfit" sentence in `autopilot queue` help while editing that paragraph | #1177 changed the behavior and memory; the help paragraph is the one this change edits (Rule 5: CLI ⇒ docs) | S:60 R:90 A:85 D:80 |
| 12 | Confident | `plain` + a non-null `stop_stage` is a usage error (a plain item has no pipeline stages) | Not in the plan; a stop_stage on a pipeline-less item is meaningless and would silently never trigger. Alternative: accept and ignore | S:40 R:85 A:55 D:45 |
| 13 | Confident | Human `status` table shows `plain`/`base` inline on the item row; exact cell placement left to apply | Plan requires `status` shows `plain`; placement is cosmetic and easily changed | S:65 R:90 A:75 D:65 |
| 14 | Certain | No PR recording: internal CLI/engine behavior | Plan Rule 6: only T6/T7 change the drawer | S:85 R:90 A:90 D:90 |

14 assumptions (11 certain, 3 confident, 0 tentative, 0 unresolved).
