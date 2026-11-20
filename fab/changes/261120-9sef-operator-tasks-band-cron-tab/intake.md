# Intake: Operator Tasks Band and the Cron Tab

**Change**: 261120-9sef-operator-tasks-band-cron-tab
**Created**: 2026-11-20

## Origin

> Execute step T7 (Tasks band and the Cron tab) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first (Decisions and Rules bind you), then implement only the T7 Brief.

One-shot `/fab-new` invocation for the operator plan (queue mode `merge-auto`). The plan (also in this
repo at `fab/plans/sahil/26-11-20-operator-triggers.md`; design page
`docs/wiki/operator-wake-architecture.html` § "Tasks · Needs you" has the band mock) binds this change
through its **Decisions** table and **Rules** section, which are not reopened here. T7 depends on T6
(Activity tab, Check now, `show loop` toggle), merged to `main` as #1171 (change
`261120-ny0u-operator-activity-tab-check-now`; this branch is rebased onto it), and T2's trigger door (`POST /api/operator/wake`, notes as `note@<at>` conditions) is on `main`. Only the
T7 Brief is in scope. The T7 Brief, verbatim:

> - Tasks: a **Needs you** band above the list — one row per open escalation (`escalated:` note whose
>   condition is still open) and per `waiting` prompt (from `operatorTracked`), with the item id, the one
>   wanted action, and `open pane` / `note…` actions; cleared when the condition clears. The note composer
>   calls `POST /api/operator/wake` after a successful write.
> - Cron: `Cron List` and `Cron Log` become one `Cron` segment — registry on top, deliveries below (the
>   existing tables stacked, the detail sheet unchanged); loop rows behind the T6 toggle.
> - Mobile `?tab=` values `tasks`, `activity`, `cron`; the legacy `log` token normalizes to `cron` for one
>   release.
> - PR evidence: desktop + mobile.
> - Docs: `ui/quake-terminal.md`, `ui/cron-console-tabs.md`, `ui/routes-and-shell.md`.

Binding plan decisions this change honours: **Drawer** (four segments `Terminal · Tasks · Activity ·
Cron`; Cron List + Cron Log merge; loop rows hidden in Cron behind a toggle; a **Needs you** band on
Tasks — Constitution IV, the strip stays at four); **Notes are triggers** (a `by: user`/`by: chat`
note newer than the item's last `by: run` note is a check condition — so the composer's note is itself
picked up by the next check even if the wake call fails); **Trigger door** (`POST /api/operator/wake`
writes the marker; never a bare `rk operator check`); **No forced run**. Plan Rule 6: T7 changes the
drawer, so the PR carries desktop + mobile `just demo` recordings, before/after. Plan Rule 4: the review
bar is copied into Non-goals.

**Gap found during intake** (resolved here, not asked — the plan runs with no user involvement until
R1): the Brief and the design page speak of "the note composer" as if it exists, but today **no UI or
API writes a note** — `GET /api/operator/notes` is read-only and notes are written only by
`rk operator track note`, runs and the chat (`app/backend/api/operator_notes.go` header comment). The
`note…` action and "the composer calls wake after a successful write" therefore require a minimal
write path: `POST /api/operator/notes` plus an inline composer. This is the smallest reading that makes
the Brief implementable; see § What Changes 2 and Assumptions #4–#6.

## Why

1. **The user's inbox is missing.** Everything the operator cannot resolve reaches the user as an
   `rk notify` push or an `escalated: …` note buried in a row's note cell, and an agent blocked on a
   permission prompt shows only as a `waiting` badge somewhere in the sidebar. The Tasks segment is the
   ledger, not a to-do list: nothing on it says "these two things need you, and here is the one action
   each wants". The design page calls the band "the inbox the plan has been missing".
2. **"You" is not yet a usable trigger from the drawer.** T2 made a fresh `by: user` note a check
   condition and gave the loop a trigger door, but there is no way to write a note from the drawer, so
   answering an escalation still means switching to a shell (`rk operator track note …`) or typing into
   the operator chat. A composer that writes the note and then calls the door makes the next check — and
   a run, since the note is a condition — happen within a minute instead of at the next ladder rung
   (up to 24 min).
3. **Two cron tabs for one question.** After T6 the strip is five segments
   (`Terminal · Tasks · Activity · Cron List · Cron Log`); the plan's drawer decision is four. The cron
   registry is short (a handful of entries) and the deliveries are the long list; two tabs force a
   switch to answer "what is scheduled and did it deliver". Stacking them in one `Cron` segment restores
   Principle IV's four-segment strip.
