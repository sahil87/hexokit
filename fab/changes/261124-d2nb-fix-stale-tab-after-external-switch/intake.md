# Intake: Fix stale tab after an external window switch — single-owner viewed-window state

**Change**: 261124-d2nb-fix-stale-tab-after-external-switch
**Created**: 2026-11-24

## Origin

Conversational — a `/fab-discuss` session. The user reported:

> Sometimes when I do rk riff, the terminal shifts, but the Compose box keeps pointing to the older tab. So anything entered here goes to the earlier tab where I had typed `rk riff`

The agent traced the symptom to the window-switch "pending intent" machinery in `app/frontend/src/app.tsx` and proposed three local patches. The user pushed back: *"Think again — is there a simpler more elegant way to track this? Is this a two writers one state problem?"* That reframing was accepted: the fix is to give the viewed-window state a **single owner (tmux)** with the UI only *requesting* changes, instead of patching the lock between two writers. The user then asked to verify the stale-snapshot race (done — see § Race analysis) and write this intake.

## Why

**The pain.** On the home-tab terminal route, the terminal can show window B while the URL, heading and the Compose box still point at window A. Text submitted from Compose is delivered to A — a tab the user is not looking at, often a shell or agent where the input does real damage (a prompt typed into the wrong agent, a command run in the wrong worktree). It is intermittent, so the user can't trust Compose after any tmux-side switch.

**Root cause — two writers, two copies of one state.** "Which window is this terminal showing" exists twice:

| Copy | Writers | Readers |
|---|---|---|
| tmux's session-current window | `select-window`, `new-window` (`rk riff`), tmux status-bar clicks, other browsers / CLIs | **the PTY** — the home-tab relay attaches directly to the session, so it renders whatever tmux has current |
| the URL `$window` param | optimistic navigation (`navigateToWindow` / `navigateToWaitingTarget`) **and** the SSE URL writeback | **Compose** (`TerminalClient` registers `windowId` into `FocusedTerminalContext` → `sendToWindow(focused.server, focused.windowId, …)` at `app/frontend/src/components/compose-strip.tsx:721`), the center heading, sidebar selection |

The `pendingClickRef` intent + 5 s confirmation timer + failure bounce + freshness verdict + byte-gated confirmation in `app.tsx` is a **lock** reconciling those two writers. It leaks:

1. **POST 200 cancels the rescue timer.** `handlePostSettlement`'s `"confirm"` branch runs `clearTimeout(tracked.timer)` (`app.tsx:2867`). This contradicts `bouncePendingSwitch`'s own comment (`app.tsx:2738`: *"a POST-200 disarms the BOUNCE, never the rescue"*) — the 5 s silent-clear rescue never runs after a successful POST.
2. **The writeback holds the intent until a byte is counted.** `if (sseConfirmed && urlMatchesPending && !hasCountedIncomingBytes()) return;` (`app.tsx:3032`). The effect only re-evaluates on its deps (`activeWindow`, `sessionName`, `windowParam`, …), i.e. on the next SSE change for that session.
3. **The next SSE change is the external switch.** When `rk riff` makes its new window active, the writeback sees `urlMatchesPending && !sseConfirmed` → `return; // intent outstanding — let the URL stand` (`app.tsx:3051`). Every later snapshot hits the same branch. The URL is stuck until the user navigates.
4. **Most likely trigger: cold load / reload / deep link to a non-active tab.** The mount-time alignment path (`app.tsx` ~2966–2995) fires `selectWindow` + `beginPendingSwitch({posted})` with **no gate and no grace mask**, so no switch epoch is minted and no byte is ever counted; `bytesCounted` (`lib/window-transition.ts`) starts `false` on a fresh page. Steps 1–3 then make the hold permanent on every fresh page load that aligned tmux. A click switch where SSE outraces the first counted byte hits the same path less often.
5. **Secondary leak.** `dialogOpenRef` suppresses the writeback (`app.tsx:3007`) but is a ref, not a dep — closing the dialog does not re-run the effect, so an external switch during an open dialog also leaves the URL stale.

