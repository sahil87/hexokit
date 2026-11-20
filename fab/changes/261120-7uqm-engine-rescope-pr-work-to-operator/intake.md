# Intake: Engine re-scope — PR work returns to the operator

**Change**: 261120-7uqm-engine-rescope-pr-work-to-operator
**Created**: 2026-11-20

## Origin

> Execute step T3 (Engine re-scope: delete PR rows, executors, `prs`/`fixes`, `merge`, Q6a/Q6b/Q7; modes become spawn shape + AI authority; judgment set updated) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first (Decisions and Rules bind you), then implement only the T3 Brief.

One-shot `/fab-new` invocation. The plan (`fab/plans/sahil/26-11-20-operator-triggers.md`, same content in this worktree) is the binding source. Its **Decisions** table and **Rules for the operator executing this plan** are not reopened here. This change is stacked on `261120-9ypa-operator-check-idle-floor-stage-seed` (step T1, which T3 depends on). The base branch is set to that branch.

Binding plan decisions that shape this step (quoted or closely paraphrased):

- **PR work**: "Back to the AI. Rows P1–P7, B1–B2, C1–C6, F1 and their executors are deleted; the engine file loses `prs` and `fixes`; the `merge` verb and Q7 (`track-pr`) go with them." The reason is zero successful arms, escalations the model had to re-explain, and the widest outcome space (conflicts, red CI), which is where judgment pays.
- **Queue work**: "Stays in Go: X0–X1, Q1–Q5 (readiness, fetch-first SHA-pinned spawn with the three modes' chaining, one respawn, completion). Q6a/Q6b go."
- **Merge modes**: "Kept as stamps on queue items. They still shape **spawn** (ladder cherry-pick, stacked base + `set-base-branch`, merge-auto no chaining) and now tell the **AI** its merge authority: `merge-auto` = merge green PRs without asking; the other two = merge only on the user's word." The merge-authority half lands in the brief and the chat skill in T4.
- **Rule 7**: "Deleting code is the point of T3. Do not keep PR executors 'for later' behind a flag; the reference is git history."
- **Rule 4 (review bar)**: must-fix means the change merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; or breaks a plan requirement. Everything else is should-fix.
- **Rule 5**: "Each step updates the memory files it touches and, where it changes a CLI surface, the help text, the `rk skill operator` topic and `rk help-dump` fixtures in the same change."
- **Rule 6**: no UI change, so the PR states `No recording: internal CLI/engine behavior` and describes the validation.

## Why

1. **The PR half of the autopilot never delivered.** `gh repo view --json autoMergeAllowed` is not a field on gh 2.103, so P6 never armed a PR. gh timeouts escalated, and every escalation became a model run whose only possible action was "transient, notified user". The rows that act (ready, arm, merge, restack, ci-fix, rebase, halt, disarm, fix items) have the widest outcome space: conflicts, red CI, stacked retargets. That is where a model's judgment pays and where a fixed table keeps escalating.
2. **Q6a/Q6b escalate noise.** Q6a fired "stage (unknown) over 30m" on agents running normally because the stage channel was dead (T1 fixes the seeding). Each escalation is a paid model run. With T1 and the 30-min `aged` conditions in `operator.Check`, the check already covers "stuck". Q6b's "queue open for over 2h" has no action behind it.
3. **Size.** `internal/autopilot` is about 4,800 lines of code plus about 9,000 lines of tests. Roughly half is PR choreography (`merge.go`, `restack.go`, `recovery.go`, PR observe, PR executors). Removing it leaves a small, deterministic engine: readiness, SHA-pinned spawn, one respawn, completion. That is the part with one right answer, and it is what makes "item done → next starts" free.
4. **If we don't:** T4 cannot hand merge authority to the AI without two writers fighting over the same PRs (engine arming or merging while a run also merges). The R1 release would also keep shipping the escalation noise this plan exists to remove.

Alternatives rejected (by the plan): keeping executors behind a flag (Rule 7), and fixing `autoMergeAllowed` in place (it would keep the widest outcome space in a fixed table).

## What Changes

