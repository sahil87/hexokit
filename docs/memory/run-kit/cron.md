---
type: memory
description: "Cron scheduling substrate — the `rk cron` CLI family (add/edit/list/rm/mute/pin/tick) over per-server intent files under ${XDG_STATE_HOME:-~/.local/state}/hexokit/cron/; stateless evaluator (every/backoff/cron + catch_up + wake_on; muted flag/lease); daemon Ticker; three-policy deliver axis (immediate/when-idle/skip-if-busy); any-role + session targets; if_absent dispositions; orphan TTL GC; circuit breakers; HTTP API; operator-state reader (watchlist join + tracked list)."
---
# Cron

**Domain**: run-kit

## Overview

`internal/cron` (app/backend/internal/cron) is the server-scoped scheduling substrate from the cron spec (`docs/specs/cron.md`): durable cron entries in one intent file per tmux server, a stateless pure evaluator, an append-only delivery log, a tick orchestrator, an injection-engine deliverer, and the daemon ticker goroutine that invokes ticks. The agent-facing surfaces are the `rk cron` CLI family below and the HTTP API (§ HTTP API). The clock's web UI is the quake terminal's segment strip — `Operator Terminal | Operator Tasks | Cron List | Cron Log` — on both form factors (the desktop quake drawer — where the cron segments render whenever a server resolves, operator or not — and the mobile operator route; a mobile server with no operator window carries its registry in the tmux Server page's Cron section instead, [ui/routes-and-shell](/run-kit/ui/routes-and-shell.md) § Server Page WATCHED Zone): `Cron List` is the registry (every entry with the API's live derived columns, sorted soonest-first, mute-with-lease / pin / edit / delete actions on the entry detail sheet, a `+ New entry` affordance) and `Cron Log` is the delivery history — both pure projections over `GET /api/cron` and the payload's `monitored*`/`operatorStale`/`operatorLastTickAt` fields, documented in [ui/cron-console-tabs](/run-kit/ui/cron-console-tabs.md); the status-bar `◷` clock chip (opening `Cron List`) and the palette's `Operator: Show cron list` / `Operator: Show cron log` are the glance entry points ([ui/status-signals](/run-kit/ui/status-signals.md) § Status Bar) (hcon). The strip's Operator Tasks segment renders the operator's whole tracked list — worker rows (pane-bearing items) plus item rows (pane-less notes, queued changes, probes, tasks; done items dimmed) — through the shared `WatchedTable` component (entry points `Operator: Show tasks` and mobile `?tab=tasks`), and the tmux Server page's WATCHED zone is the workers-only fleet view ([ui/quake-terminal](/run-kit/ui/quake-terminal.md), [ui/routes-and-shell](/run-kit/ui/routes-and-shell.md) § Server Page WATCHED Zone) (2281). The sidebar's watched underbar + `opr` register and the cron palette actions (`Cron: new entry` / `mute…` / `pin…` / `delete…`) ride the same projection ([ui/sidebar](/run-kit/ui/sidebar.md), [ui/keyboard-and-palette](/run-kit/ui/keyboard-and-palette.md)). Pending escalations (open questions awaiting the user) are not built — they sit in the registry's Extension Map ([ui/routes-and-shell](/run-kit/ui/routes-and-shell.md) § Server Page WATCHED Zone → Extension Map) as a consumer of the tracked items' note text (the `operatorTracked` read carries it). The spec records the agents-tile dashboard design as superseded (a tab-scoped tile for a server-scoped fact; the `agents` surface kind is not reserved — `SURFACE_KINDS` is `tty · web · code · gui`).

Cron is operator-agnostic: the operator is one consumer among many. The only suppression of a fire is the entry's own `muted` flag / `muted_until` lease, written through `rk cron` verbs — the clock is TOLD, it never infers (it does not read the fab operator state file for control; that file feeds the watchlist projection only, § External Contracts) (upt2).

## CLI: the `rk cron` Family

The `rk cron` cobra family (`app/backend/cmd/rk/cron.go` + per-verb files, the `rk mux` layout) is the agent-facing mutation and invocation surface over the library:

| Verb | Behavior |
|---|---|
| `add <prompt>` | Records one entry via `cron.Add`; exactly one schedule flag — `--every <dur>`, `--idle-every <dur>` (sugar for a flat backoff ladder, min = max), bare `--backoff`, or `--cron "<expr>"`; creator and default target auto-captured inside a pane (the role → session → pane ladder), or an explicit `--role`/`--session`/`--pane` flag; repeatable `--respawn <arg>` carries the caller-supplied respawn argv (§ Caller-Supplied Respawn); `--wake-on <event>` with `--wake-scope`/`--wake-debounce` builds the `wake_on` block; `--json` prints the envelope receipt `{"id","name","schedule","target"}` — exactly the four fields the human line prints, as the same strings (`schedule` via `cronScheduleSummary`, `target` via `cronTargetSummary`) (260911-fr5t-cli-spawn-and-steer-receipts) |
| `edit <id>` | Replaces one entry's schedule / `deliver` / name / `if_absent` / respawn argv / `wake_on` block in place via `cron.Edit` (§ In-Place Edit) — each flag given replaces that field, omitted fields keep their values; the schedule flags are `add`'s four-way-exclusive set via the shared `cronScheduleFromFlags` parser (zero schedule flags keeps the schedule); target and creator are immutable; a schedule or deliver change appends one `rescheduled` log line (the anchor reset) — a wake_on-only edit appends none; unknown id ⇒ `no entry <id>`, exit 1 (9aup) |
| `list [--json]` | One row per entry — id, name, schedule summary, target, deliver, flags, last-fired — or the same records under `result` in the standard rk JSON envelope (`{"ok":true,"result":[…]}`, failures `{"ok":false,"error":{…}}`; the convention and its `ok`-mirrors-exit-code rule live in [architecture/cli](/run-kit/architecture/cli.md)) (260911-ehm2-cli-json-read-verbs). Each record's `schedule` is a structured object and the record carries the intent fields `wake_on`, `if_absent`, `respawn` (plus `schedule_summary`, the table's rendering) |
| `rm <id>` | Removes one entry via `cron.Remove`; `--json` prints the receipt `{"id","removed":true}` (260911-fr5t-cli-spawn-and-steer-receipts) |
| `mute <id> [--for <dur>] [--off]` / `pin <id> [--off]` | Set (bare) or unset (`--off`) the flag via `cron.SetMuted` / `cron.SetPinned`; `mute --for <dur>` leases the mute until now+dur via `cron.SetMuteLease`; `mute --json` prints the receipt `{"id","muted","until"?}` — `until` present only on the `--for` lease (the same RFC3339 string the human line prints), `muted:false` on `--off` (260911-fr5t-cli-spawn-and-steer-receipts) |
| `tick` | One `cron.Tick` sweep across every live server with zero-value `Deps` |

**The prompt is text for an agent, never a command** — the positional is `<prompt>` in usage and help (the on-disk schema key stays `payload`, unchanged); the `add` Long and the `cron` parent Long both state it, and the parent opens with "This is not a system cron: nothing is executed": at fire time rk types the prompt into the target agent's chat through the injection engine and presses Enter, exactly as if a person had typed it; it is never run as a command (to run a command, ask the agent to run it) (upt2). The parent Long closes with the agent-briefing pointer `Agent briefing: `run-kit skill cron`.` (hcon)

**Server resolution** follows the `rk mux` order: an explicit `-L/--server` wins, else the caller's own server derived from the original `$TMUX` socket basename (`tmux.OriginalTMUX`), else `default`. The resolved name is the cron file slug, validated by `cron.ValidSlug` before any path is built. `tick` takes no `-L` and rejects an explicitly-set one with a usage error — the sweep is all-live-servers by design.

**The add-flag ↔ schema mapping**: `--every` carries a positive Go duration into `schedule.interval`; `--idle-every <dur>` is input-side sugar for a FLAT backoff ladder — it writes `schedule: {kind: backoff, min: <dur>, max: <dur>}` with no schema or evaluator change, and renderers keep showing the on-disk truth (`backoff 3m→3m`); bare `--backoff` builds `{kind: backoff, min: 60s, max: 30m}` with `--min`/`--max` refining it (a usage error without `--backoff`, and so with `--idle-every`) — the ladder is keyed on the target pane's idle epoch and there is no anchor field (§ Entry Schema); `--cron "<expr>"` carries a 5-field expression in the daemon's local time, validated at add time via `robfig/cron/v3`'s `ParseStandard` (a non-parsing expression fails the add; the CLI's field-count pre-check fires first as a friendlier usage error); `--catch-up once` — a usage error without `--cron` or with any other value — opts the entry into one late fire after a gap (§ The Stateless Evaluator). Exactly one of the four schedule flags is required (`exactly one schedule flag is required: --every, --idle-every, --backoff, or --cron`); the flag-set parser (`cronScheduleFromFlags` over a `cronScheduleFlags` struct) is shared with `edit`, which treats zero schedule flags as "keep the schedule" (9aup). `--deliver`/`--if-absent` are validated against the schema's closed sets at parse time (enforced at fire time by the deliverer and the tick orchestrator); `--name` defaults to the payload truncated to 40 runes; `--pinned` sets the flag. Success prints the assigned id and a one-line entry summary on stdout — or, under `--json`, exactly one envelope document whose `result` is `{id, name, schedule, target}`, the four fields the human line prints as the same strings (`cronScheduleSummary`/`cronTargetSummary`); a failing RunE gets its `{"ok":false}` envelope from `execute()`'s central writer. (260911-fr5t-cli-spawn-and-steer-receipts)

**`--respawn` (repeatable)** — a pflag `StringArrayVar`: one argv element per occurrence, passed exactly as typed (no splitting, no quoting rules — a path with spaces survives); an empty `--respawn` set normalizes to nil so `respawn:` stays omitted on disk. Usage-error matrix (via `cron.ValidateRespawnIntent`, shared with the API): `--respawn` without `--if-absent respawn` is an error; `--if-absent respawn` without `--respawn` is an error for role and pane targets (no default exists for them) and allowed for session targets (the resume default, § Session-Target Respawn). The Long documents the `{server}` placeholder (upt2).

**The wake flags** — `--wake-on <event>`, `--wake-scope <scope>` (default `server`), and `--wake-debounce <dur>` (default 60s) — exist on both `add` and `edit` and are parsed and validated by the shared `cronWakeOnFromFlags` helper (defined in `cron_add.go` beside `cronScheduleFromFlags`, bound to each verb's own flag vars; `cronWakeDebounceDefault` is the shared 60s default). Validation is CLI-side and usage-classified (exit 2, state dir untouched): `--wake-on` accepts only `agent-state-change` and `--wake-scope` only `server` (both via the existing `cronAddValidateEnum`), and a negative `--wake-debounce` is an error. `--wake-scope`/`--wake-debounce` without `--wake-on` are a usage error (`--wake-scope/--wake-debounce only apply with --wake-on`), detected via `Flags().Changed` so an explicit `--wake-scope server` alone still errors. On `add`, `--wake-on <event>` builds `WakeOn: &cron.WakeOn{Event, Scope, Debounce}` from the three flags; without the flag `WakeOn` stays nil and the file omits the key. On `edit` (the helper's `allowClear` arm), `--wake-on <event>` replaces the WHOLE block — the `server`/`60s` defaults fill any knob not given, even over a stored non-default value — and `--wake-on none` (alias `off`, the named constants `cronWakeClearNone`/`cronWakeClearOff`) clears the block so the file drops the key; `none`/`off` combined with a knob is a usage error, and `add` rejects both spellings. A wake_on-only edit logs NO `rescheduled` line — `cron.Edit` compares `Schedule`/`Deliver` only, and `wake_on` carries no anchor to reset (the wake cursor is keyed by entry id and cold-starts harmlessly). `Entry.validate()` carries no wake_on rule, so tolerant load is unchanged (ntde).

**Creator auto-capture and the default target**: inside a tmux pane, `add` stores `created_by: {pane: $TMUX_PANE, at: now}` and fills `session` with the caller pane's parsed `@rk_pane_agent_session` ref whenever one is stamped — regardless of the target kind the ladder or the flags select. The default target follows the role → session → pane ladder: `{kind: role, role: <value>}` when the caller's own window carries ANY non-empty `@rk_win_role` (resolved via `tmux.WindowIDForPane` + `tmux.GetWindowOption` with `tmux.RoleOption`); else `{kind: session, session: <ref>}` when the caller pane carries a parseable session ref (the `cronPaneSessionFn` seam over `tmux.GetPaneOption` + `tmux.ParseAgentSessionRef`); else `{kind: pane, pane: $TMUX_PANE}`. A failed option read degrades to the next rung with a stderr note, never aborts and never guesses. Explicit `--role <role>` / `--session <ref>` / `--pane %N` (the three target flags mutually exclusive; `--role` accepts any non-empty whitespace-free value — a role string is a tmux option discriminator other verbs read back — `--session` validated against `tmux.ValidAgentSessionRef`, `--pane` against `tmux.ValidPaneID`) override auto-capture; outside tmux an explicit target flag is required.

