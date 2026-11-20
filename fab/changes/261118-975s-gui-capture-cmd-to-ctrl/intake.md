# Intake: GUI Keyboard Capture Sends Mac Cmd as Ctrl

**Change**: 261118-975s-gui-capture-cmd-to-ctrl
**Created**: 2026-11-18

## Origin

Conversational. Came out of a `/fab-discuss` deep-dive. The user reaches the GUI tile (noVNC → Xtigervnc + IceWM on display :10) from their local machine over Tailscale. They report that "keyboard events … copy-paste doesn't work", and that the existing keyboard capture (Ctrl/⌘+Shift+G) "does some level but it's not working properly".

What the discussion established from reading the code:
- Capture only narrows the canvas chord gate's reclaim set. While latched, every rk chord except the release chord falls through to noVNC.
- Capture never translates keys. noVNC 1.7.0 on macOS remaps `Super_L` (Cmd) → `Alt_L` (`core/input/keyboard.js` ~L142-148), so ⌘C reaches the Linux guest as **Alt+C**, with capture on or off.
- ⌘C/⌘V/⌘X were never rk chords, so capture has no effect on them at all.
- Clicking the pinned capture verb moves DOM focus onto that `<button>`, off the noVNC canvas. Keys typed afterwards hit the button, not the guest, and Space/Enter would re-toggle capture. Found by code reading; not confirmed in a browser.

