# Intake: GUI Keyboard Capture — Hand rk's Chords to the Guest Desktop

**Change**: 260912-31eg-gui-keyboard-capture
**Created**: 2026-09-12

## Origin

Conversational design session (natural-language input, no Linear ticket, no backlog ID). The user
worked through the full design and settled thirteen numbered decisions (C1–C13) plus the rejected
alternatives for each. This intake was drafted in DRAFT mode (`/fab-draft` semantics): the change is
created UNACTIVATED, no branch, no pointer move — a different change
(`260912-lut4-gui-toolbar-header-fold`) was mid-pipeline with a live apply worker at the time of
writing.

> **GUI keyboard capture — hand rk's chords to the guest desktop.**
>
> The gui tile's chord gate means rk wins ~25 keyboard chords before noVNC ever sees them, so they
> never reach the guest desktop. `gui-surface.tsx`'s canvas wrapper runs a capture-phase
> `onKeyDownCapture` that asks `hasReclaimableMatch(e, bindings, "gui")`; true ⇒ `preventDefault` +
> `stopPropagation` + re-dispatch a synthetic bubbling `KeyboardEvent` on `document` so rk's
> window-level dispatcher fires; false ⇒ the key falls through to noVNC's canvas handler and onto
> the wire. Everything that is not `ttyOnly`/`webOnly` is reclaimed. The concrete complaint: pressing
> ⌘K while working in the guest desktop opens rk's command palette instead of reaching the desktop.
>
> The fix is a **keyboard capture** toggle. While latched, the chord gate passes everything to the
> guest except one reserved release binding.

**Interaction mode**: conversational — every decision below was settled with the user, including the
options explicitly rejected. This intake was generated with **zero questions asked**; every genuine
gap found while verifying the design against the tree is recorded as a graded SRAD assumption
instead (rows 14–18).

**Every code anchor in this intake was verified against the working tree on 2026-09-12** and is
cited `file:line`. Two caveats on line numbers:

- `app/frontend/src/components/surface-layout.tsx` and
  `app/frontend/src/components/gui-toolbar.tsx` are being rewritten **right now** by the dependency
  change's apply worker, so their line numbers WILL move. Anchors in those two files are cited by
  **symbol** wherever possible.
- `app/frontend/src/lib/gui-toolbar-fold.ts` is an **untracked, in-flight** file created by the
  dependency change. It is cited because it is the authoritative statement of the pinned-block
  contract this change depends on.

---

## DEPENDENCY — READ FIRST

This change **builds on `260912-lut4-gui-toolbar-header-fold`**, which at the time of writing is
**in flight, not landed** (its apply worker is live; its branch is `260912-lut4-gui-toolbar-header-fold`).

That change moves the gui toolbar out of the floating pill and into the tile header as a
width-adaptive **measured fold**, and creates a **pinned block** — controls that never fold, whose
measured width is reserved from the fit budget BEFORE any ladder item is placed. It reserves that
block containing only the `⚙` overflow toggle, explicitly so this change has a slot to drop into.
Its intake states the scope boundary verbatim:

> This change MUST build the pinned-block plumbing (a measured, reserved slot that never folds)
> containing only the `⚙` overflow toggle, so the capture control can drop into an already-reserved
> slot later. This change MUST NOT implement keyboard capture, the `gui-capture-toggle` binding, or
> the `rk-gui-capture` storage key.
> — `fab/changes/260912-lut4-gui-toolbar-header-fold/intake.md` § Origin

The pinned-block contract, as already implemented in the in-flight
`app/frontend/src/lib/gui-toolbar-fold.ts`:

```
gui-toolbar-fold.ts:18  The `⚙` pinned block is conditional (D3 × D4): the fit runs TWO passes —
gui-toolbar-fold.ts:20  renders, and nothing is reserved; otherwise re-fit with the pinned block's
gui-toolbar-fold.ts:21  measured width reserved BEFORE any ladder item. The reserve therefore never
gui-toolbar-fold.ts:112 pinnedWidth: number,
gui-toolbar-fold.ts:131 - `pinnedWidth` — the pinned block's measured width (divider + `⚙`),
gui-toolbar-fold.ts:132   reserved ONLY once something folds (the two-pass rule).
```

**Consequence for this change**: the capture control joins the ALREADY-RESERVED pinned block. Adding
it widens `pinnedWidth` by one 24×24 verb box, which can only cause **one more ladder cluster item
to fold** — it can never clip or hide the capture control itself, at any width. That is the whole
reason the dependency built the slot as a *block* rather than a bare button.

