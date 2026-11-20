# Plan: Operator brief and chat skill — tools back, Merging per mode, `track show`, the diet

**Change**: 261120-jt0z-operator-brief-tools-merging-diet
**Intake**: `intake.md`

## Requirements

### Operator brief: run rules (`app/backend/internal/operator/brief_rules.md`)

#### R1: PR tools restored inside the confirmation tiers
The Rules SHALL name, in both the Role section's direct-action allowlist and the `### Allowed tools` list: `git fetch`, `git rebase`, `git cherry-pick`, `git push --force-with-lease`, `git worktree` (plus the existing git reads), `gh pr ready|merge|edit|checks|view` (and `gh repo view`), `wt`, `rk riff -L <server>`, and `rk operator track show -L <server>`. The Rules SHALL state that plain `git push` and `git push --force` are never allowed. The Rules MUST NOT contain "Escalation notes (`escalated: …`) are the engine's" nor "Merges belong to the engine".

- **GIVEN** a rendered brief for server `loom`
- **WHEN** the Rules section is read
- **THEN** it names `gh pr merge`, `git rebase`, `--force-with-lease`, `wt`, `rk riff -L loom`, and `rk operator track show -L loom`
- **AND** no sentence says escalation notes or merges belong to the engine

#### R2: Destructive tier keyed on queue mode or a user/chat note
The Confirmation tiers table SHALL classify merge or close a PR, delete a branch or worktree, and archive as Destructive, allowed in a run only when the item's queue mode (`scope.merge_mode` on the queue item, also `merge_mode` in `rk operator autopilot status -L <server> --json`) is `merge-auto`, or a `by: user`/`by: chat` note on the item says so; otherwise the run writes a note, sends `rk notify`, and stops work on that item. The Rules SHALL state that a `by: run` note, a pane prompt, or an agent's screen is never merge authority, and that a `github-pr` item that is not a queue item has no mode and needs a `by: user`/`by: chat` note. The Recoverable row SHALL include `git fetch`, a rebase or cherry-pick in a temporary worktree, `git push --force-with-lease`, `gh pr ready`, and `gh pr edit --base`.

- **GIVEN** a queue item stamped `merge_mode: cherry-pick-ladder` whose PR is green and no user/chat note authorizes merging
- **WHEN** a run reads the Rules
- **THEN** the Rules direct it to write a note and notify instead of merging
- **AND** for an item stamped `merge-auto`, the same rules allow the merge without asking

