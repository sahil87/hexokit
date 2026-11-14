Interim — replaced by the R6 autopilot engine; R7 deletes this file.

Queues are plain `pane` items chained by `depends_on`. There is no queue state beyond the items:
skipping an entry is `rk operator track rm -L <server> <id>`, pausing unspawned entries is
`rk operator track pause -L <server> <id>`. Work a queue only when a changed item is in it or unblocks it.

### Items and readiness

- An item with no `scope.pane` is **unspawned**. It is `held` while any `depends_on` item is not
  done, and `pending` once they all are. Spawn `pending` queue items; leave `held` ones.
- **Done** means the item's `done_at` is set or its `done_when` holds. For a pane item with a fab
  change that is `.status.yaml` showing `ship` done, or the item's `stop_stage` reached.
- A same-repo dependency with no `stop_stage` is satisfied only when it is done **and** its PR
  exists (`gh pr view <dep-branch> --json url` succeeds). Tracking, a `branch_map` entry, or a
  minted branch is not satisfaction.
- Cross-repo dependencies are ordering-only barriers: wait for the dependency to be done, then
  spawn. No code moves across repos, so never use one for a code-level dependency.
- Mode = the item's stored `scope.merge_mode`; null means `cherry-pick-ladder`. A run never
  resolves config.

### Spawning a queue item

Target the item's `scope.repo`, never the operator's own repo. Two axes pick what rides the tab:
does the repo have `fab/` (`test -d <repo>/fab`), and was a task given.

| | task given | no task |
|---|---|---|
| `fab/` present | `/fab-fff <change>` for an existing change (`scope.change`); `/fab-new <text>` for raw text | bare agent |
| no `fab/` | plain agent: the raw task, then "Commit on this branch, push, and open a draft PR against the default branch." | bare agent |

Never `fab init`. Never send raw implementation instructions to a fab-project agent.

1. **Fetch first, pin the base.** In the repo's main-worktree root:

   ```sh
   git fetch origin || exit 1     # a failed fetch stops the spawn; leave the item pending
   default_branch=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
   { [ -n "$default_branch" ] && git rev-parse --verify -q "refs/remotes/origin/$default_branch" >/dev/null; } \
     || default_branch=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null)
   [ -n "$default_branch" ] || default_branch=$(git rev-parse --verify -q origin/main >/dev/null && echo main || echo master)
   base_sha=$(git rev-parse "origin/${default_branch}")
   wt create --non-interactive --name <name> --base "$base_sha" [<change-folder-name>]
   ```

   Pass the **SHA**, never the ref name: a remote-tracking start-point sets upstream tracking on
   the new branch. `--checkout <branch>` (an existing branch, or a `stacked-prs` dependent off its
   dependency's branch) takes no `--base`. No fab change and no branch argument: wt puts the
   worktree on a new branch of the same name.
2. **Dependency code**, by mode, for same-repo dependencies (after the readiness rules above):
   - `cherry-pick-ladder`: in the new worktree, for each dependency branch not already an ancestor
     of `HEAD` (`git merge-base --is-ancestor <dep-branch> HEAD`; first drop a dependency whose
     branch is an ancestor of another dependency's branch), run
     `git cherry-pick --no-commit origin/<default_branch>..<dep-branch> && git commit -m "operator: cherry-pick <dep> dependency"`.
     On conflict: `git cherry-pick --abort`, note, notify, do not spawn.
   - `stacked-prs`: branch off the dependency's branch (`wt create --checkout <dep-branch>`), and for
     a fab change record it with `fab status set-base-branch <change> <dep-branch>` in the
     worktree so the PR targets the dependency's branch.
   - `merge-auto`: no chaining. Each change is based on `origin/<default_branch>` independently.
   A dependency branch comes from the dependency item's `scope.branch`, else `branch_map[<id>]`;
   when neither exists, note, notify, and do not spawn.
3. **Session command.** `fab agent default -o yaml --repo <repo>` when fab is present; read
   `command` and `skill_prefix` from it. Use the target repo's command, never your own.
4. **Open the tab**, session command and prompt as argv tokens after `--` (a bare agent passes no
   prompt token):

   ```sh
   rk tab new -L <server> --cwd <worktree> --name <wt> --ready --json -- <session-command-argv…> ["<prompt>"]
   ```

   Read `pane_id` and `session` from the JSON result. `ready:` of `parked` or `narrow` means a wall
   to answer on a later run; `gone` gets one bounded retry, then notify.
5. **Track it.** An unspawned queue item already exists, so attach the pane:

   ```sh
   rk operator track update -L <server> <id> --scope '{"pane":"<pane-id>","session":"<session>"}'
   ```

   A brand-new spawn is `rk operator track add -L <server> <id> --kind pane --pane <pane-id> --session <session> --repo <repo> [--change <change> --branch <branch>] [--stop-stage <stage>] [--spawned-by <item-id>]`.
   A plain-agent spawn is a change-less pane item whose id is the worktree name, with `--branch <wt>`;
   once its PR URL is known, add `rk operator track add -L <server> <wt>-pr --kind github-pr --scope '{"repo":"<repo>","pr":<n>}' --check-every 2m`
   and `rk operator track rm -L <server> <wt>`. Nothing may `--depends-on` a bare agent.

### Merging

Queue PRs are created, not merged, unless the mode says otherwise. In a run:

- `cherry-pick-ladder` and `stacked-prs`: do not merge. Note that the queue is complete, list the PR
  links per repo with their dependency order, and notify the user.
- `merge-auto`: arm each PR as it ships with `gh pr merge --auto --squash <pr>` (the method flag is
  required; ready a draft first with `gh pr ready <pr>`; an "already clean" rejection means merge
  directly with `gh pr merge --squash <pr>`; auto-merge disabled on the repo means notify and stop).
  Arm only one PR per repo sequence, and only after the previous PR's merge is verified by its
  `github-pr` item turning done. The sequence is a chain of `github-pr` items:
  `rk operator track add -L <server> pr-<n> --kind github-pr --scope '{"repo":"<repo>","pr":<n>,"change":"<id>"}' --then "arm next: gh pr merge --auto --squash <next>" --depends-on pr-<n-1>`.
  When a merge is verified, spawn the next change (step 1 pins the advanced tip).
- A halted sequence (CI failure after recovery, conflict after recovery) disarms its remaining armed
  PRs with `gh pr merge --disable-auto <pr>`, halts only that repo's sequence and the repos that
  depend on it across repos, and notifies with the diagnosis.

### PR recovery

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

### Failures and timing

Review exhausted: skip the item. Ship-stage rebase conflict: notify; in `merge-auto` the queue
continues, in the chained modes dependents stay held. Cherry-pick or `stacked-prs` rebase conflict:
escalate, never skip. Pane died: one respawn (`wt create --checkout <branch>`), then skip. A stage
over 30 minutes or a queue over 2 hours: flag in a note and notify.
