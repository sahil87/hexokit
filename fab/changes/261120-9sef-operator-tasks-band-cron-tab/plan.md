# Plan: Operator Tasks Band and the Cron Tab

**Change**: 261120-9sef-operator-tasks-band-cron-tab
**Intake**: `intake.md`

## Requirements

### Tasks segment: Needs-you band

#### R1: Needs-you derivation
The frontend SHALL derive a list of "needs you" rows purely from the tracked rows built from the
sessions payload (`collectTrackedRows`), in a pure helper in `components/server-watched-zone/model.ts`.
A row is produced for:
- an **open escalation** — an item that is not done whose `latestNote.by === "run"` and whose
  `latestNote.text` starts with `escalated:`; the wanted action is the trimmed text after the prefix;
- a **waiting prompt** — a `kind: "worker"` row that is not done whose window `isWaiting(win)`; the
  wanted action is `answer the prompt in <window name>`.
An item matching both SHALL yield exactly one row (waiting kind; the escalation text appended after
` · `). Waiting rows SHALL sort before escalation rows; within each kind, oldest `updatedAt` first.
Done items SHALL never yield a row. A run note not starting with `escalated:` SHALL NOT yield a row.

- **GIVEN** a not-done item whose newest note is `{by: "run", text: "escalated: spawn interrupted: x"}`
- **WHEN** the derivation runs
- **THEN** one escalation row is produced with action `spawn interrupted: x`
- **AND** once a newer `by: user` note becomes the latest note, or `doneAt` is set, no row is produced

- **GIVEN** a tracked worker whose window `agentState` is `waiting`
- **WHEN** the derivation runs
- **THEN** one waiting row is produced; when `agentState` leaves `waiting` the row is gone

#### R2: Band rendering and actions
`WatchedTasks` SHALL render a **Needs you** band (test id `needs-you-band`) above the summary line and
table, only when at least one need exists, headed `Needs you · <n>`. Each row (`needs-you-row`,
`data-item-id`) SHALL show the item id, the wanted action, and actions: `open pane`
(`needs-you-open-pane`, only when the row has a `windowId`) calling the component's `onNavigate(windowId)`,
and `note…` (`needs-you-note`) opening the note composer (R4) in place under that row. The band SHALL
render in both mounts (desktop drawer Tasks segment, mobile operator route `?tab=tasks`) and SHALL
render even when the ledger table would otherwise show a hint, provided rows exist.

- **GIVEN** a payload with one escalated item and one waiting worker
- **WHEN** the Tasks segment renders
- **THEN** the band shows `Needs you · 2`, the waiting row first with `open pane` and `note…`
- **AND** clicking `open pane` navigates to that window (and on desktop collapses the drawer)

- **GIVEN** no needs
- **WHEN** the Tasks segment renders
- **THEN** no band element exists

### Notes: write path and composer

