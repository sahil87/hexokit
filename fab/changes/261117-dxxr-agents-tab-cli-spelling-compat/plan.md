# Plan: Agents Tab Survives the provider → cli Rename

**Change**: 261117-dxxr-agents-tab-cli-spelling-compat
**Intake**: `intake.md`

## Requirements

### Backend: Dual-spelling reads

#### R1: Tool names from both tables
`fabsysconfig` SHALL derive the tool list from both `providers.<name>.*` and `clis.<name>.*` rows of
`fab config show --origin --json`, de-duplicated and sorted.

- **GIVEN** fab emits only `clis.claude.*` and `clis.codex.*` rows
- **WHEN** the Agents document is read
- **THEN** `tools` is `["claude", "codex"]`
- **AND** a fab emitting both `providers.codex.*` and `clis.codex.*` yields `codex` once

#### R2: Role tool leaf read with new-wins fallback
A role's tool cell SHALL read `agent.profiles.<role>.cli`, falling back to `agent.profiles.<role>.provider`
when no `.cli` row exists. Per-tool table lookups (model suggestions, effort capability, inherited
fills via `fillKey`) SHALL consult `clis.<tool>…` before `providers.<tool>…`; model suggestions union
both prefixes. A cell's `source` SHALL name the key the value actually came from.

- **GIVEN** a new-spelling fab with `agent.profiles.doing.cli` derived from `agent.workers` and
  `clis.agy.profiles.default.model: gemini-3.1-pro-high`
- **WHEN** the document is read with `agent.workers = agy`
- **THEN** the `doing` model cell inherits `gemini-3.1-pro-high` with source `clis.agy.profiles.default.model`
- **AND** with both `.cli` and `.provider` rows present for a role, the `.cli` value wins

#### R3: Env-shadow lookup uses the read spelling
When a role's tool cell is env-shadowed, the system-value stack read SHALL query the key spelling that
produced the row (`agent.profiles.<role>.cli` or `.provider`).

- **GIVEN** a new-spelling fab whose `agent.profiles.review.cli` origin is `env`
- **WHEN** the document is read
- **THEN** fab is asked `config show agent.profiles.review.cli --origin --json`

### Backend: Probed write spelling

#### R4: Spelling probe per request
The Client SHALL choose the write spelling from output it already fetched — `cli` when any show row
key starts `clis.` or is an `agent.profiles.<role>.cli` key, or when `fab config explain --json` lists
`clis` / a `clis.` key / an `agent.profiles.<role>.cli` key; otherwise `provider`. No extra fab call is
added and no choice persists across requests.

- **GIVEN** fab 2.30.0 output (only `providers.*` and `.provider` rows; explain lists `providers`)
- **WHEN** a tool write is applied
- **THEN** the argv is `config set agent.profiles.<role>.provider <v> --system`
- **AND** given a fab whose explain lists `clis` but show has no `clis.` row, `Read` still probes `cli`

#### R5: Neutral and both literal tool leaves accepted, mapped to the probed spelling
Patches SHALL accept the role tool leaf as `tool`, `cli` or `provider`, validated as a tool name, and
write it under the probed spelling. A patch naming one role's tool leaf under two spellings SHALL be a
`ValidationError` before any exec. Unknown tool values fail with `unknown CLI "<v>" (available: …)`.

- **GIVEN** a new-spelling fab
- **WHEN** POSTing `{"agent.profiles.review.tool": "codex"}`
- **THEN** fab runs `config set agent.profiles.review.cli codex --system`
- **AND** `{"agent.profiles.review.tool": null}` runs `config unset agent.profiles.review.cli --system`
- **AND** `{"agent.profiles.review.tool": "codex", "agent.profiles.review.provider": "kimi"}` is a 400 with no exec

### API: Neutral document shape

#### R6: Document uses neutral field names
The `/api/fab-config` document SHALL expose `tools` (was `providers`) and `roles[].tool` (was
`roles[].provider`); the frontend SHALL send `agent.profiles.<role>.tool` for every role tool write.

