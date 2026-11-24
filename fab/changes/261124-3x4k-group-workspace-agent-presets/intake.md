# Intake: Group and workspace agent presets

**Change**: 261124-3x4k-group-workspace-agent-presets
**Created**: 2026-11-24

## Origin

> Execute step H2 (Group and workspace agent presets) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-24-agent-presets.md. Read the whole plan first (Decisions and Rules bind you), then implement only the H2 Brief.
>
> After /fab-new creates the change, run `fab status set-base-branch <new-change> 261124-m39n-riff-preset-rename-agent-preset-dropdown`.

This is step **H2** of the plan `fab/plans/sahil/26-11-24-agent-presets.md` (also in this worktree at the same relative path). The plan's **Decisions already taken** table and its **Rules for the operator** bind this change and are not reopened here. Only the H2 Brief is in scope. The change stacks on H1 (`261124-m39n-riff-preset-rename-agent-preset-dropdown`), which is its recorded base branch: H1 already renamed `rk riff`'s presets to "riff presets" (`--riff-preset`, `riff_preset` body field, "Riff preset" dialog label) and added the machine-wide agent-preset dropdown in Settings > Agent via `internal/fabsysconfig`.

Prerequisites verified at intake on 2026-11-24:

- Installed `fab` is 2.31.1. `fab agent presets --json` prints:
  ```json
  [{"name":"claude","description":"All roles on Claude (today's defaults)","source":"built-in","session":"claude","workers":"claude"},
   {"name":"codex-review","description":"Only the review role on Codex","source":"built-in","profiles":{"review":{"cli":"codex"}}},
   {"name":"codex-workers","description":"Pipeline workers on Codex; session on Claude","source":"built-in","workers":"codex"}]
  ```
  It accepts `--repo <root>` (default: current repo), so project-defined presets (`source: project`) appear only when resolved inside that repo. The reserved name `none` is never listed but is accepted everywhere a preset name is (`agent.preset none` / `FAB_AGENT_PRESET=none` = "no preset here, even if a lower layer chose one").
- `fab agent --preset` help: "agent preset for this resolution only (as if FAB_AGENT_PRESET were set; none disables a configured one). Resolution only: it is not exported into the launched session, and flags do not reach `fab dispatch start` — to make a preset reach dispatched workers, set agent.preset in config or export FAB_AGENT_PRESET". This is why H2 passes the env var on the pane, not the flag.
- An unknown name in `FAB_AGENT_PRESET` makes fab print `fab: warning: unknown agent preset "bogus" (agent.preset from env); ignoring it` on stderr and resolve as unset — a spawn never fails for a stale name.
- H1 left in `internal/fabsysconfig/fabsysconfig.go`: `listPresets(ctx)` (runs `fab agent presets --json` with `Dir=$HOME`), `presetList.names()`, `validatePreset`, the `AgentPreset` struct, and the `Document.AgentPresets` (`agent_presets`) field. `validate.ValidateIdentifier` (alnum + `-`/`_`, ≤ 64 chars, no leading `-`) exists in `internal/validate/validate.go`.

Decisions taken in the intake conversation (asked via SRAD; the user picked the recommended option each time):

1. **Indication** — both cards: the group preset as a facts line on the session-row flyout card, the workspace preset as a line on the server card (the sidebar server-row flyout and the Server page tile share `ServerCardContent`). No new row glyph.
2. **CLI verb** — none in H2. The only new CLI surface is `rk riff --agent-preset <name>` (a one-off pick). Setting the group/workspace options is UI + palette + API only; a raw `tmux set-option` still works and is tolerated at spawn.
3. **Tab record** — no. A tab does not record the preset it was launched with (no `@rk_win_agent_preset`).
4. **Resume/fork** — skip the lookup. Spawns that resume or fork a conversation (closed-tab restore `api/closed.go`, cron session respawn `cmd/rk/cron_respawn_session.go`, Fork `api/fork.go`) keep today's launcher resolution and pass no `FAB_AGENT_PRESET`. A restored conversation keeps its own agent; a group preset that moves the session CLI to Codex must not make a plain Claude resume fail its provider check.

