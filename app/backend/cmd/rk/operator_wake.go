package main

import (
	"fmt"
	"time"

	"rk/internal/cron"

	"github.com/spf13/cobra"
)

// rk operator wake — the door that makes the operator look. It drops the
// server's trigger marker (cron/<slug>.wake); the cron tick consumes it and
// fires the operator loop with `trigger:<reason>`. Writing the marker needs no
// daemon and no tmux, and the marker survives a daemon restart, so a wake sent
// while the daemon is down fires on its next tick.

// wakeNowFn is the marker timestamp source; a seam for tests.
var wakeNowFn = time.Now

var operatorWakeCmd = &cobra.Command{
	Use:   "wake [-L <server>] [--reason <text>] [--json]",
	Short: "Make the operator look at a server now, through the loop",
	Long: `Ask the server's operator loop to look at its tracked items on the next cron
tick. This is the door to make the operator look: it writes a one-line marker
the tick consumes, and the loop fires with that reason like any other check
(the check, then a run only when something changed). It never runs a check
itself — a bare 'rk operator check' outside the loop consumes the changes it
reports without a run ever seeing them, so do not use it to make the operator
look.

A second wake before the tick keeps only the newest reason. The marker waits
while the loop entry is muted or a run is in flight, and while the server is
not running; it fires when the loop is next free. No daemon is needed to write
it, and the server's liveness is not checked.

The reason is one line of text (at most 120 characters, no control characters)
recorded on the loop's log line and run, e.g. note or pr:owner/repo#12:merged.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --reason        why the operator should look (default: manual)
  --json          machine-readable envelope on stdout

Examples:
  rk operator wake
  rk operator wake -L work --reason "new note on pr-41"
  rk operator wake -L work --json

Exit codes:
  0  wake marker written
  1  operational failure (cron state directory not writable)
  2  usage error (bad server name, bad reason, extra arguments)`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runOperatorWake,
}

func init() {
	f := operatorWakeCmd.Flags()
	f.StringP("server", "L", "", "tmux server to wake the operator on (default: the caller's own server from $TMUX, else default)")
	f.String("reason", "", "why the operator should look, one line of at most 120 characters (default: manual)")
	f.Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorCmd.AddCommand(operatorWakeCmd)
}

// wakeReceipt is the --json result.
type wakeReceipt struct {
	Server string `json:"server"`
	Reason string `json:"reason"`
}

func runOperatorWake(cmd *cobra.Command, args []string) error {
	asJSON, _ := cmd.Flags().GetBool("json")
	sink := newSink(cmd)
	fail := func(err error) error {
		if asJSON {
			return sink.Envelope(nil, err)
		}
		return err
	}

	server, err := operatorServer(cmd)
	if err != nil {
		return fail(err)
	}
	rawReason, _ := cmd.Flags().GetString("reason")
	reason, err := cron.NormalizeWakeReason(rawReason)
	if err != nil {
		return fail(usageError(err))
	}
	dir, err := cron.DefaultDir()
	if err != nil {
		return fail(err)
	}
	if err := cron.EnsureDir(dir); err != nil {
		return fail(fmt.Errorf("creating cron dir: %w", err))
	}
	if err := cron.WriteWakeMarker(dir, server, reason, wakeNowFn()); err != nil {
		return fail(fmt.Errorf("writing wake marker: %w", err))
	}
	if asJSON {
		return sink.Envelope(wakeReceipt{Server: server, Reason: reason}, nil)
	}
	sink.Dataf("wake queued for %s: %s\n", server, reason)
	return nil
}
