package tmux

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Helper to build a tab-delimited tmux line.
func sessionLine(name, grouped, group string) string {
	return strings.Join([]string{name, grouped, group, "0"}, listDelim)
}

// TestCheckDelimited pins the sanitized-output guard: lines that tmux ≥ 3.7
// emitted to a non-UTF-8 client (every tab rewritten to '_') are an error,
// while healthy, empty, and partially healthy output pass — the guard fires
// only when NO line carries a delimiter.
func TestCheckDelimited(t *testing.T) {
	sanitized := []string{"_rk-ctl_0__0_1__$1_/Users/x", "main_0__0_3__$2_/Users/x"}
	if err := checkDelimited(sanitized); !errors.Is(err, ErrNoFieldDelimiter) {
		t.Fatalf("sanitized lines: err = %v, want ErrNoFieldDelimiter", err)
	}
	healthy := []string{sessionLine("_rk-ctl", "0", ""), sessionLine("main", "0", "")}
	if err := checkDelimited(healthy); err != nil {
		t.Fatalf("healthy lines: err = %v, want nil", err)
	}
	if err := checkDelimited(nil); err != nil {
		t.Fatalf("empty output: err = %v, want nil", err)
	}
	mixed := []string{"_rk-ctl_0__0", sessionLine("main", "0", "")}
	if err := checkDelimited(mixed); err != nil {
		t.Fatalf("mixed lines: err = %v, want nil", err)
	}
}

func sessionLineGrouped(name, grouped, group string, groupSize int) string {
	return strings.Join([]string{name, grouped, group, strconv.Itoa(groupSize)}, listDelim)
}

func sessionLineColor(name, grouped, group, color string) string {
	return strings.Join([]string{name, grouped, group, "0", color}, listDelim)
}

// sessionLineWindows builds a full 6-field line including the trailing
// #{session_windows} count (@rk_win_color left empty).
func sessionLineWindows(name, grouped, group string, groupSize, windows int) string {
	return strings.Join([]string{name, grouped, group, strconv.Itoa(groupSize), "", strconv.Itoa(windows)}, listDelim)
}

func strPtr(s string) *string { return &s }

func windowLine(windowID string, index int, name, path string, activityTs int64, active int, paneCmd string) string {
	return fmt.Sprintf("%s%s%d%s%s%s%s%s%d%s%d%s%s%s",
		windowID, listDelim, index, listDelim, name, listDelim, path, listDelim, activityTs, listDelim, active, listDelim, paneCmd, listDelim)
}

func windowLineColor(windowID string, index int, name, path string, activityTs int64, active int, paneCmd string, color string) string {
	return fmt.Sprintf("%s%s%d%s%s%s%s%s%d%s%d%s%s%s%s",
		windowID, listDelim, index, listDelim, name, listDelim, path, listDelim, activityTs, listDelim, active, listDelim, paneCmd, listDelim, color)
}

// windowLineLayout builds a 10-field tab-delimited tmux line including color,
// @rk_win_layout and the first @rk_win_web_<n> slot.
func windowLineLayout(windowID string, index int, name, path string, activityTs int64, active int, paneCmd, layout, web1 string) string {
	return fmt.Sprintf("%s%s%d%s%s%s%s%s%d%s%d%s%s%s%s%s%s%s%s",
		windowID, listDelim, index, listDelim, name, listDelim, path, listDelim, activityTs, listDelim, active, listDelim, paneCmd, listDelim, "" /*@rk_win_color*/, listDelim, layout, listDelim, web1)
}

// emptyWebSlotFields pads a window-line fixture with MaxWebTabs empty
// @rk_win_web_<n> slots — the positional padding between @rk_win_layout and
// @rk_win_web_active in the ListWindows format.
func emptyWebSlotFields() []string { return make([]string, MaxWebTabs) }

// fullWindowLine pads a partial fixture line to the full current-format
// length — the real format always emits every field, and a shorter line
// parses as a pre-16-slot legacy capture (legacyWebTabSlots).
func fullWindowLine(fields []string) string {
	for len(fields) < listWindowsFullFields {
		fields = append(fields, "")
	}
	return strings.Join(fields, listDelim)
}

// windowLineMarker builds a tab-delimited tmux line including the trailing
// @rk_win_marker field (@rk_win_color/@rk_win_layout, the web slots,
// @rk_win_web_active and @rk_win_code_root left empty).
func windowLineMarker(windowID string, index int, name, path string, activityTs int64, active int, paneCmd, marker string) string {
	fields := []string{
		windowID, strconv.Itoa(index), name, path, strconv.FormatInt(activityTs, 10),
		strconv.Itoa(active), paneCmd,
		"", // @rk_win_color
		"", // @rk_win_layout
	}
	fields = append(fields, emptyWebSlotFields()...)
	return fullWindowLine(append(fields,
		"",     // @rk_win_web_active
		"",     // @rk_win_code_root
		marker, // @rk_win_marker
	))
}

func TestParseSessions(t *testing.T) {
	tests := []struct {
		name  string
		lines []string
		want  []SessionInfo
	}{
		{
			name: "standard sessions with session_grouped=0",
			lines: []string{
				sessionLine("alpha", "0", "alpha"),
				sessionLine("beta", "0", "beta"),
			},
			want: []SessionInfo{{Name: "alpha"}, {Name: "beta"}},
		},
		{
			name: "filters out session-group copies (grouped=1, name != group, size > 1)",
			lines: []string{
				sessionLineGrouped("devshell", "1", "devshell", 2),
				sessionLineGrouped("devshell-82", "1", "devshell", 2),
			},
			want: []SessionInfo{{Name: "devshell"}},
		},
		{
			name: "keeps group-named session (grouped=1, name == group)",
			lines: []string{
				sessionLineGrouped("mygroup", "1", "mygroup", 1),
			},
			want: []SessionInfo{{Name: "mygroup"}},
		},
		{
			name: "keeps sole group member after rename (grouped=1, name != group, size == 1)",
			lines: []string{
				sessionLine("other", "0", "other"),
				sessionLineGrouped("run-kit-lane", "1", "run-kit-lanes", 1),
			},
			want: []SessionInfo{{Name: "other"}, {Name: "run-kit-lane"}},
		},
		{
			name: "renamed leader in multi-member group — first member kept as representative",
			lines: []string{
				sessionLineGrouped("shell", "1", "devshell", 2),
				sessionLineGrouped("devshell-82", "1", "devshell", 2),
			},
			want: []SessionInfo{{Name: "shell"}},
		},
		{
			name: "renamed leader in 3-member group — only first member kept",
			lines: []string{
				sessionLineGrouped("renamed", "1", "original", 3),
				sessionLineGrouped("original-1", "1", "original", 3),
				sessionLineGrouped("original-2", "1", "original", 3),
			},
			want: []SessionInfo{{Name: "renamed"}},
		},
		{
			name: "two independent groups — one with renamed leader, one normal",
			lines: []string{
				sessionLineGrouped("alpha", "1", "alpha", 2),
				sessionLineGrouped("alpha-copy", "1", "alpha", 2),
				sessionLineGrouped("new-beta", "1", "beta", 2),
				sessionLineGrouped("beta-copy", "1", "beta", 2),
			},
			want: []SessionInfo{{Name: "alpha"}, {Name: "new-beta"}},
		},
		{
			name: "group with leader plus ungrouped sessions — only leader kept from group",
			lines: []string{
				sessionLine("standalone", "0", ""),
				sessionLineGrouped("grp", "1", "grp", 2),
				sessionLineGrouped("grp-copy", "1", "grp", 2),
			},
			want: []SessionInfo{{Name: "standalone"}, {Name: "grp"}},
		},
		{
			name: "sole group member with color preserved after rename",
			lines: []string{
				strings.Join([]string{"renamed-sess", "1", "old-sess", "1", "7"}, listDelim),
			},
			want: []SessionInfo{{Name: "renamed-sess", Color: strPtr("7")}},
		},
		{
			name:  "empty input returns nil",
			lines: nil,
			want:  nil,
		},
		{
			name:  "empty slice returns nil",
			lines: []string{},
			want:  nil,
		},
		{
			name: "malformed line with fewer than 2 fields is skipped",
			lines: []string{
				"onlyname",
				sessionLine("good", "0", "good"),
			},
			want: []SessionInfo{{Name: "good"}},
		},
		{
			name: "ungrouped session with no session_group field (2 fields only)",
			lines: []string{
				"mysession\t0",
			},
			want: []SessionInfo{{Name: "mysession"}},
		},
		{
			name: "multiple session-group copies filtered, original kept",
			lines: []string{
				sessionLineGrouped("proj", "1", "proj", 3),
				sessionLineGrouped("proj-1", "1", "proj", 3),
				sessionLineGrouped("proj-2", "1", "proj", 3),
			},
			want: []SessionInfo{{Name: "proj"}},
		},
		{
			name: "mixed grouped and ungrouped sessions",
			lines: []string{
				sessionLine("alpha", "0", "alpha"),
				sessionLineGrouped("beta", "1", "beta", 2),
				sessionLineGrouped("beta-N", "1", "beta", 2),
				sessionLine("gamma", "0", "gamma"),
			},
			want: []SessionInfo{{Name: "alpha"}, {Name: "beta"}, {Name: "gamma"}},
		},
		{
			name: "session with @rk_win_color set",
			lines: []string{
				sessionLineColor("alpha", "0", "alpha", "4"),
				sessionLineColor("beta", "0", "beta", ""),
			},
			want: []SessionInfo{{Name: "alpha", Color: strPtr("4")}, {Name: "beta"}},
		},
		{
			name: "filters _rk-pin-* board pin-sessions from user-facing list",
			lines: []string{
				sessionLine("agent", "0", "agent"),
				sessionLine("_rk-pin-42", "0", "_rk-pin-42"),
				sessionLine("dev", "0", "dev"),
			},
			want: []SessionInfo{{Name: "agent"}, {Name: "dev"}},
		},
		{
			name: "filters _rk-iso-* isolated relay sessions from user-facing list",
			lines: []string{
				sessionLine("agent", "0", "agent"),
				sessionLine("_rk-iso-42", "0", "_rk-iso-42"),
				sessionLine("dev", "0", "dev"),
			},
			want: []SessionInfo{{Name: "agent"}, {Name: "dev"}},
		},
		{
			name: "_rk-pin-* exclusion still allows group leaders to be kept",
			lines: []string{
				sessionLineGrouped("devshell", "1", "devshell", 2),
				sessionLineGrouped("devshell-82", "1", "devshell", 2),
				sessionLine("_rk-pin-7", "0", "_rk-pin-7"),
			},
			want: []SessionInfo{{Name: "devshell"}},
		},
		{
			name: "relay ephemerals are no longer filtered (relay layer removed)",
			lines: []string{
				sessionLine("rk-relay-deadbeef", "0", "rk-relay-deadbeef"),
				sessionLine("dev", "0", "dev"),
			},
			want: []SessionInfo{{Name: "rk-relay-deadbeef"}, {Name: "dev"}},
		},
		{
			name: "only _rk-pin-* sessions present returns nil",
			lines: []string{
				sessionLine("_rk-pin-1", "0", "_rk-pin-1"),
				sessionLine("_rk-pin-2", "0", "_rk-pin-2"),
			},
			want: nil,
		},
		{
			name: "6-field line parses session_windows count",
			lines: []string{
				sessionLineWindows("alpha", "0", "alpha", 0, 5),
				sessionLineWindows("beta", "0", "beta", 0, 1),
			},
			want: []SessionInfo{{Name: "alpha", Windows: 5}, {Name: "beta", Windows: 1}},
		},
		{
			name: "missing windows field (5-field line) defaults to 0",
			lines: []string{
				sessionLineColor("alpha", "0", "alpha", "4"),
			},
			want: []SessionInfo{{Name: "alpha", Color: strPtr("4")}},
		},
		{
			name: "group-copy filtering keeps the leader's windows only",
			lines: []string{
				sessionLineWindows("proj", "1", "proj", 3, 4),
				sessionLineWindows("proj-1", "1", "proj", 3, 4),
				sessionLineWindows("proj-2", "1", "proj", 3, 4),
			},
			want: []SessionInfo{{Name: "proj", Windows: 4}},
		},
		{
			name: "malformed windows field parses as 0",
			lines: []string{
				strings.Join([]string{"alpha", "0", "alpha", "0", "", "not-a-number"}, listDelim),
			},
			want: []SessionInfo{{Name: "alpha"}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseSessions(tt.lines)
			if !sessionInfoSliceEqual(got, tt.want) {
				t.Errorf("parseSessions() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestParseSessionsMultiServer(t *testing.T) {
	// Simulate merging results from both servers as ListSessions does.
	runkitLines := []string{
		sessionLine("alpha", "0", "alpha"),
		sessionLine("beta", "0", "beta"),
	}
	defaultLines := []string{
		sessionLine("gamma", "0", "gamma"),
	}

	runkitSessions := parseSessions(runkitLines)
	defaultSessions := parseSessions(defaultLines)
	all := append(runkitSessions, defaultSessions...)

	want := []SessionInfo{
		{Name: "alpha"},
		{Name: "beta"},
		{Name: "gamma"},
	}

	if !sessionInfoSliceEqual(all, want) {
		t.Errorf("multi-server merge = %v, want %v", all, want)
	}
}

func TestParseWindows(t *testing.T) {
	const fakeNow int64 = 1700000000

	tests := []struct {
		name  string
		lines []string
		now   int64
		want  []WindowInfo
	}{
		{
			name: "marks window as active when within threshold",
			lines: []string{
				windowLine("@0", 0, "dev", "/home/user/project", fakeNow-1, 1, "claude"),
			},
			now: fakeNow,
			want: []WindowInfo{
				{Index: 0, WindowID: "@0", Name: "dev", WorktreePath: "/home/user/project", Activity: "active", IsActiveWindow: true, PaneCommand: "claude", ActivityTimestamp: fakeNow - 1},
			},
		},
		{
			name: "marks window as idle when beyond threshold",
			lines: []string{
				windowLine("@1", 0, "dev", "/home/user/project", fakeNow-ActivityThresholdSeconds-100, 0, "zsh"),
			},
			now: fakeNow,
			want: []WindowInfo{
				{Index: 0, WindowID: "@1", Name: "dev", WorktreePath: "/home/user/project", Activity: "idle", IsActiveWindow: false, PaneCommand: "zsh", ActivityTimestamp: fakeNow - ActivityThresholdSeconds - 100},
			},
		},
		{
			name: "parses all fields correctly including isActiveWindow and paneCommand",
			lines: []string{
				windowLine("@0", 0, "dev", "/home/user/project", fakeNow, 1, "claude"),
				windowLine("@2", 2, "build", "/tmp/build", fakeNow, 0, "make"),
			},
			now: fakeNow,
			want: []WindowInfo{
				{Index: 0, WindowID: "@0", Name: "dev", WorktreePath: "/home/user/project", Activity: "active", IsActiveWindow: true, PaneCommand: "claude", ActivityTimestamp: fakeNow},
				{Index: 2, WindowID: "@2", Name: "build", WorktreePath: "/tmp/build", Activity: "active", IsActiveWindow: false, PaneCommand: "make", ActivityTimestamp: fakeNow},
			},
		},
		{
			name:  "empty input returns nil",
			lines: nil,
			now:   fakeNow,
			want:  nil,
		},
		{
			name: "malformed line with fewer than 8 fields is skipped",
			lines: []string{
				"@0\t0\tdev\t/path\t1700000000\t1\tzsh",
				windowLine("@1", 1, "good", "/home/user", fakeNow, 1, "zsh"),
			},
			now: fakeNow,
			want: []WindowInfo{
				{Index: 1, WindowID: "@1", Name: "good", WorktreePath: "/home/user", Activity: "active", IsActiveWindow: true, PaneCommand: "zsh", ActivityTimestamp: fakeNow},
			},
		},
		{
			name: "activity exactly at threshold boundary is active",
			lines: []string{
				windowLine("@0", 0, "edge", "/path", fakeNow-ActivityThresholdSeconds, 0, "bash"),
			},
			now: fakeNow,
			want: []WindowInfo{
				{Index: 0, WindowID: "@0", Name: "edge", WorktreePath: "/path", Activity: "active", IsActiveWindow: false, PaneCommand: "bash", ActivityTimestamp: fakeNow - ActivityThresholdSeconds},
			},
		},
		{
			name: "activity one second past threshold is idle",
			lines: []string{
				windowLine("@0", 0, "past", "/path", fakeNow-ActivityThresholdSeconds-1, 0, "vim"),
			},
			now: fakeNow,
			want: []WindowInfo{
				{Index: 0, WindowID: "@0", Name: "past", WorktreePath: "/path", Activity: "idle", IsActiveWindow: false, PaneCommand: "vim", ActivityTimestamp: fakeNow - ActivityThresholdSeconds - 1},
			},
		},
		{
			name: "paneCommand populated from 7th field",
			lines: []string{
				windowLine("@0", 0, "work", "/home/user/code", fakeNow, 1, "node"),
			},
			now: fakeNow,
			want: []WindowInfo{
				{Index: 0, WindowID: "@0", Name: "work", WorktreePath: "/home/user/code", Activity: "active", IsActiveWindow: true, PaneCommand: "node", ActivityTimestamp: fakeNow},
			},
		},
		{
			name: "activityTimestamp exposed as raw unix epoch",
			lines: []string{
				windowLine("@0", 0, "ts", "/path", 1710300000, 0, "zsh"),
			},
			now: 1710300100,
			want: []WindowInfo{
				{Index: 0, WindowID: "@0", Name: "ts", WorktreePath: "/path", Activity: "idle", IsActiveWindow: false, PaneCommand: "zsh", ActivityTimestamp: 1710300000},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseWindows(tt.lines, tt.now)
			if tt.want == nil {
				if got != nil {
					t.Errorf("parseWindows() = %v, want nil", got)
				}
				return
			}
			if len(got) != len(tt.want) {
				t.Fatalf("parseWindows() returned %d windows, want %d", len(got), len(tt.want))
			}
			for i := range got {
				if got[i].WindowID != tt.want[i].WindowID {
					t.Errorf("window[%d].WindowID = %q, want %q", i, got[i].WindowID, tt.want[i].WindowID)
				}
				if got[i].Index != tt.want[i].Index {
					t.Errorf("window[%d].Index = %d, want %d", i, got[i].Index, tt.want[i].Index)
				}
				if got[i].Name != tt.want[i].Name {
					t.Errorf("window[%d].Name = %q, want %q", i, got[i].Name, tt.want[i].Name)
				}
				if got[i].WorktreePath != tt.want[i].WorktreePath {
					t.Errorf("window[%d].WorktreePath = %q, want %q", i, got[i].WorktreePath, tt.want[i].WorktreePath)
				}
				if got[i].Activity != tt.want[i].Activity {
					t.Errorf("window[%d].Activity = %q, want %q", i, got[i].Activity, tt.want[i].Activity)
				}
				if got[i].IsActiveWindow != tt.want[i].IsActiveWindow {
					t.Errorf("window[%d].IsActiveWindow = %v, want %v", i, got[i].IsActiveWindow, tt.want[i].IsActiveWindow)
				}
				if got[i].PaneCommand != tt.want[i].PaneCommand {
					t.Errorf("window[%d].PaneCommand = %q, want %q", i, got[i].PaneCommand, tt.want[i].PaneCommand)
				}
				if got[i].ActivityTimestamp != tt.want[i].ActivityTimestamp {
					t.Errorf("window[%d].ActivityTimestamp = %d, want %d", i, got[i].ActivityTimestamp, tt.want[i].ActivityTimestamp)
				}
			}
		})
	}
}

func TestParseWindowsTrailingEmptyFields(t *testing.T) {
	// Regression test: tmux format output ends with empty fields (e.g., @rk_win_color,
	// @rk_win_layout, the web slots unset). When the last line's trailing tabs are
	// stripped (as strings.TrimSpace does), the field count drops below 8 and the
	// window is silently lost.
	const fakeNow int64 = 1700000000

	// Simulate the real tmux format where @rk_win_color, @rk_win_layout and the
	// first web slot are empty. Each field is tab-separated; empty trailing fields
	// produce trailing tabs.
	fullLine := func(windowID string, index int, name string) string {
		return fmt.Sprintf("%s\t%d\t%s\t/path\t%d\t0\tzsh\t\t\t", windowID, index, name, fakeNow)
	}
	// Damaged line: trailing tabs stripped (simulates old TrimSpace bug on the last line).
	damagedLine := func(windowID string, index int, name string) string {
		return fmt.Sprintf("%s\t%d\t%s\t/path\t%d\t0\tzsh", windowID, index, name, fakeNow)
	}

	t.Run("full trailing tabs parsed correctly", func(t *testing.T) {
		lines := []string{
			fullLine("@0", 0, "first"),
			fullLine("@1", 1, "last"),
		}
		got := parseWindows(lines, fakeNow)
		if len(got) != 2 {
			t.Fatalf("parseWindows() returned %d windows, want 2", len(got))
		}
		if got[1].Name != "last" {
			t.Errorf("window[1].Name = %q, want %q", got[1].Name, "last")
		}
	})

	t.Run("damaged last line drops window", func(t *testing.T) {
		// This demonstrates the bug: the last line has only 7 fields after
		// trailing tabs are stripped, so parseWindows skips it.
		lines := []string{
			fullLine("@0", 0, "first"),
			damagedLine("@1", 1, "last"),
		}
		got := parseWindows(lines, fakeNow)
		if len(got) != 1 {
			t.Fatalf("parseWindows() returned %d windows, want 1 (damaged line dropped)", len(got))
		}
	})
}

func TestParseWindowsWebFamily(t *testing.T) {
	const fakeNow int64 = 1700000000

	tests := []struct {
		name       string
		lines      []string
		wantLayout string
		wantTabs   []string
	}{
		{
			name: "layout and first web slot",
			lines: []string{
				windowLineLayout("@0", 0, "docs", "/home/user", fakeNow, 1, "zsh", "single:web", "http://localhost:8080/docs"),
			},
			wantLayout: "single:web",
			wantTabs:   []string{"http://localhost:8080/docs"},
		},
		{
			name: "terminal window with empty web fields",
			lines: []string{
				windowLineLayout("@0", 0, "dev", "/home/user", fakeNow, 1, "zsh", "", ""),
			},
			wantLayout: "",
			wantTabs:   nil,
		},
		{
			name: "7-field line (old format) has empty web fields",
			lines: []string{
				windowLine("@0", 0, "dev", "/home/user", fakeNow, 1, "zsh"),
			},
			wantLayout: "",
			wantTabs:   nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseWindows(tt.lines, fakeNow)
			if len(got) != 1 {
				t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
			}
			if got[0].Layout != tt.wantLayout {
				t.Errorf("Layout = %q, want %q", got[0].Layout, tt.wantLayout)
			}
			if !reflect.DeepEqual(got[0].WebTabs, tt.wantTabs) {
				t.Errorf("WebTabs = %v, want %v", got[0].WebTabs, tt.wantTabs)
			}
		})
	}
}

// windowLineWeb builds a full-length tab-delimited tmux line with every
// web-family field placed explicitly: layout as the last fixed-prefix field,
// the MaxWebTabs web slots after it (unset slots left empty), then web_active
// and code_root.
func windowLineWeb(layout, webActive, codeRoot string, tabs ...string) string {
	fields := []string{"@0", "0", "a", "/p", "1700000000", "1", "zsh", "", layout}
	var slots [MaxWebTabs]string
	copy(slots[:], tabs)
	for _, s := range slots {
		fields = append(fields, s)
	}
	return fullWindowLine(append(fields, webActive, codeRoot))
}

// TestParseWindowsWebDensity pins the dense-prefix rule and the web_active
// clamp: a hand-written gap truncates the family at the first empty slot
// (never an error), and a non-numeric or out-of-range web_active clamps to 1
// when tabs exist and to 0 when none.
func TestParseWindowsWebDensity(t *testing.T) {
	const fakeNow int64 = 1700000000

	tests := []struct {
		name       string
		line       string
		wantTabs   []string
		wantActive int
	}{
		{
			name:       "gap truncates to the dense prefix",
			line:       windowLineWeb("", "3", "", "/proxy/3000/", "", "https://x/"),
			wantTabs:   []string{"/proxy/3000/"},
			wantActive: 1,
		},
		{
			name:       "no tabs reads active as 0",
			line:       windowLineWeb("", "2", ""),
			wantTabs:   nil,
			wantActive: 0,
		},
		{
			name:       "in-range active is kept",
			line:       windowLineWeb("", "2", "", "/proxy/3000/", "https://x/"),
			wantTabs:   []string{"/proxy/3000/", "https://x/"},
			wantActive: 2,
		},
		{
			name:       "non-numeric active clamps to 1",
			line:       windowLineWeb("", "abc", "", "/proxy/3000/"),
			wantTabs:   []string{"/proxy/3000/"},
			wantActive: 1,
		},
		{
			name:       "out-of-range active clamps to 1",
			line:       windowLineWeb("", "5", "", "/proxy/3000/"),
			wantTabs:   []string{"/proxy/3000/"},
			wantActive: 1,
		},
		{
			name:       "empty active with tabs clamps to 1",
			line:       windowLineWeb("", "", "", "/proxy/3000/"),
			wantTabs:   []string{"/proxy/3000/"},
			wantActive: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseWindows([]string{tt.line}, fakeNow)
			if len(got) != 1 {
				t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
			}
			if !reflect.DeepEqual(got[0].WebTabs, tt.wantTabs) {
				t.Errorf("WebTabs = %v, want %v", got[0].WebTabs, tt.wantTabs)
			}
			if got[0].WebActive != tt.wantActive {
				t.Errorf("WebActive = %d, want %d", got[0].WebActive, tt.wantActive)
			}
		})
	}
}

// TestParseWindowsLayoutAndCodeRoot pins the two non-family fields.
func TestParseWindowsLayoutAndCodeRoot(t *testing.T) {
	const fakeNow int64 = 1700000000

	got := parseWindows([]string{windowLineWeb("split-h:tty,web", "1", "/work/repo", "/proxy/3000/")}, fakeNow)
	if len(got) != 1 {
		t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
	}
	if got[0].Layout != "split-h:tty,web" {
		t.Errorf("Layout = %q, want %q", got[0].Layout, "split-h:tty,web")
	}
	if got[0].CodeRoot != "/work/repo" {
		t.Errorf("CodeRoot = %q, want %q", got[0].CodeRoot, "/work/repo")
	}
}

func TestParseWindowsMixedTypes(t *testing.T) {
	const fakeNow int64 = 1700000000

	lines := []string{
		windowLineLayout("@0", 0, "terminal", "/home/user", fakeNow, 1, "zsh", "", ""),
		windowLineLayout("@1", 1, "docs", "/home/user", fakeNow, 0, "python", "single:web", "http://localhost:8080/docs"),
		windowLineLayout("@2", 2, "shell", "/tmp", fakeNow, 0, "bash", "", ""),
	}

	got := parseWindows(lines, fakeNow)
	if len(got) != 3 {
		t.Fatalf("parseWindows() returned %d windows, want 3", len(got))
	}
	if got[0].Layout != "" {
		t.Errorf("window 0 Layout = %q, want empty", got[0].Layout)
	}
	if got[1].Layout != "single:web" {
		t.Errorf("window 1 Layout = %q, want %q", got[1].Layout, "single:web")
	}
	if !reflect.DeepEqual(got[1].WebTabs, []string{"http://localhost:8080/docs"}) {
		t.Errorf("window 1 WebTabs = %v, want %v", got[1].WebTabs, []string{"http://localhost:8080/docs"})
	}
	if got[2].Layout != "" {
		t.Errorf("window 2 Layout = %q, want empty", got[2].Layout)
	}
}

func TestParseWindowsMarker(t *testing.T) {
	const fakeNow int64 = 1700000000

	tests := []struct {
		name       string
		line       string
		wantMarker string
	}{
		{"current marker", windowLineMarker("@0", 0, "a", "/p", fakeNow, 1, "zsh", "manual:3"), "manual:3"},
		{"legacy marker", windowLineMarker("@0", 0, "a", "/p", fakeNow, 1, "zsh", "hatch"), "blocked:2"},
		{"trimmed legacy marker", windowLineMarker("@0", 0, "a", "/p", fakeNow, 1, "zsh", " hatch "), "blocked:2"},
		{"empty marker", windowLineMarker("@0", 0, "a", "/p", fakeNow, 1, "zsh", ""), ""},
		{"unknown marker dropped to empty", windowLineMarker("@0", 0, "a", "/p", fakeNow, 1, "zsh", "wavy"), ""},
		{"10-field line (no marker field) has empty marker", windowLineLayout("@0", 0, "a", "/p", fakeNow, 1, "zsh", "", ""), ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseWindows([]string{tt.line}, fakeNow)
			if len(got) != 1 {
				t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
			}
			if got[0].Marker != tt.wantMarker {
				t.Errorf("Marker = %q, want %q", got[0].Marker, tt.wantMarker)
			}
		})
	}
}

func TestNormalizeMarker(t *testing.T) {
	// Flat tokens map forward onto the mode × stage model; current tokens and
	// the unset empty string pass through; anything else drops to unset.
	tests := map[string]string{
		"pipe":   "manual:1",
		"dotted": "manual:1",
		"dashed": "manual:1",
		"solid":  "manual:1",
		"double": "manual:2",
		"thick":  "manual:3",
		"hatch":  "blocked:2",
		"block":  "blocked:3",

		"":          "",
		"manual":    "manual",
		"manual:1":  "manual:1",
		"manual:2":  "manual:2",
		"manual:3":  "manual:3",
		"auto":      "auto",
		"auto:1":    "auto:1",
		"auto:2":    "auto:2",
		"auto:3":    "auto:3",
		"blocked":   "blocked",
		"blocked:1": "blocked:1",
		"blocked:2": "blocked:2",
		"blocked:3": "blocked:3",

		"wavy":       "",
		"Manual":     "",
		" manual:1 ": "",
		"manual:4":   "",
		"manual:0":   "",
		"manual:1:2": "",
	}

	for raw, want := range tests {
		if got := NormalizeMarker(raw); got != want {
			t.Errorf("NormalizeMarker(%q) = %q, want %q", raw, got, want)
		}
	}

	// The forward table is consulted BEFORE the membership check, so no input
	// can ever survive as a flat token — the property the read path will rely
	// on, and one an input/output table alone would not catch if the two arms
	// were ever swapped.
	for raw := range tests {
		if _, isLegacy := legacyMarkerValues[NormalizeMarker(raw)]; isLegacy {
			t.Errorf("NormalizeMarker(%q) = %q, want a current-vocabulary token", raw, NormalizeMarker(raw))
		}
	}
}

// windowLineRole builds a tab-delimited tmux line including the trailing
// @rk_win_role field (@rk_win_color/@rk_win_layout, the web slots,
// @rk_win_web_active/@rk_win_code_root and @rk_win_marker left empty).
func windowLineRole(windowID string, index int, name, path string, activityTs int64, active int, paneCmd, role string) string {
	fields := []string{
		windowID, strconv.Itoa(index), name, path, strconv.FormatInt(activityTs, 10),
		strconv.Itoa(active), paneCmd,
		"", // @rk_win_color
		"", // @rk_win_layout
	}
	fields = append(fields, emptyWebSlotFields()...)
	return fullWindowLine(append(fields,
		"",   // @rk_win_web_active
		"",   // @rk_win_code_root
		"",   // @rk_win_marker
		role, // @rk_win_role
	))
}

func TestParseWindowsRole(t *testing.T) {
	const fakeNow int64 = 1700000000

	tests := []struct {
		name     string
		line     string
		wantRole string
	}{
		{"operator role", windowLineRole("@0", 0, "a", "/p", fakeNow, 1, "zsh", "operator"), "operator"},
		{"empty role", windowLineRole("@0", 0, "a", "/p", fakeNow, 1, "zsh", ""), ""},
		{"unknown role dropped to empty", windowLineRole("@0", 0, "a", "/p", fakeNow, 1, "zsh", "manager"), ""},
		{"line without a role field has empty role", windowLineMarker("@0", 0, "a", "/p", fakeNow, 1, "zsh", "solid"), ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseWindows([]string{tt.line}, fakeNow)
			if len(got) != 1 {
				t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
			}
			if got[0].Role != tt.wantRole {
				t.Errorf("Role = %q, want %q", got[0].Role, tt.wantRole)
			}
		})
	}
}

// windowLineFlair builds a tab-delimited tmux line including the trailing
// @rk_win_flair field (@rk_win_color/@rk_win_layout, the web slots,
// @rk_win_web_active/@rk_win_code_root/@rk_win_marker/@rk_win_role left
// empty).
func windowLineFlair(windowID string, index int, name, path string, activityTs int64, active int, paneCmd, flair string) string {
	fields := []string{
		windowID, strconv.Itoa(index), name, path, strconv.FormatInt(activityTs, 10),
		strconv.Itoa(active), paneCmd,
		"", // @rk_win_color
		"", // @rk_win_layout
	}
	fields = append(fields, emptyWebSlotFields()...)
	return fullWindowLine(append(fields,
		"",    // @rk_win_web_active
		"",    // @rk_win_code_root
		"",    // @rk_win_marker
		"",    // @rk_win_role
		flair, // @rk_win_flair
	))
}

func TestParseWindowsFlair(t *testing.T) {
	const fakeNow int64 = 1700000000

	tests := []struct {
		name      string
		line      string
		wantFlair string
	}{
		{"nyan flair", windowLineFlair("@0", 0, "a", "/p", fakeNow, 1, "zsh", "nyan"), "nyan"},
		{"naruto flair", windowLineFlair("@0", 0, "a", "/p", fakeNow, 1, "zsh", "naruto"), "naruto"},
		{"onepiece flair", windowLineFlair("@0", 0, "a", "/p", fakeNow, 1, "zsh", "onepiece"), "onepiece"},
		{"empty flair", windowLineFlair("@0", 0, "a", "/p", fakeNow, 1, "zsh", ""), ""},
		{"unknown flair dropped to empty", windowLineFlair("@0", 0, "a", "/p", fakeNow, 1, "zsh", "pikachu"), ""},
		{"line without a flair field has empty flair", windowLineRole("@0", 0, "a", "/p", fakeNow, 1, "zsh", "operator"), ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseWindows([]string{tt.line}, fakeNow)
			if len(got) != 1 {
				t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
			}
			if got[0].Flair != tt.wantFlair {
				t.Errorf("Flair = %q, want %q", got[0].Flair, tt.wantFlair)
			}
		})
	}
}

