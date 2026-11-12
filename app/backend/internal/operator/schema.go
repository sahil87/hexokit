// Package operator is the operator's tracked-item ledger: the typed schema,
// the plain-file state store under the hexokit state home, and the library
// operations behind `rk operator track` and `rk operator adopt`.
//
// The library owns the schema, the timestamps, the caps and the locked atomic
// write; callers state intent and never hand-write the YAML. Reads are
// tolerant (unknown top-level keys survive a mutation), writes are typed (an
// invented field inside `tracked` does not).
package operator

import (
	"fmt"
	"math"
	"strings"
	"time"
)

const (
	// probeTimeout bounds each subprocess the library runs on a caller's
	// behalf (the gh repo lookup).
	probeTimeout = 10 * time.Second
	// failurePauseCap is the consecutive-probe-failure count that trips an
	// item to paused: true.
	failurePauseCap = 3
	// seenCap caps a linear/slack item's seen list (oldest pruned first).
	seenCap = 200
	// checkEveryFloor is the minimum check_every cadence.
	checkEveryFloor = time.Minute
	// checkEveryDefaultText is the check_every filled at add time for
	// shell/agent items that omit it, in the terse stored form ("5m", not
	// Duration.String's "5m0s").
	checkEveryDefaultText = "5m"
	// staleMultiplier defines staleness: an agent item is stale when
	// now - checked_at exceeds staleMultiplier × check_every.
	staleMultiplier = 2
	// NoteCap is the number of notes kept per item (oldest pruned first).
	NoteCap = 50
	// NoteTextCap is the longest note text, in runes; longer text is an
	// error, never truncated.
	NoteTextCap = 1000
)

// Item kinds.
const (
	KindPane     = "pane"
	KindGitHubPR = "github-pr"
	KindLinear   = "linear"
	KindSlack    = "slack"
	KindShell    = "shell"
	KindTask     = "task"
	KindNote     = "note"
)

// Probe modes.
const (
	probePane  = "pane"
	probeShell = "shell"
	probeAgent = "agent"
	probeNone  = "none"
)

// Note authors.
const (
	ByUser = "user"
	ByRun  = "run"
	ByChat = "chat"
)

// Merge modes a chained pane item may carry in scope.merge_mode.
const (
	MergeModeCherryPickLadder = "cherry-pick-ladder"
	MergeModeStackedPRs       = "stacked-prs"
	MergeModeMergeAuto        = "merge-auto"
)

// KindNames is the valid-kind list for messages, in table order.
const KindNames = "pane, github-pr, linear, slack, shell, task, note"

// stageNames is the valid pipeline-stage list for the pane stage flags.
var stageNames = []string{"intake", "apply", "review", "hydrate", "ship", "review-pr"}

// MergeModes lists the valid --mode values.
var MergeModes = []string{MergeModeCherryPickLadder, MergeModeStackedPRs, MergeModeMergeAuto}

// NoteAuthors lists the valid note authors.
var NoteAuthors = []string{ByUser, ByRun, ByChat}

// kindSpec carries one kind's defaults. Each kind allows exactly its default
// probe mode.
type kindSpec struct {
	defaultProbe string
	doneWhen     string // "" = null default
}

var kinds = map[string]kindSpec{
	KindPane:     {defaultProbe: probePane},
	KindGitHubPR: {defaultProbe: probeShell, doneWhen: `state == "MERGED"`},
	KindLinear:   {defaultProbe: probeAgent},
	KindSlack:    {defaultProbe: probeAgent},
	KindShell:    {defaultProbe: probeShell},
	KindTask:     {defaultProbe: probeNone},
	KindNote:     {defaultProbe: probeNone},
}

// githubPRProbeFields is the github-pr kind's default declared-field set.
var githubPRProbeFields = []string{"state", "mergedAt", "mergeable"}

// ProbeSpec declares how an item is probed. argv/fields belong to shell
// probes (argv is an argv list, never a shell string); instruction belongs to
// agent probes (the LLM runs it, the binary never does).
type ProbeSpec struct {
	Mode        string   `yaml:"mode" json:"mode"`
	Argv        []string `yaml:"argv,omitempty" json:"argv,omitempty"`
	Fields      []string `yaml:"fields,omitempty" json:"fields,omitempty"`
	Instruction string   `yaml:"instruction,omitempty" json:"instruction,omitempty"`
}

