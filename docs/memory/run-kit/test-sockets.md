---
type: memory
description: "Test-socket isolation: unified rk-test-<role>-<pid>-<ns> naming, the TestMain POST-sweep (e2e family excluded), rk mux reap (dry-run default, --force, --ephemeral), kill-paired socket-file removal, /api/servers listing every server, the RK_SERVER_ALLOWLIST bound, the e2e rk-test-e2e-<token>- family anchor (+ per-rig -w<i>- sub-families for the multi-rig lane) and its bare-anchor teardown refusal, the RK_CONFIG_DIR per-rig config root, the port-fallback rule, and the per-worktree e2e run lock."
---
# Test Sockets & Test Isolation

**Domain**: run-kit

## Unified Test-Socket Naming — `rk-test-<role>-<pid>-<ns>`

**Every** test tmux-socket name — Go *and* Playwright — follows one umbrella form (260530-cf3g-unify-test-socket-reaping):

```
rk-test-<role>-<pid>-<ns>
```

- `<role>` identifies the test family: `unit`, `relay`, `tmuxctl`, `daemon`, `e2e`, and the hyphenated e2e secondaries `e2e-<token>-multi`, `e2e-<token>-msb` (worktree token embedded — § E2E (Playwright) naming below). **A role MAY contain hyphens.**
- `<pid>` is the real OS PID of the test binary (`os.Getpid()` in Go, `process.pid` in Playwright).
- `<ns>` is a single **hyphen-free** uniqueness token (Go: `time.Now().UnixNano()`; Playwright: a `Date.now().toString().slice(-6)` suffix). It being hyphen-free is what makes `<pid>` unambiguously the **second-to-last** hyphen field regardless of how many hyphens the role has.

**Single shared naming helper**: Go tests build the name via `testSocketName(role string) string` → `fmt.Sprintf("rk-test-%s-%d-%d", role, os.Getpid(), time.Now().UnixNano())`. Because Go `_test.go` symbols are package-private, the helper is duplicated across the test-support files of each package that needs it (`internal/tmux/main_test.go`, `api/main_test.go`, and small local equivalents in `internal/tmuxctl`/`internal/daemon`); all seven Go naming sites route through it — no inline `fmt.Sprintf("rk-test-…")` socket literal remains (the only intentional exceptions are the helper definitions and `socketsweep_test.go`, which hand-builds live-vs-dead-PID sockets for the sparing test).

**E2E (Playwright) naming — per-worktree derived family**: the e2e socket identity derives from the worktree, not a fixed name. `scripts/e2e-env.sh` computes a hyphen-free **token** — lowercase alphanumerics from the checkout's basename (hyphens stripped), an all-digits token gaining a `wt` prefix, plus a 2-char `cksum` hash tail of the absolute toplevel path so two same-named checkouts diverge — and sets the **family anchor** `E2E_TMUX_FAMILY=rk-test-e2e-<token>-` (trailing hyphen included; the `rk-test-` umbrella is preserved) and the **primary** `E2E_TMUX_SERVER=rk-test-e2e-<token>-0`, created by `scripts/test-e2e.sh` (one primary per rig in the multi-rig lane — below), torn down by its family-anchored trap glob, and caught by the manual reaper's `rk-test` brute-force. Every family member carries a role segment after the token: secondary per-spec servers are `${TMUX_FAMILY}<role>-${process.pid}-${epoch}` (e.g. `rk-test-e2e-<token>-multi-48213-1717…`), so `parseTestSocketPID` still reads the PID from the second-to-last field, while the primary's `-0` tail keeps it un-PID-sweepable (the `wt` prefix guarantees an all-digits token never parses as one). **Multi-rig lane** (`RK_E2E_WORKERS=N`, N>1): the harness starts N complete rigs, one per Playwright worker, and every rig — rig 0 included — gets the socket **sub-family** `rk-test-e2e-<token>-w<i>-` with primary `…-w<i>-0`; the rig's `TMUX_FAMILY` IS the sub-family, so its secondaries land at `rk-test-e2e-<token>-w<i>-<role>-<pid>-<epoch>` with the PID still in the second-to-last field. Sub-families never prefix each other (`-w1-` is not a prefix of `-w10-`), which is what lets each rig's backend allowlist be exactly its own sub-family; the worktree anchor `rk-test-e2e-<token>-` still prefixes every sub-family, so the trap glob and `global-teardown.ts`'s prefix scan reap all rigs unchanged. The single-rig lane (the default) is the one-rig case with the anchor as the family. (6p65) Because tokens are hyphen-free, the anchor `rk-test-e2e-<tokenA>-` prefixes a `rk-test-e2e-<tokenB>-…` name only when the tokens are equal — cross-worktree family matching is impossible by construction under glob and `HasPrefix` semantics alike. The declaration sites are `scripts/e2e-env.sh` (derivation), `scripts/test-e2e.sh` + `scripts/pw.sh` (which pass `E2E_TMUX_SERVER`/`E2E_TMUX_FAMILY` into the Playwright env), and the spec tree's single env reads in `app/frontend/tests/e2e/_tmux.ts` (`TMUX_SERVER`/`TMUX_FAMILY`) and `global-teardown.ts` (see `architecture.md` § Playwright E2E Tests). A preset `E2E_TMUX_SERVER` with no preset family implies family = the server name AS-IS (no appended hyphen), so prefix matching admits the primary itself.

### A bare family anchor refuses the teardown sweep

Both family-anchored teardown sweeps **refuse to run**, printing a warning that names the refused anchor, when the resolved anchor is one of the bare defaults `rk-test-e2e` or `rk-test-e2e-`:

- `app/frontend/tests/e2e/global-teardown.ts` skips its socket-dir prefix scan (`family ?? server` is the resolved anchor) and reaps only the primary.
- `scripts/test-e2e.sh` `cleanup()` skips its `"/tmp/tmux-$(id -u)/${E2E_TMUX_FAMILY}"*` socket loop and instead kills the exact primary `$E2E_TMUX_SERVER` by name. The PGID and port cleanup still run — the refusal is scoped to the socket glob.

Both sites pair every kill with a best-effort removal of the killed server's exact socket file (see § Every Kill Site Removes the Socket File) — in the refused branch that removal is exact-name too, so the refusal never widens into a prefix hazard. `global-teardown.ts` skips the file removal when `process.getuid?.()` is unavailable (the file path cannot be derived; the shell trap's own paired rm covers it). The family-glob loop also visits family sockets whose servers are ALREADY dead (a dead socket file still passes `-S`): the kill fails best-effort and the rm then clears the residue — this is how secondaries a spec's `afterAll` killed mid-run lose their files at run end.