- **GIVEN** the SPA changes the `doing` row's CLI
- **WHEN** it POSTs
- **THEN** the body key is `agent.profiles.doing.tool`

### UI: CLI labels

#### R7: Relabel Provider → CLI in the Agents tab
The Agents tab SHALL label the role-table column "CLI", each role's tool select "<role> CLI", the
depth knobs "Session CLI" / "Worker CLI", the section "Agent CLIs", the env warning "CLI set by an
environment variable" / "… sets this CLI …", and the footer SHALL name the table by both config keys.

- **GIVEN** the Agents tab is open
- **WHEN** it renders
- **THEN** the column header reads "CLI" and the knobs read "Session CLI" and "Worker CLI"
- **AND** no visible or accessible label in the tab says "provider"

### Non-Goals

- rk's own "provider" naming (`cmd/rk/agent_registry.go`, `internal/riff`, `agentProvider`, `@rk_*` options) — rk's business per the plan's N1 non-goals
- Cleaning an old-spelled `.provider` key from the user file under a post-N1 fab — fab's unset/migration contract (N1)
- Model discovery, the tool-default token — later steps H4/H3

### Design Decisions

#### Backend owns the fab spelling; the SPA speaks a neutral leaf
**Decision**: the SPA reads `tools` / `roles[].tool` and writes `agent.profiles.<role>.tool`; `fabsysconfig` maps it to `.cli` or `.provider` by probing the installed fab's own `show`/`explain` output per request.
**Why**: one place knows fab's spelling, so the tab works against fab before, during and after the `provider` → `cli` rename without the SPA tracking fab versions; the probe reuses output already fetched.
**Rejected**: switching spelling in lockstep with fab (forces simultaneous releases); keying on fab's version number (brittle); a process-wide cached probe (stale across a fab upgrade, Constitution II).
*Introduced by*: 261117-dxxr-agents-tab-cli-spelling-compat

#### New spelling wins on reads
**Decision**: role leaves and table lookups try `cli`/`clis.` first, then `provider`/`providers.`; tool names are the union.
**Why**: mirrors fab N1's resolver rule (either spelling per field, new wins) so hexokit shows what fab resolves during the deprecation window.
**Rejected**: reading only the probed spelling (loses values written in the other spelling mid-window).
*Introduced by*: 261117-dxxr-agents-tab-cli-spelling-compat

## Tasks

### Phase 2: Core Implementation

- [x] T001 `app/backend/internal/fabsysconfig/fabsysconfig.go`: spelling probe on the Client (set in `Read` from show rows + explain keys, in `Apply` from loaded rows); dual-read tool names, role tool leaf, `modelSuggestions`/`effortCapable`/`fillKey` across `clis.`/`providers.`; env-shadow lookup on the read key; accept `tool`/`cli`/`provider` leaves, map to probed spelling, reject duplicate tool leaf; `unknown CLI` message; `Document.Tools` / `Role.Tool` JSON rename <!-- R1 R2 R3 R4 R5 R6 -->
- [x] T002 `app/backend/internal/fabsysconfig/fabsysconfig_test.go`: update existing tests to `Tools`/`Tool`/`.tool`; add old/new/mixed spelling fixtures covering reads, writes, literal leaves, explain-only probe, duplicate-leaf 400, env-shadow key <!-- R1 R2 R3 R4 R5 -->
- [x] T003 `app/frontend/src/api/client.ts`, `app/frontend/src/components/settings-agents-panel.tsx`, doc comments in `app/backend/api/fab_config.go`: neutral `tools`/`tool` types, `profileKey(…, "tool")` writes, CLI relabels <!-- R6 R7 -->
- [x] T004 `app/frontend/src/components/settings-agents-panel.test.tsx`, `app/frontend/tests/e2e/_fab-config-stub.ts`, `app/frontend/tests/e2e/settings-agents.spec.ts`, `app/frontend/tests/demo/agents-{model-list,effort-capability,settings-provenance}.demo.ts`: move fixtures, selectors and expected POST bodies to the neutral leaf and new labels; assert the CLI labels <!-- R6 R7 -->

