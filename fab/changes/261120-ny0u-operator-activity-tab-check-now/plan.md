# Plan: Operator Activity Tab and Check Now

**Change**: 261120-ny0u-operator-activity-tab-check-now
**Intake**: `intake.md`

## Requirements

### Cron: loop log line carries the fire id

#### R1: `no change` loop lines name their fire
`cron.LogLine` SHALL gain `Fire string` (`json:"fire,omitempty"`) and `cron.Outcome` SHALL gain a `Fire string` field. `operatorloop.Run` MUST set `Outcome.Fire` to the fire id on the `no change` outcome when that id was generated (the same id the check record was written under). The tick's loop-fire append in `internal/cron/tick.go` MUST copy `Outcome.Fire` onto the line. Every other line keeps `fire` empty. `ParseLog` remains tolerant (old lines without `fire` parse; old binaries ignore it).

- **GIVEN** a loop fire whose check reports no change
- **WHEN** the tick appends its log line
- **THEN** the line carries `"fire": "<id>"` and `runs/<slug>/<id>.check.json` exists
- **AND** a delivery (non-loop) line and a `skipped-busy` line carry no `fire`

#### R2: Schedule-fire rung is replayable per line
`internal/cron` SHALL expose a pure helper beside `LoopLadder` that returns the ladder rung in effect at each own loop line — the count of consecutive climbing lines (`no change` or `IsLoopFailureOutcome`) immediately preceding that line, reset by any other own line — using the same climb rule as `LoopLadder` (one owner of the rule: `climbsLoopLadder`).

- **GIVEN** own lines `ran · …`, `no change`, `no change`, `schedule` fire
- **WHEN** the helper computes the rung for the last line
- **THEN** it is 2
- **AND** after a `ran · …` line the next line's rung is 0; failure lines climb like `no change`

### API: operator activity

#### R3: `GET /api/operator/activity?server=` joins loop lines, check records and run records
A GET route SHALL return `{"server", "in_flight", "rows"}` for the server's operator-loop entries' own log lines, newest first, capped at 200 rows (`operatorloop.CheckRetention`). Each row: `ts` (unix), `entry`, `reason` (raw fire reason), `outcome` (raw), `rung` (R2), `fire` (the join id: `fire`, else `run`), `check` when `<fire>.check.json` reads (`checked_at, changed, changes, open, notices, items` — `items` = distinct item ids across changes ∪ open), `run` when `<fire>.json` reads (`id, pass, outcome, lost, exit_code, started_at, ended_at, duration_s, has_brief, has_log`). Missing or corrupt records omit the sub-object; the row stays. An absent log, entries file or runs dir yields `rows: []` with 200. `server` MUST be validated with `validate.ValidateServerName` (400 otherwise).

- **GIVEN** a `no change` line with `fire` and its check record on disk
- **WHEN** the client GETs `/api/operator/activity?server=s`
- **THEN** the row carries `check` with the record's changes/open/notices and no `run`
- **AND** a transcribed `ran · …` line joins its check record and run record through `run`

#### R4: In-flight run surfaced
The response's `in_flight` SHALL be `{id, started_at}` for a live run window on the server (via `tmux.ListOperatorRunWindows`, bounded by its own timeout, behind a seam for tests), else `null`. When a run is in flight, a synthetic newest row (`running: true`, `outcome: ""`, `reason` from the run record, `check` and `run` joined by the run id) SHALL lead `rows`, since the run has no log line until transcription. A tmux listing error yields `in_flight: null`, never a failed response.

- **GIVEN** a live run window `run-<short>` for run id X with an unended record
- **WHEN** the client GETs activity
- **THEN** `in_flight.id == X` and `rows[0].running == true`

#### R5: Run brief and log contents
`GET /api/operator/runs/{server}/{id}/brief` and `.../log` SHALL serve the raw file as `text/plain; charset=utf-8`. `{server}` MUST pass `validate.ValidateServerName` and `{id}` `operatorloop.ValidRunID` (400 otherwise); the path MUST come only from `operatorloop.BriefPath`/`LogPath` under `operatorloop.Dir(ctx, server)`. Cap 256 KiB (named constant): the brief serves its first 256 KiB, the log its last 256 KiB; when truncated the response carries `X-Rk-Truncated: true`. Absent file → 404.

