# Operator triggers — idle defined, PR work back to the AI, one trigger door, Activity tab

> Plan doc, written 2026-11-20 from a `/fab-discuss` session; revised the same day to need no user
> involvement until the end. Design page: `docs/wiki/operator-wake-architecture.html` (diagrams, the
> trigger table, the drawer mock). It re-plans the operator after `26-11-10-operator-to-hexokit.md`
> (R1–R5, C1) and `26-11-16-operator-autopilot-restructure.md` (R6a–R6c) landed. Figures come from six
> days of live data (2026-11-14 → 11-20) on four tmux servers: cron logs, run records, ledgers, and the
> `claude -p` transcripts. "run-kit" in the step table means this repo (hexokit). Every step is in this repo.

> **Status (2026-11-20): complete except M1.** Done: T1 #1162, T2 #1164, T3 #1166, T4 #1167, T5 #1169 (feature off:
> `operator.pr_hooks` unset; the T8 spike was blocked because the account is not admin), T6 #1171, T7 #1172, R1 (done 2026-11-20,
> v3.23.10). M1 is scheduled for 2026-11-27.

**Your involvement.** None until the end. PRs merge when green (`merge-auto`); the operator runs the
one release itself (step **R1**) and notifies you before the daemon restart and after verification.
You hear from it only on a halt, at R1, and when the one-week report (**M1**) lands. If you want to
review PRs as they open, nothing stops you; nothing waits for you.

**Problem.** The check-then-run loop made quiet time free (87 % of 2,110 fires were a free `no change`),
but the waste moved one layer down and the engine grew past what the job needs:

1. **75 % of model runs do nothing.** 59 of 79 clean runs end "idle only briefly mid-run, worker active,
   sent nothing". A `/fab-fff` parent goes idle for ~30 s between every stage while its worker pane runs;
   the check reports `agent:idle` as a fresh edge and a run launches to say "not stuck". Median idle age at
   those runs: 32 s.
2. **The stage channel is dead.** `trackStage` (`internal/operator/check_pane.go`) only diffs an existing
   `scope.stage` baseline and never seeds one, so every tracked pane reads `stage: null`,
   `stage_advance`/`review_fail` never fire, and Q6a escalated "stage (unknown) over 30m" on agents running
   normally.
3. **Failures speed the loop up.** `LoopLadder` climbs only on `no change`; a `run-failed` line resets the
   rung to 3 min. When `claude -p` lost its OAuth token on 11-16 the loop launched 62 failing runs in 12 h,
   each pushing a notification and writing a `run failed` note.
4. **The PR half of the autopilot delivered nothing it was built for.** `gh repo view --json autoMergeAllowed`
   is not a field on gh 2.103, so P6 never armed a PR; gh timeouts escalated; every escalation became a model
   run whose only possible action was "transient, notified user". Meanwhile the rows that *act* (ready, arm,
   merge, restack, ci-fix, rebase, halt, disarm, fix items) are the half with the widest outcome space.
5. **Notes are diluted.** 74 of 118 run notes are no-op observations; three of the user's own notes on loom
   already sit below the brief's newest-ten window.
6. **The operator's work is invisible.** A wake and a scheduled fire both render as
   `operator loop · no change` in the Cron Log (loom: 738 of 848 rows); the check's findings, the trigger,
   the mechanical pass, the brief and the run log exist only as files.

Cost is fine: 163 real runs at ≈ 203K input tokens each, ≈ 33M tokens total against the old operator's
≈ 840M — but each run is 3–4× the planned 10–15K brief because it re-reads the whole ledger.

---

## Goal

```
triggers ─ an agent stops · a PR event · you · the clock (backstop)
    │        every trigger enters one door; a false trigger costs one free check
    ▼
operator.Check (Go, $0) ─ window-aware idle · stage seeded · edge-triggered · result recorded per fire
    │ changed
    ▼
queue engine (Go, small) ─ readiness · SHA-pinned spawn · one respawn · completion. Nothing about PRs.
    │ anything left that needs a decision
    ▼
operator run (AI, full toolset) ─ prompts · nudges · intake decisions · merges · restacks · conflicts · CI
    │
    ▼
Activity tab ─ every fire, its trigger, what the check saw, what the run did, brief + run log inline
```

