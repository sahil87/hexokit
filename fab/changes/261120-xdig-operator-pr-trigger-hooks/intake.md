# Intake: Operator PR Trigger Hooks (opportunistic)

**Change**: 261120-xdig-operator-pr-trigger-hooks
**Created**: 2026-11-20

## Origin

> Execute step T5 (PR trigger, opportunistic: `operator.pr_hooks`, admin probe, `rk-gh-hooks` sibling session + receiver, doctor rows) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first (Decisions and Rules bind you), then implement only the T5 Brief.

One-shot `/fab-new` from the plan's execution queue. The plan (`fab/plans/sahil/26-11-20-operator-triggers.md`, copy also in this worktree) is the binding source: its **Decisions already taken** table and **Rules for the operator executing this plan** are not to be reopened here. The spike that informs this step is `fab/plans/sahil/26-11-20-t8-spike-gh-webhook.md`.

This change is stacked on step **T2** (`261120-pgns-operator-trigger-door-failure-streaks`, base branch set accordingly): T2 built the trigger door this step calls — `rk operator wake`, the `cron/<slug>.wake` marker (`internal/cron/wake_marker.go`: `WriteWakeMarker`, `NormalizeWakeReason`, `MaxWakeReasonRunes = 120`), and the tick that consumes it as a `trigger:<reason>` loop fire.

## Why

The operator loop learns about a PR change only on its next scheduled check — the `LoopLadder` climbs 3 → 24 min on quiet servers, so a PR that goes green, gets a review, or merges can sit unnoticed for up to ~24 minutes before the operator acts on it. After T3 (PR work back to the AI) and T4 (merging rules in the brief), the operator *run* is what merges, restacks and fixes PRs, so that latency is now directly the latency of PR work.

A GitHub webhook removes that wait: a PR event becomes a trigger through the T2 door within seconds. But the plan's decision is explicit that this is **opportunistic**:

- `gh webhook forward` (the `cli/gh-webhook` extension, v0.2.0 on gh 2.103) works by **creating a real repository hook**, which requires **repo admin**. The spike's account (`sahil-noon`) has only `write` on `sahil87/hexokit`, so the common case is "no hook possible".
- The hook only saves the minutes between the event and the next scheduled check; the clock still picks every change up. It is **never required for correctness**, so a missing permission is a doctor row, not a failure and not a feature to build around.
- The spike's fallback recommendation (a per-PR `gh pr checks --watch` watcher) was **rejected by the plan** ("No per-PR watcher") — it is per-PR API polling that only covers checks.

If we do nothing, PR work keeps its ~minutes-scale latency; nothing breaks. If we build a required watcher instead, every non-admin repo becomes a failing feature. Hence: add the hook where the account can, do nothing (and say so) where it cannot.

## What Changes

### 1. Setting `operator.pr_hooks`

A new settings-registry key (`internal/settings/settings.go`), kind `list` (the existing list kind, `listSection` string-list serialization), default empty = **off**.

```yaml
operator:
  pr_hooks:
    - "sahil87/hexokit"
    - "sahil-noon/conductor-playground"
```

- Each entry is an `owner/name` GitHub repository; validated with the same shape as `operator.NewGitHubPRItem`'s `githubRepoName` regex (`^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$`) — reuse, don't duplicate. Invalid entries are rejected at write time; duplicates collapse.
- Empty list (the default) means the whole feature is off: no session, no probe, one `pr hooks: off` doctor row.
- Constitution VII: nothing required; the key works by default.

### 2. Admin probe

For each listed repo: `gh api repos/<nwo> --jq .permissions.admin` via `exec.CommandContext` with an explicit argv and a timeout (~10 s, Constitution I / § Process Execution). Result is one of: `admin` (true), `no admin` (false), or `probe failed` (gh error/timeout/unauthenticated — treated like no admin for spawn purposes, never an error that propagates).

The probe runs at **serve-start** (inside the best-effort ensure, below) and in **`rk doctor`**. Probe results are not persisted (re-derived each time — Constitution II; `gh` is a durable source).

### 3. The `rk-gh-hooks` sibling session (the `rk-openai-mcp` pattern)

Modelled on `internal/daemon/openaimcp.go`: a sibling tmux session on the rk-daemon socket that outlives `rk serve` restarts (Constitution VI), with package seams (`sessionExists`, `spawn`, `kill`, `lookPath`, …) so tests drive every branch without a live tmux server or network.

