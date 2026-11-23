package autopilot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

// Engine-file field names. Ledger projections never carry these keys.
const (
	scopeTask      = "task"
	scopePlain     = "plain"
	scopeBase      = "base"
	scopeBare      = "bare"
	scopeRespawned = "respawned"
	scopeSkipped   = "skipped"
	scopeSpawning  = "spawning"
	scopeQueue     = "queue"
	scopeEscalated = "escalated"
	scopeMergeMode = "merge_mode"
	scopeProjected = "projected"
	// scopeEngineDone distinguishes the engine file's own done_at from an
	// overlaid projection timestamp in the decision snapshot.
	scopeEngineDone = "engine_done_at"
)

var itemIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// Entry is one queue entry as it arrives on stdin. Exactly one of Change (an
// existing fab change) and Task (raw text) names the work; neither is a bare
// agent, which nothing may depend on. Plain makes a Task run as a plain agent
// even in a fab repo; Base is the branch the worktree starts from and the PR
// targets (the default branch when empty).
type Entry struct {
	ID        string    `json:"id"`
	Repo      string    `json:"repo"`
	Change    string    `json:"change,omitempty"`
	Task      string    `json:"task,omitempty"`
	Plain     bool      `json:"plain,omitempty"`
	Base      string    `json:"base,omitempty"`
	DependsOn *[]string `json:"depends_on,omitempty"`
	StopStage *string   `json:"stop_stage,omitempty"`
	// Paused queues the entry held: the spawn gate skips it until
	// `autopilot resume` — a plan step behind a user gate.
	Paused bool `json:"paused,omitempty"`
}

