package tmux

import (
	"reflect"
	"strings"
	"testing"
)

func TestSessionRole(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		{"fabKit", SessionRoleUser},
		{"_rk-pin-42", SessionRolePin},
		{"_rk-iso-5", SessionRoleIso},
		{"_rk-ctl", SessionRoleControl},
		{"_rk-operator", SessionRoleOperator},
		{"_rk-future-thing", SessionRoleReserved},
		{"_rk-", SessionRoleReserved},
		{"my_rk-notes", SessionRoleUser}, // mid-name prefix is not reserved
		{"", SessionRoleUser},
	}
	for _, tc := range cases {
		if got := SessionRole(tc.name); got != tc.want {
			t.Errorf("SessionRole(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// factsLine builds one sessionListFormat line: name, grouped, group,
// group_size, color, windows, flair, id, agent preset, path.
func factsLine(name, grouped, group, groupSize, windows, id, path string) string {
	return strings.Join([]string{name, grouped, group, groupSize, "", windows, "", id, "", path}, listDelim)
}

// TestSessionListFormatFields pins the shared 10-field shape: the agent preset
// precedes the free-form session_path, which stays last.
func TestSessionListFormatFields(t *testing.T) {
	fields := strings.Split(sessionListFormat(), listDelim)
	if len(fields) != 10 {
		t.Fatalf("sessionListFormat has %d fields, want 10", len(fields))
	}
	if fields[8] != "#{"+SessionAgentPresetOption+"}" || fields[9] != "#{session_path}" {
		t.Errorf("fields[8:] = %q, want agent preset then session_path", fields[8:])
	}
}

func TestParseSessions_agentPreset(t *testing.T) {
	line := strings.Join([]string{"proj", "0", "", "0", "", "2", "", "$1", "codex-review", "/p"}, listDelim)
	got := parseSessions([]string{line})
	if len(got) != 1 || got[0].AgentPreset != "codex-review" || got[0].Path != "/p" {
		t.Fatalf("parseSessions = %+v, want agent preset codex-review and path /p", got)
	}
	unset := strings.Join([]string{"proj", "0", "", "0", "", "2", "", "$1", "", "/p"}, listDelim)
	if got := parseSessions([]string{unset}); got[0].AgentPreset != "" {
		t.Errorf("unset option = %q, want empty", got[0].AgentPreset)
	}
}

func TestBuildSessionFacts_pathWithPreset(t *testing.T) {
	line := strings.Join([]string{"proj", "0", "", "0", "", "2", "", "$1", "claude", "/p"}, listDelim)
	got := buildSessionFacts([]string{line}, nil)
	if len(got) != 1 || got[0].Path != "/p" {
		t.Fatalf("buildSessionFacts = %+v, want path /p", got)
	}
}

// TestBuildSessionFacts covers the fold in one fixture: user rows follow the
// parseSessions keep decision (group copies fold onto the leader), pin/control
// rows are re-included from their raw lines, the reserved catch-all applies,
// attached counts land via the group-key join, and tmux enumeration order is
// preserved.
func TestBuildSessionFacts(t *testing.T) {
	lines := []string{
		factsLine("fabKit", "1", "fabKit", "2", "15", "$1", "/home/x/fab-kit"),
		factsLine("_rk-ctl", "1", "fabKit", "2", "15", "$2", "/home/x"),
		factsLine("devshell", "1", "devshell", "2", "3", "$3", "/home/y"),
		factsLine("devshell-82", "1", "devshell", "2", "3", "$4", "/home/y"),
		factsLine("_rk-pin-42", "0", "", "0", "1", "$5", "/home/x"),
		factsLine("_rk-iso-7", "0", "", "0", "1", "$8", "/home/x"),
		factsLine("_rk-operator", "0", "", "0", "1", "$6", "/home/x"),
		factsLine("_rk-future", "0", "", "0", "1", "$7", "/home/x"),
	}
	clients := []ClientInfo{
		// Attached via the derived group copy — must credit the leader row.
		{TTY: "/dev/ttys001", Width: 80, Height: 24, SessionName: "devshell-82", SessionGroup: "devshell"},
		{TTY: "/dev/ttys002", Width: 120, Height: 40, SessionName: "fabKit", SessionGroup: "fabKit"},
	}

	got := buildSessionFacts(lines, clients)
	want := []SessionFacts{
		{Name: "fabKit", Role: SessionRoleUser, Attached: 1, Windows: 15, Path: "/home/x/fab-kit", Grouped: true},
		{Name: "_rk-ctl", Role: SessionRoleControl, Attached: 0, Windows: 15, Path: "/home/x", Grouped: true},
		{Name: "devshell", Role: SessionRoleUser, Attached: 1, Windows: 3, Path: "/home/y", Grouped: true},
		{Name: "_rk-pin-42", Role: SessionRolePin, Attached: 0, Windows: 1, Path: "/home/x", Grouped: false},
		{Name: "_rk-iso-7", Role: SessionRoleIso, Attached: 0, Windows: 1, Path: "/home/x", Grouped: false},
		{Name: "_rk-operator", Role: SessionRoleOperator, Attached: 0, Windows: 1, Path: "/home/x", Grouped: false},
		{Name: "_rk-future", Role: SessionRoleReserved, Attached: 0, Windows: 1, Path: "/home/x", Grouped: false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("buildSessionFacts = %+v,\nwant %+v", got, want)
	}
}

// TestBuildSessionFactsLeaderlessGroupAttached: when a group's leader was
// renamed away (parseSessions keeps the first member as representative), a
// client's SessionKey resolves to the GROUP name, not the representative's —
// the group-bucket add is what credits that viewer to the kept row.
func TestBuildSessionFactsLeaderlessGroupAttached(t *testing.T) {
	lines := []string{
		factsLine("devshell-82", "1", "devshell", "2", "3", "$1", "/home/y"),
		factsLine("devshell-83", "1", "devshell", "2", "3", "$2", "/home/y"),
	}
	clients := []ClientInfo{
		{TTY: "/dev/ttys001", Width: 80, Height: 24, SessionName: "devshell-83", SessionGroup: "devshell"},
	}

	got := buildSessionFacts(lines, clients)
	want := []SessionFacts{
		{Name: "devshell-82", Role: SessionRoleUser, Attached: 1, Windows: 3, Path: "/home/y", Grouped: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("buildSessionFacts = %+v,\nwant %+v", got, want)
	}
}

// TestBuildSessionFactsEmpty: no lines yields no rows (nil, not a panic), and
// malformed short lines are skipped.
func TestBuildSessionFactsEmpty(t *testing.T) {
	if got := buildSessionFacts(nil, nil); got != nil {
		t.Errorf("buildSessionFacts(nil) = %+v, want nil", got)
	}
	if got := buildSessionFacts([]string{"lonely-field"}, nil); got != nil {
		t.Errorf("buildSessionFacts(short line) = %+v, want nil", got)
	}
}
