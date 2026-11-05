package main

import (
	"context"
	"time"

	"rk/internal/daemon"
	"rk/internal/openaimcp"
	"rk/internal/settings"

	"github.com/spf13/cobra"
)

// The package seams below let tests drive the openai-mcp subcommands against
// a temp layout, an httptest release server, and stubbed daemon entries.
var (
	openAIMCPLayoutCLIFn    = openaimcp.DefaultLayout
	newOpenAIMCPInstallerFn = openaimcp.NewInstaller
	openAIMCPStartFn        = daemon.EnsureOpenAIMCP
	openAIMCPRestartCLIFn   = daemon.RestartOpenAIMCP
)

var openAIMCPCmd = &cobra.Command{
	Use:   "openai-mcp",
	Short: "Manage the ChatGPT connector's tunnel-client (OpenAI Secure MCP Tunnel)",
	Long: `Manage the ChatGPT connector: OpenAI's tunnel-client, run by the daemon in
the rk-openai-mcp session so ChatGPT can call this host's MCP tools (/mcp)
through an outbound-only tunnel. No inbound port opens.

Turn the connector on, and set its tunnel ID and API key, in Settings → ChatGPT
connector. The daemon then installs tunnel-client if needed (an
openai-mcp-install window in rk-jobs) and starts it. These subcommands are the
manual surface for the same paths.

The managed install lives under ~/.local/state/hexokit/openai-mcp/bin/<version>/
(SHA256-verified against the GitHub release digest, activated by an atomic
'current' symlink flip). A tunnel-client on PATH is used when no managed
install exists.

Subcommands:
  install  Download the latest tunnel-client release and activate it (idempotent)
  start    Start the connector's tunnel-client session now
  restart  Kill and restart the session (applies a new tunnel ID or key)

Spec: docs/specs/openai-mcp.md.`,
}

var openAIMCPInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Download the latest tunnel-client release and activate it",
	Long: `Download the latest tunnel-client release for this host (linux/darwin,
amd64/arm64) from github.com/openai/tunnel-client, verify its SHA256 against
the release digest, extract the tunnel-client binary, and activate it under
~/.local/state/hexokit/openai-mcp/bin/<version>/ via an atomic 'current'
symlink flip.

Idempotent: when the managed install already matches the latest release,
nothing is downloaded. A missing or mismatched digest fails closed and leaves
the previous install untouched. There is no version-pin flag: install means
"go to latest".`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runOpenAIMCPInstall,
}

var openAIMCPStartCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the connector's tunnel-client session now",
	Long: `Start the rk-openai-mcp session (a sibling of rk-daemon on the same tmux
socket): the same ensure path the daemon runs at start, exposed so the
rk-jobs install chain and manual recovery share one implementation. The
tunnel-client profile is regenerated from settings first.

Errors when the connector is unconfigured (no tunnel ID or API key) or
tunnel-client is not installed. Gated on the daemon running: start it with
'rk serve -d' first. A connector that is off is a skip, never a start.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runOpenAIMCPStart,
}

var openAIMCPRestartCmd = &cobra.Command{
	Use:   "restart",
	Short: "Kill and restart the connector's tunnel-client session",
	Long: `Kill the rk-openai-mcp session (if any) and start it again from a freshly
derived profile, so a new tunnel ID or API key takes effect and a stuck
tunnel-client recovers. A missing tunnel-client starts the install job in
rk-jobs instead. Refuses while the connector is off: a restart never turns it
on. The same action as the palette's "ChatGPT connector: Restart".

The profile's /mcp address comes from RK_HOST and RK_PORT (else config.yaml's
port), so run it where the daemon's values apply.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runOpenAIMCPRestart,
}

func init() {
	openAIMCPCmd.AddCommand(openAIMCPInstallCmd)
	openAIMCPCmd.AddCommand(openAIMCPStartCmd)
	openAIMCPCmd.AddCommand(openAIMCPRestartCmd)
	// Nested subcommands wrap their own arg validators as usage-class (exit
	// 2); root.go's wrap loop covers only rootCmd's direct children.
	for _, c := range openAIMCPCmd.Commands() {
		if c.Args != nil {
			c.Args = usageArgs(c.Args)
		}
	}
}

