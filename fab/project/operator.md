# HexoKit — Operator Addendum

For operators coordinating lane agents in this repo; `/fab-operator` loads it at startup when present. **Lane brief** is forwarded word for word to each lane's agent; **Operator duties** stay with the operator. The rules themselves live in the constitution and `context.md` — this file is the procedure, and each section names its source so it can be pruned when the source changes.

## Lane brief

### L1. Rig safety

*Source: Constitution § PR Evidence (throwaway rig), `context.md` § Testing. The operator runs on the live HexoKit — breaking it breaks the operator.*

- In a fresh worktree, run `just setup` before any test or demo. Never borrow `node_modules` or browsers from a sibling worktree.
- Run tests and recordings only through `just` (`test-backend`, `test-frontend`, `test-e2e`, `pw`, `demo`). Never `npx playwright`, `go test` or `pnpm test` directly.
- Never touch the live daemon or the user's tmux server: no `rk serve`, no `rk serve --restart`, no `RK_PORT`.
- e2e runs are throttled across worktrees. "e2e throttle: all slots busy" is a wait, not a hang — don't kill it.

### L2. Evidence — which recording?

*Source: Constitution § PR Evidence, `context.md` § Testing (`just demo`).*

| The diff…                                                                 | Record                                                                                   |
|---------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| changes anything visible in the web UI                                    | `just demo <name> --before` (desktop + mobile), spec in `app/frontend/tests/demo/`       |
| touches `app/desktop/src/` or a shell-only SPA path (`runkitShell`, native web tile, popout) | the same command with a spec in `app/desktop/tests/demo/` (shell lane)  |
| behaves differently in the browser and the shell                          | both specs under one `<name>` — one command records both lanes                           |
| changes shared agent delivery                                             | every supported agent (see `agent-injection-matrix.demo.ts`)                             |
| has nothing observable in the UI or shell                                 | nothing — write `No recording: <reason>` and how you validated instead                   |

- Reuse an existing demo spec when one covers the workflow; otherwise add one.
- For a bug fix: **before** shows the reproduction on the base, **after** shows the fix, same steps.
- Record only real behaviour. If a bug can't be seen on screen, say so in the PR body instead of staging it.
- Paste the Markdown block `demo.sh` prints into the PR body and run its `gh pr edit --attach …` line. Never commit recordings.

### L3. CI to green

*Source: `.github/workflows/ci.yml` runs every job on every PR push — there is no label to add. User rule: nothing fails on main; fix it as soon as it shows up.*

1. Watch the checks on the current head: `gh pr checks <n> --watch`.
2. On failure, read `gh run view <run> --log-failed`; for e2e, download the `playwright-report-shard-*` artifact.
3. Fix the root cause on the branch, with a test where it applies. Push and watch again.
4. Never retry a flaky test to get green and never raise retries — a flaky test is a bug; make it deterministic.
5. There is no "pre-existing failure" exemption. If the failure also happens on `main`, fix it anyway, in its own `fix:` commit, and tell the operator at once so other lanes don't fix it too.
6. Anything pushed after a green run needs a fresh green run on the new head.
7. Rebase conflicts in generated docs (`docs/memory/**/index.md`, `docs/memory/**/log.md`) — take either side, then run `fab docs-index` to regenerate. Never hand-merge them.

### L4. Ready and review

1. Mark the PR ready: `gh pr ready <n>`.
2. Once CI is green, run `/git-pr-review` for any review comments; each fix goes back through L3.
3. Send the final report (L5).

### L5. Reports

- As soon as the draft PR opens, report its number.
- Final report, one line, exactly this shape:

  `PR #<n> · head <sha7> · CI green|red(<job>) · evidence attached|exempt(<reason>) · open threads <k>`

- If SSH push fails, push over HTTPS with `gh` credentials.

## Operator duties

- **Spawning**: e2e slots default to 2 per machine. More lanes than that in their test phase just queue — stagger spawns rather than piling on.
- **Red on main**: when a lane reports a failure that also happens on `main`, assign the fix to exactly one lane (or spawn a dedicated one) and tell the others to rebase once it merges.
- **Notes**: write each lane's L5 final report as a note on its tracked item. That note is the evidence ledger — don't keep a separate list.
- **After merge**: move the lane's tab (tmux window) to the `completed` group (tmux session), creating the group if it doesn't exist:

  ```sh
  tmux has-session -t '=completed' 2>/dev/null || tmux new-session -d -s completed
  tmux move-window -d -s <pane-id> -t '=completed:'
  ```

  Keep the quotes: zsh would otherwise expand `=completed` as a command path.

  Tracking follows the pane ID, so the move doesn't disturb the tracked item.
- **After merge**: never restart or redeploy the live daemon unless the user asks.
