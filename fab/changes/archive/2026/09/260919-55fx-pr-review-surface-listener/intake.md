# Intake: PR Review Surface + Comment Listener

**Change**: 260919-55fx-pr-review-surface-listener
**Created**: 2026-09-19

## Origin

> i want to build one more sections [top-bar surface-toggle group screenshot] for changes in runkit, should look like this [GitHub PR "Files changed" screenshot]
>
> this should work like the changes section in github pr
> user should be able to add review comments, as one adds in a pr
> there should be a button to switch on/off listening on pr comments, switch on should check for old comments too,
> checking means the runkit session is queued a message to work on the review comment and push the fix

Conversational, via `/fab-discuss` on 2026-09-19. Four reference screenshots were supplied:
the top-bar surface-toggle group (`>_` · `{}` · `://`), a GitHub "Files changed" tab, a GitHub
new-comment composer anchored to a line, and a multi-party GitHub review thread.

Two HTML design studies were produced during the discussion and presented via `rk present`:

- `docs/wiki/review-highlighting-studies.html` — the three syntax-highlighting options rendered
  against a real `window-view.ts` hunk, with diff-tint and theme toggles.
- `docs/wiki/review-comment-states.html` — every comment state (affordance → composer → single
  comment → thread → resolved → outdated → suggestion), each renderable in all three
  highlighting treatments.

**Decisions taken in the discussion, in order:**

1. **Diff source: PR-backed only.** Offered PR-backed-with-local-fallback (recommended),
   PR-backed-only, and local-git-diff. User chose **PR-backed only** — no local `git diff`
   fallback, no commenting without a PR. A branch with no PR renders no tile at all.
2. **Dedupe marker: mark on GitHub.** Offered GitHub-side marking (recommended), a local
   `$XDG_STATE_HOME` sidecar, and a cron-style delivery log. User chose **GitHub-side marking**.
3. **Scope: one change.** Offered listener-first-headless (recommended), read-only-diff-first,
   and both-together. User chose **both together as one change**. The size concern was raised
   once and the decision reaffirmed; scope is not to be narrowed.
4. **The marker is 👀, actor-blind.** The comment-states study flagged that 👀 already appears
   as a genuine human reaction in the user's own screenshots, and proposed a distinct bot
   identity to disambiguate. User responded: *"using eyes is the right thing, use it"* — so 👀
   stays, and the collision is resolved by making the marker **actor-blind** (see § What Changes
   → Dedupe). No GitHub App, no bot account.
5. **Syntax highlighting: Shiki (option C).** The highlighting study recommended option B
   (Prism), and the comment-states study hardened that recommendation by showing the comment
   layer is highlighting-neutral. User chose **C — Shiki** against that recommendation. The
   decision stands; the plan must carry Shiki's async-init and payload consequences as
   first-class requirements rather than incidental ones.
   — **SUPERSEDED on 2026-09-21 by decision 6.**
