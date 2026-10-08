# Intake: State-Socket Broadcasts Only When Something Changed

**Change**: 260916-07pj-state-socket-broadcast-dedup
**Created**: 2026-09-16

## Origin

> The /ws/state hub emits metrics, services, code-server and gui only when their JSON changed and only on dispatch ticks, and a sessions frame is not re-sent when nothing but activityTimestamp moved — so a quiet host pushes near-zero frames and every warm renderer parses proportionally less.
>
> Full context lives in fab/plans/sahil/26-09-16-idle-cpu.md — read the whole file before starting, especially "## Change 3 — state-socket broadcasts only when something changed", "## Pre-intake research" R4 (do this first — it decides the activityTimestamp treatment and confirms the wake-source), "## Standing context", and "## Decisions of record". This is change 3 of 5 in the plan — full lane (backend + frontend), measured with animations already fixed (changes 1 and 2 are now merged, so the CPU floor should be clean for this change's before/after). Use `just perf-idle-cpu` for acceptance. After intake, proceed through the full pipeline yourself (fab-fff) to implementation, review, hydrate, ship, and PR.

One-shot invocation via `/fab-new`. Plan of record: `fab/plans/sahil/26-09-16-idle-cpu.md` § Change 3 (this is change 3 of 5; changes 0 — the instrument, PR #991 — 1 — flairs, PR #1003 — and 2 — halo/seam, PR #1001 — are merged on `main`). The plan's pre-intake research item **R4** was executed before this intake was written; its results are recorded in § Why → R4 results and drive the design below.

## Why

**The problem.** Every `/ws/state` client parses four host-global frames (`metrics`, `services`, `code-server`, `gui`) on every poll-loop wake-up, whether or not anything changed, and one `sessions` frame per subscribed server whenever the marshalled snapshot differs — including when the only difference is a `window_activity` timestamp on a window that is already reported `active`. Measured on 2026-09-16 (R4, below), the four globals are **91–92 % of all frames** in every regime, and 6 of every 7 loop wake-ups are fold-only unit-completion echoes that dispatch nothing new yet still re-broadcast all four. A quiet host therefore pushes 2.2–2.6 msg/s to every open tab; a host with rename churn pushes 12 msg/s. The plan's measurement puts the renderer-side cost of this at 1–3 % of a core per renderer — below the ~3-point instrument noise floor for one page, which is why the plan classifies this change as **hygiene, not a CPU fix** (§ Decisions of record): it multiplies across every warm Electron `WebContentsView`, every open tab, every sidebar-attached server, and the Go daemon's own marshal + fan-out work.

**If we don't fix it.** Frame volume scales with (tabs × subscribed servers × tick rate); the desktop shell keeps many warm views. The redundant frames are pure waste that grows with fleet size, and the acceptance is objectively measurable without CPU measurement (messages/s from the instrument's per-socket table).

**Why this approach.** Two independent mechanisms, both taken because R4 shows both matter: (1) **gate placement** — the globals ride only *dispatch* ticks (the `if !resultsOnly` branch), because a fold-only tick has nothing new to say and there are six of them per dispatch tick; (2) **change-only emission** — each global is compared against its cached slot before `broadcastGlobalLocked`, so a dispatch tick whose payload is byte-identical emits nothing. For `sessions`, the existing `previousJSON` dedup is kept but its **key** stops seeing `activityTimestamp` on windows whose `activity` is `"active"` (the client renders no timestamp for active windows — it shows `flowing`), while the **wire payload is unchanged**. Client-side, the raw-string dedups stay as defence in depth and the one unconditional fan-out (per-server `metrics` slice write) is gated on the same changed-check.

### R4 results (2026-09-16, recorded here as the decision input)

Rig: the live Homebrew daemon on `:3000` (release build — pre-dates changes 1–2, so its CPU column is not comparable; only its socket table is used) and a **probe build of this worktree at HEAD** on `:3777` with a temporary `slog.Debug` line at `waitForNext`'s classification point (not committed), isolated `XDG_STATE_HOME`/`RK_CONFIG_DIR`, serving `app/frontend/dist`. Churn regime: a throwaway tmux server `rk-perf-dedup` (`tmux -L rk-perf-dedup`) with a `churn` window running a `cd` loop every 0.3 s under `automatic-rename-format '#{b:pane_current_path}'` and a `quiet` window. Instrument: `just perf-idle-cpu <route> 60 --url <base>`.

| Run | Route / daemon | msg/s | kB/s | frames / 60 s by type |
|---|---|---|---|---|
| before-root | `/` on `:3000` | 2.2 | 3.4 | 30 metrics · 30 services · 30 code-server · 30 gui · 10 sessions · 2 pong |
| before-rK | `/rK` on `:3000` | 2.2 | 3.3 | 30 metrics · 30 services · 30 code-server · 30 gui · 10 sessions · 2 pong |
| probe-quiet-rK | `/rK` on `:3777` (HEAD build) | 2.6 | 2.9 | 35 metrics · 35 services · 35 code-server · 35 gui · 16 sessions · 2 pong |
| probe-churn | `/rk-perf-dedup` on `:3777` | 12.1 | 14.8 | 168 metrics · 168 services · 168 code-server · 168 gui · 56 sessions · 2 pong |

Wake-source tally from the probe log (`waitForNext` return classification; `timer` reads false because `selectFirst` consumes the timer channel — the `results=false woke=false bumped=false` rows are the timer wins):

| Regime | Wake-ups | Timer wins | Fold-only (`resultsOnly=true`) | Results with pending flag (full tick) | Wake / bump |
|---|---|---|---|---|---|
| quiet `/rK` (6 servers subscribed, covered → 12 s safety timer) | 7 per 12 s steady | 5 / 60 s | 36 | ~285, **all inside a 1 s burst at subscribe time** (297 wake-ups in one second while six cold servers came up) | 5 wakes, 1 bump |
| churn `/rk-perf-dedup` (6 servers, one uncovered → 2.5 s legacy cadence) | 7 per 2.5 s steady | 26 / 65 s | 163 | 41 | 3 wakes, 1 bump |

Conclusions that bind the design:

1. **The dominant wake source is the safety/legacy timer, and each dispatch tick is followed by one fold-only echo tick per subscribed server** (6 servers → 7 wake-ups per period). The four globals are broadcast on every one of the 7, so **gate placement alone removes 6/7 of global frames** in steady state. The plan's alternative hypothesis — control-mode `%window-renamed` bumps driving the loop — is **not** what R4 saw: `bumped=true` fired once per run even with a 0.3 s `cd` loop on a covered server (the rename surfaced through the timer-driven dispatch instead). Dedup is still needed because a timer-driven dispatch tick re-emits identical `services`/`code-server`/`gui` payloads and an identical `sessions` payload differing only in an active window's `activityTimestamp`.
2. **`metrics` changes every collector tick** (`metricsPollInterval = 2.5 s`; the CPU sample ring moves), so change-only emission floors `metrics` at one frame per dispatch tick, never below the tick cadence. On `/` (metrics sentinel only) the cadence is the 2.5 s legacy interval by design (`safetyIntervalEffective`'s sentinel-only rule), so `/` cannot reach the plan's 0.3 msg/s figure — that figure applies to a covered server route. Acceptance below is stated per route accordingly.
3. **`activityTimestamp` treatment**: exclude-from-key, but only for windows already reported `activity: "active"`. Rationale: the client (`sidebar/registers.ts` `getOutputLine`) renders `<cmd> · flowing` for active windows and never reads the timestamp there; for an idle window it renders `idle <formatDuration(now − activityTimestamp)>`, so a moved timestamp on an *idle* window (an output burst that fell between two ticks) IS a visible label change and must still ship. Quantizing to the 10 s `ActivityThresholdSeconds` bucket was rejected: it would change the wire value (label precision ±10 s under 60 s) for no gain over the active-only exclusion.
4. Two observations outside this change's scope, to carry into the ship report for backlog filing: (a) the **subscribe-time hot loop** — 297 wake-ups in one second while six cold servers came up, results ticks with pending flags re-dispatching in a tight cycle until every unit settled; (b) **automatic-rename churn does not bump the control-mode subscriber** on this build (renames surface via the timer), which contradicts the plan's `%window-renamed` narrative and deserves its own look.

## What Changes

### 1. Hub — host-global broadcasts ride dispatch ticks only (`app/backend/api/sse.go` `poll()`)

Today (lines ~1919–1972 at HEAD `5102c0b5`) the tick shape is `fold → sweep → global broadcasts → dispatch (if !resultsOnly) → wait`. The four global emitters (`metrics`, `services`, `code-server` via `codeServerTick()`, `gui` via `guiTick()`) move **inside** the `if !resultsOnly { … }` block, ahead of the per-server dispatch loop, so a fold-only tick emits no global. The dead-server reap and the retain sweeps stay where they are (they act on folded results, which is what a fold-only tick exists for). Late-joiner replay (`replayGlobalSlots`, `stateSubscribe`'s ack snapshot) is unchanged — the cached slots still serve first frames.

Contract-level consequence to document: `metrics`/`services`/`code-server`/`gui` freshness is bounded by the dispatch cadence (safety/legacy timer or an event-driven full tick), which is the same bound the `sessions` snapshots already have. On `/` that is 2.5 s (unchanged); on a covered server route it is 12 s or the next wake — previously the same 12 s plus six identical echoes.

### 2. Hub — change-only emission for the four globals

Each emitter compares its freshly marshalled payload string with its cached slot **under `h.mu`** and skips the `broadcastGlobalLocked` when equal (the slot is already current, so no write is needed either). Shape for the three inline emitters:

```go
// metrics (services and code-server follow the same shape)
if h.metrics != nil {
    snap := h.metrics.Snapshot()
    if metricsJSON, err := json.Marshal(snap); err == nil {
        metricsStr := string(metricsJSON)
        ev := preRendered(hubEvent{kind: kindGlobal, typ: "metrics", data: metricsStr})
        h.mu.Lock()
        if metricsStr != h.cachedMetricsJSON {
            h.cachedMetricsJSON = metricsStr
            h.broadcastGlobalLocked(ev)
        }
        h.mu.Unlock()
    }
}
```

Note the `preRendered` marshal still happens before the lock (the existing "render outside the lock" discipline); rendering an envelope that is then not sent is acceptable on a 2.5–12 s tick, or the apply MAY move `preRendered` inside the changed branch (one extra envelope marshal under the lock is the trade — either is fine; keep whichever the review finds cleaner, but do NOT hold `h.mu` across `Snapshot()`/`json.Marshal(snap)`).

`guiTick()` (line ~837–845): `guiPayloadLocked()` renders the payload; the **dedup key for `gui` excludes `human_input_ago_ms`** because that field is a live age (`gui.HumanInputAgoMS(at, now)`) that changes every tick once any viewer has driven the display, and no frontend consumer reads it from the stream (`grep -rn human_input_ago_ms app/frontend/src` → only the `GuiStreamEntry` type in `api/client.ts`; the CLI human-input guard reads the `/api/gui/{id}` status document, not the stream). Implementation: `guiPayloadLocked` returns `(payload, key string)` where `key` is the same entry marshalled with `HumanInputAgoMS` zeroed (a second marshal of a one-element struct slice — negligible), and the hub keeps a `cachedGuiKey` beside `cachedGuiJSON`; broadcast + slot update happen only when `key != h.cachedGuiKey`. `setGUIEnabled` (the POST seam) keeps broadcasting unconditionally — it is the synchronous flip path and must stay one-state-event fast; it updates both the slot and the key.

`code-server`: `codeServerPayload{Reachable}` — compare the two-value payload string with `cachedCodeServerJSON`; identical shape to metrics.

### 3. Hub — `guiTick` stops parsing the settings file every tick

`guiTick()` currently calls `settings.Load()` (read + YAML parse) on every wake-up. Replace with a **change-stamp gate**: `internal/settings` gains an exported `Stamp()` (or equivalently `LoadIfChanged(prev)`) that stats the resolved config path (falling back to the legacy path exactly as `Load()` does) and returns a fingerprint (path + mtime + size); the hub stores the last fingerprint and calls `settings.Load()` only when it differs (and once on the first tick). A CLI-side `rk gui on` / `rk gui resize` writes the file via `Save`, changing the mtime, so it still surfaces on the next dispatch tick — the same latency as today. The settings POST path (`setGUIEnabled`) is untouched. Together with § 1 this drops the per-wake-up settings parse from 7 per period to at most 1 per settings change.

The memory Design Decision "Hub re-reads the settings file per tick; POST flips synchronously" (`docs/memory/run-kit/gui.md`) is revised at hydrate: the *mechanism* becomes "stat-gated re-read on dispatch ticks", the *why* (CLI writes the file directly) is unchanged.

### 4. Hub — `sessions` dedup key ignores `activityTimestamp` on active windows (`pollServerUnit`, `sse.go` ~2198–2231)

Today: `jsonStr := string(json.Marshal(result))`; `changed := jsonStr != h.previousJSON[server]`; on change, `previousJSON[server] = jsonStr` and fan out. After:

- Compute `jsonStr` exactly as today — it stays the **wire payload** and the **ack/replay snapshot** (`previousJSON[server]` continues to hold the last *sent* payload, which is what every connected client holds — `addClient` line ~620 and `stateSubscribe` line ~1087 read it).
- Compute `key := sessionsDedupKey(result)` — the same snapshot marshalled with `ActivityTimestamp` set to `0` on every window whose `Activity == "active"` (shallow-copy the `[]ProjectSession` and each `Windows` slice before zeroing; never mutate `result` — it is the cached slice `attachPRStatus` and previews read). Add `previousSessionsKey map[string]string` beside `previousJSON`; `changed := key != h.previousSessionsKey[server]`; on change update **both** maps under the same lock and fan out `jsonStr`. Delete the new map entry wherever `previousJSON` is deleted (the dead-server reap block ~1896).
- Idle windows keep their timestamp in the key: an output burst between two ticks on an idle window changes the `idle <dur>` label and must ship. The `Activity` flip itself (`active` ↔ `idle`, 10 s after output stops) is a visible change and ships as today. `agentIdleDuration` (formatted `Ns`/`Nm`/`Nh`) stays in the key — it is a rendered label and changes are real; its sub-minute one-second granularity is a known second churn source for the first minute of an idle/waiting agent and is a **non-goal** here.
- Ack-ordering invariant (memory § Hub edge) is preserved: both maps are written before the fan-out of that tick, in the same critical section.

The plan's line reference `tmux.go:823` (`ActivityTimestamp int64 \`json:"activityTimestamp"\``) needs **no change** — the struct and wire field are untouched.

### 5. Client — per-server `metrics` fan-out gated on the changed-check (`app/frontend/src/contexts/session-context.tsx` ~924–937)

`applyHostMetrics(raw, snap)` returns `boolean` (true when the raw payload differed from `hostMetricsPrevRef`). The `metrics` branch of `handleGlobalEvent` runs the `for (const name of subscribedServersRef.current) updateSlice(name, { metrics: snap }, true)` fan-out **only when it returned true** — today an identical payload (reconnect replay, or the ack snapshot repeating the slot) re-writes every attached server's slice and re-renders the whole tree on identical data. The raw-string dedups for `services`/`code-server`/`gui` stay exactly as they are (defence in depth now that the server dedups too). Vitest: extend `session-context.test.tsx` "dedupes identical host-metrics payloads" (line ~631) with a per-server-slice probe (`useMetrics()` under a current server) asserting no slice re-render on the identical second emit and an update on the changed third.

### 6. Tests (Go)

`app/backend/api/sse_test.go` (the file that already exercises `previousJSON` dedup — `TestSSEHubDeduplication` ~302, `TestSSEHubServicesBroadcast` ~193, `TestSSEHubCodeServerBroadcast` ~227, `TestSSEHubSlowServerDoesNotDelayMetrics` ~1332) gains:

- `TestSSEHubGlobalsNotRebroadcastWhenUnchanged` — a static metrics/services/code-server payload across ≥ 3 ticks yields exactly one frame of each per client (plus the late-joiner replay for a second client).
- `TestSSEHubGlobalsSkipFoldOnlyTicks` — drive a results-only tick (unit completion with no pending flag; the `sse_race_test.go` `TestSSE_PendingEventDrivenDispatchSurvivesResultsOnlyTick` harness shows the shape) and assert no global frame is emitted on it.
- `TestSSEHubSessionsDedupIgnoresActiveActivityTimestamp` — two fetches differing only in an `active` window's `ActivityTimestamp` → one `sessions` frame; the same on an `idle` window → two frames; an `Activity` flip → two frames.
- `sse_gui_test.go`: `TestGuiTickDedupIgnoresHumanInputAge` (two ticks after `guiHumanInputSeen` → one `gui` frame) and `TestGuiTickReloadsSettingsOnlyWhenStampChanges` (count `settings.Load` via the stamp seam or by touching the file). The existing `TestGuiTickProbeTTL` / `TestGuiTickProbeFlipAfterTTL` call `guiTick()` directly and read `cachedGui` — they keep passing because the slot is still updated on change; re-check `TestSetGUIEnabledSynchronousBroadcast` (unconditional POST broadcast preserved).
- `internal/settings`: a unit test for the new stamp helper (unchanged file → equal stamp; `Save` → different stamp; legacy fallback mirrors `Load`).
- Keep `go test -race ./api/` green — the global-broadcast move changes lock hold shape around `broadcastGlobalLocked`; `sse_race_test.go`, `present_test.go`, `update_test.go`, `state_ws_test.go` (`TestStateWS_MetricsSubscriptionReceivesBroadcast`, `TestStateWS_ConcurrentGlobalBroadcast`, `TestStateWS_HelloReplaysGlobalSlots`) must pass unmodified or with assertion updates that reflect the new contract, never loosened timing.

### 7. Acceptance measurement (the instrument, same-binary A/B)

Record a before/after table in `plan.md`. Both sides are **this worktree's Go binary** serving `app/frontend/dist` (the release `:3000` daemon cannot show the AFTER — it is a different build; see the rig note below). Before = HEAD build (`/tmp/claude-1001/…/scratchpad/rk-before` already built; rebuild with `git stash`-free means if lost: `cp configs/tmux/default.conf app/backend/build/tmux.conf && cd app/backend && CGO_ENABLED=0 go build -o <scratch>/rk-before ./cmd/rk` on a clean HEAD checkout of `sse.go`, e.g. `git show HEAD:app/backend/api/sse.go`); After = the changed build with `pnpm build` re-run for the client change. Run each on `RK_PORT=3777 RK_HOST=127.0.0.1 RK_CODE_SERVER_PORT=3779 XDG_STATE_HOME=<scratch>/xdg-state RK_CONFIG_DIR=<scratch>/rk-config <binary> serve` from the repo root, **one daemon at a time on the port**, and measure with `just perf-idle-cpu <route> 60 --url http://127.0.0.1:3777`. The `rk-perf-dedup` throwaway tmux server (created for R4 — `churn` window with the 0.3 s `cd` loop, `quiet` window) provides the churn regime; recreate it if gone:

```sh
tmux -L rk-perf-dedup new-session -d -s perf -n churn -c /tmp 'while true; do cd /tmp; sleep 0.3; cd /usr; sleep 0.3; cd /var; sleep 0.3; done'
tmux -L rk-perf-dedup set-option -g automatic-rename-format '#{b:pane_current_path}'
tmux -L rk-perf-dedup set-option -w -t perf:churn automatic-rename on
tmux -L rk-perf-dedup new-window -d -t perf -n quiet -c /tmp 'sleep 100000'
```

Kill it with `tmux -L rk-perf-dedup kill-server` and stop the `:3777` daemon when done. Never touch the user's own tmux servers or the `:3000` daemon.

Targets (60 s windows; per-socket table of the summary line and `## sockets`):

| Route | Before (HEAD build, measured) | After — required |
|---|---|---|
| `/rK` quiet, covered (12 s cadence) | 2.6 msg/s; 35 of each global | **≤ 0.5 msg/s total**; `services`/`code-server`/`gui` ≤ 1 frame each in 60 s (the first-tick emit only); `metrics` ≤ 6 frames (one per dispatch tick); `sessions` ≤ before |
| `/` sentinel-only (2.5 s cadence) — measure on `:3777` for a same-build pair | (measure) | `services`/`code-server`/`gui` ≤ 1 each in 60 s; `metrics` ≤ 25 (≤ one per 2.5 s tick); total ≤ 0.6 msg/s |
| `/rk-perf-dedup` churn (2.5 s legacy cadence, 6 servers) | 12.1 msg/s; 168 of each global; 56 sessions | `services`/`code-server`/`gui` ≤ 1 each; `metrics` ≤ 25; `sessions` ≤ 1/s per subscribed server (≤ 60 for one server, ≤ before overall); total ≤ 1.5 msg/s |
| Renderer CPU on `/` and `/rK` | (measure on the same rig) | not worse than before beyond the 3-point noise floor — the CPU claim is "no regression"; the gain claim is the message count |

### 8. Docs / memory (hydrate)

- `docs/memory/run-kit/api-and-sockets.md` § Poll loop: replace "The host-global broadcasts (`metrics`, `services`, `code-server`) are emitted every tick AHEAD of per-server dispatch" with the dispatch-tick + change-only rule; § `event: code-server` and § `event: gui`: replace "on every tick … client-side raw-payload dedup absorbs the repetition" with the server-side change-only rule (client dedup kept as defence in depth); § Hub edge / Ack ordering: note `previousSessionsKey` beside `previousJSON` and that `previousJSON` remains the last SENT payload; a new Design Decision "Global broadcasts ride dispatch ticks and emit only on change" (Decision / Why with the 2026-09-16 R4 numbers / Rejected: keeping every-tick emission with client dedup only; quantizing `activityTimestamp`; removing `human_input_ago_ms` from the stream / Introduced by 260916-07pj) and one "The `sessions` dedup key ignores `activityTimestamp` on active windows".
- `docs/memory/run-kit/gui.md` § The `event: gui` state slot ("`guiTick()` runs every poll tick: it re-reads `settings.Load()`" → stat-gated, dispatch ticks, key excludes the age field) and the Design Decision "Hub re-reads the settings file per tick" (mechanism revised, why kept).
- `docs/memory/run-kit/configuration.md` if it enumerates `settings` package exports (add the stamp helper) — check at hydrate.
- `docs/memory/run-kit/architecture/tmux-runner.md`: **not affected** (checked — it documents `internal/tmux`, not the hub loop).
- No `docs/specs/` change expected: `api.md` does not state a per-tick cadence for the globals (checked by grep); confirm at hydrate.

## Affected Memory

- `run-kit/api-and-sockets`: (modify) § Poll loop, § `event: code-server`, § `event: gui`, § Hub edge ack-ordering note; new Design Decisions for dispatch-tick + change-only globals and the active-window `activityTimestamp` key rule
- `run-kit/gui`: (modify) § The `event: gui` state slot (stat-gated settings read, dispatch-tick cadence, dedup key excludes `human_input_ago_ms`) and the Design Decision "Hub re-reads the settings file per tick; POST flips synchronously"
- `run-kit/configuration`: (modify) only if it inventories `internal/settings` exports — add the change-stamp helper; otherwise no edit
- `run-kit/ui/dialogs-and-client-state` or wherever `session-context.tsx`'s host-metrics fan-out is described: (modify) the per-server `metrics` slice write is now changed-gated — locate the owner section at hydrate (the transport seams live in `api-and-sockets` § `session-context.tsx` transport, which is the likely home)

## Impact

- **Backend**: `app/backend/api/sse.go` (poll tick shape, three inline global emitters, `guiTick`/`guiPayloadLocked`/`setGUIEnabled`, `pollServerUnit` dedup, dead-server reap map cleanup, hub struct fields `previousSessionsKey`, `cachedGuiKey`, `settingsStamp`), `app/backend/internal/settings/settings.go` (+ `settings_test.go`) for the change-stamp helper. Tests: `api/sse_test.go`, `api/sse_gui_test.go`, `api/state_ws_test.go` (assertion review), `internal/settings`.
- **Frontend**: `app/frontend/src/contexts/session-context.tsx` (`applyHostMetrics` return + gated fan-out) and `session-context.test.tsx`.
- **Wire contract**: no payload shape changes; only *when* frames are sent. Late-joiner replay and subscribe acks unchanged.
- **Docs**: the two memory files above; PR body carries the before/after table.
- **Verification gates** (plan § Standing context): `cd app/backend && go test ./api/ ./internal/settings/` plus `go test -race ./api/`; `cd app/frontend && npx tsc --noEmit` and `pnpm vitest run src/contexts/session-context.test.tsx`; the instrument before/after per § 7. No e2e spec covers frame cadence; scoped e2e only if a touched surface has a spec (`host-system-card.spec.ts` reads host metrics on `/` — run `just test-e2e "host-system-card"` once after the client change). Never the full suite as a gate.
- **Constitution**: II (no new stores — the dedup keys are in-memory hub state like `previousJSON`), IV (no settings surface), IX untouched, X untouched; Test Integrity (tests updated to the new contract, never the implementation bent to fixtures); no change-ID/PR citations in code comments.

## Open Questions

- None blocking. Two out-of-scope observations from R4 (subscribe-time hot loop; automatic-rename not bumping the control-mode subscriber) are to be surfaced in the ship report for the user to file as `idea`s — not addressed here.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The four global broadcasts move inside the `if !resultsOnly` block (dispatch ticks only); fold-only ticks emit no global | Plan § Change 3 item 1 says so unless R4 shows a completion tick must carry them; R4 measured 6 fold-only echoes per dispatch tick carrying nothing new | S:90 R:85 A:90 D:90 |
| 2 | Certain | `metrics`/`services`/`code-server` emit only when the marshalled string differs from the cached slot, compared under `h.mu`; slots still serve late joiners and acks | Plan item 1 verbatim; the `previousJSON` pattern already exists for `sessions` | S:90 R:90 A:95 D:90 |
| 3 | Confident | The `sessions` dedup key zeroes `activityTimestamp` only on windows with `activity == "active"`; idle windows keep it; wire payload unchanged; `previousJSON` stays the last SENT payload and a parallel `previousSessionsKey` holds the key | R4 decision: the client renders no timestamp for active windows (`flowing`) but renders `idle <dur>` from it for idle ones, so a burst between ticks on an idle window is a visible change. Quantizing rejected (changes wire precision) | S:75 R:80 A:80 D:70 |
| 4 | Confident | The `gui` dedup key excludes `human_input_ago_ms`; the field stays on the wire | No frontend stream consumer reads it (grep); it is a live age that would defeat dedup once any viewer drove the display; removing it from the stream would be a contract change touching `gui.md`/spec | S:70 R:85 A:80 D:70 |
| 5 | Confident | `guiTick` gates `settings.Load()` behind a file change-stamp (path+mtime+size, legacy fallback mirrored) exported from `internal/settings`; parse only on change or first tick; the POST seam is unchanged | Plan item 1 offers "load on the settings-changed path and cache, or gate the read"; a stat is the cheapest gate that keeps the CLI-write-surfaces-without-POST guarantee at the same latency | S:70 R:85 A:80 D:65 |
| 6 | Certain | Client: `applyHostMetrics` returns changed:boolean and the per-server `metrics` slice fan-out runs only when true; other client raw-string dedups stay | Plan item 3 verbatim ("keep them, remove the unconditional fan-out in favour of a changed-check") | S:85 R:90 A:85 D:85 |
| 7 | Certain | Late-joiner replay (`replayGlobalSlots`) and the subscribe-ack snapshot are untouched | Plan item 5 verbatim | S:95 R:95 A:95 D:95 |
| 8 | Confident | Acceptance is per route on a same-binary rig (`:3777`, worktree Go binary before/after, `dist` rebuilt for after): `/rK` quiet ≤ 0.5 msg/s, `/` ≤ 0.6 msg/s with `metrics` at its 2.5 s tick cadence, churn ≤ 1.5 msg/s with `sessions` ≤ 1/s per server; renderer CPU no worse than the 3-point floor | The plan's 0.3 msg/s quiet figure cannot hold on `/` because the sentinel-only slice runs at 2.5 s by design and `metrics` changes every 2.5 s collector tick; the release `:3000` daemon is a different (older) build so it cannot show the AFTER | S:70 R:85 A:75 D:65 |
| 9 | Confident | `agentIdleDuration`'s one-second granularity under 60 s stays in the key and in scope-out | It is a rendered label; changing it alters visible precision — a separate decision | S:65 R:90 A:80 D:75 |
| 10 | Certain | Go tests extended in `sse_test.go` / `sse_gui_test.go` / `internal/settings` as listed in § 6; `go test -race ./api/` kept green; existing per-tick-broadcast assertions updated to the new contract, never loosened | Plan item 4; Constitution Test Integrity | S:85 R:90 A:90 D:90 |
| 11 | Certain | `docs/specs/` needs no change; memory edits limited to `api-and-sockets.md` and `gui.md` (+ `configuration.md` only if it inventories settings exports) | grep of specs for a per-tick cadence claim found none; plan § Change 3 Memory names `api-and-sockets`; `tmux-runner.md` checked and not affected | S:70 R:95 A:85 D:80 |
| 12 | Confident | Change type pinned to `fix` (a performance/hygiene defect in frame emission), matching changes 1–2 of the plan (`fix:` PRs #1003, #1001) | Wording carries no `fix` keyword so refresh would infer `feat`; explicit pin per project memory | S:60 R:95 A:80 D:70 |
| 13 | Confident | The two R4 side-observations (subscribe-time hot loop; automatic-rename not bumping the subscriber) are reported, not fixed or filed, by this change | Out of scope per plan Non-goals; filing `idea`s is the user's call | S:60 R:95 A:70 D:60 |

13 assumptions (6 certain, 7 confident, 0 tentative, 0 unresolved).
