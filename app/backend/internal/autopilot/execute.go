package autopilot

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"rk/internal/operator"
)

// execute is the last stage of a pass: it runs the chosen actions in ledger
// order, one executor per action kind. Each executor re-reads its item and
// skips it when it changed or vanished since observe (external writes win).
// No executor sees another's effect through a status: a successor acts on the
// next pass. A hard error does not stop later actions (a failed record must
// not skip a later disarm); the errors are joined.
func (e *engine) execute(ctx context.Context, f *facts, ds []Decision) error {
	e.facts = f
	var errs error
	var unreviewed []string
	for _, d := range ds {
		var err error
		switch d.Action {
		case ActionRecordDone:
			err = e.recordDone(d)
		case ActionSpawn:
			err = e.spawn(ctx, d)
		case ActionRespawn:
			err = e.respawnItem(ctx, d)
		case ActionSkip:
			err = e.skip(d)
		case ActionEscalate:
			err = e.escalateRow(d)
		case ActionReProject:
			err = e.reProject(d)
		case ActionTrackPR:
			err = e.trackPR(ctx, d)
		case ActionRecordMerged:
			err = e.recordMerged(ctx, d, &unreviewed)
		case ActionHalt:
			err = e.halt(ctx, d)
		case ActionDisarm:
			err = e.disarmRow(ctx, d)
		case ActionReady:
			err = e.ready(ctx, d)
		case ActionArm:
			err = e.arm(ctx, d)
		case ActionMerge:
			err = e.merge(ctx, d)
		}
		errs = errors.Join(errs, err)
	}
	if len(unreviewed) > 0 {
		e.res.Unreviewed = unreviewed
		e.reportf("merged without review: %s", strings.Join(unreviewed, ", "))
	}
	return errs
}

// renderDecisions turns each decision of a dry run into an action carrying the
// typed action name and the row id; waits are not listed.
func (e *engine) renderDecisions(ds []Decision) {
	for _, d := range ds {
		if d.Action == ActionWait {
			continue
		}
		detail := "(" + d.Row + ")"
		if d.Reason != "" {
			detail += " " + d.Reason
		}
		e.act(string(d.Action), d.Item, detail)
	}
}

// reread loads the decision's item fresh and reports whether it still carries
// the fingerprint observe saw. A changed or vanished item is escalated and
// skipped.
func (e *engine) reread(d Decision) (*operator.State, operator.TrackedItem, bool) {
	st, err := e.load(d.Item)
	if err != nil {
		return nil, operator.TrackedItem{}, false
	}
	i := operator.IndexOf(st.Tracked, d.Item)
	if i < 0 || fingerprint(st.Tracked[i]) != d.fp {
		e.escalate(d.Item, changedText(d.Item, d.pr))
		return nil, operator.TrackedItem{}, false
	}
	return st, st.Tracked[i], true
}

// guarded applies fn to the decision's item under the store's lock, after
// checking the item still carries the fingerprint observe saw: the write and
// the re-read are one step.
func (e *engine) guarded(id, fp string, fn func(*operator.TrackedItem)) error {
	return e.mutateEngine(func(st *engineState) error {
		view, _, err := engineView(e.env.StatePath)
		if err != nil {
			return err
		}
		i := operator.IndexOf(view.Tracked, id)
		if i < 0 {
			return fmt.Errorf("item %s is no longer tracked", id)
		}
		it := view.Tracked[i]
		if fp != "" && fingerprint(it) != fp {
			return errItemChanged
		}
		if it.Scope == nil {
			it.Scope = map[string]interface{}{}
		}
		fn(&it)
		it.UpdatedAt = operator.NowRFC3339()
		item, ok := st.find(id)
		if !ok {
			return fmt.Errorf("item %s is no longer in the engine state", id)
		}
		applyEngineItem(item, it, item.Projected)
		return nil
	})
}