#### R3: `POST /api/operator/notes`
The daemon SHALL expose `POST /api/operator/notes` with JSON body `{server, id, text}` that appends a
`by: user` note through `operator.AddNote` to **rk's** operator state file for that server
(`operator.StatePath(socketPath)`, socket via the same seam the GET path uses) and returns 200
`{"id": <id>, "note": {"at": <unix seconds>, "by": "user", "text": <trimmed>}}` only after the write
succeeded. It SHALL return 400 for an invalid/missing server, empty id, or note validation failure
(empty, over `NoteTextCap`) with the validator's message; 404 when rk's state file does not exist
(never writing fab's file) or no item carries the id; 500 on other I/O errors. The handler SHALL use
an injectable seam so tests write to a temp file. It SHALL NOT write a wake marker. The id is only
compared for equality, never used in a path.

- **GIVEN** a server whose rk state file tracks item `pr-41`
- **WHEN** `POST /api/operator/notes {"server":"work","id":"pr-41","text":"  merge once green "}`
- **THEN** 200 with note text `merge once green`, `by: user`, and the file's item holds that note last

- **GIVEN** a server with only fab's legacy state file
- **WHEN** a note is posted
- **THEN** 404 and fab's file is byte-identical afterwards

#### R4: Note composer
A note composer component SHALL write via `postOperatorNote(server, id, text)` (new in
`api/client.ts`) and, after a successful write, call `postOperatorWake(server, "note:<id>")`. It SHALL
autofocus its textarea; Enter submits, Shift+Enter inserts a newline, Esc cancels; Save/Cancel
buttons; disabled while pending; whitespace-only text cannot be submitted. On write failure it SHALL
stay open, keep the text and show the error inline (`role="alert"`). On write success it SHALL close
and show a transient status: `note saved · check queued` when the wake succeeded, or
`note saved · the next check will pick it up` when the wake failed.

- **GIVEN** the composer open on `pr-41`
- **WHEN** the user types a note and presses Enter
- **THEN** `postOperatorNote` is called, then `postOperatorWake(server, "note:pr-41")`, then the composer closes

- **GIVEN** the write rejects with "note text is 900 characters, over the 800-character cap"
- **WHEN** the user submits
- **THEN** the composer stays open, text intact, the message shown, and no wake call is made

#### R5: Composer entry from the ledger table
`WatchedTable`'s expanded notes list (the `ItemNoteCell` expand-in-place) SHALL offer an
`add note…` control at its foot that opens the same composer for that item when the table has a
`server`; after a successful write the expanded list SHALL refetch the item's notes.

- **GIVEN** a tracked row with its notes expanded
- **WHEN** the user clicks `add note…`, writes and saves
- **THEN** the note is written, the wake called, and the expanded list refetched to include it

### Drawer: one Cron segment

#### R6: Four-segment strip
`SEGMENTS` in `components/terminal-activity-tabs.tsx` SHALL be exactly
`terminal/Terminal`, `tasks/Tasks`, `activity/Activity`, `cron/Cron` in that order;
`QuakeSegment`, the `rk:quake-terminal` seam's `segment` type and `TerminalSearch.tab` SHALL agree
(the existing union-agreement guard stays green). `TerminalActivityTabs` reads `cron` as active.

- **GIVEN** the drawer or operator route
- **WHEN** the strip renders
- **THEN** it shows `Terminal · Tasks · Activity · Cron` and no `Cron List` / `Cron Log`

#### R7: Cron console body
A `CronConsole` component SHALL stack the unchanged `CronList` (registry, top, `shrink-0`, height
capped near 40 % of the body, own scroll) over the unchanged `CronLog` (deliveries, `flex-1 min-h-0`,
own scroll), passing `server` and `inline` through; each keeps its toolbar and detail sheet, and the
Cron Log's `show loop` toggle keeps its T6 behavior (default off). The desktop drawer
(`quake-terminal.tsx`) and the operator route (`app.tsx`) SHALL mount it for the `cron` segment.

- **GIVEN** the Cron segment open
- **WHEN** it renders
- **THEN** the registry table and the deliveries table are both visible, registry above deliveries
- **AND** loop rows stay hidden until `show loop` is pressed

#### R8: Palette and openers
The palette SHALL carry one cron action — id `quake-terminal-cron`, label `Operator: Show cron`,
`requestQuakeTerminal({ action: "open", segment: "cron" })` — replacing `quake-terminal-list` and
`quake-terminal-log`. Every in-app opener that requested `list`/`log` (status bar) SHALL request
`cron`. The mobile seam's operator-less redirect to `/$server#cron` SHALL key on `segment === "cron"`.

- **GIVEN** the command palette
- **WHEN** the user searches "cron"
- **THEN** exactly one `Operator: Show cron` entry exists and selecting it opens the Cron segment

- **GIVEN** a mobile server with no operator window, sessions loaded
- **WHEN** a `cron` segment request arrives
- **THEN** it navigates to `/$server#cron`

### Routes and deep links

#### R9: `?tab=` values and legacy normalization
`validateTerminalSearch` SHALL accept `terminal`, `tasks`, `activity`, `cron`, SHALL normalize the
legacy tokens `log` and `list` to `cron` (one-release compatibility, commented for removal), and drop
anything else to absent.

- **GIVEN** a deep link `/{server}/{N}?tab=log` to the operator window
- **WHEN** the route loads
- **THEN** the Cron segment is shown

#### R10: Cron push deep link
`internal/cron/push_url.go` SHALL build cron-delivery push URLs with `?tab=cron`.

- **GIVEN** a cron delivery push for server `work`, operator window `@3`
- **WHEN** the URL is built
- **THEN** it is `/work/3?tab=cron`

### Non-Goals

- No server-side "open escalation" computation or new payload field — the band derives from `latestNote`.
- No change to the check, conditions, engine escalation, ladder, runner, trigger door, or the T6 Activity tab/endpoints.
- No `by: chat` writes, note editing or deletion from the UI.
- No new route, page or SSE channel; no detail-sheet redesign.
- No CLI surface change, no install/release/daemon restart.
- Review bar (plan § Decisions): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.

### Design Decisions

#### Needs-you derives from the newest note
**Decision**: An escalation is open while the item is not done and its newest note is the `by: run` `escalated:` note; any newer note or completion clears it; derived client-side from `latestNote`.
**Why**: The engine escalates once per condition and the sessions payload already carries the newest note; the band needs no new read and clears on the next SSE payload.
**Rejected**: A server-side open-escalation field from the engine's `escalated` map — that map is never cleared, so it cannot tell open from resolved, and it would add a payload field for a display concern.
*Introduced by*: 261120-9sef-operator-tasks-band-cron-tab

#### The drawer writes notes as the user, then knocks on the door
**Decision**: `POST /api/operator/notes` writes a `by: user` note to rk's ledger only; the composer then calls `POST /api/operator/wake` with reason `note:<id>`; a failed wake is reported but not an error.
**Why**: The plan makes a fresh user note a check condition, so the wake only shortens the wait; keeping write and wake separate matches the Brief and keeps the note endpoint a plain ledger write.
**Rejected**: Writing the wake marker inside the notes handler (couples two verbs the Brief keeps apart); writing fab's legacy file (rk never writes fab's ledger).
*Introduced by*: 261120-9sef-operator-tasks-band-cron-tab

