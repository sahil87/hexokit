package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"rk/internal/cron"
	"rk/internal/daemon"
	"rk/internal/ghhooks"
	"rk/internal/portpolicy"
	"rk/internal/settings"
	"rk/internal/validate"

	"github.com/spf13/cobra"
)

// rk operator hooks — the opportunistic PR-event trigger. `serve` is the
// loopback receiver for GitHub deliveries, `forward` supervises one
// `gh webhook forward` per admin repo, and `stop` tears both down; serve and
// forward run inside the rk-gh-hooks sibling session the daemon keeps, and are
// not meant to be typed. Every PR event becomes a wake marker through the
// trigger door (cron/<slug>.wake); nothing here is required for correctness,
// because the operator loop's clock picks every PR change up anyway.

// hooksLoopback is the only address the receiver binds: an unauthenticated
// local POST can at worst cause one spurious trigger, which costs one free
// check.
const hooksLoopback = "127.0.0.1"

// Seams for tests.
var (
	hooksNowFn          = time.Now
	hooksKillSessionFn  = daemon.KillGHHooksSession
	hooksReposFn        = func() []string { return settings.Load().OperatorPRHooks }
	hooksProbeAdminFn   = ghhooks.ProbeAdmin
	hooksRemoveHooksFn  = ghhooks.RemoveForwarderHooks
	hooksSourceFn       = ghhooks.DefaultSource
	hooksRunForwarderFn = ghhooks.RunForwarder
	hooksDoctorProbeFn  = daemon.ProbeGHHooks
)

// prHooksDoctorTimeout bounds the doctor rows' gh probes and tmux reads.
const prHooksDoctorTimeout = 15 * time.Second

