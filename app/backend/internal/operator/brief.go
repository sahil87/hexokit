package operator

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	// BriefSizeCap is the hard ceiling of a rendered brief, in bytes. A run's
	// brief rides one argv word and execve rejects a single word over 128 KiB.
	BriefSizeCap = 100 << 10
	// briefNotesShown is the most notes shown per affected item.
	briefNotesShown = 10
	// briefValueCap bounds one rendered scope/last value, in runes.
	briefValueCap = 500

	briefRoleLine = "You are a one-shot operator run. Act on what changed, write a note, exit."
	// BriefTruncationMarker is the last line of a brief that was trimmed to
	// fit BriefSizeCap.
	BriefTruncationMarker = "[brief truncated to fit the size cap: other tracked items and older notes omitted]"

	briefNoChangedLine = "nothing flagged — manual render"
	briefGoneState     = "gone"
	briefNoReasons     = "no reason given"
	briefSep           = " · "

	// briefServerFlag is the placeholder the embedded run text carries where a
	// command takes its explicit tmux server; the renderer substitutes it.
	briefServerFlag = "-L <server>"
)

//go:embed brief_rules.md
var briefRules string

//go:embed brief_autopilot.md
var briefAutopilot string

const briefExitContract = `Before exiting, append at least one note per item you acted on, or one note on the
most relevant item when nothing needed doing:

    rk operator track note -L <server> <id> "<text>" --by run

Then print exactly one final line to stdout, and nothing after it:

    outcome: <one-line summary>`

// ChangedItem is one item a run was woken for, with the reasons it was
// flagged. It is independent of how the check produced it.
type ChangedItem struct {
	ID      string
	Reasons []string
}

// BriefInput is everything the renderer reads: the loaded state, the server
// label and render time for the header, and the changed items. The renderer
// spawns nothing and writes nothing.
type BriefInput struct {
	State   *State
	Server  string
	Now     time.Time
	Changed []ChangedItem
}

// briefLayout is one rendering pass's trim settings.
type briefLayout struct {
	showOthers bool
	notesShown int
}

// RenderBrief renders the run brief as Markdown. For identical input the
// output is byte-identical. Past BriefSizeCap it drops the other-items lines,
// then shows fewer notes per affected item, and ends with
// BriefTruncationMarker; the header, What changed, Rules, Interim autopilot
// and Exit contract are never dropped.
func RenderBrief(in BriefInput) string {
	layout := briefLayout{showOthers: true, notesShown: briefNotesShown}
	out := renderBriefLayout(in, layout)
	if len(out) <= BriefSizeCap {
		return out
	}
	layout.showOthers = false
	for {
		out = renderBriefLayout(in, layout) + BriefTruncationMarker + "\n"
		if len(out) <= BriefSizeCap || layout.notesShown == 0 {
			return out
		}
		layout.notesShown--
	}
}

func renderBriefLayout(in BriefInput, layout briefLayout) string {
	items := briefItems(in.State)
	now := in.Now.UTC()
	affected := affectedSet(items, in.Changed)

	var b strings.Builder
	writeBriefHeader(&b, in)
	writeWhatChanged(&b, items, in.Changed)
	writeAffected(&b, items, affected, now, layout.notesShown)
	writeOthers(&b, items, affected, now, layout.showOthers)
	flag := "-L " + ServerLabel(in.Server)
	writeSection(&b, "Rules", withServerFlag(briefRules, flag))
	writeSection(&b, "Interim autopilot", withServerFlag(briefAutopilot, flag))
	writeSection(&b, "Exit contract", withServerFlag(briefExitContract, flag))
	return b.String()
}

func withServerFlag(text, flag string) string {
	return strings.ReplaceAll(text, briefServerFlag, flag)
}

func briefItems(st *State) []TrackedItem {
	if st == nil {
		return nil
	}
	return st.Tracked
}

func writeBriefHeader(b *strings.Builder, in BriefInput) {
	fmt.Fprintf(b, "# Operator run brief\n\n- server: %s\n- rendered: %s\n\n%s\n\n",
		ServerLabel(in.Server), in.Now.UTC().Format(time.RFC3339), briefRoleLine)
}

func writeSection(b *strings.Builder, title, body string) {
	fmt.Fprintf(b, "## %s\n\n%s\n\n", title, strings.TrimRight(body, "\n"))
}

func writeWhatChanged(b *strings.Builder, items []TrackedItem, changed []ChangedItem) {
	b.WriteString("## What changed\n\n")
	if len(changed) == 0 {
		b.WriteString(briefNoChangedLine + "\n\n")
		return
	}
	for _, c := range changed {
		kind := briefGoneState
		if i := indexOf(items, c.ID); i >= 0 {
			kind = items[i].Kind
		}
		row := []string{c.ID, kind}
		if len(c.Reasons) > 0 {
			row = append(row, strings.Join(c.Reasons, "; "))
		} else if kind != briefGoneState {
			row = append(row, briefNoReasons)
		}
		b.WriteString("- " + strings.Join(row, briefSep) + "\n")
	}
	b.WriteString("\n")
}

