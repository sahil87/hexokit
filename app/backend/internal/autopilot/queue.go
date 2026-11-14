package autopilot

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"rk/internal/operator"
	"rk/internal/settings"
)

// Mode sources reported with the resolved merge mode.
const (
	SourceFlag    = "flag"
	SourceSetting = "setting"
	SourceDefault = "default"
)

// Queue-only scope keys, beside the pinned pane scope keys.
const (
	scopeTask      = "task"
	scopeBare      = "bare"
	scopeRespawned = "respawned"
	scopeSkipped   = "skipped"
	scopeRecovery  = "recovery"
	scopeFixHead   = "fix_head"
	scopeRecoverAt = "recovery_at"
	scopeMergeSeq  = "merge_seq"
	scopeItem      = "item"
	scopeArmed     = "armed"
	scopeHalted    = "halted"
	scopeDirect    = "direct"
	scopePrepared  = "prepared"
	scopeFixItem   = "fix_item"
	scopeFixFor    = "fix_for"
)

var itemIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// Entry is one queue entry as it arrives on stdin. Exactly one of Change (an
// existing fab change) and Task (raw text) names the work; neither is a bare
// agent, which nothing may depend on.
type Entry struct {
	ID        string    `json:"id"`
	Repo      string    `json:"repo"`
	Change    string    `json:"change,omitempty"`
	Task      string    `json:"task,omitempty"`
	DependsOn *[]string `json:"depends_on,omitempty"`
	StopStage *string   `json:"stop_stage,omitempty"`
}

// ParseEntries decodes the stdin document: a JSON array of entries, strictly.
func ParseEntries(data []byte) ([]Entry, error) {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	var entries []Entry
	if err := dec.Decode(&entries); err != nil {
		return nil, operatorInvalid("invalid queue entries (want a JSON array of {id, repo, change|task, depends_on?, stop_stage?}): %v", err)
	}
	if len(entries) == 0 {
		return nil, operatorInvalid("queue is empty")
	}
	return entries, nil
}

// InvalidError marks a caller mistake; the CLI maps it to the usage class.
type InvalidError struct{ msg string }

func (e *InvalidError) Error() string { return e.msg }

func operatorInvalid(format string, a ...interface{}) error {
	return &InvalidError{msg: fmt.Sprintf(format, a...)}
}

// QueueOptions are the queue verb's inputs.
type QueueOptions struct {
	// Mode is the --mode flag ("" = not given).
	Mode string
}

// QueueReceipt reports what Enqueue stored.
type QueueReceipt struct {
	Mode    string   `json:"mode"`
	Source  string   `json:"source"`
	Items   []string `json:"items"`
	Misfits []string `json:"misfits"`
	DryRun  bool     `json:"dry_run,omitempty"`
}

// ResolveMode applies the ladder --mode flag > operator.merge_mode setting >
// cherry-pick-ladder. An invalid value from either source is an error naming
// the valid set: the destructive tier never falls back silently.
func ResolveMode(flag, setting string) (mode, source string, err error) {
	valid := strings.Join(operator.MergeModes, ", ")
	switch {
	case flag != "":
		if !operator.ValidMergeMode(flag) {
			return "", "", operatorInvalid("invalid --mode %q (valid: %s)", flag, valid)
		}
		return flag, SourceFlag, nil
	case setting != "" && setting != settings.DefaultOperatorMergeMode:
		if !operator.ValidMergeMode(setting) {
			return "", "", operatorInvalid("invalid operator.merge_mode setting %q (valid: %s)", setting, valid)
		}
		return setting, SourceSetting, nil
	}
	return operator.MergeModeCherryPickLadder, SourceDefault, nil
}

// modeOf reads an item's stored mode; null reads as cherry-pick-ladder for
// items created before queues stamped one.
func modeOf(it operator.TrackedItem) string {
	if m := operator.ScopeString(it.Scope, "merge_mode"); m != "" {
		return m
	}
	return operator.MergeModeCherryPickLadder
}