// changedText is the escalation for an item that changed or vanished since
// observe: PR items name themselves as such.
func changedText(id string, pr bool) string {
	if pr {
		return fmt.Sprintf("PR item %s changed externally; skipped", id)
	}
	return fmt.Sprintf("item %s changed externally; skipped", id)
}

// writeFailed reports a failed item write: a changed item is skipped, anything
// else carries the write's own message.
func (e *engine) writeFailed(id string, pr bool, what string, err error) {
	if errors.Is(err, errItemChanged) {
		e.escalate(id, changedText(id, pr))
		return
	}
	e.escalate(id, what+": "+err.Error())
}

func (e *engine) recordDone(d Decision) error {
	now := e.env.now().UTC().Format(time.RFC3339)
	if err := e.guarded(d.Item, d.fp, func(t *operator.TrackedItem) { t.DoneAt = &now }); err != nil {
		e.writeFailed(d.Item, d.pr, "completion marker not written", err)
		if errors.Is(err, errItemChanged) {
			return nil
		}
		return err
	}
	e.act(ActDone, d.Item, "completion observed")
	return nil
}

// escalateRow reports an escalate-once row. The dedupe record is written under
// the item's fingerprint, so a note and key never land on an item that changed
// since observe.
func (e *engine) escalateRow(d Decision) error {
	err := e.recordEscalation(d.Item, d.Key, d.Reason, d.fp)
	switch {
	case errors.Is(err, errItemChanged):
		e.res.Escalations = append(e.res.Escalations, Escalation{Item: d.Item, Reason: changedText(d.Item, d.pr)})
	case err != nil:
		e.res.Escalations = append(e.res.Escalations, Escalation{Item: d.Item, Reason: d.Reason},
			Escalation{Item: d.Item, Reason: "escalation note not written: " + err.Error()})
	default:
		e.res.Escalations = append(e.res.Escalations, Escalation{Item: d.Item, Reason: d.Reason})
	}
	return nil
}

func (e *engine) reProject(d Decision) error {
	_, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	if err := e.upsertProjection(it); err != nil {
		e.escalate(it.ID, err.Error())
		return err
	}
	return nil
}

// skip spends the dead item: it is marked skipped before the escalation, so a
// failed write never reports a skip that did not happen.
func (e *engine) skip(d Decision) error {
	if err := e.guarded(d.Item, d.fp, func(t *operator.TrackedItem) { t.Scope[scopeSkipped] = true }); err != nil {
		e.writeFailed(d.Item, d.pr, "skipped marker not written", err)
		return nil
	}
	e.escalate(d.Item, "pane died after its one respawn: skipped, dependents stay held")
	return nil
}

// trackPR gives a shipped merge-auto queue item its one-PR sequence: it finds
// the PR by branch and writes the github-pr item, which a later pass arms.
func (e *engine) trackPR(ctx context.Context, d Decision) error {
	st, qi, ok := e.reread(d)
	if !ok {
		return nil
	}
	repo := cleanRepo(operator.ScopeString(qi.Scope, "repo"))
	branch := itemBranch(st, qi)
	if branch == "" {
		e.escalate(qi.ID, "cannot discover PR: no branch recorded")
		return nil
	}
	v, err := e.viewPR(ctx, repo, "", branch, prViewFields)
	if err != nil {
		e.escalate(qi.ID, "cannot discover PR for branch "+branch+": "+stderrOf(err))
		return nil
	}
	taken := map[string]bool{}
	for _, it := range st.Tracked {
		taken[it.ID] = true
	}
	it, err := e.newPRItem(ctx, qi, repo, branch, v, "auto-"+qi.ID, nil, operator.MergeModeMergeAuto, taken)
	if err != nil {
		e.escalate(qi.ID, err.Error())
		return nil
	}
	// The PR was found by reads that took time: the item is appended only if
	// its source queue item is still the one decided on, in the same write.
	err = e.addPRItems([]operator.TrackedItem{it}, func(st *operator.State) error {
		if i := operator.IndexOf(st.Tracked, qi.ID); i < 0 || fingerprint(st.Tracked[i]) != d.fp {
			return errItemChanged
		}
		return nil
	})
	if errors.Is(err, errItemChanged) {
		e.escalate(qi.ID, changedText(qi.ID, false))
		return nil
	}
	if err != nil {
		e.escalate("", "PR items not written: "+err.Error())
		return err
	}
	e.act(ActPRTracked, qi.ID, it.ID)
	return nil
}

