# Intake: Operator State Engine

**Change**: 261111-7iz0-operator-state-engine
**Created**: 2026-11-11

## Origin

> Plan step R1 (Operator state engine: schema, `rk operator track`, `rk operator adopt`) from the plan at `/home/sahil/code/sahil87/hexokit.worktrees/arcing-fjord/fab/plans/sahil/26-11-10-operator-to-hexokit.md` — read that file (Rules, Decisions, and the R1 brief) first. Port from fab-kit's `src/go/fab/cmd/fab/operator_track*.go` and `operator_migrate.go` (fab-kit checkout). Do not touch or restart the live rk daemon or installed binaries; no automatic adopt on read.

Initiated one-shot by `/fab-new` from the plan's R1 brief (the plan came out of a `/fab-discuss` session, 2026-11-08 → 11-10, and was moved here from fab-kit on 2026-11-11). The plan's *Decisions already taken* table is binding and is not reopened here; its **Open decisions** row for R1 (notes cap/shape, who may delete a note) is resolved in this intake and recorded in the Assumptions table.

Sources read while writing this intake:

- Plan: Goal, Decisions, Rules, the R1 brief, and the R2/R3/R5 briefs (they consume what R1 builds).
- fab-kit (`2147ecdd`, `src/go/fab/cmd/fab/`): `operator_track.go` (verbs), `operator_track_types.go` (schema, caps, predicates, staleness, held-dep), `operator_state.go` (tolerant-read/typed-write IO, `slugify`, `StatePath`), `operator_migrate.go` (legacy conversion), and `internal/predicate/predicate.go` (the `done_when` grammar). `operator_clock*.go`, `operator_tick_start.go`, `operator_time.go` and `operator.go` are **not** ported here (R2 / R5 own them).
- run-kit (this repo): `internal/cron/{dir,watchlist,lock}.go` (fab-file path logic, tolerant reader, flock idiom), `internal/fsatomic`, `internal/apphome` (state-home resolution), `internal/tmux` (`SocketPath`, `PanePIDCtx`), `cmd/rk/operator.go` + `operator_request.go` (the `rk operator` command and its `-L/--server`, `--json`, exit-code conventions), and `fab/project/constitution.md`.

## Why

**Problem.** Today the operator's tracked-item ledger lives in a file fab owns (`$XDG_STATE_HOME/fab/operator/<slug>.yaml`) behind `fab operator track …`, while rk reads that file tolerantly for display (`internal/cron/watchlist.go`) and the cron clock that drives the operator lives in rk. The seam between the two repos is where the operator has broken before (cron seed ownership moved three times; the JSON-envelope regression zx5k). The plan moves the whole operator loop into HexoKit; every later step (the in-daemon check R2, the drawer reading rk's own state R3, the run brief R4, the loop R5) needs a **state file rk owns and can write**, with the same schema the operator already uses plus the one new concept the plan adds — **notes as memory**.

**R1 is the foundation of that move.** It ships the typed state engine and the two CLI doors into it: `rk operator track …` (the operator/chat/runs write path) and `rk operator adopt` (the one-time, explicit import of the existing fab file). Without it R2–R5 have nothing to read or write; with it they can proceed in parallel lanes (the plan's R2/R3/R4 lane after R1).

**Consequence of not doing it / doing it wrong.** If the schema or the write path is wrong, every downstream step inherits the error, and the live data (a week of tracked items and notes on `snappy-gopher`-class operators) is at stake at cutover (C1). Two properties are therefore load-bearing and drive the design:

1. *Concurrent writers.* The operator chat, scheduled runs, and the daemon will all write the same file (plan R1). Constitution II requires "durable before acknowledged; external writes win" — hence a lock plus re-read-inside-the-lock on every mutation, on top of `fsatomic` temp+rename.
2. *The live operator must not be disturbed.* Until C1 the live operator keeps using fab's file through the **installed** fab/rk binaries. So `adopt` is explicit and read-only against fab's file, and nothing in R1 auto-adopts on read, touches the daemon, or modifies installed binaries.

**Why port rather than reinvent.** fab's schema, caps, predicate grammar and legacy-migration code are already battle-tested by ≈ 5,200 lines of tests (`operator_track_test.go`, `operator_track_types_test.go`, `operator_migrate_test.go`, …). Porting the code *and* its tests is lower risk than redesigning, and it keeps `adopt` a faithful importer of files that real operators already have on disk (including fab's legacy shapes).