- **GIVEN** a run log of 300 KiB
- **WHEN** the client GETs `/api/operator/runs/s/<id>/log`
- **THEN** the body is the final 256 KiB and `X-Rk-Truncated: true` is set
- **AND** `/api/operator/runs/s/..%2Fx/log` is 400, a pruned run is 404

### UI: segment strip and routing

#### R6: Strip labels and the Activity segment
`SEGMENTS` in `terminal-activity-tabs.tsx` SHALL be, in order: `terminal`/`Terminal`, `tasks`/`Tasks`, `activity`/`Activity`, `list`/`Cron List`, `log`/`Cron Log` (the `Operator` prefix dropped; T7 merges the two cron segments). `QuakeSegment`, `QuakeTerminalRequest.segment`, `router-url.ts`'s `TerminalSearch.tab` union and the agreement test SHALL all include `activity`. `TerminalActivityTabs` SHALL map `?tab=activity` to the Activity segment.

- **GIVEN** the desktop drawer is open
- **WHEN** the user reads the strip
- **THEN** it shows `Terminal · Tasks · Activity · Cron List · Cron Log`

#### R7: `?tab=activity` is a real value
`validateTerminalSearch` SHALL keep `tab: "activity"` as-is; the legacy `activity` → `log` normalization SHALL be removed. Both the desktop drawer and the mobile operator route (`app.tsx` body switch) SHALL render the Activity body for that segment, with the TerminalClient unmounted (one relay stream max).

- **GIVEN** a mobile operator route `/<server>/<window>?tab=activity`
- **WHEN** the page renders
- **THEN** the Activity segment is selected and its body shows

### UI: Activity tab

#### R8: Activity rows
A new Activity component SHALL fetch `GET /api/operator/activity` on mount and whenever the server's sessions payload changes (the `useCronData` pattern — no `setInterval`), fail-silent keeping last good data, and render one row per fire, newest first:
- trigger label: `schedule` → `schedule · rung n`; `trigger:manual` → `manual`; `trigger:<x>` → `trigger · <x>`; `wake` → `trigger · agent`; anything else verbatim;
- check summary `k items · n changes · m open` plus ` · j notices` when j > 0; without a check record, the raw outcome (`skipped-busy: …`, `check-failed: …`);
- run summary: `running…` for the in-flight row; else when the run's pass acted and the run has no model outcome, `mechanical · n actions`; else the line's outcome (`ran · …`, `run-failed: …`, `run-lost: …`); plus duration when known; plus a relative timestamp.
Empty rows → `no operator activity yet`; empty server → the cron tabs' hint-line pattern.

- **GIVEN** a row with reason `schedule`, rung 3, check `{items: 2, changes: 1, open: 1, notices: 0}`, outcome `no change`
- **WHEN** Activity renders
- **THEN** the row reads `schedule · rung 3` and `2 items · 1 changes · 1 open`

#### R9: Row expansion
A row SHALL expand/collapse on click and on Enter/Space (focusable, `aria-expanded`). Expanded, it shows the changed list and the open list (item id + kind/reasons per `CheckDelta`), the notices, and — when the run has them — **Brief** and **Run log** panes fetched lazily on first expand from R5 and rendered in a scrollable `<pre>` (whitespace-pre-wrap); when `X-Rk-Truncated` is set a line says `truncated — showing first 256 KiB` (brief) / `last 256 KiB` (log). A fetch failure shows an inline error, never throws.

- **GIVEN** a row whose run has `has_brief` and `has_log`
- **WHEN** the user expands it
- **THEN** the brief and log are fetched once and shown

#### R10: Filter chips
The Activity header SHALL show chips `runs · triggers · all`, default `all`. `runs` = rows with `run` or `running`; `triggers` = rows whose reason is not `schedule`; `all` = every row. The selection is component state.

