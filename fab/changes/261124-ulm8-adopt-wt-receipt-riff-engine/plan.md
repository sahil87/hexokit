# Plan: Adopt wt v0.1.8 receipt in riff and the autopilot engine

**Change**: 261124-ulm8-adopt-wt-receipt-riff-engine
**Intake**: `intake.md`

## Requirements

### riff: wt create invocation and receipt

#### R1: wt create argv carries `--json`, and `--fetch` only on request
Worktree-mode `wt create` argv built by `buildWtCreateArgs` (`app/backend/internal/riff/riff.go`) SHALL always include `--json`. It SHALL include `--fetch` only when a new field `WorktreeFetch bool` (on `Options` and `EffectiveSpec`, worktree mode only, cleared in checkout mode like the other worktree fields) is true AND `CheckoutBranch` is empty. Riff's own flags SHALL precede the `--` passthrough, which is forwarded verbatim; the positional branch stays last.

- **GIVEN** a spec with `WorktreeBase: "origin/main"`, `WorktreeFetch: true`, `WorktreeName: "a"`
- **WHEN** `buildWtCreateArgs` runs
- **THEN** argv is `create --name a --base origin/main --fetch --json --non-interactive --open skip <passthrough…> [branch]` (order of `--json`/`--non-interactive`/`--open skip` may vary; all present)
- **AND** with `WorktreeFetch: false` (every hand `rk riff`), no `--fetch` appears
- **AND** with `CheckoutBranch` set, no `--fetch`, no `--base`

#### R2: The receipt replaces `Path:` parsing
`runWtCreate` SHALL capture wt's stdout separately from stderr and decode the single JSON document `{"ok":bool,"result":{path,name,branch,base_ref,base_sha,mode,init},"error":{code,message}}` (nullable `branch`/`base_ref`/`base_sha`). On `ok:true` it SHALL return the decoded result (path verified to be a directory, as today). On `ok:false` it SHALL return an exported error type `*riff.WtCreateError` carrying wt's exit `Code`, `Message`, and — when the document carries `result` — the kept worktree's path, unwrapping (`errors.As`) to an `*ExitCodeError{Code: ExitSubprocess}` so CLI exit mapping and the API's `riffStatusForError` are unchanged. A stdout that is not a receipt (e.g. cobra rejecting a bad passthrough flag) SHALL be an `ExitSubprocess` error that includes wt's stderr. `parseWorktreePath` SHALL be deleted.

- **GIVEN** a stub `wt` printing `{"ok":true,"result":{"path":"<dir>","name":"a","branch":"a","base_ref":"origin/main","base_sha":"<40hex>","mode":"new","init":"ok"}}`
- **WHEN** a riff spawn runs
- **THEN** the window is rooted at `<dir>` and the result carries branch `a`, base ref `origin/main`, base SHA `<40hex>`, init `ok`
- **GIVEN** a stub printing `{"ok":false,"error":{"code":3,"message":"Failed to fetch remote 'origin'"}}` and exiting 3
- **THEN** the spawn fails with a `*WtCreateError{Code:3}` whose message contains `Failed to fetch remote 'origin'`, and no window is opened

#### R3: Spawn results carry the receipt
`riff.Result` SHALL gain `Branch`, `BaseRef`, `BaseSHA`, `Init` (empty string for JSON `null`). `SpawnReceipt.Branch` (the CLI `--json` receipt) SHALL come from the wt receipt; `worktreeBranch` (`git rev-parse --abbrev-ref HEAD`) SHALL be deleted. The window-created hook of `SpawnObserved` SHALL deliver the receipt's branch and base SHA to its caller (signature change to a small exported struct, e.g. `riff.OpenedWindow{PaneID, WindowID, WorktreePath, Branch, BaseRef, BaseSHA}`); in checkout mode those receipt fields are empty. The CLI `--json` receipt SHALL gain no new keys.

- **GIVEN** an engine `SpawnObserved` call in worktree mode
- **WHEN** the window opens
- **THEN** the hook receives the receipt branch and base SHA without any git call by riff

#### R4: Init failure (exit 7) keeps and reports the worktree
When the receipt is `ok:false` with `error.code == 7` and a `result` (`init: "failed"`), riff SHALL return a `*WtCreateError{Code:7}` whose message names the kept worktree path and wt's message, SHALL NOT run `wt delete`, and SHALL NOT open a window. The daemon `Spawn`/`SpawnObserved` path SHALL return `Result{WorktreePath, Init: "failed"}` alongside the error. Fan-out keeps the failing goroutine's worktree (existing `planFanOutRollback` exclusion).

