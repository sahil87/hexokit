# Intake: Hook Launcher — Agent-State Writes Survive the Brew Upgrade Window

**Change**: 260916-la8z-hook-launcher-upgrade-window
**Created**: 2026-09-16

## Origin

Promptless dispatch from the team lead (source of truth: the live incident investigation of 2026-09-16; `{questioning-mode} = promptless-defer`, change type pinned `fix`). The lead's description, condensed:

> A Claude Code agent in pane %66 on the `shll` tmux server finished its turn at 19:48:25 IST. Its Stop hook ran and Claude Code recorded it as succeeded, but the pane's `@rk_pane_agent_state` stayed `active` (the value written by the last PreToolUse hook at 19:47:49) for 12+ minutes until a human noticed the pane was idle and the operator force-sent to it. The tick read the stale `active` and never dispatched the next stage.
>
> Root cause: `rk update` ran `brew upgrade sahil87/tap/run-kit` (3.20.2 → 3.20.3) between roughly 19:45:11 and 19:49:56. Homebrew's `install_formula` UNLINKS the old keg first, runs `FormulaInstaller#install` (tap "newer version available" lookup, `compute_dependencies`, `install_dependencies`, pour), and links the new keg only in `finish`. So `/home/linuxbrew/.linuxbrew/bin/run-kit` (and `.../bin/rk`) are dangling symlinks for the whole install phase, which is network-dependent and was minutes long here. The installed hook wrapper discards stderr and ends in `|| true`, so a missing binary exits 127, the harness sees success, and the `idle` write is silently lost. The Claude `idle_prompt` Notification backstop (~60 s later) fell inside the same window.
>
> Two independent defects compound: (1) the hook write path depends on a symlink that run-kit's own upgrade flow removes for an unbounded window; (2) `active` has no age exposed, so nothing downstream can judge staleness.

Decided fix (all in this change): a third `selfpath` resolver for an rk-owned launcher symlink that targets the Cellar binary; the daemon re-points it at start; a two-path fallback in the hook wrapper; `active` age exposed on the machine surfaces; code-server's `RK_BIN` moved to the launcher. Rejected alternatives and the residual gap are recorded verbatim below.

## Why

**The pain point.** The agent-state tier (`docs/specs/agent-state.md`) is the fab operator's only signal that a pane's turn ended. Its writer is a thin `/bin/sh -c` wrapper installed into each harness's hook config that execs the rk binary by an absolute path — today the Homebrew stable symlink `<prefix>/bin/run-kit`, chosen by `resolveRkPath()` in `cmd/rk/agent_setup.go` precisely so the hook survives version bumps (the Cellar path is deleted on upgrade). But Homebrew's `install_formula` (Library/Homebrew/install.rb) unlinks the old keg **before** the network-dependent install phase and relinks only in `finish`. For that whole window the stable symlink dangles, the wrapper's `"<path>" agent hook …` exits 127, `2>/dev/null || true` turns that into success, and the `idle`/`waiting` write never happens. `cmd/rk/upgrade.go` already records that Homebrew 6 makes an un-timed `api.github.com` call inside tap upgrades — the window is minutes, not milliseconds, and on 2026-09-16 both the Stop hook and the ~60 s `idle_prompt` Notification backstop fell inside it.

**Why it is stale forever, not briefly.** The read side (`agentStateStale` in `internal/tmux/tmux.go`) trusts any pid-carrying value while that pid is alive, and every consumer (`rollupAgentState` in `internal/sessions/sessions.go`, `rk mux panes`, `rk mux capture`) suppresses the duration for `active`. A live agent sitting idle behind a lost `idle` write therefore reads as a fresh `active` indefinitely. The spec's Writer rule 4 explicitly accepted lost writes ("the PID-liveness reconciler already clears state from dead agents") — that reasoning covers the dead-agent case and misses exactly this live-idle-agent case.

**What happens if we don't fix it.** Every `rk update` (and every manual `brew upgrade run-kit`) is a roulette wheel for every agent pane on the machine: any hook that fires during the window is lost, and a lost `idle` freezes the operator's tick for that pane until a human notices. The code-bridge extension execs `$RK_BIN` (the same stable symlink) per editor action and fails identically in the window.