## Tasks

### Phase 1: Backend

- [x] T001 Add `POST /api/operator/notes` in `app/backend/api/operator_notes.go` (handler beside the GET; body struct, server validation like `operator_wake.go`, rk state path via a new injectable `Server` seam defaulting to socket path → `operator.StatePath`, existence check → 404, `operator.AddNote(path, id, operator.ByUser, text)`, error mapping 400/404/500, receipt JSON); register the route in `app/backend/api/router.go` <!-- R3 -->
- [x] T002 Go tests for the POST in `app/backend/api/operator_notes_test.go`: 200 writes a trimmed `by: user` note; 404 unknown item; 404 when rk's file is absent with fab's file untouched; 400 empty text / over-cap / missing id / bad server; GET behavior unchanged <!-- R3 -->
- [x] T003 [P] Switch `cronPushTab` to `cron` in `app/backend/internal/cron/push_url.go` (and its header comment); update `push_url_test.go` <!-- R10 -->

### Phase 2: Frontend core

- [x] T004 Add `postOperatorNote(server, id, text)` to `app/frontend/src/api/client.ts` (POST JSON, `throwOnError` on failure, typed receipt) <!-- R4 -->
- [x] T005 Add the pure `collectNeedsYou(rows)` (+ `NeedsYouRow` type) to `app/frontend/src/components/server-watched-zone/model.ts` with unit tests in `model.test.ts` covering every R1 case <!-- R1 -->
- [x] T006 Create the note composer component (e.g. `app/frontend/src/components/operator-note-composer.tsx`) per R4, with `operator-note-composer.test.tsx` (success → note then wake `note:<id>`; write failure keeps text + alert, no wake; wake failure → "next check" status; Esc cancels; Enter/Shift+Enter; empty disabled) <!-- R4 -->
- [x] T007 Create the Needs-you band component (e.g. `app/frontend/src/components/needs-you-band.tsx`) rendering `collectNeedsYou` rows with `open pane` / `note…` (composer in place), and mount it in `app/frontend/src/components/watched-tasks.tsx` above the summary/table (also above the hint when rows exist); tests in `needs-you-band.test.tsx` and `watched-tasks` tests <!-- R2 -->
- [x] T008 Add the `add note…` composer entry to the expanded notes list in `app/frontend/src/components/watched-table.tsx` (`ItemNoteCell`), refetching notes after a successful write; extend its tests <!-- R5 -->