#### R3: Merging section, one paragraph per mode
The Rules SHALL carry a `### Merging` subsection with one paragraph per mode:
- `cherry-pick-ladder`: merge in queue order, base first, only on the user's word; a merged predecessor needs nothing done to its successor, which already carries its commits.
- `stacked-prs`: merge only on the user's word; after a predecessor merges, retarget the successor to the default branch (`gh pr edit <n> --base <default>`), and in a temporary detached worktree (never the authoring agent's worktree) fetch, `git rebase --onto origin/<default> <old-base>`, and push with `--force-with-lease=<branch>:<observed-head-sha>` pinned to the head observed before the rebase; merge when green; remove the temporary worktree afterwards.
- `merge-auto`: merge each green PR as it comes, without asking: `gh pr merge <n> --squash --match-head-commit <observed-head-sha>`; green means every required check passed, the PR is not a draft (`gh pr ready` first when the item's work is finished), and it is mergeable.
It SHALL also state: a rebase/cherry-pick conflict is the run's to resolve in that temporary worktree, one round, else abort, remove the worktree, note and notify; a red required check goes to the authoring agent as a fix request (through Pre-send validation) when its pane is alive and idle, otherwise a recovery spawn through `rk riff -L <server>` tracked as a ledger item — one round each, then note and notify; each merge, retarget, rebase, and fix request is recorded in a note.

- **GIVEN** the rendered Rules
- **WHEN** a run handles a stacked successor after its predecessor merged
- **THEN** the Merging section tells it to retarget, rebase `--onto` in a temporary detached worktree, push with a lease pinned to the observed head, and merge when green

#### R4: Narrow file-edit carve-out and retry bounds
The Role bullet "never edit files" and the Allowed-tools line "No file-editing tools." SHALL each allow exactly one exception: resolving a merge conflict in a temporary worktree (§ Merging). The Bounded retries table SHALL gain rows for conflict resolution (1 → note and notify) and for a red-check fix request / recovery spawn (1 each → note and notify).

- **GIVEN** the rendered Rules
- **WHEN** read for file editing
- **THEN** file edits are forbidden except conflict resolution in a temporary worktree

#### R5: Re-read one item, not the ledger
The Role section's re-derive bullet SHALL tell the run to re-read an item with `rk operator track show -L <server> <id> --json` and a pane with `rk mux capture -L <server>`, and never `rk operator track list -L <server> --json` unless it needs the whole ledger. The Read-only tier example SHALL use `rk operator track show -L <server>`.

- **GIVEN** the rendered Rules
- **WHEN** a run re-derives an item before acting
- **THEN** the rules name `rk operator track show -L <server> <id> --json`, and `track list --json` only for the whole ledger

### Operator brief: renderer (`app/backend/internal/operator/brief.go`)

#### R6: Exit contract — a note only for acted-on items
`briefExitContract` SHALL instruct the run to append a note on each item it acted on with `rk operator track note -L <server> <id> "<text>" --by run`, SHALL state "A run that did nothing writes no note.", and SHALL keep the final `outcome: <one-line summary>` line requirement. It MUST NOT contain "one note on the most relevant item when nothing needed doing". `briefRoleLine` SHALL read "You are a one-shot operator run. Act on what changed, note what you did, exit." The run wrapper's failure note is unchanged.

- **GIVEN** a rendered brief
- **WHEN** the Exit contract section is read
- **THEN** it contains "A run that did nothing writes no note." and the `outcome:` line, and no "most relevant item" clause

#### R7: User and chat notes always shown
In the Affected-items block, an item's notes SHALL be the newest `notesShown` (10) notes plus every older note whose `by` is `user` or `chat`, in stored (chronological) order; the `(+N earlier notes)` line SHALL count only notes omitted. Under the size-cap trim, `by: user`/`by: chat` notes SHALL be kept while `notesShown` reduces run notes to zero; only if the brief is still over the cap with `notesShown` at zero SHALL older user/chat notes then be dropped oldest-first (best-effort, never dropping What changed, Rules, or Exit contract).

- **GIVEN** an item with 14 notes where note 1 is `by: user`, note 2 is `by: chat`, and the rest are `by: run`
- **WHEN** the brief is rendered with that item changed
- **THEN** notes 1, 2 and 4–13 are shown in order, and the line reads `(+2 earlier notes)`

### Operator state: `rk operator track show` (`app/backend/cmd/rk/operator_track.go`, `internal/operator`)

#### R8: `track show` verb
`rk operator track show <id> [--json] [-L <server>]` SHALL be a pure read (no lock, no write, no conversion, no state directory created) resolving the state file like `list`. Plain output SHALL be the item's `list` line (`id · kind · state · checked age · next`) followed by the item's detail block with **all** its notes (no cap) — reusing the brief's item-block rendering. `--json` SHALL emit the shared `outputSink` envelope around the single full item (same object shape `list --json` emits, including all notes). A missing item (including an absent state file) SHALL exit 1 with `no tracked item <id>`; a malformed state file exits 1; a missing/extra positional argument or an invalid `-L` exits 2. Help SHALL carry Flags, Examples and Exit codes sections in the `track` style with no backticks in flag help. The verb is CLI-only (no MCP row) and appears in `rk help-dump` through the cobra tree.

- **GIVEN** a ledger with item `w1` holding 25 notes
- **WHEN** `rk operator track show w1 --json` runs
- **THEN** stdout is one envelope whose data is the `w1` item with all 25 notes, and the state file is unchanged
- **AND** `rk operator track show nope` exits 1 with `no tracked item nope`

### Chat skill (`docs/site/skill/operator.md`, synced to `app/backend/cmd/rk/skill/operator.md`)

#### R9: "merge all" and the PR tools belong to the chat
The topic SHALL make "merge all" the chat's own job under the same Merging rules as the brief (per mode: ladder base-first on the user's word; stacked retarget + `rebase --onto` in a temporary detached worktree, lease pinned to the observed head; merge-auto squash with `--match-head-commit`; conflict → resolve in the temporary worktree, one round; red check → fix request or `rk riff` recovery, one round each, then tell the user). The Tools and Principles bullets SHALL allow git fetch/rebase/cherry-pick/`push --force-with-lease`, `gh pr ready|merge|edit`, and `wt` inside the confirmation tiers, while queues are still created only through `rk operator autopilot queue`. The re-derive bullet SHALL name `rk operator track show <id> --json` for one item. The ledger examples SHALL include `rk operator track show`. The retries line SHALL allow one conflict-resolution round, then tell the user. The topic MUST NOT name `autopilot merge`, a halted sequence for `rm`, resuming a halted item, "spawning, cherry-picking and merging stay with the engine", or PR escalations from the engine. The synced copy SHALL be byte-identical (`scripts/sync-skill.sh`).

