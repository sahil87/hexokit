# Intake: Inherit Label Honours profiles.default; Effort Disabled for Tools Without {effort}

**Change**: 261117-26en-inherit-label-effort-capability
**Created**: 2026-11-17

## Origin

> Execute step H2 (Backend: inherit label honours profiles.default; effort disabled for tools without {effort}) of the plan at /home/sahil/code/sahil87/fab-kit/fab/plans/sahil/26-11-16-model-pins.md. Read the whole plan first (Decisions and Rules bind you), then implement only the H2 Brief.

One-shot `/fab-new` from the operator executing the cross-repo "Agent models" plan (`26-11-16-model-pins.md`, fab-kit checkout). H2 is one step of the hexokit ladder H1 → **H2** → H5 → H4 → H3. H1 (the inherit-first role model cell, change `261117-f83n-role-model-cell-inherit-list`) is already on this branch (`d0c2a280 operator: cherry-pick mp-h1 dependency`). The plan's H2 Brief, verbatim:

> In `fabsysconfig.go`:
>
> - `buildRole`: when `providers.<p>.profiles.<role>.<leaf>` is missing, fall back to
>   `providers.<p>.profiles.default.<leaf>` when computing `Inherited` (and `Effective` when no row
>   exists). Test with agy `doing` (expect `gemini-3.1-pro-high`) and kimi (expect empty → "tool default").
> - Add `effortCapable map[string]bool` to `Document`: true when the tool's `interactive_command`
>   or `headless_command` contains `{effort}`. The frontend disables the effort select (title "this
>   tool takes no effort setting") when false; the reset link still clears a stale effort override.
> - Non-goals: per-model effort lists (H4).

Binding plan Decisions that touch this step: **inherit is the default** (a role row with a tool and no model is the intended shape — the inherit label must therefore be truthful); **tool change resets model and effort, keeping a value only if the new tool offers it**; **hexokit reads, never re-derives, where it can** ("Re-implementation caused the agy inherit-label bug (H2)"). The plan's rename (`provider` → `cli`) is H5/N1 — H2 keeps today's `provider` spelling in keys and JSON.

## Why

**The inherit label lies for sparse-fill tools.** fab resolves a role leaf with per-field precedence: invocation flag > `agent.profiles.<role>` > `providers.<p>.profiles.<role>` > `providers.<p>.profiles.default` > empty (empty drops the `{model}` token so the tool's own default applies). hexokit's `buildRole` (`app/backend/internal/fabsysconfig/fabsysconfig.go:437-454`) re-derives only the first fill rung: `Inherited` is read from `providers.<p>.profiles.<role>.<leaf>` and stops there. agy is a sparse tool — the kit ships only `providers.agy.profiles.default.model: gemini-3.1-pro-high` and `providers.agy.profiles.fast.model: gemini-3.6-flash-low`. So for agy `doing`:

- fab resolves `model: gemini-3.1-pro-high`, `source.model: providers.agy.profiles.default` (verified in a scratch HOME with fab 2.30.0: `fab config set --system agent.profiles.doing.provider agy` then `fab agent doing -o yaml`).
- `fab config show --origin --json` emits a derived row `agent.profiles.doing.model = "gemini-3.1-pro-high"` (origin `default`, no `derived_from`), so with **no** model override `Effective` happens to be right — but `Inherited` is `""`.
- With a model override set, the inherit option reads `↳ inherit (provider default)` — telling the user that clearing the pin falls back to the tool's own default, when fab would actually run `gemini-3.1-pro-high`. The H1 stale-pin note ("inherit `<inherited>` instead?") quotes the same wrong value.

Since the plan makes inherit the default interaction, the inherit label is the one place the user learns what they'll actually get. A wrong label undermines the whole "unset the pin" story.

**The effort select offers settings the tool cannot take.** The effort select always lists `low…max` (`EffortSuggestions`), including for agy and kimi, whose `interactive_command`/`headless_command` carry no `{effort}` token. An effort written for those roles is silently dropped at substitution. The UI should say so rather than accept a no-op.

If not fixed: users pick wrong values based on a misleading label, and set efforts that do nothing.

**Approach.** Extend `buildRole`'s fallback by exactly the one rung fab has (`profiles.default`), rather than calling `fab agent <role> -o yaml` per role (rejected previously in memory — six extra execs per GET; the `fab config show` rows already carry the facts). Effort capability is derived from the same `show` rows (`providers.<p>.interactive_command` / `.headless_command`), so it costs no extra exec and tracks any tool the user adds.

## What Changes

### Backend — `app/backend/internal/fabsysconfig/fabsysconfig.go`

#### 1. `buildRole` falls back to the tool's `default` profile

Today:

```go
for _, leaf := range []string{profileLeafModel, profileLeafEffort} {
    // An unset leaf inherits the resolved provider's profile for this role.
    fallback := providersKeyPrefix + provider.Effective + providerProfileInfix + rd.Name + "." + leaf
    cell := cellFor(byKey, profileKeyPrefix+rd.Name+"."+leaf, fallback)
    cell.Inherited = valueString(byKey[fallback].Value)
    ...
}
```

After: resolve the fill key by trying `providers.<p>.profiles.<role>.<leaf>` first, then `providers.<p>.profiles.default.<leaf>`; the first key that has a row is the fallback. Use it for both:

- `cell.Inherited` (what clearing the override restores), and
- `cellFor`'s no-row path (`Effective`/`Source`/`Origin` when `fab config show` emitted no `agent.profiles.<role>.<leaf>` row at all).

When neither exists (kimi: no fills at all), `Inherited` and `Effective` stay `""`, which the UI renders as the inherit fallback label. For the `default` role itself, both candidate keys are the same key — no special case needed beyond not looking it up twice (harmless either way).

A small helper (e.g. `fillKey(byKey, provider, role, leaf) string` returning the first present key or `""`) keeps `buildRole` short; `cellFor`'s existing `fallbackKey != ""` guard already handles the empty case. Update the `Cell.Inherited` doc comment ("the resolved provider's profile fill for model/effort") to say role fill, then the tool's `default` fill.

Expected values (from the kit defaults probed with fab 2.30.0):

| Role row | Effective tool | Model `Inherited` | Effort `Inherited` |
|---|---|---|---|
| `doing` | agy | `gemini-3.1-pro-high` (from `providers.agy.profiles.default.model`) | `""` |
| `fast` | agy | `gemini-3.6-flash-low` (role fill wins over default) | `""` |
| `review` | kimi | `""` → "tool default" | `""` |
| `review` | codex | `gpt-5.6-sol` (unchanged) | `xhigh` (unchanged) |

#### 2. `Document.EffortCapable`

Add to `Document`:

```go
// EffortCapable says per provider whether its interactive or headless
// command carries {effort}; without it an effort override is never
// substituted.
EffortCapable map[string]bool `json:"effortCapable,omitempty"`
```

Populated in `Read` alongside `ModelSuggestions`, one entry per `doc.Providers` name: `true` when `providers.<p>.interactive_command` or `providers.<p>.headless_command` (from the same `show` rows) contains the literal `{effort}`. A tool with neither command is `false`. Every provider gets an explicit entry (true or false), so the frontend can distinguish "not capable" from "unknown". Name the token as a constant (e.g. `effortToken = "{effort}"`) and the two command leaves as constants per the code-quality "no magic strings" rule, matching the existing `providersKeyPrefix`/`providerProfileInfix` style.

Kit defaults today: claude `true`, codex `true` (`-c model_reasoning_effort={effort}`), agy `false`, kimi `false`. The project-level `fab/project/config.yaml` override of `providers.claude.interactive_command` also carries `{effort}` — whichever row `show` returns wins, which is the point of reading rows instead of hard-coding.

`Apply` returns the re-read document, so POST responses carry the map too.

### Frontend — `app/frontend/src/api/client.ts`

Add `effortCapable: Record<string, boolean>;` to the installed branch of `FabConfigDocument` (next to `effortSuggestions`). Treat a missing entry as capable (older daemon / unknown tool) so the select never disables on absent data.

### Frontend — `app/frontend/src/components/settings-agents-panel.tsx`

#### Effort select disabled for non-capable tools

`RoleRow` receives the capability of the row's **effective** tool (`role.provider.effective`). When false, the effort `RoleSelect` renders `disabled` with `title="this tool takes no effort setting"` (exact string from the brief). `RoleSelect` gains an optional `title` prop. The select still shows whatever the cell holds (inherit label, or a stale override value) so a stale effort is visible.

The **Reset** link is unaffected: it is driven by `overridden` (any override or env-shadowed `systemValue` on provider/model/effort) and posts `{provider: null, model: null, effort: null}`, so a stale effort override on an agy/kimi row is still clearable from the row.

#### Tool change clears an effort the new tool can't take

`toolChangePatch` (H1) keeps the effort override only when it is in `doc.effortSuggestions`. Extend the rule per the plan's "keeping a value only if X offers it": when the new tool is not effort-capable, the patch clears effort (`effort: null`) even if the value is in `effortSuggestions`. Concretely: `review` with `{provider: codex, effort: high}` switched to `agy` → one POST `{"agent.profiles.review.provider": "agy", "agent.profiles.review.model": null, "agent.profiles.review.effort": null}`; switched to `claude` → effort key left out (claude offers `high`). Pass the capability map (or a predicate) into `toolChangePatch`; for "inherit" as the tool, test against the depth knob's tool as H1 already does.

#### Inherit fallback label

`INHERIT_FALLBACK` changes from `"provider default"` to `"tool default"` — the brief's expected label for kimi (`empty → "tool default"`), and it avoids the "provider" word the plan is retiring. Affects `↳ inherit (tool default)` in the model list, `↳ tool default` in the effort/provider selects, the custom-input placeholder, and the stale-pin note's inherit button.

### Tests

- **Go** (`fabsysconfig_test.go`, which already has agy/kimi fixture rows at lines ~91-97):
  - agy `doing` with a model override (system origin) → `Model.Inherited == "gemini-3.1-pro-high"`; with no `agent.profiles.doing.model` row at all → `Model.Effective == "gemini-3.1-pro-high"`, `Source == "providers.agy.profiles.default.model"`.
  - agy `fast` → role fill wins over default (`gemini-3.6-flash-low`).
  - kimi role → `Inherited == ""` and `Effective == ""`.
  - `EffortCapable`: fixture commands with and without `{effort}` → `{agy:false, claude:true, codex:true, kimi:false}`; a provider with no command rows → `false`. Update the fixture's `providers.*.interactive_command` rows as needed so claude/codex carry `{effort}`.
- **Frontend unit** (`settings-agents-panel.test.tsx`): effort select disabled with the title for a non-capable effective tool and enabled for a capable one; Reset still visible and posts `effort: null` for a stale effort override on a disabled row; `toolChangePatch` clears effort when switching to a non-capable tool and keeps it when switching to a capable one; update the existing `provider default` expectations (lines ~279-369) to `tool default`.
- **E2E** (`tests/e2e/settings-agents.spec.ts` + `tests/e2e/_fab-config-stub.ts`): the stub document gains `effortCapable: { agy: false, claude: true, codex: true, kimi: false }`; update the `↳ provider default` / `↳ inherit (provider default)` expectations (lines ~97, ~139); add a case where a role on agy/kimi shows the effort select disabled with the title. Every new/changed `test()` carries the JSDoc **Proves:/Steps:** block (Constitution § Test Intent Comments).

### PR evidence

Visible UI change (disabled effort select, corrected inherit label) → per Constitution § PR Evidence, before/after Playwright screenshots on desktop and mobile through a `just` throwaway rig, attached via `gh pr ... --attach`.

## Affected Memory

- `run-kit/configuration`: (modify) § fab-kit System Config — role `Inherited`/`Effective` resolve role fill then the tool's `default` fill; the document's new `effortCapable` map and how it's derived; Design Decision on reading the rung from `show` rows rather than per-role `fab agent`.
- `run-kit/ui/dialogs-and-state`: (modify) § Agents tab — effort select disabled (title "this tool takes no effort setting") for tools without `{effort}`; tool change clears effort for a non-capable tool; inherit fallback label is "tool default".
- `run-kit/api-and-sockets`: (modify) `/api/fab-config` document shape gains `effortCapable`; the `FabConfigDocument` client type row.
- `run-kit/architecture/backend-packages`: (modify) `internal/fabsysconfig` row — `Document.EffortCapable`, `buildRole`'s default-profile fallback.

## Impact

- `app/backend/internal/fabsysconfig/fabsysconfig.go` (+ `_test.go`) — `buildRole`, `Read`, `Document`, `Cell` doc comment.
- `app/backend/api/fab_config.go` — no change expected (passes the document through); verify any handler test that asserts the JSON shape.
- `app/frontend/src/api/client.ts` — `FabConfigDocument` type.
- `app/frontend/src/components/settings-agents-panel.tsx` (+ `.test.tsx`) — `RoleSelect` `title`, `RoleRow`, `toolChangePatch`, `RoleTable` prop wiring, `INHERIT_FALLBACK`.
- `app/frontend/tests/e2e/_fab-config-stub.ts`, `settings-agents.spec.ts`.
- No new endpoints, no new fab execs per GET (both facts come from the existing `fab config show --origin --json` call). No change to write validation (`validate`/`validateValue`): an effort override for a non-capable tool remains writable via the API — the UI just stops offering it.
- Downstream ladder: H5 (rename) will touch the same keys/labels; H4 replaces `effortSuggestions` with per-model efforts but keeps H2's disabled state.

## Open Questions

- None blocking. (Native-only tools — a provider with `native: true` and no command — would read `effortCapable: false` though the native seam takes effort as a prompt instruction; no such tool ships today, and the brief defines capability by the commands.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Fall back from `providers.<p>.profiles.<role>.<leaf>` to `providers.<p>.profiles.default.<leaf>` for both `Inherited` and the no-row `Effective` | Plan H2 Brief verbatim; matches fab's verified resolution order | S:95 R:85 A:95 D:95 |
| 2 | Certain | `effortCapable` true iff `interactive_command` or `headless_command` contains `{effort}`, derived from the existing `fab config show` rows | Plan H2 Brief verbatim; no extra exec | S:95 R:85 A:90 D:90 |
| 3 | Certain | Disabled effort select carries title "this tool takes no effort setting"; Reset link still clears a stale effort override | Plan H2 Brief verbatim; Reset is already driven by `overridden` | S:95 R:90 A:90 D:95 |
| 4 | Certain | Keep `provider` spelling in keys/JSON; no rename work | Plan rules: rename is H5/N1, H2 must not anticipate it | S:90 R:85 A:95 D:95 |
| 5 | Certain | Per-model effort lists are out of scope | Plan H2 non-goal (H4) | S:95 R:90 A:95 D:95 |
| 6 | Confident | Every provider gets an explicit `effortCapable` entry; frontend treats a missing entry as capable | Fail-open posture (plan Decisions) and older-daemon safety; keeps the select usable on absent data | S:60 R:85 A:75 D:70 |
| 7 | Confident | Tool change to a non-capable tool clears the effort override in the same POST | Plan Decision "tool change resets model and effort, keeping a value only if X offers it" — a tool without `{effort}` offers none | S:65 R:85 A:80 D:75 |
| 8 | Confident | Rename `INHERIT_FALLBACK` "provider default" → "tool default" in H2 | Brief's expected kimi label is "tool default"; plan retires "provider"; low-cost string change | S:70 R:90 A:70 D:65 |
| 9 | Certain | Capability is judged for the row's effective tool (`role.provider.effective`) | Same basis H1 uses for model suggestions; the effective tool is what dispatch runs | S:65 R:90 A:85 D:80 |
| 10 | Confident | API write validation unchanged — effort for a non-capable tool stays writable | Brief scopes the change to the UI disabling the select; fab itself accepts the value | S:60 R:85 A:75 D:75 |

10 assumptions (6 certain, 4 confident, 0 tentative, 0 unresolved).
