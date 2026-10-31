# Intake: UI Rename — Server → Workspace, Session → Group, Window → Tab

**Change**: 261030-g0gv-ui-rename-workspace-group-tab
**Created**: 2026-10-30

## Origin

> I want to make it easier to 1) start a new server (Workspace), 2) start a new session (Group) 3) Start a new window (tab). Can you think of ways, present mocks to me. Make also make the semantic renames in the UI in this work.

Conversational (a `/fab-discuss` session on 2026-10-30). The agent produced the design study `docs/wiki/create-flow-studies.html` (§2 holds the rename map). The user approved the study and chose to implement it as **four sequenced changes**. This is change 1 of 4 and ships first because it's mechanical and the other three use its vocabulary:

1. **this change**: UI rename
2. `261030-qm52-workspace-create-at-folder`: backend workspace creation at a folder
3. `261030-6d2o-folder-first-new-sheet`: folder-first New sheet
4. `261030-5am0-sidebar-head-new-split-button`: `+ Tab ▾` split button in the sidebar head

The user supplied the names Workspace (tmux server), Group (tmux session) and Tab (tmux window) in the prompt. They are decided.

## Why

The UI shows raw tmux nouns (`tmux Server`, `Session`, plus leftover `Window`). They make sense to a tmux power user but not to anyone thinking in terms of projects and work. The Window → Tab rename is about 90% shipped (the heading prefix is `Tab:`, palette rows are `Tab: …`, kill copy says "tabs"), so the UI currently mixes vocabularies: `Tab: Create` sits next to `Window: Set note…`, `Session: Sort windows…` and `Server: Create`. The creation-flow redesign (changes 2–4) introduces new controls labelled `+ Tab`, `+ Group` and `+ Workspace`, so the nouns have to land before those controls do.

A side benefit: "server" is ambiguous in HexoKit. It can mean the tmux server, the HexoKit daemon (`rk serve`) or a remote host. Calling the tmux server a "Workspace" in the UI removes that ambiguity.

Alternative rejected: renaming the CLI, API and tmux options too. Those layers talk to tmux, and `rk mux new <server>`, `?server=`, `@rk_srv_*` and the MCP `new_server` are a stable contract (Constitution: CLI-as-contract). They are out of scope.

## What Changes

### Scope rule

**UI copy only**: visible text, `aria-label`s, `title`s, placeholders, Tips, palette labels and keyboard-help descriptions in `app/frontend/src/`. **Unchanged**: identifiers, prop names, file names, testids, route params (`/$server/$window`), the `?server=` search param, API paths and payloads, CLI verbs, tmux option names, Go code, and memory/spec prose that describes the tmux layer. Code identifiers keep tmux names (`createSession`, `onCreateServer`, `server-panel.tsx`, and so on). Renaming them is churn with no user value.

Where a power user benefits from the mapping, the tmux term stays as a **secondary fact**. For example, the workspace card's facts line keeps `tmux -L <name>`, and the group card keeps `$<id>`.

### Rename map (from the study's §2)

| Surface | Today | New |
|---|---|---|
| Palette prefixes | `Server:` · `Session:` · `Window:` | `Workspace:` · `Group:` · `Tab:` |
| Leftover window rows | `Window: Set note…` · `Window: Move up/down` · `Window: Mark as Operator` · `Window: Unmark Operator` · `Window: Create at Folder` · `Window: Split …` · `Window: Move to <s>` | `Tab: …` equivalents (only where the shipped label is still `Window:`) |
| Sort row | `Session: Sort windows…` | `Group: Sort tabs…` |
| Sidebar section rail Tip | `Server` | `Workspaces` |
| Sidebar panel titles | `Server` (ServerPanel `title`) · `Sessions` | `Workspaces` · `Groups` |
| Sidebar aria | `Session tree` · `Sessions` · `Toggle sessions scope` · `Tmux servers` · `New tmux server` | `Workspace tree` · `Groups` · `Toggle groups scope` · `Workspaces` · `New workspace` |
| Host page zone | `TMUX SERVERS` (+ aria `Tmux Servers`) · `+ New Server` | `WORKSPACES` · `+ New workspace` |
| Flyout card titles | `Server <n>` · `Session <n>` | `Workspace <n>` · `Group <n>` |
| Card facts lines | `tmux -L work · 3 sessions` · `$4 · 2 tabs · ~/x` | `tmux -L work · 3 groups` · unchanged |
| Card action rows | `New session` · `Kill server` · `Kill session` · `Rename session` | `New group` · `Kill workspace` · `Kill group` · `Rename group` |
| Dialog titles | `Create tmux server` · `New session` · `Kill tmux server?` · `Kill protected server?` · `Adopt server into HexoKit?` · `Kill session?` · `Rename session` | `New workspace` · `New group` · `Kill workspace?` · `Kill protected workspace?` · `Adopt workspace into HexoKit?` · `Kill group?` · `Rename group` |
| Dialog fields | `Server name` / `Server name...` · `Session name` / `Session name...` · `Type the server name to unlock force kill` · `Protected server — kill requires typing the name` | `Workspace name` · `Group name` · `Type the workspace name to unlock force kill` · `Protected workspace — kill requires typing the name` |
| Kill copy | `Kill server <b>x</b> and all its sessions?` · `Kill session <b>x</b> and all its tabs?` | `Kill workspace <b>x</b> and all its groups?` · `Kill group <b>x</b> and all its tabs?` |
| Top bar page heading | `tmux Server:` (`TMUX_SERVER_PREFIX`) | `Workspace:` |
| `/$server` page | `tmux Server Overview` (aria) · `Sessions` · `+ New Session` tile | `Workspace overview` · `Groups` · `+ New group` |
| Keyboard map / help | `New session (a new group of tabs)` | `New group` |
| Spawn-agent placeholder | `What should the agent do? (blank = empty session)` | `What should the agent do? (blank = plain shell)` |
| Waiting aria | `N tab(s) in <s> waiting for input` | unchanged (no tmux noun) |
| Operator / quake | `Operator server` | `Operator workspace` |
| Recovery rows | `Restore <server>` / `Server: Restore …` / `Server: Dismiss recovery …` | `Workspace: Restore …` / `Workspace: Dismiss recovery …` |
| Toasts / errors | any `server`/`session` noun in UI-originated toast text | same mapping |