// Note is one append-only memory entry on an item. At is set by the library.
type Note struct {
	At   string `yaml:"at" json:"at"`
	By   string `yaml:"by" json:"by"`
	Text string `yaml:"text" json:"text"`
}

// TrackedItem is one `tracked` list entry. Field order pins the YAML key
// order; seen, notes and reported are omitempty. Reported is the condition
// keys the last check already surfaced as changes — written only by Check.
type TrackedItem struct {
	ID         string                 `yaml:"id" json:"id"`
	Kind       string                 `yaml:"kind" json:"kind"`
	Probe      ProbeSpec              `yaml:"probe" json:"probe"`
	CheckEvery *string                `yaml:"check_every" json:"check_every"`
	DoneWhen   *string                `yaml:"done_when" json:"done_when"`
	Then       *string                `yaml:"then" json:"then"`
	DependsOn  []string               `yaml:"depends_on" json:"depends_on"`
	Scope      map[string]interface{} `yaml:"scope" json:"scope"`
	Last       map[string]interface{} `yaml:"last" json:"last"`
	Seen       []string               `yaml:"seen,omitempty" json:"seen,omitempty"`
	Notes      []Note                 `yaml:"notes,omitempty" json:"notes,omitempty"`
	Reported   []string               `yaml:"reported,omitempty" json:"reported,omitempty"`
	CheckedAt  *string                `yaml:"checked_at" json:"checked_at"`
	Unchanged  int                    `yaml:"unchanged" json:"unchanged"`
	Failures   int                    `yaml:"failures" json:"failures"`
	Paused     bool                   `yaml:"paused" json:"paused"`
	DoneAt     *string                `yaml:"done_at" json:"done_at"`
	AddedAt    string                 `yaml:"added_at" json:"added_at"`
	UpdatedAt  string                 `yaml:"updated_at" json:"updated_at"`
}

// BranchMapEntry is one `branch_map` value, keyed by change id.
type BranchMapEntry struct {
	Branch string `yaml:"branch" json:"branch"`
	Repo   string `yaml:"repo" json:"repo"`
}

// State is the typed view of the state file: the owned sections plus the
// unknown top-level keys that survive a rewrite. LastCheckAt is the RFC3339
// stamp of the last successful Check ("" = never checked, key omitted).
type State struct {
	Tracked     []TrackedItem
	BranchMap   map[string]BranchMapEntry
	LastCheckAt string
	extra       map[string]interface{}
}

// InvalidError marks a caller mistake (bad flag value, schema violation) as
// opposed to an operational failure (IO, lock, missing item); the CLI maps it
// to the usage exit class.
type InvalidError struct{ msg string }

func (e *InvalidError) Error() string { return e.msg }

func invalidf(format string, a ...interface{}) error {
	return &InvalidError{msg: fmt.Sprintf(format, a...)}
}

// normalizeCheckEvery forces null for pane/none items, fills the 5m default
// for shell/agent items when omitted, and rejects a cadence below the floor.
func normalizeCheckEvery(mode, given string) (*string, error) {
	if mode == probePane || mode == probeNone {
		return nil, nil
	}
	if given == "" {
		def := checkEveryDefaultText
		return &def, nil
	}
	dur, err := time.ParseDuration(given)
	if err != nil {
		return nil, invalidf("invalid --check-every %q: %v", given, err)
	}
	if dur < checkEveryFloor {
		return nil, invalidf("--check-every %q is below the %s floor", given, checkEveryFloor)
	}
	return &given, nil
}

