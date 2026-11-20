package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"rk/internal/ghhooks"
	"rk/internal/portpolicy"
	"rk/internal/selfpath"
	"rk/internal/settings"
)

const (
	// GHHooksSessionName is the tmux session running the PR-event receiver and
	// one `gh webhook forward` supervisor per admin repo. A SIBLING session on
	// the rk-daemon socket (the rk-openai-mcp precedent): it outlives `rk
	// serve` exits, so the forwarders and their repository hooks survive a
	// daemon restart.
	GHHooksSessionName = "rk-gh-hooks"
	// GHHooksReceiverWindow runs `rk operator hooks serve`.
	GHHooksReceiverWindow = "receiver"
	// ghHooksForwarderPrefix starts every forwarder window's name; the rest is
	// derived from the repo.
	ghHooksForwarderPrefix = "fwd-"
	// GHHooksReconcileEvery is how often the settings watcher re-runs the
	// ensure with no settings change, so a dead window, a later-installed
	// extension or a recovered network are picked up without a restart.
	GHHooksReconcileEvery = 10 * time.Minute
	// ghHooksEnsureTimeout bounds one ensure, probes included.
	ghHooksEnsureTimeout = 30 * time.Second
)

// GHHooks doctor states (the `pr hooks` row's note).
const (
	GHHooksStateOff            = "off"
	GHHooksStateRunning        = "running"
	GHHooksStatePolledNoAdmin  = "polled — no admin"
	GHHooksStateForwarderLost  = "forwarder missing"
	ghHooksDaemonDownHint      = "rk daemon is not running (rk serve -d)"
	ghHooksReceiverMissingNote = "receiver window is not running"
)

// The package seams mirror the openai-mcp ones so tests drive every branch
// without a live tmux server, network, or gh.
var (
	ghHooksSessionExists = func(ctx context.Context) bool {
		return sessionExistsCtx(ctx, GHHooksSessionName)
	}
	ghHooksTmux       = runTmux
	ghHooksTmuxOutput = runTmuxOutput
	ghHooksSelfPath   = selfpath.Stable
	ghHooksProbeAdmin = ghhooks.ProbeAdmin
	ghHooksExtension  = ghhooks.ExtensionInstalled
	ghHooksStamp      = settings.Stamp
	ghHooksListed     = func() bool { return len(settings.Load().OperatorPRHooks) > 0 }
)

// ghHooksMu serializes ensures: serve-start and the watcher can overlap.
var ghHooksMu sync.Mutex

// ghHooksWindow is one window of the rk-gh-hooks session.
type ghHooksWindow struct {
	id, name string
	dead     bool
}

// ghHooksWindows lists the session's windows. A missing session is no windows.
func ghHooksWindows(ctx context.Context) ([]ghHooksWindow, error) {
	if !ghHooksSessionExists(ctx) {
		return nil, nil
	}
	out, err := ghHooksTmuxOutput(ctx, "list-windows", "-t", "="+GHHooksSessionName, "-F", "#{window_id} #{pane_dead} #{window_name}")
	if err != nil {
		return nil, fmt.Errorf("listing the %s windows: %w", GHHooksSessionName, err)
	}
	var wins []ghHooksWindow
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.SplitN(line, " ", 3)
		if len(fields) != 3 {
			continue
		}
		wins = append(wins, ghHooksWindow{id: fields[0], dead: fields[1] == "1", name: fields[2]})
	}
	return wins, nil
}

// ghHooksForwarderWindow is the window name for a repo's forwarder. GitHub
// owner names never contain "--", so owner--name is injective up to the "."
// → "_" rewrite tmux window names are kept free of.
func ghHooksForwarderWindow(nwo string) string {
	owner, name, _ := strings.Cut(nwo, "/")
	return ghHooksForwarderPrefix + strings.ReplaceAll(owner+"--"+name, ".", "_")
}

