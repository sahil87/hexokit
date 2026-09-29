package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"rk/api"
	"rk/internal/config"
	"rk/internal/cron"
	"rk/internal/daemon"
	"rk/internal/homemigrate"
	"rk/internal/mcp"
	"rk/internal/portpolicy"
	"rk/internal/selfpath"
	"rk/internal/settings"
	"rk/internal/snapshot"
	"rk/internal/tmux"
	"rk/internal/tmuxctl"
	"rk/internal/updatecheck"

	"github.com/spf13/cobra"
)

// bootIDBytes is the number of random bytes behind the per-process boot id
// (16 hex chars = 8 bytes). Generated once per `rk serve` start; a fresh id on
// every restart lets an open tab detect a same-version restart and reload.
const bootIDBytes = 8

// newBootID returns a random hex boot id for this process, or an empty string
// if crypto/rand fails (the version slot then carries an empty boot — the
// reload guard simply never fires on boot, which degrades to version-only
// reload; no worse than before boot ids existed).
func newBootID() string {
	b := make([]byte, bootIDBytes)
	if _, err := rand.Read(b); err != nil {
		slog.Warn("boot id generation failed; boot-based reload disabled", "err", err)
		return ""
	}
	return hex.EncodeToString(b)
}

// resolveBrewInstalled reports whether this daemon binary is a Homebrew install,
// computed ONCE at startup (resolve the self path, test the Cellar marker).
// Best-effort: a resolve failure reports false (the palette's brew-gated
// force-update entry simply stays hidden, which is safe).
func resolveBrewInstalled() bool {
	selfPath, err := selfpath.Resolve()
	if err != nil {
		return false
	}
	return selfpath.IsBrewInstalled(selfPath)
}

// warnReservedPorts warns when the daemon port or its resolved code-server
// port lands inside a reserved block (reservedCollisions — dev builds exempt
// the rig block, where worktree dev/e2e rigs live by design). Warn-only,
// never refuse: a working daemon may already sit inside a block, so startup
// proceeds. Each warning names the actual colliding footprint port(s) —
// never the non-colliding sibling — and the env var(s) that move them.
func warnReservedPorts(cfg config.Config) {
	for _, b := range reservedCollisions(cfg) {
		ports, envVars := footprintSummary(blockFootprintHits(cfg, b))
		slog.Warn(fmt.Sprintf("port inside a reserved block — set %s outside it", strings.Join(envVars, " / ")),
			"ports", ports, "block", b.Name, "start", b.Start, "end", b.End)
	}
}

// Serve-time launcher re-point seams (the codeServerSelfPath package-var
// style): tests substitute fakes so no test touches real symlinks in $HOME.
var (
	serveResolveSelf    = selfpath.Resolve
	serveLauncherPath   = selfpath.Launcher
	serveLstat          = os.Lstat
	serveReadlink       = os.Readlink
	serveReplaceSymlink = selfpath.ReplaceSymlink
)

// repointLauncher re-points the rk-owned launcher symlink at the running
// daemon's resolved binary, so hooks keep execing a live rk through the
// post-upgrade window between Homebrew's keg cleanup and the daemon restart
// `rk update` performs (a manual `brew upgrade hexokit` re-points at the next
// daemon start). Daemon start is the only trigger — no timer, no watcher (the
// tmux.EnsureConfig posture). Brew-daemons only: a dev-worktree or e2e-rig
// `rk serve` must never re-point the machine's hooks at a throwaway build.
//
// Ownership rules: an ABSENT launcher is left absent (the installer owns
// creation), a non-symlink is the user's and never touched, and an
// already-current symlink is a no-op. Best-effort, never fatal — every error
// is a Warn and startup proceeds.
func repointLauncher(brewDaemon bool) {
	if !brewDaemon {
		return
	}
	launcher, err := serveLauncherPath()
	if err != nil {
		slog.Warn("launcher re-point skipped", "err", err)
		return
	}
	info, err := serveLstat(launcher)
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("launcher re-point skipped", "path", launcher, "err", err)
		}
		return
	}
	if info.Mode()&os.ModeSymlink == 0 {
		slog.Info("launcher is not rk-owned (not a symlink) — leaving it untouched", "path", launcher)
		return
	}
	current, err := serveReadlink(launcher)
	if err != nil {
		slog.Warn("launcher re-point skipped", "path", launcher, "err", err)
		return
	}
	resolved, err := serveResolveSelf()
	if err != nil {
		slog.Warn("launcher re-point skipped", "err", err)
		return
	}
	if current == resolved {
		return
	}
	if err := serveReplaceSymlink(resolved, launcher); err != nil {
		slog.Warn("launcher re-point failed", "path", launcher, "err", err)
		return
	}
	slog.Info("re-pointed launcher", "path", launcher, "from", current, "to", resolved)
}

