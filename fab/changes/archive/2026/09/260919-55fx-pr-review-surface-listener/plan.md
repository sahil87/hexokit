# Plan: PR Review Surface + Comment Listener

**Change**: 260919-55fx-pr-review-surface-listener
**Intake**: `intake.md`

## Requirements

> Normative source: `docs/specs/pr-review.md` (R1–R7 below keep that spec's
> numbering); `docs/wiki/review-comment-states.html` is normative for R8.
> R9–R12 cover the spec sections the spec numbers prose-only (§ Dedupe,
> § The Listener, § Constitution Mapping → V, § Phasing slice 9).

### Surface Registry: the `review` kind

#### R1: One kind appended to the closed surface registry
The backend surface registry (`app/backend/internal/layoutspec/layoutspec.go`
`surfaceKinds`) and the frontend lens registry
(`app/frontend/src/lib/window-view.ts` `ViewName`,
`app/frontend/src/lib/surface-layout.ts` `SURFACE_KINDS`) SHALL each gain
exactly one entry, `review`. Tile arity SHALL remain ≤3 (Constitution IV).
The internal kind MUST be `review`, never `changes`.

- **GIVEN** a window option `@rk_win_layout` of `split-h:tty,review`
- **WHEN** it is validated by `layoutspec.Parse` or `parseLayout`
- **THEN** both accept it and round-trip it byte-identically
- **AND** `layoutspec.Add` still returns `ErrLayoutFull` at three tiles

#### R2: Availability is derived from the already-present `prUrl`
`hasReview(win)` SHALL be `(win?.prUrl ?? "").length > 0` and SHALL add no new
SSE field and no new server-side derivation. The window's `prUrl` already rides
the SSE payload from `prstatus.BranchRefresher`. `availableTiles` SHALL include
`review` exactly when `hasReview` holds, and `HINT_ORDER` SHALL gain `review`.

The toggle's **dot** is a separate signal and is explicitly NOT availability: it
means "threads are waiting on a human", so it reads the unhandled-thread count.
A closed tile cannot report one, so the count SHALL ride the window payload as
`WindowInfo.PrReviewUnhandled`, joined by the SSE hub from the R3 digest as a
pure in-memory read (no additional `gh` call), with the same
collector-join-owned reset semantics as `PrChecks`/`PrReview`. A mounted tile's
own count SHALL win over it. This is a badge field, not an availability field —
`hasReview` stays `prUrl`-only.

- **GIVEN** a window whose branch has no pull request
- **WHEN** the top bar renders its surface-toggle group
- **THEN** no `review` button is rendered and the tile is unreachable
- **AND** an existing `@rk_win_layout` naming `review` degrades that tile away

- **GIVEN** a window with a PR, no review tile open, and every thread claimed
- **WHEN** the SSE tick joins the digest onto the window payload
- **THEN** `prReviewUnhandled` is 0 and the toggle's dot is dark
- **AND** `hasReview` still holds, so the toggle itself is still offered

### Backend: two cadences, two packages

#### R3: Digest in `prstatus`, detail in a new `internal/prreview`
The review-thread **digest** SHALL ride the existing batched
`viewer.pullRequests` GraphQL query in `internal/prstatus` and SHALL add **zero**
additional `gh` calls, carrying per thread only `id`, `isResolved`,
`isOutdated`, `path`, `line`, and the first comment's `id`, `author.login` and
`reactions(content: EYES)`. The **detail** (file list, patches, full thread
bodies) SHALL live in a new package `internal/prreview`, fetched on demand and
keyed `(prURL, headSha)`. `internal/prreview` SHALL carry `prstatus`'s posture:
a `refreshMu` single-flight held across subprocesses, a separate `mu` guarding
the map that never spans a subprocess, stale-while-revalidate on error, an
injectable `available func(ctx) bool` gate, and `exec.CommandContext` with
explicit argv slices under a 10 s timeout. A comment in each package SHALL state
why the split exists.

- **GIVEN** the 90 s collector tick runs with two PRs carrying five threads each
- **WHEN** `Collector.refresh` completes
- **THEN** exactly one `gh` subprocess has run
- **AND** `Collector.ReviewThreads(prURL)` returns the ten thread digests

#### R4: Reads are GET, mutations are POST, bodies go over stdin
The API SHALL expose exactly these endpoints, all under the existing `/api`
prefix and adding no page route:

```
GET  /api/pr/review?window={id}                       file list + stats + threads + viewer login
GET  /api/pr/review/file?window={id}&path=…&start=…&count=…   one file's rows as per-line token spans
POST /api/pr/review/comment                           new comment | reply
POST /api/pr/review/thread                            resolve | unresolve
POST /api/pr/review/listen                            arm | disarm
POST /api/pr/review/refresh                           on-demand refresh
```

Every `gh` invocation SHALL use `exec.CommandContext` with an explicit argv
slice under a timeout. Every request body carrying user-authored prose SHALL
reach `gh` over **stdin** (`gh api … --input -`), never argv.

- **GIVEN** a comment body containing `$(rm -rf /)` and a newline
- **WHEN** `POST /api/pr/review/comment` handles it
- **THEN** the body reaches `gh` as JSON on stdin and never appears in argv
- **AND** the created comment's text is byte-identical to the submitted body

### Rendering

#### R5: Highlighting is a backend concern (Chroma), windowed, dual-tier
Tokenization SHALL run in Go via `github.com/alecthomas/chroma/v2`. The frontend
SHALL ship no highlighting dependency. Tier 1 SHALL lex a bounded window — the
requested line range padded with context lines on each side — and slice out the
target lines, returning `refine: true` when the leading pad did not reach the
start of the blob. Tier 2 SHALL lex small blobs end to end on a background
goroutine and populate the cache so a later request returns `refine: false`.
The window SHALL be capped in **bytes as well as lines**: over the byte cap
context is dropped first, and past that the lines serve unhighlighted. Added and
context lines SHALL be lexed against the post-image (head sha) blob and removed
lines against the pre-image (base sha) blob; lexing a hunk body as a standalone
fragment is forbidden. Token types SHALL map to Chroma's short class names
(`k`, `nf`, `s`, `m`, `c`, `kd`, `kt`, `err`, …) coloured by CSS custom
properties in `globals.css` for both themes. The token cache SHALL key
`(blobSha, path)`, be in-memory, LRU and byte-budgeted at a daemon-sized budget,
and SHALL release idle memory on a latch.

