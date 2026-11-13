package snapshot

import (
	"context"
	"errors"
	"strings"
	"testing"

	"rk/internal/tmux"
)

// stubLayoutReads swaps the tmux read seams for the duration of a test.
func stubLayoutReads(t *testing.T,
	sessions []tmux.LayoutSession, sessErr error,
	windows []tmux.LayoutWindow, winErr error,
	panes map[string][]tmux.LayoutPane, paneErr error,
	order []string, rank *int,
) {
	t.Helper()
	origSess, origWin, origPane := listLayoutSessions, listLayoutWindows, listLayoutPanes
	origOrder, origRank := getSessionOrder, getServerRank
	listLayoutSessions = func(ctx context.Context, server string) ([]tmux.LayoutSession, error) {
		return sessions, sessErr
	}
	listLayoutWindows = func(ctx context.Context, server string) ([]tmux.LayoutWindow, error) {
		return windows, winErr
	}
	listLayoutPanes = func(ctx context.Context, server string) (map[string][]tmux.LayoutPane, error) {
		return panes, paneErr
	}
	getSessionOrder = func(ctx context.Context, server string) ([]string, error) {
		return order, nil
	}
	getServerRank = func(ctx context.Context, server string) (*int, error) {
		return rank, nil
	}
	t.Cleanup(func() {
		listLayoutSessions, listLayoutWindows, listLayoutPanes = origSess, origWin, origPane
		getSessionOrder, getServerRank = origOrder, origRank
	})
}

func TestCaptureServerAssemblesSnapshot(t *testing.T) {
	rank := 2
	stubLayoutReads(t,
		[]tmux.LayoutSession{
			{Name: "beta", Created: 200, Color: ""},
			{Name: "alpha", Created: 100, Color: "4"},
		}, nil,
		[]tmux.LayoutWindow{
			{Session: "alpha", WindowID: "@2", Index: 2, Name: "shell", Layout: "l2"},
			{Session: "alpha", WindowID: "@1", Index: 1, Name: "serve", Active: true, Layout: "l1",
				Color: "1", RkLayout: "split-h:tty,web", WebTabs: []string{"/proxy/1/", "/present/@1/2/a.html?server=s&v=1", "https://x/"},
				WebRoots: []string{"/r1", "", "/r3"}, WebActive: 2, CodeRoot: "/w", Marker: "manual:1", Flair: "nyan", Role: "operator",
				Note: "1756036800:blocked on flaky e2e"},
			{Session: "beta", WindowID: "@3", Index: 0, Name: "b", Layout: "l3"},
		}, nil,
		map[string][]tmux.LayoutPane{
			"@1": {
				{WindowID: "@1", PaneID: "%1", Index: 1, Cwd: "/b", Command: "claude"},
				{WindowID: "@1", PaneID: "%0", Index: 0, Cwd: "/a", Command: "zsh", Active: true},
			},
		}, nil,
		[]string{"beta", "alpha"}, &rank,
	)

	snap, err := CaptureServer(context.Background(), "kit")
	if err != nil {
		t.Fatalf("CaptureServer: %v", err)
	}
	if snap.Server != "kit" || snap.TakenAt.IsZero() {
		t.Errorf("server/takenAt not set: %+v", snap)
	}
	if snap.ServerRank == nil || *snap.ServerRank != 2 {
		t.Errorf("serverRank = %v, want 2", snap.ServerRank)
	}
	if len(snap.SessionOrder) != 2 || snap.SessionOrder[0] != "beta" {
		t.Errorf("sessionOrder = %v", snap.SessionOrder)
	}
	// Sessions sorted by creation time: alpha (100) before beta (200).
	if len(snap.Sessions) != 2 || snap.Sessions[0].Name != "alpha" || snap.Sessions[1].Name != "beta" {
		t.Fatalf("sessions = %+v", snap.Sessions)
	}
	alpha := snap.Sessions[0]
	if alpha.CreatedAt != 100 || alpha.Color != "4" {
		t.Errorf("alpha meta = %+v", alpha)
	}
	// Windows sorted by index within the session.
	if len(alpha.Windows) != 2 || alpha.Windows[0].ID != "@1" || alpha.Windows[1].ID != "@2" {
		t.Fatalf("alpha windows = %+v", alpha.Windows)
	}
	w1 := alpha.Windows[0]
	if !w1.Active || w1.Layout != "l1" || w1.Color != "1" || w1.RkLayout != "split-h:tty,web" ||
		len(w1.WebTabs) != 3 || w1.WebTabs[0] != "/proxy/1/" || w1.WebTabs[2] != "https://x/" ||
		len(w1.WebRoots) != 3 || w1.WebRoots[0] != "/r1" || w1.WebRoots[1] != "" || w1.WebRoots[2] != "/r3" ||
		w1.WebActive != 2 || w1.CodeRoot != "/w" ||
		w1.Marker != "manual:1" || w1.Flair != "nyan" || w1.Role != "operator" || w1.Note != "1756036800:blocked on flaky e2e" {
		t.Errorf("window @1 = %+v", w1)
	}
	// Panes sorted by index.
	if len(w1.Panes) != 2 || w1.Panes[0].ID != "%0" || w1.Panes[1].ID != "%1" {
		t.Fatalf("window @1 panes = %+v", w1.Panes)
	}
	if w1.Panes[0].Cwd != "/a" || w1.Panes[0].Command != "zsh" || !w1.Panes[0].Active {
		t.Errorf("pane %%0 = %+v", w1.Panes[0])
	}
	if snap.WindowCount() != 3 || snap.SessionCount() != 2 {
		t.Errorf("counts = %d sessions / %d windows", snap.SessionCount(), snap.WindowCount())
	}
}