// windowLineOwner builds a tab-delimited tmux line including the trailing
// @rk_win_owner field (every presentation field before it left empty).
func windowLineOwner(windowID string, index int, name, path string, activityTs int64, active int, paneCmd, owner string) string {
	fields := []string{
		windowID, strconv.Itoa(index), name, path, strconv.FormatInt(activityTs, 10),
		strconv.Itoa(active), paneCmd,
		"", // @rk_win_color
		"", // @rk_win_layout
	}
	fields = append(fields, emptyWebSlotFields()...)
	return fullWindowLine(append(fields,
		"",    // @rk_win_web_active
		"",    // @rk_win_code_root
		"",    // @rk_win_marker
		"",    // @rk_win_role
		"",    // @rk_win_flair
		owner, // @rk_win_owner
	))
}

func TestParseWindowsOwner(t *testing.T) {
	const fakeNow int64 = 1700000000

	tests := []struct {
		name      string
		line      string
		wantOwner string
	}{
		{"operator owner", windowLineOwner("@0", 0, "a", "/p", fakeNow, 1, "zsh", "operator"), "operator"},
		{"empty owner", windowLineOwner("@0", 0, "a", "/p", fakeNow, 1, "zsh", ""), ""},
		{"unknown owner dropped to empty", windowLineOwner("@0", 0, "a", "/p", fakeNow, 1, "zsh", "bogus"), ""},
		{"line without an owner field has empty owner", windowLineFlair("@0", 0, "a", "/p", fakeNow, 1, "zsh", "nyan"), ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseWindows([]string{tt.line}, fakeNow)
			if len(got) != 1 {
				t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
			}
			if got[0].Owner != tt.wantOwner {
				t.Errorf("Owner = %q, want %q", got[0].Owner, tt.wantOwner)
			}
		})
	}

	// The tail-last invariant: an owner field present AND a legacy note with
	// tabs still rejoins intact. (windowLineOwner pads to the full format
	// length; trim its empty tail so the appended fields land on the
	// pr-listen, note, retired-fallback, and legacy-note positions.)
	line := strings.TrimRight(windowLineOwner("@0", 0, "a", "/p", fakeNow, 1, "zsh", "operator"), listDelim) +
		listDelim + "" + listDelim + "" + listDelim + "" + listDelim + "" + listDelim + "123:two\tpart\tnote"
	got := parseWindows([]string{line}, fakeNow)
	if len(got) != 1 {
		t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
	}
	if got[0].Owner != "operator" {
		t.Errorf("Owner = %q, want operator", got[0].Owner)
	}
	if got[0].Note != "two\tpart\tnote" {
		t.Errorf("Note = %q, want the rejoined legacy tail", got[0].Note)
	}
}

// windowLineNote builds a tab-delimited tmux line whose note rides the NEW
// @rk_win_note field (a strict single field; every presentation field before
// it left empty). The legacy-note tail rejoin is exercised by the dual-read
// test instead.
func windowLineNote(windowID string, index int, name, path string, activityTs int64, active int, paneCmd, note string) string {
	fields := []string{
		windowID, strconv.Itoa(index), name, path, strconv.FormatInt(activityTs, 10),
		strconv.Itoa(active), paneCmd,
		"", // @rk_win_color
		"", // @rk_win_layout
	}
	fields = append(fields, emptyWebSlotFields()...)
	return fullWindowLine(append(fields,
		"",   // @rk_win_web_active
		"",   // @rk_win_code_root
		"",   // @rk_win_marker
		"",   // @rk_win_role
		"",   // @rk_win_flair
		"",   // @rk_win_owner
		"",   // @rk_win_pr_listen
		note, // @rk_win_note (new, strict single field)
	))
}

func TestParseWindowsNote(t *testing.T) {
	const fakeNow int64 = 1700000000

	tests := []struct {
		name      string
		line      string
		wantNote  string
		wantEpoch int64
	}{
		{"epoch-prefixed note", windowLineNote("@0", 0, "a", "/p", fakeNow, 1, "zsh", "1756036800:blocked on flaky e2e"), "blocked on flaky e2e", 1756036800},
		{"bare text degrades to epoch 0", windowLineNote("@0", 0, "a", "/p", fakeNow, 1, "zsh", "just some text"), "just some text", 0},
		{"non-numeric prefix keeps whole value", windowLineNote("@0", 0, "a", "/p", fakeNow, 1, "zsh", "abc:def"), "abc:def", 0},
		{"colon inside text survives SplitN-2", windowLineNote("@0", 0, "a", "/p", fakeNow, 1, "zsh", "1756036800:waiting on review: PR #42"), "waiting on review: PR #42", 1756036800},
		{"empty note field", windowLineNote("@0", 0, "a", "/p", fakeNow, 1, "zsh", ""), "", 0},
		{"line without a note field has empty note", windowLineFlair("@0", 0, "a", "/p", fakeNow, 1, "zsh", "nyan"), "", 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseWindows([]string{tt.line}, fakeNow)
			if len(got) != 1 {
				t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
			}
			if got[0].Note != tt.wantNote {
				t.Errorf("Note = %q, want %q", got[0].Note, tt.wantNote)
			}
			if got[0].NoteEpoch != tt.wantEpoch {
				t.Errorf("NoteEpoch = %d, want %d", got[0].NoteEpoch, tt.wantEpoch)
			}
		})
	}
}

// windowLineNoteDualRead builds a full line (through the legacy-note tail)
// with both halves of the note dual-read pair placed explicitly: the NEW note
// as a strict single field, and the legacy note appended LAST (tail-rejoined,
// so tabs in its text survive). The fields between them are the retired
// @rk_win_url / @rk_win_lens dual-read fallbacks (left empty here).
func windowLineNoteDualRead(newNote, legacyNote string) string {
	fields := []string{
		"@0", "0", "a", "/p", "1700000000", "1", "zsh",
		"", // @rk_win_color
		"", // @rk_win_layout
	}
	fields = append(fields, emptyWebSlotFields()...)
	fields = append(fields,
		"",      // @rk_win_web_active
		"",      // @rk_win_code_root
		"",      // @rk_win_marker
		"",      // @rk_win_role
		"",      // @rk_win_flair
		"",      // @rk_win_owner
		"",      // @rk_win_pr_listen
		newNote, // @rk_win_note (new — strict single field)
		"",      // @rk_win_url (retired dual-read fallback — empty here)
		"",      // @rk_win_lens (retired dual-read fallback — empty here)
	)
	return strings.Join(fields, listDelim) + listDelim + legacyNote
}

// TestParseWindowsNoteDualRead pins the prefer-new fallback for the note
// dual-read pair (@rk_win_note↔@rk_note) in parseWindows: a note stamped only
// by a pre-rename writer keeps reporting through the legacy field, and when
// BOTH fields carry a value the NEW name wins. The legacy note rides the
// format's last column, so tabs inside its text survive the tail rejoin.
func TestParseWindowsNoteDualRead(t *testing.T) {
	tests := []struct {
		name                string
		newNote, legacyNote string
		wantNote            string
		wantEpoch           int64
	}{
		{
			name:       "legacy-only (pre-rename writer)",
			legacyNote: "123:old",
			wantNote:   "old", wantEpoch: 123,
		},
		{
			name:     "new-only",
			newNote:  "456:new",
			wantNote: "new", wantEpoch: 456,
		},
		{
			name:       "both — new wins",
			newNote:    "456:new",
			legacyNote: "123:old",
			wantNote:   "new", wantEpoch: 456,
		},
		{
			name:       "legacy note with tabs rejoins the tail",
			legacyNote: "123:two\tpart\tnote",
			wantNote:   "two\tpart\tnote", wantEpoch: 123,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			line := windowLineNoteDualRead(tt.newNote, tt.legacyNote)
			got := parseWindows([]string{line}, 1700000000)
			if len(got) != 1 {
				t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
			}
			if got[0].Note != tt.wantNote {
				t.Errorf("Note = %q, want %q", got[0].Note, tt.wantNote)
			}
			if got[0].NoteEpoch != tt.wantEpoch {
				t.Errorf("NoteEpoch = %d, want %d", got[0].NoteEpoch, tt.wantEpoch)
			}
		})
	}
}

// windowLineLegacyURL builds a full line with the retired @rk_win_url set to
// legacyURL, the retired @rk_win_lens and legacy note empty, and the indexed
// web slots empty.
func windowLineLegacyURL(legacyURL string) string {
	fields := []string{
		"@0", "0", "a", "/p", "1700000000", "1", "zsh",
		"", // @rk_win_color
		"", // @rk_win_layout
	}
	fields = append(fields, emptyWebSlotFields()...)
	fields = append(fields,
		"",        // @rk_win_web_active
		"",        // @rk_win_code_root
		"",        // @rk_win_marker
		"",        // @rk_win_role
		"",        // @rk_win_flair
		"",        // @rk_win_owner
		"",        // @rk_win_pr_listen
		"",        // @rk_win_note
		legacyURL, // @rk_win_url (retired dual-read fallback)
		"",        // @rk_win_lens (retired dual-read fallback)
		"",        // legacy note (last)
	)
	return strings.Join(fields, listDelim)
}

// TestParseWindowsLegacyLensFallback pins the @rk_win_lens dual-read: with
// @rk_win_layout unset, a live-stamped "iframe" reads as the web-leaf layout;
// any other lens value is ignored, and a present @rk_win_layout always wins.
func TestParseWindowsLegacyLensFallback(t *testing.T) {
	withLens := func(layout, lens string) string {
		parts := strings.Split(windowLineLegacyURL(""), listDelim)
		parts[listWindowsFixedPrefix-1] = layout
		parts[listWindowsLegacyLensField] = lens
		return strings.Join(parts, listDelim)
	}
	cases := []struct {
		name, layout, lens, want string
	}{
		{"iframe with layout unset reads the web leaf", "", "iframe", "web"},
		{"other lens value ignored", "", "terminal", ""},
		{"explicit layout wins over lens", "row:tty,code,web", "iframe", "row:tty,code,web"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseWindows([]string{withLens(tc.layout, tc.lens)}, 1700000000)
			if len(got) != 1 {
				t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
			}
			if got[0].Layout != tc.want {
				t.Errorf("Layout = %q, want %q", got[0].Layout, tc.want)
			}
		})
	}
}

// TestParseWindowsLegacyURLFallback pins the @rk_win_url dual-read: with an
// empty web_1 the retired option surfaces as the dense family's first tab with
// the active pointer defaulted (the shape a first WebAdd produces); a present
// web_1 wins over the retired name.
func TestParseWindowsLegacyURLFallback(t *testing.T) {
	t.Run("empty web_1 falls back to @rk_win_url", func(t *testing.T) {
		got := parseWindows([]string{windowLineLegacyURL("http://localhost:8080/")}, 1700000000)
		if len(got) != 1 {
			t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
		}
		if len(got[0].WebTabs) != 1 || got[0].WebTabs[0] != "http://localhost:8080/" {
			t.Errorf("WebTabs = %v, want [\"http://localhost:8080/\"]", got[0].WebTabs)
		}
		if got[0].WebActive != 1 {
			t.Errorf("WebActive = %d, want 1 (defaulted for the dual-read tab)", got[0].WebActive)
		}
	})
	t.Run("web_1 wins over @rk_win_url", func(t *testing.T) {
		line := windowLineLegacyURL("http://legacy/")
		// Stamp web_1 so the indexed family takes precedence.
		parts := strings.Split(line, listDelim)
		parts[listWindowsFixedPrefix] = "http://indexed/"
		got := parseWindows([]string{strings.Join(parts, listDelim)}, 1700000000)
		if len(got) != 1 {
			t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
		}
		if len(got[0].WebTabs) != 1 || got[0].WebTabs[0] != "http://indexed/" {
			t.Errorf("WebTabs = %v, want [\"http://indexed/\"] (web_1 wins)", got[0].WebTabs)
		}
	})
}

// windowLineFull builds a fully-populated ListWindows-format line: the given
// web slots (up to MaxWebTabs, the rest empty) and every trailing field placed
// explicitly — the parse-side mirror of the format builder, so a field-offset
// drift lands here.
func windowLineFull(webActive, codeRoot, marker, role, flair, owner, prListen, note, legacyURL, legacyLens, legacyNote string, tabs []string) string {
	fields := []string{"@0", "0", "a", "/p", "1700000000", "1", "zsh", "4", "row:tty,web"}
	var slots [MaxWebTabs]string
	copy(slots[:], tabs)
	for _, s := range slots {
		fields = append(fields, s)
	}
	fields = append(fields, webActive, codeRoot, marker, role, flair, owner, prListen, note, legacyURL, legacyLens)
	return strings.Join(fields, listDelim) + listDelim + legacyNote
}

