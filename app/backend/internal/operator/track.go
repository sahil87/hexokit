package operator

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"

	"rk/internal/tmux"
)

// panePIDTimeout bounds the tmux pane_pid lookup at add/update.
const panePIDTimeout = 5 * time.Second

// paneSugarFlags are the pane scope shortcut flags; each maps to the scope key
// of the same name with '-' as '_'.
var paneSugarFlags = []string{"pane", "repo", "session", "branch", "stage", "agent", "stop-stage", "spawned-by", "change"}

// PaneSugarFlags lists the pane scope shortcut flag names.
func PaneSugarFlags() []string { return append([]string(nil), paneSugarFlags...) }

// ghNameWithOwnerFn resolves a local repo path's owner/repo via `gh repo
// view`. A failure is an add-time error: the argv is never silently left
// without --repo. Injectable seam; argv-only and bounded by probeTimeout.
var ghNameWithOwnerFn = func(ctx context.Context, repoDir string) (string, error) {
	if _, err := exec.LookPath("gh"); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "gh", "repo", "view", "--json", "nameWithOwner")
	cmd.Dir = repoDir
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	var v struct {
		NameWithOwner string `json:"nameWithOwner"`
	}
	if err := json.Unmarshal(out, &v); err != nil {
		return "", err
	}
	if v.NameWithOwner == "" {
		return "", fmt.Errorf("gh repo view returned an empty nameWithOwner")
	}
	return v.NameWithOwner, nil
}

// panePIDFn is the tmux pane_pid lookup seam.
var panePIDFn = tmux.PanePIDCtx

// AddSpec is the input of Add. Unset fields are the zero value; DoneWhen and
// Then are pointers because an explicitly empty value clears to null while an
// unset one takes the kind default.
type AddSpec struct {
	ID          string
	Kind        string
	Server      string // tmux server for the pane_pid lookup
	Probe       string
	Argv        []string
	Fields      []string
	Instruction string
	CheckEvery  string
	DoneWhen    *string
	Then        *string
	DependsOn   []string
	Scope       map[string]interface{}
	PaneSugar   map[string]string // changed pane sugar flags, by flag name
	Mode        string            // merge mode (pane only)
	Text        string            // first note (note kind only)
	TextSet     bool
	By          string // first note's author, default user
}

// AddResult reports what Add stored beyond the item itself.
type AddResult struct {
	MergeMode string // non-empty when --mode set scope.merge_mode
}