4. **Tab tokens.** `?tab=list|log` names two segments that stop existing; push notifications already in
   the wild deep-link `?tab=log` (`app/backend/internal/cron/push_url.go`), so the old token must keep
   working for one release.

If not done: R1 cannot ship (T7 is in R1's dependency set), the strip stays at five, and every
escalation keeps costing a context switch to a shell.

## What Changes

### 1. Frontend — the Needs-you band (`components/watched-tasks.tsx` + a new band component)

A **Needs you** band renders above the summary line/table in `WatchedTasks` (so it appears in both the
desktop drawer's Tasks segment and the mobile operator route's `?tab=tasks` — one component, two mounts).
It renders **only when at least one row exists** (no empty band). Header: `Needs you · <n>`. One row per
need, derived purely at render from the sessions payload (no new fetch, no timer — "cleared when the
condition clears" falls out of re-deriving on every SSE payload):

- **Open escalation.** A tracked item (`OperatorTrackedItem` from `collectTrackedRows`) that is **not
  done** (`doneAt` unset) whose `latestNote` is `by: "run"` and whose text starts with `escalated:`. The
  wanted action shown is the text after the `escalated:` prefix (trimmed), e.g. `spawn interrupted: …`.
  It clears when anything newer lands on the item (a user/chat note answering it, a run note recording
  progress) or the item completes. Rationale: the engine writes `escalated: <reason>` once per condition
  (`internal/autopilot/autopilot.go` `escalateAs`, escalate-once), and the payload carries only the
  newest note — "the newest note is still the escalation" is the payload-derivable reading of
  "condition still open" (Assumption #2).
- **Waiting prompt.** A tracked **worker** row (an item whose pane resolves to a live window,
  `kind: "worker"`) that is not done and whose window is waiting (`isWaiting(win)` from `lib/waiting.ts`,
  i.e. `agentState === "waiting"`). Wanted action text: `answer the prompt in <window name>` (the payload
  carries no question text; the window name is what the row already shows). Clears when the agent state
  leaves `waiting`.
- An item that is both waiting and escalated renders **one** row (waiting wins — it is the more
  immediate action; the escalation text is appended after ` · `).

Row anatomy (mock from the design page): `<item id>` · `<wanted action>` · actions. Actions:

- **`open pane`** — on rows with a resolvable `windowId` (waiting rows always; escalation rows when the
  item's pane is live): calls the same `onNavigate(windowId)` the table row uses (drawer: navigate +
  collapse; mobile route: `navigateToWindow`).
- **`note…`** — on every row: opens the inline note composer (§ 2) for that item, in place under the row.

Order: waiting rows first (oldest `updatedAt` first), then escalations (oldest first). Styling follows
the existing staleness banner/hint conventions (`text-signal-yellow` accent for the header, monospace,
`text-xs`), buttons via `Control`/`controlClass`. Test ids: `needs-you-band`, `needs-you-row`
(with `data-item-id`), `needs-you-open-pane`, `needs-you-note`.

Pure derivation lives beside the other projections in `components/server-watched-zone/model.ts`
(e.g. `collectNeedsYou(rows): NeedsYouRow[]`) so it is unit-testable without rendering.

### 2. The note composer + `POST /api/operator/notes` (new write path)

**Backend** — `POST /api/operator/notes` (Constitution IX: POST), body
`{"server": "<name>", "id": "<item-id>", "text": "<note>"}`:

- Validates `server` like the wake handler does; `id` must be non-empty and is only compared for
  equality (never part of a path — same rule as the GET handler).
- Writes through `operator.AddNote(path, id, operator.ByUser, text)` (`internal/operator/track.go`),
  which already validates/trims text, enforces `NoteTextCap`, prunes past `NoteCap`, touches
  `updated_at`, and writes under `Mutate`'s lock — so the daemon is one more serialized writer, never a
  racing one (Constitution II: durable before acknowledged — the 200 is sent only after the atomic write).
- `path` is **rk's** state file for the server: `operator.StatePath(socketPath)` with the socket from the
  same seam `ReadOperatorStateForServer` uses. If rk's file does not exist (a server still on fab's
  legacy file), the handler refuses (`404`, message "no rk operator state for this server") rather than
  writing fab's file — rk never writes fab's ledger. Unknown item → `404`; validation error (empty, over
  the cap) → `400` with the validator's message; I/O error → `500`.
- Response: `{"id": "<id>", "note": {"at": <unix>, "by": "user", "text": "<trimmed>"}}`.
- An injectable seam on `Server` (like `operatorStateFn`/`cronDirFn`) so handler tests write into a temp
  state file, never a live state home.
- The handler does **not** call the wake itself — the Brief puts the wake call in the composer.

**Frontend** — `postOperatorNote(server, id, text)` in `api/client.ts`, and a small inline composer
component (single-line-growing `<textarea>`, `Save` + `Cancel`, Enter submits / Shift+Enter newline,
Esc cancels, autofocus on open, disabled while pending, counter only near `NoteTextCap`). On a
successful write it calls `postOperatorWake(server, "note:<id>")` — the fire's log reason becomes
`trigger:note:<id>` (T2's `NormalizeWakeReason` accepts any single-line reason under
`MaxWakeReasonRunes`; the id is bounded by the ledger's id rules). Outcomes:

- write fails → composer stays open with the server's message inline (`role="alert"`), text kept;
- write ok, wake ok → composer closes; transient `note saved · check queued` line;
- write ok, wake fails → composer closes; transient `note saved · the next check will pick it up`
  (correct by the plan's "Notes are triggers" decision — the note is a condition regardless).

The composer is reachable from (a) the band's `note…` action and (b) every tracked row's expanded
notes list in `WatchedTable` (`ItemNoteCell`'s expand-in-place list gets an `add note…` control at its
foot; after a successful write the expanded list refetches `getOperatorNotes`). The table's own note
cell is otherwise unchanged. The design page's Tasks row ("the ledger — items, notes, a note composer")
is the source for (b).

### 3. Frontend — one `Cron` segment

- `components/terminal-activity-tabs.tsx` `SEGMENTS` becomes
  `terminal/Terminal · tasks/Tasks · activity/Activity · cron/Cron`; `QuakeSegment` is
  `"terminal" | "tasks" | "activity" | "cron"`. The `TerminalActivityTabs` active-tab read accepts
  `cron`. The doc comments naming `Cron List · Cron Log` are updated.
- A new `CronConsole` body (e.g. `components/cron-console.tsx`) stacks the **existing** `CronList` over
  the **existing** `CronLog`, both given the same `server` and `inline` flag as today: the registry in a
  `shrink-0` region capped at roughly 40 % of the body height with its own scroll, the deliveries
  filling the rest (`flex-1 min-h-0`) with their own scroll; a thin `border-t border-border` between them.
  Each table keeps its own toolbar (the Cron Log's T6 `show loop` toggle stays exactly as is, default
  off) and its own detail sheet — **the detail sheet is unchanged** (Brief).
- Mounts: the desktop drawer (`components/quake-terminal.tsx` — the `segment === "list"` /
  else-`CronLog` branch becomes `segment === "cron"` → `<CronConsole server inline />`) and the operator
  route (`app.tsx` — `cronTabActive = quakeTab === "cron"`, the `list`/`log` sub-branch replaced by
  `<CronConsole server />`).
- Mobile seam (`quake-terminal.tsx` `mobileRequestRef`): the operator-less redirect to
  `/$server#cron` keys on `detail.segment === "cron"`.
- `QuakeTerminalRequest.segment` (the `rk:quake-terminal` seam's type) follows the union.
- Palette (`lib/palette/quake-terminal.ts`): `buildQuakeTerminalListAction` + `buildQuakeTerminalLogAction`
  collapse into one `buildQuakeTerminalCronAction` — id `quake-terminal-cron`, label
  `Operator: Show cron`, `requestQuakeTerminal({ action: "open", segment: "cron" })` — and
  `use-global-palette-actions.ts` registers it once. `components/status-bar.tsx`'s cron opener requests
  `segment: "cron"`.

### 4. `?tab=` tokens and deep links

- `lib/router-url.ts`: `TerminalSearch.tab` becomes `"terminal" | "tasks" | "activity" | "cron"`;
  `validateTerminalSearch` keeps `terminal|tasks|activity|cron` and **normalizes the legacy tokens
  `log` and `list` to `cron`** for one release (a one-line comment marks it for removal after the next
  release); anything else still drops to absent (= `terminal`). The union-agreement Vitest guard
  (segments ↔ seam type ↔ router union) stays green.
- Backend `internal/cron/push_url.go`: `cronPushTab` becomes `cron`, so new cron-delivery pushes
  deep-link `/{server}/{N}?tab=cron`; already-delivered `?tab=log` links land on Cron via the
  normalization. Its test updates.

### 5. Tests

- **Vitest**: `collectNeedsYou` table cases (escalation open / cleared by a newer note / cleared by
  done / waiting row / waiting clears / both → one row / done item excluded / non-`escalated:` run note
  ignored); band renders nothing with zero needs and the header count otherwise; `open pane` calls
  `onNavigate` with the window id; `note…` opens the composer; composer: success calls
  `postOperatorNote` then `postOperatorWake(server, "note:<id>")`, write failure keeps text and shows the
  error, wake failure still closes with the "next check" message; `WatchedTable` expanded list's
  `add note…`. Segment strip renders four labels; `validateTerminalSearch` maps `log`/`list` → `cron`;
  palette has `quake-terminal-cron` and no list/log actions; quake-terminal and app operator-page tests
  updated for `cron` (stacked list + log both render).
- **Go**: `POST /api/operator/notes` — 200 writes a `by: user` note to a temp rk state file; 404 unknown
  item; 404 when only fab's file exists (and fab's file is untouched); 400 empty / over-cap / bad server;
  GET unchanged. `push_url` test expects `?tab=cron`.
- **Playwright e2e**: update `mobile-cron-tabs.spec.ts`, `quake-terminal.spec.ts`,
  `operator-page.spec.ts`, `operator-compose.spec.ts` for the four-segment strip and `?tab=cron`
  (including a `?tab=log` deep link landing on Cron); a Tasks spec covering the band from a seeded state
  file (escalated note → row; `note…` → write → row clears) — each `test()` with its Proves/Steps intent
  block (Constitution § Test Intent Comments).
- **Demo**: a `tests/demo/operator-tasks-band.demo.ts` (or extend `operator-activity.demo.ts`) recording
  the band, the composer write + wake, and the single Cron tab — desktop + mobile, `--before` for the
  base (Plan Rule 6).

### Non-goals

- **Review bar** (plan § Decisions, quoted for every review dispatch): must-fix = merges, pushes,
  deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan
  requirement. Should-fix = everything else.
- No change to the check, the conditions, the engine's escalation logic, the ladder, the runner or the
  trigger door (T1–T3, T2 own them); no server-side "open escalation" computation or new payload field.
- No `by: chat` writes from the UI and no note editing/deletion (notes leave only by cap pruning).
- No change to the Activity tab, Check now, or the brief/log endpoints (T6) beyond what the segment
  union forces.
- No new route, page or SSE channel (Principle IV); the detail sheets are not redesigned.
- No install, release or daemon restart (plan Rule 1 — R1 does that).

## Affected Memory

- `run-kit/ui/quake-terminal`: (modify) four-segment strip (`Terminal · Tasks · Activity · Cron`), the
  Cron segment stacking registry over deliveries, the Needs-you band and note composer on Tasks, the
  seam's `cron` segment and the operator-less mobile redirect keyed on it.
- `run-kit/ui/cron-console-tabs`: (modify) Cron List + Cron Log merged into one `Cron` segment
  (stacked, detail sheets unchanged, `show loop` toggle kept); palette `Operator: Show cron`.
- `run-kit/ui/routes-and-shell`: (modify) `?tab=terminal|tasks|activity|cron`, the one-release
  `log`/`list` → `cron` normalization, the operator page's content swap.
- `run-kit/api-and-sockets`: (modify) `POST /api/operator/notes` (body, status codes, rk-file-only
  write) beside the existing GET.
- `run-kit/operator-state`: (modify) notes may also be written by the daemon on the user's behalf
  (`by: user`, rk's file only) — the writers list.
- `run-kit/ui/keyboard-and-palette`: (modify) the two cron palette actions become one.
- `run-kit/cron`: (modify) push deep-link `?tab=cron` (only if `cron.md` names the `?tab=log` link).

`docs/specs/api.md` gets the new endpoint (specs are human-curated; the endpoint row is the established
pattern — T6 added its endpoints there too).

## Impact

- **Frontend**: `components/watched-tasks.tsx`, `components/watched-table.tsx` (expanded-notes
  composer entry), new band + composer + `cron-console.tsx` components,
  `components/server-watched-zone/model.ts`, `components/terminal-activity-tabs.tsx`,
  `components/quake-terminal.tsx`, `app.tsx` (operator-page swap), `lib/router-url.ts`,
  `lib/palette/quake-terminal.ts`, `hooks/use-global-palette-actions.ts`, `components/status-bar.tsx`,
  `api/client.ts`; their unit tests; e2e specs listed above; one demo spec.
- **Backend**: new handler (e.g. `app/backend/api/operator_notes.go` gains the POST, or a sibling
  `operator_notes_write.go`) + route in `api/router.go` + tests; `internal/cron/push_url.go` + test.
- **Docs**: the memory files above; `docs/specs/api.md`.
- **Risk**: the daemon becomes a ledger writer. Mitigated by reusing `operator.AddNote` (validation,
  cap, lock, atomic write) and writing rk's file only. CLI surface unchanged — no help text, skill topic
  or `rk help-dump` fixture changes (plan Rule 5 does not trigger).

## Open Questions

- None blocking. The two judgment calls the Brief leaves open — what "condition still open" means for an
  escalation, and the missing note write path — are decided in Assumptions #2 and #4 and are cheap to
  revise.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is the T7 Brief only; the plan's Decisions/Rules bind it; T6 is consumed from `main` (#1171, branch rebased onto it) | User's instruction and plan Rule 2; T7 depends on T6; user confirmed T6 merged | S:95 R:85 A:95 D:95 |
| 2 | Confident | "Open escalation" = item not done AND its newest note is `by: run` with text starting `escalated:`; cleared by any newer note or completion; derived client-side from the payload | The engine writes `escalated:` once per condition; the payload carries only `latestNote`; the design page says the band's read "already rides the sessions payload" | S:60 R:85 A:65 D:55 |
| 3 | Confident | "Waiting prompt" = tracked worker row (live window) not done with `agentState === "waiting"`; action text `answer the prompt in <window>`; one row per item, waiting wins over escalation | Brief: "per `waiting` prompt (from `operatorTracked`)"; payload has no question text | S:70 R:90 A:75 D:70 |
| 4 | Confident | Add `POST /api/operator/notes {server,id,text}` writing a `by: user` note via `operator.AddNote`; the composer is new | No write path exists today; the Brief's `note…` action and "after a successful write" presuppose one; design page lists a note composer on Tasks | S:65 R:75 A:70 D:60 |
| 5 | Confident | The endpoint writes rk's state file only; a server on fab's legacy file gets 404, fab's file untouched | rk never writes fab's ledger; post-adopt servers all have rk's file | S:55 R:85 A:75 D:70 |
| 6 | Certain | Composer calls `postOperatorWake(server, "note:<id>")` after a successful write; a failed wake is non-fatal ("next check will pick it up") | Brief puts the wake in the composer; plan decision "Notes are triggers" makes the note a condition regardless | S:75 R:90 A:80 D:70 |
| 7 | Confident | Composer reachable from the band's `note…` and from every row's expanded notes list (`add note…`) | Design page Tasks row: "items, notes, a note composer"; reuses the existing expand-in-place list | S:50 R:90 A:65 D:55 |
| 8 | Confident | Cron segment = new `CronConsole` stacking unchanged `CronList` (≈40 % height cap, own scroll) over unchanged `CronLog` (rest); each keeps its toolbar and detail sheet; `show loop` default off | Brief: "the existing tables stacked, the detail sheet unchanged; loop rows behind the T6 toggle"; registry is short, deliveries long | S:75 R:90 A:70 D:60 |
| 9 | Confident | `?tab=` accepts `terminal`/`tasks`/`activity`/`cron`; legacy `log` AND `list` normalize to `cron` for one release | Brief names `log` (the push deep-link token); `list` was equally valid until now and mapping it costs nothing | S:70 R:90 A:75 D:65 |
| 10 | Certain | Backend push deep-link `cronPushTab` switches to `cron` | New pushes should name the real segment; old ones survive via the normalization | S:65 R:90 A:85 D:80 |
| 11 | Confident | Palette list/log actions collapse into one `Operator: Show cron` (`quake-terminal-cron`); band actions are row-scoped controls like the table's existing row navigate/expand, keyboard-reachable by Tab | Constitution V; segment-level palette parity kept, per-item controls follow the existing table precedent | S:55 R:90 A:70 D:60 |
| 12 | Certain | Plan review bar copied into Non-goals and quoted in every review dispatch | Plan Rule 4, verbatim | S:95 R:90 A:95 D:95 |
| 13 | Certain | PR evidence: desktop + mobile `just demo` recordings, before/after | Plan Rule 6; Constitution § PR Evidence | S:95 R:85 A:95 D:95 |
| 14 | Certain | No CLI surface change, so no help text / skill topic / help-dump fixture updates | Plan Rule 5 triggers only on a CLI surface change; T7 is UI + one HTTP endpoint | S:70 R:90 A:85 D:80 |

14 assumptions (6 certain, 8 confident, 0 tentative, 0 unresolved).
