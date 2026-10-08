# Plan: State-Socket Broadcasts Only When Something Changed

**Change**: 260916-07pj-state-socket-broadcast-dedup
**Intake**: `intake.md`

## Requirements

### Hub: host-global broadcasts ride dispatch ticks only

#### R1: Globals are emitted only on dispatch ticks
The `/ws/state` hub's poll loop (`app/backend/api/sse.go` `poll()`) MUST emit the four host-global events — `metrics`, `services`, `code-server`, `gui` — only on ticks that dispatch per-server units (the `if !resultsOnly { … }` branch), ahead of the dispatch loop inside that branch. A fold-only tick (`waitForNext` returned `resultsOnly == true`) MUST emit no host-global event. The fold, the retain sweeps, and the dead-server reap keep their current positions ahead of the branch.

- **GIVEN** a hub with one subscribed server and static collector snapshots
- **WHEN** a per-server unit completes and the loop wakes on the results wake alone (no timer, bump, wake, or pending flag)
- **THEN** that tick folds the result and emits no `metrics`/`services`/`code-server`/`gui` frame
- **AND** the next timer-driven tick still evaluates all four emitters

#### R2: Late-joiner replay and subscribe acks are unchanged
`replayGlobalSlots` and `stateSubscribe`'s ack snapshot MUST keep serving the cached slots (`cachedMetricsJSON`, `cachedServicesJSON`, `cachedCodeServerJSON`, `cachedGuiJSON`, `previousJSON[server]`) exactly as before; a client connecting between emissions receives the current slot contents once.

- **GIVEN** a hub whose slots hold a metrics, services, code-server, gui and sessions payload and no tick has run since they were cached
- **WHEN** a second state-socket connection sends `hello` and subscribes the server
- **THEN** it receives each non-empty global slot once and the `sessions` snapshot in its ack, byte-identical to what the first connection received

### Hub: change-only emission

#### R3: `metrics`, `services`, `code-server` emit only when the payload string changed
Each of the three inline emitters MUST compare its freshly marshalled payload string with its cached slot under `h.mu` and MUST skip `broadcastGlobalLocked` (and the slot write) when the strings are equal. `Snapshot()` and `json.Marshal` MUST run outside `h.mu`, as today. The `preRendered` envelope MAY be built before or inside the changed branch; `h.mu` MUST NOT be held across the collector snapshot or its marshal.

- **GIVEN** a metrics collector whose `Snapshot()` returns the same value on three consecutive dispatch ticks
- **WHEN** the three ticks run
- **THEN** every connected client receives exactly one `metrics` frame (the first), and the same holds for `services` and `code-server`
- **GIVEN** the collector's snapshot changes between tick 3 and tick 4
- **WHEN** tick 4 runs
- **THEN** every client receives one new `metrics` frame carrying the new payload and the slot holds it

#### R4: `gui` emits only when its payload changed, ignoring `human_input_ago_ms`
`guiTick()` MUST compute a dedup key equal to the `[]gui.StreamEntry` payload with `HumanInputAgoMS` zeroed, keep it in a new hub field `cachedGuiKey` beside `cachedGuiJSON`, and broadcast + update both fields only when the key differs from `cachedGuiKey`. The wire payload MUST continue to carry `human_input_ago_ms` (omitempty) as today. `setGUIEnabled` (the settings-POST seam) MUST keep broadcasting unconditionally and MUST update both the slot and the key.

- **GIVEN** an enabled, reachable GUI with a viewer who drove the display (`guiHumanInputSeen` called) and no other state change
- **WHEN** two dispatch ticks run 100 ms apart
- **THEN** clients receive exactly one `gui` frame, and its `human_input_ago_ms` is present
- **GIVEN** the probe flips `reachable` after the TTL
- **WHEN** the next dispatch tick runs
- **THEN** clients receive a new `gui` frame with the flipped value

#### R5: `guiTick` re-reads the settings file only when it changed
`internal/settings` MUST export a change-stamp helper (e.g. `Stamp() string`, or `LoadIfChanged(prev string) (Settings, string, bool)`) that stats the resolved config path — falling back to the legacy `~/.rk/settings.yaml` path exactly as `Load()` does and honouring `RK_CONFIG_DIR` — and returns a fingerprint derived from the path, mtime and size (an empty/absent-file fingerprint is a valid, stable value). `guiTick()` MUST call `settings.Load()` only on its first run and when the fingerprint differs from the hub's stored `settingsStamp`; otherwise it MUST reuse the last loaded `GUIEnabled`/`GUIGeometry`. `Save` MUST change the fingerprint (mtime or size) so a CLI-side `rk gui on` / `rk gui resize` still surfaces on the next dispatch tick.

