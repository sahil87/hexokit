Interim — the autopilot engine's `step` runs queues; `stacked-prs` merging and PR recovery stay here until their steps land, then R7 deletes this file.

Queues are plain `pane` items chained by `depends_on`. There is no queue state beyond the items:
skipping an entry is `rk operator track rm -L <server> <id>`, pausing unspawned entries is
`rk operator track pause -L <server> <id>`. Work a queue only when a changed item is in it or unblocks it.

### Running a queue

Run `rk operator autopilot step -L <server>` and act on its escalations: send `rk notify` for each
one. Never run the spawn/arm choreography by hand: no `git fetch`/`wt create`/cherry-pick for a
queue item, no `gh pr merge --auto`/`--disable-auto`, no hand-written `github-pr` chain.

One step is one idempotent pass and waits for nothing, so call it again on a later run. It persists
completions, decides readiness (`held` until every dependency is done, then `pending`), spawns every
`pending` item in its mode (`cherry-pick-ladder`, `stacked-prs`, `merge-auto`), advances the
`cherry-pick-ladder` and `merge-auto` merge sequences, respawns a dead pane once, and flags a stage
over 30 minutes or a queue over 2 hours. A cherry-pick conflict or a failed fetch is an escalation:
the item stays pending and is never skipped. If it prints `busy`, another pass is running on this
server: do nothing and retry on a later run. Escalation lines name the item and the reason.

### Merging

Queue PRs are created, not merged, unless the mode says otherwise. `merge-auto` PRs are armed and
merged by `step`; a completed `cherry-pick-ladder` queue is merged by `rk operator autopilot merge -L <server>`
only after the user says "merge all".

- `stacked-prs`: do not merge. Note that the queue is complete, list the PR links per repo with
  their dependency order, and notify the user. `rk operator autopilot merge -L <server>` refuses a
  `stacked-prs` queue, so a "merge all" on one is not run by the engine.

### PR recovery

`step` reports a shipped PR that cannot merge as an escalation `recovery needed: <ci-failed|conflicting> — PR #<n> (<repo>)`
and leaves the PR armed; it does nothing else. Act on it with the table below.

A shipped PR that cannot merge has one reason, and each reason gets one bounded action. Write
`scope.recovery` on the `github-pr` item **before** acting, so a later run can tell a recovered item
from a first sighting.

| Reason | Detected by | One action | Then |
|--------|-------------|-----------|------|
| `ci-failed` | `gh pr checks <n> --required --json name,state,link` has a `FAILURE` | `rk operator track update -L <server> pr-<n> --scope '{"recovery":"ci-fix","fix_head":"<headRefOid>"}'`, then send the authoring pane the fix request below (it stays armed). Pane gone: one recovery spawn with the same text | green: continue. Still red on a head other than `fix_head`, or 30 minutes with no push: halt, disarm, notify with the agent's one-line diagnosis |
| `conflicting` | `unchanged` ≥ 3 on the armed item, no failed check, `gh pr view <n> --json mergeable` is `CONFLICTING` | `rk operator track update -L <server> pr-<n> --scope '{"recovery":"rebase"}'`, then in the change's worktree `git fetch origin && git rebase origin/<default_branch> && git push --force-with-lease`, then `gh pr merge --auto --squash <n>` | `CONFLICTING` again with `recovery` already `rebase`, or the rebase conflicts (`git rebase --abort`): disarm, halt, notify naming the files |

The authoring pane is the one whose `change` (from `fab pane map --all-sessions`) equals the item's
`scope.change`. The fix request is the one sanctioned raw send into a fab-project agent, because it
amends a change that already finished the pipeline:

```
CI failed on PR #<n> (<repo>): check `<check name>` — run <run link>.
Diagnose and fix on this branch, push, and report the root cause in one line.
```

One recovery spawn per item per reason: `rk operator track add -L <server> <change>-fix --kind pane --pane … --repo … --branch <branch>`
with no `--change`, removed with `rk operator track rm -L <server> <change>-fix` when the round resolves.
For a merged PR with no non-pending review (`gh pr view <n> --json reviews`), say "unreviewed" in the
note.

A halted sequence (CI failure after recovery, conflict after recovery) disarms its armed PRs with
`gh pr merge --disable-auto <pr>` and is marked `rk operator track update -L <server> --force pr-<n> --scope '{"halted":true}'` (`halted` is autopilot's field, so a hand write needs `--force`);
it halts only that repo's sequence and the repos that depend on it across repos, and notifies with
the diagnosis.

### Failures and timing

Review exhausted: skip the item. Ship-stage rebase conflict: notify; in `merge-auto` the queue
continues, in the chained modes dependents stay held. `stacked-prs` rebase conflict: escalate, never
skip.
