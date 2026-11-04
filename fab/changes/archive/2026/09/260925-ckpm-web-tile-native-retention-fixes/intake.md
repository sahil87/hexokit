# Intake: Web Tile Native Retention Fixes

**Change**: 260925-ckpm-web-tile-native-retention-fixes
**Created**: 2026-09-25

## Origin

> web tile fixes — keep native views alive, raise the tab cap, blank new tab, menus above the native view. Ship all four as ONE PR.

Conversational origin, dispatched promptless (`/fab-proceed`-style create-new, questioning mode `promptless-defer`). The user had just confirmed the web-tile tunnel works end to end in the desktop app (remote-native mode over WebSocket, literal `localhost` URLs — PRs #1033/#1037/#1039 are on `main`), then reported four issues. The orchestrating session verified each root cause by reading the code before this intake was written. Decisions agreed in the discussion:

- **Fix 1 approach (user-approved):** retain native guest views across tile unmounts by PARKING them hidden in the Electron main process and ADOPTING them on remount — not destroying them. LRU cap of **4** parked views; the user was told a retained view costs 100–300 MB for a heavy app and accepted 4.
- **Fix 2:** raise the web-tab cap from 8 to **16** (backend `MaxWebTabs` and frontend `WEB_TAB_FAMILY_CAP`).
- **Fix 3:** a selected draft ("+") deactivates every frame and shows a blank new-tab panel.
- **Fix 4 approach (user explicitly chose "approach 1"):** hide the native view while a menu/dropdown/popover/context menu is open, exactly like modals. **Tooltips (`tip.tsx`) are excluded** (hiding on every hover would flicker the page — the user was told this). **The snapshot-swap approach (`capturePage` + static image in place of the live view) was REJECTED by the user — do not implement it.**
- All four fixes ship as ONE PR (explicit user request).

## Why

The desktop app renders web tiles through the **native engine**: an Electron `WebContentsView` ("guest") composited ABOVE the SPA's DOM (`app/frontend/src/components/web-frame-native.tsx`; main side `app/desktop/src/main.ts` `createWebView` ~L1292 / `destroyWebView` ~L1333 / IPC `web:create` ~L2575, `web:destroy` ~L2618, `web:visible` ~L2655; pure registry `app/desktop/src/web-views.ts`). Four user-visible defects follow from how that engine is wired today:

1. **Switching rk tabs reloads the web page (long black loading screen).** The native frame's mount-effect cleanup calls `destroyShellWebView(tabKey)` → main `destroyWebView` → `webContents.close()` (`web-frame-native.tsx` ~L299–303). The `tabKey` is minted fresh per mount (`web-${++mountSeq}`, ~L120–122), so nothing is reusable. When the user switches tmux windows / routes, the web tile unmounts and the guest renderer is destroyed; returning boots a brand-new page. For a Vite dev app that is hundreds of module requests, each crossing the tunnel — the long black load. Within one tile every tab's frame already stays mounted (P3 — hidden, never unmounted); only the tile's own unmount on a window/route switch loses state. Without the fix, the remote-native tunnel the user just adopted feels broken for any dev-server workflow: every tab switch costs a cold boot, and HMR/WebSocket/JS state is lost.
2. **An artificial 8-web-tab ceiling.** `MaxWebTabs = 8` (`app/backend/internal/tmux/tmux.go` L130–133) exists only because `ListWindows` reads window options through ONE fixed tmux format string that spells the `@rk_win_web_1..N` slots out; the frontend mirrors it as `WEB_TAB_FAMILY_CAP = 8` (`app/frontend/src/components/iframe-window.tsx` L120). 8 is too few for the user's workflow; 16 costs only more format-string fields.
3. **"+" (new draft tab) still shows the previous website.** A selected draft (`selectedDraft !== null` in `iframe-window.tsx`) only clears the address bar. The frames wrapper still renders each Engine with `active={i + 1 === activeIndex}` (~L1440), ignoring `selectedDraft`; in the native engine the previous guest stays visible on top of everything, so the "new tab" looks like the old site.
4. **Menus render BELOW the native view.** The overlay-presence registry (`app/frontend/src/lib/overlay-presence.ts`, `app/frontend/src/hooks/use-occludes.ts`) hides the native view only for `modal`-kind overlays (command palette, dialogs, quake drawer, theme selector, screen-break egg, mobile drawer, cron entry sheet, color picker). The `transient` kind is documented as "a later consumer; nothing registers it yet". So menus — e.g. the top-bar overflow/View menu (the user's screenshot: "Fixed width" / "Terminal font" drawn under the web page) — are painted under the guest and unusable over a web tile.

Alternatives considered and rejected: destroying and re-creating with an HTTP cache warm-up (does not preserve JS/HMR state, still slow over the tunnel); snapshot-swapping menus over a static `capturePage` image (rejected by the user); hiding on tooltip hover (rejected — flicker).

## What Changes

### 1. Retain native guest views across tile unmounts (park + adopt, LRU 4)

**Current flow:** tile mount → `web:create {tabKey, url, bounds…}` → main `createWebView` builds a `WebContentsView`, registers it in `web-views.ts` keyed by `(hostContentsId, tabKey)` with `(windowId, hostId)` carried alongside → tile unmount → `web:destroy {tabKey}` → `destroyWebView` → `webContents.close()`.

**New flow:**

- **Stable identity.** Each native frame carries a STABLE retention identity in addition to (or in place of) the per-mount `tabKey`. It must uniquely and stably name "this web tab as shown in this desktop window": at minimum the desktop BrowserWindow (a second desktop window on the same host needs its own guest), the host id, the tmux server, the tmux window id (`@N` — only unique per tmux server), and the web-tab URL slot value (the Engine is already keyed by `${engineKind}:${tabUrl}` in `iframe-window.tsx`, so a slot URL change already remounts). The plan decides the exact tuple and justifies it; the guest's own in-page navigation (tracked location drifting from the slot URL) does NOT change identity.
- **Park instead of destroy on a tile unmount.** When the frame unmounts because the TILE went away (window/route switch, layout change that drops the web tile, host switch within the desktop window), main hides the view (`setVisible(false)`, removed from the visible z-stack per the existing detach discipline) and moves it to a parked set keyed by the stable identity. The guest renderer keeps running: page state, JS state and WebSocket connections (e.g. Vite HMR) survive.
- **Adopt on remount.** A native frame mounting with an identity that matches a parked view ADOPTS it instead of creating a new one: re-bind it to the new frame's `tabKey`/sender, re-show it, re-apply bounds, re-send the chord table and zoom factor, and re-report the current title / favicon / tracked URL / canGoBack / canGoForward / loading state to the new frame so the chrome shows the right values without waiting for a navigation event.
- **LRU cap of 4 parked views.** At most **4** parked (hidden, not currently mounted) views; parking a fifth evicts (destroys) the least-recently-parked/used one. Mounted (visible or P3-hidden-within-a-mounted-tile) views do not count toward the cap. Put the pure parking / LRU / identity-matching logic in an electron-free module (extend `web-views.ts` or a sibling like it, following its opaque-handle-`H` pattern) so it is unit-testable under `node --test`.
- **Destroy immediately (never park)** when:
  - the tab itself is closed or removed from the window's web-tab family (the tile stays mounted; the Engine for that URL unmounts);
  - the tab's URL slot changes (Engine re-key);
  - the tmux window is killed;
  - the host is removed (existing `removeHostWebViewsEverywhere` path, main.ts ~L1153);
  - the desktop window closes (existing `win.on("closed")` teardown, ~L2892);
  - LRU eviction.
  The frontend's unmount cleanup therefore has to distinguish "tile going away" (park) from "this tab is gone" (destroy). The plan decides the mechanism — e.g. the owning `IframeWindow` telling the engine which unmount it is, or the SPA periodically reconciling the live set of identities (derived from its SSE window list) with main so that a parked view whose window/tab no longer exists is destroyed. <!-- assumed: park-vs-destroy discrimination mechanism left to the plan; reconciliation against the SSE window list is the likely shape because a killed window is only observable there -->
- **Existing hide rules still apply** to an adopted view: modal-overlay hiding (and the new menu hiding, § 4), `tileError`, drag-hide during tile moves, host switching (`hostDetachPlan`/`hostAttachPlan` — parked views of a detached host must stay hidden when that host is re-attached; only mounted views re-show).
- **Host SPA reload:** main already destroys every guest of a host webContents on its `did-navigate` (main.ts ~L1005–1013, "the fresh SPA re-creates what it mounts"). Keep that rule for parked views too (a reload is rare and resets the SPA's own state), unless the plan finds adoption across a reload is trivial with the stable identity. <!-- assumed: parked views die with a host SPA reload — keeps the existing did-navigate teardown rule; reload is rare -->
- **Precedent:** the code tile already retains frames across window switches with a per-server LRU (`app/frontend/src/components/surface-layout.tsx` retained code frames ~L274+, `code-surface.tsx`; memory `docs/memory/run-kit/ui/lenses-and-layout.md` code-frame retention, PR #990). Mirror its vocabulary (retained / evicted / LRU) where sensible. Unlike the code tile, native parking happens in the MAIN process — a hidden `WebContentsView` keeps its state with no DOM re-parenting (the iframe re-parent reload problem does not apply).
- **Scope: native engine only.** The iframe engine (browser, non-desktop) keeps its current behavior; retaining iframes across tile unmounts would need the code tile's DOM-retention machinery and is out of scope. <!-- assumed: native-only scope — the user reported the desktop app; the iframe engine has the DOM re-parent reload problem the code tile solved separately -->

### 2. Raise the web-tab cap from 8 to 16

- Backend: `const MaxWebTabs = 16` in `app/backend/internal/tmux/tmux.go` (L133). Everything that iterates `1..MaxWebTabs` follows automatically (`WebTabOption`/`WebTabRootOption` range checks, `webtabs.go` family read/parse, `tabaddr.go` `@N/web/<n>` bound, `api/windows.go` L429, `api/windows_web.go` 409 "web tabs full" + `mv` bound, `cmd/rk/tab_web.go` messages).
- **Hard-coded field offsets that do NOT follow the constant and MUST be updated (later fields shift):**
  - `app/backend/internal/tmux/layout.go` `parseLayoutWindows` (~L276–322): today "Fields 9..16 are the dense @rk_win_web_<n> slots … fields 17..24 their parallel roots", then `parts[24]` web_active, `parts[25]` code root, `parts[26]` marker, `parts[27]` role, `parts[28]` flair, `parts[29]` owner, `parts[30]` note, `parts[31:]` legacy note. With 16 slots: URLs = `parts[8:24]`, roots = `parts[24:40]`, active = `parts[40]`, code root `parts[41]`, marker `parts[42]`, role `parts[43]`, flair `parts[44]`, owner `parts[45]`, note `parts[46]`, legacy note `parts[47:]` — and every `len(parts) >= N` guard shifts by the same +16. Prefer deriving these offsets from `MaxWebTabs` (named constants) so the next raise is a one-line change; the plan decides.
  - `app/backend/internal/tmux/tmux.go` `parseWindows` (~L1588+) and the `ListWindows` format builder (~L1814 loop): the doc comment enumerates `@rk_win_web_1 .. @rk_win_web_8` and "25 tab-delimited fields"; the fields after the URL slots (web_active, code root, marker, role, flair, owner, note, retired `@rk_win_url`, retired `@rk_win_lens`, legacy note) shift by +8. Check every positional index after the slots.
  - `app/backend/internal/tmux/webtabs.go` uses `MaxWebTabs`-relative offsets (`2*MaxWebTabs`, `2*MaxWebTabs+1`, `2*MaxWebTabs+2`) — verify, no hand edit expected.
  - The present-root read (`/present/{server}/{roothash}/*`, "one `list-windows -a` call over the eight" roots) — verify it iterates `MaxWebTabs`.
- Layout snapshots persist parsed JSON (`internal/snapshot/snapshot.go` `webTabs`), not raw format lines, so on-disk snapshots stay compatible; restore iterates `win.WebTabs` (`restore.go` ~L354) and needs no change beyond accepting up to 16.
- Frontend: `const WEB_TAB_FAMILY_CAP = 16` in `iframe-window.tsx` (L120) — drives `stripFull` and the `web tabs full (N)` tip.
- Tests to update/extend: `tmux_test.go` (fixture lines with the web slots, `[MaxWebTabs]string` arrays, the positional fixtures after the slots), `layout_test.go`, `webtabs_test.go` (`WebTabOption(MaxWebTabs) == "@rk_win_web_16"`, the full-family test currently writing `/proxy/3001..3008/`), `tabaddr_test.go` (`"@1/web/9"` and `"9"` "above MaxWebTabs" cases → 17), `cmd/rk/tab_test.go`, `api/windows_web_test.go`, frontend `iframe-window.test.tsx` ("+ is disabled at the 8-tab family cap" → 16).
- Docs: `docs/specs/ui-state.md` (~L247 "`n ≤ 8`", `#{@rk_win_web_1}`…`#{@rk_win_web_8}`, "over the eight"), any other spec or memory line stating 8 (grep `MaxWebTabs`, "8 web", "eight"), the MCP `tab_web` docs if they state the bound.

### 3. "+" draft tab: no frame active, blank new-tab panel

- While `selectedDraft !== null`, EVERY Engine in the frames wrapper renders with `active={false}` — the native guest hides (visibility rule), iframe frames hide.
- The content area shows a minimal blank "new tab" panel instead of the previous page — reuse the empty/onboarding visual language already in `iframe-window.tsx` (the empty-tile panel with the "Open any URL" guidance) but keep it minimal.
- Frames stay mounted (P3): selecting a real tab again (click, keyboard, submitting a URL that lands in an existing slot) re-activates its frame WITHOUT reloading it. Submitting the draft adds a tab and activates the new frame as today.

### 4. Menus hide the native view (approach 1)

- While any menu / dropdown / popover / context menu that can overlap a tile is open, the native view is hidden, exactly as for modals.
- **Registration mechanism** — either register menus as `modal`, or make the native frame also hide on `transient` (subscribe to `count("transient")` alongside `isModalOpen()`) and register menus as `transient`. The plan picks the cleaner one and updates the `overlay-presence.ts` header doc (which currently says nothing registers `transient`) to state the rule.
- **Register every menu-class overlay** (find them all — grep popover/menu/dropdown components, `role="menu"`, `aria-haspopup`, `role="listbox"`, `onContextMenu`, `createPortal`, `FloatingPortal`). Known candidates from a first grep: `top-bar-overflow-menu.tsx` (the reported View menu), `open-button.tsx` (the "Open" code/editor split-button dropdown), the Split split-button (`top-bar.tsx`), `breadcrumb-dropdown.tsx` (window/board/session switchers), `layout-chip.tsx`, `surface-layout.tsx` tile-header menus, `sidebar/marker-pad.tsx`, `swatch-popover.tsx`, `sidebar/server-panel.tsx` / `host-panel.tsx` / `sidebar/index.tsx` portals (row menus), `gui-toolbar-menu.tsx` / `gui-wm-picker.tsx`, `theme-picker-list.tsx`, `status-bar.tsx`, `bottom-bar.tsx`, `terminal-client.tsx` context menu, `desktop-shell/titlebar-strip.tsx`, `compose-history-flyout.tsx`, `create-session-dialog.tsx` listbox, and any keybinding/settings popovers. The plan enumerates the final list; each registers via `useOccludes(kind, open)` above any early return.
- **Excluded:** tooltips (`tip.tsx`). **Not implemented:** snapshot-swap.
- Hover-opened flyout cards (sidebar `row-flyout-card.tsx`, opened by `useHover` with `safePolygon`) are EXCLUDED like tooltips (Assumption 17) — only click-opened menus/dropdowns/popovers/context menus register.

### Tests

- **Vitest:** draft deactivation (every Engine `active={false}` while a draft is selected; blank panel rendered; re-selecting a tab re-activates without remount); each registered menu acquires on open and releases on close (overlay-presence count); the 16-tab cap (`+` disabled at 16, enabled at 15).
- **Go:** 16-slot format string build + parse with field shifting for both `parseWindows` and `parseLayoutWindows` (a line with all 16 slots populated plus distinct values in every trailing field, asserting each trailing field lands correctly); short-line / older-capture tolerance.
- **Desktop unit (`node --test`):** pure park / adopt / identity match / LRU-4 eviction / destroy-on-close logic.
- **Desktop e2e (`app/desktop/tests/e2e/`, single specs):** (a) a web tab survives a tmux window switch and back WITHOUT reloading — prove it with a page-side random token or `performance.timeOrigin` set at load that is unchanged after returning; (b) opening a menu (e.g. the top-bar overflow menu) hides the native view and closing it restores it; (c) "+" hides the previous guest. Test Intent Comments (Proves / Steps JSDoc + file header) are required on every Playwright test (Constitution § Test Intent Comments).

### Docs

- `docs/specs/window-views.md`: native-engine retention (park/adopt, LRU 4, destroy triggers) and draft behavior.
- `docs/specs/ui-state.md` and any spec stating the 8-tab cap → 16.
- Memory updated at hydrate (see Affected Memory).

### Constraints

- Follow existing patterns (electron-free pure module + impure main glue; `useOccludes`; P3 hide-never-unmount).
- No new settings surface (Constitution IV): the LRU cap 4 is a named constant, not a setting.
- No AI attribution anywhere.

## Affected Memory

- `run-kit/desktop-shell`: (modify) native guest lifecycle — park on tile unmount, adopt on remount by stable identity, LRU-4 parked cap, destroy triggers; web-views registry shape
- `run-kit/ui/lenses-and-layout`: (modify) web tile — native retention across window switches, draft tab deactivates every frame + blank new-tab panel, web-tab cap 16
- `run-kit/ui/dialogs-and-state`: (modify) overlay presence — menus/popovers now register and hide the native view; tooltips excluded
- `run-kit/tmux-sessions`: (modify) `@rk_win_web_<n>` family bound 8 → 16 and the ListWindows format-string field layout
- `run-kit/layout-snapshots`: (modify) layout capture format string field layout with 16 web slots (if it documents the field positions)
- `run-kit/architecture/testing`: (modify) new desktop e2e/unit coverage for retention, menu hiding, draft hiding

## Impact

- **Desktop (Electron):** `app/desktop/src/main.ts` (web view create/destroy/park/adopt glue, IPC payloads), `app/desktop/src/web-views.ts` (+ tests) or a new electron-free sibling, preload/bridge typings for any new IPC or payload fields, `app/desktop/tests/e2e/` (new or extended spec(s)).
- **Frontend:** `web-frame-native.tsx` (identity, park-vs-destroy unmount, adopt state replay, transient hide if chosen), the shell bridge client (`destroyShellWebView` and siblings), `iframe-window.tsx` (draft deactivation, blank panel, cap 16), `lib/overlay-presence.ts` doc, and every menu/popover component listed in § 4 (+ tests).
- **Backend (Go):** `internal/tmux/tmux.go` (constant, `ListWindows` format, `parseWindows`), `internal/tmux/layout.go` (format + `parseLayoutWindows` offsets), tests across `internal/tmux`, `internal/tabaddr`, `cmd/rk`, `api`.
- **Docs:** `docs/specs/window-views.md`, `docs/specs/ui-state.md`, memory files above.
- **Memory/perf:** up to 4 hidden guest renderers alive (100–300 MB each for heavy apps) — accepted by the user.
- No new routes, no settings, no database; tmux option names unchanged (only more slots).

## Open Questions

- ~~Hover-opened flyout cards~~ — resolved (Assumption 17): excluded like tooltips.
- Which exact tuple forms the stable retention identity, and how does the SPA tell main "park" versus "destroy" on unmount (explicit signal from the owning tile vs. reconciliation against the live window/tab set)?
- Register menus as `modal`, or have the native frame also hide on `transient`?

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Ship all four fixes (retention, cap 16, draft blank, menu hiding) as one change and one PR | Discussed — user explicitly asked for one PR | S:95 R:85 A:95 D:95 |
| 2 | Certain | Fix 1 parks native guests hidden in the main process and adopts them on remount instead of destroying on tile unmount | Discussed — user approved the park/adopt approach; root cause verified in web-frame-native.tsx cleanup | S:95 R:70 A:90 D:90 |
| 3 | Certain | LRU cap of 4 parked views; evicting the least-recently-used destroys it; mounted views do not count | Discussed — user accepted the default of 4 after the memory-cost warning | S:90 R:85 A:90 D:85 |
| 4 | Certain | Destroy immediately on tab close or removal, URL slot change, window kill, host removal, desktop window close | Discussed — enumerated destroy triggers in the approved design | S:90 R:75 A:85 D:85 |
| 5 | Confident | Stable identity includes desktop window, host id, tmux server, tmux window id and slot URL; guest in-page navigation does not change it; plan finalizes the tuple | Description leaves the exact tuple to the plan; window ids are per tmux server and two desktop windows need separate guests | S:70 R:70 A:70 D:60 |
| 6 | Confident | Park on every tile unmount; destroy explicitly on tab close / URL-slot change / window kill signals the SPA already observes; parked views of windows that vanish without a signal are bounded by the LRU cap of 4 and age out. Reconciliation against the live window/tab set is an optional tidy-up, not a correctness dependency | Orchestrator decision 2026-09-25: the LRU cap already bounds memory, so the simplest correct design needs no new signal; reversible | S:65 R:70 A:70 D:65 |
| 7 | Confident | Parked views are destroyed on a host SPA reload (keep the existing did-navigate teardown rule in main.ts) | Existing main.ts rule; a reload re-mounts every tile anyway; adoption across a reload was not requested; reversible | S:60 R:70 A:70 D:65 |
| 8 | Confident | Retention is native-engine only; iframe engine behavior unchanged | User reported the desktop app; iframe retention needs the code tile's DOM machinery | S:65 R:75 A:70 D:65 |
| 9 | Certain | Pure park, adopt, identity and LRU logic lives in an electron-free module following the web-views.ts opaque-handle pattern with node --test coverage | Description and existing web-views.ts / views.ts precedent | S:85 R:85 A:85 D:80 |
| 10 | Certain | Web-tab cap raised to 16 in both MaxWebTabs and WEB_TAB_FAMILY_CAP, including every hard-coded field offset in parseWindows and parseLayoutWindows | Discussed — user asked for 16; offsets verified in layout.go and tmux.go | S:95 R:80 A:90 D:90 |
| 11 | Confident | Derive the post-slot field offsets from MaxWebTabs via named constants rather than new literal indices | Code-quality rule against magic numbers; makes the next raise one line | S:60 R:85 A:75 D:70 |
| 12 | Certain | On-disk layout snapshots need no migration (persisted as parsed JSON, not raw format lines) | Verified internal/snapshot/snapshot.go stores webTabs as JSON | S:80 R:85 A:90 D:90 |
| 13 | Certain | While a draft is selected every Engine gets active false and a minimal blank new-tab panel shows; re-selecting a tab re-activates without reload | Discussed — root cause verified at the frames wrapper active prop | S:90 R:85 A:90 D:90 |
| 14 | Certain | The blank new-tab panel reuses the existing empty-tile onboarding visual language, kept minimal | Description says reuse and keep minimal; exact copy is the plan's call | S:75 R:90 A:80 D:70 |
| 15 | Certain | Menus, dropdowns, popovers and context menus hide the native view while open; tooltips excluded; snapshot-swap not implemented | Discussed — user chose approach 1, excluded tooltips, rejected snapshot-swap | S:95 R:80 A:90 D:90 |
| 16 | Confident | Menu registration kind (modal versus native frame also hiding on transient) is chosen by the plan and documented in overlay-presence.ts | Description explicitly delegates it; both are valid with different semantic tradeoffs | S:60 R:80 A:60 D:40 |
| 17 | Confident | Hover-opened flyout cards (sidebar row flyout card and other useHover cards) are EXCLUDED like tooltips; only click-opened menus, dropdowns, popovers and context menus hide the native view | Orchestrator decision 2026-09-25 applying the user's stated rule: tooltips are excluded because hiding on hover would flicker the page, and hover cards share that trigger; reversible by registering them later | S:65 R:75 A:70 D:65 |
| 18 | Confident | Exhaustive menu inventory is built by the plan via grep (role menu, aria-haspopup, listbox, onContextMenu, portals); the intake list is a starting set | Description asks to find them all; first grep produced the candidate list | S:75 R:75 A:70 D:70 |
| 19 | Certain | No new settings surface; the LRU cap is a named constant | Constitution IV and discussion constraint | S:90 R:90 A:95 D:95 |
| 20 | Certain | Desktop e2e proves no-reload with a page-side load token or timeOrigin, plus menu hide and draft hide specs, each with Test Intent Comments | Discussed test plan; Constitution Test Intent Comments rule | S:90 R:85 A:90 D:85 |

20 assumptions (12 certain, 8 confident, 0 tentative, 0 unresolved).