**If we don't fix it:** Compose misdelivers input after any tmux-driven switch; and patching the lock (un-cancel the timer, add a "post-confirm external switch" branch, make the dialog flag a dep) keeps the complex machinery that produced the leak. Backlog `[8wf7]` (a "Maximum update depth exceeded" render loop) independently names "the window-switch pending/confirm effects in app.tsx (pendingClickRef bounce machinery)" as a suspect — simplifying it may help there too (not an acceptance criterion).

**Why this approach.** Constitution II already names the owner: tmux is a durable source, *external writes win*, in-memory copies reconcile and yield. Making the URL a pure projection of tmux (plus a short-lived optimistic overlay) removes the second writer instead of locking it. Alternatives considered and rejected:

- **Patch the lock** (keep rescue timer on POST 200; treat "SSE confirmed, then a different window" as an external switch; make dialog-open a dep). Rejected as the primary fix — fixes today's leaks, keeps the two-writer design.
- **Per-browser isolated tmux session** (every home-tab terminal attaches via its own grouped session, like popouts) — the browser becomes the sole writer. Rejected: `rk riff` would no longer bring the new window into view, and tmux status-bar clicks / other browsers would stop converging. Following tmux is a feature (routes-and-shell § per-server convergence invariant).
- **Compose-only fix** (resolve the send target server-side to the session's current window). Treats the symptom; URL/heading stay wrong. Kept only as optional defense-in-depth (Open Questions).

## What Changes

### 1. Ownership rule

> **Whoever owns the attached session owns the window choice.**

- **Home-tab terminal route** (relay attached directly to the real session): **tmux owns** the viewed window. The URL `$window`, the center heading, sidebar selection and the Compose target are **projections** of tmux's active window for the session (SSE `activeWindow`, derived in `app.tsx` from `currentSession.windows.find(w => w.isActiveWindow)`).
- **Popout** (`popoutPosture`) and **isolated cross-tab tiles** (`_rk-iso-*` sessions): **the URL owns** — the window is fixed for the surface's lifetime, the session is rk-owned, there are no external writers. These paths are unchanged (they already early-return from alignment and writeback).

### 2. UI switches are requests, not writes

Every UI-initiated switch on the home-tab route — `navigateToWindow`'s `runSwitch` (sidebar, palette `Tab: Switch to …`, breadcrumb, SessionTiles), `navigateToWaitingTarget` (same-server), browser Back/Forward landing on a different `@N`, and the cold deep-link alignment — is a **request** to tmux via `selectWindow(server, windowId)` (`POST /api/windows/{windowId}/select`). The UI never treats its own navigation as truth.

### 3. Optimistic overlay — bounded, never held

To keep the instant feel (heading/URL flip at click = acknowledged intent; pessimistic navigation was rejected earlier — terminal.md § Design Decisions → "Window-switch feedback stays optimistic"), a switch request sets a short-lived **overlay**:

```ts
// replaces pendingClickRef + pendingSwitchRef tracking
type SwitchOverlay = { server: string; windowId: string; seq: number } | null;
```

- While the overlay is set, the URL/heading/Compose show `overlay.windowId` and the writeback does not override it.
- The overlay ends at the **first of**:
  - **SSE confirms** — the session snapshot reports `overlay.windowId` active.
  - **The first new session snapshot after the POST settles (200)**, whatever it says — it post-dates the select, so it is tmux truth (an external switch such as `rk riff` simply wins). The 200 carries `activeWindow` (`api/windows.go:256-270`); a mismatching `resp.activeWindow` ends the overlay at once and the URL follows it.
  - **Rejected / non-2xx** — end immediately, `navigate({replace:true})` to the SSE `activeWindow`, keep the existing error toast ("Tab switch didn't confirm — back to the active tab").
  <!-- clarified: corrected at plan time — ending at POST settle alone would bounce every click, because the client's snapshot is still the pre-select one until tmux's own %session-window-changed derive arrives (~300 ms debounce). The per-server receipt tick is NOT usable as the "new snapshot" signal: it bumps on every server-scoped event, not only sessions snapshots. -->
- The end is never "held" on paint: whether a terminal byte was counted plays no part.
- **Hard cap**: `selectWindow` in `api/client.ts:1092` has no client timeout, so the overlay also ends at a fixed deadline (reuse `CONFIRMATION_WINDOW_MS = 5000`) via one timer that is **only** cleared when the overlay ends — never on POST success. On expiry: clear the overlay and follow SSE (no toast — the switch outcome is unknown, tmux truth wins).
- A newer switch supersedes the overlay (monotonic `seq`; a stale POST settlement for an older `seq` is a no-op).
- The overlay must be **React state (or a ref + a state bump)** so that ending it re-runs the writeback — the current design's ref-only intent is exactly what lets the URL sit stale between snapshots.

Result: there is no state in which the UI holds a window that tmux doesn't, beyond one request plus one snapshot (hard-capped at 5 s). Any external switch after the POST settles (`rk riff`, tmux status bar, another browser) simply becomes the new projection.

### 4. URL writeback becomes unconditional projection

The writeback effect (`app.tsx` ~2998–3063) reduces to:

```ts
useEffect(() => {
  if (popoutPosture) return;
  if (!activeWindow || !sessionName) return;
  if (overlay && overlay.server === server) return;      // bounded optimistic window
  if (dialogOpen) return;                                // now a dep, not a ref (see §6)
  if (activeWindow.windowId === windowParam) return;
  navigate({ to: "/$server/$window", params: { server, window: activeWindow.windowId }, search: {}, replace: true });
}, [activeWindow, sessionName, windowParam, overlay, dialogOpen, server, popoutPosture, navigate]);
```

No `urlMatchesPending` / `sseConfirmed` / `hasCountedIncomingBytes` branches.

### 5. Paint feedback decoupled from window ownership

The first-write gate, grace mask, spinner mask and `bytesCounted` (`lib/window-transition.ts`) keep their byte-driven lifecycle for **paint** — but **never** gate where the URL points or how long the overlay lives. Specifically:

- `confirmSwitchArrived()` is called when SSE (or the POST response) shows the requested window active; it stays byte-gated as today.
- A mask with no byte-driven lift must still be torn down: on overlay end, if SSE/POST shows the requested window active, call `forceSwitchArrived()` after the existing deadline instead of relying on the removed bounce path. (Plan should keep the invariant "a stuck input-blocking mask is never possible".)
- `clearOnWindowChange` (`app.tsx:6205`, the deferred buffer clear on a UI-initiated ride) reads the overlay instead of `pendingClickRef`: `overlay?.server === server && overlay.windowId === windowParam`. A tmux/SSE-driven writeback carries no overlay, so the clear stays off — same semantics as today.

### 6. Dialog-open suppression re-evaluates on close

`dialogOpenRef` (`app.tsx:3312`) becomes a derived boolean in the writeback's deps (it is already computed every render from dialog state), so closing a dialog re-runs the projection and catches up to any switch that happened while it was open. The suppression itself is kept (it prevents focus-stealing re-renders mid-dialog).

### 7. Expected deletions in `app.tsx` / `lib/window-transition.ts`

- `pendingClickRef`, `pendingSwitchRef`, `beginPendingSwitch`, `bouncePendingSwitch`, `clearPendingSwitchTracking` → replaced by the overlay start/end functions.
- The freshness verdict + rearm (`resolvePendingSwitchVerdict`, `tickAtClick`, `postContradiction`, `bounceDisarmed`) and `resolvePendingSwitchPost` / `postConfirmsSwitch` if no longer needed (the POST's `activeWindow` is adopted directly).
- The writeback's `urlMatchesPending` / `sseConfirmed` / byte-gate branches.
- The three pending-switch teardown effects (server-change, route-leave, unmount) collapse to "end the overlay".
- The cold deep-link alignment keeps exactly one `selectWindow` and uses the same overlay (it no longer calls `beginPendingSwitch`).

Tests in `lib/window-transition.test.ts` covering deleted functions are removed or rewritten against the overlay; paint-gate tests stay.

### 8. Race analysis (verified in discussion)

- State snapshots are driven by tmux **control-mode events** (`%session-window-changed` etc.) through the hub in `app/backend/api/sse.go`, coalesced by `sseEventDebounce = 300ms`, with a `safetyPollInterval = 12s` net; `select-window` emits `%session-window-changed`.
- `handleWindowSelect` does not wake the hub; the select's own control-mode event triggers the next derive.
- **Hazard:** a derive that started *before* the select (triggered by an unrelated bump — e.g. agent rename churn) can publish *after* the POST response, carrying the pre-select active window. With §4's unconditional projection this flips the URL back to the old window for one snapshot, then the select's own event corrects it within ~300 ms + derive time. **Self-correcting flicker, not a stuck state.**
- Possible future guard (Q1 — deferred; the user accepted the flicker for v1): the hub already tracks a per-server control-mode generation (`sse.go` `Generation(server)`); the select response could return it and snapshots carry it, letting the client ignore pre-select snapshots for the projection.

### 9. Tests and evidence

- **Unit (Vitest, colocated)**: writeback/overlay behavior — (a) switch where SSE confirms before any byte, then an external switch → URL follows; (b) cold deep-link to a non-active tab, alignment POST 200, then external switch → URL follows; (c) POST rejection → URL returns to SSE active + toast; (d) POST hang → overlay ends at the deadline; (e) superseding switch ignores the older POST's settlement; (f) dialog open during external switch → URL catches up on close; (g) `clearOnWindowChange` true only for UI-initiated rides.
- **E2E (Playwright via `just test-e2e`)**: on the rig — deep-link to a non-active tab → external `tmux select-window` (or `new-window`) on the test socket → assert URL, heading and Compose `→ {window}` label follow, and a Compose send lands in the new window (verify by capture-pane). Existing window-switch specs (`window-switch-transition`, `sync-latency`, `window-heading`, …) must stay green.
- **PR evidence** (Constitution § PR Evidence): UI-observable bug → `just demo` before/after recording on desktop + mobile of: open tab A via deep link, run `rk riff`/`tmux new-window` in it, show Compose label/target follow the new window and a submitted line land there.

## Affected Memory

- `run-kit/ui/routes-and-shell`: (modify) § URL as Resumable Bookmark — writeback becomes an unconditional projection of tmux's active window with a bounded optimistic overlay; sidebar clicks are requests; the ownership rule (home-tab → tmux, popout/iso → URL); dialog-open suppression re-evaluates on close.
- `run-kit/ui/terminal`: (modify) window-switch feedback — pending-intent / confirmation timer / failure bounce / freshness verdict replaced by the overlay; paint gate and mask decoupled from ownership; `clearOnRide` reads the overlay; the stale-snapshot flicker note.

## Impact

- **Frontend**: `app/frontend/src/app.tsx` (switch, alignment, writeback, teardown effects, `clearOnWindowChange` prop — the bulk), `app/frontend/src/lib/window-transition.ts` (+ tests; delete pending-switch helpers, keep paint gate), no Compose changes (Q2 resolved: out of scope).
- **Backend**: none (Q1 resolved: no generation guard in v1).
- **Behavior contract**: the URL follows tmux at all times on the home-tab route except during one in-flight select request (≤ 5 s); the "Tab switch didn't confirm" toast fires only on an explicit POST rejection, never on timeout.
- **Risk**: the window-switch code is dense and heavily specified (several rework cycles, H1/G1/G2/F1/F3/SF5–SF8 notes). Server-scoped identity (`@N` unique per server) must be preserved in the overlay; cross-server navigation and popout must remain untouched.

## Open Questions

- **Q1 — stale-snapshot flicker**: accept the self-correcting sub-second flicker (§8), or add a guard — (a) after POST 200, ignore snapshots disagreeing with `resp.activeWindow` until one agrees or a short deadline (~1 s) passes, or (b) the control-mode generation guard (backend + frontend)?
  <!-- clarified: accept the self-correcting flicker in v1; no guard (user decision) -->
- **Q2 — Compose defense-in-depth**: should Compose's send target and `→ tab` label additionally read tmux's active window (or have the server resolve the session's current window at send time), or is the URL projection sufficient once it can no longer stick?
  <!-- clarified: out of scope; Compose keeps following the URL projection (user decision) -->

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Root cause is the leaking pending-intent lock (POST-200 cancels the rescue timer; byte-gated hold; external switch hits "intent outstanding" permanently) | Traced in discussion with exact lines (`app.tsx:2867`, `:3032`, `:3051`, `:2738`) | S:90 R:85 A:90 D:85 |
| 2 | Certain | Reframe as single owner (tmux) with UI switches as requests, not patch the lock | Discussed — user asked for the simpler two-writers framing and accepted it; Constitution II "external writes win" | S:95 R:60 A:85 D:85 |
| 3 | Confident | Ownership rule: home-tab route → tmux owns; popout and `_rk-iso-*` tiles → URL owns, unchanged | Discussed; these paths already early-return from alignment/writeback | S:80 R:75 A:80 D:80 |
| 4 | Confident | Overlay ends on POST settle regardless of outcome, adopting `resp.activeWindow`; hard cap at `CONFIRMATION_WINDOW_MS` via a timer never cleared on success | Discussed design; `selectWindow` has no client timeout so a cap is required | S:80 R:75 A:75 D:70 |
| 5 | Confident | Keep the error toast only on explicit POST rejection; deadline expiry follows tmux silently | Preserves existing failure feedback without a false toast when outcome is unknown | S:60 R:85 A:75 D:70 |
| 6 | Confident | Paint feedback (gate/mask/bytesCounted) kept but decoupled from ownership; no stuck-mask invariant preserved | Discussed — coupling intent to bytes is what made the hold stick | S:80 R:70 A:75 D:75 |
| 7 | Confident | Dialog-open suppression kept but made a writeback dep so close re-evaluates | Fixes the secondary leak while keeping the focus-stealing guard | S:70 R:85 A:80 D:75 |
| 8 | Confident | Delete pendingClickRef/beginPendingSwitch/bounce/verdict machinery rather than keep it alongside | Follows from #2; leaving it would retain the second writer | S:75 R:60 A:75 D:75 |
| 9 | Certain | Not a micro change; UI-observable fix requires `just demo` before/after evidence (desktop + mobile) and e2e via `just` recipes | Constitution § PR Evidence, Test Integrity; code-quality.md | S:90 R:90 A:95 D:95 |
| 10 | Confident | No backend change required for the core fix (select response already returns `activeWindow`) | Verified `api/windows.go:256-270` | S:80 R:85 A:90 D:80 |
| 11 | Certain | Stale-snapshot flicker (Q1): accept the self-correcting flicker in v1; no client hold, no generation guard | Asked — user chose to accept; race verified bounded to ~300 ms + derive | S:95 R:80 A:90 D:95 |
| 12 | Certain | Compose defense-in-depth (Q2) out of scope; Compose keeps reading the URL projection; `compose-and-bottom-bar` memory not affected | Asked — user chose URL-only (one source for every reader) | S:95 R:85 A:90 D:95 |

12 assumptions (5 certain, 7 confident, 0 tentative, 0 unresolved).
