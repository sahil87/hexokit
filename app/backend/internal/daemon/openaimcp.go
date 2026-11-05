package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"rk/internal/config"
	"rk/internal/openaimcp"
	"rk/internal/selfpath"
	"rk/internal/settings"
	"rk/internal/shellq"
)

const (
	// OpenAIMCPSessionName is the tmux session running OpenAI's tunnel-client
	// for the ChatGPT connector. A SIBLING session on the rk-daemon socket
	// (the rk-code-server / rk-gui precedent): it outlives `rk serve` exits,
	// so ChatGPT's tunnel survives a daemon restart.
	OpenAIMCPSessionName = "rk-openai-mcp"
	// OpenAIMCPWindowName is the single window inside the session; its pane
	// output is the tunnel-client log.
	OpenAIMCPWindowName = "tunnel"
	// OpenAIMCPInstallJobWindow is the rk-jobs window running the managed
	// install-then-start chain when no tunnel-client binary resolves.
	OpenAIMCPInstallJobWindow = "openai-mcp-install"
)

// OpenAIMCP status states, carried by the SSE `openai-mcp` event and the
// doctor row (docs/specs/openai-mcp.md § Status).
const (
	OpenAIMCPStateOff          = "off"
	OpenAIMCPStateUnconfigured = "unconfigured"
	OpenAIMCPStateInstalling   = "installing"
	OpenAIMCPStateStopped      = "stopped"
	OpenAIMCPStateStarting     = "starting"
	OpenAIMCPStateReady        = "ready"
	OpenAIMCPStateDegraded     = "degraded"
)

// errOpenAIMCPMissing is the CLI posture's missing-binary error; the daemon
// posture spawns the install job instead.
var errOpenAIMCPMissing = errors.New("tunnel-client is not installed; run `rk openai-mcp install`")

// The package seams below mirror the gui/code-server ones so tests drive
// every branch without a live tmux server, network, or real install.
var (
	openAIMCPSessionExists = func(ctx context.Context) bool {
		return sessionExistsCtx(ctx, OpenAIMCPSessionName)
	}
	openAIMCPSpawn = func(ctx context.Context, args ...string) error {
		return runTmux(ctx, args...)
	}
	openAIMCPKillRun = func(ctx context.Context, args ...string) error {
		return runTmux(ctx, args...)
	}
	openAIMCPLookPath = exec.LookPath
	openAIMCPRunJob   = func(ctx context.Context, window string, argv []string) (JobTarget, bool, error) {
		return RunJob(ctx, window, argv)
	}
	// openAIMCPSelfPath resolves the version-stable rk path for the install
	// job's chain (the code-server install job precedent).
	openAIMCPSelfPath = selfpath.Stable
	openAIMCPLayout   = openaimcp.DefaultLayout
	// openAIMCPInstallJobLive reports a live (not dead) install job window.
	openAIMCPInstallJobLive = func(ctx context.Context) bool {
		_, dead, exists := jobWindowState(ctx, jobTargetFor(OpenAIMCPInstallJobWindow))
		return exists && !dead
	}
	// openAIMCPHTTPGet probes tunnel-client's /readyz.
	openAIMCPHTTPGet = func(ctx context.Context, url string) (int, string, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return 0, "", err
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0, "", err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, openAIMCPDetailCap))
		return resp.StatusCode, string(body), nil
	}
)

// openAIMCPReadyTimeout bounds the /readyz probe; openAIMCPDetailCap caps the
// degraded detail carried to the UI.
const (
	openAIMCPReadyTimeout = 2 * time.Second
	openAIMCPDetailCap    = 200
)

// OpenAIMCPEnsureOutcome classifies how an ensure call ended so the CLI can
// print an outcome line; the daemon ignores it (warn-and-continue).
type OpenAIMCPEnsureOutcome int

const (
	// OpenAIMCPEnsureDisabled: openai_mcp.enabled is off. The zero value, so a
	// forgotten assignment never reads as a start.
	OpenAIMCPEnsureDisabled OpenAIMCPEnsureOutcome = iota
	// OpenAIMCPEnsureUnconfigured: on, but the tunnel ID or key is missing.
	OpenAIMCPEnsureUnconfigured
	// OpenAIMCPEnsureAlreadyRunning: the session exists.
	OpenAIMCPEnsureAlreadyRunning
	// OpenAIMCPEnsureInstallJobSpawned: no binary resolved; the rk-jobs
	// install-then-start chain was started (daemon posture only).
	OpenAIMCPEnsureInstallJobSpawned
	// OpenAIMCPEnsureStarted: the session was spawned.
	OpenAIMCPEnsureStarted
)