**The rule.** Never wake the operator on a clock. Wake it when an agent's work has actually stopped or it
asks a question, when a PR changes, or when you say something — and only when the next step cannot be
decided mechanically. Everything the Go side still does is cheap, deterministic, and visible.

---

## Decisions already taken (do not reopen at intake)

| Decision | Choice | Why |
|---|---|---|
| Vocabulary | **Triggers**, not wakes. A trigger decides *when* to look; the check decides *what* changed | The check is edge-triggered and idempotent, so trigger sources are cheap to add and safe to get slightly wrong |
| Idle | `agent:idle` is a condition only when no other pane in the same window is `active` **and** the idle state has held ≥ `idleFloor` (3 min). `waiting` stays immediate. The 30-min `aged` conditions are unchanged | 48 of 56 no-op runs fired on an idle under 60 s with a worker pane active in the same window; both facts are in the one snapshot the check already takes (Constitution X) |
| PR work | **Back to the AI.** Rows P1–P7, B1–B2, C1–C6, F1 and their executors are deleted; the engine file loses `prs` and `fixes`; the `merge` verb and Q7 (`track-pr`) go with them | Zero successful arms, escalations the model had to re-explain, and the widest outcome space (conflicts, red CI) — exactly where judgment pays |
| Queue work | **Stays in Go**: X0–X1, Q1–Q5 (readiness, fetch-first SHA-pinned spawn with the three modes' chaining, one respawn, completion). Q6a/Q6b go | One right answer; what makes "item done → next starts" free |
| Merge modes | Kept as stamps on queue items. They still shape **spawn** (ladder cherry-pick, stacked base + `set-base-branch`, merge-auto no chaining) and now tell the **AI** its merge authority: `merge-auto` = merge green PRs without asking; the other two = merge only on the user's word | The spawn half of a mode is mechanical; the merge half is authority, which is a rule for the operator, not a row |
| This plan's queue mode | **`merge-auto`**, queued in the step order below. The current (installed) engine merges a green PR directly (row P7); its "repo auto-merge lookup failed" escalations are noise until T3 lands | No per-PR review wait; the fab pipeline's sub-agent review and Copilot are the gate. Serial by construction (each step spawns off the merged predecessor) — it costs calendar time, not your time |
| Release | **One, run by the operator** (step R1): `just release patch` → CI publishes → `rk update` → `rk daemon restart` on each live server → verify → notify. No user gate | A daemon restart loses nothing (runs live in tmux, state is files — Constitution II/VI); the reads of every file this plan changes are tolerant in both directions, so the new binary can land under a running queue |
| Legacy `operator tick` entries | Removed by the tick itself, once, on a server whose cron file holds a loop entry (T2) | A user action that nothing else depends on is a chore the tick can do |
| Measurement | An operator report item (M1), not a user action | The operator has the cron logs, run records and transcripts; the user reads one note |
| Failure backoff | Consecutive `run-failed` / `run-lost` / `check-failed` lines climb the ladder like `no change`; one push per failure streak | A dead launcher must not run every 3 min and notify 62 times |
| Trigger door | `rk operator wake -L <server> --reason <why>` writes a one-line marker file `cron/<slug>.wake`; the next tick consumes it and fires the loop with that reason. Never a bare `rk operator check`, never an HTTP dependency | The check consumes the edges it reports, so a bare check outside the loop swallows a change without a run; a marker survives a daemon restart (Constitution II) |
| Notes are triggers | A `by: user` or `by: chat` note newer than the item's last `by: run` note is a check condition (`note@<at>`) | Today a note written from the drawer waits for an unrelated edge; this makes "you" a real trigger |
| No forced run | Check now goes through the door; there is no "run anyway" | With notes as triggers it covers every case; a forced run with nothing changed is the paid no-op being removed |
| Observation notes | A run that did nothing writes **no note**; its outcome line in Activity is the "I looked" trail | Keeps the user's notes inside the brief's newest-ten window |
| Brief diet | The run re-reads one item (`rk operator track show <id> --json`), not the ledger | The brief already carries the affected items; the ledger dump is most of the extra 38K tokens per run |
| Check records | The check result (changes, open, notices) is persisted on **every** fire, not only on a change, as `runs/<slug>/<fire-id>.check.json` (newest 200 kept) | Activity must explain a `no change` row; the data is otherwise thrown away |
| Operator log vs cron log | Separate **views** over one file. The cron log stays the single delivery log; Activity joins loop lines with check records and run records | Merging them left the operator's work invisible under its own heartbeat |
| Drawer | Four segments: **Terminal · Tasks · Activity · Cron**. Activity is new; Cron List + Cron Log merge; loop rows hidden in Cron behind a toggle; **Check now** in the Activity header; a **Needs you** band on Tasks | Principle IV: the strip stays at four |
| PR trigger | **Opportunistic.** `gh webhook forward` (the `cli/gh-webhook` extension) in a sibling tmux session `rk-gh-hooks` for every repo in `operator.pr_hooks` where the logged-in account can create a hook (admin). Where it cannot, nothing is built — the clock picks the change up. No per-PR watcher | The hook only saves the minutes between the event and the next scheduled check; it is never required for correctness, so a missing permission is a doctor row, not a feature. Spike: `26-11-20-t8-spike-gh-webhook.md` — the forwarder creates a real repo hook and needs admin; `sahil-noon` has write on `sahil87/hexokit` |
| Model | Sonnet 5.5 at medium for runs, unchanged until M1 | Measure before paying for a stronger model on every run |
| Review bar | Unchanged from `26-11-16-operator-autopilot-restructure.md` § Decisions: must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else | Keeps reviews convergent |

---

## Current state (verified 2026-11-20)

- `main` holds R1–R5, C1, R6a, R6r-i, R6r-ii, R6b, R6c, the follow-ups #1143–#1156, and this plan
  (#1160). Four live servers (`hexokit`, `hexokit2`, `loom`, `fab_kit`) run the loop; the legacy
  `operator tick` entries are still on disk, muted. `fab operator` is deleted (F2, PR #703).
- Code: `internal/operator` (check, store, brief), `internal/operatorloop` (runner, exec, judgment,
  transcribe), `internal/autopilot` (≈ 4,800 lines; `rules.go` is the table; `execute.go`, `merge.go`,
  `restack.go`, `recovery.go`, `repo.go` hold the PR executors), `internal/cron` (`loop.go` has
  `LoopLadder`; `wake.go` the agent-state fingerprint; `tick.go` the orchestrator),
  `cmd/rk/operator_*.go`, frontend `components/quake-terminal.tsx`, `terminal-activity-tabs.tsx`,
  `cron-log.tsx`, `cron-list.tsx`, `watched-table.tsx`, `cron-entry-detail-sheet.tsx`.
- Release: `just release patch` (`scripts/release.sh`: clean tree, bump tag, push; CI builds and
  publishes); on a box, `rk update` (brew-installed: the managed update job) then `rk daemon restart`.
- Memory: `docs/memory/run-kit/{operator-state,operator-loop,operator-brief,operator-autopilot,cron}.md`,
  `ui/{quake-terminal,cron-console-tabs}.md`. The chat skill is `docs/site/skill/operator.md`, synced to
  `cmd/rk/skill/operator.md`.
- Known host-only test failures (unchanged): `cmd/rk` `TestPortPinRowRealPolicyValues`, `rk/api`
  `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`. Neither blocks a step.
- M1 of the parent plan (one-week measurement) is due 2026-11-21 per the `m1-measure` note on `hexokit`;
  the token figures in the Problem section are its transcript-usage method, minus pricing.

---

## Rules for the operator executing this plan

1. **This plan changes the operator that runs it.** Workers build and test in their own worktrees. The
   live daemons keep the **installed** `rk` until step **R1**, which the operator runs itself once every
   code step has merged; no step before R1 installs a binary or restarts a daemon.
2. One fab change per code step (T1–T7), started with `/fab-new` in a fresh worktree off `main`, using
   the step's **Brief** as the description plus this file's absolute path. **R1 and M1 are executed by
   the operator chat itself**, woken by a cron entry (their briefs give the exact `rk cron add`) — not
   by a queue entry (the engine turns any task in a fab repo into `/fab-new`) and not by a `note` item
   (nothing executes a note). If either was queued as a note, the note stays as the record and the cron
   entry is the mechanism.
3. Queue mode **`merge-auto`**, entries in table order. A green PR merges without anyone's word; the
   next step spawns off the merged predecessor. A halted PR (closed, red after one fix round) is an
   escalation to the user, not a wait.
4. Every step's intake copies the review bar into its non-goals; every review dispatch quotes it. A step at
   its third failed review stops and reports findings grouped by class.
5. Each step updates the memory files it touches and, where it changes a CLI surface, the help text, the
   `rk skill operator` topic and `rk help-dump` fixtures in the same change (CLI ⇒ docs + tests).
6. PR evidence per the constitution: T6/T7 change the drawer (desktop + mobile recordings via
   `just demo`); every other step states `No recording: internal CLI/engine behavior` and its validation.
7. Deleting code is the point of T3. Do not keep PR executors "for later" behind a flag; the reference is
   git history.
8. The operator notifies the user (`rk notify`) exactly three times on the happy path: when R1 is about to
   restart the daemons, when R1's verification passed, and when M1's report is written. Anything else is a
   halt.

---

## Steps and dependencies

| ID | Repo | Step | Depends on | Size | Gate |
|---|---|---|---|---|---|
| **T1** | run-kit | Check: idle defined (same-window worker + 3-min floor); stage baseline seeded | — | M | — |
| **T2** | run-kit | Clock: failure streaks climb; trigger door (`rk operator wake`, marker, fire reason); check record per fire; notes as conditions; `POST /api/operator/wake`; legacy-tick sweep | — | M | — |
| **T3** | run-kit | Engine re-scope: delete PR rows, executors, `prs`/`fixes`, `merge`, Q6a/Q6b/Q7; modes become spawn shape + AI authority; judgment set updated | T1 | L | — |
| **T4** | run-kit | Brief and chat skill: git/gh/wt back within the tiers; Merging section per mode; `track show`; re-read one item; no note when nothing done; user notes always shown | T3 | M | — |
| **T5** | run-kit | PR trigger, opportunistic: `operator.pr_hooks`, admin probe, `rk-gh-hooks` sibling session + receiver, doctor rows | T2 | M | — |
| **T6** | run-kit | Activity tab + Check now + `GET /api/operator/activity` + brief/log endpoints; loop rows hidden in Cron Log | T2, T4 | L | — |
| **T7** | run-kit | Tasks Needs-you band + note composer calls wake; Cron List + Cron Log merge into one Cron tab; mobile `?tab=` | T6 | M | — |
| **R1** | — | **Done 2026-11-20 (v3.23.10).** Release and roll out: `just release patch`, wait for CI, `rk update`, restart each live daemon, verify one trigger → check → run cycle, notify | T5 (re-landed as #1169), T7 | S | operator chat, cron-woken |
| **M1** | — | Report one week after R1: model runs/day, no-op share, tokens/run, failure streaks, PR-trigger latency; one note + notify | R1 | S | operator chat, cron-woken |

```
T1 ── T3 ── T4 ──┐
T2 ── T5 ────────┼── T6 ── T7 ── R1 ── M1
   └─────────────┘
```

Under `merge-auto` the engine runs the queue serially in table order; the Depends-on column is the
semantic order and is what the chat passes as `depends_on`.

---

## Briefs

### T1 — Check: idle defined, stage seeded (run-kit)

- **Idle.** In `operator.Check`'s pane join (`check_pane.go` `trackAgent`), the `agent:idle` condition
  requires both: no other pane **in the same tmux window** whose reconciled agent state is `active`; and
  the idle state's epoch at least `idleFloor` (3 min, a named constant) old. Until both hold the baseline
  (`scope.agent`) still advances silently — no condition, no `agent_state` delta — so resume does not
  fire a burst. `agent:waiting` is unchanged (immediate); `agent:idle:aged` / `agent:waiting:aged:<n>`
  unchanged. The pane snapshot already lists every pane with its window id; no new tmux call. The first
  idle that passes the floor emits the `agent_state` delta with the real `duration`.
- **Stage.** `trackStage`: when `scope.stage` is empty and the snapshot resolved a stage, write it as the
  baseline (no event); diffs behave as today from the next check on. Projections written by the engine
  still carry no `stage` — the check seeds it on first look.
- Tests: idle table cases (worker-active / floor-not-reached / both-pass / waiting-unaffected); stage
  seeds without an event, then `stage_advance` and `review_fail` report; the existing edge-trigger and
  aged tests stay green.
- Docs: `operator-state.md` § Pane state and § Conditions; a Design Decision "Idle means the work stopped".

### T2 — Clock: failure streaks, the trigger door, check records, notes as conditions (run-kit)

- **Failure streaks.** `cron.LoopLadder`: the trailing count that climbs the ladder counts `no change`
  **and** the failure classes (`run-failed`, `run-lost`, `check-failed`); a `ran` or `skipped-busy` line
  still resets to rung 0. `DeriveEntry`'s next-fire and the watchdog follow (they call `LoopLadder`).
  The `operator run failed` push is sent only when the previous loop line for the server was not itself
  a failure; the `run failed` note on each changed item stays.
- **Trigger door.** `rk operator wake -L <server> --reason <text>` (default `manual`): validates the
  server, writes `cron/<slug>.wake` (one line `<unix-ts> <reason>`, atomic, 0600), exits 0; no daemon
  needed. The tick, per live server, reads and deletes the marker before `Evaluate` and emits a loop fire
  with reason `trigger:<reason>`, subject to the in-flight suppression and the rate cap; the log line
  carries the reason; `LoopLadder` treats the line like any other own line. `POST /api/operator/wake`
  `{server, reason?}` writes the same marker (Constitution IX).
- **Check record per fire.** The runner persists `runs/<slug>/<fire-id>.check.json` —
  `{fired_at, reason, checked_at, changed, changes, open, notices, run?}` — on every fire including
  `no change`; newest 200 kept; transcription prunes it with the run records.
- **Notes as conditions.** `operator.Check` derives `note@<at>` for an item whose newest `by: user` or
  `by: chat` note is newer than its newest `by: run` note; keyed by the note's `at` so it fires once. It
  is a judgment reason.
- **Legacy sweep.** The tick's seed step, on a server whose cron file already holds a loop entry, removes
  every muted legacy typed `operator tick` entry (`run` empty, `target.kind == role`, `role == operator`,
  `payload == "operator tick"`) in one atomic write and logs one `expired-legacy` line per removed entry.
  An unmuted legacy entry is left alone (someone rolled back on purpose).
- Tests: ladder cases; push once per streak; marker consumed exactly once and left in place on a dead
  server; fire reason in the log; check records written for `no change`; note condition fires once;
  sweep removes muted only.
- Docs: `cron.md` § Operator Loop Entry, `operator-loop.md`, `operator-state.md`, `api-and-sockets.md`.

### T3 — Engine re-scope (run-kit)

- Delete from `internal/autopilot`: rows P1–P7, B1–B2, C1–C6, F1, Q6a, Q6b, Q7 and the wait-table entries
  for PR and fix statuses; the PR and fix status derivations; `execute.go` executors `track-pr`,
  `record-merged`, `halt`, `disarm`, `ready`, `arm`, `merge`, `fix-request`, `recovery-spawn`, `rebase`,
  `restack`, `untrack`; `merge.go`, `restack.go`, `recovery.go`; the PR facts in `observe.go` (`gh pr view`,
  `gh pr checks`, `gh repo view`, compare API); `prs` and `fixes` in the engine file and `enginefile.go`;
  the `merge` verb; `stop`'s halt/disarm half (it keeps pausing every unspawned item); `rm` of a halted
  sequence; `resume` of `halted`. Keep X0, X1, Q1–Q5, the pass lock, the migration, `queue`, `step`,
  `status`, `pause`, `resume` (of `paused`/`skipped`), `rm` (of an unspawned item).
- Readiness: a same-repo dependency with null `stop_stage` still needs its PR to **exist** and a
  change-less dependency still completes on its PR merged or green — these reads stay because spawn
  needs them; they are the only `gh` calls left in the engine.
- Merge modes stay stamped and keep shaping spawn. `status --json` keeps `merge_mode` and drops
  `pr_status`. A tolerant read of an engine file that still carries `prs`/`fixes` ignores them.
  Existing `pr-<n>` projection items are ordinary `github-pr` ledger items from now on.
- Judgment set (`operatorloop/judgment.go`): a `changed` delta on a `github-pr` item and a `done` on one
  are judgment reasons now; `pane_death` on a queue item stays mechanical (respawn).
- Tests: the `decide` enumeration shrinks to the kept combinations; spawn/respawn/completion tests stay;
  every deleted executor's test goes with it.
- Docs: `operator-autopilot.md` rewritten to the smaller engine, with a Design Decision "PR work returned
  to the operator" citing this plan; `operator-loop.md` § judgment set.
- Non-goals: no new rows; no flag that keeps the PR executors reachable.

### T4 — Brief, chat skill, and the diet (run-kit)

- **Tools back.** `brief_rules.md`: restore `git` (fetch, rebase, cherry-pick, push with
  `--force-with-lease` only), `gh pr ready|merge|edit|checks|view`, `wt` to the allowed tools and the
  direct-action allowlist, inside the confirmation tiers: merge, close, delete branch/worktree are
  **destructive** — allowed when the item's queue mode is `merge-auto`, or a `by: user`/`by: chat` note
  on the item says so; otherwise note + notify. Remove "escalation notes are the engine's".
- **Merging section**, one paragraph per mode: `cherry-pick-ladder` (merge in queue order on the user's
  word; a merged predecessor needs nothing since the successor carries its commits); `stacked-prs` (after
  a predecessor merges, retarget the successor to the default branch and `rebase --onto` it in a
  temporary detached worktree, `--force-with-lease` pinned to the observed head, merge when green — never
  touch the authoring agent's worktree); `merge-auto` (merge green PRs as they come, squash,
  `--match-head-commit`). A conflict is the run's to resolve in that temporary worktree; a red required
  check goes to the authoring agent as a fix request if its pane is alive and idle, else a recovery spawn
  through `rk riff` — one round each, then notify.
- **Chat skill.** "merge all" is the chat's own job (same Merging rules); the `autopilot merge` /
  `rm <sequence>` / `resume halted` paragraphs go; queues are still created only through `autopilot queue`.
- **Diet.** New read verb `rk operator track show <id> [--json]` (one item, all notes). The rules tell the
  run to re-read the affected item with it and the pane with `rk mux capture`, never `track list --json`
  unless it needs the whole ledger. Exit contract: a note only for an item the run **acted on**; a run
  that did nothing prints its `outcome:` line and writes no note (the wrapper's failure note is
  unchanged). The Affected-items block shows the newest 10 notes but always includes every `by: user`
  and `by: chat` note of the item.
- Tests: the render test flips (Merging section present, tools present, no autopilot section);
  `track show`; exit-contract text; golden.
- Docs: `operator-brief.md`, `operator-state.md` (verb table), `docs/site/skill/operator.md` + sync.

### T5 — PR trigger, opportunistic (run-kit)

- The spike is done: `fab/plans/sahil/26-11-20-t8-spike-gh-webhook.md`. `gh webhook forward` (extension
  `cli/gh-webhook` v0.2.0 on gh 2.103) exists and runs, but it works by **creating a real repository
  hook**, so it needs admin; one `--repo` per process; it stops on a dropped relay connection and needs a
  supervisor. The event list and hook cleanup are unverified (the spike ran as `sahil-noon`, write on
  `sahil87/hexokit`) — verify them in this step on any repo the account administers; if none is
  available, ship the probe-and-skip path with the forwarder flags as written and leave a note.
- **Rule:** if the account can add a hook, add it; if not, the change is picked up by the clock and that
  is fine. The hook saves the minutes between a PR event and the next scheduled check and is never
  required. No per-PR `gh pr checks --watch` watcher.
- Setting `operator.pr_hooks` (list of `owner/name`; default empty = off). For each listed repo,
  serve-start and `rk doctor` probe `gh api repos/<nwo>` → `permissions.admin`; when true, ensure a
  sibling session `rk-gh-hooks` (the `rk-openai-mcp` pattern) runs `gh webhook forward --repo <nwo>
  --events pull_request,pull_request_review,check_suite,workflow_run` (drop names the extension rejects)
  pointed at the receiver `rk operator hooks serve` (hidden verb, 127.0.0.1, derived port); the supervisor
  restarts a forwarder that exits, with backoff. When `admin` is false, do nothing for that repo and say
  so in doctor (`polled — no admin`); never fail serve-start over it.
- The receiver maps a PR event to every live server whose ledger holds a `github-pr` item or a queue
  projection with that `repo`/`pr` or head branch, and calls the door with `pr:<nwo>#<n>:<event>`.
  Unknown PRs are ignored. No payload content is stored.
- `rk doctor` gets a `pr hooks` row per listed repo (off / running / polled — no admin / forwarder
  missing). `rk operator hooks stop` removes only the hooks it created (identified by the forward URL).
- Tests: receiver mapping; door called once per event; nothing on an untracked PR; non-admin repo yields
  no process and a doctor row.
- Docs: a new `operator-triggers.md` memory file (triggers table, the opportunistic rule),
  `configuration.md`, `daemon-lifecycle.md`.

### T6 — Activity tab and Check now (run-kit)

- `GET /api/operator/activity?server=` joins, newest first: loop lines from the cron log (reason, outcome,
  ts), the check record for that fire, and the run record (pass, outcome, duration) when there is one;
  `GET /api/operator/runs/{server}/{id}/brief|log` serve the brief and the run log **contents**
  (read-only, size-capped).
- Drawer strip becomes `Terminal · Tasks · Activity · Cron` (`QuakeSegments` values; the `Operator` prefix
  is dropped from labels). Activity renders one row per fire: `trigger · <reason>` / `schedule · rung n` /
  `manual`, the check summary (`k items · n changes · m open · notices`), the run summary
  (`mechanical · n actions` or the outcome line, duration); a row expands to the changed/open lists, the
  brief and the run log. Filter chips `runs · triggers · all`. The staleness banner moves here.
  **Check now** in the Activity header calls `POST /api/operator/wake` and shows "run in progress" when
  a run is in flight.
- The Cron Log tab hides loop-entry rows by default (a `show loop` toggle); the merge into one Cron tab
  is T7. Mobile: the operator route's `?tab=` accepts `activity`.
- PR evidence: desktop + mobile recordings (`just demo`), before/after.
- Docs: `ui/quake-terminal.md`, `ui/cron-console-tabs.md`, `api-and-sockets.md`.

### T7 — Tasks band and the Cron tab (run-kit)

- Tasks: a **Needs you** band above the list — one row per open escalation (`escalated:` note whose
  condition is still open) and per `waiting` prompt (from `operatorTracked`), with the item id, the one
  wanted action, and `open pane` / `note…` actions; cleared when the condition clears. The note composer
  calls `POST /api/operator/wake` after a successful write.
- Cron: `Cron List` and `Cron Log` become one `Cron` segment — registry on top, deliveries below (the
  existing tables stacked, the detail sheet unchanged); loop rows behind the T6 toggle.
- Mobile `?tab=` values `tasks`, `activity`, `cron`; the legacy `log` token normalizes to `cron` for one
  release.
- PR evidence: desktop + mobile.
- Docs: `ui/quake-terminal.md`, `ui/cron-console-tabs.md`, `ui/routes-and-shell.md`.

### R1 — Release and roll out (operator chat, cron-woken, no fab change)

**Mechanism.** The chat does not poll for this; a cron entry on the plan's server wakes it every four
hours with the condition and the instruction, and the chat removes the entry once R1 is verified:

```sh
rk cron add -L hexokit2 --name "r1 release" --cron "0 */4 * * *" --role operator --deliver when-idle \
  "operator: plan fab/plans/sahil/26-11-20-operator-triggers.md — if every code-step PR (T1–T7, with T5 counted only by its re-land #1169 on main) shows MERGED and R1 is not yet done, execute step R1 exactly as its brief says and then rk cron rm this entry; otherwise reply 'R1: not yet' and do nothing else."
```

The 2-minute heads-up notification before the daemon restart is the only user-facing moment, and it
needs no reply. T5 counts as merged only when #1169 is `MERGED` (#1168 landed on T2's branch).

Run only after T1–T7 are merged (`gh pr view` on each shows `MERGED`). From a clean checkout of `main`
on this box:

1. `just release patch` (done 2026-11-20: CI auto-tagged v3.23.10, so `just release patch` was not needed) (`scripts/release.sh`: refuses a dirty tree; bumps the `v*` tag, pushes). Watch
   the release workflow to completion (`gh run list --workflow` / `gh run watch`); on failure, stop and
   notify with the run URL.
2. `rk notify "operator release: restarting daemons in 2 minutes" --title "R1"`; wait 2 minutes so a
   user mid-action can stop it.
3. `rk update` (brew-installed: the managed update job; otherwise `just build` and copy `dist/rk` over
   the path `rk doctor` reports as the daemon binary). Confirm `rk --version` shows the new tag.
4. For each live server (`rk mux sessions`-level listing, or `tmux -L <server> list-sessions` per known
   server): `rk daemon restart` (the daemon is one per box; run it once, then confirm every server's
   loop entry still fires — `rk cron list -L <server>`). Set `operator.pr_hooks` to the repos the ledgers
   track and confirm `rk doctor`'s `pr hooks` rows.
5. Verify one cycle: `rk operator wake -L hexokit --reason manual`; within a minute `GET
   /api/operator/activity?server=hexokit` (or `rk cron log -L hexokit`) shows a `trigger:manual` row with
   a check summary. Confirm the legacy `operator tick` entries are gone (`rk cron list`). Confirm no run
   launched for an idle-under-floor pane with an active sibling (watch Activity for a few minutes).
6. `rk notify "operator release <tag>: rolled out, one cycle verified" --title "R1"`; write a `by: run`
   note on this plan's tracking item with the tag, the servers restarted, and anything skipped.

Rollback: `brew` the previous version (`rk update` cannot downgrade; `brew install rk@<prev>` or
`brew switch`-equivalent as documented in `toolkit-standards.md`), `rk daemon restart`. The engine file's
dropped keys are ignored by both versions.

### M1 — Report (operator chat, cron-woken, no fab change)

Seven days after R1. The last thing R1 does is add the entry that wakes the chat for M1, dated R1's
completion plus seven days (daemon local time):

```sh
rk cron add -L hexokit2 --name "m1 report" --cron "<minute> <hour> <day> <month> *" --role operator --deliver when-idle \
  "operator: plan fab/plans/sahil/26-11-20-operator-triggers.md — execute step M1 (the one-week report) now, then rk cron rm this entry."
```

Compute from the four
servers' cron logs, run records and the `claude -p` transcripts (the same method as this plan's Problem
section): loop fires/day and the share of `no change`; model runs/day and the no-op share (target under
20 %); tokens per run (target under 60K total-in); `run-failed` streaks; PR-trigger latency where hooks
ran. Write one note on an `m1-report` item with the table and a one-line verdict against the targets,
then `rk notify`.

---

## Open decisions (resolve at each step's intake)

| Step | Question |
|---|---|
| T1 | Whether "same window" should also include "same worktree in another window" — start with same window; widen only if the data shows the gap |
| T2 | Push-once-per-streak by reading the cron log vs a streak marker beside the run records (prefer the log — no new file) |
| T3 | Whether `autopilot status` keeps listing the former PR projections, or leaves them to `track list` only |
| T5 | Receiver port derivation (port policy block) |
| T6 | Brief/log endpoints as rendered text vs raw files with the frontend rendering |
| R1 | Whether to roll out to `loom` and `fab_kit` in the same pass or one server first — same pass unless the verification on `hexokit` fails |

## Non-goals

- Model tiering; changing the run model; a new drawer page or route.
- Event-driven agent state through tmux control-mode (same door; a later step if latency matters).
- Any rewrite of the queue engine's spawn path, the pass lock, or the engine file beyond removing keys.
- Changing fab's pipeline skills or fab-kit.
