# Intake: Retry after a failed run

**Change**: 261124-5j8o-retry-after-failed-run
**Created**: 2026-11-24

## Origin

> Execute step T12 (Retry after a failed run) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first (Decisions and Rules bind you), then implement only the T12 Brief.

One-shot invocation. The plan (`fab/plans/sahil/26-11-20-operator-triggers.md`, also present in this worktree at
the same relative path) is the design source; its § Decisions table, § Rules for the operator executing this plan,
and § Non-goals bind this change. Only the **T12 Brief** is in scope. The T12 Brief, verbatim:

> **Problem.** `operator.Check` consumes the edges it reports; a run that then fails (launcher logged
> out, a crash, no outcome line) leaves only a `run failed` note. The condition stays `open`, nothing
> re-offers it, and a done item yields no further edge — so a failure on the `done` fire is terminal
> (26 quiet checks after the 19:19Z failure on `ot-t8`).
>
> - **Check** (`internal/operator`): a `failed@<at>` condition, derived like `note@<at>`
>   (`PendingFailure`): the item's newest `by: run` note is a failure note (`FailureNotePrefix`) and no
>   later `by: run` note exists; `<at>` is that note's time, so each failure is one edge. Derived for every
>   item, done and paused included. A later successful run writes a note (the exit contract) and clears
>   it; a run that did nothing on the item writes no note, so the run SHALL note the item it was retried
>   for (`retried after failure: <what it found>`), or the condition stays open — add that line to the exit
>   contract.
> - **Loop** (`operatorloop/judgment.go`): `failed` is a judgment reason, rendered `failed <at>`. The
>   failure-streak ladder (T2) already spaces the retries; nothing else changes.
> - **Wrapper**: unchanged (it already writes the failure note).
> - Tests: condition derivation (failure note newest ⇒ condition; later run note ⇒ cleared; a second
>   failure ⇒ a new key); judgment case; an integration case: failing launcher → note → fixed launcher →
>   the next fire launches a run for the item with reason `failed`.
> - Docs: `operator-state.md` (conditions table, a Design Decision "a failed run is retried, not
>   forgotten"), `operator-loop.md`, `operator-brief.md` (exit contract line).

## Why

**The pain.** `operator.Check` is edge-triggered: it records each condition key it reports in the item's
`reported` list and never reports it again while the condition holds. The loop launches a model run for the
items whose changes need judgment. If that run then fails — the `claude -p` launcher is logged out (seen on this
box from 18:44Z 2026-11-23: every run failed in 2 s with `Not logged in`), the launcher crashes, the mechanical
phase fails, or the run exits without an `outcome:` line — the wrapper (`operatorloop/exec.go` `reportFailure` →
`notes.go` `NoteFailure`) appends a `by: run` note `run failed: exit <n> — <log tail>` to each changed item and
nothing else. The edge was already consumed, so the condition sits in `open` forever and no later fire re-offers
it. For a `done` item it is worse: a done item yields no further edge at all, so a failure on the `done` fire is
terminal — on `ot-t8` the 19:19Z failure was followed by 26 quiet `no change` checks while the item's `then:`
(merge the PR) was never acted on.

**If we don't fix it.** Every transient launcher failure silently drops whatever the failed run was supposed to
decide: a post-intake advance, a waiting prompt, a merge under `merge-auto` (T11's `pr-<n>` `done` edge is
exactly such a one-shot edge). The user only finds out by reading the Activity tab or the ledger.

**Why this approach.** A failure note is already durable state on the item (Constitution II — state is files),
and the plan's T2 decision already made notes into conditions (`note@<at>`). Deriving a `failed@<at>` condition
from the same notes makes a failure an edge the check re-offers exactly once per failure, with no new file, no
new counter, and no retry timer: the T2 failure-streak ladder (`cron.LoopLadder` climbs on `run-failed` /
`run-lost` / `check-failed`) already spaces consecutive failing fires, so a dead launcher still cannot run every
3 minutes. Alternatives rejected by the plan: un-consuming the edge on failure (the check would have to know
about run outcomes, and the wrapper would have to rewrite `reported`), or a forced re-run (the plan's "No forced
run" decision).

## What Changes

### 1. Check: `PendingFailure` and the `failed@<at>` condition (`app/backend/internal/operator`)

**`schema.go`** — add a sibling of `PendingInstruction`, the one owner of the rule:

```go
// PendingFailure reports a run failure nothing has answered yet: the item's
// newest `by: run` note is a failure note (FailureNotePrefix) and no later
// `by: run` note exists. at is that failure note's own `at`, so each failure
// is its own condition. Notes whose `at` does not parse are ignored.
func PendingFailure(notes []Note) (at string, ok bool)
```

Semantics (exact):
- Consider only notes with `By == ByRun` whose `At` parses as RFC3339; skip the rest (same tolerance as
  `PendingInstruction`).
- Find the newest such note by parsed time. If its text starts with `FailureNotePrefix` (`"run failed: "`),
  return `(note.At, true)`; otherwise `("", false)`. No run notes ⇒ `("", false)`.
- Ties on equal timestamps: the later note in slice order wins (notes are append-only, so slice order is
  write order) — i.e. use `!t.Before(latest)` when scanning.
- `by: user` / `by: chat` notes neither set nor clear it (they drive `note@`, a separate condition).
- Any later non-failure `by: run` note clears it — a run's own note, and also the engine's `escalated: …`
  note (`autopilot.go` writes those `by: run`). That is the intended "a later successful run note clears it".

**`check_conditions.go`** — add the key prefix and derive it in `itemConditions`, beside the note condition, so
it applies to **every** item regardless of state (done, paused, or active — `itemConditions` appends after
`stateConditions`, which is exactly the "derived for every item" placement):

```go
// condFailedPrefix is completed with the unanswered failure note's own `at`,
// so a second failure is a new condition.
condFailedPrefix = "failed@"
...
if at, ok := PendingFailure(it.Notes); ok {
    conds = append(conds, condDelta{condFailedPrefix + at, CheckDelta{Kind: DeltaFailed, ID: it.ID, At: at}})
}
```

Emission order: state conditions, then `note@`, then `failed@`.

**`check.go`** — new delta kind `DeltaFailed = "failed"`; `CheckDelta.At` (already present, documented as "a note
delta's instruction note time") is reused and its comment widened to cover the failure note time;
`MarshalJSON` emits `{"kind":"failed","id":"<id>","at":"<at>"}` (same field set as `note`).

Edge behaviour falls out of the existing `reported` machinery: the key `failed@2026-11-23T19:19:00Z` is reported
once as a change, then listed in `open` while the failure note is still the newest run note; a second failure
writes a newer note ⇒ new key ⇒ new change; a later non-failure run note ⇒ the condition disappears (and the
key drops out of `reported` as every vanished condition does today).

### 2. Loop: `failed` is a judgment reason (`app/backend/internal/operatorloop`)

**`runner.go` `reasonFor`** — `case operator.DeltaFailed: detail = d.At`, so the reason renders `failed <at>`
(e.g. `failed 2026-11-23T19:19:00Z`).

**`judgment.go` `reasonNeedsJudgment`** — add `operator.DeltaFailed` to the always-judgment case list
(beside `DeltaNote`). No owned/unowned distinction: a failed run on an engine-owned queue item is still the
run's to retry, because the mechanical pass already ran and what failed was the model run.

No pending-scan fallback (unlike `pendingNoteReason`): the brief says "nothing else changes". An open
`failed@` condition is offered once per failure; the exit-contract line below is what closes it.


The wrapper (`exec.go` `reportFailure`, `notes.go` `NoteFailure`) is unchanged — it already writes the
failure note on every changed item, once per failed run. Each failed retry writes another failure note, which
is a new `failed@` key, which is one more fire — spaced by the T2 failure ladder, and the push is still sent
once per failure streak (`inFailureStreak`).

### 3. CLI rendering (`app/backend/cmd/rk/operator_check.go`)

The human renderer of `rk operator check` gets `case operator.DeltaFailed: return d.At` (mirrors
`DeltaNote`), with a table case in `operator_check_test.go`. JSON output comes from `MarshalJSON`. No new flag,
verb, or help text — the CLI surface is unchanged, so no `rk help-dump` fixture changes are expected (verify).

### 4. Brief: the exit-contract line (`app/backend/internal/operator/brief.go` `briefExitContract`)

Add one line to the exit contract (the run reads it). Exact intent:

> An item listed with a `failed <at>` reason was offered again because an earlier run failed. Write a note
> on it either way — `retried after failure: <what you found or did>` — even when nothing needed doing;
> until a run note follows the failure note, the item stays flagged.

This is an explicit exception to T4's "a run that did nothing writes no note" rule, scoped to `failed`
items only; the brief's render test (`brief_test.go`, the `## Exit contract` section assertions) gains the
`retried after failure:` text, and the existing "no note when nothing needed doing" assertion must still pass
(the general rule stays; the exception is worded as an exception). Update the brief golden if one exists.

### 5. Tests

- `internal/operator` — `PendingFailure` table: failure note newest ⇒ `(at, true)`; later non-failure run
  note ⇒ cleared; failure after a success ⇒ set again with the new `at`; user/chat notes don't affect it;
  unparseable `at` ignored; same-second tie resolves by append order. Check-level: a failure note on a done
  item and on a paused item yields `failed@<at>` in `changes`; the next check lists it in `open` (not
  `changes`); a second failure note ⇒ a new key in `changes`; a later run note ⇒ gone from both. JSON form of
  the `failed` delta in the existing marshal table (`check_test.go`).
- `internal/operatorloop` — `judgment_test.go`: a `failed <at>` reason on any item (incl. engine-owned) is
  in the judgment set; `reasonFor` renders `failed <at>`.
- Integration (`runner_test.go` / `loop_test.go`, using the existing launcher seams): a fire whose launcher
  fails ⇒ failure note on the item ⇒ launcher fixed ⇒ the next fire's check reports `failed@<at>` and launches
  a run whose judgment set carries the item with a reason of kind `failed`.
- `cmd/rk` — `operator_check_test.go` render case.

### 6. Docs (memory)

- `docs/memory/run-kit/operator-state.md` — Conditions table row
  `failed@<at>` | `PendingFailure` holds: the item's newest run note is a failure note; `<at>` is that note's
  `at` (`failed` delta: `at`); the prose next to `PendingInstruction` gains `PendingFailure`; a Design Decision
  **"A failed run is retried, not forgotten"** (why: the check consumes edges, a failed run left the item's
  condition open forever; the failure note is the durable record; the ladder bounds the rate).
- `docs/memory/run-kit/operator-loop.md` — judgment set lists `failed`; the failure-note decision notes that
  the note now re-offers the item.
- `docs/memory/run-kit/operator-brief.md` — exit contract gains the `retried after failure:` line.

### Non-goals

- Review bar (plan § Decisions, copied per Rule 4): **must-fix** = merges, pushes, deletes or spawns the wrong
  thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. **Should-fix** = everything else.
- No change to the wrapper's failure notes, the push-once-per-streak rule, or `cron.LoopLadder`.
- No retry counter, backoff timer, or new state file; no forced run.
- No change to `PendingInstruction` (failure notes stay non-answers).
- No frontend change (Activity renders deltas generically). PR evidence: `No recording: internal CLI/engine
  behavior` with the test validation listed.
- Nothing from T9/T10/T11 or any other step.

## Affected Memory

- `run-kit/operator-state`: (modify) `failed@<at>` condition row, `PendingFailure` rule, Design Decision "A failed run is retried, not forgotten"
- `run-kit/operator-loop`: (modify) judgment set gains `failed`; failure-note decision cross-references the retry
- `run-kit/operator-brief`: (modify) exit contract gains the `retried after failure:` line

## Impact

- `app/backend/internal/operator/schema.go` (new `PendingFailure`), `check_conditions.go` (new prefix +
  derivation), `check.go` (`DeltaFailed`, `MarshalJSON` case, `At` comment), `brief.go` (exit-contract text),
  tests in `check_test.go` / a schema test / `brief_test.go`.
- `app/backend/internal/operatorloop/judgment.go`, `runner.go` (`reasonFor`), tests.
- `app/backend/cmd/rk/operator_check.go` (render case) + test.
- Activity API (`api/operator_activity*.go`) passes check records through unchanged; the new delta kind
  simply appears in them — no code change expected.
- Behavioral: after deployment, every existing item whose newest run note is a failure note (e.g. `ot-t8` on
  `hexokit`) reports `failed@<at>` on the first check and gets one retry run — the intended recovery.

## Open Questions

- None blocking. The exit-contract wording is drafted above; final phrasing is the implementer's within that intent.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Condition key `failed@<at>`, `<at>` = the failure note's own `at`; derived via a new `operator.PendingFailure` in `schema.go` beside `PendingInstruction` | Spelled out in the T12 Brief | S:95 R:85 A:95 D:95 |
| 2 | Certain | Derived for every item (done and paused included) — placed in `itemConditions` after `stateConditions`, like `note@` | Brief: "Derived for every item, done and paused included"; `itemConditions` is where `note@` already does this | S:90 R:85 A:90 D:90 |
| 3 | Certain | Any later non-failure `by: run` note clears the condition (including engine `escalated:` notes, which are `by: run`); user/chat notes don't | Brief: "no later `by: run` note exists" | S:85 R:80 A:85 D:85 |
| 4 | Certain | `failed` is always a judgment reason in `reasonNeedsJudgment`, rendered `failed <at>` by `reasonFor`; wrapper, ladder and push rule unchanged | Brief § Loop and § Wrapper | S:95 R:85 A:90 D:90 |
| 5 | Certain | Exit contract gains a scoped exception: a `failed` item gets a `retried after failure: …` note even when the run did nothing | Brief: "add that line to the exit contract" | S:90 R:85 A:85 D:85 |
| 6 | Certain | New delta kind `DeltaFailed = "failed"` reusing `CheckDelta.At`, JSON `{"kind","id","at"}` like `note` | Mirrors `DeltaNote`; brief says "derived like note@<at>" | S:70 R:85 A:85 D:80 |
| 7 | Confident | `rk operator check` human renderer gets a `failed` case; no CLI flag/verb/help change, so no help-dump fixture change | Rendering switch mirrors `note`; CLI surface unchanged | S:60 R:90 A:80 D:80 |
| 8 | Confident | Same-second tie between a failure note and a later run note resolves by append order (later in slice wins) | RFC3339 has 1 s resolution; notes are append-only so slice order is write order — a success written the same second must clear | S:40 R:85 A:65 D:55 |
| 9 | Confident | No `judgmentSet` fallback scan for an already-reported open `failed@` (unlike `pendingNoteReason`) | Brief: "nothing else changes"; the exit-contract note is the closer; adding a scan would make an un-noted failure ride every later run | S:50 R:80 A:55 D:45 |
| 10 | Confident | `failed@` is emitted after `note@` in the condition order | Only affects listing order in changes/open; no consumer depends on it | S:35 R:95 A:70 D:60 |
| 11 | Certain | PR evidence: `No recording: internal CLI/engine behavior` | Plan Rule 6 — T12 has no UI change | S:90 R:90 A:95 D:95 |

11 assumptions (7 certain, 4 confident, 0 tentative, 0 unresolved).