// ghHooksProbes probes every repo concurrently: one hung gh must not
// multiply the daemon-start delay by the repo count.
func ghHooksProbes(ctx context.Context, repos []string) map[string]ghhooks.ProbeResult {
	results := make([]ghhooks.ProbeResult, len(repos))
	var wg sync.WaitGroup
	for i, repo := range repos {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = ghHooksProbeAdmin(ctx, repo)
		}()
	}
	wg.Wait()
	out := make(map[string]ghhooks.ProbeResult, len(repos))
	for i, repo := range repos {
		out[repo] = results[i]
	}
	return out
}

var errGHHooksDaemonDown = errors.New("rk daemon is not running; start it with `rk serve -d`")

// ensureGHHooksCore reconciles the rk-gh-hooks session with the setting:
//
//   - empty list: kill a stale session;
//   - otherwise probe each repo, and build a receiver plus one forwarder
//     window per admin repo — and nothing at all for a repo without admin;
//   - forwarder windows of a repo that is unlisted or definitively not admin
//     are killed. A repo whose probe merely failed keeps the window it has: a
//     network blip must not tear down a working forwarder, and it spawns
//     nothing new.
//
// The daemon gate comes first: a spawn on an rk-daemon socket with no daemon
// would birth a tmux server of its own.
func ensureGHHooksCore(ctx context.Context) error {
	ghHooksMu.Lock()
	defer ghHooksMu.Unlock()

	repos := settings.Load().OperatorPRHooks
	if !jobDaemonRunning(ctx) {
		return errGHHooksDaemonDown
	}
	wins, err := ghHooksWindows(ctx)
	if err != nil {
		return err
	}
	if len(repos) == 0 {
		return killGHHooksSessionIf(ctx, len(wins) > 0, "daemon.ensureGHHooks")
	}

	probes := ghHooksProbes(ctx, repos)
	live := map[string]ghHooksWindow{}
	for _, w := range wins {
		if !w.dead {
			live[w.name] = w
		}
	}

	wanted := map[string]string{} // forwarder window name -> repo
	keep := map[string]bool{}
	for _, repo := range repos {
		name := ghHooksForwarderWindow(repo)
		if _, dup := wanted[name]; dup {
			slog.Warn("gh hooks: two repos map to one window name; the second is skipped", "repo", repo, "window", name)
			continue
		}
		switch res := probes[repo]; res.Admin {
		case ghhooks.AdminYes:
			wanted[name] = repo
			keep[name] = true
		case ghhooks.AdminProbeFailed:
			slog.Warn("gh hooks: admin probe failed; the repo is polled", "repo", repo, "err", res.Err)
			if _, running := live[name]; running {
				keep[name] = true
			}
		}
	}

	extension := true
	if missingForwarder(wanted, live) {
		extension = ghHooksExtension(ctx)
		if !extension {
			slog.Warn("gh hooks: the gh-webhook extension is not installed; no forwarder started", "hint", ghhooks.ExtensionInstallHint)
		}
	}
	if len(keep) == 0 || (!extension && !anyKept(keep, live)) {
		return killGHHooksSessionIf(ctx, len(wins) > 0, "daemon.ensureGHHooks")
	}

	exe, err := ghHooksSelfPath()
	if err != nil {
		return fmt.Errorf("resolving the rk path for the %s session: %w", GHHooksSessionName, err)
	}
	port := strconv.Itoa(portpolicy.GHHooks)
	receiver := []string{exe, "operator", "hooks", "serve", "--port", port}

	// A dead window (a pane kept by remain-on-exit) is replaced, not reused.
	for _, w := range wins {
		if w.dead {
			killGHHooksWindow(ctx, w)
			delete(live, w.name)
		}
	}
	// Killing a session's last window ends the session, so only a live window
	// proves it is still there.
	sessionUp := len(live) > 0
	if _, ok := live[GHHooksReceiverWindow]; !ok {
		if err := spawnGHHooksWindow(ctx, sessionUp, GHHooksReceiverWindow, receiver); err != nil {
			return err
		}
		sessionUp = true
	}
	for name, repo := range wanted {
		if _, ok := live[name]; ok || !extension {
			continue
		}
		argv := []string{exe, "operator", "hooks", "forward", "--repo", repo, "--port", port}
		if err := spawnGHHooksWindow(ctx, sessionUp, name, argv); err != nil {
			return err
		}
	}
	for _, w := range live {
		if strings.HasPrefix(w.name, ghHooksForwarderPrefix) && !keep[w.name] {
			killGHHooksWindow(ctx, w)
		}
	}
	return nil
}

