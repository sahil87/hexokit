package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"rk/internal/operator"
	"rk/internal/validate"

	"github.com/spf13/cobra"
)

// rk operator track — the CLI door onto the operator's tracked-item ledger
// (internal/operator): a thin flag-to-library layer. The library owns the
// schema, timestamps, caps, and the locked atomic write; this file only parses
// flags, resolves the per-server state file, and maps errors onto the exit
// classes (usage → 2, everything else → 1).

const (
	// operatorTrackStdinCap bounds the note text read from stdin; the
	// library's own rune cap rejects anything shorter than this that is still
	// too long.
	operatorTrackStdinCap = 64 << 10
	// operatorTrackStdinMarker is the note text that means "read stdin".
	operatorTrackStdinMarker = "-"
)

// operatorSocketPathFn is the tmux socket-path query seam: the slug of the
// state file derives from it. Tests stub it so no live tmux server is asked.
var operatorSocketPathFn = operator.ServerSocketPath

// operatorTrackReceipt is the --json success document of the mutation verbs.
type operatorTrackReceipt struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Mode   string `json:"mode,omitempty"`
}

var operatorTrackCmd = &cobra.Command{
	Use:   "track",
	Short: "Manage the operator's tracked items",
	Long: `Manage the operator's tracked items — the ledger the operator watches,
chains, and annotates. State lives in one plain YAML file per tmux server under
the hexokit state home; every verb writes it atomically under a lock, so the
operator chat, scheduled runs, and the daemon can write concurrently.

Verbs: add, update, observe, rm, list, note, pause, resume. Only list is a pure
read. All verbs take -L/--server (default: the caller's own server from $TMUX).`,
	Example: `  rk operator track add pr-1234 --kind github-pr --scope '{"pr":1234}' --argv gh --argv pr --argv view --argv 1234 --fields state
  rk operator track note pr-1234 "waiting on the design review" --by chat
  rk operator track list --json`,
	Args: usageArgs(cobra.NoArgs),
	RunE: func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var operatorTrackAddCmd = &cobra.Command{
	Use:   "add <id> --kind <kind> [flags]",
	Short: "Add a tracked item (the kind fills its defaults; flags override)",
	Long: `Add a tracked item. The kind fills its defaults; flags override them.

Kinds: pane, github-pr, linear, slack, shell, task, note. Each kind allows
exactly its default probe mode. A shell item needs --argv, --fields, and
--done-when. A github-pr item builds its probe from scope.pr (and the repo
named by scope.repo). A pane item seeds the pinned scope keys, accepts the
pane flags, and records the pane's shell pid. A note item takes --text (and
--by) and starts with that one note.

--mode (pane items only) sets scope.merge_mode; when omitted it stays null.

Flags:
  --kind          item kind (required)
  --probe         probe mode (each kind allows only its default)
  --argv          shell probe argv token (repeatable; never a shell string)
  --fields        comma-separated probe fields compared against and stored into last
  --instruction   agent probe instruction
  --check-every   probe cadence (floor 1m; default 5m for shell/agent; null for pane/none)
  --done-when     done predicate: path ==|!= json-scalar clauses joined by ' and '
  --then          prose the run executes when done or changed fires
  --depends-on    comma-separated item ids this item depends on
  --scope         scope metadata as a JSON object
  --text, --by    note kind only: the first note's text and author (user, run, chat)
  --mode          merge mode for a pane item: cherry-pick-ladder, stacked-prs, merge-auto
  pane flags      --pane --repo --session --branch --stage --agent --stop-stage --spawned-by --change
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator track add n1 --kind note --text "remember X"
  rk operator track add pr-1234 --kind github-pr --scope '{"pr":1234}' --argv gh --argv pr --argv view --argv 1234 --fields state,mergedAt
  rk operator track add w1 --kind pane --pane %5 --change 260101-ab12-x --repo /src/app --branch feat

Exit codes:
  0  added
  1  operational failure (duplicate id, state file busy or unreadable)
  2  usage error (unknown kind or flag, invalid value)`,
	Args:         usageArgs(cobra.ExactArgs(1)),
	SilenceUsage: true,
	RunE:         runOperatorTrackAdd,
}

var operatorTrackUpdateCmd = &cobra.Command{
	Use:   "update <id> [flags]",
	Short: "Change a tracked item's cadence, predicate, then, deps, or scope",
	Long: `Change a tracked item. Only the flags given change; --scope merges per key and a
changed scope.pane re-records the pane's shell pid. Notes are append-only: use
rk operator track note. Use pause and resume to flip paused.

Flags:
  --check-every   probe cadence (floor 1m; null for pane/none items)
  --done-when     done predicate (empty string clears it)
  --then          prose to run when done or changed fires (empty string clears it)
  --depends-on    comma-separated item ids (replaces the list)
  --scope         scope as a JSON object (merged per key)
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator track update pr-1234 --check-every 10m
  rk operator track update w1 --scope '{"pane":"%9"}'

Exit codes:
  0  updated
  1  operational failure (no such item, state file busy or unreadable)
  2  usage error (no flag given, invalid value)`,
	Args:         usageArgs(cobra.ExactArgs(1)),
	SilenceUsage: true,
	RunE:         runOperatorTrackUpdate,
}

var operatorTrackObserveCmd = &cobra.Command{
	Use:   "observe <id> (--json <object> | --error <message>) [--seen <id>...]",
	Short: "Record a probe result or failure for a tracked item",
	Long: `Record one probe outcome. --json stores the observed object per the item's probe
fields (dotted paths; an absent field stores null) and bumps unchanged or resets
it. --error counts a failure; the third consecutive failure pauses the item.
Exactly one of --json and --error is required. Here --json is the observed
object, not an output switch.

Flags:
  --json          observed fields as a JSON object
  --error         probe failure message
  --seen          handled item id to append to seen (repeatable; capped at 200, oldest pruned)
  -L, --server    tmux server (default: the caller's own server from $TMUX)

Examples:
  rk operator track observe pr-1234 --json '{"state":"OPEN","mergeable":"MERGEABLE"}'
  rk operator track observe pr-1234 --error "gh: HTTP 502"

Exit codes:
  0  recorded
  1  operational failure (no such item, state file busy or unreadable)
  2  usage error (neither or both of --json and --error, invalid JSON)`,
	Args:         usageArgs(cobra.ExactArgs(1)),
	SilenceUsage: true,
	RunE:         runOperatorTrackObserve,
}

var operatorTrackRmCmd = &cobra.Command{
	Use:   "rm <id> [--json]",
	Short: "Remove a tracked item and its notes",
	Long: `Remove a tracked item. Its notes go with it. Removing a done item also drops it
from every dependent's depends_on so the chain advances; a not-done removal
keeps the edges. The branch_map is untouched.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator track rm pr-1234

Exit codes:
  0  removed
  1  operational failure (no such item, state file busy or unreadable)
  2  usage error`,
	Args:         usageArgs(cobra.ExactArgs(1)),
	SilenceUsage: true,
	RunE:         runOperatorTrackRm,
}

var operatorTrackListCmd = &cobra.Command{
	Use:   "list [--kind <kind>] [--json]",
	Short: "List tracked items (id · kind · state · checked age · next)",
	Long: `List tracked items, one line each: id · kind · state · checked age · next. A pure
read: it never writes and never converts. States: done, paused, held, pending,
stale, live, watching. --json prints the full items, including notes.

Flags:
  --kind          filter to one kind
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout (the full items array)

Examples:
  rk operator track list
  rk operator track list --kind pane --json

Exit codes:
  0  listed (an absent state file lists nothing)
  1  operational failure (state file unreadable)
  2  usage error (unknown kind)`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runOperatorTrackList,
}

var operatorTrackNoteCmd = &cobra.Command{
	Use:   "note <id> <text> [--by user|run|chat]",
	Short: "Append a note to a tracked item",
	Long: `Append a note to a tracked item. Notes are append-only: at most 50 are kept per
item (the oldest are pruned) and each is at most 1000 characters (longer text is
an error, never truncated). The timestamp is set by the binary. A <text> of -
reads the note from stdin.

Flags:
  --by            note author: user (default), run, or chat
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator track note pr-1234 "waiting on the design review"
  echo "long note" | rk operator track note pr-1234 - --by run

Exit codes:
  0  appended
  1  operational failure (no such item, state file busy or unreadable)
  2  usage error (empty or over-length text, unknown --by)`,
	Args:         usageArgs(cobra.ExactArgs(2)),
	SilenceUsage: true,
	RunE:         runOperatorTrackNote,
}

var operatorTrackPauseCmd = &cobra.Command{
	Use:   "pause <id> [--json]",
	Short: "Pause a tracked item",
	Long: `Set paused on a tracked item; its probes stop until it is resumed.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator track pause pr-1234

Exit codes:
  0  paused
  1  operational failure (no such item, state file busy or unreadable)
  2  usage error`,
	Args:         usageArgs(cobra.ExactArgs(1)),
	SilenceUsage: true,
	RunE:         func(cmd *cobra.Command, args []string) error { return runOperatorTrackPause(cmd, args[0], true) },
}

var operatorTrackResumeCmd = &cobra.Command{
	Use:   "resume <id> [--json]",
	Short: "Resume a paused tracked item and zero its failure count",
	Long: `Clear paused on a tracked item and zero its consecutive-failure count.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator track resume pr-1234

Exit codes:
  0  resumed
  1  operational failure (no such item, state file busy or unreadable)
  2  usage error`,
	Args:         usageArgs(cobra.ExactArgs(1)),
	SilenceUsage: true,
	RunE:         func(cmd *cobra.Command, args []string) error { return runOperatorTrackPause(cmd, args[0], false) },
}

func init() {
	// Flag help carries no backticks — pflag consumes a backtick-quoted span as
	// a metavar name (the mux new --ephemeral defect).
	operatorTrackCmd.PersistentFlags().StringP("server", "L", "", "tmux server whose operator state to use (default: the caller's own server from $TMUX, else default)")

	f := operatorTrackAddCmd.Flags()
	f.String("kind", "", "item kind: pane, github-pr, linear, slack, shell, task, note (required)")
	f.String("probe", "", "probe mode (each kind allows only its default)")
	f.StringArray("argv", nil, "shell probe argv token (repeatable; never a shell string)")
	f.StringSlice("fields", nil, "comma-separated probe fields compared against and stored into last")
	f.String("instruction", "", "agent probe instruction")
	f.String("check-every", "", "probe cadence (floor 1m; default 5m for shell/agent; null for pane/none)")
	f.String("done-when", "", "done predicate: path ==|!= json-scalar clauses joined by ' and '")
	f.String("then", "", "prose the run executes when done or changed fires")
	f.StringSlice("depends-on", nil, "comma-separated item ids this item depends on")
	f.String("scope", "", "scope metadata as a JSON object")
	f.String("text", "", "note kind only: the first note's text")
	f.String("by", "", "note kind only: the first note's author (user, run, chat; default user)")
	f.String("mode", "", "merge mode for a pane item: "+strings.Join(operator.MergeModes, ", ")+" (default: unset)")
	for _, name := range operator.PaneSugarFlags() {
		f.String(name, "", "pane scope shortcut")
	}
	f.Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	f = operatorTrackUpdateCmd.Flags()
	f.String("check-every", "", "probe cadence (floor 1m; null for pane/none items)")
	f.String("done-when", "", "done predicate (empty string clears it)")
	f.String("then", "", "prose to run when done or changed fires (empty string clears it)")
	f.StringSlice("depends-on", nil, "comma-separated item ids (replaces the list)")
	f.String("scope", "", "scope as a JSON object (merged per key)")
	f.Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	f = operatorTrackObserveCmd.Flags()
	f.String("json", "", "observed fields as a JSON object")
	f.String("error", "", "probe failure message (counts a failure; the third consecutive one pauses the item)")
	f.StringArray("seen", nil, "handled item id to append to seen (repeatable; capped at 200, oldest pruned)")

	operatorTrackRmCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorTrackPauseCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorTrackResumeCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	f = operatorTrackListCmd.Flags()
	f.String("kind", "", "filter to one kind")
	f.Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	f = operatorTrackNoteCmd.Flags()
	f.String("by", operator.ByUser, "note author: user, run, or chat")
	f.Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	operatorTrackCmd.AddCommand(
		operatorTrackAddCmd, operatorTrackUpdateCmd, operatorTrackObserveCmd,
		operatorTrackRmCmd, operatorTrackListCmd, operatorTrackNoteCmd,
		operatorTrackPauseCmd, operatorTrackResumeCmd,
	)
	operatorCmd.AddCommand(operatorTrackCmd)
}

// operatorServer resolves the tmux server label: explicit -L/--server
// (validated; a bad name is a usage error), else the caller's own server from
// $TMUX.
func operatorServer(cmd *cobra.Command) (string, error) {
	server, _ := cmd.Flags().GetString("server")
	if server == "" {
		return cliServerLabel(operatorOriginalTMUXFn()), nil
	}
	if msg := validate.ValidateServerName(server); msg != "" {
		return "", usageError(errors.New(msg))
	}
	return server, nil
}

// operatorStateTarget resolves the tmux server label and its state file path.
func operatorStateTarget(cmd *cobra.Command) (server, path string, err error) {
	server, err = operatorServer(cmd)
	if err != nil {
		return "", "", err
	}
	path, err = operator.StatePathFor(server, operatorSocketPathFn(operatorTrackContext(cmd), server))
	if err != nil {
		return "", "", err
	}
	return server, path, nil
}

// operatorTrackError maps a library error onto the exit classes: a caller
// mistake is usage (2), everything else operational (1).
func operatorTrackError(err error) error {
	var inv *operator.InvalidError
	if errors.As(err, &inv) {
		return usageError(err)
	}
	return err
}

// operatorTrackDone writes the verb's outcome: the --json envelope when asked,
// else (on success) one confirmation line on stdout.
func operatorTrackDone(cmd *cobra.Command, receipt operatorTrackReceipt, err error) error {
	err = operatorTrackError(err)
	asJSON, _ := cmd.Flags().GetBool("json")
	sink := newSink(cmd)
	if asJSON {
		if err != nil {
			return sink.Envelope(nil, err)
		}
		return sink.Envelope(receipt, nil)
	}
	if err != nil {
		return err
	}
	if receipt.Mode != "" {
		sink.Dataf("mode: %s (flag)\n", receipt.Mode)
	}
	sink.Dataf("%s %s\n", receipt.Action, receipt.ID)
	return nil
}

func operatorTrackContext(cmd *cobra.Command) context.Context {
	if ctx := cmd.Context(); ctx != nil {
		return ctx
	}
	return context.Background()
}

// optionalString returns a pointer to the flag's value when it was set, so an
// explicitly empty value (clear to null) differs from an unset one.
func optionalString(cmd *cobra.Command, name string) *string {
	if !cmd.Flags().Changed(name) {
		return nil
	}
	v, _ := cmd.Flags().GetString(name)
	return &v
}

// scopeFlag parses --scope as a JSON object (nil when unset or empty).
func scopeFlag(cmd *cobra.Command) (map[string]interface{}, error) {
	raw, _ := cmd.Flags().GetString("scope")
	if raw == "" {
		return nil, nil
	}
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, usageError(fmt.Errorf("invalid --scope JSON: %v", err))
	}
	if m == nil {
		return nil, usageError(errors.New("invalid --scope: must be a JSON object"))
	}
	return m, nil
}