All paths below are relative to `app/backend/` unless they start with `docs/`.

### 1. Rule table (`internal/autopilot/rules.go`)

Delete these rows: `P1`, `P2`, `P3`, `B1`, `B2`, `P4`, `C1`–`C6`, `P6`, `P7`, `F1`, `F2`, `Q6a`, `Q6b`, `Q7`, plus the `kindPR` variants of `X0` and `X1`. F2 is not named in the plan, but it only exists for fix items, and the `fixes` list is deleted.

The table after deletion is exactly:

```go
var ruleTable = []rule{
	{id: "X0", kind: kindQueue, all: true, guard: removedProjectionGuard, action: ActionEscalate, text: projectionRemovedText},
	{id: "X1", kind: kindQueue, all: true, guard: needsProjection, action: ActionReProject},
	{id: "Q1", kind: kindQueue, queue: QueueDone, guard: doneAtUnset, action: ActionRecordDone},
	{id: "Q2", kind: kindQueue, queue: QueuePending, action: ActionSpawn},
	{id: "Q3", kind: kindQueue, queue: QueueSpawnUnknown, action: ActionEscalate, text: spawnInterruptedText, guard: /* not yet escalated */},
	{id: "Q4", kind: kindQueue, queue: QueueDead, guard: /* respawn unspent */, action: ActionRespawn},
	{id: "Q5", kind: kindQueue, queue: QueueDead, guard: /* respawn spent */, action: ActionSkip},
}
```

- `ActionKind` keeps only `ActionWait`, `ActionRecordDone`, `ActionSpawn`, `ActionRespawn`, `ActionSkip`, `ActionEscalate` and `ActionReProject`. Delete `ActionTrackPR`, `ActionRecordMerged`, `ActionHalt`, `ActionDisarm`, `ActionReady`, `ActionArm`, `ActionMerge`, `ActionRestack`, `ActionFixRequest`, `ActionRecoverySpawn`, `ActionRebase` and `ActionUntrack`.
- `itemKind` keeps only `kindQueue`. `kindPR`/`kindFix`, the `pr`/`fix` fields on `rule`/`wait`/`Decision`, and the matching branches in `matches`, `decide`, `decideItem` and `waitDeclared` go. `decide` keeps walking only queue items (`legacyQueueItem`).
- Delete the guards and texts that only served deleted rows: `slowStage`, `slowQueue`, `recoveryWindow`, `stacked`, `prFactsOf`, `armedFact`, `predecessorMerged`, `staleBase*`, `repoAllowsAutoMerge`, `slowStage*`, `slowQueue*`, `ageOver` (if unused), `hasPRItem`, `trackPRGuard`, `mergeGuard`, `closedHaltText`, `noPushHalt*`, `authoringRecoveryGuard`, `failedAfterFixText`, `conflictingAgainText`, `fixSpawnInterruptedText`, `short` (if unused), `oldestUnfinished`, `stageLabel` (if unused), and `ruleCtx.oldest`.
- `removedProjectionGuard`'s "done" test keeps only the pane/queue half (`deriveQueue == QueueDone`). `needsProjection` keeps only the `scope.pane` condition, since no engine PR item exists any more.
- The wait table keeps only the queue waits: `done` (recorded), `paused`, `skipped`, `held`, `spawn-unknown` (already escalated) and `spawned` (the agent is working). Every PR and fix wait goes.

### 2. Derived statuses (`internal/autopilot/status.go`)

- Delete `PRStatus` and its constants, `FixStatus` and its constants, `prFacts`, `facts.pr`, `facts.autoMerge`, `armed()`, `haltedCone`, `observedMerged`, `blockedByDeps`, `inSeqPredecessor`, `prPrecheck`, `derivePR`, `deriveFix`, `authoringPane`, `paneIdle` (if unused elsewhere) and `changeMatches` (if unused elsewhere).
- `QueueStatus` and `deriveQueue` stay: `done › paused › skipped › held › pending › spawn-unknown › spawned › dead`.

### 3. Readiness: the `merge-auto` barrier no longer reads a PR item