func missingForwarder(wanted map[string]string, live map[string]ghHooksWindow) bool {
	for name := range wanted {
		if _, ok := live[name]; !ok {
			return true
		}
	}
	return false
}

func anyKept(keep map[string]bool, live map[string]ghHooksWindow) bool {
	for name := range keep {
		if _, ok := live[name]; ok {
			return true
		}
	}
	return false
}

// spawnGHHooksWindow starts a window running argv directly (no shell): the
// first one births the session, later ones join it.
func spawnGHHooksWindow(ctx context.Context, sessionUp bool, name string, argv []string) error {
	args := []string{"new-session", "-d", "-s", GHHooksSessionName, "-n", name}
	if sessionUp {
		args = []string{"new-window", "-d", "-t", "=" + GHHooksSessionName + ":", "-n", name}
	}
	if err := ghHooksTmux(ctx, append(args, argv...)...); err != nil {
		return fmt.Errorf("starting the %s window of %s: %w", name, GHHooksSessionName, err)
	}
	return nil
}

func killGHHooksWindow(ctx context.Context, w ghHooksWindow) {
	slog.Warn("tmux teardown", "audit", "kill", "op", "kill-window", "server", serverSocket, "target", GHHooksSessionName+":"+w.name, "callers", "daemon.ensureGHHooks")
	if err := ghHooksTmux(ctx, "kill-window", "-t", w.id); err != nil {
		slog.Warn("gh hooks: could not remove a window", "window", w.name, "err", err)
	}
}

// killGHHooksSessionIf kills the session by exact-match target when present.
func killGHHooksSessionIf(ctx context.Context, present bool, caller string) error {
	if !present {
		return nil
	}
	slog.Warn("tmux teardown", "audit", "kill", "op", "kill-session", "server", serverSocket, "target", GHHooksSessionName, "callers", caller)
	if err := ghHooksTmux(ctx, "kill-session", "-t", "="+GHHooksSessionName); err != nil {
		return fmt.Errorf("killing the %s session: %w", GHHooksSessionName, err)
	}
	return nil
}

// ensureGHHooks runs at daemon start, after ensureOpenAIMCP. Best-effort: it
// never fails daemon start, and a PR hook is never required for correctness —
// the operator loop's clock picks every PR change up regardless.
func ensureGHHooks() {
	ctx, cancel := context.WithTimeout(context.Background(), ghHooksEnsureTimeout)
	defer cancel()
	if err := ensureGHHooksCore(ctx); err != nil && !errors.Is(err, errGHHooksDaemonDown) {
		slog.Warn("gh hooks: ensure failed", "err", err)
	}
}

// KillGHHooksSession kills the rk-gh-hooks session by exact-match target. An
// absent session is success; killed reports whether one was there.
func KillGHHooksSession() (killed bool, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	if !ghHooksSessionExists(ctx) {
		return false, nil
	}
	if err := killGHHooksSessionIf(ctx, true, "daemon.KillGHHooksSession"); err != nil {
		return false, err
	}
	return true, nil
}

