---
type: memory
description: "Daemon autostart: `rk daemon autostart on|off|status` registers the daemon with the OS per-user service manager (systemd user unit / LaunchAgent) to start once at boot or login via the login shell — never supervised; shared Backend interface + GOOS registry in internal/daemon/autostart, one self-registering file per OS."
---
# Daemon Autostart

**Domain**: run-kit

## Overview

`rk daemon autostart on [--now] | off | status`, each with `--json` (the standard `{ok,result}` envelope), registers the rk daemon with the OS's per-user service manager so it starts **once** at boot or login. The OS never restarts it: a crashed daemon stays down until `rk daemon start`. Off by default. Design and rationale: `fab/plans/sahil/26-11-11-rk-daemon-autostart.md`; spike evidence: `fab/plans/sahil/26-11-11-rk-daemon-autostart-s1-findings.md`.

## Shared surface

- **Package** `internal/daemon/autostart` (`autostart.go`): the `Backend` interface (`On(ctx, OnOptions{Now})`, `Off(ctx)`, `Status(ctx)`), the `Result` (`name`, `path`, `changed`, `started`, `hints`) and `Status` (`platform`, `manager`, `name`, `path`, `registered`, `enabled`, `starts_at` boot|login, `linger` Linux-only, `last_exit_code`, `last_result`, `rk_path`, `shell`, `stale`, `hints`) documents, and a GOOS registry: `Register(goos, ctor)` from each backend file's `init()`, `For(goos)` errors naming the platform when none is registered. No build tags: every backend compiles and tests on any host; the CLI picks one through the `autostartGOOS = runtime.GOOS` seam (`cmd/rk/daemon_autostart.go`, `autostartBackendFn` for tests).
- **Start command**: every registration runs `<login shell> -lc "$(StartScript(rkPath, unsetEnv))"` → `exec [env -u V …] '<rk>' daemon start --if-not-running`. The login shell gives the daemon's tmux server (and every later agent) the environment a manual start from the user's profile would; `--if-not-running` (backed by `daemon.ErrAlreadyRunning`) makes a start against a live daemon a success while real failures stay the job's non-zero exit. `rkPath` is `selfpath.Stable()` — the brew-prefix symlink, never a Cellar keg.
- **Managed marker**: each generated file carries `autostart.ManagedMarker` ("Managed by rk daemon autostart") as a comment; `off` refuses to delete a file at the registration path that lacks it.
- **Invariants**: every verb is idempotent (`changed:false` is "already on/off"); `on` registers only, `--now` also starts through the service manager; `off` never stops a running daemon; every service-manager call is `exec.CommandContext` with a timeout.

## Linux (systemd)

<!-- A1 fills this section. -->

## macOS (launchd)

<!-- A2 fills this section. -->