// Add appends a validated item (and, for a pane item carrying branch and
// repo, a branch_map entry). External lookups run before the lock is taken.
func Add(ctx context.Context, path string, spec AddSpec) (AddResult, error) {
	var res AddResult
	kd, ok := kinds[spec.Kind]
	if !ok {
		return res, invalidf("unknown --kind %q (valid: %s)", spec.Kind, KindNames)
	}
	mode, err := probeMode(spec.Kind, kd, spec.Probe)
	if err != nil {
		return res, err
	}

	scope := spec.Scope
	if spec.Kind == KindPane {
		base := paneScope()
		for k, v := range scope {
			base[k] = v
		}
		scope = base
		if err := applyPaneSugar(spec.PaneSugar, scope); err != nil {
			return res, err
		}
		if spec.Mode != "" {
			if !validMergeMode(spec.Mode) {
				return res, invalidf("unknown --mode %q (valid: %s)", spec.Mode, strings.Join(MergeModes, ", "))
			}
			scope["merge_mode"] = spec.Mode
			res.MergeMode = spec.Mode
		}
		recordPanePID(ctx, spec.Server, scope)
	} else {
		if len(spec.PaneSugar) > 0 {
			for _, name := range paneSugarFlags {
				if _, set := spec.PaneSugar[name]; set {
					return res, invalidf("--%s applies only to kind pane", name)
				}
			}
		}
		if spec.Mode != "" {
			return res, invalidf("--mode applies only to kind pane")
		}
	}
	if scope == nil {
		scope = map[string]interface{}{}
	}

	probe := ProbeSpec{Mode: mode}
	switch mode {
	case probeShell:
		probe.Argv, probe.Fields = spec.Argv, spec.Fields
		if spec.Kind == KindGitHubPR {
			if len(probe.Argv) == 0 {
				probe.Argv, err = defaultGitHubPRArgv(ctx, scope)
				if err != nil {
					return res, err
				}
			}
			if len(probe.Fields) == 0 {
				probe.Fields = githubPRProbeFields
			}
		}
	case probeAgent:
		probe.Instruction = spec.Instruction
	}

	checkEvery, err := normalizeCheckEvery(mode, spec.CheckEvery)
	if err != nil {
		return res, err
	}
	doneWhen := doneWhenOrDefault(spec.DoneWhen, kd.doneWhen)
	if spec.Kind == KindShell && doneWhen == nil {
		return res, invalidf("kind shell requires --done-when")
	}
	if spec.TextSet && spec.Kind != KindNote {
		return res, invalidf("--text applies only to kind note")
	}
	var then *string
	if spec.Then != nil && *spec.Then != "" {
		then = spec.Then
	}

	now := nowRFC3339()
	item := TrackedItem{
		ID:         spec.ID,
		Kind:       spec.Kind,
		Probe:      probe,
		CheckEvery: checkEvery,
		DoneWhen:   doneWhen,
		Then:       then,
		DependsOn:  spec.DependsOn,
		Scope:      scope,
		Last:       map[string]interface{}{},
		AddedAt:    now,
		UpdatedAt:  now,
	}
	if item.DependsOn == nil {
		item.DependsOn = []string{}
	}
	if spec.Kind == KindNote {
		by := spec.By
		if by == "" {
			by = ByUser
		}
		text, err := validateNote(by, spec.Text)
		if err != nil {
			return res, invalidf("kind note requires --text: %v", err)
		}
		item.Notes = []Note{{At: now, By: by, Text: text}}
	}
	if err := validateItem(item); err != nil {
		return res, err
	}
	if spec.ID == "" {
		return res, invalidf("tracked item id must not be empty")
	}

	return res, Mutate(path, func(st *State) error {
		if indexOf(st.Tracked, item.ID) >= 0 {
			return fmt.Errorf("tracked item %s already exists", item.ID)
		}
		if err := validateDeps(item, st.Tracked); err != nil {
			return err
		}
		st.Tracked = append(st.Tracked, item)
		if spec.Kind == KindPane {
			branch, repo := scopeString(scope, "branch"), scopeString(scope, "repo")
			if branch != "" && repo != "" {
				// Keyed by the change id when given, else the item id (a
				// known-change spawn's id is the change).
				key := scopeString(scope, "change")
				if key == "" {
					key = item.ID
				}
				st.BranchMap[key] = BranchMapEntry{Branch: branch, Repo: repo}
			}
		}
		return nil
	})
}

// probeMode resolves the item's probe mode: the kind default, or the override
// when the kind allows it.
func probeMode(kind string, kd kindSpec, given string) (string, error) {
	if given == "" {
		return kd.defaultProbe, nil
	}
	switch given {
	case probePane, probeShell, probeAgent, probeNone:
	default:
		return "", invalidf("unknown --probe %q (valid: pane, shell, agent, none)", given)
	}
	if given != kd.defaultProbe {
		return "", invalidf("kind %s does not allow probe mode %q", kind, given)
	}
	return given, nil
}

// doneWhenOrDefault applies the add-time rule: unset → the kind default,
// explicitly empty → null.
func doneWhenOrDefault(given *string, kindDefault string) *string {
	v := kindDefault
	if given != nil {
		v = *given
	}
	if v == "" {
		return nil
	}
	return &v
}

func validMergeMode(mode string) bool {
	for _, m := range MergeModes {
		if m == mode {
			return true
		}
	}
	return false
}

