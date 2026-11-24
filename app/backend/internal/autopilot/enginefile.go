package autopilot

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"rk/internal/fsatomic"
	"rk/internal/operator"

	"gopkg.in/yaml.v3"
)

const engineFileSuffix = ".autopilot.yaml"

// engineItem is one queue item's durable intent.
type engineItem struct {
	ID        string                 `yaml:"id" json:"id"`
	Queue     string                 `yaml:"queue,omitempty" json:"queue,omitempty"`
	Repo      string                 `yaml:"repo,omitempty" json:"repo,omitempty"`
	Change    string                 `yaml:"change,omitempty" json:"change,omitempty"`
	Task      string                 `yaml:"task,omitempty" json:"task,omitempty"`
	Plain     bool                   `yaml:"plain,omitempty" json:"plain,omitempty"`
	Base      string                 `yaml:"base,omitempty" json:"base,omitempty"`
	Group     string                 `yaml:"group,omitempty" json:"group,omitempty"`
	Bare      bool                   `yaml:"bare,omitempty" json:"bare,omitempty"`
	Branch    string                 `yaml:"branch,omitempty" json:"branch,omitempty"`
	Worktree  string                 `yaml:"worktree,omitempty" json:"worktree,omitempty"`
	BaseSHA   string                 `yaml:"base_sha,omitempty" json:"base_sha,omitempty"`
	MergeMode string                 `yaml:"merge_mode,omitempty" json:"merge_mode,omitempty"`
	StopStage string                 `yaml:"stop_stage,omitempty" json:"stop_stage,omitempty"`
	DependsOn []string               `yaml:"depends_on" json:"depends_on"`
	Paused    bool                   `yaml:"paused,omitempty" json:"paused,omitempty"`
	Spawning  string                 `yaml:"spawning,omitempty" json:"spawning,omitempty"`
	Respawned bool                   `yaml:"respawned,omitempty" json:"respawned,omitempty"`
	Skipped   bool                   `yaml:"skipped,omitempty" json:"skipped,omitempty"`
	Pane      string                 `yaml:"pane,omitempty" json:"pane,omitempty"`
	Session   string                 `yaml:"session,omitempty" json:"session,omitempty"`
	Projected bool                   `yaml:"projected,omitempty" json:"projected,omitempty"`
	PRTracked string                 `yaml:"pr_tracked,omitempty" json:"pr_tracked,omitempty"`
	DoneAt    *string                `yaml:"done_at" json:"done_at"`
	Escalated map[string]interface{} `yaml:"escalated" json:"escalated"`
	AddedAt   string                 `yaml:"added_at,omitempty" json:"added_at,omitempty"`
	UpdatedAt string                 `yaml:"updated_at,omitempty" json:"updated_at,omitempty"`
	SpawnedBy string                 `yaml:"spawned_by,omitempty" json:"spawned_by,omitempty"`
}

// engineState is the complete single-writer engine file. Item order is
// execution order. A file written by an older binary may carry `prs` and
// `fixes` lists and the item keys of the PR work the engine no longer does;
// they load as unknown YAML keys and the next write drops them.
type engineState struct {
	Version  int          `yaml:"version" json:"version"`
	Migrated bool         `yaml:"migrated,omitempty" json:"migrated,omitempty"`
	Queue    []engineItem `yaml:"queue" json:"queue"`
}

func newEngineState() *engineState {
	return &engineState{Version: 1, Queue: []engineItem{}}
}

func engineFilePath(statePath string) string {
	return strings.TrimSuffix(statePath, filepath.Ext(statePath)) + engineFileSuffix
}

func loadEngineFile(statePath string) (*engineState, error) {
	path := engineFilePath(statePath)
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return newEngineState(), nil
		}
		return nil, fmt.Errorf("cannot read %s: %w", path, err)
	}
	st := newEngineState()
	if len(data) > 0 {
		if err := yaml.Unmarshal(data, st); err != nil {
			return nil, fmt.Errorf("cannot parse %s: %w", path, err)
		}
	}
	if st.Version == 0 {
		st.Version = 1
	}
	if st.Queue == nil {
		st.Queue = []engineItem{}
	}
	for i := range st.Queue {
		normalizeEngineItem(&st.Queue[i])
	}
	return st, nil
}

func normalizeEngineItem(it *engineItem) {
	if it.DependsOn == nil {
		it.DependsOn = []string{}
	}
	if it.Escalated == nil {
		it.Escalated = map[string]interface{}{}
	}
}

