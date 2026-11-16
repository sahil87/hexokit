# Status Pyramid — What Wins When

> The precedence model for every status signal HexoKit renders: which signal owns
> which visual channel, on which surface, under what preconditions. This spec is
> the design intent for the UI-surfacing change that follows the Generic
> Agent-State Tier (PR #314); sections marked **[target]** differ from shipped
> code, sections marked **[current]** describe behavior that already exists.
>
> Companions: [`agent-state.md`](agent-state.md) defines the `@rk_pane_agent_state`
> convention this spec consumes (states, staleness, reconciler, rollup);
> the dot's shape/hue rendering vocabulary lives in `status-dot.tsx` /
> `pr-status-model.ts` (`statusDotState`, `PHASE_HUE`,
> `prOwnsGlyph`/`prGlyphColor` for the row's PR glyph channel).

---

## The Signal Inventory

Four signal layers, each with a precondition that determines whether it exists
for a given window. Layers are facts about the world; *tiers* (below) are the
display-precedence ladder built on them.

| Layer | Signal | Exists when | Source |
|-------|--------|-------------|--------|
| L0 — tmux output | `activity` (active/idle), `activityTimestamp` | always, every window | `#{window_activity}` within 10s (`ActivityThresholdSeconds`) |
| L1 — agent lifecycle | `agentState` (active / waiting / idle) + epoch | an instrumented agent runs in a pane of the window | `@rk_pane_agent_state` pane option, window rollup `waiting > active > idle`; absent = unknown; PID-liveness reconciler clears dead-agent values, shell-name fallback for legacy two-segment values (see agent-state.md) |
| L2 — fab pipeline | `fabChange`, `fabStage`, `fabDisplayState` | the pane's worktree has an active change | cwd → `.fab-status.yaml` → `.status.yaml`, via the pane-map join |
| L3 — PR | `prNumber`/`prUrl` + `prState`/`prChecks`/`prReview`/`prIsDraft` | the window's fab change records a PR, or the pane's branch resolves to one; the default-branch carve-out (#389) applies only to branch fallback | fab `.status.yaml` `prs:` (last entry, resolved by URL) first for fab-bound windows; otherwise branch → `gh` lookup, with MERGED/CLOSED candidates admitted only when their head commit is HEAD or its ancestor (invariant 6) |

Two orthogonal *axes* run across these layers:

- **Journey** (where is this work): L2 stage → L3 PR. Encoded in **hue + shape**.
- **Attention & flags** (does this need a human *now* / did the pipeline fail
  here): L1 `waiting` (and, future, "stuck"); L2 `failed`. Encoded as
  **additive overlays** — never in hue or shape.

### Why L0 exists (and what it no longer does)

L0 is the **floor**: the only layer whose precondition is "always", and therefore
the only signal for the non-agent majority of a terminal console — builds,
REPLs, ssh sessions, `htop`, dev servers, log tails. Dropping it would make the
pyramid describe only agent/fab/PR panes: an agent-dashboard model, contradicting
HexoKit's terminal-underneath positioning (an agent is just one thing you run in
a pane).

L0 speaks about **bytes, not intent** — it answers "is output happening", never
"does this need me" — so it is never an attention signal. Its historically
misleading cases were all *agent* panes (a spinner repainting below a permission
prompt reads "active"; a silently thinking agent reads "idle"); the agent tier
now owns every such window, and L0 never speaks for a pane with a fresh
`@rk_pane_agent_state`. What remains is its honest domain, exactly three jobs:

1. Bottom-tier solid/ring for windows with no PR, no change, no agent.
2. The elapsed ticker for those windows (`idle 23m` on a forgotten shell pane).
3. The duration-mute rule (output flowing → hide elapsed), pierced only by `waiting`.

A future refinement MAY consult `#{pane_current_command} ≠ shell` (already
collected as `PaneCommand`) as a complementary process-running signal for the
floor tier — a silent long build reads busy correctly by process, wrongly by
output. Not v1.

---

## The Channel Model

| Channel | Carries | Vocabulary |
|---------|---------|------------|
| Core hue **[current — compositional vocabulary]** | which journey + position in it (the LOCAL story) | **cool = fab pipeline**: blue (building — intake·apply·review) → green (PR-ready/done — ship·review-pr·done) · **warm = ad-hoc agent**: yellow · gray = floor (no agent, no journey). Purple/orange are retired from the dot |
| Shape | **liveness** — the SAME meaning in every hue | solid (**work happening NOW** — agent mid-turn; floor: output flowing) · ring (**at rest** — no live worker · idle agent · waiting agent · parked done · quiet shell). Per-family source: journey hues read the rolled-up `agentState` only (absent/stale ⇒ ring); the L0 output fallback is the floor's alone |
| PR glyph **[current]** | the REMOTE story — the branch's PR on GitHub; never the dot | right-edge git-pull-request glyph, six states via `prGlyphColor`: red closed (✕ icon) > purple merged > red failing > gray open-draft (dotted-rail icon) > yellow checks-running > green open; gated on `prOwnsGlyph` (owned PR: open/merged/closed), un-family-gated |
| Overlays **[current]** | attention + failure + relation — THREE **additive** flags, never destructive, never a tier | constant-**yellow** pulsing halo = `waiting`, over any tier (blocked is at rest: the halo wraps a ring) · **red center** = `failed` (fab `fabDisplayState === "failed"` — the only dot-red), over either shape: inside the hollow ring at rest, as a **bullseye** (dark gap ring) over solid so failure changes the silhouette, never color alone; flagged dots keep the 9px footprint · **watched underbar** = on the fab operator's watchlist — a 1px neutral bar (`text-text-secondary`, painted from `currentColor`) 4px below the dot, sidebar window row only; stale (the operator loop's tick overdue) = dimmed AND dashed (1px-on/2px-off), static. Never a hue, never a shape. (future) slow-pulse halo = stuck. No overlay = no flag |
| Duration text | how long in the current resting state | `waiting Xm` (attention token) · `idle Xm` · tmux elapsed |
| Hover card (row flyout) | full detail | hue-word + liveness-word label + flags, the `fab`/`pr`/`opr` registers (`out`/`agt` omitted — the row already carries them), PR link, docs link |
| Rollup badges **[current]** | attention counts up the hierarchy | session row → server tile → board header |

**Compositional vocabulary — split by story, not by precedence.** The **dot
tells the local story** (what runs in this pane: which journey, is anyone
working, did the pipeline fail here, does it need me) and the **glyph tells
the remote story** (the branch's PR on GitHub). Four hues × two shapes, plus
three additive overlay flags (waiting halo · failed red center · watched
underbar), and shape means
the same thing in every hue — fully compositional, no per-cell captions. The
fab hue is a **two-stop progress bar, not a stage map**: blue = building
(pre-PR work), green = PR-ready/landed/done ("still cooking vs out the door"
at a glance); the exact stage lives in the `fab` register. The glance rule:
cool core = my pipeline, warm core = my ad-hoc agents, gray = just a terminal,
**yellow glow = needs me now**, **red center = my pipeline failed here**.

> **Superseded — aqo6 shape channel (260810-aqo6, shape half only).** The
> compositional-vocabulary change shipped shape = pipeline *health* from
> `fabDisplayState` bookkeeping (three shapes: solid / ring / failed dotted
> ring), so a stage marked `active` rendered a solid "work happening" dot even
> when its agent had been idle for hours. The liveness rework ties shape to
> the PID-reconciled `agentState` (solid cannot outlive its process) and
> decomposes the third `failed` shape into the additive red-center overlay.
> aqo6's other halves stand unchanged: the PR eviction to the glyph, the
> two-family hue ladder, and the additive waiting halo. Palette v3's
> supersession (below) is kept for the record.

> **Superseded — palette v3 (260706-y1ar).** The prior palette packed 6 hues ×
> 5 shapes: the PR owned the dot per family (purple = fab PR, orange = agent
> PR), `done` was a sharp square, `skipped` a gray ring, and every non-intake
> fab stage collapsed to a single green (the "green collapse", freeing amber).
> Once the row's rest-state PR glyph shipped (93dy), the dot's PR tier became
> redundant — a merged PR rendered a purple square AND a purple glyph two
> pixels apart — and shape meaning shifted per row (pending = "checks running"
> only on PR rows). The eviction removed two hues (purple, orange) and two
> shapes (done square, skipped ring) from the dot and made the vocabulary
> compositional. Palette v3's rationale history (amber retirement, the green
> collapse's supporting fact that the old ship/review-pr green barely rendered
> because `/git-pr` creates the PR mid-ship) is kept here for the record.

**Attention is additive: a constant-yellow pulsing halo around the dot, with the
core hue and shape untouched.** Blue core + yellow halo = "pipeline at intake,
needs me" (intake is the *asking* stage — fab-waiting-at-intake is a common
case, not a corner). Yellow is the agent color in both roles: yellow core = "an
ad-hoc agent lives here", yellow halo = "an agent needs you" — the glow never
claims the window is ad-hoc, because family identity lives strictly in the
core. Under `prefers-reduced-motion` the halo renders as a static yellow outer
ring — attention is never encoded in motion alone. Rejected alternatives, for
the record: **hue-flip on waiting** (destroys family identity exactly when
attention is highest); **self-colored halo** (pulse in the core's own hue —
fine animated, but its reduced-motion form nearly vanishes and reads like the
hollow `ring` shape; also leaves colorblind + reduced-motion users with no
cue); **fuchsia attention hue** (superseded — the amber collision that forced
it no longer exists once fab collapses to blue/green).

