# Plan: Agents settings tab for fab-kit's system config

**Change**: 261030-wf1x-fab-system-config-agents-tab
**Intake**: `intake.md`

## Requirements

### Backend: fab CLI wrapper

#### R1: The wrapper reads fab's machine-wide config through its JSON contract only
A new package `app/backend/internal/fabsysconfig` SHALL build the settings document from `fab config show --origin --json`, `fab config explain --json` and (only for keys whose winner is `env`) `fab config show <key> --origin --json`. It MUST decode with `encoding/json`, MUST NOT parse `~/.fab-kit/config.yaml` or the `show --origin` text, and MUST hold no cache — every read re-runs fab.

- **GIVEN** fab reports `agent.workers` from the system tier and `agent.profiles.doing.provider` derived from `agent.workers`
- **WHEN** the document is built
- **THEN** `fields["agent.workers"]` carries value/origin/originDetail, and the `doing` role's provider cell has `override: null`, `effective` = the resolved provider and `source: "agent.workers"`

#### R2: Every fab call is a bounded argv exec from `$HOME` behind an injectable runner
Every fab invocation SHALL use `exec.CommandContext` with an argv slice, a 10 s timeout and `Dir = $HOME`, capture stdout and stderr separately, and go through a `Runner` seam so tests never run the real binary. fab presence SHALL be detected with `exec.LookPath("fab")`; when absent the read returns `installed:false` and no error.

- **GIVEN** `fab` is not on PATH
- **WHEN** the document is read
- **THEN** it is `{"installed": false}` with no error

#### R3: The document exposes fields, providers, roles and suggestions
The document SHALL contain `installed`, `systemPath`, `providers` (sorted, derived from `providers.<name>.*` keys — never hard-coded), `fields` for the seven v1 scalar keys, `roles` in the order default, operator, doing, fast, hydrate, review (depth `session` for the first two, `workers` for the rest) with provider/model/effort cells `{override, effective, source, origin, originDetail}`, `modelSuggestions` per provider (from `providers.<p>.profiles.*.model`) and `effortSuggestions` (`low, medium, high, xhigh, max`). A cell's `override` SHALL be set only when its origin is `system`. When a role's model/effort leaf is not set, its effective value and source come from the resolved provider's `providers.<p>.profiles.<role>.*` leaf, and are empty when that does not exist. A key whose winner is `env` SHALL also carry `systemValue` when a system tier value exists.

- **GIVEN** `FAB_AGENT_WORKERS=kimi` wins over a system `agent.workers: codex`
- **WHEN** the document is built
- **THEN** `fields["agent.workers"]` is `{value: "kimi", origin: "env", originDetail: "FAB_AGENT_WORKERS", systemValue: "codex"}`

### Backend: writes

#### R4: Writes are validated server-side before any exec
A write patch SHALL be validated in full before fab is invoked. Keys MUST be in the allowlist (`agent.session`, `agent.workers`, `agent.profiles.<role>.{provider,model,effort}` for the six roles, `dispatch.mode`, `dispatch.column_width`, `dispatch.min_cols`, `dispatch.min_rows`, `dispatch.reap_done`). Providers MUST be in the effective providers list; `dispatch.mode` MUST be `pane|native|headless`; `column_width` an integer 1–99; `min_cols`/`min_rows` positive integers; `reap_done` a bool; model/effort single-line, non-empty after trim, ≤128 chars, no `#`, no leading `-`, no control characters. For `agent.profiles.<role>.*` leaves an empty string means unset. Any failure is a validation error and nothing is exec'd.

- **GIVEN** a patch `{"dispatch.mode": "weird"}`
- **WHEN** it is applied
- **THEN** a validation error is returned and fab is never invoked for set/unset

