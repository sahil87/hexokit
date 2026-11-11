# Plan: Daemon Autostart Visibility (doctor row + system-card line)

**Change**: 261111-whzt-daemon-autostart-visibility
**Intake**: `intake.md`

## Requirements

### Autostart: Shared summary vocabulary

#### R1: `Status.Summary()` is the single autostart state string
`app/backend/internal/daemon/autostart/autostart.go` SHALL expose `func (s Status) Summary() string` returning exactly one of:

| Condition (evaluated in order) | Result |
|---|---|
| `Registered && Enabled && StartsAt == StartsAtBoot` | `on (boot)` |
| `Registered && Enabled && StartsAt == StartsAtLogin && Linger != nil && !*Linger` | `on (login only — enable lingering for boot)` (U+2014 em dash) |
| `Registered && Enabled` (any other StartsAt, incl. login with `Linger == nil` or `*Linger == true`) | `on (login)` |
| `Registered && !Enabled` | `registered but disabled` |
| otherwise | `off` |

The function MUST read only `Status` fields — never `Platform`, `Manager`, or `runtime.GOOS` — so any backend registered through `autostart.Register` (the macOS LaunchAgent backend included, which leaves `Linger` nil) is summarised without change. The five strings SHALL be named constants.

- **GIVEN** a Linux status with `Registered`, `Enabled`, `StartsAt: "login"`, `Linger: &false`
- **WHEN** `Summary()` is called
- **THEN** it returns `on (login only — enable lingering for boot)`

- **GIVEN** a status with `Registered`, `Enabled`, `StartsAt: "login"`, `Linger: nil` (macOS shape)
- **WHEN** `Summary()` is called
- **THEN** it returns `on (login)`

#### R2: `rk daemon autostart status` text uses the shared summary
`writeAutostartStatusText` in `app/backend/cmd/rk/daemon_autostart.go` SHALL print its first line as `Autostart: ` + `s.Summary()`, replacing its private state switch. Detail lines and `Hint:` lines are unchanged.

- **GIVEN** a registered, enabled, login-only Linux status with lingering off
- **WHEN** `rk daemon autostart status` renders text
- **THEN** the first line is `Autostart: on (login only — enable lingering for boot)` and the `Hint:` line naming `loginctl enable-linger <user>` still prints

### Doctor: autostart row

#### R3: `rk doctor` reports a `daemon autostart` row
`runDoctorChecks()` in `app/backend/cmd/rk/doctor.go` SHALL append a check named `daemon autostart`, immediately after the `cron ticker` row, produced by a pure `autostartCheck(status func(context.Context) (autostart.Status, error)) doctorCheck`. Production wiring passes a package-level seam `autostartStatusFn` that resolves the backend through the existing `autostartBackendFn` seam (`daemon_autostart.go`) and calls `Status` under a 10-second `context.WithTimeout`. The note SHALL be `Summary()` followed by `"; "`-joined fragments, in this order, each only when its condition holds:

1. `Stale` → `registration stale — re-run 'rk daemon autostart on'`
2. `LastExitCode != nil && *LastExitCode != 0` → `last start exited <n>`, plus ` (<LastResult>)` when `LastResult != ""`
3. summary `off` → `enable with 'rk daemon autostart on'`
4. summary is the login-only form → `details: 'rk daemon autostart status'`

- **GIVEN** autostart is not registered
- **WHEN** `rk doctor` runs
- **THEN** the row prints `[ OK ] daemon autostart — off; enable with 'rk daemon autostart on'`

- **GIVEN** a registered, enabled, boot-start status
- **WHEN** `rk doctor --json` runs
- **THEN** the checks array contains `{"name":"daemon autostart","ok":true,"note":"on (boot)"}`

#### R4: The autostart row never fails doctor
The row MUST always be `OK: true` and MUST NOT change `report.OK`. A backend-resolution error (unsupported GOOS) or a `Status` error (e.g., no systemd) SHALL produce the note `unavailable — <err>`.

- **GIVEN** `autostartBackendFn` returns `daemon autostart is not supported on darwin (supported: linux)`
- **WHEN** `rk doctor` runs
- **THEN** the row is `[ OK ] daemon autostart — unavailable — daemon autostart is not supported on darwin (supported: linux)` and the overall verdict is unaffected

