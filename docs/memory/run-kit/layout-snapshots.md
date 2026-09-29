---
type: memory
description: "Per-server tmux layout snapshots (`internal/snapshot`): capture set + the hexokit state-home snapshots store (apphome dual-read, one-release legacy window; atomic latest, 10-entry history, content-dedup, zero-session guard, .died-{ts} tombstones), Snapshotter cadence + ephemeral opt-out, the per-window recently-closed ring ({server}.closed/, ClosedRingCap 10; consumers: closed-window routes + cron respawn by AgentRef), restore/reopen engines + rk mux snapshot CLI (no relaunch), recovery reader."
---
# Layout Snapshots & Restore

**Domain**: run-kit

## Overview

The run-kit daemon persists a layout snapshot per covered tmux server so a server death (agent misfire, crash, reboot) is recoverable instead of a forensic reconstruction. `internal/snapshot` owns the schema, the file store, the periodic writer, the restore engine, and the restorable-offer derivation. Snapshots are **disaster-recovery backups** — artifacts about the past, never the source of a live-state answer — and restore never relaunches a process. Two read surfaces serve them: the `rk mux snapshot list|show|restore` CLI (the operator reader) and the `/api/recovery` endpoints behind the Host Overview RECOVERY zone (the user-facing reader — § Snapshot read boundary).

## Requirements

### Requirement: Capture set

`internal/snapshot.CaptureServer(ctx, server)` derives the whole recreate-able layout from tmux at capture time and nothing more. Scrollback contents, environment variables, and running processes MUST NOT be captured.

The JSON schema (`snapshot.go`):

| Level | Fields |
|-------|--------|
| `Snapshot` | `server`, `takenAt`, `serverRank` (nullable, `@rk_srv_rank`), `sessionOrder` (`@rk_srv_session_order`), `sessions[]`, plus tombstone-only `diedAt` / `auditedKill` |
| `Session` | `name`, `createdAt` (unix seconds), `color` (raw `@rk_ses_color`), `windows[]` |
| `Window` | `index`, `id`, `name`, `active`, `layout` (`#{window_layout}`), `color`, `rkLayout` (`@rk_win_layout` — named `rkLayout` because `layout` already holds the tmux pane layout string), `webTabs` (dense `@rk_win_web_<n>` family), `webRoots` (parallel to `webTabs`, `""` = no root), `webActive` (`@rk_win_web_active`), `codeRoot` (`@rk_win_code_root`), `marker` (normalized `@rk_win_marker` `<mode>[:<stage>]` token), `flair` (`@rk_win_flair`), `role` (`@rk_win_role`), `owner` (`@rk_win_owner`), `note` (`@rk_win_note` — raw `<unix-epoch>:<text>` value), `panes[]` |
| `Pane` | `id`, `index`, `cwd`, `command`, `active` |

`Pane.Command` is informational only — reported by restore, never relaunched. `Pane.Active` is consumed by restore's active-pane re-select.

Capture assembles from the `internal/tmux` layout reads plus `GetSessionOrder`/`GetServerRank`, grouping windows under their owning sessions with a **deterministic order** (sessions by creation time then name; windows and panes by index). Determinism is load-bearing: the store's write dedup compares serialized content, so equal layouts MUST serialize equally. The two rk option reads are best-effort — a malformed stored value degrades to `slog.Debug` with the field left empty rather than sinking the layout capture. The layout reads themselves are hard errors.

#### Scenario: Dead server never captures as empty
- **GIVEN** a capture racing its server's death
- **WHEN** the layout reads fail
- **THEN** `CaptureServer` returns an error, never an empty snapshot — an empty snapshot overwriting a good one is exactly the loss snapshots exist to prevent

### Requirement: `internal/tmux` layout primitives

`internal/tmux/layout.go` holds both halves — the read-only layout queries and the restore mutators — all routed through the package's `Run`/`RunOutput` core with `exec.CommandContext` argument slices and `TmuxTimeout` (Constitution §I).

**Reads** (tab-delimited `-F` formats + pure `parseLayout*` helpers, same shape as `parseSessions`):

- `ListLayoutSessions` — `#{session_name}`, `#{session_created}`, `#{@rk_ses_color}`.
- `ListLayoutWindows` — `list-windows -a`, keyed to the non-hidden owning session, **deduplicated by window id** (a pinned or isolated window is linked into both its home session and its `_rk-pin-*`/`_rk-iso-*` session, so `-a` surfaces it once per link; the first non-hidden occurrence wins).
- `ListLayoutPanes` — `list-panes -a` grouped into a `windowID → panes` map, deduped by pane id.

`isLayoutHiddenSession` excludes the hidden link-target sessions (`IsHiddenLinkSession` — board pin-sessions `_rk-pin-*` and isolated relay sessions `_rk-iso-*`) and the `_rk-ctl` control anchor — pinned/isolated windows persist via home-session membership and the anchor is daemon-recreated. `_rk-operator` is deliberately NOT excluded: the operator window is MOVED into it (single membership, unlike the linked pin/iso sessions — see [tmux-sessions](/run-kit/tmux-sessions.md) § Operator Session), so excluding it would drop the operator window from the capture entirely. Unlike `ListSessions`, these helpers deliberately do NOT map a dead-server error to an empty result.

The `_rk-operator` + `@rk_win_role` round trip is load-bearing: capture takes `_rk-operator` as a regular session (windows nested under it, each carrying `role` from `@rk_win_role`), and restore recreates the session with its windows and re-applies `@rk_win_role` per window (§ Restore semantics) — so a snapshot taken with a promoted operator restores to hidden+pinned state (the restored `_rk-operator` satisfies the FetchSessions content rule), never a visible stray session with an orphaned role. Pinned by the live-tmux integration test `TestOperatorPromotionRoundTripLiveTmux` (`internal/snapshot/integration_test.go`).

