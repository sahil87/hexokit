package main

import (
	"context"
	"errors"
	"fmt"

	"rk/internal/operatorloop"

	"github.com/spf13/cobra"
)

// rk operator run-exec — the hidden wrapper that runs inside an operator-loop
// run window (internal/operatorloop). The daemon composes its argv; nobody
// types it. It runs the launcher with the run's brief on stdin, tees the
// output to the run log, and records the outcome in the run record. It never
// writes the cron log: the daemon's tick transcribes the record.

// operatorRunExecFn is the operatorloop.Exec seam; tests stub it.
var operatorRunExecFn = operatorloop.Exec

var operatorRunExecCmd = &cobra.Command{
	Use:   "run-exec --server <server> --run <run-id> -- <launcher argv...>",
	Short: "Run one operator-loop run (internal wrapper inside a run window)",
	Long: `Run the launcher command of one operator-loop run: its brief file feeds the
launcher's stdin, its output is tee'd to the run log, and the run record gets
the start time, exit code and the last 'outcome: <text>' line it printed. A run
that exits non-zero or prints no outcome line also leaves a 'run failed' note on
each changed item and sends a push notification.

This verb is started by the daemon inside a run window and is not meant to be
typed. It exits with the launcher's exit status.

Flags:
  -L, --server    tmux server of the run (required)
  --run           run id, YYYYMMDDTHHMMSS-xxxx (required)

Examples:
  rk operator run-exec --server work --run 20261112T101500-ab12 -- sh -c 'claude -p'

Exit codes:
  the launcher's exit status
  1  operational failure (run record missing, state unreadable)
  2  usage error`,
	Hidden:       true,
	Args:         usageArgs(cobra.MinimumNArgs(1)),
	SilenceUsage: true,
	RunE:         runOperatorRunExec,
}

func init() {
	f := operatorRunExecCmd.Flags()
	f.StringP("server", "L", "", "tmux server of the run")
	f.String("run", "", "run id")
	operatorCmd.AddCommand(operatorRunExecCmd)
}

func runOperatorRunExec(cmd *cobra.Command, args []string) error {
	server, _ := cmd.Flags().GetString("server")
	if server == "" {
		return usageError(errors.New("--server is required"))
	}
	server, err := operatorServer(cmd)
	if err != nil {
		return err
	}
	runID, _ := cmd.Flags().GetString("run")
	if !operatorloop.ValidRunID(runID) {
		return usageError(fmt.Errorf("invalid --run %q", runID))
	}
	res, err := operatorRunExecFn(operatorTrackContext(cmd), operatorloop.ExecOptions{
		Server: server,
		RunID:  runID,
		Argv:   args,
		Stdout: cmd.OutOrStdout(),
		Stderr: cmd.ErrOrStderr(),
		Notify: func(ctx context.Context, title, body string) { sendNotify(ctx, title, body) },
	})
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return &exitCodeError{code: res.ExitCode, msg: fmt.Sprintf("run %s: launcher exited %d", runID, res.ExitCode)}
	}
	return nil
}
