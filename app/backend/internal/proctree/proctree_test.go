package proctree

import (
	"context"
	"errors"
	"testing"
)

func withAgentNames(t *testing.T, names ...string) {
	t.Helper()
	set := map[string]bool{}
	for _, n := range names {
		set[n] = true
	}
	SetAgentCommNames(set)
	t.Cleanup(func() { SetAgentCommNames(map[string]bool{}) })
}

// TestClassify pins the classification rule: an agent name matches on the
// comm basename or on either of the first two cmdline token basenames; node,
// git, and the other fallback; all case-insensitive.
func TestClassify(t *testing.T) {
	withAgentNames(t, "claude", "claude-code", "codex", "gemini", "kimi", "kimi-code", "opencode", "agy")
	cases := []struct {
		comm, cmdline, want string
	}{
		{"claude", "", "agent"},
		{"claude-code", "", "agent"},
		{"kimi-code", "", "agent"},
		{"Claude", "", "agent"}, // lowercased before lookup
		{"/usr/local/bin/claude", "", "agent"},
		// Bounded cmdline fallback: a node-hosted CLI is agent by its second
		// token; a third token never counts, so prompt text is not evidence.
		{"node", "node /usr/local/bin/gemini --yolo", "agent"},
		{"node", "/usr/bin/node /opt/agy/cli.js", "node"},
		{"node", `node server.js "please run claude now"`, "node"},
		{"node", "", "node"},
		{"git", "", "git"},
		{"gh", "", "git"},
		{"zsh", "-zsh", "other"},
		{"my-wrapper", "my-wrapper claude --resume", "agent"},
		{"my-wrapper", "my-wrapper --run claude", "other"},
		{"", "", "other"},
	}
	for _, tc := range cases {
		if got := Classify(tc.comm, tc.cmdline); got != tc.want {
			t.Errorf("Classify(%q, %q) = %q, want %q", tc.comm, tc.cmdline, got, tc.want)
		}
	}
}

// TestClassifyWithoutNames: before SetAgentCommNames runs nothing classifies
// agent by name.
func TestClassifyWithoutNames(t *testing.T) {
	SetAgentCommNames(map[string]bool{})
	if got := Classify("claude", ""); got != "other" {
		t.Errorf("Classify = %q, want other", got)
	}
}

// TestParsePSCmdlines: the darwin cmdline-join parser (unit-tested here on
// every platform) is robust to right-aligned pids, spaces inside args, and
// non-pid lines.
func TestParsePSCmdlines(t *testing.T) {
	out := "  123 /bin/zsh -l\n" +
		" 1250 claude --dangerously-skip-permissions -n my session\n" +
		"garbage line\n" +
		"  77\n"
	m := parsePSCmdlines(out)
	if len(m) != 3 {
		t.Fatalf("parsed %d entries, want 3: %v", len(m), m)
	}
	if m[123] != "/bin/zsh -l" {
		t.Errorf("m[123] = %q", m[123])
	}
	if m[1250] != "claude --dangerously-skip-permissions -n my session" {
		t.Errorf("m[1250] = %q (args with spaces must survive)", m[1250])
	}
	if m[77] != "" {
		t.Errorf("m[77] = %q, want empty args", m[77])
	}
	if _, ok := m[0]; ok {
		t.Error("non-pid line leaked into the map")
	}
}

func TestPaneHasAgentVia(t *testing.T) {
	withAgentNames(t, "claude")
	tree := func(context.Context, int) ([]Node, error) {
		return []Node{{PID: 10, Comm: "zsh", Classification: "other", Children: []Node{
			{PID: 11, PPID: 10, Comm: "wrapper", Classification: "other", Children: []Node{}},
		}}}, nil
	}

	t.Run("comm heuristics find nothing", func(t *testing.T) {
		_, has, err := PaneHasAgentVia(context.Background(), tree, 10, 0)
		if err != nil || has {
			t.Errorf("has = %v, err = %v, want false/nil", has, err)
		}
	})
	t.Run("agent pid reclassifies the node", func(t *testing.T) {
		got, has, err := PaneHasAgentVia(context.Background(), tree, 10, 11)
		if err != nil || !has {
			t.Fatalf("has = %v, err = %v, want true/nil", has, err)
		}
		if got[0].Children[0].Classification != "agent" {
			t.Errorf("child classification = %q, want agent", got[0].Children[0].Classification)
		}
	})
	t.Run("discovery error propagates", func(t *testing.T) {
		boom := errors.New("boom")
		_, has, err := PaneHasAgentVia(context.Background(), func(context.Context, int) ([]Node, error) { return nil, boom }, 10, 0)
		if !errors.Is(err, boom) || has {
			t.Errorf("has = %v, err = %v, want false/boom", has, err)
		}
	})
}
