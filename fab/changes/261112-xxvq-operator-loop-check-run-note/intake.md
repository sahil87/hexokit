# Intake: Operator Loop — Cron Fire → Check → Run Window → Note

**Change**: 261112-xxvq-operator-loop-check-run-note
**Created**: 2026-11-12

## Origin

> Plan step R5 (The loop: cron fire → check → run window → note; Cron Log outcome) from the plan at
> /home/sahil/code/sahil87/hexokit.worktrees/arcing-fjord/fab/plans/sahil/26-11-10-operator-to-hexokit.md
> — read that file (Rules, Decisions, and the R5 brief) first. S1 findings (#1116), R1 state engine,
> R2 check (rk operator check), and R4 run brief + chat skill (rk operator brief, rk skill operator)
> are all merged on main; build on them. Do not touch or restart the live rk daemon or installed
> binaries; the live operator must keep working until C1.

One-shot `/fab-new`, with two questions asked at intake (the plan's own R5 open decisions):

1. **Entry switch**: the user chose **"Daemon seeds on rk file"**. When the daemon finds rk's operator
   state file for a server and no loop entry exists, it seeds the loop entry and **mutes** (doesn't
   delete) the old `operator tick` entry. The adopt and track verbs don't touch cron.
2. **Run transcript**: the user chose **"rk run log + path"**. An rk-owned per-run log file plus a run
   record. The Cron Log detail sheet shows the outcome and the log path. No new route or page.

The R5 brief from the plan (verbatim, the binding scope):

> - The daemon owns an `operator` cron entry of a new kind (not a typed prompt). On fire: call R2's
>   check; nothing changed → log `no change` to Cron Log, stop; changed → open an ephemeral tmux
>   window in the operator's session, launch the resolved headless command (fab present:
>   `fab agent operator --headless -o yaml`; else rk's default launcher) with the R4 brief, close
>   the window when the run exits.
> - One run at a time per server: a fire while a run window is alive is `skipped-busy`.
> - Keep `--wake-on agent-state-change`, backoff 3m→24m, respawn semantics.
> - rk seeds this entry itself (fab stops seeding in F1).
> - Cron Log row per fire: `no change` / `ran · <one-line outcome> · <duration>`, linking the run's
>   transcript.
> - Acceptance: kill the daemon during a run → the run finishes and its note lands; a fresh daemon
>   rebuilds everything from files and tmux.

Plan Decisions that bind this change (not reopened): chat and scheduled work are **separate** (chat
never gets ticks). A **deterministic Go check** runs before any model call. **Notes** are the only
memory. Next-check time comes from **rk's backoff + wake only** (the model never picks its own
interval). There is **one model** for runs, the resolved `operator` role. The design assumes a
**cold prompt cache**. There is **no new UI tab**: runs show up in Cron Log and item notes. **Each
run gets its own tmux window, never a daemon child process** (Constitution II + VI). Merge
authority is unchanged.

## Why

The live operator is one long-lived chat. rk cron types `operator tick` into it every 3–30 min. A
chat re-reads its whole history on every reply, so a tick costs more the older the session gets,
whatever work it does. On loom2, 1,563 ticks over 149 h cost ≈ $451, and ≈ 90 % of that was
re-reading cached history. **76 % of ticks found "no change"**. After compaction the operator ran
on a summary of its own rules.

R1 (state engine), R2 (`operator.Check`, the free Go gate) and R4 (`operator.RenderBrief`, the
short run brief) are merged, but **nothing connects them**. `operator.Check` has no daemon caller,
and no cron entry or route triggers it ([operator-state](docs/memory/run-kit/operator-state.md)).
The brief has no launcher ([operator-brief](docs/memory/run-kit/operator-brief.md)). R5 is that
connection. The daemon's cron ticker fires the entry, `Check` decides for free, and only a real
change starts a fresh headless run from a ~10–20K-token brief. The run acts, writes a note and
exits. Target ≈ $30 for the same 6-day workload.

If R5 isn't built, F1 (fab stops seeding the typed tick) and C1 (cutover) cannot happen, and the
check and brief stay unused library code.

Why this shape over the alternatives:

- **Run in a tmux window, not a daemon child.** Constitution II says the daemon must be killable at
  any instant, and VI says tmux is independent of the server. S1 measured that the window survives
  daemon SIGTERM and SIGKILL, with a process tree of `tmux server → sh → wrapper → launcher`. The
  daemon is not an ancestor.
- **A new entry kind, not a typed prompt.** A typed prompt needs a live chat to receive it. The loop
  has no target agent: it fires a Go function.
- **Daemon seeds on the rk file (user's choice).** "rk's file exists" is already the display switch
  R3 uses (`resolveOperatorStatePath`, [cron](docs/memory/run-kit/cron.md) § External Contracts).
  Before C1 no live server has an rk file, so the new binary behaves exactly as today. `rk operator
  adopt` at C1 creates the file, and the next tick switches that server over by itself. Muting
  instead of deleting the old entry makes rollback a single unmute. A muted entry still counts as a
  `role:operator` row for fab's reconcile, so pre-F1 fab never re-seeds it.

## What Changes

### 1. The loop entry — a new cron entry kind (`internal/cron`)

Add a run-kind discriminant to `cron.Entry`. Proposed YAML: a top-level `run: operator-loop` field.
With `run` set, `payload` and `target` are not used and validation does not require them. Without
`run`, the entry behaves exactly as today. The seeded entry on disk:

```yaml
- id: <4-char>
  name: operator loop
  run: operator-loop
  schedule: { kind: backoff, min: 3m, max: 24m }
  wake_on: { event: agent-state-change, scope: server, debounce: 60s }
  pinned: true
  created_by: { at: <unix> }
```

<!-- clarified: discriminant is a top-level `run: operator-loop` key (closed set of one); payload/target unused — user chose over target.kind / an action flag -->

- **Validation**: `run` is a closed set (`operator-loop` only). It cannot appear together with
  `deliver`, `if_absent`, `respawn` or a target. There is at most one `run: operator-loop` entry
  per server file (an `Add` with a duplicate is refused). `rk cron add` gains **no** flag to create
  one, because rk seeds it. `rk cron edit` (schedule/wake tuning), `mute`, `pin` and `rm` work on it
  unchanged.
- **Tolerant load**: an older binary reading a file that has the new key ignores the unknown `run`
  key and sees an entry with an empty target. That fails per-entry validation, so it's skipped with
  `entry-invalid`, never a broken tick. That's acceptable forward compatibility; a test pins it.
- **Evaluator**: a loop entry needs no target resolution and never lands in `EvalResult.Absent`, so
  `if_absent` never applies. Due math reuses the existing schedule kinds. The **backoff anchor** has
  no agent pane to read an idle epoch from, so for a loop entry the ladder comes from the entry's own
  log. Consecutive `no change` lines climb the ladder: 3m, 6m, 12m, 24m, then 24m. Any other own
  line (`ran …`, `run-failed …`, `run-lost …`, `check-failed …`, `rescheduled`) resets it to rung 0,
  anchored at that line's ts. The rule stays a pure function of (entry, log, now), so the evaluator stays stateless.
  <!-- clarified: log-derived ladder — consecutive `no change` climbs, any other own line resets; user chose over a flat 3m interval and reset-on-wake-only -->
- **Wake**: `wake_on: agent-state-change, scope: server` stays. Without a target pane, the
  fingerprint drops instead **the panes of the server's live run window** (the role-marked window,
  § 3), so the run's own agent going idle or vanishing never wakes the loop. Debounce (60s, hold
  after own delivery) is unchanged.
