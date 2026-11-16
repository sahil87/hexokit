package autopilot

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"rk/internal/operator"
)

// Step runs one idempotent pass over the server's ledger: observe the facts
// of the items that can act, derive their statuses, decide one rule row per
// item, and execute the chosen actions in ledger order. No call waits for CI:
// the next step picks up where this one stopped. It runs under the pass lock;
// under DryRun it reads but never writes or acts, and takes no lock.
func Step(ctx context.Context, env Env) (*StepResult, error) {
	return passLocked(env, func() (*StepResult, error) { return step(ctx, env) })
}

func step(ctx context.Context, env Env) (result *StepResult, resultErr error) {
	e := newEngine(env)
	defer func() {
		if resultErr != nil {
			e.escalate("", "step failed: "+resultErr.Error())
		}
	}()
	return e.pass(ctx)
}

// pass is the one pass every writing verb runs: observe → derive → decide →
// execute. Under DryRun it renders the decisions instead of executing them.
func (e *engine) pass(ctx context.Context) (*StepResult, error) {
	st, f, err := e.observe(ctx)
	if err != nil {
		return e.res, err
	}
	ds := decide(st, f, e.env.now())
	if e.env.DryRun {
		e.renderDecisions(ds)
		return e.res, nil
	}
	return e.res, e.execute(ctx, f, ds)
}

// Stop is the global user stop: it halts the unfinished merge sequences so a
// later step does not re-arm them, pauses every unspawned queue item, and runs
// one pass, in which row P3 disarms every armed PR in the halted cone. Live
// panes are left untouched. A disarm that fails is retried by the next stop or
// step. It runs under the pass lock.
func Stop(ctx context.Context, env Env) (*StepResult, error) {
	return passLocked(env, func() (*StepResult, error) { return stop(ctx, env) })
}

func stop(ctx context.Context, env Env) (*StepResult, error) {
	e := newEngine(env)
	var paused []string
	if err := e.mutateEngine(func(st *engineState) error {
		unfinished := false
		for i := range st.Queue {
			it := &st.Queue[i]
			if it.Pane == "" && it.DoneAt == nil && !it.Paused {
				it.Paused = true
				it.UpdatedAt = operator.NowRFC3339()
				paused = append(paused, it.ID)
			}
		}
		for i := range st.PRs {
			it := &st.PRs[i]
			if it.DoneAt == nil {
				it.Halted = true
				unfinished = true
			}
		}
		if len(paused) == 0 && !unfinished {
			return operator.ErrNoWrite
		}
		return nil
	}); err != nil {
		e.escalate("", "stop intent not written: "+err.Error())
		return e.res, fmt.Errorf("stop intent not written: %w", err)
	}
	for _, id := range paused {
		e.act(ActPaused, id, "")
	}
	_, err := e.pass(ctx)
	return e.res, errors.Join(err, e.disarmErr, e.coneErr)
}

// StatusItem is one queue item in the status view.
type StatusItem struct {
	ID        string      `json:"id"`
	State     QueueStatus `json:"state"`
	Mode      string      `json:"mode"`
	Repo      string      `json:"repo"`
	Branch    string      `json:"branch"`
	PR        string      `json:"pr"`
	DependsOn []string    `json:"depends_on"`
	// Sequence is the item's merge-sequence position ("2/3"), "" before one
	// exists.
	Sequence string `json:"sequence"`
	// Queue is the id stamped by `autopilot queue` ("" for a legacy item).
	Queue string `json:"queue"`
	// PRStatus is the derived status of the item's PR item ("" before one
	// exists).
	PRStatus string `json:"pr_status"`
	Halted   bool   `json:"halted"`
}

// StatusResult is the read-only queue view. Summary is the Queue Completion
// Summary, present when every queue item is done.
type StatusResult struct {
	Items    []StatusItem `json:"items"`
	Complete bool         `json:"complete"`
	Summary  string       `json:"summary"`
	// Structured human-rendering inputs share the full JSON summary source.
	SummaryItems []string `json:"-"`
	MergeOrder   []string `json:"-"`
}

