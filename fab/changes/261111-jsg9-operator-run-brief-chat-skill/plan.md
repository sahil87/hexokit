# Plan: Operator Run Brief and Chat Skill

**Change**: 261111-jsg9-operator-run-brief-chat-skill
**Intake**: `intake.md`

## Requirements

### Operator: Run Brief Renderer

#### R1: Brief renderer library
`internal/operator` SHALL expose a pure renderer (no subprocesses, no writes) that turns a
loaded `*State`, a server label, a render time and a list of changed items into the run brief
as Markdown. The input type for changed items SHALL be a small adapter type
(`ChangedItem{ID string; Reasons []string}`), independent of R2's check output.

- **GIVEN** a state with items `a` (github-pr) and `b` (pane, `depends_on: [a]`)
- **WHEN** the brief is rendered with `Changed: [{ID: "a", Reasons: ["state: OPEN → MERGED"]}]`
- **THEN** the output contains a What-changed row for `a` with its reason
- **AND** the state file on disk is unchanged

#### R2: Brief layout and order
The brief SHALL contain, in this order: a header (server, render time, the one-shot role line
"You are a one-shot operator run. Act on what changed, write a note, exit."), a **What changed**
section, an **Affected items** section, an **Other tracked items** section, the **Rules**
section, the **Interim autopilot** section, and the **Exit contract** section.

- **GIVEN** any state and changed list
- **WHEN** the brief is rendered
- **THEN** the seven section headings appear exactly once each, in the order above

#### R3: What-changed rows
Each changed item SHALL render as one row: id · kind · reasons (joined). A changed id absent
from the state SHALL render as `gone` without error. An empty changed list SHALL render the
line `nothing flagged — manual render`.

- **GIVEN** `Changed: [{ID: "zzz"}]` and no item `zzz`
- **WHEN** rendered
- **THEN** the What-changed section shows `zzz` as `gone` and rendering succeeds

#### R4: Affected items detail
The affected set SHALL be every changed item plus its direct dependency neighbours in both
directions (items it `depends_on`, and items whose `depends_on` names it), each rendered once,
in state-file order. Each block SHALL show: id, kind, lifecycle state (the same derivation
`rk operator track list` uses: done/paused/held/pending/stale/live/watching), probe mode,
`check_every`, `done_when`, `then`, `depends_on`, the non-null `scope` keys (sorted), `last`
(sorted keys), and the item's notes (newest last, each with `at` and `by`).

- **GIVEN** `b depends_on a`, and only `a` changed
- **WHEN** rendered
- **THEN** both `a` and `b` appear in Affected items with full blocks
- **AND** `b`'s state reads `held` while `a` is not done

#### R5: Other items one-liners
Every tracked item not in the affected set SHALL render as one line `id · kind · state`.

- **GIVEN** an item `c` unrelated to the changed set
- **WHEN** rendered
- **THEN** `c` appears once, as a single line, under Other tracked items

#### R6: Notes cap per item
Each affected item SHALL show at most its last 10 notes; when older notes exist, a line
`(+N earlier notes)` SHALL precede the shown notes.

- **GIVEN** an affected item with 14 notes
- **WHEN** rendered
- **THEN** exactly the newest 10 notes are shown, preceded by `(+4 earlier notes)`

#### R7: Hard size cap and trim order
The rendered brief SHALL NOT exceed a hard cap of 100 KB (bytes). When over the cap, the
renderer SHALL trim in order: (1) drop Other-tracked-items lines, (2) reduce shown notes per
affected item (oldest first, down to zero), and SHALL append a truncation marker line. The
header, What-changed section, Rules, Interim autopilot and Exit contract SHALL never be dropped.

- **GIVEN** a state whose full brief would exceed 100 KB because of notes and many items
- **WHEN** rendered
- **THEN** the output is ≤ 100 KB, contains the Rules and What-changed sections, and ends with
  the truncation marker

#### R8: Deterministic output
For identical input (including `Now`), the brief SHALL be byte-identical across runs: items
in state-file order, map keys sorted.

- **GIVEN** the same state, server, time and changed list
- **WHEN** rendered twice
- **THEN** both outputs are byte-identical (golden test)

### Operator: Run Rules and Interim Autopilot Text