**Not renamed:** the **web tile's tab strip** ("web tabs", `@N/web/<n>`). Where its copy says only "tab", make it say "web tab" so it doesn't collide with Tab = tmux window. Server-originated error strings coming from the Go API are also left alone (backend scope).

### How to find everything

Grep the non-test sources for user-visible strings containing `Server`, `server`, `Session`, `session`, `Window` and `window` in JSX text, `label=`, `title=`, `aria-label=`, `placeholder=`, `Tip label=`, palette `label:` fields and keybinding `label`/`description`/`mapLabel` fields. The discussion's inventory found about 44 attribute strings plus the palette families in `app.tsx`, `lib/palette/*.ts`, `hooks/use-global-palette-actions.ts`, `lib/keybindings.ts`, `components/sidebar/*`, `components/server-dialogs.tsx`, `components/host-overview-page.tsx`, `components/session-tiles/session-tiles.tsx`, `components/session-name-prompt.tsx`, `components/top-bar.tsx`, `components/spawn-agent-dialog.tsx`, `components/quake-terminal.tsx` and `components/recovery-section.tsx`.

The **Help/skill docs** that quote UI labels (`docs/site/**` and the bundled `rk skill` topic pages, if they quote palette labels) should be updated where they quote a renamed UI label verbatim.

### Tests

About 65 test files (unit plus e2e under `app/frontend/tests/`) match on the old strings (palette labels, dialog titles, aria-labels). Update the assertions to the new copy. Testids are unchanged, so testid-based selectors keep working. Run the affected Vitest files and the e2e specs that select by text or role name.

### PR evidence

This is a user-visible UI change, so per the Constitution § PR Evidence, record a `just demo` covering the sidebar (Workspaces/Groups panels and a flyout card), the palette's `Workspace:`/`Group:` rows and the host page `WORKSPACES` zone, on desktop and mobile.

### The design study ships with this change

`docs/wiki/create-flow-studies.html` (untracked in the worktree today) is committed in this change, with a row added to `docs/specs/index.md`'s design-study table: "Create Flow Studies — design study for starting a Workspace/Group/Tab (261030 discussion): today's create entry points, the UI rename map, inline `+` / folder-first New sheet / sidebar-head split-button options, and the sequenced recommendation."

## Affected Memory

- `run-kit/ui/sidebar`: (modify) panel titles, card titles and action rows, aria labels in the new vocabulary
- `run-kit/ui/top-bar`: (modify) `TMUX_SERVER_PREFIX` → `Workspace:` heading; the session crumb description
- `run-kit/ui/keyboard-and-palette`: (modify) palette prefix families `Workspace:`/`Group:`/`Tab:`; the `create-session` label
- `run-kit/ui/dialogs-and-state`: (modify) dialog titles and fields
- `run-kit/ui/routes-and-shell`: (modify) host page `WORKSPACES` zone, the `/$server` overview copy
- `run-kit/ui/visual-design`: (modify) only if it quotes renamed labels

## Impact

Frontend-only: about 15 component/lib files, about 65 test files, a few docs pages. No API, backend, CLI or tmux changes. Low risk, but wide. The main hazard is a missed string, so the review should grep for leftovers.

## Open Questions

- Should the CLI gain `rk workspace`/`rk group` aliases later? Out of scope here, noted in the study as a separate decision.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Nouns are Workspace (tmux server), Group (tmux session), Tab (tmux window) | Given by the user in the prompt | S:95 R:70 A:95 D:95 |
| 2 | Certain | UI copy only; CLI/API/route params/tmux options/code identifiers keep tmux names | Discussed in study §2; the user approved the study; CLI-as-contract | S:85 R:80 A:90 D:85 |
| 3 | Confident | Keep tmux terms as secondary facts (`tmux -L <name>`, `$id`) in flyout cards | Study §2; preserves the mapping for power users | S:75 R:90 A:75 D:75 |
| 4 | Confident | The web tile's strip is called "web tab", never bare "tab" | Study §2 collisions list | S:70 R:90 A:70 D:70 |
| 5 | Confident | Ship as change 1 of 4, before the creation-flow changes | The user chose "Sequenced changes" | S:90 R:85 A:85 D:85 |
| 6 | Confident | Commit the design study plus a specs-index row in this change | Project convention for design studies in `docs/wiki/` | S:60 R:95 A:80 D:75 |
| 7 | Confident | Backend-originated error strings are untouched | Scope rule (UI only); the backend is shared with CLI/MCP clients | S:60 R:90 A:70 D:70 |

7 assumptions (2 certain, 5 confident, 0 tentative, 0 unresolved).
