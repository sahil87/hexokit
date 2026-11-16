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
// instead of executing git/gh choreography from prose; the queue itself is the
// tracked items, so there is no queue store to keep in sync.

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
		By: by, DryRun: dry,
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
	Short: "Run operator queues: spawn, chain, and merge in order",
	Long: `Run operator queues deterministically. A queue is N pane items chained by
depends_on; a merge sequence is a chain of github-pr items. Every verb re-reads
the operator state file, acts, and writes back under a lock, so nothing is held
in memory and a fresh run picks up exactly where the last one stopped.

Each pass observes the facts of the items that can act, derives a status per
item, picks at most one rule row per item, and executes the chosen actions in
ledger order. step --dry-run prints the chosen rows and runs nothing.

Verbs: queue, step, merge, stop, rm, resume, status. Engine intent lives in a
per-server YAML file beside the ledger; ledger items are projections only.
Escalations become by: run notes and rk notify calls. Only status is a pure read.
All verbs take -L/--server (default: the caller's own server from $TMUX).

Every writing verb is single-writer: it takes a per-server pass lock for the
whole intent write and following pass. A second one that finds the lock held
writes nothing and reports busy. Step, merge, stop, rm and resume exit 0 on busy;
queue exits 1 without queueing and asks for a retry. status takes no lock.

Merge modes (--mode, or the operator.merge_mode setting):
  cherry-pick-ladder  chained PRs; each change gets its dependencies cherry-picked
                      in; merge after review
  stacked-prs         chained PRs; each is cut from its dependency's branch;
                      register chains with merge; restacks escalate until supported
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
	Use:   "queue [--mode <mode>] [--by user|run|chat] [--dry-run] [--all] [--json] < entries.json",
	Short: "Persist a queue of pending pane items from JSON entries on stdin",
	Long: `Persist a queue as N pending items in one engine-file write under the pass
lock, then run one pass. If another pass holds the lock, nothing is written:
print "busy: another autopilot pass is running on this server; queue not
written, retry" and exit 1. A --dry-run takes no lock and writes nothing.
Entries arrive as a JSON array on stdin:

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
as a misfit. Without an explicit --mode, a live call refuses it without writing.
Preview with --dry-run, confirm the mode and misfits, then queue once with --mode.

Flags:
  --mode          merge mode: cherry-pick-ladder, stacked-prs, merge-auto
  --by            note author: user, run, chat (default chat)
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
                  non-git repo, invalid --by, unconfirmed misfit)`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotQueue,
}

var operatorAutopilotStepCmd = &cobra.Command{
	Use:   "step [--by run|chat] [--dry-run] [--all] [--json]",
	Short: "Advance every queue and merge sequence one idempotent pass",
	Long: `Run one pass over the server's tracked items: observe, derive each item's
status, pick at most one rule row per item, and execute the chosen actions. A
queue item whose completion is observed is recorded done; a pending item whose
dependencies are satisfied is spawned; a dead pane is respawned once. A merge
sequence advances one PR per pass: the head PR is readied if draft, armed while
its checks are pending, and merged when green (a repo without auto-merge is
merged on green); a PR merged on GitHub is recorded and its successor acts on
the next pass. Every armed PR of a halted sequence is disarmed, whoever armed
it. No call waits for CI; call step again later.

A failed required check, or CONFLICTING with no progress, is only escalated as
"recovery needed: <ci-failed|conflicting> — PR #<n> (<repo>)", once per head
commit. The engine does not arm such a PR and does nothing else to it.

step takes the per-server pass lock (a --dry-run does not). If another pass
holds it, step does nothing, prints "busy" and exits 0.

The output lists actions taken (spawned, cherry-picked, armed, merged,
disarmed, readied), per-merge report lines, and escalations. The engine writes
each escalation as a by: run note and sends rk notify once per dedupe key.
--dry-run reads but changes nothing: it lists each chosen row as
"dry-run: <action> <item> (<row>)", for example "dry-run: spawn ab12 (Q2)".

Flags:
  --by            note author: run (default) or chat
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
  2  usage error (invalid --by)`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotStep,
}

var operatorAutopilotMergeCmd = &cobra.Command{
	Use:   "merge [--repo <path>] [--all] [--json]",
	Short: "Start the ordered merge of a completed queue",
	Long: `Start the ordered merge for completed cherry-pick-ladder and stacked-prs
queues (every repo, or one with --repo): create the github-pr chain items in the
engine file and their ledger projections, then run one pass. Cherry-pick-ladder
sequences ready, arm or merge each head in later steps. Stacked-prs sequences
escalate restacks; they are never armed or merged in this step. Run this only on
the user's confirmation to merge all. It refuses while queue items are not done
and does nothing for merge-auto items.

merge takes the per-server pass lock. If another pass holds it, merge does
nothing, prints "busy" and exits 0.

Flags:
  --repo          limit to one repo (absolute path)
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --all           show every entry (human lists default to 20 entries each)
  --json          complete machine-readable envelope on stdout

Examples:
  rk operator autopilot merge
  rk operator autopilot merge --repo /src/app --json