**Watched is additive too: a 1px neutral underbar beneath the dot, on the
sidebar window row only.** The fab operator's watchlist is a relation, not a
journey position, so it can never be a hue or a shape; below the dot is the
one free geometric slot (the halo owns the perimeter up to 3px of box-shadow,
the red center owns the middle). The bar is `text-text-secondary` painted
from `currentColor` in every state — selected rows included — so it can never
read as journey, and it sits 4px below the 7px dot (3px below the 9px flagged
footprint) so it clears the halo. Stale (the operator loop's tick overdue) is
dimmed AND dashed — `opacity-50` plus a 1px-on/2px-off dash, static — so
staleness is never encoded in opacity alone. The placement study is
[`docs/wiki/watched-row-indicator-studies.html`](../wiki/watched-row-indicator-studies.html).

**Rejected — watched placements**, for the record: **green ◉** (spends the
PR-ready hue on a relation and adds a second dot silhouette — hue +
silhouette collision); **neutral ◉** (the bullseye trap — beside a gray floor
ring a gray ◉ reproduces the failed-over-solid silhouette); **orbit ring at
4px** (17px footprint in a 24px row, eats the well gap, a third concentric
shape); **reticle ticks** (noise at 7px, collide with the halo perimeter);
**dashed dot border** (border style is the shape/liveness channel and was the
pre-#802 failed rendering); **marker-well texture** (the well is
human-owned); **ghost headset** (the headset says "this row IS the
operator"); **dotted name underline** (reads as a link, rides the
inline-rename control — parked fallback); **nothing on the row** (zero glance
surface until the agents-tile dashboard — interim fallback).

---

## The Tier Ladder (dot ownership)

The dot's core hue is owned by **two ladders joined at the top** — first
precondition wins **[current — compositional vocabulary]**; shape is
**liveness, derived per family**; `failed` and `waiting` are additive overlay
flags. No PR branch exists anywhere in the ladder:

```
fabChange ?  (stage ∈ {intake, apply, review} ? blue-building : green-PR-ready,
              shape by agent liveness, failed flag by fabDisplayState)
          :  (fresh agentState ? yellow (solid mid-turn / ring at rest)
                              : gray floor, shape by tmux activity)
failed    →  additive red center, over either shape (fab hues only)
waiting   →  additive yellow halo, over anything (core hue + shape kept)
```

- **[D1 — dissolved]** No family owns the dot via PR — the PR was evicted to
  the row's rest-state glyph, which is (as it already was) un-family-gated:
  any pane whose branch has an owned PR shows the glyph, even a plain floor
  pane whose dot stays gray. Derivation stays universal (the L3 register and
  the hover card show the PR for any pane; Principle X); a plain shell never
  renders a mystifying PR dot.
- The blue↔green split is **stage-based, never `prNumber`-based** — the dot
  consults no PR field. A **`skipped`** display-state makes the window not
  fab-owned: the ladder falls through (agent tier, then floor).
  `fabDisplayState` now contributes only the **failed overlay flag**
  (`=== "failed"`) — never the shape.
- **[current]** shape = **liveness** on the journey hues (fab blue/green,
  ad-hoc yellow): **solid iff the rolled-up `agentState === "active"`**;
  `waiting`, `idle`, and absent/stale all yield **ring** (a waiting agent is
  blocked — at rest by definition). The output-flowing L0 fallback is the
  gray **floor's alone** — a dev server flowing output in a fab worktree must
  not render solid (accepted cost: an uninstrumented agent on a fab window
  reads ring). `agentState` is PID-reconciled, so a solid cannot outlive its
  process — but solid is **not proof of progress**: a live-but-wedged agent
  stays solid until the reserved `stuck` overlay exists.
- **[current]** the agent tier is **warm**: a fresh `agentState` gives a
  yellow core (solid mid-turn even while quiet; ring when idle or waiting —
  an agent parked here), replacing the 10-second output heuristic for those
  windows. Freshness rules are #314's (absent option / shell reconciler →
  fall through to the floor).