User decisions:
- Asked "When should a Mac's Cmd key be sent to the remote desktop as Ctrl?" → **"Only while capture is on"**.
- Asked whether the clipboard bridge (local ↔ guest clipboard text) belongs in this change → answered "We are trying to capture every keyboard event, right?" Read as: this change makes capture deliver every keyboard event correctly. Clipboard *text* transport is not a keyboard event and stays out (see Assumptions #1).

> /fab-new (no description; scope from the preceding discussion): GUI keyboard capture: Mac Cmd→Ctrl while captured, capture verb must not steal focus from the desktop.

## Why

1. **Problem.** On a Mac, the GUI tile's keyboard capture promises "the keyboard belongs to the desktop". The user's fingers still produce ⌘C/⌘V/⌘A/⌘Z/⌘S/⌘F, and those arrive in Linux apps as Alt+letter. Alt+letter opens menus or does nothing, and Alt+drag moves windows in IceWM. Copy/paste *inside* the remote desktop therefore never works from Mac muscle memory, and capture, the feature meant to fix keyboard handoff, visibly doesn't. Separately, clicking the capture icon leaves keyboard focus on the icon. The first keys after turning capture on go nowhere until the user clicks into the desktop again.
2. **Consequence of not fixing.** Capture reads as broken. Users fall back to remembering the physical Ctrl key, which is the opposite of what a capture mode is for. The user's report of "keyboard events not going" persists.
3. **Why this approach.**
   - noVNC's Cmd→Alt shuffle is the right default for an *un*captured tile, because rk keeps ⌘ for its own chords. Capture is the explicit "desktop owns the keyboard" mode, so translating Cmd→Ctrl only while captured keeps the uncaptured behaviour unchanged. The user chose this over always-on.
   - Remapping the Cmd **modifier itself** (MetaLeft/MetaRight → Control_L) rather than rewriting each letter chord reuses noVNC's existing macOS meta-held path. That path already sends an immediate press+release for any key pressed while meta is held (`keyboard.js` ~L166-174), so every ⌘+key becomes Ctrl+key on the wire with no per-letter table.
   - Stopping the pinned verb from taking focus keeps the documented "noVNC grabs focus only on click, never programmatically" invariant, and needs no programmatic `rfb.focus()` call.

## What Changes

### 1. Cmd → Ctrl while captured (macOS only)

Where: the canvas wrapper's existing capture-phase key handling in `app/frontend/src/components/gui-surface.tsx`. Today `onKeyDownCapture` is at ~L956-976 and runs the chord gate first. Add a matching `onKeyUpCapture`.

Condition: capture latched **and** `detectPlatform() === "mac"` (`app/frontend/src/lib/keybindings.ts:546`, the existing UA probe). `GuiSurface` does not receive the capture flag today. `surface-layout.tsx` holds `guiCapture` (L1071) and passes it to the toolbar only. Thread it to `GuiSurface` as a prop, the way sibling posture props travel.

Behaviour while the condition holds:
- **Order in keydown:** the chord-gate reclaim check runs FIRST and is unchanged. A reclaimed chord (only ⌘⇧G under capture) is still re-dispatched to rk and never reaches noVNC.
- **keydown, `e.code` = `MetaLeft`/`MetaRight`:** `preventDefault()` + `stopPropagation()` (noVNC never sees the meta press). Send `rfb.sendKey(XK_Control_L /* 0xffe3 */, "ControlLeft", true)`. Track that Ctrl is held. Ignore auto-repeat (`e.repeat`).
- **keyup, `e.code` = `MetaLeft`/`MetaRight`:** stop the event. If Ctrl is tracked as held, send `rfb.sendKey(0xffe3, "ControlLeft", false)` and clear the tracking.
- **Every other key:** untouched. It flows to noVNC, whose macOS meta-held branch (`e.metaKey && code !== Meta*`) sends an immediate press+release of that key. With Control_L already down in the guest, that is Ctrl+key. Examples: ⌘C → Ctrl+C, ⌘V → Ctrl+V, ⌘⇧T → Ctrl+Shift+T only if Shift is held in the guest — noVNC taps a Shift pressed after ⌘, so the plan's R4 holds it explicitly.
- **Stuck-Ctrl guard:** if Ctrl is tracked as held, release it (send Control_L up) on any of:
  - window `blur` (⌘Tab: macOS never delivers the Meta keyup to the page);
  - `document.visibilitychange` → hidden;
  - the capture latch turning off;
  - the component unmounting or the RFB disconnecting.

  noVNC's own blur `_allKeysUp` only releases keys in *its* `_keyDownList`, which never contains our injected Ctrl.
- The Option/Alt key is NOT touched. It keeps noVNC's remap (Alt_L → Mode_switch).

Not changed:
- uncaptured behaviour (⌘ still → Alt_L via noVNC);
- non-Mac platforms;
- coarse pointers (capture is omitted there; touch input goes through the key bar);
- the reclaim predicate and `hasReclaimableMatch`.

A ⌘⇧G release while captured sends a bare Ctrl press+release to the guest (Meta down → Ctrl down; G reclaimed by rk; Meta up → Ctrl up). That is harmless and accepted.

### 2. The pinned capture verb never takes focus

`app/frontend/src/components/gui-toolbar.tsx` ~L589-605, the `data-testid="gui-capture-toggle"` button. Add `onMouseDown={(e) => e.preventDefault()}` so a pointer click toggles capture without moving DOM focus. If focus was on the noVNC canvas, it stays there and the next keystroke reaches the guest. Keyboard activation (Tab to the button, Enter/Space) still works because only mousedown is suppressed. Do not add any programmatic `rfb.focus()`.

The palette row (`GUI: Capture keyboard` / `GUI: Release keyboard`) is not changed by this item. The palette's own close-and-restore-focus behaviour applies. Apply should confirm by reading the code that restore returns focus to the canvas when the palette was opened from it. If it does not, record that as a finding rather than widening scope.

### 3. Tests

- Unit (vitest, via the `just` recipe; never run test runners directly): in the existing gui-surface test file, with a mocked RFB, `detectPlatform` → mac, and capture on:
  - MetaLeft down → `sendKey(0xffe3, "ControlLeft", true)`, and the event never reaches the noVNC mock;
  - MetaLeft up → the matching up;
  - window blur while held → up is sent;
  - capture off → no remap (Meta reaches noVNC);
  - non-mac → no remap;
  - ⌘⇧G still reclaimed and re-dispatched.
- Unit, gui-toolbar: mousedown on the capture verb is `defaultPrevented`.
- The constitution requires PR evidence for UI changes. Make the `just demo` before/after recordings of the capture toggle on desktop and mobile viewports. The behavioural difference is on-wire and needs a Mac browser, which the demo rig may not show. Say so in the PR.

## Affected Memory

- `run-kit/gui`: (modify) Requirement "Keyboard capture hands the gui chords to the guest". Add: on macOS, while latched, Cmd is sent to the guest as Control_L (released on blur/hide/unlatch); uncaptured Cmd keeps noVNC's Alt mapping. Add a scenario (⌘C while captured on a Mac → Ctrl+C in the guest). Add a Design Decision: modifier-level remap reusing noVNC's meta-held path, and why it is gated on capture.
- `run-kit/ui/lenses-and-layout`: (modify) § GUI Surface → Chord gate. Document the Meta→Control_L remap in the wrapper's keydown/keyup capture handlers, the stuck-Ctrl release triggers, and that the pinned capture verb suppresses mousedown focus.

## Impact

- `app/frontend/src/components/gui-surface.tsx`: new `capture` prop, keydown remap branch, `onKeyUpCapture`, blur/visibility/unlatch release effect.
- `app/frontend/src/components/surface-layout.tsx`: pass `guiCapture` to `GuiSurface`.
- `app/frontend/src/components/gui-toolbar.tsx`: capture verb `onMouseDown` preventDefault.
- Tests beside those components.
- No backend, no API, no keybinding-registry change, no new dependency. noVNC is not patched.

## Open Questions

- The user has not confirmed they are on a Mac. If they are on Windows or Linux, item 1 is a no-op for them and only item 2 helps. Their copy-paste symptom would then be the separate clipboard-transport problem.
- Clipboard transport (local clipboard → guest via `clipboardPasteFrom`, and guest → local via the RFB `clipboard` event, which needs a secure context and a user gesture) is deferred to a follow-up change.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Scope is keyboard delivery only (Cmd→Ctrl + capture verb focus); clipboard text transport is a separate follow-up change | Asked. The user replied "we are trying to capture every keyboard event, right?", which frames the change as keyboard events; clipboard text isn't one and needs a Safari spike | S:70 R:75 A:60 D:65 |
| 2 | Certain | Cmd→Ctrl applies only while the capture latch is on | Asked. The user chose "Only while capture is on" over always-on | S:95 R:85 A:90 D:90 |
| 3 | Confident | Remap at the modifier level (MetaLeft/Right ↔ Control_L via `rfb.sendKey`) and let noVNC's macOS meta-held press+release deliver the letter | noVNC's keyboard.js ~L166-174 already sends press+release for keys while meta is held; avoids a per-letter table | S:60 R:80 A:75 D:60 |
| 4 | Confident | Release the injected Ctrl on window blur, visibilitychange→hidden, unlatch, unmount/disconnect | macOS swallows the Meta keyup on ⌘Tab; noVNC's `_allKeysUp` doesn't know about the injected Ctrl | S:55 R:85 A:80 D:75 |
| 5 | Certain | Detect Mac with the existing `detectPlatform()` in lib/keybindings.ts | Existing keycap-platform probe; no new detection code | S:70 R:90 A:90 D:85 |
| 6 | Confident | Fix the focus trap by suppressing mousedown focus on the pinned capture verb, not by programmatic `rfb.focus()` | Keeps the documented "noVNC grabs focus only on click, never programmatically" invariant; one attribute | S:50 R:85 A:65 D:50 |
| 7 | Confident | ⌘⇧G release under capture sending a bare Ctrl press+release to the guest is acceptable | The reclaim check still runs first; a lone Ctrl tap is inert in X apps | S:60 R:85 A:80 D:80 |
| 8 | Confident | The Option/Alt key keeps noVNC's remap (Alt_L → Mode_switch) | Not part of the user's complaint; changing it would break AltGr-style input on Mac layouts | S:55 R:85 A:70 D:70 |
| 9 | Certain | Coarse pointers unaffected | Capture control is omitted on coarse pointers per gui.md | S:85 R:90 A:95 D:90 |
| 10 | Certain | Tests via vitest unit tests through `just` recipes; PR evidence via `just demo` per the constitution | Project rules: never run tests directly; UI changes need before/after recordings | S:70 R:85 A:90 D:85 |
| 11 | Confident | The user is on a Mac | Symptoms (Cmd copy/paste failing) match the noVNC Cmd→Alt remap; unconfirmed, and the change is a no-op elsewhere | S:40 R:90 A:50 D:70 |

11 assumptions (4 certain, 7 confident, 0 tentative, 0 unresolved).