func TestCaptureServerDeadServerErrorPropagates(t *testing.T) {
	dead := errors.New("layout list-sessions: exit status 1: no server running on /tmp/tmux-1/kit")
	stubLayoutReads(t, nil, dead, nil, nil, nil, nil, nil, nil)

	snap, err := CaptureServer(context.Background(), "kit")
	if err == nil {
		t.Fatal("want error for dead server, got nil")
	}
	if snap != nil {
		t.Fatalf("want nil snapshot on error, got %+v", snap)
	}
	if !strings.Contains(err.Error(), "no server running") {
		t.Errorf("error should carry the dead-server text: %v", err)
	}
	if !tmux.IsServerGone(err) {
		t.Errorf("capture error should stay IsServerGone-classifiable: %v", err)
	}
}

// stubWindowReads swaps the single-window read seams (CaptureWindow's seams)
// for the duration of a test, mirroring stubLayoutReads.
func stubWindowReads(t *testing.T,
	win tmux.LayoutWindow, found bool, winErr error,
	panes []tmux.LayoutPane, paneErr error,
) {
	t.Helper()
	origWin, origPanes := listLayoutWindow, listLayoutPanesForWindow
	listLayoutWindow = func(ctx context.Context, server, windowID string) (tmux.LayoutWindow, bool, error) {
		return win, found, winErr
	}
	listLayoutPanesForWindow = func(ctx context.Context, server, windowID string) ([]tmux.LayoutPane, error) {
		return panes, paneErr
	}
	t.Cleanup(func() { listLayoutWindow, listLayoutPanesForWindow = origWin, origPanes })
}

// TestCaptureWindowAssemblesRecord: a live window captures exactly the Window
// shape CaptureServer would give it (full @rk_win_* set, panes index-sorted)
// plus the owning session name.
func TestCaptureWindowAssemblesRecord(t *testing.T) {
	stubWindowReads(t,
		tmux.LayoutWindow{Session: "alpha", WindowID: "@7", Index: 2, Name: "agent", Active: true,
			Layout: "l7", Color: "2", RkLayout: "single:web", WebTabs: []string{"/proxy/1/"},
			WebRoots: []string{"/r1"}, WebActive: 1, CodeRoot: "/w", Marker: "manual:1",
			Note: "1756036800:blocked"},
		true, nil,
		[]tmux.LayoutPane{
			{WindowID: "@7", PaneID: "%8", Index: 1, Cwd: "/b", Command: "claude", Active: true},
			{WindowID: "@7", PaneID: "%7", Index: 0, Cwd: "/a", Command: "zsh"},
		}, nil,
	)

	win, session, err := CaptureWindow(context.Background(), "kit", "@7")
	if err != nil {
		t.Fatalf("CaptureWindow: %v", err)
	}
	if session != "alpha" {
		t.Errorf("session = %q, want alpha", session)
	}
	if win.ID != "@7" || win.Index != 2 || win.Name != "agent" || !win.Active ||
		win.Layout != "l7" || win.Color != "2" || win.RkLayout != "single:web" ||
		len(win.WebTabs) != 1 || win.WebTabs[0] != "/proxy/1/" || win.WebRoots[0] != "/r1" ||
		win.WebActive != 1 || win.CodeRoot != "/w" || win.Marker != "manual:1" ||
		win.Note != "1756036800:blocked" {
		t.Errorf("window = %+v", win)
	}
	// Panes index-sorted (the reads return pane order unsorted).
	if len(win.Panes) != 2 || win.Panes[0].ID != "%7" || win.Panes[1].ID != "%8" {
		t.Fatalf("panes = %+v, want index order %%7,%%8", win.Panes)
	}
	if !win.Panes[1].Active || win.Panes[1].Command != "claude" {
		t.Errorf("pane %%8 = %+v", win.Panes[1])
	}
}

