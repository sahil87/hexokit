# Intake: Isolated Terminal Sessions

**Change**: 260925-9xq3-tty-isolated-session
**Created**: 2026-09-25

## Origin

> The terminal relay can attach a window through its own single-window tmux session, so a terminal shown outside its home tab (borrowed into another tab, or popped out) never fights the home session's current window. The session is created on demand and reaped when its last client leaves.

Invoked via `/fab-new` with the instruction to treat **Change 3 — isolated terminal sessions** of `fab/plans/sahil/26-09-24-surface-drag-and-popout.md`, plus that plan's **Standing context** and **Decisions of record**, as authoritative intake input. The plan came out of the 2026-09-24/25 `/fab-discuss` sessions (drag-to-snap, N-tile layout tree, tiles from other tabs, popout). Changes 1 (layout tree, #1035) and 2 (drag to snap, #1036) are already on main. This change is **backend-only** and file-disjoint from 1–2. Changes 4 (tiles from other tabs) and 5 (popout) consume it: they send `isolate: true` on the relay `open` op of a borrowed or popped-out tty tile.

Interaction was one-shot plus one question. The plan left two decisions to intake. Both were settled here:

1. **Should every tty stream isolate?** (plan item 4 / open question 1) — **Asked; the user chose opt-in only** (`isolate: true`). Rationale shown to the user: always-isolate breaks the same-session window "ride" (`ui/terminal.md` § `setWindowId`, where a same-session window switch keeps the stream mounted and the live PTY follows home's active window without a wire op) and the "tmux is truth for current window" URL model, forces frontend work, and adds one session per viewed window. The documented two-browser-tabs-yank tradeoff therefore stays.
2. **Lifecycle: `destroy-unattached` vs. explicit reap** (plan item 3) — **decided by probe**, on a private `-S` socket with tmux 3.7c on 2026-09-25 (results under What Changes § Lifecycle).

## Why

A home session has **one** active-window pointer shared by every client attached to it. The relay attaches each stream directly to the window's home session (`attach-session -t <home>` after a session-scoped `select-window`). So two streams showing *different* windows of the same session fight: whichever selects last wins, and the other stream's PTY jumps to the wrong window. Today that is an accepted tradeoff (`docs/memory/run-kit/tmux-sessions.md` § Terminal Relay → Accepted behavioural tradeoffs), because in a single tab only one window of a session renders at a time.

Changes 4 and 5 break that assumption:

- **Borrowed tiles** (change 4): tab B shows tab A's terminal (`@A/tty`) while B's own terminal and other tabs of the same session may also be live. If A and B are windows of one session, rendering both would thrash the home pointer on every attach and reopen.
- **Popouts** (change 5): a popped-out terminal lives in its own browser window and must keep its window while the opener navigates to a sibling tab.

Without isolation, those features cannot keep a stable terminal. They would also move the home session's active window under the user, which the SPA reads as navigation, because the URL follows tmux's active window.

**Why this approach**: the pin-session mechanism already solves exactly this for board panes. A single-window `_rk-pin-*` session is created with `link-window` (not move), the window stays in its home session, and the pin session's sole window is permanently active. So attaching there never touches home's pointer. The plan's decision of record ("Isolation mechanism verified", 2026-09-24) confirmed on a throwaway server that after `link-window`, `select-window` on home does not move the linked session's window, and that `kill-session` on the linked session leaves the window alive in home. Reusing this shape adds a second hidden-session kind rather than a new mechanism.

**Rejected**: tmux `join-pane` for cross-tab moves (kills a single-pane home window, changes the plain-tmux view, needs a stored home — plan decisions); isolating every stream (above); a per-WebSocket ephemeral grouped session (removed in 260602-qn62 — group sessions still share nothing useful here and multiply sessions per socket).

## What Changes

### 1. `internal/tmux`: iso-session naming, ensure, taxonomy, filters

New constants and helpers in `internal/tmux/tmux.go`, beside `PinSessionPrefix` / `PinSessionName` / `WindowIDFromPinSession` (~line 463–510):

```go
// IsoSessionPrefix is the reserved prefix for run-kit's single-window isolated
// relay sessions: `_rk-iso-<windowDigits>` (the window's @N with `@` stripped).
IsoSessionPrefix = "_rk-iso-"

func IsoSessionName(windowID string) (string, bool)          // "@42" → "_rk-iso-42"; ("", false) on invalid id
func WindowIDFromIsoSession(name string) (string, bool)      // inverse
```

`EnsureIsoSession(ctx, server, windowID) (string, error)` follows the `Pin` creation shape in `internal/tmux/board.go` (~line 273–405), minus the board stamps:

1. Validate the window id (`ValidWindowID`) and derive the name.
2. **Idempotent**: when `has-session -t =<iso>` succeeds, return the name (reuse; a second isolated viewer of the same window shares the session).
3. `new-session -d -s <iso> -c ServerBirthDir()` (the same session_path hygiene as pin).
   - A `duplicate session` error from a concurrent ensure counts as success, followed by re-probing existence.
4. Capture the placeholder window id (`list-windows -t =<iso> -F '#{window_id}'`), never assume index 0.
5. `LinkWindowToSession(windowID, iso, server)`. On failure, kill the iso session (rooted in `context.Background()`, as in Pin's rollback) and return the error.
6. `kill-window -t <placeholder>`. Failure is non-fatal: log a warning, as Pin does.

It does **not** set `destroy-unattached` at creation (see § Lifecycle — doing so destroys the session instantly).

**Taxonomy**: `internal/tmux/session_facts.go` gets `SessionRoleIso = "iso"`, matched on `IsoSessionPrefix` before the `ReservedSessionPrefix` catch-all. That makes `rk mux sessions` report `role: iso` instead of `reserved`.

**Hidden-session filtering**: an iso session is an rk-internal link target, exactly like a pin session. Every site that skips `PinSessionPrefix` must also skip `IsoSessionPrefix`. The preferred shape is one shared predicate (e.g. `isHiddenLinkSession(name)` = pin ∨ iso) rather than duplicated prefix checks. Known sites, which apply must audit exhaustively with `grep -rn PinSessionPrefix`:

- `parseSessions` chokepoint, `internal/tmux/tmux.go` ~1088. No iso session may appear in REST/SSE/board/server-aggregate session lists.
- `isLayoutHiddenSession`, `internal/tmux/layout.go:138`. Snapshots skip iso sessions (`ListLayoutSessions`, and the `list-windows -a` / `list-panes -a` consumers at layout.go ~190/209/229/334 that key windows to their non-pin owning session and dedupe by window id).
- `ResolveWindowSession` / `resolveHomeSession`, `tmux.go` ~2229–2300. These resolve the **home** (non-pin, non-iso) session. When the window is linked only into hidden sessions, they fall back to the reported session, as today's pin-only path does.
- The other `list-windows -a` consumers: `webtabs.go:278` `ListDeclaredWebRoots`, `parseActiveWindowsByGroup` (`tmux.go` ~1927), `legacy_options.go` window sweeps, and `cmd/rk/mux_panes.go` (internal sessions contribute no rows). Each must not double-count or mis-attribute a window that is linked into an iso session.
- The tmuxctl active-window event derivation (`internal/tmuxctl`, § Active-Window Event Derivation). An iso session's `%session-window-changed` must not feed the SESSIONS highlight.
- Cron / operator window derivations that enumerate sessions, where they bypass `parseSessions`.

### 2. Relay: `isolate` on the `open` op

`app/backend/api/terminals_ws.go`:

```go
type openOp struct {
    Op       string `json:"op"`
    ID       uint32 `json:"id"`
    Server   string `json:"server"`
    WindowID string `json:"windowId"`
    Cols     uint16 `json:"cols"`
    Rows     uint16 `json:"rows"`
    Isolate  bool   `json:"isolate,omitempty"` // new; absent ⇒ false (back-compat)
}
```

Wire example: `{"op":"open","id":7,"server":"default","windowId":"@42","cols":120,"rows":32,"isolate":true}`.

**Session pick order** in `attachStream` (currently ~line 639–664):

1. **pin**: `PinSessionName(windowID)` exists → attach it. This is unchanged, and it already isolates, so no iso session is created for a pinned window even when `isolate` is true.
2. **iso** (only when `op.Isolate`): `EnsureIsoSession(ctx, server, windowID)` → attach it. Ensure failure → per-stream `closed` 4004 when the window is missing, else 4001 attach-failed. Logged; the socket stays up.
3. **home**: `ResolveWindowSession`. Unchanged for every non-isolated stream.

`SelectWindowInSession(session, windowID, server)` still runs for all three. It is a no-op for single-window sessions, but keeps the path uniform.

**Attach argv for an iso stream** chains the lifecycle option onto the attach, as one tmux invocation (argument slice, never a shell string — Constitution I):

```
tmux [-L srv] [-f conf] attach-session -t =_rk-iso-42 ; set-option -t =_rk-iso-42 destroy-unattached on
```

In Go this is the separate args `"attach-session", "-t", target, ";", "set-option", "-t", target, "destroy-unattached", "on"`. The target form must match what the probe accepted: set-option rejected `-t =name` in the first probe run. Use `ExactSessionTarget`, or a bare name if the exact form is refused. Apply verifies this in a test. Non-iso attaches keep today's argv byte-for-byte.

**Attach-failure rollback**: if `pty.StartWithSize` fails after an ensure, the option was never set, so the session would leak. Kill the iso session **only if it has no attached clients**, because another isolated viewer may share it.

### 3. Lifecycle — `destroy-unattached`, verified

Probe on tmux 3.7c, private `-S` socket, 2026-09-25:

| Step | Observed |
|------|----------|
| `set-option destroy-unattached on` on a freshly created, never-attached session | **Session destroyed immediately.** The option therefore cannot be set at creation. |
| `attach-session -t ISO ; set-option -t ISO destroy-unattached on` (via `script` pty) | Client attached; option `on`; session alive |
| `select-window` home:@other then home:@0 while the iso client is attached | Home active moved; **iso active stayed on its window** |
| Second isolated client on the same iso session; SIGKILL the first | Session **survives** (one client left) |
| SIGKILL the last client | Iso session **reaped**; the linked window **still alive in home** (`home windows=@0 @1`) |
| `kill-session -t home` while an iso client is attached | The window **survives in the iso session** (its last link). When the last iso client dies, the session is reaped and the window dies with it. |

Choice: **`destroy-unattached on`, set by the attach command itself**. There is no explicit reap on stream close, because tmux reaps when the last client detaches. That covers relay `closeStream` / socket teardown (`killAndReapAttach` SIGKILLs the attach client) and a daemon crash (attach children die, their PTYs close) with no rk bookkeeping. This keeps the design tmux-side (Constitution II/VI).

**Residual leak window**: a daemon death between `EnsureIsoSession` and the attach leaves a client-less iso session without the option set. It is reused by the next ensure for that window. No sweep in v1. <!-- assumed: crash-window leak accepted without a sweep — narrow window, reuse heals it; revisit only if the home-killed orphan case matters -->

**Home killed while isolated**: the window outlives its home session, invisible in the sidebar because iso is hidden, until the last isolated viewer leaves. v1 accepts and documents this, with no rk-side cascade from session kill to iso sessions. It appears again under Open Questions.

### 4. Tests (Go only — no frontend sender in this change)

Tests run on an isolated `-L` server using the existing test-socket naming (`rk-test-<role>-<pid>-<ns>`), gated with `env -u TMUX -u TMUX_PANE go test ./...` after `just _ensure-tmux-conf`. Use the `-L` + stubbed-precondition pattern from project memory.

- `internal/tmux`:
  - `IsoSessionName` / inverse round-trip, and invalid ids.
  - `EnsureIsoSession`:
    - creates a session with exactly the target window;
    - the window is still in home;
    - it is idempotent;
    - a concurrent or duplicate ensure succeeds;
    - a link failure rolls back.
  - `SessionRole("_rk-iso-5") == "iso"`.
  - `parseSessions` and `isLayoutHiddenSession` skip iso.
  - `ResolveWindowSession` returns home, not iso, for a window linked into both.
  - The `list-windows -a` consumers do not duplicate a window linked into iso.
- Relay (`api/terminals_ws_test.go` or a sibling):
  - **Two isolated streams on sibling windows of one session each keep their window.** Open @A and @B of session S with `isolate:true`, then write/select on home. Each PTY keeps rendering its own window, and home's active window is not moved by the opens.
  - A non-isolated open still attaches home (unchanged argv).
  - `isolate` on a pinned window attaches the pin session and creates no iso session.
  - Closing the last isolated stream reaps `_rk-iso-N` while the window stays in home.
  - An `open` without the field decodes as `Isolate=false`.

### 5. Specs and memory

- `docs/specs/api.md` § `/ws/terminals` (~line 399–425): the `open` op gains `isolate` (optional bool, default false), and the pick order becomes pin → iso (when requested) → home.
- Memory updates at hydrate; see Affected Memory.

## Affected Memory

- `run-kit/tmux-sessions`: (modify) new § Iso Sessions (`_rk-iso-*`): naming, ensure shape, `destroy-unattached` chained on attach, sharing, the home-killed and crash-window caveats. Also:
  - relay pick order pin → iso → home in § Terminal Relay, and the Accepted-tradeoffs note (opt-in isolation escapes the yank);
  - `iso` in § Session Role Taxonomy;
  - § parseSessions Filter Chokepoint;
  - Design Decisions: *Opt-in isolation, not every stream*; *destroy-unattached set by the attach, not at creation*.
- `run-kit/api-and-sockets`: (modify) `/ws/terminals` `open` op `isolate` field and the pick order.
- `run-kit/architecture/tmux-runner`: (modify) `EnsureIsoSession` / `IsoSessionName`, and `ResolveWindowSession` skipping iso.
- `run-kit/layout-snapshots`: (modify) `isLayoutHiddenSession` excludes `_rk-iso-*`.
- `run-kit/agent-messaging`: (modify) `rk mux sessions` role enum gains `iso`; `rk mux panes` skips iso sessions.

## Impact

- **Code**:
  - `app/backend/internal/tmux/` (`tmux.go`, `board.go` shape reuse — possibly extract a shared `linkSingleWindowSession` helper used by both Pin and EnsureIsoSession, `session_facts.go`, `layout.go`, `webtabs.go`, `legacy_options.go`);
  - `app/backend/internal/tmuxctl/` (event filter);
  - `app/backend/api/terminals_ws.go`;
  - `app/backend/cmd/rk/mux_panes.go`;
  - tests beside each.
- **APIs**: additive optional field on the `/ws/terminals` `open` op. No new routes (Constitution IV) and no new endpoints (IX untouched).
- **Frontend**: none in this change. `relay-mux.ts` starts sending `isolate` in change 4. That change must keep `isolate` in the stream's re-open `opts` so a socket drop re-opens isolated. Isolated streams do not ride same-session window switches.
- **Constitution**: I (argv slices incl. the `";"` separator arg; validated window id before any tmux call), II/VI (state is tmux-derived; reaping is tmux-side), IV (no route/setting), Test Intent Comments N/A (no Playwright tests).
- **Verification**: `just _ensure-tmux-conf` then `cd app/backend && env -u TMUX -u TMUX_PANE go test ./...`; `just test-backend`.

## Open Questions

- Should rk's session-kill path also kill iso sessions linked to that session's windows, so killing a home session with a borrowed or popped-out terminal kills the window immediately instead of when the last isolated viewer leaves? (v1: no; documented.)
- Is a sweep for client-less `_rk-iso-*` sessions left by a daemon crash between ensure and attach worth adding? (v1: no; reuse heals it.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Isolation is opt-in via `isolate: true` on the `open` op; non-isolated streams are unchanged | Asked — user chose opt-in; always-isolate breaks the same-session ride and URL-follows-tmux model and forces frontend work | S:95 R:70 A:90 D:90 |
| 2 | Certain | Lifecycle is `destroy-unattached on` chained onto the iso attach argv (`attach-session … ; set-option … destroy-unattached on`), no explicit reap | Probed on tmux 3.7c: setting it at creation destroys the session; chained on attach it reaps on last-client exit and leaves the window in home | S:80 R:80 A:90 D:80 |
| 3 | Certain | Session name `_rk-iso-<windowDigits>`, `IsoSessionName`/`WindowIDFromIsoSession` beside the pin helpers | Plan-specified; mirrors `PinSessionName` | S:95 R:75 A:95 D:95 |
| 4 | Certain | Pick order pin → iso (when requested) → home; a pinned window never gets an iso session | Plan-specified; pin already isolates | S:90 R:80 A:90 D:90 |
| 5 | Certain | `EnsureIsoSession` follows Pin's creation shape (`new-session -d -c ServerBirthDir`, captured placeholder, `link-window`, kill placeholder, Background-rooted rollback); idempotent; duplicate-session race = success | Plan says "the pin path's shape"; board.go is the reference | S:80 R:85 A:85 D:80 |
| 6 | Confident | One iso session per window, shared by every isolated viewer of that window | Name is keyed by window id; probe showed the session survives while any client remains | S:70 R:80 A:85 D:75 |
| 7 | Confident | Attach failure after ensure kills the iso session only when it has no attached clients | Option is unset until attach succeeds, so it would leak; a shared session must not be killed under another viewer | S:60 R:85 A:80 D:75 |
| 8 | Confident | Iso sessions are hidden everywhere pin sessions are (shared predicate over parseSessions, layout snapshots, home resolution, `list-windows -a` consumers, tmuxctl events, mux panes) | Same link-target nature as pin; plan says `parseSessions` filter + snapshots skip | S:70 R:80 A:75 D:70 |
| 9 | Confident | New `SessionRoleIso = "iso"` rather than falling into `reserved` | Plan: "`_rk-iso-` in the `_rk-*` taxonomy"; explicit role is more useful to `rk mux sessions` consumers | S:60 R:85 A:70 D:60 |
| 10 | Confident | Home killed while isolated: window lives on in the iso session until the last isolated viewer leaves; accepted and documented in v1 | Probed behavior; a cascade would only cover rk's kill path, not plain tmux | S:50 R:75 A:55 D:45 |
| 11 | Tentative | Crash-window leak (daemon dies between ensure and attach) accepted with no sweep; next ensure reuses the session | Narrow window and reuse heals it, but an orphan could outlive a killed home | S:30 R:70 A:40 D:40 |
| 12 | Certain | Backend-only: no frontend sender in this change; `isolate` absent ⇒ false | User instruction + plan: change 4 wires the client | S:90 R:85 A:90 D:90 |
| 13 | Certain | Tests are Go-only on an isolated `-L` server with `env -u TMUX -u TMUX_PANE`, incl. the two-sibling-windows relay test and the reap test | Plan item 5 + project memory on the Go test gate | S:85 R:90 A:85 D:85 |
| 14 | Confident | Memory/spec touch set: tmux-sessions, api-and-sockets, architecture/tmux-runner, layout-snapshots, agent-messaging; spec api.md § /ws/terminals | Plan item 6 plus every doc that enumerates `_rk-pin-*` filtering | S:75 R:90 A:75 D:70 |

14 assumptions (7 certain, 6 confident, 1 tentative, 0 unresolved).
