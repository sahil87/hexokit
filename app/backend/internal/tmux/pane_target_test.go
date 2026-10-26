package tmux

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestParsePaneTarget(t *testing.T) {
	tests := []struct {
		name       string
		in         string
		wantPane   string
		wantWindow string
		wantErr    bool
	}{
		{"pane ID", "%5", "%5", "", false},
		{"pane ID large", "%123", "%123", "", false},
		{"window ID", "@3", "", "@3", false},
		{"exact session:window", "=work:editor", "", "=work:editor", false},
		{"exact session:window index", "=work:2", "", "=work:2", false},
		{"bare session:window rejected", "work:editor", "", "", true},
		{"bare name rejected", "editor", "", "", true},
		{"empty rejected", "", "", "", true},
		{"bare pane prefix rejected", "%", "", "", true},
		{"non-numeric pane rejected", "%x", "", "", true},
		{"non-numeric window rejected", "@x", "", "", true},
		{"bare equals rejected", "=", "", "", true},
		{"missing session rejected", "=:editor", "", "", true},
		{"missing window rejected", "=work:", "", "", true},
		{"second colon rejected", "=work:editor:0", "", "", true},
		{"session with colon impossible", "=a:b:c", "", "", true},
		{"session with period rejected", "=my.sess:win", "", "", true},
		{"window with space rejected", "=work:my win", "", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParsePaneTarget(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("ParsePaneTarget(%q) = %+v, want error", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParsePaneTarget(%q) err = %v", tt.in, err)
			}
			if got.PaneID != tt.wantPane || got.WindowTarget != tt.wantWindow {
				t.Errorf("ParsePaneTarget(%q) = %+v, want pane=%q window=%q", tt.in, got, tt.wantPane, tt.wantWindow)
			}
		})
	}
}

// TestParsePaneFacts: empty first/last fields must not shift the remaining
// fields — only the trailing newline is trimmed, never the delimiting tabs.
func TestParsePaneFacts(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want PaneFacts
	}{
		{
			"all fields",
			"/home/u/proj\tnvim\twaiting:123\n",
			PaneFacts{CWD: "/home/u/proj", Command: "nvim", AgentState: "waiting", AgentStateEpoch: 123},
		},
		{
			"empty agent state keeps cwd and command",
			"/home/u/proj\tzsh\t\n",
			PaneFacts{CWD: "/home/u/proj", Command: "zsh"},
		},
		{
			"empty cwd does not shift command into cwd",
			"\tnvim\twaiting:123\n",
			PaneFacts{CWD: "", Command: "nvim", AgentState: "waiting", AgentStateEpoch: 123},
		},
		{
			"empty cwd and agent state",
			"\tzsh\t\n",
			PaneFacts{Command: "zsh"},
		},
		{
			"shell command reconciles away two-segment state",
			"/home/u/proj\tzsh\twaiting:123\n",
			PaneFacts{CWD: "/home/u/proj", Command: "zsh"},
		},
		{
			"scope-named field wins over legacy when set",
			"/home/u/proj\tnvim\tidle:100\twaiting:123\n",
			PaneFacts{CWD: "/home/u/proj", Command: "nvim", AgentState: "waiting", AgentStateEpoch: 123},
		},
		{
			"whitespace-only scope-named field falls back to legacy",
			"/home/u/proj\tnvim\twaiting:123\t  \n",
			PaneFacts{CWD: "/home/u/proj", Command: "nvim", AgentState: "waiting", AgentStateEpoch: 123},
		},
		{
			"session identity uses scope-named field",
			"/home/u/proj\tcodex\t\twaiting:123\tclaude:old\tcodex:session\n",
			PaneFacts{CWD: "/home/u/proj", Command: "codex", AgentState: "waiting", AgentStateEpoch: 123, AgentProvider: "codex", AgentSessionRef: "session"},
		},
		{
			"session identity falls back to legacy",
			"/home/u/proj\tcodex\t\twaiting:123\tcodex:session\t\n",
			PaneFacts{CWD: "/home/u/proj", Command: "codex", AgentState: "waiting", AgentStateEpoch: 123, AgentProvider: "codex", AgentSessionRef: "session"},
		},
		{
			"stale state does not retain identity",
			"/home/u/proj\tzsh\t\twaiting:123\t\tcodex:session\n",
			PaneFacts{CWD: "/home/u/proj", Command: "zsh"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parsePaneFacts(tt.raw); got != tt.want {
				t.Errorf("parsePaneFacts(%q) = %+v, want %+v", tt.raw, got, tt.want)
			}
		})
	}
}

