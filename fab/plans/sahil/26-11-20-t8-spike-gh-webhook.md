# Operator triggers — T8 spike findings (`gh webhook forward`)

> Findings of the spike inside step **T8** of `fab/plans/sahil/26-11-20-operator-triggers.md`, run
> 2026-11-20 on this host against `sahil87/hexokit`. Throwaway; no production code. **Result: blocked
> at hook creation** — the authenticated account is not a repo admin, so no event was forwarded and the
> event/latency questions are unanswered. Raw logs: `/tmp/claude-1000/-home-sahil-code-sahil87-hexokit-worktrees-quiet-starling/1acffab6-c69f-447b-934b-af55c3b4058d/scratchpad/t8/`.

## Environment

| Item | Value |
|---|---|
| `gh` | `2.103.3 (2026-10-26)` |
| Account | `sahil-noon` (only account in `gh auth status`), token `gho_…` (OAuth) |
| Token scopes | `admin:public_key`, `gist`, `read:org`, `repo` |
| Role on `sahil87/hexokit` | `write` (`permissions.admin: false`, `push: true`) — repo is owned by user `sahil87` |
| Extension | `cli/gh-webhook` **v0.2.0**, installed cleanly by `gh extension install cli/gh-webhook` |

## What was run

```sh
gh extension install cli/gh-webhook                       # ok -> v0.2.0
gh webhook forward --help                                 # help.log
python3 -I recv.py 48445 …/t8/received.jsonl              # receiver on 127.0.0.1:48445; self-test POST logged
gh api repos/sahil87/hexokit/hooks                        # hooks-before.json: HTTP 404
gh webhook forward --repo=sahil87/hexokit \
  --events=pull_request,pull_request_review,check_suite,check_run,workflow_run \
  --url=http://127.0.0.1:48445/hooks/github               # forward.log: exit 1 immediately
```

`forward.log`:

```
Error: error creating webhook: HTTP 404: Not Found (https://api.github.com/repos/sahil87/hexokit/hooks)
exit=1
```

## Why it failed

- `gh webhook forward` works by **creating a real repository hook** (`POST /repos/{nwo}/hooks`, the
  extension's `createHook`) and then reading deliveries over a websocket (`ws_url` in the create
  response). Creating a repo hook requires **admin on the repo**; GitHub answers a non-admin with 404.
- Scope is **not** the blocker: `gh`'s hint ("needs `admin:repo_hook`") is generic. The same token reads
  hooks on a repo the account owns (`GET repos/sahil-noon/conductor-playground/hooks` → `[]`,
  `scope-probe-owned-repo.json`), so `repo` scope covers hooks. The missing piece is the `admin` role
  (`perm.json`: `write`).
- Unblocking needs a user action outside the spike: run as the owner account (`sahil87`), or grant
  `sahil-noon` admin on the repo. Not attempted.

## Questions from the brief

| Question | Answer |
|---|---|
| Extension installs / subcommand exists | Yes — v0.2.0, `gh webhook forward` present |
| Auth / scope / admin | `repo` scope suffices; **repo admin role required** (org mode `--org` needs org admin) |
| Event names accepted | Not reached — hook creation fails before events are validated (validation is server-side at create) |
| Events received / latency | **None** — see table below |
| Persistent repo hook created? | Not created (create call failed). By design it creates one per run; cleanup on exit unverified |
| Several repos per process? | **No.** `-R, --repo string` is a single string flag; one process per repo (or one `--org` process per org, org admin) |
| Failure modes | Hard exit 1 on create failure (no retry). Binary contains `unable to connect to webhooks server, forwarding stopped` — forwarder exits on websocket loss, so it needs a supervisor/restart |

| Event | Action(s) planned | Sent? | Received? | Latency |
|---|---|---|---|---|
| `pull_request` | `opened`, `labeled`, `unlabeled`, `ready_for_review`, `converted_to_draft`, `closed` | No | No | — |
| `pull_request_review` | — | No | No | — |
| `check_suite` / `check_run` / `workflow_run` | push to probe branch | No | No | — |

Step 4 (throwaway branch + draft PR) was **skipped**: with no forwarder running it could produce no
evidence and would only have added GitHub writes to clean up.

## Cleanup

- No branch, file, PR, label or hook was created on GitHub. `git/matching-refs/heads/spike/t8` → `0`.
- Hooks on `sahil87/hexokit` cannot be listed by this account (`hooks-before.json`, `hooks-after.json`:
  both 404), but the only write attempted was the failed `POST …/hooks`.
- Receiver (PID 2699122) killed; forwarder exited on its own. No `recv.py`/`gh-webhook` process left.
- Local: `gh-webhook` extension remains installed (`gh extension remove webhook` to undo). Repo checkout
  untouched apart from this file.

## Recommendation for T8

Build T8 on the **per-PR watcher fallback**, not the webhook relay. The relay's hard requirement is
repo **admin** per tracked repo (one hook-creating process each, plus a supervisor because it exits on
websocket loss), and the account HexoKit actually runs as here has only `write` on its own main repo —
the common case for any tracked org repo too. The watcher needs only the read access the polling ladder
already uses. Shape: when a tracked item is a `github-pr` ledger item (or a queue projection with
`repo`/`pr`), the sibling session runs `gh pr checks <n> -R <nwo> --watch --interval 30` for it; when it
exits (checks finished, exit 0/1; or `--fail-fast` on first failure) it calls
`rk operator wake --reason pr:<nwo>#<n>:checks`. The mapping is fixed at spawn time (one watcher per
tracked `nwo#n`), so no payload → item mapping is needed; watchers are reaped when the item leaves the
ledger. Limits to state in the intake: `--watch` is itself polling (default 10 s; per-PR API cost), and
it covers **checks only** — merge, review and conflict changes stay on the 3→24 min ladder. Keep the
webhook relay as an opt-in follow-up for repos where the user is admin; before that, re-run this spike
as `sahil87` (or with admin granted) to answer the event table, latency and hook-cleanup questions.
