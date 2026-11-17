# Intake: Role Model Cell — Inherit-First List, Custom Entry, Stale-Pin Flag, Tool-Change Reset

**Change**: 261117-f83n-role-model-cell-inherit-list
**Created**: 2026-11-17

## Origin

> Execute step H1 (Role model cell: inherit-first list that opens unfiltered, custom entry, stale-pin flag, tool change resets model/effort) of the plan at /home/sahil/code/sahil87/fab-kit/fab/plans/sahil/26-11-16-model-pins.md. Read the whole plan first (Decisions and Rules bind you), then implement only the H1 Brief.

One-shot `/fab-new` invocation. The plan ("Agent models: stop config breaking on every model release", fab-kit `fab/plans/sahil/26-11-16-model-pins.md`, written 2026-11-16) is the design source; this change is its step **H1** (hexokit, size M, no dependencies — it runs first in the hexokit chain H1 → H2 → H5 → H4 → H3). The plan's **Decisions** table and **Rules** bind this change; only the H1 Brief is implemented here.

Plan decisions that bind H1 (verbatim intent):

- **Inherit is the default.** A role row with a tool and no model is the intended shape. The UI's first model option is "inherit", and picking it **unsets** the key — inheriting the kit's per-role fills moves with kit releases.
- **Pins remain possible.** Picking a concrete model or typing a custom one still writes a pin. The UI flags a pin the tool no longer offers.
- **Tool change resets model and effort.** Same POST as the tool write: `{provider: X, model: null, effort: null}`, keeping a value only if X offers it. Removes the cross-tool stale pin.
- **hexokit reads, never re-derives, where it can.**
- The rename provider → cli is **not** this step (H5 does the hexokit side, N1 the fab side) — H1 keeps today's `provider` key spelling and labels.

The H1 Brief (verbatim):

> In `settings-agents-panel.tsx`:
>
> - Replace `RoleModelInput`'s `<input list>` + `<datalist>` with a list control that **always opens unfiltered**, whatever the saved value. Options in order:
>   1. `↳ inherit (<inherited>)`, which commits `null` (unset);
>   2. every suggestion for the row's effective tool;
>   3. the current override when it is not a suggestion, labelled `<value> (not offered)`;
>   4. `Custom…`, which swaps the cell for a free-text input (same `useTextSettingDraft` commit path, Escape returns to the list).
>
>   Use a plain `<select>` while the list is short. Build it so H4 can switch to a searchable list (kimi reports hundreds of aliases) without changing the option order or commit behaviour.
> - **Stale pin:** replace the bare ⚠ (`mismatch`) with an inline note: "pinned to `<value>`, which `<tool>` doesn't offer — inherit `<inherited>` instead?" plus a one-click action that commits `null`. Show it only when the suggestion list is non-empty and lacks the override. For claude the wording is "not in the list — inherit `<inherited>` to track the latest", because Claude Code accepts any full model ID: a pinned `claude-opus-5-5` is stale, not invalid.
> - **Tool change:** `RoleRow`'s tool `onChange` sends one patch `{provider: v, model: null, effort: null}`, leaving out the model key when the current model override is offered by the new tool and the effort key when the effort override is in `doc.effortSuggestions`. Picking "inherit" for the tool follows the same rule against the depth knob's tool.
> - Tests: unit cases for each option kind, the tool-change patch shape (kept vs cleared), and the stale-pin action; an e2e case in `settings-agents.spec.ts` that sets a model, reloads the tab, opens the list and sees every suggestion (the regression for the bug).
> - Non-goals: backend changes (H2); discovery (H4); the tool-default option (H3).

## Why

**The bug the user hit.** In Settings → Agents, the per-role **model** cell is an `<input list=…>` backed by a `<datalist>` (`app/frontend/src/components/settings-agents-panel.tsx:439-490`, `RoleModelInput`). The input is pre-filled with the saved override, and browsers filter a datalist by the input's current text. So on first pick (empty input) every suggestion is listed, but when the user comes back to edit a row that already has a pin, the list shows only the saved model — the other models are hidden unless the user first clears the text. The backend's `modelSuggestions` is correct; the control is the bug.