// prLabel names a PR item in reports: its queue item, else its own id.
func prLabel(it operator.TrackedItem) string {
	if l := operator.ScopeString(it.Scope, scopeItem); l != "" {
		return l
	}
	return it.ID
}

// recordMerged records a verified merge and reports it, with its position in
// the repo's sequence and whether it merged without a submitted review.
func (e *engine) recordMerged(ctx context.Context, d Decision, unreviewed *[]string) error {
	st, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	now := e.env.now().UTC().Format(time.RFC3339)
	if err := e.guarded(d.Item, d.fp, func(t *operator.TrackedItem) { t.DoneAt = &now }); err != nil {
		e.writeFailed(d.Item, d.pr, "merged completion not written", err)
		return nil
	}
	repo := cleanRepo(operator.ScopeString(it.Scope, "repo"))
	label := prLabel(it)
	pos, total := 0, 0
	for _, s := range seqItems(st, seqOf(it)) {
		total++
		if s.ID == it.ID {
			pos = total
		}
	}
	line := fmt.Sprintf("%s: merged (%s %d/%d)", label, filepath.Base(repo), pos, total)
	reviews, err := prView{}, errNoPinnedRepo
	if nwo := pinnedRepo(it); nwo != "" {
		reviews, err = e.viewPR(ctx, repo, nwo, prNum(it.Scope), "reviews")
	}
	if err != nil {
		e.escalate(it.ID, "merged PR review lookup failed: "+stderrOf(err))
	} else if !hasReview(reviews.Reviews) {
		line += " · unreviewed"
		*unreviewed = append(*unreviewed, fmt.Sprintf("#%s (%s)", prNum(it.Scope), label))
	}
	e.reportf("%s", line)
	e.act(ActMerged, label, fmt.Sprintf("PR #%s", prNum(it.Scope)))
	return nil
}

func hasReview(rs []reviewSummary) bool {
	for _, r := range rs {
		if !strings.EqualFold(r.State, "PENDING") {
			return true
		}
	}
	return false
}

// halt writes `halted` on this one item, escalates, then disarms the item
// itself if it is armed. The rest of the cone is derived from that one write.
func (e *engine) halt(ctx context.Context, d Decision) error {
	_, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	reason := fmt.Sprintf("PR #%s was closed without merging", prNum(it.Scope))
	if err := e.guarded(d.Item, d.fp, func(t *operator.TrackedItem) { t.Scope[scopeHalted] = true }); err != nil {
		if errors.Is(err, errItemChanged) {
			e.writeFailed(d.Item, d.pr, "", err)
		} else {
			e.escalate(d.Item, "halt marker not written: "+err.Error()+"; "+reason)
		}
		return nil
	}
	e.escalate(d.Item, "halted: "+reason)
	if e.facts.pr[d.Item].armed() {
		return e.disarm(ctx, it)
	}
	return nil
}

func (e *engine) disarmRow(ctx context.Context, d Decision) error {
	if _, it, ok := e.reread(d); ok {
		return e.disarm(ctx, it)
	}
	return nil
}

// target is the pinned PR a gh mutation acts on, from a re-read item.
type target struct{ repo, nwo, n string }

func (e *engine) target(it operator.TrackedItem) (target, bool) {
	nwo, ok := e.pin(it)
	if !ok {
		return target{}, false
	}
	n := prNum(it.Scope)
	if n == "" {
		e.escalate(it.ID, "scope.pr is not a PR number")
		return target{}, false
	}
	return target{repo: cleanRepo(operator.ScopeString(it.Scope, "repo")), nwo: nwo, n: n}, true
}

