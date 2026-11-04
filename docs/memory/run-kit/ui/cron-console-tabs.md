---
type: memory
description: "The quake terminal's `Cron List` / `Cron Log` tabs — the cron clock's web UI on both form factors: the four-segment strip (tokens terminal|tasks|list|log, the `activity` alias), Cron List row anatomy/sort/dimming + `+ New entry`, Cron Log deliveries-only anatomy, the entry detail sheet (mute lease presets, pin, Edit, delete, inline variant), the create dialog's edit mode, CronStaleBanner placement, useCronData on the SSE cadence, e2e coverage."
---
# run-kit UI — Cron Quake Terminal Tabs

**Domain**: run-kit/ui

## Overview

The `Cron List` and `Cron Log` tabs are the cron clock's web surface ([cron](/run-kit/cron.md)) — the registry (what is scheduled, with actions) and the log (what happened), mounted as two segments of the quake terminal's shared strip on BOTH form factors: the desktop quake drawer's segment header and the mobile operator route's segmented header ([ui/quake-terminal](/run-kit/ui/quake-terminal.md)). Both tabs render their rows through the shared `DataTable` ([ui/data-table](/run-kit/ui/data-table.md) — `components/data-table.tsx`: the header row, click-to-sort, fine-pointer resize, and the per-viewer `hexokit-table-<id>` view state). Components: `components/cron-list.tsx` (the registry), `components/cron-log.tsx` (the log), `components/data-table.tsx` (the shared table), `components/cron-stale-banner.tsx` (the pinned staleness banner mounted above either cron tab), `components/cron-entry-detail-sheet.tsx` (the per-entry action surface), `components/cron-create-dialog.tsx` (create + edit modes), `components/terminal-activity-tabs.tsx` (the shared segment strip), `hooks/use-cron.ts` (data), `lib/cron-schedule.ts` (the plain-words schedule/deliver helpers `describeSchedule`/`describeDeliver`), and `lib/cron-list-model.ts` (the row helpers `cronEntryLabel` / `targetChip` / `isCronDimmed` / `mutedLabel` / `compareCronEntries` / `sortCronEntries`). The backend contract is `GET /api/cron`'s `entries` + `deliveries` ([cron](/run-kit/cron.md) § HTTP API); staleness reads `operatorStale`/`operatorLastTickAt` off the existing sessions payload — no new fetch.

## Requirements

### Requirement: One four-segment strip, both form factors
The segment strip SHALL be a single controlled presentational component — `QuakeSegments({ value, onChange })` in `components/terminal-activity-tabs.tsx` — carrying four values in this fixed order with these Title Case labels: `terminal` / `Operator Terminal`, `tasks` / `Operator Tasks`, `list` / `Cron List`, `log` / `Cron Log`; `QuakeSegment` derives from the strip's exported `SEGMENTS` table, the single spelling `router-url.ts`'s literal `tab` union and `QuakeTerminalRequest.segment` are guarded against by a Vitest agreement test. Both mounts consume identical tab markup, roles, and test ids (`role="tablist"` / `role="tab"` / `aria-selected`, `controlClass({ variant: "segment" })`, `data-testid="terminal-activity-tabs"`), and no label wraps or truncates at the desktop drawer width or at the 375px mobile header. Only the strip's OUTER chrome differs by mount: the optional `className` prop replaces the default `border-b border-border bg-bg-primary` wrapper classes, and the desktop drawer passes `className=""` because its single header row already supplies the border ([quake-terminal](/run-kit/ui/quake-terminal.md) § Anatomy); the mobile route mount keeps the default. The mobile route's `TerminalActivityTabs` wrapper drives the router `tab` search param (a client-side search update with `replace: true`, never a full navigation) and is wrapped in `shrink-0 pt-9` so the strip starts below the mobile tongue's `absolute top-0 h-9 w-16` centered hit box (2281); the desktop quake terminal drives the strip with quake-terminal-local component state instead. The `?tab=` deep-link tokens are `terminal|tasks|list|log`; `validateTerminalSearch` additionally accepts `activity` and normalizes it to `log` for one release (deep-links sent by already-delivered push notifications keep landing on `Cron Log` — [cron](/run-kit/cron.md) § Notify Deep-Links), unknown values dropping to absent. On every non-terminal segment the terminal is swapped out — UNMOUNTED in the desktop drawer (at most one relay stream), mounted-but-hidden on the mobile route.