**Sequencing requirement**: this change MUST branch from (or rebase onto) the dependency's landed
commit. If the dependency has landed by apply time, the plan SHALL re-verify the pinned-block API
(`decideGuiToolbarFold`'s `pinnedWidth` parameter and the two-pass reserve) against the merged tree
rather than against the untracked file cited above.

---

## Why

### The problem, concretely

The gui tile's canvas wrapper runs a **capture-phase** keydown gate
(`app/frontend/src/components/gui-surface.tsx:985`):

```tsx
onKeyDownCapture={(e) => {
  onInteractRef.current?.();
  if (!reclaimRef.current?.(e.nativeEvent)) return;
  // noVNC's Keyboard listens on the canvas (a descendant) — stop the
  // event before it descends, then re-dispatch on the parent document:
  // rk's keybinding dispatcher listens at window in the BUBBLE phase,
  // so a plain stopPropagation would eat the chord with it.
  e.preventDefault();
  e.stopPropagation();
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: e.key, code: e.code,
      ctrlKey: e.ctrlKey, metaKey: e.metaKey,
      shiftKey: e.shiftKey, altKey: e.altKey,
      bubbles: true,
    }),
  );
}}
```

`reclaimRef` is the `shouldReclaimChord` prop (`gui-surface.tsx:249`–`:252`), built in `app.tsx` as
a partial application of the registry predicate:

```tsx
// app.tsx:1818–1822
const reclaimChordForKind = useCallback(
  (kind: SurfaceKind) => (e: KeyboardEvent) =>
    hasReclaimableMatch(e, keybindings.bindings, kind),
  [keybindings.bindings],
);
```

threaded `app.tsx:5408` → `surface-layout.tsx:1674` (`shouldReclaimChord={shouldReclaimChord?.("gui")}`).

The predicate itself (`app/frontend/src/lib/keybindings.ts:594`):

```ts
export function hasReclaimableMatch(
  e: ChordEvent,
  bindings: readonly EffectiveBinding[],
  kind: ViewName,
): boolean {
  return findMatches(e, bindings).some((b) => {
    if (b.ttyOnly) return false;
    if (b.webOnly) return kind === "web";
    if (b.guiOnly) return kind === "gui";
    return true;
  });
}
```

So **everything that is not `ttyOnly` or `webOnly` is reclaimed** under kind `"gui"`, plus the
`guiOnly` bindings. Enumerated from the registry (`keybindings.ts:205`–`:410`), **34 registry
entries survive the gate**; several are platform-conditional (an empty `code` means no Win/Linux
chord, an empty `macCode` means no mac chord), so roughly **25 chords actually fire on any one
platform**:

`create-session`, `create-window`, `kill-window`, `reopen-window`, `new-app-window`,
`close-app-window`, `compose-toggle`, `open-last-used`, `window-prev`, `window-next`,
`session-prev`, `session-next`, `go-back`, `go-forward`, `agent-next-waiting`, `host-menu-open`,
`shortcuts-overlay`, `settings-open`, `sidebar-toggle`, `operator-console`, `tty-toggle`,
`code-toggle`, `web-toggle`, `gui-toggle`, `zen-toggle`, `focus-hop`, `command-palette`,
`command-palette-alt`, `layout-cycle`, `gui-zoom-in`, `gui-zoom-out`, `gui-zoom-fit`,
`board-cycle-next`, `board-cycle-prev`.

In the user's vocabulary that is: ⌘K, ⌘T, ⌘W, ⌘1–4, ⌘;, ⌘I, ⌘B, ⌘J, ⌘,, ⌘/, ⌘[, ⌘], ⌘↑, ⌘↓, plus
the `guiOnly` Ctrl+=/−/0 zoom trio. None of them reach the guest.

### What happens if we don't fix it

The gui tile stays a *viewer* of a desktop rather than a *workspace* on it. Any guest application
whose own shortcuts collide with rk's — an editor's ⌘K, a browser's ⌘T, a window manager's ⌘1–4 —
is permanently unreachable through the tile. The user must leave rk (open a native VNC client, or
SSH in) to do work the tile was built for.

### Why this approach over the alternatives

- **A reserved-chord allowlist** (pass a hardcoded subset, keep the rest). Rejected implicitly by
  C3: once ⌘K passes there is no principled line that keeps ⌘1–4 or ⌘B. Every line drawn is a line
  the user has to memorise.
- **Suppress the gate while the gui tile is focused** (no toggle at all). Rejected — the gui tile is
  focused most of the time it is open, so this is the same as deleting rk's chords for anyone who
  uses the surface. The mode must be deliberate and visible.
- **Rely on the existing keyboard lock.** It exists and already works — but only in FULLSCREEN, and
  only where the browser grants it. See C11; capture's real job is the WINDOWED case.

### Why this is a small change

**One predicate narrows.** Nothing else in the pipeline changes: the capture-phase interceptor, the
synthetic re-dispatch, the window dispatcher, the `guiGated` handler map, noVNC's canvas handler —
all untouched. Every other part of this change is a control, an icon, a storage key, two palette
rows and one registry binding, each of which follows a shipped precedent in this codebase.

---

## What Changes

### C1 — MECHANISM: one predicate narrows

**Decision.** In capture mode, `hasReclaimableMatch(e, bindings, "gui")` narrows to the **single
`gui-capture-toggle` actionId**. Every other chord returns `false` and therefore reaches the guest
over the RFB wire. Nothing else in the pipeline changes.

Concretely, the predicate at `keybindings.ts:594` gains a capture-mode narrowing so that, when
captured:

```ts
// captured === true ⇒ only the release binding is reclaimable
return findMatches(e, bindings).some((b) => b.actionId === "gui-capture-toggle");
```

and when not captured it is **byte-identical** to today's behaviour.

The flag reaches the predicate through the existing thread — `app.tsx`'s `reclaimChordForKind`
(`app.tsx:1818`) already closes over state, so the captured boolean joins its dependency array and
`gui-surface.tsx` needs no new prop.
<!-- assumed: the narrowing rides a 4th `captured` parameter on `hasReclaimableMatch` rather than a separate exported predicate or a wrapper at the app.tsx callback — C1 fixes the BEHAVIOUR ("hasReclaimableMatch narrows") but not the signature. A 4th optional param keeps every existing call site compiling and keeps the one-predicate framing literal; the alternative (a sibling `hasReclaimableMatchCaptured`) splits the unit tests in two -->

**Non-goals of C1**: the capture-phase interceptor's body, the synthetic `KeyboardEvent`
re-dispatch, `shouldRefuseTerminalChord`, `shouldSuppressChord`, the `guiGated` handler map, and
noVNC's own canvas handler are ALL unchanged.

### C2 — ESCAPE HATCH: a real registry binding, not a parsed chord

**Decision.** The release chord is a **registry binding**, added to the default table in
`app/frontend/src/lib/keybindings.ts` alongside the existing `guiOnly` zoom trio
(`keybindings.ts:398`–`:400`):

```ts
{ actionId: "gui-capture-toggle", code: "KeyG", tier: "shifted", scope: "terminal",
  kind: "builtin", label: "Keyboard capture",
  description: "hand every chord to the guest desktop",
  mapLabel: "capture", ignoreInputs: true, guiOnly: true },
```

- `tier: "shifted"` resolves to **Ctrl+Shift+G on Linux/Windows and ⌘⇧G on mac** — confirmed by the
  tier derivation at `keybindings.ts:877`:
  `if (e.shiftKey && (e.metaKey || e.ctrlKey)) return { code: e.code, tier: "shifted" };`
- `guiOnly: true` is the correct gate, per the flag's own contract
  (`keybindings.ts:118`–`:124`): "The dispatcher handler map treats a `guiOnly` binding's handler as
  absent unless the focused tile is gui, the reclaim predicate intercepts it only for kind `"gui"`,
  and the terminal seam never refuses it."

**`KeyG` is FREE in the shifted tier — verified.** `grep -n 'KeyG' app/frontend/src/lib/keybindings.ts`
returns **nothing**: no registry binding of any tier uses it. Nor is it claimed by a host — the
shifted-tier entries in `claimedKeys` (`keybindings.ts:495`–`:516`) are `KeyR` (reload), `KeyI`
(devtools), `KeyQ` (mac logout), `KeyC`/`KeyV` (win/linux terminal copy/paste) and, outside the
desktop shell, `KeyN`/`KeyT`/`KeyW` (incognito / reopen tab / close window). `KeyG` appears in none
of them.

**Why a registry binding rather than a parsed chord string.** Being in the registry buys, with no
extra code: remapping (the user can move the escape hatch and it moves everywhere), a cheatsheet row
in the shortcuts overlay, `withShortcutHints` decoration on its palette row, and the tooltip keycap
of C13. A user remap moves the escape hatch with it — a hardcoded chord would strand it.

**REJECTED**:

- **F8** — the VNC-client convention, but it sits outside rk's cmd/ctrl/shifted tiers entirely (the
  tier derivation at `keybindings.ts:877` has no bare-key tier), and a bare function key is exactly
  the kind of key a guest application may want.