- **GIVEN** a stub `wt create` emitting an exit-7 document with `result.path = <dir>`
- **WHEN** a spawn runs
- **THEN** the error text contains `<dir>`, `wt delete` is never invoked, and no tmux window is created

#### R5: Minimum wt version gate
Before any `wt create`, riff SHALL ensure `wt --version` (format `wt version vX.Y.Z`) reports ≥ v0.1.8, probed with `exec.CommandContext` under a short timeout. Below the minimum, or on unparseable output, it SHALL refuse with an `*ExitCodeError{Code: ExitPrecondition}` whose one-line message names the observed version string and the fix, e.g. `run-kit riff: wt v0.1.6 is too old — rk needs wt >= v0.1.8 (run: wt update)`. A passing probe SHALL be cached for the process; a failing probe SHALL NOT be cached (the next spawn re-probes). The gate SHALL live in `internal/riff` so the CLI (`Run`, fan-out) and the daemon (`Spawn`, `SpawnObserved`, the autopilot engine) all pass through it. No code path falls back to `Path:` parsing.

- **GIVEN** a stub `wt` answering `--version` with `wt version v0.1.7`
- **WHEN** any worktree-mode spawn runs
- **THEN** it fails with the `wt update` message, exit class precondition, and `wt create` is never invoked
- **AND** after the stub is changed to `v0.1.8`, the next spawn in the same process succeeds

