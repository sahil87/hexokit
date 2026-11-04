package daemon

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"rk/internal/config"
	"rk/internal/ports"
	"rk/internal/tmux"
)

const (
	// ServerSocket is the tmux server socket for the daemon (separate from agent sessions).
	ServerSocket = "rk-daemon"
	// SessionName is the tmux session name for the daemon. Matches the socket
	// name so the combined exact-match target (=rk-daemon) is unambiguous and
	// cannot collide with user-facing sessions via tmux prefix matching.
	SessionName = "rk-daemon"
	// LegacySessionName is the pre-rename session name. Stop/Restart consult
	// this so a daemon started by an older binary can be shut down cleanly
	// during the first upgrade.
	LegacySessionName = "rk"
	// WindowName is the tmux window name where `rk serve` runs.
	WindowName = "serve"

	// cmdTimeout is the default timeout for one-shot tmux commands
	// (has-session, send-keys, kill-session, list-panes). Kept short so
	// probes like IsRunning() stay snappy.
	cmdTimeout = 5 * time.Second

	// LogEnvVar is the env var the daemonized inner serve reads to learn that
	// it should tee slog output to a file in addition to stderr. Set by
	// startSession on the inner `rk serve` invocation, read by cmd/rk/serve.go.
	// Exported as the single source of truth so cmd/rk does not duplicate the
	// literal.
	LogEnvVar = "RK_DAEMON_LOG"
	// daemonLogDirName is the subdirectory under os.UserCacheDir() that holds
	// the daemon log file.
	daemonLogDirName = "rk"
	// daemonLogFilename is the basename of the daemon log file.
	daemonLogFilename = "daemon.log"
	// portProbeTimeout bounds the net.DialTimeout liveness probe added before
	// daemon startup. Long enough to absorb scheduler jitter on a loaded host,
	// short enough to keep `rk serve -d` snappy.
	portProbeTimeout = 400 * time.Millisecond
	// localhostAddr is the loopback substitution target for wildcard/empty hosts.
	localhostAddr = "127.0.0.1"
)

// target returns the tmux target string for the daemon's window, with both
// session and window segments anchored (`=`) so tmux performs exact-match
// instead of prefix-match lookup.
func target() string {
	return targetFor(SessionName)
}

// targetFor returns an exact-match window target for the given session name.
func targetFor(session string) string {
	return "=" + session + ":=" + WindowName
}

// serverSocket is the variable form of ServerSocket — overridable in tests so
// integration tests can exercise IsRunning/Stop against an isolated socket
// without touching a production daemon.
var serverSocket = ServerSocket

// stopGracePeriod bounds Stop()'s wait for the inner `rk serve` to exit after
// C-c. It must exceed the inner serve's combined graceful-shutdown budget —
// supervisor stop (5s) + server.Shutdown (5s) in cmd/rk/serve.go, run
// sequentially, ~10s worst case — plus margin for C-c keystroke delivery and
// tmux round-trips. It feeds Stop()'s grace-deadline timer (NOT a context
// bounding the operation); each individual tmux command keeps the shorter
// cmdTimeout. A var (not const) so tests can shrink it to deterministically
// drive Stop()'s timeout/kill branch without burning the full grace period of
// wall-clock — mirroring the serverSocket test seam.
var stopGracePeriod = 12 * time.Second

// stopPollInterval is how often Stop() checks whether the session has
// disappeared. A var (not const) for the same test-seam reason as
// stopGracePeriod: tests shrink it so the poll loop reacts quickly relative to
// a shrunken grace period.
var stopPollInterval = 200 * time.Millisecond

// runTmux executes a tmux command on the daemon server, capturing stderr for diagnostics.
func runTmux(ctx context.Context, args ...string) error {
	return runTmuxInDir(ctx, "", args...)
}

// runTmuxInDir is runTmux with a working-directory override for the tmux
// client process (empty dir inherits the daemon's own CWD, preserving
// runTmux's historical behavior). Server-birth-capable invocations
// (startSession's new-session, which starts the rk-daemon tmux server) pass
// tmux.ServerBirthDir() so the born server — which keeps its first client's
// CWD for life — never sits on rk's own, possibly-later-deleted, CWD.
func runTmuxInDir(ctx context.Context, dir string, args ...string) error {
	fullArgs := append([]string{"-L", serverSocket}, args...)
	return tmux.Run(ctx, fullArgs, tmux.RunOpts{Dir: dir})
}

