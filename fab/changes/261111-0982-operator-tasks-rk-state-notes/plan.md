# Plan: Operator Tasks Reads rk Operator State, Shows Notes

**Change**: 261111-0982-operator-tasks-rk-state-notes
**Intake**: `intake.md`

## Requirements

### Backend: Operator state source selection

#### R1: rk's state file is the primary source; fab's file is the fallback
`sessions.FetchSessions` SHALL resolve the operator state file per server from the same slug (`cron.FabOperatorSlug(socketPath)`, `"default"` when the socket-path query fails) as two candidates: rk's `<apphome.StateDir()>/operator/<slug>.yaml` (identical to `operator.StatePath(socketPath)`) and fab's `cron.FabOperatorStatePath(slug)`. When rk's file exists on disk (`os.Stat` succeeds), it SHALL be the only file read for that fetch. Otherwise fab's file SHALL be read exactly as today. The read path MUST NOT create, lock, convert, or write either file, and MUST NOT adopt. `internal/cron` MUST NOT import `internal/operator`.

- **GIVEN** a server with an rk operator file and a fab operator file
- **WHEN** the sessions payload is built
- **THEN** `operatorTracked`, the watchlist join and the tick facts come from rk's file only
- **AND** fab's file is not read

- **GIVEN** a server with only a fab operator file
- **WHEN** the sessions payload is built
- **THEN** the payload is what it is today (except the note projection of R4)

#### R2: Present-but-empty rk file wins; corrupt rk file does not fall back
An rk file that exists but tracks nothing (empty file, or `tracked: []`) SHALL yield `operatorTracked: []` (present, empty) and SHALL NOT fall back to fab's file. An rk file that exists but fails to parse SHALL degrade to nil `OperatorTracked` (key omitted), no watchlist join, and tick 0. It SHALL NOT fall back to fab's file.

- **GIVEN** an empty rk file and a fab file with items
- **WHEN** the payload is built
- **THEN** `operatorTracked` is `[]`
- **GIVEN** a corrupt rk file and a valid fab file
- **WHEN** the payload is built
- **THEN** `operatorTracked` is absent and no window is `monitored`

### Backend: Tolerant reader

#### R3: The reader parses per-item notes and maps fab's text to a note
`cron.ParseOperatorState` SHALL parse each tracked item's `notes:` list into `TrackedItem.Notes []Note` (`Note{At int64, By string, Text string}`, with `at` parsed via `parseTickAt`), in file order. Non-map elements and elements with an empty `text` SHALL be skipped. When an item of kind `note` carries a non-empty `text` and has no parsed notes, the reader SHALL synthesize one note `{At: updated_at, else added_at, By: "user", Text: text}`, mirroring `operator.convertItem`. Kind values (`pane`, `fab-change`, …) SHALL pass through verbatim and SHALL NOT filter. `last_tick_at` SHALL be read from whichever file was chosen.

- **GIVEN** an rk item with three notes (`by` user/run/chat)
- **WHEN** parsed
- **THEN** `Notes` holds three entries oldest→newest with unix `At`
- **GIVEN** a fab `note` item with `text: "archive once merged"` and no `notes`
- **WHEN** parsed
- **THEN** `Notes` is one `{By: "user", Text: "archive once merged"}` at `updated_at`
- **GIVEN** an rk `kind: pane` item with `scope.pane: "%5"` and `done_at: null`
- **WHEN** `WatchlistEntries()` runs
- **THEN** it is included

### Backend: Sessions payload

#### R4: Payload carries latest note and count only
`OperatorTrackedItem` SHALL carry `latestNote` (`{at, by, text}`: the newest note, omitted when the item has none) and `noteCount` (omitted when 0). It SHALL NOT carry the full notes list, and SHALL NOT carry `text`.

- **GIVEN** an item with 4 notes
- **WHEN** projected
- **THEN** `latestNote` is the 4th note and `noteCount` is 4
- **GIVEN** an item with no notes
- **WHEN** projected
- **THEN** both keys are omitted from the JSON

### Backend: Notes route

