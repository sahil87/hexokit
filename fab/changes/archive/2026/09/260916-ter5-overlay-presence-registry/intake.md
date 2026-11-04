# Intake: Overlay Presence Registry

**Change**: 260916-ter5-overlay-presence-registry
**Created**: 2026-09-16

## Origin

> One SPA-side registry says whether a modal-class overlay is open — the palette, every dialog, the settings panel, the quake drawer, the screen-break egg and the mobile drawer register while open — so a surface that cannot be painted over (the native web view) can hide itself; toasts move over chrome so they never sit on the stage.
>
> Full context lives in fab/plans/sahil/26-09-16-web-tile-native-browser.md — read the whole file before starting, especially "## Change 2 — overlay presence" for the task detail, "## Standing context" and "## Decisions of record" for what applies across the whole plan, and the "## Spike verdict" section at the bottom — change 0's spike found the modal-hide budget (21-40ms open→hide) needs no pre-hide, and `modal` is the only kind that hides (this change is otherwise unchanged by the spike). This is change 2 of 6 in the plan (light lane). After intake, proceed through the full pipeline yourself (fab-fff) to implementation, review, hydrate, ship, and PR.

**Mode**: one-shot `/fab-new` from the plan's intake seed. The plan (`fab/plans/sahil/26-09-16-web-tile-native-browser.md` § Change 2) and the design study (`docs/wiki/web-tile-native-browser-studies.html` § 5 Layering, § 13 change stack) are the design authority; the spike verdict (plan § Spike verdict) confirms this change unchanged. Change 1 (the engine seam, `260916-fxt1`, PR #993) is on `main`; change 3d (desktop registry + bridge) is file-disjoint and may run in parallel.

**Key decisions carried from the plan**:
- The registry is a **count of mounted occluding overlays**, never a focus read — focus is stolen by iframes and (later) native views, so presence is the truth the engine needs.
- Two kinds, `modal | transient`; **only `modal` counts toward the hide signal**. `transient` exists in the type and the counter so the clip rule (change 4) has a slot, but **no transient call sites land here**.
- Toasts stop being stage overlays: they anchor **over chrome (the top-bar band)** so they never sit on the tile area a native view will paint over.
- The registry is **inert with no subscriber** — the iframe engine ignores it, every existing e2e spec stays green, and the native engine (change 3f) is its first consumer.

## Why

**The problem.** The desktop shell is about to render the web tile through Electron's `WebContentsView` (plan change 3). A native view is composited *above* the SPA's DOM: nothing the SPA draws — not the ⌘K palette, not a dialog, not the quake drawer, not a toast, not the screen-break egg — can appear over it. The spike measured the fix: `setVisible(false)` on the guest lands 21–40 ms after the palette keypress with no swallowed frame and no hole (the tile placeholder keeps the card), so **hiding the guest while a modal-class overlay is open** is the layering rule. What the SPA lacks is the *signal*: today there are 21 components at `z-50`/`z-[60]` and no central notion of "an overlay is open" — dialog state is spread across `useDialogState`, `useSettingsDialog`, `useServerDialogs`, the palette's own `open`, the quake terminal's machine, the screen-break store's `flight`, and the shell's `sidebarOpen`.

