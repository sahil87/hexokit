package main

import (
	"errors"
	"strings"
	"testing"

	"rk/internal/proctree"
	"rk/internal/tmux"
)

// TestAgentCommNamesCoverRegistry: every registry runtime is recognized by
// both of its names — a harness added to agentRuntimes() must never silently
// fall out of the walk.
func TestAgentCommNamesCoverRegistry(t *testing.T) {
	for _, n := range []string{"claude-code", "Claude", "/usr/local/bin/claude"} {
		if got := proctree.Classify(n, ""); got != proctree.ClassAgent {
			t.Errorf("Classify(%q) = %q, want agent", n, got)
		}
	}
	for _, rt := range agentRuntimes() {
		for _, n := range []string{rt.binary, rt.comm} {
			if n == "node" {
				continue
			}
			if got := proctree.Classify(n, ""); got != proctree.ClassAgent {
				t.Errorf("registry name %q classifies %q, want agent", n, got)
			}
		}
	}
	// gemini is a node-hosted CLI: caught by the bounded cmdline fallback.
	if got := proctree.Classify("node", "node /usr/local/bin/gemini --yolo"); got != proctree.ClassAgent {
		t.Errorf("node-hosted gemini classifies %q, want agent", got)
	}
}

// TestMuxProcessHumanOutput: the human tree shape — header, indented
// PID/comm/class lines (tag omitted for other), and the trailing agent notice
// (R5a).
func TestMuxProcessHumanOutput(t *testing.T) {
	f := &muxFake{} // default tree: zsh → claude [agent]
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "process", "%5")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	want := "Pane %5 (PID 1234)\n" +
		"1234 zsh\n" +
		"  1250 claude [agent]\n" +
		"\nAgent process detected.\n"
	if stdout != want {
		t.Errorf("stdout = %q, want %q", stdout, want)
	}
}

// TestMuxProcessNoAgent: without an agent node the trailing notice is absent.
func TestMuxProcessNoAgent(t *testing.T) {
	f := &muxFake{
		states: map[string]string{"%5": ""},
		discoverTree: []processNode{{
			PID: 1234, Comm: "zsh", Classification: "other",
			Children: []processNode{{PID: 1300, PPID: 1234, Comm: "git", Classification: "git", Children: []processNode{}}},
		}},
	}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "process", "%5")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	want := "Pane %5 (PID 1234)\n1234 zsh\n  1300 git [git]\n"
	if stdout != want {
		t.Errorf("stdout = %q, want %q", stdout, want)
	}
	if strings.Contains(stdout, "Agent process detected") {
		t.Error("agent notice printed for an agent-free tree")
	}
}

// TestMuxProcessPIDCrossCheck: a wrapper-launched agent (comm is NOT in the
// table) is still classified agent when the pane's @rk_agent_state carries its
// live pid — instrumentation beats heuristics; has_agent follows (R5b).
func TestMuxProcessPIDCrossCheck(t *testing.T) {
	f := &muxFake{
		facts: map[string]tmux.PaneFacts{"%5": {
			AgentState: tmux.AgentStateActive, AgentStateEpoch: 1_800_000_000, AgentPID: 1400,
		}},
		discoverTree: []processNode{{
			PID: 1234, Comm: "zsh", Classification: "other",
			Children: []processNode{{
				PID: 1400, PPID: 1234, Comm: "my-wrapper", Cmdline: "my-wrapper --run claude", Classification: "other",
				Children: []processNode{},
			}},
		}},
	}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "process", "%5")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(stdout, "  1400 my-wrapper [agent]\n") {
		t.Errorf("stdout = %q, want the wrapper node tagged [agent]", stdout)
	}
	if !strings.Contains(stdout, "Agent process detected.") {
		t.Errorf("stdout = %q, want the agent notice via the pid cross-check", stdout)
	}

	// JSON: the same override lands in the machine-readable tree.
	stdout, _, err = runMuxCmd(t, "process", "%5", "--json")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(stdout, "\"comm\": \"my-wrapper\"") ||
		!strings.Contains(stdout, "\"classification\": \"agent\"") ||
		!strings.Contains(stdout, "\"has_agent\": true") {
		t.Errorf("json = %q, want the pid-cross-checked agent classification", stdout)
	}
}

// TestMuxProcessJSONShape: --json emits the documented shape inside the
// standard envelope (R5a, R8).
func TestMuxProcessJSONShape(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "process", "%5", "--json")
	if err != nil {
		t.Fatalf("err = %v, want exit 0", err)
	}
	want := "{\n" +
		"  \"ok\": true,\n" +
		"  \"result\": {\n" +
		"    \"pane\": \"%5\",\n" +
		"    \"pane_pid\": 1234,\n" +
		"    \"processes\": [\n" +
		"      {\n" +
		"        \"pid\": 1234,\n" +
		"        \"ppid\": 0,\n" +
		"        \"comm\": \"zsh\",\n" +
		"        \"cmdline\": \"-zsh\",\n" +
		"        \"classification\": \"other\",\n" +
		"        \"children\": [\n" +
		"          {\n" +
		"            \"pid\": 1250,\n" +
		"            \"ppid\": 1234,\n" +
		"            \"comm\": \"claude\",\n" +
		"            \"cmdline\": \"claude\",\n" +
		"            \"classification\": \"agent\",\n" +
		"            \"children\": []\n" +
		"          }\n" +
		"        ]\n" +
		"      }\n" +
		"    ],\n" +
		"    \"has_agent\": true\n" +
		"  }\n" +
		"}\n"
	if stdout != want {
		t.Errorf("stdout = %q, want %q", stdout, want)
	}
}

// TestMuxProcessTargetAndErrors: target grammar is usage (exit 2); a missing
// pane (pid read failure) and a discovery failure are operational (exit 1)
// (R1/R5a).
func TestMuxProcessTargetAndErrors(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "process", "mysession:win")
	if err == nil || exitCode(err) != exitUsage {
		t.Fatalf("bare name: err = %v, want exit 2", err)
	}
	if stdout != "" {
		t.Errorf("stdout = %q on usage error, want empty", stdout)
	}

	// Window targets resolve to the agent pane before the pid read.
	f.panePIDs = map[string]int{"%7": 4321}
	stdout, _, err = runMuxCmd(t, "process", "@3")
	if err != nil {
		t.Fatalf("window target: err = %v", err)
	}
	if !strings.HasPrefix(stdout, "Pane %7 (PID 4321)\n") {
		t.Errorf("stdout = %q, want the resolved agent pane's tree", stdout)
	}

	f.panePIDErr = errors.New("exit status 1: can't find pane: %5")
	_, _, err = runMuxCmd(t, "process", "%5")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("missing pane: err = %v, want exit 1", err)
	}

	f.panePIDErr = nil
	f.discoverErr = errors.New("PID 1234 not found")
	_, _, err = runMuxCmd(t, "process", "%5")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("discovery failure: err = %v, want exit 1", err)
	}
}