- **GIVEN** a 5 000-line Go blob and a request for lines 2 000–2 060
- **WHEN** tier 1 lexes it
- **THEN** only the padded window is lexed, the response carries
  `refine: true`, and the 61 requested rows carry token spans
- **AND** after the background pass a repeat request returns `refine: false`

- **GIVEN** a blob whose padded window exceeds the byte cap
- **WHEN** tier 1 runs
- **THEN** the context pads are dropped first, and if still over the cap the
  rows serve as single plain spans rather than blocking or erroring

#### R6: The line is the unit of the API, and rows carry their addressing
`GET /api/pr/review/file` SHALL return an array of per-line rows — never one
HTML blob per file — each row carrying its token spans, its row kind
(`add`/`del`/`ctx`), its side and its line numbers. Every rendered code row SHALL
carry `data-l` (the line number on its side), `data-side` (`L`/`R`), and, on
deleted rows, `data-at` (the post-image line the deletion sat before). Comment
markers, selection highlights and suggestion ranges SHALL be applied with a
`TreeWalker` over the rows' text nodes; rewriting a row's `innerHTML` is
forbidden.

- **GIVEN** a unified hunk `@@ -10,3 +10,4 @@` with one deletion and two additions
- **WHEN** the rows are built
- **THEN** the deleted row carries `data-side="L"`, its own `data-l`, and a
  `data-at` naming the post-image line it sat before
- **AND** decorating that row with a comment marker leaves its token `<span>`
  elements intact

#### R7: Virtualize the file list, not the diff body; selection survives repaint
The file list SHALL be virtualized and each file's diff fetched and rendered
lazily on expand; an expanded file's diff SHALL render as plain DOM. Selection
SHALL be saved as `{line, col}` file coordinates before a repaint and restored
by walking text nodes afterwards. Row builders (hunk header, line numbers,
marker cell, code cell) SHALL be shape-agnostic so a later split view is a
row-shape variation rather than a second renderer. **Mark as viewed** SHALL be
per-viewer localStorage keyed `rk-review-viewed:<prUrl>:<sha>:<path>`.

- **GIVEN** a PR with 200 files
- **WHEN** the tile mounts
- **THEN** no file body is fetched and only the visible file rows are in the DOM

- **GIVEN** an in-progress selection inside an expanded file
- **WHEN** a background refine swaps that file's rows
- **THEN** the selection is restored to the same `{line, col}` range

### Comment States

#### R8: Every comment state renders and dispatches per the design authority
The tile SHALL render the six states of
`docs/wiki/review-comment-states.html` — open/unmarked, open/marked 👀 (with a
`→ dispatched` chip), open with a new reply after the mark (chip cleared),
resolved (collapsed, dimmed, purple pill), outdated (collapsed, amber pill),
pending-review (local only, amber left edge). The composer SHALL anchor under
its line, outline that line for its lifetime, carry the side+line ref in its
header (`R264` / `L120`), and offer GitHub's two modes as a split button —
*Add single comment* (posts immediately, chip `⚡ dispatch on post`) and
*Start a review* (batches into a pending review, chip dimmed to
`⊘ on review submit`). Suggestion blocks SHALL render as a mini-diff with an
Apply button. Outdated threads SHALL never dispatch; resolved threads are
terminal; suggestion-only threads SHALL never dispatch.

- **GIVEN** a thread that is outdated and unresolved and unmarked
- **WHEN** the listener evaluates eligibility
- **THEN** the thread is not eligible and is rendered collapsed with an amber pill

#### R9: Dedupe is the 👀 reaction, actor-blind, marked after delivery
The eligibility predicate SHALL be
`unhandled(t) ≡ !t.isResolved ∧ !t.isOutdated ∧ !hasEyes(t.firstComment)` and
SHALL perform **no identity join** — a 👀 from any actor suppresses dispatch and
removing it releases the claim. Switch-on backfill SHALL be the identical
predicate with no cursor, seed file or separate backfill path. The 👀 reaction
SHALL be posted only **after** a verified submit (`inject.Engine.Send` returning
nil — never on `inject.ProbeFailure` or `inject.SubmitUnverified`).

- **GIVEN** an injection that fails its novelty probe
- **WHEN** delivery returns `inject.ProbeFailure`
- **THEN** no reaction is posted and the thread is eligible again next tick

### The Listener

#### R10: Arm state is a tmux option; delivery is a tracker sibling
Arm state SHALL be the per-window tmux option `@rk_win_pr_listen` (`1` / unset),
registered in the `@rk_<scope>_<name>` registry. The listener SHALL be a tracker
modeled structurally on `api/operator_queue.go`'s `operatorQueueTracker` — own
mutex, `now func() time.Time` clock seam, injected `deliver` closure (nil in
test hubs with tracking still advancing), advanced synchronously on the SSE
per-server tick, reaped on the post-loop retain seam — holding process memory
only. It SHALL borrow cron's delivery rules: a busy predicate of
`active | waiting` read fresh at delivery time, a per-window min-gap of 60 s
mirroring `operatorQueueMinGap`, an entry TTL, requeue-on-re-busy, quiet drop on
any other failure, a per-window hourly rate cap, and auto-disarm after repeated
dispatch failures. It SHALL dispatch **one thread per idle observation**, at
**thread** granularity, into the window's own agent pane. With the target window
absent it SHALL hold **without marking** and SHALL NOT respawn. The payload
SHALL be `pr-review-thread`, a **sibling of** the closed operator template
registry rather than a row in it — it is server-initiated and agent-addressed,
so it is not client-selectable and carries no registry id (see § Design
Decisions) — borrowing that registry's plain-string-composition rule and its
dynamic bare fence. It SHALL carry the PR number and URL, file + line, the
surrounding hunk, every comment body in a dynamic bare fence, the reviewer
logins, the thread URL, and the instruction to fix, push and resolve the thread.

- **GIVEN** an armed window with three unhandled threads and an idle agent
- **WHEN** three SSE ticks separated by more than the min-gap elapse
- **THEN** exactly one thread is delivered per tick, in order
- **AND** each delivered thread's first comment carries 👀 afterwards

- **GIVEN** an armed window whose agent pane is `active`
- **WHEN** the tick advances the tracker
- **THEN** nothing is delivered and nothing is marked

