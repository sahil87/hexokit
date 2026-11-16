# Demo Evidence

Command: `just demo pr-branch-reuse --before`

Result: before and after web passes both completed with 2 passing projects each (desktop and mobile), using real `gh` and temporary worktrees. The reused-name branch is `docs/daemon-autostart-plan` at `origin/main`; before shows historical PR #1115 merged and after shows no PR. The positive control is `skill-restore-topic` at its own head commit and shows PR #1109 merged in both variants.

## PR-body Markdown

### Before

**Desktop**

![](.demo/pr-branch-reuse-before-desktop.webm)

**Mobile**

![](.demo/pr-branch-reuse-before-mobile.webm)

### After

**Desktop**

![](.demo/pr-branch-reuse-after-desktop.webm)

**Mobile**

![](.demo/pr-branch-reuse-after-mobile.webm)

## Attach command

```sh
gh pr edit --attach .demo/pr-branch-reuse-before-desktop.webm --attach .demo/pr-branch-reuse-before-mobile.webm --attach .demo/pr-branch-reuse-after-desktop.webm --attach .demo/pr-branch-reuse-after-mobile.webm
```
