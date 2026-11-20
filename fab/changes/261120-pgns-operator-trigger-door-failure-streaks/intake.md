# Intake: Operator Clock — Failure Streaks, Trigger Door, Check Records, Notes as Conditions

**Change**: 261120-pgns-operator-trigger-door-failure-streaks
**Created**: 2026-11-20

## Origin

> Execute step T2 (Clock: failure streaks climb; trigger door (`rk operator wake`, marker, fire reason); check record per fire; notes as conditions; `POST /api/operator/wake`; legacy-tick sweep) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first (Decisions and Rules bind you), then implement only the T2 Brief.

One-shot `/fab-new` invocation from the operator executing the plan `fab/plans/sahil/26-11-20-operator-triggers.md` (also present in this worktree at that repo-relative path). The plan's **Decisions already taken** table and **Rules for the operator** bind this change and are not reopened here. Only the **T2 Brief** is in scope; T1 (idle/stage), T3 (engine re-scope), T4 (brief/skill/diet), T5 (PR hooks), T6/T7 (drawer) are separate changes.

Binding plan decisions relevant to T2 (verbatim intent):

- **Failure backoff** — consecutive `run-failed` / `run-lost` / `check-failed` lines climb the ladder like `no change`; one push per failure streak. "A dead launcher must not run every 3 min and notify 62 times."
- **Trigger door** — `rk operator wake -L <server> --reason <why>` writes a one-line marker file `cron/<slug>.wake`; the next tick consumes it and fires the loop with that reason. Never a bare `rk operator check`, never an HTTP dependency. A marker survives a daemon restart (Constitution II).
- **Notes are triggers** — a `by: user` or `by: chat` note newer than the item's last `by: run` note is a check condition (`note@<at>`).
- **No forced run** — check-now goes through the door; there is no "run anyway".
- **Check records** — the check result (changes, open, notices) is persisted on **every** fire, not only on a change, as `runs/<slug>/<fire-id>.check.json` (newest 200 kept).
- **Legacy `operator tick` entries** — removed by the tick itself, once, on a server whose cron file holds a loop entry.
- **Operator log vs cron log** — separate views over one file; the cron log stays the single delivery log.
- **Release** — no step before R1 installs a binary or restarts a daemon; reads of every file this plan changes must be tolerant in both directions (old binary reading new files, new binary reading old files).

