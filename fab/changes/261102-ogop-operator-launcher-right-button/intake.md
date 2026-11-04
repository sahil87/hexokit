# Intake: Operator launcher becomes a right-aligned "Operator" button

**Change**: 261102-ogop-operator-launcher-right-button
**Created**: 2026-11-02

## Origin

Conversational. A design discussion compared options in an HTML mock, and the user approved one of them. This intake was then created by a promptless dispatch (`{questioning-mode} = promptless-defer`), so no questions were asked. Decisions that would have needed a question are recorded as deferred rows in `## Assumptions`.

The synthesized brief:

> **Operator launcher → right-aligned "Operator" button.** Replace the quake launcher's three render forms with ONE `<button>`. It shows ◉ + "Operator" + ⌘J keycap, plus a draft dot when there is an unsent draft. It latches (pressed) while the drawer is open. Move it from the top bar's center cell into the right cluster as its leftmost item, left of the surface toggles and separated from them by a divider. It gets a registry entry that does not overflow early, plus an "Operator ⌘J" menu row.

**Approved mock** (reference only, variant B′): `/tmp/claude-1001/-home-sahil-code-sahil87-hexokit-worktrees-twilit-tapir/582f9403-8b84-4c3e-a5ea-46758149c455/scratchpad/operator-launcher-mock/index.html`. This is a session scratchpad and may not outlive the session. Everything in it that matters is reproduced below.

**How the decision was reached.** The user chose "Option B, right-aligned". These alternatives were rejected:
- **A**: keep today's three-element structure and restyle it as a button. Rejected because it keeps the "swap under the cursor" problem: the clicked element is replaced by a different element.
- **C**: a status chip with live state words ("operator · working / needs you"). Rejected because it adds a status channel to the top bar that competes with the Status Pyramid.
- **D**: a glyph-only icon toggle beside the tiles. Rejected because it is hard to discover and would be confused with the tile toggles.
- **E**: remove the launcher entirely. Rejected as the worst for discoverability.
- **Centered "Operator" label.** Keeping the button in the center cell with the "Operator" label was also considered. Rejected because "◉ Operator ⌘J" (~16ch) exceeds the deliberate 12ch `lg` budget that protects the breadcrumbs' minimum width.

## Why