// openAIMCPEnsureOptions is one ensure posture.
type openAIMCPEnsureOptions struct {
	// strict returns failures as errors (CLI, API); otherwise they are logged
	// and the caller carries on (daemon start: the dashboard must come up).
	strict bool
	// installOnMissing starts the rk-jobs install-then-start chain when no
	// binary resolves; otherwise a missing binary is errOpenAIMCPMissing.
	installOnMissing bool
	// restartOnProfileChange restarts a running session whose derived profile
	// differs from the one on disk (a new port, host, or tunnel ID). Only
	// callers in the daemon's own deployment environment set it: a manual CLI
	// call from another shell may resolve a different RK_PORT and must not
	// move a working tunnel onto it.
	restartOnProfileChange bool
}

var (
	// openAIMCPDaemonStart is daemon start's posture.
	openAIMCPDaemonStart = openAIMCPEnsureOptions{installOnMissing: true, restartOnProfileChange: true}
	// openAIMCPFromDaemon is the posture of callers inside the daemon process:
	// the settings and key POSTs, and restart.
	openAIMCPFromDaemon = openAIMCPEnsureOptions{strict: true, installOnMissing: true, restartOnProfileChange: true}
	// openAIMCPFromCLI is `rk openai-mcp start`, including the install job's
	// own start: strict, never installs, never restarts a running session.
	openAIMCPFromCLI = openAIMCPEnsureOptions{strict: true}
)

// ensureOpenAIMCPCore is the shared ensure. The order is fixed: disabled,
// unconfigured, running session (left alone, or restarted when its profile
// changed and the posture allows), binary ladder (install job or
// errOpenAIMCPMissing), THEN write the profile and spawn.
func ensureOpenAIMCPCore(opts openAIMCPEnsureOptions) (OpenAIMCPEnsureOutcome, error) {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()

	s := settings.Load()
	if !s.OpenAIMCPEnabled {
		return OpenAIMCPEnsureDisabled, nil
	}
	fail := func(outcome OpenAIMCPEnsureOutcome, err error) (OpenAIMCPEnsureOutcome, error) {
		if opts.strict {
			return outcome, err
		}
		slog.Warn("chatgpt connector not started", "err", err)
		return outcome, nil
	}
	layout, err := openAIMCPLayout()
	if err != nil {
		return fail(OpenAIMCPEnsureUnconfigured, fmt.Errorf("resolving the connector state dir: %w", err))
	}
	if s.OpenAIMCPTunnelID == "" {
		return fail(OpenAIMCPEnsureUnconfigured, errors.New("no tunnel ID set; add it in Settings → ChatGPT connector"))
	}
	if !layout.KeySet() {
		return fail(OpenAIMCPEnsureUnconfigured, errors.New("no API key saved; add it in Settings → ChatGPT connector"))
	}
	cfg := config.Load()
	profile := openaimcp.ProfileInput{TunnelID: s.OpenAIMCPTunnelID, MCPURL: openaimcp.MCPURL(cfg.Host, cfg.Port)}

	if openAIMCPSessionExists(ctx) {
		if !opts.restartOnProfileChange {
			return OpenAIMCPEnsureAlreadyRunning, nil
		}
		changed, err := layout.WriteProfile(profile)
		if err != nil {
			return fail(OpenAIMCPEnsureAlreadyRunning, fmt.Errorf("writing the tunnel-client profile: %w", err))
		}
		if !changed {
			return OpenAIMCPEnsureAlreadyRunning, nil
		}
		slog.Info("chatgpt connector: profile changed; restarting tunnel-client")
		if err := killOpenAIMCPSession(ctx, layout); err != nil {
			return fail(OpenAIMCPEnsureAlreadyRunning, err)
		}
	}

	binary := resolveOpenAIMCPBinary(layout)
	if binary == "" {
		if !opts.installOnMissing {
			return OpenAIMCPEnsureUnconfigured, errOpenAIMCPMissing
		}
		if err := spawnOpenAIMCPInstallJob(ctx); err != nil {
			return fail(OpenAIMCPEnsureInstallJobSpawned, err)
		}
		return OpenAIMCPEnsureInstallJobSpawned, nil
	}

	if _, err := layout.WriteProfile(profile); err != nil {
		return fail(OpenAIMCPEnsureUnconfigured, fmt.Errorf("writing the tunnel-client profile: %w", err))
	}
	// A health.url left by a previous run names a dead port; the new
	// tunnel-client writes a fresh one once its listener binds.
	removeIfExists(layout.HealthURLPath())

	args := []string{
		"new-session", "-d",
		"-s", OpenAIMCPSessionName,
		"-n", OpenAIMCPWindowName,
		// tunnel-client prefers CONTROL_PLANE_API_KEY, then OPENAI_API_KEY,
		// over the profile's file: key. Stripping both makes the key saved in
		// Settings the only one it can use, whatever env the daemon inherited.
		"env", "-u", "CONTROL_PLANE_API_KEY", "-u", "OPENAI_API_KEY",
		binary, "run", "--profile-dir", layout.ProfileDir(), "--profile", openaimcp.ProfileName,
	}
	if err := openAIMCPSpawn(ctx, args...); err != nil {
		return fail(OpenAIMCPEnsureStarted, fmt.Errorf("spawning the %s session: %w", OpenAIMCPSessionName, err))
	}
	return OpenAIMCPEnsureStarted, nil
}