- The **overlays are ladder-exempt and additive**: `waiting` wraps any tier's
  dot in the constant-yellow pulsing halo — a fab intake agent asking a
  question keeps its blue core; a review-failed window keeps its blue hue and
  its red-center flag over whichever base shape its liveness gives.

### What-wins-when facts (the crisp version)

1. **"Green aligns with PR existence" is emergent, not a PR check.** The
   blue↔green split keys on the stage alone (`intake`/`apply`/`review` →
   building, else PR-ready); for a pipeline-run change `/git-pr` creates the PR
   mid-ship, so green *in practice* coincides with the PR's life — but the dot
   never consults `prNumber`. An adopted change (PR pre-exists) or a reused
   branch with an open PR shows its glyph earlier; the dot stays stage-true.
2. **PR state never reaches the dot.** The remote story — open, checks
   running, failing, merged, closed — lives on the row's rest-state glyph
   (`prGlyphColor`: closed-red > merged-purple > fail-red > draft-gray >
   pending-yellow > open-green; shape carries what color cannot — ✕ for
   closed, dotted rail for draft) and the register surfaces. Dot and glyph
   never share a fact: dot-red = my pipeline failed here, glyph-red = the PR
   is failing on GitHub or was closed there (the ✕ tells which).
3. **~~Agent state owns the warm family, but never surfaces in the dot on
   fab windows~~ — SUPERSEDED.** Agent state now owns the SHAPE on every
   journey hue, fab included: solid = physically live (PID-reconciled
   `agentState === "active"`) beats solid = bookkeeping stage-active — a
   stale-active stage must stop reading healthy (the hours-idle solid that
   motivated the liveness rework). `fabDisplayState` keeps only the failed
   overlay flag; the hover card's and PANE panel's `agt` register and the
   additive halo still carry the full agent story.
