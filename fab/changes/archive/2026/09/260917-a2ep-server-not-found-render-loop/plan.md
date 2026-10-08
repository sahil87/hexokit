# Plan: A missing-server route must not spin the renderer

**Change**: 260917-a2ep-server-not-found-render-loop
**Intake**: `intake.md`

## Requirements

### Routes & Shell: absent-server fallback idles

#### R1: One-render idle contract for a missing-server route
Loading `/$server` or `/$server/$window` for a server the daemon does not have MUST render the "Server not found" fallback and then leave the renderer idle: no React re-render loop, no navigation loop, no repeated subscription attempt. Measured on the worktree's own production build, `just perf-idle-cpu /nosuchserver 15` MUST report renderer ≤ 5 % and main ≤ 2 % (today: 112 % / 99.4 %), and `/nosuchserver/0` the same bounds.

- **GIVEN** a daemon whose server list does not contain `nosuchserver`
- **WHEN** a tab loads `/nosuchserver` (or `/nosuchserver/0`) and idles for 15 s
- **THEN** the page shows "Server not found" and the renderer's main thread accrues well under 0.3 s of task time per 3 s of wall time
- **AND** the `/` host overview and a real `/$server` page measure unchanged within the instrument's 3-point noise floor

#### R2: The loop's mechanism is found and recorded before it is fixed
The apply agent MUST identify the specific mechanism (component, hook/effect, and the unstable identity or self-triggering navigation) that keeps the renderer busy, and record it under `## Notes` in this file — with the before/after instrument summary lines — before changing behavior. The fix SHALL be the smallest change that removes that mechanism at its source.

- **GIVEN** the live repro (renderer 112 %, main 99.4 %, 0 recalcs, 0 layouts, samples in `main-*.js`, `tip-*.js` (React), `router-*.js` (TanStack Router), `rolldown-runtime-*.js`, `use-keybindings-*.js`, `command-palette-*.js`)
- **WHEN** the apply agent bisects the ranked hypotheses in `## Notes` § R7 hypotheses on a worktree build
- **THEN** `## Notes` names the culprit with file:line, the evidence that pinned it (the hypothesis toggle that dropped main-thread time from ~99 % to idle), and the fix shape chosen

#### R3: The fallback's behavior contract is unchanged
`ServerNotFound` MUST still render the copy `Server not found`, the sentence naming the server (`No tmux server named <strong>{serverName}</strong> was found.`), and the `Go to server list` anchor to `/`. The three-way guard's other arms MUST keep working: `ServerWaiting` for `pendingServer` swapping to the server view once the refreshed list contains it; a later genuine deletion of the viewed server flipping to "Server not found" (the `gone` reap path); kill/not-found redirects landing on `/$server`, never `/`.

- **GIVEN** the fix is applied
- **WHEN** `just test-e2e "e2e/create-server-waiting"` and the new spec run, and the fallback is opened by hand on the worktree rig
- **THEN** every assertion about copy, link target, and the waiting → view swap still passes
- **AND** no route, page, settings key, or router-table entry is added (Constitution IV)

