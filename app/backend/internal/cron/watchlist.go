package cron

import (
	"os"
	"sort"
	"strconv"
	"time"

	"gopkg.in/yaml.v3"
)

// watchlist.go — the operator-state reader: the per-item parse of an
// operator state file's tracked: list, feeding the sessions payload's
// watchlist join (by pane ID), the operator staleness timestamp, and the
// per-server tracked-items list the Operator Tasks tab renders.
//
// Two files share one schema family and this one reader: rk's own
// ($XDG_STATE_HOME/hexokit/operator/<slug>.yaml, the primary source, written
// only by internal/operator) and fab's ($XDG_STATE_HOME/fab/operator/<fab-slug>.yaml,
// resolved via FabOperatorStatePath, the fallback while no rk file exists).
// Which one is read is the caller's choice (internal/sessions). internal/cron
// must not import internal/operator, which imports it.
//
// EXTERNAL CONTRACT: both are read tolerantly for DISPLAY only: unknown keys
// are ignored, an absent or unparseable file degrades to (zero, false), never
// an error. This reader writes neither; rk NEVER writes fab's file.
//
// One parse, two projections. The reader surfaces EVERY tracked item — any
// kind, pane-bearing or not, done or not — as a TrackedItem in list order:
// the operator's tracked: list is the ledger a task tab must show whole (a
// done item stays in the ledger until the operator removes it, so the task
// list shows it dimmed). The pane join consumes only the pane-bearing,
// not-done subset (OperatorState.WatchlistEntries): a done-but-unacked item
// would otherwise pin a watched row onto a finished or dead pane. paused
// items stay in both projections (a probe backoff or user pause is not a
// removal) and kind is never a filter.
//
// Primary shape (fab-kit ≥ 2.25, kit migration 2.24.9-to-2.25.0): a top-level
// `tracked:` LIST of items `{id, kind, text, scope: {pane, repo, session,
// stage, agent, branch, refs, …}, paused, done_at, added_at, updated_at, …}`.
// A missing or non-map scope keeps the item with empty scope fields (a note's
// scope is `{refs: [...]}`, a task may carry none). Malformed items — a
// non-map element, a missing id — are skipped, never fatal.
//
// Legacy shape (fab-kit ≤ 2.24): a top-level `monitored:` MAP keyed by change
// id. It is read ONLY when the `tracked` key is absent — a one-release dual
// read (fab/backlog.md tracks its retirement). The binary deletes `monitored`
// in the same write that introduces `tracked`, so both-present is residue:
// `tracked` wins by key presence, even as an empty list, so a stale map can
// never resurrect entries after the operator removes the last tracked item.

// noteKind is the tracked-item kind whose fab-side `text` becomes a note.
const noteKind = "note"

// userNoteAuthor is the `by` of a note synthesized from fab's note text.
const userNoteAuthor = "user"

// DefaultWatchlistStaleThreshold is the UI-facing "is the whole monitoring
// system dead" staleness window over the operator's last_tick_at — a
// product-level display threshold only; nothing in cron gates a fire on it.
const DefaultWatchlistStaleThreshold = 15 * time.Minute

// parseTickAt accepts unix seconds (number or string) or an RFC3339 string.
func parseTickAt(v any) int64 {
	switch t := v.(type) {
	case int:
		return int64(t)
	case int64:
		return t
	case float64:
		return int64(t)
	case string:
		if n, err := strconv.ParseInt(t, 10, 64); err == nil {
			return n
		}
		if ts, err := time.Parse(time.RFC3339, t); err == nil {
			return ts.Unix()
		}
	case time.Time:
		// yaml.v3 decodes ISO-8601 timestamps to time.Time on its own.
		return t.Unix()
	}
	return 0
}

// Note is one entry of a tracked item's notes: list — the operator's
// per-item memory. At is unix seconds (0 when absent or unparseable); By is
// user | run | chat, passed through verbatim.
type Note struct {
	At   int64
	By   string
	Text string
}

