# Intake: Operator Run Brief and Chat Skill

**Change**: 261111-jsg9-operator-run-brief-chat-skill
**Created**: 2026-11-11

## Origin

> Plan step R4 (Run brief + chat skill, incl. interim autopilot text) from the plan at
> /home/sahil/code/sahil87/hexokit.worktrees/arcing-fjord/fab/plans/sahil/26-11-10-operator-to-hexokit.md —
> read that file (Rules, Decisions, and that step's brief) first. R1 (the operator state engine in
> internal/operator/) is merged on main; build on it. Do not touch or restart the live rk daemon or
> installed binaries.

Started with `/fab-new` from the plan's R4 brief. The plan is also in this repo at
`fab/plans/sahil/26-11-10-operator-to-hexokit.md`. Background:
`fab/plans/sahil/26-11-11-headless-run-spike.md` (S1 findings) and `docs/wiki/operator-explained.html`.

The R4 brief from the plan:

> - **Run brief** (≈ 10–15K tokens, in rk's skill bundle, e.g. `rk skill operator run`): what
>   changed + the affected items with notes + the rules — confirmation tiers, answer model
>   (routine prompts only), nudges, notify, "never merge / close / delete without the user unless
>   `merge-auto`", write a note before exiting. Tools limited to what runs need.
> - **Interim autopilot text**: §6 Queues + Dependency Resolution from `fab-operator.md`,
>   condensed, until R6 replaces it with Go.
> - **Chat skill** (`rk skill operator` or a deployed skill — decide at intake): talk to the user,
>   read and write notes via `rk operator track note`, spawn per the existing two-axis rule.
>   Never receives ticks.
> - Source material: `fab-operator.md` §1 Principles, §3 Safety, §5 Auto-Nudge, §6. Rewrite, don't
>   copy: ≈ 160KB becomes ≈ 15K tokens (brief) + a chat skill of similar size.

At intake the user settled the plan's one open R4 question and one design question:

1. **Chat skill = `rk skill operator`**, a static topic page shipped in the rk binary. The other
   options were a deployed `/operator` SKILL.md written into each provider's skills directory
   (rejected: rk would take on a new per-provider install-and-update job) and keeping the
   `/fab-operator` name as an alias (rejected: it collides with fab's own skill, which F1 retires).
2. **Run brief = a new `rk operator brief` verb** that assembles the brief from rule text built
   into the binary plus the live state file. The other option was a static `rk skill operator-run`
   page with R5 adding the changed items itself (rejected: the brief would be assembled in two
   places, and `rk skill` pages are static by contract, so they cannot carry changed items or notes).

## Why

**Problem.** Today the operator is one long-lived chat. rk cron types `operator tick` into it every
3–30 minutes. Every reply re-reads the whole history, so cost grows with the session's age: about
$451 over 149 h on loom2, 90 % of it re-reading cached history, and 76 % of ticks found nothing
changed. After the one compaction, the 108 KB `/fab-operator` skill fell out of context and the
operator ran on a summary of its own rules. The plan replaces this with a loop:
clock → Go check (R2) → **fresh headless run from a short brief** (R5) → note on the item. A
separate **chat** session talks to the user and never receives ticks.

R4 supplies the two texts that loop depends on:

- **The run brief.** Each run starts cold, so the brief is the run's entire knowledge: what
  changed, the affected items and their notes (the operator's memory), and the rules a run must
  follow. S1 found that codex never caches the brief (`cached_input_tokens` stays at a fixed
  ~10K prefix), so every run pays for the full brief. It must be short, and it is assembled fresh
  for each run.
- **The chat skill.** The new chat session needs its own skill: how to talk to the user, track
  work, spawn agents and record notes. It must not cover tick handling, which moves to runs.

**If we don't do it.** R5 has nothing to launch runs with, C1 has no chat skill to open in the
operator window, and the old 108 KB skill stays the only rule source.

**Why this approach.** A verb that renders the brief from the state file keeps assembly in one
place, in Go and under test. R5 only pipes the verb's output into the headless command on stdin
(S1 confirmed all three providers read the brief from stdin). A static `rk skill operator` topic
page follows the existing pattern (`rk skill cron`, `rk skill change`): versioned with the binary,
checked by the drift test, and within the toolkit skill standard's 150-line limit.

## What Changes

### 1. Brief renderer in `internal/operator` (library)

Add a brief renderer to `app/backend/internal/operator/` (e.g. `brief.go` plus embedded rule
files). It uses R1's types (`State`, `TrackedItem`, `Note`) and the store loader (`Load`,
`StatePathForServer`). It reads only; it never writes the state file.

Suggested shape (the final API is the planner's choice; the intent is fixed):

```go
// ChangedItem names one item the check found changed and why.
type ChangedItem struct {
    ID      string   // tracked item id
    Reasons []string // free-text deltas, e.g. "state: OPEN → MERGED", "agent waiting", "due (check_every 5m)"
}

type BriefInput struct {
    Server  string        // tmux server label (shown in the brief header)
    Now     time.Time     // render time (header; note/age rendering)
    Changed []ChangedItem // from R2's check (R5 wires it); may be empty
    State   *State        // loaded state file
}

func RenderBrief(in BriefInput) (string, error)
```

R2 (the check) is being built in parallel, so R4 must not depend on R2's output type.
`ChangedItem` is the small adapter type: R5 maps R2's result into it. If R2 merges first with a
compatible type, apply may reuse it instead.

**Brief layout** (Markdown, in this order):

1. **Header**: server, render time, and one line: "You are a one-shot operator run. Act on what
   changed, write a note, exit."
2. **What changed**: one row per `ChangedItem` (id · kind · reasons). An id missing from the
   state file is listed as `gone` and is not an error, because the item may have been removed
   between the check and the render.
3. **Affected items**: for each changed item, and for each item it `depends_on` or that depends on
   it (so queue and dependency context is there), a full block: kind, probe, scope (non-null keys
   only), `last`, held/done/paused/stale state, `depends_on`, `then`, and its **notes, newest last,
   capped** (see Size budget).
4. **Other tracked items**: one line each (id · kind · state), so the run can see the whole
   ledger without its full detail.
5. **Rules**: the embedded rule text (§2 below).
6. **Interim autopilot**: the embedded autopilot text (§3 below), in its **own embedded file and
   its own section**, so R7 removes it by deleting one file and one include.
7. **Exit contract**: before exiting, append at least one note per item you acted on, or one note
   on the most relevant item when nothing needed doing:
   `rk operator track note <id> "<text>" --by run`. Then print exactly one final line
   `outcome: <one-line summary>`, which R5 will read for the Cron Log row.

**Size budget.** S1 says shrink the brief rather than rely on the cache. Targets: rules plus
autopilot ≤ ~40 KB of text (≈ 10K tokens); notes per affected item capped (default: the last 10;
older notes summarized as `(+N earlier notes)`); and a **hard total cap well below 120 KB**
(S1: `execve` rejects a single argv word over 128 KiB, which kimi's `-p "$(cat)"` form hits). Over
the cap, the renderer trims in order (other-items lines → older notes) and adds a trailing
truncation marker. It never drops the rules or the What-changed section.

**Determinism.** For the same input the output is byte-stable: items in state-file order, map
keys sorted. This makes golden tests possible.

### 2. Run rules text (embedded, rewritten from fab-operator.md §1/§3/§5)

Rewrite, don't copy: from `~/code/sahil87/fab-kit/src/kit/skills/fab-operator.md` (108 KB), write
a short rule text for a **one-shot, unattended run**. It is embedded via `//go:embed` from a
Markdown file inside `internal/operator/`. It covers:

- **Role.** One-shot run with no memory beyond this brief and the notes. Coordinate, don't
  execute: never read code to diagnose and never edit files. Act only on the changed items and
  what they unblock.
- **Confirmation tiers**, unattended version: read-only actions are free. Recoverable actions
  (send a routine command to an idle agent, rebase or cherry-pick for dependency resolution) may
  proceed and are recorded in a note. Destructive actions (merge a PR, close a PR, delete a branch
  or worktree, archive) **never** happen in a run unless the item's `scope.merge_mode` is
  `merge-auto` and the action is that mode's merge. Otherwise the run writes a note and sends
  `rk notify` asking the user, and stops on that item.
- **Pre-send validation**: the pane must exist and the agent state must fit the send
  (`@rk_pane_agent_state`). A run never sends to an `active` agent and never uses `--force`.
- **Auto-nudge / answer model** (§5), **routine prompts only**: classify with
  `rk mux capture <pane> --lines 40 --classify --json`; answer yes/no, `[Y/n]` and permission
  prompts with `y`; numbered menus that are routine (synonymous or permission-type options) get
  the first/default option. Re-capture before sending and abort if the output changed. Send with
  `rk mux send <pane> "<text>" --answer`, or `--key` for key names. **Strategic prompts are not
  auto-picked in a run**: leave them open, `rk notify`, and write a note. The 30-minute idle
  auto-default may apply when the pane's agent-state duration shows ≥ 30 min and the note history
  shows the prompt was already left open and notified.
- **Stuck nudge**: at most one nudge per stuck agent, recorded in a note. A second occurrence (seen
  from notes) escalates via `rk notify`.
- **Bounded retries** from §3: rebase conflict 0 → escalate; cherry-pick conflict → abort and
  escalate; pane death → report, and respawn only queue-driven items, once.
- **Notify**: `rk notify` behind `command -v rk`, fail-silent: a failed notify is noted, never
  fatal.
- **Notes are the memory**: read an item's notes before acting. User instructions arrive as
  `by: user` / `by: chat` notes, and the run follows them.
- **Allowed tools** (stated in the brief; enforced at launch by R5, not here): `rk operator track …`,
  `rk mux capture|send|inventory`, `rk notify`, `rk tab`/`rk riff` (queue spawns only),
  `wt create`, `git fetch|cherry-pick|rebase` (dependency resolution only), `gh pr view|checks`
  (and `gh pr merge` only under `merge-auto`), and fab reads (`fab pane map`, `.status.yaml`,
  `fab status set-base-branch`, `fab agent … -o yaml`) when fab is present. No file editing tools.
- **Agent probes** (`linear`/`slack` items marked due): the run executes the item's
  `probe.instruction`, records the result with `rk operator track observe <id> --json … [--seen …]`,
  and notes anything new.

### 3. Interim autopilot text (embedded, separate file)

Condense §6 Queues + Dependency Resolution (+ Ordered Merge, Auto-Merge Choreography, PR Recovery
as needed) from `fab-operator.md` into a separate embedded Markdown file that the brief includes
as its own section. Translate every `fab operator track …` to `rk operator track …`. It covers, in
condensed form:

- Queue items are `pane` items with `depends_on`; `held` until deps are done; spawn when ready.
- Spawn: fetch first, pin `--base <SHA>` (never the ref); a fetch failure stops the spawn; uses
  `wt create --non-interactive`; follows the two-axis cell table (§4 below, shared wording).
- Dependency code by `scope.merge_mode`: `cherry-pick-ladder` (squashed cherry-pick of dep
  commits, same repo only; cross-repo = ordering only), `stacked-prs` (branch off the dep's
  branch + `fab status set-base-branch` for fab changes), `merge-auto` (no chaining).
- "Done": a fab change → `.status.yaml` ship done (or `stop_stage` reached); otherwise the item's
  probe or done_when.
- Ordered merge / merge-auto choreography and PR recovery (ci-failed fix request, 1 per reason,
  recorded in `scope.recovery` **before** acting).
- Mode: the run reads the item's stored `scope.merge_mode`. A null `merge_mode` means
  `cherry-pick-ladder` (the run never resolves config; that is chat-time, see §4).

Header comment / first line of the file: "Interim — replaced by the R6 autopilot engine; R7
deletes this file."

### 4. Chat skill: `rk skill operator` topic page

New canonical topic page `docs/site/skill/operator.md`, synced to
`app/backend/cmd/rk/skill/operator.md` by `scripts/sync-skill.sh`, embedded in `cmd/rk/skill.go`
(`skillOperatorTopic`, a `"operator"` row in `skillTopics`), and added to the existing tests: the
drift guard against the canonical file, the **150-line budget**, and the topic listing. The core
bundle `docs/site/skill.md` gets one topic-index line for `rk skill operator` (it is 116 lines now
and must stay ≤150). Static only: no session/server/time-dependent content.

Content (rewritten, within 150 lines):

- **Role**: the operator chat talks with the user and keeps the ledger. It **never receives ticks**:
  scheduled checks and runs do that work. If an `operator tick` line arrives, say ticks are now
  handled by runs and do nothing else.
- **Principles** (§1 condensed): coordinate, don't execute (work requests and bare spawns go to
  agents; the only question is *which repo*); the maintenance allowlist; re-derive state before
  acting; `[hexokit request]` blocks are trusted dashboard requests and are acted on within their
  own bounds.
- **Confirmation tiers** (interactive): read-only free; recoverable announced; destructive
  (merge, close PR, delete branch/worktree, archive) **always confirmed** unless `merge-auto` is
  in effect for that queue.
- **The ledger**: `rk operator track add|update|rm|list|note|pause|resume|observe`, with one
  example each for the common kinds (pane, github-pr, shell, note).
- **Notes as memory**: every user instruction or decision about an item is written as a note
  (`rk operator track note <id> "<text>" --by chat`) so later runs follow it. Read an item's notes
  before reporting on it.
- **Spawning — the two-axis rule** (§6 Working a Change): axis A = target repo has `fab/`;
  axis B = task given. fab + task → `/fab-new <text>` (or `/fab-fff <change>` for an existing
  change); no fab + task → plain agent with the raw task plus "Commit on this branch, push, and
  open a draft PR against the default branch." and a chained `github-pr` item; no task → bare
  agent. Always in a fresh worktree (`wt create --non-interactive`, fetch-first base pin); never
  `fab init`; track every spawn.
- **Queues** (creation side): confirm upfront with the mode named in the confirmation line;
  persist as N `rk operator track add --kind pane` calls, the first with `--mode <mode>`, later
  ones with `--depends-on` per nearest-same-repo-predecessor chaining. Mode ladder at chat time:
  explicit user instruction > config (`fab config get autopilot.merge_mode` when fab is present)
  > `cherry-pick-ladder`. Runs then drive the queue.
- **What a run sees**: `rk operator brief` prints the brief a run would get, for debugging.

The kickoff typed by `rk operator` (`operatorKickoffPrompt = "/fab-operator"` in
`cmd/rk/operator.go`) is **not changed** in R4. Switching the operator window to the new chat
skill is a cutover action (R5 / C1). Before then fab still seeds the typed `operator tick` cron
entry, and the old skill is the one that handles it.

### 5. `rk operator brief` CLI verb

New verb under `rk operator` (file `cmd/rk/operator_brief.go`, test `operator_brief_test.go`):

```
rk operator brief [-L <server>] [--changed <id>[=<reason>]]... [--state <path>]
```

- Resolves the state file like `rk operator track` does (`-L/--server`, default the caller's
  server from `$TMUX`, else `default`), loads it, renders, and prints the brief to stdout
  (stdout is data; nothing else on stdout; exit 0).
- `--changed` may repeat; `id=reason` attaches a reason (repeat the id for multiple reasons).
  With no `--changed`, the What-changed section says "nothing flagged — manual render", and the
  brief still renders (chat debugging, R5 tests).
- `--state <path>` reads an explicit state file (tests, R5 flexibility) instead of resolving one.
- A missing state file renders an empty-ledger brief (not an error), matching R1's tolerant read
  of an absent file. A `--changed` id that is not in the file renders as `gone`. A malformed state
  file is exit 1.
- Help text and `rk help-dump` pick the verb up through the cobra tree. Check the new surface
  against the shll standards (help-dump, skill) per the constitution's Toolkit Standards rule.

### 6. Out of scope

- Launching runs, the cron loop, Cron Log outcomes, tool restriction at launch (R5).
- The check/diff and `ChangedItem` production (R2).
- Go autopilot engine (R6), removal of the interim text (R7).
- Changing the `rk operator` kickoff, fab's `/fab-operator` skill, or the cron entry (R5/F1/C1).
- MCP exposure of `operator brief` (not requested).
- Any action against the live rk daemon, the live tmux servers, or installed binaries (plan Rule 1).
  Tests run through `just test-backend` only.

## Affected Memory

- `run-kit/operator-brief`: (new) the run brief: the `rk operator brief` verb, `RenderBrief` layout,
  size budget and trim order, embedded rule and interim-autopilot files, exit contract
  (`--by run` note + `outcome:` line), and the `rk skill operator` chat topic (role, never-ticks,
  two-axis spawn, notes as memory)
- `run-kit/operator-state`: (modify) cross-reference the brief as a read-only consumer of the state
  file and add `rk operator brief` to the `rk operator` verb family
- `run-kit/toolkit-standards`: (modify) record the new `operator` skill topic and the
  `rk operator brief` CLI surface in the skill / help-dump conformance notes

## Impact

- **New Go**: `app/backend/internal/operator/brief.go` (+ `brief_test.go`, golden fixtures under
  `testdata/`), two embedded Markdown files in `internal/operator/` (run rules; interim
  autopilot), `app/backend/cmd/rk/operator_brief.go` (+ test), command registration in the
  `rk operator` tree.
- **Skill bundle**: `docs/site/skill/operator.md` (new canonical), `docs/site/skill.md` (topic
  index line), `scripts/sync-skill.sh` (sync row), `app/backend/cmd/rk/skill/operator.md` (synced
  copy), `app/backend/cmd/rk/skill.go` (embed + map row), `app/backend/cmd/rk/skill_test.go`
  (drift, budget, topic rows).
- **No UI change**, so no Playwright evidence; the PR states `No recording: CLI/library only`.
- **No new dependencies.** Reads R1's store; no writes. No subprocesses in the renderer.
- **Downstream**: R5 consumes `rk operator brief` (or `RenderBrief` directly in the daemon); F1
  points `/fab-operator` at `rk skill operator`; R7 deletes the interim autopilot file.

## Open Questions

- Should R5 call `RenderBrief` in-process from the daemon, or exec `rk operator brief`? Both work
  with this design; R5 decides.
- Exact note cap per affected item (default 10 assumed) and the hard size cap (≈ 100 KB assumed).
  M1's measurements may tune these.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Chat skill is delivered as the static topic page `rk skill operator` (canonical `docs/site/skill/operator.md`, synced and embedded, ≤150 lines) | Asked — user chose `rk skill operator` over a deployed `/operator` skill or a `/fab-operator` alias | S:95 R:70 A:90 D:95 |
| 2 | Certain | The run brief is rendered by a new `rk operator brief` verb backed by a `RenderBrief` library function in `internal/operator`, from embedded rule text plus the live state file | Asked — user chose the verb over a static `rk skill operator-run` page + R5 composition; `rk skill` is static-only by contract | S:95 R:70 A:90 D:95 |
| 3 | Certain | Builds on R1's `internal/operator` types and store; the brief is read-only against the state file | Plan R4 depends on R1; user said build on it; R1 memory defines the store contract | S:90 R:80 A:95 D:95 |
| 4 | Certain | No action against the live rk daemon, tmux servers, or installed binaries; testing via `just test-backend` only | User instruction + plan Rule 1 + constitution § PR Evidence | S:100 R:60 A:100 D:100 |
| 5 | Confident | The interim autopilot text lives in its own embedded file and brief section so R7 deletes it cleanly | Plan R7 "Delete the interim autopilot text" — isolation makes that a one-file removal | S:80 R:85 A:85 D:80 |
| 6 | Confident | R4 does not change the `rk operator` kickoff (`/fab-operator`); switching the operator window to the chat skill is R5/C1 | Plan Rule 1 and C1 step 4 — before cutover fab still seeds the typed tick entry handled by the old skill | S:70 R:85 A:80 D:75 |
| 7 | Confident | A small `ChangedItem{ID, Reasons}` adapter type is the brief's input instead of R2's output type, since R2 is built in parallel | R2 and R4 are parallel lanes after R1; R5 wires them; reuse R2's type if it lands first and fits | S:65 R:85 A:75 D:70 |
| 8 | Confident | Runs never take destructive actions (merge/close/delete/archive) except the merge under `merge-auto`, never auto-pick strategic prompts, never send to `active` agents or use `--force` | Plan Decisions (merge authority) + brief "answer model (routine prompts only)"; an unattended run has no user to confirm | S:80 R:70 A:80 D:80 |
| 9 | Confident | Exit contract: at least one `--by run` note, then a final `outcome: <one-line>` stdout line for R5's Cron Log row | Plan: "write a note before exiting" + R5's `ran · <one-line outcome>` Cron Log row; S1: runs must leave an outcome even on failure | S:75 R:85 A:75 D:70 |
| 10 | Confident | Allowed-tool list is stated in the brief text; enforcement at launch belongs to R5 | Plan: "Tools limited to what runs need"; R4 has no launch path, so it can only declare the list | S:70 R:85 A:75 D:75 |
| 11 | Tentative | Size budget: rules + autopilot ≤ ~40 KB, last 10 notes per affected item, hard total cap ≈ 100 KB with trim order other-items → older notes, never dropping rules or What-changed | S1: no brief caching on codex and a 128 KiB argv limit for kimi; exact numbers are a judgment M1 may tune | S:55 R:85 A:55 D:50 |
| 12 | Tentative | Affected-item set = changed items plus their direct `depends_on` neighbours (both directions); everything else as one-liners | Queue and dependency actions need the neighbours' state; a full ledger dump would blow the size budget | S:50 R:85 A:60 D:55 |
| 13 | Tentative | Chat-time merge-mode ladder: user instruction > `fab config get autopilot.merge_mode` (fab present) > `cherry-pick-ladder`; runs read only the stored `scope.merge_mode` (null ⇒ cherry-pick-ladder) | R1's library reads no config; where `merge_mode` lives long-term is R6's open decision, so the interim keeps fab's key read through the fab CLI | S:50 R:80 A:55 D:45 |
| 14 | Confident | Missing state file renders an empty-ledger brief; an unknown `--changed` id renders as `gone`; a malformed file exits 1 | Mirrors R1's tolerant read of an absent file; the check-to-render race can remove items | S:65 R:90 A:75 D:70 |

14 assumptions (4 certain, 7 confident, 3 tentative, 0 unresolved).