#### R11: A settings key gates the tick and every verb is palette-reachable
A `pr_review_listener` bool key (default `true`, live) SHALL be added to the
`internal/settings` registry, shaped exactly like `cron_ticker`, and SHALL gate
every listener tick. Every new verb — toggle listen, next/previous file, expand
file, add comment on the focused line, reply, resolve thread, mark viewed,
refresh — SHALL be registered in the command palette (Constitution V).

- **GIVEN** `pr_review_listener: false` in `config.yaml`
- **WHEN** an SSE tick advances the listener tracker
- **THEN** nothing is queued and nothing is delivered

#### R12: Tests carry their intent comments
Every new Playwright `test()` SHALL carry a JSDoc block with **Proves:** and
**Steps:**, and every new spec file SHALL open with a file-header comment
covering shared setup. Go unit tests SHALL cover the prreview cache and lexer
window, the unhandled predicate, and the tracker's drain/requeue/cap; Vitest
SHALL cover the diff row builders, the viewed store and the palette builder.

- **GIVEN** the new e2e spec file
- **WHEN** a reviewer reads it
- **THEN** each `test()` states what it proves and the steps it takes

### Non-Goals

- Split diff view — unified only; the row builders stay shape-agnostic so split
  lands later as a row-shape variation.
- Pre-PR review — PR-backed only; a branch with no PR renders no tile.
- A batched-review authoring loop — *Start a review* creates/extends the
  viewer's pending review, but pending state is not mirrored across viewers.
- Respawning an absent target window.
- Verifying that the agent actually resolved the thread.
- The `Origin`/DNS-rebinding audit of `/api/*` mutations — tracked as its own
  change per the intake's deferred note.

### Design Decisions

#### Ship Chroma's full lexer set rather than a curated subset
**Decision**: import `github.com/alecthomas/chroma/v2/lexers` whole (~280
languages) instead of vendoring a curated subset of lexer XML.
**Why**: measured directly on `rk` itself (Go 1.25, linux/amd64, the release
ldflags, frontend embedded), building the same tree twice with only the
`chroma/v2/lexers` import swapped out — **54 977 870 B with the full lexer set
against 52 015 146 B without it: +2 962 724 B (2.83 MiB), ~5.7 %**. An isolated
A/B on a bare binary agrees to within 7 KB (baseline 2 405 753 B → 7 556 216 B
with the full set, → 4 446 703 B with `chroma/v2` core plus five hand-embedded
lexer XML files), so the lexer set costs 2.83 MiB and Chroma's core + `regexp2`
— which a curated build needs too — costs the remaining ~2.2 MiB either way.
2.83 MiB is not worth what curating costs: a curated set caps the tile at the
languages we guessed, and Chroma's Go/Markdown/HTML lexers are *Go code* inside
the `lexers` package rather than XML, so curating means hand-porting them and
re-porting them on every Chroma upgrade. Worse, R5's whole ladder degrades
colour *precision*, never colour *presence*; a missing lexer degrades to no
colour at all, which is the outcome R5 exists to prevent.
**Rejected**: embedding a curated `Go, TS/TSX, CSS, JSON, Markdown, shell, YAML`
subset (saves 2.83 MiB, costs an unbounded "your language isn't supported"
surface and a per-upgrade port of the Go-coded lexers); lazy-loading lexer XML
from disk at runtime (a second distribution artifact, and Constitution II's
derive-at-request-time posture does not extend to shipping data files).
*Introduced by*: 260919-55fx-pr-review-surface-listener

#### The write paths speak GraphQL for threads and REST for comments
**Decision**: thread reads, resolve/unresolve, and the *Start a review* path use
`gh api graphql`; single-comment creation, replies and the 👀 reaction use
`gh api` REST endpoints. Every one passes its body as JSON on **stdin** via
`gh api … --input -`.
**Why**: REST has no resolve/unresolve verb and no thread object at all —
`isResolved`/`isOutdated` exist only in GraphQL — while REST's
`POST /pulls/{n}/comments` and `…/comments/{id}/replies` are the only calls that
take a `commit_id` anchor and a reply parent without a review wrapper. Using
each API where it is the only one that expresses the operation avoids a
translation layer. `--input -` is what keeps user prose out of argv
(Constitution I).
**Rejected**: GraphQL-only (no reply-by-parent verb without constructing a
review); REST-only (cannot resolve a thread, cannot read `isOutdated`);
`-f body=…` on argv (puts user prose in the process table).
*Introduced by*: 260919-55fx-pr-review-surface-listener

#### Context expansion SPLICES into the diff; it is not a second view of the file
**Decision**: `GET /api/pr/review/file` with `start`/`count` answers with only
the requested context rows, and the client merges them into the file's existing
rows (`lib/review-rows.ts` `mergeContextRows`) rather than writing them over the
body. Lines the diff already renders are dropped from the incoming set, and a
hunk header whose gap the expansion closes is removed.
**Why**: R6/R7 make the expander an interleaving affordance — it splices between
line N and line N+1, beside the composer and the thread card. Treating a ranged
response as the file's new body throws the unified diff away: hunk headers,
add/del rows and their washes are replaced by a flat list of `ctx` rows, and
because the body is cached, collapsing and re-expanding shows the context view
again. The response is deliberately narrow (only the lines asked for), so the
merge has to live on the client, which is the side that knows what is on screen.
**Rejected**: returning the whole file re-diffed on every expansion (an
unbounded response, which the 1 000-line cap exists to prevent); a second
endpoint for "diff plus context" (a new route, Constitution IV).
*Introduced by*: 260919-55fx-pr-review-surface-listener

#### `pr-review-thread` is a SIBLING of the operator template registry, with no id
**Decision**: the listener's payload is rendered by `renderPRReviewThread` in
`api/pr_review_listener.go` and is **not** a row in `api/operator.go`'s
`operatorTemplates`. It carries no registry id at all.
**Why**: every entry in that map is an operator-addressed, CLIENT-SELECTABLE id
published through `OperatorTemplateList()` / `rk operator request --list`. This
payload is server-initiated and addressed to the subject window's own agent, so
a row would publish a template no client may request and would force an
exclusion flag onto every other entry. What it does borrow is the registry's
RULE — plain string composition, never `text/template`, so a fact cannot
silently become a directive — and the dynamic bare fence for user prose.
**Rejected**: a real registry row plus per-entry exclusion flags (complexity
paid by every existing template to describe one that is not addressable); an
unreferenced `prReviewThreadTemplate` const standing in for the id (dead code
claiming a registry membership that does not exist — deleted).
*Introduced by*: 260919-55fx-pr-review-surface-listener