4. **`waiting` is never a tier and never destructive** — it cannot displace
   core hue or shape anywhere. It is an additive overlay: constant-yellow halo
   pulse + the register surfaces' `waiting Xm` + rollup counts + push. Under
   shape = liveness, the waiting STATE itself implies the ring base (blocked
   is at rest) — the halo always wraps a ring.
5. **tmux output recency surfaces in exactly two places**: the bottom tier's
   solid/ring (no change, no PR, no agent), and the duration-mute rule (below).
   It is never an attention signal — output ≠ needs-me — and it never makes a
   journey hue solid (the L0 fallback is the floor's alone).
6. **Merged-PR durability is derived, not remembered** **[current — D2 revised;
   feeds the GLYPH post-eviction]**.
   The first implementation resolved D2 with an `--state open` lookup plus a
   10-minute **in-memory grace window** (`branchPRMergedGrace`) — which proved
   wrong in production: the grace expires (and any rk restart wipes it), so the
   merged-purple signal silently decayed minutes after merge. The revised rule:
   the branch→PR derivation queries **all states** and picks by precedence
   **open (most recently updated) > merged (most recent) > closed (most
   recent)** (`pickBranchPR`); a closed-unmerged PR is therefore selected only
   when the branch has no open or merged PR, and renders the red ✕ glyph. A
   merged PR then renders the
   glyph's **durable purple merged state statelessly and restart-proof** for as
   long as the pane sits on that branch — no grace clock, no negative-stamp
   machinery (`wentNegativeAt` retired). Branch-reuse edge: an open PR always
   outranks an older merged one on the same branch. (Pre-eviction this same
   durability fed the dot's purple done-square; the derivation is unchanged —
   only its consumer moved to the glyph.)
   **Default-branch carve-out (#389)**: a pane on the repo's *default* branch
   never derives a branch-PR at all. `gh pr list --head` matches by head-ref
   *name* only, so every default-branch match is degenerate (a fork PR whose
   head is named `main`, or a historical same-repo PR whose head was the
   default branch) — and the durability rule above would pin that wrong PR
   forever. The refresher detects the default branch locally
   (`git symbolic-ref refs/remotes/origin/HEAD`, per-repo cached, fail-open
   on lookup failure) and resolves excluded pairs to an authoritative
   negative, clearing any stale positive within one pass.
   **Branch-reuse ownership**: an OPEN candidate still matches by head-ref name
   alone and outranks terminal candidates. A MERGED or CLOSED candidate is
   attributable only when its `headRefOid` is HEAD or an ancestor of HEAD
   (`git merge-base --is-ancestor`); a missing head commit is not owned. This
   filter runs before precedence picking, so a historical PR cannot attach to a
   fresh branch that merely reuses its name, while a branch that genuinely
   contains its merged PR's head keeps the durable purple glyph. Fab-recorded
   `prs:` identity is explicit and outranks both this fallback and the default-
   branch carve-out.
7. **Unknown beats wrong**: absent `@rk_pane_agent_state`, or a value on a pane whose
   command is a plain shell (reconciler), means *no agent tier* — the ladder
   falls through to tmux. Nothing renders a guessed agent state.

---

## Decision Table

`—` = signal absent. Compositional vocabulary; the shape column is **liveness**
(journey hues: solid iff the rolled-up `agentState` is `active`, else ring;
floor: output); the overlay columns are the additive flags — the red-center
`failed` overlay (fab hues only) and the waiting halo (core hue/shape
unchanged by it); the glyph column is the row's rest-state PR glyph (the dot's
column never encodes PR state).

| # | journey | signals | Dot (core hue · shape [· center] [· halo]) | Glyph | Tip/panel duration |
|---|---------|---------|--------------------------------|-------|--------------------|
| 1 | floor | no agent · output flowing | gray · solid | — | *(none — muted)* |
| 2 | floor | no agent · quiet | gray · ring | — | tmux elapsed |
| 3 | ad-hoc | agent active | yellow · solid | — | *(none)* |
| 4 | ad-hoc | agent idle | yellow · ring | — | `idle Xm` (from epoch) |
| 5 | ad-hoc | agent **waiting** | yellow · ring · **halo** | — | `waiting Xm` — push after sustain |
| 6 | ad-hoc | PR open · healthy | yellow (per agent liveness) | green | per agent state |
| 7 | ad-hoc | PR checks fail | yellow (per agent liveness) | red | |
| 8 | ad-hoc | PR merged | yellow (per agent liveness) | purple — durable via state-all derivation (D2 revised) | |
| 9 | ad-hoc | PR open + **waiting** | yellow · ring · **halo** | green | `waiting Xm` |
| 10 | floor | PR on branch · no agent · no change | gray (floor) | per PR state | PR also in the L3 register; never the dot |
| 11 | fab | intake · active/ready · worker live | blue · solid | — | |
| 12 | fab | intake · pending / no live worker | blue · ring | — | |
| 13 | fab | intake + **waiting** | blue · ring · **halo** | — | the asking stage — common case |
| 14 | fab | apply/review · worker live | blue · solid | — | idle→`idle Xm`, else none |
| 15 | fab | review · failed | blue · per liveness · **red center** (ring + center when nobody is on it; bullseye while a rework agent is live) | — | |
| 16 | fab | review · failed + **waiting** | blue · ring · **red center** · **halo** | — | hue and overlays compose; the ring base is the waiting state's at-rest shape |
| 17 | fab | ship→done · PR open · healthy | green · per liveness | green | |
| 18 | fab | ship→done · PR checks running | green · per liveness | **yellow** (checks running) | |
| 19 | fab | ship→done · PR checks fail / changes requested | green · per liveness | red | |
| 20 | fab | ship→done · PR merged | green · solid (**live agent** on the window) / green · ring (parked done) | purple — durable via state-all derivation (D2 revised) | |
| 21 | fab | PR closed-unmerged · change live | the live stage tier (closed renders the red ✕ glyph, never a dot tier) **[current]** | — | |
| 22 | fab | displayState skipped | falls through — agent tier, else gray floor **[current]** | per PR state | |

---

## Row Minimalism **[decided]**

The WindowRow's trailing status **text** cluster — the stage word (`intake`, red
when failed) and the duration text — is **removed**; the name gets the freed
width back (less truncation, especially on mobile).