// ParseEntries decodes the stdin document: a JSON array of entries, strictly.
func ParseEntries(data []byte) ([]Entry, error) {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	var entries []Entry
	if err := dec.Decode(&entries); err != nil {
		return nil, operatorInvalid("invalid queue entries (want a JSON array of {id, repo, change|task, plain?, base?, depends_on?, stop_stage?, paused?}): %v", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, operatorInvalid("invalid queue entries: unexpected input after the JSON array")
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
	Mode    string
	ModeSet bool
}

// QueueReceipt reports what Enqueue stored.
type QueueReceipt struct {
	Mode        string       `json:"mode"`
	Source      string       `json:"source"`
	Items       []string     `json:"items"`
	Misfits     []string     `json:"misfits"`
	Actions     []Action     `json:"actions"`
	Escalations []Escalation `json:"escalations"`
	DryRun      bool         `json:"dry_run,omitempty"`
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
	if m := operator.ScopeString(it.Scope, scopeMergeMode); m != "" {
		return m
	}
	return operator.MergeModeCherryPickLadder
}

func scopeBool(it operator.TrackedItem, key string) bool {
	b, _ := it.Scope[key].(bool)
	return b
}

func isBare(it operator.TrackedItem) bool {
	b, _ := it.Scope[scopeBare].(bool)
	return b
}

// ErrQueueBusy reports that no queue was written because another pass holds the lock.
var ErrQueueBusy = errors.New("busy: another autopilot pass is running on this server; queue not written, retry")

// Enqueue validates and writes the engine file under the pass lock, then runs
// one pass. Dry runs resolve and validate only; they take no lock and write nothing.
func Enqueue(ctx context.Context, env Env, entries []Entry, opts QueueOptions, settingValue string) (QueueReceipt, error) {
	return enqueue(ctx, env, entries, opts, settingValue, true)
}

func enqueue(ctx context.Context, env Env, entries []Entry, opts QueueOptions, settingValue string, runPass bool) (QueueReceipt, error) {
	rec := QueueReceipt{Items: []string{}, Misfits: []string{}, Actions: []Action{}, Escalations: []Escalation{}, DryRun: env.DryRun}
	result, err := passLocked(env, func() (*StepResult, error) {
		e := newEngine(env)
		if opts.ModeSet && opts.Mode == "" {
			return nil, operatorInvalid("--mode must not be empty")
		}
		mode, source, err := ResolveMode(opts.Mode, settingValue)
		if err != nil {
			return nil, err
		}
		rec.Mode, rec.Source = mode, source
		st, err := e.load()
		if err != nil {
			return nil, err
		}
		items, misfits, err := e.buildQueue(ctx, st, entries, mode)
		if err != nil {
			return nil, err
		}
		if len(misfits) > 0 {
			rec.Misfits = misfits
		}
		for _, it := range items {
			rec.Items = append(rec.Items, it.ID)
		}
		if env.DryRun {
			return newResult(true), nil
		}
		if err := e.mutateEngine(func(fresh *engineState) error {
			view, _, err := engineView(env.StatePath)
			if err != nil {
				return err
			}
			for _, it := range items {
				if fresh.has(it.ID) || operator.IndexOf(view.Tracked, it.ID) >= 0 {
					return operatorInvalid("tracked item %s already exists", it.ID)
				}
			}
			for _, it := range items {
				if err := operator.ValidateDeps(it, append(append([]operator.TrackedItem(nil), view.Tracked...), items...)); err != nil {
					return err
				}
				fresh.upsert(engineItemFromTracked(it, false))
			}
			return nil
		}); err != nil {
			return nil, err
		}
		if !runPass {
			return newResult(false), nil
		}
		stepResult, passErr := e.pass(ctx)
		rec.Actions, rec.Escalations = stepResult.Actions, stepResult.Escalations
		if passErr != nil {
			rec.Escalations = append(rec.Escalations, Escalation{Reason: "pass failed: " + passErr.Error()})
		}
		return stepResult, nil
	})
	if err != nil {
		return rec, err
	}
	if result.Busy {
		return rec, ErrQueueBusy
	}
	return rec, nil
}

// buildQueue validates the entries against the loaded state and returns the
// items with implicit chaining applied.
func (e *engine) buildQueue(ctx context.Context, st *operator.State, entries []Entry, mode string) ([]operator.TrackedItem, []string, error) {
	byID := map[string]Entry{}
	pos := map[string]int{}
	for i, en := range entries {
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
		if err := e.validatePlainBase(ctx, en); err != nil {
			return nil, nil, err
		}
		byID[en.ID] = en
		pos[en.ID] = i
	}

	queueID := e.queueID(entries[0].ID)
	var misfits []string
	items := make([]operator.TrackedItem, 0, len(entries))
	for i, en := range entries {
		en.Repo = cleanRepo(en.Repo)
		deps, _ := e.depsFor(entries, i, mode)
		if en.DependsOn != nil {
			deps = append([]string{}, *en.DependsOn...)
		}
		for _, d := range deps {
			if err := checkDep(st, byID, en, d); err != nil {
				return nil, nil, err
			}
			if j, inQueue := pos[d]; inQueue && j >= i {
				return nil, nil, operatorInvalid("entry %s depends on %s, which is not an earlier entry in the queue: a dependency must come before its dependent", en.ID, d)
			}
			if en.Base != "" && mode == operator.MergeModeStackedPRs && sameRepoDep(st, byID, en, d) {
				return nil, nil, operatorInvalid("entry %s: base %s conflicts with its stacked-prs dependency %s: a stacked entry bases on its dependency's branch", en.ID, en.Base, d)
			}
		}
		scope := map[string]interface{}{
			"repo": en.Repo, scopeMergeMode: mode, scopeBare: en.Change == "" && en.Task == "", scopeQueue: queueID,
		}
		if en.Change != "" {
			scope["change"] = en.Change
		}
		if en.Task != "" {
			scope[scopeTask] = en.Task
		}
		if en.Plain && en.Task != "" {
			scope[scopePlain] = true
		}
		if en.Base != "" {
			scope[scopeBase] = en.Base
		}
		if en.StopStage != nil && *en.StopStage != "" {
			scope["stop_stage"] = *en.StopStage
		}
		it, err := operator.NewPaneItem(en.ID, deps, scope)
		if err != nil {
			return nil, nil, err
		}
		it.Paused = en.Paused
		items = append(items, it)
	}
	return items, misfits, nil
}

// validatePlainBase checks an entry's plain and base fields. A plain entry has
// no change and no pipeline stages to stop at; a base must be a valid branch
// name that exists on the repo's origin, probed authoritatively with ls-remote
// rather than a possibly stale remote-tracking ref.
func (e *engine) validatePlainBase(ctx context.Context, en Entry) error {
	if en.Plain {
		if en.Change != "" {
			return operatorInvalid("entry %s: plain cannot be combined with a change", en.ID)
		}
		if en.StopStage != nil && *en.StopStage != "" {
			return operatorInvalid("entry %s: plain cannot be combined with a stop_stage (a plain agent has no pipeline stages)", en.ID)
		}
	}
	if en.Base == "" {
		return nil
	}
	if safeBranch(en.Base) == "" {
		return operatorInvalid("entry %s: invalid base %q", en.ID, en.Base)
	}
	if _, err := e.git(ctx, en.Repo, "ls-remote", "--exit-code", "--heads", "origin", "refs/heads/"+en.Base); err != nil {
		if exitCode(err, 2) {
			return operatorInvalid("entry %s: base %s is not a branch on origin", en.ID, en.Base)
		}
		return operatorInvalid("entry %s: cannot verify base %s on origin: %s", en.ID, en.Base, stderrOf(err))
	}
	return nil
}

// queueID names one `queue` call: the first entry's id plus the call time, so
// the items of a queue can be told apart from user-tracked panes and from other
// queues.
func (e *engine) queueID(first string) string {
	return fmt.Sprintf("%s-%x", first, e.env.now().Unix())
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
