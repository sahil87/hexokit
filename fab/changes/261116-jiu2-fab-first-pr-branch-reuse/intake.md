# Intake: Fab-First PR Source + Branch-Reuse Ownership Check

**Change**: 261116-jiu2-fab-first-pr-branch-reuse
**Created**: 2026-11-16

## Origin

> Bug: a pane's PR is wrongly linked when a git branch name is reused. In the loom repo
> (`/home/sahil/code/wvrdz/loom.worktrees/leafy-steppe`) the user created a fresh `wt` worktree
> named `leafy-steppe` with branch `leafy-steppe`, at HEAD = main tip
> (`4f7c2291c0 chore: release v0.1.781`), no commits ahead of main and no `fab/current`. The
> HexoKit sidebar PANE register and the row's PR glyph showed `pr #4203 · merged`. PR #4203 is an
> unrelated PR ("chore: remove empty fab/env/.env.common", head `leafy-steppe`, created and merged
> 2026-10-12) from an earlier, now-deleted worktree that happened to get the same randomly
> generated name.

Interaction mode: conversational. The bug was diagnosed in a preceding conversation, the current
mechanism was verified in code, two fixes were proposed, and the user approved both ("go ahead
with both"). This intake was then created by a promptless dispatch (`/fab-proceed` →
`promptless-defer`): no questions were asked at intake; open decisions are recorded as deferred
Unresolved rows in `## Assumptions`.

Decisions carried from the conversation:

1. **Fab-first PR source** — when a window is bound to an active fab change whose `.status.yaml`
   has a non-empty `prs:` list, the window's PR identity comes from that list (last entry), not
   from branch→gh derivation.
2. **Branch-fallback ownership check for MERGED/CLOSED PRs** — in the branch→PR fallback an OPEN
   PR still matches by branch name alone; a MERGED or CLOSED candidate is attributed only when the
   PR's head commit (`headRefOid`) is HEAD or an ancestor of HEAD
   (`git merge-base --is-ancestor <headRefOid> HEAD`). Clarified 2026-11-16: the user chose this
   ancestry test over the earlier "commits ahead of the default branch, or HEAD == headRefOid"
   rule, which re-attached the old PR as soon as new work was committed on a reused-name branch.

Rejected in the conversation: reverting to fab `prs:` only (loses non-fab panes — the reason for
#314); a PR-`createdAt`-after-branch-creation (reflog) test (more complex than the local
ancestry check); the "ahead of default OR HEAD == headRefOid" ownership rule (superseded by the
ancestry test at clarify — it re-attaches the stale PR once new commits land on the reused branch).

## Why