// validateItem runs the rules that need no other items: known kind,
// kind-allowed probe mode, shell probe argv+fields, a parseable done_when, and
// the note caps. Duplicate-id and depends-on checks need the existing list
// and live in validateDeps.
func validateItem(it TrackedItem) error {
	kd, ok := kinds[it.Kind]
	if !ok {
		return invalidf("unknown kind %q (valid: %s)", it.Kind, KindNames)
	}
	if it.Probe.Mode != kd.defaultProbe {
		return invalidf("kind %s does not allow probe mode %q", it.Kind, it.Probe.Mode)
	}
	if it.Probe.Mode == probeShell {
		if len(it.Probe.Argv) == 0 {
			return invalidf("shell probe requires --argv")
		}
		if len(it.Probe.Fields) == 0 {
			return invalidf("shell probe requires --fields")
		}
	}
	if it.DoneWhen != nil && *it.DoneWhen != "" {
		if _, err := Parse(*it.DoneWhen); err != nil {
			return invalidf("invalid --done-when: %v", err)
		}
	}
	return nil
}

// validateDeps checks the item's depends_on against the existing list: every
// named id must exist and no item may depend on itself.
func validateDeps(it TrackedItem, existing []TrackedItem) error {
	for _, dep := range it.DependsOn {
		if dep == it.ID {
			return invalidf("--depends-on %q names the item itself", dep)
		}
		if indexOf(existing, dep) < 0 {
			return invalidf("--depends-on %q: no tracked item with that id", dep)
		}
	}
	return nil
}

func indexOf(items []TrackedItem, id string) int {
	for i := range items {
		if items[i].ID == id {
			return i
		}
	}
	return -1
}

// itemDone reports whether the item's done_when fires against its last
// observed fields. A null done_when is never done here; a persisted done_at
// (a pane item's built-in completion) is durable evidence and wins.
func itemDone(it TrackedItem) bool {
	if it.DoneAt != nil && *it.DoneAt != "" {
		return true
	}
	if it.DoneWhen == nil || *it.DoneWhen == "" {
		return false
	}
	p, err := Parse(*it.DoneWhen)
	if err != nil {
		return false
	}
	return p.Eval(it.Last)
}

// scopeString reads a string scope value ("" for absent/null/non-string).
func scopeString(scope map[string]interface{}, key string) string {
	s, _ := scope[key].(string)
	return s
}

// paneScope seeds the eleven pinned pane scope keys as null.
func paneScope() map[string]interface{} {
	return map[string]interface{}{
		"pane": nil, "pane_pid": nil, "change": nil, "repo": nil, "session": nil,
		"branch": nil, "stage": nil, "agent": nil, "stop_stage": nil,
		"spawned_by": nil, "merge_mode": nil,
	}
}

// checkEveryDuration parses the item's check_every; a null/unparseable value
// reports ok=false.
func checkEveryDuration(it TrackedItem) (time.Duration, bool) {
	if it.CheckEvery == nil {
		return 0, false
	}
	d, err := time.ParseDuration(*it.CheckEvery)
	return d, err == nil
}

// itemStale applies the staleness rule: an agent item with
// now - checked_at > staleMultiplier × check_every (checked_at null falls back
// to added_at).
func itemStale(it TrackedItem, now time.Time) bool {
	if it.Probe.Mode != probeAgent {
		return false
	}
	ce, ok := checkEveryDuration(it)
	if !ok {
		return false
	}
	base := it.AddedAt
	if it.CheckedAt != nil {
		base = *it.CheckedAt
	}
	t, err := time.Parse(time.RFC3339, base)
	if err != nil {
		return false
	}
	return now.Sub(t) > staleMultiplier*ce
}

// heldDep returns the first depends_on id whose item is not done ("" when
// every dep is satisfied). A dep id missing from the list is unsatisfied.
func heldDep(items []TrackedItem, it TrackedItem) string {
	for _, dep := range it.DependsOn {
		i := indexOf(items, dep)
		if i < 0 || !itemDone(items[i]) {
			return dep
		}
	}
	return ""
}

// scopePRNumber renders scope.pr as the PR-number argv token (JSON numbers
// decode as float64; hand-written YAML may carry an int or string).
func scopePRNumber(scope map[string]interface{}) string {
	switch v := scope["pr"].(type) {
	case float64:
		if v != math.Trunc(v) {
			return ""
		}
		return fmt.Sprintf("%d", int64(v))
	case int:
		return fmt.Sprintf("%d", v)
	case int64:
		return fmt.Sprintf("%d", v)
	case string:
		return strings.TrimSpace(v)
	}
	return ""
}
