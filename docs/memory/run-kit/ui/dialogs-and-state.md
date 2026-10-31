---
description: "Component conventions; modal dialogs and popup surfaces, incl. the folder-first New sheet and shared create hooks, and the Settings dialog's Agents tab (the spring-loaded marker pad, the GUI off-/restart-confirms on one shared shell with the gui.enabled off-interception); the overlay-presence registry (modal + click-opened-menu transient counts — the hide signal for unpaintable surfaces) and status-bar toasts; clipboard and e2e host-state rules; the Zustand window store, optimistic mutation feedback, recently-closed mirror."
type: memory
---
# run-kit UI — Dialogs & Client State

## Component Conventions

- **All components are client-side** — pure React SPA, no Server Components. Data fetched via typed API client (`app/frontend/src/api/client.ts`) and SSE context
- **No loading spinners** — SSE keeps data fresh, the view renders with whatever data is available
- **Data fetching via context** — `SessionProvider` at layout level owns the `EventSource` connection and provides session data via `useSessions()` hook
- **SSE via `useSessions` hook** — thin wrapper over `SessionProvider` context. Single `EventSource` at layout level. SSE handler diffs incoming `e.data` JSON string against a `useRef<string>` before parsing — if identical, skips `setSessions()` entirely (eliminates ~90% of redundant re-renders). When data has changed, `setSessions()` is wrapped in `startTransition()` to keep user input responsive. Auto-reconnects via `EventSource` built-in. Server-side SSE uses a module-level goroutine hub that deduplicates polling across browser tabs
- **ChromeProvider context** (`app/frontend/src/contexts/chrome-context.tsx`) — split into state/dispatch contexts. Three hooks: `useChromeState()` (state only), `useChromeDispatch()` (dispatch only), `useChrome()` (convenience alias for both). Components that only read state (e.g., `AppShell`) use `useChromeState()` to avoid subscribing to dispatch identity changes. Manages current session:window selection, sidebar open/collapsed state, drawer state (mobile), `isConnected`, `fixedWidth`, and `terminalFontSize` (the effective global terminal font preference — see § Terminal Font Size). Chrome derives content from the selection — no slot injection
- **SessionProvider context** (`app/frontend/src/contexts/session-context.tsx`) — layout-level provider owning the single `EventSource`. Session data consumed via `useSessions()` hook. Connection status forwarded to ChromeProvider internally.
- **Shared `Dialog` component** (`app/frontend/src/components/dialog.tsx`) — reusable modal with title, backdrop, close-on-click, and an optional `size` width variant (§ Settings Dialog → Dialog width variant). Used for create, kill, **session**-rename, and settings dialogs. Window rename is the centered `WindowHeading`'s inline edit, not a dialog (§ Window Heading). (260724-6j1v)
- **Dialog control conventions** — every dialog button composes the Control primitive's `wide` variant via `controlClass` (28px fine / 40px coarse floors — the `--ctl-h-bar`/`--ctl-h-bar-coarse` lockstep) and every dialog text input carries `INPUT_COARSE` (40px coarse min-height; fine sizes unchanged) plus `INPUT_FOCUS` (the one live-input focus treatment, `outline-none focus:border-accent-green`) from `components/controls.ts` ([visual-design](/run-kit/ui/visual-design.md) § Global Control-State Rules → Dialog and input constants). Destructive confirms compose the primitive's `confirm` variant pair — the neutral arm (cancel/safe) / the `danger` arm (the destructive arm on the `signal-red` token) — consumed by the sidebar kill dialog (`sidebar/kill-dialog.tsx`), the board kill trio (`board/board-page.tsx` — "Unpin instead"/"Cancel" neutral, "Kill" danger), and the server dialogs (`server-dialogs.tsx` — kill, force-kill, adopt); call sites add only layout (`flex-1`/`w-full`). Dialog/panel button disabled states follow the primitive's unified `disabled` recipe (`opacity-40` + `cursor-not-allowed` + hover neutralized back to the rest arm). `window-note-prompt.tsx`'s submit disables only while a submit is in flight — an empty submit is a valid note-clear, so emptiness never disables (unlike its `session-name-prompt.tsx` twin, whose collision/empty guards block submit). (260906-3i9e)

### Clipboard Utility

`app/frontend/src/lib/clipboard.ts` — shared `copyToClipboard(text: string): Promise<boolean>` function. Primary path uses `navigator.clipboard.writeText()`; fallback uses `document.execCommand('copy')` for non-secure contexts (HTTP). All callers (terminal copy, Pane panel row copy, status-bar copy segments, the `Copy:` palette entries) import from this module (§ Steady-state version surfaces for the boolean success signal). The keyed click-to-copy interaction on register surfaces — selection guard, clipboard call, one 1s `copied ✓` feedback slot per surface — lives once in `hooks/use-copy-feedback.ts` (`useCopyFeedback`), consumed by the Pane panel rows and the status-bar segments/menu rows ([status-signals](/run-kit/ui/status-signals.md) § Status Bar). (3m72)

