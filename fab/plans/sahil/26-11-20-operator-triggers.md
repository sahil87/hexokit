# Operator triggers — idle defined, PR work back to the AI, one trigger door, Activity tab

> Plan doc, written 2026-11-20 from a `/fab-discuss` session. Design page: `docs/wiki/operator-wake-architecture.html`
> (diagrams, the trigger table, the drawer mock). It re-plans the operator after
> `26-11-10-operator-to-hexokit.md` (R1–R5, C1) and `26-11-16-operator-autopilot-restructure.md`
> (R6a–R6c) landed. Figures come from six days of live data (2026-11-14 → 11-20) on four tmux servers:
> cron logs, run records, ledgers, and the `claude -p` transcripts. "run-kit" in the step table means this
> repo (hexokit). Every step is in this repo.

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
| PR work | **Back to the AI.** Rows P4–P7, B1–B2, C1–C6, F1 and their executors are deleted; the engine file loses `prs` and `fixes`; the `merge` verb and Q7 (`track-pr`) go with them | Zero successful arms, escalations the model had to re-explain, and the widest outcome space (conflicts, red CI) — exactly where judgment pays |
| Queue work | **Stays in Go**: X0–X1, Q1–Q5 (readiness, fetch-first SHA-pinned spawn with the three modes' chaining, one respawn, completion). Q6a/Q6b go | One right answer; what makes "item done → next starts" free |
| Merge modes | Kept as stamps on queue items. They still shape **spawn** (ladder cherry-pick, stacked base + `set-base-branch`, merge-auto no chaining) and now tell the **AI** its merge authority: `merge-auto` = merge green PRs without asking; the other two = merge only on the user's word | The spawn half of a mode is mechanical; the merge half is authority, which is a rule for the operator, not a row |
| Failure backoff | Consecutive `run-failed` / `run-lost` / `check-failed` lines climb the ladder like `no change`; one push per failure streak | A dead launcher must not run every 3 min and notify 62 times |
| Trigger door | `rk operator wake -L <server> --reason <why>` writes a one-line marker file `cron/<slug>.wake`; the next tick consumes it and fires the loop with that reason. Never a bare `rk operator check`, never an HTTP dependency | The check consumes the edges it reports, so a bare check outside the loop swallows a change without a run; a marker survives a daemon restart (Constitution II) |
| Notes are triggers | A `by: user` or `by: chat` note newer than the item's last `by: run` note is a check condition (`note@<at>`) | Today a note written from the drawer waits for an unrelated edge; this makes "you" a real trigger |
| No forced run | Check now goes through the door; there is no "run anyway" | With notes as triggers it covers every case; a forced run with nothing changed is the paid no-op being removed |
| Observation notes | A run that did nothing writes **no note**; its outcome line in Activity is the "I looked" trail | Keeps the user's notes inside the brief's newest-ten window |
| Brief diet | The run re-reads one item (`rk operator track show <id> --json`), not the ledger | The brief already carries the affected items; the ledger dump is most of the extra 38K tokens per run |
| Check records | The check result (changes, open, notices) is persisted on **every** fire, not only on a change, as `runs/<slug>/<fire-id>.check.json` (newest 200 kept) | Activity must explain a `no change` row; the data is otherwise thrown away |
| Operator log vs cron log | Separate **views** over one file. The cron log stays the single delivery log; Activity joins loop lines with check records and run records | Merging them left the operator's work invisible under its own heartbeat |
| Drawer | Four segments: **Terminal · Tasks · Activity · Cron**. Activity is new; Cron List + Cron Log merge; loop rows hidden in Cron behind a toggle; **Check now** in the Activity header; a **Needs you** band on Tasks | Principle IV: the strip stays at four |
| PR trigger | `gh webhook forward` (the `cli/gh-webhook` extension) in a sibling tmux session `rk-gh-hooks`, opt-in per repo through a setting; the clock is the fallback wherever it is absent | Seconds instead of up to 24 min for the one fact class with no local edge, and no inbound port of our own |
| Model | Sonnet 5.5 at medium for runs, unchanged until M1 | Measure before paying for a stronger model on every run |
| Review bar | Unchanged from `26-11-16-operator-autopilot-restructure.md` § Decisions: must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else | Keeps reviews convergent |

---

## Current state (verified 2026-11-20)

- `main` holds R1–R5, C1, R6a, R6r-i, R6r-ii, R6b, R6c, and the follow-ups #1143–#1156. Four live servers
  (`hexokit`, `hexokit2`, `loom`, `fab_kit`) run the loop; the legacy `operator tick` entries are still on
  disk, muted. `fab operator` is deleted (F2, PR #703).
- Code: `internal/operator` (check, store, brief), `internal/operatorloop` (runner, exec, judgment,
  transcribe), `internal/autopilot` (≈ 4,800 lines; `rules.go` is the table; `execute.go`, `merge.go`,
  `restack.go`, `recovery.go`, `repo.go` hold the PR executors), `internal/cron` (`loop.go` has
  `LoopLadder`; `wake.go` the agent-state fingerprint; `tick.go` the orchestrator),
  `cmd/rk/operator_*.go`, frontend `components/quake-terminal.tsx`, `terminal-activity-tabs.tsx`,
  `cron-log.tsx`, `cron-list.tsx`, `watched-table.tsx`, `cron-entry-detail-sheet.tsx`.
- Memory: `docs/memory/run-kit/{operator-state,operator-loop,operator-brief,operator-autopilot,cron}.md`,
  `ui/{quake-terminal,cron-console-tabs}.md`. The chat skill is `docs/site/skill/operator.md`, synced to
  `cmd/rk/skill/operator.md`.
- Known host-only test failures (unchanged): `cmd/rk` `TestPortPinRowRealPolicyValues`, `rk/api`
  `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`. Neither blocks a step.
- M1 (one-week measurement) is due 2026-11-21 per the `m1-measure` note on `hexokit`; the token figures in
  the Problem section are its transcript-usage method, minus pricing.

---

## Rules for the operator executing this plan

1. **This plan changes the operator that runs it.** Workers build and test in their own worktrees. The live
   daemons keep the **installed** `rk` until step **C1**; never `just install`, rebuild into the live
   binary path, or restart a live daemon mid-plan. C1 does that, with the user.
2. One fab change per step, started with `/fab-new` in a fresh worktree off `main`, using the step's
   **Brief** as the description plus this file's absolute path. Steps marked **user gate** or **user
   action** stop and ask; everything else proceeds when its dependencies are merged.
3. Merge mode `cherry-pick-ladder`: PRs are created and merged after the user's review. Dependencies below
   are the only chaining; same-repo steps with no dependency may run in parallel.
4. Every step's intake copies the review bar into its non-goals; every review dispatch quotes it. A step at
   its third failed review stops and reports findings grouped by class.
5. Each step updates the memory files it touches and, where it changes a CLI surface, the help text, the
   `rk skill operator` topic and `rk help-dump` fixtures in the same change (CLI ⇒ docs + tests).
6. PR evidence per the constitution: T9/T10 change the drawer (desktop + mobile recordings via
   `just demo`); every other step states `No recording: internal CLI/engine behavior` and its validation.
7. Deleting code is the point of T4. Do not keep PR executors "for later" behind a flag; the reference is
   git history.

---

## Steps and dependencies

| ID | Repo | Step | Depends on | Size | Gate |
|---|---|---|---|---|---|
| **T1** | run-kit | Idle, defined: window-aware idle + 3-min floor in `operator.Check` | — | S | — |
| **T2** | run-kit | Seed the stage baseline; `stage_advance` / `review_fail` live | T1 | S | — |
| **T3** | run-kit | Failure streaks climb the ladder; one push per streak | — | S | — |
| **T4** | run-kit | Engine re-scope: delete PR rows, executors, `prs`/`fixes`, `merge`, Q6a/Q6b/Q7; modes become spawn shape + AI authority | T2 | L | — |
| **T5** | run-kit | Brief and chat skill: git/gh/wt back within the tiers; merge, restack, conflict and CI prose for the three modes; judgment set updated | T4 | M | — |
| **T6** | run-kit | Brief diet: `track show`, re-read one item, no note when nothing was done | T5 | S | — |
| **T7** | run-kit | Trigger door: `rk operator wake --reason`, marker file, fire reason in the log, check record per fire, notes as conditions, `POST /api/operator/wake` | T3 | M | — |
| **T8** | run-kit | PR trigger: `gh webhook forward` sibling session + receiver, opt-in setting, doctor row | T7 | M | — |
| **T9** | run-kit | Activity tab + Check now + `GET /api/operator/activity`; loop rows leave the Cron tab | T7, T6 | L | — |
| **T10** | run-kit | Tasks: Needs-you band, note composer calls wake; Cron List + Cron Log merge into one Cron tab | T9 | M | — |
| **U1** | — | Remove the muted legacy `operator tick` entries on every server (`rk cron rm <id> -L <server>`) | — | S | **user action** |
| **C1** | — | Release: build, install, restart each daemon; start `rk-gh-hooks` where wanted; watch one trigger → check → run cycle in Activity | T4, T6, T8, T10 | S | **user gate** |
| **M2** | — | Measure one week after C1: model runs per day, no-op share, tokens per run, trigger latency for PR events | C1 | S | **user action** |

```
T1 ── T2 ── T4 ── T5 ── T6 ──┐
T3 ── T7 ──┬── T8 ───────────┼── C1 ── M2
           └── T9 ── T10 ────┘
U1 (any time)
```

T1–T2 and T3–T7 are two independent lanes until T9 joins them.

---

## Briefs

### T1 — Idle, defined (run-kit)

- In `operator.Check`'s pane join (`check_pane.go` `trackAgent`), the `agent:idle` condition requires both:
  no other pane **in the same tmux window** whose reconciled agent state is `active`; and the idle state's
  epoch at least `idleFloor` (3 min, a named constant) old. Until both hold the baseline (`scope.agent`)
  still advances silently — no condition, no `agent_state` delta — so resume does not fire a burst.
- `agent:waiting` is unchanged (immediate). `agent:idle:aged` / `agent:waiting:aged:<n>` are unchanged.
- The pane snapshot already lists every pane with its window id; no new tmux call.
- The `agent_state` delta for a suppressed idle is not emitted; the first idle that passes the floor emits
  it with the real `duration`.
- Tests: table cases for worker-active / floor-not-reached / both-pass / waiting-unaffected; the existing
  edge-trigger and aged tests stay green.
- Docs: `operator-state.md` § Pane state and § Conditions; a Design Decision "Idle means the work stopped".
- Acceptance on live data: replaying the six-day ledgers is not required; the unit cases cover the shapes
  seen (idle 15–57 s with a sibling worker active).

### T2 — Seed the stage baseline (run-kit)

- `trackStage`: when `scope.stage` is empty and the snapshot resolved a stage, write it as the baseline
  (no event). Diffs behave as today from the next check on.
- Projections written by the engine still carry no `stage` — the check seeds it on its first look.
- Tests: first check seeds without an event; the second check reports `stage_advance`; `review → apply`
  reports `review_fail`.
- Docs: `operator-state.md` § Pane state (d).

### T3 — Failure streaks climb (run-kit)

- `cron.LoopLadder`: the trailing count that climbs the ladder counts `no change` **and** the failure
  classes (`run-failed`, `run-lost`, `check-failed`) — a `ran` or `skipped-busy` line still resets to
  rung 0. The `DeriveEntry` next-fire and the watchdog follow the same rule (they call `LoopLadder`).
- `operatorloop.Exec` / the runner: the `operator run failed` push is sent only when the previous loop line
  for the server was not itself a failure (read the cron log, or a `failed_streak` marker beside the run
  records — pick the simpler); the `run failed` note on each changed item stays.
- Tests: ladder cases; push-once-per-streak; a success after failures resets.
- Docs: `cron.md` § Operator Loop Entry (log-derived ladder), `operator-loop.md` § Runner.

### T4 — Engine re-scope (run-kit)

- Delete from `internal/autopilot`: rows P1–P7, B1–B2, C1–C6, F1, Q6a, Q6b, Q7 and the wait-table entries
  for PR and fix statuses; the PR and fix status derivations; `execute.go` executors `track-pr`,
  `record-merged`, `halt`, `disarm`, `ready`, `arm`, `merge`, `fix-request`, `recovery-spawn`, `rebase`,
  `restack`, `untrack`; `merge.go`, `restack.go`, `recovery.go`; the PR facts in `observe.go` (`gh pr view`,
  `gh pr checks`, `gh repo view`, compare API); `prs` and `fixes` in the engine file and `enginefile.go`;
  the `merge` verb; `stop`'s halt/disarm half (it keeps pausing every unspawned item); `rm` of a halted
  sequence; `resume` of `halted`. Keep X0, X1, Q1–Q5, the pass lock, the migration, `queue`, `step`,
  `status`, `pause`, `resume` (of `paused`/`skipped`), `rm` (of an unspawned item).
- Readiness: a same-repo dependency with null `stop_stage` still needs its PR to **exist** (the branch
  has an open or merged PR) and a change-less dependency still completes on its PR merged or green —
  these reads stay because spawn needs them; they are the only `gh` calls left in the engine.
- Merge modes stay stamped and keep shaping spawn (ladder cherry-pick, stacked base + `set-base-branch`,
  merge-auto no chaining). `status --json` keeps `merge_mode` per item and drops `pr_status`.
- A tolerant read of an engine file that still carries `prs`/`fixes` ignores them (a one-line
  `migrated_prs: true` note is not needed; unknown keys are already ignored).
- Projection items for PRs that already exist in ledgers (`pr-<n>`) are ordinary `github-pr` ledger items
  from now on; nothing removes them.
- Judgment set (`operatorloop/judgment.go`): a `changed` delta on a `github-pr` item and a `done` on one
  are now judgment reasons (the engine no longer handles them); `pane_death` on a queue item stays
  mechanical (respawn).
- Tests: the `decide` enumeration shrinks to the kept combinations; spawn/respawn/completion tests stay;
  every deleted executor's test goes with it.
- Docs: `operator-autopilot.md` rewritten to the smaller engine (verbs, file, rows, decisions — record
  "PR work returned to the operator" with this plan as the why); `operator-loop.md` § judgment set.
- Non-goals: no new rows; no flag that keeps the PR executors reachable.

### T5 — Brief and chat skill (run-kit)

- `brief_rules.md`: restore `git` (fetch, rebase, cherry-pick, push with `--force-with-lease` only),
  `gh pr ready|merge|edit|checks|view`, `wt` to the allowed tools and the direct-action allowlist, inside
  the confirmation tiers: merge, close, delete branch/worktree are **destructive** — allowed only when the
  item's queue mode is `merge-auto`, or a `by: user`/`by: chat` note on the item says so; otherwise note
  + notify. Remove the line "escalation notes are the engine's".
- Add a **Merging** section, one paragraph per mode: `cherry-pick-ladder` (merge in queue order after the
  user's word; the next item was spawned with the predecessor's commits cherry-picked, so a merged
  predecessor needs nothing); `stacked-prs` (after a predecessor merges, retarget the successor to the
  default branch and `rebase --onto` it in a temporary detached worktree, `--force-with-lease` pinned to
  the observed head, then merge when green — never touch the authoring agent's worktree);
  `merge-auto` (merge green PRs as they come, squash, `--match-head-commit`). A conflict is the run's to
  resolve in that temporary worktree; a red required check goes to the authoring agent as a fix request
  if its pane is alive and idle, else a recovery spawn through `rk riff` — one round each, then notify.
- `rk skill operator` (chat): "merge all" is the chat's own job now (the same Merging rules); the
  `autopilot merge`/`rm <sequence>`/`resume halted` paragraphs go; queues are still created only through
  `autopilot queue`.
- The brief's render test flips: it asserts the Merging section exists and the tools are present.
- Docs: `operator-brief.md` (rules, allowlist, Design Decision "PR work returned to the operator").

### T6 — Brief diet (run-kit)

- New read verb `rk operator track show <id> [--json]` (one item with all its notes). The brief's rules
  tell the run to re-read the affected item with it, and `rk mux capture` for the pane — never
  `track list --json` unless it needs the whole ledger.
- Exit contract: a note is written only for an item the run **acted on** (sent, answered, merged, queued,
  notified); a run that did nothing prints its `outcome:` line and writes no note. The wrapper's failure
  note is unchanged.
- The brief's Affected-items block shows the newest 10 notes but always includes every `by: user` and
  `by: chat` note of the item, even older ones (they are the instructions).
- Tests: render golden; `track show`; exit contract text.
- Docs: `operator-brief.md`, `operator-state.md` (verb table).

### T7 — Trigger door (run-kit)

- `rk operator wake -L <server> --reason <text>` (default reason `manual`): validates the server, writes
  `cron/<slug>.wake` (one line: `<unix-ts> <reason>`, atomic, 0600) and exits 0. No daemon needed.
- The tick, per live server, reads and deletes the marker before `Evaluate` and emits a loop fire with
  reason `trigger:<reason>` for that server's loop entry, subject to the same in-flight suppression and
  rate cap as any fire. The log line carries that reason; `LoopLadder` treats the resulting line like any
  other own line.
- `POST /api/operator/wake` `{server, reason?}` calls the same code path (writes the marker; the tick does
  the rest) — Constitution IX.
- **Check record per fire:** the runner persists `runs/<slug>/<fire-id>.check.json` —
  `{fired_at, reason, checked_at, changed, changes, open, notices, run?}` — on every fire including
  `no change`; retention newest 200; transcription prunes it with the run records.
- **Notes as conditions:** `operator.Check` derives `note@<at>` for an item whose newest `by: user` or
  `by: chat` note is newer than its newest `by: run` note (and newer than `last_check_at` of the item's
  last reported note key, so it fires once). It is a judgment reason. The drawer's note composer calls
  `POST /api/operator/wake` after a successful note write.
- `rk cron log`/`GET /api/cron` surface the reason as today.
- Tests: marker consumed exactly once; a marker on a dead server is left in place; fire reason in the
  log; check records written for `no change`; note condition fires once.
- Docs: `cron.md` § Operator Loop Entry (trigger marker), `operator-loop.md` (check records),
  `operator-state.md` (note condition), `api-and-sockets.md`.

### T8 — PR trigger (run-kit)

- **Spike first, inside the step:** confirm `gh extension install cli/gh-webhook` and
  `gh webhook forward --repo <nwo> --events pull_request,check_suite,pull_request_review --url
  http://127.0.0.1:<port>/hooks/github` deliver on the current GitHub. If `check_suite` is unavailable,
  use `workflow_run`. If the extension is unusable, stop and report; the fallback design is a per-PR
  `gh pr checks <n> --watch` watcher calling the door.
- Setting `operator.pr_hooks` (list of `owner/name`; default empty = off). When non-empty, serve-start
  (and `rk doctor`) ensure a sibling session `rk-gh-hooks` (the `rk-openai-mcp` pattern) running one
  `gh webhook forward` per repo, plus the receiver `rk operator hooks serve` (hidden verb) on a
  derived port. The receiver maps a PR event to every live server whose ledger holds a `github-pr` item
  or a queue projection with that `repo`/`pr` or branch, and calls the door with
  `pr:<nwo>#<n>:<event>`. Unknown PRs are ignored. No payload content is stored.
- `rk doctor` gets a `pr hooks` row (off / running / forwarder missing).
- Tests: receiver mapping; door called once per event; nothing on an untracked PR.
- Docs: `cron.md` or a new `operator-triggers.md` memory file (triggers table), `configuration.md`,
  `daemon-lifecycle.md` (sibling session).

### T9 — Activity tab and Check now (run-kit)

- `GET /api/operator/activity?server=` joins, newest first: loop lines from the cron log (reason, outcome,
  ts), the check record for that fire, and the run record (pass, outcome, duration, brief path, run log
  path) when there is one; serves the brief and the run log **contents** on demand
  (`GET /api/operator/runs/{server}/{id}/brief|log`, read-only, 0600 files, size-capped).
- Drawer strip becomes `Terminal · Tasks · Activity · Cron` (`QuakeSegments` values; the `Operator`
  prefix is dropped from labels). Activity renders one row per fire: `trigger · <reason>` /
  `schedule · rung n` / `manual`, the check summary (`k items · n changes · m open · notices`), the run
  summary (`mechanical · n actions` or the outcome line, duration); a row expands to the changed/open
  lists, the brief and the run log. Filter chips `runs · triggers · all`. The staleness banner moves here.
  **Check now** in the Activity header calls `POST /api/operator/wake` and shows "run in progress" when
  the server reports a run in flight.
- The Cron Log tab hides loop-entry rows by default (a `show loop` toggle) — the merge into one Cron tab
  is T10.
- Mobile: the operator route's `?tab=` accepts `activity`; the staleness banner is unchanged on mobile.
- PR evidence: desktop + mobile recordings (`just demo`), before/after.
- Docs: `ui/quake-terminal.md`, `ui/cron-console-tabs.md`, `api-and-sockets.md`.

### T10 — Tasks band and the Cron tab (run-kit)

- Tasks: a **Needs you** band above the list: one row per open escalation (`escalated:` note whose
  condition is still open) and per `waiting` prompt (from `operatorTracked`), with the item id, the one
  wanted action (from the note / the prompt's first line), and `open pane` / `note…` actions; cleared when
  the condition clears. The note composer (existing) calls the door after writing.
- Cron: `Cron List` and `Cron Log` become one `Cron` segment — registry on top, deliveries below (the
  existing tables, stacked, the detail sheet unchanged); loop rows behind the T9 toggle.
- Mobile `?tab=` values: `tasks`, `activity`, `cron`; `log`/`activity` legacy tokens normalize to `cron`
  for one release.
- PR evidence: desktop + mobile.
- Docs: `ui/quake-terminal.md`, `ui/cron-console-tabs.md`, `ui/routes-and-shell.md`.

### U1 — Remove the legacy entries (user action)

On each server: `rk cron list -L <server>` → `rk cron rm <id of "operator tick"> -L <server>`. Nothing
reseeds it (fab's reconcile is gone with F2).

### C1 — Release (user gate)

1. Build and install `rk`; restart each daemon (`rk serve --restart` per server, with the user).
2. Set `operator.pr_hooks` for the repos that should push PR events; confirm `rk-gh-hooks` is up
   (`rk doctor`).
3. Open the drawer → Activity; press **Check now**; watch `manual · check … · no change`.
4. Let one agent finish a stage; confirm no run launches while its worker is active, and one launches
   once it is idle past the floor.
5. Merge one PR by hand; confirm the `pr:` trigger row appears within seconds.

Rollback: the previous binary; the engine file's dropped keys are ignored by both versions.

### M2 — Measure (user action)

One week after C1, the same transcript-usage method as M1 plus: model runs per day and the no-op share
(target: under 20 %), tokens per run (target: under 60K total-in), PR-event trigger latency, and the
count of `run-failed` streaks.

---

## Open decisions (resolve at each step's intake)

| Step | Question |
|---|---|
| T1 | Whether "same window" should also include "same worktree in another window" (a worker spawned into its own tab) — start with same window; widen only if the data shows the gap |
| T3 | Streak marker beside the run records vs reading the cron log for the push-once rule |
| T4 | Whether `autopilot status` should keep listing `github-pr` ledger items that were PR projections, or leave them to `track list` only |
| T7 | Check-record retention (200) vs reusing the run-record pruning count (50) |
| T8 | Receiver port derivation (port policy block) and whether the forwarder runs one process per repo or one with `--repo` repeated |
| T9 | Whether the brief/log endpoints are server-side rendered text or raw files with the frontend rendering |

## Non-goals

- Model tiering; changing the run model; a new drawer page or route.
- Event-driven agent state through tmux control-mode (same door; a later step if latency matters).
- Any rewrite of the queue engine's spawn path, the pass lock, or the engine file beyond removing keys.
- Changing fab's pipeline skills or fab-kit.