#### The unhandled-thread digest rides the window payload, not a tile report
**Decision**: `WindowInfo.PrReviewUnhandled` is joined onto each window by
`sseHub.attachPRStatus` from `prstatus.Collector.UnhandledThreads`, alongside
`prChecks`/`prReview`, and drives both the review toggle's dot and the tile's
revalidation. A MOUNTED tile's own count still wins for the dot.
**Why**: the dot means "threads are waiting on a human", and a closed tile
reports nothing — so without a server-side join the dot could only sit lit on
availability, which is exactly what spec § Phasing slice 7's unread badge is
not. The join is a pure in-memory read of a digest the collector already polls,
so it adds no `gh` call and keeps the SSE hot path subprocess-free. R2's
"no new SSE field" governs AVAILABILITY (`hasReview` still keys off `prUrl`
alone); the unread count is a separate signal.
**Rejected**: leaving the dot dark until the tile reports (honest, but gives up
the unread badge entirely); a second injection point for the digest (both halves
are reads of one snapshot taken at the same moment).
*Introduced by*: 260919-55fx-pr-review-surface-listener

#### The listener tracker lives in `api`, beside the queue it is modeled on
**Decision**: the tracker is `api/pr_review_listener.go`, not a member of
`internal/prreview`.
**Why**: it needs the SSE tick's already-fetched session snapshot (for the busy
predicate and target resolution) and the daemon's injection adapter — both of
which live in `api`. `operatorQueueTracker` sits there for exactly the same
reasons, and reusing its shape means the `advance`/`retain` seams already exist
on the hub.
**Rejected**: a tracker inside `internal/prreview` (would invert the dependency:
the detail fetcher would have to import the session and injection layers).
*Introduced by*: 260919-55fx-pr-review-surface-listener

## Tasks

### Phase 1: Registry, dependency, and the empty tile

- [x] T001 Add `github.com/alecthomas/chroma/v2` to `app/backend/go.mod` (and its `dlclark/regexp2` indirect) via `go get`; run `go mod tidy` <!-- R5 -->
- [x] T002 [P] Append `"review": true` to `surfaceKinds` in `app/backend/internal/layoutspec/layoutspec.go` and extend the kind list in `app/backend/internal/layoutspec/layoutspec_test.go` <!-- R1 -->
- [x] T003 [P] Add `review` to `ViewName` and `hasReview` to `app/frontend/src/lib/window-view.ts`; add `review` to `HINT_ORDER` and to `availableViews` <!-- R1 R2 -->
- [x] T004 Add `review` to `SURFACE_KINDS`, `SURFACE_LABEL` ("Changes"), `SURFACE_GLYPH` (`+-`) and `availableTiles` in `app/frontend/src/lib/surface-layout.ts` <!-- R1 R2 -->
- [x] T005 [P] Add the `review-toggle` binding (`Digit5`, same tier/scope shape as `gui-toggle`) to `app/frontend/src/lib/keybindings.ts` <!-- R11 -->
- [x] T006 [P] Add `PrListenOption = "@rk_win_pr_listen"` to `app/backend/internal/tmux/tmux.go`'s option-name constants <!-- R10 -->
- [x] T007 [P] Add the `pr_review_listener` bool key (default true, live, category `behavior`) to `app/backend/internal/settings/settings.go` and update the inventory assertions in `app/backend/internal/settings/registry_test.go`, `settings_test.go` and `app/backend/api/settings_test.go` <!-- R11 -->

### Phase 2: `internal/prreview` — the detail fetcher

- [x] T008 Create `app/backend/internal/prreview/prreview.go`: package doc stating the digest/detail split rationale, `ParsePRURL` (owner/repo/number), the `ghExec`/`available` seams, `ghTimeout`, and the `Fetcher` struct with `refreshMu`/`mu` <!-- R3 -->
- [x] T009 Add `app/backend/internal/prreview/files.go`: PR metadata (`head.sha`, `base.sha`) + `gh api repos/{o}/{r}/pulls/{n}/files --paginate` decode into `FileEntry{Path, PreviousPath, Status, Additions, Deletions, Patch, Sha}` <!-- R3 R4 -->
- [x] T010 Add `app/backend/internal/prreview/threads.go`: the GraphQL `reviewThreads` detail query (full comment bodies, reactions, urls) decoded into `Thread`/`Comment` <!-- R3 R8 -->
- [x] T011 Add `app/backend/internal/prreview/cache.go`: the `(prURL, headSha)` review cache plus the byte-budgeted LRU `(blobSha, path)` token/blob cache with an idle-scavenge latch <!-- R5 -->
- [x] T012 Add `app/backend/internal/prreview/blob.go`: `gh api repos/{o}/{r}/contents/{path}?ref={sha}` base64 blob fetch shared by context expansion and lexing, cached by `(blobSha, path)` <!-- R5 R7 -->
- [x] T013 Add `app/backend/internal/prreview/highlight.go`: Chroma token→short-class mapping over `chroma.StandardTypes` with parent-walk fallback, and `LexWindow(path, blob, start, count)` implementing the leading/trailing context pads, the byte cap (drop context first, then serve plain), and the `refine` flag <!-- R5 -->
- [x] T014 Add the tier-2 background refine pass to `app/backend/internal/prreview/highlight.go`: a bounded goroutine that lexes small blobs end to end into the cache so a repeat request answers `refine: false` <!-- R5 -->
- [x] T015 Add `app/backend/internal/prreview/hunks.go`: the unified-patch state machine producing `Row{Kind, LeftLine, RightLine, At, Side}` with hunk headers, bucketing deletions onto the post-image line they preceded <!-- R6 -->
- [x] T016 Add `app/backend/internal/prreview/rows.go`: join `hunks.go` rows with `highlight.go` spans — added/context rows against the head blob, removed rows against the base blob — into the wire `LineRow{kind, side, l, at, spans[]}` <!-- R5 R6 -->
- [x] T017 Add `app/backend/internal/prreview/write.go`: `AddComment` (REST `pulls/{n}/comments`), `Reply` (REST `…/comments/{id}/replies`), `StartReview` (GraphQL find-or-create pending review + `addPullRequestReviewThread`), `ResolveThread`/`UnresolveThread` (GraphQL), `MarkEyes` (REST reactions) — all bodies as JSON on **stdin** via `gh api … --input -` <!-- R4 R8 R9 -->
- [x] T018 Add `app/backend/internal/prreview/prreview_test.go` covering `ParsePRURL`, the hunk state machine, `LexWindow` window/byte-cap/refine behavior, the token-class mapping, the LRU budget, and the argv-vs-stdin contract of the write paths <!-- R3 R4 R5 R6 -->

