# Operator to HexoKit — check-then-run loop, notes as memory, autopilot in Go

> Plan doc — written 2026-11-10 from a `/fab-discuss` session (2026-11-08 → 11-10). Background
> pages in `docs/wiki/`: `operator-explained.html` (newcomer view, current design),
> `operator-one-shot-ticks.html` (measurements + comparison with other agent tools),
> `operator-quake-mock.html` (earlier UI mock; superseded on the Runs tab, see Decisions).
> Facts below were verified against fab-kit `src/go/fab/cmd/fab/operator*.go` and
> `src/kit/skills/fab-operator.md`, run-kit `origin/main` 8552373f (2026-11-05)
> `app/backend/internal/{cron,sessions}`, `cmd/rk/{operator,cron_*}.go`, and run-kit's constitution.
> Drafted in fab-kit (sahil87/fab-kit#695, closed unmerged) and moved here on 2026-11-11 so the
> plan is executed by a hexokit operator. "run-kit" in the step table means this repo.

**Problem.** The operator is one chat session that rk cron types `operator tick` into every
3–30 min. A chat re-reads its whole history on every reply, so the cost of a tick grows with the
session's age, not with its work. Measured on loom2 `snappy-gopher` (149 h, 1,563 ticks, Opus 5.5
API prices): **≈ $451**, of which ≈ 90 % was re-reading cached history (median 537K tokens per
call); **76 % of ticks** made one `tick-start --diff` call and printed "no change". After the one
compaction the context fell to 73.5K, so the 160KB operator skill was gone and the operator ran
on a summary of its own rules.

Second problem: the operator is split across two repos that each know the other's internals.
rk parses fab's state file (`internal/cron/watchlist.go`, path hardcoded in `dir.go`) and
launches the operator via `fab agent operator -o yaml`; fab seeds and edits rk's cron entry and
calls rk mux/tab/cron. Past breakages came from this seam (JSON-envelope regression zx5k, cron
seed ownership moved three times, session-selector iyb4).

---

## Goal

One loop, owned by HexoKit:

```
clock ──► check (Go, no AI) ──► nothing changed → stop, $0
                    │
                    └─ changed ──► fresh AI run (short brief) ──► act ──► write a note
                                          ▲                                  │
                                          └──── notes on tracked items ◄─────┘
you ◄──► operator chat (separate session; reads and writes the same notes; never gets ticks)
```

- **Checking is free.** A Go function decides whether anything changed.
- **Every run starts fresh** from a short brief, so cost and quality don't decay with time.
- **Notes are the memory.** What you asked for and what the operator did live on the item.
- fab provides plain CLI facts and actions only. HexoKit calls fab; fab never calls HexoKit for
  operator work. Without fab, the operator still watches panes, PRs and shell probes.

Target: the same 6-day workload for ≈ $30 (estimate: ~370 runs at 5–8 ¢).

---

## Decisions already taken (do not reopen at intake)

| Decision | Choice | Why |
|---|---|---|
| Chat vs scheduled work | **Separate.** Chat is a normal session with the operator skill; scheduled work runs as fresh headless runs | Every scheduler studied (Hermes, OpenClaw, Codex tasks, Claude Managed Agents) runs unattended work in fresh sessions; OpenClaw retired its in-chat heartbeat in Oct 2026 |
| Gate | Deterministic Go check before any model call | Hermes `wakeAgent:false` / OpenClaw `fire:false` pattern; removes the 76 % no-change ticks |
| Memory | **Notes** on tracked items (one append-only field) — no separate "directive" / "last outcome" fields | One concept. Existing `kind: note` items are the seed |
| Next-check time | rk's backoff + wake-on-agent-state-change only. The model does **not** choose its interval | Already exists; fewer moving parts |
| Models | One model for runs (the resolved `operator` role). No cheap/expensive tiering | Actions are rare (21 sends in 1,563 ticks); add tiering later only if measured cost says so |
| Prompt cache | Design for a **cold** cache: the run brief stays short (≈ 10–15K tokens) and tool-trimmed | Dispatched worker runs used the 5-minute cache (interactive sessions mostly 1-hour); runs are often > 5 min apart; works the same for codex/kimi |
| UI | No new tab. Runs appear in **Cron Log** (one-line outcome) and in item notes (Tasks tab) | run-kit Principle IV (minimal surface) |
| Where runs execute | Each run in its **own tmux window**, never a daemon child process | run-kit Principle II (disposable daemon) + VI (tmux independent of the server) |
| Ownership | HexoKit owns the engine, loop, brief, chat skill **and autopilot**. fab owns change metadata and the pipeline skills | Autopilot is git/gh/wt orchestration; its only fab touchpoints are three CLI calls (below). run-kit Principle III forbids reimplementing change management, not orchestrating branches and PRs |
| Merge authority | Unchanged: `merge-auto` only on explicit user / `--mode` / config; invalid mode is an error; merge, close-PR, branch/worktree delete always confirm otherwise | Destructive tier |
| `fab operator brief` | **Not built.** HexoKit reads fab facts through existing fab surfaces | rk already reads `.status.yaml` (`internal/sessions/fabstate.go`) |

