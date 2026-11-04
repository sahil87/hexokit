# Cron — rk-Owned Clock Substrate

> A server-scoped scheduling substrate hosted by the rk daemon: durable cron
> entries in one intent file per tmux server, fired into agents resolved at
> delivery time. The operator is the predominant client — its tick rides an
> idle-anchored backoff schedule and survives operator death — but any agent
> can create entries, and the creating agent becomes the default target.
> Everything here is **[target]** — nothing is implemented.
>
> Companions: [`agent-state.md`](agent-state.md) (the idle epoch the backoff
> schedule derives from; the `@rk_pane_agent_session` session key that names targets),
> [`agent-messaging.md`](agent-messaging.md) (the communication standard —
> delivery is one client of its write channel and readiness gate),
> [`api.md`](api.md) (endpoint surface). Visual design:
> [`docs/wiki/cron-clock-design-studies.html`](../wiki/cron-clock-design-studies.html)
> (the three-tier UI mocks, backoff timeline, resolution ladder). The UI is
> tiered (§ UI): the status-bar `◷` clock chip for the glance, the quake
> terminal's four-segment strip (`Operator Terminal | Operator Tasks | Cron
> List | Cron Log`) as the larger view on both form factors, the tmux Server
> page's WATCHED zone as the fleet view, boards for immersion — the right
> panel is retired, so no panel/rail placement exists. Cross-repo: this spec supersedes the
> **Clock B ownership** half of fab-kit's operator pulse plan
> (`fab/plans/sahil/26-09-03-operator-pulse-plan.md`, apt-marten worktree) —
> the clock moves into rk; fab keeps owning what a tick *means*. The operator
> substrate it builds on is **shipped** (#839–#842 wave): `@rk_win_role=operator`
> radio semantics with the `_rk-operator` home session, the `rk operator`
> launcher, `rk mux sessions` role facts, and the quake terminal
> (the drawer + the top-bar quake launcher).

---

## The Problem

1. **Monitoring liveness depends on the monitored session.** The operator's
   cadence lives in a `/loop` inside its own Claude session; a Ctrl-C, restart,
   or compaction kills the timer silently and nothing notices (the
   dev-ws-sahil01 incident, 2026-09-03).
2. **Recurring work has no durable home.** A recurring task handed to an agent
   dies with the agent's session. There is no machine-local, session-independent
   scheduler an agent can program.
3. **No visibility.** Neither "what is scheduled" nor "what is the operator
   currently watching" is renderable anywhere — the facts live in transient
   session context.

## Clock Taxonomy & Scope

A "clock" here is anything that **delivers a payload to a target** when a
predicate over (time, derived state) becomes true. Five kinds; the last is
deliberately out of scope:

| Kind | Anchor | In scope? |
|------|--------|-----------|
| Wall-clock schedule (`cron`) | absolute time | yes |
| Interval (`every`) | time since last delivery | yes |
| Duration-since-state (`backoff`) | a derived epoch (pane idle-since) | yes |
| Edge trigger (`wake_on`) | a state *transition* (agent-state change) | yes — a watch, not a timer, but it shares everything except the predicate |
| Ephemeral wait | one-shot, held by a live caller | **no** — `rk mux await` owns it (shipped); the boundary rule: a wait that must **outlive its intender** is a one-shot cron entry, an ephemeral one is an await |

Two scope rules:

- **Internal tickers are not crons.** The safety poll, snapshotter, and
  BranchRefresher have no target and no delivery — they refresh derived
  state, stay anonymous, and never enter the registry. *No target ⇒ not a
  cron.*
- **The operator's compound need is a union predicate**, not a new kind: one
  entry with `schedule: backoff` **and** `wake_on: agent-state-change`
  (debounced, so five workers flipping in one second coalesce into one tick).

## The Model

1. **A stateless evaluator, pluggable invokers.** The clock's core is
   `rk cron tick` — a short-lived idempotent verb: read the entry files,
   derived state (idle epochs, pane liveness), and the delivery log; compute
   what is due; deliver; append to the log; exit. (The fab operator state
   file is read for watchlist display only — § Watchlist — never to decide
   whether a fire is emitted.) It holds **no in-memory schedule state**, so every invoker is
   equivalent, serialized by a non-blocking flock: the **rk-daemon ticker
   goroutine** is the default (an isolated goroutine sharing no locks with
   the serving path — the process-internal separation that actually protects
   the tick from a busy handler), an **OS user timer** is the drop-in
   alternate for machines that reboot unattended, and manual invocation is
   the debug path. Promoting the evaluator to its own process later is a
   config change, not a redesign — the escape hatch if the daemon ever
   proves untrustworthy as a host. A restart's worst case is one duplicate
   idempotent fire.
2. **One cron file per tmux server.** Entries are *intent*, the same class as
   `.status.yaml` and `config.yaml` — read from disk at evaluation/request
   time, never a derived-state store (Constitution II holds; see § Constitution
   Alignment).
3. **Entries name targets, not panes.** A target is resolved at fire time —
   by role, or by agent chat session id — so a killed-and-relaunched operator
   keeps receiving its tick, and a resumed agent keeps receiving its task.
4. **Delivery rides the one injection engine** (`internal/inject`, per
   [`agent-messaging.md`](agent-messaging.md)'s write channel) — never raw
   `send-keys` — so the pane-mode guard, echo probe, and submit verification
   are inherited, not reimplemented.
5. **The operator is one client among many** — the first and most important
   one, but the substrate is agent-generic.

---

## Cron State

**Location**: `$XDG_STATE_HOME/hexokit/cron/<server-slug>.yaml` — one file per
tmux server, keyed by socket name (the pulse-plan sidecar precedent; a
separate subdir, never parsed as anything else).

```yaml
entries:
  - id: a3f9                     # 4-char, rk-generated
    name: operator tick
    schedule: { kind: backoff, min: 3m, max: 24m }   # the operator consumer's tuning, not the substrate default
    wake_on: { event: agent-state-change, scope: server, debounce: 60s }
    target: { kind: role, role: operator }
    payload: "operator tick"
    deliver: skip-if-busy        # immediate | when-idle | skip-if-busy
    if_absent: respawn           # skip | notify | respawn
    respawn: ["rk", "operator", "-L", "{server}"]   # argv; {server} → the stamped server name
    pinned: true                 # never orphan-expired
    # muted_until: 1788261200    # optional mute lease (unix seconds) — expiry unmutes with no write
    created_by: { session: 8c1e…, pane: "%12", at: 1788254000 }
  - id: k7q2
    name: hourly PR sweep
    schedule: { kind: every, interval: 1h }
    target: { kind: session, session: 4fe2… }   # @rk_pane_agent_session id
    payload: "check open PRs for new review comments and triage them"
    deliver: when-idle
    if_absent: skip
    created_by: { session: 4fe2…, pane: "%31", at: 1788255100 }