1. **Problem.** The quake launcher (`app/frontend/src/components/quake-launcher.tsx`, mounted in the top bar's center cell beside the page heading at `app/frontend/src/components/top-bar.tsx` ~line 1807) looks like a text field but behaves like a button:
   - At ≥`lg` it renders as a STANDING bordered `<input>` with the placeholder "Ask…" ("Ask the operator…" at ≥`2xl`).
   - Its `onFocus` immediately sets the quake machine to `open`, and the drawer then moves focus to the docked compose textarea. So the user can never actually type into it.
   - Its Enter-to-send (`onKeyDown`) and file-paste (`onPaste` → `attachOperatorFiles`) handlers are effectively unreachable.

   The component also has THREE render forms:
   - the md–lg dim ghost (`· ◉ ask`, `data-testid="quake-launcher-ghost"`);
   - the ≥lg standing input box (`quake-launcher` wrapper + `quake-launcher-input`);
   - a separate collapsed glyph+chord button (`quake-launcher-collapsed`), shown while the drawer is open or on the operator window's own route.

   Clicking the box therefore swaps it for a different element under the pointer.
2. **Consequence of not doing it.** The control keeps lying about what it is. It looks like a text field that can't be typed into, and it changes shape under the cursor. It also keeps dead code paths (Enter-send, paste upload, the `readOnly` no-operator branch, and a two-query width ladder) that tests must keep covering. The center cell stays crowded too: at ≥`lg` the page heading hides its `PageType:` prefix only so that the launcher fits beside it.
3. **Why this approach.**
   - One `<button>` that is the same element in every state removes the swap-under-cursor problem and the fake-input affordance.
   - A fixed noun label ("Operator") is stable; the verb moves to the tooltip.
   - The right cluster already has a measured overflow registry, so narrow-width behavior comes from measured fit instead of hard-coded `lg`/`2xl` breakpoints.
   - Moving the button out of the center gives the breadcrumbs back their room.

## What Changes

### 1. One button, same element in every state (`quake-launcher.tsx`)

Replace all three forms with ONE `<button type="button">`. It is the same DOM element at rest, while the drawer is open, and on the operator route. Visual anatomy, left to right:

```
[ ◉• Operator ⌘J • ]
  │   │        │  └ draft dot (only when an unsent draft exists)
  │   │        └ chord keycap (registry-effective, omitted when unbound/disabled)
  │   └ fixed label "Operator"
  └ OperatorStateGlyph (◉ with the live state dot)
```

- **Glyph**: the existing `OperatorStateGlyph` (`components/operator-state-glyph.tsx`) with its live state dot, always shown (`showDot` true). The dot keeps `data-testid="quake-launcher-state"` and the `data-state` attribute. Dot colors stay unchanged: `active` green, `waiting` amber, other states grey, and no dot when there is no operator.
- **Label**: the fixed noun **"Operator"** in every state. It is never "Ask", "Ask the operator" or "Start operator".
- **Chord keycap**: read from the keybindings registry exactly as today:
  ```ts
  const binding = byAction.get("quake-terminal");
  const chord = binding?.enabled ? formatCombo({ code: binding.code, tier: binding.tier }, host.platform) : undefined;
  ```
  It uses the same `<kbd>` styling as today (`rounded border border-border px-1 text-[10px] leading-4 text-text-secondary`, `aria-hidden`).
- **Draft dot**: a small dot shown when the resolved operator's shared compose draft is non-empty, i.e. `useOperatorCompose(server, target).text.trim() !== ""` (the same store key the drawer's docked strip reads). Give it a testid (e.g. `quake-launcher-draft`).
- **Tooltip** (the shared `Tip` component, the top-bar convention):
  - operator exists: `Ask the operator (⌘J)`
  - no operator on the resolved server: `Start the operator (⌘J)`. The absent state dot is what conveys "no operator"; the label stays "Operator".
  - draft present: append `· unsent draft`, e.g. `Ask the operator (⌘J) · unsent draft`
  - chord unbound or disabled: drop the parenthetical.
  - The chord text inside the tooltip is the same `formatCombo` output as the keycap, so it reads `(⇧Ctrl+J)` on Linux/Windows.
- **Accessible name**: the button's text is "Operator". In any glyph-only rung (see §4) it keeps `aria-label="Operator"`. Testid: `data-testid="quake-launcher"` on the button itself.
- **Styling**: a top-bar content-width chip on the shared height token (`TOP_BAR_BUTTON_H` / `controlClass({ variant: "icon", box: "height", … })`, the UpdateChip / Open-segment convention), with the `rk-glint` CRT-glint hover from the button hover vocabulary. It is a `button`, never an `input`.

**States and click semantics**:

| State | Visual | Click |
|-------|--------|-------|
| Rest (machine `rest`, not operator route) | plain chip | `setQuakeMachineState("open")`; the drawer's focus-on-open moves focus to the docked compose textarea |
| Open (machine `open`) | latched: inset well, `aria-expanded="true"`; the green accent edge additionally shows only while the docked compose owns focus (the existing focus-derived `engaged` flag) | re-focus the docked compose: `setQuakeMachineState("open")` (the same-value re-assertion bumps the activity counter the outside-click settle check honours), then focus `[data-testid="quake-terminal-compose-input"]`. Esc / click-away still close the drawer. The click does NOT close it. |
| Operator window's own route (`onOperatorRoute`) | plain chip (never latched — no drawer) | `focusComposeStrip()` (from `lib/compose-strip-events.ts`); no machine transition, no drawer |
| No operator on resolved server | plain chip, no state dot, "Start the operator" tooltip | same as Rest (the drawer then shows its Start-operator hint) |

The `onOperatorRoute` derivation stays as it is today: `routeServer !== null && routeServer === server && target !== undefined && routeWindow === target.window.windowId`.