### Phase 3: Cron segment, routes, palette

- [x] T009 Change `SEGMENTS` / `QuakeSegment` / `TerminalActivityTabs` in `app/frontend/src/components/terminal-activity-tabs.tsx` to `terminal|tasks|activity|cron` (labels `Terminal · Tasks · Activity · Cron`, doc comments updated); update `TerminalSearch.tab` + `validateTerminalSearch` in `app/frontend/src/lib/router-url.ts` with the `log`/`list` → `cron` normalization; follow the seam type (`QuakeTerminalRequest.segment`); update `terminal-activity-tabs.test.tsx` and `router-url.test.ts` <!-- R6 R9 -->
- [x] T010 Create `app/frontend/src/components/cron-console.tsx` (`CronConsole` stacking `CronList` over `CronLog`) with a unit test; mount it for `segment === "cron"` in `app/frontend/src/components/quake-terminal.tsx` (desktop drawer, `inline`) and for `quakeTab === "cron"` in `app/frontend/src/app.tsx` (operator route); key the mobile operator-less redirect on `cron`; update `quake-terminal.test.tsx` and any app tests <!-- R7 R8 -->
- [x] T011 Collapse the palette list/log actions into `buildQuakeTerminalCronAction` (`quake-terminal-cron`, `Operator: Show cron`) in `app/frontend/src/lib/palette/quake-terminal.ts`; register it once in `app/frontend/src/hooks/use-global-palette-actions.ts`; switch `app/frontend/src/components/status-bar.tsx`'s opener to `cron`; update `quake-terminal.test.ts` (palette) and any other `list`/`log` references (`grep -rn '"list"\|"log"'`) <!-- R8 -->

### Phase 4: E2E, demo, verification

- [x] T012 Update Playwright specs for the four-segment strip and `?tab=cron` (`app/frontend/tests/e2e/mobile-cron-tabs.spec.ts`, `quake-terminal.spec.ts`, `operator-page.spec.ts`, `operator-compose.spec.ts`, plus any spec naming `Cron List`/`Cron Log`), including a `?tab=log` deep link landing on Cron; add an e2e spec for the band (seeded rk state file with an escalated note → band row; `note…` → write → band clears) — each `test()` with its Proves/Steps intent block <!-- R2 R6 R9 -->
- [x] T013 Add the demo `app/frontend/tests/demo/operator-tasks-band.demo.ts` (band, composer write + wake, the single Cron tab) runnable by `just demo operator-tasks-band` on desktop + mobile; fix any existing demo spec that clicks `Cron List`/`Cron Log` <!-- R2 R7 -->
- [x] T014 Run `just test-backend`, `just test-frontend`, the frontend type check, and `just test-e2e` for the touched specs; fix regressions <!-- R1 R2 R3 R4 R5 R6 R7 R8 R9 R10 -->

## Execution Order

- T001 blocks T002; T004 blocks T006; T005 + T006 block T007; T006 blocks T008.
- T009 blocks T010 and T011.
- T012–T014 run last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `collectNeedsYou` yields escalation rows (not-done, newest note `by: run` `escalated:`) and waiting rows (worker, not done, waiting), one row per item, waiting first, oldest first
- [x] A-002 R2: `WatchedTasks` renders the `Needs you · <n>` band only when needs exist, with item id, wanted action, `open pane` (when a window resolves) and `note…`, in both drawer and mobile mounts
- [x] A-003 R3: `POST /api/operator/notes` appends a trimmed `by: user` note to rk's state file via `operator.AddNote` and returns the receipt after the write
- [x] A-004 R4: The composer writes then calls `postOperatorWake(server, "note:<id>")`, closing with the matching status line
- [x] A-005 R5: The expanded notes list offers `add note…` and refetches after a successful write
- [x] A-006 R6: The strip is exactly `Terminal · Tasks · Activity · Cron`; the three unions agree
- [x] A-007 R7: `CronConsole` stacks the unchanged `CronList` over the unchanged `CronLog` in both the drawer and the operator route
- [x] A-008 R8: One palette action `quake-terminal-cron`; no `quake-terminal-list`/`-log`; status-bar and mobile seam use `cron`
- [x] A-009 R9: `validateTerminalSearch` accepts `cron` and maps `log`/`list` to `cron`
- [x] A-010 R10: Cron push URLs carry `?tab=cron`