// Status derives the queue view with the same observe and derive stages as
// step, so it shows the statuses step acts on. It makes read-only gh calls,
// takes no pass lock, writes nothing and reports no escalations: a failed
// lookup is returned as plain error text.
func Status(ctx context.Context, env Env) (StatusResult, error) {
	// Status reports failures without writing notes to the ledger.
	env.DryRun = true
	e := newEngine(env)
	e.readOnly = true
	st, f, err := e.observe(ctx)
	if err != nil {
		return StatusResult{Items: []StatusItem{}}, err
	}
	res := StatusResult{Items: []StatusItem{}}
	var queue []operator.TrackedItem
	for _, it := range st.Tracked {
		if isQueueItem(st, it) {
			queue = append(queue, it)
		}
	}
	allDone := len(queue) > 0
	for _, it := range queue {
		state := deriveQueue(st, f, it)
		if state != QueueDone {
			allDone = false
		}
		row := StatusItem{
			ID: it.ID, State: state, Mode: modeOf(it), Repo: operator.ScopeString(it.Scope, "repo"),
			Branch: itemBranch(st, it), DependsOn: append([]string{}, it.DependsOn...),
			Queue: operator.ScopeString(it.Scope, scopeQueue),
		}
		for _, p := range st.Tracked {
			if !isPRItem(p) || operator.ScopeString(p.Scope, scopeItem) != it.ID {
				continue
			}
			row.PR = prNum(p.Scope)
			ps := derivePR(st, f, p)
			row.PRStatus, row.Halted = string(ps), ps == PRHalted
			seq := seqItems(st, seqOf(p))
			for i, s := range seq {
				if s.ID == p.ID {
					row.Sequence = fmt.Sprintf("%d/%d", i+1, len(seq))
				}
			}
		}
		res.Items = append(res.Items, row)
	}
	res.Complete = allDone
	if allDone {
		res.SummaryItems, res.MergeOrder = e.completionSummary(ctx, st, queue)
		res.Summary = fmt.Sprintf("Queue complete. %d PRs ready for review:\n%s\nMerge per-repo: %s. Or ask me to merge all.", len(queue), strings.Join(res.SummaryItems, "\n"), strings.Join(res.MergeOrder, ", "))
	}
	var lookupErr error
	for _, w := range e.warnings {
		lookupErr = errors.Join(lookupErr, errors.New(w))
	}
	return res, lookupErr
}

// completionSummary renders the Queue Completion Summary: every PR with its
// role, and the per-repo merge order.
func (e *engine) completionSummary(ctx context.Context, st *operator.State, queue []operator.TrackedItem) ([]string, []string) {
	pos := map[string]int{}
	for i, it := range queue {
		pos[it.ID] = i + 1
	}
	var rows []string
	repoOrder := []string{}
	repoPos := map[string][]int{}
	repoBarrier := map[string]string{}
	for i, it := range queue {
		repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
		url := "(no PR found)"
		if br := itemBranch(st, it); br != "" {
			if v, err := e.viewPR(ctx, repo, "", br, "url"); err != nil {
				e.escalate(it.ID, "completion summary PR lookup failed: "+stderrOf(err))
			} else if v.URL != "" {
				url = v.URL
			}
		}
		role, barrier := e.roleOf(st, it, repo, pos)
		rows = append(rows, fmt.Sprintf("%d. %s: %s (%s, %s)", i+1, it.ID, url, tildePath(repo), role))
		if _, seen := repoPos[repo]; !seen {
			repoOrder = append(repoOrder, repo)
			repoBarrier[repo] = barrier
		}
		repoPos[repo] = append(repoPos[repo], i+1)
	}
	parts := make([]string, 0, len(repoOrder))
	for _, repo := range repoOrder {
		ps := repoPos[repo]
		seg := fmt.Sprintf("%s %d", filepath.Base(repo), ps[0])
		if len(ps) > 1 {
			seg = fmt.Sprintf("%s %d→%d", filepath.Base(repo), ps[0], ps[len(ps)-1])
		}
		if bar := repoBarrier[repo]; bar != "" {
			seg += " (after " + bar + " reaches main)"
		}
		parts = append(parts, seg)
	}
	return rows, parts
}

// roleOf describes how an item relates to its dependencies and, for the
// per-repo line, the cross-repo barrier its repo waits behind.
func (e *engine) roleOf(st *operator.State, it operator.TrackedItem, repo string, pos map[string]int) (role, barrier string) {
	var cross string
	for _, d := range it.DependsOn {
		di := operator.IndexOf(st.Tracked, d)
		if di < 0 {
			continue
		}
		dRepo := cleanRepo(depRepo(st, st.Tracked[di]))
		if dRepo == repo {
			return "depends on " + d, ""
		}
		if cross == "" {
			cross = d
			if p, ok := pos[d]; ok {
				barrier = fmt.Sprintf("%s:%d", filepath.Base(dRepo), p)
			}
		}
	}
	if cross != "" {
		return "ordering-only after " + cross, barrier
	}
	return "base", ""
}

func tildePath(p string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" && strings.HasPrefix(p, home+string(filepath.Separator)) {
		return "~" + strings.TrimPrefix(p, home)
	}
	return p
}
