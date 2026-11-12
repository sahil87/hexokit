# Intake: macOS daemon autostart (LaunchAgent)

**Change**: 261111-qdxp-macos-daemon-autostart-launchagent
**Created**: 2026-11-11

## Origin

> Implement step A2 of fab/plans/sahil/26-11-11-rk-daemon-autostart.md: the same "rk daemon autostart on|off|status" verbs on macOS (LaunchAgent). Read that plan (Goal, Decisions, brief A2) and the S1 findings fab/plans/sahil/26-11-11-rk-daemon-autostart-s1-findings.md (its macOS section is an untested candidate; already in this worktree via cherry-pick) first. Resolve A2's open decisions at intake (launchd label; whether the desktop app exposes the switch) and record them. macOS cannot be run here, so tests go behind seams and the PR must say the plist shape is unverified on a real Mac. Never enable autostart on this machine. Once the intake is done, continue with /fab-fff. Another lane (A1, Linux) works the same verbs in parallel: keep the platform split clean (shared CLI surface vs. per-OS backend) so the two PRs merge without conflicts.

One-shot operator dispatch (lane brief L1–L5 attached: rig safety, evidence, CI-to-green, ready/review, reports). The plan's "Decisions already taken" table is binding and is not reopened here: start once and never supervise (no `KeepAlive`), per-user LaunchAgent (no root), start at **login** on macOS, run `rk daemon start` through the user's **login shell**, off by default, and the verb is `rk daemon autostart on|off|status`.

Coordination with the A1 lane: at intake time, cross-session messages with the `a1-linux-autostart` session agreed a shared/per-OS file split and the shared contract (see § Platform split).

## Why

1. **Problem.** Nothing starts the HexoKit daemon after a reboot or re-login on a Mac. Until someone runs `rk daemon start`, every rk cron entry is silent: no operator ticks, no reminders, no respawns, and nothing says so (the "reboot hole" of the 2026-09-03 operator pulse plan). Once the operator lives in the daemon, a missing daemon means no operator at all.
2. **Consequence of not doing it.** macOS users, who are the main desktop-app audience, keep the reboot hole after Linux (A1) closes it, and the plan's A4 (docs) and A5 (turn it on) cannot complete for macOS.
3. **Why this approach.** The plan already chose the mechanism: a per-user LaunchAgent written by `rk`, not `brew services`. That rules out `brew services`, which ties autostart to the Homebrew install and starts the service with a bare environment. rk writes the plist itself, so it controls the environment (login shell) and the no-restart rule (no `KeepAlive`).

## What Changes

### Platform split (shared CLI surface vs. per-OS backend)

A1 (Linux) and A2 (macOS) run in parallel and must merge without conflicts. The rule: **shared code is written once, as one standalone commit that both branches carry byte-identical**. When the second PR rebases onto main, git drops it as already applied. **Per-OS code lives in files only one lane touches.**

Shared (one commit, identical on both branches):

