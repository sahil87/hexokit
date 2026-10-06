package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"rk/internal/apphome"
	"rk/internal/shellq"
	"rk/internal/validate"
)

// JobsSessionName is the tmux session hosting daemon-managed job windows
// (update, restart). It is a SIBLING session on the rk-daemon socket — the
// rk-code-server / rk-remotes precedent — never a window inside the rk-daemon
// session: daemon.Stop()'s exact-match =rk-daemon kill never touches it, so a
// job window survives the daemon restart the job itself triggers (the
// load-bearing property for `rk daemon restart` running as a job).
const JobsSessionName = "rk-jobs"

// JobTarget identifies a spawned (or found in-flight) job window — enough for
// callers (API handlers, the CLI) to build a dashboard link or a one-line
// report.
type JobTarget struct {
	Server   string // tmux socket name: "rk-daemon"
	Session  string // JobsSessionName
	Window   string // job name, e.g. "update"
	WindowID string // tmux window id, e.g. "@5"
}

// jobDaemonRunning probes daemon liveness. A package seam (mirroring
// codeServerSessionExists) so tests drive the gate without a live tmux server.
var jobDaemonRunning = func(ctx context.Context) bool {
	return isRunningCtx(ctx)
}

// jobSessionExists reports whether the named session exists on the daemon
// socket. A package seam for the same reason as jobDaemonRunning.
var jobSessionExists = func(ctx context.Context, name string) bool {
	return sessionExistsCtx(ctx, name)
}

// jobWindowState queries a job window: exists, dead (remained-on-exit pane),
// and its window id. One list-panes call carries both format fields; an error
// (window absent — "can't find window", exit 1) maps to exists=false. A package
// seam so tests drive the three dedup branches without a live tmux server.
//
// list-panes, NOT display-message: display-message with a target whose window
// part does not resolve silently falls back to the session's ACTIVE window and
// exits 0 (verified on tmux 3.6a) — which read the rk-jobs idle window as a
// live in-flight job and made RunJob spawn nothing (260812-anac, the released
// 3.15.10 first-click bug). list-panes hard-fails on a missing window.
var jobWindowState = func(ctx context.Context, target string) (id string, dead bool, exists bool) {
	out, err := jobRunTmuxOutput(ctx, "list-panes", "-t", target, "-F", "#{window_id} #{pane_dead}")
	if err != nil {
		return "", false, false
	}
	// A job window is single-pane by construction; parse the first line and
	// tolerate extras from a manual split.
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	fields := strings.Fields(line)
	if len(fields) != 2 {
		return "", false, false
	}
	return fields[0], fields[1] == "1", true
}

// jobRunTmux / jobRunTmuxOutput are the package seams over the runTmux/
// runTmuxOutput runners (exec.CommandContext + argv + caller-bounded ctx,
// Constitution I) so tests capture argv without a live tmux server.
var jobRunTmux = runTmux
var jobRunTmuxOutput = runTmuxOutput

// jobTargetFor returns the exact-match window target (=rk-jobs:=<window>) used
// for every dedup/probe/kill/options call — prefix-match hijack is the class
// of footgun the `=` anchors exist to prevent (tmux-sessions memory).
func jobTargetFor(window string) string {
	return "=" + JobsSessionName + ":=" + window
}

