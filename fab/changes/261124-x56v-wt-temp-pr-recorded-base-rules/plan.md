# Plan: `--temp`, `--pr` and the recorded base in the run rules and chat skill

**Change**: 261124-x56v-wt-temp-pr-recorded-base-rules
**Intake**: `intake.md`

## Requirements

### Run rules: temporary worktrees and recovery spawns (`internal/operator/brief_rules.md`)

#### R1: Temporary worktree through `wt create --temp`
The run rules SHALL make the temporary detached worktree for a `stacked-prs` restack or a conflict round with
`wt create --temp <observed-head-sha> --fetch --json` in the item's repo (the receipt's `path` is `<tmp>`, its
`name`, prefixed `tmp-`, is what is deleted), and SHALL clean it up with `wt delete <name> --non-interactive`. The
rules MUST NOT contain `git worktree add` or `git worktree remove`, and the separate `git fetch origin` step of the
restack SHALL be dropped (the `--fetch` does it).

- **GIVEN** a `stacked-prs` predecessor merged and the successor needs re-seating
- **WHEN** a run follows § Merging
- **THEN** it creates `<tmp>` with `wt create --temp <observed-head-sha> --fetch --json`, rebases and pushes in it, and removes it with `wt delete <name> --non-interactive`
- **AND** a conflict round that does not resolve aborts the rebase and removes the worktree with the same `wt delete`

