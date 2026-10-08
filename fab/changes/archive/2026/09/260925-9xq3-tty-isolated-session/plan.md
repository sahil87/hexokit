# Plan: Isolated Terminal Sessions

**Change**: 260925-9xq3-tty-isolated-session
**Intake**: `intake.md`

## Requirements

### tmux: Iso-Session Identity

#### R1: Iso-session naming
`internal/tmux` SHALL define `IsoSessionPrefix = "_rk-iso-"` beside `PinSessionPrefix` and expose `IsoSessionName(windowID) (string, bool)` (`@42` → `_rk-iso-42`; `("", false)` for an invalid window id, using the same validity rule as `PinSessionName`) and its inverse `WindowIDFromIsoSession(name) (string, bool)`.

- **GIVEN** window id `@42`
- **WHEN** `IsoSessionName("@42")` is called
- **THEN** it returns `("_rk-iso-42", true)` and `WindowIDFromIsoSession("_rk-iso-42")` returns `("@42", true)`
- **AND** `IsoSessionName("42")`, `IsoSessionName("@x")`, `WindowIDFromIsoSession("_rk-pin-42")` return `false`

#### R2: Iso role in the reserved taxonomy
`SessionRole` SHALL classify a name starting with `IsoSessionPrefix` as a new `SessionRoleIso = "iso"`, checked before the `ReservedSessionPrefix` catch-all.

- **GIVEN** session `_rk-iso-5`
- **WHEN** `SessionRole` classifies it
- **THEN** the result is `"iso"` (not `"reserved"`, not `"user"`)

### tmux: Ensure

#### R3: EnsureIsoSession creates a single-window linked session
`EnsureIsoSession(ctx, server, windowID) (string, error)` SHALL validate the window id before any tmux call, and when `_rk-iso-<digits>` does not exist create it following Pin's creation shape (`new-session -d -s <iso> -c ServerBirthDir()`, capture the placeholder window id via `list-windows`, `link-window` the target in, `kill-window` the placeholder). The window SHALL remain a member of its home session (link, not move). It MUST NOT set `destroy-unattached` (setting it on a never-attached session destroys the session immediately on tmux 3.7c). All tmux calls go through `internal/tmux` exec helpers with `exec.CommandContext` + timeout.

- **GIVEN** home session `S` with windows `@A`, `@B`
- **WHEN** `EnsureIsoSession(ctx, srv, "@B")` runs
- **THEN** session `_rk-iso-<B>` exists with exactly one window, `@B`
- **AND** `@B` is still listed in `S`

#### R4: EnsureIsoSession is idempotent and race-tolerant
When the iso session already exists, `EnsureIsoSession` SHALL return its name without modifying it (a second isolated viewer shares it). A `duplicate session` failure from `new-session` (a concurrent ensure won the race) SHALL be treated as success after re-probing that the session exists.

- **GIVEN** `_rk-iso-<B>` already exists
- **WHEN** `EnsureIsoSession` runs again
- **THEN** it returns the same name, no error, and the session still has exactly one window