| File | Content |
|---|---|
| `app/backend/internal/daemon/autostart/autostart.go` | `Backend` interface (`On(ctx, OnOptions{Now bool}) (Result, error)`, `Off(ctx) (Result, error)`, `Status(ctx) (Status, error)`). `Result{Name, Path string; Changed, Started bool; Hints []string}` — `Changed` is how an idempotent re-run says "already on/off". `Status` (snake_case JSON): `platform`, `manager`, `name`, `path`, `registered`, `enabled`, `starts_at` (`"boot"`/`"login"`/`""`), `linger` (`*bool`, Linux only), `last_exit_code` (`*int`), `last_result`, `rk_path`, `shell`, `stale` (on-disk file differs from what `on` would write now), `hints []string`. Platform registry `Register(goos, func() Backend)` + `For(goos) (Backend, error)` (unregistered GOOS → error naming the platform). Helpers: `RKPath()` (`selfpath.Stable`, survives `brew upgrade`), `StartScript(rkPath string, unsetEnv []string)` → `exec [env -u V …] '<rk>' daemon start --if-not-running` (shell-quoted; the `env -u` prefix omitted when `unsetEnv` is empty — macOS passes nil), and `const ManagedMarker = "Managed by rk daemon autostart"` (each backend writes it as a comment in its file; `off` refuses to delete a file at its path that lacks it). Login-shell lookup is NOT shared — each backend owns its own seam |
| `app/backend/internal/daemon/autostart/autostart_test.go` | Registry + `StartScript` tests |
| `app/backend/internal/daemon/daemon.go` + `cmd/rk/daemon_start.go` | Sentinel `daemon.ErrAlreadyRunning` returned by `Start()`/`StartWithBinary()` (same message text, `daemon already running`); new `rk daemon start --if-not-running` flag: exit 0 printing `run-kit daemon already running` when the daemon is up (checked with `errors.Is`), every other failure stays non-zero. This replaces S1's L7 text-grep guard (S1 itself suggested an idempotent start flag) |
| `app/backend/cmd/rk/daemon_autostart.go` | Cobra `autostart` parent with `on [--now]`, `off`, `status`; `--json` on all three (`{ok,result}` envelope via `newSink`; on/off emit `Result`, status emits `Status`). `--now` defaults to false. Backend chosen through the seam `autostartGOOS = runtime.GOOS` (the `desktopGOOS`/`guiGOOS` idiom). Text rendering of `Result`/`Status` |
| `app/backend/cmd/rk/daemon.go` | One `AddCommand(daemonAutostartCmd)` line + one `autostart` line in the Long help |
| `docs/memory/run-kit/daemon-autostart.md` | New memory file with a shared section and separate `## Linux (systemd)` / `## macOS (launchd)` sections. Each lane fills only its own section at hydrate |

Per-OS (one lane each):

- A1: `internal/daemon/autostart/systemd.go` + `systemd_test.go`
- **A2 (this change): `internal/daemon/autostart/launchd.go` + `launchd_test.go`**, which self-register in `init()` via `Register("darwin", newLaunchd)`

Self-registration means the shared code never names a symbol from the other lane, so each PR compiles and passes on its own. **No build tags**: plain files plus seams, so the launchd backend's tests run on Linux CI.

**A1 agreed to this split** in a cross-session reply at intake: unit name `hexokit-daemon.service`, label `ai.shll.hexokit.daemon` accepted. A1 also added the contract items folded into the table above: `ErrAlreadyRunning` + `--if-not-running`, `StartScript(rkPath, unsetEnv)` with `exec`, `Result`, `RKPath`/`Shell`/`Stale` on `Status`, `ManagedMarker`, `--json` on all verbs, and `--now` defaulting to false.

**A2 writes the shared commit** and pushes it to origin branch `autostart-shared`; A1 cherry-picks that exact sha. **Done at intake:** commit `e7336e55` (`feat(daemon): shared surface for rk daemon autostart on|off|status`) is already on this branch and on `origin/autostart-shared`. It contains `autostart.go` + test, `cmd/rk/daemon_autostart.go` + test, the `daemon.go` registration, `ErrAlreadyRunning` + `--if-not-running` (seam `daemonStartFn`), the `daemon-autostart.md` skeleton, and the `daemon-lifecycle.md` pointer. It is this change's first commit, written at intake for coordination. Apply builds `launchd.go` on top of it and MUST NOT edit shared files without first agreeing the change with A1 by message.

### `launchd.go` — the macOS backend

**Identity** (open decision, resolved here):
- Label: `ai.shll.hexokit.daemon`. This is the reverse-DNS launchd convention under the toolkit's `shll.ai` domain, with `hexokit` as the product name. Unlike the desktop app's `ai.shll.run-kit` appId, this registration has no installed base to keep stable, so it takes the current product name.
- Plist path: `~/Library/LaunchAgents/ai.shll.hexokit.daemon.plist`.
- launchd domain target: `gui/<uid>`, service target `gui/<uid>/ai.shll.hexokit.daemon` (uid from `os.Getuid()`).

