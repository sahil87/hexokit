# Intake: Model Suggestions and Per-Model Efforts from `fab agent models`

**Change**: 261120-hnzf-model-suggestions-from-fab-agent-models
**Created**: 2026-11-20

## Origin

> Execute step H4 (Suggestions and per-model efforts from fab agent models) of the plan at /home/sahil/code/sahil87/fab-kit/fab/plans/sahil/26-11-16-model-pins.md. Read the whole plan first (Decisions and Rules bind you), then implement only the H4 Brief.

One-shot `/fab-new` from the operator executing the cross-repo "Agent models" plan (`26-11-16-model-pins.md`, fab-kit checkout). H4 is one step of the hexokit ladder H1 → H2 → H5 → **H4** → H3. H1 (`0779013d`, inherit-first model cell), H2 (`56b67efb`, inherit label + effort capability) and H5 (`29400261`, `providers`/`clis` spelling compat) are merged on `main` and present on this branch. H4's cross-repo dependency — fab-kit D1 (`fab agent models`) **released** — is met: the installed fab is **2.30.1** and ships the verb (it also already ships F2's reserved `tool-default` row, which is H3's business, not H4's). The plan's H4 Brief, verbatim:

> - `fabsysconfig.go`: fill `ModelSuggestions` from `fab agent models --json` (one call per `Read`,
>   bounded by `FabTimeout`), falling back to today's fill scan when the verb is missing (older fab).
>   Carry `label`, `efforts` and `default` per model; surface fab's warning lines in `Warnings`.
> - Frontend: the model list shows labels (e.g. "GLM 5.3 (Latest)") with the id as secondary text,
>   marks the tool's default, and turns searchable above ~30 entries (kimi). The stale-pin note now
>   means "the tool doesn't offer it", not "the kit doesn't ship it".
> - Effort select: offer the selected model's `efforts` when known (codex adds `ultra` for some
>   models), else the tool's set; keep H2's disabled state for tools without `{effort}`.
> - Non-goals: hexokit reading any tool's config itself.

Binding plan Decisions that touch this step:

- **Ask the tool for its models** — fab owns discovery (`fab agent models`); **hexokit only calls fab, never reads tool configs itself** (no `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.kimi-code/config.toml` reads in hexokit).
- **Discovery fails open** — any discovery error or timeout returns the kit's fills plus a warning; it must never block the settings page.
- **Pins remain possible** — picking a concrete model or typing a custom one still writes a pin; the UI flags a pin the tool no longer offers.
- **Tool change resets model and effort**, keeping a value only if the new tool offers it.
- **hexokit reads, never re-derives, where it can** — take fab's rows (order, labels, efforts, default flag) as given.
- **Inherit is the default** — the model list's first option stays `↳ inherit (<inherited>)`.

## Why