- **GIVEN** the user says "merge all" after a `cherry-pick-ladder` queue completes
- **WHEN** the chat reads its topic
- **THEN** it merges the PRs base-first itself (confirmation tier: destructive, confirmed), not via an autopilot verb

### Non-Goals

- Engine change in `internal/autopilot` — no new rows, no Go merge path (plan T3 owns the engine; review bar: a change that lets Go merge again is must-fix).
- Runtime enforcement of the allowed-tool list — stays declarative text.
- Changes to the run wrapper (`internal/operatorloop`) — failure note and outcome parsing stay.
- Trigger door, check records, PR hooks, Activity tab (T2/T5/T6).
- Review bar (plan § Decisions): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.

### Design Decisions

#### PR work returned to the run, inside the tiers
**Decision**: The run rules allow git fetch/rebase/cherry-pick/`push --force-with-lease`, `gh pr ready|merge|edit`, `wt` and `rk riff`, with merge/close/delete gated on the item's stamped queue mode (`merge-auto`) or a `by: user`/`by: chat` note, and a per-mode Merging section.
**Why**: The engine no longer merges, restacks or recovers PRs; without these tools a `merge-auto` queue deadlocks at the first green PR, and the judgment conflicts and red CI need is the model's.
**Rejected**: Keeping merges forbidden in runs and routing every merge to the user (defeats `merge-auto`); a Go executor (deleted in T3 for delivering nothing).
*Introduced by*: 261120-jt0z-operator-brief-tools-merging-diet

#### A run that did nothing writes no note
**Decision**: The exit contract asks for a note only on items the run acted on; a no-op run prints only its `outcome:` line.
**Why**: No-op observation notes were 74 of 118 run notes and pushed the user's own notes out of the brief's newest-ten window; the run's outcome line already records that it looked.
**Rejected**: A note on the most relevant item on every run (the dilution being removed).
*Introduced by*: 261120-jt0z-operator-brief-tools-merging-diet

#### One-item re-read with `track show`
**Decision**: A new pure read verb `rk operator track show <id> [--json]` returns one item with all its notes, and the run rules re-read an item with it instead of `track list --json`.
**Why**: The ledger dump was most of a run's extra ~38K input tokens; the brief already carries the affected items, so one item is all a re-derive needs.
**Rejected**: `track list --kind` filtering (still returns many items and every note); a `--id` filter on `list` (overloads a list verb with a single-item contract).
*Introduced by*: 261120-jt0z-operator-brief-tools-merging-diet

#### User and chat notes are exempt from the notes cap
**Decision**: The affected-item block always shows every `by: user`/`by: chat` note on top of the newest ten, and the size-cap trim drops them only after run notes reach zero.
**Why**: Those notes are the user's instructions; a run that cannot see them cannot follow them.
**Rejected**: Raising the cap for everyone (grows every brief with run chatter).
*Introduced by*: 261120-jt0z-operator-brief-tools-merging-diet

## Tasks

### Phase 1: Core Implementation