- **Double-tap Esc** — the first Esc leaks to the guest and closes its menus, and it needs bespoke
  timing logic that exists nowhere else in the registry.

### C3 — FULL-PASS MODEL: everything passes except the toggle

**Decision.** While latched, **every chord passes to the guest except `gui-capture-toggle`** — ⌘K
included. That was the original complaint, and once ⌘K passes there is no principled line that keeps
⌘1–4 or ⌘B. The `guiOnly` zoom trio (Ctrl+=/−/0) passes too.

**Consequence, to be stated plainly in the UI and the docs**: while captured there is **no keyboard
way to switch tiles**. The three exits are:

1. the release chord (⌘⇧G / Ctrl+Shift+G),
2. clicking the pinned capture icon,
3. the command palette — reachable by pointer, since ⌘K itself is captured.

This is why C4's mouse guarantee and C12's permanent placement are load-bearing rather than
cosmetic.

### C4 — THREE EQUAL ACTIVATION PATHS

**Decision.** Capture toggles by exactly three means, all equal:

1. **Clicking the icon** in the pinned block.
2. **The chord** (C2).
3. **The palette row** — label `GUI: Capture keyboard` when released, `GUI: Release keyboard` when
   latched.

Constitution V requires (2) and (3): *"every user-facing action reachable via a keyboard shortcut or
a UI control MUST also be registered in the command palette."*

**The mouse is NEVER captured.** The chord gate is a `keydown` interceptor only — `gui-surface.tsx`'s
pointer handling (`onPointerDownCapture`, `onPointerMove`, `onMouseDownCapture` at `:243`–`:264`) is
a separate, untouched path. So clicking the icon always works, even if the chord has been remapped
to something the user has forgotten. **That is why the control being PINNED (never folds, at any
width) is the escape hatch that cannot fail.**

### C5 — PERSISTENCE: a new `rk-gui-capture` key

**Decision.** Capture is **sticky per viewer**: a new `rk-gui-capture` key in
`app/frontend/src/lib/gui-posture.ts`, following that file's documented validated-read /
try-catch-noop-write discipline. The shape is the `rk-gui-lock` / `rk-gui-stats-visible` shape
(`"1"` = on, absent = off):

```ts
const GUI_CAPTURE_KEY = "rk-gui-capture";

export function readGuiCapture(): boolean {
  try {
    return localStorage.getItem(GUI_CAPTURE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeGuiCapture(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(GUI_CAPTURE_KEY, "1");
    } else {
      localStorage.removeItem(GUI_CAPTURE_KEY);
    }
  } catch {
    /* noop — best-effort persistence */
  }
}
```

The file's header docblock MUST be extended to describe the new key, as every sibling is described
there.

**Scope, stated explicitly**: like its siblings it is **viewer-global** — a plain
`localStorage.getItem(KEY)` with no server, window, or session scoping. **Latching in one browser
window latches in every window for that viewer**, and it survives a reload. Seven `rk-gui-*` sibling
keys shipped at the time of writing (`gui-posture.ts:61`–`:67`: `rk-gui-zoom`, `rk-gui-pointer`,
`rk-gui-lock`, `rk-gui-quality`, `rk-gui-stats-visible`, `rk-gui-hidpi`, `rk-gui-keybar`), and the
dependency change adds an eighth (`rk-gui-toolbar`); `rk-gui-capture` is the ninth. All are
viewer-global in exactly this way.

**REJECTED**:

- **Reset-on-blur** — cannot be forgotten, but surprising: a click on the tty tile would silently
  drop the mode out from under a user who deliberately set it.
- **Reset-on-reload only** (session-scoped) — inconsistent with all eight siblings.

### C6 — ICON: a new `KeyboardGlyph`

**Decision.** A new `KeyboardGlyph` in `app/frontend/src/components/top-bar-icons.tsx`. Verified:
the register currently holds **21 glyphs** (`grep -c '^export function .*Glyph'` = 21) and **none is
a keyboard** (`grep -i keyboard` returns nothing in that file).

It follows the file's `ControlGlyph` conventions exactly (`top-bar-icons.tsx:31`–`:62`): 14 px
rendered, `viewBox="0 0 24 24"` (the wrapper default), `strokeWidth 2` (the wrapper default),
`fill="none"`, `stroke="currentColor"`, `strokeLinecap="round"`, `strokeLinejoin="round"`,
`aria-hidden="true"`, `className="shrink-0"`, and a kebab-case `data-icon` test seam — i.e. all
defaults, so the call is simply `<ControlGlyph name="keyboard">…</ControlGlyph>`.