// runTmuxOutput executes a tmux command on the daemon server, returning stdout
// on success and capturing stderr for diagnostics on failure.
func runTmuxOutput(ctx context.Context, args ...string) ([]byte, error) {
	fullArgs := append([]string{"-L", serverSocket}, args...)
	return tmux.RunOutput(ctx, fullArgs, tmux.RunOpts{})
}

// sessionExistsCtx returns true if a session with the exact given name exists
// on the daemon socket. The `=` prefix forces exact-match lookup so a prefix
// like "rk" cannot accidentally match "rk-relay-*" or "rk-daemon".
func sessionExistsCtx(ctx context.Context, name string) bool {
	return runTmux(ctx, "has-session", "-t", "="+name) == nil
}

// sessionExists is the context-free form of sessionExistsCtx: it runs the
// liveness probe under its own fresh cmdTimeout context. Stop() uses this for
// every poll/re-probe so no liveness check ever inherits a near-expired
// deadline from the grace period — a stale context would error and be misread
// as "session gone".
func sessionExists(name string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	return sessionExistsCtx(ctx, name)
}

// runningSessionCtx returns the name of the live daemon session — preferring
// the current SessionName, falling back to LegacySessionName for daemons
// started by older binaries. Returns "" if neither exists.
func runningSessionCtx(ctx context.Context) string {
	if sessionExistsCtx(ctx, SessionName) {
		return SessionName
	}
	if sessionExistsCtx(ctx, LegacySessionName) {
		return LegacySessionName
	}
	return ""
}

// isRunningCtx reports whether any (current-or-legacy) daemon session exists.
func isRunningCtx(ctx context.Context) bool {
	return runningSessionCtx(ctx) != ""
}

// IsRunning returns true if the daemon tmux session exists (under the current
// or legacy name).
func IsRunning() bool {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()

	return isRunningCtx(ctx)
}

// probeHost applies loopback substitution to a configured bind host. A serve
// bound to a wildcard (`0.0.0.0`, empty string, or IPv6 `::`) is reachable on
// loopback, so we dial 127.0.0.1 — dialing `0.0.0.0` itself is platform-
// inconsistent and not a reliable liveness signal. Any literal host is
// returned unchanged.
func probeHost(host string) string {
	switch host {
	case "", "0.0.0.0", "::", "[::]", "[::1]":
		return localhostAddr
	}
	return host
}