- [x] T001 Add `Show(path, id string) (all []TrackedItem, item TrackedItem, err error)` (pure read via `Load`, `no tracked item <id>` when absent, including an absent state file) and an exported `ItemBlock(all []TrackedItem, it TrackedItem) string` that renders the brief's item block with all notes (`writeItemBlock` with `notesShown = len(notes)`, `clock()` for now) in `app/backend/internal/operator/track.go` / `brief.go`; unit tests in `internal/operator/track_test.go` <!-- R8 -->
- [x] T002 Add `operatorTrackShowCmd` (`show <id> [--json]`, help with Flags/Examples/Exit codes, `ExactArgs(1)` via `usageArgs`, `--json` flag) and `runOperatorTrackShow` in `app/backend/cmd/rk/operator_track.go`, register it in `operatorTrackCmd.AddCommand`; plain output = `ListLines(all, [item])[0]` then `ItemBlock`; `--json` = `sink.Envelope(item, nil)`; errors through `operatorTrackDone` <!-- R8 -->
- [x] T003 Change `writeNotes` in `app/backend/internal/operator/brief.go` to show the newest `notesShown` plus every older `by: user`/`by: chat` note, counting only omitted notes in `(+N earlier notes)`; extend the trim loop in `RenderBrief` so that at `notesShown == 0` a final pass drops older user/chat notes oldest-first while over the cap (add a layout field, e.g. `userNotesDropped int`) <!-- R7 -->
- [x] T004 Rewrite `briefExitContract` and `briefRoleLine` in `app/backend/internal/operator/brief.go` per R6 <!-- R6 -->
- [x] T005 Rewrite `app/backend/internal/operator/brief_rules.md`: Role bullets (re-derive with `track show`, allowlist with git/gh/wt/`rk riff`, edit carve-out, remove the engine-escalation bullet), Confirmation tiers table + authority paragraph, new `### Merging` subsection, Bounded retries rows, Allowed tools list; every `rk mux`/`rk operator`/`rk riff` command carries `-L <server>` <!-- R1 R2 R3 R4 R5 -->

### Phase 2: Tests

- [x] T006 Update `app/backend/internal/operator/brief_test.go`: flip `TestRenderBrief_NoAutopilotProseOrWriteTools` into a test asserting no `## Interim autopilot` section, the Merging section and restored tools present, and the removed engine sentences / bare `git push --force ` absent; extend `TestBriefRules_CoverTheRunContract` with Merging anchors; `TestRenderBrief_ExitContract` asserts the no-note sentence and absence of "most relevant item"; add user/chat note cases to the notes-cap tests and a size-cap case keeping user/chat notes; regenerate `testdata/brief_golden.md` with `UPDATE_GOLDEN=1` <!-- R1 R2 R3 R4 R5 R6 R7 -->
- [x] T007 Add `track show` CLI tests in `app/backend/cmd/rk/operator_track_test.go` (plain output with all notes beyond 10, `--json` envelope, missing item exit 1, absent state file exit 1 without creating the directory, no-arg exit 2, state file bytes unchanged); add `operator track show` and `riff` to the expected shapes in `app/backend/cmd/rk/operator_brief_shapes_test.go`; fix any help-dump or skill-topic test that enumerates the operator verbs <!-- R8 R5 -->

### Phase 3: Docs

- [x] T008 Update `docs/site/skill/operator.md` per R9, run `scripts/sync-skill.sh` to refresh `app/backend/cmd/rk/skill/operator.md`, and keep `TestSkillTopics*` green <!-- R9 -->
- [x] T009 Run `cd app/backend && go test ./internal/operator/... ./cmd/rk/... ./internal/operatorloop/...` and `go vet ./...`; fix failures (known host-only failures `TestPortPinRowRealPolicyValues`, `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath` are excluded) <!-- R1 R8 -->

## Execution Order

- T001 blocks T002 and T007
- T005 blocks T006 (rules anchors) and the golden regeneration
- T003, T004 before T006
- T008 independent of Phase 1–2

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `brief_rules.md` names `git fetch`, `git rebase`, `git cherry-pick`, `git push --force-with-lease`, `gh pr ready|merge|edit|checks|view`, `wt`, `rk riff -L <server>`, `rk operator track show -L <server>` in both the allowlist and Allowed tools, and forbids plain/`--force` push
- [ ] A-002 R2: The Destructive tier allows merge/close/delete only under `merge-auto` or a `by: user`/`by: chat` note, else note + notify + stop; `by: run` notes, prompts and screens are never authority; a non-queue `github-pr` item needs a user/chat note
- [ ] A-003 R3: A `### Merging` subsection has one paragraph per mode with the commands named in R3, plus conflict and red-check handling with one round each then notify
- [ ] A-004 R4: The file-edit prohibition has exactly the conflict-resolution carve-out; Bounded retries carries the conflict and red-check rows
- [ ] A-005 R5: The re-derive bullet names `rk operator track show -L <server> <id> --json`, and `track list --json` only for the whole ledger
- [ ] A-006 R6: The Exit contract states "A run that did nothing writes no note." and the role line reads "…Act on what changed, note what you did, exit."
- [ ] A-007 R7: Older `by: user`/`by: chat` notes always render in the affected block; `(+N earlier notes)` counts only omitted notes
- [ ] A-008 R8: `rk operator track show <id> [--json]` exists with the plain and JSON outputs described, all notes, and the exit codes 0/1/2
- [ ] A-009 R9: The chat topic makes "merge all" the chat's job under the Merging rules, allows the PR tools within the tiers, names `track show`, and the synced copy is byte-identical