// TestParseWindowsFullWebFamily pins the post-slot field offsets: a line with
// every URL slot populated and a distinct value in every trailing field must
// land each field in its own struct member.
func TestParseWindowsFullWebFamily(t *testing.T) {
	tabs := make([]string, MaxWebTabs)
	for i := range tabs {
		tabs[i] = "/proxy/" + strconv.Itoa(4000+i) + "/"
	}
	line := windowLineFull("9", "/work/repo", "manual:2", "operator", "nyan", "operator", "1",
		"1700000001:full line", "", "", "", tabs)

	got := parseWindows([]string{line}, 1700000000)
	if len(got) != 1 {
		t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
	}
	w := got[0]
	if !reflect.DeepEqual(w.WebTabs, tabs) {
		t.Errorf("WebTabs = %v, want %v", w.WebTabs, tabs)
	}
	if w.WebActive != 9 {
		t.Errorf("WebActive = %d, want 9", w.WebActive)
	}
	if w.Color == nil || *w.Color != "4" {
		t.Errorf("Color = %v, want \"4\"", w.Color)
	}
	if w.Layout != "row:tty,web" {
		t.Errorf("Layout = %q, want row:tty,web", w.Layout)
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
	if !w.PrListen {
		t.Error("PrListen = false, want true")
	}
	if w.Note != "full line" || w.NoteEpoch != 1700000001 {
		t.Errorf("Note = %q (epoch %d), want \"full line\" (1700000001)", w.Note, w.NoteEpoch)
	}

	// The legacy note fills in only when the new note field is empty, its
	// free-text tail rejoined across embedded tabs.
	legacy := windowLineFull("1", "", "", "", "", "", "", "", "", "", "123:two\tpart\tnote", tabs[:1])
	got = parseWindows([]string{legacy}, 1700000000)
	if len(got) != 1 {
		t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
	}
	if got[0].Note != "two\tpart\tnote" || got[0].NoteEpoch != 123 {
		t.Errorf("Note = %q (epoch %d), want the rejoined legacy tail (123)", got[0].Note, got[0].NoteEpoch)
	}
}

// TestParseWindowsPrListen pins the @rk_win_pr_listen fail-closed parse: only
// the exact "1" arms the listener.
func TestParseWindowsPrListen(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want bool
	}{
		{"1", true},
		{" 1 ", true},
		{"", false},
		{"0", false},
		{"true", false},
		{"on", false},
		{"11", false},
	} {
		line := windowLineFull("", "", "", "", "", "", tc.raw, "", "", "", "", nil)
		got := parseWindows([]string{line}, 1700000000)
		if len(got) != 1 {
			t.Fatalf("raw %q: parseWindows() returned %d windows, want 1", tc.raw, len(got))
		}
		if got[0].PrListen != tc.want {
			t.Errorf("raw %q: PrListen = %v, want %v", tc.raw, got[0].PrListen, tc.want)
		}
	}
}

// TestParseWindowsShortLineTolerance: a capture line from the pre-16-slot
// format (8 URL slots, trailing fields at the old offsets) parses without
// error — the slots it carries survive and the fields the shorter line never
// carried read empty.
func TestParseWindowsShortLineTolerance(t *testing.T) {
	fields := []string{
		"@0", "0", "a", "/p", "1700000000", "1", "zsh",
		"4",                                                  // @rk_win_color
		"row:tty",                                            // @rk_win_layout
		"/proxy/3000/", "https://x/", "", "", "", "", "", "", // the 8-slot-era URL slots
		"", "", "", "", "", "", "", "", "", "", // the 8-slot-era trailing fields
	}
	got := parseWindows([]string{strings.Join(fields, listDelim)}, 1700000000)
	if len(got) != 1 {
		t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
	}
	w := got[0]
	if !reflect.DeepEqual(w.WebTabs, []string{"/proxy/3000/", "https://x/"}) {
		t.Errorf("WebTabs = %v, want the two populated slots", w.WebTabs)
	}
	if w.WebActive != 1 {
		t.Errorf("WebActive = %d, want 1 (absent active clamps with tabs present)", w.WebActive)
	}
	if w.CodeRoot != "" || w.Marker != "" || w.Role != "" || w.Flair != "" || w.Owner != "" || w.Note != "" {
		t.Errorf("trailing fields = %q/%q/%q/%q/%q/%q, want all empty on a short line",
			w.CodeRoot, w.Marker, w.Role, w.Flair, w.Owner, w.Note)
	}
	if w.Color == nil || *w.Color != "4" {
		t.Errorf("Color = %v, want \"4\"", w.Color)
	}
	if w.Layout != "row:tty" {
		t.Errorf("Layout = %q, want row:tty", w.Layout)
	}
}

// TestParseWindowsDenseLegacyLine: a pre-16-slot capture with EVERY URL slot
// populated parses at the legacy offsets — web_active and the trailing fields
// immediately after the 8 slots must not be consumed as extra URL slots.
func TestParseWindowsDenseLegacyLine(t *testing.T) {
	tabs := []string{"/p/1/", "/p/2/", "/p/3/", "/p/4/", "/p/5/", "/p/6/", "/p/7/", "/p/8/"}
	fields := []string{
		"@0", "0", "a", "/p", "1700000000", "1", "zsh",
		"4",           // @rk_win_color
		"row:tty,web", // @rk_win_layout
	}
	fields = append(fields, tabs...)
	// The 8-slot-era trailing fields at the old offsets: web_active, code_root,
	// marker, role, flair, owner, note, the retired @rk_win_url and
	// @rk_win_lens, then the legacy note LAST.
	fields = append(fields, "3", "/code", "manual:2", "operator", "nyan", "operator",
		"1700000001:n", "", "", "")
	got := parseWindows([]string{strings.Join(fields, listDelim)}, 1700000000)
	if len(got) != 1 {
		t.Fatalf("parseWindows() returned %d windows, want 1", len(got))
	}
	w := got[0]
	if !reflect.DeepEqual(w.WebTabs, tabs) {
		t.Errorf("WebTabs = %v, want the 8 legacy URL slots (trailing fields must not leak in)", w.WebTabs)
	}
	if w.WebActive != 3 {
		t.Errorf("WebActive = %d, want 3", w.WebActive)
	}
	if w.CodeRoot != "/code" || w.Marker != "manual:2" || w.Role != "operator" ||
		w.Flair != "nyan" || w.Owner != "operator" {
		t.Errorf("trailing = %q/%q/%q/%q/%q, want the legacy offsets' values",
			w.CodeRoot, w.Marker, w.Role, w.Flair, w.Owner)
	}
	if w.Note != "n" || w.NoteEpoch != 1700000001 {
		t.Errorf("Note = %q (epoch %d), want \"n\" (1700000001)", w.Note, w.NoteEpoch)
	}
}

// sessionLineFlair builds a 7-field tab-delimited tmux line including the
// trailing @rk_ses_flair field (@rk_ses_color left empty, windows count 1).
func sessionLineFlair(name, grouped, group, flair string) string {
	return strings.Join([]string{name, grouped, group, "0", "", "1", flair}, listDelim)
}

func TestParseSessionsFlair(t *testing.T) {
	tests := []struct {
		name      string
		line      string
		wantFlair string
	}{
		{"nyan flair", sessionLineFlair("alpha", "0", "alpha", "nyan"), "nyan"},
		{"empty flair", sessionLineFlair("alpha", "0", "alpha", ""), ""},
		{"unknown flair dropped to empty", sessionLineFlair("alpha", "0", "alpha", "pikachu"), ""},
		{"6-field line (no flair field) has empty flair", sessionLineWindows("alpha", "0", "alpha", 0, 1), ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseSessions([]string{tt.line})
			if len(got) != 1 {
				t.Fatalf("parseSessions() returned %d sessions, want 1", len(got))
			}
			if got[0].Flair != tt.wantFlair {
				t.Errorf("Flair = %q, want %q", got[0].Flair, tt.wantFlair)
			}
		})
	}
}

// sessionLineIDPath builds a full 9-field tab-delimited tmux line including
// the trailing #{session_id} and #{session_path} fields.
func sessionLineIDPath(name, grouped, group, id, path string) string {
	return strings.Join([]string{name, grouped, group, "0", "", "1", "", id, path}, listDelim)
}

func TestParseSessionsIDPath(t *testing.T) {
	tests := []struct {
		name     string
		line     string
		wantID   string
		wantPath string
	}{
		{"9-field line parses id and path", sessionLineIDPath("alpha", "0", "alpha", "$4", "/home/user/code/x"), "$4", "/home/user/code/x"},
		{"7-field line (no id/path) leaves both empty", sessionLineFlair("alpha", "0", "alpha", ""), "", ""},
		{"8-field line parses id only", strings.Join([]string{"alpha", "0", "alpha", "0", "", "1", "", "$4"}, listDelim), "$4", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseSessions([]string{tt.line})
			if len(got) != 1 {
				t.Fatalf("parseSessions() returned %d sessions, want 1", len(got))
			}
			if got[0].ID != tt.wantID {
				t.Errorf("ID = %q, want %q", got[0].ID, tt.wantID)
			}
			if got[0].Path != tt.wantPath {
				t.Errorf("Path = %q, want %q", got[0].Path, tt.wantPath)
			}
		})
	}
}

// The operator session is NOT name-skipped in parseSessions — its windows are
// the pinned operator row's only data source (the window is moved, not
// linked), so a parse-level skip would erase the row's data. Hiding is
// content-conditional at the FetchSessions join instead.
func TestParseSessionsKeepsOperatorSession(t *testing.T) {
	line := sessionLineIDPath(OperatorSessionName, "0", OperatorSessionName, "$4", "/home/user")
	got := parseSessions([]string{line})
	if len(got) != 1 {
		t.Fatalf("parseSessions() dropped the operator session, want it kept")
	}
	if got[0].Name != OperatorSessionName {
		t.Errorf("Name = %q, want %q", got[0].Name, OperatorSessionName)
	}
}

func TestHasSessionArgv(t *testing.T) {
	got := hasSessionArgv([]string{"-L", "srv"}, OperatorSessionName)
	want := []string{"-L", "srv", "has-session", "-t", "=_rk-operator:"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("hasSessionArgv() = %v, want %v", got, want)
	}
}

func TestNewDetachedSessionArgv(t *testing.T) {
	got := newDetachedSessionArgv([]string{"-S", "/tmp/x.sock"}, OperatorSessionName, "/home/user")
	want := []string{"-S", "/tmp/x.sock", "new-session", "-d", "-s", "_rk-operator", "-c", "/home/user"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("newDetachedSessionArgv() = %v, want %v", got, want)
	}
}

func TestDemoteDestinationSession(t *testing.T) {
	tests := []struct {
		name     string
		cwd      string
		birthDir string
		want     string
	}{
		{"cwd basename is the destination", "/home/u/code/myproj", "/home/u", "myproj"},
		{"trailing slash still basenames", "/home/u/code/myproj/", "/home/u", "myproj"},
		{"empty cwd falls back to the birth-dir basename", "", "/home/u", "u"},
		{"root cwd falls back to the birth-dir basename", "/", "/home/u", "u"},
		{"a basename invalid as a tmux session name falls back to the birth-dir basename", "/home/u/.config", "/home/u", "u"},
		{"an invalid birth-dir basename degrades to the literal fallback", "", ".", "rk-home"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := demoteDestinationSession(tt.cwd, tt.birthDir); got != tt.want {
				t.Errorf("demoteDestinationSession(%q, %q) = %q, want %q", tt.cwd, tt.birthDir, got, tt.want)
			}
		})
	}
}