## What Changes

### 1. New package `app/backend/internal/operator/` (the engine, no CLI, no tmux except one seam)

Pure Go library. Files (names indicative; keep each focused):

| File | Content | Ported from |
|---|---|---|
| `schema.go` | Constants, kinds table, `probeSpec`, `TrackedItem`, `Note`, `State` | `operator_track_types.go` |
| `predicate.go` | `done_when` grammar: `Parse`, `Predicate.Eval` | fab `internal/predicate/predicate.go` (+ its test) |
| `store.go` | Path resolution, tolerant `Load`, atomic `Save`, lock, `Mutate` | `operator_state.go` (+ rk's `fsatomic`, `cron/lock.go` idiom) |
| `track.go` | Library ops: `Add`, `Update`, `Observe`, `Remove`, `Pause`, `Resume`, `AddNote`, `List` + list rendering helpers (state/age/next) | `operator_track.go` |
| `adopt.go` | Read fab's file, convert, merge into rk's file | `operator_migrate.go` + `operator_state.go` |
| `*_test.go` | Ported tests (see §6) | `operator_track_test.go`, `operator_track_types_test.go`, `operator_migrate_test.go`, `predicate_test.go` |

#### 1a. Schema (ported verbatim unless stated)

Kinds: `pane`, `github-pr`, `linear`, `slack`, `shell`, `task`, `note`. Each kind allows exactly its default probe mode (`pane`→`pane`, `github-pr`/`shell`→`shell`, `linear`/`slack`→`agent`, `task`/`note`→`none`); `github-pr` defaults `done_when: state == "MERGED"` and probe fields `state,mergedAt,mergeable`.

Constants (ported values): `trackProbeTimeout=10s`, `trackFailurePauseCap=3`, `trackSeenCap=200` (oldest pruned), `trackCheckEveryFloor=1m`, `trackCheckEveryDefault="5m"` (shell/agent items; forced `null` for pane/none), `trackStaleMultiplier=2`. (`trackTickBudget=60s` belongs to R2's probe runner and is **not** ported now.)

Item shape (YAML key order pinned by struct field order; JSON tags mirror):

```yaml
tracked:
  - id: pr-1234                    # unique, kebab/slug
    kind: github-pr
    probe: {mode: shell, argv: [gh, pr, view, "1234", --repo, o/r, --json, "state,mergedAt,mergeable"], fields: [state, mergedAt, mergeable]}
    check_every: 5m                # null for pane/none
    done_when: 'state == "MERGED"' # equality-only predicate, " and " joined
    then: null                     # prose the run executes when done/changed fires
    depends_on: []                 # item ids; must exist, not self
    scope: {pr: 1234, repo: /path} # free JSON object (pane kind seeds 11 pinned keys, below)
    last: {}                       # last observed probe fields
    seen: []                       # linear/slack only (omitempty), cap 200
    notes: []                      # NEW — see 1b (omitempty)
    checked_at: null
    unchanged: 0
    failures: 0
    paused: false
    done_at: null                  # durable built-in completion (pane items)
    added_at: 2026-11-11T09:00:00Z
    updated_at: 2026-11-11T09:00:00Z
branch_map: {}                     # see 1d
```

Pane scope seeds eleven pinned keys as `null`: `pane, pane_pid, change, repo, session, branch, stage, agent, stop_stage, spawned_by, merge_mode`.

**Differences from fab's schema (deliberate):**

- `text` (note-only field) is **removed**; free text lives in `notes` (1b). `kind: note` stays a valid kind — a free-standing note is an item whose content is its notes list.
- `clock_override` and the `track clock` verb are **not** ported (the clock moves to R5; plan Decisions: "rk's backoff + wake-on-agent-state-change only").
- Tolerant-read / typed-write posture is kept: unknown **top-level** keys survive a mutation; an invented field **inside** `tracked` does not (every mutation re-marshals the section from the typed structs).

#### 1b. Notes — the new concept (plan R1: "one append-only list per item, capped")

```go
type Note struct {
    At   string `yaml:"at"   json:"at"`   // RFC3339 UTC, set by the binary — no verb accepts a timestamp
    By   string `yaml:"by"   json:"by"`   // "user" | "run" | "chat"
    Text string `yaml:"text" json:"text"` // non-empty, trimmed
}
```

- `TrackedItem.Notes []Note` — `yaml:"notes,omitempty"`. Append-only: `AddNote` appends and touches `updated_at`.
- **Caps** (binary-enforced, resolves the plan's open decision): at most **50 notes per item** (oldest pruned first when the 51st is appended) and **1000 runes per note** (over-length is an error, never silently truncated). Count-based because the reader (run brief, drawer) wants a bounded *number* of entries; the per-note rune cap bounds bytes indirectly (worst case ≈ 50 × 1000 runes per item).
- **Deletion:** there is **no per-note delete verb** in R1. A note leaves only by cap pruning or by removing its item (`track rm`). This keeps "append-only" literal and avoids a chat/run racing to erase each other's memory; a delete verb can be added later if it proves necessary.
- `by` is validated against `{user, run, chat}`; unknown → usage error.

#### 1c. Store: path, tolerant read, locked atomic write

- **Path:** `<apphome.StateDir()>/operator/<slug>.yaml` → `$XDG_STATE_HOME/hexokit/operator/<slug>.yaml` (resolved through `apphome` so the dual-read home rule holds). Directory mode `0700`, file mode `0600` (the `cron` precedent — notes can contain agent output).
- **Slug:** derived from the tmux server's socket path with the **same injective rule fab uses** (`-`→`--`, strip leading `/`, `/`→`-`, empty → `default`) — reuse `cron.FabOperatorSlug` (move it, or call it, without duplicating the rule). Using the identical slug makes `adopt` a 1:1 file mapping and keeps one server ↔ one file. The socket path comes from `tmux.SocketPath(ctx, server)`; if it cannot be queried the slug is `default` (fab's behavior).
- **Server addressing (CLI):** `-L/--server <name>`, default "the caller's own server from `$TMUX`, else default" — exactly the `rk operator request` convention (`operatorOriginalTMUXFn` / `cliServerLabel`), because `internal/tmux`'s `init()` strips `$TMUX` from the process.
- **Read:** `Load(path)` is tolerant — missing file ⇒ empty state (not an error), unparsable file ⇒ hard error naming the path. Reads take **no lock**: `fsatomic.WriteFile` guarantees a reader sees the old or the complete new file.
- **Write:** `Mutate(path, fn)` = acquire lock → **re-read** the file (external writes win, Constitution II) → apply `fn` to the typed state → `fsatomic.WriteFile` → release. `fn` errors abort with nothing written.
- **Lock:** advisory `flock(LOCK_EX)` on a **sidecar** file `<slug>.yaml.lock` (never on the data file — `fsatomic` replaces it by rename, which would orphan the lock). Acquisition polls `LOCK_NB` for up to **5 s** (Constitution "Process Execution": nothing may hang), then fails with a clear "state file busy" error; the lock is released on every return path. The lock file is created lazily and left in place.
- **Durable before acknowledged:** every verb returns success only after `Mutate` has renamed the new file into place. No in-memory cache, no write-behind.
- Timestamps (`added_at`, `updated_at`, `checked_at`, note `at`) are computed in the library (`time.Now().UTC().Format(time.RFC3339)`) behind an injectable clock for tests; no verb accepts a timestamp.

#### 1d. `branch_map`

fab's `branch_map` (`{<change-id>: {branch, repo}}`, written when a `pane` item is added with both `branch` and `repo`) feeds dependency resolution. It is kept as a typed top-level section, written at `track add` for `pane` items exactly as fab does, and carried over by `adopt`. R1 ships **no** `branch-map rm` verb — its only consumer is R6's autopilot, which will own its lifecycle. (`track rm` never touches it, as in fab.)

### 2. `rk operator track` — verbs (new cobra subcommand of `operatorCmd`)

New files `cmd/rk/operator_track.go` (+ `_test.go`), registered in `operatorCmd.AddCommand(...)` next to `operatorRequestCmd`. `operatorCmd` keeps `Args: cobra.NoArgs`; subcommands dispatch before that check (as `request` already does). All verbs take `-L/--server` and `--json` (where output exists) and follow the toolkit exit-code convention (0 ok, 1 operational, 2 usage).

| Verb | Ported behavior |
|---|---|
| `track add <id> --kind <k>` | Flags: `--probe --argv(repeatable) --fields --instruction --check-every --done-when --then --depends-on --scope(JSON) --mode`, pane sugar `--pane --repo --session --branch --stage --agent --stop-stage --spawned-by --change`, and **`--text`/`--by`** (kind `note` only: creates the item with its first note; `--by` defaults to `user`). Validation = fab's: known kind, kind-allowed probe, shell needs `--argv`+`--fields` and (kind shell) `--done-when`, `done_when` must parse, unique id, `depends_on` exist and not self. `github-pr` builds `gh pr view <n> [--repo <nwo>] --json state,mergedAt,mergeable` from `scope.pr` (+ `gh repo view` for `--repo`, argv-only `exec.CommandContext` with timeout, behind an injectable seam; failure is an add-time error). Pane add records `scope.pane_pid` via `tmux.PanePIDCtx` (any failure ⇒ `null`). Pane items with `branch`+`repo` write `branch_map`. |
| `track update <id>` | `--check-every --done-when --then --depends-on --scope(merge per key) --scope.pane re-fingerprint`. **`--text` is dropped** (notes are append-only via `note`). `--pause/--resume` flags are **not** kept on `update` — see pause/resume verbs. |
| `track observe <id>` | `--json <obj>` \| `--error <msg>` (exactly one), `--seen <id>…`. Stores `last` per `probe.fields` (dotted paths, absent ⇒ `null`), bumps `unchanged` vs `failures`, 3rd consecutive failure ⇒ `paused`, prunes `seen` to 200. This is the write R2's check and the runs use for agent probes. |
| `track rm <id>` | Removes the item. If the removed item was **done**, drops it from every dependent's `depends_on` (so the chain advances); not-done removal keeps the edges. `branch_map` untouched. Its notes go with it. |
| `track list` | One line per item `id · kind · state · checked-age · next` (states: done, paused, held, pending, stale, live, watching — ported `trackListState`), `--kind` filter, `--json` prints the full items array **including notes**. **Pure read: never writes, never converts.** |
| `track note <id> <text> [--by user\|run\|chat]` | **New.** Appends a note (1b). `--by` defaults to `user`; the chat skill and runs will pass `chat`/`run` explicitly (their skills land in R4). Text may also come from stdin when `<text>` is `-`. |
| `track pause <id>` / `track resume <id>` | **New verbs** (the plan names `pause`). `pause` sets `paused: true`. `resume` clears it **and zeroes `failures`** (fab's `--resume` semantics). |

Dropped vs fab: `track clock`, `update --text/--pause/--resume`. Output for `add` with `--mode` keeps fab's `mode: <m> (flag)` line.

`--mode` (merge mode for chained pane items): validated against `cherry-pick-ladder | stacked-prs | merge-auto` (plan Decisions / R6). R1 reads **no** config: when omitted, `scope.merge_mode` stays `null` and R6 resolves `flag > config > cherry-pick-ladder` at readiness time (plan R6: "Config key location … decided at intake" of R6). An explicit invalid mode is a usage error.

### 3. `rk operator adopt` — explicit, idempotent import

New `cmd/rk/operator_adopt.go` (+ test); library in `internal/operator/adopt.go`.

```
rk operator adopt [--from <fab-state.yaml>] [-L <server>] [--dry-run] [--json]
```

Behavior:

1. **Source:** `--from` if given, else fab's file for this server: `cron.FabOperatorStatePath(cron.FabOperatorSlug(socketPath))` (path logic already in `internal/cron/dir.go`). Missing source ⇒ not an error: prints `nothing to adopt (no fab operator state at <path>)` and exits 0 — and **creates no rk file**.
2. **Read-only against fab's file** — opened `O_RDONLY`; never written, locked, renamed or converted. (Fab's own read verbs convert-and-save legacy files; adopt must not. Conversion runs **in memory** on the parsed map.)
3. **Legacy shapes** are converted in memory by the ported `operator_migrate.go` logic: the pre-`tracked` sections (`monitored` → `pane` items with `scope.change` seeded and `checked_at = last_transition`; `watches` → `linear`/`slack` agent items with `seen = known ∪ completed`, `paused = !enabled`; `autopilot` queue → pane-less chained `pane` items with `scope.merge_mode`; open `notes` → `kind: note` items keeping their ids, resolved dropped) **and** retired `kind: fab-change` items (→ `kind: pane`, `scope.change = id`, `scope.pane_pid = null`). A **running** legacy autopilot queue refuses (exit 1, message adapted from `operatorLegacyRunningRefusal`) with nothing written — same safety rule as fab.
4. **Notes seed (plan: "Existing `kind: note` items are the seed"):** for every fab `kind: note` item (native or converted) the old `text` becomes the item's first note `{at: updated_at (fallback added_at), by: user, text}`; the `text` field is not carried. Other kinds have no `text` and gain no notes.
5. **Not carried:** `clock_override` (R5 owns the clock). **Carried:** `branch_map`. Unknown top-level keys in fab's file are ignored (they are fab's).
6. **Merge, never clobber (idempotent):** adopt runs through `Mutate`. Items are matched by `id`. An id **already present in rk's file is left untouched** (Constitution II: external/rk writes win — rk may have progressed past fab's copy); an id absent is appended in fab's order; `branch_map` entries are added only when the key is absent. Re-running adopt therefore adds only what is new and reports the rest as `skipped (already present)`.
7. **Validation on the way in:** each converted item passes `validateTrackedItem`-equivalent normalization; an invalid item (e.g. a hand-edited bad `probe.mode`) is **skipped with a named warning**, not fatal — the live file may be hand-drifted (fab's tolerant posture). Notes over the caps are truncated to the newest 50 / rejected-per-note text is trimmed to 1000 runes with a warning (adopt must not fail on legacy prose; `track note` still errors).
8. **Output:** `adopted <n> item(s), skipped <m> (already present)[, <k> invalid]` + one line per skipped/invalid id; `--json` emits `{"source", "target", "adopted":[…], "skipped":[…], "invalid":[{"id","reason"}], "dry_run":bool}`; `--dry-run` computes everything and **writes nothing** (not even the directory or lock).
9. **No automatic adopt on read — anywhere.** No other verb, the daemon, or the sessions payload calls adopt. rk's `track list` on a server with no rk file simply lists nothing; falling back to fab's file for the drawer is R3's job and is explicitly out of scope here.

### 4. Moving `FabOperatorSlug`

`cron.FabOperatorSlug` / `cron.FabOperatorStatePath` stay where they are (cron's watchlist still reads fab's file until R3). `internal/operator` imports them from `internal/cron` — acceptable (no cycle: `cron` must not import `operator`; verify at apply). If importing `cron` from `operator` pulls too much, extract the two pure functions to `internal/apphome` (or a tiny `internal/operator/slug.go` re-exporting) **without changing their behavior or breaking cron's callers/tests**.

### 5. Docs, help and conformance (CLI ⇒ docs + tests)

- `--help` text for `track` (+ every verb), `adopt`: toolkit conventions — Examples, Exit codes, no backticks in flag help (pflag metavar gotcha noted in `operator_request.go`).
- `rk help-dump` / the help-dump conformance test (`cmd/rk/help_dump*.go`) must include the new subcommands; update fixtures/golden as the existing tests require. Check `shll standards` for the CLI-surface standards named in the Constitution's *Toolkit Standards* clause before finalizing help output.
- Memory (hydrate, see Affected Memory): new `operator-state` memory file; package table, CLI reference and toolkit-standards notes updated.
- `docs/specs/`: no spec change in R1 (pre-implementation design intent lives in the plan doc until C1); revisit at hydrate if the spec set has an operator page by then.

### 6. Tests (ported with the code, plus new coverage)

Port, adapting package names/fixtures (`t.TempDir()` + `t.Setenv("XDG_STATE_HOME", …)`; **never** the live state home, daemon, tmux server, or installed binaries — Constitution PR Evidence also forbids touching a live `rk serve`):

- `predicate_test.go` — grammar table tests (from fab's `internal/predicate/predicate_test.go`).
- `track_types_test.go` ← `operator_track_types_test.go` (kinds table, `normalizeCheckEvery` floor/default/null rules, `validateTrackedItem`, `validateTrackedDeps`, `trackedItemDone`, staleness, held-dep).
- `track_test.go` ← `operator_track_test.go` (add/update/observe/rm/list behaviors; the `ghNameWithOwnerRunner` and `trackPanePIDLookup` seams become injectable vars in the new package).
- `migrate_test.go` / `adopt_test.go` ← `operator_migrate_test.go` (every legacy shape → expected items; running-autopilot refusal; fab-change conversion; idempotent re-run).
- **New:** notes (append, 50-cap pruning, 1000-rune error, `by` validation, `rm` drops notes, `list --json` includes notes); store (missing file ⇒ empty; unparsable ⇒ error; unknown top-level keys survive a mutation; in-section drift dropped; `0600/0700` modes; lock contention ⇒ timeout error without writing; two goroutines each `AddNote` ⇒ both land, none lost — the concurrency property that motivates the lock); `adopt` leaves the fab file byte-identical (hash before/after), `--dry-run` writes nothing, re-adopt skips existing ids, existing rk item not overwritten, fab `kind: note` `text` → first note, `clock_override` dropped, `branch_map` carried.
- CLI-level tests in `cmd/rk` for flag validation / exit codes / `--json` shapes (the `operator_request_test.go` pattern).

## Affected Memory

- `run-kit/operator-state`: (new) The operator state engine — `internal/operator` schema (kinds, probe modes, caps, notes), state file location/slug/permissions, tolerant-read/typed-write + lock + atomic write contract, `rk operator track` verbs, `rk operator adopt` semantics (explicit, read-only against fab's file, merge-never-clobber, legacy shapes, no auto-adopt), and what is deliberately not ported (`clock`, `text`).
- `run-kit/architecture/backend-packages`: (modify) Add the `internal/operator` row.
- `run-kit/architecture/cli`: (modify) Add `rk operator track …` and `rk operator adopt` to the CLI reference.
- `run-kit/toolkit-standards`: (modify) Record the help-dump / new-surface check for the new `operator` subcommands.
- `run-kit/cron`: (modify, small) Note under the operator-state reader that rk now has its own writable state file (reader unchanged until R3) so the two do not read as contradictory.

## Impact

- **New code:** `app/backend/internal/operator/` (~1.5–2 kLOC incl. ported tests ~2 kLOC more), `app/backend/cmd/rk/operator_track.go`, `operator_adopt.go` (+ tests). Small edit: `cmd/rk/operator.go` (`AddCommand`), possibly `internal/cron/dir.go` (slug reuse).
- **No** frontend, HTTP API, daemon, cron, sessions-payload, MCP-table, or settings changes. The MCP proxy's allowlisted `Table` is untouched (a verb with no row is not a tool; operator track/adopt are CLI-only for now).
- **Runtime state:** creates `$XDG_STATE_HOME/hexokit/operator/<slug>.yaml` (+ `.lock`) only when a mutating verb runs or `adopt` actually adopts something. Nothing reads it yet (R3/R2/R5 do later), so R1 is inert for the live operator by construction.
- **Dependencies:** none new (`gopkg.in/yaml.v3`, `spf13/cobra` already present).
- **Cross-repo:** fab-kit is only *read* (porting source). No fab change. The fab file format is an external contract; adopt's tolerant conversion is the compatibility surface.
- **Process rules honored (plan "Rules"):** built and tested in this worktree only; no brew upgrade / `fab sync` / daemon restart; PR body states `No recording: internal backend/CLI behavior with nothing observable in the web UI or desktop shell` plus the test evidence (Constitution *PR Evidence* exemption).
- **Risk:** the lock/atomic-write path is the part that cannot be left to ported tests (fab had flock-free single-writer assumptions plus rk-side `atomicfile`); the new concurrency test is the guard.

## Open Questions

None blocking. Two judgment-call defaults (graded Confident but the least certain rows: #8, #9, #15, #16) that the user may want to flip at review (both reversible, both cheap):

- Notes cap = 50 per item / 1000 runes per note, and no per-note delete verb (plan left count-vs-bytes and deletion authority open).
- `adopt` is merge-never-clobber (present ids skipped) rather than replace-on-readopt; there is no `--force`.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | R1 scope is state engine + `track` + `adopt` only; no check, loop, brief, UI, daemon or cron changes | Plan R1 "Out of scope: the check, the loop, UI"; user instruction not to touch the live daemon/installed binaries | S:95 R:90 A:95 D:95 |
| 2 | Certain | `adopt` is explicit, idempotent, leaves fab's file untouched, and nothing auto-adopts on read | Stated verbatim in the R1 brief and the user's instruction | S:95 R:85 A:95 D:95 |
| 3 | Certain | State file lives at `$XDG_STATE_HOME/hexokit/operator/<slug>.yaml` via `apphome.StateDir()`, plain YAML, written with `fsatomic` plus a lock | R1 brief + Constitution II (plain files under the hexokit state home) | S:90 R:70 A:95 D:90 |
| 4 | Certain | Port tests with the code (`operator_track_test`, `operator_track_types_test`, `operator_migrate_test`, predicate) | R1 brief explicitly lists them | S:95 R:85 A:95 D:95 |
| 5 | Confident | `<slug>` uses fab's injective socket-path slug rule (reuse `cron.FabOperatorSlug`) so adopt maps 1:1 per server | Plan says only `<slug>`; one server ↔ one file and the rule is already mirrored in `internal/cron/dir.go` | S:70 R:70 A:90 D:80 |
| 6 | Confident | Lock = blocking-with-5 s-timeout `flock` on a sidecar `<slug>.yaml.lock`, re-read inside the lock before every mutation | Plan says "a lock"; rename-based writes forbid locking the data file; Process Execution forbids unbounded waits; Constitution II "external writes win" | S:75 R:80 A:85 D:75 |
| 7 | Confident | Note shape `{at, by, text}` with `by ∈ {user, run, chat}`, binary-set RFC3339 UTC `at`, append-only | Shape given in the R1 brief; timestamp rule inherited from fab ("no subcommand accepts one") | S:90 R:70 A:85 D:85 |
| 8 | Confident | Notes capped at 50 per item (oldest pruned) and 1000 runes per note; over-length errors on write | Plan's open decision "count vs bytes"; count bounds what a run brief must read, rune cap bounds bytes; numbers are judgment, easily retuned | S:50 R:85 A:60 D:55 |
| 9 | Confident | No per-note delete verb in R1; notes leave only via cap or `track rm` | Plan's open decision "who may delete a note"; literal append-only is the safest default and a verb can be added without migration | S:50 R:85 A:60 D:60 |
| 10 | Confident | `kind: note` stays a kind; its content is its notes list; fab's `text` field is dropped and, on adopt, becomes the first note (`by: user`, `at: updated_at`→`added_at`) | Plan: "one concept … existing `kind: note` items are the seed"; keeps one place for prose | S:70 R:65 A:80 D:70 |
| 11 | Confident | Kind `task` is retained although the plan's kind list omits it | fab has it, rk's tolerant reader and Tasks tab already carry `task`; dropping it would lose live items on adopt | S:65 R:70 A:85 D:75 |
| 12 | Confident | `clock_override` and `track clock` are not ported | Plan Decisions: next-check timing is rk's backoff/wake only; R5 owns the clock | S:85 R:80 A:90 D:85 |
| 13 | Confident | `branch_map` is kept (typed section, add-time write, adopt carry) with no `rm` verb until R6 | Live data feeds dependency resolution that R6 ports; a minimal carry avoids losing it at C1 | S:60 R:70 A:75 D:65 |
| 14 | Confident | Verb set: `add, update, observe, rm, list, note, pause, resume`; `update` loses `--text/--pause/--resume` | R1 brief lists add, rm, list, note, pause and an ellipsis; `observe` is required by R2's "writes the baseline exactly as the daemon call does" | S:75 R:75 A:85 D:75 |
| 15 | Confident | `--mode` validated against the three modes cherry-pick-ladder, stacked-prs, merge-auto; omitted ⇒ `merge_mode: null` (no config read in R1) | Plan defers `merge_mode` config location to R6's intake; pinning the default now would shadow R6's config | S:55 R:75 A:65 D:60 |
| 16 | Confident | `adopt` merges by id, skips ids already present, never overwrites; `--dry-run`, `--from`, `--json`; missing source ⇒ exit 0 and no file created | "Idempotent" + Constitution II (rk writes win); a `--force` replace is unnecessary before C1 | S:65 R:75 A:80 D:60 |
| 17 | Confident | Invalid/hand-drifted legacy items are skipped with a named warning rather than failing adopt; legacy note text over cap is trimmed with a warning | Fab's tolerant-read posture; adopt must not wedge a live operator's migration on one bad item | S:60 R:75 A:80 D:70 |
| 18 | Confident | Server addressing via `-L/--server` defaulting to the caller's `$TMUX` server, like `rk operator request`; `--json` and exit codes 0/1/2 per toolkit standards | Existing `rk operator` conventions in this repo | S:80 R:80 A:90 D:85 |
| 19 | Confident | `gh repo view` and tmux `pane_pid` lookups are argv-only `exec.CommandContext` with timeouts behind injectable seams; failures: gh ⇒ add error, pane_pid ⇒ `null` | Constitution I and Process Execution; behavior ported from fab | S:75 R:80 A:90 D:85 |
| 20 | Confident | Change is `feat`; PR states `No recording:` (backend/CLI only) with test evidence | Constitution *PR Evidence* exempts changes with nothing observable in UI/shell | S:80 R:85 A:90 D:85 |

20 assumptions (9 certain, 11 confident, 0 tentative, 0 unresolved).