- **GIVEN** an unchanged settings file
- **WHEN** `guiTick()` runs five times
- **THEN** the settings file is parsed once
- **GIVEN** `settings.Save` writes `gui.enabled: true` between two ticks
- **WHEN** the second tick runs
- **THEN** `guiTick` reloads and the `gui` payload reports `enabled:true` on that tick

### Hub: `sessions` dedup key

#### R6: The `sessions` dedup key ignores `activityTimestamp` on active windows
`pollServerUnit` MUST compute `jsonStr` (the wire payload) exactly as today and additionally a key `sessionsDedupKey(result)` — the same snapshot marshalled with `ActivityTimestamp` set to `0` on every window whose `Activity == "active"`, built from a shallow copy of the sessions slice and of each `Windows` slice (the cached `result` MUST NOT be mutated). The hub MUST hold a new `previousSessionsKey map[string]string`; `changed` MUST be `key != h.previousSessionsKey[server]`; on change both `previousJSON[server] = jsonStr` and `previousSessionsKey[server] = key` MUST be written in the same `h.mu` critical section before any fan-out of that tick (the ack-ordering invariant). `previousJSON[server]` therefore remains the last SENT payload. The dead-server reap MUST delete the new map's entry wherever it deletes `previousJSON`. Windows with `Activity == "idle"` keep their timestamp in the key. `agentIdleDuration`, `activity`, and every other field stay in the key.

- **GIVEN** two consecutive fetches for a server that differ only in `ActivityTimestamp` on a window whose `Activity` is `"active"` in both
- **WHEN** both units complete
- **THEN** clients receive one `sessions` frame
- **GIVEN** two consecutive fetches that differ only in `ActivityTimestamp` on a window whose `Activity` is `"idle"` in both
- **WHEN** both units complete
- **THEN** clients receive two `sessions` frames
- **GIVEN** two consecutive fetches where one window flips `Activity` from `"active"` to `"idle"`
- **WHEN** both units complete
- **THEN** clients receive two `sessions` frames and the second carries the window's latest `activityTimestamp`
- **GIVEN** a server whose last sent payload is cached and a suppressed tick followed it
- **WHEN** a new client subscribes that server
- **THEN** its ack snapshot equals the last SENT payload (not the suppressed one)

### Client: per-server metrics fan-out is change-gated

#### R7: `applyHostMetrics` reports change and the per-server fan-out runs only on change
In `app/frontend/src/contexts/session-context.tsx`, `applyHostMetrics(raw, snap)` MUST return `true` when `raw` differed from `hostMetricsPrevRef.current` (and it updated host metrics) and `false` otherwise. The `metrics` branch of `handleGlobalEvent` MUST run the per-server `updateSlice(name, { metrics: snap }, true)` fan-out only when `applyHostMetrics` returned `true`. The raw-string dedups for `services`, `code-server`, and `gui` MUST remain unchanged.

- **GIVEN** a `SessionProvider` with a current server attached and a probe component reading `useMetrics()`
- **WHEN** the same `metrics` global payload is emitted twice
- **THEN** the probe re-renders for the first emit only and `useMetrics()` still returns the snapshot
- **WHEN** a payload with a different `hostname` is emitted
- **THEN** the probe re-renders and `useMetrics()` returns the new snapshot

### Verification: tests and the instrument

#### R8: Go tests cover the new contract and the race suite stays green
`app/backend/api/sse_test.go` MUST gain tests proving R1 (no globals on a fold-only tick), R3 (one frame per unchanged payload across ticks; a new frame on change; late joiner still replayed), and R6 (the three `sessions` scenarios). `app/backend/api/sse_gui_test.go` MUST gain tests proving R4 (dedup ignores the age field; a flip still emits) and R5 (settings parsed once across unchanged ticks; reload after `Save`). `app/backend/internal/settings` MUST gain a unit test for the stamp helper (unchanged → equal; `Save` → different; legacy fallback mirrors `Load`; `RK_CONFIG_DIR` honoured). Existing tests in `sse_test.go`, `sse_gui_test.go`, `state_ws_test.go`, `sse_race_test.go`, `present_test.go`, `update_test.go` MUST pass — assertions that encoded the every-tick contract MAY be updated to the new contract but MUST NOT loosen timing or drop coverage. `go test ./api/ ./internal/settings/` and `go test -race ./api/` MUST pass.