#### R5: `GET /api/operator/notes` serves one item's full notes
`GET /api/operator/notes?server=<slug>&id=<item-id>` SHALL return `200 {"id", "notes": [{at, by, text}, …]}` oldest→newest, read through the same source selection as R1/R2. It SHALL return 400 when `id` is missing or empty, and 404 when no file is present, the chosen file is corrupt, or no item has that id. `server` SHALL resolve through `serverFromRequest`. `id` SHALL only be compared for equality and never used in a path. No mutating route is added.

- **GIVEN** an rk file whose item `x` has two notes
- **WHEN** `GET /api/operator/notes?id=x`
- **THEN** 200 with both notes in file order
- **WHEN** `id` is absent
- **THEN** 400
- **WHEN** `id=nope`
- **THEN** 404

### Frontend: Operator Tasks note column

#### R6: Item rows show the latest note and expand to all notes
In `WatchedTable`, an item row's note cell SHALL show `latestNote.text` truncated with a ` · {by} · {age} ago` suffix (age computed at render from `nowSeconds`) and a `+{noteCount-1}` hint when `noteCount > 1`. The cell's native-button toggle (`data-testid="tracked-item-expand"`) SHALL expand in place. Expanding SHALL fetch `GET /api/operator/notes` and list every note oldest→newest as `{age} · {by} · {text}` with whitespace preserved. While loading it SHALL show the latest note plus "loading…". On failure it SHALL show the latest note plus "notes unavailable". Collapse returns to the one-line view. Each expand refetches.

- **GIVEN** an item with `noteCount: 3`
- **WHEN** the row renders
- **THEN** the latest note's text and `+2` are visible
- **WHEN** the toggle is activated
- **THEN** all three notes render in order

#### R7: Worker rows prefer the item's latest note over the tab note
A worker row SHALL render the item's latest-note cell (R6 behavior) when `item.latestNote` is present. Otherwise it SHALL render today's `WorkerNoteCell` (window `@rk_win_note` with age), and only that fallback carries the 24h stale `opacity-50` dimming. The note column's `sortValue` SHALL be the rendered text (latest note, else tab note for workers, else "").

- **GIVEN** a worker row whose item has `latestNote`
- **WHEN** rendered
- **THEN** the item note shows, not the tab note
- **GIVEN** a worker row whose item has none and the window has a tab note
- **WHEN** rendered
- **THEN** the tab note shows as today

#### R8: The frontend types and client follow the wire
`OperatorTrackedItem` in `src/types.ts` SHALL drop `text` and gain `latestNote?: OperatorNote` and `noteCount?: number`. `src/api/client.ts` SHALL export `getOperatorNotes(server, id)` hitting `withServer("/api/operator/notes", server)` with `id` URL-encoded, mirroring `getCron`.

- **GIVEN** the client
- **WHEN** `getOperatorNotes("s", "a b")` runs
- **THEN** it requests `/api/operator/notes?server=s&id=a%20b` (param order per `withServer`)

### Docs

#### R9: Specs describe the new source and route
`docs/specs/api.md` SHALL document `GET /api/operator/notes` and the `latestNote`/`noteCount` payload fields. `docs/specs/cron.md` SHALL state that the operator watchlist seam reads rk's state file first, with fab's file as the pre-cutover fallback.

- **GIVEN** the specs
- **WHEN** read
- **THEN** both facts are present

### Non-Goals
- Writing notes from the UI — notes are written by `rk operator track note`, runs and chat.
- A `last_tick_at`/liveness stamp in rk's file — owned by R5 (the loop).
- Any new tab, segment, or page (Constitution IV).
- Touching the live daemon, `rk operator adopt`, or fab-kit.

### Design Decisions

#### Existence of rk's file is the source switch
**Decision**: rk's operator file existing on disk makes it the sole source, even when empty or corrupt.
**Why**: After adopt (or the first `rk operator track add`), rk's file is the ledger. Falling back to fab's frozen file would present stale items as live.
**Rejected**: Falling back whenever rk's file is empty or corrupt, which would resurrect the pre-cutover ledger after adopt.
*Introduced by*: 261111-0982-operator-tasks-rk-state-notes