**The problem.** `gh pr list --head <branch>` matches by head-ref *name* only. The branch→PR
refresher queries `--state all` and ranks open > merged > closed (status-pyramid invariant 6, D2
revised) so that a genuinely merged PR keeps its purple glyph statelessly and restart-proof. The
side effect: any historical merged/closed PR whose head had the same name is attributed to *any*
later branch with that name, forever. `wt` generates random two-word worktree/branch names
(`leafy-steppe`), so name reuse across months of worktrees is routine, not exotic. The default-
branch carve-out (#389) already handles the degenerate `main` case; branch reuse is the same
degenerate-match class on non-default branches.

**Consequence if unfixed.** The PANE register and the PR glyph (the top status tier — L3 outranks
fab/agent/tmux in the pyramid) confidently show a wrong, merged PR on a fresh worktree. "Unknown
beats wrong" (pyramid invariant 7) is violated: a brand-new branch with zero work reads as
"shipped". The wrong link is also durable by design (invariant 6), so it never self-heals while
the pane sits on that branch.

**Why this approach.**

- Fab already records the change's PR(s) in `.status.yaml` `prs:` — an explicit, durable,
  locally-readable fact (Constitution §II durable source; §X derivation, not push). For
  fab-bound windows it is strictly more accurate than name matching and costs nothing extra on the
  hot path: `internal/fabstatus` already reads that exact file per window on every
  `FetchSessions`.
- Non-fab panes (teammate branches, manually opened PRs) still need branch derivation (the reason
  #314 replaced the `prs:` source). The ownership check keeps that universality while removing the
  degenerate merged/closed attribution: OPEN PRs (by far the common live case) are unaffected, and
  a genuinely merged squash-merge branch keeps its own commits not on main, so it stays purple.
- Both checks are local (file read on the hot path; `git` on the refresher goroutine), so the
  zero-subprocess SSE hot path is preserved.

## What Changes

### 1. Current mechanism (verified, for orientation)

- `app/backend/internal/sessions/sessions.go`
  - `windowBranchRepo` (~line 676): active pane's `(cwd, GitBranch)` if it has a branch, else the
    first pane with one.
  - `windowPRKey` (~line 701): maps that pane's cwd to its git root (`config.FindGitRoot`, pure
    stat-walk).
  - `enrichWindowPR` (~line 743): `prstatus.Register(repoDir, branch)` then
    `prstatus.SnapshotBranchPR(repoDir, branch)`; on hit sets `WindowInfo.PrURL/PrNumber`,
    `PrState = prstatus.MapBranchState(pr.State)` (fallback), `PrIsDraft = pr.IsDraft` (fallback).
    SSE hot path — zero subprocess/network allowed.
  - Fab tier (~lines 853–897): `fabMemo := fabstatus.NewMemo()`; per window
    `fab := fabMemo.WindowState(panes)` assigns `FabChange/FabStage/FabDisplayState`.
    `enrichWindowPR(&sd.windows[j])` is called at the END of the same per-window loop (~line 939),
    i.e. after the fab tier is resolved for that window.
- `app/backend/internal/fabstatus/fabstatus.go`: `State{Change, Stage, DisplayState}`;
  `Memo.WindowState` (first pane carrying a change wins); `parseFabStatusLink` reads
  `.fab-status.yaml` symlink → `fab/changes/<name>/.status.yaml`, parses the ordered `progress:`
  map via `yaml.Node` (`parseProgressStates`). Shared with the operator check.
- `app/backend/internal/prstatus/prstatus_branch.go`: `BranchRefresher.refreshWhere` per pair:
  default-branch exclusion (`defaultBranch` → `git symbolic-ref refs/remotes/origin/HEAD`, cached,
  fail-open) → viewer head-index join (`viewerIndexPR` → `pickBranchCandidate`) → gh fallback
  (`branchPRExec`: `gh pr list --head <branch> --state all --limit 100 --json
  number,url,state,updatedAt,isDraft` → `pickBranchPR`). `BranchPR{Number, URL, State, UpdatedAt,
  IsDraft}`. Negative TTL, seed cache (`prstatus_disk.go`), `RefreshURLs` (detector-targeted
  re-resolve through the same `refreshWhere`).
- `app/backend/internal/prstatus/prstatus.go`: viewer-wide collector, one batched GraphQL
  `viewer.pullRequests` query selecting `headRefName` + `headRepository { nameWithOwner }`;
  `ViewerPR{Number, URL, State, HeadRepo, HeadRef, UpdatedAt}` feeds `StoreViewerIndex`.
- `app/backend/api/sse.go` `attachPRStatus` (~line 1796): URL-keyed join of live
  state/checks/review/draft from the collector snapshot onto any window with a non-empty `PrURL`;
  on a miss PrState/PrIsDraft keep `enrichWindowPR`'s fallbacks.
- Nothing reads fab's `.status.yaml` `prs:` list today. `docs/specs/status-pyramid.md:28` records
  that L3 PR used to come from `prs:` and was replaced post-#314 by branch→gh.

### 2. Fix 1 — Fab-first PR identity

**Rule.** When the window's fab tier resolves an active change (the `fabMemo.WindowState` result
already computed for that window) AND that change's `.status.yaml` has a non-empty `prs:` list,
the window's PR identity (`PrURL`, `PrNumber`) comes from the **last** entry of that list (fab
appends, so last = most recent). Branch derivation is not consulted for identity in that case.
When the change has no `prs:` entries (`prs: []`, absent, or unparsable), fall back to the
branch derivation (with Fix 2 applied).
<!-- assumed: fab-first wins even on the repo's default branch (#389 carve-out) — explicit fab record outranks name matching -->
<!-- assumed: the window-level fab rollup (Memo.WindowState) feeds the PR identity as-is, even if the fab-bound pane differs from windowPRKey's branch pane -->

