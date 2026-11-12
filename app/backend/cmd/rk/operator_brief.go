package main

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"rk/internal/operator"

	"github.com/spf13/cobra"
)

// rk operator brief — prints the brief a one-shot operator run would be handed:
// the tracked-item ledger around the changed items plus the embedded run
// rules. A thin layer over operator.RenderBrief; it reads the state file and
// writes nothing.

const operatorBriefReasonSep = "="

// operatorBriefNowFn is the render-time seam; tests pin it so the header is
// stable.
var operatorBriefNowFn = time.Now

var operatorBriefCmd = &cobra.Command{
	Use:   "brief [-L <server>] [--changed <id>[=<reason>]]... [--state <path>]",
	Short: "Print the run brief for the operator's tracked items",
	Long: `Print the brief a one-shot operator run is handed: the changed items with their
dependency neighbours and notes, one line for every other tracked item, the run
rules, and the exit contract. Only the brief is printed on stdout. The state
file is only read; a missing file renders an empty ledger.

With no --changed the What changed section says nothing was flagged, which is
the manual-render form for checking what a run would see.

Flags:
  --changed       item id that changed, with an optional reason as id=reason (repeatable;
                  repeating an id adds reasons to its one row)
  --state         read this state file instead of the server's own
  -L, --server    tmux server (default: the caller's own server from $TMUX)

Examples:
  rk operator brief
  rk operator brief --changed pr-1234=merged --changed pr-1234=ci-green
  rk operator brief --state ./ledger.yaml --changed w1

Exit codes:
  0  printed
  1  operational failure (state file unreadable or malformed)
  2  usage error (invalid server name, empty --changed id)`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runOperatorBrief,
}

func init() {
	f := operatorBriefCmd.Flags()
	f.StringArray("changed", nil, "item id that changed, as id or id=reason (repeatable)")
	f.String("state", "", "read this state file instead of the server's own")
	f.StringP("server", "L", "", "tmux server whose operator state to use (default: the caller's own server from $TMUX, else default)")
	operatorCmd.AddCommand(operatorBriefCmd)
}

// parseChangedFlags turns repeated id[=reason] values into one ChangedItem per
// id, in first-seen order, with reasons accumulated in flag order.
func parseChangedFlags(values []string) ([]operator.ChangedItem, error) {
	var changed []operator.ChangedItem
	index := map[string]int{}
	for _, v := range values {
		id, reason, _ := strings.Cut(v, operatorBriefReasonSep)
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, usageError(fmt.Errorf("invalid --changed %q: the item id is empty", v))
		}
		i, seen := index[id]
		if !seen {
			i = len(changed)
			index[id] = i
			changed = append(changed, operator.ChangedItem{ID: id})
		}
		if reason = strings.TrimSpace(reason); reason != "" {
			changed[i].Reasons = append(changed[i].Reasons, reason)
		}
	}
	return changed, nil
}

func runOperatorBrief(cmd *cobra.Command, args []string) error {
	values, _ := cmd.Flags().GetStringArray("changed")
	changed, err := parseChangedFlags(values)
	if err != nil {
		return err
	}
	server, path, err := operatorBriefTarget(cmd)
	if err != nil {
		return err
	}
	st, err := operator.Load(path)
	if err != nil {
		return err
	}
	brief := operator.RenderBrief(operator.BriefInput{
		State: st, Server: server, Now: operatorBriefNowFn(), Changed: changed,
	})
	newSink(cmd).Dataf("%s", brief)
	return nil
}

// operatorBriefTarget resolves the server label and the state file to read:
// --state wins and needs no tmux query; otherwise the per-server file.
func operatorBriefTarget(cmd *cobra.Command) (server, path string, err error) {
	state, _ := cmd.Flags().GetString("state")
	if state == "" {
		return operatorStateTarget(cmd)
	}
	server, err = operatorServer(cmd)
	if err != nil {
		return "", "", err
	}
	if strings.TrimSpace(state) == "" {
		return "", "", usageError(errors.New("--state requires a non-empty path"))
	}
	return server, state, nil
}