func validStage(s string) bool {
	for _, st := range stageNames {
		if st == s {
			return true
		}
	}
	return false
}

// applyPaneSugar writes the pane flag sugar into scope. --change pre-declares
// the expected change (validated non-empty only — the change may not exist
// yet); only the stage-valued flags are name-checked.
func applyPaneSugar(sugar map[string]string, scope map[string]interface{}) error {
	for _, name := range paneSugarFlags {
		v, set := sugar[name]
		if !set {
			continue
		}
		key := strings.ReplaceAll(name, "-", "_")
		if v == "" {
			if key == "change" {
				return invalidf("--change requires a non-empty change id")
			}
			scope[key] = nil
			continue
		}
		if (key == "stage" || key == "stop_stage") && !validStage(v) {
			return invalidf("invalid --%s %q (valid: %s)", name, v, strings.Join(stageNames, ", "))
		}
		scope[key] = v
	}
	return nil
}

// recordPanePID maintains the scope.pane_pid fingerprint beside scope.pane: a
// non-empty pane records the pane's current shell pid; any lookup failure
// stores null and proceeds. A cleared pane nulls pane_pid.
func recordPanePID(ctx context.Context, server string, scope map[string]interface{}) {
	paneID := scopeString(scope, "pane")
	if paneID == "" {
		scope["pane_pid"] = nil
		return
	}
	ctx, cancel := context.WithTimeout(ctx, panePIDTimeout)
	defer cancel()
	pid, err := panePIDFn(ctx, paneID, server)
	if err != nil {
		scope["pane_pid"] = nil
		return
	}
	scope["pane_pid"] = pid
}

// defaultGitHubPRArgv builds the github-pr kind's default probe argv:
// gh pr view <n> [--repo <owner/repo>] --json state,mergedAt,mergeable. The PR
// number comes from scope.pr; --repo is derived from scope.repo.
func defaultGitHubPRArgv(ctx context.Context, scope map[string]interface{}) ([]string, error) {
	pr := scopePRNumber(scope)
	if pr == "" {
		return nil, invalidf("kind github-pr requires scope.pr (or explicit --argv)")
	}
	argv := []string{"gh", "pr", "view", pr}
	fields := strings.Join(githubPRProbeFields, ",")
	if repoDir := scopeString(scope, "repo"); repoDir != "" {
		// Without --repo the probe would run from the caller's cwd and query
		// the wrong PR number, so a failed derivation must not drop it.
		nwo, err := ghNameWithOwnerFn(ctx, repoDir)
		if err != nil {
			return nil, fmt.Errorf("cannot resolve the GitHub repo for scope.repo %s (%v) — pass --argv explicitly (gh pr view %s --repo <owner/repo> --json %s) or fix gh auth", repoDir, err, pr, fields)
		}
		argv = append(argv, "--repo", nwo)
	}
	return append(argv, "--json", fields), nil
}

// UpdateSpec is the input of Update; only set fields change. DoneWhen and
// Then clear to null when set to the empty string.
type UpdateSpec struct {
	ID         string
	Server     string
	CheckEvery *string
	DoneWhen   *string
	Then       *string
	DependsOn  *[]string
	Scope      map[string]interface{} // merged per key
}

