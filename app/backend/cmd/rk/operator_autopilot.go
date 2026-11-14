package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"rk/internal/autopilot"
	"rk/internal/inject"
	"rk/internal/operator"
	"rk/internal/settings"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk operator autopilot — the CLI door onto internal/autopilot, the
// deterministic queue engine. Runs and the operator chat call these verbs
// instead of executing git/gh choreography from prose; the queue itself is the
// tracked items, so there is no queue store to keep in sync.

const autopilotStdinCap = 1 << 20

var autopilotSettingsFn = func() string { return settings.Load().OperatorMergeMode }

// autopilotEnvFn builds a verb's engine environment; tests replace it so no
// tmux server, git remote or gh is reached.
var autopilotEnvFn = func(cmd *cobra.Command, by string, dry bool) (autopilot.Env, error) {
	server, path, err := operatorStateTarget(cmd)
	if err != nil {
		return autopilot.Env{}, err
	}
	run := autopilot.ExecRunner{}
	return autopilot.Env{
		Server: server, StatePath: path, Run: run,
		Spawn: autopilot.RiffSpawner{Server: server, Run: run},
		Panes: autopilotPanes{server: server},
		Session: func(ctx context.Context, repo string) (string, error) {
			session, _, _, err := resolveLandingSession(ctx, "", server, repo)
			return strings.TrimPrefix(session, "="), err
		},
		By: by, DryRun: dry,
	}, nil
}

// autopilotPanes is the production pane view: the operator's pane snapshot
// (with each pane's derived fab change) and the mux send injection engine.
type autopilotPanes struct{ server string }

func (p autopilotPanes) Snapshot(ctx context.Context) (map[string]operator.PaneInfo, error) {
	return operator.SnapshotPanes(ctx, p.server)
}

// Send delivers one Enter-terminated message the way `rk mux send` does. A
// working agent (active, or waiting on a question this is not the answer to) is
// never interrupted: the caller defers.
func (p autopilotPanes) Send(ctx context.Context, paneID, text string) error {
	facts, err := muxSendFactsFn(ctx, paneID, p.server)
	if err != nil {
		return fmt.Errorf("read pane facts: %w", err)
	}
	switch facts.AgentState {
	case tmux.AgentStateActive, tmux.AgentStateWaiting:
		return autopilot.ErrPaneBusy
	}
	engine := inject.NewEngine(muxBufferNameFn())
	return muxSendEngineSendFn(ctx, engine, cliInjectTmux{}, p.server, paneID, inject.Sanitize(text), true)
}

