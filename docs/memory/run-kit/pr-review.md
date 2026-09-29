---
description: "The `review` surface and the PR-comment listener: the PR-backed diff tile (server-side Chroma tokens, per-line spans, data-l/data-side/data-at anchoring, TreeWalker decoration, file-list virtualization, selection restore), the two-cadence split (prstatus digest / internal/prreview detail), the six comment states and their gh write paths, the actor-blind 👀 dedupe predicate, and the @rk_win_pr_listen tracker dispatching one unhandled thread per idle observation into the window's agent."
type: memory
---
# run-kit — PR Review Surface + Comment Listener

**Domain**: run-kit

## Overview

A window's branch already resolves to a pull request ([pr-status](/run-kit/architecture/pr-status.md)). The `review` surface renders that PR the way GitHub's "Files changed" tab does — file rows, expandable unified diffs, line-anchored comments — and the **comment listener** watches the PR's review threads and hands each unhandled one to the window's own agent as work to do. Spec: `docs/specs/pr-review.md`; `docs/wiki/review-comment-states.html` is the design authority for the comment states.

The surface is **PR-backed only**. No PR on the branch ⇒ no toggle, no tile, and no way to comment — which keeps the diff, the comments and the listener's input on **one substrate** and means no comment ever needs a run-kit-owned store (Constitution II).

```
 branch ──prstatus.BranchRefresher──▶ PR ──┬──▶ digest   (in the existing 90 s batch)
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

## The `review` Surface Kind

`review` is the fifth entry in the closed surface registry: `layoutspec.surfaceKindList` (Go) and `ViewName` / `SURFACE_KINDS` (TS, in both `layout-tree.ts` and `surface-layout.ts`), plus the template stand-in lists (`indexKinds` / `INDEX_KINDS`). It adds a kind, not a slot: tile growth stays bounded by the per-viewport size floor (Constitution IV). Like every kind but `gui` it may tile in another tab as a foreign `@N/review` leaf (`Tile: Bring <window> Changes here`); the foreign tile reads its HOME window's `prUrl` / `prReviewUnhandled` and binds none of the route window's seams (`reviewCommandsRef`, the unhandled/listening reporters), so the `Review:` palette family and the toggle dot always describe the route window's own bare tile. The internal kind is `review`, never `changes`: this repo already means a fab change by "changes" (`fab/changes/`, the sidebar change slug, "Active change"), and the two would collide in exactly the surfaces where both appear. The **user-facing** label is `Changes` (`SURFACE_LABEL.review`) and the glyph is `+-` (`SURFACE_GLYPH.review` — the diff's own sign pair, in the existing 2-char ASCII vocabulary beside `>_` / `://` / `{}` / `[]`).

**Availability** is `hasReview(win) ≡ (win?.prUrl ?? "").length > 0` — the branch-derived `prUrl` already rides the SSE window payload, so the lens adds no server-side derivation and no availability field. `availableTiles` pushes `review` last (the ⌘5 position); `HINT_ORDER` is `[code, gui, review, web, tty]`.

The toggle's **dot is not availability**. It means "threads are waiting on a human", so it reads the unhandled-thread count, which a closed tile cannot report. `WindowInfo.PrReviewUnhandled` (JSON `prReviewUnhandled`) carries it, joined by `sseHub.attachPRStatus` from the R3 digest as a pure in-memory read — collector-join-owned like `PrChecks`/`PrReview` (zeroed on every pass, re-attached for any window with a PR URL). A mounted tile's own count wins, because it reads the detail document rather than the 90 s digest. Full toggle mechanics: [top-bar](/run-kit/ui/top-bar.md) § Surface toggles; the renderer sits in [lenses-and-layout](/run-kit/ui/lenses-and-layout.md) § Review Surface.

## Two Cadences, Two Packages

The digest and the detail have opposite cost profiles and do not share a package.

| | Digest | Detail |
|---|---|---|
| Lives in | `internal/prstatus` (`prstatus_threads.go`) | `internal/prreview` |
| Cadence | every 90 s, every PR the viewer owns | on demand, only while a tile is mounted |
| Carries | `id`, `isResolved`, `isOutdated`, `path`, `line`, first comment's `id` + `databaseId` + `author.login` + 👀 count | file list, patches, full thread bodies, blobs, token spans |
| Keyed by | PR URL (`threadsByURL`) | PR URL, entry-carried head sha; blobs key `(blobSha, path)` |
| Extra `gh` subprocesses | none — rides the existing `viewer.pullRequests` query | one per mount, plus one per blob (shared between context expansion and lexing) |

