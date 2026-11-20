# Intake: Agents Tab Survives the provider → cli Rename

**Change**: 261117-dxxr-agents-tab-cli-spelling-compat
**Created**: 2026-11-17

## Origin

> Execute step H5 (Read and write both providers/provider and clis/cli spellings; relabel Provider → CLI) of the plan at /home/sahil/code/sahil87/fab-kit/fab/plans/sahil/26-11-16-model-pins.md. Read the whole plan first (Decisions and Rules bind you), then implement only the H5 Brief.

One-shot, operator-dispatched step of the cross-repo "model pins" plan (fab-kit + hexokit). The plan
lives only in the fab-kit checkout at the absolute path above; read it for the full context, but this
change implements **only H5**. Its predecessors in hexokit, H1 (role model cell) and H2 (inherit label
honours `profiles.default`, `effortCapable`), have landed on this branch (`fillKey`, `effortCapable`,
`toolChangePatch`, `StaleModelNote` all exist in the current code).

The H5 Brief, verbatim:

> - `fabsysconfig.go`: derive tool names from both `providers.<name>.*` and `clis.<name>.*` rows;
>   read a role's tool from `agent.profiles.<role>.cli`, falling back to `.provider`. Write the
>   spelling the installed fab accepts: probe once per `Read` (presence of any `clis.` row, or
>   `fab config explain --json` listing the key) and keep the choice on the `Client`.
> - Accept both spellings in `isProfileKey` / the patch keys; the frontend sends a neutral `tool` leaf
>   and the backend maps it.
> - Relabel the column and chips "CLI", and the knobs "Session CLI" / "Worker CLI".
> - Tests: the stub serves each spelling; reads and writes work against both.
> - Must be **released** before N1 is released (rule 5).

Binding plan decisions that touch this step:

- **Rename "provider" → "cli"** (fab-kit N1): config `providers:` → `clis:`, `agent.profiles.<role>.provider`
  → `.cli`, `fab agent --provider` → `--cli`, `fab agent -o yaml` `provider:` → `cli:`. UI label "CLI".
  Old spellings stay readable and settable in fab for at least one minor release with a deprecation
  warning `<old> is deprecated, wrote <new>`. N1 does not exist yet — fab today (2.30.0) only knows
  the `provider` spelling.
- **hexokit reads, never re-derives, where it can** — prefer fab's own rows and verbs.
- Rule 5: **N1 must not be released before H5 is released.** H5 is what lets the Agents tab keep
  working on both sides of the rename.
- rk's own "provider" naming for agent CLIs (`cmd/rk/agent_registry.go`, `riff`, `@rk_*` agent
  options, `agentProvider` in `client.ts`) is **out of scope** — only the fab-facing Agents tab moves.

## Why