// isQueueItem reports whether the item belongs to a queue: a pane item with a
// repo. A recovery spawn's tracking item (fix_for) is not one: it is a
// change-less agent the recovery round owns, not queue work to spawn or respawn.
func isQueueItem(it operator.TrackedItem) bool {
	return it.Kind == operator.KindPane && operator.ScopeString(it.Scope, "repo") != "" &&
		operator.ScopeString(it.Scope, scopeFixFor) == ""
}

func isBare(it operator.TrackedItem) bool {
	b, _ := it.Scope[scopeBare].(bool)
	return b
}

// Enqueue persists the entries as pending pane items in one locked write. All
// validation happens before the write, so a rejected queue leaves the file
// untouched.
func Enqueue(ctx context.Context, env Env, entries []Entry, opts QueueOptions, settingValue string) (QueueReceipt, error) {
	e := newEngine(env)
	mode, source, err := ResolveMode(opts.Mode, settingValue)
	if err != nil {
		return QueueReceipt{}, err
	}
	rec := QueueReceipt{Mode: mode, Source: source, Items: []string{}, Misfits: []string{}, DryRun: env.DryRun}

	st, err := e.load()
	if err != nil {
		return rec, err
	}
	items, misfits, err := e.buildQueue(ctx, st, entries, mode)
	if err != nil {
		return rec, err
	}
	if len(misfits) > 0 {
		rec.Misfits = misfits
	}
	for _, it := range items {
		rec.Items = append(rec.Items, it.ID)
	}
	if env.DryRun {
		return rec, nil
	}
	err = operator.Mutate(env.StatePath, func(fresh *operator.State) error {
		for _, it := range items {
			if operator.IndexOf(fresh.Tracked, it.ID) >= 0 {
				return operatorInvalid("tracked item %s already exists", it.ID)
			}
		}
		for _, it := range items {
			if err := operator.ValidateDeps(it, append(append([]operator.TrackedItem(nil), fresh.Tracked...), items...)); err != nil {
				return err
			}
		}
		fresh.Tracked = append(fresh.Tracked, items...)
		return nil
	})
	return rec, err
}

// buildQueue validates the entries against the loaded state and returns the
// items with implicit chaining applied.
func (e *engine) buildQueue(ctx context.Context, st *operator.State, entries []Entry, mode string) ([]operator.TrackedItem, []string, error) {
	byID := map[string]Entry{}
	for _, en := range entries {
		if !itemIDRe.MatchString(en.ID) {
			return nil, nil, operatorInvalid("invalid id %q (letters, digits, '.', '_', '-'; at most 64)", en.ID)
		}
		if _, dup := byID[en.ID]; dup {
			return nil, nil, operatorInvalid("duplicate id %q in the queue", en.ID)
		}
		if operator.IndexOf(st.Tracked, en.ID) >= 0 {
			return nil, nil, operatorInvalid("tracked item %s already exists", en.ID)
		}
		if en.Change != "" && !changeIDRe.MatchString(en.Change) {
			return nil, nil, operatorInvalid("entry %s: invalid change %q", en.ID, en.Change)
		}
		if en.Change != "" && en.Task != "" {
			return nil, nil, operatorInvalid("entry %s names both a change and a task", en.ID)
		}
		en.Repo = cleanRepo(en.Repo)
		if err := e.validateRepo(ctx, en.Repo); err != nil {
			return nil, nil, operatorInvalid("entry %s: %v", en.ID, err)
		}
		if en.StopStage != nil && *en.StopStage != "" && !validStage(*en.StopStage) {
			return nil, nil, operatorInvalid("entry %s: invalid stop_stage %q", en.ID, *en.StopStage)
		}
		byID[en.ID] = en
	}

	var misfits []string
	items := make([]operator.TrackedItem, 0, len(entries))
	for i, en := range entries {
		en.Repo = cleanRepo(en.Repo)
		deps, explicit := e.depsFor(entries, i, mode)
		if en.DependsOn != nil {
			deps, explicit = append([]string{}, *en.DependsOn...), true
		}
		for _, d := range deps {
			if err := checkDep(st, byID, en, d); err != nil {
				return nil, nil, err
			}
			if mode == operator.MergeModeMergeAuto && explicit && en.DependsOn != nil && sameRepoDep(st, byID, en, d) {
				misfits = append(misfits, fmt.Sprintf("misfit: merge-auto with same-repo depends_on (%s → %s): each entry is based on the default branch independently, so the dependency's code never reaches it; ask whether stacked-prs or cherry-pick-ladder is meant", en.ID, d))
			}
		}
		scope := map[string]interface{}{
			"repo": en.Repo, "merge_mode": mode, scopeBare: en.Change == "" && en.Task == "",
		}
		if en.Change != "" {
			scope["change"] = en.Change
		}
		if en.Task != "" {
			scope[scopeTask] = en.Task
		}
		if en.StopStage != nil && *en.StopStage != "" {
			scope["stop_stage"] = *en.StopStage
		}
		it, err := operator.NewPaneItem(en.ID, deps, scope)
		if err != nil {
			return nil, nil, err
		}
		items = append(items, it)
	}
	return items, misfits, nil
}

