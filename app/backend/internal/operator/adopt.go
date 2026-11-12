package operator

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// Adopt imports fab's operator state file into rk's. The source is opened
// read-only and never written, locked, renamed, or converted on disk — legacy
// shapes convert in memory. Nothing else calls Adopt: there is no automatic
// import on read.

// ErrNoSource is returned (wrapped with the path) when the fab state file does
// not exist; the caller reports it and exits cleanly.
var ErrNoSource = errors.New("no fab operator state")

// LegacyRunningRefusal is the refusal for a legacy file carrying a running
// autopilot queue: its current entry has in-flight side effects the
// conversion cannot reproduce.
const LegacyRunningRefusal = "operator state file has a running autopilot queue — finish or stop it before adopting"

const (
	kindLegacyFabChange = "fab-change"
	defaultMergeMode    = MergeModeCherryPickLadder
)

// AdoptInvalid names one source item that was skipped and why.
type AdoptInvalid struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// AdoptResult is the outcome of an Adopt run. Warnings are chatter for the
// caller (trimmed legacy prose) and not part of the JSON document.
type AdoptResult struct {
	Source   string         `json:"source"`
	Target   string         `json:"target"`
	Adopted  []string       `json:"adopted"`
	Skipped  []string       `json:"skipped"`
	Invalid  []AdoptInvalid `json:"invalid"`
	DryRun   bool           `json:"dry_run"`
	Warnings []string       `json:"-"`
}

// fabItem is a source item: the rk schema plus fab's text field (a note item's
// prose, which becomes its first note).
type fabItem struct {
	TrackedItem `yaml:",inline"`
	Text        string `yaml:"text,omitempty"`
}

// Adopt merges the items and branch_map of the fab state file at source into
// the rk state file at target, matching items by id and leaving ids already
// present untouched. dryRun computes the result and writes nothing (no
// directory, no lock).
func Adopt(source, target string, dryRun bool) (AdoptResult, error) {
	res := AdoptResult{
		Source: source, Target: target, DryRun: dryRun,
		Adopted: []string{}, Skipped: []string{}, Invalid: []AdoptInvalid{},
	}
	raw, err := os.ReadFile(source)
	if err != nil {
		if os.IsNotExist(err) {
			return res, fmt.Errorf("%w at %s", ErrNoSource, source)
		}
		return res, fmt.Errorf("cannot read %s: %w", source, err)
	}
	data := map[string]interface{}{}
	if len(raw) > 0 {
		if err := yaml.Unmarshal(raw, &data); err != nil {
			return res, fmt.Errorf("cannot parse %s: %w", source, err)
		}
	}

	src, bm, err := sourceItems(source, data, &res)
	if err != nil {
		return res, err
	}
	candidates := make([]TrackedItem, 0, len(src))
	seenIDs := map[string]bool{}
	for _, fi := range src {
		it, reason := convertItem(fi, &res)
		if reason == "" && seenIDs[it.ID] {
			reason = "duplicate id in source"
		}
		if reason != "" {
			res.Invalid = append(res.Invalid, AdoptInvalid{ID: fi.ID, Reason: reason})
			continue
		}
		seenIDs[it.ID] = true
		candidates = append(candidates, it)
	}

	merge := func(st *State) error {
		res.Adopted, res.Skipped = []string{}, []string{}
		changed := false
		for _, it := range candidates {
			if indexOf(st.Tracked, it.ID) >= 0 {
				res.Skipped = append(res.Skipped, it.ID)
				continue
			}
			st.Tracked = append(st.Tracked, it)
			res.Adopted = append(res.Adopted, it.ID)
			changed = true
		}
		for _, key := range sortedKeys(bm) {
			if _, present := st.BranchMap[key]; !present {
				st.BranchMap[key] = bm[key]
				changed = true
			}
		}
		if !changed {
			return errNoWrite
		}
		return nil
	}

	if dryRun {
		st, err := Load(target)
		if err != nil {
			return res, err
		}
		_ = merge(st)
		return res, nil
	}
	if err := Mutate(target, merge); err != nil {
		return res, err
	}
	return res, nil
}