// WatchGHHooksSettings re-runs the ensure whenever the settings file changes
// and every GHHooksReconcileEvery regardless, until ctx ends. `rk serve` runs
// it beside WatchOpenAIMCPSettings, so an edit to operator.pr_hooks takes
// effect without a restart.
func WatchGHHooksSettings(ctx context.Context, every time.Duration) {
	watchGHHooks(ctx, every, GHHooksReconcileEvery, ensureGHHooks)
}

func watchGHHooks(ctx context.Context, every, reconcileEvery time.Duration, ensure func()) {
	last := ghHooksStamp()
	lastRun := time.Now()
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stamp := ghHooksStamp()
			// With nothing listed the periodic pass has nothing to recover;
			// only an edit (which may have just emptied the list) runs.
			periodic := time.Since(lastRun) >= reconcileEvery && ghHooksListed()
			if stamp == last && !periodic {
				continue
			}
			last, lastRun = stamp, time.Now()
			ensure()
		}
	}
}

// GHHooksRepoStatus is one `pr hooks` doctor row: the listed repo (empty for
// the single off row), its state, and a detail that rides the note.
type GHHooksRepoStatus struct {
	Repo   string
	State  string
	Detail string
}

// ghHooksRepoProbe is everything one repo's classification reads.
type ghHooksRepoProbe struct {
	probe           ghhooks.ProbeResult
	daemonDown      bool
	extensionAbsent bool
	receiverLive    bool
	forwarderLive   bool
}

// ProbeGHHooks gathers and classifies every listed repo. The daemon is
// checked before any tmux read, so a down daemon reads as forwarders missing
// and callers need no gate of their own.
func ProbeGHHooks(ctx context.Context) []GHHooksRepoStatus {
	repos := settings.Load().OperatorPRHooks
	if len(repos) == 0 {
		return []GHHooksRepoStatus{{State: GHHooksStateOff}}
	}
	probes := ghHooksProbes(ctx, repos)
	up := jobDaemonRunning(ctx)
	var wins []ghHooksWindow
	if up {
		wins, _ = ghHooksWindows(ctx)
	}
	live := map[string]bool{}
	for _, w := range wins {
		live[w.name] = !w.dead
	}
	var extensionAbsent bool
	for _, p := range probes {
		if p.Admin == ghhooks.AdminYes {
			extensionAbsent = !ghHooksExtension(ctx)
			break
		}
	}
	out := make([]GHHooksRepoStatus, 0, len(repos))
	for _, repo := range repos {
		out = append(out, classifyGHHooks(repo, ghHooksRepoProbe{
			probe:           probes[repo],
			daemonDown:      !up,
			extensionAbsent: extensionAbsent,
			receiverLive:    live[GHHooksReceiverWindow],
			forwarderLive:   live[ghHooksForwarderWindow(repo)],
		}))
	}
	return out
}

// classifyGHHooks maps one repo's probe onto a state, in precedence order:
// no admin (a failed probe reads the same, its reason in the detail), the
// daemon down, the extension absent, a window missing, running.
func classifyGHHooks(repo string, p ghHooksRepoProbe) GHHooksRepoStatus {
	st := GHHooksRepoStatus{Repo: repo}
	switch {
	case p.probe.Admin != ghhooks.AdminYes:
		st.State = GHHooksStatePolledNoAdmin
		if p.probe.Err != nil {
			st.Detail = "probe failed: " + p.probe.Err.Error()
		}
	case p.daemonDown:
		st.State, st.Detail = GHHooksStateForwarderLost, ghHooksDaemonDownHint
	case p.extensionAbsent:
		st.State, st.Detail = GHHooksStateForwarderLost, ghhooks.ExtensionInstallHint
	case !p.receiverLive:
		st.State, st.Detail = GHHooksStateForwarderLost, ghHooksReceiverMissingNote
	case !p.forwarderLive:
		st.State, st.Detail = GHHooksStateForwarderLost, "forwarder window is not running"
	default:
		st.State = GHHooksStateRunning
	}
	return st
}