- **Delivery-log outcome classes** (one line per fire, `<slug>.log`):

  | Outcome | When | Counts toward the rate cap |
  |---|---|---|
  | `no change` | Check ran and found no new changes | no |
  | `skipped-busy: run <run-id>` | a run window for this server is alive at fire time | no (as today) |
  | `ran · <outcome> · <duration>` | a run finished; transcribed from its run record (§ 4) | yes |
  | `run-failed: exit <n> · <duration>` | the launcher exited non-zero, or there was no `outcome:` line | yes |
  | `run-lost: <reason>` | the run record has no end, but its window is gone; or the launch itself failed | yes |
  | `check-failed: <detail>` | `operator.Check` returned an error (e.g. a dead tmux server, a state lock held for > 5s) | yes |

  `<duration>` uses the existing short duration format (e.g. `2m13s`), and `<outcome>` is the run's
  `outcome:` line capped at 200 runes. A `ran` line's `ts` is the time the line is written; the run
  record holds the start/end.

### 2. The loop runner seam — `cron.Deps.LoopRunner`

`internal/operator` imports `internal/cron`, so `cron` cannot call `operator.Check`. Follow the
`SessionRespawner` precedent: add a nil-safe seam `Deps.LoopRunner func(ctx, Fire) Outcome`. Wire
the production implementation in `cmd/rk`'s `serve.go`, or in a new package that imports both
(`internal/operatorloop` is the proposed name). With a nil seam the outcome is logged as
`no-deliverer`, which leaves daemons without the seam byte-identical. `tickServer` sends
`run: operator-loop` fires to the seam instead of the `Deliverer`.