The window capture format (`layoutWindowFormat`) carries the rk-owned presentation options as positional fields after `window_layout`: `@rk_win_color`, `@rk_win_layout`, the web-tab family spelled out slot by slot — `@rk_win_web_1..16` (URLs) **and** `@rk_win_web_1_root..16_root` (roots; this format runs once per snapshot, not per tick, so the tick-cost argument behind `ListWindows` omitting roots does not apply) — `@rk_win_web_active`, `@rk_win_code_root`, `@rk_win_marker`, `@rk_win_role`, `@rk_win_flair`, `@rk_win_owner`, then `@rk_win_note` as a strict single field, and legacy `@rk_note` **LAST**. Every post-slot field offset derives from `tmux.MaxWebTabs` via the `layoutWindow*Field` constants beside `parseLayoutWindows` (the `listWindows*Field` twin beside `parseWindows` in [tmux-sessions](/run-kit/tmux-sessions.md) § the `@rk_win_web_<n>` row), so a cap raise stays a one-line change and short lines from older captures parse tolerantly with missing fields empty. `parseLayoutWindows` applies `NormalizeMarker` to the marker field, so snapshots contain only the current marker vocabulary even when tmux stores a flat token. The dual-read note key is read new-then-legacy positionally — `parseLayoutWindows` prefers the new field and falls back to the legacy one — the same rule as `parseWindows`. Only the legacy note gets tail-rejoin (`strings.Join(parts[N:], listDelim)`): it is free text in a tab-delimited format and MUST stay last so tabs inside the text cannot truncate sibling fields; the new note is control-char-stripped at write time (the shared `validate.ValidateNoteText` rule), so a single field is safe. The legacy note field exists for the deprecation window only ([tmux-sessions](/run-kit/tmux-sessions.md) § Deprecation Ledger). The capture struct stores the family as struct FIELDS (`RkLayout`, `WebTabs []string`, `WebRoots []string` parallel to `WebTabs` with `""` where absent, `WebActive`, `CodeRoot`), not option names — a snapshot carrying the older `rkType`/`rkUrl` keys decodes fine because this struct ignores unknown keys and restores without web state; `/present/` URLs are restored verbatim (parity — no `@N` window-id remap).

**Restore mutators**:

- `CreateSessionForRestore(name, windowName, cwd, server) (windowID, bornIndex, error)` — `new-session -d -P -F '#{window_id}\t#{window_index}'`; server-birth-capable, so it carries the same pins as `CreateSession` (config `-f`, `CleanEnvForServer`, `ServerBirthDir`) plus the same `@rk_srv_managed` birth stamp (the shared `stampManagedOnBirth` seam with its `probeServerAlive` pre-probe — restore applies the managed conf, so the restored server is rk-managed; the capture set is NOT extended to carry a pre-death mark, and a restored formerly-external server comes back managed — adopt semantics by construction). Returns the born index so the caller can renumber.
- `CreateWindowAtIndex(session, index, name, cwd, server)` — `new-window -d -P` at an explicit `=session:index` target.
- `CreateWindowWithOptionsID(session, name, cwd, server, ops)` — `new-window -a` append after the session's current window; the reopen engine's fallback when the stored index is occupied (the restore engine's documented append posture, minus `MoveWindow`: a reopen never renumbers a live session's neighbours). `ops` is passed as nil at that seam — the `@rk_win_*` re-stamp runs as a follow-up `SetWindowOptions` call once the new id is known, so it degrades per-step.
- `RenumberWindow(session, windowID, index, server)` — `move-window -s <windowID> -t =session:<index>`. Distinct from `MoveWindow`, which is a reorder-among-existing-windows primitive built on adjacent swaps and no-ops onto a free index.
- `SelectLayout(windowID, layout, server)` — `select-layout -t <windowID> -- <layout>`; the `--` pins the layout string positionally (mirrors `set-buffer` in `SetAgentSendBuffer`).
- `SelectPane(paneID, server)` — `select-pane -t %N`.