```

Runtime facts (`last_fired`, `next_fire`, backoff rung, orphaned-since) are
**not** stored in the file — they are derived (see § Schedules) or held
in-memory and re-derived on restart. The file changes only on add / rm /
pin / mute / edit.

## Schedules

| Kind | Semantics | State stored |
|------|-----------|--------------|
| `every` | Fixed interval from creation; fires when `now − last_delivery ≥ interval` | none — last delivery derives from the delivery log line |
| `backoff` | Duration-based, anchored on a **derived epoch**: fire times are `anchor + min·(2ⁿ − 1)` (i.e. +1m, +3m, +7m, +15m…), capped at `max`; `min = max` collapses the ladder to a flat "every `min` of quiet" reminder (`--idle-every`) | **none** — the schedule is a pure function of the anchor |
| `cron` | Classic 5-field expression | none | 

The `backoff` anchor for the operator tick is the **agent idle epoch** already
carried by `@rk_pane_agent_state` — rk-owned substrate, re-read each
evaluation. **The anchor-join rule (load-bearing):** the effective anchor is
*the last activity not caused by the clock* — the evaluator joins the raw
idle epoch against the delivery log and ignores idle-epoch resets that
immediately follow its own delivery. Without the join, every delivered tick
makes the operator busy, resets the raw epoch, and pins the ladder at rung 1
forever (the self-resetting-ladder bug). Both inputs live on disk, so the
schedule stays a pure function and a restart at worst re-fires one due tick —
every payload must tolerate that (ticks are idempotent by contract).

**Flat ladder = idle reminder.** `min = max` is legal (validation rejects only
`max < min`) and collapses the ladder to a flat "every `min` of quiet": every
gap is `min`, anchored on the same last-genuine-idle epoch under the same
anchor-join rule — the clock's own pings never restart the count, real
activity does. `rk cron add --idle-every <dur>` is sugar that writes exactly
`{kind: backoff, min: dur, max: dur}` — no new kind, no schema field. The two
idle-aware clocks are not interchangeable:

| Expression | Fires when | An agent idle for 5 s at a boundary | An agent that went idle 5 s after a boundary |
|---|---|---|---|
| `--idle-every 3m` (flat backoff, `min == max`) | 3 m after the last *genuine* idle moment, then every 3 m while it stays quiet; own pings don't restart the count | not pinged until it has been quiet 3 m | pinged 3 m after it went idle |
| `--every 3m --deliver skip-if-busy` (fixed grid, idleness checked at each boundary) | at every 3 m grid point at which the agent happens to be idle; busy boundaries are skipped, not held | pinged now | waits nearly 3 m for the next boundary |

The operator's "wake me every 3 minutes of quiet" reminder is the flat
backoff, not the grid version.

**Union predicate** (optional per entry, derivable):

- `wake_on` — an edge trigger OR'd with the schedule: fire when the named
  transition occurs (v1: `agent-state-change`, server-scoped). Three rules
  keep it from feeding on itself:
  - **Self-exclusion (the wake analogue of the anchor-join rule):** the
    entry's own resolved target pane is excluded from the fingerprint the
    entry observes. A delivery makes the target busy; that flip is caused by
    the clock and must never read as the next edge. An unresolved target has
    nothing to exclude.
  - **Transition filter:** a transition to `waiting` or `idle`, or a pane
    disappearing, is actionable and fires; a transition to `active`
    (including a pane first appearing as `active`) advances the observation
    without firing — an agent starting work never needs the target's
    attention, a completion or a question does.
  - **Debounce = hold after own delivery:** an actionable edge inside
    `debounce` of the entry's own newest delivery is held (kept pending, not
    dropped) and fires on a later poll; a burst still coalesces into one
    delivery. The operator entry's consumer seeds `60s` (rk defines the schema
    and the evaluator; the consumer — fab's clock reconcile — seeds and tunes
    its entry through `rk cron add`/`edit`; `rk operator` is launcher-only and
    never touches the entry).

**Catch-up policy**: a wall-clock `cron` fire missed while no invoker ran
defaults to **skip** (never fire late); `catch_up: once` is the per-entry
opt-in for at-most-one late fire. Landed semantics (C9): an occurrence stays
due for a grace window of `DefaultCronGrace` (2m — covers tick jitter and
short daemon restarts), extended to `DefaultHoldWindow` (2h) for
`deliver: when-idle` entries so a busy-pane hold can outlive the grace; a
stale occurrence past its window logs exactly one `missed` delivery-log line
per gap (mute-gated like a fire, target-independent — schedule history, not
delivery), which advances the anchor past the gap; `catch_up: once` lifts the
lateness bound and fires the latest stale occurrence exactly once.

## Targets & Fire-Time Resolution

| Kind | Names | Resolution at fire | Lifetime |
|------|-------|--------------------|----------|
| `role` | A server role — any `@rk_win_role` value (`operator` is the predominant one) | The window carrying that `@rk_win_role` value → its agent pane (the operator role rides the shipped radio semantics; equivalently the `_rk-operator` member) | Never orphans — the role outlives any pane |
| `session` | An agent chat session (`@rk_pane_agent_session` id) | The live pane carrying that session id | Orphans when no pane resolves |
| `pane` | A raw pane id | That pane, if alive | Dies with the pane (discouraged; exists for scripts) |

**Creator auto-capture**: `rk cron add` run inside a pane derives the caller's
identity from `$TMUX_PANE` + socket → its `@rk_pane_agent_session` session and role, and
defaults `target` to the session (role if one is held). "The agent that uses it
becomes the target" costs no arguments.

**`if_absent` ladder** when resolution fails at fire time:

- `skip` — record a missed fire; entry trends toward orphaned.
- `notify` — `rk notify` (fail-silent contract) with entry name and server.
- `respawn` — run the entry's own `respawn: [argv...]` command as an
  argv-slice exec (never a shell string) under a timeout; the `{server}`
  placeholder in any element is substituted with the entry's stamped tmux
  server name, so the operator entry reads
  `respawn: ["rk", "operator", "-L", "{server}"]`. The command owns the whole
  bring-back — spawn, readiness classification, and the kickoff
  (`rk operator -L {server}` creates the operator window and delivers the
  `/fab-operator` kickoff itself, which runs startup and re-establishes
  context). The window opens in a project root derived from the server's
  sessions (the home directory only as a last resort), and an undelivered
  kickoff is surfaced rather than silent — a `kickoff: undelivered
  reason=<r>` stderr line, a daemon WARN, and a shell notification. Session targets without a `respawn` command keep the default
  **[phase 3]**: resume the agent (`claude --resume <session-id>` through the
  launcher seam) and deliver into the resumed pane — the standard
  spawn-then-deliver composite ([`agent-messaging.md`](agent-messaging.md)
  § Spawn and trust walls): `await --ready` classifies the fresh pane
  (`ready`/`parked`), a `parked` wall escalates via `rk notify` (the clock
  never auto-answers walls — judgment is caller-side and the daemon has no
  judge), and delivery proceeds only on `ready`. A role target without a
  `respawn` command degrades to `notify`. A cron that brings its dead agent
  back. **A respawn never delivers the bare tick**: a fresh session has no
  tick convention in context, so the first contact is the respawn command's
  own kickoff; bare payloads resume from the second fire.

**Orphan GC**: a `session`/`pane` entry that fails resolution goes **orphaned**
— visible in the UI and `rk cron list`, never silently dropped — and expires
after a TTL (default 7d) unless `pinned`. `role` entries never orphan.

## One Operator Per Server

**Shipped substrate** (no longer an assumption): `@rk_win_role=operator` is a
server-scoped radio — every role write routes through the shared promote
helpers, which clear the role from any other window (`ClearWindowRoleExcept`)
and physically move the carrier into the per-server `_rk-operator` home
session; `rk operator`'s create path stamps atomically, and `rk mux sessions`
exposes the role taxonomy as substrate facts. This is what makes
`target: role` well-defined and is the durable identity that lets the
operator's crons survive its death: the entry outlives the pane, the role
outlives the agent, and `if_absent: respawn` closes the loop. The evaluator
resolves the role exactly as the pinned sidebar row and the quake terminal do —
never a bare `-t _rk-operator` (exact-match targets only).

## Delivery

1. Resolve target → pane (above).
2. The `deliver` policy decides what happens when the agent is busy at fire
   time — three values. `immediate` sends now. `when-idle` gates on
   `@rk_pane_agent_state` (busy ⇒ hold until the state clears, bounded by
   `DefaultHoldWindow` — 2h from the fire's scheduled due time: past it the
   hold expires with a logged `held-expired` outcome that advances the anchor
   and drops the fire, never force-delivering into a busy pane).
   `skip-if-busy` reads the agent state once at due time and, on
   `active | waiting`, drops the fire with a logged `skipped-busy` outcome
   that advances the anchor (the next attempt is the next due period, never
   the next poll) and does not count toward the rate cap; `idle` and unknown
   states deliver. No hold bound applies to `skip-if-busy` — the check happens
   once, at due time.
3. Send through the injection engine (the write channel of the communication
   standard — [`agent-messaging.md`](agent-messaging.md)), inheriting the
   pane-mode guard, paste probe, and submit verification.
4. Append one line to a per-server delivery log (`cron/<slug>.log`,
   size-capped) — the derivation source for `last fired / delivered` in UI and
   `every` schedules. A log is history, not live state (recovery-backup class).
   `missed` and `rescheduled` are schedule-history lines, not deliveries: each
   advances the anchor without being a delivery (`rescheduled` is appended by
   `rk cron edit` when the schedule or deliver policy changes). Two
   `rescheduled` boundary rules: the backoff ladder walk reads only lines
   newer than the entry's newest `rescheduled` line (the edit cuts the streak,
   so pre-edit deliveries are not misread as rungs of the new ladder), and
   orphan GC skips `rescheduled` lines (they are neither resolution evidence
   nor absent-class, so they never start an absent run).

**Evaluator guards** (all load-bearing):

- **Live-server filter first.** Any tmux command against a dead socket
  *resurrects* it as a fresh server — an evaluator that enumerates sockets
  every tick without filtering to live servers is a zombie-server factory.
- **Env discipline** (pulse-plan + `%14`-collision lessons): every
  tmux-touching call scrubs `TMUX`/`TMUX_PANE` and addresses the **stamped
  absolute socket path**, never "current server".
- **Circuit breakers**: a per-target delivery rate cap (default N/hour;
  tripping is visible in the UI, not silent) and a per-server entry cap —
  the dumb guards against tick storms, delivery feedback loops, and
  cron-spam from misbehaving agents.

## Watchlist — Derived from the Operator State File

The complementary visibility surface — and it requires **no push at all**.
The fab operator binary already maintains a server-keyed state file
(`$XDG_STATE_HOME/fab/operator/<slug>.yaml`, written only through
`fab operator` verbs — `tick-start`, `track add|update|observe|rm|list|clock`)
carrying `tick_count`, `last_tick_at`, and the `tracked:` list of items whose
`scope` names the pane ID (the join key), repo, session, stage, last-known
agent state, and branch. The slug is a
**cross-repo contract**: fab-kit owns the file and derives `<slug>` from the
server's tmux socket path — escape `-` as `--` FIRST, strip the leading `/`,
replace every remaining `/` with `-`, empty ⇒ `default` (e.g.
`/tmp/tmux-1001/runKit` → `tmp-tmux--1001-runKit`, file
`tmp-tmux--1001-runKit.yaml`). rk mirrors the rule exactly
(`tmux.SocketPath` + `cron.FabOperatorSlug`), never writes the file, and
falls back to slug `default` on a socket-path query failure — matching fab.
rk **derives** the watchlist from this file — the same posture as its
`.status.yaml` and `.fab-dispatch/` reads (Constitution II) — in one
tolerant read with two projections: the whole `tracked:` list (every item —
any kind, pane-bearing or not, done or not, with its text, refs, paused flag
and done/added/updated timestamps) is surfaced on the sessions payload for
the Operator Tasks tab (display only, never a fire input — e.g. a
`kind: note` item with only `scope.refs` lands on `operatorTracked` and on
no window's `monitored`), and the pane-bearing, not-done subset joins onto
windows by pane ID as the watchlist (the pre-2.25 `monitored:` map stays
readable for one release). Constitution X is satisfied by
there being nothing underivable left: the earlier tick-doc-push design is
superseded.

`last_tick_at` is the **single staleness timestamp** serving every consumer:
the UI tick-age stamp, the dimmed-and-dashed watched-row underbar, and the
cron tabs' pinned staleness banner. A stale watchlist in the UI *is* the
dead-loop alarm's evidence.

Cross-tool contract note: rk parses a fab-owned schema. The read is tolerant
(unknown keys ignored, absent file = empty watchlist) and documented as an
external contract, the same class as the dispatch-record reads.

## UI — Three Tiers: Glance, Dashboard, Immersion

Crons and the watchlist are server-scoped monitoring facts. The design is
tiered; each tier reuses a shipped mechanism:

1. **Glance — the status-bar `◷` clock chip** (always cheap, always there):
   one chip on the desktop status bar showing the soonest next fire (`◷ in
   12m` / `◷ due`), flipping to the yellow `◷ stale {age}` when the operator
   loop is stale, and omitted when the server has no entries and no staleness.
   Its click (and its overflow-menu mirror row `◷ Cron List`) opens the
   quake terminal on `Cron List`. The **watchlist stays out of the sidebar** —
   watched workers are already window rows in the tree, so the ambient signal
   is the StatusDot's watched underbar on the row plus an `opr` register line
   on the row's existing flyout card (beside `@rk_win_note`). Staleness past
   the pulse threshold dims and dashes the underbar and drives the cron tabs'
   pinned staleness banner.
2. **Dashboard — the larger view is server-scoped: the quake terminal's
   four-segment strip on both form factors.** The strip is
   `Operator Terminal | Operator Tasks | Cron List | Cron Log` in that fixed
   order — on desktop the quake drawer's segment header, on mobile the
   operator route's segmented header (change
   `260911-hcon-cron-surface-consolidation`, building on
   `260910-6ehs-console-activity-segment-status-chip` and
   `260911-2281-console-tasks-segment-watchlist`). `Cron List` is the
   registry: every entry with the API's live derived columns (schedule in
   plain words, target chip, backoff rung, deliver marker, next fire, muted
   with lease remaining, pinned, orphan state), sorted soonest-fire-first
   with undated entries last, muted/orphaned rows dimmed never omitted, a
   `+ New entry` affordance, and row actions on the entry detail sheet —
   mute/unmute with `Mute for…` lease presets, pin, edit (the create dialog's
   edit mode over `POST /api/cron/edit`), delete. `Cron Log` is the delivery
   history: the log's lines (fires, `missed`, `skipped-absent`,
   `rate-capped`, `rescheduled`, respawn outcomes) newest first, a tap
   opening the entry's detail sheet when the entry still exists. The pinned
   operator-staleness banner renders above both cron tabs. Operator Tasks
   renders the operator's WHOLE tracked list through the SAME shared
   watched-table component as the Server page's WATCHED zone — pane-bearing
   workers as rows whose click navigates to the worker's terminal and
   collapses the drawer, pane-less items (notes, queued changes, github-pr
   probes, shell probes, held tasks) as item rows with kind chip, refs, text
   (truncated, expand-in-place), and paused/done state; done-but-unacked
   items render dimmed until the operator removes them, and the tab's count
   line matches what `fab operator track list` reports. Entry points: the
   status-bar `◷` clock chip and the palette entries `Operator: Show tasks`,
   `Operator: Show cron list`, and `Operator: Show cron log` (mobile: the
   `?tab=tasks|list|log` content slots on the operator route); the quake
   terminal's title strip also carries the operator tick-age stamp after the live
   agent-state line. Neither cron segment depends on an operator window: the
   desktop drawer renders `Cron List` / `Cron Log` whenever a server
   resolves (cron needs no operator — agents schedule with `rk cron add`,
   entries target any role/session/pane); only `Operator Terminal` reads the
   operator target — Operator Tasks renders on the server too, with its own
   no-operator hint — while on mobile the terminal and tasks requests still
   need the operator route. The tmux Server page keeps only the
   **WATCHED** zone on desktop
   (the fleet view, change `260910-1rx0-server-page-clock-dashboard`):
   watched workers with full detail (state, rung, what it awaits, age, last
   note) on `/$server`. Rejected names for the cron tabs:
   "Watches"/"Cron Watches" collide with the operator's worker watchlist
   (the StatusDot underbar, the WATCHED zone, the `opr` register);
   "Logs"/"Cron Logs" misdescribe the merged feed the log half came from
   (half of it was computed upcoming fires, not logs).

   **Superseded (2026-09-10) — the agents-tile dashboard.** The earlier
   design landed tier 2 in the reserved `agents` surface kind
   ([`surface-layout.md`](surface-layout.md)): opened as
   `main-left: tty,agents` beside the operator terminal, tile-zoom to
   full-center, no compose of its own (output-only per the quake terminal's
   one-input rule — the quake launcher is the global talk channel). Superseded:
   it was a tab-scoped tile for a server-scoped fact, and `agents` is no
   longer a reserved surface kind — `SURFACE_KINDS` is now
   `tty · web · code · gui` (the `gui` surface took the fourth kind). The
   study's § 1b mock stays as the record of the rejected direction.

   **Superseded (2026-09-11) — the CLOCK section and the Server-page CRONS
   / RECENT DELIVERIES zones.** Tier 1's glance lived in a desktop-only
   sidebar `CLOCK` section (a default-off `CollapsiblePanel` behind the
   section rail, mute/delete on the row's flyout card, `Panel: Toggle
   Clock`), and tier 2b put the registry on `/$server` as CRONS and RECENT
   DELIVERIES zones beside WATCHED (`Server: Clock dashboard` scrolling the
   CRONS heading into view). Both retired in favor of the quake terminal's `Cron
   List | Cron Log` tabs — one surface on both form factors instead of three
   renderers of the same entries, with the `◷` chip as the glance entry; the
   earlier merged Activity feed (upcoming fires + deliveries across a "now"
   divider) split into the two tabs at the same time. The `?tab=activity`
   deep-link token survives one release as an alias for `log`, so
   already-sent push notifications keep landing.
3. **Immersion — an operator board** (zero new machinery, optional): boards
   already render pinned windows as live terminal cards. The operator (an
   actuating agent) can pin its watched windows to a `watched` board as the
   set changes — link-based pinning keeps every window in its home session —
   giving a full-screen live view of everything under watch at
   `/board/watched`. This is a *usage pattern* of shipped boards, not a
   feature; at most P3 adds a cron payload that reconciles the board to the
   watchlist.
4. **Mobile — the same four segments on the operator route; the Server page's Cron section when no operator exists.** The desktop
   tiers collapse badly on a phone (a 50px drawer panel + flyout-buried
   actions), so mobile carries the identical strip on the operator route
   (`?tab=terminal|tasks|list|log`) when an operator window exists; a
   server with no operator has no operator route, so its cron registry
   lives in the tmux Server page's **Cron** section (the mobile counterpart
   of the desktop WATCHED zone — the same `CronList`, always rendered on the
   mobile Server page, reached by `Operator: Show cron list` / `Show cron
   log`, which navigate to `/$server#cron` there instead of toasting):
   - The **mobile strip** — on the operator route, already the operator
     surface on phones —
     carries the segment header, **Operator Terminal | Operator Tasks |
     Cron List | Cron Log**. `Cron Log` is the time-ordered delivery log
     (the Calendar-agenda / PagerDuty triage pattern: mobile ops surfaces
     are time-ordered feeds), `Cron List` the registry with its actions,
     and Operator Tasks the watchlist content slot (`?tab=tasks`), the
     same shared watched-table component as the Server page's WATCHED
     zone. Pure derivation — the deterministic-render contract
     holds; it inherits the quake terminal's server resolution. Only the
     two operator segments degrade to absent without an operator; the
     cron segments never do.
   - **Staleness is the cron tabs' pinned banner** (the healthchecks.io
     dead-man's-switch model): a stale operator loop is the most important
     item, not a side warning — the banner renders above both `Cron List`
     and `Cron Log`.
   - **Tap a row → an entry detail sheet** with the alarm-app anatomy:
     name, schedule in plain words, last/next, mute with `Mute for…`
     lease presets, an edit row, delete and pin rows. No flyout cards on
     mobile.
   - **Push is the mobile entry point**: escalations, orphans, and staleness
     ride `rk notify`; the notification deep-links to the `Cron Log` tab
     (`?tab=log`; `?tab=activity` resolves there for one release).
   - The tree's watched-row underbars remain on both form factors.
   - **Desktop has parity**: the desktop quake drawer ships the same
     four segments (tier 2) — one registry, log, watchlist, banner, and
     detail-sheet codebase across both form factors.