fab touchpoints HexoKit keeps (all existing):
`.status.yaml` reads (stage map, `done`), `fab status set-base-branch` (stacked PRs),
`/fab-new` + `/fab-proceed` as spawn prompts, `fab agent operator -o yaml [--headless]` for the
launcher, `wt` (via run-kit's `internal/wt` wrapper).

---

## Current state (verified 2026-11-10)

- **fab**: operator Go ≈ 4,400 lines + ≈ 5,200 test lines — `operator.go`, `operator_track*.go`,
  `operator_tick_start.go`, `operator_clock*.go`, `operator_migrate.go`, `operator_state.go`,
  `operator_time.go`; skill `fab-operator.md` (≈ 108KB; §6 Queues ≈ 180 lines, Dependency
  Resolution ≈ 70 lines) + `_cli-fab-operator.md` (≈ 54KB). State file
  `$XDG_STATE_HOME/fab/operator/<slug>.yaml` (atomic writes + flock). fab is the only seeder of
  rk's `operator tick` cron entry (bjrk).
- **run-kit**: owns the clock (`internal/cron`: backoff, wake, deliver, respawn), the operator
  window/role (`cmd/rk/operator.go`), operator requests, the drawer (Operator Terminal | Operator
  Tasks | Cron List | Cron Log), and reads fab's tracked list (`internal/cron/watchlist.go` →
  `sessions.OperatorTracked`). Has `internal/{fsatomic,ghprobe,prstatus,promptscan,wt,inject}` and
  `internal/sessions/fabstate.go`. rk cron can only type prompts into panes; it cannot run a
  command — **not needed** once the check lives in the daemon.
- **Gap**: no headless launch path in rk today; `fab agent <role> --headless -o yaml` resolves the
  provider's `headless_command`.

---

## Rules for the operator executing this plan

1. **This plan changes the operator that runs it.** Workers build and test in their own
   worktrees. The live operator keeps running on the **installed** fab and rk binaries until
   step **C1**. Never `brew upgrade`, `fab sync` or restart the rk daemon on the live server
   mid-plan; C1 does that, with the user.
2. Steps marked **user gate** stop and ask. Everything else proceeds when its dependencies are
   merged.