**Supervisor seams** (`internal/tmuxctl/supervisor.go`), all nil-safe/no-op when unwired: `Sockets() []string` (the covered-server set — `rk-test-*`/`.lock` candidates never open a Client, so the snapshotter inherits the daemon's scope filter with no new enumeration), `Generation(name) int64`, and the `OnSocketRemoved func(string)` callback invoked from `closeSocket` outside the mutex on the event-loop goroutine.

### Requirement: Store layout and retention

`snapshot.Store` roots at `DefaultDir()` — `<state home>/snapshots`, where the state home resolves through `internal/apphome.StateDir()` under the dual-read rule: `${XDG_STATE_HOME:-~/.local/state}/hexokit` when the hexokit dir exists or neither home exists, else the legacy `run-kit` dir — the legacy read is a one-release window, dropped next release. State dir, not cache: recovery artifacts must not be droppable by contract. `snapshots/` is in the state home's must-move copy set: `internal/homemigrate.Migrate()`, called at release-build `serve` start only, copies the legacy `run-kit/snapshots/` tree (recursive, file modes preserved) into a temp sibling and publishes it onto the new home with one atomic `os.Rename` — best-effort and non-fatal, the race loser discards its copy, and the legacy tree is left byte-unchanged (downgrade-safe). On store first use, when the resolved dir is absent and a legacy `$XDG_STATE_HOME/rk/snapshots` exists, the legacy dir is moved into place (`os.Rename`, best-effort, one-time — preserving recovery backups) and a `MOVED-to-run-kit` breadcrumb file is left in the legacy state dir naming the new path; a failed move degrades to cold-start behavior (empty store), never an error. The breadcrumb keeps the `MOVED-to-run-kit` name — an on-disk artifact name written by prior releases (§ Design Decisions). (li54)

```
{server}.json                 — latest snapshot (live server)
{server}/{unix-ts}.json       — rolling history, last 10
{server}.died-{unix-ts}.json  — tombstones, last 10
{server}.closed/{unix-nanos}.json — per-window recently-closed ring, last 10 (§ Recently-closed window ring)
```

`Write` skips entirely when content equals the current latest **ignoring `takenAt`** (`ContentEqual`), so safety-interval passes on quiet servers never churn history — history holds 10 real layout changes, not 10 minutes. Both the latest and the history entry go through `fsatomic.WriteFile`; history beyond 10 entries is pruned oldest-first on write. A **same-second collision** (two content-different writes inside one second) bumps the history timestamp forward to the next free second, keeping the filename grammar a bare unix-seconds integer so `--at`/`LoadAt` stay compatible.

`Tombstone(server, diedAt, audited)` loads the latest, stamps `diedAt` (+ `auditedKill`), atomically writes `{server}.died-{ts}.json`, removes `{server}.json`, and prunes tombstones to 10; history directories are left intact. A server with no latest snapshot is a no-op.

`Dismiss(server)` converts the server's lingering live-latest into a tombstone stamped `auditedKill: true` (a thin `Tombstone(server, time.Now(), true)` wrapper): a user-driven dismissal is a deliberate run-kit action, and the audited marker already excludes the entry from the restorable-offer set, so a dismissed server is never re-offered. Idempotent — a server with no latest snapshot is a no-op success; history is left intact.

`RetireLatest(server)` removes the server's latest snapshot file **without tombstoning it** — the `@rk_srv_ephemeral` opt-out's cleanup, for when the immediate first-observation snapshot landed before the mark was set. Retire means "never should have been covered", as opposed to a tombstone's "server died", so no `.died-*` file is created and rolling history/tombstones are untouched (the existing prune owns history). Idempotent — a missing latest is a no-op success.

Readers: `LoadLatest`, `LoadAt(server, ts)` (history entry, then tombstone), `Resolve(server, at)` (the entry at `at`, else the latest, else the newest tombstone), and `List(serverFilter)` (every live latest and every tombstone, newest-first, with session/window counts and history depth). The `.died-` infix can never occur inside a server name — validated names are `[A-Za-z0-9_-]`, no dots — so the filename grammar is unambiguous.

#### Scenario: Zero-session snapshot never overwrites a good latest
- **GIVEN** the `_rk-ctl` anchor holding a socket alive after the last user-facing session closes
- **WHEN** capture succeeds and yields a 0-session snapshot
- **THEN** `Store.Write` skips it with a `slog.Debug` line — the last good layout and its history survive

#### Scenario: Freshness-only recapture writes nothing
- **GIVEN** a store with an existing latest snapshot for `kit`
- **WHEN** an identical-content snapshot with a newer `takenAt` is written
- **THEN** neither the latest file nor the history changes

### Requirement: Recently-closed window ring

`{server}.closed/{unix-nanos}.json` holds one `ClosedWindow` per recently-killed tmux window on `server`, newest-first. `ClosedWindow` (`ID` unix-nanos string, `ClosedAt` RFC3339, `Server`, `Session` — the owning non-pin session at kill time, `Window` — the full `Window` capture struct incl. panes, `AgentProvider`/`AgentRef` — JSON keys `agentProvider`/`agentRef` (omitempty), from `sessions.ResolveAgentPane`'s active-pane-first rollup over the envelope's fetch at kill time, both omitted when the window carried no agent pane) is what the api's kill seam pushes so a reopen CAN state exactly what was lost. (260904-bf1l-agent-session-identity-rename) `Store.PushClosed(rec)` assigns `ID`/`ClosedAt` itself (unix-nanos, with an intra-nanosecond collision bump forward, mirroring the history same-second bump) and prunes oldest-first on write via `ClosedRingCap = 10` — a named constant, not a setting (same posture as history/tombstone retention, Constitution IV/VII). `ListClosed` returns newest-first, skipping undecodable files (a missing ring dir is an empty list); `LoadClosed(server, id)` returns `(nil, nil)` on absence; `DeleteClosed` is idempotent. A record written with the previous-generation `chatProvider`/`chatRef` JSON keys is folded into `AgentProvider`/`AgentRef` on load by `coalesceLegacy` — a present new key wins, and the legacy fields are zeroed after coalesce, so any re-write carries only the new keys; the write path emits only the new keys, and pre-upgrade records keep their resume affordance. (260904-bf1l-agent-session-identity-rename) The `closedSuffix = ".closed"` infix cannot collide with a server name — validated names are `[A-Za-z0-9_-]`, no dots — the same grammar argument as `.died-`. Record ids are bare unix-nanos digit strings validated by `validClosedID` before they address a path on disk (the filename-grammar owner is the store, never the caller).

The ring has two consumer classes: the api's closed-window routes (§ Snapshot read boundary) and the cron session respawner (`cmd/rk/cron_respawn_session.go`), which scans `ListClosed` newest-first for the first record whose `AgentRef` matches a due session-target cron entry and — on a successful resume — drops the consumed record via `DeleteClosed` ([cron](/run-kit/cron.md) § Session-Target Respawn).

The api package records in `handleWindowKill` BEFORE `tmux.KillWindow` (the option set dies with the window and is never derivable after) via `CaptureWindow(ctx, server, windowID) (Window, session, error)` — a **single-window** capture that reads only the one window through `tmux.ListLayoutWindow`/`tmux.ListLayoutPanesForWindow` (the `-f`-filtered variants of `ListLayoutWindows`/`ListLayoutPanes`, so a kill never walks every window on the server). The `layoutWindowToSnapshot` helper maps the read onto the `Window` shape in exactly one place, shared by `CaptureServer` and `CaptureWindow`. Any capture failure degrades to `slog.Debug` + an absent `closed` field — recording must never block or fail the kill itself.

### Requirement: Window reopen engine

`snapshot.ReopenWindow(ctx, server, rec)` beside `Restore` recreates ONE closed-window record's window onto a live server — same session, name, index where feasible, pane cwds as fresh shells, split geometry best-effort, and the `@rk_win_*` option set re-stamped — and returns the new window ID. It runs through the exported/unexported pair `ReopenWindow`/`reopenWindow` driving the shared `restoreOps` seam (production `productionRestoreOps`; tests inject fakes), so the ordering/fallback logic is unit-testable without a live tmux server. The session check and the window create are fatal; every later step (cwd fallback, splits, layout, active-pane select, options, focus) degrades to a `slog.Debug` line — the restore engine's per-step posture, minus its report (reopen returns no report, so what restore would collect becomes log lines).

Sequence: (1) the record's `Session` must exist on the server (`ops.listSessions` → `SessionGoneError{Session}` when absent — `ListSessions` maps a dead server to `(nil, nil)`, which lands here the same way); (2) the first pane's stored cwd degrades through `restoreCwd` (missing dir → server default, note); (3) `ops.createWindowAt` tries the stored index, falling back to `ops.createWindowAppend` (`new-window -a`, never renumbering live neighbours) when that errors — the production adapters are `tmux.CreateWindowAtIndex` / `CreateWindowWithOptionsID`; (4) additional panes ride `ops.splitWindow` detached at their own cwds, with `newPaneIDs` tracking created ids for the re-select; (5) `ops.selectLayout` replays the stored `Layout` string best-effort when at least one extra pane came back (positionally mapped — each pane's cwd stays with the pane, not the cell); (6) the stored active pane beyond position 0 re-selects via `ops.selectPane`; (7) the `@rk_win_*` set rides `WindowOptionOps(rec.Window)` (the ONE exported option mapping shared by restore, reopen, and the resume re-stamp in `api/closed.go`; empty values omitted, active pointer only when > 0) through `ops.setWindowOpts(ctx, ...)`; (8) `ops.selectWindow` focuses the new window. `firstPaneCwd` is the shared first-pane-cwd helper; `/present/` URLs are restored verbatim (no `@N` remap).

Every tmux invocation goes through `internal/tmux` on the explicit server socket (Constitution §I), and reopen is user-initiated only — the same posture as restore, bounded per call inside.

### Requirement: Snapshotter cadence

`snapshot.Snapshotter` runs inside the serve process over a `ServerSource` (`Sockets()` / `Generation(name)`, satisfied by the tmuxctl Supervisor) and a `Store`.

- **Debounce** — a 2s check tick compares each covered server's control-mode generation counter (an in-memory int read, zero subprocess cost) against the last written one; a write lands after the counter has been **stable for one full tick**, so event bursts coalesce into one capture.
- **Churn bound** — `maxHold` (15s) caps how long the debounce may defer a continuously-churning server, so sustained window cycling still snapshots rather than starving writes until quiescence.
- **Safety pass** — every ≥60s per server, capture and write-if-changed regardless of events, covering missed notifications and layout-invisible drift. Mirrors the SSE hub's safety-poll backstop at a far coarser cadence: snapshots need freshness, not UI latency.
- **First observation** — a newly covered server (daemon start or a fresh socket) snapshots immediately rather than waiting out a safety interval.
- **Ephemeral opt-out** — a due pass (first observation, event-due, or safety-due) first reads the server's ephemeral mark (`tmux.EphemeralOption` = `@rk_srv_ephemeral`; `IsEphemeralServer` dual-reads the retired `@rk_ephemeral` when the scope-named one is unset — [tmux-sessions](/run-kit/tmux-sessions.md) § Legacy Option Migration) via the injectable `ephemeralFunc` seam on `Snapshotter` (production: `tmux.IsEphemeralServer`; tests inject a fake, mirroring the `captureFunc` seam). The read happens only where a write would — never on every 2s tick. A marked server gets no capture and no write; the pass instead calls `Store.RetireLatest` under `writeMu` (honoring the same `removedEpoch` drop rule as writes) so a latest written before the mark was set is removed, and reports success so bookkeeping advances — the mark is re-read only on generation movement or the safety cadence, which doubles as the un-mark detection bound. A read error degrades to a log line and the pass proceeds as not-ephemeral (snapshot coverage is the safer default). Removing the mark (`set-option -s -u @rk_srv_ephemeral`) resumes coverage on the next due pass with no other action. The check lives in the snapshotter's pass, NOT in the Supervisor's covered set — an ephemeral server stays live in SSE/UI.
- **Accepted residual race** — a server marked and killed within one check interval (~2s) before the snapshotter observes the mark leaves a lingering latest → one restorable offer. Accepted; no ephemeral flag is stamped into the snapshot payload, and `RestorableOffers` carries no ephemeral filter — the option dies with its server and is unreadable post-mortem, so the skip+retire pair is the only mechanism that can work.
- **Bookkeeping advances only on success** — `writtenGen`, `lastPass`, and `dirtySince` move only after a pass whose capture succeeded and whose write landed or deduped, so a failed capture retries on the very next tick instead of being parked until the safety interval.
- **Resilience** — every failure degrades to a log line (`IsServerGone` capture errors at `Debug`, everything else `Warn`); snapshotting never crashes or blocks serving, and a snapshotter that fails to start is non-fatal.

`OnServerRemoved(server)` tombstones the dead server's latest snapshot. `NoteAuditedKill(server)` records a kill through run-kit's audited path; a removal observed within 30s tombstones as `auditedKill: true`.

#### Scenario: A capture racing removal never resurrects a live latest
- **GIVEN** an in-flight capture for a server whose socket is then removed
- **WHEN** `OnServerRemoved` bumps that server's `removedEpoch` and takes `writeMu` to tombstone
- **THEN** a write already inside `writeMu` completes and is legitimately part of the tombstone, while any write acquiring `writeMu` afterwards observes the bumped epoch and drops — no "live" latest ever reappears after the tombstone

### Requirement: `rk mux snapshot` CLI

`cmd/rk/snapshot.go` builds a cobra parent with three children as a member of the `rk mux` family ([agent-messaging](/run-kit/agent-messaging.md)); the old root form `rk snapshot …` survives as a hidden deprecation alias (pointer printed on the executed command, identical flags/output/exit codes, removable in a future release). All children validate `<server>` via `validate.ValidateServerName` and `--at` as a non-negative unix timestamp **before** any filesystem or tmux use. All output goes to `cmd.OutOrStdout()` — it is data, unaffected by `--quiet` (the `reaper` posture). The family members reject an explicitly-set inherited `-L/--server` with a usage error (exit 2).

- `list [<server>] [--json]` — human form: one row per entry — server, state (`live` / `died <age> ago` / `died <age> ago (audited)`), snapshot age, session/window counts, history depth — capped at 10 rendered rows (`snapshotListCap`) with a stated truncation notice and `--all` to lift it (Toolkit Principle 9, mirroring `reaper`); the header count stays exact. `--json` emits the standard JSON envelope via `outputSink.Envelope` (full envelope convention in [cli](/run-kit/architecture/cli.md)): `{"ok":true,"result":[…]}` with one object per `Store.List` entry in its newest-first order, keys exactly `server`, `taken_at` (RFC 3339 UTC), `died_at` (RFC 3339 UTC or null — null ⇔ a live row, so state is derivable and there is no separate state key), `audited_kill`, `sessions`, `windows`, `history_count`; an empty store emits `"result": []`, never null. `--json` carries every row — `snapshotListCap` and `--all` bound only the rendered table, so `--all` is accepted but inert under `--json`. The verb addresses the store, never a socket. The MCP `snapshot_list` tool exposes this verb ([mcp](/run-kit/mcp.md)). (260911-ehm2-cli-json-read-verbs)
- `show <server> [--at <ts>]` — prints the stored layout tree (sessions → windows → panes with cwds and former commands) plus rank/session-order/death metadata, touching no tmux.
- `restore <server> [--at <ts>]` — recreates the layout and renders the report.

### Requirement: Restore semantics

`snapshot.Restore(ctx, server, snap)` recreates a dead server's layout through the `restoreOps` seam (production adapters over `internal/tmux`; tests inject fakes). Restore is user-initiated only — the daemon never restores automatically (Constitution §VI).

- **Target agreement** — the operative target is the caller-validated `server` argument, not the JSON-embedded `Server` field; a snapshot whose field disagrees is rejected. No JSON-sourced value ever reaches a tmux target.
- **Refusal** — a server alive with ≥1 user-facing session (`ListSessions`, which maps a dead server to `(nil, nil)`) is refused. There is no `--force`: restore is for dead servers.
- **Sessions** — recreated oldest-first with original names. The first window rides `CreateSessionForRestore` (which births the server with the standard pins) and is renumbered from the born base-index to its stored index when they differ; later windows are created at their explicit stored index.
- **Panes** — fresh shells at the recorded cwd, appended as sequential detached splits. `select-layout` restores geometry best-effort; a failure is a report note, never fatal. A stored active pane beyond position 0 is re-selected via `SelectPane` (splits are detached, so position 0 needs no call).
- **Options** — `@rk_srv_rank`, `@rk_srv_session_order`, session color (`@rk_ses_color`), and per-window `@rk_win_color` / `@rk_win_layout` / the web-tab family (`@rk_win_web_<n>` + `@rk_win_web_<n>_root` per dense slot, `@rk_win_web_active` when > 0) / `@rk_win_code_root` / `@rk_win_marker` / `@rk_win_flair` / `@rk_win_role` / `@rk_win_owner` / `@rk_win_note` are reapplied from the snapshot (empty values are omitted, never unset — the skip-when-empty `add` helper), and each session's stored active window is re-selected. `WindowOptionOps` applies `NormalizeMarker` before constructing the marker write, so snapshots containing flat tokens restore as current tokens. Every failure is a report note. `@rk_win_note` round-trips **verbatim**, epoch prefix included, so the note's relative age stays honest across a restore.
- **Missing cwd** — a deleted worktree falls back to the server default dir (no `-c`) with a note; it never fails the restore.
- **Report** — what was recreated, what was skipped, per-window notes, and each window's former command so the user can decide what to resume (e.g. `claude -c` per agent window), closing with the attach hint.

Split-order fidelity has a stated limit: `select-layout` maps panes to layout cells **positionally**, so a window whose original panes were created in a different split order can see panes occupy different cells than they originally did. Each pane's cwd and former command stay with the pane, not the cell.

A stored `@rk_win_layout` is reapplied **verbatim** and does not run the live-in-one-place check — a surface borrowed into another tab at snapshot time restores as borrowed even when the holder's state has since drifted. Accepted limitation of a user-initiated restore of past state ([ui/lenses-and-layout](/run-kit/ui/lenses-and-layout.md) § Surface Layout → Tiles from other tabs).

#### Scenario: No process is ever relaunched
- **GIVEN** a tombstoned snapshot whose panes recorded long-running commands
- **WHEN** `rk mux snapshot restore <server>` runs
- **THEN** every recreated pane is a fresh shell and the stored commands appear only in the report output

### Requirement: Restorable offers — the reboot signature

`Store.RestorableOffers(liveServers []string)` (`restorable.go`) derives the restorable-offer set: every `Store.List("")` entry with `DiedAt == nil` (a lingering live-latest — the daemon died with the server, so nothing tombstoned it: the reboot signature) whose server is absent from the caller-supplied live-server enumeration (`tmux.ListServers(ctx)` — no live socket). Tombstones — audited or unaudited — are never offered. Infra servers are excluded by name via `infraServerName` (exact `rk-daemon`/`rk-jobs`/`rk-code-server`/`rk-remotes` — the daemon siblings, whose layouts are owner-recreated — plus the `rk-test-*` prefix, mirroring the frontend `isInfraServer` idiom; `rk-test-*` sockets never snapshot at all, so the prefix rule is a second line of defense). The live-server enumeration stays outside the package — the caller passes it in. There is no ephemeral-mark filter here by design: the option dies with its server, so a post-mortem check cannot work — the snapshotter's skip+retire pair (§ Snapshotter cadence) owns the opt-out, with the accepted residual race of one offer for a server marked and killed before its mark was observed.

Each `Offer` carries the server name, `takenAt`, session/window counts, and the full stored layout tree inline — sessions (name, raw `color`) with windows sorted by index (index, name, pane count, the recorded per-pane former commands in pane order with empties omitted, and a per-window `resumable` boolean) — so a row expansion needs no second request. A window is `resumable` when any pane's recorded command is a `claude` invocation (`isClaudeCommand`: the basename of the first word equals `claude` — `claude`, `claude -c`, `/path/to/claude --flags` match; `claudeify` does not). Slices serialize non-nil (`[]`, never `null`). A `LoadLatest` that comes back nil between `List` and load (a raced concurrent tombstone) is skipped — the server no longer qualifies.

#### Scenario: Reboot orphan is offered; infra, tombstone, and live servers never are
- **GIVEN** a store holding a live-latest for `kit`, a live-latest for `rk-daemon`, and a tombstone for `old`, while only `dev` has a live socket
- **WHEN** `RestorableOffers` runs
- **THEN** exactly one offer is returned (`kit`) — `rk-daemon` is excluded as infra, `old` as a tombstone; a live-latest whose server has a socket is excluded as alive

### Requirement: Snapshot read boundary (Constitution II / VI)

Snapshots are derived state persisted as a disaster-recovery backup, not a state store — the same category as the daemon's log file: an artifact about the past, not a database about the present. Live state stays derived from tmux and the filesystem; no live-state query is ever answered from a snapshot.

The sanctioned request-time read paths are TWO user-facing recovery readers (the Constitution §II recovery-reader carve-out), the api package's `internal/snapshot` consumers: `api/recovery.go` serves `GET /api/recovery` (the derived restorable offers; an unwired or empty store yields an empty list, never an error), `POST /api/recovery/restore` (validate the body-addressed server via `validate.ValidateServerName` before any filesystem or tmux use → load the latest → drive `snapshot.Restore` synchronously under a dedicated 60s context — a documented, commented exception to the 5s handler-blocking guidance: rare, user-initiated, each inner tmux call individually `TmuxTimeout`-bounded; the response is the engine's restore report serialized directly, and engine refusals surface as errors, never partial success) and `POST /api/recovery/dismiss` (validate → `Store.Dismiss`), and `api/closed.go` serves the `{server}.closed/` ring (`GET /api/windows/closed` newest-first; `POST /api/windows/closed/{id}/reopen|dismiss|resume` all `?server=`-addressed, mutations POST per §IX) with resume reusing the fork seam verbatim ([rk-riff](/run-kit/rk-riff.md) § Resume-Fork Launcher Seam). The daemon side adds one more consumer of the same store: the cron session respawner wired in `cmd/rk/serve.go`, which reads the ring by `AgentRef` to source a session resume and drops the consumed record on success ([cron](/run-kit/cron.md) § Session-Target Respawn) — a recovery-backup read driving a restore-class action, never a live-state answer. The recovery zone's bulk controls (Restore all, Dismiss all) are client-side sequential loops over the per-server endpoints — dismiss is idempotent and cheap (a single atomic tombstone rename), so no bulk endpoint exists. These endpoints answer questions **about backups** and drive user-initiated restore/reopen — restore stays user-initiated only (Constitution §VI); the daemon never restores automatically. The store is wired nil-safe from `cmd/rk/serve.go` via `api.Server.SetSnapshotStore` — the read-seam mirror of the kill-notifier write seam below — from the same store the snapshotter (and the kill-seam recorder behind `api/closed.go`'s `recordClosedWindow`) writes, so the offers are exactly what was persisted.