The production `LoopRunner.Run(ctx, fire)` for server `S`:

1. **Busy gate**: list the windows on `S` and find the live run window (§ 3). If one exists, return
   `skipped-busy: run <run-id>`. Do **not** call Check: the run in flight owns the current changes.
2. **Transcribe** finished runs (§ 4) before deciding. This runs on every tick, not only on fires,
   so a `ran` row appears within ~30s of a run ending.
3. **Check**: `operator.Check(ctx, S, CheckOptions{})`. On error, return `check-failed: <err>`.
   When `changed == false`, return `no change`.
4. **Changed**: turn `CheckResult.Changes` into `[]operator.ChangedItem`, one per id in first-seen
   order, with reasons rendered as `<kind>[ <detail>]`. Then render the brief with
   `operator.RenderBrief` (loaded state, server label, `Now`) and **launch** (§ 3). Return an
   `Outcome` with `Held: true`, so no line is written at launch. The single `ran …`/`run-failed …`
   line is written at transcription, which keeps it to one Cron Log row per fire.
   <!-- clarified: launch writes no log line; the one row per fire is written at transcription — user confirmed -->

`Check` writes `reported` (it consumes the edges) **before** the run acts. If the run then fails,
those edges don't fire again, so § 4's failure note is what keeps the failure visible.

### 3. The run window

- **Where**: a new window in the server's `_rk-operator` session (`tmux.OperatorSessionName`). If
  that session is missing, create it detached (`new-session -d`). The window's directory is
  `@rk_srv_operator_root` when it is still valid, else `$HOME` (the `rk operator -L` directory
  rule).
- **Marking**: name the window `run-<short-id>` and, on creation, stamp `@rk_win_role=operator-run`, a new role value. Never `operator`:
  that role is a radio and would take over the chat window's role. Also stamp the run id on the
  window (`@rk_win_operator_run=<run-id>`, added to the option registry). Opt the window out of
  snapshots/closed-ring (ephemeral). `sessions.FetchSessions` keeps `_rk-operator` hidden while
  every window in it is `operator` or `operator-run`.
  <!-- clarified: role `@rk_win_role=operator-run`, run id in `@rk_win_operator_run`, window name `run-<short-id>`, hidden wrapper `rk operator run-exec` — user chose over option-only identification -->
- **"Window exists" is the busy signal**, and tmux can still tell it after a daemon restart.
- **Process shape** (from S1): `new-window` runs the hidden wrapper verb directly. There is no
  `; exec $SHELL` tail, so the window dies when the wrapper exits. Every tmux call is an argv slice
  through `internal/tmux` with a timeout (Constitution I).
