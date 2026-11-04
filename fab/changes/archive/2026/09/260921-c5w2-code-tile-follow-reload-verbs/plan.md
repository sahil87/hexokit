# Plan: Code Tile Header Verbs — Follow Terminal + Reload Editor

**Change**: 260921-c5w2-code-tile-follow-reload-verbs
**Intake**: `intake.md`

## Requirements

### UI (surface layout): the code tile's header verbs

#### R1: Follow terminal verb — rendered only on drift
The code tile header SHALL render a **Follow terminal** verb (`aria-label="Follow terminal"`, `Tip` label `Follow terminal — reopen the editor at <basename>`) ONLY when the ACTIVE window's latched root drifts from the live derivation: `codeRootFollowTarget(win)` (new pure helper in `lib/code-folder-latch.ts`, the `codeRootSeed` "null means no write" shape) returns `win.gitRoot` when `win.codeRoot` and `win.gitRoot` are both non-empty and differ, else `null`. The verb's presence IS the drift indicator — no other badge. A retained (other-window) frame never renders it.

- **GIVEN** a window whose code tile is open at root A and whose active pane's cwd derives root B ≠ A
- **WHEN** the header renders
- **THEN** the Follow terminal verb is visible, its tooltip naming B's basename
- **GIVEN** `codeRoot === gitRoot`, or either is empty (pre-seed, or no resolvable cwd)
- **THEN** no Follow terminal verb renders

#### R2: Follow terminal rides the existing follow path, with an in-flight guard
Selecting Follow terminal MUST re-seed `@rk_win_code_root` from `gitRoot` through the SAME wrapper the editor-initiated `onFolderNavigated` report uses, factored into a named `requestCodeFollow(frameWindowId, folder, report)` in `SurfaceLayout`: record the pending follow target synchronously (`pendingCodeFollowRef`), call the parent callback, clear the target on rejection. The parent callback for the verb is a new `onCodeFollowTerminal(folder)` prop, implemented in app.tsx as `handleCodeFollowTerminal` = `setWindowOptions({"@rk_win_code_root": folder})` → `followFolder(folder, { degradeToFolder: true })` with the same toast + rethrow contract as `handleCodeFolderNavigated`. `followFolder` (hooks/use-code-workspace.ts) gains the `degradeToFolder` option: when the workspace GET fails (non-`ok` result or a rejected fetch), the follow lands the live frame on `codeServerSrc(folder)` with exactly one `console.warn`; the editor-initiated caller keeps today's leave-in-place behaviour. A `codeFollowInFlight` state disables the verb from click until the returned promise settles. The frame record's `root` baseline moves in place — the follow is never an eviction.

- **GIVEN** drift and a live frame **WHEN** the user clicks Follow terminal **THEN** the option becomes `gitRoot`, the live iframe (same element) navigates to the new `?workspace=` URL, the frame record survives with its baseline moved, and once the payload tick lands the verb disappears
- **WHEN** the workspace GET fails after the option write **THEN** the frame navigates to `/code/?folder=<gitRoot>` (one console warning) so editor and option agree
- **WHEN** the option POST is rejected **THEN** the error toast shows, the pending target is cleared, the frame is untouched, and the verb re-enables
- **WHILE** the follow promise is pending **THEN** the verb is disabled (no double POST, no second nonce)

#### R3: Reload editor verb + the `CodeSurface` reload seam
The code tile header SHALL render a **Reload editor** verb (`aria-label="Reload editor"`, `Tip` label `Reload editor — reboots this tab's workbench`, the existing `RefreshGlyph`) whenever the tile is the ACTIVE window's visible code tile (`slot >= 0`) AND a frame is mounted (`codeReachable && codeFrames.some(r => r.windowId === windowId)`). `CodeSurface` gains `reloadNonce?: number`: the mount-time value is pre-seen; a value not seen before by that instance runs exactly one `iframeRef.current?.contentWindow?.location.reload()` (the rescue's try/catch posture) from an effect keyed on `[reloadNonce]`, recording the nonce as seen even when no iframe is mounted (pending/unreachable ⇒ no-op). Never a `src` write, never an unmount. `SurfaceLayout` holds `codeReload: { windowId; nonce } | null` and passes `reloadNonce` only to the frame whose `windowId` matches; every other frame receives `undefined`.