#### R5: Set and unset map to `fab config set|unset --system` argv
A non-null value SHALL run `fab config set <key> <value> --system`; `null` SHALL run `fab config unset <key> --system`. Calls run sequentially in sorted key order, stop at the first failure (the error carries fab's stderr), and a successful apply re-reads and returns the fresh document plus `warnings` (fab stderr lines of successful writes that contain "warning").

- **GIVEN** `{"agent.workers": "codex", "agent.profiles.review.model": null}`
- **WHEN** applied
- **THEN** argv `config set agent.workers codex --system` and `config unset agent.profiles.review.model --system` are executed and the fresh document is returned

### Backend: HTTP

#### R6: `/api/fab-config` follows the settings GET + partial-merge POST contract
`GET /api/fab-config` SHALL return the document (re-read every time). `POST /api/fab-config` SHALL accept `{key: value|null}`, return 400 on malformed body/validation failure (before exec), 503 when fab is not installed, 502 with fab's stderr on a non-zero exit, and 200 with the fresh document plus `warnings` otherwise. Only GET and POST are used and the route is registered next to `/api/settings`.

- **GIVEN** a stub runner and a valid POST body
- **WHEN** the handler runs
- **THEN** the response is 200 with the re-read document, and a body key outside the allowlist is 400 with no set/unset argv recorded

### Frontend: placement and data

#### R7: A curated "Agents" tab lives in the existing Settings dialog
`SettingsTab` SHALL include `"agents"`; the rail SHALL read General, Appearance, Agents, Shortcuts, All settings; `openSettings("agents")` SHALL open on it and a tab-less open SHALL still land on General. No new route, page or dialog is added and fab keys are not added to the All-settings registry table.

- **GIVEN** the dialog is closed
- **WHEN** `openSettings("agents")` is called
- **THEN** the Agents tab is selected and the rail order is General, Appearance, Agents, Shortcuts, All settings

#### R8: The tab re-fetches on every visit and never caches
The Agents panel SHALL call `getFabConfig()` each time it mounts (dialog open on Agents, or switching to the tab) and render from the document each POST returns.

- **GIVEN** the user leaves Agents and returns
- **WHEN** the panel mounts again
- **THEN** `GET /api/fab-config` is requested again

### Frontend: panel UI

#### R9: Session/worker agents, dispatch rows and provenance
The panel SHALL render, under `ScopeHeading` "Agents" (hint `~/.fab-kit/config.yaml · machine-wide, outranks project files`), latched provider chips for `agent.session` and `agent.workers`, and under `ScopeHeading` "Dispatch" (hint `how worker stages are launched`) a mode chip group, a `column_width` number input with `%`, `min_cols`/`min_rows` number inputs on one row, and a `reap_done` `BoolToggle`. Each row SHALL show a provenance chip (`system|env|default`, `project` as a read-only chip), a modified dot when a system override exists, and a `reset` link (→ `null` POST) only when a system override exists. Chips and the toggle commit on change; number inputs commit on blur/Enter and Escape reverts. A failed write shows fab's message inline on that row and leaves the previous value in place.

- **GIVEN** `agent.workers` has origin `default`
- **WHEN** the panel renders
- **THEN** the row shows a `default` chip, no modified dot and no reset link; after choosing `codex` the POST `{"agent.workers":"codex"}` is sent

#### R10: Env-shadow warning
When a field's (or role provider cell's) origin is `env`, its row SHALL show an inline amber warning that the saved system value does not take effect until the variable named in `originDetail` is unset. Any `warnings` returned by a POST SHALL be shown verbatim.

- **GIVEN** `agent.workers` origin is `env` with detail `FAB_AGENT_WORKERS`
- **WHEN** the panel renders
- **THEN** the warning names `FAB_AGENT_WORKERS`

#### R11: Per-role override table
The panel SHALL render a role table with columns role, tier, provider, model, effort, reset. Provider is a select (first option = inherit), model is a text input with a datalist of the row's resolved provider's suggestions, effort is a select of `effortSuggestions` plus inherit. Unset cells show the inherited value dimmed with a `↳` prefix (`↳ provider default` when empty). Choosing inherit/blank POSTs `null` for that leaf. A row's `reset` (visible only when any leaf has an override) POSTs `null` for all three leaves in one request. A model override that is not in the resolved provider's non-empty suggestion list SHALL show a warning marker (not a block). The table scrolls inside its own wrapper on phones.

- **GIVEN** the `doing` role has no provider override and `agent.workers` is kimi
- **WHEN** the table renders
- **THEN** the provider cell shows `↳ kimi` dimmed, and picking inherit on an overridden leaf POSTs that key as `null`

#### R12: fab-not-installed empty state
When `installed:false`, the tab SHALL show only the scope heading and "fab isn't installed on this host. Install fab-kit to manage agent defaults here." with no error toast or console error.

- **GIVEN** the API returns `{"installed": false}`
- **WHEN** the tab renders
- **THEN** only the empty-state message is shown

#### R13: Footer
The panel SHALL end with a footer stating that the providers table and other list/map keys can't be set from the CLI and that project-only keys (`fab/project/config.yaml`) aren't shown, and SHALL show the system config path with a copy-path control.

- **GIVEN** the document has a `systemPath`
- **WHEN** the panel renders
- **THEN** the footer shows the path and a copy button

### Keyboard-first

#### R14: Palette entry
`use-global-palette-actions.ts` SHALL register `Settings: Agents` (id `settings-agents`) → `openSettings("agents")` next to the other `Settings:` entries. All controls in the tab are native, keyboard-operable elements.

- **GIVEN** the palette is open
- **WHEN** `Settings: Agents` is selected
- **THEN** the dialog opens on the Agents tab

### Governance and evidence

#### R15: Constitution IV amendment
`fab/project/constitution.md` Principle IV SHALL gain the intake §6 sentence, the version SHALL go 2.2.0 → 2.3.0 and Last Amended SHALL be 2026-10-31.