// sourceItems decodes the source map into its item list and branch_map,
// converting legacy shapes in memory. A malformed item is reported invalid,
// not fatal: the live file may be hand-drifted.
func sourceItems(source string, data map[string]interface{}, res *AdoptResult) ([]fabItem, map[string]BranchMapEntry, error) {
	bm := map[string]BranchMapEntry{}
	if err := decodeSection(data, keyBranchMap, &bm); err != nil {
		return nil, nil, fmt.Errorf("%s: %w", source, err)
	}
	var items []fabItem
	if legacyShape(data) {
		var err error
		if items, err = convertLegacy(data, bm); err != nil {
			return nil, nil, err
		}
	} else if list, ok := data[keyTracked].([]interface{}); ok {
		for i, elem := range list {
			var fi fabItem
			b, err := yaml.Marshal(elem)
			if err == nil {
				err = yaml.Unmarshal(b, &fi)
			}
			if err != nil {
				id := fmt.Sprintf("#%d", i)
				if m, ok := elem.(map[string]interface{}); ok {
					if s, _ := m["id"].(string); s != "" {
						id = s
					}
				}
				res.Invalid = append(res.Invalid, AdoptInvalid{ID: id, Reason: "unreadable item: " + err.Error()})
				continue
			}
			items = append(items, fi)
		}
	}
	for i := range items {
		convertFabChange(&items[i])
	}
	return items, bm, nil
}

// convertFabChange rewrites a retired kind: fab-change item to kind: pane,
// seeding scope.change = the item's id (a fab-change item's id was the change
// id by construction — without it the item would never complete) and
// scope.pane_pid = null.
func convertFabChange(fi *fabItem) {
	if fi.Kind != kindLegacyFabChange {
		return
	}
	fi.Kind = KindPane
	if fi.Scope == nil {
		fi.Scope = map[string]interface{}{}
	}
	fi.Scope["change"] = fi.ID
	fi.Scope["pane_pid"] = nil
}

// convertItem turns a source item into an rk item: normalize, seed the first
// note from a note item's text, enforce the note caps (trimming with a
// warning rather than failing), and validate. A non-empty reason means the
// item is invalid.
func convertItem(fi fabItem, res *AdoptResult) (TrackedItem, string) {
	it := fi.TrackedItem
	if it.ID == "" {
		return it, "missing id"
	}
	normalizeItem(&it)
	if it.Kind == KindNote && strings.TrimSpace(fi.Text) != "" {
		at := it.UpdatedAt
		if at == "" {
			at = it.AddedAt
		}
		if at == "" {
			at = nowRFC3339()
		}
		it.Notes = append([]Note{{At: at, By: ByUser, Text: fi.Text}}, it.Notes...)
	}
	it.Notes = capNotes(it.ID, it.Notes, res)
	if it.Kind == KindNote && len(it.Notes) == 0 {
		return it, "note item has no text"
	}
	if err := validateItem(it); err != nil {
		return it, err.Error()
	}
	return it, ""
}

