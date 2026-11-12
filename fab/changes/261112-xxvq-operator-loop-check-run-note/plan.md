# Plan: Operator Loop — Cron Fire → Check → Run Window → Note

**Change**: 261112-xxvq-operator-loop-check-run-note
**Intake**: `intake.md`

## Requirements

### Cron: The `run: operator-loop` entry kind

#### R1: Loop entry schema and validation
`cron.Entry` SHALL gain an optional top-level `run` field (`yaml:"run,omitempty"`) whose only legal value is `operator-loop` (named constant `RunOperatorLoop`). An entry with `run` set MUST NOT carry `payload`, `target`, `deliver`, `if_absent` or `respawn`; validation SHALL reject any of them with a per-field error and SHALL reject an unknown `run` value. An entry without `run` SHALL validate exactly as today (payload/target required). `Add` SHALL refuse a second `run: operator-loop` entry in the same server file. `rk cron add` SHALL NOT gain a flag to create one; `rk cron edit` (schedule/wake), `mute`, `pin`, `rm` SHALL work on it unchanged.

- **GIVEN** a server file with one valid `run: operator-loop` entry (schedule backoff 3m/24m, `wake_on`, pinned, no target/payload)
- **WHEN** `LoadEntries` reads it
- **THEN** the entry loads with no diagnostic
- **AND** an entry with `run: operator-loop` plus a `payload` loads as `entry-invalid`, while sibling entries still load

#### R2: Log-derived backoff for loop entries
For a `run: operator-loop` entry with `schedule.kind: backoff`, the evaluator SHALL derive the next fire purely from the entry's own schedule history (`ScheduleHistory`): let `k` be the number of consecutive `no change` lines at the end of the entry's own history (counted back to the newest line whose outcome is NOT `no change` — any of `ran …`, `run-failed …`, `run-lost …`, `check-failed …`, `rescheduled`, `skipped-busy …` — or to the start of history); the next fire is **the newest own line's ts + min(min·2ᵏ, max)**. With no own lines the next fire is `created_by.at + min`. Every gap between consecutive checks is therefore bounded by `max`, regardless of whether the preceding lines came from schedule, wake, or catch-up fires. <!-- clarified: rework cycle 2 — anchor the projection on the newest own line, not on the newest non-`no change` line; the earlier Σ-gaps formula let off-schedule `no change` lines push the next check hours past max --> The rule MUST stay a pure function of (entry, log, now). Non-loop entries keep the existing idle-epoch `JoinAnchor` behavior byte-for-byte.

- **GIVEN** a loop entry `min 3m max 24m` whose newest non-`no change` line is `ran …` at T, followed by `no change` lines at T+3m and T+9m
- **WHEN** evaluated at T+20m
- **THEN** the next fire is T+21m (k = 2, gap 12m after T+9m), so the entry is not due
- **AND** at T+21m it is due

- **GIVEN** a loop entry `min 3m max 24m` with `ran …` at T followed by 10 wake-fired `no change` lines 70 s apart (the last at T+10m30s)
- **WHEN** the next fire is projected
- **THEN** it is T+10m30s+24m (k = 10, gap capped at max) — never later than `max` after the last check

#### R3: Loop entries need no target resolution
A loop entry SHALL never be target-resolved and SHALL never appear in `EvalResult.Absent`; `if_absent` and respawn MUST NOT apply. A due loop entry SHALL be emitted in `EvalResult.Fires` with empty `PaneID`, reason `schedule` or `wake`, and `DueAt` as today. Muting (flag or lease) SHALL suppress it exactly as any entry. Orphan GC MUST NOT expire it.

- **GIVEN** a due loop entry on a live server with no operator window at all
- **WHEN** `Evaluate` runs
- **THEN** the entry is in `Fires` (not `Absent`) and no `respawn`/notify disposition runs

#### R4: Wake fingerprint excludes run-window panes
For a loop entry with `wake_on`, the per-entry fingerprint SHALL exclude every pane belonging to a window whose `@rk_win_role` is `operator-run` on that server (instead of the target-pane exclusion). `GatherFacts` SHALL surface the set of run-window pane ids in `ServerFacts` so the evaluator stays pure. Debounce and actionable-transition rules are unchanged.

- **GIVEN** a loop entry with `wake_on` and a run window whose agent pane flips `active → idle`
- **WHEN** the tick evaluates
- **THEN** no wake edge fires for the loop entry
- **AND** an unrelated pane flipping to `waiting` does fire it (subject to debounce)

#### R5: Loop fires route to the `LoopRunner` seam
`cron.Deps` SHALL gain `LoopRunner func(ctx context.Context, fire Fire) Outcome` (nil-safe). `tickServer` SHALL route every `run: operator-loop` fire to it instead of the `Deliverer`; a nil seam logs `no-deliverer`. The per-target rate cap for loop fires SHALL be keyed on the entry id. A `Held` outcome SHALL NOT be logged (existing rule). The tick SHALL also call an optional `Deps.LoopTranscribe func(ctx, server string) []LogLine` (nil-safe) once per live server per tick, before evaluation, and append each returned line to the log (single writer).

- **GIVEN** a daemon built without the seams (both nil)
- **WHEN** a loop entry fires
- **THEN** one `no-deliverer` line is appended and no other behavior changes