**Why this approach.** Homebrew deletes the old keg only in cleanup, **after** the new keg is linked, so the old binary at its Cellar path keeps working through the entire unlink→link window. An rk-owned symlink whose target is that Cellar path is therefore live exactly when the brew symlink is not; after cleanup it dangles until the daemon (restarted by `rk update` seconds after the upgrade, or at its next start after a manual upgrade) re-points it, and the brew symlink covers that second gap. Two paths, each covering the other's hole, with no logic frozen into settings.json. Exposing `active` age is defense in depth against *any* lost write.

**Explicitly rejected** (recorded so apply does not re-derive them):

- Demoting a stale `active` to unknown after a fixed timeout — long e2e runs and builds legitimately exceed any threshold small enough to have helped here, and flickering to unknown misinforms the operator differently.
- A post-upgrade sweep from `rk update` that clears `active` values — covers only rk-driven upgrades, and has the reader mutating the writer's option.
- Inline `tmux set-option` fallback in the wrapper — re-freezes the option name/format into settings.json (the gen-1 → gen-2 migration removed exactly that; the option has been renamed since).
- A retry-with-sleep in the wrapper — covers seconds, not the multi-minute network-dependent window observed.
- Resolving symlinks in the hook path at install time — pins the Cellar version and re-freezes the hook (the failure `resolveRkPath` was designed to remove).

## What Changes

### 1. `internal/selfpath`: a third resolver — the rk-owned launcher

