package tmux

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestParseRunWindows(t *testing.T) {
	d := listDelim
	line := func(win, sess, name, role, run, pane, dead string) string {
		return strings.Join([]string{win, sess, name, role, run, pane, dead}, d)
	}
	lines := []string{
		line("@1", OperatorSessionName, "chat", "operator", "", "%1", "0"),
		line("@2", OperatorSessionName, "run-ab12", RoleOperatorRun, "20261112T101500-ab12", "%2", "0"),
		line("@2", OperatorSessionName, "run-ab12", RoleOperatorRun, "20261112T101500-ab12", "%5", "1"),
		line("@3", "work", "main", "", "", "%3", "0"),
		line("@4", OperatorSessionName, "run-cd34", RoleOperatorRun, "20261112T102000-cd34", "%4", "0"),
		"malformed",
	}
	got := parseRunWindows(lines)
	want := []RunWindow{
		{WindowID: "@2", Session: OperatorSessionName, Name: "run-ab12", RunID: "20261112T101500-ab12", PaneIDs: []string{"%2"}},
		{WindowID: "@4", Session: OperatorSessionName, Name: "run-cd34", RunID: "20261112T102000-cd34", PaneIDs: []string{"%4"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseRunWindows = %+v, want %+v", got, want)
	}
	if len(parseRunWindows(nil)) != 0 {
		t.Error("no lines must parse to no windows")
	}
}

// TestParseRunWindowsCountsOnlyLiveStampedWindows: a role without a valid run
// id, and a window whose panes are all dead, are not runs in flight.
func TestParseRunWindowsCountsOnlyLiveStampedWindows(t *testing.T) {
	d := listDelim
	line := func(win, run, pane, dead string) string {
		return strings.Join([]string{win, OperatorSessionName, "run-x", RoleOperatorRun, run, pane, dead}, d)
	}
	const id = "20261112T101500-ab12"
	for name, lines := range map[string][]string{
		"role without a run id":   {line("@1", "", "%1", "0")},
		"role with a bad run id":  {line("@1", "../etc", "%1", "0")},
		"every pane dead":         {line("@1", id, "%1", "1"), line("@1", id, "%2", "1")},
		"dead pane, no live pane": {line("@1", id, "%1", "1")},
	} {
		if got := parseRunWindows(lines); len(got) != 0 {
			t.Errorf("%s: parseRunWindows = %+v, want none", name, got)
		}
	}
	got := parseRunWindows([]string{line("@1", id, "%1", "1"), line("@1", id, "%2", "0")})
	if len(got) != 1 || !reflect.DeepEqual(got[0].PaneIDs, []string{"%2"}) {
		t.Errorf("one live pane among dead ones: %+v, want the window with only %%2", got)
	}
}

func TestRunWindowsFormatCarriesStamps(t *testing.T) {
	for _, want := range []string{"#{" + RoleOption + "}", "#{" + OperatorRunOption + "}", "#{window_id}", "#{pane_id}", "#{pane_dead}"} {
		if !strings.Contains(runWindowsFormat, want) {
			t.Errorf("format %q missing %q", runWindowsFormat, want)
		}
	}
	if n := len(strings.Split(runWindowsFormat, listDelim)); n != runWindowsFields {
		t.Errorf("format has %d fields, runWindowsFields = %d", n, runWindowsFields)
	}
}

// TestBuildRunWindowArgs: one invocation creates the window detached and
// stamps it, targeting the new window by its unique exact name (a detached
// window is not the invocation's current window).
func TestBuildRunWindowArgs(t *testing.T) {
	args := buildRunWindowArgs("run-ab12", "/home/u", "'rk' 'operator' 'run-exec'", "20261112T101500-ab12")
	if len(args) < 2 || args[0] != "new-window" || args[1] != "-d" {
		t.Fatalf("argv = %v, want new-window -d first", args)
	}
	joined := strings.Join(args, " ")
	target := "=" + OperatorSessionName + ":=run-ab12"
	for _, want := range []string{
		"-n run-ab12", "-c /home/u", "=" + OperatorSessionName + ":",
		"set-option -w -t " + target + " " + RoleOption + " " + RoleOperatorRun,
		"set-option -w -t " + target + " " + OperatorRunOption + " 20261112T101500-ab12",
		"set-option -w -t " + target + " remain-on-exit off",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("argv %q missing %q", joined, want)
		}
	}
	if strings.Contains(joined, "exec \"${SHELL") {
		t.Errorf("argv %q: no shell-fallback tail", joined)
	}
	if n := strings.Count(joined, " ; "); n != 3 {
		t.Errorf("argv has %d chained commands after new-window, want 3 set-options", n)
	}
}

// windowRoles lists the role of every window in the operator session.
func windowRoles(t *testing.T, server string) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wins, err := ListWindows(ctx, OperatorSessionName, server)
	if err != nil {
		t.Fatalf("ListWindows: %v", err)
	}
	var roles []string
	for _, w := range wins {
		roles = append(roles, w.Role)
	}
	return roles
}

// TestLaunchOperatorRunWindowCreatesSessionWithOnlyTheRunWindow: when the call
// creates _rk-operator, the new-session placeholder shell is killed so the
// session holds exactly the stamped run window (and so reads as hidden).
func TestLaunchOperatorRunWindowCreatesSessionWithOnlyTheRunWindow(t *testing.T) {
	server := withSessionOrderTmux(t)
	ctx := context.Background()

	birth, err := LaunchOperatorRunWindow(ctx, server, "run-ab12", t.TempDir(), "sleep 30", "20261112T101500-ab12")
	if err != nil {
		t.Fatalf("LaunchOperatorRunWindow: %v", err)
	}
	if roles := windowRoles(t, server); len(roles) != 1 || roles[0] != RoleOperatorRun {
		t.Fatalf("operator session roles = %v, want exactly one operator-run window", roles)
	}
	wins, err := ListOperatorRunWindows(ctx, server)
	if err != nil || len(wins) != 1 || wins[0].RunID != "20261112T101500-ab12" || wins[0].WindowID != birth.WindowID || wins[0].Name != "run-ab12" {
		t.Fatalf("run windows = %+v, err %v", wins, err)
	}
}