// resolveOpenAIMCPBinary is the two-rung ladder: the managed install (an
// absolute path, since the tmux pane's PATH is not rk's), then tunnel-client
// on PATH. "" when neither resolves.
func resolveOpenAIMCPBinary(l openaimcp.Layout) string {
	if info, err := os.Stat(l.CurrentBinary()); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
		return l.CurrentBinary()
	}
	if path, err := openAIMCPLookPath(openaimcp.BinaryName); err == nil {
		return path
	}
	return ""
}

// spawnOpenAIMCPInstallJob starts the rk-jobs install-then-start chain and
// returns at once: nothing blocks on the download. RunJob's dedup (a live
// window of the same name is reused) guards against a second job.
func spawnOpenAIMCPInstallJob(ctx context.Context) error {
	exe, err := openAIMCPSelfPath()
	if err != nil {
		return fmt.Errorf("tunnel-client is not installed and the rk path is unresolvable; run `rk openai-mcp install`: %w", err)
	}
	quoted := shellq.Quote(exe)
	argv := []string{quoted + " openai-mcp install && " + quoted + " openai-mcp start"}
	target, started, err := openAIMCPRunJob(ctx, OpenAIMCPInstallJobWindow, argv)
	switch {
	case err != nil:
		return fmt.Errorf("tunnel-client is not installed and the install job failed to start; run `rk openai-mcp install`: %w", err)
	case !started:
		slog.Info("chatgpt connector: tunnel-client install already running", "window", target.Window)
	default:
		slog.Info("chatgpt connector: spawned the tunnel-client install job", "window", target.Window)
	}
	return nil
}

// ensureOpenAIMCP runs at daemon start, after ensureGUI: first stop a session
// the settings no longer allow (they may have changed while the daemon was
// down), then ensure. Best-effort; it never fails daemon start.
func ensureOpenAIMCP() {
	if _, err := ReconcileOpenAIMCP(); err != nil {
		slog.Warn("chatgpt connector: reconcile failed", "err", err)
	}
	_, _ = ensureOpenAIMCPCore(openAIMCPDaemonStart)
}

// errOpenAIMCPDaemonDown is the gate's error: a spawn (tmux new-session) on a
// rk-daemon socket with no daemon would birth a tmux server of its own.
var errOpenAIMCPDaemonDown = errors.New("rk daemon is not running; start it with `rk serve -d`")

// EnsureOpenAIMCP is `rk openai-mcp start`: strict, never installs, never
// restarts a running session. Gated on the daemon running.
func EnsureOpenAIMCP() (OpenAIMCPEnsureOutcome, error) {
	return ensureOpenAIMCPGated(openAIMCPFromCLI)
}

// EnsureOpenAIMCPFromDaemon is the settings and key POSTs' ensure: it starts
// the install job when tunnel-client is missing and restarts a running
// session onto a changed profile. Gated on the daemon running.
func EnsureOpenAIMCPFromDaemon() (OpenAIMCPEnsureOutcome, error) {
	return ensureOpenAIMCPGated(openAIMCPFromDaemon)
}

func ensureOpenAIMCPGated(opts openAIMCPEnsureOptions) (OpenAIMCPEnsureOutcome, error) {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	if !jobDaemonRunning(ctx) {
		return OpenAIMCPEnsureDisabled, errOpenAIMCPDaemonDown
	}
	return ensureOpenAIMCPCore(opts)
}