6. **Highlighting moves to the backend: Chroma, not Shiki.** *(2026-09-21, supersedes
   decision 5.)* User asked to integrate [px0](https://px0.ai/) directly instead of
   Shiki, and whether it could be used without running a server. Investigation of
   `px0-ai/px0` found: every Go file is `package main` under module path `px0` (not a
   fetchable URL), and px0 is a standalone HTTP server with an embedded frontend, an
   LSP client and an agent dispatcher — so it is **not importable as a library and
   cannot be integrated without running a server**. Its highlighting, however, is
   `github.com/alecthomas/chroma/v2` (pure Go, no CGO, ~280 languages) plus a windowed
   lexer, and Chroma *is* importable. Decision: **tokenize server-side with Chroma;
   the frontend ships no highlighting dependency at all.** This removes four costs the
   browser-side choice carried rather than solved — the 100–300 KB bundle, async init
   and its unhighlighted-then-repaint flash, bundling two editor themes, and a theme
   whose colours assume a flat ground the diff tint sits under. Recorded in
   `docs/specs/pr-review.md` § R5.
7. **Architecture ported from px0's internals (MIT, with attribution).** *(2026-09-21.)*
   A read of px0's `docs/internals/` supplied several mechanisms now normative in the
   spec: windowed lexing with leading/trailing context pads and a byte cap over the
   line cap; **dual-tier refinement** with a `refine` flag and a background exact pass
   (replacing the earlier "files over a cap render unhighlighted" rule with a ladder
   that degrades to briefly-imprecise colour instead of none); short token classes
   coloured by CSS custom properties (which is what makes both themes free from
   run-kit's existing palette); the unified-hunk state machine bucketing changed lines
   into post-image line numbers; `data-l` / `data-at` row addressing (extended here
   with `data-side`) as the **comment-anchoring contract**; `TreeWalker` decoration
   that adds comment markers without destroying token markup; and coordinate-based
   selection restore across repaints. Deliberately not adopted: px0's 512 MB cache
   budget (wrong for a daemon), its path+mtime+size cache key (blob shas are immutable
   and strictly better), and its non-virtualized diff view — px0 virtualizes its
   *source* viewer but renders diffs as plain DOM, which is right for one file against
   HEAD and wrong for a 200-file PR, so run-kit virtualizes the **file list** instead.
   Recorded in spec § R5–R7 and § Prior Art.

> **Deferred, tracked separately.** px0 guards every mutating endpoint with
> POST + `Origin == Host` + a Host-must-be-IP-or-localhost DNS-rebinding check.
> run-kit binds `0.0.0.0` by default and is reachable over SSH-tunnelled remotes,
> and this change adds mutations that **write to GitHub** — so a malicious page
> triggering a comment post or a thread resolve is a real threat model. run-kit's
> current origin posture on `/api/*` mutations was not audited. User decided on
> 2026-09-21 to handle this as its own change rather than folding it in here.

## Why

**The problem.** A run-kit window is already bound to a branch, a worktree, an agent, and —
via `internal/prstatus` — a pull request. Everything needed to review that PR is derivable
inside run-kit already, yet reviewing it means leaving for github.com, and acting on a review
comment means reading it there, re-typing its substance into the agent's pane, and manually
tracking which comments have been dealt with. The last step is the expensive one: on a PR with
fifteen review threads, the human is the queue.

**The consequence of not doing it.** The review→fix loop stays manual and lossy. Comments get
handled twice or not at all, because "which of these has the agent already seen" lives only in
the reviewer's head. The agent-orchestration story stops precisely where the highest-value
automation begins — run-kit can spawn, watch, message, and schedule agents, but cannot close
the loop on the one signal that most often demands agent work.

**Why this approach.** Three alternatives were weighed and rejected:

- *Local `git diff` with run-kit-owned comments* — always available including pre-PR, but
  comments would need a run-kit-owned store, colliding with Constitution II, and the listener
  would then read a different substrate than the one comments are written into. Rejected.
- *A local sidecar for dedupe state* — invisible to humans, and a wipe re-dispatches the whole
  backlog, which is expensive when each dispatch makes an agent push a commit. Rejected.
- *A cron entry per armed window* — cron entries are user-authored, per-server, disk-backed
  intent files with orphan GC; synthesizing and reaping them as a per-window toggle flips is
  churn against machinery built for a different lifecycle. Rejected in favour of a tracker
  sibling (below).

The chosen shape keeps every fact derived at request time from `gh` (Constitution II), reuses
the injection engine rather than inventing a second delivery path, and makes the dedupe marker
visible on github.com to a reviewer who never opens run-kit.

## What Changes

### 1. A new surface kind: `review`

The closed surface registry gains one entry — the registry's own comment in
`app/backend/internal/layoutspec/layoutspec.go` states that "extending the registry is
appending one entry".

```go
// app/backend/internal/layoutspec/layoutspec.go
var surfaceKinds = map[string]bool{
    "tty": true, "web": true, "code": true, "gui": true,
    "review": true,   // NEW
}
```

```ts
// app/frontend/src/lib/window-view.ts
export type ViewName = "tty" | "web" | "code" | "gui" | "review";
```

**Naming.** The kind is `review`, NOT `changes`. This repo already means something specific by
"changes" — `fab/changes/`, the change slug in the sidebar and status bar, "Active change" — and
the two would be ambiguous in exactly the surfaces where both appear. The user-facing label may
read "Changes"; the internal kind must not.

**Availability** mirrors `hasCode` exactly and needs no new derivation, because
`WindowInfo.PrURL` is already branch-derived server-side by `prstatus.BranchRefresher` and
already rides the SSE payload (`internal/tmux/tmux.go`: `PrURL *string \`json:"prUrl,omitempty"\``):

```ts
export function hasReview(win: ViewWindow | null | undefined): boolean {
  return (win?.prUrl ?? "").length > 0;
}
```

Per decision 1 (PR-backed only), no PR ⇒ the toggle is unlit and the tile is unreachable. This
is the same availability-vs-reachability split `code` already uses.

**Toggle placement**: a fourth flush button in the top bar's `surface-toggles` group, carrying
the same availability dot as the others. Arity is unchanged — still ≤3 tiles (Constitution IV).
`HINT_ORDER` gains `review`.

### 2. Backend: a two-cadence split

The two jobs have opposite cost profiles and must not share a package.

**(a) Digest — always polling, near-free.** Add `reviewThreads` to the *existing* batched
GraphQL query in `internal/prstatus`, which already runs `gh api graphql` over
`viewer.pullRequests(first: 100, …)` every 90s across every PR the viewer owns. Per thread,
fetch only: `id`, `isResolved`, `isOutdated`, `path`, `line`, and the first comment's `id`,
`author.login`, and `reactions(content: EYES)`. This feeds the listener's edge detection and an
unread badge on the toggle — for **zero additional `gh` calls**.

**(b) Detail — on demand, only while a tile is mounted.** New package `internal/prreview`:
file list, patches, and full thread bodies, keyed `(prURL, headSha)`. It carries the same
posture `prstatus` already proves: single-flight `refreshMu` held across the whole pass
including subprocesses, a separate `mu` guarding the map for readers that never spans a
subprocess, stale-while-revalidate on error, an injectable `available func(ctx) bool` gate, and
`exec.CommandContext` with explicit argv slices under a 10s timeout.

A comment in the code must state why the split exists — without it, the two paths read as
duplication to the next reader.

**Routes** (Constitution IX — reads GET, every mutation POST):

```
GET  /api/pr/review?window={id}      files + patches + threads + viewer login
POST /api/pr/review/comment          new comment (path,line,side,body) | reply (threadId)
POST /api/pr/review/thread           resolve / unresolve
POST /api/pr/review/listen           arm / disarm
POST /api/pr/review/refresh          on-demand refresh, mirrors /api/status/refresh
```

Comment bodies are passed to `gh` over **stdin**, never argv (Constitution I).

### 3. Frontend: the diff renderer

Unified view only in v1 (split view is a follow-on; the reference screenshots are unified).

**File rows** carry, per the reference shot: chevron, filename (bold) + dim path, copy-path
button, `+N`/`−N` counts, an Added/Modified badge, a "Mark as viewed" checkbox, and an overflow
`⋯`. Expanding renders the unified diff with line numbers, an added/removed wash plus a left
bar, and context expanders (`↕ All 75 lines`, `↑ 5 lines`).

**Syntax highlighting: Chroma, server-side** (decision 6, superseding decision 5). The
frontend ships **no highlighting dependency at all**. Normative detail lives in
`docs/specs/pr-review.md` § R5; the load-bearing points:

- **Windowed lexing with dual-tier refinement.** Chroma runs well under 1 MB/s, so whole-blob
  lexing on open is off the table. Tier 1 lexes a bounded window — requested lines plus a
  context pad each side — and returns in low single-digit ms with `refine: true` when the
  window may have guessed. Tier 2 lexes small blobs end-to-end on a background goroutine and
  the client swaps corrected lines in place. This **replaces** the earlier "over the cap,
  render unhighlighted" rule: it degrades to briefly-imprecise colour, never to no colour, and
  never blocks the tile.
- **Byte cap as well as a line cap.** A thousand-line window can be the whole of a generated
  file. Over the byte cap, drop context first; past that, serve the blob unhighlighted.
  Thresholds are measured during apply, not guessed.
- **Short classes + CSS custom properties.** Token types map to `.k` / `.nf` / `.s` / `.m` /
  `.c` / `.kd` / `.kt` / `.err`, coloured by matching properties in `globals.css`. Class length
  is payload — it repeats once per token per line. Because run-kit's stylesheet owns the
  colours, **both themes come free from the existing palette** and the diff tint composes
  underneath by construction; the light-theme string-vs-add-wash collision cannot arise.
- **Pre-image / post-image.** Added and context lines lex against the head-sha blob, removed
  lines against the base-sha blob. Lexing a hunk body as a fragment is forbidden — it starts
  the lexer mid-file with the wrong state, which is what the context pad exists to prevent.
- **Cache** keyed `(blobSha, path)` — immutable, so it can never invalidate wrongly. In-memory,
  LRU, byte-budgeted, **daemon-sized** (px0's 512 MB budget is wrong for a long-lived daemon
  with a ~20 MB idle footprint), with idle memory released on a latch.

**The line is the unit of the API** (spec § R6). The response is an array of per-line token
spans, never one HTML blob per file — a blob cannot be interleaved, and interleaving is the
comment layer's whole job. Every row carries `data-l`, `data-side` (`L`/`R`) and, for deleted
rows, `data-at` (the post-image line the deletion sat before). That tuple is GitHub's
`(path, side, line)` addressing and therefore the **comment-anchoring contract**. Comment
markers, selection highlights and suggestion ranges are applied with a `TreeWalker` over text
nodes so token markup survives; rewriting a row's `innerHTML` is forbidden.

**Virtualize the file list, not the diff body** (spec § R7). One file's diff is bounded by that
file; the *number of files* in a PR is not. Files render lazily on expand. Selection must
survive a repaint (save `{line, col}`, restore by walking text nodes) because a background
refine swapping lines under an in-progress selection is the normal case — that selection is
usually about to be quoted into a comment.

Context expansion needs the full blob — the **same blob** the lexer needs, so the two share one
`gh api .../contents/{path}?ref={sha}` fetch.

**Mark as viewed** is per-viewer state and lives in localStorage per Constitution IV's layering,
keyed `rk-review-viewed:<prUrl>:<sha>:<path>` — the head-sha in the key is what makes it reset
on a new push, matching GitHub.

### 4. Comment states

Per `docs/wiki/review-comment-states.html`, which is the design authority for this section.

| State | Rendering | Listener behaviour |
|---|---|---|
| Open, unmarked | expanded card | **eligible** — dispatches on next tick |
| Open, marked 👀 | expanded, `→ dispatched` chip | held — no re-dispatch until a new reply |
| Open, new reply after mark | expanded, chip clears | **re-queued** — whole thread re-sent |
| Resolved | collapsed one-liner, dimmed, purple pill | terminal — never dispatched |
| Outdated | collapsed + amber pill + original hunk on demand | **never dispatched** |
| Pending review (unsubmitted) | local only, amber left edge | invisible to `gh` until submitted |

**Composer.** Anchored under the line, which takes an outline for the duration. Header carries
the side+line ref (`R264` = right/new side line 264; `L` = left/old). Footer carries GitHub's
own two modes as a split button: *Add single comment* posts immediately; *Start a review*
batches into a pending review. These differ for the listener — **a pending review is invisible
to `gh` until submitted**, so only the single-comment path can dispatch on post. The dispatch
chip reads `⚡ dispatch on post` in single mode and dims to `⊘ on review submit` in review mode.

**Outdated must never dispatch.** The agent would be handed a line number that no longer names
the code the comment is about; dispatching produces a confident edit in the wrong place, which
is strictly worse than dropping it. Outdated threads surface for a human to re-anchor or resolve.

**Suggestion blocks** (` ```suggestion `) render as their own mini-diff with an Apply button.
A suggestion-only thread is **not** dispatched — it is a mechanical edit GitHub commits with one
button, and burning an agent turn on it is waste. Applying marks the thread handled.

### 5. Dedupe: 👀, actor-blind

The marker is the **👀 reaction on the thread's first comment**, and it is deliberately
**actor-blind** — the predicate performs no identity join:

```
unhandled(thread) ≡ !thread.isResolved && !thread.isOutdated && !hasEyes(thread.firstComment)
```

👀 means **claimed, by whoever put it there**. A human reacting 👀 says "I am handling this" and
suppresses dispatch exactly as the agent's own mark does — one signal, two writers, one meaning.
Consequences, all of which are features:

- rk needs **no bot account and no GitHub App** — it reacts as whoever is authenticated.
- **Un-reacting releases the claim**, and the thread becomes eligible again on the next tick.
  This is the manual re-dispatch gesture; no additional UI is required for it.
- The claim is **visible on github.com** to a reviewer who never opens run-kit.

**Switch-on backfill needs no code.** "Check old comments too" is the identical predicate — the
backlog is just every thread that is unresolved, not outdated, and unmarked. There is no
cursor, no cold-start rule, no seed file, and no special backfill path. This is the single
largest simplification the GitHub-marking decision buys.

**Marking is ordered after delivery, never before.** `internal/inject` already distinguishes a
verified submit from `inject.ProbeFailure` / `SubmitUnverified` (its failure taxonomy splits on
the Enter boundary). The reaction is posted only on a verified submit, so a failed injection
leaves the thread unmarked and it re-dispatches on the next tick. Marking first would strand
comments silently.

### 6. The listener

**Arm state**: a new per-window tmux option `@rk_win_pr_listen` (values `1` / unset), which
needs a row in the `@rk_<scope>_<name>` registry in
`docs/memory/run-kit/tmux-sessions.md` § Server-Scoped User Options. Per-window because the
unit of work is a branch; shared across viewers because it is a fact about the work, not a
viewing posture (this is the R7 test in `surface-layout.md`, and it passes).

**Mechanism: a tracker sibling, not a cron entry.** Model it structurally on
`api/operator_queue.go`'s `operatorQueueTracker` — own mutex, `now func() time.Time` clock
seam, injected `deliver` closure seam (nil in test hubs, tracking still advancing), advanced
synchronously on the SSE per-server tick, reaped on the post-loop retain seam. State is
process-memory only; a daemon restart forgets in-flight queueing and degrades to re-deriving
from `gh` on the next poll (Constitution II).

**Borrow cron's rules wholesale** rather than reinventing them:

- busy predicate is `active | waiting` (`when-idle` semantics), read fresh at delivery time
- a per-window min-gap, mirroring `operatorQueueMinGap` (60s) and its rationale — the rolled-up
  agent state lags an injection by a hook round-trip
- entry TTL, requeue-on-re-busy, drop-quietly on any other failure
- a per-window hourly rate cap, and auto-disarm after repeated dispatch failures
  (cron's circuit-breaker precedent)

**One thread per idle observation** (the operator queue's "exactly one entry per tick"), so a
twenty-comment review does not arrive as a wall.

**Dispatch granularity is the thread, not the comment** — one thread is one unit of work, and
the agent is handed every comment in it, in order, so it has the argument and not just the last
line.

**Target**: the window whose pane resolves to that `(repoDir, branch)` — already derived by
`prstatus.BranchRefresher`. When the window is absent, borrow cron's `if_absent` posture: v1
holds without marking (so nothing is lost) and does not respawn.

**Payload**: a new entry in the closed template registry described in
`docs/memory/run-kit/operator-actuation.md`, e.g. `pr-review-thread`, carrying the PR number and
URL, file + line, the surrounding hunk, every comment body in a dynamic bare fence (the
`acceptsText` fence-length rule), the reviewer logins, the thread URL, and the instruction to
fix, push, and resolve the thread when done.

**Loop guard.** The obvious guard — excluding viewer-authored comments — is *wrong*: the user
commenting on their own PR is the primary use case, and an author filter would break exactly
what this builds. The marker-based predicate is already sufficient: the agent's own reply does
not unmark the thread, so a replied-but-unresolved thread stays handled and never re-fires; a
new head sha unmarks nothing, because marks are per-comment.

### 7. Settings + palette

- A `pr_review_listener` bool key in the `internal/settings` registry (default true, live),
  gating every tick — the exact shape of the existing `cron_ticker` key.
- Palette entries for every verb (Constitution V): toggle listen, next/previous file, expand
  file, add comment on focused line, reply, resolve thread, mark viewed, refresh.

## Affected Memory

- `run-kit/pr-review`: (new) the whole feature — the `review` surface, `internal/prreview`, the
  two-cadence split, the comment write paths, the 👀 actor-blind dedupe contract, the listener
  tracker, and the dispatch state table
- `run-kit/architecture/pr-status`: (modify) `reviewThreads` folded into the existing batched
  GraphQL query; the digest-vs-detail split and why it exists
- `run-kit/architecture/backend-packages`: (modify) new `prreview` row in the package table,
  and the Chroma entry in the external Go dependency table
- `run-kit/api-and-sockets`: (modify) the five new `/api/pr/review*` routes
- `run-kit/ui/lenses-and-layout`: (modify) the `review` surface renderer, its content states,
  the per-line token contract, the `data-l`/`data-side`/`data-at` anchoring attributes,
  TreeWalker decoration, file-list virtualization, and selection restore across refine swaps
- `run-kit/ui/top-bar`: (modify) the fourth flush surface toggle and its availability dot
- `run-kit/ui/keyboard-and-palette`: (modify) the new palette entries
- `run-kit/tmux-sessions`: (modify) the `@rk_win_pr_listen` registry row
- `run-kit/configuration`: (modify) the `pr_review_listener` settings key (registry inventory
  count moves from 18 to 19)
- `run-kit/ui/visual-design`: (modify) only if the diff/comment components emit new Control
  variants — if they do, the `/__controls` gallery and its committed PNG baselines are changed
  surface and both pointer-class baselines must be regenerated

## Impact

**New code**
- `app/backend/internal/prreview/` — the on-demand detail fetcher
- `app/backend/api/pr_review.go` — the five routes
- `app/backend/api/pr_review_listener.go` — the tracker
- `app/frontend/src/components/review-surface.tsx` + diff/file-row/thread/composer components
- `app/frontend/src/lib/review.ts` — types, the unhandled predicate, viewed-state store

**Modified**
- `app/backend/internal/layoutspec/layoutspec.go` — one registry entry (+ its test's kind list)
- `app/backend/internal/prstatus/prstatus.go` — `reviewThreads` in the batch, new projection
- `app/backend/internal/settings/` — the `pr_review_listener` key
- `app/backend/api/sse.go` — tracker advanced on the per-server tick, reaped on the retain seam
- `app/frontend/src/lib/window-view.ts` — `ViewName`, `hasReview`, `HINT_ORDER`
- `app/frontend/src/lib/surface-layout.ts`, `components/surface-layout.tsx` — tile wiring
- `app/frontend/src/components/top-bar.tsx` — the fourth toggle
- `app/frontend/src/lib/keybindings.ts` + palette registration

**Dependencies** — one new **Go** module dependency: `github.com/alecthomas/chroma/v2`
(plus its pure-Go `dlclark/regexp2` indirect). No CGO, no system libraries, and **no new
frontend dependency at all** — the `app/frontend` bundle is unchanged by highlighting. The
binary-size delta from Chroma's full ~280-lexer set is a measured decision during apply: ship
all lexers, or register a curated subset (Go, TS/TSX, CSS, JSON, Markdown, shell, YAML) if the
delta is material to a Homebrew-distributed binary.

**Docs** — two design studies move from the scratchpad into `docs/wiki/`
(`review-highlighting-studies.html`, `review-comment-states.html`) with rows in
`docs/specs/index.md` § Wiki, and a new spec `docs/specs/pr-review.md`.

**Testing** — Go unit tests for the prreview cache, the unhandled predicate, the tracker's
drain/requeue/cap; Vitest for the diff renderer and viewed-state store; Playwright e2e for the
toggle, the composer, the thread render, and the outdated/resolved states, each with the
`Proves:`/`Steps:` JSDoc the constitution requires.

## Open Questions

- Multiple live windows on the same `(repoDir, branch)` — which one receives the dispatch?
  (Recorded as a Tentative assumption below: most-recently-active pane-bearing window.)
- Whether the unread badge on the surface toggle should count unresolved threads or only
  *unhandled* ones. (Recorded as Tentative: unhandled, so the badge goes quiet as work is
  claimed.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Diff and comments are PR-backed only; no local `git diff` fallback, no tile without a PR | Discussed — user chose "PR-backed only" over the recommended PR-with-local-fallback | S:95 R:70 A:90 D:95 |
| 2 | Certain | Dedupe is marked on GitHub, not in a local sidecar or delivery log | Discussed — user chose GitHub-side marking from three options | S:95 R:65 A:90 D:90 |
| 3 | Certain | The marker is the 👀 reaction | Discussed — user reaffirmed explicitly after the collision was flagged: "using eyes is the right thing, use it" | S:100 R:70 A:90 D:95 |
| 4 | Confident | Surface + commenting + listener ship as ONE change; scope is not to be narrowed | Discussed — user chose "both together" after the size concern was raised and answered | S:95 R:50 A:90 D:90 |
| 5 | Certain | ~~Syntax highlighting uses Shiki (option C)~~ **SUPERSEDED by #21** | Discussed 2026-09-19 — user chose C against the study's recommendation of B. Superseded 2026-09-21 when highlighting moved server-side | S:95 R:60 A:85 D:90 |
| 6 | Confident | 👀 is actor-blind: a human's own 👀 also suppresses dispatch, and un-reacting is the re-dispatch gesture | Proposed as the resolution to the collision the study flagged; user's "use it" endorsed the approach. Keeps the predicate identity-free and needs no bot account | S:70 R:75 A:85 D:75 |
| 7 | Confident | Internal surface kind is `review`, not `changes` | Recommended in discussion, not contradicted. "Changes" collides with fab's own vocabulary (`fab/changes/`, change slug, "Active change") in the same surfaces. Renaming later is a registry entry plus a type member | S:65 R:85 A:90 D:70 |
| 8 | Confident | The listener is a tracker sibling of `operatorQueueTracker`, NOT a cron entry | Designed in discussion with rationale: cron entries are user-authored disk-backed per-server files with orphan GC; a per-window toggle would churn against that lifecycle | S:70 R:60 A:90 D:75 |
| 9 | Confident | Two-cadence backend split: thread digest in the existing prstatus batch, full bodies in a new on-demand `internal/prreview` | Designed in discussion. The batch runs every 90s over every PR the viewer owns; full bodies there multiply the payload by comment count across the whole window | S:70 R:65 A:90 D:80 |
| 10 | Confident | ~~Shiki uses the JS regex engine, not wasm~~ **MOOT under #21** | The wasm-in-`embed.FS` objection that drove this row is what server-side tokenization removes entirely; no frontend engine is chosen any more | S:55 R:75 A:85 D:70 |
| 11 | Confident | Dispatch granularity is the thread, not the individual comment | Designed in discussion — the agent needs the whole argument, not the last line | S:70 R:80 A:85 D:80 |
| 12 | Certain | Outdated threads are never dispatched; resolved is terminal; suggestion-only threads are skipped | Designed in discussion and rendered in the comment-states study. Dispatching an outdated anchor produces a confident edit in the wrong place | S:70 R:75 A:90 D:85 |
| 13 | Certain | Only the single-comment path dispatches on post; a pending review is invisible to `gh` until submitted | Mechanical consequence of the GitHub API, verified against the composer's two modes | S:65 R:85 A:90 D:85 |
| 14 | Certain | Arm state is a per-window `@rk_win_pr_listen` tmux option, shared across viewers | Applies `surface-layout.md`'s R7 test: it is a fact about the work, not a viewing posture. Matches the existing `@rk_win_*` registry convention | S:65 R:80 A:90 D:80 |
| 15 | Certain | "Mark as viewed" is per-viewer localStorage keyed on the head sha | Constitution IV states per-viewer state lives in localStorage; the sha in the key reproduces GitHub's reset-on-push behavior | S:70 R:90 A:90 D:80 |
| 16 | Certain | A `pr_review_listener` settings key gates the tick, shaped exactly like `cron_ticker` | Direct precedent in `internal/settings`; a live-gated background loop without a kill switch is the anti-pattern that key exists to avoid | S:65 R:85 A:90 D:85 |
| 17 | Confident | Unified diff view only in v1; split view is a follow-on | All four reference screenshots are unified; split view doubles the renderer surface for no signal in the supplied design | S:75 R:80 A:80 D:75 |
| 18 | Confident | ~~Files over a size cap render unhighlighted~~ **SUPERSEDED by #22** | Replaced by the dual-tier refine ladder, which degrades to briefly-imprecise colour instead of none. A byte cap survives as the innermost rung | S:45 R:85 A:70 D:45 |
| 19 | Confident | With several live windows on one `(repoDir, branch)`, dispatch targets the most-recently-active pane-bearing window | Not discussed. One obvious default exists and it is cheap to change, but it is a genuine pick among a few reasonable ones | S:30 R:80 A:60 D:40 |
| 20 | Confident | The toggle's unread badge counts *unhandled* threads, not all unresolved ones | Not discussed. Counting unhandled makes the badge go quiet as work is claimed, which matches the marker's meaning — but a reviewer may want the unresolved total instead | S:30 R:85 A:60 D:45 |

| 21 | Confident | Highlighting is server-side Chroma (`chroma/v2`), not an in-browser highlighter; the frontend ships no highlighting dependency | Discussed 2026-09-21 — user asked to integrate px0 directly. px0 is not importable (all `package main`, non-fetchable module path, and a server not a library), but its highlighter is Chroma, which is. Supersedes #5 and moots #10 | S:90 R:55 A:90 D:85 |
| 22 | Confident | Windowed lexing with dual-tier background refinement and a `refine` flag, byte cap inside the line cap | Ported from px0's `highlight.go` + `docs/internals/syntax-highlighting.md` (MIT). Strictly better than the size-cap rule it replaces: degrades to briefly-imprecise colour, never to none, and never blocks | S:70 R:70 A:85 D:80 |
| 23 | Certain | Token types map to short CSS classes coloured by `globals.css` custom properties | Ported from px0. This is the mechanism that makes both themes free from run-kit's existing palette and makes the diff tint compose underneath by construction | S:70 R:80 A:90 D:85 |
| 24 | Confident | The API returns per-line token spans, never one HTML blob per file; rows carry `data-l` / `data-side` / `data-at` | A blob cannot be interleaved and interleaving is the comment layer's whole job. The attribute tuple is GitHub's own `(path, side, line)` addressing, so it doubles as the anchoring contract | S:75 R:65 A:90 D:85 |
| 25 | Confident | Comment markers and selection highlights are applied via `TreeWalker` over text nodes, never by rewriting a row's `innerHTML` | Ported from px0's `decorate()`. Server-rendered token markup would otherwise be destroyed by any decoration; this was an unaddressed gap before the px0 read | S:70 R:70 A:90 D:85 |
| 26 | Confident | Virtualize the file list, not the diff body | px0 virtualizes its source viewer but renders diffs as plain DOM, on the ground that one file's diff is bounded. Correct for one file vs HEAD; for a PR the unbounded axis is file count, so the axis inverts | S:65 R:75 A:85 D:75 |
| 27 | Confident | Selection is saved as `{line, col}` and restored after repaint | A background refine swap under an in-progress selection is the normal case, and that selection is usually about to be quoted into a comment | S:65 R:80 A:85 D:80 |
| 28 | Certain | The token cache keys `(blobSha, path)` with a daemon-sized byte budget, not px0's path+mtime+size and 512 MB | Blob shas are immutable so the key can never invalidate wrongly; px0's budget suits a foreground tool you close, not a daemon with a ~20 MB idle footprint to protect | S:70 R:85 A:90 D:85 |
| 29 | Confident | Row builders are shape-agnostic so split view later is a row-shape variation, not a second renderer | px0's `pairRows` pairs deletion and addition runs into one two-half row, keeping columns aligned with no synced-scroll code. Cheap to preserve now, expensive to retrofit | S:60 R:85 A:85 D:75 |
| 30 | Confident | Chroma's lexer-set size is measured during apply; ship-all vs curated-subset decided on the delta | Chroma's ~280 lexers are Go code in a Homebrew-distributed binary. The need to check is certain; the verdict depends on a number nobody has yet | S:55 R:85 A:80 D:70 |

30 assumptions (11 certain, 19 confident, 0 tentative, 0 unresolved) — #5 and #18 superseded, #10 moot.
