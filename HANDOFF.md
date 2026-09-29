# Handoff — Working-Directory Diff Surface

**Worktree:** `/home/asim/code/run-kit.worktrees/workdir-diff`
**Branch:** `260929-wd01-working-dir-diff-surface` (cut from `origin/main` @ `88f4d8e7`)
**Prepared by:** the session that shipped PR #1027 (the PR-review "Changes" surface)

Read this file, then run `/fab-new` to open the change and write the intake. Do not
start editing before the intake exists — this repo is spec-first.

---

## 1. What to build

A **sixth surface**: a tile that shows the **working directory's** diff and its file
tree — what `git status` / `git diff` say right now, before anything is committed or
pushed. Its own icon in the surface toggle group, next to the existing `+-` Changes icon.

The user's words:

> another icon which does just shows the diff for the working directory and the tree
> view of working directory

Two things in one tile, mirroring the shipped Changes surface:

- the **file tree** of what has changed in the working directory, and
- the **diff** for the selected / expanded files.

It is **local-only**. No `gh`, no GitHub, no network, no review comments, no listener.
That is the whole point of it existing alongside Changes: Changes is what the *PR* says,
this is what *your disk* says.

## 2. Why this is a small change

Almost every part already exists and is directly reusable. The shipped Changes surface
was built from a clean split between "where do the rows come from" and "how are rows
rendered", and only the first half is new here.

| Need | Already exists | Reuse verdict |
|---|---|---|
| Availability gate | `win.gitRoot` on the SSE window payload — the active pane's cwd walked to its repo root | **Use as-is.** No new field, no new derivation. |
| Unified-patch → rows | `internal/prreview/hunks.go` (`ParsePatch`), `rows.go` (`LineRowsFromPatch`) | **Extract, don't copy.** See §5. |
| Syntax colour | `internal/prreview/highlight.go` (Chroma, windowed lexing, `refine` tier) | **Extract, don't copy.** |
| File tree UI | `app/frontend/src/lib/review-tree.ts` + `components/review-tree.tsx` | **Reuse directly** — already prop-driven, no PR concepts in it. |
| Diff renderer | `components/review-diff.tsx`, `review-file-row.tsx` | Reuse, with the comment callbacks made optional. |
| Surface plumbing | `lib/layout-tree.ts`, `lib/surface-layout.ts`, `lib/window-view.ts`, `lib/keybindings.ts` | Add one kind; the registry does the rest. |

What is genuinely new: a `git` reader package, two GET routes, one surface component.

## 3. The seams, precisely

### Frontend registry (add one surface kind — suggest `diff`, label "Working", glyph `~~`)

- `app/frontend/src/lib/window-view.ts:24` — `ViewName` is the union
  (`"tty" | "web" | "code" | "gui" | "review"`); `layout-tree.ts:32` aliases
  `SurfaceKind = ViewName`, so widening the union here widens both.
- `app/frontend/src/lib/surface-layout.ts:93` `SURFACE_LABEL`, `:108` `SURFACE_GLYPH`,
  `:113` `SURFACE_KINDS`, `:134` `availableTiles` — add the kind to all four.
  `availableTiles` order **is** the ⌘-digit order, so append after `review`.
- `app/frontend/src/lib/window-view.ts:122` — add `hasDiff(win)` next to `hasReview`:
  ```ts
  export function hasDiff(win: ViewWindow | null | undefined): boolean {
    return (win?.gitRoot ?? "").length > 0;
  }
  ```
  Same availability-vs-reachability split the file already documents: a repo with a
  clean tree still *offers* the lens; emptiness selects its CONTENT, not its presence.
  Also add it to `HINT_ORDER` (`:74`) and `availableViews` (`:143`).
- `app/frontend/src/lib/keybindings.ts:338` — `review-toggle` is ⌘5 / `Digit5`.
  Add `diff-toggle` on `Digit6`, `tier: "shifted"`, `macTier: "cmd"`. The
  browser-claim loop at `:491` already covers `Digit1`–`Digit9`, so ⌘6 needs no
  new claim entry — but do re-read the comment at `:329`, which says the digit
  claims "resolve all five" surfaces. That count is now wrong and is yours to fix.

### Backend