## Why

1. **Problem.** After F1 and H1, the only place to choose an agent preset is machine-wide (Settings > Agent → `agent.preset` in `~/.fab-kit/config.yaml`). There is no way to say "this group runs on Codex workers" or "this workspace is all Claude" (plan Problem #1). A one-off `fab agent --preset` flag never reaches pane/headless workers because `fab dispatch start` re-resolves from config (plan Problem #3).
2. **Consequence of not doing it.** Users who want different agent assignments per project or per workspace must flip the machine default before each spawn, which also changes every other spawn on the box. The operator and autopilot cannot be pointed at a different assignment for one workspace.
3. **Why this approach.** The plan fixes the mechanism: per-entity state lives in `@rk_*` tmux options (Constitution IV, plan decision "Group and workspace storage"; tmux environment was rejected because only new panes see updates and the value sprays into every child). HexoKit resolves one name at spawn and hands it to fab as `FAB_AGENT_PRESET` — on the `fab agent` exec that resolves the launcher **and** on the new tab's panes — so fab's existing env layer makes the preset reach `fab dispatch start` in all three dispatch modes, while fab never reads tmux (plan decision "How fab gets the group/workspace choice"). It applies at launch only (plan decision "When it applies").

## What Changes

### 1. tmux options and setters — `app/backend/internal/tmux`

- New constants beside `SessionColorOption`/`SessionFlairOption` (`tmux.go`):
  ```go
  // SessionAgentPresetOption is the session-scoped option naming the group's agent preset.
  const SessionAgentPresetOption = "@rk_ses_agent_preset"
  // ServerAgentPresetOption is the server-scoped (set -s) option naming the workspace's agent preset.
  const ServerAgentPresetOption = "@rk_srv_agent_preset"
  ```
  Each holds one preset name; empty/absent = unset. Names follow the scope-prefix convention (`fab/project/context.md` § Conventions): a key never reused at another scope.
- Setters alongside the session color setters, through the existing helpers (`setSessionOption`/`unsetSessionOption`, and `set-option -s` / `set-option -su` like `MarkServerProtected`/`UnmarkServerProtected`):
  - `SetSessionAgentPreset(session, name, server string) error`, `UnsetSessionAgentPreset(session, server string) error`
  - `SetServerAgentPreset(ctx, server, name string) error`, `UnsetServerAgentPreset(ctx, server string) error`
  - Wire through the `TmuxOps` interface / `prodTmuxOps` in `api/router.go` and the shared `mockTmuxOps`.
- **Session state** — extend the shared `sessionListFormat()` (consumed by both `parseSessions` and `buildSessionFacts` in `session_facts.go`) with `#{@rk_ses_agent_preset}` as a 10th field, and add `AgentPreset string \`json:"agent_preset,omitempty"\`` to `SessionInfo`. Update the format comments ("9-field" → "10-field") and every parser/test that counts fields.
- **Server state** — `ReadServerMarks` already does one `show-options -s` dump; parse `@rk_srv_agent_preset` from it into a new `ServerMarks.AgentPreset string` (no extra exec). `GET /api/servers` `serverInfo` gains `agent_preset` (omitted when empty).
- **Spawn-time read** — a getter that reads both values for a target in bounded tmux execs, e.g. `GetAgentPresetOptions(ctx, server, session string) (sessionPreset, serverPreset string, err error)` (or two getters). Must be `exec.CommandContext` with `TmuxTimeout`, argv slices, and must handle the CLI path (empty server label → the caller's restored `$TMUX`). A read failure degrades to "no value" with a `slog.Debug`, never fails a spawn.
- Register both options in `docs/memory/run-kit/tmux-sessions.md` § Server-Scoped User Options and in `docs/specs/ui-state.md`'s option inventory. No `MigrateLegacyOptions` row (new keys, no legacy names).

### 2. Name validation — `app/backend/internal/validate` + a fab preset-list reader

- `ValidateAgentPresetName(name string) string` in `internal/validate`: delegates to `ValidateIdentifier(name, "Agent preset name")` (alnum + `-`/`_`, ≤ 64, no leading `-`). This is the "short allowlisted character set" check and runs **before any subprocess** (Constitution I).
- A reusable reader for fab's preset list rooted at a directory, so setters and the dialog validate against the list fab would actually resolve there: `fab agent presets --json` with `Dir=<repoRoot>` (or `--repo <root>`), `exec.CommandContext` + `FabTimeout`. Reuse/extract H1's `fabsysconfig.listPresets` decoding rather than duplicating it (e.g. export a `ListAgentPresets(ctx, dir string) ([]AgentPreset, error)` from `internal/fabsysconfig`, keeping `Dir=$HOME` as the machine-wide default). A failing/older fab returns an error → callers treat presets as unsupported.
- **Membership rule for setters**: the name must be in the list **or** the reserved `none`.
  - Group (session) option: list resolved in the session's derived repo root (`deriveRepoRoot`, as `GET /api/riff/presets` does); when the session has no repo, the machine-wide list (`Dir=$HOME`).
  - Workspace (server) option: the machine-wide list (`Dir=$HOME`).
  - presets unsupported (older fab) → 400 `agent presets are not supported by the installed fab`; unknown → 400 `unknown agent preset "x" (available: claude, codex-review, codex-workers)`. Nothing is written on a 400.

### 3. API — set/clear routes and state (Constitution IX: POST only)

- `POST /api/sessions/{session}/agent-preset?server=<s>` ← `{"agent_preset": "codex-review"}` sets; `{"agent_preset": null}` or `""` clears. Implement via the existing `handleSessionStringOption` pattern used by `/color` and `/flair` (decode → validate → set/unset → SSE wake), with the membership check added before `set`.
- `POST /api/servers/agent-preset` ← `{"name": "<server>", "agent_preset": "codex-review" | null}`. Mirrors `handleServerProtect` (validate server name → validate preset → set/unset → `s.sseHub.wake(name)`).
- Responses `{"ok": true}`; 400 for invalid charset / unknown / unsupported; 500 for tmux failures.
- State: the sessions SSE payload carries `agent_preset` per session (via `SessionInfo`); `GET /api/servers` carries `agent_preset` per server. Both writes are durable in tmux before the response (Constitution II).
- `GET /api/riff/presets?server=&session=` (the dialog's one preflight fetch) additionally returns:
  ```json
  {
    "riff_presets": [...], "tiers": [...],
    "agent_presets": [{"name":"codex-review","description":"…","source":"built-in", ...}],
    "agent_preset_inherited": {"name": "codex-review", "from": "group"}
  }
  ```
  `agent_presets` comes from `fab agent presets --json` in the session's repo root and is **omitted** when fab fails/is older (the dialog then hides the field). `agent_preset_inherited` is the name the ladder would pick with no explicit pick (`from`: `"group"` | `"workspace"`), omitted when nothing is set. Key casing per the plan's Key casing decision (snake_case).
- `POST /api/riff` body gains optional `agent_preset` (snake_case). Validated before any subprocess: charset (400), then membership in the repo-scoped list or `none` (400 `unknown agent preset …`; if the list cannot be read, an explicit pick → 400 unsupported). The other fields are untouched.

### 4. Lookup at spawn — `app/backend/internal/riff`

- New `Options.AgentPreset string` (explicit pick) and the resolution ladder, evaluated **once per spawn** in the engine:
  1. explicit pick on the request (`Options.AgentPreset`)
  2. the target session's `@rk_ses_agent_preset`
  3. the server's `@rk_srv_agent_preset`
  4. nothing
  Option-sourced values that fail `ValidateAgentPresetName` (hand-set garbage) are skipped with a `slog.Warn` and the ladder continues. Option values are **not** membership-checked at spawn: a stale name still spawns and fab warns and ignores it (plan "Stale names").
- **Skip for resume/fork (decided)**: when `Options.ResumeSessionRef != ""` (fork, closed-tab restore, cron session respawn), the ladder is not evaluated and nothing is passed — byte-identical to today.
- When a name resolves:
  - `ResolveAgent` / `ResolveHeadlessAgent` run `fab agent … -o yaml` with `cmd.Env = append(os.Environ(), "FAB_AGENT_PRESET="+name)`. Change their signatures to accept the preset (e.g. an extra `preset string` param or a small options struct) and update all callers; `runFabAgent` gains the env parameter. The legacy `--print` retry gets the same env.
  - The tab's tmux commands carry `-e FAB_AGENT_PRESET=<name>`: on `new-window` (both `buildSpawnArgvs` and `buildNewWindowCaptureArgs`, placed before the shell command) and on each `split-window` of the same spawn, so every pane of the tab — and any `fab` command the agent runs there, including `fab dispatch start` — resolves the same preset.
- **With no name, pass nothing**: argv slices and `cmd.Env` (nil → inherit) must be identical to today's. This is asserted by tests (see § Tests).
- The explicit pick also beats a `FAB_AGENT_PRESET` already in the daemon's own environment (Go's exec keeps the last duplicate env entry); with no name, the daemon's ambient env behaves exactly as today.

### 5. Every caller goes through the lookup

| Caller | File | Session for the ladder | Notes |
|---|---|---|---|
| Web UI spawn | `api/riff.go` `handleRiffSpawn` → `riff.Spawn` | `body.Session` | explicit pick from body `agent_preset` |
| `rk riff` CLI | `cmd/rk/riff.go` (calls `riff.ResolveAgent` then `riff.Run`) | the caller's current session/server (via restored `$TMUX`) | new `--agent-preset <name>` flag beside H1's `--riff-preset`; validated (charset → exit 2 usage; membership against the repo list → exit 2 `unknown agent preset`) before any spawn; `riff.Run`'s spec carries the name so `new-window`/`split-window` get `-e` |
| Autopilot | `internal/autopilot/riffspawn.go` (`riff.SpawnObserved`) | `req.Session` | also `spawn.go` `buildPrompt`'s `resolveAgentFn(ctx, repo, "")` skill-prefix lookup must resolve with the same preset name, so a Codex preset gets the `$` prefix |
| Operator run (headless) | `internal/operatorloop/runner.go` `openRunWindow` → `resolveLauncherFn` (`riff.ResolveHeadlessAgent`) + `tmux.LaunchOperatorRunWindow` | `_rk-operator` (`tmux.OperatorSessionName`) — in practice the workspace option, since nothing sets the hidden session's option | `LaunchOperatorRunWindow`/`buildRunWindowArgs` gain an env list → `-e FAB_AGENT_PRESET=<name>` on its `new-window` |
| Operator chat window | `cmd/rk/operator.go` (`operatorResolveAgentFn`) | `_rk-operator` on the target server | same ladder; `-e` on the window it creates <!-- assumed: rk operator's chat window is included as "an agent spawned there"; the Brief lists only the run launcher explicitly --> |
| Fork / closed restore / cron respawn | `api/fork.go`, `api/closed.go`, `cmd/rk/cron_respawn_session.go` | — | **excluded** (decision 4): no ladder, no env |

`rk tutorial` (`cmd/rk/tutorial.go`) is left unchanged — it is not a group/workspace spawn. <!-- assumed: rk tutorial excluded from the lookup -->

### 6. UI — `app/frontend`

- **Types** (`src/types.ts`, `src/api/client.ts`): `ProjectSession` gains `agentPreset?: string` mapped from the session payload's `agent_preset` (follow how `sessionColor`/`flair` are mapped); `ServerInfo` gains `agent_preset?: string`; `getRiffPresets` returns `agentPresets?: FabAgentPreset[]` (reuse H1's `FabAgentPreset` type) and `agentPresetInherited?: {name: string; from: "group" | "workspace"}`; `spawnRiff` opts gain `agentPreset?: string` sent as body `agent_preset`; new client fns `setSessionAgentPreset(server, session, name | null)` and `setServerAgentPreset(server, name | null)`.
- **Spawn dialog** (`src/components/spawn-agent-dialog.tsx`): an **"Agent preset"** field next to the existing Agent Tier field (the dialog's other preset field is "Riff preset" since H1). Native `<select>`, `aria-label="Agent preset"`:
  - first option = inherit (value `""`): label `Group default: codex-review` / `Workspace default: codex-review` when `agentPresetInherited` is set, else `Default (machine setting)`.
  - then one option per preset (`name — description`), then `none — no preset, even the machine default` (sends `none`).
  - Hidden entirely when `agentPresets` is absent (older fab / fab failure). Sends `agent_preset` only when the user picked something other than inherit.
- **Indication (decided: both cards)**:
  - Session-row flyout card (`src/components/sidebar/row-flyout-card.tsx`, session card): a facts line `agent preset: codex-review` when `agentPreset` is set.
  - Server card (`src/components/sidebar/server-card.tsx` `ServerCardContent`, shared by the sidebar server-row flyout and the Server page tile): a line `agent preset: codex-review`.
  - A value not in the known preset list renders `codex-review (unknown)` with a "Clear agent preset" action row on that card. "Known" = the preset list the UI has for that scope (the machine list from `GET /api/fab-config`'s `agent_presets` for the workspace; the group's repo-scoped list where loaded, else the machine list); `none` renders as `none (no preset)`. When no list is available (older fab), show the raw value without an unknown marker. <!-- assumed: unknown detection is client-side against whichever list the UI has for that scope -->
- **Palette actions** (Constitution V), registered with the existing `Group: …` actions in `app.tsx` and the `Workspace: …` actions (`app.tsx` / `hooks/use-global-palette-actions.ts`):
  - `Group: Set Agent Preset…` — opens a picker listing the presets (+ `none`) for the current group; selecting POSTs the session route.
  - `Group: Clear Agent Preset` — shown only when the current group has one.
  - `Workspace: Set Agent Preset…` / `Workspace: Clear Agent Preset` — same for the current server.
  - The picker reuses an existing palette sub-list / picker pattern (e.g. how `Group: Set Color` opens its chooser); hidden when fab reports no presets.
- Updates arrive through the existing SSE stream / servers refresh — no client polling.

### 7. Snapshots — `app/backend/internal/snapshot`

- `Session` gains `AgentPreset string \`json:"agentPreset,omitempty"\`` (match the snapshot JSON's existing camelCase — it is an internal file format, not a settings/API key) filled from the layout session read (extend `tmux.ListLayoutSessions`' format / `LayoutSession` with the option); `Snapshot` gains `ServerAgentPreset string \`json:"serverAgentPreset,omitempty"\`` read best-effort like `ServerRank`.
- Restore re-applies both: the session option after the session is recreated, the server option in the "Server-scoped rk options" block next to `setServerRank`, appending a report note on failure (never failing the restore). Add the setters to `restoreOps`.
- Old snapshots without the fields restore exactly as before.

### 8. Docs, skill bundle, help fixtures

- `docs/memory/run-kit/rk-riff.md` (`--agent-preset`, the ladder, the env handoff, unchanged-when-unset, resume/fork excluded), `tmux-sessions.md` (registry rows), `layout-snapshots.md` (captured options), plus the API/UI memory files below.
- `docs/specs/ui-state.md` — the two options in the inventory.
- `rk skill` core bundle (`app/backend/cmd/rk/skill/skill.md` or whichever page documents `rk riff`): `--agent-preset`. One line in the `rk skill operator` topic (`app/backend/cmd/rk/skill/operator.md`): a workspace or group agent preset applies to agents the operator spawns.
- Help-dump fixtures/tests for the new flag (`cmd/rk/help_dump_test.go`, `tests/e2e/help-topics.spec.ts` if they cover `rk riff`).

### 9. Tests and evidence

- **Go**:
  - lookup ladder table test in `internal/riff`: explicit > session > server > none; garbage option skipped; resume/fork skips.
  - **unchanged-when-unset**: with no name, the `fab agent` argv and `cmd.Env == nil`, and the `new-window`/`split-window` argv are byte-identical to today's (golden argv assertions).
  - with a name: `FAB_AGENT_PRESET=<name>` on the fab exec env and `-e FAB_AGENT_PRESET=<name>` on `new-window` and each `split-window`.
  - validation: `ValidateAgentPresetName` cases; session/server routes reject bad charset and unknown names with nothing written, accept `none`, `null` clears; unsupported fab → 400.
  - `POST /api/riff` with `agent_preset`: charset/unknown → 400 with nothing created; valid → `Options.AgentPreset` set.
  - `parseSessions` / `buildSessionFacts` with the 10-field format; `parseServerMarks` reads `@rk_srv_agent_preset`.
  - snapshot round trip: capture → JSON → restore re-sets both options (fake ops), and an old snapshot without the fields restores unchanged.
  - operator run: `buildRunWindowArgs` carries `-e` only with a name; `openRunWindow` passes the workspace preset to the headless resolver.
  - autopilot: `RiffSpawner.Spawn` passes the group's preset; `buildPrompt` prefix uses it.
  - `cmd/rk/riff_test.go`: `--agent-preset` validation (exit 2) and pass-through.
- **Vitest**: spawn dialog field (inherit label from group/workspace, hidden without presets, sends `agent_preset` only on explicit pick, `none` option); session flyout and server card lines incl. `(unknown)` + clear; palette actions call the right client fns.
- **Playwright e2e**: dialog field and palette set/clear actions (stub `GET /api/riff/presets` with `agent_presets` + `agent_preset_inherited`); each `test()` with its JSDoc Proves/Steps block and the file header per Constitution § Test Intent Comments.
- **Demo** (plan Rule 7, Constitution § PR Evidence): a new `app/frontend/tests/demo/group-agent-preset.demo.ts`, recorded with `just demo group-agent-preset --before` on desktop and mobile, showing a group preset being set from the palette, the card indication, and the spawn dialog showing `Group default: …` — i.e. a group preset changing what a new tab launches. Attach with `gh pr edit --attach`.

### Constraints that bind the whole change

- `exec.CommandContext` with timeouts and argv slices everywhere (Constitution I, Process Execution); all tmux interaction through `internal/tmux`.
- Names validated before any subprocess; nothing written on a 400.
- fab never reads tmux; HexoKit never parses `~/.fab-kit/config.yaml` (Constitution III/IV).
- Mutations are `POST` (IX); new routes are justified by the Brief ("POST routes to set and clear each").
- Plan Rule 8: build/test in this worktree only; install no binary, restart no daemon.

## Affected Memory

- `run-kit/rk-riff`: (modify) `--agent-preset`, `Options.AgentPreset`, the explicit > group > workspace > none ladder, `FAB_AGENT_PRESET` on the fab exec and `-e` on the tab's panes, unchanged-when-unset, resume/fork excluded, every caller.
- `run-kit/tmux-sessions`: (modify) registry rows for `@rk_ses_agent_preset` and `@rk_srv_agent_preset`; the 10-field session list format; `ServerMarks.AgentPreset`.
- `run-kit/layout-snapshots`: (modify) captured/restored `agentPreset` / `serverAgentPreset`.
- `run-kit/api-and-sockets`: (modify) `POST /api/sessions/{session}/agent-preset`, `POST /api/servers/agent-preset`, `agent_preset` on session/server state, `POST /api/riff` `agent_preset`, `GET /api/riff/presets` `agent_presets` + `agent_preset_inherited`.
- `run-kit/ui/dialogs-and-state`: (modify) § Spawn-Agent Dialog — the "Agent preset" field.
- `run-kit/ui/sidebar`: (modify) the session flyout and server card agent-preset lines, unknown marker + clear.
- `run-kit/ui/keyboard-and-palette`: (modify) `Group:` / `Workspace:` Set/Clear Agent Preset actions.
- `run-kit/operator-loop`: (modify) the run window resolves and carries the workspace agent preset.
- `run-kit/operator-autopilot`: (modify) autopilot spawns follow the group/workspace preset (incl. the skill-prefix lookup).

## Impact

- **Backend (Go)**: `internal/tmux/{tmux.go,session_facts.go,operator_run.go}` (+ layout session read), `internal/validate/validate.go`, `internal/fabsysconfig/fabsysconfig.go` (export the repo-scoped preset reader), `internal/riff/{riff.go,shell.go}`, `api/{riff.go,sessions.go,servers.go,router.go}`, `internal/autopilot/{riffspawn.go,spawn.go}`, `internal/operatorloop/runner.go`, `cmd/rk/{riff.go,operator.go}`, `internal/snapshot/{snapshot.go,restore.go}`, tests alongside each.
- **Frontend**: `src/types.ts`, `src/api/client.ts`, `src/components/spawn-agent-dialog.tsx`, `src/components/sidebar/{row-flyout-card.tsx,server-card.tsx}`, `src/app.tsx` / `src/hooks/use-global-palette-actions.ts`, Vitest files, `tests/e2e/spawn-agent.spec.ts` (+ a palette spec), new demo spec.
- **Docs**: memory files above, `docs/specs/ui-state.md`, `rk skill` bundle pages, help-dump fixtures.
- **External contracts**: additive only — new routes, new optional body/JSON fields, new CLI flag. The spawn path is shared by the autopilot and operator, so the unchanged-when-unset guarantee is load-bearing. Requires fab ≥ 2.31 for presets; degrades to "field hidden, setters 400" on older fab.
- **Out of scope**: a CLI verb for setting options (decision 2), a per-tab record (decision 3), changing a running tab's preset, storing the preset on the change, tmux environment variables, a separate operator preset.

## Open Questions

- None blocking. The plan's three H2 open decisions and the resume/fork question were asked and resolved (see Origin). Softer apply-time details are recorded as graded assumptions below.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is the H2 Brief only; base branch is H1 (`261124-m39n-…`) | User instruction + plan step table | S:95 R:85 A:95 D:95 |
| 2 | Certain | Storage is `@rk_ses_agent_preset` (session) / `@rk_srv_agent_preset` (server), one name each, unset when empty; registered in tmux-sessions memory and `ui-state.md` | Plan decisions "Group and workspace storage", "Key casing"; Brief "Options" | S:95 R:80 A:95 D:95 |
| 3 | Certain | Ladder explicit pick > session option > server option > nothing; with a name, `FAB_AGENT_PRESET` on the `fab agent` exec (interactive + headless) and `-e FAB_AGENT_PRESET` on the tab's panes; with none, argv and env identical to today | Brief "Lookup at spawn"; plan decision "How fab gets the group/workspace choice" | S:95 R:75 A:90 D:90 |
| 4 | Certain | Group/workspace indication on both the session flyout card and the server card; no row glyph | Asked — user chose "Both cards (Recommended)" | S:95 R:85 A:90 D:95 |
| 5 | Certain | No CLI verb sets the options in H2; only `rk riff --agent-preset` is added | Asked — user chose "No verb in H2 (Recommended)" | S:95 R:85 A:90 D:95 |
| 6 | Certain | A tab does not record its launch preset | Asked — user chose "No (Recommended)" | S:95 R:85 A:90 D:95 |
| 7 | Certain | Resume/fork spawns (fork, closed restore, cron session respawn) skip the ladder and pass nothing | Asked — user chose "Skip the lookup (Recommended)"; avoids a Codex group preset breaking a Claude resume's provider check | S:95 R:80 A:90 D:95 |
| 8 | Certain | Setters validate charset (`ValidateIdentifier`) before any subprocess, then membership in fab's list or reserved `none`; nothing written on a 400; POST routes `/api/sessions/{session}/agent-preset` and `/api/servers/agent-preset` mirroring color/flair and protect | Brief "Options"/"API and state"; Constitution I/IX; existing handler patterns | S:85 R:80 A:85 D:80 |
| 9 | Confident | Option values are not membership-checked at spawn (stale names spawn; fab warns); garbage that fails the charset is skipped with a warning | Brief "Stale names"; charset guard keeps argv clean | S:75 R:85 A:80 D:75 |
| 10 | Confident | Group setter validates against the list resolved in the session's repo root (machine list when no repo); workspace setter against the machine-wide list (`Dir=$HOME`) | Project-defined presets only exist inside a repo; a workspace spans repos | S:55 R:80 A:65 D:55 |
| 11 | Confident | The dialog's data rides `GET /api/riff/presets` (`agent_presets` repo-scoped, `agent_preset_inherited` {name, from}) instead of a new GET route | Existing one-preflight-fetch pattern; Constitution IV resists new routes | S:65 R:85 A:75 D:70 |
| 12 | Confident | The dialog offers inherit (labelled with the group/workspace default), each preset, and `none` (no preset even the machine default); hidden when fab gives no presets | Brief "showing the inherited value … one-off pick. Hide it when fab reports no presets"; fab accepts `none` | S:60 R:85 A:70 D:60 |
| 13 | Confident | Setters accept `none` too (a group can opt out of the workspace or machine preset) | fab's reserved value; consistent with the dialog | S:55 R:85 A:70 D:60 |
| 14 | Confident | `-e FAB_AGENT_PRESET` goes on `new-window` and every `split-window` of the same spawn, so every pane of the tab resolves the same preset | Brief names new-window/first pane; multi-pane `rk riff` tabs would otherwise diverge | S:60 R:85 A:75 D:65 |
| 15 | Confident | Operator run uses the ladder with session `_rk-operator` (effectively the workspace option) and gets `-e` on its run window; autopilot uses the item's group session and its skill-prefix lookup uses the same preset | Brief "Every caller"; a Codex preset changes the skill prefix | S:70 R:80 A:75 D:70 |
| 16 | Tentative | `rk operator`'s chat window follows the same ladder (session `_rk-operator`); `rk tutorial` is left unchanged | Plan goal "every agent spawned there … including the ones the operator starts"; the Brief lists only the run launcher | S:40 R:80 A:50 D:45 |
| 17 | Tentative | "(unknown)" is decided client-side against the preset list the UI has for that scope (machine list for workspace; repo list where loaded, else machine list for a group); no marker when no list is available | Brief "Show the value as unknown in the UI with a way to clear it"; avoids a fab exec per SSE derive | S:45 R:85 A:50 D:40 |
| 18 | Confident | Snapshot fields `agentPreset` (session) / `serverAgentPreset` (snapshot root) in the snapshot's existing camelCase; restore failures become report notes | Snapshot JSON is an internal file format already camelCase (`serverRank`, `sessionOrder`); mirrors ServerRank handling | S:60 R:85 A:75 D:65 |
| 19 | Confident | The repo-scoped preset reader is extracted from H1's `fabsysconfig.listPresets` rather than duplicated | code-quality anti-pattern "Duplicating existing utilities" | S:65 R:85 A:80 D:70 |
| 20 | Confident | Palette actions `Group: Set/Clear Agent Preset` and `Workspace: Set/Clear Agent Preset`, the Set actions opening a picker in the palette's existing chooser pattern | Brief "Palette actions to set and clear …"; existing `Group:`/`Workspace:` naming | S:65 R:85 A:70 D:65 |

20 assumptions (8 certain, 10 confident, 2 tentative, 0 unresolved).