// RunJob runs argv in the managed window named `window` of the rk-jobs sibling
// session on the rk-daemon socket, returning the window's identity.
//
// started=false with a nil error means a LIVE job window with that name
// already exists (in-flight): its target is returned so callers can surface it
// and NO second window is spawned. An error means the job did not start.
//
// Semantics, in order:
//
//  1. Daemon gate: the daemon must be running — otherwise error. Any tmux
//     command on a dead socket would silently BIRTH a server; the gate refuses
//     instead of paying that side effect (no fallback fork, intake decision 1).
//  2. Session-absent fast path: rk-jobs is created WITH the job window as its
//     first window (new-session -d -n <window> <argv…> — the tunnel.go
//     pattern), so no idle default window ever exists; the dedup probe is
//     skipped (no session ⇒ no in-flight job). A lost duplicate-session race
//     falls through to the session-exists path below.
//  3. Window dedup on the exact-match target: a live pane → in-flight, return
//     started=false; a dead pane (a completed prior run, any exit status —
//     remain-on-exit on) → respawn-window -k relaunches argv in the dead
//     window (reap-on-rerun, intake decision 5 — in place, because killing a
//     session's last window would kill the session); absent → spawn fresh.
//  4. Spawn (session-exists path): new-window -d … -P -F '#{window_id}'
//     <argv…>. tmux joins the trailing argv words with spaces into its own
//     sh -c — the same boundary the shipped codeserver spawn crosses. argv is
//     CALLER-SUPPLIED and shell-sensitive: RunJob validates only the window
//     name. The web handlers pass rk-controlled binaries plus
//     ValidateToolName-validated tool names; `rk daemon run` passes the CLI
//     user's own command verbatim (their own shell authority — the same trust
//     as typing the tmux command themselves). Multi-word arguments do not
//     survive the unquoted join.
//  5. Post-spawn window options, BEST-EFFORT (warn-only, never fail the
//     spawn): remain-on-exit on (the pane persists after ANY exit, so a
//     completed job's output stays on screen until the next run respawns the
//     window in place) and a pipe-pane tee to <state>/logs/<window>.log
//     (apphome.LogsDir) for durable log continuity with the pre-window
//     update.log/restart.log paths.
//
// The window name is validated before it becomes a tmux target or a pipe-pane
// shell-string component (Constitution I) — the same identifier class as
// validate.ValidateToolName (CLI users supply it via rk daemon run --window).
func RunJob(ctx context.Context, window string, argv []string) (target JobTarget, started bool, err error) {
	target = JobTarget{Server: serverSocket, Session: JobsSessionName, Window: window}

	if msg := validate.ValidateToolName(window); msg != "" {
		return target, false, fmt.Errorf("invalid job window name %q: %s", window, msg)
	}
	if len(argv) == 0 {
		return target, false, fmt.Errorf("no command given for job window %q", window)
	}

	// Every tmux call below shares ONE cmdTimeout-bounded context derived from
	// the caller's — deliberately NOT Stop's per-command-context pattern: the
	// single budget bounds the whole gate→ensure→dedup→spawn→options sequence,
	// so an API handler calling RunJob blocks at most one cmdTimeout end-to-end
	// rather than accumulating a fresh budget per command.
	cmdCtx, cancel := context.WithTimeout(ctx, cmdTimeout)
	defer cancel()

	// 1. Daemon gate — never birth a tmux server as a side effect.
	if !jobDaemonRunning(cmdCtx) {
		return target, false, fmt.Errorf("rk daemon is not running — start it with `rk serve -d`")
	}

	// 2. Session-absent fast path: create rk-jobs WITH the job window as its
	// first window (the internal/remote/tunnel.go pattern) — new-session -d
	// alone would mint a permanent idle default shell window, and no session
	// means no job can be in flight, so the dedup probe is skipped.
	winTarget := jobTargetFor(window)
	spawned := false
	if !jobSessionExists(cmdCtx, JobsSessionName) {
		createArgs := []string{"new-session", "-d", "-s", JobsSessionName, "-n", window, "-P", "-F", "#{window_id}"}
		createArgs = append(createArgs, argv...)
		out, err := jobRunTmuxOutput(cmdCtx, createArgs...)
		switch {
		case err == nil:
			target.WindowID = strings.TrimSpace(string(out))
			spawned = true
		case strings.Contains(err.Error(), "duplicate session"):
			// A concurrent RunJob won the create race — ITS job window may be in
			// flight, so fall through to the session-exists probe + spawn path.
		default:
			return target, false, fmt.Errorf("creating %s session with %q job window: %w", JobsSessionName, window, err)
		}
	}

	if !spawned {
		// 3. Window dedup (exact-match targets throughout).
		if id, dead, exists := jobWindowState(cmdCtx, winTarget); exists {
			if !dead {
				// In-flight: hand back the live window, spawn nothing.
				target.WindowID = id
				return target, false, nil
			}
			// Dead window from a completed prior run (remain-on-exit on, any
			// exit status): relaunch argv IN the dead window (reap-on-rerun).
			// respawn-window, NOT kill-window +
			// new-window: the job window is usually the session's ONLY window,
			// and killing a session's last window kills the session out from
			// under the follow-up spawn (caught by the scratch-socket
			// integration test).
			respawnArgs := []string{"respawn-window", "-k", "-t", winTarget}
			respawnArgs = append(respawnArgs, argv...)
			if err := jobRunTmux(cmdCtx, respawnArgs...); err != nil {
				return target, false, fmt.Errorf("respawning dead %q job window: %w", window, err)
			}
			target.WindowID = id
			spawned = true
		}
	}

	if !spawned {
		// 4. Spawn into the existing session.
		spawnArgs := []string{"new-window", "-d", "-t", "=" + JobsSessionName + ":", "-n", window, "-P", "-F", "#{window_id}"}
		spawnArgs = append(spawnArgs, argv...)
		out, err := jobRunTmuxOutput(cmdCtx, spawnArgs...)
		if err != nil {
			return target, false, fmt.Errorf("spawning %q job window: %w", window, err)
		}
		target.WindowID = strings.TrimSpace(string(out))
	}

	// 5. Post-spawn window options — best-effort, warn-only.
	if err := jobRunTmux(cmdCtx, "set-option", "-w", "-t", winTarget, "remain-on-exit", "on"); err != nil {
		slog.Warn("job window remain-on-exit failed to set; the window will close on exit and its output will not persist on screen", "window", window, "err", err)
	}
	if logsDir, err := apphome.LogsDir(); err != nil {
		slog.Warn("job window log pipe skipped: state home unresolvable", "window", window, "err", err)
	} else {
		logPath := filepath.Join(logsDir, window+".log")
		if err := os.MkdirAll(logsDir, 0o755); err != nil {
			slog.Warn("job window log dir creation failed; the pipe-pane tee may not write", "window", window, "err", err)
		}
		// The one shell string in the spawn path — pipe-pane's command is shell-
		// interpreted by tmux. window passed the ValidateToolName class above
		// (no whitespace, quotes, or metacharacters), but the logs dir path is
		// arbitrary (e.g. under /Users/Jane Doe), so it is single-quoted for
		// the shell.
		if err := jobRunTmux(cmdCtx, "pipe-pane", "-o", "-t", winTarget, "cat >> "+shellq.Quote(logPath)); err != nil {
			slog.Warn("job window log pipe failed; output lives in scrollback only", "window", window, "err", err)
		}
	}

	return target, true, nil
}
