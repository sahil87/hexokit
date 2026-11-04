# Status Dot — The Compositional Vocabulary

> [← Back to the README](https://github.com/sahil87/hexokit/blob/main/README.md#status-dots--read-every-window-at-a-glance)

> The single status dot reused on the sidebar window row, the dashboard window cards, and the
> pane-panel header. It tells the window's **local story** — what runs in this pane: which journey,
> is anyone working right now, did the pipeline fail here, does it need me — using **two
> orthogonal visual channels** plus **three additive overlay flags**: **core hue = journey**,
> **shape = liveness** (the same meaning in every hue), a **red center = the pipeline failed
> here**, a **constant-yellow pulsing halo = the agent is waiting on you**, and — on the sidebar
> window row only — a **neutral underbar = on the fab operator's watchlist**. The **remote
> story** — the branch's PR on GitHub — lives on the row's right-edge **PR glyph**, never on the
> dot. There is no matrix to memorize: hue × shape × overlays compose freely and no cell is
> special.

Implementation: `app/frontend/src/components/status-dot.tsx` (rendering) +
`app/frontend/src/components/pr-status-model.ts` (`statusDotState` / `fabPhase` /
`PHASE_HUE` / `prOwnsGlyph` / `prGlyphColor`). Design authority:
[`docs/specs/status-pyramid.md`](https://github.com/sahil87/hexokit/blob/main/docs/specs/status-pyramid.md).

## Precedence — which input drives the dot (two families joined at the top)

The dot's core hue is owned by **two ladders joined at the top** — the first precondition that
holds wins. **Shape is liveness, derived per family**: the journey hues (blue · green · yellow)
read the window's rolled-up `agentState` ONLY (absent or stale ⇒ ring — a dev server flowing
output in a fab worktree must NOT render solid; the output-flowing fallback is the gray floor's
alone). `failed` and `waiting` are *additive overlays*, computed independently (ladder-exempt,
never tiers of their own). **No PR branch exists anywhere in the ladder** — the dot never
consults PR fields:

```
fabChange ?  (stage ∈ {intake, apply, review} ? blue-building : green-PR-ready)  [cool = fab pipeline]
          :  (fresh agentState ? yellow agent : gray floor)                      [warm = ad-hoc agent / floor]
shape     →  journey hues: solid iff agentState === "active", else ring · floor: output flowing ? solid : ring
failed    →  additive red center, over either shape (fabDisplayState === "failed" — fab hues only)
waiting   →  additive constant-yellow halo, over anything (core hue + shape kept)
```

The glance rule: **blue = still cooking, green = out the door / done, yellow core = my ad-hoc
agents, gray = just a terminal, yellow glow = needs me now, red center = my pipeline failed
here.**

1. **Cool family — fab pipeline** (the pane's worktree has an active fab change):
   - `stage ∈ {intake, apply, review}` → **blue building** (pre-PR work).
   - every other stage (`ship`, `review-pr`, `done`, unknown) → **green PR-ready** — the change has
     completed its local work ("the PR is ready"). The blue↔green split is **stage-based, never
     `prNumber`-based**; its alignment with PR existence is emergent (`/git-pr` creates the PR
     mid-ship), not a stage check.
   - shape comes from the window's rolled-up **`agentState`**, not from stage bookkeeping: a
     stage marked `active` whose agent has been idle for hours renders a **ring**, not a solid —
     solid is physically honest (`agentState` is PID-reconciled server-side, so it cannot outlive
     the process).
   - a **`skipped`** display-state makes the window *not fab-owned* — the change has left its
     journey, so the ladder simply falls through (agent tier, then floor).
2. **Warm family — ad-hoc agent** (no fab change, but a fresh `@rk_pane_agent_state`) → **yellow**
   (solid mid-turn, ring when the agent is idle or waiting — blocked is at rest by definition).
3. **Floor** (no fab change, no fresh agent) → **monochrome gray** tmux activity (solid while
   output flows, ring when quiet) — the one place output drives the shape.

## The four legend strips

![StatusDot compositional reference](https://raw.githubusercontent.com/sahil87/hexokit/main/docs/img/status-dot-reference.svg)

### 1 · Core hue = journey (4)

| Hue | Token | Hex (ref) | Means |
|-----|-------|-----------|-------|
| blue | `text-signal-blue` | `#60a5fa` (dark; `#2563eb` light) | fab **building** — intake · apply · review (pre-PR work) |
| green | `text-accent-green` | theme green | fab **PR-ready / done** — ship · review-pr · done (local work complete) |
| yellow | `text-signal-yellow` | `#facc15` (dark; `#b07d02` light) | **ad-hoc agent** — a fresh `@rk_pane_agent_state`, no fab change |
| gray | `text-text-secondary` | gray | **floor** — plain terminal; color is reserved for a journey |

The purple and orange PR hues are **retired from the dot** — purple survives in the glyph and the
PR text surfaces. The fab hue is a **two-stop progress bar, not a stage map**: exactly two fab
hues, answering "still cooking vs out the door" at a glance; the exact stage lives in the `fab`
register on the hover card and the PANE panel.

### 2 · Shape = liveness (2 — the same meaning in every hue)

| Shape | Rendering | Means |
|-------|-----------|-------|
| solid | filled circle in the core hue | **work happening NOW** — agent mid-turn (`agentState: active`, PID-reconciled); floor: output flowing |
| ring | hollow circle, 1.8px border in the core hue | **at rest** — no live worker · idle agent · waiting agent · **parked done** · quiet shell |

The shape source is **per-family**: journey hues read the rolled-up `agentState` only (absent or
stale ⇒ ring); the output-flowing signal belongs to the gray floor alone. Solid cannot outlive
its process (the server-side PID reconciler clears a dead agent's state) — but solid is **not
proof of progress**: a live-but-wedged agent stays solid until the reserved `stuck` overlay
exists.

A **parked-done change is a green resting ring** — resting, journey complete; the purple merged
glyph (when a PR exists) says how it ended. All unflagged dots render at one uniform 7px
footprint.

### 3 · Overlays = additive flags (3 — over any hue × shape; never a tier, never destructive)

| Overlay | Rendering | Means |
|---------|-----------|-------|
| **failed red center** | a small (~3px) **red** center dot flagged over the base shape, at a 9px footprint | review / review-pr failed **here** (fab `fabDisplayState === "failed"`) — the only dot-red |
| **waiting halo** | a constant-yellow pulsing box-shadow ring around the dot (`rk-waiting-halo`) | an agent is **waiting on you** — blocked, therefore at rest: the halo always wraps a RING |
| **watched underbar** | a 1px **neutral** bar (`text-text-secondary`, painted from `currentColor`) 4px below the dot — 3px below the 9px flagged footprint — **sidebar window row only** | the window is on the **fab operator's watchlist** — a relation, so never a hue and never a shape; stale (the operator loop's tick overdue) = **dimmed AND dashed** (`opacity-50` plus a 1px-on/2px-off dash), static |

Failure and liveness are **orthogonal**: over a **ring**, the red center sits inside the hollow
ring ("failed, nobody on it — **act**"); over a **solid**, the flag cuts a **dark gap ring**
between the fill and the red center — a **bullseye** silhouette, so failure is never encoded in
color alone (colorblind a11y). Flagged dots keep the **9px footprint** (failure salience does not
drop); unflagged dots stay at 7px. Under `prefers-reduced-motion` the halo renders as a **static
yellow ring** — attention is never encoded in motion alone.

Yellow is the agent color in both roles — **yellow core** = "an ad-hoc agent lives here",
**yellow halo** = "an agent needs you now" — the glow never claims the window is ad-hoc, because
family identity lives strictly in the core.

The watched underbar renders only where the row passes the watched flag — today the sidebar
window row alone; the dashboard window cards, the pane-panel header, the status bar, and the tty
tile header render no bar. It is the same neutral ink whatever the dot's hue, so it can never
read as a journey position, and it clears the waiting halo's reach by sitting below it. The
watchlist's full story (stage, repo · branch, tick age) lives in the `opr` register on the hover
card and the PANE panel.

### 4 · PR = the right-edge row glyph (one channel, six states — never the dot)

A window with an **owned PR** (`prOwnsGlyph`: `prNumber` present with a known owned state — `open`, `merged`, or `closed`; unknown/unconfident states never own) shows a
git-pull-request glyph at the row's right edge, colored by `prGlyphColor` — first match wins, and
the order is the design:

| Color | Token | Icon | Means |
|-------|-------|------|-------|
| red | `text-signal-red` | ✕ closed icon | **closed** — GitHub's closed red (matches the register's `PR_STATE_COLORS.closed`); sits above fail (stale checks are noise, and passing checks must not fall through to green); the ✕ shape separates it from a failing PR |
| purple | `text-signal-purple` | normal | merged |
| red | `text-signal-red` | normal (or draft) | checks fail / changes requested — fail stays on top of every open state; a failing draft keeps the draft shape |
| gray | `text-text-secondary` | dotted-rail draft icon | open **draft** — the only gray glyph state; muted even while its checks run (draft outranks pending) |
| yellow | `text-signal-yellow` | normal | open, **checks running** (`prChecks: pending`) |
| green | `text-accent-green` | normal | open, checks pass or no decisive signal |

A closed-unmerged PR earns the **red ✕ glyph** (its register line is unchanged) — a dead PR is a
glance-level "this window needs a decision" signal. Shape and color divide the work: closed and
failing share red and are separated by shape (✕ vs arc); draft is the only gray state and also
carries its own shape (the dotted merge rail, GitHub's draft silhouette), so it never reads as an
open PR in a dim theme or to a colorblind viewer. The icon is picked once, by `prGlyphIcon`
(✕ closed first, dotted-rail draft, arc otherwise), at every glyph site. The glyph is
deliberately **not family-gated**: any pane whose branch has an owned PR shows it — even a plain
floor pane whose dot stays gray (derivation is universal, Constitution Principle X).

## Reading a row — composed examples

Read hue, then shape, then overlays, then glyph:

| Dot | Glyph | Reads as |
|-----|-------|----------|
| blue solid | — | worker building — a fab change with a live agent mid-turn |
| blue ring + red center | — | review **failed, nobody on it — act** |
| blue bullseye (solid + gap ring + red center) | — | review failed, **rework agent live** |
| blue ring + red center, yellow halo | — | review failed and the agent is asking |
| blue ring, yellow halo | — | intake stage, agent asking |
| blue ring + underbar | — | building, at rest, **watched by the operator** |
| blue ring, yellow halo + underbar | — | watched agent asking |
| blue ring, dashed dim underbar | — | watched, **operator loop stale** (dimmed + dashed) |
| green ring | purple | merged and parked — archive me |
| gray solid | — | build running (floor — output flowing) |
| gray ring | — | quiet shell |

## D2 — merged / closed-PR derivation (feeds the glyph)

The backend branch→PR derivation queries **all** PR states (`gh pr list --state all`) and picks by
precedence: an **open** PR (most recently updated) wins; else the most recent **merged** PR; else
the most recent **closed** PR. A **merged** PR therefore keeps resolving positive on every pass, so
the **glyph's purple merged state is durable statelessly** — derived fresh from `gh` each cycle,
with no in-memory grace clock and nothing for an rk restart to wipe. A **closed-unmerged** PR is
still derived (it shows in the L3 register) and feeds the red ✕ glyph as well. Branch-reuse
edge: an open PR always outranks an older merged one on the same branch. (Pre-eviction this
durability fed the dot's purple done-square; the mechanism is unchanged — only its consumer moved
to the glyph.)

## Row Minimalism — glyphs on the row, detail on hover

The sidebar window row's trailing status **text** cluster — the stage word (`intake`, red when
failed) and the duration text — is **removed**; the window name gets the freed width back (less
truncation, especially on mobile). The row's status signals are glyphs only: the leading StatusDot,
plus the rest-state PR glyph above. The PR glyph is informational — it swaps out for the pin and ✕
actions the moment you hover the row.

Where each removed signal survives:

| Removed from the row | Survives as |
|----------------------|-------------|
| stage word (`review`) | the dot's core hue at a glance (blue = pre-PR, green = PR-ready); the exact stage in the hover card and the PANE panel |
| failed-red stage text | the dot's **red-center overlay** (over whichever base shape the window's liveness gives — ring + center when nobody is on it, bullseye while a rework agent is live) |
| `done`-parking suppression | the dot's green resting ring |
| PR states (merged / failing / pending / draft / closed) | the right-edge PR glyph (purple / red / yellow / gray dotted-rail / red ✕) |
| idle / elapsed duration | the hover card's `agt` register + the PANE panel register view |
| `waiting Xm` | the additive halo + the `agt` register on both surfaces |

**Hover any row for the full picture.** Resting the pointer on a window row opens a card at the
sidebar's right edge — same position every time, so it never jumps around under the pointer. It
shows the dot's own label, the `fab` and `pr` registers (joined by the `opr` watchlist register
when the fab operator monitors the window; `out`/`agt` are omitted — the row itself already
carries those facts), how long ago the PR status was checked, and an
"Open PR #N" link. The card also opens when you focus a row with the keyboard (Escape dismisses
it), and on a touch device by tapping the row's status dot.