### API: read-only autostart endpoint

#### R5: `GET /api/daemon/autostart` serves the autostart state
The router (`app/backend/api/router.go`) SHALL register `GET /api/daemon/autostart` (no POST — read-only, Principle IX) handled in a new `app/backend/api/autostart.go`. On success it SHALL respond `200` with `{"supported": true, "summary": <Summary()>, "status": <autostart.Status, A1's JSON tags verbatim>}`. When backend resolution or `Status` fails it SHALL respond `200` with `{"supported": false, "summary": "unavailable", "error": "<err text>"}`. The probe runs under a 10-second timeout derived from the request context. The backend is reached through a nil-defaulting `Server` seam field `autostartStatusFn func(ctx context.Context) (autostart.Status, error)` (the `guiEnsureFn` idiom); nil falls back to `autostart.For(runtime.GOOS)` + `Status`. The handler MUST NOT call `On` or `Off`.

- **GIVEN** a server whose seam returns a registered/enabled/boot status
- **WHEN** a client issues `GET /api/daemon/autostart`
- **THEN** the response is 200 JSON with `supported: true`, `summary: "on (boot)"`, and `status.starts_at: "boot"`

- **GIVEN** a server whose seam returns an error
- **WHEN** a client issues `GET /api/daemon/autostart`
- **THEN** the response is 200 JSON with `supported: false`, `summary: "unavailable"` and the error text

### UI: system-card autostart row

#### R6: The HexoKit system card shows a read-only autostart row
`app/frontend/src/components/system-card.tsx` SHALL fetch `getDaemonAutostart()` (new, in `app/frontend/src/api/client.ts`, typed `DaemonAutostartResponse`) once on mount and render one row between the daemon line and the service rows: label `autostart`, value = `summary`, `data-testid="system-card-autostart"`, styled like a service row. When `summary === "off"` the value reads `off — rk daemon autostart on`. When `supported === false` the value reads `unavailable — <error>` inline (bare `unavailable` when no error text) — not a `Tip`, which is unreachable on non-focusable text by keyboard and on coarse pointers (Constitution V). The row has NO button, toggle or click handler.

- **GIVEN** the endpoint returns `{supported: true, summary: "on (login only — enable lingering for boot)"}`
- **WHEN** the Host page renders the system card
- **THEN** the card shows `autostart` followed by `on (login only — enable lingering for boot)`

- **GIVEN** the endpoint returns `summary: "off"`
- **WHEN** the card renders
- **THEN** the row reads `off — rk daemon autostart on`

#### R7: The autostart row degrades by disappearing
When `getDaemonAutostart()` rejects (an older daemon 404s the route, network error) the row SHALL NOT render, and the rest of the card SHALL render unchanged. A response arriving after unmount MUST NOT set state.

- **GIVEN** the endpoint 404s
- **WHEN** the card renders
- **THEN** no `system-card-autostart` element exists and the daemon line and service rows render as before

### Non-Goals

- A settings-registry key, UI toggle, POST endpoint, or palette action for autostart — the A3 open decision resolved to status-line-only (see Design Decisions).
- Live refresh of the row (SSE plumbing, polling) — a mount-time read is enough for a read-only awareness row; polling is an anti-pattern here.
- The macOS backend itself (A2) and docs/skill updates (A4).

### Design Decisions