var operatorAutopilotCmd = &cobra.Command{
	Use:   "autopilot",
	Short: "Run operator queues: spawn, chain, merge in order, recover PRs",
	Long: `Run operator queues deterministically. A queue is N pane items chained by
depends_on; a merge sequence is a chain of github-pr items. Every verb re-reads
the operator state file, acts, and writes back under a lock, so nothing is held
in memory and a fresh run picks up exactly where the last one stopped.

Verbs: queue, step, merge, stop, status. Only status is a pure read. The engine
never notifies: failures and halts come back as escalations, and the caller (a
run or the chat) turns them into rk notify. All verbs take -L/--server (default:
the caller's own server from $TMUX).

Merge modes (--mode, or the operator.merge_mode setting):
  cherry-pick-ladder  chained PRs; each change gets its dependencies cherry-picked
                      in; merge after review
  stacked-prs         chained PRs; each is cut from its dependency's branch; merge
                      after review
  merge-auto          each PR is armed to merge as it ships; the next change waits
                      for the verified merge`,
	Example: `  echo '[{"id":"ab12","repo":"/src/app","change":"ab12"}]' | rk operator autopilot queue
  rk operator autopilot step --json
  rk operator autopilot merge
  rk operator autopilot status`,
	Args: usageArgs(cobra.NoArgs),
	RunE: func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var operatorAutopilotQueueCmd = &cobra.Command{
	Use:   "queue [--mode <mode>] [--by user|run|chat] [--dry-run] [--json] < entries.json",
	Short: "Persist a queue of pending pane items from JSON entries on stdin",
	Long: `Persist a queue as N pending pane items in one locked write. Entries arrive as a
JSON array on stdin:

  [
    {"id": "ab12", "repo": "/src/app", "change": "ab12"},
    {"id": "fix-login", "repo": "/src/web", "task": "fix login after password reset"},
    {"id": "ef56", "repo": "/src/app", "change": "ef56", "depends_on": ["ab12"], "stop_stage": null}
  ]

An entry names an existing fab change (change), raw text (task), or neither (a
bare agent, which nothing may depend on). The mode resolves as --mode, then the
operator.merge_mode setting, then cherry-pick-ladder, and is stamped on every
item; the receipt prints it as "mode: <name> (flag|setting|default)". An invalid
setting value is an error, never a silent fallback.

Every entry after the first depends on the nearest earlier entry in its repo,
else on the previous entry (an ordering-only barrier across repos). An explicit
depends_on replaces that. In merge-auto each entry depends on the previous one as
a barrier only. A merge-auto queue with explicit same-repo depends_on is reported
as a misfit: ask the user which mode they meant.

Flags:
  --mode          merge mode: cherry-pick-ladder, stacked-prs, merge-auto
  --by            note author: user, run, chat (default chat)
  --dry-run       validate and report without writing
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  echo '[{"id":"ab12","repo":"/src/app","change":"ab12"}]' | rk operator autopilot queue
  rk operator autopilot queue --mode stacked-prs < queue.json

Exit codes:
  0  queued
  1  operational failure (state file busy or unreadable, id already tracked)
  2  usage error (bad entries, invalid mode or setting, bare dependency, relative repo)`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotQueue,
}

var operatorAutopilotStepCmd = &cobra.Command{
	Use:   "step [--by run|chat] [--dry-run] [--json]",
	Short: "Advance every queue and merge sequence one idempotent pass",
	Long: `Run one pass over the server's tracked items: persist newly observed
completions, advance every in-progress merge sequence (verify merges, arm the
next PR, merge and retarget stacked PRs, arm merge-auto PRs), detect stalls and
run the one bounded recovery per reason, spawn every pending queue item whose
dependencies are satisfied, and flag slow ones. No call waits for CI; call step
again later.

The output lists actions taken (spawned, cherry-picked, armed, merged,
retargeted, rebased, disarmed, recovery-sent), per-merge report lines, and
escalations for the caller to notify on. --dry-run reads but changes nothing.

Flags:
  --by            note author: run (default) or chat
  --dry-run       report the plan without side effects
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator autopilot step
  rk operator autopilot step --dry-run --json

Exit codes:
  0  stepped (with or without actions or escalations)
  1  operational failure (state file busy or unreadable)
  2  usage error`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotStep,
}

var operatorAutopilotMergeCmd = &cobra.Command{
	Use:   "merge [--repo <path>] [--json]",
	Short: "Start the ordered merge of a completed queue",
	Long: `Start the ordered merge for completed cherry-pick-ladder and stacked-prs queues
(every repo, or one with --repo): create the github-pr chain items and arm or
merge the first PR of each repo's sequence. Later steps advance it. Run this only
on the user's confirmation to merge all. It refuses while queue items are not
done, and does nothing for merge-auto items.

Flags:
  --repo          limit to one repo (absolute path)
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator autopilot merge
  rk operator autopilot merge --repo /src/app --json

Exit codes:
  0  started (or nothing to merge)
  1  operational failure (queue items not done, no PR for a branch, state busy)
  2  usage error`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotMerge,
}

var operatorAutopilotStopCmd = &cobra.Command{
	Use:   "stop [--json]",
	Short: "Disarm every armed PR and pause every unspawned queue item",
	Long: `Global user stop: disarm every armed PR (gh pr merge --disable-auto), halt the
unfinished merge sequences so a later step does not re-arm them, and pause every
unspawned queue item. Live panes are left untouched. To resume a halted PR item:
rk operator track update <id> --scope '{"halted":false}'.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator autopilot stop

Exit codes:
  0  stopped
  1  operational failure (state file busy or unreadable)
  2  usage error`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotStop,
}

var operatorAutopilotStatusCmd = &cobra.Command{
	Use:   "status [--json]",
	Short: "Show the queue: state, mode, repo, branch, PR, position, recovery",
	Long: `Read-only queue view: per item the derived state (done, paused, held, pending,
spawned), mode, repo, branch, PR, merge-sequence position and recovery marker.
When every item is done it ends with the Queue Completion Summary. States derive
from stored facts only; step applies the live PR checks.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --json          machine-readable envelope on stdout

Examples:
  rk operator autopilot status
  rk operator autopilot status --json

Exit codes:
  0  listed (an absent state file lists nothing)
  1  operational failure (state file unreadable)
  2  usage error`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotStatus,
}

func init() {
	operatorAutopilotCmd.PersistentFlags().StringP("server", "L", "", "tmux server whose operator state to use (default: the caller's own server from $TMUX, else default)")

	f := operatorAutopilotQueueCmd.Flags()
	f.String("mode", "", "merge mode: "+strings.Join(operator.MergeModes, ", ")+" (default: the operator.merge_mode setting, else cherry-pick-ladder)")
	f.String("by", operator.ByChat, "note author: user, run, chat")
	f.Bool("dry-run", false, "validate and report without writing")
	f.Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	f = operatorAutopilotStepCmd.Flags()
	f.String("by", operator.ByRun, "note author: run or chat")
	f.Bool("dry-run", false, "report the plan without side effects")
	f.Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	operatorAutopilotMergeCmd.Flags().String("repo", "", "limit to one repo (absolute path)")
	operatorAutopilotMergeCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorAutopilotStopCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorAutopilotStatusCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	operatorAutopilotCmd.AddCommand(
		operatorAutopilotQueueCmd, operatorAutopilotStepCmd, operatorAutopilotMergeCmd,
		operatorAutopilotStopCmd, operatorAutopilotStatusCmd,
	)
	operatorCmd.AddCommand(operatorAutopilotCmd)
}

// autopilotError maps an engine error onto the exit classes: a caller mistake
// is usage (2), everything else operational (1).
func autopilotError(err error) error {
	var inv *autopilot.InvalidError
	if errors.As(err, &inv) {
		return usageError(err)
	}
	return operatorTrackError(err)
}

// autopilotAuthor validates --by against the verb's allowed authors.
func autopilotAuthor(cmd *cobra.Command, allowed ...string) (string, error) {
	by, _ := cmd.Flags().GetString("by")
	for _, a := range allowed {
		if by == a {
			return by, nil
		}
	}
	return "", usageError(fmt.Errorf("invalid --by %q (valid: %s)", by, strings.Join(allowed, ", ")))
}

// autopilotFinish writes a verb's outcome: the envelope under --json, else the
// human rendering.
func autopilotFinish(cmd *cobra.Command, result any, render func(outputSink), err error) error {
	err = autopilotError(err)
	asJSON, _ := cmd.Flags().GetBool("json")
	sink := newSink(cmd)
	if asJSON {
		return sink.Envelope(result, err)
	}
	if err != nil {
		return err
	}
	render(sink)
	return nil
}

func runAutopilotQueue(cmd *cobra.Command, args []string) error {
	by, err := autopilotAuthor(cmd, operator.ByUser, operator.ByRun, operator.ByChat)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	dry, _ := cmd.Flags().GetBool("dry-run")
	mode, _ := cmd.Flags().GetString("mode")
	raw, err := io.ReadAll(io.LimitReader(cmd.InOrStdin(), autopilotStdinCap))
	if err != nil {
		return autopilotFinish(cmd, nil, nil, fmt.Errorf("read entries from stdin: %w", err))
	}
	entries, err := autopilot.ParseEntries(raw)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	env, err := autopilotEnvFn(cmd, by, dry)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	rec, err := autopilot.Enqueue(operatorTrackContext(cmd), env, entries, autopilot.QueueOptions{Mode: mode}, autopilotSettingsFn())
	return autopilotFinish(cmd, rec, func(s outputSink) {
		s.Dataf("mode: %s (%s)\n", rec.Mode, rec.Source)
		verb := "queued"
		if rec.DryRun {
			verb = "would queue"
		}
		for _, id := range rec.Items {
			s.Dataf("%s %s\n", verb, id)
		}
		for _, m := range rec.Misfits {
			s.Dataf("%s\n", m)
		}
	}, err)
}

func renderStep(s outputSink, res *autopilot.StepResult) {
	prefix := ""
	if res.DryRun {
		prefix = "dry-run: "
	}
	for _, a := range res.Actions {
		line := prefix + a.Kind + " " + a.Item
		if a.Detail != "" {
			line += " " + a.Detail
		}
		s.Dataf("%s\n", line)
	}
	for _, r := range res.Report {
		s.Dataf("%s\n", r)
	}
	for _, e := range res.Escalations {
		s.Dataf("escalate %s: %s\n", e.Item, e.Reason)
	}
	if len(res.Actions)+len(res.Report)+len(res.Escalations) == 0 {
		s.Dataf("%snothing to do\n", prefix)
	}
}

func runAutopilotStep(cmd *cobra.Command, args []string) error {
	by, err := autopilotAuthor(cmd, operator.ByRun, operator.ByChat)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	dry, _ := cmd.Flags().GetBool("dry-run")
	env, err := autopilotEnvFn(cmd, by, dry)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	res, err := autopilot.Step(operatorTrackContext(cmd), env)
	return autopilotFinish(cmd, res, func(s outputSink) { renderStep(s, res) }, err)
}

func runAutopilotMerge(cmd *cobra.Command, args []string) error {
	repo, _ := cmd.Flags().GetString("repo")
	env, err := autopilotEnvFn(cmd, operator.ByChat, false)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	res, err := autopilot.StartMerge(operatorTrackContext(cmd), env, autopilot.MergeOptions{Repo: repo})
	return autopilotFinish(cmd, res, func(s outputSink) { renderStep(s, res) }, err)
}

func runAutopilotStop(cmd *cobra.Command, args []string) error {
	env, err := autopilotEnvFn(cmd, operator.ByChat, false)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	res, err := autopilot.Stop(operatorTrackContext(cmd), env)
	return autopilotFinish(cmd, res, func(s outputSink) { renderStep(s, res) }, err)
}

func runAutopilotStatus(cmd *cobra.Command, args []string) error {
	env, err := autopilotEnvFn(cmd, operator.ByChat, false)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	res, err := autopilot.Status(operatorTrackContext(cmd), env)
	return autopilotFinish(cmd, res, func(s outputSink) {
		for _, it := range res.Items {
			line := fmt.Sprintf("%s · %s · %s · %s", it.ID, it.State, it.Mode, it.Repo)
			if it.Branch != "" {
				line += " · " + it.Branch
			}
			if it.PR != "" {
				line += " · PR #" + it.PR
			}
			if it.Sequence != "" {
				line += " · " + it.Sequence
			}
			if it.Recovery != "" {
				line += " · recovery: " + it.Recovery
			}
			if it.Halted {
				line += " · halted"
			}
			s.Dataf("%s\n", line)
		}
		if len(res.Items) == 0 {
			s.Dataf("no queue\n")
		}
		if res.Summary != "" {
			s.Dataf("\n%s\n", res.Summary)
		}
	}, err)
}
