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

// engineItem is one queue or merge-sequence PR's durable intent. Fields used
// only by the other item kind stay empty.
type engineItem struct {
	ID        string                 `yaml:"id" json:"id"`
	Queue     string                 `yaml:"queue,omitempty" json:"queue,omitempty"`
	Item      string                 `yaml:"item,omitempty" json:"item,omitempty"`
	Repo      string                 `yaml:"repo,omitempty" json:"repo,omitempty"`
	NWO       string                 `yaml:"nwo,omitempty" json:"nwo,omitempty"`
	PR        interface{}            `yaml:"pr,omitempty" json:"pr,omitempty"`
	URL       string                 `yaml:"url,omitempty" json:"url,omitempty"`
	Change    string                 `yaml:"change,omitempty" json:"change,omitempty"`
	Task      string                 `yaml:"task,omitempty" json:"task,omitempty"`
	Bare      bool                   `yaml:"bare,omitempty" json:"bare,omitempty"`
	Branch    string                 `yaml:"branch,omitempty" json:"branch,omitempty"`
	Worktree  string                 `yaml:"worktree,omitempty" json:"worktree,omitempty"`
	MergeSeq  string                 `yaml:"merge_seq,omitempty" json:"merge_seq,omitempty"`
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
	Deferred  bool                   `yaml:"deferred,omitempty" json:"deferred,omitempty"`
	Halted    bool                   `yaml:"halted,omitempty" json:"halted,omitempty"`
	PRDropped bool                   `yaml:"pr_dropped,omitempty" json:"pr_dropped,omitempty"`
	DoneAt    *string                `yaml:"done_at" json:"done_at"`
	Escalated map[string]interface{} `yaml:"escalated" json:"escalated"`
	AddedAt   string                 `yaml:"added_at,omitempty" json:"added_at,omitempty"`
	UpdatedAt string                 `yaml:"updated_at,omitempty" json:"updated_at,omitempty"`
	SpawnedBy string                 `yaml:"spawned_by,omitempty" json:"spawned_by,omitempty"`
}

// engineState is the complete single-writer engine file. Queue and PR order
// are execution order and survive reads and writes unchanged.
type engineState struct {
	Version  int          `yaml:"version" json:"version"`
	Migrated bool         `yaml:"migrated,omitempty" json:"migrated,omitempty"`
	Queue    []engineItem `yaml:"queue" json:"queue"`
	PRs      []engineItem `yaml:"prs" json:"prs"`
}

func newEngineState() *engineState {
	return &engineState{Version: 1, Queue: []engineItem{}, PRs: []engineItem{}}
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
	if st.PRs == nil {
		st.PRs = []engineItem{}
	}
	for i := range st.Queue {
		normalizeEngineItem(&st.Queue[i])
	}
	for i := range st.PRs {
		normalizeEngineItem(&st.PRs[i])
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
	for i := range s.PRs {
		if s.PRs[i].ID == id {
			return &s.PRs[i], true
		}
	}
	return nil, false
}

func (s *engineState) has(id string) bool {
	_, ok := s.find(id)
	return ok
}

func (s *engineState) upsert(it engineItem, pr bool) bool {
	items := &s.Queue
	if pr {
		items = &s.PRs
	}
	for i := range *items {
		if (*items)[i].ID == it.ID {
			return false
		}
	}
	normalizeEngineItem(&it)
	*items = append(*items, it)
	return true
}

func (s *engineState) remove(id string) bool {
	for i := range s.Queue {
		if s.Queue[i].ID == id {
			s.Queue = append(s.Queue[:i], s.Queue[i+1:]...)
			return true
		}
	}
	for i := range s.PRs {
		if s.PRs[i].ID == id {
			s.PRs = append(s.PRs[:i], s.PRs[i+1:]...)
			return true
		}
	}
	return false
}

func engineItemFromTracked(it operator.TrackedItem, projected bool) engineItem {
	out := engineItem{
		ID: it.ID, Queue: operator.ScopeString(it.Scope, scopeQueue), Item: operator.ScopeString(it.Scope, scopeItem),
		Repo: operator.ScopeString(it.Scope, "repo"), NWO: pinnedRepo(it), PR: it.Scope["pr"], URL: operator.ScopeString(it.Scope, scopeURL),
		Change: operator.ScopeString(it.Scope, "change"), Task: operator.ScopeString(it.Scope, scopeTask), Bare: isBare(it),
		Branch: operator.ScopeString(it.Scope, "branch"), MergeSeq: seqOf(it), MergeMode: modeOf(it), StopStage: operator.ScopeString(it.Scope, "stop_stage"),
		DependsOn: append([]string{}, it.DependsOn...), Paused: it.Paused, Spawning: operator.ScopeString(it.Scope, scopeSpawning),
		Respawned: scopeBool(it, scopeRespawned), Skipped: skipped(it), Pane: operator.ScopeString(it.Scope, "pane"),
		Session: operator.ScopeString(it.Scope, "session"), Projected: projected, Deferred: scopeBool(it, scopeDeferred), Halted: scopeBool(it, scopeHalted), PRDropped: scopeBool(it, scopePRDropped),
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
		scopeQueue: it.Queue, scopeMergeMode: it.MergeMode, scopeBare: it.Bare,
		scopeSpawning: it.Spawning, scopeRespawned: it.Respawned, scopeSkipped: it.Skipped,
		scopeEscalated: it.Escalated, "projected": it.Projected,
		scopePRDropped: it.PRDropped, scopeEngineDone: it.DoneAt,
	}
	if it.Task != "" {
		scope[scopeTask] = it.Task
	}
	if it.StopStage != "" {
		scope["stop_stage"] = it.StopStage
	}
	out := operator.TrackedItem{
		ID: it.ID, Kind: operator.KindPane, Probe: operator.ProbeSpec{Mode: "pane"},
		DependsOn: append([]string{}, it.DependsOn...), Scope: scope, Last: map[string]interface{}{},
		Paused: it.Paused, DoneAt: it.DoneAt, AddedAt: it.AddedAt, UpdatedAt: it.UpdatedAt,
	}
	if it.MergeSeq == "" && it.Item == "" {
		return out
	}
	out.Kind = operator.KindGitHubPR
	scope["pr"], scope[scopeMergeSeq], scope[scopeItem], scope[scopeURL] = it.PR, it.MergeSeq, it.Item, it.URL
	scope[scopeDeferred], scope[scopeHalted] = it.Deferred, it.Halted
	prItem, err := operator.NewGitHubPRItem(it.ID, out.DependsOn, scope, it.NWO)
	if err == nil {
		prItem.Paused, prItem.DoneAt, prItem.AddedAt, prItem.UpdatedAt = it.Paused, it.DoneAt, it.AddedAt, it.UpdatedAt
		return prItem
	}
	out.Probe = operator.ProbeSpec{Mode: "shell", Argv: []string{"gh", "pr", "view", prNum(scope), "--repo", it.NWO}}
	return out
}

func applyEngineItem(dst *engineItem, src operator.TrackedItem, projected bool) {
	updated := engineItemFromTracked(src, projected)
	updated.Worktree = dst.Worktree
	updated.Paused = dst.Paused
	*dst = updated
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
	appendEngine := func(items []engineItem) {
		for _, engine := range items {
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
			}
			st.Tracked = append(st.Tracked, it)
		}
	}
	appendEngine(es.Queue)
	appendEngine(es.PRs)
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
	for _, it := range st.PRs {
		out[it.ID] = true
	}
	return out, nil
}