// KillOpenAIMCPSession kills the session by exact-match target and removes
// the stale health URL. An absent session is success.
func KillOpenAIMCPSession() (killed bool, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	if !openAIMCPSessionExists(ctx) {
		return false, nil
	}
	layout, layoutErr := openAIMCPLayout()
	if layoutErr != nil {
		layout = openaimcp.Layout{}
	}
	if err := killOpenAIMCPSession(ctx, layout); err != nil {
		return false, err
	}
	return true, nil
}

// killOpenAIMCPSession kills the session and, when the layout resolved,
// removes its stale health URL.
func killOpenAIMCPSession(ctx context.Context, layout openaimcp.Layout) error {
	slog.Warn("tmux teardown", "audit", "kill", "op", "kill-session", "server", serverSocket, "target", OpenAIMCPSessionName, "callers", "daemon.KillOpenAIMCPSession")
	if err := openAIMCPKillRun(ctx, "kill-session", "-t", "="+OpenAIMCPSessionName); err != nil {
		return fmt.Errorf("killing the %s session: %w", OpenAIMCPSessionName, err)
	}
	if layout.Root != "" {
		removeIfExists(layout.HealthURLPath())
	}
	return nil
}

// RestartOpenAIMCP kills then ensures, so a new tunnel ID or key takes effect
// and a stuck tunnel-client recovers; a missing binary starts the install job
// (the code-server restart precedent). The daemon gate comes first, so a down
// daemon touches no tmux at all. Refuses while off: a restart never flips the
// switch.
func RestartOpenAIMCP() error {
	if !settings.Load().OpenAIMCPEnabled {
		return errors.New("the ChatGPT connector is off; turn it on in Settings → ChatGPT connector")
	}
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	up := jobDaemonRunning(ctx)
	cancel()
	if !up {
		return errOpenAIMCPDaemonDown
	}
	if _, err := KillOpenAIMCPSession(); err != nil {
		return err
	}
	_, err := ensureOpenAIMCPCore(openAIMCPFromDaemon)
	return err
}

// ReconcileOpenAIMCP stops a tunnel-client the settings no longer allow (the
// connector off, or its tunnel ID or key gone) after a writer other than the
// settings POST changed them: a hand edit, a dotfiles sync, or any change
// made while the daemon was down. The session outlives daemon restarts by
// design, so without this it would keep tunneling while every surface says
// off. Runs at daemon start and from WatchOpenAIMCPSettings. No tmux is
// touched when the settings allow the connector or the daemon is down.
// Reports whether it killed.
func ReconcileOpenAIMCP() (bool, error) {
	s := settings.Load()
	layout, layoutErr := openAIMCPLayout()
	if s.OpenAIMCPEnabled && s.OpenAIMCPTunnelID != "" && layoutErr == nil && layout.KeySet() {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	if !jobDaemonRunning(ctx) || !openAIMCPSessionExists(ctx) {
		return false, nil
	}
	slog.Warn("chatgpt connector: stopping a tunnel-client the settings no longer allow",
		"enabled", s.OpenAIMCPEnabled, "tunnel_id_set", s.OpenAIMCPTunnelID != "")
	if layoutErr != nil {
		layout = openaimcp.Layout{}
	}
	if err := killOpenAIMCPSession(ctx, layout); err != nil {
		return false, err
	}
	return true, nil
}

// OpenAIMCPWatchInterval is how often `rk serve` stats the settings file for
// WatchOpenAIMCPSettings: one stat per tick, tmux only when the file changed
// and the settings disallow the connector.
const OpenAIMCPWatchInterval = 5 * time.Second

// WatchOpenAIMCPSettings runs ReconcileOpenAIMCP whenever the settings file
// changes, until ctx ends. `rk serve` runs it for its whole life, independent
// of any UI client: the status hub only polls while a browser is connected,
// and a connector turned off by a hand edit or a dotfiles sync must stop
// tunneling whether or not anyone is looking.
func WatchOpenAIMCPSettings(ctx context.Context, every time.Duration) {
	last := settings.Stamp()
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stamp := settings.Stamp()
			if stamp == last {
				continue
			}
			last = stamp
			if _, err := ReconcileOpenAIMCP(); err != nil {
				slog.Warn("chatgpt connector: reconcile after a settings change failed", "err", err)
			}
		}
	}
}

