---
type: memory
description: "The operator state engine — `internal/operator`'s tracked-item schema (kinds, probe modes, caps, notes, reported conditions), the rk-owned per-server state file, its tolerant-read/typed-write + sidecar-lock + atomic-write contract, the `rk operator track` verbs, the read-only `rk operator adopt` import, and `operator.Check` / `rk operator check` — the two-phase, edge-triggered probe-and-diff gate that runs before any model call."
---
# Operator State

**Domain**: run-kit

## Overview

The operator's tracked-item ledger is a plain YAML file that rk owns and writes, one per tmux server, at `<apphome.StateDir()>/operator/<slug>.yaml` (`$XDG_STATE_HOME/hexokit/operator/<slug>.yaml`). `internal/operator` (`app/backend/internal/operator`) is the library behind it — schema, store, verbs, importer — and `rk operator track …` / `rk operator adopt` / `rk operator check` (`cmd/rk/operator_track.go`, `operator_adopt.go`, `operator_check.go`) are its CLI doors. The schema is the one fab-kit's operator already uses (ported), plus per-item **notes** as the operator's memory and a per-item `reported` list that makes the check edge-triggered. `operator.Check` is the deterministic gate of the operator loop — clock → check (Go, no model) → nothing changed → stop; changed → a model run — and is a library call with no daemon caller, HTTP route, or cron entry yet. The file is also the display source: the sessions payload (the watchlist join, the staleness facts, `operatorTracked`) and `GET /api/operator/notes` read it read-only through the tolerant cron reader whenever it exists, with fab's file read only while it does not ([cron](/run-kit/cron.md) § External Contracts); nothing on the read path creates, converts, or writes it, and nothing adopts on read. The file is a plain-file durable source under Constitution II — a fresh daemon rebuilds from it with no cache.

## Requirements

### Requirement: Schema

`TrackedItem` field order pins the YAML key order and the JSON tags mirror the YAML names:
`id, kind, probe{mode, argv, fields, instruction}, check_every, done_when, then, depends_on, scope, last, seen (omitempty), notes (omitempty), reported (omitempty), checked_at, unchanged, failures, paused, done_at, added_at, updated_at`. `reported` is the condition keys the last check already surfaced; only `Check` writes it (adopt never sets it, `track list --json` shows it). The file's other typed top-level keys are `branch_map` (`{<change-id>: {branch, repo}}`) and `last_check_at` (RFC3339 UTC of the last successful check; omitted until the first check; every other verb preserves it). There is no `text` field and no `clock_override`.

