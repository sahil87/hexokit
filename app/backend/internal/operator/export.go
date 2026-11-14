package operator

import "context"

// The helpers below are the ledger primitives the autopilot engine builds on:
// it reads and writes the same tracked items through the same locked store, so
// it must agree with `rk operator track` on what done, held and a pane item are.

// ErrNoWrite, returned from a Mutate callback, releases the lock without
// writing the file.
var ErrNoWrite = errNoWrite

// ItemDone reports whether the item is done: a persisted done_at, or its
// done_when holding against the last observed fields.
func ItemDone(it TrackedItem) bool { return itemDone(it) }

// ScopeString reads a string scope value ("" for absent, null or non-string).
func ScopeString(scope map[string]interface{}, key string) string { return scopeString(scope, key) }

// ScopeInt reads an integer scope value; ok is false for absent, null or
// non-numeric values.
func ScopeInt(scope map[string]interface{}, key string) (int, bool) { return scopeInt(scope, key) }

// ScopePRNumber renders scope.pr as the PR-number argv token ("" when unset).
func ScopePRNumber(scope map[string]interface{}) string { return scopePRNumber(scope) }

// IndexOf returns the position of the item with id, or -1.
func IndexOf(items []TrackedItem, id string) int { return indexOf(items, id) }

// NowRFC3339 is the store's timestamp source.
func NowRFC3339() string { return nowRFC3339() }

// ValidMergeMode reports whether mode is one of MergeModes.
func ValidMergeMode(mode string) bool { return validMergeMode(mode) }

// BuiltInCompleted is the pane completion predicate: at the terminus (or past
// stop_stage) with the stage finished.
func BuiltInCompleted(stopStage, stage, displayState string) bool {
	return builtInCompleted(stopStage, stage, displayState)
}

// PaneScope returns a fresh pane scope with the pinned keys set to null.
func PaneScope() map[string]interface{} { return paneScope() }

// NewPaneItem builds a pending pane item (no pane yet) for the given scope and
// dependencies, with the pane-kind defaults. The scope is merged over the
// pinned null keys.
func NewPaneItem(id string, deps []string, scope map[string]interface{}) (TrackedItem, error) {
	if id == "" {
		return TrackedItem{}, invalidf("tracked item id must not be empty")
	}
	full := paneScope()
	for k, v := range scope {
		full[k] = v
	}
	if deps == nil {
		deps = []string{}
	}
	now := nowRFC3339()
	it := TrackedItem{
		ID:        id,
		Kind:      KindPane,
		Probe:     ProbeSpec{Mode: probePane},
		DependsOn: deps,
		Scope:     full,
		Last:      map[string]interface{}{},
		AddedAt:   now,
		UpdatedAt: now,
	}
	if err := validateItem(it); err != nil {
		return TrackedItem{}, err
	}
	return it, nil
}

// NewGitHubPRItem builds a github-pr item probing `gh pr view <n> --repo
// <nwo>` with the kind defaults. nwo is the repo's owner/name.
func NewGitHubPRItem(id string, deps []string, scope map[string]interface{}, nwo string) (TrackedItem, error) {
	if id == "" {
		return TrackedItem{}, invalidf("tracked item id must not be empty")
	}
	pr := scopePRNumber(scope)
	if pr == "" {
		return TrackedItem{}, invalidf("kind github-pr requires scope.pr")
	}
	every := "2m"
	done := kinds[KindGitHubPR].doneWhen
	if deps == nil {
		deps = []string{}
	}
	argv := []string{"gh", "pr", "view", pr}
	if nwo != "" {
		argv = append(argv, "--repo", nwo)
	}
	argv = append(argv, "--json", "state,mergedAt,mergeable")
	now := nowRFC3339()
	it := TrackedItem{
		ID:         id,
		Kind:       KindGitHubPR,
		Probe:      ProbeSpec{Mode: probeShell, Argv: argv, Fields: append([]string(nil), githubPRProbeFields...)},
		CheckEvery: &every,
		DoneWhen:   &done,
		DependsOn:  deps,
		Scope:      scope,
		Last:       map[string]interface{}{},
		AddedAt:    now,
		UpdatedAt:  now,
	}
	if err := validateItem(it); err != nil {
		return TrackedItem{}, err
	}
	return it, nil
}

// ValidateDeps checks the item's depends_on against the list: every id exists
// and no item depends on itself.
func ValidateDeps(it TrackedItem, existing []TrackedItem) error { return validateDeps(it, existing) }

// ValidateNote checks a note's author and text and returns the trimmed text.
func ValidateNote(by, text string) (string, error) { return validateNote(by, text) }

// AppendNote adds a note to the item in a loaded state, pruning past NoteCap.
// It is the in-Mutate form of AddNote, for callers batching several changes
// into one write.
func AppendNote(it *TrackedItem, by, text string) error {
	text, err := validateNote(by, text)
	if err != nil {
		return err
	}
	now := nowRFC3339()
	it.Notes = append(it.Notes, Note{At: now, By: by, Text: text})
	if len(it.Notes) > NoteCap {
		it.Notes = append([]Note(nil), it.Notes[len(it.Notes)-NoteCap:]...)
	}
	it.UpdatedAt = now
	return nil
}

// PaneInfo is one pane of the server snapshot: tmux's own facts plus the fab
// tier derived from the pane's cwd.
type PaneInfo struct {
	PaneID       string
	Cwd          string
	Command      string
	AgentState   string
	Change       string
	Stage        string
	DisplayState string
}

// SnapshotPanes lists every pane of the named server. A dead server is an
// error, never an empty snapshot.
func SnapshotPanes(ctx context.Context, server string) (map[string]PaneInfo, error) {
	rows, err := paneSnapshotFn(ctx, server)
	if err != nil {
		return nil, err
	}
	out := make(map[string]PaneInfo, len(rows))
	for id, r := range rows {
		out[id] = PaneInfo{
			PaneID: r.PaneID, Cwd: r.Cwd, Command: r.Command, AgentState: r.AgentState,
			Change: r.Change, Stage: r.Stage, DisplayState: r.DisplayState,
		}
	}
	return out, nil
}

// RecordPanePID maintains the scope.pane_pid fingerprint beside scope.pane
// (null on an empty pane or a failed lookup), the same rule `track update`
// applies when a pane is attached.
func RecordPanePID(ctx context.Context, server string, scope map[string]interface{}) {
	recordPanePID(ctx, server, scope)
}
