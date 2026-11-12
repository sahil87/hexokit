# Intake: Operator Tasks Reads rk Operator State, Shows Notes

**Change**: 261111-0982-operator-tasks-rk-state-notes
**Created**: 2026-11-11

## Origin

> Plan step R3 (Drawer + sessions payload read rk's own operator state; notes in Tasks) from the plan at /home/sahil/code/sahil87/hexokit.worktrees/arcing-fjord/fab/plans/sahil/26-11-10-operator-to-hexokit.md — read that file (Rules, Decisions, and that step's brief) first. R1 (the operator state engine in internal/operator/) is merged on main; build on it. Do not touch or restart the live rk daemon or installed binaries.

Interaction: `/fab-new` with a plan pointer, plus two questions answered by the user during intake (see Assumptions #4 and #5).

The plan's R3 brief, verbatim:

> ### R3 — Drawer and sessions payload (run-kit)
> - `watchlist.go` / `sessions.OperatorTracked` read rk's own state file; fall back to fab's file
>   while no rk state exists (pre-C1).
> - Operator Tasks rows show the latest note (with expand to all notes).
> - No new tab (Principle IV).

Plan decisions that bind this step (from "Decisions already taken — do not reopen"):
- **Memory = notes** on tracked items: one append-only list per item. No separate "directive" / "last outcome" fields.
- **UI**: no new tab. Runs show up in Cron Log (R5) and in item notes (Operator Tasks tab — this step).
- Plan Rule 1: the live operator keeps running on the **installed** fab and rk binaries until step C1. This change MUST NOT `brew upgrade`, `fab sync`, or restart the rk daemon on the live server. Verification uses throwaway rigs only (`just` recipes), per the constitution's PR Evidence rule.
- `rk operator adopt` is explicit (R1). There is **no automatic adopt on read**. This step reads rk's file when it exists and never creates, converts, or writes either file.

## Why

1. **Problem.** R1 (merged, `app/backend/internal/operator/`) made rk the owner of the operator's tracked-item ledger at `$XDG_STATE_HOME/hexokit/operator/<slug>.yaml`, with per-item **notes** (`{at, by: user|run|chat, text}`, capped at `NoteCap = 50` per item and `NoteTextCap = 1000` runes per note) as the operator's memory. But every display surface still reads **fab's** file. `internal/cron/watchlist.go` (`ReadOperatorState` over `cron.FabOperatorStatePath`) feeds `sessions.FetchSessions`, which builds three things: the pane-keyed watchlist join (`WindowInfo.Monitored*`), the staleness facts (`OperatorLastTickAt` / `OperatorStale`), and `ProjectSession.OperatorTracked`, which the drawer's **Operator Tasks** segment renders. The memory file `docs/memory/run-kit/operator-state.md` states it outright: "Nothing in the daemon, the sessions payload, or the cron watchlist reads this file yet."
2. **Consequence if not done.** After cutover (C1: `rk operator adopt` + the new loop), the operator writes only rk's file. Operator Tasks would keep showing fab's frozen file or nothing. The notes, which the plan makes the operator's whole memory ("what you asked for and what the operator did live on the item"), would appear nowhere in the UI. C1's step 2 ("`rk operator adopt` → compare Operator Tasks before/after (same items, same notes)") depends on this step.
3. **Why this approach.** The plan fixes it: read rk's file, fall back to fab's file only while no rk state exists, and show notes in the existing Operator Tasks rows with no new tab (Constitution IV). The fallback lets this change ship and be released **before** C1 without changing anything on a live server. No server has an rk operator file until someone runs `rk operator adopt` or `rk operator track add`, so live drawers keep reading fab's file exactly as they do today.

## What Changes

### 1. Source selection: rk's file first, fab's file as the pre-C1 fallback (backend)

`sessions.FetchSessions` (`app/backend/internal/sessions/sessions.go`, the operator-watchlist block around lines 856–886) currently resolves one path, `cron.FabOperatorStatePath(cron.FabOperatorSlug(socketPath))`. It changes to a two-candidate resolution, still **one read per fetch**:

```
slug := cron.FabOperatorSlug(socketPath)   // "default" when the socket-path query fails (unchanged)
rkPath  := <apphome.StateDir()>/operator/<slug>.yaml      // == operator.StatePath(socketPath)
fabPath := cron.FabOperatorStatePath(slug)                // unchanged

if rkPath exists (os.Stat succeeds, regardless of content):
    source = rk  → read rkPath tolerantly
else:
    source = fab → read fabPath tolerantly (today's behavior, byte-for-byte)
```

Rules:
- **Existence is the switch.** "rk state exists" means the rk file exists on disk. An rk file that exists but tracks nothing (`tracked: []`, or an empty file) is still the source. It yields `operatorTracked: []`, not fab's list. After adopt or the first `rk operator track add`, rk is authoritative, and showing fab's stale list would misreport.
- **A corrupt rk file does not fall back.** It degrades like a corrupt fab file does today: `OperatorTracked = nil` (key omitted), no watchlist join, tick 0. Falling back to fab's file post-C1 would show a frozen ledger as if it were live. The daemon logs nothing new for this (today's tolerant-read posture is silent).
- **Path resolution must not import-cycle.** `internal/operator` imports `internal/cron` (for `FabOperatorSlug`). So `internal/cron` must NOT import `internal/operator`. `internal/sessions` may import either. Preferred shape: `sessions` calls `operator.StatePath(sock)`, or a small pure resolver that computes the same `<StateDir>/operator/<slug>.yaml`, and passes the chosen path to the tolerant reader. The test for the resolver pins `rkPath == operator.StatePath(sock)` so the two cannot drift.
- **Read-only.** Neither file is ever created, locked, converted, or written by the read path. There is no auto-adopt (plan + R1).
- **socketPathFn seam unchanged.** A failed `#{socket_path}` query still degrades to slug `"default"` for **both** candidates.

