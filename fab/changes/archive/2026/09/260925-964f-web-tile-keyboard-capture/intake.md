# Intake: Web Tile Keyboard Capture

**Change**: 260925-964f-web-tile-keyboard-capture
**Created**: 2026-09-25

## Origin

> now what we need is the keyboard capture button on rk present as well like we have it on gui

Conversational origin. The orchestrating session proposed these defaults and the user approved them ("yes spin up build and ship the PR"):
- reuse ⌘⇧G as the toggle / release chord;
- scope the latch to the web kind, independent of the gui latch;
- mark a captured tile with a `keys → page` header chip, mirroring the gui tile's `keys → desktop`.

## Why

A gui tile has a keyboard-capture latch (`rk-gui-capture`, ⌘⇧G, toolbar button, `keys → desktop` header meta). While it is on, the lens-iframe reclaim narrows to the release chord alone, so the remote desktop receives every other chord. A web tile has no such latch. The present/web tile always reclaims every rk chord: ⌘K palette, ⌘F find, ⌘L address, pane chords, and in the native engine Escape. So a web app that binds those keys (an IDE, a terminal-in-browser, a design tool) never receives them. Users need the same "hand every key to the page" switch on the web tile.

## What Changes

- **Latch:** a new `rk-web-capture` localStorage flag (`app/frontend/src/lib/web-capture.ts`, `readWebCapture`/`writeWebCapture`). It is owned by `app.tsx` state, like `guiCapture`.
- **Binding:** a new `web-capture-toggle` builtin (⌘⇧G, `webOnly`, `ignoreInputs`, label "Keyboard capture"). The dispatcher runs the first matching binding whose handler is present, and each capture toggle's handler exists only on its own surface. So it shares ⌘⇧G with `gui-capture-toggle` (`guiOnly`) without a real clash. `findConflicts` generalizes its tty↔web gate exemption to cover any two different surface gates.
- **Iframe engine:** `hasReclaimableMatch(..., captured)` narrows to the kind's release action (`web-capture-toggle` for web, `gui-capture-toggle` for gui). `reclaimChordForKind` passes `webCapture` for kind `web`.
- **Native engine:** `buildWebChordTable(bindings, captured)`. When captured, the table holds only the release binding's arms and drops the focus-return Escape. It re-uploads through the existing `web:chords` effect whenever the table changes.
- **Chrome:** a keyboard-glyph verb in the web tile HEADER, beside the Expand / ✕ verbs. It has a "Keyboard capture" tip with the chord, uses `aria-pressed`, and turns accent-green when on. The first cut placed it in the URL bar next to Find; the user tested that and asked for the header instead.
- **Tile header:** a `keys → page` chip while captured.
- **Palette:** a `Web: Capture keyboard` / `Web: Release keyboard` verb, available when the web tile has a URL.

## Affected Memory

- `run-kit/ui/keyboard-and-palette`: (modify) web-capture-toggle binding, surface-gate conflict exemption, captured reclaim per kind
- `run-kit/ui/lenses-and-layout`: (modify) web tile capture button, header chip, native chord-table narrowing

## Impact

Frontend: `app.tsx`, `surface-layout.tsx`, `iframe-window.tsx`, `lib/keybindings.ts`, `lib/web-chord-table.ts`, the new `lib/web-capture.ts`, and tests. Desktop: `chords.ts` and `main.ts` gain an optional `keepFocus` chord-spec field, which skips the host focus hop for the capture toggle. It is backward compatible both ways: an older shell ignores the field. No backend changes and no new IPC channel; the native path reuses `web:chords`.

## Open Questions

None.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Reuse ⌘⇧G for the web capture toggle | Discussed — user approved the default; gates are disjoint | S:90 R:85 A:90 D:90 |
| 2 | Certain | Latch is kind-scoped (`rk-web-capture`), independent of `rk-gui-capture` | Discussed — user approved | S:90 R:90 A:90 D:85 |
| 3 | Certain | Header chip reads `keys → page` | Discussed — user approved; mirrors `keys → desktop` | S:90 R:95 A:90 D:90 |
| 4 | Confident | Native engine drops the focus-return Escape while captured | "Every chord to the page" includes Escape; ⌘⇧G still releases | S:70 R:85 A:75 D:70 |
| 5 | Confident | Latch is global across web tiles, not per tile | Matches the gui latch's global shape; simplest | S:65 R:80 A:75 D:70 |