**Pins are the default interaction, and they go stale.** Today the only way to get anything into the model cell is to type or pick a concrete model, which writes `agent.profiles.<role>.model` — a key that outranks the kit's per-role fills, so the role never moves when the kit ships a newer model. There is no visible "inherit" choice (the inherited value only shows as a placeholder that vanishes once a value is set), so clearing a pin means knowing to blank the text box and blur. The plan's core decision is that **inherit is the default**: the first option of the list must be inherit, and picking it must unset the key.

**A stale pin is only a bare ⚠.** When the override is outside the resolved tool's suggestions, the cell shows a ⚠ with a hover title. It tells the user nothing actionable and offers no one-click way back to the inherited fill.

**A tool change leaves the other tool's model behind.** Switching a role from codex to claude while `model: gpt-5.6-sol` is pinned yields `claude --model gpt-5.6-sol`. The UI only shows the ⚠. The plan decides the tool write should also clear model/effort overrides the new tool does not offer, in the **same POST**.

**If we don't fix it:** every model release keeps breaking configs the UI itself created; users can't see the full list when editing; cross-tool stale pins keep reaching dispatch. H1 is the step that fixes what the user feels and needs nothing from fab, so it ships first.

**Why this approach:** a native `<select>` always shows all options regardless of the current value (fixes the filter bug with zero custom machinery), makes "inherit" a first-class first option, and keeps free-text entry reachable via `Custom…`. Building the option list as a pure function (kind-tagged options) lets H4 swap the renderer for a searchable list without touching order or commit semantics. Rejected: keeping the datalist and clearing the input on focus (still a filtered, browser-dependent widget, and loses the visible current value); a custom combobox now (more code than a short list needs — H4 decides when search is warranted).

## What Changes

All changes are frontend-only, in `app/frontend/`. No backend, API or type changes (`FabConfigDocument`, `FabRole`, `FabRoleCell` stay as they are).

### 1. Model option list — a pure, kind-tagged builder

Add a pure function in `src/components/settings-agents-panel.tsx` that builds the model cell's options in the fixed order, so the renderer (a `<select>` now, a searchable list in H4) only maps over it:

```ts
type ModelOption =
  | { kind: "inherit"; value: typeof MODEL_INHERIT; label: string }   // commits null
  | { kind: "suggestion"; value: string; label: string }             // commits value
  | { kind: "stale"; value: string; label: string }                  // the current override, not offered
  | { kind: "custom"; value: typeof MODEL_CUSTOM; label: "Custom…" }; // enters custom mode

function modelOptions(cell: FabRoleCell, suggestions: string[]): ModelOption[]
```

Order and labels:

1. **inherit** — label `↳ inherit (<inherited>)` where `<inherited>` is the same value the existing `inheritedLabel` uses: `cell.effective` when `cell.override === null`, else `cell.inherited`; empty → the existing `INHERIT_FALLBACK` ("provider default"). Example: `↳ inherit (claude-opus-5-5)`, `↳ inherit (provider default)`. Picking it commits `null` for `agent.profiles.<role>.model`.
2. **suggestion** — one per entry of the row's suggestions, in the document's order (`doc.modelSuggestions[role.provider.effective]`, as `RoleTable` already passes). Label = the model id. Picking commits that id.
3. **stale** — present only when `cell.override !== null` and the override is not among the suggestions. Label `<value> (not offered)` when the suggestion list is non-empty; plain `<value>` when the list is empty (a tool with no fills, e.g. kimi, has no list to be "not offered" by — mirrors the stale-pin note's non-empty condition). <!-- assumed: "(not offered)" suffix only when the suggestion list is non-empty — an empty list (kimi/agy without fills) says nothing about what the tool offers -->
4. **custom** — label `Custom…`. Picking it does not write; it swaps the cell to the free-text input (§2).

Sentinel values for inherit/custom must never collide with a real model id: inherit uses `""` (an empty model is never a valid pin — the backend treats an empty profile string as unset), custom uses a named constant that cannot be a model id (e.g. `MODEL_CUSTOM = "\u0000custom"` or similar non-printable/non-id string — named constants, no magic strings, per code-quality).

The `<select>`'s `value` is `cell.override ?? ""` — the selected option is the override (a suggestion or the stale entry) or inherit. Dimmed (`text-text-secondary`) when `cell.override === null`, matching `RoleSelect`. `aria-label` stays `` `${role} model` `` so existing label-based queries keep working. Because it is a native `<select>`, the list always opens unfiltered regardless of the saved value — this is the bug fix.

Commit path in list mode: the select's `onChange` goes through the row's `useRowWrite.run` (busy + row-scoped error, like the provider/effort selects), POSTing `{ "agent.profiles.<role>.model": value | null }`. Selecting the already-selected option is a no-op (native `onChange` won't fire).

### 2. `Custom…` free-text mode

Picking `Custom…` swaps the cell for a text input (local component state `mode: "list" | "custom"`):

- The input is built on the existing `useTextSettingDraft` (same commit path the old `RoleModelInput` used): initial draft `cell.override ?? ""`, Enter/blur commits, trimmed `""` commits `null` (unset), a non-empty value commits the string. The input gets focus when the mode switches. `aria-label` `` `${role} model` `` (custom), placeholder the inherit text.
- **Escape returns to the list** — always, whether or not the draft diverged: it reverts the draft, clears the error, switches back to list mode, and stops propagation so the Settings dialog does not close. (`useTextSettingDraft`'s own Escape only stops propagation when the draft diverged; the custom input wraps its `onKeyDown` to always handle Escape here.)
- After a **successful** commit (or a blur with an unchanged draft) the cell returns to list mode; the fresh document makes the new value show as a suggestion or as the stale `(not offered)` entry. A **failed** commit stays in custom mode with the draft kept and fab's error shown inline (`TextSettingError`), matching the old behaviour.
- Writes from custom mode go through the panel's queued `write`, as `RoleModelInput` does today.

<!-- assumed: Escape always returns to the list (not only when the draft diverged), and a successful commit also returns to the list — the Brief says "Escape returns to the list"; staying in a text box after a commit would re-create the filtered-input feel -->

### 3. Stale-pin inline note (replaces the bare ⚠)

Remove the `mismatch` ⚠ `<span role="img" aria-label="model not in the provider's suggestions">`. In its place, when **the suggestion list is non-empty and lacks `cell.override`** (`cell.override !== null`), render an inline note for that row with a one-click action that commits `null` for the role's model key:

- Non-claude tool (`role.provider.effective !== "claude"`):
  `pinned to <value>, which <tool> doesn't offer — [inherit <inherited>] instead?`
- Claude (`role.provider.effective === "claude"`):
  `pinned to <value>, not in the list — [inherit <inherited>] to track the latest`
  (Claude Code accepts any full model ID, so a pinned `claude-opus-5-5` is stale, not invalid — the wording must not claim the tool rejects it.)

`<value>` = the override, `<tool>` = `role.provider.effective`, `<inherited>` = the inherit value from §1 (`cell.inherited` while overridden; `provider default` when empty). `[…]` is a `<button type="button">` (accent link style like `ResetLink`), disabled while the row is busy, whose click runs `run({ "agent.profiles.<role>.model": null })`. Give the note a `data-testid` (e.g. `stale-model-<role>`) and the button an accessible name such as `` `Inherit ${inherited} for ${role} model` `` so tests can target it. Value/tool/inherited render in monospace (`<code>` or `font-mono`).

Placement: the role table's model column is narrow (`max-w` ~12rem, table `min-w-[620px]`), so the note renders as a full-width sub-row under the role row (`<tr><td colSpan={6}>…</td></tr>`), the same way the row's write error already renders. Styled amber (`text-signal-yellow`, `text-[10px]`) like the other inline warnings. <!-- assumed: the note renders as a full-width sub-row under the role row (like the existing error row) rather than inside the narrow model cell -->

No note when the suggestion list is empty (kimi/agy without fills) or when there is no override.

### 4. Tool change resets model and effort in the same POST

`RoleRow`'s provider `RoleSelect` `onChange(v)` stops sending a single key. It builds one patch:

```ts
// newTool: the tool the row will resolve to after this write
const newTool = v ?? role.provider.inherited;   // inherit → the depth knob's tool
const patch: Patch = { [profileKey(role.role, "provider")]: v };
if (!(role.model.override !== null && (doc.modelSuggestions[newTool] ?? []).includes(role.model.override)))
  patch[profileKey(role.role, "model")] = null;
if (!(role.effort.override !== null && doc.effortSuggestions.includes(role.effort.override)))
  patch[profileKey(role.role, "effort")] = null;
void run(patch);
```

Rules:

- The model key is **left out** (kept) only when the current model override is offered by the new tool (`modelSuggestions[newTool]` includes it). Otherwise it is sent as `null` — including when there is no override (an unset of an absent key is harmless; the row reset already does exactly that), which matches the Brief's literal patch shape `{provider: v, model: null, effort: null}`.
- The effort key is left out only when the current effort override is in `doc.effortSuggestions`; otherwise `null`. (Today's `effortSuggestions` is the global `low…max` set, so a normal effort override is kept; H2/H4 refine per-tool efforts.)
- **Picking inherit for the tool** (`v === null`) uses the same rule against the depth knob's tool. The depth knob's tool is `role.provider.inherited` (the backend's `inherited` for the provider cell is the depth knob — `agent.session` for session-tier roles, `agent.workers` for workers — per `docs/memory/run-kit/api-and-sockets.md`); fall back to `doc.fields["agent." + role.depth]?.value` when `inherited` is empty.
- **No effective tool change ⇒ provider key only.** When `newTool === role.provider.effective` (e.g. explicitly pinning the tool the row already inherits, or un-pinning to an inherited tool equal to the pinned one), send only `{provider: v}` — the model/effort overrides were already chosen for that tool, and a custom model the suggestion list doesn't carry (e.g. `glm-latest[1m]` on claude) must not be wiped by a no-op tool write. <!-- assumed: the reset applies only when the effective tool actually changes; pinning/unpinning to the same tool sends just the provider key -->

`RoleRow` therefore needs `modelSuggestions` (the whole map, or a lookup) and `effortSuggestions` passed in — `RoleTable` currently passes only `suggestions={doc.modelSuggestions[role.provider.effective]}`; add the map (or pass `doc`) so the new tool's list can be looked up.

The provider and effort `RoleSelect`s are otherwise unchanged (their inherit option keeps the existing `↳ <value>` label; only the model list adopts `↳ inherit (<value>)` per the Brief).

### 5. Tests

**Unit** — `src/components/settings-agents-panel.test.tsx` (vitest + Testing Library; fixtures `makeDoc`, `withRole`, `inherited`, `overridden` already exist; `modelSuggestions` fixture is `{ claude: ["claude-opus-5-5", "claude-sonnet-5-5"], codex: ["gpt-5.6-sol"], agy: [], kimi: [] }`):

- Replace the datalist/placeholder/⚠ tests (`offers the resolved provider's models as datalist suggestions`, `model commits on blur, and clearing it unsets`, `flags a model override outside…`, `does not flag a model when the provider has no suggestions`, and the `placeholder` assertions in `shows inherited cells dimmed…` / `labels inherit on an overridden leaf…`) with select-based equivalents.
- **Each option kind:** the model select's options are, in order, `↳ inherit (<inherited>)`, every suggestion, the stale `<value> (not offered)` entry only when the override is not a suggestion, then `Custom…`. Cases: no override (inherit selected, label uses `effective`, `provider default` when empty); override that is a suggestion (selected, no stale entry, the full list still present — the regression); override not in a non-empty list (stale entry labelled `(not offered)`, selected); override with an empty list (kimi: plain label, no note).
- Picking a suggestion POSTs `{ "agent.profiles.<role>.model": "<id>" }`; picking inherit POSTs `null`.
- **Custom…**: picking it shows a text input; typing + Enter (and blur) POSTs the trimmed value; an empty commit POSTs `null`; Escape returns to the select without a POST; a rejected commit keeps the input with the error.
- **Stale-pin note:** shows the non-claude wording for codex and the claude wording for claude; the action POSTs `{ "agent.profiles.<role>.model": null }`; absent when the list is empty or the override is offered.
- **Tool-change patch shape:** codex → claude with a codex-only model pin and `effort: high` ⇒ `{provider: "claude", model: null}` with effort kept (left out); a pin the new tool offers ⇒ model key left out; an effort override outside `effortSuggestions` ⇒ `effort: null`; no overrides ⇒ `{provider, model: null, effort: null}`; picking inherit for the tool evaluates against the depth knob's tool (`role.provider.inherited`); picking the tool the row already resolves to ⇒ provider key only. The existing `a provider pick POSTs that role's provider key` and `choosing inherit on an overridden leaf POSTs null for that key` tests update to the new patch shape.

**E2E** — `app/frontend/tests/e2e/settings-agents.spec.ts`, with a JSDoc **Proves:/Steps:** block (Constitution § Test Intent Comments):

- New test (the bug regression): open the Agents tab, pick `claude-sonnet-5-5` in `doing model`, assert the POST `{ "agent.profiles.doing.model": "claude-sonnet-5-5" }`; **reload the tab** (close/reopen the Settings dialog or switch tabs away and back — the panel re-fetches on every mount — or `page.reload()` + reopen; the stateful stub keeps the system tier across GETs within the page's route); assert the select's value is `claude-sonnet-5-5` and its options contain **every** suggestion (`claude-opus-5-5`, `claude-sonnet-5-5`) plus inherit first and `Custom…` last. Native `<select>` options can't be visually "opened" in Playwright; asserting the option list is the equivalent.
- Update the file-header comment if the shared setup description changes. Existing tests that only touch effort/provider chips stay as they are; the existing `per-role override …` test's reset assertion is unaffected.
- `tests/e2e/_fab-config-stub.ts`: likely no change (it already serves `modelSuggestions` and applies set/unset); extend only if the new test needs it.

**Demo / PR evidence** (Constitution § PR Evidence — ship-stage concern, noted for the plan): this changes observable UI, so the PR needs before/after `just demo` recordings at desktop and mobile viewports. `app/frontend/tests/demo/agents-settings.demo.ts` and `agents-settings-provenance.demo.ts` already drive this tab and may need updating to the new control (they may reference the model input/datalist).

## Affected Memory

- `run-kit/ui/dialogs-and-state`: (modify) § Agents tab — the per-role table's model cell becomes an inherit-first `<select>` (inherit → suggestions → `(not offered)` override → `Custom…` free-text mode, Escape returns to the list); the stale-pin ⚠ is replaced by the inline "pinned to … — inherit …" note with a one-click unset (claude wording variant); a provider change POSTs `{provider, model: null, effort: null}` in one request, keeping the model/effort override only when the new effective tool offers it, and only when the effective tool actually changes. Add a Design Decision entry for inherit-first + native select (datalist filter bug) and the tool-change reset.

## Impact

- **Code**: `app/frontend/src/components/settings-agents-panel.tsx` (`RoleModelInput` replaced, `RoleRow`'s provider `onChange`, `RoleTable` props), `app/frontend/src/components/settings-agents-panel.test.tsx`, `app/frontend/tests/e2e/settings-agents.spec.ts`, possibly `app/frontend/tests/e2e/_fab-config-stub.ts` and the two `tests/demo/agents-settings*.demo.ts` scripts.
- **API/backend**: none. `/api/fab-config` already accepts multi-key patches with `null` unsets (sequential, sorted key order; a failing later key leaves earlier keys written — the panel already re-reads on failure).
- **Downstream plan steps**: H2 (backend inherit label / effort capability) and H4 (searchable list from `fab agent models`) build on the option builder and the stale-pin note; H5 renames the `provider` label/keys; H3 inserts `↳ tool default` as option 2. The option builder must keep inherit first and leave room for H3's insertion.
- **Constitution**: V (keyboard-first — a native `<select>` and text input are keyboard-reachable; the stale-pin action is a real `<button>`); IV unaffected (same Agents tab); § Test Intent Comments for the new e2e test; § PR Evidence for before/after recordings.
- **Verification gates**: `cd app/backend && go test ./...` (unchanged), `cd app/frontend && npx tsc --noEmit`, `just test`, `just build`.

## Open Questions

- None blocking. The tentative choices (stale label suffix only for non-empty lists, sub-row placement of the note, reset only on an effective tool change, Escape always returning to the list) are recorded below for `/fab-clarify`.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Model cell becomes a native `<select>` with options in the order inherit → suggestions → non-suggestion override → `Custom…` | Brief specifies the order and "plain `<select>` while the list is short" verbatim | S:95 R:85 A:95 D:95 |
| 2 | Certain | Inherit option labelled `↳ inherit (<inherited>)` commits `null`; `<inherited>` reuses the existing inherit value rule (`effective` when unset, `inherited` when overridden, `provider default` when empty) | Brief + plan Decision "Inherit is the default"; existing `inheritedLabel` already encodes the value rule | S:90 R:85 A:90 D:85 |
| 3 | Certain | Options are produced by a pure kind-tagged builder (`modelOptions`) that the renderer maps over | Brief: "Build it so H4 can switch to a searchable list without changing the option order or commit behaviour" | S:85 R:85 A:85 D:80 |
| 4 | Certain | `Custom…` swaps to a text input on `useTextSettingDraft`; Enter/blur commit, empty commits `null` | Brief: "same `useTextSettingDraft` commit path"; empty→unset matches today's `RoleModelInput` | S:90 R:85 A:90 D:85 |
| 5 | Confident | Escape in custom mode always returns to the list (reverts, stops propagation); a successful commit also returns to the list; a failed commit stays with the error | Brief says "Escape returns to the list"; staying in the box after commit would recreate the filtered-input feel; failure keeping the draft matches the existing draft idiom | S:70 R:85 A:70 D:65 |
| 6 | Tentative | `(not offered)` suffix on the override entry only when the suggestion list is non-empty; plain value when empty | Brief labels it `(not offered)` unconditionally, but an empty list (kimi/agy without fills) says nothing about what the tool offers; mirrors the stale-note condition | S:50 R:85 A:55 D:45 |
| 7 | Certain | Stale-pin note replaces the ⚠, shown only when the suggestion list is non-empty and lacks the override, with wording per tool (claude: "not in the list — inherit X to track the latest"; others: "which <tool> doesn't offer — inherit X instead?") and a one-click unset button | Brief wording and condition verbatim | S:90 R:85 A:90 D:85 |
| 8 | Tentative | The stale-pin note renders as a full-width sub-row under the role row (like the write-error row), amber `text-[10px]` | Model column is ~12rem in a 620px-min table; the existing error row sets the precedent; Brief says "inline note" without placement | S:45 R:85 A:60 D:50 |
| 9 | Certain | Tool change sends one patch `{provider: v, model: null, effort: null}`, leaving model out when the new tool offers the model override and effort out when the effort override is in `effortSuggestions`; null sent even when no override exists | Brief literal patch shape; unsetting an absent key is already done by the row reset | S:90 R:80 A:85 D:85 |
| 10 | Confident | Picking inherit for the tool evaluates the rule against `role.provider.inherited` (the depth knob's tool), falling back to `fields["agent.<depth>"].value` | Brief: "against the depth knob's tool"; memory documents provider `inherited` as the depth knob | S:80 R:85 A:80 D:70 |
| 11 | Tentative | When the new effective tool equals the current effective tool, send only the provider key (no model/effort reset) | Not in the Brief; protects a custom model pin (e.g. `glm-latest[1m]` on claude) from being wiped by a no-op tool write — the reset's purpose is the cross-tool stale pin | S:40 R:80 A:55 D:45 |
| 12 | Confident | Provider and effort selects keep their existing `↳ <value>` inherit label; only the model list adopts `↳ inherit (…)` | Brief scopes the label to the model list; H5 relabels the provider column later | S:65 R:90 A:70 D:65 |
| 13 | Certain | No backend/API/type changes; "provider" spelling and labels unchanged | Brief non-goals (H2, H4, H3) and plan rule: rename is H5/N1 | S:95 R:90 A:95 D:95 |
| 14 | Certain | Tests: unit cases per option kind, tool-change patch shapes, stale-pin action; e2e regression (set model, reload tab, list shows every suggestion) with a Proves/Steps JSDoc | Brief test list + Constitution § Test Intent Comments | S:90 R:85 A:90 D:85 |
| 15 | Confident | The e2e "reload" re-mounts the panel (close/reopen dialog or tab switch, or page reload with the stateful stub) and asserts the select's option list rather than a visually opened native dropdown | Native select popups aren't inspectable in Playwright; the panel re-fetches on every mount so a remount is a true reload of the document | S:70 R:90 A:75 D:65 |

15 assumptions (8 certain, 4 confident, 3 tentative, 0 unresolved).
