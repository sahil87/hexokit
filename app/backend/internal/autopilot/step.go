package autopilot

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"rk/internal/operator"
)

const (
	// slowStage and slowQueue flag a stage or a whole queue that has run long;
	// they only flag, never act.
	slowStage = 30 * time.Minute
	slowQueue = 2 * time.Hour
)

// Step runs one idempotent pass over the server's ledger: persist observed
// completions, advance every merge sequence (verify, arm, merge, detect
// stalls, recover), spawn every ready queue item, and flag slow ones. No call
// waits for CI: the next step picks up where this one stopped. Under DryRun it
// reads but never writes or acts.
func Step(ctx context.Context, env Env) (result *StepResult, resultErr error) {
	e := newEngine(env)
	defer func() {
		if resultErr != nil {
			e.escalate("", "step failed: "+resultErr.Error())
		}
	}()
	if err := e.observeDone(ctx); err != nil {
		return e.res, err
	}
	if err := e.advance(ctx); err != nil {
		return e.res, err
	}
	if err := e.spawnPending(ctx); err != nil {
		return e.res, err
	}
	e.flagSlow()
	return e.res, nil
}

// flagSlow notes and escalates a spawned item whose stage has not moved for
// slowStage, and a queue that has been open for slowQueue.
func (e *engine) flagSlow() {
	st, err := e.load()
	if err != nil {
		return
	}
	now := e.env.now()
	var oldest time.Time
	var oldestID string
	for _, it := range st.Tracked {
		if !isQueueItem(st, it) || operator.ItemDone(it) {
			continue
		}
		if t, err := time.Parse(time.RFC3339, it.AddedAt); err == nil && (oldest.IsZero() || t.Before(oldest)) {
			oldest, oldestID = t, it.ID
		}
		if operator.ScopeString(it.Scope, "pane") == "" || it.Paused {
			continue
		}
		if t, err := time.Parse(time.RFC3339, it.UpdatedAt); err == nil && now.Sub(t) > slowStage {
			e.flagOnce(it, fmt.Sprintf("stage %s over %s without moving", stageLabel(it), slowStage))
		}
	}
	if oldestID != "" && now.Sub(oldest) > slowQueue {
		if i := operator.IndexOf(st.Tracked, oldestID); i >= 0 {
			e.flagOnce(st.Tracked[i], fmt.Sprintf("queue open for over %s", slowQueue))
		}
	}
}

func stageLabel(it operator.TrackedItem) string {
	if s := operator.ScopeString(it.Scope, "stage"); s != "" {
		return s
	}
	return "(unknown)"
}

func (e *engine) flagOnce(it operator.TrackedItem, text string) {
	for _, n := range it.Notes {
		if n.Text == "escalated: "+text {
			return
		}
	}
	e.escalate(it.ID, text)
}

// Stop is the global user stop: disarm every armed PR, halt the unfinished
// merge sequences so a later step does not re-arm them, and pause every
// unspawned queue item. Live panes are left untouched.
func Stop(ctx context.Context, env Env) (*StepResult, error) {
	e := newEngine(env)
	var targets []operator.TrackedItem
	var paused []string
	if err := e.mutate(func(st *operator.State) error {
		for i := range st.Tracked {
			it := &st.Tracked[i]
			if isPRItem(*it) {
				if !operator.ItemDone(*it) {
					it.Scope[scopeHalted] = true
				}
				if scopeBool(*it, scopeArmed) {
					targets = append(targets, *it)
				}
			}
			if isQueueItem(st, *it) && operator.ScopeString(it.Scope, "pane") == "" && !operator.ItemDone(*it) && !it.Paused {
				it.Paused = true
				it.UpdatedAt = operator.NowRFC3339()
				paused = append(paused, it.ID)
			}
		}
		if len(paused) == 0 && len(targets) == 0 {
			for _, it := range st.Tracked {
				if isPRItem(it) && !operator.ItemDone(it) {
					return nil
				}
			}
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
	var err error
	for _, it := range targets {
		err = errors.Join(err, e.disarm(ctx, it))
	}
	return e.res, err
}

// StatusItem is one queue item in the status view.
type StatusItem struct {
	ID        string   `json:"id"`
	State     string   `json:"state"`
	Mode      string   `json:"mode"`
	Repo      string   `json:"repo"`
	Branch    string   `json:"branch"`
	PR        string   `json:"pr"`
	DependsOn []string `json:"depends_on"`
	// Sequence is the item's merge-sequence position ("2/3"), "" before one
	// exists.
	Sequence string `json:"sequence"`
	// Queue is the id stamped by `autopilot queue` ("" for a legacy item).
	Queue    string `json:"queue"`
	Recovery string `json:"recovery"`
	Halted   bool   `json:"halted"`
}

// StatusResult is the read-only queue view. Summary is the Queue Completion
// Summary, present when every queue item is done.
type StatusResult struct {
	Escalations []Escalation `json:"escalations,omitempty"`
	Items       []StatusItem `json:"items"`
	Complete    bool         `json:"complete"`
	Summary     string       `json:"summary"`
	// Structured human-rendering inputs share the full JSON summary source.
	SummaryItems []string `json:"-"`
	MergeOrder   []string `json:"-"`
}

// Status derives the queue view from stored state alone; only the completion
// summary reads PR links through gh.
func Status(ctx context.Context, env Env) (StatusResult, error) {
	// Status reports failures without writing notes to the ledger.
	env.DryRun = true
	e := newEngine(env)
	st, err := e.load()
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
		state := derivedState(st, it)
		if state != StateDone {
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
			row.Recovery = operator.ScopeString(p.Scope, scopeRecovery)
			row.Halted = scopeBool(p, scopeHalted)
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
	res.Escalations = e.res.Escalations
	var lookupErr error
	for _, escalation := range res.Escalations {
		lookupErr = errors.Join(lookupErr, fmt.Errorf("%s: %s", escalation.Item, escalation.Reason))
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
			if v, err := e.viewPR(ctx, repo, br, "url"); err != nil {
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