#### Autostart is surfaced as a read-only status line, not a settings toggle
**Decision**: The UI shows the autostart state as a read-only row on the HexoKit system card fed by `GET /api/daemon/autostart`; there is no settings-registry key, toggle, POST route, or palette action.
**Why**: Autostart state lives in the OS service manager, not `config.yaml` — a registry key would be a drifting second copy; the HOST HEALTH zone is read-only by contract; turning autostart on is a deliberate CLI opt-in (plan default "off"; lingering needs a privileged step a toggle can't take anyway).
**Rejected**: A `daemon_autostart` settings-registry entry with an apply hook (second source of truth, mutates host state from a read-only zone, remote one-click enable); a system-card toggle + palette action (same remote-enable concern).
*Introduced by*: 261111-whzt-daemon-autostart-visibility

#### One `Status.Summary()` feeds CLI, doctor and UI
**Decision**: The autostart state vocabulary is a method on the platform-neutral `autostart.Status`; the CLI status text, the doctor row and the API's `summary` all call it.
**Why**: Three surfaces must say the same thing; keying the lingering clause on `Linger != nil` rather than the platform keeps every backend (A2 included) working with no surface change.
**Rejected**: Deriving the label separately in the frontend from raw fields (a second copy of the rules in TypeScript).
*Introduced by*: 261111-whzt-daemon-autostart-visibility

## Tasks

### Phase 1: Shared vocabulary

- [x] T001 Add the five summary constants and `func (s Status) Summary() string` to `app/backend/internal/daemon/autostart/autostart.go`; add a table test covering every row of the R1 mapping (incl. linger nil/true/false) to `app/backend/internal/daemon/autostart/autostart_test.go` <!-- R1 -->
- [x] T002 Switch `writeAutostartStatusText` in `app/backend/cmd/rk/daemon_autostart.go` to `"Autostart: " + s.Summary()` and update expectations in `app/backend/cmd/rk/daemon_autostart_test.go` (add a login-only/linger-off case) <!-- R2 -->

### Phase 2: Core implementation

- [x] T003 [P] Add `autostartStatusFn` seam + pure `autostartCheck` to `app/backend/cmd/rk/doctor.go`, append it after the `cron ticker` row in `runDoctorChecks()` (never touching `report.OK`); add a table test in `app/backend/cmd/rk/doctor_test.go` covering off, boot, login-only, plain login, disabled, stale, non-zero exit (with and without LastResult), resolution error and Status error — every case `OK: true` <!-- R3 R4 --> <!-- rework: install a fake autostartStatusFn for the whole cmd/rk test package (TestMain in cmd/rk/main_test.go) so tests calling runDoctorChecks() never reach the real service manager (A-019) -->
- [x] T004 [P] Add `autostartStatusFn` seam field on `Server` (`app/backend/api/router.go`, documented beside the gui/openAIMCP seam group), register `r.Get("/api/daemon/autostart", s.handleDaemonAutostart)`, implement the handler in new `app/backend/api/autostart.go`, and add `app/backend/api/autostart_test.go` covering supported (boot/off/login-only summaries + verbatim `status`) and error → `supported:false` (use `NewTestRouterAndServer` to inject the seam) <!-- R5 -->
- [x] T005 Add `DaemonAutostartResponse` type + `getDaemonAutostart()` to `app/frontend/src/api/client.ts` (throwOnError on non-OK, mirroring `getHealth`) <!-- R6 -->
- [x] T006 Render the autostart row in `app/frontend/src/components/system-card.tsx` (mount-time fetch with a cancelled flag, hidden on rejection, off-hint copy, unavailable + `Tip`); extend `app/frontend/src/components/system-card.test.tsx` with a partial `vi.mock("@/api/client")` and cases for boot, login-only, off-hint, unavailable-with-tip, and rejection ⇒ row absent (existing tests keep passing) <!-- R6 R7 --> <!-- rework: value must wrap, not truncate, so the login-only advice survives the 375px card; make the after-unmount test meaningful or drop its claim; stub getDaemonAutostart in host-overview-page.test.tsx; declare status on DaemonAutostartResponse -->

### Phase 3: Integration & evidence

- [x] T007 Extend `app/frontend/tests/e2e/host-system-card.spec.ts` with a `page.route("**/api/daemon/autostart", …)`-stubbed test asserting the row text on `/`, with a JSDoc **Proves:/Steps:** block and the file-header comment updated for the new stub <!-- R6 -->
- [x] T008 Add `app/frontend/tests/demo/daemon-autostart-row.demo.ts` (pattern from an existing demo spec): stub `/api/daemon/autostart` to the login-only payload, open `/`, dwell on the HexoKit system card <!-- R6 -->
- [x] T009 Document `GET /api/daemon/autostart` (request, both response shapes, read-only, seam) in `docs/specs/api.md` near § Health <!-- R5 -->

### Phase 4: Verification

- [x] T010 Run `just test-backend`, `just test-frontend`, `cd app/frontend && npx tsc --noEmit` (via the existing typecheck recipe if one exists), and `just test-e2e host-system-card`; fix any failures <!-- R1 R2 R3 R4 R5 R6 R7 --> <!-- verified: just check (tsc) clean; just test-backend new tests pass (remaining failures are host-environment: tmux-guard shim flips TestPortPinRowRealPolicyValues' report.OK, inotify exhaustion in TestHomeMigrationPickupE2E/tmuxctl); just test-frontend new tests pass; local `just test-e2e host-system-card` blocked by host inotify exhaustion (126/128 instances) — e2e verification deferred to CI, which runs the full e2e suite on every push -->

## Execution Order

- T001 blocks T002, T003, T004 (all call `Summary()`)
- T005 blocks T006; T006 blocks T007, T008

## Acceptance

### Functional Completeness

- [x] A-001 R1: `Status.Summary()` exists in `internal/daemon/autostart` and returns the five exact strings per the R1 table, reading no platform field
- [x] A-002 R2: `rk daemon autostart status` text's first line is `Autostart: <Summary()>`
- [x] A-003 R3: `rk doctor` (human and `--json`) includes a `daemon autostart` row after `cron ticker` with the R3 note composition
- [x] A-004 R5: `GET /api/daemon/autostart` is registered (GET only) and returns the R5 success and unavailable shapes
- [x] A-005 R6: The system card renders the read-only `autostart` row between the daemon line and service rows, with off-hint and unavailable-tip variants

### Behavioral Correctness

- [x] A-006 R2: The CLI status text no longer computes its own state string; Linux login-only now reads `on (login only — enable lingering for boot)`

### Scenario Coverage

- [x] A-007 R1: A Go table test covers every Summary branch including linger nil/true/false
- [x] A-008 R3: A Go table test covers every doctor note fragment
- [x] A-009 R5: Go handler tests cover success and error responses through an injected seam
- [x] A-010 R6: Vitest covers boot, login-only, off-hint and unavailable rows; a stubbed Playwright e2e test asserts the row on `/` with a Proves/Steps JSDoc block

### Edge Cases & Error Handling

- [x] A-011 R4: The doctor row is `OK: true` for every input including both error kinds, and never changes `report.OK`
- [x] A-012 R7: A rejected fetch hides the row without affecting the rest of the card; no state update after unmount

### Code Quality

- [x] A-013 Pattern consistency: New code follows the doctor row (pure check + seam), API seam-field, client getter and system-card row patterns of surrounding code
- [x] A-014 No unnecessary duplication: The summary rules live once (Go); the frontend renders `summary` rather than re-deriving it; the doctor seam reuses `autostartBackendFn`
- [x] A-015 Subprocess safety: No new subprocess calls; the status probe runs under a bounded context (Principle I / Process Execution)
- [x] A-016 No client polling: The row is a single mount-time fetch, no `setInterval`
- [x] A-017 Comments state constraints only — no narration, no change IDs or PR numbers
- [x] A-018 Minimal surface: No new page/route in the SPA, no settings-registry key, no new control (so no palette entry required)

### Security

- [x] A-019 R5: The endpoint is read-only — no code path in this change calls `Backend.On`/`Off`, `systemctl enable`, or `loginctl enable-linger`; tests and demos use seams/stubs only

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant (the private state switch in `writeAutostartStatusText` it superseded was already removed in the same diff)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `registered but disabled` kept as the fourth summary string; `on (login)` for any enabled login start without a known-off linger | Matches A1's existing CLI vocabulary; nil linger is macOS or an unreadable logind, where advising lingering would be wrong or unverified | S:70 R:85 A:80 D:70 |
| 2 | Confident | API JSON uses `supported`/`summary`/`status`/`error` keys with `status` nesting A1's `autostart.Status` verbatim | Reuses A1's JSON tags (snake_case) unchanged; envelope keys are new and minimal | S:65 R:85 A:75 D:70 |
| 3 | Confident | Doctor row placed after `cron ticker`; seam reuses `autostartBackendFn` | Both rows answer "will the daemon's background work run"; reuse avoids a second GOOS seam | S:65 R:90 A:80 D:75 |
| 4 | Certain | Tests and demo stub the route/seams; nothing reaches a real service manager in assertions | User's never-enable rule and determinism | S:90 R:90 A:90 D:90 |

4 assumptions (1 certain, 3 confident, 0 tentative).
