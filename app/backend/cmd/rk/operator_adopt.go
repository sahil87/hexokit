package main

import (
	"errors"
	"fmt"

	"rk/internal/cron"
	"rk/internal/operator"

	"github.com/spf13/cobra"
)

// rk operator adopt — the explicit, one-time import of fab's operator state
// file into rk's own. The source is read-only (never written, locked,
// renamed, or converted on disk); nothing else invokes adopt.

var operatorAdoptCmd = &cobra.Command{
	Use:   "adopt [--from <fab-state.yaml>] [-L <server>] [--dry-run] [--json]",
	Short: "Import fab's operator state file into rk's (read-only, never clobbers)",
	Long: `Import the tracked items and branch_map of fab's operator state file into rk's
own state file for the server. The fab file is only read. Legacy shapes (the
monitored, watches, autopilot, and notes sections, and retired fab-change
items) convert in memory. Each fab note item's text becomes its first note;
clock_override is not carried.

Items are matched by id: an id already present in rk's file is left untouched
and reported as skipped, so re-running adopt adds only what is new. An invalid
item is skipped with its id and reason, not fatal. A legacy file with a running
autopilot queue is refused and nothing is written. When fab has no state file
there is nothing to adopt: exit 0, and no rk file is created.

Flags:
  --from          fab state file to read (default: fab's file for this server)
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --dry-run       compute and report everything, write nothing
  --json          machine-readable envelope on stdout

Examples:
  rk operator adopt --dry-run
  rk operator adopt
  rk operator adopt --from ~/.local/state/fab/operator/default.yaml --json

Exit codes:
  0  adopted, nothing to adopt, or dry-run complete
  1  operational failure (unreadable source, running legacy queue, state file busy)
  2  usage error`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runOperatorAdopt,
}

func init() {
	f := operatorAdoptCmd.Flags()
	f.String("from", "", "fab operator state file to read (default: fab's file for this server)")
	f.StringP("server", "L", "", "tmux server whose operator state to use (default: the caller's own server from $TMUX, else default)")
	f.Bool("dry-run", false, "compute and report everything, write nothing")
	f.Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorCmd.AddCommand(operatorAdoptCmd)
}

func runOperatorAdopt(cmd *cobra.Command, args []string) error {
	asJSON, _ := cmd.Flags().GetBool("json")
	dryRun, _ := cmd.Flags().GetBool("dry-run")
	from, _ := cmd.Flags().GetString("from")
	sink := newSink(cmd)

	fail := func(err error) error {
		if asJSON {
			return sink.Envelope(nil, err)
		}
		return err
	}

	_, target, err := operatorStateTarget(cmd)
	if err != nil {
		return fail(err)
	}
	source := from
	if source == "" {
		server, _ := cmd.Flags().GetString("server")
		if server == "" {
			server = cliServerLabel(operatorOriginalTMUXFn())
		}
		source, err = cron.FabOperatorStatePath(cron.FabOperatorSlug(operatorSocketPathFn(operatorTrackContext(cmd), server)))
		if err != nil {
			return fail(err)
		}
	}

	res, err := operator.Adopt(source, target, dryRun)
	switch {
	case errors.Is(err, operator.ErrNoSource):
		if asJSON {
			return sink.Envelope(res, nil)
		}
		sink.Dataf("nothing to adopt (no fab operator state at %s)\n", source)
		return nil
	case err != nil:
		return fail(operatorTrackError(err))
	}

	if asJSON {
		for _, w := range res.Warnings {
			sink.Notef("warning: %s\n", w)
		}
		return sink.Envelope(res, nil)
	}
	line := fmt.Sprintf("adopted %d item(s), skipped %d (already present)", len(res.Adopted), len(res.Skipped))
	if len(res.Invalid) > 0 {
		line += fmt.Sprintf(", %d invalid", len(res.Invalid))
	}
	if dryRun {
		line += " [dry run]"
	}
	sink.Dataf("%s\n", line)
	for _, id := range res.Skipped {
		sink.Dataf("skipped %s (already present)\n", id)
	}
	for _, inv := range res.Invalid {
		sink.Dataf("invalid %s: %s\n", inv.ID, inv.Reason)
	}
	for _, w := range res.Warnings {
		sink.Notef("warning: %s\n", w)
	}
	return nil
}