func writeEngineFile(statePath string, st *engineState) error {
	st.Version = 1
	if err := os.MkdirAll(filepath.Dir(engineFilePath(statePath)), 0o700); err != nil {
		return fmt.Errorf("cannot create engine state directory: %w", err)
	}
	data, err := yaml.Marshal(st)
	if err != nil {
		return fmt.Errorf("cannot marshal engine state: %w", err)
	}
	path := engineFilePath(statePath)
	if err := fsatomic.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("cannot write %s: %w", path, err)
	}
	return nil
}

func (s *engineState) find(id string) (*engineItem, bool) {
	for i := range s.Queue {
		if s.Queue[i].ID == id {
			return &s.Queue[i], true
		}
	}
	return nil, false
}

func (s *engineState) has(id string) bool {
	_, ok := s.find(id)
	return ok
}

func (s *engineState) upsert(it engineItem) bool {
	for i := range s.Queue {
		if s.Queue[i].ID == it.ID {
			return false
		}
	}
	normalizeEngineItem(&it)
	s.Queue = append(s.Queue, it)
	return true
}

func (s *engineState) remove(id string) bool {
	for i := range s.Queue {
		if s.Queue[i].ID == id {
			s.Queue = append(s.Queue[:i], s.Queue[i+1:]...)
			return true
		}
	}
	return false
}

func engineItemFromTracked(it operator.TrackedItem, projected bool) engineItem {
	out := engineItem{
		ID: it.ID, Queue: operator.ScopeString(it.Scope, scopeQueue),
		Repo:   operator.ScopeString(it.Scope, "repo"),
		Change: operator.ScopeString(it.Scope, "change"), Task: operator.ScopeString(it.Scope, scopeTask), Bare: isBare(it),
		Plain: scopeBool(it, scopePlain), Base: operator.ScopeString(it.Scope, scopeBase),
		Group:  operator.ScopeString(it.Scope, scopeGroup),
		Branch: operator.ScopeString(it.Scope, "branch"), MergeMode: operator.ScopeString(it.Scope, scopeMergeMode), StopStage: operator.ScopeString(it.Scope, "stop_stage"),
		DependsOn: append([]string{}, it.DependsOn...), Paused: it.Paused, Spawning: operator.ScopeString(it.Scope, scopeSpawning),
		Respawned: scopeBool(it, scopeRespawned), Skipped: skipped(it), Pane: operator.ScopeString(it.Scope, "pane"),
		Session: operator.ScopeString(it.Scope, "session"), Projected: projected, PRTracked: operator.ScopeString(it.Scope, scopePRTracked),
		DoneAt: it.DoneAt, AddedAt: it.AddedAt, UpdatedAt: it.UpdatedAt, SpawnedBy: operator.ScopeString(it.Scope, "spawned_by"),
		Escalated: map[string]interface{}{},
	}
	if seen, ok := it.Scope[scopeEscalated].(map[string]interface{}); ok {
		for k, v := range seen {
			out.Escalated[k] = v
		}
	}
	return out
}

func (it engineItem) tracked() operator.TrackedItem {
	scope := map[string]interface{}{
		"repo": it.Repo, "change": it.Change, "branch": it.Branch, "stop_stage": nil,
		"pane": it.Pane, "session": it.Session, "spawned_by": it.SpawnedBy,
		scopeBare: it.Bare, scopeSpawning: it.Spawning, scopeRespawned: it.Respawned, scopeSkipped: it.Skipped,
		scopeEscalated: it.Escalated, "projected": it.Projected,
		scopeEngineDone: it.DoneAt,
	}
	if it.Queue != "" {
		scope[scopeQueue] = it.Queue
	}
	if it.MergeMode != "" {
		scope[scopeMergeMode] = it.MergeMode
	}
	if it.Task != "" {
		scope[scopeTask] = it.Task
	}
	if it.Plain {
		scope[scopePlain] = true
	}
	if it.Base != "" {
		scope[scopeBase] = it.Base
	}
	if it.Group != "" {
		scope[scopeGroup] = it.Group
	}
	if it.PRTracked != "" {
		scope[scopePRTracked] = it.PRTracked
	}
	if it.StopStage != "" {
		scope["stop_stage"] = it.StopStage
	}
	return operator.TrackedItem{
		ID: it.ID, Kind: operator.KindPane, Probe: operator.ProbeSpec{Mode: "pane"},
		DependsOn: append([]string{}, it.DependsOn...), Scope: scope, Last: map[string]interface{}{},
		Paused: it.Paused, DoneAt: it.DoneAt, AddedAt: it.AddedAt, UpdatedAt: it.UpdatedAt,
	}
}

