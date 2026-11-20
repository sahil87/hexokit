# Intake: Operator Activity Tab and Check Now

**Change**: 261120-ny0u-operator-activity-tab-check-now
**Created**: 2026-11-20

## Origin

> Execute step T6 (Activity tab and Check now) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first (Decisions and Rules bind you), then implement only the T6 Brief.

One-shot invocation from the operator queue (mode `merge-auto`). The plan (also in this repo at
`fab/plans/sahil/26-11-20-operator-triggers.md`; design page `docs/wiki/operator-wake-architecture.html`
has the drawer mock) binds this change through its **Decisions** table and **Rules** section. T6
depends on T2 (#1164 — trigger door, `POST /api/operator/wake`, check records) and T4 (#1167); both are
on `main`, as are T1, T3 and T5 (#1169). Only the T6 Brief is in scope. The T6 Brief, verbatim:

> - `GET /api/operator/activity?server=` joins, newest first: loop lines from the cron log (reason, outcome,
>   ts), the check record for that fire, and the run record (pass, outcome, duration) when there is one;
>   `GET /api/operator/runs/{server}/{id}/brief|log` serve the brief and the run log **contents**
>   (read-only, size-capped).
> - Drawer strip becomes `Terminal · Tasks · Activity · Cron` (`QuakeSegments` values; the `Operator` prefix
>   is dropped from labels). Activity renders one row per fire: `trigger · <reason>` / `schedule · rung n` /
>   `manual`, the check summary (`k items · n changes · m open · notices`), the run summary
>   (`mechanical · n actions` or the outcome line, duration); a row expands to the changed/open lists, the
>   brief and the run log. Filter chips `runs · triggers · all`. The staleness banner moves here.
>   **Check now** in the Activity header calls `POST /api/operator/wake` and shows "run in progress" when
>   a run is in flight.
> - The Cron Log tab hides loop-entry rows by default (a `show loop` toggle); the merge into one Cron tab
>   is T7. Mobile: the operator route's `?tab=` accepts `activity`.
> - PR evidence: desktop + mobile recordings (`just demo`), before/after.
> - Docs: `ui/quake-terminal.md`, `ui/cron-console-tabs.md`, `api-and-sockets.md`.

Binding plan decisions this change honours: **No forced run** (Check now goes through the door; there
is no "run anyway"); **Operator log vs cron log** (separate *views* over one file — the cron log stays
the single delivery log, Activity joins loop lines with check records and run records); **Check
records** (persisted on every fire as `runs/<slug>/<fire-id>.check.json`, newest 200 — written by T2);
**Drawer** (Activity is new; Check now in the Activity header; loop rows hidden in Cron behind a
toggle); **Trigger door** (never a bare `rk operator check`). Plan Rule 6: T6 changes the drawer, so
the PR carries desktop + mobile `just demo` recordings, before/after.

## Why

The operator's work is invisible (plan § Problem 6). A trigger fire and a scheduled fire both render
as `operator loop · no change` in the Cron Log (loom: 738 of 848 rows); the check's findings, the
trigger, the mechanical pass, the brief and the run log exist only as files under
`$XDG_STATE_HOME/hexokit/operator/runs/<slug>/`. T2 started persisting a check record on every fire
precisely so a `no change` row can be explained — but nothing reads it yet. There is also no way to
say "look now" from the UI: the trigger door exists (`POST /api/operator/wake`) but no control calls it.

If not done: the user cannot see why the operator did or didn't act, the Cron Log stays drowned in loop
heartbeats, and the T2 check records are write-only. T7 (the Needs-you band, the Cron merge) and R1's
verification step ("`GET /api/operator/activity?server=hexokit` shows a `trigger:manual` row with a
check summary") both depend on this endpoint and tab existing.

Why this approach: the plan decided Activity is a *view* joined from the existing durable files (cron
log + check records + run records), not a new log — Constitution II (state lives as plain files, the
daemon derives) and the "one delivery log" decision. Check now goes through the trigger door so a
false trigger costs one free check and never a paid no-op run.

## What Changes

### 1. Backend — fire id on the loop log line (the join key)

Today the join is incomplete: a transcribed run line carries `run: <id>` (= the fire id, so it joins
to `<id>.check.json` and `<id>.json`), but a `no change` line carries no id at all, and its check
record (`runs/<slug>/<fire-id>.check.json`) can only be guessed by timestamp. Add the fire id to the
line:

- `internal/cron` `LogLine` gains `Fire string \`json:"fire,omitempty"\`` — "the operator-loop fire id
  whose check record (`<fire>.check.json`) explains this line; empty on every other line".
- `cron.Outcome` gains a `Fire string` field; `operatorloop.Run` sets it to the fire id on the
  `no change` outcome (the only non-held outcome whose check ran and whose record was written).
  The tick's loop-line append (`internal/cron/tick.go`) copies `Outcome.Fire` onto the line.
- Transcribed run lines already carry `Run` = fire id; the activity join uses `Fire` when present,
  else `Run`. `skipped-busy`, `check-failed` and `run-lost: launch: …` (pre-record) lines have no
  check record and render without a check summary.
- Old lines (written before this change) have neither; they render with the loop line alone. No
  timestamp-proximity guessing.
- Readers stay tolerant both ways (an old binary ignores `fire`; `ParseLog` already skips unknown
  fields), so the release can land under a running queue (plan § Release).


### 2. Backend — `GET /api/operator/activity?server=<name>`

New handler (e.g. `app/backend/api/operator_activity.go`, registered next to `/api/operator/notes`
and `/api/operator/wake` in `api/router.go`). Read-only (GET per Constitution IX).

- Validate `server` with `validate.ValidateServerName` (400 on bad/missing).
- Resolve the cron dir (`s.cronDir()`), read the server's cron log (`cron.LogPath` + `cron.ReadLog`),
  read the server's cron entries to find the operator-loop entry id(s) (the loop entry kind), and keep
  only that entry's own lines (`cron.OwnDeliveries`).
- Resolve the runs dir (`operatorloop.Dir(ctx, server)`); for each loop line, newest first, capped at
  200 rows (matching `CheckRetention`):
  - `ts`, `reason` (raw fire reason: `schedule`, `wake`, `trigger:<why>`), `outcome` (raw line outcome).
  - `rung` for `schedule` fires: the ladder position at that line — replay the same climb rule as
    `cron.LoopLadder` (consecutive `no change` / failure lines immediately preceding the line; any
    other own line resets) over the own lines up to it. Expose the replay as a small pure helper in
    `internal/cron` beside `LoopLadder` so the rule has one owner.
  - `fire`: the join id (`line.Fire`, else `line.Run`).
  - `check`: when `<fire>.check.json` exists — `{checked_at, changed, changes, open, notices}`
    (the `operatorloop.CheckRecord` fields; `changes`/`open` are `operator.CheckDelta` lists,
    `notices` `operator.CheckNotice`), plus `items` = the count of distinct item ids across
    changes ∪ open. Absent/unreadable record → omitted.
  - `run`: when `<fire>.json` exists — `{id, pass: {actions, escalations, busy?, error?}, outcome,
    lost?, exit_code?, started_at?, ended_at?, duration_s, has_brief, has_log}` from
    `operatorloop.Record` (`Duration()`), `has_*` from stat of `<id>.brief.md` / `<id>.log`.
- Top-level `in_flight`: the run currently executing, if any — `{id, started_at}` — derived from the
  live run windows (`tmux.ListOperatorRunWindows` for the server, the same source the runner's busy
  check and transcription use); `null` when none. A launched run has no log line until transcription,
  so the in-flight run is **also** surfaced as a synthetic newest row (`outcome: ""`, `running: true`)
  built from its record + check record, so the user sees "running" in the list, not just the header.
- Response: `{"server": "...", "in_flight": {...}|null, "rows": [ ... ]}`. An absent log / runs dir
  yields `rows: []`, never an error. Tolerant reads throughout (a corrupt check/run record drops that
  sub-object, the row stays).

### 3. Backend — `GET /api/operator/runs/{server}/{id}/brief` and `.../log`

Two read-only routes (one handler parameterised by kind is fine):

- Validate `{server}` (`validate.ValidateServerName`) and `{id}` (`operatorloop.ValidRunID`) → 400;
  the path comes only from `operatorloop.BriefPath` / `operatorloop.LogPath` under
  `operatorloop.Dir(ctx, server)` — no caller-supplied path segment ever reaches the filesystem.
- Serve the **raw file contents** as `text/plain; charset=utf-8` (open question T6 resolved: raw
  files, the frontend renders them — no server-side markdown rendering).
- Size cap 256 KiB: the brief is served from its head, the log from its **tail** (the end of a run
  log is the interesting part); when truncated, set response header `X-Rk-Truncated: true` and the
  frontend shows a "truncated — showing first/last 256 KiB" line.
- 404 when the record or file is absent (pruned run); 500 only on an unexpected read error.


### 4. Frontend — the segment strip

`app/frontend/src/components/terminal-activity-tabs.tsx`:

```ts
const SEGMENTS = [
  { tab: "terminal", label: "Terminal" },
  { tab: "tasks", label: "Tasks" },
  { tab: "activity", label: "Activity" },
  { tab: "list", label: "Cron List" },
  { tab: "log", label: "Cron Log" },
] as const;
```

The `Operator` prefix is dropped. T6 ships five segments; T7 merges `Cron List` + `Cron Log` into one
`Cron` segment, landing the plan's four-segment strip `Terminal · Tasks · Activity · Cron` (Principle
IV). Both steps merge before R1, the only release, so no user ever runs the five-segment strip.
`TerminalActivityTabs`' `active` derivation accepts `activity`. Update the comments that name the
four-label set.


`app/frontend/src/lib/router-url.ts`: `TerminalSearch.tab` gains `"activity"` as a real value; the
current legacy normalization (`activity` → `log`) is removed — `?tab=activity` now opens Activity
(the token old push notifications carry now lands on the operator's activity, which is what it
meant). The Vitest agreement test between `SEGMENTS`, `QuakeTerminalRequest.segment` and the
`tab` union is updated, as is the `validateTerminalSearch` unit test.

`quake-terminal.tsx`: render the Activity body for `segment === "activity"` (one relay stream max —
the TerminalClient is unmounted like on Tasks/Cron). The cron-segment cross-server request rule
(`list`/`log`) is unchanged. The mobile operator route (AppShell's `TerminalActivityTabs` mount and
whatever renders the body per `tab`) renders Activity too.

### 5. Frontend — the Activity tab

New component (e.g. `app/frontend/src/components/operator-activity.tsx` + `api/client.ts` functions
`getOperatorActivity(server)`, `getOperatorRunFile(server, id, "brief"|"log")`, and reuse/add
`postOperatorWake(server, reason?)`).

- **Header**: filter chips `runs · triggers · all` (default `all`); **Check now** button on the right.
  - `runs` = rows with a run (`run` present, or `running`); `triggers` = rows whose reason is not
    `schedule`; `all` = everything.
  - Check now → `POST /api/operator/wake {server}` (reason omitted ⇒ the door's default `manual`).
    While `in_flight` is set the button is disabled and reads "run in progress". After a successful
    post it shows a transient "check queued" state and refetches; the new row appears when the next
    tick consumes the marker. No forced run, no bare check (plan decisions).
- **Staleness banner**: `CronStaleBanner` (or a renamed shared banner) mounts above the Activity body
  and is **removed** from above the Cron List / Cron Log bodies (the banner "moves here").
- **Row** (one per fire, newest first):
  - Trigger label: `schedule` → `schedule · rung n`; `trigger:manual` → `manual`; `trigger:<x>` →
    `trigger · <x>`; `wake` (the agent-state fingerprint edge) → `trigger · agent`.
  - Check summary: `k items · n changes · m open · notices` (notices count shown only when > 0);
    absent check record → just the loop outcome (`skipped-busy`, `check-failed: …`).
  - Run summary: `mechanical · n actions` when the pass acted and no model run outcome; else the run's
    outcome line (`ran · …`, `run-failed: …`, `run-lost: …`); `running…` for the in-flight row; the
    duration; relative timestamp.
- **Expanded row**: the changed and open lists (item id + reasons/kind per `CheckDelta`), the notices,
  then **Brief** and **Run log** panes fetched lazily on expand from the endpoints in §3, rendered in a
  scrollable `<pre>` (whitespace-pre-wrap, monospace), with the truncation line when flagged.
- **Refresh**: fetch on mount, after Check now, and on the same refresh signal the Cron Log uses (SSE
  wake / its existing cadence — follow `cron-log.tsx`'s pattern, no new SSE channel).
- **Keyboard / palette** (Constitution V): the Activity segment and Check now are registered in the
  command palette like the existing segment actions; rows expand/collapse via keyboard (Enter/Space).
- Empty state: "no operator activity yet" when `rows` is empty; unresolved server → the tab's hint line
  like the cron tabs.

### 6. Frontend — Cron Log hides loop rows

`cron-log.tsx`: rows whose entry is the operator-loop entry are hidden by default; a `show loop`
toggle in the Cron Log header reveals them (component state, default off). Everything else in the
Cron Log is unchanged. The merge into one Cron tab is T7, not here.

### 7. Tests

- Go: `LogLine.Fire` round-trip; `operatorloop.Run` sets `Outcome.Fire` on `no change`; tick copies it
  onto the line; rung replay helper cases (schedule after k no-change lines, reset after `ran`,
  failures climb); activity handler — join by `fire` and by `run`, missing check record, missing run
  record, corrupt record tolerated, in-flight synthetic row, 200 cap, bad server 400, absent log → `[]`;
  brief/log handler — bad server/id 400, absent 404, cap + `X-Rk-Truncated` (head for brief, tail for
  log), content type.
- Vitest: segment strip labels/order and the agreement test; `validateTerminalSearch` accepts
  `activity`; Activity rendering of each row kind, filter chips, Check now (calls wake, disabled when
  in flight), lazy brief/log fetch on expand; Cron Log hides loop rows until `show loop`.
- Playwright: update any e2e spec asserting the old labels / `?tab=activity`→`log`; intent comments
  per the Test Intent Comments rule.
- Demo: a `just demo` spec (e.g. `app/frontend/tests/demo/operator-activity.demo.ts`) showing the
  drawer's Activity tab (rows, expand, Check now) desktop + mobile, `--before` for the base.

### Non-goals

- **Review bar** (plan § Decisions, quoted for every review dispatch): must-fix = merges, pushes,
  deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan
  requirement. Should-fix = everything else.
- T7's work: the Tasks **Needs you** band, the note composer calling wake, merging Cron List + Cron Log
  into one `Cron` segment, the `tasks`/`cron` mobile values and the `log` → `cron` normalization.
- Any "run anyway" / forced run; any bare `rk operator check` from the UI.
- A new log file, a new route/page, or an SSE channel for activity.
- Changing the check, the ladder rule, the runner's outcomes, or record retention (T1/T2 own them).
- No install, release or daemon restart (plan Rule 1 — R1 does that).

## Affected Memory

- `run-kit/ui/quake-terminal`: (modify) segment strip is `Terminal · Tasks · Activity · Cron List · Cron Log`, Operator prefix dropped; the Activity segment, its rows, filter chips, expansion, Check now and in-flight state; staleness banner now above Activity
- `run-kit/ui/cron-console-tabs`: (modify) Cron Log hides operator-loop rows behind a `show loop` toggle; the staleness banner no longer renders above the cron tabs
- `run-kit/ui/routes-and-shell`: (modify) operator route `?tab=` accepts `activity` as a real segment; the legacy `activity` → `log` normalization is gone
- `run-kit/api-and-sockets`: (modify) `GET /api/operator/activity?server=` response shape and join; `GET /api/operator/runs/{server}/{id}/brief|log` contents, cap and truncation header
- `run-kit/cron`: (modify) delivery `LogLine` gains `fire` (the loop fire id on `no change` lines)
- `run-kit/operator-loop`: (modify) the `no change` outcome carries its fire id; Activity as the read view over loop lines + check records + run records

## Impact

- Backend: `internal/cron/{log.go,tick.go,loop.go}` (LogLine.Fire, Outcome.Fire, rung replay helper),
  `internal/operatorloop/runner.go` (set Fire on no-change), new `api/operator_activity.go` (+ tests),
  `api/router.go` (three GET routes). No new dependencies; reads only existing files.
- Frontend: `components/terminal-activity-tabs.tsx`, `components/quake-terminal.tsx`, mobile operator
  route body mount (`app.tsx` / AppShell), `lib/router-url.ts`, new `components/operator-activity.tsx`,
  `components/cron-log.tsx`, `components/cron-stale-banner.tsx` placement, `api/client.ts`, command
  palette registrations, `types.ts`; their Vitest specs; affected Playwright specs; a new demo spec.
- Docs: the memory files above; `docs/specs/api.md` if it enumerates operator endpoints.
- No CLI surface change (no help-dump fixture or `rk skill operator` change).
- Compatibility: `fire` is additive and ignored by older readers; the endpoints are new.

## Open Questions

- None blocking. The plan's T6 open decision (brief/log as rendered text vs raw files) is resolved
  here as raw files with frontend rendering (Assumption 6).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is the T6 Brief only; T7 items (Needs-you band, composer wake, Cron merge, `tasks`/`cron`/`log`→`cron` mobile values) are out | Plan Rule 2 and the user's instruction "implement only the T6 Brief" | S:95 R:85 A:95 D:95 |
| 2 | Certain | The plan's review bar is copied into Non-goals and quoted in every review dispatch | Plan Rule 4, verbatim | S:95 R:90 A:95 D:95 |
| 3 | Certain | Check now posts `POST /api/operator/wake {server}` with the door's default reason `manual`; no forced run, no bare check | Plan decisions "No forced run" and "Trigger door"; T2's handler defaults the reason | S:90 R:85 A:90 D:90 |
| 4 | Certain | Brief/log endpoints validate server and run id and build paths only via `operatorloop.BriefPath`/`LogPath`; GET only | Constitution I and IX; existing validators | S:85 R:85 A:90 D:90 |
| 5 | Certain | Staleness banner moves from above the cron tabs to above Activity | Brief: "The staleness banner moves here" | S:80 R:90 A:80 D:75 |
| 6 | Confident | Brief/log served as raw `text/plain`, 256 KiB cap (brief head, log tail), `X-Rk-Truncated` header; frontend renders in a `<pre>` | Resolves the plan's T6 open decision toward the simpler server; UI is monospace; the log's tail is what matters | S:60 R:85 A:70 D:60 |
| 7 | Confident | Join key: new `fire` field on the loop `no change` log line (via `cron.Outcome.Fire`); transcribed lines join on existing `run`; old lines render without a check summary — no timestamp join | Runner's `fired_at` and the tick's line `ts` are separate instants; additive field is tolerant both ways | S:55 R:70 A:70 D:60 |
| 8 | Confident | T6 strip has five segments (`Terminal · Tasks · Activity · Cron List · Cron Log`); T7's merge lands the plan's four; never released in between (R1 follows T7) | Brief says strip "becomes `… · Cron`" but also "the merge into one Cron tab is T7" | S:60 R:80 A:70 D:55 |
| 9 | Confident | Reason labels: `schedule` → `schedule · rung n` (rung replayed from the ladder rule at that line, helper beside `LoopLadder`); `trigger:manual` → `manual`; `trigger:<x>` → `trigger · <x>`; `wake` → `trigger · agent` | Brief lists the three label shapes; `wake` is the agent-state edge, a trigger in the plan's vocabulary | S:55 R:85 A:60 D:50 |
| 10 | Confident | In-flight run: `in_flight` derived from live run windows (`tmux.ListOperatorRunWindows`), also shown as a synthetic `running` row; Check now disabled with "run in progress" | Same source the runner's busy check uses; a launched run has no log line until transcription | S:60 R:85 A:70 D:70 |
| 11 | Confident | `?tab=activity` becomes a real value; the legacy `activity` → `log` normalization is removed | Brief: "`?tab=` accepts `activity`"; the token now has its own segment | S:80 R:85 A:75 D:70 |
| 12 | Confident | Activity response capped at the newest 200 rows | Matches `CheckRetention`; older rows have no check record anyway | S:60 R:90 A:70 D:70 |
| 13 | Confident | Activity segment and Check now registered in the command palette; rows keyboard-expandable | Constitution V: every UI action is in the palette | S:60 R:85 A:85 D:75 |
| 14 | Confident | `show loop` toggle is component state, default off (not persisted) | Brief: "hides loop-entry rows by default"; T7 keeps the toggle | S:70 R:90 A:65 D:60 |
| 15 | Confident | Activity refreshes on mount, after Check now, and on the Cron Log's existing refresh signal; no new SSE channel | Follows the established cron-log pattern; non-goal: no new channel | S:50 R:85 A:65 D:65 |
| 16 | Confident | Filter chips default to `all`; `runs` = has a run or running, `triggers` = reason ≠ `schedule` | A `no change` row from Check now must be visible right after clicking; definitions follow the chip names | S:35 R:90 A:40 D:35 |

16 assumptions (5 certain, 11 confident, 0 tentative, 0 unresolved).
