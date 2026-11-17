package main

import (
	"errors"
	"strings"
	"testing"

	"rk/internal/tmux"
)

// TestMuxCaptureHumanOutput: the default shape is the header block — context
// line joining only the resolved parts, then the content untrimmed (R2/R3).
func TestMuxCaptureHumanOutput(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "capture", "%5")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	// Default fake: %5 idle at epoch 1_800_000_000, now 1_800_000_300 → 5m.
	want := "--- pane %5 ---\n" +
		"cwd: /home/x/code/repo | agent: idle (5m)\n" +
		"---\n" +
		"line one\nline two\n"
	if stdout != want {
		t.Errorf("stdout = %q, want %q", stdout, want)
	}
	if len(f.captureCalls) != 1 || f.captureCalls[0].lines != 50 || f.captureCalls[0].server != "default" {
		t.Errorf("capture calls = %+v, want one 50-line capture on the default server", f.captureCalls)
	}
}

// TestMuxCaptureRawByteIdentical: --raw prints exactly the captured text — no
// header, no enrichment, no trimming (R2).
func TestMuxCaptureRawByteIdentical(t *testing.T) {
	content := "  spaced  \n\ntrailing blanks\n\n"
	f := &muxFake{captureContent: map[string]string{"%5": content}}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "capture", "%5", "--raw")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if stdout != content {
		t.Errorf("stdout = %q, want byte-identical %q", stdout, content)
	}
}

// TestMuxCaptureJSONShape: --json wraps the documented shape in the standard
// envelope (R8), with nulls for uninstrumented fields (R2/R3).
func TestMuxCaptureJSONShape(t *testing.T) {
	f := &muxFake{states: map[string]string{"%5": ""}} // uninstrumented
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "capture", "%5", "--json", "--lines", "200")
	if err != nil {
		t.Fatalf("err = %v, want exit 0", err)
	}
	want := "{\n" +
		"  \"ok\": true,\n" +
		"  \"result\": {\n" +
		"    \"pane\": \"%5\",\n" +
		"    \"lines\": 200,\n" +
		"    \"content\": \"line one\\nline two\\n\",\n" +
		"    \"cwd\": \"/home/x/code/repo\",\n" +
		"    \"agent_state\": null,\n" +
		"    \"agent_state_duration\": null\n" +
		"  }\n" +
		"}\n"
	if stdout != want {
		t.Errorf("stdout = %q, want %q", stdout, want)
	}
	if f.captureCalls[0].lines != 200 {
		t.Errorf("--lines did not reach the capture: %+v", f.captureCalls[0])
	}
}

// TestMuxCaptureContextLineOmission: an empty cwd or an uninstrumented pane
// drops its part; with zero parts the context line disappears entirely (R3).
func TestMuxCaptureContextLineOmission(t *testing.T) {
	cases := []struct {
		name     string
		facts    tmux.PaneFacts
		wantLine string // "" = no context line at all
	}{
		{"no cwd", tmux.PaneFacts{AgentState: tmux.AgentStateIdle, AgentStateEpoch: 1_800_000_000}, "agent: idle (5m)"},
		{"uninstrumented", tmux.PaneFacts{CWD: "/tmp"}, "cwd: /tmp"},
		{"no parts", tmux.PaneFacts{}, ""},
		{"active carries its duration", tmux.PaneFacts{CWD: "/tmp", AgentState: tmux.AgentStateActive, AgentStateEpoch: 1_800_000_000}, "cwd: /tmp | agent: active (5m)"},
		{"aged active carries its duration", tmux.PaneFacts{CWD: "/tmp", AgentState: tmux.AgentStateActive, AgentStateEpoch: 1_800_000_300 - 720}, "cwd: /tmp | agent: active (12m)"},
		{"waiting carries a duration", tmux.PaneFacts{AgentState: tmux.AgentStateWaiting, AgentStateEpoch: 1_800_000_180}, "agent: waiting (2m)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &muxFake{facts: map[string]tmux.PaneFacts{"%5": tc.facts}}
			installMuxFakes(t, f)

			stdout, _, err := runMuxCmd(t, "capture", "%5")
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			lines := strings.Split(stdout, "\n")
			if len(lines) < 2 || lines[0] != "--- pane %5 ---" {
				t.Fatalf("stdout = %q, want the header block", stdout)
			}
			if tc.wantLine == "" {
				if lines[1] != "---" {
					t.Errorf("stdout = %q, want no context line", stdout)
				}
				return
			}
			if lines[1] != tc.wantLine || lines[2] != "---" {
				t.Errorf("context line = %q, want %q", lines[1], tc.wantLine)
			}
		})
	}
}

