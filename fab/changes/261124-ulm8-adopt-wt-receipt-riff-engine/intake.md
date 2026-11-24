# Intake: Adopt wt v0.1.8 receipt in riff and the autopilot engine

**Change**: 261124-ulm8-adopt-wt-receipt-riff-engine
**Created**: 2026-11-24

## Origin

> Execute step T9 (Adopt wt v0.1.8 in riff and the engine) of the plan at
> /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-20-operator-triggers.md. Read the whole plan first
> (Decisions and Rules bind you), then implement only the T9 Brief.

One-shot `/fab-new`, in the operator-spawned worktree `ot-t9`. The plan binds this change: its
**Decisions** table, the **Rules for the operator executing this plan**, and the **T9 Brief** (quoted
verbatim below). Only T9 is in scope — T10 (`--temp`/`--pr` in the run rules and chat skill) and R2
(roll-out) are separate steps.

T9 Brief, verbatim:

> `wt` v0.1.8 (sahil87/wt plan `26-11-23-worktree-base-receipts.md`, PRs #62–#66) ships
> `wt create --fetch --json`, the recorded base (`branch.<name>.wt-base[-sha]`, `base`/`base_sha` in
> `wt list --json`), the `--reuse`+`--base` usage error, `--pr <n>` and `--temp <ref>`. Everything riff
> and the engine do around `wt create` today exists to compensate for their absence.
>
> - **riff** (`internal/riff/riff.go`): `runWtCreate` passes `--fetch --json`; `parseWorktreePath`'s
>   `^Path:` scan is replaced by decoding the one receipt document (`{path, name, branch, base_ref,
>   base_sha, mode, init}`); `Result` gains `BaseRef`, `BaseSHA` and `Init`. A receipt with
>   `init: failed` is the existing exit-7 shape: the worktree exists, report it, never roll back. `rk riff`
>   keeps the `--` passthrough.
> - **engine** (`internal/autopilot/spawn.go`): delete the engine's `git fetch origin` and the
>   `rev-parse` of `baseRef`; pass `--base origin/<def|dep|base>` with `--fetch` and take `base_sha` and
>   `branch` from the receipt for the attach write and `branch_map`. "A failed fetch stops the spawn"
>   becomes `wt` exit 3 → the same escalation and `pending` outcome. The ladder cherry-pick keeps its
>   `rev-parse --verify refs/remotes/origin/<dep>` (the fetch inside `wt create` has refreshed it). The
>   stacked path's `set-base-branch` and respawn (`--checkout`) are unchanged.
> - **Minimum version**: riff probes `wt --version` once per process and refuses to spawn below
>   v0.1.8 with a one-line fix (`wt update`); the engine escalates the same text. No silent fallback to the
>   old parsing.
> - Tests: riff's wt fake emits the receipt; engine spawn tests assert no `fetch`/`rev-parse` argv and
>   the receipt-sourced `branch`/`base_sha`; exit-3 and exit-7 receipts.
> - Docs: `rk-riff.md`, `operator-autopilot.md` § Spawn (fetch-first SHA pin becomes "`wt` fetches and
>   pins; the receipt is the record"), a Design Decision "The receipt is the spawn's record".

Intake research verified the receipt contract against the installed `wt v0.1.8` (scratch repo
experiment, see § What Changes → "Verified wt v0.1.8 behavior") and surfaced one conflict the brief
does not mention: **`--base origin/<b>` makes `wt` set upstream tracking on the new branch**, which the
engine's existing design deliberately avoids (Design Decision "Fetch-first SHA pin", test
`TestSpawnBranchHasNoUpstreamTracking`). Resolution recorded as assumption #6.

## Why

1. **The problem.** riff and the engine work around a `wt create` that, before v0.1.8, had no machine
   output and no fetch: riff scans combined output for a `^Path:` line (`parseWorktreePath`,
   `internal/riff/riff.go:740`) and then shells out to `git rev-parse --abbrev-ref HEAD` for the branch
   (`worktreeBranch`, `riff.go:504`); the engine runs its own `git fetch origin`
   (`internal/autopilot/spawn.go:92`), its own `git rev-parse origin/<base>` to pin a SHA
   (`spawn.go:163`), and a second branch read (`openedBranch`, `internal/autopilot/riffspawn.go:78`).
   `wt` v0.1.8 does all of this itself and reports it in one JSON receipt.
2. **If we don't.** Three copies of the same facts (path, branch, pinned base) derived three ways keep
   drifting; the `Path:` scan breaks the day wt's human output changes; the engine's SHA is computed from
   a ref read separately from the worktree add, so "the SHA we recorded" and "the SHA the branch was cut
   from" are only equal by construction, never by record. T10 (restacks with `--temp`, fixes with
   `--pr`, PR base from `wt list --json base`) depends on spawns going through the recorded-base path.
