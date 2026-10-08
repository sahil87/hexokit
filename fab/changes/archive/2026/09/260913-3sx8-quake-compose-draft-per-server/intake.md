# Intake: Quake terminal compose draft is per tmux server

**Change**: 260913-3sx8-quake-compose-draft-per-server
**Created**: 2026-09-14

## Origin

Promptless dispatch from `/fab-proceed` (team-lead → intake subagent, `{questioning-mode} = promptless-defer`), 2026-09-14. The lead synthesized the description below from a user bug report and a code-reading session; the user accepted the recommended fix with "go ahead".

> **Problem (user-observed, 2026-09-14):** The quake terminal (desktop ⌘J drawer) is supposed to be tmux-server scoped. The user typed text into the quake terminal's compose box while on one tmux server's route, navigated to a different tmux server's route, and the same text appeared in that server's quake compose box. The draft leaked across servers.
>
> **Root cause (verified in code):** the "shared compose seam" in `app/frontend/src/lib/quake-terminal.ts` holds ONE module-level `composeState: QuakeComposeState = { text, sending, uploading, error }` with no server dimension. `setOperatorComposeText(text)` and `useOperatorCompose()` take no server argument. Both consumers — the drawer's docked `QuakeCompose` strip (`components/quake-terminal.tsx`) and the top-bar `QuakeLauncher` (`components/quake-launcher.tsx`) — render `compose.text` from it. When the route's server changes the resolved `server` changes, but nothing re-keys or clears the text. Same defect for `error`: a failed send on server A displays under server B.
>
> **Decision (recommended, accepted with "go ahead"): Option 1 — reuse `lib/compose-draft-store.ts` for the quake compose TEXT, keyed by the operator window target `entryKey(server, target.window.windowId)`.** `sending` / `uploading` / `error` stay in the quake module but keyed per server. Success clears that target's draft via `clearComposeDraft(key)`. Rejected: Option 2 — a private per-server `Map<server, text>` inside `quake-terminal.ts` (smaller diff, no persistence, a second draft discipline to maintain).

Interaction mode: one-shot dispatch — no questions were asked; every judgment call is graded in `## Assumptions`.

## Why

**The pain point.** The quake terminal is the talk-to-the-operator surface, and every tmux server has its own operator. A draft is addressed to one operator; when the user changes server route, the drawer and launcher retarget to the new server's operator (the resolved `server` and `target` change), but the text they display does not. The user sees text they wrote for server A's operator sitting in server B's compose box — and pressing Enter would deliver it to the wrong operator. The inline error line has the same defect: a `409`/probe failure from a send on A renders under B, blaming the wrong operator.

**The consequence of leaving it.** Wrong-target sends are the worst outcome the compose surfaces can produce — the direct lane runs the full injection engine into the operator pane, and a message meant for one operator lands in another's TUI composer as a submitted prompt. Short of that, the leak breaks the per-server mental model the rest of the quake terminal enforces (chat subject is server-checked at send time; pinned/picked servers reset on navigation; window ids are server-scoped).

**Why re-key into the existing draft store rather than patch the quake module.** The route compose strip solved exactly this problem: `lib/compose-draft-store.ts` is a per-target draft map keyed by `entryKey(server, windowId)` — the store's own header states the principle, "drafts are keyed by their SEND TARGET … so a draft stays with its addressee instead of traveling with the user across routes". The quake compose's send target IS the operator window, so `entryKey(server, operatorWindowId)` is a natural key in the store's grammar, not a bent one. The quake terminal already writes into this store for its mobile arm (`setComposeText(entryKey(srv, windowId), detail.send)` at two sites in `quake-terminal.tsx`) — only the desktop seam skipped it. Reusing the store gives one draft discipline, refresh persistence (localStorage `runkit-compose-drafts` with age/cap pruning) for free, and honors Constitution IV (per-viewer state in localStorage). A private per-server map in the quake module would have fixed the symptom with a smaller diff but left two draft stores with two persistence postures to keep aligned.

