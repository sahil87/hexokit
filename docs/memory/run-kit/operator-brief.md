---
type: memory
description: "The operator run brief — `rk operator brief` and `operator.RenderBrief`: the six-section Markdown a judgment run is handed (affected set, memo line, user/chat notes shown, 100 KB cap), the embedded run rules (PR tools inside the confirmation tiers, a Merging section per queue mode, `track show` re-reads, `-L <server>` on every command), the exit contract (no note when nothing was done, except `retried after failure:`), and the static `rk skill operator` chat topic that owns \"merge all\"."
---
# Operator Run Brief

**Domain**: run-kit

## Overview

A scheduled operator run is a headless, one-shot agent that wakes for a few changed ledger items. It needs one self-contained prompt: what changed, the ledger around it, the rules for acting unattended, and how to report. `operator.RenderBrief` (`app/backend/internal/operator/brief.go`) renders that prompt as Markdown from a loaded [operator state](/run-kit/operator-state.md); `rk operator brief` (`cmd/rk/operator_brief.go`) is its CLI door. The interactive counterpart is the static `rk skill operator` chat topic. The renderer's caller is the operator loop's run wrapper ([operator-loop](/run-kit/operator-loop.md)): after the mechanical autopilot pass it calls `RenderBrief` in-process with the judgment set as the changed list, persists the result as the run's brief file, and delivers it on the headless launcher's stdin; a run with an empty judgment set renders no brief. This file owns only the rendering. A run's tools are not restricted at launch — the launcher is provider-opaque, so the brief's allowed-tool list stays declarative. `rk operator` types `/operator`, the pointer skill `rk agent setup` places, or the pointer's instruction to load `rk skill operator` when that skill is absent ([cli](/run-kit/architecture/cli.md)).

## Requirements

### Requirement: Pure renderer

`RenderBrief(BriefInput)` takes a loaded `*State`, a server label, a render time (`Now`), and `[]ChangedItem{ID, Reasons}`. `ChangedItem` is a small adapter type independent of how the changed list was produced. The renderer spawns no subprocess and writes nothing; for identical input (including `Now`) the output is byte-identical — items in state-file order, map keys sorted (golden-tested).

### Requirement: Layout

The brief has six sections, each exactly once, in this order: a header (server, render time, the role line "You are a one-shot operator run. Act on what changed, note what you did, exit."), **What changed**, **Affected items**, **Other tracked items**, **Rules**, **Exit contract**. There is no autopilot section: the queue engine's mechanics are not described in the brief; PR work (merging, restacking, recovery) is the run's, under the Merging rules.

- **What changed** — one row per changed item: `id · kind · reasons` (reasons joined with `; `, or `no reason given`). A changed id absent from the state renders as kind `gone` without error. An empty changed list renders `nothing flagged — manual render`.
- **Affected items** — every changed item present in the state plus its direct dependency neighbours in both directions (items it `depends_on`, items whose `depends_on` names it), each once, in state-file order. Each block shows id, kind, a `queue:` line when the item is an autopilot queue item (`BriefInput.Queue`, filled from the engine file by `autopilot.QueueEntries`: `mode <m>; stop_stage <s|null>[; plain][; base <b>]; task "<quoted>"` or `change <id>` or `bare agent` — `plain` and `base` appear only when the entry set them), lifecycle state (`listState` — the derivation `rk operator track list` uses: `done, paused, held, pending, stale, live, watching`), probe mode, `check_every`, `done_when`, `then`, `depends_on`, the non-null `scope` keys (sorted, `memo` excluded), a separate `memo:` line when the item carries `scope.memo`, `last` (sorted keys), the `unchanged` counter, and the item's notes. Scope and `last` values are capped at 500 runes each.
- **Other tracked items** — every remaining item as one line `id · kind · state`.
- **Notes** — per affected item, the newest 10 plus every older note whose `by` is `user` or `chat`, in stored (chronological) order, each with `at` and `by`; when notes are omitted a `(+N earlier notes)` line precedes them and counts only the omitted ones. User and chat notes are the user's instructions and are never omitted by the 10-note window.