var operatorHooksCmd = &cobra.Command{
	Use:   "hooks",
	Short: "Turn GitHub PR events into operator triggers (opportunistic)",
	Long: `Turn GitHub PR events into operator triggers. For each repository listed in the
operator.pr_hooks setting where the logged-in gh account has admin, the daemon
keeps a sibling tmux session 'rk-gh-hooks' running 'gh webhook forward' and a
loopback receiver; a PR event for a tracked PR then wakes that server's operator
within seconds instead of at the next scheduled check.

It is never required: where the account cannot create a hook (no admin), or the
cli/gh-webhook extension is missing, nothing is built and the operator loop's
clock picks every PR change up. 'rk doctor' shows one 'pr hooks' row per listed
repository.

Only stop is for typing: the receiver and forwarder verbs run inside the
rk-gh-hooks session.`,
	Example: `  rk operator hooks stop`,
	Args:    usageArgs(cobra.NoArgs),
	RunE:    func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var operatorHooksServeCmd = &cobra.Command{
	Use:   "serve [--port <port>]",
	Short: "Receive forwarded GitHub PR events on loopback (internal)",
	Long: `Receive GitHub webhook deliveries forwarded by 'gh webhook forward' and wake the
operator of every live tmux server that tracks the PR.

It binds 127.0.0.1 only and serves POST /hooks/github, nothing else. A delivery
maps to a server when the server's ledger holds a github-pr item for that
repository and PR (or head branch), or an item whose checkout is on that head
branch of that repository; the server's wake marker is written once per
delivery with the reason pr:<owner>/<repo>#<n>:<event>. Unknown PRs and other
events are ignored. No payload content is stored or logged.

This verb is started by the daemon inside the rk-gh-hooks session and is not
meant to be typed.

Flags:
  --port    port to listen on (default: the port policy's gh-hooks port)

Examples:
  rk operator hooks serve --port 21900

Exit codes:
  0  stopped by a signal
  1  operational failure (port in use)
  2  usage error`,
	Hidden:       true,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runOperatorHooksServe,
}

var operatorHooksForwardCmd = &cobra.Command{
	Use:   "forward --repo <owner/name> [--port <port>]",
	Short: "Supervise gh webhook forward for one repository (internal)",
	Long: `Run 'gh webhook forward' for one repository against the local receiver and
restart it whenever it exits, waiting 5 s, then 10 s, doubling to 5 min, and
starting over after a run of 10 minutes or more. The forwarder exits when its
relay connection drops and at once when the hook cannot be created, so it must
be supervised.

This verb is started by the daemon inside the rk-gh-hooks session and is not
meant to be typed. A stop signal ends the forwarder and its process group, which
lets the extension remove the repository hook it created.

Flags:
  --repo    GitHub repository, owner/name (required)
  --port    port of the local receiver (default: the port policy's gh-hooks port)

Examples:
  rk operator hooks forward --repo sahil87/hexokit

Exit codes:
  0  stopped by a signal
  2  usage error (missing or invalid --repo or --port)`,
	Hidden:       true,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runOperatorHooksForward,
}

var operatorHooksStopCmd = &cobra.Command{
	Use:   "stop [--json]",
	Short: "Stop the PR-event forwarders and remove the hooks they created",
	Long: `Kill the rk-gh-hooks session and delete the repository hooks 'gh webhook forward'
created, for each repository in operator.pr_hooks where the account has admin.
Only hooks of the forwarder's own shape (named "cli", relaying through
GitHub's webhook forwarder) are deleted; any other hook — CI, deploys, chat
integrations — is never touched. An absent session is not an error.

The session comes back at the next daemon start, or the next change to
operator.pr_hooks, unless the setting is emptied: stop is a cleanup, not a
switch. To turn the feature off, empty operator.pr_hooks.

Flags:
  --json    machine-readable envelope on stdout

Examples:
  rk operator hooks stop
  rk operator hooks stop --json

Exit codes:
  0  session stopped (or absent) and every forwarder hook removed
  1  operational failure (a hook could not be removed, tmux error)
  2  usage error`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runOperatorHooksStop,
}

func init() {
	operatorHooksServeCmd.Flags().Int("port", portpolicy.GHHooks, "port to listen on (127.0.0.1)")
	operatorHooksForwardCmd.Flags().String("repo", "", "GitHub repository, owner/name")
	operatorHooksForwardCmd.Flags().Int("port", portpolicy.GHHooks, "port of the local receiver")
	operatorHooksStopCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorHooksCmd.AddCommand(operatorHooksServeCmd, operatorHooksForwardCmd, operatorHooksStopCmd)
	operatorCmd.AddCommand(operatorHooksCmd)
}

// hooksPort reads and validates --port.
func hooksPort(cmd *cobra.Command) (int, error) {
	port, _ := cmd.Flags().GetInt("port")
	if port < 1 || port > 65535 {
		return 0, usageError(fmt.Errorf("--port %d is out of range 1-65535", port))
	}
	return port, nil
}

// hooksStopContext ends on the signals a tmux kill or a terminal delivers.
func hooksStopContext(cmd *cobra.Command) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(operatorTrackContext(cmd), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
}

// newHooksReceiver wires the receiver to the real source and the trigger door.
func newHooksReceiver() (*ghhooks.Receiver, error) {
	dir, err := cron.DefaultDir()
	if err != nil {
		return nil, err
	}
	if err := cron.EnsureDir(dir); err != nil {
		return nil, fmt.Errorf("creating cron dir: %w", err)
	}
	return &ghhooks.Receiver{
		Source: hooksSourceFn(),
		Wake: func(server, reason string) error {
			return cron.WriteWakeMarker(dir, server, reason, hooksNowFn())
		},
	}, nil
}

func runOperatorHooksServe(cmd *cobra.Command, args []string) error {
	port, err := hooksPort(cmd)
	if err != nil {
		return err
	}
	receiver, err := newHooksReceiver()
	if err != nil {
		return err
	}
	ln, err := listenHooks(port)
	if err != nil {
		return err
	}
	ctx, stop := hooksStopContext(cmd)
	defer stop()
	slog.Info("gh hooks receiver listening", "addr", ln.Addr().String())
	return serveHooks(ctx, ln, receiver)
}

// listenHooks binds the receiver port on loopback only.
func listenHooks(port int) (net.Listener, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort(hooksLoopback, strconv.Itoa(port)))
	if err != nil {
		return nil, fmt.Errorf("binding the receiver: %w", err)
	}
	return ln, nil
}