func runOperatorTrackAdd(cmd *cobra.Command, args []string) error {
	f := cmd.Flags()
	kind, _ := f.GetString("kind")
	if kind == "" {
		return operatorTrackDone(cmd, operatorTrackReceipt{}, usageError(fmt.Errorf("--kind is required (valid: %s)", operator.KindNames)))
	}
	if f.Changed("by") && kind != operator.KindNote {
		return operatorTrackDone(cmd, operatorTrackReceipt{}, usageError(errors.New("--by applies only to kind note")))
	}
	scope, err := scopeFlag(cmd)
	if err != nil {
		return operatorTrackDone(cmd, operatorTrackReceipt{}, err)
	}
	server, path, err := operatorStateTarget(cmd)
	if err != nil {
		return operatorTrackDone(cmd, operatorTrackReceipt{}, err)
	}

	spec := operator.AddSpec{ID: args[0], Kind: kind, Server: server, Scope: scope}
	spec.Probe, _ = f.GetString("probe")
	spec.Argv, _ = f.GetStringArray("argv")
	spec.Fields, _ = f.GetStringSlice("fields")
	spec.Instruction, _ = f.GetString("instruction")
	spec.CheckEvery, _ = f.GetString("check-every")
	spec.DoneWhen = optionalString(cmd, "done-when")
	spec.Then = optionalString(cmd, "then")
	spec.DependsOn, _ = f.GetStringSlice("depends-on")
	spec.Mode, _ = f.GetString("mode")
	spec.Text, _ = f.GetString("text")
	spec.TextSet = f.Changed("text")
	spec.By, _ = f.GetString("by")
	for _, name := range operator.PaneSugarFlags() {
		if f.Changed(name) {
			if spec.PaneSugar == nil {
				spec.PaneSugar = map[string]string{}
			}
			spec.PaneSugar[name], _ = f.GetString(name)
		}
	}

	res, err := operator.Add(operatorTrackContext(cmd), path, spec)
	return operatorTrackDone(cmd, operatorTrackReceipt{ID: args[0], Action: "added", Mode: res.MergeMode}, err)
}