- **GIVEN** the changed hub
- **WHEN** `cd app/backend && go test ./api/ ./internal/settings/ && go test -race ./api/` runs
- **THEN** all tests pass with the new tests present

#### R9: Frontend type-check and the session-context suite pass
`cd app/frontend && npx tsc --noEmit` MUST pass and `pnpm vitest run src/contexts/session-context.test.tsx` MUST pass with the new R7 assertions added to the existing "dedupes identical host-metrics payloads" test or a sibling test.

- **GIVEN** the client change
- **WHEN** the type-check and the suite run
- **THEN** both pass

#### R10: The instrument's before/after table is recorded and meets the per-route targets
The apply MUST record in this file's `## Notes` a before/after table from `just perf-idle-cpu <route> 60 --url http://127.0.0.1:3777` on the same-binary rig (worktree Go binary at HEAD vs the changed build, `dist` rebuilt for the changed side; one daemon on the port at a time; isolated `XDG_STATE_HOME`/`RK_CONFIG_DIR`; the `rk-perf-dedup` throwaway tmux server for churn — recipe in `intake.md` § 7). Targets over 60 s: `/rK` quiet total ≤ 0.5 msg/s with `services`/`code-server`/`gui` ≤ 1 frame each and `metrics` ≤ 6; `/` total ≤ 0.6 msg/s with `services`/`code-server`/`gui` ≤ 1 each and `metrics` ≤ 25; `/rk-perf-dedup` churn total ≤ 1.5 msg/s with `services`/`code-server`/`gui` ≤ 1 each, `metrics` ≤ 25, `sessions` ≤ before; renderer CPU on `/` and `/rK` within 3 points of before. The rig MUST be torn down afterwards (`tmux -L rk-perf-dedup kill-server`, stop the `:3777` daemon) and the user's own tmux servers and the `:3000` daemon MUST NOT be touched.

- **GIVEN** the before binary on `:3777`
- **WHEN** the three routes are measured for 60 s each
- **THEN** the before rows are recorded
- **GIVEN** the changed binary on `:3777` with the rebuilt `dist`
- **WHEN** the same three routes are measured
- **THEN** every target above holds and the after rows are recorded beside the before rows

### Non-Goals

- Changing the safety interval (12 s), the legacy interval (2.5 s), `sseEventDebounce`, `metricsPollInterval`, or `automatic-rename-format` — the emission *cadence* is untouched; only *whether* a frame is sent changes.
- Quantizing or dropping `activityTimestamp` from the wire; changing `agentIdleDuration`'s one-second granularity under 60 s.
- Removing `human_input_ago_ms` from the `gui` stream payload.
- Splitting the React `SessionContext` (measured below the noise floor — plan backlog idea).
- The subscribe-time hot loop and the non-bumping automatic-rename observation from R4 — reported in the ship summary for backlog filing, not fixed here.

### Design Decisions

#### Global broadcasts ride dispatch ticks and emit only on change
**Decision**: the four host-global emitters run inside the `if !resultsOnly` branch and each compares its marshalled payload string with its cached slot under `h.mu`, broadcasting only on inequality.
**Why**: 2026-09-16 R4 measurement — 6 of every 7 hub wake-ups are fold-only unit-completion echoes and the globals were 91–92 % of all `/ws/state` frames (2.2–2.6 msg/s quiet, 12.1 msg/s churn); `services`/`code-server`/`gui` payloads are identical across ticks for minutes at a time; every warm renderer and every attached server multiplies the parse cost.
**Rejected**: keeping every-tick emission and relying on client raw-string dedup (the frames are still sent, parsed, and stringified by every client); a per-emitter timer (adds cadence knobs; the dispatch tick already is the freshness bound the `sessions` snapshots have).
*Introduced by*: 260916-07pj-state-socket-broadcast-dedup