### Behavioral Correctness

- [x] A-011 R1: A band row clears on the next payload once a newer note lands, the item completes, or the agent leaves `waiting`
- [x] A-012 R7: The Cron Log's `show loop` toggle still defaults off inside the stacked console

### Removal Verification

- [x] A-013 R6: No `"list"`/`"log"` segment values, `Cron List`/`Cron Log` labels, or list/log palette builders remain in `app/frontend/src` outside the one-release normalization and its tests

### Scenario Coverage

- [x] A-014 R1: Unit tests cover open / cleared-by-newer-note / cleared-by-done / waiting / waiting-clears / both→one / non-escalation run note
- [x] A-015 R3: Go tests cover 200, 404 unknown item, 404 fab-only (file untouched), 400 validation cases
- [x] A-016 R4: Composer tests cover success, write failure (no wake), and wake failure
- [x] A-017 R9: An e2e test proves a `?tab=log` deep link lands on the Cron segment
- [x] A-018 R2: An e2e test proves the band renders from a seeded escalated note and clears after a note is written

### Edge Cases & Error Handling

- [x] A-019 R3: A server on fab's legacy file is refused with 404 and fab's file is never written
- [x] A-020 R4: Whitespace-only notes cannot be submitted; over-cap text surfaces the server's message without closing
- [x] A-021 R2: Done items never appear in the band; an escalation row on an item without a live window has no `open pane`

### Code Quality

- [x] A-022 Pattern consistency: New code follows naming and structural patterns of surrounding code (handler seams like `operatorStateFn`, `Control`/`controlClass` buttons, test ids)
- [x] A-023 No unnecessary duplication: `operator.AddNote`, `isWaiting`, `collectTrackedRows`, `postOperatorWake`, existing `CronList`/`CronLog` are reused, not reimplemented
- [x] A-024: Type narrowing over `as` casts in the new frontend code; no magic strings for the `escalated:` prefix or wake reason prefix (named constants)
- [x] A-025: No client polling — the band derives from the SSE payload; the composer only fetches on user action
- [x] A-026: Comments state constraints, not narration or change IDs
- [x] A-027: Every new/modified Playwright `test()` carries a Proves/Steps intent block

### Security

- [x] A-028 R3: The item id is only compared for equality and never used to build a path; server validated before resolving a socket; POST only (Constitution IX)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `app/frontend/src/components/cron-list.tsx:182` (`inline ? " relative"`) and `app/frontend/src/components/cron-log.tsx:104` (same) — the only `inline` mount of either table is now `CronConsole`, which demotes both roots back to `static` via `SHEET_ANCHOR_TO_CONSOLE`; dropping the `relative` branch (and the doc lines describing it, cron-list.tsx:32, cron-log.tsx:31) would let `CronConsole` drop its arbitrary-variant override too.
- `app/frontend/src/components/cron-console.tsx:9` `SHEET_ANCHOR_TO_CONSOLE` — redundant once the tables' `inline` roots stop being `relative` (see above).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Wanted-action text for waiting rows is `answer the prompt in <window name>`; escalation rows show the reason after `escalated:` | Payload has no question text; reason is the engine's own wording | S:60 R:90 A:70 D:65 |
| 2 | Confident | The band renders above the hint as well as above the table whenever needs exist | A need implies a tracked item, so the hint case is rare; showing it is never wrong | S:50 R:95 A:70 D:70 |
| 3 | Confident | Transient composer status auto-clears after a few seconds via a single timeout, not polling | Matches toast-like transient UI; not a data fetch | S:50 R:95 A:70 D:65 |
| 4 | Confident | rk state-file existence is checked with `os.Stat` before `AddNote`, mapping absence to 404 | `Mutate` may create the file; the handler must not create a ledger for a fab-only server | S:60 R:85 A:75 D:70 |
| 5 | Certain | Wake reason prefix constant `note:` → log reason `trigger:note:<id>` | T2's door accepts single-line reasons; matches the PR trigger's `pr:` shape | S:75 R:90 A:85 D:80 |

5 assumptions (1 certain, 4 confident, 0 tentative).