func runOperatorTrackUpdate(cmd *cobra.Command, args []string) error {
	f := cmd.Flags()
	receipt := operatorTrackReceipt{ID: args[0], Action: "updated"}
	if !f.Changed("check-every") && !f.Changed("done-when") && !f.Changed("then") && !f.Changed("depends-on") && !f.Changed("scope") {
		return operatorTrackDone(cmd, receipt, usageError(errors.New("nothing to update: pass at least one of --check-every, --done-when, --then, --depends-on, --scope")))
	}
	scope, err := scopeFlag(cmd)
	if err != nil {
		return operatorTrackDone(cmd, receipt, err)
	}
	server, path, err := operatorStateTarget(cmd)
	if err != nil {
		return operatorTrackDone(cmd, receipt, err)
	}
	spec := operator.UpdateSpec{
		ID:         args[0],
		Server:     server,
		CheckEvery: optionalString(cmd, "check-every"),
		DoneWhen:   optionalString(cmd, "done-when"),
		Then:       optionalString(cmd, "then"),
		Scope:      scope,
	}
	if f.Changed("depends-on") {
		deps, _ := f.GetStringSlice("depends-on")
		spec.DependsOn = &deps
	}
	return operatorTrackDone(cmd, receipt, operator.Update(operatorTrackContext(cmd), path, spec))
}