// Update changes an item's cadence, predicate, then, depends_on, or scope. A
// scope.pane change re-records the pane_pid fingerprint in the same mutation.
func Update(ctx context.Context, path string, spec UpdateSpec) error {
	if spec.DoneWhen != nil && *spec.DoneWhen != "" {
		if _, err := Parse(*spec.DoneWhen); err != nil {
			return invalidf("invalid --done-when: %v", err)
		}
	}
	return Mutate(path, func(st *State) error {
		idx := indexOf(st.Tracked, spec.ID)
		if idx < 0 {
			return fmt.Errorf("no tracked item %s", spec.ID)
		}
		it := st.Tracked[idx]
		if spec.CheckEvery != nil {
			ce, err := normalizeCheckEvery(it.Probe.Mode, *spec.CheckEvery)
			if err != nil {
				return err
			}
			it.CheckEvery = ce
		}
		if spec.DoneWhen != nil {
			it.DoneWhen = nil
			if *spec.DoneWhen != "" {
				it.DoneWhen = spec.DoneWhen
			}
		}
		if spec.Then != nil {
			it.Then = nil
			if *spec.Then != "" {
				it.Then = spec.Then
			}
		}
		if spec.DependsOn != nil {
			deps := *spec.DependsOn
			if deps == nil {
				deps = []string{}
			}
			it.DependsOn = deps
			if err := validateDeps(it, st.Tracked); err != nil {
				return err
			}
		}
		if spec.Scope != nil {
			scope := make(map[string]interface{}, len(it.Scope)+len(spec.Scope))
			for k, v := range it.Scope {
				scope[k] = v
			}
			for k, v := range spec.Scope {
				scope[k] = v
			}
			if _, touched := spec.Scope["pane"]; touched {
				recordPanePID(ctx, spec.Server, scope)
			}
			it.Scope = scope
		}
		it.UpdatedAt = nowRFC3339()
		st.Tracked[idx] = it
		return nil
	})
}

// ObserveSpec is one probe outcome: Fields for a success (a decoded JSON
// object), Failed for a failure. Seen lists handled ids to append.
type ObserveSpec struct {
	ID     string
	Fields map[string]interface{}
	Failed bool
	Seen   []string
}

// Observe stores a probe outcome: last per probe.fields (dotted paths, absent
// → null), unchanged bumped or reset, failures counted (the third consecutive
// one pauses the item), seen pruned to its cap.
func Observe(path string, spec ObserveSpec) error {
	return Mutate(path, func(st *State) error {
		idx := indexOf(st.Tracked, spec.ID)
		if idx < 0 {
			return fmt.Errorf("no tracked item %s", spec.ID)
		}
		it := st.Tracked[idx]
		now := nowRFC3339()
		it.CheckedAt = &now
		it.UpdatedAt = now
		if spec.Failed {
			it.Failures++
			if it.Failures >= failurePauseCap {
				it.Paused = true
			}
		} else {
			newLast := spec.Fields
			if len(it.Probe.Fields) > 0 {
				newLast = extractProbeFields(spec.Fields, it.Probe.Fields)
			}
			normalizeJSONNumbers(newLast)
			if reflect.DeepEqual(newLast, it.Last) {
				it.Unchanged++
			} else {
				it.Unchanged = 0
				it.Last = newLast
			}
			it.Failures = 0
			for _, s := range spec.Seen {
				if !containsString(it.Seen, s) {
					it.Seen = append(it.Seen, s)
				}
			}
			if len(it.Seen) > seenCap {
				it.Seen = it.Seen[len(it.Seen)-seenCap:]
			}
		}
		st.Tracked[idx] = it
		return nil
	})
}

// extractProbeFields pulls the declared fields (top-level keys, or dotted
// paths a.b into nested objects) out of an observed object. An absent field
// stores null so a value→absent transition stays visible and `field == null`
// predicates work.
func extractProbeFields(obj map[string]interface{}, fields []string) map[string]interface{} {
	out := map[string]interface{}{}
	for _, f := range fields {
		segs := strings.Split(f, ".")
		setPathValue(out, segs, getPathValue(obj, segs))
	}
	return out
}

func getPathValue(obj map[string]interface{}, segs []string) interface{} {
	var cur interface{} = obj
	for _, s := range segs {
		m, ok := cur.(map[string]interface{})
		if !ok {
			return nil
		}
		cur = m[s]
	}
	return cur
}