**The PANE panel is the same register view for the selected window.** The four signal layers render
as separate, orthogonal lines — never collapsed — joined by the fifth `opr` register when the
window is on the operator's watchlist, so the dot is a *pure function* of what they show
and can be mentally derived from it:

```
out  claude · flowing                     (L0: pane command · flowing / idle <dur>)
agt  waiting 3m                            (L1: @rk_pane_agent_state + epoch)
fab  dmex · review · failed                (L2: change id · stage · displayState)
PR   #314 open · checks fail · draft        (L3: prNumber/state/checks/review/draft)
opr  watched · review · tick 2m ago         (operator watchlist — the row's underbar)
```

The slug is written once — the pane's branch carries it, so `fab` renders the bare change id.

The register keys are fixed-width 3-char (`out`/`agt`/`fab`/`PR`/`opr`), matching the panel's existing
`tmx`/`cwd`/`git` vocabulary. Absent layers render as absent (a plain shell pane shows only `out`).
The L3 PR register shows for **any** pane with a `prNumber` (universal derivation, even a plain
pane whose dot stays gray). The row's rest-state PR glyph is stricter — it renders only for an
**owned** PR; a closed PR keeps its register line and shows the red ✕ row glyph (unknown or
unconfident states still show no glyph). The **session tiles**
(the `/$server` dashboard) carry the same dot + rest-state glyph pair per window tile.