#### R9: Embedded run rules
The Rules section SHALL be embedded from a Markdown file in `internal/operator/` via
`//go:embed`, rewritten (not copied) from fab-operator.md §1/§3/§5 for an unattended one-shot
run. It MUST cover: role (coordinate, don't execute; no code reading/diagnosis, no file edits;
act only on changed items and what they unblock); confirmation tiers for runs (read-only free;
recoverable proceeds and is noted; destructive — merge/close PR, delete branch/worktree,
archive — never, except the merge under `scope.merge_mode == merge-auto`; otherwise note +
`rk notify` + stop on that item); pre-send validation (pane exists, agent state fits; never send
to `active`, never `--force`); the answer model for routine prompts only
(`rk mux capture <pane> --lines 40 --classify --json`; yes/no, `[Y/n]`, permission → `y`;
routine menus → first/default; re-capture before send, abort if changed;
`rk mux send … --answer` / `--key`); strategic prompts left open + notify + note; the 30-minute
idle auto-default conditions; one stuck nudge per agent then escalate; bounded retries;
`rk notify` fail-silent behind `command -v rk`; notes as memory (read notes first; follow
`by: user` / `by: chat` instructions); the allowed-tool list; agent probes for due
`linear`/`slack` items via `probe.instruction` + `rk operator track observe`.

- **GIVEN** the embedded rules file
- **WHEN** the brief is rendered
- **THEN** the Rules section contains the never-merge/close/delete-unless-`merge-auto` rule,
  the routine-only answer model, and the allowed-tool list

#### R10: Interim autopilot text, isolated
The Interim autopilot section SHALL come from a **separate** embedded Markdown file whose first
line marks it interim ("Interim — replaced by the R6 autopilot engine; R7 deletes this file."),
included through exactly one reference in the renderer so R7 removes it with one file and one
include. It SHALL condense fab-operator.md §6 Queues + Dependency Resolution (+ ordered merge,
merge-auto choreography, PR recovery as needed) using `rk operator track …` verbs only (no
`fab operator track`): held/ready queue items, fetch-first `--base <SHA>` spawn via
`wt create --non-interactive`, the three merge modes' dependency code, the done definition,
ordered merge, PR recovery with `scope.recovery` written before acting, and mode = stored
`scope.merge_mode` (null ⇒ `cherry-pick-ladder`).

- **GIVEN** the rendered brief
- **WHEN** searched for `fab operator track`
- **THEN** there are no matches, and the Interim autopilot section begins with the interim line

#### R11: Rules + autopilot size budget
The combined embedded rules and interim autopilot text SHOULD be ≤ 40 KB.

- **GIVEN** the two embedded files
- **WHEN** their byte lengths are summed in a test
- **THEN** the sum is ≤ 40 960 bytes

#### R12: Exit contract
The Exit contract section SHALL instruct the run to append at least one note per item it acted
on (or one note on the most relevant item when nothing needed doing) with
`rk operator track note <id> "<text>" --by run`, then print exactly one final stdout line
`outcome: <one-line summary>`.

- **GIVEN** the rendered brief
- **WHEN** reading the Exit contract
- **THEN** it names `--by run` and the `outcome:` line format

### CLI: `rk operator brief`

#### R13: Verb surface
`rk operator brief [-L <server>] [--changed <id>[=<reason>]]... [--state <path>]` SHALL print
the brief to stdout (nothing else on stdout) and exit 0. Server/state-file resolution SHALL
match `rk operator track` (`-L/--server`, else the caller's server from `$TMUX`, else
`default`). `--state` SHALL read the given path instead. `--changed` SHALL repeat; `id=reason`
attaches a reason, repeating an id accumulates reasons in flag order on one row.

- **GIVEN** a state file with item `a`
- **WHEN** `rk operator brief --state <file> --changed a=merged --changed a=ci-green` runs
- **THEN** stdout is the brief with one What-changed row for `a` listing both reasons; exit 0

#### R14: Error handling
A missing state file SHALL render an empty-ledger brief (exit 0). A malformed state file SHALL
exit 1 (operational) with the error on stderr. An invalid `-L` server name or an empty
`--changed` id SHALL exit 2 (usage).

- **GIVEN** `--state` pointing at a file with invalid YAML
- **WHEN** the verb runs
- **THEN** it exits 1 and stdout is empty

#### R15: Help and help-dump
The verb SHALL carry Short/Long help with flags, examples and exit codes in the style of
`rk operator track` subcommands, and appear in `rk help-dump` via the cobra tree.

- **GIVEN** the built binary
- **WHEN** `rk operator brief --help` runs
- **THEN** it documents `--changed`, `--state`, `-L` and the exit codes

