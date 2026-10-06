package main

import (
	"fmt"

	"rk/internal/daemon"
	"rk/internal/validate"

	"github.com/spf13/cobra"
)

// daemonRunJobFn is the seam over the internal job primitive so tests can
// drive the spawned / already-running / daemon-down branches without a live
// tmux server. Default: the real primitive (the CLI is a thin wrapper — the
// API handlers call the same function in-process).
var daemonRunJobFn = daemon.RunJob

var daemonRunCmd = &cobra.Command{
	Use:   "run --window <name> -- <cmd> [args...]",
	Short: "Run a command in a managed job window on the daemon's tmux server",
	Long: `Run a command in a managed job window of the rk-jobs session on the
rk-daemon tmux socket — the mechanism behind one-click update and daemon
restart, exposed for scripts and debugging.

The window is WATCHABLE: it appears on the dashboard under the rk-daemon
server while the command runs. After the command exits (success or failure)
the pane remains so the output stays visible; the next run of the same
--window respawns it in place. Output is also teed to
~/.local/state/hexokit/logs/<name>.log.

The daemon must be running (rk serve -d) — the command refuses rather than
birthing a tmux server. Re-running while a job window is live is a no-op: the
existing window's target is printed ('already running: ...') and nothing is
spawned.`,
	Args: cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		window, _ := cmd.Flags().GetString("window")
		if msg := validate.ValidateToolName(window); msg != "" {
			return fmt.Errorf("invalid --window name: %s", msg)
		}

		target, started, err := daemonRunJobFn(cmd.Context(), window, args)
		if err != nil {
			return err
		}
		// One bounded line per invocation (toolkit Principle 9).
		if started {
			fmt.Fprintf(cmd.OutOrStdout(), "spawned %s:%s:%s (%s)\n",
				target.Server, target.Session, target.Window, target.WindowID)
		} else {
			fmt.Fprintf(cmd.OutOrStdout(), "already running: %s:%s:%s (%s)\n",
				target.Server, target.Session, target.Window, target.WindowID)
		}
		return nil
	},
}

func init() {
	daemonRunCmd.Flags().String("window", "", "job window name in the rk-jobs session (required)")
	_ = daemonRunCmd.MarkFlagRequired("window")
}