`internal/selfpath/selfpath.go` today has two audiences: `Resolve()` (the real on-disk binary, symlinks followed — brew detection, the daemon's own respawn) and `Stable()` / `StableFor(resolved)` (the brew-prefix symlink `<prefix>/bin/run-kit` — code-server `RK_BIN` via `codeServerSelfPath` in `internal/daemon/codeserver.go`, the gui supervisor argv via `guiSelfPath` in `internal/daemon/gui.go`, the post-upgrade daemon restart via `StableFor` in `cmd/rk/upgrade.go`).

Add a **launcher** resolver that returns the path of the rk-owned symlink `~/.local/share/rk/bin/run-kit`. This path already exists as `guiPointerPath(home)` in `cmd/rk/agent_setup.go`, built from the dir constant `rkBinRelDir = ".local/share/rk/bin"` in `cmd/rk/tmux_guard.go`. The constant (and the `rkBinDir(home)` join) moves into `selfpath` so the package is the single owner of the path; `cmd/rk` imports it (the gui display block's shell literal `guiPointerShellPath` keeps composing from the same constant so the block and the Go side can never disagree). Shape, mirroring the existing seams:

```go
// LauncherRelDir is the per-machine launcher directory relative to $HOME. It
// MUST stay off PATH: resolveRkPath prefers exec.LookPath("run-kit"), so a
// launcher on PATH would resolve to itself.
const LauncherRelDir = ".local/share/rk/bin"

// LauncherFor returns the rk-owned launcher symlink path for a given home.
func LauncherFor(home string) string

// Launcher is LauncherFor(os.UserHomeDir()).
func Launcher() (string, error)
```

Package doc: extend the "two resolvers, two audiences" paragraph to three — Launcher is for callers that must keep working **during** a `brew upgrade` (the hook wrapper, code-server's `RK_BIN`), because its target is the Cellar binary that Homebrew deletes only in cleanup, after the new keg is linked.

**Target change.** The pointer currently written by `rk agent setup` targets the brew stable symlink (`rkPath`, the `resolveRkPath()` result), so today it dangles during upgrades too. Its target becomes the **resolved Cellar binary** — see Assumption 3 for the open question of *which* resolution (the running setup binary's `selfpath.Resolve()` per the lead's description, or `filepath.EvalSymlinks(rkPath)` of the PATH-found stable symlink). On a non-Homebrew install the target is simply the resolved binary. Ownership and write rules are unchanged: rk only ever writes a symlink there ("is a symlink" is the ownership test — a regular file or directory at the path is the user's and is never touched), and the write stays atomic via `replaceSymlink` (temp symlink in the same dir + rename).

### 2. `rk serve` re-points the launcher at daemon start

In `cmd/rk/serve.go` RunE, immediately after the managed tmux.conf refresh (`tmux.EnsureConfig()` — the existing "daemon start is the only trigger" posture: no timer, no watcher), refresh the launcher:

- Lstat `selfpath.Launcher()`. Absent → do nothing (the installer owns creation). Non-symlink → do nothing, `slog.Info` that it is not rk-owned. Symlink whose `Readlink` target equals `selfpath.Resolve()` → no-op. Symlink with any other target → `replaceSymlink(resolved, launcher)` (the helper moves next to the resolver so both `cmd/rk` and the serve path share it), `slog.Info` old → new.
- Best-effort, never fatal: every error is a `slog.Warn` and startup proceeds.
- Seam-injected for tests (a package var for the resolve/lstat/readlink/replace triple in the `codeServerSelfPath` style) so no test touches real symlinks in `$HOME`.

`rk update` already restarts the daemon after `brew upgrade` (`cmd/rk/upgrade.go`), so the rk-driven path re-points within seconds of the new keg linking. A manual `brew upgrade run-kit` re-points at the next daemon start; between cleanup and that start the hook wrapper's second path (below) covers it.

See Assumption 2 for the open question of gating this on a Homebrew-installed daemon (`resolveBrewInstalled()` already exists in `serve.go`).

### 3. Two-path fallback in the hook wrapper

`agentStateHookCommand` and `agentStateHookCommandJSON` in `cmd/rk/agent_setup.go` take a second path. The launcher is tried first; if it fails to exec, the brew stable symlink (today's `resolveRkPath()` result) is tried; then `|| true`. Target shapes (fourth generation of the wrapper; `<launcher>` = `selfpath.LauncherFor(home)`, `<stable>` = `resolveRkPath()`):

```sh
/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "<launcher>" agent hook --agent claude idle 2>/dev/null || "<stable>" agent hook --agent claude idle 2>/dev/null || true'
```

```sh
/bin/sh -c '[ -n "$TMUX_PANE" ] && { "<launcher>" agent hook --agent agy idle 2>/dev/null || "<stable>" agent hook --agent agy idle 2>/dev/null; }; echo "{}"'
```

Invariants that MUST hold (each is an existing test or a Constitution rule):

- Both paths are machine-derived at install time and pass `validateHookPath` (absolute, none of `' " $ \` \\`); both sit double-quoted inside the single-quoted `sh -c` body.
- No option name, state format, or other logic is frozen into settings.json — the wrapper stays a thin never-fail interface; all logic stays in `rk agent hook`.
- Keep the `$TMUX_PANE` short-circuit, the absolute `/bin/sh`, `2>/dev/null` on both invocations, exit 0 on every path (Claude treats exit 2 as blocking; copilot's `preToolUse` is fail-closed on non-zero; agy's JSON variant must still echo `{}` last).
- A binary that runs but exits non-zero is NOT retried on the second path in any observable way that matters: `rk agent hook` itself always exits 0 (`TestAgentHookCmdNeverErrorsOnMalformedInvocation`), so the `||` chain only ever advances on exec failure (127/126).
- The ` agent hook ` family marker (`rkHookMarkerAgentHookFamily`) still matches, so `isRkEntry` recognises the current third-generation lines and `rk agent setup` replaces them in place; `--uninstall` still strips every generation.

**`rk doctor`** (`hookRkPath` in `cmd/rk/doctor.go` ~line 949) extracts "the double-quoted token immediately before ` agent hook `". With two invocations per command it must extract **both** embedded paths (walk every ` agent hook ` occurrence), and `agentHooksStatus`'s dangling-path rule needs a two-path semantics — see Assumption 5 (default: fail only when **both** paths dangle; a dangling launcher with a live stable path is a passing check with a note pointing at `rk agent setup`). The gen-3 → gen-4 wrapper is still classified generation 3 by `classifyHookGeneration` (same marker); doctor's note text `installed (generation 3)` should stay unless the shape needs to be surfaced (Assumption 6).

**`rk agent setup` writes the launcher as part of the hooks family.** Today the pointer is written only inside the gui display artifact (`applyGuiDisplayBlocks` → `installGuiDisplayPointer`, `agent_setup.go` ~line 659 / 1640). Because the hooks now embed the launcher path, the pointer write moves ahead of the per-agent hook installs and runs regardless of whether the gui display artifact is installed; the gui display block keeps gating on the pointer being in place (its `guiPointerInPlace` / `guiPointerForeign` / `guiPointerDeclined` verdicts are reused, not duplicated). The consent prompt, dry-run note, re-probe-before-write, and `MkdirAll`-after-consent behaviour carry over unchanged; the message prefix changes from `gui display:` to a launcher-neutral prefix (Assumption 7). If the user declines the pointer write, the hooks are still installed with both paths — the wrapper's second path covers a missing launcher.

### 4. Expose `active` age on the machine surfaces

Three sites currently emit a duration only for `idle` and `waiting`; each gains `active` (from `AgentStateEpoch`, same `FormatAgentDuration` format — `12s` / `12m` / `2h`):

| Site | File | Field |
|------|------|-------|
| `rk mux panes` | `cmd/rk/mux_panes.go` ~line 169 (`row.AgentStateDuration`) | `agent_state_duration` |
| `rk mux capture` | `cmd/rk/mux_capture.go` ~line 189 (`duration`) | `agent_state_duration` |
| window rollup | `internal/sessions/sessions.go` `rollupAgentState` ~line 437 | `AgentIdleDuration` → JSON `agentIdleDuration` |

The condition `state == idle || state == waiting` becomes `state != ""` (any known state with `epoch > 0`); comments that say "never shown for active" are rewritten to state the new rule and its reason (a lost write on a live agent is otherwise invisible). Field names do not change — the fab operator reads `agent_state_duration` and can now apply an "active for 12m with no stage/PR delta" rule.

**Frontend.** The rollup field reaches the SPA as `agentIdleDuration`, and three consumers append it to the state label whenever it is non-empty regardless of state: `src/components/sidebar/registers.ts:77` (`${win.agentState} ${win.agentIdleDuration}`), `src/components/status-dot-label.ts:91`, and `src/components/quake-terminal.tsx:911`; `src/components/watched-table.tsx:176–199` already branches by state and only reads the duration for `waiting`/`idle`. Per Assumption 4 the UI display rule stays unchanged: those unconditional consumers gate on `agentState === "waiting" || agentState === "idle"` so rendered output is byte-identical, and the `status-dot-label.ts:82` comment ("populated for `waiting` and `idle`") is corrected to say the field is now populated for `active` too but rendered only for the two rest states. Existing Vitest coverage on those components must keep passing; add one case per gated consumer asserting an `active` window with a duration renders without it.

### 5. Code-server `RK_BIN` switches to the launcher

`codeServerSelfPath` in `internal/daemon/codeserver.go` (line 78, `= selfpath.Stable`) becomes the launcher resolver, because the code-bridge extension execs `$RK_BIN` per editor action and fails in the same window. The gui supervisor (`guiSelfPath`, `gui.go` line 72) and the upgrade restart (`StableFor`, `upgrade.go` line 295) **stay on `Stable`** — the supervisor is a long-lived process launched once, and the restart runs after link. The `codeServerSelfPath` doc comment is rewritten for the new audience. `docs/memory/run-kit/code-bridge.md` § the `rk` resolution ladder (line 70) and § `RK_BIN` is env-carried (line 284) describe `RK_BIN` as the brew-prefix symlink and must be updated.

### 6. Spec and memory

- `docs/specs/agent-state.md` Writer rule 4 (lines ~69–90): the "If the binary is missing at fire time the hook is a silent no-op … acceptable, because the PID-liveness reconciler already clears state from dead agents" paragraph gains the live-idle-agent caveat and the two-path launcher design; the canonical command block (line ~93) shows the fourth-generation shape with `<launcher>` and `<stable>` placeholders; the `<abs-rk>` explanatory sentence is updated.
- Memory: see § Affected Memory.

### Residual gap (recorded, out of scope)

`rk agent hook` execs `tmux` via PATH (through the tmux guard shim → brew symlink); a tmux upgrade opens the same class of window for the write itself. Not addressed here — record it in `agent-state.md` memory as a known gap.

## Affected Memory

- `run-kit/agent-state`: (modify) hook installer section — fourth-generation two-path wrapper shape, the launcher as a hooks-family artifact (not only the gui display block's), the serve-time re-point, the live-idle-agent lost-write caveat, `rk doctor`'s two-path parse, and the residual tmux-upgrade gap.
- `run-kit/gui`: (modify) § "The pointer directory stays off PATH and is owned by symlink-ness" (line ~388) and the per-machine pointer paragraph (line ~107) — the pointer is now the shared launcher owned by `internal/selfpath`, targets the Cellar binary, and is written ahead of the hooks; the gui block's gating on it is unchanged.
- `run-kit/daemon-lifecycle`: (modify) § `rk serve` Wiring (line ~232) — the launcher re-point step after `tmux.EnsureConfig()`, startup ordering `EnsureConfig → launcher re-point → Supervisor.Start → ListenAndServe`; a Design Decisions entry for "daemon start is the trigger, not `rk update`".
- `run-kit/build-and-release`: (modify) § Homebrew Distribution (line ~76) — the unlink→install→link→cleanup order of `install_formula` and which rk path is live in each phase (the fact every resolver audience is derived from).
- `run-kit/code-bridge`: (modify) § the `rk` resolution ladder (line ~70) and § `RK_BIN` is env-carried (line ~284) — `RK_BIN` is the launcher, not the brew-prefix symlink.
- `run-kit/agent-messaging`: (modify) the `rk mux panes` / `rk mux capture` field tables (lines ~489, ~639, ~1083) — `agent_state_duration` is populated for `active` too; the fab-operator staleness rule it enables.
- `run-kit/architecture`: (modify) § Backend Libraries → `internal/selfpath` — three resolvers, three audiences (only if the package has a row there; otherwise skip).

## Impact

**Go (`app/backend`, module root):**

- `internal/selfpath/selfpath.go` (+ `selfpath_test.go`): `LauncherRelDir`, `LauncherFor`, `Launcher`, `ReplaceSymlink` moved in from `cmd/rk`; package doc.
- `cmd/rk/tmux_guard.go`: `rkBinRelDir` / `rkBinDir` become thin aliases of (or are replaced by) the `selfpath` constant; the shim's own `rkShimsRelDir` is untouched.
- `cmd/rk/agent_setup.go`: `agentStateHookCommand(launcherPath, stablePath, state, provider)`, `agentStateHookCommandJSON(...)`, the opencode plugin's `const RK = "<path>"` line (gains a second const or an inline fallback — `extractRkHookCommands` in doctor.go parses it), the kimi TOML `command = "..."` variant, the launcher write moved out of `applyGuiDisplayBlocks` into the hooks-family flow, `validateHookPath` applied to both paths.
- `cmd/rk/doctor.go`: `hookRkPath` → multi-path extraction; `agentHooksStatus` dangling rule; note text.
- `cmd/rk/serve.go`: launcher re-point after `tmux.EnsureConfig()`, seam-injected.
- `internal/daemon/codeserver.go`: `codeServerSelfPath = selfpath.Launcher`.
- `cmd/rk/mux_panes.go`, `cmd/rk/mux_capture.go`, `internal/sessions/sessions.go`: `active` duration.
- Tests: `TestAgentStateHookCommandShape` (agent_setup_test.go:406) and `TestAgentStateHookCommandJSONShape` (agent_hook_test.go:925) extended to assert both paths and the trailing `|| true` / `echo "{}"`; `TestAgentHookCmdNeverErrorsOnMalformedInvocation` (agent_hook_test.go:570) must keep passing; `TestGuiDisplayPointerRelink` (agent_setup_test.go:2413) follows the moved pointer flow; new tests for the selfpath resolver, the doctor parser with a two-invocation command (both wrapper variants), the serve-time re-point (seam-injected — absent / foreign / current / stale cases), and `active` duration in mux panes, mux capture, and `rollupAgentState`. All existing `rk agent setup` installer tests (fixture settings.json / hooks.json / TOML / JS plugin files) are regenerated for the fourth-generation shape.

**Frontend (`app/frontend`):** `src/components/sidebar/registers.ts`, `src/components/status-dot-label.ts`, `src/components/quake-terminal.tsx` gain the idle/waiting gate; `src/types.ts:195` comment; Vitest cases per consumer. `just test-frontend` is the unit gate (full run, not per-file — a cross-file `getByText` slipped through a scoped run before).

**Docs:** `docs/specs/agent-state.md`; memory files per § Affected Memory.

**CLI surface / toolkit standards:** `rk agent setup` and `rk doctor` output text changes (pointer prefix, doctor note/hint). Constitution § Toolkit Standards binds these to `shll standards` — check `shll standards principles` and `shll standards help-dump` before changing help or output shapes; no new subcommands or flags are added, so `help-dump` is unaffected unless a flag is introduced.

**Gates:** `just test-backend` for Go (the Bash tool here runs inside tmux — use `env -u TMUX -u TMUX_PANE` if any test reaches `checkPreconditions`; fresh worktree needs `just _ensure-tmux-conf` before `go test` / `go vet` for the `tmux.conf` embed pattern), `just test-frontend` for Vitest. No e2e change expected.

**Runtime rollout:** existing installs keep working unmodified (gen-3 lines still exec the stable symlink); users gain the launcher fallback on their next `rk agent setup` re-run plus an agent-session restart (harnesses snapshot hook config at session start). `rk doctor` should say so (Assumption 6).

**Constitution:** §I — both paths pass `validateHookPath`; every subprocess in Go stays `exec.CommandContext` with argv slices. §II — the launcher is an installer artifact like the tmux guard shim, not a state store; nothing is read back from it at request time. §X — hooks still carry only the underivable lifecycle state.

## Open Questions

- Should the serve-time re-point run only when the daemon itself is Homebrew-installed (a dev `rk serve` from a worktree binary, or an e2e rig's `rk serve` with a real `$HOME`, would otherwise re-point the machine's hooks at a throwaway build)? (Assumption 2) — **Resolved 2026-09-16**: brew-only; see Assumption 2.
- Which resolution supplies the launcher's target at install time: the running setup binary's `selfpath.Resolve()`, or `filepath.EvalSymlinks(resolveRkPath())` of the PATH-found stable symlink? (Assumption 3) — **Resolved 2026-09-16**: EvalSymlinks of the PATH-found stable symlink; see Assumption 3.
- Doctor's rule for a dangling launcher when the stable path is live — pass with a note, or fail? (Assumption 5)

## Clarifications

### Session 2026-09-16

| # | Action | Detail |
|---|--------|--------|
| 2 | Confirmed | Gate the serve-time launcher re-point on `resolveBrewInstalled()`; non-brew daemons never re-point |
| 3 | Confirmed | Launcher install-time target resolves the PATH-found stable symlink (`filepath.EvalSymlinks(rkPath)`), never the running setup binary; serve-time re-point uses `selfpath.Resolve()` |

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The five-part fix (launcher resolver, serve re-point, two-path wrapper, `active` age, code-server `RK_BIN`) ships as one `fix` change; the five rejected alternatives and the tmux-upgrade residual gap are not revisited | Decided in the live incident conversation; description enumerates each with its reason | S:95 R:70 A:90 D:95 |
| 2 | Confident | Gate the serve-time launcher re-point on `resolveBrewInstalled()` (the daemon's own binary carries the Cellar marker) so a dev-worktree `rk serve` or an e2e rig's `rk serve` (real `$HOME`, throwaway binary) never re-points the machine's hooks at a build that will vanish; recommended default: brew-only, with the unconditional form kept behind the seam for tests — DECIDED: brew-only via `resolveBrewInstalled()`; a non-brew daemon (dev worktree, e2e rig, curl install) never re-points; the unconditional form stays behind the seam for tests only | Clarified — user confirmed (lead decision in conversation, 2026-09-16) | S:95 R:45 A:40 D:30 |
| 3 | Confident | The launcher's install-time target: `filepath.EvalSymlinks(rkPath)` of the validated PATH-found stable symlink (falls back to `rkPath` unchanged when it does not resolve), NOT the running setup binary's `selfpath.Resolve()` — so `bin/rk agent setup` from a dev worktree still points the launcher at the Homebrew Cellar binary, matching today's `resolveRkPath` semantics where the running binary's location is deliberately not trusted; the serve-time re-point (which does run from the installed daemon) uses `selfpath.Resolve()` as described — DECIDED: install-time target = `filepath.EvalSymlinks` of the validated PATH-found stable symlink (fallback: that path unchanged); serve-time re-point uses `selfpath.Resolve()` of the daemon binary | Clarified — user confirmed (lead decision in conversation, 2026-09-16) | S:95 R:60 A:45 D:35 |
| 4 | Confident | The rollup emits `AgentIdleDuration` for `active`; the frontend display rule is kept unchanged by gating the three unconditional consumers (`registers.ts:77`, `status-dot-label.ts:91`, `quake-terminal.tsx:911`) on `waiting`/`idle`; `watched-table.tsx` already branches by state and needs no change | Lead's stated default ("keep the UI display rule unchanged unless trivially additive") plus a read of the consumers; the gate is three one-line conditions and preserves byte-identical labels | S:75 R:85 A:80 D:70 |
| 5 | Confident | `rk doctor` agent-hooks row: extract every path before each ` agent hook ` occurrence; the check FAILS only when every embedded path dangles; a dangling launcher with a live stable path PASSES with a note (`launcher <path> dangling — re-run rk agent setup`); a dangling stable path with a live launcher also passes with a note | The description says only that doctor "must handle" two invocations; the existing rule fails on any dangling path, but a dangling launcher is the expected state between brew cleanup and the next daemon start, so failing on it would page for a self-healing condition. Easily revised | S:50 R:85 A:70 D:60 |
| 6 | Confident | `classifyHookGeneration` stays at three generations (same ` agent hook ` marker); the two-path shape is reported by doctor as a note when an installed gen-3 command carries only one path (`single-path wrapper — re-run rk agent setup to add the launcher fallback`), not as a failure; no new generation number, no new marker | A fourth marker would only serve reporting; the ownership/replace logic keys on the family marker and needs no change. Rollout hint is what a user needs | S:55 R:85 A:75 D:65 |
| 7 | Confident | The pointer install moves out of `applyGuiDisplayBlocks` into a launcher step that runs first in `rk agent setup` (before per-agent hooks, before the shim and gui blocks), reusing `installGuiDisplayPointer`'s consent / dry-run / re-probe / atomic-replace flow verbatim; its messages change prefix from `gui display:` to `launcher:`; `--uninstall` removes it last (after hooks and the gui block, both of which reference it); the gui block's `guiPointerInPlace`/`Foreign`/`Declined` gating consumes the launcher step's verdict | Follows from "write the launcher pointer as part of the hooks family" plus the existing tmux-shim ordering precedent (artifact before the things that exec it); prefix rename is cosmetic but visible output, so it is checked against `shll standards principles` | S:65 R:80 A:75 D:65 |
| 8 | Certain | `rkBinRelDir` and `replaceSymlink` move from `cmd/rk` into `internal/selfpath` (exported `LauncherRelDir`, `LauncherFor`, `ReplaceSymlink`); `cmd/rk` keeps thin aliases only where the diff would otherwise touch unrelated shim code | `selfpath` must own the path to resolve it, and `serve.go` needs the atomic replace; keeping one owner is the package's stated purpose | S:70 R:90 A:85 D:80 |
| 9 | Confident | The opencode JS plugin (`const RK = "<path>"`) and the kimi TOML `command = "..."` entries gain the same two-path fallback in their own syntax (a second const / the same OR-chain of two invocations inside the TOML string), and `extractRkHookCommands` in doctor.go learns the second const | The description says "the wrapper" generically and lists every installer kind under `isRkEntry`; leaving one harness single-path would leave that harness exposed to the incident. Per-kind syntax is mechanical | S:55 R:80 A:75 D:70 |
| 10 | Certain | Both embedded paths pass `validateHookPath` (absolute, no `' " $ \` \\`); an unvalidatable launcher path fails the install loudly, exactly as an unvalidatable stable path does today | Constitution §I and the existing `validateHookPath` contract | S:90 R:90 A:95 D:95 |
| 11 | Certain | The serve-time re-point never creates the launcher when absent and never touches a non-symlink at the path; it is best-effort and logged, never fatal to startup | Stated in the description; mirrors the tmux.conf refresh posture and the pointer ownership rule | S:90 R:85 A:90 D:90 |
| 12 | Certain | Gates: `just test-backend` (Go) and `just test-frontend` (Vitest, full run); no e2e change; `env -u TMUX -u TMUX_PANE` when a Go test reaches `checkPreconditions`; `just _ensure-tmux-conf` first in a fresh worktree | Project testing conventions in `fab/project/context.md` and the description's constraints | S:85 R:95 A:95 D:95 |
| 13 | Confident | `docs/memory/run-kit/architecture.md` gets an `internal/selfpath` row update only if the package already has one; no new memory file is created for the launcher (it is documented inside `agent-state.md` and `gui.md`) | Memory landscape check: the pointer is currently documented in `gui.md`; splitting a one-symlink artifact into its own file would over-fragment | S:60 R:90 A:70 D:70 |

13 assumptions (5 certain, 8 confident, 0 tentative, 0 unresolved).