func applyEngineItem(dst *engineItem, src operator.TrackedItem, projected bool) {
	updated := engineItemFromTracked(src, projected)
	updated.Worktree = dst.Worktree
	updated.BaseSHA = dst.BaseSHA
	updated.Paused = dst.Paused
	*dst = updated
}

// overlayPaneFacts copies onto a queue item the facts the check derives from
// its pane and the engine never learns on its own: the change a raw-task spawn
// acquired from /fab-new, the pipeline stage, and the branch that change has
// checked out. The branch matters most: /fab-new renames the spawn-time branch
// to the change name, so the engine's own `branch` goes stale while the check
// records the real one under the change id in branch_map. Resolving it here
// means every reader of the view (respawn, cherry-pick sources, status, the
// projection write-back) sees the branch git has. The engine file is not
// written by the overlay itself, but the item's next guarded write copies the
// view's change and branch into it (engineItemFromTracked); the stored change
// then fixes the item's change for good, while branch keeps re-deriving from
// branch_map on every view. stage is never stored. Ending that side effect is
// the agent-event-log plan's step E4.
func overlayPaneFacts(it *operator.TrackedItem, p operator.TrackedItem, branchMap map[string]operator.BranchMapEntry) {
	change := operator.ScopeString(it.Scope, "change")
	if change == "" {
		change = operator.ScopeString(p.Scope, "change")
		if change != "" {
			it.Scope["change"] = change
		}
	}
	if stage := operator.ScopeString(p.Scope, "stage"); stage != "" {
		it.Scope["stage"] = stage
	}
	if change != "" {
		if be, ok := branchMap[change]; ok && be.Branch != "" {
			it.Scope["branch"] = be.Branch
		}
	}
}

// engineView exposes the engine file through the existing derive/rule model,
// while overlaying only projection-owned facts from the ledger.
func engineView(statePath string) (*operator.State, map[string]operator.TrackedItem, error) {
	ledger, err := operator.Load(statePath)
	es, esErr := loadEngineFile(statePath)
	if err != nil {
		return nil, nil, err
	}
	if esErr != nil {
		return nil, nil, esErr
	}
	projections := map[string]operator.TrackedItem{}
	ledgerByID := map[string]operator.TrackedItem{}
	for _, it := range ledger.Tracked {
		projections[it.ID] = it
		ledgerByID[it.ID] = it
	}
	st := &operator.State{BranchMap: ledger.BranchMap, LastCheckAt: ledger.LastCheckAt, Tracked: []operator.TrackedItem{}}
	for _, engine := range es.Queue {
		it := engine.tracked()
		if p, ok := projections[it.ID]; ok {
			it.Paused = it.Paused || p.Paused
			it.Unchanged = p.Unchanged
			it.Last = p.Last
			it.Notes = p.Notes
			it.UpdatedAt = p.UpdatedAt
			if it.AddedAt == "" {
				it.AddedAt = p.AddedAt
			}
			if it.DoneAt == nil {
				it.DoneAt = p.DoneAt
			}
			overlayPaneFacts(&it, p, st.BranchMap)
		}
		st.Tracked = append(st.Tracked, it)
	}
	for _, legacy := range ledger.Tracked {
		if es.has(legacy.ID) {
			continue
		}
		if es.Migrated {
			legacy.Scope = projectionScope(legacy)
		}
		st.Tracked = append(st.Tracked, legacy)
	}
	return st, projections, nil
}

// QueueEntries returns each queue item's entry by id, for the run brief.
func QueueEntries(statePath string) (map[string]operator.QueueEntry, error) {
	st, err := loadEngineFile(statePath)
	if err != nil {
		return nil, err
	}
	out := make(map[string]operator.QueueEntry, len(st.Queue))
	for _, it := range st.Queue {
		out[it.ID] = operator.QueueEntry{Task: it.Task, Change: it.Change, StopStage: it.StopStage, MergeMode: it.MergeMode, Plain: it.Plain, Base: it.Base}
	}
	return out, nil
}

// OwnedIDs reports ids whose decisions belong to the engine file.
func OwnedIDs(statePath string) (map[string]bool, error) {
	st, err := loadEngineFile(statePath)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, it := range st.Queue {
		out[it.ID] = true
	}
	return out, nil
}