- **Launcher resolution** happens in the daemon, before the window opens, with
  `fab agent operator --headless -o yaml` run in the operator root (extend `riff.ResolveAgent` or
  add a sibling that takes the `--headless` flag; same best-effort ladder). With fab absent, or when
  resolution fails, use rk's default headless launcher
  `claude -p --dangerously-skip-permissions` (a new `riff.DefaultHeadlessLauncher` constant).
  The resolved launcher string is provider-opaque. It is riff's one documented shell-expansion
  exception, run as `sh -c '<launcher>'` with the brief on **stdin** for every provider (S1:
  claude, codex and kimi all read stdin; kimi's `-p "$(cat)"` form limits one argv word to 128 KiB,
  and `BriefSizeCap` is 100 KB).
- **Wrapper**: the hidden verb `rk operator run-exec --server S --run <run-id> -- sh -c '<launcher>'`
  It:
  1. writes `started_at`, `pid` and `window` into the run record (atomic write);
  2. streams `runs/<slug>/<run-id>.brief.md` to the launcher's stdin and tees stdout+stderr to
     `runs/<slug>/<run-id>.log`;
  3. on exit, parses the **last** stdout line that matches `^outcome: (.*)$` (the R4 exit contract);
  4. on a non-zero exit, or no `outcome:` line, appends a fallback note with `--by run` to **each
     changed item**: `run failed: exit <n> — <≤200-byte log tail>`. It also sends a fail-silent
     `rk notify` (S1: an unauthenticated provider exits non-zero after 1–15 s, and without this the
     row would be empty);
  5. writes `ended_at`, `exit_code`, `outcome` and, when one is found through `internal/transcript`
     for the resolved provider, `transcript` into the run record. It never touches the cron log
     itself (§ 4).

### 4. Run records and transcription (the durable state behind one Cron Log row)

The user chose **rk run log + path**. Under `<state home>/operator/runs/<slug>/` (0700 dir, 0600
files):

| File | Written by | Content |
|---|---|---|
| `<run-id>.json` | daemon at launch (before `new-window`), wrapper at start/exit, daemon at transcription | `{id, server, entry, fired_at, changed:[ids], window, started_at, ended_at, exit_code, outcome, transcript, logged}` |
| `<run-id>.brief.md` | daemon at launch | the rendered brief (≤ `BriefSizeCap`) |
| `<run-id>.log` | wrapper | full stdout+stderr of the run |

- **Run id**: a sortable timestamp plus random suffix (e.g. `20261112T101500-ab12`).
- **Durable before acknowledged**: the record and brief are written atomically (`fsatomic`) before
  the window is created. If window creation fails, the record is marked ended and the fire logs
  `run-lost: launch: <err>`.
- **Single writer to the cron log**: only the tick (under its flock) appends to `<slug>.log`. The
  wrapper writes only the run record and the item notes. That avoids an append-vs-trim race with
  `trimLog`'s rename. On each tick, the loop runner transcribes every record that has `ended_at`
  set and `logged == false` into one delivery line (`ran · …` or `run-failed: …`), then sets
  `logged: true`. A record with no `ended_at` whose window is gone becomes `run-lost: window gone`.
- **Cron Log linking**: the delivery log line gains an optional `run` field (`<run-id>`, omitempty).
  `GET /api/cron` deliveries carry `run` plus the derived `runLog` (absolute log path) and
  `transcript` when the record has one. The Cron Log row's detail sheet shows the outcome, duration,
  run log path and transcript path as copyable text. There is **no new route or page**
  (Principle IV).
- **Retention**: keep the newest 50 run records per server and prune older ones (record + brief +
  log) at transcription time. Run records are history (recovery-backup class): a fresh daemon needs
  only the un-logged ones.
  <!-- clarified: newest 50 run records per server, pruned at transcription — user chose over 7-day age and newest-200 -->

### 5. Seeding and the legacy-entry switch

On each tick, per live server, before evaluating:

- When **rk's operator state file exists** (`operator.StatePathForServer`; existence is the switch,
  matching R3) and the server's cron file has **no** `run: operator-loop` entry, `Add` the seeded
  entry (§ 1) and `SetMuted(true)` every legacy typed-prompt entry with `target.role == operator`
  and `payload == "operator tick"`. Log one `seeded` diagnostic at Info.
- When no rk file exists, do nothing. Live servers keep fab's typed tick until C1's `rk operator
  adopt`.
- **Idempotent**: an existing loop entry, even muted, is never re-seeded or rewritten. A user who
  mutes the loop and unmutes the legacy entry has rolled back, and the daemon respects it, because
  it only seeds when no loop entry exists. To re-seed, delete the loop entry.
- A corrupt cron file skips seeding (the strict mutation read refuses to mutate) and is logged as a
  diagnostic, never written.

### 6. Respawn semantics and the chat window

The loop entry has no target, so `if_absent` and the `respawn: ["rk","operator","-L","{server}"]`
argv don't apply to it. The loop never depends on the chat window existing. "Keep respawn
semantics" means: the legacy entry (now muted) keeps its fields so an unmute brings back today's
behavior byte-for-byte, and the run window path creates `_rk-operator` when it's missing. `rk
operator` (the chat launcher and its `/fab-operator` kickoff) is **not** changed here: switching the
chat to the R4 skill is C1/F1.

### 7. Surfaces

- `rk cron list` and the Cron List tab show the loop entry with target `—` / `operator loop` and no
  payload. `rk cron list --json` mirrors the on-disk key (`run`).
- The Cron Log rows render the new outcome strings as-is. The detail sheet gains the run fields
  (§ 4).
- `rk doctor`'s cron-ticker row is unchanged. **No** new MCP tools. The hidden wrapper verb is
  excluded from `rk help-dump`'s public surface, per the hidden-verb convention.
- UI-visible changes (Cron List row and Cron Log detail sheet) need `just demo` before/after
  recordings on desktop and mobile in the PR (Constitution § PR Evidence).

### 8. Tests and acceptance

- Unit tests: entry validation and tolerant load of `run`; the log-derived backoff ladder (climb on
  `no change`, reset on `ran`); wake fingerprint excluding run-window panes; `tickServer` routing to
  `LoopRunner` (nil seam ⇒ `no-deliverer`); the busy gate; Check-to-ChangedItem mapping; run-record
  transcription (ended ⇒ `ran`, non-zero ⇒ `run-failed`, gone window ⇒ `run-lost`, `logged`
  idempotency); seeding (rk file exists/absent, legacy mute, no re-seed when muted); wrapper outcome
  parsing and failure note; retention pruning.
- **Acceptance (plan)**: on an isolated rig (own `XDG_STATE_HOME`, `RK_PORT`, tmux `-L` socket,
  never the live daemon or the user's tmux servers), with a stub launcher (`sh -c 'cat >/dev/null;
  sleep 20; rk operator track note <id> "stub acted" --by run; echo "outcome: stub acted"'`): kill
  the daemon (SIGTERM, then SIGKILL in a second pass) during the run. The run finishes and its note
  lands; a fresh daemon transcribes exactly one `ran · stub acted · …` line and doesn't fire again
  while the window was alive. S1 found that `RK_SERVER_ALLOWLIST` does **not** scope tmuxctl attach,
  so the acceptance harness MUST isolate the tmux socket directory (the S1 `unshare -Ur`
  technique, or a private `TMUX_TMPDIR`), never relying on the allowlist alone.
- Go tests run through `just test-backend`. Never restart, signal or `brew upgrade` the live daemon
  (plan Rule 1).

## Affected Memory

- `run-kit/cron`: (modify) the `run: operator-loop` entry kind, its validation and tolerant load,
  the log-derived backoff ladder for target-less entries, wake exclusion of run-window panes, the
  `LoopRunner` seam, the new delivery-log outcome classes and the `run` field, seeding on the rk
  file + legacy-entry mute, and the Operator-Tick Entry Ownership section updated (rk now seeds the
  loop entry)