// TestMuxCaptureValidation: target grammar and flag validation are usage
// errors (exit 2); --json/--raw are mutually exclusive (R1/R2).
func TestMuxCaptureValidation(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)

	for _, args := range [][]string{
		{"capture", "mysession:win"},         // bare name rejected
		{"capture", "%5", "--lines", "0"},    // < 1
		{"capture", "%5", "--json", "--raw"}, // mutually exclusive
		{"capture"},                          // missing target
		{"capture", "%5", "%6"},              // extra arg
	} {
		stdout, _, err := runMuxCmd(t, args...)
		if err == nil || exitCode(err) != exitUsage {
			t.Errorf("args %v: err = %v (exit %d), want usage exit 2", args, err, exitCode(err))
		}
		if stdout != "" {
			t.Errorf("args %v: stdout = %q, want empty on usage error", args, stdout)
		}
	}
	if len(f.captureCalls) != 0 {
		t.Errorf("capture ran on usage errors: %v", f.captureCalls)
	}

	_, _, err := runMuxCmd(t, "capture", "mysession:win")
	for _, want := range []string{"%N", "@N", "=session:window"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q missing accepted form %q", err.Error(), want)
		}
	}
}

// TestMuxCaptureWindowTargetResolves: a window target routes to the window's
// agent pane before capture (R1).
func TestMuxCaptureWindowTargetResolves(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "capture", "@3", "--raw")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(f.captureCalls) != 1 || f.captureCalls[0].paneID != "%7" {
		t.Errorf("capture calls = %+v, want the resolved agent pane %%7", f.captureCalls)
	}
	if stdout == "" {
		t.Error("stdout empty, want the captured text")
	}
}

// TestMuxCaptureOperationalErrors: a tmux capture failure or a missing pane is
// exit 1 carrying the diagnostic (R2, A-010).
func TestMuxCaptureOperationalErrors(t *testing.T) {
	f := &muxFake{captureErr: errors.New("exit status 1: can't find pane: %9")}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "capture", "%9")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit 1", err)
	}
	if !strings.Contains(err.Error(), "can't find pane") {
		t.Errorf("err = %v, want tmux's stderr diagnostic", err)
	}
	if stdout != "" {
		t.Errorf("stdout = %q on a failed capture, want empty", stdout)
	}

	// The enrichment read failing is likewise operational (non-raw modes).
	f.captureErr = nil
	f.factsErr = errors.New("exit status 1: no server running")
	_, _, err = runMuxCmd(t, "capture", "%5")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("facts read: err = %v, want exit 1", err)
	}
}

// TestMuxCaptureClassifyJSON: --classify adds the fixed-shape questions object
// under --json — reason null on a match, snippet empty on none — and the key
// is absent without the flag (R3).
func TestMuxCaptureClassifyJSON(t *testing.T) {
	cases := []struct {
		name    string
		content string
		args    []string
		wantQ   string // "" = no questions key at all
	}{
		{
			"matched", "building...\nOverwrite file [y/N]\n", []string{"--json", "--classify"},
			"    \"questions\": {\n" +
				"      \"indicator\": \"yes_no\",\n" +
				"      \"snippet\": \"Overwrite file [y/N]\",\n" +
				"      \"reason\": null\n" +
				"    },\n" +
				"    \"composer\": {\n" +
				"      \"text\": \"\",\n" +
				"      \"ghost\": false\n" +
				"    }\n",
		},
		{
			"none with reason", "   \n", []string{"--json", "--classify"},
			"    \"questions\": {\n" +
				"      \"indicator\": \"none\",\n" +
				"      \"snippet\": \"\",\n" +
				"      \"reason\": \"blank_capture\"\n" +
				"    },\n" +
				"    \"composer\": {\n" +
				"      \"text\": \"\",\n" +
				"      \"ghost\": false\n" +
				"    }\n",
		},
		{"absent without flag", "Overwrite file [y/N]\n", []string{"--json"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &muxFake{states: map[string]string{"%5": ""}, captureContent: map[string]string{"%5": tc.content}}
			installMuxFakes(t, f)

			stdout, _, err := runMuxCmd(t, append([]string{"capture", "%5"}, tc.args...)...)
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if tc.wantQ == "" {
				if strings.Contains(stdout, "questions") {
					t.Errorf("stdout = %q, want no questions key without --classify", stdout)
				}
				return
			}
			if !strings.Contains(stdout, tc.wantQ) {
				t.Errorf("stdout = %q, want questions block %q", stdout, tc.wantQ)
			}
			// The six existing keys still precede it in order, inside the envelope.
			if !strings.HasSuffix(stdout, "    \"agent_state_duration\": null,\n"+tc.wantQ+"  }\n}\n") {
				t.Errorf("stdout = %q, want questions as the trailing key", stdout)
			}
		})
	}
}