A token-less anchor is never a valid single-worktree family: it is a strict prefix of **every** derived family (`rk-test-e2e-<token>-…`), so a prefix scan or glob under it reaches sibling worktrees' in-flight servers. The anchor collapses to a bare default when `E2E_TMUX_SERVER` is preset to one with no preset family — `scripts/e2e-env.sh` then sets `E2E_TMUX_FAMILY` to the server name as-is. Killing the primary from the refused branch carries no cross-worktree hazard: it is an **exact name, not a prefix**, mirroring `global-teardown.ts` keeping the primary in its kill set unconditionally. Derived anchors are unaffected — their scan runs in full — and `_tmux.ts`'s own fallback default carries the bare value: the guard lives at the two sweep sites, not on the constant.

### E2E creation sites mark their servers `@rk_srv_ephemeral`

Both e2e creation sites set `@rk_srv_ephemeral 1` server-scoped at birth: `scripts/test-e2e.sh`'s `seed_tmux_server` marks each rig's primary server (`rk-test-e2e-<token>-0`, or `rk-test-e2e-<token>-w<i>-0` per rig in the multi-rig lane) immediately after its `new-session` creation, and the Playwright `_tmux.ts` `createSession` helper marks its target server after a successful create, inside its existing best-effort try block — one seam covering the primary and every `rk-test-e2e-<token>-<role>-<pid>-<epoch>` secondary the multi-server specs spin up (a repeated set is an idempotent no-op). The marking is belt-and-braces alongside the `rk-test-*` name umbrella: `IsTestServerName(name)` ⇒ treated-as-ephemeral already covers these names, so the option changes no behavior for them — it standardizes the creator-intent semantic for option-reading consumers (`rk mux reap --ephemeral`, the snapshotter's retire-on-mark); consumers read through `IsEphemeralServer`, which dual-reads the retired `@rk_ephemeral` name when the scope-named one is unset ([tmux-sessions](/run-kit/tmux-sessions.md) § Legacy Option Migration). Go test-scaffolding creation sites are deliberately NOT marked: creation there is ~50 heterogeneous raw `new-session` sites (only the *naming* is centralized, via `testSocketName`), and the PID-scoped `TestMain` post-sweep self-heals Go-test residue independently.

`scripts/test-e2e.sh` also marks the rig's servers `@rk_srv_managed` (rk's own substrate, so the WS-attach conf reload fires on first view) and pre-seeds the legacy, pre-scope-prefix names of the server-scope origin/session-order options plus the window-scope role/url/note options on the `e2e-init` window, so the once-per-daemon legacy-option migration sweep (`MigrateLegacyOptions`, `internal/tmux/legacy_options.go`) is exercised when specs attach. `app/frontend/tests/e2e/legacy-scope-sweep.spec.ts` seeds the same legacy names on a dedicated scratch server and asserts convergence: legacy names unset, scope-prefixed names set.

### PID parsing — second-to-last hyphen field

`parseTestSocketPID(name) (int, bool)` (one copy per sweeping package — the seven `main_test.go` files listed in § Automatic Test-Socket Sweep) extracts the PID from the **second-to-last** hyphen-delimited field — `strings.Split(name, "-")`, take element `len-2`, `strconv.Atoi`. It returns `ok=false` when the name lacks the `rk-test-` prefix, has fewer than 5 fields (`rk`, `test`, `<role>`, `<pid>`, `<ns>`), or the candidate field is non-numeric.

Parsing from the right (fixed `len-2` index) is what makes hyphenated roles work: `rk-test-e2e-sunnygazelleac-multi-48213-1717…` yields PID `48213` because the role (`e2e-sunnygazelleac-multi`) occupies the middle fields and never shifts the PID's position. A fixed *left* index (the field immediately after the prefix) would break the moment a role contained a hyphen.

`testPIDAlive(pid)` reports liveness via `syscall.Kill(pid, 0)` with a biased-alive interpretation — only a definitive `ESRCH` marks the PID dead; any other error (incl. `EPERM`) is treated as alive (leak-not-kill bias). A non-positive PID is treated as dead defensively.

### `IsTestServerName` — single-prefix identity check

"Is this a test artifact?" is the single exported check `tmux.IsTestServerName(name) bool` → `strings.HasPrefix(name, "rk-test-")` (`internal/tmux/tmux.go`); the `"rk-test-"` literal lives in exactly this one place.

`IsTestServerName` is **intentionally NOT applied** in `ListServers` nor in the `/api/servers` handler — internal consumers (`board.go` in particular) iterate every real tmux server, and `/api/servers` surfaces every server so the operator sees exactly what `rk mux reap` will reap. Its only consumer is the **tmuxctl supervisor's resurrection guard** (`isTmuxSocketCandidate` in `internal/tmuxctl/supervisor.go`): leaked `rk-test-*` sockets (including `rk-test-e2e-*`) are excluded from the control-mode candidate set so `resolveBootstrap`'s `new-session -s _rk-ctl` does not *resurrect* every orphan test socket on bootstrap. This is a **correctness guard, not UI noise reduction**, and stays in force regardless of `/api/servers` listing every server.

## Every Kill Site Removes the Socket File

tmux does not unlink the socket file of a killed (or crashed) server, so every rk-owned kill site pairs its `kill-server` with a best-effort removal of the exact file it just targeted; leaked files otherwise accumulate in `/tmp/tmux-<uid>/` and `/api/servers` probes every one of them per request (`ScanSocketDir` + a probe per socket — an observed ~350ms flat floor at ~2,700 stale files). The four sites:

| Kill site | Removal |
|-----------|---------|
| `scripts/test-e2e.sh` `cleanup()` (both branches) | `rm -f` of each globbed `$sock` / the refused branch's exact primary path |
| `app/frontend/tests/e2e/global-teardown.ts` | `rmSync(/tmp/tmux-<uid>/<name>, { force: true })` per killed socket; skipped when uid is unavailable |
| the seven `TestMain` post-sweeps | `os.Remove(filepath.Join(socketDir, name))` after the kill attempt (§ Automatic Test-Socket Sweep) |
| `rk mux reap`'s kill arm | post-kill `os.Remove`, `ENOENT`-tolerant (§ `rk mux reap`) |

Removal is everywhere best-effort (a leaked file is harmless residue; hygiene never fails a run) and everywhere scoped to exactly the file whose server the site just killed — the sweeps' sparing rules (live-PID, e2e family) and the teardowns' family anchoring apply to the file removal identically. The spec-level `_tmux.ts` `killServer` helper deliberately carries no removal: its secondaries' files are inside the family glob/prefix-scan, so the run-end sweeps clear them.

## Automatic Test-Socket Sweep — POST-sweep in `TestMain`

**Every tmux-spawning Go test package post-sweeps its own residue.** Seven packages carry the `TestMain` post-sweep, each in its own `main_test.go`: `internal/tmux`, `api`, `cmd/rk` (`package main`), `internal/daemon`, `internal/tmuxctl`, `internal/snapshot`, and `internal/remote`. `sweepDeadTestSockets()` runs *after* `m.Run()`, never before:

