# Intake: Navigation Chords Fire from the Compose Textarea

**Change**: 260914-88is-compose-strip-nav-chords
**Created**: 2026-09-14

## Origin

Promptless dispatch from `/fab-proceed`, synthesized from a diagnostic conversation (no questions asked; every would-be question is a deferred Unresolved row in § Assumptions — there are none).

> **Title idea:** Navigation chords fire from the compose textarea (tab/session/history nav no longer dead after landing in the strip).
>
> **Problem.** Since PR #972 (compose strip on by default, focus on fresh navigation), Cmd+↑ / Cmd+↓ tab browsing dies after one or two presses. Root cause, verified in code: `window-prev`/`window-next`, `session-prev`/`session-next`, `go-back`/`go-forward` are ordinary bindings WITHOUT `ignoreInputs`; `useKeybindingDispatch` skips any non-`ignoreInputs` match when `shouldSuppressChord(e.target)` is true — true for INPUT/TEXTAREA/contentEditable, with only the `.xterm` carve-out; the restore router in `app.tsx` (`restoreFocus` / `firstVisitKind`) now lands first-visit focus in the compose strip's textarea when the strip is on. So: press Cmd+↓ from xterm → navigate → focus lands in the compose textarea of the new window → next Cmd+↓ targets a TEXTAREA → suppressed → browser does its native caret-to-document-end. The user experiences "focus stuck in the compose box, shortcuts stop working". Before #972 the strip was off by default, navigation landed in xterm, chords fired — so this is a regression of #972.
>
> **Decided fix.** Add `ignoreInputs: true` to six bindings in `DEFAULT_BINDINGS`: `window-prev`, `window-next`, `session-prev`, `session-next`, `go-back`, `go-forward`. The compose strip's own `onKeyDown` already lets modifier-arrows fall through untouched, so nothing in `compose-strip.tsx` changes. The user explicitly confirmed including go-back/go-forward.
>
> **Alternative rejected.** Adding the compose textarea to the `.xterm`-style carve-out inside `shouldSuppressChord` — it would let EVERY non-ignoreInputs global chord fire inside the strip, and `focusIsEngaged` reuses `shouldSuppressChord`, so the restore router would stop treating the strip as an engaged surface.
>
> **Accepted side exposure.** `ignoreInputs` fires in every input, including the palette input and dialog fields. ⌘B/sidebar-toggle has the identical exposure today; accepted rather than building a compose-only predicate.
>
> **Tests.** Unit assertions on the six rows; a dispatch-hook case for `window-next` in a TEXTAREA; one Playwright e2e pressing the platform window-next chord from the focused compose textarea and asserting the route changes. **Memory/docs impact.** The shortcut table rows, the `ignoreInputs` punch-through prose in two memory files (disjointness re-verified), optionally a sentence in focus-ownership. **Constraints.** Constitution V; frontend-only; change type `fix`; light lane expected.

Interaction mode: one-shot dispatch. Key decisions were made in the preceding conversation and are recorded verbatim in § What Changes and § Assumptions.

## Why

