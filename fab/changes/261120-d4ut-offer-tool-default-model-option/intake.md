# Intake: Offer the Tool-Default Model Value in the Agents Tab

**Change**: 261120-d4ut-offer-tool-default-model-option
**Created**: 2026-11-20

## Origin

> Execute step H3 (Offer the F2 value (tool-default) in the model list) of the plan at /home/sahil/code/sahil87/fab-kit/fab/plans/sahil/26-11-16-model-pins.md. Read the whole plan first (Decisions and Rules bind you), then implement only the H3 Brief.

One-shot `/fab-new` from the operator executing the cross-repo "Agent models" plan (`26-11-16-model-pins.md`, fab-kit checkout). H3 is the **last** step of the hexokit ladder H1 → H2 → H5 → H4 → **H3**. H1 (inherit-first model cell), H2 (inherit label + effort capability) and H5 (`providers`/`clis` spelling compat) are merged on `main`; H4 (`261120-hnzf-model-suggestions-from-fab-agent-models` — suggestions/efforts from `fab agent models --json`) is present on this branch via commit `49569c7b` ("operator: cherry-pick mp-h4 dependency"). H3's cross-repo dependency — fab-kit **F2 released** — is met: fab-kit `cb848535 feat: Reserved tool-default model value (#708)` shipped in **v2.30.1**, which is the installed fab (`fab --version` → 2.30.1).

The plan's H3 Brief, verbatim:

> After F2 is **released**: add `↳ tool default (<discovered default>)` as the second option of the
> model list, committing the F2 token. Take the token and label from `fab agent models --json`.
> Display a row holding the token as "tool default", not the raw string.

F2's token (decided at F2's user gate) is **`tool-default`**. Per fab's `_cli-fab.md` § fab agent models: *"Every provider's first row is the reserved `{id: "tool-default", source: "reserved", default: false}` row. Its label is `tool default (<default-id>)` when discovery identifies a default, otherwise plain `tool default`; its efforts come from that default row when non-empty, else Claude's known set for Claude, else `[]`. The real default row keeps `default: true`. A discovered row whose ID is literally `tool-default` is dropped."* Resolution: `tool-default` participates in precedence as an ordinary non-empty value (wins over lower tiers), then collapses to an empty model (`{model}` token and its flag dropped; native rung omits the Agent-tool `model` param). `fab config set agent.profiles.<role>.model tool-default` is accepted (unlike `""`).

Reserved rows captured on this machine (`fab agent models --json`, fab 2.30.1):

```json
{"cli":"agy","id":"tool-default","label":"tool default","efforts":[],"default":false,"source":"reserved"}
{"cli":"claude","id":"tool-default","label":"tool default (claude-fable-5-1[1m])","efforts":["low","medium","high","xhigh","max"],"default":false,"source":"reserved"}
{"cli":"codex","id":"tool-default","label":"tool default (gpt-6.1-sol)","efforts":["low","medium","high","xhigh","max","ultra"],"default":false,"source":"reserved"}
{"cli":"kimi","id":"tool-default","label":"tool default (openrouter/moonshotai/kimi-k3.1-pro)","efforts":["low","high","max"],"default":false,"source":"reserved"}
```

Binding plan Decisions that touch this step:

