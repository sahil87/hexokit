package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"rk/internal/tmux"
)

func installInventoryFakes(t *testing.T, names []string) {
	t.Helper()
	installMuxFakes(t, &muxFake{})
	oldServers, oldWindows := muxInventoryServersFn, muxInventoryWindowsFn
	t.Cleanup(func() { muxInventoryServersFn, muxInventoryWindowsFn = oldServers, oldWindows })
	muxInventoryServersFn = func(context.Context) ([]string, error) { return append([]string(nil), names...), nil }
	muxInventoryWindowsFn = muxPanesWindowsFn
}

func decodeInventory(t *testing.T, stdout string) muxInventoryResult {
	t.Helper()
	var doc struct {
		OK     bool               `json:"ok"`
		Result muxInventoryResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
		t.Fatalf("decode inventory: %v\n%s", err, stdout)
	}
	if !doc.OK {
		t.Fatalf("unsuccessful envelope: %s", stdout)
	}
	return doc.Result
}

func TestMuxInventoryAllServers(t *testing.T) {
	installInventoryFakes(t, []string{"zeta", "alpha"})
	// An ambient tmux server must not silently scope the fleet query.
	muxOriginalTMUXFn = func() string { return "/tmp/tmux-1/other,123,0" }
	out, stderr, err := runMuxCmd(t, "inventory", "--json")
	if err != nil || stderr != "" {
		t.Fatalf("inventory: %v stderr=%s", err, stderr)
	}
	r := decodeInventory(t, out)
	if r.Partial || r.ObservedAt != time.Unix(1_800_000_300, 0).UTC().Format(time.RFC3339Nano) {
		t.Fatalf("metadata: %+v", r)
	}
	if len(r.Servers) != 2 || r.Servers[0].Server != "alpha" || r.Servers[1].Server != "zeta" {
		t.Fatalf("servers: %+v", r.Servers)
	}
	for _, s := range r.Servers {
		if s.PaneCount != 2 || len(s.Panes) != 2 || s.Panes[0].Pane != "%5" || s.Panes[0].WindowID != "@3" || s.Panes[0].SessionID != "$3" || s.Panes[0].AgentState == nil || s.Error != nil || s.Truncated {
			t.Fatalf("server: %+v", s)
		}
		if len(s.Sessions) == 0 {
			t.Fatal("session roles missing")
		}
	}
}

func TestMuxInventoryExplicitServer(t *testing.T) {
	installInventoryFakes(t, nil)
	muxInventoryServersFn = func(context.Context) ([]string, error) {
		t.Error("scoped query discovered servers")
		return nil, errors.New("unexpected discovery")
	}
	out, _, err := runMuxCmd(t, "inventory", "-L", "work", "--json")
	if err != nil {
		t.Fatal(err)
	}
	r := decodeInventory(t, out)
	if len(r.Servers) != 1 || r.Servers[0].Server != "work" {
		t.Fatalf("scope: %+v", r)
	}
}

func TestMuxInventoryUsage(t *testing.T) {
	for _, args := range [][]string{{"--limit", "0"}, {"--limit", "5001"}, {"-L", ""}, {"-L", "bad/name"}} {
		t.Run(fmt.Sprint(args), func(t *testing.T) {
			installInventoryFakes(t, nil)
			_, _, err := runMuxCmd(t, append([]string{"inventory"}, args...)...)
			if err == nil || exitCode(err) != 2 {
				t.Fatalf("err=%v exit=%d", err, exitCode(err))
			}
		})
	}
}

func TestMuxInventoryPartial(t *testing.T) {
	installInventoryFakes(t, []string{"healthy", "broken"})
	original := muxInventoryWindowsFn
	muxInventoryWindowsFn = func(ctx context.Context, session, server string) ([]tmux.WindowInfo, error) {
		if server == "broken" {
			return nil, errors.New("permission denied")
		}
		return original(ctx, session, server)
	}
	out, _, err := runMuxCmd(t, "inventory", "--json")
	if err != nil {
		t.Fatal(err)
	}
	r := decodeInventory(t, out)
	if !r.Partial || r.Servers[0].Error == nil || !strings.Contains(*r.Servers[0].Error, "permission denied") || len(r.Servers[1].Panes) != 2 || r.Servers[1].Error != nil {
		t.Fatalf("partial: %+v", r)
	}
	if r.Servers[0].Panes == nil {
		t.Fatal("failed server panes must be [], not null")
	}
}

func TestMuxInventoryPreservesObservedRows(t *testing.T) {
	installInventoryFakes(t, []string{"work"})
	muxPanesSessionsFn = func(context.Context, string) ([]tmux.SessionInfo, error) {
		return []tmux.SessionInfo{{Name: "first"}, {Name: "gone"}}, nil
	}
	original := muxInventoryWindowsFn
	muxInventoryWindowsFn = func(ctx context.Context, session, server string) ([]tmux.WindowInfo, error) {
		if session == "gone" {
			return nil, errors.New("session disappeared")
		}
		return original(ctx, session, server)
	}
	out, _, err := runMuxCmd(t, "inventory", "--json")
	if err != nil {
		t.Fatal(err)
	}
	r := decodeInventory(t, out)
	if !r.Partial || len(r.Servers[0].Panes) != 2 || r.Servers[0].Panes[0].Session != "first" {
		t.Fatalf("lost observed rows: %+v", r)
	}
}