func runOpenAIMCPInstall(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	layout, err := openAIMCPLayoutCLIFn()
	if err != nil {
		return err
	}
	ins := newOpenAIMCPInstallerFn()
	ins.Progress = sink.chatter
	sink.Notef("Resolving the latest tunnel-client release...\n")
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	res, err := ins.Install(ctx, layout)
	if err != nil {
		return err
	}
	if res.AlreadyCurrent {
		sink.Dataf("tunnel-client v%s is already current (%s).\n", res.Version, res.Path)
		return nil
	}
	sink.Dataf("Installed tunnel-client v%s (%s).\n", res.Version, res.Path)
	return nil
}

func runOpenAIMCPStart(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	outcome, err := openAIMCPStartFn()
	if err != nil {
		return err
	}
	switch outcome {
	case daemon.OpenAIMCPEnsureDisabled:
		sink.Dataf("The ChatGPT connector is off; turn it on in Settings → ChatGPT connector.\n")
	case daemon.OpenAIMCPEnsureAlreadyRunning:
		sink.Dataf("The ChatGPT connector is already running (%s session).\n", daemon.OpenAIMCPSessionName)
	default:
		sink.Dataf("Started the ChatGPT connector (%s session).\n", daemon.OpenAIMCPSessionName)
	}
	return nil
}

func runOpenAIMCPRestart(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	if err := openAIMCPRestartCLIFn(); err != nil {
		return err
	}
	sink.Dataf("Restarted the ChatGPT connector (%s session).\n", daemon.OpenAIMCPSessionName)
	return nil
}

// openAIMCPDaemonRunningFn / openAIMCPProbeDoctorFn are the doctor row's
// seams over the daemon-liveness gate and the status probe.
var (
	openAIMCPDaemonRunningFn = daemon.IsRunning
	openAIMCPProbeDoctorFn   = daemon.ProbeOpenAIMCP
)

// openAIMCPCheck renders the connector status as the openai-mcp doctor row.
// Always OK-shaped (the gui/code-server posture): off is the default and a
// not-ready connector is a state, never a dependency failure.
func openAIMCPCheck(st daemon.OpenAIMCPStatus) doctorCheck {
	check := doctorCheck{Name: "openai-mcp", OK: true}
	switch st.State {
	case daemon.OpenAIMCPStateOff:
		check.Note = "off"
	case daemon.OpenAIMCPStateUnconfigured:
		check.Note = "on: unconfigured, " + st.Detail + " (Settings → ChatGPT connector)"
	case daemon.OpenAIMCPStateInstalling:
		check.Note = "on: installing tunnel-client (rk-jobs window " + daemon.OpenAIMCPInstallJobWindow + ")"
	case daemon.OpenAIMCPStateStopped:
		if st.Detail != "" {
			check.Note = "on: not running, " + st.Detail
		} else {
			check.Note = "on: not running (rk openai-mcp start)"
		}
	case daemon.OpenAIMCPStateStarting:
		check.Note = "on: starting"
	case daemon.OpenAIMCPStateReady:
		check.Note = "on: ready (" + daemon.OpenAIMCPSessionName + " session)"
	default:
		check.Note = "on: degraded, " + st.Detail
	}
	return check
}

// openAIMCPDoctorCheck gathers the live status for the row. A down daemon is
// reported as such before any tmux read: there is no session to inspect.
func openAIMCPDoctorCheck() doctorCheck {
	if !settings.Load().OpenAIMCPEnabled {
		return openAIMCPCheck(daemon.OpenAIMCPStatus{State: daemon.OpenAIMCPStateOff})
	}
	if !openAIMCPDaemonRunningFn() {
		return doctorCheck{Name: "openai-mcp", OK: true, Note: "on: daemon not running (rk serve -d)"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), openAIMCPDoctorTimeout)
	defer cancel()
	return openAIMCPCheck(openAIMCPProbeDoctorFn(ctx))
}

// openAIMCPDoctorTimeout bounds the row's tmux reads plus the /readyz GET.
const openAIMCPDoctorTimeout = 5 * time.Second