// depsFor is the implicit chaining for entry i: the nearest earlier entry in
// the same repo, else the immediately previous entry (a cross-repo,
// ordering-only barrier). merge-auto chains every entry to its predecessor as
// a barrier only.
func (e *engine) depsFor(entries []Entry, i int, mode string) ([]string, bool) {
	if i == 0 {
		return []string{}, false
	}
	if mode == operator.MergeModeMergeAuto {
		return []string{entries[i-1].ID}, false
	}
	repo := cleanRepo(entries[i].Repo)
	for j := i - 1; j >= 0; j-- {
		if cleanRepo(entries[j].Repo) == repo {
			return []string{entries[j].ID}, false
		}
	}
	return []string{entries[i-1].ID}, false
}

// checkDep rejects a dependency that is unknown or names a bare agent.
func checkDep(st *operator.State, byID map[string]Entry, en Entry, dep string) error {
	if dep == en.ID {
		return operatorInvalid("entry %s depends on itself", en.ID)
	}
	if d, ok := byID[dep]; ok {
		if d.Change == "" && d.Task == "" {
			return operatorInvalid("entry %s depends on %s, a bare agent with no task: nothing can depend on it", en.ID, dep)
		}
		return nil
	}
	i := operator.IndexOf(st.Tracked, dep)
	if i < 0 {
		return operatorInvalid("entry %s depends on %q, which is neither in this queue nor tracked", en.ID, dep)
	}
	if isBare(st.Tracked[i]) {
		return operatorInvalid("entry %s depends on %s, a bare agent with no task: nothing can depend on it", en.ID, dep)
	}
	return nil
}

func sameRepoDep(st *operator.State, byID map[string]Entry, en Entry, dep string) bool {
	repo := cleanRepo(en.Repo)
	if d, ok := byID[dep]; ok {
		return cleanRepo(d.Repo) == repo
	}
	if i := operator.IndexOf(st.Tracked, dep); i >= 0 {
		return cleanRepo(depRepo(st, st.Tracked[i])) == repo
	}
	return false
}

// depRepo is the repo of a dependency: its scope.repo, else its branch_map
// entry's.
func depRepo(st *operator.State, dep operator.TrackedItem) string {
	if r := operator.ScopeString(dep.Scope, "repo"); r != "" {
		return r
	}
	for _, key := range []string{operator.ScopeString(dep.Scope, "change"), dep.ID} {
		if be, ok := st.BranchMap[key]; ok && be.Repo != "" {
			return be.Repo
		}
	}
	return ""
}

func validStage(s string) bool {
	switch s {
	case "intake", "apply", "review", "hydrate", "ship", "review-pr":
		return true
	}
	return false
}
