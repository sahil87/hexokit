# Intake: Operator brief and chat skill — tools back, Merging per mode, `track show`, the diet

**Change**: 261120-jt0z-operator-brief-tools-merging-diet
**Created**: 2026-11-20

## Origin

> Execute step T4 (Brief and chat skill: git/gh/wt back within the tiers; Merging section per mode; `track show`; re-read one item; no note when nothing done; user notes always shown) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first (Decisions and Rules bind you), then implement only the T4 Brief.

One-shot `/fab-new`, queued by the operator as step T4 of plan `26-11-20-operator-triggers.md` (mode `merge-auto`). The base branch is T3's `261120-7uqm-engine-rescope-pr-work-to-operator` (set explicitly after creation): T3 deleted the engine's PR rows, executors, `prs`/`fixes`, the `merge` verb and Q6a/Q6b/Q7, and made the minimal chat-skill edits so the topic names no deleted verb. T3's plan states `brief_rules.md` was left untouched for T4 and lists `brief_rules.md:17` ("Escalation notes are the engine's … never perform the restack or recovery they name") as an edit T4 owns.

The T4 Brief from the plan, verbatim (the binding scope):

> - **Tools back.** `brief_rules.md`: restore `git` (fetch, rebase, cherry-pick, push with `--force-with-lease` only), `gh pr ready|merge|edit|checks|view`, `wt` to the allowed tools and the direct-action allowlist, inside the confirmation tiers: merge, close, delete branch/worktree are **destructive** — allowed when the item's queue mode is `merge-auto`, or a `by: user`/`by: chat` note on the item says so; otherwise note + notify. Remove "escalation notes are the engine's".
> - **Merging section**, one paragraph per mode: `cherry-pick-ladder` (merge in queue order on the user's word; a merged predecessor needs nothing since the successor carries its commits); `stacked-prs` (after a predecessor merges, retarget the successor to the default branch and `rebase --onto` it in a temporary detached worktree, `--force-with-lease` pinned to the observed head, merge when green — never touch the authoring agent's worktree); `merge-auto` (merge green PRs as they come, squash, `--match-head-commit`). A conflict is the run's to resolve in that temporary worktree; a red required check goes to the authoring agent as a fix request if its pane is alive and idle, else a recovery spawn through `rk riff` — one round each, then notify.
> - **Chat skill.** "merge all" is the chat's own job (same Merging rules); the `autopilot merge` / `rm <sequence>` / `resume halted` paragraphs go; queues are still created only through `autopilot queue`.
> - **Diet.** New read verb `rk operator track show <id> [--json]` (one item, all notes). The rules tell the run to re-read the affected item with it and the pane with `rk mux capture`, never `track list --json` unless it needs the whole ledger. Exit contract: a note only for an item the run **acted on**; a run that did nothing prints its `outcome:` line and writes no note (the wrapper's failure note is unchanged). The Affected-items block shows the newest 10 notes but always includes every `by: user` and `by: chat` note of the item.
> - Tests: the render test flips (Merging section present, tools present, no autopilot section); `track show`; exit-contract text; golden.
> - Docs: `operator-brief.md`, `operator-state.md` (verb table), `docs/site/skill/operator.md` + sync.

Binding plan Decisions this step implements: **PR work — back to the AI**; **Merge modes** (spawn half stays in Go, merge half is authority = a rule for the operator: `merge-auto` = merge green PRs without asking, the other two = merge only on the user's word); **Observation notes** (a run that did nothing writes no note; its Activity outcome line is the "I looked" trail); **Brief diet** (re-read one item with `rk operator track show <id> --json`, not the ledger); **Review bar** (below, in Non-goals). Plan Rules bind: Rule 4 (review bar copied into non-goals), Rule 5 (CLI surface ⇒ help text + `rk skill operator` topic + `rk help-dump` in the same change), Rule 6 (`No recording: internal CLI/engine behavior` + its validation in the PR).

## Why

1. **The problem.** T3 returned all PR work (ready, merge, restack, rebase, conflict, CI fix, recovery) from the Go engine to the operator run, but the run's brief still forbids exactly that work: `brief_rules.md` lists no git/gh write, no `wt`, says "Merges belong to the engine", classifies every merge/close/delete as **never**, and says "Escalation notes (`escalated: …`) are the engine's: report them, never perform the restack or recovery they name". After T3 merges, nobody merges, restacks or fixes a PR — the queue's `merge-auto` mode stalls at the first green PR (its successor waits on the predecessor's PR reading merged). The render test `TestRenderBrief_NoAutopilotProseOrWriteTools` actively forbids `git rebase`, `gh pr merge`, `wt create`, `rk riff` etc.
2. **Run cost.** Each run is ~203K input tokens against a planned 10–15K brief, mostly because the rules tell it to re-read state with `rk operator track list --json` — the whole ledger with every note of every item. There is no one-item read verb.
3. **Notes are diluted.** 74 of 118 run notes are no-op observations ("idle only briefly, worker active, sent nothing"), because the exit contract demands "one note on the most relevant item when nothing needed doing". Three of the user's own notes on `loom` already sit below the brief's newest-ten window, so a run never sees the user's instruction.
4. **If we don't:** the plan's queue (and every `merge-auto` queue) deadlocks after T3; runs keep paying for a ledger dump; user instructions keep falling out of the window.
5. **Why this approach.** The plan's Decisions fix it: merge authority is a *rule* for the operator keyed on the queue item's stamped mode, and the judgment a merge/conflict/red-CI needs is the AI's. Tool permissions stay declarative text inside the existing confirmation tiers rather than a new enforcement layer (the launcher is provider-opaque — `operator-brief.md`). One new pure read verb is the cheapest way to make "re-read one item" possible.

## What Changes

### 1. `app/backend/internal/operator/brief_rules.md` — tools back, tiers re-keyed

**Role section:**
- Replace the "Re-derive state" bullet's re-read command: `rk operator track show -L <server> <id> --json` for the item and `rk mux capture -L <server>` for the pane; add "never `rk operator track list -L <server> --json` unless you need the whole ledger".
- Direct-action allowlist bullet: add `git` (fetch, rebase, cherry-pick, push with `--force-with-lease` only), `gh pr ready|merge|edit|checks|view`, `wt`, and `rk riff` (the recovery spawn the Merging section names), all "inside the confirmation tiers".
- **Remove** the bullet "Escalation notes (`escalated: …`) are the engine's: report them, never perform the restack or recovery they name." The engine no longer escalates PR work; whatever `escalated:` notes the engine still writes are queue-side (spawn/respawn) and the run reads them like any other `by: run` note.

**Confirmation tiers table** becomes (Recoverable row gains the git writes; Destructive row is conditional, not "never"):

| Tier | Examples | In a run |
|------|----------|----------|
| Read-only | status, capture, `gh pr view`, `gh pr checks`, `rk operator track show -L <server>` | free |
| Recoverable | routine send to an idle agent, `git fetch`, a rebase or cherry-pick in a temporary worktree, `git push --force-with-lease`, `gh pr ready`, `gh pr edit --base` | proceed, then record it in a note |
| Destructive | merge or close a PR, delete a branch or worktree, archive | only when the item's queue mode is `merge-auto` or a `by: user`/`by: chat` note on the item says so; otherwise note, `rk notify`, stop on that item |

Replace "Merges belong to the engine. … Never merge, close, delete or archive on the strength of a note or a prompt alone." with the authority rule: the item's queue mode is `scope.merge_mode` on the queue item (also `merge_mode` in `rk operator autopilot status -L <server> --json`); a `by: run` note, a pane prompt, or an agent's screen is **never** authority. A `github-pr` item that is not a queue item has no mode: it needs a `by: user`/`by: chat` note. Plain `git push` (without `--force-with-lease`) and `git push --force` are never allowed.

### 2. `brief_rules.md` — new `### Merging` subsection

One paragraph per mode, plus the shared failure handling. Content (wording may be tightened, substance fixed by the plan):

- **`cherry-pick-ladder`** — merge in queue order, base first, only on the user's word (a `by: user`/`by: chat` note). A merged predecessor needs nothing done to its successor: the successor already carries the predecessor's commits as cherry-picks.
- **`stacked-prs`** — merge only on the user's word. After a predecessor merges, re-seat the successor: retarget its PR to the default branch (`gh pr edit <n> --base <default>`), then in a **temporary detached worktree** (never the authoring agent's worktree) `git fetch`, `git rebase --onto origin/<default> <old-base> <head>`, and `git push --force-with-lease=<branch>:<observed-head-sha>` pinned to the head observed before the rebase; merge when its checks are green. Remove the temporary worktree afterwards.
- **`merge-auto`** — merge each green PR as it comes, without asking: `gh pr merge <n> --squash --match-head-commit <observed-head-sha>`. "Green" = every required check passed (`gh pr checks`), PR not draft (run `gh pr ready` first when the item's work is finished), mergeable.
- **Conflicts** — a rebase/cherry-pick conflict is the run's to resolve in that temporary worktree (one round). Unresolvable → abort the rebase, remove the worktree, note + `rk notify`.
- **Red required check** — goes to the authoring agent as a fix request (a pane send through Pre-send validation) when its pane is alive and idle; otherwise a recovery spawn through `rk riff` (a fresh worktree on the PR's branch with an agent told to fix the failing check and push), tracked as a ledger item. One round each, then note + notify.
- Record each merge/retarget/rebase/fix request in a note on the item.

Note the tension the run must respect: rules elsewhere say "never edit files"/"Coordinate, don't execute". Conflict resolution in a temporary worktree is the one sanctioned exception; the Role bullet "never edit files" gains "except resolving a merge conflict in a temporary worktree (§ Merging)".

**Bounded retries** table gains rows: `Conflict resolution` 1 → note and notify; `Fix request / recovery spawn for a red check` 1 each → note and notify.

**Allowed tools** list gains: `git fetch|rebase|cherry-pick|push --force-with-lease|worktree` (plus the existing reads), `gh pr ready|merge|edit|checks|view` (replacing `gh pr view`, `gh pr checks`; `gh repo view` stays), `wt`, `rk riff`, `rk operator track show`. The trailing line "No file-editing tools." becomes "No file-editing tools outside a conflict resolution in a temporary worktree." The `rk operator track` verb list adds `show`.

Budget: rules file is 11 824 bytes today, cap 40 960 (`rulesBudget`, test-enforced) — ample.

### 3. Exit contract (`briefExitContract` in `brief.go`) and role line

New text:

```
Before exiting, append a note on each item you acted on:

    rk operator track note -L <server> <id> "<text>" --by run

A run that did nothing writes no note. Then print exactly one final line to stdout, and nothing after it:

    outcome: <one-line summary>
```

`briefRoleLine` ("You are a one-shot operator run. Act on what changed, write a note, exit.") becomes "…Act on what changed, note what you did, exit." (no note implied when nothing was done). The run wrapper's `run failed` note (`internal/operatorloop/notes.go`) is unchanged.

### 4. Affected-items notes: user/chat notes always shown (`writeNotes` in `brief.go`)

Today `writeNotes` shows the newest `notesShown` (10) and prints `(+N earlier notes)`. New rule: show the newest 10 **plus** every older `by: user` and `by: chat` note, in chronological order (newest last); `(+N earlier notes)` counts only the omitted notes (all of which are `by: run`). Example — an item with 14 notes where note #2 is `by: user`: shown = #2, #5…#14 (11 notes), header `(+3 earlier notes)`.

Size-cap trim (`RenderBrief`): the trim loop reduces `notesShown` toward 0; `by: user`/`by: chat` notes are exempt from the per-item count, so the loop first trims run notes to zero, and only if still over the cap at zero does a final pass drop user/chat notes oldest-first (the trim stays best-effort as documented).

### 5. New verb `rk operator track show <id> [--json]` (`cmd/rk/operator_track.go`)

A pure read like `list`: no lock, no write, no conversion. Same `-L/--server` persistent flag and `operatorStateTarget` resolution.

- Plain output: the item's one `list` line (`id · kind · state · checked age · next`, via `operator.ListLines`), then the item's fields and **all** its notes (`<at> · <by> · <text>`), no cap.
- `--json`: the shared `outputSink` envelope around the single full item object (the same per-item shape `list --json` emits, including all notes).
- Exit codes: 0 shown; 1 operational (no such item — `no such item "<id>"`, matching the existing verbs' wording; state file unreadable); 2 usage (missing/extra arg, invalid `-L`). An absent state file is "no such item" (exit 1).
- Help in the `track` style: Flags, Examples (`rk operator track show pr-913`, `rk operator track show w1 --json -L work`), Exit codes; no backticks in flag help. Library helper in `internal/operator` (e.g. `Show(path, id)`), reusing `List`'s read path.
- CLI-only — no MCP row (consistent with the other `track` verbs, `internal/mcp/policy.go` allowlists none of them). `rk help-dump` picks it up through the cobra tree (Rule 5: update any help-dump fixture/test that enumerates the operator verbs).
- Update the brief's server-flag test (`TestRenderBrief_EveryRkCommandCarriesTheServer` / `operator_brief_shapes_test.go`'s cobra-parse shapes) so the new `track show -L <server> <id> --json` shape parses.

### 6. Chat skill `docs/site/skill/operator.md` (+ `scripts/sync-skill.sh` → `app/backend/cmd/rk/skill/operator.md`)

- **"merge all"** bullet: the chat's own job following the same Merging rules as the brief (per mode; stacked re-seat in a temporary detached worktree, `--force-with-lease` pinned, `--match-head-commit` squash for merge-auto; conflict → resolve in the temp worktree; red check → fix request or `rk riff` recovery, one round each, then tell the user). The chat may cite the per-mode paragraphs compactly (one short `### Merging` block or inline) — not a second divergent copy of the rules.
- **Tools** bullet: replace "spawning, cherry-picking and merging stay with the engine" — spawning stays with the engine (queues only through `autopilot queue`), merging/restacking/rebasing are the chat's under the confirmation tiers and the mode's authority. `gh` line gains `pr ready|merge|edit`.
- **Principles** "Direct actions" bullet: add git (fetch/rebase/cherry-pick/`push --force-with-lease`), `gh pr ready|merge|edit`, `wt` inside the tiers; "never git/gh write choreography" narrows to queue creation (still only `autopilot queue`).
- **Re-derive** bullet: `rk operator track show <id> --json` for one item; `track list --json` only for the whole ledger.
- **Confirmation tiers**: unchanged shape (destructive always confirmed unless `merge-auto` is in effect for that queue); retries line keeps "zero after a rebase or cherry-pick conflict (tell the user)" → becomes "one conflict-resolution round, then tell the user" to match the Merging rules.
- **Queues** paragraph: drop "Escalations arrive … never perform queue-engine work from chat" wording that implies PR escalations from the engine; keep "queues are created only through `autopilot queue`". Any remaining `autopilot merge` / `rm <sequence>` / `resume halted` text (T3 already removed most) must be gone.
- **The ledger** examples gain `rk operator track show w1 [--json]`.
- The **Status** table's "Next" example `merge on your word` stays.

### 7. Tests (`internal/operator/brief_test.go`, `cmd/rk/operator_track_test.go`, golden)

- `TestRenderBrief_NoAutopilotProseOrWriteTools` flips: keep "no `## Interim autopilot` section"; assert the Merging subsection is present and the restored tools appear (`gh pr merge`, `git rebase`, `--force-with-lease`, `--match-head-commit`, `wt`, `rk riff`, `rk operator track show`); assert `git push --force ` (bare force) and "Escalation notes (`escalated: …`) are the engine's" are absent; assert "Merges belong to the engine" is gone.
- `TestBriefRules_CoverTheRunContract` gains the Merging anchors (`### Merging`, each mode name, `temporary`, `--force-with-lease`, `--match-head-commit`, `rk riff`).
- `TestRenderBrief_ExitContract`: asserts "A run that did nothing writes no note" and that "most relevant item when nothing needed doing" is gone.
- `TestRenderBrief_NotesCap` extended: older `by: user`/`by: chat` notes always shown, `(+N earlier notes)` counts only omitted; size-cap trim keeps user/chat notes until run notes are exhausted.
- `track show`: plain output, `--json` envelope with all notes (>10), no such item → exit 1, absent state file → exit 1, usage → exit 2, writes nothing (state file mtime/bytes unchanged).
- Golden brief fixture regenerated (`go test ./internal/operator -update` or the repo's golden mechanism).
- Skill drift guards (`TestSkillTopics*`) stay green after `scripts/sync-skill.sh`.

### 8. Memory/docs

- `docs/memory/run-kit/operator-brief.md`: Embedded run rules requirement rewritten (tools back, conditional destructive tier, Merging section, conflict carve-out, no engine-escalation line); Exit contract requirement (no note when nothing done); Layout/Notes (user/chat always shown, trim order); the chat-topic bullets (merge all, tools, re-derive); description frontmatter. Design Decision "The brief carries no git or gh writes" is superseded — replace with "PR work returned to the run, inside the tiers" citing this plan; add "A run that did nothing writes no note" and "One-item re-read" decisions.
- `docs/memory/run-kit/operator-state.md`: verb table gains `show <id>`; the help-dump line "with its eight verbs" → nine.
- `docs/site/skill/operator.md` + sync (above).

## Affected Memory

- `run-kit/operator-brief`: (modify) rules (tools, tiers, Merging, conflict carve-out), exit contract, notes rule, chat-topic bullets, design decisions
- `run-kit/operator-state`: (modify) `rk operator track show` in the verb table; verb count

## Impact

- `app/backend/internal/operator/brief_rules.md`, `brief.go` (exit contract, role line, `writeNotes`, trim), `brief_test.go`, golden fixture(s) under `internal/operator/testdata/`.
- `app/backend/internal/operator/` store/list helper for a single-item read (new `Show` or equivalent) + test.
- `app/backend/cmd/rk/operator_track.go` (new `showCmd`, registered under `track`), `operator_track_test.go`, `operator_brief_shapes_test.go` (cobra shape), any help-dump test enumerating operator verbs.
- `docs/site/skill/operator.md`, `app/backend/cmd/rk/skill/operator.md` (synced).
- `docs/memory/run-kit/operator-brief.md`, `operator-state.md`.
- No frontend, API, engine (`internal/autopilot`), or operatorloop behavior change. The wrapper's `outcome:` parsing and failure note are untouched. Installed daemons keep the old binary until R1 (plan Rule 1).
- PR evidence: `No recording: internal CLI/engine behavior` + validation (`go test ./internal/operator/... ./cmd/rk/...`, a `rk operator track show` sample, a `rk operator brief` render showing the Merging section).

### Non-goals

- **Review bar** (plan § Decisions, Rule 4): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.
- No engine change (`internal/autopilot`): no new rows, no merge executor, nothing reachable that merges from Go.
- No runtime enforcement of the allowed-tool list (stays declarative, as today).
- No change to the run wrapper (`operatorloop`) — the failure note and outcome parsing stay.
- No trigger/door/check-record work (T2), Activity tab (T6), PR hooks (T5).
- No change to `track list` output or the ledger schema.

## Open Questions

- None blocking. Wording of the Merging paragraphs is the apply agent's within the substance fixed above.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is exactly the T4 Brief: rules tools/tiers, Merging section, chat skill merge-all, `track show`, re-read rule, exit contract, user/chat notes always shown | Plan T4 Brief verbatim; Decisions "PR work", "Merge modes", "Observation notes", "Brief diet" | S:95 R:80 A:95 D:95 |
| 2 | Certain | Destructive actions allowed only when the item's queue mode is `merge-auto` or a `by: user`/`by: chat` note says so; otherwise note + notify | Plan T4 Brief and Merge-modes Decision state it exactly | S:95 R:70 A:95 D:90 |
| 3 | Certain | Base branch is T3's `261120-7uqm-engine-rescope-pr-work-to-operator`; T3 left `brief_rules.md` untouched for T4 and flagged line 17 | User instruction + T3 plan.md line 89/217 | S:95 R:90 A:95 D:95 |
| 4 | Confident | The item's mode is read from the queue item's `scope.merge_mode` (also `autopilot status --json` `merge_mode`); a non-queue `github-pr` item has no mode and needs a user/chat note | Code: `autopilot/queue.go` stamps `scope.merge_mode`; T3 kept `merge_mode` in status JSON | S:70 R:75 A:80 D:70 |
| 5 | Confident | `track show` is a pure read mirroring `list` (no lock), plain = list line + fields + all notes, `--json` = envelope around the full item; missing item or state file → exit 1 | Mirrors `list`'s contract and the existing verbs' exit-code table; plan says "one item, all notes" | S:70 R:85 A:80 D:70 |
| 6 | Confident | `track show` is CLI-only (no MCP row) | All `track` verbs, `brief`, `check` are CLI-only per operator-state.md | S:60 R:85 A:85 D:80 |
| 7 | Certain | Exit contract: note only on acted-on items; no-op run writes no note; role line reworded to not imply a note; wrapper failure note unchanged | Plan Decision "Observation notes" + T4 Brief | S:90 R:85 A:85 D:80 |
| 8 | Confident | Recovery spawn uses `rk riff` and the run tracks it as a ledger item; `rk riff` and `wt` join allowed tools | Plan T4 Brief names `rk riff`; "every spawn is tracked" is the chat skill's existing rule | S:75 R:75 A:70 D:70 |
| 9 | Confident | Chat skill gets the Merging rules compactly (same substance as the brief), not a divergent copy | Plan: "merge all is the chat's own job (same Merging rules)" | S:75 R:85 A:70 D:65 |
| 10 | Confident | `by: user`/`by: chat` notes survive the size-cap trim until run notes reach zero; then oldest user/chat notes drop (best-effort) | Plan says "always includes" but the 100 KB cap must hold; this ordering honours both | S:45 R:85 A:60 D:45 |
| 11 | Confident | "Never edit files" / "No file-editing tools" get a narrow carve-out for conflict resolution in the temporary worktree rather than being removed | Plan says a conflict is the run's to resolve in the temp worktree, which needs edits; keeping the general prohibition preserves "coordinate, don't execute" | S:50 R:80 A:60 D:45 |
| 12 | Confident | After removing "escalation notes are the engine's", `escalated:` notes get no special rule (read like any `by: run` note) | Engine no longer escalates PR work after T3; Notes-are-the-memory already covers run notes | S:45 R:85 A:60 D:55 |
| 13 | Confident | Chat retry line changes from "zero after a rebase or cherry-pick conflict" to one conflict-resolution round, matching the run's Merging rules | Plan: chat follows "same Merging rules"; keeping zero would make chat and run diverge | S:45 R:85 A:55 D:50 |
| 14 | Certain | Plain `git push` and `git push --force` stay disallowed; only `--force-with-lease` (pinned to the observed head for stacked re-seats) | Plan: "push with `--force-with-lease` only" | S:85 R:70 A:85 D:85 |

14 assumptions (5 certain, 9 confident, 0 tentative, 0 unresolved).