Today, in `merge-auto`, a dependency is satisfied only when its one-PR sequence item (created by Q7) has merged (`mergeAutoBarrier` + `prMerged` in `gate.go`). With Q7 and `prs` gone, no PR item exists. Without a replacement, a `merge-auto` successor would spawn as soon as its predecessor ships, before the operator merged the PR. That would spawn off an unmerged base, which is a must-fix by the review bar ("spawns the wrong thing"). This plan's own queue runs `merge-auto`.

Replacement: a `merge-auto` barrier dependency is satisfied when the dependency is done **and** its branch's PR is observed **merged** this pass. The read is `gh pr view <dep-branch> --json url,state` in the dependency's own repo (cross-repo barriers included), and `state == "MERGED"` satisfies the barrier. It is recorded as a per-pass fact on `queueFacts` (for example `depMerged map[string]bool`) beside the existing `depPR`. `observeReadiness` performs the read, and `deriveQueue`/`unmetDep` reads the fact the same way it reads `depPR` today. The rules for a failed read stay the same: "no pull requests found" is a normal held state, and any other failure escalates through the usual dedupe (`dependency <id> PR lookup failed: …`) in step and is silent in read-only `status`. A dependency with no recorded branch escalates `dependency <id> has no branch recorded`, as `depPRExists` does today.

The engine's remaining `gh` calls are then exactly:

- `depPRExists`: the same-repo dependency with null `stop_stage` needs its PR to exist.
- The `merge-auto` barrier read above. It uses the same `gh pr view <branch>` shape and the same helper (`viewPR`).
- `plainAgentDone`: a change-less item completes on its branch PR merged, or open with required checks not pending (`gh pr checks <n> --required`). This keeps `requiredChecks`/`checksPending`, which move out of `observe.go` if that file loses its other content.
- Spawn's existing default-branch resolution (`gh repo view` fallback in `repo.go` `defaultBranch`) and `nameWithOwner` if still referenced by spawn. Delete `nameWithOwner` if only PR code used it.

### 4. Observe (`internal/autopilot/observe.go`)

Delete `isSeqPR`, `observePRs`, `observePR`, `observeStaleBase`, `observePRWrite` (the `operator.Observe` write-through and snapshot reload), `observeAutoMerge`, and the `observe()` branch that reloads after a PR write. Keep `observe`, `observeCompletion` and `observeReadiness` (extended per §3). `checkRun`/`requiredChecks`/`checksPending` stay because `plainAgentDone` uses them. Delete `firstFailed`.

### 5. Executors and files

- Delete whole files: `internal/autopilot/merge.go`, `restack.go`, `recovery.go`, and their tests `merge_test.go`, `restack_test.go`, `recovery_test.go`.
- `execute.go`: delete `trackPR`, `prLabel`, `recordMerged`, `hasReview`, `halt`, `disarmRow`, `target`/`e.target`, `disarm`, `prFinished`, `ready`, `arm` and `merge`, plus their `case`s in `execute`'s switch. Keep `execute`, `renderDecisions`, `reread`, `guarded`, `changedText` (the `pr` flag goes), `writeFailed`, `recordDone`, `escalateRow`, `reProject` and `skip`. The spawn/respawn executors in `spawn.go`/`riffspawn.go` are unchanged.
- `Decision.pr`, `Decision.Status` comments, and the "PR item `<id>` changed externally" text go. Only the queue form remains.
- `repo.go`: `prNum` and any PR-only helpers (`withRepo` if unused) go. `safeBranch`, `checkedBranch`, `validateSpawnBranches`, `depBranch`/`itemBranch`, `defaultBranch`, `resolveRef`, `isAncestor` and `worktreeForBranch` stay where spawn uses them. Delete what the compiler and `go vet` show unused.
- `autopilot.go`: `Env`'s seams stay (`Runner`, `Spawner`, `Panes` with busy-aware `Send`, `Notify`). Delete `Send` from the `Panes` interface only if no remaining code calls it. `fix-request` was its only engine caller, so check and delete if dead. `StepResult` drops PR-only report fields (merge report lines, `unreviewed` summary). `engine.coneErr` goes.