- `run-kit/operator-loop`: (new) the loop runner (busy gate → Check → brief → run window), run
  records/brief/log files, the wrapper verb and exit/failure contract, transcription, retention,
  launcher resolution (headless + default), restart-survival invariants
- `run-kit/operator-state`: (modify) `operator.Check` now has a daemon caller (the loop); the
  overview's "no daemon caller yet" changes
- `run-kit/operator-brief`: (modify) the brief now has a launcher (stdin delivery, launch-time
  tool restriction still declarative-only)
- `run-kit/tmux-sessions`: (modify) the `operator-run` role value, the `@rk_win_operator_run`
  option registry row, and `_rk-operator` hiding over `operator`/`operator-run` windows
- `run-kit/ui/cron-console-tabs`: (modify) the Cron Log detail-sheet run fields and the loop
  entry's Cron List row

## Impact

- **Backend**: `internal/cron` (schema, evaluate/backoff join, wake fingerprint, tick routing,
  log line, derive, store seeding helper), a new loop-runner package (or `cmd/rk`), `internal/riff`
  (headless resolve + default headless launcher), `internal/tmux` (option registry, run-window
  helpers), `internal/sessions` (`_rk-operator` hide rule), `api/cron.go` (delivery JSON `run`,
  `runLog`, `transcript`), `cmd/rk/serve.go` (wire the seam), `cmd/rk` (hidden wrapper verb),
  `cmd/rk/cron_list.go` (the loop row).
- **Frontend**: `src/api/client.ts` (`CronDelivery` fields), `components/cron-log.tsx` /
  `cron-entry-detail-sheet.tsx` (run fields), `lib/cron-list-model.ts` (loop row target/payload
  rendering).
- **State home**: new `<state>/hexokit/operator/runs/<slug>/` tree.
- **Cross-repo**: none in this change. F1 (fab-kit) stops seeding the typed tick and delegates
  `fab operator …` once this ships in a release. Until then, the mute-not-delete switch keeps fab's
  reconcile from re-seeding.
- **Live safety**: no live server has an rk operator file before C1, so seeding is dormant on the
  live box even after upgrade. Nothing in this change restarts or signals the live daemon.

## Open Questions

- Should a run be restricted to the brief's allowed-tool list at launch (e.g. claude
  `--allowedTools`)? The resolved headless command comes from fab and is provider-opaque, so this
  change keeps the list declarative (R4 posture) and leaves enforcement for later.
- Should the run window ever be shown to the user (e.g. a Cron Log row action that switches to the
  live run window)? Not in scope; the run log path covers inspection.

## Clarifications

### Session 2026-11-12

| # | Question | Answer |
|---|----------|--------|
| 14 | When does the target-less loop entry's 3m→24m backoff climb and reset? | Log-derived: consecutive `no change` climbs; any other own line (`ran`, `run-failed`, `run-lost`, `check-failed`, `rescheduled`) resets to 3m |
| 13 | How does a cron entry mark itself as the loop kind? | Top-level `run: operator-loop` (closed set); payload/target unused |
| 17 | Run-window naming? | Role `operator-run`, option `@rk_win_operator_run`, window name `run-<short-id>`, hidden wrapper `rk operator run-exec` |
| 16 | Run-record retention per server? | Newest 50, pruned at transcription |

### Session 2026-11-12 (bulk confirm)