const (
	// daemonLogDirMode is the permission used for `os.MkdirAll` on the daemon
	// log's parent directory.
	daemonLogDirMode = 0o755
	// daemonLogFileMode is the permission used when creating the daemon log file.
	daemonLogFileMode = 0o644
)

// setupSlog constructs the default slog logger. When RK_DAEMON_LOG (from env)
// is set and the file can be opened for append, slog output is teed to both
// os.Stderr and the log file via io.MultiWriter. On any error (UserCacheDir
// failure upstream, mkdir failure, open failure) we fall back to stderr-only
// and emit a single slog.Warn so the operator can see the failure mode but
// HTTP serving still proceeds — diagnostic logging MUST NOT block startup.
func setupSlog(level slog.Level) *slog.Logger {
	var out io.Writer = os.Stderr
	logPath := os.Getenv(daemon.LogEnvVar)
	var openErr error
	if logPath != "" {
		if err := os.MkdirAll(filepath.Dir(logPath), daemonLogDirMode); err != nil {
			openErr = err
		} else {
			f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, daemonLogFileMode)
			if err != nil {
				openErr = err
			} else {
				out = io.MultiWriter(os.Stderr, f)
			}
		}
	}

	logger := slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: level}))
	if openErr != nil {
		logger.Warn("daemon log unavailable", "path", logPath, "err", openErr)
	}
	return logger
}

// migrateHomes is the homemigrate.Migrate seam for the dev-gate test.
var migrateHomes = homemigrate.Migrate

// daemonPortBusyFn probes whether something already listens on the resolved
// daemon port — the migration-deferral guard's seam (tests stub it).
var daemonPortBusyFn = daemon.PortBusy