**`list` is disk-derived only**: entry file + delivery log, zero tmux commands — a tmux probe against a dead socket would resurrect the server, and next-fire/rung/orphan derivations need live facts, derived behind the HTTP API instead (§ HTTP API). The FLAGS column renders `muted(<remaining>)` for a live lease (e.g. `muted(4m)`, via `cronDurationShort`), `muted` for the indefinite flag, `pinned` as today, comma-joined. Under `--json` each record reports the EFFECTIVE `muted` (flag OR live lease) plus `muted_until` (snake_case, `omitempty` — emitted only while the lease is live, matching the record's existing snake_case keys), and additionally carries the raw log-derived orphan-streak fields `orphaned_since`/`expires_at` (§ Orphan TTL GC) — raw because the zero-tmux invariant bans resolution probes, so the API remains the live-gated surface. An absent or empty file is an empty listing (`{"ok":true,"result":[]}` under `--json`) with exit 0; load diagnostics print to stderr without failing the listing.

**`--json` intent fields are structured and keyed like the entry file** (`cronListRecord` + `cronListSchedule`/`cronListWakeOn` in `cron_list.go`, snake_case throughout — the HTTP API's camelCase projection is a separate type by design). The record array nests under `result` in the standard envelope (`sink.Envelope`), so machine consumers read `.result[]` (260911-ehm2-cli-json-read-verbs):

| Key | Shape | Presence |
|---|---|---|
| `schedule` | `{kind, interval?, min?, max?, expr?, catch_up?}` — `kind` always; the parameters `omitempty`, so each kind carries only its own (`every` → `interval`; `backoff` → `min`/`max`; `cron` → `expr` + `catch_up`). Durations are `time.Duration.String()` (`"1m0s"`, `"30m0s"`), the same encoding as `GET /api/cron`; an unset duration is omitted, never `"0s"` | always |
| `schedule_summary` | the table's SCHEDULE rendering (`cronScheduleSummary`: `every 1h` / `backoff 1m→30m` / `cron <expr> (catch-up once)`) | always — **deprecated on arrival, kept for one release** (through the release after r5ao ships), then removed |
| `wake_on` | `{event, scope?, debounce?}` when the entry has a block; JSON `null` when it does not — never omitted | always |
| `if_absent` | the stored string verbatim; `""` when unset (the raw intent, never the evaluator's effective default — `deliver` is emitted the same way) | always |
| `respawn` | the stored argv verbatim, `{server}` placeholder unsubstituted; `[]` when unset — never `null` | always |
| `target` | stays the `role:<r>` / `session:<id>` / `pane:%N` summary string (fab-kit matches on it) | always |

Everything else on the record (`id`, `name`, `deliver`, `pinned`, `muted`, `muted_until`, `last_fired`, `orphaned_since`, `expires_at`) keeps the fixed-key-set rule above — `muted_until` remains the sole `omitempty` scalar (r5ao).

**`tick` is the invoker verb**: it wraps `cron.Tick(ctx, cron.Deps{})` — flock, live-server filter, TMUX scrub, and tolerant load all inherited — under a bounded 60s context. Zero-value `Deps` wires no `Deliverer` (fires record outcome `no-deliverer` while the fire/log/cursor choreography exercises) — the CLI verb is the debug invoker; delivering ticks are the daemon Ticker's (§ Daemon Ticker Invoker), which passes the `EngineDeliverer`. A held lock exits 0 quietly with no output; otherwise stdout carries a one-line summary — servers swept, fires, diagnostics count. Real errors (dir resolution, lock creation) exit non-zero via RunE.

## HTTP API

The cron HTTP surface (`app/backend/api/cron.go`, registered beside the other resource routes in `api/router.go`) is a thin JSON translation layer over `internal/cron` — all schedule math stays in the library (`DeriveEntry` calls `JoinAnchor`/`Ladder.NextFire`/`everyAnchor`/`LastDelivery`), the handlers never reimplement it. The wire shape is camelCase (the on-disk YAML's snake_case never crosses the HTTP edge); the server resolves via `serverFromRequest` (`?server=`).

| Route | Behavior |
|---|---|
| `GET /api/cron` | Every entry's intent fields plus the derived facts `lastFired` (unix seconds, 0 = never), `nextFire` (omitted when unknowable), `rung`, `orphaned`, `orphanedSince`/`expiresAt` (`omitempty`, zero unless orphaned — § Orphan TTL GC) — `{"entries": [...]}`; plus a sibling `deliveries` array: the newest delivery-log lines (the log is chronological, so the tail is newest) projected most-recent-first via `cronDeliveriesToJSON` off the log `handleCronList` already loads (`cron.ReadLog` ≡ read + `ParseLog` — no second disk read), capped at `maxCronDeliveries` (50, named constant), each `{ts, entry, name, target, reason, outcome}` with `name` joined from the current entries (empty when the entry was since deleted — a delivery for a removed entry stays valid history). `muted` reports the EFFECTIVE state (`Entry.EffectivelyMuted(s.now())` — stored flag OR unexpired lease), so every consumer (the quake terminal `Cron List` tab's dimming, the entry detail sheet, the palette) stays correct without knowing about leases; `mutedUntil` (unix seconds, `omitempty`) is the additive lease fact, emitted only while the lease is live — an expired lease is indistinguishable from no lease on the wire (`cronEntryToJSON` takes `now` for both). `respawn` echoes the entry's argv (`omitempty`); the schedule shape is `{kind, interval?, min?, max?, expr?, catchUp?}` with no `anchor` key. A live-server endpoint (unlike `rk cron list`): it gathers resolved-target facts via the `Server.cronFactsFn` seam (production wires `cron.GatherFactsLive`; nil on the test router), so backoff next-fire/rung and the orphaned flag are real. An absent/empty entry file or log yields `{"entries": [], "deliveries": []}` at 200, never 404; corrupt-entry diagnostics are logged server-side (`slog`), never surfaced |
| `POST /api/cron/create` | Body mirrors the `rk cron add` schema fields (name, schedule kind+params including `catchUp`, target kind+params, payload, deliver, ifAbsent, `respawn`, pinned); `created_by.at` is set to now unconditionally (it anchors `every` schedules pre-first-delivery). Validates + persists via `cron.Add` — any `Add` error is a 400 with the underlying text, including the shared add-time gate `cron.ValidateRespawnIntent` (a role or pane target with `ifAbsent: respawn` and no `respawn` argv is a 400); success is 201 with the created entry (assigned 4-char id) |
| `POST /api/cron/delete` | `{"id": "<4char>"}` → `cron.Remove`; unknown id ⇒ 404; success ⇒ 200 `{"ok": true}` |
| `POST /api/cron/mute` | `{"id": "<4char>", "muted": <bool>, "for"?: "<Go duration>"}` → `cron.SetMuted` / `cron.SetMuteLease`; `muted:true` with no `for` sets the indefinite flag (clearing any lease); `muted:true` with a valid positive `for` leases the mute until now+`for` via `cron.SetMuteLease` (the same store helper the CLI's `mute --for` uses); `muted:false` clears both flag and lease; an unparsable or non-positive `for` ⇒ 400; unknown id ⇒ 404; success ⇒ 200 `{"ok": true}` (hcon) |
| `POST /api/cron/pin` | `{"id": "<4char>", "pinned": <bool>}` → `cron.SetPinned`; unknown id ⇒ 404; success ⇒ 200 `{"ok": true}` — mirrors mute's contract exactly |
| `POST /api/cron/edit` | `{"id": "<4char>", schedule?, deliver?, name?, ifAbsent?, respawn?}` — the route parity of `rk cron edit`: present-keys-set partial-merge semantics (Constitution IX — absent keys keep their values; `schedule` present replaces the whole schedule; `respawn: []` clears the argv; `ifAbsent` set to a non-`respawn` value clears `respawn`), decoded into pointer fields over a raw key map. `target`, `createdBy`, `muted`, `pinned` keys are rejected with 400 (`target is immutable` / `use /api/cron/mute|pin` wording). Flow: decode → enum/duration pre-checks mirroring `validate()`'s closed sets → `cron.Edit` (the shared helper behind the CLI verb — § In-Place Edit) → 404 `cron entry not found` on unknown id, 400 on a merged-entry validation failure (the `EntryValidationError` unwrap), 409 on tick-flock contention (`ErrEditContention`), 500 on other store errors → SSE wake → 200 with the updated entry in the `create` response shape. No frontend client helper consumes it yet (9aup) |

Every mutation wakes the SSE hub explicitly on success (`s.initSSEHub(); s.sseHub.wake(server)` — the same wake-after-write pattern as `handleSessionStringOption`): entry-file writes emit no tmux control-mode event, so without the wake the repaint would wait for the safety poll. The CLI's `mute --for` lease mutator cannot wake the hub (as for every `rk cron` verb); the web surfaces catch up on the next sessions-slice broadcast.

**Trust note**: entries can be created over the localhost HTTP API, so the API can make the daemon exec a `respawn` command — but it could already type arbitrary text into an agent's chat (command execution by proxy), so the trust boundary does not move (upt2).

**Per-entry derivation** (`internal/cron/derive.go`): `DeriveEntry(e, log, facts, now) DerivedEntry` computes `{NextFire, HasNextFire, Rung, Orphaned, OrphanedSince, ExpiresAt, LastFired}` per entry from the delivery log plus resolved `TargetFacts`. An `every` next-fire is `everyAnchor(e, log) + interval`; a `backoff` rung/next-fire come from `JoinAnchor(StateEpoch, ScheduleHistory, min, max)` (§ `backoff` and the anchor-join rule — the reschedule-bounded view) — the reported rung is the ladder's + 1 (the upcoming fire's rung) — and are unknowable (`HasNextFire` false) without a resolved anchor epoch; a `cron`-kind entry's next-fire is the next occurrence after now via `ParseStandard` + `Schedule.Next` (`Rung` stays 0) — `HasNextFire` holds false only when the expression fails to parse, never a fabricated time. `Orphaned` is a live per-call snapshot of target resolution (`!facts.Resolved()`), never a persisted expiry state; `OrphanedSince`/`ExpiresAt` are the § Orphan TTL GC derivations (zero unless orphaned; `ExpiresAt` additionally zero for pinned and role entries).

**Watchlist reader** (`internal/cron/watchlist.go`): `ReadOperatorState(path)` tolerantly parses the fab-owned operator state file (path via `FabOperatorStatePath` over the socket-path slug — § External Contracts) into `OperatorState{Items []TrackedItem, LastTickAt}`; `ParseOperatorState(data)` is the bytes-level half. One parse, two projections. `Items` holds EVERY id-bearing `tracked:` item — pane-less, done, paused, or scope-less — in the list's own order (fab's insertion order, the operator's ledger), each a `TrackedItem{ID, Kind, Text, Refs, Pane, Repo, Session, Stage, Agent, Branch, Paused, DoneAt, AddedAt, UpdatedAt}`: `Text` from the item's `text` (fab caps note prose at 500 chars), `Refs` from `scope.refs` (string elements only, `nil` when absent), `Paused` from `paused == true`, the three timestamps through `parseTickAt` (`null`/absent ⇒ 0; a non-null but unparseable `done_at` decodes to 0 and the item reads as live — the binary writes RFC3339 and nothing else), and a missing or non-map `scope` keeps the item with empty scope fields (a note's scope is `{refs: [...]}`, a task may carry none). `OperatorState.WatchlistEntries()` is the pane join's input: the pane-bearing (`Pane != ""`), not-done (`DoneAt == 0`) subset sorted by ID — `paused` and `kind` never filter — as `[]WatchlistEntry{ChangeID, Pane, Repo, Session, Stage, Agent, Branch, Kind}`. The primary shape is fab-kit ≥ 2.25's top-level `tracked:` list (`parseTrackedItems`); the pre-2.25 `monitored:` map (`parseMonitoredMap`, `Kind` empty, every legacy entry pane-bearing and never done) is read ONLY when the `tracked` key is absent — a one-release dual read; with `tracked` present, even as `[]`, the map is ignored. Malformed items (a non-map element, a missing id) are skipped, never fatal; a non-list `tracked:` yields no items. Unknown keys ignored, absent/corrupt file ⇒ `(zero, false)`, never an error. rk never writes the file. `DefaultWatchlistStaleThreshold` (15m) is the UI-facing "is the monitoring system dead" window over `last_tick_at` — a display threshold only; nothing in cron gates a fire on it. The sessions-payload projections this reader feeds (the `monitored*` join and `operatorTracked`) are documented in [tmux-sessions](/run-kit/tmux-sessions.md) § Fab-Tier Derivation.

## In-Place Edit

`rk cron edit <id>` and `POST /api/cron/edit` are the two surfaces of one helper, `cron.Edit(dir, slug, id, now, apply)` (`internal/cron/edit.go`), so they cannot drift (9aup):

- **The merge** — `cron.Update(dir, slug, id, apply)` (`store.go`, beside `setFlag`): `loadForMutate` → locate the entry (absent ⇒ `(Entry{}, false, nil)`, the `Remove` shape) → `apply` mutates a copy → the merged entry passes `validate()` and `ValidateRespawnIntent` (a failure is wrapped in `EntryValidationError` and writes nothing — the callers' 400/usage-error signal, distinct from a store failure's 500/exit 1) → `saveEntries` (atomic via `fsatomic`). `Update` writes no fields of its own; `ID`, `Target`, `CreatedBy`, `Muted`, `MutedUntil`, `Pinned` survive byte-for-byte.
- **The flock** — the entry write and the log append happen under the tick flock (`acquireLock(LockPath(dir))`, non-blocking, retried every 100 ms for up to 2 s — a tick is sub-second); persistent contention returns the `ErrEditContention` sentinel (`cron tick in progress — retry`), rendered as CLI exit 1 / HTTP 409. The lock orders the reset relative to a tick's read-evaluate-append; `AppendLog` is `O_APPEND`, so byte safety never depended on it. `add`/`rm`/`mute`/`pin` stay lock-free (entry writes are atomic and touch no log).
- **The `rescheduled` log line — the anchor reset.** When the merged `Schedule` or `Deliver` differs from the stored one, `Edit` appends `LogLine{TS: now, Entry: id, Reason: "edit", Outcome: "rescheduled"}` (no `Target`). Name-, `if_absent`-, `respawn`-, and `wake_on`-only edits, and no-op edits (merged schedule and deliver equal the stored values), append nothing. The line is schedule history, like `missed`: `every`/`cron` count from the edit (their anchor is `LastDelivery`, outcome-agnostic), a backoff streak is cut (§ `backoff` and the anchor-join rule — `ScheduleHistory`), `OrphanedSince` skips it (§ Orphan TTL GC), it never counts toward the rate cap (§ Circuit Breakers), and the wake cursor is untouched. `LAST-FIRED` / `lastFired` (both `LastDelivery`) show the edit time until the next outcome — the same precedent `missed`/`skipped-absent`/`rate-capped` set.
- **Field semantics** — each flag/key given REPLACES that field; omitted fields keep their values. The schedule flags are `add`'s four-way-exclusive set via the shared `cronScheduleFromFlags` parser: zero schedule flags keeps the stored schedule; more than one is the exactly-one usage error; `--min`/`--max` without `--backoff` is a usage error even when the stored schedule is a backoff (a refinement is spelled `--backoff --min …` and replaces the whole ladder, 60s/30m defaults for the knob not given). `--respawn` replaces the whole argv; `--if-absent` set to a non-`respawn` value clears `respawn` (an argv without the policy is dead weight and would trip the merged-entry respawn rule). `--wake-on <event>` replaces the whole `wake_on` block (the `server`/`60s` defaults fill the knob not given); `--wake-on none` (alias `off`) clears it. **Target and creator are immutable** — `--role`/`--session`/`--pane` are not defined on the verb (a target flag fails as an unknown flag, exit 2) and the route rejects the `target`/`createdBy` keys with 400; mute/pin keep their own verbs/routes. A bare `edit <id>` is the usage error `nothing to edit — pass a schedule flag, --deliver, --name, --if-absent, --respawn, or --wake-on`.
- **CLI output** — one stdout data line `edited <id> <name> [<schedule summary> -> <target summary>]` via `cronScheduleSummary`/`cronTargetSummary`; the `rescheduled` append is not separately announced. Unknown id ⇒ `no entry <id>`, exit 1 (the `rm`/`mute`/`pin` shape).
- **Owner tuning** — `edit` is also how the operator entry's owner tunes it: fab's clock reconcile applies its derived schedule and deliver policy through `rk cron edit` (§ External Contracts), and a user's `rk cron edit <op-id> --idle-every 3m` turns the operator tick into an idle reminder; nothing in rk re-seeds or rewrites the entry, so an edit survives every later `rk operator` launch.

## State Files

All cron state lives under `${XDG_STATE_HOME:-~/.local/state}/hexokit/cron/` (`DefaultDir`, resolved through `internal/apphome` — the `hexokit` state dir when it exists, else the legacy `run-kit` state dir when it exists, else the `hexokit` dir; XDG-honoring with the `~/.local/state` fallback; dir 0700, files 0600). For one release the legacy `$XDG_STATE_HOME/run-kit/cron/` tree stays active through that dual-read rule: `internal/homemigrate` copies `cron/` (entry files, delivery logs, and wake cursors) into the new state home at release-build serve start while leaving the legacy tree byte-unchanged, so a pre-migration process keeps reading and writing the legacy dir. The legacy read arm and the legacy tree are dropped next release. Server slugs are tmux socket names validated against `^[A-Za-z0-9_-]+$` (the snapshot-store rule) before any path is built — a validated slug can never traverse or split a path.

| Path | Content | Class |
|---|---|---|
| `<slug>.yaml` | cron entries — intent (the same class as `.status.yaml`) | intent |
| `<slug>.log` | delivery log, JSON lines | recovery-backup (history, never a live-state source) |
| `<slug>.cursor.yaml` | `wake_on` previous-observation cursor | startup seed cache (never authoritative) |
| `.lock` | non-blocking tick flock (no slug — one lock serializes a tick across all servers) | droppable |

## Entry Schema

Entry files are INTENT: runtime facts (`last_fired`, `next_fire`, backoff rung, orphaned-since) are never schema fields — they derive from the delivery log, the pane agent-state option, and the wake cursor. The typed schema (`schema.go`):

- `id` — 4-char rk-generated id (random from `[a-z0-9]`, unique within the server's file), assigned by `Add`.
- `name`, `payload` — display name and the text delivered on a fire.
- `schedule` — `kind: every | backoff | cron`; `every` carries `interval`; `backoff` carries `min` + `max` (the ladder is keyed on the target pane's idle epoch by definition — there is no anchor field); `cron` carries a 5-field `expr` (parsed via `robfig/cron/v3`'s `ParseStandard` at validation time — a non-parsing expression fails per-entry validation: an `entry-invalid` diagnostic on tolerant load, an error on the strict mutation read) plus an optional `catch_up: once` (cron-kind only; any other value, or any value on another kind, fails validation) opting into one late fire after a gap. Durations are Go `time.ParseDuration` strings (`60s`, `30m`). A retired `anchor:` key in an existing file is accepted and ignored on read (unknown key).
- `wake_on` — `{event: agent-state-change, scope: server, debounce}` edge trigger OR'd with the schedule.
- `target` — `kind: role | session | pane` + the discriminant field (`role`, `session`, `pane`); a role target accepts ANY `@rk_win_role` value (`operator` is the predominant one; `RoleOperator` exists for the call sites that name the operator role literally — the operator-window lookup in `push_url.go`); pane targets must pass `tmux.ValidPaneID` (the `%N` grammar).
- `deliver` (`immediate | when-idle | skip-if-busy`) — delivery gating enforced by the deliverer (§ EngineDeliverer): `immediate` (or empty) sends at fire time; `when-idle` holds while the target pane's agent state reads busy; `skip-if-busy` reads the state once at due time and drops a busy-pane fire with a logged `skipped-busy` outcome that advances the anchor. The closed set is enforced by `Entry.validate()` (`""`, `immediate`, `when-idle`, `skip-if-busy` pass; anything else fails with `unknown deliver value %q` — so `POST /api/cron/create` rejects an unknown value with 400 instead of storing it) (9aup).
- `if_absent` (`skip | notify | respawn`) — disposition of a due fire whose target doesn't resolve, applied by the tick orchestrator (§ Tick Orchestration's `if_absent` dispositions): `respawn` runs the entry's own `respawn` argv on a `role` or `session` target (§ Caller-Supplied Respawn), falls back to the `Deps.SessionRespawner` seam on a `session` target without an argv (§ Session-Target Respawn), and degrades to `notify` plus a `respawn-uncommanded` diagnostic on a role target without an argv, a nil session seam, or a `pane` target (always).
- `respawn` — the caller-supplied argv (`[]string`) used only with `if_absent: respawn`; validation rejects a present-but-empty slice (`respawn needs at least one element`) and an empty `argv[0]`.
- `pinned`, `muted`, `muted_until` — the flags plus the mute lease (unix seconds): `muted` is the indefinite mute, `muted_until` a bounded one (§ Mute Lease). Both are intent fields set only by mutation verbs.
- `created_by` — `{session, pane, at}` provenance; `session` is the caller pane's agent-session ref when one is stamped (§ CLI creator auto-capture), and `at` is the pre-delivery anchor for `every` and the orphan-streak fallback for a never-logged entry (§ Orphan TTL GC).

Per-entry validation gates id presence, schedule-kind shape (positive interval, `max ≥ min` — equality is allowed, so a `min == max` backoff is a legal flat ladder), the `deliver` closed set, target shape, and the respawn argv shape. The mutation helpers `Add` / `Update` / `Remove` / `SetMuted` / `SetMuteLease` / `SetPinned` read-modify-write the file atomically via `fsatomic.WriteFile`; the mutation read path is strict — a corrupt file is an error (`refusing to mutate`), never a silent drop of existing intent. A `suppress_while:` key in an existing file is likewise accepted and ignored on read (unknown key); neither retired key is rewritten on read — it disappears the next time any mutation verb marshals that file.

### Mute Lease

`Entry.EffectivelyMuted(now)` is the single muted rule — `Muted || (MutedUntil > 0 && now.Unix() < MutedUntil)` — used by the evaluator, the API projection, and `rk cron list` alike. Write rules (`store.go`, all riding the shared atomic `setFlag` read-modify-write; a corrupt file refuses to mutate): `SetMuteLease(dir, slug, id, until)` sets `muted_until = until` AND clears `muted` (a lease is a bounded mute — an earlier indefinite mute does not outlive it); `SetMuted(…, true)` sets `muted` AND clears `muted_until` (indefinite wins); `SetMuted(…, false)` (the `--off` path and the HTTP `muted:false` body) clears both. Lease expiry needs no write and no wake: the evaluator reads an expired lease as unmuted on its next evaluation, and the stale `muted_until` value is scrubbed by whichever mutation next marshals the file (upt2).

## Operator-Tick Entry Ownership

The operator-tick entry is a consumer's entry, not rk's: **rk defines the schema and the evaluator; the consumer (fab) seeds and tunes its entry.** fab-kit's clock reconcile (`operator_clock.go`, fab-kit ≥ 2.26.2) seeds it when `rk cron list --json` shows no `role:operator` row — one fully explicit `rk cron add "operator tick" --backoff --min 3m --max 24m --wake-on agent-state-change --wake-scope server --wake-debounce 60s --deliver skip-if-busy --role operator --if-absent respawn --respawn rk --respawn operator --respawn -L --respawn '{server}' --pinned` — on zero candidates only (never on an rk failure or an ambiguous tie), from every reconcile entry point (`fab operator track` mutations, `tick-start --diff`, and `fab operator clock sync`, which `/fab-operator` §2 Init and every per-tick frame run), and then tunes it through `rk cron edit` (§ In-Place Edit). The `rk cron add --help` example shows the same entry, relying on the `server`/`60s` wake defaults for `--wake-scope`/`--wake-debounce`. rk carries no copy of the entry's field values: `rk operator` is launcher-only — singleton role window, `fab agent operator` resolution, kickoff delivery, promotion ([rk-riff](/run-kit/rk-riff.md) § Single-Quote Escaping and Task Injection) — and never reads or writes the cron state dir; the entry's `respawn: ["rk", "operator", "-L", "{server}"]` argv is the one place the launcher appears, and it runs only when the entry already exists and fires (§ Caller-Supplied Respawn). Existing on-disk entries are never migrated or rewritten by rk outside the mutation verbs (pfo3).

## Tolerant Load

`LoadEntries` never fails a tick: an absent file yields an empty set with no error; an unreadable or unparseable file yields an empty set plus a diagnostic (`entry-file-unreadable` / `entry-file-corrupt`); each entry is decoded from its own `yaml.Node` so one malformed entry (bad duration, unknown schedule kind, unknown target kind) is skipped with a per-entry `entry-invalid` diagnostic while the rest load. Unknown keys are ignored everywhere — including the retired `anchor:` and `suppress_while:` keys on files that carry them.

## The Stateless Evaluator

`Evaluate(EvalInput) EvalResult` is the pure core: no package-level mutable state, no I/O — equal inputs return deep-equal results (pinned by test), so every invoker (CLI tick, daemon ticker, manual) is equivalent. `EvalInput` carries everything disk-derivable: the server's entries, per-entry resolved `TargetFacts`, the server agent-state map `States` (pane id → state; each `wake_on` entry fingerprints its own target-excluded view of it), the parsed delivery log, the previous `WakeCursor`, and `Now`. `EvalResult` carries due `Fire`s (entry, resolved reason `schedule | wake`, resolved target pane, backoff rung, fire time, `DueAt` — the scheduled time the fire came due), due-but-target-unresolved fires in `Absent []Fire` (emitted with an empty `PaneID`, exactly as resolved fires), stale cron occurrences in `Missed []Fire` (mute-gated, target-independent — schedule history for the tick to log as one `missed` line per gap), `Diagnostic`s, and the `NextCursor` for the tick orchestrator to persist. Composition order per entry: muted (flag or live lease, via `EffectivelyMuted`) → schedule/wake due math → target resolution → emit. A muted entry is skipped with a `muted` diagnostic whose detail distinguishes the two forms — `entry is muted` (the flag) vs `entry is muted until <RFC3339>` (a live lease); a skipped fire is a silent diagnostic, never an error, never a recorded miss.

### `every`

Fires when `now − anchor ≥ interval`, where the anchor is the entry's newest delivery-log line, or `created_by.at` before any delivery.

### `backoff` and the anchor-join rule

Fire times are `anchor + min·(2ⁿ − 1)` — gaps `min, 2·min, 4·min, …` with each gap capped at `max`. The effective anchor is *the last activity not caused by the clock*. `JoinAnchor` joins the raw idle epoch (the target pane's `@rk_pane_agent_state` epoch, supplied in facts) against the entry's own delivery log:

- A raw epoch within `attributionWindow` (named constant, 120s) after the entry's own latest delivery is attributed to that delivery (the agent going busy/idle because the payload landed) and does NOT reset the ladder — including the stale-option skew case where the epoch still predates the delivery.
- On an attributed epoch, the rung is recovered by a backward streak walk over the log: consecutive own deliveries whose spacing fits the ladder shape (a gap must not be SMALLER than the ladder gap at its rung minus the attribution tolerance; larger gaps are invoker lateness, which idempotent ticks absorb). The walk is **seeded from the newest gap** as the *largest* rung whose ladder gap is ≤ gap + `seedSkew` (`largestRungWithGapAtMost`; `seedSkew` is a named constant equal to `DefaultTickInterval`, 30s — lateness only ever inflates a gap, so the seed adds one poll of jitter and never subtracts a tolerance). A newest gap too small for any rung-to-rung spacing (below `2·min − seedSkew`) seeds no walk: the newest delivery is rung 1 of a fresh ladder and nothing older joins. Capped rungs are indistinguishable by gap — the seed takes the smallest capped rung, and the walk then counts each further capped gap (≥ `max − attributionWindow`) as one more rung *at* the cap rather than descending to the pre-cap rung below it, so a streak parked at `max` keeps its full rung count and keeps firing every `max`. The reconstructed anchor is the oldest streak delivery minus `min`. The jitter bound assumes `min ≥ DefaultTickInterval`; below that the ladder is unobservable at the poll cadence anyway (schema validation only requires `min > 0`). A consistency floor — next fire never earlier than last delivery + `min` — falls back to the conservative single-delivery streak when an ambiguous history would under-shoot it.
- No deliveries, or a non-attributed epoch (genuine activity): the ladder resets to rung 0 with the raw epoch as anchor.

Both inputs live on disk, so the schedule stays a pure function; a restart at worst re-fires one due tick. An implementation laddering off the raw epoch alone resets after every delivery (the self-resetting-ladder bug) and fails the shipped tests.

**Flat ladder = idle reminder**: `min == max` collapses the ladder — `gapAfter` returns `max` on every rung, so the entry fires `<dur>` after the last genuine idle moment and then every `<dur>` while the pane stays quiet; the anchor-join rule keeps the clock's own pings from restarting the count (a flip inside `attributionWindow` of the entry's newest own log line is clock-caused) and genuine activity resets it. `rk cron add --idle-every <dur>` is sugar writing exactly this entry. The two clocks differ at the boundaries: the flat backoff counts quiet time (an agent idle for 5 s at a grid boundary is NOT pinged until it has been quiet the full `<dur>`; an agent that went idle 5 s after a boundary is pinged `<dur>` after it went idle), while `--every <dur> --deliver skip-if-busy` fires at every grid point at which the agent happens to be idle (busy boundaries skipped, not held). (9aup)

**The join's log view is reschedule-bounded**: both `JoinAnchor` call sites (`evaluate.go`, `derive.go`) read `ScheduleHistory(log, id)` — the entry's own lines strictly newer than its newest `rescheduled` line (the boundary line itself excluded; identical to `OwnDeliveries` when no edit exists — `OwnDeliveries` stays the unfiltered view), so an edited ladder restarts from the target's raw idle epoch (`Ladder{Anchor: rawEpoch, Rung: 0}` when no lines postdate the edit) instead of walking pre-edit deliveries as rungs of the new ladder. (9aup)

### `cron` expressions

A `cron`-kind entry's due math (`cronexpr.go`, `cronScheduleDue`) is a pure function of (entry, delivery log, now) on the `everyAnchor` rule — the entry's newest own log line, else `created_by.at`. Occurrence math comes from `robfig/cron/v3` (`ParseStandard` + `Schedule.Next` only — its runtime scheduler is never used; the stateless evaluator remains the only clock), evaluated in the daemon's local time. The latest occurrence in `(anchor, now]` is pinpointed by a minute-granularity binary search over the existence probe `Next(t) ≤ now` (~log₂(span-minutes) `Next` calls — never an occurrence-by-occurrence scan from an ancient anchor; a zero `Next`, robfig's 5-year horizon, reads as no occurrence). The entry fires when that occurrence lies within its deliver-dependent window — `DefaultCronGrace` (2m, covering 30s-tick jitter and short daemon restarts) for `immediate` and `skip-if-busy` entries (a skip decides once at due time and needs no cross-tick retry room), `DefaultHoldWindow` (2h — § EngineDeliverer) for `when-idle` entries (a hold is realized as cross-tick retry) — carrying `DueAt` = the occurrence. Past the window: `catch_up: once` fires late exactly once per gap with `DueAt = now` (deliberately opting out of the hold bound); otherwise the occurrence surfaces in `EvalResult.Missed` and the tick logs one `missed` line — advancing the anchor past the gap, one line per gap rather than per tick, which is what keeps later walks short. Missed emission passes the same muted → due math gating as fires (a muted entry suppresses it silently) and is logged regardless of target resolution — schedule history, not delivery, so no `if_absent` disposition applies. Every `Fire` carries `DueAt` (`every`: anchor+interval; `backoff`: ladder next-fire; `cron`: the occurrence; wake and catch-up late fires: `now`) — the deliverer's hold bound derives from it.

### `wake_on` poll approximation

A `wake_on: agent-state-change` entry fires when its **per-entry** agent-state fingerprint differs from the entry's previous observation by an **actionable transition**, held for `debounce` after the entry's own newest delivery. The evaluator receives the raw server-scoped map (`EvalInput.States`, pane id → `@rk_pane_agent_state`) and renders one fingerprint per entry with `fingerprintExcluding(states, facts.PaneID)` — the canonical sorted `pane=state` rendering (`Fingerprint`, map order never leaks in; `parseFingerprint` is its lossless inverse) **minus the entry's own resolved target pane**. A delivery makes the target busy; that flip is caused by the clock and never reads as an edge — the wake analogue of the backoff anchor-join rule. An unresolved target has nothing to exclude, so the full fingerprint is compared. The rule (`wakeEdge`), in order: no prior observation ⇒ cold start, no edge, the cursor seeds (`wake-cold-start`); unchanged ⇒ no edge; changed but **no actionable transition** ⇒ no edge, the cursor ADVANCES so the same transition is never re-judged (`wake-ignored-transition`); changed and actionable but `now − lastOwnDelivery < debounce` (`LastDelivery` — the entry's newest own log line, any reason/outcome; no line ⇒ no hold) ⇒ HOLD, keep the old observation so the edge stays pending (`wake-debounced`); otherwise fire and advance. Classification (`classifyDiff`) walks the union of both parsed fingerprints: a pane moving to `waiting` or `idle`, or vanishing, is actionable; a move to `active` — including a pane first appearing as `active` — is not (an agent starting work needs nobody; a completion or a question does); any other value fails open toward firing. A burst still coalesces into one fire, and a held edge is deferred, never dropped. The cursor is keyed by entry id so one entry's fire cannot advance (and thereby swallow) another entry's pending edge. The operator entry carries `debounce: 60s` — an edge landing right after a tick waits for the poll after next.

The cursor persists at `<slug>.cursor.yaml`, written atomically by the tick orchestrator every tick. It is seed-cache class per Constitution II: absent/corrupt/empty degrades to a cold start (no edge fire that tick, cursor rewritten) — at worst one missed or duplicate edge, which tick idempotency absorbs.

## Delivery Log

`<slug>.log` is append-only, one JSON line per logged outcome: `{ts, entry, target, reason, outcome}`. The outcome classes are `delivered`, `failed: <detail>` (anchor advancement on failure is deliberate self-throttling — retry next due period, not next tick), `skipped-busy: <state>` (a `skip-if-busy` fire dropped on a busy pane — NON-held by design: logged so the anchor advances and the next attempt lands one full interval later, never on the next poll), `skipped-absent` / `notified-absent` (the `if_absent` dispositions), `respawned` / `respawn-failed: <detail>` (the respawn dispositions — an exit-0 argv respawn whose output tail carries the launcher's `kickoff: undelivered reason=<r>` line logs `respawned (kickoff undelivered: <reason>)` instead of the bare form (`respawnSuccessOutcome`), still `respawned`-prefixed for classification; on the argv path the failure detail is the error plus a ≤200-byte output tail (`respawnDetail`); on the session path the seam's returned `Outcome` rendered verbatim, its detail's phase prefix (`readiness:` vs `send:`) distinguishing a pre-delivery classification failure from a post-ready send error), `rate-capped` (circuit-breaker trips), `expired-orphan` (the orphan-GC removal audit — § Orphan TTL GC), `no-deliverer`, `missed` (a stale cron occurrence past its window with no catch-up — schedule history, target-independent, one line per gap), `rescheduled` (an edit's anchor reset, `Reason: edit`, no target — the same schedule-history class as `missed`: it advances the `every`/`cron` anchor to the edit time, cuts the backoff streak (§ In-Place Edit), and is neutral to orphan GC), and `held-expired` (a `when-idle` hold that outlived `DefaultHoldWindow` — the fire is dropped and the anchor advances). **Held (`held-busy`) outcomes are never appended** — a `when-idle` hold records a `delivery-held` diagnostic instead, because the log is the derivation source for `every`'s last-delivery and the backoff anchor-join streak: logging a held attempt would advance anchors and silently delay the fire by a full period. The hold is realized as cross-tick retry — the fire re-computes as due on the next tick. (`skipped-busy` is the deliberate counter-example: a busy-pane outcome that MUST be logged because advancing the anchor is its purpose — § Design Decisions.) The log is history (recovery-backup class), never a live-state source. `ParseLog` skips unparseable lines tolerantly; an absent or unreadable log parses as "no deliveries". When an append pushes the file past the cap (`logCapBytes`, 512 KiB), it is trimmed to its newest ~half, cut at a line boundary, written atomically via `fsatomic` — trimming loses only old history.

## Tick Orchestration

`Tick(ctx, deps)` runs one evaluation sweep — short-lived, idempotent, serialized by the flock: flock → live-server set → per-server load → facts → `Evaluate` → deliver → log → orphan GC → cursor. `Deps` is all seams (`Dir`, `Now`, `ListServers`, `Tmux`, `Deliverer`, `Notifier`, `RunRespawn`, `SessionRespawner`); zero values select the production defaults (`DefaultDir`, `tmux.ListServers`, the real tmux seam, `time.Now`, `runRespawnExec`, `push.Notify`). `RunRespawn` (`RunRespawnFunc`) is the caller-supplied-argv exec seam (nil ⇒ the production `runRespawnExec` — § Caller-Supplied Respawn); `SessionRespawner` has no package-level default: production wires `cmd/rk`'s `rkCronRespawnSession(store)` in `serve.go` (only when the snapshot store resolved — § Session-Target Respawn), and a nil seam keeps the notify-degrade path so a daemon built without it keeps working. A nil `Deliverer` records outcome `no-deliverer` — the fire/log/cursor choreography still exercises. Every diagnostic surfaces at debug via `slog` (the `rate-capped` circuit-breaker trip and the orphan-GC `expired-orphan` audit are the escalations, at Warn); a per-file or per-server failure is a diagnostic, never an aborted tick.

- **flock**: a non-blocking exclusive flock (`syscall.Flock`, `LOCK_EX|LOCK_NB`) on `cron/.lock`. A held lock returns the `ErrTickHeld` sentinel internally; `Tick` treats it as a clean, quiet exit — no fires, no writes, no error, a debug-level note (skip-on-contention is correct because ticks are idempotent). `TickResult.Held` reports the held-lock no-op and `TickResult.Servers` the count of live servers actually swept, so an invoker can stay silent on contention and summarize otherwise.
- **Live-server filter first**: the tick derives its server set from `tmux.ListServers` (the live-socket-probed enumeration — the same filter `rk mux reap` and the managed-conf sweep rely on) and skips entry files whose server is not in that set entirely (`server-not-live` diagnostic, ZERO tmux commands) — a tmux command against a dead socket resurrects it, so the evaluator can never be a zombie-server factory.
- **TMUX scrub**: the package constructs no `exec` calls of its own; every tmux touch routes through the `TmuxSeam` interface whose production implementation delegates to `internal/tmux` (which scrubs `TMUX`/`TMUX_PANE` from the subprocess env and targets explicit `-L <server>`). The respawn argv exec inherits the daemon's own (already TMUX-scrubbed) process environment.
- **Deliverer seam**: `Deliverer` (`Deliver(ctx, Fire) Outcome`) is supplied by the caller; production wires the `EngineDeliverer` (below) and tests use fakes — the interface substitutes the implementation without touching evaluation. `Tick` appends one log line per non-held delivery outcome and persists the next wake cursor after evaluation.
- **if_absent dispositions**: for each `EvalResult.Absent` fire, `Tick` applies the entry's `if_absent` policy per the disposition table:

  | Target kind | `respawn` argv present | Disposition |
  |---|---|---|
  | role / session | yes | run the argv via `RunRespawn` under a `DefaultRespawnTimeout` (90s) derived context, `os.UserHomeDir()` as the exec's cwd (the daemon has no project cwd — the operator window's own directory is the launcher's derivation, § Caller-Supplied Respawn), `{server}` substituted with the fire's stamped server name (`RespawnArgv`) → `respawned` on exit 0 (`respawned (kickoff undelivered: <reason>)` when the captured output tail carries the launcher's `kickoff: undelivered reason=<r>` stderr line — `respawnSuccessOutcome`, still `respawned`-prefixed so orphan GC and rate-cap classification hold) / `respawn-failed: <detail>` otherwise (error + ≤200-byte output tail). NO delivery that tick — the payload lands on the next resolved fire |
  | session | no | `SessionRespawner` (closed-ring plain resume — § Session-Target Respawn); a nil seam degrades to notify as below |
  | role | no | notify-degrade with a `respawn-uncommanded` diagnostic ("if_absent respawn has no respawn command; degraded to notify") |
  | pane | any | notify-degrade (a dead pane id never re-resolves, so a respawn can never land its payload) |

  The other policies: `skip` (or empty) appends `skipped-absent`; `notify` (and every respawn degrade) calls the `Deps.Notifier` seam (production default `internal/push.Notify`, fail-silent — a notify error is a diagnostic, never a tick error) with title `cron: <entry name>`, body naming the server, and a deep-link URL (§ Notify Deep-Links), then appends `notified-absent`. Every logged disposition advances the schedule anchor, so a dead target produces one disposition per due period, not one per tick; both respawn outcomes count toward the absent-fire rate cap (entry-ID keyed).
- **Orphan GC pass**: after the dispositions, still under the same flock and live-server scope, `tickServer` expires continuously-orphaned unpinned session/pane entries per § Orphan TTL GC — removal rides the existing `Remove` mutation plus one `expired-orphan` audit line, never a push notification.

## Notify Deep-Links

Cron's fail-silent notify calls carry a same-origin deep-link to the quake terminal's `Cron Log` tab (`internal/cron/push_url.go`). `PushURL(server, windowID)` — exported, pure — builds `/{server}/{N}?tab=log` where the URL segment is the window id's numeric part (the tmux `@N` sans `@`), both segments path-escaped (the `waitingPushURL` shape); an empty windowID yields `""`. For one release the router's `validateTerminalSearch` also accepts the `activity` token and normalizes it to `log`, so deep-links carrying `tab=activity` (the token already-sent push notifications carry) keep landing on `Cron Log` (hcon). `operatorPushURL(ctx, server, seam)` — unexported — resolves the server's `role: operator` carrier window through the tick's `TmuxSeam` (the same `@rk_win_role` radio semantics `GatherFacts` uses — no new tmux surface) and returns its deep-link; the tick orchestrator's `if_absent: notify` call site passes it. The session respawner's escalate path re-probes `list-windows` at notify time — the operator window may have been created by the failed respawn itself (the delivery-wall case), exactly when the link matters most — and passes the pure `PushURL` result through. The fail-silent contract is absolute: an unresolvable operator window yields `""` and the notify fires URL-less — the tick never errors, blocks, or retries over a missing deep link. The `tab=log` param and the tab it selects are documented in [ui/cron-console-tabs](/run-kit/ui/cron-console-tabs.md).

## Daemon Ticker Invoker

`Ticker` (`ticker.go`, `NewTicker(deps).Start(ctx)`) is the daemon invoker: a goroutine invoking `cron.Tick` every `DefaultTickInterval` (30s — well under the operator backoff schedule's 3m `min` rung, so the poll bounds fire lateness to a fraction of the smallest rung; `wake_on` is approximated by the same poll). It is isolated from the serving path: no shared locks (the only serialization is `Tick`'s own non-blocking flock), each iteration wrapped in panic recovery (a panicking tick logs at Error and skips the iteration — it never kills the daemon) and bounded by a per-tick context timeout (`tickTimeout`). A `cron_ticker` settings key (bool, default true, live — see [configuration](/run-kit/configuration.md)) gates every iteration via a fresh `settings.Load()`: off ⇒ the iteration skips with a debug note (no tmux or disk work), on ⇒ ticking resumes with no daemon restart. `serve.go` starts the ticker after the snapshotter block, bound to the serve context, with the snapshotter's best-effort posture: a `cron.DefaultDir()` resolution failure disables ticking with a single `slog.Warn`, never blocking serving. `rk doctor` renders an always-OK informational "cron ticker" row (the ephemeral/tmux-config posture) reporting the setting state and state-dir resolvability — doctor runs in a separate process, so it reports config + disk facts, not live goroutine state.

## EngineDeliverer

`EngineDeliverer` (`deliver.go`, `NewEngineDeliverer()`) is the production `Deliverer`: it sends through `internal/inject` — the one injection engine, never raw `send-keys` — via a dedicated `inject.Engine` on the per-client buffer `rk-cron-send` (the CLI/daemon precedent is `rk-agent-send`; see [agent-send](/run-kit/agent-send.md)) and a package-private `inject.Tmux` adapter (`cronInjectTmux`, mirroring `riffInjectTmux` since cron cannot import cmd or riff) delegating to `internal/tmux` context-bound primitives with the fire's stamped `Server`. Delivery inherits the pane-mode guard, `inject.Sanitize`, the novelty echo probe, and submit verification.

- `deliver: immediate` (or empty) sends now with submit; a send error yields outcome `failed: <detail>` (logged).
- `deliver: when-idle` reads the target pane's agent state at delivery time (`tmux.PaneAgentState` — fresher than the eval-time facts) and holds on `active | waiting` (the operator request-lane busy predicate): outcome `held-busy` with `Outcome.Held = true` — never log-appended (§ Delivery Log), retried by next-tick re-evaluation. `idle` and unknown (`""`) states deliver. There is no in-tick waiting — ticks stay short-lived — and the hold is bounded by `DefaultHoldWindow`: past 2h from the fire's `DueAt` the outcome is `held-expired` with `Held` unset — a logged disposition that advances the anchor and drops the fire (the next due period fires normally), never a force-delivery into a busy pane. Wake-reason and catch-up late fires carry `DueAt = now`, so they never expire. A held `wake`-reason fire's edge is consumed (`Evaluate` computes `NextCursor` before delivery); the payload lands on the entry's next schedule-due or next edge.
- `deliver: skip-if-busy` reads the same state once at due time and, on `active | waiting`, DROPS the fire: outcome `skipped-busy: <state>` with `Held` deliberately unset — logged, so the anchor advances to this due point and the next attempt is the next due period (an unlogged skip would re-fire every 30 s poll and degenerate into `when-idle`). No hold bound applies — `DefaultHoldWindow` is never consulted for this policy; the `cron`-kind due window stays `DefaultCronGrace`. `idle` and unknown (`""`) states deliver (an unknown-state pane carries no gateable signal); a state-read error is `failed: agent-state read: …` exactly as for `when-idle`. A `skipped-busy` line is the entry's newest own line for every derivation that reads one — the `every`/`cron` anchor, the `wake_on` debounce, and the backoff attribution test (moot on a flat ladder: all gaps are equal). (9aup)

## Caller-Supplied Respawn

How to bring a target back is the entry creator's knowledge, not the clock's: with `if_absent: respawn` and a non-empty `respawn: [argv...]`, the tick runs the argv as an argument slice via `exec.CommandContext` — NEVER a shell string (Constitution I) — through the `Deps.RunRespawn` exec seam (`RunRespawnFunc func(ctx, argv, dir) ([]byte, error)`; nil selects the production `runRespawnExec`, which sets `cmd.Dir` and captures combined output). `RespawnArgv(e, server)` is the pure render step: the exact substring `{server}` in ANY element is replaced with the fire's stamped server name (`strings.ReplaceAll` on a copy — the entry is never mutated), so the file reads plainly (`respawn: ["rk", "operator", "-L", "{server}"]`). Runtime: `DefaultRespawnTimeout` (90s named constant — it must exceed `rk operator -L`'s server-mode kickoff delivery bound of `operatorServerDeliverDeadline` 60s + `operatorCmdTimeout` 10s plus agent boot, the `cronSessionSpawnTimeout` precedent), working directory the user's home (the daemon has no project cwd), environment the daemon's own (already TMUX/TMUX_PANE-scrubbed by `internal/tmux`'s init). Outcomes: exit 0 within the timeout ⇒ `respawned` — rendered `respawned (kickoff undelivered: <reason>)` by `respawnSuccessOutcome` when the combined output carries the launcher's `kickoff: undelivered reason=<r>` stderr line (the ≤200-byte tail folds it in for free), still `respawned`-prefixed for orphan/rate classification; non-zero exit, timeout, or exec error ⇒ `respawn-failed: <detail>` with the error and a ≤200-byte output tail folded in (`respawnDetail`, `…`-prefixed when truncated). **After a successful respawn there is NO delivery that tick** — a fresh session has no tick convention in context, so the payload lands on the next resolved fire; both outcomes append one log line, advance the anchor, and count toward the absent-fire rate cap (entry-ID keyed) as before. The respawn command owns its own idempotency (no defensive re-probe is implemented generically — `rk operator` is already a per-server singleton). The operator entry's argv presupposes `rk operator -L <server>` — the daemon-invocable form ([rk-riff](/run-kit/rk-riff.md) § Single-Quote Escaping and Task Injection): no `$TMUX` precondition, `-L`-addressed tmux calls, the window opened in the server's recorded operator launch directory (`@rk_srv_operator_root`) when still valid, else the home directory (the kickoff miss then surfaced rather than silent), a singleton hit reported with `Operator tab already present.` and no `switch-client` (upt2, t7vy, rrax).

## Session-Target Respawn

The production `Deps.SessionRespawner` is `rkCronRespawnSession(store)` (`cmd/rk/cron_respawn_session.go`), wired into the ticker's `cron.Deps` in `serve.go` with the same snapshot `Store` the snapshotter writes (only when the store resolved — otherwise the nil-seam notify degrade stands). It lives in `cmd/rk` because it needs `riff.Spawn`, `internal/snapshot`, and tmux calls `internal/cron` cannot import (the `cronInjectTmux` package-boundary rule). It is the DEFAULT for a `session`-target entry with `if_absent: respawn` and no `respawn` command — a caller-supplied argv overrides it — and pane targets and a nil seam keep the notify degrade byte-identical. Its flow for a fire on `fire.Server`:

1. **Ring scan** — `store.ListClosed(server)` (newest-first) for the first record whose `AgentRef == fire.Entry.Target.Session`; the newest matching capture carries the freshest cwd/options ([layout-snapshots](/run-kit/layout-snapshots.md) § Recently-closed window ring). No matching record, a list error, or an unwired store ⇒ escalate — the record is the only source of the resume cwd, and the clock never guesses.
2. **Gates mirror `handleClosedResume`** (`api/closed.go`) — the record's `AgentProvider` must be `claude` (`--resume` is Claude-only), the ref must pass the strict UUID gate (`cronSessionUUIDRe`, re-declared locally per the riff/api duplication precedent — the property must hold at the unescaped-launcher boundary, Constitution §I), and the record's first-pane cwd must be inside a git repo (`FindGitRoot`).
3. **Plain-resume spawn through the riff seam** — `riff.Spawn` with `Where: "checkout"`, `RepoRoot` = record cwd, `Session` = the record's owning session, `WindowNameBase` = the record's window name, `ResumeSessionRef` = ref, `ResumePlain: true` — `--resume <uuid>` WITHOUT `--fork-session` ([rk-riff](/run-kit/rk-riff.md) § Resume-Fork Launcher Seam), because the entry targets this session id and a fork's fresh id would orphan it forever.
4. **Postlude, both best-effort** — re-stamp the record's `@rk_win_*` set (`snapshot.WindowOptionOps(rec.Window)`) on the spawned window and drop the consumed ring record (`DeleteClosed`); either failure logs at Warn and never fails the respawn (the `handleClosedResume` postlude — the record's purpose is consumed).
5. **Readiness composite, then the payload** — `inject.DeliverWhenReady` on the dedicated `cronSessionRespawnBuffer` under the `operatorDeliverDeadline`-class bound (the `cronSessionRespawnDeliverFn` shape), delivering the entry's payload itself — resume restores the conversation's context, so no kickoff exists for arbitrary sessions. Any non-`ready` classification (`parked`/`narrow`/`gone`/timeout) or send error escalates fail-silently via the same `push.Notify` channel naming the entry and server (the `cronSessionRespawnNotifyFn` seam), and returns `respawn-failed: <detail>` with the `readiness:` vs `send:` phase prefix; walls are never auto-answered, and no keys are sent into an unclassified pane.

A gate failure creates nothing; a spawn that fails only at readiness/delivery leaves the resumed window in place (kill nothing, create nothing after the failed step) — the SessionStart hook re-stamps the resumed pane with the same session id, so the entry resolves again on later ticks. Every tmux touch is an argv-slice `exec.CommandContext` with a timeout, addressed at the fire's stamped server (`-L <slug>` via the `operatorServerPrefix` helper) under the daemon's TMUX/TMUX_PANE-scrubbed env — inherited by routing through the existing helpers, never new shell strings (Constitution §I).

## Orphan TTL GC

Session- and pane-target entries whose target is gone are not immortal (role targets never orphan — the radio re-resolves). The machinery lives in `internal/cron/orphan.go` plus the GC pass in `tickServer`:

- **Derived orphaned-since, never stored** — `OrphanedSince(log, entry)` walks the entry's delivery-log lines newest→oldest; the trailing run is every line up to the newest resolved-class line (outcome prefix `delivered`/`respawned` — evidence the target resolved). Absent-class and neutral lines (`skipped-absent`, `notified-absent`, `respawn-failed`, `rate-capped`, `failed: …`) never terminate the run. `rescheduled` lines (an edit's anchor reset) are dropped before the walk — neither resolution evidence nor absent-class, so they never start or end a run, and an entry whose ONLY own line is `rescheduled` derives 0, never the `created_by.at` fallback (the log holds history, just no unresolved evidence). Orphaned-since is the OLDEST line in the trailing run; an entry with no log lines at all falls back to `created_by.at`; an entry whose newest own line is resolved-class derives 0 ("not orphaned") — returning a resolved line's timestamp would let log trimming derive an OLDER age. The 512 KiB log-cap trim can only make the derived age younger, so expiry degrades later, never premature. `OrphanTTL` is the 7-day named constant; `OrphanExpiresAt(since, pinned)` = `since + OrphanTTL`, zero for pinned.
- **Expiry rule** — after the dispositions, under the same flock and live-server scope, an entry is removed via the existing `Remove` mutation with one `expired-orphan` log line (the audit trail — expiry is never silent, and a target dead 7d is not push-worthy news) when ALL hold: target kind `session` or `pane`; target unresolved in this tick's gathered facts; derived orphan age ≥ `OrphanTTL`; not `pinned`. `muted` does NOT exempt (facts are gathered for muted entries even though they never fire). **The respawned-this-tick guard**: an entry whose absent disposition this tick came back resolved-class (a successful respawn) is never expired this tick — the gathered facts and the GC's log view both predate the respawn, so without the guard GC would delete the entry right after reviving its agent.
- **Pre-disposition log view** — GC derives streaks from `gcLog`, the log as snapshotted right after `ReadLog` (before any disposition appends): a just-appended absent line would otherwise become a never-fired entry's only line, resetting its streak to now and defeating the `created_by.at` fallback. For entries with existing runs both views agree (the streak is the run's oldest timestamp).
- **Read-side surfacing (additive)** — `DeriveEntry` gains `OrphanedSince`/`ExpiresAt` (zero unless currently orphaned; `ExpiresAt` additionally zero for `pinned` and role entries), carried through `GET /api/cron` as `orphanedSince`/`expiresAt` (`omitempty`) and `rk cron list --json` as `orphaned_since`/`expires_at` (raw log-derived, no live-resolution gate — the list verb's zero-tmux invariant; the API remains the live-gated surface). No frontend change required.

## Circuit Breakers

- **Per-target rate cap**: before delivering a resolved fire (and before absent dispositions), `Tick` counts the trailing hour's log lines for the same target — keyed on the fire's pane ID for resolved fires, on the entry ID for absent fires (their lines carry no pane); the counted classes are `delivered`, `failed: …`, `notified-absent`, `respawned`, `respawn-failed: …` (`countsTowardRate`) — `missed`, `held-expired`, `skipped-busy` (a dropped fire, not a delivery attempt), and `rescheduled` (schedule history, not delivery) never count, and `held-busy` never appears in the log so it is inherently excluded — across all entries targeting it. At or past `DefaultTargetRatePerHour` (30, named constant) the fire is suppressed with outcome `rate-capped`. The trip is visible: the `rate-capped` line IS appended (anchor advancement self-throttles the storm; the log is the future UI's derivation source) AND surfaced at `slog.Warn` — the one cron diagnostic above debug alongside the orphan-GC audit.
- **Per-server entry cap**: `Add` refuses to add an entry past `MaxEntriesPerServer` (50, named constant) with an error naming the cap. Defensively, evaluation processes at most the first cap-many entries of a hand-edited larger file, skipping the excess with per-entry `entry-cap-exceeded` diagnostics.

## Fact Gathering & Target Resolution

`GatherFacts` resolves every entry's target on one live server in one enumeration pass (sessions → windows + panes; enumeration failures degrade to diagnostics): the server-scoped agent-state map (`ServerFacts.States`, pane id → state — the `wake_on` input, from which the evaluator renders each entry's own target-excluded fingerprint) comes from the enumerated panes' `@rk_pane_agent_state` values, and each resolved target pane's state + idle epoch (`tmux.PaneFactsCtx` — `StateEpoch` is the `backoff` anchor input) fills its `TargetFacts`. Resolution per target kind: `role` finds the window whose `@rk_win_role` equals the entry's role value — ANY value resolves, not just `operator` (the radio semantics — see [tmux-sessions](/run-kit/tmux-sessions.md); diagnostics read `no window carries role <role>` / `role window %s: %v`) — and resolves its agent pane via `tmux.ResolveAgentPane`, never a bare `-t _rk-operator`; `session` finds the live pane carrying the `@rk_pane_agent_session` id (see [agent-state](/run-kit/agent-state.md)); `pane` checks id validity plus liveness via `tmux.PaneExists`. A target that fails resolution surfaces the entry's due fires in `EvalResult.Absent` for the tick's `if_absent` dispositions (`target-unresolved` diagnostic, never an error).

## External Contracts

The fab operator state file at `$XDG_STATE_HOME/fab/operator/<fab-slug>.yaml` (same XDG resolution root; `FabOperatorStatePath`) is a **fab-owned schema read tolerantly, for DISPLAY only** — it feeds the watchlist join, the staleness projection, and the per-server tracked-items list the Operator Tasks tab renders, and is never read to decide whether a fire is emitted (upt2). rk's read surfaces each item's `id`, `kind`, `text`, `paused`, `done_at`, `added_at`, `updated_at`, and the `scope` block's `pane`/`repo`/`session`/`stage`/`agent`/`branch`/`refs`; every other key stays ignored. Its owned shape since fab-kit 2.25.0 (kit migration `2.24.9-to-2.25.0`) is one `tracked:` list of generic items — `{id, kind, probe, scope: {pane, repo, session, stage, agent, branch, stop_stage, spawned_by, merge_mode}, paused, done_at, …}` — beside `branch_map`, `tick_count`, `last_tick_at`, `last_full_at`; the binary converts a legacy file (`monitored`/`watches`/`autopilot`/`notes` sections) on its first read-modify-write and deletes those keys in the same atomic write, so both shapes never coexist in a binary-written file. Its read class matches the `.status.yaml` and `.fab-dispatch/` reads: unknown keys ignored, `last_tick_at` accepted as unix seconds (number or string) or an RFC3339/ISO-8601 timestamp, and an absent or unparseable file degrades to the empty watchlist, never an error. Cron writes nothing to it.

The `<fab-slug>` is a **cross-repo naming contract**: fab-kit owns the file and derives the slug from the server's tmux socket path — escape literal `-` as `--` FIRST, strip the leading `/`, replace every remaining `/` with `-`, empty ⇒ `default` (e.g. `/tmp/tmux-1001/runKit` → `tmp-tmux--1001-runKit`, file `tmp-tmux--1001-runKit.yaml`). rk mirrors the rule exactly, split into the query half `tmux.SocketPath(ctx, server)` (`display-message -p '#{socket_path}'` through the server-addressed raw-exec core, argv slice, `TmuxTimeout`-bounded — errors propagate; the caller owns the degradation policy) and the pure half `cron.FabOperatorSlug(socketPath)` (table-tested); `sessions.go` derives the file as `FabOperatorStatePath(FabOperatorSlug(SocketPath(server)))`, falling back to slug `default` when the query errors (matching fab) and never surfacing the failure. `FabOperatorStatePath` validates path-safety by construction (non-empty, no `/`, no NUL — every `/` was already replaced, so traversal is structurally impossible) rather than `ValidSlug`'s socket-name alphabet (a socket path may legally contain `.`). The rule is pinned in `docs/specs/cron.md` § Watchlist (upt2).

**`rk cron list --json` is a fab-kit read contract.** fab-kit's operator clock (`operator_clock.go`) runs `rk cron list --json` and reads the envelope's `result` array to find the operator-tick entry — the row whose `target` equals `role:operator`, name `operator tick` as the tiebreak — and reads `id`, `name`, `target`, `muted`, `muted_until` to drive `rk cron mute`; its derived-schedule reconcile compares the structured `schedule` (`kind`/`interval`/`min`/`max`) against what it intends before applying a change through `rk cron edit` (§ In-Place Edit), whose schedule flags are `add`'s and so write the same `kind`/`interval`/`min`/`max` vocabulary the list emits (`--idle-every <d>` lands as `{kind: backoff, min: d, max: d}`). Those keys and the `target` summary string are therefore cross-repo stable, as is the envelope nesting itself; `schedule_summary` is the one field with a declared removal (§ CLI) (r5ao) (260911-ehm2-cli-json-read-verbs). The `wake_on` shape (`{event, scope, debounce}`, `null` when unset) is part of the same contract; fab's seed passes the wake flags through `rk cron add … --wake-on agent-state-change … --pinned` and reads the block back on the same listing (§ Operator-Tick Entry Ownership) (ntde, pfo3).

## Requirements

### Requirement: Tolerant entry-file load
Loading a server's entry file SHALL ignore unknown keys (including the retired `anchor:` and `suppress_while:` keys), SHALL skip an invalid entry with a per-entry diagnostic without failing the file, SHALL treat an absent file as an empty entry set with no error, and SHALL treat a whole-file parse failure as an empty set plus a diagnostic — a corrupt file MUST never abort a tick. Mutation helpers MUST refuse to mutate a corrupt file and MUST write atomically.

#### Scenario: Mixed file loads the good, diagnoses the bad
- **GIVEN** an entry file with one valid entry, one entry with an unknown schedule kind, and a top-level unknown key
- **WHEN** loaded
- **THEN** the valid entry is returned, the invalid entry appears only in diagnostics, and no error is returned

### Requirement: Stateless deterministic evaluation
`Evaluate` SHALL hold no package-level mutable state and perform no I/O; two calls with equal inputs MUST return deep-equal results. An effectively-muted entry (flag or live lease) MUST skip with a `muted` diagnostic distinguishing the two forms (`entry is muted` / `entry is muted until <RFC3339>`).

### Requirement: Mute lease semantics and write rules
`Entry.EffectivelyMuted(now)` SHALL return `Muted || (MutedUntil > 0 && now.Unix() < MutedUntil)` and SHALL be the single muted rule across evaluator, API, and CLI list. `SetMuteLease` SHALL set `muted_until` AND clear `muted`; `SetMuted(true)` SHALL set `muted` AND clear `muted_until`; `SetMuted(false)` SHALL clear both; all three SHALL share the atomic read-modify-write and refuse a corrupt file. Lease expiry SHALL require no write and no wake — the next evaluation reads an expired lease as unmuted. `rk cron mute <id> --for <dur>` SHALL lease until now+dur (a positive Go duration; a usage error with `--off`), printing `muted <id> until <RFC3339 local>`; bare `mute` stays indefinite; `--off` clears both. (upt2) Under `--json` the three forms instead print exactly one envelope document: `result` `{id, muted: true, until}` on the lease form (`until` the same RFC3339 string the human line prints — present only there), `{id, muted: true}` on the bare form, `{id, muted: false}` on `--off`; a failing RunE gets its `{"ok":false}` envelope from `execute()`'s central writer. (260911-fr5t-cli-spawn-and-steer-receipts)

#### Scenario: Live lease suppresses, expired lease fires
- **GIVEN** an entry with `muted_until = now+60s` and a due schedule
- **WHEN** evaluated at `now`
- **THEN** no fire is emitted and the diagnostic reads `muted — entry is muted until …`
- **AND GIVEN** the same entry evaluated at `now+61s`, **THEN** the fire is emitted and no file write occurred

### Requirement: Backoff anchor-join
A `backoff` entry SHALL fire on the ladder `anchor + min·(2ⁿ − 1)` with per-gap cap `max` — `min == max` collapses it to a flat "every `min` of quiet" idle reminder — where the effective anchor is derived by `JoinAnchor` from the raw idle epoch joined against the entry's `ScheduleHistory` (own log lines strictly newer than the newest `rescheduled` line, so an edit restarts the ladder from the raw epoch instead of ingesting pre-edit deliveries as rungs): an epoch within `attributionWindow` of the latest own delivery continues the trailing own-delivery streak; a non-attributed epoch resets to rung 0 with the epoch as anchor. The schema carries no anchor field — the ladder is keyed on the target pane's idle epoch by definition. The streak walk SHALL be seeded from the newest own-delivery gap as the largest rung whose ladder gap is ≤ gap + `seedSkew` (one `DefaultTickInterval`), so a clean own-delivery streak of any length reconstructs to its ladder rung; a gap too small for any rung SHALL seed a single-delivery streak. An implementation deriving the ladder from the raw epoch alone MUST fail the package's tests, and so MUST one whose seed subtracts a tolerance from the gap. (9aup)

#### Scenario: Attributed epoch continues the ladder
- **GIVEN** `min: 60s, max: 30m`, deliveries at T+1m and T+3m, and a raw idle epoch 5s after the T+3m delivery
- **WHEN** evaluated
- **THEN** the next fire is T+7m (rung 3), not T+3m+1m; **AND GIVEN** a raw epoch 10m after the T+3m delivery, **THEN** the rung resets and the next fire is epoch+60s

#### Scenario: A three-delivery streak climbs, and an alternation escapes
- **GIVEN** `min: 60s, max: 30m` and deliveries at T+1m, T+3m, T+7m with an attributed epoch
- **WHEN** evaluated
- **THEN** the ladder is anchor T, rung 3, next fire T+15m — not rung 2 / T+9m
- **AND GIVEN** the delivery history `0, 2m, 6m, 8m, 12m, 14m` replayed forward, **THEN** successive gaps read 4m, 8m, 16m, 30m, 30m, 30m, … — the cap holds
- **AND GIVEN** deliveries at +1, +3, +7, +15, +31, +61, +91m (the last two gaps capped), **THEN** the ladder is anchor T, rung 7, next fire +121m — not rung 6 / +93m

### Requirement: Cron-kind due math with bounded windows
A `cron`-kind entry SHALL fire when the latest occurrence in (anchor, now] — the anchor per the `everyAnchor` rule, occurrences via `ParseStandard` + `Schedule.Next` in the daemon's local time — lies within `DefaultCronGrace` (2m) for `immediate` and `skip-if-busy` entries or `DefaultHoldWindow` (2h) for `when-idle` entries, carrying `DueAt` = the occurrence. With `catch_up: once` the latest occurrence SHALL be due with no lateness bound — at most one late fire per gap, carrying `DueAt = now` (exempt from the hold bound); an on-time occurrence carries `DueAt` = the occurrence even with catch-up set. A stale occurrence without catch-up SHALL surface in `EvalResult.Missed`, and the tick SHALL append exactly one `missed` line per gap — mute-gated (a muted entry suppresses it silently), target-independent (no `if_absent` disposition), advancing the anchor. Occurrence walks MUST be bounded — a minute-granularity binary search over the existence probe `Next(t) ≤ now`, never an unbounded scan from an ancient anchor. Every `Fire` SHALL carry `DueAt` (`every`: anchor+interval; `backoff`: ladder next-fire; `cron`: the occurrence; wake and catch-up late fires: `now`).

#### Scenario: On-time fire, gap miss, catch-up
- **GIVEN** `{kind: cron, expr: "*/5 * * * *"}`, last own log line at 10:00:30, now 10:05:20
- **WHEN** evaluated
- **THEN** a schedule fire is emitted with `DueAt` 10:05:00 (within the 2m grace)
- **AND GIVEN** now 10:09:00 with no log line after 10:00:30, **THEN** no fire is emitted and exactly one `missed` line is appended for the gap — subsequent ticks append nothing until the next occurrence
- **AND GIVEN** the same entry with `catch_up: once`, **THEN** one late fire is emitted with `DueAt = now`, and after its log line the next due is the next future occurrence

### Requirement: Wake-on delta with cold-start degradation
A `wake_on: agent-state-change` entry SHALL compare a per-entry fingerprint that excludes its own resolved target pane (the full fingerprint when the target is unresolved), SHALL fire only when the diff contains an actionable transition (a pane moving to `waiting` or `idle`, a pane vanishing, or any state other than `active`), SHALL advance its cursor without firing on a diff of only `→ active` transitions, SHALL hold (not fire, previous observation kept) an actionable edge while `now − lastOwnDelivery < debounce`, and MUST treat an absent/corrupt cursor as a cold start — no edge fire that tick, cursor rewritten, never an error.

#### Scenario: Own target flip is not an edge
- **GIVEN** an entry whose target resolved to `%683`, cursor observation `%685=active`, states `{%683: active, %685: active}`
- **WHEN** evaluated
- **THEN** no fire, no diagnostic, the cursor is unchanged

#### Scenario: Worker completion fires, worker start does not
- **GIVEN** cursor observation `%685=active`
- **WHEN** `%685` reads `idle` and the entry's newest own delivery is ≥ `debounce` ago
- **THEN** one `wake` fire and the cursor advances
- **AND GIVEN** cursor observation `%685=idle` **WHEN** `%685` reads `active` **THEN** no fire, `wake-ignored-transition`, cursor advances — even inside the hold window

#### Scenario: Hold after own delivery
- **GIVEN** `debounce: 60s`, the entry's newest own log line at T, an actionable edge
- **WHEN** evaluated at T+20s
- **THEN** no fire, `wake-debounced`, the old observation is kept
- **AND WHEN** evaluated at T+70s **THEN** the edge fires

### Requirement: Live-server filter before any socket touch
The tick SHALL derive its server set from the live-socket-probed enumeration and MUST NOT issue any tmux command for a server outside that set; entry files for dead servers are skipped with a diagnostic only. The package MUST NOT construct its own tmux `exec` calls — all tmux interaction routes through `internal/tmux` behind the `TmuxSeam` interface.

#### Scenario: Dead server's entry file is never probed
- **GIVEN** entry files for servers `live1` and `dead1` where only `live1` enumerates
- **WHEN** a tick runs
- **THEN** facts are gathered and fires evaluated for `live1` only, and zero tmux commands target `dead1`

### Requirement: Idempotent, serialized tick
A tick SHALL take the non-blocking flock on `cron/.lock` before evaluating; when the lock is held elsewhere it MUST exit cleanly and quietly — no fires, no log writes, no error. A duplicate fire after a restart is acceptable; a missed suppression is not.

### Requirement: Delivery log as derivation source
Each non-held delivery outcome SHALL append exactly one JSON line (`{ts, entry, target, reason, outcome}`); a held outcome MUST append nothing (a `delivery-held` diagnostic is recorded instead) so anchors and the backoff streak join are unchanged by holds and the fire is due again next tick — with the deliberate counter-example that a `skip-if-busy` drop logs `skipped-busy: <state>` precisely so the anchor advances to the skipped due point; a stale cron occurrence SHALL append exactly one `missed` line per gap; a `when-idle` hold past `DefaultHoldWindow` SHALL append `held-expired`; an edit that changes schedule or deliver SHALL append exactly one `rescheduled` line (`Reason: edit`, no target — § In-Place Edit); the parser SHALL expose per-entry last-delivery (`LastDelivery`, outcome-agnostic) and the trailing own-delivery streak while skipping unparseable lines, plus `ScheduleHistory` (own lines strictly newer than the newest `rescheduled` line, boundary excluded — the `JoinAnchor` view); an append past the 512 KiB cap SHALL atomically trim to the newest tail cut at a line boundary.

### Requirement: Daemon ticker invoker
A `Ticker` SHALL invoke `Tick` at `DefaultTickInterval` (30s), bound to the serve context, with panic recovery per iteration (a panic logs and skips the iteration) and a per-tick context timeout. Each iteration SHALL consult the `cron_ticker` setting (bool, default true, live) — when off, the iteration skips without tmux or disk work; when re-enabled, ticking resumes without a restart. Startup MUST follow the snapshotter's best-effort posture: a state-dir resolution failure disables ticking with a Warn, never blocking serving.

### Requirement: Injection-engine delivery with when-idle holds and skip-if-busy drops
Delivery SHALL go through `internal/inject` on the dedicated buffer `rk-cron-send` — never raw `send-keys`. `deliver: when-idle` SHALL read the target pane's agent state at delivery time and hold (outcome `held-busy`, `Held: true`) on `active | waiting`; `idle` and unknown states deliver. The hold SHALL be bounded by `DefaultHoldWindow` (2h from `Fire.DueAt`): past it the outcome SHALL be `held-expired` (`Held` unset — logged, anchor-advancing, the fire dropped), never a force-delivery into a busy pane; catch-up late fires (`DueAt = now`) are exempt by construction. `deliver: skip-if-busy` SHALL read the same state once at due time and, on `active | waiting`, return `skipped-busy` with `Held` unset — a LOGGED, anchor-advancing drop with no hold bound (`DefaultHoldWindow` is never consulted; the `cron`-kind due window stays `DefaultCronGrace`); a state-read error SHALL be `failed: agent-state read: …` on both busy-checking policies. A send failure SHALL log `failed: <detail>`. (9aup)

### Requirement: if_absent dispositions
Due-but-target-unresolved fires SHALL surface in `EvalResult.Absent` (emitted exactly like resolved fires, with an empty pane). `Tick` SHALL apply `skip` (log `skipped-absent`), `notify` (fail-silent notifier + `notified-absent`), and `respawn` per the disposition table: role/session target with a `respawn` argv ⇒ run it via the `RunRespawn` exec seam; session target without an argv ⇒ the `SessionRespawner` seam (nil seam degrades to notify); role target without an argv ⇒ notify-degrade with a `respawn-uncommanded` diagnostic; pane target ⇒ notify-degrade always. Logged dispositions SHALL advance the anchor — one disposition per due period, not per tick.

### Requirement: Caller-supplied respawn argv
The `respawn` argv SHALL execute as an argument slice via `exec.CommandContext` (never a shell string) through the `Deps.RunRespawn` seam (nil ⇒ the production default), under `DefaultRespawnTimeout` (90s), with the user's home directory as the exec's cwd (the daemon has no project cwd; where the respawned operator WINDOW opens is `rk operator -L`'s own derivation — the recorded `@rk_srv_operator_root` launch directory when still valid, home as its fallback) and the daemon's TMUX-scrubbed environment; `{server}` in any element SHALL be substituted with the fire's stamped server name (`RespawnArgv`, copy-not-mutate). Exit 0 ⇒ `respawned` — or `respawned (kickoff undelivered: <reason>)` when the output tail carries the launcher's `kickoff: undelivered` line, still `respawned`-prefixed for orphan/rate classification — with NO delivery that tick; anything else ⇒ `respawn-failed: <detail>` with the error and a ≤200-byte output tail. Validation SHALL reject a present-but-empty argv and an empty `argv[0]`; `ValidateRespawnIntent` SHALL require the argv at add time for role/pane targets with `if_absent: respawn` (session targets keep the resume default) — enforced by `cron.Add` (the API's 400) and the CLI (a usage error), deliberately NOT in `validate()` so an existing on-disk entry in that state keeps loading and degrades to notify at fire time. The respawn command owns its own idempotency. (upt2)

#### Scenario: `{server}` substitution and failure detail
- **GIVEN** an absent role fire whose entry has `respawn: ["rk","operator","-L","{server}"]` on server `runKit`
- **WHEN** the tick disposes it
- **THEN** the exec seam receives `["rk","operator","-L","runKit"]`, the outcome is `respawned`, and no delivery is attempted
- **AND GIVEN** the command exits 1 printing `boom`, **THEN** the outcome is `respawn-failed: …boom…` and the anchor still advances

### Requirement: Session-target respawn mechanics
The production SessionRespawner SHALL source the resume from the server's recently-closed ring — the first (newest) record whose `AgentRef` matches the target session ref — and SHALL escalate (one fail-silent notify naming entry + server, outcome `respawn-failed`, no window created) on no matching record, a non-`claude` provider, a ref failing the strict UUID gate, or a record cwd outside a git repo. The spawn SHALL go through the riff seam in checkout mode at the record cwd with plain resume (`ResumePlain` — `--resume <uuid>`, never `--fork-session`); on success it SHALL re-stamp the record's `@rk_win_*` options and drop the consumed ring record (both best-effort, neither failing the respawn). Delivery SHALL run through `inject.DeliverWhenReady` and SHALL deliver the entry's payload itself (no kickoff); any non-`ready` classification or send error SHALL escalate with a `readiness:`/`send:` phase-prefixed `respawn-failed`, and no keys MUST reach an unclassified pane. The seam is consulted only for a session target with `if_absent: respawn` and no `respawn` command — the default a caller-supplied argv overrides.

### Requirement: rk holds no operator-tick seed
`internal/cron` SHALL expose no role-keyed seed helper and `rk operator` SHALL NOT read or write the cron state directory; the operator-tick entry is created and tuned by its consumer through `rk cron add`/`edit` (§ Operator-Tick Entry Ownership). rk MUST NOT migrate or rewrite an existing entry outside the mutation verbs. (pfo3)

#### Scenario: Launcher on an empty server
- **GIVEN** a server whose cron state dir has no `role:operator` entry
- **WHEN** `rk operator` (or `rk operator -L <server>`) opens the operator window
- **THEN** the state dir is unchanged and no seed warning appears on stderr
- **AND** the entry appears on fab's next reconcile (`fab operator clock sync` at `/fab-operator` Init)

### Requirement: Any-role targets
A role target SHALL accept ANY `@rk_win_role` value: resolution SHALL scan for the window whose `Role` equals the entry's role (diagnostics `no window carries role <role>` / `role window %s: %v`), `--role` SHALL accept any non-empty whitespace-free value, and the auto-capture ladder SHALL target `{kind: role, role: <value>}` whenever the caller window carries any non-empty role. `RoleOperator` SHALL remain only where a call site names the operator role literally (the operator-window lookup in `push_url.go`). (upt2, pfo3)

#### Scenario: Non-operator role resolves
- **GIVEN** a window stamped `@rk_win_role=reviewer` and an entry `target: {kind: role, role: reviewer}`
- **WHEN** facts are gathered
- **THEN** the target resolves to that window's agent pane
- **AND GIVEN** `rk cron add x --every 1h --role "a b"`, **THEN** a usage error and no file write

### Requirement: Fab operator file slug mirrors fab (display only)
The watchlist/staleness read SHALL derive the fab operator state file's name as `FabOperatorStatePath(FabOperatorSlug(SocketPath(server)))`: `tmux.SocketPath` queries `#{socket_path}` (argv slice, bounded); the pure `cron.FabOperatorSlug` SHALL mirror fab's rule exactly — escape `-`→`--` FIRST, strip the leading `/`, replace `/`→`-`, empty ⇒ `default` — and a query failure SHALL degrade to slug `default` with no error surfaced. `FabOperatorStatePath` SHALL validate by construction (non-empty, no `/`, no NUL). The rule is a cross-repo contract pinned in `docs/specs/cron.md` § Watchlist: fab-kit owns the file; rk mirrors the slug. rk MUST NOT read the file for control (no fire decision depends on it). (upt2)

#### Scenario: Socket-path slug table
- **GIVEN** socket path `/tmp/tmux-1001/runKit`
- **WHEN** `FabOperatorSlug` runs
- **THEN** it returns `tmp-tmux--1001-runKit`; and `/tmp/tmux/1000/default` → `tmp-tmux-1000-default`; `""` → `default`
- **AND GIVEN** a fab state file at `fab/operator/tmp-tmux--1001-runKit.yaml` with a `tracked:` item whose `scope.pane` is `%5`, **WHEN** `FetchSessions` runs against `runKit`, **THEN** the window holding `%5` reports `monitored: true` and `operatorLastTickAt` is populated

### Requirement: Orphan TTL expiry
`tickServer` SHALL expire — remove via the existing `Remove` mutation plus one `expired-orphan` log line, with no push notification — any entry for which ALL hold: target kind `session`/`pane` (role entries are never candidates); target unresolved in this tick's gathered facts; derived orphaned-since ≥ `OrphanTTL` (7d); not `pinned` (`muted` does NOT exempt). Orphaned-since MUST derive from the entry's trailing absent-run of delivery-log lines (resolved-class `delivered*`/`respawned*` prefixes terminate the run; `rescheduled` lines are skipped before the walk — they never start or end a run and never trigger the `created_by.at` fallback; `created_by.at` is the fallback for a line-less entry) and MUST NOT be persisted in the entry file; the GC pass SHALL derive from the pre-disposition log snapshot and SHALL NOT expire an entry whose disposition this tick was resolved-class (a successful respawn).

#### Scenario: Orphan expiry truth table
- **GIVEN** an unpinned `session` entry unresolved for 8 days
- **WHEN** the tick runs
- **THEN** the entry is gone from the intent file and its newest log line is `expired-orphan`
- **AND GIVEN** the same entry but `pinned: true`, **THEN** it survives every tick
- **AND GIVEN** a `muted`, unpinned entry unresolved ≥ 7d, **THEN** it expires
- **AND GIVEN** an entry whose respawn succeeded this tick, **THEN** it is not expired regardless of history

### Requirement: Circuit breakers
Before delivery, `Tick` SHALL suppress a fire at or past `DefaultTargetRatePerHour` (30 trailing-hour log lines keyed on pane ID, or entry ID for absent fires) with a logged `rate-capped` outcome AND a `slog.Warn`. `Add` SHALL refuse past `MaxEntriesPerServer` (50) with a named-cap error, and evaluation SHALL process only the first cap-many entries of an oversized file with `entry-cap-exceeded` diagnostics.

### Requirement: CLI server resolution and slug validation
The entry-file-scoped verbs (`add`, `edit`, `list`, `rm`, `mute`, `pin`) SHALL resolve their tmux server as: explicit `-L/--server` wins, else the caller's own server from the original `$TMUX` socket basename, else `default`; the resolved name MUST pass `cron.ValidSlug` before any path is built. `tick` MUST reject an explicitly-set `-L` with a usage error — it sweeps every live server by design.

#### Scenario: Caller-socket resolution, tick refuses `-L`
- **GIVEN** a shell inside a tmux pane on socket `/tmp/tmux-1001/work,12,0`
- **WHEN** `rk cron list` runs with no `-L`
- **THEN** the entry file for slug `work` is read
- **AND** `rk cron tick -L work` exits non-zero with a usage error naming the flag

### Requirement: `add` schedule-flag and write contract
`rk cron add <prompt>` SHALL require exactly one schedule flag — `--every` (a positive Go duration), `--idle-every` (a positive Go duration, sugar for a flat backoff ladder: the entry file records `{kind: backoff, min: <dur>, max: <dur>}` — no schema field, no evaluator change, and renderers keep showing the on-disk truth `backoff 3m→3m`), bare `--backoff` (`min 60s`/`max 30m` defaults; `--min`/`--max` without `--backoff` are a usage error, including alongside `--idle-every`), or `--cron` (a 5-field expression in the daemon's local time, validated at add time via `ParseStandard` — a non-parsing expression fails the add, the field-count pre-check firing first as a friendlier usage error; `--catch-up once`, a usage error without `--cron` or with any other value, opts into one late fire after a gap). The usage error names all four flags (`exactly one schedule flag is required: --every, --idle-every, --backoff, or --cron`), and the parser (`cronScheduleFromFlags` over `cronScheduleFlags`) is shared with `edit`. `--deliver`/`--if-absent` values MUST be validated against the schema's closed sets at parse time, and every write MUST go through `cron.Add`. Success prints the assigned id and a one-line entry summary on stdout — the schedule summary rendering the expression with any catch-up (`cron <expr> (catch-up once)`). The `add` and parent `cron` help SHALL state that the payload is prompt text typed into the target agent's chat (via the injection engine, submitted with Enter), never run as a command; the `--idle-every` help SHALL contrast it with `--every` (the count restarts on genuine activity; the clock's own deliveries never restart it). (9aup)

#### Scenario: Mutual exclusion and enum validation
- **GIVEN** `rk cron add "check PRs" --every 1h --backoff`
- **WHEN** parsed
- **THEN** the command exits non-zero with a mutual-exclusion usage error
- **AND GIVEN** `--deliver sometimes`, **THEN** the command exits non-zero naming the valid values and the entry file is untouched

### Requirement: Creator auto-capture and default target
Inside a tmux pane, `add` SHALL store `created_by: {pane: $TMUX_PANE, at: now}`, filling `session` with the caller pane's parsed `@rk_pane_agent_session` ref whenever one is stamped (regardless of the selected target kind), and SHALL default the target down the role → session → pane ladder: `role:<value>` when the caller's window carries any non-empty `@rk_win_role`, else `session:<ref>` when the caller pane carries a parseable session ref, else `pane:$TMUX_PANE`; a failed option read MUST degrade to the next rung, never abort. Explicit `--role <role>` / `--session <ref>` / `--pane %N` (the three mutually exclusive, each validated at parse time — the session ref against `tmux.ValidAgentSessionRef`, the role non-empty and whitespace-free) override auto-capture; outside tmux (`$TMUX_PANE` unset) an explicit target flag is REQUIRED — the command MUST NOT guess a target.

#### Scenario: Role window, agent pane, plain pane, outside tmux
- **GIVEN** an agent pane `%12` in a window with no role whose `@rk_pane_agent_session` carries `claude:4fe2…`, on server `work`
- **WHEN** `rk cron add "tick me" --every 5m` runs
- **THEN** the stored entry has `target: {kind: session, session: 4fe2…}` and `created_by: {session: 4fe2…, pane: "%12", at: <now>}`
- **AND GIVEN** a plain pane (no session ref), **THEN** the entry targets `{kind: pane, pane: "%12"}` and `created_by.session` stays empty
- **AND GIVEN** the same command from the window carrying `@rk_win_role=operator`, **THEN** the target is `{kind: role, role: operator}` (with `created_by.session` still filled when the pane carries a ref)
- **AND GIVEN** `$TMUX_PANE` unset and no target flag, **THEN** the command exits non-zero telling the caller to pass `--role`, `--session`, or `--pane`

### Requirement: `list` derives from disk only
`rk cron list` SHALL read only the entry file and the delivery log — zero tmux commands — rendering one row per entry (id, name, schedule summary, target, deliver, flags, last-fired) or, under `--json`, the same records nested under `result` in the standard rk envelope on stdout (`{"ok":true,"result":[…]}` on success, `{"ok":false,"error":{"code","message"}}` on failure with `ok` mirroring the exit code — the convention in [architecture/cli](/run-kit/architecture/cli.md)). FLAGS SHALL render `muted(<remaining>)` for a live lease, `muted` for the indefinite flag, and `pinned`; `--json` SHALL report the effective `muted` and carry `muted_until` (omitempty, live leases only). Under `--json`, `schedule` SHALL be an object `{kind, interval?, min?, max?, expr?, catch_up?}` (`kind` always present, parameters `omitempty`, durations as `time.Duration.String()`); `wake_on` SHALL be an object `{event, scope?, debounce?}` or JSON `null`, never omitted; `if_absent` SHALL be the stored string verbatim (`""` when unset); `respawn` SHALL be the stored argv verbatim (`[]` when unset, never `null`); and `schedule_summary` SHALL carry the table's rendering for one release. An absent or empty file yields an empty listing with exit 0; corrupt entries surface as stderr diagnostics without failing the listing.

#### Scenario: Each schedule kind carries only its own parameters
- **GIVEN** entries `{kind: every, interval: 1h}`, `{kind: backoff, min: 60s, max: 30m}` with `wake_on: {event: agent-state-change, scope: server, debounce: 2m}` and `respawn: ["rk", "operator", "-L", "{server}"]`, and `{kind: cron, expr: "0 9 * * *", catch_up: once}` with no `wake_on`
- **WHEN** `rk cron list --json` runs
- **THEN** the records under the envelope's `result` carry schedules exactly `{"kind":"every","interval":"1h0m0s"}`, `{"kind":"backoff","min":"1m0s","max":"30m0s"}`, and `{"kind":"cron","expr":"0 9 * * *","catch_up":"once"}`
- **AND** the backoff record's `wake_on` is `{"event":"agent-state-change","scope":"server","debounce":"2m0s"}` and its `respawn` is the four-element argv with `{server}` intact, while the other two records carry `"wake_on": null` and `"respawn": []`

### Requirement: Single-entry mutation verbs
`rk cron rm <id>` SHALL remove via `cron.Remove`; `mute <id> [--for <dur>] [--off]` SHALL set the indefinite flag via `cron.SetMuted`, lease via `cron.SetMuteLease(now+dur)`, and unset (`--off`) both via `cron.SetMuted(false)`; `pin <id> [--off]` SHALL set/unset via `cron.SetPinned`. An unknown id MUST exit non-zero with `no entry <id>` on stderr; each success prints a one-line confirmation on stdout (`muted <id> until <RFC3339 local>` for a lease, `muted <id>` / `unmuted <id>` for the flag).

### Requirement: `edit` in-place schedule/policy replacement
`rk cron edit <id>` SHALL replace the fields its flags name and keep the rest: the schedule flags are `add`'s four-way-exclusive set via the shared `cronScheduleFromFlags` parser (zero schedule flags keeps the stored schedule; `--min`/`--max` without `--backoff` is a usage error even when the stored schedule is a backoff), `--deliver`/`--if-absent` are validated with the same enum helper as `add`, `--respawn` replaces the whole argv, `--wake-on <event>` replaces the whole `wake_on` block (the `server`/`60s` defaults fill an omitted knob; `none`/`off` clears it), and `--if-absent` set to a non-`respawn` value clears `respawn`. A bare `edit <id>` MUST fail with the usage error `nothing to edit — pass a schedule flag, --deliver, --name, --if-absent, --respawn, or --wake-on` (exit 2); target and creator are immutable (`--role`/`--session`/`--pane` are not defined and fail as unknown flags, exit 2; the help states the immutability rule). The write SHALL go through `cron.Edit` — the tick-flock hold (contention past the 2 s retry budget ⇒ `cron tick in progress — retry`, exit 1), the validated merge via `cron.Update` (identity fields `ID`/`Target`/`CreatedBy`/`Muted`/`MutedUntil`/`Pinned` byte-for-byte untouched), and exactly one `rescheduled` log line (`Reason: edit`, no target) only when the merged schedule or deliver differs from the stored values (a wake_on-only edit appends no log line). Success prints one stdout data line `edited <id> <name> [<schedule summary> -> <target summary>]`; an unknown id MUST exit 1 with `no entry <id>`. (9aup, ntde)

#### Scenario: Schedule edit resets the anchors
- **GIVEN** an `every 1h` entry, **WHEN** `edit <id> --idle-every 3m` runs, **THEN** the stored schedule is `{backoff, 3m, 3m}`, every other field is unchanged, exactly one `rescheduled` line exists, and the success line shows `backoff 3m→3m`
- **AND GIVEN** a name-only edit, or a re-set of the identical schedule, **THEN** no log line is appended

### Requirement: `wake_on` flags on `add` and `edit`
`rk cron add` and `rk cron edit` SHALL accept `--wake-on <event>` (only `agent-state-change`), `--wake-scope <scope>` (only `server`, the default), and `--wake-debounce <dur>` (default `60s`, MUST be `≥ 0`), parsed and validated by the shared `cronWakeOnFromFlags` helper — enum checks via `cronAddValidateEnum`, all failures usage-classified (exit 2, state dir untouched). `--wake-scope`/`--wake-debounce` without `--wake-on` SHALL be a usage error, detected via `Flags().Changed` so an explicit default-value knob still errors. `add --wake-on <event>` SHALL persist `wake_on: {event, scope, debounce}` built from the three flags; without the flag the file MUST omit the `wake_on:` key. `edit --wake-on <event>` SHALL replace the whole block with the defaults filling any omitted knob; `edit --wake-on none` (alias `off`) SHALL clear the block so the file drops the key, and `none`/`off` combined with a knob SHALL be a usage error; `add` MUST reject `none`/`off`. A wake_on-only edit MUST append no `rescheduled` line (`cron.Edit` compares `Schedule`/`Deliver` only). `Entry.validate()` MUST NOT gain a wake_on rule. (ntde)

#### Scenario: add persists the block or omits the key
- **GIVEN** a stubbed cron dir
- **WHEN** `rk cron add "operator tick" --backoff --role operator --wake-on agent-state-change` runs
- **THEN** the stored entry carries `wake_on: {agent-state-change, server, 60s}`; with `--wake-scope server --wake-debounce 2m` the block is `{agent-state-change, server, 2m}`; and without `--wake-on` the file has no `wake_on:` key
- **AND GIVEN** an unknown event, an unknown scope, a negative debounce, or a knob without `--wake-on`, **THEN** the exit is 2 and the state dir is untouched

#### Scenario: edit replaces the whole block, clears it, and logs nothing
- **GIVEN** a stored entry with `wake_on: {agent-state-change, server, 2m}`
- **WHEN** `rk cron edit <id> --wake-on agent-state-change` runs
- **THEN** the block is `{agent-state-change, server, 60s}` (the default fills the omitted knob) and the log gains no `rescheduled` line
- **AND WHEN** `rk cron edit <id> --wake-on none` (or `off`) runs, **THEN** the reloaded entry has no `wake_on`, the file drops the key, and the entry's other fields are untouched; `none` plus a knob exits 2

### Requirement: `tick` invoker posture
`rk cron tick` SHALL wrap `cron.Tick` with zero-value `Deps` under a bounded context; a held lock MUST exit 0 quietly with no output; otherwise stdout carries a one-line summary (servers swept, fires, diagnostics count). With no `Deliverer` wired, fires record outcome `no-deliverer`.

### Requirement: `GET /api/cron` derived-facts projection
`GET /api/cron?server=<slug>` SHALL return `{"entries": [...], "deliveries": [...]}` — each entry's intent fields with the derived facts (`nextFire`/`rung`/`orphaned`/`orphanedSince`/`expiresAt`/`lastFired`) computed by `cron.DeriveEntry` (the API layer MUST NOT reimplement schedule math), plus the recent delivery log projected most-recent-first, capped at the named `maxCronDeliveries` constant, each line carrying `{ts, entry, name, target, reason, outcome}` with `name` joined from the current entries (empty for a since-deleted entry). `muted` SHALL report the effective state (`EffectivelyMuted` at request time) and `mutedUntil` SHALL be emitted only while the lease is live; the schedule SHALL carry no `anchor` key. An absent or empty entry file or log SHALL yield `{"entries": [], "deliveries": []}` at 200, never 404 or an error; corrupt-entry diagnostics SHALL be logged server-side and never surfaced to the client. A `cron`-kind entry SHALL report its next occurrence as `nextFire`; an entry whose expression fails to parse SHALL report no next-fire rather than a fabricated one.

### Requirement: cron mutation routes
`POST /api/cron/create` SHALL validate and persist via `cron.Add` (any `Add` error ⇒ 400 with its text, including the `ValidateRespawnIntent` gate and the `deliver` closed-set check; success ⇒ 201 with the created entry, `created_by.at` always set to now); `POST /api/cron/delete` ← `{"id"}`, `POST /api/cron/mute` ← `{"id", "muted", "for"?}` (true with no `for` ⇒ indefinite flag, clearing any lease; true with a valid positive `for` ⇒ a lease until now+`for` via `cron.SetMuteLease`; an unparsable or non-positive `for` ⇒ 400; false ⇒ both cleared), and `POST /api/cron/pin` ← `{"id", "pinned"}` SHALL mutate via `cron.Remove`/`cron.SetMuted`/`cron.SetMuteLease`/`cron.SetPinned`, 404 on an unknown id, 200 `{"ok": true}` on success. `POST /api/cron/edit` ← `{"id", schedule?, deliver?, name?, ifAbsent?, respawn?}` SHALL partial-merge present keys (absent keys keep their values; `schedule` replaces the whole schedule; `respawn: []` clears the argv) via the shared `cron.Edit` helper, reject `target`/`createdBy`/`muted`/`pinned` keys with 400, map unknown id ⇒ 404, merged-entry validation failure (`EntryValidationError`) ⇒ 400, tick-flock contention (`ErrEditContention`) ⇒ 409, other store failures ⇒ 500, and return 200 with the updated entry in the `create` response shape. All five SHALL wake the SSE hub explicitly on success (`initSSEHub(); sseHub.wake(server)`) — entry-file writes emit no tmux control-mode event. (9aup)

### Requirement: tolerant watchlist read
`cron.ParseOperatorState`/`cron.ReadOperatorState` SHALL parse the fab operator state file tolerantly — an absent or corrupt file degrades to `(zero, false)`, never an error; a non-list `tracked:` yields no items. Every `tracked:` element that is a map with a non-empty string `id` SHALL be kept — pane-less, done, paused, or scope-less alike (a missing or non-map `scope` keeps the item with empty scope fields) — in list order, with `Text` from `text`, `Refs` from `scope.refs` (string elements only, `nil` when absent), `Paused` from `paused == true`, and `DoneAt`/`AddedAt`/`UpdatedAt` via `parseTickAt` (`null`/absent/unparseable ⇒ 0). `OperatorState.WatchlistEntries()` SHALL return exactly the pane-bearing, not-done subset (`Pane != ""`, `DoneAt == 0`) sorted by ID — `paused` and `kind` SHALL not filter. When the `tracked` key is absent the legacy `monitored:` map SHALL be parsed as before (one-release dual read — `Kind == ""` items, sorted by key); when it is present the map SHALL be ignored. rk SHALL never write the fab-owned file.

#### Scenario: Tracked list read
- **GIVEN** a state file whose `tracked:` list holds a `fab-change` item with `scope.pane: '%180'` and `done_at: null`, a `note` item with `scope: {refs: [y60c]}` and a `text` but no pane, and a pane-bearing item with `done_at` set
- **WHEN** `ParseOperatorState` runs
- **THEN** `Items` holds all three in list order — the note with its `Text`/`Refs` — while `WatchlistEntries()` holds exactly the first item, with `Kind: fab-change` and its scope fields
- **AND GIVEN** `monitored: {legacy: {pane: "%1"}}` beside `tracked: []`, **THEN** no items are returned

## Design Decisions

### The clock is told, never infers
**Decision**: The only suppression of a fire is the entry's own `muted`/`muted_until`, written through `rk cron` verbs; cron never reads the fab operator state file to decide whether a fire is emitted (the file feeds the watchlist projection only).
**Why**: rk parsing fab's private state-file schema for control is a CLI-layering violation (rk owns the tmux/agent substrate, fab owns choreography) with two concrete bugs behind it — a slug-rule mismatch that silently suppressed every fire on every server, and a `trackedLen` heuristic that counted a finished autopilot as tracked. Inversion of control keeps fab's knowledge in fab: fab TELLS the clock through the clock's own verbs (mute / lease / unmute).
**Rejected**: fixing only the file-path mismatch while keeping the guard read — restores the flawed coupling, and every future fab schema change becomes a latent cron regression in rk.
*Introduced by*: 260909-upt2-cron-decoupling-mute-lease

### Lease, not plain mute, for "my loop is alive"
**Decision**: `rk cron mute <id> --for <dur>` sets `muted_until` (unix seconds); expiry needs no write — the evaluator reads an expired lease as unmuted on the next tick.
**Why**: the in-session operator loop wants "I'm alive, hold off" semantics: a renewed lease lapses on its own when the loop dies, so the cron backstop resumes with no further call — the dead-man's-switch shape the staleness banner already uses. A plain mute would outlive a crashed operator and the incident class would return.
**Rejected**: plain mute + unmute on stop (loses the backstop on a crash); a heartbeat file (a new state store, Constitution II).
*Introduced by*: 260909-upt2-cron-decoupling-mute-lease

### `kind: backoff` carries no anchor field
**Decision**: the backoff schema is `{kind, min, max}`; bare `--backoff` selects the 60s→30m defaults with `--min`/`--max` refining them. The ladder is keyed on the target pane's idle epoch by definition — the mode switch is the schedule kind itself (`every` is the non-backoff mode).
**Why**: the anchor-join math never read the field; a field with one legal value that names nothing invites operator-specific readings.
**Rejected**: renaming the anchor to `target-idle` (still a field with one legal value); an `--anchor` flag (ceremony without choice).
*Introduced by*: 260909-upt2-cron-decoupling-mute-lease

### Respawn is a caller-supplied argv with `{server}`
**Decision**: `respawn: [argv...]` on the entry runs via `exec.CommandContext` through the `Deps.RunRespawn` exec seam (90s timeout, home-dir cwd for the exec itself, daemon env); the operator entry says `rk operator -L {server}`, whose own launch derivation picks the operator window's directory (the recorded `@rk_srv_operator_root` launch directory when still valid, home as the launcher's fallback); session-resume stays the no-command default for session targets.
**Why**: how to bring a target back is the creator's knowledge, not the clock's; the argv form keeps Constitution I (no shell strings) and lets any consumer respawn any role, with fab's launch knowledge living in fab's own entry.
**Rejected**: a per-role launch registry (more machinery than one field); a built-in operator respawner (fab knowledge inside the cron daemon); dropping the session-resume default (loses shipped behavior for no gain); a generic defensive re-probe in the tick (the command owns its idempotency — `rk operator` is already a per-server singleton).
*Introduced by*: 260909-upt2-cron-decoupling-mute-lease

### No delivery on the respawn tick
**Decision**: a successful respawn appends `respawned` and delivers nothing that tick; the entry's payload lands on the next resolved fire via the ordinary `Fires` branch.
**Why**: `if_absent: respawn` runs only when target resolution already failed, so every respawn is first contact with a fresh session that has no tick convention in context; the respawn command's own kickoff (for the operator, the `/fab-operator` prompt `rk operator` types) is the first contact, and the kickoff-vs-payload distinction falls out of the branch split for free — no has-kicked-off bookkeeping exists.
**Rejected**: a persisted kicked-off flag on the entry or in a sidecar (an intent file is the wrong place for a runtime fact, and the branch split already encodes it).
*Introduced by*: 260909-upt2-cron-decoupling-mute-lease

### Fab state file read only for display, slug mirrored from fab
**Decision**: `FabOperatorStatePath` stays for the watchlist/staleness projection, deriving the file name via `tmux.SocketPath` + the pure `cron.FabOperatorSlug` that copies fab's slugify (`-`→`--` first, strip leading `/`, `/`→`-`, empty ⇒ `default`); the rule is pinned in the spec as a cross-repo contract, and a query failure degrades to slug `default`.
**Why**: the watched marks (the underbar + `opr` register) and the stale warning are projection, not control; mirroring the slug is cheaper than a second file format and fixes the same-term-two-meanings bug ("server-slug" resolved differently in the two repos) at its source.
**Rejected**: asking fab-kit to write server-name-keyed files (socket-path keying is deliberately collision-free across socket dirs); reading the file for fire suppression (the CLI-layering violation this change removes).
*Introduced by*: 260909-upt2-cron-decoupling-mute-lease

### Anchor-join as a log-derived streak
**Decision**: rung = trailing streak of the entry's own deliveries whose following idle-epoch observations were attributed (within `attributionWindow` after a delivery); a non-attributed epoch resets rung 0 / anchor = epoch.
**Why**: the pre-delivery idle epoch is unrecoverable once tmux overwrites the option, so the log is the only durable record; the streak formulation is a pure function of (raw epoch, log) — both on disk, per the spec's statelessness requirement.
**Rejected**: persisting the effective anchor in a sidecar (a live-state store — Constitution II violation, and drift-prone); raw-epoch ladder (the self-resetting-ladder bug the plan's standing rule exists to reject).
*Introduced by*: 260906-3jtn-cron-core-evaluator

### Seed the streak walk from the largest fitting rung
**Decision**: the streak walk's seed is `largestRungWithGapAtMost(min, max, gap + seedSkew)` — the largest rung whose ladder gap fits inside the newest own-delivery gap plus one poll of jitter (`seedSkew = DefaultTickInterval`, 30s); a gap too small for any rung seeds a single-delivery streak; at the cap, each further capped gap counts as one more rung at the cap instead of a descent.
**Why**: lateness (a late poll, a daemon restart) only ever inflates an observed gap — a genuine rung-r gap is observed as `gapAfter(r) + [0, jitter]`, never smaller — so adding the jitter bound and taking the largest fitting rung is the one direction that never under-seeds, and a clean streak of any length reconstructs to its true rung.
**Rejected**: the smallest rung whose gap reaches `gap − attributionWindow` — with `attributionWindow` (120s) equal to the rung-1→2 gap at the default `min`, every three-delivery streak under-seeds by one rung, the walk stops a delivery early, and the operator ladder pins at rungs 2↔3 (a 2m/4m alternation that never decays toward `max`; an idle operator was ticked ~20×/hour for five hours instead of 2×/hour). `attributionWindow` is the epoch-attribution window, not a gap tolerance, and keeps that single role.
*Introduced by*: 260909-ts8e-backoff-ladder-rung-seeding

### Wake cursor as a seed-cache-class sidecar
**Decision**: the `wake_on` previous-observation fingerprint persists at `<slug>.cursor.yaml`; corrupt/absent = cold start (no edge fire that tick), rewritten every tick.
**Why**: a state-delta needs a previous observation; entry files must stay intent-only; Constitution II's seed-cache carve-out covers never-authoritative, droppable files.
**Rejected**: fingerprint in the entry file (runtime fact in an intent file); in-memory only (breaks the every-invoker-is-equivalent stateless contract).
*Introduced by*: 260906-3jtn-cron-core-evaluator

### Wake fingerprint excludes the entry's own target
**Decision**: `Evaluate` renders a per-entry fingerprint from the shared state map with the entry's resolved target pane removed; the cursor stores that view.
**Why**: the entry's own delivery makes the target busy, and that flip is caused by the clock — with the target in the fingerprint every tick had a ~30–50 % chance of causing the next one, so ticks arrived in 30 s pairs and quadruples. This is the same principle as the backoff anchor-join rule.
**Rejected**: one server-wide fingerprint with fires suppressed by the target's state — cannot distinguish "target busy because of us" from "target busy because a worker finished"; a cursor migration for the new rendering — one spurious wake per entry after deploy is absorbed by tick idempotency.
*Introduced by*: 260909-4gt7-cron-wake-self-exclusion

### Debounce is hold-after-own-delivery
**Decision**: the wake hold window is measured from the entry's newest own delivery-log line (`LastDelivery`), not from the previous observation's age; classification runs before the hold so an ignored-only diff always advances the cursor.
**Why**: under a 30 s poll the previous observation is always older than any sub-poll debounce, so an observation-age hold is unreachable and the field in every entry file does nothing; the question the hold answers is "did we just act on this entry".
**Rejected**: deleting the `debounce` field — it exists in every entry file and hold-after-delivery is genuinely useful once the self-trigger is gone.
*Introduced by*: 260909-4gt7-cron-wake-self-exclusion

### `→ active` is not a wake edge
**Decision**: a transition to `waiting` or `idle`, or a pane vanishing, fires; a transition to `active` (including a pane first appearing as `active`) advances the cursor without firing; unknown state values fail open toward firing.
**Why**: an agent starting work never needs the target's attention; a completion or a question does. With several workers active the operator would otherwise be ticked every poll.
**Rejected**: fire only on `→ waiting` — the operator's autopilot depends on noticing completions, and the backoff anchor is the operator's own idle epoch, so worker completions would otherwise wait up to the 30 m rung.
*Introduced by*: 260909-4gt7-cron-wake-self-exclusion

### `muted` as a schema field
**Decision**: add `muted: bool` to the entry schema (default false); the evaluator skips muted entries.
**Why**: the spec fixes mute as a first-class verb (`rk cron mute`, `POST /api/cron/mute`, the UI toggle) and states the file changes on mute — the flag must live in the intent file.
**Rejected**: a separate muted-ids sidecar (splits intent across files for no gain).
*Introduced by*: 260906-3jtn-cron-core-evaluator

### Delivery boundary at the `Deliverer` interface
**Decision**: `Tick` computes fires, resolves targets, and calls a caller-supplied `Deliverer`; injection, `when-idle` gating, `if_absent` handling, and circuit breakers live behind the interface in the production `EngineDeliverer`, which substitutes in without touching evaluation.
**Why**: matches the cron clock plan's core/delivery split; keeps every core function testable without tmux delivery; the log-append and cursor-write choreography still exercises end-to-end in tests via the fake.
**Rejected**: stubbing `internal/inject` calls directly in the core (drags delivery scope into the core; injection gating decisions belong with the deliverer).
*Introduced by*: 260906-3jtn-cron-core-evaluator

### `cron list` never touches tmux
**Decision**: `list` derives from the entry file + delivery log only; no next-fire/rung/orphan columns.
**Why**: any tmux command against a dead socket resurrects it (the zombie-server rule); next-fire/rung need live facts, derived behind the HTTP surface instead (`GET /api/cron`, § HTTP API).
**Rejected**: probing live servers for next-fire in the CLI (zombie hazard + duplicates the HTTP API's derivation).
*Introduced by*: 260906-bi3v-rk-cron-cli

### List `--json` mirrors the on-disk schema keys
**Decision**: the structured `--json` fields use the entry file's own YAML key names (`kind`, `interval`, `min`, `max`, `expr`, `catch_up`, `wake_on`, `if_absent`, `respawn`) in snake_case, with durations as `time.Duration.String()`; `wake_on`/`respawn`/`if_absent` are always present (`null` / `[]` / `""`) while the schedule's parameters are `omitempty`.
**Why**: consumers compare these values against what they intend to write (fab-kit's derived-schedule reconcile), so sharing the schema vocabulary with the file and with `rk cron edit` (which writes through the same `cron.Schedule`) leaves nothing to keep in sync; one duration encoding across rk's JSON surfaces (the API already uses `d.String()`); the top-level fixed key set is the record's existing contract, and the per-kind parameter subset is the schedule's.
**Rejected**: parsing `schedule_summary` (a rendering, not a contract); integer-seconds durations (diverges from both the API and the YAML marshaller); reusing the API's camelCase `cronScheduleJSON` (different package and casing convention); a structured `target` (fab-kit matches the summary string and nothing asked for it).
*Introduced by*: 260910-r5ao-cron-list-structured-json

### `schedule_summary` is a one-release compatibility field
**Decision**: the display string the `schedule` key carried before it became an object survives under `schedule_summary` for one release, then is removed; the table's SCHEDULE column reads it so human output is unchanged.
**Why**: the `schedule` type change is the one non-additive part of the structured contract; the summary keeps any string-reading consumer working through one release without holding two encodings of one fact forever.
**Rejected**: dropping the string immediately (no grace period for unknown consumers); keeping it indefinitely (two encodings of one fact).
*Introduced by*: 260910-r5ao-cron-list-structured-json

### Mute/pin unset via `--off`
**Decision**: `mute <id> [--for <dur>] [--off]` and `pin <id> [--off]`; no `unmute`/`unpin` verbs.
**Why**: smallest surface satisfying the spec's mute toggle plus the lease; maps 1:1 onto `SetMuted`/`SetMuteLease`/`SetPinned(bool)`.
**Rejected**: separate un-verbs (doubles the surface); toggle-on-repeat (non-idempotent scripts).
*Introduced by*: 260906-bi3v-rk-cron-cli

### Outside-tmux adds require an explicit target
**Decision**: `$TMUX_PANE` unset + no `--role`/`--pane` ⇒ hard error.
**Why**: the `rk role` posture — a typed command must not guess a target; auto-capture without a pane has nothing to capture.
**Rejected**: defaulting to `role:operator` (writes intent against a server the caller may not mean).
*Introduced by*: 260906-bi3v-rk-cron-cli
### Held outcomes never reach the delivery log
**Decision**: `Outcome.Held` outcomes skip the log append; the hold is cross-tick retry via unchanged anchors. The `skip-if-busy` drop (`skipped-busy`, `Held` unset) is the deliberate counter-example — a busy-pane outcome that MUST be logged because advancing the anchor is its purpose (see "`skip-if-busy` is a logged, non-held outcome on the deliver axis").
**Why**: the log is the anchor-derivation source (`every` last-line, backoff streak join) — logging a held attempt advances anchors and silently delays the fire by a full period; not logging makes re-evaluation the retry mechanism for free. A drop has no retry to realize, so it needs the opposite treatment: the logged line IS the anchor advance.
**Rejected**: logging held attempts with an outcome filter in the schedule math (touches the pinned derivation semantics for no gain); in-tick waiting for idle (violates the short-lived-tick contract).
*Introduced by*: 260906-kl1g-daemon-ticker-cron-delivery; `skipped-busy` counter-example 260910-9aup-cron-idle-every-skip-if-busy

### Held wake edges are consumed
**Decision**: a `wake`-reason fire held under `when-idle` does not restore the wake cursor; the payload lands on the entry's next schedule-due or next edge.
**Why**: `Evaluate` computes `NextCursor` before delivery outcomes exist; re-plumbing cursor persistence around outcomes buys nothing real — the only planned wake user (operator tick) is `deliver: skip-if-busy` (ntde), under which a busy wake fire is a logged `skipped-busy` drop rather than a hold, and no `when-idle` wake consumer exists.
**Rejected**: outcome-aware cursor persistence (couples the pure evaluator to delivery results).
*Introduced by*: 260906-kl1g-daemon-ticker-cron-delivery

### `when-idle` busy predicate is `active | waiting`
**Decision**: hold on `active` and `waiting`; deliver on `idle` and unknown ("").
**Why**: matches the operator request-lane busy gate (`api/operator.go`); typing into a `waiting` pane would stack a payload behind a pending question; an unknown-state pane (plain shell, no agent) can't be gated on a signal it doesn't carry.
**Rejected**: hold on unknown (a when-idle entry targeting a non-agent pane would never fire).
*Introduced by*: 260906-kl1g-daemon-ticker-cron-delivery

### Rate-cap key: pane ID for resolved fires, entry ID for absent fires
**Decision**: the trailing-hour count keys on the log line's target pane for deliveries, and on the entry ID for absent dispositions (their lines carry no pane).
**Why**: the spec's cap is per-target; absent fires have no target, but their notify path still needs the cap (the spec assigns notify throttling to it).
**Rejected**: a separate notify-cursor sidecar (the pulse plan's design, obsoleted by the spec's "the rate cap covers notify throttling").
*Introduced by*: 260906-kl1g-daemon-ticker-cron-delivery

### The consumer owns the operator-tick entry; rk is substrate
**Decision**: rk defines the cron schema and evaluator and exposes the verbs; the operator-tick entry's whole lifecycle — seed, mute/unmute, schedule and deliver tuning — belongs to fab's clock reconcile, keyed on the `role:operator` row (the "one operator per server" radio invariant `@rk_win_role=operator` makes role-target presence the drift-proof idempotency key, and it survives a user renaming, muting, or hand-tuning the entry). `rk operator` is launcher-only and rk carries no copy of the entry's field values.
**Why**: a second seeder in rk is a frozen mirror of fab's policy constants — every tuning (ladder bounds, deliver policy, wake debounce) would need a lockstep rk release, or a fresh server ticks on the old policy until fab's first reconcile converges it; one owner ends the cross-repo tax and the overlap window.
**Rejected**: keeping an rk seed as a fallback for a fab that predates its own seed (re-creates the two-owner drift; an old fab's `/fab-operator` Init already STOPs loudly on a missing entry, so the failure is visible, not silent); a fab minimum-version probe in `rk operator` (new launcher surface for a transitional case, and fab's release history inside rk); a name/payload match or a reserved entry id as the key (breaks on rename; special-cases `Add`'s uniform random assignment).
*Introduced by*: 260906-kbbh-operator-tick-seed-respawn (the key); 260912-pfo3-drop-operator-tick-seed (the ownership)

### Respawn seams are nil-safe with a byte-identical degrade
**Decision**: `Deps.RunRespawn` (the caller-supplied argv exec; nil selects the production `runRespawnExec`) and `Deps.SessionRespawner` (session targets without an argv; nil keeps the notify-degrade path byte-for-byte), each consulted only for `if_absent: respawn` on its branch of the disposition switch.
**Why**: mirrors the `Deliverer`/`Notifier` seam shape — the disk/logic core stays testable via fakes while production wires the real implementations in `serve.go`; the per-kind gates live at explicit branches in the disposition switch.
**Rejected**: overloading `Deliverer` to also handle absent-fire respawn (conflates resolved-fire delivery with absent-fire disposition — different inputs and failure semantics).
*Introduced by*: 260906-kbbh-operator-tick-seed-respawn; session seam 260908-f89x-cron-session-targets-gc; argv seam 260909-upt2-cron-decoupling-mute-lease

### Escalate-don't-wait for respawn walls
**Decision**: a non-`ready` readiness classification or a send error during the session-resume respawn calls the fail-silent notifier (entry + server named) and returns `respawn-failed` — no in-tick retry, no judgment round, no delivery into an unclassified pane. (The argv respawn has no readiness classification to gate on — its failure detail comes from the process exit and output tail.)
**Why**: the judgment-round carve-out exists for a human-attended dispatch loop; the daemon tick has no human to answer a wall, and the spec's ladder rule is that the clock never auto-answers walls — escalation to a human is the only safe posture.
**Rejected**: cross-tick readiness retry without escalation (a silently-stuck respawn defeats the backstop's purpose); auto-answering common wall patterns (the spec's explicit prohibition).
*Introduced by*: 260906-kbbh-operator-tick-seed-respawn

### Derivation logic lives in `internal/cron`, not the `api` package
**Decision**: `DeriveEntry` (next-fire/rung/orphaned/last-fired) is an exported function in `internal/cron`; the `GET /api/cron` handler is a thin JSON translation layer over it.
**Why**: `internal/cron` already owns every piece of the underlying math (`JoinAnchor`, `Ladder.NextFire`, `everyAnchor`, `LastDelivery`); keeping the derivation there matches the existing package boundary and keeps the projection logic testable independent of HTTP.
**Rejected**: inlining the derivation in `api/cron.go` — duplicates package-private schedule math or forces exporting internals purely for one caller.
*Introduced by*: 260907-1jm6-cron-api-derivations

### Watchlist staleness attaches to every `ProjectSession`
**Decision**: `OperatorLastTickAt`/`OperatorStale` populate identically on every session returned for one server, rather than only the `Hidden` operator session.
**Why**: simpler consumer contract — no special-casing to locate the `Hidden` session first; the repeated bytes are negligible (one int64 + one bool × a handful of sessions per server).
**Rejected**: attaching only to the `Hidden` operator session — matches its "operator row's own data source" precedent more narrowly, but forces every consumer to filter for it first.
*Introduced by*: 260907-1jm6-cron-api-derivations

### `pin` rides the same HTTP contract as `mute`
**Decision**: `POST /api/cron/pin` ← `{"id", "pinned"}` mutates via `cron.SetPinned` — 404 on an unknown id, 200 `{"ok": true}` plus an SSE hub wake on success, mirroring `POST /api/cron/mute` byte-for-byte in shape.
**Why**: the entry detail sheet's pin row (the spec's alarm-app anatomy — [ui/cron-console-tabs](/run-kit/ui/cron-console-tabs.md)) needs a pin mutation reachable from the browser; mirroring mute's contract keeps the mutation surface uniform and adds no new response shape.
**Rejected**: keeping `cron.SetPinned` CLI-only (strands the mobile sheet's pin row); a differently-shaped pin body (diverges from the mute precedent for no reason).
*Introduced by*: 260907-yxen-mobile-cron-activity-feed

### The pin route waited for a consumer
**Decision**: pin's HTTP endpoint exists only because a browser consumer appeared — the CLI-only posture held while no caller needed pin over HTTP and gave way when the mobile detail sheet became that caller. `POST /api/cron/edit` lands on a DECLARED consumer instead of a shipped one: the run-kit UI's future edit surface is named as the consumer at ship time, and the route goes in with the verb so both surfaces ride the shared `cron.Edit` helper from day one.
**Why**: speculative HTTP surface is avoided by policy (minimal surface, Constitution IV); the CLI-only stance was conditional ("no consumer"), and the condition expired rather than the principle breaking. For edit, the declared-consumer variant is the same policy with the condition relaxed one notch — the UI consumer is committed work, and splitting verb/route would duplicate the helper choreography or drift it.
**Rejected**: adding the route preemptively ahead of any consumer (speculative surface); silently overwriting the earlier CLI-only entry (a reversal recorded in place keeps the decision's history legible, FKF §3.3).
*Introduced by*: 260907-yxen-mobile-cron-activity-feed; edit-route amendment 260910-9aup-cron-idle-every-skip-if-busy

### Delivery history rides the existing `GET /api/cron` endpoint
**Decision**: recent deliveries project as a sibling `deliveries` array on the existing `GET /api/cron` response, not a new endpoint.
**Why**: Constitution IV (minimal surface) and the one-thin-read-endpoint pattern both favor extending; `handleCronList` already holds the parsed log (`cron.ReadLog`), so the projection is a pure slice of loaded data, not a new code path.
**Rejected**: a separate `GET /api/cron/log` endpoint (doubles the read surface for data always consumed alongside `entries`).
*Introduced by*: 260907-yxen-mobile-cron-activity-feed

### Notify deep-links target the Cron Log tab, not a specific entry
**Decision**: the cron notify deep-link is `/{server}/{operatorWindowNum}?tab=log`, with no entry id in the URL; the helper is split into an exported pure `PushURL(server, windowID)` builder plus the unexported `operatorPushURL` resolver so the session respawner's escalation (which resolves windows through its own seam) reuses the builder without new `Deps` surface.
**Why**: the spec's notification deep-links to the quake terminal's log tab, not to a specific entry's detail sheet; the pure/seam split keeps `internal/cron`'s exported surface minimal and each half unit-testable through its existing fake.
**Rejected**: carrying `&entry=<id>` to auto-open a detail sheet (speculative surface beyond the stated requirement); one monolithic resolver (forces the `cmd/rk` caller through the tick's seam it doesn't hold).
*Introduced by*: 260907-yxen-mobile-cron-activity-feed

### Watchlist staleness threshold is 15 minutes
**Decision**: the named constant `DefaultWatchlistStaleThreshold` (15m) gates `OperatorStale`.
**Why**: the spec names `last_tick_at` as "the single staleness timestamp" but gives no number; a named constant keeps the value a one-line change.
**Rejected**: a short-fuse (120s-class) loop-liveness threshold — that answers a different, much-shorter-fuse question ("is the in-session loop still ticking") and would false-trip watchlist staleness constantly.
*Introduced by*: 260907-1jm6-cron-api-derivations

### Plain resume, not fork, for session respawn
**Decision**: session respawn composes `--resume <uuid>` without `--fork-session` (the riff seam's `ResumePlain` mode).
**Why**: the entry targets this session id; the SessionStart hook re-stamps the resumed pane with the same id, so the entry resolves again on the next fire — a fork mints a fresh id and the entry stays orphaned forever.
**Rejected**: fork + rewriting the entry's target to the new id — mutates intent with a runtime fact, and a rewrite failure orphans permanently.
*Introduced by*: 260908-f89x-cron-session-targets-gc

### Orphaned-since derives from the delivery log
**Decision**: trailing-run derivation over the entry's log lines (resolved-class `delivered*`/`respawned*` prefixes terminate the run; `created_by.at` fallback); no schema field.
**Why**: Constitution II and the spec's rule that runtime facts are never entry-file fields; log trimming degrades expiry conservatively later, never premature.
**Rejected**: an `orphaned_since` entry-file field — contradicts the spec's mutation set (add/rm/pin/mute) and turns intent into a state store.
*Introduced by*: 260908-f89x-cron-session-targets-gc

### First delivery after a session resume is the bare payload
**Decision**: the session respawner delivers the entry payload directly once ready; no kickoff.
**Why**: resume restores the conversation's context, so the fresh-session "never the bare tick" rationale (no tick convention in context) does not apply; no kickoff is defined for arbitrary sessions.
**Rejected**: a synthetic preamble/kickoff — adds a convention no payload author expects; payloads are idempotent and self-contained by contract.
*Introduced by*: 260908-f89x-cron-session-targets-gc

### Hold bound as drop-with-visible-history
**Decision**: a `when-idle` fire held busy past `DefaultHoldWindow` (2h) logs `held-expired` and is dropped; never force-delivered.
**Why**: recurring schedules lose nothing (the next due period fires normally) and stale payloads never land mid-task hours later; the bound derives from `Fire.DueAt`, keeping evaluation stateless.
**Rejected**: unbounded hold (delivers stale payloads at the worst moment); force-deliver at the bound (interrupting a busy/waiting agent contradicts when-idle's purpose).
*Introduced by*: 260908-qyin-cron-schedule-completions

### Expression math via robfig/cron/v3, parse+next only
**Decision**: depend on `github.com/robfig/cron/v3` for `ParseStandard` + `Schedule.Next`; its runtime scheduler is never used.
**Why**: DOM/DOW union semantics, ranges, steps, and names are battle-tested there; the stateless evaluator remains the only clock.
**Rejected**: an in-house 5-field parser (~300 lines of subtle edge cases for zero dependency savings that matter — the lib has no transitive deps).
*Introduced by*: 260908-qyin-cron-schedule-completions

### Missed occurrences log rather than diagnose
**Decision**: a stale occurrence appends one `missed` log line (mute-gated, target-independent), advancing the anchor.
**Why**: one line per gap (not per tick) bounds the occurrence walk near now; the quake terminal's `Cron Log` tab surfaces visible missed history; a diagnostic alone repeats every tick and leaves the anchor stale.
**Rejected**: diagnostic-only (invisible, unbounded walk); one line per missed occurrence in a gap (log spam over long gaps for no derivation gain).
*Introduced by*: 260908-qyin-cron-schedule-completions

### The when-idle due window extends to the hold bound
**Decision**: a cron occurrence stays deliverable for `DefaultCronGrace` (2m) on immediate entries and `DefaultHoldWindow` (2h) on when-idle entries.
**Why**: a when-idle hold is realized as cross-tick re-evaluation — with only the 2m grace every held cron fire would expire before the pane could idle, making when-idle+cron useless.
**Rejected**: one shared window (either too lax for immediate or too strict for when-idle); persisted first-observed-due state (Constitution II violation).
*Introduced by*: 260908-qyin-cron-schedule-completions

### Idle reminder is a flat backoff, not a schedule kind
**Decision**: "Ping every X of quiet" is `{kind: backoff, min: X, max: X}`.
**Why**: `gapAfter` returns `max` on every rung when `min == max`; the anchor is the pane's idle epoch and the anchor-join rule keeps the clock's own pings from restarting the count — the wanted semantics, already shipped and tested.
**Rejected**: a fourth schedule kind (duplicates the anchor-join machinery); a skip-when-busy `every` variant (a delivery concern on the schedule axis).
*Introduced by*: 260910-9aup-cron-idle-every-skip-if-busy

### `--idle-every` is input-side CLI sugar over the unchanged schema
**Decision**: the flag expands in the CLI parser to a flat backoff; renderers keep showing the on-disk truth (`backoff 3m→3m`).
**Why**: discoverability was the gap; sugar keeps the format and evaluator untouched, and displaying the stored schedule keeps `list`/UI honest about what the file says.
**Rejected**: a `kind: idle-every` on disk (a second spelling the evaluator must normalize); round-trip rendering (`idle-every 3m`) — deferred as a display-only follow-up.
*Introduced by*: 260910-9aup-cron-idle-every-skip-if-busy

### `skip-if-busy` is a logged, non-held outcome on the deliver axis
**Decision**: a third `deliver` value checks agent state once at due time and drops a busy-pane fire with `Outcome{Status: "skipped-busy", Held: false}`, which the tick logs; rate-cap-exempt; ordinary `DefaultCronGrace` window.
**Why**: logging is the mechanism — the newest own log line is the anchor for every kind, so a logged skip moves the next attempt to the next period; an unlogged skip would re-fire on the next poll and degenerate into `when-idle`.
**Rejected**: `hold: 0` on `when-idle` — a sentinel is less readable and yields no distinct log outcome.
*Introduced by*: 260910-9aup-cron-idle-every-skip-if-busy

### `edit` logs `rescheduled` as the anchor reset point, through one shared helper
**Decision**: `cron.Edit` holds the tick flock, runs `Update`, and appends one `rescheduled` line (`Reason: edit`) when schedule or deliver changed; both the CLI verb and `POST /api/cron/edit` call it.
**Why**: every kind anchors on the entry's newest own log line, so an edited entry would otherwise be judged against history produced under the old schedule; the lock orders the reset relative to a concurrent tick; a single helper keeps the two surfaces from drifting.
**Rejected**: mutating the delivery log or rewriting `created_by.at`; duplicating the choreography in the handler.
*Introduced by*: 260910-9aup-cron-idle-every-skip-if-busy

### `rescheduled` is a backoff streak boundary and orphan-neutral
**Decision**: `JoinAnchor` reads `ScheduleHistory` (own lines newer than the newest `rescheduled`); `LastDelivery` is unchanged; `OrphanedSince` skips `rescheduled` lines.
**Why**: the ladder walk is outcome-agnostic and would ingest pre-edit deliveries as rungs; `LastDelivery` must still see the line so `every`/`cron` anchor on the edit; a cut view fed to `OrphanedSince` would fall back to `created_by.at` and could expire an old edited entry on its first unresolved tick.
**Rejected**: filtering `OwnDeliveries` itself.
*Introduced by*: 260910-9aup-cron-idle-every-skip-if-busy

### Watched means pane-bearing and not done; `tracked` wins by key presence
**Decision**: The pane join consumes `OperatorState.WatchlistEntries()` — a tracked item is a watchlist entry exactly when it carries a `scope.pane` and its `done_at` is null; `paused` and `kind` do not affect inclusion. The legacy `monitored:` map is read only when the `tracked` key is absent — `tracked: []` beside a stale map yields nothing.
**Why**: The join's question is "is the operator watching this pane": a done-but-unacked item would pin a watched row onto a finished or dead pane, a paused item is still in the tracked set, and only `fab-change` carries a pane probe today so a kind filter would encode a fab-kit detail. fab deletes `monitored` in the same write that introduces `tracked`, so both-present is residue; falling back on an empty list would resurrect stale entries after the operator removes the last item.
**Rejected**: filtering the join to `kind: fab-change`; keeping done items in the join until `track rm`; merging both arms or falling back on emptiness; reading `fab operator track list --json` via a subprocess per fetch (a `fab` dependency on a per-request hot path for data already on disk).
*Introduced by*: 260911-owgh-watchlist-reader-tracked-list; join-scope amendment 260911-xy8b-operator-tasks-lists-all-tracked-items

### The Operator Tasks list is the whole tracked set; the pane join stays pane-bearing and not-done
**Decision**: One tolerant read of the operator state file yields two projections — `Items` (every tracked item, for the Tasks segment, done items dimmed) and `WatchlistEntries()` (pane-bearing, not-done, for the `monitored` join). The Tasks segment lists `Items`; the sidebar underbar, `opr` register, and Server page WATCHED zone keep the join's meaning.
**Why**: A tab named Operator Tasks must show what `fab operator track list` reports, and a done note's text ("archive once merged") stays useful until the operator removes it; a done pane-bearing item must still not pin a watched row onto a finished pane.
**Rejected**: Renaming the tab to "Watched Workers" and keeping it workers-only (the user wants the task list); a separate `GET /api/operator/tracked` endpoint (the sessions payload already carries server-scoped operator facts on the SSE cadence, and fab caps note text at 500 chars).
*Introduced by*: 260911-xy8b-operator-tasks-lists-all-tracked-items

### `operatorTracked` rides the sessions payload, stamped on every session
**Decision**: `ProjectSession.OperatorTracked` is stamped identically on every session of a server, like `operatorLastTickAt`/`operatorStale`, with `windowId` resolved server-side by pane.
**Why**: The Tasks segment stays a pure projection over data the frontend already holds; no new route, no client polling, no second clock; a missing key is the older-backend signal and the frontend falls back to the `monitored`-derived rows.
**Rejected**: A per-server top-level field (the sessions payload has no server envelope) or a dedicated endpoint (a second fetch path for a handful of items).
*Introduced by*: 260911-xy8b-operator-tasks-lists-all-tracked-items

### Target and creator are immutable under `edit`
**Decision**: `edit` (verb and route) accepts no target/creator/mute/pin keys — the verb defines no target flags and the route rejects `target`/`createdBy`/`muted`/`pinned` keys with 400.
**Why**: a retarget is a different entry (the delivery-log history belongs to the old target); mute/pin keep their own verbs and routes.
**Rejected**: in-place retargeting (moves history onto a target that never produced it); accepting target flags as a rm+add shortcut (mints a new id silently, breaking anything that recorded the old one).
*Introduced by*: 260910-9aup-cron-idle-every-skip-if-busy

### wake_on is CLI-addressable; the generic backoff defaults stay
**Decision**: expose `wake_on` as three `rk cron add`/`edit` flags so a consumer can seed and tune the full operator entry through rk verbs alone, while the generic `--backoff` ladder defaults stay 60s→30m and only the operator spec moves to 3m→24m.
**Why**: fab's seed must not lose the reactive channel; the 3m→24m ladder is the operator consumer's tuning, not the substrate's default — moving the generic default would encode consumer policy in the substrate, the opposite of the ownership split.
**Rejected**: changing the generic defaults to agree (touches every "60s→30m by default" string and every user's future entries for one consumer's preference); a Go-only spec with no CLI path (blocks fab's seed).
*Introduced by*: 260911-ntde-cron-wake-on-flags-seed-tuning

### A wake_on edit is not a reschedule
**Decision**: `edit --wake-on …` replaces or clears the block without a `rescheduled` log line; `cron.Edit`'s Schedule/Deliver comparison is untouched.
**Why**: `rescheduled` is the anchor-reset point for `every`/`cron`/`backoff`; `wake_on` has no anchor — its cursor is entry-id keyed and cold-starts harmlessly.
**Rejected**: logging `rescheduled` on any field change (would restart a healthy backoff streak for a debounce tweak).
*Introduced by*: 260911-ntde-cron-wake-on-flags-seed-tuning

See [configuration](/run-kit/configuration.md) § Migrations & Breadcrumbs for the state-root inventory this tenant joins, [layout-snapshots](/run-kit/layout-snapshots.md) for the sibling state-root resolution pattern, and [test-sockets](/run-kit/test-sockets.md) for the tmux test-isolation conventions the package's tests follow.