**Geometry — candidate "A6", chosen from three:**

```tsx
export function KeyboardGlyph() {
  return (
    <ControlGlyph name="keyboard">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01" />
      <path d="M8 12h.01M12 12h.01M16 12h.01" />
      <path d="M6 16h.01" />
      <path d="M9 16h6" />
      <path d="M18 16h.01" />
    </ControlGlyph>
  );
}
```

The bottom row is **dot · spacebar · dot**, symmetric about x=12. The dots sit at x=6 and x=18,
directly under the outer keys of the y=8 row, so all three rows share one grid.

**REJECTED**:

- the full-width `M7 16h10` spacebar — reads as one long rule rather than echoing the key rows;
- a 2-row simplified keyboard — loses the keyboard read at 14 px;
- a single keycap — indistinguishable from a generic key/button glyph.

### C7 — LATCH TREATMENT: the shipped `LATCHED_ARM_RINGED` recipe

**Decision.** The latched state uses the **already-shipped** `LATCHED_ARM_RINGED` recipe
(`app/frontend/src/components/control.tsx:131`), verified verbatim:

```ts
// control.tsx:128–131
/** Border-axis equivalent for borderless controls (rail toggles, find-bar and
 *  tile-verb glyph buttons) — ring-inset paints inside, so latching never
 *  shifts layout. */
const LATCHED_ARM_RINGED =
  "bg-accent-green/15 ring-1 ring-inset ring-accent-green text-accent-green hover:bg-accent-green/25";
```

That is a **15 % green wash PLUS an inset ring PLUS green ink** — not green ink alone. It is
consumed through `controlClass` (`control.tsx:300`, ringed branch at `:330`/`:340`), and the call is
**the identical call the tty header's ⌕ find toggle already makes** — verified at
`surface-layout.tsx` in the tile-header block (the `kind === "tty" && slot === firstTtySlot` find
button):

```tsx
className={controlClass({
  variant: "toggle",
  base: VERB_BUTTON_BASE,
  rest: "hover:bg-bg-inset hover:text-text-primary",
  ringed: true,
  pressed: findOpen,
})}
```

(`VERB_BUTTON_BASE` is defined at `surface-layout.tsx:370`.) The capture verb makes the same call
with `pressed: captured`. **This is a further caller of an existing recipe, not a new visual.** The
ring is painted `ring-inset`, so latching never shifts layout — which matters because the pinned
block's measured width must not change when the latch flips.

### C8 — WHY GREEN (and where the CONSEQUENCE is carried)

**Decision.** Green. The reasoning, as settled:

- **Yellow is taken.** The status pyramid uses a constant-yellow pulsing halo for `waiting` ("needs
  me now"), plus yellow checks-running on PR glyphs and warm-yellow for ad-hoc agents. A persistent
  yellow chip would read as an alert demanding action, which capture is not.
- **Red is taken.** Failure (the status dot's red centre) and destructive (the ✕ close hover).
- **Green is the app's latch vocabulary** — `LATCHED_ARM` / `LATCHED_ARM_RINGED` /
  `LATCHED_ARM_FLUSH` are the single latched/on arm, documented at `control.tsx:119`–`:136` as
  "scheme C: green = state", with the algebra owned by `docs/memory/run-kit/ui/visual-design.md`.
  Capture is a toggle, so it latches like one.

**The CONSEQUENCE of the mode is carried by WORDS, not hue.** While latched, the gui tile header's
small meta chip reads **`keys → desktop`**. The chip takes the wash and the ink but **NOT the ring**
— it is a label, not a control.

### C9 — FINE POINTER ONLY (omit, don't disable)

**Decision.** The capture control renders **only on fine pointers**, and its palette row is likewise
**omitted on coarse**. This is symmetric with the existing coarse-only rows in
`app/frontend/src/lib/palette/gui.ts`: `gui-pointer-trackpad` / `gui-pointer-touch` and
`gui-keybar-hide` / `gui-keybar-show` sit inside `if (input.coarsePointer) { … }`
(`palette/gui.ts:323`), while the lock pair sits inside `if (!input.coarsePointer) { … }`
(`palette/gui.ts:341`). The capture row joins the **fine-only** block.

**Omit, never disable.**

**Rationale**: capture governs the chord gate, and touch input never reaches that gate — the
coarse-pointer key bar (`gui-keybar.tsx`) and the on-screen keyboard's hidden input are separate
paths. On a phone the control would visibly do nothing, and it would additionally cost ~30 px of a
375 px top bar.

**Accepted cost**: a tablet with a paired external keyboard reports a coarse pointer and therefore
gets no toggle.

### C10 — NO AUTO-ENGAGE

**Decision.** Capture **never latches by itself**. Fullscreen and capture stay **orthogonal
switches**: entering fullscreen does not latch capture, and exiting it does not release capture.

**REJECTED**: latching on fullscreen entry and restoring the previous state on exit. Two reasons:
the latch would move without the user touching it (the one thing a latch must never do), and it
conflicts irreconcilably with C5's sticky key — what would "sticky" mean if fullscreen could
override it?

### C11 — KEYBOARD LOCK IS OUT OF SCOPE AND ALREADY EXISTS — DO NOT RE-IMPLEMENT

**All three line numbers verified in `app/frontend/src/app.tsx`:**

```tsx
// app.tsx:242–250 — the helper
/** The keyboard-lock capability (Chrome desktop's "all keys to the guest"
 *  mode for the gui fullscreen verb). Absent everywhere else — the `in` guard
 *  is the feature detection; the cast bridges the DOM-lib gap. */
function keyboardLock(): { lock(): Promise<void>; unlock(): void } | undefined {
  return "keyboard" in navigator
    ? (navigator as unknown as { keyboard?: { lock(): Promise<void>; unlock(): void } }).keyboard
    : undefined;
}

// app.tsx:1424–1427 — chained on the fullscreen promise
void tile
  .requestFullscreen()
  .then(() => keyboardLock()?.lock())
  .catch(() => {});

// app.tsx:1431–1433 — released on any fullscreen exit, including Esc
const onFsChange = () => {
  if (!document.fullscreenElement) keyboardLock()?.unlock();
};
```

**Consequence to record.** In a browser tab, ⌘W / ⌘T / ⌘N / ⌘Q can **never** reach the guest via the
chord gate — the browser takes them above the page, before any listener runs. But in gui
**fullscreen** they already do, via this existing lock. **Capture's real job is the WINDOWED case**,
where `keyboard.lock()` is unavailable.

**This change touches none of that code.** No edit to `keyboardLock`, to `guiFullscreen`, or to the
`fullscreenchange` effect. (The dependency change moves `guiFullscreen`'s *target* from the canvas
wrapper to the tile element; that is its edit, not this one, and it explicitly records the lock
behaviour as untouched.)

### C12 — INDICATOR PLACEMENT

**Decision.** The capture verb lives in the **pinned block beside `⚙`**, with a hairline either side,
sitting between the adaptive cluster and the frame verbs. The divider uses the shipped spec the
dependency change adopted:

```tsx
<span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border" />
```

Because the dependency change makes fullscreen target the **TILE** — the header travels into
fullscreen and the floating pill is deleted outright — the indicator is **permanently visible in
every context, including fullscreen**. No hide-timer carve-out is needed.

**Two explicit non-requirements** (both were live in an earlier design round and are now MOOT — they
MUST NOT appear in the plan):

- **No fullscreen-pill hide-timer suspension.** An earlier round assumed a surviving fullscreen pill
  and specified suspending its hide timer while latched. The pill is deleted; `TOOLBAR_HIDE_MS` and
  `TOOLBAR_REVEAL_EDGE_PX` go with it.
- **No pill-chip variant of the control.** Capture is a 24×24 borderless header verb **everywhere**,
  so only `LATCHED_ARM_RINGED` is used and `LATCHED_ARM` (the bordered-chip arm, `control.tsx:126`)
  never comes into play.

### C13 — TOOLTIP

**Decision.** A `Tip` (`app/frontend/src/components/tip.tsx`) like every other control in the
cluster, label **"Keyboard capture"**, with the keycap pulled from the **LIVE registry binding**,
not a hardcoded string — so a remap updates the hint.

The keycap source is `chordHintFor(actionId, bindings, platform)`
(`keybindings.ts:1022`–`:1032`), which is the same registry data `withShortcutHints`
(`keybindings.ts:1043`) reads; it resolves aliases and formats via `formatCombo`. This is the idiom
the dependency change adopted for the three zoom tips.

Per the `Tip` contract (`tip.tsx:21`–`:50`), verified:

- `Tip` **REPLACES** the native `title=` — never both, or the OS bubble doubles the styled tip.
- `aria-label` stays and is what coarse pointers get, since **`Tip` is suppressed under
  `pointer: coarse` by contract** — consistent with C9.
- `Tip` clones its single child and adds **no wrapper DOM node**, so it composes with the pinned
  block's width measurement for free.
- The capture verb joins the cluster's single `TipGroup` (the warm-cluster provider the dependency
  change wraps the whole header cluster in), so sweeping the row opens its tip at 0 ms.

### Palette wiring (the C4 ⇄ C13 seam)

`withShortcutHints` attaches a keycap by matching **`action.id === binding.actionId`**
(`keybindings.ts:1048`–`:1053`). A destination-only PAIR of ids (the `gui-keybar-show` /
`gui-keybar-hide` shape) would therefore leave **both** rows without the keycap.

**Resolution**: the palette exposes **ONE row with the stable id `gui-capture-toggle`** whose LABEL
depends on state — `GUI: Capture keyboard` when released, `GUI: Release keyboard` when latched. One
id keeps the `withShortcutHints` decoration; the state-dependent label keeps the destination-only
wording C4 specifies.
<!-- assumed: one state-labelled palette row keyed `gui-capture-toggle`, rather than a two-id destination-only pair — C4 names the two LABELS but not the ids, and the pair shape (gui-keybar-show/hide) would silently drop the keycap that C2 and C13 both depend on. Reversible: it is one row in palette/gui.ts and one test -->

The row also satisfies `palette/gui.ts`'s standing rule (`palette/gui.ts:95`–`:97`): the header fold
cluster consumes this SAME list by stable id via `pickGuiActions`, and **no cluster-only action may
be introduced** — so the pinned capture verb's `onClick` MUST be the palette row's body, not a
parallel handler.

### Dispatcher handler wiring

The chord's handler joins the `guiGated` handler map in `app.tsx`, exactly where the zoom trio sits:

```tsx
// app.tsx:4736–4742 — the gate
// guiOnly gate — the webOnly mirror: a `guiOnly` binding's handler is
// treated as ABSENT unless the gui tile owns focus …
const guiGated = (id: string, run: () => void) => …

// app.tsx:4871–4873 — the precedent
"gui-zoom-in": guiGated("gui-zoom-in", () => handleGuiZoomChange(stepGuiZoom(guiZoom, 1))),
"gui-zoom-out": guiGated("gui-zoom-out", () => handleGuiZoomChange(stepGuiZoom(guiZoom, -1))),
"gui-zoom-fit": guiGated("gui-zoom-fit", () => handleGuiZoomChange("fit")),
```

so:

```tsx
"gui-capture-toggle": guiGated("gui-capture-toggle", () => handleGuiCaptureChange(!guiCapture)),
```

The gate is why the release chord works: `guiOnly` means the handler is present only while the gui
tile owns focus, and the narrowed reclaim predicate is what delivers the chord there in the first
place.

### The `keys → desktop` meta chip

The gui tile header's small meta chip is the C8 carrier. **Verified gap**: `tileMeta`
(`surface-layout.tsx:574`) currently returns a value only for `code` (the root's basename) and `web`
(the tab's display form) — **it returns `null` for `gui`, so the gui tile has no meta chip today**,
and the dependency change does not add one.

The data exists: `GuiSignal` (`app/frontend/src/contexts/session-context.tsx:283`–`:295`) carries
both `wm: string` and `display: string`, which is where `icewm · :1` comes from.

**Resolution for this change**: extend the gui header to render a meta chip in the existing meta
slot — `wm · display` when both are present, falling back gracefully when the guest is bare
(`wm === ""`, the `GUI_BARE` case already exercised in `gui-surface.test.tsx:144`) — and swap its
content to `keys → desktop` while captured, taking `bg-accent-green/15` + `text-accent-green` and
**no ring**.
<!-- assumed: this change adds the gui meta chip it swaps. C8 says the chip "swaps from its normal content (e.g. `icewm · :1`)", but tileMeta returns null for gui and the dependency change does not add it — so the chip does not exist to swap. The alternative (render `keys → desktop` only while latched, nothing otherwise) is cheaper but leaves an empty slot that appears and disappears, which reads as a layout bug -->

---

## Affected Memory

- `run-kit/ui/keyboard-and-palette`: (modify) The gui chord-gate rules gain the capture mode — the
  narrowed `hasReclaimableMatch`, the new `gui-capture-toggle` `guiOnly` shifted-tier binding and
  its `guiGated` handler, the full-pass model and its "no keyboard tile-switching while captured"
  consequence, and the single state-labelled `GUI: Capture keyboard` / `GUI: Release keyboard`
  palette row keyed on the actionId for `withShortcutHints`.
- `run-kit/gui`: (modify) Keyboard capture as a gui-surface mode — what passes, what does not, the
  windowed-vs-fullscreen split against the existing `keyboard.lock()`, the browser-reserved chords
  that can never pass in a tab, and the three exits.
- `run-kit/ui/lenses-and-layout`: (modify) The gui tile header's pinned block gains the capture verb
  beside `⚙`, permanently visible at every width and in fullscreen; the gui meta chip (`wm · display`)
  and its `keys → desktop` capture state.
- `run-kit/ui/visual-design`: (modify) `KeyboardGlyph` joins the `ControlGlyph` register (22 glyphs);
  a further `LATCHED_ARM_RINGED` caller; the wash+ink-without-ring treatment for a LABEL carrying
  latched state (the meta chip), distinguished from the ringed control treatment.
- `run-kit/ui/dialogs-and-state`: (modify) The per-viewer gui posture inventory gains `rk-gui-capture`,
  and records that it is viewer-global like its siblings (latching in one window latches everywhere).
- `run-kit/ui/status-signals`: (modify) The capture verb joins the gui header cluster's `TipGroup`;
  its keycap is read live via `chordHintFor` rather than hardcoded.

---

## Impact

**Modified files** (all under `app/frontend/src/`):

| File | Change |
|------|--------|
| `lib/keybindings.ts` | The `gui-capture-toggle` binding in the default table (beside the zoom trio at `:398`–`:400`); the capture-mode narrowing in `hasReclaimableMatch` (`:594`) |
| `app.tsx` | `rk-gui-capture`-backed state + its setter; the captured flag into `reclaimChordForKind` (`:1818`); `"gui-capture-toggle": guiGated(…)` beside `:4871`–`:4873`; the flag threaded to `SurfaceLayout` |
| `components/surface-layout.tsx` | The capture verb in the gui header's **pinned block**; the gui meta chip and its `keys → desktop` capture state (`tileMeta` at `:574`) |
| `components/gui-toolbar.tsx` | The pinned block gains a second member; `pinnedWidth` grows by one 24×24 verb box (in-flight file — verify against the landed dependency) |
| `components/top-bar-icons.tsx` | `KeyboardGlyph` (the 22nd glyph) |
| `lib/gui-posture.ts` | `rk-gui-capture` + `readGuiCapture`/`writeGuiCapture`; the header docblock extended |
| `lib/palette/gui.ts` | One state-labelled row `gui-capture-toggle` in the **fine-pointer** block (`:341`) |

**Tests**

- `lib/keybindings.test.ts` — the narrowed predicate: captured ⇒ only `gui-capture-toggle` returns
  true; not-captured ⇒ byte-identical to today for every existing case; `KeyG`/shifted resolves per
  platform.
- `lib/gui-posture.test.ts` — `rk-gui-capture` read/write, the absent/invalid-value default, and the
  throwing-`localStorage` path.
- `lib/palette/gui.test.ts` — the row present on fine, **absent** on coarse; the label flips with
  state; the id is `gui-capture-toggle`.
- `components/top-bar-icons.test.tsx` (or the register's existing test) — `data-icon="keyboard"`.
- `components/gui-toolbar.test.tsx` — the capture verb renders in the pinned block at **every** width
  (it must never fold), and never on coarse.
- **A Playwright e2e case** — `app/frontend/tests/e2e/` (alongside `gui-surface.spec.ts` and the
  `_gui.ts` helper). **jsdom cannot prove chord routing** — there is no real key pipeline, no
  capture-phase ordering against a canvas listener, and no noVNC. The spec must prove: with capture
  off, ⌘K/Ctrl+Shift+K opens the palette; with capture on, it does not and the key reaches the
  canvas; ⌘⇧G/Ctrl+Shift+G releases from the captured state; clicking the icon releases; the latch
  survives a reload (C5).
- Per the constitution's **Test Intent Comments** rule, every new Playwright `test()` carries a
  `Proves:` / `Steps:` JSDoc block, and a new spec file opens with a shared-setup file header.
- **Regenerate `control-gallery.spec.ts-snapshots` ONLY IF the `Control` primitive emits new
  classes.** It should not — C7 adds a caller, not a recipe.

**Gates (the environment now has a full Go toolchain 1.27.1 and frontend deps + Playwright/Chromium
installed, so all of these run)**:

```
cd app/frontend && npx tsc --noEmit
just test-frontend      # justfile:99
just test-e2e           # justfile:104  → scripts/test-e2e.sh
just test-backend       # justfile:91
just build              # justfile:48
```

**Always go through `just` recipes** — never `playwright test` / `pnpm test` / `vitest` directly
(Constitution VIII: the justfile is the index).

**Constitution touchpoints**

- **V (Keyboard-First)** — satisfied by C4: the chord and the palette row both exist, and the
  palette row is the documented fallback for a surface that reserves chords — which is precisely
  what capture mode does. Note the deliberate inversion: while captured the palette is reachable by
  pointer, because its own chord has been handed to the guest. The principle's fallback guarantee
  ("palette → action") is met by the pointer-reachable palette plus the reserved release chord.
- **IV (Minimal Surface Area)** — no new route, no new settings surface; per-viewer state stays in
  `localStorage` (`rk-gui-capture`), exactly where the constitution puts per-viewer state.
- **Test Intent Comments** — every new Playwright `test()` needs its `Proves:` / `Steps:` JSDoc.

**Risks**

- **Dependency ordering.** The pinned block does not exist on `main` yet. Branching before the
  dependency lands means the plan's central placement decision has no host. Mitigation: branch from
  the dependency's landed commit, or rebase before apply.
- **Line drift.** `surface-layout.tsx` and `gui-toolbar.tsx` are being rewritten by the dependency's
  apply worker right now. Every anchor in those two files must be re-resolved by symbol at apply
  time.
- **The escape hatch is the whole safety story.** A bug that latches capture but breaks the release
  chord AND hides the icon leaves a viewer with no keyboard route out of the tile. The e2e case MUST
  cover both the chord exit and the click exit, and the "never folds at any width" assertion is a
  safety test, not a cosmetic one.
- **Predicate regression blast radius.** `hasReclaimableMatch` also serves the `code` and `web`
  iframe reclaim paths. The narrowing must be provably inert when not captured — assert
  byte-identical behaviour for kinds `code` and `web` in the unit tests.

**Explicitly out of scope**

- `keyboard.lock()` and everything around `guiFullscreen` (C11) — already shipped, untouched.
- Auto-engaging capture on fullscreen (C10).
- A coarse-pointer / mobile capture control, and the key bar `gui-keybar.tsx` (C9).
- Any change to the capture-phase interceptor body, the synthetic re-dispatch, or noVNC's handler (C1).
- A hide-timer carve-out or a pill-chip variant of the control (C12) — both MOOT.

---

## Open Questions

- The gui header meta chip that C8's `keys → desktop` state swaps into does not exist today
  (`tileMeta` at `surface-layout.tsx:574` returns `null` for `gui`), and the dependency change does
  not add it. Does this change add the `wm · display` chip, or render `keys → desktop` only while
  latched? (Recorded as a Tentative assumption below.)
- Does the capture-mode narrowing ride a 4th parameter on `hasReclaimableMatch`, or a sibling
  predicate? C1 fixes the behaviour but not the signature. (Recorded as a Confident assumption below.)
- Should the palette expose one state-labelled row or a destination-only pair? A pair loses the
  `withShortcutHints` keycap that C2 and C13 depend on. (Recorded as a Confident assumption below.)
- Does the bare-WM case (`wm === ""`) render `· :1`, just `:1`, or no chip at all? (Recorded as a
  Tentative assumption below.)

---

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | C1 — capture narrows `hasReclaimableMatch(e, bindings, "gui")` to the single `gui-capture-toggle` actionId; nothing else in the pipeline changes | Discussed — user chose the one-predicate narrowing over a reserved-chord allowlist and over suppressing the gate on gui focus. Predicate verified at `keybindings.ts:594` | S:95 R:85 A:95 D:95 |
| 2 | Certain | C2 — the escape hatch is a real registry binding `gui-capture-toggle`, `guiOnly: true`, shifted tier, `code: "KeyG"` (Ctrl+Shift+G / ⌘⇧G) | Discussed — user chose a registry binding over F8 and over double-tap Esc, for remapping + cheatsheet + palette + tooltip for free. `KeyG` verified free: no registry match, and absent from `claimedKeys` (`keybindings.ts:495`–`:516`) | S:95 R:80 A:95 D:95 |
| 3 | Certain | C3 — full-pass model: everything passes to the guest except the toggle, ⌘K included; the `guiOnly` zoom trio passes too | Discussed — user chose it over a partial allowlist, on the ground that once ⌘K passes no principled line keeps ⌘1–4 or ⌘B. Consequence (no keyboard tile-switching while captured) accepted explicitly | S:95 R:80 A:90 D:95 |
| 4 | Certain | C4 — three equal activation paths (icon click, chord, palette row); the mouse is never captured, so the icon click always works | Discussed. Constitution V requires the chord and the palette row. The mouse guarantee is structural — the gate is a `keydown` interceptor only; pointer handling at `gui-surface.tsx:243`–`:264` is untouched | S:95 R:85 A:95 D:95 |
| 5 | Certain | C5 — sticky per viewer via a new `rk-gui-capture` key in `gui-posture.ts`, viewer-global like its eight siblings (latching in one window latches everywhere) | Discussed — user chose sticky over reset-on-blur (surprising) and reset-on-reload-only (inconsistent with the siblings). The seven shipped `rk-gui-*` keys verified at `gui-posture.ts:61`–`:67`; the dependency adds an eighth | S:90 R:90 A:95 D:90 |
| 6 | Certain | C6 — a new `KeyboardGlyph` with the "A6" geometry (rect case, 4-dot row, 3-dot row, dot·spacebar·dot bottom row symmetric about x=12) | Discussed — chosen from three candidates; the full-width spacebar, the 2-row keyboard and the single keycap were rejected. Register verified: 21 glyphs, none a keyboard; `ControlGlyph` conventions at `top-bar-icons.tsx:31`–`:62` | S:95 R:90 A:90 D:90 |
| 7 | Certain | C7 — `controlClass({ variant: "toggle", base: VERB_BUTTON_BASE, rest: "hover:bg-bg-inset hover:text-text-primary", ringed: true, pressed })` — the identical call the tty ⌕ find toggle makes | Discussed. Recipe verified verbatim at `control.tsx:131`; the find-toggle call site verified in `surface-layout.tsx`'s tile header. A further caller of a shipped recipe, not a new visual. The `rest` arm was read off the live call site (the design note omitted it) | S:95 R:90 A:95 D:95 |
| 8 | Certain | C8 — green, because yellow (waiting/checks/ad-hoc) and red (failure/destructive) are taken and green is the app's latch vocabulary; the CONSEQUENCE is carried by the `keys → desktop` words, not by hue | Discussed — the hue vocabulary is fixed by the status pyramid and `control.tsx:119`–`:136` ("scheme C: green = state"); the algebra is owned by `docs/memory/run-kit/ui/visual-design.md` | S:90 R:85 A:90 D:90 |
| 9 | Certain | C9 — fine pointer only, control AND palette row; omit, never disable | Discussed. Symmetric with the shipped coarse-only rows at `palette/gui.ts:323` and the fine-only block at `:341`. Rationale: touch input never reaches the chord gate, and it would cost ~30px of a 375px top bar. Accepted cost: a tablet with an external keyboard gets no toggle | S:90 R:85 A:90 D:90 |
| 10 | Certain | C10 — capture never latches by itself; fullscreen and capture stay orthogonal | Discussed — user rejected latch-on-fullscreen-entry: the latch would move untouched, and it conflicts irreconcilably with C5's sticky key | S:90 R:85 A:90 D:95 |
| 11 | Certain | C11 — `keyboard.lock()` is out of scope and must not be re-implemented; capture's job is the WINDOWED case | Discussed. All three anchors verified: helper `app.tsx:245`, `.then(() => keyboardLock()?.lock())` `app.tsx:1426`, unlock `app.tsx:1433`. Consequence recorded: ⌘W/⌘T/⌘N/⌘Q can never pass in a browser tab, but already do in gui fullscreen via the lock | S:95 R:95 A:95 D:95 |
| 12 | Certain | C12 — the verb lives in the pinned block beside `⚙`, permanently visible including fullscreen; NO hide-timer carve-out and NO pill-chip variant (both MOOT) | Discussed — the earlier fullscreen-pill carve-out was reversed once the dependency deleted the pill and moved fullscreen to the tile. The dependency's intake §7 records that reversal explicitly | S:90 R:85 A:90 D:95 |
| 13 | Certain | C13 — a `Tip` labelled "Keyboard capture" with the keycap read live from the registry (`chordHintFor`, `keybindings.ts:1022`), not hardcoded | Discussed. `Tip` contract verified at `tip.tsx:21`–`:50`: replaces native `title=`, suppressed under `pointer: coarse` (consistent with C9), adds no wrapper DOM node | S:90 R:95 A:95 D:90 |
| 14 | Confident | The capture-mode narrowing rides a 4th `captured` parameter on `hasReclaimableMatch` rather than a sibling predicate or an app.tsx-side wrapper | GAP — C1 fixes the behaviour ("hasReclaimableMatch narrows") but not the signature. An optional 4th param keeps every existing call site compiling and keeps the one-predicate framing literal; a sibling predicate would split the unit tests. Cheap to change: one signature, one call site | S:65 R:85 A:85 D:70 | <!-- assumed -->
| 15 | Certain | The palette exposes ONE state-labelled row keyed `gui-capture-toggle` (label flips `GUI: Capture keyboard` ⇄ `GUI: Release keyboard`), not a two-id destination-only pair | GAP — C4 names the two LABELS but not the ids. `withShortcutHints` (`keybindings.ts:1048`) matches `action.id === binding.actionId`, so the `gui-keybar-show`/`gui-keybar-hide` pair shape would silently drop the keycap C2 and C13 both depend on. One row in `palette/gui.ts` plus one test | S:60 R:90 A:90 D:75 | <!-- assumed -->
| 16 | Confident | This change branches from / rebases onto the landed `260912-lut4-gui-toolbar-header-fold`, and re-verifies `gui-toolbar-fold.ts`'s `pinnedWidth` two-pass API against the merged tree | The dependency is in flight, not landed; its `gui-toolbar-fold.ts` is untracked. The contract is unambiguous (verified at `gui-toolbar-fold.ts:18`–`:21`, `:112`, `:131`–`:132`) but the file may change before merge. Sequencing is mechanical, not a design choice | S:85 R:60 A:85 D:85 | <!-- assumed -->
| 17 | Tentative | This change ADDS the gui header meta chip (`wm · display`, e.g. `icewm · :1`) that C8's `keys → desktop` state swaps into | GAP — C8 assumes the chip exists. Verified it does NOT: `tileMeta` (`surface-layout.tsx:574`) returns a value only for `code` and `web`, `null` for `gui`, and the dependency change does not add one. The data exists on `GuiSignal` (`session-context.tsx:283`–`:295`: `wm`, `display`). The alternative — render `keys → desktop` only while latched — is cheaper but leaves a slot that appears and disappears, reading as a layout bug. Scope-expanding either way, so worth a `/fab-clarify` pass | S:45 R:55 A:50 D:40 | <!-- assumed: this change adds the gui meta chip it swaps; tileMeta returns null for gui today -->
| 18 | Confident | On a bare guest (`wm === ""`, the shipped `GUI_BARE` case) the meta chip degrades to the display alone (`:1`) rather than rendering `· :1` or nothing | GAP — follows from row 17 and was never discussed; `gui-surface.test.tsx:144` shows `GUI_BARE` is a real, tested state. Purely presentational and trivially reversible, but it needs a decision before the chip can be written | S:35 R:90 A:60 D:45 | <!-- assumed: bare-WM meta chip degrades to the display alone -->

18 assumptions (14 certain, 3 confident, 1 tentative, 0 unresolved).