**Keep** (load-bearing invariants):
- **Focus-ownership invariant (a).** At machine entry (`rest → open`), a `useEffect` keyed on `machine` captures `document.activeElement` into `setQuakeRestoreOrigin(...)`, but ONLY when it lies outside every quake-terminal-owned element (`isQuakeTerminalTarget`). A mouse click on the button focuses the button BEFORE the click transitions the machine. The button carries `data-quake-terminal`, so the guard drops it and the origin is `null` rather than the button itself. That behavior must be preserved: `docs/memory/run-kit/ui/focus-ownership.md` § The Quake Terminal's Own Focus Return. The capture effect must keep running on the component that is always mounted on desktop. If the button can be overflowed into the menu, the effect must still run (see Impact).
- **`data-quake-terminal`** on the button, so that its click is not treated as an outside click that collapses the drawer.
- The same-value machine re-assertion when the drawer is already open.
- **Mobile renders nothing**: `useIsMobile()` → `null`. The mobile operator path (the chevron-menu row's `requestQuakeTerminal({ action: "open" })` → navigation to the operator window's terminal route, and the tongue) is unchanged.
- Server/target resolution via `resolveQuakeTerminalTarget(routeServer, servers, sessionsByServer, lastViewedRef.current)`, which tolerates a missing `SessionProvider` (degrades to "no operator").
- Escape is not handled in the component (the quake terminal's Esc ladder owns release).

**Remove**:
- the `<input>` and its `onChange` / `onFocus` / Enter-send `onKeyDown` / `onPaste` (`attachOperatorFiles`) handlers;
- the `readOnly` no-operator branch and both placeholders;
- the md–lg ghost (`quake-launcher-ghost`) and the separate collapsed control (`quake-launcher-collapsed`, `aria-label="Focus quake terminal compose"`);
- `WIDE_RUNG_QUERY` / `EXTRA_WIDE_RUNG_QUERY` and the `useMediaQuery` width ladder;
- imports that become unused: `attachOperatorFiles`, `sendOperatorMessage` and `setOperatorComposeText`, if nothing else in the file needs them.

The docked compose inside the drawer (`QuakeCompose` in `quake-terminal.tsx`) is UNCHANGED and still says "Ask the operator…".

### 2. Placement: out of the center cell, into the right cluster's head (`top-bar.tsx`)

- Delete the `<QuakeLauncher …/>` mount from the center cell (`top-bar.tsx` ~line 1807, plus its comment block). After this, the center cell holds only the page heading.
- Render the button as the **leftmost item of the right cluster**, immediately LEFT of the surface-toggle group (`SurfaceToggleGroup`, `>_ :// {} []`).
- A **divider** separates the button from what follows it, so that it doesn't read as a fifth tile toggle (the drawer is a viewer-level overlay, not a tile in the tab's layout). Use the existing hairline/neutral-divider vocabulary (`border-l border-border` or an equivalent thin rule at the bar control height).
- It renders in **every mode** (`terminal`, `board`, `server`, `host`), whereas the surface toggles are terminal-only. On non-terminal modes the divider separates it from the next in-bar control (Refresh / Gear / the board controls), or it is omitted when nothing follows. <!-- assumed: divider rendered whenever another in-bar control follows the launcher, omitted otherwise -->
- The route server and window keep arriving as props (`routeServer={server || null}`, `routeWindow={currentWindow?.windowId ?? null}`). The component must not pull router hooks, because the TopBar test harness doesn't mock them.

### 3. Registry entry: does not overflow early, has a menu row

The right cluster is driven by the ordered overflow registry `rightItems: RegistryEntry[]` in `top-bar.tsx` (~line 990). How it works:
- Fit candidates exclude `menuOnly` and `pinned` entries.
- `orderForFit` (in `lib/top-bar-overflow.ts`) moves `dropLast` entries to the tail of the fit order.
- The probe measures each candidate's `barRender()` width.
- `computeVisibleCount` greedily fits from the reversed (tail-first) widths.
- Overflowed entries render their `menuRender()` rows in `TopBarOverflowMenu`, under `menuGroup` sections (Tiles / View / Tab / App).