## Where red appears

- **On the dot**: only as the small red center of the **failed overlay** — inside the hollow ring
  at rest, or as the bullseye's center over a solid — never as a whole-dot color, and never as an
  attention signal (attention is the yellow halo). It is an overlay, not a shape: it composes with
  either liveness base.
- **On the glyph**: a failing PR (checks fail / changes requested) — the remote-failure signal —
  or a closed PR (the ✕ shape says which).

The two channels never share a fact: dot-red is *your pipeline failed here*, glyph-red is *the PR
is failing on GitHub or was closed there*.

## Accessibility

Every dot carries `role="img"` + `aria-label` composed from **hue word + liveness word +
flags** — a pure function of what the dot shows — so neither color nor motion is ever the sole
channel (colorblind a11y + the keyboard-first constitution). Examples: `"building — worker live"`,
`"PR-ready — at rest"`, `"building — failed — rework live"` (bullseye),
`"building — failed — at rest — agent waiting 3m"`, `"agent — idle"`; the floor uses the bare
`"active"` / `"idle"`. A watched window's label grows one trailing clause after the waiting
suffix — ` — watched`, or ` — watched (operator stale)` when the operator loop's tick is overdue
(`"building — at rest — watched"`); the underbar itself is `aria-hidden` decoration. PR facts are
deliberately absent from the label (the glyph is
`aria-hidden` decoration; the flyout card and PANE panel carry the PR detail). The halo respects
`prefers-reduced-motion` (a static yellow ring), and the same waiting fact is carried by the
duration text and the register surfaces.