// TestMuxCaptureClassifyHumanLine: --classify appends one `question:` header
// line after the context line — or directly after the pane header when the
// context line is omitted — before the closing separator (R4).
func TestMuxCaptureClassifyHumanLine(t *testing.T) {
	cases := []struct {
		name     string
		facts    tmux.PaneFacts
		content  string
		wantHead []string
	}{
		{
			"with context line", tmux.PaneFacts{CWD: "/tmp", AgentState: tmux.AgentStateIdle, AgentStateEpoch: 1_800_000_000},
			"1) yes  2) no\n",
			[]string{"--- pane %5 ---", "cwd: /tmp | agent: idle (5m)", "question: enumerated_options — 1) yes  2) no", "---"},
		},
		{
			"without context line", tmux.PaneFacts{},
			"Enter your name:\n",
			[]string{"--- pane %5 ---", "question: colon_prompt — Enter your name:", "---"},
		},
		{
			"none carries the reason", tmux.PaneFacts{CWD: "/tmp"},
			"done\n>\n",
			[]string{"--- pane %5 ---", "cwd: /tmp", "question: none (turn_boundary)", "---"},
		},
		{
			"active pane still classifies", tmux.PaneFacts{CWD: "/tmp", AgentState: tmux.AgentStateActive, AgentStateEpoch: 1_800_000_000},
			"Proceed? [Y/n]\n",
			[]string{"--- pane %5 ---", "cwd: /tmp | agent: active (5m)", "question: yes_no — Proceed? [Y/n]", "---"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &muxFake{facts: map[string]tmux.PaneFacts{"%5": tc.facts}, captureContent: map[string]string{"%5": tc.content}}
			installMuxFakes(t, f)

			stdout, _, err := runMuxCmd(t, "capture", "%5", "--classify")
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			want := strings.Join(tc.wantHead, "\n") + "\n" + tc.content
			if stdout != want {
				t.Errorf("stdout = %q, want %q", stdout, want)
			}
			if strings.Count(stdout, "question:") != 1 {
				t.Errorf("stdout = %q, want exactly one question: line", stdout)
			}
		})
	}
}

// TestMuxCaptureClassifyRawExclusive: --raw is byte-identical by contract, so
// pairing it with --classify is a usage error and performs no capture (R2).
func TestMuxCaptureClassifyRawExclusive(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "capture", "%5", "--classify", "--raw")
	if err == nil || exitCode(err) != exitUsage {
		t.Fatalf("err = %v (exit %d), want usage exit 2", err, exitCode(err))
	}
	if stdout != "" || len(f.captureCalls) != 0 {
		t.Errorf("stdout = %q, captures = %v; want nothing on a usage error", stdout, f.captureCalls)
	}
}

// --classify reads the composer from the attribute-preserving capture: a dim
// suggestion reports ghost, typed text does not, and the human line names it.
func TestMuxCaptureClassifyComposer(t *testing.T) {
	plain := "9 assumptions. Run /fab-ff to continue.\n❯ /fab-ff\n  status\n"
	cases := []struct {
		name, escaped, wantJSON, wantHuman string
	}{
		{"ghost", "9 assumptions. Run /fab-ff to continue.\n\x1b[39m❯ \x1b[2m/fab-ff\x1b[0m\n  status\n",
			"    \"composer\": {\n      \"text\": \"/fab-ff\",\n      \"ghost\": true\n    }\n", "composer: /fab-ff (ghost suggestion, not input)\n"},
		{"typed", plain, "    \"composer\": {\n      \"text\": \"/fab-ff\",\n      \"ghost\": false\n    }\n", "composer: /fab-ff\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &muxFake{states: map[string]string{"%5": "idle"}, captureContent: map[string]string{"%5": plain}, captureEscaped: map[string]string{"%5": tc.escaped}}
			installMuxFakes(t, f)
			stdout, _, err := runMuxCmd(t, "capture", "%5", "--json", "--classify")
			if err != nil || !strings.Contains(stdout, tc.wantJSON) {
				t.Errorf("json stdout = %q err %v, want %q", stdout, err, tc.wantJSON)
			}
			stdout, _, err = runMuxCmd(t, "capture", "%5", "--classify")
			if err != nil || !strings.Contains(stdout, tc.wantHuman) {
				t.Errorf("human stdout = %q err %v, want %q", stdout, err, tc.wantHuman)
			}
			stdout, _, _ = runMuxCmd(t, "capture", "%5", "--json")
			if strings.Contains(stdout, "composer") {
				t.Errorf("composer must be absent without --classify: %q", stdout)
			}
		})
	}
}