// TestCaptureWindowGoneIsAnError: a window that no longer exists (killed before
// the capture ran) is an error — the caller records nothing and kills anyway,
// so gone-vs-read-error is deliberately NOT distinguished.
func TestCaptureWindowGoneIsAnError(t *testing.T) {
	stubWindowReads(t, tmux.LayoutWindow{}, false, nil, nil, nil)

	_, _, err := CaptureWindow(context.Background(), "kit", "@99")
	if err == nil {
		t.Fatal("want error for a gone window")
	}
	if !strings.Contains(err.Error(), "@99") {
		t.Errorf("error should name the window: %v", err)
	}
}

// TestCaptureWindowReadErrorsPropagate: a tmux read failure (dead server,
// exec fault) on either read surfaces as an error.
func TestCaptureWindowReadErrorsPropagate(t *testing.T) {
	dead := errors.New("layout list-windows: exit status 1: no server running")
	stubWindowReads(t, tmux.LayoutWindow{}, false, dead, nil, nil)
	if _, _, err := CaptureWindow(context.Background(), "kit", "@7"); err == nil {
		t.Fatal("want error for a failed window read")
	}

	paneDead := errors.New("layout list-panes: exit status 1")
	stubWindowReads(t,
		tmux.LayoutWindow{Session: "alpha", WindowID: "@7", Index: 1, Name: "w"}, true, nil,
		nil, paneDead)
	if _, _, err := CaptureWindow(context.Background(), "kit", "@7"); err == nil {
		t.Fatal("want error for a failed pane read")
	}
}

// TestCaptureServerSkipsRunWindows: an operator-run window is never captured,
// and a session that held only run windows is dropped with them, so a
// restored snapshot cannot hold a window that reads as a run in flight.
func TestCaptureServerSkipsRunWindows(t *testing.T) {
	stubLayoutReads(t,
		[]tmux.LayoutSession{
			{Name: tmux.OperatorSessionName, Created: 100},
			{Name: "work", Created: 200},
		}, nil,
		[]tmux.LayoutWindow{
			{Session: tmux.OperatorSessionName, WindowID: "@1", Index: 0, Name: "run-ab12", Role: tmux.RoleOperatorRun},
			{Session: "work", WindowID: "@2", Index: 0, Name: "main"},
			{Session: "work", WindowID: "@3", Index: 1, Name: "run-cd34", Role: tmux.RoleOperatorRun},
		}, nil,
		map[string][]tmux.LayoutPane{}, nil,
		nil, nil,
	)

	snap, err := CaptureServer(context.Background(), "kit")
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Sessions) != 1 || snap.Sessions[0].Name != "work" {
		t.Fatalf("sessions = %+v, want only work (the run-only session is dropped)", snap.Sessions)
	}
	if ws := snap.Sessions[0].Windows; len(ws) != 1 || ws[0].ID != "@2" {
		t.Errorf("work windows = %+v, want only @2", ws)
	}
}

// TestCaptureWindowRefusesRunWindow: the kill-seam capture records nothing for
// a run window.
func TestCaptureWindowRefusesRunWindow(t *testing.T) {
	stubWindowReads(t,
		tmux.LayoutWindow{Session: tmux.OperatorSessionName, WindowID: "@7", Name: "run-ab12", Role: tmux.RoleOperatorRun},
		true, nil, nil, nil)
	if _, _, err := CaptureWindow(context.Background(), "kit", "@7"); err == nil {
		t.Fatal("want error for a run window")
	}
}
