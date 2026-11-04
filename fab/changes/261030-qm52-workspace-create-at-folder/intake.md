# Intake: Create a Workspace at a Folder

**Change**: 261030-qm52-workspace-create-at-folder
**Created**: 2026-10-30

## Origin

> I want to make it easier to 1) start a new server (Workspace), 2) start a new session (Group) 3) Start a new window (tab).

Conversational (`/fab-discuss` on 2026-10-30, design study `docs/wiki/create-flow-studies.html` §1 and §6). The user approved the study and chose four sequenced changes. This is **change 2 of 4**: it depends on `261030-g0gv-ui-rename-workspace-group-tab` for vocabulary, and `261030-6d2o-folder-first-new-sheet` uses its API.

## Why

Creating a workspace (tmux server) always starts it in the wrong place. `handleServerCreate` (`app/backend/api/servers.go:127`) hardcodes the first session:

```go
homeDir, err := os.UserHomeDir()
...
if err := s.tmux.CreateSession("0", homeDir, body.Name); err != nil {
```

So every new workspace lands on a group named `0` in `~`. To start real work the user has to create a second group at the right folder and kill `0`: three steps across two surfaces. The study ranked this as friction #1. The New sheet (change 3) can't offer "New workspace at <folder>" until the API accepts a folder.

Alternative rejected: creating the server and then a second session from the frontend and killing `0`. That's racy and leaves a visible junk group; the backend should create it right the first time.

## What Changes

### API: `POST /api/servers` accepts an optional folder

Request body gains `cwd` (optional, same semantics and validation as `POST /api/sessions`'s `cwd`):

```json
{ "name": "hexokit", "cwd": "~/code/sahil87/hexokit" }
```

Handler behavior:

1. Validate `name` with `validate.ValidateServerName` (unchanged).
2. If `cwd` is present and non-empty: validate it exactly as `handleSessionCreate` does (`api/sessions.go`): `validate.ValidatePath(body.CWD, "Working directory")`, then `validate.ExpandTilde`, plus whatever existence check that handler does. Reuse it; don't duplicate it. If the two handlers would otherwise copy the logic, extract a shared helper.
3. **First group name**: if `cwd` is given, derive it from the folder basename using the backend's safe-session-name rule (the Go equivalent of the frontend's `deriveNameFromPath` → `toSafeSessionName`; reuse an existing helper if one exists in `internal/validate` or `internal/tmux`, otherwise add one with tests). An empty derivation (`/`, `~`) falls back to `main`. If `cwd` is absent, keep the current behavior: `"0"` at `$HOME`. That keeps `rk`/MCP and other existing callers byte-identical.
4. `s.tmux.CreateSession(firstGroup, resolvedCwd, body.Name)`.
5. The response stays `201 {"ok": true}`, optionally plus `"group": "<firstGroup>"` so the frontend can navigate without guessing.

All process execution keeps going through the existing tmux package (`exec.CommandContext`, argument slices). This change adds no new subprocess paths (Constitution I).

### Frontend

- `createServer(name, cwd?)` in `app/frontend/src/api/client.ts` sends `cwd` when provided.
- The existing create-workspace dialog (`components/server-dialogs.tsx`, the single `ServerDialogs` mount, and the host page's create dialog in `host-overview-page.tsx`) gains an **optional folder field** with the same quick-picks and `getDirectories` autocomplete as `create-session-dialog.tsx` (extract the folder-input piece into a reusable component if that's cleaner, because change 3 reuses it too). Prefill: the active tab's `worktreePath` when there is one, otherwise empty.
- **Name prefill from folder**: when the name field is untouched and a folder is chosen, prefill the name from the folder basename (`deriveNameFromPath` → `toSafeServerName`). Typing in the name field stops the prefill from tracking.
- After creation, the existing pending-marker → waiting → view lifecycle (`markServerPending`, `refreshServers`) is unchanged; the landing tab is the new workspace's only window.

### Tests

- Go: `api/servers_test.go` cases for cwd absent (`"0"` at home, unchanged), cwd present (folder-named group at the expanded path), an invalid cwd (400 with the session handler's message), and a folder whose basename derives to empty (→ `main`).
- Vitest: the dialog sends `cwd`; the name prefill follows the folder until edited.
- e2e: create a workspace with a folder → the sidebar shows a group named after the folder, not `0`.

### PR evidence

`just demo` showing the create-workspace dialog with a folder chosen and the resulting sidebar (desktop and mobile). `--before` shows the old `0` group.

## Affected Memory

- `run-kit/api-and-sockets`: (modify) `POST /api/servers` body gains `cwd`; first-group naming rule
- `run-kit/tmux-sessions`: (modify) server-birth session: folder-named group at `cwd`, `"0"`/`$HOME` only when `cwd` is absent
- `run-kit/ui/dialogs-and-state`: (modify) create-workspace dialog folder field and name prefill
- `run-kit/ui/routes-and-shell`: (modify) host page create dialog

## Impact

Backend: `api/servers.go` (+ tests), possibly a shared cwd-validation/name-derivation helper. Frontend: `api/client.ts`, `server-dialogs.tsx`, `host-overview-page.tsx`, maybe a new reusable folder-input component. CLI/MCP unchanged (cwd is optional; absent ⇒ legacy behavior).

## Open Questions

- Should `rk mux new` / MCP `new_server` gain a `--cwd` too? Out of scope; the legacy default is kept for them.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `cwd` is optional; absent ⇒ legacy `"0"` at `$HOME` | Keeps every existing caller byte-identical; additive API | S:80 R:90 A:90 D:85 |
| 2 | Confident | First group is named after the folder basename; empty derivation ⇒ `main` | Mirrors instant session naming (`deriveNameFromPath`); study §4 "new workspace + group + tab at the folder" | S:75 R:85 A:75 D:65 |
| 3 | Confident | Reuse the session handler's cwd validation (ValidatePath + ExpandTilde) | Same input class; one validation path (Constitution I) | S:70 R:90 A:85 D:85 |
| 4 | Confident | The existing create dialogs gain an optional folder field now; the New sheet (change 3) takes over later | Ships value independently of change 3 | S:65 R:85 A:70 D:70 |
| 5 | Tentative | The response adds `"group": "<name>"` | Convenience for navigation; harmless if unused <!-- assumed: response gains group field --> | S:40 R:90 A:55 D:55 |
| 6 | Confident | The workspace name is prefilled from the folder until the user types | Same save-as prefill model as `SessionNamePrompt` | S:60 R:95 A:75 D:70 |

6 assumptions (1 certain, 4 confident, 1 tentative, 0 unresolved).