### Requirement: `Cron List` is the registry
`Cron List` (`components/cron-list.tsx`) SHALL render every entry from `useCronData(server).entries` as a `DataTable` row (`data-testid="cron-list-row-{id}"`), one row per entry under a header row of seven columns `entry · target · schedule · rung · deliver · next · flags`: the label (`cronEntryLabel` — the entry name, with the fallback label for unnamed entries), the target chip (`targetChip` — `role: operator` / `session: foo` / `pane: %3`), the plain-words schedule (`describeSchedule`), the backoff rung (`rung N`, backoff kinds only), a deliver marker when `deliver` is set and not `immediate` (`data-testid="cron-list-deliver"`, the raw policy text — the norm adds zero chrome), the relative next fire (`in {dur}` / `due` / `—` when the evaluator gave no `nextFire`), and the flags in their own column — `muted {remaining}` while a lease is live (`mutedLabel`, keyed on the server's EFFECTIVE `muted`: stored flag OR unexpired lease, so no client-side expiry logic), `muted` for the indefinite flag, `pinned`, `orphaned {age}` plus `expires {rel}` while the orphan-TTL reap time is ahead. The at-rest order is `sortCronEntries` (`nextFire` ascending; entries with no `nextFire` sort last, stable by name then id) expressed as the `next` column's initial ascending sort over the extracted `compareCronEntries` comparator — the list sort and the table sort are one function, `sortCronEntries` being `[...entries].sort(compareCronEntries)`; a header click is a per-viewer override persisted under `hexokit-table-cron-list` ([ui/data-table](/run-kit/ui/data-table.md)). Muted and orphaned rows are DIMMED (`opacity-50` under `isCronDimmed`), never omitted. Each row is a keyboard-reachable `<tr role="button" tabIndex=0>` (Enter/Space open the sheet, the `coarse:min-h-[44px]` touch floor carried on the row). The tab carries a `+ New entry` chip (`data-testid="cron-list-new"`, the header row) opening `CronCreateDialog` in create mode; the empty state renders the hint `Agents can schedule prompts too — rk cron add.`; an unresolvable server renders the centered hint `no server resolved — cron list unavailable` and fires no request. Tapping a row opens the entry detail sheet (below).

#### Scenario: Sort and dimming
- **GIVEN** entries A (`nextFire` in 5m), B (no `nextFire`), C (`nextFire` in 1m, muted)
- **WHEN** `Cron List` renders
- **THEN** the order is C, A, B and C is dimmed, not omitted

### Requirement: `Cron Log` is deliveries only
`Cron Log` (`components/cron-log.tsx`) SHALL render the server's `deliveries` array from `useCronData(server)` as `DataTable` rows of three columns `entry · outcome · when`, in the API's most-recent-first order as-is (`initialSort: null`) — one row per log line (fires, `missed`, `skipped-absent`, `rate-capped`, `rescheduled`, respawn outcomes — the log is schedule history, not only successful deliveries), each reading `{name || entry id}` · the raw `outcome` text · `{dur} ago` (render-time `Date.now()`, never a ticking timer). A user header sort is an additive per-viewer override persisted under `hexokit-table-cron-log`; `Table: Reset columns` returns to API order. It SHALL NOT render computed upcoming fires or a "now" divider — the registry half lives in `Cron List`. Tapping a row whose entry still exists opens the entry detail sheet for it (the row is `<tr role="button" tabIndex=0>`, Enter/Space included); a row for a since-deleted entry is an inert `<tr aria-disabled>` with no role, no `tabIndex`, and no handlers — valid history that opens nothing, because the sheet needs the live entry. The empty state is the single line `No deliveries yet on {server}.`; an unresolvable server degrades to the centered hint `no server resolved — cron log unavailable` and fires no request.

#### Scenario: Deleted-entry row is inert
- **GIVEN** a delivery whose entry was deleted
- **WHEN** the user taps its row
- **THEN** nothing opens

### Requirement: Data rides the sessions cadence — no polling
Both tabs' data SHALL come from `useCronData(server)` (`hooks/use-cron.ts`): a mount fetch of `GET /api/cron?server=<slug>` plus a refetch on every state-socket `sessions` event for that server — the same SSE-driven cadence every surface rides (cron mutations wake the hub server-side, so a mutation's confirmation lands on the next tick). No timers, no polling loop; a transient fetch failure keeps the last good data, and the cached data is keyed to the server that produced it (a server switch yields the empty shape until the new server's first fetch resolves). Every relative time computes at render from `Date.now()` via `formatDuration` — the SSE cadence is the clock.

### Requirement: `CronStaleBanner` above both cron tabs
The pinned (non-scrolling) operator-staleness banner SHALL be its own component (`components/cron-stale-banner.tsx`) mounted ONCE above the `Cron List` / `Cron Log` body by their parents (the desktop drawer body and the mobile route's content slot) — never above `Operator Terminal` or `Operator Tasks`. It renders exactly when any of the resolved server's sessions reports `operatorStale === true`, reading the already-shipped `operatorStale`/`operatorLastTickAt` fields through the session context (no new fetch), carrying `operator tick — last seen {dur} ago` (`operator tick — no recent tick` when the tick is 0/absent) as a `role="status"` `text-signal-yellow` line (`data-testid="cron-activity-banner"` — this id predates the banner's extraction and is deliberate; renaming it would churn specs for no behavior gain); the age computes at render time.

#### Scenario: Banner gating
- **GIVEN** a server whose sessions report `operatorStale: true`
- **WHEN** either cron tab is active
- **THEN** the banner shows; **AND** on `Operator Terminal` it does not

### Requirement: The entry detail sheet is the row-action surface
Tapping any `Cron List` row or a live-entry `Cron Log` row SHALL open `CronEntryDetailSheet` scoped to that entry — the sole action surface for an entry on both form factors (modal bottom-anchored overlay on mobile, the `inline` variant in the desktop drawer): name, the `describeSchedule` sentence, Last fired / Next fire rows (`lastFired` 0 renders "never"; an absent `nextFire` renders "unknown"), a `Deliver` fact row (`describeDeliver(entry.deliver)`, `data-testid="cron-entry-deliver"`), mute/unmute, pin/unpin, an `Edit` row, and a two-step kill-confirm delete row. The mute arm carries a `Mute for…` choice with the presets `30m` / `2h` / `8h` / `until unmuted`, posting to `POST /api/cron/mute` with the additive `for` field (`muteCron(server, id, true, forDuration)`; `until unmuted` and unmute send no `for` — [cron](/run-kit/cron.md) § HTTP API). Mute and pin reflect OPTIMISTICALLY — a local override until the next SSE-driven refetch's entry confirms the value, then the override clears; a failure reverts to the prop value and surfaces the error inline (`role="alert"`). Delete closes the sheet on success.

The sheet's **`inline` variant** (the desktop drawer mount — both cron tabs take an `inline` prop that makes their root `relative` and forwards the flag) drops the fixed full-viewport backdrop and `aria-modal` for an in-container `absolute inset-0` panel whose header leads with a `‹ Back` control in place of the ✕; rows are identical in both variants. Esc inside the inline panel returns to the tab only, never collapses the drawer: the panel's focus trap claims the key with `preventDefault`, and the drawer's document Esc listener additionally stands down via a DOM check for a nested `[role="dialog"]` inside the drawer root ([ui/quake-terminal](/run-kit/ui/quake-terminal.md)). The `Edit` row opens `CronCreateDialog`'s edit mode as a nested modal (the sheet's focus trap stands down while it is open).

### Requirement: The create dialog's edit mode
`CronCreateDialog` SHALL accept an optional `entry: CronEntry` prop selecting **edit mode**: title `Edit entry`, submit label `Save`. Editable fields are name, schedule (the kind picker — a kind change replaces the whole schedule), deliver, if-absent, and the respawn argv (a non-`respawn` if-absent clears respawn, matching the CLI/route rule); target (rendered as the chip, not a control), payload (rendered as text), and muted/pinned are read-only — the route and the CLI expose no edit for them ([cron](/run-kit/cron.md) § In-Place Edit). Submit SHALL POST only the changed fields via `editCron(server, body: CronEditBody)` (`api/client.ts`) to `POST /api/cron/edit`; server 400s render inline as the create path does, and a 409 `cron tick in progress — retry` renders as a retryable inline error — the dialog stays open and Save fires again. A schedule or deliver change appends the route's `rescheduled` log line, which `Cron Log` shows on the next SSE cadence — no client handling needed.

#### Scenario: Changed-fields-only submit
- **GIVEN** an entry opened in edit mode
- **WHEN** the user changes only the name and saves
- **THEN** the POST body is `{id, name}` and the dialog closes on 200

### Requirement: Mobile parity and e2e coverage
The cron tabs SHALL need only a resolved server — never an operator window (cron needs no operator: agents schedule with `rk cron add`, entries target any role/session/pane). On desktop the quake drawer renders `Cron List` / `Cron Log` (and Operator Tasks) on `server` alone; only the Operator Terminal segment reads the operator target ([ui/quake-terminal](/run-kit/ui/quake-terminal.md) § Desktop segments), so an operator-less server still shows its registry and log there, the `◷` chip and the two palette rows included. On mobile the two cron tabs mount identically on the operator route when an operator window exists (the same `CronList`/`CronLog` components without `inline`, under the same strip and the same `CronStaleBanner`); a server with no operator window has no operator route, so its mobile cron home is the tmux Server page's **Cron** section — the Cron List body (`CronListView`, the `entries`-taking rendering behind `CronList`; registry only, no log) under a `Cron` heading and the staleness banner, over that section's single cron subscription, rendered by `ServerWatchedZone`'s mobile branch whenever the mobile Server page renders ([ui/routes-and-shell](/run-kit/ui/routes-and-shell.md) § Server Page WATCHED Zone); the mobile seam arm routes operator-less `list`/`log` requests to `/$server#cron` instead of toasting ([ui/quake-terminal](/run-kit/ui/quake-terminal.md) § Mobile open is navigation) (05ab). E2e coverage: `app/frontend/tests/e2e/mobile-cron-tabs.spec.ts` (the four segments at 375px in order, the `?tab=activity` alias landing on `Cron Log`, `?tab=list` landing on `Cron List`, the banner above both cron tabs, `+ New entry` opening the dialog, the detail sheet's `Edit` row), `app/frontend/tests/e2e/quake-terminal.spec.ts` (the four desktop drawer segments, the `◷` chip opening `Cron List` — on an operator-less server too — the palette's `Operator: Show cron list` / `Operator: Show cron log`, the mobile operator-less `Show cron list` landing on the Server page's Cron section, the desktop `?tab=` handoffs, and a Cron List header re-sort surviving a reload via the persisted `hexokit-table-cron-list` view state), and `app/frontend/tests/e2e/server-watched-zone.spec.ts` (the mobile Cron section in place of WATCHED). Vitest covers alias parsing (`router-url.test.ts`), the list sort and lease rendering (`cron-list-model.test.ts`, `cron-list.test.tsx`), the strip labels (`terminal-activity-tabs.test.tsx`), and the dialog's edit mode (`cron-create-dialog.test.tsx`); Go tests cover `PushURL`, the mute `for` field, and the `cron` skill topic.

## Design Decisions

### Tab names mirror the CLI
**Decision**: The cron tabs are `Cron List` and `Cron Log`, with `Cron List` first.
**Why**: rk's CLI-as-contract principle; `rk cron list` is the registry a user already knows, and the list is where actions live.
**Rejected**: "Watches"/"Cron Watches" (collides with the operator's worker watchlist: the underbar, the WATCHED zone, the `opr` register); "Logs"/"Cron Logs" for the merged feed (half of it was computed future fires).
*Introduced by*: 260911-hcon-cron-surface-consolidation

### The log tab drops the upcoming-fires half
**Decision**: `Cron Log` shows deliveries only; each entry's next fire lives in `Cron List`.
**Why**: with one to five entries the merged timeline's ordering bought little, and it duplicated the registry without offering its actions.
**Rejected**: keep the merged timeline under a new name — misdescribes the content.
*Introduced by*: 260911-hcon-cron-surface-consolidation

### The `activity` alias is normalized in the validator
**Decision**: `validateTerminalSearch` maps `tab=activity` to `log` for one release.
**Why**: already-sent push notifications keep landing; one place, unit-testable, no redirect.
**Rejected**: a route-level redirect (a navigation for an alias) or dropping the alias (dead links).
*Introduced by*: 260911-hcon-cron-surface-consolidation

### Web mute lease rides the existing mute route
**Decision**: an optional `for` duration on `POST /api/cron/mute`.
**Why**: Constitution IX (POST only, no new verb shapes); the CLI's `mute --for` has the same store helper; backward compatible.
**Rejected**: display-only lease (the list could not do what the CLI does); a new `/api/cron/mute-for` route.
*Introduced by*: 260911-hcon-cron-surface-consolidation

### The strip is a fixed-order four-segment strip, sized against all four labels
**Decision**: the strip renders all four segments — `Operator Tasks` is a real tab (the watchlist, [ui/quake-terminal](/run-kit/ui/quake-terminal.md)) — and its geometry is sized and tested against the four-label set so no label wraps or truncates at the drawer width or at 375px.
**Why**: a disabled placeholder segment is a dead control with a state style and no behavior; the four-label sizing is what keeps every segment readable.
**Rejected**: a disabled `Operator Tasks` placeholder segment.
*Introduced by*: 260911-hcon-cron-surface-consolidation

### Detail panel is an inline variant of the existing sheet, not a new component
**Decision**: `CronEntryDetailSheet` gains an `inline` prop that swaps its fixed backdrop + bottom anchoring for an in-container `absolute inset-0` panel with a `‹ Back` back control.
**Why**: one component keeps mute/pin/delete semantics (optimistic overrides, confirm step, error line) identical on both form factors; the drawer's `translate` transform would already trap a `fixed` sheet inside the drawer box, so the variant makes that explicit rather than accidental.
**Rejected**: a modal over the quake drawer (heavy, a dialog over a dialog); a flyout card (the cron-clock design study bans flyouts for this content); a second detail component (drift).
*Introduced by*: 260910-6ehs-console-activity-segment-status-chip

### Muted/orphaned entries dim, never omit
**Decision**: muted and orphaned entries stay in the list with a dimmed treatment rather than being filtered out.
**Why**: the tabs are triage — a muted backstop is exactly what a phone user must be able to see at a glance; the spec's treatment-not-omission rule.
**Rejected**: hiding them (the registry pattern's instinct — contradicts the tabs' glanceability purpose).
*Introduced by*: 260907-yxen-mobile-cron-activity-feed

### Sheet mutations are optimistic, reconciled by the SSE refetch
**Decision**: mute/pin reflect instantly via a local override that clears once the next SSE-driven refetch's entry confirms the value; failures revert and surface inline.
**Why**: every cron mutation wakes the SSE hub server-side, so confirmation is one tick away — the existing optimistic-mutation pattern ([ui/dialogs-and-state](/run-kit/ui/dialogs-and-state.md)).
**Rejected**: waiting for the POST response to repaint (a beat of dead UI on the phone's primary action surface); a client-side confirmation timer (a polling loop — banned).
*Introduced by*: 260907-yxen-mobile-cron-activity-feed

### The tabs' relative times are render-time only
**Decision**: "in 5m" / "3m ago" labels compute from `Date.now()` at render time; the SSE-cadence refetch is the clock.
**Why**: a ticking timer would be a new client-side poll for a label-only concern; the refetch cadence already repaints the tabs often enough for minute-granularity labels.
**Rejected**: a per-second `setInterval` re-render (client polling); server-computed relative strings (stale the moment they're served).
*Introduced by*: 260907-yxen-mobile-cron-activity-feed

### Cron is ungated from the operator
**Decision**: `Cron List` / `Cron Log` need only a resolved server. In the desktop drawer only `Operator Terminal` reads the operator target (Operator Tasks also renders on the server alone, with its own `No operator on this server` hint); on mobile, terminal and tasks requests still need the operator route, so only the cron requests gain an operator-less destination.
**Why**: agents schedule with `rk cron add`, entries target any role/session/pane, and the operator-tick entry is one consumer's entry among others; a phone user who stopped the operator must still reach the registry that mutes the entry respawning it.
**Rejected**: keeping the gate (leaves the registry unreachable exactly when the operator is gone); a mobile cron sheet (the mobile quake arm is navigation, and a second overlay species contradicts the one-surface consolidation); a Cron section on the desktop Server page (desktop already has the drawer operator-less, and the CRONS zone's supersession stands).
*Introduced by*: 260913-05ab-cron-tabs-ungated

### The mobile operator-less cron home is the Server page, registry only
**Decision**: `ServerWatchedZone`'s mobile branch renders a `Cron` section (`CronList`, no log) in the tiles' footer slot; operator-less mobile cron requests navigate to `/$server#cron`.
**Why**: a server-scoped page for a server-scoped fact; the footer slot already renders on both form factors; no new route (Constitution IV); the log's mobile entry is the push deep-link, which needs the operator route regardless.
**Rejected**: a `List | Log` sub-strip in the section (machinery for a second-order case); a `?tab=` search param on `/$server` (the route validates no search — the hash is the lighter carrier).
*Introduced by*: 260913-05ab-cron-tabs-ungated