CWD display (the Pane panel's `cwd` row) renders the active pane's `cwd` (falls back to `worktreePath`) basename-first over two spans (`status-panel.tsx`):
- Home substitution only: `abbreviateHomePath()` maps `/home/<user>/…` → `~/…` (Linux/macOS/`/root` conventions; exact home dir → `~`). No tail truncation — the old `shortenPath()` `…/<second-to-last>/<last>` rule is gone.
- Basename-first split: the abbreviated path splits at its last `/`; the basename span holds `shrink-0` (never clips) while the parent span yields (head-truncates via `dir="rtl"` + `<bdi dir="ltr">`). A root-level or single-segment path renders whole as the basename with no parent span.
- The row's `title` attribute and copy value always carry the original unmodified `activePaneCwd` — hover or copy for the full path. A deleted-on-disk cwd (`cwdMissing`) recolors both spans red and appends a ` (deleted)` tag.
- The status bar's `cwd` segment renders only the basename (`cwdFull.split("/")` last segment), full path as its copy value.

### E2E host-global filesystem state (`~/.config/hexokit/config.yaml` snapshot/restore)

`scripts/test-e2e.sh` isolates the **tmux server** (a per-worktree derived socket family, `rk-test-e2e-<token>-*`), the **ports** (a derived per-worktree triple in the 21000–21299 rig block), and **`$XDG_STATE_HOME`** (a per-run temp dir), but NOT `$HOME` — so any e2e that exercises a feature persisting under `$HOME` (settings, VAPID keys, push subscriptions) POSTs against the **developer's REAL host file**. `board-list-reorder.spec.ts` therefore snapshots the developer's `~/.config/hexokit/config.yaml` and restores it around the suite so a curated board order (or any other setting) is never clobbered by test residue:

- **`beforeAll`** raw-byte-reads `config.yaml` (`readFileSync(path, "utf8")`). Absent detection is **ENOENT-only**: a `code === "ENOENT"` read error means "no file to restore" (afterAll then deletes any residue); ANY other read error (EACCES/EIO — the file EXISTS but couldn't be snapshotted) is **rethrown**, so afterAll never `rmSync`-deletes real settings on a failed snapshot.
- **`afterAll`** (always runs, even on test failure) restores VERBATIM: write the original bytes back if the file existed, else `rmSync({ force: true })` to delete residue — a byte-identical round-trip. Teardown errors are swallowed so they never mask a test failure.

This is the general pattern for **any** host-global filesystem state an e2e touches: explicit save/restore in the spec, because the harness scopes tmux, ports, and `$XDG_STATE_HOME` but not `$HOME`. The spec file's header intent comment documents the save/restore (per the constitution's Test Intent Comments rule).

## Session Name Prompt

`app/frontend/src/components/session-name-prompt.tsx` — the save-as-style prompt behind the `Group: Create` palette action and the `create-session` chord (which resolves through the same palette body): a single name input on the shared `Dialog` shell (`size="sm"`), pre-filled with the auto-derived session name and select-all'd so Enter accepts the default and typing replaces it. Live `toSafeSessionName` conversion, `finalizeSafeName` at submit, inline collision hint blocking submit, empty-submit no-op; Escape/backdrop close via the shell's focus trap. It is the one session-creation surface with a name field — path picking is the New sheet's job (below) — and submits through the existing `executeCreateSessionInstant` optimistic path in `app.tsx` (its open state folds into `dialogOpenRef`). Behavior contract: [routes-and-shell](/run-kit/ui/routes-and-shell.md) § Prompted Creation. (260823-qe3n)

## New Sheet

`app/frontend/src/components/new-sheet.tsx` — the folder-first **New** sheet: one flow that creates a **Tab**, a **Group**, or a **Workspace** at a chosen folder. It replaces the window-only `Tab: Create at Folder` dialog; there is no other create-at-folder surface. It mounts only while open (state resets on close) on the shared `Dialog` shell with `size="sheet"` (§ Dialog width variant), is lazy + `Suspense`-wrapped, and is **presentational**: it takes `initialLevel`, `availableLevels`, `server`, `group`, `sessions`, `workspaceNames`, `contextFolder`/`contextBranch`/`contextMeta`, and reports `onSubmit({level, folder, name})`; the host owns the create actions. Pure logic (level order/labels, `cycleLevel`, `buildFolderSections`, `isListMatch`, `deriveSheetName`, `previewFor`, `countTabsByFolder`, `resolveContextTarget`) lives in `lib/new-sheet.ts`.

**Opener seam and host.** `contexts/new-sheet-context.tsx` (`NewSheetProvider`, mounted in `AppLayout` like `server-dialogs-context`) exposes referentially stable `openNewSheet({level, server?, group?})` / `closeNewSheet` plus `newSheetRequest` / `newSheetOpen`. The level always comes from the opener (no per-opener memory); the optional `server`/`group` pin the target when the caller knows it. The ONE mount is `NewSheetHost` (`components/new-sheet-host.tsx`, rendered in `AppLayout`): it resolves the target workspace, group, and context window from `SessionContext` plus the route (`useRouteWindowId`, the shared route-window reader) with `resolveContextTarget` — precedence: the request's `group` (its active tab) → the tab being viewed → the tab last viewed in this workspace (`readLastWindow`) → the first group's active tab. The target is **snapshotted per request** (a ref keyed by the request object) so SSE ticks never move the field's prefill. `availableLevels` drops levels with no target: Tab needs a resolved group, Group needs a workspace, Workspace is always available — on the host page (no workspace) the sheet falls back to Workspace level. `newSheetOpen` folds into AppShell's modal-gating predicate.

**Layout, top to bottom**:
1. **Level switch** — `Control variant="segment"` buttons (`aria-pressed`) `Tab` · `Group` · `Workspace`, unavailable levels disabled. Tab and Group buttons carry the platform's effective chord keycap via `chordHintFor` (`create-window`, `create-session`; none when unbound, e.g. Group on mac); Workspace has none. Switching level clears any name override.
2. **Folder field** — `role="combobox"` input prefilled with the context folder (`~`-abbreviated), focused with its text selected; empty on the host page. `aria-expanded` tracks whether a list is showing and `aria-activedescendant` the selected row.
3. **Folder list** (`role="listbox"`, grouped, uppercase section headers) — **Current** (the context folder, branch chip, meta `active tab` only when the folder is really an active tab's, else `last tab` / `first group`), **Worktrees · <repo>** (from `GET /api/worktrees` — [api-and-sockets](/run-kit/api-and-sockets.md) — branch chip, `detached` for an empty branch, `N tabs open`), **Open elsewhere** (`tabFolders(sessions)` — every tab folder across the workspace's groups, `projectRoots` widened past each group's first tab — minus rows already listed). A folder repeated across sources lists once, in the first section that has it. A non-repo context folder simply omits the Worktrees section. When the field holds text that is not an exact list match (`isListMatch`), the list is replaced by debounced `getDirectories` autocomplete rows (`useDirectorySuggestions`); after an autocomplete pick the empty state reads `Enter creates at this folder` instead of `No matching folders`.
4. **Preview** (`role="status"`, `bg-inset` box) — exactly what Create will do, with a mini tree marking new nodes green: `New tab in <ws> › <group> at <folder>` / `New group <name> in <ws>, first tab at <folder>` / `New workspace <name> (tmux -L <name>), first group and tab at <folder>`. A blank folder reads `the default folder`.
5. **Name override** (Group and Workspace only; Tab stays unnamed so tmux auto-names it to the folder basename) — a name input prefilled with the derived name and select-all'd, with the live per-kind transform (`toSafeSessionName` / `toSafeServerName`) and `finalizeSafeName` at submit.
6. **Footer** — hints `⇥ level` · `↑↓ folder` (desktop), a **`Name it…`** button (Group/Workspace, hidden while the override is open; visible on mobile, with the platform chord keycap `formatCombo({code:"Enter", tier:"cmd"})` on desktop) that calls the same `openNameOverride` as the chord, so pointer/touch users can name a workspace, and the primary `Create tab|group|workspace ↵`.

**Names.** The derived name is `deriveNameFromPath(folder)` through the level's transform and `uniqueName` (`-2`…`-10`, then `-11`; `lib/names.ts`) against live names — the workspace's groups for Group, `ctx.servers` for Workspace — so the preview always shows a creatable name; the same `deriveSheetName` backs the instant `create-session` paths' derivation (§ [routes-and-shell](/run-kit/ui/routes-and-shell.md) § Instant Creation). A collision can only come from a **typed override**: an already-live name disables Create and shows `A <level> named <name> already exists` (the backend answers `409` for workspaces). Workspace names additionally pass `isValidServerName` (`SERVER_NAME_PATTERN`, `lib/names.ts`), the one rule shared with `CreateWorkspaceDialog`.

**Keyboard map** (focus in the folder field): `Enter` creates with the field's folder and the derived/overridden name — unless an autocomplete row is highlighted, in which case it fills the field without creating; `↑/↓` walk the list (a list row sets the field; an autocomplete row only highlights, resetting when results change, not on keystroke); `Tab`/`Shift+Tab` cycle the available levels (`cycleLevel`, wrapping); `⌘↵`/`Ctrl+↵` opens the name override; `Esc` closes via the shell. Enter in the name input submits.

**Create actions** (run by `NewSheetHost.handleSubmit`; the sheet closes on submit): Tab → `useCreateTab()(server, group, folder)` (no name; optimistic ghost labelled `rawBasename(cwd)`); Group → `useCreateGroup().createGroup(server, name, folder)`; Workspace → `useCreateWorkspace()(name, folder)` (§ New Sheet → Shared create hooks). A group submit refused by the in-flight guard keeps the sheet open (no toast — the in-flight create is visible in the sidebar) rather than closing silently.

**Shared create hooks** (`hooks/use-create-group.ts`, `use-create-tab.ts`, `use-create-workspace.ts`) own each level's optimistic lifecycle once, for every opener — the sheet, the instant sidebar/tile/palette creates (`executeCreateSessionInstant` and the ghost-window path in `app.tsx`), the named prompt, and the board sidebar's group create:
- `useCreateGroup()` → `{createGroup(server, name, cwd) => boolean, isCreatingGroup()}`: add a ghost group, `createSession(server, name, cwd)`, drop the ghost and toast on failure; a success leaves the ghost for the SSE payload to reconcile. **One create is in flight at a time** — `createGroup` returns `false` and does nothing while a previous one is unsettled, so a second submit can never strand a ghost.
- `useCreateTab()` → `(server, group, cwd) => void`: ghost tab labelled `rawBasename(cwd)`, `createWindow(server, group, undefined, cwd)`, rollback + toast on failure. Each call owns its own ghost, so rapid creates never strand one. The board route's tab create stays a plain unghosted `createWindow` (it never had a ghost).
- `useCreateWorkspace()` → `(name, cwd) => void`: ghost server, `createServer(name, cwd)`, `markServerPending(name)` (the route guard shows the waiting state, not "Workspace not found"), navigate to `/$server`; `refreshServers()` on settle and a cleared pending marker on rollback survive the opener closing. `ServerDialogs` and the host page's create reach the same lifecycle (the host page still carries its own local-ghost copy).
All return stable functions.

**Shared folder pieces** (`components/folder-path-input.tsx`): `useDirectorySuggestions()` — the debounced (~300 ms) `getDirectories` state `{suggestions, loading, request, clear}` shared by `FolderPathInput` and the sheet; `tabFolders(sessions)`; `projectRoots(sessions)`; and `FolderPathInput`, a controlled combobox (`value`, `onChange`, optional `onSubmit` on Enter with no highlighted option, `quickPicks`, `ariaLabel`) that the New workspace dialog (§ New Workspace Dialog) mounts. Its highlight index resets when the suggestion results change (not on keystroke). Hidden directories (`.`-prefixed) are excluded server-side. An empty folder is allowed — `cwd` is omitted and the backend picks its default.

## New Workspace Dialog

`app/frontend/src/components/create-workspace-dialog.tsx` — the single "New workspace" dialog, mounted by the layout-mounted `ServerDialogs` (`components/server-dialogs.tsx`, opened by the sidebar/board `onCreateServer` → `openCreateServer` triggers — the palette's `Workspace: Create` opens the New sheet at Workspace level instead, § New Sheet) and by the host page (`host-overview-page.tsx`, § [routes-and-shell](/run-kit/ui/routes-and-shell.md)). `ServerDialogs` runs the shared `useCreateWorkspace` lifecycle (§ New Sheet → Shared create hooks); the host page keeps its own local-ghost copy; the dialog only collects `(name, cwd)` and calls `onSubmit(finalizedName, trimmedFolder | undefined)`. Props: `initialFolder?`, `existingNames` (the live server names from `ctx.servers`), `quickPicks`, `onSubmit`, `onClose`. It mounts only while open, so state resets on close.

- **Name** — `toSafeServerName` live transform, validated against `/^[a-zA-Z0-9_-]+$/` after `finalizeSafeName`.
- **Folder (optional)** — the shared `FolderPathInput` (§ New Sheet → Shared folder pieces) below the name; a blank folder submits without `cwd`, and the backend births the legacy `"0"` group at `$HOME`.
- **Name follows the folder until edited** — while the name field is untouched, choosing or typing a folder sets the name to `toSafeServerName(deriveNameFromPath(folder))`. The first keystroke in the name field marks it touched and the folder stops driving it until the dialog is reopened.
- **Already-exists guard** — when the finalized name matches an entry in `existingNames`, Create is disabled and the helper text becomes the red hint `A workspace named <name> already exists`. This matters because the folder-derived prefill makes the current workspace's own name the default; the backend returns `409` for the same case.
- **Prefill** (`ServerDialogs` only, via `useRouteWindowId`) — `initialFolder` is the current tab's `worktreePath`, resolved from the route's `window` param against `ctx.sessionsByServer` for the current server; empty when no tab is open. The host page has no active tab and opens empty. Quick-picks are `projectRoots` over every workspace's groups (`ctx.sessionsByServer`), as on the host page.

## Spawn-Agent Dialog

`app/frontend/src/components/spawn-agent-dialog.tsx` — a compact `Dialog` (the shared dialog styling: `text-xs` field labels, disabled-submit styling) surfacing `rk riff` as a one-action web spawn. It is the frontend of the web-UI agent-spawn flow; the backend is `POST /api/riff` (see [api-and-sockets](/run-kit/api-and-sockets.md) § API Layer and the engine in [rk-riff](/run-kit/rk-riff.md)). **Title** carries the target session: `Spawn agent in {session}` (substring-compatible with the e2e's `getByRole("dialog", { name: "Spawn agent" })`, which does case-insensitive substring matching).

**Fields — in order Task → Preset → Where → Worktree → Agent**:

1. **Task** — free text, optional, autofocused; empty spawns a blank agent session.
2. **Preset** — a dropdown fetched on open (see preflight below), populated against any live backend (the response always carries the `riff_presets` built-ins — `discuss`/`incognito`/`blank`); the `presets.length > 0` guard covers only the preflight-failed path. Each option renders `name — layout (N panes)`; presets are skill-only, so the backend reports `layout: ""` / `paneCount: 1` on every row (both rendered as optional decoration).
3. **Where** — a `role="radiogroup"` with two options: **new worktree** (default, `where="worktree"`) and **this checkout** (`where="checkout"`, roots the window in the existing checkout — no worktree created). State is the typed `RiffWhere = "worktree" | "checkout"` union (no `as` casts).
4. **Worktree** — a text input, blank by default, placeholder `auto-named (e.g. swift-fox)`; **hidden when `where === "checkout"`** (it has no meaning there). Converts **live** via `toSafeWorktreeName` as the user types (§ Live Safe-Name Conversion) — spaces → `_`, `/` → `_`, a leading `-` dropped (matching `ValidateWorktreeName`), hyphens kept. Blank = wt auto-names; a typed name rides `worktreeName` through to `wt create --name`. No pre-filled suggestion; the placeholder is the honest fallback (§ Design Decisions → The worktree field carries no pre-filled name).
5. **Agent** — a tier dropdown populated from the preflight's `tiers` (built-ins ∪ the repo's `agent.tiers`, `default` first), defaulting to the `DEFAULT_TIER = "default"` constant. Displays tier **names only** (no model IDs — brittle to parse out of command strings). **FAB-GATED**: the field renders **only when `tiers.length > 0`**. The backend fab-gates the presets response (`tiers: []` for a non-fab repo — see [api-and-sockets](/run-kit/api-and-sockets.md) § API Layer `/api/riff/presets`), so an empty list HIDES the field entirely — no label, no hint text, no disabled control — because in a non-fab repo every tier resolves to the same `DefaultLauncher` (inert noise). When hidden, `tier` is omitted from the spawn body (see § Defaults). Non-fab-repo hiding does NOT enumerate system agents (claude/codex/gemini) — tiers remain fab's abstraction (constitution §III). (gsmu)

**Enter submits from any field** (`handleKeyDown` wired on all inputs incl. the radios and both selects). **Preflight fetch** (`getRiffPresets(server, session)`) is **best-effort**, with two branches: (gsmu)

- **Success** — sets `presets` and mirrors the response `tiers` **verbatim** (`setTiers(data.tiers)`). A fab project returns a populated list (field shown); a non-fab repo returns `[]` (field hidden). This verbatim mirror is what makes the frontend gate follow the backend gate.
- **Failure** (e.g. non-repo cwd, network error) — leaves the preset dropdown hidden and **keeps the Agent dropdown at the built-in `[DEFAULT_TIER]` fallback (field SHOWN)**. On a rejected fetch the repo's fab-ness is UNKNOWN, so the conservative status quo is to show the inert default rather than hide it — still allowing a task-only spawn.

A `cancelled` ref guards the async setState; a `mountedRef` guards the submit path against a stale setState after the dialog closes.

**Defaults omit unset fields**: `spawnRiff` omits each field when unset/default — `where` when `"worktree"`, `worktreeName` when blank (and always in checkout mode — the client drops it since the backend rejects the pairing), `tier` when `"default"` — so leaving the fields untouched sends a two-field body. The submit also drops `tier` entirely when the Agent Tier field is hidden (`tier: tiers.length > 0 ? tier : undefined`): a non-fab repo never sends an inert tier, matching the gate. The `tiers` array is a submit dependency of the `handleSubmit` `useCallback`. (gsmu)

**Submit → in-flight → outcome**: on submit it sets a `busy` flag (disables all fields + the button, guarding double-submit) and shows an **indeterminate** busy pipeline label — `LogoSpinner` + "Spawning: worktree → window → agent…" — with **no per-step progression**, because the synchronous endpoint emits no per-step events. On success it closes and calls `onSpawned(windowId)` (wired to `app.tsx`'s `navigateToWindow`, inheriting the window-switch slide transition). **Falsy-windowId guard**: the backend `windowId` is best-effort (`""` when its `display-message` window-id resolve fails), so the dialog only navigates when `res.windowId` is truthy — otherwise it closes without navigating and lets the SSE stream surface the new sidebar row (navigating with an empty id would land on a junk `/$server/@` URL). A `400`/`500` renders its message in-dialog (`text-signal-red`; nothing was created on a `400`) and keeps the dialog open for correction.

**Entry points — THREE** (the first two are terminal-route only, the third is the sidebar). The two terminal-route entries open the dialog for the CURRENT window's session; the sidebar entry targets ANY listed session on ANY server (cross-server spawn): (gsmu)

1. **Cmd+K `Agent: Spawn`** — a `PaletteAction` in `app.tsx`'s `agentSpawnActions` block (folded into `paletteActions`), gated on `sessionName` (mirrors `Tab: Create`). Passes the CURRENT `{server, sessionName}` (`onSelect: () => handleOpenSpawnAgent(server, sessionName)`; `server` added to the memo deps). Constitution V palette parity; the shortcut/registration is documented at the registration site per `code-review.md` ("New keyboard shortcuts must be documented in the command palette registration").
2. **`+ New Agent`** — the window-switcher dropdown's `secondaryAction` beside `+ New Window` (see § Breadcrumb Dropdowns). Threaded via an optional `onSpawnAgent?(session)` on the top-bar slot context (`top-bar-slot-context.tsx`) → `TopBar` prop → `BreadcrumbDropdown.secondaryAction`; absent (e.g. before `AppShell` registers, or off-terminal routes) → the dropdown renders no `+ New Agent`. The one-arg slot signature is kept via a thin `handleSlotSpawnAgent = (sess) => handleOpenSpawnAgent(server, sess)` binding the CURRENT server (this entry is not cross-server).
3. **Sidebar session-card `Spawn agent…` row (gsmu)** — an action row on the session row's flyout card (§ Row-hover register flyout card), rendered only when the optional `onSpawnAgent?: (server, session) => void` handler is wired. It passes the ROW's explicit `{server, session}`, so it works from any route the sidebar is mounted on (Host / Workspace / Terminal — NOT the board-route sidebar, which passes no handler) and targets any server → **cross-server spawn**. Wired `app.tsx` → `<Sidebar onSpawnAgent={handleOpenSpawnAgent} />`.

All three entry points call `AppShell`'s `handleOpenSpawnAgent(server, session)`, which sets the explicit target state `spawnAgentTarget: {server, session} | null`. The dialog renders iff `spawnAgentTarget != null` and is lazy-imported + `Suspense`-wrapped (like `NewSheet`), receiving `server={spawnAgentTarget.server}` and `session={spawnAgentTarget.session}` (an explicit target, not the current server from `useSessionContext`). `spawnAgentTarget != null` is folded into `dialogOpenRef` so the active-window effect treats it like every other open dialog. (gsmu)

**Cross-server nav on success** (gsmu): `onSpawned(windowId)` branches on whether the target IS the current route server. Same-server → reuse `navigateToWindow` (inherits the window-switch slide transition). Cross-server → `navigate({ to: "/$server/$window", params: { server: target, window: windowId } })` (+ close the mobile sidebar), mirroring `handleSidebarSelectWindow`. The falsy-`windowId` guard is preserved on both branches. The branch itself lives in the **shared `navigateToSpawnedWindow(srv, windowId)`** helper in `app.tsx`, which the row-flyout fork also calls (§ Row-hover register flyout card → Fork navigation on success) — one routing rule for every riff-shaped result, so the two call sites cannot drift.

## Server Kill Dialog

The single create-server + kill-server implementation (`app/frontend/src/components/server-dialogs.tsx`, mounted once in `AppLayout` via `server-dialogs-context`) forks the kill confirm on the target's `protected` payload flag — read from the already-fetched `ctx.servers` list (`?? false`, no new fetch; the flag derives from the `@rk_protected` tmux server option, see [tmux-sessions](/run-kit/tmux-sessions.md)). Kills are reachable from the palette's server actions ([keyboard-and-palette](/run-kit/ui/keyboard-and-palette.md)) and the server-tile surfaces. Both forks navigate away when the killed server is the current one. (260824-xaw2-protected-server-class)

- **Non-protected target** — the plain two-button confirm ("Kill workspace <name> and all its groups? This cannot be undone."), zero drift from the shared confirm path (the `confirm` variant's neutral/`danger` arms — § Component Conventions → Dialog control conventions).
- **Protected target** (`ProtectedKillDialog`, title "Kill protected workspace?") — three behaviors:
  - **Typed-name force unlock** — an auto-focused text input (`placeholder="Type <name> to unlock force kill"`, `aria-label="Type the workspace name to unlock force kill"`); the destructive **Force kill** button stays disabled until the typed value EXACTLY equals the server name, Enter submits only on match, Escape cancels via the Dialog's focus trap. Keyboard-first per Constitution V.
  - **Blast-radius copy** — red (`text-signal-red`) copy derived live from client-held session data (`ctx.sessionsByServer`, no endpoint): for `rk-daemon`, "kills the dashboard, N running job(s), code-server, M remote tunnel(s)" composed from the `rk-jobs` active-window count, `rk-code-server` presence, and the `rk-remotes` window count (each fragment omitted when zero/absent); for other protected servers, "kills N group(s), M tab(s)".
  - **Daemon Restart primary** — for `rk-daemon` only, a "Restart HexoKit" primary button wired to `ctx.restartNow()` (the SessionContext restart path → `POST /api/restart`, failure toasts); non-daemon protected targets get no Restart primary — Cancel is the safe default.
- **Force kill path** — Force kill calls `killServer(name, true)`; the client's `force` arg rides `POST /api/servers/kill` as `{name, force}`, and the killServer optimistic action passes it through (`useOptimisticAction<[string, boolean]>`). Without `force` the backend refuses protected targets with `409 {"error", "protected": true}` — see [api-and-sockets](/run-kit/api-and-sockets.md) § API Layer.

## Server Adopt Dialog

The same `server-dialogs.tsx` layout-mounted home carries the **adopt confirm** (`Dialog title="Adopt workspace into HexoKit?"`, opened via the `requestAdoptServer` context trigger beside `requestKillServer` — `server-dialogs-context`), the web entry for converting an external server to rk-managed ([tmux-sessions](/run-kit/tmux-sessions.md) § `@rk_srv_managed`). Reachable from the palette's external-only `Workspace: Adopt <name> into HexoKit` entries ([keyboard-and-palette](/run-kit/ui/keyboard-and-palette.md)). The copy states the semi-irreversibility plainly — HexoKit's tmux config is applied now, and the user's own config returns only on server restart — under **neutral** (not danger-red) styling: adopt is a config mutation, not a destruction, so it forks nothing off the kill dialog's danger idiom and carries no optimistic killed-mark analog. Confirm calls `adoptServer(name)` (`POST /api/servers/adopt`) then `ctx.refreshServers()` — the backend wakes the SSE hub on success, so the repaint rides the stream and the refresh is belt-and-braces; failures toast. (260826-lv87-external-server-provenance-adopt)

## GUI Off-Confirm Dialog

`app/frontend/src/components/gui-off-dialog.tsx` — the GUI off-confirm (spec `docs/specs/gui.md` § The switch), the `server-dialogs.tsx` danger-confirm grammar on the shared confirm shell **`gui-confirm-shell.tsx`** (`useGuiStatusOnOpen` — the one-shot status fetch — plus `GuiConfirmShell`, the body/buttons layout over the shared `Dialog`; the shell is shared with the restart confirm, § GUI Restart-Confirm Dialog) (title `Turn the GUI off?`, **Cancel** / **Turn off** danger pair). ONE mount lives at `AppLayout` in `app.tsx`, shared by two open paths through the **`gui-off-context` seam** (`contexts/gui-off-context.tsx` — `open()` self-posting for the palette's `GUI: Turn off`; `request() → Promise<boolean>` verdict-deferring for the settings seam, which must `updateEntryValue` with the same write; `undefined` outside the provider ⇒ callers fall back to the direct POST). (o2sp) (pp6o)

On open the dialog fetches `GET /api/gui/host` ONCE (never polled — the stream payload carries no `apps`/`reason`/`uptime`, so the copy derives from the status document; a failed GET leaves the confirm with the generic copy, never a throw). The body is the shipped CLI confirm's copy grammar, per status shape (`guiOffBody(status)` + the exported `formatGuiUptime(seconds)` — `4h 12m` / `3m` / `12s`):

| Status shape | Copy |
|---|---|
| `apps` non-empty | `Turning the GUI off kills the rk-gui session and every app on display <display>:` + an indented `<name> ×<count>, …  (up <uptime>)` line |
| `apps` empty | `…kills the rk-gui session.` + `No apps are running on display <display>.` |
| `display` empty (never ran) | `Turning the GUI off kills the rk-gui session.` |
| `backend === "screen-sharing"` | `Turning the GUI off stops the Screen Sharing mirror; nothing on your Mac is closed.` |

Confirm POSTs exactly `{"gui.enabled": false}` (Constitution IX — the settings POST's server-side side effect kills the `rk-gui` session; the dialog never calls a kill route), flipping the stream's `enabled` within one state event so every tab's toggle disappears and open gui tiles degrade with the option untouched. A failed POST toasts and keeps the dialog open for retry.

**The settings-seam interception**: the All-settings tab's registry row renders the `gui.enabled` `BoolToggle` like every other key, but `settings-registry-seam.ts`'s `commitSetting` intercepts the OFF direction — key `gui.enabled`, value `false`, current value `true` — and routes through the injected `requestGuiOff()` seam (the dialog in verdict-deferring mode) before posting: a cancel resolves without the POST so the toggle snaps back to on; a confirm falls through to the shared `postSettings` + `updateEntryValue` write. The on direction and the `null`-unset post directly. (`SettingsDialogBody` injects the seam via `useGuiOffRequest()?.request`; `useSettingsRegistry(options?)` takes it as an optional argument so non-AppLayout mounts keep the direct behavior.)

**Per-viewer gui postures** (`lib/gui-posture.ts`, validated reads / try/catch-noop writes — the untrusted-localStorage discipline; ten keys): `rk-gui-zoom` (`"fit"` | a decimal percentage from `GUI_ZOOM_STEPS` (50/75/100/125/150/200), absent or out-of-table = `"fit"` — the canvas zoom; a one-time migration reads a legacy `rk-gui-view: "1:1"` as `100` when `rk-gui-zoom` is absent, and `writeGuiZoom` removes the legacy key), `rk-gui-pointer` (`"touch"` | `"trackpad"` — the coarse-pointer input mode; absent/invalid resolves the pointer-class default: `trackpad` on coarse, `touch` on fine), `rk-gui-lock` (`"1"` = locked, absent = unlocked — a locked viewer never drives SetDesktopSize; viewer-local by design, a second fine-pointer viewer can still resize — the loop-safe host-wide answer is the host pin `rk gui lock`, streamed as the entry's `locked` and honored by every viewer's tile, [gui](/run-kit/gui.md) § Agent verbs), `rk-gui-quality` (`"sharp"` | `"balanced"` | `"smooth"`, absent/invalid = the pointer-class default — `balanced` on fine, `smooth` on coarse — the RFB quality preset, [lenses-and-layout](/run-kit/ui/lenses-and-layout.md) § GUI Surface), `rk-gui-stats-visible` (`"1"` = shown, absent = hidden — the stats overlay's visibility, the lock's shape), `rk-gui-hidpi` (`"1"` = on, absent/other = off — the HiDPI rendering switch: the percentage-zoom host CSS size divides by `devicePixelRatio`, so a 100% zoom maps one framebuffer pixel to one device pixel; client-side rendering only, never a server-facing size), `rk-gui-keybar` (`"0"` = hidden, absent/other = shown — the key bar's visibility; the default keeps the bar rendering), `rk-gui-toolbar` (`"1"` = open, absent/other = closed — the header fold's `⚙` panel open state; an overflow panel's rest state is closed, and a persisted-open panel whose items have all unfolded renders nothing — the state goes latent, not false), `rk-gui-capture` (`"1"` = captured, absent/other = released — the keyboard-capture latch: while set, the gui chord gate hands every chord but the `gui-capture-toggle` release binding to the guest desktop, [lenses-and-layout](/run-kit/ui/lenses-and-layout.md) § GUI Surface → Chord gate), and `hexokit-gui-wm-strip-dismissed` (`"1"` = dismissed, absent = shown — the bare-WM strip's dismissal, cleared whenever the stream's `wm` turns non-empty so a later bare state shows the strip again; a `reachable` flip never clears it). For the zoom/pointer/lock/quality/stats/hidpi/keybar/toolbar/capture nine `app.tsx` owns the state, seeded from these keys (the pointer mode and the quality seeded with the coarse-pointer flag), written by the palette's destination-only rows (`GUI: Zoom …`/`GUI: 1:1`, `GUI: Pointer → …`, `GUI: Lock/Unlock resolution`, `GUI: Quality → …`, `GUI: Show/Hide stats`, `GUI: HiDPI on/off`, `GUI: Hide/Show key bar`, `GUI: Show/Hide toolbar`), by the tile's zoom chords/Ctrl+wheel/pinch, and by the header fold cluster's chips and `⚙` panel rows — the capture latch by its three equal paths (the `gui-capture-toggle` chord, the pinned header verb, and the state-labelled `GUI: Capture/Release keyboard` row) — ([keyboard-and-palette](/run-kit/ui/keyboard-and-palette.md) § The `GUI:` palette family); the tile consumes them as props (§ [lenses-and-layout](/run-kit/ui/lenses-and-layout.md) § GUI Surface). The strip-dismissal key is owned by the gui tile itself — read on mount, written by the strip's × and by the `wm`-non-empty clearing effect. (0aur) (t2lv) (lut4) (31eg)

## GUI Restart-Confirm Dialog

`app/frontend/src/components/gui-restart-dialog.tsx` — the desktop-pick restart confirm (spec `docs/specs/gui.md` § Switching desktops), built on the shared `gui-confirm-shell.tsx` shell (title `Restart the desktop now?`, **Later** confirm arm / **Restart** danger arm). ONE mount lives at `AppLayout` beside `GuiOffDialog`, behind the **`gui-restart-context` seam** (`contexts/gui-restart-context.tsx` — `request() → Promise<boolean>` resolving the verdict, the `GuiOffRequest` shape; `undefined` outside the provider ⇒ callers skip the confirm, the settings write already standing). The body copy derives from the shell's one-shot status fetch via `guiRestartBody` (`lib/gui-desktop.ts`): `Running apps will close: <name ×count, …>` with apps running; `No apps are running on display <display>.` without; `The desktop is not running — the new desktop starts on the next restart.` when unreachable; a failed GET renders the generic `Couldn't read the desktop status — restarting it closes any running apps.`. **Restart** POSTs `/api/gui/host/restart` itself (`restartGui`) — a `409`-shaped `{ok:false, disabled}` (the GUI flipped off between the check and the POST) resolves as an info toast, not an error, and a thrown error toasts and closes; the written pin stands either way. **Later** (and Escape/backdrop) resolves `false` and calls nothing further. (pp6o)

**The shared pick flow** (`hooks/use-desktop-pick.ts` — the one flow both picker doors run, the Settings `gui.wm` select and the palette's `GUI: Desktop…` sub-list): the caller's settings write first (its rejection propagates and ends the flow), then a fresh one-shot `fetchGuiStatus` decides the ending — `enabled: false` skips the confirm and toasts `Desktop set — takes effect when the GUI turns on` (a restart would 409 `gui disabled`); enabled — or a failed fetch, read as enabled/unknown so the confirm renders its generic line — opens the restart confirm above. (pp6o)

## Settings Dialog

A tabbed settings **dialog** (not a routed page — constitution §IV keeps "no settings pages") gathers the instance's scattered preferences into one keyboard-first surface: `app/frontend/src/components/settings-dialog.tsx` on the shared `Dialog` shell (focus trap, `role="dialog"`, Escape closes) at its fixed-height `size="xl"` variant (§ Dialog width variant). Five tabs, in rail order (the `SETTINGS_TABS` array is the single source of that order): four curated topic tabs first (each reusing the existing control components — the second-surface rule), then the **All settings** registry-driven everything-table last — the advanced escape hatch sits after the curated presentation (260824-xf6p-all-settings-tab-last):

| Tab | Controls |
|-----|----------|
| **General** | Instance display name, SSH host, MCP endpoint (read-only), Auto-name tabs (`auto_name`), Easter eggs (`easter_eggs`) (all **This host**); notifications (**This device**) |
| **Appearance** | Theme pair, instance accent color (**This host**); terminal font size, quake terminal opacity (**This device**) |
| **Agents** | fab-kit's machine-wide config (`~/.fab-kit/config.yaml`) through the fab CLI — session/worker agent, per-role overrides, dispatch knobs — `components/settings-agents-panel.tsx` (§ Agents tab below) |
| **Shortcuts** | The registry-driven shortcuts/rebinding surface — `app/frontend/src/components/settings-shortcuts-panel.tsx`, `data-testid="settings-shortcuts-panel"`, THE single shortcuts surface ([keyboard-and-palette](/run-kit/ui/keyboard-and-palette.md) § Shortcuts panel) |
| **All settings** | Every `ui: true` config.yaml key as a registry-generated row (search, category headers, typed controls, modified dot, restart badge, escape-hatch footer — § All-settings tab below) |

**MCP endpoint row** (General → This host, after SSH host) — display-only, no registry key: `mcpEndpointUrl()` (`lib/mcp-endpoint.ts`, the page origin + `/mcp`) in a `break-all` `<code>` (`data-testid="settings-mcp-endpoint"`) beside a `CopyValueButton`; the `Copy: MCP Endpoint` palette entry is its keyboard parity. Why the page origin: [mcp](/run-kit/mcp.md) § The dashboard surfaces the endpoint from the page origin. (261007-vqkk-mcp-endpoint-tailscale-serve-settings)

**One `role="tablist"` markup, one breakpoint** — at `min-[480px]:` and up the tab list is a vertical left rail beside the active panel (accent-tinted active tab, `bg-accent/15`); below 480px the SAME element restyles into a horizontal scrollable strip under the dialog title — the dialog's single `min-[480px]:` breakpoint, no second code path. **Roving tabindex**: the active tab is the list's one Tab stop (`tabIndex={active ? 0 : -1}`), arrow keys (both axes, both layouts) move focus and activate on focus, Tab leaves the list into the panel. The `role="tabpanel"` container owns the scroll (`flex-1 overflow-y-auto` inside the fixed-height `xl` panel), so the rail never jumps between the short General tab and the tall Shortcuts tab. The Shortcuts panel additionally mounts ONLY while its tab is active (mount == visible), which gates its per-open data plumbing — the riff-presets fetch, the macro add-flow's palette targets, the tmux keybindings fetch — exactly on panel visibility (a board/host route keeps the CUSTOM rows read/rebind/delete-only).

**Mounted once at `AppLayout`, not `AppShell`** — `AppShell` is server-scoped (assumes a non-null `currentServer` throughout `app.tsx`), while `AppLayout` is the true every-page layer (the persistent `RootTopBar` mounts there; `/board/$name` renders inside it without `AppShell`). So the dialog, its state, and its logic exist exactly once and it is available on every route including boards. `SettingsDialog` is lazy-imported and rendered inside a `SettingsDialogProvider` at the `AppLayout` level; the body (`SettingsDialogBody`) mounts only while open, so the per-open registry fetch runs on mount with no reopen-staleness bookkeeping.

**`SettingsDialogContext` (`contexts/settings-dialog-context.tsx`)** — a deliberately small open/close context `{ isOpen, activeTab, setActiveTab, openSettings, closeSettings }` provided at `AppLayout` so any descendant (palette actions, sidebar gear, chevron menu rows) targets the one dialog while it renders once. `SettingsTab = "general" | "appearance" | "all" | "shortcuts"`; `openSettings(tab?)` semantics: a call WITH a tab opens (if closed) and activates that tab; a tab-less call opens on **General** when closed and is a **tab-preserving no-op** when already open — no last-visited-tab persistence, a tab-less reopen always lands General. Instance data (display name, accent) lives in its own contexts, not here.

**Scope groups live inside the topic tabs** — the persistence-scope labeling is load-bearing UX (a device-local value not syncing across devices reads as designed, not broken), so the two `ScopeHeading` groups render INSIDE each of General and Appearance (both mix scopes, per the table above):

- **This host** ("stored on this instance, shared by every device") — persisted to `~/.config/hexokit/config.yaml`. The config home resolves per home: `$HOME/.config/hexokit/` when it exists, else the legacy `$HOME/.config/run-kit/` while it exists (the legacy dir stays in place for one release), else the hexokit path.
- **This device** ("stored in this browser only") — browser-local ergonomics (the Web Push subscription is per-browser, so the scope is semantically exact).

**Desktop preference-pane layout, one responsive code path** (260724-6j1v):

- **Wide fixed-height dialog** — `size="xl"` on the shared `Dialog` (`max-w-4xl`, fixed height, panel `overflow-hidden`) instead of the phone-card `max-w-sm` every other dialog keeps (§ Dialog width variant below).
- **`PreferenceRow`** — each setting is a `grid grid-cols-1 min-[480px]:grid-cols-[190px_1fr] gap-x-6 gap-y-1.5 py-2.5 items-start` row: label column left (the label plus an optional small `text-text-secondary` **sublabel** hint underneath), control column right, so every control's left edge lands on ONE vertical rule. `htmlFor` renders the label as a real `<label>` bound to the row's input; rows whose control carries its own labeled elements (the theme picker, steppers) pass none. Hairline separators come from `divide-y divide-border/40` on the wrapping section. The component lives in `text-setting-core.tsx` and takes an optional `meta` line (a small monospace config key under the sublabel).
- **`ScopeHeading`** — each scope heading is a full-width underlined rule (`border-b border-border`): the uppercase scope name left, the storage hint right-aligned on the SAME baseline. The component lives in the shared `text-setting-core.tsx` module (also consumed by the All-settings table's category headers; `settings-dialog.tsx` re-exports it for its historical import sites) — an empty hint renders no right-aligned span.
- **Input cap** — text inputs stop at `max-w-[320px]` so they don't stretch edge to edge.
- **Responsive collapse, no second dialog** — the `min-[480px]:` variant is the ONLY breakpoint: below 480px the row markup falls back to `grid-cols-1`, stacking label above control (the phone layout), and the tablist becomes the horizontal strip. One code path, no mobile fork.
- **Scroll path** — `xl` inverts the shared dialog's panel scroll: the panel is fixed-height with `overflow-hidden` and each tab panel carries its own `overflow-y-auto`; `sm`/`lg` keep the panel-level `max-h-[calc(100vh-2rem)] overflow-y-auto` with the backdrop container `p-4`, so a tall pane scrolls inside a short viewport instead of clipping content off-screen unreachably.

**Controls reuse existing models, never rebuilt** (the second-surface rule):

- **Instance display name** — a `TextSetting` (Enter/blur commits, Escape cancels the edit only; a second Escape closes the dialog — the window-rename vocabulary) reading the registry seam's `settingValue("instance_name")` (live-mirrored from `useInstanceName()`), committing via the seam's `commitSetting("instance_name", …)`, which routes through the context's optimistic `setInstanceName` (empty clears) and mirrors the write into the registry list. Placeholder is the real hostname.
- **SSH host** — a single free-form `TextSetting` used verbatim (alias or `user@host`, never split into username/hostname fields — preserves the `open-in-app.ts` verbatim-alias contract). It reads the stored **setting** through the registry seam (NOT the effective health value, which may be an env fallback), commits via `commitSetting("ssh_host", …)` (empty clears, `invalidateOpenContext()` refreshes the Open control's cached deeplink context on success), and surfaces a backend `400` as an inline `role="alert"` error without clobbering the stored value.
- **Auto-name tabs** (`auto_name`) — a `BoolToggle` under the This-host scope group, sublabel from the registry description, reading and committing through the same registry seam as its All-settings table row (`commitSetting("auto_name", on)` → `postSettings`; the backend rewires the hub tracker live — see [configuration](/run-kit/configuration.md) § Settings HTTP API). `log_level`/`tmux_conf` stay table-only (advanced keys).
- **Easter eggs** (`easter_eggs`) — a `BoolToggle` directly after Auto-name tabs, sublabel from the registry description, reading `settingValue("easter_eggs") !== false` (ON before the fetch resolves and when the key is absent — the registry default is on) and committing via `commitSetting("easter_eggs", on)`; the seam's key-specific case POSTs and then mirrors the value into the screen-break store, so the flip applies without a reload (see [screen-break-eggs](/run-kit/ui/screen-break-eggs.md) § The store); a `null` unset mirrors the registry default (on) into both the store and the entry, so this row and the All-settings row agree. No backend side effect. (hn6s)
- **Instance accent color** (`AccentColorControl`) — reuses the HOST-panel `SwatchPopover` (color-only) + `useInstanceAccent().setColor` descriptor model ("4" / "1+3"; NOT a free RGB picker — the color model is descriptor-based end-to-end, see § Instance Accent). A pick POSTs and repaints the top-bar stripe without reload; the popover's Clear row clears. The popover's cells keep 18px on fine pointers and step to 28px on coarse (the dense-picker exception), the flair strip wrapped in a coarse-only `overflow-x-auto` so the fixed ~190px box holds ([visual-design](/run-kit/ui/visual-design.md) § Touch Targets).
- **Theme** (`ThemePairControl`) — a second surface reusing `useTheme()`/`useThemeActions()` (`/api/settings` partial-merge POST): a System/Light/Dark mode control — three bordered chips whose selected mode wears the Control primitive's green latch arm via `controlClass({ variant: "toggle", pressed })` (the REST-swap is structural — the builder emits the arm or the hover-carrying rest classes, never both; `aria-pressed` carried; [visual-design](/run-kit/ui/visual-design.md) § Global Control-State Rules → Latch vocabulary) — plus the shared `ThemePickerList` core rendered inline (search + grouped DARK/LIGHT list with palette swatches, in a bordered `max-w-[420px]` box) — the same core the top-bar `ThemeSelector` modal renders (§ Visual Design → Theme Selector). The control is `collapsible`: at rest a trigger button names the ACTIVE theme (swatch + name + ▾); clicking it swaps in the focused search field with the list in a popover (`absolute top-full z-50` below the field — the same panel-local elevation pattern as the accent `SwatchPopover`), which closes on commit, Escape, or focus leave; keyboard/commit closes refocus the trigger. Both preferred slots show a check at once (`checkedIds={[themeDark, themeLight]}`); click/Enter commits via `setTheme(id)` (slot + mode update, the list closes, the dialog stays); hover/keyboard nav live-previews with `cancelOnLeave` reverting on pointer/focus leave, and an Escape that just cancelled a preview or closed the list is consumed (`stopPropagation`) so only an idle Escape closes the dialog — the `TextSetting` two-stage-Escape vocabulary.
- **Terminal font size** (`TerminalFontControl`, under This device) — the shared `ChromeContext.terminalFontSize` control: a `[−] {size}px [+]` stepper + Reset wired to `increaseTerminalFont`/`decreaseTerminalFont`/`resetTerminalFont` (localStorage `hexokit-terminal-font-size`, clamped by `TERMINAL_FONT_BOUNDS`). No new persistence (see § Terminal Font Size).
- **Quake terminal opacity** (`QuakeOpacityControl`, under This device, sublabel "Desktop quake terminal background; 100% turns off the blur") — the desktop quake terminal drawer's glass background ([ui/quake-terminal](/run-kit/ui/quake-terminal.md) § Glass background): a range slider (`min`/`max` = the 0.5–1.0 clamp, step 0.05; the unset default is 0.95) with an `aria-live` percent readout, backed by the per-viewer localStorage key `hexokit-quake-terminal-opacity` through the quake terminal's pub/sub store (`useQuakeOpacity`) — NOT an `internal/settings` registry key and NO `/api/settings` request (the registry is per-instance daemon config; glass is per-eye). An open quake terminal reflects changes live via the store's same-tab notify; 100% disables the backdrop blur entirely.
- **Notifications** (`NotificationsControl`, under This device, sublabel "Web Push to this browser") — the Web Push opt-in surface in chrome, backed by the same `usePushSubscription()` `{state, enable, sendTest}` the palette actions use, so the two surfaces cannot drift (§ Notifications (Web Push opt-in)). Contents: a status line (a 1.5px `role="status"` dot + `Subscribed on this device` / `Blocked in browser settings` / `Not subscribed`), an **Enable notifications** button whenever `!subscribed` (so it stays offered under `denied`, where re-allowing is a browser-settings action), a **Send test notification** button `disabled` until subscribed (Tip: "Send a local test notification" / "Enable notifications first"), the denied re-allow note, and a "Setup & troubleshooting guide ↗" link over the shared `NOTIFICATIONS_HELP_URL` in a new tab. **No Disable/unsubscribe action** — `lib/push.ts` has no unsubscribe path. When `state === "unsupported"` (insecure context / no service worker) the row **stays present** and renders a short "Not supported in this browser" note with no action buttons — a settings pane explains absence rather than vanishing (§ Design Decisions → The settings Notifications row explains an unsupported browser). (260724-6j1v)

**Agents tab — a curated surface over fab-kit's system config** (`settings-agents-panel.tsx`, `SettingsAgentsPanel`; the one curated tab whose data source is not the `internal/settings` registry — Constitution IV's single carve-out, [configuration](/run-kit/configuration.md) § fab-kit System Config). Its data is the daemon's `GET /api/fab-config` document ([api-and-sockets](/run-kit/api-and-sockets.md)); the tab never holds a cache — the panel fetches on **every mount** (opening the dialog on Agents, or switching to the tab; `getFabConfig()` is never deduplicated) and re-renders from the fresh document each `POST /api/fab-config` returns, so an external edit (the user's shell, `fab config upgrade`) always wins. Layout, top to bottom:

- **Agents** `ScopeHeading` (hint `~/.fab-kit/config.yaml · machine-wide, outranks project files`) — `agent.session` ("what you talk to") and `agent.workers` ("what pipeline stages dispatch to") as latched provider chips, one per entry of the document's `providers` (never a hard-coded list); then the **per-role override table**: columns role · tier · provider · model · effort · reset, rows `default`/`operator` (tier `session`) and `doing`/`fast`/`hydrate`/`review` (tier `workers`). Provider is a `<select>` whose first option inherits; model is a text input with a `<datalist>` of the resolved provider's `modelSuggestions`; effort is a `<select>` of `effortSuggestions` plus inherit. An unset cell shows the inherited value dimmed with a `↳` prefix (`↳ provider default` when the resolved value is empty); choosing inherit/blank POSTs `null` for that leaf; a row's `reset` (visible only when any of its three leaves has a system override) POSTs `null` for all three in one request. A model override absent from the resolved provider's non-empty suggestion list shows a warning marker (never a block — fab does not validate provider×model pairs). The table scrolls inside its own wrapper on phones, never the page.
- **Dispatch** `ScopeHeading` (hint `how worker stages are launched`) — `dispatch.mode` chips (`pane`/`native`/`headless`), `dispatch.column_width` number input with a `%` suffix, `dispatch.min_cols` × `dispatch.min_rows` number inputs on one row, and `dispatch.reap_done` as a `BoolToggle`.
- **Row anatomy** — each row is a `PreferenceRow` (label, sublabel, and the config key as a small monospace `meta` line) carrying a **provenance chip** (`system` / `env` / `default`; `project` renders as a read-only chip though the daemon's `$HOME` working directory never produces it), a **modified dot** when a system-tier value exists, and a **`reset` link** (→ `null` POST) only when a system override exists. Chips and the toggle commit on change; number inputs commit on blur/Enter through the `useTextSettingDraft` idiom and Escape reverts. A failed write shows fab's message inline on that row and leaves the previous value in place.
- **Env-shadow warning** — when a field's (or role provider cell's) origin is `env`, the row shows an inline amber warning naming the variable from `originDetail`: the saved system value does not take effect until it is unset (derived from provenance, so it shows before any write as well as after). Any `warnings` array on a POST response renders verbatim.
- **Footer** — states that the providers table and other list/map keys can't be set from the CLI and that project-only keys (`fab/project/config.yaml`) aren't shown, and shows the system config path with a `CopyValueButton` (there is no frontend seam that opens an arbitrary absolute path in the code tile).
- **fab not installed** — `{"installed": false}` renders only the scope heading and "fab isn't installed on this host. Install fab-kit to manage agent defaults here." — no toast, no console error.

`PreferenceRow` is exported from `text-setting-core.tsx` (beside `ScopeHeading`) so the Agents panel reuses it; it additionally takes an optional `meta` line. The phone collapse is the dialog's single `min-[480px]:` breakpoint like every other panel.

**All-settings tab — the registry-driven everything-table** (`settings-all-panel.tsx`, `data-testid="settings-all-panel"`): the pane half of the two-level model — the curated tabs stay the palatable presentation, this tab exposes every `ui: true` config.yaml key, so a future registry key appears with a typed control, description, category placement, modified indicator, and live/restart badge at zero frontend cost. Browser-local controls (terminal font, notifications) keep their curated homes and never appear here — the table renders registry keys only. Duplication with the curated tabs is deliberate (the VSCode settings-UI/settings.json model) and drift-guarded by the single seam below. (260823-5r41-settings-pane-live-apply)

- **One dialog-level registry seam** (`settings-registry-seam.ts`, `useSettingsRegistry()`): the `SettingsEntry[]` fetch + state hoist to the dialog body — one mount-gated fetch per open — and every settings row in every tab reads/writes through the returned `{ entries, settingValue, commitSetting }`. The read path is ONE derived list: `entriesWithMirrors` overlays the live values of context-backed keys (`theme`/`theme_dark`/`theme_light`/`instance_name`, plus `instance_color` only while the accent context's setting `isExplicit`) onto the fetched entries, so a row's control and its modified dot derive from the same read path and cannot diverge — per-key mirror logic in consumers is forbidden by construction. Writes route by key: context-backed keys POST through their context's setter (`setTheme` — with the enum mode word mapped to the per-mode slot id, `dark` → `themeDark` / `light` → `themeLight` / else `"system"`; `useInstanceAccent().setColor`; `useInstanceName().setInstanceName`); `gui.enabled`'s OFF direction detours through the injected off-confirm seam before its POST (§ GUI Off-Confirm Dialog → The settings-seam interception); `easter_eggs` POSTs directly and then mirrors the committed value into the screen-break store via `setEasterEggsEnabled(value !== false)` — the trigger hook reads the store, not the fetched list, so a same-browser flip applies without a reload ([screen-break-eggs](/run-kit/ui/screen-break-eggs.md) § The store) (hn6s); context-less keys (`auto_name`, `ssh_host`, `log_level`, `tmux_conf`) POST via the generic `postSettings` and update the shared list optimistically; a backend `400` rejects `commitSetting` so the row surfaces it inline without clobbering the stored value. Committed values are recorded as they land and reapplied over the mount fetch's resolution, so a fetch that was issued before a commit and resolves after it cannot clobber the newer committed value. Client-side, the generic surface is the exported `SettingsEntry` (gaining `options?: string[]`), `getSettingsEntries()`, and `postSettings()` in `api/client.ts`; the 13 per-key wrappers stay untouched.
- **Search + category headers**: a search field on top runs a substring filter over key, description, and category (the palette haystack precedent); rows render in registry order grouped under title-cased category headers on `ScopeHeading`'s underlined rule, and a header hides when all its rows are filtered out (group `<section>`s key on group identity, not the category name — a filtered run can split a category into two groups).
- **Typed controls per kind, with key overrides**: `bool` → `BoolToggle` (commit-on-flip; its switch composes the shared `SWITCH_TRACK_*`/`SWITCH_KNOB_*` constants from `controls.ts` — ON the `bg-accent-green/30` track + green knob, OFF the `bg-bg-inset` recessed ground — the same recipe the server card's Protect switch consumes, [visual-design](/run-kit/ui/visual-design.md) § Global Control-State Rules); `enum` → a closed select over the entry's `options` (an out-of-list effective value — e.g. `theme` holding a named theme id — renders the registry default WITHOUT committing, never a blank select); `string`/`path` → the `TextEntryControl` on the shared text-setting core; `color` → the `SwatchPopover` descriptor control; `map`/`list` (`server_colors`, `server_flairs`, `board_order`) → read-only rows with a current-value summary (entry count / ordered names) and a hint naming their dedicated editing surface (sidebar pickers, board sidebar reorder) plus the escape hatch. Key overrides: `theme_dark`/`theme_light` render as selects over the client theme registry filtered to the slot's category (never free text — the backend validates only non-empty), with the same no-commit fallback-to-default guard; `gui.wm` renders `GuiWMPicker` (`components/gui-wm-picker.tsx`) — once the one-shot status fetch resolves, a select (`Auto (ladder)` value `""`, one option per installed `wm_candidates` entry — the label as visible text, the name as value — then one DISABLED `<option>` per known-but-missing entry labelled `<Label> — not installed`, then `Other…`, whose reveal alone writes nothing and which shows the shared text-field contract beneath the select — placeholder `binary name, e.g. startlxde` — Enter/blur commits; a stored pin naming no candidate, installed or known-missing, pre-selects `Other…` with the field pre-filled), falling back to the plain `TextEntryControl` while the fetch pends and permanently after a rejection (the dialog never blocks on it), a collapsed `Install more ▾` disclosure below the select (`data-testid="gui-wm-install-more"`, rendered iff `missingWMs(status)` is non-empty) expanding to one monospace, user-selectable `<Label>: <hint>` line per missing desktop (`data-testid="gui-wm-install-line"`), and every commit routed through the shared desktop-pick flow (§ GUI Restart-Confirm Dialog) (pp6o) (91px); `instance_color` binds the accent context so the top-bar stripe repaints optimistically. `ThemePairControl` stays the Appearance tab's rich theme surface, untouched.
- **Shared text-setting core** (`text-setting-core.tsx`): `useTextSettingDraft(value, commit)` owns the draft/commit/Escape state machine (Enter/blur commit, Escape cancels the edit only, inline `role="alert"` rejection), with `textSettingInputClass` and `TextSettingError` carrying the shared styling/markup — consumed by both the curated `TextSetting` and the table's `TextEntryControl`, so the commit contract is single-sourced.
- **Modified dot + restart badge**: each row's modified-from-default dot compares the seam-read effective value against the registry `default` per kind (`null`-equals-empty for unset scalars, `{}`/`[]` for nested); every `live: false` row (`tmux_conf`, `log_level`) renders a "requires restart" badge driven by the GET payload's `live` flag — no frontend key list. No per-row reset action (the `null`-unset POST and the escape hatch exist). Known residual: the table-side `instance_color` Clear path leaves a stale modified dot until dialog reopen (the Clear drops the accent mirror's `isExplicit` overlay and the row falls back to the fetched entry) — recorded as a follow-up.
- **Escape-hatch footer**: renders the constant path `~/.config/hexokit/config.yaml` (displayable as a constant by the fixed-config-root decision — no API resolves it) with a copy-to-clipboard button and a one-line hint that map/list keys and comments are edited there; no open-in-editor mechanism.
- **`CopyValueButton`** (exported from `settings-all-panel.tsx`) is the dialog's one copy control — `copyToClipboard` (`lib/clipboard.ts`), a `Tip` + `aria-label` from its `label`, text `Copy` → `Copied` for 1.5 s with the timer cleared on unmount; the escape-hatch footer and General's MCP endpoint row both use it.

### Dialog width variant (`size` on `components/dialog.tsx`)

`Dialog` takes an optional `size?: "sm" | "lg" | "xl" | "sheet"` defaulting to `"sm"`: `sm` → `max-w-sm` (the phone-card width every other dialog uses — spawn, kill, the name prompt, board kill confirm, …); `lg` → `max-w-2xl` (≈672px) — **consumerless**; `sheet` → the New sheet's variant: `sm:max-w-[520px]` centered from `sm` up; below `sm` the backdrop drops its gutter (`items-end p-0`) and the panel becomes a full-width bottom sheet with square bottom corners (`rounded-b-none`), keeping the panel scroll path; `xl` → `max-w-4xl` plus a FIXED panel height (`h-[min(40rem,calc(100vh-2rem))]`) with panel-level `overflow-hidden` and `flex flex-col` — the tabbed settings dialog's variant and its only consumer. `sm`/`lg` carry the panel scroll path (`max-h-[calc(100vh-2rem)] overflow-y-auto` on the panel, `p-4` on the backdrop container — the `calc` offset matches that padding so the panel never touches the viewport edge), which is safe for `sm` dialogs and is what keeps a tall pane reachable in a short viewport; `xl` inverts that so the tab rail never jumps between short and tall panels — each tab panel owns its own internal scroll instead. Asserted in `dialog.test.tsx` (default vs `lg` vs `xl` vs `sheet` max-width and placement, the `xl` fixed-height/overflow classes, and the scroll classes on `sm`/`lg`). (260818-bncw-tabbed-settings-dialog)

**Triggers — two registry chords, five palette actions in the layout-level global group, a top-bar gear chip, and two chevron-menu rows** (every one reaches the same `useSettingsDialog()` seam):

- **The `settings-open` chord** — ⌘, on every mac host (browser-reserved in a mac browser, where settings is palette-only), ⇧Ctrl+, on Windows/Linux ([keyboard-and-palette](/run-kit/ui/keyboard-and-palette.md) § The default binding set). A **pure opener**: tab-less `openSettings()` — lands General when closed, a tab-preserving no-op when open (re-fire never closes, never yanks the tab). It is a registry builtin like every other app chord, so it is rebindable per device and its combo surfaces automatically in the shortcuts panel, the palette hint, and the gear's tooltip chip. **Both route shells resolve the handler** — `keybindingHandlers` in `app.tsx` and `boardKeyHandlers` in `board-page.tsx` look the layout-global palette entries up by id over the merged list (§ Dispatch seams), so chord and palette can never drift and no per-shell rewiring exists. The unshifted ⌘, resolves `reserved` in a mac browser because it is the browser's own Preferences accelerator (claimed data, § Claimed keys). (260801-mqim)
- **The `shortcuts-overlay` chord** — ⌘/ on mac hosts, ⇧Ctrl+/ on Win/Linux — a **three-state toggle into the Shortcuts tab**: closed → open on Shortcuts; open on Shortcuts → close; open on another tab → switch to Shortcuts (never close). The registry actionIds `settings-open`/`shortcuts-overlay` are unchanged, so stored per-device override diffs in `localStorage["hexokit-keybindings"]` keep applying. (260818-bncw-tabbed-settings-dialog)
- **Command palette** — five layout-level global entries (`use-global-palette-actions.ts`, § Single palette mount + palette-actions slot): `Settings: Open` (id `settings-open`, the pure opener), `Settings: Appearance` (id `settings-appearance`, `openSettings("appearance")`), `Settings: Agents` (id `settings-agents`, `openSettings("agents")`), `Settings: All` (id `settings-all`, `openSettings("all")` — the registry-table deep-link), and `Help: Keyboard Shortcuts` (id `shortcuts-overlay` — the Shortcuts-tab toggle and the ONLY Shortcuts entry; one action per intent). Each id doubles as the registry actionId where a binding exists, so `withShortcutHints` decorates the entries for free. The dialog itself mounts once in `AppLayout` (§ Design Decisions → Settings dialog mounts at `AppLayout`, not `AppShell`; → One palette mount in AppLayout, routes register via the slot).
- **Top-bar gear chip** — `SettingsGearButton` in `top-bar.tsx` (`GearIcon` from `sidebar/icons.tsx`), the L3-tail fit candidate in the right cluster on ALL four modes, sitting immediately before the exempt overflow chevron (the trailing chevron block stays outermost), consuming `useSettingsDialog()`; under width pressure it degrades to the chevron menu's App-section "Settings" row (`SettingsMenuRow`) (§ Right cluster → Settings gear). Per the tier-1 tooltip system (§ Tier-1 `Tip`), the gear is named via a `Tip label="Settings"` carrying the **host-effective `settings-open` chord** in its `kbd` slot, omitted when unbound/disabled — with an `aria-label="Open settings"` retained and never a native `title=`. The same Tip-not-title rule applies to icon-only controls inside the dialog (the accent-picker button, the font steppers). (260812-d1at)
- **Chevron menu rows** — the overflow menu's App section carries "Settings" (tab-less, like the gear) and "Keyboard shortcuts", a pure **deep-link** calling `openSettings("shortcuts")` directly on the layout-provided context — re-clicking while open on Shortcuts does not close (only the chord/palette entry carries the toggle semantics).

**Instance display name has THREE display consumers, delivered via a root context** — see § Instance Display Name below.

## Host Form Dialog

`app/frontend/src/components/host-form-dialog.tsx` — the ONE Add/Edit host form of the desktop-shell titlebar strip: a mode-discriminated props union (`mode: "add" | "edit"` — narrowed by check, no `as` casts) on the shared `Dialog` shell inside a `z-[60]` wrapper (the strip's menu-stacking treatment — [top-bar](/run-kit/ui/top-bar.md) § Desktop-Shell Titlebar Strip). Both modes render the same field contract: Name (optional) above URL, same labels, same validation copy (the exported `INVALID_HOST_URL_MESSAGE` — `Enter a full http(s) URL, e.g. http://host:6123`), same inline error slot, same Cancel/primary button row; Enter in either field submits. The exported `reduceOrigin(raw): string | null` (full http(s) URL → origin, `null` when malformed) backs BOTH add mode's local validation and the strip's edit-mode save — one check paired with one copy constant.

- **Edit mode** is a pure rendering extraction: the caller owns the save semantics — prefill (`initialName`/`initialUrl`), the diff-against-prefill-then-live-row commit, `servers:rename` / `servers:set-url`, the optimistic row update, and the row refocus — and its `onSubmit` answers with the inline error to show (the dialog stays open) or `null` once the save proceeds (the caller unmounts). `urlEnabled: false` (a shell without `setUrl`) disables the URL field with a "URL editing needs a newer desktop app." note. No connectivity ping on save — a temporarily-down host stays editable.
- **Add mode** owns its submit: local URL validation first (the shared check + copy), then ONE `addShellHostDirect(name.trim(), origin)` invoke ([desktop-shell](/run-kit/desktop-shell.md) § `window.runkitShell` Bridge) — the main process pings before persisting, so a returned `{ ok: false, error }` renders inline in the same error slot and keeps the dialog open for correction. While the invoke is in flight the form is `busy` (fields + submit disabled — the ping can take up to 5s; the spawn-agent in-flight convention). A blank Name auto-derives from the ping's returned hostname main-side. Success fires `onSuccess` — the shell has already switched the window to the new host, so the caller just closes the dialog.

The strip is the only consumer (the edit pencil / F2 path in edit mode, the `+ Add Host…` footer fork in add mode), rendering both modes inside the switcher container (backdrop clicks never trip the menu's outside-click close) and counting them in its `dialogOpen` key-suspension union. Covered by the colocated `host-form-dialog.test.tsx` (both modes — edit save-diff / disabled-URL / inline-error paths; add validation, busy, inline main-side failure, and success) plus the strip suite's footer-fork tests. (260820-d99v-spa-host-form-dialog)

## Marker Pad Popup

`app/frontend/src/components/sidebar/marker-pad.tsx` is the window row's single marker-editing popup. It has one chrome and does not render inside the row flyout card. Its listbox is a three-mode-row grid with one clear cell (`∅`) spanning the rows and three stage cells per mode. The top-left reads `Marker`; the columns are headed `∅`, `1`, `2`, and `3`, with `early`/`mid`/`done` supplied as the numbered headings' accessible labels. The highlighted cell retains its ring and tints its mode-row label and stage-column heading in the marker ink; selecting `∅` tints only the `∅` heading.

The popup fits the measured sidebar width through `markerPadPopoverLayout`: at the 160px sidebar minimum it uses `{width: 152, cellPx: 22, labelPx: 42}`; with room it caps at `{width: 180, cellPx: 26, labelPx: 54}`. `placeMarkerPad` returns row-relative coordinates, vertically centers when unconstrained, and clamps the popup inside every sidebar edge.

Open state is row-local, with a module-scoped `activeMarkerPad` registry enforcing exactly one open pad across all rows, following the `activeFlyout` idiom. A capture-phase document `pointerdown` listener dismisses outside presses while ignoring the pad and its own strip. Pointer and keyboard movement live-preview cells on the row; Escape previews the committed value before cancelling, so dismissal cannot leave a walked highlight painted.

## Overlay Presence

`app/frontend/src/lib/overlay-presence.ts` is the SPA's single "an occluding overlay is open" signal — a module-level **count** of mounted occluding overlays, per kind, with a synchronous subscription. It exists for a surface that cannot be painted over: the desktop shell's native web view (`WebContentsView`) is composited above the SPA's DOM, so nothing the SPA draws — palette, dialog, drawer, menu, toast, tip — can appear over it, and the view hides itself while an occluding overlay is open. The module imports no React and touches no DOM, `window`, or storage.

**API**: `OverlayKind = "modal" | "transient"`; `acquire(kind): () => void` (the returned release is idempotent — a second call is a no-op, the count never goes negative); `count(kind?)` (per kind, or the sum when omitted); `isModalOpen()` (`count("modal") > 0`); `isOccludingOpen()` (`count("modal") + count("transient") > 0` — the native surface's full hide signal); `subscribe(listener): () => void` (fires synchronously, with no payload, after every acquire and every effective release; listeners are iterated over a snapshot so an unsubscribe mid-notify is safe); `_resetForTests()`. The registration rule: `modal` is the blocking-page class (palette, dialogs, drawers); `transient` is the click-opened menu class — a click-opened menu, dropdown, popover, or context menu registers `transient` while open. Tooltips (`tip.tsx`) and hover-opened flyout cards register NOTHING — hiding the native view on every hover would flicker the page.

**Hook**: `hooks/use-occludes.ts` — `useOccludes(kind, open)` holds a registration while `open` is true and releases on `open → false` and on unmount; called above any early `return null`. A component that only mounts while open passes `true`. StrictMode's effect double-invocation settles at one registration.

**Registering surfaces** (`modal`, the full inventory):

| Surface | Predicate |
|---------|-----------|
| Command palette (`command-palette.tsx`) | `open` |
| `Dialog` primitive (`dialog.tsx`) — one call covers every consumer, the settings dialog's panels included | `true` while mounted |
| Theme selector (`theme-selector.tsx`) | `open` |
| Cron entry detail sheet (`cron-entry-detail-sheet.tsx`), modal variant only | `!inline` |
| Quake drawer (`quake-terminal.tsx`) | `open` — the mount flag, true through the exit slide, so a hidden surface re-shows once the drawer has left the stage |
| Screen-break egg (`screen-break.tsx` `ScreenBreak`) | `flight !== null` — the whole 12 s flight, heal included |
| Mobile sidebar drawer (`shell/shell.tsx`) | `drawerActive` (`isMobile && sidebarOpen && !!sidebarChildren`) |
| Color picker modal mount (`app.tsx` `AppShell`) | `showColorPicker !== null` — the bespoke shell with a full backdrop around `SwatchPopover` |

**Registering surfaces** (`transient`, the click-opened menu inventory): the top-bar overflow/View menu (`top-bar-overflow-menu.tsx`), the top-bar Split split-button (`top-bar.tsx`), the status-bar menu (`status-bar.tsx`), the bottom-bar function-key menu (`bottom-bar.tsx`), the desktop titlebar-strip menu (`desktop-shell/titlebar-strip.tsx`), the tile-header export menu (`surface-layout.tsx`), the layout chip (`layout-chip.tsx`), the compose-history flyout (`compose-history-flyout.tsx`), the GUI toolbar menu (`gui-toolbar-menu.tsx`), the breadcrumb dropdowns (`breadcrumb-dropdown.tsx` — window/board/session switchers), the marker pad (`sidebar/marker-pad.tsx`), the pin popover (`sidebar/pin-popover.tsx`), the swatch popover (`swatch-popover.tsx`), and the Open split-button (`open-button.tsx`). Mount-only-while-open surfaces pass `true`; open-state surfaces pass their `open`.

**Not registered**: `Tip` tooltips and hover-opened flyout cards (`sidebar/row-flyout-card.tsx`, opened by `useHover` with `safePolygon`) register nothing — both fire on hover, and hiding the native view on hover would flicker the page (§ Design Decisions → Click-opened menus register `transient`; hover surfaces register nothing). The inline cron sheet needs none (it lives inside the registered quake drawer). Toasts are neither: on desktop they sit over the status bar, off the stage (§ Error toast system).

**Consumer seam**: readers call `subscribe` + `isOccludingOpen()` (or `useSyncExternalStore(subscribe, isOccludingOpen)` in React). The subscriber is the web tile's native engine (`components/web-frame-native.tsx` — [lenses-and-layout](/run-kit/ui/lenses-and-layout.md) § Web Tile): it reads `overlayOpen` via `useSyncExternalStore(subscribe, isOccludingOpen, () => false)` and hides its guest (`web:visible {false}`) while an occluding overlay is open, re-showing — after a fresh bounds measure — on release. Covered by `lib/overlay-presence.test.ts`, `hooks/use-occludes.test.tsx`, `components/menu-occludes.test.tsx` (acquire-on-open/release-on-close across the transient inventory), and one acquire/release assertion in each registering component's colocated test. (q2xk, ckpm)

## Zustand Window Store

Window optimistic state is managed by a Zustand store at `app/frontend/src/store/window-store.ts`. This is the single source of truth for what windows are visible and what their display names are during the period between a user action and its SSE confirmation.

**Store location**: `app/frontend/src/store/window-store.ts`

**Store shape:**

```ts
// Flat entry type (not WindowInfo & {...} — stores only the fields needed for display)
type WindowEntry = {
  session: string;
  windowId: string;
  index: number;
  name: string;
  pendingName?: string;    // non-undefined = optimistic rename, pending SSE confirmation
  killed: boolean;         // true = optimistically hidden, pending SSE confirmation
  webOverride?: { webTabs?: string[]; webActive?: number };  // optimistic web-tab family, display only
};

type GhostWindow = {
  optimisticId: string;    // client-generated unique key for React rendering / rollback
  session: string;
  name: string;
  createdAt: number;
  snapshotWindowIds: Set<string>; // windowIds present in session at creation time
};

type WindowStore = {
  entries: ReadonlyMap<string, WindowEntry>;  // keyed by windowId (@N)
  ghosts: GhostWindow[];
  // actions (the only ways to mutate window state):
  setWindowsForSession(session, incoming): void;
  addGhostWindow(session, name, currentWindowIds?: Iterable<string>): string;  // returns optimisticId
  removeGhost(optimisticId): void;
  killWindow(session, windowId): void;
  restoreWindow(session, windowId): void;
  renameWindow(session, windowId, newName): void;
  clearRename(session, windowId): void;
  clearSession(session): void;
};
```

**Key identifier**: `windowId` is the tmux `@N` value (e.g., `"@3"`). It is globally unique per tmux server, assigned at window creation, and never renumbered. It is used as the store key — not the mutable numeric index.

**`MergedWindow` type**: defined in and exported from `app/frontend/src/store/window-store.ts`. Includes `windowId: string` as a required non-optional field.

**Action surface (minimal by design)**:

| Action | Effect |
|--------|--------|
| `setWindowsForSession(session, incoming)` | SSE reconciliation — merges by `windowId`, preserves `killed`/`pendingName`/`webOverride`, removes absent windows, reconciles ghosts |
| `addGhostWindow(session, name, currentWindowIds?)` | Creates a ghost entry; returns `optimisticId` for rollback |
| `removeGhost(optimisticId)` | Removes a ghost by ID (API failure rollback) |
| `killWindow(session, windowId)` | Sets `killed: true` |
| `restoreWindow(session, windowId)` | Sets `killed: false` (API failure rollback or always-settled cleanup) |
| `renameWindow(session, windowId, newName)` | Sets `pendingName` |
| `clearRename(session, windowId)` | Clears `pendingName` (settled or rollback) |
| `setWebOverride(server, session, windowId, override)` | Merges an optimistic web-tab family override (`webTabs?`/`webActive?`) into the entry |
| `clearWebOverride(server, session, windowId)` | Clears the web override (SSE confirmed, rollback, or route change) |
| `swapWindowOrder(session, srcIndex, dstIndex)` | Swaps index values of two entries (optimistic reorder); no-op if either missing |
| `clearSession(session)` | Removes all windows and ghosts for the session |

**SSE sync**: `AppShell` (in `app.tsx`) calls `setWindowsForSession(s.name, s.windows)` for each session in a `useEffect` on `rawSessions`. This keeps the store in sync with the SSE ground truth.

**Ghost reconciliation**: When `setWindowsForSession` is called, it computes `newIds = incomingIds − priorKnownIds`. For each ghost (oldest first) whose `snapshotWindowIds` does not contain any element of `newIds`, the ghost is removed.

**useMergedSessions**: `useMergedSessions` in `optimistic-context.tsx` derives window data from the Zustand store rather than from raw `session.windows`. For each session: filters `killed: true` entries, applies `pendingName ?? name` for display, sorts by `index`, then appends ghosts.

**Consumers use the store via `useWindowStore()` hook**:
```ts
const { killWindow, restoreWindow, renameWindow, clearRename, swapWindowOrder } = useWindowStore();
```

**Session/server state** (ghost sessions, ghost servers, session kill/rename) remains in `OptimisticContext` — these use name-based keys and are not subject to index-collision bugs.

## Optimistic UI & Mutation Feedback

All mutating API calls use the `useOptimisticAction` hook (`app/frontend/src/hooks/use-optimistic-action.ts`) which provides `{ execute, isPending }`. The hook calls `onOptimistic` synchronously before the async API call, tracks `isPending`, and calls `onRollback`/`onError` on failure and `onSettled` on success. An unmount guard (`mountedRef`) prevents state-after-unmount warnings.

**Callback contract** — four optional result callbacks with distinct mount-safety guarantees:

| Callback | Called on | Mount guard | Use for |
|----------|-----------|-------------|---------|
| `onAlwaysSettled` | success | none — always fires | Root-level context cleanup (e.g., `unmarkKilled`) |
| `onAlwaysRollback` | failure | none — always fires | Root-level context cleanup (e.g., `unmarkKilled`) |
| `onSettled` | success | behind `mountedRef` | Local component state updates |
| `onRollback` | failure | behind `mountedRef` | Local component state updates |

`onAlwaysSettled`/`onAlwaysRollback` MUST be safe to call after the initiating component unmounts — i.e., they may only interact with root-level stores/contexts like `OptimisticContext` or the Zustand window store (both always available for the lifetime of the app). Using local component state or `setState` in these callbacks will cause state-after-unmount warnings. Use `onSettled`/`onRollback` for anything that touches local component state.

`onError` is also behind the `mountedRef` guard (safe to call `addToast` — `ToastProvider` is root-level, but error display is only meaningful when the user can see it).

**Three feedback patterns:**

1. **Ghost entries** (CRUD operations): Creating a session/window/server immediately inserts a ghost entry with `opacity-50 animate-pulse` styling. SSE reconciliation auto-clears ghosts when real data arrives. Failure removes the ghost and shows an error toast. Kill operations immediately hide the entry; failure restores it. Rename operations immediately update the displayed name; failure reverts. **Window** ghost/kill/rename state is managed by the Zustand window store (`app/frontend/src/store/window-store.ts`); **session and server** ghost/kill/rename state remains in `OptimisticProvider` context (`app/frontend/src/contexts/optimistic-context.tsx`). Both feed into `useMergedSessions(realSessions, currentServer)` which filters session-level overlays by `currentServer` (so cross-server ghosts/kills/renames don't leak — see "Server Capture Convention" below) and merges with SSE data.

2. **Button loading states** (fire-and-forget): Split pane and close pane top-bar buttons show a spinner SVG (`animate-spin`) and `disabled` attribute during `isPending`. Command palette equivalents use the same hook for error toast feedback (palette closes, so spinner not visible).

4. **Field-overlay state** (single-writer route state): the terminal route's surface layout rides a `pendingLayout { key, value }` overlay in `app.tsx` — the ONE field case that is NOT a Zustand-store ghost/kill/rename row. `applyLayout` sets it before POSTing `@rk_win_layout`; the rendered layout is `effectiveLayout({ ...window, layout: pendingLayout.value })` while `key` matches the current route, and it clears when the SSE payload's `layout` equals the pending value, on POST rejection (revert to the payload value; the failure surfaces through the mutation-feedback path), or on a route change. The overlay lives in `app.tsx` state, not the window store: the layout has exactly one writer surface (the terminal route) and one consumer, and the store's optimistic machinery is ghost-row shaped, not field-override shaped. Degradation still applies to the pending value, so tiles reorder immediately and never flicker back when the tick confirms. (iip5)

5. **Per-window field override in the Zustand store** (the web-tab strip's select/remove verbs): the strip's verbs ride the store's per-entry `webOverride { webTabs?, webActive? }` (`SurfaceLayout`'s `useOptimisticAction` pair — display only): select sets `{ webActive: n }`; remove sets the locally shifted family from the pure `webFamilyAfterRemove(tabs, active, n)` (a display-only mirror of the backend's repoint rule — slots past `n` shift down, the pointer becomes 0 on an emptied family, `min(n, newLen)` when it pointed at `n`, `active-1` when past `n`), compounding on any in-flight override so back-to-back closes shift the family the user is looking at, not the stale payload. The verb POST wakes the SSE hub; a `SurfaceLayout` reconcile effect clears the override once the payload's `webTabs`/`webActive` match it (the `pendingName` discipline), a rejection rolls the override back and toasts the error, and a window switch drops it via the parent's `${server}:${windowId}` key. ADD is NOT optimistic — the slot index is server-assigned, so the new tab renders on the confirming tick. (9kip)

3. **Inline progress** (async data): File upload shows an "Uploading..." badge in the terminal area. Directory autocomplete shows a spinner in the path input trailing slot. Server list refresh shows a spinner on the dropdown trigger.

**Error toast system**: `ToastProvider` + `Toast` component (`app/frontend/src/components/toast.tsx`). The stack (`data-testid="toast-stack"`) anchors `fixed bottom-1 right-2` on desktop — over the status bar's right end, off the stage (a native web view in the desktop shell paints above the SPA and would hide a stage-anchored toast) and off the top bar (whose controls must stay hit-testable) — and `fixed bottom-4 right-4` on mobile (`useIsMobile()`: no status bar and no native view there); toasts auto-dismiss after 4 seconds and stack upward from the anchor. Error variant has `var(--color-ansi-1)` (red) left accent border; info variant uses `var(--color-ansi-4)` (blue). Theme-aware via CSS custom properties. Despite the "error" name it is the general toast surface (the `info` variant carries success/neutral messages). `addToast(message, variant?, action?, onDismiss?)` takes an optional THIRD positional `action?: { label, onSelect }` (260718-gxrq) rendered as a keyboard-focusable `<button>` inside the toast body — selecting it dismisses the toast then runs `onSelect`; an optional FOURTH positional `onDismiss?: () => void` fires ONLY when the toast TIMES OUT (it is not fired when `action` was selected — the action owns its own follow-up); three-arg call sites stay valid. Used for the post-pin "Pinned to <board>" + "View board" toast (§ Post-pin success feedback + toast optional action), and the post-reopen "Resume agent" toast action whose onTimeout dismisses the closed record (§ Recently-closed mirror below).

**Type guard**: `isGhostWindow(win)` exported from `optimistic-context.tsx` — narrows `WindowInfo | MergedWindow` to `MergedWindow & { optimistic: true }`. Used in the sidebar and the `SessionTiles` density view instead of `as` casts. `MergedWindow` type is defined in and exported from `app/frontend/src/store/window-store.ts`; it includes `windowId: string` as a required non-optional field.

### Window Kill: Zustand Store Handles Kill Cleanup

Window kill state is tracked in the Zustand window store by `windowId` (the immutable tmux `@N` identifier), not by mutable index.

**Kill flow** (`useOptimisticAction` pattern):
- `onOptimistic`: calls `windowStore.killWindow(session, windowId)` — sets `killed: true` in the store
- `onAlwaysRollback` (API failure): calls `windowStore.restoreWindow(session, windowId)` — clears `killed`
- `onAlwaysSettled` (API success): calls `windowStore.restoreWindow(session, windowId)` — clears `killed` (SSE absence will remove the entry once tmux confirms)

When the next SSE update arrives without the `windowId`, `setWindowsForSession` removes the entry from the store entirely — regardless of whether `killed` is set. No explicit `confirmKill` action is needed.

**Four `useOptimisticAction` instances** use this pattern, and every window-kill `action` awaits the response and pushes its `closed` record via `pushRecentlyClosed(srv, res.closed)` when present (the `srv` is the per-call captured server — Shape B; a `closed`-less response pushes nothing):

| Instance | File | Kill path |
|----------|------|-----------|
| `executeKillWindow` | `app/frontend/src/components/sidebar/index.tsx` | Ctrl+Click direct kill |
| `executeKillFromDialog` | `app/frontend/src/components/sidebar/index.tsx` | Confirmation dialog kill — the push rides the window arm only (the session arm has no `closed` record) |
| `executeKillWindow` | `app/frontend/src/hooks/use-dialog-state.ts` | Command palette kill |
| `executeKillWindow` (cross-server push) | `app/frontend/src/components/board/board-page.tsx` | Board-row kill — the kill response's `closed` goes onto ITS server's mirror (the route server's mirror is the palette gate) |

### Recently-closed mirror (`useRecentlyClosed`)

The server-side `{server}.closed/` ring ([layout-snapshots](/run-kit/layout-snapshots.md) § Recently-closed window ring) is the AUTHORITY; the frontend keeps only a module-level mirror string-keyed per server (`stacks: Map<string, ClosedWindow[]>` inside `hooks/use-recently-closed.ts`, exported helpers `pushRecentlyClosed(server, rec)`/`popRecentlyClosed(server, id)` plus the `buildReopenWindowAction(stack, onReopen)` palette-entry builder). The mirror exists ONLY to gate the `Tab: Reopen closed` palette entry and render its description — the server record is authoritative. It is seeded by `listClosedWindows(server)` on each `useRecentlyClosed(server)` hook mount (fail-silent — the gate just stays hidden until the next mount), pushed from every window-kill response that carries `closed` — the ⌘W/palette dialog executor (`use-dialog-state.ts`), the sidebar's Ctrl+Click and kill-dialog executors (`components/sidebar/index.tsx`, window arm only; asserted by the "window kills push the recently-closed record" tests in `index.core.test.tsx`) (thxr), bulk close (`app.tsx` `executeBulkClose`), and the board route's `executeKillWindow` — and popped on reopen/dismiss/409. Every subscriber redraws via `useSyncExternalStore` (the same no-React-state-shape as `use-local-storage-enum.ts`). A top-of-stack only entry (`buildReopenWindowAction` returns `[]` on an empty stack) carries id `reopen-window`, description `"<name> — fresh shell in <session>"`, so `withShortcutHints` renders the effective combo on the row. On a `409` session-gone reopen the mirror pops too — the backend already dropped the record, so the entry would be a dead end.

**Session kills are unaffected**: Session names are stable across kills (tmux never renumbers sessions). Session kill/restore remain in `OptimisticContext`.

### Cross-Session Move: Compound Optimistic Update

The `executeMoveToSession` hook in `sidebar/index.tsx` combines two store actions (`killWindow` + `addGhostWindow`) for a single optimistic update. This is the only `useOptimisticAction` instance that performs a compound optimistic mutation (hiding in one session while inserting a ghost in another). The ref-based `lastMoveToSessionRef` stores `{ srcSession, windowId, optimisticId }` so `onAlwaysRollback` can reverse both operations even after the component navigates away.

### Server Capture Convention (Optimistic Actions)

The `server` argument that scopes a mutation to a tmux server is **always captured at user-event time**, never read from an ambient module-level global, never frozen at component mount. This is enforced both by the API client signature (every server-scoped function takes `server: string` as its first arg — see `tmux-sessions.md` → "Frontend Server Routing Contract") and by the React handler shape on every call site.

#### The two compliant capture shapes

**Shape A — explicit capture inside `useCallback`**: read `server` from `useSessionContext()` at component scope, list it in the callback's deps array, and pass it as the first argument to the action when the user-event handler fires:

```tsx
const { server } = useSessionContext();
const handleRenameSession = useCallback(() => {
  if (!renameSessionName.trim() || !sessionName) return;
  executeRenameSession(server, sessionName, renameSessionName.trim());
  setShowRenameSessionDialog(false);
}, [renameSessionName, sessionName, server, executeRenameSession]);
```

**Shape B — `server` threaded through the `useOptimisticAction` argument tuple**: extend the tuple's first slot to `string` and forward it inside `action`. This is the standard shape for hooks like `executeRenameSession`, `executeKillFromDialog`, `executeMoveToSession`, etc.:

```tsx
const { execute: executeRenameSession } = useOptimisticAction<[string, string, string]>({
  action: (srv, oldName, newName) => renameSession(srv, oldName, newName),
  onOptimistic: (srv, oldName, newName) => {
    lastRenameSessionRef.current = { server: srv, name: oldName };
    markRenamed("session", srv, oldName, newName);
  },
  onRollback: () => {
    const last = lastRenameSessionRef.current;
    if (last) unmarkRenamed(last.server, last.name);
  },
  ...
});
```

**Refs that bridge async callbacks** (e.g., `lastKillSessionRef`, `lastRenameSessionRef`, `killDialogServerRef`) snapshot `{ server, name }` together inside `onOptimistic`, so `onAlwaysRollback`/`onAlwaysSettled` can target the originating server even if the user has switched servers by the time the API resolves. Snapshotting the name without the server is a bug — rollback would invalidate the wrong server's overlay.

#### Optimistic overlays carry `server` (session-level)

`OptimisticContext` (`app/frontend/src/contexts/optimistic-context.tsx`) stores session-level entries with their originating `server` and filters by `(server, name)` at render time. The discriminated-union types reflect this:

```ts
type GhostEntry =
  | { optimisticId: string; type: "session"; name: string; server: string }
  | { optimisticId: string; type: "server"; name: string };

type KilledEntry =
  | { type: "session"; identifier: string; server: string }
  | { type: "server"; identifier: string };

type RenamedEntry = { type: "session"; identifier: string; newName: string; server: string };
```

API surface (session-level entries take `server` first; server-level entries are global):

| Method | Signature | Notes |
|--------|-----------|-------|
| `addGhostSession` | `(server, name) => optimisticId` | Session ghost |
| `addGhostServer` | `(name) => optimisticId` | Server ghost — global, no `server` arg |
| `markKilled("session", server, name)` | overload | Session kill |
| `markKilled("server", name)` | overload | Server kill — global |
| `unmarkKilled("session", server, name)` | overload | Mirror of `markKilled` |
| `unmarkKilled("server", name)` | overload | Mirror of `markKilled` |
| `markRenamed("session", server, name, newName)` | required `server` | |
| `unmarkRenamed(server, name)` | required `server` | |
| `useMergedSessions(real, currentServer)` | filter | Drops session-level overlays whose `server !== currentServer` |

`useMergedSessions` filters ghosts/kills/renames by `currentServer` before applying them. SSE reconciliation only inspects ghosts whose `server === currentServer` so the other server's pending state is left intact when the user switches servers and back.

**Window-store entries are NOT keyed by server** — windows cannot migrate across tmux servers (`MoveWindowToSession` operates within a single server, and there is no cross-server move API). The `windowId` (tmux `@N`) is unique per server, and `setWindowsForSession` is only ever called with data for the active server. Adding `server` to the window-store key would be defensive bookkeeping with no failure mode to defend against.

#### General rule: don't introduce ambient state for request parameters

Any value that scopes an HTTP request to a particular backend resource (server, project, account, tenant) MUST be passed as an explicit argument to the API call, captured at user-event time. Module-level mutable getters, refs read at fetch time, or context reads inside the action callback (rather than the handler) all create the same closure-race shape. If a value travels with a mutation, it travels in the call signature — period.

The regression test in `app/frontend/src/hooks/use-dialog-state.test.tsx` flips `SessionProvider`'s `server` prop between `openRenameSessionDialog("foo")` and `handleRenameSession()` and asserts the API call uses the post-flip server (`server-B`), proving the capture point is the handler invocation, not the dialog open.

## Design Decisions

### One folder-first New sheet with a level switch, not per-level dialogs
**Decision**: Tab, Group, and Workspace creation share one sheet whose primary input is the folder; the level is a switch inside it, names derive from the folder, and a live preview states the outcome. Chords and one-click `+` creates stay instant and never open it.
**Why**: names already derive from folders everywhere (tmux auto-names tabs; instant groups use `deriveNameFromPath`), so the folder is the real input and the name is an optional override. One grammar replaces three (name-only workspace dialog, instant group, instant tab) and the window-only at-folder dialog; keeping both pickers would duplicate the folder UI.
**Rejected**: Per-level dialogs (three grammars); a menu without a sheet (cannot pick folders); remembering the last level per opener (the opener names the intent).
*Introduced by*: 261030-6d2o-folder-first-new-sheet

### The sheet is presentational; `NewSheetHost` owns targets and create actions
**Decision**: `NewSheet` receives its target and reports `onSubmit`; a single layout-mounted `NewSheetHost` resolves the workspace/group/context folder, snapshots them per request, and runs the create action, opened through `new-sheet-context`.
**Why**: the opener seam must serve boards, host pages, and later split-button/per-group callers — `AppShell`-owned state would not reach them. Snapshotting keeps SSE ticks from moving the prefill under the user.
**Rejected**: Sheet state inside `AppShell`; reading live sessions inside the sheet.
*Introduced by*: 261030-6d2o-folder-first-new-sheet

### The optimistic create lifecycle lives once per level, in hooks
**Decision**: `useCreateGroup` / `useCreateTab` / `useCreateWorkspace` own ghost → API → rollback + toast for every opener; the group hook carries a one-in-flight guard that returns `false` on a refused call.
**Why**: the group lifecycle had been copied across `app.tsx`, the board page, and the sheet; a copy that could not see the others' ghost state stranded ghosts on a second submit. A boolean return lets the sheet keep itself open instead of dropping the submit.
**Rejected**: Per-opener `useOptimisticAction` copies; a guard that silently swallows (the user sees the sheet close and nothing happen).
*Introduced by*: 261030-6d2o-folder-first-new-sheet

### Name override is a button as well as a chord
**Decision**: The footer carries a visible `Name it…` button for Group/Workspace (mobile included) that opens the same override as `⌘↵`/`Ctrl+↵`.
**Why**: the chord alone left touch and pointer users unable to name a workspace from the palette's `Workspace: Create`.
**Rejected**: A hint-only footer; a permanently visible name field (puts a derived value on the primary path).
*Introduced by*: 261030-6d2o-folder-first-new-sheet

### Single-open registry over event-plumbing dismissal
**Decision**: `marker-pad.tsx` owns a module-scoped `activeMarkerPad` handle; opening any pad closes the currently registered one. A capture-phase document `pointerdown` listener remains alongside it.
**Why**: A strip press stops propagation, so a registry makes the single-open invariant independent of every event handler on the path. The codebase uses the same shape for row flyouts.
**Rejected**: Capture-phase outside dismissal alone, which leaves the invariant coupled to event plumbing; hoisting open state into React context, which would re-render unrelated rows.
*Introduced by*: 260830-imj9-marker-pad-spring-loaded-gesture

### One marker-pad chrome; the coarse entry is the strip
**Decision**: The marker pad has one popup chrome. A coarse-pointer tap on the 36 × 36px marker strip opens that same pad in click-menu mode.
**Why**: One chrome keeps one keyboard model, placement path, and test surface, while the 56px right-edge rail remains the sole coarse flyout trigger.
**Rejected**: A Marker row inside the row flyout card; leaving coarse pointers with only the command-palette path.
*Introduced by*: 260830-imj9-marker-pad-spring-loaded-gesture

### The pad names itself; the labels carry the selection

**Decision**: the pad's top-left reads `Marker`, stage columns are headed `1`/`2`/`3`, and the
highlighted cell tints its mode-row label and stage-column heading in the marker ink. The
`<mode> · <gloss>` header line is deleted.
**Why**: the top-left is where a reader looks for the name of the surface, and spending it on the
current value duplicated what the highlight ring already showed. Tinting the two labels states the
selection on the axes themselves, which also labels the previously unlabelled ordinal axis.
**Rejected**: keeping the value line and adding a separate title row, which costs a second line of a
pad that must fit a 160px sidebar; and labelling columns with the gloss words (`early`/`mid`/`done`),
which does not fit the cell width — the gloss is retained as the headings' accessible label instead.
*Introduced by*: 260830-hbsr-marker-track-and-pad-refinements

### Marker-pad width derives from the measured sidebar
**Decision**: `markerPadPopoverLayout(sidebarWidth)` computes popup width, cell pitch, and label-track width; the label track shrinks before a cell drops below 22px.
**Why**: The sidebar supports a 160px minimum, so a fixed 180px popup cannot remain inside its placement bounds.
**Rejected**: A fixed popup with horizontal scrolling; a portal outside the sidebar, which would separate the relative gesture from its row anchor.
*Introduced by*: 260830-imj9-marker-pad-spring-loaded-gesture

### The server record is the authority; the mirror exists only to gate the palette entry
**Decision**: `useRecentlyClosed(server)` keeps a per-server module-level `Map<string, ClosedWindow[]>` mirror (exported push/pop helpers) seeded from `GET /api/windows/closed` on mount, pushed from kill responses, and popped on reopen/dismiss/409 — a `useSyncExternalStore` React seam — but the server-side `{server}.closed/` ring stays authoritative.
**Why**: A client-only stack loses the record across reloads and cannot capture `@rk_win_web_<n>_root` (omitted from `ListWindows`); the mirror is the cheap way to gate the `Tab: Reopen closed` entry and render its description without a refetch per palette open, while the server keeps the record the toast's resume action must still resolve.
**Rejected**: Zustand slice in `store/window-store.ts` (the ghost/kill/rename overlay is window-shaped, not ring-shaped, and a module-scope map is cheaper); re-fetching the ring on every palette open (the gate would flicker).
*Introduced by*: 260829-11t0-reopen-closed-tab-recently-closed-stack

### Window-switch feedback stays optimistic
**Decision**: window-switch navigation stays optimistic — the heading/URL flip at click (acknowledged intent) and the sidebar highlight stays SSE-derived (confirmation); the slide plays only on confirmed-fast arrival, with a pending mask + failure bounce-back layered on.
**Why**: keeps the terminal rendering immediately while giving each visual state an honest, distinct signal.
**Rejected**: pessimistic navigation (waits for confirmation before flipping); a dimmed overlay.
*Introduced by*: 260715-38kg-window-switch-confirmed-motion

### Settings dialog mounts at `AppLayout`, not `AppShell`
**Decision**: The settings dialog + its `SettingsDialogContext` mount once at `AppLayout` (the persistent every-page layer), not `AppShell`. Instance display-name delivery lives in a separate root-mounted `InstanceNameProvider` (in `RootWrapper` beside `InstanceAccentProvider`), not in `SettingsDialogContext`.
**Why**: `AppShell` is server-scoped (assumes non-null `currentServer` throughout `app.tsx`), so mounting there would leave the dialog unavailable on `/board/$name`, which renders inside `AppLayout` without `AppShell` — and board coverage is the whole point of the every-page mount. Three display surfaces plus the dialog editor need one live-updating `{hostname, instanceName}` state — the exact fetch-once + optimistic-set + multi-surface-repaint shape `InstanceAccentProvider` already established; keeping it out of the chrome-only `SettingsDialogContext` avoids mixing chrome state with instance data and keeps the provider above the `RootTopBar` consumers anyway.
**Rejected**: mounting at `AppShell` (dead on boards); a module-level name cache (no reactivity path for the dialog's live edit); putting the name pair in `SettingsDialogContext` (mixes chrome and instance data).
*Introduced by*: 260723-o7q8-settings-dialog

### The restart confirm shares the off-confirm's shell
**Decision**: extract the one-shot status fetch + apps-list rendering from `gui-off-dialog.tsx` into a shared shell consumed by both `GuiOffDialog` and the new `GuiRestartDialog`; the restart dialog mounts once at AppLayout behind a `GuiRestartRequest` context.
**Why**: the same destructive-action grammar (list what dies, confirm) for a second consumer; a context-mounted single dialog is how the off-confirm already reaches both the palette and the settings seam.
**Rejected**: parameterizing `GuiOffDialog` with mode props (two unrelated POST paths in one component); a second copy of the fetch/apps rendering.
*Introduced by*: 260910-pp6o-gui-desktop-picker

### Dialog theme control embeds the shared picker core, never dispatches the modal
**Decision**: The dialog's theme surface renders the shared `ThemePickerList` core inline (mode buttons above it, `setTheme()` wiring underneath), rather than dispatching the `"theme-selector:open"` event to reuse the top-bar `ThemeSelector` modal. Checkmark placement is a core prop (`checkedIds`): the dialog checks both preferred slots at once, the modal checks only its open-time active theme.
**Why**: `ThemeSelector` is mounted only inside `AppShell` (`app.tsx`), so the event has no listener on `/board/$name` — the dialog's core every-page-mount promise — and dispatching it would stack a modal on a modal (both `z-50`, Escape-handler interference). The shared core keeps the two surfaces drift-proof while `setTheme(id)` keeps owning slot updates + the partial-merge POST + localStorage sync. The dual-slot check preserves the one thing per-mode controls showed that a single active check would lose; the modal's contract stays unchanged.
**Rejected**: dispatching `theme-selector:open` from the dialog (dead on boards, modal-on-modal stacking); moving the `ThemeSelector` mount to `AppLayout` (a behavior change to an unrelated surface); two plain `<select>`s per mode (no search, swatches, or preview — the picker core provides all three with the same wiring); dual checks in the modal too (an unrequested modal behavior change).
*Introduced by*: 260819-qkow-settings-inline-theme-picker

### Agents is a curated tab over the fab CLI, not a registry-table extension
**Decision**: fab-kit's machine-wide config surfaces as its own curated **Agents** tab (rail between Appearance and Shortcuts) backed by `/api/fab-config`, while the All-settings table stays the `internal/settings` registry for hexokit's own `config.yaml`; the tab re-fetches on every mount and renders the fresh document each POST returns.
**Why**: the two config homes have different owners and write paths (the registry serializer vs. the `fab config` CLI, which preserves comments and its reference fence and validates keys) — one tab per owner keeps provenance (system/env/default chips, env-shadow warnings) honest and Constitution IV's single settings surface intact; no cache because fab-kit, the user's shell and `fab config upgrade` write the same file (Constitution II, external writes win).
**Rejected**: a second settings dialog or page (Constitution IV); merging fab keys into the All-settings table (two owners, two sources); an "Open fab config in the code tile" footer link (no seam opens an arbitrary absolute path — a copy-path control stands in).
*Introduced by*: 261030-wf1x-fab-system-config-agents-tab

### Tab state lives in SettingsDialogContext
**Decision**: `activeTab` + `openSettings(tab?)` live in `SettingsDialogContext`, not in dialog-local state.
**Why**: The deep-link writers (global palette entry bodies, the chevron menu row) live outside the dialog body; context state lets them target a tab without prop drilling or a CustomEvent side channel, and the context is already the dialog's open/close seam.
**Rejected**: dialog-local tab state + a CustomEvent carrying the tab (a second event seam alongside the context that already owns open/close); a router search param (Constitution IV — settings are not a route).
*Introduced by*: 260818-bncw-tabbed-settings-dialog

### Chord semantics stay per-binding: toggle for shortcuts, pure opener for settings-open
**Decision**: `shortcuts-overlay` keeps its documented TOGGLE behavior, refined for tabs (closed→open on Shortcuts; open-on-Shortcuts→close; open-elsewhere→switch to Shortcuts). `settings-open` stays a pure opener (re-fire = no-op, never closes, never yanks the tab).
**Why**: Each binding preserves its established semantics — settings-open is open-only per the macOS ⌘, convention (260801-mqim); the overlay chord toggles — so muscle memory survives the consolidation. Switch-not-close on the third state: a user pressing "show me shortcuts" while looking at Appearance wants shortcuts, not a closed dialog.
**Rejected**: making both toggles (contradicts the settings-open decision); close-on-any-tab for the shortcuts chord (punishes the switch intent).
*Introduced by*: 260818-bncw-tabbed-settings-dialog

### Two-level model: curated tabs + everything-table
**Decision**: keep General/Appearance/Agents/Shortcuts curated and add an All-settings registry table tab; seven keys deliberately appear in both presentations over one dialog-level state seam.
**Why**: the VSCode settings-UI/settings.json model the user chose — palatable curated controls plus an exposes-everything surface that future registry keys join for free; one state seam makes duplication drift-proof.
**Rejected**: replacing General/Appearance with the flat list (loses the curated UX); a yaml view (browser never sees file bytes — a client-side rendering is a second serializer that drifts and drops comments; serving/writing raw bytes is forbidden backend surface; the omit-when-default file is near-empty so the table strictly dominates).
*Introduced by*: 260823-5r41-settings-pane-live-apply

### Window kill state is keyed by `windowId`, not index
**Decision**: Optimistic window-kill state lives in the Zustand window store keyed by the tmux `@N` `windowId` (immutable, never renumbered), not by the window's numeric index.
**Why**: tmux renumbers window indices when a window is killed, so index-keyed kill state suppresses the *next* window that slides into the killed index — an index-collision bug that is invisible until SSE reconciles.
**Rejected**: tracking kill state by numeric index; an explicit `confirmKill` action (SSE absence already removes the entry).

### `server` is captured at user-event time, never read ambiently
**Decision**: Every server-scoped mutation takes `server` as an explicit first argument, captured when the React handler fires (Shape A or Shape B in § Server Capture Convention); refs that bridge async callbacks snapshot `{ server, name }` together.
**Why**: Dereferencing live state at fetch time retargets the request whenever the user switches servers between intent and dispatch — most commonly via Cmd+K's near-instant server switcher between opening a rename dialog and pressing Enter. The optimistic overlay hides the bug until SSE reconciles (~2–5 s later), so it surfaces as random renames/kills landing on the wrong server with a flicker on rollback.
**Rejected**: a module-level closure (`_getServer`) wired to `serverRef.current`; refs read at fetch time; context reads inside the `action` callback rather than the handler; snapshotting a name without its server.

### The spawn-agent busy label is indeterminate
**Decision**: The spawn-agent dialog shows one indeterminate busy label (`LogoSpinner` + "Spawning: worktree → window → agent…") with no per-step progression.
**Why**: The spawn endpoint is synchronous and emits no per-step events, so there is nothing to drive a stepper.
**Rejected**: streaming per-step progress (needs a new SSE/long-poll seam, out of proportion for the feature).

### Ghost reconciliation is set-difference, not count-based
**Decision**: `setWindowsForSession` reconciles ghosts by set difference — `newIds = incomingIds − priorKnownIds`, removing each ghost (oldest first) whose `snapshotWindowIds` contains none of `newIds`.
**Why**: Concurrent creates and deletes in the same SSE tick keep the counts consistent while the identities differ, so identity comparison is the only one that survives them without false positives.
**Rejected**: count-based ghost reconciliation.

### The worktree field carries no pre-filled name
**Decision**: The spawn-agent dialog's Worktree input is blank by default, carrying only the placeholder `auto-named (e.g. swift-fox)`; a blank value lets `wt` auto-name.
**Why**: `wt` exposes no name-suggest seam, so any pre-filled value would have to be generated locally.
**Rejected**: reimplementing `wt`'s name generator in the frontend (constitution §III).

### Overlay presence is a count, not a focus read
**Decision**: A module-level counter of mounted occluding overlays (per kind) with a synchronous subscription is the single "an overlay is open" signal (§ Overlay Presence); every modal-class surface registers through `useOccludes` while open.
**Why**: Focus is stolen by iframes and native views exactly when the signal is needed, so a focus read lies; nested modals (a create dialog over a detail sheet, a confirm inside the quake drawer) need a count, not a boolean, to stay correct until the last one closes; module state needs no provider above the independently mounted palette, dialog, drawer and toast trees and is readable from non-React bridge code.
**Rejected**: an `activeElement`/focus read (stolen by embedded frames); scraping `[role="dialog"]` from the DOM (misses the screen-break layer and the mobile drawer's backdrop, matches transient popovers that carry the role, double-counts nested dialogs); a React context (needs a provider spanning trees that mount separately).
*Introduced by*: 260916-ter5-overlay-presence-registry

### Click-opened menus register `transient`; hover surfaces register nothing
**Decision**: Every click-opened menu, dropdown, popover, and context menu that can overlap a tile registers `useOccludes("transient", open)` while open, and the native engine's hide signal is `isOccludingOpen()` — modal + transient counts. Tooltips (`tip.tsx`) and hover-opened flyout cards (`sidebar/row-flyout-card.tsx`) register nothing, and the native view is simply HIDDEN while an occluding overlay is open (the modal rule, extended).
**Why**: A native `WebContentsView` is composited above the SPA's DOM, so an open menu over a web tile paints UNDERNEATH the page and is unusable — the same defect class as a dialog, so the same hide rule applies. `modal` keeps its blocking-page semantic and `transient` is the menu class by design; registering menus as `modal` would mislabel them for every future modal-kind consumer. Hover-triggered surfaces are excluded because hiding the native view on every hover would flicker the page — a tooltip or flyout appears and disappears with pointer movement.
**Rejected**: Registering menus as `modal` (semantically wrong — the kind would lie to future consumers); snapshot-swapping the guest for a static `capturePage` image while a menu is open (rejected — hide-and-restore is simpler and already proven by the modal path); hiding on tooltips/hover cards (hover flicker).
*Introduced by*: 260925-ckpm-web-tile-native-retention-fixes

### Toasts live over chrome
**Decision**: On desktop the toast stack anchors bottom-right over the status bar's right end; on mobile it stays at the stage's bottom-right corner; toasts never register as an overlay.
**Why**: A toast is not modal-class — hiding a native web view for 4 s on every notification would be wrong — and clipping the view around a toast reflows the page. Every part of the top bar is interactive, so a toast there blocks the overflow chevron, the gear or the rename heading for its whole life (the `top-bar-overflow.spec` chevron hit-test is the contract). The status bar's right end is the least interactive chrome; the toast straddles a few pixels into the stage there, the cheapest overlap available. Mobile has no status bar and no native view, so the stage corner costs nothing.
**Rejected**: top-right over the top bar (blocks the right cluster); the top bar's center (the rename heading, switcher and quake launcher live there, and the center collapses below `sm`); registering toasts as `modal`; clipping the view around the toast.
*Introduced by*: 260916-ter5-overlay-presence-registry
