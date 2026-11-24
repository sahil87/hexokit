# Plan: One group per plan — `autopilot queue --group`

**Change**: 261124-latu-queue-group-per-plan
**Intake**: `intake.md`

## Requirements

### Engine: Queue group stamp

#### R1: `queue --group` stamps every item of the call
`rk operator autopilot queue` SHALL accept `--group <name>`. When non-empty, `Enqueue` SHALL stamp `group: <name>` on every item written by that call, stored in the engine file (`engineItem.Group`, YAML/JSON key `group`, `omitempty`) and round-tripped through `engineItemFromTracked` / `engineItem.tracked()` exactly as `queue`/`merge_mode` are (scope key `group`). Items of earlier queue calls SHALL keep their own group (or none). Without `--group` no `group` key SHALL be written and behavior SHALL be unchanged.

- **GIVEN** an empty engine file
- **WHEN** `queue --group operator-triggers` writes entries `a`, `b` (any repos)
- **THEN** both engine items carry `group: operator-triggers`
- **AND** a later `queue` call without `--group` writes items with no `group` key and leaves `a`/`b` untouched

#### R2: Group name validation
A non-empty group SHALL pass `validate.ValidateNewName(name, "Group name")` and SHALL NOT start with `tmux.ReservedSessionPrefix` (`_rk-`). A failure SHALL be an `InvalidError` (usage, exit 2) raised before any write, including under `--dry-run`. An explicitly empty `--group ""` SHALL be refused as usage (mirroring `--mode must not be empty`).

- **GIVEN** `queue --group "_rk-x"` (or `"a b"`, `"a:b"`, `"a.b"`, `"a;b"`)
- **WHEN** it runs, with or without `--dry-run`
- **THEN** it exits 2 with a message naming the group, and the engine file is unchanged

#### R3: Receipt names the group
`QueueReceipt` SHALL carry `group` (`json:"group,omitempty"`), and the human receipt SHALL print a `group: <name>` line next to the `mode:` line when set.

- **GIVEN** `queue --group g --dry-run`
- **WHEN** the receipt prints
- **THEN** it shows `group: g` (human) / `"group": "g"` (`--json`)

### Engine: Spawn lands in the group

#### R4: Spawn and respawn use the item's group as the landing session
Both the fresh-spawn and the respawn path in `internal/autopilot/spawn.go` SHALL use the item's stored `group` as `SpawnRequest.Session` when non-empty, without calling `Env.Session`; when empty they SHALL call `Env.Session(ctx, repo)` exactly as today. A grouped request SHALL set `SpawnRequest.EnsureSession = true`. Cross-repo items of one queue share the group.

- **GIVEN** a queued item with `group: g` whose dependencies are satisfied
- **WHEN** a pass spawns it (or respawns it after its pane died)
- **THEN** the spawner receives `Session: "g"`, `EnsureSession: true`, and the attach records `session: g`
- **AND** an item without a group gets the `Env.Session` value and `EnsureSession: false`

#### R5: The group session is created on demand, joined when present
The production `RiffSpawner` SHALL, for a request with `EnsureSession`, ensure the session exists before opening the window via a new exported `internal/tmux` wrapper over the existing `ensureSessionCapturingPlaceholder` (`EnsureSessionOnServer(ctx, server, session) (placeholder string, err error)`). An existing session SHALL be joined (no create, no error). When the session was just created, its placeholder window SHALL be killed best-effort after the spawn attempt returns (success or failure), so the group holds only agent tabs and a failed spawn leaves no empty session. An ensure failure SHALL fail the spawn before any worktree or window is created. `--dry-run` SHALL create nothing.

- **GIVEN** no tmux session `g` on the server
- **WHEN** a grouped item spawns
- **THEN** session `g` is created, the agent window opens in it, and the placeholder window is gone
- **GIVEN** an existing session `g` with other windows
- **WHEN** a grouped item spawns
- **THEN** the window joins `g` and no existing window is killed

### Engine: Status

#### R6: `status` shows the group
`StatusItem` SHALL carry `Group string \`json:"group,omitempty"\``; the human `status` line SHALL append ` · group <name>` when set (after ` · plain` / ` · base <b>`).

- **GIVEN** a grouped item and an ungrouped item
- **WHEN** `status` / `status --json` runs
- **THEN** the grouped row ends with ` · group g` and its JSON has `"group": "g"`; the ungrouped row and JSON have neither

### CLI surface and docs

#### R7: Help text
The `queue` command's `Use`, Long (flag list, a paragraph on `--group`, Exit codes 2 list "invalid group") and the `status` Long (`--json` items carry `group`) SHALL describe the flag; the flag registration SHALL have a help string.

- **GIVEN** `rk operator autopilot queue --help`
- **WHEN** read
- **THEN** it documents `--group <name>`, its validation, and that spawns land in that tmux session (created if absent, joined if present)