The row carries **two glyph-only status signals**: the leading StatusDot, and —
for a window with an owned PR (`prOwnsGlyph`: `prNumber` present with a known
owned state, `open`, `merged` or `closed` — unknown/unconfident states never
own) — a **rest-state git-pull-request glyph** in the trailing cluster's
last slot, colored from the shared PR vocabulary (`prGlyphColor`: red closed >
purple merged > red failing > gray open-draft > yellow checks-running > green
open) with the icon picked by state (✕ closed, dotted-rail draft, arc
otherwise — closed and failing share red and separate by shape). The
glyph is informational decoration: `aria-hidden`, never focusable, never
clickable. It swaps out entirely on row hover, on coarse pointers, and on
keyboard focus within the cluster, where the pin + kill actions take the slots.
This is a deliberate partial reversal of the original "the StatusDot is the
row's only externally visible status signal" rule: PR existence and PR health
are the highest-value scan question, and a hue-only dot answers it too coarsely.
The reversal is bounded to a glyph — **no status TEXT returns to the row**.
**[current]**

Where each removed signal goes:

| Removed from the row | Survives as |
|----------------------|-------------|
| stage word (`review`) | dot hue at a glance (blue building / green PR-ready); exact stage in the row flyout card and the PANE panel |
| failed-red stage text | the dot's **red-center overlay** — over whichever base shape the window's liveness gives (ring + center when nobody is on it; bullseye while a rework agent is live) |
| `done`-parking suppression | the dot's green resting ring |
| PR states (merged / failing / pending) | the rest-state PR glyph column (purple / red / yellow) |
| idle/elapsed duration | row flyout card + PANE panel; the *attention* half ("sitting too long") migrates to the future `stuck` overlay |
| `waiting Xm` | the waiting overlay itself (see D3 resolution) + the flyout card + PANE panel |

