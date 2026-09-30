# PR Review — The `review` Surface and the Comment Listener

> The terminal route gains a fifth surface kind: **`review`**, a PR-backed diff
> review tile rendering the window's pull request the way GitHub's "Files
> changed" tab does — file rows, expandable unified diffs, line-anchored
> comments — plus a **listener** that watches the PR's review threads and
> dispatches each unhandled one into the window's own agent as work to do.
> This spec is **[target]** — designed in a `/fab-discuss` session on
> 2026-09-19; the change is
> [`260919-55fx-pr-review-surface-listener`](../../fab/changes/260919-55fx-pr-review-surface-listener/intake.md).
>
> Design authorities: [`review-comment-states.html`](../wiki/review-comment-states.html)
> owns every comment state and is normative for § Comment States.
> [`review-highlighting-studies.html`](../wiki/review-highlighting-studies.html)
> is **historical** for its option comparison — it weighed three *in-browser*
> highlighters, and § R5 subsequently moved tokenization to the backend
> entirely — but its two findings still bind: the comment layer is
> highlighting-neutral, and token colour has to survive the diff tint.
>
> Requirement numbering here (R1–R7, with R3a / R6a / R6b inserted as the
> design learned) is local to this spec and unrelated to `surface-layout.md`'s.
>
> Companions: [`surface-layout.md`](surface-layout.md) (the tile model, the
> surface registry, and its view-state test — this spec adds one kind and
> changes nothing about the tile model),
> [`window-views.md`](window-views.md) (availability derivation —
> `review` follows the `code` pattern exactly),
> [`api.md`](api.md) (the HTTP surface),
> [`agent-messaging.md`](agent-messaging.md) (the injection engine this
> dispatches through), [`cron.md`](cron.md) (the delivery rules this borrows
> wholesale — busy predicate, hold, rate cap).

---

## The Problem

A run-kit window is already bound to a branch, a worktree, an agent, and — via
`internal/prstatus` — a pull request. Everything needed to review that PR is
derivable inside run-kit already. Yet:

1. **Reviewing means leaving.** The diff lives on github.com; the window that
   produced it sits here.
2. **Acting on a comment is manual and lossy.** Reading a review comment,
   re-typing its substance into the agent's pane, and remembering which
   comments have been dealt with is work the human does by hand. On a PR with
   fifteen threads, *the human is the queue.*
3. **The loop stops where it matters most.** run-kit can spawn, watch, message,
   and schedule agents. The one signal that most reliably demands agent work —
   a reviewer saying "this is wrong, fix it" — is the one it cannot act on.

---

## The Model

The surface is **PR-backed only**. There is no local-`git diff` mode: with no
PR on the branch, the toggle is unlit and the tile is unreachable, exactly as
`code` behaves outside a repo. This is deliberate — it keeps comments and the
threads the listener reads on **one substrate** rather than two, and it means
no comment ever needs a run-kit-owned store (Constitution II).

```
 branch ──prstatus.BranchRefresher──▶ PR ──┬──▶ digest   (in the existing 90s batch)
                                           └──▶ detail  (on demand, tile mounted)
                                                  │
 review tile ◀────────────────────────────────────┘
      │
      │ comment / reply / resolve ──▶ gh ──▶ GitHub
      │
 listener ──unhandled thread──▶ inject.Engine ──▶ the window's agent pane
      │                                                    │
      └────────────── 👀 on verified submit ◀──────────────┘
```

### R1 — One kind, appended to a closed registry

`layoutspec.surfaceKindList` gains `"review"`; `ViewName` gains `"review"`. The
registry's own comment already states that extending it is appending one entry.
The **tile model is unchanged** — growth is still bounded by the per-viewport
size floor, not a tile count (Constitution IV); this adds a kind, not a slot.
Like every kind but `gui`, a review tile may be borrowed into another tab as a
foreign `@N/review` leaf: it reads its home window's PR and digest, and binds
none of the route window's `Review:` palette seams or toggle dot.

The internal kind is `review`, **not** `changes`. This repo already means
something specific by "changes" (`fab/changes/`, the change slug in the sidebar
and status bar, "Active change"), and the two would be ambiguous in exactly the
surfaces where both appear. A user-facing label may read "Changes"; the kind
must not.

### R2 — Availability is derived, not stored

```ts
export function hasReview(win: ViewWindow | null | undefined): boolean {
  return (win?.prUrl ?? "").length > 0;
}
```