- **Kinds**: `pane, github-pr, linear, slack, shell, task, note`. Each kind allows exactly its default probe mode — `pane`→`pane`, `github-pr`/`shell`→`shell`, `linear`/`slack`→`agent`, `task`/`note`→`none` — and a non-default `--probe` is rejected. `github-pr` defaults `done_when` to `state == "MERGED"` and its probe fields to `state,mergedAt,mergeable`; a `shell` item requires `--argv`, `--fields`, and `--done-when`.
- **Constants**: probe subprocess timeout 10s, failure-pause cap 3 (the third consecutive failure sets `paused`), `seen` cap 200 (oldest pruned), `check_every` floor 1m and default `5m` (shell/agent items; forced `null` for pane/none), staleness multiplier 2 (an agent item is stale when `now − checked_at > 2 × check_every`, `checked_at` null falling back to `added_at`).
- **Pane scope** seeds eleven pinned keys as `null`: `pane, pane_pid, change, repo, session, branch, stage, agent, stop_stage, spawned_by, merge_mode`.
- **Merge modes** for `scope.merge_mode`: `cherry-pick-ladder`, `stacked-prs`, `merge-auto`. An omitted `--mode` leaves `merge_mode` null; the library reads no config.
- **`done_when` grammar** (`predicate.go`, `Parse` / `Predicate.Eval`): one or more `<path> <op> <literal>` clauses joined by ` and `; `<op>` is `==` or `!=`; the literal is a JSON scalar; the path is a field name or dotted path, and a path absent from the evaluated object compares as null. `or`, comparison operators, regex, and functions are parse errors. An item is *done* when its persisted `done_at` is set (a pane item's built-in completion wins) or its `done_when` holds against `last`.
- **Errors** split into `InvalidError` (a caller mistake — bad flag value, schema violation) and everything else (IO, lock, missing item); the CLI maps the first to exit 2 and the rest to exit 1.

### Requirement: Notes

Every item carries `notes: [{at, by, text}]`, an append-only memory list. `at` is RFC3339 UTC set by the library; `by` is `user | run | chat`; `text` is trimmed, non-empty, and at most 1000 runes — over-length is an error, never truncated. At most 50 notes are kept per item: the 51st append drops the oldest. Appending touches `updated_at`. There is no per-note delete: a note leaves only by cap pruning or with its item (`track rm`). A `kind: note` item is an item whose content is its notes list, created with its first note.

### Requirement: Store — path, tolerant read, locked atomic write

- **Path and slug**: `StatePath(socketPath)` joins the state home, `operator/`, and `cron.FabOperatorSlug(socketPath)` + `.yaml` — the same injective socket-path rule fab uses (`-`→`--`, strip the leading `/`, `/`→`-`, empty → `default`), so one server maps to one file and adopt is a 1:1 mapping. The socket path comes from `tmux.SocketPath` (seam `socketPathFn`); a query failure yields `""` and so the slug `default`. The directory is mode `0700`, the data and lock files `0600` (notes can carry agent output).
- **Display read**: the daemon's read is not `Load` but the tolerant `cron.ReadOperatorState` over this same file, selected by existence (`sessions.resolveOperatorStatePath`): the file existing — even empty — makes it the source; a corrupt one yields no list and no fall back to fab's file. A note's `at` is read tolerantly to unix seconds, and the newest note and the note count ride the sessions payload while the full list is served on demand ([api-and-sockets](/run-kit/api-and-sockets.md) § `/api/operator/notes`).
- **Read** (`Load`): lock-free. A missing file is an empty state; an unparsable file is a hard error naming the path. `fsatomic` writes guarantee a reader sees the old or the complete new file.
- **Typed write**: the file is decoded into `tracked`, `branch_map` and `last_check_at` typed fields plus the remaining top-level keys. A mutation re-marshals the owned sections from the typed fields — a field invented inside `tracked` does not survive — and writes the other top-level keys back verbatim, so unknown top-level keys survive.
- **Mutate**: `Mutate(path, fn)` creates the directory, takes an exclusive `flock` on the sidecar `<slug>.yaml.lock`, re-reads the data file inside the lock (external writes win), applies `fn` to the typed state, writes with `fsatomic.WriteFile`, and releases the lock on every return path. A failing `fn` writes nothing; an `fn` returning the internal `errNoWrite` writes nothing and succeeds. Success is returned only after the rename — no cache, no write-behind. The lock is polled non-blocking every 25ms for at most 5s, then fails with `ErrBusy` ("operator state file busy"). The lock is never taken on the data file, because the rename-based write would orphan it; the lock file is created lazily and left in place.
- **Timestamps** (`added_at`, `updated_at`, `checked_at`, note `at`) come from one injectable `clock`, formatted `time.RFC3339` in UTC; no verb accepts a timestamp.

### Requirement: `rk operator track`

`track` is a child of `operatorCmd` with `-L/--server` as a persistent flag (default: the caller's own server from `$TMUX` via `cliServerLabel(operatorOriginalTMUXFn())`, else the default server; a named server is validated through `validate.ValidateServerName`, a usage error on failure). Verbs, each a thin flag-to-library layer:

| Verb | Behavior |
|---|---|
| `add <id> --kind <k>` | Flags `--probe --argv (repeatable) --fields --instruction --check-every --done-when --then --depends-on --scope (JSON object) --mode`, the pane flags `--pane --repo --session --branch --stage --agent --stop-stage --spawned-by --change`, and `--text`/`--by` (kind `note` only; `--by` defaults to `user`). Validation: known kind, kind-allowed probe, shell argv/fields/done-when, a parseable `done_when`, a unique id, `depends_on` existing and not self, `check_every` normalized. `github-pr` builds `gh pr view <n> [--repo <nwo>] --json state,mergedAt,mergeable` from `scope.pr`; `--repo` comes from `gh repo view --json nameWithOwner` run in `scope.repo` (argv-only `exec.CommandContext` under the 10s probe timeout, seam `ghNameWithOwnerFn`) and its failure is an add-time error. A pane item records `scope.pane_pid` through `tmux.PanePIDCtx` (seam `panePIDFn`, 5s bound; any failure stores `null`), and with both `branch` and `repo` writes `branch_map` keyed by `scope.change`, else the item id. Pane flags and `--mode` on a non-pane kind are usage errors. The external lookups run before the lock is taken. |
| `update <id>` | `--check-every --done-when --then --depends-on --scope`; only flags given change; an empty `--done-when`/`--then` clears to null; `--scope` merges per key and a changed `scope.pane` re-records `pane_pid`. |
| `observe <id>` | Exactly one of `--json <object>` (here the observed fields, not an output switch) or `--error <msg>`; `--seen <id>` repeatable. A success stores `last` per `probe.fields` (dotted paths, absent ⇒ null), bumps `unchanged` when `last` is unchanged else resets it, zeroes `failures`, appends unseen `seen` ids and prunes to 200. A failure counts toward the pause cap. |
| `rm <id>` | Removes the item and its notes. A *done* item is also dropped from every dependent's `depends_on` so the chain advances; a not-done removal keeps the edges. `branch_map` is untouched. |
| `list [--kind k]` | A pure read — never locks, writes, or converts. One line per item `id · kind · state · checked-age · next`; states `done, paused, held, pending, stale, live, watching`; `--json` emits the full items array including notes. |
| `note <id> <text> [--by user\|run\|chat]` | Appends a note; `<text>` of `-` reads stdin (capped at 64 KiB). |
| `pause <id>` / `resume <id>` | `pause` sets `paused`; `resume` clears it and zeroes `failures`. |

Mutating verbs print one `<action> <id>` line (`add` with `--mode` first prints `mode: <m> (flag)`) or, with `--json`, the shared `outputSink` envelope around `{id, action, mode?}`. Exit codes: 0 ok, 1 operational (duplicate id, no such item, state file busy or unreadable), 2 usage. `track clock` and `update --text/--pause/--resume` do not exist.

### Requirement: `rk operator adopt`

`rk operator adopt [--from <fab-state.yaml>] [-L <server>] [--dry-run] [--json]` is the one explicit import of fab's operator state file into rk's. Nothing else calls `operator.Adopt` — no verb, the daemon, or the sessions payload adopts on read.

- **Source**: `--from`, else `cron.FabOperatorStatePath(cron.FabOperatorSlug(socketPath))`. A missing source prints `nothing to adopt (no fab operator state at <path>)` (under `--json`, the envelope with empty lists), exits 0, and creates no rk file.
- **Read-only against fab's file**: it is read with `os.ReadFile` — never written, locked, renamed, or converted on disk; conversion happens in memory.
- **Legacy shapes** convert in memory when `tracked` is absent and any of `monitored`, `watches`, `autopilot`, `notes` is present: `monitored` entries → `pane` items (`scope.change` = the id, `checked_at` = `last_transition`); `watches` → `linear`/`slack` agent items (`seen` = `known ∪ completed`, `paused = !enabled`, `then` = the watch's instructions); the not-yet-completed `autopilot` queue → chained `pane` items carrying `scope.merge_mode` (default `cherry-pick-ladder`), chained to the nearest same-repo predecessor; open `notes` → `kind: note` items keeping their ids (resolved ones dropped). A retired `kind: fab-change` item becomes `kind: pane` with `scope.change` = its id and `scope.pane_pid` null. A legacy file whose autopilot `state` is `running` is refused — exit 1, nothing written.
- **Notes seed**: a fab `kind: note` item's `text` becomes its first note `{at: updated_at (fallback added_at), by: user, text}`; the `text` field is not carried. A note item with no text is invalid.
- **Not carried / carried**: `clock_override` is dropped; `branch_map` is carried (a key is added only when absent); unknown top-level keys of fab's file are ignored.
- **Merge, never clobber**: the merge runs through `Mutate`. Items are matched by id; an id already present in rk's file is left untouched and reported skipped, an absent id is appended in source order. Re-running adopts only what is new, and a run that changes nothing writes nothing.
- **Validation on the way in**: each converted item passes `validateItem`; an invalid or unreadable item, or a duplicate id within the source, is skipped and reported `{id, reason}` rather than failing the run. Legacy note prose over the caps is trimmed (text to 1000 runes, newest 50 notes kept, unknown `by` ⇒ `user`) and recorded as a warning on stderr.
- **`--dry-run`** loads the target (no directory, no lock), computes the merge, and writes nothing.
- **Output**: `adopted <n> item(s), skipped <m> (already present)[, <k> invalid][ [dry run]]` plus one `skipped <id> (already present)` / `invalid <id>: <reason>` line per id; `--json` emits `{source, target, adopted, skipped, invalid, dry_run}` through the envelope. Exit codes: 0 adopted / nothing to adopt / dry-run complete, 1 operational (unreadable source, running legacy queue, state file busy), 2 usage.

### Requirement: `operator.Check` — two-phase gate

`Check(ctx, server, CheckOptions) (CheckResult, error)` probes every due item, diffs it against the stored baselines, writes the new baselines in one locked write, and returns what changed. `server` is the tmux server label (`""` = default), resolved to the state path with `StatePathForServer`. `CheckOptions.Budget` bounds the wall clock spent *starting* shell probes (zero ⇒ 60s). Test seams are package-level vars (`paneSnapshotFn`, `agentAliveFn`, `probeRunnerFn`, `ghAvailableFn`, `gitBranchFn`) plus the store's `clock`.

- **Phase 1 — observe, lock-free**: `Load` the file; when some `probe.mode == pane` item has a non-null `scope.pane`, take ONE pane snapshot of the server, resolve `agent_exited` (the process-tree walk) and the branch lookups for the panes tracked items point at, then run every due shell probe sequentially. Nothing is written, and no subprocess or `/proc` crawl ever runs under the state lock — the lock gives up after 5s while a probe budget is 60s, and the chat, runs, and the daemon all write the same file.
- **Phase 2 — apply, under one `Mutate`**: re-read the file (external writes win), then for each item still present by id apply the probe outcome — only while the item's `probe.argv` and `checked_at` equal their phase-1 values, otherwise the result is discarded and the external observation stands — apply the pane baselines, derive the condition set and edge verdicts, and write `done_at`, `reported`, `branch_map` and `last_check_at` once. An item added during phase 1 is evaluated without a probe; an item added or re-pointed (`scope.pane` changed) during phase 1 skips the pane diff that round and keeps its stored pane condition keys, so it is never falsely reported `pane_death`. Success is returned only after the atomic rename. Two concurrent checks serialize in phase 2; the second sees the first's `reported` and reports no duplicate edges.
- An empty `tracked` list takes no snapshot, runs no probe, returns `changed: false`, and still writes `last_check_at`.
- A dead tmux server (an empty session list that fails `ServerAlive`) is a `Check` error, never an empty snapshot — that would report `pane_death` for every tracked pane.

### Requirement: Pane state comes from rk's own data

The pane snapshot is `tmux.ListSessions` + `ListWindowsStrict` on the server: per pane `PaneID, Cwd, Command, PanePID, AgentPID`, the reconciled `AgentState` and `AgentStateEpoch`, plus change / stage / display state from `fabstatus.Memo.Derive(cwd)`. fab's CLI is never invoked, so the operator watches panes with no fab installed (stage-derived deltas simply do not occur). Per pane item (`probe.mode == pane`, non-null `scope.pane`, no `done_at`), first match wins:

- **`pane_death`** — the pane id is absent from the snapshot; baselines untouched.
- **`pane_mismatch`** — recorded non-zero `scope.pane_pid` differs from the pane's current `PanePID` (tmux recycled `%N` across a server restart); `found` is the pane's observed change id or null. A null recorded pid, or an unknown current one, joins on the pane id alone.
- **`agent_exited`** — the foreground `Command` is a shell (`tmux.IsShellCommand`) and no live agent exists: the reconciled state is empty or `AgentPID` is 0 AND the `proctree` walk from `PanePID` finds no agent. A walk error counts as "agent alive" (no evidence must not fabricate an exit). `command` is the foreground command.
- **Clean join**, in order: (a) *change appear/switch* — an observed change id that is non-empty and differs from `scope.change` is a `changed` event `fields: {change: {from, to}}` and updates the baseline (an unresolved observation never clears it); (b) *`branch_map`* — an observed change without an entry, with a non-empty `scope.repo`, gains `{branch, repo}` from `git -C <cwd> branch --show-current` (argv-only, 10s; empty/failed results skip and retry next check); (c) *built-in completion* — only with a non-null `scope.change` and a resolved stage: `stop_stage` null ⇒ done at `ship` with display state `done`/`skipped`; `stop_stage` set ⇒ done when past it in stage order (`intake, apply, review, hydrate, ship, review-pr`) or at it with `done`/`skipped`; `done_at` is persisted in the same write so the verdict survives the pane disappearing; (d) *`stage_advance` / `review_fail`* — a resolved stage differing from a non-empty `scope.stage` is an event with `pane, from, to` (`review → apply` is `review_fail`) and updates the baseline; no baseline stage diffs against nothing; (e) *agent state* — `scope.agent` ← the observed state verbatim (null when unknown); `waiting` and `idle` are standing conditions (`agent:waiting`, `agent:idle`), while `active` and unknown only move the baseline, mirroring `internal/cron/wake.go`'s classification. The `agent_state` delta carries `pane, from, to, duration` (`tmux.FormatAgentDuration` since `AgentStateEpoch`); once its key is already reported it lists under `open` with no `from`.
- A user-paused pane item still runs the diff (baselines and events advance, so resume does not fire a burst) but yields no conditions; a done item is inert.

### Requirement: Shell probe runner

- **Due rule**: `probe.mode == shell`, not paused, not done, and `checked_at` null/unparsable or `now − checked_at ≥ check_every` (missing or invalid `check_every` ⇒ 5m). One helper (`cadenceElapsed`) serves shell and agent items.
- **Runner**: argv-only `exec.CommandContext` bounded by the 10s `probeTimeout`, caller's environment inherited, `exec.LookPath(argv[0])` first. Errors compose to one line — `exit <n>: <first stderr line>`, `timeout after 10s`, or the lookup error. Probes run sequentially.
- **`github-pr`** items first consult `ghprobe.Available`; when gh is missing or logged out the item is skipped with `checked_at` and `failures` untouched and a `gh_unavailable` notice (other shell items still run).
- **Outcome** (`checked_at` ← completion time): a non-zero exit, timeout, or stdout that is not a JSON object is a failure — `failures++`, `paused` set at the cap of 3, a `probe_error` notice. A success zeroes `failures`, extracts `probe.fields` (dotted paths, absent ⇒ null; `extractProbeFields` + `normalizeJSONNumbers`); equal to `last` ⇒ `unchanged++`, different ⇒ a `changed` event with per-field `{from, to}`, `unchanged = 0`, `last` ← new, `updated_at` ← now.
- **Budget**: items still due once the deadline passes record a `skipped` notice (`skipped (check budget)`) with `failures` untouched.
- `linear`/`slack` items (probe mode `agent`) are never executed by `Check`; they become `due`/`stale` conditions and the run does the query.

### Requirement: Conditions and edge-triggered verdicts

Each check derives every item's current condition-key set and compares it with the item's stored `reported`:

| Key | Holds when |
|---|---|
| `done` | `done_at` set, built-in completion fired this check, or `done_when` holds against `last` |
| `pane_death`, `pane_mismatch`, `agent_exited` | the pane cases above |
| `agent:waiting`, `agent:idle` | clean join with that observed agent state |
| `paused` | `paused` with `failures ≥ 3` (the probe-failure pause) |
| `stale` | agent item with `now − (checked_at ?? added_at) > 2 × check_every` |
| `due@<checked_at ?? added_at>` | agent item, not paused/done, past `check_every` — keyed by the base timestamp, so it fires once per due period |
| `unknown_dep:<id>` | a `depends_on` id missing from the list (one key per missing id) |

A done item yields only `done` plus any `unknown_dep:*`; a user-paused item below the failure cap yields only `unknown_dep:*`. A key absent from `reported` is **new** and goes into `changes`; a key already in `reported` goes into `open`. After evaluation `reported` is replaced by the current set, sorted (empty ⇒ omitted), so a condition that clears and returns fires again. **Event deltas** — `changed` probe fields, change appear/switch, `stage_advance`, `review_fail` — are always new; their baselines are consumed in the same write. **Notices** (a single probe failure below the cap, a budget skip, gh unavailable) never gate; reaching the cap produces the gating `paused` condition. `changed = len(changes) > 0`.

### Requirement: `CheckResult` shape

`{checked_at, changed, changes, open, notices}`; the three lists marshal as `[]` when empty and are ordered by tracked-list order, then emission order. `CheckDelta` carries `kind, id` plus the kind's fields in a pinned key order: `pane` (pane kinds and `agent_state`), `fields` (`changed`), `then` (`done`: the item's `then` or null), `age` (`stale`, `due`), `instruction` (`due`), `error`/`failures`/`paused` (`paused`), `found` (`pane_mismatch`, nullable), `command` (`agent_exited`, nullable), `from`/`to` (`stage_advance`, `review_fail`, `agent_state`), `duration` (`agent_state`), `dep` (`unknown_dep`). Kinds: `changed, done, pane_death, pane_mismatch, agent_exited, stage_advance, review_fail, agent_state, paused, stale, due, unknown_dep`. `CheckNotice` is `{id, kind, error, failures}` with kinds `probe_error`, `skipped`, `gh_unavailable`. fab's chat render frame (`tick_count`, `last_tick_at`, `fleet_summary`, rendered `items:` rows, `candidates:`) has no counterpart.

### Requirement: `rk operator check`

`rk operator check [-L <server>] [--json]` calls `operator.Check` in-process (no daemon needed) and writes the baselines exactly as the daemon's call does — it consumes the edges it reports, so an immediate second run lists them under `open`. `-L/--server` is the same resolution as `track` (`operatorServer`: explicit and validated through `validate.ValidateServerName`, else the caller's own server from `$TMUX`). Human output: a header `no change` or `changed <n>`, followed by `, open <n>` and `, notices <n>` when non-zero, then one tab-aligned `<new|open|note>  <id>  <kind>  <detail>` row per change, open condition, and notice. `--json` emits `CheckResult` through the shared `outputSink` envelope. Exit codes: 0 checked (changed or not), 1 operational (state unreadable or busy, tmux listing failure), 2 usage. There is no `--dry-run`; `track list --json` is the read-only view.

### Requirement: Surface conformance

`rk help-dump` walks the cobra tree, so `operator adopt`, `operator check`, and `operator track` with its eight verbs appear without a fixture change. Help text follows the toolkit conventions — Examples and Exit codes sections, no backticks in flag help ([toolkit-standards](/run-kit/toolkit-standards.md) § A new command surface is checked against help-dump and Principle 9). The verbs and `check` are CLI-only: the MCP proxy's allowlisted table has no rows for them.

## Design Decisions

### Sidecar lock, locked re-read, lock-free reads
**Decision**: Writers hold `flock` on `<slug>.yaml.lock` and re-read the data file inside it; readers take no lock.
**Why**: `fsatomic` replaces the data file by rename, so a lock on it would be orphaned; the atomic rename gives readers a complete file; the re-read makes external writes win (Constitution II). The operator chat, scheduled runs, and the daemon write the same file concurrently.
**Rejected**: Locking the data file (broken by the rename); an in-memory cache (violates durable-before-acknowledged).
*Introduced by*: 261111-7iz0-operator-state-engine

### Notes replace `text`; `kind: note` stays
**Decision**: Prose lives only in `notes`; a note item is an item whose content is its notes list; adopt turns fab's old `text` into the first note.
**Why**: One concept and one place for prose; the notes list is the operator's memory across runs.
**Rejected**: Keeping both `text` and `notes` (two concepts for the same prose).
*Introduced by*: 261111-7iz0-operator-state-engine

### Count-capped, append-only notes
**Decision**: 50 notes per item (oldest pruned) and 1000 runes per note (error, never truncation); no per-note delete verb.
**Why**: Readers (run brief, drawer) want a bounded number of entries; the rune cap bounds bytes indirectly; literal append-only keeps a chat and a run from erasing each other's memory. A delete verb can be added later without a migration.
**Rejected**: A byte budget (harder to explain to a writer); a delete verb (a race over memory).
*Introduced by*: 261111-7iz0-operator-state-engine

### Adopt is explicit and merge-never-clobber
**Decision**: Adopt is invoked only by the user, reads fab's file read-only, matches by id, and never overwrites an id rk already holds; there is no `--force`.
**Why**: Until cutover the live operator keeps using fab's file through the installed binaries, so import must not disturb it; rk's copy may already have progressed past fab's (Constitution II — external/rk writes win); a legacy file on disk may be hand-drifted, so one bad item is skipped, not fatal.
**Rejected**: Automatic adopt on read (hidden writes, races the live operator); replace-on-readopt (clobbers progress).
*Introduced by*: 261111-7iz0-operator-state-engine

### Display reads rk's file when it exists, never adopting
**Decision**: The sessions payload and the notes route read rk's operator file whenever it exists on disk (even empty or corrupt, with no fall back) and fab's file otherwise; the read is tolerant and read-only.
**Why**: After adopt or the first `rk operator track add`, rk's file is the ledger, so fab's frozen copy must not be shown as live; before either, no server has an rk file, so live drawers keep reading fab's file unchanged and the display ships ahead of cutover.
**Rejected**: Auto-adopting on read (hidden writes that race the live operator); falling back to fab's file when rk's is empty or corrupt (resurrects the pre-adopt ledger).
*Introduced by*: 261111-0982-operator-tasks-rk-state-notes

### Port fab's schema, drop its clock and text
**Decision**: The schema, caps, predicate grammar, and legacy conversion are ported from fab-kit, while `clock_override`/`track clock` and the note `text` field are not; `branch_map` is carried with no `rm` verb, and kind `task` is kept.
**Why**: fab's code is battle-tested and keeping its shape lets adopt import files real operators already have; next-check timing is rk's own backoff, so a clock override has no owner here; `task` items and `branch_map` entries exist in live data and would be lost on adopt.
**Rejected**: Redesigning the schema (risk to live data); dropping `task` or `branch_map` (silent loss at adopt).
*Introduced by*: 261111-7iz0-operator-state-engine

### Edge-triggered standing conditions
**Decision**: Standing conditions (done, pane death/mismatch, agent exited, waiting/idle, failure-pause, stale, due, unknown dependency) are reported in `changes` once, when their key first appears in an item's condition set, then listed in `open`; the item's `reported` field holds the last-reported set.
**Why**: Under the run loop every change launches a paid model run; fab's level-triggered re-emission would relaunch a run on every fire for a condition a run chose to leave alone.
**Rejected**: Porting fab's level-triggered deltas (cost repeats until a run acks); a separate cursor sidecar (memory split from the item, extra file to reconcile).
*Introduced by*: 261111-zm04-operator-check-probe-diff

### Probe outside the lock
**Decision**: The check observes (pane listing, process walk, probes) lock-free, then applies all results in one `Mutate`, discarding a probe outcome whose item's `checked_at` or argv moved meanwhile.
**Why**: Probes can take up to the 60s budget while the lock gives up after 5s; the chat, runs, and daemon all write the same file, and external writes must win (Constitution II).
**Rejected**: Probing inside the mutation as fab does (writers hit `ErrBusy`); raising the lock timeout (still blocks the chat for a minute).
*Introduced by*: 261111-zm04-operator-check-probe-diff

### Pane facts from rk, not fab
**Decision**: Pane state comes from rk's tmux listing, its reconciled agent state, its `.fab-status.yaml` derivation, and its process-tree walk, living in `internal/fabstatus` and `internal/proctree` so `internal/operator` can import them.
**Why**: The operator must work without fab; `cmd/rk` is package main and `internal/sessions` will import `internal/operator`, so the shared pieces need neutral homes.
**Rejected**: Shelling out to `fab pane map` (fab dependency, a subprocess per check); importing `internal/sessions` from `operator` (import cycle once the sessions payload reads operator state).
*Introduced by*: 261111-zm04-operator-check-probe-diff
