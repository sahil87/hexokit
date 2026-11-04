# Multiple PRs per window — draft

**Drafted**: 2026-09-25 · against `d829bfa7` · from the 260925 heuristics discussion
**Status**: **not ready for intake** — the open questions below need answers first.
**Shape (tentative)**: one repo (run-kit); likely 2 changes (detection → UI), sequential.
**Pre-change truth**: `app/backend/internal/sessions/sessions.go` (`windowBranchRepo` ~:590, `windowPRKey` ~:610, `enrichWindowPR`); `app/backend/internal/prstatus/prstatus_branch.go` (`pickBranchPR` ~:1330); `docs/specs/status-pyramid.md` (PR tier, rollups); `docs/memory/run-kit/architecture/pr-status.md`.

## Use case

One agent conversation in one pane regularly ships **several PRs in sequence**: change A → branch A → PR A, then change B → `git switch` to branch B → PR B, in the same worktree. Today a window carries exactly one `PrURL`, derived from the **current** branch of the active pane (else the first pane with a branch), so PR A disappears from the UI the moment the pane switches to branch B — while A may still be open, failing CI, or awaiting review.

## Model

1. **PR is a pane fact; the window is a rollup.** Each pane carries a PR *list*; the window shows the union. This also removes the focus-dependent pick in `windowBranchRepo` (active pane first, else first pane) — the window no longer needs one representative pane.
2. **Deterministic sources only** (Constitution II/X — derived, never hook-pushed):
   - **Worktree reflog** (primary): every linked worktree keeps its own HEAD reflog; each `checkout: moving from A to B` entry names a branch the pane's worktree held. Branches checked out since the conversation's start anchor → one PR each via the existing branch → PR lookup (`pickBranchPR` precedence unchanged per branch).
   - **fab change folders** (secondary, maybe): PR URLs recorded by `fab add-pr` in the worktree's `fab/changes/*/.status.yaml` — covers fab flows even when the reflog is noisy.
   - **Not a source**: `gh` searches like "PRs by me in this repo" — that is the heuristic this plan exists to avoid.
3. **Current branch stays first** in the list; older entries follow in reflog order (newest first).

## UI (sketch)

- **Sidebar row dot**: still one status. With >1 PR, the most actionable wins by a fixed ladder (draft: changes requested > CI failing > review pending > open > merged > closed), plus a small `×N` count.
- **Window flyout card**: one row per PR — number, title, state, CI.
- **Status bar PANE section**: the focused pane's list (the focused pane is legitimately "what you're looking at" here, not a guess).
- **Board cards**: TBD — one card per window with the rollup, or the list inline.

## Open questions (answer before intake)

1. **Start anchor.** What bounds "since the conversation started"? tmux 3.7c has no `pane_start_time` (verified: expands empty). Candidates: agent session start from `@rk_pane_agent_state` / the transcript's first entry; window creation time; no bound + a cap (last N branches). The anchor choice decides whether a long-lived pane accumulates stale PRs.
2. **Merged/closed retention.** Does a merged PR stay in the list for the life of the conversation, drop after merge, or drop after a grace period? (Ties into whether the sidebar should show "all done".)
3. **Uncovered shapes.** PRs made without checking out a local branch (`git push origin HEAD:x`, `gh pr create --head`), and PRs in another repo from the same conversation. Transcript URL parsing would catch these but is per-provider parsing — in or out?
4. **Cost.** `gh` lookups scale with distinct (repo, branch) pairs per window. Does the prstatus refresher batch? The current top-N-most-recently-updated window in the branch lookup would also drop stale PRs — replace with exact per-branch lookups?
5. **Status-pyramid spec.** The multi-PR rollup ladder needs a row in `docs/specs/status-pyramid.md` § Rollups before build.
6. **API shape.** `PrURL`/`PrNumber` → `prs: [...]` on the window payload: additive field + keep the scalar for one release, or a clean break?