- **GIVEN** rows of reasons `schedule` (no run), `trigger:manual` (no run), `wake` (with run)
- **WHEN** the user picks `runs`
- **THEN** only the `wake` row shows; `triggers` shows the latter two

#### R11: Check now
The Activity header SHALL have a **Check now** button that POSTs `/api/operator/wake {server}` (no reason ⇒ the door's default `manual`). While `in_flight` is set the button is disabled and reads `run in progress`. After a successful POST it reads `check queued` until the next activity fetch returns, and triggers a refetch. A failed POST shows an error state on the button (no throw). There is no forced-run path and no bare check.

- **GIVEN** no run in flight
- **WHEN** the user clicks Check now
- **THEN** exactly one `POST /api/operator/wake` with body `{server}` is sent and the button reads `check queued`

#### R12: Staleness banner moves to Activity
`CronStaleBanner` SHALL mount above the Activity body (desktop drawer and mobile operator route) and SHALL no longer mount above the Cron List / Cron Log bodies.

- **GIVEN** a stale operator on the server
- **WHEN** the user views Cron Log
- **THEN** no staleness banner shows; on Activity it shows

#### R13: Palette registration
The command palette SHALL list an Activity segment action (the `buildQuakeTerminalTasksAction` twin, always listed) and a Check now action (listed when a server resolves; posts the wake). Both are keyboard-reachable (Constitution V).

- **GIVEN** the palette is open
- **WHEN** the user types `activity`
- **THEN** the Activity segment action is listed and opens the drawer on Activity

### UI: Cron Log hides loop rows

#### R14: `show loop` toggle
`cron-log.tsx` SHALL hide rows whose entry is an operator-loop entry by default and render a `show loop` toggle in its header that reveals them (component state, default off). Other rows are unchanged.

- **GIVEN** a log with a loop row and a delivery row
- **WHEN** Cron Log renders
- **THEN** only the delivery row shows until `show loop` is toggled on

### Docs

#### R15: Memory and spec docs updated
The memory files listed in the intake's Affected Memory are updated at hydrate; `docs/specs/api.md` gains the three GET routes if it enumerates operator endpoints.

- **GIVEN** the change ships
- **WHEN** a reader opens `api-and-sockets.md`
- **THEN** the activity and run-file endpoints are documented

### Non-Goals

- Review bar (plan § Decisions): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.
- T7 work: Needs-you band, note composer wake, merging Cron List + Cron Log into `Cron`, `tasks`/`cron` mobile values and `log` → `cron` normalization.
- A forced run, a bare `rk operator check`, a new log file, a new route/page, a new SSE channel.
- Changing the check, ladder rule, runner outcomes or record retention; any install/release/restart.

### Design Decisions

#### Fire id on the log line is the activity join key
**Decision**: The loop `no change` line carries `fire: <id>`; transcribed run lines join on their existing `run`; lines from before the field render without a check summary.
**Why**: The runner's `fired_at` and the tick's line `ts` are taken at different instants, so a timestamp join would mis-pair fires; an additive JSON field is tolerant in both directions.
**Rejected**: Joining check records to lines by nearest timestamp — fragile and silently wrong under clock-second boundaries.
*Introduced by*: 261120-ny0u-operator-activity-tab-check-now

#### Run files served raw and capped
**Decision**: Brief and run log are served as raw `text/plain`, 256 KiB cap (brief head, log tail), truncation flagged by `X-Rk-Truncated`; the frontend renders them in a `<pre>`.
**Why**: Keeps the daemon a reader of plain files; the UI is monospace, and the end of a run log is where the outcome is.
**Rejected**: Server-rendered HTML/markdown — more server surface for no reading gain.
*Introduced by*: 261120-ny0u-operator-activity-tab-check-now

## Tasks

### Phase 1: Setup

- [x] T001 Add `Fire` to `cron.LogLine` (`app/backend/internal/cron/log.go`) and `cron.Outcome` (`app/backend/internal/cron/tick.go`); copy `outcome.Fire` onto the loop-fire line in the `eval.Fires` append in `tick.go`; set `Fire: fireID` on the `no change` outcome in `app/backend/internal/operatorloop/runner.go` when `idErr == nil`. Tests in `log_test.go`/`tick_test.go`/`runner_test.go` (or the nearest existing test files). <!-- R1 -->
- [x] T002 [P] Add the per-line rung replay helper (e.g. `LoopRungs(lines []LogLine) []int` over own lines) beside `LoopLadder` in `app/backend/internal/cron/loop.go`, reusing `climbsLoopLadder`; table tests in `loop_test.go`. <!-- R2 -->

### Phase 2: Core Implementation

- [x] T003 New `app/backend/api/operator_activity.go`: `handleOperatorActivity` (GET `/api/operator/activity`) — validate server, read cron entries + log via `s.cronDir()`/`cron` helpers, filter to `IsLoop()` entries' own lines, newest first, cap 200, attach rung (T002), join check/run records via `operatorloop.Dir`/`CheckRecordPath`/`RecordPath`/`ReadRecord`, `has_brief`/`has_log` via stat; `in_flight` + synthetic running row via a `listRunWindows` seam on `Server` defaulting to `tmux.ListOperatorRunWindows`; runs-dir resolution behind a seam for tests. Register in `api/router.go` beside `/api/operator/notes`. <!-- R3 R4 -->
- [x] T004 In the same file, `handleOperatorRunFile` for GET `/api/operator/runs/{server}/{id}/brief` and `/log` — validators, `BriefPath`/`LogPath`, 256 KiB cap (head for brief, tail for log), `X-Rk-Truncated`, `text/plain; charset=utf-8`, 404 on absent. Register both routes. <!-- R5 -->
- [x] T005 `app/backend/api/operator_activity_test.go`: join by `fire` and by `run`, missing/corrupt records, rung values, in-flight synthetic row, tmux error → `in_flight: null`, 200 cap, bad server 400, absent log → `rows: []`; run-file handler: bad server/id 400, absent 404, head/tail cap + header, content type. <!-- R3 R4 R5 -->
- [x] T006 [P] Frontend types + client: `OperatorActivity*` types in `app/frontend/src/types.ts` (or the cron types' home), `getOperatorActivity(server)`, `getOperatorRunFile(server, id, kind)` (returns `{text, truncated}`), and `postOperatorWake(server, reason?)` (reuse if one exists) in `app/frontend/src/api/client.ts`; a `useOperatorActivity(server)` hook modeled on `hooks/use-cron.ts` (refetch on sessions change, fail-silent, plus an explicit `refetch`). <!-- R8 R11 -->
- [x] T007 Segment strip: update `SEGMENTS`, comments and `TerminalActivityTabs` mapping in `app/frontend/src/components/terminal-activity-tabs.tsx`; `TerminalSearch.tab` + `validateTerminalSearch` in `app/frontend/src/lib/router-url.ts` (drop `activity` → `log`); `QuakeTerminalRequest.segment`; update the agreement test and `router-url` tests. <!-- R6 R7 -->
- [x] T008 New `app/frontend/src/components/operator-activity.tsx`: header (filter chips, Check now with in-flight / queued / error states), rows with labels and summaries, keyboard-expandable rows with changed/open/notices and lazily fetched Brief/Run log `<pre>` panes + truncation line, empty/hint states; `operator-activity.test.tsx` covering R8–R11. <!-- R8 R9 R10 R11 -->
- [x] T009 Mount Activity: `app/frontend/src/components/quake-terminal.tsx` body switch (with `CronStaleBanner` above it, removed from above the cron bodies) and the mobile operator route body switch in `app/frontend/src/app.tsx` (same banner move); keep the cron cross-server request rule for `list`/`log` only. <!-- R7 R12 -->
- [x] T010 [P] Cron Log `show loop` toggle in `app/frontend/src/components/cron-log.tsx` (identify loop rows from the entries' loop kind or the delivery's entry — whichever field the cron payload already carries), default off; `cron-log.test.tsx` cases. <!-- R14 -->

### Phase 3: Integration & Edge Cases

- [x] T011 Palette: an Activity segment action (twin of `buildQuakeTerminalTasksAction`) and a Check now action in `app/frontend/src/hooks/use-global-palette-actions.ts` and the builder module; tests beside the existing palette-action tests. <!-- R13 -->
- [x] T012 Update Playwright specs asserting the old labels or `?tab=activity` → `log` (`app/frontend/tests/e2e/quake-terminal.spec.ts`, `mobile-cron-tabs.spec.ts`, any other hit of `Operator Tasks`/`Operator Terminal`), with intent comments per the constitution; add an e2e covering the Activity segment and Check now (stub routes as the file's existing pattern does). <!-- R6 R7 R8 R11 -->
- [x] T013 Demo spec `app/frontend/tests/demo/operator-activity.demo.ts` (pattern of existing demos): open the drawer, switch to Activity, expand a row, click Check now; desktop + mobile. Run `just demo operator-activity --before` if the rig is available; record the output paths in the result. <!-- R8 R11 -->

### Phase 4: Polish

- [x] T014 Run the verification gates via `just`: `just test-backend`, `just test-frontend` (plus frontend type check), `just test-e2e` for the touched specs, `just build`. Fix failures. Known host-only failures (`TestPortPinRowRealPolicyValues`, `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`) are not blockers. <!-- R15 -->
- [x] T015 If `docs/specs/api.md` enumerates `/api/operator/*` routes, add the three GET routes there. <!-- R15 -->

## Execution Order

- T001 and T002 block T003; T003 blocks T005; T006 blocks T008; T007 blocks T009; T008 blocks T009, T011, T012, T013.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `no change` loop lines carry `fire` equal to the check record id; other lines carry none
- [x] A-002 R2: the rung helper returns the ladder position per line using `climbsLoopLadder`
- [x] A-003 R3: `/api/operator/activity` returns joined rows newest first, capped at 200
- [x] A-004 R4: `in_flight` and the synthetic running row appear while a run window is live
- [x] A-005 R5: brief/log endpoints serve raw capped contents with the truncation header
- [x] A-006 R6: the strip reads `Terminal · Tasks · Activity · Cron List · Cron Log`
- [x] A-007 R7: `?tab=activity` selects Activity on mobile and desktop request paths
- [x] A-008 R8: rows render the trigger label, check summary and run summary per the rules
- [x] A-009 R9: rows expand by mouse and keyboard and lazily load brief and log
- [x] A-010 R10: filter chips filter as defined, default `all`
- [x] A-011 R11: Check now posts the wake once, disables while a run is in flight
- [x] A-012 R12: the staleness banner shows on Activity and not on the cron tabs
- [x] A-013 R13: palette lists the Activity segment and Check now actions
- [x] A-014 R14: Cron Log hides loop rows until `show loop` is on
- [x] A-015 R15: memory files and (if applicable) `docs/specs/api.md` document the endpoints and UI — `docs/specs/api.md` documents the three routes; memory files are hydrate-stage work per R15

### Behavioral Correctness

- [x] A-016 R7: the legacy `activity` → `log` normalization is gone; `activity` is kept
- [x] A-017 R12: Cron List / Cron Log no longer render `CronStaleBanner`

### Scenario Coverage

- [x] A-018 R3: Go tests cover join by `fire`, join by `run`, missing and corrupt records
- [x] A-019 R8: Vitest covers each row kind, chips, Check now and lazy expansion
- [x] A-020 R6: the segment agreement test includes `activity`

### Edge Cases & Error Handling

- [x] A-021 R3: absent log/entries/runs dir → 200 with `rows: []`; bad server → 400
- [x] A-022 R4: a tmux listing error yields `in_flight: null`, not a 500
- [x] A-023 R5: bad server or run id → 400; absent file → 404
- [x] A-024 R11: a failed wake POST shows an error state without throwing

### Code Quality

- [x] A-025 Pattern consistency: new handlers, hook and component follow `operator_notes.go`/`operator_wake.go`, `use-cron.ts` and `cron-log.tsx` patterns
- [x] A-026 No unnecessary duplication: path, validation and ladder logic reuse `operatorloop`, `validate` and `cron` helpers
- [x] A-027: Subprocess calls (tmux listing) go through `internal/tmux` with its timeout; no inline tmux command
- [x] A-028: No client polling — refresh rides the sessions payload change and explicit refetch
- [x] A-029: Named constants for the 200-row and 256 KiB caps; no magic numbers
- [x] A-030: Comments state constraints only — no narration or change IDs
- [x] A-031: New behavior has Go and Vitest tests; touched Playwright tests carry intent comments

### Security

- [x] A-032 R5: run-file paths are built only from validated server and run id via `operatorloop` path helpers; no traversal
- [x] A-033 R3: all new routes are GET and read-only (Constitution IX)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Activity lists lines of every `IsLoop()` entry on the server (normally one) | The loop entry id is not fixed; `IsLoop()` is the existing discriminator | S:60 R:85 A:80 D:70 |
| 2 | Confident | Activity refetch rides the sessions-payload change like `useCronData`, plus explicit refetch after Check now | code-quality anti-pattern bans client polling; established pattern | S:65 R:85 A:85 D:75 |
| 3 | Confident | Check now palette action listed only when a server resolves; the Activity segment action always listed | Mirrors the Tasks twin and the operator-start gating | S:55 R:90 A:75 D:65 |
| 4 | Confident | `mechanical · n actions` shows when `pass.actions > 0` and the run record has no model `outcome` | Distinguishes a mechanical-only pass from a model run per the Brief's two summary shapes | S:50 R:85 A:60 D:55 |
| 5 | Confident | Demo recording attempted in apply; if the rig cannot run, the result says so and ship states the gap | Constitution § PR Evidence requires reporting missing evidence | S:70 R:80 A:75 D:70 |
| 6 | Confident | `check queued` ends on the first activity fetch that returns after the wake POST succeeds (the POST triggers that fetch); a failed POST reads `check failed — retry` and stays clickable | R11's literal wording; the new row arrives when the next cron tick (≤30s) consumes the marker and rides the normal sessions-driven refetch | S:60 R:90 A:70 D:55 |
| 7 | Confident | A run summary appends the record's duration only to the `mechanical · n actions` form; the loop line's outcome (`ran · … · 2m13s`) already carries its own duration | Appending it again rendered `… · 2m13s · 2m` in the recorded demo | S:55 R:90 A:75 D:65 |
| 8 | Confident | The mobile operator route hides (never unmounts) the terminal column on `?tab=activity`, like Tasks and the cron tabs; only the desktop drawer unmounts the TerminalClient | The route has exactly one TerminalClient, so one relay stream holds either way; changing hide→unmount for Activity alone would diverge from its sibling tabs | S:55 R:85 A:80 D:65 |
| 9 | Confident | The activity and run-file handlers resolve the runs dir through the existing `cronRunsDirFn` seam; an unwired or failing resolver means no joined records on activity and a 404 on run files | One seam for "where are this server's runs", the `GET /api/cron` precedent (nil joins nothing) | S:55 R:85 A:80 D:70 |
| 10 | Confident | A live run whose line was already transcribed adds no synthetic row (matched by fire id); the synthetic row's rung is `LoopLadder`'s current rung for its entry, and its `ts` is the record's `fired_at` | The window can outlive transcription by a tick; the ladder helper is the single owner of the rung rule | S:50 R:90 A:75 D:60 |
| 11 | Confident | `operatorloop.ReadCheckRecord` is added beside `WriteCheckRecord` and decodes `CheckDelta` with the default decoder (its `MarshalJSON` keys match the field names case-insensitively), covered by a round-trip test | No check-record reader existed; the handler must not hand-roll JSON parsing | S:60 R:85 A:80 D:70 |
| 12 | Confident | `docs/specs/cron.md` and `docs/specs/index.md` still name the old four-label strip; only `docs/specs/api.md` is edited here | The task scopes spec edits to T015; the strip is mid-redesign until T7 lands the four-segment end state | S:60 R:85 A:70 D:65 |

12 assumptions (0 certain, 12 confident, 0 tentative).

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant (the legacy `activity` → `log` normalization it obsoletes was removed in this diff)
