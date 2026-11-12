package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"text/tabwriter"

	"rk/internal/operator"

	"github.com/spf13/cobra"
)

// rk operator check — the CLI door onto operator.Check, the deterministic gate
// the daemon runs before any model call. It runs in-process (no daemon needed)
// and writes the baselines exactly as the daemon's call does, so a manual check
// consumes the edges it reports.

// operatorCheckFn is the operator.Check seam; tests stub it so no tmux server
// or subprocess is reached.
var operatorCheckFn = operator.Check

// Row prefixes of the human output.
const (
	checkRowNew  = "new"
	checkRowOpen = "open"
	checkRowNote = "note"
)

var operatorCheckCmd = &cobra.Command{
	Use:   "check [-L <server>] [--json]",
	Short: "Probe tracked items and report what changed since the last check",
	Long: `Probe every due tracked item, diff it against its stored baselines, and report
what changed — the same deterministic gate the daemon runs before it starts a
model run. No model is involved.

The check writes the new baselines exactly as the daemon's call does: it
consumes the changes it reports, so a second check right after reports them as
open (still standing) instead of new. Probes and the pane listing run before
the state file is locked, so a check never blocks track verbs.

A condition that persists (a finished item, a dead pane, an exited agent, a
paused probe, a stale or due agent item) is reported as new once, then listed as
open until it clears. Notices (a single probe failure, a skipped probe) never
count as a change.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator check
  rk operator check -L work --json

Exit codes:
  0  checked (with or without changes)
  1  operational failure (state file unreadable or busy, tmux listing failure)
  2  usage error`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runOperatorCheck,
}

func init() {
	f := operatorCheckCmd.Flags()
	f.StringP("server", "L", "", "tmux server whose operator state to check (default: the caller's own server from $TMUX, else default)")
	f.Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorCmd.AddCommand(operatorCheckCmd)
}

func runOperatorCheck(cmd *cobra.Command, args []string) error {
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
	res, err := operatorCheckFn(operatorTrackContext(cmd), server, operator.CheckOptions{})
	if err != nil {
		return fail(operatorTrackError(err))
	}
	if asJSON {
		return sink.Envelope(res, nil)
	}
	renderCheck(sink, res)
	return nil
}

// renderCheck prints the header and one aligned row per delta and notice.
func renderCheck(sink outputSink, res operator.CheckResult) {
	sink.Dataf("%s\n", checkHeader(res))
	tw := tabwriter.NewWriter(sink.data, 0, 8, 2, ' ', 0)
	for _, d := range res.Changes {
		fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\n", checkRowNew, d.ID, d.Kind, checkDetail(d))
	}
	for _, d := range res.Open {
		fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\n", checkRowOpen, d.ID, d.Kind, checkDetail(d))
	}
	for _, n := range res.Notices {
		fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\n", checkRowNote, n.ID, n.Kind, checkNoticeDetail(n))
	}
	_ = tw.Flush()
}

func checkHeader(res operator.CheckResult) string {
	head := "no change"
	if res.Changed {
		head = fmt.Sprintf("changed %d", len(res.Changes))
	}
	if n := len(res.Open); n > 0 {
		head += fmt.Sprintf(", open %d", n)
	}
	if n := len(res.Notices); n > 0 {
		head += fmt.Sprintf(", notices %d", n)
	}
	return head
}

// checkDetail renders the kind-specific part of a delta row.
func checkDetail(d operator.CheckDelta) string {
	switch d.Kind {
	case operator.DeltaChanged:
		return checkFieldChanges(d.Fields)
	case operator.DeltaDone:
		if d.Then != nil {
			return "then: " + *d.Then
		}
	case operator.DeltaPaneDeath:
		return d.Pane
	case operator.DeltaPaneMismatch:
		return fmt.Sprintf("%s found %s", d.Pane, checkNullable(d.Found))
	case operator.DeltaAgentExited:
		return fmt.Sprintf("%s %s", d.Pane, checkNullable(d.Command))
	case operator.DeltaStageAdvance, operator.DeltaReviewFail:
		return fmt.Sprintf("%s %s → %s", d.Pane, checkNullable(d.From), checkNullable(d.To))
	case operator.DeltaAgentState:
		line := fmt.Sprintf("%s %s → %s", d.Pane, checkNullable(d.From), checkNullable(d.To))
		if d.Duration != nil {
			line += " (" + *d.Duration + ")"
		}
		return line
	case operator.DeltaPaused:
		return d.Error
	case operator.DeltaStale:
		return d.Age
	case operator.DeltaDue:
		if d.Instruction == "" {
			return d.Age
		}
		return d.Age + " — " + d.Instruction
	case operator.DeltaUnknownDep:
		return d.Dep
	}
	return ""
}

func checkNullable(s *string) string {
	if s == nil {
		return "null"
	}
	return *s
}

// checkFieldChanges renders `field: from → to` pairs in field-name order, with
// values in their JSON form so a string and its number-looking twin differ.
func checkFieldChanges(fields map[string]operator.FieldChange) string {
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, fmt.Sprintf("%s: %s → %s", name, checkJSON(fields[name].From), checkJSON(fields[name].To)))
	}
	return strings.Join(parts, "; ")
}

func checkJSON(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}

func checkNoticeDetail(n operator.CheckNotice) string {
	if n.Kind == operator.NoticeProbeError {
		return fmt.Sprintf("%s (failures %d)", n.Error, n.Failures)
	}
	return n.Error
}
