package autopilot

import (
	"fmt"

	"rk/internal/operator"
)

var engineScopeKeys = []string{
	scopeQueue, scopeMergeMode, scopeSpawning, scopeRespawned, scopeSkipped,
	scopeEscalated, scopeTask, scopeBare, scopeProjected, scopePRTracked, "worktree",
}

// legacyQueueItem is only the migration predicate. Runtime queue membership
// comes from the engine file, so ordinary pane dependencies regain their normal
// tracked-item meaning after migration.
func legacyQueueItem(_ *operator.State, it operator.TrackedItem) bool {
	return it.Kind == operator.KindPane && (it.Scope[scopeQueue] != nil || it.Scope[scopeMergeMode] != nil)
}

func migrateEngineState(statePath string) error {
	engine, err := loadEngineFile(statePath)
	if err != nil {
		return err
	}
	if engine.Migrated {
		return nil
	}
	ledger, err := operator.Load(statePath)
	if err != nil {
		return err
	}
	moving := map[string]bool{}
	changed := false
	for _, it := range ledger.Tracked {
		if !legacyQueueItem(ledger, it) {
			continue
		}
		moving[it.ID] = true
		if !engine.has(it.ID) {
			projected := operator.ScopeString(it.Scope, "pane") != "" || len(it.Notes) > 0
			engine.upsert(engineItemFromTracked(it, projected))
			changed = true
		}
	}
	if len(moving) == 0 {
		engine.Migrated = true
		return writeEngineFile(statePath, engine)
	}
	if changed {
		if err := writeEngineFile(statePath, engine); err != nil {
			return err
		}
	}
	if err := operator.Mutate(statePath, func(st *operator.State) error {
		kept := st.Tracked[:0]
		for _, item := range st.Tracked {
			if !moving[item.ID] {
				kept = append(kept, item)
				continue
			}
			if operator.ScopeString(item.Scope, "pane") == "" && len(item.Notes) == 0 {
				continue
			}
			item.DependsOn = []string{}
			item.Scope = projectionScope(item)
			kept = append(kept, item)
		}
		st.Tracked = kept
		return nil
	}); err != nil {
		return err
	}
	engine.Migrated = true
	return writeEngineFile(statePath, engine)
}

func projectionScope(it operator.TrackedItem) map[string]interface{} {
	allowed := map[string]bool{
		"pane": true, "pane_pid": true, "session": true, "repo": true, "change": true,
		"branch": it.Kind == operator.KindPane, "stop_stage": true, "spawned_by": true,
		"stage": true, "agent": true, "memo": true, "pr": it.Kind == operator.KindGitHubPR,
	}
	out := map[string]interface{}{}
	for k, v := range it.Scope {
		if allowed[k] {
			out[k] = v
		}
	}
	return out
}

func removeProjection(statePath, id string) error {
	return operator.Mutate(statePath, func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, id)
		if i < 0 {
			return operator.ErrNoWrite
		}
		st.Tracked = append(st.Tracked[:i], st.Tracked[i+1:]...)
		return nil
	})
}

func (e *engine) mutateEngine(fn func(*engineState) error) error {
	if e.env.DryRun {
		return nil
	}
	st, err := loadEngineFile(e.env.StatePath)
	if err != nil {
		return err
	}
	if err := fn(st); err != nil {
		if err == operator.ErrNoWrite {
			return nil
		}
		return err
	}
	return writeEngineFile(e.env.StatePath, st)
}

func (e *engine) load(ids ...string) (*operator.State, error) {
	st, _, err := engineView(e.env.StatePath)
	if err != nil {
		id := ""
		if len(ids) > 0 {
			id = ids[0]
		}
		e.escalate(id, "state load failed: "+err.Error())
	}
	return st, err
}

func (e *engine) projection(id string) (operator.TrackedItem, bool, error) {
	st, err := operator.Load(e.env.StatePath)
	if err != nil {
		return operator.TrackedItem{}, false, err
	}
	i := operator.IndexOf(st.Tracked, id)
	if i < 0 {
		return operator.TrackedItem{}, false, nil
	}
	return st.Tracked[i], true, nil
}

func (e *engine) upsertProjection(it operator.TrackedItem) error {
	if e.env.DryRun {
		return nil
	}
	if err := operator.Mutate(e.env.StatePath, func(st *operator.State) error {
		i := operator.IndexOf(st.Tracked, it.ID)
		var out operator.TrackedItem
		if i >= 0 {
			out = st.Tracked[i]
		} else {
			var err error
			out, err = operator.NewPaneItem(it.ID, nil, projectionScope(it))
			if err != nil {
				return err
			}
		}
		out.Kind = it.Kind
		out.DependsOn = []string{}
		out.Scope = mergeProjectionScope(out.Scope, projectionScope(it))
		out.UpdatedAt = operator.NowRFC3339()
		if i >= 0 {
			st.Tracked[i] = out
		} else {
			st.Tracked = append(st.Tracked, out)
		}
		if branch, repo := operator.ScopeString(out.Scope, "branch"), operator.ScopeString(out.Scope, "repo"); it.Kind == operator.KindPane && branch != "" && repo != "" {
			key := operator.ScopeString(out.Scope, "change")
			if key == "" {
				key = out.ID
			}
			st.BranchMap[key] = operator.BranchMapEntry{Branch: branch, Repo: repo}
		}
		return nil
	}); err != nil {
		return fmt.Errorf("projection %s not written: %w", it.ID, err)
	}
	return e.mutateEngine(func(st *engineState) error {
		item, ok := st.find(it.ID)
		if !ok {
			return fmt.Errorf("engine item %s vanished before projection acknowledgement", it.ID)
		}
		if item.Projected {
			return operator.ErrNoWrite
		}
		item.Projected = true
		return nil
	})
}

func mergeProjectionScope(current, update map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for k, v := range current {
		out[k] = v
	}
	for k, v := range update {
		out[k] = v
	}
	for _, k := range engineScopeKeys {
		delete(out, k)
	}
	return out
}