**The register view has TWO surfaces**: the bottom PANE panel and a row-anchored
**hover flyout card** (opening on whole-row hover, keyboard row focus, or a
coarse-pointer dot tap, at a fixed x on the sidebar's right edge). Both render
the four signal layers as separate, orthogonal lines — never collapsed — plus a
fifth **`opr` watchlist register** (last) when the fab operator monitors the
window, so the dot is a *pure function* of what they show and can be mentally
derived from it (every dot overlay has a register: the watched underbar's
stale dimming reads off `opr`'s `tick <age> ago`):

```
out  claude · flowing                   (L0)
agt  waiting 3m                           (L1)
fab  dmex · review · failed               (L2)
PR   #314 open · checks fail · draft      (L3)
opr  watched · review · tick 2m ago       (operator watchlist)
```

The slug is written once — the branch carries it.

Register keys are fixed-width 3-char lowercase (`out` / `agt` / `fab` / `pr` /
`opr`), matching the panel's existing `tmx`/`cwd`/`git` vocabulary.
**[current]**

Absent layers render as absent (no placeholder rows for a plain shell pane
beyond `output`).

## Duration-Text Ladder (register surfaces)

With row minimalism, this ladder governs the **two register surfaces** — the row
flyout card and the PANE panel; the row itself renders no duration. (The
Decision Table's "Duration text" column henceforth describes their content.)

**[current]** (the pre-y1ar `getWindowDuration` row ladder is retired with Row
Minimalism — the function is deleted):

```
waiting Xm   (attention token; NOT muted by output)   ← new
(output flowing → no duration)                        ← unchanged mute
idle Xm      (computed from @rk_pane_agent_state epoch)     ← source swap
tmux elapsed (activityTimestamp ticker)                ← unchanged
```

The waiting exemption is load-bearing: a Claude blocked on a permission prompt
keeps rendering its spinner *below* the prompt, so L0 reads "flowing" — the mute
rule would hide exactly the duration that matters most. `waiting` is the only
state that pierces the mute. (In the register view the L0 line always shows its
elapsed value — the mute rule applied only to the retired one-line tip summary,
where space was contested, never to an uncontested register line.)

---

## Attention Propagation **[current]**

The `waiting` overlay rolls up the hierarchy as a count of waiting windows:

| Surface | Treatment |
|---------|-----------|
| Window row (sidebar) / window tile (SessionTiles) / pane-panel header | halo pulse on the existing StatusDot (free — same component) |
| Session row | count badge when > 0 (e.g. `2⚠` styled per chip vocabulary) |
| Server tile (Host TMUX SERVERS zone) | count badge; one glance at `/` answers "does anything need me" |
| Server tile (sidebar SERVER panel) | count badge, right-aligned on the tile's "N sess" line (inline flex, not absolute — avoids the hover-revealed palette/kill action cluster at the tile top-right); same attached-server-only semantics as the Host tile |
| Board header + board pane | header count; waiting pane gets a pulsing seam (3px, border-width system) — reduced-motion: static seam |
| Command palette | `Agent: Next waiting` — cycles waiting windows (current server first, then others), the keyboard-first attention nav (Constitution V) |
| Web Push | `waiting` sustained ≥ 15s → one push per waiting episode (dedupe on the state's epoch; re-arm when the state changes). Body: window + `waiting for input`; carries the question text when a future `@rk_agent_msg` option exists. `idle`/`active` never push |
| Row flyout card | carries the `agt` register on every tier: `waiting 3m` / `active` / `idle 12m` |

Not built (deliberately): a top attention banner (fights the minimal top bar —
the rollup badges + palette nav cover discovery), a second per-row indicator
(mobile clutter), any new page (Constitution IV).

---

## Future Tenants of the Animation Channel

- **Stuck** — `idle` ≥ threshold (default 15m, matching the fab-operator's 🔴
  rule) at a non-terminal fab stage → *slow* pulse, distinct from waiting's
  fast pulse. Attention-tier, so it overlays like waiting; not v1.
- **Error** — the `@rk_pane_agent_state` convention has no error state in v1; if one
  is added, it joins the overlay (never the tier ladder).

One overlay at a time: `waiting` outranks `stuck`.

---

## Accessibility

- `aria-label` composes hue word + liveness word + flags: `"building — failed —
  at rest — agent waiting 3m"`. The watched overlay appends one trailing clause
  after the waiting suffix — ` — watched`, or ` — watched (operator stale)`
  when the operator loop's tick is overdue (`"building — at rest — watched"`);
  the underbar itself is `aria-hidden` decoration. Color and motion are never
  the sole channel (the halo has a static reduced-motion form; the bullseye
  changes the silhouette, not just the color; the underbar is dimmed AND
  dashed when stale, never opacity alone; the duration text and the hover card
  carry the same fact).
- The pulse respects `prefers-reduced-motion` per the existing animation
  discipline (`rk-*` utilities zero out; JS treatments skip themselves).

---

## Open Decisions

| ID | Question | Resolution |
|----|----------|-----------|
| ~~D1~~ | ~~PR tier gate: `prNumber` alone?~~ | **Dissolved (compositional vocabulary — aqo6)**: no family owns the dot via PR — the PR was evicted to the row's rest-state glyph, which is un-family-gated as it already was (any pane with an owned PR shows it; derivation stays universal in the register view). *History*: palette v3 first resolved this per-family (purple = `fabChange && prNumber`, orange = `fresh agentState && prNumber`) before the eviction removed PR dot-ownership entirely |
| D2 | Merged/closed PR retention under branch-derivation | **Revised after production observation** (first resolution — `--state open` + 10-min in-memory grace — decayed the merged-purple signal on grace expiry or rk restart): derivation queries **all PR states**; precedence open (most recent) > merged (most recent) > closed (most recent); merged renders **the glyph's durable purple state** statelessly; closed-unmerged renders the glyph's red ✕ state (GitHub's closed color, matching `PR_STATE_COLORS.closed` on the register line). Grace-window machinery retired. Post-eviction the consumer is the GLYPH, not a dot square. **Default-branch carve-out (#389)**: branch fallback never runs for a pane on the repo's default branch — head-name-only matching makes every such candidate degenerate, so excluded pairs resolve to an authoritative negative. **Branch-reuse ownership (invariant 6)**: before precedence picking, MERGED/CLOSED candidates require their `headRefOid` in HEAD's ancestry; OPEN matches by name. Fab `prs:` identity outranks branch fallback and the carve-out. **[current]** |
| ~~D3~~ | ~~Is a 7px halo pulse salient enough for `waiting`?~~ | **Resolved (additive halo, palette v3 — carried forward unchanged)**: `waiting` = constant-**yellow** pulsing halo around the dot, core hue and shape untouched. Rejected: hue-flip (destroys family identity precisely when attention is highest — e.g. fab intake asking); self-colored halo (reduced-motion form nearly invisible + collides with the `ring` shape); fuchsia (its motivating amber collision no longer exists). Reduced-motion: static yellow outer ring |