#### R6: No-upstream option
A new field `WorktreeNoUpstream bool` (Options + EffectiveSpec, worktree mode only) SHALL make `runWtCreate` run `wt` with `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=branch.autoSetupMerge`, `GIT_CONFIG_VALUE_0=false` appended to the inherited environment, so wt sets no upstream on the new branch. Without the field the environment is unchanged (hand riffs keep wt's default).

- **GIVEN** `WorktreeNoUpstream: true` and a stub `wt` that records its environment
- **WHEN** a spawn runs
- **THEN** the stub saw `GIT_CONFIG_KEY_0=branch.autoSetupMerge` / `GIT_CONFIG_VALUE_0=false`; without the field it saw neither

### engine: spawn through wt's fetch and pin

#### R7: The engine no longer fetches or pins
`spawnItem` (`app/backend/internal/autopilot/spawn.go`) SHALL NOT run `git fetch origin` nor `git rev-parse <baseRef>`. `SpawnRequest.BaseSHA` SHALL be replaced by `BaseRef` (`origin/<base>`: the stacked dependency branch, else the item's `base`, else the default branch). `RiffSpawner` (`riffspawn.go`) SHALL map a new-worktree request to `riff.Options{WorktreeBase: req.BaseRef, WorktreeFetch: true, WorktreeNoUpstream: true, …}`; the respawn (`ExistingWorktree`/checkout) mapping is unchanged.

- **GIVEN** a queued item in a repo whose `origin/main` is ahead of the local checkout
- **WHEN** the engine spawns it
- **THEN** the engine's runner recorded no `git fetch` and no `git rev-parse origin/…`, the request's `BaseRef` is `origin/main`, and the branch is cut from the fetched origin tip (receipt `base_sha`)

#### R8: Receipt-sourced branch and base SHA are recorded
`SpawnResult` SHALL gain `BaseSHA`. For a new worktree the branch SHALL come from the receipt (request-fixed `NewBranch`/`CheckoutBranch` still win); `openedBranch`'s `git rev-parse --abbrev-ref HEAD` remains only for the existing-worktree respawn path. `attach` SHALL write the branch as today (projection → `branch_map`) and record `base_sha` on the engine item via a new optional `engineItem.BaseSHA` (`yaml:"base_sha,omitempty"`), tolerant in both directions; `status --json` is unchanged.

- **GIVEN** a successful spawn whose receipt names branch `a` and base SHA `S`
- **THEN** the engine item has `branch: a`, `base_sha: S`, and `branch_map` maps the item to `a`

#### R9: wt failures map to the existing pending-and-escalate outcome
A spawn error SHALL clear the spawning marker and leave the item `pending` (existing `launchWithPolicy` path). The escalation text SHALL be derived from `*riff.WtCreateError` when present: code 3 → `wt create --fetch failed, spawn stopped and the item stays pending: <message>`; code 2 on a spawn with a base → `<base ref> could not be resolved after the fetch (is the branch on origin? push it before stacking): <message>`; code 7 → `wt init failed; worktree <path> was kept and the item stays pending — remove it (wt delete <name>) before the retry: <message>`; anything else (including the version-gate refusal) keeps `spawn failed: <error>`, so the gate's `wt update` text reaches the escalation.

- **GIVEN** the spawner returns `&riff.WtCreateError{Code:3,…}`
- **THEN** an escalation containing `wt create --fetch failed` is recorded, the item is `pending`, and no spawning marker remains

#### R10: Stacked base existence is wt's check on the spawn path
On the spawn path `stackedBase` SHALL NOT verify `refs/remotes/origin/<dep-branch>` (that read would see the main checkout's stale refs and, with no engine fetch left, block a freshly pushed dependency forever); wt's post-fetch `Invalid --base ref` (exit 2) is the check, surfaced per R9. The respawn path's verify SHALL stay. `ladderDeps`/`resolveRef`/`defaultBranch` reads stay; the cherry-pick in `prepareWorktree` runs after wt's fetch. `defaultBranch`'s comment "It runs after a successful fetch" SHALL be corrected.

- **GIVEN** a `stacked-prs` dependent whose dependency branch was pushed to origin after the main checkout's last fetch
- **WHEN** the engine spawns the dependent
- **THEN** it spawns with `BaseRef: origin/<dep-branch>` (no "not on origin" escalation)

#### R11: Spawned branches carry no upstream
A branch the engine creates SHALL have no `branch.<b>.remote`/`branch.<b>.merge` (kept invariant, now via R6). `TestSpawnBranchHasNoUpstreamTracking` SHALL keep asserting it against a fake spawner that models wt (fetch, resolve `BaseRef`, `worktree add -b <branch> <path> <sha>`, honoring the no-upstream request).

- **GIVEN** an engine spawn
- **THEN** `git config --get branch.<b>.merge` fails in the repo

### Docs

#### R12: Memory reflects the receipt as the spawn's record
`docs/memory/run-kit/rk-riff.md` and `docs/memory/run-kit/operator-autopilot.md` SHALL describe the new argv, receipt decoding, `Result` fields, version gate, exit-7 report, no-upstream option, and the engine's "wt fetches and pins; the receipt is the record" spawn, with a Design Decision "The receipt is the spawn's record" superseding "Fetch-first SHA pin". (Written at hydrate.)

- **GIVEN** hydrate completes
- **THEN** neither memory file describes `Path:` parsing or an engine-side fetch/rev-parse as current behavior

### Non-Goals

- T10 (`brief_rules.md`, `rk skill operator`, `--temp`/`--pr`, PR base from `wt list --json`) — separate step
- New `rk riff` CLI flags or `--json` keys; `status --json` changes — not in the brief
- An engine-side wt version probe or any `Path:` fallback — the brief forbids a fallback
- Respawn, readiness, completion, `buildPrompt`, the pass lock — unchanged by the brief
- Installing binaries or restarting daemons — plan Rule 1
- Review bar (plan § Decisions): must-fix = merges, pushes, deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan requirement. Should-fix = everything else.

### Design Decisions

#### The receipt is the spawn's record
**Decision**: riff decodes `wt create --json`'s one receipt document for path, branch, base ref, pinned base SHA and init outcome; the engine passes `--base origin/<b> --fetch` and records the receipt's branch and `base_sha` instead of fetching and `rev-parse`-pinning itself.
**Why**: wt owns worktree creation (Constitution III); its receipt states the SHA the branch was actually cut from, where the engine's separate `rev-parse` only matched it by construction; scraping a `Path:` line breaks on any output change.
**Rejected**: keeping the engine fetch + SHA `--base` (duplicates wt, keeps three derivations of the same facts); a fallback to `Path:` parsing for older wt (two code paths; a version gate with a `wt update` fix instead).
*Introduced by*: 261124-ulm8-adopt-wt-receipt-riff-engine

#### No upstream via `branch.autoSetupMerge=false`
**Decision**: the engine's `wt create` runs with `GIT_CONFIG_*` env setting `branch.autoSetupMerge=false`, so a remote-tracking `--base` sets no upstream; hand `rk riff` keeps wt's default.
**Why**: a spawned branch tracking `origin/<base>` makes fab's `/git-pr` skip `push -u` and run a bare `git push`, which `push.default=simple` rejects and `push.default=upstream` sends to the base branch.
**Rejected**: `git branch --unset-upstream` in Prepare (an extra git call needing a no-upstream guard); accepting upstream (wrong-push risk).
*Introduced by*: 261124-ulm8-adopt-wt-receipt-riff-engine

#### `--fetch` only on request
**Decision**: riff always passes `--json` but `--fetch` only via `WorktreeFetch`, which the engine sets.
**Why**: an unconditional fetch makes every hand riff network-bound and turns `rk riff -- --reuse --name x` into a wt usage error; hand spawns pass `--fetch` through `--` when they want it.
**Rejected**: always `--fetch` (literal brief reading).
*Introduced by*: 261124-ulm8-adopt-wt-receipt-riff-engine

## Tasks

### Phase 1: riff

- [x] T001 In `app/backend/internal/riff/riff.go`: add `WorktreeFetch` and `WorktreeNoUpstream` to `Options` and `EffectiveSpec` (copied in `SpawnObserved`, cleared in checkout mode); extend `buildWtCreateArgs` with `--json` always and `--fetch` per R1. Update `TestBuildWtCreateArgs` in `riff_test.go` (with/without fetch, checkout drops fetch/base, passthrough verbatim). <!-- R1 -->
- [x] T002 In `riff.go`: add the receipt types and the exported `WtCreateError` (Code, Message, Kept path; `Error()`, `Unwrap()` → `*ExitCodeError{ExitSubprocess}`); rewrite `runWtCreate` to capture stdout/stderr separately, decode the receipt, return the decoded result, apply `WorktreeNoUpstream` env (R6); delete `parseWorktreePath` and `TestParseWorktreePath`; add a receipt-decode table test (success with nulls, exit-3 doc, exit-7 doc with result, non-JSON stdout). <!-- R2 -->
- [x] T003 In `riff.go`: add `Branch`, `BaseRef`, `BaseSHA`, `Init` to `Result`; thread the receipt through `SpawnObserved`/`Spawn`, `Run`, and `runCount` (fan-out `SpawnReceipt.Branch` from the receipt); delete `worktreeBranch`; change the window-created hook to deliver an exported struct with the receipt branch/base (update `TestSpawnObservedRecordsPaneBeforeLaterFailure`). <!-- R3 -->
- [x] T004 In `riff.go`: exit-7 handling per R4 (error names the kept path, no rollback, no window; daemon path returns `Result{WorktreePath, Init:"failed"}`); test with a stub `wt` whose `create` emits an exit-7 document and whose `delete` logs (must stay empty), and assert no tmux window. <!-- R4 -->
- [x] T005 In `riff.go` (or a new `internal/riff/wtversion.go`): the version gate per R5 (parse `wt version vX.Y.Z`, semver compare against v0.1.8, cache success only, `ExitPrecondition` message with `wt update`), called at the top of `runWtCreate`; unit-test the parser/compare table and a stub-driven too-old → upgraded sequence. Add a test seam to reset the cache. <!-- R5 -->
- [x] T006 Update every stub `wt` in `internal/riff/riff_test.go`, `internal/riff/deliver_test.go`, and `cmd/rk/riff_test.go` to answer `--version` with `wt version v0.1.8` and to print a receipt (not `Path:`) for `create`; add an R6 env test (stub records `GIT_CONFIG_*`); run `just test-backend` for the riff and cmd/rk packages. <!-- R6 -->

### Phase 2: engine

- [x] T007 In `app/backend/internal/autopilot/autopilot.go` and `riffspawn.go`: replace `SpawnRequest.BaseSHA` with `BaseRef`; add `SpawnResult.BaseSHA`; map new-worktree requests to `WorktreeBase`/`WorktreeFetch`/`WorktreeNoUpstream`; take branch/base SHA from the hook struct (request-fixed branch wins; `openedBranch` git read only for `ExistingWorktree`); rewrite the `SpawnRequest` doc comment. <!-- R7 -->
- [x] T008 In `spawn.go`: delete the engine `git fetch origin` and `git rev-parse <baseRef>`; pass `BaseRef`; split `stackedBase` so the spawn path skips the origin verify while respawn keeps it (R10); correct `defaultBranch`'s comment in `repo.go`. <!-- R10 -->
- [x] T009 In `spawn.go` (`launchWithPolicy` or a helper) map `*riff.WtCreateError` codes 3/2/7 to the R9 escalation texts, keeping `spawn failed: <err>` otherwise. <!-- R9 -->
- [x] T010 In `enginefile.go` and `spawn.go` `attach`: add `engineItem.BaseSHA` (`base_sha,omitempty`) and record `res.BaseSHA`; confirm tolerant read of files without the key. <!-- R8 -->
- [x] T011 In `internal/autopilot/harness_test.go`: rework `fakeSpawner` to model wt — `git fetch origin` (via the test's own git helper, not the engine runner), resolve `req.BaseRef` to a SHA (failure → `&riff.WtCreateError{Code:2,…}`), `worktree add -b <branch> <path> <sha>`, return receipt-shaped `Branch`/`BaseSHA`, optional injected `WtCreateError` for exit-3/exit-7 cases. <!-- R11 -->
- [x] T012 In `internal/autopilot/spawn_test.go` / `spawning_test.go` / `passes_test.go`: rewrite `TestSpawnPinsFetchedTipNotStaleLocalHead` (base_sha = fetched origin tip, no engine fetch/rev-parse argv), `TestSpawnFetchFailureStopsTheSpawn` (exit-3 → escalation, pending, marker cleared), the item-`base` rev-parse count assertion (~line 794) to assert `BaseRef: origin/eng-v2` and zero engine rev-parse; keep `TestSpawnBranchHasNoUpstreamTracking` green; add exit-7, stacked-freshly-pushed-dependency (R10), and `base_sha`/`branch_map` attach (R8) cases; run `just test-backend`. <!-- R7 -->

## Execution Order

- T001–T005 before T006 (stubs follow the final protocol); T003 before T007 (hook struct); T007 before T008–T012.

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `buildWtCreateArgs` emits `--json` for every worktree-mode create and `--fetch` only when `WorktreeFetch` is set without `CheckoutBranch`; passthrough is verbatim
- [ ] A-002 R2: `runWtCreate` decodes the receipt from stdout only; `parseWorktreePath` no longer exists; `ok:false` yields `*WtCreateError` unwrapping to `*ExitCodeError{ExitSubprocess}`
- [ ] A-003 R3: `riff.Result` has `Branch/BaseRef/BaseSHA/Init`; `worktreeBranch` is gone; the CLI receipt's branch comes from wt; no new CLI JSON keys
- [ ] A-004 R4: exit 7 reports the kept path, never calls `wt delete`, opens no window
- [ ] A-005 R5: spawns refuse below v0.1.8 or on unparseable version with the `wt update` message; success cached, failure re-probed
- [ ] A-006 R6: `WorktreeNoUpstream` injects exactly the three `GIT_CONFIG_*` vars; absent otherwise
- [ ] A-007 R7: the engine runs no `git fetch` and no `git rev-parse origin/…` during a spawn; `SpawnRequest.BaseRef` is `origin/<b>` per mode
- [ ] A-008 R8: the engine item records the receipt `branch` and `base_sha`; `branch_map` follows the branch
- [ ] A-009 R9: exit-3/2/7 escalations use the mapped texts; item stays `pending` with no spawning marker
- [ ] A-010 R10: spawn-path `stackedBase` makes no origin verify; respawn still does; `defaultBranch` comment corrected
- [ ] A-011 R11: engine-spawned branches have no upstream; `TestSpawnBranchHasNoUpstreamTracking` passes against the wt-modelling fake
- [ ] A-012 R12: memory files describe the receipt-based spawn (verified at hydrate)

### Scenario Coverage

- [ ] A-013 R2: tests cover success-with-nulls, exit-3, exit-7, non-JSON receipts
- [ ] A-014 R10: a test spawns a stacked dependent whose dependency was pushed after the main checkout's last fetch
- [ ] A-015 R5: a test drives too-old → upgraded within one process

### Edge Cases & Error Handling

- [ ] A-016 R2: a passthrough flag wt rejects at parse time (no document) yields an `ExitSubprocess` error carrying wt's stderr, not a JSON decode panic
- [ ] A-017 R4: in fan-out, an exit-7 worktree is not rolled back

### Code Quality

- [ ] A-018 Pattern consistency: new code follows riff/autopilot naming, error, and `exec.CommandContext`-with-timeout patterns
- [ ] A-019 No unnecessary duplication: the version gate and receipt decode live once in `internal/riff`; the engine reuses them
- [ ] A-020 No comment narration: comments state constraints (e.g. why no upstream), never change IDs or next-line narration
- [ ] A-021 Tests run through `just test-backend`; all backend tests pass (host-only known failures `TestPortPinRowRealPolicyValues`, `TestTerminals_IsoSharedSessionSurvivesFirstClientDeath` excepted)

### Security

- [ ] A-022 R6: all subprocesses (`wt --version`, `wt create`) use `exec.CommandContext` with a timeout and argument slices; the env injection adds fixed constant values only

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Exported `riff.WtCreateError` (Code, Message, Kept) unwrapping to `*ExitCodeError` is how the engine distinguishes wt exit codes | The engine needs codes 2/3/7; `errors.As` keeps CLI/API mapping intact | S:60 R:80 A:75 D:60 |
| 2 | Confident | The window-created hook signature changes to an exported struct carrying receipt branch/base | Its only callers are the autopilot adapter and one riff test; the engine must persist the branch inside the hook | S:60 R:80 A:80 D:65 |
| 3 | Confident | The version gate runs at the top of `runWtCreate`, so checkout-mode spawns (no wt create) never probe | Every wt create path funnels through it; checkout mode has nothing to gate | S:65 R:85 A:80 D:70 |
| 4 | Confident | Exit-2 escalation mentions the base not being on origin generically rather than only for stacked mode | Item `base` is validated at queue time, so in practice exit 2 on a spawn is the stacked/dep case; one text covers both | S:55 R:85 A:70 D:60 |
| 5 | Confident | `fakeSpawner` performs the fetch with the test's own git helper so engine-runner argv assertions stay meaningful | The fake stands in for wt, whose git calls are not the engine's | S:65 R:85 A:80 D:70 |

| 6 | Confident | The receipt's kept-worktree type is exported as `riff.KeptWorktree{Path, Name, Init}` (`WtCreateError.Kept`, plus `KeptPath()`), so the engine's fake spawner can model an exit-7 create | The engine package cannot construct an unexported type; the error text and `Result` still carry the same facts | S:60 R:85 A:80 D:65 |
| 7 | Confident | `ensureWtVersion` also runs once before a fan-out starts, and a missing or unrunnable `wt --version` is an `ExitPrecondition` refusal with the same `wt update` fix | N goroutines each probing and failing would produce N identical errors; an unreadable version is as unusable as an old one | S:60 R:85 A:80 D:70 |
| 8 | Confident | `RiffSpawner` sets `WorktreeFetch` only when the request carries a `BaseRef`, and `WorktreeNoUpstream` always (both cleared for the existing-worktree respawn) | A new worktree always has a base in the engine; the guard keeps `--fetch` off any request that names none | S:65 R:85 A:80 D:70 |
| 9 | Confident | `applyEngineItem` carries `BaseSHA` over from the stored item (as it does `Worktree`), and `engineItem.BaseSHA` is `json:"base_sha,omitempty"` on a type `status --json` does not marshal | `applyEngineItem` rebuilds the item from the tracked scope, which has no `base_sha`; without the carry-over the next guarded write would drop the record | S:70 R:80 A:85 D:75 |
| 10 | Confident | The window-created hook's `WorktreePath` is the receipt's worktree root, not the (possibly subdirectory) window root; checkout mode keeps the window root | The engine records it as the item's worktree; no engine path sets `WorktreeSubdir` | S:60 R:85 A:80 D:70 |
| 11 | Confident | The `cmd/rk` autopilot CLI test environment gains a no-op failing spawner, and the engine's now-unused `gitFetchTimeout` class is removed | Those passes reached the (nil) spawner once the engine fetch that used to stop them was deleted; the fetch timeout class has no caller left | S:65 R:85 A:80 D:70 |
| 12 | Confident | `rk riff --help` text is left as is (it names no wt version); the version requirement surfaces through the gate's refusal message | Rule 5: no CLI surface change, so no help-dump fixture moves | S:60 R:85 A:75 D:70 |

12 assumptions (0 certain, 12 confident, 0 tentative).
