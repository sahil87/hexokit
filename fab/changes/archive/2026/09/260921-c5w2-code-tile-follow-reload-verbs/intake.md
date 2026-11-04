# Intake: Code Tile Header Verbs — Follow Terminal + Reload Editor

**Change**: 260921-c5w2-code-tile-follow-reload-verbs
**Created**: 2026-09-22

## Origin

Conversational — a `/fab-proceed` create-new dispatch (promptless) after a discussion that diagnosed the "code tile points at the old folder" complaint and settled the shape of the fix. The synthesized description handed to intake:

> **Problem**: linking code-server with run-kit feels finicky. Concretely: the user switches branch/worktree in the terminal (e.g. `wt` creates and cds into a new worktree) and the code tile keeps pointing at the older folder. The user wants a reset button on the code tile's top bar so that when anything goes wrong with code-server they can force a full reload of the editor.
>
> **Diagnosis agreed**: the "old folder" is not a bug but the deliberate latch rule (change 260813-if5d, shared option `@rk_win_code_root`, iip5): the editor's folder is seeded once from the active pane's cwd at the code tile's first render and the terminal never moves it afterwards, because agents `cd` constantly and a live derivation would swap the workbench and lose open tabs/dirty buffers. The only writer today is the editor's own File > Open Folder (the follow path). The memory records "Stale roots are accepted … no reset verb, no palette entry" as a decision. New evidence that revisits it narrowly: worktree switches (`wt`) leave the tile on the old worktree and File > Open Folder is too buried to be a practical escape.
>
> **Decisions**: (1) add TWO small verbs to the code tile's header verb cluster — **Follow terminal** (rendered only when the latched root differs from the live derivation; clicking re-seeds `@rk_win_code_root` from `gitRoot` and rides the EXISTING follow path — `setWindowOptions`, workspace re-fetch, nonce-keyed `followSrc` re-navigation via the same `handleCodeFolderNavigated` machinery; the pending-follow target must be recorded so the LRU treats it as a follow, never an eviction; the verb's presence IS the drift indicator) and **Reload editor** (always present when a code frame is mounted; reloads the ACTIVE window's frame only via the same `contentWindow.location.reload()` seam the first-boot rescue uses; retained LRU frames untouched; CodeSurface needs an imperative reload seam shaped like the `followSrc` nonce). (2) KEEP the `?workspace=` URL form and the latch paradigm — `?workspace=` carries `rk.tab`/`rk.server`, the only per-window channel into the extension host; a `?folder=` boot registers tab-less and hides the run-kit actions; the verb only adds a second writer beside File > Open Folder. (3) Memory: supersede the "Stale roots are accepted … no reset verb" bullet and the "Two sanctioned parent re-navigations" decision; record the rationale (worktree switching + buried escape) in Design Decisions, present-truth style.
>
> **Rejected**: a true code-server PROCESS restart from the tile (no `rk code-server restart` verb or daemon route exists; it would kill every workbench on every tab — out of scope; if ever wanted, a palette entry with confirm, not a header verb); falling back to `?folder=` boots (drops tab identity); live derivation following the terminal (moves the editor on every `cd` — the original problem); a blind reload of all retained frames.
>
> **Constraints**: P3 "hide, never unmount" — neither verb may unmount/remount the iframe or rewrite the `src` attribute reactively; only the two sanctioned mechanisms (followSrc re-navigation, `contentWindow.location.reload()`). Frontend gate is the FULL `just test-frontend`; e2e single specs only (`just test-e2e code-folder-latch.spec`, `code-surface.spec`). Extend `code-folder-latch.spec.ts` (drift → verb appears → click → `@rk_win_code_root` equals the pane's git root via `_tmux.ts` `windowOption` → verb disappears) and add a reload-verb test in `code-surface.spec.ts` (the stub code-server load counter). No AI attribution anywhere. Follow the existing verb naming/label conventions in surface-layout.tsx.
>
> **Deliberately open**: exact glyphs for the two verbs; whether a palette entry should mirror the verbs (default: header verbs only); whether the follow verb should also show when the frame sits on a `?folder=` degrade URL.

Intake was grounded against the present code and memory before writing: `docs/memory/run-kit/ui/lenses-and-layout.md` (§ Code Surface, § The code root, the Design Decisions on the latch, the mount-generation rule, the two sanctioned re-navigations, the frame LRU and the pending-follow target), `docs/memory/run-kit/code-bridge.md` (§ Tab identity — why `?workspace=`), `components/code-surface.tsx`, `components/surface-layout.tsx`, `app.tsx`, `lib/code-folder-latch.ts` (+ test), `hooks/use-code-workspace.ts`, `lib/palette/layout.ts`, and the e2e specs `code-folder-latch.spec.ts` / `code-surface.spec.ts`.

## Why

**The pain.** The code tile's folder is the shared per-window option `@rk_win_code_root`, seeded once from the active pane's derived `gitRoot` the first time the tile renders and then owned by the editor's own navigation. That rule is correct for the common case — agents `cd` constantly and a live derivation would swap the workbench under the user, losing open tabs, dirty buffers and undo stacks (memory § Design Decisions → "Derivation seeds the code root once; only the editor moves it"). But a **worktree switch** is a different kind of movement: `wt` creates a sibling worktree and `cd`s into it, and from then on the terminal and the editor are looking at two different checkouts of the same repo. Nothing in the UI says so — the tile header still shows the old basename, the verb cluster looks identical, and the only escape is File > Open Folder inside the workbench (buried, and it drops to a bare `?folder=` URL that the follow rule then has to repair). The memory even records the gap as a decision: "Stale roots are accepted … No liveness probe, no reset verb, no palette entry."

**The second pain** is unrelated to folders: when code-server misbehaves in the frame (a stuck workbench, a disconnected extension host, a half-loaded `NO FOLDER OPENED` boot the rescue did not catch) there is no user-initiated way to reboot ONE editor. A full page reload re-boots every tile and every retained frame; closing and reopening the tile does not remount the iframe (P3 keeps it hidden, not unmounted — and the LRU retains it on purpose).

**If we do nothing**, drift stays silent and the user keeps editing the wrong worktree until a save fails to show up in the terminal's `git status`; and every code-server hiccup costs a full page reload.

**Why this shape.** Two header verbs on the code tile, reusing mechanisms that already exist and are already sanctioned:

- *Follow terminal* is a SECOND WRITER of `@rk_win_code_root` beside File > Open Folder (and the CLI twin `rk tab code set`) — an explicit, user-initiated re-seed from the live `gitRoot`. It rides the existing follow path end to end (`setWindowOptions` → `followFolder` re-derivation → nonce-keyed `followSrc` re-navigation of the live frame; the pending-follow target recorded synchronously so the frame LRU reads the option write as a follow, never an eviction). The latch paradigm is untouched: the terminal still never moves the editor on its own — a human does, with one click. Rendering the verb only when the two roots differ turns the drift itself into a visible signal, with zero cost when there is none.
- *Reload editor* is a user-initiated sibling of the first-boot rescue's `contentWindow.location.reload()`: it reboots the ACTIVE window's frame only, keeps the `?workspace=` URL (hence the `rk.tab`/`rk.server` identity), never writes `src`, never unmounts, and leaves the other retained frames alone.

Rejected shapes and why (all agreed in conversation): a code-server PROCESS restart from the tile (no `rk code-server restart` verb or daemon route exists; it would kill every workbench on every tab — server-side terminals, hot-exit state; if ever wanted it is a confirm-gated palette entry, not a header verb); a return to `?folder=` boots (drops tab identity — the bridge host registers tab-less and hides the run-kit actions; `?workspace=` exists precisely to carry `rk.tab`/`rk.server`, the only per-window channel into the extension host); live derivation following the terminal (the original problem); a blind reload of every retained frame (destroys state in frames the user did not ask to touch).

## What Changes

### 1. Pure predicate — `lib/code-folder-latch.ts`

Add one exported helper beside `codeRootFor` / `codeRootSeed`, in the same "null means no write" shape as `codeRootSeed`:

```ts
/**
 * The follow-terminal verb's target: the live derived `gitRoot` when the
 * latched code root has DRIFTED from it — both non-empty and different —
 * else `null` (no drift ⇒ no verb, nothing to write). Empty inputs never
 * count as drift: a pre-seed window (`codeRoot` empty) is about to be seeded
 * from `gitRoot` anyway, and an empty derivation (no cwd resolvable) has no
 * folder to follow.
 */
export function codeRootFollowTarget(win: ViewWindow | null | undefined): string | null {
  const latched = win?.codeRoot ?? "";
  const derived = win?.gitRoot ?? "";
  return latched !== "" && derived !== "" && latched !== derived ? derived : null;
}
```

Colocated unit tests in `code-folder-latch.test.ts` cover: drift ⇒ `gitRoot`; equal roots ⇒ `null`; empty `codeRoot` ⇒ `null` (pre-seed); empty `gitRoot` ⇒ `null`; `null`/`undefined` window ⇒ `null`. The module's header comment gains one sentence: after the seed, the writers of the latch are the editor's own navigation AND the explicit follow-terminal verb — the terminal still never moves it on its own.

### 2. `CodeSurface` — an imperative reload seam shaped like `followSrc`

`components/code-surface.tsx` gains one optional prop:

```ts
/** User-initiated reload (the header's Reload editor verb): a nonce not seen
 *  before by THIS instance runs one `contentWindow.location.reload()` —
 *  the rescue's seam — which keeps the frame's URL and tab identity and
 *  never writes `src`. The value present at mount is pre-seen (a mount IS a
 *  fresh boot); an already-seen nonce (every ordinary re-render) is inert.
 *  Absent ⇒ no reload path. */
reloadNonce?: number;
```

Implementation: a `reloadNonceRef` initialised to the mount-time prop value; an effect keyed on `[reloadNonce]` that, when the prop is a number different from the ref, records it and calls `iframeRef.current?.contentWindow?.location.reload()` inside the same try/catch posture the rescue uses (a cross-origin or pre-load frame skips silently). The iframe must be mounted (`reachable && src !== null`) — a nonce arriving while the tile is pending or unreachable is recorded as seen and does nothing (there is no frame to reload; the next mount is a fresh boot anyway). The reload is transparent to the first-boot rescue: it does not change `src`, so it opens no new mount generation; a settled generation ignores the extra `load`, and an unsettled one at most re-arms its existing wait timer (the `arm` guard). The chord-reclaim / focus listeners re-attach on the `load` exactly as they do after the rescue's reload.

Unit tests in `code-surface.test.tsx` (the existing `stubReload` contentWindow spy): a nonce change ⇒ exactly one `reload()`; the same nonce re-rendered ⇒ no second call; a nonce present at mount ⇒ no call; a nonce while `reachable=false` ⇒ no call and no throw.

### 3. `SurfaceLayout` — two code-tile header verbs + the palette command seam

`components/surface-layout.tsx`, in the header's verb row (the `kind === "gui"` fullscreen verb is the structural precedent: a per-kind content verb, any arity, rendered before the layout-verb cluster with a hairline between). New block for `kind === "code" && slot >= 0` (visible tile only — a retained hidden frame renders no header):

```tsx
{kind === "code" && slot >= 0 && (codeFollowTarget !== null || codeFrameMounted) && (
  <>
    {codeFollowTarget !== null && (
      <Tip label={`Follow terminal — reopen the editor at ${basename(codeFollowTarget)}`}>
        <button type="button" aria-label="Follow terminal" disabled={codeFollowInFlight}
          onClick={() => requestCodeFollow(windowId, codeFollowTarget)}
          className={`${VERB_BUTTON_CLASS} hover:text-text-primary`}>
          <FollowTerminalGlyph />
        </button>
      </Tip>
    )}
    {codeFrameMounted && (
      <Tip label="Reload editor — reboots this tab's workbench">
        <button type="button" aria-label="Reload editor"
          onClick={() => setCodeReload((r) => ({ windowId, nonce: (r?.nonce ?? 0) + 1 }))}
          className={`${VERB_BUTTON_CLASS} hover:text-text-primary`}>
          <RefreshGlyph />
        </button>
      </Tip>
    )}
    {showVerbs && <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border" />}
  </>
)}
```

- `codeFollowTarget = codeRootFollowTarget(win)` (the ACTIVE window's payload record — the verb is never offered for a retained frame). Its presence is the drift indicator; no other badge or copy.
- `codeFrameMounted = codeReachable && codeFrames.some((r) => r.windowId === windowId)` — a frame record exists only once the active window's src resolved and the iframe mounted; pending or unreachable tiles show no Reload verb (nothing to reload).
- Order, left to right: Follow terminal (conditional) · Reload editor · hairline · the layout verbs (Expand/Restore, Promote, Swap, hairline, Close). The verb cluster is right-aligned, so the conditional verb appearing never shifts Reload editor or the layout verbs.
- Chrome: `VERB_BUTTON_CLASS` (24×24 / 26×26 coarse) + `Tip` + `aria-label`, same hover tokens as Promote/Swap (`hover:text-text-primary`, not the destructive red). Tip copy follows the "Verb — consequence" shape of `Close pane — kills the tmux pane`; the accessible name is the bare verb (`Follow terminal`, `Reload editor`) — that is what tests and the palette rows reference. Both verbs render on desktop and mobile alike (mobile's slot-A single tile has header room; the `coarse:` sizing is already in `VERB_BUTTON_BASE`).
- **Follow-terminal path — factor the existing wrapper**: the inline `onFolderNavigated` wrapper (records `pendingCodeFollowRef.set(frameWindowId, folder)` synchronously, then `Promise.resolve(onCodeFolderNavigated?.(folder)).catch(clear-target)`) becomes a named `requestCodeFollow(frameWindowId, folder)` used by BOTH the editor-initiated seam and the new verb, so the LRU's follow-vs-eviction rule (§ Design Decisions → "A follow's pending target is recorded synchronously before the latch POST") covers the verb by construction. A `codeFollowInFlight` state disables the verb from click to promise settle — the payload still reads the OLD root until the option tick, so without it a second click would re-POST and produce a second nonce/re-navigation. The parent's `handleCodeFolderNavigated` guard (`folder === codeRootFor(effectiveWindow)` ⇒ no-op) passes because drift means they differ.
- **Reload path**: `codeReload: { windowId: string; nonce: number } | null` component state; each frame receives `reloadNonce={frame.windowId === codeReload?.windowId ? codeReload.nonce : undefined}` — a retained frame that later becomes active receives `undefined` until its own verb is clicked, and a freshly created frame pre-sees whatever value is current at mount (§ 2), so switching windows or evicting/re-creating frames can never replay a reload. Only the active window's frame can ever be targeted (the verb sits on the visible tile).
- **Palette command seam** (Constitution V — every UI control must be palette-reachable; the LRU decision already notes "if one is ever added it registers in the palette"): SurfaceLayout fills an optional `codeCommandsRef?: MutableRefObject<CodeTileCommands | null>` (the `guiCommandsRef` precedent) with `{ followTerminal(): void; reload(): void }` bound to the same internal functions the header verbs call; `null` while no code tile is visible.

Unit tests in `surface-layout.test.tsx`: the Follow verb renders iff the active window's `codeRoot` and `gitRoot` are both non-empty and differ (no verb when equal, when `codeRoot` is empty, or on a retained frame's hidden wrapper); the Reload verb renders iff the active window's frame record exists and `codeReachable`; clicking Follow calls `onCodeFolderNavigated` with `gitRoot` and disables until the returned promise settles; clicking Reload increments the nonce the active frame's `CodeSurface` receives (assert via the contentWindow reload spy) and leaves a retained frame's spy untouched.

### 4. `app.tsx` — the follow degrade and the palette rows

- `handleCodeFolderNavigated` is reused unchanged as the follow's write half. Its re-derivation half, `followFolder` in `hooks/use-code-workspace.ts`, gains an option so the verb never leaves the editor and the option disagreeing: `followFolder(folder, { degradeToFolder?: boolean })` — when set and the workspace GET fails (non-`ok`, non-409 error), the follow lands on `codeServerSrc(folder)` (`/code/?folder=…`) with exactly one `console.warn`, the same degrade posture the hook's mount path already has. The editor-initiated caller keeps today's behaviour (a failed follow leaves the editor at its own working `?folder=` navigation — the frame is already there, so a degrade re-navigation would be a needless reload). app.tsx exposes `handleCodeFollowTerminal(folder)` = `setWindowOptions(...)` → `followFolder(folder, { degradeToFolder: true })` with the same error toast + rethrow contract as `handleCodeFolderNavigated`, and passes it to SurfaceLayout as `onCodeFollowTerminal`; SurfaceLayout's verb calls `requestCodeFollow(windowId, target, onCodeFollowTerminal)` (the wrapper takes the parent callback as a parameter so the editor-initiated seam and the verb share one pending-target contract).
- Two palette rows, built in a new pure `lib/palette/code.ts` (the `web-tabs.ts` / `gui.ts` per-kind precedent; `Web: …` is the label-prefix precedent for per-kind content actions):

  | id | label | present when | onSelect |
  |----|-------|--------------|----------|
  | `code-follow-terminal` | `Code: Follow Terminal` | `layout.order.includes("code") && codeRootFollowTarget(effectiveWindow) !== null` | `codeCommandsRef.current?.followTerminal()` |
  | `code-reload-editor` | `Code: Reload Editor` | `layout.order.includes("code") && codeReachable && codeSrcFor(windowId) !== null` | `codeCommandsRef.current?.reload()` |

  No chords — palette bodies only (the surface-layout spec's "palette + chord reachable; direct per-verb bindings remain open to a later phase" stance). Colocated `code.test.ts` covers the presence predicates.

### 5. Glyphs — `components/top-bar-icons.tsx`

Reload editor reuses the existing `RefreshGlyph` (the top bar's `Refresh page` and the web tile's `Refresh` already use it — one glyph, one meaning). Follow terminal needs a new `ControlGlyph` — a small terminal prompt with an arrow into a folder is the working default; the exact drawing is deferred (see Assumptions). Both glyphs must sit inside the 24×24 verb box at the shared stroke weight.
<!-- assumed: Follow-terminal glyph drawing — user left the glyphs deliberately open; a prompt-plus-arrow placeholder ships, swappable in one file -->

### 6. e2e

- **`code-folder-latch.spec.ts`** — one new test in the existing describe (real tmux, the code-server stub, the 30 s budget, intent JSDoc per the constitution): seed a repo-cwd window at `?layout=split-h:tty,code` and assert the seed as today; then `tmux split-window -c <dir>` where `<dir>` is a fresh `mkdtempSync(join(homedir(), ".rk-e2e-drift-"))` **under `$HOME`** (a non-repo cwd, so the derivation returns the raw cwd — and `$HOME` is the `@rk_win_code_root` write path's validation constraint; the existing `/tmp` split would be refused with 400); poll `GET /api/sessions` until the window's `gitRoot` is `<dir>` while `windowOption(id, "@rk_win_code_root")` is still `GIT_ROOT`; assert the `Follow terminal` button (role + name, scoped to `surface-tile-code`) is visible and was NOT visible before the split; click it; poll `windowOption(id, "@rk_win_code_root")` → `<dir>`; `fetchWorkspace(page, id)` and assert the iframe `src` becomes `/code/?workspace=<new path>` (the same iframe element — a follow re-navigates, never remounts), the tile header shows `<dir>`'s basename, and the `Follow terminal` button is gone (roots agree again). `afterAll` removes the temp dir. The file header's shared-setup comment and the scope-limit paragraph are updated (the follow half is now e2e-covered through the verb).
- **`code-surface.spec.ts`** — one new test in the stub-reachable describe using the existing `addInitScript` iframe-`load` counter: open the code tile, wait for exactly 1 load and capture the element handle; assert `Reload editor` is visible (and that it was hidden while `code-surface-pending` showed, using `holdWorkspaceFetch`); click it; poll the counter to exactly 2; assert the same element handle and the unchanged `src`. A second test (or a second half) in the retention describe: with windows A (code open) and B (code open, retained) — reload on the active window increments the counter by exactly one and B's retained iframe element is unchanged. The stub-down describe asserts neither verb renders on the not-running empty state.
- Gates: `just test-frontend` (full Vitest — never touched-files-only), `just test-e2e code-folder-latch.spec`, `just test-e2e code-surface.spec` (single specs, never the full run), `tsc --noEmit`.

### 7. Memory (hydrate targets — present-truth style, no history narration)

`docs/memory/run-kit/ui/lenses-and-layout.md`:
- § The code root → the "Follow rule" bullet gains the verb as the second writer; the "Stale roots are accepted …" bullet is REPLACED by a "Drift is visible, not silent" bullet: the `Follow terminal` verb renders exactly when `codeRootFollowTarget(win)` is non-null and re-seeds the option from the live `gitRoot` through the follow path; a stale root that STILL equals the derivation (both point at the deleted worktree) keeps rendering code-server's "folder does not exist" state, with File > Open Folder and `rk tab code set` as the escapes. No liveness probe.
- § Code Surface → a "User-initiated reload" bullet (the `reloadNonce` seam, active frame only, transparent to the rescue) and the § Surface Layout → Tile renderer verb inventory gains the two code verbs.
- Design Decisions: "Derivation seeds the code root once; only the editor moves it" → "…the editor or an explicit user verb moves it; the terminal never moves it on its own" (Decision/Why/Rejected updated, *Introduced by* appended). "Two sanctioned parent re-navigations" → restated as **two sanctioned MECHANISMS with four triggers**: (a) the nonce-keyed `followSrc` re-navigation — triggered by the editor's own File > Open Folder OR the Follow terminal verb; (b) `contentWindow.location.reload()` — triggered by the marker-gated first-boot rescue OR the Reload editor verb. Both keep URL + tab identity; neither writes `src`; nothing else may parent-navigate a live frame. The frame-LRU decision's rejected "a palette evict/reload verb (none needed …)" is updated to name the shipped `Code: Reload Editor` row. New decision **"Follow terminal is an explicit verb, not a live derivation"** with the rationale (worktree switching leaves the tile on the old checkout; File > Open Folder is too buried; a verb that appears only under drift makes the state visible without moving the editor on ordinary `cd`s) and the rejected alternatives above.

`docs/memory/run-kit/ui/keyboard-and-palette.md` § Command Palette Actions: the two `Code:` rows and the `codeCommandsRef` seam.

## Affected Memory

- `run-kit/ui/lenses-and-layout`: (modify) § Code Surface (reload seam), § The code root (second writer, drift bullet replaces "Stale roots are accepted"), § Surface Layout → Tile renderer (verb inventory), Design Decisions (seed-once decision reworded; "Two sanctioned parent re-navigations" restated as two mechanisms × four triggers; LRU decision's rejected palette-verb note; new "Follow terminal is an explicit verb" decision)
- `run-kit/ui/keyboard-and-palette`: (modify) § Command Palette Actions — `Code: Follow Terminal`, `Code: Reload Editor`, the `codeCommandsRef` seam

## Impact

Frontend only — no backend, API, or CLI change (`POST /api/windows/{id}/options` and `GET /api/windows/{id}/code-workspace` are reused as-is; `@rk_win_code_root` keeps its registry row and scope).

- `app/frontend/src/lib/code-folder-latch.ts` (+ `.test.ts`) — `codeRootFollowTarget`
- `app/frontend/src/components/code-surface.tsx` (+ `.test.tsx`) — `reloadNonce` prop
- `app/frontend/src/components/surface-layout.tsx` (+ `.test.tsx`) — two verbs, `requestCodeFollow` factoring, `codeReload` state, `codeFollowInFlight`, `codeCommandsRef`, new props `onCodeFollowTerminal` / `codeCommandsRef`
- `app/frontend/src/hooks/use-code-workspace.ts` — `followFolder(folder, { degradeToFolder })`
- `app/frontend/src/app.tsx` — `handleCodeFollowTerminal`, `codeCommandsRef`, palette wiring
- `app/frontend/src/lib/palette/code.ts` (new, + `.test.ts`) — the two `Code:` rows
- `app/frontend/src/components/top-bar-icons.tsx` — `FollowTerminalGlyph`
- `app/frontend/tests/e2e/code-folder-latch.spec.ts`, `app/frontend/tests/e2e/code-surface.spec.ts`
- `docs/memory/run-kit/ui/lenses-and-layout.md`, `docs/memory/run-kit/ui/keyboard-and-palette.md`

Risks: any palette test asserting exact entry counts on a terminal-route window with the code tile open (the operator-compose precedent) — run the FULL Vitest suite, not the touched files. The Follow verb can be offered for a `gitRoot` the backend refuses (outside `$HOME`): the click surfaces the existing error toast and the verb stays — acceptable, the frontend does not know the validation rule.

## Open Questions

- Exact glyph for Follow terminal (Reload editor reuses `RefreshGlyph`) — deferred; the apply agent picks a `ControlGlyph` drawing and a human can swap it.
- Palette mirroring: the conversation's default was "header verbs only", but Constitution V (every UI control MUST be palette-registered) and the frame-LRU decision's own note ("if one is ever added it registers in the palette") leave no room — this intake ships `Code: Follow Terminal` / `Code: Reload Editor`. Flagged so the user sees the override.
- Follow verb on a `?folder=` degrade frame — resolved by construction: the predicate reads `codeRoot` vs `gitRoot`, not the URL form; a seed-refused window has an empty `codeRoot` and never shows the verb, a failed-GET window shows it and the click degrades to `?folder=<gitRoot>` so the editor always lands on the terminal's folder. Recorded as an assumption below; deferred for the user's confirmation of that default.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Two header verbs on the code tile — `Follow terminal` (drift-only) and `Reload editor` (frame-mounted only) — in `surface-layout.tsx`'s header verb row using `VERB_BUTTON_CLASS` + `Tip` + `aria-label`, the gui fullscreen verb's per-kind-content-verb structure | Discussed — user chose header verbs; chrome tokens, box sizes, and the labels-in-aria-label convention are all read from the file | S:95 R:85 A:95 D:95 |
| 2 | Certain | Follow terminal rides the EXISTING follow path: `setWindowOptions({"@rk_win_code_root": gitRoot})` → workspace re-derivation → nonce-keyed `followSrc` re-navigation of the live frame; the pending-follow target is recorded synchronously in SurfaceLayout before the POST so the LRU reads it as a follow | Discussed — explicit user decision; the mechanism, its ordering hazard, and the wrapper to factor are all in the code and memory | S:95 R:80 A:95 D:95 |
| 3 | Certain | Reload editor reloads the ACTIVE window's frame only via `contentWindow.location.reload()` in the rescue's try/catch posture — never a `src` write, never an unmount; retained frames untouched | Discussed — explicit user decision; P3 and the sanctioned-mechanism rule leave one seam | S:95 R:85 A:95 D:95 |
| 4 | Certain | `?workspace=` stays the primary mount form and the latch paradigm is kept; the verb is only a second writer beside File > Open Folder and `rk tab code set` | Discussed — user asked whether to drop workspaces and agreed no; `rk.tab`/`rk.server` ride the workspace file (code-bridge memory) | S:95 R:70 A:95 D:95 |
| 5 | Certain | Out of scope: code-server process restart, `?folder=` boots, live derivation, blind reload of all retained frames | Discussed — all four rejected with rationale in conversation | S:95 R:90 A:90 D:95 |
| 6 | Confident | The drift predicate is `codeRootFollowTarget(win)` (returns `gitRoot` or `null`) in `lib/code-folder-latch.ts` — both roots non-empty and different ⇒ `gitRoot`, else `null` — with colocated tests | User specified the pure predicate and its home; the "null means no write" return shape mirrors `codeRootSeed`; the name is mine | S:85 R:90 A:90 D:80 |
| 7 | Confident | The reload seam is a `reloadNonce?: number` prop on `CodeSurface` (mount value pre-seen; a new value ⇒ one reload), with SurfaceLayout holding `{windowId, nonce}` state and passing the nonce only to that window's frame | User asked for the shape that fits the `followSrc` nonce pattern; a `useImperativeHandle` ref would also work but keeps less of the props-only contract | S:70 R:85 A:80 D:65 |
| 8 | Confident | Follow-terminal's re-derivation degrades to `/code/?folder=<gitRoot>` when the workspace GET fails (`followFolder(folder, { degradeToFolder: true })`, one console warning); the editor-initiated follow keeps today's leave-in-place behaviour | Without it a failed GET leaves the option moved and the frame on the old folder — a new mismatch the editor-initiated path never had; the hook's mount path already degrades this way | S:60 R:85 A:85 D:75 |
| 9 | Confident | Both verbs also register palette rows `Code: Follow Terminal` / `Code: Reload Editor` (new pure `lib/palette/code.ts`, `Web:` prefix precedent) through a `codeCommandsRef` seam (the `guiCommandsRef` precedent); no chords — overriding the conversation's "header verbs only" default | Constitution V makes palette registration a MUST for every UI control, and the LRU design decision already says a reload verb registers in the palette; flagged in Open Questions | S:60 R:85 A:90 D:70 |
| 10 | Confident | `Follow terminal` is disabled from click until the follow promise settles (`codeFollowInFlight`); the Reload verb hides while the tile is pending or unreachable (no frame record) | The payload reads the old root until the option tick, so an unguarded second click re-POSTs and re-navigates twice; a pending/unreachable tile has no frame to reload | S:55 R:95 A:85 D:80 |
| 11 | Confident | Accessible names are the bare verbs `Follow terminal` / `Reload editor`; Tips use the "Verb — consequence" shape (`Follow terminal — reopen the editor at <basename>`, `Reload editor — reboots this tab's workbench`); order Follow · Reload · hairline · layout verbs; rendered on desktop and mobile alike | Read from the existing `Close pane — kills the tmux pane` Tip and the gui verb's any-form-factor precedent; the tty pane segment is desktop-only, so form factor is a judgment call | S:60 R:95 A:75 D:70 |
| 12 | Confident | Reload editor reuses `RefreshGlyph`; Follow terminal gets a new `ControlGlyph` in `top-bar-icons.tsx` | One glyph per meaning — the top bar and web tile already use `RefreshGlyph` for "reload this"; the follow glyph has no precedent | S:50 R:95 A:80 D:70 |
| 13 | Certain | Tests: unit (`code-folder-latch.test.ts`, `code-surface.test.tsx`, `surface-layout.test.tsx`, `palette/code.test.ts`); e2e extends `code-folder-latch.spec.ts` with drift → verb → click → option = pane's root (via `windowOption`) → verb gone, splitting the pane at a `$HOME`-resident temp dir (the `/tmp` split would be refused by the write path's validation), and `code-surface.spec.ts` with the load-counter reload test; gates `just test-frontend` (full), `just test-e2e code-folder-latch.spec`, `just test-e2e code-surface.spec` | User specified the gates and both e2e scenarios; the `$HOME` constraint is documented in `code-surface.spec.ts`'s `makeWindow` note | S:95 R:90 A:95 D:95 |
| 14 | Certain | Memory: replace the "Stale roots are accepted … no reset verb, no palette entry" bullet; restate "Two sanctioned parent re-navigations" as two mechanisms (followSrc nonce, `reload()`) × four triggers (editor Open Folder, Follow terminal, marker-gated rescue, Reload editor); reword the seed-once decision; add the "Follow terminal is an explicit verb, not a live derivation" decision with the worktree/buried-escape rationale; add the `Code:` palette rows to keyboard-and-palette | Discussed — user asked for exactly this supersession, present-truth style | S:95 R:90 A:90 D:95 |
| 15 | Tentative | Exact glyph drawing for the Follow terminal verb — the apply agent lands a placeholder `ControlGlyph` (terminal prompt + arrow into a folder) that a human swaps | Deferred — promptless dispatch; user marked it deliberately open; taste, not derivable from the codebase, but a one-file swap that blocks nothing | S:15 R:90 A:40 D:35 |
| 16 | Confident | The Follow verb on a `?folder=` degrade frame follows the by-construction default (§ 4 / row 8): the predicate reads roots, not the URL form — a seed-refused window (empty `codeRoot`) never shows it, a failed-GET window shows it and the click degrades to `?folder=<gitRoot>` | Deferred — promptless dispatch; user marked it deliberately open; the code answers the default, pending the user's confirmation | S:15 R:85 A:50 D:40 |

16 assumptions (9 certain, 6 confident, 1 tentative, 0 unresolved).