func runOperatorTrackObserve(cmd *cobra.Command, args []string) error {
	f := cmd.Flags()
	receipt := operatorTrackReceipt{ID: args[0], Action: "observed"}
	jsonGiven, errGiven := f.Changed("json"), f.Changed("error")
	if jsonGiven == errGiven {
		return usageError(errors.New("track observe requires exactly one of --json or --error"))
	}
	spec := operator.ObserveSpec{ID: args[0], Failed: errGiven}
	spec.Seen, _ = f.GetStringArray("seen")
	if jsonGiven {
		raw, _ := f.GetString("json")
		var decoded interface{}
		if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
			return usageError(fmt.Errorf("invalid --json: %v", err))
		}
		obj, ok := decoded.(map[string]interface{})
		if !ok {
			return usageError(errors.New("invalid --json: must be a JSON object"))
		}
		spec.Fields = obj
	}
	_, path, err := operatorStateTarget(cmd)
	if err != nil {
		return err
	}
	if err := operatorTrackError(operator.Observe(path, spec)); err != nil {
		return err
	}
	newSink(cmd).Dataf("%s %s\n", receipt.Action, receipt.ID)
	return nil
}

func runOperatorTrackRm(cmd *cobra.Command, args []string) error {
	receipt := operatorTrackReceipt{ID: args[0], Action: "removed"}
	_, path, err := operatorStateTarget(cmd)
	if err != nil {
		return operatorTrackDone(cmd, receipt, err)
	}
	return operatorTrackDone(cmd, receipt, operator.Remove(path, args[0]))
}