- **GIVEN** the active window's code tile shows a live iframe **WHEN** the user clicks Reload editor **THEN** the same iframe element fires exactly one additional `load`, its `src` attribute is unchanged, and other windows' retained frames fire no load
- **GIVEN** the tile pends or code-server is unreachable **THEN** the Reload editor verb is absent
- **GIVEN** a mounted frame **WHEN** `reloadNonce` changes **THEN** `reload()` is called once; the same nonce re-rendered ⇒ no further call; a nonce present at mount ⇒ no call
- **GIVEN** a frame created after a reload was requested for another window **THEN** it never replays that reload

#### R4: Command-palette parity (Constitution V)
Both verbs SHALL be registered in the palette through a pure builder `buildCodeActions` in `lib/palette/code.ts` (the `zen.ts`/`layout.ts` builder pattern, colocated `code.test.ts`): `Code: Follow Terminal` (id `code-follow-terminal`, `description` = `→ <basename>`) when `layout.order.includes("code") && codeRootFollowTarget(effectiveWindow) !== null`, and `Code: Reload Editor` (id `code-reload-editor`) when `layout.order.includes("code") && codeReachable && codeSrc !== null`. Both `onSelect` bodies route through `codeCommandsRef: MutableRefObject<CodeTileCommands | null>` (`{ followTerminal(): void; reload(): void }`, the `guiCommandsRef`/`zoomToggleRef` fill-and-clear pattern) so the header button and the palette row run the same body. Offered on the terminal route (`windowParam`) on both form factors. No chords.

- **GIVEN** the terminal route with a mounted code frame and drift **WHEN** the palette opens **THEN** it lists `Code: Follow Terminal` and `Code: Reload Editor`
- **GIVEN** no drift **THEN** only `Code: Reload Editor`; **GIVEN** no mounted frame **THEN** neither

#### R5: Verb chrome and placement
The verbs use `VERB_BUTTON_CLASS` + `Tip` + `aria-label` with `hover:text-text-primary` (not the destructive red), rendered in the header verb row for `kind === "code" && slot >= 0` before the layout-verb cluster in the order Follow terminal (conditional) · Reload editor · hairline (when `showVerbs`) · layout verbs — the gui fullscreen verb's per-kind-content-verb structure. Follow terminal uses a new `FollowTerminalGlyph` `ControlGlyph` in `top-bar-icons.tsx` (terminal prompt + arrow placeholder drawing at the shared stroke weight; the exact drawing is a one-file swap).

- **GIVEN** a 3-tile desktop layout **THEN** the code header reads: glyph · `Code` · basename chip · spring · [Follow] · Reload · │ · Expand · Promote · Swap · │ · Close

### Non-Goals
- A code-server PROCESS restart from the tile — no CLI verb or daemon route exists; it would kill every workbench on every tab.
- Falling back to `?folder=` boots — drops `rk.tab`/`rk.server` tab identity.
- Live derivation following the terminal — reintroduces the `cd`-moves-the-editor problem the latch solved.
- Reloading retained frames; a liveness probe of the latched root; per-verb chords.
- Spec edits (`docs/specs/*` are human-curated). Memory updates are hydrate's (intake § 7 lists the targets).

### Design Decisions

