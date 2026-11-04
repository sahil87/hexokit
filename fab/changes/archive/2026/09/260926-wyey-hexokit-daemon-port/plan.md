# Plan: HexoKit Daemon Port

**Change**: 260926-wyey-hexokit-daemon-port
**Intake**: `intake.md`

## Requirements

### Port policy: the default moves

#### R1: Daemon default is 6123
`app/backend/internal/portpolicy/ports.env` SHALL set `PORTPOLICY_DAEMON_DEFAULT=6123`, with
`PORTPOLICY_DAEMON_LEGACY=3000` unchanged. The +1/+2 convention holds (6124 dev backend, 6125
code-server default). Tunnel (3100–3199), rig (21000–21299), and sentinel (21999) values MUST NOT
change. The file's comments SHALL describe the present state (no "once it moves" future tense).

- **GIVEN** a fresh install (no legacy or new config/state home, no `RK_PORT`, no config `port`)
- **WHEN** `config.Load()` resolves
- **THEN** `Port == 6123` and `ResolvedCodeServerPort() == 6125`
- **AND** `rk ports --json` reports `default_port` 6123, `default_dev_backend_port` 6124,
  `default_code_server_port` 6125

#### R2: Code-server override semantics unchanged
An explicit valid `RK_CODE_SERVER_PORT` SHALL still mean externally managed; otherwise code-server
defaults to the *effective* daemon port + 2.

- **GIVEN** `RK_PORT=3000` (or a config pin of 3000)
- **WHEN** config resolves
- **THEN** the code-server port is 3002, not 6125

### Existing installs: pinned, nudged

#### R3: Existing installs keep 3000
The C4 pin paths SHALL keep existing installs on 3000 with the new default in force: the migration
writes `port: 3000` (DaemonLegacy, never DaemonDefault) + `settings.PortPinComment`; an unmigrated
existing install resolves 3000 via the virtual pin; `RK_CONFIG_DIR` override suppresses the virtual
pin and resolves 6123. Tests SHALL exercise these against the real embedded policy values (not only
injected constants).

- **GIVEN** a legacy `~/.config/run-kit/` home and no `~/.config/hexokit/`
- **WHEN** `config.Load()` resolves before migration
- **THEN** `Port == 3000`
- **AND** after `homemigrate` runs, the new config.yaml ends with the pin comment + `port: 3000`