- **GIVEN** the constitution
- **WHEN** read after the change
- **THEN** Principle IV states the settings surface MAY host a curated fab system-config tab read/written only through the `fab config` CLI, and Governance reads `Version: 2.3.0 | Last Amended: 2026-10-31`

#### R16: Tests never touch the developer's real fab config
Go tests and Vitest SHALL use the injectable runner / mocked client; Playwright e2e and the demo SHALL stub `/api/fab-config` at the browser (`page.route`) so no fab write can reach `~/.fab-kit/config.yaml`.

- **GIVEN** the test suites run
- **WHEN** they finish
- **THEN** `~/.fab-kit/config.yaml` is unchanged

### Non-Goals
- Merging fab keys into the All-settings registry table — two owners and sources.
- `autopilot.merge_mode`, project-only keys and the `providers` table — outside the v1 set.
- Opening the config in the code tile via the code bridge — no existing frontend seam; a copy-path control is the fallback (Assumption 3).
- Fixing the upstream `fab agent` nil-writer panic or the missing env-tier warning — file with fab-kit.

### Design Decisions

#### Inherited model/effort derive from the `show --origin --json` rows
**Decision**: Role cells read `agent.profiles.<role>.*` rows and fall back to `providers.<resolved>.profiles.<role>.*` rows from the single `show --origin --json` call; no `fab agent <role>` calls.
**Why**: fab ≥ 2.28.11 reports typed values, origin and `derived_from` in one call; avoids six extra subprocesses per GET.
**Rejected**: `fab agent <role> -o yaml` per role (intake's original proposal) — superseded by the JSON contract and costs six execs.
*Introduced by*: 261030-wf1x-fab-system-config-agents-tab

## Tasks

### Phase 1: Setup

- [x] T001 Amend Constitution IV, bump to 2.3.0, Last Amended 2026-10-31 in `fab/project/constitution.md` <!-- R15 -->
- [x] T002 [P] Add `"agents"` to `SettingsTab` in `app/frontend/src/contexts/settings-dialog-context.tsx` <!-- R7 -->

### Phase 2: Core Implementation

- [x] T003 Create `app/backend/internal/fabsysconfig/` (`fabsysconfig.go`: Runner seam, Client, document types, Read, validation, Apply) <!-- R1 R2 R3 R4 R5 -->
- [x] T004 Create `app/backend/internal/fabsysconfig/fabsysconfig_test.go` (document building, installed:false, argv shape, validation, env systemValue, role fallback) <!-- R1 R2 R3 R4 R5 -->
- [x] T005 Create `app/backend/api/fab_config.go` handlers + `Server.fabSys` seam and register routes in `app/backend/api/router.go` <!-- R6 -->
- [x] T006 Create `app/backend/api/fab_config_test.go` (GET, POST partial-merge/null, 400/502/503, installed:false) <!-- R6 R16 -->
- [x] T007 Add typed `getFabConfig`/`postFabConfig` + document types to `app/frontend/src/api/client.ts` <!-- R6 R8 -->
- [x] T008 Create `app/frontend/src/components/settings-agents-panel.tsx` (rows, provenance, reset, env warning, role table, dispatch, footer, empty state) <!-- R8 R9 R10 R11 R12 R13 -->
- [x] T009 Wire the tab into `app/frontend/src/components/settings-dialog.tsx` (`SETTINGS_TABS` order, panel mount) <!-- R7 -->
- [x] T010 Add `Settings: Agents` entry in `app/frontend/src/hooks/use-global-palette-actions.ts` <!-- R14 -->

### Phase 3: Integration & Edge Cases

- [x] T011 Create `app/frontend/src/components/settings-agents-panel.test.tsx` (chips, provenance, reset visibility, `↳` cells, env warning, not-installed, error inline, inherit→null, re-fetch) <!-- R8 R9 R10 R11 R12 R13 R16 -->
- [x] T012 Update `settings-dialog.test.tsx` (tab order, deep link) and `use-global-palette-actions.test.tsx` (new entry) <!-- R7 R14 -->
- [x] T013 Add Playwright spec `app/frontend/tests/e2e/settings-agents.spec.ts` with `page.route` stub (tab order, palette deep link, set/reset flow, phone collapse, not-installed) <!-- R7 R9 R12 R14 R16 -->
- [x] T014 Add demo spec `app/frontend/tests/demo/agents-settings.demo.ts` <!-- R7 R9 -->

### Phase 4: Polish

- [x] T015 Run `just test-backend`, `just test-frontend`, tsc, and the new e2e spec; fix failures <!-- R16 -->

## Execution Order

- T003 blocks T004, T005; T005 blocks T006
- T007 blocks T008; T008 blocks T009, T011; T002 blocks T009, T010, T012
- T013/T014 need T009 and T010

## Acceptance

### Functional Completeness

- [x] A-001 R1: `fabsysconfig.Read` builds the document from the three JSON fab calls with no YAML/text parsing and no cache
- [x] A-002 R2: Every fab call is `exec.CommandContext` argv with a 10 s timeout, `Dir=$HOME`, behind a `Runner` seam; absent fab yields `installed:false`
- [x] A-003 R3: The document has installed, systemPath, providers, fields, roles (ordered), modelSuggestions, effortSuggestions with `override` only for system-origin cells
- [x] A-004 R4: Allowlist and value validation reject bad patches before any exec
- [x] A-005 R5: set/unset argv and warnings/re-read behavior match the spec
- [x] A-006 R6: GET/POST `/api/fab-config` registered next to `/api/settings` with the specified status mapping
- [x] A-007 R7: Agents tab sits between Appearance and Shortcuts; `openSettings("agents")` deep-links; tab-less open lands on General
- [x] A-008 R8: The panel fetches on every mount
- [x] A-009 R9: Chips, number inputs, toggle, provenance chip, modified dot and reset link behave per spec
- [x] A-010 R10: Env origin renders the amber shadow warning naming the variable; POST warnings render verbatim
- [x] A-011 R11: Role table shows inherited `↳` cells, inherit→null, row reset in one POST, model-mismatch warning, internal scroll wrapper
- [x] A-012 R12: Not-installed state renders without errors
- [x] A-013 R13: Footer text and copy-path control present
- [x] A-014 R14: `Settings: Agents` palette entry opens the tab
- [x] A-015 R15: Constitution IV amended, version 2.3.0, Last Amended 2026-10-31

### Behavioral Correctness

- [x] A-016 R7: Existing General/Appearance/Shortcuts/All tabs and roving-tabindex nav still work with five tabs
- [x] A-017 R9: A failed write leaves the previous value and shows fab's message on that row

### Scenario Coverage

- [x] A-018 R5: Go test covers set+unset in one patch with exact argv
- [x] A-019 R16: No test writes the real `~/.fab-kit/config.yaml` (runner seam / mocked client / `page.route`)

### Edge Cases & Error Handling

- [x] A-020 R4: Empty/`#`/leading-dash/over-long model values, out-of-range column_width and unknown providers are rejected
- [x] A-021 R6: fab non-zero exit → 502 with stderr; fab missing on POST → 503

### Code Quality

- [x] A-022 Pattern consistency: New code follows naming and structural patterns of surrounding code
- [x] A-023 No unnecessary duplication: Existing utilities reused (PreferenceRow idioms, `useTextSettingDraft`, `BoolToggle`, `controlClass`, `writeJSON/writeError`)
- [x] A-024 Subprocess hygiene: no shell strings, all calls `exec.CommandContext` with timeout
- [x] A-025 Test intent comments: new Playwright `test()` blocks carry Proves/Steps JSDoc and a file header
- [x] A-026 No magic strings: key names, roles and limits are named constants

### Security

- [x] A-027 R4: User-supplied values reach fab only as argv elements after validation; values can't parse as flags

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant (`PreferenceRow` was moved from `settings-dialog.tsx` into `text-setting-core.tsx`, not duplicated).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Inherited model/effort come from the `show --origin --json` rows (agent.profiles leaf, else resolved provider's providers.<p>.profiles leaf) — no `fab agent <role>` calls | Clarified intake says JSON provenance suffices; one call, no six extra execs | S:70 R:80 A:75 D:65 |
| 2 | Confident | e2e/demo stub `/api/fab-config` with `page.route` rather than a stub `fab` on the rig PATH | A PATH stub would affect every other e2e that shells out to fab; `page.route` is the repo's established stub idiom and cannot write the real config. One real-fab isolated-HOME pass is a ship-time item | S:60 R:80 A:70 D:60 |
| 3 | Tentative | Footer ships a copy-path control instead of a code-bridge `vscode.open` link | No frontend seam opens an absolute path in the code tile; intake flagged the mechanism as a guess and named copy-path as the fallback | S:50 R:75 A:55 D:50 |
| 4 | Confident | Model is free text + datalist; effort is a select of low/medium/high/xhigh/max + inherit | Intake assumption #17 default; fab has no enum | S:55 R:80 A:60 D:55 |
| 5 | Confident | POST returns 503 when fab is not installed and stops at the first failing fab call (earlier writes persist) | fab has no transactional multi-key write; sorted order keeps it deterministic | S:55 R:75 A:70 D:60 |
| 6 | Certain | `autopilot.merge_mode` stays out of v1 | Intake non-goal | S:90 R:85 A:90 D:90 |

6 assumptions (1 certain, 4 confident, 1 tentative).
