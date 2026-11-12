package cron

import (
	"errors"
	"io/fs"
	"os"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"rk/internal/fsatomic"
	"rk/internal/tmux"
)

// wake.go — the `wake_on` poll approximation (R7). A wake_on:
// agent-state-change entry fires when its per-entry agent-state fingerprint
// differs from the entry's previous observation by an actionable transition,
// held for `debounce` after the entry's own newest delivery so a tick's own
// effect on the server never reads as the next edge.
//
// The fingerprint is per entry, not per server: the entry's own resolved
// target pane is excluded (fingerprintExcluding). Delivering a tick makes the
// target busy, and that flip is caused by the clock — the wake analogue of
// the backoff anchor-join rule. Transitions are classified (classifyDiff):
// `→ waiting`, `→ idle`, and a pane vanishing need the target's attention;
// `→ active` never does, so it advances the cursor without firing.
//
// The observation lives in a per-server cursor sidecar (<slug>.cursor.yaml) —
// seed-cache class per Constitution II: never authoritative, corrupt/absent
// degrades to a cold start (no edge fire that tick, cursor rewritten), at
// worst one missed or duplicate edge, which tick idempotency absorbs. Per-entry
// debounce means the cursor is keyed by entry id: one entry's fire must not
// advance (and thereby swallow) another entry's pending edge.

// WakeObservation is one entry's last-observed fingerprint and when that
// fingerprint value was first recorded.
type WakeObservation struct {
	Fingerprint string `yaml:"fingerprint"`
	ObservedAt  int64  `yaml:"observed_at"`
}

// WakeCursor is the per-server cursor file's content.
type WakeCursor struct {
	Entries map[string]WakeObservation `yaml:"entries,omitempty"`
}

// clone deep-copies the cursor map so evaluation never mutates its input.
func (c WakeCursor) clone() WakeCursor {
	out := WakeCursor{Entries: map[string]WakeObservation{}}
	for k, v := range c.Entries {
		out.Entries[k] = v
	}
	return out
}

// Fingerprint renders an agent-state map (pane id → state) as a canonical
// string. Map order never leaks in (sorted), so equal states always
// fingerprint equal. parseFingerprint is its inverse.
func Fingerprint(states map[string]string) string {
	keys := make([]string, 0, len(states))
	for pane, state := range states {
		if state == "" {
			continue
		}
		keys = append(keys, pane)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, pane := range keys {
		b.WriteString(pane)
		b.WriteByte('=')
		b.WriteString(states[pane])
		b.WriteByte('\n')
	}
	return b.String()
}

// parseFingerprint inverts Fingerprint. Lines without '=' are skipped, so a
// cursor written by an older rendering degrades to "fewer panes", never a
// parse error.
func parseFingerprint(fp string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(fp, "\n") {
		pane, state, ok := strings.Cut(line, "=")
		if !ok || pane == "" || state == "" {
			continue
		}
		out[pane] = state
	}
	return out
}

// fingerprintExcluding renders states without the given pane. The shared map
// is never mutated — Evaluate renders one view per entry from the same input.
// An empty pane id excludes nothing (the unresolved-target case).
func fingerprintExcluding(states map[string]string, pane string) string {
	if pane == "" {
		return Fingerprint(states)
	}
	if _, present := states[pane]; !present {
		return Fingerprint(states)
	}
	view := make(map[string]string, len(states))
	for k, v := range states {
		if k != pane {
			view[k] = v
		}
	}
	return Fingerprint(view)
}

// fingerprintExcludingSet renders states without any pane in exclude — the
// loop entry's view, which drops every run-window pane. The shared map is
// never mutated.
func fingerprintExcludingSet(states map[string]string, exclude map[string]bool) string {
	if len(exclude) == 0 {
		return Fingerprint(states)
	}
	view := make(map[string]string, len(states))
	for k, v := range states {
		if !exclude[k] {
			view[k] = v
		}
	}
	return Fingerprint(view)
}

// actionableTransition reports whether a pane moving from prev to cur (cur ""
// = the pane vanished) needs the wake target's attention. `active` is the one
// state an agent enters on its own without needing anyone; every other value
// — including states this package does not know — fails open toward firing.
func actionableTransition(prev, cur string) bool {
	if prev == cur {
		return false
	}
	return cur != tmux.AgentStateActive
}

// classifyDiff reports whether any pane in the union of two fingerprints
// underwent an actionable transition.
func classifyDiff(prevFP, curFP string) bool {
	prev := parseFingerprint(prevFP)
	cur := parseFingerprint(curFP)
	for pane, state := range cur {
		if actionableTransition(prev[pane], state) {
			return true
		}
	}
	for pane, state := range prev {
		if _, still := cur[pane]; !still && actionableTransition(state, "") {
			return true
		}
	}
	return false
}

// wakeEdge applies the delta-vs-cursor rule for one wake_on entry.
//
//   - no prior observation (cold start): no edge; seed the cursor.
//   - fingerprint unchanged: no edge; keep the observation.
//   - changed, but no actionable transition (only `→ active`): no edge; the
//     cursor ADVANCES so the same transition is never re-judged.
//   - changed and actionable, but now − lastDelivery < debounce: HOLD (no
//     fire) and keep the old observation — the edge stays pending and fires on
//     a later tick once the entry's own delivery is far enough behind.
//   - changed and actionable, past the hold: fire; the cursor advances.
//
// hasDelivery=false (the entry never fired) means no hold. Classification runs
// before the hold check so an ignored-only diff advances regardless.
//
// Returns the edge, the entry's next observation, and a diagnostic reason
// ("", "wake-cold-start", "wake-ignored-transition", or "wake-debounced").
func wakeEdge(debounce time.Duration, fp string, obs WakeObservation, hasObs bool,
	lastDelivery time.Time, hasDelivery bool, now time.Time) (edge bool, next WakeObservation, diag string) {
	if !hasObs {
		return false, WakeObservation{Fingerprint: fp, ObservedAt: now.Unix()}, "wake-cold-start"
	}
	if obs.Fingerprint == fp {
		return false, obs, ""
	}
	advanced := WakeObservation{Fingerprint: fp, ObservedAt: now.Unix()}
	if !classifyDiff(obs.Fingerprint, fp) {
		return false, advanced, "wake-ignored-transition"
	}
	if hasDelivery && now.Sub(lastDelivery) < debounce {
		return false, obs, "wake-debounced"
	}
	return true, advanced, ""
}

// ReadWakeCursor reads the cursor tolerantly: absent or corrupt ⇒ cold start
// (zero cursor, false).
func ReadWakeCursor(path string) (WakeCursor, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return WakeCursor{}, false
		}
		return WakeCursor{}, false
	}
	var c WakeCursor
	if err := yaml.Unmarshal(data, &c); err != nil {
		return WakeCursor{}, false
	}
	if len(c.Entries) == 0 {
		return WakeCursor{}, false
	}
	return c, true
}

// WriteWakeCursor persists the cursor atomically.
func WriteWakeCursor(path string, c WakeCursor) error {
	out, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	return fsatomic.WriteFile(path, out, fileMode)
}