The launcher gets a registry entry at the **registry head** (before `surface-toggles`):
- **`dropLast: true`**, not `pinned`. A `pinned` entry never reaches the menu (no `menuRender` rows) and its container renders at the head on the assumption that "the only pinned entry is the registry head" (the mobile switch group). That conflicts with the required overflow menu row. `orderForFit` is stable within the `dropLast` half, so with the launcher before `surface-toggles` the fit order tail is `[…, quake-launcher, surface-toggles]`. The surface toggles therefore remain the very last to overflow, and the launcher is second-to-last: after Open / Layout / UpdateChip / Refresh / Gear.
- `modes: ["terminal", "board", "server", "host"]`.
- `hidden: isMobile`. The bar form is desktop-only; the mobile path is the existing menu row (below).
- **Menu row when overflowed**: an "Operator" row with the trailing chord keycap (`MENU_ROW_KBD_CLASS`). It uses the same click semantics as the button (rest → open; open → re-focus the docked compose; operator route → `focusComposeStrip()`) and lives in the `app` menu group.
- **Interaction with the existing `quake-terminal` menuOnly row.** `rightItems` already has a `menuOnly` entry `id: "quake-terminal"` (App group, all modes) rendering `QuakeTerminalMenuRow` ("Quake terminal" + chord, `requestQuakeTerminal({ action: "open" })`). Today it is the mobile path and also always shows on desktop. Default: merge it into the launcher's entry so that desktop never shows two operator rows. The merged entry:
  - is a `dropLast` fit candidate on desktop whose row appears only when overflowed;
  - is `menuOnly` on mobile, where the row always shows;
  - uses the single row label "Operator".

  <!-- assumed: fold the existing menuOnly "Quake terminal" row into the launcher's registry entry (menuOnly on mobile, dropLast fit candidate on desktop) and relabel it "Operator" on both form factors -->

### 4. Narrow-width degradation from measured fit (not breakpoints)

The old `lg` / `2xl` media-query ladder is removed. Narrow-width handling comes from the right cluster's measured fit. The ideal ladder is: **labelled (`◉ Operator ⌘J`) → glyph-only (`◉`, plus the keycap or not — see Assumptions) → menu row**.

**Verified finding.** The registry has NO two-width entry support today:
- `RegistryEntry` has one `barRender`.
- The probe measures one width per entry.
- `computeVisibleCount` returns a count, not per-entry rungs.

UpdateChip is NOT a two-width precedent. Its label varies with content (`⬆ v{latest}` vs `⬆ updates (N)`), but it has a single bar form that the probe simply re-measures; it never folds to a smaller form under pressure.

The real multi-rung precedent is the sidebar head's measured fold (`SidebarHead` in `top-bar.tsx` + `nextHeadRung` in `lib/new-split.ts`). It has rungs R1 full → R2 wordmark hidden → R3 icon-only, with per-rung measured widths and `NEW_SPLIT_FOLD_HYSTERESIS_PX` hysteresis.

**Chosen mechanism (default):** extend `RegistryEntry` with an optional compact bar form (e.g. `compactBarRender?: () => ReactNode`). The probe measures both forms, and the fit computation in `lib/top-bar-overflow.ts` (pure, unit-testable) decides, per entry, full vs compact vs overflowed. Only the launcher uses it initially. The alternative is a self-folding launcher that measures itself. It is rejected because a child whose width changes on its own would feed the probe a moving width (a fit feedback loop). <!-- assumed: generalize the registry with an optional compact rung rather than self-measure inside the launcher -->

