# Plan: Plain spawn in a fab repo — `plain` and `base` queue entry fields

**Change**: 261123-ostd-plain-spawn-base-field
**Intake**: `intake.md`

## Requirements

### Autopilot queue: `plain` entries

#### R1: `plain` entry field
`autopilot.Entry` SHALL accept an optional boolean `plain` (`json:"plain,omitempty"`). `ParseEntries` SHALL keep `DisallowUnknownFields`, and its error text SHALL list the accepted keys including `plain?` and `base?`.

- **GIVEN** a queue document `[{"id":"p1","repo":"/src/app","task":"bump deps","plain":true}]`
- **WHEN** `ParseEntries` decodes it
- **THEN** it returns one entry with `Plain == true` and no error

#### R2: `plain` validation
`buildQueue` SHALL reject, as a usage error (`operatorInvalid`, exit 2) before any write and under `--dry-run` too: `plain` combined with `change`; `plain` combined with a non-empty `stop_stage`. `plain` without `task` SHALL be accepted and SHALL be the existing bare agent (no prompt; `bare: true`; nothing may depend on it).

- **GIVEN** an entry `{"id":"p1","repo":"/src/app","change":"ab12","plain":true}`
- **WHEN** `autopilot queue` (live or `--dry-run`) runs
- **THEN** it fails with a usage error naming `p1` and writes nothing

- **GIVEN** an entry `{"id":"p2","repo":"/src/app","task":"x","plain":true,"stop_stage":"intake"}`
- **WHEN** `autopilot queue` runs
- **THEN** it fails with a usage error naming `p2` and writes nothing

- **GIVEN** an entry `{"id":"p3","repo":"/src/app","plain":true}`
- **WHEN** `autopilot queue` runs
- **THEN** `p3` is queued as a bare agent

#### R3: `plain` spawn prompt in a fab repo
`buildPrompt` SHALL, for an item with `plain` and a `task`, return the no-fab prompt shape **even when the target repo has `fab/`**: `<task>\n\nCommit on this branch, push, and open a draft PR against <pr-base>.` where `<pr-base>` is the `stacked-prs` dependency branch when there is one, else the item's `base`, else the repo default branch. A `plain` item SHALL NOT get `/fab-new`, `fab change switch`, or `fab status set-base-branch`. Without `plain`, a fab repo + task SHALL still produce `/fab-new <task>` (the default is unchanged).

- **GIVEN** a repo with `fab/` and a queue item `{task: "bump deps", plain: true}` on default branch `main`
- **WHEN** the engine spawns it
- **THEN** the prompt is `bump deps\n\nCommit on this branch, push, and open a draft PR against main.`
- **AND** the same item without `plain` gets `/fab-new bump deps`

#### R4: `plain` completion
A `plain` queue item with a task SHALL complete by the existing change-less rule (`plainAgentDone`: its branch PR is `MERGED`, or `OPEN` with no required check pending) regardless of whether the repo has `fab/`. `isPlainAgent` SHALL return true for such an item; a non-plain task item in a fab repo SHALL keep returning false.

- **GIVEN** a spawned `plain` item in a fab repo whose branch has an open PR with required checks passing
- **WHEN** a pass observes completion
- **THEN** the item is `done`

### Autopilot queue: `base` entries

#### R5: `base` entry field and validation
`autopilot.Entry` SHALL accept an optional string `base` (`json:"base,omitempty"`). `buildQueue` SHALL reject as a usage error, before any write and under `--dry-run` too: a `base` that fails `safeBranch`; a `base` that is not a branch on the entry repo's `origin` (probed with `git ls-remote --exit-code --heads origin refs/heads/<base>` through the engine's runner); a `base` on a `stacked-prs` entry that has a same-repo dependency (implicit chaining or explicit `depends_on`, in-queue or already tracked) — a misfit of two bases. A `base` on a `stacked-prs` entry with no same-repo dependency SHALL be accepted.

- **GIVEN** `{"id":"b1","repo":"/src/app","task":"x","base":"eng-v2"}` and `origin` has no `eng-v2`
- **WHEN** `autopilot queue` runs
- **THEN** it fails with a usage error naming `b1` and `eng-v2`, writes nothing

- **GIVEN** a `--mode stacked-prs` queue `[a, b]` in one repo where `b` sets `base: eng-v2`
- **WHEN** `autopilot queue` runs
- **THEN** it fails with a usage error naming `b` (two bases) and writes nothing