// setPathValue writes v at a dotted path, merging into nested objects that
// earlier fields already created — fields a.b and a.c both land under a. A
// non-object value at an intermediate segment is replaced by an object so the
// declared field always lands.
func setPathValue(out map[string]interface{}, segs []string, v interface{}) {
	cur := out
	for _, s := range segs[:len(segs)-1] {
		next, ok := cur[s].(map[string]interface{})
		if !ok {
			next = map[string]interface{}{}
			cur[s] = next
		}
		cur = next
	}
	cur[segs[len(segs)-1]] = v
}

// normalizeJSONNumbers rewrites integral float64 values (JSON's number
// decoding) to ints so a stored last compares DeepEqual-stable across a YAML
// save/load roundtrip (YAML decodes "1" as int).
func normalizeJSONNumbers(v interface{}) {
	switch m := v.(type) {
	case map[string]interface{}:
		for k, val := range m {
			if f, ok := val.(float64); ok && f == float64(int(f)) {
				m[k] = int(f)
			} else {
				normalizeJSONNumbers(val)
			}
		}
	case []interface{}:
		for i, val := range m {
			if f, ok := val.(float64); ok && f == float64(int(f)) {
				m[i] = int(f)
			} else {
				normalizeJSONNumbers(val)
			}
		}
	}
}