// capNotes applies the note caps to imported prose: each text trimmed to
// NoteTextCap runes, the newest NoteCap notes kept, empty notes dropped —
// each recorded as a warning.
func capNotes(id string, notes []Note, res *AdoptResult) []Note {
	out := make([]Note, 0, len(notes))
	for _, n := range notes {
		n.Text = strings.TrimSpace(n.Text)
		if n.Text == "" {
			continue
		}
		if utf8.RuneCountInString(n.Text) > NoteTextCap {
			n.Text = string([]rune(n.Text)[:NoteTextCap])
			res.Warnings = append(res.Warnings, fmt.Sprintf("%s: note text trimmed to %d characters", id, NoteTextCap))
		}
		switch n.By {
		case ByUser, ByRun, ByChat:
		default:
			n.By = ByUser
		}
		out = append(out, n)
	}
	if len(out) > NoteCap {
		res.Warnings = append(res.Warnings, fmt.Sprintf("%s: kept the newest %d of %d notes", id, NoteCap, len(out)))
		out = out[len(out)-NoteCap:]
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// --- legacy shapes (conversion only — nothing else carries the old schemas) --

type monitoredEntry struct {
	Pane           string   `yaml:"pane"`
	Repo           string   `yaml:"repo"`
	Session        string   `yaml:"session"`
	Stage          string   `yaml:"stage,omitempty"`
	Agent          string   `yaml:"agent,omitempty"`
	StopStage      *string  `yaml:"stop_stage"`
	SpawnedBy      *string  `yaml:"spawned_by"`
	DependsOn      []string `yaml:"depends_on"`
	Branch         string   `yaml:"branch"`
	EnrolledAt     string   `yaml:"enrolled_at"`
	LastTransition string   `yaml:"last_transition"`
}

type autopilotState struct {
	Queue     []string `yaml:"queue"`
	Current   *string  `yaml:"current"`
	Completed []string `yaml:"completed"`
	State     *string  `yaml:"state"`
	Mode      string   `yaml:"mode"`
}

type watchEntry struct {
	Enabled      bool                   `yaml:"enabled"`
	Source       string                 `yaml:"source"`
	Query        map[string]interface{} `yaml:"query,omitempty"`
	TargetRepo   string                 `yaml:"target_repo"`
	StopStage    *string                `yaml:"stop_stage"`
	Known        []string               `yaml:"known"`
	Completed    []string               `yaml:"completed"`
	LastChecked  *string                `yaml:"last_checked"`
	LastError    *string                `yaml:"last_error"`
	Instructions string                 `yaml:"instructions,omitempty"`
}

type legacyNote struct {
	ID        string   `yaml:"id"`
	Text      string   `yaml:"text"`
	Refs      []string `yaml:"refs,omitempty"`
	CreatedAt string   `yaml:"created_at"`
	UpdatedAt string   `yaml:"updated_at"`
	Resolved  bool     `yaml:"resolved"`
}

var legacyKeys = []string{"monitored", "watches", "autopilot", "notes"}

// legacyShape reports whether data is a pre-`tracked` file: any of the four
// old sections present (non-null) with `tracked` absent.
func legacyShape(data map[string]interface{}) bool {
	if t, ok := data[keyTracked]; ok && t != nil {
		return false
	}
	for _, k := range legacyKeys {
		if v, ok := data[k]; ok && v != nil {
			return true
		}
	}
	return false
}

// convertLegacy converts a legacy-shaped file's sections to items. A running
// autopilot queue refuses.
func convertLegacy(data map[string]interface{}, bm map[string]BranchMapEntry) ([]fabItem, error) {
	ap := autopilotState{}
	if err := decodeSection(data, "autopilot", &ap); err != nil {
		return nil, err
	}
	if ap.State != nil && *ap.State == "running" {
		return nil, errors.New(LegacyRunningRefusal)
	}

	now := nowRFC3339()
	items := []fabItem{}

	// monitored.<id> → pane items (scope from the entry fields, scope.change
	// seeded from the id, checked_at = last_transition).
	monitored := map[string]monitoredEntry{}
	if err := decodeSection(data, "monitored", &monitored); err != nil {
		return nil, err
	}
	for _, id := range sortedKeys(monitored) {
		items = append(items, convertMonitored(id, monitored[id]))
	}

	// watches.<name> → linear/slack agent items (seen = known ∪ completed,
	// then = instructions, a disabled watch converts paused).
	watches := map[string]watchEntry{}
	if err := decodeSection(data, "watches", &watches); err != nil {
		return nil, err
	}
	for _, name := range sortedKeys(watches) {
		items = append(items, convertWatch(name, watches[name], now))
	}

	items = convertAutopilotQueue(items, ap, bm, now)

	// Open notes → kind: note items keeping their ids; resolved dropped.
	notes := []legacyNote{}
	if err := decodeSection(data, "notes", &notes); err != nil {
		return nil, err
	}
	for _, n := range notes {
		if n.Resolved {
			continue
		}
		scope := map[string]interface{}{}
		if len(n.Refs) > 0 {
			scope["refs"] = n.Refs
		}
		items = append(items, fabItem{
			TrackedItem: TrackedItem{
				ID:        n.ID,
				Kind:      KindNote,
				Probe:     ProbeSpec{Mode: probeNone},
				DependsOn: []string{},
				Scope:     scope,
				Last:      map[string]interface{}{},
				AddedAt:   n.CreatedAt,
				UpdatedAt: n.UpdatedAt,
			},
			Text: n.Text,
		})
	}
	return items, nil
}

func setScopeString(scope map[string]interface{}, key, s string) {
	if s != "" {
		scope[key] = s
	}
}

func convertMonitored(id string, e monitoredEntry) fabItem {
	scope := paneScope()
	scope["change"] = id // a monitored entry's id is its change id
	setScopeString(scope, "pane", e.Pane)
	setScopeString(scope, "repo", e.Repo)
	setScopeString(scope, "session", e.Session)
	setScopeString(scope, "branch", e.Branch)
	setScopeString(scope, "stage", e.Stage)
	setScopeString(scope, "agent", e.Agent)
	if e.StopStage != nil {
		scope["stop_stage"] = *e.StopStage
	}
	if e.SpawnedBy != nil {
		scope["spawned_by"] = *e.SpawnedBy
	}
	var checkedAt *string
	if e.LastTransition != "" {
		checkedAt = &e.LastTransition
	}
	dependsOn := e.DependsOn
	if dependsOn == nil {
		dependsOn = []string{}
	}
	return fabItem{TrackedItem: TrackedItem{
		ID:        id,
		Kind:      KindPane,
		Probe:     ProbeSpec{Mode: probePane},
		DependsOn: dependsOn,
		Scope:     scope,
		Last:      map[string]interface{}{},
		CheckedAt: checkedAt,
		AddedAt:   e.EnrolledAt,
		UpdatedAt: e.LastTransition,
	}}
}

func convertWatch(name string, w watchEntry, now string) fabItem {
	instruction := fmt.Sprintf("check %s for new items; report new ids not in seen", w.Source)
	if len(w.Query) > 0 {
		instruction = fmt.Sprintf("check %s for new items matching query %v; report new ids not in seen", w.Source, w.Query)
	}
	scope := map[string]interface{}{
		"repo":       w.TargetRepo,
		"stop_stage": nil,
		"query":      nil,
	}
	if w.StopStage != nil {
		scope["stop_stage"] = *w.StopStage
	}
	if len(w.Query) > 0 {
		scope["query"] = w.Query
	}
	seen := unionStrings(w.Known, w.Completed)
	if len(seen) > seenCap {
		seen = seen[len(seen)-seenCap:]
	}
	checkEvery := checkEveryDefaultText
	item := TrackedItem{
		ID:         name,
		Kind:       w.Source,
		Probe:      ProbeSpec{Mode: probeAgent, Instruction: instruction},
		CheckEvery: &checkEvery,
		DependsOn:  []string{},
		Scope:      scope,
		Last:       map[string]interface{}{},
		Seen:       seen,
		CheckedAt:  w.LastChecked,
		Paused:     !w.Enabled,
		AddedAt:    now,
		UpdatedAt:  now,
	}
	if w.Instructions != "" {
		item.Then = &w.Instructions
	}
	return fabItem{TrackedItem: item}
}

// convertAutopilotQueue folds the not-yet-completed queue entries into items:
// an entry already converted from monitored gains merge_mode (and a chain dep
// when it has none); a queue-only entry becomes a pane-less pane item
// (pending/held). Chaining follows the nearest same-repo predecessor rule,
// with a cross-repo entry chained to its immediate predecessor.
func convertAutopilotQueue(items []fabItem, ap autopilotState, bm map[string]BranchMapEntry, now string) []fabItem {
	if len(ap.Queue) == 0 {
		return items
	}
	completed := map[string]bool{}
	for _, id := range ap.Completed {
		completed[id] = true
	}
	mode := ap.Mode
	if mode == "" {
		mode = defaultMergeMode
	}
	repoOf := func(id string) string {
		for _, it := range items {
			if it.ID == id {
				return scopeString(it.Scope, "repo")
			}
		}
		return bm[id].Repo
	}
	var pending []string // not-completed queue entries seen so far, in order
	for _, id := range ap.Queue {
		if completed[id] {
			continue
		}
		pred := ""
		if repo := repoOf(id); repo != "" {
			for i := len(pending) - 1; i >= 0; i-- {
				if repoOf(pending[i]) == repo {
					pred = pending[i]
					break
				}
			}
		}
		if pred == "" && len(pending) > 0 {
			pred = pending[len(pending)-1]
		}
		idx := -1
		for i := range items {
			if items[i].ID == id {
				idx = i
				break
			}
		}
		if idx >= 0 {
			items[idx].Scope["merge_mode"] = mode
			if len(items[idx].DependsOn) == 0 && pred != "" {
				items[idx].DependsOn = []string{pred}
			}
		} else {
			scope := paneScope()
			scope["change"] = id // a queue entry's id is its change id
			setScopeString(scope, "repo", repoOf(id))
			setScopeString(scope, "branch", bm[id].Branch)
			scope["merge_mode"] = mode
			deps := []string{}
			if pred != "" {
				deps = []string{pred}
			}
			items = append(items, fabItem{TrackedItem: TrackedItem{
				ID:        id,
				Kind:      KindPane,
				Probe:     ProbeSpec{Mode: probePane},
				DependsOn: deps,
				Scope:     scope,
				Last:      map[string]interface{}{},
				AddedAt:   now,
				UpdatedAt: now,
			}})
		}
		pending = append(pending, id)
	}
	return items
}

// unionStrings concatenates the lists deduped, first occurrence winning.
func unionStrings(a, b []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, s := range append(append([]string{}, a...), b...) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