// affectedSet returns the ids of the changed items present in the state plus
// their direct dependency neighbours in both directions.
func affectedSet(items []TrackedItem, changed []ChangedItem) map[string]bool {
	changedIDs := map[string]bool{}
	for _, c := range changed {
		if indexOf(items, c.ID) >= 0 {
			changedIDs[c.ID] = true
		}
	}
	affected := map[string]bool{}
	for _, it := range items {
		if changedIDs[it.ID] {
			affected[it.ID] = true
			for _, dep := range it.DependsOn {
				affected[dep] = true
			}
			continue
		}
		for _, dep := range it.DependsOn {
			if changedIDs[dep] {
				affected[it.ID] = true
			}
		}
	}
	return affected
}

func writeAffected(b *strings.Builder, items []TrackedItem, affected map[string]bool, now time.Time, notesShown int) {
	b.WriteString("## Affected items\n\n")
	wrote := false
	for _, it := range items {
		if !affected[it.ID] {
			continue
		}
		writeItemBlock(b, items, it, now, notesShown)
		wrote = true
	}
	if !wrote {
		b.WriteString("none\n\n")
	}
}

func writeItemBlock(b *strings.Builder, items []TrackedItem, it TrackedItem, now time.Time, notesShown int) {
	fmt.Fprintf(b, "### %s (%s)\n\n", it.ID, it.Kind)
	fmt.Fprintf(b, "- state: %s\n", listState(items, it, now))
	fmt.Fprintf(b, "- probe: %s\n", it.Probe.Mode)
	fmt.Fprintf(b, "- check_every: %s\n", briefOptional(it.CheckEvery))
	fmt.Fprintf(b, "- done_when: %s\n", briefOptional(it.DoneWhen))
	fmt.Fprintf(b, "- then: %s\n", briefOptional(it.Then))
	fmt.Fprintf(b, "- depends_on: %s\n", briefList(it.DependsOn))
	fmt.Fprintf(b, "- scope: %s\n", briefMap(it.Scope, true))
	fmt.Fprintf(b, "- last: %s\n", briefMap(it.Last, false))
	fmt.Fprintf(b, "- unchanged: %d\n", it.Unchanged)
	writeNotes(b, it.Notes, notesShown)
	b.WriteString("\n")
}

func writeNotes(b *strings.Builder, notes []Note, notesShown int) {
	if len(notes) == 0 {
		b.WriteString("- notes: none\n")
		return
	}
	b.WriteString("- notes:\n")
	shown := notes
	if len(notes) > notesShown {
		shown = notes[len(notes)-notesShown:]
		fmt.Fprintf(b, "  (+%d earlier notes)\n", len(notes)-notesShown)
	}
	for _, n := range shown {
		text := strings.ReplaceAll(n.Text, "\n", "\n    ")
		fmt.Fprintf(b, "  - %s%s%s%s%s\n", n.At, briefSep, n.By, briefSep, text)
	}
}

func writeOthers(b *strings.Builder, items []TrackedItem, affected map[string]bool, now time.Time, show bool) {
	b.WriteString("## Other tracked items\n\n")
	if !show {
		b.WriteString("omitted\n\n")
		return
	}
	wrote := false
	for _, it := range items {
		if affected[it.ID] {
			continue
		}
		fmt.Fprintf(b, "- %s%s%s%s%s\n", it.ID, briefSep, it.Kind, briefSep, listState(items, it, now))
		wrote = true
	}
	if !wrote {
		b.WriteString("none\n")
	}
	b.WriteString("\n")
}

func briefOptional(s *string) string {
	if s == nil || *s == "" {
		return "—"
	}
	return *s
}

func briefList(ss []string) string {
	if len(ss) == 0 {
		return "—"
	}
	return strings.Join(ss, ", ")
}

// briefMap renders a scope or last map as sorted `key: value` pairs. Scope
// shows only non-null keys; last shows every key.
func briefMap(m map[string]interface{}, skipNull bool) string {
	keys := make([]string, 0, len(m))
	for k, v := range m {
		if skipNull && v == nil {
			continue
		}
		keys = append(keys, k)
	}
	if len(keys) == 0 {
		return "—"
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + ": " + briefValue(m[k])
	}
	return strings.Join(parts, ", ")
}

func briefValue(v interface{}) string {
	raw, err := json.Marshal(v)
	s := string(raw)
	if err != nil {
		s = fmt.Sprintf("%v", v)
	}
	if r := []rune(s); len(r) > briefValueCap {
		s = string(r[:briefValueCap]) + "…"
	}
	return s
}
