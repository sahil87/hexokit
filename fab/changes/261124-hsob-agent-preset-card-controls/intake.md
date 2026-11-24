# Intake: Agent preset card controls (plan step C1)

**Change**: 261124-hsob-agent-preset-card-controls
**Created**: 2026-11-24

## Origin

> Execute step C1 (Card controls: always-present preset line, "Agent preset…" row and chooser on the group and workspace cards, preset name on the row) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-24-agent-preset-controls.md. Read the whole plan first (Decisions and Rules bind you), then implement only the C1 Brief.

Interaction: `/fab-new` one-shot with three questions asked at intake (the plan's two C1 open decisions plus one wording gap). The plan (`fab/plans/sahil/26-11-24-agent-preset-controls.md`, on `main` at `eda9dddc`) and its design study (`docs/wiki/agent-preset-controls-studies.html`) are the binding inputs. The plan's "Decisions already taken" table and "Rules for the operator" are NOT reopened here. Where the design study and the plan disagree, **the plan wins** (plan Rule 7).

Answers given at intake:

1. **Chooser form** → an **anchored popover**, the same mechanism as "Change color…" (card closes, popover opens anchored to the row/tile/header), on both desktop and touch.
2. **Row marker placement** → a small chip **right after the name, before the badges**; capped (~14ch) with an ellipsis, full name in a `title` tooltip.
3. **Empty-ladder wording** → when nothing is set anywhere the card line reads `agent preset: none · fab's defaults`.

Step C2 (Settings > Agent "Save as preset…" / "Manage…") is explicitly OUT of scope — a separate change that depends on this one.

## Why

Agent presets work end to end (fab-kit #711 / fab 2.31.1; hexokit #1189, #1191), but the UI for them is thin:

1. **A group's or workspace's preset can only be set from the command palette.** The sidebar cards show the preset as read-only text, and only when the entity has its own value — so a group that inherits shows nothing, and there is no visible, mouse-reachable way to change it.
2. **Nothing shows on the row.** You have to open a card to learn that a group runs on a different preset than its neighbours.

If we don't fix it, presets stay a palette-only power feature: users can't see which preset new tabs in a group will launch with, nor change it without knowing the palette action names.

Approach (fixed by the plan's Decisions table): the control lives on the cards that already hold every other per-group/per-workspace action ("Change color…" sits there), the chooser only *picks* a preset (no per-role breakdown — that belongs to Settings > Agent), and the row marker appears only for an entity's **own** preset (inherited values add no marker). The backend routes, tmux options and palette actions already exist — this is **frontend only**.

## What Changes

All paths are under `app/frontend/` unless stated.

### 1. Data the cards need: the machine default and the full inheritance ladder

The card line and the chooser's `inherit` description need the *effective* preset and its *source*. Launch-time resolution (already shipped; unchanged by this change) is:

```
spawn-dialog pick  >  group (@rk_ses_agent_preset)  >  workspace (@rk_srv_agent_preset)  >  machine default (fab agent.preset)  >  fab's defaults
```

- The group's own value is `session.agent_preset` (`src/types.ts`), already on the row's session prop.
- The workspace value is `ServerInfo.agent_preset` (`src/api/client.ts` ~L1522), held by `ServerGroup` in `src/components/sidebar/index.tsx` as `serverInfo?.agent_preset` and by `ServerPanel` per tile as `info.agent_preset`. The `SessionRow` does **not** currently receive it — thread it down as a new string prop (e.g. `workspaceAgentPreset`) from `ServerGroup` (index.tsx ~L3241 where `onClearAgentPreset` is passed). It is a primitive string, so the row's memo contract is unaffected.
- The machine default is `GET /api/fab-config` → `fields["agent.preset"].value` (`FabConfigDocument`, `KEY_PRESET = "agent.preset"` in `settings-agents-panel.tsx`). Today `loadMachineAgentPresets()` in `src/lib/agent-presets.ts` reads that same document but keeps only `agent_presets`. Extend the cached loader so the one cached `getFabConfig()` read yields both the preset list and the machine default (e.g. a `loadMachineAgentPresetInfo(): Promise<{ presets?: FabAgentPreset[]; machineDefault?: string }>` with `loadMachineAgentPresets` kept as a thin wrapper so existing callers/tests are unchanged, and a matching hook alongside `useAgentPresetList` / `useMachineAgentPresets`). Keep the 30 s TTL and the never-rejects contract. An empty / null / non-string `agent.preset` value means "no machine default".
- Add a **pure** resolver in `src/lib/agent-presets.ts`, unit-tested, e.g.:

```ts
type PresetSource = "set here" | "from workspace" | "machine default" | "fab's defaults";
function resolveAgentPreset(args: {
  own?: string;            // the entity's own value ("" / undefined = unset)
  workspace?: string;      // only for a group; omit for a workspace
  machineDefault?: string;
}): { name: string | undefined; source: PresetSource };
// own set            → { name: own,            source: "set here" }
// group, ws set      → { name: workspace,      source: "from workspace" }
// machine set        → { name: machineDefault, source: "machine default" }
// nothing anywhere   → { name: undefined,      source: "fab's defaults" }
```

`none` at any rung is a real value and stops the walk (a workspace `none` makes a group with no own value read `none (no preset) · from workspace`).

### 2. The always-present preset line (group card + workspace card)

Replace the conditional `{session.agent_preset && <AgentPresetFact …/>}` in `session-row.tsx` (~L209) and `{agentPreset && <AgentPresetFact name={agentPreset} />}` in `server-card.tsx` (~L72) with a line rendered **whenever fab reports presets** (the list the card judges against is non-empty — the same `presetsAvailable` rule the palette uses: `(list?.length ?? 0) > 0`), not only when the entity has its own preset. **Hide the line entirely when fab reports no presets** (fab absent / too old / list undefined or empty).

Format: `agent preset: <name> · <source>` where

| Case | Line |
|---|---|
| Own valid preset | `agent preset: codex-review · set here` |
| Own unknown name | `agent preset: old-preset (unknown) · set here` |
| Own `none` | `agent preset: none (no preset) · set here` |
| Group inheriting workspace | `agent preset: codex-workers · from workspace` |
| Inheriting machine default | `agent preset: claude · machine default` |
| Nothing set anywhere | `agent preset: none · fab's defaults` |

The name rendering keeps the existing `describeAgentPreset(name, list)` wording (`<name> (unknown)` for a name missing from the known list, `none (no preset)` for the reserved opt-out). The "nothing set anywhere" name is a plain `none` (user's answer at intake) — distinct from the reserved `none (no preset)` label. Keep `data-testid="row-flyout-agent-preset"`. The group card judges names against the group's repo-scoped list when one is known (`useAgentPresetList(server, session)`), else the machine list; the workspace card uses the machine list.

Update `AgentPresetFact` in `src/components/sidebar/agent-preset-card.tsx` (or replace it with an `AgentPresetLine`) to take `{ own, workspace?, server?, session? }` and do the resolution + rendering; it mounts only while the card is open (keeps the lazy cached read).

### 3. The "Agent preset…" action row

A `CardActionRow` (`row-flyout-card.tsx`) labelled **`Agent preset…`** on both the group card (`session-row.tsx`) and the workspace card (`ServerCardContent` in `server-card.tsx`), placed **immediately after "Change color…"** (plan: "next to"/"after Change color…"; the study placed it after Spawn agent on the group card — the plan wins). Its `hint` is the **effective** preset name (the same display name as the line: e.g. `codex-review`, `none (no preset)`, `none` when nothing is set). Hidden when fab reports no presets. Suggested test ids: `row-flyout-agent-preset-action`. Icon: an existing sidebar icon (e.g. a gear/sliders glyph from `icons.tsx`; add one only if none fits).

Rendered only when the card has the seams to act (an `onSetAgentPreset`-style handler is supplied), mirroring the optional-handler gating of `onSpawnAgent` / `onColorChange` (the board-route sidebar may pass none).

### 4. The chooser (anchored popover)

Clicking the row **closes the card, then opens the chooser** — the exact close-then-open idiom "Change color…" uses (`close(); setShowColorPicker(true);` with the card's `useRowFlyout({ suppressed: … || showChooser })` so popover-over-card precedence holds). The chooser is a popover **anchored to the same element** the color popover anchors to — the group row (`session-row.tsx`), the workspace tile (`server-panel.tsx` `ServerTile`, `tileAnchorRef` + `useAnchoredPopoverPos`), and the GROUPS-pane workspace header (`index.tsx` `ServerGroup`, `headerRef` + `useAnchoredPopoverPos`) — portalled to `document.body` with the shared flip heuristic so the sidebar's overflow never clips it. Same mechanism on fine and coarse pointers (decision at intake).

Content (from the design study, plan wording wins):

```
Agent preset · Group hexokit
○ inherit        uses codex-workers (from workspace)
○ claude         All roles on Claude (today's defaults)
● codex-review   Only the review role on Codex
○ codex-workers  Pipeline workers on Codex; session on Claude
○ none           no preset, even the machine default
Applies to tabs created from now on. Running tabs keep theirs.
```

- Entries: `inherit` first, with a description stating what inherit resolves to for this entity — `uses <name> (<source>)` built from the resolver over the *inherited* rungs only (group: workspace → machine → fab's defaults; workspace: machine → fab's defaults), e.g. `uses codex-workers (from workspace)`, `uses claude (machine default)`, `uses none (fab's defaults)`; then each preset from the list with its `description` (omit the description when absent); then `none` with `no preset, even the machine default` (the palette's existing wording).
- The **current choice is marked**: `inherit` when the entity has no own value; the matching preset; `none` when own is `none`. An own **unknown** name matches no entry, so nothing is marked; the existing "Clear agent preset" card row still covers clearing it (and `inherit` also clears).
- **List source**: for a group, the group's repo-scoped list when available, as the palette does (`app.tsx` ~L4870: `getRiffPresets(server, session)` → `rememberRepoAgentPresets` → fall back to `loadMachineAgentPresets()`); for a workspace, the machine list. Loading the repo-scoped list on chooser open (same call the palette makes) is acceptable; render the machine/remembered list immediately if one is already held.
- **Picking** calls the existing API and closes the popover:
  - group → `setSessionAgentPreset(server, session, name | null)` (`POST /api/sessions/{session}/agent-preset`)
  - workspace → `setServerAgentPreset(server, name | null)` (`POST /api/servers/agent-preset`)
  - `inherit` sends `null` (clears the option); `none` sends `"none"`.
  - Errors surface as a toast, the same way the palette/clear paths do (`addToast` / the sidebar's existing clear handlers in `index.tsx` ~L1775–1790, which also call `refreshServers` for the workspace route). Re-use those handlers' shape: generalise `handleSessionAgentPresetClear` / `handleServerAgentPresetClear` / `handleAgentPresetClear` into set handlers taking `name | null` (clear = set `null`).
- A **footer** line: `Applies to tabs created from now on. Running tabs keep theirs.` (study wording; matches the plan's "When a choice applies: at launch" decision).
- Accessibility: `role="radiogroup"` with an `aria-label` like `Agent preset for <entity>`; each entry `role="radio"` with `aria-checked`.

Implement the chooser as one shared component (e.g. `src/components/sidebar/agent-preset-chooser.tsx`) used by all three anchors, with the list-building logic as a pure function (e.g. `buildAgentPresetChoices({ presets, own, inherited })` in `src/lib/agent-presets.ts`) so Vitest can cover it without rendering. The palette builder (`src/lib/palette/agent-preset.ts`) MAY reuse that pure function for its preset/none rows **only if its output is byte-identical** — the plan says the palette actions stay unchanged.

### 5. Keyboard

- ArrowDown / ArrowUp move between entries (wrap), Enter (and Space, native button) picks, Escape closes without changing anything and returns focus sensibly (to the row/tile/header that anchored it, matching the color popover's behavior).
- On open, focus starts on the **current choice** (falls back to `inherit` when nothing matches, e.g. an unknown name).
- Clicking outside closes (same as the color popover).
- The palette actions `Group: Set Agent Preset…`, `Group: Clear Agent Preset`, `Workspace: Set Agent Preset…`, `Workspace: Clear Agent Preset` stay and are **unchanged** — they remain the keyboard path (Constitution V is already satisfied: the card row's action is registered in the palette).

### 6. Row marker (preset name on the row)

On a **group row** (`session-row.tsx`) and a **workspace row** — both the Workspaces-panel tile (`server-panel.tsx` `ServerTile`) and the GROUPS-pane workspace header (`index.tsx` `ServerGroup` header) — show the preset name **only when that entity has its own preset** (inherited values add no marker). Shown for an own `none` too (it is an explicit choice that differs), as the literal `none`.

Placement (decision at intake): a small neutral bordered chip **directly after the name, before the badges** — on the group row after the name span and before the viewer badge / `WaitingBadge` / `+` button; on the workspace tile on the name line after the name (the count line keeps the count + waiting badge as today); on the GROUPS-pane header after the server name, before its trailing controls. Styling: the neutral chip idiom (`text-text-secondary`, 1px `border-border`, small radius, ~10px text, `leading-none`, no signal colour — it is informational, not attention). Truncation: the chip is capped (~14ch, `max-w-[14ch]`) with `overflow-hidden text-ellipsis whitespace-nowrap` and carries `title="agent preset: <name>"` + an accessible label; the entity name keeps `min-w-0 truncate` priority so the row never overflows. Suggested test id: `agent-preset-marker`.

It must not break the row layout rules at narrow widths or on touch: the coarse `pr-[56px]` rail reserve, the 375 px mobile drawer, Row Minimalism (`tests/e2e/row-minimalism.spec.ts`, `docs/specs/status-pyramid.md` § Row Minimalism — that spec governs the *window* row's stage/duration words; group/workspace rows gain only this one marker and must stay on one line).

### 7. Clear row

The existing `AgentPresetClearRow` ("Clear agent preset", shown only for a name unknown to the list) stays as-is. The chooser's `inherit` covers clearing a valid preset.

### 8. Mobile

The same row and chooser work on coarse pointers, where the card opens from the status rail (group rows and the GROUPS-pane workspace header; the Workspaces-panel tile card is suppressed on coarse by design and stays so). The popover must fit within a 375 px viewport (flip / clamp like the color popover) with ≥36 px touch rows (`coarse:min-h-[36px]`).

### 9. Tests and evidence

- **Vitest**:
  - `src/lib/agent-presets.test.ts` (new or extended): the resolver's source wording for every row of the table in §2 (own/unknown/none, from workspace, machine default, fab's defaults, workspace `none` stopping the walk); the chooser-list builder (inherit description per entity kind, preset descriptions, `none` entry, current-choice marking incl. unknown → none marked).
  - `session-row.test.tsx` / `server-panel.test.tsx` (existing preset blocks ~L700 / ~L655): line always present when presets are reported, hidden when not; the action row's presence/hint/placement after Change color…; clicking it closes the card and opens the chooser; picking calls the handler with `name` / `null` / `"none"`; keyboard (arrows, Enter, Escape, initial focus on current); the row marker present only for an own preset.
- **Playwright e2e**: a new spec (e.g. `tests/e2e/agent-preset-card.spec.ts`, modelled on `agent-preset-palette.spec.ts`'s fully-mocked `/api/sessions`, `/ws/state`, `/api/fab-config`, `/api/sessions/*/agent-preset`, `/api/servers/agent-preset` routes) covering **set, inherit and none on a group and on a workspace**, and the **row marker** appearing/disappearing; plus a coarse-pointer/mobile case. Every `test()` carries the Proves/Steps JSDoc and the file header comment (Constitution § Test Intent Comments). Extend `tests/e2e/_fab-config-stub.ts` only if the machine default must be stubbed there.
- Existing specs that must keep passing: `agent-preset-palette.spec.ts`, `row-minimalism.spec.ts`, `row-flyout.spec.ts`, `sidebar-section-rail.spec.ts`, and any spec asserting card row order (e.g. "Change color… is the FIRST action row" in `row-flyout-card.test.tsx` stays true).
- **Demo**: `tests/demo/agent-preset-card.demo.ts` recorded with `just demo agent-preset-card --before` on desktop and mobile (Constitution § PR Evidence); the existing `tests/demo/group-agent-preset.demo.ts` is a model.
- If the work touches the shared Control primitive / `control-gallery.tsx`, regenerate the control-gallery baselines (`just test-e2e "control-gallery"`). Not expected — the chooser uses sidebar card/popover idioms, not Control.
- Rule 6: no step writes to the real `~/.fab-kit/config.yaml`; all tests use the mocks/stubs.

### 10. Docs

- `docs/memory/run-kit/ui/sidebar.md` — the preset line (always present, source wording), the "Agent preset…" row, the chooser, the row marker, and the file map entry for `agent-preset-card.tsx` / any new chooser file.
- `docs/memory/run-kit/ui/dialogs-and-state.md` — the chooser as a popover surface (and its keyboard contract), alongside the existing agent-preset content.

## Affected Memory

- `run-kit/ui/sidebar`: (modify) group/workspace card preset line always present with its source; "Agent preset…" card row; chooser popover; preset-name row marker on group rows, workspace tiles and the GROUPS-pane workspace header; file map
- `run-kit/ui/dialogs-and-state`: (modify) the agent-preset chooser popover (entries, current-choice marking, keyboard, list source, apply-at-launch footer)

## Impact

- **Frontend only** (`app/frontend/src/`): `lib/agent-presets.ts` (machine default in the cached read, resolver, choice-list builder), `hooks/` (a hook exposing presets + machine default), `components/sidebar/agent-preset-card.tsx` (line, row, possibly marker), a new chooser component, `session-row.tsx`, `server-card.tsx`, `server-panel.tsx`, `index.tsx` (threading the workspace preset to session rows; set handlers; chooser anchoring for the header), possibly `icons.tsx`.
- No backend, route, tmux-option, or fab-kit change. Existing routes: `POST /api/sessions/{session}/agent-preset`, `POST /api/servers/agent-preset`, `GET /api/fab-config`, `GET` riff presets (repo-scoped list).
- Palette (`lib/palette/agent-preset.ts`, `app.tsx` wiring) — unchanged behavior. C2 will later share `api/client.ts` and palette wiring, so keep changes there minimal.
- Tests: new/extended Vitest and Playwright specs; a new demo spec. No control-gallery baseline change expected.

## Open Questions

- None blocking. The plan's two C1 open decisions were answered at intake (anchored popover; marker after the name, before badges).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Frontend only; reuse existing routes, tmux options and palette actions unchanged | Plan C1 Brief: "Frontend only. The routes, the tmux options and the palette actions already exist"; "The palette actions stay and are unchanged" | S:95 R:85 A:95 D:95 |
| 2 | Certain | Chooser shows inherit + presets with descriptions + none; no per-role breakdown | Plan Decisions table ("What the chooser shows") — not reopened | S:95 R:80 A:95 D:95 |
| 3 | Certain | Row marker only for an entity's own preset; inherited values add no marker | Plan Decisions table ("Row marker") | S:95 R:80 A:95 D:90 |
| 4 | Certain | Line/row/chooser hidden when fab reports no presets | Plan C1 Brief: "Hide the line when fab reports no presets"; row "Hidden when fab reports no presets" | S:90 R:85 A:90 D:90 |
| 5 | Certain | Chooser is an anchored popover (close card, then open), same as Change color…, on desktop and mobile | Asked — user chose "Anchored popover" (plan open decision C1-1) | S:95 R:70 A:90 D:90 |
| 6 | Certain | Row marker is a capped (~14ch) neutral chip right after the name, before the badges, with a title tooltip | Asked — user chose "After name, before badges" (plan open decision C1-2) | S:90 R:80 A:85 D:85 |
| 7 | Certain | Nothing-set line reads `agent preset: none · fab's defaults` | Asked — user chose this wording at intake | S:95 R:90 A:90 D:90 |
| 8 | Confident | "Agent preset…" row sits immediately after "Change color…" on both cards (not after Spawn agent… as the study shows) | Plan says "next to"/"placed after Change color…"; plan wins over the study (Rule 7) | S:75 R:90 A:80 D:70 |
| 9 | Confident | Source wording exactly "set here" / "from workspace" / "machine default" / "fab's defaults" | Plan C1 Brief lists these four strings; the study's "from machine default" variant loses to the plan | S:85 R:90 A:80 D:75 |
| 10 | Confident | Machine default comes from `GET /api/fab-config` `fields["agent.preset"].value`, read through the existing 30 s cached loader | The fab-config document already carries the field (Settings > Agent reads it); one cached read serves list + default | S:65 R:85 A:80 D:80 |
| 11 | Confident | Ladder shown on the card ignores a repo's project-file `agent.preset` (group → workspace → machine → fab's defaults only) | Matches the design study's ladder and the plan's four source words; project-level presets are a C2/non-goal concern | S:60 R:80 A:65 D:70 |
| 12 | Confident | An own `none` shows a `none` marker on the row and is marked in the chooser | `none` is an explicit own value that differs from inheritance; the study's marker shows any own value | S:65 R:90 A:75 D:70 |
| 13 | Confident | The GROUPS-pane workspace header counts as a "workspace row" and gets the marker, row and chooser; the Workspaces-panel tile card stays fine-pointer-only | Both surfaces render the shared ServerCardContent; the tile's coarse suppression is existing design | S:60 R:80 A:75 D:65 |
| 14 | Confident | Chooser picks surface errors as toasts via generalised versions of the existing clear handlers | Mirrors the palette/clear paths' error handling; no new error surface | S:60 R:90 A:80 D:80 |
| 15 | Confident | Group chooser loads the repo-scoped list on open (riff presets call), falling back to the machine list, as the palette does | Plan: "offer the group's repo-scoped list when it is available, as the palette does" | S:80 R:85 A:80 D:75 |

15 assumptions (10 certain, 5 confident, 0 tentative, 0 unresolved).