// TrackedItem is one item of an operator state file's tracked: list,
// read tolerantly for display — every kind, pane-bearing or not, done or
// not. The watchlist join consumes only the pane-bearing, not-done subset
// (WatchlistEntries); the sessions payload's operatorTracked list carries
// all of them. fab's other keys (probe, check_every, done_when, then,
// depends_on, last, checked_at, unchanged, failures, seen and the scope's
// stop_stage/spawned_by/merge_mode/pr) are ignored by the tolerant read.
type TrackedItem struct {
	ID        string   // tracked item id (fab-change: the change ID; other kinds: a slug) / the legacy monitored map's key
	Kind      string   // pane | fab-change | github-pr | linear | slack | shell | task | note; "" for a legacy monitored: entry
	Text      string   // fab's note prose (capped at 500 chars); "" for other kinds unless the item carries text
	Notes     []Note   // notes: list in file order (oldest first); a fab note item's text becomes one user note when it has none
	Refs      []string // scope.refs — change ids / branch or worktree names the item is about; nil when absent
	Pane      string   // scope.pane ("%N") — the join key; "" for pane-less items
	Repo      string   // scope.repo
	Session   string   // scope.session
	Stage     string   // scope.stage
	Agent     string   // scope.agent
	Branch    string   // scope.branch
	Paused    bool     // paused
	DoneAt    int64    // done_at as unix seconds; 0 = not done (the item is still live in the operator's set)
	AddedAt   int64    // added_at as unix seconds; 0 when absent
	UpdatedAt int64    // updated_at as unix seconds; 0 when absent
}

// OperatorState is the tolerant read of one operator state file.
type OperatorState struct {
	Items      []TrackedItem // tracked: list order (fab's insertion order); legacy monitored: map entries sorted by key
	LastTickAt int64
}

// WatchlistEntries is the pane join's input: every item with a non-empty
// Pane and DoneAt == 0 (paused and kind do not filter), sorted by ID — the
// entry set the pane-keyed join has always consumed.
func (s OperatorState) WatchlistEntries() []WatchlistEntry {
	var entries []WatchlistEntry
	for _, item := range s.Items {
		if item.Pane == "" || item.DoneAt != 0 {
			continue
		}
		entries = append(entries, WatchlistEntry{
			ChangeID: item.ID,
			Pane:     item.Pane,
			Repo:     item.Repo,
			Session:  item.Session,
			Stage:    item.Stage,
			Agent:    item.Agent,
			Branch:   item.Branch,
			Kind:     item.Kind,
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].ChangeID < entries[j].ChangeID })
	return entries
}

// WatchlistEntry is one watched item: the tracked item's id plus the fields
// the watchlist join needs, lifted from its `scope` block (pane/repo/session/
// stage/agent/branch). Kind is the item's `kind` (fab-change, github-pr,
// shell, …) and is "" for a legacy monitored: entry, which carried none; it
// is not plumbed to the sessions payload.
type WatchlistEntry struct {
	ChangeID string // the tracked item id (fab-change: the change ID) / the legacy monitored map's key
	Pane     string // "%N" — the join key onto PaneInfo.PaneID
	Repo     string
	Session  string
	Stage    string
	Agent    string
	Branch   string
	Kind     string
}

// strField extracts a string key from a tolerantly-decoded map ("" for
// missing or non-string values).
func strField(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// refsField extracts a string-list key from a tolerantly-decoded map —
// string elements only, non-string elements skipped; absent or empty ⇒ nil.
func refsField(m map[string]any, key string) []string {
	list, _ := m[key].([]any)
	var refs []string
	for _, el := range list {
		if s, ok := el.(string); ok {
			refs = append(refs, s)
		}
	}
	return refs
}

// ParseOperatorState distills the file bytes. ok is false only when the YAML
// itself fails to parse (corrupt). Items come back in the file's own order
// (the tracked: list's order is the operator's ledger, top-down; the legacy
// monitored: map is sorted by key for determinism). The tracked: list is the
// primary shape; the monitored: map is read only when the tracked key is
// absent — see the file header for the both-present rule.
func ParseOperatorState(data []byte) (state OperatorState, ok bool) {
	var raw map[string]any
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return OperatorState{}, false
	}
	if raw == nil {
		raw = map[string]any{}
	}
	if tracked, present := raw["tracked"]; present {
		state.Items = parseTrackedItems(tracked)
	} else {
		state.Items = parseMonitoredMap(raw["monitored"])
	}
	state.LastTickAt = parseTickAt(raw["last_tick_at"])
	return state, true
}

