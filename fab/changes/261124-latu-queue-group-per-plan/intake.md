# Intake: One group per plan — `autopilot queue --group`

**Change**: 261124-latu-queue-group-per-plan
**Created**: 2026-11-24

## Origin

> Execute step T13 (One group per plan: queue --group) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first (Decisions and Rules bind you), then implement only the T13 Brief.

One-shot, spawned by the operator from the plan `fab/plans/sahil/26-11-20-operator-triggers.md` (the copy in this worktree is current; T13 was added there 2026-11-24). The plan's **Decisions**, **Rules for the operator executing this plan** and **Non-goals** bind this change. The T13 Brief is reproduced in substance below; the plan's Open decision for T13 is already chosen ("finished tabs stay in the plan's group").

Binding rules from the plan that apply here:
- Rule 4 — **review bar** (copied into Non-goals below): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else. A step at its third failed review stops and reports findings grouped by class.
- Rule 5 — a CLI-surface change updates the help text, the `rk skill operator` topic and `rk help-dump` fixtures in the same change.
- Rule 6 — PR states `No recording: internal CLI/engine behavior` and its validation (only T6/T7 record).
- Plan Non-goal — no rewrite of the queue engine's spawn path, the pass lock, or the engine file beyond what this step adds.

## Why

**Problem.** Agents the autopilot engine spawns for a plan land wherever the engine's landing-session seam (`autopilot.Env.Session`, called from `internal/autopilot/spawn.go` in both the spawn and respawn paths) points. Production wires that seam (`cmd/rk/operator_autopilot.go` `autopilotEnvFn`) to `resolveLandingSession(ctx, "", server, repo)` — the role-aware default `rk tab new` uses (caller's user session, else a picked user session). So two plans running in parallel interleave their tabs in one tmux session, and nothing in the sidebar says which plan a tab belongs to. The UI already calls a tmux session a **Group**; a plan should be one.

**If we don't fix it.** Parallel plans (T13 itself is queued beside T9–T12 as its own queue) produce a mixed sidebar group; the operator addendum's workaround — manually moving each finished lane's tab into a `completed` group — is operator toil and loses the plan grouping anyway.

**Why this approach.** The engine already stamps per-queue structure on every item (`queue` id, `merge_mode`); a `group` stamp is the same shape, stored durably in the engine file (Constitution II), and the spawn seam already carries a `SpawnRequest.Session`. The engine never needs to read the plan file: the chat derives the group name from the plan's slug and passes it once on the `queue` call. Rejected: having the engine parse plan files (couples the deterministic engine to a document format); moving finished tabs to a `<group>-done` session (plan Open decision T13 chose "stay"; revisit only if a long plan's group gets crowded).

## What Changes

### 1. Engine: `queue --group <name>` stamps the queue

- New flag on `rk operator autopilot queue`: `--group <name>` (string, default empty).
- `autopilot.QueueOptions` (`internal/autopilot/queue.go`) gains `Group string`. `Enqueue` stamps it on **every** item of that `queue` call — stored like `queue` and `merge_mode` (structure, Constitution II):
  - `engineItem` (`internal/autopilot/enginefile.go`) gains `Group string \`yaml:"group,omitempty" json:"group,omitempty"\``, round-tripped through the existing load/normalize/write path (and the ledger-projection mapping if `merge_mode`/`queue` are carried there — follow whatever `queue`/`merge_mode` do).
  - Items from a different `queue` call keep their own group (or none). A later `queue` call that depends on ids of an earlier call does not inherit or change the earlier call's group.