#### R4: Doctor nudges pinned-at-3000 installs
`rk doctor` SHALL show the OK-shaped `port pin` row (C4's `portPinCheck`) when config.yaml `port`
is 3000, the default is 6123, and `RK_PORT` is not overriding; its Note names :6123 and rule P's
move steps (config edit, `rk daemon restart`, Tailscale Serve, bookmarks/phone shortcuts, MCP
clients at `:6123/mcp`). No row for unpinned, moved (6123 / other), or RK_PORT-overridden installs.
The verdict is never affected.

- **GIVEN** config.yaml `port: 3000`, real policy values, `RK_PORT` unset
- **WHEN** the doctor report is built
- **THEN** a `port pin` row exists, `OK: true`, Note contains `:6123` and `rk daemon restart`
- **AND** with `RK_PORT=3000` set, or `port: 6123`, no such row

### Present-tense surfaces state 6123

#### R5: CLI help and embedded skill text
`serve` help (`cmd/rk/serve.go`), `rk url` help/doc comment (`cmd/rk/url.go`), and the embedded
`cmd/rk/skill/skill.md` SHALL state the default as 6123 — derived from `portpolicy.DaemonDefault`
in Go strings where practical (no second literal). `rk url` itself stays config-derived. Go comments
naming "127.0.0.1:3000 default" (`cmd/rk/origin.go`, `notify.go`, `tab_wake.go`,
`internal/remote/ssh.go`) SHALL say 6123 (or "the portpolicy default").

- **GIVEN** the built binary
- **WHEN** `rk serve --help` / `rk url --help` run
- **THEN** they say 6123, never "default 3000"

#### R6: Docs
README.md, `docs/site/install.md`, `docs/site/skill.md`, `docs/specs/architecture.md`,
`docs/specs/api.md`, `docs/specs/project-plan.md` (present-tense lines only) SHALL state 6123 for the
daemon default URL/port, Tailscale Serve/Funnel examples, and MCP endpoint/allowed-origin examples.
install.md SHALL add one short note that installs from before the rename stay on their pinned port
(`rk doctor` shows how to move). README's stale `~/.config/run-kit/config.yaml` path → `~/.config/hexokit/config.yaml`.
The "precedence: default 3000 < …" phrasing becomes "default 6123 < …". Example "move" values
(`port: 4000`) may stay.

- **GIVEN** the docs
- **WHEN** grepping present-tense default statements
- **THEN** none say 3000 is the default

#### R7: Dev tooling follows the default
`justfile` recipes/comments, `app/frontend/vite.config.ts` fallbacks, `scripts/perf-idle-cpu.{sh,mjs}`
`DEFAULT_URL`, and comments in `scripts/gui-perf-link.sh`, `scripts/e2e-env.sh`,
`scripts/dev-desktop.sh`, `app/desktop/src/main.ts` SHALL use 6123 (6124 backend). The justfile SHOULD
read the default from `ports.env` rather than carry a second literal; vite.config SHALL compute the
backend target once (one constant) instead of seven repeated expressions.

- **GIVEN** `RK_PORT` unset
- **WHEN** `just dev` starts
- **THEN** Vite listens on 6123 and proxies to the Go backend on 6124

#### R8: UI host-URL examples
Placeholders/examples that illustrate an rk daemon/host URL SHALL show 6123:
`host-form-dialog.tsx` `INVALID_HOST_URL_MESSAGE`, desktop `hosts.ts:70`, `welcome/welcome.ts:343,805`,
`welcome/welcome.html:363`; matching unit-test assertions updated. Web-tile examples of a user's own
dev server (`iframe-window.tsx` `localhost:3000`, `rk present :3000`, tutorial "present
localhost:3000") and all millisecond `3000` literals SHALL stay.

- **GIVEN** the Add-host dialog with an invalid URL
- **WHEN** the error renders
- **THEN** it reads `e.g. http://host:6123`

### Release + plan bookkeeping

#### R9: Release notes and plan doc
The plan doc `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` SHALL: mark C4 merged 2026-09-26
(`65407dc2`, [run-kit#1053](https://github.com/sahil87/run-kit/pull/1053)); mark C5 in progress on
`260926-wyey-hexokit-daemon-port`; update Status + "Where we are" (homes done; port default in
progress); strike C4 in the Order line; add a "Release notes draft (C5 — paste at R1)" block with the
intake §4 text. The PR body (ship) SHALL carry the same Upgrade notes.

- **GIVEN** the plan doc after apply
- **WHEN** read
- **THEN** the C4 row links #1053 and says merged; a release-notes draft exists for R1

### Non-Goals

- Renaming `RK_PORT`/`RK_HOST`/`RK_CODE_SERVER_PORT` — substrate (D2)
- Moving the remote tunnel range — C4 deferred it
- Moving existing users — they move on their own schedule (rule P)
- Rewriting history: `fab/changes/archive`, `docs/wiki/*`, `docs/findings/*`, memory narrative (D11)
- Churning test fixtures that use 3000 as an arbitrary sample port

### Design Decisions

#### Flip the constant, not the mechanism
**Decision**: C5 changes only `PORTPOLICY_DAEMON_DEFAULT`; the pin, virtual pin, and doctor row are C4's and wake automatically.
**Why**: C4 designed the legacy/default split so the flip is one line; everything derives from `portpolicy`.
**Rejected**: A new C5-specific migration or doctor check — duplicates C4's shipped seams.
*Introduced by*: 260926-wyey-hexokit-daemon-port

## Tasks

### Phase 1: Core

- [x] T001 Set `PORTPOLICY_DAEMON_DEFAULT=6123` in `app/backend/internal/portpolicy/ports.env`, rewrite its comments present-tense; update `internal/portpolicy/portpolicy_test.go` to assert DaemonDefault 6123 / DaemonLegacy 3000 and DaemonDefault != DaemonLegacy <!-- R1 -->
- [x] T002 Run `env -u TMUX -u TMUX_PANE go test ./...` in app/backend (after `just _ensure-tmux-conf`); fix tests that assumed the default was 3000 (`cmd/rk/ports_test.go`, `cmd/rk/serve_warn_test.go` "default port stays silent", `cmd/rk/origin_test.go` default-fallback rows, `internal/config/config_test.go`, `internal/settings/registry_test.go` port def, doctor "(default)" label cases) — derive from `portpolicy.DaemonDefault` where the test is about the default; leave sample-port fixtures <!-- R1 -->
- [x] T003 Add/extend tests with the real policy values: config fresh install → 6123/6125; RK_PORT=3000 → code-server 3002; unmigrated legacy home → 3000 virtual pin; RK_CONFIG_DIR override → 6123; homemigrate writes `port: 3000` (DaemonLegacy) while DaemonDefault is 6123; doctor report `port pin` row present for `port: 3000` and absent for 6123 / RK_PORT override (in `internal/config/config_test.go`, `internal/homemigrate/homemigrate_test.go`, `cmd/rk/doctor_test.go`) <!-- R2 R3 R4 -->

### Phase 2: Surfaces

- [x] T004 `cmd/rk/serve.go` help and `cmd/rk/url.go` Long/doc comment: state the default from `portpolicy.DaemonDefault` (fmt.Sprintf), not a literal; `cmd/rk/skill/skill.md` → 6123; comments in `cmd/rk/origin.go`, `cmd/rk/notify.go`, `cmd/rk/tab_wake.go`, `internal/remote/ssh.go` → 6123 <!-- R5 -->
- [x] T005 [P] Docs: README.md, docs/site/install.md (+ pinned-install note), docs/site/skill.md, docs/specs/architecture.md, docs/specs/api.md, docs/specs/project-plan.md — present-tense defaults, Tailscale Serve/Funnel examples, MCP endpoint examples → 6123; README config path → `~/.config/hexokit/config.yaml` <!-- R6 -->
- [x] T006 [P] Dev tooling: `justfile` (source ports.env or `${RK_PORT:-6123}` with pointer comment; comments 6123/6124), `app/frontend/vite.config.ts` (one computed backend-target constant, default 6123), `scripts/perf-idle-cpu.sh`, `scripts/perf-idle-cpu.mjs`, comments in `scripts/gui-perf-link.sh`, `scripts/e2e-env.sh`, `scripts/dev-desktop.sh`, `app/desktop/src/main.ts` <!-- R7 -->
- [x] T007 [P] UI examples: `app/frontend/src/components/host-form-dialog.tsx`, `app/desktop/src/hosts.ts`, `app/desktop/src/welcome/welcome.ts`, `app/desktop/src/welcome/welcome.html` → 6123; update matching tests (`host-form-dialog.test.tsx`, `app/desktop/src/hosts.test.ts`, any welcome test); leave iframe-window/tutorial dev-server examples and ms timeouts <!-- R8 -->

### Phase 3: Bookkeeping + gates

- [x] T008 Plan doc `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`: C4 row merged (#1053, `65407dc2`, nudge "wakes with C5"), C5 row in progress, Status + Where-we-are, Order strikes C4, add "Release notes draft (C5 — paste at R1)" block <!-- R9 -->
- [x] T009 Gates: full Go suite (`env -u TMUX -u TMUX_PANE go test ./...`), `go vet ./...`, `cd app/frontend && npx tsc --noEmit`, `just test-frontend`, desktop unit tests (`cd app/desktop && pnpm test` or the repo's recipe) for touched files; final grep of non-test source/docs for `\b3000\b` stating the daemon default — none left <!-- R1 R5 R6 R7 R8 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `ports.env` has DAEMON_DEFAULT=6123, DAEMON_LEGACY=3000; tunnel/rig/sentinel unchanged; comments present-tense
- [x] A-002 R1: `rk ports` / config resolve 6123/6124/6125 for a fresh install (test-covered)
- [x] A-003 R5: `serve` and `url` help derive the default from `portpolicy.DaemonDefault`; skill.md says 6123
- [x] A-004 R6: README, install.md, skill.md, architecture.md, api.md, project-plan.md present-tense defaults say 6123; install.md has the pinned-install note; README config path is hexokit
- [x] A-005 R7: justfile, vite.config, perf scripts default to 6123/6124; vite.config computes the backend target once
- [x] A-006 R8: host-URL placeholders show 6123; dev-server examples and ms timeouts untouched
- [x] A-007 R9: plan doc C4 merged + #1053, C5 in progress, Status/Order updated, release-notes draft present

### Behavioral Correctness

- [x] A-008 R2: effective port + 2 drives code-server default (3000 pin → 3002; fresh → 6125); explicit RK_CODE_SERVER_PORT still externally managed
- [x] A-009 R3: migration pin writes DaemonLegacy (3000), never DaemonDefault, with real policy values

### Scenario Coverage

- [x] A-010 R3: tests cover fresh → 6123, unmigrated legacy → 3000 virtual pin, RK_CONFIG_DIR override → 6123
- [x] A-011 R4: tests cover doctor `port pin` row present at `port: 3000`, absent at 6123 and under RK_PORT override, verdict unaffected

### Edge Cases & Error Handling

- [x] A-012 R4: nudge Note names :6123, config path, `rk daemon restart`, Tailscale Serve, bookmarks/phone shortcuts, MCP `:6123/mcp`

### Code Quality

- [x] A-013 Pattern consistency: new code follows naming and structural patterns of surrounding code
- [x] A-014 No unnecessary duplication: the default is derived from `portpolicy` (Go) / `ports.env` where practical, not re-hardcoded
- [x] A-015 No magic numbers: no new bare 6123 literal in Go source outside `ports.env` and tests
- [x] A-016 Comments state constraints, no change-ID/PR citations or narration
- [x] A-017 Tests cover the changed behavior; sample-port fixtures not churned

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — the flip retires no live code path; the one piece of dead weight the change touched (the C4 simulated-flip `portpolicy.DaemonDefault` var-swap harness in `internal/config/config_test.go`) was already replaced in place by the real-values tests

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Help strings derive from `portpolicy.DaemonDefault` via fmt.Sprintf at package init | portpolicy is an imported package, so its init runs first; avoids a second literal | S:70 R:90 A:85 D:75 |
| 2 | Confident | README's `~/.config/run-kit/config.yaml` is a C4 miss and is fixed here | Same line is being edited; present-truth path is hexokit | S:70 R:95 A:85 D:85 |
| 3 | Confident | Tutorial "present localhost:3000" stays — it illustrates a user dev server | Intake §3 judgment rule | S:70 R:95 A:80 D:80 |
| 4 | Confident | Settings registry `port` def already derives from `portpolicy.DaemonDefault` — no code change there, only its test | Code survey (settings.go port descriptor) | S:85 R:90 A:90 D:90 |

4 assumptions (0 certain, 4 confident, 0 tentative).