func TestRoleCarriersToClear(t *testing.T) {
	tests := []struct {
		name  string
		lines []string
		keep  string
		want  []string
	}{
		{
			"clears every carrier except the target",
			[]string{"@3" + listDelim + "operator", "@7" + listDelim + "", "@9" + listDelim + "operator"},
			"@9",
			[]string{"@3"},
		},
		{
			"zero carriers is a no-op",
			[]string{"@3" + listDelim + "", "@7" + listDelim + ""},
			"@9",
			nil,
		},
		{
			"target already carrying the role is idempotent (not cleared)",
			[]string{"@9" + listDelim + "operator"},
			"@9",
			nil,
		},
		{
			"carriers across sessions on the same server all clear",
			[]string{"@3" + listDelim + "operator", "@5" + listDelim + "operator"},
			"@9",
			[]string{"@3", "@5"},
		},
		{
			"malformed lines are skipped",
			[]string{"", "@3"},
			"@9",
			nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := roleCarriersToClear(tt.lines, tt.keep)
			if len(got) != len(tt.want) {
				t.Fatalf("roleCarriersToClear() = %v, want %v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("roleCarriersToClear()[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// paneLine builds an 11-field tab-delimited list-panes line with empty
// agent-state and agent-session fields on both name generations (the common
// case). Use paneLineAgent to carry a legacy agent state, paneLineAgentSession
// to also carry a legacy (@rk_pane_chat) agent-session value, or paneLineFull
// for full per-generation control.
func paneLine(windowID string, paneID string, paneIndex int, cwd, command string, active int) string {
	return paneLineAgentSession(windowID, paneID, paneIndex, cwd, command, active, "", "")
}

// paneLineAgent builds an 11-field tab-delimited list-panes line carrying the
// agent state in the LEGACY field (6) only, with an empty legacy agent-session
// field.
func paneLineAgent(windowID string, paneID string, paneIndex int, cwd, command string, active int, agentState string) string {
	return paneLineAgentSession(windowID, paneID, paneIndex, cwd, command, active, agentState, "")
}

// paneLineAgentSession builds an 11-field tab-delimited list-panes line
// carrying the agent state in the LEGACY field (6) and the agent session in
// the retired @rk_pane_chat field (9) only, with alternate_on (field 7) pinned
// to "0" (normal screen) and the scope-named successor fields (8/10) empty.
func paneLineAgentSession(windowID string, paneID string, paneIndex int, cwd, command string, active int, agentState, agentSession string) string {
	return paneLineAlt(windowID, paneID, paneIndex, cwd, command, active, agentState, agentSession, "0")
}

// paneLineAlt builds an 11-field tab-delimited list-panes line with an
// explicit alternate_on value (field 7) and empty scope-named successor fields
// (8/10).
func paneLineAlt(windowID string, paneID string, paneIndex int, cwd, command string, active int, agentState, agentSession, alt string) string {
	return paneLineFull(windowID, paneID, paneIndex, cwd, command, active, agentState, agentSession, alt, "", "")
}

// paneLineFull builds a 12-field tab-delimited list-panes line with full
// control over both generations of the agent-state/agent-session fields:
// legacy agent-state at 6, alternate_on at 7, scope-named agent-state at 8,
// the retired @rk_pane_chat at 9, and @rk_pane_agent_session at 10; pane_pid
// (field 11) is pinned to fixturePanePID.
func paneLineFull(windowID string, paneID string, paneIndex int, cwd, command string, active int, agentState, agentSession, alt, newAgentState, newAgentSession string) string {
	return fmt.Sprintf("%s%s%s%s%d%s%s%s%s%s%d%s%s%s%s%s%s%s%s%s%s%s%d",
		windowID, listDelim, paneID, listDelim, paneIndex, listDelim, cwd, listDelim, command, listDelim, active, listDelim, agentState, listDelim, alt, listDelim, newAgentState, listDelim, agentSession, listDelim, newAgentSession, listDelim, fixturePanePID)
}

// fixturePanePID is the pane_pid every paneLine* fixture carries.
const fixturePanePID = 1234

// totalPanes sums the number of panes across all windows in the map.
func totalPanes(byWindow map[string][]PaneInfo) int {
	n := 0
	for _, panes := range byWindow {
		n += len(panes)
	}
	return n
}

func TestParsePanes(t *testing.T) {
	t.Run("empty input returns nil", func(t *testing.T) {
		byWindow := parsePanes(nil)
		if byWindow != nil {
			t.Errorf("parsePanes(nil) byWindow = %v, want nil", byWindow)
		}
	})

	t.Run("empty slice returns nil", func(t *testing.T) {
		byWindow := parsePanes([]string{})
		if byWindow != nil {
			t.Errorf("parsePanes([]) byWindow = %v, want nil", byWindow)
		}
	})

	t.Run("standard parse: single pane", func(t *testing.T) {
		lines := []string{
			paneLine("@0", "%8", 1, "/home/user/code", "zsh", 0),
		}
		byWindow := parsePanes(lines)
		if totalPanes(byWindow) != 1 {
			t.Fatalf("parsePanes() returned %d total panes, want 1", totalPanes(byWindow))
		}
		if byWindow["@0"] == nil || len(byWindow["@0"]) != 1 {
			t.Errorf("byWindow[@0] = %v, want 1 pane", byWindow["@0"])
		}
		p := byWindow["@0"][0]
		if p.PaneID != "%8" {
			t.Errorf("PaneID = %q, want %%8", p.PaneID)
		}
		if p.PaneIndex != 1 {
			t.Errorf("PaneIndex = %d, want 1", p.PaneIndex)
		}
		if p.Cwd != "/home/user/code" {
			t.Errorf("Cwd = %q, want /home/user/code", p.Cwd)
		}
		if p.Command != "zsh" {
			t.Errorf("Command = %q, want zsh", p.Command)
		}
		if p.PanePID != fixturePanePID {
			t.Errorf("PanePID = %d, want %d", p.PanePID, fixturePanePID)
		}
		if p.IsActive {
			t.Errorf("IsActive = true, want false")
		}
	})

	t.Run("active pane flag parsed correctly", func(t *testing.T) {
		lines := []string{
			paneLine("@0", "%5", 0, "/tmp", "bash", 1),
		}
		byWindow := parsePanes(lines)
		if totalPanes(byWindow) != 1 {
			t.Fatalf("expected 1 total pane, got %d", totalPanes(byWindow))
		}
		if !byWindow["@0"][0].IsActive {
			t.Error("IsActive = false, want true")
		}
	})

	t.Run("malformed line with fewer than 6 fields is skipped", func(t *testing.T) {
		lines := []string{
			"0\t%1\t0\t/tmp", // only 4 fields
			paneLine("@1", "%2", 0, "/home/user", "zsh", 0), // valid
		}
		byWindow := parsePanes(lines)
		if totalPanes(byWindow) != 1 {
			t.Fatalf("parsePanes() returned %d total panes, want 1", totalPanes(byWindow))
		}
		if byWindow["@0"] != nil {
			t.Errorf("byWindow[@0] should be nil (malformed line for window 0), got %v", byWindow["@0"])
		}
		if len(byWindow["@1"]) != 1 {
			t.Errorf("byWindow[@1] = %v, want 1 pane", byWindow["@1"])
		}
		if byWindow["@1"][0].PaneID != "%2" {
			t.Errorf("PaneID = %q, want %%2", byWindow["@1"][0].PaneID)
		}
	})

	t.Run("panes grouped by window index", func(t *testing.T) {
		// Window 0: panes %0, %1; Window 1: pane %2
		lines := []string{
			paneLine("@0", "%0", 0, "/tmp/a", "zsh", 1),
			paneLine("@0", "%1", 1, "/tmp/b", "vim", 0),
			paneLine("@1", "%2", 0, "/tmp/c", "bash", 0),
		}
		byWindow := parsePanes(lines)
		if totalPanes(byWindow) != 3 {
			t.Fatalf("parsePanes() returned %d total panes, want 3", totalPanes(byWindow))
		}
		if len(byWindow["@0"]) != 2 {
			t.Errorf("byWindow[@0] = %d panes, want 2", len(byWindow["@0"]))
		}
		if len(byWindow["@1"]) != 1 {
			t.Errorf("byWindow[@1] = %d panes, want 1", len(byWindow["@1"]))
		}
		if byWindow["@0"][0].PaneID != "%0" {
			t.Errorf("byWindow[@0][0].PaneID = %q, want %%0", byWindow["@0"][0].PaneID)
		}
		if byWindow["@0"][1].PaneID != "%1" {
			t.Errorf("byWindow[@0][1].PaneID = %q, want %%1", byWindow["@0"][1].PaneID)
		}
		if byWindow["@1"][0].PaneID != "%2" {
			t.Errorf("byWindow[@1][0].PaneID = %q, want %%2", byWindow["@1"][0].PaneID)
		}
	})

	t.Run("all malformed lines returns nil", func(t *testing.T) {
		lines := []string{"bad", "also\tbad\tonly\tthree"}
		byWindow := parsePanes(lines)
		if byWindow != nil {
			t.Errorf("parsePanes() byWindow = %v, want nil", byWindow)
		}
	})

	t.Run("line with non-window-id first field is skipped", func(t *testing.T) {
		// A bare index (the pre-window-id format) or garbage in field 0 must be
		// dropped, not grouped under a bogus key.
		lines := []string{
			paneLine("0", "%1", 0, "/tmp", "zsh", 0),   // numeric index, not @N
			paneLine("win", "%2", 0, "/tmp", "zsh", 0), // garbage
			paneLine("@3", "%3", 0, "/tmp", "zsh", 0),  // valid
		}
		byWindow := parsePanes(lines)
		if totalPanes(byWindow) != 1 {
			t.Fatalf("parsePanes() returned %d total panes, want 1", totalPanes(byWindow))
		}
		if byWindow["@3"][0].PaneID != "%3" {
			t.Errorf("byWindow[@3][0].PaneID = %q, want %%3", byWindow["@3"][0].PaneID)
		}
	})

	t.Run("agent state parsed from field 6", func(t *testing.T) {
		cases := []struct {
			raw       string
			wantState string
			wantEpoch int64
		}{
			{"active:1751790000", "active", 1751790000},
			{"waiting:1751790001", "waiting", 1751790001},
			{"idle:1751790002", "idle", 1751790002},
		}
		for _, c := range cases {
			lines := []string{paneLineAgent("@0", "%1", 0, "/tmp", "claude", 1, c.raw)}
			byWindow := parsePanes(lines)
			if totalPanes(byWindow) != 1 {
				t.Fatalf("raw %q: got %d panes, want 1", c.raw, totalPanes(byWindow))
			}
			p := byWindow["@0"][0]
			if p.AgentState != c.wantState || p.AgentStateEpoch != c.wantEpoch {
				t.Errorf("raw %q: AgentState=%q epoch=%d, want %q/%d", c.raw, p.AgentState, p.AgentStateEpoch, c.wantState, c.wantEpoch)
			}
		}
	})

	t.Run("unset agent state yields zero values", func(t *testing.T) {
		lines := []string{paneLineAgent("@0", "%1", 0, "/tmp", "claude", 1, "")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentState != "" || p.AgentStateEpoch != 0 {
			t.Errorf("unset: AgentState=%q epoch=%d, want empty/0", p.AgentState, p.AgentStateEpoch)
		}
	})

	t.Run("malformed agent state degrades to zero", func(t *testing.T) {
		cases := []string{
			"active",            // no colon
			"active:notanumber", // non-integer epoch
			"bogus:1751790000",  // unknown state token
			":1751790000",       // empty state
		}
		for _, raw := range cases {
			lines := []string{paneLineAgent("@0", "%1", 0, "/tmp", "claude", 1, raw)}
			p := parsePanes(lines)["@0"][0]
			if p.AgentState != "" || p.AgentStateEpoch != 0 {
				t.Errorf("raw %q: AgentState=%q epoch=%d, want empty/0", raw, p.AgentState, p.AgentStateEpoch)
			}
		}
	})

	t.Run("legacy shell-command reconciler zeros a two-segment leftover state", func(t *testing.T) {
		for _, shell := range []string{"sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"} {
			lines := []string{paneLineAgent("@0", "%1", 0, "/tmp", shell, 1, "active:1751790000")}
			p := parsePanes(lines)["@0"][0]
			if p.AgentState != "" || p.AgentStateEpoch != 0 {
				t.Errorf("shell %q: AgentState=%q epoch=%d, want empty/0 (legacy reconciler)", shell, p.AgentState, p.AgentStateEpoch)
			}
		}
	})

	t.Run("non-shell command keeps a two-segment state", func(t *testing.T) {
		lines := []string{paneLineAgent("@0", "%1", 0, "/tmp", "claude", 1, "active:1751790000")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentState != "active" || p.AgentStateEpoch != 1751790000 {
			t.Errorf("claude: AgentState=%q epoch=%d, want active/1751790000", p.AgentState, p.AgentStateEpoch)
		}
	})

	t.Run("pid-carrying state survives a shell pane command when the process is alive", func(t *testing.T) {
		// The wrapped-launch case: claude started via a non-exec'ing bash
		// wrapper, so pane_current_command reads "bash" while the agent runs.
		// PID liveness must win over the shell-name heuristic.
		restore := agentProcessAlive
		agentProcessAlive = func(pid int) bool { return pid == 4242 }
		defer func() { agentProcessAlive = restore }()

		lines := []string{paneLineAgent("@0", "%1", 0, "/tmp", "bash", 1, "waiting:1751790000:4242")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentState != "waiting" || p.AgentStateEpoch != 1751790000 {
			t.Errorf("alive pid under bash: AgentState=%q epoch=%d, want waiting/1751790000", p.AgentState, p.AgentStateEpoch)
		}
	})

	t.Run("pid-carrying state zeroed when the process is dead", func(t *testing.T) {
		// A crashed/killed agent must clear even when the pane command looks
		// agent-like — liveness is authoritative for pid-carrying values.
		restore := agentProcessAlive
		agentProcessAlive = func(int) bool { return false }
		defer func() { agentProcessAlive = restore }()

		lines := []string{paneLineAgent("@0", "%1", 0, "/tmp", "claude", 1, "active:1751790000:4242")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentState != "" || p.AgentStateEpoch != 0 {
			t.Errorf("dead pid: AgentState=%q epoch=%d, want empty/0", p.AgentState, p.AgentStateEpoch)
		}
	})

	t.Run("agent-session ref parsed from the retired @rk_pane_chat field", func(t *testing.T) {
		const uuid = "6f0d9e2a-1c3b-4f7e-9a2d-8b5c4e1f0a37"
		lines := []string{paneLineAgentSession("@0", "%1", 0, "/tmp", "claude", 1, "active:1751790000", "claude:"+uuid)}
		p := parsePanes(lines)["@0"][0]
		if p.AgentProvider != "claude" || p.AgentSessionRef != uuid {
			t.Errorf("AgentProvider=%q AgentSessionRef=%q, want claude/%s", p.AgentProvider, p.AgentSessionRef, uuid)
		}
	})

	t.Run("unset agent session yields empty agent-session fields", func(t *testing.T) {
		lines := []string{paneLineAgentSession("@0", "%1", 0, "/tmp", "claude", 1, "active:1751790000", "")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentProvider != "" || p.AgentSessionRef != "" {
			t.Errorf("unset agent session: AgentProvider=%q AgentSessionRef=%q, want empty", p.AgentProvider, p.AgentSessionRef)
		}
	})

	t.Run("malformed agent session degrades to empty", func(t *testing.T) {
		for _, raw := range []string{"claude", "claude:", ":abc", "Claude:abc", "claude:has space"} {
			lines := []string{paneLineAgentSession("@0", "%1", 0, "/tmp", "claude", 1, "active:1751790000", raw)}
			p := parsePanes(lines)["@0"][0]
			if p.AgentProvider != "" || p.AgentSessionRef != "" {
				t.Errorf("raw %q: AgentProvider=%q AgentSessionRef=%q, want empty", raw, p.AgentProvider, p.AgentSessionRef)
			}
		}
	})

	t.Run("back-compat: a 9-field line (no scope-named fields) is skipped by the < 12 guard", func(t *testing.T) {
		// All 12 fields are required now; a pane emitted without them is skipped
		// (the format always emits both generations — tmux resolves an unset
		// option to an empty field — so a short line is a parse anomaly).
		nineField := fmt.Sprintf("0%s%%1%s0%s/tmp%sclaude%s1%sactive:1751790000%s%s0",
			listDelim, listDelim, listDelim, listDelim, listDelim, listDelim, listDelim, listDelim)
		valid := paneLineAgentSession("@1", "%2", 0, "/tmp", "claude", 1, "", "")
		byWindow := parsePanes([]string{nineField, valid})
		if totalPanes(byWindow) != 1 {
			t.Fatalf("got %d panes, want 1 (9-field line skipped)", totalPanes(byWindow))
		}
		if byWindow["@0"] != nil {
			t.Errorf("byWindow[@0] should be nil (9-field line skipped), got %v", byWindow["@0"])
		}
	})

	t.Run("dual-read: new agent-state field wins over legacy", func(t *testing.T) {
		restore := agentProcessAlive
		agentProcessAlive = func(pid int) bool { return pid == 4242 }
		defer func() { agentProcessAlive = restore }()

		lines := []string{paneLineFull("@0", "%1", 0, "/tmp", "claude", 1, "idle:100", "", "0", "active:200:4242", "")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentState != "active" || p.AgentStateEpoch != 200 {
			t.Errorf("both set: AgentState=%q epoch=%d, want active/200 (new wins)", p.AgentState, p.AgentStateEpoch)
		}
	})

	t.Run("dual-read: legacy agent-state field used when new is empty", func(t *testing.T) {
		lines := []string{paneLineFull("@0", "%1", 0, "/tmp", "claude", 1, "idle:100", "", "0", "", "")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentState != "idle" || p.AgentStateEpoch != 100 {
			t.Errorf("new empty: AgentState=%q epoch=%d, want idle/100 (legacy fallback)", p.AgentState, p.AgentStateEpoch)
		}
	})

	t.Run("dual-read: whitespace-only new agent-state field falls back to legacy", func(t *testing.T) {
		// The parse helpers TrimSpace their input, so a blank-but-present new
		// value must not block the legacy fallback (trimmed-value semantics).
		lines := []string{paneLineFull("@0", "%1", 0, "/tmp", "claude", 1, "idle:100", "claude:abc", "0", "  ", " ")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentState != "idle" || p.AgentStateEpoch != 100 {
			t.Errorf("new blank: AgentState=%q epoch=%d, want idle/100 (legacy fallback)", p.AgentState, p.AgentStateEpoch)
		}
		if p.AgentProvider != "claude" || p.AgentSessionRef != "abc" {
			t.Errorf("new blank agent session: AgentProvider=%q AgentSessionRef=%q, want claude/abc (legacy fallback)", p.AgentProvider, p.AgentSessionRef)
		}
	})

	t.Run("dual-read: both agent-state fields empty yields empty state", func(t *testing.T) {
		lines := []string{paneLineFull("@0", "%1", 0, "/tmp", "claude", 1, "", "", "0", "", "")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentState != "" || p.AgentStateEpoch != 0 {
			t.Errorf("both empty: AgentState=%q epoch=%d, want empty/0", p.AgentState, p.AgentStateEpoch)
		}
	})

	t.Run("dual-read: new agent-session field wins over legacy", func(t *testing.T) {
		lines := []string{paneLineFull("@0", "%1", 0, "/tmp", "claude", 1, "active:1751790000", "claude:legacy-ref", "0", "", "claude:new-ref")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentSessionRef != "new-ref" {
			t.Errorf("both set: AgentSessionRef=%q, want new-ref (new wins)", p.AgentSessionRef)
		}
	})

	t.Run("dual-read: legacy agent-session field used when new is empty", func(t *testing.T) {
		lines := []string{paneLineFull("@0", "%1", 0, "/tmp", "claude", 1, "active:1751790000", "claude:legacy-ref", "0", "", "")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentSessionRef != "legacy-ref" {
			t.Errorf("new empty: AgentSessionRef=%q, want legacy-ref (legacy fallback)", p.AgentSessionRef)
		}
	})

	t.Run("dual-read: both agent-session fields empty yields empty identity", func(t *testing.T) {
		lines := []string{paneLineFull("@0", "%1", 0, "/tmp", "claude", 1, "active:1751790000", "", "0", "", "")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentProvider != "" || p.AgentSessionRef != "" {
			t.Errorf("both empty: AgentProvider=%q AgentSessionRef=%q, want empty", p.AgentProvider, p.AgentSessionRef)
		}
	})

	t.Run("dual-read: new agent-state only (no legacy) parses", func(t *testing.T) {
		restore := agentProcessAlive
		agentProcessAlive = func(pid int) bool { return pid == 4242 }
		defer func() { agentProcessAlive = restore }()

		lines := []string{paneLineFull("@0", "%1", 0, "/tmp", "claude", 1, "", "", "0", "active:200:4242", "claude:new-ref")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentState != "active" || p.AgentStateEpoch != 200 {
			t.Errorf("new only: AgentState=%q epoch=%d, want active/200", p.AgentState, p.AgentStateEpoch)
		}
		if p.AgentSessionRef != "new-ref" {
			t.Errorf("new only: AgentSessionRef=%q, want new-ref", p.AgentSessionRef)
		}
	})

	t.Run("alternate_on parsed from field 7", func(t *testing.T) {
		lines := []string{paneLineAlt("@0", "%1", 0, "/tmp", "claude", 1, "", "", "1")}
		p := parsePanes(lines)["@0"][0]
		if !p.AltScreen {
			t.Error("AltScreen = false, want true")
		}

		lines = []string{paneLineAlt("@0", "%1", 0, "/tmp", "zsh", 1, "", "", "0")}
		p = parsePanes(lines)["@0"][0]
		if p.AltScreen {
			t.Error("AltScreen = true, want false")
		}
	})

	t.Run("dead pid zeros BOTH agent-state and agent-session fields", func(t *testing.T) {
		restore := agentProcessAlive
		agentProcessAlive = func(int) bool { return false }
		defer func() { agentProcessAlive = restore }()

		lines := []string{paneLineAgentSession("@0", "%1", 0, "/tmp", "claude", 1, "active:1751790000:4242", "claude:abc-123")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentState != "" || p.AgentProvider != "" || p.AgentSessionRef != "" {
			t.Errorf("dead pid: AgentState=%q Agent=%q/%q, want all empty", p.AgentState, p.AgentProvider, p.AgentSessionRef)
		}
	})

	t.Run("shell pane with no live pid-bearing agent-state zeros the agent session", func(t *testing.T) {
		// Two-segment (legacy / SessionStart-before-first-prompt) agent-state has
		// no pid, so a plain-shell pane falls to the shell heuristic and never
		// surfaces an agent session.
		lines := []string{paneLineAgentSession("@0", "%1", 0, "/tmp", "bash", 1, "active:1751790000", "claude:abc-123")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentProvider != "" || p.AgentSessionRef != "" {
			t.Errorf("shell pane: Agent=%q/%q, want empty", p.AgentProvider, p.AgentSessionRef)
		}
	})

	t.Run("live wrapped pid keeps the agent session under a bash command", func(t *testing.T) {
		// The wrapped-launch case: claude under a non-exec'ing bash wrapper, so
		// pane_current_command is "bash" while the agent runs. PID liveness wins
		// over the shell heuristic for the agent session exactly as it does for
		// agent-state.
		restore := agentProcessAlive
		agentProcessAlive = func(pid int) bool { return pid == 4242 }
		defer func() { agentProcessAlive = restore }()

		lines := []string{paneLineAgentSession("@0", "%1", 0, "/tmp", "bash", 1, "waiting:1751790000:4242", "claude:abc-123")}
		p := parsePanes(lines)["@0"][0]
		if p.AgentProvider != "claude" || p.AgentSessionRef != "abc-123" {
			t.Errorf("live wrapped pid: Agent=%q/%q, want claude/abc-123", p.AgentProvider, p.AgentSessionRef)
		}
	})
}

func TestParseAgentSessionRef(t *testing.T) {
	cases := []struct {
		raw          string
		wantProvider string
		wantRef      string
	}{
		{"claude:6f0d9e2a-1c3b-4f7e-9a2d-8b5c4e1f0a37", "claude", "6f0d9e2a-1c3b-4f7e-9a2d-8b5c4e1f0a37"},
		{"codex:thread-abc", "codex", "thread-abc"}, // unknown-but-well-formed provider tolerated
		{"claude:seg1:seg2", "claude", "seg1:seg2"}, // first-colon split; a colon-bearing ref is preserved
		{" claude:abc ", "claude", "abc"},           // surrounding whitespace trimmed
		{"gpt-4o_mini:x", "gpt-4o_mini", "x"},       // provider with digits/_/-
		{"", "", ""},                                // empty
		{"claude", "", ""},                          // no colon
		{"claude:", "", ""},                         // empty ref
		{":abc", "", ""},                            // empty provider
		{"Claude:abc", "", ""},                      // uppercase provider rejected
		{"9claude:abc", "", ""},                     // provider must start with a-z
		{"cla ude:abc", "", ""},                     // space in provider
		{"claude:has space", "", ""},                // whitespace in ref
		{"claude:tab\there", "", ""},                // control char in ref
	}
	for _, c := range cases {
		provider, ref := parseAgentSessionRef(c.raw)
		if provider != c.wantProvider || ref != c.wantRef {
			t.Errorf("parseAgentSessionRef(%q) = (%q, %q), want (%q, %q)", c.raw, provider, ref, c.wantProvider, c.wantRef)
		}
		// The exported wrappers share the private rule — assert parity on the
		// same table rather than duplicating cases.
		if gp, gr := ParseAgentSessionRef(c.raw); gp != provider || gr != ref {
			t.Errorf("ParseAgentSessionRef(%q) = (%q, %q), want (%q, %q)", c.raw, gp, gr, provider, ref)
		}
		if got := ValidAgentSessionRef(c.wantRef); c.wantRef != "" && !got {
			t.Errorf("ValidAgentSessionRef(%q) = false, want true", c.wantRef)
		}
	}
}

// TestValidAgentSessionRef: the exported shape gate rejects exactly the refs
// the private rule rejects — empty, whitespace-bearing, control-char-bearing.
func TestValidAgentSessionRef(t *testing.T) {
	cases := []struct {
		ref  string
		want bool
	}{
		{"6f0d9e2a-1c3b-4f7e-9a2d-8b5c4e1f0a37", true},
		{"seg1:seg2", true}, // a colon-bearing ref stays opaque
		{"x", true},
		{"", false},
		{"has space", false},
		{"tab\there", false},
		{"del\x7fhere", false},
		{"newline\nhere", false},
	}
	for _, c := range cases {
		if got := ValidAgentSessionRef(c.ref); got != c.want {
			t.Errorf("ValidAgentSessionRef(%q) = %v, want %v", c.ref, got, c.want)
		}
	}
}

func TestParseAgentState(t *testing.T) {
	cases := []struct {
		raw       string
		wantState string
		wantEpoch int64
		wantPID   int
	}{
		{"active:100", "active", 100, 0},
		{"waiting:200", "waiting", 200, 0},
		{"idle:300", "idle", 300, 0},
		{"active:100:4242", "active", 100, 4242}, // pid-carrying form
		{"waiting:200:1", "waiting", 200, 1},
		{"", "", 0, 0},
		{"active", "", 0, 0},
		{"active:", "", 0, 0},
		{"active:x", "", 0, 0},
		{"bogus:100", "", 0, 0},
		{"active:100:x", "", 0, 0},      // malformed pid → wholly unknown
		{"active:100:0", "", 0, 0},      // non-positive pid → wholly unknown
		{"active:100:-7", "", 0, 0},     // negative pid → wholly unknown
		{"active:100:4242:9", "", 0, 0}, // too many segments
		{" idle:400 ", "idle", 400, 0},  // surrounding whitespace trimmed
	}
	for _, c := range cases {
		state, epoch, pid := parseAgentState(c.raw)
		if state != c.wantState || epoch != c.wantEpoch || pid != c.wantPID {
			t.Errorf("parseAgentState(%q) = (%q, %d, %d), want (%q, %d, %d)", c.raw, state, epoch, pid, c.wantState, c.wantEpoch, c.wantPID)
		}
	}
}

// makeDirenvDiff builds a real DIRENV_DIFF value the way direnv does — JSON
// {"p":{...},"n":{...}} → zlib deflate → base64url (padded) — so reversal tests
// exercise genuine decode/inflate/parse paths rather than a hand-mocked shortcut.
// p holds prior values (changed/removed vars), n holds new values (changed/added).
func makeDirenvDiff(t *testing.T, p, n map[string]string) string {
	t.Helper()
	payload, err := json.Marshal(struct {
		P map[string]string `json:"p"`
		N map[string]string `json:"n"`
	}{P: p, N: n})
	if err != nil {
		t.Fatalf("marshal diff: %v", err)
	}
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	if _, err := w.Write(payload); err != nil {
		t.Fatalf("zlib write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("zlib close: %v", err)
	}
	return base64.URLEncoding.EncodeToString(buf.Bytes())
}

func TestSanitizeEnv(t *testing.T) {
	tests := []struct {
		name    string
		input   []string
		wantHas []string // exact entries that must be present
		wantNot []string // substrings that must be absent from every entry
	}{
		{
			// direnv added WORKTREE_INIT_SCRIPT + IDEAS_FILE, changed PATH,
			// removed EDITOR. Reversal must undo all four.
			name: "reverses direnv diff (add removed, changed+removed restored)",
			input: []string{
				"HOME=/home/user",
				"PATH=/run-kit/bin:/usr/bin",
				"WORKTREE_INIT_SCRIPT=fab sync",
				"IDEAS_FILE=fab/backlog.md",
				"DIRENV_DIFF=" + makeDirenvDiff(t,
					map[string]string{"PATH": "/home/user/.local/bin:/usr/bin", "EDITOR": "vim"},
					map[string]string{"PATH": "/run-kit/bin:/usr/bin", "WORKTREE_INIT_SCRIPT": "fab sync", "IDEAS_FILE": "fab/backlog.md"},
				),
				"SHELL=/bin/zsh",
			},
			wantHas: []string{
				"HOME=/home/user",
				"PATH=/home/user/.local/bin:/usr/bin", // restored to prior (true from-home PATH)
				"EDITOR=vim",                          // direnv-removed var restored
				"SHELL=/bin/zsh",
			},
			wantNot: []string{"WORKTREE_INIT_SCRIPT", "IDEAS_FILE", "/run-kit/bin", "DIRENV_"},
		},
		{
			name: "strips all RK_* and DIRENV_* vars",
			input: []string{
				"HOME=/home/user",
				"PATH=/usr/bin",
				"RK_DAEMON_LOG=/tmp/daemon.log",
				"RK_PORT=3000",
				"RK_HOST=0.0.0.0",
				"DIRENV_DIR=/run-kit",
				"DIRENV_FILE=/run-kit/.envrc",
			},
			wantHas: []string{"HOME=/home/user", "PATH=/usr/bin"},
			wantNot: []string{"RK_", "DIRENV_"},
		},
		{
			// No DIRENV_DIFF: pass through unchanged except RK_*/DIRENV_* strips.
			// The real PATH MUST survive — NOT reset to the POSIX default.
			name: "no diff: passes PATH through, does not POSIX-reset",
			input: []string{
				"HOME=/home/user",
				"PATH=/home/user/.local/bin:/usr/bin",
				"RK_PORT=3000",
				"SHELL=/bin/zsh",
			},
			wantHas: []string{
				"HOME=/home/user",
				"PATH=/home/user/.local/bin:/usr/bin",
				"SHELL=/bin/zsh",
			},
			wantNot: []string{"RK_", cleanPATH},
		},
		{
			// Malformed DIRENV_DIFF: fail-soft to pass-through + strips.
			name: "malformed diff: fail-soft pass-through with strips",
			input: []string{
				"HOME=/home/user",
				"PATH=/home/user/.local/bin:/usr/bin",
				"RK_DAEMON_LOG=/tmp/x",
				"DIRENV_DIFF=not-valid-base64!!!",
			},
			wantHas: []string{"HOME=/home/user", "PATH=/home/user/.local/bin:/usr/bin"},
			wantNot: []string{"RK_", "DIRENV_", cleanPATH},
		},
		{
			// Last-resort PATH guard: env with no PATH gets cleanPATH injected.
			name:    "PATH-missing guard injects cleanPATH",
			input:   []string{"HOME=/home/user", "SHELL=/bin/zsh"},
			wantHas: []string{"HOME=/home/user", "PATH=" + cleanPATH, "SHELL=/bin/zsh"},
			wantNot: nil,
		},
		{
			name:    "empty input still gets PATH guard",
			input:   nil,
			wantHas: []string{"PATH=" + cleanPATH},
			wantNot: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeEnv(tt.input)

			for _, want := range tt.wantHas {
				found := false
				for _, e := range got {
					if e == want {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("missing expected entry %q in %v", want, got)
				}
			}

			for _, sub := range tt.wantNot {
				for _, e := range got {
					if strings.Contains(e, sub) {
						t.Errorf("unexpected entry %q containing %q", e, sub)
					}
				}
			}

			// PATH should appear exactly once.
			pathCount := 0
			for _, e := range got {
				if strings.HasPrefix(e, "PATH=") {
					pathCount++
				}
			}
			if pathCount != 1 {
				t.Errorf("PATH appears %d times, want 1", pathCount)
			}
		})
	}
}

func TestReverseDirenvDiff_absentPassesThrough(t *testing.T) {
	in := []string{"HOME=/home/user", "PATH=/usr/bin"}
	got, err := reverseDirenvDiff(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != len(in) {
		t.Fatalf("expected unchanged env, got %v", got)
	}
	for i := range in {
		if got[i] != in[i] {
			t.Errorf("entry %d changed: got %q want %q", i, got[i], in[i])
		}
	}
}

func TestReverseDirenvDiff_valid(t *testing.T) {
	diff := makeDirenvDiff(t,
		map[string]string{"PATH": "/usr/bin", "EDITOR": "vim"},  // prior
		map[string]string{"PATH": "/run-kit/bin", "ADDED": "x"}, // new (PATH changed, ADDED added, EDITOR removed by direnv)
	)
	in := []string{
		"HOME=/home/user",
		"PATH=/run-kit/bin",
		"ADDED=x",
		"DIRENV_DIFF=" + diff,
	}
	got, err := reverseDirenvDiff(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := envToMap(got)
	if m["PATH"] != "/usr/bin" {
		t.Errorf("PATH not restored: got %q want /usr/bin", m["PATH"])
	}
	if v, ok := m["ADDED"]; ok {
		t.Errorf("ADDED should be removed, got %q", v)
	}
	if m["EDITOR"] != "vim" {
		t.Errorf("EDITOR (direnv-removed) not restored: got %q want vim", m["EDITOR"])
	}
	// DIRENV_DIFF is left for the caller's DIRENV_* strip, not removed here.
	if _, ok := m["DIRENV_DIFF"]; !ok {
		t.Errorf("DIRENV_DIFF should remain for the caller to strip")
	}
}

func TestReverseDirenvDiff_malformedReturnsError(t *testing.T) {
	in := []string{"HOME=/home/user", "DIRENV_DIFF=not-base64!!!"}
	got, err := reverseDirenvDiff(in)
	if err == nil {
		t.Fatalf("expected error for malformed diff, got nil")
	}
	// On error the original env is returned so the caller can fall through.
	if len(got) != len(in) {
		t.Errorf("expected original env returned on error, got %v", got)
	}
}

// TestReverseDirenvDiff_oversizedPayloadFailsSoft proves that a DIRENV_DIFF
// whose inflated payload exceeds the size cap is rejected with an error (so the
// caller falls through fail-soft) rather than being decoded into memory. It
// builds a valid zlib stream — highly compressible so the encoded env value
// stays tiny — that inflates well past maxDirenvDiffInflated.
func TestReverseDirenvDiff_oversizedPayloadFailsSoft(t *testing.T) {
	// A large, highly-compressible payload: JSON is irrelevant here because the
	// size cap trips before the unmarshal ever runs.
	big := strings.Repeat("A", maxDirenvDiffInflated+1024)
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	if _, err := w.Write([]byte(big)); err != nil {
		t.Fatalf("zlib write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("zlib close: %v", err)
	}
	encoded := base64.URLEncoding.EncodeToString(buf.Bytes())

	in := []string{"HOME=/home/user", "DIRENV_DIFF=" + encoded}
	got, err := reverseDirenvDiff(in)
	if !errors.Is(err, errDirenvDiffTooLarge) {
		t.Fatalf("expected errDirenvDiffTooLarge, got %v", err)
	}
	// On error the original env is returned so the caller can fall through.
	if len(got) != len(in) {
		t.Errorf("expected original env returned on oversized diff, got %v", got)
	}
}

func envToMap(environ []string) map[string]string {
	m := make(map[string]string, len(environ))
	for _, e := range environ {
		if i := strings.IndexByte(e, '='); i >= 0 {
			m[e[:i]] = e[i+1:]
		}
	}
	return m
}

func TestEnsureConfigCreatesDropInDir(t *testing.T) {
	dest := withTempDefaultConfig(t)

	// Fresh install — both config and tmux.d/ should be created.
	if _, err := EnsureConfig(); err != nil {
		t.Fatalf("EnsureConfig() error: %v", err)
	}
	dropInDir := filepath.Join(filepath.Dir(dest), "tmux.d")
	fi, err := os.Stat(dropInDir)
	if os.IsNotExist(err) {
		t.Error("tmux.d/ not created on fresh install")
	} else if err != nil {
		t.Fatalf("stat tmux.d/: %v", err)
	} else if !fi.IsDir() {
		t.Error("tmux.d/ exists but is not a directory")
	}
	if _, err := os.Stat(DefaultConfigPath); os.IsNotExist(err) {
		t.Error("tmux.conf not created on fresh install")
	}

	// Remove tmux.d/ but keep config — EnsureConfig should recreate tmux.d/.
	if err := os.RemoveAll(dropInDir); err != nil {
		t.Fatalf("failed to remove tmux.d/: %v", err)
	}
	if _, err := EnsureConfig(); err != nil {
		t.Fatalf("EnsureConfig() second call error: %v", err)
	}
	fi, err = os.Stat(dropInDir)
	if os.IsNotExist(err) {
		t.Error("tmux.d/ not recreated when config exists but dir missing")
	} else if err != nil {
		t.Fatalf("stat tmux.d/: %v", err)
	} else if !fi.IsDir() {
		t.Error("tmux.d/ exists but is not a directory after recreation")
	}
}

func TestForceWriteConfigCreatesDropInDir(t *testing.T) {
	dest := withTempDefaultConfig(t)

	if err := ForceWriteConfig(); err != nil {
		t.Fatalf("ForceWriteConfig() error: %v", err)
	}
	dropInDir := filepath.Join(filepath.Dir(dest), "tmux.d")
	fi, err := os.Stat(dropInDir)
	if os.IsNotExist(err) {
		t.Error("tmux.d/ not created by ForceWriteConfig")
	} else if err != nil {
		t.Fatalf("stat tmux.d/: %v", err)
	} else if !fi.IsDir() {
		t.Error("tmux.d/ exists but is not a directory")
	}
}

func TestDefaultConfigContainsSourceDirective(t *testing.T) {
	content := string(DefaultConfigBytes())
	want := `if-shell '[ -d "$HOME/.config/hexokit" ] || [ ! -d "$HOME/.config/run-kit" ]' 'source-file -q ~/.config/hexokit/tmux.d/*.conf' 'source-file -q ~/.config/run-kit/tmux.d/*.conf'`
	if !strings.Contains(content, want) {
		t.Error("embedded default config missing the if-shell dual-source directive for tmux.d/")
	}
}

// The embedded default config sets automatic-rename-format to the pane's
// current-path basename, so unnamed windows display their folder rather than
// the running command (change 260707-j66b).
func TestDefaultConfigSetsAutomaticRenameFormat(t *testing.T) {
	content := string(DefaultConfigBytes())
	if !strings.Contains(content, "automatic-rename-format '#{b:pane_current_path}'") {
		t.Error("embedded default config missing automatic-rename-format '#{b:pane_current_path}'")
	}
}

func TestEnsureDropInDirNoHomeDir(t *testing.T) {
	origDefault := DefaultConfigPath
	defer func() { DefaultConfigPath = origDefault }()
	DefaultConfigPath = ""

	// Should be a no-op, not panic.
	ensureDropInDir()
}

// The config-path resolution chain is RK_TMUX_CONF env → tmux_conf config.yaml
// key → DefaultConfigPath. HOME is isolated so settings.Load reads only the
// config.yaml the test writes.
func TestResolveConfigPathPrecedence(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	origDefault := DefaultConfigPath
	defer func() { DefaultConfigPath = origDefault }()
	DefaultConfigPath = filepath.Join(home, ".rk", "tmux.conf")

	confDir := filepath.Join(home, ".config", "hexokit")
	if err := os.MkdirAll(confDir, 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	confFile := filepath.Join(confDir, "config.yaml")
	if err := os.WriteFile(confFile, []byte("tmux_conf: /from/config.yaml\n"), 0o644); err != nil {
		t.Fatalf("write config.yaml: %v", err)
	}

	t.Setenv("RK_TMUX_CONF", "/from/env")
	if got := resolveConfigPath(); got != "/from/env" {
		t.Errorf("env + config key: resolveConfigPath() = %q, want %q", got, "/from/env")
	}

	t.Setenv("RK_TMUX_CONF", "")
	if got := resolveConfigPath(); got != "/from/config.yaml" {
		t.Errorf("config key only: resolveConfigPath() = %q, want %q", got, "/from/config.yaml")
	}

	if err := os.Remove(confFile); err != nil {
		t.Fatalf("remove config.yaml: %v", err)
	}
	if got := resolveConfigPath(); got != DefaultConfigPath {
		t.Errorf("neither set: resolveConfigPath() = %q, want %q", got, DefaultConfigPath)
	}
}

// windowID reads the stable tmux window id (@N) for a display-message target on
// the isolated test server. A "session:index" target resolves that specific
// window; a bare "session" target resolves the session's ACTIVE window. Fails the
// test if it cannot be resolved.
func windowID(t *testing.T, server, target string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "-L", server, "display-message", "-t", target, "-p", "#{window_id}").CombinedOutput()
	if err != nil {
		t.Fatalf("resolve window id for %q: %v\n%s", target, err, string(out))
	}
	id := strings.TrimSpace(string(out))
	if id == "" {
		t.Fatalf("empty window id for %q", target)
	}
	return id
}

func TestMoveWindow_reordersAndPreservesID(t *testing.T) {
	server := withSessionOrderTmux(t)

	// boot session exists with window 0; add two more so we have 0,1,2.
	for _, name := range []string{"one", "two"} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, "tmux", "-L", server, "new-window", "-t", "boot", "-n", name).CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("new-window %q: %v\n%s", name, err, string(out))
		}
	}

	// Capture the stable id of the window currently at index 2, then move it to
	// index 0. The reorder is positional (bubble-swap), but tmux preserves the
	// window id across the move — the contract this migration relies on.
	id := windowID(t, server, "boot:2")

	if err := MoveWindow(id, 0, server); err != nil {
		t.Fatalf("MoveWindow(%q -> 0): %v", id, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	gotSession, gotIndex, err := resolveWindowSessionIndex(ctx, server, id)
	if err != nil {
		t.Fatalf("resolve after move: %v", err)
	}
	if gotIndex != 0 {
		t.Errorf("after MoveWindow: index = %d, want 0", gotIndex)
	}
	if gotSession != "boot" {
		t.Errorf("after MoveWindow: session = %q, want %q", gotSession, "boot")
	}
}

// windowOption reads a user-defined window option for target via show-options,
// returning ("", false) when the option is unset.
func windowOption(t *testing.T, server, target, option string) (string, bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "-L", server, "show-options", "-wqv", "-t", target, option).CombinedOutput()
	if err != nil {
		t.Fatalf("show-options %q for %q: %v\n%s", option, target, err, string(out))
	}
	v := strings.TrimSpace(string(out))
	return v, v != ""
}

// TestMoveWindow_multiStepReorder exercises a reorder that needs ≥2 swaps
// (window at index 4 → index 1 across 6 windows) and asserts the final layout
// plus preserved @N after the single chained invocation.
func TestMoveWindow_multiStepReorder(t *testing.T) {
	server := withSessionOrderTmux(t)

	// boot has window 0; add five more so indices are 0..5.
	for _, name := range []string{"one", "two", "three", "four", "five"} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, "tmux", "-L", server, "new-window", "-t", "boot", "-n", name).CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("new-window %q: %v\n%s", name, err, string(out))
		}
	}

	// Move the window at index 4 to index 1 (insert-before). Requires 3 swaps
	// (4↔3, 3↔2, 2↔1) emitted as one chained invocation.
	id := windowID(t, server, "boot:4")
	if err := MoveWindow(id, 1, server); err != nil {
		t.Fatalf("MoveWindow(%q -> 1): %v", id, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	gotSession, gotIndex, err := resolveWindowSessionIndex(ctx, server, id)
	if err != nil {
		t.Fatalf("resolve after multi-step move: %v", err)
	}
	if gotSession != "boot" {
		t.Errorf("session = %q, want %q", gotSession, "boot")
	}
	// Insert-before semantics: moving index 4 to before index 1 lands it at index 1.
	if gotIndex != 1 {
		t.Errorf("after multi-step MoveWindow: index = %d, want 1", gotIndex)
	}
}

// selectWindowCLI makes target the session's active window via a bare
// select-window (test setup only — bypasses MoveWindow).
func selectWindowCLI(t *testing.T, server, target string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "tmux", "-L", server, "select-window", "-t", target).CombinedOutput(); err != nil {
		t.Fatalf("select-window -t %q: %v\n%s", target, err, string(out))
	}
}

// TestMoveWindow_preservesActiveWindow proves the fix: reordering a window the
// user is NOT viewing must not drift the session's active window. tmux otherwise
// pins the active window to its index slot during swap-window, so a different
// window would occupy the active slot after the shuffle. With [0,1*,2,3] (1
// active), moving window 3 to index 0 must leave window 1 active — not the
// index-pinned window that lands in slot 1.
func TestMoveWindow_preservesActiveWindow(t *testing.T) {
	server := withSessionOrderTmux(t)

	// boot has window 0; add three more so indices are 0..3.
	for _, name := range []string{"one", "two", "three"} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, "tmux", "-L", server, "new-window", "-t", "boot", "-n", name).CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("new-window %q: %v\n%s", name, err, string(out))
		}
	}

	// Make the window at index 1 active (the "viewed" window) and record its id.
	selectWindowCLI(t, server, "boot:1")
	wantActive := windowID(t, server, "boot:1")

	// Move the window at index 3 to index 0 — the reorder the user did NOT intend
	// to change their focus.
	dragged := windowID(t, server, "boot:3")
	if err := MoveWindow(dragged, 0, server); err != nil {
		t.Fatalf("MoveWindow(%q -> 0): %v", dragged, err)
	}

	// windowID with a bare session target resolves that session's ACTIVE window
	// (display-message -t boot), so it reads back the post-move active window.
	if gotActive := windowID(t, server, "boot"); gotActive != wantActive {
		t.Errorf("after MoveWindow: active window = %q, want %q (active window drifted)", gotActive, wantActive)
	}
}

// TestMoveWindow_preservesActiveWindowWhenDragged covers the edge where the moved
// window IS the active one. Restoring by stable window id (not index) must follow
// the dragged window to its new slot: with [0,1,2,3*] (3 active), moving window 3
// to index 0 must leave that same window active AND now at index 0.
func TestMoveWindow_preservesActiveWindowWhenDragged(t *testing.T) {
	server := withSessionOrderTmux(t)

	for _, name := range []string{"one", "two", "three"} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, "tmux", "-L", server, "new-window", "-t", "boot", "-n", name).CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("new-window %q: %v\n%s", name, err, string(out))
		}
	}

	// The dragged window is the active one.
	selectWindowCLI(t, server, "boot:3")
	dragged := windowID(t, server, "boot:3")

	if err := MoveWindow(dragged, 0, server); err != nil {
		t.Fatalf("MoveWindow(%q -> 0): %v", dragged, err)
	}

	if gotActive := windowID(t, server, "boot"); gotActive != dragged {
		t.Errorf("after MoveWindow: active window = %q, want %q (dragged+active window lost focus)", gotActive, dragged)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, gotIndex, err := resolveWindowSessionIndex(ctx, server, dragged)
	if err != nil {
		t.Fatalf("resolve after move: %v", err)
	}
	if gotIndex != 0 {
		t.Errorf("after MoveWindow: dragged window index = %d, want 0", gotIndex)
	}
}

// TestMoveWindow_preservesActiveWindowInSessionGroup exercises the reorder inside a
// tmux session GROUP. Members created with `new-session -t <base>` share window
// membership but keep INDEPENDENT active-window pointers. MoveWindow resolves the
// dragged window to a single owning session (via resolveWindowSessionIndex) and
// runs its swaps + the active-window restore scoped to THAT session; the restore
// target is session-qualified (`select-window -t <session>:@N`) rather than a bare
// `@N`, which is ambiguous across group members (see SelectWindowInSession). This
// pins that the qualified restore keeps the reordered session's active window
// invariant even while a mirror member exists with a different active pointer.
func TestMoveWindow_preservesActiveWindowInSessionGroup(t *testing.T) {
	server := withSessionOrderTmux(t)

	// boot has window 0; add three more so indices are 0..3.
	for _, name := range []string{"one", "two", "three"} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, "tmux", "-L", server, "new-window", "-t", "boot", "-n", name).CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("new-window %q: %v\n%s", name, err, string(out))
		}
	}

	// Create a grouped mirror member sharing boot's windows (independent active
	// pointer). This is the condition under which a bare @N restore is ambiguous.
	mirrorCtx, mirrorCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if out, err := exec.CommandContext(mirrorCtx, "tmux", "-L", server, "new-session", "-d", "-t", "boot", "-s", "mirror").CombinedOutput(); err != nil {
		mirrorCancel()
		t.Fatalf("new-session -t boot -s mirror: %v\n%s", err, string(out))
	}
	mirrorCancel()

	// The dragged window (index 3). Resolve the session MoveWindow will operate on
	// exactly as MoveWindow does — a bare @N can resolve to either group member, so
	// the assertion below targets whichever session it picks rather than assuming a
	// name.
	dragged := windowID(t, server, "boot:3")
	resolveCtx, resolveCancel := context.WithTimeout(context.Background(), 5*time.Second)
	ownSession, _, err := resolveWindowSessionIndex(resolveCtx, server, dragged)
	resolveCancel()
	if err != nil {
		t.Fatalf("resolve owning session for %q: %v", dragged, err)
	}

	// Make the owning session's active window a NON-dragged window (index 1), and
	// point the other member at a different window so the two members' active
	// pointers diverge — the state under which a bare restore is unsafe.
	otherSession := "mirror"
	if ownSession == "mirror" {
		otherSession = "boot"
	}
	selectWindowCLI(t, server, otherSession+":0")
	selectWindowCLI(t, server, ownSession+":1")
	wantActive := windowID(t, server, ownSession)

	// Move a window the owning session is NOT viewing (index 3 -> index 0).
	if err := MoveWindow(dragged, 0, server); err != nil {
		t.Fatalf("MoveWindow(%q -> 0): %v", dragged, err)
	}

	// The reordered session's active window must be unchanged. The session-qualified
	// restore keeps the select scoped to the same member the swaps ran on, rather
	// than letting a bare @N leak the active-window change to another group member.
	if gotActive := windowID(t, server, ownSession); gotActive != wantActive {
		t.Errorf("after MoveWindow in session group: %s active window = %q, want %q (active window drifted)", ownSession, gotActive, wantActive)
	}
}

// TestSetWindowOptions_chainedSetAndUnset verifies the chained set-option
// primitive applies a mixed set+unset batch in one invocation against a real
// tmux server.
func TestSetWindowOptions_chainedSetAndUnset(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	// Pre-set @rk_win_layout so the batch can unset it while setting @rk_win_color/@rk_win_web_1.
	setupCtx, setupCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if out, err := exec.CommandContext(setupCtx, "tmux", "-L", server, "set-option", "-w", "-t", id, "@rk_win_layout", "single:web").CombinedOutput(); err != nil {
		setupCancel()
		t.Fatalf("pre-set @rk_win_layout: %v\n%s", err, string(out))
	}
	setupCancel()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	color := "5"
	url := "https://example.test"
	ops := []WindowOptionOp{
		{Key: "@rk_win_color", Value: &color},
		{Key: "@rk_win_web_1", Value: &url},
		{Key: "@rk_win_layout", Value: nil}, // unset
	}
	if err := SetWindowOptions(ctx, id, server, ops); err != nil {
		t.Fatalf("SetWindowOptions: %v", err)
	}

	if v, ok := windowOption(t, server, id, "@rk_win_color"); !ok || v != "5" {
		t.Errorf("@rk_win_color = %q (set=%v), want \"5\"", v, ok)
	}
	if v, ok := windowOption(t, server, id, "@rk_win_web_1"); !ok || v != url {
		t.Errorf("@rk_win_web_1 = %q (set=%v), want %q", v, ok, url)
	}
	if v, ok := windowOption(t, server, id, "@rk_win_layout"); ok {
		t.Errorf("@rk_win_layout = %q, want unset", v)
	}
}

// TestGetWindowOption_roundTrip verifies the getter reads back what
// SetWindowOption wrote and reports ("", nil) for an unset option, against a
// real tmux server.
func TestGetWindowOption_roundTrip(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if v, err := GetWindowOption(ctx, id, server, "@rk_win_web_1_root"); err != nil || v != "" {
		t.Errorf("unset option = (%q, %v), want (\"\", nil)", v, err)
	}

	if err := SetWindowOption(ctx, id, server, "@rk_win_web_1_root", "/tmp/some dir/root"); err != nil {
		t.Fatalf("SetWindowOption: %v", err)
	}
	if v, err := GetWindowOption(ctx, id, server, "@rk_win_web_1_root"); err != nil || v != "/tmp/some dir/root" {
		t.Errorf("set option = (%q, %v), want (\"/tmp/some dir/root\", nil)", v, err)
	}

	if err := UnsetWindowOption(ctx, id, server, "@rk_win_web_1_root"); err != nil {
		t.Fatalf("UnsetWindowOption: %v", err)
	}
	if v, err := GetWindowOption(ctx, id, server, "@rk_win_web_1_root"); err != nil || v != "" {
		t.Errorf("after unset = (%q, %v), want (\"\", nil)", v, err)
	}
}

func TestMoveWindowToSession_movesAndPreservesID(t *testing.T) {
	server := withSessionOrderTmux(t)

	// Create the destination session and a source window in the boot session.
	for _, args := range [][]string{
		{"new-session", "-d", "-s", "dst"},
		{"new-window", "-t", "boot", "-n", "mover"},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		full := append([]string{"-L", server}, args...)
		out, err := exec.CommandContext(ctx, "tmux", full...).CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("setup %v: %v\n%s", args, err, string(out))
		}
	}

	id := windowID(t, server, "boot:mover")

	if err := MoveWindowToSession(id, "dst", server); err != nil {
		t.Fatalf("MoveWindowToSession(%q -> dst): %v", id, err)
	}

	// tmux's move-window preserves the window id; only its owning session
	// changes. Verify the same id now resolves to the dst session.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	gotSession, err := ResolveWindowSession(ctx, server, id)
	if err != nil {
		t.Fatalf("resolve after move-to-session: %v", err)
	}
	if gotSession != "dst" {
		t.Errorf("after MoveWindowToSession: session = %q, want %q", gotSession, "dst")
	}
}

func TestLinkWindowToSession_linksAndPreservesID(t *testing.T) {
	server := withSessionOrderTmux(t)

	// Create the destination session and a source window in the boot session.
	for _, args := range [][]string{
		{"new-session", "-d", "-s", "dst"},
		{"new-window", "-t", "boot", "-n", "linker"},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		full := append([]string{"-L", server}, args...)
		out, err := exec.CommandContext(ctx, "tmux", full...).CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("setup %v: %v\n%s", args, err, string(out))
		}
	}

	id := windowID(t, server, "boot:linker")

	if err := LinkWindowToSession(id, "dst", server); err != nil {
		t.Fatalf("LinkWindowToSession(%q -> dst): %v", id, err)
	}

	// link-window makes the window a member of BOTH sessions (unlike move-window),
	// preserving its id. Verify the same id now appears in dst AND still in boot.
	windowsIn := func(session string) []string {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		lines, err := tmuxExecServer(ctx, server, "list-windows", "-t", ExactSessionTarget(session), "-F", "#{window_id}")
		if err != nil {
			t.Fatalf("list-windows %q: %v", session, err)
		}
		out := make([]string, 0, len(lines))
		for _, l := range lines {
			out = append(out, strings.TrimSpace(l))
		}
		return out
	}
	inSession := func(session string) bool {
		for _, w := range windowsIn(session) {
			if w == id {
				return true
			}
		}
		return false
	}
	if !inSession("dst") {
		t.Errorf("after LinkWindowToSession: window %q not present in dst", id)
	}
	if !inSession("boot") {
		t.Errorf("after LinkWindowToSession: window %q left boot (link must keep it a member of the source too)", id)
	}
}

// TestBuildSetWindowLayoutsArgv pins the chained argv shape: one
// `set-option -w -t <id> @rk_win_layout <value>` op per pair, ";"-chained in
// slice order.
func TestBuildSetWindowLayoutsArgv(t *testing.T) {
	got := buildSetWindowLayoutsArgv([]WindowLayoutWrite{
		{WindowID: "@7", Layout: "web"},
		{WindowID: "@9", Layout: "h(tty,@3/tty)"},
	})
	want := []string{
		"set-option", "-w", "-t", "@7", "@rk_win_layout", "web",
		";",
		"set-option", "-w", "-t", "@9", "@rk_win_layout", "h(tty,@3/tty)",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("argv = %v, want %v", got, want)
	}
}

// TestSetWindowLayouts_chainedTwoWindows verifies one invocation lands both
// windows' @rk_win_layout values, against a real (isolated) tmux server.
func TestSetWindowLayouts_chainedTwoWindows(t *testing.T) {
	server := withSessionOrderTmux(t)
	setupCtx, setupCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if out, err := exec.CommandContext(setupCtx, "tmux", "-L", server, "new-window", "-t", "boot", "-n", "second").CombinedOutput(); err != nil {
		setupCancel()
		t.Fatalf("new-window second: %v\n%s", err, string(out))
	}
	setupCancel()
	first := windowID(t, server, "boot:0")
	second := windowID(t, server, "boot:second")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pairs := []WindowLayoutWrite{
		{WindowID: first, Layout: "web"},
		{WindowID: second, Layout: "h(tty,web)"},
	}
	if err := SetWindowLayouts(ctx, server, pairs); err != nil {
		t.Fatalf("SetWindowLayouts: %v", err)
	}

	if v, ok := windowOption(t, server, first, "@rk_win_layout"); !ok || v != "web" {
		t.Errorf("first @rk_win_layout = %q (set=%v), want \"web\"", v, ok)
	}
	if v, ok := windowOption(t, server, second, "@rk_win_layout"); !ok || v != "h(tty,web)" {
		t.Errorf("second @rk_win_layout = %q (set=%v), want \"h(tty,web)\"", v, ok)
	}
}

// withSessionOrderTmux starts an isolated tmux server for session-order
// integration tests, runs fn, and cleans up. Skips the test if tmux is
// unavailable. Returns the server name fn should pass to tmux helpers.
func withSessionOrderTmux(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	server := testSocketName("unit")

	// Bootstrap: start a session so the server exists. Server-scoped options
	// require a running server.
	bootCtx, cancelBoot := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelBoot()
	cmd := exec.CommandContext(bootCtx, "tmux", "-L", server, "new-session", "-d", "-s", "boot")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("could not start isolated tmux server %q: %v\n%s", server, err, string(out))
	}

	t.Cleanup(func() {
		killCtx, cancelKill := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelKill()
		_ = exec.CommandContext(killCtx, "tmux", "-L", server, "kill-server").Run()
	})
	return server
}

func setRawServerOption(t *testing.T, ctx context.Context, server, option, value string) {
	t.Helper()
	args := append(serverArgs(server), "set-option", "-s", option, value)
	if out, err := exec.CommandContext(ctx, "tmux", args...).CombinedOutput(); err != nil {
		t.Fatalf("set %s: %v\n%s", option, err, string(out))
	}
}

func unsetRawServerOption(t *testing.T, ctx context.Context, server, option string) {
	t.Helper()
	args := append(serverArgs(server), "set-option", "-s", "-u", option)
	if out, err := exec.CommandContext(ctx, "tmux", args...).CombinedOutput(); err != nil {
		t.Fatalf("unset %s: %v\n%s", option, err, string(out))
	}
}

func TestSessionOrder(t *testing.T) {
	server := withSessionOrderTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("unset returns empty", func(t *testing.T) {
		got, err := GetSessionOrder(ctx, server)
		if err != nil {
			t.Fatalf("GetSessionOrder unset: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("got %v, want empty", got)
		}
	})

	cases := []struct {
		name string
		want []string
	}{
		{name: "round trip", want: []string{"main", "dev", "scratch"}},
		{name: "special characters", want: []string{`foo,bar`, `x"y`, `back\slash`, "café", "α-β"}},
		{name: "empty slice", want: []string{}},
		{name: "nil treated as empty", want: nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := SetSessionOrder(ctx, server, tc.want); err != nil {
				t.Fatalf("SetSessionOrder: %v", err)
			}
			got, err := GetSessionOrder(ctx, server)
			if err != nil {
				t.Fatalf("GetSessionOrder: %v", err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("len got=%d want=%d (got=%v want=%v)", len(got), len(tc.want), got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("idx %d: got %q want %q", i, got[i], tc.want[i])
				}
			}
		})
	}

	t.Run("invalid JSON returns syntax error", func(t *testing.T) {
		setRawServerOption(t, ctx, server, SessionOrderOption, "not-json")
		_, err := GetSessionOrder(ctx, server)
		if err == nil {
			t.Fatal("expected JSON decode error, got nil")
		}
		var syntaxErr *json.SyntaxError
		if !errors.As(err, &syntaxErr) {
			t.Errorf("expected wrapped *json.SyntaxError, got %v", err)
		}
	})
}

func TestServerRank(t *testing.T) {
	server := withSessionOrderTmux(t)
	deadServer := testSocketName("unit-dead")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("unset returns nil", func(t *testing.T) {
		got, err := GetServerRank(ctx, server)
		if err != nil {
			t.Fatalf("GetServerRank unset: %v", err)
		}
		if got != nil {
			t.Errorf("got %v, want nil (unset)", *got)
		}
	})

	t.Run("no server returns nil", func(t *testing.T) {
		got, err := GetServerRank(ctx, deadServer)
		if err != nil {
			t.Fatalf("GetServerRank on dead server: %v", err)
		}
		if got != nil {
			t.Errorf("got %v, want nil (no server)", *got)
		}
	})

	t.Run("set and overwrite round trip", func(t *testing.T) {
		for _, want := range []int{3, 0} {
			if err := SetServerRank(ctx, server, want); err != nil {
				t.Fatalf("SetServerRank(%d): %v", want, err)
			}
			got, err := GetServerRank(ctx, server)
			if err != nil {
				t.Fatalf("GetServerRank after %d: %v", want, err)
			}
			if got == nil || *got != want {
				t.Fatalf("got %v, want %d", got, want)
			}
		}
	})

	t.Run("malformed value returns error", func(t *testing.T) {
		setRawServerOption(t, ctx, server, ServerRankOption, "not-an-int")
		if _, err := GetServerRank(ctx, server); err == nil {
			t.Fatal("expected decode error for malformed rank, got nil")
		}
	})
}

func TestServerOrigin(t *testing.T) {
	server := withSessionOrderTmux(t)
	deadServer := testSocketName("unit-dead")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	for _, tc := range []struct {
		name   string
		server string
	}{
		{name: "unset returns empty", server: server},
		{name: "no server returns empty", server: deadServer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := GetServerOrigin(ctx, tc.server)
			if err != nil {
				t.Fatalf("GetServerOrigin: %v", err)
			}
			if got != "" {
				t.Errorf("got %q, want empty", got)
			}
		})
	}

	t.Run("set and overwrite round trip", func(t *testing.T) {
		const origin = "http://127.0.0.1:3001"
		if err := SetServerOrigin(ctx, server, origin); err != nil {
			t.Fatalf("SetServerOrigin: %v", err)
		}

		args := append(serverArgs(server), "show-option", "-sv", OriginOption)
		out, err := exec.CommandContext(ctx, "tmux", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("raw show-option: %v\n%s", err, string(out))
		}
		if got := strings.TrimSpace(string(out)); got != origin {
			t.Errorf("raw show-option = %q, want %q", got, origin)
		}

		for _, want := range []string{origin, "http://127.0.0.1:3005"} {
			if want != origin {
				if err := SetServerOrigin(ctx, server, want); err != nil {
					t.Fatalf("SetServerOrigin overwrite: %v", err)
				}
			}
			got, err := GetServerOrigin(ctx, server)
			if err != nil {
				t.Fatalf("GetServerOrigin: %v", err)
			}
			if got != want {
				t.Fatalf("got %q, want %q", got, want)
			}
		}
	})
}

func TestOperatorRoot(t *testing.T) {
	server := withSessionOrderTmux(t)
	deadServer := testSocketName("unit-dead")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	for _, tc := range []struct {
		name   string
		server string
	}{
		{name: "unset returns empty", server: server},
		{name: "no server returns empty", server: deadServer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := GetOperatorRoot(ctx, tc.server)
			if err != nil {
				t.Fatalf("GetOperatorRoot: %v", err)
			}
			if got != "" {
				t.Errorf("got %q, want empty", got)
			}
		})
	}

	t.Run("set and overwrite round trip", func(t *testing.T) {
		for _, want := range []string{"/home/u/proj", "/home/u/other repo"} {
			if err := SetOperatorRoot(ctx, server, want); err != nil {
				t.Fatalf("SetOperatorRoot(%q): %v", want, err)
			}
			got, err := GetOperatorRoot(ctx, server)
			if err != nil {
				t.Fatalf("GetOperatorRoot: %v", err)
			}
			if got != want {
				t.Fatalf("got %q, want %q", got, want)
			}
		}
	})
}

func TestEphemeralServerFlag(t *testing.T) {
	server := withSessionOrderTmux(t)
	deadServer := testSocketName("unit-dead")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cases := []struct {
		name    string
		server  string
		prepare func(*testing.T)
		want    bool
	}{
		{name: "current option set", server: server, prepare: func(t *testing.T) {
			setRawServerOption(t, ctx, server, EphemeralOption, "1")
		}, want: true},
		{name: "unset after set", server: server, prepare: func(t *testing.T) {
			setRawServerOption(t, ctx, server, EphemeralOption, "1")
			unsetRawServerOption(t, ctx, server, EphemeralOption)
		}},
		{name: "never set", server: server},
		{name: "no server", server: deadServer},
		{name: "mark reads back", server: server, prepare: func(t *testing.T) {
			if err := MarkServerEphemeral(ctx, server); err != nil {
				t.Fatalf("MarkServerEphemeral: %v", err)
			}
		}, want: true},
		{name: "legacy option set", server: server, prepare: func(t *testing.T) {
			setRawServerOption(t, ctx, server, LegacyEphemeralOption, "1")
		}, want: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.server == server {
				unsetRawServerOption(t, ctx, server, EphemeralOption)
				unsetRawServerOption(t, ctx, server, LegacyEphemeralOption)
			}
			if tc.prepare != nil {
				tc.prepare(t)
			}
			got, err := IsEphemeralServer(ctx, tc.server)
			if err != nil {
				t.Fatalf("IsEphemeralServer: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestProtectedServerFlag(t *testing.T) {
	server := withSessionOrderTmux(t)
	deadServer := testSocketName("unit-dead")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cases := []struct {
		name    string
		server  string
		prepare func(*testing.T)
		want    bool
	}{
		{name: "current option set", server: server, prepare: func(t *testing.T) {
			setRawServerOption(t, ctx, server, ProtectedOption, "1")
		}, want: true},
		{name: "unset after set", server: server, prepare: func(t *testing.T) {
			if err := MarkServerProtected(ctx, server); err != nil {
				t.Fatalf("MarkServerProtected: %v", err)
			}
			if err := UnmarkServerProtected(ctx, server); err != nil {
				t.Fatalf("UnmarkServerProtected: %v", err)
			}
		}},
		{name: "never set", server: server},
		{name: "no server", server: deadServer},
		{name: "legacy option set", server: server, prepare: func(t *testing.T) {
			setRawServerOption(t, ctx, server, LegacyProtectedOption, "1")
		}, want: true},
		{name: "unmark clears legacy option", server: server, prepare: func(t *testing.T) {
			setRawServerOption(t, ctx, server, LegacyProtectedOption, "1")
			if err := UnmarkServerProtected(ctx, server); err != nil {
				t.Fatalf("UnmarkServerProtected: %v", err)
			}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.server == server {
				unsetRawServerOption(t, ctx, server, ProtectedOption)
				unsetRawServerOption(t, ctx, server, LegacyProtectedOption)
			}
			if tc.prepare != nil {
				tc.prepare(t)
			}
			got, err := IsProtectedServer(ctx, tc.server)
			if err != nil {
				t.Fatalf("IsProtectedServer: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestGuardedServerFlag(t *testing.T) {
	server := withSessionOrderTmux(t)
	deadServer := testSocketName("unit-dead")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cases := []struct {
		name    string
		server  string
		prepare func(*testing.T)
		want    bool
	}{
		{name: "daemon name", server: productionDaemonServer, want: true},
		{name: "marked server", server: server, prepare: func(t *testing.T) {
			if err := MarkServerProtected(ctx, server); err != nil {
				t.Fatalf("MarkServerProtected: %v", err)
			}
		}, want: true},
		{name: "unmarked server", server: server},
		{name: "dead server", server: deadServer},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.server == server {
				unsetRawServerOption(t, ctx, server, ProtectedOption)
				unsetRawServerOption(t, ctx, server, LegacyProtectedOption)
			}
			if tc.prepare != nil {
				tc.prepare(t)
			}
			got, err := IsGuardedServer(ctx, tc.server)
			if err != nil {
				t.Fatalf("IsGuardedServer: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestManagedServerFlag(t *testing.T) {
	server := withSessionOrderTmux(t)
	deadServer := testSocketName("unit-dead")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cases := []struct {
		name    string
		server  string
		prepare func(*testing.T)
		want    bool
	}{
		{name: "marked server", server: server, prepare: func(t *testing.T) {
			if err := MarkServerManaged(ctx, server); err != nil {
				t.Fatalf("MarkServerManaged: %v", err)
			}
		}, want: true},
		{name: "unset after set", server: server, prepare: func(t *testing.T) {
			if err := MarkServerManaged(ctx, server); err != nil {
				t.Fatalf("MarkServerManaged: %v", err)
			}
			if err := UnmarkServerManaged(ctx, server); err != nil {
				t.Fatalf("UnmarkServerManaged: %v", err)
			}
		}},
		{name: "unmarked server", server: server},
		{name: "dead server", server: deadServer},
		{name: "daemon name", server: productionDaemonServer, want: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.server == server {
				unsetRawServerOption(t, ctx, server, ManagedOption)
			}
			if tc.prepare != nil {
				tc.prepare(t)
			}
			got, err := IsManagedServer(ctx, tc.server)
			if err != nil {
				t.Fatalf("IsManagedServer: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestServerAllowed(t *testing.T) {
	cases := []struct {
		name      string
		allowlist string // "" = unset
		set       bool
		server    string
		want      bool
	}{
		{name: "unset admits all", set: false, server: "default", want: true},
		{name: "blank admits all", set: true, allowlist: "  ", server: "default", want: true},
		{name: "exact match admitted", set: true, allowlist: "rk-test-e2e", server: "rk-test-e2e", want: true},
		{name: "prefix match admitted", set: true, allowlist: "rk-test-e2e", server: "rk-test-e2e-secondary", want: true},
		{name: "no match rejected", set: true, allowlist: "rk-test-e2e", server: "default", want: false},
		{name: "comma tokens", set: true, allowlist: "alpha, beta", server: "beta-1", want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.set {
				t.Setenv(ServerAllowlistEnv, tc.allowlist)
			} else {
				os.Unsetenv(ServerAllowlistEnv)
			}
			if got := ServerAllowed(tc.server); got != tc.want {
				t.Errorf("ServerAllowed(%q) = %v, want %v (allowlist %q)", tc.server, got, tc.want, tc.allowlist)
			}
		})
	}
}

// withRealSessionTmux starts an isolated tmux server with a "real" session
// containing two windows. Skips the test if tmux is unavailable. Returns
// (server, realSession).
// cleanTmuxCmd builds an exec.Cmd for a raw tmux invocation in a test with the
// ambient $TMUX stripped from the child's environment. When the test suite
// runs INSIDE a tmux pane, the pane's $TMUX leaks into the test process's env;
// a bare exec.CommandContext("tmux", ...) would then target the PANE's server
// (via that socket) rather than the isolated test server the -L flag names,
// corrupting both the test and the pane's server. The package init already
// strips $TMUX from the process, but raw exec.CommandContext calls in tests
// capture os.Environ() — which is evaluated per-call and can still carry a
// leaked $TMUX — so strip it explicitly on the child.
func cleanTmuxCmd(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "tmux", args...)
	env := os.Environ()
	filtered := env[:0]
	for _, kv := range env {
		if !strings.HasPrefix(kv, "TMUX=") {
			filtered = append(filtered, kv)
		}
	}
	cmd.Env = filtered
	return cmd
}

func withRealSessionTmux(t *testing.T) (string, string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	server := testSocketName("unit")
	real := "real"

	bootCtx, cancelBoot := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelBoot()
	cmd := exec.CommandContext(bootCtx, "tmux", "-L", server, "new-session", "-d", "-s", real, "-n", "win0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("could not start isolated tmux server %q: %v\n%s", server, err, string(out))
	}
	addCtx, cancelAdd := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelAdd()
	if out, err := exec.CommandContext(addCtx, "tmux", "-L", server, "new-window", "-t", real, "-n", "win1").CombinedOutput(); err != nil {
		t.Fatalf("create second window: %v\n%s", err, string(out))
	}

	t.Cleanup(func() {
		killCtx, cancelKill := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelKill()
		_ = exec.CommandContext(killCtx, "tmux", "-L", server, "kill-server").Run()
	})
	return server, real
}

// ResolveWindowSession returns the window's home (non-pin) session. An unpinned
// window has exactly one link, so it resolves to that session directly.
func TestResolveWindowSession_findsOwningSession(t *testing.T) {
	server, real := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	lines, err := tmuxExecServer(ctx, server, "list-windows", "-t", real, "-F", "#{window_id}")
	if err != nil || len(lines) == 0 {
		t.Fatalf("list-windows on real session: lines=%v err=%v", lines, err)
	}
	id := strings.TrimSpace(lines[0])

	got, err := ResolveWindowSession(ctx, server, id)
	if err != nil {
		t.Fatalf("ResolveWindowSession: %v", err)
	}
	if got != real {
		t.Errorf("ResolveWindowSession(%q) = %q, want %q", id, got, real)
	}
}

// ResolveWindowSession returns an error when the window ID does not exist on the
// server. The relay relies on this not-found contract to close the socket with
// code 4004 "Window not found".
func TestResolveWindowSession_notFound(t *testing.T) {
	server, _ := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	got, err := ResolveWindowSession(ctx, server, "@999999")
	if err == nil {
		t.Fatalf("ResolveWindowSession(@999999) = %q, want non-nil error", got)
	}
	// Assert the contract message, not just any error — guards against a raw
	// tmux stderr/exit-status error leaking through instead of the documented
	// `window %q not found` contract the relay (code 4004) depends on.
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("ResolveWindowSession(@999999) error = %q, want it to contain \"not found\"", err)
	}
}

func TestKillSessionCtx_killsSession(t *testing.T) {
	server, _ := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Create a throwaway session, then kill it via KillSessionCtx.
	if _, err := tmuxExecServer(ctx, server, "new-session", "-d", "-s", "victim"); err != nil {
		t.Fatalf("create victim session: %v", err)
	}
	if err := KillSessionCtx(ctx, server, "victim"); err != nil {
		t.Fatalf("KillSessionCtx: %v", err)
	}
	if _, err := tmuxExecRawServer(ctx, server, "has-session", "-t", "victim"); err == nil {
		t.Errorf("session 'victim' still present after KillSessionCtx")
	}
}

func TestListSessions_filtersPinSessions(t *testing.T) {
	server, real := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// `_rk-pin-*` and `_rk-iso-*` sessions must be filtered out of the
	// user-facing list.
	if _, err := tmuxExecServer(ctx, server, "new-session", "-d", "-s", PinSessionPrefix+"42"); err != nil {
		t.Fatalf("create pin session: %v", err)
	}
	if _, err := tmuxExecServer(ctx, server, "new-session", "-d", "-s", IsoSessionPrefix+"43"); err != nil {
		t.Fatalf("create iso session: %v", err)
	}

	got, err := ListSessions(ctx, server)
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	for _, s := range got {
		if IsHiddenLinkSession(s.Name) {
			t.Errorf("ListSessions returned hidden link-target session %q — should be filtered", s.Name)
		}
	}
	foundReal := false
	for _, s := range got {
		if s.Name == real {
			foundReal = true
		}
	}
	if !foundReal {
		t.Errorf("real session %q missing from ListSessions: %v", real, got)
	}
}

// sessionInfoSliceEqual compares two SessionInfo slices, treating nil and empty as equivalent.
func sessionInfoSliceEqual(a, b []SessionInfo) bool {
	if len(a) == 0 && len(b) == 0 {
		if a == nil && b == nil {
			return true
		}
		if a == nil && len(b) == 0 {
			return true
		}
		if b == nil && len(a) == 0 {
			return true
		}
		return len(a) == len(b)
	}
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Name != b[i].Name {
			return false
		}
		if a[i].Windows != b[i].Windows {
			return false
		}
		if (a[i].Color == nil) != (b[i].Color == nil) {
			return false
		}
		if a[i].Color != nil && *a[i].Color != *b[i].Color {
			return false
		}
	}
	return true
}

func TestIsTestServerName(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		// Unified test umbrella — every test socket starts with rk-test-,
		// including the formerly-distinct relay/tmuxctl/daemon roles and the
		// PID-stamped e2e secondaries.
		{"rk-test-unit-48213-1780032043508597000", true},
		{"rk-test-relay-48213-1780031796792405000", true},
		{"rk-test-tmuxctl-48213-1", true},
		{"rk-test-daemon-48213-1", true},
		{"rk-test-e2e", true},
		{"rk-test-e2e-multi-48213-1", true},
		{"rk-test-e2e-coupling-48213-1", true},

		// User-facing / production servers — NOT test artifacts.
		{"default", false},
		{"Some", false},
		{"rk-daemon", false},
		{"production", false},
		{"runkit", false},
		// Legacy prefixes are gone — they no longer match the single umbrella.
		{"rk-relay-test-20089-1", false},
		{"rk-verify-89115", false},
		{"rk-e2e-coupling-654810", false},
	}
	for _, tc := range cases {
		if got := IsTestServerName(tc.name); got != tc.want {
			t.Errorf("IsTestServerName(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestMatchesServerAllowlist(t *testing.T) {
	cases := []struct {
		name      string
		allowlist string
		server    string
		want      bool
	}{
		// Unset / empty / whitespace-only allowlist is treated as UNSET and
		// admits every server — an empty value never means "match nothing".
		{"unset admits any", "", "kit", true},
		{"unset admits test server", "", "rk-test-e2e", true},
		{"whitespace-only admits any", "   ", "runWork", true},

		// Exact match is the prefix-of-itself case.
		{"exact match", "rk-test-e2e", "rk-test-e2e", true},

		// Prefix admits this-run secondaries (rk-test-e2e-<role>-<pid>-<epoch>).
		{"prefix admits multi secondary", "rk-test-e2e", "rk-test-e2e-multi-4821-318204", true},
		{"prefix admits coupling secondary", "rk-test-e2e", "rk-test-e2e-coupling-4821-318211", true},

		// Comma-separated multi-token list, with surrounding whitespace trimmed.
		{"multi-token admits first prefix", "rk-test-e2e, rk-test-foo", "rk-test-e2e-multi-1-2", true},
		{"multi-token admits second prefix", "rk-test-e2e, rk-test-foo", "rk-test-foo", true},
		{"multi-token excludes non-member", "rk-test-e2e, rk-test-foo", "runWork", false},

		// Empty tokens (leading/trailing/double commas) are ignored, not
		// treated as a wildcard empty prefix. A value that is non-empty but
		// yields ONLY empty tokens has zero non-empty prefixes, so it matches
		// nothing (distinct from the "" / whitespace-only "unset" case above —
		// those short-circuit before tokenizing).
		{"empty tokens ignored still matches", ",rk-test-e2e,,", "rk-test-e2e", true},
		{"all-empty tokens match nothing", ",,", "kit", false},

		// Non-match: rk-test-e2e does NOT admit other rk-test-* roles, even
		// though they share the broader umbrella IsTestServerName matches.
		{"non-match operator server", "rk-test-e2e", "kit", false},
		{"non-match other rk-test role", "rk-test-e2e", "rk-test-relay-9001-1717", false},

		// The broader rk-test- umbrella token admits any rk-test-* role.
		{"umbrella admits e2e", "rk-test-", "rk-test-e2e", true},
		{"umbrella admits relay", "rk-test-", "rk-test-relay-9001-1717", true},
		{"umbrella excludes operator", "rk-test-", "runWork", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchesServerAllowlist(tc.server, tc.allowlist); got != tc.want {
				t.Errorf("matchesServerAllowlist(%q, %q) = %v, want %v", tc.server, tc.allowlist, got, tc.want)
			}
		})
	}
}

// TestSetExitEmptyOff sets the server-scoped exit-empty option to off and reads
// it back via `show-options -g`, asserting the imperative backstop reaches a
// live tmux server (the one path the embedded `-f` config never covers for
// hand-created/foreign servers). Change:
// 260602-a1wo-prevent-exit-empty-server-death.
func TestSetExitEmptyOff(t *testing.T) {
	server := withSessionOrderTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// The isolated server is created WITHOUT our `-f` config, so it starts at
	// tmux's default exit-empty=on — the exact gap that let `kit` inherit `on`.
	before, err := tmuxExecRawServer(ctx, server, "show-options", "-g", "-v", "exit-empty")
	if err != nil {
		t.Fatalf("read exit-empty before: %v", err)
	}
	if got := strings.TrimSpace(before); got != "on" {
		t.Logf("note: default exit-empty was %q (expected \"on\") — proceeding", got)
	}

	if err := SetExitEmptyOff(ctx, server); err != nil {
		t.Fatalf("SetExitEmptyOff: %v", err)
	}

	after, err := tmuxExecRawServer(ctx, server, "show-options", "-g", "-v", "exit-empty")
	if err != nil {
		t.Fatalf("read exit-empty after: %v", err)
	}
	if got := strings.TrimSpace(after); got != "off" {
		t.Errorf("exit-empty after SetExitEmptyOff = %q, want \"off\"", got)
	}

	// Idempotent — a second call is a no-op success.
	if err := SetExitEmptyOff(ctx, server); err != nil {
		t.Fatalf("SetExitEmptyOff (second call): %v", err)
	}
}

func TestIsServerGone(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{name: "nil error", err: nil, want: false},
		{name: "no server running", err: errors.New("exit status 1: no server running on /tmp/tmux-1001/utils"), want: true},
		{name: "failed to connect", err: errors.New("exit status 1: failed to connect to server"), want: true},
		{name: "No such file or directory", err: errors.New("exit status 1: error connecting to /tmp/tmux-1001/utils (No such file or directory)"), want: true},
		{name: "server exited unexpectedly (mid-teardown connect)", err: errors.New("exit status 1: server exited unexpectedly"), want: true},
		{name: "non-matching error", err: errors.New("exit status 1: some other tmux failure"), want: false},
		{name: "empty error message", err: errors.New(""), want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsServerGone(tc.err); got != tc.want {
				t.Errorf("IsServerGone(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestBuildCreateWindowArgs asserts the argv slice produced by
// buildCreateWindowArgs: an empty name omits the -n token entirely (so tmux's
// automatic-rename-format names the window to its folder basename), while a
// non-empty name pins it with -n <name>. The -t target is the exact-match
// session form `=<session>:` — new-window's -t is a window target, so a bare
// session name would first match a window of that name in the attached
// session and create the window there (the ext misroute, 2026-07-17).
func TestBuildCreateWindowArgs(t *testing.T) {
	cases := []struct {
		name    string
		session string
		winName string
		cwd     string
		want    []string
	}{
		{
			name:    "empty name omits -n",
			session: "dev",
			winName: "",
			cwd:     "/home/user/run-kit",
			want:    []string{"new-window", "-a", "-t", "=dev:", "-c", "/home/user/run-kit"},
		},
		{
			name:    "non-empty name pins with -n",
			session: "dev",
			winName: "feature",
			cwd:     "/home/user/run-kit",
			want:    []string{"new-window", "-a", "-t", "=dev:", "-n", "feature", "-c", "/home/user/run-kit"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildCreateWindowArgs(tc.session, tc.winName, tc.cwd)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("buildCreateWindowArgs(%q, %q, %q) =\n  %#v\nwant\n  %#v", tc.session, tc.winName, tc.cwd, got, tc.want)
			}
		})
	}
}

// TestSessionWindowNameCollision reproduces the 2026-07-17 "ext" misroute
// against a real tmux server: a session named X coexisting with a WINDOW named
// X in another session. CreateWindow and ListWindows pass session names into
// commands whose -t is a *window* target (new-window; list-panes, even under
// -s), where tmux matches a bare name against the current session's window
// names before trying it as a session name — creating the window in the wrong
// session and gluing the wrong session's panes onto the right session's
// windows. The exact-match target form (ExactSessionTarget) plus the window-id
// pane join must keep both operations pinned to the named session.
func TestSessionWindowNameCollision(t *testing.T) {
	server := withSessionOrderTmux(t) // provides session "boot"
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// In session "boot", create a window whose NAME collides with the session
	// created next.
	createHomeWindow(t, server, "boot", "victim")
	if err := CreateSession("victim", "/tmp", server); err != nil {
		t.Fatalf("create session victim: %v", err)
	}

	// CreateWindow targeting SESSION "victim" must land there — not next to
	// WINDOW "victim" inside boot (the misroute).
	if err := CreateWindow("victim", "newwin", "/tmp", server); err != nil {
		t.Fatalf("CreateWindow: %v", err)
	}
	victimWindows, err := ListWindows(ctx, "victim", server)
	if err != nil {
		t.Fatalf("ListWindows(victim): %v", err)
	}
	foundInVictim := false
	for _, w := range victimWindows {
		if w.Name == "newwin" {
			foundInVictim = true
		}
	}
	if !foundInVictim {
		t.Errorf("window %q not found in session victim — misrouted create; victim windows: %+v", "newwin", victimWindows)
	}
	bootWindows, err := ListWindows(ctx, "boot", server)
	if err != nil {
		t.Fatalf("ListWindows(boot): %v", err)
	}
	for _, w := range bootWindows {
		if w.Name == "newwin" {
			t.Errorf("window %q landed in session boot — the bare-name window-target misroute", "newwin")
		}
	}

	// Pane join: session victim's windows must carry their OWN panes, never
	// boot's (the index-join symptom was boot's pane IDs on victim's windows).
	bootPaneIDs := make(map[string]bool)
	for _, w := range bootWindows {
		for _, p := range w.Panes {
			bootPaneIDs[p.PaneID] = true
		}
	}
	for _, w := range victimWindows {
		if len(w.Panes) == 0 {
			t.Errorf("victim window %s (%s) has no panes — pane join failed", w.WindowID, w.Name)
		}
		for _, p := range w.Panes {
			if bootPaneIDs[p.PaneID] {
				t.Errorf("victim window %s carries boot's pane %s — cross-session pane misjoin", w.WindowID, p.PaneID)
			}
		}
	}
}

// TestExactSessionTarget pins the exact-match session target form: `=name:`.
// The `=` disables prefix/fnmatch matching; the trailing `:` forces session
// parsing on commands whose -t is a window target (new-window, list-panes),
// where a bare name is matched against the attached session's window names
// first — the session/window name-collision misroute.
func TestExactSessionTarget(t *testing.T) {
	cases := []struct{ session, want string }{
		{"planner", "=planner:"},
		{"0", "=0:"},                   // numeric session names must not parse as an index
		{"_rk-pin-42", "=_rk-pin-42:"}, // pin-sessions ride the same helper
	}
	for _, tc := range cases {
		if got := ExactSessionTarget(tc.session); got != tc.want {
			t.Errorf("ExactSessionTarget(%q) = %q, want %q", tc.session, got, tc.want)
		}
	}
	if got := exactWindowInSession("planner", "@4"); got != "=planner:@4" {
		t.Errorf("exactWindowInSession(planner, @4) = %q, want =planner:@4", got)
	}
}

// TestSetAgentSendBuffer_LeadingDash is the live regression test for the `--`
// option terminator in SetAgentSendBufferCtx. Without `--`, a message that starts
// with a dash (e.g. "--force is broken") is parsed by tmux set-buffer as flags
// and the command hard-fails; with `--`, the text is stored verbatim as the
// positional buffer data. It stores such text through SetAgentSendBufferCtx, then
// reads the named buffer back with `show-buffer -b` and asserts the round-trip
// is byte-for-byte the original. Skips when tmux is unavailable.
func TestSetAgentSendBuffer_LeadingDash(t *testing.T) {
	server := withSessionOrderTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cases := []string{
		"--force is broken",
		"-t is not a flag here",
		"-",
		"normal text no dash",
	}
	for _, text := range cases {
		t.Run(text, func(t *testing.T) {
			if err := SetAgentSendBufferCtx(ctx, text, server); err != nil {
				t.Fatalf("SetAgentSendBufferCtx(%q): %v", text, err)
			}
			got, err := tmuxExecRawServer(ctx, server, "show-buffer", "-b", AgentSendBuffer)
			if err != nil {
				t.Fatalf("show-buffer: %v", err)
			}
			// tmux show-buffer appends a trailing newline the stored value did
			// not carry; the buffer content is everything before it.
			got = strings.TrimSuffix(got, "\n")
			if got != text {
				t.Errorf("buffer round-trip = %q, want verbatim %q", got, text)
			}
		})
	}
}

func TestServerBirthDir(t *testing.T) {
	t.Run("resolvable home", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("HOME", dir)
		if got := ServerBirthDir(); got != dir {
			t.Errorf("ServerBirthDir() = %q, want %q", got, dir)
		}
	})
	t.Run("unresolvable home falls back to root", func(t *testing.T) {
		// An empty $HOME makes os.UserHomeDir error on unix; the fallback must
		// be "/" (always exists, can never dangle) — never an empty string,
		// which would silently no-op the cmd.Dir / -c pins.
		t.Setenv("HOME", "")
		if got := ServerBirthDir(); got != "/" {
			t.Errorf("ServerBirthDir() with empty HOME = %q, want %q", got, "/")
		}
	})
}

// sessionPathOf reads #{session_path} for one session on the given server.
func sessionPathOf(t *testing.T, server, session string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := tmuxExecRawServer(ctx, server, "display-message", "-t", ExactSessionTarget(session), "-p", "#{session_path}")
	if err != nil {
		t.Fatalf("read session_path of %q: %v", session, err)
	}
	return strings.TrimSpace(out)
}

// mustEvalSymlinks resolves symlinks so paths reported by tmux (which records
// the client's getcwd, i.e. the resolved physical path) compare equal to a
// possibly-symlinked $HOME (e.g. macOS /var → /private/var temp dirs).
func mustEvalSymlinks(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", path, err)
	}
	return resolved
}

// TestCreateSession_ServerBirthCwdIsHome proves the server-birth CWD pin
// (change 260720-ji0k): CreateSession first-touching a fresh socket births the
// tmux server from ServerBirthDir(), so — with no explicit -c — the session's
// start dir is the operator's home, NOT the rk process's own CWD (this test
// binary runs from the package dir, so a missing pin fails the assertion).
func TestCreateSession_ServerBirthCwdIsHome(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	server := testSocketName("unit")
	t.Cleanup(func() {
		killCtx, cancelKill := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelKill()
		_ = exec.CommandContext(killCtx, "tmux", "-L", server, "kill-server").Run()
	})

	// Empty cwd: no -c is passed, so the session_path exposes the birthing
	// client's working directory — exactly the pin under test.
	if err := CreateSession("birth", "", server); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	got := mustEvalSymlinks(t, sessionPathOf(t, server, "birth"))
	want := mustEvalSymlinks(t, ServerBirthDir())
	if got != want {
		t.Errorf("session_path = %q, want %q (server birth must be anchored to home, not rk's CWD)", got, want)
	}
}

// TestCreateSession_BirthStampsManaged proves the birth branch of the
// provenance stamp: CreateSession first-touching a fresh socket births the
// server, so the newborn must read managed.
func TestCreateSession_BirthStampsManaged(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	server := testSocketName("unit")
	t.Cleanup(func() {
		killCtx, cancelKill := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelKill()
		_ = exec.CommandContext(killCtx, "tmux", "-L", server, "kill-server").Run()
	})

	if err := CreateSession("birth", "", server); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got, err := IsManagedServer(ctx, server)
	if err != nil {
		t.Fatalf("IsManagedServer after birth: %v", err)
	}
	if !got {
		t.Error("got false, want true (a server this call birthed must be stamped managed)")
	}
}

// TestCreateSession_ExistingServerNotStamped proves the non-birth branch:
// adding a session to an already-live (unmarked) server writes no stamp —
// provenance must not lie about a server rk did not birth.
func TestCreateSession_ExistingServerNotStamped(t *testing.T) {
	// Boot the server WITHOUT going through CreateSession, so it is live but
	// carries no ManagedOption mark.
	server := withSessionOrderTmux(t)

	if err := CreateSession("extra", "", server); err != nil {
		t.Fatalf("CreateSession on live server: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got, err := IsManagedServer(ctx, server)
	if err != nil {
		t.Fatalf("IsManagedServer on unmarked live server: %v", err)
	}
	if got {
		t.Error("got true, want false (session create on an existing server writes no stamp)")
	}
}

// TestCapturePaneArgs asserts the capture-pane argv both variants produce: the
// -e ANSI-escape flag rides ONLY the echo-probe variant (CapturePaneCtx); the
// plain variant (`rk mux capture`) must emit no -e, and both capture the last
// N lines of scrollback (-p -S -N).
func TestCapturePaneArgs(t *testing.T) {
	plain := capturePaneArgs("%5", 50, false)
	for _, a := range plain {
		if a == "-e" {
			t.Errorf("plain capture argv %v carries -e, want no ANSI escapes", plain)
		}
	}
	escaped := capturePaneArgs("%5", 50, true)
	foundE := false
	for _, a := range escaped {
		if a == "-e" {
			foundE = true
		}
	}
	if !foundE {
		t.Errorf("escape capture argv %v missing -e (the echo probe depends on it)", escaped)
	}
	want := []string{"capture-pane", "-t", "%5", "-p", "-S", "-50"}
	if !reflect.DeepEqual(plain, want) {
		t.Errorf("capturePaneArgs(%%5, 50, false) =\n  %#v\nwant\n  %#v", plain, want)
	}
}

func TestKillPaneCtx(t *testing.T) {
	server, _ := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// A second pane in win0 gives us a kill target that leaves the session alive.
	lines, err := tmuxExecServer(ctx, server, "split-window", "-t", "real:win0", "-d", "-P", "-F", "#{pane_id}")
	if err != nil {
		t.Fatalf("split victim pane: %v", err)
	}
	victim := lines[0]

	if err := KillPaneCtx(ctx, victim, server); err != nil {
		t.Fatalf("KillPaneCtx(%s): %v", victim, err)
	}
	// tmux 3.6a's display-message succeeds (empty) on a missing pane, so verify
	// the kill through list-panes instead of PaneExists.
	remaining, err := tmuxExecServer(ctx, server, "list-panes", "-t", "real:win0", "-F", "#{pane_id}")
	if err != nil {
		t.Fatalf("list panes after kill: %v", err)
	}
	for _, id := range remaining {
		if id == victim {
			t.Errorf("pane %s still present after KillPaneCtx", victim)
		}
	}

	// A missing pane is a REAL error carrying tmux's diagnostic (unlike
	// KillActivePane's silent-success contract).
	if err := KillPaneCtx(ctx, "%999999", server); err == nil {
		t.Error("KillPaneCtx on a missing pane must error")
	} else if !strings.Contains(err.Error(), "can't find pane") {
		t.Errorf("KillPaneCtx error = %q, want tmux's \"can't find pane\" diagnostic", err)
	}
}

// liveWindowIDs lists the window IDs of one session on the given server.
func liveWindowIDs(t *testing.T, server, session string) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	lines, err := tmuxExecServer(ctx, server, "list-windows", "-t", ExactSessionTarget(session), "-F", "#{window_id}")
	if err != nil {
		t.Fatalf("list-windows on %q: %v", session, err)
	}
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, strings.TrimSpace(l))
	}
	return out
}

// liveSessionNames lists every session name on the given server.
func liveSessionNames(t *testing.T, server string) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	lines, err := tmuxExecServer(ctx, server, "list-sessions", "-F", "#{session_name}")
	if err != nil {
		t.Fatalf("list-sessions: %v", err)
	}
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, strings.TrimSpace(l))
	}
	return out
}

// liveWindowSession resolves the session a window lives in via a global
// list-windows scan — never display-message -t, which would ATTACH a client to
// the resolved session and keep an emptied session alive past its last window.
func liveWindowSession(t *testing.T, server, windowID string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	lines, err := tmuxExecServer(ctx, server, "list-windows", "-a", "-F", "#{window_id}\t#{session_name}")
	if err != nil {
		t.Fatalf("list-windows -a: %v", err)
	}
	for _, l := range lines {
		parts := strings.Split(l, "\t")
		if len(parts) == 2 && parts[0] == windowID {
			return parts[1]
		}
	}
	t.Fatalf("window %q not found on server %q", windowID, server)
	return ""
}

func containsStr(hay []string, needle string) bool {
	for _, s := range hay {
		if s == needle {
			return true
		}
	}
	return false
}

// TestOperatorPromoteDemoteLive exercises the full physical-promotion cycle
// against a live server: move-in creates the operator session detached and
// moves the window (idempotent on re-promote); the radio clear surfaces the
// displaced carrier; demote moves the window out to its cwd-basename session
// and the emptied operator session dies with its last window.
func TestOperatorPromoteDemoteLive(t *testing.T) {
	server, _ := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Pin both windows to a dedicated cwd so the demote destination is
	// deterministic regardless of the test binary's own cwd.
	workDir := t.TempDir()
	if out, err := cleanTmuxCmd(ctx, "-L", server, "new-session", "-d", "-s", "worksrc", "-c", workDir).CombinedOutput(); err != nil {
		t.Fatalf("create worksrc session: %v\n%s", err, string(out))
	}
	// worksrc starts with one window; add a sibling so the source survives.
	if out, err := cleanTmuxCmd(ctx, "-L", server, "new-window", "-t", ExactSessionTarget("worksrc"), "-c", workDir).CombinedOutput(); err != nil {
		t.Fatalf("create sibling window: %v\n%s", err, string(out))
	}

	ids := liveWindowIDs(t, server, "worksrc")
	if len(ids) != 2 {
		t.Fatalf("worksrc session windows = %v, want 2", ids)
	}
	win := ids[0]
	sibling := ids[1]

	// Promote: creates the operator session and moves the window in.
	if err := MoveWindowIntoOperatorSession(ctx, serverArgs(server), win); err != nil {
		t.Fatalf("MoveWindowIntoOperatorSession: %v", err)
	}
	if !containsStr(liveSessionNames(t, server), OperatorSessionName) {
		t.Fatalf("sessions = %v, want %s present", liveSessionNames(t, server), OperatorSessionName)
	}
	if got := liveWindowSession(t, server, win); got != OperatorSessionName {
		t.Errorf("window %q session = %q, want %q", win, got, OperatorSessionName)
	}
	// The source session keeps its remaining window (membership moved, not copied).
	if got := liveWindowIDs(t, server, "worksrc"); !containsStr(got, sibling) || containsStr(got, win) {
		t.Errorf("worksrc session windows = %v, want only %q", got, sibling)
	}

	// Re-promote is idempotent (already a member — no same-session move error).
	if err := MoveWindowIntoOperatorSession(ctx, serverArgs(server), win); err != nil {
		t.Fatalf("re-promote: %v", err)
	}

	// Demote moves the window out to its cwd-basename session. (An emptied
	// operator session dies with its last window only when no client is
	// attached — tmux keeps an attached client's current session alive. In
	// production there is no attached client; here the test's own
	// display-message reads attach one, so the destroy is asserted in the
	// endpoint/demote-of-last-window e2e, not here.)
	if err := DemoteWindowFromOperatorSession(ctx, serverArgs(server), win); err != nil {
		t.Fatalf("DemoteWindowFromOperatorSession: %v", err)
	}
	wantDest := filepath.Base(workDir)
	if got := liveWindowSession(t, server, win); got != wantDest {
		t.Errorf("window %q session = %q after demote, want %q (cwd basename)", win, got, wantDest)
	}

	// Demote on a non-member is a no-op.
	if err := DemoteWindowFromOperatorSession(ctx, serverArgs(server), sibling); err != nil {
		t.Fatalf("demote non-member: %v", err)
	}

	// Radio displacement: promote sibling while win holds the role — the clear
	// surfaces win as the displaced carrier, demote moves it out, and the
	// operator session ends holding exactly the new operator.
	if err := SetWindowOption(ctx, win, server, RoleOption, "operator"); err != nil {
		t.Fatalf("set role on %q: %v", win, err)
	}
	if err := MoveWindowIntoOperatorSession(ctx, serverArgs(server), win); err != nil {
		t.Fatalf("re-promote %q: %v", win, err)
	}
	cleared, err := ClearWindowRoleExcept(ctx, serverArgs(server), sibling)
	if err != nil {
		t.Fatalf("ClearWindowRoleExcept: %v", err)
	}
	if len(cleared) != 1 || cleared[0] != win {
		t.Errorf("cleared = %v, want [%s] (the displaced carrier)", cleared, win)
	}
	for _, id := range cleared {
		if err := DemoteWindowFromOperatorSession(ctx, serverArgs(server), id); err != nil {
			t.Fatalf("demote displaced %q: %v", id, err)
		}
	}
	if err := SetWindowOption(ctx, sibling, server, RoleOption, "operator"); err != nil {
		t.Fatalf("set role on %q: %v", sibling, err)
	}
	if err := MoveWindowIntoOperatorSession(ctx, serverArgs(server), sibling); err != nil {
		t.Fatalf("promote sibling: %v", err)
	}
	opWindows := liveWindowIDs(t, server, OperatorSessionName)
	if len(opWindows) != 1 || opWindows[0] != sibling {
		t.Errorf("operator session windows = %v, want exactly [%s]", opWindows, sibling)
	}
	if got := liveWindowSession(t, server, win); got == OperatorSessionName {
		t.Errorf("displaced window %q still in %q", win, OperatorSessionName)
	}

	// Collision tolerance: a pre-existing user session carrying the operator
	// session's name is adopted — promote still moves in, and the mixed
	// population keeps it visible (the FetchSessions content rule's concern;
	// the move itself must not fail).
	foreignDir := t.TempDir()
	if out, err := cleanTmuxCmd(ctx, "-L", server, "new-session", "-d", "-s", "usersess", "-c", foreignDir).CombinedOutput(); err != nil {
		t.Fatalf("create foreign session: %v\n%s", err, string(out))
	}
	foreignWin := liveWindowIDs(t, server, "usersess")[0]
	if err := MoveWindowToSession(foreignWin, OperatorSessionName, server); err != nil {
		t.Fatalf("move foreign window into operator session: %v", err)
	}
	// A dedicated promote source (its own session survives the move).
	promoteDir := t.TempDir()
	if out, err := cleanTmuxCmd(ctx, "-L", server, "new-session", "-d", "-s", "promotesrc", "-c", promoteDir).CombinedOutput(); err != nil {
		t.Fatalf("create promotesrc session: %v\n%s", err, string(out))
	}
	promoteWin := liveWindowIDs(t, server, "promotesrc")[0]
	if err := MoveWindowIntoOperatorSession(ctx, serverArgs(server), promoteWin); err != nil {
		t.Fatalf("promote into a pre-existing operator session: %v", err)
	}
	if got := liveWindowIDs(t, server, OperatorSessionName); !containsStr(got, promoteWin) || !containsStr(got, foreignWin) {
		t.Errorf("operator session windows = %v, want both the promoted %q and foreign %q", got, promoteWin, foreignWin)
	}
}

// TestActiveWindowID_reportsSelectedWindow verifies the post-select read the
// window-select handler composes its response from: after a session-scoped
// select, ActiveWindowID reports the newly active window of that session.
func TestActiveWindowID_reportsSelectedWindow(t *testing.T) {
	server := withSessionOrderTmux(t)

	// Second window in the boot session — boot starts with exactly one.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, err := cleanTmuxCmd(ctx, "-L", server, "new-window", "-t", ExactSessionTarget("boot")).CombinedOutput(); err != nil {
		t.Fatalf("new-window: %v\n%s", err, string(out))
	}
	lines, err := tmuxExecServer(ctx, server, "list-windows", "-t", ExactSessionTarget("boot"), "-F", "#{window_id}")
	if err != nil {
		t.Fatalf("list-windows: %v", err)
	}
	if len(lines) != 2 {
		t.Fatalf("boot windows = %v, want 2", lines)
	}
	first, second := lines[0], lines[1]

	if err := SelectWindowInSession("boot", first, server); err != nil {
		t.Fatalf("select %q: %v", first, err)
	}
	if got, err := ActiveWindowID(ctx, server, "boot"); err != nil || got != first {
		t.Errorf("ActiveWindowID = %q, %v; want %q", got, err, first)
	}

	if err := SelectWindowInSession("boot", second, server); err != nil {
		t.Fatalf("select %q: %v", second, err)
	}
	if got, err := ActiveWindowID(ctx, server, "boot"); err != nil || got != second {
		t.Errorf("ActiveWindowID = %q, %v; want %q", got, err, second)
	}
}

// TestActiveWindowID_missingSessionErrors pins the failure shape the handler's
// fallback keys on: a read against a nonexistent session MUST error.
func TestActiveWindowID_missingSessionErrors(t *testing.T) {
	server := withSessionOrderTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := ActiveWindowID(ctx, server, "no-such-session"); err == nil {
		t.Error("ActiveWindowID on a missing session must return an error")
	}
}

// clientLine builds a tab-delimited list-clients line in clientFormat order:
// tty, width, height, session_name, session_group, session_group_list, flags.
func clientLine(tty string, width, height int, session, group, groupList, flags string) string {
	return strings.Join([]string{
		tty, strconv.Itoa(width), strconv.Itoa(height), session, group, groupList, flags,
	}, listDelim)
}

// clientLine11 builds the full 11-field clientFormat line.
func clientLine11(tty string, width, height int, session, group, groupList, flags, pid, created, activity, termname string) string {
	return strings.Join([]string{
		tty, strconv.Itoa(width), strconv.Itoa(height), session, group, groupList, flags,
		pid, created, activity, termname,
	}, listDelim)
}

func TestParseClients(t *testing.T) {
	tests := []struct {
		name  string
		lines []string
		want  []ClientInfo
	}{
		{
			// The live-diagnosis fixture: two sized attached clients plus the
			// rk daemon's tmuxctl control-mode subscription — only the two
			// sized viewers survive.
			name: "keeps sized attached clients, excludes the control-mode subscription",
			lines: []string{
				clientLine("/dev/pts/5", 144, 91, "runKit", "", "", "attached,UTF-8"),
				clientLine("/dev/pts/8", 116, 37, "runKit", "", "", "attached,focused,UTF-8"),
				clientLine("/dev/pts/11", 80, 0, "runKit", "", "", "attached,focused,control-mode,ignore-size,read-only,UTF-8"),
			},
			want: []ClientInfo{
				{TTY: "/dev/pts/5", Width: 144, Height: 91, SessionName: "runKit", Flags: []string{"attached", "UTF-8"}},
				{TTY: "/dev/pts/8", Width: 116, Height: 37, SessionName: "runKit", Flags: []string{"attached", "focused", "UTF-8"}},
			},
		},
		{
			name: "excludes a client flagged ignore-size alone",
			lines: []string{
				clientLine("/dev/pts/1", 120, 40, "alpha", "", "", "attached,ignore-size,UTF-8"),
			},
			want: nil,
		},
		{
			name: "matches flags as comma-split tokens, not substrings",
			lines: []string{
				clientLine("/dev/pts/1", 120, 40, "alpha", "", "", "attached,pre-control-mode-post,UTF-8"),
			},
			want: []ClientInfo{
				{TTY: "/dev/pts/1", Width: 120, Height: 40, SessionName: "alpha", Flags: []string{"attached", "pre-control-mode-post", "UTF-8"}},
			},
		},
		{
			name: "drops unsized clients (non-positive width or height)",
			lines: []string{
				clientLine("/dev/pts/1", 0, 40, "alpha", "", "", "attached"),
				clientLine("/dev/pts/2", 120, -1, "alpha", "", "", "attached"),
				clientLine("/dev/pts/3", 120, 40, "alpha", "", "", "attached"),
			},
			want: []ClientInfo{
				{TTY: "/dev/pts/3", Width: 120, Height: 40, SessionName: "alpha", Flags: []string{"attached"}},
			},
		},
		{
			name: "skips short lines",
			lines: []string{
				strings.Join([]string{"/dev/pts/1", "120", "40"}, listDelim),
			},
			want: nil,
		},
		{
			name: "parses the 11-field identity fields",
			lines: []string{
				clientLine11("pts/3", 144, 91, "main", "", "", "attached,focused", "4242", "1757500000", "1757500300", "xterm-256color"),
			},
			want: []ClientInfo{
				{TTY: "pts/3", Width: 144, Height: 91, SessionName: "main", Flags: []string{"attached", "focused"}, PID: 4242, Created: time.Unix(1757500000, 0), Activity: time.Unix(1757500300, 0), TermName: "xterm-256color"},
			},
		},
		{
			// Older tmux without client_pid/created/activity/termname: the
			// 7-field floor keeps the viewer with zero identity values.
			name: "7-field legacy line survives with zero identity values",
			lines: []string{
				clientLine("/dev/pts/1", 120, 40, "alpha", "", "", "attached"),
			},
			want: []ClientInfo{
				{TTY: "/dev/pts/1", Width: 120, Height: 40, SessionName: "alpha", Flags: []string{"attached"}},
			},
		},
		{
			name: "non-numeric client_pid yields 0, line kept",
			lines: []string{
				clientLine11("/dev/pts/1", 120, 40, "alpha", "", "", "attached", "abc", "1757500000", "1757500300", "xterm-256color"),
			},
			want: []ClientInfo{
				{TTY: "/dev/pts/1", Width: 120, Height: 40, SessionName: "alpha", Flags: []string{"attached"}, PID: 0, Created: time.Unix(1757500000, 0), Activity: time.Unix(1757500300, 0), TermName: "xterm-256color"},
			},
		},
		{
			name: "control-mode on an 11-field line is still dropped",
			lines: []string{
				clientLine11("/dev/pts/11", 80, 24, "runKit", "", "", "attached,control-mode", "4242", "1757500000", "1757500300", "xterm-256color"),
			},
			want: nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseClients(tt.lines)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseClients() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestClientInfoSessionKey(t *testing.T) {
	tests := []struct {
		name   string
		client ClientInfo
		want   string
	}{
		{
			name:   "ungrouped client keys on its own session name",
			client: ClientInfo{SessionName: "runKit"},
			want:   "runKit",
		},
		{
			// A client attached via a derived group copy sizes the leader's
			// shared windows, so it must count against the leader row
			// parseSessions keeps.
			name:   "group-copy attach keys on the leader name from session_group",
			client: ClientInfo{SessionName: "devshell-82", SessionGroup: "devshell", SessionGroupList: "devshell,devshell-82"},
			want:   "devshell",
		},
		{
			// tmux 3.6a reports #{session_group} as an opaque NUMERIC group id
			// — the member-name list is the cross-version cross-reference.
			name:   "numeric session_group id falls back to the member-name list",
			client: ClientInfo{SessionName: "devshell-82", SessionGroup: "0", SessionGroupList: "devshell,devshell-82"},
			want:   "devshell",
		},
		{
			name:   "grouped attach with anchor-only list prefix skips _rk-ctl",
			client: ClientInfo{SessionName: "devshell-82", SessionGroup: "0", SessionGroupList: "_rk-ctl,devshell"},
			want:   "devshell",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.client.SessionKey(); got != tt.want {
				t.Errorf("SessionKey() = %q, want %q", got, tt.want)
			}
		})
	}
}

// ListClients against a dead/absent server degrades to nil, nil (the
// ListSessions idiom) — never an error the fetch path has to special-case.
func TestListClients_goneServer(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	clients, err := ListClients(ctx, "rk-no-such-server-list-clients")
	if err != nil {
		t.Fatalf("ListClients on a gone server = %v, want nil", err)
	}
	if clients != nil {
		t.Errorf("ListClients on a gone server = %+v, want nil", clients)
	}
}

// TestClassifyProbe covers the pure three-way probe classification: exit 0 is
// alive, a fast failure (dead-socket refusal) is dead, and a failure under an
// expired probe deadline is timeout — the case that must NOT read as dead.
func TestClassifyProbe(t *testing.T) {
	cases := []struct {
		name   string
		runErr error
		ctxErr error
		want   probeResult
	}{
		{"exit 0 is alive", nil, nil, probeAlive},
		{"fast failure is dead", errors.New("exit status 1"), nil, probeDead},
		{"fast failure under canceled parent is still dead", errors.New("exit status 1"), context.Canceled, probeDead},
		{"deadline-exceeded kill is timeout", errors.New("signal: killed"), context.DeadlineExceeded, probeTimeout},
		{"success under an expired deadline is still alive", nil, context.DeadlineExceeded, probeAlive},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyProbe(tc.runErr, tc.ctxErr); got != tc.want {
				t.Errorf("classifyProbe(%v, %v) = %d, want %d", tc.runErr, tc.ctxErr, got, tc.want)
			}
		})
	}
}

// TestKeepFromProbes covers ListServers' keep/drop matrix: alive keeps, dead
// drops (no retry), and a first-probe timeout keeps the server unless the
// retry refuses instantly (which proves the socket dead).
func TestKeepFromProbes(t *testing.T) {
	cases := []struct {
		name  string
		first probeResult
		retry probeResult
		want  bool
	}{
		{"alive keeps", probeAlive, probeAlive, true},
		{"dead drops without retry", probeDead, probeDead, false},
		{"timeout then retry alive keeps", probeTimeout, probeAlive, true},
		{"timeout then retry dead drops", probeTimeout, probeDead, false},
		{"timeout then retry timeout keeps", probeTimeout, probeTimeout, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := keepFromProbes(tc.first, tc.retry); got != tc.want {
				t.Errorf("keepFromProbes(%d, %d) = %v, want %v", tc.first, tc.retry, got, tc.want)
			}
		})
	}
}

// TestParseServerMarks covers the pure dump parser: new-name-first reads, the
// legacy fallback on absence-from-dump, new-wins precedence (including an
// explicitly empty new value), quote stripping, malformed-rank errors, and
// empty dumps.
func TestParseServerMarks(t *testing.T) {
	rank3 := 3
	cases := []struct {
		name    string
		dump    string
		want    ServerMarks
		wantErr bool
	}{
		{
			name: "empty dump reads zero marks",
			dump: "",
			want: ServerMarks{},
		},
		{
			name: "new names set",
			dump: "@rk_srv_rank 3\n@rk_srv_ephemeral 1\n@rk_srv_protected 1\n@rk_srv_managed 1\n",
			want: ServerMarks{Rank: &rank3, Ephemeral: true, Protected: true, Managed: true},
		},
		{
			name: "legacy-only ephemeral falls back",
			dump: "@rk_ephemeral 1\n",
			want: ServerMarks{Ephemeral: true},
		},
		{
			name: "legacy-only protected falls back",
			dump: "@rk_protected 1\n",
			want: ServerMarks{Protected: true},
		},
		{
			name: "both absent reads false",
			dump: "buffer-limit 20\n",
			want: ServerMarks{},
		},
		{
			name: "both set: new wins",
			dump: "@rk_srv_ephemeral 1\n@rk_ephemeral \"\"\n",
			want: ServerMarks{Ephemeral: true},
		},
		{
			name: "new present but empty: legacy NOT consulted",
			dump: "@rk_srv_ephemeral \"\"\n@rk_ephemeral 1\n",
			want: ServerMarks{},
		},
		{
			name: "quoted rank value is stripped",
			dump: "@rk_srv_rank \"3\"\n",
			want: ServerMarks{Rank: &rank3},
		},
		{
			name: "empty rank reads nil",
			dump: "@rk_srv_rank \"\"\n",
			want: ServerMarks{},
		},
		{
			name:    "malformed rank errors",
			dump:    "@rk_srv_rank not-an-int\n",
			wantErr: true,
		},
		{
			name: "managed has no legacy fallback",
			dump: "@rk_srv_managed 1\n",
			want: ServerMarks{Managed: true},
		},
		{
			name: "unrelated options are ignored",
			dump: "activity-action other\nassume-paste-time 1\nbuffer-limit 20\n",
			want: ServerMarks{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseServerMarks(tc.dump)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseServerMarks(%q) = nil error, want decode error", tc.dump)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseServerMarks(%q): %v", tc.dump, err)
			}
			if (got.Rank == nil) != (tc.want.Rank == nil) ||
				(got.Rank != nil && tc.want.Rank != nil && *got.Rank != *tc.want.Rank) {
				t.Errorf("Rank = %v, want %v", got.Rank, tc.want.Rank)
			}
			if got.Ephemeral != tc.want.Ephemeral {
				t.Errorf("Ephemeral = %v, want %v", got.Ephemeral, tc.want.Ephemeral)
			}
			if got.Protected != tc.want.Protected {
				t.Errorf("Protected = %v, want %v", got.Protected, tc.want.Protected)
			}
			if got.Managed != tc.want.Managed {
				t.Errorf("Managed = %v, want %v", got.Managed, tc.want.Managed)
			}
		})
	}
}

// TestReadServerMarks exercises the exported reader end-to-end: a dead server
// reads zero marks with a nil error (gone-server taxonomy), and a live server
// round-trips rank, new-name ephemeral, legacy-name protected, and managed
// through the real show-options -s dump.
func TestReadServerMarks(t *testing.T) {
	server := withSessionOrderTmux(t)
	deadServer := testSocketName("unit-dead")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("gone server reads zero marks, nil error", func(t *testing.T) {
		got, err := ReadServerMarks(ctx, deadServer)
		if err != nil {
			t.Fatalf("ReadServerMarks on dead server: %v", err)
		}
		if got != (ServerMarks{}) {
			t.Errorf("got %+v, want zero ServerMarks", got)
		}
	})

	t.Run("unset marks read zero", func(t *testing.T) {
		got, err := ReadServerMarks(ctx, server)
		if err != nil {
			t.Fatalf("ReadServerMarks unset: %v", err)
		}
		if got != (ServerMarks{}) {
			t.Errorf("got %+v, want zero ServerMarks", got)
		}
	})

	t.Run("marks round trip through the dump", func(t *testing.T) {
		setRawServerOption(t, ctx, server, ServerRankOption, "3")
		setRawServerOption(t, ctx, server, EphemeralOption, "1")
		setRawServerOption(t, ctx, server, LegacyProtectedOption, "1")
		setRawServerOption(t, ctx, server, ManagedOption, "1")

		got, err := ReadServerMarks(ctx, server)
		if err != nil {
			t.Fatalf("ReadServerMarks: %v", err)
		}
		if got.Rank == nil || *got.Rank != 3 {
			t.Errorf("Rank = %v, want 3", got.Rank)
		}
		if !got.Ephemeral {
			t.Error("Ephemeral = false, want true (new name)")
		}
		if !got.Protected {
			t.Error("Protected = false, want true (legacy fallback)")
		}
		if !got.Managed {
			t.Error("Managed = false, want true")
		}
	})
}

func TestBuildCreateWindowWithCommandArgs(t *testing.T) {
	v := "split-h:tty,web"
	cases := []struct {
		name     string
		session  string
		winName  string
		cwd      string
		shellCmd string
		ops      []WindowOptionOp
		want     []string
	}{
		{
			name:    "no command, no cwd, no ops",
			session: "kit",
			winName: "»fox",
			want: []string{"new-window", "-P", "-F",
				"#{session_name}\t#{window_id}\t#{pane_id}",
				"-a", "-t", "=kit:", "-n", "»fox"},
		},
		{
			name:     "command sits before the chained option ops",
			session:  "kit",
			winName:  "»fox",
			cwd:      "/wt/fox",
			shellCmd: `'claude' '--model' 'opus'; exec "${SHELL:-/bin/sh}"`,
			ops:      []WindowOptionOp{{Key: LayoutOption, Value: &v}},
			want: []string{"new-window", "-P", "-F",
				"#{session_name}\t#{window_id}\t#{pane_id}",
				"-a", "-t", "=kit:", "-n", "»fox", "-c", "/wt/fox",
				`'claude' '--model' 'opus'; exec "${SHELL:-/bin/sh}"`,
				";", "set-option", "-w", LayoutOption, "split-h:tty,web"},
		},
		{
			name:    "ops chain without a command",
			session: "my session",
			winName: "w",
			ops:     []WindowOptionOp{{Key: LayoutOption, Value: &v}},
			want: []string{"new-window", "-P", "-F",
				"#{session_name}\t#{window_id}\t#{pane_id}",
				"-a", "-t", "=my session:", "-n", "w",
				";", "set-option", "-w", LayoutOption, "split-h:tty,web"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildCreateWindowWithCommandArgs(tc.session, tc.winName, tc.cwd, tc.shellCmd, tc.ops)
			if len(got) != len(tc.want) {
				t.Fatalf("args = %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("args = %v, want %v (first diff at %d)", got, tc.want, i)
				}
			}
		})
	}
}

func TestParseWindowBirth(t *testing.T) {
	cases := []struct {
		name    string
		line    string
		want    WindowBirth
		wantErr bool
	}{
		{
			name: "three tab-separated fields",
			line: "kit\t@42\t%97",
			want: WindowBirth{Session: "kit", WindowID: "@42", PaneID: "%97"},
		},
		{
			name: "session with spaces survives the tab split",
			line: "my session\t@1\t%2",
			want: WindowBirth{Session: "my session", WindowID: "@1", PaneID: "%2"},
		},
		{name: "two fields error", line: "kit\t@42", wantErr: true},
		{name: "four fields error", line: "kit\t@42\t%97\textra", wantErr: true},
		{name: "empty line errors", line: "", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseWindowBirth(tc.line)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseWindowBirth(%q) = %+v, want an error", tc.line, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseWindowBirth(%q): %v", tc.line, err)
			}
			if got != tc.want {
				t.Errorf("parseWindowBirth(%q) = %+v, want %+v", tc.line, got, tc.want)
			}
		})
	}
}

// TestSanitizeEnvReappliesUTF8Locale proves a born server's environment passes
// tmux's UTF-8 client rule even when the direnv-diff reversal removes the only
// locale variable: direnv added LC_CTYPE (present in n, absent from p), the
// process has no LANG, so reversal strips LC_CTYPE — and sanitizeEnv puts the
// C.UTF-8 assignment back. A UTF-8 variable that survives reversal is left
// alone.
func TestSanitizeEnvReappliesUTF8Locale(t *testing.T) {
	diff := makeDirenvDiff(t, map[string]string{}, map[string]string{"LC_CTYPE": "en_US.UTF-8"})
	got := sanitizeEnv([]string{"PATH=/usr/bin", "LC_CTYPE=en_US.UTF-8", "DIRENV_DIFF=" + diff})
	if slices.Contains(got, "LC_CTYPE=en_US.UTF-8") {
		t.Fatalf("direnv-added LC_CTYPE survived reversal: %v", got)
	}
	if !slices.Contains(got, "LC_CTYPE=C.UTF-8") {
		t.Fatalf("sanitized env lacks a UTF-8 locale: %v", got)
	}

	got = sanitizeEnv([]string{"PATH=/usr/bin", "LANG=en_IN.UTF-8", "DIRENV_DIFF=" + diff, "LC_CTYPE=en_US.UTF-8"})
	if slices.Contains(got, "LC_CTYPE=C.UTF-8") || !slices.Contains(got, "LANG=en_IN.UTF-8") {
		t.Fatalf("surviving UTF-8 LANG must leave the env alone: %v", got)
	}
}

// TestRefreshDefaultConfigPath covers the serve-time re-resolution: package
// init resolves DefaultConfigPath before the home migration can publish the
// new config home, so the first post-upgrade boot must re-resolve or the
// managed-conf refresh would rewrite the legacy file. A legacy-only home is
// a no-op; once the new home exists the managed resolution follows it, while
// a user-owned configPath (tmux_conf key / RK_TMUX_CONF) stays put.
func TestRefreshDefaultConfigPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	legacyDir := filepath.Join(home, ".config", "run-kit")
	newDir := filepath.Join(home, ".config", "hexokit")
	if err := os.MkdirAll(legacyDir, 0o755); err != nil {
		t.Fatal(err)
	}

	origDefault, origConfig, origManaged := DefaultConfigPath, configPath, managedConfigPath
	t.Cleanup(func() {
		DefaultConfigPath, configPath, managedConfigPath = origDefault, origConfig, origManaged
	})

	t.Run("legacy-only home is a no-op", func(t *testing.T) {
		DefaultConfigPath = filepath.Join(legacyDir, "tmux.conf")
		configPath = DefaultConfigPath
		managedConfigPath = true

		RefreshDefaultConfigPath()

		if DefaultConfigPath != filepath.Join(legacyDir, "tmux.conf") {
			t.Errorf("DefaultConfigPath = %q, want unchanged legacy path", DefaultConfigPath)
		}
	})

	t.Run("managed resolution follows the published home", func(t *testing.T) {
		DefaultConfigPath = filepath.Join(legacyDir, "tmux.conf")
		configPath = DefaultConfigPath
		managedConfigPath = true
		if err := os.MkdirAll(newDir, 0o755); err != nil {
			t.Fatal(err)
		}

		RefreshDefaultConfigPath()

		want := filepath.Join(newDir, "tmux.conf")
		if DefaultConfigPath != want {
			t.Errorf("DefaultConfigPath = %q, want %q", DefaultConfigPath, want)
		}
		if configPath != want {
			t.Errorf("configPath = %q, want %q (managed path follows)", configPath, want)
		}
		if !managedConfigPath {
			t.Error("managedConfigPath flipped; want still managed")
		}
	})

	t.Run("user-owned config path stays put", func(t *testing.T) {
		DefaultConfigPath = filepath.Join(legacyDir, "tmux.conf")
		userPath := filepath.Join(home, "my-tmux.conf")
		configPath = userPath
		managedConfigPath = false

		RefreshDefaultConfigPath()

		if DefaultConfigPath != filepath.Join(newDir, "tmux.conf") {
			t.Errorf("DefaultConfigPath = %q, want the new home's path", DefaultConfigPath)
		}
		if configPath != userPath {
			t.Errorf("configPath = %q, want user-owned %q", configPath, userPath)
		}
		if managedConfigPath {
			t.Error("managedConfigPath flipped; want still user-owned")
		}
	})
}