**The pain.** With the compose strip on by default (its shipped default since #972), a fresh desktop navigation to a window lands keyboard focus in the strip's `<textarea>`. Every navigation chord — ⌘↑/⌘↓ (`window-prev`/`window-next`, Linux ⇧Ctrl+↑/↓), ⇧⌘↑/⇧⌘↓ (`session-prev`/`session-next`, Linux ⇧Ctrl+←/→), ⌘[/⌘] (`go-back`/`go-forward`, Linux ⇧Ctrl+[ ]) — is an ordinary registry binding, so `useKeybindingDispatch` (`app/frontend/src/hooks/use-keybinding-dispatch.ts:54`, `if (!binding.ignoreInputs && shouldSuppressChord(e.target)) continue;`) suppresses it while the textarea owns focus. The first press from an xterm works (xterm is the `.xterm` carve-out in `shouldSuppressChord`); it navigates; the restore router's `firstVisitKind()` resolves `compose`; the second press targets the textarea and is swallowed — the browser performs its native caret jump instead. Tab browsing with the arrow chords, the primary keyboard way to walk the sidebar (Constitution V), works for exactly one step.

**The consequence of not fixing it.** Keyboard-first navigation is broken in the default configuration for every desktop user: "focus stuck in the compose box, shortcuts stop working". The only recoveries are Escape (hands focus to the terminal) before every chord, or turning the strip off — undoing #972's default.

**Why this approach.** The registry already has a per-binding punch-through mechanism, `ignoreInputs`, used by `compose-toggle`, `sidebar-toggle`, `quake-terminal`, `tty/code/web/gui-toggle`, `zen-toggle`, `command-palette`, `settings-open`, `shortcuts-overlay`, `web-find`/`terminal-find`, `web-address`, the gui-zoom trio and `gui-capture-toggle`. The recorded rationale for that family (memory `keyboard-and-palette.md` § Stateful surface chords) is exactly the one that applies here: "chrome toggles are modifier combos that never insert text, so they stay live inside real text inputs — the compose strip's textarea in particular." Navigation chords are the same class — modifier combos with no editing meaning worth preserving in a short compose draft (⌘↑ caret-to-top-of-draft is the one loss, the same trade xterm users already accept). Opting the six rows in keeps the blast radius to navigation; the rejected alternative (a compose carve-out in `shouldSuppressChord`) would (a) let every global chord fire inside the strip and (b) break `focusIsEngaged` (`lib/keybindings.ts:1053-1060`), which reuses `shouldSuppressChord` so the restore router's first-visit compose arm treats a focused strip as an engaged surface it must not steal from.

## What Changes

### 1. Registry — six `DEFAULT_BINDINGS` rows gain `ignoreInputs: true`

File: `app/frontend/src/lib/keybindings.ts`, the arrow/history block at lines 278–283 (current text):

```ts
{ actionId: "window-prev", code: "ArrowUp", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Previous tab", mapLabel: "prev tab" },
{ actionId: "window-next", code: "ArrowDown", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Next tab", mapLabel: "next tab" },
{ actionId: "session-prev", code: "ArrowLeft", tier: "shifted", macCode: "ArrowUp", scope: "global", kind: "builtin", label: "Previous session", description: "jump to the adjacent session's active window", mapLabel: "prev session" },
{ actionId: "session-next", code: "ArrowRight", tier: "shifted", macCode: "ArrowDown", scope: "global", kind: "builtin", label: "Next session", description: "jump to the adjacent session's active window", mapLabel: "next session" },
{ actionId: "go-back", code: "BracketLeft", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Back", description: "history", mapLabel: "back" },
{ actionId: "go-forward", code: "BracketRight", tier: "shifted", macTier: "cmd", scope: "global", kind: "builtin", label: "Forward", description: "history", mapLabel: "fwd" },
```

Each of the six rows appends `ignoreInputs: true` (matching the field's placement on sibling rows such as `sidebar-toggle` line 307 and `compose-toggle` line 240). No other field changes: codes, tiers, `macTier`/`macCode` refinements, scope, labels, descriptions and `mapLabel`s are untouched, so the mac demotions, the tier-disjointness of the window/session pairs, and the shortcuts panel rendering are unaffected.

The block's leading comment (lines 264–277, the arrow-key navigation rationale) gains a short constraint statement of the non-obvious why — e.g. that the six rows carry `ignoreInputs` because the desktop restore router lands first-visit focus in the compose textarea, so a navigation chord's natural next press targets a TEXTAREA and would otherwise be suppressed after one step; navigation chords have no editing meaning worth preserving in a compose draft. Per `fab/project/code-quality.md` the comment states the constraint, and does NOT cite change IDs or PR numbers.

Two adjacent doc comments name `ignoreInputs` examples and should be refreshed so they do not read as an exhaustive list: the `ignoreInputs?: boolean` field JSDoc (lines 99–102, "⌘K keeps its historical everywhere-behavior … everything else goes through `shouldSuppressChord`") and the `shouldSuppressChord` JSDoc (lines 1023–1030, "Bindings with `ignoreInputs` (⌘K, the overlay toggle) skip this predicate entirely"). Wording is the implementer's; they must stop implying ⌘K/the overlay are the only members.

### 2. No change to the dispatcher, the suppression predicate, or the compose strip

- `app/frontend/src/hooks/use-keybinding-dispatch.ts` — unchanged. Its existing rule 4 ("a suppressed match YIELDS to later matches … so a shared-chord `ignoreInputs` binding still fires inside inputs instead of being shadowed by a suppressed higher-precedence match") is what makes the fix work without touching dispatch.
- `shouldSuppressChord` / `focusIsEngaged` (`lib/keybindings.ts:1031-1060`) — unchanged (the rejected alternative).
- `app/frontend/src/components/compose-strip.tsx` — unchanged. Its `onKeyDown` (lines 848–915) consumes only: Escape; the five readline chords via `handleReadlineKey` (Ctrl+U, Ctrl+W, Alt+B, Alt+F, Alt+D — exact-modifier: Meta or Shift anywhere → unhandled); BARE ↑/↓ for sent-history recall (`bareArrow` requires `!shiftKey && !altKey && !metaKey && !ctrlKey`); and Enter via `classifyComposeEnter`. ⌘↑/⌘↓, ⇧⌘↑/⇧⌘↓, ⇧Ctrl+arrows, ⌘[/⌘] and ⇧Ctrl+[/] all fall through to the window-level dispatcher, where the new `ignoreInputs` lets them fire.
- `app.tsx` restore router (`restoreFocus` lines 1749–1798, `firstVisitKind` 1805–1807) — unchanged. After a chord navigates, the per-window restore effect arms for the new window and lands first-visit focus in the new window's compose textarea again; with the fix the next chord fires from there, so repeated presses walk the list.

### 3. Behavioral consequences to record (not to change)

- **Repeated tab/session/history chords work from the compose textarea** on desktop with the strip on — the user-visible fix.
- **Every text input is exposed**, not just the compose strip: the palette input, the settings dialog's fields, the create-session dialog's name field (e.g. ⌘↓ there switches the tab behind the dialog), the web tile's address bar, the FindBar inputs. This is the accepted trade — identical to today's `sidebar-toggle`/`quake-terminal`/tile-toggle exposure — rather than a compose-only predicate.
- **Lost editing motions in the compose draft**: ⌘↑/⌘↓ (mac document start/end), ⇧⌘↑/⇧⌘↓ (mac select-to-document-start/end), ⇧Ctrl+↑/↓/←/→ on Linux (select-to-paragraph / select-word in some desktops), and the bracket chords (no native editing meaning). Accepted; a compose draft is short.
- **Mac board route, compose textarea focused, ⌘[ / ⌘]**: `board-cycle-prev`/`board-cycle-next` (`scope: "board"`, `tier: "cmd"`, lines 408–409, NO `ignoreInputs`) share ⌘[/⌘] with `go-back`/`go-forward` on mac. `findMatches` orders the board-scoped pair first; under a focused textarea that match is suppressed and — by dispatcher rule 4 — yields, so the global `go-back`/`go-forward` now fires history navigation from the board's compose box (today the chord is dead there; blurred, it still pane-cycles as before). This is a new consequence surfaced during intake, in the same class as the accepted exposure; it is recorded in § Assumptions and must be stated in the memory update (§ 5) so it is not later mistaken for a bug. On Linux the pair is tier-disjoint (`Ctrl+[` vs `⇧Ctrl+[`), so nothing changes there.

### 4. Tests

**Unit — `app/frontend/src/lib/keybindings.test.ts`.** The existing full-row `toEqual` assertions for the window pair (lines 607–661, "window-prev/window-next: ⇧Ctrl+↑/↓ base with a ⌘↑/⌘↓ mac demotion in BOTH mac hosts") and the session pair (lines 663–735) compare the whole `DEFAULT_BINDINGS` row and MUST gain `ignoreInputs: true` or they fail. Add one dedicated assertion, in the style of line 766 (`expect(byId(resolved(), "command-palette").ignoreInputs).toBe(true)`), that iterates the six actionIds `["window-prev","window-next","session-prev","session-next","go-back","go-forward"]` and asserts `ignoreInputs` is `true` on each resolved binding — the set as a contract, so a future row edit that drops the flag fails loudly. If a full-row assertion exists for `go-back`/`go-forward`, update it likewise.

**Unit — `app/frontend/src/hooks/use-keybinding-dispatch.test.ts`.** Existing cases prove `ignoreInputs` fires in an `<input>` (line 53, `shortcuts-overlay`) and in a `<textarea>` for `compose-toggle` (line 62) and the tile digits (line 77), each through the real `DEFAULT_BINDINGS` row. Add a sibling case for the navigation family: mount `useKeybindingDispatch({ "window-next": handler })` (optionally all six handlers in the tile-digit loop style), create + focus a `<textarea>`, dispatch `press({ code: "ArrowDown", shiftKey: true, ctrlKey: true }, textarea)` (the Linux/base face — jsdom is a non-mac host, see `press` helper lines 6–13), assert the handler ran once and `event.defaultPrevented` is `true`. For the bracket pair use `code: "BracketLeft"/"BracketRight"` with the same modifiers; for the session pair `ArrowLeft`/`ArrowRight`.

**e2e — one Playwright test.** Requirements:
- Precondition: the compose strip is ON and its textarea owns focus (`expectActiveElement(page, "compose")` from `tests/e2e/_ready.ts:175`).
- Action: press the platform window-next chord. The e2e rig runs on Linux with Playwright's Desktop Chrome (Windows UA — the win/linux face), so the chord is `Shift+Control+ArrowDown` (mac would be `Meta+ArrowDown`).
- Assertion: the route's window changes (`expect(page).toHaveURL(...)` — the pattern at `shortcut-registry.spec.ts:149-158`), THEN the textarea is focused again on the new window (`expectActiveElement(page, "compose")`), THEN a second `Shift+Control+ArrowDown` changes the window again. The second press is the regression under test — a single press already worked before this change.
- Placement (implementer's call, see Assumptions #6): preferred host is `app/frontend/tests/e2e/compose-strip.spec.ts` inside the existing `test.describe("on by default", …)` block (line ~1117), whose fixture is exactly "no seed → strip on → fresh navigation lands focus in the textarea" against the real tmux backend (`TERM_SESSION` one `cat` window + `BOARD_SESSION` two windows exist from `beforeAll`, so the flattened list has ≥ 3 rows and a next-window target always exists; assert the URL leaves the starting window rather than naming a fixed target). The alternative host, `shortcut-registry.spec.ts`, has the deterministic 3-window mock and the exact `/default/2` URL pattern but a file-level `beforeEach` that seeds the strip OFF (lines 125–130) precisely because of this bug; a test there must override that seed — note `seedComposeStrip` writes only when the key is ABSENT (`_ready.ts:196-207`), so a nested `seedComposeStrip(page, true)` after the file-level `false` is a no-op; use a direct `page.addInitScript` that sets `runkit-compose-strip` to `"true"`, or restructure the describe. The file-level comment there (lines 124–127) also needs rewording once nav chords fire from the textarea (the opt-out is then about the other chords, e.g. `create-window`, `kill-window`, splits).
- Every new `test()` MUST carry the Proves/Steps JSDoc (Constitution § Test Intent Comments); if the e2e lands in `compose-strip.spec.ts`, its file-header comment gains a clause for the nav-chord coverage.
- Run single specs only: `just test-e2e compose-strip.spec` (pass `<name>.spec`; `pnpm install --frozen-lockfile` in `app/frontend` first if `node_modules` is missing), and `just test-frontend` for the unit lanes.

### 5. Memory updates (hydrate)

- `docs/memory/run-kit/ui/keyboard-and-palette.md`
  - § The default binding set, table rows for ↑ `window-prev`, ↓ `window-next`, ← `session-prev`, → `session-next`, [ `go-back`, ] `go-forward` (lines 39–44): append `(`ignoreInputs`)` to each row's description, matching the sibling rows' annotation style (e.g. line 49 `Toggle sidebar (`ignoreInputs`)`).
  - Line 65 (the arrow-pairs paragraph): add the punch-through statement and its reason — the desktop first-visit focus lands in the compose textarea, so navigation chords must fire from a real text input to walk more than one step; the loss is the native ⌘↑/⌘↓ caret jumps inside a draft.
  - § Dispatch seams, `shouldSuppressChord` bullet (line ~185): the enumerated `ignoreInputs` set ("⌘K, the shortcuts toggle, `settings-open`, the find/address openers, and the whole surface-toggle family…") gains the navigation family (the two arrow pairs and the history pair).
  - § Scope precedence — scoped beats global (lines 198–203): add the mac board-route consequence from § 3 (a focused compose textarea suppresses the board-scoped pane-cycle match, which yields to the `ignoreInputs` global history pair).
  - § Design Decisions: one new decision, e.g. "Navigation chords punch through text inputs via per-binding `ignoreInputs`, not a compose carve-out in `shouldSuppressChord`" — Decision / Rationale (blast radius; `focusIsEngaged` reuse) / Alternative rejected.
- `docs/memory/run-kit/ui/compose-and-bottom-bar.md`, § Readline editing chords (line 62): the sentence "the `ignoreInputs` punch-through set (⌘K, ⌘I, ⇧⌘/, ⇧⌘,, ⇧⌘⏎, the find/address openers, ⌘B, and the ⌘1/2/3 tile digits) does not collide — every member is exact-modifier disjoint from the five readline chords" must list the six new members and the disjointness re-verified. Verification (done at intake): the readline chords are Ctrl+U, Ctrl+W (Ctrl, no Shift/Meta/Alt) and Alt+B, Alt+F, Alt+D (Alt, no Ctrl/Shift/Meta); the six new members are ⌘↑/⌘↓ (Meta), ⇧⌘↑/⇧⌘↓ (Shift+Meta), ⌘[/⌘] (Meta) on mac and ⇧Ctrl+↑/↓/←/→, ⇧Ctrl+[/] (Shift+Ctrl) on Win/Linux — every one carries Meta or Shift, which `classifyReadlineKey` treats as "unhandled", and none shares a key code with U/W/B/F/D. Disjoint.
- `docs/memory/run-kit/ui/focus-ownership.md`, § Restore Router (line 35): one sentence stating that the first-visit compose landing is what makes navigation chords `ignoreInputs` — the strip is the default keyboard surface, so chords that move between windows must fire from it (cross-reference to keyboard-and-palette).

### 6. Out of scope

- No palette change: no new action is introduced, so Constitution V parity is already satisfied (the six actions have palette entries `Tab: Previous/Next`, `Session: Previous/Next`, back/forward) and `operator-compose.spec`'s palette entry count is unaffected.
- No change to other global non-`ignoreInputs` chords (`agent-next-waiting`, `host-menu-open`, `create-window`, `kill-window`, the split pair, `board-cycle-*`) — the decided set is the six navigation rows only.
- No backend change.

## Affected Memory

- `run-kit/ui/keyboard-and-palette`: (modify) six shortcut-table rows gain the `(ignoreInputs)` tag; arrow-pairs paragraph and the Dispatch-seams `ignoreInputs` enumeration gain the navigation family; Scope-precedence gains the mac board-route yield consequence; one new Design Decision
- `run-kit/ui/compose-and-bottom-bar`: (modify) § Readline editing chords — extend the `ignoreInputs` punch-through set with the six navigation chords and restate the re-verified exact-modifier disjointness
- `run-kit/ui/focus-ownership`: (modify) § Restore Router — one sentence on why the first-visit compose landing requires navigation chords to punch through the strip

## Impact

- **Code**: `app/frontend/src/lib/keybindings.ts` (six rows + two doc comments + one block comment). Frontend-only; no backend, no API, no dependency change.
- **Tests**: `app/frontend/src/lib/keybindings.test.ts` (two existing full-row blocks updated, one new set assertion), `app/frontend/src/hooks/use-keybinding-dispatch.test.ts` (one new textarea case), one new Playwright `test()` in `app/frontend/tests/e2e/compose-strip.spec.ts` (or `shortcut-registry.spec.ts` with its seed/comment adjusted).
- **Runtime behavior**: navigation chords fire inside every real text input (compose strip, palette input, dialog fields, address bar, find bars); the native caret/selection motions those chords meant inside a textarea are lost there; on mac's board route, ⌘[/⌘] from the compose textarea runs history navigation instead of nothing.
- **Docs**: three memory files (above). No spec change (`docs/specs/` has no shortcut registry spec).
- **Constitution**: V (keyboard-first — restores it); Test Intent Comments (the new e2e test's JSDoc); code-quality comment rule (no PR numbers in the new code comment).
- **Lane**: small — expect the light lane.

## Open Questions

None — the fix, its scope (six bindings, go-back/go-forward included), the rejected alternative and the accepted exposure were all decided in the conversation.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Fix is `ignoreInputs: true` on exactly six `DEFAULT_BINDINGS` rows — `window-prev`, `window-next`, `session-prev`, `session-next`, `go-back`, `go-forward` — and nothing else in the registry changes | Discussed — user decided the set and explicitly confirmed including `go-back`/`go-forward`; the field is the registry's existing punch-through mechanism on 17 sibling rows | S:95 R:90 A:95 D:95 |
| 2 | Certain | `shouldSuppressChord`, `focusIsEngaged`, `useKeybindingDispatch` and `compose-strip.tsx` are NOT modified | Discussed — the compose carve-out alternative was rejected (blast radius; `focusIsEngaged` reuses the predicate); verified `compose-strip.tsx` `onKeyDown` only intercepts bare arrows / exact-modifier readline chords, so modifier chords already fall through | S:90 R:90 A:95 D:90 |
| 3 | Certain | Change type is `fix` (regression of the compose-on-by-default default); frontend-only, no palette or backend change | Discussed — user named the type; no new action so Constitution V parity needs no palette work | S:95 R:95 A:95 D:95 |
| 4 | Certain | The wider exposure — nav chords firing in the palette input, dialog fields (e.g. create-session name), address bar and find bars, and the loss of native ⌘↑/⌘↓/⇧⌘↑/⇧⌘↓ caret motions inside a draft — is accepted as-is; no compose-only predicate | Discussed — user accepted, citing `sidebar-toggle`'s identical exposure today | S:85 R:85 A:80 D:80 |
| 5 | Confident | On mac's board route, ⌘[/⌘] pressed inside the compose textarea now runs `go-back`/`go-forward` (the suppressed board-scoped `board-cycle-*` match yields to the `ignoreInputs` global); this is recorded in memory, not special-cased | New finding at intake (not in the conversation) but in the same class as the accepted exposure in #4; follows the dispatcher's documented yield rule; trivially reversible by adding `ignoreInputs` to the board pair or a scoped exception later | S:40 R:85 A:65 D:60 |
| 6 | Confident | The e2e test lives in `compose-strip.spec.ts`'s "on by default" describe (real backend, fixture already lands focus in the textarea; assert the URL leaves the starting window, refocus lands in the strip, second press moves again); `shortcut-registry.spec.ts` is the fallback and would need its file-level off-seed overridden via a direct `addInitScript` and its header comment reworded | Description delegated placement to "whichever hosts the chord-in-textarea pattern"; compose-strip.spec hosts the first-visit-focus fixture, and the seed-ordering pitfall in shortcut-registry is verified in `_ready.ts` (`seedComposeStrip` writes only when the key is absent) | S:65 R:90 A:80 D:65 |
| 7 | Certain | Unit coverage: update the two full-row `toEqual` blocks (window pair, session pair) in `keybindings.test.ts`, add one set-level `ignoreInputs` assertion over the six ids, and add one `use-keybinding-dispatch.test.ts` case pressing `Shift+Ctrl+ArrowDown` (base face) in a focused `<textarea>` with `defaultPrevented` asserted | Existing tests would fail without the row updates (verified: `toEqual` on the full row); the textarea-case style is already present for `compose-toggle` and the tile digits; the description asked for a `window-next` textarea case if not covered (it is not) | S:80 R:95 A:90 D:85 |
| 8 | Certain | Three memory files change (keyboard-and-palette, compose-and-bottom-bar, focus-ownership) per § 5, including a new Design Decision in keyboard-and-palette and the mac board-route consequence in § Scope precedence; the readline disjointness holds (every new member carries Meta or Shift; no shared key code) | Description named the first two files and said focus-ownership "may warrant" a sentence; disjointness verified at intake against `classifyReadlineKey`'s exact-modifier rule | S:80 R:95 A:90 D:80 |
| 9 | Certain | The `ignoreInputs` field JSDoc and the `shouldSuppressChord` JSDoc in `keybindings.ts` are reworded so they no longer read as an exhaustive "⌘K + overlay" list; the arrow-block comment gains the constraint (no PR/change IDs) | Not discussed; follows `code-quality.md`'s comment rule (state constraints, never cite PR numbers) and keeps the registry's inline documentation truthful; reversible | S:55 R:95 A:85 D:80 |

9 assumptions (7 certain, 2 confident, 0 tentative, 0 unresolved).
