# Intake: Working-Directory Diff Surface

**Change**: 260929-wd01-working-dir-diff-surface
**Created**: 2026-09-29

## Origin

Conversational, alongside the first-load work on the shipped Changes surface. The user asked for:

> another icon which does just shows the diff for the working directory and the tree view of working directly

and then, having first asked for a handoff to a second agent, took it back into this session:

> start working on the other intake that we discussed yourself / complete the whole change till Fab-fff

The five open questions the handoff left for the user are resolved here by this session, each with its reasoning stated, because the instruction was to carry the change rather than to ask. They are called out in Assumptions so a reader can overturn any one of them cheaply.

## Why

**The gap.** The Changes surface (`review`, ⌘5) answers *what does the pull request say*. Nothing in the app answers *what does my disk say right now*. Between them sits every edit that is written but not committed — which, in a tool whose whole premise is watching agents work in tmux panes, is the state the user most often wants to look at. Today reading it means dropping to a pane and running `git diff`, losing the tree, the syntax colour, the virtualized file list and the keyboard model the Changes surface already has.

**Why it is cheap.** The expensive half of the Changes surface is the network. This one has no network at all.

Measured on this repo (`git diff HEAD~8`, a 216-file / 1.70 MB stand-in for a large working tree):

| Read | Measured |
|---|---|
| `git status --porcelain=v1 -z` | **0.01 s** (0.15 s cold) |
| `git diff HEAD --numstat -M` | **0.04 s** |
| `git diff HEAD --no-color --no-ext-diff -M` (full, 1.70 MB) | **0.04 s** |
| `git diff --no-index /dev/null <untracked>` | **0.00 s** |

Against `gh`'s 1.05 s for 80 files, git is free. Two subprocesses, ~0.05 s, no rate limit, no auth, no budget. That single fact removes most of the machinery the PR surface needs: no `reviewTTL`, no stale-while-revalidate, no single-flight `refreshMu`, no availability probe, no cost accounting. **Do not port them.** The eager budget stays, because it bounds RENDER cost, which is unchanged.

**Why the rendering half is nearly free too.** The patch→rows→spans pipeline in `internal/prreview` is already substrate-agnostic: `ParsePatch` takes a unified patch, and `git diff` emits unified patches. `ReviewTree` is already prop-driven with no PR concepts in it. So this change is a git reader, two routes, one surface component, and a registry entry.

## What Changes

### 1. `internal/diffrows` — extract the substrate-agnostic half of `prreview`

New package holding the pure patch→rows→spans code, moved verbatim from `internal/prreview`: `hunks.go` (`ParsePatch`, `PatchRow`, hunk-header parsing), `rows.go` (`LineRow`, `LineRowsFromPatch`, `FileBody`, `renderHunk`, `collectRuns`) and the *pure* half of `highlight.go` (`Span`, `tokenClass`, `lexerFor`, `lexLines`, `plainSpans`, `lexWindow`, `sliceSpans`, `appendSpan`, `byteLen`).

The Fetcher-bound half of `highlight.go` — `spansFor`, `refinedSpans`, `queueRefine` — **stays in `prreview`**, because it is coupled to that package's blob cache and its gh-backed fetch. The split is exactly "does this touch a network or a cache": nothing in `diffrows` does.

`prreview` keeps type aliases so no consumer churns:

```go
type LineRow = diffrows.LineRow
type Span = diffrows.Span
type FileBody = diffrows.FileBody
```

`api/pr_review.go` reads `prreview.FileBody`, and the existing tests read `prreview.Thread` / `prreview.FileBody`; aliases keep all of that compiling untouched.

> **Merge note.** PR #1069 (`260929-pr01-review-first-load`) is open against `prreview.go`, `files.go`, `threads.go` and `ghprobe.go`. This change touches none of those four except `prreview.go`'s import block and the three alias lines. Expect a trivial import conflict and nothing else.

### 2. `internal/wtdiff` — the git reader

New package. Wraps `git` exactly as `prreview` wraps `gh`: `exec.CommandContext` with an explicit argv slice, never a shell string (Constitution I). An injectable `gitExec` seam mirroring `ghExec`, so every test runs without a repository.

```go
type Reader struct {
    gitExec func(ctx context.Context, dir string, args ...string) ([]byte, error)
    now     func() time.Time
}
type Snapshot struct {
    Root    string      `json:"root"`
    Branch  string      `json:"branch"`
    Head    string      `json:"head"`
    Files   []FileEntry `json:"files"`
    ReadAt  time.Time   `json:"readAt"`
}
```

Two reads build a snapshot:

- `git -C <root> status --porcelain=v1 -z` — the status classification and the untracked list. `-z` because paths can hold newlines and quoting. The record is `XY<space><path>NUL`, and a rename adds the OLD path as its own NUL-terminated field immediately after — parsing must consume that second field or every subsequent record shifts.
- `git -C <root> diff HEAD --no-color --no-ext-diff -M` — every tracked change, staged and unstaged, in one unified stream. Split per file on `diff --git `, strip the extended headers down to the first `@@` so what reaches `ParsePatch` is byte-identical in shape to what GitHub's REST `patch` field carries.

