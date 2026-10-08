# Plan: Web Tile Keyboard Capture

**Change**: 260925-964f-web-tile-keyboard-capture
**Intake**: `intake.md`

## Requirements

### Keyboard: Web Capture Latch

#### R1: A persisted web capture latch
A `rk-web-capture` localStorage flag SHALL hold the web capture state. It is read on boot, written on every toggle, and independent of `rk-gui-capture`. Storage failures SHALL degrade to "released".

#### R2: ⌘⇧G toggles web capture on a web surface
A `web-capture-toggle` builtin (⌘⇧G, `webOnly`, `ignoreInputs`) SHALL flip the latch. It SHALL NOT be reported as conflicting with `gui-capture-toggle`: different surface gates are disjoint.

- **GIVEN** a web tile is the active surface
- **WHEN** the user presses ⌘⇧G
- **THEN** web capture toggles and the gui latch is untouched

#### R3: Captured reclaim narrows to the release chord on both engines
While captured, the iframe engine's `shouldReclaimChord` SHALL match only the kind's release action. The native engine's chord table SHALL contain only the release binding's arms, with no focus-return Escape.

- **GIVEN** web capture is on
- **WHEN** the page has focus and the user presses ⌘K, ⌘F or Escape
- **THEN** the page receives the key and rk does not act
- **AND** ⌘⇧G is still reclaimed and releases capture

### Chrome

#### R4: Header capture button
The web tile HEADER SHALL render a keyboard-capture verb just before the Expand / ✕ layout verbs (tip "Keyboard capture" with the chord, `aria-pressed`, accent when on). It flips the latch. It SHALL render at any arity, only when the tile has a URL, and never on mobile. The URL bar SHALL carry no capture button.

#### R5: Header chip and palette verb
A captured web tile's header SHALL show a `keys → page` chip. The palette SHALL offer `Web: Capture keyboard` / `Web: Release keyboard` when the web tile has a URL.

## Tasks

- [x] T001 `lib/web-capture.ts` latch + `web-capture.test.ts` <!-- R1 -->
- [x] T002 `lib/keybindings.ts`: `web-capture-toggle` binding, kind-aware captured `hasReclaimableMatch`, `surfaceGate` disjointness in `findConflicts`; update `keybindings.test.ts` <!-- R2, R3 -->
- [x] T003 `lib/web-chord-table.ts`: `captured` narrowing + Escape drop; `web-chord-table.test.ts` captured suite <!-- R3 -->
- [x] T004 `app.tsx`: state, handler (`webGatedRun`), reclaim flag, palette verb, SurfaceLayout props <!-- R2, R3, R5 -->
- [x] T005 `surface-layout.tsx` header chip + prop forwarding; `iframe-window.tsx` button + captured chord table; `iframe-window.test.tsx` button tests <!-- R4, R5 -->
- [x] T006 Review fixes: `shouldRefuseTerminalChord` filters `webOnly` matches too (⇧Ctrl+G stays with a focused pane); the chord handler goes through `webGated` so it inherits the palette body's `hasWebUrl` gate; the toggle's native chord specs carry `keepFocus`, and desktop `chords.ts` (`findChord`) and `main.ts` skip the host focus hop for them, so flipping capture from inside the page leaves focus in the guest <!-- R2, R3 -->

## Acceptance

- [x] A-001 R1: latch round-trips and is independent of the gui latch
- [x] A-002 R2: `web-capture-toggle` is ⌘⇧G webOnly; `findConflicts` reports no web/gui clash
- [x] A-003 R3: captured `hasReclaimableMatch` for web matches only ⌘⇧G; captured chord table is exactly the release arms
- [x] A-004 R3: a remapped release binding is followed; an unbound one yields an empty table
- [x] A-005 R4: the header button sits in the same rail as Expand (before it), reflects `aria-pressed`, and calls `onWebCaptureChange(!on)`; it is absent on an onboarding tile, on mobile, and on non-web tiles
- [x] A-006 R5: chip renders only on a captured web tile; palette verb label follows state
- [x] A-007 Typecheck clean; full frontend vitest suite green; desktop `node --test` green
- [x] A-008 R2: ⇧Ctrl+G / ⇧⌘G under terminal focus are not refused
- [x] A-009 R3: the native toggle arms carry `keepFocus`; main skips the focus hop for them; a non-boolean `keepFocus` rejects the payload