**Plist shape**, from S1's untested macOS candidate:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.shll.hexokit.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>{login shell}</string><string>-lc</string>
    <string>{StartScript(absolute stable rk path)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>{state home}/logs/autostart.log</string>
  <key>StandardErrorPath</key><string>{state home}/logs/autostart.log</string>
</dict>
</plist>
```

- A leading XML comment `<!-- Managed by rk daemon autostart -->` (`autostart.ManagedMarker`). `off` refuses to delete a plist at that path that lacks it.
- `ProgramArguments[2]` is `autostart.StartScript(rkPath, nil)` → `exec '<rk>' daemon start --if-not-running`.
- No `KeepAlive`, `StartInterval` or `WatchPaths`: the job runs once per load and is never restarted.
- `AbandonProcessGroup` keeps launchd from killing the job's process group when the shell exits, so the tmux server it births survives (hazard 1).
- String values are XML-escaped (`encoding/xml` `EscapeText`).
- The `rk` path is absolute: `selfpath.Stable`, the brew opt/bin symlink, not the Cellar path.
- The login shell is looked up, not taken from `$SHELL`: `dscl . -read /Users/<user> UserShell` → `UserShell: /bin/zsh`, falling back to `/bin/zsh`, the macOS default, when dscl fails or prints nothing. Done behind a seam.
- The log path lives in the state home's `logs/` dir (`apphome.LogsDir()`, the constitution's home for rk job logs), so a failing login start leaves a trace.

**`on [--now]`** is idempotent:
1. Render the plist and write it atomically (`fsatomic.WriteFile`, 0644), creating `~/Library/LaunchAgents` and the logs dir if missing. If the file on disk is already byte-identical, it is not rewritten.
2. `launchctl enable gui/<uid>/<label>` clears any stale `launchctl disable` override. It neither loads nor starts the job.
3. Without `--now`, stop here. launchd loads every plist in `~/Library/LaunchAgents` at the next login, and the daemon starts then.
4. With `--now`: if the service is already loaded (`launchctl print gui/<uid>/<label>` exits 0) and the plist was unchanged, it is a no-op. If it was loaded and the plist changed, `bootout` first. Then `launchctl bootstrap gui/<uid> <plist>`. Because of `RunAtLoad`, bootstrapping runs the job immediately. The start guard makes that a success no-op when the daemon is already running.

This deviates from the plan brief's literal "then `launchctl bootstrap`". On macOS, bootstrap with `RunAtLoad` *starts* the daemon, so an unconditional bootstrap would contradict the plan's own "don't start it now unless `--now`" (A1's brief, which A2 mirrors as "same verbs and flags").

**`off`** is idempotent and never stops the daemon:
0. If a plist exists at the path but lacks `ManagedMarker`, refuse with an error (it is not ours) and touch nothing.
1. If loaded: `launchctl bootout gui/<uid>/<label>`. The job's shell has already exited after its one run; `AbandonProcessGroup` plus tmux's own `daemon()`/`setsid` keep the tmux server out of the job's reach.
2. Delete the plist (a missing file is fine).
3. Never call `rk daemon stop`.

**`status`**:
- `platform: darwin`, `manager: launchd`, `name: <label>`, `path: <plist path>`.
- `rk_path` / `shell` = what `on` would write now. `stale` = the on-disk plist differs from that rendering.
- `registered` = plist exists.
- `enabled` = registered and the label is not marked disabled in `launchctl print-disabled gui/<uid>`.
- `starts_at: "login"` always. macOS has no per-user boot start: a LaunchDaemon would run as root, which the plan rules out.
- `last_exit_code` / `last_result` are parsed from `launchctl print gui/<uid>/<label>` (`last exit code = N`). `(never exited)` or not loaded gives a null code, and `last_result` is `"never run"` / `"not loaded"`.
- `hints`:
  - the login-shell caveat: exports that live only in `~/.zshrc` (PATH, credentials, `TMUX_TMPDIR`) are not seen by `zsh -lc`, so move them to `~/.zprofile`;
  - a **stale registration** hint when the on-disk plist differs from what `on` would write now (rk moved, login shell changed), naming `rk daemon autostart on` to refresh it;
  - when not registered, the command to turn it on.

**Process execution**: every `launchctl` and `dscl` call goes through `exec.CommandContext` with a 10 s timeout and an argument slice (Principle I). The label is a constant, never user input. Tests replace a single `runCmd` seam (name, args → stdout, exit code, err), plus `homeDir`, `uid`, `loginShell` and `rkPath` seams, and write into `t.TempDir()`. No test can reach a real `launchctl`, and on this Linux machine none exists.

### Desktop app (open decision, resolved here)

The desktop app does **not** expose the switch in A2; the switch is CLI-only. Reasons:
- The shell's posture is that it runs `rk` only for explicit user actions and read-only detection, and it has a daemon menu but no settings surface.
- A toggle there is desktop-shell scope (`app/desktop/src/`). It would need a shell-lane recording, and the macOS-only behavior could not be shown by the Linux/Xvfb `just demo`.
- A3 owns autostart visibility (the `rk doctor` row and the UI status line).

A desktop menu item is a candidate follow-up after A3.

**Both starting together is harmless**, with no code change needed:
- The desktop app's Start runs `rk daemon start`. That refuses with `daemon already running` when the LaunchAgent got there first, and the menu already disables Start while the daemon is running.
- The LaunchAgent's start guard reads an already-running daemon as success.
- `rk daemon start`'s port guard and `IsRunning` check prevent a second serve whichever way the race goes.

### Never on this machine

No code path runs during tests or local validation against the real user domain. CLI validation here uses the Linux backend's absence (pre-A1) or A1's backend only with `--help`/`status`. `rk daemon autostart on` is never run on this machine.

## Affected Memory

- `run-kit/daemon-autostart`: (new) autostart verbs, the shared Backend/registry split, and the `## macOS (launchd)` section (label, plist shape, `on`/`--now`/`off`/`status` semantics, unverified-on-real-Mac caveat). A1 fills `## Linux (systemd)`.
- `run-kit/daemon-lifecycle`: (modify) a one-line pointer to `daemon-autostart.md` from the `rk daemon` subcommand list.

## Impact

- New package `app/backend/internal/daemon/autostart/`: shared `autostart.go` + A2's `launchd.go`.
- New `app/backend/cmd/rk/daemon_autostart.go`; a one-line registration in `cmd/rk/daemon.go`.
- Dependencies: `internal/selfpath` (stable rk path), `internal/fsatomic` (plist write), `internal/apphome` (logs dir). No new third-party module: the plist is rendered with `text/template` plus `encoding/xml` escaping.
- No web UI, no desktop-shell change, no API route. PR evidence: `No recording: CLI-only, macOS-only backend; validated with unit tests behind launchctl/dscl/filesystem seams`. The PR body must state that the plist shape and the launchctl sequence are **unverified on a real Mac** and list S1's five macOS checks as A5's to-do.
- MCP policy (`docs/specs/mcp.md`): `daemon *` other than `status` must not gain a policy row, so no MCP change.

## Open Questions

- A real-Mac check of S1's five macOS items: tmux survival with and without `AbandonProcessGroup`, `bootout` leaving the daemon running, the environment diff under `zsh -lc`, the tmux socket path vs `TMPDIR`, and a second login not starting a second daemon. This is deferred to A5 (user gate); A2 cannot run it.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Plan decisions are binding: per-user LaunchAgent, login timing, login-shell start, no `KeepAlive`, off by default, verbs `on\|off\|status` | Plan § "Decisions already taken (do not reopen at intake)" | S:95 R:70 A:95 D:95 |
| 2 | Confident | launchd label `ai.shll.hexokit.daemon`, plist `~/Library/LaunchAgents/ai.shll.hexokit.daemon.plist` | Open decision assigned to this intake by the user; reverse-DNS is launchd convention, `shll.ai` is the toolkit domain (desktop appId `ai.shll.run-kit`), product is HexoKit; no installed base pins an older name | S:70 R:60 A:70 D:60 |
| 3 | Confident | The desktop app does not expose the switch in A2; CLI-only. Concurrent starts are already harmless | Open decision assigned to this intake by the user; the shell posture is explicit actions only, with no settings surface; a shell change needs shell-lane evidence that can't show macOS; A3 owns visibility | S:70 R:75 A:70 D:65 |
| 4 | Confident | Shared surface (interface, registry, CLI, start script, memory skeleton) is one byte-identical commit on both lanes; per-OS backends self-register in their own files; no build tags | The user asked for a clean shared/per-OS split that merges without conflict; the cherry-picked-commit pattern is already used here (`operator: cherry-pick q5yn dependency`); the GOOS-seam idiom exists (`desktopGOOS`, `guiGOOS`) | S:80 R:65 A:75 D:60 |
| 5 | Confident | Package `internal/daemon/autostart/` | The plan scopes the work to `internal/daemon` + `cmd/rk/daemon*`; a subpackage keeps the large `daemon` package untouched | S:70 R:80 A:75 D:70 |
| 6 | Confident | `on` writes the plist and runs `launchctl enable` but only bootstraps with `--now` | `bootstrap` with `RunAtLoad` starts the job now, which would contradict "don't start unless `--now`"; launchd loads `~/Library/LaunchAgents` at login anyway | S:65 R:80 A:75 D:65 |
| 7 | Confident | Login shell from `dscl . -read /Users/<user> UserShell` with a `/bin/zsh` fallback, never `$SHELL` | S1: look the shell up, don't rely on `$SHELL`; dscl is the macOS directory-service lookup; zsh is the macOS default | S:75 R:85 A:70 D:75 |
| 8 | Confident | Start command is `exec '<rk>' daemon start --if-not-running` (new idempotent flag + `ErrAlreadyRunning` sentinel) with the absolute stable rk path, replacing S1's L7 text-grep guard | Agreed with A1 by message; S1 recorded that `start` exits 1 when up and `status` always exits 0, and suggested an idempotent start flag as the cleaner fix; ties the unit to an exit code, not display text | S:85 R:80 A:80 D:80 |
| 9 | Confident | Plist adds `StandardOutPath`/`StandardErrorPath` → `{state home}/logs/autostart.log` beyond S1's candidate | Without it a failed login start leaves no trace; the constitution puts rk job logs under the state home's `logs/` | S:55 R:90 A:70 D:70 |
| 10 | Confident | `status` reports `starts_at: login`, `last_exit_code` from `launchctl print`, disabled state from `print-disabled`, a stale-plist hint, and the `.zshrc` caveat hint | Plan Goal asks registered/enabled/without-a-login/last result; S1 asks status to carry the rc caveat | S:70 R:85 A:70 D:70 |
| 11 | Certain | Every launchctl/dscl call via `exec.CommandContext` with a timeout behind one seam; tests in `t.TempDir()`; autostart never enabled on this machine | Constitution I and § Process Execution; explicit user instruction | S:95 R:90 A:95 D:95 |
| 12 | Certain | Evidence: `No recording: CLI-only`; the PR body states the plist shape is unverified on a real Mac | User instruction; lane brief L2 (nothing observable in UI/shell) | S:95 R:90 A:95 D:95 |
| 13 | Confident | `on`/`off`/`status` all take `--json`; `on` returns `Result{Changed,Started}`; `ManagedMarker` comment guards `off`'s delete | Agreed shared contract with A1 (cross-session); A3/A5 scripting wants it | S:80 R:85 A:80 D:80 |

13 assumptions (4 certain, 9 confident, 0 tentative, 0 unresolved).
