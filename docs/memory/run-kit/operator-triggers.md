---
type: memory
description: "What wakes the operator loop: the triggers table (agent stop/question, PR event, user/note, clock backstop), the one-door rule (the cron/<slug>.wake marker), and the opportunistic PR hook — operator.pr_hooks, admin probe, the rk-gh-hooks session, the loopback receiver and its server mapping, the pr:<nwo>#<n>:<event> reason, the forwarder supervisor, `rk operator hooks stop`, doctor states."
---
# Operator Triggers

**Domain**: run-kit

## Overview

The operator loop runs on a clock ([cron](/run-kit/cron.md) § Operator Loop Entry) and is also woken early by triggers. Every trigger funnels through one door, the server's wake marker. The PR-event trigger is opportunistic: it saves the minutes between a PR event and the next scheduled check where the account can create a repository hook, and does nothing everywhere else.

## Triggers

| Trigger | Source | Arrives as |
|---|---|---|
| Agent stop / question | an agent pane going idle or waiting (the `wake_on` edge, [cron](/run-kit/cron.md)) | a loop fire from the wake edge |
| PR event | a forwarded GitHub delivery for a tracked PR (below) | `trigger:pr:<nwo>#<n>:<event>` |
| User / note | `rk operator wake`, `POST /api/operator/wake`, a chat note ([operator-state](/run-kit/operator-state.md)) | `trigger:<reason>` (default `manual`) |
| Clock backstop | the loop's `LoopLadder` schedule | a scheduled fire |

The clock picks up every change regardless of the other rows; a trigger only shortens the wait. No trigger is required for correctness. One trigger changes what the check reports: a `trigger:manual` fire reports an idle agent regardless of the idle floor (the active-sibling rule still holds), because Check now is the user asking to look now ([operator-state](/run-kit/operator-state.md) § Conditions).

## The One Door

Every explicit trigger writes the server's wake marker `cron/<slug>.wake` through `cron.WriteWakeMarker` — one line `<unix-ts> <reason>`, atomic, mode 0600, one pending marker per server with the newest reason winning. The next cron tick consumes it as one `trigger:<reason>` loop fire ([cron](/run-kit/cron.md) § Operator Loop Entry → Trigger marker). The door is edge-triggered and idempotent, so a spurious or duplicate trigger costs one free check. Writers never call the daemon over HTTP: the marker file survives daemon restarts and works with no daemon running.

## Opportunistic PR Hook

`operator.pr_hooks` ([configuration](/run-kit/configuration.md) § Settings Registry) lists `owner/name` repositories. The rule per listed repo:

- **Admin** (the account's `permissions.admin` is true) ⇒ a `gh webhook forward` forwarder runs for it.
- **Anything else** — no admin, probe failure, extension missing, daemon down ⇒ nothing is built for the repo and the clock picks its PR changes up.

An empty list (the default) turns the whole feature off: no session, no probe, one `pr hooks: off` doctor row.

**Admin probe.** `gh api repos/<nwo> --jq .permissions.admin` through `exec.CommandContext` with an argv slice and a 10 s timeout, classified `admin`, `no-admin`, or `probe-failed` (gh missing, unauthenticated, timed out, non-boolean output). Probe-failed is treated like no-admin for every decision and reported only in the doctor wording. The result is re-derived on every use, never persisted. Reconcile never tears down a working forwarder on a probe *failure* (a network blip), only on a definitive no-admin or an unlisted repo.

**Extension.** The forwarder is the `cli/gh-webhook` gh extension. rk never installs it; when it is absent no forwarder is spawned and doctor says `forwarder missing` with the hint `gh extension install cli/gh-webhook`.

### The `rk-gh-hooks` Session

A sibling tmux session on the rk-daemon socket, built by `internal/daemon/ghhooks.go` on the `rk-openai-mcp` pattern ([daemon-lifecycle](/run-kit/daemon-lifecycle.md)), so it outlives `rk serve` restarts.

| Window | Runs |
|---|---|
| `receiver` | `rk operator hooks serve --port 21900` |
| `fwd-<owner>--<name>` (one per admin repo; `.` → `_`) | `rk operator hooks forward --repo <nwo> --port 21900` |

The ensure reconciles to the setting: empty list ⇒ kill a stale session; otherwise probe every repo (concurrently), ensure the receiver, ensure one forwarder window per admin repo, remove forwarder windows of unlisted or definitively non-admin repos, replace dead windows. With no admin repo, or the extension missing and no forwarder already running, no session is built (a stale one is killed). It is daemon-gated (no tmux command without a running daemon) and never fails serve-start; failures are logged and surface through doctor.

### The Receiver

`rk operator hooks serve` (hidden) binds `127.0.0.1` only, port `PORTPOLICY_GH_HOOKS` (21900), and serves only `POST /hooks/github` (other methods 405, other paths 404). Loopback is the trust boundary; an unauthenticated local POST costs at worst one spurious trigger.

- **Events.** `X-GitHub-Event` selects the extraction: `pull_request` / `pull_request_review` → `pull_request.number` + `pull_request.head.ref`; `check_suite` → `check_suite.pull_requests[].number` + `head_branch`; `workflow_run` → `workflow_run.pull_requests[].number` + `head_branch`; the repository is `repository.full_name`. Any other event is ignored.
- **Body.** Capped at 5 MiB (over ⇒ 413). A well-formed delivery is answered 2xx (202) immediately; malformed bodies, unknown events, no PR identity, and mapping errors all end without a marker and never a 5xx, so the forwarder never retries.
- **No payload is stored** — not on disk, and logs carry only the event name and `nwo#n`.
- **Server mapping.** For every live tmux server, the receiver loads that server's operator ledger (tolerant read) and matches when a tracked item is (a) a `github-pr` item pinned by its probe argv `--repo` to the event's repo whose `scope.pr` is among the event's PRs or whose `scope.branch` is the event's head branch, or (b) an item carrying a local checkout path in `scope.repo` whose branch (`branch_map[scope.change]`, else `scope.branch`) equals the event's head branch and whose checkout's `origin` remote resolves (https and ssh forms) to the event's repo. Queue items are case (b): their projections in the ledger carry a local path and no `scope.queue`, so the match is by local path + branch + git-origin nwo. Done items match too. Dead servers and untracked PRs get no marker.
- **The door call.** Per matching server, once per delivery: `cron.WriteWakeMarker(<cron dir>, <server>, "pr:<nwo>#<n>:<event>", now)` — `<n>` the matched PR number (the branch when matched by branch alone) — truncated to 120 runes.

### The Forwarder Supervisor

`rk operator hooks forward --repo <nwo>` (hidden) is a Go supervisor over `gh webhook forward --repo <nwo> --events pull_request,pull_request_review,check_suite,workflow_run --url http://127.0.0.1:21900/hooks/github`, run via `exec.CommandContext` with no shell.

- **Backoff.** The forwarder exits when its relay websocket drops and at once when hook creation fails, so it restarts after 5 s, doubling to a 5 min cap; a run of 10 min or more resets the wait to 5 s. The schedule is a pure function under test.
- **Process group.** The child runs in its own process group and a stop signal SIGTERMs the group: `gh` does not pass signals to the extension, and the extension removes its repository hook only on its own SIGTERM. Ten seconds of grace precede the kill.
- **One forwarder per repo.** A second forwarder on a repo that already has a forwarder hook fails with HTTP 422 `Hook already exists`. A crashed supervisor that orphaned its extension therefore blocks restarts until the orphan or its hook is removed; the supervisor keeps retrying with backoff and never sweeps hooks itself, so it cannot delete a forwarder a user started by hand.
- **Events** are the four above; `check_run` is deliberately absent. The hook-create call accepts all four.

### Hook Identity and `rk operator hooks stop`

A hook the extension creates is named `cli` with `config.url` `https://webhook-forwarder.github.com/hook` (the GitHub relay, not the local `--url`), `config.content_type: json`, `type: Repository`. `ghhooks.IsForwarderHook` is the one predicate keyed on name + relay URL.

`rk operator hooks stop [--json]` (visible) kills the `rk-gh-hooks` session (exact-match target; absent is success) and, for each listed repo whose probe says admin, lists `gh api repos/<nwo>/hooks` (paginated) and deletes only hooks matching the predicate via `gh api -X DELETE repos/<nwo>/hooks/<id>`. A repo whose probe failed is reported and makes the stop incomplete (exit 1): unknown is not "no admin", since a hook may be left behind. It never touches any other hook. It is a cleanup, not a switch: the session returns at the next serve-start or settings edit unless `operator.pr_hooks` is emptied. Exit codes 0 ok, 1 operational, 2 usage; `--json` emits the standard envelope around `{session_killed, repos: [{repo, admin, removed, error?}]}`.

### Doctor States

`rk doctor` appends one `pr hooks <nwo>` row per listed repo (a single `pr hooks` row when the list is empty). Rows are always OK-shaped and never flip the verdict, like the `gui` and `openai-mcp` rows; the probes and tmux reads are bounded by a 15 s timeout.

| Note | When |
|---|---|
| `off` | `operator.pr_hooks` empty |
| `running` | admin, daemon up, the `receiver` window and the repo's forwarder window alive |
| `polled — no admin` | probe says no admin; a failed probe reads `polled — no admin (probe failed: <err>)` |
| `forwarder missing` | admin, but the extension is absent (install hint), the daemon is down (`rk serve -d`), or a window is missing or dead |

## Requirements

### Requirement: The PR hook is never required
The operator MUST work identically, merely slower to notice PR changes, with `operator.pr_hooks` empty, a repo without admin, the extension absent, or the daemon down. No failure of the hook machinery SHALL fail daemon start, serve, or the operator loop.

#### Scenario: Non-admin repo
- **GIVEN** `operator.pr_hooks: ["b/noadmin"]` and a probe answering `false`
- **WHEN** the daemon ensures the session and `rk doctor` runs
- **THEN** no tmux window or process exists for the repo and the row reads `polled — no admin`

### Requirement: Only tracked PRs trigger
The receiver MUST write a wake marker only for live servers whose ledger tracks the event's PR, once per delivery per server.

#### Scenario: Tracked and untracked PRs
- **GIVEN** server `work` tracks github-pr `pr-12` for `o/r#12` and server `play` tracks nothing
- **WHEN** a `pull_request` delivery for `o/r#12` arrives
- **THEN** `cron/work.wake` reads `<ts> pr:o/r#12:pull_request` and no `play.wake` exists
- **AND** a delivery for `o/r#99` writes no marker anywhere

## Design Decisions

### Opportunistic, never required
**Decision**: Build a forwarder only where `permissions.admin` is true; elsewhere build nothing and report `polled — no admin`.
**Why**: `gh webhook forward` creates a real repository hook, which needs admin; the account usually has only write. The hook saves minutes, and the clock covers every change anyway, so a missing permission is a state, not a defect.
**Rejected**: a per-PR `gh pr checks --watch` watcher — per-PR API polling that covers only checks; a required watcher turns every non-admin repo into a failing feature.
*Introduced by*: 261120-xdig-operator-pr-trigger-hooks

### The receiver writes the marker, not the daemon
**Decision**: `rk operator hooks serve` calls `cron.WriteWakeMarker` directly for each matched server.
**Why**: The door is the marker file — it survives daemon restarts and has no HTTP dependency, and the receiver runs on the box with the same state home.
**Rejected**: POSTing `/api/operator/wake` — adds an HTTP dependency the door is designed without.
*Introduced by*: 261120-xdig-operator-pr-trigger-hooks

### Fixed port-policy receiver port
**Decision**: The receiver listens on `PORTPOLICY_GH_HOOKS=21900`, one fixed port from the policy file.
**Why**: One daemon per box means one receiver; the policy file is the single source of truth for reserved ports and its collision check covers the port.
**Rejected**: `daemon port + 3` — the e2e rig block is contiguous triples, so +3 lands on the next rig's Vite port.
*Introduced by*: 261120-xdig-operator-pr-trigger-hooks

### Go supervisor, in its own process group
**Decision**: A hidden `rk operator hooks forward` verb supervises `gh webhook forward` with capped exponential backoff and SIGTERMs the child's process group on stop.
**Why**: The forwarder exits on relay loss and on create failure; the shell-string loop alternative is forbidden by Constitution I; and only the extension process, not `gh`, removes the hook on SIGTERM, so a group signal is what keeps hooks from leaking.
**Rejected**: a shell `while true` loop in the tmux window; a per-repo tmux respawn hook; signalling `gh` alone (orphans the extension and its hook).
*Introduced by*: 261120-xdig-operator-pr-trigger-hooks

### Projections matched by local path, branch and origin
**Decision**: A ledger item matches a PR event by its local `scope.repo` path + branch + the checkout's git-origin nwo, not by `scope.queue`.
**Why**: Queue items live in a separate engine file; the operator ledger holds only a projection whose `scope.repo` is a local path and which drops `scope.queue`. Reading the ledger alone keeps the receiver free of the autopilot package.
**Rejected**: importing `internal/autopilot` to read queues; resolving the nwo through `gh` (a network call where `git remote get-url origin` is local and fast).
*Introduced by*: 261120-xdig-operator-pr-trigger-hooks

### Settings watcher gated off dev builds
**Decision**: `rk serve` starts the `operator.pr_hooks` settings watcher only when `version != "dev"`.
**Why**: The watcher's ensure acts on the rk-daemon tmux socket, which a dev rig or e2e rig shares with the box's live daemon; a rig's empty `pr_hooks` would otherwise kill the live `rk-gh-hooks` session and the repo hooks it holds.
**Rejected**: running the watcher everywhere and relying on a per-rig `RK_CONFIG_DIR` — it protects the setting, not the shared socket.
*Introduced by*: 261120-xdig-operator-pr-trigger-hooks

### Identify forwarder hooks by name and relay URL
**Decision**: `stop` deletes only hooks named `cli` whose `config.url` is `https://webhook-forwarder.github.com/hook`.
**Why**: That is the shape observed on a live hook the extension created; any other hook (CI, deploys, chat) must never be touched.
**Rejected**: matching the local `--url` (the extension registers the relay URL instead); deleting every hook on a listed repo.
*Introduced by*: 261120-xdig-operator-pr-trigger-hooks