### 2. The tolerant reader learns rk's schema (backend, `internal/cron/watchlist.go`)

rk's schema is fab's ported `tracked:` list (same keys: `id, kind, scope{pane, repo, session, stage, agent, branch, refs, change, …}, paused, done_at, added_at, updated_at`). The existing `ParseOperatorState` → `parseTrackedItems` therefore already reads rk's file. The deltas:

- **Notes.** Parse each item's `notes:` list tolerantly into `TrackedItem.Notes []Note` (`Note{At int64 /* unix seconds via parseTickAt */, By string, Text string}`), in file order (oldest first, since R1 appends). A non-map element or an empty `text` is skipped. The reader enforces no cap of its own (R1's writer caps at 50).
- **fab's `text` → a note.** For a fab-sourced `note`-kind item carrying `text`, the reader synthesizes one note `{at: updated_at || added_at, by: "user", text}` when the item has no `notes:` list. This mirrors `operator.convertItem` in `adopt.go`, so the drawer shows the same note before and after adopt. That is C1's acceptance check: "same items, same notes". `TrackedItem.Text` stays parsed but is no longer projected to the wire (see §3).
- **Kind.** rk's pane kind is `pane` (fab's is `fab-change`). Kind is display-only and never a filter (the existing rule). Both values pass through verbatim. The frontend kind chip shows whatever the file says.
- **`last_tick_at`.** Still read from the chosen file's top-level `last_tick_at` (tolerant: an absent key gives 0, which is never stale). rk's file has no such key today. R1 preserves unknown top-level keys, and R5 (the loop) decides whether to stamp one. This step does not invent a tick for the rk source, so a server whose source is rk shows no staleness banner until R5 writes one.
- Rename and doc the header comment: the reader now serves **two** files (rk-owned, the primary source; fab-owned, the pre-C1 fallback). "rk NEVER writes this file" still holds for fab's file. rk's file is written only by `internal/operator`, never by this reader.
- The legacy `monitored:` arm and the `tracked`-wins-by-key-presence rule are unchanged. They apply only to the fab fallback in practice.

