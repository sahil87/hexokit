package cron

import (
	"context"
	"errors"
	"testing"

	"rk/internal/tmux"
)

// fakeTmux records every call (per server) so tests can pin which servers were
// touched — the dead-server "zero tmux commands" property.
type fakeTmux struct {
	calls    []string // "method server ..."
	sessions map[string][]tmux.SessionInfo
	windows  map[string]map[string][]tmux.WindowInfo // server → session → windows
	panes    map[string]map[string]tmux.PaneFacts    // server → paneID → facts
	alive    map[string]map[string]bool              // server → paneID → alive
	agent    map[string]map[string]string            // server → windowID → agent pane
	runWins  map[string][]tmux.RunWindow             // server → live run windows
}

func newFakeTmux() *fakeTmux {
	return &fakeTmux{
		sessions: map[string][]tmux.SessionInfo{},
		windows:  map[string]map[string][]tmux.WindowInfo{},
		panes:    map[string]map[string]tmux.PaneFacts{},
		alive:    map[string]map[string]bool{},
		agent:    map[string]map[string]string{},
		runWins:  map[string][]tmux.RunWindow{},
	}
}

func (f *fakeTmux) ListSessions(ctx context.Context, server string) ([]tmux.SessionInfo, error) {
	f.calls = append(f.calls, "ListSessions "+server)
	return f.sessions[server], nil
}

func (f *fakeTmux) ListWindows(ctx context.Context, session, server string) ([]tmux.WindowInfo, error) {
	f.calls = append(f.calls, "ListWindows "+server+" "+session)
	return f.windows[server][session], nil
}

func (f *fakeTmux) ResolveAgentPane(ctx context.Context, windowTarget, server string) (string, error) {
	f.calls = append(f.calls, "ResolveAgentPane "+server+" "+windowTarget)
	if p, ok := f.agent[server][windowTarget]; ok {
		return p, nil
	}
	return "", errors.New("no agent pane for " + windowTarget)
}

func (f *fakeTmux) PaneFacts(ctx context.Context, paneID, server string) (tmux.PaneFacts, error) {
	f.calls = append(f.calls, "PaneFacts "+server+" "+paneID)
	if pf, ok := f.panes[server][paneID]; ok {
		return pf, nil
	}
	return tmux.PaneFacts{}, errors.New("can't find pane " + paneID)
}

func (f *fakeTmux) PaneExists(ctx context.Context, paneID, server string) (bool, error) {
	f.calls = append(f.calls, "PaneExists "+server+" "+paneID)
	return f.alive[server][paneID], nil
}

func (f *fakeTmux) ListRunWindows(ctx context.Context, server string) ([]tmux.RunWindow, error) {
	f.calls = append(f.calls, "ListRunWindows "+server)
	return f.runWins[server], nil
}

func (f *fakeTmux) callsFor(server string) int {
	n := 0
	for _, c := range f.calls {
		if len(c) > len(server) && c[len(c)-len(server):] == server || containsCall(c, server) {
			n++
		}
	}
	return n
}

func containsCall(call, server string) bool {
	for _, m := range []string{"ListSessions ", "ListWindows ", "ResolveAgentPane ", "PaneFacts ", "PaneExists ", "ListRunWindows "} {
		if len(call) > len(m)+len(server) && call[:len(m)] == m && call[len(m):len(m)+len(server)] == server {
			return true
		}
	}
	return false
}

func factsEntries() []Entry {
	return []Entry{
		{ID: "role", Target: Target{Kind: TargetRole, Role: RoleOperator}},
		{ID: "sess", Target: Target{Kind: TargetSession, Session: "4fe2"}},
		{ID: "pane", Target: Target{Kind: TargetPane, Pane: "%42"}},
		{ID: "dead", Target: Target{Kind: TargetPane, Pane: "%99"}},
		{ID: "gone", Target: Target{Kind: TargetSession, Session: "no-such"}},
		{ID: "badrole", Target: Target{Kind: TargetRole, Role: "wizard"}},
	}
}

// TestGatherFactsResolution covers R16: role targets resolve via the
// @rk_win_role radio (operator window → agent pane), session targets via the
// @rk_pane_agent_session carrier, pane targets by liveness; unresolvable
// targets produce skip diagnostics, not errors.
func TestGatherFactsResolution(t *testing.T) {
	fk := newFakeTmux()
	fk.sessions["dev"] = []tmux.SessionInfo{{Name: "work"}, {Name: tmux.OperatorSessionName}}
	fk.windows["dev"] = map[string][]tmux.WindowInfo{
		"work": {{
			WindowID: "@5",
			Panes: []tmux.PaneInfo{
				{PaneID: "%10", AgentState: tmux.AgentStateIdle, AgentSessionRef: "4fe2"},
				{PaneID: "%11"},
			},
		}},
		tmux.OperatorSessionName: {{
			WindowID: "@9",
			Role:     RoleOperator,
			Panes:    []tmux.PaneInfo{{PaneID: "%12", AgentState: tmux.AgentStateIdle}},
		}},
	}
	fk.agent["dev"] = map[string]string{"@9": "%12"}
	fk.panes["dev"] = map[string]tmux.PaneFacts{
		"%12": {AgentState: tmux.AgentStateIdle, AgentStateEpoch: 1700000000},
		"%10": {AgentState: tmux.AgentStateIdle, AgentStateEpoch: 1700001000},
		"%42": {AgentState: tmux.AgentStateActive, AgentStateEpoch: 1700002000},
	}
	fk.alive["dev"] = map[string]bool{"%42": true, "%99": false}

	out := GatherFacts(context.Background(), "dev", factsEntries(), fk)

	role := out.Targets["role"]
	if !role.Resolved() || role.PaneID != "%12" || role.StateEpoch != 1700000000 {
		t.Errorf("role target = %+v, want %%12 epoch 1700000000", role)
	}
	sess := out.Targets["sess"]
	if !sess.Resolved() || sess.PaneID != "%10" || sess.StateEpoch != 1700001000 {
		t.Errorf("session target = %+v, want %%10 epoch 1700001000", sess)
	}
	pane := out.Targets["pane"]
	if !pane.Resolved() || pane.PaneID != "%42" || pane.AgentState != tmux.AgentStateActive {
		t.Errorf("pane target = %+v", pane)
	}

	for _, id := range []string{"dead", "gone", "badrole"} {
		if out.Targets[id].Resolved() {
			t.Errorf("%s should be unresolved: %+v", id, out.Targets[id])
		}
	}
	var diags int
	for _, d := range out.Diags {
		if d.Reason == "target-unresolved" {
			diags++
		}
	}
	if diags != 3 {
		t.Errorf("diags = %v, want 3 target-unresolved", out.Diags)
	}
}