### 6. Engine file (`internal/autopilot/enginefile.go`)

- `engineState` keeps `version`, `migrated` and `queue`. Delete the `prs` and `fixes` lists and `upsertFix`/`fixParent`. `upsert` loses its `pr bool` parameter.
- `engineItem` keeps only the queue keys: `id`, `queue`, `repo`, `change`, `task`, `bare`, `branch`, `worktree`, `merge_mode`, `stop_stage`, `depends_on`, `paused`, `spawning`, `respawned`, `skipped`, `pane`, `session`, `projected`, `done_at`, `escalated`, `added_at`, `updated_at`, `spawned_by`. Delete `item`, `nwo`, `pr`, `url`, `merge_seq`, `deferred`, `halted`, `pr_dropped`, `recovery`, `fix_head`, `recovery_at` and `fix_item`. Delete `recoveryValues` and `roundSpent`.
- **Tolerant read**: an engine file that still carries `prs:`/`fixes:` lists, or the deleted item keys, loads without error and ignores them. Unknown YAML fields are already ignored. Add a test with a fixture file carrying both lists and a queue item with `halted`, `pr_dropped` and `recovery`. The next lock-holding write rewrites the file without them (dropping them on write is acceptable and expected).
- `OwnedIDs` returns only queue item ids. A former `pr-<n>` projection or fix-item projection in the ledger is therefore no longer engine-owned: `track add`/`track rm` and the judgment set treat it as an ordinary ledger item.
- **Migration** (`migrate.go`, kept): it no longer absorbs `github-pr` ledger items carrying `scope.merge_seq` into the engine file. Such items stay ordinary `github-pr` ledger items. It keeps absorbing `pane` items with `scope.queue` or a non-null `scope.merge_mode`. Adjust `migrate_test.go` accordingly.

### 7. CLI surface (`cmd/rk/operator_autopilot.go`, `operator_autopilot_admin.go`)

- **Delete the `merge` verb** (`Use: "merge [--repo <path>] [--all] [--json]"`, its RunE, its `AddCommand` registration and its tests). `rk operator autopilot` goes from eight children to seven: `queue`, `step`, `stop`, `status`, `rm`, `resume`, `pause`.
- **`stop`**: writes `paused` on every unspawned, unfinished queue item (live panes untouched), then runs one pass. The halt-every-PR-item half, the P3 disarm cone and the "cannot tell whether the halted PR is armed" error all go. Update help text to match.
- **`rm <id>`**: drops only an unspawned queue item (no `pane`, no `spawning`) with its identity-only projection. It still refuses an item another not-done queue item depends on (exit 2, naming dependents). The halted-sequence branch (by PR item id or `merge_seq`, fresh armed read, `pr_dropped`) goes. A PR id or sequence id is now an unknown id (usage error, exit 2). Update help text.
- **`resume <id>`**: clears `paused` or `skipped` on one queue item, then runs one pass. The `halted` case and the cone language go. An item with neither flag set, or an unknown id, is a usage error (exit 2).
- **`pause`**, **`queue`** and **`step`** are unchanged apart from report lines. `step`'s action vocabulary shrinks to `spawned`, `respawned`, `cherry-picked`, `paused`, `done`, `removed`, `resumed`, plus escalations. The `armed`, `merged`, `readied`, `disarmed`, `pr-tracked`, `recovery-sent`, `recovery-spawned`, `rebased`, `retargeted` and `untracked` lines and the `merged without review` summary go.
- **`status`**: `--json` keeps `state`, `merge_mode`, `task`, `change`, `stop_stage`, repo and branch, and **drops `pr_status`** and the `fixes` list. The human table drops the `PR #n · <status> · i/n` column. The Queue Completion Summary stays (it is queue-derived). **Resolved open decision (T3)**: `status` no longer lists the former PR projections. They are left to `rk operator track list`.
- Exit-code doc text: remove "`merge` on an incomplete queue" and "`rm` of a sequence with an armed or unreadable PR".
- `autopilot` parent help: describe the engine as queue/readiness/spawn/respawn/completion. PR readying, arming, merging, restacking and CI/conflict recovery are the operator run's work (mode = merge authority).
- `cmd/rk/operator_track.go:182-183` help text ("use rk operator autopilot rm for an unspawned queue item or a halted merge sequence") drops "or a halted merge sequence".