#### R8: Chat skill § Plans names the group
`docs/site/skill/operator.md` § Plans SHALL say: a plan queue passes `--group <plan slug without date prefix>` (e.g. `26-11-20-operator-triggers.md` → `operator-triggers`) or the user's name for it, on every `queue` call of that plan; ad-hoc queues get no group unless asked; the confirmation line names the group; a finished lane's tab stays in its group. `app/backend/cmd/rk/skill/operator.md` SHALL be re-synced (`scripts/sync-skill.sh`).

- **GIVEN** the chat is asked to execute a plan file
- **WHEN** it follows § Plans
- **THEN** its `queue` call carries `--group <slug>` and its report says `… in group <slug>`

#### R9: Operator addendum retires the `completed` move for plan queues
`fab/project/operator.md` § Operator duties SHALL state that a lane spawned by a grouped (plan) queue stays in its group after merge (the done marker is the signal); the `completed`-group move applies only to ungrouped lanes.

- **GIVEN** a plan lane's PR merged
- **WHEN** the operator follows the addendum
- **THEN** it does not move the tab out of the plan's group

### Non-Goals

- No moving of finished tabs (no `<group>-done`, no automatic `completed` move).
- The engine never reads plan files.
- No change to per-mode spawn shape, chaining, the pass lock, or the engine-file schema beyond the additive `group` key.
- No UI/sidebar change; no API endpoint (autopilot verbs have none).
- No `--group` on other verbs; no re-grouping of queued items.
- Review bar (plan Rule 4): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.

### Design Decisions