```go
func TestMain(m *testing.M) {
    code := m.Run()
    sweepDeadTestSockets()
    os.Exit(code)
}
```

There is no pre-sweep: the post-sweep means **each run reaps its OWN dead-PID residue** on the way out, so no package's sweep is load-bearing for another package's — or another worktree's — leftovers.

**The duplicated set** per package is `sweepDeadTestSockets` + `parseTestSocketPID` + `testPIDAlive` + the two consts `testSocketPrefix` / `testSocketE2EPrefix` (~78 lines, Go `_test.go` symbols being package-private). `testSocketName` is **not** in the set — the sweep never calls it, and `internal/daemon`/`internal/tmuxctl` already define it in their own test files, where a second definition would not compile.

**The `rk-test-e2e-` family is excluded** — the prefix check (`testSocketE2EPrefix`) runs **before** the PID parse in every copy. An e2e secondary (`rk-test-e2e-<token>-<role>-<pid>-<epoch>`) embeds the Playwright **worker** PID, and `playwright.config.ts` sets `retries: 1`, so a worker respawn leaves a still-in-use server owned by a dead PID that the PID rule alone would reap mid-run. The family's own teardown chain owns it: the `scripts/test-e2e.sh` EXIT trap, `global-teardown.ts`, and `rk mux reap` by hand.

