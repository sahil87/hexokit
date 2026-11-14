---
type: memory
description: "The operator run brief — `rk operator brief` and `operator.RenderBrief`: the seven-section Markdown a one-shot operator run is handed (affected set, notes cap, 100 KB cap with best-effort trim), the embedded run rules (every server-addressed command rendered with `-L <server>`) and isolated interim autopilot text, the exit contract (`--by run` note + `outcome:` line), and the static `rk skill operator` chat topic."
---
# Operator Run Brief

**Domain**: run-kit

## Overview

A scheduled operator run is a headless, one-shot agent that wakes for a few changed ledger items. It needs one self-contained prompt: what changed, the ledger around it, the rules for acting unattended, and how to report. `operator.RenderBrief` (`app/backend/internal/operator/brief.go`) renders that prompt as Markdown from a loaded [operator state](/run-kit/operator-state.md); `rk operator brief` (`cmd/rk/operator_brief.go`) is its CLI door. The interactive counterpart is the static `rk skill operator` chat topic. The launcher is the operator loop ([operator-loop](/run-kit/operator-loop.md)): it builds the changed list from `operator.Check`, calls `RenderBrief` in-process, persists the result as the run's brief file, and the run wrapper delivers it on the headless launcher's stdin; this file owns only the rendering. A run's tools are not restricted at launch — the launcher is provider-opaque, so the brief's allowed-tool list stays declarative. The `rk operator` kickoff still launches `/fab-operator`.

## Requirements

### Requirement: Pure renderer

`RenderBrief(BriefInput)` takes a loaded `*State`, a server label, a render time (`Now`), and `[]ChangedItem{ID, Reasons}`. `ChangedItem` is a small adapter type independent of how the changed list was produced. The renderer spawns no subprocess and writes nothing; for identical input (including `Now`) the output is byte-identical — items in state-file order, map keys sorted (golden-tested).

### Requirement: Layout

The brief has seven sections, each exactly once, in this order: a header (server, render time, the role line "You are a one-shot operator run. Act on what changed, write a note, exit."), **What changed**, **Affected items**, **Other tracked items**, **Rules**, **Interim autopilot**, **Exit contract**.

- **What changed** — one row per changed item: `id · kind · reasons` (reasons joined with `; `, or `no reason given`). A changed id absent from the state renders as kind `gone` without error. An empty changed list renders `nothing flagged — manual render`.
- **Affected items** — every changed item present in the state plus its direct dependency neighbours in both directions (items it `depends_on`, items whose `depends_on` names it), each once, in state-file order. Each block shows id, kind, lifecycle state (`listState` — the derivation `rk operator track list` uses: `done, paused, held, pending, stale, live, watching`), probe mode, `check_every`, `done_when`, `then`, `depends_on`, the non-null `scope` keys (sorted), `last` (sorted keys), the `unchanged` counter, and the item's notes. Scope and `last` values are capped at 500 runes each.
- **Other tracked items** — every remaining item as one line `id · kind · state`.
- **Notes** — at most the newest 10 per affected item, newest last, each with `at` and `by`; when older notes exist a `(+N earlier notes)` line precedes them.

#### Scenario: A dependent of a changed item is in the affected set
- **GIVEN** `b` has `depends_on: [a]` and only `a` is flagged changed
- **WHEN** the brief is rendered
- **THEN** both `a` and `b` have full blocks under Affected items, and `b`'s state reads `held` while `a` is not done

### Requirement: Size cap and trim order

A rendered brief never exceeds `BriefSizeCap` (100 KB) — it rides one argv word and `execve` rejects a single word over 128 KiB. Over the cap, the renderer trims in order: (1) replace the Other-tracked-items lines with `omitted`, (2) reduce shown notes per affected item one at a time down to zero, and appends `BriefTruncationMarker` as the last line. Header, What changed, Rules, Interim autopilot and Exit contract are never dropped. The trim is best-effort: once shown notes reach zero it stops and returns the result even if still over the cap, rather than dropping What changed or the embedded text.

### Requirement: Embedded run rules