#### A plan is a group
**Decision**: `rk operator autopilot queue --group <name>` stamps a tmux session name on every item of the call; spawn and respawn open the item's window in that session, creating it on demand (placeholder window removed) and joining it when it exists. The chat names the group after the plan file's slug.
**Why**: Spawns landed in the role-aware default session, so parallel plans interleaved their tabs in one sidebar group with nothing saying which plan a tab belonged to; the UI already calls a tmux session a Group. Stamping at queue time keeps the engine plan-agnostic and durable (engine file), and the existing `SpawnRequest.Session` seam already carries the landing session.
**Rejected**: the engine parsing plan files (couples the deterministic engine to a document format); moving finished tabs to a `completed` or `<group>-done` session (the done marker already signals completion; revisit only if a long plan's group gets crowded).
*Introduced by*: 261124-latu-queue-group-per-plan

## Tasks

### Phase 1: Setup

- [x] T001 [P] Add `EnsureSessionOnServer(ctx, server, session string) (string, error)` to `app/backend/internal/tmux/tmux.go` (bounded by `TmuxTimeout`, `serverArgs(server)` prefix, delegating to `ensureSessionCapturingPlaceholder`); doc comment states the placeholder contract <!-- R5 -->

### Phase 2: Core Implementation

- [x] T002 Add `Group` to `QueueOptions` and `QueueReceipt` (`app/backend/internal/autopilot/queue.go`), a `scopeGroup = "group"` constant, validation (`ValidateNewName` + `_rk-` refusal, empty-but-set refusal) before any write in `enqueue`, and stamping in `buildQueue`'s scope map; add `Group` to `engineItem` and both mappings in `app/backend/internal/autopilot/enginefile.go` <!-- R1 R2 R3 -->
- [x] T003 Add `EnsureSession bool` to `SpawnRequest` (`app/backend/internal/autopilot/autopilot.go`); in `app/backend/internal/autopilot/spawn.go` add a small `landingSession(ctx, it, repo)` helper used by both spawn and respawn (group ⇒ group + ensure; else `Env.Session`) <!-- R4 -->
- [x] T004 In `app/backend/internal/autopilot/riffspawn.go`, when `req.EnsureSession`, call `tmux.EnsureSessionOnServer` before `riff.SpawnObserved` (error ⇒ return, nothing created) and kill a non-empty placeholder best-effort after it returns <!-- R5 -->
- [x] T005 Add `Group` to `StatusItem` (`app/backend/internal/autopilot/step.go`, filled from scope) and the ` · group <name>` suffix in `runAutopilotStatus` (`app/backend/cmd/rk/operator_autopilot.go`) <!-- R6 -->
- [x] T006 Register `--group` on `queue`, pass it into `QueueOptions` (with set-detection like `--mode`), print `group: <name>` in the human receipt, and update `queue`/`status` help text (`app/backend/cmd/rk/operator_autopilot.go`, plus wherever `runAutopilotQueue` lives) <!-- R3 R7 -->

### Phase 3: Integration & Edge Cases

- [x] T007 Tests in `app/backend/internal/autopilot/` (`queue_test.go`, `spawn_test.go`, `status_test.go`, `enginefile_test.go`): stamping across a call and not across calls, engine-file round trip, validation table (dry-run included, nothing written), spawn and respawn send `Session: g`/`EnsureSession: true` via `fakeSpawner.reqs`, ungrouped unchanged, status JSON/human field <!-- R1 R2 R4 R6 -->
- [x] T008 Tests: `app/backend/internal/tmux` unit test for the ensure wrapper's argv/prefix composition where feasible without a live server; `app/backend/cmd/rk/operator_autopilot_test.go` for `--group` reaching `QueueOptions`, receipt line, usage exit on a bad group, status suffix <!-- R3 R5 R6 R7 -->

### Phase 4: Polish

- [x] T009 [P] Update `docs/site/skill/operator.md` § Plans (and the Queues section where `queue` flags are listed) per R8; run `scripts/sync-skill.sh` so `app/backend/cmd/rk/skill/operator.md` matches; update `fab/project/operator.md` per R9 <!-- R8 R9 -->

## Execution Order

- T001 blocks T004; T002 blocks T003, T005, T006; T003 blocks T004
- T007/T008 after their implementation tasks; T009 independent

## Acceptance

### Functional Completeness

- [x] A-001 R1: `queue --group g` stamps `group: g` on every engine item of that call, persisted and reloaded; other calls' items unaffected
- [x] A-002 R2: invalid or reserved group names are usage errors (exit 2) before any write, under `--dry-run` too
- [x] A-003 R3: the receipt shows the group in human and JSON forms
- [x] A-004 R4: spawn and respawn pass the item's group as `SpawnRequest.Session` with `EnsureSession: true`; ungrouped items still use `Env.Session`
- [x] A-005 R5: `RiffSpawner` ensures the session via the exported `internal/tmux` wrapper, joins an existing one, and kills only the placeholder it created
- [x] A-006 R6: `status` human row and `--json` carry the group, omitted when unset
- [x] A-007 R7: `queue` and `status` help text document `--group`
- [x] A-008 R8: skill § Plans updated and synced copy byte-identical
- [x] A-009 R9: `fab/project/operator.md` no longer instructs moving plan-queue lanes to `completed`

### Behavioral Correctness

- [x] A-010 R4: a queue without `--group` produces byte-identical engine items and spawn requests to before (existing tests unchanged and green)

### Scenario Coverage

- [x] A-011 R4: a test drives a grouped item through spawn and a respawn and asserts the recorded `Session`
- [x] A-012 R2: a table test covers `_rk-` prefix, space, `:`, `.`, forbidden char, explicit empty

### Edge Cases & Error Handling

- [x] A-013 R5: an ensure failure fails the spawn with no worktree/window and the item stays pending (spawning cleared) with an escalation
- [x] A-014 R5: a spawn failure after a fresh session creation leaves no empty session (placeholder killed ⇒ session gone)

### Code Quality

- [x] A-015 Pattern consistency: new fields/flags follow the `plain`/`base`/`merge_mode` patterns (scope constants, omitempty, status suffix)
- [x] A-016 No unnecessary duplication: session creation reuses `ensureSessionCapturingPlaceholder`; no new tmux create path; tmux calls stay in `internal/tmux`
- [x] A-017 Process execution: every new tmux call is bounded by a context timeout and uses argv slices
- [x] A-018 No comment narration: comments state constraints only, no change IDs/PR numbers
- [x] A-019 Tests: new behavior covered by Go unit tests; `cd app/backend && go test ./internal/autopilot/... ./internal/tmux/... ./cmd/rk/...` green apart from the plan's known host-only failures

### Security

- [x] A-020 R2: the group name is validated before it reaches any tmux argv (Constitution I)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- Known host-only failures (plan § Current state): `cmd/rk` `TestPortPinRowRealPolicyValues`, `rk/api` `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`.

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant (the `completed`-group move in `fab/project/operator.md` stays for ungrouped lanes; `ensureDetachedSession` is untouched and still used by `EnsureOperatorSession`)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Ensure happens in `RiffSpawner` behind a `SpawnRequest.EnsureSession` flag rather than inside the `Env.Session` seam | The placeholder can only be killed after the window opens, which is the spawner's moment; keeps engine tests on fakes | S:70 R:85 A:80 D:65 |
| 2 | Confident | Placeholder killed after the spawn attempt regardless of outcome | Matches the board.go/operator-session precedent; on failure it removes the otherwise-empty session | S:60 R:85 A:80 D:70 |
| 3 | Confident | Explicit `--group ""` is a usage error | Mirrors `--mode must not be empty` in `enqueue` | S:60 R:90 A:85 D:75 |
| 4 | Certain | No help-dump fixture files to regenerate | `rk help-dump` is generated at runtime from cobra; no committed fixtures exist (`cmd/rk/help_dump_test.go` uses a synthetic tree) | S:80 R:95 A:90 D:90 |
| 5 | Confident | `QueueOptions` carries `GroupSet` beside `Group` (as `ModeSet` beside `Mode`), and group tests live in one new `internal/autopilot/group_test.go` plus the CLI and tmux test files | Explicit empty `--group ""` needs set-detection; one file keeps the group scenarios together without touching sibling tests | S:70 R:90 A:85 D:75 |
| 6 | Confident | The ensure wrapper's test runs against a private `rk-test-*` tmux socket (existing `withSessionOrderTmux` helper), not a pure argv test | Placeholder-kill leaving no session is tmux behavior; the helper skips when tmux is absent and never touches the user's server | S:70 R:90 A:85 D:75 |

6 assumptions (1 certain, 5 confident, 0 tentative).