Full bodies in the batch would multiply that payload by comment count across a 100-PR window every 90 s. Serving the listener from the detail fetcher would make the listener depend on a tile being open. Both package doc comments state the split so it does not read as duplication.

**`internal/prstatus`'s digest half** adds a `reviewThreads(first: 100) { … comments(first: 1) { … reactions(content: EYES, first: 1) } }` selection to the one batched `ghQuery`, and `refresh` rebuilds `threadsByURL` wholesale in the same critical section as `byURL`, so one snapshot always describes one batch. Readers: `Collector.ReviewThreads(prURL)` (copy of the slice) and `Collector.UnhandledThreads(prURL)` (predicate-filtered, gh order — oldest first, so a review dispatches in the order it was written). A thread with no comments is skipped: it has no marker target and cannot be described to an agent.

**`internal/prreview`** carries the posture `prstatus` proves: a `refreshMu` single-flighting whole passes including their subprocesses, a separate `mu` guarding `byURL` for readers that never spans a subprocess, stale-while-revalidate on error, an injectable `available func(ctx) bool` gate, and `exec.CommandContext` with explicit argv under `ghTimeout` = 10 s. `reviewTTL` = 60 s is a floor on gh volume, not a freshness promise — the tile also has an explicit refresh verb and revalidates off the SSE digest. A cold document is **two gh reads run concurrently** inside that single-flight pass: the file list over REST (only REST carries patches) and one GraphQL call answering threads, viewer login **and** the PR meta. Nothing flows between them — `ParsePRURL` is pure and runs before both — so the earlier serial form paid one round trip to wait for another, and a third for four scalars. Measured on an 84-file PR, both shapes back to back: **3.57–3.62 s serial against 1.29–2.22 s concurrent.** Error precedence is fixed at files-then-threads, because both share one ctx and a budget expiry fails both; reporting whichever goroutine lost the race would make one failure surface as a timeout on one run and a rate limit on the next. Cache shape is keyed **(prURL, headSha)** by construction: the map keys on URL and the entry carries its head sha, so a lookup naming a different head sha misses and the next fetch replaces the entry wholesale — keying the map itself by the pair would retain one document per push forever. Package inventory: [backend-packages](/run-kit/architecture/backend-packages.md).

Both packages take their gh-availability answer from `internal/ghprobe.Available(ctx, timeout)` — one stdlib-only probe (`LookPath("gh")` then `gh auth status`) so the two collectors cannot drift on what "gh is unavailable" means, each supplying its own timeout budget.

That answer is **memoized: 5 min on success, 30 s on failure**, single-flighted under one lock. The asymmetry is the point — "gh works" changes about once a month, while "gh is broken" is a fact the user is actively fixing, and a 5-minute negative memo would hide their own `gh auth login` from them. `LookPath` stays outside the memo (a filesystem check costing microseconds; caching it would make a gh installed mid-session invisible for the TTL). Why it matters: `gh auth status` is a **network call** — 0.34–0.39 s across ten consecutive runs, paid on every cold document, and twice observed at **30 s**. Since the caller's budget is `ghTimeout` = 10 s, that second shape cancels the probe and turns a working tile into "gh is unavailable". It costs no API budget, though: `core.remaining` reads 5000 before and after.

## Routes

Six endpoints under the existing `/api` prefix, no new page route (Constitution IV), reads GET and every mutation POST (Constitution IX). Handler contracts: [api-and-sockets](/run-kit/api-and-sockets.md) § API Layer.

```
GET  /api/pr/review?window={id}                              file list + threads + viewer login + listen arm
GET  /api/pr/review/file?window={id}&path=…&start=…&count=…  one file's rows as per-line token spans
POST /api/pr/review/comment                                  new comment | reply
POST /api/pr/review/thread                                   resolve | unresolve
POST /api/pr/review/listen                                   arm | disarm
POST /api/pr/review/refresh                                  on-demand refresh
```