// parseTrackedItems is the fab-kit ≥ 2.25 arm: a non-list value yields no
// items; each element must be a map with a non-empty string id (yaml.v3
// decodes `done_at: null` to a nil interface and a set timestamp to
// time.Time or string; a non-nil but unparseable done_at decodes to 0 — the
// item then reads as live, the tolerant-read posture: the binary writes
// RFC3339 and nothing else). A missing or non-map scope keeps the item with
// empty scope fields.
func parseTrackedItems(v any) []TrackedItem {
	items, _ := v.([]any)
	var out []TrackedItem
	for _, el := range items {
		item, _ := el.(map[string]any)
		if item == nil {
			continue
		}
		id := strField(item, "id")
		if id == "" {
			continue
		}
		scope, _ := item["scope"].(map[string]any)
		kind := strField(item, "kind")
		text := strField(item, "text")
		updatedAt := parseTickAt(item["updated_at"])
		addedAt := parseTickAt(item["added_at"])
		notes := parseNotes(item["notes"])
		if len(notes) == 0 && kind == noteKind && text != "" {
			at := updatedAt
			if at == 0 {
				at = addedAt
			}
			notes = []Note{{At: at, By: userNoteAuthor, Text: text}}
		}
		out = append(out, TrackedItem{
			ID:        id,
			Kind:      kind,
			Text:      text,
			Notes:     notes,
			Refs:      refsField(scope, "refs"),
			Pane:      strField(scope, "pane"),
			Repo:      strField(scope, "repo"),
			Session:   strField(scope, "session"),
			Stage:     strField(scope, "stage"),
			Agent:     strField(scope, "agent"),
			Branch:    strField(scope, "branch"),
			Paused:    item["paused"] == true,
			DoneAt:    parseTickAt(item["done_at"]),
			AddedAt:   addedAt,
			UpdatedAt: updatedAt,
		})
	}
	return out
}

// parseNotes reads an item's notes: list in file order; a non-list value
// yields none, and a non-map element or one with empty text is skipped.
func parseNotes(v any) []Note {
	list, _ := v.([]any)
	var out []Note
	for _, el := range list {
		m, _ := el.(map[string]any)
		text := strField(m, "text")
		if text == "" {
			continue
		}
		out = append(out, Note{At: parseTickAt(m["at"]), By: strField(m, "by"), Text: text})
	}
	return out
}

// parseMonitoredMap is the fab-kit ≤ 2.24 arm (one-release dual read): a
// change-id-keyed map of {pane, repo, session, stage, agent, branch}; a
// non-map value or an entry without a pane yields nothing (every legacy
// entry was pane-bearing and never done). Entries come back sorted by key —
// a map has no order and the read stays deterministic. Kind stays "" — the
// legacy schema carried none and the reader invents no value.
func parseMonitoredMap(v any) []TrackedItem {
	monitored, _ := v.(map[string]any)
	var out []TrackedItem
	for key, mv := range monitored {
		m, _ := mv.(map[string]any)
		if m == nil {
			continue
		}
		pane := strField(m, "pane")
		if pane == "" {
			continue // nothing to join against
		}
		out = append(out, TrackedItem{
			ID:      key,
			Pane:    pane,
			Repo:    strField(m, "repo"),
			Session: strField(m, "session"),
			Stage:   strField(m, "stage"),
			Agent:   strField(m, "agent"),
			Branch:  strField(m, "branch"),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// ReadOperatorState reads an operator state file (rk's or fab's) tolerantly: absent or
// corrupt ⇒ (zero, false), never an error.
func ReadOperatorState(path string) (state OperatorState, present bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return OperatorState{}, false
	}
	state, ok := ParseOperatorState(data)
	if !ok {
		return OperatorState{}, false
	}
	return state, true
}