`.status.yaml` shape fab writes:

```yaml
prs:
    - https://github.com/sahil87/hexokit/pull/1073
```

**Parsing.** Extend `internal/fabstatus` so the same single `yaml.Node` pass that reads
`progress:` also extracts the `prs:` sequence (top-level key; sequence of scalar URL strings).
Additive field on `State`, e.g. `PRURL string` (the last non-empty entry) — or `PRs []string` with
the caller picking the last; plan decides. A malformed `prs:` (not a sequence, non-scalar items)
degrades to "no fab PR" (fall back to branch), never an error, matching fabstatus's per-pane
fail-open degradation. The operator-check consumer of `fabstatus` ignores the new field.

**Number.** Parse the PR number from the URL's `/pull/<n>` path segment (pure string parse, no
network). An entry that does not parse as a GitHub PR URL is skipped (treated as absent).

**Hot path.** No new I/O: the `.status.yaml` file is already read by `parseFabStatusLink` for this
window; `enrichWindowPR` takes the fab state (or just the fab PR URL) as an input instead of
re-deriving it. Zero subprocess/network on `FetchSessions` is preserved.

**Live state/checks/review/draft.** Unchanged join: `attachPRStatus` keys on `PrURL` against the
viewer-wide collector. For a fab-sourced PR the collector does not cover (teammate-authored,
outside the top-100 window, or a non-canonical URL — e.g. a pre-rename
`https://github.com/sahil87/run-kit/pull/811` entry, which exists in this repo's own older
changes), state still needs a source. Direction agreed in conversation: the background refresher
resolves the PR **by URL/number** instead of by head (e.g. `gh pr view <url> --json
number,url,state,isDraft,headRefOid`, run on the refresher goroutine with `exec.CommandContext` +
`ghTimeout` + argv), behind a URL-keyed `Register`/`Snapshot`-style façade so the hot path only
registers + joins. **Clarified 2026-11-16: the by-URL resolution ships in this change** (user chose
"look it up by URL"). The window carries the **canonical** URL GitHub returns (`pr.URL`) once
resolved, so a pre-rename `run-kit` entry joins the collector. Before the first resolution lands
(cold start), `PrState` stays `""` (unknown — never defaulted to `open`; `MapBranchState` posture)
and the recorded `PrNumber`/`PrURL` identity still renders.

**Scope of fab-first (clarified 2026-11-16).** The fab `prs:` PR is shown even when the window sits
on the repo's default branch (the explicit record outranks the #389 carve-out, which stays for the
branch path). The PR comes from the window-level fab rollup (the same change behind the row's
stage marker), even when the fab-bound pane differs from `windowPRKey`'s branch-supplying pane.

**Sketch** (shape only; plan owns the final form):

```go
// sessions.go — per-window loop, after fab tier:
fab := fabMemo.WindowState(sd.windows[j].Panes)
...
enrichWindowPR(&sd.windows[j], fab.PRURL)

func enrichWindowPR(w *tmux.WindowInfo, fabPRURL string) {
    if fabPRURL != "" {
        if num, ok := parsePRNumber(fabPRURL); ok {
            prstatus.RegisterURL(fabPRURL)                 // cheap set touch, no exec
            url := fabPRURL
            w.PrURL, w.PrNumber = &url, &num
            if pr, ok := prstatus.SnapshotURLPR(fabPRURL); ok { // last-good by-URL resolution
                w.PrState = prstatus.MapBranchState(pr.State)
                w.PrIsDraft = pr.IsDraft
                if pr.URL != "" { w.PrURL = &pr.URL } // canonical URL (repo rename)
            }
            return
        }
    }
    // existing branch path (Register + SnapshotBranchPR), now ownership-checked (Fix 2)
}
```

