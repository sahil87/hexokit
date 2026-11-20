package autopilot

import (
	"context"
	"strings"

	"rk/internal/operator"
)

// Remove drops an unspawned queue item, removes its projection, and runs one
// pass. Any other id is a usage error.
func Remove(ctx context.Context, env Env, id string) (*StepResult, error) {
	return passLocked(env, func() (*StepResult, error) {
		e := newEngine(env)
		removed := false
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
				removed = true
				return nil
			}
			return operatorInvalid("unknown autopilot item %s", id)
		}); err != nil {
			return e.res, err
		}
		if removed {
			if err := removeProjection(env.StatePath, id); err != nil {
				return e.res, err
			}
			e.act(ActRemoved, id, "")
		}
		_, err := e.pass(ctx)
		return e.res, err
	})
}

// Resume clears one queue item's skipped or paused intent, including a
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
			return e.res, operatorInvalid("%s is not skipped or paused", id)
		}
		e.act(ActResumed, id, "")
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

// Pause holds an unspawned queue item: the spawn gate skips a paused item
// until Resume clears it — the user gate of a plan step. A spawned, spawning,
// done, or non-queue id is a usage error: a live pane is not held by a flag.
// An already-paused item is a no-op.
func Pause(ctx context.Context, env Env, id string) (*StepResult, error) {
	return passLocked(env, func() (*StepResult, error) {
		e := newEngine(env)
		changed := false
		if err := e.mutateEngine(func(st *engineState) error {
			var item *engineItem
			for i := range st.Queue {
				if st.Queue[i].ID == id {
					item = &st.Queue[i]
				}
			}
			if item == nil {
				return operatorInvalid("unknown queue item %s", id)
			}
			if item.Pane != "" || item.Spawning != "" || item.DoneAt != nil {
				return operatorInvalid("%s has spawned or is done; pause holds only unspawned queue entries", id)
			}
			if item.Paused {
				return operator.ErrNoWrite
			}
			item.Paused = true
			changed = true
			return nil
		}); err != nil {
			return e.res, err
		}
		if changed {
			e.act(ActPaused, id, "")
		}
		return e.res, nil
	})
}