`WindowInfo.PrURL` is already branch-derived server-side and already rides the
SSE payload, so **availability** needs no new derivation and no new field. The
toggle is a fourth flush button in the top bar's `surface-toggles` group;
`HINT_ORDER` gains `review`.

Its **dot is a different question** and is not availability. The dot means
"threads are waiting on a human", so it reads the unhandled-thread count
(§ Phasing slice 7's unread badge), which a CLOSED tile cannot report. That
count therefore rides the window payload as `prReviewUnhandled`, joined by the
SSE hub from the R3 digest the collector already polls — a pure in-memory read,
no extra `gh` call, and the same collector-join-owned shape as `prChecks` /
`prReview`. A mounted tile's own count wins, because it reads the detail
document rather than the 90 s digest.

### R3 — Two cadences, two packages

The digest and the detail have opposite cost profiles and MUST NOT share a
package. The split is load-bearing, and the code must say why — without a
comment it reads as duplication.

| | Digest | Detail |
|---|---|---|
| Lives in | `internal/prstatus` (its own scoped query) | `internal/prreview` |
| Cadence | every 3 min, only PRs live windows resolve to | on demand, only while a tile is mounted |
| Carries | `id`, `isResolved`, `isOutdated`, `path`, `line`, first comment's `id` + `author.login` + `reactions(content: EYES)` | file list, patches, thread bodies |
| Keyed by | PR URL | `(prURL, headSha)`; the token cache beneath it keys `(blobSha, path)` — R5 |
| **GraphQL points** | ~2–6 per pass | ~21 per mount |

Pulling full bodies into the batch would multiply the payload by comment count
across a 100-PR window every 90 s. Serving the listener from the detail
fetcher would make the listener depend on a tile being open. Hence both.

> The digest rode the viewer-wide `viewer.pullRequests` batch in an earlier
> draft, on the reasoning that doing so cost **no additional `gh` call**. That
> was true, and it is the wrong unit — see § GraphQL Cost. It is now a scoped
> `nodes(ids:)` query over the live set.

`internal/prreview` carries the posture `prstatus` already proves: single-flight
`refreshMu` held across the whole pass including subprocesses, a separate `mu`
guarding the map for readers that never spans a subprocess,
stale-while-revalidate on error, an injectable availability gate, and
`exec.CommandContext` with explicit argv slices under a 10 s timeout.

A cold document is **two gh reads, run concurrently** inside that single-flight
pass: the file list over REST (only REST carries patches) and one GraphQL call
answering threads, viewer login **and** the PR meta. Nothing flows between them
— `ParsePRURL` is pure and runs before both — so serialising them only ever
paid one round trip to wait for another. Measured on an 84-file PR, the two
shapes back to back: **3.57–3.62 s serial against 1.29–2.22 s concurrent.**

The availability gate is memoized in `internal/ghprobe` (5 min on success,
30 s on failure — asymmetric because "gh is broken" is a fact the user is
actively fixing). `gh auth status` is a NETWORK call: 0.34–0.39 s across ten
consecutive runs, and twice observed at 30 s. Since `ghTimeout` is 10 s, that
second shape turned a working tile into "gh is unavailable" — a failure caused
entirely by re-asking a question whose answer we already had.

### R3a — GraphQL cost is DECLARED, not measured

Every query this surface sends is priced by GitHub on the `first:` values it
**declares**, not on the rows it returns. A nested connection is therefore a
fixed per-call price, paid identically by a PR with five threads and one with
five hundred:

```
cost ≈ (outer first × inner first) / 100 + 1
```

Measured against the live API, one PR:

| query | cost |
|---|---|
| `reviewThreads(first: 100)` × `comments(first: 100)` | **101** |
| `reviewThreads(first: 100)` × `comments(first: 20)` | **21** |
| `reviewThreads(first: 100)` × `comments(first: 10)` | 11 |
| `reviewThreads(first: 50)` × `comments(first: 20)` | 11 |
| `reviewThreads(first: 30)` × `comments(first: 10)` | 3 |
| a query with no nested connection (file list, PR meta, `gh pr list`) | 1 |
| `reviewThreads(first: 100)` × `comments(first: 20)` **+ 4 PR scalars** | **21** |

**This is the rule that cost an account.** The detail query shipped at
`comments(first: 100)`, so every tile mount spent 101 points; a page reload
spent ~106, ~36 reloads exhausted the 5 000/hour budget, and because the same
budget carries the PR-status join, a review-surface feature took checks, review
decision and draft state down with it across the whole app.

Three rules follow, and all three are load-bearing:

1. **Never reason about cost in `gh` calls.** "It rides an existing call, so it
   is free" is true of subprocesses and false of points. Counting subprocesses
   is what hid this for so long: ~9 calls per reload looked far too cheap to be
   spending 100 points, because *one* of them declared a 10 000-node product.
2. **Bound every nested connection, and bound the INNER one first.** A
   truncated thread *list* hides feedback the reader never learns exists; a
   thread truncated past its twentieth comment hides the tail of a conversation
   nobody reads in a side panel. So thread coverage stays wide and comments give.
3. **Select `rateLimit { cost remaining }` on any polled query** and log it. The
   regression was invisible until the account died; GitHub's own accounting is
   one field away and is the only trustworthy source.

Rule 1 reads both ways, and the second direction is worth just as much. A
nested connection is never free because it rides an existing call — but a
**scalar** declares no node product, so it never needs a call of its own. The
PR's `title`, `state`, `headRefOid` and `baseRefOid` cost a whole REST round
trip (~0.65 s on the critical path) until they were moved onto the
`pullRequest` node the thread query already selects; measured with
`rateLimit { cost }`, the price stayed at **21** and the call still returned in
0.78 s. Reach for the existing node first; just never assume the reach is free
without selecting `cost` and reading it.

On which: **`gh api rate_limit` misreports both buckets.** It read
`graphql: 0/5000 remaining` while GraphQL was fully exhausted, and `core: 0`
while the REST header said 355. Only `rateLimit { }` *inside* a GraphQL query,
and the `X-RateLimit-*` response headers for REST, are truthful.

### R4 — Every mutation is a POST; every body goes over stdin

```
GET  /api/pr/review?window={id}          file list + per-file stats + threads + viewer login
GET  /api/pr/review/file?window={id}     one file's hunks as per-line token spans
       &path=…&start=…&count=…           (windowed; see R5/R6)
POST /api/pr/review/comment              new comment (path,line,side,body) | reply (threadId)
POST /api/pr/review/thread               resolve / unresolve
POST /api/pr/review/listen               arm / disarm
POST /api/pr/review/refresh              on-demand refresh, mirrors /api/status/refresh
```

The file list and the file body are **separate reads**. A PR with two hundred
files must render its list without tokenizing any of them (R7), and an expanded
file fetches its own lines windowed (R5). A single response carrying every
file's tokens is the shape this spec exists to avoid.

`/api/pr/review/file` returns, per line: the token spans, the side, the
line numbers on each side, and the row kind (`add` / `del` / `ctx`) — plus a
response-level **`refine`** flag (R5) and the hunk headers. Rendering is the
client's, because the same parsed hunks feed both the unified rows and, later,
the paired split rows, and re-shaping client-side beats two round trips or two
response shapes for one diff.

Constitution IX. Comment bodies reach `gh` over **stdin**, never argv —
Constitution I, and user-authored prose is the least argv-safe input in the
system.

---

## Rendering

**Unified view only** in v1; split view is a follow-on. All four reference
screenshots are unified, and split doubles the renderer surface for no signal
in the supplied design.

File rows carry, per the reference: chevron, filename (bold) + dim path, copy
path, `+N`/`−N`, an Added/Modified badge, a **Mark as viewed** checkbox, and an
overflow `⋯`. Expanding renders the unified diff with line numbers, an
added/removed wash plus a left bar, and context expanders (`↕ All 75 lines`,
`↑ 5 lines`).

### R5 — Highlighting is a backend concern

Tokenization runs in Go via
[Chroma](https://github.com/alecthomas/chroma) (`github.com/alecthomas/chroma/v2`,
pure Go, no CGO, ~280 languages). **The frontend ships no highlighting
dependency at all.**

> Supersedes an earlier decision to use Shiki in the browser. The route here is
> [px0](https://github.com/px0-ai/px0) (MIT), whose highlighting is Chroma plus
> a windowed lexer; px0 itself is not importable — every file is `package main`
> under a non-fetchable module path, and it is a server, not a library — so what
> this spec adopts is Chroma directly plus px0's *approach*, ported with
> attribution. See § Prior Art.

Moving tokenization server-side removes four problems the in-browser choice
carried rather than solving them: the 100–300 KB bundle, async highlighter init
(and the unhighlighted-then-repaint flash), shipping two editor themes, and a
theme whose colours assume a flat ground the diff tint then sits under.

**Windowed lexing with dual-tier refinement.** Chroma lexers run well under
1 MB/s, so whole-file tokenization on open is off the table. Three rungs:

- **Tier 0.5 (the list read, no fetch at all).** The eagerly-expanded rows are
  lexed from the PATCH'S OWN TEXT before they go on the wire. The patch already
  carries every line it renders, so this costs no blob and no request — only
  CPU. It is not the whole file, so a hunk opening inside a block comment or a
  raw string lexes wrong; measured on an 84-file PR it is right for **4,561 of
  4,916 rows (92%)**, costs **+71 ms** across the file set (one goroutine per
  file, capped by the eager budget's own `maxEagerFiles`), and roughly doubles
  the list payload (560 KB → 1,113 KB).

  It exists because the rungs below it all need a round trip: before it, the
  first paint was monochrome and colour arrived over ~6 s of `SPANS_CONCURRENCY`-
  bounded blob fetches. It is a RUNG, not a replacement — the other 8% is real,
  and tier 1 is what corrects it.

  **Tier 0.5 must NOT set `refine`.** The client fires `onLoadRange()` on mount
  when a body carries `refine: true`, so setting it would make a 31-file PR
  issue 31 body requests the instant the tile mounts — exactly the storm the
  list/body split exists to prevent. The correction rides the client's existing
  viewport pump instead, which is viewport-driven and concurrency-bounded.

- **Tier 1 (always).** Lex a bounded window — the requested lines padded with
  context on each side — and slice out the target lines. The leading pad puts
  the lexer in the right state on entry (inside a block comment, a raw string);
  the trailing pad lets a construct opening inside the window find its
  terminator. Returns in low single-digit milliseconds with **`refine: true`**
  when the window may have guessed.
- **Tier 2 (small blobs only).** A background goroutine lexes the blob end to
  end and populates the cache; the client swaps the corrected lines in place.

The window is capped in **bytes as well as lines** — generated files exist with
multi-megabyte single lines, where a thousand-line window is the whole file.
Over the byte cap, context is dropped first; past that, the blob serves
unhighlighted. Concrete window, context, byte-cap and background-pass
thresholds are set during apply against real PRs, not guessed here.

This replaces "files over a cap render unhighlighted" with a ladder that
degrades to *briefly imprecise colours* instead of *no colours*, and never
blocks the tile.

**Short classes, CSS custom properties.** Chroma token types map to one- and
two-character classes (`.k`, `.nf`, `.s`, `.m`, `.c`, `.kd`, `.kt`, `.err`),
coloured by matching custom properties in `globals.css`. Class-name length is
payload here — the string repeats once per token on every line shipped.
Because run-kit's own stylesheet owns the colours, **both themes come free from
the existing palette** and the add/remove wash composes underneath by
construction. The light-theme string-token-versus-add-wash collision the
highlighting study flagged cannot arise: we pick the token colour.

**Pre-image and post-image.** Chroma lexes a *file*; a unified hunk interleaves
two sides. Added and context lines are lexed against the post-image blob (head
sha), removed lines against the pre-image (base sha). Lexing a hunk body as a
standalone fragment is not permitted — it starts the lexer mid-file with the
wrong state, which is exactly what the context padding exists to prevent.

The blobs this needs are the blobs § Rendering already fetches for context
expansion (`↕ All 75 lines`), so the two requirements share one fetch.

**Cache.** Keyed `(blobSha, path)`. Blob shas are immutable, so unlike a
path+mtime+size key it can never invalidate wrongly. In-memory, LRU, byte-
budgeted, droppable — the same class as `prstatus`'s cache, and like it, never
a source of truth. The budget is **daemon-sized**: px0 runs a 512 MB cache
because it is a foreground tool you close, while `rk` is a long-lived daemon
with a ~20 MB-class idle footprint to protect. Idle memory is returned to the
OS on a latch so it happens once per idle period, not once per tick.

### R6 — The line is the unit of the API

The response carries **an array of per-line token spans**, never one HTML blob
per file. A blob cannot be interleaved, and the comment layer's whole job is
interleaving: a composer row, a thread card, and an expander all splice between
line *N* and line *N+1*.

Every rendered row carries its addressing as data attributes:

| Attribute | On | Meaning |
|---|---|---|
| `data-l` | any row present on a side | the line number on that side |
| `data-side` | every code row | `L` (pre-image) or `R` (post-image) |
| `data-at` | deleted rows | the post-image line the deletion sat before |

This is the anchoring contract. GitHub addresses a comment by
`(path, side, line)`, and these attributes are that tuple, so a selection
anywhere in the diff can drive the composer, and a thread fetched from `gh`
finds its row without a second index.

**Decoration is non-destructive.** Comment indicators, selection highlights and
suggestion ranges are applied with a `TreeWalker` over the text nodes of the
mounted rows, splitting and wrapping matches **without touching token markup**.
Rewriting a row's `innerHTML` to add a marker would destroy the tokens the
backend just computed, and is not permitted.

### R6a — The tile opens expanded, on one request

The PR opens with its files already open, as GitHub's Files-changed tab does.
That is affordable only because of the split R5/R6 already make: a diff's
**structure** is free — the patch is in the cached `Review` document, so rows
cost no network — while its **colour** costs a blob fetch. So:

- The list response carries `rows` (structure, **never** spans) for every file
  inside the eager budget below, and a `rowCount` for every file whether
  expanded or not, so a collapsed file's placeholder is still sized correctly.
- Expanding on open therefore costs **zero** additional requests and **zero**
  additional `gh` subprocesses. Fetching each body instead would cost one of
  each per file, at mount, on an origin whose six connection slots also carry
  the SSE stream everything else depends on.
- **Files marked viewed open shut.** Per-viewer state already decides this
  (R7's localStorage key), and a file nobody will read is colour nobody pays for.

**The eager-expansion budget** follows GitHub's two independent caps rather than
one, because the two failure shapes are different — a single generated lockfile
dominating the page, and a 300-file PR trying to render everything:

| Cap | Meaning | Collapsed reason |
|---|---|---|
| per file | a file whose diff exceeds it collapses on its own account | `large` |
| whole diff | once the PR has spent the row budget, the rest collapse | `budget` |
| file count | a floor on per-file cost, so thousands of tiny files still stop | `budget` |

A collapsed file renders **open**, showing why its diff is absent and a
**Load diff** button — never an empty row. The two reasons are worded
differently because only `large` means "this file will always be slow".
The constants live in `internal/prreview` and are the one knob to turn; exact
GitHub values are not published, and these match its behaviour at the shapes
that matter.

**Colour arrives on approach, never on mount.** An expanded file requests its
spans when it nears the viewport, through a queue capped well under the
connection limit — which doubles as the ceiling on concurrent `gh` blob
fetches. Reading a PR is top-down, so this fetches almost exactly what gets
looked at, and a file scrolled past costs one request rather than the whole
diff costing forty. The response is the ordinary rangeless body, so it replaces
the seeded rows with the same structure plus spans and the R5 refine ladder
takes over: **tier 0** plain → **tier 1** windowed → **tier 2** exact.

**Seeding happens on identity only.** A revalidation (the SSE digest tick, or a
reload after a mutation) MUST NOT re-seed: the open/closed set and the bodies
already fetched are the reader's state, not the server's, and re-seeding would
collapse the file someone was mid-comment in.

### R6b — The file tree

The changed files also render as a **directory tree** beside the diff, the shape
VS Code's Pull Request view uses. A flat list of seventy paths is a wall; the
same paths as a tree are a map.

- **Navigation only.** Selecting a file scrolls the diff list to it and focuses
  it. The tree never expands a file, fetches a body, or marks anything — it owns
  no state the rows do not already own, so the two halves of the tile cannot
  disagree.
- **Single-child directory runs collapse into one row** (`app/backend/api`, not
  three nested rows). A Go repository is mostly such runs, and an indent per
  segment for a directory that branches nowhere buys only scrolling. A file's
  ancestors are therefore NOT its path prefixes, which is why revealing a file
  walks the built tree rather than splitting the string.
- **No checkbox**, though the reference tree has one: the file rows already
  carry a viewed checkbox, and two controls for one piece of state, both on
  screen at once, is worse than the redundancy is useful. Viewed files dim.
- Status is a second channel — ink on the filename *and* the letter — so a scan
  separates new files from edits without reading every trailing glyph.
- The toggle sits beside the listen control and is palette-reachable
  (Constitution V). Whether the tree shows is a **viewing posture**: per-viewer
  localStorage, and deliberately not keyed on the PR, because a reader who wants
  the tree wants it on every PR. Which directories are open is per-PR and does
  not persist — a tree that reopened yesterday's folders on a different PR is
  noise.

### R7 — Virtualize the file list, not the diff body

A single file's diff is bounded by that file, so an expanded file renders as
plain DOM. What is unbounded in a pull request is the **number of files**, so
the file list is virtualized.

Virtualization stands down once anything is expanded, because rows then have
wildly unequal heights and a fixed-height sizer would lie to the scrollbar.
R6a's budget is what keeps that safe: it bounds how much can be open at once,
so the un-virtualized case is bounded too. Variable-height virtualization
would lift the bound and is the obvious follow-up, not a prerequisite.

If the diff body ever does need virtualizing, the recipe is a native-scrolling
viewport over a spacer sized `totalLines × lineHeight`, with a recycled row
band translated into place, an overscan margin, paint throttled to
`requestAnimationFrame`, and typography measured **once** offscreen so geometry
stays algebraic and paint never reads layout.

Two consequences for row construction, both cheap now and expensive later:

- **Selection must survive a repaint.** Save the selection as
  `{line, col}` file coordinates, re-render, then restore by walking text nodes.
  A background refine swapping lines under an in-progress selection is the
  normal case, not an edge one — that selection is usually about to be quoted
  into a comment.
- **Row builders are shared across row shapes.** Split view is deferred (§ What
  This Does Not Do), but it is a *row-shape* variation, not a second renderer:
  pair each deletion run with the addition run that follows it index-by-index,
  pad the shorter side, and render each pair as one row with two halves — which
  keeps the columns aligned with no synced-scroll code. Building the
  hunk-header, line-number, marker and code-cell builders shape-agnostic now is
  what keeps that true.

**Mark as viewed** is per-viewer state → localStorage, keyed
`rk-review-viewed:<prUrl>:<sha>:<path>`. The head sha in the key is what resets
it on a new push, matching GitHub. Constitution IV's layering.

---

## Comment States

[`review-comment-states.html`](../wiki/review-comment-states.html) is normative
for this section.

| State | Rendering | Listener |
|---|---|---|
| Open, unmarked | expanded card | **eligible** — dispatches next tick |
| Open, marked 👀 | expanded, `→ dispatched` chip | held — un-react 👀 to re-queue |
| Open, new reply after mark | expanded, chip still reads dispatched | **still held** — un-react 👀 to re-queue |
| **Resolved** | collapsed one-liner, dimmed, purple pill | terminal — never dispatched |
| **Outdated** | collapsed + amber pill + original hunk on demand | **never dispatched** |
| Pending review (unsubmitted) | local only, amber left edge | invisible to `gh` until submitted |

The composer anchors under its line, which takes an outline for the duration.
The header carries the side+line ref (`R264` = right/new side; `L` = old). The
footer carries GitHub's own two modes as a split button — and they differ for
the listener: **a pending review is invisible to `gh` until submitted**, so only
*Add single comment* can dispatch on post. The chip reads `⚡ dispatch on post`
in single mode and dims to `⊘ on review submit` in review mode.

**Outdated never dispatches.** The agent would be handed a line number that no
longer names the code the comment is about, and would produce a confident edit
in the wrong place — strictly worse than dropping it. Outdated threads surface
for a human to re-anchor or resolve.

**Suggestion-only threads never dispatch.** A ` ```suggestion ` block is a
mechanical edit GitHub commits with one button; spending an agent turn on it is
waste. Applying the suggestion marks the thread handled.

---

## Dedupe: 👀, Actor-Blind

```
unhandled(thread) ≡ !isResolved ∧ !isOutdated ∧ !hasEyes(firstComment)
```

The marker is the **👀 reaction on the thread's first comment**, and the
predicate performs **no identity join**. 👀 means *claimed, by whoever put it
there*: a human reacting 👀 says "I am handling this" and suppresses dispatch
exactly as the agent's own mark does. One signal, two writers, one meaning.

This was not the original design — 👀 appears as a genuine human reaction in
real threads, and the first proposal was a distinct bot identity to
disambiguate. Actor-blindness is the better answer, and everything that follows
from it is a feature:

- **No bot account, no GitHub App.** rk reacts as whoever is authenticated.
- **Un-reacting releases the claim** and the thread is eligible again next
  tick. This *is* the manual re-dispatch gesture — no extra UI.
- **The claim is legible on github.com** to a reviewer who never opens run-kit.

**"Check old comments too" needs no code.** Switch-on backfill is the identical
predicate: the backlog is every thread that is unresolved, not outdated, and
unmarked. No cursor, no cold-start rule, no seed file, no backfill path. This
is the single largest simplification the marking decision buys, and it is why
marking beat a local sidecar.

**Marking is ordered after delivery, never before.** `internal/inject` already
distinguishes a verified submit from `ProbeFailure` / `SubmitUnverified` — its
failure taxonomy splits on the Enter boundary. The reaction is posted only on a
verified submit, so a failed injection leaves the thread unmarked and it
re-dispatches next tick. Marking first would strand comments silently.

---

## The Listener

### Arm state

A per-window `@rk_win_pr_listen` option (`1` / unset), with a row in the
`@rk_<scope>_<name>` registry. **Per-window** because the unit of work is a
branch; **shared across viewers** because it is a fact about the work, not a
viewing posture — `surface-layout.md`'s substrate-vs-view-state test, and it
passes.

### Mechanism: a tracker sibling, not a cron entry

Modeled structurally on `api/operator_queue.go`'s `operatorQueueTracker` — own
mutex, clock seam, injected `deliver` closure (nil in test hubs, tracking still
advancing), advanced synchronously on the SSE per-server tick, reaped on the
post-loop retain seam. State is process memory only; a restart forgets in-flight
queueing and re-derives from `gh` on the next poll (Constitution II).

Cron was considered and rejected: its entries are user-authored, per-server,
disk-backed intent files with orphan GC. Synthesizing and reaping entry files as
a per-window toggle flips is churn against machinery built for a different
lifecycle.

But cron's **rules** are borrowed wholesale rather than reinvented:

- busy predicate `active | waiting`, read fresh at delivery time
- a per-window min-gap mirroring `operatorQueueMinGap` (60 s) — the rolled-up
  agent state lags an injection by a hook round-trip
- entry TTL, requeue-on-re-busy, drop-quietly on any other failure
- a per-window hourly rate cap and auto-disarm after repeated failures
  (the circuit-breaker precedent)

### Dispatch

**One thread per idle observation** — a twenty-comment review must not arrive as
a wall.

**Granularity is the thread, not the comment.** One thread is one unit of work;
the agent receives every comment in it, in order, so it has the argument and not
just the last line.

**Target** is the window whose pane resolves to that `(repoDir, branch)` —
already derived. With the window absent, v1 holds *without marking* so nothing
is lost, and does not respawn.

**Payload** is `pr-review-thread`: PR number and URL, file + line, the
surrounding hunk, every comment body in a dynamic bare fence (the `acceptsText`
fence-length rule), reviewer logins, thread URL, and the instruction to fix,
push, and resolve the thread when done.

It is a **sibling of** the closed operator template registry
(`api/operator.go`'s `operatorTemplates`), deliberately **not a row in it**, and
so it carries no registry id. Every entry in that map is an
operator-addressed, *client-selectable* id published through
`OperatorTemplateList()` / `rk operator request --list`; this payload is
server-initiated and addressed to the subject window's own agent. A row would
publish a template no client may request and would force an exclusion flag onto
every other entry. What it shares with the registry is the *rule*: plain string
composition, never `text/template`, so a fact cannot silently become a
directive.

### The loop guard

The obvious guard — excluding viewer-authored comments — is **wrong**: the user
commenting on their own PR is the primary use case, and an author filter would
break exactly what this builds.

The marker-based predicate is already sufficient. The agent's own reply does not
unmark the thread, so a replied-but-unresolved thread stays handled and never
re-fires; a new head sha unmarks nothing, because marks are per-comment.

**No auto-requeue on a new reply.** An earlier draft of § Comment States promised
that a reply after the mark re-queues the whole thread. That is rejected, and the
predicate deliberately cannot express it: a reply-triggered requeue fires on *the
agent's own reply* too, which is the exact feedback loop this section exists to
prevent — and the only way to exempt it is the author filter rejected above.
Re-queueing stays a human gesture: un-react 👀, and the thread is eligible on the
next tick. Any UI that claims otherwise is lying about the backend.

A `pr_review_listener` settings key (bool, default true, live) gates every tick,
shaped exactly like `cron_ticker` — a live background loop without a kill switch
is the anti-pattern that key exists to prevent.

---

## Constitution Mapping

- **I** — every `gh` call is `exec.CommandContext` with an explicit argv slice
  under a timeout; comment bodies go over stdin, never argv.
- **II** — nothing is stored server-side. The diff, the threads, and *handled-ness*
  are all derived from `gh` at request time; the marker lives on GitHub; arm
  state is a tmux option; viewed state is per-viewer localStorage. The in-memory
  caches are caches, and a cold start re-derives everything.
- **IV** — no new route; one new surface kind in the existing terminal route;
  tile growth still bounded by the size floor. One new settings-registry key, no new settings surface.
- **V** — every verb (toggle listen, next/previous file, expand, comment, reply,
  resolve, mark viewed, refresh) is palette-reachable.
- **IX** — reads are GET, every mutation is POST.
- **X** — review comments are derivable from `gh`, so they are polled
  server-side and never pushed by an agent hook.

**Dependencies.** One new Go module dependency —
`github.com/alecthomas/chroma/v2` (plus its pure-Go `dlclark/regexp2`
indirect). No CGO, no system libraries, no new frontend dependency at all.

The full ~280-lexer set ships. Measured on `rk` itself by building the same
tree twice with only the `chroma/v2/lexers` import swapped: **54 977 870 B with
it against 52 015 146 B without — +2 962 724 B (2.83 MiB), ~5.7 %**. A curated
subset (Go, TS/TSX, CSS, JSON, Markdown, shell, YAML) was rejected: 2.83 MiB
does not pay for capping the tile at the languages we guessed, and Chroma's Go,
Markdown and HTML lexers are *Go code* inside the `lexers` package rather than
XML, so curating means hand-porting them on every Chroma upgrade. The R5 ladder
degrades colour *precision*, never colour *presence* — a missing lexer degrades
to no colour at all, which is the outcome R5 exists to prevent.

---

## Prior Art

The highlighting and rendering approach is adapted from
[px0](https://github.com/px0-ai/px0) (MIT), whose internals docs are the
clearest published description of this problem. Ported ideas: windowed lexing
with leading and trailing context pads, the byte cap over the line cap, the
dual-tier background refinement with a `refine` flag, short token classes
coloured by CSS custom properties, the unified-hunk state machine that buckets
changed lines into post-image line numbers, the `data-l` / `data-at` row
addressing, `TreeWalker` decoration that preserves token markup, and
coordinate-based selection restore.

px0 is **not** a dependency and cannot be one: every file is `package main`
under a non-fetchable module path, and it is a server rather than a library.
The shared dependency is Chroma. Ported code carries attribution in its file
header.

Deliberately **not** adopted: px0's 512 MB cache budget (wrong for a daemon —
see R5), its path+mtime+size cache key (blob shas are strictly better), and its
non-virtualized diff view (correct for one file against `HEAD`, wrong for a
two-hundred-file PR — see R7). px0 has no review or comment layer, so nothing
in § Comment States or § Dedupe derives from it.

---

## What This Does Not Do

- **No split diff view** — unified only; follow-on. The row builders are
  nonetheless shape-agnostic (R7) so split lands as a row-shape variation
  rather than a second renderer.
- **No pre-PR review** — PR-backed only, by decision. A branch without a PR has
  no tile.
- **No batched-review authoring loop** — *Start a review* is supported, but a
  pending review is invisible to `gh` and therefore to the listener until
  submitted; the tile does not try to mirror pending state across viewers.
- **No respawn on an absent target** — the listener holds rather than
  resurrecting a window. Cron's `if_absent` respawn ladder is available later
  if the hold proves annoying.
- **No agent-authored resolution enforcement** — the agent is *asked* to resolve
  the thread when it pushes; nothing verifies that it did. The thread simply
  stays marked, and a human's new reply re-queues it.

---

## Phasing

One change, per the scope decision. Task ordering inside it:

| # | Slice |
|---|-------|
| 1 | Registry entry (`layoutspec` + `ViewName`), `hasReview`, toggle + availability dot, empty tile |
| 2 | Chroma spike: token→class table mapped onto `globals.css` custom properties, both themes; measure the lexer-set binary delta (§ Constitution Mapping → Dependencies) |
| 3 | `internal/prreview`: blob fetch, windowed lexer with context pads + byte cap, dual-tier refine, `(blobSha, path)` LRU with a daemon-sized budget and an idle-scavenge latch |
| 4 | `GET /api/pr/review` (file list only) + virtualized file rows, viewed checkboxes |
| 5 | `GET /api/pr/review/file` per-line token spans; unified rows with `data-l`/`data-side`/`data-at`; context expansion over the shared blob; `refine` swap; selection restore |
| 6 | Threads rendered inline via `TreeWalker` decoration; comment / reply / resolve write paths; suggestion blocks |
| 7 | `reviewThreads` folded into the prstatus batch; unread badge |
| 8 | `@rk_win_pr_listen`, the tracker, the `pr-review-thread` template, 👀 marking |
| 9 | Palette entries; Playwright e2e with `Proves:`/`Steps:` intent comments |