// OpenAIMCPStatus is the connector status the SSE event and doctor carry.
// KeySet is the only fact about the key that ever leaves the daemon.
type OpenAIMCPStatus struct {
	Enabled     bool   `json:"enabled"`
	TunnelIDSet bool   `json:"tunnelIdSet"`
	KeySet      bool   `json:"keySet"`
	State       string `json:"state"`
	Detail      string `json:"detail"`
}

// openAIMCPProbe is everything the status classification reads, gathered by
// ProbeOpenAIMCP and classified by the pure classifyOpenAIMCP.
type openAIMCPProbe struct {
	enabled, tunnelIDSet, keySet bool
	daemonDown                   bool
	installing, binaryMissing    bool
	session                      bool
	healthURL                    string
	readyStatus                  int
	readyBody                    string
	readyErr                     error
}

// ProbeOpenAIMCP gathers and classifies the connector status. It checks the
// daemon before any session read and reports a down daemon as stopped, so
// callers need no gate of their own.
func ProbeOpenAIMCP(ctx context.Context) OpenAIMCPStatus {
	s := settings.Load()
	p := openAIMCPProbe{enabled: s.OpenAIMCPEnabled, tunnelIDSet: s.OpenAIMCPTunnelID != ""}
	layout, layoutErr := openAIMCPLayout()
	if layoutErr == nil {
		p.keySet = layout.KeySet()
	}
	if !p.enabled || !p.tunnelIDSet || !p.keySet {
		return classifyOpenAIMCP(p)
	}
	// Every probe below reads tmux on the rk-daemon socket. With no daemon
	// session (a foreground `rk serve`) there is nothing to read, so the gate
	// comes first and the state says why.
	if !jobDaemonRunning(ctx) {
		p.daemonDown = true
		return classifyOpenAIMCP(p)
	}
	p.installing = openAIMCPInstallJobLive(ctx)
	p.session = openAIMCPSessionExists(ctx)
	p.binaryMissing = resolveOpenAIMCPBinary(layout) == ""
	if p.session {
		if data, err := os.ReadFile(layout.HealthURLPath()); err == nil {
			p.healthURL = strings.TrimSpace(string(data))
		}
		if p.healthURL != "" {
			readyCtx, cancel := context.WithTimeout(ctx, openAIMCPReadyTimeout)
			p.readyStatus, p.readyBody, p.readyErr = openAIMCPHTTPGet(readyCtx, strings.TrimRight(p.healthURL, "/")+"/readyz")
			cancel()
		}
	}
	return classifyOpenAIMCP(p)
}

// classifyOpenAIMCP maps a probe onto one state, in precedence order: off,
// unconfigured, daemon down (stopped), installing, stopped, starting, ready,
// degraded.
func classifyOpenAIMCP(p openAIMCPProbe) OpenAIMCPStatus {
	st := OpenAIMCPStatus{Enabled: p.enabled, TunnelIDSet: p.tunnelIDSet, KeySet: p.keySet}
	switch {
	case !p.enabled:
		st.State = OpenAIMCPStateOff
	case !p.tunnelIDSet:
		st.State, st.Detail = OpenAIMCPStateUnconfigured, "set the tunnel ID"
	case !p.keySet:
		st.State, st.Detail = OpenAIMCPStateUnconfigured, "save an API key"
	case p.daemonDown:
		st.State, st.Detail = OpenAIMCPStateStopped, "rk daemon is not running (rk serve -d)"
	case p.installing:
		st.State = OpenAIMCPStateInstalling
	case !p.session && p.binaryMissing:
		st.State, st.Detail = OpenAIMCPStateStopped, "tunnel-client is not installed (rk openai-mcp install)"
	case !p.session:
		st.State = OpenAIMCPStateStopped
	case p.healthURL == "" || p.readyErr != nil:
		st.State = OpenAIMCPStateStarting
	case p.readyStatus == http.StatusOK:
		st.State = OpenAIMCPStateReady
	default:
		st.State = OpenAIMCPStateDegraded
		line, _, _ := strings.Cut(strings.TrimSpace(p.readyBody), "\n")
		if line == "" {
			line = fmt.Sprintf("readyz answered %d", p.readyStatus)
		}
		st.Detail = line
	}
	return st
}

// removeIfExists removes path, ignoring a missing file.
func removeIfExists(path string) {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		slog.Warn("chatgpt connector: could not remove a stale file", "path", path, "err", err)
	}
}