### 8. Judgment set (`internal/operatorloop/judgment.go`)

`reasonNeedsJudgment` gains the item kind:

```go
case operator.DeltaChanged:
	return item.Kind == operator.KindGitHubPR
case operator.DeltaDone:
	return item.Kind == operator.KindGitHubPR || (item.Then != nil && strings.TrimSpace(*item.Then) != "")
```

- A `changed` probe delta on a `github-pr` ledger item is judgment, as is a `done` on one (merged or closed). Former `pr-<n>` projections are now ordinary `github-pr` items, so their deltas reach the run.
- `pane_death` / `pane_mismatch` / `agent_exited` on an engine-owned queue item stays mechanical (`!owned`): Q4 respawns.
- `stage_advance` and `review_fail` stay non-judgment.
- Update `judgment_test.go` table: add rows for `changed` on a github-pr item (judgment), `changed` on a non-PR item (not), `done` on a github-pr item without `then` (judgment), and `done` on a pane item without `then` (not). Keep the existing rows green.

### 9. Settings description and chat-skill surface (Rule 5, minimal)

- `internal/settings/settings.go` `operator.merge_mode` `desc`: replace "merge-auto arms each PR to merge as it ships" with text stating both halves of a mode. It shapes how a queue item is spawned (ladder cherry-pick, stacked base, merge-auto unchained), and it tells the operator its merge authority (`merge-auto`: merge green PRs without asking; the other two: merge only on the user's word). Keep the struct comment at `settings.go:139` consistent.
- `docs/site/skill/operator.md` (synced to `cmd/rk/skill/operator.md` by the existing sync step) has references to verbs and behaviours this step deletes: `rk operator autopilot merge` (lines ~33, ~144), "`rm <id>` drops … a halted sequence", "resume" of halted, the `merge-auto` "each PR is armed the moment it lands" paragraph (~110), and the confirmation lines (~92). This step makes only the edits needed so the topic no longer names a deleted verb or a behaviour the engine no longer has. "merge all" becomes the chat's own job under the mode's authority, stated in one line, and `rm`/`resume` lose the halted-sequence clauses. The full **Merging** section per mode, the restored git/gh/wt tools, and the brief rules (`internal/operator/brief_rules.md`) belong to **T4** and are not touched here. `brief_rules.md` names only `queue|step|status`, so it needs no T3 edit.
- `rk help-dump` is generated from the cobra tree. Any test pinning the autopilot children list or the `merge` command updates with the verb deletion (`operator_autopilot_test.go`, `operator_autopilot_admin_test.go`, help-dump/toolkit tests that enumerate the operator tree).

### 10. Tests

- Delete with their code: `merge_test.go`, `restack_test.go`, `recovery_test.go`, and every PR- or fix-specific case in `rules_test.go`, `revised_rules_test.go`, `escalation_test.go` (Q6a/Q6b/B2/F2 cases), `status_test.go` (PR/fix status tables, `pr_status`), `ownstate_test.go`, `lifecycle_test.go`, `passes_test.go`, `deltas_test.go`, `durability_test.go`, `enginefile_test.go`, `migrate_test.go`, `harness_test.go` (fake gh scripts for `pr view`/`pr checks`/`repo view`/compare/merge/ready only where now unused), and `cmd/rk/operator_autopilot*_test.go` (merge verb, halted-sequence rm, halted resume, stop disarm).
- `decide` enumeration test: shrinks to the kept combinations (queue kind × every `QueueStatus` × the three merge modes). Every combination has a row or a declared wait, and none is `unmatched`.
- Keep green: spawn (all three modes' chaining), respawn, skip, completion (fab terminus/stop_stage, plain agent PR merged/green), readiness (same-repo dep PR exists), the pass lock, migration, queue validation, pause, X0/X1, Q3.
- New tests: the `merge-auto` barrier (dep done + PR open → held; dep done + PR merged → pending/spawns; read failure escalates in step and is silent in status). Tolerant read of an engine file with `prs`/`fixes`. `stop` pauses unspawned items and writes no `halted`. `rm` of an unknown/PR id → exit 2. `resume` of a `halted`-only item → exit 2. Judgment table rows (§8).
- Run `go test ./...` in `app/backend` (known host-only failures, unrelated: `cmd/rk` `TestPortPinRowRealPolicyValues`, `rk/api` `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath`) and `go vet ./...`.

### 11. Non-goals (copied per Rule 4)

- No new rows. No flag, build tag or dormant code path that keeps any PR executor reachable (Rule 7). Git history is the reference.
- No brief/chat-skill rewrite beyond removing references to deleted verbs. The Merging section, tool restoration, `track show` and the exit-contract changes are T4.
- No change to the spawn path, the pass lock or the engine file beyond removing keys (plan non-goal), apart from the `merge-auto` barrier read in §3, which readiness needs once PR items are gone.
- No change to `operator.Check`, its conditions or the loop ladder (T1/T2).
- **Review bar** (Rule 4, quoted for every review dispatch): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.
- PR evidence: `No recording: internal CLI/engine behavior`, plus the `go test`/`go vet` validation (Rule 6).

## Affected Memory

- `run-kit/operator-autopilot`: (modify) rewrite to the smaller engine. It covers the engine file (queue only, tolerant of legacy `prs`/`fixes`), projections (queue only), the pass shape (observe completion + readiness only), queue statuses, the rule table X0, X1, Q1–Q5, escalations (X0, Q3, spawn-path), queue, `rm`/`resume`/`pause` (queue items only), readiness including the new `merge-auto` merged-PR read, spawn (unchanged), and `stop`/`status` (no PR fields). Delete the Merge, Restack and recovery requirements and their PR-only Design Decisions. Add a Design Decision **"PR work returned to the operator"** citing `fab/plans/sahil/26-11-20-operator-triggers.md`, and update the description frontmatter.
- `run-kit/operator-loop`: (modify) § Judgment set. A `changed` probe delta or a `done` on a `github-pr` item is judgment. Remove "a `changed` probe delta on a PR item … never judgment". The mechanical-pass report vocabulary shrinks.
- `run-kit/operator-state`: (modify) engine-owned ids are queue items only. Former `pr-<n>` projections are ordinary `github-pr` items, the engine-file sibling description loses `prs`/`fixes`, and the `track rm` pointer loses "halted merge sequence".
- `run-kit/configuration`: (modify) `operator.merge_mode` description (spawn shape + merge authority), if the file restates it.
- `run-kit/toolkit-standards`: (modify) the `operator autopilot` help-dump surface no longer includes `merge`, if enumerated.
- `run-kit/architecture/cli`: (modify) the `rk operator autopilot` children list, if enumerated.

## Impact

- **Code**: `app/backend/internal/autopilot/` (rules, status, observe, execute, enginefile, migrate, gate, repo, autopilot, step, rm + tests; three files deleted with their tests), `internal/operatorloop/judgment.go` + test, `cmd/rk/operator_autopilot.go`, `operator_autopilot_admin.go`, `operator_track.go` (help text) + tests, `internal/settings/settings.go` (one description).
- **Docs**: `docs/site/skill/operator.md` and its synced copy `cmd/rk/skill/operator.md` (deleted-verb references only), memory files above.
- **Net**: a large deletion (several thousand lines including tests). Additions are the `merge-auto` barrier read, the judgment rows and the tolerant-read test.
- **Runtime compatibility**: the live daemons keep the installed `rk` until R1 (Rule 1). After R1, engine files on disk with `prs`/`fixes` load and are rewritten without them. Former PR projections become ordinary `github-pr` ledger items, which `operator.Check` already probes (their `changed`/`done` deltas now reach a run). Rollback: the older binary reads the smaller engine file fine (missing lists read empty).
- **No API/UI change**: no HTTP route or frontend file changes.

## Open Questions

None blocking. The plan's T3 open decision (whether `autopilot status` keeps listing former PR projections) is resolved in Assumptions #6.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Delete rows P1–P7, B1–B2, C1–C6, F1, Q6a, Q6b, Q7, their executors, `merge.go`/`restack.go`/`recovery.go`, PR observe facts, `prs`/`fixes`, the `merge` verb, stop's halt/disarm half, `rm` of a halted sequence, `resume` of halted | Plan T3 Brief and Decisions table, verbatim; Rule 7 forbids keeping them behind a flag | S:95 R:70 A:95 D:95 |
| 2 | Certain | Keep X0, X1, Q1–Q5, the pass lock, the migration, `queue`/`step`/`status`/`pause`, `resume` of paused/skipped, `rm` of an unspawned item | Plan T3 Brief, verbatim | S:95 R:80 A:95 D:95 |
| 3 | Confident | Also delete F2 and the `kindPR` variants of X0/X1 | Not named in the Brief, but F2 only exists for fix items and PR X0/X1 only for PR items, and both lists are deleted; leaving them would be dead rows | S:70 R:80 A:85 D:85 |
| 4 | Confident | Replace the `merge-auto` barrier (today: the dependency's Q7 PR item merged) with a per-pass `gh pr view <dep-branch> --json url,state` read: satisfied when `MERGED` | Without it a merge-auto successor would spawn before the predecessor merged (a must-fix "spawns the wrong thing"); the Brief keeps readiness's `gh` reads "because spawn needs them" and the plan's own merge-auto queue relies on "each step spawns off the merged predecessor"; same read shape as `depPRExists` | S:60 R:70 A:75 D:70 |
| 5 | Confident | Migration stops absorbing `github-pr` items with `scope.merge_seq`; they stay ordinary ledger items | Engine file has no `prs` list to absorb into; Brief: "Existing `pr-<n>` projection items are ordinary `github-pr` ledger items from now on" | S:70 R:80 A:85 D:85 |
| 6 | Confident | `autopilot status` stops listing former PR projections (drops `pr_status` and the PR column); they are left to `track list` | Resolves the plan's T3 open decision; consistent with "`status --json` keeps `merge_mode` and drops `pr_status`" and with PR projections becoming ordinary ledger items | S:65 R:85 A:75 D:70 |
| 7 | Confident | Judgment: `changed` and `done` deltas on a `github-pr` item are judgment reasons regardless of `then`; queue-item `pane_death` stays mechanical | Plan T3 Brief, verbatim; implementation via the item's `Kind` in `reasonNeedsJudgment` | S:90 R:85 A:85 D:85 |
| 8 | Tentative | T3 edits the chat skill (`docs/site/skill/operator.md` + synced copy) and the `operator.merge_mode` settings description only to remove references to deleted verbs and the "arms each PR" behaviour; the full Merging section and brief rules stay T4's | Rule 5 requires the skill topic to change with the CLI surface, but T4's Brief owns the skill rewrite; minimal edits satisfy both without pre-empting T4 | S:55 R:85 A:60 D:50 |
| 9 | Confident | Engine file tolerant read: legacy `prs`/`fixes` lists and deleted item keys are ignored on load and dropped on the next locked write | Brief: "A tolerant read of an engine file that still carries `prs`/`fixes` ignores them"; yaml unknown-field tolerance already exists | S:85 R:75 A:85 D:85 |
| 10 | Confident | `OwnedIDs` returns queue ids only, so former PR/fix projections are no longer engine-owned (`track` verbs and the judgment set treat them as ordinary items) | Direct consequence of deleting `prs`/`fixes`; matches "ordinary `github-pr` ledger items from now on" | S:75 R:80 A:85 D:80 |
| 11 | Certain | PR evidence is `No recording: internal CLI/engine behavior` with `go test`/`go vet` validation | Plan Rule 6 | S:95 R:95 A:95 D:95 |

11 assumptions (3 certain, 7 confident, 1 tentative, 0 unresolved).