**Why the in-flight flags and error do NOT move into the draft store.** `sending`, `uploading`, and `error` are not drafts — they are ephemeral in-flight facts about a send on a server, never persisted. They stay module state in `lib/quake-terminal.ts`, but gain the server dimension so a failure on A stays on A.

## What Changes

### 1. `lib/quake-terminal.ts` — the compose seam becomes target-keyed

**Text moves to the draft store.** The module-level `composeState.text` is removed. The draft key for the quake compose is the operator window target:

```ts
import { entryKey } from "@/store/window-store";
import { getComposeDraft, subscribeComposeDraft, setComposeText, clearComposeDraft } from "@/lib/compose-draft-store";

/** The draft-store key for the quake compose: the SEND TARGET (the operator
 *  window), the same grammar the route strip uses. null when no operator
 *  window resolves on the server — there is then nothing to address. */
export function operatorComposeKey(
  server: string | null,
  target: OperatorWindowTarget | undefined,
): string | null {
  if (!server || !target) return null;
  return entryKey(server, target.window.windowId);
}
```

**In-flight flags and error become per-server.** Replace the single `composeState` with a per-server map of flags; the listener set stays module-level:

```ts
export type QuakeComposeFlags = { sending: boolean; uploading: boolean; error: string | null };
const FLAGS_INITIAL: QuakeComposeFlags = { sending: false, uploading: false, error: null };
const composeFlags = new Map<string, QuakeComposeFlags>();   // keyed by server name

function flagsFor(server: string | null): QuakeComposeFlags   // stable object per server while unchanged; FLAGS_INITIAL for null/absent
function patchFlags(server: string, patch: Partial<QuakeComposeFlags>): void   // replace the server's object, notify listeners
```

Why per SERVER and not per target key: a server has exactly one operator window at a time (the server-scoped radio), and the flags describe a send against that server's operator; keying by server keeps the no-target case representable (an upload error can surface even when the target vanished mid-flight) and matches the description's accepted design.

**Public API — both consumers pass their resolved `server` + `target`:**

```ts
export type QuakeComposeState = { text: string } & QuakeComposeFlags;   // shape unchanged for consumers

/** Edit the draft for this target; any edit clears THAT server's inline error.
 *  No-op when no operator window resolves (key null). */
export function setOperatorComposeText(
  server: string | null,
  target: OperatorWindowTarget | undefined,
  text: string,
): void;

/** Subscribe to this target's draft text (from the draft store) + this
 *  server's in-flight flags. */
export function useOperatorCompose(
  server: string | null,
  target: OperatorWindowTarget | undefined,
): QuakeComposeState;
```