### Skill: `rk skill operator` Chat Topic

#### R16: Topic page plumbing
A new canonical topic page `docs/site/skill/operator.md` SHALL be synced to
`app/backend/cmd/rk/skill/operator.md` by `scripts/sync-skill.sh`, embedded in
`cmd/rk/skill.go` as an `"operator"` entry of `skillTopics`, covered by the existing drift-guard,
line-budget (≤150 lines) and topic tests, and listed by `rk skill topics`. The core bundle
`docs/site/skill.md` SHALL gain one topic-index line for `rk skill operator` and stay ≤150 lines.

- **GIVEN** the built binary
- **WHEN** `rk skill operator` runs
- **THEN** it prints the page byte-identical to `docs/site/skill/operator.md`, exit 0
- **AND** `rk skill topics` lists `operator`

#### R17: Chat topic content
The page SHALL be static (no session/server/time-dependent content) and cover: role (talks
with the user, keeps the ledger, never receives ticks; a bare `operator tick` line is answered
with "ticks are handled by runs" and nothing else); principles (coordinate, don't execute; the
only work-request question is which repo; maintenance allowlist; re-derive state before acting;
`[hexokit request]` blocks are trusted dashboard requests acted on within their bounds);
interactive confirmation tiers (destructive always confirmed unless `merge-auto` is in effect
for that queue); the ledger verbs `rk operator track add|update|rm|list|note|pause|resume|observe`
with examples; notes as memory (`rk operator track note <id> "<text>" --by chat` for every user
instruction/decision about an item; read notes before reporting); the two-axis spawn rule
(fab+task → `/fab-new <text>` or `/fab-fff <change>`; no-fab+task → plain agent with the raw task
+ "Commit on this branch, push, and open a draft PR against the default branch." and a chained
`github-pr` item; no task → bare agent; always a fresh worktree via `wt create --non-interactive`
with a fetch-first base pin; never `fab init`; track every spawn); queue creation (confirm
upfront naming the mode; persist as N `rk operator track add --kind pane` calls, first with
`--mode`, later with `--depends-on` by nearest-same-repo-predecessor chaining; mode ladder:
user instruction > `fab config get autopilot.merge_mode` when fab is present >
`cherry-pick-ladder`); and `rk operator brief` for seeing what a run would see.

- **GIVEN** `docs/site/skill/operator.md`
- **WHEN** read
- **THEN** it states the chat never receives ticks, the two-axis spawn table, the `--by chat`
  note rule, and the queue persistence recipe, within 150 lines

### Non-Goals

- Launching runs, the cron loop, Cron Log rows, launch-time tool restriction — R5
- Producing changed items (the check/diff) — R2
- The Go autopilot engine (R6) and deleting the interim text (R7)
- Changing the `rk operator` kickoff (`/fab-operator`), fab's skill, or the cron entry — R5/F1/C1
- MCP exposure of `operator brief`
- Any action against the live rk daemon, tmux servers, or installed binaries

### Design Decisions

#### Brief rendered by a verb, not a static skill page
**Decision**: The run brief is rendered by `RenderBrief` in `internal/operator` behind
`rk operator brief`, combining embedded rule text with the live state file.
**Why**: The brief carries per-run content (changed items, notes); `rk skill` pages are
static by contract. One renderer keeps assembly in one tested place; R5 pipes stdout to the
headless command's stdin.
**Rejected**: A static `rk skill operator-run` page with R5 prepending the dynamic part —
assembly split across two places, and the static page would still exceed the 150-line budget.
*Introduced by*: 261111-jsg9-operator-run-brief-chat-skill

#### Interim autopilot text in its own embedded file
**Decision**: The condensed §6 autopilot text lives in a separate embedded file with one
include site.
**Why**: R7 deletes it once R6 lands; isolation makes that a one-file, one-line removal.
**Rejected**: Inlining it in the rules file — R7 would have to edit prose surgically.
*Introduced by*: 261111-jsg9-operator-run-brief-chat-skill