#### R5: EnsureIsoSession rolls back on link failure
If the link (or placeholder capture) fails, `EnsureIsoSession` SHALL kill the just-created iso session with a `context.Background()`-rooted kill (Pin's rollback pattern) and return an error; a placeholder `kill-window` failure is non-fatal (warn log).

- **GIVEN** a window id that does not exist on the server
- **WHEN** `EnsureIsoSession` runs
- **THEN** it returns an error and no `_rk-iso-*` session remains

### tmux: Hidden-Session Filtering

#### R6: Iso sessions are hidden wherever pin sessions are
Every site that treats `_rk-pin-*` as a non-user-facing link target SHALL treat `_rk-iso-*` the same way, via one shared predicate (e.g. `isHiddenLinkSession(name)` = pin ∨ iso) rather than duplicated prefix checks. At minimum: the `parseSessions` chokepoint (`tmux.go`), `isLayoutHiddenSession` (`layout.go`) and the layout window/pane listers that key a window to its non-pin owning session, `ResolveWindowSession`/`resolveHomeSession` (home = non-pin, non-iso), and the other `list-windows -a` consumers found by auditing every `PinSessionPrefix` reference (`webtabs.go`, `parseActiveWindowsByGroup`, `legacy_options.go`, `cmd/rk/mux_panes.go`, `internal/tmuxctl` active-window derivation, cron/operator window derivations). A site where pin-skipping does not apply (e.g. `ListPinSessionNames`, `Unpin` recovery) keeps pin-only semantics.

- **GIVEN** window `@B` linked into both home `S` and `_rk-iso-<B>`
- **WHEN** sessions are listed via `ListSessions`, layout snapshots captured, or `ResolveWindowSession(@B)` called
- **THEN** no `_rk-iso-*` session appears in the session list or snapshot, `@B` is attributed once to `S`, and `ResolveWindowSession` returns `S`

### Relay: Opt-In Isolation

#### R7: `open` op carries an optional `isolate` flag
The `/ws/terminals` `open` op SHALL accept `"isolate": true` (`openOp.Isolate bool json:"isolate,omitempty"`); an absent field decodes as `false`, and a non-isolated open SHALL behave exactly as today (same session pick, same attach argv).

- **GIVEN** `{"op":"open","id":7,"windowId":"@42","cols":120,"rows":32}` (no `isolate`)
- **WHEN** the relay attaches
- **THEN** it resolves the home session (or pin) and runs `attach-session -t <session>` with no chained command

#### R8: Session pick order pin → iso → home
`attachStream` SHALL pick: (1) the pin session when it exists (regardless of `isolate`; no iso session is created); else (2) when `op.Isolate`, `EnsureIsoSession` and attach it; else (3) `ResolveWindowSession` (home). An ensure failure SHALL emit a per-stream `closed` (4004 when the window is missing, 4001 otherwise), never close the socket. `SelectWindowInSession` still runs for every pick.

- **GIVEN** pinned window `@P` and an `open` with `isolate: true`
- **WHEN** the relay attaches
- **THEN** it attaches `_rk-pin-<P>` and no `_rk-iso-<P>` session is created
- **GIVEN** unpinned `@B` and `isolate: true`
- **THEN** it attaches `_rk-iso-<B>`

#### R9: The iso attach sets `destroy-unattached` itself
For an iso attach the argv SHALL chain the lifecycle option in the same tmux invocation — `attach-session -t <iso> ; set-option -t <iso> destroy-unattached on` as separate argv elements (the `";"` is its own element; no shell string). Non-iso attach argv is unchanged. The target form used for `set-option` MUST be one tmux accepts (verified by test; the bare/`name:` form, since `set-option -t =name` was rejected in the probe).

- **GIVEN** an isolated stream attached to `_rk-iso-<B>`
- **WHEN** `show-options -t <iso> -v destroy-unattached` runs
- **THEN** it prints `on`
- **AND** when the stream's attach client dies (stream close, socket teardown, or SIGKILL) and it was the last client, the iso session is gone and `@B` is still in home

#### R10: Attach-failure rollback never kills a shared session
If the PTY attach fails after a successful ensure, the relay SHALL kill the iso session only when it has no attached clients (another isolated viewer may share it), then emit the per-stream 4001.

- **GIVEN** an iso session with zero clients after a failed attach
- **WHEN** the rollback runs
- **THEN** the iso session is killed
- **GIVEN** an iso session that another stream is attached to
- **THEN** it is left alone

### Relay: Isolation Semantics

#### R11: Isolated streams on sibling windows keep their windows
Two isolated streams on sibling windows of one session SHALL each keep rendering their own window, and neither open SHALL move the home session's active window.

- **GIVEN** session `S` with `@A` (active) and `@B`
- **WHEN** isolated streams open `@A` and `@B`, and then home selects `@B`
- **THEN** `_rk-iso-<A>`'s active window is still `@A` and `_rk-iso-<B>`'s is `@B`
- **AND** the isolated opens did not change `S`'s active window

### Docs

#### R12: Spec and memory reflect iso sessions
`docs/specs/api.md` § `/ws/terminals` SHALL document the `isolate` field and pick order at apply; hydrate SHALL update memory (tmux-sessions, api-and-sockets, architecture/tmux-runner, layout-snapshots, agent-messaging).

- **GIVEN** the change is hydrated
- **WHEN** a reader looks up the relay pick order or `_rk-*` roles
- **THEN** `_rk-iso-*` and `isolate` are documented with the lifecycle and the two accepted caveats (home killed while isolated; crash-window leak)

### Non-Goals

- Frontend sending `isolate` (change 4 wires `relay-mux.ts`; change 5 popouts)
- Isolating every stream — user decision: opt-in only
- A sweep for client-less `_rk-iso-*` sessions left by a crash between ensure and attach
- Cascading rk's session kill to iso sessions

### Design Decisions

#### Opt-in isolation, not every stream
**Decision**: Only an `open` with `isolate: true` attaches a `_rk-iso-*` session; home-tab streams attach the home session.
**Why**: Home-tab streams depend on sharing home's active-window pointer — the same-session window ride keeps the stream mounted while the PTY follows home's active window, and the URL follows tmux's active window.
**Rejected**: Isolating every stream — fixes the two-tabs-yank tradeoff but turns every window switch into close+reopen, breaks the URL-follows-tmux model, needs frontend work, and costs one session per viewed window.
*Introduced by*: 260925-9xq3-tty-isolated-session

#### destroy-unattached set by the attach, not at creation
**Decision**: The iso attach argv chains `; set-option -t <iso> destroy-unattached on`; tmux reaps the session when its last client leaves.
**Why**: Setting the option on a never-attached session destroys it immediately (tmux 3.7c probe); chaining it on the attach makes reaping tmux-side, covering stream close, socket teardown and daemon crash with no rk bookkeeping.
**Rejected**: An explicit reap on stream close — misses daemon crashes and needs reference counting across shared viewers.
*Introduced by*: 260925-9xq3-tty-isolated-session

## Tasks

### Phase 1: Setup

- [x] T001 Add `IsoSessionPrefix`, `IsoSessionName`, `WindowIDFromIsoSession` beside the pin helpers in `app/backend/internal/tmux/tmux.go`, with round-trip/invalid-id unit tests beside `TestPinSessionNameRoundTrip` in `internal/tmux/board_test.go` <!-- R1 -->
- [x] T002 Add `SessionRoleIso = "iso"` and its `SessionRole` case (before the reserved catch-all) in `app/backend/internal/tmux/session_facts.go`, with a test; update the `rk mux sessions` role help text in `cmd/rk/` if it enumerates roles <!-- R2 -->

### Phase 2: Core Implementation

- [x] T003 Implement `EnsureIsoSession(ctx, server, windowID)` in `app/backend/internal/tmux/` (new `iso.go` or beside Pin in `board.go`), reusing Pin's creation steps — extract a shared single-window link helper used by both `Pin` and `EnsureIsoSession` if it removes duplication without changing Pin's stamp-before-link ordering; idempotent reuse, duplicate-session race tolerance, Background-rooted rollback, non-fatal placeholder kill. Real-tmux tests on an isolated `-L` test server (existing board_test.go pattern) <!-- R3 R4 R5 -->
- [x] T004 Introduce a shared hidden-link-session predicate (pin ∨ iso) in `app/backend/internal/tmux/` and apply it at every audited `PinSessionPrefix` site where pin-skipping means "not a user-facing owner": `parseSessions`, `isLayoutHiddenSession` + layout window/pane listers, `ResolveWindowSession`/`resolveHomeSession`, `webtabs.go`, `parseActiveWindowsByGroup`, `legacy_options.go`, `cmd/rk/mux_panes.go`, `internal/tmuxctl`, cron/operator derivations; leave pin-specific sites (`ListPinSessionNames`, board derivation, Unpin recovery) pin-only. Tests: parse-level tests for parseSessions/layout parsers and a real-tmux `ResolveWindowSession` dual-membership test mirroring `TestResolveWindowSession_dualMembershipResolvesHome` <!-- R6 -->
- [x] T005 Relay: add `Isolate` to `openOp` in `app/backend/api/terminals_ws.go`; add `EnsureIsoSession` (and whatever the rollback needs, e.g. a client-count probe + kill) to the `TmuxOps` interface in `api/router.go`, `prodTmuxOps`, and `mockTmuxOps` in `api/sessions_test.go`; implement the pin → iso → home pick and per-stream closed codes on ensure failure <!-- R7 R8 -->
- [x] T006 Relay: build the iso attach argv with the chained `";" set-option -t <target> destroy-unattached on` (non-iso argv unchanged) — factor argv construction into a small testable function; add the attach-failure rollback that kills the iso session only when it has zero clients (client probe via `internal/tmux`, e.g. `list-clients -t`) <!-- R9 R10 -->

### Phase 3: Integration & Edge Cases

- [x] T007 Relay unit tests in `app/backend/api/terminals_ws_test.go` with `mockTmuxOps`: absent `isolate` decodes false and picks home; `isolate` on a pinned window picks pin and never calls ensure; `isolate` on an unpinned window calls ensure and attaches iso; ensure failure emits a per-stream `closed` and leaves the socket open; argv builder produces the chained form for iso and the unchanged form otherwise <!-- R7 R8 R9 -->
- [x] T008 Real-tmux integration tests on an isolated `-L` server (`env -u TMUX -u TMUX_PANE`, `rk-test-*` naming, `just _ensure-tmux-conf` first): two isolated attaches on sibling windows of one session each keep their window and do not move home's active window; the chained attach sets `destroy-unattached on`; killing the last attach client reaps `_rk-iso-N` while the window stays in home; a second client keeps the session alive when the first dies; rollback leaves a shared session alone. Place where the attach can be driven through a PTY (api package using `prodTmuxOps`, or `internal/tmux` driving `attach-session` via `creack/pty`) <!-- R9 R10 R11 -->

### Phase 4: Polish

- [x] T009 Update `docs/specs/api.md` § `/ws/terminals` (~399–425): `open` op `isolate` field (optional, default false) and pick order pin → iso (when requested) → home, with the `destroy-unattached` lifecycle in one sentence; update the `terminals_ws.go` header comment's protocol/pick description to match <!-- R12 -->

## Execution Order

- T001 blocks T003, T004 (T003/T004 use the prefix/name helpers)
- T003 blocks T005, T006
- T005 blocks T006, T007; T006 blocks T008

## Acceptance

### Functional Completeness

- [x] A-001 R1: `IsoSessionName`/`WindowIDFromIsoSession` exist beside the pin helpers, round-trip valid ids, and reject invalid ids and pin names
- [x] A-002 R2: `SessionRole("_rk-iso-5") == "iso"`, and `rk mux sessions` reports `iso` for iso sessions
- [x] A-003 R3: `EnsureIsoSession` creates `_rk-iso-<digits>` with exactly the target window, the window remains in home, and `destroy-unattached` is not set at creation
- [x] A-004 R4: A repeat `EnsureIsoSession` returns the same name without error or modification; a duplicate-session race is treated as success
- [x] A-005 R5: A link failure leaves no `_rk-iso-*` session behind (Background-rooted rollback)
- [x] A-006 R6: Iso sessions are excluded from `ListSessions`, layout snapshots, `rk mux panes`, the tmuxctl active-window derivation and every other audited `list-windows -a` consumer, through one shared predicate; `ResolveWindowSession` returns home for a window linked into iso
- [x] A-007 R7: `openOp.Isolate` exists with `json:"isolate,omitempty"`; an absent field is `false` and the non-isolated attach path is byte-for-byte unchanged
- [x] A-008 R8: Pick order is pin → iso (when requested) → home; a pinned window never gets an iso session; ensure failure yields a per-stream `closed` without closing the socket
- [x] A-009 R9: The iso attach argv is `attach-session -t <iso> ";" set-option -t <iso> destroy-unattached on` as argv elements, and tmux accepts the target form (verified by test)
- [x] A-010 R10: After a failed attach the iso session is killed only when it has zero clients
- [x] A-011 R12: `docs/specs/api.md` § `/ws/terminals` documents `isolate` and the pick order

### Scenario Coverage

- [x] A-012 R11: A real-tmux test proves two isolated attaches on sibling windows of one session each keep their window, and home's active window is not moved by the opens
- [x] A-013 R9: A real-tmux test proves the last attach client's death reaps the iso session while the window stays in home, and that a remaining client keeps the session alive

### Edge Cases & Error Handling

- [x] A-014 R8: A missing window with `isolate: true` produces `closed` 4004 and no leaked iso session
- [x] A-015 R10: A shared iso session is not killed by another stream's attach-failure rollback

### Code Quality

- [x] A-016 Pattern consistency: New code follows `internal/tmux` naming and structure (pin helpers, exec helpers, `ExactSessionTarget`) and the relay's existing error/close-code style
- [x] A-017 No unnecessary duplication: Pin and iso creation share code where their steps coincide; the pin ∨ iso check lives in one predicate
- [x] A-018: All tmux interaction goes through `internal/tmux` with `exec.CommandContext` and timeouts; no shell strings (the `";"` separator is an argv element)
- [x] A-019: Validated window id before any tmux subprocess (Constitution I)
- [x] A-020: No database/cache state introduced; lifecycle is tmux-derived (Constitution II/VI); no tmux session leaks on disconnect (code-review.md must-fix rule)
- [x] A-021: Go tests pass under `env -u TMUX -u TMUX_PANE go test ./...` and follow the isolated `-L` test-socket pattern; no god functions (>50 lines without reason) added to `attachStream`
- [x] A-022: Comments state constraints (why the option is chained on attach, why rollback checks clients), never narration or change IDs

### Security

- [x] A-023 R7: The `isolate` flag introduces no new unvalidated input into tmux argv — the iso name is derived only from the validated window id

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant. The one replaced block (the inline attach-argv construction in `attachStream`) was factored into `attachArgv` in the same edit, leaving no dead code.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `EnsureIsoSession` and the rollback's client probe are added to the api `TmuxOps` interface (prod + mock) rather than called as package funcs from the relay | The relay already reaches tmux via `tc.s.tmux` (HasSession, ResolveWindowSession, SelectWindowInSession); keeps relay unit tests mockable | S:70 R:85 A:85 D:75 |
| 2 | Confident | The two-sibling-windows and reap tests run against real tmux on an isolated `-L` server; relay decision logic is covered separately with `mockTmuxOps` | Existing relay tests are mock-based; real-tmux behavior (active-window independence, destroy-unattached) cannot be mocked meaningfully | S:70 R:90 A:80 D:70 |
| 3 | Confident | Extract a shared single-window-link helper only if it keeps Pin's stamp-before-link ordering intact | Pin stamps options between create and link; forcing a shared helper that breaks that ordering would regress Pin | S:65 R:85 A:75 D:65 |
| 4 | Tentative | `set-option` target uses the bare session name (or `name:`) rather than `ExactSessionTarget`'s `=name` form | The probe saw `set -t =name` rejected on tmux 3.7c; apply verifies by test and may switch forms | S:50 R:85 A:55 D:50 |
| 5 | Certain | T001 and T002 are both in `session_facts.go`/`tmux.go` and may be implemented in one edit | Trivial; separated only for R1/R2 traceability | S:90 R:95 A:95 D:90 |

5 assumptions (1 certain, 3 confident, 1 tentative).