**The suggestion list is the kit's guess, not the tool's truth** (plan problem #3). Today `modelSuggestions` (`app/backend/internal/fabsysconfig/fabsysconfig.go:483`) collects only `clis|providers.<tool>.profiles.*.model` fill values from `fab config show`, so the Agents tab's model list is at most the kit's fills:

- It lags the tools — codex's own default is already `gpt-6.1-sol`, the kit's fill is `gpt-5.6-sol`.
- It never shows models the user added: custom Claude Code picker models (`glm-latest[1m]`, `kimi-latest[1m]`, `auto[1m]` …), kimi's hundreds of `[models."<alias>"]` aliases.
- Consequently the H1 stale-pin note fires on any custom model the user deliberately picked (it means "the kit doesn't ship it"), and never on what actually matters — a pin the **tool** no longer offers.

**The effort select offers one fixed set.** It always lists `low…max` (`EffortSuggestions`), but efforts are per model: codex reports `supported_reasoning_levels` per model (some add `ultra`), kimi's `Kimi K3.1 Pro` takes `low/high/max`. Without per-model efforts, the UI offers values the model rejects and hides `ultra` where it exists.

fab-kit D1 solved discovery once for every consumer: `fab agent models --json` asks each tool (codex `debug models`, claude aliases + `modelPicker.options`, kimi config) with fail-open adapters. H4 makes the Agents tab consume it instead of re-deriving from fills. If we don't: the settings UI keeps steering users toward stale kit fills and keeps flagging their deliberate custom models as wrong — the opposite of the plan's goal (stop config breaking on every model release).

**Why this approach**: one `fab agent models --json` call per `Read` (rather than per tool or per role) — it returns every tool in one process; fab already applies short per-adapter timeouts (codex: 3s) and fails open, so hexokit only needs the outer `FabTimeout` bound plus a fill-scan fallback for older fab. Reading tool configs directly in hexokit is an explicit non-goal (it would duplicate fab's adapters and drift).

## What Changes

### 1. `fab agent models --json` — the contract consumed (verified against fab 2.30.1)

`fab agent models --json` prints a JSON array to stdout, one row per (tool, model); warning lines go to stderr (exit 0). Captured on this machine:

```
stderr: warning: codex: codex debug models: timed out after 3s
stdout: [
  {"cli":"agy","id":"tool-default","label":"tool default","efforts":[],"default":false,"source":"reserved"},
  {"cli":"agy","id":"gemini-3.1-pro-high","label":"gemini-3.1-pro-high","efforts":[],"default":false,"source":"fill"},
  {"cli":"claude","id":"tool-default","label":"tool default (claude-fable-5-1[1m])","efforts":["low","medium","high","xhigh","max"],"default":false,"source":"reserved"},
  {"cli":"claude","id":"opus","label":"opus","efforts":["low","medium","high","xhigh","max"],"default":false,"source":"alias"},
  {"cli":"claude","id":"glm-latest[1m]","label":"GLM 5.3 (Latest)","efforts":["low","medium","high","xhigh","max"],"default":false,"source":"tool"},
  {"cli":"claude","id":"claude-fable-5-1[1m]","label":"claude-fable-5-1[1m]","efforts":[...],"default":true,"source":"tool"},
  {"cli":"codex","id":"gpt-5.6-sol","label":"gpt-5.6-sol","efforts":[],"default":false,"source":"fill"},
  {"cli":"codex","id":"gpt-6.1-sol","label":"gpt-6.1-sol","efforts":[],"default":true,"source":"tool"},
  {"cli":"kimi","id":"openrouter/moonshotai/kimi-k3.1-pro","label":"Kimi K3.1 Pro","efforts":["low","high","max"],"default":true,"source":"tool"},
  ...
]
```

Counts on this machine: kimi 367 `tool` rows; claude 4 `alias` + 11 `tool`; codex 3 `fill` + 1 `tool` (discovery timed out); agy 2 `fill`; each tool also has one `reserved` row.

Rules for consuming it:

- **Row key spelling**: the tool field is `cli` in 2.30.1; a fab that has D1 but predates the N1 rename spells it `provider`. Accept both, `cli` wins (same newest-first rule as H5's `toolLeafSpellings`).
- **Exclude `source: "reserved"` rows** (the F2 `tool-default` token). Offering the token is H3's step ("`↳ tool default (<discovered default>)` as the second option"); H4 must not leak it as a plain suggestion.
- **Keep fab's order** per tool (fab already orders aliases/fills/tool rows); de-duplicate by `id` within a tool, first occurrence wins.
- Only tools in `doc.Tools` get a `modelSuggestions` entry; every `doc.Tools` entry gets one (possibly `[]`). Rows for a tool not in `doc.Tools` are ignored.

### 2. Backend — `app/backend/internal/fabsysconfig/fabsysconfig.go`

**New suggestion shape.** `Document.ModelSuggestions` changes from `map[string][]string` to `map[string][]ModelSuggestion` (JSON key `modelSuggestions` unchanged):

```go
// ModelSuggestion is one model a tool offers, as `fab agent models` reports it.
type ModelSuggestion struct {
	ID      string   `json:"id"`
	Label   string   `json:"label,omitempty"`   // omitted when equal to ID
	Efforts []string `json:"efforts,omitempty"` // per model when known, else the tool's set, else empty
	Default bool     `json:"default,omitempty"` // the tool's own default model
}
```

**Discovery in `Read`.** One `fab agent models --json` call per `Read`, through the same `Runner` (so it is bounded by `FabTimeout` via `execRunner`, runs with `Dir=$HOME`, and is fakeable in tests). Call `c.run` directly (not `c.fab`) so stderr is kept on success: its `warningLines(stderr)` go into `doc.Warnings`. The call runs **concurrently** with the `fab config show` / `fab config explain` calls (a goroutine joined before suggestions are built), so the GET's latency is the max of discovery and the config reads rather than their sum (codex discovery alone can take its 3s timeout). Any test fake runner that records calls must therefore be safe for concurrent use.

**Fallback.** When `fab agent models --json` fails for any reason — non-zero exit (an older fab without the verb treats `models` as an unknown role), `FabTimeout`, or stdout that does not decode as the row array — `Read` falls back to today's fill scan (`modelSuggestions(rows, tool)`, now returning `[]ModelSuggestion{{ID: v}}` with no label/efforts/default). The fallback is **silent** (no warning): an older fab is the expected cause and a warning on every visit would be noise; fab itself already fails open per adapter with its own warnings.

**Warnings on GET and POST.** `doc.Warnings` now carries discovery warnings on every `Read`. `Apply` currently overwrites `doc.Warnings` with the write warnings — change it to keep both: the write's warning lines first, then the re-read's discovery warnings.

**Unchanged**: `EffortSuggestions` (the global `low…max` list, still the last fallback), `EffortCapable` (H2), the write path and validation (effort/model values are already free text ≤128 chars, so `ultra` and any discovered id are accepted).

Package doc comment: add `fab agent models --json` to the "Reads decode" list, noting the fill-scan fallback for older fab.

### 3. API types — `app/frontend/src/api/client.ts`

```ts
export type FabModelSuggestion = {
  id: string;
  /** Display name; absent when it equals the id. */
  label?: string;
  /** Efforts this model takes; absent when unknown. */
  efforts?: string[];
  /** The tool's own default model. */
  default?: boolean;
};
// FabConfigDocument (installed):
modelSuggestions: Record<string, FabModelSuggestion[]>;
/** fab stderr warning lines — discovery warnings on every read, plus write warnings on a POST. */
warnings?: string[];
```

### 4. Frontend model cell — `app/frontend/src/components/settings-agents-panel.tsx`

`modelOptions(cell, suggestions)` keeps its fixed order and commit behaviour (inherit `""` → `null`; suggestion → its id; `(not offered)` stale override; `Custom…` NUL sentinel) but takes `FabModelSuggestion[]`. Each suggestion option carries `id`, `label` (fallback: id), and `isDefault`.

- **Label + secondary id.** When `label !== id`, the label is primary and the id is secondary text. In the native `<select>` (which cannot style option sub-text) the option text is `` `${label} · ${id}` ``; in the searchable list, the label is the main line and the id renders smaller/dimmed beside or under it. When `label === id`, show the id once.
- **Default marker.** The tool's default model (`default: true`) is marked with the suffix ` · tool default` (same "tool default" vocabulary as the existing `↳ tool default` inherit fallback and H3's upcoming `↳ tool default (<id>)` option).
- **Searchable above 30.** A constant `SEARCHABLE_MODEL_THRESHOLD = 30`: when the row's suggestion count exceeds it (kimi: 367), the cell renders a searchable list instead of the native `<select>`. Requirements for the searchable list:
  - It **opens unfiltered** every time, whatever the saved value (the H1 regression: the filter text starts empty, never pre-filled with the saved override).
  - It renders the same `modelOptions` array in the same order; the filter matches label **or** id (case-insensitive substring); `↳ inherit` and `Custom…` stay visible regardless of the filter.
  - Keyboard: typing filters, ArrowUp/ArrowDown move, Enter commits, Escape closes the list without committing (and stops propagation so the Settings dialog stays open — same rule as `CustomModelInput`).
  - The closed control shows the current value (label of the override, or the dimmed `↳ inherit (<inherited>)`), keeps `aria-label="<role> model"`, and is disabled while the row is busy.
  - Picking `Custom…` swaps to `CustomModelInput` exactly as today.
  - Reuse an existing searchable-list/combobox pattern in `app/frontend/src/components/` if one fits (candidates seen: `folder-path-input.tsx`, `gui-wm-picker`, `command-palette.tsx`); otherwise a small local component.
- **Stale pin = "the tool doesn't offer it".** `isStalePin` compares the override against suggestion **ids** of the now-discovered list. The note's wording stays (H1: `pinned to <v>, which <tool> doesn't offer — inherit <inherited> instead?`; claude: `pinned to <v>, not in the list — inherit <inherited> to track the latest`); the semantics change via the data source. Update the component's doc comment accordingly. With the older-fab fallback the list is fills only, as today.

### 5. Frontend effort select

The effort options for a row, in order of preference:

1. the **selected model's** `efforts` when non-empty — the selected model is `role.model.effective` (the override, or the inherited/resolved value); when that is empty (tool default), the suggestion with `default: true`;
2. else the **tool's set** — the union of `efforts` across the row's tool's suggestions, in first-seen order;
3. else the global `doc.effortSuggestions` (`low…max`, today's list).

H2's disabled state (`effortCapable[tool] === false` → disabled, title `this tool takes no effort setting`) is unchanged, and `RoleSelect` still appends an override that is not in the list (so a stale effort stays visible and resettable). Example: a codex row whose model is a codex model reporting `["low","medium","high","xhigh","max","ultra"]` offers `ultra`; a kimi row on `Kimi K3.1 Pro` offers `low/high/max` (kimi is not effort-capable by default, so that select is disabled anyway).

### 6. Tool-change patch

`toolChangePatch` keeps a model override only when it is an **id** in the new tool's suggestions, and keeps an effort override only when it is in the **new tool's effort set** (rule 2 above, falling back to `effortSuggestions`) and the new tool is effort-capable. Shape of the patch is otherwise unchanged (one POST, neutral `tool` leaf).

### 7. Panel warnings

`SettingsAgentsPanel` currently sets `warnings` only from POST responses. It must also show the GET document's `warnings` on load (discovery warnings such as `warning: codex: codex debug models: timed out after 3s`), rendered in the existing `data-testid="fab-warnings"` block. A POST still replaces them with that response's `warnings`.

### 8. Tests

- **Go** (`fabsysconfig_test.go`): recorded `fab agent models --json` fixture → `modelSuggestions` with label/efforts/default; reserved rows excluded; `provider`-keyed rows accepted; duplicate ids de-duplicated; tools outside `doc.Tools` ignored; failing verb (non-zero exit) → fill-scan fallback with no warning; malformed JSON → fallback; stderr warning lines → `doc.Warnings`; `Apply` keeps write warnings + discovery warnings. Existing fakes must answer (or fail) the new argv without breaking current expectations.
- **API** (`app/backend/api/fab_config_test.go`): update for the new suggestion shape if it asserts on it.
- **Unit** (`settings-agents-panel.test.tsx`): label + secondary id text; default marker; label-less suggestion shows id once; searchable list above 30 (opens unfiltered with a saved override, filter by label and by id, inherit/Custom… always present, Enter commits, Escape closes); ≤30 stays a native `<select>`; effort options from the selected model, from the tool set, from the global fallback; `ultra` offered; disabled state kept; tool-change patch keeps/clears by id and by the new tool's effort set; GET warnings rendered.
- **e2e**: `tests/e2e/_fab-config-stub.ts` serves `modelSuggestions` as objects (with labels, efforts, a `default`) and a >30-entry tool; `tests/e2e/settings-agents.spec.ts` keeps H1's reload-then-open regression and adds a searchable-list case.

## Affected Memory

- `run-kit/configuration`: (modify) § fab-kit System Config — model suggestions come from `fab agent models --json` (one call per Read, concurrent, fill-scan fallback for older fab, reserved rows excluded, `cli`/`provider` row key), discovery warnings in `Warnings`; Reads list gains the verb
- `run-kit/ui/dialogs-and-state`: (modify) Agents tab — model cell labels/secondary id/default marker/searchable list above 30, stale pin now means "the tool doesn't offer it", per-model effort options, tool-change keep rules, GET warnings rendered
- `run-kit/api-and-sockets`: (modify) `/api/fab-config` GET/POST document — `modelSuggestions{<tool>: [{id, label?, efforts?, default?}]}`, `warnings` on GET too
- `run-kit/architecture/backend-packages`: (modify) `internal/fabsysconfig` row — the `fab agent models` read and `ModelSuggestion` type

## Impact

- **Backend**: `app/backend/internal/fabsysconfig/fabsysconfig.go` (+ tests); `app/backend/api/fab_config.go` untouched unless its tests assert the suggestion shape.
- **Frontend**: `app/frontend/src/api/client.ts` (types), `app/frontend/src/components/settings-agents-panel.tsx` (model cell, effort options, tool-change patch, warnings) + `.test.tsx`; possibly a new small searchable-list component.
- **e2e**: `app/frontend/tests/e2e/_fab-config-stub.ts`, `settings-agents.spec.ts`.
- **Runtime cost**: every `GET /api/fab-config` and every POST (which re-reads) now launches `fab agent models`, which itself launches `codex debug models` etc. Concurrency keeps GET latency ≈ max(discovery, config reads); fab's per-adapter 3s timeout bounds discovery well under `FabTimeout` (10s). No cache in v1 (plan D1 open decision).
- **API contract**: `modelSuggestions` element type changes from string to object. The SPA is embedded in the same binary as the daemon, so there is no cross-version client.
- **Compatibility**: works on fab without the verb (fallback), with D1 pre-N1 (`provider` row key) and post-N1 (`cli`).

## Open Questions

- Should a POST skip re-running discovery (reuse the client's previous suggestions) to keep model/effort picks snappy when a tool's discovery is slow? v1 re-reads fully, matching the tab's no-cache freshness rule.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | H4's dependencies are met: D1 is released (fab 2.30.1 has `fab agent models --json`) and H5 is merged on main | Verified by running the verb and reading git log on this branch | S:95 R:90 A:95 D:95 |
| 2 | Certain | hexokit never reads any tool's config itself; all discovery is via `fab agent models` | Plan binding Decision + H4 non-goal | S:100 R:85 A:100 D:100 |
| 3 | Confident | Exclude `source: "reserved"` (`tool-default`) rows from suggestions | F2 already shipped the row, but offering it is H3's step; leaking it as a plain suggestion would ship H3 half-done | S:70 R:85 A:80 D:75 |
| 4 | Certain | Accept both `cli` and `provider` as the row's tool key, `cli` wins | Plan: D1 uses today's `provider` spelling and N1 renames output; mirrors H5's newest-first spelling rule | S:75 R:90 A:85 D:85 |
| 5 | Confident | `ModelSuggestions` becomes `map[string][]ModelSuggestion` `{id, label?, efforts?, default?}` under the same JSON key | Brief says carry label/efforts/default per model; SPA and daemon ship in one binary, so changing the element type is safe | S:75 R:80 A:80 D:70 |
| 6 | Confident | Fall back to the fill scan on any failure of the verb (non-zero exit, timeout, bad JSON), silently | Brief: fall back when the verb is missing; distinguishing "missing" by stderr text is fragile; fab already warns per adapter, so a hexokit warning would be noise on older fab | S:65 R:85 A:75 D:65 |
| 7 | Confident | Run discovery concurrently with the `fab config show`/`explain` reads | Codex discovery can take its full 3s; summing it onto the GET is avoidable; brief only requires one call per Read bounded by FabTimeout | S:55 R:85 A:75 D:70 |
| 8 | Certain | Keep fab's row order per tool; de-dup by id, first wins | Decision "hexokit reads, never re-derives" — fab owns ordering | S:65 R:90 A:80 D:80 |
| 9 | Confident | Effort options: selected model's efforts → union of the tool's efforts → global `low…max`; "selected model" is the effective model, or the `default: true` row when effective is empty | Brief's order ("selected model's efforts when known, else the tool's set"); the global list keeps today's behaviour when fab reports nothing | S:70 R:85 A:75 D:65 |
| 10 | Certain | GET's discovery warnings are shown on load; Apply returns write warnings followed by discovery warnings | Brief: surface fab's warning lines in Warnings; today the panel only shows POST warnings and Apply overwrites the Read's | S:70 R:90 A:80 D:75 |
| 11 | Confident | Searchable threshold is >30 suggestions (`SEARCHABLE_MODEL_THRESHOLD = 30`) | Brief says "~30"; exact value is a UI tweak | S:60 R:95 A:60 D:55 |
| 12 | Confident | Native-select option text is `label · id`; default marked with ` · tool default` | Brief asks for label + id secondary + default mark but no wording; "tool default" matches the inherit fallback and H3's option vocabulary | S:45 R:95 A:55 D:45 |
| 13 | Confident | Tool-change patch keeps an effort only if it is in the new tool's effort set (not the global list) | Follows the "keep a value only if X offers it" Decision once per-tool efforts exist; brief does not spell it out | S:50 R:90 A:65 D:60 |
| 14 | Confident | POSTs re-run discovery (no reuse of the previous suggestions) | Matches the tab's no-cache freshness rule and plan D1's v1 "no cache"; costs latency on slow discovery (Open Question) | S:45 R:85 A:60 D:55 |

14 assumptions (5 certain, 9 confident, 0 tentative, 0 unresolved).