Plan open decision for T2, resolved here: push-once-per-streak by **reading the cron log** (the plan's preference — no new file), not a streak marker.

## Why

1. **Failures speed the loop up.** `cron.LoopLadder` (`app/backend/internal/cron/loop.go`) climbs only on `no change`; any other own line — including `run-failed: …` — ends the trailing count and resets the rung to 0 (3 min). When `claude -p` lost its OAuth token on 2026-11-16 the loop launched 62 failing runs in 12 h, each pushing an `operator run failed` notification (sent by `reportFailure` in `app/backend/internal/operatorloop/exec.go`) and writing a `run failed` note. A dead launcher must back off like a quiet server does, and the user should be told once per streak, not 62 times.
2. **There is no trigger door.** Today the only ways the loop looks are the backoff schedule and the agent-state wake edge. A user note written from the drawer waits for an unrelated edge; a bare `rk operator check` outside the loop consumes the edges it reports (it writes baselines) and so swallows a change without ever starting a run. The plan's later steps (T5 PR hooks, T6 "Check now", T7 note composer) all need one safe door: a marker file the tick consumes, which survives a daemon restart and needs no daemon to write.
3. **Fire reasons are lost.** Every fire renders as `operator loop · no change`; the transcribed run line hard-codes `Reason: string(cron.FireSchedule)` (`operatorloop/transcribe.go`) even for wake fires. Activity (T6) must say *why* a fire happened.
4. **Check results are thrown away.** The check's changes/open/notices exist only in memory for a `no change` fire and only as `changes` in the run record for a run. T6's Activity tab must explain a `no change` row; the data has to be persisted per fire.
5. **Notes are not triggers.** `judgmentSet` (`operatorloop/judgment.go`) already treats an item whose newest `by: user`/`by: chat` note is newer than its newest `by: run` note as needing judgment — but only *after* something else opened the gate. `operator.Check` never reports a note, so a note alone never starts a run.
6. **Legacy entries linger.** All four live servers still carry fab's typed `operator tick` entries, muted by the seed step. `fab operator` is deleted (F2, PR #703), so nothing depends on them; removing them is a chore the tick can do instead of the user.

If not done: the next launcher outage repeats the 62-runs/62-pushes storm; T5/T6/T7 have no door to call; Activity cannot explain its rows.

Why this approach: the check is edge-triggered and idempotent, so a trigger only needs to *cause a loop fire*; the loop's existing busy gate, in-flight suppression and rate cap then apply unchanged. A marker file (not an HTTP call, not an in-memory flag) is the only door that works with no daemon, survives a restart, and keeps the tick the cron log's single writer.

## What Changes

All paths are under `app/backend/` unless stated.

### 1. Failure streaks climb the ladder (`internal/cron/loop.go`)

- Add an exported classifier, e.g. `IsLoopFailureOutcome(outcome string) bool`, true for the three failure classes by prefix: `run-failed: ` (`outcomeRunFailedPrefix`), `run-lost: ` (`outcomeRunLostPrefix`), `check-failed: ` (`outcomeCheckFailedPrefix`).
- `LoopLadder`: the trailing count climbs on `OutcomeNoChange` **or** `IsLoopFailureOutcome(...)`. Any other own line (`ran · …`, `skipped-busy: run …`, `rate-capped`, `rescheduled`, …) still ends the count (rung 0). Update the doc comment.
- `DeriveEntry` (`internal/cron/derive.go:62`) and the operator watchdog (`internal/sessions/operatorstate.go` `operatorLoopLiveness`, which calls `cron.DeriveEntry`) follow automatically because both go through `LoopLadder`; no code change there beyond tests/comments if needed.

Example (min 3m, max 24m): log tail `ran · …`, `run-failed: exit 1 · 4s`, `run-failed: exit 1 · 3s`, `check-failed: …` → rung 3, next fire = anchor + gap at rung 3 (not 3 min).

### 2. One push per failure streak (`internal/operatorloop/exec.go`)

- `reportFailure` keeps writing the `run failed: exit N — <tail>` note on every changed item (unchanged), but sends the `operator run failed` push **only when the previous loop line for the server was not itself a failure**.
- "Previous loop line" = the newest own line of the run's loop entry (`rec.Entry`) in the server's cron delivery log (`cron.DefaultDir()` → `cron.LogPath(dir, slug)` → `cron.ReadLog` → `cron.OwnDeliveries(log, rec.Entry)`), read **read-only** by the wrapper. The current run's own line is not yet in the log (it is written at transcription by the tick, and the evaluator suppresses the loop entry while a run window lives), so the newest own line is the preceding fire's.
- If that newest own line satisfies `cron.IsLoopFailureOutcome`, skip the push; otherwise (including an empty or unreadable log — fail toward notifying) push as today.
- Introduce a seam so tests can feed the log (e.g. a package var for the previous-outcome lookup), matching the package's existing test-seam style.

### 3. The trigger door

#### 3a. Marker file (`internal/cron`)

- New path helper beside `LogPath`/`CursorPath` in `internal/cron/dir.go`: `WakePath(dir, slug string) (string, error)` → `<cron dir>/<slug>.wake`, slug validated with `ValidSlug` like the others. `entrySlugs` already ignores non-`.yaml` files, so the marker is never mistaken for an entry file.
- Marker format: exactly one line `<unix-ts> <reason>\n`, written atomically (temp + rename via the repo's `fsatomic` helper), mode `0600`. A second wake before consumption overwrites it (newest reason wins; one pending trigger per server).
- Helpers (new file, e.g. `internal/cron/wake_marker.go`): `WriteWakeMarker(dir, slug, reason string, now time.Time) error`, `ReadWakeMarker(dir, slug) (WakeMarker{At int64; Reason string}, ok bool, err error)`, `RemoveWakeMarker(dir, slug) error`. Read is tolerant: an unparseable marker is treated as present with reason `manual` (it is still a trigger) — or removed with a diagnostic; plan picks one (see Assumptions #13).
- Reason normalization (shared by CLI and API): trim; empty → `manual`; control characters (incl. newlines) rejected as a usage/400 error; capped (≈120 runes). Example reasons: `manual`, `note`, `pr:sahil87/hexokit#1161:pull_request` (T5's shape).

#### 3b. `rk operator wake` (`cmd/rk/operator_wake.go`, new)

```
rk operator wake [-L <server>] [--reason <text>]
```

- `-L/--server` resolves like the other `rk operator` verbs (default: the caller's own server from `$TMUX`); the name is validated (`validate.ValidateServerName`). `--reason` defaults to `manual`.
- Writes the marker via `cron.WriteWakeMarker(cron.DefaultDir(), …)`, prints a one-line confirmation (and supports `--json` if the sibling verbs do — follow `operator check`'s output conventions), exits 0. **No daemon needed** and no tmux call is required to write; a marker written for a dead server stays on disk (the tick skips dead servers entirely) and fires when that server is live again.
- Exit codes: 0 written; 1 operational failure (cron dir not writable); 2 usage error (bad server name, bad reason).
- Register on `operatorCmd` like `operator_check.go:69`. Help text follows the `operator check` Long format (Flags / Examples / Exit codes).
- Per plan Rule 5 (CLI ⇒ docs + tests): update the `rk skill operator` topic (`docs/site/skill/operator.md`, synced to `cmd/rk/skill/operator.md`) with a short paragraph on `rk operator wake` (the door; never a bare `rk operator check` to make the operator look), and the `rk help-dump` fixtures/tests (`cmd/rk/help_dump_test.go`).

#### 3c. Tick consumes the marker (`internal/cron/tick.go`, `evaluate.go`)

- In `tickServer`, per **live** server, after transcription and before `Evaluate`: read the marker. Pass it into `EvalInput` (e.g. `Trigger *WakeMarker` / `TriggerReason string`).
- `Evaluate`: for the server's loop entry (`e.IsLoop()`), a pending trigger makes the entry due regardless of schedule/wake state, **after** the muted check and the `RunInFlight` suppression (both still win — "subject to the in-flight suppression"). The fire carries `Reason: FireReason("trigger:" + reason)`, `Rung: 0`, `DueAt: now`. If the schedule or wake edge is also due in the same tick, there is still exactly one fire and the trigger reason wins. The wake cursor update for the entry proceeds as today.
- Consumption: the tick deletes the marker once the trigger fire has been **emitted and logged** — that includes a `rate-capped` suppression (the rate cap still applies; `rateCapped` appends its line with `Reason: "trigger:<reason>"`). When the loop entry is muted, a run is in flight, or the server has no loop entry yet, the marker is **left in place** and fires on a later tick (mirrors "a pending edge fires once the run is over"). A dead server's marker is never touched (dead servers get zero work, R12).
- Delete is best-effort-after-log: a failure to delete is a diagnostic (`wake-marker-remove-failed`); the next tick would fire again — acceptable (a false trigger costs one free check), but the plan should prefer deleting immediately after the fire is decided and before the runner call so a crash mid-run does not double-fire. Exact ordering is a plan detail; the test is "consumed exactly once".
- The fire's log line carries `Reason: "trigger:<reason>"` (the `Reason` field already exists on `LogLine`). `LoopLadder` needs no special case: it reads outcomes, so a trigger fire's `no change` climbs and its `ran · …` resets like any other own line.

#### 3d. Fire reason reaches run lines (`internal/operatorloop`)

- `Record` gains `Reason string \`json:"reason,omitempty"\`` set from `fire.Reason` in `persistRun`.
- `Transcribe` uses `rec.Reason` for the line's `Reason`, falling back to `string(cron.FireSchedule)` when empty (records written by the installed binary). Old binaries reading new records ignore the unknown field (tolerant both ways).

### 4. `POST /api/operator/wake` (`api/`)

- Body `{ "server": "<name>", "reason": "<text>" }` (`reason` optional → `manual`). Validates the server name and reason with the same rules as the CLI; writes the same marker via `cron.WriteWakeMarker`; responds 200 with a small JSON receipt (e.g. `{"server": "...", "reason": "..."}`) — follow existing operator handler conventions (`api/operator_start.go`, `api/operator_notes.go`) for error shape (400 on validation, 500 on write failure).
- Register in `api/router.go` beside `r.Post("/api/operator/start", …)` (POST only — Constitution IX). Durable before acknowledged (Constitution II rule 1): the marker is on disk before the 200.
- Add a seam for the cron dir in the server struct if tests need it (pattern: `cronRunsDirFn` at `api/router.go:323`).
- No frontend change in T2 (the Check-now button is T6, the note-composer call is T7).

### 5. Check record per fire (`internal/operatorloop`)

- For every loop fire on which `operator.Check` ran — outcome `no change` **and** changed (whether the launch then succeeds or fails) — the runner persists `runs/<slug>/<fire-id>.check.json` in the existing runs dir (`Dir(ctx, server)`, dir 0700, file 0600, atomic write):

```json
{
  "fired_at": "2026-11-20T10:03:00Z",
  "reason": "trigger:manual",
  "checked_at": "2026-11-20T10:03:01Z",
  "changed": false,
  "changes": [],
  "open": [ { "kind": "agent_state", "id": "...", ... } ],
  "notices": [],
  "run": "20261120T100300-ab12"
}
```

  `changes`/`open`/`notices` are `operator.CheckResult`'s slices marshalled as-is (pinned `CheckDelta` JSON); `run` is present only when the fire persisted a run record.
- `fire-id` uses the run-id format (`NewRunID`, `YYYYMMDDTHHMMSS-xxxx`); when a run launches, the run reuses the same id so `<id>.check.json` sits beside `<id>.json`/`.brief.md`/`.log`. `listRunIDs` already ignores `<id>.check.json` (its `TrimSuffix(".json")` stem `<id>.check` fails `ValidRunID`), so run-record listing/pruning/transcription are unaffected; check records need their own lister.
- Fires with no check result write no check record: `skipped-busy` (no check is run) and `check-failed` (the check errored; the log line carries the error).
- A check-record write failure is a `slog.Warn`, never changes the fire's outcome.
- Retention: newest **200** check records per server (constant e.g. `CheckRetention = 200`), pruned by `Transcribe`'s existing `Prune(dir)` pass (extend `Prune` or add a sibling called from the same place). Independent of `RunRetention = 50`.

### 6. Notes as conditions (`internal/operator`)

- New condition key prefix `note@` (`condNotePrefix = "note@"`) and delta kind `DeltaNote = "note"`.
- In `itemConditions` (`check_conditions.go`): for **every** item (including done and paused items — a user instruction is never inert), when its newest `by: user`/`by: chat` note's `at` is strictly newer than its newest `by: run` note's `at` (or there is no run note), emit `condDelta{condNotePrefix + at, CheckDelta{Kind: DeltaNote, ID: it.ID, At: at}}` keyed by that note's `at`. Edge-triggering through `TrackedItem.Reported` makes it a change exactly once; while unanswered it is listed as open; a newer `by: run` note clears it; a newer user/chat note is a new key and fires again.
- `CheckDelta` gains the field for the note time and `MarshalJSON` adds `case DeltaNote: add("at", d.At)` (pinned key order).
- Move the "newest instruction newer than newest run note" logic out of `operatorloop/judgment.go` `hasUserInstruction` into `internal/operator` (e.g. `PendingInstruction(notes []Note) (at string, ok bool)`) and use it from both the check and `judgmentSet` — one owner, no duplicate.
- Judgment: `reasonNeedsJudgment` returns true for `operator.DeltaNote`. `reasonFor` (runner.go) renders `note <at>`. The existing `judgmentSet` user-note scan may stay (it covers an item whose note condition was reported by an earlier fire) but must not add a duplicate reason for the same item if the plan can avoid it cheaply.
- `rk operator check` human output: a `note` delta renders like other deltas (the CLI already has a `note` row prefix `checkRowNote` for something else — confirm no ambiguity in the row label).

### 7. Legacy-tick sweep (`internal/cron/seed.go`, `tick.go`)

- New `SweepLegacyOperatorTicks(dir, slug string) (removed []string, err error)`: under the normal mutate path (`loadForMutate` + `saveEntries`, one atomic write), when the server's cron file holds a loop entry (`e.IsLoop()`, muted or not), remove every entry with `isLegacyOperatorTick(e) && e.Muted` (`run` empty, `target.kind == role`, `role == operator`, `payload == "operator tick"`). An **unmuted** legacy entry is left alone (someone rolled back on purpose). No loop entry ⇒ no-op. No matching entry ⇒ no write.
- Called from the tick's seed step for each swept server (after `SeedOperatorLoop`, so a just-seeded server — whose seed write muted its legacy entries — is swept in the same step; on the four live servers the loop already exists, so the first new tick sweeps). Gated on the seed seam being configured (production daemon), not on the state file's existence.
- The tick appends one log line per removed entry: `LogLine{TS: now, Entry: <legacy id>, Outcome: "expired-legacy"}` (mirrors `expired-orphan`). `seedLoop` currently runs before `appendLine` exists in `tickServer`; the plan reorders so the removed ids are logged through `appendLine`.
- Update `seed.go`'s header comment (it still says fab's reconcile needs the muted row).

### Tests (per the T2 Brief)

- `internal/cron`: ladder cases (`no change` + failures climb; `ran`/`skipped-busy` reset; mixed tails); `DeriveEntry` next-fire on a failure streak; marker write/read/remove (format, 0600, atomic overwrite); tick consumes a marker exactly once and emits a fire whose log line has `Reason: "trigger:<reason>"`; marker left in place on a dead server, while a run is in flight, and when the loop entry is muted; rate-capped trigger consumed with a `rate-capped` line; sweep removes muted legacy entries only (unmuted kept, no loop entry ⇒ untouched) with one `expired-legacy` line each.
- `internal/operatorloop`: push sent on first failure, suppressed when the previous own line is a failure, sent again after a `ran` line; note still written every time; check record written for a `no change` fire and for a changed fire (with `run`), none for skipped-busy; retention 200; transcribed line carries the record's reason (and falls back to `schedule` for a reason-less record); `reasonNeedsJudgment` true for `note`.
- `internal/operator`: note condition fires once (new → open → cleared by a newer run note → a newer user note fires again); `by: chat` counts; done/paused items still report it; JSON shape of the `note` delta.
- `cmd/rk`: `operator wake` writes the marker, default reason `manual`, bad server/reason exit 2; help-dump fixture updated.
- `api`: `POST /api/operator/wake` writes the marker; 400 on bad server; GET not routed.

### Docs (memory, at hydrate)

`cron.md` § Operator Loop Entry (failure-climbing ladder, trigger marker + `trigger:<reason>` fire reason, legacy sweep + `expired-legacy`), `operator-loop.md` (fire reason in record and line, check records + retention, push-once-per-streak), `operator-state.md` (note condition `note@<at>` / `note` delta), `api-and-sockets.md` (`POST /api/operator/wake`). Also `docs/specs/cron.md`/`api.md` only if hydrate finds spec-level gaps (human-curated; not required).

### Non-goals

- **Review bar (copied from the plan, binding for every review of this change):** must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.
- No idle/stage changes (T1), no engine/PR-row changes (T3), no brief/skill-rules/diet changes beyond the `rk operator wake` paragraph (T4), no PR hooks or receiver (T5), no Activity tab, Check-now button, activity/brief/log endpoints, or note-composer wake call (T6/T7).
- No "run anyway"/forced run; no HTTP dependency for the door; no new streak file.
- No binary install or daemon restart (plan Rule 1 — R1 does that).
- No UI change ⇒ PR states `No recording: internal CLI/engine behavior` plus validation (plan Rule 6).

## Affected Memory

- `run-kit/cron`: (modify) Operator Loop Entry — ladder climbs on `no change` and failure classes; the `cron/<slug>.wake` trigger marker, its consumption rules and the `trigger:<reason>` fire reason; the legacy-tick sweep and `expired-legacy` log line
- `run-kit/operator-loop`: (modify) fire reason persisted in run records and transcribed lines; per-fire check records (`<fire-id>.check.json`, newest 200); push once per failure streak via the cron log
- `run-kit/operator-state`: (modify) Conditions — the `note@<at>` condition and `note` delta; `rk operator wake` in the verb table
- `run-kit/api-and-sockets`: (modify) `POST /api/operator/wake`

## Impact

- **Go packages**: `internal/cron` (loop.go, dir.go, new wake-marker file, evaluate.go, tick.go, seed.go), `internal/operatorloop` (runner.go, record.go, transcribe.go, exec.go, judgment.go, new check-record file), `internal/operator` (check.go, check_conditions.go, schema/notes helper), `cmd/rk` (new operator_wake.go, help-dump fixtures, skill topic sync), `api` (router.go + new or extended operator handler).
- **Durable files**: new `$XDG_STATE_HOME/hexokit/cron/<slug>.wake` and `…/operator/runs/<slug>/<id>.check.json`; run record gains `reason`; cron log gains `trigger:*` reasons and `expired-legacy` lines; cron entry files lose muted legacy entries. All reads tolerant both ways (installed binary keeps running until R1).
- **Downstream consumers**: T5 calls the door with `pr:<nwo>#<n>:<event>`; T6 reads check records + reasons and calls `POST /api/operator/wake`; T7's composer calls it after a note write.
- **Docs**: `docs/site/skill/operator.md` + `cmd/rk/skill/operator.md` sync; four memory files.
- No frontend, no dependency changes.

## Open Questions

- Should an unparseable marker fire as `trigger:manual` or be discarded with a diagnostic? (Assumed: fire as `manual` — a false trigger costs one free check.)
- Should the `judgmentSet` user-note scan be removed now that notes are check conditions, or kept as a backstop? (Assumed: keep, dedupe reasons; T4 owns the brief side.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Ladder climbs on `no change` + `run-failed`/`run-lost`/`check-failed`; `ran`/`skipped-busy` (and any other own line) end the count | Plan Decision "Failure backoff" + T2 Brief verbatim | S:95 R:85 A:95 D:90 |
| 2 | Certain | Push-once-per-streak reads the cron log (newest own loop line), no streak marker file | Plan open decision T2 states the preference "prefer the log — no new file" | S:85 R:85 A:85 D:85 |
| 3 | Certain | Marker path `cron/<slug>.wake`, one line `<unix-ts> <reason>`, atomic, 0600; `rk operator wake -L <server> --reason <text>` default `manual`, no daemon needed | T2 Brief and plan Decision "Trigger door" verbatim | S:95 R:80 A:90 D:90 |
| 4 | Certain | Trigger fire reason is `trigger:<reason>`, subject to in-flight suppression and the rate cap; log line carries it; LoopLadder needs no special case | T2 Brief verbatim | S:90 R:80 A:90 D:85 |
| 5 | Certain | `POST /api/operator/wake {server, reason?}` writes the same marker; POST only | T2 Brief + Constitution IX | S:90 R:85 A:90 D:85 |
| 6 | Certain | Check record path/fields `runs/<slug>/<fire-id>.check.json` `{fired_at, reason, checked_at, changed, changes, open, notices, run?}`, newest 200, pruned with run records | T2 Brief verbatim | S:95 R:80 A:85 D:85 |
| 7 | Certain | Note condition `note@<at>` for newest user/chat note newer than newest run note; fires once; is a judgment reason | T2 Brief + plan Decision "Notes are triggers" | S:90 R:85 A:90 D:85 |
| 8 | Certain | Legacy sweep removes only muted typed `operator tick` entries on a server with a loop entry, one atomic write, one `expired-legacy` line each; unmuted kept | T2 Brief verbatim | S:95 R:70 A:90 D:90 |
| 9 | Confident | Marker left in place (not consumed) when the loop entry is muted, a run is in flight, or no loop entry exists; consumed once the trigger fire is logged (incl. rate-capped) | Mirrors the wake cursor's "pending edge fires once the run is over"; dropping it would silently lose a user's trigger | S:60 R:80 A:70 D:60 |
| 10 | Confident | Trigger and schedule/wake due in the same tick ⇒ one fire, trigger reason wins | One fire per entry per tick is the evaluator's invariant; the trigger is the more specific "why" | S:55 R:90 A:75 D:70 |
| 11 | Confident | Fire id = run-id format; a launched run reuses the fire id so `<id>.check.json` sits beside the run record | Keeps the T6 join trivial; `listRunIDs` already skips `.check.json` stems | S:60 R:80 A:75 D:65 |
| 12 | Confident | Check records written only for fires where the check ran (`no change`, changed); none for `skipped-busy` / `check-failed` | "Every fire" in the Brief, but those fires have no check result; the log line already explains them | S:50 R:85 A:60 D:50 |
| 13 | Confident | Unparseable marker still fires as `trigger:manual` (then consumed) rather than being discarded | A false trigger costs one free check (plan Decision "Vocabulary"); discarding could lose a real trigger | S:35 R:90 A:60 D:50 |
| 14 | Confident | Reason normalization: trim, empty → `manual`, reject control chars/newlines (exit 2 / 400), cap ~120 runes | Marker is one line; T5's `pr:<nwo>#<n>:<event>` shape must fit | S:50 R:90 A:75 D:65 |
| 15 | Confident | Note condition applies to done and paused items too | A user instruction is never inert; itemConditions' early returns otherwise hide it | S:55 R:85 A:70 D:65 |
| 16 | Confident | `hasUserInstruction` moves to `internal/operator` and is shared by the check and `judgmentSet` | One owner for the rule (code-quality: no duplication) | S:60 R:90 A:80 D:75 |
| 17 | Certain | Run record gains `reason`; transcription uses it with fallback to `schedule` for reason-less records | Required for "the log line carries the reason" on run lines; tolerant in both directions per plan Release decision | S:70 R:85 A:85 D:80 |
| 18 | Confident | Sweep runs in the seed step after seeding, gated on the seed seam being set, not on the state file existing | "On a server whose cron file already holds a loop entry" is the only condition the Brief names | S:60 R:75 A:75 D:65 |
| 19 | Confident | `rk operator wake` validates the server name only (no liveness check); a dead server's marker waits on disk | "No daemon needed" + Brief test "left in place on a dead server" | S:65 R:90 A:75 D:65 |
| 20 | Certain | Skill topic + help-dump fixtures updated for the new verb; no UI change ⇒ `No recording: internal CLI/engine behavior` | Plan Rules 5 and 6 | S:90 R:90 A:90 D:90 |

20 assumptions (10 certain, 10 confident, 0 tentative, 0 unresolved).
