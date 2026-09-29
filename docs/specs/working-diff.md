# Working-Directory Diff Surface

> Status: shipped (260929-wd01). Sibling spec: [pr-review.md](pr-review.md),
> whose row model, list/body split and eager budget this surface shares.
> Registry contract: [surface-layout.md](surface-layout.md).

The Changes surface answers *what does the pull request say*. This one answers
*what does my disk say right now* — every edit that is written but not
committed. They are different questions, and the app previously answered only
the first.

## W1 — Repo-backed, and available whenever the window has a repo

Availability is exactly `gitRoot` non-empty:

```ts
hasDiff(win) ≡ (win?.gitRoot ?? "").length > 0
```

`gitRoot` is the window's active-pane cwd walked to its repo root, already
derived server-side for the code lens and already on the SSE window payload —
so this surface adds **no new field and no new derivation**, the same way
`hasReview` keys off `prUrl`.

The availability-vs-reachability split is load-bearing here in a way it is not
for the PR surface: a **clean tree still offers the lens**. Emptiness selects
the surface's CONTENT (an empty state), never its presence. A tile that vanished
the moment you committed would be an absence the reader has to interpret — and
they would have to interpret it exactly when they are least sure whether their
work is saved.

The surface takes the ⌘6 position, last in `availableTiles`, with glyph `~~` and
label "Working".

## W2 — git is free, so none of the network machinery is ported

Measured on this repo (`git diff HEAD~8`, a 216-file / 1.70 MB stand-in for a
large working tree):

| Read | Measured |
|---|---|
| `git status --porcelain=v1 -z` | 0.01 s (0.15 s cold) |
| `git diff HEAD --numstat -M` | 0.04 s |
| `git diff HEAD --no-color --no-ext-diff -M` (full, 1.70 MB) | **0.04 s** |
| `git diff --no-index /dev/null <untracked>` | 0.00 s |

Against `gh`'s measured 1.05 s for 80 files, git is free. So `internal/wtdiff`
carries **none** of what `internal/prreview` needs to survive a network: no
cache, no TTL, no stale-while-revalidate, no single-flight `refreshMu`, no
availability probe, no rate-limit accounting. Caching a 50 ms local read would
buy nothing and cost a staleness bug.

**What IS kept is the eager budget** — `maxEagerRowsPerFile` 500,
`maxEagerRows` 5000, `maxEagerFiles` 75, identical to the PR surface. It bounds
RENDER cost, and render cost does not care where the rows came from.

## W3 — Two reads, one merged view

- `git status --porcelain=v1 -z` — the status classification and the untracked
  list.
- `git diff HEAD --no-color --no-ext-diff -M` — every tracked change, **staged
  and unstaged**, against HEAD, in one call.

One merged view rather than split staged/unstaged panes, because "the diff for
the working directory" is most naturally "what have I changed since the last
commit". The staged/unstaged distinction survives as a **per-file badge** read
from the porcelain's index column — the information without doubling the
surface. A file can be both (`MM`); the badge then reports staged and the rows
show the union, which is what `git diff HEAD` returns.

### Three facts about git's output, each load-bearing

1. **A rename emits its OLD path as a second NUL-terminated field.** A parser
   that does not consume it reads that path as the next record's status code and
   silently shifts every file after the rename. The output still looks
   plausible, which is what makes it dangerous.
2. **`git diff --no-index` exits 1 on SUCCESS.** It is how an untracked file
   becomes an all-added patch without writing to the index (`git add -N` would,
   and this surface performs no writes). Treating exit 1 as failure drops every
   untracked file.
3. **A pure rename, a binary file or a mode-only change has no hunks.** Each
   records as a file with no patch — `hasPatch: false`, which the shipped file
   row already renders as "no diff available" — rather than as an empty diff.

Per-file patches are split on `diff --git ` and trimmed to their first `@@`,
which makes the input to `ParsePatch` **byte-identical in shape to GitHub's REST
`patch` field**. That is why the shipped parser reads git with no change at all.

## W4 — Colour needs no fetch

The PR surface's highlight ladder (spec pr-review.md § R5) exists because its
lexer has to pull the post-image blob from GitHub, which is why it has a window,
a byte cap, a `refine` flag and a background pass.

None of that applies here: **the post image IS the file on disk**, and the patch
already carries its text. So there is one lex, over the rows themselves, and no
tier ladder. `internal/diffrows` holds the shared lexing; the Fetcher-bound
tiering stays in `internal/prreview`.

## W5 — Read-only, and every route a GET

```
GET /api/diff?window={id}              file list + status + eagerly-expanded rows
GET /api/diff/file?window={id}&path=…  one file's rows, with token spans
```

There are no mutations: no staging, no committing, no discarding, no comments.
A working-tree line has no GitHub address to anchor a thread to, so `ReviewDiff`
renders in read-only mode — its comment seams are optional, and when `onComment`
is absent the hover gutter and the composer do not render at all rather than
offering a button that cannot work.

`path` is shape-validated and then checked against the snapshot's **own**
changed-file list. That closed set is the authorization and is not optional:
without it the route serves any file in the repository, and through a `..`
segment, any file outside it. Identical reasoning to `handlePRReviewFile`.

## W6 — Freshness is a button, not a protocol

The PR surface revalidates off the SSE thread digest, because a gh read is
expensive and a comment landing late is invisible. Here a read is 0.05 s and
there is no equivalent push signal for a filesystem.

v1 refreshes on mount, on identity change, and on an explicit refresh verb. A
refresh **must not re-seed the open set** — the reader's expand state is theirs,
not the server's, and collapsing the file they were reading is the bug that
seeding on every load would cause.

A filesystem watcher is deliberately out of scope: it is a new capability and a
new failure mode. At 0.05 s a tick-poll is affordable and is the obvious
follow-up.

## Package split

`internal/diffrows` holds the substrate-agnostic half of the old
`internal/prreview`: `ParsePatch`, the row model, the line runs, and the Chroma
lexing. The split line is **"does it touch a network or a cache"** — `spansFor`,
`refinedSpans`, `queueRefine` and `refinePassByteCap` stayed behind because they
are bound to the blob cache and the gh fetch. `prreview` keeps type and const
aliases for everything that crossed, so no consumer churned.