Rejected: a dedicated `clock` **surface kind** (a dedicated kind would split
the surface model — the surface set is `tty · web · code · gui`, and crons
ride the quake terminal and Server page instead); **Host page** (checking crons
must not cost a navigation); **status bar
only** (no management affordance — the `◷` readout that rides it is an entry
point to the quake terminal's `Cron List` tab, not the surface); **mobile
registry-in-the-drawer** (the pre-feed mobile design: a pinned-height
`CollapsiblePanel` in the drawer with flyout-card actions — no glanceability,
mute two taps deep; superseded by the quake terminal's cron tabs); a **fab-authored HTML
frame displayed by path** for the Tasks segment (fab writing `<slug>.html`
beside the operator state YAML every tick, shown by rk through a new
file-serving route plus a sandboxed iframe, with a polling or mtime-watch
refresh story and a second cross-repo file contract beside the slug rule —
an unthemed foreign page inside the drawer; superseded by rendering the
already-derived watchlist, which the frontend already holds in the sessions
payload).

Palette-registered per Constitution V (`Operator: Open quake terminal`,
`Operator: Show tasks`, `Operator: Show cron list`, `Operator: Show cron
log`, `Cron: new entry`,
`Cron: mute…`, `Cron: pin…`, `Cron: delete…`).
Mutations wake the SSE hub explicitly (user-option and file writes emit no
tmux event — the safety-poll lesson).

## API & CLI

| Surface | Form |
|---------|------|
| Read | `GET /api/cron?server=<slug>` — entries + derived next-fire + orphan state; watchlist rides the existing SSE state doc |
| Mutate | `POST /api/cron/create`, `POST /api/cron/delete`, `POST /api/cron/mute` (optional `for` duration leases the mute), `POST /api/cron/edit` (partial-merge body; immutable target; returns the entry) — POST-only (Constitution IX) |
| CLI | `rk cron add <prompt> --every 1h \| --idle-every 3m \| --backoff \| --cron "<expr>" [--json] [--name N] [--deliver when-idle\|skip-if-busy] [--if-absent skip] [--respawn <arg>…] [--wake-on agent-state-change [--wake-scope server] [--wake-debounce 60s]]`, `rk cron edit <id> [<schedule flag>] [--deliver P] [--name N] [--if-absent P] [--respawn <arg>…] [--wake-on <event>\|none …]` (target and creator immutable; a schedule or deliver change logs `rescheduled`; `--wake-on` replaces the whole block, `none`/`off` clears it, and a wake-only edit logs nothing), `rk cron list [--json]`, `rk cron rm <id> [--json]`, `rk cron mute <id> [--for <dur>] [--off] [--json]` — agent-friendly: no flags beyond the schedule are required |

`rk cron mute <id> --for <dur>` mutes until now+dur; expiry unmutes
automatically with no further call — the evaluator reads an expired lease as
unmuted. Plain `mute` is indefinite; `--off` clears both. On `add`,
`--respawn` is repeatable — one argv element per occurrence, passed exactly
as typed; the `{server}` placeholder is substituted with the entry's stamped
server name when the command runs (§ Targets & Fire-Time Resolution).
Entries can be created over the localhost HTTP API, so the API can now make
the daemon exec a command — but it could already type arbitrary text into an
agent's chat (command execution by proxy), so the trust boundary does not
move.

## Constitution Alignment

| Principle | How it holds |
|-----------|--------------|
| II (no database) | Entry files are intent read at request time (`.status.yaml` class); runtime facts derived or in-memory, re-derived on restart; the delivery log is recovery-backup class (history, never a live-state source) |
| VI (tmux independent) | The clock lives in the daemon; tmux sessions and agents are untouched by daemon restarts — at worst one duplicate idempotent fire |
| IX (POST-only) | All mutations are POST |
| X (hooks carry only the underivable) | Nothing is pushed — the watchlist derives from the fab-owned operator state file, staleness from its `last_tick_at`; no new hook exists |
| IV (minimal surface) | No new page or tile — the cron surface lives in the quake terminal's existing segment strip; the watchlist reuses the tree rows instead of duplicating them |

## Phasing

> Execution shape — change breakdown, waves, the P1.5 gate, and the fab-kit
> item — lives in
> [`fab/plans/sahil/26-09-06-cron-clock-plan.md`](../../fab/plans/sahil/26-09-06-cron-clock-plan.md).

- **P1 — substrate + operator tick**: the evaluator verb + daemon-ticker
  invoker + flock, entry file, `role` target, `backoff` (with the anchor-join)
  + `every` schedules, `wake_on`, injection-engine
  delivery, evaluator guards (live-server filter, rate caps), `rk cron` CLI,
  API.
- **P1.5 — backstop live** (before any UI): the operator-tick entry
  (`if_absent: respawn` with `respawn: ["rk", "operator", "-L", "{server}"]`)
  exists on every server that runs an operator. Ownership decision
  (2026-09-12): **rk defines the schema and the evaluator; the consumer (fab)
  seeds and tunes its entry.** The handover ran in two steps, both shipped:
  STEP 1 exposed `wake_on` on the CLI (`--wake-on`/`--wake-scope`/
  `--wake-debounce` on `rk cron add` and `edit`) so a consumer can seed the
  full entry through rk verbs alone; STEP 2 deleted the rk-side seed once
  fab-kit's clock reconcile seeded the entry itself (fab-kit ≥ 2.26.2 —
  `rk cron add … --pinned` on a server with no `role:operator` row, healed by
  every reconcile entry point and by `fab operator clock sync`), leaving `rk
  operator` launcher-only. Silence while the
  operator's in-session `/loop` lives is **lease arbitration**: the loop
  renews a mute lease (`rk cron mute <id> --for <dur>`) each tick, and when
  the loop dies the lease lapses and the cron backstop resumes on its own.
  The fab-kit side that issues the renewals is a follow-up — until it ships,
  the idle operator is ticked every backoff step (loud but safe; mute by hand
  if needed). Gate before proceeding: kill the loop → a tick arrives within
  one backoff step; with the lease renewing, no double ticks while the loop
  is healthy; `rk cron add/list/rm` works from inside a pane. Kills the
  incident class.
- **P2 — visibility**: the quake terminal's four-segment strip (`Operator
  Terminal | Operator Tasks | Cron List | Cron Log`) on the desktop drawer
  and the mobile operator route + staleness banner + entry detail sheet,
  the Server page's WATCHED zone, watched-row underbar + the `opr` register
  line (watchlist and `last_tick_at` read from the fab operator state file),
  SSE wiring, palette actions, notify deep-links.
- **P3 — generalization + replacement posture**: `session` targets with
  auto-capture, orphan GC, the closed-session resume default for
  `if_absent: respawn`, `cron` expressions; then the fab-kit skill change —
  the operator's in-session loop renews the mute lease each tick while it
  runs, and once the loop retires the entry's union predicate (`backoff` +
  `wake_on`) replaces §4 Adaptive cadence as the only clock — the lease
  simply stops being renewed — eliminating the loop-death incident class
  entirely.

## Open Questions

1. Server ≈ one operator's domain assumes per-project servers; a multi-repo
   server would need an optional session/cwd scope on entries. Not built until
   the layout is real.
2. `when-idle` hold window bound — **decided at Wave 4 (C9,
   `260908-qyin-cron-schedule-completions`): drop after a 2h hold window
   (`DefaultHoldWindow`) with a logged `held-expired` outcome.** The bound
   derives from the fire's scheduled due time (`Fire.DueAt`), keeping
   evaluation stateless; the expiry is a logged disposition, so it advances
   the anchor and the next due period fires normally. Drop-with-visible-history
   won over the alternatives because (a) recurring schedules lose nothing —
   the next due period fires on its own; (b) unbounded hold delivers a payload
   that stopped being relevant hours ago, landing mid-context-switch at the
   worst moment; (c) force-delivering at the bound would interrupt a
   busy/waiting agent, contradicting what `when-idle` exists for. Catch-up
   late fires (`DueAt = now`) are exempt by construction — an entry that opted
   into unbounded lateness is not then dropped for being late.
3. Mutual watching's second half — **decided at P1.5 (C4,
   `260906-kbbh-operator-tick-seed-respawn`): no reverse loop-side
   cron-staleness check is built.** The loop does not warn when the cron's
   delivery-log stamp goes stale. (a) The only place such a check could live
   is inside the `/loop` itself — `fab-operator.md` — which this wave's
   zero-skill-change constraint forbids touching. (b) The risk is asymmetric:
   a dead cron backstop while the loop is healthy is a benign no-op — the
   loop is already doing the monitoring job the cron exists to back up; the
   incident class is the reverse direction (backstop alive, loop dead).
   (c) C5 builds the generic staleness mechanism for the primary direction
   (cron watching the loop, via `last_tick_at`); the reverse direction, if
   ever built, would consume the cron's own delivery-log staleness through
   the same UI surface rather than a bespoke loop-side check. (d) C10
   collapses the two clocks into one — once `/loop` retires in favor of the
   entry's union predicate, no second clock remains to watch, so a reverse
   watch built now would be dead code. (The seed itself lives in fab — see
   P1.5's two-step handover; this note's reasoning is unaffected.) The pulse
   plan's sidecar state (ladder
   rung, notify cursor) is otherwise obsolete — the anchor-join makes the
   ladder stateless and the rate cap covers notify throttling.