#### R6: Delivery-log outcome classes and `run` field
`LogLine` SHALL gain an optional `run` field (`json:"run,omitempty"`). Loop outcomes SHALL use exactly these strings: `no change`; `skipped-busy: run <run-id>`; `ran · <outcome> · <duration>`; `run-failed: exit <n> · <duration>` (or `run-failed: no outcome line · <duration>` on exit 0 without an `outcome:` line); `run-lost: <reason>`; `check-failed: <detail>`. `<duration>` SHALL be rendered by a shared short formatter (e.g. `2m13s`, `45s`); `<outcome>` capped at 200 runes. `ran`, `run-failed`, `run-lost`, `check-failed` SHALL count toward the rate cap; `no change` and `skipped-busy` SHALL NOT. Transcribed lines carry the run id in `run`. Orphan-GC classification (`resolvedOutcome`, absent-class) MUST treat the new classes as neutral.

- **GIVEN** a transcribed successful run `20261112T101500-ab12` with outcome `nudged pr-41, noted` lasting 133 s
- **WHEN** the line is appended
- **THEN** it reads `{"outcome":"ran · nudged pr-41, noted · 2m13s","run":"20261112T101500-ab12",…}`

### Operator loop: runner, run window, records

#### R7: Loop runner decision order
The production `LoopRunner` (new package `internal/operatorloop`, which may import `cron`, `operator`, `tmux`, `riff`) SHALL, for server S: (1) if a live `operator-run` window exists on S, return `skipped-busy: run <run-id>` without calling Check; (2) call `operator.Check(ctx, S, CheckOptions{})` — error ⇒ `check-failed: <err>`; `Changed == false` ⇒ `no change`; (3) otherwise map `CheckResult.Changes` to `[]operator.ChangedItem` (one per id, first-seen order, reasons `<kind>` plus a short detail where the delta carries one, e.g. `stage_advance apply→review`), render the brief with `operator.RenderBrief`, persist the run (R9), launch the run window (R8), and return a `Held` outcome (no log line at launch). A launch failure SHALL mark the record ended and be transcribed as `run-lost: launch: <err>` (no silent loss).