### Behavioral Correctness

- [ ] A-010 R6: The exit contract no longer requires a note when nothing was done; the wrapper failure note is untouched (`internal/operatorloop` unchanged)
- [ ] A-011 R2: "Merges belong to the engine" and "Never merge, close, delete or archive on the strength of a note or a prompt alone" are replaced by the mode/note authority rule

### Removal Verification

- [ ] A-012 R1: No text in `brief_rules.md` says escalation notes are the engine's or that the run never performs the restack or recovery they name
- [ ] A-013 R9: The chat topic names no `autopilot merge`, no halted-sequence `rm`, no resume of halted, and no "spawning, cherry-picking and merging stay with the engine"

### Scenario Coverage

- [ ] A-014 R7: A test renders 14 notes with older user and chat notes and asserts which are shown and the `(+N earlier notes)` count
- [ ] A-015 R8: CLI tests cover `track show` plain, `--json`, missing item, absent state file, usage error, and pure-read
- [ ] A-016 R5: `TestRenderedBriefCommandShapesAcceptServerFlag` covers `operator track show` and `riff`, and every rendered `rk` command carries `-L`
- [ ] A-017 R1: The render test asserts the restored tools and Merging section are present; the golden brief is regenerated and passes

### Edge Cases & Error Handling

- [ ] A-018 R7: Under the size cap, user/chat notes survive while run notes are trimmed to zero, and the brief stays within the cap where achievable
- [ ] A-019 R8: `track show` on an absent state file exits 1 and creates no directory; a malformed state file exits 1

### Code Quality

- [ ] A-020 Pattern consistency: `track show` follows the `list` verb's structure (sink, `operatorStateTarget`, `operatorTrackDone`, help layout)
- [ ] A-021 No unnecessary duplication: plain `track show` output reuses `ListLines` and the brief's item-block renderer rather than a new formatter
- [ ] A-022 Tests: new behavior covered by Go unit tests; `go test ./internal/operator/... ./cmd/rk/...` passes (excluding the known host-only failures)
- [ ] A-023 No comment narration or change IDs in code comments

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `track show` plain output = the `list` line + the brief's item block with all notes (exported `ItemBlock`) | Reuses existing renderers; plan says "one item, all notes" | S:65 R:85 A:75 D:60 |
| 2 | Confident | Missing item and absent state file both exit 1 with `no tracked item <id>` | Matches the existing verbs' wording and exit class | S:70 R:85 A:85 D:75 |
| 3 | Confident | The size-cap trim drops user/chat notes only after `notesShown` reaches zero, oldest first | Honours "always includes" while keeping the cap best-effort | S:55 R:85 A:65 D:55 |
| 4 | Confident | `rk riff` in the rules carries `-L <server>` (riff accepts `-L`), so it joins the brief's shape test | `riff.go` registers `--server/-L`; the shape regex already covers `riff` | S:70 R:85 A:85 D:75 |
| 5 | Certain | Role line becomes "Act on what changed, note what you did, exit." | Intake §3 fixes the wording | S:85 R:90 A:85 D:85 |

| 6 | Confident | Plain `track show` output separates the list line from the item block with one blank line | The item block opens with a `###` heading; the blank line keeps the list line parseable on its own | S:60 R:90 A:80 D:70 |
| 7 | Confident | The Bounded retries table carries separate rows for a red-check fix request and a recovery spawn | R4 asks for "1 each"; separate rows make each round auditable | S:65 R:90 A:80 D:70 |
| 8 | Confident | The Role "-L <server>" contract line names `rk riff` alongside `rk mux` and `rk operator` | `rk riff` joins the commands every run passes `-L` to; the shape test already parses it | S:70 R:90 A:85 D:75 |
| 9 | Confident | The chat topic carries a compact `### Merging` block under Queues instead of only inline text | R9 asks for per-mode rules; one short block avoids scattering them while staying a summary of the brief's rules | S:60 R:90 A:75 D:65 |

9 assumptions (1 certain, 8 confident, 0 tentative).