- Session name constant: `rk-gh-hooks`.
- Window `receiver`: runs `rk operator hooks serve` (hidden verb, §4).
- One window per **admin** repo (window name derived from the nwo, sanitized for tmux): runs a supervised forwarder (hidden verb `rk operator hooks forward --repo <nwo>`), which loops `gh webhook forward --repo <nwo> --events pull_request,pull_request_review,check_suite,workflow_run --url http://127.0.0.1:<port>/hooks/github` via `exec.CommandContext` and **restarts it on exit with backoff** (start 5 s, doubling, cap 5 min; reset to the floor after a run that lasted ≥ 10 min). The supervisor is Go, not a shell loop (no shell strings — Constitution I). The spike showed the forwarder exits on a dropped relay websocket ("unable to connect to webhooks server, forwarding stopped") and exits 1 immediately on a hook-create failure, so both must be survivable without spinning.
- `--events`: the four names above; **drop any name the extension rejects** (event validation is server-side at hook create — verify on an admin repo during apply; the spike never reached it). `check_run` is deliberately not in the list.
- Ensure is **daemon-gated and best-effort**, called from serve-start next to `ensureOpenAIMCP()` (`internal/daemon/daemon.go`): setting empty ⇒ kill a stale `rk-gh-hooks` session if present and return; otherwise probe each repo, ensure the receiver window, ensure a forwarder window per admin repo, remove forwarder windows for repos no longer listed or no longer admin. **Never fails serve-start**; errors are logged (slog) and surfaced via doctor.
- When the `gh-webhook` extension is not installed (`gh webhook forward --help` fails / `gh extension list` lacks `cli/gh-webhook`), no forwarder window is spawned and doctor says `forwarder missing` with the install hint `gh extension install cli/gh-webhook`. rk does **not** install the extension itself (an outward-facing action on the user's gh config).
- Non-admin repo: **nothing is built** for it — no window, no process. Doctor says `polled — no admin`.

### 4. The receiver: `rk operator hooks serve` (hidden)

- Binds **127.0.0.1** only, on the receiver port (§6), path `POST /hooks/github`. No other routes. Loopback-only is the trust boundary; an unauthenticated local POST can at worst cause one spurious trigger, which costs one free check (the door is edge-triggered and idempotent — plan § Decisions "Vocabulary").
- Reads `X-GitHub-Event` and the JSON payload with a body-size cap; extracts the repository `full_name` and the PR identity:
  - `pull_request`, `pull_request_review` → `pull_request.number` (and `pull_request.head.ref`)
  - `check_suite` → `check_suite.pull_requests[].number` and `check_suite.head_branch`
  - `workflow_run` → `workflow_run.pull_requests[].number` and `workflow_run.head_branch`
  - any other event → ignored
- **Mapping**: for every **live** tmux server (`tmux.ListServers`), read that server's operator state (tolerant read, `internal/operator`) and the autopilot engine projections; a server matches when it holds a `github-pr` ledger item, or a queue projection, whose repo equals the payload repo AND (pr number matches OR head branch matches). Repo for an item comes from its scope / probe `--repo` argv / PR URL — whichever the item carries.
- For each matching server, call the door: `cron.WriteWakeMarker(dir, slug, "pr:<nwo>#<n>:<event>", now)` — e.g. `pr:sahil87/hexokit#1162:check_suite`. **Once per event per server** (one delivery with several PR numbers matching the same server still writes one marker; newest reason wins per T2's one-pending-marker semantics). A reason longer than `MaxWakeReasonRunes` is truncated rather than rejected.
- **Unknown PRs are ignored** (no marker, 2xx response). Dead servers get no marker.
- **No payload content is stored** — not on disk, not in logs beyond event name + nwo#n.
- Responds 2xx quickly so the forwarder never retries; mapping errors are logged, not returned as 5xx.

### 5. `rk operator hooks stop`

User-facing verb: kills the `rk-gh-hooks` session and removes **only the hooks this feature created**, per listed admin repo: `gh api repos/<nwo>/hooks`, delete (`gh api -X DELETE repos/<nwo>/hooks/<id>`) only hooks identified by the forwarder's URL (the relay/forward URL the extension registers). Must never touch any other hook. Whether the extension already deletes its hook on clean exit is unverified (spike) — verify during apply; `stop` is the explicit cleanup either way.
<!-- assumed: hook identification by the extension's registered config.url / name pattern — exact shape to be verified on an admin repo at apply -->

### 6. Receiver port (open decision T5, resolved here)

A new constant in the port policy (`app/backend/internal/portpolicy/ports.env`, the one source of truth, `//go:embed`'d by `internal/portpolicy`): `PORTPOLICY_GH_HOOKS`, a single port in the machine-only 5-digit range that collides with no reserved block — outside the rig block 21000–21299, outside the rule-P tunnel target 21500–21599, and not the sentinel 21999 (proposal: **21900**). Added to `parse`'s required keys, to `Reserved()`/`Collisions()` coverage so a daemon/code-server port pinned onto it is flagged, and to `portpolicy_test.go`. Rejected: deriving from the daemon port (`daemon+3`) — the rig block is laid out as contiguous triples, so `+3` lands on the next rig's Vite port. The daemon is one per box, so one fixed receiver port suffices; e2e rigs run with a per-rig `RK_CONFIG_DIR` whose `pr_hooks` is empty, so they never bind it.

### 7. `rk doctor` rows

A `pr hooks` row **per listed repo** (or one `pr hooks: off` row when the list is empty). States:

| State | When |
|---|---|
| `off` | `operator.pr_hooks` empty |
| `running` | admin, receiver window live, forwarder window live |
| `polled — no admin` | probe says admin false (or probe failed — detail text says so) |
| `forwarder missing` | admin, but no live forwarder window (extension absent, session down, window dead) — detail carries the hint |

Always **OK-shaped** (never flips `report.OK`), matching the `gui`/`openai-mcp` doctor posture — a missing permission is a state, not a defect.

### 8. CLI surface, docs, tests (plan Rule 5)

- New `rk operator hooks` group: `stop` (visible), `serve` and `forward` (hidden). Help text, the `rk skill operator` topic (`docs/site/skill/operator.md` synced to `cmd/rk/skill/operator.md`) if it mentions triggers, and the `rk help-dump` fixtures updated in the same change.
- Tests (from the brief): receiver mapping (github-pr item match, queue projection match by pr and by head branch); door called **once per event** per matching server; **nothing** on an untracked PR; **non-admin repo yields no process and a doctor row**. Plus: setting validation, port-policy parse/collision, supervisor backoff schedule, ensure reconcile (add/remove windows), dead-server skip.
- PR evidence: `No recording: internal CLI/daemon behavior` (plan Rule 6) with validation listed.
- Live verification (brief): verify the event list and hook cleanup on a repo the account administers — the spike found `sahil-noon` owns `sahil-noon/conductor-playground` (hooks readable there), so it is the candidate. If no admin repo is usable, ship the probe-and-skip path with the forwarder flags as written and leave a note on the tracking item.

### Non-goals

- **Review bar** (plan § Decisions, verbatim): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.
- No per-PR `gh pr checks --watch` watcher (plan decision; overrides the spike's recommendation).
- No `--org` mode, no webhook secret handling, no public endpoint, no HTTP dependency for the door (the receiver writes the marker file directly, never calls the daemon).
- No changes to the queue engine, the check, or the tick beyond consuming the existing marker; no Activity UI (T6).
- No auto-install of `cli/gh-webhook`.
- No daemon restart or binary install (plan Rule 1 — R1 does that).

## Affected Memory

- `run-kit/operator-triggers`: (new) the triggers table (agent stop/question, PR event, user/note, clock backstop), the one-door rule, the opportunistic PR-hook rule, `rk-gh-hooks` + receiver mapping + reason format, doctor states
- `run-kit/configuration`: (modify) `operator.pr_hooks` key; `PORTPOLICY_GH_HOOKS` in the ports.env policy
- `run-kit/daemon-lifecycle`: (modify) the `rk-gh-hooks` sibling session, its serve-start ensure (best-effort, never fails start)
- `run-kit/toolkit-standards`: (modify) new `rk operator hooks` surface in the help-dump / P9 new-surface check

## Impact

- `app/backend/internal/settings/settings.go` (+ api settings plumbing if lists need it) — new key.
- `app/backend/internal/portpolicy/{ports.env,portpolicy.go,portpolicy_test.go}` — new constant; also `scripts/e2e-env.sh` sources ports.env (no change expected, but parse must stay compatible).
- `app/backend/internal/daemon/` — new `ghhooks.go` (+ test) mirroring `openaimcp.go`; `daemon.go` serve-start call.
- New receiver/mapping package or file (e.g. `internal/operator/hooks*.go` or `internal/ghhooks/`) — reads operator state + engine projections, writes via `internal/cron` marker.
- `app/backend/cmd/rk/` — `operator_hooks.go` (+ test), `doctor.go` rows, help-dump fixtures, `skill/operator.md` sync.
- External: `gh` + the `cli/gh-webhook` extension (runtime only, optional).

## Open Questions

- Exact event names the extension accepts and whether it removes its hook on clean exit — to be verified on an admin repo during apply (see §8); the design tolerates either answer.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Opportunistic rule: add hook only where `permissions.admin` is true; otherwise do nothing and say `polled — no admin`; never fail serve-start | Plan § Decisions "PR trigger" and T5 Brief, verbatim | S:95 R:85 A:95 D:95 |
| 2 | Certain | No per-PR `gh pr checks --watch` watcher, despite the spike's recommendation | Plan decision overrides the spike explicitly | S:95 R:80 A:95 D:95 |
| 3 | Certain | `operator.pr_hooks` is a list of `owner/name`, default empty = off | T5 Brief | S:95 R:85 A:90 D:90 |
| 4 | Certain | Sibling session `rk-gh-hooks` following the `rk-openai-mcp` pattern; receiver `rk operator hooks serve` hidden, 127.0.0.1 | T5 Brief; `internal/daemon/openaimcp.go` is the pattern | S:90 R:75 A:90 D:90 |
| 5 | Certain | Events `pull_request,pull_request_review,check_suite,workflow_run`, dropping any the extension rejects | T5 Brief verbatim | S:95 R:85 A:85 D:90 |
| 6 | Certain | Receiver calls the T2 door per matching live server with reason `pr:<nwo>#<n>:<event>`, once per event; unknown PRs ignored; no payload stored | T5 Brief; T2's `cron.WriteWakeMarker` is the door | S:95 R:80 A:90 D:90 |
| 7 | Certain | Doctor `pr hooks` row per listed repo with states off / running / polled — no admin / forwarder missing; `stop` removes only hooks it created | T5 Brief | S:90 R:85 A:85 D:85 |
| 8 | Certain | Base branch is T2's `261120-pgns-operator-trigger-door-failure-streaks` | User instruction | S:100 R:90 A:100 D:100 |
| 9 | Confident | Receiver port = new fixed port-policy constant `PORTPOLICY_GH_HOOKS` (proposed 21900), not a daemon-port offset | Plan open decision T5 says "port policy block"; `daemon+3` collides with the next rig triple's Vite port; one daemon per box | S:60 R:75 A:70 D:55 |
| 10 | Confident | Forwarder supervision is a hidden Go verb (`rk operator hooks forward`) with 5 s→5 min doubling backoff, reset after a ≥10 min run | Brief says "supervisor restarts … with backoff"; Constitution I rules out a shell loop; values are reasonable defaults | S:65 R:80 A:75 D:60 |
| 11 | Certain | Doctor rows are OK-shaped (never flip the verdict) | Matches gui/openai-mcp doctor posture; brief frames no-admin as a state | S:70 R:90 A:85 D:75 |
| 12 | Confident | Probe failure (gh error/timeout) is treated as no admin for spawn and reported in the doctor detail, not as a fifth state | Brief fixes four states; failing closed is safe because the clock covers it | S:55 R:85 A:75 D:60 |
| 13 | Confident | rk does not auto-install `cli/gh-webhook`; doctor `forwarder missing` carries the install hint | Brief is silent; installing alters the user's gh setup (outward action) | S:40 R:80 A:55 D:50 |
| 14 | Tentative | `stop` identifies its hooks by the extension's registered config URL/name pattern, verified on an admin repo at apply | Brief says "identified by the forward URL"; the spike never saw a created hook, so the exact shape is unverified | S:50 R:55 A:45 D:45 |
| 15 | Confident | Live verification on `sahil-noon/conductor-playground` (owned ⇒ admin); if unusable, ship probe-and-skip and leave a note | Brief's fallback instruction; spike shows the account owns that repo | S:70 R:85 A:70 D:70 |

15 assumptions (9 certain, 5 confident, 1 tentative, 0 unresolved).