The list and the body are **separate reads**: a 200-file PR renders its list without tokenizing any of it. Every user-authored body reaches `gh` as a JSON document on **stdin** (`gh api … --input -`), never argv (Constitution I). `path` is shape-validated with `validate.ValidatePath`, gated on `Review.FindFile` (the PR's own file set IS the authorization) on both the patch and context-expansion branches, and re-checked by `prreview.repoRelativePath` (rejects absolute paths, `.`/`..`/empty segments, NUL and newline) before it reaches the contents route.

## Highlighting — Server-Side Chroma

Tokenization runs in Go via `github.com/alecthomas/chroma/v2`. **The frontend ships no highlighting dependency at all.**

- **Windowed lexing, dual tier.** Tier 1 lexes a bounded window — the requested lines padded with `contextPadLines` = 60 each side, capped at `windowLines` = 200 — and slices out the target lines, answering `refine: true` when the leading pad did not reach the start of the blob. Tier 2 lexes blobs ≤ `refinePassByteCap` = 512 KiB end to end on a background goroutine and publishes `blobEntry.full`, so a later request answers `refine: false` with exact spans. The ladder degrades colour *precision*, never colour *presence*.
- **Byte cap inside the line cap.** Over `windowByteCap` = 256 KiB the context pads are dropped first; still over, the rows serve as single plain spans rather than blocking or erroring. Generated files with multi-megabyte single lines are what the byte cap exists for.
- **Pre-image / post-image.** Added and context rows lex against the head-sha blob, deleted rows against the base-sha blob. Lexing a hunk body as a standalone fragment is not permitted — it starts the lexer mid-file with the wrong state, which is what the pads prevent.
- **Token classes.** `tokenClass` walks Chroma's own `chroma.StandardTypes` table (falling back to a token type's `Parent()` when a dialect sub-type is unmapped), so the short class names (`k`, `nf`, `s`, `mi`, `c1`, `kd`, `kt`, `err`, …) are upstream's, not a second table that could drift. `lexerFor` resolves by filename via `lexers.Match` and treats a plaintext match as no lexer at all — the caller emits plain spans and skips the work. `FileBody.Highlighted` is false when nothing matched or the blob could not be read.
- **Colours live in `globals.css`.** `--rk-tok-*` custom properties per theme, scoped by a `.rk-tok` ancestor so a one-character class cannot collide with a utility class. Because run-kit's stylesheet owns the colours, both themes come free from the existing palette and the add/remove wash (`--rk-review-add-wash` / `-del-wash`, with the left bar as an inset box-shadow so row heights never jitter) composes underneath by construction.
- **Cache.** `blobCache` is an in-memory LRU keyed `(blobSha, path)` — blob shas are immutable, so a hit is always the exact bytes the sha names and the key can never invalidate wrongly. Budget `blobBudgetBytes` = 32 MiB, daemon-sized against rk's ~20 MB-class idle footprint. `note(sha, path, delta)` credits the refine footprint to the entry's own `bytes` under the cache lock, so eviction reclaims it. `scavenge` releases idle memory on a **latch** after `blobIdleWindow` = 60 s untouched — one release per idle period, not one per tick.

## Rows, Anchoring, and the Diff Body

**The line is the unit of the API** (`prreview.LineRow`, `FileBody`): the response is an array of per-line rows, never one HTML blob per file. A blob cannot be interleaved, and interleaving a composer, a thread card and an expander between line *N* and *N+1* is the comment layer's whole job. Each row carries its kind (`hunk`/`ctx`/`add`/`del`), its side, both gutter numbers, and its spans; the response carries `refine`, `totalLines`, `headSha`, `baseSha` and `highlighted`.

**The anchoring contract** is GitHub's own `(path, side, line)` tuple rendered as data attributes by `lib/review-rows.ts`'s `rowAttributes`:

| Attribute | On | Meaning |
|---|---|---|
| `data-l` | any row present on a side | the line number on that side |
| `data-side` | every code row | `L` (pre-image) or `R` (post-image) |
| `data-at` | deleted rows | the post-image line the deletion sat before |

A selection anywhere in the diff drives the composer from that tuple, and a thread fetched from `gh` finds its row without a second index (`rowMatchesThread`).

**Decoration is non-destructive.** `decorateMatches` walks a row's text nodes with a `TreeWalker`, splitting and wrapping matches in `.rk-review-mark`; `undecorate` unwraps them. Assigning `innerHTML` to add a marker would throw away the token spans the backend just computed and is not done anywhere. The production consumer marks a thread's backtick-quoted symbols on its anchored row.

**Virtualize the file list, not the diff body.** One file's diff is bounded by that file; the number of files in a PR is not. `ReviewSurface` mounts only the visible band (`FILE_ROW_HEIGHT` = 28 px, `FILE_OVERSCAN` = 6) over a spacer sized `files.length × FILE_ROW_HEIGHT` with the band translated into place, and each file's body is fetched lazily on expand. An **expanded file breaks the fixed-height assumption**, so once anything is expanded the list renders in full — a PR with an expanded file is one the user is reading, not scrolling past.