// TestParsePaneTargetErrorNamesForms: the rejection message must name the three
// accepted forms (an agent reading the error can correct itself).
func TestParsePaneTargetErrorNamesForms(t *testing.T) {
	_, err := ParsePaneTarget("mysession:win")
	if err == nil {
		t.Fatal("want error")
	}
	for _, want := range []string{"%N", "@N", "=session:window"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q missing accepted form %q", err.Error(), want)
		}
	}
}

func TestSelectAgentPane(t *testing.T) {
	tests := []struct {
		name  string
		panes []PaneInfo
		want  string
	}{
		{
			"active pane with state wins",
			[]PaneInfo{{PaneID: "%1", IsActive: true, AgentState: "idle"}, {PaneID: "%2", AgentState: "idle"}},
			"%1",
		},
		{
			"state-carrying pane beats stateless active",
			[]PaneInfo{{PaneID: "%1", IsActive: true}, {PaneID: "%2", AgentState: "waiting"}},
			"%2",
		},
		{
			"no state falls back to active pane",
			[]PaneInfo{{PaneID: "%1"}, {PaneID: "%2", IsActive: true}},
			"%2",
		},
		{
			"no state and no active falls back to first",
			[]PaneInfo{{PaneID: "%1"}, {PaneID: "%2"}},
			"%1",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SelectAgentPane(tt.panes); got != tt.want {
				t.Errorf("SelectAgentPane = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestAgentStateStale pins the shared reconcile rule both the sessions rollup
// (parsePanes) and the mux verbs' PaneAgentState route through (R10):
// pid-carrying values are trusted iff the pid is alive; legacy two-segment
// values (pid 0) fall back to the shell-command heuristic.
func TestAgentStateStale(t *testing.T) {
	orig := agentProcessAlive
	t.Cleanup(func() { agentProcessAlive = orig })

	agentProcessAlive = func(int) bool { return false }
	if !agentStateStale(4242, "vim") {
		t.Error("dead pid must be stale regardless of the pane command")
	}
	agentProcessAlive = func(int) bool { return true }
	if agentStateStale(4242, "bash") {
		t.Error("live pid must be trusted even on a shell-named pane (wrapped launch)")
	}
	for _, shell := range []string{"sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"} {
		if !agentStateStale(0, shell) {
			t.Errorf("legacy two-segment value on shell %q must be stale", shell)
		}
	}
	if agentStateStale(0, "vim") {
		t.Error("legacy two-segment value on a non-shell command must be trusted")
	}

	// And the same decision reaches the parsePanes rollup — a dead pid zeros
	// AgentPID together with AgentState, while the pane pid (field 11) stays.
	agentProcessAlive = func(int) bool { return false }
	// Field layout: window, pane, index, cwd, command, active, legacy state,
	// alternate_on, scoped state, legacy session, scoped session, pane_pid.
	lines := []string{"@1\t%1\t0\t/tmp\tvim\t1\tactive:1700000000:4242\t0\t\t\t\t1234"}
	got := parsePanes(lines)["@1"]
	if len(got) != 1 || got[0].AgentState != "" || got[0].AgentPID != 0 {
		t.Errorf("dead-pid pane = %+v, want reconciled to unknown with AgentPID 0", got)
	}
	if len(got) == 1 && got[0].PanePID != 1234 {
		t.Errorf("dead-pid pane PanePID = %d, want 1234", got[0].PanePID)
	}
	legacy := []string{"@1\t%1\t0\t/tmp\tbash\t1\tactive:1700000000\t0\t\t\t\t1234"}
	got = parsePanes(legacy)["@1"]
	if len(got) != 1 || got[0].AgentState != "" {
		t.Errorf("legacy shell pane = %+v, want reconciled to unknown", got)
	}

	// A live pid is kept on the pane for the liveness-walk cross-check.
	agentProcessAlive = func(pid int) bool { return pid == 4242 }
	live := []string{"@1\t%1\t0\t/tmp\tvim\t1\tactive:1700000000:4242\t0\t\t\t\t1234"}
	got = parsePanes(live)["@1"]
	if len(got) != 1 || got[0].AgentPID != 4242 || got[0].PanePID != 1234 {
		t.Errorf("live-pid pane = %+v, want AgentPID 4242 and PanePID 1234", got)
	}
	// Neither pid is a dashboard field.
	if len(got) == 1 {
		b, err := json.Marshal(got[0])
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if strings.Contains(string(b), "PanePID") || strings.Contains(string(b), "AgentPID") ||
			strings.Contains(string(b), "panePid") || strings.Contains(string(b), "agentPid") {
			t.Errorf("PaneInfo JSON leaks a pid field: %s", b)
		}
	}
}

// TestPaneFactsCtx exercises the one-shot fact read against an isolated test
// server: cwd plus the reconciled (state, epoch, pid) triple, with the
// dead-pid reconcile and the uninstrumented case reading as unknown. The
// pid-liveness probe is stubbed (the TestAgentStateStale pattern) so the
// reconcile is deterministic.
func TestPaneFactsCtx(t *testing.T) {
	server, _ := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	orig := agentProcessAlive
	t.Cleanup(func() { agentProcessAlive = orig })
	agentProcessAlive = func(int) bool { return true }

	lines, err := tmuxExecServer(ctx, server, "list-panes", "-t", "real:win0", "-F", "#{pane_id}")
	if err != nil {
		t.Fatalf("list panes: %v", err)
	}
	paneID := lines[0]

	// Uninstrumented pane: cwd resolves, the agent state reads unknown.
	facts, err := PaneFactsCtx(ctx, paneID, server)
	if err != nil {
		t.Fatalf("PaneFactsCtx: %v", err)
	}
	if facts.CWD == "" {
		t.Error("PaneFacts.CWD empty, want the pane's current path")
	}
	if facts.Command == "" {
		t.Error("PaneFacts.Command empty, want the pane's foreground command")
	}
	if facts.AgentState != "" || facts.AgentStateEpoch != 0 || facts.AgentPID != 0 {
		t.Errorf("uninstrumented pane = %+v, want unknown state", facts)
	}

	// A live-pid 3-segment value is trusted verbatim (state + epoch + pid).
	if _, err := tmuxExecServer(ctx, server, "set-option", "-pt", paneID, AgentStateOption, "waiting:1700000000:4242"); err != nil {
		t.Fatalf("set agent state: %v", err)
	}
	facts, err = PaneFactsCtx(ctx, paneID, server)
	if err != nil {
		t.Fatalf("PaneFactsCtx: %v", err)
	}
	if facts.AgentState != AgentStateWaiting || facts.AgentStateEpoch != 1700000000 || facts.AgentPID != 4242 {
		t.Errorf("PaneFacts = %+v, want waiting/1700000000/4242", facts)
	}

	// A dead pid reconciles to unknown — the pid is never reported.
	agentProcessAlive = func(int) bool { return false }
	facts, err = PaneFactsCtx(ctx, paneID, server)
	if err != nil {
		t.Fatalf("PaneFactsCtx: %v", err)
	}
	if facts.AgentState != "" || facts.AgentPID != 0 {
		t.Errorf("dead-pid pane = %+v, want reconciled to unknown", facts)
	}

	// PaneAgentState delegates to the same read.
	agentProcessAlive = func(int) bool { return true }
	state, err := PaneAgentState(ctx, paneID, server)
	if err != nil || state != AgentStateWaiting {
		t.Errorf("PaneAgentState = %q, %v, want waiting, nil", state, err)
	}
}

// TestPaneFactsCtx_dualRead exercises the legacy-name fallback of the fact
// read: a pane stamped only with the retired unscoped option (an older
// `rk agent hook` generation) still resolves through the same parse +
// reconcile, and the scope-named field wins when both are set.
func TestPaneFactsCtx_dualRead(t *testing.T) {
	server, _ := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	orig := agentProcessAlive
	t.Cleanup(func() { agentProcessAlive = orig })
	agentProcessAlive = func(int) bool { return true }

	lines, err := tmuxExecServer(ctx, server, "list-panes", "-t", "real:win0", "-F", "#{pane_id}")
	if err != nil {
		t.Fatalf("list panes: %v", err)
	}
	paneID := lines[0]

	// Legacy-only: the retired name still resolves.
	if _, err := tmuxExecServer(ctx, server, "set-option", "-pt", paneID, LegacyAgentStateOption, "idle:1700000000:4242"); err != nil {
		t.Fatalf("set legacy agent state: %v", err)
	}
	facts, err := PaneFactsCtx(ctx, paneID, server)
	if err != nil {
		t.Fatalf("PaneFactsCtx: %v", err)
	}
	if facts.AgentState != AgentStateIdle || facts.AgentStateEpoch != 1700000000 || facts.AgentPID != 4242 {
		t.Errorf("legacy-only pane = %+v, want idle/1700000000/4242", facts)
	}

	// Both set: the scope-named value wins.
	if _, err := tmuxExecServer(ctx, server, "set-option", "-pt", paneID, AgentStateOption, "waiting:1700000001:4242"); err != nil {
		t.Fatalf("set agent state: %v", err)
	}
	facts, err = PaneFactsCtx(ctx, paneID, server)
	if err != nil {
		t.Fatalf("PaneFactsCtx: %v", err)
	}
	if facts.AgentState != AgentStateWaiting || facts.AgentStateEpoch != 1700000001 {
		t.Errorf("both-set pane = %+v, want waiting/1700000001 (new wins)", facts)
	}
}

func TestParsePaneSize(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantW   int
		wantH   int
		wantErr bool
	}{
		{"valid pair", "54\t14\n", 54, 14, false},
		{"no trailing newline", "190\t44", 190, 44, false},
		{"zero width rejected", "0\t14\n", 0, 0, true},
		{"zero height rejected", "80\t0\n", 0, 0, true},
		{"negative rejected", "-3\t14\n", 0, 0, true},
		{"non-numeric rejected", "x\t14\n", 0, 0, true},
		{"empty output rejected", "", 0, 0, true},
		{"missing field rejected", "80\n", 0, 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w, h, err := parsePaneSize(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parsePaneSize(%q) = (%d, %d), want error", tt.raw, w, h)
				}
				return
			}
			if err != nil {
				t.Fatalf("parsePaneSize(%q) err = %v", tt.raw, err)
			}
			if w != tt.wantW || h != tt.wantH {
				t.Errorf("parsePaneSize(%q) = (%d, %d), want (%d, %d)", tt.raw, w, h, tt.wantW, tt.wantH)
			}
		})
	}
}

// TestPaneSizeCtx reads the pane's geometry against an isolated test server: a
// live pane reports positive dimensions, and a missing pane errors (tmux's
// display-message succeeds with EMPTY output on one — the parse failure is
// what surfaces the operational error).
func TestPaneSizeCtx(t *testing.T) {
	server, _ := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	lines, err := tmuxExecServer(ctx, server, "list-panes", "-t", "real:win0", "-F", "#{pane_id}")
	if err != nil {
		t.Fatalf("list panes: %v", err)
	}
	w, h, err := PaneSizeCtx(ctx, lines[0], server)
	if err != nil {
		t.Fatalf("PaneSizeCtx: %v", err)
	}
	if w <= 0 || h <= 0 {
		t.Errorf("PaneSizeCtx = (%d, %d), want positive dimensions", w, h)
	}
	if _, _, err := PaneSizeCtx(ctx, "%999999", server); err == nil {
		t.Error("PaneSizeCtx on a missing pane must error")
	}
}

// TestPanePIDCtx reads the pane's shell PID against an isolated test server.
func TestPanePIDCtx(t *testing.T) {
	server, _ := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	lines, err := tmuxExecServer(ctx, server, "list-panes", "-t", "real:win0", "-F", "#{pane_id}")
	if err != nil {
		t.Fatalf("list panes: %v", err)
	}
	pid, err := PanePIDCtx(ctx, lines[0], server)
	if err != nil {
		t.Fatalf("PanePIDCtx: %v", err)
	}
	if pid <= 0 {
		t.Errorf("PanePIDCtx = %d, want a positive shell pid", pid)
	}
	if _, err := PanePIDCtx(ctx, "%999999", server); err == nil {
		// tmux 3.6a's display-message succeeds with EMPTY output on a missing
		// pane — the pid parse failure is what surfaces the operational error.
		t.Error("PanePIDCtx on a missing pane must error")
	}
}

// TestIsShellCommand pins the shell/non-shell split the unknown-state warning
// and the reconciler's legacy fallback share.
func TestIsShellCommand(t *testing.T) {
	for _, shell := range []string{"sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"} {
		if !IsShellCommand(shell) {
			t.Errorf("IsShellCommand(%q) = false, want true", shell)
		}
	}
	for _, other := range []string{"htop", "claude", "nvim", ""} {
		if IsShellCommand(other) {
			t.Errorf("IsShellCommand(%q) = true, want false", other)
		}
	}
}

// TestClearPaneModeCtx exercises the pane-mode guard against an isolated test
// server: a fresh pane probes false and clear is a no-op (a wrongly-sent bare
// `send-keys -X cancel` against a modeless pane is itself a tmux error, so a
// nil return proves no cancel subprocess ran); a copy-mode pane probes true,
// one clear cancels it, and a missing pane surfaces the tmux error.
func TestClearPaneModeCtx(t *testing.T) {
	server, _ := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	lines, err := tmuxExecServer(ctx, server, "list-panes", "-t", "real:win0", "-F", "#{pane_id}")
	if err != nil {
		t.Fatalf("list panes: %v", err)
	}
	paneID := lines[0]

	inMode, err := PaneInModeCtx(ctx, paneID, server)
	if err != nil {
		t.Fatalf("PaneInModeCtx: %v", err)
	}
	if inMode {
		t.Fatal("fresh pane must not be in a mode")
	}
	if err := ClearPaneModeCtx(ctx, paneID, server); err != nil {
		t.Fatalf("clear on a modeless pane must be a no-op: %v", err)
	}

	if _, err := tmuxExecServer(ctx, server, "copy-mode", "-t", paneID); err != nil {
		t.Fatalf("enter copy-mode: %v", err)
	}
	inMode, err = PaneInModeCtx(ctx, paneID, server)
	if err != nil {
		t.Fatalf("PaneInModeCtx (copy-mode): %v", err)
	}
	if !inMode {
		t.Fatal("copy-mode pane must probe in-mode")
	}
	if err := ClearPaneModeCtx(ctx, paneID, server); err != nil {
		t.Fatalf("clear copy-mode: %v", err)
	}
	inMode, err = PaneInModeCtx(ctx, paneID, server)
	if err != nil {
		t.Fatalf("PaneInModeCtx (post-clear): %v", err)
	}
	if inMode {
		t.Fatal("pane must read out-of-mode after the clear")
	}

	if err := ClearPaneModeCtx(ctx, "%999999", server); err == nil {
		// tmux's display-message succeeds with EMPTY output on a missing pane —
		// the pane_in_mode parse failure is what surfaces the operational error.
		t.Error("ClearPaneModeCtx on a missing pane must error")
	}
}

// WindowIDForPane resolves a pane to its window's @N id against a live
// server, and refuses a malformed pane id before any subprocess runs.
func TestWindowIDForPane(t *testing.T) {
	server, _ := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	panes, err := tmuxExecServer(ctx, server, "list-panes", "-t", "real:win1", "-F", "#{pane_id}")
	if err != nil {
		t.Fatalf("list panes: %v", err)
	}
	paneID := panes[0]

	wins, err := tmuxExecServer(ctx, server, "list-windows", "-t", "real", "-F", "#{window_name} #{window_id}")
	if err != nil {
		t.Fatalf("list windows: %v", err)
	}
	var want string
	for _, line := range wins {
		name, id, _ := strings.Cut(line, " ")
		if name == "win1" {
			want = id
		}
	}
	if want == "" {
		t.Fatalf("win1 not found in list-windows: %v", wins)
	}

	got, err := WindowIDForPane(ctx, paneID, server)
	if err != nil {
		t.Fatalf("WindowIDForPane: %v", err)
	}
	if got != want {
		t.Errorf("WindowIDForPane(%s) = %q, want %q (win1's id)", paneID, got, want)
	}

	if _, err := WindowIDForPane(ctx, "bogus", server); err == nil {
		t.Error("WindowIDForPane with a malformed pane id must error before any subprocess")
	}
}