#### Follow terminal is an explicit verb, not a live derivation
**Decision**: The Follow terminal verb is a second WRITER of `@rk_win_code_root` beside File > Open Folder (and `rk tab code set`). It calls the identical follow wrapper (pending-target record → parent callback → latch POST → workspace re-fetch → nonce-keyed `followSrc` re-navigation), so the frame LRU sees a follow, never an eviction, and the `?workspace=` tab identity is preserved. The terminal never moves the editor on its own.
**Why**: Worktree switches (`wt`) leave the tile on the old checkout and File > Open Folder is too buried to be a practical escape. A verb that appears only under drift makes the state visible without moving the editor on ordinary `cd`s.
**Rejected**: A live-derivation follow (moves the editor on every `cd`); a `src` rewrite (P3 hazard — re-navigates on ordinary latch writes); clearing the option so the seed re-fires (the seed fires only on an empty option at first render and races the SSE tick; it also bypasses the LRU's follow bookkeeping).
*Introduced by*: 260921-c5w2-code-tile-follow-reload-verbs

#### Two sanctioned re-navigation mechanisms, four triggers
**Decision**: A live code frame may be parent-navigated by exactly two mechanisms: (a) the nonce-keyed `followSrc` re-navigation — triggered by the editor's own File > Open Folder OR the Follow terminal verb; (b) `contentWindow.location.reload()` — triggered by the marker-gated first-boot rescue OR the Reload editor verb (carried into `CodeSurface` as a per-window `reloadNonce`). Both keep URL + tab identity; neither writes `src`.
**Why**: A reload keeps the `?workspace=` identity and the mount-generation src ref; a nonce prop is the established one-shot channel from `SurfaceLayout` to a live frame without re-rendering `src`.
**Rejected**: A `key` bump (remount = page unload, kills the extension host); a ref handle exposing the iframe element (leaks the DOM node across the component boundary); a `src` re-set to the same URL (goes through the P3-hazard path this component forbids).
*Introduced by*: 260921-c5w2-code-tile-follow-reload-verbs

#### A shell-initiated follow degrades to `?folder=` on a failed re-derivation
**Decision**: `followFolder(folder, { degradeToFolder: true })` lands the frame on `/code/?folder=<folder>` when the workspace GET fails; the editor-initiated follow keeps the leave-in-place behaviour.
**Why**: The editor-initiated follow targets a frame that already navigated itself to the new folder, so a failed GET costs only tab identity. The verb's frame is still on the OLD folder; without the degrade a failed GET leaves the option moved and the editor stale — a mismatch the latch never had before.
**Rejected**: Rolling the option back on a failed GET (a second write racing the SSE tick, and the terminal's folder is what the user asked for); leaving the mismatch (the verb would appear to do nothing).
*Introduced by*: 260921-c5w2-code-tile-follow-reload-verbs

## Tasks

### Phase 1: Pure modules

- [x] T001 Add `codeRootFollowTarget(win): string | null` to `app/frontend/src/lib/code-folder-latch.ts` per intake § 1 (both roots non-empty and different ⇒ `gitRoot`, else `null`; one header-comment sentence: after the seed the writers are the editor's own navigation AND the explicit Follow terminal verb) and cover it in `app/frontend/src/lib/code-folder-latch.test.ts` (drift, equal, empty `codeRoot`, empty `gitRoot`, null/undefined). <!-- R1 -->
- [x] T002 [P] Create `app/frontend/src/lib/palette/code.ts` (header comment in the `zen.ts` style) exporting `CodePaletteAction`, `CodePaletteOptions { codeTileOpen: boolean; followTarget: string | null; frameMounted: boolean; onFollowTerminal(): void; onReload(): void }` and `buildCodeActions(opts)` → `Code: Follow Terminal` (`code-follow-terminal`, `description: "→ <basename>"`) when `codeTileOpen && followTarget`, `Code: Reload Editor` (`code-reload-editor`) when `codeTileOpen && frameMounted`; colocated `code.test.ts` (both / follow-only / reload-only / none, description basename, onSelect wiring, tile-closed ⇒ none). <!-- R4 -->
- [x] T003 [P] `app/frontend/src/hooks/use-code-workspace.ts`: `followFolder(folder, opts?: { degradeToFolder?: boolean })` — on a non-`ok` result or a rejected fetch with the option set, `setFollow` to `codeServerSrc(folder)` with a fresh nonce and `root: folder`, one `console.warn`, and keep the map entry current; without the option today's behaviour is unchanged. Update the `CodeWorkspace.followFolder` type + header comment; extend the colocated `app/frontend/src/hooks/use-code-workspace.test.tsx` (failed GET with the option ⇒ `followSrc` = `codeServerSrc(folder)` with a fresh nonce and one warning; failed GET without the option ⇒ no follow, today's behaviour). <!-- R2 -->

### Phase 2: Component seams

- [x] T004 `app/frontend/src/components/code-surface.tsx`: add `reloadNonce?: number` to `CodeSurfaceProps` (doc per intake § 2); `reloadNonceRef` initialised to the mount-time prop; `useEffect([reloadNonce])` — a new number ≠ ref ⇒ record it, then if `reachable && src !== null` call `iframeRef.current?.contentWindow?.location.reload()` in try/catch (else no-op); extend the header comment's sanctioned-re-navigation paragraph (two mechanisms × four triggers). Tests in `code-surface.test.tsx` with the existing `stubReload` helper: nonce change ⇒ exactly one `reload()`; same nonce re-rendered ⇒ none; nonce present at mount ⇒ none; nonce while `reachable=false` ⇒ none and no throw. <!-- R3 -->
- [x] T005 `app/frontend/src/components/surface-layout.tsx` per intake § 3: (a) export `interface CodeTileCommands { followTerminal(): void; reload(): void }`, add props `onCodeFollowTerminal?: (folder: string) => void | Promise<void>` and `codeCommandsRef?: React.MutableRefObject<CodeTileCommands | null>` (filled while the active window's code tile is visible, cleared otherwise/unmount — the `zoomToggleRef` pattern); (b) factor the inline `onFolderNavigated` wrapper into `requestCodeFollow(frameWindowId, folder, report)` used by the load seam (with `onCodeFolderNavigated`) and the verb (with `onCodeFollowTerminal`); (c) `codeFollowInFlight` state (set on click, cleared on settle) disabling the Follow verb; (d) `codeReload: { windowId: string; nonce: number } | null` state; `<CodeSurface reloadNonce={frame.windowId === codeReload?.windowId ? codeReload.nonce : undefined}>`; (e) header block for `kind === "code" && slot >= 0`: Follow terminal (when `codeRootFollowTarget(win) !== null`; `Tip` label `Follow terminal — reopen the editor at <basename>`; new `FollowTerminalGlyph` added to `top-bar-icons.tsx`), Reload editor (when `codeReachable && codeFrames.some(r => r.windowId === windowId)`; `Tip` label `Reload editor — reboots this tab's workbench`; `RefreshGlyph`), then the hairline when `showVerbs` — `VERB_BUTTON_CLASS` + `hover:text-text-primary`; (f) `codeCommandsRef.current = { followTerminal: () => target && requestCodeFollow(windowId, target, onCodeFollowTerminal), reload: () => frameMounted && setCodeReload(...) }`. Tests in `surface-layout.test.tsx` (the `renderLayout` + `codeSpy` harness): Follow renders iff drift on the active window (not equal, not empty `codeRoot`, not on the retained wrapper); Reload renders iff a frame record exists and `codeReachable`; clicking Follow calls `onCodeFollowTerminal` with `gitRoot`, records the pending target, and disables until settle (re-enables on rejection); clicking Reload bumps the `reloadNonce` the active frame receives and leaves a retained frame's `undefined`; `codeCommandsRef` seams call the same bodies and read `null` when no code tile is visible. <!-- R1, R2, R3, R4, R5 -->

### Phase 3: Shell wiring

- [x] T006 `app/frontend/src/app.tsx`: `handleCodeFollowTerminal(folder)` = `setWindowOptions(server, windowParam, { "@rk_win_code_root": folder }).then(() => followFolder(folder, { degradeToFolder: true }))` with `handleCodeFolderNavigated`'s guard/toast/rethrow contract; `const codeCommandsRef = useRef<CodeTileCommands | null>(null)`; pass `onCodeFollowTerminal` and `codeCommandsRef` to `<SurfaceLayout>`; in the `viewActions` memo append `...(windowParam ? buildCodeActions({ codeTileOpen: layout.order.includes("code"), followTarget: codeRootFollowTarget(effectiveWindow), frameMounted: (codeServer?.reachable ?? false) && codeSrc !== null, onFollowTerminal: () => codeCommandsRef.current?.followTerminal(), onReload: () => codeCommandsRef.current?.reload() }) : [])` with deps updated; `npx tsc --noEmit` clean from `app/frontend`. <!-- R2, R4 -->

### Phase 4: End-to-end proof

- [x] T007 `app/frontend/tests/e2e/code-folder-latch.spec.ts` per intake § 6: new test "the Follow terminal verb re-seeds the code root from the drifted terminal cwd" — seed a repo window with the code tile open, `expectCodeRoot(id, GIT_ROOT)`, assert `Follow terminal` (role + name, scoped to `surface-tile-code`) is NOT visible; `mkdtempSync(join(homedir(), ".rk-e2e-drift-"))` (under `$HOME` — the write path's validation; removed in `afterAll`/`finally`), `tmux split-window -c <dir>`, `expectDerivedGitRoot(page, id, dir)` while the option still reads `GIT_ROOT`; assert the verb visible; capture the iframe `elementHandle`; click; `expectCodeRoot(id, dir)`; `fetchWorkspace(page, id)` → poll the iframe `src` to `workspaceSrc(path)` with `root === dir`; same element handle; header chip shows `dir`'s basename; the verb is gone. Update the file-header shared-setup + scope-limit comments (the follow half is now e2e-covered through the verb) and add the Proves/Steps JSDoc; `test.setTimeout(30_000)`. Run `just test-e2e code-folder-latch.spec`. <!-- R1, R2 -->
- [x] T008 [P] `app/frontend/tests/e2e/code-surface.spec.ts` per intake § 6: (1) stub-reachable describe — "the Reload editor verb reloads the live frame in place — one extra load, same element, same src": with the `__codeIframeLoads` counter, `holdWorkspaceFetch` to assert the verb is hidden while `code-surface-pending` shows, release, loads → 1, capture handle + `src`, click `Reload editor` (scoped to `surface-tile-code`), poll loads → 2, same handle, same `src`; (2) retention describe — windows A (code open) and B (code open, then retained): Reload on the active window moves the counter by exactly one and B's retained iframe element is unchanged; (3) stub-down describe — neither verb renders on the not-running empty state. Proves/Steps JSDoc on each. Run `just test-e2e code-surface.spec`. <!-- R3 -->

## Execution Order

- T001, T002, T003, T004 are independent of each other
- T005 depends on T001 (predicate) and T004 (`reloadNonce`)
- T006 depends on T002, T003, T005
- T007 and T008 depend on T005 + T006; run them as single specs (`just test-e2e code-folder-latch.spec`, `just test-e2e code-surface.spec`) — never the full e2e run
- Unit gate after T006: `just test-frontend` (the FULL Vitest suite — a touched-files-only run misses cross-file palette assertions) and `npx tsc --noEmit` in `app/frontend`

## Acceptance

### Functional Completeness

- [x] A-001 R1: `Follow terminal` renders on the active code tile exactly when `codeRootFollowTarget(win)` is non-null, with the target basename in its tooltip; never on a retained frame
- [x] A-002 R2: Clicking it runs the shared `requestCodeFollow` wrapper → `onCodeFollowTerminal` → option POST → `followFolder(folder, { degradeToFolder: true })`, disabled while in flight
- [x] A-003 R3: `Reload editor` renders exactly when a frame record exists and `codeReachable`; `CodeSurface` reloads once per unseen `reloadNonce` via `contentWindow.location.reload()` and never writes `src`
- [x] A-004 R4: `buildCodeActions` yields `Code: Follow Terminal` / `Code: Reload Editor` per gating and app.tsx registers them through `codeCommandsRef`
- [x] A-005 R5: Verb chrome, order, labels, and glyphs match the header conventions (`VERB_BUTTON_CLASS`, `Tip`, hairline placement)

### Behavioral Correctness

- [x] A-006 R2: After Follow terminal, `@rk_win_code_root === gitRoot`, the live frame (same element) is at the new `?workspace=` URL, the frame record survives with its baseline moved (no eviction), and the verb is gone after the payload tick
- [x] A-007 R2: A failed workspace GET after the option write lands the frame on `/code/?folder=<gitRoot>` with one console warning; a rejected option POST toasts, clears the pending target, leaves the frame untouched, re-enables the verb
- [x] A-008 R3: Reload editor keeps the same iframe element and `src` and fires exactly one more `load`; retained frames are untouched; a frame created later never replays the nonce

### Scenario Coverage

- [x] A-009 R1, R2: e2e `code-folder-latch.spec.ts` covers drift → verb appears → click → option re-seeded → src followed → verb gone (T007)
- [x] A-010 R3: e2e `code-surface.spec.ts` covers hidden-while-pending, reload → +1 load same element, retained frame isolation, absent when not running (T008)
- [x] A-011 R3: Unit tests cover nonce change / repeated nonce / mount-time nonce / unreachable nonce
- [x] A-012 R4: `code.test.ts` covers both / follow-only / reload-only / none gating and the description basename

### Edge Cases & Error Handling

- [x] A-013 R1: Empty `gitRoot` (no resolvable cwd) or empty `codeRoot` (pre-seed) never offers Follow terminal
- [x] A-014 R3: A reload nonce arriving while pending or unreachable is recorded and is a no-op without error
- [x] A-015 R2: The editor-initiated follow's failure behaviour (leave in place) is unchanged by the `degradeToFolder` option

### Code Quality

- [x] A-016 Pattern consistency: verbs use `VERB_BUTTON_CLASS`/`Tip`/`ControlGlyph`, aria-labels + Tip copy follow the "Verb — consequence" shape; the palette builder mirrors `zen.ts`/`layout.ts`; the ref seam mirrors `zoomToggleRef`/`guiCommandsRef`
- [x] A-017 No unnecessary duplication: one follow wrapper (`requestCodeFollow`) serves both triggers; `RefreshGlyph` is reused; `codeRootFollowTarget` lives beside `codeRootFor`
- [x] A-018 Type narrowing over assertions; no new `as` casts in the added code paths
- [x] A-019 Comments state constraints (why the nonce is pre-seen at mount, why the wrapper is shared, why the degrade exists), no narration, no change IDs in code comments; e2e tests carry Proves/Steps JSDoc and both spec file headers are updated
- [x] A-020 Tests: new behaviour covered at unit (latch, palette, CodeSurface, SurfaceLayout, hook) and e2e (both specs); `just test-frontend` green; `npx tsc --noEmit` clean

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- e2e: single specs only (`just test-e2e code-folder-latch.spec`, `just test-e2e code-surface.spec`); the per-worktree e2e flock serializes runs, so a second run waits rather than colliding

## Deletion Candidates

None — this change adds new functionality without making existing code redundant. The inline `onFolderNavigated` wrapper was factored into `requestCodeFollow` in place (no dead copy left behind), and the `reloadNonce` seam, the palette builder, and the two verbs are all additive.

Note for hydrate (not a candidate): the previously recorded deletion candidate "`codeSrc` remains in the return shape but has no production consumer" (`docs/memory/run-kit/ui/lenses-and-layout.md` § Code Surface → Mount gating) is now stale — `app.tsx` consumes `codeSrc` for the `Code: Reload Editor` palette gate (`frameMounted`). The memory edit should drop that parenthetical.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Follow terminal reuses the editor-follow wrapper (`requestCodeFollow`) and the `followSrc` re-navigation | Intake rows 2, 9; the LRU's pending-follow bookkeeping already exists | S:90 R:85 A:95 D:95 |
| 2 | Certain | Reload = `contentWindow.location.reload()` via a per-window `reloadNonce` prop, mount-time value pre-seen | Intake rows 3, 7; the rescue's seam; the `followSrc` nonce idiom | S:90 R:90 A:95 D:90 |
| 3 | Certain | Palette rows `Code: Follow Terminal` / `Code: Reload Editor` via `codeCommandsRef` | Constitution V; intake row 9; `guiCommandsRef`/`zoomToggleRef` seam pattern | S:85 R:90 A:95 D:90 |
| 4 | Confident | `followFolder(folder, { degradeToFolder })` for the verb only | Intake row 8 — the verb's frame is still on the old folder, unlike the editor-initiated follow | S:70 R:85 A:85 D:80 |
| 5 | Confident | Reload gating = frame record exists ∧ reachable; Follow gating = `codeRootFollowTarget` non-null ∧ active visible tile; `codeFollowInFlight` disables Follow until settle | Intake row 10 | S:70 R:90 A:85 D:80 |
| 6 | Tentative | `FollowTerminalGlyph` = terminal prompt + arrow placeholder; Reload reuses `RefreshGlyph` | Intake rows 12, 15 — user left the drawing open; one-file swap | S:40 R:95 A:70 D:55 |
| 7 | Confident | Palette `description: "→ <basename>"` on the Follow row; Tip copy in the "Verb — consequence" shape | Intake row 11; the gui rows use `description` the same way | S:60 R:95 A:85 D:75 |
| 8 | Certain | e2e drift dir is a `mkdtemp` under `$HOME` | The code-root write path rejects paths outside `$HOME` (`validate.ExpandTilde`); intake row 13 | S:85 R:95 A:95 D:95 |
| 9 | Confident | `buildCodeActions` takes `codeTileOpen` explicitly (rather than the layout) so the builder stays layout-agnostic | Mirrors `buildZenActions`' caller-gated shape; trivially reversible | S:55 R:95 A:85 D:75 |
| 10 | Confident | The two verbs render inside the tile header, which is `!mobile`-gated in `surface-layout.tsx` — so the header verbs are desktop-only; mobile reaches the same actions through the palette rows, which `app.tsx` offers on BOTH form factors | Intake row 11's "rendered on desktop and mobile alike" predates the read that the whole header is desktop-only (the tty pane segment is the same); R4's palette parity covers mobile | S:60 R:90 A:80 D:70 |
| 11 | Confident | The retention isolation e2e (T008 part 2) reloads the ACTIVE window's frame while the other window's frame sits retained — WITHOUT switching back. A switch-back between two code-tile windows trips a PRE-EXISTING retention defect: React's keyed-list move re-parents the demoted tile's DOM node and Chromium reloads the iframe in place (same element, extra `load` — verified with an element-tagging diagnostic spec), silently rebooting that workbench. Unrelated to this change's code paths (untouched tile ordering); flagged for a follow-up change, not fixed here | The plan's scenario ("B retained, reload on the active window") is preserved; only the switch-back step — orthogonal to the verb's per-window nonce targeting — was dropped | S:50 R:85 A:85 D:75 |

9 assumptions (4 certain, 4 confident, 1 tentative), plus 2 apply-time additions (rows 10–11, both confident).
