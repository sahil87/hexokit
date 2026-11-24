package operator

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
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

	briefRoleLine = "You are a one-shot operator run. Act on what changed, note what you did, exit."
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

const briefExitContract = `Before exiting, append a note on each item you acted on:

    rk operator track note -L <server> <id> "<text>" --by run

A run that did nothing writes no note. The one exception is an item listed with a ` + "`failed <at>`" + ` reason: an earlier run failed on it and it was offered again. Note it either way — ` + "`retried after failure: <what you found or did>`" + ` — even when nothing needed doing; until a run note follows the failure note, the item stays flagged.

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
	// Queue holds the autopilot queue entry of each queue item by id. The
	// ledger projection of a queue item carries no queue marker, so this is
	// the brief's only statement that an item is engine queue work.
	Queue map[string]QueueEntry
}

// QueueEntry is an autopilot queue item's entry as the engine file holds it:
// what was asked (a raw task or an existing change) and where it stops.
type QueueEntry struct {
	Task      string
	Change    string
	StopStage string
	MergeMode string
	// Plain marks a task run as a plain agent (no fab pipeline) even in a fab
	// repo; Base is the branch it starts from and its PR targets.
	Plain bool
	Base  string
}

// briefLayout is one rendering pass's trim settings.
type briefLayout struct {
	showOthers bool
	notesShown int
	// userNotesDropped is how many of an item's oldest by-user/by-chat notes the
	// size-cap trim has discarded, applied only once notesShown is zero.
	userNotesDropped int
}

// RenderBrief renders the run brief as Markdown. For identical input the
// output is byte-identical. Past BriefSizeCap it drops the other-items lines,
// then shows fewer run notes per affected item, then drops the oldest user and
// chat notes, and ends with BriefTruncationMarker; the header, What changed,
// Rules and Exit contract are never dropped.
func RenderBrief(in BriefInput) string {
	layout := briefLayout{showOthers: true, notesShown: briefNotesShown}
	out := renderBriefLayout(in, layout)
	if len(out) <= BriefSizeCap {
		return out
	}
	layout.showOthers = false
	for {
		out = renderBriefLayout(in, layout) + BriefTruncationMarker + "\n"
		if len(out) <= BriefSizeCap {
			return out
		}
		switch {
		case layout.notesShown > 0:
			layout.notesShown--
		case layout.userNotesDropped < maxUserNotes(in):
			layout.userNotesDropped++
		default:
			return out
		}
	}
}

// maxUserNotes is the most by-user/by-chat notes any one item carries: the
// bound on how far the trim's final pass can go.
func maxUserNotes(in BriefInput) int {
	most := 0
	for _, it := range briefItems(in.State) {
		count := 0
		for _, n := range it.Notes {
			if n.By == ByUser || n.By == ByChat {
				count++
			}
		}
		most = max(most, count)
	}
	return most
}

func renderBriefLayout(in BriefInput, layout briefLayout) string {
	items := briefItems(in.State)
	now := in.Now.UTC()
	affected := affectedSet(items, in.Changed)

	var b strings.Builder
	writeBriefHeader(&b, in)
	writeWhatChanged(&b, items, in.Changed)
	writeAffected(&b, items, affected, in.Queue, now, layout)
	writeOthers(&b, items, affected, now, layout.showOthers)
	flag := "-L " + ServerLabel(in.Server)
	writeSection(&b, "Rules", withServerFlag(briefRules, flag))
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

func writeAffected(b *strings.Builder, items []TrackedItem, affected map[string]bool, queue map[string]QueueEntry, now time.Time, layout briefLayout) {
	b.WriteString("## Affected items\n\n")
	wrote := false
	for _, it := range items {
		if !affected[it.ID] {
			continue
		}
		entry, inQueue := queue[it.ID]
		writeItemBlock(b, items, it, entry, inQueue, now, layout)
		wrote = true
	}
	if !wrote {
		b.WriteString("none\n\n")
	}
}

func writeItemBlock(b *strings.Builder, items []TrackedItem, it TrackedItem, entry QueueEntry, inQueue bool, now time.Time, layout briefLayout) {
	fmt.Fprintf(b, "### %s (%s)\n\n", it.ID, it.Kind)
	if inQueue {
		fmt.Fprintf(b, "- queue: %s\n", briefQueueEntry(entry))
	}
	fmt.Fprintf(b, "- state: %s\n", listState(items, it, now))
	fmt.Fprintf(b, "- probe: %s\n", it.Probe.Mode)
	fmt.Fprintf(b, "- check_every: %s\n", briefOptional(it.CheckEvery))
	fmt.Fprintf(b, "- done_when: %s\n", briefOptional(it.DoneWhen))
	fmt.Fprintf(b, "- then: %s\n", briefOptional(it.Then))
	fmt.Fprintf(b, "- depends_on: %s\n", briefList(it.DependsOn))
	scope := it.Scope
	memo, _ := scope[ScopeMemo].(map[string]interface{})
	if memo != nil {
		scope = make(map[string]interface{}, len(it.Scope))
		for k, v := range it.Scope {
			if k != ScopeMemo {
				scope[k] = v
			}
		}
	}
	fmt.Fprintf(b, "- scope: %s\n", briefMap(scope, true))
	if len(memo) > 0 {
		fmt.Fprintf(b, "- memo: %s\n", briefMap(memo, true))
	}
	fmt.Fprintf(b, "- last: %s\n", briefMap(it.Last, false))
	fmt.Fprintf(b, "- unchanged: %d\n", it.Unchanged)
	writeNotes(b, it.Notes, layout)
	b.WriteString("\n")
}

// briefQueueEntry renders a queue entry as one line: mode, stop stage, the
// plain and base markers when set, and the task (quoted) or change it was
// queued with.
func briefQueueEntry(e QueueEntry) string {
	mode := e.MergeMode
	if mode == "" {
		mode = "cherry-pick-ladder"
	}
	stop := e.StopStage
	if stop == "" {
		stop = "null"
	}
	line := fmt.Sprintf("mode %s; stop_stage %s", mode, stop)
	if e.Plain {
		line += "; plain"
	}
	if e.Base != "" {
		line += "; base " + e.Base
	}
	switch {
	case e.Task != "":
		line += "; task " + strconv.Quote(e.Task)
	case e.Change != "":
		line += "; change " + e.Change
	default:
		line += "; bare agent"
	}
	return line
}

// writeNotes shows the newest layout.notesShown notes plus every older
// by-user/by-chat note (the user's instructions), oldest first. The earlier
// count covers only the omitted notes.
func writeNotes(b *strings.Builder, notes []Note, layout briefLayout) {
	if len(notes) == 0 {
		b.WriteString("- notes: none\n")
		return
	}
	b.WriteString("- notes:\n")
	cut := max(len(notes)-layout.notesShown, 0)
	dropUser := 0
	if layout.notesShown == 0 {
		dropUser = layout.userNotesDropped
	}
	var shown []Note
	for i, n := range notes {
		if i >= cut {
			shown = append(shown, n)
			continue
		}
		if n.By != ByUser && n.By != ByChat {
			continue
		}
		if dropUser > 0 {
			dropUser--
			continue
		}
		shown = append(shown, n)
	}
	if omitted := len(notes) - len(shown); omitted > 0 {
		fmt.Fprintf(b, "  (+%d earlier notes)\n", omitted)
	}
	for _, n := range shown {
		text := strings.ReplaceAll(n.Text, "\n", "\n    ")
		fmt.Fprintf(b, "  - %s%s%s%s%s\n", n.At, briefSep, n.By, briefSep, text)
	}
}

// ItemBlock renders one item's brief block with every note, for the verb that
// re-reads a single item. all is the whole ledger the item's state derives from.
// The block carries no queue line: the verb reads the ledger only, and queue
// membership is the engine file's fact (the run brief's block shows it).
func ItemBlock(all []TrackedItem, it TrackedItem) string {
	var b strings.Builder
	writeItemBlock(&b, all, it, QueueEntry{}, false, clock().UTC(), briefLayout{notesShown: len(it.Notes)})
	return b.String()
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