`useOperatorCompose` reads text through `useSyncExternalStore(subscribeComposeDraft, () => getComposeDraft(key).text)` (the store's stable-snapshot contract) and flags through the module listener set; the two are merged with a memo so the returned object is stable while neither input changed.

**`sendOperatorMessage(server, target, value)` — signature unchanged, body re-keyed:**

- Guard: `!server || !target || flagsFor(server).sending` → `false` (the in-flight guard is per server; a send on B while A is in flight is allowed).
- `patchFlags(server, { sending: true })`.
- On success: `clearComposeDraft(operatorComposeKey(server, target))` and `patchFlags(server, { error: null, sending: false })`. The global `text: ""` reset is gone — only the sent target's draft clears.
- On failure: `patchFlags(server, { error: message, sending: false })`; the draft is untouched (existing retry/edit contract).
- The chat-subject fork (`getOperatorChatTarget(server)`, templated vs direct lane) is untouched.

**`attachOperatorFiles(server, target, files)` — signature unchanged;** `uploading`/`error` patches go to `patchFlags(server, …)`.

**Module header comment** (`lib/quake-terminal.ts` lines ~38–41, "The shared compose seam … ONE draft/send/upload implementation") is updated to state the new invariant: the draft is per operator target in the draft store; flags are per server.

### 2. `components/quake-terminal.tsx` — the drawer's docked `QuakeCompose`

`QuakeCompose` already receives `server` and `target` as props. It calls `useOperatorCompose(server, target)` and `setOperatorComposeText(server, target, e.target.value)`. The `pendingSend` delivery (`void sendOperatorMessage(server, target, pendingSend)`) and the file handlers (`attachOperatorFiles(server, target, files)`) are unchanged.

**No-operator posture.** When `target` is `undefined` on the resolved server, `operatorComposeKey` is null: `useOperatorCompose` returns the stable empty draft and edits are no-ops. The textarea stays mounted and focusable (the drawer body already shows the Start-operator hint) but renders `readOnly` with the placeholder `Start the operator to compose…` so the user is not typing into a box that silently drops characters. Text typed on a server before its operator starts is not retained — sending was impossible there anyway.

### 3. `components/quake-launcher.tsx` — the top-bar standing box

The launcher resolves `{ server, target }` via `resolveQuakeTerminalTarget(...)` already. It calls `useOperatorCompose(server, target)` and `setOperatorComposeText(server, target, e.target.value)`; `textRef` keeps mirroring `compose.text`. Same no-operator posture: the `<input>` becomes `readOnly` when `target` is `undefined`. It MUST stay focusable — the standing box's `onFocus` is what steps the machine `rest → open` (the drawer then shows the Start-operator hint), so `disabled` is wrong here.

**Launcher vs drawer resolution.** The drawer's server is `pickerServer ?? pinnedServer ?? resolveQuakeServer(...)`; the launcher has no picker/pin and uses `resolveQuakeServer(...)` alone. They agree whenever the drawer opens (pick/pin are null at open and reset on navigation / at rest), so a draft typed in the standing box is the one the docked strip shows. After a pick/pin inside the open drawer the two may key different servers — by design (the draft follows the server), and the launcher is collapsed to glyph + chord while the drawer is open so no second input is visible.

### 4. `lib/compose-draft-store.ts` — comment-only

No behavioral change. The header comment's "at most one strip is mounted, so per-key channels would buy nothing" gains the quake compose as a second subscriber class (still one global listener set — notify-on-change is cheap). Quake drafts now count toward `MAX_PERSISTED_DRAFTS = 30` and age out under `MAX_DRAFT_AGE_MS`; no constants change.

### 5. Key sharing with the operator page's own compose strip (intended consequence)

The operator window's own route wears the quake surface as a page whose input is the route `ComposeStrip`, keyed by `entryKey(server, routeWindowId)` — which for the operator route IS `entryKey(server, operatorWindowId)`, the quake key. A draft typed in the drawer on a server route therefore reappears in the operator page's strip after `⤢ open as tab`, and vice versa. This is the "keyed by SEND TARGET" principle working as intended (the mobile arm already relies on it: `setComposeText(entryKey(srv, tgt.window.windowId), detail.send)` seeds the page strip). The drawer never opens on the operator route, so the two views of one draft are never on screen together.

### 6. Tests

**New Vitest coverage in `lib/quake-terminal.test.ts` ("shared compose seam")** — the bug's regression case on the seam itself:

- `setOperatorComposeText("srvA", targetA, "for A")`; `renderHook(() => useOperatorCompose("srvB", targetB))` reads `text === ""`; re-render with `("srvA", targetA)` reads `"for A"`.
- A failed `sendOperatorMessage("srvA", targetA, …)` sets `error` for A; `useOperatorCompose("srvB", targetB).error === null`; an edit on A clears A's error.
- A successful send on A clears only A's draft — a pre-set B draft survives.
- A send on B is not blocked by an in-flight send on A.
- No-operator: `useOperatorCompose("srvA", undefined).text === ""` and `setOperatorComposeText("srvA", undefined, "x")` is a no-op.

**Existing tests updated for the new signatures** (every call site today is the zero-arg/one-arg shape): `lib/quake-terminal.test.ts` (the `beforeEach` reset + 6 seam cases), `components/quake-terminal.test.tsx` (`setOperatorComposeText("")` resets in 6 `beforeEach` blocks + the "half-written" draft case), `components/quake-launcher.test.tsx` (`beforeEach` reset + the "half-written draft" case). Test isolation resets the draft store the way `lib/compose-draft-store.test.ts` does — `localStorage.clear()` then `hydrateComposeDrafts()` — plus clearing the per-server flags (an exported test-only reset, or a `setOperatorComposeText` + resolved awaits, whichever the existing store exposes).

**Component tests** in `quake-terminal.test.tsx` / `quake-launcher.test.tsx`: one case each that renders with server A, types, re-renders with server B's route, and asserts the textarea/input is empty.

**E2E** (`app/frontend/tests/e2e/quake-terminal.spec.ts`, fully mocked over the state-socket, no tmux): one `test()` with the mandatory Proves/Steps JSDoc that seeds a two-server sessions payload (each with a `role: "operator"` window), types into the docked compose on server A's route, navigates to server B's route, asserts the compose is empty, navigates back, asserts the text is back. If the state-socket mock cannot carry two servers without disproportionate fixture work, unit coverage suffices (see Assumptions).

### 7. Out of scope

- The mobile arm (route compose strip, `?from=` chip, `setComposeText` seeds) — already keyed.
- The chat-subject store (`setOperatorChatSubject`, `getOperatorChatTarget`, chip) — already server-checked at send time.
- Pushing quake sends into `pushComposeSentHistory` (so the operator page's ↑ recalls them) — a feature, not this fix.
- A server-only synthetic draft key for the no-operator case — rejected as bending the store's `server:windowId` grammar.

## Affected Memory

- `run-kit/ui/quake-terminal`: (modify) § *One shared compose seam* — draft is per operator target in the compose-draft store, flags/error per server (a draft typed under A never renders under B); § *Send errors surface inline, text preserved* — error is per server; § *Availability degrades to absent* — the read-only no-operator compose posture; Design Decision *Compose docks in the drawer* — its "the seam itself is untouched … draft, in-flight flags, and the inline error stay module state" clause is superseded; new Design Decision recording the store reuse over a private per-server map.
- `run-kit/ui/compose-and-bottom-bar`: (modify) § *Drafts are per-target and survive refresh* / Design Decision *Drafts are keyed by entryKey* — the quake compose (drawer + launcher) is a second consumer of `lib/compose-draft-store.ts`, keying by the operator window; quake drafts share the operator page strip's key and count toward the 30-draft cap.
- `run-kit/ui/top-bar`: (modify, light) § quake launcher — the standing box's draft is server-keyed and read-only when no operator resolves.

## Impact

**Code** (all `app/frontend/src/`):
- `lib/quake-terminal.ts` — seam rewrite (~60 lines around 655–750): remove `composeState.text`, add `operatorComposeKey`, per-server flags map, new `useOperatorCompose`/`setOperatorComposeText` signatures, re-keyed `sendOperatorMessage`/`attachOperatorFiles`.
- `components/quake-terminal.tsx` — `QuakeCompose` call sites (~1335, ~1429–1434) + `readOnly`/placeholder.
- `components/quake-launcher.tsx` — call sites (~97, ~236–240) + `readOnly`.
- `lib/compose-draft-store.ts` — header comment only.
- Tests: `lib/quake-terminal.test.ts`, `components/quake-terminal.test.tsx`, `components/quake-launcher.test.tsx`, `tests/e2e/quake-terminal.spec.ts`.

**Behavior visible to users:** quake drafts persist across page refresh (new — a consequence of the store); a draft typed in the drawer shows in the operator page's compose strip and vice versa (new, intended); the compose box is read-only on an operator-less server (new). No backend, API, tmux, or route changes. No new localStorage key.

**Verification gates:** `just test-frontend` (Vitest), `just test-e2e quake-terminal.spec` (single spec — the worktree is named `driven-polecat`, so a bare filter is safe here but pass the `.spec` suffix anyway), `cd app/frontend && npx tsc --noEmit`.

## Open Questions

None blocking. The two softest calls — the read-only no-operator posture (Assumptions #5) and whether the two-server e2e is worth its fixture cost (Assumptions #9) — are graded Confident with a stated fallback each; `/fab-clarify` can revisit them.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Reuse `lib/compose-draft-store.ts` for the quake compose TEXT, keyed `entryKey(server, target.window.windowId)` (Option 1); reject a private per-server `Map<server, text>` in the quake module (Option 2) | Discussed — user accepted the recommendation with "go ahead"; the store's own header names SEND TARGET keying as its principle and the mobile arm already writes this key | S:95 R:70 A:90 D:90 |
| 2 | Certain | `sending` / `uploading` / `error` stay module state in `lib/quake-terminal.ts`, keyed per SERVER in a map (not per target key, not in the draft store) | Description mandates per-server flags; in-flight facts are not drafts; one operator per server makes server the natural key and keeps the no-target case representable | S:90 R:85 A:85 D:85 |
| 3 | Certain | Success path clears only the sent target's draft via `clearComposeDraft(key)`; failure leaves the draft for retry/edit; any edit clears that server's error | Existing seam contract (memory § Send errors surface inline) carried over with the server dimension added | S:90 R:90 A:90 D:90 |
| 4 | Confident | Seam API takes `(server, target)` — `useOperatorCompose(server, target)`, `setOperatorComposeText(server, target, text)` — with an exported `operatorComposeKey(server, target)` helper, rather than callers computing keys | Both consumers already hold the resolved pair; keeping the key derivation inside the module mirrors how `sendOperatorMessage` already takes `(server, target)` | S:60 R:90 A:80 D:65 |
| 5 | Confident | No-operator posture: key null ⇒ stable empty draft, edits are no-ops; the drawer textarea and launcher input render `readOnly` (not `disabled` — the launcher's `onFocus` drives `rest → open`) with a Start-operator placeholder; text typed before Start operator may be lost | Description accepts "empty, non-editable-or-transient"; the route strip precedent disables with no target, but the launcher must stay focusable, so `readOnly` is the consistent choice | S:50 R:85 A:55 D:45 |
| 6 | Confident | Sharing the draft key with the operator page's own compose strip (`entryKey(server, operatorWindowId)`) is intended: drawer draft ⇄ operator-page strip draft | Direct consequence of SEND-TARGET keying; the mobile arm already seeds the page strip through this exact key; the two views are never on screen together | S:55 R:80 A:75 D:70 |
| 7 | Confident | Launcher and drawer each key by their OWN resolved server; divergence is possible only after a drawer pick/pin, while the launcher is collapsed | Pick/pin are null at open and reset on navigation / at rest, so the standing box and docked strip agree whenever both matter | S:55 R:85 A:70 D:70 |
| 8 | Certain | Tests: new Vitest seam cases (A text / B empty / back to A; A error invisible on B; A success leaves B's draft; per-server in-flight guard; no-target no-op) plus signature updates across the three existing test files; store reset via `localStorage.clear()` + `hydrateComposeDrafts()` | code-quality.md: bug fixes MUST include tests; the isolation idiom is the one `compose-draft-store.test.ts` already uses | S:85 R:90 A:95 D:90 |
| 9 | Confident | Add one two-server e2e `test()` (Proves/Steps JSDoc) to `quake-terminal.spec.ts` using its fully-mocked state-socket payload; fall back to unit-only if the mock cannot carry two servers without disproportionate fixture work | Description: "desirable if the rig supports two tmux servers"; the spec needs no tmux at all, so feasibility hinges only on the mock's payload shape | S:60 R:90 A:55 D:50 |
| 10 | Certain | Scope: mobile arm and chat-subject store untouched; no `pushComposeSentHistory` for quake sends; no server-only synthetic key | Description's scope boundaries and rejected alternatives, restated | S:90 R:85 A:90 D:90 |
| 11 | Certain | `change_type` is `fix`; hydrate touches `ui/quake-terminal`, `ui/compose-and-bottom-bar`, `ui/top-bar` (light); no AI attribution in commits/PRs | Dispatcher pinned the type; user CLAUDE.md forbids attribution; memory files located by grepping the seam's prose | S:95 R:95 A:95 D:95 |
| 12 | Confident | The in-flight `sending` guard is per server: a send on B proceeds while A's send is in flight | Consistent with per-server flags; the guard exists to stop a double-submit of ONE draft, which is per target | S:50 R:90 A:75 D:65 |

12 assumptions (6 certain, 6 confident, 0 tentative, 0 unresolved).