- Validation (before any write, also under `--dry-run`): `<name>` must pass the session-name validator for a to-be-created session — `validate.ValidateNewName(name, "Group name")` (the plan's "`validate.ValidateSessionName`" does not exist; `ValidateNewName` is the existing to-be-created session/window rule: non-empty, ≤128, no forbidden chars, no `:`/`.`, no spaces) — and must not start with `_rk-` (`tmux.ReservedSessionPrefix`). A failure is an `InvalidError` ⇒ usage error, exit 2, nothing written. Message shape e.g. `invalid --group "_rk-x": a group may not start with _rk-`.
- Empty `--group` (flag absent) ⇒ no `group` stamped; behavior byte-identical to today (the seam's default landing session stands).
- The queue receipt (human and `--json`) names the group when set, e.g. a line `group: operator-triggers` beside the existing `mode: <name> (flag|setting|default)` line, and `"group": "operator-triggers"` in `QueueReceipt` (omitted when empty).

### 2. Spawn and respawn land in the item's group

- Both call sites in `internal/autopilot/spawn.go` that today do `session, err := e.env.Session(ctx, repo)` (fresh spawn ~L169, respawn ~L556) use the item's stored `group` as `SpawnRequest.Session` when it is non-empty; otherwise they call the seam exactly as today.
- **Session creation when absent**: the named session is created on demand through the existing tmux ensure helper (`internal/tmux/tmux.go` `ensureSessionCapturingPlaceholder` / `ensureDetachedSession` — export a thin server-scoped wrapper rather than adding a new create path; `CreateSession` is the server-birth path and also acceptable if the server may be dead). An existing session of that name is **joined, never an error**. Because tmux's `new-session` always starts a placeholder shell window, a session the engine just created has its placeholder killed once the agent window is open (the `board.go` pin-session / `MoveWindowIntoOperatorSession` precedent), so the group ends holding only agent tabs. An adopted pre-existing session keeps all its windows.
  <!-- assumed: placeholder window of a freshly created group session is killed after the agent window opens (board.go / operator-session precedent); the Brief only says "creating the session through the existing ensure helper" -->
- Where the ensure lives: in the production path (the `RiffSpawner` / the production `Env` wiring in `cmd/rk/operator_autopilot.go`), not in the engine's decision code, so tests keep using fakes. `--dry-run` creates nothing (dry-run executes no spawn).
- Cross-repo entries of one queue share the group (sessions are not repo-bound; worktrees still sit beside each repo — unchanged).
- The ledger projection's `session` scope (written by `attach` from `req.Session`) therefore records the group — no new projection field needed.
- The engine never reads the plan file.

### 3. `status` shows the group

- `autopilot.StatusItem` (`internal/autopilot/step.go`) gains `Group string \`json:"group,omitempty"\``.
- Human `rk operator autopilot status` line appends ` · group <name>` when set (same pattern as ` · plain` / ` · base <b>` in `runAutopilotStatus`, `cmd/rk/operator_autopilot.go` ~L420).
- Help text for `queue` (Long: flags list, the entries paragraph, Exit codes 2 list gains "invalid group") and `status` (`--json` items carry `group`) updated; `rk help-dump` fixtures regenerated.

### 4. Chat skill (`docs/site/skill/operator.md` § Plans, synced to `cmd/rk/skill/operator.md`)

- A plan queue gets a group: the plan file's slug without its date prefix (`26-11-20-operator-triggers.md` → `operator-triggers`), or what the user names. It goes on the one `queue` call (`--group operator-triggers`).
- Ad-hoc queues get no group unless the user asks.
- A queued plan's confirmation line names the group, e.g. `Queued N steps from <plan> in group <group>; <ids> wait on you; <ids> wait on a release.`
- A plan queued in several `queue` calls (a later call for held/released steps, or a parallel step queued as its own call) passes the **same** `--group` on each.
- After merge: a finished lane's tab stays in its plan's group; the sidebar's done marker is the signal; the group empties only when its tabs are closed.
- Run the existing skill sync so `cmd/rk/skill/operator.md` matches, and keep the skill drift guards green.

### 5. Operator addendum (`fab/project/operator.md`)

- The Operator duties bullet "**After merge**: move the lane's tab (tmux window) to the `completed` group …" is retired for plan queues: a lane spawned by a queue with a group stays in its group after merge. Keep the `completed`-group move only for lanes without a group (ad-hoc queues / hand spawns), or drop it if nothing else needs it — state the plan-queue rule explicitly either way.

### 6. Tests

- `queue --group` stamping: every item of the call carries `group`; an earlier queue's items untouched; round-trip through the engine file.
- Validation: empty-after-trim/forbidden chars/space/`:`/`.` rejected; `_rk-foo` rejected; all as usage (exit 2) with nothing written, also under `--dry-run`.
- Spawn and respawn land in the named session: the riff/spawner fake records `SpawnRequest.Session` = group; without group the `Env.Session` seam's value is used (existing tests stay green, i.e. a queue without `--group` is unchanged).
- Ensure helper: existing session joined (no create); absent session created and placeholder killed — unit-testable via the pure argv helpers / prefix-runner pattern already in `internal/tmux`.
- `status` human line and `--json` carry `group`; omitted when unset.
- CLI: `cmd/rk` queue command test passes `--group`; help-dump fixtures.

### 7. Docs (memory)

- `docs/memory/run-kit/operator-autopilot.md`: Entry/queue section (the `--group` flag and its validation), Spawn section (landing session = item's group when set, ensure + placeholder rule, respawn same), Status section (`group` field), and a Design Decision **"A plan is a group"** (Decision: `queue --group` stamps a tmux session that spawn/respawn land in; Why: parallel plans interleaved tabs in one session, the UI already calls a session a Group, the engine stays plan-agnostic; Rejected: engine parses plan files; moving finished tabs to `<group>-done`/`completed`).

## Affected Memory

- `run-kit/operator-autopilot`: (modify) `queue --group` stamp and validation; spawn/respawn landing in the item's group with ensure-on-demand; `status` shows `group`; Design Decision "A plan is a group"

## Impact

- **Go**: `app/backend/internal/autopilot/{queue.go,enginefile.go,spawn.go,step.go,status.go,riffspawn.go,autopilot.go}` (+ their `_test.go` / harness fakes), `app/backend/internal/tmux/tmux.go` (exported ensure wrapper; no new tmux create path), `app/backend/cmd/rk/operator_autopilot.go` (flag, wiring, status rendering, help text) + `operator_autopilot_test.go`, help-dump fixtures.
- **Docs**: `docs/site/skill/operator.md` + synced `app/backend/cmd/rk/skill/operator.md`, `fab/project/operator.md`, `docs/memory/run-kit/operator-autopilot.md`.
- No API endpoint (the autopilot verbs have no HTTP surface), no frontend change, no engine-file version bump (`group` is an additive `omitempty` key; older binaries ignore it on read and drop it on their next write — same tolerance as `plain`/`base`).
- Shares `queue.go`/`spawn.go`/`status.go` with T9 and T11 running in parallel; whichever ships second rebases at `/git-pr`.
- PR evidence: `No recording: internal CLI/engine behavior` (plan Rule 6), with validation listed (unit tests + a `queue --group --dry-run` receipt).

## Open Questions

- None blocking. The placeholder-window handling and the exact home of the ensure call (RiffSpawner vs production `Env` wiring) are recorded as assumptions for plan generation.

## Non-goals

- Review bar (plan § Decisions, Rule 4): **must-fix** = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. **Should-fix** = everything else.
- No moving of finished tabs (no `<group>-done`, no automatic `completed` move).
- The engine never reads or parses plan files.
- No change to spawn shape per merge mode, dependency chaining, the pass lock, or the engine-file schema beyond the additive `group` key.
- No UI/sidebar change; no new API endpoint.
- No `--group` on `step`/`resume`/other verbs; no re-grouping of an already-queued item.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Flag is `rk operator autopilot queue --group <name>`, stamped on every item of that call, stored in the engine file like `queue`/`merge_mode` | Verbatim from the T13 Brief | S:95 R:80 A:95 D:95 |
| 2 | Certain | Finished lanes' tabs stay in the plan's group; the operator addendum's `completed`-group move is retired for plan queues | Plan Open decision T13 marked "(chosen)" and Brief "After merge" bullet | S:95 R:85 A:95 D:90 |
| 3 | Certain | Chat skill derives the group from the plan slug minus date prefix (`operator-triggers`), or the user's name; ad-hoc queues get none; confirmation line names it | Verbatim from the Brief's Chat skill bullet | S:95 R:90 A:95 D:90 |
| 4 | Confident | Validation uses `validate.ValidateNewName(name, "Group name")` plus a `_rk-` (`tmux.ReservedSessionPrefix`) prefix refusal; failures are usage errors (exit 2) with nothing written | Brief names `validate.ValidateSessionName`, which does not exist; `ValidateNewName` is the existing rule for a to-be-created session name and the engine may create it | S:70 R:85 A:85 D:75 |
| 5 | Confident | Spawn and respawn use the item's `group` as `SpawnRequest.Session` when set, else call the existing `Env.Session` seam unchanged | Brief: "Spawn and respawn pass the item's group … without --group the seam's default stands"; both call sites read `e.env.Session` today | S:85 R:80 A:90 D:85 |
| 6 | Confident | An absent group session is created via an exported wrapper over the existing `internal/tmux` ensure helper in the production path (RiffSpawner/`Env` wiring), never in dry-run; an existing session is joined | Brief: "through the existing ensure helper … an existing session … is joined"; constitution's code-quality rule keeps tmux interaction in `internal/tmux` | S:75 R:80 A:75 D:65 |
| 7 | Tentative | A freshly created group session's placeholder shell window is killed once the agent window opens | Not in the Brief; follows the `board.go` pin-session and `MoveWindowIntoOperatorSession` precedent so the group holds only agent tabs; easy to drop | S:40 R:85 A:65 D:55 |
| 8 | Confident | `status` human line appends ` · group <name>`; `StatusItem` and `QueueReceipt` JSON carry `group` (omitempty) | Brief: "`status` and `status --json` show `group`"; mirrors the existing `plain`/`base` rendering | S:80 R:90 A:90 D:85 |
| 9 | Confident | PR states `No recording: internal CLI/engine behavior` | Plan Rule 6 binds every step except T6/T7 | S:85 R:90 A:85 D:80 |
| 10 | Confident | Only `docs/memory/run-kit/operator-autopilot.md` changes in memory (plus skill doc + `fab/project/operator.md` outside memory) | Brief's Docs bullet lists exactly these | S:85 R:90 A:85 D:85 |

10 assumptions (3 certain, 6 confident, 1 tentative, 0 unresolved).