- `app/backend/api/router.go:1049-1054` — the six `/api/pr/review*` routes are the
  shape to copy. Suggest `GET /api/diff` (tree + file list) and
  `GET /api/diff/file` (one file's rows), mirroring `handlePRReview` /
  `handlePRReviewFile` in `app/backend/api/pr_review.go`.
- Both are **GET reads** (Constitution IX). There are no mutations in this feature.
- Window → repo root resolution: `resolvePRReviewTarget` (`api/pr_review.go:75`) reads
  one request-scoped `FetchSessions` snapshot and pulls `window.PrURL`. Do the same,
  but read `gitRoot`. Measured cost of that snapshot: **~0 ms** (tmux `list-panes` is
  sub-millisecond here), so no caching needed on that hop.

### New package: `app/backend/internal/wtdiff` (name it what you like)

Wraps `git` the way `prreview` wraps `gh` — `exec.CommandContext` with an explicit
argv slice, never a shell string (Constitution I). Suggested reads:

- `git -C <root> status --porcelain=v1 -z` → the changed-file list (staged, unstaged,
  untracked, renames). `-z` because paths can contain anything.
- `git -C <root> diff --no-color --no-ext-diff -M` (unstaged) and `--cached` (staged)
  → unified patches that drop straight into the existing `ParsePatch`.
- Untracked files have no patch; decide whether to show them as all-added or as a
  bare tree entry. **Ask the user.**

This is local disk, so it is fast and cheap — none of the PR surface's rate-limit,
budget, or stale-while-revalidate machinery applies. Do not port it. Keep the fetch
synchronous and re-run it on demand.

## 4. Open decisions — put these in the intake and ask

1. **Staged vs unstaged.** One merged view, two sections, or a toggle? GitHub has no
   equivalent, so there is no "do what GitHub does" answer to fall back on.
2. **Untracked files.** Shown as fully-added diffs, listed in the tree only, or hidden
   behind a toggle? Fully-added is expensive on a fresh `node_modules` mistake.
3. **Refresh trigger.** The Changes surface is push-driven off the SSE thread digest.
   There is no equivalent signal for the working tree. Options: a manual refresh verb,
   an SSE tick, or a filesystem watch. A watch is a new capability — probably too much
   for v1; recommend manual + on-focus.
4. **Does it need `git add` / stage-from-the-UI?** The user asked for a *view*. Assume
   read-only unless they say otherwise, and say so in the intake.
5. **Availability when the tree is clean.** Recommend: tile stays available (matches
   `web`'s always-available treatment), content shows an empty state.

## 5. What you will meet at merge time

Another session is working on `internal/prreview` in a **different worktree** (branch
`260929-pr01-review-first-load`, a first-load latency fix). Different checkout, so
nothing it does can reach your files — this is purely a note about rebasing later.

Its edit surface in `prreview.go` is lines 44–86 (consts/errors), 322–360 (`fetch`),
473–475 (`ghAvailable`), plus `files.go`, `threads.go` and `internal/ghprobe/ghprobe.go`.

If you extract the patch→rows→spans code into a shared package, your edit surface in
`prreview.go` is lines 155, 402 and 410 — the three `LineRow` / `ParsePatch` /
`LineRowsFromPatch` references. Disjoint from the above by ~240 lines and in different
functions, so git merges them cleanly. `cache.go:35` (`[][]Span`) is yours alone.

The one region both branches touch is the **import block** at the top of `prreview.go`.
Expect a trivial conflict there and nothing else. Do not wait for that branch.

## 6. Ground rules for this repo

- **Constitution** (`docs/specs/` — read `architecture.md` and `api.md`):
  I — `exec.CommandContext` + explicit argv, prose only ever over stdin.
  II — no database. IV — minimal surface. V — keyboard + palette parity.
  IX — GET reads, POST mutations. X — hooks carry only what is not derivable.
- **Specs are normative.** `docs/specs/pr-review.md` is the sibling spec and the model
  to imitate — read it before designing, especially § R4 (list/body split), § R5 (the
  highlight ladder) and § R6 (the row wire format). Write a new spec for this surface;
  do not extend `pr-review.md`, they are different features.
- **Also read** `docs/specs/surface-layout.md` (the registry contract you are adding to)
  and `docs/specs/window-views.md`.
- **Tests run through `just` only** — `just test-backend`, `just test-frontend`,
  `just test-e2e`. Never `go test` / `pnpm test` / `playwright test` directly.
- **Worktree discipline.** Work only in this directory. Never bare `git stash`/`stash pop`
  — the stash stack is shared across worktrees.
- Commit messages end with the session's own `Co-Authored-By:` line; PR descriptions end
  with the Claude Code attribution line.

## 7. Suggested first moves

```
cd /home/asim/code/run-kit.worktrees/workdir-diff
/fab-new            # open the change, write intake.md, get the SRAD gate green
```

Then, in the intake, resolve §4's five questions with the user before planning.