Exit codes:
  0  started (or nothing to merge), or busy
  1  operational failure (queue items not done, no PR for a branch, state file
     busy or unreadable, a gh lookup failed)
  2  usage error (--repo empty, relative or not a queued repository)`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotMerge,
}

var operatorAutopilotStopCmd = &cobra.Command{
	Use:   "stop [--all] [--json]",
	Short: "Disarm every armed PR and pause every unspawned queue item",
	Long: `Global user stop: halt the unfinished merge sequences so a later step does
not re-arm them, pause every unspawned queue item, and disarm every armed PR in
the halted sequences (gh pr merge --disable-auto), whoever armed it. Live panes
are left untouched. Armed is read from GitHub, so a disarm that fails is retried
by the next stop or step until GitHub reports it disarmed. Use
rk operator autopilot resume <id> on the one item that carries halted to resume
its derived downstream cone.

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
  1  operational failure (state file busy or unreadable, a state write failed,
     a disarm failed)
  2  usage error`,
	Args:         usageArgs(cobra.NoArgs),
	SilenceUsage: true,
	RunE:         runAutopilotStop,
}

var operatorAutopilotStatusCmd = &cobra.Command{
	Use:   "status [--all] [--json]",
	Short: "Show the queue: state, mode, repo, branch, PR, position",
	Long: `Queue view: per item the derived status (done, paused, skipped, held,
pending, spawn-unknown, spawned, dead), mode, repo, branch and, for an item with
a PR item, the PR number, the PR item's derived status (merged, halted, closed,
deferred, blocked, draft, failed, conflicting, green, waiting) and its
merge-sequence position, e.g. "PR #12 · green · 1/3". It writes nothing, takes
no pass lock and reports no escalations.

Statuses are derived by the same observe and derive stages as step, so status
makes read-only GitHub calls: gh pr view and gh pr checks for the PRs that can
act, and for readiness whether a same-repo dependency's PR exists (a dependency
with no PR yet is simply held). The Queue Completion Summary (shown when every
item is done) reads each PR link. If a gh lookup fails, the
failures are printed as plain text, nothing else is listed in the human view,
and the command exits 1; with --json the envelope reports ok:false with that
error and still carries the items it derived.

Flags:
  -L, --server    tmux server (default: the caller's own server from $TMUX)
  --all           show every entry (human lists default to 20 entries each)
  --json          complete machine-readable envelope on stdout (items carry
                  state and pr_status)

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
	operatorAutopilotRemoveCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")
	operatorAutopilotResumeCmd.Flags().Bool("json", false, "emit the machine-readable envelope (exactly one JSON document on stdout)")

	for _, cmd := range []*cobra.Command{operatorAutopilotQueueCmd, operatorAutopilotStepCmd, operatorAutopilotMergeCmd, operatorAutopilotStopCmd, operatorAutopilotStatusCmd, operatorAutopilotRemoveCmd, operatorAutopilotResumeCmd} {
		cmd.Flags().Bool("all", false, "show every list entry (default: 20 per human list; JSON is always complete)")
	}

	operatorAutopilotCmd.AddCommand(
		operatorAutopilotQueueCmd, operatorAutopilotStepCmd, operatorAutopilotMergeCmd,
		operatorAutopilotStopCmd, operatorAutopilotRemoveCmd, operatorAutopilotResumeCmd, operatorAutopilotStatusCmd,
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
	env, err := autopilotEnvFn(cmd, by, dry)
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
	reports := res.Report
	if len(res.Unreviewed) > 0 {
		reports = reports[:len(reports)-1]
	}
	for _, r := range reports[:autopilotShown(cmd, len(reports))] {
		s.Dataf("%s\n", r)
	}
	autopilotListTotal(s, "reports", len(reports), autopilotShown(cmd, len(reports)))
	if len(res.Unreviewed) > 0 {
		s.Dataf("merged without review: %s\n", strings.Join(res.Unreviewed[:autopilotShown(cmd, len(res.Unreviewed))], ", "))
		autopilotListTotal(s, "unreviewed merges", len(res.Unreviewed), autopilotShown(cmd, len(res.Unreviewed)))
	}
	for _, e := range res.Escalations[:autopilotShown(cmd, len(res.Escalations))] {
		s.Dataf("escalate %s: %s\n", e.Item, e.Reason)
	}
	autopilotListTotal(s, "escalations", len(res.Escalations), autopilotShown(cmd, len(res.Escalations)))
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
	return autopilotFinish(cmd, res, func(s outputSink) { renderStep(cmd, s, res) }, err)
}

func runAutopilotMerge(cmd *cobra.Command, args []string) error {
	repo, _ := cmd.Flags().GetString("repo")
	env, err := autopilotEnvFn(cmd, operator.ByChat, false)
	if err != nil {
		return autopilotFinish(cmd, nil, nil, err)
	}
	res, err := autopilot.StartMerge(operatorTrackContext(cmd), env, autopilot.MergeOptions{Repo: repo, RepoSet: cmd.Flags().Changed("repo")})
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
			if it.PR != "" {
				line += " · PR #" + it.PR
			}
			if it.PRStatus != "" {
				line += " · " + it.PRStatus
			}
			if it.Sequence != "" {
				line += " · " + it.Sequence
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