// migrateHomesUnlessDev runs the one-time run-kit → hexokit home migration at
// daemon start — before config.Load and tmux.EnsureConfig read anything — and
// then re-resolves the tmux managed-conf path: tmux.DefaultConfigPath was
// fixed at package init, before the migration could publish, so the first
// post-upgrade boot must re-resolve or EnsureConfig would manage the legacy
// file. Dev builds (version == "dev": just dev/air and the e2e rigs) skip the
// migration entirely — a worktree rig shares the developer's real legacy home
// with the live brew daemon, so a rig must never freeze a stale copy of it
// for the real upgrade (the same gate reserved.go uses).
//
// The publish is also DEFERRED while the daemon port is already bound: that
// listener is a live daemon (after a brew upgrade, typically the old binary,
// which runs in the same rk-daemon session) that keeps reading and writing
// the legacy home — a publish would hide it behind the new home's win in the
// dual-read rule, and this serve would then lose the bind and exit anyway.
// `rk daemon restart` stops the old serve before starting the new one, so the
// normal upgrade path finds the port free. Deferral is safe: the legacy home
// stays authoritative and the next clean start migrates.
func migrateHomesUnlessDev() {
	if version == "dev" {
		return
	}
	if daemonPortBusyFn() {
		slog.Warn("home migration deferred: the daemon port is already in use — restart the daemon (rk daemon restart) to migrate")
		return
	}
	migrateHomes(slog.Default())
	tmux.RefreshDefaultConfigPath()
}

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the HTTP server (foreground)",
	Long: fmt.Sprintf(`Start the HTTP server in the foreground.

Environment variables:
  RK_HOST      Host to bind (default "127.0.0.1")
  RK_PORT      Port to bind (default %[1]d)

Port resolution (lowest to highest): default %[1]d < 'port:' in
~/.config/hexokit/config.yaml < RK_PORT.

Examples:
  run-kit serve                              # foreground on 127.0.0.1:%[1]d
  RK_HOST=0.0.0.0 RK_PORT=8080 run-kit serve # bind all interfaces, port 8080

To run run-kit as a background daemon, see 'run-kit daemon start' (and the rest of the
'run-kit daemon' subcommand tree).`, portpolicy.DaemonDefault),
	RunE: func(cmd *cobra.Command, args []string) error {
		migrateHomesUnlessDev()
		cfg := config.Load()

		// Three-state managed tmux.conf refresh before starting (daemon start is
		// the only trigger — no timer, no watcher). The reload sweep runs ONLY
		// on an actual stale→force-write transition: reloading unchanged config
		// on every start would be wasted tmux traffic across every live server.
		refreshed, err := tmux.EnsureConfig()
		if err != nil {
			return fmt.Errorf("ensuring tmux config: %w", err)
		}
		// Brew detection is computed once for the whole startup; the launcher
		// re-point runs only on a brew daemon (a dev-worktree or e2e-rig serve
		// must never re-point the machine's hooks at a throwaway build). It runs
		// BEFORE the optional reload sweep below: the sweep can take up to 30 s,
		// and code-server bridge actions exec RK_BIN with no fallback, so a stale
		// launcher must be repaired first.
		selfBrew := resolveBrewInstalled()
		repointLauncher(selfBrew)
		if refreshed {
			sweepCtx, sweepCancel := context.WithTimeout(context.Background(), 30*time.Second)
			tmux.RefreshSweep(sweepCtx)
			sweepCancel()
		}

		// No startup sweep: relay ephemerals are gone (the relay attaches the PTY
		// directly to the real session), and board pin-sessions (`_rk-pin-*`) are
		// PERSISTENT across rk restarts (Constitution VI — tmux survives the
		// server). A persisted pin is valid state, not an orphan, so there is
		// nothing to reap. Isolated relay sessions (`_rk-iso-*`) reap themselves
		// via destroy-unattached; one left client-less by a daemon death between
		// ensure and attach is reused by the next isolated open of its window.

		// Log level: the LOG_LEVEL env is an undocumented per-process escape
		// that wins when set (the dev rig depends on it); otherwise the
		// log_level config.yaml key applies. "debug" enables debug, anything
		// else is info.
		logLevel := slog.LevelInfo
		if l := os.Getenv("LOG_LEVEL"); l != "" {
			if strings.EqualFold(l, "debug") {
				logLevel = slog.LevelDebug
			}
		} else if strings.EqualFold(settings.Load().LogLevel, "debug") {
			logLevel = slog.LevelDebug
		}
		logger := setupSlog(logLevel)
		slog.SetDefault(logger)

		// After slog.SetDefault so the warning rides the configured logger
		// (incl. the RK_DAEMON_LOG tee): daemon-start stderr is invisible on
		// the desktop "Start & connect" and `rk update` restart paths.
		warnReservedPorts(cfg)

		// Below-floor tmux warning, after slog.SetDefault so it rides the
		// configured logger (incl. the RK_DAEMON_LOG tee): the daemon-start
		// stderr warning is invisible on the desktop "Start & connect" and
		// `rk update` restart paths. Unknown versions log nothing.
		vctx, vcancel := context.WithTimeout(context.Background(), tmux.TmuxTimeout)
		v, vok := tmuxVersionProbe(vctx)
		vcancel()
		if vok && v.BelowFloor() {
			slog.Warn(tmux.UpgradeHint(runtime.GOOS, exec.LookPath, v.Raw))
		}

		// Graceful shutdown via SIGINT/SIGTERM
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()

		// Process start feeds the version slot's `started` field (the host
		// page's daemon uptime readout). Captured before the router so the
		// whole boot sequence counts toward uptime.
		started := time.Now().Unix()

		router, apiServer := api.NewRouterAndServer(ctx, logger, cfg)

		// Expose the running version to clients over SSE (server-global
		// `event: version`, replayed on connect) and wire the periodic update
		// checker: it polls the shll.ai versions manifest on a background tick
		// and, when any toolkit tool crosses its notify threshold (or a prior
		// match clears), broadcasts a server-global
		// `event: update-available`. Both surfaces drive the web UI's update chip
		// and the post-restart auto-reload. The checker suppresses itself for the
		// "dev" sentinel / unparseable versions and is bound to the serve context.
		apiServer.SetVersion(version, newBootID(), selfBrew, started, cfg.Port)
		updateChecker := updatecheck.New(version, selfBrew)
		updateChecker.OnQualify = apiServer.WireUpdateAvailableBroadcast()
		updateChecker.Start(ctx)
		apiServer.SetUpdateChecker(updateChecker)

		// /mcp — the streamable-HTTP transport over the same policy table and
		// executor `rk mcp` serves on stdio. See wireMCP.
		wireMCP(ctx, cmd, apiServer, cfg, version, logger)

		// Start the tmuxctl supervisor AFTER tmux.EnsureConfig() (above) and
		// BEFORE the HTTP listen, so the SSE hub never races an empty Client map
		// for sockets that already exist on disk.
		//
		// Per-socket Open failures (PTY unavailable, etc.) are logged
		// inside the Supervisor and never block startup.
		supervisor := tmuxctl.NewSupervisor(api.NewHubSinkFactory())

		// Inject this deployment's origin (derived from the same config the
		// server binds with) so every supervisor dial stamps @rk_srv_origin on the
		// covered tmux server — pane-side `rk url`/`rk notify` resolve it from
		// there. The startup enumeration covers pre-existing servers (healing
		// the value across restarts on a new port); fsnotify dials cover births.
		tmuxctl.SetStampOrigin(fmt.Sprintf("http://%s:%d", cfg.Host, cfg.Port))

		// Layout snapshotter: periodically persists per-covered-server layout
		// snapshots (disaster-recovery backups; the /api/recovery endpoints are
		// the sanctioned read-only reader — live state never derives from a
		// snapshot) and tombstones a server's last snapshot when its socket is
		// removed.
		// Wired BEFORE supervisor.Start so the removal callback can never miss
		// an early socket removal. Best-effort throughout: a store-dir
		// resolution failure disables snapshotting with a warning — it must
		// never block serving.
		// snapStore is hoisted so the cron ticker's session respawner below
		// reads the SAME ring the snapshotter writes (nil ⇒ the seam stays
		// unwired and the notify degrade stands).
		var snapStore *snapshot.Store
		if snapDir, err := snapshot.DefaultDir(); err != nil {
			slog.Warn("layout snapshots disabled: state dir unresolvable", "err", err)
		} else {
			snapshot.MigrateLegacyDir(snapDir)
			snapStore = snapshot.NewStore(snapDir)
			snapshotter := snapshot.NewSnapshotter(supervisor, snapStore)
			supervisor.OnSocketRemoved = snapshotter.OnServerRemoved
			apiServer.SetServerKillNotifier(snapshotter.NoteAuditedKill)
			// The recovery endpoints read from the SAME store the snapshotter
			// writes to, so /api/recovery offers exactly what was persisted.
			apiServer.SetSnapshotStore(snapStore)
			snapshotter.Start(ctx)
		}

		// Cron ticker: the cron evaluator's daemon invoker — an isolated
		// goroutine sharing no locks with the serving path, gated per
		// iteration by the cron_ticker setting. Best-effort like the
		// snapshotter: a state-dir resolution failure disables ticking with a
		// warning — it must never block serving.
		if cronDir, err := cron.DefaultDir(); err != nil {
			slog.Warn("cron ticker disabled: state dir unresolvable", "err", err)
		} else {
			deps := cron.Deps{Dir: cronDir, Deliverer: cron.NewEngineDeliverer()}
			if snapStore != nil {
				// Session respawn needs the recently-closed ring (R8): wire
				// it only when the store resolved, else the nil-seam notify
				// degrade stands byte-identical.
				deps.SessionRespawner = rkCronRespawnSession(snapStore)
			}
			cron.NewTicker(deps).Start(ctx)
		}

		if err := supervisor.Start(ctx); err != nil {
			slog.Warn("tmuxctl supervisor failed to start; falling back to safety-net poll", "err", err)
		} else {
			apiServer.SetWindowChangeSubscriber(api.NewSupervisorSubscriber(supervisor))
			// Thread the per-socket active-window trackers into the fetch path
			// so FetchSessions derives isActiveWindow from control-mode events
			// (Tier 1), falling back to the base pointer (Tier 2) per group.
			apiServer.SetActiveWindowProvider(supervisor)
		}

		addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
		server := &http.Server{
			Addr:    addr,
			Handler: router,
		}

		go func() {
			slog.Info("server starting", "addr", addr)
			if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				slog.Error("server error", "err", err)
				os.Exit(1)
			}
		}()

		<-ctx.Done()
		slog.Info("shutting down...")

		// Stop the supervisor first (bounded 5s) so all control-mode
		// connections close cleanly before the HTTP server shuts down.
		// Stop errors are logged but do not block shutdown — matches the
		// daemon-log graceful-degradation pattern from PR #197.
		supCtx, supCancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := supervisor.Stop(supCtx); err != nil {
			slog.Warn("tmuxctl supervisor stop error", "err", err)
		}
		supCancel()

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if err := server.Shutdown(shutdownCtx); err != nil {
			slog.Error("shutdown error", "err", err)
		}

		return nil
	},
}