// disarm turns auto-merge off on one PR. A PR that already merged or closed
// cannot auto-merge any more, so that counts as disarmed. Any other failure is
// escalated and kept in disarmErr (stop reports it); the PR is still derived
// armed, so the next pass retries.
func (e *engine) disarm(ctx context.Context, it operator.TrackedItem) error {
	t, ok := e.target(it)
	if !ok {
		return nil
	}
	if _, err := e.gh(ctx, t.repo, withRepo(t.nwo, "pr", "merge", "--disable-auto", t.n)...); !alreadyApplied(err, "disarm") && !e.prFinished(ctx, t) {
		e.escalate(it.ID, fmt.Sprintf("disarming PR #%s failed — it may still merge: %s", t.n, stderrOf(err)))
		e.disarmErr = errors.Join(e.disarmErr, err)
		return nil
	}
	e.act(ActDisarmed, it.ID, "PR #"+t.n)
	return nil
}

// prFinished reports whether the PR is merged or closed.
func (e *engine) prFinished(ctx context.Context, t target) bool {
	v, err := e.viewPR(ctx, t.repo, t.nwo, t.n, "state")
	return err == nil && (strings.EqualFold(v.State, "MERGED") || strings.EqualFold(v.State, "CLOSED"))
}

// ready marks a draft PR ready: a draft can be neither merged nor armed. The
// next pass arms or merges it.
func (e *engine) ready(ctx context.Context, d Decision) error {
	_, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	t, ok := e.target(it)
	if !ok {
		return nil
	}
	if _, err := e.gh(ctx, t.repo, withRepo(t.nwo, "pr", "ready", t.n)...); !alreadyApplied(err, "ready") {
		e.escalate(it.ID, fmt.Sprintf("cannot ready draft PR #%s: %s", t.n, stderrOf(err)))
		return nil
	}
	e.act(ActReadied, it.ID, "PR #"+t.n)
	return nil
}

// arm enables auto-merge (squash). Nothing is stored: a failure of any kind is
// escalated and the next pass re-reads autoMergeRequest.
func (e *engine) arm(ctx context.Context, d Decision) error {
	_, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	t, ok := e.target(it)
	if !ok {
		return nil
	}
	if _, err := e.gh(ctx, t.repo, withRepo(t.nwo, "pr", "merge", "--auto", "--squash", t.n)...); !alreadyApplied(err, "arm") {
		e.escalate(it.ID, fmt.Sprintf("arming PR #%s failed: %s", t.n, stderrOf(err)))
		return nil
	}
	e.act(ActArmed, it.ID, "PR #"+t.n)
	return nil
}

// merge squash-merges a green, unarmed PR now, only if its head is still the
// commit whose checks were read. The next pass observes MERGED and records it.
func (e *engine) merge(ctx context.Context, d Decision) error {
	_, it, ok := e.reread(d)
	if !ok {
		return nil
	}
	t, ok := e.target(it)
	if !ok {
		return nil
	}
	pf := e.facts.pr[d.Item]
	if pf == nil || pf.view.HeadRefOid == "" {
		e.escalate(it.ID, fmt.Sprintf("merging PR #%s refused: its head commit was not observed", t.n))
		return nil
	}
	args := append(withRepo(t.nwo, "pr", "merge", "--squash", t.n), "--match-head-commit", pf.view.HeadRefOid)
	if _, err := e.gh(ctx, t.repo, args...); !alreadyApplied(err, "merge") {
		e.escalate(it.ID, fmt.Sprintf("merging PR #%s failed: %s", t.n, stderrOf(err)))
		return nil
	}
	e.act(ActMerged, prLabel(it), "PR #"+t.n+" squash-merged")
	return nil
}