### 3. Sessions payload: latest note + count, no full list (backend, `internal/sessions/sessions.go`, `app/frontend/src/types.ts`)

`OperatorTrackedItem` (stamped on **every** session of a server, so its size multiplies by session count) gains:

```go
type OperatorTrackedItem struct {
    // …existing fields…
    LatestNote *OperatorNote `json:"latestNote,omitempty"` // the newest note; nil when the item has none
    NoteCount  int           `json:"noteCount,omitempty"`  // total notes on the item (0 omitted)
}

type OperatorNote struct {
    At   int64  `json:"at"`   // unix seconds
    By   string `json:"by"`   // user | run | chat
    Text string `json:"text"`
}
```

- `text` is **removed** from the wire projection. The fab-sourced note text now arrives as `latestNote` (§2). The frontend `OperatorTrackedItem.text` field and its render path are replaced by `latestNote`. Frontend and backend ship together in one binary (embedded SPA), so no older-backend compatibility shim is kept for `text`. The existing "older backend: no `operatorTracked` at all → monitored-derived rows" fallback stays.
- The full notes list is **never** in the sessions payload (user decision, Assumption #4). The SSE hub dedups the sessions JSON, and a `latestNote` changes only when a note is appended, so dedup still holds.

### 4. New read-only route: all notes for one item (backend, `app/backend/api/`)

```
GET /api/operator/notes?server=<slug>&id=<item-id>
→ 200 {"id": "<item-id>", "notes": [{"at": 1762850000, "by": "run", "text": "…"}, …]}   // oldest → newest, file order
→ 404 {"error": "…"} when no item with that id exists in the chosen source (or no source file exists)
→ 400 when id is missing/empty
```

- Same source selection as §1 (rk if its file exists, else fab), via the same resolver, so the route and the payload cannot disagree on source.
- `server` resolves through the existing `serverFromRequest(r)` helper (`api/router.go:469`), as `GET /api/cron?server=` does. The socket-path query uses the bounded `tmux.SocketPath` (argv slice + timeout, Constitution I / Process Execution).
- GET only (Constitution IX: reads are GET). No mutation route. Notes are written through `rk operator track note` (R1) and, later, by runs and chat. The UI stays read-only, matching the existing table doc ("Read-only by design: the watchlist is derived, edits are … verbs").
- Register it in `api/router.go` beside `/api/cron`. Document it in `docs/specs/api.md` and memory `api-and-sockets.md`.
- `id` is matched by exact string equality against the parsed items. It is never used to build a path, so there is no traversal surface.

### 5. Operator Tasks rows: latest note, expand to all notes (frontend)

Files: `app/frontend/src/components/watched-table.tsx` (the `note` column, `NoteCell`, `WorkerNoteCell`), `app/frontend/src/types.ts`, plus a small fetch helper in the existing api client module (follow the `GET /api/cron` client pattern).

- **Item rows** (pane-less or dead-pane): the note cell shows `latestNote.text` truncated, with an age/author suffix (` · run · 5m ago`, age computed at render from `nowSeconds` like the rest of the table) and a `+N` hint when `noteCount > 1`. Clicking or pressing Enter/Space on it (the existing native-button `tracked-item-expand` toggle, which stays keyboard-reachable per Constitution V) expands in place. On expand it fetches `GET /api/operator/notes` and renders all notes oldest→newest, each as `at · by · text` with whitespace preserved. While loading, the cell shows the latest note plus a quiet "loading…". On fetch failure it falls back to the latest note plus a quiet "notes unavailable". Collapse returns to the one-line view. Expanded state stays cell-local (the row stays stateless, as today). The fetched list is not cached across collapses. A re-expand refetches, so a new run's note appears.
- **Worker rows** (item on a live window): the note column shows the **item's latest note** when `latestNote` is present, with the same expand-to-all behavior. Otherwise it falls back to today's `WorkerNoteCell` (the window's `@rk_win_note` tab note with its age and the 24h stale dimming) (user decision, Assumption #5). The `opacity-50` stale-dim `className` applies only when the tab-note fallback is what renders.
- **Sort.** The `note` column's `sortValue` uses the rendered text (item latest note, else tab note for worker rows).
- **Mounts.** Both mounts of `WatchedTable` get this: the desktop drawer's Operator Tasks (`dense`, `watched-dense`) and the mobile operator route's `?tab=tasks` / Server page WATCHED zone (non-dense, `watched`). The Server page WATCHED zone renders `watchedWorkerRows` (window-derived, no `item.latestNote`), so it keeps showing tab notes unchanged.
- **Command palette (Constitution V).** Expanding a note is a per-row cell toggle, like today's `tracked-item-expand`. It is not a new global action, so no palette entry is added (the current expand toggle has none). Do not add a tab or segment.
- Update the `watched-table.tsx` and `watched-tasks.tsx` header comments ("truncated text with expand-in-place toggle" → latest note + expand to all notes; source is rk's file with the fab fallback).

### 6. Tests

- **Go, `internal/cron/watchlist_test.go`**: rk-shaped fixture (kind `pane`, notes list with mixed authors, RFC3339 `at`) parses into `Notes` in order. A malformed note element is skipped. A fab `note` item with `text` and no `notes` synthesizes one `by: user` note at `updated_at`/`added_at`. `kind: pane` items with a pane enter `WatchlistEntries`.
- **Go, `internal/sessions`**: the source-selection resolver, with table cases: rk exists → rk; rk absent + fab present → fab; both absent → nil; rk present-but-empty → `[]` (not fab's list); rk corrupt → nil (no fall back). Also `rkPath == operator.StatePath(sock)`. Plus `projectTrackedItems` → `latestNote`/`noteCount` (newest note, count, nil when none, `text` not projected). Use `t.TempDir()` + `XDG_STATE_HOME` via `t.Setenv`. Never the real state home.
- **Go, `api/`**: `GET /api/operator/notes` returns 200 with ordered notes, 404 for unknown id or no file, 400 for missing id, and follows the rk-first source rule.
- **Frontend unit (`watched-table` / `watched-tasks` / `server-watched-zone/model` tests)**: item row shows the latest note + `+N`. Expand fetches and lists all notes (mock fetch). Fetch failure falls back. Worker row with `latestNote` shows it. Worker row without one shows the tab note with stale dimming. The `text`-field render path is gone.
- **Playwright e2e**: one test proving the Operator Tasks row shows the latest note and expands to all notes, with the mandatory JSDoc `Proves:`/`Steps:` intent comment (Constitution: Test Intent Comments), using the existing e2e fixtures/stubs for the sessions payload and the new route.
- **PR evidence** (Constitution: PR Evidence): Before/After screenshots of the Operator Tasks segment (desktop drawer + mobile `?tab=tasks`) and a short `just demo` recording of expand-to-all-notes, all against a **throwaway rig** with a seeded rk operator state file under the rig's own `XDG_STATE_HOME`. Never the live `rk serve` or the user's tmux server (plan Rule 1).

## Affected Memory

- `run-kit/cron`: (modify) Watchlist reader + External Contracts. The reader now serves rk's state file as the primary source with fab's file as the pre-C1 fallback (existence switch, corrupt-rk-no-fallback). It parses per-item notes and synthesizes a note from fab's `text`. Staleness reads the chosen file's `last_tick_at`.
- `run-kit/operator-state`: (modify) Drop "nothing in the daemon, the sessions payload, or the cron watchlist reads this file yet". The sessions payload/watchlist and `GET /api/operator/notes` now read it (read-only, never auto-adopt).
- `run-kit/ui/quake-terminal`: (modify) Operator Tasks rows show the item's latest note with expand-to-all-notes. Worker rows prefer the item note over the tab note.
- `run-kit/api-and-sockets`: (modify) New `GET /api/operator/notes` route. `operatorTracked[]` gains `latestNote`/`noteCount` and drops `text`.
- `run-kit/tmux-sessions`: (modify) The watchlist-tier paragraph names the rk-first / fab-fallback source.

## Impact

- **Backend**: `app/backend/internal/cron/watchlist.go` (+ test), `app/backend/internal/sessions/sessions.go` (+ test), new resolver (in `sessions`, or a tiny helper with no `cron → operator` import), `app/backend/api/router.go` + a new handler file (e.g. `api/operator_notes.go`) + test.
- **Frontend**: `app/frontend/src/types.ts`, `app/frontend/src/components/watched-table.tsx`, `app/frontend/src/components/watched-tasks.tsx` (comment), the api client module, the unit tests beside them, and one e2e spec under `app/frontend/tests/e2e/`.
- **Specs**: `docs/specs/api.md` (new route + payload fields), `docs/specs/cron.md` (the operator watchlist seam names rk's file as primary).
- **Not touched**: `internal/operator` writer semantics (R1), the cron evaluator/tick (the watchlist never gates a fire), `rk operator adopt`, fab-kit, the live daemon and installed binaries.
- **Rollout safety**: on every existing server no rk operator file exists, so behavior is identical to today except that fab note items now render through `latestNote` (same text). That makes the change safe to release ahead of C1.

## Open Questions

- None blocking. R5 decides whether the loop stamps a `last_tick_at` (or another liveness fact) into rk's file. Until then an rk-sourced server shows no staleness banner. That is deliberate, and Assumption #7 records it.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Read rk's state file first; fall back to fab's file only while no rk state exists; never auto-adopt or write either file | Plan R3 brief + R1 "no automatic adopt on read" + plan Rule 1 | S:95 R:85 A:95 D:90 |
| 2 | Certain | No new tab or segment; notes render inside the existing Operator Tasks rows | Plan Decisions (UI) + Constitution IV | S:95 R:80 A:95 D:95 |
| 3 | Confident | "rk state exists" = the rk file exists on disk. Present-but-empty is authoritative (`[]`). A corrupt rk file degrades to nil without falling back to fab | Post-adopt rk is the ledger, so showing fab's frozen list would misreport. Mirrors today's corrupt-file degrade | S:60 R:80 A:70 D:65 |
| 4 | Certain | Payload carries only `latestNote` + `noteCount`. All notes come from a new read-only `GET /api/operator/notes?server=&id=` | Asked — user chose "Latest + on-demand" over all-notes-in-payload and last-N | S:95 R:75 A:90 D:90 |
| 5 | Certain | Worker rows show the item's latest note when present, else today's `@rk_win_note` tab note (with its stale dimming) | Asked — user chose "Item note, fall back" | S:95 R:85 A:90 D:90 |
| 6 | Confident | Extend the existing tolerant `cron.ParseOperatorState` (rk's schema is fab's ported `tracked:` list) instead of reading through `operator.Load`. Path resolution lives in `sessions` to avoid a `cron → operator` import cycle | Display reads stay tolerant (watchlist contract). `operator` already imports `cron` | S:55 R:85 A:80 D:70 |
| 7 | Confident | Staleness reads the chosen file's `last_tick_at`. rk's file has none until R5, so rk-sourced servers show no banner meanwhile | R5 owns the loop's liveness fact. Inventing one here would pre-empt R5 | S:50 R:85 A:70 D:65 |
| 8 | Confident | A fab `note` item's `text` becomes a synthesized `{at: updated_at‖added_at, by: user}` note. `text` drops off the wire | Mirrors `operator.convertItem`, so the drawer shows the same notes before and after adopt (C1 acceptance). Frontend and backend ship as one binary | S:60 R:80 A:80 D:70 |
| 9 | Confident | Expanded notes are fetched on each expand (no cross-collapse cache). Fetch failure falls back to the latest note with a quiet "notes unavailable" | Keeps the table stateless and clock-free. A re-expand sees new run notes | S:50 R:90 A:75 D:70 |
| 10 | Confident | No command-palette entry for the per-row note expand | It is a cell toggle like today's `tracked-item-expand` (no palette entry), not a global action. Constitution V covers user-facing actions | S:50 R:90 A:65 D:65 |

10 assumptions (5 certain, 5 confident, 0 tentative, 0 unresolved).
