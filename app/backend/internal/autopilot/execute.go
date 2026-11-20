package autopilot

import (
	"context"
	"errors"
	"fmt"
	"time"

	"rk/internal/operator"
)

// execute is the last stage of a pass: it runs the chosen actions in ledger
// order, one executor per action kind. Each executor re-reads its item and
// skips it when it changed or vanished since observe (external writes win).
// No executor sees another's effect through a status: a successor acts on the
// next pass. A hard error does not stop later actions; the errors are joined.
func (e *engine) execute(ctx context.Context, ds []Decision) error {
	var errs error
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
		}
		errs = errors.Join(errs, err)
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
		e.escalate(d.Item, changedText(d.Item))
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
// observe.
func changedText(id string) string {
	return fmt.Sprintf("item %s changed externally; skipped", id)
}

// writeFailed reports a failed item write: a changed item is skipped, anything
// else carries the write's own message.
func (e *engine) writeFailed(id, what string, err error) {
	if errors.Is(err, errItemChanged) {
		e.escalate(id, changedText(id))
		return
	}
	e.escalate(id, what+": "+err.Error())
}

func (e *engine) recordDone(d Decision) error {
	now := e.env.now().UTC().Format(time.RFC3339)
	if err := e.guarded(d.Item, d.fp, func(t *operator.TrackedItem) { t.DoneAt = &now }); err != nil {
		e.writeFailed(d.Item, "completion marker not written", err)
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
		e.res.Escalations = append(e.res.Escalations, Escalation{Item: d.Item, Reason: changedText(d.Item)})
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
		e.writeFailed(d.Item, "skipped marker not written", err)
		return nil
	}
	e.escalate(d.Item, "pane died after its one respawn: skipped, dependents stay held")
	return nil
}
