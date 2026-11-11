package main

import (
	"github.com/spf13/cobra"
)

var daemonCmd = &cobra.Command{
	Use:   "daemon",
	Short: "Manage the background run-kit daemon (tmux-managed run-kit serve)",
	Long: `Manage the background run-kit daemon — a run-kit serve instance running in a
dedicated rk-daemon tmux session. The daemon survives shell exits and SSH
disconnects; the foreground run-kit serve does not.

Subcommands:
  start      Start the daemon
  stop       Stop the daemon (and optionally reclaim the port)
  restart    Stop and start the daemon
  status     Show daemon state and current port owner
  run        Run a command in a managed job window (rk-jobs session)
  autostart  Start the daemon once at boot or login (on | off | status)

See 'run-kit daemon <subcommand> --help' for flags on each.`,
}

func init() {
	daemonCmd.AddCommand(daemonStartCmd)
	daemonCmd.AddCommand(daemonStopCmd)
	daemonCmd.AddCommand(daemonRestartCmd)
	daemonCmd.AddCommand(daemonStatusCmd)
	daemonCmd.AddCommand(daemonRunCmd)
	daemonCmd.AddCommand(daemonAutostartCmd)
}