// wireMCP builds the MCP server from the live Cobra tree and mounts its
// streamable-HTTP handler on /mcp. Fail-soft: a table that cannot resolve is
// a defect `rk doctor`'s mcp row already reports, and the daemon must still
// come up (Constitution VI posture — availability first); the route then
// answers 503 until a fixed binary is restarted. The tailscale probe inside
// LiveTailnetIdentity is the only subprocess this adds to daemon start — a
// bounded argv exec (Constitution I / Process Execution).
//
// The root arrives via cmd.Root() rather than the rootCmd package var:
// rootCmd's no-args default delegates here (rootCmd → serveCmd), so a package
// var reference back would be an initialization cycle.
//
// Exe is os.Executable() for parity with `rk mcp`: every upgrade path
// (`rk update`, POST /api/update) restarts the daemon, so the running
// binary's own path is the right verb executable for its lifetime.
func wireMCP(ctx context.Context, cmd *cobra.Command, apiServer *api.Server, cfg config.Config, version string, logger *slog.Logger) {
	exe, _ := os.Executable()
	mcpServer, err := mcp.New(mcp.Config{Root: cmd.Root(), Exe: exe, Version: version, Instructions: string(skillBundle), Logger: logger})
	if err != nil {
		slog.Warn("mcp: /mcp disabled — policy table did not resolve", "err", err)
		return
	}
	hostname, _ := os.Hostname()
	addrs, _ := net.InterfaceAddrs()
	tailnet := mcp.LiveTailnetIdentity(ctx)
	policy := mcp.NewOriginPolicy(mcp.DeriveAllowedOrigins(cfg.Host, cfg.Port, hostname, addrs, tailnet))
	slog.Info("mcp: /mcp mounted", "tools", len(mcpServer.Tools()), "origins", policy.Origins())
	apiServer.SetMCPHandler(mcpServer.HTTPHandler(policy, logger))
}
