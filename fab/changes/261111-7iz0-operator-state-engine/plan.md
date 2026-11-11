# Plan: Operator State Engine

**Change**: 261111-7iz0-operator-state-engine
**Intake**: `intake.md`

## Requirements

### Operator State: Schema and Store

#### R1: Typed tracked-item schema
`internal/operator` SHALL define the tracked-item schema ported from fab (`operator_track_types.go`): kinds `pane, github-pr, linear, slack, shell, task, note`; each kind allows exactly its default probe mode; the ported caps/constants (`seen` cap 200, `check_every` floor 1m and default `5m`, failure-pause cap 3, staleness multiplier 2); YAML key order pinned by struct order; JSON tags mirror YAML. The `text` field and `clock_override` SHALL NOT exist.

- **GIVEN** an item of kind `github-pr` with no probe override
- **WHEN** it is validated
- **THEN** its probe mode is `shell`, `done_when` defaults to `state == "MERGED"`, and fields default to `state,mergedAt,mergeable`
- **AND** a kind given a non-default probe mode is rejected

#### R2: done_when predicate grammar
The package SHALL include the equality-only `done_when` grammar (`Parse`, `Eval`; clauses joined by ` and `, `==`/`!=`, JSON-scalar literals, dotted paths, absent path = null), ported with its tests.

- **GIVEN** `state == "MERGED" and mergeable != null`
- **WHEN** parsed and evaluated against `last`
- **THEN** it is true only when both clauses hold; `or`, `<`, regex are parse errors

#### R3: Tolerant read, typed write
`Load` SHALL return an empty state for a missing file, a hard error naming the path for an unparsable file, and SHALL NOT lock or write. Mutations SHALL re-marshal only the owned sections (`tracked`, `branch_map`) from typed structs so drift inside `tracked` is dropped, while unknown top-level keys survive.

- **GIVEN** a file with an unknown top-level key and an invented field inside a tracked item
- **WHEN** any mutation runs
- **THEN** the top-level key survives and the invented item field is gone

#### R4: Path, slug, permissions
The state file SHALL live at `<apphome.StateDir()>/operator/<slug>.yaml`, where `<slug>` uses the same injective socket-path rule as `cron.FabOperatorSlug` (`default` when the socket path cannot be queried). The directory SHALL be mode `0700` and files `0600`.

- **GIVEN** `XDG_STATE_HOME=/x` and a server whose socket path is `/tmp/tmux-1000/runKit`
- **WHEN** the path is resolved
- **THEN** it is `/x/hexokit/operator/tmp-tmux--1000-runKit.yaml`

#### R5: Locked, atomic, durable writes
`Mutate(path, fn)` SHALL acquire an exclusive `flock` on the sidecar `<slug>.yaml.lock` (polling non-blocking for at most 5 s, then failing with a "state file busy" error), re-read the file inside the lock, apply `fn`, write with `fsatomic.WriteFile`, and release the lock on every return path. An `fn` error SHALL write nothing. Success is returned only after the rename. The lock SHALL NOT be taken on the data file itself.

- **GIVEN** two goroutines each appending a note to the same item
- **WHEN** both run concurrently
- **THEN** both notes are present afterwards
- **AND** a held lock past the timeout yields an error and no write

#### R6: Library-owned timestamps
`added_at`, `updated_at`, `checked_at` and note `at` SHALL be computed in the library as RFC3339 UTC through an injectable clock; no verb accepts a timestamp.

### Operator State: Notes

#### R7: Append-only capped notes
Each item SHALL carry `notes []{at, by, text}` (omitempty). `by` SHALL be one of `user|run|chat`; `text` SHALL be non-empty after trimming and at most 1000 runes (over-length is an error, never truncated). At most 50 notes are kept per item, pruning oldest first. Appending touches `updated_at`. There is no per-note delete; notes leave only by cap pruning or removal of the item.

- **GIVEN** an item holding 50 notes
- **WHEN** a 51st is appended
- **THEN** the oldest is dropped and the newest is last
- **AND** a 1001-rune note or an unknown `by` is rejected

### Operator State: `rk operator track`