- **GIVEN** a live run window on S
- **WHEN** the loop entry fires
- **THEN** the outcome is `skipped-busy: run <id>` and `operator.Check` is not called (the state file's `last_check_at` is unchanged)

- **GIVEN** no run window and a Check that reports no new changes
- **WHEN** the entry fires
- **THEN** the outcome is `no change` and no window or run record is created

#### R8: Run window creation
A run window SHALL be created in session `_rk-operator` on S (created detached with `new-session -d` when absent), named `run-<short-id>`, cwd `@rk_srv_operator_root` when it still validates as a directory, else `$HOME`. It SHALL run the hidden wrapper verb directly (no `; exec $SHELL` tail) so the window dies when the wrapper exits. Immediately after creation it SHALL be stamped `@rk_win_role=operator-run` and `@rk_win_operator_run=<run-id>`; a stamp failure SHALL kill the window and fail the launch. All tmux calls SHALL go through `internal/tmux` argv-slice helpers with a timeout (Constitution I). The rk binary path for the wrapper SHALL be the running executable (`os.Executable`, existing `internal/selfpath` helper if applicable). `@rk_win_operator_run` SHALL be registered in the tmux option registry. `sessions.operatorSessionHidden` SHALL treat `operator` and `operator-run` windows as hideable.

- **GIVEN** a server with no `_rk-operator` session
- **WHEN** a run launches
- **THEN** `_rk-operator` exists with one window `run-<short-id>` carrying both stamps, and the session is hidden from user-facing lists

#### R9: Run records, brief and log files
Per run, under `<state home>/operator/runs/<slug>/` (dir 0700, files 0600; `<slug>` = the operator state-file slug of S): `<run-id>.json` (record), `<run-id>.brief.md` (rendered brief), `<run-id>.log` (wrapper output). The record schema is `{id, server, entry, fired_at, changed:[ids], window, started_at, ended_at, exit_code, outcome, transcript, logged}` (timestamps RFC3339 UTC; zero values omitted). Run id format `YYYYMMDDTHHMMSS-xxxx` (UTC, 4 random `[a-z0-9]`). The record and brief SHALL be written atomically (`fsatomic`) BEFORE the window is created (durable before acknowledged). Record writes from the daemon and the wrapper SHALL be atomic whole-file writes; the wrapper writes only its own fields via read-modify-write.

- **GIVEN** a launch
- **WHEN** the window is created
- **THEN** `<run-id>.json` (with `fired_at`, `changed`, `window`) and `<run-id>.brief.md` already exist on disk

#### R10: Wrapper verb `rk operator run-exec`
A hidden cobra verb `rk operator run-exec --server S --run <run-id> -- <argv…>` SHALL: write `started_at`; run `<argv…>` (`exec.CommandContext`, no timeout beyond a generous ceiling constant, e.g. 2h) with stdin = the brief file and stdout+stderr tee'd to `<run-id>.log` (and to the window); on exit parse the LAST stdout line matching `^outcome: (.*)$`; on non-zero exit or no outcome line, append `run failed: exit <n> — <≤200-byte log tail>` with `--by run` to each `changed` item still present (via `operator.AddNote`) and send a fail-silent `rk notify`-equivalent (`push.Notify` or `rk notify` argv, best-effort); then write `ended_at`, `exit_code`, `outcome`, and `transcript` (best-effort via `internal/transcript` when resolvable, else omitted). It MUST NOT write the cron log. It SHALL be `Hidden: true` and excluded from the MCP policy table. Exit code mirrors the child's.

- **GIVEN** a launcher that prints `outcome: stub acted` and exits 0
- **WHEN** the wrapper finishes
- **THEN** the record carries `exit_code: 0`, `outcome: "stub acted"`, `ended_at` set, and no failure note was written

- **GIVEN** a launcher that exits 1 with no outcome line
- **WHEN** the wrapper finishes
- **THEN** each changed item gains a `by: run` note starting `run failed: exit 1` and the record carries `exit_code: 1`

#### R11: Launcher resolution
The daemon SHALL resolve the run launcher with `fab agent operator --headless -o yaml` (Dir = the operator root) through a riff helper parallel to `ResolveAgent` (same FabTimeout, same tolerant `command` extraction, no legacy `--print` retry needed for headless). On any failure (fab absent, non-zero, no command) it SHALL fall back to `riff.DefaultHeadlessLauncher = "claude -p --dangerously-skip-permissions"`. The launcher string is run as `sh -c '<launcher>'` (riff's one documented shell-expansion exception) with the brief on stdin.

- **GIVEN** fab is not on PATH
- **WHEN** a run launches
- **THEN** the wrapper argv is `sh -c 'claude -p --dangerously-skip-permissions'`

#### R12: Transcription and run-lost detection
`LoopTranscribe(ctx, S)` SHALL scan S's run records and return one `LogLine` (entry = the record's `entry`, `run` = id, `reason` = `schedule`) per record that is ended and `logged == false` — `ran · <outcome> · <dur>` when `exit_code == 0` and `outcome != ""`, else `run-failed: …` — and for each record with no `ended_at` whose window (`@rk_win_operator_run == id`) no longer exists, a `run-lost: window gone` line (marking the record ended). After the tick appends a line it SHALL mark the record `logged: true` (atomic). Duration = `ended_at − started_at` (or `− fired_at` when `started_at` is absent). Transcription SHALL then prune to the newest 50 records per server (deleting record + brief + log). A record that fails to parse SHALL be skipped with a diagnostic, never crash the tick.

- **GIVEN** the daemon was killed mid-run and the wrapper wrote `ended_at` while it was down
- **WHEN** a fresh daemon's first tick runs
- **THEN** exactly one `ran · … · …` line is appended for that run and the record reads `logged: true`
- **AND** a second tick appends nothing for it

#### R13: Seeding and legacy mute
Each tick, per live server S, before evaluation: when rk's operator state file for S exists (`operator.StatePathForServer` + `os.Stat`) AND S's cron file has no `run: operator-loop` entry, the tick (through a nil-safe `Deps.LoopSeed func(ctx, server string) bool` reporting existence, wired from `internal/operatorloop`) SHALL `Add` the seeded entry `{name: "operator loop", run: operator-loop, schedule: backoff 3m/24m, wake_on: {agent-state-change, server, 60s}, pinned: true, created_by.at: now}` and SHALL `SetMuted(true)` every entry with `target.kind == role`, `target.role == operator`, `payload == "operator tick"`. An existing loop entry (muted or not) MUST NOT be re-seeded or rewritten. No rk file ⇒ no change. A corrupt cron file ⇒ no write, diagnostic only.

- **GIVEN** a server with fab's `operator tick` role entry and no rk operator state file
- **WHEN** ticks run
- **THEN** the cron file is byte-unchanged
- **AND** after `rk operator adopt` creates the rk file, the next tick adds the loop entry and the legacy entry reads `muted: true`
- **AND** after the user mutes the loop entry and unmutes the legacy one, later ticks change nothing

### API and UI

#### R14: Cron API exposes run fields
`GET /api/cron` delivery JSON SHALL carry `run` (omitempty) and, when the run record exists, `runLog` (absolute log path) and `transcript` (omitempty). Loop entries in the entries JSON SHALL carry `run: "operator-loop"` and empty target/payload. `rk cron list` human output SHALL show the loop entry's target column as `operator loop` and payload as `—`; `--json` mirrors the on-disk `run` key.

- **GIVEN** a `ran` line with run id R whose record exists
- **WHEN** `GET /api/cron` is fetched
- **THEN** that delivery carries `run: R` and `runLog: <state>/operator/runs/<slug>/R.log`

#### R15: Cron Log and Cron List rendering
The Cron Log detail sheet SHALL show, for a delivery with `run`, the run id, the outcome line, the run log path and the transcript path (when present) as copyable text. Cron List SHALL render a loop entry with target `operator loop` and no payload. No new route, page or tab (Principle IV). The new outcome strings render verbatim in the existing outcome column.

- **GIVEN** a Cron Log row for a `ran` delivery
- **WHEN** the user opens its detail sheet
- **THEN** the run log path is shown and copyable

#### R16: Run windows never outlive their run as a busy signal
A run window SHALL count as "run in flight" (the `RunInFlight` fact, the runner's busy gate, and transcription's window lookup) only when it carries BOTH `@rk_win_role=operator-run` AND a non-empty, valid `@rk_win_operator_run`, AND at least one of its panes is alive (`#{pane_dead}` = 0). Run windows SHALL be created with `remain-on-exit off` set on the window, so a user's global `remain-on-exit on` cannot leave a dead window behind. Layout-snapshot capture SHALL NOT capture `operator-run` windows (or, at minimum, restore SHALL NOT re-stamp the `operator-run` role or `@rk_win_operator_run` on a restored window). <!-- clarified: rework cycle 3 — the earlier Non-Goal "a captured run window is inert history" was wrong: restore re-stamps the role on a fresh shell window, which pinned the loop forever --> The create + stamp of a run window SHOULD be one tmux invocation (targeting the new window by its unique name) so a daemon crash between them cannot leave an unstamped running wrapper.

- **GIVEN** a layout snapshot captured while a run window existed in `_rk-operator`
- **WHEN** the snapshot is restored onto a fresh server
- **THEN** no restored window carries `@rk_win_role=operator-run`, and the next due loop fire is not suppressed

- **GIVEN** a user tmux.conf with `set -g remain-on-exit on`
- **WHEN** a run's wrapper exits
- **THEN** the run window is gone (or, if a dead window remains, it does not count as in flight) and the next loop fire is not suppressed

- **GIVEN** a window carrying `@rk_win_role=operator-run` but no `@rk_win_operator_run`
- **WHEN** the tick gathers facts
- **THEN** `RunInFlight` is false

### Non-Goals

- Changing `rk operator` (the chat launcher) or its `/fab-operator` kickoff — C1/F1
- Launch-time tool restriction (provider-opaque launcher) — the brief's allowed-tool list stays declarative
- A route or viewer for run-log contents — the path is shown, not served
- fab-kit changes (F1) and the live cutover (C1)

### Design Decisions

#### Loop entry as a `run` discriminant, not a target kind
**Decision**: A top-level `run: operator-loop` key marks an entry that fires a Go function instead of typing a payload.
**Why**: `target` means "where to send"; overloading it would special-case resolution, orphan GC and `if_absent`. A separate key keeps those paths untouched and older binaries skip the entry as invalid instead of breaking.
**Rejected**: `target.kind: operator-loop`; a payload-level action flag.
*Introduced by*: 261112-xxvq-operator-loop-check-run-note

#### The tick is the cron log's single writer
**Decision**: Run outcomes reach `<slug>.log` only through tick-time transcription of run records the wrapper writes.
**Why**: `AppendLog`'s cap trim rewrites the file via rename; a second writer could lose lines. Transcription also makes a fresh daemon rebuild the outcome from files alone.
**Rejected**: The wrapper appending to the log directly (append-vs-trim race; a second lock protocol).
*Introduced by*: 261112-xxvq-operator-loop-check-run-note

#### Log-derived ladder for target-less entries
**Decision**: Consecutive `no change` lines climb the backoff ladder; any other own line resets it.
**Why**: There is no agent pane to read an idle epoch from; "nothing changed" is the loop's idleness signal and keeps the evaluator pure.
**Rejected**: A flat 3m interval (probes every 3m forever); reset on wake only (probe-only changes never reset).
*Introduced by*: 261112-xxvq-operator-loop-check-run-note

#### Daemon seeds on the rk state file
**Decision**: The tick seeds the loop entry when rk's operator state file exists, and mutes (not deletes) the legacy typed tick.
**Why**: Existence of rk's file is already the display switch; pre-C1 no live server has one, so the release is dormant until `rk operator adopt`. Mute keeps rollback one unmute and keeps fab's reconcile from re-seeding.
**Rejected**: An explicit `rk operator loop on|off` verb; adopt switching the entry.
*Introduced by*: 261112-xxvq-operator-loop-check-run-note

## Tasks

### Phase 1: Setup

- [x] T001 Add `Run` field + `RunOperatorLoop` constant to `cron.Entry`, extend `Entry.validate()` (closed set, forbidden fields, payload/target optional when set) and `Add` (one loop entry per file) in `app/backend/internal/cron/schema.go` and `store.go`, with tests in `schema_test.go`/`store_test.go` (incl. tolerant load of a mixed file) <!-- R1 -->
- [x] T002 [P] Add `Run` (`json:"run,omitempty"`) to `LogLine`, outcome constants/helpers (`OutcomeNoChange`, prefix helpers, a short duration formatter) and rate-cap/orphan classification for the new classes in `app/backend/internal/cron/log.go`, `tick.go` (`countsTowardRate`), `orphan.go`, with tests <!-- R6 -->
- [x] T003 [P] Add `DefaultHeadlessLauncher` and `ResolveHeadlessAgent(ctx, repoRoot, tier)` (`fab agent <tier> --headless -o yaml`, tolerant `command` parse, default fallback) in `app/backend/internal/riff/riff.go` with tests in `riff_test.go` <!-- R11 -->

### Phase 2: Core Implementation

- [x] T004 Implement the log-derived loop ladder (pure helper, e.g. `LoopLadder(entry, log)`) in `app/backend/internal/cron/backoff.go` and route loop entries to it in `evaluate.go` and `derive.go` (next-fire projection), with table tests incl. the R2 scenario and the `created_by.at` fallback <!-- R2 --> <!-- rework: revise to R2's corrected formula: next = newest own line ts + min(min·2^k, max), k = trailing `no change` count; update derive.go projection too; add the off-schedule wake-lines test and a catch-up-after-downtime test (fires once, not once per tick) -->
- [x] T005 Make `Evaluate` skip target resolution for loop entries (always `Fires`, never `Absent`), and exempt them from orphan GC, in `app/backend/internal/cron/evaluate.go` / `tick.go`, with tests <!-- R3 --> <!-- rework: suppress loop fires while a run is in flight (run window present in ServerFacts) so a Held launch does not produce an extra skipped-busy/no change row next tick -->
- [x] T006 Surface run-window pane ids (`@rk_win_role == operator-run`) in `ServerFacts` from `GatherFacts` (`facts.go`, TmuxSeam enumeration already lists windows/roles) and exclude them from the loop entry's wake fingerprint in `wake.go`/`evaluate.go`, with tests <!-- R4 --> <!-- rework: surface a run-in-flight fact (live operator-run window) in ServerFacts for T005's suppression --> <!-- rework: R16: RunInFlight (and ListOperatorRunWindows) count a window only with role operator-run AND a valid non-empty @rk_win_operator_run AND ≥1 live pane (#{pane_dead}=0); tests incl. role-without-run-id and dead-pane window -->
- [x] T007 Add `Deps.LoopRunner`, `Deps.LoopTranscribe`, `Deps.LoopSeed` (all nil-safe) and wire them into `Tick`/`tickServer`: seed-then-transcribe-then-evaluate per server, loop fires → `LoopRunner` (entry-id rate key), transcribed lines appended via `appendLine` in `app/backend/internal/cron/tick.go`, with tests using fakes (nil seams ⇒ `no-deliverer`, held ⇒ unlogged) <!-- R5 --> <!-- rework: (a) transcription must run and append BEFORE Evaluate (R5); (b) mark a run logged only when its line is durably on disk — appendLine must report success; add tick tests (unwritable log path; just-transcribed entry not due same tick) -->
- [x] T008 Create `app/backend/internal/operatorloop/` with run-record types, paths (`runs/<slug>/`), run-id generation, atomic read/write helpers and retention pruning (newest 50), with tests <!-- R9 -->
- [x] T009 Implement `Transcribe(ctx, server)` in `internal/operatorloop` (ended ⇒ `ran`/`run-failed`, missing window ⇒ `run-lost: window gone`, `logged` marking via a post-append callback or mark-before-return contract that keeps exactly-once under crash, prune) with tests incl. the daemon-restart scenario <!-- R12 --> <!-- rework: markLost must set Lost only when the re-read record still has no ended_at (lost-vs-ended race); drop requirement-id provenance from test comments -->
- [x] T010 Implement run-window helpers in `app/backend/internal/tmux/` (ensure `_rk-operator` session, `new-window -d -P -F` with argv command + name + cwd, set `@rk_win_role`/`@rk_win_operator_run`, find live run window by role/option), register `@rk_win_operator_run` in the option registry, and update `operatorSessionHidden` in `app/backend/internal/sessions/sessions.go` (+ test) <!-- R8 --> <!-- rework: run-created _rk-operator must not keep the new-session placeholder shell window (kill it as MoveWindowIntoOperatorSession does); create run windows detached (-d) so they never steal the session's current window; test window count + hidden state --> <!-- rework: R16: set remain-on-exit off on run windows; make create+stamp one tmux invocation (target the new window by its unique name) to restore atomicity with -d; parsimony — MoveWindowIntoOperatorSession (and any identical demote-path capture) must reuse ensureOperatorSessionCapturingPlaceholder so the placeholder rule lives in one place -->
- [x] T011 Implement the `LoopRunner` in `internal/operatorloop` (busy gate → `operator.Check` → ChangedItem mapping → `RenderBrief` → persist record+brief → resolve launcher → create window → `Held`), with seams for Check/tmux/resolve and tests for each branch (busy, check error, no change, changed, launch failure) <!-- R7 --> <!-- rework: wrapper binary must be the running executable (selfpath.Stable), not selfpath.LauncherOrStable -->
- [x] T012 Implement `Seed(ctx, server)` in `internal/operatorloop` (rk state file existence → `cron.Add` loop entry + `SetMuted` legacy `operator tick` role entries; idempotent; corrupt file ⇒ no write) with tests for the R13 scenarios <!-- R13 --> <!-- rework: seed.go doc must name every trigger that creates rk's state file (`rk operator adopt`, `track add`, AND `rk operator check`) -->
- [x] T013 Add the hidden `rk operator run-exec` verb in `app/backend/cmd/rk/operator_run_exec.go` (record start/end, stdin brief, tee log, outcome parse, failure notes via `operator.AddNote` + fail-silent notify, best-effort transcript path) with tests in `operator_run_exec_test.go` <!-- R10 -->

### Phase 3: Integration & Edge Cases

- [x] T014 Wire `LoopRunner`, `LoopTranscribe`, `LoopSeed` into the cron ticker deps in `app/backend/cmd/rk/serve.go` (best-effort; resolution failure leaves the seams nil with one Warn) <!-- R5 --> <!-- rework: serve.go wiring must use selfpath.Stable for the wrapper path -->
- [x] T015 Extend `api/cron.go` delivery/entry JSON (`run`, `runLog`, `transcript`; entry `run`) and `cmd/rk/cron_list.go` human/json rendering for loop entries, with tests in `api/cron_test.go` / `cmd/rk/cron_list_test.go` <!-- R14 --> <!-- rework: gofmt cmd/rk/cron_list.go (cronListRecord alignment broken by the Run field) -->
- [x] T016 Frontend: add `run`/`runLog`/`transcript` to `CronDelivery` and `run` to the entry type in `app/frontend/src/api/client.ts`; render loop entries in `lib/cron-list-model.ts`; show run fields (copyable) in `components/cron-entry-detail-sheet.tsx` / `cron-log.tsx`, with Vitest coverage <!-- R15 --> <!-- rework: reuse the shared OPERATOR_LOOP_RUN constant in lib/cron-schedule.ts instead of the repeated literal -->
- [x] T017 Restart-survival integration test: a Go test (or `scripts/` harness run via a `just` recipe) on an isolated tmux socket dir (`TMUX_TMPDIR` under `t.TempDir()` / `-L rk-test-…`) that launches a stub run through the runner + wrapper, drops the in-memory daemon state, runs a fresh tick, and asserts one `ran · stub acted · …` line and the item note — never touching the live daemon or the user's tmux servers <!-- R12 -->

### Phase 4: Polish

- [x] T018 Update `docs/specs/cron.md` (operator entry ownership → rk seeds the loop entry; loop kind) and the `rk cron add --help` / skill topic text that describes fab seeding (`cmd/rk/skill/cron.md` via `docs/site/skill/cron.md` + `scripts/sync-skill.sh`) where now inaccurate <!-- R13 --> <!-- rework: docs/specs/cron.md § Operator Loop Entry: update the ladder formula to R2's corrected wording; name all rk-state-file triggers (adopt/track add/check) as the seeding switch; fix the `_rk-operator` hidden-session sentence (hidden because every window is `operator` or `operator-run`) --> <!-- rework: rewrap the over-long reflowed line in docs/specs/cron.md § Operator Loop Entry; mention R16's snapshot/remain-on-exit rules -->
- [x] T019 Record PR evidence: `just demo` before/after recordings (desktop + mobile) of the Cron List loop row and the Cron Log detail sheet run fields, using a demo spec under `app/frontend/tests/demo/` <!-- R15 -->
- [x] T020 Exclude `operator-run` windows from layout-snapshot capture (`internal/tmux/layout.go` layoutWindowToSnapshot / `internal/snapshot/snapshot.go`) or from restore re-stamping (`internal/snapshot/restore.go` WindowOptionOps), with a test restoring a snapshot that held an `operator-run` window <!-- R16 -->

## Execution Order

- T001 blocks T004, T005, T006, T007, T012, T015
- T002 blocks T007, T009
- T008 blocks T009, T011, T012, T013
- T010 blocks T011, T009 (window lookup)
- T003 blocks T011
- T007 + T009 + T011 + T012 block T014; T014 blocks T017
- T015 blocks T016 blocks T019

## Acceptance

### Functional Completeness

- [x] A-001 R1: `run: operator-loop` entries load, validate (forbidden fields rejected, unknown run value rejected), and at most one per server file is accepted by `Add`
- [x] A-002 R2: A loop entry's backoff climbs one rung per consecutive `no change` line and resets on any other own line; non-loop backoff is unchanged (existing tests pass untouched) — `LoopLadder` now returns a `LoopRung` anchored on the newest own line (next = anchor + min(min·2ᵏ, max)); evaluate.go and derive.go both use it; non-loop `Ladder`/`JoinAnchor` untouched
- [x] A-003 R3: Loop entries are never target-resolved, never reach `Absent`, never trigger respawn/notify, and are never orphan-expired
- [x] A-004 R4: Run-window panes are excluded from the loop entry's wake fingerprint
- [x] A-005 R5: Loop fires go to `Deps.LoopRunner`; nil seams log `no-deliverer`; transcribed lines are appended only by the tick (transcription now runs and appends before `Evaluate`)
- [x] A-006 R6: The six loop outcome strings are produced exactly as specified, `LogLine.run` is set on transcribed lines, and rate-cap/orphan classification treats them as specified
- [x] A-007 R7: The runner's decision order (busy → check → no change / changed → launch) holds, and a busy fire does not call Check
- [x] A-008 R8: Run windows are created in `_rk-operator` (created when missing) with name `run-<short-id>`, both stamps, the operator-root/home cwd rule, no shell-fallback tail; `_rk-operator` stays hidden over `operator`/`operator-run` windows (placeholder killed, detached create, wrapper via `selfpath.Stable`)
- [x] A-009 R9: Record + brief are on disk (atomic, 0600 in a 0700 dir) before the window is created; run ids follow `YYYYMMDDTHHMMSS-xxxx`
- [x] A-010 R10: `rk operator run-exec` records start/end/exit/outcome, feeds the brief on stdin, tees output to the log, writes failure notes + fail-silent notify on failure, never writes the cron log, and is hidden
- [x] A-011 R11: Launcher resolution uses `fab agent operator --headless -o yaml` and falls back to `claude -p --dangerously-skip-permissions`
- [x] A-012 R12: Ended unlogged records are transcribed exactly once; a gone window yields `run-lost: window gone`; retention keeps 50
- [x] A-013 R13: Seeding fires only when rk's state file exists and no loop entry exists; legacy `operator tick` entries are muted, not deleted; no re-seed after a user mute
- [x] A-014 R14: `GET /api/cron` and `rk cron list` expose the run fields and render loop entries as specified
- [x] A-015 R15: The Cron Log detail sheet shows run id, outcome, run log path and transcript path; Cron List shows `operator loop`; no new route/page/tab

### Scenario Coverage

- [x] A-016 R12: A test simulates a daemon restart mid-run (wrapper finishes while no tick runs) and asserts one `ran` line + the item note after the fresh tick, and nothing on the following tick
- [x] A-017 R13: Tests cover rk file absent (byte-unchanged), present (seed + legacy mute), and user-rolled-back (no change)
- [x] A-018 R7: Tests cover busy, check-failed, no change, changed, and launch-failure branches

### Edge Cases & Error Handling

- [x] A-032 R2: Off-schedule `no change` lines (wake or catch-up fires) never push the next loop check more than `max` after the newest own line, and a catch-up after downtime fires once, not once per tick

- [x] A-019 R10: A launcher exiting non-zero without an outcome line produces `run-failed: exit <n> · <dur>` and failure notes on each still-present changed item (removed items are skipped without error)
- [x] A-020 R12: A malformed run record is skipped with a diagnostic and does not break the tick
- [x] A-021 R13: A corrupt cron file is never written by seeding
- [x] A-022 R1: An older-shape file with a `run` key is tolerated per entry (bad loop entry skipped, siblings load)

### Code Quality

- [x] A-023 Pattern consistency: New code follows the naming and structure of `internal/cron` and `internal/operator` (seams as package vars/Deps fields, atomic writes via `fsatomic`, tolerant reads)
- [x] A-024 No unnecessary duplication: Existing utilities reused (`operator.Check`, `RenderBrief`, `AddNote`, `StatePathForServer`, `internal/tmux` helpers, `fsatomic`, the ladder math, `push.Notify`)
- [x] A-025 Every subprocess uses `exec.CommandContext` with argv slices and a timeout; the launcher shell string is the single documented exception (Constitution I, code-quality Go backend rule)
- [x] A-026 Disposable daemon: no in-memory-only state; every daemon-originated write is durable before the run launches; a fresh daemon rebuilds from run records, the cron log and tmux (Constitution II)
- [x] A-027 No god functions (>50 lines without reason), no magic strings/numbers (outcome strings, retention 50, run role/option names are named constants)
- [x] A-028 No comment narration or change-ID citations in code comments
- [x] A-029 New behavior is covered by tests (Go unit tests for every new function; Vitest for the frontend fields); `just test-backend` and frontend type-check pass — `just test-backend` fails only `TestPortPinRowRealPolicyValues` (cmd/rk doctor), re-verified in review to fail identically on an export of the unmodified merge-base efd0fa7f; `just test-frontend` 6078/6078 pass; `tsc --noEmit` clean
- [x] A-030 All tmux interaction goes through `internal/tmux`; no inline tmux command construction in `internal/operatorloop` or `cmd/rk`

- [x] A-033 R16: A restored snapshot never yields an `operator-run` window; a dead or run-id-less `operator-run` window never sets `RunInFlight`; run windows set `remain-on-exit off` — capture skips run windows (and run-only sessions), `WindowOptionOps` never re-stamps the role (covers restore, reopen, closed-ring, respawn), `parseRunWindows` requires a valid run id + a live pane, remain-on-exit pinned off in the create invocation; real-tmux tests cover each
- [x] A-034: The placeholder-capturing `_rk-operator` ensure exists in exactly one helper, reused by `MoveWindowIntoOperatorSession` and the run-window launch — `ensureSessionCapturingPlaceholder` (tmux.go) backs promote, demote and `LaunchOperatorRunWindow`

### Security

- [x] A-031 R8: Server names and run ids are validated (`validate.ValidateServerName`, run-id regex) before they reach any tmux argv or filesystem path; no path traversal via `<slug>` or `<run-id>`

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- Verification never touches the live rk daemon, installed binaries, or the user's tmux servers (plan Rule 1); use `just test-backend` / `just test-frontend` / isolated sockets only.

## Deletion Candidates

- `app/backend/cmd/rk/cron.go:139` `cronDurationShort` — a one-line forwarder to `cron.DurationShort`; its 4 callers can call the shared formatter directly
- `app/backend/cmd/rk/operator_run_exec.go:60-62` — the explicit `server == ""` check duplicates what `operatorServer` resolves; `operatorServer` alone (or a `MarkFlagRequired`) covers it
- `app/backend/internal/operatorloop/runner.go:57-60` — the `id == ""` → `"unknown"` fallback is unreachable now that `tmux.parseRunWindows` only returns windows with a valid run id
- `app/backend/internal/tmux/tmux.go` `EnsureOperatorSession` / `ensureDetachedSession` — the run launch was their only production caller; with it moved to `ensureSessionCapturingPlaceholder` they have no production call sites

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | New package `internal/operatorloop` hosts the runner, transcription, seeding and record I/O | `cron` can't import `operator`; a package (vs. all in `cmd/rk`) keeps it unit-testable and reusable by the wrapper verb | S:70 R:80 A:80 D:70 |
| 2 | Confident | Two extra nil-safe seams `LoopTranscribe` and `LoopSeed` alongside `LoopRunner` | Transcription and seeding must run every tick, not only on fires; seams keep `cron` free of `operator` imports | S:65 R:80 A:80 D:65 |
| 3 | Confident | `skipped-busy` lines also reset the loop ladder (they are not `no change`) | Intake listed "any other own line" resets; a busy skip means work is in flight, so checking again soon is right | S:55 R:85 A:70 D:60 |
| 4 | Confident | `run-failed: no outcome line · <dur>` for an exit-0 run lacking an outcome line | The exit contract requires an outcome line; treating its absence as failure keeps the failure-note path consistent | S:60 R:85 A:75 D:65 |
| 5 | Confident | Wrapper ceiling timeout 2h | Bounds a hung provider without killing normal runs (S1 runs take seconds; real runs minutes); Constitution requires a context timeout | S:50 R:90 A:70 D:60 |
| 6 | Confident | Layout snapshots exclude (or never re-stamp) `operator-run` windows | Clarified in rework cycle 3: restore re-stamps captured roles on a fresh shell window, which would pin `RunInFlight` forever; closed-ring capture is UI-close only (`api/closed.go`) so it needs no change | S:80 R:80 A:85 D:75 |
| 7 | Confident | Restart-survival acceptance is a Go integration test on an isolated tmux socket dir, not a live-daemon test | Plan Rule 1 + S1 Surprise 1 (`RK_SERVER_ALLOWLIST` doesn't scope tmuxctl) | S:70 R:85 A:80 D:75 |

| 8 | Confident | `parseWindows` surfaces `operator-run` as a window role (`tmux.RoleOperatorRun`) while `validate.RoleValues` stays closed (not user-settable), and `ClearWindowRoleExcept` never clears it | Without the read arm the evaluator and sessions projection never see run windows; without the radio exemption a chat window taking the operator role would erase a live run's busy signal | S:75 R:80 A:80 D:70 |
| 9 | Confident | The run window is created with its role and run-id stamps chained into the `new-window` call (`LaunchOperatorRunWindow`), and a failed creation kills any window of that name | Stronger than stamp-after-create: no reader ever sees an unstamped run window; satisfies "stamp failure kills the window and fails the launch" | S:70 R:85 A:80 D:70 |
| 10 | Confident | Run records gain an optional `lost` field (reason) beside the specified schema; `Run` outcomes use `exit_code` as a pointer so `0` is recorded | A launch failure has no exit status and must transcribe as `run-lost: launch: <err>`; exit 0 must be distinguishable from "not exited" | S:65 R:85 A:75 D:65 |
| 11 | Confident | Marking a run `logged` is a fourth nil-safe seam `Deps.LoopLogged`, and the tick skips appending a run id already present in the log | Exactly-once under a crash between append and mark; keeps `cron` free of `operatorloop` imports | S:65 R:80 A:80 D:65 |
| 12 | Confident | `cron.SeedOperatorLoop` (one atomic write: add loop entry + mute legacy `operator tick` entries) lives in `internal/cron`; `operatorloop.StateFileExists` is the `LoopSeed` switch; servers with an rk state file but no cron file are swept too | A single write cannot leave the loop live beside an unmuted typed tick; the Add+SetMuted pair would be two writes | S:70 R:80 A:80 D:70 |
| 13 | Confident | Run-file paths and seeding resolve the state file with one tmux socket query and fail when the socket path is unknown (no `default`-slug fallback) | A transient query failure must not move run files or seeding onto another server's slug | S:65 R:85 A:75 D:65 |
| 14 | Tentative | The record's `transcript` is never populated for headless runs: no provider session ref is observable from a launcher that is provider-opaque; the field and API/UI plumbing exist for when one is reported | R10 says "best-effort … when resolvable"; nothing in the exit contract carries a session ref | S:50 R:85 A:60 D:50 |
| 15 | Confident | The loop rate-cap key is the entry id and counts `ran`/`run-failed`/`run-lost`/`check-failed`; `skipped-busy` lines reset the ladder (assumption 3) | Matches R5/R6 | S:70 R:85 A:80 D:70 |
| 16 | Confident | The restart-survival acceptance (T017) re-execs the Go test binary as the run window's wrapper (TestMain) on an isolated `TMUX_TMPDIR` + `XDG_STATE_HOME`, instead of building rk | Exercises the real tmux window, runner, wrapper and tick without compiling the binary; never touches live servers | S:70 R:85 A:80 D:70 |
| 17 | Confident | `rk cron list` has no payload column, so only the target column (`operator loop`) and the `run` JSON key change | R14's "payload as —" has no list column to land in; the Cron List UI shows `—` for the loop's payload in the edit dialog | S:65 R:85 A:75 D:65 |
| 18 | Confident | `LoopLadder` returns a `LoopRung` (newest own line ts + trailing `no change` count) with its own `NextFire`/`Due`, instead of reusing the summed-gaps `Ladder` | R2's corrected formula is anchor + one gap at rung k, not Σ of gaps; a separate type keeps non-loop `Ladder`/`JoinAnchor` byte-for-byte | S:75 R:85 A:80 D:70 |
| 19 | Confident | `OPERATOR_LOOP_RUN` moves to the leaf `lib/cron-schedule.ts` and `cron-list-model.ts` imports it | The schedule helper is the dependency-free leaf; importing from cron-list-model would add `format` and `client` edges to it | S:70 R:90 A:80 D:70 |
| 20 | Confident | The optional per-tick state-path resolution cleanup is not done | Needs a seam change across `cron.Deps` and `operatorloop`; marked optional and not simple | S:60 R:90 A:75 D:65 |
| 21 | Confident | Run-window liveness comes from a new `TmuxSeam.ListRunWindows` (`list-panes -a`, one call per tick, only on servers with a loop entry), not from the `WindowInfo` role | The heavy window parse carries neither the run id nor `pane_dead`; one shared filter (`tmux.ListOperatorRunWindows`) now backs the evaluator, the runner and transcription | S:70 R:85 A:80 D:70 |
| 22 | Confident | Run-id grammar moved to `validate.ValidRunID` (`operatorloop.ValidRunID` delegates) | `internal/tmux` cannot import `operatorloop`; the busy filter must validate the id | S:70 R:90 A:80 D:75 |
| 23 | Confident | Snapshot capture skips run windows (and run-only sessions) and `WindowOptionOps` also never restores the run role; `CaptureWindow` refuses a run window | Capture-side skip leaves no phantom shell window; the restore-side guard covers hand-built or older snapshots | S:70 R:85 A:75 D:65 |
| 24 | Confident | `ensureSessionCapturingPlaceholder(ctx, prefix, session)` is the single placeholder rule, used by the operator promote, the demote destination and the run launch | The demote path captured an identical placeholder for a different session name, so the helper takes the session | S:70 R:90 A:80 D:70 |

24 assumptions (0 certain, 23 confident, 1 tentative).