#### R2: Recovery spawn on the PR's head through `--pr`
The red-check recovery spawn SHALL be `rk riff -L <server> -- --pr <n>` (riff's `--` passthrough runs
`wt create --pr <n>`: a fresh worktree on the PR's head branch).

- **GIVEN** a red required check and an authoring pane that is gone or not idle
- **WHEN** the run spawns a recovery
- **THEN** the rules name `rk riff -L <server> -- --pr <n>`, an agent told to fix the failing check and push, tracked as a ledger item

#### R3: `git worktree` leaves the allowlists
The direct-action allowlist and § Allowed tools SHALL NOT list `git worktree`; `wt` is listed with its verbs
(`create --temp`, `delete`, `list --json` — `--pr` is reached through `rk riff -- --pr <n>`). The Recoverable tier names the `wt create --temp` / `wt delete`
worktree the run made itself.

- **GIVEN** the rendered Rules section
- **WHEN** it is read
- **THEN** `git worktree` appears nowhere and `wt create --temp`, `wt delete`, `wt list --json` appear in both lists

#### R4: Plain item PR base from the recorded base
For a `plain` item the rules SHALL state: its PR base is the `queue:` line's `base` when set; otherwise `base` for
the item's branch from `wt list --json` in the item's repo, read `origin/<b>` as `<b>`; a null `base` means the
repo's default branch.

- **GIVEN** a plain item whose `queue:` line carries no `base` and whose worktree branch has `base: "origin/eng-v2"`
- **WHEN** the run needs the item's PR base
- **THEN** it uses `eng-v2`

### Chat skill (`docs/site/skill/operator.md`, synced to `app/backend/cmd/rk/skill/operator.md`)

#### R5: Hand spawns via riff passthrough, tracked
The skill SHALL say a hand spawn (an agent the user explicitly asks the chat to start itself rather than queue) is
`rk riff -L <server> -- --base origin/<branch> --fetch`, then tracked with `rk operator track add <id> --kind pane
…`; it is not an engine queue item, so nothing may depend on it. A plain shell tab stays `rk tab new -- <cmd>`.

- **GIVEN** the user asks "start an agent on eng-v2 yourself"
- **WHEN** the chat reads the skill
- **THEN** it runs `rk riff -L <server> -- --base origin/eng-v2 --fetch` and `track add … --kind pane`

#### R6: Skill § Merging mirrors the run rules
The skill's § Merging SHALL carry the same `wt create --temp … --fetch --json` / `wt delete <name>` restack and
conflict wording and the `rk riff -L <server> -- --pr <n>` recovery spawn, with no `git worktree` text.

- **GIVEN** the skill topic
- **WHEN** it is compared with the run rules
- **THEN** both describe the same temporary-worktree and recovery-spawn commands

#### R7: `--reuse` gotcha
§ Gotchas SHALL carry a bullet: `wt` refuses `--reuse` with `--base` (and with `--fetch`), exit 2; pass `--reuse`
alone with `--name`, or drop it to start fresh from a base.

- **GIVEN** a chat composing `rk riff -- --reuse --base …`
- **WHEN** it reads § Gotchas
- **THEN** it knows the combination fails and which form to use

### Tests and memory

#### R8: Tests guard the text
`internal/operator/brief_test.go` SHALL assert the `wt create --temp <observed-head-sha> --fetch --json`, `wt delete`,
`-- --pr <n>` and plain-base text, and the absence of `git worktree add` / `git worktree remove` / `git worktree`
from the rules; `cmd/rk/skill_test.go` SHALL assert the operator topic carries `-- --base origin/<branch> --fetch`,
the `--reuse` gotcha and `wt create --temp`, and no `git worktree`. The skill drift guards stay green after sync.

- **GIVEN** a regression re-introducing `git worktree add --detach`
- **WHEN** `go test ./internal/operator/ ./cmd/rk/` runs
- **THEN** a test fails

#### R9: Memory reflects the rules
`docs/memory/run-kit/operator-brief.md` SHALL describe the new commands (rules summary, allowlists, § Merging,
plain-item base, the chat hand-spawn clause) and carry a Design Decision "Temporary worktrees go through `wt`".
(Done at hydrate.)

- **GIVEN** the memory file after hydrate
- **WHEN** it is grepped for `git worktree`
- **THEN** only the Design Decision's Rejected field mentions it

### Non-Goals

- No Go logic, CLI flag, API or UI change; riff/engine spawn path untouched (T9) — review bar: **must-fix** = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. **Should-fix** = everything else.
- No change to T11's merge-auto projection text or T12/T13 scope.

### Design Decisions

#### Temporary worktrees go through `wt`
**Decision**: Restack and conflict rounds use `wt create --temp <sha> --fetch --json` / `wt delete <name> --non-interactive`; a red-check recovery uses `rk riff -- --pr <n>`; `git worktree` is not an allowed run tool.
**Why**: Constitution III (wrap, don't reinvent); the temp worktree lands under `<repo>.worktrees/` where `wt list` sees it; one fetch-and-pin step and one cleanup verb; `--pr` resolves the head branch instead of the run guessing.
**Rejected**: raw `git fetch` + `git worktree add --detach <tmp>` + `git worktree remove` — invents a path outside `wt`'s view and leaves strays when a run dies mid-restack.
*Introduced by*: 261124-x56v-wt-temp-pr-recorded-base-rules

## Tasks

### Phase 2: Core Implementation

- [x] T001 Edit `app/backend/internal/operator/brief_rules.md`: allowlist + Recoverable tier + § Allowed tools drop `git worktree` and spell out `wt` verbs; § Merging `stacked-prs` steps use `wt create --temp … --fetch --json` / `wt delete <name> --non-interactive`; conflict paragraph and red-check recovery (`rk riff -L <server> -- --pr <n>`); plain-item PR base sentence in § Queue items that finish their intake <!-- R1 R2 R3 R4 -->
- [x] T002 Edit `docs/site/skill/operator.md` (§ Spawning agents hand-spawn paragraph, § Merging mirror, § Gotchas `--reuse` bullet), then run `scripts/sync-skill.sh` to copy into `app/backend/cmd/rk/skill/operator.md` <!-- R5 R6 R7 -->

### Phase 3: Integration & Edge Cases

- [x] T003 Update `app/backend/internal/operator/brief_test.go` (`TestBriefRules_CoverTheRunContract` wants; `TestRenderBrief_NoAutopilotSectionAndPRToolsRestored` gone-list gains `git worktree`) and add an operator-topic content test in `app/backend/cmd/rk/skill_test.go`; run `go test ./internal/operator/ ./cmd/rk/` <!-- R8 -->

### Phase 4: Polish

- [x] T004 Run the full Go test suite (`cd app/backend && go test ./...`) and confirm only the known host-only failures, if any <!-- R8 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `brief_rules.md` § Merging uses `wt create --temp <observed-head-sha> --fetch --json` and `wt delete <name> --non-interactive`; no `git worktree add|remove`; no separate `git fetch origin` restack step
- [x] A-002 R2: the red-check recovery spawn reads `rk riff -L <server> -- --pr <n>`
- [x] A-003 R3: neither the allowlist nor § Allowed tools lists `git worktree`; both list the `wt` verbs
- [x] A-004 R4: the plain-item rule states the `queue:` line → `wt list --json` `base` (`origin/` stripped) → default-branch order
- [x] A-005 R5: the skill's hand-spawn paragraph names `rk riff -L <server> -- --base origin/<branch> --fetch` and `track add … --kind pane`, and says nothing may depend on it
- [x] A-006 R6: the skill § Merging has the same `wt` commands as the rules and no `git worktree`
- [x] A-007 R7: § Gotchas carries the `--reuse` + `--base`/`--fetch` bullet
- [x] A-008 **N/A**: memory is written at hydrate (R9 "Done at hydrate"); hydrate verifies it — R9: `operator-brief.md` reflects the new commands and carries the Design Decision

### Scenario Coverage

- [x] A-009 R8: tests assert presence of the new text and absence of `git worktree` in rules and operator topic; `go test ./internal/operator/ ./cmd/rk/` passes; the skill copy is byte-identical to the canonical file

### Edge Cases & Error Handling

- [x] A-010 R1: the conflict-failure path removes the temp worktree with `wt delete` (no stray left by the documented flow)
- [x] A-011 R3: the rules file stays ≤ 40 960 bytes

### Code Quality

- [x] A-012 Pattern consistency: new rule text follows the existing `-L <server>` convention and tier wording
- [x] A-013 No unnecessary duplication: the skill mirrors the rules without adding a second, divergent procedure
- [x] A-014 New features and bug fixes include tests covering the changed behavior (text guards in both packages)
- [x] A-015 No comment narration or change-ID citations in test comments

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `wt create --temp <sha> --fetch --json` is valid and fetches; the explicit `git fetch origin` step is dropped | Verified in a scratch repo: exit 0, receipt `mode: temp` | S:90 R:85 A:95 D:90 |
| 2 | Certain | `wt-base` records `origin/<b>` for `--base origin/<b>`; rule reads `origin/<b>` as `<b>` | Verified in a scratch repo (`branch.b1.wt-base origin/main`) | S:85 R:90 A:95 D:85 |
| 3 | Certain | `wt delete <name> --non-interactive` removes a temp worktree without prompts | Verified in a scratch repo | S:85 R:90 A:95 D:90 |
| 4 | Confident | Recovery spawn form is `rk riff -L <server> -- --pr <n>` | riff's CLI path adds no `--base`, so `--pr` passes through cleanly; Brief names `wt create --pr <n>` | S:75 R:85 A:80 D:70 |
| 5 | Confident | Hand spawn is tracked with `track add --kind pane` but is not a queue item | Brief's "tracked with `track add`"; no-dependency follows from it not being an engine entry | S:65 R:80 A:65 D:60 |

5 assumptions (3 certain, 2 confident, 0 tentative).