#### R8: Verb set and flags
`rk operator track` SHALL provide `add`, `update`, `observe`, `rm`, `list`, `note`, `pause`, `resume`, each accepting `-L/--server` (default: caller's `$TMUX` server, as `rk operator request`), with `--json` where output exists and exit codes 0/1/2 (ok/operational/usage). `track clock`, `update --text/--pause/--resume` SHALL NOT exist.

#### R9: add
`add <id> --kind <k>` SHALL apply the ported validation: known kind; kind-allowed probe; shell kind requires `--argv` + `--fields` and `--done-when`; `done_when` parses; unique id; `depends_on` exist and are not self; `check_every` normalization (null for pane/none, default 5m, floor 1m). `github-pr` SHALL build `gh pr view <n> [--repo <nwo>] --json state,mergedAt,mergeable` from `scope.pr` (the `gh repo view` lookup being an injectable, timeout-bounded, argv-only seam; failure is an add-time error). Pane items SHALL seed the eleven pinned scope keys, accept the pane sugar flags, record `scope.pane_pid` via `tmux.PanePIDCtx` (any failure ⇒ null), and write `branch_map` when both `branch` and `repo` are set (keyed by `--change` else the id). `kind note` requires `--text` (+ `--by`, default `user`) and creates the item with its first note. `--mode` is validated against `cherry-pick-ladder|stacked-prs|merge-auto`; when omitted `scope.merge_mode` stays null and no config is read.

- **GIVEN** `track add n1 --kind note --text "remember X"`
- **WHEN** it succeeds
- **THEN** item `n1` exists with one note `{by: user, text: "remember X"}`

#### R10: update, observe, pause, resume, rm
`update` SHALL change cadence/predicate/`then`/`depends_on`/scope (merged per key; a `scope.pane` change re-fingerprints). `observe` SHALL take exactly one of `--json`/`--error`, store `last` per `probe.fields` (dotted paths, absent ⇒ null), bump `unchanged` or reset it, count failures (third consecutive ⇒ `paused`), and prune `seen` to 200. `pause` sets `paused`; `resume` clears it and zeroes `failures`. `rm` SHALL delete the item and, when it was done, drop it from every dependent's `depends_on`; `branch_map` is untouched.

#### R11: note
`note <id> <text> [--by user|run|chat]` SHALL append a note (R7); `<text>` of `-` reads stdin.

#### R12: list
`list` SHALL be a pure read (never writes or converts) printing one line per item `id · kind · state · checked-age · next` with the ported state derivation (done, paused, held, pending, stale, live, watching), `--kind` filter, and `--json` printing the full items including notes.

### Operator State: `rk operator adopt`

#### R13: Read-only, explicit import
`adopt [--from <path>] [-L server] [--dry-run] [--json]` SHALL read fab's state file (default `cron.FabOperatorStatePath(cron.FabOperatorSlug(socketPath))`) read-only — never writing, locking, renaming or converting it. A missing source SHALL print `nothing to adopt (no fab operator state at <path>)`, exit 0, and create no rk file. No other code path SHALL invoke adopt.

- **GIVEN** a fab file
- **WHEN** adopt runs
- **THEN** the fab file's bytes are identical before and after

#### R14: Legacy conversion in memory
Adopt SHALL convert, on the parsed map, the legacy `monitored`/`watches`/`autopilot`/`notes` shapes and retired `kind: fab-change` items exactly as fab's `operator_migrate.go`; a running legacy autopilot queue SHALL refuse with exit 1 and write nothing.

#### R15: Notes seed, drops, carries
For every fab `kind: note` item the old `text` SHALL become the first note `{at: updated_at (fallback added_at), by: user, text}` and the `text` field SHALL NOT be carried. `clock_override` SHALL be dropped; `branch_map` SHALL be carried (added only for absent keys); unknown top-level keys of fab's file are ignored.

#### R16: Merge, never clobber
Adopt SHALL run through `Mutate`, match items by id, leave ids already present untouched (reporting them skipped), and append absent ids in fab's order. An invalid converted item SHALL be skipped with a named warning, not fatal; legacy note text over the caps SHALL be trimmed (newest 50 notes, 1000 runes) with a warning. `--dry-run` computes everything and writes nothing (no directory, no lock). Output: `adopted <n> item(s), skipped <m> (already present)[, <k> invalid]` plus one line per skipped/invalid id; `--json` emits `{source,target,adopted,skipped,invalid:[{id,reason}],dry_run}`.

- **GIVEN** rk already holds item `a` and fab holds `a` and `b`
- **WHEN** adopt runs twice
- **THEN** `a` is untouched, `b` is added once, and the second run adopts 0

### Non-Goals

- The check/probe runner, the loop, the run brief, the drawer/sessions payload reader, UI, MCP table rows, cron/daemon changes (R2–R5).
- Falling back to fab's file on read (R3); any automatic adopt.
- `branch-map rm`, per-note delete, merge-mode config resolution (R6).

### Design Decisions

#### Sidecar lock, locked re-read, lock-free reads
**Decision**: Writers hold `flock` on `<slug>.yaml.lock` and re-read inside it; readers take no lock.
**Why**: `fsatomic` replaces the data file by rename (a lock on it would be orphaned); atomic rename gives readers a complete file; re-read makes external writes win (Constitution II).
**Rejected**: Locking the data file (broken by rename); in-memory cache (violates durable-before-acknowledged).
*Introduced by*: 261111-7iz0-operator-state-engine

#### Notes replace `text`; `kind: note` stays
**Decision**: Prose lives only in `notes`; a note item is an item whose content is its notes list; adopt turns old `text` into the first note.
**Why**: One concept (plan Decisions) and one place for prose.
**Rejected**: Keeping both `text` and `notes` (two concepts).
*Introduced by*: 261111-7iz0-operator-state-engine

## Tasks

### Phase 1: Setup

- [x] T001 Create `app/backend/internal/operator/schema.go`: constants, kinds table, `probeSpec`, `TrackedItem` (with `Notes`, no `Text`), `Note`, `State`, `branchMapEntry`; port `operator_track_types.go` helpers (`normalizeCheckEvery`, `validateTrackedItem`, `validateTrackedDeps`, done/held/stale/scope helpers) <!-- R1 -->
- [x] T002 [P] Create `app/backend/internal/operator/predicate.go` + `predicate_test.go` ported from fab `internal/predicate` <!-- R2 -->
- [x] T003 Decide slug reuse: confirm `internal/operator` can import `internal/cron` (`FabOperatorSlug`, `FabOperatorStatePath`) without a cycle; otherwise extract the two pure funcs preserving behavior and cron tests <!-- R4 -->

### Phase 2: Core Implementation

- [x] T004 Create `app/backend/internal/operator/store.go`: `StatePath(socketPath)`, tolerant `Load`, typed `Save` via `fsatomic`, sidecar `flock` with 5 s poll timeout, `Mutate`, injectable clock, 0700/0600 modes <!-- R3 R4 R5 R6 -->
- [x] T005 Create `app/backend/internal/operator/track.go`: library ops `Add`, `Update`, `Observe`, `Remove`, `Pause`, `Resume`, `AddNote` (50/1000 caps, `by` validation), `List` + list-line helpers (state/age/next), github-pr argv builder and pane-pid/`gh` seams <!-- R7 R9 R10 R11 R12 -->
- [x] T006 Create `app/backend/internal/operator/adopt.go`: read-only fab-file load, in-memory legacy conversion (port `operator_migrate.go`: monitored/watches/autopilot/notes/fab-change, running-queue refusal), notes seeding, merge-by-id, warnings, dry-run, result struct <!-- R13 R14 R15 R16 -->
- [x] T007 Create `app/backend/cmd/rk/operator_track.go`: cobra `track` with `add|update|observe|rm|list|note|pause|resume`, `-L/--server`, `--json`, exit codes, help text with Examples/Exit codes (no backticks in flag help); register via `operatorCmd.AddCommand` in `cmd/rk/operator.go` <!-- R8 R9 R10 R11 R12 -->
- [x] T008 Create `app/backend/cmd/rk/operator_adopt.go`: cobra `adopt` with `--from --dry-run --json -L`, output forms, exit codes <!-- R13 R16 -->

### Phase 3: Tests and Integration

- [x] T009 [P] Port tests: `schema_test.go` ← `operator_track_types_test.go`; `track_test.go` ← `operator_track_test.go` (seams injected); `adopt_test.go` ← `operator_migrate_test.go` — all on `t.TempDir()` + `t.Setenv("XDG_STATE_HOME")`, never live state/daemon/tmux <!-- R1 R9 R10 R12 R14 -->
- [x] T010 [P] New tests `app/backend/internal/operator/store_test.go` + `notes_test.go`: missing/unparsable file, unknown-top-level survival, in-section drift dropped, modes, lock timeout writes nothing, concurrent `AddNote` loses none, 50-cap pruning, 1000-rune error, `by` validation, `rm` drops notes, list `--json` includes notes <!-- R3 R5 R7 R12 -->
- [x] T011 [P] New adopt tests: fab file byte-identical (hash), `--dry-run` writes nothing, missing source exit 0 and no file, re-adopt idempotent, existing rk item not overwritten, note `text`→first note, `clock_override` dropped, `branch_map` carried, running-queue refusal, invalid item skipped with warning <!-- R13 R14 R15 R16 -->
- [x] T012 CLI tests in `app/backend/cmd/rk/operator_track_test.go` and `operator_adopt_test.go` (flag validation, exit codes 0/1/2, `--json` shapes; `operator_request_test.go` pattern) and update help-dump fixtures/tests for the new subcommands; check `shll standards` for CLI-surface standards <!-- R8 R13 -->
- [x] T013 Run `cd app/backend && go vet ./... && go test ./...` and fix regressions <!-- R1 -->

### Phase 4: Polish

- [x] T014 Review all new files for comment discipline (constraints only, no change IDs/narration) and magic numbers named <!-- R1 -->

## Execution Order

- T001 blocks T004–T006; T002 blocks T001's `done_when` validation compile (do T002 first or together)
- T004 blocks T005 and T006; T005/T006 block T007/T008
- Phase 3 tests follow their code

## Acceptance

### Functional Completeness

- [x] A-001 R1: `internal/operator` exposes the schema, kinds table and caps; no `text` or `clock_override` field exists
- [x] A-002 R2: Predicate grammar parses/evaluates with ported tests passing
- [x] A-003 R3: Load/save tolerant-read typed-write behavior verified by tests
- [x] A-004 R4: Path resolves to `<state>/hexokit/operator/<slug>.yaml`, modes 0700/0600
- [x] A-005 R5: Mutate takes the sidecar lock with a 5 s timeout and re-reads inside it
- [x] A-006 R7: Notes append-only, 50/1000 caps, `by` validated, no delete verb
- [x] A-007 R8: All eight verbs exist; `track clock` and update pause/text flags do not
- [x] A-008 R9: `add` validation, github-pr argv, pane fingerprint, branch_map, note first-note, `--mode` validation behave as specified
- [x] A-009 R10: update/observe/pause/resume/rm semantics (failure pause, done-dep edge drop) hold
- [x] A-010 R12: `list` is read-only and `--json` includes notes
- [x] A-011 R13: `adopt` never modifies the fab file and creates no rk file when the source is absent
- [x] A-012 R14 R15: Legacy shapes convert in memory; note text seeds first note; `clock_override` dropped; `branch_map` carried
- [x] A-013 R16: Adopt merges by id, is idempotent, supports `--dry-run`/`--json`, skips invalid items with warnings

### Behavioral Correctness

- [x] A-014 R5: Two concurrent writers both land; lock contention past timeout errors without writing
- [x] A-015 R6: Timestamps come from the injectable clock; no flag accepts one

### Scenario Coverage

- [x] A-016 R16: Re-running adopt reports 0 adopted and N skipped
- [x] A-017 R14: A legacy file with a running autopilot queue exits 1 and writes nothing

### Edge Cases & Error Handling

- [x] A-018 R3: Unparsable state file errors naming the path; missing file is empty
- [x] A-019 R9: `gh repo view` failure is an add-time error; pane_pid lookup failure stores null
- [x] A-020 R8: Usage errors exit 2; operational errors exit 1

### Code Quality

- [x] A-021 Pattern consistency: New code follows naming and structural patterns of surrounding code (`cmd/rk/operator_request.go`, `internal/cron`)
- [x] A-022 No unnecessary duplication: `fsatomic`, `apphome`, `cron.FabOperatorSlug`, `tmux.PanePIDCtx` reused; no second slug rule
- [x] A-023: All subprocess calls use `exec.CommandContext` with argv slices and timeouts
- [x] A-024: No magic strings/numbers — constants named
- [x] A-025: Comments state constraints only (no narration, no change IDs)
- [x] A-026: New behavior covered by tests; `go test ./...` passes

### Security

- [x] A-027 R5 R13: State/lock files 0600 in a 0700 dir; no shell strings; fab's file opened read-only

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant (`internal/cron/watchlist.go`'s tolerant reader of fab's file stays until R3 by design)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Library lives in one package `internal/operator`, single flat file set | Matches sibling packages (`internal/cron`) | S:70 R:80 A:85 D:80 |
| 2 | Confident | Lock timeout 5 s, poll interval ~25 ms | Process Execution rule requires bounded waits; value is judgment | S:60 R:90 A:80 D:70 |
| 3 | Confident | `by` default for `note`/`add --text` is `user` | Intake A7; skills pass `chat`/`run` explicitly in R4 | S:75 R:85 A:80 D:75 |
| 4 | Confident | Lane: FULL (14 tasks > 5), apply dispatched | Pipeline rule | S:90 R:90 A:95 D:90 |

4 assumptions (0 certain, 4 confident, 0 tentative).
