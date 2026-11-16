package autopilot

import (
	"context"
	"strings"

	"rk/internal/operator"
)

// Remove drops an unspawned queue item or a halted merge sequence, removes its
// projections, and runs one pass.
func Remove(ctx context.Context, env Env, id string) (*StepResult, error) {
	return passLocked(env, func() (*StepResult, error) {
		e := newEngine(env)
		var removed []string
		if err := e.mutateEngine(func(st *engineState) error {
			for _, item := range st.Queue {
				if item.ID != id {
					continue
				}
				if item.Pane != "" || item.Spawning != "" {
					return operatorInvalid("%s has spawned or is spawning and cannot be removed", id)
				}
				var dependents []string
				for _, candidate := range st.Queue {
					if candidate.DoneAt == nil && containsID(candidate.DependsOn, id) {
						dependents = append(dependents, candidate.ID)
					}
				}
				if len(dependents) > 0 {
					return operatorInvalid("%s has unfinished dependents: %s", id, strings.Join(dependents, ", "))
				}
				st.remove(id)
				removed = []string{id}
				return nil
			}
			seq := ""
			for _, item := range st.PRs {
				if item.ID == id || item.MergeSeq == id {
					seq = item.MergeSeq
					break
				}
			}
			if seq == "" {
				return operatorInvalid("unknown autopilot item %s", id)
			}
			view, _, err := engineView(env.StatePath)
			if err != nil {
				return err
			}
			found := false
			for _, item := range seqItems(view, seq) {
				found = true
				if !operator.ItemDone(item) && !haltedCone(view, nil, item) {
					return operatorInvalid("merge sequence %s is not halted", seq)
				}
			}
			if !found {
				return operatorInvalid("unknown merge sequence %s", seq)
			}
			for _, item := range append([]engineItem(nil), st.PRs...) {
				if item.MergeSeq == seq {
					st.remove(item.ID)
					removed = append(removed, item.ID)
				}
			}
			return nil
		}); err != nil {
			return e.res, err
		}
		for _, itemID := range removed {
			if err := removeProjection(env.StatePath, itemID); err != nil {
				return e.res, err
			}
			e.act("removed", itemID, "")
		}
		_, err := e.pass(ctx)
		return e.res, err
	})
}

// Resume clears one item's stopped, skipped, or paused intent, including a
// projection pause, and runs one pass.
func Resume(ctx context.Context, env Env, id string) (*StepResult, error) {
	return passLocked(env, func() (*StepResult, error) {
		e := newEngine(env)
		projection, present, err := e.projection(id)
		if err != nil {
			return e.res, err
		}
		changed := present && projection.Paused
		if err := e.mutateEngine(func(st *engineState) error {
			item, ok := st.find(id)
			if !ok {
				return operatorInvalid("unknown autopilot item %s", id)
			}
			if item.Halted {
				item.Halted = false
				changed = true
			}
			if item.Skipped {
				item.Skipped = false
				changed = true
			}
			if item.Paused {
				item.Paused = false
				changed = true
			}
			if !changed {
				return operator.ErrNoWrite
			}
			return nil
		}); err != nil {
			return e.res, err
		}
		if present && projection.Paused {
			if err := operator.Resume(env.StatePath, id); err != nil {
				return e.res, err
			}
		}
		if !changed {
			return e.res, operatorInvalid("%s is not halted, skipped, or paused", id)
		}
		e.act("resumed", id, "")
		_, err = e.pass(ctx)
		return e.res, err
	})
}

func containsID(ids []string, id string) bool {
	for _, candidate := range ids {
		if candidate == id {
			return true
		}
	}
	return false
}