## Scope notes

- **Frontend only.** The dot's inputs flow on `WindowInfo` via SSE (`fabChange`, `fabStage`,
  `fabDisplayState`, `activity`, `agentState`); the glyph reads the branch-derived PR fields. The
  backend D2 derivation (state-all precedence, default-branch carve-out #389) is unchanged.
- The shared PR color vocabulary (`PR_STATE_COLORS`, `PR_CHECKS_COLORS`, `PR_REVIEW_COLORS`) is
  preserved — it serves the glyph chain and the pane-panel PR register.
- **Accepted costs** (documented, not bugs): with a native/headless dispatch topology, real
  pipeline work whose agent lives outside the change's window reads ring — the hover-card `fab`
  register disambiguates. The window rollup is one value (`waiting > active > idle`), so a
  two-pane window with one waiting + one active agent rolls to waiting ⇒ ring + halo.

*Shape = liveness + the failed red-center overlay introduced by change
`260903-18ot-statusdot-shape-liveness-overlays`, superseding parts of
`260810-aqo6-statusdot-compositional-vocabulary` (the 3-shape vocabulary and shape-from-
`fabDisplayState`; aqo6's PR eviction to the glyph and the two-family hue ladder stand), which
itself superseded palette v3 (`260706-y1ar`), extending the lifecycle journey (`260615-0hsz`) and
the unified StatusDot (`260615-yg7f`).*