WHERE the label drops relative to other controls overflowing is a deferred decision (Assumptions #U1). The default for the plan: the label drops FIRST, before any other fit candidate overflows, because the glyph plus tooltip still identify the control. After that the normal pyramid runs, and the glyph-only button overflows to its menu row just before the surface toggles. The ladder needs expand-edge hysteresis (the crumb-collapse / head-fold precedent) so it doesn't flap at the boundary.

### 5. Center cell follow-through

- The `TopBar` comment at ~line 770 ("The center heading never yields its cell to the quake launcher…") and the center-cell comments at ~1699 / ~2168 that reference the launcher are rewritten or removed. Per code-quality: no history narration and no change IDs.
- **The compact heading at ≥`lg`.** At ≥`lg` the heading hides its `PageType:` prefix (the `hidden sm:inline lg:hidden` sweep-cell span, ~line 2168) "so the standing quake launcher fits beside `{name} ▾`". With the launcher gone, that reason no longer applies. Whether to restore the prefix at ≥`lg` is deferred (Assumptions #U2). The default for the plan is to leave the compact heading as is, so all freed width goes to the breadcrumbs, which is the user's stated goal.

### 6. Tests

- **`app/frontend/src/components/quake-launcher.test.tsx`** (~30 cases): rewrite for the one-button contract. Tests to keep or adapt:
  - mobile → null;
  - operator route → `focusComposeStrip`, no machine transition, no latch;
  - state dot present/absent (no operator, no `SessionContext`);
  - click at rest opens the drawer and focus lands in the docked compose;
  - click while open re-focuses the docked compose and never reads as an outside click;
  - `aria-expanded` follows the machine; the accent edge follows `engaged`, not the machine;
  - the draft dot follows the shared store per server;
  - the tooltip copy (Ask / Start / unsent draft / no chord);
  - Esc releases to rest and restores the prior focus;
  - a blur alone never steps the machine;
  - invariant (a): a mouse-entered open holds `null` origin rather than the button;
  - `data-quake-terminal` present.

  Delete these cases: the md–lg / ≥lg / ≥2xl rung cases, the read-only box, Enter-send, the empty-Enter no-op, and image paste.
- **`app/frontend/src/components/top-bar.test.tsx`**: the launcher mounts in `top-bar-right`, not the center cell. It is leftmost, before `surface-toggles`, with a divider. It renders on all four modes on desktop and not on mobile. Overflow order: it overflows after Open/Layout/Refresh/Gear but before the surface toggles, and when overflowed an "Operator" row appears in the App section. There is only one operator row in the menu on desktop, and the mobile row is still present.
- **`app/frontend/src/lib/top-bar-overflow.test.ts`** (or the existing fit tests): unit cases for the compact-rung fit arithmetic and its hysteresis.
- **Playwright e2e**. Update every `quake-launcher-input` / `quake-launcher-ghost` / `quake-launcher-collapsed` reference to the single `quake-launcher` button:
  - `app/frontend/tests/e2e/quake-terminal.spec.ts` (~12 refs, incl. the `launcherInput` helper at ~297, the engaged-accent assertion at ~498, the ghost test at ~548, and the state-dot test at ~1828);
  - `app/frontend/tests/e2e/window-heading.spec.ts` (~116, ~158, ~169, ~742);
  - `app/frontend/tests/e2e/web-view-lens.spec.ts` (~640).

  Per Constitution § Test Intent Comments, each modified `test()` updates its JSDoc **Proves:** / **Steps:** block.
- **Demo recording** (Constitution § PR Evidence). Add a web-lane demo spec, e.g. `app/frontend/tests/demo/operator-button.demo.ts`, recorded via `just demo operator-button --before`, showing:
  - the button at rest in the right cluster;
  - click → drawer opens with the button latched;
  - click while open re-focuses the compose;
  - Esc closes;
  - the draft dot after typing an unsent draft;
  - a narrow desktop width showing the degradation ladder (labelled → glyph-only → "Operator" menu row).

  Desktop is verified at both widths (1280 and a narrow desktop such as 1024 or lower). The mobile viewport (375×812) must show the top bar unchanged: no launcher, and the chevron row still opens the operator route. No shell recording is needed: the diff does not touch `app/desktop/src/` or shell-only SPA paths.

## Affected Memory

- `run-kit/ui/quake-terminal`: (modify) Rewrite "Requirement: The quake launcher — standing affordance and collapsed control (desktop)" for the one-button contract, the right-cluster placement, the latch, the draft dot and the tooltips. Update "Requirement: Affordance pair — quake launcher (desktop) / tongue (mobile)", the compose-seam requirement's mention of the "standing launcher box", and the outside-click scenario wording. Supersede these Design Decisions:
  - "Desktop standing affordance is the quake launcher": its "Rejected: a separate right-cluster ◉ control — duplicate action and fit-budget cost" is now reversed.
  - "The short placeholder does not repeat the operator glyph".
  - "The ghost rung is md–lg-only".
  - "Compose docks in the drawer; the launcher is a launcher": keep the docking, drop the collapse-to-glyph clause.

  Record the new decision and the rejected A/C/D/E alternatives.
- `run-kit/ui/top-bar`: (modify) The center cell no longer hosts the launcher. The right cluster gains the launcher entry at its head (`dropLast`, all modes, divider, menu row, merged `quake-terminal` row). The `RegistryEntry` shape gains the compact rung, and the fit mechanics change accordingly. Update the terminal-mode end-state line ("Operator │ Surface toggles · Open · ▦ Layout · Refresh · Gear · chevron") and the description frontmatter ("center heading + … + quake launcher").
- `run-kit/ui/focus-ownership`: (modify) § The Quake Terminal's Own Focus Return. The invariant (a) capture now runs in the launcher button's component (wording: "standing input" → "button"). If an overflowed launcher unmounts the button, record where the capture effect lives.
- `run-kit/ui/compose-and-bottom-bar`: (modify) The subscriber list "(the quake terminal's docked compose and launcher box…)" becomes "docked compose and the launcher's draft dot".
- `run-kit/ui/dialogs-and-state`: (modify) The toast-placement rejection note lists "the rename heading, switcher and quake launcher live there [center]". Drop the launcher from that list.

## Impact

- **Code**:
  - `app/frontend/src/components/quake-launcher.tsx`: rewrite.
  - `app/frontend/src/components/top-bar.tsx`: center mount removed; registry entry + divider + the compact-rung plumbing in the probe/fit/visible render added; the `quake-terminal` menuOnly entry merged; comments updated.
  - `app/frontend/src/components/top-bar-overflow-menu.tsx`: `QuakeTerminalMenuRow` relabel/rework into the "Operator" row with the launcher's click semantics.
  - `app/frontend/src/lib/top-bar-overflow.ts`: compact-rung fit arithmetic.
  - `app/frontend/src/components/operator-state-glyph.tsx`: doc comment only (it lists "the quake launcher's standing box, ghost, and collapsed control").
  - `app/frontend/src/lib/quake-terminal.ts`, `lib/keybindings.ts` (~326), `lib/compose-draft-store.ts`: comments that describe the "launcher box" / "standing launcher" / "launcher input has focus".
  - Possibly `quake-terminal.tsx` (~179 comment).
- **Invariant (a) placement risk.** If the launcher's registry entry overflows, its `barRender()` is not mounted in the bar, while the probe copy is `inert` and off-screen. The `rest → open` restore-origin capture effect must not depend on the visible button being mounted. Two options: hoist it into an always-mounted host (e.g. a tiny always-rendered `QuakeLauncherFocusCapture` in TopBar, or the TopBar body), or keep it in a component that always renders. The probe copy must NOT also run the capture effect (double capture), and it must not render a duplicate `data-testid="quake-launcher"` that tests could match. Note: the probe's `inert` copy would also carry `data-quake-terminal`, which is harmless.
- **Probe duplication.** The probe renders every fit candidate's `barRender()`, so the launcher's hooks run twice (`useOperatorCompose`, `useKeybindings`, etc.). That is cheap, but the machine-following capture effect must not run in the probe copy (see above).
- **Docs (user-facing)**: `docs/site/skill/tutorial.md` line ~61 says "type into the quake launcher ("Ask…"), Enter sends". That is already inaccurate, and after this change it is wrong. Reword it to "click **Operator** (or ⌘J)". Check it against the toolkit standards (Constitution § Toolkit Standards; `shll standards`) because it is `docs/site/`.
- **Constitution V**: the palette already carries the `quake-terminal` action ("Quake terminal", ⌘J / ⇧Ctrl+J), so no new palette entry is needed. The button adds no new action.
- **Constitution IV**: no new route or surface. The change relocates and simplifies an existing control.
- **No backend, API, or desktop-shell changes.**
- **Control-gallery baselines**: if the new chip is added to `/__controls` or changes classes the Control primitive emits, `control-gallery.spec.ts` baselines are affected (code-quality.md § Verification). Not expected.

## Open Questions

_None — all resolved at clarify._

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Replace the ghost, standing input and collapsed control with ONE `<button>` that is the same element in every state; remove the `<input>`, Enter-send, paste upload, the `readOnly` branch and the `WIDE_RUNG_QUERY`/`EXTRA_WIDE_RUNG_QUERY` ladder. | Discussed: the user approved Option B; A/C/D/E were rejected with reasons. The removal list was given explicitly. | S:95 R:75 A:90 D:90 |
| 2 | Certain | The label is the fixed noun "Operator". The tooltip carries the verb: "Ask the operator (⌘J)", or "Start the operator (⌘J)" with no operator; a draft appends "unsent draft". | Discussed; specified verbatim by the user. | S:95 R:90 A:90 D:90 |
| 3 | Certain | Contents: `OperatorStateGlyph` (live dot, `quake-launcher-state` kept) + "Operator" + registry-effective chord keycap + draft dot when the shared compose draft is non-empty. | Discussed; specified by the user. The draft source is `useOperatorCompose(server, target)`, the same key as the docked strip. | S:90 R:85 A:85 D:85 |
| 4 | Certain | Click semantics are kept: rest → open; open → same-value re-assert + focus the docked compose (no close); operator route → `focusComposeStrip()` with no drawer. Esc and click-away close. | Discussed: the user said "keep today's semantics". Matches the current collapsed-control code. | S:90 R:85 A:90 D:90 |
| 5 | Certain | Keep invariant (a)'s `rest → open` restore-origin capture guarded by `isQuakeTerminalTarget`, `data-quake-terminal` on the control, and the same-value re-assertion. | Discussed: listed explicitly under "Keep". Documented in the focus-ownership memory. | S:95 R:70 A:90 D:90 |
| 6 | Certain | Move the button out of the center cell into the right cluster as its leftmost item, left of `SurfaceToggleGroup`, separated by a divider; it renders on all four modes, desktop only (mobile → null, mobile path unchanged). | Discussed: placement, divider and mode coverage were specified by the user. | S:95 R:70 A:85 D:90 |
| 7 | Confident | The registry entry is `dropLast` (not `pinned`) and sits at the registry head before `surface-toggles`. The fit-order tail becomes `[…, quake-launcher, surface-toggles]`, so the launcher overflows second-to-last, after Gear. | The user said "pinned or dropLast". `pinned` entries never produce menu rows and assume a single head entry, which conflicts with the required menu row. `orderForFit` is stable within the dropLast half. | S:70 R:80 A:80 D:65 |
| 8 | Confident | When the launcher is overflowed, its row is "Operator" + chord keycap in the `app` menu group, with the button's click semantics. | The user asked for an "Operator ⌘J" row. `app` is where the existing quake-terminal row lives. | S:70 R:90 A:75 D:70 |
| 9 | Certain | While open: `aria-expanded="true"` + an inset-well latch follow the machine `open` state; the green accent edge keeps today's focus-derived `engaged` rule (shown only while the docked compose owns focus). No `aria-pressed`: a click while open re-focuses, it does not toggle closed. | Clarified — user confirmed (accent only when focused; aria-expanded over aria-pressed). Preserves "chrome never claims focus it lacks". | S:95 R:80 A:90 D:90 |
| 10 | Certain | Fold the existing `menuOnly` "Quake terminal" App row into the launcher's registry entry (menuOnly on mobile; a dropLast fit candidate on desktop whose row appears only when overflowed), relabelled "Operator" on both form factors. Mobile behaviour unchanged; only the row label text changes. | Clarified — user confirmed (merge as "Operator"). Avoids two operator rows on desktop. | S:95 R:80 A:85 D:90 |
| 11 | Certain | The fold ladder has THREE in-bar rungs: `◉ Operator <chord>` (full) → `◉ Operator` (keycap dropped, label kept) → `◉` glyph-only (state dot + draft dot) → menu row. The accessible name stays "Operator" at every rung and the tooltip still names the chord. | Clarified after review — user confirmed adding the keycap-less rung: with the Linux `Shift+Ctrl+J` keycap the full button is 175px, so with the sidebar open the label only showed at ≥ ~1450px viewports and 1280–1440 saw glyph-only. | S:95 R:85 A:90 D:90 |
| 12 | Confident | Implement the two-width rung by extending `RegistryEntry` with an optional compact bar form. The probe measures both forms; the fit first tries the full form, and if not every candidate fits, retries with the compact form before dropping anything (fold-first per #19), with hysteresis on the way back (the `nextHeadRung` precedent). No self-measurement inside the launcher. | Verified in code: the fit is a tail-first greedy over probe-measured widths (`top-bar.tsx` measure effect, `computeVisibleCount`), and the probe is ResizeObserver-watched, so a self-folding child would feed back into its own measurement. A registry-level compact form keeps the probe static per form. Touches shared fit machinery: scoped to one optional field. | S:70 R:60 A:75 D:70 |
| 13 | Confident | The restore-origin capture effect must keep running when the launcher is overflowed or only exists in the inert probe. Host it in an always-mounted component, never in the probe copy. | Invariant (a) is load-bearing. The probe renders an `inert` duplicate of every fit candidate, and an overflowed entry has no visible mount. | S:55 R:70 A:70 D:60 |
| 14 | Confident | A divider is rendered whenever another in-bar control follows the launcher (the surface toggles on terminal mode, Refresh/Gear/board controls elsewhere) and omitted when nothing follows. | The stated purpose is to keep the button from reading as a tile toggle or part of the control group. Off terminal mode it still separates a viewer-level overlay from page controls. | S:50 R:90 A:60 D:55 |
| 15 | Confident | Single testid `data-testid="quake-launcher"` on the button; `quake-launcher-state` kept on the dot; add `quake-launcher-draft`; the `-input`/`-ghost`/`-collapsed` ids are retired. Unit and e2e tests are rewritten accordingly, with Test Intent JSDoc updated. | Follows existing testid conventions; Constitution § Test Intent Comments. | S:60 R:90 A:80 D:70 |
| 16 | Certain | PR evidence: a web-lane `just demo` spec (e.g. `operator-button`) with `--before`, covering rest/open/re-focus/Esc/draft dot/narrow-desktop degradation, plus a mobile viewport showing no change. No shell recording. | Constitution § PR Evidence: user-visible web UI change, no `app/desktop/src/` or shell-only paths touched. | S:70 R:90 A:85 D:75 |
| 17 | Confident | Update `docs/site/skill/tutorial.md` (~line 61: "type into the quake launcher ("Ask…"), Enter sends") to describe clicking **Operator** / ⌘J, checked against the toolkit standards. | The current tutorial text describes the removed input. `docs/site/` falls under Constitution § Toolkit Standards. | S:50 R:90 A:75 D:70 |
| 18 | Certain | No new palette action: the existing `quake-terminal` palette entry and ⌘J (⇧Ctrl+J) binding cover Constitution V. | Verified: `lib/keybindings.ts` registers `quake-terminal`, and the palette action exists. | S:80 R:95 A:90 D:90 |
| 19 | Certain | (#U1) The label → glyph-only fold happens FIRST — before any other right-cluster fit candidate overflows to the menu. | Clarified — user confirmed. The glyph, tooltip and ⌘J still identify the button, so Refresh/Gear stay in-bar longer. | S:95 R:75 A:90 D:90 |
| 20 | Certain | (#U2) The ≥`lg` heading keeps its compact form (no `PageType:` prefix restored); the freed center width goes to the breadcrumbs. | Clarified — user confirmed. | S:95 R:85 A:90 D:90 |

20 assumptions (8 certain, 6 confident, 4 tentative, 2 unresolved).