Untracked files get `git -C <root> diff --no-color --no-ext-diff --no-index /dev/null <path>`, one subprocess each at ~0 ms. **It exits 1 on success** (differences found), so the runner must treat 1 as normal here and only a higher code as failure.

Binary files: `git diff --numstat` reports `-\t-\t<path>`, and the patch body says `Binary files … differ`. Both project to `HasPatch: false`, which the shipped file row already renders as "no diff available".

`XY` projects to a single `Status` plus a `Staged` bool — the index column `X` non-empty and not `?` means staged. A file can be both (`MM`: staged edit plus later unstaged edit); `Staged` then reports true and the diff shows the union, which is what `git diff HEAD` returns and what the reader is asking about.

No cache. A read is 0.05 s and costs nothing, so caching it would only add a staleness bug.

### 3. Routes

```
GET /api/diff?window={id}              file list + status + eagerly-expanded rows
GET /api/diff/file?window={id}&path=…  one file's rows, with token spans
```

Both GET; there are no mutations in this feature (Constitution IX). `resolvePRReviewTarget`'s shape is copied to resolve `window → gitRoot` from one request-scoped `FetchSessions` snapshot — measured at ~0 ms, so no caching on that hop.

`path` is shape-validated and then checked against the snapshot's own changed-file list, exactly as `handlePRReviewFile` does. **That closed set is the authorization**: without it the route would serve any file in the repository — or, through a `..` segment, outside it. `repoRelativePath`'s guard is reused for the same reason it exists there.

### 4. Frontend

- **Registry**: `ViewName` (`window-view.ts:24`) gains `"diff"`; `SURFACE_LABEL` "Working", `SURFACE_GLYPH` `~~`, `SURFACE_KINDS`, and `availableTiles` (appended after `review`, so it takes the ⌘6 position). `HINT_ORDER` and `availableViews` likewise.
- **Availability**: `hasDiff(win) ≡ (win?.gitRoot ?? "").length > 0`. `gitRoot` is the active pane's cwd walked to its repo root and **already rides the SSE window payload** — so, like `hasReview` keying off `prUrl`, this needs no new field and no new server-side derivation. Same availability-vs-reachability split: a clean tree still offers the lens, and emptiness selects its CONTENT.
- **Keybinding**: `diff-toggle` on `Digit6`, `tier: "shifted"`, `macTier: "cmd"`. The browser-claim loop already covers `Digit1`–`Digit9`, so no new claim entry — but the comment at `keybindings.ts:329` says the digit claims "resolve all five" surfaces, and that count becomes six.
- **`components/working-surface.tsx`**: the tile. Reuses `ReviewTree` as-is and `ReviewDiff` in a read-only mode.
- **`ReviewDiff` read-only mode**: `onComment` / `onReply` / `onResolve` / `threads` become optional. When `onComment` is absent the hover-to-comment gutter affordance and the composer do not render. This is the one shipped component this change modifies, and its existing tests are the guard.

### Out of scope (explicit)

- **Staging, committing, discarding, or any write.** The user asked for a view. Every route here is a GET.
- **Review comments and the listener.** Those are PR concepts; a working-tree line has no GitHub address to anchor to.
- **A filesystem watcher.** v1 refreshes on mount, on identity change, and on an explicit refresh verb. A read is 0.05 s, so polling it on the SSE tick is affordable and is the obvious follow-up — but a watcher is a new capability and a new failure mode, and it should be its own change.
- **Branch/commit comparison** (`git diff main...`). This surface answers "what is on my disk", one question.

## Affected Memory

- `run-kit/pr-review`: (modify) the patch→rows→spans pipeline is no longer `prreview`-owned; record `internal/diffrows` as the substrate-agnostic half and the "does it touch a network or a cache" line that splits them.
- `run-kit/ui/lenses-and-layout`: (modify) the surface registry gains a sixth kind, its glyph, its ⌘6 position and its `gitRoot` availability gate.
- `run-kit/architecture/backend-packages`: (modify) two new packages.

## Impact

- **New:** `app/backend/internal/diffrows/` (moved files), `app/backend/internal/wtdiff/`, `app/frontend/src/components/working-surface.tsx`.
- **Modified:** `app/backend/internal/prreview/` (three alias lines + imports), `app/backend/api/router.go` (two routes), a new `api/diff.go`, `app/frontend/src/lib/{window-view,surface-layout,layout-tree,keybindings}.ts`, `components/review-diff.tsx` (optional callbacks), `api/client.ts` (two fetchers).
- **Wire:** additive only. No existing response shape changes.
- **Gates:** `just test-backend`, `just test-backend-race`, `just test-frontend`, `cd app/frontend && npx tsc --noEmit`, `just test-e2e`.
- **Known-failing before this change** (verified on clean `origin/main`, must not be attributed here): `rk/cmd/rk`'s `TestPortPinRowRealPolicyValues`; e2e `control-gallery` fine+coarse pointer baselines and `gui-toolbar-fold` real-widths.

## Open Questions