The other api-side touchpoint is the write-path annotation: `api.Server.SetServerKillNotifier(fn)` (`api/tmuxctl_bridge.go`) is wired by `rk serve` to the snapshotter's `NoteAuditedKill`, and `handleServerKill` (`POST /api/servers/kill`) invokes it with the server name just before `tmux.KillServer` so the imminent tombstone records the kill as audited. Fire-and-forget, nil-safe, and it reads nothing.

#### Scenario: Live state never comes from a snapshot
- **GIVEN** the backend's snapshot coupling
- **WHEN** audited
- **THEN** the only `internal/snapshot` consumers are `api/recovery.go` (server restore/dismiss), `api/closed.go` (the recently-closed ring), and the daemon's cron session respawner (`cmd/rk/cron_respawn_session.go`, reading the ring by `AgentRef` to source a resume) — each serves backup questions or drives recovery, and no live-state handler reads a snapshot to answer a query

## Design Decisions

### Recently-closed ring lives server-side under `internal/snapshot`
**Decision**: The per-server recently-closed stack is a `{server}.closed/{unix-nanos}.json` ring (cap `ClosedRingCap = 10`, `fsatomic.WriteFile`, newest-first listing) on the same state-home `snapshots/` root as the server snapshots, with `PushClosed`/`ListClosed`/`LoadClosed`/`DeleteClosed` as the store methods and `closedSuffix = ".closed"` as the filename-grammar owner.
**Why**: A client-side (Zustand-only) stack cannot capture `@rk_win_web_<n>_root` (omitted from `ListWindows`) and dies on reload — the ring keeps capture cheap (one window's layout read at the kill seam), survives reload and daemon restart, and reuses the recovery-backup carve-out the server snapshots already occupy.
**Rejected**: a client-only stack — loses state and dies on reload; a per-window record inside the same `{server}.json` latest snapshot — conflates a per-window capture with a server-capture cadence.
*Introduced by*: 260829-11t0-reopen-closed-tab-recently-closed-stack

### Snapshotter home: `internal/snapshot`, wired in `cmd/rk/serve.go`
**Decision**: The writer lives in `internal/snapshot` and is wired in `serve.go` next to the tmuxctl Supervisor, not in `internal/daemon`.
**Why**: The "daemon" that observes servers is the long-running serve process; `internal/daemon` is the tmux-session daemonizer (start/stop lifecycle) and holds no observation machinery. The Supervisor plus its serve wiring is where covered-server observation already lives.
**Rejected**: Extending `internal/daemon` (wrong layer — it never sees sockets or events); hooking the SSE hub's poll loop (it only runs while clients are connected, and snapshots must run unconditionally).
*Introduced by*: 260805-htmy-daemon-layout-snapshots-restore

### Event debounce via generation-counter ticks, not a new EventSink
**Decision**: The snapshotter polls the Supervisor's in-memory per-server generation counters on a 2s tick and writes after one stable tick.
**Why**: Generation counters already increment on every layout-changing control-mode notification, the read is an in-memory int (zero subprocess cost), and tick-compare gives debounce for free without touching the Client read-loop contract (callbacks must not block).
**Rejected**: A dedicated EventSink chained into `NewHubSinkFactory` (couples snapshotting into the SSE sink path and still needs its own debounce timer plumbing); reusing the SSE hub's `Wait` fan-in (the hub only polls servers with connected clients).
*Introduced by*: 260805-htmy-daemon-layout-snapshots-restore

### Tombstone rewrites the JSON rather than renaming only
**Decision**: Tombstoning loads the latest snapshot, stamps `diedAt` (+ `auditedKill` when noted), atomically writes `{server}.died-{ts}.json`, and removes `{server}.json`.
**Why**: A bare rename cannot carry the audited-kill annotation, and stamping inside the JSON keeps one machine-readable artifact per death.
**Rejected**: Sidecar metadata files (two files to keep consistent); encoding "audited" in the filename (unparseable growth of the filename grammar).
*Introduced by*: 260805-htmy-daemon-layout-snapshots-restore

### Content dedup ignores `takenAt`
**Decision**: A write whose content matches the current latest apart from `takenAt` is skipped entirely — no latest rewrite, no history entry.
**Why**: History then holds 10 real layout changes rather than 10 consecutive safety passes, which is what a recovery reader wants.
**Rejected**: Rewriting the latest for freshness (churns history into uselessness). Accepted tradeoff: a quiet server's latest file carries a stale `takenAt`/mtime, so snapshot age reads as "age of the last layout change", not "age of the last check".
*Introduced by*: 260805-htmy-daemon-layout-snapshots-restore

### Storage under `$XDG_STATE_HOME`, uniform across platforms
**Decision**: `DefaultDir()` resolves through `internal/apphome` — `${XDG_STATE_HOME:-~/.local/state}/hexokit/snapshots` on every platform including macOS, dual-reading the legacy `run-kit` state home for one release. A legacy `$XDG_STATE_HOME/rk/snapshots` is moved into the resolved root once (best-effort `os.Rename` into an absent target, never a merge), leaving a `MOVED-to-run-kit` breadcrumb in the legacy dir.
**Why**: Recovery artifacts must not live in a cache dir, which is droppable by contract; Go offers no `UserStateDir`, and a uniform path keeps the `rk mux snapshot` docs single-shaped. The move preserves backups users may still need to restore from; a failed move degrades to cold-start behavior, never an error.
**Rejected**: A per-platform path (`~/Library/Application Support` on darwin) — two shapes to document for an artifact users mostly reach through the CLI; copying instead of renaming (duplicates backups, no atomicity); leaving the legacy dir in place (silent fork between two snapshot roots).
*Introduced by*: 260805-htmy-daemon-layout-snapshots-restore; state-root move 260823-li54-config-root-registry-core

### `RenumberWindow` as a distinct primitive from `MoveWindow`
**Decision**: Restore places a session's first window with `RenumberWindow` (`move-window -s <id> -t =session:<index>`), a primitive distinct from `MoveWindow`.
**Why**: `MoveWindow` is a reorder-among-existing-windows primitive built on adjacent swaps and no-ops when the target index is unoccupied — which is exactly the restore case (a fresh session with one window at the base index). The live round-trip integration test is what pins the distinction.
**Rejected**: Overloading `MoveWindow` with a renumber mode (two different semantics behind one name, with existing reorder callers to re-verify).
*Introduced by*: 260805-htmy-daemon-layout-snapshots-restore

### Shared `internal/fsatomic.WriteFile` for all file stores
**Decision**: One `internal/fsatomic` package provides `WriteFile(path, data, perm)` — temp file in the same directory, write, atomic rename, temp removed on any failure — and `internal/push`, `internal/remote`, and `internal/snapshot` all call it.
**Why**: Constitution §II keeps state in plain files rather than a database, which makes torn writes a real corruption vector, so every file store needs the same guarantee; three copies of it would drift. `perm` applies at file **creation** (`O_CREATE|O_EXCL`) so the process umask is respected exactly like `os.WriteFile`.
**Rejected**: A per-package private copy (n implementations to keep in sync); `os.CreateTemp` plus an explicit `Chmod` (chmod silently *widens* permissions on hardened-umask hosts, so a 0600 keypair could land wider than `os.WriteFile` would have produced).
*Introduced by*: 260805-htmy-daemon-layout-snapshots-restore

### Board membership is not restored
**Decision**: The hidden link-target sessions (`_rk-pin-*` pin-sessions, `_rk-iso-*` isolated relay sessions) and the `_rk-ctl` anchor are excluded from capture, so board pins and iso attach targets are not recreated by restore.
**Why**: Pinned/isolated windows come back through their home sessions (the capture keys each window to its non-hidden owner), board membership is re-derivable UI state, iso sessions are ephemeral by design (they reap themselves via `destroy-unattached` and are re-created on demand by the next isolated open), and the anchor is tmuxctl-owned and auto-recreated on the next dial.
**Rejected**: Capturing and replaying pin-session links (restores derived UI state at the cost of a link-recreation ordering problem on a fresh server). See [tmux-sessions](/run-kit/tmux-sessions.md) § Pin Sessions.
*Introduced by*: 260805-htmy-daemon-layout-snapshots-restore

### Restore stamps provenance unconditionally
**Decision**: `CreateSessionForRestore` stamps `@rk_srv_managed` on the server it births (the same `stampManagedOnBirth` seam as `CreateSession`); the snapshot capture set is not extended to carry a server's pre-death mark.
**Why**: the stamp records which conf actually applied at birth, and restore applies the managed conf — so an unconditional stamp is truthful by construction. Capturing and faithfully restoring the old mark would leave a restored external server unmarked forever with no recovery path (the option dies with its server), while rk's restore genuinely does apply the managed conf.
**Rejected**: extending the capture set with the pre-death mark (a stale fact restore would then re-lie with); skipping the stamp (strands restored servers as external despite running rk's conf).
*Introduced by*: 260826-lv87-external-server-provenance-adopt

### Restorable-offer derivation lives in `internal/snapshot`
**Decision**: The restorable-offer derivation is `Store.RestorableOffers(liveServers)` in `internal/snapshot`, taking the live-server list as an argument, not api-side logic.
**Why**: The store schema and tombstone semantics live there; the api handler stays a thin validate→derive→serialize shell, and the derivation is unit-testable with a temp-dir store and a fake server list.
**Rejected**: Deriving in the handler (couples offer semantics to HTTP; harder to test).
*Introduced by*: 260820-4psk-host-recovery-section

### Dismiss reuses tombstone semantics
**Decision**: Dismiss converts the live-latest to a tombstone stamped `auditedKill: true` (a thin `Tombstone(server, time.Now(), true)` wrapper), so it never re-qualifies as an offer.
**Why**: Audited tombstones are already never offered; the smallest semantic reuse guaranteeing no re-offer, introducing no new state class (Constitution II).
**Rejected**: A separate dismissed-list file (a new state class); deleting the snapshot (destroys the backup the user might still want via the CLI).
*Introduced by*: 260820-4psk-host-recovery-section

### Ephemeral read via an injectable snapshotter seam, not a ServerSource extension
**Decision**: `Snapshotter` gains an `ephemeralFunc func(ctx, server) (bool, error)` field (production: `tmux.IsEphemeralServer`), called only on due passes inside `snapshot()`; the `ServerSource` interface is untouched.
**Why**: Mirrors the existing `captureFunc` test seam exactly (the suite already injects fakes); keeps option semantics in `internal/tmux` where all tmux interaction lives; satisfies the cost constraint by construction — reads happen only where writes would (first observation, event-due, safety-due), never per tick. Supervisor/tmuxctl stay ignorant of the convention.
**Rejected**: Extending `ServerSource` with an ephemeral query implemented by `*tmuxctl.Supervisor` — the control-mode Client has no existing cheap option-query path, so it would drag option semantics and new plumbing into tmuxctl for no cost win; per-tick reads — a subprocess every 2s per server violates the cost constraint.
*Introduced by*: 260821-zelc-ephemeral-option-snapshot-reap

### Skipped pass advances bookkeeping
**Decision**: An ephemeral-skip pass reports success to the tick loop (bookkeeping `lastPass`/`writtenGen` advance), so a marked server is re-read only on generation movement or the safety cadence.
**Why**: Treating skip as failure would make the server due every tick — exactly the per-tick subprocess the cost constraint forbids. The safety cadence (60s) doubles as the un-mark detection bound.
**Rejected**: A separate ephemeral-state cache with its own refresh timer — more state for the same behavior the existing bookkeeping already provides.
*Introduced by*: 260821-zelc-ephemeral-option-snapshot-reap

### Note-pair capture ordering: new note single field, legacy note last
**Decision**: in `ListWindows`' format and `layoutWindowFormat` alike, `@rk_win_note` occupies a strict single field second-to-last and legacy `@rk_note` stays LAST with tail-rejoin (`strings.Join(parts[N:], listDelim)`); the parser prefers the new field and falls back to the rejoined legacy tail.
**Why**: two free-text fields cannot both enjoy tail-rejoin; legacy notes already in the wild keep their exact read path, while rk-written new notes are control-char-stripped at write time (`api/windows.go` note validation) so a single field is safe. Putting `@rk_win_note` last instead would regress legacy-note reads during the transition window.
**Rejected**: capturing the note pair via a separate `show-options` read — a second tmux call per capture for a transition-only concern.
*Introduced by*: 260828-3o5d-rk-option-scope-prefix-rename

### Dual-read carried in the list format, not a second call
**Decision**: legacy and new fields for the dual-read keys ride the same `list-windows` format line in both `ListWindows` and `layoutWindowFormat`; parsers pick new-then-legacy positionally. The note pair (`@rk_win_note`/`@rk_note`) rides both formats; the retired `@rk_win_url` additionally rides the `ListWindows` format as a `web_1` dual-read fallback (the one-release compat for the frontend's mid-session live-flip path), never swept.
**Why**: zero extra subprocess per read; capture and parse live in the same binary, so positional fields are unambiguous.
**Rejected**: a `show-options` dual-read per window — O(windows) extra tmux calls on every sidebar tick and every snapshot.
*Introduced by*: 260828-3o5d-rk-option-scope-prefix-rename

### Closed-ring read-compat via field-pair coalesce
**Decision**: `ClosedWindow` carries `LegacyChatProvider`/`LegacyChatRef` fields holding the previous-generation `chatProvider`/`chatRef` JSON keys; `LoadClosed` folds them into `AgentProvider`/`AgentRef` via `coalesceLegacy` (a present new key wins, legacy fields zeroed after coalesce), and the write path emits only the new `agentProvider`/`agentRef` keys.
**Why**: Cheap, and it preserves resume affordances across the upgrade — a record written with the legacy keys still answers "what agent session did this window carry".
**Rejected**: Dropping read-compat — constitution-permissible (the ring is a non-authoritative recovery artifact) but loses working resume affordances for no savings.
*Introduced by*: 260904-bf1l-agent-session-identity-rename

### `MOVED-to-run-kit` breadcrumb name kept
**Decision**: The one-time legacy-move breadcrumb written into `<state-root>/rk/` keeps the name `MOVED-to-run-kit` even though the resolved snapshot root now lives under the `hexokit` state home.
**Why**: It is an on-disk artifact name already written by prior releases; renaming the constant changes nothing a user can observe and buys no cleanup.
**Rejected**: Renaming to a hexokit-flavored breadcrumb — the constant would stop matching artifacts already on disk, for no gain.
*Introduced by*: 260926-qm4d-hexokit-home-migration