func runOperatorTrackPause(cmd *cobra.Command, id string, pause bool) error {
	receipt := operatorTrackReceipt{ID: id, Action: "resumed"}
	op := operator.Resume
	if pause {
		receipt.Action, op = "paused", operator.Pause
	}
	_, path, err := operatorStateTarget(cmd)
	if err != nil {
		return operatorTrackDone(cmd, receipt, err)
	}
	return operatorTrackDone(cmd, receipt, op(path, id))
}

func runOperatorTrackNote(cmd *cobra.Command, args []string) error {
	receipt := operatorTrackReceipt{ID: args[0], Action: "noted"}
	text := args[1]
	if text == operatorTrackStdinMarker {
		b, err := io.ReadAll(io.LimitReader(cmd.InOrStdin(), operatorTrackStdinCap))
		if err != nil {
			return operatorTrackDone(cmd, receipt, fmt.Errorf("reading note from stdin: %w", err))
		}
		text = string(b)
	}
	by, _ := cmd.Flags().GetString("by")
	_, path, err := operatorStateTarget(cmd)
	if err != nil {
		return operatorTrackDone(cmd, receipt, err)
	}
	return operatorTrackDone(cmd, receipt, operator.AddNote(path, args[0], by, text))
}

func runOperatorTrackList(cmd *cobra.Command, args []string) error {
	kind, _ := cmd.Flags().GetString("kind")
	asJSON, _ := cmd.Flags().GetBool("json")
	sink := newSink(cmd)
	_, path, err := operatorStateTarget(cmd)
	if err != nil {
		return operatorTrackDone(cmd, operatorTrackReceipt{}, err)
	}
	all, shown, err := operator.List(path, kind)
	if err != nil {
		return operatorTrackDone(cmd, operatorTrackReceipt{}, err)
	}
	if asJSON {
		return sink.Envelope(shown, nil)
	}
	for _, line := range operator.ListLines(all, shown) {
		sink.Dataf("%s\n", line)
	}
	return nil
}