3. Merge mode: `cherry-pick-ladder` (PRs created, merged after the user's review). Cross-repo
   steps never cherry-pick across repos: a cross-repo dependency means "merged **and released**".
4. Each step is one fab change, started with `/fab-new` in the step's repo, using the step's
   **Brief** below as the description. Spawn with the plan path so the agent can read this file;
   fab-kit steps (F1, F2) get the absolute path of this file in the hexokit checkout, since the
   plan does not exist in fab-kit.
5. A run-kit step that needs a fab release (or the reverse) waits for the release, not just the
   merge.

---

## Steps and dependencies

| ID | Repo | Step | Depends on | Size | Gate |
|---|---|---|---|---|---|
| **S1** | run-kit | Spike: headless run in a tmux window, per provider | — | S | — |
| **R1** | run-kit | Operator state engine: schema, `rk operator track`, `rk operator adopt` | — | L | — |
| **R2** | run-kit | Check: probe runner + diff as an in-daemon function (+ `rk operator check`) | R1 | M | — |
| **R3** | run-kit | Drawer + sessions payload read rk's own state; notes in Tasks | R1 | S | — |
| **R4** | run-kit | Run brief + chat skill (incl. autopilot rules as text, interim) | R1 | M | — |
| **R5** | run-kit | The loop: cron fire → check → run window → note; Cron Log outcome | R2, R4, S1 | L | — |
| **F1** | fab-kit | Hand over: deprecate `fab operator`, stop seeding cron, `/fab-operator` → pointer, migration file | R5 released | M | — |
| **C1** | both | Cutover on each tmux server: release, `rk operator adopt`, switch the cron entry, new chat | R3, R5, F1 released | S | **user gate** |
| **M1** | — | Measure one week vs baseline ($451 / 6.2 days); confirm cache TTL of runs | C1 | S | — |
| **R6** | run-kit | Autopilot in Go: queue, readiness, spawn, dependency code, ordered merge, 3 modes | C1 | L | — |
| **R7** | run-kit | Remove interim autopilot text from the brief | R6 | S | — |
| **F2** | fab-kit | Delete fab operator code, skill, docs (after one release cycle) | C1 + 1 release, R7 | M | **user gate** |

Parallel lanes after **R1**: R2, R3, R4 can run at once. S1 can start immediately.

```
S1 ──────────────────┐
R1 ──┬── R2 ─────────┤
     ├── R4 ─────────┴── R5 ── F1 ──┐
     └── R3 ────────────────────────┴── C1 ──┬── M1
                                             └── R6 ── R7 ── F2
```

---

## Briefs

### S1 — Spike: headless run in a tmux window (run-kit)

Throwaway. Answer, with numbers, before R5 is designed:
- Launch `fab agent operator --headless -o yaml`'s command for claude, codex and kimi in a new
  ephemeral tmux window (`rk tab new -- …` or the tmux equivalent), feeding a 10K-token brief.
- Measure: start-up time, first-token time, total tokens, and **which prompt cache the run uses**
  (`usage.cache_creation.ephemeral_5m_input_tokens` vs `_1h_` in the transcript).
- Confirm the window survives an rk daemon restart mid-run.
- Output: a short findings file under `fab/plans/` in run-kit. No production code.

### R1 — Operator state engine (run-kit)

- Port fab's tracked-item schema and verbs to `internal/operator/` + `rk operator track
  add|rm|list|note|pause|...`: kinds `pane`, `github-pr`, `linear`, `slack`, `shell`, `note`;
  `depends_on`, `scope`, `probe`, `seen`, `checked_at`.
- **Notes**: one append-only list per item (`{at, by: user|run|chat, text}`), capped.
- State at `$XDG_STATE_HOME/hexokit/operator/<slug>.yaml`, plain file, `fsatomic` writes + a lock
  (chat, run and daemon can write concurrently). Constitution II: durable before acknowledged;
  external writes win.
- `rk operator adopt`: explicit, idempotent import of fab's
  `$XDG_STATE_HOME/fab/operator/<slug>.yaml` (path logic already in `internal/cron/dir.go`),
  including fab's legacy shapes (port `operator_migrate.go`). Leaves the fab file untouched.
  **No automatic adopt on read** — the live operator keeps using fab's file until C1.
- Port the tests with the code (`operator_track_test.go`, `operator_track_types_test.go`,
  `operator_migrate_test.go`).
- Out of scope: the check, the loop, UI.

### R2 — Check (run-kit)

- Port `tick-start --diff` as a Go function the daemon calls: probe runner (shell argv,
  github-pr via `internal/ghprobe`, pane state from rk's own pane/agent-state data, `agent_exited`
  liveness), field-scoped comparison against `seen`/`last`, output = list of changed items.
- `rk operator check [--json]` exposes it for debugging; it writes the baseline exactly as the
  daemon call does.
- Linear/Slack `probe: agent` items: the check marks them due by `check_every`; the run does the
  query.
- Out of scope: launching runs.

### R3 — Drawer and sessions payload (run-kit)

- `watchlist.go` / `sessions.OperatorTracked` read rk's own state file; fall back to fab's file
  while no rk state exists (pre-C1).
- Operator Tasks rows show the latest note (with expand to all notes).
- No new tab (Principle IV).

### R4 — Run brief and chat skill (run-kit)

- **Run brief** (≈ 10–15K tokens, in rk's skill bundle, e.g. `rk skill operator run`): what
  changed + the affected items with notes + the rules — confirmation tiers, answer model
  (routine prompts only), nudges, notify, "never merge / close / delete without the user unless
  `merge-auto`", write a note before exiting. Tools limited to what runs need.
- **Interim autopilot text**: §6 Queues + Dependency Resolution from `fab-operator.md`,
  condensed, until R6 replaces it with Go.
- **Chat skill** (`rk skill operator` or a deployed skill — decide at intake): talk to the user,
  read and write notes via `rk operator track note`, spawn per the existing two-axis rule.
  Never receives ticks.
- Source material: `fab-operator.md` §1 Principles, §3 Safety, §5 Auto-Nudge, §6. Rewrite, don't
  copy: ≈ 160KB becomes ≈ 15K tokens (brief) + a chat skill of similar size.

### R5 — The loop (run-kit)

- The daemon owns an `operator` cron entry of a new kind (not a typed prompt). On fire: call R2's
  check; nothing changed → log `no change` to Cron Log, stop; changed → open an ephemeral tmux
  window in the operator's session, launch the resolved headless command (fab present:
  `fab agent operator --headless -o yaml`; else rk's default launcher) with the R4 brief, close
  the window when the run exits.
- One run at a time per server: a fire while a run window is alive is `skipped-busy`.
- Keep `--wake-on agent-state-change`, backoff 3m→24m, respawn semantics.
- rk seeds this entry itself (fab stops seeding in F1).
- Cron Log row per fire: `no change` / `ran · <one-line outcome> · <duration>`, linking the run's
  transcript.
- Acceptance: kill the daemon during a run → the run finishes and its note lands; a fresh daemon
  rebuilds everything from files and tmux.

### F1 — Hand over (fab-kit)

- `fab operator track|tick-start|clock …` print a deprecation line and delegate to the matching
  `rk operator` verb when rk ≥ R5's release is present; otherwise behave as today.
- `fab operator clock sync` and the reconcile seed stop creating the `operator tick` entry when rk
  ≥ R5's release is present.
- `/fab-operator` (project skill and the `~/` pointer written by `fab sync`) becomes a short
  pointer to HexoKit's chat skill.
- Migration file in `src/kit/migrations/` describing the hand-over (`rk operator adopt`, cron
  entry switch). The binary does no data moves; rk adopts.
- Update `_cli-fab-operator.md`, memory and specs (`docs/specs/operator.md`, `skills.md`) per the
  CLI ⇒ docs + tests rule.

### C1 — Cutover (user gate)

Per tmux server, with the user:
1. Release run-kit (R1–R5) and fab-kit (F1); upgrade both.
2. `rk operator adopt` → compare Operator Tasks before/after (same items, same notes).
3. Switch the cron entry to the loop kind (rk does this on adopt, or a verb — decide in R5).
4. Old operator chat: stop it, open the new chat skill in the operator window.
5. Watch one wake → check → run → note cycle end to end.
Rollback: re-enable the old typed-prompt entry; fab's file was never modified.

### M1 — Measure (after one week)

Same method as the baseline (transcript usage): checks, runs, tokens, $ per day, run start-up
time, cache TTL actually used. Compare with ≈ $73/day. If runs are cold-cache and expensive,
shrink the brief before considering model tiering.

### R6 — Autopilot in Go (run-kit)

Port §6 Queues + Dependency Resolution + Ordered Merge to Go:
- queue order, `depends_on`, readiness gate, `held`;
- spawn: fetch, pin `--base <SHA>` (never the ref), fetch failure = stop, via `internal/wt`;
- dependency code: `cherry-pick-ladder` (squashed cherry-pick of dep commits),
  `stacked-prs` (branch off the dep's branch + `fab status set-base-branch` when the item is a fab
  change, or the base given in the spawn prompt otherwise), `merge-auto` (no chaining);
- ordered merge and stack handling via `gh`; merge gate per Decisions;
- "done": fab change → `.status.yaml` ship done; otherwise the item's probe (e.g. PR open + CI
  green);
- mode resolution: user / `--mode` > config > `cherry-pick-ladder`. Config key location (rk
  settings vs fab's `autopilot.merge_mode`) decided at intake.
Tests for every sharp edge listed in fab-operator.md §6 (stale base, fetch failure, upstream
tracking, dep drift).

### R7 — Trim the brief (run-kit)

Delete the interim autopilot text from the run brief; the run calls the R6 engine instead.

### F2 — Delete fab's operator (fab-kit, user gate)

After one release with F1's wrappers: delete `operator*.go` (except anything `fab pane` still
needs), the operator skill and `_cli-fab-operator.md`, the user-level pointer template, and update
memory/specs. Keep `fab agent`, `fab pane`, `fab status set-base-branch`.

---

## Open decisions (resolve at each step's intake)

| Step | Question |
|---|---|
| R1 | Notes cap and shape (count vs bytes); who may delete a note |
| R4 | Chat skill name and delivery (`rk skill operator` vs a deployed `/operator` skill vs keeping the `/fab-operator` name as an alias) |
| R5 | Does `adopt` switch the cron entry, or a separate verb? Run transcript location for the Cron Log link |
| R6 | Where `merge_mode` lives after the move (rk settings, or keep reading `fab config` via the fab CLI) |
| M1 | Threshold that would justify model tiering |

## Non-goals

- Model-chosen check intervals; cheap/expensive model tiering (revisit after M1).
- A new drawer tab or page.
- Changing fab's pipeline skills (`/fab-new`, `/git-pr`, stages).
- Running the operator without rk.