func containsString(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

// dropString returns list without every occurrence of s (never nil — an
// emptied depends_on stays []).
func dropString(list []string, s string) []string {
	out := make([]string, 0, len(list))
	for _, v := range list {
		if v != s {
			out = append(out, v)
		}
	}
	return out
}

// Remove deletes an item and its notes. A done item is also dropped from every
// dependent's depends_on so the chain advances after the ack; a not-done
// removal keeps the edges. branch_map is untouched.
func Remove(path, id string) error {
	return Mutate(path, func(st *State) error {
		idx := indexOf(st.Tracked, id)
		if idx < 0 {
			return fmt.Errorf("no tracked item %s", id)
		}
		removed := st.Tracked[idx]
		st.Tracked = append(st.Tracked[:idx], st.Tracked[idx+1:]...)
		if itemDone(removed) {
			for i := range st.Tracked {
				st.Tracked[i].DependsOn = dropString(st.Tracked[i].DependsOn, removed.ID)
			}
		}
		return nil
	})
}

// Pause sets paused on an item.
func Pause(path, id string) error {
	return setPaused(path, id, true)
}

// Resume clears paused on an item and zeroes its failure count.
func Resume(path, id string) error {
	return setPaused(path, id, false)
}

func setPaused(path, id string, paused bool) error {
	return Mutate(path, func(st *State) error {
		idx := indexOf(st.Tracked, id)
		if idx < 0 {
			return fmt.Errorf("no tracked item %s", id)
		}
		it := &st.Tracked[idx]
		it.Paused = paused
		if !paused {
			it.Failures = 0
		}
		it.UpdatedAt = nowRFC3339()
		return nil
	})
}

// validateNote checks the author and text of a note and returns the trimmed
// text. Over-length text is an error, never truncated.
func validateNote(by, text string) (string, error) {
	switch by {
	case ByUser, ByRun, ByChat:
	default:
		return "", invalidf("invalid --by %q (valid: %s)", by, strings.Join(NoteAuthors, ", "))
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", invalidf("note text must not be empty")
	}
	if n := utf8.RuneCountInString(text); n > NoteTextCap {
		return "", invalidf("note text is %d characters, over the %d-character cap", n, NoteTextCap)
	}
	return text, nil
}

// AddNote appends a note to an item, pruning the oldest past NoteCap, and
// touches updated_at. There is no per-note delete: notes leave only by cap
// pruning or with their item.
func AddNote(path, id, by, text string) error {
	text, err := validateNote(by, text)
	if err != nil {
		return err
	}
	return Mutate(path, func(st *State) error {
		idx := indexOf(st.Tracked, id)
		if idx < 0 {
			return fmt.Errorf("no tracked item %s", id)
		}
		it := &st.Tracked[idx]
		now := nowRFC3339()
		it.Notes = append(it.Notes, Note{At: now, By: by, Text: text})
		if len(it.Notes) > NoteCap {
			it.Notes = append([]Note(nil), it.Notes[len(it.Notes)-NoteCap:]...)
		}
		it.UpdatedAt = now
		return nil
	})
}

// List is a pure read: it never locks, writes, or converts. kind filters to
// one kind when non-empty.
func List(path, kind string) (all, shown []TrackedItem, err error) {
	if kind != "" {
		if _, ok := kinds[kind]; !ok {
			return nil, nil, invalidf("unknown --kind %q (valid: %s)", kind, KindNames)
		}
	}
	st, err := Load(path)
	if err != nil {
		return nil, nil, err
	}
	shown = st.Tracked
	if kind != "" {
		shown = []TrackedItem{}
		for _, it := range st.Tracked {
			if it.Kind == kind {
				shown = append(shown, it)
			}
		}
	}
	return st.Tracked, shown, nil
}

// ListLines renders one line per shown item: id · kind · state · checked-age ·
// next.
func ListLines(all, shown []TrackedItem) []string {
	now := clock().UTC()
	lines := make([]string, 0, len(shown))
	for _, it := range shown {
		lines = append(lines, fmt.Sprintf("%s · %s · %s · %s · %s",
			it.ID, it.Kind, listState(all, it, now), listCheckedAge(all, it, now), listNext(all, it)))
	}
	return lines
}

// listState derives the item's lifecycle state without a pane snapshot — pane
// items with a pane read live.
func listState(items []TrackedItem, it TrackedItem, now time.Time) string {
	switch {
	case itemDone(it):
		return "done"
	case it.Paused:
		return "paused"
	}
	if heldDep(items, it) != "" {
		return "held"
	}
	if it.Kind == KindPane && scopeString(it.Scope, "pane") == "" {
		return "pending"
	}
	if itemStale(it, now) {
		return "stale"
	}
	if it.Probe.Mode == probePane {
		return "live"
	}
	return "watching"
}

// listCheckedAge renders the Checked column: — for held items, live for pane
// items, the age since checked_at for probed items, and the age since
// updated_at for notes.
func listCheckedAge(items []TrackedItem, it TrackedItem, now time.Time) string {
	if !itemDone(it) && !it.Paused && heldDep(items, it) != "" {
		return "—"
	}
	if it.Probe.Mode == probePane {
		return "live"
	}
	base := it.CheckedAt
	if it.Kind == KindNote {
		base = &it.UpdatedAt
	}
	if base == nil || *base == "" {
		return "—"
	}
	t, err := time.Parse(time.RFC3339, *base)
	if err != nil {
		return "—"
	}
	return formatAge(now.Sub(t))
}

// listNext renders the Next column: the item's then, "spawn" for a pending
// pane item, "held: <dep-id>" for a held item.
func listNext(items []TrackedItem, it TrackedItem) string {
	if it.Then != nil && *it.Then != "" {
		return *it.Then
	}
	if dep := heldDep(items, it); dep != "" && !itemDone(it) {
		return "held: " + dep
	}
	if it.Kind == KindPane && scopeString(it.Scope, "pane") == "" && !itemDone(it) && !it.Paused {
		return "spawn"
	}
	return "—"
}

// formatAge renders an item age with day capability (note ages span weeks).
func formatAge(d time.Duration) string {
	secs := int64(d.Seconds())
	if secs < 0 {
		secs = 0
	}
	switch {
	case secs < 60:
		return fmt.Sprintf("%ds", secs)
	case secs < 3600:
		return fmt.Sprintf("%dm", secs/60)
	case secs < 86400:
		return fmt.Sprintf("%dh", secs/3600)
	default:
		return fmt.Sprintf("%dd", secs/86400)
	}
}