#### Latest note in the payload, full list on demand
**Decision**: The sessions payload carries `latestNote` + `noteCount`. The full list comes from `GET /api/operator/notes`.
**Why**: `operatorTracked` is stamped on every session, and notes cap at 50 × 1000 runes per item, so the full list would multiply payload size by session count.
**Rejected**: All notes in the payload (unbounded growth). Last-N in the payload (an "expand to all" that isn't all).
*Introduced by*: 261111-0982-operator-tasks-rk-state-notes

#### Extend the tolerant cron reader instead of `operator.Load`
**Decision**: The display read stays `cron.ParseOperatorState` (tolerant map parse), extended with notes. Path choice lives in `internal/sessions`.
**Why**: rk's schema is fab's ported `tracked:` list, so one tolerant reader serves both files. `operator` already imports `cron`, so `cron` cannot import `operator`.
**Rejected**: Reading via `operator.Load`, which errors on parse failure and would put two reader shapes behind one surface.
*Introduced by*: 261111-0982-operator-tasks-rk-state-notes

## Tasks

### Phase 1: Core backend

- [x] T001 Extend `app/backend/internal/cron/watchlist.go`: add `Note` type + `TrackedItem.Notes`, parse `notes:` tolerantly in `parseTrackedItems`, synthesize the note from a `note`-kind item's `text` when no notes parsed; update the file-header comment (two sources: rk primary, fab fallback; rk's file written only by `internal/operator`). Tests in `watchlist_test.go` for rk-shaped fixtures, malformed notes, text→note synthesis, `kind: pane` in `WatchlistEntries` <!-- R3 -->
- [x] T002 Add source selection in `app/backend/internal/sessions/` (new small file, e.g. `operatorstate.go`): a pure-ish resolver returning the chosen path (rk if `os.Stat` succeeds, else fab) from a socket path; `rkPath` built as `<apphome.StateDir()>/operator/<FabOperatorSlug>.yaml` (or by calling `operator.StatePath`); a read helper returning `(cron.OperatorState, present bool)` honoring R2. Wire it into `FetchSessions` replacing the fab-only block (keep the `socketPathFn` seam and the "default" slug fallback). Tests with `t.TempDir()` + `t.Setenv("XDG_STATE_HOME", …)`: rk wins, fab fallback, both absent, rk empty → present empty, rk corrupt → absent (no fallback), `rkPath == operator.StatePath(sock)` <!-- R1 R2 -->
- [x] T003 Update `OperatorTrackedItem` in `app/backend/internal/sessions/sessions.go`: add `OperatorNote` type, `LatestNote *OperatorNote` / `NoteCount int` (omitempty), drop `Text`; `projectTrackedItems` fills them from `item.Notes`. Update the struct/field doc comments. Tests for latest/count/omission <!-- R4 -->

### Phase 2: Route + frontend

- [x] T004 Add `GET /api/operator/notes` in a new `app/backend/api/operator_notes.go` (register in `api/router.go` beside `/api/cron`), reading through T002's resolver with the server's socket path via the bounded tmux seam already used by the API layer; 400/404/200 per R5. Handler tests in `api/operator_notes_test.go` <!-- R5 -->
- [x] T005 Frontend wire: `app/frontend/src/types.ts` (`OperatorNote`, `latestNote`, `noteCount`, drop `text`, refresh doc comment) and `getOperatorNotes` in `app/frontend/src/api/client.ts` (+ client test) <!-- R8 -->
- [x] T006 `app/frontend/src/components/watched-table.tsx`: replace `NoteCell` with an item-note cell (latest note + suffix + `+N`, expand fetches all notes, loading/failure states, keyboard-reachable native button, cell-local state); worker rows use it when `latestNote` present else `WorkerNoteCell`; stale-dim only on the tab-note fallback; `sortValue` per R7; header comment update. Update `watched-tasks.tsx` header comment. Unit tests in `watched-table`/`watched-tasks` tests (mock `getOperatorNotes`), fix any fixtures using `text` <!-- R6 R7 -->

### Phase 3: Integration, e2e, docs

- [x] T007 Playwright: extend `app/frontend/tests/e2e/quake-terminal.spec.ts` (or the spec that already stubs `operatorTracked`) with a test proving the Operator Tasks row shows the latest note and expands to all notes (stub `/api/operator/notes` via `page.route`), with the required `Proves:`/`Steps:` JSDoc; update any existing test relying on `text` <!-- R6 R7 -->
- [x] T008 [P] Docs: `docs/specs/api.md` (route + payload fields) and `docs/specs/cron.md` (watchlist seam: rk first, fab fallback) <!-- R9 -->
- [x] T009 Run verification gates: `cd app/backend && go test ./...`, `cd app/frontend && npx tsc --noEmit` and the frontend unit tests, and the targeted e2e spec through the repo's `just` recipe; never the live `rk serve` or the user's tmux server <!-- R1 R6 -->