| # | Action | Detail |
|---|--------|--------|
| 7 | Confirmed | — |
| 8 | Confirmed | — |
| 9 | Confirmed | — |
| 10 | Confirmed | — |
| 11 | Confirmed | — |
| 12 | Confirmed | — |
| 15 | Confirmed | — |
| 18 | Confirmed | — |

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The daemon seeds the loop entry when rk's operator state file exists and no loop entry exists, and mutes (doesn't delete) the legacy `operator tick` entry; adopt/track don't touch cron | Asked: the user chose "Daemon seeds on rk file" | S:95 R:75 A:90 D:90 |
| 2 | Certain | The run transcript is an rk-owned per-run log + run record; the Cron Log detail sheet shows outcome + log path (+ provider transcript when found); no new route or page | Asked: the user chose "rk run log + path" | S:95 R:80 A:90 D:90 |
| 3 | Certain | Each run executes in its own tmux window, never as a daemon child; the window dies with the wrapper (no shell fallback) | Plan Decisions + S1 measurements; Constitution II/VI | S:95 R:70 A:95 D:95 |
| 4 | Certain | One run at a time per server; a fire while a run window is alive logs `skipped-busy` and skips Check | R5 brief verbatim | S:95 R:80 A:90 D:90 |
| 5 | Certain | The brief is delivered on stdin for every provider; launcher from `fab agent operator --headless -o yaml`, else rk's default headless launcher | R5 brief + S1 (all providers read stdin; kimi argv cap 128 KiB vs 100 KB BriefSizeCap) | S:90 R:80 A:90 D:85 |
| 6 | Certain | Backoff 3m→24m, `wake_on agent-state-change` (server, 60s debounce) and pinned are kept on the loop entry | R5 brief "Keep …"; the values are today's operator entry | S:90 R:85 A:90 D:90 |
| 7 | Certain | The loop is wired through a nil-safe `cron.Deps.LoopRunner` seam implemented outside `internal/cron` | Clarified — user confirmed | S:95 R:75 A:90 D:80 |
| 8 | Confident | The tick is the single writer to the cron log; the wrapper writes the run record, and the tick transcribes ended records into one `ran`/`run-failed`/`run-lost` line | Clarified — user confirmed | S:95 R:70 A:80 D:70 |
| 9 | Confident | Launch writes no log line (Held outcome); the one Cron Log row per fire is written at transcription | Clarified — user confirmed | S:95 R:75 A:75 D:65 |
| 10 | Certain | On a non-zero exit or a missing `outcome:` line, the wrapper appends a `--by run` failure note to each changed item and sends a fail-silent notify | Clarified — user confirmed | S:95 R:80 A:80 D:75 |
| 11 | Confident | Run windows live in `_rk-operator` (created if missing) with role `operator-run`, never `operator`; `_rk-operator` stays hidden over both | Clarified — user confirmed | S:95 R:75 A:80 D:70 |
| 12 | Confident | Respawn semantics: the loop never needs the chat window; the muted legacy entry keeps its respawn argv for rollback; the `rk operator` chat launcher/kickoff is unchanged here | Clarified — user confirmed | S:95 R:80 A:75 D:65 |
| 13 | Confident | Discriminant spelled `run: operator-loop` (a closed set), with payload/target not used | Clarified — user confirmed (over target.kind / an action flag) | S:95 R:70 A:60 D:50 |
| 14 | Confident | Loop backoff ladder from its own log: consecutive `no change` lines climb (3m→6m→12m→24m), any other own line resets | Clarified — user confirmed (over flat 3m and reset-on-wake-only) | S:95 R:70 A:60 D:45 |
| 15 | Confident | Wake fingerprint excludes the panes of the live run window so the run never wakes its own loop | Clarified — user confirmed | S:95 R:80 A:65 D:55 |
| 16 | Confident | Run-record retention: newest 50 per server, pruned at transcription | Clarified — user confirmed (over 7 days and newest 200) | S:95 R:90 A:55 D:50 |
| 17 | Confident | Role `operator-run`, option `@rk_win_operator_run`, window name `run-<short-id>`, hidden wrapper verb `rk operator run-exec` | Clarified — user confirmed (over option-only identification) | S:95 R:80 A:65 D:50 |
| 18 | Confident | Launch-time tool restriction stays out of scope; the allowed-tool list remains declarative | Clarified — user confirmed | S:95 R:85 A:70 D:65 |

18 assumptions (8 certain, 10 confident, 0 tentative, 0 unresolved).