### 3. Fix 2 — Ownership check for MERGED/CLOSED branch candidates

**Rule.** In `BranchRefresher`'s branch→PR resolution (both the viewer head-index join and the
`gh pr list` fallback — and therefore `RefreshURLs`, which shares `refreshWhere`):

- An **OPEN** candidate matches by branch name alone (unchanged).
- A **MERGED** or **CLOSED** candidate is attributed **only when** its `headRefOid` is the local
  `HEAD` or an ancestor of it: `git merge-base --is-ancestor <headRefOid> HEAD` (run with
  `cmd.Dir = repoDir`) exits 0. Exit 1 (not an ancestor) and exit 128 (object unknown locally —
  e.g. the commit was never fetched here) both mean **not owned**. A candidate with no
  `headRefOid` (gh/GraphQL didn't return it, or an older disk seed entry) is **not owned**.

Outcome for the reported bug: a fresh worktree on main tip never has #4203's head commit in its
history (worktrees share one object store, so the old commit may still exist locally, but it is not
an ancestor of the new branch's HEAD) → not owned → the pair resolves negative → no glyph, no PANE
`pr` line. This holds even after the user commits new work on the reused-name branch. A genuine
just-merged branch (squash or merge-commit) still has its PR's head commit in its own history →
stays purple (invariant 6 durability preserved for the genuine case), including when further
commits are added after the merge. No default-branch resolution or ahead count is needed.

**Ordering.** Filter merged/closed candidates by ownership *before* precedence picking
(`pickBranchCandidate` / `pickBranchPR`), so ranking happens only among attributable candidates.
On the index path, an index whose candidates are all filtered out is a **miss** (falls through to
gh — the index is never an authoritative negative, which still holds); on the gh path, a parsed
result whose candidates are all filtered out is a valid authoritative negative (`pr = nil`, stamps
`negativeAt` as today).

**`headRefOid`.**
- Add `headRefOid` to `branchPRExec`'s `--json` fields:
  `--json number,url,state,updatedAt,isDraft,headRefOid`.
- Add `headRefOid` to the viewer GraphQL query node selection, to the private `ghPR` JSON shape,
  to `ViewerPR` (e.g. `HeadOid string`), and to `BranchPR` (e.g. `HeadRefOid string
  json:"headRefOid"`), so index candidates carry it.
- Candidates without it (e.g. loaded from an older disk seed cache) are not owned when MERGED/CLOSED
  (the next fresh pass re-derives them with the oid).

**Git checks run off the hot path.** Only on the refresher goroutine, only when a merged/closed
candidate actually needs adjudication (an OPEN winner or no candidates needs no git call), using
`exec.CommandContext` with a timeout (`ghTimeout` or a dedicated short git timeout) and explicit
argv, `cmd.Dir = repoDir`, OUTSIDE `r.mu` (same discipline as `defaultBranch`/`originRepo`).
Package-var seams for tests (mirroring `branchDefaultExec` / `branchOriginExec`).
HEAD is resolved with `git rev-parse HEAD` on the refresher goroutine. When the check fails for a
reason other than exit 1/128 (timeout, git missing, other error), the pass keeps the pair's
last-good entry untouched (no positive or negative is written for that candidate this pass) and
retries next pass — never a fresh false attribution, never a flicker-off of a genuine PR.
<!-- assumed: transient check failure = keep last-good, no write; exit 1/128 and missing oid = not owned (user-chosen) -->
Cache the verdict keyed by `(repoDir, headRefOid, HEAD)`: ancestry between two fixed commits is
immutable, so a cached verdict never goes stale — the cache needs only a size/observation bound,
pruned with the other per-repo caches for pairs no longer observed (Constitution §II bounded
memory).

**Accepted edges** (discussed):
- A squash-merged branch later reset/rebased onto main → its PR head commit leaves HEAD's history
  → glyph clears. Correct for a branch now sitting on main.
- A merge-commit (non-squash) merged branch later fast-forwarded to main keeps the PR head commit in
  history → stays purple. Acceptable: the branch genuinely contains that PR's work.
- A teammate's merged PR viewed from a worktree that fetched it: the head commit is local and in
  history → owned. Viewed from a worktree that never fetched it: not owned (no glyph).

### 4. Docs (at hydrate)

- `docs/specs/status-pyramid.md`: L3 source row (line ~28) — fab `.status.yaml` `prs:` (last
  entry) first for fab-bound windows, branch → gh lookup otherwise; invariant 6 — add the
  branch-reuse note (merged/closed attribution requires ownership evidence; OPEN by name); D2
  decision row (line ~440) cross-reference.
- Memory files listed under Affected Memory.

### 5. Tests

Go unit tests alongside, run via `just test-backend`:

- `internal/fabstatus/fabstatus_test.go`: `prs:` parsing — empty list, absent key, single entry,
  multiple entries (last wins), malformed (mapping/scalar instead of sequence), non-URL entry.
- `internal/prstatus/prstatus_branch_test.go`: ownership filter — OPEN by name with oid not in
  history (attributed); MERGED with is-ancestor exit 1 (not attributed → negative on gh path, miss
  on index path); MERGED with exit 0 (attributed); MERGED with exit 128 / unknown object (not
  attributed); MERGED without `headRefOid` (not attributed); open > merged precedence unchanged;
  mixed list where the newest merged fails but an owned closed passes; transient git failure
  (timeout/other error) keeps last-good and writes nothing; no git call when the winner is OPEN;
  `--json` argv includes `headRefOid`; is-ancestor argv shape; cache hit avoids a second git call
  for the same `(repo, headRefOid, HEAD)`.
- `internal/prstatus/prstatus_test.go`: GraphQL parse carries `headRefOid` into `ViewerPR`.
- `internal/sessions/sessions_test.go`: fab-bound window with `prs:` → PrURL/PrNumber from the
  last entry, branch snapshot ignored; fab-bound window with `prs: []` → branch path; non-fab
  window → branch path; zero-subprocess posture unchanged.

### 6. PR Evidence

The effect is UI-visible (row PR glyph and the PANE register's `pr` line), so Constitution
§ PR Evidence applies: before/after recordings via `just demo` on a throwaway rig (never a live
`rk serve`), desktop + mobile viewports, showing a pane on a reused-name fresh branch losing the
stale merged glyph. Because correctness depends on the `gh` integration, the scenario should use
real `gh`: e.g. a rig pane in a fresh worktree of this repo whose branch name equals the head of a
historical merged hexokit PR, at main tip (before: merged glyph shown; after: none), plus a
positive control (a branch containing its merged PR's head commit / a fab change with `prs:`) still showing its PR.

## Affected Memory

- `run-kit/architecture/pr-status`: (modify) branch→PR resolution gains the merged/closed
  ownership filter (`headRefOid` is an ancestor of HEAD), `headRefOid` on the gh `--json`
  fields, GraphQL selection, `ViewerPR`/`BranchPR`; any by-URL resolution added for fab-sourced
  PRs; new Design Decision entries (fab-first identity; ownership check vs. reflog/createdAt and
  vs. fab-only revert).
- `run-kit/daemon-lifecycle`: (modify) § Branch→PR Derivation — resolver order now includes the
  ownership filter; hot-path `enrichWindowPR` takes the fab `prs:` identity first.
- `run-kit/architecture/backend-packages`: (modify) `internal/sessions` Branch→PR enrichment
  paragraph (fab-first) and the `internal/fabstatus`/`internal/prstatus` rows as needed.
- `run-kit/tmux-sessions`: (modify) fab-tier derivation section — `fabstatus` also extracts the
  `.status.yaml` `prs:` list (last entry) for the PR identity.
- `run-kit/ui/status-signals`: (modify) PR (L3) register source note — fab `prs:` first, branch
  derivation with ownership check otherwise (frontend code unchanged).

## Impact

- **Backend code**: `app/backend/internal/fabstatus/fabstatus.go` (+ test),
  `app/backend/internal/sessions/sessions.go` (`enrichWindowPR` signature/flow; + test),
  `app/backend/internal/prstatus/prstatus_branch.go` (ownership filter, git seams, caches,
  `headRefOid`, possibly by-URL resolution; + test), `app/backend/internal/prstatus/prstatus.go`
  (GraphQL selection + `ViewerPR`; + test), possibly `prstatus_disk.go` (seed DTO gains optional
  `headRefOid`; schema stays tolerant — absent field = not owned when merged/closed).
- **API/wire**: no new endpoint or SSE event; `WindowInfo.PrURL/PrNumber/PrState/PrIsDraft` keep
  their shape — only which PR populates them changes.
- **Frontend**: no code change expected; observable change is the glyph/PANE `pr` line content.
- **Performance**: hot path unchanged (no new I/O beyond the already-read `.status.yaml`). The
  refresher gains at most two local `git` calls per merged/closed adjudication, cached per
  `(repo, branch, HEAD)`; OPEN winners need none.
- **Specs**: `docs/specs/status-pyramid.md` (L3 source row, invariant 6, D2 row).
- **Constitution touchpoints**: §I (argv + `exec.CommandContext` + timeout), §II (bounded caches,
  seed never authoritative), §X (both sources derived, nothing pushed), § PR Evidence.

## Open Questions

- None — all resolved at clarify (2026-11-16).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Ship both fixes in one change: fab-first PR identity + merged/closed ownership check in the branch fallback | Discussed — user approved "go ahead with both" | S:95 R:80 A:90 D:90 |
| 2 | Certain | Fab-first identity = last entry of the window's active fab change's `.status.yaml` `prs:` list; empty/absent list falls back to branch derivation | Discussed — user's decision 1 verbatim (last/most recent entry; fallback when no entries) | S:90 R:85 A:85 D:85 |
| 3 | Confident | `prs:` is parsed in `internal/fabstatus`'s existing single `yaml.Node` pass and exposed as an additive `State` field; malformed → no fab PR (fail-open to branch) | Codebase: fabstatus already reads this exact file per window on the hot path with per-pane fail-open degradation | S:70 R:85 A:80 D:70 |
| 4 | Confident | A fab `prs:` entry overrides branch derivation even when the branch would resolve a different (even OPEN) PR | Discussed — "PR identity comes from that list, not from branch derivation"; the fab artifact is the explicit record | S:80 R:80 A:70 D:70 |
| 5 | Certain | State/draft for fab-sourced PRs come from a background by-URL resolution (`gh pr view <url> --json number,url,state,isDraft,headRefOid`) on the refresher behind a URL-keyed register/snapshot façade, shipped in this change | Clarified — user chose "look it up by URL" (2026-11-16) | S:90 R:75 A:80 D:85 |
| 6 | Confident | Before the first by-URL resolution lands (cold start), a fab-sourced PR renders identity with `PrState = ""` (unknown), never defaulted to open | Codebase: `MapBranchState` posture and the prOwnsDot "unknown, not open" rationale in `enrichWindowPR`'s comment | S:70 R:85 A:75 D:75 |
| 7 | Certain | Ownership rule: OPEN matches by name; MERGED/CLOSED attributed only when `git merge-base --is-ancestor <headRefOid> HEAD` exits 0 | Clarified — user chose the ancestry test over "ahead > 0 OR HEAD == oid" (2026-11-16) | S:95 R:75 A:90 D:90 |
| 8 | Confident | Ancestry verdicts cached by `(repoDir, headRefOid, HEAD)` with no TTL (immutable for fixed commits), bounded/pruned with other per-repo caches; HEAD via `git rev-parse HEAD` on the refresher | Ancestry of two fixed commits never changes; discussion said "cache where sensible" | S:70 R:85 A:85 D:75 |
| 9 | Confident | Ownership filter applies before precedence picking on both index and gh paths; an all-filtered index is a miss (falls through), an all-filtered gh result is an authoritative negative | Codebase: preserves the "index miss is never authoritative" design decision and the gh path's sole-negative-writer role | S:60 R:80 A:75 D:65 |
| 10 | Certain | Add `headRefOid` to `branchPRExec --json`, the GraphQL selection, `ViewerPR`, and `BranchPR`; MERGED/CLOSED candidates lacking it (old seed) are not owned | Clarified — user: "if gh doesn't return the head commit, the PR is not attached" | S:85 R:85 A:85 D:85 |
| 11 | Confident | is-ancestor exit 1/128 = not owned; transient failure (timeout/other error) keeps the pair's last-good entry and writes nothing that pass | Exit 128 (object absent) = not owned is user-chosen; keep-last-good avoids both false attribution and flicker for transient failures | S:65 R:80 A:70 D:65 |
| 12 | Certain | Ancestry test replaces the ahead-of-default check entirely — no default-branch resolution or rev-list count in the ownership path | Clarified — user selected "PR head is in HEAD's history" (2026-11-16) | S:90 R:75 A:85 D:85 |
| 13 | Certain | Fab-first applies even on the repo's default branch (explicit artifact outranks the #389 carve-out; carve-out stays for the branch path) | Clarified — user chose "fab record wins" (2026-11-16) | S:90 R:80 A:85 D:90 |
| 14 | Certain | The window-level fab rollup (`fabstatus.Memo.WindowState`) feeds the PR identity as-is, even when the fab-bound pane differs from `windowPRKey`'s branch pane | Clarified — user chose "the window's fab change" (2026-11-16) | S:90 R:80 A:85 D:90 |
| 15 | Certain | Non-canonical `prs:` URLs (e.g. pre-rename `sahil87/run-kit/pull/811`) are canonicalized: the window carries the URL the by-URL resolution returns, so the collector join hits | Clarified — part of the user's "look it up by URL" choice (2026-11-16) | S:85 R:80 A:80 D:85 |
| 16 | Certain | Zero subprocess/network on `FetchSessions`; all new git/gh calls run on the refresher goroutine with `exec.CommandContext` + timeout + argv, outside `r.mu` | Constitution §I, Process Execution; existing hot-path invariant; discussed | S:95 R:90 A:95 D:95 |
| 17 | Certain | Accepted edges: a squash-merged branch later reset/rebased onto main loses its glyph (PR head leaves history); a merge-commit branch fast-forwarded to main keeps it | Discussed + clarified — the branch either no longer or still contains that PR's work | S:85 R:80 A:80 D:80 |
| 18 | Confident | Disk seed cache stays never-authoritative; a seeded stale merged positive may show until the first fresh pass re-derives; seed DTO gains an optional `headRefOid` | Constitution §II seed-cache rule; existing seed provenance design | S:60 R:85 A:75 D:70 |
| 19 | Certain | Rejected alternatives: revert to fab `prs:` only; PR createdAt vs reflog branch-creation test | Discussed — fab-only loses non-fab panes (#314's reason); reflog test more complex than the local check | S:90 R:85 A:85 D:90 |
| 20 | Certain | Tests are Go unit tests alongside (`fabstatus_test.go`, `prstatus_branch_test.go`, `prstatus_test.go`, `sessions_test.go`), run via `just test-backend` | Discussed; code-quality.md test strategy; context.md "always run tests through just" | S:90 R:90 A:90 D:90 |
| 21 | Confident | PR evidence: `just demo` before/after on a throwaway rig with real `gh`, using a fresh worktree whose branch name matches a historical merged PR head, plus a positive control | Constitution § PR Evidence (UI-visible, external integration must be exercised); concrete scenario is an inference | S:60 R:80 A:55 D:55 |
| 22 | Certain | Docs at hydrate: `docs/specs/status-pyramid.md` L3 source row + invariant 6 branch-reuse note (+ D2 row), and the pr-status/daemon-lifecycle/backend-packages/tmux-sessions/status-signals memory | Discussed — named in the description; memory locations verified by grep | S:85 R:90 A:85 D:85 |

22 assumptions (15 certain, 7 confident, 0 tentative, 0 unresolved).