## Execution Order

- T001 blocks T002 and T003 (they consume `TrackedItem.Notes`)
- T002 blocks T004 (shared resolver)
- T005 blocks T006 blocks T007

## Acceptance

### Functional Completeness

- [ ] A-001 R1: With an rk file present, `FetchSessions` reads only rk's file; with it absent, fab's file is read as before; neither file is written
- [ ] A-002 R2: An empty rk file yields `operatorTracked: []`; a corrupt rk file yields an absent `operatorTracked` with no fallback to fab
- [ ] A-003 R3: Notes parse in file order with unix `at`; fab note-item `text` becomes one `user` note; `kind: pane` items join the watchlist
- [ ] A-004 R4: `operatorTracked[]` items carry `latestNote` + `noteCount` (omitted when none) and no `text`
- [ ] A-005 R5: `GET /api/operator/notes` returns 200 ordered notes / 400 missing id / 404 unknown id or no file, with the same source as the payload
- [ ] A-006 R6: Item rows show latest note + author + age + `+N`, and expand to all notes fetched from the route
- [ ] A-007 R7: Worker rows show the item's latest note when present, else the tab note with its stale dimming
- [ ] A-008 R8: Frontend types and `getOperatorNotes` match the wire
- [ ] A-009 R9: `docs/specs/api.md` and `docs/specs/cron.md` document the route, fields and source order

### Behavioral Correctness

- [ ] A-010 R4: The `text` field is gone from the Go projection and the TS type; no frontend code reads `item.text`

### Scenario Coverage

- [ ] A-011 R1: Go tests cover rk-wins, fab-fallback, both-absent, rk-empty, rk-corrupt, and the `operator.StatePath` parity
- [ ] A-012 R6: A Playwright test with a `Proves:`/`Steps:` JSDoc exercises latest-note display and expand-to-all in the Operator Tasks segment

### Edge Cases & Error Handling

- [ ] A-013 R6: Note fetch failure leaves the latest note visible with "notes unavailable"; the expand toggle remains a keyboard-reachable native button
- [ ] A-014 R3: Malformed notes (non-map, empty text) are skipped, never fatal

### Code Quality

- [ ] A-015 Pattern consistency: New code follows naming and structural patterns of surrounding code (`getCron` client shape, `api/cron.go` handler shape, tolerant-read helpers)
- [ ] A-016 No unnecessary duplication: The route and the payload share one source-selection resolver; `parseTickAt`/`strField` reused
- [ ] A-017 Comments state constraints only — no narration, no change IDs in code comments
- [ ] A-018 No client polling: notes are fetched only on expand, never on a timer
- [ ] A-019 Frontend uses type narrowing, not `as` casts, for the new note shapes
- [ ] A-020 No `internal/cron` → `internal/operator` import

### Security

- [ ] A-021 R5: `id` is never used to build a path; `server` passes `serverFromRequest` validation; the socket-path query stays on the bounded tmux seam

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Source-selection helper lives in `internal/sessions` (new file) and is reused by the API handler | `sessions` may import both `cron` and `operator`; one resolver keeps the route and payload in agreement | S:60 R:85 A:80 D:70 |
| 2 | Confident | Route 404s (not 200-empty) when no file is present or the file is corrupt | The item id cannot be resolved, and the UI falls back to the latest note | S:55 R:90 A:75 D:65 |
| 3 | Confident | The Playwright test lives in the existing spec that already stubs `operatorTracked` (quake-terminal or mobile-cron-tabs) | Reuses existing fixtures and the file-header setup comment | S:55 R:90 A:75 D:70 |
| 4 | Confident | Expanded note line format is `{age} ago · {by} · {text}` | Matches the table's existing `· … ago` suffix vocabulary | S:45 R:95 A:70 D:60 |

4 assumptions (0 certain, 4 confident, 0 tentative).