- Whether `~~` is the right glyph next to `+-`. It is two ASCII chars like every other entry and reads as "modified", but it is a taste call and cheap to change.
- Whether a clean tree should hide the tile rather than show an empty state. Recommended kept visible (matching `web`, which is always available and selects content), because a tile that vanishes when your work is committed is a tile whose absence you have to interpret.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The surface is READ-ONLY: no staging, committing or discarding, every route a GET | The user asked to "show the diff"; writes are a materially different feature with a different risk profile, and Constitution IX makes the GET/POST split explicit | S:80 R:90 A:90 D:85 |
| 2 | Certain | One merged view of the working tree vs **HEAD** (`git diff HEAD -M`), not split staged/unstaged panes | "the diff for the working directory" is most naturally "what have I changed since the last commit". Measured: one `git diff HEAD -M` returns tracked changes staged AND unstaged, with renames and deletes, in one 0.04 s call | S:75 R:85 A:90 D:80 |
| 3 | Certain | The staged/unstaged distinction survives as a per-file badge from `git status`'s XY codes, not as a view split | Keeps the information without doubling the surface; mirrors how the shipped file row already renders a status letter | S:70 R:90 A:85 D:80 |
| 4 | Certain | Untracked files are included, as all-added patches via `git diff --no-index /dev/null <path>` | Measured at 0.00 s each. `git status` already excludes gitignored files, so the `node_modules` worry does not arise; the eager budget bounds the rest | S:75 R:85 A:90 D:80 |
| 5 | Certain | `--no-index` exits **1** on success and the runner must accept it | Verified directly: exit 1 with a valid patch on stdout. Treating 1 as failure would silently drop every untracked file | S:95 R:90 A:95 D:90 |
| 6 | Certain | `git status --porcelain=v1 -z` emits a rename's OLD path as a second NUL field, which the parser must consume | Verified directly: `R··newname.txt\0renamed.txt\0`. Not consuming it shifts every subsequent record | S:95 R:90 A:95 D:90 |
| 7 | Certain | No cache, no TTL, no stale-while-revalidate, no availability probe | Measured: two reads, ~0.05 s, no network, no rate limit. Caching a 0.05 s local read buys nothing and adds a staleness bug | S:85 R:85 A:90 D:85 |
| 8 | Certain | The eager budget IS kept | It bounds render cost, not fetch cost, and render cost is unchanged. 216 files / 1.70 MB is a realistic working tree | S:80 R:90 A:90 D:85 |
| 9 | Certain | Availability is `gitRoot` non-empty — no new field, no new derivation | `gitRoot` already rides the SSE window payload as the code lens's other half; same trick `hasReview` plays with `prUrl` | S:90 R:90 A:90 D:90 |
| 10 | Certain | `path` is authorized by membership of the snapshot's own changed-file list, reusing `repoRelativePath` | Identical reasoning to `handlePRReviewFile`: without the closed set the route serves any file in the repo, and a `..` segment escapes it entirely | S:90 R:85 A:95 D:90 |
| 11 | Certain | Extract the pure patch→rows→spans code to `internal/diffrows`; `spansFor`/`refinedSpans`/`queueRefine` stay in `prreview` | The split line is "does it touch a network or a cache". Those three are bound to the blob cache and the gh fetch; nothing else is | S:80 R:80 A:90 D:85 |
| 12 | Certain | `prreview` keeps `type LineRow = diffrows.LineRow` (and Span, FileBody) so no consumer churns | Go type aliases are identical types; `api/pr_review.go` and the existing tests keep compiling untouched | S:85 R:90 A:90 D:85 |
| 13 | Confident | Binary files project to `HasPatch: false` and reuse the shipped "no diff available" row | `--numstat` reports `-\t-\t<path>` for binary; the row already exists for GitHub's own undiffable files | S:70 R:90 A:85 D:75 |
| 14 | Confident | `ReviewDiff`'s comment callbacks become optional rather than a second read-only renderer being written | Duplicating the diff renderer to avoid four optional props is the worse trade; its existing tests guard the change | S:65 R:80 A:85 D:75 |
| 15 | Confident | Surface kind `diff`, label "Working", glyph `~~`, ⌘6 | Two ASCII chars like every sibling; "Working" distinguishes it from "Changes" in the same tooltip row. Taste, and cheap to change | S:55 R:90 A:80 D:65 |
| 16 | Confident | No filesystem watcher in v1; refresh on mount, identity change, and an explicit verb | A watcher is a new capability and a new failure mode. At 0.05 s a tick-poll is affordable and is the natural follow-up, but it is not this change | S:65 R:85 A:85 D:75 |
| 17 | Confident | A clean tree keeps the tile visible with an empty state | Matches `web`'s always-available treatment; a tile that vanishes when you commit is an absence the user has to interpret | S:55 R:90 A:80 D:70 |
| 18 | Confident | Per-file patches are split on `diff --git ` and trimmed to the first `@@` | Makes the input to `ParsePatch` byte-identical in shape to GitHub's REST `patch` field, so the shipped parser needs no change at all | S:70 R:85 A:85 D:75 |

18 assumptions. Grades are derived from the composite, not asserted.