// TestGatherFactsFingerprint: the server agent-state map covers every pane
// with a known agent state; its rendering is sorted and stable.
func TestGatherFactsFingerprint(t *testing.T) {
	fk := newFakeTmux()
	fk.sessions["dev"] = []tmux.SessionInfo{{Name: "work"}}
	fk.windows["dev"] = map[string][]tmux.WindowInfo{
		"work": {{
			WindowID: "@5",
			Panes: []tmux.PaneInfo{
				{PaneID: "%10", AgentState: tmux.AgentStateIdle},
				{PaneID: "%11", AgentState: tmux.AgentStateActive},
				{PaneID: "%12"}, // unknown state — excluded
			},
		}},
	}
	out := GatherFacts(context.Background(), "dev", nil, fk)
	if want := "%10=idle\n%11=active\n"; Fingerprint(out.States) != want {
		t.Errorf("fingerprint = %q, want %q", Fingerprint(out.States), want)
	}
	if _, present := out.States["%12"]; present {
		t.Error("pane with an unknown state should be absent from States")
	}
}

// TestGatherFactsNoOperatorWindow: a role target on a server without an
// operator window is unresolvable, not an error.
func TestGatherFactsNoOperatorWindow(t *testing.T) {
	fk := newFakeTmux()
	fk.sessions["dev"] = []tmux.SessionInfo{{Name: "work"}}
	fk.windows["dev"] = map[string][]tmux.WindowInfo{
		"work": {{WindowID: "@5"}},
	}
	out := GatherFacts(context.Background(), "dev",
		[]Entry{{ID: "role", Target: Target{Kind: TargetRole, Role: RoleOperator}}}, fk)
	if out.Targets["role"].Resolved() {
		t.Error("role target resolved without an operator window")
	}
	if len(out.Diags) != 1 || out.Diags[0].Reason != "target-unresolved" {
		t.Errorf("diags = %+v", out.Diags)
	}
}

// TestGatherFactsEnumerationFailure: a session enumeration error degrades to
// diagnostics + empty facts, never an error return.
func TestGatherFactsEnumerationFailure(t *testing.T) {
	fk := newFakeTmux()
	// No sessions registered: ListSessions returns nil — the server enumerates
	// empty. Targets are unresolvable but nothing errors.
	out := GatherFacts(context.Background(), "dev", factsEntries(), fk)
	if len(out.States) != 0 {
		t.Errorf("states = %v, want empty", out.States)
	}
	if out.Targets["role"].Resolved() || out.Targets["sess"].Resolved() {
		t.Errorf("targets resolved on an empty server: %+v", out.Targets)
	}
}

// TestGatherFactsAnyRole: role targets accept any @rk_win_role value — a
// window stamped `reviewer` resolves a `role: reviewer` entry to that
// window's agent pane; a role with no carrier reads unresolved with the
// role-naming diagnostic.
func TestGatherFactsAnyRole(t *testing.T) {
	fk := newFakeTmux()
	fk.sessions["dev"] = []tmux.SessionInfo{{Name: "work"}}
	fk.windows["dev"] = map[string][]tmux.WindowInfo{
		"work": {{
			WindowID: "@5",
			Role:     "reviewer",
			Panes:    []tmux.PaneInfo{{PaneID: "%20", AgentState: tmux.AgentStateIdle}},
		}},
	}
	fk.agent["dev"] = map[string]string{"@5": "%20"}
	fk.panes["dev"] = map[string]tmux.PaneFacts{
		"%20": {AgentState: tmux.AgentStateIdle, AgentStateEpoch: 1700000000},
	}

	entries := []Entry{
		{ID: "rev", Target: Target{Kind: TargetRole, Role: "reviewer"}},
		{ID: "none", Target: Target{Kind: TargetRole, Role: "wizard"}},
	}
	out := GatherFacts(context.Background(), "dev", entries, fk)

	rev := out.Targets["rev"]
	if !rev.Resolved() || rev.PaneID != "%20" || rev.StateEpoch != 1700000000 {
		t.Errorf("reviewer role target = %+v, want %%20 epoch 1700000000", rev)
	}
	none := out.Targets["none"]
	if none.Resolved() {
		t.Errorf("un-carried role resolved: %+v", none)
	}
	if none.Unresolved != "no window carries role wizard" {
		t.Errorf("unresolved detail = %q, want the role-naming form", none.Unresolved)
	}
	var sawDiag bool
	for _, d := range out.Diags {
		if d.EntryID == "none" && d.Reason == "target-unresolved" && d.Detail == "no window carries role wizard" {
			sawDiag = true
		}
	}
	if !sawDiag {
		t.Errorf("diags = %+v, want the no-window-carries diagnostic for wizard", out.Diags)
	}
}