#### The `sessions` dedup key ignores `activityTimestamp` on active windows
**Decision**: `pollServerUnit` dedups on a key marshalled from a copy of the snapshot with `ActivityTimestamp` zeroed on windows whose `Activity` is `"active"`; the wire payload and the ack/replay snapshot (`previousJSON`) are unchanged and always the last SENT payload.
**Why**: the client renders `<cmd> · flowing` for active windows and never reads the timestamp there, so a stream of output on an active window produced a new frame every tick that changed nothing visible; an idle window's timestamp drives the `idle <dur>` label, so a burst between ticks on an idle window is a real change and still ships.
**Rejected**: quantizing to the 10 s activity bucket (changes wire precision for the sub-minute label); excluding the timestamp on every window (an idle window's label would go stale after a between-ticks burst until some other field changed).
*Introduced by*: 260916-07pj-state-socket-broadcast-dedup

#### `guiTick` stat-gates the settings re-read
**Decision**: `guiTick` parses the settings file only when an exported `internal/settings` change-stamp (path + mtime + size, legacy fallback mirrored) differs from the last one it saw; the POST seam `setGUIEnabled` is unchanged.
**Why**: `settings.Load()` was a read + YAML parse on every wake-up (7 per period); a stat preserves the reason the per-tick read existed — a CLI-side `rk gui on` writes the file directly and must surface without a POST — at the same one-tick latency.
**Rejected**: a TTL cache (adds a latency knob and can miss a flip inside the window); routing the CLI through the HTTP API (fails when the daemon is down — the original decision's rejected option, still valid).
*Introduced by*: 260916-07pj-state-socket-broadcast-dedup

## Tasks

### Phase 1: Setup

- [x] T001 Read `fab/plans/sahil/26-09-16-idle-cpu.md` § Change 3, § Standing context, § Decisions of record; read `intake.md` § What Changes and § R4 results; read `docs/memory/run-kit/api-and-sockets.md` § State Socket (Hub edge, Poll loop) and `docs/memory/run-kit/gui.md` § The `event: gui` state slot. Confirm the rig: `ss -ltn | grep 3777` (a probe daemon from R4 may still be running — stop it with `pkill -f 'rk-probe serve'` before your own before-run), `tmux -L rk-perf-dedup list-windows -t perf` (recreate per `intake.md` § 7 if absent), `ls /tmp/claude-1001/-home-sahil-code-sahil87-run-kit-worktrees-state-socket-broadcast-dedup/05f137f1-ba7c-4861-86a2-d8cfa5dc2098/scratchpad/rk-before` (the HEAD build; rebuild it per `intake.md` § 7 if absent). <!-- R10 -->
- [x] T002 Record the BEFORE rows: start the HEAD binary on `:3777` (`RK_PORT=3777 RK_HOST=127.0.0.1 RK_CODE_SERVER_PORT=3779 XDG_STATE_HOME=<scratch>/xdg-state RK_CONFIG_DIR=<scratch>/rk-config <scratch>/rk-before serve` from the repo root, in the background), then run `just perf-idle-cpu /rK 60 --url http://127.0.0.1:3777`, `just perf-idle-cpu / 60 --url http://127.0.0.1:3777`, `just perf-idle-cpu /rk-perf-dedup 60 --url http://127.0.0.1:3777` one at a time; paste each summary line and `## sockets` histogram into `## Notes` under "Before"; stop the daemon. <!-- R10 -->

### Phase 2: Core Implementation

- [x] T003 `app/backend/internal/settings/settings.go`: add the exported change-stamp helper (`Stamp() string` — stat the resolved config path, fall back to the legacy path exactly as `Load()` does, honour `RK_CONFIG_DIR`; fingerprint = path + mtime (UnixNano) + size; a stable sentinel for "no file"). Unit tests in `settings_test.go`: unchanged file → equal stamps; `Save` → different stamp; absent primary + present legacy → stamp reflects the legacy file; `RK_CONFIG_DIR` override → no legacy fallback. <!-- R5 -->
- [x] T004 `app/backend/api/sse.go`: add hub fields `previousSessionsKey map[string]string`, `cachedGuiKey string`, `settingsStamp string`, `settingsCache settings.Settings` (or the two fields it needs); initialise the map in `newSSEHub`; delete `previousSessionsKey[server]` in the dead-server reap block beside `previousJSON`. <!-- R6 -->
- [x] T005 `app/backend/api/sse.go` `poll()`: move the `metrics`, `services`, `code-server` emitters and the `h.guiTick()` call inside the `if !resultsOnly { … }` block, ahead of the `for _, server := range servers` dispatch loop; update the tick-shape comment ("fold → sweep → [dispatch tick: global broadcasts → dispatch] → wait"). Rewrite each of the three inline emitters to compare the marshalled string with its cached slot under `h.mu` and broadcast + write the slot only when different (snapshot + marshal stay outside the lock). <!-- R1 -->
- [x] T006 `app/backend/api/sse.go` `guiTick()` / `guiPayloadLocked()` / `setGUIEnabled()`: `guiPayloadLocked` returns `(payload, key string)` where `key` marshals the entry with `HumanInputAgoMS = 0`; `guiTick` broadcasts and writes `cachedGuiJSON`/`cachedGuiKey` only when `key != h.cachedGuiKey`; `setGUIEnabled` writes both and broadcasts unconditionally. Replace the per-tick `settings.Load()` with the stamp gate: read `settings.Stamp()` outside `h.mu`; when it differs from `h.settingsStamp` (or on first run) call `settings.Load()` and store the stamp; use the cached `GUIEnabled`/`GUIGeometry` otherwise. Keep the flip-forces-reprobe behaviour. <!-- R4 -->
- [x] T007 `app/backend/api/sse.go` `pollServerUnit`: add `sessionsDedupKey(result []sessions.ProjectSession) (string, error)` (shallow-copy sessions and each `Windows` slice, zero `ActivityTimestamp` where `Activity == "active"`, `json.Marshal`); compute `jsonStr` as today and `key`; under `h.mu` set `changed := key != h.previousSessionsKey[server]` and on change write both `previousJSON[server]` and `previousSessionsKey[server]`; fan out `jsonStr` as today. Update the dedup comment to state that `previousJSON` is the last SENT payload and why the key differs. <!-- R6 -->
- [x] T008 [P] `app/frontend/src/contexts/session-context.tsx`: `applyHostMetrics` returns `boolean` (changed); the `metrics` branch of `handleGlobalEvent` runs the per-server `updateSlice` fan-out only when it returned `true`; update the comment above the fan-out. `services`/`code-server`/`gui` branches unchanged. <!-- R7 -->

### Phase 3: Integration & Edge Cases

- [x] T009 `app/backend/api/sse_test.go`: add `TestSSEHubGlobalsNotRebroadcastWhenUnchanged` (static collectors, ≥ 3 dispatch ticks → one frame of each global per client; a second client added afterwards gets the replay), `TestSSEHubGlobalsEmitOnChange` (metrics snapshot changes → exactly one new frame), `TestSSEHubGlobalsSkipFoldOnlyTicks` (drive a results-only tick using the `sse_race_test.go` `TestSSE_PendingEventDrivenDispatchSurvivesResultsOnlyTick` harness shape; assert no global frame on it), `TestSSEHubSessionsDedupIgnoresActiveActivityTimestamp` (the three R6 scenarios, plus the ack snapshot equals the last SENT payload after a suppressed tick). <!-- R8 -->
- [x] T010 [P] `app/backend/api/sse_gui_test.go`: add `TestGuiTickDedupIgnoresHumanInputAge` (two ticks after `guiHumanInputSeen` → one `gui` frame; the frame carries `human_input_ago_ms`), `TestGuiTickEmitsOnReachableFlip` (probe flips after TTL → a second frame), `TestGuiTickReloadsSettingsOnlyWhenStampChanges` (count parses via a seam or by asserting `enabled` flips only after `settings.Save`/file touch). Re-run the existing gui tests; adjust any that counted every-tick frames. <!-- R8 -->
- [x] T011 Run `cd app/backend && go test ./api/ ./internal/settings/` then `go test -race ./api/`; fix regressions in `state_ws_test.go` (`TestStateWS_MetricsSubscriptionReceivesBroadcast`, `TestStateWS_ConcurrentGlobalBroadcast`, `TestStateWS_HelloReplaysGlobalSlots`), `sse_test.go` (`TestSSEHubSlowServerDoesNotDelayMetrics`, `TestSSEHubServicesBroadcast`, `TestSSEHubCodeServerBroadcast`), `present_test.go`, `update_test.go` by updating assertions to the new contract — never by weakening timing or reverting the behaviour. `gofmt -l` on the touched files must be clean (17 pre-existing unclean files elsewhere in `app/backend` are NOT this change's concern — leave them). <!-- R8 -->
- [x] T012 [P] `app/frontend/src/contexts/session-context.test.tsx`: extend the "dedupes identical host-metrics payloads" test (or add a sibling) with a `useMetrics()` probe under a current server proving the per-server slice re-renders once for two identical emits and again for a changed payload; run `cd app/frontend && npx tsc --noEmit && pnpm vitest run src/contexts/session-context.test.tsx`. <!-- R9 -->

### Phase 4: Polish

- [x] T013 Record the AFTER rows: `cd app/frontend && pnpm build`; `cp configs/tmux/default.conf app/backend/build/tmux.conf` (if absent) and `cd app/backend && CGO_ENABLED=0 go build -o <scratch>/rk-after ./cmd/rk`; start `rk-after` on `:3777` with the same env as T002 (only after the before daemon is stopped); measure the same three routes for 60 s each; paste into `## Notes` under "After" beside the before rows and state pass/fail against each R10 target; stop the daemon and `tmux -L rk-perf-dedup kill-server`. If a target misses, investigate before declaring the task done (a missed `services`/`code-server`/`gui` target means a payload field is churning — name it in Notes). <!-- R10 -->
- [x] T014 Run `just test-e2e "host-system-card"` once (the only e2e spec reading host metrics on `/`); record the result in `## Notes`. Do not run the full suite. <!-- R9 -->

## Execution Order

- T002 (before rows) must complete before any of T003–T008 touch the tree; T013 (after rows) must follow T011/T012 green.
- T003 blocks T006 (the stamp helper); T004 blocks T005–T007 (hub fields).
- T008 and T012 are independent of the Go tasks.

## Acceptance

### Functional Completeness

- [x] A-001 R1: The four global emitters live inside the `if !resultsOnly` branch of `poll()` and a fold-only tick emits no global frame (test `TestSSEHubGlobalsSkipFoldOnlyTicks` passes)
- [x] A-002 R2: `replayGlobalSlots` and `stateSubscribe`'s ack snapshot are unchanged and `TestStateWS_HelloReplaysGlobalSlots` passes
- [x] A-003 R3: `metrics`, `services`, `code-server` are broadcast only when their marshalled string differs from the cached slot; the compare and slot write are under `h.mu`; snapshot + marshal are outside it
- [x] A-004 R4: `gui` is broadcast only when the age-stripped key differs from `cachedGuiKey`; `human_input_ago_ms` still rides the wire; `setGUIEnabled` broadcasts unconditionally and updates both fields
- [x] A-005 R5: `internal/settings` exports the stamp helper with legacy fallback and `RK_CONFIG_DIR` honoured; `guiTick` parses settings only on first run or a stamp change
- [x] A-006 R6: `pollServerUnit` dedups on `sessionsDedupKey` (active-window timestamps zeroed, cached slice unmutated), writes `previousJSON` and `previousSessionsKey` in one critical section before fan-out, and the reap deletes both
- [x] A-007 R7: `applyHostMetrics` returns the changed flag and the per-server metrics fan-out runs only when true

### Behavioral Correctness

- [x] A-008 R3: With static collectors, three dispatch ticks yield one frame of each of `metrics`/`services`/`code-server` per client and a changed snapshot yields exactly one new frame
- [x] A-009 R6: Two fetches differing only in an active window's `activityTimestamp` yield one `sessions` frame; the idle-window and activity-flip cases yield two; a late subscriber's ack equals the last SENT payload
- [x] A-010 R5: `settings.Save` between two ticks makes the second tick reload and the `gui` payload reflect the new `enabled`

### Scenario Coverage

- [x] A-011 R8: `go test ./api/ ./internal/settings/` and `go test -race ./api/` pass with the new tests present; existing every-tick assertions were updated to the new contract without loosening
- [x] A-012 R9: `npx tsc --noEmit` passes and `session-context.test.tsx` passes with the per-server slice dedup assertion
- [x] A-013 R10: `## Notes` carries the before/after table for `/rK`, `/`, `/rk-perf-dedup` (60 s each, same-binary rig) and every per-route target holds; renderer CPU within 3 points of before

### Edge Cases & Error Handling

- [x] A-014 R4: A `reachable` flip after the probe TTL still emits a `gui` frame despite the age field being ignored
- [x] A-015 R6: A window flipping `active → idle` emits a frame carrying its latest `activityTimestamp`
- [x] A-016 R5: An absent settings file yields a stable stamp and `Default()` behaviour; the legacy path is stat-ed only when the primary is absent and `RK_CONFIG_DIR` is unset
- [x] A-017 R1: The dead-server reap, retain sweeps, and pending-flag full-tick logic are unchanged in position and behaviour (`sse_race_test.go` passes)

### Code Quality

- [x] A-018 Pattern consistency: new hub fields and maps follow the `previousJSON`/`cachedMetricsJSON` naming and initialisation pattern; the stamp helper follows `Load`/`Save` conventions in `internal/settings`
- [x] A-019 No unnecessary duplication: the three inline emitters share one shape (a small helper is acceptable if it does not obscure the lock discipline); the gui key reuses `guiPayloadLocked`'s entry construction
- [x] A-020 Derive state, no caches beyond justification: the only new in-memory state is dedup keys/stamps mirroring existing hub slots (Constitution II; no disk, no settings key)
- [x] A-021 No magic strings/numbers: the `"active"` comparison uses the existing activity constant if one exists in `internal/tmux` (add one beside `ActivityThresholdSeconds` if not)
- [x] A-022 Comment discipline: comments state the invariants (last-SENT payload, key-vs-payload split, why the age field is excluded, why fold-only ticks emit nothing) and cite no change IDs or PR numbers
- [x] A-023 Tests conform to the requirements, never the other way round (Test Integrity); `gofmt -l` clean on touched files
- [x] A-024 Frontend: type narrowing over assertions in the changed `metrics` branch; the `boolean` return is typed explicitly

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- Instrument before/after table: to be filled by T002 / T013.

### Before (T002, 2026-09-16, HEAD build `rk-before` on `:3777`, 60 s windows, one run at a time)

Regime note: the churn run measured in a quieter regime than R4's (fewer attached servers on this rig — 2.6 msg/s before vs R4's 12.1); the per-frame-type targets remain the operative check.

| Route | msg/s | kB/s | Frames by type (60 s) | Renderer CPU |
|---|---|---|---|---|
| `/rK` | 3.6 | 4.3 | 49 metrics · 49 services · 49 code-server · 49 gui · 20 sessions · 2 pong (218 frames) | 3.8 % |
| `/` | 2.6 | 3.2 | 35 metrics · 35 services · 35 code-server · 35 gui · 16 sessions · 2 pong (158 frames) | 1.5 % |
| `/rk-perf-dedup` (churn) | 2.6 | 3.2 | 34 metrics · 34 services · 34 code-server · 34 gui · 16 sessions · 2 pong (154 frames) | 2.2 % |

Summary lines:
- `perf-idle-cpu /rK 60.1s renderer=3.8% gpu=1.7% browser=0.1% main=1.2% recalcs=578 layouts=10 anims=7 xterm=0 iframes=0 ws[/ws/state]=3.6msg/s,4.3kB/s`
- `perf-idle-cpu / 60.1s renderer=1.5% gpu=0% browser=0.1% main=0.4% recalcs=0 layouts=5 anims=0 xterm=0 iframes=0 ws[/ws/state]=2.6msg/s,3.2kB/s`
- `perf-idle-cpu /rk-perf-dedup 60.1s renderer=2.2% gpu=0.3% browser=0.1% main=0.6% recalcs=252 layouts=5 anims=2 xterm=0 iframes=0 ws[/ws/state]=2.6msg/s,3.2kB/s`

### After (T013, 2026-09-16, changed build `rk-after` + rebuilt `dist` on `:3777`, 60 s windows, one run at a time)

| Route | msg/s | kB/s | Frames by type (60 s) | Renderer CPU |
|---|---|---|---|---|
| `/rK` | 0.3 | 1.9 | 5 metrics · 0 services · 0 code-server · 0 gui · 10 sessions · 2 pong (17 frames) | 3.8 % |
| `/` | 0.3 | 2.0 | 5 metrics · 0 services · 0 code-server · 0 gui · 11 sessions · 2 pong (18 frames) | 1.5 % |
| `/rk-perf-dedup` (churn) | 0.4 | 1.8 | 5 metrics · 0 services · 0 code-server · 0 gui · 15 sessions · 2 pong (22 frames) | 2.5 % |

Summary lines:
- `perf-idle-cpu /rK 60.1s renderer=3.8% gpu=2% browser=0.1% main=1% recalcs=573 layouts=10 anims=7 xterm=0 iframes=0 ws[/ws/state]=0.3msg/s,1.9kB/s`
- `perf-idle-cpu / 60.1s renderer=1.5% gpu=0% browser=0.1% main=0.3% recalcs=0 layouts=4 anims=0 xterm=0 iframes=0 ws[/ws/state]=0.3msg/s,2kB/s`
- `perf-idle-cpu /rk-perf-dedup 60.1s renderer=2.5% gpu=0.4% browser=0.1% main=0.7% recalcs=249 layouts=2 anims=2 xterm=0 iframes=0 ws[/ws/state]=0.4msg/s,1.8kB/s`

R10 target check (all PASS):
- `/rK`: total 0.3 ≤ 0.5 ✓; services/code-server/gui 0 ≤ 1 each ✓; metrics 5 ≤ 6 ✓; sessions 10 ≤ 20 (before) ✓
- `/`: total 0.3 ≤ 0.6 ✓; services/code-server/gui 0 ≤ 1 each ✓; metrics 5 ≤ 25 ✓ (5 ≈ one per 12 s — this run's sentinel route sat at the covered-server cadence, not the 2.5 s legacy one; either way inside the bound)
- `/rk-perf-dedup` churn: total 0.4 ≤ 1.5 ✓; services/code-server/gui 0 ≤ 1 each ✓; metrics 5 ≤ 25 ✓; sessions 15 ≤ 16 (before) ✓
- Renderer CPU within 3 points of before on `/` (1.5 → 1.5) and `/rK` (3.8 → 3.8) ✓

Rig torn down: `rk-after` daemon stopped (`:3777` free), `tmux -L rk-perf-dedup kill-server` done. The user's own tmux servers and the `:3000` daemon were not touched.

### T014 e2e

`just test-e2e "host-system-card"` → **2 passed (2.1s)** on 2026-09-16 (the only spec reading host metrics on `/`).

## Deletion Candidates

None — this change adds gating (dedup keys, the settings stamp, the changed-flag) without making existing code redundant. The client-side raw-string dedups for `services`/`code-server`/`gui` in `session-context.tsx` were considered and are deliberately retained as defence in depth (intake § What Changes 5, R7).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The stamp helper is an exported `Stamp() string` returning path+mtime+size (not a `LoadIfChanged`); the hub caches the last `Settings` value | Smallest API surface; mirrors `Load`'s path resolution; a nano-mtime + size fingerprint is sufficient for a hand-edited or `Save`-written YAML | S:70 R:90 A:85 D:75 |
| 2 | Confident | The `preRendered` envelope may be built before the lock even when the broadcast is skipped | One wasted marshal per 2.5–12 s is negligible and keeps the existing render-outside-the-lock discipline; the apply may move it into the changed branch if the review prefers | S:70 R:95 A:85 D:75 |
| 3 | Confident | The `sessions` key is computed by marshalling a shallow-copied snapshot rather than by string-editing `jsonStr` | Correct by construction against field-order or escaping surprises; one extra marshal per server per dispatch tick is within budget | S:70 R:90 A:85 D:75 |
| 4 | Confident | Test hubs that assert a first `metrics` frame after subscribe keep passing via the first-tick emit plus the late-joiner replay; assertions counting repeated frames are updated, not the hub | The intake's test survey found none of the named tests depend on repetition beyond the first frame; Test Integrity forbids bending the implementation | S:65 R:85 A:80 D:70 |
| 5 | Confident | The churn route's `sessions ≤ before` target (rather than the plan's "≤ 1/s per subscribed server" alone) is the operative bound because the churn server renames every 0.3 s under a 2.5 s dispatch cadence | The rename is a real visible change on every dispatch tick; the plan's bound is met trivially at 2.5 s and the tighter "not worse" bound is what proves the key change is safe | S:65 R:90 A:80 D:70 |

5 assumptions (0 certain, 5 confident, 0 tentative).