#### Chat skill as an rk skill topic
**Decision**: The operator chat skill ships as the static topic `rk skill operator` (≤150 lines).
**Why**: Same delivery as the existing topics — versioned with the binary, drift-guarded; F1
turns `/fab-operator` into a pointer to it.
**Rejected**: A deployed per-provider `/operator` SKILL.md (new install-and-update job); keeping
`/fab-operator` as an alias (name collision with fab's skill).
*Introduced by*: 261111-jsg9-operator-run-brief-chat-skill

## Tasks

### Phase 1: Setup

- [x] T001 Read the source material: `~/code/sahil87/fab-kit/src/kit/skills/fab-operator.md` §1 Principles, §3 Safety, §5 Auto-Nudge, §6 Coordination Patterns (incl. Queues, Dependency Resolution, Ordered Merge, Auto-Merge Choreography, PR Recovery), and the R1 package `app/backend/internal/operator/` (schema.go, store.go, track.go) plus `app/backend/cmd/rk/operator_track.go` and `app/backend/cmd/rk/skill.go` / `skill_test.go` for patterns <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 Write the run rules text `app/backend/internal/operator/brief_rules.md` (rewritten for unattended one-shot runs per R9; includes the allowed-tool list) <!-- R9 -->
- [x] T003 Write the interim autopilot text `app/backend/internal/operator/brief_autopilot.md` (first line is the interim marker; `rk operator track` verbs only) per R10; keep rules + autopilot ≤ 40 KB combined <!-- R10 -->
- [x] T004 Implement `app/backend/internal/operator/brief.go`: `ChangedItem`, `BriefInput`, `RenderBrief`, the embeds of T002/T003 (autopilot via exactly one embed var + one include), the seven sections in order, affected-set derivation (changed + direct deps both directions), lifecycle state via the existing `listState`, sorted scope/last keys, notes cap 10 with `(+N earlier notes)`, the Exit contract text, the 100 KB hard cap with trim order and truncation marker; named constants for caps <!-- R1 -->
- [x] T005 Add `app/backend/internal/operator/brief_test.go`: section order, gone ids, empty-changed line, affected neighbours both directions with held state, other-items one-liners, notes cap, size cap + trim order (rules/what-changed kept, marker present), no `fab operator track` in output, interim marker first line, rules+autopilot ≤ 40 960 bytes, Exit contract names `--by run` and `outcome:`, determinism via a golden file under `app/backend/internal/operator/testdata/` <!-- R8 -->
- [x] T006 Implement `app/backend/cmd/rk/operator_brief.go`: `rk operator brief` with `-L/--server`, repeatable `--changed id[=reason]`, `--state <path>`; reuse `operatorStateTarget` resolution; load via `operator.Load`; error mapping (malformed → 1, bad `-L`/empty id → 2); Short/Long help with flags, examples, exit codes; register under `operatorCmd` <!-- R13 -->
- [x] T007 Add `app/backend/cmd/rk/operator_brief_test.go`: render from `--state` fixture, reasons accumulate per id, missing file → empty-ledger brief exit 0, malformed file → exit 1 with empty stdout, empty `--changed` id → usage error, help text mentions the flags <!-- R14 -->

### Phase 3: Integration & Edge Cases

- [x] T008 Write the chat topic page `docs/site/skill/operator.md` (≤150 lines, static) per R17 <!-- R17 -->
- [x] T009 Wire the topic: add a sync row in `scripts/sync-skill.sh`, run it to produce `app/backend/cmd/rk/skill/operator.md`, add the `skillOperatorTopic` embed + `"operator"` map row in `app/backend/cmd/rk/skill.go`, add rows to every case table in `app/backend/cmd/rk/skill_test.go`, and add one topic-index line to `docs/site/skill.md` (re-sync the core copy); core stays ≤150 lines <!-- R16 -->
- [x] T010 Check the new CLI surface against the shll standards (help-dump, skill) per the constitution's Toolkit Standards rule; confirm `rk help-dump` includes `operator brief` (fix any test that enumerates the command tree) <!-- R15 -->

### Phase 4: Polish

- [x] T011 Run `just test-backend` (never `go test` directly, never against the live daemon or installed binaries) and fix failures; run `gofmt` on touched Go files <!-- R8 -->

## Execution Order

- T002 and T003 block T004 (embeds must exist to compile)
- T004 blocks T005, T006; T006 blocks T007
- T008 blocks T009

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `RenderBrief` exists in `internal/operator`, takes `ChangedItem`s, performs no subprocess calls and no writes
- [ ] A-002 R2: The brief's seven sections appear once each in the specified order
- [ ] A-003 R9: The Rules text covers role, run confirmation tiers (destructive only under `merge-auto`), pre-send validation, routine-only answer model, strategic-left-open, idle auto-default, stuck nudge, bounded retries, fail-silent notify, notes as memory, allowed tools, agent probes
- [ ] A-004 R10: The interim autopilot text is a separate embedded file with the interim marker as its first line and a single include site
- [ ] A-005 R12: The Exit contract names `rk operator track note <id> "<text>" --by run` and the final `outcome: <one-line summary>` line
- [ ] A-006 R13: `rk operator brief` prints the brief to stdout with `-L`, `--changed id[=reason]` (repeatable, reasons accumulate) and `--state`
- [ ] A-007 R16: `rk skill operator` prints the topic byte-identical to `docs/site/skill/operator.md`; `rk skill topics` lists `operator`; the core bundle has the index line
- [ ] A-008 R17: The topic page covers role/never-ticks, principles, tiers, ledger verbs, `--by chat` notes, two-axis spawn, queue creation with the mode ladder, and `rk operator brief`
- [ ] A-009 R15: `rk operator brief --help` documents flags, examples and exit codes; `rk help-dump` includes the verb

### Behavioral Correctness

- [ ] A-010 R4: Affected items include the changed items and their direct dependency neighbours in both directions, each once, with lifecycle state matching `rk operator track list`
- [ ] A-011 R8: Rendering the same input twice is byte-identical (golden test passes)

### Scenario Coverage

- [ ] A-012 R3: Tests cover a `gone` changed id and the empty-changed `nothing flagged — manual render` line
- [ ] A-013 R5: Tests cover other items rendered as single `id · kind · state` lines
- [ ] A-014 R6: Tests cover the 10-note cap with the `(+N earlier notes)` line

### Edge Cases & Error Handling

- [ ] A-015 R7: An oversized state renders ≤ 100 KB, keeps header/What-changed/Rules/Interim autopilot/Exit contract, trims other-items first then notes, and ends with the truncation marker
- [ ] A-016 R14: Missing state file → empty-ledger brief, exit 0; malformed → exit 1 with empty stdout; invalid `-L` or empty `--changed` id → exit 2
- [ ] A-017 R11: Rules + autopilot embedded text totals ≤ 40 960 bytes (test-enforced)
- [ ] A-018 R10: The rendered brief contains no `fab operator track` string

### Code Quality

- [ ] A-019 Pattern consistency: New Go follows `internal/operator` and `cmd/rk/operator_track.go` patterns (thin CLI over library, `usageError` mapping, `newSink` output, help style)
- [ ] A-020 No unnecessary duplication: State derivation reuses `listState`/`heldDep`/`itemDone`; server resolution reuses `operatorStateTarget`; skill embedding follows the existing topic pattern
- [ ] A-021 Readability: No god functions (>50 lines without reason); caps are named constants, no magic numbers
- [ ] A-022 Comments: Comments state constraints/why only — no narration, no change IDs or PR numbers
- [ ] A-023 Tests: New behavior is covered by `*_test.go`; tests pass under `just test-backend`
- [ ] A-024 Process safety: The renderer spawns no subprocesses; nothing touches the live rk daemon, live tmux servers, or installed binaries

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Hard cap is 100 KB (bytes) and the notes cap is 10 per affected item | Intake Tentative #11 values; S1's 128 KiB argv ceiling leaves margin; tunable constants | S:60 R:90 A:65 D:60 |
| 2 | Confident | Trim order: other-items lines first, then notes oldest-first per item; header/what-changed/rules/autopilot/exit never dropped | Intake What Changes §1 size budget; rules are the run's only knowledge | S:70 R:90 A:75 D:70 |
| 3 | Confident | Lifecycle state in the brief reuses `listState` so it matches `rk operator track list` | One derivation, no drift between list and brief | S:75 R:90 A:85 D:80 |
| 4 | Confident | Embedded file names `brief_rules.md` / `brief_autopilot.md` inside `internal/operator/` | `//go:embed` cannot reach above the module root; package-local files keep R7's deletion local | S:65 R:95 A:80 D:70 |
| 5 | Confident | Repeating `--changed` for one id accumulates reasons on one row in flag order | Intake "repeat the id for multiple reasons" | S:75 R:95 A:80 D:80 |
| 6 | Tentative | Empty `--changed` id (e.g. `--changed =x`) is a usage error; an id without `=` has no reasons | Natural reading of the `id[=reason]` grammar | S:50 R:95 A:65 D:55 |
| 7 | Confident | Rules + autopilot budget enforced in a test at 40 960 bytes | Intake ≤ ~40 KB target, made checkable | S:65 R:90 A:75 D:70 |

7 assumptions (0 certain, 6 confident, 1 tentative).