- **GIVEN** a `--mode stacked-prs` queue whose first entry sets `base: eng-v2` and `eng-v2` exists on origin
- **WHEN** `autopilot queue` runs
- **THEN** the queue is written

#### R6: `base` at spawn
When an item has `base`, the spawn SHALL use `origin/<base>` wherever it would use `origin/<default>`: after the existing `git fetch origin`, `git rev-parse origin/<base>` SHALL be the `BaseSHA` (fetch-first SHA pin unchanged — no `wt --fetch`, that is T9); the ladder cherry-pick range SHALL be `origin/<base>..<dep>`; an existing-`change` fab item SHALL run `fab status set-base-branch <change> <base>` in the new worktree (as the stacked path does); a raw-task fab item's `/fab-new` prompt SHALL carry the trailing `set-base-branch <new-change> <base>` instruction (same text and skill-prefix rendering as the stacked path); a plain/no-fab prompt SHALL name `<base>` as the PR base. `respawn` SHALL build its prompt with the same base precedence. A spawn that finds both a stacked dependency base and an item `base` SHALL escalate and not spawn (defense in depth behind R5). Without `base`, every spawn path SHALL behave exactly as today.

- **GIVEN** a `cherry-pick-ladder` item with `base: eng-v2` depending on same-repo `a` (branch `a`)
- **WHEN** the engine spawns it
- **THEN** `BaseSHA` is `rev-parse origin/eng-v2` and the cherry-pick runs `origin/eng-v2..<a-ref>`

- **GIVEN** an existing-change item `{change: "ab12", base: "eng-v2"}` in a fab repo
- **WHEN** the engine spawns it
- **THEN** the worktree runs `fab status set-base-branch ab12 eng-v2` and the prompt is `/fab-fff ab12`

### Autopilot: durability and views

#### R7: Engine file stores `plain` and `base`
`engineItem` SHALL carry `plain` (`bool`, omitempty) and `base` (`string`, omitempty), round-tripped through scope keys (`plain`, `base`) by `engineItemFromTracked` and `tracked()`. An engine file without these keys SHALL load as `plain: false`, no base.

- **GIVEN** a queued item with `plain: true, base: eng-v2`
- **WHEN** the engine file is written and reloaded
- **THEN** the reloaded item has `plain: true` and `base: eng-v2`

#### R8: `status` shows `plain` and `base`
`StatusItem` SHALL carry `plain` (`json:"plain,omitempty"`) and `base` (`json:"base,omitempty"`). The human `rk operator autopilot status` row SHALL show `plain` and `base <b>` when set.

- **GIVEN** a queue item with `plain: true, base: eng-v2`
- **WHEN** `autopilot status --json` runs
- **THEN** its row carries `"plain": true` and `"base": "eng-v2"`; an item without them omits both keys

### Operator run brief

#### R9: Brief `queue:` line and the post-intake exemption
`operator.QueueEntry` SHALL carry `Plain` and `Base`, filled by `autopilot.QueueEntries`. `briefQueueEntry` SHALL render `plain` and `base <b>` on the `queue:` line when set (e.g. `mode merge-auto; stop_stage null; plain; base eng-v2; task "…"`). `brief_rules.md` § Queue items that finish their intake SHALL state that the rule does not apply to a `plain` item (it has no intake) and that a `plain` item is judged like a no-fab item — done when its PR merges or is green.

- **GIVEN** a queue item with `plain: true, base: eng-v2, task: "x"`
- **WHEN** the brief renders it
- **THEN** its `queue:` line contains `plain` and `base eng-v2`

### Chat skill and CLI help

#### R10: `rk skill operator` documents `plain` and `base`
`docs/site/skill/operator.md` (synced byte-identical to `app/backend/cmd/rk/skill/operator.md` via `scripts/sync-skill.sh`) SHALL: add the spawn-table row `fab/` present + task + `plain` ⇒ plain agent; make the PR base in the plain rows `<base>` (default branch unless `base` is given); add a `base:` note ("the work belongs on `<branch>`" ⇒ `base`; must exist on origin; not with a `stacked-prs` same-repo dependency); state the rule that a request for an agent on a tab for a task without the fab pipeline is queued `plain: true` (tracked, fresh worktree), and that only an explicit request for an untracked scratch tab may use `rk riff` / `rk tab new -- <cmd>`, which is not tracked and nothing may depend on; keep `/fab-new` as the fab-repo default; carve the scratch-tab exception into the Principles text that says spawning stays with the engine; mention `plain` and `base` in the § Queues entry paragraph.