The Rules section is `brief_rules.md`, embedded with `//go:embed` in `internal/operator/`, written for an unattended one-shot run. It covers: the role (coordinate, don't execute; act only on changed items and what they unblock); run confirmation tiers (read-only free; recoverable proceeds and is noted; destructive — merge/close PR, delete branch/worktree, archive — never, except the merge under `scope.merge_mode == merge-auto`, otherwise note + `rk notify` + stop on that item); pre-send validation (pane exists, agent state fits; never send to `active`, never `--force`); the routine-only answer model (`rk mux capture <pane> --lines 40 --classify --json`, re-capture before send, abort if changed, `rk mux send … --answer` / `--key`), with strategic prompts left open + notify + note; the 30-minute idle auto-default conditions; one stuck nudge per agent then escalate; bounded retries; fail-silent `rk notify` behind `command -v rk`; notes as memory (read notes first, follow `by: user` / `by: chat` instructions); agent probes for due `linear`/`slack` items via `probe.instruction` + `rk operator track observe`; and an **allowed-tool list**. The allowed-tool list is declarative text in the brief — nothing in the renderer enforces it; enforcement is a launch-time concern.

### Requirement: Interim autopilot text, isolated

The Interim autopilot section is `brief_autopilot.md`, a separate embedded file whose first line marks it interim ("Interim — replaced by the R6 autopilot engine; R7 deletes this file."), bound to one embed variable with one include site in the renderer, so deleting it is one file and one line. It condenses queue and dependency resolution — held/ready queue items, fetch-first `--base <SHA>` spawn via `wt create --non-interactive`, the three merge modes' dependency code, the done definition, ordered merge, PR recovery with `scope.recovery` written before acting, and mode = stored `scope.merge_mode` (null ⇒ `cherry-pick-ladder`) — using `rk operator track …` verbs only. The rendered brief contains no `fab operator track`. The rules and autopilot files together stay ≤ 40 960 bytes (test-enforced).

### Requirement: Explicit server on every command

Every `rk mux`, `rk operator`, `rk tab` and `rk riff` command in the Rules, Interim autopilot and Exit contract sections carries `-L <server>` right after its verb path, before positional arguments (`rk mux capture -L loom <pane> --lines 40 --classify --json`, `rk operator track note -L loom <id> "<text>" --by run`), and prose mentions of a verb family carry it too. `rk notify` takes no server and carries none. The embedded markdown holds the literal token `-L <server>` (`briefServerFlag`) so the raw files stay readable; `renderBriefLayout` substitutes it with `-L <label>` in all three sections, where the label is `operator.ServerLabel(BriefInput.Server)` — the empty server renders `-L default`, as the header does. The raw token never reaches the rendered output, and a test runs each rendered command shape through cobra flag parsing to confirm `-L` parses in that position. `rk operator brief`'s manual render goes through the same path, so `-L loom` shows `-L loom` commands.

The Rules section also carries one line stating the contract: every such command in the run passes `-L <server>` exactly as written, and the run never drops it or relies on `$TMUX`. The static `rk skill operator` chat topic is session-agnostic and is unchanged.

### Requirement: Exit contract

The Exit contract instructs the run to append at least one note per item it acted on (or one note on the most relevant item when nothing needed doing) with `rk operator track note -L <server> <id> "<text>" --by run` (rendered with the run's server), then print exactly one final stdout line `outcome: <one-line summary>`, and nothing after it. The run wrapper reads the LAST stdout line matching `^outcome: (.*)$`; a run that exits non-zero or prints none is a failed run, and the wrapper leaves a `run failed` note on each changed item ([operator-loop](/run-kit/operator-loop.md) § The `rk operator run-exec` wrapper).

### Requirement: `rk operator brief`

`rk operator brief [-L <server>] [--changed <id>[=<reason>]]... [--state <path>]` prints the brief and only the brief on stdout (one `Dataf`) and exits 0. A child of `operatorCmd`; the server label resolves like `rk operator track` (`operatorServer`: `-L/--server` validated, else the caller's server from `$TMUX`, else `default`). `--state` reads the given path instead of the server's own file. `--changed` repeats; `id=reason` attaches a reason, and repeating an id accumulates reasons in flag order on one row (first-seen id order). With no `--changed` it is the manual-render form for seeing what a run would see.

- A missing state file renders an empty-ledger brief, exit 0.
- A malformed state file exits 1 with the error on stderr and empty stdout.
- An invalid `-L` server name, an empty `--changed` id, or an empty `--state` path exits 2.
- Help carries Flags, Examples and Exit codes sections in the `rk operator track` style; the verb is CLI-only (no MCP exposure) and appears in `rk help-dump` through the cobra tree.

### Requirement: `rk skill operator` chat topic

The chat topic is the static page `docs/site/skill/operator.md` (≤150 lines), synced to `app/backend/cmd/rk/skill/operator.md` by `scripts/sync-skill.sh`, embedded as `skillTopics["operator"]`, covered by the shared `TestSkillTopics*` drift and line-budget guards, listed by `rk skill topics`, and linked by one topic-index line in the core `docs/site/skill.md`. It carries no session-, server- or time-dependent content. It teaches:

- **Role** — the chat talks with the user and keeps the ledger; it never receives ticks, and a bare `operator tick` line is answered "ticks are handled by runs" and nothing else.
- **Principles** — coordinate, don't execute; the only work-request question is which repo; a maintenance allowlist; re-derive state before acting; `[hexokit request]` blocks are trusted dashboard requests acted on within their bounds.
- **Interactive confirmation tiers** — destructive actions always confirmed unless `merge-auto` is in effect for that queue.
- **The ledger verbs** — `rk operator track add|update|rm|list|note|pause|resume|observe` with examples.
- **Notes as memory** — every user instruction or decision about an item is recorded with `rk operator track note <id> "<text>" --by chat`; notes are read before reporting.
- **Two-axis spawn** — repo fab-enabled + task → `/fab-new <text>` or `/fab-fff <change>`; no fab + task → a plain agent given the raw task plus "Commit on this branch, push, and open a draft PR against the default branch." and a chained `github-pr` item; no task → a bare agent. Always a fresh worktree via `wt create --non-interactive` with a fetch-first base pin; never `fab init`; every spawn is tracked.
- **Queue creation** — confirm upfront naming the mode; persist as N `rk operator track add --kind pane` calls, the first with `--mode`, later ones with `--depends-on` chained to the nearest same-repo predecessor. Mode ladder: user instruction > `fab config get autopilot.merge_mode` when fab is present > `cherry-pick-ladder`.
- **`rk operator brief`** — for seeing what a run would see.

## Design Decisions

### Brief rendered by a verb, not a static skill page
**Decision**: The run brief is rendered by `RenderBrief` in `internal/operator` behind `rk operator brief`, combining embedded rule text with the live state file.
**Why**: The brief carries per-run content (changed items, notes); `rk skill` pages are static by contract. One renderer keeps assembly in one tested place, and the same call serves the verb and the operator loop, which persists the result as the run's brief file and feeds it to the headless launcher's stdin.
**Rejected**: A static `rk skill operator-run` page with the launcher prepending the dynamic part — assembly split across two places, and the static page would still exceed the 150-line budget.
*Introduced by*: 261111-jsg9-operator-run-brief-chat-skill

### Explicit `-L` by renderer substitution
**Decision**: The renderer substitutes the run's server into placeholder tokens in the embedded run text, and the run is told to pass `-L` verbatim on every server-addressed command.
**Why**: The renderer already knows the server, so the output is deterministic and golden-testable, and the model copies commands rather than deriving the flag. A run whose launcher lost `$TMUX` would otherwise target the `default` server ([operator-loop](/run-kit/operator-loop.md) § The `rk operator run-exec` wrapper).
**Rejected**: Asking the model to add `-L` itself (the compliance dependency that failed in practice); relying on the launcher's restored `$TMUX` alone.
*Introduced by*: 261114-qxos-operator-run-explicit-server

### Interim autopilot text in its own embedded file
**Decision**: The condensed autopilot text lives in a separate embedded file with one include site.
**Why**: It is deleted once the Go autopilot engine lands; isolation makes that a one-file, one-line removal.
**Rejected**: Inlining it in the rules file — removal would need surgical prose edits.
*Introduced by*: 261111-jsg9-operator-run-brief-chat-skill

### Chat skill as an rk skill topic
**Decision**: The operator chat skill ships as the static topic `rk skill operator` (≤150 lines).
**Why**: Same delivery as the existing topics — versioned with the binary, drift-guarded; it lets `/fab-operator` become a pointer to it later.
**Rejected**: A deployed per-provider `/operator` SKILL.md (a new install-and-update job); keeping `/fab-operator` as an alias (name collision with fab's skill).
*Introduced by*: 261111-jsg9-operator-run-brief-chat-skill