**PID-scoped to dead owners only — never a blanket wipe.** Past the e2e skip, `sweepDeadTestSockets` enumerates `/tmp/tmux-<uid>/` and reaps — `kill-server`, then `os.Remove` of the socket file — a socket only when its embedded PID **parses** (`parseTestSocketPID`) **AND is dead** (`testPIDAlive` reports `ESRCH`) — or is this process's own PID, since the sweep runs while exiting. Live-PID sockets — which belong to a **concurrent `go test ./...` package running as a separate process** — are spared, kill and file alike, so packages running in parallel do not kill each other. Sockets without a parseable PID (no role/pid/ns shape) are left untouched. For a dead-PID socket the kill fails (server already gone) and the removal then clears the residue file — so each run also heals prior crashed runs' file residue, and residue surviving a parallel `go test ./...` (spared because its owner was still live at that sweep's exit) is cleared by the next run's sweep. Kills use `exec.CommandContext` + a 5s timeout and an argument slice (constitution I) — never a shell string. Best-effort: enumeration, kill, or removal failures are ignored (a leaked socket is harmless residue; never blocking tests is the priority).

`t.Cleanup(kill-server)` reaps each socket on the normal path; the post-sweep is the only automatic cleanup for **un-catchable SIGKILL / panic / OOM residue**. The manual `rk mux reap` is the by-hand janitor for cruft that has already accumulated on disk across runs.

### Injectable socket dir — the sweep test's private namespace

`internal/tmux` alone carries the seam: `sweepDeadTestSocketsIn(socketDir string)` holds the enumeration loop, and the `TestMain`-called wrapper `sweepDeadTestSockets()` supplies the hardcoded `/tmp/tmux-<uid>` default. The other six copies carry the single-function shape — the sweep test is the seam's only consumer.

`socketsweep_test.go` births its fixture servers in a private per-test directory and invokes `sweepDeadTestSocketsIn` against exactly that directory, so neither fixture creation nor the mid-run sweep ever touches the shared namespace sibling worktrees and concurrent packages share. `isolatedSocketDir(t)` creates the base dir with **`os.MkdirTemp("", "rk")` — deliberately not `t.TempDir()`** — sets `TMUX_TMPDIR` to it via `t.Setenv`, and returns the derived `<base>/tmux-<uid>` path tmux places `-L` sockets under. Both halves are load-bearing:

- **The short path**: a full socket path must fit `sockaddr_un`'s ~104-byte `sun_path`. `t.TempDir()` embeds the test's name in the directory, which alone overruns the limit once the `tmux-<uid>/<socket>` tail is appended — the failure surfaces as `File name too long`.
- **The env/seam pairing**: fixture creation and `tmuxSocketLive`'s kill/probe path resolve their socket through the **ambient** `TMUX_TMPDIR`, while the sweep resolves through the **injected** dir argument. The two must name the same directory or the test asserts against servers the sweep never saw.

`TestSweepDeadTestSockets_reapsOwnAndDeadSparesOtherLive` proves the three-way own/other-live/dead invariant — for the server kill AND the socket file (reaped sockets' files absent, spared ones present, asserted via `socketFileExists` before any liveness probe); `TestSweepDeadTestSockets_sparesE2EFamily` proves the family exclusion — a dead-PID `rk-test-e2e-fixture-*` socket survives (file included) while a sibling `rk-test-sweepspare-*` carrying the **same** dead PID is reaped, so the exclusion is scoped to the family rather than a blanket softening of the PID rule.

## `rk mux reap` — Brute-Force-by-Prefix Operator Cleanup

`rk mux reap` is an **operator-invoked** member of the `rk mux` family ([agent-messaging](/run-kit/agent-messaging.md)), built by the `newReapCmd(use, deprecated)` two-instance constructor and registered on `muxCmd` (260529-fww2-rk-reaper-command). `reapAliasCmd` is a **hidden deprecation alias** `rk reaper` at the root that prints cobra's `Deprecated` pointer to stderr and runs byte-identically (a human-typed verb, so the alias is removable in a future release — unlike the permanent `agent-hook` contract). Neither form is wired into any startup path. The command body (`cmd/rk/reaper.go`) is thin — flag parsing + summary rendering; all scan/classify/reap logic lives in `internal/tmux/reaper.go` (constitution §III). The family member rejects an explicitly-set inherited `-L/--server` with a usage error (exit 2); the root alias carries no `-L` flag.

### No relay startup sweep

There is no relay startup sweep. Relay ephemerals do not exist (the relay attaches directly), and board pin-sessions (`_rk-pin-*`) are PERSISTENT across rk restarts (a valid state, not an orphan), so there is no in-server session class to reap at startup. The reaper is the operator-only janitor for **whole test servers and dead/stale sockets/`.lock` files** — different scope, different trigger. (260602-qn62-move-based-board-pin-sessions)

### Brute-force-by-prefix — no liveness probe to match

The reaper's default match is **purely by name prefix** — no PID parse, no name-shape reasoning, no e2e exclusion, no `.lock`-inherits-base-server logic; `--ephemeral` adds a second, option-based match dimension (see § `--ephemeral` below). The absent e2e exclusion is the deliberate **inverse** of the automatic post-sweep's: the Go sweep skips the `rk-test-e2e-` family precisely because that family's own teardown chain owns it, and this operator janitor is the last link in that chain — the by-hand cleaner for crashed e2e residue no trap or teardown hook reached. It iterates **RAW** socket-dir candidates via `ScanSocketDir(ctx)` (NOT `ListServers`, which probes dead sockets away) and classifies each:

- **Bare `rk mux reap`** ≡ `rk mux reap --prefix rk-test` — matches every `rk-test*` socket, `.lock` file, and live server.
- **`rk mux reap --prefix <p>`** applies identical behavior to `<p>*`.
- A matched **live server** → `KillServer` (`ReapActionKill`), and after a **successful** kill the socket file is removed too (`ENOENT`-tolerant — a tmux build that unlinks on exit is fine; the file is implied by the `Killed` entry and never double-reported in `RemovedSockets`; a failed kill leaves the file untouched since the server may still be live, and a non-`ENOENT` removal failure joins the partial-failure aggregate without unwinding the kill). A matched **socket** (dead) or **`.lock` file** → `os.Remove` (`ReapActionRemove`).

The only thing requiring the outside world is the live-vs-dead distinction for a matched, non-`.lock` candidate. `classifyReap(name, prefix, ephemeral, protected, serverLive)` is a **pure function** (`internal/tmux/reaper.go`) — `serverLive` and the `ephemeral`/`protected` membership sets are supplied by the caller (`reapCandidates`, which calls `probeServerAlive` only when `probeNeeded` says the kill-vs-remove decision depends on it). `ReapAction` is the exported enum (`ReapActionSkip`/`Kill`/`Remove`); the full matrix is unit-testable via `TestClassifyReap` without spawning servers.

### `--ephemeral` — union with the live option dimension

`rk mux reap --ephemeral` matches the **union** of the prefix match (unchanged; bare invocation still defaults to `--prefix rk-test`) and every **live** server carrying the ephemeral mark (`@rk_srv_ephemeral`, dual-read with the retired `@rk_ephemeral`). The mark sets are caller-computed: `enumerateMarkedServers(ctx, ephemeralEnabled)` enumerates live servers via `ListServers` (liveness-probed — a tmux command on a dead socket resurrects a server, so dead sockets are never queried and stay prefix-only territory), queries `IsEphemeralServer`/`IsProtectedServer` per live server (skipping `_rk-ctl`/`rk-daemon` before the query; a per-server read failure logs and simply does not match), and returns BOTH sets — the ephemeral set is nil when the dimension is disabled, the protected set is ALWAYS enumerated (the skip it feeds is unconditional). The resulting name-sets are threaded into `reapCandidates` as data so `classifyReap`/`probeNeeded` stay pure. Ephemeral matches are live servers, so they classify as kill. The dangerous-prefix guard applies to the prefix dimension only — option matches are explicit creator opt-in and need no length guard. Without the flag the ephemeral dimension is disabled entirely and behavior is byte-identical to the prefix-only sweep. Safety framing (stated in the command's `Long` help): the option is explicit opt-in set by the creator, making this sweep safer than prefix guessing — and it gives agents a sanctioned bulk-cleanup verb so they stop reaching for raw `tmux kill-server`.

### Hard-skips (never reaped, even under `--prefix` + `--force`)

- **`_rk-ctl` control anchor** (`ControlAnchorSessionName`) — owned by `tmuxctl`.
- **Live `rk-daemon` production server** (named const `productionDaemonServer = "rk-daemon"`, a local literal to avoid an `internal/daemon` import edge).
- **Live `@rk_srv_protected` servers** — skipped unconditionally: under `--ephemeral`, under any prefix match, always; protected beats ephemeral when one server carries both marks.

The name-skips are short-circuited before the prefix/ephemeral check in *both* `classifyReap` and `probeNeeded`, so a broad or mistyped `--prefix rk` — or a hypothetical `@rk_srv_ephemeral` mark on one of them — can never take down production — the dry-run default alone is not sufficient protection for the daemon. The protected skip is live-only and checked in the same lock-step: a LIVE protected server yields `ReapActionSkip` before the prefix/ephemeral checks in both functions, and `probeNeeded` still probes a protected-marked candidate because the option dies with its server — the DEAD socket file of a formerly-protected server is inert and stays removable.

### Dry-run is the DEFAULT; `--yes`/`--force` to act

Invoking `rk mux reap` (bare or `--prefix`) with no action flag **prints the match list** with each entry's classified action (`kill`/`remove`) and **touches nothing**. The action gate is `act := (yes || force) && !dryRun` (per-instance closure-bound flag vars):

- `--yes` (or `--force`) → actually reap.
- `--dry-run` is an **explicit alias** for the default preview and always wins (forces preview even if `--yes`/`--force` were also passed).
- `--force` is the **ONLY** flag that bypasses the dangerous-prefix guard. `--yes` acts but does NOT bypass the guard, so an operator who only confirms is still protected from a typo'd short prefix.

**Dangerous-prefix guard** (`ReapTestServers`): an empty prefix or one of length ≤ 3 (e.g. `rk-`) matches nearly everything (`runkit`, `runWork`, production) and is **refused** unless `--force`. The guard refuses regardless of `act`, so even a dry-run with a dangerous prefix reports the refusal rather than previewing a near-everything match. The guard applies to the **prefix dimension only** — `--ephemeral` matches are explicit creator opt-in and need no length guard.

### Operating contract — do NOT run while tests are running

Because the manual reaper has **no live-run protection by design** (no name allowlist, no PID gate), the operating contract is: **do not run `rk mux reap` (bare or `--prefix`) while tests are running** — it will kill their live tmux servers. The automatic post-sweep's PID-scoping protects concurrent `go test` packages; the manual tool relies on the human. This contract is stated in the command's `Long` help text and here.

### I/O routine, test seam, and partial-failure contract

`ReapTestServers(ctx, prefix, act, force, ephemeralOnly) (ReapResult, error)` is the public entry point: it applies the dangerous-prefix guard, scans via `ScanSocketDir`, computes the mark sets via `enumerateMarkedServers(ctx, ephemeralOnly)` (ephemeral nil when the dimension is disabled; protected always enumerated), then delegates per-candidate work to the internal seam `reapCandidates(ctx, dir, prefix, candidates, ephemeral, protected, probe, act)` — passing `socketDirPath()` and `probeServerAlive`. Tests drive `reapCandidates` directly with a temp dir + fake prober + fake ephemeral/protected sets (no real tmux server spawned). `ReapResult` carries `Killed []string`, `RemovedSockets []string`, and `DryRunPlan []ReapPlanEntry` (`{Name, Action}` pairs, populated only on a dry-run).

**Partial failure**: each kill/remove failure is logged via `slog.Warn` and skipped; iteration continues; a joined aggregate error (`reaper partial failures: …`) is returned at the end (nil when all succeed). The command renders the summary *before* surfacing the aggregate error, so the operator sees what was reaped even on partial failure.

## `/api/servers` Lists Every Server — No Test-Socket Hide

There is no `/api/servers` test-socket hide filter (260530-cf3g-unify-test-socket-reaping). `handleServersList` (`api/servers.go`) returns the output of `tmux.ListServers` directly, so the response includes **every** tmux server discovered — including leaked `rk-test-*` orphans. The reaper is the **sole** mechanism that keeps this list clean. Listing costs one liveness probe per socket candidate: a probe that times out is retried once, and a second timeout KEEPS the name (live-but-busy stays listed — only fast-refusing dead sockets drop; see [tmux-sessions](/run-kit/tmux-sessions.md) § Server Discovery), so a test server under load never flickers out of the dev UI.

**Accepted consequence**: after a crashed test run, the dev UI lists the orphans **and opens an SSE stream per orphan server** until the operator runs `rk mux reap`. This is intended ("surface everything") — the user sees exactly the pile the reaper will reap. The `servers_test.go` fixture asserts that ALL servers (including `rk-test-*` / `rk-test-e2e-*`) are returned (`TestHandleServersList_ReturnsAllServersIncludingTestSockets`).

## `RK_SERVER_ALLOWLIST` — Env-Gated Test-Isolation Filter in `ListServers`

`ListServers` applies an **env-gated allowlist filter** read from `RK_SERVER_ALLOWLIST` (const `tmux.ServerAllowlistEnv`, `internal/tmux/tmux.go`) (260531-tmnm-test-scoped-server-enumeration). The env var is read **in-package** via `os.Getenv` — matching the `RK_TMUX_CONF`/`OriginalTMUX` precedent — **NOT** threaded through `internal/config` (`ListServers` is a `ctx`-only free function and `internal/tmux` has no `config` dependency to carry it).

- **Unset / whitespace-only (production default)**: the filter is a no-op — `ListServers` returns all live servers. The `/api/servers` "surface every server" contract (see § above) and the `IsTestServerName` design intent are preserved exactly. An empty value is treated as unset, so a blank env never means "match nothing".
- **Set (test only)**: the post-probe live-server list is narrowed to names admitted by `matchesServerAllowlist(name, allowlist)` — a pure, table-tested predicate (`TestMatchesServerAllowlist`, no live tmux server needed). The allowlist is a **comma-separated list of prefixes**; each token is trimmed, empty tokens skipped, and a name matches when it `strings.HasPrefix` ANY token (exact match = prefix-of-itself).

**Why prefix, not exact**: multi-server e2e specs create secondaries in `beforeAll` named `rk-test-e2e-<token>-<role>-<pid>-<epoch>` (e.g. `rk-test-e2e-<token>-multi-*`, `…-scope-*`, `…-msb-*`). Exact match on the primary (`rk-test-e2e-<token>-0`) would wrongly exclude them and break those specs; the harness therefore exports the rig's family — the **family anchor** `rk-test-e2e-<token>-` in the single-rig lane, the per-rig **sub-family** `rk-test-e2e-<token>-w<i>-` in the multi-rig lane, trailing hyphen included — as the allowlist, admitting the rig's primary plus its this-run secondaries. Because the token is hyphen-free, the anchor prefixes a sibling worktree's family only when the tokens are equal, so the prefix match can never bleed across worktrees; and the anchor still excludes the broader `rk-test-` umbrella — a `rk-test-relay-*` Go-test server is NOT admitted.

**Why the filter lives in `ListServers`, not the `/api/servers` handler**: the board route attaches servers from **two** distinct `ListServers`-rooted paths — (1) `GET /api/servers` (`api/servers.go`) populating `useSessionContext().servers`, and (2) the internal `board.go` board-entry enumeration (`ListBoards` / `GetBoard`, which iterate `ListServers` per-server) (260602-qn62). Filtering only the HTTP handler would leave path (2) unscoped, so the SSE inflation persists. Placing it in `ListServers` means **all** enumeration consumers inherit the scope when the env is set: `/api/servers` and `board.go`. This is the intended outcome in the test environment (the only environment that sets the var).

**Why it matters**: on the board route the frontend attaches **all** known servers (boards are cross-server by design). All N per-server subscriptions ride ONE state-socket WebSocket that holds no HTTP/1.1 pool slot (260716-qf3j-state-socket), so scoping the backend READ path to the worktree's e2e family does not relieve connection-pool pressure; the allowlist's value is that it **bounds which servers a test backend enumerates**, one subscription per test server rather than one per live `kit`/`runWork`/orphan server on a busy operator box.

### Allowlist vs `IsTestServerName` denylist — opposite directions

These two mechanisms point in **opposite directions** and coexist without conflict:

| Mechanism | Question | Hides | Used by |
|-----------|----------|-------|---------|
| `RK_SERVER_ALLOWLIST` (forward allowlist) | "Is this a server THIS test run may see?" | **normal** servers from tests | `ListServers` (env-gated) |
| `IsTestServerName` (`HasPrefix "rk-test-"`, denylist) | "Is this a test server?" | **test** servers from normal operation | tmuxctl supervisor resurrection guard only |

The `tmuxctl` supervisor's **enumeration** is **unaffected**: it does NOT call `ListServers` — it enumerates the socket dir via `os.ReadDir` + `isTmuxSocketCandidate` (`supervisor.go`), so its resurrection guard is independent of the allowlist. Its **dial path does consult the allowlist**: the `productionDial` `@rk_srv_origin` stamp is gated on the exported `tmux.ServerAllowed(name)` predicate (the same `matchesServerAllowlist` semantics `ListServers` applies, exported so "which servers do I stamp" is the same question as "which servers does this deployment cover" — otherwise the e2e backend's supervisor, which dials the host's sockets, would overwrite host servers' origins with its own e2e origin).

### Harness wiring — backend READ path vs WRITE socket

`scripts/test-e2e.sh` exports `RK_SERVER_ALLOWLIST` into every **backend** process it launches, set to exactly that rig's family: the `E2E_TMUX_FAMILY` anchor (`rk-test-e2e-<token>-`) on the single-rig `bash -c "… exec just dev"` launch, the per-rig sub-family `rk-test-e2e-<token>-w<i>-` on each per-rig backend launch in the multi-rig lane — so the backend's `ListServers` read path is scoped to its own rig's servers for the run, and no rig ever enumerates a sibling rig's sessions (the isolation that makes one rig per Playwright worker correct; the anchor alone would admit every rig). This is distinct from `E2E_TMUX_SERVER`, which scopes the **socket the tests WRITE to** (a shell/TS-only variable Go never reads). A dedicated `RK_*` name is honest about allowlist intent and matches the env-var convention rather than repurposing the socket-naming variable for Go config.

### Port-fallback rule — Playwright reads `E2E_PORT` through one helper, never the ambient `RK_PORT`

The Playwright-side base-port read lives in exactly one helper, `app/frontend/tests/e2e/_harness.ts`: `harnessPort()` returns the harness-set `E2E_PORT` (read lazily at call time, so `playwright.config.ts`'s `applyWorkerRig()`-first ordering contract holds) and otherwise falls back to the port policy's `PORTPOLICY_SENTINEL` (21999) parsed from `app/backend/internal/portpolicy/ports.env`; `harnessOrigin()` is the `http://localhost:<port>` form. Every consumer resolves through it: `playwright.config.ts` (baseURL + webServer port, called after `applyWorkerRig()`), the spec/helper sites that build raw origins (`_boards.ts` `apiBase()`, `_gui.ts` `RIG_ORIGIN`, `session-reorder`, `echo-latency`, `touch-focus-gate`, `mobile-touch-scroll`), and the desktop lane's `_shell.ts` by relative import. `E2E_PORT` is set **only** by the harness (`scripts/test-e2e.sh` `run_playwright` and `scripts/pw.sh` pass it into the Playwright env alongside the `RK_PORT` they still export for non-Playwright child-env readers), so a bare `playwright test` genuinely lands on the connect-to-nothing sentinel — fail-closed even on a box where direnv exports `RK_PORT` into every shell. The backend keeps reading `RK_PORT` unchanged; only the spec-side read is `E2E_PORT`.

The other two fixed-port hazards in the spec tree derive through `app/frontend/tests/e2e/_ports.ts`: `reserveDeadPort()` (bind `127.0.0.1:0` → read → close → return `{port, url}`) supplies the dead web-tab URL specs stamp — resolved once per file in `beforeAll` and fed to both the stamped URL and `stubProxyPorts` so the stub and the stamp can never desync — and `startCodeStub(html)` binds the harness-seeded `RK_CODE_SERVER_PORT` (validated) or an ephemeral port-0 fallback when unset, so concurrent bare runs never collide on the stub bind (see `architecture.md` § Playwright E2E Tests for the helper inventory).

## Per-Run Config-Root Isolation — `RK_CONFIG_DIR`

The isolation posture's config leg: alongside the derived port triple, the per-worktree socket family, and the per-run temp `XDG_STATE_HOME`, `scripts/test-e2e.sh` isolates the settings file too. `make_state_home` lays out each rig's state home — `config/` for the settings file, plus a `data/` home carrying the code-bridge extension fixture manifest — under the per-run `mktemp -d` (removed by the EXIT trap): the single-rig lane uses the run root itself, the multi-rig lane gives rig *i* `$E2E_STATE_HOME/rig<i>`. The harness exports `RK_CONFIG_DIR` (the rig's `config/`) into the backend launch(es) and the `run_playwright` env, so backend and specs agree on the same per-run `config.yaml`; in the multi-rig lane the Playwright-side value describes rig 0 and `_rig.ts` re-points it (with `XDG_STATE_HOME`) at the worker's own row of the `E2E_RIGS` rig table. The backend honors it in `settings.Dir()` — the env-gated override recorded in [configuration](/run-kit/configuration.md) § Config Root (verbatim root when set, byte-identical production when unset/whitespace-only, legacy `~/.rk` touchpoints suppressed) — so parallel `just test-e2e` runs mutating `instance_name`/`board_order` through the live API each write only their own per-run file — never the developer's real `~/.config/hexokit/config.yaml`, never a sibling worktree's run.

Spec side, the config-touching specs (`settings-dialog.spec.ts`, `board-list-reorder.spec.ts`) read `SETTINGS_PATH` from the shared `app/frontend/tests/e2e/_settings.ts` helper, which mirrors `settings.Dir()` exactly — including the whitespace-only-means-unset rule, so an exported-but-blank `RK_CONFIG_DIR` can never make spec and backend disagree on the file. Their `beforeAll`/`afterAll` snapshot/restore pattern is deliberately KEPT: the interactive `just pw` lane runs against a `just dev` rig that sets no `RK_CONFIG_DIR`, so `SETTINGS_PATH` is then the developer's real config and the snapshot still protects it; under the harness the same pattern is a harmless no-op on the temp file. `pwa-assets.spec.ts` needs no path awareness (tint-agnostic by design). (y60c)


## Design Decisions

### Whoever kills a server removes its socket file
**Decision**: Socket-file removal rides each existing kill site (the two e2e teardowns, the seven TestMain sweeps, the reaper's kill arm) rather than a new cleanup pass, daemon sweep, or listing filter.
**Why**: tmux does not unlink a killed server's socket; the kill site is the one place that knows exactly which file its dead server owned, so removal there is precisely scoped by construction — the sparing rules each site already enforces apply to the file identically.
**Rejected**: resurrecting the `/api/servers` hide filter (deliberately deleted — the list must show what reap will reap); a periodic daemon sweep (new rk-side behavior for what is tmux's own artifact — Constitution II posture).
*Introduced by*: 260904-f6h4-test-socket-file-hygiene

### Never `kill 0` from a non-detached shell script
**Decision**: Launch the subtree you intend to tear down into its **own** process group — `set -m` job control (`bash -c "… exec <cmd>" &`, portable: macOS has no `setsid`) makes the background job a group leader, so `PGID=$!` — then **verify via `ps` that the child's real PGID is not the script's own** (abort on match — a silent job-control failure would re-arm the grenade), and kill **only** that group by negative PGID: `kill -- "-$PGID"`. Guard with `[ -n "$PGID" ]` so a trap firing before launch is a no-op.
**Why**: A script that runs inline (sourced into an interactive shell or spawned by an agent) shares the **caller's** process group, so `kill 0` / `kill -- -$$` SIGTERMs the caller's unrelated processes — including live tmux servers and `-CC` control clients. Root cause of a 16-server death burst with zero `audit=kill-server` lines; constitution VI.
**Rejected**: `kill 0` / `kill -- -$$` from the script's own (shared) process group.
*Introduced by*: 260530-cf3g-unify-test-socket-reaping

### Embedded-PID naming: PID = second-to-last hyphen field
**Decision**: When a name encodes `<prefix>-<role>-<pid>-<ns>` and `<role>` may itself contain hyphens (e.g. `e2e-multi`), parse the PID from the **right** (`strings.Split(name, "-")`, element `len-2`) and keep `<ns>` a single hyphen-free token.
**Why**: This decouples PID extraction from the role's segment count.
**Rejected**: A fixed left index — it breaks the moment a role gains a hyphen.
*Introduced by*: 260530-cf3g-unify-test-socket-reaping

### Manual cleanup tools default to dry-run; only `--force` bypasses safety guards
**Decision**: A brute-force-by-prefix janitor (`rk mux reap`) is intentionally not PID-gated — the operator asserts nothing live needs the matched artifacts. The safety budget is: dry-run-default preview, unconditional hard-skips for production-critical names (`_rk-ctl`, `rk-daemon`), a dangerous-prefix guard (empty/≤3 chars), and a documented operating contract ("don't run while tests run"). `--yes` (confirm) and `--force` (bypass guard) are **separate** flags.
**Why**: Confirming an action does not waive typo protection.
*Introduced by*: 260530-cf3g-unify-test-socket-reaping

### Test isolation via an env-gated allowlist at the enumeration root, not the HTTP handler
**Decision**: When a behavior fans out to multiple backend paths (here: the board route reaches `ListServers` via both `/api/servers` and internal `board.go` enumeration), scope it at the shared **root function** (`ListServers`), not at one consumer (`handleServersList`). Gate the filter behind an env var read **in-package** so production (env UNSET) is a byte-for-byte no-op and only the test harness narrows the list. Extract the match logic as a pure predicate (`matchesServerAllowlist`).
**Why**: A handler-only filter leaves sibling paths unscoped. The in-package read matches the package's existing `os.Getenv` precedent — no new cross-package import for one scoping value. A pure predicate is table-testable without live tmux servers.
**Rejected**: Filtering only in `handleServersList` — leaves the `board.go` enumeration path unscoped.
*Introduced by*: 260531-tmnm-test-scoped-server-enumeration

### A forward allowlist and a reverse denylist can coexist — keep them distinct
**Decision**: Hiding *normal* servers *from tests* (`RK_SERVER_ALLOWLIST`) and hiding *test* servers *from normal operation* (the `IsTestServerName` resurrection guard) are separate mechanisms; when opposite-direction scoping is needed, add a new mechanism rather than flipping the existing one.
**Why**: They are not interchangeable: the e2e family (`rk-test-e2e-<token>-*`) is matched by `IsTestServerName`, so a `!IsTestServerName` denylist would hide the very servers the tests need.
**Rejected**: Repurposing `IsTestServerName` as a `!IsTestServerName` denylist for test scoping.
*Introduced by*: 260531-tmnm-test-scoped-server-enumeration

### Keep the test-server allowlist on bounded enumeration, not pool relief
**Decision**: `RK_SERVER_ALLOWLIST` stays in force purely as a bound on how many tmux servers a test backend enumerates; connection-pool pressure is not part of its justification.
**Why**: Every enumerated server costs a subscription, so an unscoped test backend on a busy operator box subscribes to every live `kit`/`runWork`/orphan server as well as the test ones. Pool relief is not the lever — all per-server subscriptions ride ONE pool-free state socket (260716-qf3j-state-socket). The related pool-starvation failure mode is recorded in `e2e-flakiness-board-route-dynamic-import-hang`.
*Introduced by*: 260531-tmnm-test-scoped-server-enumeration

### Keep the `rk-test-` umbrella in the e2e family anchor
**Decision**: The e2e socket family anchor is `rk-test-e2e-<token>-` (primary `rk-test-e2e-<token>-0`), keeping the `rk-test-` umbrella rather than shortening to `rk-e2e-<token>-`.
**Why**: The `rk-test-` prefix is load-bearing in three shipped contracts: `IsTestServerName` (`HasPrefix "rk-test-"`) drives the tmuxctl supervisor's resurrection guard (stops daemon bootstrap resurrecting leaked test sockets), bare `rk mux reap` defaults to `--prefix rk-test`, and the name umbrella is the documented treated-as-ephemeral belt. Shedding it would silently exit all three. Every nesting-proof property survives the longer spelling: the token is hyphen-free, so `rk-test-e2e-<tokenA>-` prefixes `rk-test-e2e-<tokenB>-…` only when the tokens are equal.
**Rejected**: the `rk-e2e-<token>-` shorthand — it carries no rationale for shedding `rk-test-`, and shedding it regresses the resurrection guard and reap coverage.
*Introduced by*: 260822-pz2e-per-worktree-e2e-isolation

### `E2E_TMUX_FAMILY` as a first-class exported env var
**Decision**: The derivation helper (`scripts/e2e-env.sh`) exports both the anchor (`E2E_TMUX_FAMILY`, trailing hyphen included) and the primary (`E2E_TMUX_SERVER = family + "0"`); the trap glob, `RK_SERVER_ALLOWLIST`, `global-teardown.ts`, and spec secondary names all consume the family.
**Why**: With a role segment on the primary (`-0`), the primary's own name is not the family prefix — globbing `${E2E_TMUX_SERVER}*` would match only `…-0*` and leak secondaries. A dedicated anchor variable keeps every matcher on the same string instead of four sites re-deriving "strip the trailing role".
**Rejected**: deriving the family in each consumer by string-stripping the primary's `-0` tail — four fragile copies of the same slice, and a preset `E2E_TMUX_SERVER` override would strip a character that isn't a role segment.
*Introduced by*: 260822-pz2e-per-worktree-e2e-isolation

### Spec-side port reads use a dedicated harness-only variable
**Decision**: Playwright and its helpers read the base port from `E2E_PORT` through the single `_harness.ts` helper (harness-set value, else the port policy's fail-closed sentinel — 21999 from `ports.env`), never from `RK_PORT`; the harness scripts pass both, and the backend/dev rig keeps `RK_PORT` unchanged (single-helper ownership + sentinel value: 260925-40fa-machine-ports-policy). Dead-URL and code-stub ports derive at run time (`_ports.ts`: reserve-then-release ephemeral bind; env-or-port-0 stub bind) instead of fixed literals.
**Why**: A fail-closed fallback keyed on `RK_PORT` is a no-op on any direnv-configured box (direnv exports `RK_PORT=3000` into every shell), silently pointing a bare `playwright test` at the live dev server; fixed `:8080`/`3939` literals let any port occupant flip assertions or collide concurrent runs.
**Rejected**: Unsetting/ignoring `RK_PORT` inside Playwright — fights the ambient env instead of sidestepping it, and breaks the "RK_PORT stays for anything else that reads it" contract; a reserved derived dead port (e.g. `E2E_PORT+3`) — triple→quad bookkeeping for a URL that only needs to be dead.
*Introduced by*: 260903-u1b8-e2e-fixed-port-hardening

### Per-worktree exclusive lock precedes the stale-kill
**Decision**: `scripts/test-e2e.sh` takes an exclusive `flock` on `/tmp/rk-e2e-wt-<uid>-<E2E_TOKEN>.lock` before anything touches the derived triple or socket family and holds it to process exit; a second run in the same worktree waits (one stderr line, `flock -w 1800`, then an error naming the file) and never kills the first. Every long-lived child (tmux primary, detached dev server, Playwright) is launched with the lock fd closed.
**Why**: The stale-kill reclaims "this worktree's own leftover"; without a lock a concurrent sibling run in the same worktree IS that leftover — the second run kills the first's dev server and both fight over one rig (observed as hundreds of spurious failures within minutes). The `RK_E2E_SLOTS` semaphore cannot prevent it: it is a per-user load knob, N>1 by design, taken after the destructive step. `flock(2)` releases when the last descriptor closes, so a crashed or SIGKILLed run leaves no stale lock — but only if no daemonizing child inherits the fd (verified: a tmux server and a detached `bash -c … &` both keep the lock held after the harness exits).
**Rejected**: A PID file (stale after a crash); making the slot semaphore per-worktree (wrong knob, wrong position); auto-killing the older run (it may be the user's); locking `just dev` (interactive lane — a non-blocking warning suffices); relying on `FD_CLOEXEC` (bash does not set it on `exec {fd}` opens); a cleanup-time `flock -u` (cleanup does not run on SIGKILL and the lock must cover teardown).
*Introduced by*: 260913-osy0-e2e-per-worktree-lock

### Step-forward port fallback only on an unkillable foreign owner
**Decision**: `scripts/e2e-env.sh` derivation is pure (no port probing, no mutation). `scripts/test-e2e.sh` first kills listeners on the derived port triple (self-claim — they are this worktree's by construction, and the kill runs only under the per-worktree run lock, so the leftover can never be a live sibling run); only when a port is STILL busy after the kill does it step the triple forward by 3 within the rig block (21000–21299, from the port policy file `ports.env` that `e2e-env.sh` sources) (bounded), with a printed notice that `just pw` then needs an explicit `RK_E2E_PORT`.
**Why**: Probing inside the derivation would make `just pw` non-deterministic (it could derive past a rig the harness just started). Killing first preserves the "claim from your own leftover `just dev`" semantic; stepping is reserved for the genuinely-foreign case (a hash collision with another user's process).
**Rejected**: probe-and-step inside `e2e-env.sh` (breaks the deterministic-rediscovery property `just pw` depends on); treating any listener as foreign (would never reclaim your own leftover rig).
*Introduced by*: 260822-pz2e-per-worktree-e2e-isolation

### Ephemeral set as caller-computed data into a pure classifier
**Decision**: `ReapTestServers` enumerates live servers and queries `IsEphemeralServer` per live server; `reapCandidates`/`classifyReap` receive the resulting name-set as data.
**Why**: Preserves `classifyReap`'s documented purity (the full matrix stays unit-testable with no tmux); dead sockets are never queried (a tmux command on a dead socket resurrects a server); the existing temp-dir + fake-prober seam tests extend naturally with a fake ephemeral set.
**Rejected**: Querying the option inside `classifyReap`/`reapCandidates` per candidate — breaks purity and probes dead sockets.
*Introduced by*: 260821-zelc-ephemeral-option-snapshot-reap

### One Playwright marking seam, not per-spec marking
**Decision**: the e2e `@rk_srv_ephemeral` option-set lives inside `_tmux.ts` `createSession` (server-scoped, idempotent, best-effort), not in each spec's `beforeAll`.
**Why**: every secondary-server spec already routes through `createSession`; one seam future-proofs new specs with zero per-spec ceremony — the same rationale that centralized the lifecycle helpers.
**Rejected**: a separate `createServer` helper (nothing else distinguishes server-create from session-create in the specs — `createSession` with `opts.server` IS the server-create path).
*Introduced by*: 260821-hbmh-ephemeral-creation-adoption

### E2E exclusion by family prefix, not per-worktree token matching
**Decision**: `sweepDeadTestSockets` skips the whole `rk-test-e2e-` family by prefix, checked before the PID parse.
**Why**: The e2e family has its own owners-and-teardown chain (`test-e2e.sh` trap glob, `global-teardown.ts` prefix scan, `rk mux reap` by hand); Go tests never need to janitor it, and prefix exclusion closes the worker-PID-respawn hole completely — a respawned Playwright worker leaves a live server whose embedded PID is dead, which no PID-based rule can distinguish from residue.
**Rejected**: Per-worktree token matching — more moving parts for no added safety; the Go sweep would need the worktree token, which it has no reason to know.
*Introduced by*: 260903-np2w-test-socket-sweep-scoping

### Injectable-dir seam over `TMUX_TMPDIR`-only isolation
**Decision**: The `internal/tmux` sweep is two functions — `sweepDeadTestSocketsIn(socketDir)` holding the loop, plus a wrapper supplying the real default; the sweep test sets `TMUX_TMPDIR` per-test for fixture creation AND passes the derived temp dir to the seam.
**Why**: Keeps the `TestMain` wrapper's behavior byte-identical (hardcoded `/tmp/tmux-<uid>` default) while the test gets a fully private namespace; the seam is the direct, deterministic handle for the enumeration dir, so no test ever fires the shared-namespace sweep mid-run.
**Rejected**: `TMUX_TMPDIR` alone with the wrapper reading it — that changes the production wrapper's enumeration behavior for all callers.
*Introduced by*: 260903-np2w-test-socket-sweep-scoping

### Guard the bare family anchor at the sweep sites, not at the constant
**Decision**: The `rk-test-e2e` / `rk-test-e2e-` refusal lives in `global-teardown.ts` and the `test-e2e.sh` `cleanup()` trap; `_tmux.ts`'s fallback default is outside the guard, and the refused branch still kills the primary by its exact name.
**Why**: A token-less anchor is unsafe only where it is used as a *prefix*; the two sweep sites are the only places that widen it into a match. Guarding there leaves the constant's other consumers (which use it as an exact server name) working, and keeps the primary reaped so the refusal never trades a cross-worktree hazard for a leak.
**Rejected**: Changing or removing `_tmux.ts`'s fallback default — direct Playwright runs are fail-closed anyway, and the constant has consumers for which a bare name is correct.
*Introduced by*: 260903-np2w-test-socket-sweep-scoping

### One complete rig per Playwright worker, sub-family per rig
**Decision**: In the multi-rig lane (`RK_E2E_WORKERS=N`, N>1) the harness starts N complete rigs — tmux server, backend, Vite, code-server stub port, state home — one per Playwright worker, and every rig, rig 0 included, gets the socket sub-family `rk-test-e2e-<token>-w<i>-`; each rig's backend `RK_SERVER_ALLOWLIST` is exactly its own sub-family.
**Why**: rk's state stream broadcasts session changes to every connected client, so two workers sharing one rig would see each other's sessions in their sidebars — a correctness race, not a load problem. Per-rig sub-families make the allowlist isolation exact (no rig lists another rig's servers, and `-w1-` can never prefix `-w10-`) while the worktree anchor still prefixes every sub-family, so the existing teardown sweeps reap all rigs unchanged.
**Rejected**: more shards only (each shard pays ~50 s of fixed setup before running a single test, and shards and workers stack — both knobs are kept); in-process workers on a shared rig (the SSE cross-talk race).
*Introduced by*: 260916-6p65-e2e-multi-rig-lane