### Phase 3: The digest in `prstatus`

- [x] T019 Extend `ghQuery` in `app/backend/internal/prstatus/prstatus.go` with `reviewThreads(first: 100)` selecting `id/isResolved/isOutdated/path/line` and the first comment's `id/author.login/reactions(content: EYES)`; add the `ReviewThread` projection and `ghPR` decode fields <!-- R3 -->
- [x] T020 Add the `byURL`-parallel `threadsByURL` map to `Collector` (rebuilt wholesale in the same critical section) plus `ReviewThreads(prURL) []ReviewThread` and `Unhandled(prURL) []ReviewThread`, with the actor-blind predicate as a pure exported helper <!-- R3 R9 -->
- [x] T021 Extend `app/backend/internal/prstatus/prstatus_test.go` with digest-parse and predicate table tests (resolved / outdated / eyes-by-any-actor / eligible) <!-- R3 R9 -->

### Phase 4: The API routes

- [x] T022 Add `app/backend/api/pr_review.go`: the shared window→(prURL, repoDir) resolution, `handlePRReview` (GET list + threads + viewer login) and `handlePRReviewFile` (GET windowed rows) <!-- R4 R6 -->
- [x] T023 Add the mutation handlers to `app/backend/api/pr_review.go`: `handlePRReviewComment`, `handlePRReviewThread`, `handlePRReviewListen` (writes/clears `@rk_win_pr_listen`), `handlePRReviewRefresh` (mirrors `/api/status/refresh`'s detached + coalesced + throttled shape) <!-- R4 R10 -->
- [x] T024 Register the six routes in `app/backend/api/router.go` beside the existing `/api/status/refresh` block <!-- R4 -->
- [x] T025 Add `app/backend/api/pr_review_test.go`: route method/verb conformance (GET reads, POST mutations), missing-window 404, no-PR 404, and body-over-stdin assertions through a recording `gh` seam <!-- R4 -->

### Phase 5: The listener

- [x] T026 Add `app/backend/api/pr_review_listener.go`: `prReviewListenerTracker` modeled on `operatorQueueTracker` — mutex, `now` clock seam, injected `deliver`, per-window queue keyed by thread id, TTL, 60 s min-gap, hourly rate cap, failure counter with auto-disarm, `advance(server, snapshot)` and `retain(live, observed)` <!-- R10 -->
- [x] T027 Add the `pr-review-thread` payload renderer to `app/backend/api/pr_review_listener.go`: PR number + URL, file + line, the surrounding hunk, every comment body in a dynamic bare fence (reusing `fenceUserText`), reviewer logins, thread URL, and the fix/push/resolve instruction <!-- R10 -->
- [x] T028 Wire delivery: resolve the target window for `(repoDir, branch)` from the tick snapshot, gate on `@rk_win_pr_listen` + the `pr_review_listener` setting + the `active|waiting` busy predicate read fresh, inject via `s.injectIntoPane`, and post 👀 **only** on a verified submit <!-- R9 R10 R11 -->
- [x] T029 Advance the tracker on the SSE per-server tick and reap it on the post-loop retain seam in `app/backend/api/sse.go`, beside the `operatorQueue` calls <!-- R10 -->
- [x] T030 Add `app/backend/api/pr_review_listener_test.go`: one-thread-per-idle-observation, busy hold, min-gap, TTL expiry, rate cap, auto-disarm, requeue-on-failure, no-mark-on-`ProbeFailure`, absent-target hold, and the settings gate <!-- R9 R10 R11 -->

### Phase 6: The frontend surface

- [x] T031 Add `app/frontend/src/lib/review.ts`: the wire types, the actor-blind `unhandled` predicate, the `rk-review-viewed:<prUrl>:<sha>:<path>` localStorage store (validate-on-read, try/catch-noop), and the unhandled-count selector for the toggle badge <!-- R7 R9 -->
- [x] T032 Add the six client functions to `app/frontend/src/api/client.ts` (`fetchPRReview`, `fetchPRReviewFile`, `postPRReviewComment`, `postPRReviewThread`, `postPRReviewListen`, `postPRReviewRefresh`) <!-- R4 -->
- [x] T033 Add `app/frontend/src/lib/review-rows.ts`: shape-agnostic row builders (hunk header, line-number cell, marker cell, code cell) emitting `data-l`/`data-side`/`data-at`, plus `{line, col}` selection save/restore over text nodes and the `TreeWalker` decorator <!-- R6 R7 -->
- [x] T034 Add the token-class custom properties (`--rk-tok-k`, `--rk-tok-s`, …) and the `.rk-tok .k { color: var(--rk-tok-k) }` rules for both themes, plus the add/remove wash and left bar, to `app/frontend/src/globals.css` <!-- R5 -->
- [x] T035 Add `app/frontend/src/components/review-surface.tsx`: the tile shell, content states (no PR / loading / error / empty diff), the header (PR number, listen toggle, refresh) and the virtualized file list <!-- R2 R7 R10 -->
- [x] T036 Add `app/frontend/src/components/review-file-row.tsx`: chevron, filename + dim path, copy-path, `+N`/`−N`, Added/Modified badge, Mark-as-viewed checkbox, overflow `⋯`, lazy body fetch on expand <!-- R7 -->
- [x] T037 Add `app/frontend/src/components/review-diff.tsx`: unified rows from `review-rows.ts`, context expanders (`↕ All N lines`, `↑ 5 lines`) over the shared blob, and the `refine` swap that preserves selection <!-- R5 R6 R7 -->
- [x] T038 Add `app/frontend/src/components/review-thread.tsx`: the six comment states, the resolved/outdated pills, the `→ dispatched` chip, and suggestion blocks with Apply <!-- R8 -->
- [x] T039 Add `app/frontend/src/components/review-composer.tsx`: line-anchored composer with the outlined anchor row, the `R264`/`L120` header ref, the *Add single comment* / *Start a review* split button, and the `⚡ dispatch on post` / `⊘ on review submit` chip <!-- R8 -->
- [x] T040 Add `case "review"` to `renderContent` in `app/frontend/src/components/surface-layout.tsx`, mounting `ReviewSurface` with the window's `prUrl` and the tile focus seam <!-- R1 R2 -->
- [x] T041 Wire the surface into `app/frontend/src/app.tsx`: `panelSurfaces` now yields `review`, `surfaceDot` reports unhandled-thread presence for it, and the `review-toggle` chord handler mounts through `tileChordHandler` <!-- R2 R11 -->
- [x] T042 Add `app/frontend/src/lib/palette/review.ts` with the eight `Review:` actions (toggle listen, next/previous file, expand file, add comment on focused line, reply, resolve thread, mark viewed, refresh) and register them in `app/frontend/src/app.tsx` <!-- R11 -->

### Phase 7: Tests

- [x] T043 [P] Add `app/frontend/src/lib/review.test.ts` — the unhandled predicate table, the viewed store (write/read/reset-on-new-sha, malformed value), and the unhandled-count selector <!-- R7 R9 -->
- [x] T044 [P] Add `app/frontend/src/lib/review-rows.test.ts` — row-builder output attributes, selection save/restore across a repaint, and `TreeWalker` decoration preserving token spans <!-- R6 R7 -->
- [x] T045 [P] Add `app/frontend/src/lib/palette/review.test.ts` — the eight action ids and labels <!-- R11 -->
- [x] T046 Add `app/frontend/tests/e2e/pr-review.spec.ts` with the required file-header comment and a `Proves:`/`Steps:` JSDoc block on every `test()`: toggle availability with and without a PR, file list + expand, a rendered thread, the resolved and outdated states, and the listen toggle writing `@rk_win_pr_listen` <!-- R12 -->

### Phase 8: Verification

- [x] T047 Run the verification gates in order — `cd app/backend && go test ./...`, `cd app/frontend && npx tsc --noEmit`, `just test`, `just build` — and fix what they surface <!-- R12 -->

## Execution Order

- T001 blocks T013/T014 (Chroma must be a module dependency before the lexer code compiles).
- T008 blocks T009–T017; T011 blocks T012 and T014; T013 blocks T014 and T016; T015 blocks T016.
- T019 blocks T020; T020 blocks T028.
- T022 blocks T023; T023 blocks T024; T024 blocks T025.
- T026 blocks T027 and T028; T028 blocks T029.
- T031 blocks T032–T042; T033 blocks T037 and T044; T034 blocks T037.
- T035 blocks T036/T037/T040; T038 and T039 block T037's thread/composer mounts.
- T040 blocks T041; T042 depends on T035 (the verbs it invokes).
- T047 runs last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `layoutspec.surfaceKinds`, `ViewName`, and `SURFACE_KINDS` each carry exactly one new entry `review`, and a `review`-bearing layout round-trips through both parsers.
- [x] A-002 R2: `hasReview` derives availability from `prUrl` alone, adds no SSE field, and `availableTiles`/`HINT_ORDER`/`availableViews` include `review` exactly when a PR exists.
- [x] A-003 R3: `internal/prreview` exists with `refreshMu`/`mu`/stale-while-revalidate/injectable `available`, and the digest rides the existing `prstatus` batch with no additional `gh` call.
- [x] A-004 R4: all six endpoints exist with the specified verbs, are registered in `router.go`, and every user-authored body reaches `gh` on stdin.
- [x] A-005 R5: Chroma tokenizes server-side with windowed dual-tier refinement, a byte cap, short classes and a `(blobSha, path)` LRU; `app/frontend/package.json` gains no dependency.
- [x] A-006 R6: `GET /api/pr/review/file` returns per-line rows and every rendered code row carries `data-l`/`data-side` (and `data-at` on deletions).
- [x] A-007 R7: the file list is virtualized, file bodies load lazily on expand, and `rk-review-viewed:<prUrl>:<sha>:<path>` holds the viewed state.
- [x] A-008 R8: all six comment states render per `review-comment-states.html`, and the composer carries both modes with the correct dispatch chip.
- [x] A-009 R9: the `unhandled` predicate is actor-blind and 👀 is posted only after a verified submit.
- [x] A-010 R10: `@rk_win_pr_listen` arms a tracker that advances on the SSE tick, delivers one thread per idle observation into the window's own agent, and holds without marking when the target is absent.
- [x] A-011 R11: `pr_review_listener` gates every tick, and all eight verbs are registered in the command palette.
- [x] A-012 R12: Go, Vitest and Playwright coverage exists for the areas named in R12.

### Behavioral Correctness

- [x] A-013 R3: pulling the digest into the batch adds zero `gh` subprocesses — the extended `ghQuery` is still one call.
- [x] A-014 R5: an over-byte-cap window drops context first and then serves plain rows; it never blocks the tile and never errors.
- [x] A-015 R5: added and context lines are lexed against the head blob and removed lines against the base blob; no code path lexes a hunk body as a standalone fragment.
- [x] A-016 R6: decoration goes through a `TreeWalker`; no code path assigns to a row's `innerHTML`.
- [x] A-017 R7: a `refine` swap under an in-progress selection restores the same `{line, col}` range.
- [x] A-018 R10: the busy predicate is read fresh at delivery time, not from the tick's cached rollup alone.

### Scenario Coverage

- [x] A-019 R1: a test asserts a 4-tile add is still refused (`ErrLayoutFull`) with `review` in the registry.
- [x] A-020 R9: a test drives resolved / outdated / eyes-from-a-third-party / eligible through the predicate.
- [x] A-021 R10: a test drives three eligible threads through three ticks and asserts one delivery per tick, in order.
- [x] A-022 R12: the e2e spec exercises the toggle, the file list, an expanded diff, a thread, and the listen toggle.

### Edge Cases & Error Handling

- [x] A-023 R2: a window with no PR renders no toggle and degrades an existing `review` tile out of the layout.
- [x] A-024 R3: a `gh` error or malformed JSON leaves the last-good detail cache untouched (stale-while-revalidate).
- [x] A-025 R5: a blob with no matching Chroma lexer serves plain rows rather than erroring.
- [x] A-026 R8: an outdated thread and a suggestion-only thread are both rendered and both refused by the listener.
- [x] A-027 R10: `inject.ProbeFailure` and `inject.SubmitUnverified` both leave the thread unmarked and requeued.
- [x] A-028 R10: repeated dispatch failures auto-disarm the window and the hourly rate cap suppresses a storm.

### Code Quality

- [x] A-029 Pattern consistency: new Go code follows the `prstatus` collector shape (seams as struct fields, `Snapshot` deep copies, package doc stating the design) and new React code follows the existing surface-component conventions.
- [x] A-030 No unnecessary duplication: `internal/tmux`, `internal/inject`, `internal/validate`, `fenceUserText`, `controlClass` and `src/api/client.ts` are reused rather than reimplemented.
- [x] A-031 Process execution: every `exec.CommandContext` call carries an explicit argv slice and a timeout; no shell string, no `exec.Command` without a context.
- [x] A-032 No polling from the client: the tile refreshes on mount, on the SSE tick, and on the explicit refresh verb — never on a `setInterval` + fetch.
- [x] A-033 No database or disk state store: every cache is in-memory and droppable; the marker lives on GitHub, arm state in a tmux option, viewed state in localStorage.
- [x] A-034 Comment discipline: comments state constraints the code cannot show (the digest/detail split, the marking-after-delivery ordering, the byte cap) and narrate nothing.
- [x] A-035 Function size: no new function exceeds the codebase's typical size without a stated reason; the diff renderer is decomposed into row builders.
- [x] A-036 Type narrowing: new frontend code uses `if` guards and discriminated unions rather than `as` casts on parse paths.

### Security

- [x] A-037 R4: no comment body, thread id, path or branch name is interpolated into a shell string, and every user-authored body reaches `gh` on stdin.
- [x] A-038 R4: `window`, `path`, `start` and `count` query parameters are validated before any subprocess call.

## Notes

- **Verification gates**: `go test ./...` (backend), `go test -race ./api/...`,
  `npx tsc --noEmit`, `just test` (backend + frontend + e2e) and `just build`
  all pass. The ONE exception is the `/__controls` gallery drift guard
  (`control-gallery.spec.ts`, both pointer classes), which **fails at HEAD on
  this machine with the change reverted** — verified by restoring the committed
  `globals.css` and re-running the spec alone. The diff is sub-pixel text
  antialiasing across every cell, including cells this change's CSS cannot
  reach, i.e. a font-rendering mismatch against the committed baselines rather
  than control drift. The baselines were therefore deliberately NOT regenerated:
  doing so would commit this box's rendering over the reference and destroy the
  guard. `terminal-tile-find.spec.ts` flaked once under load and passed on
  retry.
- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Chroma's FULL ~280-lexer set ships; no curated subset | The measurement the intake (#30) and spec § Dependencies demanded, taken on `rk` itself by building the same tree with and without the `lexers` import: 54 977 870 B vs 52 015 146 B — the lexer set costs **2 962 724 B (2.83 MiB), ~5.7 %** (an isolated bare-binary A/B agrees to 7 KB). Not worth capping the language set and hand-porting the Go-coded lexers on every upgrade — see § Design Decisions | S:90 R:85 A:90 D:85 |
| 2 | Certain | Chroma's own `chroma.StandardTypes` is the token→class table (with a `Parent()` walk for unmapped types) | It IS the short-class table the spec describes (`k`/`nf`/`s`/`m`/`c`/`kd`/`kt`/`err`), already maintained upstream. Writing our own would drift | S:85 R:90 A:95 D:90 |
| 3 | Certain | Window = 200 lines, context pad = 60 lines each side, byte cap = 256 KiB, tier-2 background pass for blobs ≤ 512 KiB | The spec defers the concrete thresholds to apply. 200 lines is ~3 screens of an expanded hunk; 60 lines of pad clears any realistic block comment or raw string; 256 KiB at Chroma's sub-1 MB/s throughput is ~0.3 s worst case; 512 KiB bounds the background pass to under a second | S:60 R:90 A:80 D:70 |
| 4 | Confident | The token/blob LRU budget is 32 MiB, scavenged on a latch after 60 s idle | Daemon-sized against the ~20 MB idle footprint the spec names, and two orders below px0's 512 MB. 32 MiB holds roughly a 200-file PR's blobs | S:55 R:90 A:80 D:70 |
| 5 | Certain | The surface's user-facing label is "Changes" and its glyph is `+-` | The intake fixes the label ("The user-facing label may read 'Changes'"); the glyph follows the existing 2-char ASCII vocabulary (`>_`/`://`/`{}`/`[]`) and `+-` is the diff's own sign pair | S:80 R:90 A:85 D:75 |
| 6 | Confident | The `review` tile chord is ⌘5 / ⇧Ctrl+5 (`Digit5`), the next digit after gui's `Digit4` | The four existing surfaces are `Digit1`–`Digit4` with the identical row shape, and `MAC_BROWSER_CMD_CLAIMS` already reserves `Digit1`–`Digit9`, so the palette-reachable fallback rule the constitution requires already covers it | S:65 R:90 A:85 D:80 |
| 7 | Confident | Thread reads/resolve/pending-review go through GraphQL; single comments, replies and the 👀 reaction go through REST — see § Design Decisions | Each API is used where it is the only one that expresses the operation: REST has no thread object or resolve verb, GraphQL has no reply-by-parent without a review wrapper | S:70 R:70 A:90 D:80 |
| 8 | Confident | *Start a review* finds-or-creates the viewer's single pending review and appends via `addPullRequestReviewThread` | GitHub permits exactly one pending review per viewer per PR, so create-unconditionally would 422 on the second comment. Find-or-create is the only shape that composes, and the spec explicitly declines to mirror pending state across viewers | S:65 R:75 A:85 D:75 |
| 9 | Confident | The listener tracker lives in `api/pr_review_listener.go`, not in `internal/prreview` — see § Design Decisions | It needs the tick's session snapshot and the injection adapter, both of which live in `api`; `operatorQueueTracker` sits there for the same reasons | S:70 R:75 A:90 D:80 |
| 10 | Confident | Entry TTL is 30 min and the per-window hourly cap is 30 deliveries, matching `operatorQueueTTL` and `cron.DefaultTargetRatePerHour` | The spec says "borrow cron's rules wholesale"; borrowing the constants as well as the shapes is the literal reading and keeps one number per concept | S:75 R:85 A:85 D:85 |
| 11 | Confident | Auto-disarm fires after 3 consecutive dispatch failures on one window, clearing `@rk_win_pr_listen` | Cron's circuit-breaker precedent bounds a failing target; 3 is enough to ride out one transient probe failure without spamming a broken pane. Re-arming is one toggle click | S:50 R:85 A:80 D:65 |
| 12 | Confident | The toggle's unread badge counts UNHANDLED threads (intake #20) and is rendered as the existing availability dot, not a numeric badge | The dot is the toggle group's only per-surface signal slot (`showDot`); adding a numeric badge would change the shared button geometry for every surface. The count still drives the palette entry's label | S:55 R:85 A:80 D:65 |
| 13 | Confident | With several live windows on one `(repoDir, branch)`, the dispatch targets the most-recently-active pane-bearing window (intake #19) | Carried forward from the intake unchanged; one obvious default, cheap to change | S:40 R:80 A:65 D:50 |
| 14 | Confident | `GET /api/pr/review/file` takes `start`/`count` and returns rows for one file; the client requests the file's own hunk ranges and widens them on context expansion | The spec fixes the parameter names but not who chooses the range. The client knows which hunks are on screen, and the alternative (server-chosen ranges) would need a second round trip to widen | S:65 R:80 A:80 D:75 |
| 15 | Confident | `POST /api/pr/review/refresh` mirrors `/api/status/refresh`'s tri-state 202 (`started`/`coalesced`/`throttled`) | The spec says "mirrors /api/status/refresh"; mirroring the body shape as well as the detach keeps one client-side refresh idiom | S:75 R:85 A:90 D:85 |
| 16 | Confident | The tier-2 refine result is published and read under `refineMu`, not just written under it | The background pass hands its spans to a reader on another goroutine; an unguarded read is a data race, not merely a stale answer. Caught by the verification pass and covered by `go test -race ./api/...` | S:85 R:90 A:95 D:90 |
| 17 | Confident | A tripped listener circuit breaker LATCHES on the window state instead of deleting it | The disarm write is best-effort, so deleting the state would let the next tick rebuild a zero-failure one and re-trip forever. Only the option actually going false clears the latch | S:70 R:85 A:90 D:80 |
| 18 | Confident | Context expansion is capped at 1 000 lines per response, separately from the 200-line lexing window | The expander's unit is what a human asked to see, not what the lexer windows internally; a file longer than the cap serves its first page and the next `↑` continues. An unbounded response is what the cap prevents — the blob can be a generated file | S:60 R:85 A:80 D:70 |
| 19 | Confident | A gh outage (`prreview.ErrUnavailable`) HOLDS the entry instead of counting toward the circuit breaker | An outage is not evidence that this window is broken; disarming a user's tab over someone else's network is the wrong response. It joins busy and absent in the retryable class | S:70 R:85 A:90 D:80 |
| 20 | Confident | Suggestion-only detection is "every comment body in the thread contains a ```suggestion fence and no prose outside it" | The spec says a suggestion-only thread never dispatches but does not define "only". Requiring every comment to be fence-only is the conservative reading — a thread with an argument plus a suggestion still reaches the agent | S:55 R:80 A:80 D:65 |
| 21 | Confident | **Apply suggestion** copies the replacement to the clipboard AND resolves the thread | GitHub's own Apply is a web-only action — there is no REST or GraphQL verb for committing a suggestion — and R4 fixes the endpoint set at six, so no new route may be added for it. `review-comment-states.html` § 7 (normative) says "suggestion-only threads are marked handled when the suggestion is applied", and resolve is the only verb we have that marks a thread handled. The button's `title` states both halves so the composition is discoverable rather than surprising | S:45 R:75 A:70 D:55 |
| 22 | Confident | The pending-review (sixth) comment state is COMPONENT memory, not persisted anywhere | `gh` cannot see an unsubmitted review, so the tile's own record is the only one that exists, and the state is explicitly "local only" in both the spec table and the wiki. Constitution II forbids a store; localStorage would be worse than nothing here, because it would outlive a submit the tile never observes and claim a comment is still pending after it shipped | S:70 R:85 A:85 D:75 |
| 23 | Confident | The composer's dispatch chip follows HOVER and keyboard FOCUS across the two submit buttons | R8 makes both modes SUBMIT actions, so a chip that repainted on mode selection could only repaint after the post — i.e. never be seen, which is the opposite of "states that difference instead of hiding it". Following the pointer/focus is what makes `⊘ on review submit` reachable before committing, and ⌘/Ctrl+Enter submits the chip's mode so the keyboard path agrees with what is displayed | S:55 R:85 A:80 D:65 |
| 24 | Certain | The `→ re-queued` pill is REMOVED; a marked thread reads `→ dispatched` whether or not a reply landed | Spec § The loop guard settles it in the spec's own words — "No auto-requeue on a new reply … Any UI that claims otherwise is lying about the backend" — and the implementation's predicate is 👀-on-the-first-comment only. The stale promise survived in `review-comment-states.html` § 4 and its state table; both are corrected here, so the design authority and the spec now agree | S:90 R:90 A:95 D:90 |
| 25 | Certain | A shared `internal/ghprobe.Available(ctx, timeout)` replaces the duplicated `ghAvailable` in `prstatus` and `prreview` | Two byte-identical `LookPath` + `gh auth status` probes had drifted apart in comment only; one source means they cannot disagree about what "gh is unavailable" means. Placed in its own stdlib-only package rather than exported from `prstatus`, following `internal/gitinfo`'s precedent — the R3 digest/detail split deliberately keeps those two packages independent | S:80 R:90 A:90 D:80 |

25 assumptions (7 certain, 18 confident, 0 tentative).

## Deletion Candidates

- `app/backend/internal/prreview/highlight.go:250` `queueRefine(ref PRRef, …)` — the `ref` parameter is never read in the body; every other input (`path`, `sha`, `lines`, `lexer`) is.
- `app/backend/internal/prreview/prreview.go:121` `FileEntry.Sha` — decoded from the gh files listing and shipped on the wire, but no server or client path reads it (both images are addressed by the PR's head/base COMMIT shas).
- `app/backend/internal/prreview/prreview.go:212` `Fetcher.Snapshot` as an exported symbol — its only callers are `Get`/`fresh` inside this package; unexporting it would stop a caller from mutating the shared document.
- `app/frontend/src/components/review-composer.tsx:35` `ReviewComposerProps.initialBody` — declared for the palette's "seed a quote of the selection", which no caller supplies.
- None of the previous cycle's candidates survive: `viewedProgress` was deleted, and `decorateMatches`/`undecorate`/`spanClass`/`rowText`, `prReviewThreadTemplate`, `prReviewThreadFacts.ThreadID` and `onApplySuggestion` all gained production call sites; the duplicated `ghAvailable` was consolidated into `internal/ghprobe`.