- **GIVEN** the operator chat reads `rk skill operator`
- **WHEN** the user asks for "a plain agent on loom to bump deps, on eng-v2"
- **THEN** the skill directs a queue entry with `"plain": true, "base": "eng-v2"`

#### R11: `autopilot queue` help documents `plain` and `base`
`operator_autopilot.go` `queue` `Long` help SHALL document `plain` and `base` in the entry paragraph (with an example entry) and the new `base` + `stacked-prs` misfit refusal, and SHALL replace the stale sentence claiming an explicit same-repo `depends_on` in `merge-auto` is a misfit (since #1177 it is the merged-PR barrier).

- **GIVEN** `rk operator autopilot queue --help`
- **WHEN** a user reads the entry paragraph
- **THEN** it names `plain` and `base` and does not call merge-auto `depends_on` a misfit

### Non-Goals

- `wt create --fetch --json` / receipt adoption and removal of the engine's fetch/`rev-parse` — T9
- `--temp`/`--pr` run-rule changes — T10; roll-out, `rk update`, daemon restart — R2
- Any change to the `/fab-new` default, rule-table rows, or merge-mode semantics beyond the `base` misfit
- Review bar (plan § Decisions): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else

### Design Decisions

#### The request, not the repo, picks the pipeline
**Decision**: A queue entry's `plain: true` selects the plain-agent prompt (task + "open a draft PR against `<base>`") even in a fab repo; without it a fab repo + task still gets `/fab-new`. A `base` entry field picks the start point and PR base explicitly.
**Why**: Every repo the operator serves has `fab/`, so a repo-chosen pipeline made a tracked plain agent impossible; the guard against raw text reaching a pipeline agent should not forbid choosing a plain agent on purpose. The engine computed its base from the default branch or a stacked dependency only, so a long-lived integration branch (loom2's `eng-v2`) could not be targeted although `wt` takes any ref.
**Rejected**: Inferring "plain" from task wording (unreliable, silent); untracked `rk riff` spawns as the plain path (loses tracking, completion and dependency chaining); a repo-level setting (the choice is per request, not per repo).
*Introduced by*: 261123-ostd-plain-spawn-base-field

## Tasks

### Phase 1: Setup

- [x] T001 Add `Plain bool json:"plain,omitempty"` and `Base string json:"base,omitempty"` to `Entry` and scope-key constants `scopePlain = "plain"`, `scopeBase = "base"` in `app/backend/internal/autopilot/queue.go`; update the `ParseEntries` error text to list `plain?, base?` <!-- R1 -->
- [x] T002 Add `Plain`/`Base` to `engineItem` (`yaml`/`json` `plain,omitempty` / `base,omitempty`) and round-trip them through `engineItemFromTracked` and `tracked()` in `app/backend/internal/autopilot/enginefile.go`; add `Plain bool` and `Base string` to `operator.QueueEntry` in `app/backend/internal/operator/brief.go` and fill them in `QueueEntries` <!-- R7 -->

### Phase 2: Core Implementation

- [x] T003 In `buildQueue` (`app/backend/internal/autopilot/queue.go`) validate `plain`+`change`, `plain`+non-empty `stop_stage`, `base` `safeBranch`, `base` on origin via `git ls-remote --exit-code --heads origin refs/heads/<base>` (through `e.git`/runner, in the entry repo), and `base` + `stacked-prs` + same-repo dependency (use `sameRepoDep` over the resolved deps); stamp `scopePlain` (only when `plain` and `task`) and `scopeBase` on the item scope. Keep `buildQueue` readable — extract an entry-validation helper if it grows past ~50 lines <!-- R2, R5 -->
- [x] T004 Widen `isPlainAgent` in `app/backend/internal/autopilot/gate.go`: a queue item with a task, no change, and `plain` set is a plain agent regardless of `fab/`; update its doc comment <!-- R4 -->
- [x] T005 In `app/backend/internal/autopilot/spawn.go`: compute the effective base (item `base` else default branch) in `spawnItem`; `baseRef = origin/<effective>` unless a stacked branch applies; escalate (no spawn) when both a stacked branch and an item `base` are present; pass the effective base to `prepareWorktree` so the ladder range is `origin/<base>..<dep>` and an existing change runs `fab status set-base-branch <change> <base>` when `base` is set (or the stacked base as today); make `buildPrompt` take the plain branch first (plain + task ⇒ no-fab shape against stacked base › item base › default) and append the `set-base-branch` instruction for a raw-task fab item when the item has a `base`; make `respawn` pass the same base into `buildPrompt`. Update the `buildPrompt` doc comment (no longer "never raw text to a fab-project agent" unconditionally) <!-- R3, R6 -->
- [x] T006 Add `Plain`/`Base` to `StatusItem` in `app/backend/internal/autopilot/step.go` and fill them in `Status`; show `plain` and `base <b>` in the human row of `runAutopilotStatus` in `app/backend/cmd/rk/operator_autopilot.go` <!-- R8 -->
- [x] T007 Render `plain` and `base <b>` in `briefQueueEntry` (`app/backend/internal/operator/brief.go`); in `app/backend/internal/operator/brief_rules.md` § Queue items that finish their intake add that the rule does not apply to a `plain` item (the `queue:` line says `plain`) and that a plain item is judged like a no-fab item — done when its PR merges or is green <!-- R9 -->

### Phase 3: Integration & Edge Cases (tests)

- [x] T008 [P] `app/backend/internal/autopilot/spawn_test.go`: `buildPrompt` table cases — fab+task+plain → plain shape against default; +base → against `eng-v2`; +stacked base → against the dependency branch; no-fab+task+base → against `eng-v2`; fab raw task+base → `/fab-new` + `set-base-branch <new-change> eng-v2` instruction; plain without task → ""; fab+task without plain → `/fab-new` (unchanged). Spawn cases: `base` pins `rev-parse origin/eng-v2`; ladder range `origin/eng-v2..<dep>`; existing change + base runs `fab status set-base-branch <change> eng-v2`; stacked branch + item base escalates without spawning <!-- R3, R6 -->
- [x] T009 [P] `app/backend/internal/autopilot/queue_test.go`: rejects `plain`+`change`, `plain`+`stop_stage`, `base` not on origin (ls-remote exit 2), unsafe `base`, `base` + `stacked-prs` + same-repo dep (implicit and explicit); accepts `base` on a stacked first entry; accepts `plain` without task as bare; `--dry-run` applies the same validation; `ParseEntries` accepts `plain`/`base` <!-- R1, R2, R5 -->
- [x] T010 [P] Completion and views tests: a `plain` item in a fab repo completes via `plainAgentDone` (merged; open + required checks passing) and a non-plain task item in a fab repo is not a plain agent (`gate_test.go` or the nearest existing completion test file); engine-file round-trip of `plain`/`base` and a legacy file without them (`enginefile_test.go`); `status --json` carries/omits `plain`/`base` (`status_test.go`); brief `queue:` line renders `plain`/`base` (`app/backend/internal/operator/brief_test.go`, updating any golden) <!-- R4, R7, R8, R9 -->

### Phase 4: Polish

- [x] T011 Update `docs/site/skill/operator.md` per R10 (spawn table row, `<base>` in plain rows, `base:` note, plain/scratch-tab rule, Principles carve-out, § Queues entry paragraph + example), then run `scripts/sync-skill.sh` so `app/backend/cmd/rk/skill/operator.md` is identical; fix any skill drift/golden test that asserts the old text <!-- R10 -->
- [x] T012 Update the `queue` `Long` help in `app/backend/cmd/rk/operator_autopilot.go` per R11 (plain/base entry docs + example, `base`+`stacked-prs` misfit, remove the stale merge-auto misfit sentence); update any help golden/`help-dump` fixture that captures it <!-- R11 -->
- [x] T013 Run `just test-backend` and fix failures caused by this change (known host-only failures `TestPortPinRowRealPolicyValues`, `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath` are pre-existing and not blockers) <!-- R1 -->

## Execution Order

- T001–T002 before T003–T007; T003–T007 before their tests T008–T010; T011–T012 independent of tests; T013 last

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `Entry` decodes `plain` and `base`; unknown keys are still rejected; the parse error lists `plain?` and `base?`
- [ ] A-002 R2: `plain`+`change` and `plain`+`stop_stage` are usage errors before any write (dry-run included); `plain` without task is queued bare
- [ ] A-003 R3: a `plain` task item in a fab repo gets the plain prompt naming the right PR base, and no `/fab-new`/`fab change switch`/`set-base-branch`
- [ ] A-004 R4: `isPlainAgent` is true for a plain task item in a fab repo, and such an item completes via `plainAgentDone`
- [ ] A-005 R5: `base` failing `safeBranch`, missing on origin, or combined with `stacked-prs` + a same-repo dependency is a usage error before any write; a stacked first entry with `base` is accepted
- [ ] A-006 R6: with `base`, `BaseSHA` comes from `origin/<base>`, the ladder range is `origin/<base>..<dep>`, an existing change records `set-base-branch <change> <base>`, a raw-task fab prompt carries the `set-base-branch` instruction, plain/no-fab prompts name `<base>`, and respawn uses the same base
- [ ] A-007 R7: `plain`/`base` survive an engine-file write and reload; a file without them loads as today
- [ ] A-008 R8: `status --json` carries `plain`/`base` when set and omits them otherwise; the human row shows them
- [ ] A-009 R9: the brief `queue:` line renders `plain`/`base`, and `brief_rules.md` exempts plain items from the post-intake rule
- [ ] A-010 R10: `rk skill operator` carries the plain row, the `base:` note, the plain/scratch-tab rule and the Principles carve-out; the two skill copies are identical
- [ ] A-011 R11: `queue --help` documents `plain`/`base` and the `base` misfit, and no longer calls merge-auto `depends_on` a misfit

### Behavioral Correctness

- [ ] A-012 R3: a fab repo + task without `plain` still produces `/fab-new <task>` (default unchanged)
- [ ] A-013 R6: an item without `base` spawns exactly as before (same fetch, `rev-parse origin/<default>`, same ladder range, same prompts)

### Scenario Coverage

- [ ] A-014 R3: `buildPrompt` table tests cover plain/base/stacked/no-fab/raw-task combinations
- [ ] A-015 R5: queue tests cover each rejection and the stacked-first-entry acceptance
- [ ] A-016 R4: a completion test covers a plain item in a fab repo (merged and open-green)

### Edge Cases & Error Handling

- [ ] A-017 R6: a spawn that sees both a stacked dependency branch and an item `base` escalates and opens no window
- [ ] A-018 R5: the origin probe failure (non-zero exit) yields a usage error, not a panic or a silent accept; the probe runs through the runner with a timeout (no shell string)

### Code Quality

- [ ] A-019 Pattern consistency: new fields, scope keys and validation follow the existing `task`/`stop_stage`/`merge_mode` patterns in `queue.go`/`enginefile.go`
- [ ] A-020 No unnecessary duplication: `safeBranch`, `sameRepoDep`, `RenderSkillRef` and the existing stacked `set-base-branch` paths are reused rather than re-implemented
- [ ] A-021: All subprocess calls go through the engine runner (`exec.CommandContext`, argv slices, per-class timeout) — no shell strings
- [ ] A-022: No god functions — `buildQueue`/`spawnItem` stay readable (helpers extracted where they would exceed ~50 lines of new logic)
- [ ] A-023: Comments state constraints, not narration; no change IDs or PR numbers in code comments
- [ ] A-024: New behavior is covered by tests (`just test-backend` green apart from the two known host-only failures)

### Security

- [ ] A-025 R5: `base` is validated by `safeBranch` before it reaches any git argv

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The scope keys are `plain` and `base`, alongside the existing `task`/`merge_mode` scope constants | Follows the existing scope-key pattern; intake #7 | S:80 R:90 A:90 D:85 |
| 2 | Confident | `scopePlain` is stamped only when `plain` and `task` are both set; `plain` without task is stored as bare only | A plain flag on a bare agent changes nothing and would make `isPlainAgent` reason about a task-less item | S:65 R:90 A:80 D:70 |
| 3 | Confident | The origin probe is `git ls-remote --exit-code --heads origin refs/heads/<base>` in the entry repo via the runner | Authoritative without trusting a stale remote-tracking ref; intake #9 | S:70 R:85 A:75 D:65 |
| 4 | Confident | A spawn finding both a stacked dependency base and an item `base` escalates (defense in depth) | An item tracked from an earlier queue call could pair them past queue-time checks only through hand edits; refusing is the safe outcome | S:60 R:85 A:80 D:75 |
| 5 | Confident | The human `status` row appends ` · plain` and ` · base <b>` after the existing fields | Matches the ` · `-joined row style; placement is cosmetic | S:65 R:95 A:80 D:70 |
| 6 | Certain | Memory files are updated at hydrate, not in apply; apply updates the skill doc, CLI help, and brief rules | The pipeline's hydrate stage owns `docs/memory/` | S:85 R:90 A:95 D:90 |

6 assumptions (2 certain, 4 confident, 0 tentative).