#### Scenario: A dependent of a changed item is in the affected set
- **GIVEN** `b` has `depends_on: [a]` and only `a` is flagged changed
- **WHEN** the brief is rendered
- **THEN** both `a` and `b` have full blocks under Affected items, and `b`'s state reads `held` while `a` is not done

### Requirement: Size cap and trim order

A rendered brief never exceeds `BriefSizeCap` (100 KB) — it rides one argv word and `execve` rejects a single word over 128 KiB. Over the cap, the renderer trims in order: (1) replace the Other-tracked-items lines with `omitted`, (2) reduce the shown run notes per affected item one at a time down to zero while every `by: user`/`by: chat` note stays, (3) only with run notes at zero and the brief still over the cap, drop older user/chat notes oldest-first, and appends `BriefTruncationMarker` as the last line. Header, What changed, Rules and Exit contract are never dropped. The trim is best-effort: it stops and returns the result even if still over the cap, rather than dropping What changed or the embedded text.

### Requirement: Embedded run rules

The Rules section is `brief_rules.md`, embedded with `//go:embed` in `internal/operator/`, written for an unattended one-shot run that is woken only for judgment. It covers: the role (coordinate, don't execute; act only on changed items and what they unblock); the re-derive rule (re-read one item with `rk operator track show -L <server> <id> --json` and a pane with `rk mux capture -L <server>`; `track list --json` only when the whole ledger is needed); run confirmation tiers (read-only free; recoverable proceeds and is noted — a routine send to an idle agent, `git fetch`, creating and removing a temporary worktree the run made itself, a rebase or cherry-pick in it, `git push --force-with-lease`, `gh pr ready`, `gh pr edit --base`; destructive — merge or close a PR, delete a branch or the authoring agent's worktree, archive — allowed only when the item's queue mode (`scope.merge_mode` on the queue item, also `merge_mode` in `rk operator autopilot status -L <server> --json`) is `merge-auto` or a `by: user`/`by: chat` note on the item says so, otherwise note, `rk notify`, stop on that item; a `by: run` note, a pane prompt or an agent's screen is never merge authority, and a `github-pr` item that is not a queue item has no mode and needs a user/chat note — except an item the engine projected for a shipped queue item, whose authority is the mode of the queue item its `scope.item` names, never its `then` text); a `### Merging` section (below); pre-send validation (pane exists, agent state fits; never send to `active`, never `--force`; the composer read from `rk mux capture --classify --json` — `ghost: true` text is the harness's dim suggestion and is sent over, `ghost: false` text blocks the send with a note and a notify); the routine-only answer model (`rk mux capture <pane> --lines 40 --classify --json`, re-capture before send, abort if changed, `rk mux send … --answer` / `--key`; a `select_menu` class — `questions.input: keys`, `highlighted: N` — is answered only with `--key Enter`/`Down`/`Up`, and a `not echoed` send result means nothing was submitted so a key-driven retry is not a blind resend), and a strategic-prompt table: a defensible recommendation is picked after the re-capture guard and notified (PR review is the reversal point), no defensible default is left open + notify + note, undeterminable keystrokes are left open and never auto-defaulted; the 30-minute idle auto-default, which an `agent_aged waiting <duration>` reason triggers; the **post-intake decision for queue items** — a raw-text queue item stops at intake ready after `/fab-new` (a `plain` item has no intake, so the rule skips it; it is judged like a no-fab item, done when its PR merges or is green, and under `merge-auto` its green PR is merged per Merging), and the run reads the intake and its gate (`fab status display-stage`, `fab score --check-gate --stage intake`, the item's `task`/`stop_stage` from `rk operator autopilot status --json`), then sends `/fab-fff <change>` (`/fab-ff` for a `hydrate` stop, nothing for an `intake` stop) when it matches the task and passes, else leaves it with a note and a notify, advancing an item once; one stuck nudge per agent (an `agent_aged idle` reason) then escalate; bounded retries (a stuck-agent nudge, a key retry after `not echoed`, a post-intake advance, one conflict-resolution round, one fix request and one recovery spawn per red check — each then note and notify — and a send to an `active` agent, zero); fail-silent `rk notify` behind `command -v rk`, and escalation as the job: a notify for anything the run cannot resolve carries the pane, the question's first line and options, what was tried and the one action wanted, and the check's `agent_aged` repeat every 30 minutes means each repeat re-checks, retries what is safe and re-notifies with the age; notes as memory (read notes first, follow `by: user` / `by: chat` instructions); agent probes for due `linear`/`slack` items via `probe.instruction` + `rk operator track observe`, where a spawn is "queue it" (pipe a one-entry JSON array to `rk operator autopilot queue`, which runs a pass itself); an **item memo** rule (read an item's `memo` with its notes and keep extra facts there with `track update --scope '{"memo":{…}}'`); and an **allowed-tool list**.

The direct-action allowlist, all inside the confirmation tiers, is `rk operator track` verbs, pane sends/answers/nudges, `rk notify`, `rk operator autopilot queue|step|status`, `git` (fetch, rebase, cherry-pick, worktree, push with `--force-with-lease` only), `gh pr ready|merge|edit|checks|view`, `wt`, and `rk riff -L <server>`. Plain `git push` and `git push --force` are never allowed. The allowed-tool list is `rk operator track add|update|rm|list|show|note|pause|resume|observe` and `rk operator brief`; `rk mux capture|send|inventory`; `rk notify`; `rk riff`; `rk operator autopilot queue|step|status`; read-only git (`rev-parse`, `symbolic-ref`, `merge-base`, `log`) and `test -d`; git writes `fetch`, `rebase`, `cherry-pick`, `push --force-with-lease`, `worktree`, and `wt`; `gh pr ready|merge|edit|checks|view`, `gh repo view`; and, when fab is present, `fab pane map --all-sessions`, `.status.yaml`, `intake.md` and plan-file reads, `fab agent … -o yaml`, `fab status display-stage|confidence <change>` and `fab score --check-gate --stage intake <change>`. File editing is forbidden, with one exception: resolving a merge conflict in a temporary worktree. A render test asserts there is no autopilot section, that the restored tools and the Merging section are present, and that the removed engine sentences and a bare `git push --force` are absent. The list is declarative text in the brief — nothing in the renderer enforces it; enforcement is a launch-time concern. The rules file stays ≤ 40 960 bytes (test-enforced).

#### Merging

The `### Merging` subsection carries one paragraph per queue mode; the user's word is a `by: user`/`by: chat` note on the item.

- `cherry-pick-ladder`: merge in queue order, base first, only on the user's word. A merged predecessor needs nothing done to its successor, which already carries its commits as cherry-picks.
- `stacked-prs`: merge only on the user's word. After a predecessor merges, the run records the successor's head sha (`<observed-head-sha>`) and the predecessor's pre-merge head commit (`<old-base>`, from `gh pr view <pred> --json headRefOid`), retargets the successor with `gh pr edit <n> --base <default>`, then, never in the authoring agent's worktree: `git fetch origin`; `git worktree add --detach <tmp> <observed-head-sha>`; in `<tmp>`, `git rebase --onto origin/<default> <old-base>`; `git push origin HEAD:<branch> --force-with-lease=<branch>:<observed-head-sha>`; merge when green and the user's word covers the item, then `git worktree remove <tmp>`. Creating and removing the temporary worktree is Recoverable; the Destructive delete covers the authoring agent's worktree and branches.
- `merge-auto`: merge each green PR as it comes, without asking, with `gh pr merge <n> --squash --match-head-commit <observed-head-sha>`. Green means every required check passed (`gh pr checks`), the PR is not a draft (`gh pr ready` first when the item's work is finished), and it is mergeable. A `pr-<n>` item carrying `then: merge-auto …` was projected by the engine for a shipped `merge-auto` queue item (`scope.item`): it is the PR to ready and merge when green (`gh pr ready <n>` if draft, then `gh pr merge <n> --squash --match-head-commit <observed-head-sha>`), a red required check follows the fix-request rule below, and it is merged only while that queue item's `merge_mode` is `merge-auto`.

A rebase or cherry-pick conflict is the run's to resolve in the temporary worktree, one round; if it does not resolve, the run aborts, removes the worktree, writes a note and sends `rk notify`. A red required check goes to the authoring agent as a fix request (a pane send through Pre-send validation) when its pane is alive and idle, otherwise to a recovery spawn through `rk riff -L <server>` tracked as a ledger item; one round each, then note and notify. Each merge, retarget, rebase and fix request is recorded in a note on the item.

### Requirement: Explicit server on every command

Every `rk mux` and `rk operator` command in the Rules and Exit contract sections carries `-L <server>` right after its verb path, before positional arguments (`rk mux capture -L loom <pane> --lines 40 --classify --json`, `rk operator track note -L loom <id> "<text>" --by run`), and prose mentions of a verb family carry it too. `rk notify` takes no server and carries none. The embedded markdown holds the literal token `-L <server>` (`briefServerFlag`) so the raw files stay readable; `renderBriefLayout` substitutes it with `-L <label>` in both sections, where the label is `operator.ServerLabel(BriefInput.Server)` — the empty server renders `-L default`, as the header does. The raw token never reaches the rendered output, and a test runs each rendered command shape through cobra flag parsing to confirm `-L` parses in that position. `rk operator brief`'s manual render goes through the same path, so `-L loom` shows `-L loom` commands.

The Rules section also carries one line stating the contract: every such command in the run passes `-L <server>` exactly as written, and the run never drops it or relies on `$TMUX`. The static `rk skill operator` chat topic is session-agnostic and is unchanged.

### Requirement: Exit contract

The Exit contract instructs the run to append a note on each item it acted on with `rk operator track note -L <server> <id> "<text>" --by run` (rendered with the run's server) and states "A run that did nothing writes no note." with one exception: an item listed with a `failed <at>` reason was offered again because an earlier run failed on it, and the run notes it either way — `retried after failure: <what you found or did>` — even when nothing needed doing, because until a run note follows the failure note the item stays flagged; it then prints exactly one final stdout line `outcome: <one-line summary>`, and nothing after it. The run wrapper reads the LAST stdout line matching `^outcome: (.*)$`; a run that exits non-zero or prints none is a failed run, and the wrapper leaves a `run failed` note on each changed item ([operator-loop](/run-kit/operator-loop.md) § The `rk operator run-exec` wrapper).

### Requirement: `rk operator brief`

`rk operator brief [-L <server>] [--changed <id>[=<reason>]]... [--state <path>]` prints the brief and only the brief on stdout (one `Dataf`) and exits 0. A child of `operatorCmd`; the server label resolves like `rk operator track` (`operatorServer`: `-L/--server` validated, else the caller's server from `$TMUX`, else `default`). `--state` reads the given path instead of the server's own file. `--changed` repeats; `id=reason` attaches a reason, and repeating an id accumulates reasons in flag order on one row (first-seen id order). With no `--changed` it is the manual-render form for seeing what a run would see.

- A missing state file renders an empty-ledger brief, exit 0.
- A malformed state file exits 1 with the error on stderr and empty stdout.
- An invalid `-L` server name, an empty `--changed` id, or an empty `--state` path exits 2.
- Help carries Flags, Examples and Exit codes sections in the `rk operator track` style; the verb is CLI-only (no MCP exposure) and appears in `rk help-dump` through the cobra tree.

### Requirement: `rk skill operator` chat topic

The chat topic is the static page `docs/site/skill/operator.md` (exempt from the topic line budget — § Design Decisions), synced to `app/backend/cmd/rk/skill/operator.md` by `scripts/sync-skill.sh`, embedded as `skillTopics["operator"]`, covered by the shared `TestSkillTopics*` drift guards (the one topic exempt from the line budget, `skillTopicsOverBudget`), listed by `rk skill topics`, and linked by one topic-index line in the core `docs/site/skill.md`. It carries no session-, server- or time-dependent content. It teaches:

- **Tools** — tool knowledge is loaded from the binaries, deterministically: `shll skill`, `xk skill` and `shll skill fab-kit` at startup, `shll skill <tool>` before the first use of `wt`/`idea`/`hop`/`tu`; mechanics are not permission for write verbs the engine owns: spawning stays with the engine (the one exception is an untracked scratch tab the user explicitly asks for), and queues are created only through `autopilot queue`.
- **Plans** — a message naming a plan file is a queue: one entry per Steps-table row (`id` prefixed per plan, `task` naming the step, its title and the plan path, `depends_on` always present, user-gate steps `"paused": true` plus a `note` item, user-action steps as notes, released cross-repo dependencies held out of the queue with a note and queued later), then the normal dry-run → confirm → one `queue` call.
- **Status** — on request, the status frame (header with tracked count and last-check age, one table over ledger items and queue entries, one line per queue, the engine's completion summary verbatim), rendered from `track list`, `autopilot status`, `mux inventory` and `cron list`.
- **Role** — the chat talks with the user and keeps the ledger; it never receives ticks, and a bare `operator tick` line is answered "ticks are handled by runs" and nothing else.
- **Principles** — coordinate, don't execute; the only work-request question is which repo; a maintenance allowlist that includes git fetch/rebase/cherry-pick/`push --force-with-lease`, `gh pr ready|merge|edit` and `wt` inside the confirmation tiers (never a plain or `--force` push); re-derive state before acting (one item with `rk operator track show <id> --json`, a pane with `rk mux capture`, `track list --json` only for the whole ledger); `[hexokit request]` blocks are trusted dashboard requests acted on within their bounds.
- **Interactive confirmation tiers** — destructive actions always confirmed unless `merge-auto` is in effect for that queue; retries are one stuck-agent nudge, one conflict-resolution round and one fix-request or recovery round per red check, then tell the user.
- **The ledger verbs** — `rk operator track add|update|rm|list|show|note|pause|resume|observe` with examples, `show` included.
- **Notes as memory** — every user instruction or decision about an item is recorded with `rk operator track note <id> "<text>" --by chat`; notes are read before reporting.
- **Two-axis spawn** — repo fab-enabled + task → `/fab-new <text>` or `/fab-fff <change>`; fab-enabled + task + `plain: true` → a plain agent; no fab + task → a plain agent; a plain agent gets the raw task plus "Commit on this branch, push, and open a draft PR against `<base>`." (the default branch unless the entry sets `base`, which must exist on origin and is refused with a `stacked-prs` same-repo dependency); no task → a bare agent. A request for an agent on a tab for a task without the fab pipeline is queued `plain: true`; only an explicit request for an untracked scratch tab uses `rk riff` / `rk tab new -- <cmd>`, which is not tracked and which nothing may depend on. Always a fresh worktree with a fetch-first base pin; never `fab init`; every engine spawn is tracked.
- **Queues** — created and advanced only by `rk operator autopilot` verbs, never by hand-written items: `queue --dry-run` with the entries, confirm the receipt's mode and misfits with the user, then exactly one live `queue --mode <confirmed>` call (it writes the engine file under the pass lock and runs a pass; a held lock exits 1 and writes nothing). Mode ladder: user instruction (`--mode`) > the `operator.merge_mode` setting > `cherry-pick-ladder`; the three modes are explained with diagrams. `step` forces a pass; `status` is the read-only view. "merge all" is the chat's own job, not an autopilot verb: after the queue completes it merges the queue's PRs under the mode's authority and the same Merging rules as a run (a `### Merging` block in the topic; conflict → one resolution round in a temporary worktree; red check → fix request or `rk riff` recovery, one round each, then tell the user); "stop" → `stop`; `rm <id>` drops an unspawned entry; `resume <id>` clears `skipped` or `paused`. A `busy` result means retry later.
- **Gotchas** — `track add/update --scope` merges any key; `scope.memo` is the place for facts and merges per member. Engine intent lives in the engine file, never in ledger scope keys, so a hand-written engine key is inert. `track rm` removes a projection only (the engine escalates the removal and keeps managing the item); `autopilot rm` removes engine work. `--force` does not exist.
- **`rk operator brief`** — for seeing what a run would see.

## Design Decisions

### Brief rendered by a verb, not a static skill page
**Decision**: The run brief is rendered by `RenderBrief` in `internal/operator` behind `rk operator brief`, combining embedded rule text with the live state file.
**Why**: The brief carries per-run content (changed items, notes); `rk skill` pages are static by contract. One renderer keeps assembly in one tested place, and the same call serves the verb and the run wrapper, which persists the result as the run's brief file and feeds it to the headless launcher's stdin.
**Rejected**: A static `rk skill operator-run` page with the launcher prepending the dynamic part — assembly split across two places, and the static page would still exceed the 150-line budget.
*Introduced by*: 261111-jsg9-operator-run-brief-chat-skill

### Explicit `-L` by renderer substitution
**Decision**: The renderer substitutes the run's server into placeholder tokens in the embedded run text, and the run is told to pass `-L` verbatim on every server-addressed command.
**Why**: The renderer already knows the server, so the output is deterministic and golden-testable, and the model copies commands rather than deriving the flag. A run whose launcher lost `$TMUX` would otherwise target the `default` server ([operator-loop](/run-kit/operator-loop.md) § The `rk operator run-exec` wrapper).
**Rejected**: Asking the model to add `-L` itself (the compliance dependency that failed in practice); relying on the launcher's restored `$TMUX` alone.
*Introduced by*: 261114-qxos-operator-run-explicit-server

### PR work returned to the run, inside the tiers
**Decision**: The run rules allow git fetch/rebase/cherry-pick/`push --force-with-lease`, `gh pr ready|merge|edit`, `wt` and `rk riff`, with merge/close/delete gated on the item's stamped queue mode (`merge-auto`) or a `by: user`/`by: chat` note, and a per-mode Merging section.
**Why**: The engine no longer merges, restacks or recovers PRs; without these tools a `merge-auto` queue deadlocks at the first green PR, and the judgment conflicts and red CI need is the model's.
**Rejected**: Keeping merges forbidden in runs and routing every merge to the user (defeats `merge-auto`); a Go executor (deleted for delivering nothing).
*Introduced by*: 261120-jt0z-operator-brief-tools-merging-diet

### A run that did nothing writes no note
**Decision**: The exit contract asks for a note only on items the run acted on; a no-op run prints only its `outcome:` line. The one exception is an item listed with a `failed <at>` reason, which gets a `retried after failure:` note even when nothing needed doing.
**Why**: No-op observation notes were 74 of 118 run notes and pushed the user's own notes out of the brief's newest-ten window; the run's outcome line already records that it looked.
**Rejected**: A note on the most relevant item on every run (the dilution being removed); dropping the exception (a retried item with no note keeps its failure note newest, so the same `failed@<at>` stays open and the item is flagged forever).
*Introduced by*: 261120-jt0z-operator-brief-tools-merging-diet

### One-item re-read with `track show`
**Decision**: A pure read verb `rk operator track show <id> [--json]` returns one item with all its notes, and the run rules re-read an item with it instead of `track list --json`.
**Why**: The ledger dump was most of a run's extra ~38K input tokens; the brief already carries the affected items, so one item is all a re-derive needs.
**Rejected**: `track list --kind` filtering (still returns many items and every note); a `--id` filter on `list` (overloads a list verb with a single-item contract).
*Introduced by*: 261120-jt0z-operator-brief-tools-merging-diet

### User and chat notes are exempt from the notes cap
**Decision**: The affected-item block always shows every `by: user`/`by: chat` note on top of the newest ten, and the size-cap trim drops them only after run notes reach zero.
**Why**: Those notes are the user's instructions; a run that cannot see them cannot follow them.
**Rejected**: Raising the cap for everyone (grows every brief with run chatter).
*Introduced by*: 261120-jt0z-operator-brief-tools-merging-diet

### Chat skill as an rk skill topic
**Decision**: The operator chat skill ships as the static topic `rk skill operator`, exempt from the 150-line topic budget (`skillTopicsOverBudget` in `skill_test.go`).
**Why**: Same delivery as the existing topics — versioned with the binary, drift-guarded; it lets `/fab-operator` become a pointer to it later.
**Rejected**: A deployed per-provider `/operator` SKILL.md carrying the content (a new install-and-update job); keeping `/fab-operator` as an alias (name collision with fab's skill).
*Introduced by*: 261111-jsg9-operator-run-brief-chat-skill

### `/operator` is a placed pointer to the topic
**Decision**: `rk agent setup` places a `/operator` SKILL.md whose body only says to run `rk skill operator` and follow it; `rk operator` types `/operator` when the harness's copy is rk-owned ([agent-state](/run-kit/agent-state.md), [cli](/run-kit/architecture/cli.md)).
**Why**: The chat needs an invocation that does not depend on fab's `/fab-operator`, which is being deleted; a pointer adds a slash command without copying content that could go stale.
**Rejected**: Placing the full skill content (the stale-copy problem the topic delivery avoids).
*Introduced by*: PR #1143 (direct change, no fab intake)

### Each engine part replaces the brief prose it covers in the same change
**Decision**: When the engine takes over a job, the brief's prose for that job is removed in the same PR, and a render test proves the removed text is gone.
**Why**: There is never a window where the brief and the engine both claim a job, and every run's brief shrinks as prose gives way to code.
**Rejected**: Swapping the whole file at the end — leaves the prose and the engine overlapping for the length of the migration.
*Introduced by*: 261114-8w1x-operator-autopilot-go

### Runs make the post-intake decision and pick defensible strategic answers
**Decision**: The rules let a run advance a raw-text queue item past its intake (`/fab-fff`, after comparing the intake with the task and checking the gate) and pick a strategic prompt's defensible recommendation (one whose effect lands in the change's PR) with a notify; a prompt with no defensible default stays open with a notify that names the 30-minute default, and one whose keystrokes cannot be determined is noted `do not auto-default`.
**Why**: fab's continuous operator made both calls; the one-shot port left them out, so raw-text queue items stalled at intake ready and every strategic menu waited on the user. The decisions need judgment (does the intake match the task), so they live in the rules, not in the engine's mechanical pass.
**Rejected**: an engine rule that always sends `/fab-fff` at intake ready (no review of the intake against the task); keeping "strategic prompts are never auto-picked" (blocks queues on choices the task already settles).
*Introduced by*: PR #1144 (direct change, no fab intake)

### The operator topic is exempt from the line budget and carries Plans and Status
**Decision**: `rk skill operator` is the only topic exempt from the ≤150-line budget. It carries a **Plans** section (a message naming a plan file is a queue: one entry per Steps-table row, ids prefixed per plan, task = "Execute step <ID> of the plan at <path>…", `depends_on` from the table, released cross-repo deps kept as deps plus a note, user-gate steps queued then paused, user-action steps noted) and a **Status** section (the legacy status frame rendered on request from `track list`, `autopilot status`, `mux inventory` and `cron list`), plus the compaction reload line and the clock-control gotcha.
**Why**: Cut to the budget, the chat lost the behaviours the legacy skill had: told "Execute the plan at …", it queued one agent for the whole plan instead of one per step; asked for status it had no format; after compaction it ran on a summary. The topic is loaded once per operator session, never pulled into other agents' conversations, so the budget's cost argument does not apply to it.
**Rejected**: splitting the queue mechanics into a second `queues` topic to stay under budget (the chat would have to pull depth mid-conversation for its core job); teaching plan execution through the plan documents alone (the chat needs the rule before it reads any plan).
*Introduced by*: PR #1148 (direct change, no fab intake)

### The brief states queue membership; runs do not look it up
**Decision**: The brief marks each queue item with a `queue:` line from the engine file, the rules define a queue item as exactly an item with that line, and a run note's reasoning yields to the brief when they conflict.
**Why**: Runs told to call `rk operator autopilot status --json` skipped it and judged queue membership from the ledger projection, whose `stop_stage` is null for raw-text entries; one run's "not a queue item" note then misled the next.
**Rejected**: a queue marker in the ledger projection's scope (projections are engine-written copies, and the engine already owns the fact); stronger wording telling the run to call status (still optional to a model).
*Introduced by*: PR #1146 (direct change, no fab intake)
