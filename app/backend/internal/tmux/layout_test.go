package tmux

import (
	"context"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestParseLayoutSessions(t *testing.T) {
	tests := []struct {
		name  string
		lines []string
		want  []LayoutSession
	}{
		{
			name: "basic sessions with and without color",
			lines: []string{
				"kit\t1750000000\t4",
				"utils\t1750000100\t",
			},
			want: []LayoutSession{
				{Name: "kit", Created: 1750000000, Color: "4"},
				{Name: "utils", Created: 1750000100, Color: ""},
			},
		},
		{
			name: "pin/iso sessions and control anchor filtered",
			lines: []string{
				"_rk-pin-42\t1750000000\t",
				"_rk-iso-9\t1750000000\t",
				"_rk-ctl\t1750000001\t",
				"real\t1750000002\t1+3",
			},
			want: []LayoutSession{
				{Name: "real", Created: 1750000002, Color: "1+3"},
			},
		},
		{
			name: "malformed lines skipped",
			lines: []string{
				"short\t123",           // too few fields
				"bad\tnot-a-ts\t",      // non-integer created
				"\t1750000000\t",       // empty name
				"ok\t1750000003\tblue", // valid
			},
			want: []LayoutSession{
				{Name: "ok", Created: 1750000003, Color: "blue"},
			},
		},
		{
			name:  "empty input",
			lines: nil,
			want:  nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseLayoutSessions(tt.lines)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseLayoutSessions() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

// layoutLine builds a layout-capture line with every field placed explicitly:
// rk_layout as the last fixed-prefix field, then the MaxWebTabs web slots,
// their MaxWebTabs parallel roots, then web_active, code_root, marker, role,
// flair, owner, the note (strict single field), and the legacy note appended
// LAST.
func layoutLine(session, id, index, name, active, layout, color, rkLayout, webActive, codeRoot, marker, role, flair, owner, note, legacyNote string, tabs, roots []string) string {
	fields := []string{session, id, index, name, active, layout, color, rkLayout}
	var slots, slotRoots [MaxWebTabs]string
	copy(slots[:], tabs)
	copy(slotRoots[:], roots)
	for _, s := range slots {
		fields = append(fields, s)
	}
	for _, r := range slotRoots {
		fields = append(fields, r)
	}
	fields = append(fields, webActive, codeRoot, marker, role, flair, owner, note)
	return strings.Join(fields, listDelim) + listDelim + legacyNote
}

// fullLayoutLine pads a partial fixture line to the full current-format
// length — the real format always emits every field, and a shorter line
// parses as a pre-16-slot legacy capture (legacyWebTabSlots).
func fullLayoutLine(fields []string) string {
	for len(fields) < layoutWindowFullFields {
		fields = append(fields, "")
	}
	return strings.Join(fields, listDelim)
}

func TestParseLayoutWindows(t *testing.T) {
	// lineThroughMarker builds a full line with only the marker trailing field
	// set — role/flair/note empty, exercising the optional trailing fields.
	lineThroughMarker := func(marker string) string {
		fields := make([]string, layoutWindowMarkerField+1)
		copy(fields, []string{"kit", "@1", "1", "serve", "1", "d5d2,204x48,0,0,1", "4"})
		fields[layoutWindowMarkerField] = marker
		return fullLayoutLine(fields)
	}
	// lineThroughNote builds a full line with only the note trailing field set.
	lineThroughNote := func(note string) string {
		fields := make([]string, layoutWindowNoteField+1)
		copy(fields, []string{"kit", "@1", "1", "serve", "1", "d5d2,204x48,0,0,1"})
		fields[layoutWindowNoteField] = note
		return fullLayoutLine(fields)
	}
	// lineThroughOwner builds a full line with only the owner trailing field set.
	lineThroughOwner := func(owner string) string {
		fields := make([]string, layoutWindowOwnerField+1)
		copy(fields, []string{"kit", "@1", "1", "serve", "1", "d5d2,204x48,0,0,1"})
		fields[layoutWindowOwnerField] = owner
		return fullLayoutLine(fields)
	}

	tests := []struct {
		name  string
		lines []string
		want  []LayoutWindow
	}{
		{
			name: "windows with options and active flag",
			lines: []string{
				layoutLine("kit", "@1", "1", "serve", "1", "d5d2,204x48,0,0,1", "4", "split-h:tty,web", "1", "", "solid", "operator", "", "operator", "", "",
					[]string{"http://x"}, nil),
				"kit\t@2\t2\tshell\t0\tabcd,204x48,0,0,2\t\t\t\t",
			},
			want: []LayoutWindow{
				{Session: "kit", WindowID: "@1", Index: 1, Name: "serve", Active: true,
					Layout: "d5d2,204x48,0,0,1", Color: "4", RkLayout: "split-h:tty,web",
					WebTabs: []string{"http://x"}, WebRoots: []string{""}, WebActive: 1,
					Marker: "manual:1", Role: "operator", Owner: "operator"},
				{Session: "kit", WindowID: "@2", Index: 2, Name: "shell", Active: false,
					Layout: "abcd,204x48,0,0,2"},
			},
		},
		{
			name: "web family with roots and active index",
			lines: []string{
				layoutLine("kit", "@1", "1", "serve", "1", "d5d2,204x48,0,0,1", "", "", "2", "", "", "", "", "", "", "",
					[]string{"/proxy/3000/", "/present/@1/2/a.html?server=s&v=1", "https://x/"},
					[]string{"/r1", "", "/r3"}),
			},
			want: []LayoutWindow{
				{Session: "kit", WindowID: "@1", Index: 1, Name: "serve", Active: true,
					Layout:   "d5d2,204x48,0,0,1",
					WebTabs:  []string{"/proxy/3000/", "/present/@1/2/a.html?server=s&v=1", "https://x/"},
					WebRoots: []string{"/r1", "", "/r3"}, WebActive: 2},
			},
		},
		{
			name: "gap truncates to the dense prefix, active clamps",
			lines: []string{
				layoutLine("kit", "@1", "1", "serve", "1", "d5d2,204x48,0,0,1", "", "", "3", "", "", "", "", "", "", "",
					[]string{"/proxy/3000/", "", "https://x/"}, nil),
			},
			want: []LayoutWindow{
				{Session: "kit", WindowID: "@1", Index: 1, Name: "serve", Active: true,
					Layout:  "d5d2,204x48,0,0,1",
					WebTabs: []string{"/proxy/3000/"}, WebRoots: []string{""}, WebActive: 1},
			},
		},
		{
			name: "line without a role field leaves Role empty",
			lines: []string{
				lineThroughMarker("solid"),
			},
			want: []LayoutWindow{
				{Session: "kit", WindowID: "@1", Index: 1, Name: "serve", Active: true,
					Layout: "d5d2,204x48,0,0,1", Color: "4", Marker: "manual:1"},
			},
		},
		{
			name: "owner field captured, unknown value rides verbatim",
			lines: []string{
				lineThroughOwner("operator"),
			},
			want: []LayoutWindow{
				{Session: "kit", WindowID: "@1", Index: 1, Name: "serve", Active: true,
					Layout: "d5d2,204x48,0,0,1", Owner: "operator"},
			},
		},
		{
			name: "new note in its strict single field, verbatim",
			lines: []string{
				lineThroughNote("1756036800:blocked on flaky e2e"),
			},
			want: []LayoutWindow{
				{Session: "kit", WindowID: "@1", Index: 1, Name: "serve", Active: true,
					Layout: "d5d2,204x48,0,0,1", Note: "1756036800:blocked on flaky e2e"},
			},
		},
		{
			name: "pin/iso link rows skipped, home row kept once",
			lines: []string{
				"_rk-pin-7\t@7\t0\tpinned\t1\tllll,1x1,0,0,7\t\t\t\t",
				"_rk-iso-7\t@7\t0\tpinned\t1\tllll,1x1,0,0,7\t\t\t\t",
				"home\t@7\t3\tpinned\t0\tllll,1x1,0,0,7\t\t\t\t",
				"home\t@7\t3\tpinned\t0\tllll,1x1,0,0,7\t\t\t\t", // duplicate id
			},
			want: []LayoutWindow{
				{Session: "home", WindowID: "@7", Index: 3, Name: "pinned",
					Layout: "llll,1x1,0,0,7"},
			},
		},
		{
			name: "malformed lines skipped",
			lines: []string{
				"kit\t@9\tnot-an-index\tx\t0\tl\t\t\t\t",
				"kit\tnot-a-window-id\t1\tx\t0\tl\t\t\t\t",
				"kit\t@9\t1\tx\t0", // too few fields
			},
			want: nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseLayoutWindows(tt.lines)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseLayoutWindows() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

// TestParseLayoutWindowsNoteDualRead pins the prefer-new fallback for the note
// dual-read pair (@rk_win_note↔@rk_note) in parseLayoutWindows — same rule as
// parseWindows: legacy-only values report, new-only values report, and when
// BOTH fields carry a value the NEW name wins. The legacy note tail rejoin
// survives tabs.
func TestParseLayoutWindowsNoteDualRead(t *testing.T) {
	tests := []struct {
		name                string
		newNote, legacyNote string
		wantNote            string
	}{
		{
			name:       "legacy-only (pre-rename writer)",
			legacyNote: "123:old",
			wantNote:   "123:old",
		},
		{
			name:     "new-only",
			newNote:  "456:new",
			wantNote: "456:new",
		},
		{
			name:       "both — new wins",
			newNote:    "456:new",
			legacyNote: "123:old",
			wantNote:   "456:new",
		},
		{
			name:       "legacy note with tabs rejoins the tail",
			legacyNote: "123:two\tpart\tnote",
			wantNote:   "123:two\tpart\tnote",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			line := layoutLine("kit", "@1", "1", "serve", "1", "d5d2,204x48,0,0,1",
				"", "", "", "", "", "", "", "", tt.newNote, tt.legacyNote, nil, nil)
			got := parseLayoutWindows([]string{line})
			if len(got) != 1 {
				t.Fatalf("parseLayoutWindows() returned %d windows, want 1", len(got))
			}
			if got[0].Note != tt.wantNote {
				t.Errorf("Note = %q, want %q", got[0].Note, tt.wantNote)
			}
		})
	}
}

// TestParseLayoutWindowsFullWebFamily pins the post-slot field offsets: a line
// with every URL slot AND every root slot populated, plus a distinct value in
// every trailing field, must land each field in its own struct member.
func TestParseLayoutWindowsFullWebFamily(t *testing.T) {
	tabs := make([]string, MaxWebTabs)
	roots := make([]string, MaxWebTabs)
	for i := range tabs {
		tabs[i] = "/proxy/" + strconv.Itoa(4000+i) + "/"
		roots[i] = "/r" + strconv.Itoa(i+1)
	}
	line := layoutLine("kit", "@1", "1", "serve", "1", "d5d2,204x48,0,0,1", "4", "split-h:tty,web",
		"9", "/work/repo", "manual:2", "operator", "nyan", "operator", "1756036800:full line", "", tabs, roots)

	got := parseLayoutWindows([]string{line})
	if len(got) != 1 {
		t.Fatalf("parseLayoutWindows() returned %d windows, want 1", len(got))
	}
	w := got[0]
	if !reflect.DeepEqual(w.WebTabs, tabs) {
		t.Errorf("WebTabs = %v, want %v", w.WebTabs, tabs)
	}
	if !reflect.DeepEqual(w.WebRoots, roots) {
		t.Errorf("WebRoots = %v, want %v", w.WebRoots, roots)
	}
	if w.WebActive != 9 {
		t.Errorf("WebActive = %d, want 9", w.WebActive)
	}
	if w.CodeRoot != "/work/repo" {
		t.Errorf("CodeRoot = %q, want /work/repo", w.CodeRoot)
	}
	if w.Marker != "manual:2" {
		t.Errorf("Marker = %q, want manual:2", w.Marker)
	}
	if w.Role != "operator" {
		t.Errorf("Role = %q, want operator", w.Role)
	}
	if w.Flair != "nyan" {
		t.Errorf("Flair = %q, want nyan", w.Flair)
	}
	if w.Owner != "operator" {
		t.Errorf("Owner = %q, want operator", w.Owner)
	}
	if w.Note != "1756036800:full line" {
		t.Errorf("Note = %q, want the verbatim strict single field", w.Note)
	}

	// The legacy note fills in only when the new note field is empty, its
	// free-text tail rejoined across embedded tabs.
	legacy := layoutLine("kit", "@2", "2", "docs", "0", "abcd,204x48,0,0,2", "", "",
		"1", "", "", "", "", "", "", "123:two\tpart\tnote", tabs[:1], roots[:1])
	got = parseLayoutWindows([]string{legacy})
	if len(got) != 1 {
		t.Fatalf("parseLayoutWindows() returned %d windows, want 1", len(got))
	}
	if got[0].Note != "123:two\tpart\tnote" {
		t.Errorf("Note = %q, want the rejoined legacy tail", got[0].Note)
	}
	if !reflect.DeepEqual(got[0].WebTabs, tabs[:1]) || !reflect.DeepEqual(got[0].WebRoots, roots[:1]) {
		t.Errorf("WebTabs/WebRoots = %v/%v, want the single populated slot pair", got[0].WebTabs, got[0].WebRoots)
	}
}

// TestParseLayoutWindowsShortLineTolerance: a capture line from the
// pre-16-slot format (8 URL slots, 8 roots, trailing fields at the old
// offsets) parses with the legacy offsets — the slots and roots it carries
// survive and the fields the shorter line never carried read empty.
func TestParseLayoutWindowsShortLineTolerance(t *testing.T) {
	fields := []string{
		"kit", "@1", "1", "serve", "1", "d5d2,204x48,0,0,1", "4", "split-h:tty,web",
		"/proxy/3000/", "https://x/", "", "", "", "", "", "", // the 8-slot-era URL slots
		"/r1", "", "", "", "", "", "", "", // the 8-slot-era roots
		"", "", "", "", "", "", // web_active .. note
		"", // legacy note
	}
	got := parseLayoutWindows([]string{strings.Join(fields, listDelim)})
	if len(got) != 1 {
		t.Fatalf("parseLayoutWindows() returned %d windows, want 1", len(got))
	}
	w := got[0]
	if !reflect.DeepEqual(w.WebTabs, []string{"/proxy/3000/", "https://x/"}) {
		t.Errorf("WebTabs = %v, want the two populated slots", w.WebTabs)
	}
	if !reflect.DeepEqual(w.WebRoots, []string{"/r1", ""}) {
		t.Errorf("WebRoots = %v, want the legacy root block parallel to the tabs", w.WebRoots)
	}
	if w.WebActive != 1 {
		t.Errorf("WebActive = %d, want 1 (absent active clamps with tabs present)", w.WebActive)
	}
	if w.CodeRoot != "" || w.Marker != "" || w.Role != "" || w.Flair != "" || w.Owner != "" || w.Note != "" {
		t.Errorf("trailing fields = %q/%q/%q/%q/%q/%q, want all empty on a short line",
			w.CodeRoot, w.Marker, w.Role, w.Flair, w.Owner, w.Note)
	}
	if w.Color != "4" || w.RkLayout != "split-h:tty,web" {
		t.Errorf("Color/RkLayout = %q/%q, want 4/split-h:tty,web", w.Color, w.RkLayout)
	}
}

// TestParseLayoutWindowsDenseLegacyLine: a pre-16-slot capture with EVERY URL
// and root slot populated parses at the legacy offsets — the root block must
// not misread as extra URL slots, and the trailing fields land where the old
// format put them.
func TestParseLayoutWindowsDenseLegacyLine(t *testing.T) {
	fields := []string{
		"kit", "@1", "1", "serve", "1", "d5d2,204x48,0,0,1", "4", "split-h:tty,web",
	}
	tabs := []string{"/p/1/", "/p/2/", "/p/3/", "/p/4/", "/p/5/", "/p/6/", "/p/7/", "/p/8/"}
	roots := []string{"/r1", "/r2", "/r3", "/r4", "/r5", "/r6", "/r7", "/r8"}
	fields = append(fields, tabs...)
	fields = append(fields, roots...)
	// The 8-slot-era trailing fields at the old offsets, then the legacy note.
	fields = append(fields, "3", "/code", "solid", "operator", "nyan", "operator", "1700000001:n", "123:legacy")
	got := parseLayoutWindows([]string{strings.Join(fields, listDelim)})
	if len(got) != 1 {
		t.Fatalf("parseLayoutWindows() returned %d windows, want 1", len(got))
	}
	w := got[0]
	if !reflect.DeepEqual(w.WebTabs, tabs) {
		t.Errorf("WebTabs = %v, want the 8 legacy URL slots (roots must not leak in)", w.WebTabs)
	}
	if !reflect.DeepEqual(w.WebRoots, roots) {
		t.Errorf("WebRoots = %v, want %v", w.WebRoots, roots)
	}
	if w.WebActive != 3 {
		t.Errorf("WebActive = %d, want 3", w.WebActive)
	}
	if w.CodeRoot != "/code" || w.Marker != "manual:1" || w.Role != "operator" ||
		w.Flair != "nyan" || w.Owner != "operator" || w.Note != "1700000001:n" {
		t.Errorf("trailing = %q/%q/%q/%q/%q/%q, want the legacy offsets' values",
			w.CodeRoot, w.Marker, w.Role, w.Flair, w.Owner, w.Note)
	}
}

func TestParseLayoutPanes(t *testing.T) {
	lines := []string{
		"@1\t%0\t0\t/home/u/proj\tzsh\t1",
		"@1\t%1\t1\t/home/u/proj/sub\tclaude\t0",
		"@2\t%2\t0\t/tmp\tbash\t1",
		"@2\t%2\t0\t/tmp\tbash\t1",        // duplicate pane id collapses
		"@3\t%3\tnot-an-index\t/x\tsh\t0", // malformed index skipped
		"bad\t%4\t0\t/x\tsh\t0",           // invalid window id skipped
		"@3\t\t0\t/x\tsh\t0",              // empty pane id skipped
		"@3\t%5\t0",                       // too few fields
	}
	got := parseLayoutPanes(lines)
	want := map[string][]LayoutPane{
		"@1": {
			{WindowID: "@1", PaneID: "%0", Index: 0, Cwd: "/home/u/proj", Command: "zsh", Active: true},
			{WindowID: "@1", PaneID: "%1", Index: 1, Cwd: "/home/u/proj/sub", Command: "claude", Active: false},
		},
		"@2": {
			{WindowID: "@2", PaneID: "%2", Index: 0, Cwd: "/tmp", Command: "bash", Active: true},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseLayoutPanes() = %+v, want %+v", got, want)
	}

	if parseLayoutPanes(nil) != nil {
		t.Error("parseLayoutPanes(nil) should return nil")
	}
}

func TestListLayoutSessionsDeadServerErrors(t *testing.T) {
	// A never-started socket name: the layout read MUST return an error (a
	// capture racing server death must never read as "empty server"). Unlike
	// ListSessions, the dead-server case is NOT mapped to (nil, nil).
	ctx := t.Context()
	if _, err := ListLayoutSessions(ctx, "rk-test-layout-dead-sock"); err == nil {
		t.Fatal("ListLayoutSessions on a dead socket: want error, got nil")
	} else if !IsServerGone(err) {
		t.Fatalf("ListLayoutSessions dead-socket error not classified by IsServerGone: %v", err)
	}
	if _, err := ListLayoutWindows(ctx, "rk-test-layout-dead-sock"); err == nil {
		t.Fatal("ListLayoutWindows on a dead socket: want error, got nil")
	}
	if _, err := ListLayoutPanes(ctx, "rk-test-layout-dead-sock"); err == nil {
		t.Fatal("ListLayoutPanes on a dead socket: want error, got nil")
	}
}

func TestBuildRestoreSessionArgs(t *testing.T) {
	got := buildRestoreSessionArgs("kit", "serve", "/home/u/proj")
	// configArgs() may prepend ["-f", path]; assert on the tail.
	tail := got[len(got)-11:]
	want := []string{"new-session", "-d", "-P", "-F", "#{window_id}\t#{window_index}", "-s", "kit", "-n", "serve", "-c", "/home/u/proj"}
	if !reflect.DeepEqual(tail, want) {
		t.Errorf("buildRestoreSessionArgs tail = %v, want %v", tail, want)
	}

	// Empty windowName and cwd omit -n / -c entirely.
	got = buildRestoreSessionArgs("kit", "", "")
	tail = got[len(got)-7:]
	want = []string{"new-session", "-d", "-P", "-F", "#{window_id}\t#{window_index}", "-s", "kit"}
	if !reflect.DeepEqual(tail, want) {
		t.Errorf("buildRestoreSessionArgs(no name/cwd) tail = %v, want %v", tail, want)
	}
}

func TestBuildRestoreWindowArgs(t *testing.T) {
	got := buildRestoreWindowArgs("kit", 3, "agent", "/tmp/w")
	want := []string{"new-window", "-d", "-P", "-F", "#{window_id}", "-t", "=kit:3", "-n", "agent", "-c", "/tmp/w"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("buildRestoreWindowArgs = %v, want %v", got, want)
	}

	// Missing cwd (deleted worktree fallback) omits -c; empty name omits -n.
	got = buildRestoreWindowArgs("kit", 5, "", "")
	want = []string{"new-window", "-d", "-P", "-F", "#{window_id}", "-t", "=kit:5"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("buildRestoreWindowArgs(no name/cwd) = %v, want %v", got, want)
	}
}

// TestCreateSessionForRestore_BirthStampsManaged proves the birth branch of
// the provenance stamp: the first restore invocation on a fresh socket births
// the server (and applies the managed conf via -f), so the newborn must read
// managed.
func TestCreateSessionForRestore_BirthStampsManaged(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	server := testSocketName("unit")
	t.Cleanup(func() {
		killCtx, cancelKill := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelKill()
		_ = exec.CommandContext(killCtx, "tmux", "-L", server, "kill-server").Run()
	})

	if _, _, err := CreateSessionForRestore("restored", "", "", server); err != nil {
		t.Fatalf("CreateSessionForRestore: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got, err := IsManagedServer(ctx, server)
	if err != nil {
		t.Fatalf("IsManagedServer after restore birth: %v", err)
	}
	if !got {
		t.Error("got false, want true (a server this restore birthed must be stamped managed)")
	}
}

// TestCreateSessionForRestore_ExistingServerNotStamped proves the non-birth
// branch: restoring into an already-live (unmarked) server writes no stamp.
func TestCreateSessionForRestore_ExistingServerNotStamped(t *testing.T) {
	// Boot the server WITHOUT going through CreateSessionForRestore, so it is
	// live but carries no ManagedOption mark.
	server := withSessionOrderTmux(t)

	if _, _, err := CreateSessionForRestore("restored", "", "", server); err != nil {
		t.Fatalf("CreateSessionForRestore on live server: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got, err := IsManagedServer(ctx, server)
	if err != nil {
		t.Fatalf("IsManagedServer on unmarked live server: %v", err)
	}
	if got {
		t.Error("got true, want false (restore into an existing server writes no stamp)")
	}
}