- **Inherit is the default** — the model list's first option stays `↳ inherit (<inherited>)` (commits `null`). Tool default is the **second** option.
- **Ask the tool for its models / hexokit reads, never re-derives** — the token and its label come from fab's reserved row; hexokit never hard-codes `tool-default` as a magic string for behaviour.
- **Pins remain possible** — concrete suggestions and `Custom…` keep writing pins.
- **Tool change resets model and effort, keeping a value only if the new tool offers it** — every tool that has a reserved row "offers" the token.
- **Discovery fails open** — when fab reports no reserved row (older fab, or `fab agent models` failed and H4's fill-scan fallback ran), the option is simply absent; nothing breaks.

## Why

Plan problem #5: **there is no way to say "use the tool's own default"** for a tool that only takes concrete slugs (codex, agy). Inherit gives the kit's per-role fill (e.g. codex review → `gpt-5.6-sol`), which still lags the tool (codex's own default is already `gpt-6.1-sol`). `fab config set … ""` is refused. F2 added the reserved `tool-default` value in fab; without H3, HexoKit's Agents tab — the place users actually edit role models — cannot set it except via `Custom…` free text (which the user would have to know the spelling of), and a row holding it would render as a raw `tool-default` pin flagged **stale** by H4's note ("pinned to `tool-default`, which codex doesn't offer — inherit … instead?") because H4 deliberately excludes reserved rows from suggestions. That steers users *away* from the very value meant to stop config breaking on model releases.

**Why this approach**: fab already returns the reserved row per tool in the same `fab agent models --json` call H4 makes, with a ready-made label naming the discovered default and the default's efforts. Carrying that row through the existing `Read` costs no extra exec, keeps fab as the single owner of the token spelling and label (Decision "hexokit reads, never re-derives"), and degrades to "no option" automatically on fab versions without F2. Alternatives rejected: hard-coding `tool-default` in the frontend (drifts if fab ever renames it, and would offer a value an older fab passes verbatim as `--model tool-default`); folding the reserved row into `modelSuggestions` (it would count toward the searchable threshold, appear among concrete models, get the "tool default" default-marker logic confused, and be treated as a pin by stale/keep checks).

## What Changes

### 1. Backend — `app/backend/internal/fabsysconfig/fabsysconfig.go`

**New `Document` field** carrying each tool's reserved row:

```go
// ToolDefaults is each tool's reserved "use the tool's own default" model
// value, as `fab agent models` reports it (source "reserved"): ID is the
// token to write, Label names the discovered default, Efforts are the
// default model's. A tool fab reports no reserved row for has no entry.
ToolDefaults map[string]ModelSuggestion `json:"toolDefaults,omitempty"`
```

- Filled in `Read` only when discovery succeeded (`found.ok`), from the same `found.rows` H4 already decodes — no new exec. On H4's silent fill-scan fallback, `ToolDefaults` stays nil (field omitted).
- Rule: for each row with `Source == sourceReserved` (`"reserved"`), non-empty `ID`, and `tool()` in `doc.Tools`, the **first** such row per tool wins. Build the `ModelSuggestion` with the same conversion `discoveredSuggestions` uses (efforts only when non-empty; `Label` omitted when equal to `ID`; `Default` copied — always false for reserved rows). Rows for tools outside `doc.Tools` are ignored.
- Implementation shape: either a sibling helper `discoveredToolDefaults(rows []modelRow, tools []string) map[string]ModelSuggestion` or extend `discoveredSuggestions` to return both maps; factor the row → `ModelSuggestion` conversion into one small helper so both paths share it. Suggestions continue to **exclude** reserved rows (H4 rule unchanged), and the searchable threshold still counts suggestions only.
- `Apply` returns the re-read document, so `ToolDefaults` is present on POST responses too (no extra work).
- Write path / validation unchanged: the model leaf is free text ≤128 chars, so `tool-default` is accepted and passed to `fab config set`, which accepts it on fab ≥ 2.30.1.
- Update the package doc comment / `Document` comment where H4 describes the `fab agent models` read to mention reserved rows now feed `ToolDefaults`.

### 2. API types — `app/frontend/src/api/client.ts`

Add to the installed `FabConfigDocument`:

```ts
/** Per tool, the reserved "use the tool's own default" model value from
 *  `fab agent models` — `id` is the token to write, `label` names the
 *  discovered default. Absent for a tool (or entirely) on a fab without it. */
toolDefaults?: Record<string, FabModelSuggestion>;
```

### 3. Frontend model list — `app/frontend/src/components/settings-agents-panel.tsx`

**New option kind.** `ModelOption` gains `{ kind: "toolDefault"; value: string; label: string }`. `modelOptions(cell, suggestions, toolDefault?)` takes the row's tool's `toolDefault` (`doc.toolDefaults?.[role.tool.effective]`, threaded `RoleTable` → `RoleRow` → `RoleModelCell` alongside `modelSuggestions`). Fixed order becomes:

1. `↳ inherit (<inherited>)` → commits `null` (unchanged);
2. **`↳ <fab label>`** — e.g. `↳ tool default (gpt-6.1-sol)`, or `↳ tool default` when fab found no default — value = `toolDefault.id` (the token), commits that string as a normal pick. Present only when `toolDefault` exists. Label text: `` `↳ ${toolDefault.label || toolDefault.id}` `` (fab's label always differs from the id, so in practice `label` is set);
3. the tool's suggestions (unchanged);
4. the stale override `<value> (not offered)` — **not** emitted when the override equals the tool-default token;
5. `Custom…` (unchanged).

**Display a row holding the token as "tool default".** With the override = token:

- native `<select>`: `value` = token selects option 2, so the closed control reads `↳ tool default (gpt-6.1-sol)`;
- `SearchableModelList` (>30 suggestions, kimi): the closed trigger shows option 2's label via `optionName` (which must return `label` for the new kind);
- `isStalePin` returns false when the override equals the row's tool-default token → no `StaleModelNote`;
- anywhere the cell's **inherited/effective** value is rendered as text and equals the token (a lower tier holding `tool-default`, e.g. `providers.codex.profiles.review.model: tool-default` set by hand), render it as `tool default` instead of the raw token — i.e. `inheritedValue` (used by `↳ inherit (…)`, `inheritedLabel`, the `CustomModelInput` placeholder, and `StaleModelNote`'s `inherit <code>…</code>` action) maps token → the existing `INHERIT_FALLBACK` text `"tool default"` (same words the UI already uses for an empty effective value — both mean the tool's own default applies). This needs the row's token, so `inheritedValue` (or a wrapper) takes the tool-default id as an optional argument.

When the row's tool has **no** `toolDefault` (older fab / discovery fallback), the token is not recognised: a `tool-default` override shows as a plain stale value exactly as H4 does today. That is correct-by-design (an older fab would pass `--model tool-default` verbatim), and requires no special-casing.

**Searchable list.** The tool-default option, like inherit and `Custom…`, is a non-model commit path: `matchesModelFilter` keeps it visible regardless of the filter, and `changeQuery`'s "land on the first match" logic continues to skip it (it already only lands on `suggestion`/`stale` kinds — keep it that way). Keyboard/Escape/opens-unfiltered behaviour unchanged.

### 4. Effort options

`modelEfforts(role, suggestions, fallback, toolDefault?)`: when the row's effective model is **empty or equals the tool-default token**, the model whose efforts apply is the tool's default — prefer `toolDefault.efforts` when non-empty (fab already derived them from the default row), else the `default: true` suggestion's efforts (H4's existing rule for empty), then fall through to H4's tool set → global list. Concrete effective models are unchanged. H2's disabled state for tools without `{effort}` is unchanged.

Example: codex review row set to tool default → effort select offers `low…max, ultra` (from the reserved row), matching what `gpt-6.1-sol` takes.

### 5. Tool-change patch

`toolChangePatch(…)` gains the tool-default map (or the next tool's entry): a model override equal to the **next** tool's `toolDefaults[nextTool].id` is **kept** (the new tool offers the token — it means "that tool's own default" for any tool); otherwise H4's rule (kept only if it is a suggestion id for the next tool). If the next tool has no `toolDefault`, a token override is cleared like any unoffered model. When the model resolves via the token, the effort-keep rule may use the next tool's `toolDefault.efforts` as part of its effort set (union with the tool set is fine; must still require `takesEffort`).

### 6. Tests

- **Go** (`fabsysconfig_test.go`): extend H4's recorded `fab agent models --json` fixture (it already contains reserved rows) to assert `ToolDefaults` — per-tool `{ID:"tool-default", Label:"tool default (gpt-6.1-sol)", Efforts:[…]}`, label-only `tool default` for a tool with no discovered default (agy), first reserved row per tool wins, tools outside `doc.Tools` ignored, reserved rows still absent from `ModelSuggestions`; failing verb / malformed JSON → `ToolDefaults` nil; JSON encoding omits the field when nil.
- **Unit** (`settings-agents-panel.test.tsx`): option 2 is `↳ tool default (<id>)` and picking it POSTs `{"agent.profiles.<role>.model":"tool-default"}`; absent `toolDefaults` → no option (order inherit, suggestions…, Custom…); override = token selects it, shows no `(not offered)` option and no stale note; inherited token renders `↳ inherit (tool default)`; searchable list (>30) keeps the option visible under a non-matching filter and the closed trigger shows its label; effort options for a token/empty row come from `toolDefaults[tool].efforts`; tool-change keeps a token override when the next tool has a `toolDefault` and clears it when it doesn't.
- **e2e**: `tests/e2e/_fab-config-stub.ts` serves `toolDefaults` (with a label naming a default) for the stubbed tools and lets a role hold `tool-default`; `tests/e2e/settings-agents.spec.ts` adds a case: open a role's model list, pick `↳ tool default (…)`, the stub records the `tool-default` write, and after reload the cell reads `↳ tool default (…)` with no stale note.

## Affected Memory

- `run-kit/configuration`: (modify) § fab-kit System Config model discovery — reserved rows feed `ToolDefaults` (first per tool, doc.Tools only, nil on fallback) while staying out of suggestions
- `run-kit/ui/dialogs-and-state`: (modify) Agents tab model cell — second option `↳ tool default (<default>)` committing fab's token; token rows display as tool default (no stale note, inherit text maps token → "tool default"); effort options and tool-change keep rule for the token
- `run-kit/api-and-sockets`: (modify) `/api/fab-config` document gains `toolDefaults{<tool>: {id, label?, efforts?}}`

## Impact

- **Backend**: `app/backend/internal/fabsysconfig/fabsysconfig.go` (+ `fabsysconfig_test.go`). No new exec, no API handler change (`app/backend/api/fab_config.go` passes the document through).
- **Frontend**: `app/frontend/src/api/client.ts` (type), `app/frontend/src/components/settings-agents-panel.tsx` (option kind, display mapping, stale exemption, effort, tool-change) + `settings-agents-panel.test.tsx`.
- **e2e**: `app/frontend/tests/e2e/_fab-config-stub.ts`, `app/frontend/tests/e2e/settings-agents.spec.ts`.
- **Compatibility**: on fab without F2 (no reserved rows) or when discovery falls back, `toolDefaults` is omitted and the UI is exactly H4's. On fab 2.30.1+ the token round-trips through `fab config set`.
- **Plan sequencing**: H3 is the final hexokit step; N1 (fab rename) does not touch the reserved row's `id`/`source` fields, and H4 already reads both `cli`/`provider` row keys.

## Open Questions

- None blocking. (Whether the H4 default marker `· tool default` on the concrete default suggestion reads as redundant next to the new `↳ tool default (<id>)` option is a cosmetic follow-up; they mean different things — pin that model vs. track whatever the tool defaults to — so both stay.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Dependencies met: F2 released (fab 2.30.1 ships `tool-default` reserved rows) and H4 is on this branch | Verified `fab --version`, fab-kit git log (`cb848535` in v2.30.1), live `fab agent models --json`, and HEAD `49569c7b` | S:95 R:90 A:95 D:95 |
| 2 | Certain | The token is `tool-default`, but hexokit takes it from the reserved row's `id`, never hard-codes it | Brief: "Take the token and label from `fab agent models --json`"; Decision "hexokit reads, never re-derives" | S:90 R:85 A:95 D:90 |
| 3 | Confident | Carry reserved rows in a new `Document.ToolDefaults map[string]ModelSuggestion` rather than inside `modelSuggestions` | Keeps suggestions = concrete models (searchable threshold, stale/keep checks, default marker unaffected); reuses the existing type; same single exec | S:65 R:85 A:80 D:65 |
| 4 | Certain | Option is second, labelled `↳ <fab label>` (e.g. `↳ tool default (gpt-6.1-sol)`), committing the token; absent when the tool has no reserved row | Brief wording verbatim; fab's label already has the `tool default (<id>)` form | S:90 R:90 A:90 D:85 |
| 5 | Confident | A token override is never stale and emits no `(not offered)` option; inherited/effective token text renders as `tool default` (existing `INHERIT_FALLBACK` wording) | Brief: "Display a row holding the token as 'tool default', not the raw string"; the empty-effective case already uses those words for the same meaning | S:70 R:90 A:80 D:70 |
| 6 | Confident | When fab reports no reserved row (older fab / discovery fallback) the token is treated as a plain value (shown stale), not special-cased | Decision "discovery fails open"; an older fab would pass `--model tool-default` verbatim, so flagging it is honest | S:55 R:90 A:75 D:65 |
| 7 | Confident | Effort options for an empty or token effective model use `toolDefaults[tool].efforts` first, then H4's default-row → tool-set → global chain | fab computes the reserved row's efforts from the default model; matches H4's "selected model's efforts" rule | S:55 R:90 A:75 D:70 |
| 8 | Confident | Tool change keeps a token override when the next tool has a reserved row, clears it otherwise | Decision "keep a value only if X offers it"; the token means "that tool's default" for any tool offering it | S:60 R:90 A:75 D:70 |
| 9 | Confident | In the searchable list the tool-default option stays visible under any filter and is not an Enter-after-typing landing target | It is a non-model commit path like inherit and `Custom…`, which H4 already treats this way | S:50 R:95 A:75 D:70 |

9 assumptions (3 certain, 6 confident, 0 tentative, 0 unresolved).