func TestMuxInventoryEmptyAndDiscoveryFailure(t *testing.T) {
	installInventoryFakes(t, nil)
	out, _, err := runMuxCmd(t, "inventory", "--json")
	if err != nil {
		t.Fatal(err)
	}
	r := decodeInventory(t, out)
	if r.Partial || r.Servers == nil || len(r.Servers) != 0 {
		t.Fatalf("empty fleet: %+v", r)
	}
	muxInventoryServersFn = func(context.Context) ([]string, error) { return nil, errors.New("unreadable socket directory") }
	_, _, err = runMuxCmd(t, "inventory", "--json")
	if err == nil || exitCode(err) != 1 || !strings.Contains(err.Error(), "unreadable socket directory") {
		t.Fatalf("discovery error: %v", err)
	}
}

func TestMuxInventoryDeadServer(t *testing.T) {
	installInventoryFakes(t, []string{"died"})
	muxSessionsFactsFn = func(context.Context, string) ([]tmux.SessionFacts, error) { return nil, nil }
	muxSessionsAliveFn = func(context.Context, string) error { return errors.New("no server running") }
	out, _, err := runMuxCmd(t, "inventory", "--json")
	if err != nil {
		t.Fatal(err)
	}
	r := decodeInventory(t, out)
	if !r.Partial || r.Servers[0].Error == nil || r.Servers[0].Sessions == nil {
		t.Fatalf("dead server: %+v", r)
	}
}

func TestMuxInventoryAgentsAndLimit(t *testing.T) {
	installInventoryFakes(t, []string{"work"})
	muxInventoryWindowsFn = func(context.Context, string, string) ([]tmux.WindowInfo, error) {
		return []tmux.WindowInfo{{WindowID: "@1", Panes: []tmux.PaneInfo{
			{PaneID: "%1", Command: "zsh", PanePID: 1, AgentState: "idle"}, // stale state, agent exited
			{PaneID: "%2", Command: "claude"},                              // uninstrumented direct agent
			{PaneID: "%3", Command: "node", AgentState: "waiting"},
			{PaneID: "%4", Command: "vim"},
			{PaneID: "%5", Command: "bash", PanePID: 5}, // observed live child
		}}}, nil
	}
	muxProcessDiscoverFn = func(_ context.Context, pid int) ([]processNode, error) {
		if pid == 5 {
			return []processNode{{PID: 6, Classification: "agent"}}, nil
		}
		return []processNode{}, nil
	}
	out, _, err := runMuxCmd(t, "inventory", "--agents-only", "--limit", "2", "--json")
	if err != nil {
		t.Fatal(err)
	}
	r := decodeInventory(t, out).Servers[0]
	if r.PaneCount != 5 || !r.Truncated || len(r.Panes) != 2 || r.Panes[0].Pane != "%2" || r.Panes[1].Pane != "%3" {
		t.Fatalf("agent filter/limit: %+v", r)
	}
	out, _, err = runMuxCmd(t, "inventory", "--agents-only", "--limit", "3", "--json")
	if err != nil {
		t.Fatal(err)
	}
	r = decodeInventory(t, out).Servers[0]
	if r.Truncated || len(r.Panes) != 3 || r.Panes[2].Pane != "%5" {
		t.Fatalf("exact limit: %+v", r)
	}
}

func TestMuxInventoryCancellationAndFanout(t *testing.T) {
	installInventoryFakes(t, []string{"a", "b", "c", "d", "e", "f"})
	var running, maximum atomic.Int32
	muxSessionsFactsFn = func(ctx context.Context, _ string) ([]tmux.SessionFacts, error) {
		n := running.Add(1)
		defer running.Add(-1)
		for old := maximum.Load(); n > old && !maximum.CompareAndSwap(old, n); old = maximum.Load() {
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	rootCmd.SetContext(ctx)
	t.Cleanup(func() { rootCmd.SetContext(context.Background()) })
	out, _, err := runMuxCmd(t, "inventory", "--json")
	if err != nil {
		t.Fatal(err)
	}
	r := decodeInventory(t, out)
	if !r.Partial || maximum.Load() != 4 || running.Load() != 0 {
		t.Fatalf("partial=%v max=%d running=%d", r.Partial, maximum.Load(), running.Load())
	}
	for _, s := range r.Servers {
		if s.Error == nil {
			t.Fatalf("cancelled server appears healthy: %+v", s)
		}
	}
}

func TestMuxInventoryQuietPreservesErrors(t *testing.T) {
	installInventoryFakes(t, []string{"broken"})
	muxInventoryWindowsFn = func(context.Context, string, string) ([]tmux.WindowInfo, error) {
		return nil, errors.New("permission denied")
	}
	out, stderr, err := runMuxCmd(t, "inventory", "--quiet")
	if err != nil || !strings.Contains(out, "broken") || !strings.Contains(stderr, "permission denied") {
		t.Fatalf("out=%s stderr=%s err=%v", out, stderr, err)
	}
}
