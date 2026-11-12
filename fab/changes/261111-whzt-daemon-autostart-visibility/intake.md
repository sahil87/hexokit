# Intake: Daemon Autostart Visibility (doctor row + system-card line)

**Change**: 261111-whzt-daemon-autostart-visibility
**Created**: 2026-11-11

## Origin

> Implement step A3 of fab/plans/sahil/26-11-11-rk-daemon-autostart.md: "Visibility" for daemon autostart — an `rk doctor` row ("Daemon autostart: on (boot) / on (login only — enable lingering for boot) / off") and the same fact on the existing daemon-status surface in the UI. Read that plan (Goal, Decisions, Principles IV/V mentioned in brief A3) first. The A1 Linux autostart implementation (PR #1123, branch 261111-rreg-linux-daemon-autostart-systemd, `rk daemon autostart status` backend) is already in this worktree via cherry-pick — build on its status API rather than re-deriving state. The macOS backend (A2, PR #1124) is not here; keep the doctor/UI code platform-neutral by going through the shared surface, so it works for both once both merge. Resolve A3's open decision at intake (settings-registry toggle vs. status line only) and record it; any new UI control must also be a palette action, and no new page. Never enable autostart or lingering on this machine. Once the intake is done, continue with /fab-fff.

One-shot invocation from the operator, carrying a lane brief (rig safety via `just` recipes only, PR evidence via `just demo <name> --before`, CI to green, `/git-pr-review`, one-line final report). No prior conversation; the plan doc is the design source.

Plan brief A3 (verbatim):

> - `rk doctor`: one row, "Daemon autostart: on (boot) / on (login only — enable lingering for boot) / off".
> - The daemon-status surface in the UI shows the same fact. Any new UI control must also be a palette action (Principle V). No new page (Principle IV).

Plan open decision for A3: *"Is a UI toggle worth a settings-registry entry, or is a status line enough?"* — **resolved here: status line only** (see What Changes § Decision).

## Why

1. **Problem.** A1 added `rk daemon autostart on|off|status`, but the only way to learn whether the daemon will come back after a reboot is to know that verb exists and run it. `rk doctor` — the place users go to ask "is my install healthy?" — says nothing, and the Host page's HexoKit system card (the UI's daemon-status surface: version / uptime / port + Restart) says nothing either. The reboot hole is closed only for users who remember they closed it.
2. **Consequence if not done.** A machine with autostart off (the default) or "on (login only)" on a headless Linux box that reboots unattended silently loses every cron entry, the operator, and all reminders until someone runs `rk daemon start` — exactly the failure the plan exists to fix, now merely hidden behind an unadvertised verb. A login-only registration on a server that nobody logs into is the worst case: the user believes autostart is on.
3. **Why this approach.** Both surfaces read the one platform-neutral `autostart.Backend.Status` (A1's shared surface in `internal/daemon/autostart`) through `autostart.For(goos)`, so the macOS backend (A2) lights up on both surfaces the moment it merges with zero doctor/UI changes, and neither surface re-derives systemd/launchd state. A read-only status line (not a toggle) keeps the Host page's HOST HEALTH zone read-only, keeps the OS service manager the single source of truth, and keeps "turn it on" a deliberate CLI act per the plan's "Off by default / nothing starts on a machine where the user didn't ask" decision.

## What Changes

### Decision: status line only — no settings-registry entry, no UI toggle

Resolved at intake (plan § Open decisions, A3). The UI shows the autostart state as a **read-only row**; there is **no** settings-registry key, **no** toggle, **no** new mutating endpoint, and therefore **no** new palette action (Principle V only binds actions reachable via a control — a read-only row adds none). Reasons:

- **Wrong store.** The settings registry (`internal/settings`) is per-instance preferences persisted in `~/.config/hexokit/config.yaml`. Autostart state lives in the OS service manager (a systemd user unit / a LaunchAgent plist). A registry key would be a second copy that drifts the moment the user runs `rk daemon autostart off` from a shell — the registry would have to *derive* its value from the service manager, which is not what registry keys are. Principle II's "external writes win" makes the service manager authoritative anyway.
- **HOST HEALTH is read-only by contract.** `docs/memory/run-kit/ui/sidebar.md` § HOST HEALTH Zone: "Read-only awareness view; nothing here mutates host state (Constitution IV)". The system card's only verb is Restart, which re-uses an existing seam.
- **Deliberate opt-in.** The plan's Default decision is "Off — nothing should start on a machine where the user didn't ask for it", and A5 (turning it on) is a user gate. A web toggle reachable from any tailnet browser (and from the operator's MCP/automation reach) makes enabling a boot-time job a one-click remote act. The CLI verb stays the single door.
- **Lingering can't be toggled anyway.** Boot-time start on Linux needs `loginctl enable-linger`, a privileged one-time step `autostart on` never runs. A toggle could only ever reach "on (login only)", so the useful remediation is copy that names the command, not a switch.

Rejected: a settings-registry entry (`daemon_autostart` bool) with an apply hook — second source of truth, mutates host state from a read-only zone, needs a palette action and a POST endpoint. Rejected: a system-card toggle button + palette action without a registry key — same remote-enable concern; deferrable to a later step if users ask.

### Shared summary in `internal/daemon/autostart` (platform-neutral)

Add one formatter to `app/backend/internal/daemon/autostart/autostart.go` so doctor, the API and the CLI's `status` text cannot drift:

```go
// Summary is the one-line autostart state shown by `rk doctor` and the
// Host page's system card.
func (s Status) Summary() string
```

Mapping (exact strings):

| Status | Summary |
|---|---|
| `Registered && Enabled && StartsAt == "boot"` | `on (boot)` |
| `Registered && Enabled && StartsAt == "login" && Linger != nil && !*Linger` | `on (login only — enable lingering for boot)` |
| `Registered && Enabled && StartsAt == "login"` otherwise (macOS: `Linger == nil`; Linux with an unreadable linger state) | `on (login)` |
| `Registered && !Enabled` | `registered but disabled` |
| otherwise | `off` |

Platform-neutral by construction: it reads only `Status` fields; the lingering clause keys off `Linger != nil` (a field only backends with lingering populate), never off `Platform == "linux"`. The em dash is U+2014, matching the plan's wording.

`writeAutostartStatusText` in `app/backend/cmd/rk/daemon_autostart.go` currently computes its own `Autostart: …` state string (`off` / `on (<starts_at>)` / `registered but disabled`). Switch it to `"Autostart: " + s.Summary()` so the CLI, doctor and UI print one vocabulary (the CLI's `on (login)` line on Linux-without-linger becomes `on (login only — enable lingering for boot)`; its `Hint:` lines still carry the exact `loginctl enable-linger <user>` command). Update `daemon_autostart_test.go` expectations accordingly.

### `rk doctor` row — `daemon autostart`

New check in `app/backend/cmd/rk/doctor.go`, appended by `runDoctorChecks()` (place it right after the `cron ticker` row — both are "will the daemon's background work run" facts):

```go
// autostartStatusFn is the seam for the doctor autostart row: tests replace it
// so no check ever reaches a real service manager.
var autostartStatusFn = func(ctx context.Context) (autostart.Status, error) {
	b, err := autostartBackendFn() // the existing daemon_autostart.go seam (autostart.For(autostartGOOS))
	if err != nil { return autostart.Status{}, err }
	return b.Status(ctx)
}

func autostartCheck(status func(context.Context) (autostart.Status, error)) doctorCheck
```

- Name: `daemon autostart`. Human row: `  [ OK ] daemon autostart — on (boot)`.
- **Always OK-shaped** (the cron-ticker / code-server / gui posture): off is the default and login-only is a state, never a dependency failure — the row never flips `report.OK`.
- Note = `s.Summary()`, then `"; "`-joined fragments (remediation rides the Note because `Hint` prints only on FAIL rows — the locale-row precedent):
  - `Stale` → `registration stale — re-run 'rk daemon autostart on'`
  - `LastExitCode != nil && *LastExitCode != 0` → `last start exited <n>` (+ ` (<LastResult>)` when non-empty)
  - summary is `off` → `enable with 'rk daemon autostart on'`
  - summary is the login-only form → `details: 'rk daemon autostart status'` (the status verb's hints print the exact `loginctl enable-linger <user>` command; doctor does not re-derive the username)
- Errors degrade, never fail: `autostart.For` error (unsupported GOOS — today darwin in this branch until A2 merges) or a `Status` error (no systemd: `systemdErrMissing`) → Note `unavailable — <err>`.
- The probe runs under `context.WithTimeout(context.Background(), 10*time.Second)`; the backend's own subprocesses already use `exec.CommandContext` with per-call timeouts (Principle I).
- `--json` carries `{name:"daemon autostart", ok:true, note:"…"}` verbatim — no new fields on `doctorCheck`.

Examples:

```
  [ OK ] daemon autostart — off; enable with 'rk daemon autostart on'
  [ OK ] daemon autostart — on (boot)
  [ OK ] daemon autostart — on (login only — enable lingering for boot); details: 'rk daemon autostart status'
  [ OK ] daemon autostart — on (boot); registration stale — re-run 'rk daemon autostart on'
  [ OK ] daemon autostart — unavailable — daemon autostart is not supported on darwin (supported: linux)
```

Tests in `doctor_test.go`: table test over `autostartCheck` with a fake status func covering every Summary branch, stale, non-zero exit, both error kinds, and an assertion that the row is OK in every case.

### API — `GET /api/daemon/autostart`

New read-only route registered in `app/backend/api/router.go` next to `/api/health`, handler in a new `app/backend/api/autostart.go`:

```json
// 200 — backend resolved and Status succeeded
{ "supported": true, "summary": "on (login only — enable lingering for boot)", "status": { /* autostart.Status verbatim, A1's JSON tags */ } }
// 200 — autostart.For or Status errored (unsupported platform, no systemd)
{ "supported": false, "summary": "unavailable", "error": "daemon autostart is not supported on darwin (supported: linux)" }
```

- `GET` (Principle IX: reads are GET). Always 200 for a resolved request; the unavailable case is data, not an HTTP error, so the UI renders it.
- Behind a `Server` seam field (the `guiEnsureFn`/`openAIMCPEnsureFn` idiom): `autostartStatusFn func(ctx) (autostart.Status, error)`, nil ⇒ production `autostart.For(runtime.GOOS)` + `Status`. `NewTestRouter` handlers and Go tests inject a fake — no test reaches a real `systemctl`.
- Request context with a 10 s timeout bounds the probe.
- No caching: autostart changes out-of-band via the CLI, the probe is a handful of short subprocesses, and the endpoint is hit once per system-card mount.
- Document in `docs/specs/api.md` (new `### GET /api/daemon/autostart` section near § Health).

Go tests in `app/backend/api/autostart_test.go`: supported/on-boot, login-only, off, unsupported error → `supported:false`, method is GET only.

### UI — autostart row on the HexoKit system card

`app/frontend/src/components/system-card.tsx` gains one read-only row between the daemon line and the service rows, styled like a service row (`text-text-secondary` label + status, `flex items-center gap-[1ch]`):

```
HexoKit  v0.9.1 · up 3d 4h · :6123                 [Restart]
autostart  on (login only — enable lingering for boot)
jobs       2 jobs                                     [View]
code-server up                                        [View]
remotes    not running
```

- Label `autostart`; value = the API's `summary`. When `summary === "off"` the value renders `off — rk daemon autostart on` (education micro-copy: the empty state names what fills it). When `supported === false` render `unavailable` with a `Tip` carrying the `error` text. The row carries `data-testid="system-card-autostart"`.
- **No button, no toggle, no click handler** — therefore no palette entry (Principle V) and no new page/route (Principle IV).
- Data: new `getDaemonAutostart(): Promise<DaemonAutostartResponse>` in `app/frontend/src/api/client.ts` (+ type in `src/types.ts` or alongside), fetched once on `SystemCard` mount (`useEffect` + local `useState`; abort/ignore on unmount). Any fetch failure (an older daemon 404s the route, network error) **hides the row** — graceful degrade, the same posture as the version-slot's uptime/port fields on older daemons.
- No SSE/state-socket plumbing: the SSE `version` slot is boot-constant and cached, while autostart changes at runtime; a mount-time GET is the right freshness for a read-only awareness row.
- Unit tests in `app/frontend/src/components/system-card.test.tsx` (mock `getDaemonAutostart`): boot, login-only, off-with-hint, unavailable-with-tip, fetch-rejects ⇒ row absent.
- e2e: extend `app/frontend/tests/e2e/host-system-card.spec.ts` with a `page.route("**/api/daemon/autostart", …)` stub test asserting the row text for one state (the rig daemon must never touch the real service manager's answer for assertions — stubbed for determinism), with the required JSDoc **Proves:/Steps:** block and file-header update.

### PR evidence

Visible in the web UI ⇒ `just demo daemon-autostart-row --before` with a new spec `app/frontend/tests/demo/daemon-autostart-row.demo.ts`: open `/`, show the HexoKit system card (desktop + mobile). Before = base (no row); after = the row. The demo stubs `/api/daemon/autostart` via `page.route` to a fixed `on (login only — enable lingering for boot)` payload so the recording never depends on (or touches) this machine's service manager. Not a shell-only path (`app/desktop/src/` untouched) ⇒ web lane only.

### Safety

Read-only everywhere: nothing in this change calls `Backend.On`/`Off`, `systemctl enable`, or `loginctl enable-linger`. Tests use seams/fakes; demos stub the route. Never enable autostart or lingering on this machine (plan rule 3; A5 is the user gate).

## Affected Memory

- `run-kit/daemon-autostart`: (modify) add the `Status.Summary()` vocabulary, the doctor row, the `GET /api/daemon/autostart` route and the system-card row; record the status-line-only decision (A3 open decision) in Design Decisions
- `run-kit/architecture/cli`: (modify) doctor row description gains the `daemon autostart` row; `daemon autostart status` text now uses `Summary()`
- `run-kit/api-and-sockets`: (modify) new `GET /api/daemon/autostart` route
- `run-kit/ui/sidebar`: (modify) § HOST HEALTH Zone — HexoKit system card gains the read-only autostart row

## Impact

- **Backend**: `app/backend/internal/daemon/autostart/autostart.go` (+test), `app/backend/cmd/rk/doctor.go` (+test), `app/backend/cmd/rk/daemon_autostart.go` (+test), `app/backend/api/router.go`, new `app/backend/api/autostart.go` (+test).
- **Frontend**: `app/frontend/src/api/client.ts`, types, `app/frontend/src/components/system-card.tsx` (+test), `app/frontend/tests/e2e/host-system-card.spec.ts`, new `app/frontend/tests/demo/daemon-autostart-row.demo.ts`.
- **Docs/specs**: `docs/specs/api.md`; memory files above.
- **No** settings-registry change, **no** palette change, **no** new route/page, **no** desktop-shell change.
- **Cross-step**: A2 (macOS, PR #1124) only needs to `Register("darwin", …)`; both surfaces then show its state with no further change. If A2's `Status` populates `Linger` as nil (per the plan: "as A1, minus lingering"), macOS reads `on (login)`.

## Open Questions

- None blocking. A system-card toggle could be revisited after A5 if users ask for it (it would need a POST route, a palette action, and a confirm step).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | A3 open decision: status line only — no settings-registry entry, no UI toggle | User delegated the decision to intake; registry is config.yaml prefs not OS service-manager state (second source of truth), HOST HEALTH is read-only by contract, plan defaults to deliberate CLI opt-in | S:70 R:70 A:75 D:60 |
| 2 | Certain | Both surfaces read A1's `autostart.Backend.Status` via `autostart.For(goos)`; no re-derivation of systemd state | Explicit in the user's brief; A1's package exposes exactly this platform-neutral surface | S:95 R:85 A:95 D:95 |
| 3 | Confident | One shared `Status.Summary()` in `internal/daemon/autostart` with the five exact strings in the mapping table; CLI status text switches to it | Plan gives the three headline strings verbatim; a single formatter prevents CLI/doctor/UI drift; `on (login)` for nil-linger keeps macOS correct without platform checks | S:75 R:85 A:80 D:70 |
| 4 | Certain | Doctor row is always OK-shaped (never flips the verdict); errors degrade to an `unavailable — <err>` note | Off is the default and a state, not a dependency failure — the established cron-ticker/gui/code-server posture in doctor.go | S:85 R:90 A:90 D:85 |
| 5 | Confident | Doctor row named `daemon autostart`, placed after `cron ticker`; remediation rides `"; "`-joined Note fragments | Lowercase row names are the doctor convention; Hint only renders on FAIL rows (locale-row precedent) | S:65 R:90 A:80 D:70 |
| 6 | Confident | UI data via new `GET /api/daemon/autostart` fetched on SystemCard mount, not via SSE version slot or `/api/health` | Version slot is boot-constant and cached; health is a liveness probe that must stay cheap; autostart changes at runtime | S:60 R:80 A:80 D:65 |
| 7 | Confident | Unavailable/unsupported is a 200 with `supported:false`; fetch failure (older daemon 404) hides the row | Graceful-degrade posture of the system card's version fields; the UI must render the unsupported state on platforms without a backend | S:60 R:85 A:75 D:70 |
| 8 | Confident | The autostart row sits on the existing HexoKit system card (the daemon-status surface), between the daemon line and service rows; `off` shows the `rk daemon autostart on` hint | System card is the UI's daemon-status surface per memory; education micro-copy convention | S:75 R:85 A:80 D:70 |
| 9 | Certain | No palette action, no new page, no desktop-shell change | Read-only row adds no control (Principle V binds controls); Principle IV forbids new pages | S:90 R:90 A:90 D:90 |
| 10 | Confident | PR evidence: `just demo daemon-autostart-row --before` (web lane, desktop + mobile) with `/api/daemon/autostart` stubbed via `page.route`; e2e stubbed too | Lane brief L2 table (UI-visible ⇒ web demo); stubbing keeps the rig away from this machine's service manager and deterministic | S:80 R:85 A:80 D:75 |
| 11 | Certain | Nothing calls On/Off, systemctl enable, or loginctl enable-linger; all tests use seams | Plan rule 3 and the user's explicit "never enable autostart or lingering on this machine" | S:95 R:95 A:95 D:95 |

11 assumptions (4 certain, 7 confident, 0 tentative, 0 unresolved).