3. **Why this approach.** Constitution III (Wrap, Don't Reinvent): wt owns worktree creation, so it
   should own fetch, pin and the record of both. The receipt is a structured, versioned contract
   (`{"ok":…,"result":{…}}`, `error.code` == exit code) — strictly better than scraping text. A minimum
   version gate (no fallback) keeps a single code path.

## What Changes

### Verified wt v0.1.8 behavior (scratch repo, 2026-11-24)

```
$ wt --version
wt version v0.1.8

$ wt create --base origin/main --fetch --json --no-init aa
{"ok":true,"result":{"path":"/…/repo.worktrees/aa","name":"aa","branch":"aa","base_ref":"origin/main","base_sha":"b3c1e28c…","mode":"new","init":"skipped"}}
exit=0
$ git config --get-regexp '^branch\.aa\.'
branch.aa.remote origin
branch.aa.merge refs/heads/main          # ← upstream set to origin/main (branch.autoSetupMerge default)
branch.aa.rebase true
branch.aa.wt-base origin/main
branch.aa.wt-base-sha b3c1e28c…

$ GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=branch.autoSetupMerge GIT_CONFIG_VALUE_0=false \
    wt create --base origin/main --fetch --json --no-init bb
{"ok":true,"result":{…,"branch":"bb","base_ref":"origin/main","base_sha":"b3c1e28c…","mode":"new","init":"skipped"}}
$ git config --get-regexp '^branch\.bb\.'
branch.bb.wt-base origin/main            # ← no remote/merge: no upstream
branch.bb.wt-base-sha b3c1e28c…

# fetch failure (origin unreachable)
{"ok":false,"error":{"code":3,"message":"Failed to fetch remote 'origin'"}}   exit=3
# base not on origin after the fetch
{"ok":false,"error":{"code":2,"message":"Invalid --base ref: origin/nope"}}    exit=2
```

Receipt contract (wt `docs/specs/cli-surface.md` § `--json` receipt): stdout is exactly one compact JSON
line on every `RunE` exit path; `ok == (exit == 0)`; `error.code` is the process exit code. Init failure
(exit 7, worktree kept) is `{"ok":false,"error":{"code":7,"message":"init script exited with status N"},"result":{…,"init":"failed"}}`.
`mode` ∈ `new|checkout|reuse|temp` (`--pr` reports `checkout`); `base_ref`/`base_sha` are `null` for
`checkout`/`reuse`; `branch` is `null` for `temp` or a detached/unreadable reuse. `init` ∈
`ok|failed|skipped|not-found`. `--fetch` is a no-op with `--checkout`/`--pr` and a usage error (exit 2)
with `--reuse`. `--json` implies `--non-interactive` and `--open skip`; an explicit non-skip `--open` is
exit 2. Cobra parse errors (unknown flag) emit no document.

### riff (`app/backend/internal/riff/riff.go`)

- **Argv.** `buildWtCreateArgs` always adds `--json` (it already passes `--non-interactive --open skip`;
  keep or drop those — `--json` implies both; keeping them is harmless). It adds `--fetch` only when the
  spawn carries an explicit base it wants fetched — see assumption #4: the engine sets it; hand
  `rk riff` spawns do not (T10 has hand spawns pass `-- --base origin/<b> --fetch` themselves, and an
  unconditional `--fetch` would make every hand riff network-bound and turn `rk riff -- --reuse --name x`
  into a wt usage error). Proposed shape: a new `Options`/`EffectiveSpec` field `WorktreeFetch bool` →
  `--fetch`, emitted only in worktree mode and never with `CheckoutBranch`.
- **Receipt decoding replaces `parseWorktreePath`.** `runWtCreate` captures **stdout separately from
  stderr** (today it uses `CombinedOutput`; wt keeps phase separators, the summary and `Error/Why/Fix`
  on stderr) and decodes the single document into an internal type, e.g.

  ```go
  type wtReceipt struct {
      OK     bool            `json:"ok"`
      Result *wtCreateResult `json:"result"`
      Error  *struct{ Code int `json:"code"`; Message string `json:"message"` } `json:"error"`
  }
  type wtCreateResult struct {
      Path, Name string
      Branch, BaseRef, BaseSHA *string // json: branch, base_ref, base_sha — nullable
      Mode, Init string
  }
  ```

  `runWtCreate` returns this result (not a bare path string). `parseWorktreePath` and its
  `TestParseWorktreePath` are deleted. The existing post-check that `path` is a directory stays.
  Failure messages carry wt's `error.message` (plus the stderr tail for context) instead of the
  combined output dump. A non-JSON stdout (e.g. a cobra parse error from a bad passthrough flag) is a
  `SubprocessErr` naming the stderr.
- **`Result` gains `BaseRef`, `BaseSHA`, `Init`** (strings; empty when the receipt has `null`), plus the
  receipt `Branch` (riff's `Result` has no `Branch` today; the engine needs it — see engine section).
  `SpawnReceipt.Branch` (the CLI `--json` receipt) is sourced from the wt receipt; `worktreeBranch`'s
  `git rev-parse --abbrev-ref HEAD` is deleted. The `windowCreated`/`SpawnObserved` hook must expose the
  receipt branch and base SHA to the engine (today it passes `(pane, window, path)`); widen it to pass
  the decoded receipt (or a small struct) — exact signature is a plan-stage choice.
- **Init failure (exit 7).** `ok:false` with `result.init == "failed"`: the worktree exists. riff
  returns an `ExitSubprocess` error whose message names the kept worktree path and wt's message, with
  `Result.WorktreePath`/`Init` populated; **no rollback** (no `wt delete`), no window opened — the same
  outcome as today's exit 7 (today the error is an opaque "wt create failed: exit status 7" with the
  combined output), now reported explicitly. In fan-out, `planFanOutRollback` already excludes the
  failing goroutine's own worktree, so the kept worktree survives there too. (Assumption #9.)
- **Minimum version gate.** riff probes `wt --version` (output `wt version vX.Y.Z`) and refuses to spawn
  below v0.1.8 with a one-line message, e.g.
  `run-kit riff: wt v0.1.6 is too old — rk needs wt ≥ v0.1.8 (run: wt update)`, as `ExitPrecondition`
  on the CLI path (alongside the existing `wt not found on PATH` precondition in
  `cmd/rk/riff.go:checkPreconditions`) and as a returned error on the daemon/engine path (which has no
  precondition step today — the gate must live in `internal/riff` so the daemon `Spawn`, `SpawnObserved`,
  `Run` and fan-out all hit it before any `wt create`). "Once per process": cache a **passing** probe
  (`sync.Once`-style or a mutex-guarded flag); a failing probe is re-probed on the next spawn so a
  `wt update` takes effect without a daemon restart (assumption #7). Unparseable version output also
  refuses, showing the raw string (assumption #8). The probe uses `exec.CommandContext` with a short
  timeout (Constitution I / Process Execution). No fallback to the old `Path:` parsing anywhere.
- **`rk riff` keeps the `--` passthrough** verbatim; riff's own flags come before the passthrough as
  today (`create [--name] [--checkout|--base] [--fetch] --json … <passthrough…> [positional]`).

### engine (`app/backend/internal/autopilot/spawn.go`, `riffspawn.go`, `autopilot.go`)

- **Delete** the engine's `git fetch origin` (`spawn.go:92–95`) and `git rev-parse <baseRef>`
  (`spawn.go:163–167`). `SpawnRequest.BaseSHA` becomes a base **ref** (`BaseRef`, value
  `origin/<def|dep|base>` — default branch, the stacked dependency branch, or the entry's `base`), and
  the request asks for a fetch; `RiffSpawner` maps it to `riff.Options{WorktreeBase: "origin/<b>",
  WorktreeFetch: true, …}`. The `SpawnRequest` doc comment ("never a ref: a remote-tracking start point
  sets upstream tracking") is rewritten to the new mechanism (assumption #6).
- **No upstream on spawned branches (kept invariant).** wt sets upstream for a remote-tracking `--base`
  per `branch.autoSetupMerge` (verified above: `branch.<b>.merge refs/heads/main`, `rebase true`). A
  spawned branch tracking `origin/main` would make fab's `/git-pr` skip its `git push -u origin <branch>`
  ("If no upstream") path and run a bare `git push` — rejected under `push.default=simple`, and under
  `push.default=upstream` it **pushes to main** (must-fix class: pushes the wrong thing). The engine
  keeps "no upstream": the engine's wt invocation runs with
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=branch.autoSetupMerge GIT_CONFIG_VALUE_0=false` in its
  environment (riff option, e.g. `WorktreeNoUpstream bool`, set only by `RiffSpawner`), which wt honors
  ("`false` never") — verified above. Hand `rk riff` spawns keep wt's default (the user chose
  `--base`). `TestSpawnBranchHasNoUpstreamTracking` stays and must keep passing against the new path
  (its fake spawner must now model `wt`'s behavior — see Tests).
- **Receipt-sourced `branch` and `base_sha`.** `SpawnResult` gains `BaseSHA`; `attach` writes
  `res.Branch` (now the receipt's `branch`) as today — it flows to the projection and, through
  `track`'s upsert, to `branch_map` — and records `res.BaseSHA` on the engine item (new optional key
  `base_sha` on `engineItem`, tolerant read both ways — assumption #10). `openedBranch`'s
  `git rev-parse --abbrev-ref HEAD` fallback for new worktrees is replaced by the receipt branch; the
  request-fixed branch (`NewBranch`/`CheckoutBranch`) still wins when set, and the respawn path
  (`ExistingWorktree`, checkout mode — no `wt create`, no receipt) keeps its git read.
- **Failed fetch → wt exit 3.** "A failed fetch stops the spawn" becomes: wt exits 3 with
  `error.message "Failed to fetch remote 'origin'"` → riff error → `launchWithPolicy`'s
  `err != nil && !opened` branch clears the spawning marker and escalates; the item stays `pending`.
  The escalation text should keep the recognizable phrase (e.g. "wt create --fetch failed, spawn
  stopped and the item stays pending: <wt message>") so `TestSpawnFetchFailureStopsTheSpawn`'s intent
  carries over (rename/adjust its assertion; it must also assert no `git fetch` and no
  `git rev-parse origin/` argv from the engine).
- **Ordering consequence — refs read before wt's fetch.** Today every ref read in `spawnItem` runs after
  the engine's fetch. After deletion, these run against the main checkout's last-fetched refs:
  - `defaultBranch` (`repo.go:68`, origin/HEAD verify): acceptable; its comment "It runs after a
    successful fetch" must be corrected.
  - `stackedBase`'s `rev-parse --verify -q refs/remotes/origin/<dep-branch>` (`spawn.go:316`): on a
    stale checkout a freshly pushed dependency would read "not on origin" and — since nothing in the
    engine fetches any more — **never** spawn. Resolution (assumption #11): on the **spawn** path, drop
    the pre-verify and let `wt create --base origin/<dep> --fetch` be the check (exit 2
    `Invalid --base ref` after its fetch) → escalation "dependency X: branch Y is not on origin (push it
    before stacking)"; the **respawn** path's call is unchanged (brief: respawn unchanged).
  - `ladderDeps`/`resolveRef` (`repo.go:187`) resolve `refs/heads/<dep>` first (engine-spawned
    dependencies live as local branches of the same repo) and fall back to `refs/remotes/origin/<dep>`.
    The cherry-pick itself (`prepareWorktree`, `origin/<base>..<dep-ref>`) runs inside Prepare, after
    wt's fetch, so it sees fresh refs. The brief's "the ladder cherry-pick keeps its
    `rev-parse --verify refs/remotes/origin/<dep>`" is honored — those reads stay.
- **Unchanged:** the stacked path's `fab status set-base-branch` (in `prepareWorktree`), respawn
  (`--checkout` / `ExistingWorktree`), readiness, the `base` entry validation (`ls-remote` in
  `queue.go:324`), dependency chaining, completion, `buildPrompt`.
- **Minimum version on the engine path:** the riff gate's error surfaces through `launchWithPolicy` as
  `spawn failed: <riff text>` — the same one-line fix text, as the brief requires; no engine-side
  probe.

### Tests

- **riff** (`internal/riff/riff_test.go`, `deliver_test.go`, `cmd/rk/riff_test.go`): every stub `wt`
  on PATH emits a receipt on stdout (and answers `--version` with `wt version v0.1.8`). New cases:
  receipt decode table (success with nullable fields, `ok:false` exit-3 document, exit-7 document with
  `result`, non-JSON stdout); `buildWtCreateArgs` table gains `--json` and `--fetch`-only-when-set (and
  never with `--checkout`); the no-upstream env applied only when the option is set; version gate (old
  version refuses with the `wt update` text, unparseable refuses, passing probe cached, failing probe
  re-probed); exit-7 keeps the worktree (no `wt delete` invoked) and reports its path. Delete
  `TestParseWorktreePath`.
- **engine** (`internal/autopilot/spawn_test.go`, `harness_test.go`, `spawning_test.go`): the harness's
  `fakeSpawner` builds real worktrees from `req.BaseRef` the way wt does (fetch, resolve the ref to a
  SHA, `worktree add -b <branch> <path> <sha>`, no upstream when no-upstream is requested) and returns
  receipt-shaped `Branch`/`BaseSHA`; spawn tests assert **no `git fetch` and no `git rev-parse origin/…`
  argv from the engine's runner**, `SpawnRequest.BaseRef == "origin/<b>"` per mode (default, item
  `base`, stacked dependency), and the attached item's `branch`/`base_sha` equal the receipt's. An
  exit-3 receipt (fetch failure) → escalation + `pending` + marker cleared; an exit-7 receipt →
  escalation naming the kept worktree + `pending`. `TestSpawnPinsFetchedOriginTip` (or its current
  name) becomes "the recorded base_sha is the fetched origin tip". A stacked dependent whose branch was
  pushed after the main checkout's last fetch still spawns (no stale pre-verify).
- Run through `just test-backend` (context.md: never `go test` directly).

### Docs

- `docs/memory/run-kit/rk-riff.md`: § Worktree-Name Passthrough / argv (now `--json`, optional
  `--fetch`), the receipt replacing `Path:` parsing, `Result` fields, the version gate, the exit-7
  report, the no-upstream option; test-coverage list (`TestParseWorktreePath` gone).
- `docs/memory/run-kit/operator-autopilot.md` § Spawn: "fetch-first SHA pin" becomes "`wt` fetches and
  pins; the receipt is the record"; the no-upstream mechanism; the stacked "not on origin" check now
  comes from wt. Design Decision **"The receipt is the spawn's record"** (four-field shape); the existing
  "Fetch-first SHA pin" decision is superseded/rewritten (its Rejected "a base ref instead of a SHA"
  no longer holds — the upstream concern is handled by `branch.autoSetupMerge=false`).
- Help text / `rk skill operator` / `rk help-dump` fixtures: only if a CLI surface changes (Rule 5).
  The CLI's flags do not change; if `rk riff`'s help mentions the wt requirement, add "≥ v0.1.8".

## Affected Memory

- `run-kit/rk-riff`: (modify) wt receipt replaces `Path:` parsing and the branch read; `--json`/`--fetch`
  argv; `Result.BaseRef/BaseSHA/Init`; minimum wt version gate; exit-7 kept-worktree report; no-upstream
  option.
- `run-kit/operator-autopilot`: (modify) § Spawn — wt fetches and pins, receipt is the record; engine
  fetch/rev-parse deleted; no-upstream invariant mechanism; stacked base check via wt exit 2; `base_sha`
  on the engine item; Design Decision "The receipt is the spawn's record" superseding "Fetch-first SHA
  pin".

## Impact

- **Code:** `app/backend/internal/riff/riff.go` (argv, `runWtCreate`, receipt decode, `Result`,
  `SpawnReceipt.Branch`, version gate, `windowCreated` hook), `app/backend/cmd/rk/riff.go`
  (precondition/version message on the CLI path), `app/backend/internal/autopilot/{spawn.go,
  riffspawn.go, autopilot.go, enginefile.go, repo.go}` (fetch/rev-parse deletion, `SpawnRequest`/
  `SpawnResult`, `attach`, `stackedBase` split, `defaultBranch` comment, `engineItem.BaseSHA`).
- **Tests:** `internal/riff/riff_test.go`, `deliver_test.go`, `cmd/rk/riff_test.go`,
  `internal/autopilot/{spawn_test.go, harness_test.go, spawning_test.go}` and any test whose stub `wt`
  prints `Path:`.
- **Dependency:** `wt` ≥ v0.1.8 on every box running `rk` (installed here: v0.1.8). R2 rolls the new
  `rk` out; a box with an older `wt` refuses spawns with the `wt update` fix instead of misbehaving.
- **API/UI:** none. `POST /api/riff` and the fork endpoint go through `riff.Spawn` — they inherit the
  receipt path and the version gate; response shapes unchanged. PR evidence: `No recording: internal
  CLI/engine behavior` (Rule 6) with the test validation listed.
- **Live daemons:** untouched until R2 (Rule 1).

## Open Questions

- Should `rk riff --json`'s CLI receipt also expose `base_ref`/`base_sha`/`init`? (Assumed no — not in
  the brief; T10 reads the base from `wt list --json`. Assumption #14.)
- Resolved at intake (user answers): upstream mechanism (#6), `--fetch` gating (#4), exit-7 behavior
  (#9), `base_sha` placement (#10).

## Non-goals

- T10's work: `brief_rules.md` / `rk skill operator` changes, `--temp`/`--pr` usage, reading the PR base
  from `wt list --json`.
- Any rewrite of the queue engine's spawn path beyond the brief's deletions (plan Non-goals), the pass
  lock, or the engine file beyond the one optional `base_sha` key; respawn behavior; readiness rules.
- A fallback to `Path:` parsing for older `wt`; an engine-side wt version probe.
- Installing a binary or restarting a daemon (Rule 1).
- **Review bar** (plan § Decisions, quoted for every review dispatch): must-fix = merges, pushes,
  deletes or spawns the wrong thing; loses or corrupts state; crashes the CLI; breaks a plan
  requirement. Should-fix = everything else.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is exactly the T9 Brief (riff receipt, engine fetch/rev-parse deletion, version gate, tests, two memory files); T10/R2 excluded | Plan Rule 2 and the user's instruction "implement only the T9 Brief" | S:95 R:85 A:95 D:95 |
| 2 | Certain | Review bar copied into non-goals and quoted in review dispatches; PR states `No recording: internal CLI/engine behavior` | Plan Rules 4 and 6 | S:95 R:90 A:95 D:95 |
| 3 | Certain | Receipt contract as verified against installed wt v0.1.8: one stdout JSON doc, `ok`/`result`/`error{code,message}`, nullable `branch/base_ref/base_sha`, exit-7 carries `result` | Verified by scratch-repo experiment and wt's `cli-surface.md` | S:90 R:85 A:95 D:90 |
| 4 | Certain | riff always passes `--json` but `--fetch` only when the spawn requests it (an explicit option the engine sets; hand `rk riff` fetches only when the user passes `--fetch` through `--`) | Asked — user chose "only when requested" over the literal "always"; reconciles T10's `-- --base origin/<b> --fetch` and keeps `--reuse` passthrough and offline hand riffs working | S:95 R:80 A:95 D:90 |
| 5 | Confident | Engine passes `--base origin/<def\|dep\|base>` + fetch; `SpawnRequest.BaseSHA` becomes a base ref | Brief states it directly | S:90 R:75 A:85 D:85 |
| 6 | Certain | Keep "no upstream on spawned branches" by running the engine's `wt create` with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=branch.autoSetupMerge GIT_CONFIG_VALUE_0=false` (riff option set only by RiffSpawner); hand riffs keep wt's default | Asked — user chose env autoSetupMerge=false over unset-in-Prepare or accepting upstream. Verified wt honors it; upstream to origin/main would break `/git-pr`'s `push -u` path and can push to main under `push.default=upstream` | S:95 R:75 A:95 D:90 |
| 7 | Confident | Version probe caches only a passing result; a failing probe re-runs on the next spawn | "Once per process" read literally would force a daemon restart after `wt update`; caching success satisfies the intent | S:55 R:85 A:75 D:65 |
| 8 | Tentative | Unparseable `wt --version` output refuses the spawn, showing the raw string <!-- assumed: strict refusal for unparseable/dev version strings --> | Brief: "No silent fallback"; a dev build is blocked, but strictness keeps one code path | S:40 R:85 A:55 D:45 |
| 9 | Certain | Exit 7 (`init: failed`): riff returns an ExitSubprocess error naming the kept worktree, `Result.WorktreePath`/`Init` populated, no rollback, no window; engine escalates and the item stays pending | Asked — user chose "fail, report, keep" over opening the window anyway; matches the brief's "existing exit-7 shape" | S:95 R:80 A:95 D:90 |
| 10 | Certain | Receipt `base_sha` is recorded on the engine item as a new optional `base_sha` key (tolerant read), not added to `status --json` | Asked — user chose "engine item only" over exposing it in status or not recording it | S:95 R:85 A:95 D:90 |
| 11 | Confident | Spawn-path `stackedBase` drops its pre-fetch `refs/remotes/origin/<dep>` verify; wt's post-fetch exit 2 (`Invalid --base ref`) becomes the "not on origin" escalation; respawn's verify unchanged | With the engine fetch deleted the pre-verify reads stale refs and would block a freshly pushed dependency forever; wt now checks it after its own fetch | S:55 R:75 A:75 D:60 |
| 12 | Confident | `defaultBranch` and `ladderDeps` ref reads stay as-is before wt's fetch (local `refs/heads/<dep>` first); cherry-pick runs in Prepare after the fetch | Brief keeps those reads; dependencies are local branches of the same repo; only the comment "runs after a successful fetch" changes | S:60 R:80 A:75 D:65 |
| 13 | Confident | Receipt `branch` replaces riff's `worktreeBranch` and the engine's `openedBranch` git read for new worktrees; respawn (checkout mode, no receipt) keeps its git read | Brief: receipt replaces the "branch copy"; checkout mode never runs `wt create` | S:70 R:80 A:80 D:70 |
| 14 | Confident | No new keys on the `rk riff --json` CLI receipt; its `branch` is sourced from the wt receipt | Brief lists only `Result` fields; avoids a CLI-surface change (Rule 5) | S:55 R:85 A:70 D:60 |

14 assumptions (7 certain, 6 confident, 1 tentative, 0 unresolved).