// serveHooks serves h on ln until ctx ends, then shuts down within a grace
// period. A clean shutdown is nil.
func serveHooks(ctx context.Context, ln net.Listener, h http.Handler) error {
	srv := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if err := <-errc; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func runOperatorHooksForward(cmd *cobra.Command, args []string) error {
	repo, _ := cmd.Flags().GetString("repo")
	if repo == "" {
		return usageError(errors.New("--repo is required"))
	}
	if msg := validate.ValidateGitHubRepo(repo); msg != "" {
		return usageError(fmt.Errorf("--repo %q: %s", repo, msg))
	}
	port, err := hooksPort(cmd)
	if err != nil {
		return err
	}
	ctx, stop := hooksStopContext(cmd)
	defer stop()
	return hooksRunForwarderFn(ctx, repo, port, func(msg string, args ...any) {
		slog.Warn(msg, append([]any{"repo", repo}, args...)...)
	})
}

// hooksStopRepo is one repository's result in the stop receipt.
type hooksStopRepo struct {
	Repo    string  `json:"repo"`
	Admin   bool    `json:"admin"`
	Removed []int64 `json:"removed"`
	Error   string  `json:"error,omitempty"`
}

// hooksStopReceipt is the --json result of `rk operator hooks stop`.
type hooksStopReceipt struct {
	SessionKilled bool            `json:"session_killed"`
	Repos         []hooksStopRepo `json:"repos"`
}

func runOperatorHooksStop(cmd *cobra.Command, args []string) error {
	asJSON, _ := cmd.Flags().GetBool("json")
	sink := newSink(cmd)
	ctx := operatorTrackContext(cmd)

	killed, killErr := hooksKillSessionFn()
	receipt := hooksStopReceipt{SessionKilled: killed, Repos: []hooksStopRepo{}}
	var failures []string
	if killErr != nil {
		failures = append(failures, killErr.Error())
	}
	for _, repo := range hooksReposFn() {
		row := hooksStopRepo{Repo: repo, Removed: []int64{}}
		// Only an admin repo can have a forwarder hook; probing first also keeps
		// the hook listing off repos the account cannot read.
		if res := hooksProbeAdminFn(ctx, repo); res.Admin == ghhooks.AdminYes {
			row.Admin = true
			removed, err := hooksRemoveHooksFn(ctx, repo)
			row.Removed = append(row.Removed, removed...)
			if err != nil {
				row.Error = err.Error()
				failures = append(failures, row.Error)
			}
		}
		receipt.Repos = append(receipt.Repos, row)
	}

	var err error
	if len(failures) > 0 {
		err = fmt.Errorf("pr hooks stop incomplete: %s", failures[0])
	}
	if asJSON {
		return sink.Envelope(receipt, err)
	}
	switch {
	case killed:
		sink.Dataf("killed the %s session\n", daemon.GHHooksSessionName)
	default:
		sink.Dataf("no %s session running\n", daemon.GHHooksSessionName)
	}
	for _, row := range receipt.Repos {
		switch {
		case row.Error != "":
			sink.Dataf("%s: %s\n", row.Repo, row.Error)
		case !row.Admin:
			sink.Dataf("%s: polled — no admin, nothing to remove\n", row.Repo)
		default:
			sink.Dataf("%s: removed %d forwarder hook(s)\n", row.Repo, len(row.Removed))
		}
	}
	return err
}

// prHooksDoctorChecks is the `pr hooks` doctor rows: one per listed
// repository, or a single `pr hooks` row reading off. Always OK-shaped (the
// gui and openai-mcp posture): a repo without admin, a missing extension or a
// stopped daemon is a state, never a dependency failure, because the
// operator loop's clock covers every PR event the hook would have announced.
func prHooksDoctorChecks() []doctorCheck {
	ctx, cancel := context.WithTimeout(context.Background(), prHooksDoctorTimeout)
	defer cancel()
	return prHooksChecks(hooksDoctorProbeFn(ctx))
}

func prHooksChecks(statuses []daemon.GHHooksRepoStatus) []doctorCheck {
	checks := make([]doctorCheck, 0, len(statuses))
	for _, st := range statuses {
		name := "pr hooks"
		if st.Repo != "" {
			name += " " + st.Repo
		}
		note := st.State
		switch {
		case st.Detail == "":
		case st.State == daemon.GHHooksStatePolledNoAdmin:
			note += " (" + st.Detail + ")"
		default:
			note += " — " + st.Detail
		}
		checks = append(checks, doctorCheck{Name: name, OK: true, Note: note})
	}
	return checks
}