#### R4: The `--then` history-sync spin is classified
After R1 is satisfied, the instrument's `--then` navigation (`history.pushState` + synthetic `popstate` fallback) to a **valid** tty route and to `/nosuchserver` MUST be re-measured. If it still spins AND the path is product-reachable (browser back/forward, desktop `goBack`, an in-app `pushState`), it MUST be fixed and covered by an extra e2e step; if it is reachable only through the instrument's synthetic fallback, it MUST be documented as instrument-only in `docs/memory/run-kit/architecture/testing.md` § Performance probes at hydrate (the finding recorded in `## Notes` here). `scripts/perf-idle-cpu.*` MUST NOT be modified (change 5's files).

- **GIVEN** R1's fix is in the worktree build
- **WHEN** `just perf-idle-cpu / 15 --then /<real-server>/@<N> --url …` and `… --then /nosuchserver` run
- **THEN** `## Notes` records both summary lines and the classification (fixed / instrument-only / same loop, gone)

#### R5: An e2e guards the idle contract
A new spec `app/frontend/tests/e2e/server-not-found-idle.spec.ts` MUST load a missing-server route, assert the fallback's copy and link, open a CDP session (`page.context().newCDPSession(page)`), enable `Performance`, read `Performance.getMetrics` → `TaskDuration` (cumulative main-thread task seconds), wait 3 s with no interaction, read again, and assert the delta is `< 0.3`. It MUST cover both the `/$server` and `/$server/$window` forms as two `test()`s, run in the default e2e set (no `@perf` tag), and carry the constitution's Test Intent JSDoc (file header + per-test **Proves:** / **Steps:**) with no change IDs or PR numbers.

- **GIVEN** the e2e rig's daemon (which knows only the `rk-test-e2e-<token>-*` socket family)
- **WHEN** `just test-e2e "e2e/server-not-found-idle"` runs
- **THEN** both tests pass on the fixed build
- **AND** the same spec fails on the unfixed build (verified once during apply by running it before the fix, or by temporarily reverting the fix — record which in `## Notes`)

#### R6: A unit test pins the fixed mechanism
A colocated Vitest (`*.test.ts`/`*.test.tsx`) MUST cover the fixed hook, helper, or component so the mechanism cannot silently regress: e.g. a render-count assertion that a component mounted with an absent server settles after a bounded number of renders, or a unit on an extracted pure helper. Extending `app/frontend/src/app.test.tsx` is acceptable.

- **GIVEN** the fix from R2
- **WHEN** `just test-frontend` runs
- **THEN** the new test passes on the fixed code and would fail on the pre-fix code (assert the property, not the implementation detail)

### Non-Goals

- `NotFoundPage` (a URL matching no route at all) — out of scope unless R2 shows it shares the loop, in which case it is one more e2e step
- Any change to `scripts/perf-idle-cpu.sh` / `.mjs` (change 5's files)
- New flairs, the ambient-motion setting, desktop-lane e2e
- Widening the backend server-name cap or touching the e2e harness for the known long-worktree failures

### Design Decisions

#### Fix the source, prefer the smallest change; hoist the guard only if several effects misbehave
**Decision**: If R2 pins a single unstable identity (a per-render `?? []`, a fresh object dependency, a `navigate` to the current location), fix that identity in place (e.g. a module-level frozen empty constant, a stable memo, a same-location guard). Hoist `resolveServerView` into `ServerShell` above `AppShell`'s hook body only if R2 shows multiple independent effects re-firing for an absent server.
**Why**: the hook body is ~4,500 lines; a hoist changes mount/unmount behavior for the `waiting → view` swap and every effect's first run, which is a larger behavioral surface than the contract requires. The intake authorizes both shapes and prefers the smaller one when it suffices.
**Rejected**: a `beforeLoad` redirect or a throttle/debounce on the re-render — they hide the loop without removing it and the memory § Design Decisions already rejected route-level redirects for this guard.
*Introduced by*: 260917-a2ep-server-not-found-render-loop

#### The e2e asserts main-thread task time via CDP, not process CPU
**Decision**: the guard reads `Performance.getMetrics` `TaskDuration` deltas over a 3 s window and asserts `< 0.3 s`.
**Why**: a spinning page accrues ~3.0 s in that window and a quiet SPA on the rig accrues well under 0.1 s, so the signal is an order of magnitude and stable enough for a gate; process-level CPU sampling is the instrument's job and is too noisy for CI.
**Rejected**: `@perf`-tagging the spec like `gui-perf.spec.ts` — that spec audits noisy latency distributions; this one guards a binary regression and must run by default.
*Introduced by*: 260917-a2ep-server-not-found-render-loop

## Tasks

### Phase 1: Setup

- [x] T001 Bring up the worktree measurement rig: `just build` (frontend `dist` + Go binary), then serve the worktree build on a spare port in a detached tmux window on the **default** tmux server (`tmux new-window -d -n a2ep-rig "cd $(pwd) && RK_PORT=3777 ./bin/rk serve"` — pick another free port if 3777 is taken; the daemon lists the host's real tmux servers read-only, which is fine). Confirm `curl -s http://127.0.0.1:3777/api/servers` answers. Record the "before" lines in `## Notes`: `just perf-idle-cpu /nosuchserver 15 --url http://127.0.0.1:3777`, `just perf-idle-cpu /nosuchserver/0 15 --url …`, `just perf-idle-cpu / 15 --url …`, and `just perf-idle-cpu /<a-real-server-name> 15 --url …`. One instrument instance at a time. <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 R7 — find the loop. Bisect the ranked hypotheses in `## Notes` § R7 hypotheses on the worktree build (edit → `just build-frontend` or `just build` → re-measure `/nosuchserver`; or use `just dev`'s unminified bundle with `--url http://localhost:<vite-port>` and the instrument's `## js self time` to read real function names). Stop at the first toggle that drops main-thread time to idle. Record in `## Notes` § R7 finding: culprit file:line, mechanism, the evidence line, and the fix shape chosen per the Design Decision. Do NOT start T003 before this section is written. <!-- R2 -->
- [x] T003 Fix at the source in `app/frontend/src/app.tsx` (and `app/frontend/src/contexts/session-context.tsx` only if the culprit lives there) per the R7 finding: e.g. replace per-render `?? []` / fresh-object fallbacks for an absent server with module-level frozen constants (`const NO_SESSIONS: readonly ProjectSession[] = []` pattern — check `EMPTY_SLICE` in session-context for the existing idiom), stabilize the offending memo dependency, or guard a same-location `navigate`. If — and only if — the finding shows several independent effects re-firing, hoist the `resolveServerView` guard into `ServerShell` so an absent server renders `ServerNotFound`/`ServerWaiting` without mounting `AppShell`'s hook body, keeping both fallbacks below the persistent TopBar. Add a code comment stating the invariant the code cannot show (why the identity must be stable / why the guard sits where it does), with no change IDs or PR numbers. <!-- R2 -->
- [x] T004 [P] Write `app/frontend/tests/e2e/server-not-found-idle.spec.ts`: file-header comment (shared setup: no tmux fixture — any name outside the rig's `rk-test-e2e-<token>-` family is a guaranteed miss; the CDP `Performance` domain and what `TaskDuration` measures), then two `test()`s (`/rk-e2e-missing-<random>` and `/rk-e2e-missing-<random>/0`), each with a **Proves:** / **Steps:** JSDoc: goto → `expect(getByRole("heading", { name: "Server not found" }))` visible → copy names the server → the `Go to server list` link has `href="/"` → `const cdp = await page.context().newCDPSession(page); await cdp.send("Performance.enable")` → read `TaskDuration` → `page.waitForTimeout(3000)` → read again → `expect(delta).toBeLessThan(0.3)`. Use the repo's `_ready.ts` helpers only where they fit (this page has no terminal). No `@perf` tag. <!-- R5 -->
- [x] T005 [P] Add the Vitest for the fixed mechanism, colocated (`app/frontend/src/app.test.tsx` or a new `*.test.tsx` beside the fixed file): assert the property (e.g. a component rendered with an absent server and a live `TopBarSlotProvider`/`SessionContext` stub settles — render count stops growing after N commits; or the extracted helper's identity is stable across calls). It MUST fail against the pre-fix code. <!-- R6 -->

### Phase 3: Integration & Edge Cases

- [x] T006 Rebuild (`just build`, restart the rig window's `rk serve`) and record the "after" lines in `## Notes`: `/nosuchserver`, `/nosuchserver/0`, `/`, `/<real-server>` — `/nosuchserver*` renderer ≤ 5 % and main ≤ 2 %; the other two within 3 points of "before". Then re-measure the `--then` door: `just perf-idle-cpu / 15 --then /<real-server>/@<N> --url …` and `just perf-idle-cpu / 15 --then /nosuchserver --url …`; classify per R4 in `## Notes` § `--then` classification. If product-reachable and still spinning: fix it in the router/history sync and add a third `test()` to the spec that navigates via `page.evaluate(() => { history.pushState({}, "", "/rk-e2e-missing-x"); dispatchEvent(new PopStateEvent("popstate")); })` before the same CDP assertion. <!-- R4 -->
- [x] T007 Gates, scoped: `cd app/frontend && npx tsc --noEmit`; `just test-frontend`; `just test-e2e "e2e/server-not-found-idle"`; `just test-e2e "e2e/create-server-waiting"` (the waiting → view arm; note this spec is a known environmental failure under long worktree names — if it reds with a 400 on server creation and the diff touches no Go/scripts/harness, record it as environmental in `## Notes` and move on). Never the full `just test`. Fix anything the gates surface. <!-- R1 -->

### Phase 4: Polish

- [x] T008 Tear down the rig window (`tmux kill-window -t a2ep-rig`), re-read every comment you added for narration or change-ID citations and remove them, and confirm `## Notes` carries: § R7 finding, § before/after table, § `--then` classification, § e2e negative-check method (R5), § environmental e2e failures (if any). <!-- R3 -->

## Execution Order

- T001 blocks T002 (the rig is the oracle); T002 blocks T003 (finding before fix)
- T004 and T005 are independent of each other and may start once T002 names the mechanism (T005 needs it; T004 does not)
- T006 needs T003; T007 needs T003–T006; T008 last

## Acceptance

### Functional Completeness

- [x] A-001 R1: On the worktree build, `just perf-idle-cpu /nosuchserver 15` and `/nosuchserver/0 15` report renderer ≤ 5 % and main ≤ 2 %, recorded in `## Notes` beside the "before" lines (112 % / 99.4 %)
- [x] A-002 R2: `## Notes` § R7 finding names the culprit (file:line), the mechanism, the toggle evidence, and the chosen fix shape, and the code diff matches that finding
- [x] A-003 R4: `## Notes` § `--then` classification records both `--then` summary lines and one of: fixed (with the third e2e step), instrument-only (memory note deferred to hydrate), or same loop gone
- [x] A-004 R5: `app/frontend/tests/e2e/server-not-found-idle.spec.ts` exists with two `test()`s (`/$server` and `/$server/$window` forms), the CDP `TaskDuration` delta assertion `< 0.3`, and passes via `just test-e2e "e2e/server-not-found-idle"`
- [x] A-005 R6: A colocated Vitest covers the fixed mechanism and passes in `just test-frontend`

### Behavioral Correctness

- [x] A-006 R3: `ServerNotFound` still renders "Server not found", the sentence naming the server, and a `Go to server list` anchor to `/` (asserted by the e2e)
- [x] A-007 R3: The `ServerWaiting` → view swap for a just-created server still works (`create-server-waiting` spec green, or recorded as the known environmental 400 with the diff shown to touch no Go/scripts/harness)
- [x] A-008 R1: `/` and a real `/$server` page measure within 3 points of their "before" renderer/main numbers on the same rig

### Scenario Coverage

- [x] A-009 R5: The e2e was shown to fail on the unfixed build (method recorded in `## Notes`)
- [x] A-010 R6: The Vitest was shown to fail on the pre-fix code (assertion is on the property, not on implementation detail)

### Edge Cases & Error Handling

- [x] A-011 R3: No route, page, settings key, or router-table entry added; `router.tsx` route tree unchanged (Constitution IV)
- [x] A-012 R4: `scripts/perf-idle-cpu.sh` and `scripts/perf-idle-cpu.mjs` are untouched
- [x] A-013 R3: A server that disappears while viewed still flips to "Server not found" (the `gone` reap path is not short-circuited by the fix — reasoned from the diff, or exercised on the rig by killing a throwaway tmux server)

### Code Quality

- [x] A-014 Pattern consistency: new constants/helpers follow the surrounding idiom (`EMPTY_SLICE`-style module constants, colocated `*.test.tsx`, `_ready.ts`-style spec header)
- [x] A-015 No unnecessary duplication: no second copy of `resolveServerView` or of the fallback markup
- [x] A-016 Type narrowing over assertions: no new `as` casts beyond the existing `params` cast pattern
- [x] A-017 Comments state invariants, not narration; no change IDs / PR numbers in code or test comments (Test Intent rule)
- [x] A-018 Tests added for the changed behavior (e2e + Vitest) and every new `test()` carries **Proves:** / **Steps:**
- [x] A-019 No client polling introduced (`setInterval` + fetch); the e2e's `waitForTimeout(3000)` is the measurement window, not app code

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

### Live repro (2026-09-17, daemon :3000, v3.20.8 + main, headless Chromium)

```
perf-idle-cpu /nosuchserver 12.2s renderer=112.4% gpu=0% browser=0.1% main=99.4% recalcs=0 layouts=0 anims=0 xterm=0 iframes=0 ws[/ws/state]=0.3msg/s,3.3kB/s
## js by script: 4711ms main-*.js · 2748ms tip-*.js (React) · 1707ms router-*.js (TanStack) · 783ms rolldown-runtime · 438ms router-* (2nd chunk) · 295ms use-keybindings · 150ms command-palette · 75ms use-media-query · 71ms use-optimistic-action
## sockets: /ws/state 4 frames in 12 s (3 sessions, 1 metrics) — the socket is quiet; this is not socket-driven
```

Reading: the whole `AppShell` subtree re-renders continuously (keybindings, palette, media-query hooks all sampled), the state socket is quiet, and there are zero recalcs/layouts — a React render loop closed through a context or router store, not a data-driven one.

### Cleared during intake

- `computeKillRedirect` (`lib/navigation.ts`) returns `null` when `!isConnected`, and an absent server is never connected — the kill-redirect effect is **not** the loop.
- `attachedSet` in `session-context.tsx` intersects with known servers — an absent server is never subscribed on the state socket (the 4 frames in 12 s confirm it).

### R7 hypotheses (ranked — bisect in this order)

1. **Fresh empty array per render → top-bar slot re-registration loop.** `AppShell` (`app.tsx` ~:899) does `const rawSessions = ctx.sessionsByServer.get(server) ?? [];` — for an absent server the map has no entry, so every render yields a **new** `[]`; `useMergedSessions(rawSessions, server)` then returns a new merged array each render; everything memoized on `sessions` (including `topBarSlot`, ~:5300–5375) recomputes; `useRegisterTopBarSlot(topBarSlot)` (`top-bar-slot-context.tsx:218`) runs `setSlot(slot)` in an effect keyed on `slot` → `TopBarSlotProvider` state changes → its subtree (which contains the `<Outlet>` and thus `AppShell`) re-renders → new `[]` → repeat. With a real server the map returns the same array reference between socket frames, so the loop never closes. **Toggle**: replace `?? []` with a module-level `const NO_SESSIONS: ProjectSession[] = []` (and check `isConnectedByServer.get(server) ?? false` — a primitive, fine) and re-measure. Also scan the hook body for every other `?? []` / `?? {}` / `new Map()` / `new Set()` fallback that is reached only when the server is absent.
2. **A `navigate()` to the current location in an effect.** Grep every `navigate(` inside `AppShell` whose deps include `sessions`/`currentSession`/`server`; a `replace: true` to the URL already shown re-renders the route and re-fires the effect. (`computeKillRedirect` is cleared; check the others — e.g. the switch-window resolution and the `?layout=` translation effect.)
3. **`useSearch({ strict: false })` / `useMatches()` returning fresh objects on `/$server` with no `validateSearch`** feeding a memo that a state setter depends on.
4. **A `useSyncExternalStore` / zustand selector returning a fresh object** (`useWindowStore((s) => s.entries)` is a stable reference; check any selector that maps/filters).

### R7 finding

**Culprit**: `app/frontend/src/app.tsx` — `AppShell` body, the `const rawSessions = ctx.sessionsByServer.get(server) ?? [];` line (was :899 at HEAD). For a server the daemon does not have, the map has no entry, so every render produced a **fresh `[]`**.

**Mechanism** (hypothesis 1, confirmed): fresh `rawSessions` → `useMergedSessions`'s `useMemo` recomputes each render → `sessions` is a new array → the `topBarSlot` `useMemo` (~:5300) recomputes → `useRegisterTopBarSlot(topBarSlot)` (~:5385) re-runs its `[setSlot, slot]` effect → `setSlot(newObject)` → `TopBarSlotProvider` state change → its `useMemo([slot, notFound])` context value re-identities → every consumer (including `AppShell` itself) re-renders → fresh `[]` → repeat. All hooks run before the `resolveServerView` early-return, so the not-found arm kept the loop alive for the tab's lifetime. With a real server the map returns the same array reference between socket frames, so the loop never closes there.

**Toggle evidence**: one-line bisect — replacing `?? []` with a module-level `const NO_SESSIONS: ProjectSession[] = []` and rebuilding the rig dropped `just perf-idle-cpu /nosuchserver 15 --url http://127.0.0.1:3777` from `renderer=111.3% main=99.5%` to `renderer=1.5% main=0.6%` (idle floor; ~7.5 ms of JS sampled in 15 s, vs ~14.9 s before). No other hypothesis needed testing.

**Fix shape**: the small in-place fix per the Design Decision — the toggle itself is the fix (stable identity at the source). The `ServerShell` hoist was rejected: the finding is a single unstable identity, not several independent misbehaving effects.

### Before / after (worktree rig)

Worktree rig: `dist/rk serve` on `RK_PORT=3777` (tmux window `a2ep-rig`), real-server route = `/default`.

**Before (build at HEAD 615263d8):**

```
perf-idle-cpu /nosuchserver 15.1s renderer=111.3% gpu=0% browser=0% main=99.5% recalcs=0 layouts=0 anims=0 xterm=0 iframes=0 ws[/ws/state]=0.1msg/s,2.3kB/s
perf-idle-cpu /nosuchserver/0 15.2s renderer=111.5% gpu=0% browser=0.1% main=99.5% recalcs=0 layouts=0 anims=0 xterm=0 iframes=0 ws[/ws/state]=0.1msg/s,2.3kB/s
perf-idle-cpu / 15.1s renderer=1.7% gpu=0% browser=0.1% main=0.6% recalcs=0 layouts=1 anims=0 xterm=0 iframes=0 ws[/ws/state]=0.1msg/s,2.3kB/s
perf-idle-cpu /default 15.1s renderer=2% gpu=0.3% browser=0% main=0.7% recalcs=63 layouts=1 anims=2 xterm=0 iframes=0 ws[/ws/state]=0.1msg/s,2.4kB/s
```

**After (fixed build):**

```
perf-idle-cpu /nosuchserver 15.1s renderer=1.6% gpu=0% browser=0% main=0.6% recalcs=0 layouts=0 anims=0 xterm=0 iframes=0 ws[/ws/state]=0.1msg/s,2.4kB/s
perf-idle-cpu /nosuchserver/0 15.1s renderer=1.7% gpu=0% browser=0.1% main=0.6% recalcs=0 layouts=0 anims=0 xterm=0 iframes=0 ws[/ws/state]=0.1msg/s,2.4kB/s
perf-idle-cpu / 15.1s renderer=1.5% gpu=0.1% browser=0% main=0.5% recalcs=0 layouts=1 anims=0 xterm=0 iframes=0 ws[/ws/state]=0.1msg/s,2.4kB/s
perf-idle-cpu /default 15.1s renderer=2% gpu=0.3% browser=0% main=0.7% recalcs=63 layouts=1 anims=2 xterm=0 iframes=0 ws[/ws/state]=0.1msg/s,2.4kB/s
```

### `--then` classification

```
perf-idle-cpu / -> /bootstrap/0 15.1s renderer=2.9% gpu=2.4% browser=0% main=1.5% recalcs=107 layouts=2 anims=2 xterm=1 iframes=0 ws[/ws/state]=0.3msg/s,2.5kB/s ws[/ws/terminals]=0.1msg/s,0kB/s
perf-idle-cpu / -> /nosuchserver 15.1s renderer=1.6% gpu=0.1% browser=0.1% main=0.6% recalcs=0 layouts=0 anims=0 xterm=0 iframes=0 ws[/ws/state]=0.2msg/s,2.5kB/s
```

**Classification: same loop, gone.** Both `--then` doors (to a valid tty route and to `/nosuchserver`) measure at the idle floor on the fixed build — the pre-fix `--then` spin was the same per-render-`?? []` loop reached through the in-app navigation door, not a separate history-sync loop. No router fix, no third e2e step, no instrument-only memory note needed.

### e2e negative check

Method: temporarily reverted the fix in `app/frontend/src/app.tsx` (`?? NO_SESSIONS` back to `?? []`) and ran `just test-e2e "e2e/server-not-found-idle"` against the dev-server rig. Both tests FAILED as required: the CDP `TaskDuration` delta measured **2.83 s over the 3 s window** (budget < 0.3 s) — the spinning page accrues ~1 s of main-thread task time per second, exactly the pre-fix signature. The fix was then restored and the same spec passed (2 passed, 7.6 s).

Vitest negative check (A-010): with the same revert in place, `npx vitest run src/app.test.tsx -t "settles"` failed both new tests in 2.6 s — the slot-consumer probe counted **1201 renders over a 300 ms idle window** (bound ≤ 1). Restored → both pass. (The probe mounts via `createRoot` with the act environment off because `act()` drains React's queue until empty, which HANGS on the unfixed code instead of failing — verified: an act-based version of this test never returned under the revert.)

### Environmental e2e failures

None hit. `just test-e2e "e2e/create-server-waiting"` passed both tests (exit 0 on the clean rerun; an earlier piped invocation showed a cleanup-phase `ELIFECYCLE` after "2 passed" — a dev-recipe teardown artifact, not a test failure). No long-worktree 400 occurred in this run. The diff touches no Go, `scripts/`, or e2e-harness files.

## Deletion Candidates

None — this change fixes one unstable identity in place (a per-render `?? []` swapped for a module-level constant) and adds tests; no existing file, function, branch, or config became redundant or unused.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Hypothesis 1 (fresh `[]` → `useRegisterTopBarSlot` re-registration) is the most likely loop and is bisected first | Static read of `app.tsx:899` and `top-bar-slot-context.tsx:218` plus the profile (React + router store, quiet socket, whole subtree sampled); not Certain until the toggle is measured | S:75 R:90 A:75 D:70 |
| 2 | Certain | The measurement rig is the worktree's own `rk serve` on a spare port (3777 by default), never the user's `:3000` daemon | Intake § Standing context, live-daemon etiquette | S:95 R:95 A:95 D:95 |
| 3 | Confident | The e2e uses `page.waitForTimeout(3000)` as the measurement window and a `< 0.3` s threshold | Plan of record fixes both numbers; the rig's quiet-page baseline is expected well under 0.1 s | S:85 R:90 A:80 D:85 |
| 4 | Confident | The Vitest asserts a settling/identity property rather than a specific implementation, so it survives the small-fix vs hoist choice | R6's intent; exact shape depends on the R7 finding | S:70 R:90 A:80 D:70 |
| 5 | Certain | `create-server-waiting` reds with a 400 under this long worktree name are environmental and recorded, not fixed here | Project memory (long-worktree tmux socket-name cap) | S:90 R:95 A:95 D:95 |

5 assumptions (2 certain, 3 confident, 0 tentative).