1. **The problem**: the Agents settings tab is built on fab's current spelling. `providerNames`
   derives the tool list from `providers.<name>.*` rows of `fab config show --origin --json`;
   `buildRole` reads `agent.profiles.<role>.provider`; `validate` / `isProfileKey` only accept the
   `provider` leaf and writes go to `fab config set agent.profiles.<role>.provider … --system`;
   `modelSuggestions`, `effortCapable` and `fillKey` all look under `providers.`. When fab-kit N1 ships
   `clis:` / `.cli`, a hexokit that only knows `provider` shows an **empty tool list** (the chip rows
   for `agent.session` / `agent.workers` and every role's tool select lose their options), loses every
   role's tool override, loses model suggestions and the effort-capability flags, and writes a
   deprecated key on every tool change.
2. **Consequence of not doing it**: the tab breaks the day N1 is released for anyone running a
   released hexokit. Plan rule 5 makes N1's release wait on this one, so H5 is on the critical path
   of the rename.
3. **Why this approach**: dual-read + probed-write makes hexokit correct against fab both before and
   after N1 (and during N1's window, when fab may emit both spellings). The frontend speaks a neutral
   `tool` leaf so it never has to know which fab is installed — the backend is the single place that
   maps to fab's spelling, consistent with "fab owns the file, hexokit wraps the CLI". Relabelling
   "Provider" → "CLI" now matches N1's user-facing word, and removes the collision with "provider"
   meaning a model vendor (kimi's `[providers.openrouter]`, Claude Code routing to Fireworks).
   Rejected: waiting for N1 and switching spelling in lockstep (would need simultaneous releases and
   break users on either version skew); hard-coding the spelling by fab version number (brittle, and
   the brief asks for a capability probe).

## What Changes

### 1. Backend — `app/backend/internal/fabsysconfig/fabsysconfig.go`

**Spelling probe.** Add a spelling choice to the `Client` (e.g. a `profileToolLeaf` / `tableSpelling`
field, `"cli"` or `"provider"`), set once per `Read` and once per `Apply` from rows already loaded —
no extra fab call is required:

- New spelling (`cli` / `clis`) when **any** `fab config show --origin --json` row has a key starting
  `clis.` **or** matching `agent.profiles.<role>.cli`, or when `fab config explain --json` (already run
  by `Read` for descriptions) lists a key `clis` (or any key beginning `clis.` /
  `agent.profiles.<role>.cli`).
- Otherwise the old spelling (`provider` / `providers`) — today's fab, so a missing probe signal is
  the safe default.
- `Apply` derives the choice from the rows it already loads under `applyMu` before validating, so the
  write spelling is decided against the same fab that will receive the write. The Client is built per
  request (see the `applyMu` comment), so "keep the choice on the Client" means per request; no
  process-wide cache (Constitution II — external writers win, and a fab upgrade between requests must
  be honoured on the next request).

**Dual read.**

- `providerNames(rows)` (rename freely, e.g. `toolNames`) collects names from **both** `providers.<name>.*`
  and `clis.<name>.*` rows, de-duplicated, sorted.
- Per-tool lookups — `modelSuggestions`, `effortCapable` (`.interactive_command` / `.headless_command`
  containing `{effort}`), `fillKey` (`<table>.<tool>.profiles.<role|default>.<leaf>`) — consult the
  `clis.<tool>…` key first and fall back to `providers.<tool>…`. During N1's window fab may emit both;
  new wins. A cell's `Source` stays the **actual** key the value came from (so the UI shows the real
  config path, e.g. `clis.codex.profiles.review.model` or `providers.codex.profiles.review.model`).
  `modelSuggestions` unions the model values found under both prefixes (de-duplicated).
- `buildRole`: the role's tool cell reads `agent.profiles.<role>.cli`, falling back to
  `agent.profiles.<role>.provider` (new wins when both rows are present). `derived_from` handling is
  unchanged.
- The env-shadow `systemValue` lookup in `Read` (`c.systemValue(ctx, profileKeyPrefix+rd.Name+"."+leaf)`)
  must query the key spelling that actually produced the row (for the tool leaf: `.cli` or `.provider`),
  not a hard-coded `provider`.

**Neutral write leaf + both spellings accepted.**

- `profileLeaves` / `isProfileKey` accept the tool leaf in three spellings: `tool` (what the frontend
  sends), `cli`, and `provider`. `model` / `effort` unchanged.
- `validate` maps any of the three tool spellings to the probed write spelling before building ops, so
  the argv is `fab config set agent.profiles.<role>.cli <v> --system` against a renamed fab and
  `… .provider <v> --system` against today's fab (same for `unset`). If one patch names the same
  role's tool leaf twice under different spellings (e.g. `.tool` and `.provider`), reject with a
  `ValidationError` (HTTP 400) before any exec — the mapped keys would collide.
- `isProviderKey` (rename freely, e.g. `isToolKey`) recognises all three leaf spellings plus
  `agent.session` / `agent.workers`; the value must be one of the dual-read tool names. Message text
  moves to the new word: `unknown CLI %q (available: …)`.
- `agent.session` / `agent.workers` keys are unchanged by N1 and need no mapping.

**Document JSON (hexokit-internal API).** Rename the provider-flavoured fields to the neutral word so
the wire shape matches the neutral patch leaf (the backend and SPA ship together in one binary, so this
is not a compatibility surface):

```go
type Role struct {
    Role   string `json:"role"`
    Depth  string `json:"depth"`
    Tool   Cell   `json:"tool"`   // was Provider / "provider"
    Model  Cell   `json:"model"`
    Effort Cell   `json:"effort"`
}

type Document struct {
    // ...
    Tools []string `json:"tools,omitempty"` // was Providers / "providers"
    // ModelSuggestions / EffortCapable keep their per-tool maps
}
```

Comments and Go identifiers in the package that say "provider" for the tool should say "tool"/"CLI"
where touched (keep it to this package; rk's own `provider` naming elsewhere is out of scope).

### 2. API — `app/backend/api/fab_config.go`

Only doc comments change: the GET comment's payload sketch (`"providers"` → `"tools"`) and the POST
example should show the neutral leaf, e.g.
`POST /api/fab-config ← {"agent.workers": "codex", "agent.profiles.review.tool": "codex", "agent.profiles.review.model": null}`.

### 3. Frontend — `app/frontend/src/api/client.ts`, `app/frontend/src/components/settings-agents-panel.tsx`

- `client.ts`: `FabRole.provider` → `FabRole.tool`; `FabConfigDocument.providers` → `tools`. Doc comment
  on `inherited` says "the tool" not "the provider". Leave unrelated `agentProvider` (session/window
  types, line ~305) alone.
- `settings-agents-panel.tsx`:
  - `profileKey(role, leaf)` leaf type becomes `"tool" | "model" | "effort"`; every tool write
    (`toolChangePatch`, the row reset) sends `agent.profiles.<role>.tool`.
  - All `role.provider` reads → `role.tool`; `doc.providers` → `doc.tools`; `RoleRow`'s `providers`
    prop → `tools`.
  - **Relabels** (user-visible):
    - Role-table column header `Provider` → `CLI`.
    - Role tool select accessible label `${role} provider` → `${role} CLI` (e.g. "doing CLI").
    - Env warning: aria-label `provider set by an environment variable` → `CLI set by an environment variable`;
      title `… sets this provider — …` → `… sets this CLI — …`.
    - Knobs (`ChipRow` labels): `Session agent` → `Session CLI`, `Worker agent` → `Worker CLI`
      (sublabels unchanged: "What you talk to: fab agent, operator, batch", "What pipeline stages dispatch to").
    - Section aria-label `Agent providers` → `Agent CLIs`.
    - Footer `The providers table and other list/map keys can't be set from the CLI.` → name the table
      by its config keys so it is right on either fab, e.g. `The CLI table (providers: / clis:) and other list/map keys can't be set from the command line.`
      (avoid "set from the CLI" next to the new "CLI" noun).
  - The `INHERIT_FALLBACK` ("tool default") and `NO_EFFORT_TITLE` ("this tool takes no effort setting")
    wording already says "tool"; keep.

### 4. Tests

- **Backend** (`app/backend/internal/fabsysconfig/fabsysconfig_test.go`): the `fakeFab` runner is "the
  stub" the brief means. Add an old-spelling fixture (today's `baseRows()`) and a new-spelling fixture
  (same rows with `providers.` → `clis.` and `agent.profiles.<role>.provider` → `.cli`), and for **each**:
  - `Read` returns the same `Tools`, role tool cells (effective / inherited / override / source),
    model suggestions, `EffortCapable`, and agy `doing` inherit (`gemini-3.1-pro-high` from
    `<table>.agy.profiles.default.model`).
  - `Apply({"agent.profiles.review.tool": "codex"})` runs `config set agent.profiles.review.provider codex --system`
    on the old fixture and `config set agent.profiles.review.cli codex --system` on the new one; same for
    `null` → `unset`.
  - Patches using the literal `.provider` or `.cli` leaf are accepted and mapped to the probed spelling.
  - A mixed fixture (both `providers.*` and `clis.*` rows, and both `.provider` and `.cli` role rows with
    different values) proves new-wins and de-duplicated tool names.
  - The explain-only probe signal (no `clis.` show row, explain lists `clis`) selects the new spelling.
  - Duplicate tool leaf in one patch (`.tool` + `.provider` for the same role) → `ValidationError`, no exec.
  - Env-shadowed tool cell queries `config show agent.profiles.<role>.cli --origin --json` on the new
    fixture (`.provider` on the old).
  - Existing tests are updated for the renamed JSON fields / leaf (`Role.Tool`, `Document.Tools`).
- **Frontend unit** (`app/frontend/src/components/settings-agents-panel.test.tsx`, ~53 `provider`
  mentions): fixtures move to `tool` / `tools`; assert writes send `agent.profiles.<role>.tool`;
  assert the new labels ("CLI" column, "doing CLI" select, "Session CLI" / "Worker CLI" knobs).
- **e2e** (`app/frontend/tests/e2e/_fab-config-stub.ts`, `settings-agents.spec.ts`): the browser stub
  serves hexokit's document (post-backend), so it moves to the neutral shape (`tools`, `role.tool`,
  patch keys `agent.profiles.<role>.tool`); spec selectors move to the new labels (`getByLabel("review CLI")`,
  region "Agent CLIs") and expected POST bodies to the `.tool` leaf. Keep each `test()`'s JSDoc
  Proves/Steps block accurate (Constitution § Test Intent Comments).
- **Demos** that select by the old label or seed old keys move with the rename:
  `tests/demo/agents-model-list.demo.ts`, `tests/demo/agents-effort-capability.demo.ts`,
  `tests/demo/agents-settings-provenance.demo.ts` (seeded `agent.profiles.*.provider` keys → `.tool`,
  `getByLabel("doing provider")` → `"doing CLI"`).
- Run through `just test-backend`, `just test-frontend`, `just test-e2e` (never direct `go test` / `pnpm test`).

### 5. PR evidence

The relabel is visible in the web UI, so per Constitution § PR Evidence the PR needs **Before/After**
screenshots of Settings → Agents (desktop and mobile) via the `just` rig — e.g. an
`agents-cli-label` demo or screenshots showing the "Provider" column / "Session agent" knob before and
the "CLI" column / "Session CLI" knob after. The dual-spelling backend behaviour is not observable
against the browser stub; the PR body states it is covered by the Go tests against both fixtures (fab
with the new spelling is not released yet, so no live new-spelling fab can be exercised).

## Affected Memory

- `run-kit/configuration`: (modify) fab system-config wrapper — key set gains the `tool`/`cli`/`provider` leaf mapping, the spelling probe, dual-read of `providers.`/`clis.` and `.provider`/`.cli` (new wins), document fields `tools` / `role.tool`, effort-capability and inheritance lookups across both table prefixes
- `run-kit/api-and-sockets`: (modify) `/api/fab-config` GET payload (`tools`, `roles[].tool`) and POST body (neutral `agent.profiles.<role>.tool` leaf, old/new leaf spellings accepted and mapped)
- `run-kit/ui/dialogs-and-state`: (modify) Agents tab labels — "CLI" column, "Session CLI" / "Worker CLI" knobs, env warning and footer wording; tool-change patch sends the `tool` leaf
- `run-kit/architecture/backend-packages`: (modify) `internal/fabsysconfig` row — dual-spelling read and probed write spelling

## Impact

- **Backend**: `app/backend/internal/fabsysconfig/fabsysconfig.go` (+ `_test.go`); doc comments in
  `app/backend/api/fab_config.go`. No new subprocess calls (the probe reuses `show` / `explain` output
  already fetched); all execs stay argv-slice `exec.CommandContext` with `FabTimeout` (Constitution I).
- **Frontend**: `app/frontend/src/api/client.ts` (types), `app/frontend/src/components/settings-agents-panel.tsx`
  (+ `.test.tsx`), `app/frontend/tests/e2e/_fab-config-stub.ts`, `app/frontend/tests/e2e/settings-agents.spec.ts`,
  the three `tests/demo/agents-*.demo.ts` files.
- **Cross-repo**: fab-kit N1 must not release before this is released (plan rule 5). No dependency on
  any fab release for this change itself — it must work against today's fab 2.30.0 unchanged.
- **Not touched**: rk's own provider naming (`cmd/rk/agent_registry.go`, `internal/riff`, `@rk_*`
  agent options, `agentProvider` fields); `riff.ResolveAgent` reads only `command` / `skill_prefix`
  from `fab agent -o yaml`, so the `fab agent` output rename does not reach it.

## Open Questions

- When fab is post-N1 but the user's `~/.fab-kit/config.yaml` still holds the old `agent.profiles.<role>.provider`
  key (N1's migration not yet run), does `fab config unset agent.profiles.<role>.cli --system` also
  remove the old-spelled key? That is N1's contract to define; H5 writes only the probed spelling and
  relies on fab's resolver and migration. Flag in the PR if Go tests can't model it.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is the H5 Brief only: dual-read, probed write spelling, neutral `tool` patch leaf, "CLI" relabel, tests against both spellings | User: "implement only the H5 Brief"; plan Decisions bind | S:95 R:90 A:95 D:95 |
| 2 | Certain | New spelling is `clis:` table and `agent.profiles.<role>.cli` leaf; UI label "CLI"; knobs "Session CLI" / "Worker CLI" | Plan Decision "Rename provider → cli" and N1 Brief ("decided: `cli` (user, 2026-11-16)") | S:95 R:85 A:95 D:95 |
| 3 | Certain | rk's own "provider" naming (agent registry, riff, `agentProvider`, `@rk_*` options) is untouched | N1 Brief non-goals: "rk's own provider naming … out of scope; hexokit relabels only the fab-facing Agents tab (H5)" | S:90 R:85 A:90 D:90 |
| 4 | Confident | Probe derives from the already-loaded `show` rows (any `clis.` key or `agent.profiles.<role>.cli` key) plus `explain` keys when `Read` has them; default is the old spelling; no extra fab call, no cross-request cache | Brief offers both signals; reusing fetched output avoids a new subprocess; per-request Client + Constitution II (external writers win) rule out a process cache; today's fab must keep working | S:80 R:85 A:80 D:75 |
| 5 | Confident | On reads, new spelling wins over old when both are present (role leaf and table lookups); tool names are the de-duplicated union; `Source` reports the actual key found | Mirrors N1's resolver rule "reads either spelling per field, new wins"; Source must point at a real config path | S:80 R:85 A:85 D:80 |
| 6 | Confident | Backend accepts `tool`, `cli` and `provider` leaves in patches, maps all to the probed spelling; two spellings for the same role in one patch is a 400 | Brief: "accept both spellings … frontend sends neutral `tool` … backend maps it"; collision rejection keeps validate-before-exec | S:75 R:85 A:80 D:75 |
| 7 | Tentative | hexokit document JSON renames `providers` → `tools` and `roles[].provider` → `roles[].tool` (Go `Document.Tools`, `Role.Tool`) | Matches the neutral patch leaf and H1's existing `tool` vocabulary; backend and SPA ship in one binary so it is not a compat surface; brief doesn't name the document fields — `clis`/`cli` was the alternative | S:55 R:80 A:65 D:55 |
| 8 | Confident | Also relabel env-warning text, section aria-label ("Agent CLIs"), select labels ("<role> CLI"), footer and the `unknown CLI` validation message | "Relabel the column and chips" plus the plan's goal of removing the word from the fab-facing tab; partial relabel would leave mixed vocabulary | S:70 R:90 A:75 D:70 |
| 9 | Confident | PR needs Before/After screenshots of the relabelled tab (desktop + mobile); dual-spelling backend proof is Go tests only, stated in the PR body | Constitution § PR Evidence covers visible label changes; no post-N1 fab exists to exercise live | S:80 R:85 A:85 D:80 |
| 10 | Tentative | Clearing an old-spelled role key under a post-N1 fab (pre-migration) is left to fab's `unset`/migration contract; H5 writes only the probed key | N1 owns old-key handling and the file migration; hexokit never edits the file itself (Constitution IV/III) | S:55 R:75 A:65 D:60 |

10 assumptions (3 certain, 5 confident, 2 tentative, 0 unresolved).