**Context expansion splices.** `GET /api/pr/review/file` with `start`/`count` answers with only the requested context rows (capped at `contextExpandMaxLines` = 1000 per response, separate from the 200-line lexing window), and `mergeContextRows` merges them into the file's existing rows — ordering incoming rows by post-image line, dropping lines already rendered, and removing a hunk header whose gap the expansion closed. The blob it reads is the same cached blob the lexer uses.

**Selection survives a repaint.** `saveSelection` records `{side, line, col}` file coordinates and `restoreSelection` resolves them back to (node, offset) by walking text nodes. A background refine swapping rows under an in-progress selection is the normal case, and that selection is usually about to be quoted into a comment.

**Mark as viewed** is per-viewer state in localStorage, keyed `rk-review-viewed:<prUrl>:<sha>:<path>` (Constitution IV's layering). The head sha in the key is what resets it on a new push, matching GitHub.

**Content states** (the availability-vs-reachability split `code` uses): `review-loading` while the first fetch is in flight, `review-error` when the document is unavailable (gh down, unauthenticated, no PR), `review-empty` when the PR changes no files, and the live list otherwise. A failed refresh over a live document renders a `review-banner` and keeps the document.

## Comment States and the Write Paths

`threadState` maps a thread that exists on GitHub onto four renderings; the remaining two rows of the design authority are not thread states.

| State | Rendering | Listener |
|---|---|---|
| Open, unmarked | expanded card | **eligible** — dispatches next tick |
| Open, marked 👀 | expanded, `→ dispatched` chip | held — un-react 👀 to re-queue |
| Open, new reply after the mark | still `→ dispatched` | **still held** — un-react 👀 to re-queue |
| Resolved | collapsed one-liner, dimmed, purple pill | terminal — never dispatched |
| Outdated | collapsed, amber pill, original hunk on demand | **never dispatched** |
| Pending review (unsubmitted) | local only, amber left edge (`.rk-review-pending`) | invisible to `gh` until submitted |

**Outdated never dispatches**: the agent would be handed a line number that no longer names the code the comment is about, producing a confident edit in the wrong place — strictly worse than dropping it. **Suggestion-only threads never dispatch**: `Thread.SuggestionOnly()` holds when *every* comment body is a ` ```suggestion ` fence with no prose outside it, which is a mechanical edit GitHub commits with one button. Applying a suggestion copies the replacement to the clipboard and resolves the thread — GitHub exposes no API for committing one, and resolve is the verb that marks a thread handled.

**The composer** anchors under its line, which takes `.rk-review-row-anchored` for the composer's lifetime, and carries the side+line ref in its header (`R264` right/new, `L120` left/old). Its footer is GitHub's two modes as a split button: *Add single comment* posts immediately, *Start a review* appends to the viewer's pending review. They differ for the listener — a pending review is invisible to `gh` until submitted — so the dispatch chip reads `⚡ dispatch on post` in single mode and `⊘ on review submit` in review mode, and it follows **hover and keyboard focus** across the two buttons so the review-mode chip is reachable *before* committing. ⌘/Ctrl+Enter submits the chip's mode. The sixth state lives in component memory as `PendingReviewComment`s for the mount only.

**Which API each write uses** is decided by which one expresses the operation: thread reads, resolve/unresolve and the pending-review path go through `gh api graphql`; single-comment creation, replies and the 👀 reaction go through `gh api` REST. *Start a review* finds-or-creates the viewer's single pending review (GitHub permits exactly one per viewer per PR) and appends via `addPullRequestReviewThread`.

## Dedupe: 👀, Actor-Blind

```
unhandled(t) ≡ !t.isResolved ∧ !t.isOutdated ∧ !hasEyes(t.firstComment)
```

`prstatus.Unhandled` is the backend predicate and `lib/review.ts`'s `isUnhandled` mirrors it, so the toggle's dot and the listener cannot disagree about what is outstanding. The marker is the **👀 reaction on the thread's first comment**, read with **no identity join**. 👀 means *claimed, by whoever put it there*: a human reacting 👀 says "I am handling this" and suppresses dispatch exactly as the listener's own mark does. Consequences:

- rk needs **no bot account and no GitHub App** — it reacts as whoever is authenticated.
- **Un-reacting releases the claim** and the thread is eligible on the next tick. That *is* the manual re-dispatch gesture; there is no other UI for it.
- The claim is **legible on github.com** to a reviewer who never opens run-kit.
- **Switch-on backfill needs no code.** The backlog is every thread the predicate admits — no cursor, no cold-start rule, no seed file, no separate backfill path.

**Marking is ordered after delivery.** The reaction is posted only on a verified submit (`inject.Engine.Send` returning nil — never on `inject.ProbeFailure` or `inject.SubmitUnverified`, whose taxonomy splits on the Enter boundary), so a failed injection leaves the thread unmarked and it re-dispatches on the next tick. Marking first would strand comments silently.

**The loop guard** is the predicate itself. Excluding viewer-authored comments would break the primary use case (a user commenting on their own PR), and a reply-triggered requeue would fire on the agent's own reply. The agent's reply does not unmark the thread, so a replied-but-unresolved thread stays handled; a new head sha unmarks nothing, because marks are per-comment.

## The Listener

**Arm state** is the per-window tmux option `@rk_win_pr_listen` (`"1"` armed, unset disarmed — only the exact `"1"` arms, so an unrecognized value fails closed). Per-window because the unit of work is a branch; shared across viewers because arming is a fact about the work, not a viewing posture. It rides the window payload as `WindowInfo.PrListen` so the SSE tick can advance the listener without a subprocess. Registry row and format-field position: [tmux-sessions](/run-kit/tmux-sessions.md) § Server-Scoped User Options.

**The mechanism is a tracker sibling**, `api/pr_review_listener.go`'s `prReviewListenerTracker`, modeled structurally on `api/operator_queue.go`'s `operatorQueueTracker`: its own mutex, a `now func() time.Time` clock seam, an injected `deliver` closure (nil in test hubs, with tracking still advancing), advanced synchronously on the SSE per-server tick (`pollServerUnit`) and reaped on the post-loop `retain` seam. State is process memory only — a daemon restart forgets in-flight queueing and re-derives from `gh` on the next poll (Constitution II); the 👀 marker on GitHub is the only durable record of what has been handled.

`advance` is level-triggered off one already-fetched server snapshot: for each armed window it refreshes the queue from the digest, expires stale entries, and reserves **at most one** thread for detached delivery — "one thread per idle observation", so a twenty-comment review does not arrive as a wall. A window that disarms or leaves the snapshot drops its queue; a re-arm re-derives the backlog from the same predicate.

Cron's delivery rules are borrowed with their constants:

| Knob | Value | Source of the number |
|---|---|---|
| `prListenQueueCap` | 8 pending threads per window | a larger review drains over successive ticks; nothing is lost, the queue is re-derived every tick |
| `prListenTTL` | 30 min | `operatorQueueTTL` |
| `prListenMinGap` | 60 s | `operatorQueueMinGap` — rolled-up agent state lags an injection by a hook round-trip |
| `prListenRatePerHour` | 30 | `cron.DefaultTargetRatePerHour` |
| `prListenFailureLimit` | 3 consecutive failures | enough to ride out one transient probe failure without spamming a broken pane |
| `prListenDeliverTimeout` | 60 s | bounds one detached delivery: detail fetch + injection + reaction write |

The busy predicate is cron's when-idle rule, `active | waiting`, read **fresh at delivery time** (`waiting` counts because a pane blocked on a human question would swallow the injection into its prompt). **Failure taxonomy** in `finishDelivery`: `errPRListenBusy`, `errPRListenAbsent` and `errPRListenUnavailable` requeue (the absent case holds **without marking**, so nothing is lost; the gh-outage case holds rather than counting toward the breaker, because an outage is not evidence that *this window* is broken); every other error drops quietly and counts toward the circuit breaker; success clears the counter. Tripping the breaker **latches** `prListenWindow.disarmed` and clears the option best-effort — latching rather than deleting the state is what stops a failed disarm write from letting the next tick rebuild a zero-failure state and re-trip forever. Only the option actually reading false clears the latch. With the target window absent, v1 holds and does not respawn.

**Target** is the window whose pane resolves to that `(repoDir, branch)`, already derived by `prstatus.BranchRefresher`; with several live windows on one pair, the most-recently-active pane-bearing window receives the dispatch. Delivery re-resolves the target from a fresh session fetch and re-checks the busy predicate before rendering.

**The payload** is `pr-review-thread`, rendered by `renderPRReviewThread` from `prReviewThreadFacts` — PR number and URL, repo, file + side + line, the surrounding hunk, every comment body oldest first, the thread URL (the first comment's permalink; GitHub has no thread-level permalink), and the instruction to fix, push and resolve the thread, or reply on it if it asks a question rather than requesting a change. It is a **sibling of** the closed operator template registry rather than a row in it, and carries no registry id (§ Design Decisions). Composition is plain string concatenation, never `text/template`, and every comment body and the hunk ride a dynamic bare fence (`fenceUserText`) — reviewer prose is data the agent must read, and a fixed fence is escapable by a body containing one. Registry contract: [operator-actuation](/run-kit/operator-actuation.md); injection engine: [agent-send](/run-kit/agent-send.md).

## Settings, Palette, and Chord

`pr_review_listener` (bool, default `true`, `live`, category `behavior`, `ui: true`) gates every listener tick, shaped exactly like `cron_ticker` — a live background loop without a kill switch is the anti-pattern that key exists to prevent. The tracker reads it through an injected `enabled func() bool` closing over `settings.Load()`, so a flip takes effect without a daemon restart. Registry inventory: [configuration](/run-kit/configuration.md).

Every verb is palette-reachable (Constitution V), which is load-bearing rather than ceremonial here: the surface's own affordances are pointer-first (a gutter `+`, a chevron, a checkbox), so the palette is the only keyboard route to most of them. `lib/palette/review.ts`'s `buildReviewActions(seams, listening)` builds nine `Review:` rows over the surface's imperative seams (`review-listen` — label naming the destination state — plus next/previous file, expand file, comment on focused line, reply, resolve, mark viewed, refresh), returning an empty array when the tile is not mounted, since a palette entry that predictably no-ops is worse than an absent one. `View: Changes` falls out of `VIEW_ACTION_LABEL` with no review-specific code, and `Tile: Show/Hide/Focus/Switch to Changes` ride the shared registry. The tile chord is `review-toggle` on `Digit5` (⌘5 / ⇧Ctrl+5), the next digit after gui's `Digit4`; `MAC_BROWSER_CMD_CLAIMS` already reserves `Digit1`–`Digit9`, so in a mac browser the chord is palette-only. Full chord table: [keyboard-and-palette](/run-kit/ui/keyboard-and-palette.md).

## Tests

Go: the prreview cache and its budget accounting, the lexer window and byte caps, the tier-2 refine under `-race` (`TestSpansForIsRaceFreeAcrossTheTier2Refine` — 8 goroutines × 20 reads), `repoRelativePath` traversal, the stdin-never-argv contract on every write path (`TestWritePathsSendBodiesOnStdinNeverArgv`, `TestPRReviewCommentSendsBodyOnStdin`), the uniform verbs (`TestPRReviewRoutesUseTheUniformVerbs`), the unhandled predicate, and the tracker's drain / requeue / cap / breaker-latch / gh-outage arms. Vitest: the diff row builders, `mergeContextRows`, the viewed store, the thread-state mapping and the palette builder. Playwright: `app/frontend/tests/e2e/pr-review.spec.ts`, ten tests, each with the `Proves:`/`Steps:` JSDoc the constitution requires.

## Design Decisions

### Chroma's full lexer set ships; no curated subset
**Decision**: import `github.com/alecthomas/chroma/v2/lexers` whole (~280 languages) rather than vendoring a curated subset of lexer XML.
**Why**: measured on `rk` itself (Go 1.25, linux/amd64, release ldflags, frontend embedded) by building the same tree twice with only the `lexers` import swapped — 54 977 870 B with the full set against 52 015 146 B without: **+2 962 724 B (2.83 MiB), ~5.7 %**. That does not pay for capping the tile at the languages we guessed, and Chroma's Go, Markdown and HTML lexers are *Go code* inside the `lexers` package rather than XML, so curating means hand-porting them on every Chroma upgrade. The R5 ladder degrades colour *precision*, never colour *presence* — a missing lexer degrades to no colour at all, which is the outcome the ladder exists to prevent.
**Rejected**: a curated `Go, TS/TSX, CSS, JSON, Markdown, shell, YAML` subset (saves 2.83 MiB, costs an unbounded "your language isn't supported" surface and a per-upgrade port); lazy-loading lexer XML from disk (a second distribution artifact, and Constitution II's derive-at-request-time posture does not extend to shipping data files).
*Introduced by*: 260919-55fx-pr-review-surface-listener

### The write paths speak GraphQL for threads and REST for comments
**Decision**: thread reads, resolve/unresolve and the *Start a review* path use `gh api graphql`; single-comment creation, replies and the 👀 reaction use `gh api` REST. Every one passes its body as JSON on stdin via `--input -`.
**Why**: REST has no thread object and no resolve verb — `isResolved`/`isOutdated` exist only in GraphQL — while REST's `POST /pulls/{n}/comments` and `…/comments/{id}/replies` are the only calls taking a `commit_id` anchor and a reply parent without a review wrapper. Using each API where it is the only one that expresses the operation avoids a translation layer; `--input -` is what keeps user prose out of argv.
**Rejected**: GraphQL-only (no reply-by-parent verb without constructing a review); REST-only (cannot resolve a thread, cannot read `isOutdated`); `-f body=…` on argv (puts user prose in the process table).
*Introduced by*: 260919-55fx-pr-review-surface-listener

### Context expansion splices into the diff; it is not a second view of the file
**Decision**: a ranged `GET /api/pr/review/file` answers with only the requested context rows, and the client merges them into the file's existing rows (`mergeContextRows`) instead of writing them over the body.
**Why**: the expander is an interleaving affordance — it splices between line *N* and *N+1*, beside the composer and the thread card. Treating a ranged response as the file's new body throws the unified diff away: hunk headers, add/del rows and their washes become a flat list of `ctx` rows, and because the body is cached, collapsing and re-expanding shows the context view again. The response is deliberately narrow, so the merge lives on the client — the side that knows what is on screen.
**Rejected**: returning the whole file re-diffed on every expansion (an unbounded response, which the 1 000-line cap exists to prevent); a second endpoint for "diff plus context" (a new route, Constitution IV).
*Introduced by*: 260919-55fx-pr-review-surface-listener

### `pr-review-thread` is a sibling of the operator template registry, with no id
**Decision**: the payload is rendered by `renderPRReviewThread` in `api/pr_review_listener.go` and is not a row in `api/operator.go`'s `operatorTemplates`. It carries no registry id at all.
**Why**: every entry in that map is an operator-addressed, *client-selectable* id published through `OperatorTemplateList()` / `rk operator request --list`. This payload is server-initiated and addressed to the subject window's own agent, so a row would publish a template no client may request and would force an exclusion flag onto every existing entry. What it borrows is the registry's *rule* — plain string composition, never `text/template`, so a fact cannot silently become a directive — and the dynamic bare fence for user prose.
**Rejected**: a real registry row plus per-entry exclusion flags (complexity paid by every existing template to describe one that is not addressable); an unreferenced template const standing in for the id (dead code claiming a registry membership that does not exist).
*Introduced by*: 260919-55fx-pr-review-surface-listener

### The unhandled-thread digest rides the window payload, not a tile report
**Decision**: `WindowInfo.PrReviewUnhandled` is joined onto each window by `sseHub.attachPRStatus` from `prstatus.Collector.UnhandledThreads`, alongside `prChecks`/`prReview`, and drives both the toggle's dot and the tile's revalidation. A mounted tile's own count still wins for the dot.
**Why**: the dot means "threads are waiting on a human", and a closed tile reports nothing — so without a server-side join the dot could only sit lit on availability, which is exactly what the unread badge is not. The join is a pure in-memory read of a digest the collector already polls, so it adds no `gh` call and keeps the SSE hot path subprocess-free. Availability stays `prUrl`-only; the unread count is a separate signal.
**Rejected**: leaving the dot dark until the tile reports (honest, but gives up the unread badge entirely); a second injection point for the digest (both halves are reads of one snapshot taken at the same moment).
*Introduced by*: 260919-55fx-pr-review-surface-listener

### The listener tracker lives in `api`, beside the queue it is modeled on
**Decision**: the tracker is `api/pr_review_listener.go`, not a member of `internal/prreview`.
**Why**: it needs the SSE tick's already-fetched session snapshot (for the busy predicate and target resolution) and the daemon's injection adapter, both of which live in `api`. `operatorQueueTracker` sits there for the same reasons, and reusing its shape means the `advance`/`retain` seams already exist on the hub.
**Rejected**: a tracker inside `internal/prreview` (inverts the dependency — the detail fetcher would have to import the session and injection layers).
*Introduced by*: 260919-55fx-pr-review-surface-listener

### The tile revalidates off the SSE digest, never a timer
**Decision**: `ReviewSurface` reloads on mount, on a window/PR change, on the pushed `prReviewUnhandled` count changing (first observation skipped so a mount does not double-fetch), and on the explicit refresh verb. There is no `setInterval` in the surface.
**Why**: the digest changing means a comment landed, was claimed or was resolved — i.e. the detail document is stale — and it arrives on a stream the client is already subscribed to. Polling from the client is the anti-pattern the SSE stream exists to remove.
**Rejected**: a tile-local poll (a second cadence over the same facts, and it would run while nothing changed).
*Introduced by*: 260919-55fx-pr-review-surface-listener

### The `→ re-queued` rendering does not exist
**Decision**: `threadState` emits `open`, `dispatched`, `resolved` or `outdated`; a marked thread reads `dispatched` whether or not a reply landed after the mark.
**Why**: the backend predicate is 👀-on-the-first-comment only, and a reply never clears it. A reply-triggered requeue would fire on the agent's own reply, which is the feedback loop the marker exists to prevent, and the only way to exempt it is the author filter that breaks the primary use case. Re-queueing stays a human gesture — un-react 👀. A UI claiming otherwise would be lying about the backend.
**Rejected**: a `requeued` state keyed on a reply newer than the mark (unimplementable without the rejected author filter).
*Introduced by*: 260919-55fx-pr-review-surface-listener

## Known Limits

These are properties of what ships, not open work items.

**GraphQL cost is priced on the `first:` values a query DECLARES, not on the rows it returns.** A nested connection is a fixed per-call price, paid identically by a PR with five threads and one with five hundred: `cost ≈ (outer first × inner first) / 100 + 1`. Measured against the live API on one PR: `reviewThreads(first: 100) × comments(first: 100)` = **101** points; `× comments(first: 20)` = 21; `× comments(first: 10)` = 11; `reviewThreads(first: 50) × comments(first: 20)` = 11; a query with no nested connection (PR meta, file list, `gh pr list`, the viewer batch) = 1.

This is not academic. The detail query shipped at `comments(first: 100)`, so **every tile mount cost 101 points**; a page reload cost ~106, ~36 reloads exhausted the 5 000/hour budget, and because that budget also carries the PR-status join, a review-surface feature took checks, review decision and draft state down across the whole app. The detail query is now bounded at `comments(first: 20)` (~21 per mount, measured ~23 per reload end to end); thread coverage stays at 100 because a truncated thread *list* hides feedback the reader never learns exists, while a thread truncated past its twentieth comment hides the tail of a conversation nobody reads in a side panel.

Two rules fall out, both learned the expensive way. **Never reason about cost in `gh` calls** — "it rides an existing call, so it is free" is true of subprocesses and false of points, and counting subprocesses is precisely what hid this: ~9 calls per reload looked far too cheap to be spending 100 points, because *one* of them declared a 10 000-node product. And **`gh api rate_limit` misreports both buckets** — it read `graphql: 0/5000 remaining` while GraphQL was fully exhausted, and `core: 0` while the REST header said 355; only `rateLimit { }` *inside* a GraphQL query and the `X-RateLimit-*` response headers are truthful. Polled queries therefore select `rateLimit { cost remaining }` and log it, warning below 1 000 remaining.

Steady-state burn, measured: idle ~206 points/hour (the digest's own 3-minute tick plus the branch refresher); a reload ~23; a daemon restart ~200 once, as every `(repoDir, branch)` pair is first-sight and resolves — which in development means every `just dev` rebuild.

**A tier-2 refine swap can be missed for the life of a mount.** `review-diff.tsx` re-requests a file exactly once on `refine: true` and latches that it has done so. On a large blob (under `refinePassByteCap`) the background pass can still be lexing when the retry arrives, in which case the server answers `refine: true` from tier 1 again and the tile keeps the possibly-guessed tier-1 colours until it remounts — on exactly the large files tier 2 exists for.

**Not attempted in v1**: split diff view (the row builders are shape-agnostic so it lands as a row-shape variation, not a second renderer); pre-PR review; mirroring pending-review state across viewers; respawning an absent target window; verifying that the agent actually resolved the thread. The `Origin` / DNS-rebinding audit of `/api/*` mutations is tracked as its own change.

## Prior Art

The highlighting and rendering approach is adapted from [px0](https://github.com/px0-ai/px0) (MIT), whose internals docs are the clearest published description of this problem. Ported: windowed lexing with leading and trailing context pads, the byte cap over the line cap, dual-tier background refinement with a `refine` flag, short token classes coloured by CSS custom properties, the unified-hunk state machine bucketing changed lines into post-image line numbers, `data-l` / `data-at` row addressing, `TreeWalker` decoration that preserves token markup, and coordinate-based selection restore. Ported code carries attribution in its file header.

px0 is not a dependency and cannot be one: every file is `package main` under a non-fetchable module path, and it is a server rather than a library. The shared dependency is Chroma. Deliberately not adopted: px0's 512 MB cache budget (wrong for a daemon), its path+mtime+size cache key (blob shas are immutable and strictly better), and its non-virtualized diff view (correct for one file against `HEAD`, wrong for a two-hundred-file PR — the unbounded axis inverts). px0 has no review or comment layer, so nothing in § Comment States or § Dedupe derives from it.