**If we don't build it.** Change 3f would have to either read focus (wrong — an iframe or native view steals focus while a dialog is open, and a dialog's focus trap is not the only modal surface) or scrape the DOM for `[role="dialog"]` (the quake terminal already does this once at settle time as a special case — it is a fragile heuristic, not a contract: the screen-break egg and the mobile drawer's backdrop would be missed or double-counted). Every later overlay would silently break the native tile.

**Why a counter module, not context or DOM.** A module-level counter with `subscribe` is readable from non-React code (the engine's bridge effect) and from any React tree via `useSyncExternalStore`; it needs no provider above the palette/dialog/drawer mounts (which live in different trees — `AppLayout`, `AppShell`, the root `ToastProvider`); and a count (not a boolean) is correct for nested modals (a `CronCreateDialog` opened from the `CronEntryDetailSheet`, a `Dialog` confirm inside the quake drawer). It mirrors the codebase's existing in-module pub/sub idiom (`lib/screen-break-store.ts`, `hooks/use-local-storage-boolean.ts`).

**Why toasts move now.** The toast stack is `fixed bottom-4 right-4` — the stage's bottom-right corner, exactly where a web tile's content sits. A toast is not modal-class (it must not hide the page for 4 s on every "Sent to operator"), and clipping the guest around it (change 4's transient rule) reflows the page by the toast's height. The study's answer is a placement change: corner-anchored toasts position over chrome (status bar / top bar), never over the stage. Doing it here keeps change 3f free of toast special cases.

## What Changes

### 1. `app/frontend/src/lib/overlay-presence.ts` (new, pure)

A tiny module-level registry, no React import:

```ts
export type OverlayKind = "modal" | "transient";

/** Register an open occluding overlay; returns its release. Release is
 *  idempotent — a second call is a no-op (StrictMode effect replays and
 *  defensive double-cleanup never drive the count negative). */
export function acquire(kind: OverlayKind): () => void;

/** Open overlays of `kind`, or all kinds when omitted. */
export function count(kind?: OverlayKind): number;

/** The hide signal a native surface reads: `count("modal") > 0`. */
export function isModalOpen(): boolean;

/** Notified after every count change (acquire or release). Returns the unsubscribe. */
export function subscribe(listener: () => void): () => void;

/** Test seam — zero every count and drop every listener. */
export function _resetForTests(): void;
```

Semantics:
- Counts are per kind (`Map<OverlayKind, number>` or two integers); `count()` with no argument sums them.
- `acquire` increments and notifies; the returned `release` decrements and notifies **once** — a closure flag makes the second call a no-op. The count never goes below 0.
- `subscribe` listeners fire synchronously after each change with no payload (readers call `count`/`isModalOpen`); unsubscribing during a notification is safe (iterate over a copy or a `Set` snapshot).
- No DOM, no `window`, no localStorage — the module is importable from Vitest with no setup and from the engine's effect without a provider.

Colocated `overlay-presence.test.ts`: acquire increments the right kind; release decrements; double release is a no-op; `isModalOpen()` is true only while a `modal` is held (a held `transient` alone leaves it false); `count()` sums kinds; subscribers fire on acquire and release and stop after unsubscribe; nested modals (two acquires, one release) keep `isModalOpen()` true until the second release.

### 2. `app/frontend/src/hooks/use-occludes.ts` (new)

```ts
/** Holds an overlay-presence registration of `kind` while `open` is true;
 *  releases on `open → false` and on unmount. */
export function useOccludes(kind: OverlayKind, open: boolean): void {
  useEffect(() => {
    if (!open) return;
    return acquire(kind);
  }, [kind, open]);
}
```

Colocated `use-occludes.test.tsx` (RTL `renderHook`): acquires on `open: true`, releases on rerender to `false`, releases on unmount, re-acquires on `false → true`, StrictMode double-invocation leaves the count at 1.

### 3. Call sites — every modal-class overlay registers `modal` while open

Verified inventory (every `aria-modal` / full-viewport-backdrop surface in `app/frontend/src/components`):

| Surface | File | Open predicate | Notes |
|---------|------|----------------|-------|
| Command palette | `command-palette.tsx` | `open` (line ~70) | Call the hook **before** the `if (!open) return null` early return (hooks rule). |
| Every `Dialog` consumer | `dialog.tsx` | mounted ⇒ open: `useOccludes("modal", true)` | One call covers the 19 consumers that render through the primitive: `create-session-dialog`, `cron-create-dialog`, `gui-confirm-shell` (→ `gui-off-dialog`, `gui-restart-dialog`), `gui-geometry-prompt`, `gui-send-key-prompt`, `host-form-dialog`, `operator-compose-dialog`, `server-dialogs`, `session-name-prompt`, `settings-dialog`, `sidebar/kill-dialog`, `spawn-agent-dialog`, `tmux-commands-dialog`, `window-note-prompt`, plus the inline `<Dialog>` mounts in `app.tsx`, `board/board-page.tsx` (kill confirm), `host-overview-page.tsx`, `desktop-shell/titlebar-strip.tsx` (Remove host). |
| Settings panel | `settings-dialog.tsx` → `settings-all-panel.tsx` | covered by `Dialog` | `SettingsAllPanel` renders only inside `SettingsDialog`'s `<Dialog size="xl">`; it needs **no separate call**. Verify with a grep that no other mount exists. |
| Theme selector | `theme-selector.tsx` | `open` | Bespoke `aria-modal` + `fixed inset-0` backdrop, not on `dialog.tsx` — gets its own call (before its early return). |
| Cron entry detail sheet (modal variant) | `cron-entry-detail-sheet.tsx` | `!inline` while mounted | The `fixed inset-0 z-40` + `aria-modal` variant registers; the `inline` variant (inside the quake drawer's cron tabs) does **not** — the drawer already registers. |
| Quake drawer | `quake-terminal.tsx` | `open` (the drawer mount flag, line ~238) | `open`, not `machine === "open"`: the flag stays true through the exit slide, so the guest re-shows when the drawer has actually left the stage. |
| Screen-break egg | `screen-break.tsx` `ScreenBreak` | `flight !== null` | The event layer covers the whole viewport for the full 12 s flight (crack → shatter → emerge → heal); register for the whole flight. Hook before the `if (!flight) return null` return. |
| Mobile sidebar drawer | `shell/shell.tsx` `AppShell` | `drawerActive` (`isMobile && sidebarOpen && !!sidebarChildren`, line ~240) | The same predicate that arms the drawer's focus trap. |

Not registered (transient class — clipping is change 4's job; recorded here so review does not flag them as omissions): `tip.tsx`, `sidebar/row-flyout-card.tsx`, `sidebar/marker-pad.tsx`, `sidebar/pin-popover.tsx` (carries `role="dialog"` but is a popover with no backdrop), `swatch-popover.tsx`, `theme-picker-list.tsx` (embedded, not the modal), `compose-history-flyout.tsx`, the status-bar popovers, the top-bar overflow menu, `compose-strip.tsx` (explicitly not a dialog per its header comment).

Each call is one line: `useOccludes("modal", <predicate>)` with the import. No other behavior in these components changes.

### 4. Toast placement — `app/frontend/src/components/toast.tsx`

`ToastContainer`'s class changes from the stage corner to the top-bar band:

```diff
- className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
+ className="fixed top-2 right-2 z-50 flex flex-col gap-2 pointer-events-none"
```

The stack grows downward from the top-right; `role="alert"`, `aria-live="polite"`, the 4 s timer, variants, the optional action button and `onDismiss` are untouched. The top bar exists on every form factor (the desktop status bar is desktop-only and, at 24 px, shorter than a toast), so one class serves phones, browsers and the shell. A short comment states the constraint (a toast must never sit on the stage because a native web view paints over the SPA there), not the history. `toast.test.tsx` asserts behavior, not position — add one assertion that the container carries the top-anchored classes (`top-2 right-2`) and not `bottom-4`. No e2e asserts toast position (verified: `agent-next-waiting`, `operator-compose`, `operator-digest` only check visibility/text).

### 5. Tests

- `lib/overlay-presence.test.ts` and `hooks/use-occludes.test.tsx` as above.
- One RTL assertion per registering component, added to its existing colocated test file (`command-palette.test.tsx`, `dialog.test.tsx`, `quake-terminal.test.tsx`, `screen-break.test.tsx`, `shell/shell.test.tsx`, `cron-entry-detail-sheet.test.tsx`; `theme-selector` gets a new small test or a case in an existing one): after `_resetForTests()`, rendering the surface open makes `count("modal")` 1 (or `isModalOpen()` true) and closing/unmounting returns it to 0. Reading the real module is preferred over `vi.mock` — it also proves the import wiring; a spy on `acquire` is acceptable where a component's open path is hard to drive.
- Gates: `cd app/frontend && npx tsc --noEmit`; `just test-frontend` (the full Vitest run — touched-files-only has missed cross-file breakage before); e2e smoke `just test-e2e "e2e/command-palette.spec"`, one dialog spec (`just test-e2e "e2e/operator-compose.spec"` — it also drives toasts), one spec per run.

### 6. Memory

`docs/memory/run-kit/ui/dialogs-and-state.md`:
- New § **Overlay presence** (near § Component Conventions or beside the dialog sections): the module API, the two kinds and the modal-only hide rule, the registering-surface table above, the not-registered transient list, the `useOccludes` hook, and the consumer seam (`subscribe` + `isModalOpen`, first consumed by the desktop shell's native web engine).
- § Error toast system: "Fixed bottom-right" becomes the top-right over the top-bar band, with the reason.
- § Design Decisions: **Overlay presence is a count, not a focus read** — Decision / Why (focus is stolen by iframes and native views; nested modals need a count; module-level so non-React code subscribes) / Rejected (a focus-based read; `[role="dialog"]` DOM scraping; a React context, which would need a provider above trees that mount independently) / *Introduced by* this change.
- `fab docs-index` regenerates `docs/memory/run-kit/ui/index.md` if the file's frontmatter description changes (it should — add "overlay presence").

## Affected Memory

- `run-kit/ui/dialogs-and-state`: (modify) new § Overlay presence, updated § Error toast system placement, new Design Decision *Overlay presence is a count, not a focus read*
- `run-kit/ui/index`: (modify) regenerated by `fab docs-index` if the dialogs-and-state description changes

## Impact

**Frontend only** (`app/frontend/src/`): two new modules (`lib/overlay-presence.ts`, `hooks/use-occludes.ts`) with tests; one-line hook calls in 7 components (`command-palette.tsx`, `dialog.tsx`, `theme-selector.tsx`, `cron-entry-detail-sheet.tsx`, `quake-terminal.tsx`, `screen-break.tsx`, `shell/shell.tsx`); a placement class change in `toast.tsx`; test additions in ~8 spec files. No backend, no desktop (`app/desktop`) changes, no routes, no settings keys, no keyboard shortcuts, no palette entries (nothing user-actionable is added — Constitution IV/V untouched). No behavior change for any current viewer: the registry has no subscriber until change 3f, and the toast move is visual only. Existing e2e specs stay green; the smoke set above is the only e2e run.

**Risk**: low. The only user-visible change is toast position. Hook-order mistakes (calling `useOccludes` after an early `return null`) would throw in dev — the tests for each surface catch that.

## Open Questions

- None blocking. The exact toast offset (`top-2 right-2`) is a placement detail the worker may tune against the top bar's height if a toast visibly straddles into the stage on either form factor; the rule that matters is *over chrome, never the stage*.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Module API is `acquire(kind) → release`, `count(kind?)`, `isModalOpen()`, `subscribe(cb)`, `_resetForTests()`; kinds are `modal` and `transient` | Plan § Change 2 item 1 names the shape verbatim; `isModalOpen` is the one-line derived read the plan's "only modal counts toward the hide signal" implies; `_resetForTests` mirrors `screen-break-store.ts` | S:90 R:95 A:95 D:90 |
| 2 | Certain | Only `modal` counts toward the hide signal; `transient` is in the type and counter but has no call sites in this change | Plan § Change 2 + § Spike verdict ("`modal` is the only kind that hides"); non-goal "clipping geometry (change 4)" | S:95 R:90 A:95 D:95 |
| 3 | Confident | Toasts anchor top-right over the top-bar band (`fixed top-2 right-2`), stack growing downward, one class on every form factor | Plan says "over the status bar / top bar band"; the top bar exists on phones, browsers and the shell while the status bar is desktop-only and 24 px (shorter than a toast, so it would still straddle the stage); the study calls it a one-line placement change | S:70 R:95 A:75 D:60 |
| 4 | Certain | `dialog.tsx` registers once (`useOccludes("modal", true)`) and covers all 19 consumers; the settings panel needs no separate call because `SettingsAllPanel` only mounts inside `SettingsDialog`'s `<Dialog>` | Verified by grep: every consumer renders through the primitive; `SettingsAllPanel` has one mount (`settings-dialog.tsx:521`) | S:85 R:95 A:95 D:90 |
| 5 | Confident | Bespoke `aria-modal` surfaces not on `dialog.tsx` also register: `theme-selector.tsx` and the modal (non-inline) variant of `cron-entry-detail-sheet.tsx` | Plan: "any bespoke modal gets its own call"; both carry `aria-modal` + a `fixed inset-0` backdrop, so they cover the stage exactly like a dialog; the inline sheet lives inside the already-registered quake drawer | S:75 R:95 A:85 D:80 |
| 6 | Confident | The quake drawer registers on its `open` mount flag rather than `machine === "open"` | The flag stays true through the exit slide, so the guest re-shows only once the drawer has left the stage; the machine flips to `rest` at the start of the close | S:70 R:95 A:80 D:75 |
| 7 | Confident | The screen-break egg registers for the whole flight (`flight !== null`), including the heal phase | The layer is `fixed inset-0` for the full 12 s timeline; a guest painting through the crack mid-heal defeats the effect | S:70 R:95 A:85 D:80 |
| 8 | Confident | The mobile drawer registers on `drawerActive` (`isMobile && sidebarOpen && !!sidebarChildren`) | The same predicate arms its focus trap; on desktop the sidebar is a grid column, not an overlay | S:80 R:95 A:90 D:85 |
| 9 | Certain | Transient popovers (tip, row flyout, marker pad, pin popover, swatch/theme popovers, compose-history flyout, status-bar/top-bar menus) do not register | Plan non-goal; the clip rule is change 4 | S:90 R:95 A:95 D:95 |
| 10 | Confident | Component tests read the real module (`_resetForTests()` then `count("modal")`/`isModalOpen()`); a spy on `acquire` is acceptable where an open path is hard to drive | Plan says "a mocked module"; reading the real module also proves import wiring and is the `screen-break-store` precedent; equivalent assertion strength | S:60 R:95 A:85 D:70 |
| 11 | Certain | The registry is inert without a subscriber — no behavior change for the iframe engine; the e2e smoke set is `command-palette.spec` + `operator-compose.spec` (one spec per run) | Plan § Change 2 item 4; project memory on `just test-e2e` filter semantics | S:90 R:95 A:95 D:90 |
| 12 | Confident | `release` is idempotent and the count never goes negative; listeners fire synchronously with no payload | StrictMode replays effects; a payload-free notify matches `screen-break-store.subscribe` and lets readers call `count` | S:65 R:95 A:90 D:85 |
| 13 | Confident | Memory lands in `run-kit/ui/dialogs-and-state.md` only (new § Overlay presence, toast placement line, one Design Decision); `lenses-and-layout.md` is untouched until change 3f consumes the signal | Plan § Change 2 item 5 names dialogs-and-state; the toast system is documented there (§ Error toast system) | S:80 R:95 A:90 D:85 |
| 14 | Certain | `change_type` is `feat` (a new registry + a placement change; no fix/refactor semantics) | Plan lane hint and description; pinned explicitly per project memory on re-inference | S:85 R:95 A:95 D:90 |

14 assumptions (7 certain, 7 confident, 0 tentative, 0 unresolved).
