# Plan: Operator PR Trigger Hooks (opportunistic)

**Change**: 261120-xdig-operator-pr-trigger-hooks
**Intake**: `intake.md`

## Requirements

### Settings: `operator.pr_hooks`

#### R1: The setting
The settings registry (`app/backend/internal/settings/settings.go`) SHALL carry a key `operator.pr_hooks` of kind `list` (string list, default empty = off), serialized with the existing `listSection` shape under the flat dotted key (`operator.pr_hooks:` followed by `  - "owner/name"` lines — the registry's keys are flat dotted names, like `operator.merge_mode`). Each entry MUST match the GitHub `owner/name` shape `^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$`; the regex MUST live in one place shared by settings and `internal/operator` (move it to `internal/validate`, e.g. `validate.ValidateGitHubRepo`, and make `operator.NewGitHubPRItem` use it — settings cannot import operator). Invalid entries are skipped on parse and rejected (400, all-or-nothing) on apply; duplicates collapse preserving first order. The key is `ui: false` (no Settings-page row in this change), `live: true`.

- **GIVEN** a config.yaml with `operator.pr_hooks:` and entries `"sahil87/hexokit"`, `"bad repo"`, `"sahil87/hexokit"`
- **WHEN** settings load
- **THEN** `Settings.OperatorPRHooks` is `["sahil87/hexokit"]`
- **AND** an apply of `["ok/repo", "no slash"]` returns an error and leaves the value unchanged

#### R2: Receiver port in the port policy
`app/backend/internal/portpolicy/ports.env` SHALL gain `PORTPOLICY_GH_HOOKS=21900` (machine-only 5-digit range; outside the rig block 21000–21299, the rule-P tunnel target 21500–21599, and the sentinel 21999), exposed as `portpolicy.GHHooks`, required by `parse`, and covered by `Reserved()`/`Collisions()` so a daemon or code-server port pinned onto it is flagged. `scripts/e2e-env.sh` keeps sourcing the file unchanged.

- **GIVEN** the embedded ports.env
- **WHEN** `portpolicy` initializes
- **THEN** `GHHooks == 21900` and `Collisions(21900, 0)` names the gh-hooks reservation

### Daemon: the `rk-gh-hooks` sibling session

#### R3: Admin probe
For each listed repo the system SHALL probe `gh api repos/<nwo> --jq .permissions.admin` via `exec.CommandContext` (explicit argv, ~10 s timeout) and classify the result as `admin`, `no-admin`, or `probe-failed` (error, timeout, non-boolean output). The probe is re-derived on every call (never persisted). A package seam makes it test-drivable.

- **GIVEN** `gh` answers `false` for `owner/x`
- **WHEN** the probe runs
- **THEN** the result is `no-admin` and no forwarder is spawned for `owner/x`

#### R4: Ensure / reconcile the session
`internal/daemon` SHALL gain `ghhooks.go` mirroring `openaimcp.go`'s shape (package seams for session/window existence, spawn, kill, lookPath, probe; `slog` warnings; daemon-gated by `jobDaemonRunning`). The ensure:
1. setting empty ⇒ kill a stale `rk-gh-hooks` session (exact-match `=rk-gh-hooks`) if present; return;
2. probe every listed repo;
3. ensure the session `rk-gh-hooks` with a window `receiver` running `<rk> operator hooks serve --port <portpolicy.GHHooks>` (absolute stable rk path, as the openai-mcp install job resolves it);
4. for each `admin` repo, ensure a window (name derived from the nwo, sanitized for tmux, e.g. `fwd-owner-name`) running `<rk> operator hooks forward --repo <nwo> --port <port>`; skip when the `gh-webhook` extension is absent (R8 reports it);
5. kill forwarder windows whose repo is no longer listed or no longer admin.
It is called best-effort from `startSession` in `internal/daemon/daemon.go` right after `ensureOpenAIMCP()`, and from a settings-stamp watcher run by `rk serve` (the `WatchOpenAIMCPSettings` pattern) so an edit to `operator.pr_hooks` takes effect without a restart. It NEVER fails daemon start or serve; every failure is logged.

- **GIVEN** `operator.pr_hooks: ["a/admin", "b/noadmin"]`, extension installed, daemon running
- **WHEN** ensure runs
- **THEN** session `rk-gh-hooks` has windows `receiver` and the `a/admin` forwarder only
- **AND** when the list becomes empty the session is killed

#### R5: Forwarder supervisor (`rk operator hooks forward`, hidden)
A hidden verb SHALL run `gh webhook forward --repo <nwo> --events pull_request,pull_request_review,check_suite,workflow_run --url http://127.0.0.1:<port>/hooks/github` via `exec.CommandContext` (no shell), and restart it on exit with backoff: 5 s initial, doubling, capped at 5 min, reset to 5 s after a run that lasted ≥ 10 min. It exits on SIGINT/SIGTERM (context cancel) without restarting. The backoff schedule is a pure function under test. If the extension rejects an event name at create (observed at apply on an admin repo), that name is removed from the constant list.

- **GIVEN** the child exits after 1 s three times in a row
- **WHEN** the supervisor schedules restarts
- **THEN** the waits are 5 s, 10 s, 20 s; after a 15-min run the next wait is 5 s again

### Receiver: `rk operator hooks serve` (hidden)

#### R6: Loopback receiver and event extraction
A hidden verb SHALL bind `127.0.0.1:<port>` (default `portpolicy.GHHooks`, `--port` override) and serve only `POST /hooks/github`. It reads `X-GitHub-Event` and a body capped (e.g. 5 MiB; over-cap ⇒ 413) and extracts `repository.full_name` plus PR identities: `pull_request`/`pull_request_review` → `pull_request.number`, `pull_request.head.ref`; `check_suite` → `check_suite.pull_requests[].number`, `check_suite.head_branch`; `workflow_run` → `workflow_run.pull_requests[].number`, `workflow_run.head_branch`; any other event → ignored (2xx). It always answers 2xx for a well-formed delivery (mapping errors are logged, never 5xx), stores no payload, and logs only event name + `nwo#n`. Non-POST or other paths ⇒ 404/405.

- **GIVEN** a `check_suite` delivery for `o/r` with `pull_requests:[{number:7}]`, `head_branch:"feat-x"`
- **WHEN** it is POSTed
- **THEN** the extracted event is `{event: check_suite, nwo: o/r, prs: [7], branch: feat-x}`

#### R7: Mapping to servers and the door
The mapping (a pure-ish function over injected server list + per-server state loader, in a new package, e.g. `internal/ghhooks`) SHALL, for every **live** tmux server (`tmux.ListServers`), load the server's operator state (`operator.StatePathForServer` + `operator.Load`, tolerant) and match when any tracked item:
- is a `github-pr` item whose pinned repo (probe argv `--repo <nwo>`, case-insensitive) equals the event nwo AND (`scope.pr` ∈ event PRs OR `scope.branch` == event branch); or
- is a queue projection (pane item with `scope.queue`) whose repo resolves to the event nwo AND whose branch (`branch_map[scope.change].branch`, else `scope.branch`) equals the event branch. A projection's `scope.repo` is a **local path**; its nwo is resolved from `git -C <path> remote get-url origin` (https and ssh forms parsed; `exec.CommandContext`, short timeout; cached per delivery).

For each matching server the receiver SHALL write exactly one marker via `cron.WriteWakeMarker(cron.DefaultDir(), server, reason, now)` with reason `pr:<nwo>#<n>:<event>` (`<n>` = the first matched PR number, or the branch when matched by branch only), truncated to `cron.MaxWakeReasonRunes`. Unknown PRs and dead servers produce no marker. Done items are still matched (a merge event for a done item is harmless — one free check).

- **GIVEN** server `work` tracks github-pr `pr-12` (`--repo o/r`, `pr:12`) and server `play` tracks nothing
- **WHEN** a `pull_request` delivery for `o/r#12` arrives
- **THEN** `cron/work.wake` reads `<ts> pr:o/r#12:pull_request` and no `play.wake` exists
- **AND** a delivery for `o/r#99` writes no marker anywhere

### CLI and doctor

#### R8: `rk doctor` rows
`rk doctor` SHALL append one row per listed repo named `pr hooks <nwo>` (or a single `pr hooks` row reading `off` when the list is empty), always `OK: true` (the gui/openai-mcp posture — never flips the verdict). Note states:
| Note | When |
|---|---|
| `off` | list empty |
| `running` | admin, daemon up, `receiver` and the repo's forwarder windows alive |
| `polled — no admin` | probe `no-admin`; or `probe-failed` with the note `polled — no admin (probe failed: <err>)` |
| `forwarder missing` | admin, but extension absent (hint `gh extension install cli/gh-webhook`), daemon down (hint `rk serve -d`), or a window missing/dead |
The doctor rows are bounded by a timeout and use seams for tests.

- **GIVEN** `operator.pr_hooks: ["b/noadmin"]`
- **WHEN** `rk doctor` runs
- **THEN** a row `pr hooks b/noadmin` reads `polled — no admin`, OK, and no tmux window exists for it

#### R9: `rk operator hooks stop`
A visible verb SHALL kill the `rk-gh-hooks` session (exact match; absent = success) and, for each listed repo whose probe says admin, list `gh api repos/<nwo>/hooks` and delete (`gh api -X DELETE repos/<nwo>/hooks/<id>`) **only** hooks created by the forwarder — identified by the extension's registered shape (its `config.url` relay host / hook name, verified against a real hook on an admin repo at apply; the identification is one named predicate under test). Any other hook is never touched. Help text documents that the next serve-start (or setting edit) brings the session back unless `operator.pr_hooks` is emptied. Exit codes per the toolkit convention (0 ok, 1 operational, 2 usage); `--json` envelope like `rk operator wake`.

- **GIVEN** a repo with hooks `{id:1, forwarder shape}` and `{id:2, config.url: https://ci.example}`
- **WHEN** `rk operator hooks stop` runs
- **THEN** only hook 1 is deleted

#### R10: CLI surface docs
`rk operator hooks` (group) with `stop` visible and `serve`/`forward` hidden SHALL have help text in the repo's long-help style (purpose, flags, examples, exit codes); `rk help-dump` and its tests stay green (hidden verbs per existing hidden-verb handling); the `rk skill operator` topic (`docs/site/skill/operator.md` → `cmd/rk/skill/operator.md` sync) gains one sentence that PR events arrive as `pr:<nwo>#<n>:<event>` wake reasons when `operator.pr_hooks` lists the repo and the account is admin, else the clock picks the change up.

- **GIVEN** the built CLI
- **WHEN** `rk operator hooks --help` runs
- **THEN** `stop` is listed and `serve`/`forward` are not

### Non-Goals
- Review bar (plan § Decisions): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.
- No per-PR `gh pr checks --watch` watcher; no `--org` mode; no webhook secret; no public endpoint; the door is the marker file, never an HTTP call to the daemon.
- No auto-install of `cli/gh-webhook`; no Settings UI row; no frontend change (PR evidence: `No recording: internal CLI/daemon behavior`).
- No queue-engine, check, or tick changes; no binary install or daemon restart (plan Rule 1).

### Design Decisions

#### Fixed port-policy receiver port
**Decision**: The receiver listens on `PORTPOLICY_GH_HOOKS=21900`, one fixed port from the policy file.
**Why**: One daemon per box ⇒ one receiver; the policy file is the single source of truth for reserved ports and its collision check covers it.
**Rejected**: `daemon port + 3` — the e2e rig block is laid out as contiguous triples, so +3 lands on the next rig's Vite port.
*Introduced by*: 261120-xdig-operator-pr-trigger-hooks

#### The receiver writes the marker, not the daemon
**Decision**: `rk operator hooks serve` calls `cron.WriteWakeMarker` directly for each matched server.
**Why**: The plan's door is the marker file (survives daemon restarts, no HTTP dependency); the receiver already runs on the box with the same state home.
**Rejected**: POSTing `/api/operator/wake` — adds an HTTP dependency the plan forbids for the door.
*Introduced by*: 261120-xdig-operator-pr-trigger-hooks

#### Go supervisor for the forwarder
**Decision**: A hidden `rk operator hooks forward` verb supervises `gh webhook forward` with capped exponential backoff.
**Why**: The forwarder exits on relay loss and on create failure; Constitution I forbids shell-string loops.
**Rejected**: a shell `while true` loop in the tmux window; a per-repo tmux respawn hook.
*Introduced by*: 261120-xdig-operator-pr-trigger-hooks

## Tasks

### Phase 1: Setup

- [x] T001 [P] Move the GitHub `owner/name` regex into `app/backend/internal/validate/validate.go` (`ValidateGitHubRepo`, + test) and use it from `internal/operator/export.go` <!-- R1 -->
- [x] T002 [P] Add `PORTPOLICY_GH_HOOKS=21900` to `app/backend/internal/portpolicy/ports.env`, `GHHooks` + required key + `Reserved()`/`Collisions()` coverage in `portpolicy.go`, tests in `portpolicy_test.go`; confirm `scripts/e2e-env.sh` still sources cleanly <!-- R2 -->
- [x] T003 Add `operator.pr_hooks` (`OperatorPRHooks []string`, kind list, validated parse/apply, dedup, `ui: false`) to `app/backend/internal/settings/settings.go` + `settings_test.go` round-trip/validation cases; check `api/settings.go` needs nothing extra <!-- R1 -->

### Phase 2: Core Implementation

- [x] T004 Create `app/backend/internal/ghhooks/` (receiver core): event extraction (`Extract(event string, body []byte)`), the mapping (`Match(servers, loadState, resolveNWO)` over `operator.State`), reason formatting/truncation, the origin-URL → nwo parser, and the HTTP handler (`POST /hooks/github`, body cap, 2xx contract) — with table tests for every event kind, github-pr match by pr and by branch, projection match via resolved nwo + branch_map, untracked PR ⇒ no marker, dead server skipped, one marker per server per event <!-- R6 R7 -->
- [x] T005 Add the forwarder supervisor (backoff pure function + run loop with injectable runner/clock) in `app/backend/internal/ghhooks/forward.go` with tests for the 5 s→5 min schedule and reset after ≥10 min <!-- R5 -->
- [x] T006 Add the admin probe (`ProbeAdmin(ctx, nwo)` → admin/no-admin/probe-failed, seam over gh) and the extension-present check in `internal/ghhooks` + tests <!-- R3 -->
- [x] T007 Create `app/backend/internal/daemon/ghhooks.go` (+ `ghhooks_test.go`): session/window constants, ensure/reconcile per R4 (empty ⇒ kill; receiver window; per-admin forwarder windows; stale-window removal; daemon gate), `KillGHHooksSession`, status probe for doctor, and `WatchGHHooksSettings` <!-- R4 -->
- [x] T008 Wire `ensureGHHooks()` into `startSession` after `ensureOpenAIMCP()` in `internal/daemon/daemon.go`, and start `WatchGHHooksSettings` from `cmd/rk/serve.go` beside `WatchOpenAIMCPSettings` <!-- R4 -->

### Phase 3: Integration & Edge Cases

- [x] T009 Add `app/backend/cmd/rk/operator_hooks.go` (+ test): `operator hooks` group, hidden `serve` (binds 127.0.0.1, writes markers via `cron.WriteWakeMarker`), hidden `forward`, visible `stop` (session kill + forwarder-hook deletion predicate under test, `--json`) with long help and exit codes <!-- R9 R10 R6 R5 -->
- [x] T010 Add the `pr hooks` doctor rows to `app/backend/cmd/rk/doctor.go` (helper beside the openai-mcp row) + `doctor_test.go` cases for off / running / polled — no admin (incl. probe failed) / forwarder missing <!-- R8 -->
- [x] T011 Live verification (best effort): on `sahil-noon/conductor-playground` (admin), run the forwarder against a local receiver to confirm accepted event names, the created hook's shape (adjust the R9 predicate), and whether it removes its hook on exit; clean up every hook/branch created. If not possible, record that in `## Notes` and keep the flags as written <!-- R5 R9 -->

### Phase 4: Polish

- [x] T012 Update `docs/site/skill/operator.md` with the PR-trigger sentence and re-sync `app/backend/cmd/rk/skill/operator.md` (existing sync mechanism); keep `help_dump_test.go` and skill-sync tests green <!-- R10 -->
- [x] T013 Run `just test-backend` and `cd app/backend && go vet ./...`; fix failures (known host-only failures `TestPortPinRowRealPolicyValues`, `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath` are pre-existing) <!-- R1 R2 R3 R4 R5 R6 R7 R8 R9 R10 -->

## Execution Order

- T001 blocks T003 and T004 (shared validator)
- T002 blocks T007 and T009 (port constant)
- T004–T006 block T007, T009, T010

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `operator.pr_hooks` parses, validates (shared validator), dedups, serializes, and defaults empty
- [ ] A-002 R2: `PORTPOLICY_GH_HOOKS=21900` is in ports.env, exposed as `portpolicy.GHHooks`, and in the collision check
- [ ] A-003 R3: the admin probe returns admin / no-admin / probe-failed via an argv `exec.CommandContext` with a timeout
- [ ] A-004 R4: ensure builds the session with a receiver and one forwarder per admin repo only, removes stale windows, kills the session when the list is empty, and never fails daemon start
- [ ] A-005 R5: the forwarder runs `gh webhook forward` with the four events and the loopback URL and restarts with the specified backoff
- [ ] A-006 R6: the receiver binds 127.0.0.1 only, serves only `POST /hooks/github`, extracts the four event kinds, caps the body, stores no payload
- [ ] A-007 R7: a tracked PR (github-pr by pr or branch; projection by resolved nwo + branch) writes one `pr:<nwo>#<n>:<event>` marker per matching live server
- [ ] A-008 R8: doctor shows one OK-shaped `pr hooks` row per listed repo with the four states
- [ ] A-009 R9: `rk operator hooks stop` kills the session and deletes only forwarder-created hooks
- [ ] A-010 R10: `rk operator hooks` help lists `stop` only; skill topic carries the PR-trigger sentence and is synced

### Scenario Coverage

- [ ] A-011 R7: tests prove door called once per event per server, nothing on an untracked PR, dead server skipped
- [ ] A-012 R4: test proves a non-admin repo yields no process/window and a doctor row
- [ ] A-013 R5: backoff schedule test (5, 10, 20 … cap 300 s; reset after ≥ 10 min)

### Edge Cases & Error Handling

- [ ] A-014 R6: malformed JSON / unknown event / no PR identity ⇒ 2xx, no marker; over-cap body ⇒ 413
- [ ] A-015 R3: gh missing, unauthenticated, or timing out ⇒ probe-failed, no spawn, doctor note says probe failed
- [ ] A-016 R4: daemon down ⇒ ensure touches no tmux and doctor says `forwarder missing` with the `rk serve -d` hint

### Code Quality

- [ ] A-017 Pattern consistency: `internal/daemon/ghhooks.go` mirrors `openaimcp.go` (seams, postures, slog, exact-match targets, teardown audit log)
- [ ] A-018 No unnecessary duplication: the repo regex, wake marker writer, operator state loader, and stable rk path resolver are reused, not re-implemented
- [ ] A-019 Every subprocess uses `exec.CommandContext` with an argv slice and a timeout (Constitution I / § Process Execution); tmux goes through `internal/tmux` / the daemon's runTmux
- [ ] A-020 No magic strings/numbers: session/window names, port, events, backoff bounds, body cap are named constants
- [ ] A-021 Comments state constraints, not narration; no change IDs in code comments
- [ ] A-022 New behavior has Go tests alongside (`*_test.go` in the same package)

### Security

- [ ] A-023 R6: the receiver never binds a non-loopback address and never logs/persists payload content
- [ ] A-024 R9: hook deletion is gated by the forwarder-shape predicate and admin probe; no other hook can be deleted

## Notes

T011 live verification (2026-11-20, `gh` 2.103.3, `cli/gh-webhook` v0.2.0, account `sahil-noon`, repo `sahil-noon/conductor-playground`, admin true; hooks `[]` before and after):

- **Events**: `pull_request,pull_request_review,check_suite,workflow_run` is accepted by the hook-create call (the created hook listed exactly those four); nothing was dropped from the list.
- **Hook shape** (the R9 predicate): `name: "cli"`, `config.url: "https://webhook-forwarder.github.com/hook"` (the relay, not the local `--url`), `config.content_type: json`, `type: Repository`. `IsForwarderHook` keys on name + relay URL.
- **Cleanup**: the extension removes its own hook when the *extension process* gets SIGTERM. `gh` does not pass signals on — SIGTERM to `gh` alone orphaned the extension and left the hook (and SIGINT to the extension did nothing). The supervisor therefore runs the child in its own process group and SIGTERMs the group; verified with the built `rk operator hooks forward`: SIGTERM to the supervisor ended every process and the hook list returned to `[]`.
- **Duplicate hook**: a second forwarder on a repo that already has a forwarder hook fails with `HTTP 422 Hook already exists on this repository` (and prints it only on exit). A crashed supervisor that leaves its extension orphaned therefore blocks restarts until the orphan or its hook is removed (`rk operator hooks stop` removes the hook); the supervisor keeps retrying with backoff and does not sweep hooks itself, so it can never delete a forwarder a user started by hand.
- **Delivery**: one `pull_request` delivery (24 KB, `X-GitHub-Event: pull_request`, path `/hooks/github`) reached a throwaway local receiver through the relay. On this host the relay websocket then dropped about every 50 s (`websocket: close 1006`), the forwarder exited 1 and the supervisor restarted it (5 s, 10 s, 20 s waits observed), so later deliveries in the capture session were lost in the gaps — the clock covers them. No real `check_suite`/`pull_request_review` payload was captured; their field paths follow GitHub's documented payloads.
- **Left on GitHub**: three closed throwaway PRs (#1–#3, "t11 probe …") on `sahil-noon/conductor-playground`; their branches were deleted. No PR on `sahil87/*`.
- **Ledger match**: queue items live in a separate `<state>.autopilot.yaml`; the operator ledger holds only their projection, which drops `scope.queue`. The receiver therefore matches any ledger item with an absolute `scope.repo` path whose branch (`branch_map[scope.change]`, else `scope.branch`) equals the event's head branch and whose checkout origin resolves to the event repo — it does not require `scope.queue`, and does not import `internal/autopilot`.
- Reconcile never tears down a forwarder on a probe *failure* (only on a definitive no-admin or an unlisted repo), and builds no session at all when no repo is admin or the extension is missing.

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Settings key is the flat dotted `operator.pr_hooks` list (not a nested `operator:` map) | The registry's keys are flat dotted names (`operator.merge_mode`) | S:85 R:85 A:95 D:90 |
| 2 | Confident | Move the owner/name regex into `internal/validate` | settings cannot import operator (import cycle via tmux); validate is already imported by settings | S:70 R:85 A:85 D:70 |
| 3 | Confident | Receiver reads only the operator state file (projections live there), not autopilot internals | `enginefile.go` writes queue projections into the ledger; T3 will delete most autopilot PR code, so avoid depending on it | S:70 R:80 A:80 D:70 |
| 4 | Confident | Projection repo → nwo via `git remote get-url origin` parse | `scope.repo` is a local path; git is local and fast, gh is a network call | S:60 R:85 A:75 D:60 |
| 5 | Confident | A settings-stamp watcher in `rk serve` re-runs the ensure on edits | Same pattern as `WatchOpenAIMCPSettings`; otherwise a list edit needs a restart | S:55 R:85 A:80 D:65 |
| 6 | Confident | Doctor row name `pr hooks <nwo>`, single `pr hooks` row when off | Brief: "a `pr hooks` row per listed repo (off / …)" | S:70 R:90 A:80 D:70 |
| 7 | Confident | Setting is `ui: false`, so no frontend change and no recording | Plan Rule 6 makes T5 a no-recording step; a list editor UI is not in the brief | S:65 R:85 A:80 D:70 |
| 8 | Certain | Forwarder hook identification predicate: hook name `cli` + `config.url` `https://webhook-forwarder.github.com/hook` | Observed on a live hook created by the extension on an admin repo (T011) | S:90 R:70 A:90 D:85 |

8 assumptions (2 certain, 6 confident, 0 tentative).
