package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"rk/internal/autopilot"
	"rk/internal/operator"
	"rk/internal/settings"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk operator autopilot — the CLI door onto internal/autopilot, the
// deterministic queue engine. Runs and the operator chat call these verbs
// instead of executing git choreography from prose; the queue itself is the
// engine file's items, so there is no queue store to keep in sync.

const autopilotStdinCap = 1 << 20
const autopilotListCap = 20

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
		DryRun: dry,
		Notify: func(ctx context.Context, title, body string) { sendNotify(ctx, title, body) },
	}, nil
}

// autopilotPanes is the production pane view: the operator's pane snapshot
// (with each pane's derived fab change) and a pane's process id.
type autopilotPanes struct{ server string }

func (p autopilotPanes) PID(ctx context.Context, pane string) (int, error) {
	return tmux.PanePIDCtx(ctx, pane, p.server)
}

func (p autopilotPanes) Snapshot(ctx context.Context) (map[string]operator.PaneInfo, error) {
	return operator.SnapshotPanes(ctx, p.server)
}

var operatorAutopilotCmd = &cobra.Command{
	Use:   "autopilot",
	Short: "Run operator queues: readiness, spawn, respawn, completion",
	Long: `Run operator queues deterministically. A queue is N pane items chained by
depends_on. Every verb re-reads the operator state file, acts, and writes back
under a lock, so nothing is held in memory and a fresh run picks up exactly where
the last one stopped.

Each pass observes the facts of the items that can act, derives a status per
item, picks at most one rule row per item, and executes the chosen actions in
queue order. step --dry-run prints the chosen rows and runs nothing.

The engine does queue work only: readiness, SHA-pinned spawn, one respawn and
completion. Readying, arming, merging and restacking PRs and fixing red CI or
conflicts are the operator run's work, under the queue's mode as its merge
authority.

Verbs: queue, step, stop, status, rm, resume, pause. Engine intent lives in a
per-server YAML file beside the ledger; ledger items are projections only.
Escalations become by: run notes and rk notify calls. Only status is a pure read.
All verbs take -L/--server (default: the caller's own server from $TMUX).

Every writing verb is single-writer: it takes a per-server pass lock for the
whole intent write and following pass. A second one that finds the lock held
writes nothing and reports busy. Step, stop, rm, resume and pause exit 0 on busy;
queue exits 1 without queueing and asks for a retry. status takes no lock.

Merge modes (--mode, or the operator.merge_mode setting) shape how an item is
spawned and tell the operator its merge authority:
  cherry-pick-ladder  chained PRs; each change gets its dependencies cherry-picked
                      in; the operator merges only on the user's word
  stacked-prs         chained PRs; each is cut from its dependency's branch and
                      records that base; the operator merges only on the user's
                      word
  merge-auto          every PR is based on the default branch, unchained; the next
                      change waits until the previous PR is merged; the operator
                      merges green PRs without asking`,
	Example: `  echo '[{"id":"ab12","repo":"/src/app","change":"ab12"}]' | rk operator autopilot queue
  rk operator autopilot step --json
  rk operator autopilot status`,
	Args: usageArgs(cobra.NoArgs),
	RunE: func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var operatorAutopilotQueueCmd = &cobra.Command{
	Use:   "queue [--mode <mode>] [--dry-run] [--all] [--json] < entries.json",
	Short: "Persist a queue of pending pane items from JSON entries on stdin",
	Long: `Persist a queue as N pending items in one engine-file write under the pass
lock, then run one pass. If another pass holds the lock, nothing is written:
print "busy: another autopilot pass is running on this server; queue not
written, retry" and exit 1. A --dry-run takes no lock and writes nothing.
Entries arrive as a JSON array on stdin:

  [
    {"id": "ab12", "repo": "/src/app", "change": "ab12"},
    {"id": "fix-login", "repo": "/src/web", "task": "fix login after password reset"},
    {"id": "ef56", "repo": "/src/app", "change": "ef56", "depends_on": ["ab12"], "stop_stage": null},
    {"id": "deps", "repo": "/src/loom", "task": "bump deps", "plain": true, "base": "eng-v2"}
  ]

An entry names an existing fab change (change), raw text (task), or neither (a
bare agent, which nothing may depend on). Two optional fields shape it: plain
(true) runs a task as a plain agent in a fab repo too — the task text plus
"commit, push and open a draft PR", no /fab-new, finished when its PR merges or
is green — and is refused with a change or a stop_stage; base names the branch
the worktree starts from and the PR targets (default: the repo's default
branch), and must exist on the repo's origin. base is refused on a stacked-prs
entry that has a same-repo dependency, which bases on that dependency's branch.
The mode resolves as --mode, then the
operator.merge_mode setting, then cherry-pick-ladder, and is stamped on every
item; the receipt prints it as "mode: <name> (flag|setting|default)". An invalid
setting value is an error, never a silent fallback.

Every entry after the first depends on the nearest earlier entry in its repo,
else on the previous entry (an ordering-only barrier across repos). An explicit
depends_on replaces that. In merge-auto each entry depends on the previous one as
a barrier only: a same-repo depends_on, implicit or explicit, waits for the
dependency's PR to merge. Preview with --dry-run, confirm the mode, then queue
once with --mode.

Flags:
  --mode          merge mode: cherry-pick-ladder, stacked-prs, merge-auto
  --dry-run       validate and report without writing
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --all           show every entry (human lists default to 20 entries each)
  --json          complete machine-readable envelope on stdout

Examples:
  echo '[{"id":"ab12","repo":"/src/app","change":"ab12"}]' | rk operator autopilot queue
  rk operator autopilot queue --mode stacked-prs < queue.json

Exit codes:
  0  queued
  1  operational failure (another pass holds the lock; queue not written,
     state file busy or unreadable, a state write failed)
  2  usage error (bad entries, id already tracked, invalid mode or setting,
                  bare dependency, forward or cyclic dependency, relative or
                  non-git repo, plain with a change or stop_stage, base that
                  is invalid, not on origin, or set on a stacked-prs entry
                  with a same-repo dependency)`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotQueue,
}

var operatorAutopilotStepCmd = &cobra.Command{
	Use:   "step [--dry-run] [--all] [--json]",
	Short: "Advance every queue one idempotent pass",
	Long: `Run one pass over the server's queue items: observe, derive each item's
status, pick at most one rule row per item, and execute the chosen actions. A
queue item whose completion is observed is recorded done; a pending item whose
dependencies are satisfied is spawned; a dead pane is respawned once. No call
waits for CI or a merge; call step again later.

A merge-auto item waits until its predecessor is done and that predecessor's PR
reads merged. A same-repo successor of an item with no stop_stage waits until the
predecessor's PR exists.

step takes the per-server pass lock (a --dry-run does not). If another pass
holds it, step does nothing, prints "busy" and exits 0.

The output lists actions taken (spawned, respawned, cherry-picked, paused, done,
removed, resumed) and escalations. The engine writes each escalation as a by: run note and sends rk notify once per dedupe key.
--dry-run reads but changes nothing: it lists each chosen row as
"dry-run: <action> <item> (<row>)", for example "dry-run: spawn ab12 (Q2)".

Flags:
  --dry-run       report the plan without side effects
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --all           show every entry (human lists default to 20 entries each)
  --json          complete machine-readable envelope on stdout

Examples:
  rk operator autopilot step
  rk operator autopilot step --dry-run --json

Exit codes:
  0  stepped (with or without actions or escalations), or busy
  1  operational failure (state file busy or unreadable, tmux pane snapshot
     failed, a state write failed)
  2  usage error`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotStep,
}

var operatorAutopilotStopCmd = &cobra.Command{
	Use:   "stop [--all] [--json]",
	Short: "Pause every unspawned queue item",
	Long: `Global user stop: pause every unspawned, unfinished queue item so a later step
does not spawn it, then run one pass. Live panes are left untouched, and no PR is
read or changed. Use rk operator autopilot resume <id> to release an item.

stop takes the per-server pass lock. If another pass holds it, stop does
nothing, prints "busy" and exits 0.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --all           show every entry (human lists default to 20 entries each)
  --json          complete machine-readable envelope on stdout

Examples:
  rk operator autopilot stop

Exit codes:
  0  stopped, or busy
  1  operational failure (state file busy or unreadable, a state write failed)
  2  usage error`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotStop,
}

var operatorAutopilotStatusCmd = &cobra.Command{
	Use:   "status [--all] [--json]",
	Short: "Show queue items with their derived status",
	Long: `Queue view: per item the derived status (done, paused, skipped, held,
pending, spawn-unknown, spawned, dead), mode, repo and branch. Status writes
nothing, takes no pass lock and reports no escalations. It lists queue items
only; PRs are read with rk operator track list.

Statuses are derived by the same observe and derive stages as step, so status
makes read-only GitHub calls: whether a same-repo dependency's PR exists (a
dependency with no PR yet is simply held), whether a merge-auto predecessor's PR
is merged, and a plain agent's PR state. The Queue Completion Summary (shown
when every item is done) reads each PR link. If a gh lookup fails, the failures
are printed as plain text, nothing else is listed in the human view, and the
command exits 1; with --json the envelope reports ok:false with that error and
still carries the items it derived.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --all           show every entry (human lists default to 20 entries each)
  --json          complete machine-readable envelope on stdout (items carry
                  state, mode, task, change and stop_stage)

Examples:
  rk operator autopilot status
  rk operator autopilot status --json

Exit codes:
  0  listed (an absent state file lists nothing)
  1  operational failure (state file unreadable, a gh lookup failed)
  2  usage error`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotStatus,
}

func init() {
	operatorAutopilotCmd.PersistentFlags().StringP("server", "L", "", "tmux server whose operator state to use (default: the caller's own server from $TMUX, else default)")

	f := operatorAutopilotQueueCmd.Flags()
	f.String("mode", "", "merge mode: "+strings.Join(operator.MergeModes, ", ")+" (default: the operator.merge_mode setting, else cherry-pick-ladder)")
	f.Bool("dry-run", false, "validate and report without writing")
	f.Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	f = operatorAutopilotStepCmd.Flags()
	f.Bool("dry-run", false, "report the plan without side effects")
	f.Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	operatorAutopilotStopCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorAutopilotStatusCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorAutopilotRemoveCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorAutopilotResumeCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorAutopilotPauseCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	for _, cmd := range []*cobra.Command{operatorAutopilotQueueCmd, operatorAutopilotStepCmd, operatorAutopilotStopCmd, operatorAutopilotStatusCmd, operatorAutopilotRemoveCmd, operatorAutopilotResumeCmd, operatorAutopilotPauseCmd} {
		cmd.Flags().Bool("all", false, "show every list entry (default: 20 per human list; JSON is always complete)")
	}

	operatorAutopilotCmd.AddCommand(
		operatorAutopilotQueueCmd, operatorAutopilotStepCmd,
		operatorAutopilotStopCmd, operatorAutopilotRemoveCmd, operatorAutopilotResumeCmd, operatorAutopilotPauseCmd, operatorAutopilotStatusCmd,
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
	dry, _ := cmd.Flags().GetBool("dry-run")
	mode, _ := cmd.Flags().GetString("mode")
	raw, err := io.ReadAll(io.LimitReader(cmd.InOrStdin(), autopilotStdinCap+1))
	if err != nil {
		return autopilotFinish(cmd, nil, nil, fmt.Errorf("read entries from stdin: %w", err))
	}
	if len(raw) > autopilotStdinCap {
		return autopilotFinish(cmd, nil, nil, usageError(fmt.Errorf("queue entries exceed the %d-byte stdin limit", autopilotStdinCap)))
	}
	entries, err := autopilot.ParseEntries(raw)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	env, err := autopilotEnvFn(cmd, operator.ByRun, dry)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	rec, err := autopilot.Enqueue(operatorTrackContext(cmd), env, entries, autopilot.QueueOptions{Mode: mode, ModeSet: cmd.Flags().Changed("mode")}, autopilotSettingsFn())
	return autopilotFinish(cmd, rec, func(s outputSink) {
		s.Dataf("mode: %s (%s)\n", rec.Mode, rec.Source)
		verb := "queued"
		if rec.DryRun {
			verb = "would queue"
		}
		for _, id := range rec.Items[:autopilotShown(cmd, len(rec.Items))] {
			s.Dataf("%s %s\n", verb, id)
		}
		autopilotListTotal(s, "items", len(rec.Items), autopilotShown(cmd, len(rec.Items)))
		for _, m := range rec.Misfits[:autopilotShown(cmd, len(rec.Misfits))] {
			s.Dataf("%s\n", m)
		}
		autopilotListTotal(s, "misfits", len(rec.Misfits), autopilotShown(cmd, len(rec.Misfits)))
		if len(rec.Actions)+len(rec.Escalations) > 0 {
			renderStep(cmd, s, &autopilot.StepResult{Actions: rec.Actions, Escalations: rec.Escalations})
		}
	}, err)
}

func renderStep(cmd *cobra.Command, s outputSink, res *autopilot.StepResult) {
	if res.Busy {
		s.Dataf("busy: another autopilot pass is running on this server; retry later\n")
		return
	}
	prefix := ""
	if res.DryRun {
		prefix = "dry-run: "
	}
	for _, a := range res.Actions[:autopilotShown(cmd, len(res.Actions))] {
		line := prefix + a.Kind + " " + a.Item
		if a.Detail != "" {
			line += " " + a.Detail
		}
		s.Dataf("%s\n", line)
	}
	autopilotListTotal(s, "actions", len(res.Actions), autopilotShown(cmd, len(res.Actions)))
	for _, e := range res.Escalations[:autopilotShown(cmd, len(res.Escalations))] {
		s.Dataf("escalate %s: %s\n", e.Item, e.Reason)
	}
	autopilotListTotal(s, "escalations", len(res.Escalations), autopilotShown(cmd, len(res.Escalations)))
	if len(res.Actions)+len(res.Escalations) == 0 {
		s.Dataf("%snothing to do\n", prefix)
	}
}

func runAutopilotStep(cmd *cobra.Command, args []string) error {
	dry, _ := cmd.Flags().GetBool("dry-run")
	env, err := autopilotEnvFn(cmd, operator.ByRun, dry)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	res, err := autopilot.Step(operatorTrackContext(cmd), env)
	return autopilotFinish(cmd, res, func(s outputSink) { renderStep(cmd, s, res) }, err)
}

func runAutopilotStop(cmd *cobra.Command, args []string) error {
	env, err := autopilotEnvFn(cmd, operator.ByChat, false)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	res, err := autopilot.Stop(operatorTrackContext(cmd), env)
	return autopilotFinish(cmd, res, func(s outputSink) { renderStep(cmd, s, res) }, err)
}

func runAutopilotStatus(cmd *cobra.Command, args []string) error {
	env, err := autopilotEnvFn(cmd, operator.ByChat, false)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	res, err := autopilot.Status(operatorTrackContext(cmd), env)
	return autopilotFinish(cmd, res, func(s outputSink) {
		for _, it := range res.Items[:autopilotShown(cmd, len(res.Items))] {
			line := fmt.Sprintf("%s · %s · %s · %s", it.ID, it.State, it.Mode, it.Repo)
			if it.Branch != "" {
				line += " · " + it.Branch
			}
			if it.Plain {
				line += " · plain"
			}
			if it.Base != "" {
				line += " · base " + it.Base
			}
			s.Dataf("%s\n", line)
		}
		autopilotListTotal(s, "items", len(res.Items), autopilotShown(cmd, len(res.Items)))
		if len(res.Items) == 0 {
			s.Dataf("no queue\n")
		}
		if res.Summary != "" {
			s.Dataf("\nQueue complete. %d PRs ready for review:\n", len(res.SummaryItems))
			for _, line := range res.SummaryItems[:autopilotShown(cmd, len(res.SummaryItems))] {
				s.Dataf("%s\n", line)
			}
			autopilotListTotal(s, "review PRs", len(res.SummaryItems), autopilotShown(cmd, len(res.SummaryItems)))
			s.Dataf("Merge per-repo: %s. Or ask me to merge all.\n", strings.Join(res.MergeOrder[:autopilotShown(cmd, len(res.MergeOrder))], ", "))
			autopilotListTotal(s, "repos", len(res.MergeOrder), autopilotShown(cmd, len(res.MergeOrder)))
		}
	}, err)
}

func autopilotShown(cmd *cobra.Command, total int) int {
	all, _ := cmd.Flags().GetBool("all")
	if all || total <= autopilotListCap {
		return total
	}
	return autopilotListCap
}

func autopilotListTotal(s outputSink, label string, total, shown int) {
	if total == 0 {
		return
	}
	if shown < total {
		s.Dataf("%s: %d total; showing %d (cap %d), %d omitted; use --all to show all\n", label, total, shown, autopilotListCap, total-shown)
	} else {
		s.Dataf("%s: %d total\n", label, total)
	}
}