// TestLaunchOperatorRunWindowLeavesAdoptedSessionAndFocusAlone: with a chat
// window already in _rk-operator, the run window is added detached (the chat
// window stays current) and no existing window is killed.
func TestLaunchOperatorRunWindowLeavesAdoptedSessionAndFocusAlone(t *testing.T) {
	server := withSessionOrderTmux(t)
	ctx := context.Background()
	if err := EnsureOperatorSession(ctx, serverArgs(server)); err != nil {
		t.Fatal(err)
	}
	wins, err := ListWindows(ctx, OperatorSessionName, server)
	if err != nil || len(wins) != 1 {
		t.Fatalf("seed windows = %+v, err %v", wins, err)
	}
	chat := wins[0].WindowID

	birth, err := LaunchOperatorRunWindow(ctx, server, "run-cd34", t.TempDir(), "sleep 30", "20261112T102000-cd34")
	if err != nil {
		t.Fatal(err)
	}
	wins, err = ListWindows(ctx, OperatorSessionName, server)
	if err != nil || len(wins) != 2 {
		t.Fatalf("windows = %+v, err %v", wins, err)
	}
	for _, w := range wins {
		switch w.WindowID {
		case chat:
			if !w.IsActiveWindow {
				t.Error("the existing window lost focus to the run window")
			}
			if w.Role != "" {
				t.Errorf("the run's stamps landed on the existing window: role %q", w.Role)
			}
		case birth.WindowID:
			if w.IsActiveWindow || w.Role != RoleOperatorRun {
				t.Errorf("run window = %+v, want detached and stamped", w)
			}
		default:
			t.Errorf("unexpected window %+v", w)
		}
	}
}

// TestLaunchOperatorRunWindowStampsAtomicallyAndPinsRemainOnExit: the window
// carries both stamps and remain-on-exit off as soon as it exists, so a user's
// global `remain-on-exit on` leaves no dead window behind and a finished run
// is gone from the listing.
func TestLaunchOperatorRunWindowStampsAtomicallyAndPinsRemainOnExit(t *testing.T) {
	server := withSessionOrderTmux(t)
	ctx := context.Background()
	if _, err := tmuxExecServer(ctx, server, "set-option", "-g", "remain-on-exit", "on"); err != nil {
		t.Fatal(err)
	}

	const id = "20261112T101500-ab12"
	birth, err := LaunchOperatorRunWindow(ctx, server, "run-ab12", t.TempDir(), "sleep 1", id)
	if err != nil {
		t.Fatal(err)
	}
	lines, err := tmuxExecServer(ctx, server, "show-options", "-w", "-v", "-t", birth.WindowID, "remain-on-exit")
	if err != nil || len(lines) != 1 || strings.TrimSpace(lines[0]) != "off" {
		t.Fatalf("remain-on-exit = %v, err %v, want the window pinned off", lines, err)
	}
	wins, err := ListOperatorRunWindows(ctx, server)
	if err != nil || len(wins) != 1 || wins[0].RunID != id || len(wins[0].PaneIDs) != 1 {
		t.Fatalf("run windows = %+v, err %v", wins, err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if wins, _ = ListOperatorRunWindows(ctx, server); len(wins) == 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("run window still listed after its command exited: %+v", wins)
}

// TestListOperatorRunWindowsIgnoresRoleOnlyAndDeadWindows: against real tmux,
// a window stamped operator-run with no run id, and one whose pane is dead,
// are not runs in flight.
func TestListOperatorRunWindowsIgnoresRoleOnlyAndDeadWindows(t *testing.T) {
	server := withSessionOrderTmux(t)
	ctx := context.Background()
	if err := EnsureOperatorSession(ctx, serverArgs(server)); err != nil {
		t.Fatal(err)
	}
	role := RoleOperatorRun
	roleOnly, err := CreateWindowWithOptionsID(OperatorSessionName, "role-only", t.TempDir(), server, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetWindowOptions(ctx, roleOnly, server, []WindowOptionOp{{Key: RoleOption, Value: &role}}); err != nil {
		t.Fatal(err)
	}

	// A stamped window whose only pane is dead (remain-on-exit keeps it).
	const id = "20261112T102000-cd34"
	dead, err := CreateWindowWithOptionsID(OperatorSessionName, "run-cd34", t.TempDir(), server, nil)
	if err != nil {
		t.Fatal(err)
	}
	run, on := id, "on"
	if err := SetWindowOptions(ctx, dead, server, []WindowOptionOp{
		{Key: RoleOption, Value: &role}, {Key: OperatorRunOption, Value: &run}, {Key: "remain-on-exit", Value: &on},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := tmuxExecServer(ctx, server, "respawn-window", "-k", "-t", dead, "true"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		lines, _ := tmuxExecServer(ctx, server, "list-panes", "-t", dead, "-F", "#{pane_dead}")
		if len(lines) == 1 && strings.TrimSpace(lines[0]) == "1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the pane never died")
		}
		time.Sleep(50 * time.Millisecond)
	}

	if wins, err := ListOperatorRunWindows(ctx, server); err != nil || len(wins) != 0 {
		t.Fatalf("run windows = %+v, err %v, want none", wins, err)
	}
}