// portInUse reports whether host:port is currently accepting TCP connections.
// Uses net.DialTimeout with portProbeTimeout — a successful dial means
// something is listening; any error (refused, timeout, DNS failure) is treated
// as "port free" so the daemon proceeds to startSession. The dial target is
// resolved through probeHost so wildcard binds are detected on loopback.
func portInUse(host string, port int) bool {
	addr := net.JoinHostPort(probeHost(host), strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, portProbeTimeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// PortBusy reports whether the resolved daemon RK_HOST:RK_PORT already has a
// listener — the serve-start home migration's live-daemon guard. Before the
// migration, config.Load resolves an existing install's virtually pinned
// port, which is exactly the port a still-running old-binary daemon holds.
func PortBusy() bool {
	cfg := config.Load()
	return portInUse(cfg.Host, cfg.Port)
}

// guardPortAvailable refuses daemon startup when the configured RK_HOST:RK_PORT
// already has a listener that is not the daemon itself. Runs AFTER IsRunning()
// in Start/StartWithBinary so the "daemon already running" path takes priority.
// The error message intentionally contains the substrings `already serving on`,
// `not under the rk-daemon`, and `RK_PORT` so scripts can pattern-match the
// refusal mode.
func guardPortAvailable() error {
	cfg := config.Load()
	if !portInUse(cfg.Host, cfg.Port) {
		return nil
	}
	return fmt.Errorf(
		"something is already serving on %s:%d, but not under the rk-daemon tmux session "+
			"(likely a foreground `rk serve`, or another process holding the port). "+
			"Stop it first, or set a different port (port: in ~/.config/hexokit/config.yaml, or RK_PORT).",
		probeHost(cfg.Host), cfg.Port,
	)
}

// reapStaleDaemonSocket kills any leftover daemon session (current and legacy
// names, exact-match) on the rk-daemon socket. It is a race-window safety net:
// Start/StartWithBinary call it only after IsRunning() returned false, so in
// the common path both kills are no-ops against sessions that are already
// absent. It MUST target sessions, never the server — the rk-daemon socket is
// multi-tenant (rk-jobs, rk-code-server, rk-remotes are sibling sessions that
// deliberately outlive the daemon), and the historical `kill-server` here
// destroyed all of them on every restart: the rk-jobs update window SIGHUPed
// itself mid-`shll update` and ensureCodeServer never ran, so code-server was
// absent after every auto-update (the 260813 bug). Goes through runTmux so it
// inherits the existing exec.CommandContext + timeout enforcement and stays
// scoped to serverSocket (never touches the agent-session `runkit` server).
// Idempotent — `kill-session` against a missing session or dead server errors
// ("can't find session", "no server running on …"), which we suppress to
// slog.Debug because it is the common happy-path case. Real failures are also
// logged at Debug and never block startup; if anything is genuinely broken,
// the subsequent startSession call will surface it.
func reapStaleDaemonSocket(ctx context.Context) {
	for _, session := range []string{SessionName, LegacySessionName} {
		slog.Warn("tmux teardown", "audit", "kill", "op", "kill-session", "server", serverSocket, "target", session, "callers", "daemon.reapStaleDaemonSocket")
		if err := runTmux(ctx, "kill-session", "-t", "="+session); err != nil {
			slog.Debug("daemon session reap finished with error", "session", session, "err", err)
		}
	}
}

// KillServer kills the ENTIRE tmux server on the daemon socket — the daemon
// session and every sibling (rk-jobs, rk-code-server, rk-remotes, the _rk-ctl
// anchor). This is the opt-in "full restart" primitive behind
// `rk daemon restart --full`; ordinary restarts stay session-scoped
// (reapStaleDaemonSocket) per the 260813 sibling-kill lesson. Delegates to
// tmux.KillServer (which emits the killAudit teardown line and runs under its
// own timeout) and widens its dead-server tolerance: a socket with no live
// server is success — the caller's next step is birthing a fresh one anyway.
// Uses the serverSocket var (not the constant) to honor the test seam.
//
// Release-synchronous w.r.t. the code-server port: when an rk-code-server
// sibling existed pre-kill, the kill's SIGHUP leaves the node process seconds
// from unbinding, so KillServer runs the bounded port-free wait before
// returning — a Start() composed right after can no longer misclassify the
// dying instance as externally managed. The wait is CONDITIONAL on the sibling
// having existed: when it never did, a busy code-server port belongs to a
// genuinely externally managed instance that will not release it, and waiting
// would burn the full timeout on every full restart.
func KillServer() error {
	probeCtx, probeCancel := context.WithTimeout(context.Background(), cmdTimeout)
	hadCodeServer := codeServerSessionExists(probeCtx)
	probeCancel()

	err := tmux.KillServer(serverSocket)
	if err != nil && tmux.IsServerGone(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if hadCodeServer {
		waitForCodeServerPortFree()
	}
	return nil
}

// daemonTmuxLookPath resolves tmux on PATH for the Start/StartWithBinary
// precheck. Package-level so tests can simulate a tmux-less host (the
// codeServerLookPath idiom).
var daemonTmuxLookPath = exec.LookPath

// daemonTmuxVersion probes the PATH tmux version for the below-floor start
// warning (the daemonTmuxLookPath seam idiom).
var daemonTmuxVersion = tmux.CurrentVersion

// daemonWarnWriter receives the once-at-start below-floor warning — stderr
// in production, a buffer in tests.
var daemonWarnWriter io.Writer = os.Stderr

// checkTmuxPresent fails fast when tmux is absent from PATH, with a
// remediation hint instead of the raw exec wrap that a missing binary would
// otherwise surface mid-operation. It runs before IsRunning, the port guard,
// and the stale-socket reap — all of which shell out to tmux. The same
// lookPath drives the package-manager probe so a stubbed host yields a
// deterministic hint in tests.
//
// A present tmux additionally gets the version floor check: below floor
// prints one warning and continues (warn-don't-block — only remote tunnels
// hard-require ≥ 3.4); unknown versions neither warn nor block.
func checkTmuxPresent() error {
	if _, err := daemonTmuxLookPath("tmux"); err != nil {
		return fmt.Errorf("tmux not found on PATH — the run-kit daemon runs inside a tmux session; %s (or run `rk doctor` for a full dependency check)",
			tmux.InstallHint(runtime.GOOS, daemonTmuxLookPath))
	}
	warnTmuxBelowFloor()
	return nil
}

// warnTmuxBelowFloor prints the shared upgrade message once at daemon start
// when the PATH tmux parses below the supported floor. Blocking start would
// brick currently-working setups the moment rk upgrades, so this only warns.
func warnTmuxBelowFloor() {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	v, ok := daemonTmuxVersion(ctx)
	if !ok || !v.BelowFloor() {
		return
	}
	fmt.Fprintln(daemonWarnWriter, tmux.UpgradeHint(runtime.GOOS, daemonTmuxLookPath, v.Raw))
}

// Start creates a new daemon tmux session running `rk serve`.
// The command is passed directly to new-session so the session exits when the server exits.
// Uses os.Executable to resolve the current binary, so a locally-built binary restarts itself
// rather than whichever `rk` happens to be in $PATH.
// Returns an error if a daemon is already running, or if the configured port is
// already held by another process (e.g. a foreground `rk serve`).
func Start() error {
	if err := checkTmuxPresent(); err != nil {
		return err
	}
	if IsRunning() {
		return fmt.Errorf("daemon already running")
	}
	if err := guardPortAvailable(); err != nil {
		return err
	}

	reapCtx, reapCancel := context.WithTimeout(context.Background(), cmdTimeout)
	reapStaleDaemonSocket(reapCtx)
	reapCancel()

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolving executable path: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return fmt.Errorf("resolving executable symlinks: %w", err)
	}

	return startSession(exe)
}

// StartWithBinary creates a new daemon tmux session using the provided binary path.
// The binPath is resolved via filepath.EvalSymlinks before use, so callers can pass
// a symlink (e.g. the Homebrew bin symlink) that points to the current version.
// Use this instead of Start when the running process's os.Executable path may be stale
// (e.g. after brew upgrade deletes the old Cellar directory).
// Inherits the same port-availability + stale-socket-reap guards as Start.
func StartWithBinary(binPath string) error {
	if err := checkTmuxPresent(); err != nil {
		return err
	}
	if IsRunning() {
		return fmt.Errorf("daemon already running")
	}
	if err := guardPortAvailable(); err != nil {
		return err
	}

	reapCtx, reapCancel := context.WithTimeout(context.Background(), cmdTimeout)
	reapStaleDaemonSocket(reapCtx)
	reapCancel()

	exe, err := filepath.EvalSymlinks(binPath)
	if err != nil {
		return fmt.Errorf("resolving executable symlinks: %w", err)
	}

	return startSession(exe)
}

// startSession creates the daemon tmux session with the given resolved binary path.
// When os.UserCacheDir() resolves successfully, the inner serve is spawned with
// RK_DAEMON_LOG=<cache>/rk/daemon.log in its environment so it can tee slog
// output to a durable log file (read by cmd/rk/serve.go). On UserCacheDir
// failure we proceed without the env var — file logging is best-effort and
// MUST NOT block daemon creation.
//
// The new-session runs with its working directory pinned to
// tmux.ServerBirthDir() (home, fallback "/"): this call BIRTHS the rk-daemon
// tmux server, and a tmux server keeps the CWD of the process that first
// touches its socket for its whole life. Without the pin the server inherits
// wherever the user ran `rk daemon start` — often a git worktree that is later
// deleted, leaving the server on a dead inode (on tmux 3.7 that silently
// breaks `-c` for every new pane). This is the highest-leverage pin: the inner
// `rk serve` runs inside this session, so its own CWD (home, via the session's
// default start dir) is what every later server birth would inherit. `rk
// serve` is CWD-independent (config comes from config.yaml + env, the exe is
// absolute), so running it from home is safe.
//
// The resolved deployment binding (RK_PORT, RK_HOST, and RK_CODE_SERVER_PORT
// when overridden) is passed to the new session explicitly via -e, resolved in
// THIS process at call time: the rk-daemon tmux server is long-lived
// (sibling sessions and the _rk-ctl anchor keep it up across ordinary
// restarts) and builds a new session's environment from the global
// environment it was born with, not from the calling client — without -e a
// respawned serve would re-read a stale born-with value. Always passed, so the
// born-with value can never win. Before the birth, syncServerDeploymentEnv
// mirrors the caller's raw deployment env into a LIVE server's global
// environment, so rk-jobs windows (UI update/restart, rk daemon run) — whose
// env comes from the server's global env — re-resolve the same binding.
func startSession(exe string) error {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()

	cfg := config.Load()
	// The sync gets its own bounded context: it is best-effort and must never
	// consume the session-creation deadline below (a probe or set-environment
	// call spending the shared budget would make new-session run with an
	// expired context and fail the start).
	syncCtx, syncCancel := context.WithTimeout(context.Background(), cmdTimeout)
	syncServerDeploymentEnv(syncCtx)
	syncCancel()

	args := []string{"new-session"}
	if logPath, ok := resolveDaemonLogPath(); ok {
		args = append(args, "-e", LogEnvVar+"="+logPath)
	}
	args = append(args, "-e", config.PortEnvVar+"="+strconv.Itoa(cfg.Port))
	args = append(args, "-e", config.HostEnvVar+"="+cfg.Host)
	// RK_CODE_SERVER_PORT passes only when an explicit override is set:
	// passing the +2 convention value would turn the convention into an
	// override.
	if cfg.CodeServerPort != 0 {
		args = append(args, "-e", config.CodeServerPortEnvVar+"="+strconv.Itoa(cfg.CodeServerPort))
	}
	args = append(args, "-d", "-s", SessionName, "-n", WindowName, exe, "serve")

	// Create a detached tmux session that runs the resolved binary directly.
	// When the serve process exits, the session closes automatically.
	if err := runTmuxInDir(ctx, tmux.ServerBirthDir(), args...); err != nil {
		return fmt.Errorf("creating tmux session: %w", err)
	}

	// Stamp the newborn server managed (belt-and-braces beside the
	// IsManagedServer name-derivation). Best-effort: a stamp failure degrades
	// the server to external for conf-pushing only and never fails daemon
	// start. Fresh ctx — the birth ctx above may be near-spent.
	stampCtx, stampCancel := context.WithTimeout(context.Background(), cmdTimeout)
	if err := tmux.MarkServerManaged(stampCtx, serverSocket); err != nil {
		slog.Warn("daemon server managed stamp failed", "server", serverSocket, "err", err)
	}
	stampCancel()

	// Bring up the managed code-server beside the daemon (260811-a2bo).
	// Best-effort and re-entrant: an absent binary or a spawn failure warns
	// and NEVER fails daemon start — the dashboard must come up regardless.
	ensureCodeServer()

	// Bring up the rk-gui supervisor beside the daemon. Same best-effort
	// posture; the gui.enabled gate inside ensureGUI is the first rung, so a
	// default install issues zero gui tmux commands.
	ensureGUI()

	return nil
}

// syncServerDeploymentEnv mirrors the caller's raw RK_PORT / RK_HOST /
// RK_CODE_SERVER_PORT deployment env into the LIVE rk-daemon server's global
// environment: `set-environment -g KEY VALUE` when the caller has it set
// non-empty, otherwise `set-environment -gu KEY`. New sessions on a live
// server build their environment from the server's global env, not from the
// calling client, so without this mirror an rk-jobs window (the UI
// update/restart buttons, rk daemon run) would re-resolve with a stale
// born-with value and move the daemon back. Raw env is mirrored rather than
// the resolved value so config-only installs stay config-driven (a later
// config.yaml edit still applies from a job window), while an env-only
// install keeps its env port across updates. Skipped silently when no server
// is running — a birth takes the caller env verbatim anyway. Best-effort:
// failures log at Debug and never fail the start.
func syncServerDeploymentEnv(ctx context.Context) {
	if err := tmux.ServerAlive(ctx, serverSocket); err != nil {
		return
	}
	for _, key := range []string{config.PortEnvVar, config.HostEnvVar, config.CodeServerPortEnvVar} {
		if value := os.Getenv(key); value != "" {
			if err := runTmux(ctx, "set-environment", "-g", key, value); err != nil {
				slog.Debug("daemon server env sync failed", "key", key, "err", err)
			}
		} else if err := runTmux(ctx, "set-environment", "-gu", key); err != nil {
			slog.Debug("daemon server env unset failed", "key", key, "err", err)
		}
	}
}

// resolveDaemonLogPath returns the absolute path to the daemon log file and
// true on success. On any error (UserCacheDir unsupported on the host),
// emits a single slog.Warn and returns "", false so the caller can spawn the
// inner serve without RK_DAEMON_LOG — file logging is diagnostic, not
// load-bearing.
func resolveDaemonLogPath() (string, bool) {
	cache, err := os.UserCacheDir()
	if err != nil {
		slog.Warn("daemon log path unavailable", "err", err)
		return "", false
	}
	return filepath.Join(cache, daemonLogDirName, daemonLogFilename), true
}

// Stop delivers a graceful interrupt to the inner `rk serve` process and waits
// up to stopGracePeriod for it to exit. Delivery is signal-first — SIGINT
// straight to the pane's process (what a C-c keystroke would raise via the
// tty) — with tmux key delivery as the fallback, then the grace-timeout
// kill-session fallback. The grace period covers the inner `rk serve`'s
// worst-case graceful shutdown (supervisor stop + server.Shutdown, sequential
// ~10s) so a healthy shutdown is never misclassified as hung.
//
// The grace deadline is an independent timer, NOT a context bounding the whole
// operation: every tmux command (initial lookup, C-c send, each liveness poll,
// the kill) gets its own fresh cmdTimeout-bounded context. This is deliberate —
// an earlier version bounded everything with one stopGracePeriod context, which
// (a) made every probe inherit a near-expired deadline as the grace period wound
// down, so a probe could fail on `context deadline exceeded` and be misread as
// "session gone", and (b) coupled the wall-clock deadline to command execution,
// leaving no seam to drive the timeout branch in tests. Separating the timer
// from per-command contexts fixes both.
//
// Returns nil if the daemon is not running, if it exits on its own within the
// grace period (graceful delivery worked), or if the session has already vanished by kill-time
// — a daemon that exited on its own is the success outcome, not a failure. Only
// a session that is still alive AND fails to die under kill-session surfaces an
// error. Targets a legacy-named daemon (SessionName == LegacySessionName)
// transparently so users upgrading from older binaries can stop/restart without
// manual cleanup.
func Stop() error {
	// Initial lookup under its own fresh cmdTimeout context.
	lookupCtx, lookupCancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer lookupCancel()

	session := runningSessionCtx(lookupCtx)
	if session == "" {
		return nil
	}

	// Graceful delivery is signal-first: SIGINT straight to the inner serve
	// process. The pane runs the serve binary directly (startSession passes it
	// as the new-session command, no shell wrapper), so pane_pid IS the serve
	// process, and SIGINT is exactly what a delivered C-c would raise via the
	// tty. Key-based delivery stays the fallback, not the primary path: the
	// session's usual sole client is run-kit's own `-CC` control bridge (now
	// writable — see internal/tmuxctl productionDial), but a user-attached
	// read-only client can still be resolved as send-keys' target and rejected
	// ("client is read-only", on tmux ≥3.7 outright), and a pane sitting in a
	// mode routes C-c into the mode key table instead of the process (copy-mode
	// binds C-c → cancel). Signaling the PID bypasses both. Both delivery
	// mechanisms are best-effort and MUST NOT early-return: any failure falls
	// through to the grace-timer/kill-session fallback below, keeping the
	// "graceful interrupt → wait grace → kill" contract reachable regardless of
	// why delivery fails (an early return here wedges restart, rk update, and
	// POST /api/restart).
	delivered := false
	if pid, err := innerServePIDForFn(session); err != nil {
		slog.Warn("daemon stop: inner serve PID unresolved; falling back to tmux C-c delivery", "err", err)
	} else if err := signalPID(pid, syscall.SIGINT); err != nil {
		slog.Warn("daemon stop: SIGINT delivery failed; falling back to tmux C-c delivery", "pid", pid, "err", err)
	} else {
		delivered = true
	}

	if !delivered {
		// Fallback: tmux key delivery. Pre-cancel any pane mode first — a pane
		// in a mode does not receive C-c as a literal key (the mode key table
		// intercepts it; copy-mode binds C-c → cancel). `copy-mode -q` is
		// idempotent (exit 0 when the pane is not in a mode) so it runs
		// unconditionally. Each command gets its own fresh cmdTimeout context,
		// matching this function's per-command-context pattern, and targets
		// targetFor(session) so the legacy-session path stays correct.
		modeCtx, modeCancel := context.WithTimeout(context.Background(), cmdTimeout)
		defer modeCancel()
		if err := runTmux(modeCtx, "copy-mode", "-q", "-t", targetFor(session)); err != nil {
			slog.Debug("daemon stop: copy-mode pre-cancel failed", "err", err)
		}

		sendCtx, sendCancel := context.WithTimeout(context.Background(), cmdTimeout)
		defer sendCancel()
		if err := runTmux(sendCtx, "send-keys", "-t", targetFor(session), "C-c"); err != nil {
			slog.Warn("daemon stop: C-c send failed; relying on grace-timeout kill fallback", "err", err)
		}
	}

	// The grace deadline is an independent timer, NOT a context bounding the
	// operation. Each liveness poll runs under its own fresh cmdTimeout context
	// (via sessionExists) so no probe inherits a near-expired deadline.
	graceTimer := time.NewTimer(stopGracePeriod)
	defer graceTimer.Stop()

	for {
		select {
		case <-graceTimer.C:
			// Grace period elapsed. Re-probe under a fresh context: if the daemon
			// already exited on its own (graceful delivery worked), that's success — never kill
			// an absent session nor surface a `can't find session` error.
			if !sessionExists(session) {
				return nil
			}
			// Still alive — force-kill under its own fresh cmdTimeout context,
			// consistent with every other one-shot tmux command here.
			killCtx, killCancel := context.WithTimeout(context.Background(), cmdTimeout)
			defer killCancel()
			slog.Warn("tmux teardown", "audit", "kill", "op", "kill-session", "server", serverSocket, "target", session, "callers", "daemon.Stop(timeout)")
			if err := runTmux(killCtx, "kill-session", "-t", "="+session); err != nil {
				// kill-session errored. Re-confirm liveness under a fresh context:
				// if the session is now gone the kill effectively succeeded (or the
				// daemon raced to exit) — treat as success. Only a session that is
				// still alive after a failed kill is a genuine failure.
				if !sessionExists(session) {
					return nil
				}
				return fmt.Errorf("killing daemon session after timeout: %w", err)
			}
			return nil
		case <-time.After(stopPollInterval):
			if !sessionExists(session) {
				return nil
			}
		}
	}
}

// InnerServePID returns the PID of the `rk serve` process running inside the
// daemon tmux pane, derived from tmux's `pane_pid` format spec. Used by the
// `rk daemon` CLI surface to recognize the daemon as the port owner (so
// `--force` paths refuse to SIGTERM the daemon itself).
//
// Returns (0, error) when the daemon session is absent or the tmux query fails.
func InnerServePID() (int, error) {
	return innerServePIDFor(SessionName)
}

// innerServePIDFor is the session-parameterized form of InnerServePID: Stop()
// resolves the running session first (current or legacy name) and needs the
// pane PID of that specific session for signal-first graceful delivery.
func innerServePIDFor(session string) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()

	out, err := runTmuxOutput(ctx, "list-panes", "-t", targetFor(session), "-F", "#{pane_pid}")
	if err != nil {
		return 0, fmt.Errorf("querying daemon pane pid: %w", err)
	}
	s := string(bytes.TrimSpace(out))
	if s == "" {
		return 0, fmt.Errorf("no pane_pid returned for daemon target %s", targetFor(session))
	}
	pid, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("parsing pane_pid %q: %w", s, err)
	}
	return pid, nil
}

// innerServePIDFn is the package seam over InnerServePID so tests drive the
// OwnerIsDaemon self-recognition branch without a live daemon pane.
var innerServePIDFn = InnerServePID

// innerServePIDForFn is the package seam over innerServePIDFor so tests drive
// Stop()'s PID-unresolved fallback without a live daemon pane.
var innerServePIDForFn = innerServePIDFor

// signalPID delivers sig to pid. A seam so tests exercise Stop()'s
// signal-failure fallback without real processes.
var signalPID = func(pid int, sig syscall.Signal) error {
	return syscall.Kill(pid, sig)
}

// OwnerIsDaemon reports whether the port owner is the rk daemon's inner serve
// PID — the --force paths must never signal the daemon itself. An
// unresolvable inner PID is not proof of ownership: it reports false.
func OwnerIsDaemon(owner *ports.PortOwner) bool {
	pid, err := innerServePIDFn()
	if err != nil || pid <= 0 {
		return false
	}
	return pid == owner.PID
}
