# Intake: A missing-server route must not spin the renderer

**Change**: 260917-a2ep-server-not-found-render-loop
**Created**: 2026-09-17

## Origin

> Idle CPU follow-ups — Change 7 (server-not-found-render-loop): a missing-server route must not spin the renderer. Read fab/plans/sahil/26-09-17-idle-cpu-followups.md in full (Standing context, Decisions of record, R7 pre-intake research, and § Change 7's four numbered tasks) before writing the intake. Independent of changes 5/6 — runs from its own worktree. Lane: full.

One-shot `/fab-new` from the plan `fab/plans/sahil/26-09-17-idle-cpu-followups.md` (drafted 2026-09-17 against `619184d2`, v3.20.8). This is **Change 7** of that plan and the promotion of backlog item **[a2ep]** (2026-09-16) to a change — the plan's Decisions of record say so explicitly, which is why the change carries the `a2ep` ID (so `/fab-archive` closes the backlog row). The plan's first batch (`26-09-16-idle-cpu.md`, changes 0–4) has merged; this change is file-disjoint from the plan's changes 5 (instrument renderer/headed) and 6 (flairs on tty routes) and runs in parallel from its own worktree. Lane hint from the plan: **full** — it needs a real repro test.

Key plan decisions carried into this intake verbatim:

- **The loop is found first, then fixed at the source.** The plan's § R7 pre-intake research lists candidate mechanisms but prescribes no fix; task 1 of the change is the finding, and the fix follows it.
- **Acceptance is measured with the existing instrument**: `just perf-idle-cpu /nosuchserver 15` renderer ≤ 5 %, main ≤ 2 %; `/` unchanged; the fallback page still renders its copy and its way home.
- **An e2e guards the contract** via a CDP `Performance.getMetrics` main-thread task-time delta, with the Test Intent JSDoc the constitution requires.
- **Live-daemon etiquette**: the user's `:3000` daemon and tmux servers are read-only for measurement; a changed build is measured on the worktree's own `rk serve` on a derived port with `dist` rebuilt.

## Why

**The pain point.** A route naming a tmux server the daemon does not have — `/nosuchserver`, or `/runKit` after that server was renamed to `rK` — renders the "Server not found" fallback and then burns **~109 % of one core in the renderer process (99.4 % main-thread time) for as long as the tab lives**. Measured 2026-09-17 on the live daemon (v3.20.8, `just perf-idle-cpu /nosuchserver 15`): renderer 109 %, main 99.4 %, **0 style recalcs, 0 layouts**, ~130 DOM nodes. That signature — all script, no painting — is a JavaScript re-render or redirect loop, not a rendering cost. The CPU profile is `(program)`-dominated (native), and an earlier catch attributed the samples to `tip-*.js` + `router-*.js` + `main-*.js`. It reproduces on direct load, via the instrument's `--then` in-app navigation, and under `--reduced-motion`, so flairs and motion are not involved.

**The consequence of not fixing it.** This is the largest single number in either idle-CPU plan — bigger than every flair, halo, and socket finding combined, and it is a *sustained* full core, not a transient. In the desktop app it is any window left open on a server that has since been renamed or killed: the user does not see a spinner or a warning, just a laptop fan. The fallback page has been shipping in this state since the three-way route guard landed (`260602-3i5d`), so every renamed or killed server has silently produced one hot tab per viewer.

**Why fix at the source rather than paper over it.** The 15-second repro plus the instrument's recalc/layout oracle mean the loop can be localized precisely (which effect or navigation re-fires, and what its unstable dependency is). A throttle or a debounce would hide the symptom while leaving the render loop in place for the next component that mounts under the same conditions. Fixing the dependency, the render-time navigation, or the subscription re-attempt — whichever it is — also leaves the codebase with a one-render contract for the fallback that an e2e can assert forever.

## What Changes

### 1. Find the loop (R7 — the change's first task, recorded in plan.md)

The plan's § R7 research is the entry point. The apply agent MUST record the finding (which component, which effect/navigation, which dependency) in `plan.md` before writing the fix.

**Established facts from this intake's code read** (so R7 starts from them, not from zero):

- The page reached for a `/$server` miss is **`ServerNotFound`** in `app/frontend/src/app.tsx` (defined ~:732, rendered from `AppShell` at ~:5396) — **not** `NotFoundPage` in `router.tsx`. `NotFoundPage` is the app-layout route's `notFoundComponent` and only renders for URLs that match no route at all (e.g. a 3-segment `/a/b/c` or `/board/x/y`). `ServerNotFound` renders its copy (`Server not found` / `No tmux server named <strong>{serverName}</strong> was found.`) and a plain `<a href="/">Go to server list</a>`.
- `ServerShell` (`app.tsx` ~:727) is a thin pass-through to `<AppShell />`. **`AppShell` runs its entire hook body — roughly 4,500 lines of hooks, effects, `useMemo`s and `useCallback`s between ~:890 and ~:5390 — before reaching the three-way guard** `resolveServerView(server, servers, pendingServer, serversLoaded)` (~:788) and early-returning `<ServerNotFound>`. Every one of those effects is live while the fallback is on screen.
- Two candidate loops sit in that body and name `navigate` in their effects: the **kill-redirect effect** (~:2207, deps `[sessionName, windowParam, sessions, currentSession, currentWindow, isConnected, navigate, server]`) which calls `navigate({ to: "/$server", params: { server }, replace: true })` when `computeKillRedirect` returns a target, and the surrounding **URL-key / `currentWindowEverSeenRef` tracking effect** (~:2197). For an absent server `sessions` is empty, `currentSession` is `undefined`, `isConnected` is `false`; whether `computeKillRedirect` returns a `dashboard` target in that state (and whether `navigate` to the *same* `/$server` URL re-renders → re-fires) is the first thing to check.
- In `app/frontend/src/contexts/session-context.tsx`: the effective attach set (`attachedSet`, ~:747) is `currentServer ∪ attachedNonCurrent ∩ knownServers`, so an absent server is **never subscribed** on the state socket — the "one subscription attempt for an absent server key" candidate from the plan is likely already satisfied and should be confirmed rather than assumed. `pendingServer` is `null` for a never-created server; `serversLoaded` flips `true` in `fetchServers()`'s `finally`. The `setChromeConnected` mirror effect (~:769) runs on every `slicesByServer` change even when `currentServer` has no slice.
- `AppShell` derives `server` as `ctx.currentServer ?? params.server ?? ""` (~:898); `currentServer` is set by the provider from the route. Check whether an absent-server route bounces `currentServer` between the param and `null`/`""` across renders.
- The instrument's `--then` fallback is `history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate"))` (`scripts/perf-idle-cpu.mjs` ~:253–269). R7 notes that `--then` to a **valid** tty route also spun at 109 % while the page showed the terminal, whereas a real sidebar click did not — so a second, history-sync loop may exist. It is investigated **after** the primary loop (see § 3).

**Method** (Standing context): `just perf-idle-cpu /nosuchserver 15` for the number; a CPU profile (`page.coverage` / CDP `Profiler.start` with 1 ms sampling — the instrument already opens a CDP session) to name the frames; then a bisect by `--inject` (route `--inject` through `scripts/perf-idle-cpu.sh` directly when the JS contains parentheses — `just`'s `{{args}}` does not re-quote) or by temporarily short-circuiting the suspected effect in a worktree build served on a derived port. One instrument instance at a time. Noise floor ≈ 3 points.

### 2. Fix at the source

The fix shape follows the finding. The plan enumerates the admissible shapes; pick the one the finding demands, no more:

- **stable effect deps** — a dependency that is a fresh object/array each render (a `useMemo` missing, a default `[]`, a `Map` rebuilt per render) is stabilized or replaced with a primitive key;
- **no navigation during render or in a self-triggering effect** — a `navigate()` whose target equals the current location (a `replace: true` to the very `/$server` URL already shown) must not fire, or must be gated on a condition that becomes false after it fires (the existing `currentWindowEverSeen` gate is the precedent, memory § "`currentWindowEverSeen` gate on kill-redirect");
- **one subscription attempt for an absent server key** — if the state-socket diff effect or an ack/gone handler re-attaches an unknown key, guard it once (confirm first whether `attachedSet`'s intersection with `knownServers` already covers this — see § 1);
- **a router-level guard** — hoisting the three-way `resolveServerView` decision **above** `AppShell`'s hook body (e.g. into `ServerShell`, which is today a one-line pass-through) so an absent server never mounts the 4,500-line hook body at all. This is admissible under Constitution IV (no new route, no new page — the route table is untouched; `ServerNotFound` and `ServerWaiting` keep rendering below the persistent TopBar inside `AppLayout`'s `<Outlet>`), and it turns the fallback into a genuinely cheap page rather than a cheap page sitting on an expensive component. If the finding is a single unstable dep, the smaller fix wins; if several effects misbehave on an absent server, the hoist is the source fix.

Whatever the shape, the fallback's **behavior contract is unchanged**: the "Server not found" copy names the server, the "Go to server list" link goes to `/`, the `ServerWaiting` arm for a just-created server (`pendingServer`) still swaps to the server view when the refreshed list contains it, and a *later* genuine deletion of a server the tab is on still flips to "Server not found" (the `gone` reap path, memory § Server-Gone Reap). Kill/not-found redirects still land on `/$server`, never `/`.

### 3. The `--then` pushState spin

After the primary loop is fixed, re-run the instrument's `--then` path to a **valid** tty route (`just perf-idle-cpu / 15 --then /<server>/@<N>` against a worktree build) and to `/nosuchserver`. Two outcomes:

- **It still spins** → TanStack Router's history sync loops on an externally pushed `popstate` without a matching router `location.state`. If that is a product-reachable path (browser back/forward, the desktop shell's `webContents.goBack`, deep links opened via `history.pushState` from the code lens), fix it in the router setup or the sync effect and add it to the e2e (a `page.evaluate(() => { history.pushState({}, "", "/nosuchserver"); dispatchEvent(new PopStateEvent("popstate")); })` step). If it is reachable **only** through the instrument's synthetic `pushState + popstate` fallback, document it as instrument-only in `docs/memory/run-kit/architecture/testing.md` § Performance probes ("`--then`'s pushState fallback is not a faithful in-app navigation; prefer a route with a clickable `a[href]`") and leave the instrument alone (changing the instrument's navigation is change 5's file territory).
- **It no longer spins** → it was the same loop reached by a second door; record that in `plan.md` and move on.

### 4. Tests

**e2e (the standing guard)** — `app/frontend/tests/e2e/server-not-found-idle.spec.ts`, run through `just test-e2e "server-not-found-idle"` (one spec per run — a bare name that matches the worktree folder runs the whole suite). It runs in the default e2e set as a gate, not `@perf`-tagged like `gui-perf.spec.ts` (that spec is an audit of noisy loopback timings; this one asserts an ~0 vs ~3 s difference). Shape:

```ts
/**
 * Loading a route whose tmux server the daemon does not have renders the
 * "Server not found" fallback once and then idles — no re-render or redirect
 * loop keeps the main thread busy while the tab is open.
 *
 * Shared setup: the e2e rig's daemon knows only the rk-test-e2e-<token>-*
 * socket family, so any other server name is a guaranteed miss; no tmux
 * fixture is needed. A CDP session on the page reads
 * Performance.getMetrics, whose TaskDuration is the cumulative main-thread
 * task time in seconds.
 */

/**
 * Proves: the "Server not found" fallback for `/$server` renders its copy and
 * its way home, then leaves the main thread quiet.
 * Steps:
 *  1. Open /rk-e2e-missing-<random> and wait for the "Server not found" heading.
 *  2. Assert the copy names the server and the "Go to server list" link points at "/".
 *  3. Open a CDP session, enable Performance, read TaskDuration (t0).
 *  4. Wait 3 s with no interaction.
 *  5. Read TaskDuration again; assert (t1 - t0) < 0.3 s.
 */
```

A second `test()` covers the `/$server/$window` form (`/rk-e2e-missing-<random>/0`) with the same steps; a third covers the in-app door if § 3 finds a product-reachable history-sync loop. Use `page.context().newCDPSession(page)`; the threshold is **0.3 s of main-thread task time over a 3 s window** (the plan's number — a spinning page accrues ~3.0 s, a quiet SPA on the rig well under 0.1 s). The test does not read renderer CPU % (process sampling is the instrument's job and is too noisy for a gate).

**Vitest** — colocated with the fixed hook/component: if the fix is a dependency or gate change in `app.tsx`, extend `app/frontend/src/app.test.tsx` (which already covers `resolveServerView`) or add a unit for the extracted helper (e.g. a pure `shouldRedirectFromAbsentServer(...)` if the kill-redirect gate is the culprit, alongside the existing `computeKillRedirect` tests); if the fix is the `ServerShell` hoist, a render test asserting `AppShell`'s hook body does not mount for an absent server (e.g. a mocked heavy child never renders). Follow the existing colocated `*.test.tsx` pattern.

### 5. Verification and acceptance (recorded in plan.md before/after)

- `cd app/frontend && npx tsc --noEmit`; the affected Vitest files via `just test-frontend`; the new spec via `just test-e2e "server-not-found-idle"`. **Never the full `just test` as a gate** (Standing context; the long-worktree-name e2e failures are environmental).
- Instrument, against the worktree's own build on a derived port (`just build` → `rk serve --port <derived>`; `--url http://127.0.0.1:<port>`), before and after:
  - `just perf-idle-cpu /nosuchserver 15 --url …` → renderer **≤ 5 %**, main **≤ 2 %** (was 109 / 99.4).
  - `just perf-idle-cpu /nosuchserver/0 15 --url …` (the `/$server/$window` form) → same bounds.
  - `just perf-idle-cpu / 15 --url …` → unchanged within the 3-point noise floor (was renderer 3.0, main 0.9).
  - `just perf-idle-cpu /<real-server> 15 --url …` → unchanged within noise (proves the guard did not slow the real server page).
- Manual: the fallback page still shows "Server not found", the server's name, and the "Go to server list" link; clicking it lands on `/`.

### Non-goals

- New flairs, the ambient-motion setting, changes to `scripts/perf-idle-cpu.*` (change 5's files), `NotFoundPage` for non-server misses unless R7 shows it shares the loop (then it is one more line in the e2e, not a redesign).
- Any new route, page, or settings key (Constitution IV).
- A desktop-lane e2e: the fix lives in the shared frontend, so the desktop shell's "window left on a renamed server" case is covered by the web spec.

## Affected Memory

- `run-kit/ui/routes-and-shell`: (modify) § URL Structure — the "Server not found" paragraph gains the **one-render contract** (the fallback renders once and idles; no effect or navigation re-fires for an absent server) and names the mechanism R7 found; § Design Decisions gains the entry for the chosen fix shape (four-field Decision / Why / Rejected / Introduced by). Also correct the stale route-table row that calls `NotFoundPage` the "root `notFoundComponent`" — it lives on the `app-layout` route.
- `run-kit/api-and-sockets`: (modify) **only if** the absent-server subscription path changed — the state-socket section's `attachedSet` / subscribe-diff description gains the one-attempt guard. If R7 confirms the intersection with `knownServers` already prevents any subscribe, leave this file untouched.
- `run-kit/architecture/testing`: (modify) **only if** § 3 lands on "instrument-only" — § Performance probes gains the note that `--then`'s `pushState + popstate` fallback is not a faithful in-app navigation. Also the e2e layer list gains the new spec's one-line description (CDP `Performance.getMetrics` as an idle-main-thread oracle) since it is the first e2e to use that oracle.

## Impact

- **Code**: `app/frontend/src/app.tsx` (`AppShell` hook body / `ServerShell` / the kill-redirect and URL-key effects, ~:727–800, ~:2190–2240, ~:5385–5400), possibly `app/frontend/src/contexts/session-context.tsx` (`attachedSet`, the subscribe-diff effect ~:1174, the `setChromeConnected` mirror ~:769). No backend, no API, no router table change.
- **Tests**: new `app/frontend/tests/e2e/server-not-found-idle.spec.ts`; extended `app/frontend/src/app.test.tsx` or a new colocated `*.test.tsx`.
- **Docs**: the memory files above; no spec change (`docs/specs/architecture.md`'s route list is unchanged).
- **Risk**: the three-way guard's `waiting` arm and the `gone` reap flip are the two behaviors most likely to regress from a hoist or a gate change — both have existing e2e coverage (`create-server-waiting`, the legacy sweep specs) to run scoped after the fix.
- **Parallel work**: file-disjoint from change 5 (`scripts/perf-idle-cpu.*`, `architecture/testing.md` § Performance probes — shared only if § 3's instrument-only note lands; coordinate the doc paragraph at merge) and change 6 (`globals.css`, `flair-overlay.tsx`, `terminal-client.tsx`, `ui/visual-design.md`).

## Open Questions

- None blocking. R7's finding decides between the small-fix and the `ServerShell`-hoist shapes; the plan authorizes both.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The change is created under backlog ID `a2ep` (`--change-id a2ep`) so `/fab-archive` closes the backlog row | Plan § Decisions of record: "a2ep is promoted from backlog to a change"; the invocation text itself is natural language, hence not Certain | S:80 R:40 A:85 D:85 |
| 2 | Certain | The loop is found first (R7) and the fix follows the finding; the intake prescribes no fix | Plan § Change 7 task 1 and § R7 say so explicitly; four admissible fix shapes enumerated | S:95 R:90 A:90 D:90 |
| 3 | Confident | Hoisting `resolveServerView` into `ServerShell` above `AppShell`'s hook body is an admissible "router-level guard" under Constitution IV | Route table, pages, and TopBar placement are unchanged; only which component runs the hooks for an absent server. Not Certain because the plan's phrase "router-level guard" could be read as a TanStack `beforeLoad`, which memory § Design Decisions rejected for the overview case | S:70 R:70 A:80 D:70 |
| 4 | Certain | The e2e lives at `app/frontend/tests/e2e/server-not-found-idle.spec.ts`, uses `page.context().newCDPSession` + `Performance.getMetrics` `TaskDuration`, asserts a delta < 0.3 s over 3 s, and carries the Test Intent JSDoc | Plan § Change 7 task 4 fixes the oracle, the window, and the threshold; the constitution fixes the comment form; the path is the repo's actual e2e dir (the plan's `tests/e2e/` is relative to `app/frontend/`) | S:90 R:85 A:95 D:95 |
| 5 | Confident | The e2e runs in the default e2e set as a gate, not `@perf`-tagged | Plan says "an e2e guards it"; the signal is ~3.0 s vs ~0 s, not a noisy latency distribution like `gui-perf.spec.ts`. Reversible by adding the tag if the rig proves noisy | S:75 R:90 A:75 D:75 |
| 6 | Certain | Acceptance: `/nosuchserver` renderer ≤ 5 %, main ≤ 2 %; `/` and a real server page unchanged within the 3-point floor; measured on the worktree's own `rk serve` on a derived port, never the user's `:3000` daemon | Plan § Change 7 task 3 + Standing context (instrument, noise floor, live-daemon etiquette) | S:95 R:90 A:95 D:95 |
| 7 | Confident | The `--then` pushState spin is fixed only if product-reachable; otherwise documented as instrument-only in `architecture/testing.md` § Performance probes, leaving `scripts/perf-idle-cpu.*` to change 5 | Plan § Change 7 task 2 gives both arms; the file-disjointness with change 5 decides where the instrument-side note may land | S:80 R:80 A:70 D:70 |
| 8 | Certain | Verification is `tsc --noEmit` + affected Vitest + the one scoped e2e; never the full `just test` as a gate | Standing context; project memory records environmental full-suite e2e failures in long-named worktrees | S:95 R:95 A:95 D:100 |
| 9 | Confident | The `/$server/$window` form of a missing server is covered by the same fix, a second `test()`, and a second instrument run | Plan's intake seed names both forms; `terminalRoute` is a child of `serverLayoutRoute`, so `AppShell` is the common component | S:80 R:85 A:85 D:85 |
| 10 | Confident | No desktop-lane e2e; the desktop "window left on a renamed server" case rides the shared frontend fix | Plan's Why names the desktop case as motivation, not as a separate surface; `app/desktop/tests/e2e` drives the same SPA | S:70 R:85 A:80 D:80 |
| 11 | Certain | Memory: `ui/routes-and-shell` gains the one-render contract and a Design Decision; `api-and-sockets` and `architecture/testing` change only under their stated conditions; also fix the stale "root `notFoundComponent`" row | Plan § Change 7 Memory line; the stale row was observed during this intake's read of `router.tsx` vs the memory table | S:90 R:95 A:90 D:90 |
| 12 | Confident | The absent-server state-socket subscription is likely already prevented by `attachedSet ∩ knownServers`; R7 confirms rather than adds a guard | Read of `session-context.tsx` ~:747 during intake; not Certain until the diff effect and ack/gone handlers are traced under the repro | S:70 R:85 A:75 D:75 |

12 assumptions (5 certain, 7 confident, 0 tentative, 0 unresolved).