### Phase 3: Integration & Edge Cases

- [x] T005 Run `just test-backend`, `just test-frontend`, frontend type check, and `just test-e2e settings-agents`; fix fallout <!-- R1 R5 R6 R7 -->

## Acceptance

### Functional Completeness

- [ ] A-001 R1: Tool names are the sorted union of `providers.<n>.*` and `clis.<n>.*` row names
- [ ] A-002 R2: A role's tool cell reads `.cli` first, `.provider` second; suggestions, effort capability and inherited fills resolve under either table prefix with `clis.` winning
- [ ] A-003 R3: An env-shadowed tool cell's system-value read queries the spelling that produced the row
- [ ] A-004 R4: The write spelling is probed from already-fetched `show`/`explain` output, defaults to `provider`, and adds no fab subprocess call
- [ ] A-005 R5: `tool`, `cli` and `provider` leaves are accepted and written under the probed spelling; duplicate tool leaves for one role are a ValidationError before exec
- [ ] A-006 R6: The document exposes `tools` and `roles[].tool`; every SPA tool write sends `agent.profiles.<role>.tool`
- [ ] A-007 R7: The tab shows "CLI" column, "<role> CLI" selects, "Session CLI"/"Worker CLI" knobs, "Agent CLIs" region, CLI env-warning wording and a footer naming `providers:` / `clis:`

### Scenario Coverage

- [ ] A-008 R4: Go tests exercise reads and writes against an old-spelling fixture, a new-spelling fixture and a mixed fixture
- [ ] A-009 R7: Frontend unit and e2e tests assert the new labels and the `.tool` POST bodies

### Edge Cases & Error Handling

- [ ] A-010 R5: An unknown tool value fails with `unknown CLI` and runs no fab call
- [ ] A-011 R4: The explain-only signal (no `clis.` show row) selects the new spelling

### Code Quality

- [ ] A-012 Pattern consistency: New code follows the package's naming and structural patterns (constants for key fragments, argv-slice execs)
- [ ] A-013 No unnecessary duplication: one helper resolves "new spelling then old" for both role leaves and table lookups
- [ ] A-014 Subprocess safety: no new exec path; existing execs stay `exec.CommandContext` with `FabTimeout`
- [ ] A-015 Tests: changed behavior is covered by Go, Vitest and Playwright tests; e2e `test()` JSDoc Proves/Steps blocks match the updated bodies
- [ ] A-016 No magic strings: spelling fragments (`clis.`, `cli`, `tool`) are named constants
- [ ] A-017 No comment narration: comments state constraints, not history or change IDs

### Security

- [ ] A-018 R5: Mapped keys are built only from the allowlisted role names and the fixed leaf set; values still pass the tool-name allowlist before reaching argv

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Probe from `Read`'s explain output only in `Read`; `Apply` probes from show rows alone (it does not run explain today) | Brief accepts either signal; show rows are the stronger one (a renamed fab emits `clis.` default rows for its built-in CLIs); adding explain to `Apply` would be a new subprocess per write | S:75 R:85 A:80 D:75 |
| 2 | Confident | The Read path's probe result is not used for writes; `Apply` re-probes from its own rows under `applyMu` | Write spelling must match the fab that receives the write in that request | S:80 R:90 A:85 D:80 |
| 3 | Confident | `effortCapable` checks each command leaf under `clis.` first, then `providers.` | Same new-wins rule as other lookups | S:80 R:90 A:85 D:85 |
| 4 | Tentative | Role cells expose the neutral leaf name only in the JSON; the row-key spelling is visible via `source` | Keeps the SPA spelling-agnostic; source still shows the real key | S:60 R:85 A:70 D:65 |

4 assumptions (0 certain, 3 confident, 1 tentative).
