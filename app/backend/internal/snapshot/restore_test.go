package snapshot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"rk/internal/tmux"
)

// fakeRestore records the engine's tmux mutations.
type fakeRestore struct {
	live []tmux.SessionInfo

	calls []string // ordered call trace

	nextWindow int
	// failCreateAt makes createWindowAt fail for the given index.
	failCreateAt map[int]error
	// opsCreateAppendErr makes createWindowAppend fail (reopen fallback path).
	opsCreateAppendErr error
	// failSplit makes every splitWindow call fail.
	failSplit error
	// failLayout makes selectLayout fail.
	failLayout error
	// missingDirs marks cwds that no longer exist.
	missingDirs map[string]bool
	// bornIndex is the index new sessions' first windows are born at
	// (models base-index).
	bornIndex int
}

func (f *fakeRestore) ops() restoreOps {
	return restoreOps{
		listSessions: func(ctx context.Context, server string) ([]tmux.SessionInfo, error) {
			return f.live, nil
		},
		createSession: func(name, windowName, cwd, server string) (string, int, error) {
			f.nextWindow++
			id := fmt.Sprintf("@%d", f.nextWindow)
			f.calls = append(f.calls, fmt.Sprintf("new-session %s -n %s -c %q -> %s", name, windowName, cwd, id))
			return id, f.bornIndex, nil
		},
		createWindowAt: func(session string, index int, name, cwd, server string) (string, error) {
			if err := f.failCreateAt[index]; err != nil {
				return "", err
			}
			f.nextWindow++
			id := fmt.Sprintf("@%d", f.nextWindow)
			f.calls = append(f.calls, fmt.Sprintf("new-window %s:%d -n %s -c %q -> %s", session, index, name, cwd, id))
			return id, nil
		},
		createWindowAppend: func(session, name, cwd, server string) (string, error) {
			if f.opsCreateAppendErr != nil {
				return "", f.opsCreateAppendErr
			}
			f.nextWindow++
			id := fmt.Sprintf("@%d", f.nextWindow)
			f.calls = append(f.calls, fmt.Sprintf("new-window-append %s -n %s -c %q -> %s", session, name, cwd, id))
			return id, nil
		},
		renumberWindow: func(session, windowID string, index int, server string) error {
			f.calls = append(f.calls, fmt.Sprintf("renumber-window %s:%s -> %d", session, windowID, index))
			return nil
		},
		splitWindow: func(windowID string, horizontal bool, cwd, server string) (string, error) {
			if f.failSplit != nil {
				return "", f.failSplit
			}
			f.calls = append(f.calls, fmt.Sprintf("split-window %s -c %q", windowID, cwd))
			return "%9", nil
		},
		selectLayout: func(windowID, layout, server string) error {
			if f.failLayout != nil {
				return f.failLayout
			}
			f.calls = append(f.calls, fmt.Sprintf("select-layout %s %s", windowID, layout))
			return nil
		},
		selectPane: func(paneID, server string) error {
			f.calls = append(f.calls, fmt.Sprintf("select-pane %s", paneID))
			return nil
		},
		selectWindow: func(session, windowID, server string) error {
			f.calls = append(f.calls, fmt.Sprintf("select-window %s:%s", session, windowID))
			return nil
		},
		setSessionColor: func(session, color, server string) error {
			f.calls = append(f.calls, fmt.Sprintf("session-color %s=%s", session, color))
			return nil
		},
		setWindowOpts: func(ctx context.Context, windowID, server string, ops []tmux.WindowOptionOp) error {
			keys := make([]string, 0, len(ops))
			for _, op := range ops {
				keys = append(keys, op.Key+"="+*op.Value)
			}
			f.calls = append(f.calls, fmt.Sprintf("window-opts %s %s", windowID, strings.Join(keys, ",")))
			return nil
		},
		setSessionOrder: func(ctx context.Context, server string, order []string) error {
			f.calls = append(f.calls, fmt.Sprintf("session-order %s", strings.Join(order, ",")))
			return nil
		},
		setServerRank: func(ctx context.Context, server string, rank int) error {
			f.calls = append(f.calls, fmt.Sprintf("server-rank %d", rank))
			return nil
		},
		dirExists: func(path string) bool { return !f.missingDirs[path] },
	}
}

func (f *fakeRestore) trace() string { return strings.Join(f.calls, "\n") }

func restoreFixture() *Snapshot {
	rank := 3
	return &Snapshot{
		Server:       "kit",
		TakenAt:      time.Now().UTC(),
		ServerRank:   &rank,
		SessionOrder: []string{"beta", "alpha"},
		Sessions: []Session{
			{
				Name: "alpha", CreatedAt: 100, Color: "4",
				Windows: []Window{
					{Index: 1, ID: "@10", Name: "serve", Layout: "l1", Color: "2", Marker: "manual:1", Flair: "onepiece", Role: "operator", Owner: "operator",
						Note: "1756036800:blocked on flaky e2e",
						Panes: []Pane{
							{ID: "%0", Index: 0, Cwd: "/proj", Command: "zsh"},
							{ID: "%1", Index: 1, Cwd: "/proj/sub", Command: "claude", Active: true},
						}},
					{Index: 3, ID: "@11", Name: "agent", Active: true,
						Panes: []Pane{{ID: "%2", Index: 0, Cwd: "/agent", Command: "claude"}}},
				},
			},
			{
				Name: "beta", CreatedAt: 200,
				Windows: []Window{
					{Index: 0, ID: "@20", Name: "b", Active: true,
						Panes: []Pane{{ID: "%3", Index: 0, Cwd: "/b", Command: "bash"}}},
				},
			},
		},
	}
}

func TestRestoreRecreatesFullLayout(t *testing.T) {
	f := &fakeRestore{bornIndex: 1}
	report, err := restore(context.Background(), "kit", restoreFixture(), f.ops())
	if err != nil {
		t.Fatalf("restore: %v\ntrace:\n%s", err, f.trace())
	}

	wantCalls := []string{
		`new-session alpha -n serve -c "/proj" -> @1`, // born at 1 == stored 1, no move
		`split-window @1 -c "/proj/sub"`,
		`select-layout @1 l1`,
		`select-pane %9`, // stored active pane %1 (position 1) → split-created %9
		`window-opts @1 @rk_win_color=2,@rk_win_marker=manual:1,@rk_win_flair=onepiece,@rk_win_role=operator,@rk_win_owner=operator,@rk_win_note=1756036800:blocked on flaky e2e`,
		`new-window alpha:3 -n agent -c "/agent" -> @2`,
		`select-window alpha:@2`, // stored active window @11 → new id @2
		`session-color alpha=4`,
		`new-session beta -n b -c "/b" -> @3`,
		`renumber-window beta:@3 -> 0`, // born at 1, stored index 0
		`select-window beta:@3`,
		`session-order beta,alpha`,
		`server-rank 3`,
	}
	if got := f.trace(); got != strings.Join(wantCalls, "\n") {
		t.Errorf("call trace mismatch:\ngot:\n%s\n\nwant:\n%s", got, strings.Join(wantCalls, "\n"))
	}

	if len(report.Sessions) != 2 {
		t.Fatalf("report sessions = %+v", report.Sessions)
	}
	w0 := report.Sessions[0].Windows[0]
	if w0.Panes != 2 || len(w0.FormerCommands) != 2 || w0.FormerCommands[1] != "claude" {
		t.Errorf("window report = %+v", w0)
	}
	if len(report.Skipped) != 0 {
		t.Errorf("unexpected skips: %v", report.Skipped)
	}
}

func TestRestoreRefusesLiveServerWithSessions(t *testing.T) {
	f := &fakeRestore{live: []tmux.SessionInfo{{Name: "existing"}}}
	_, err := restore(context.Background(), "kit", restoreFixture(), f.ops())
	if err == nil {
		t.Fatal("want refusal error for live server")
	}
	if !strings.Contains(err.Error(), "refusing to restore") {
		t.Errorf("refusal message: %v", err)
	}
	if len(f.calls) != 0 {
		t.Errorf("refusal must touch nothing, got calls: %v", f.calls)
	}
}

func TestRestoreMissingCwdFallsBackWithNote(t *testing.T) {
	f := &fakeRestore{bornIndex: 1, missingDirs: map[string]bool{"/proj": true, "/proj/sub": true}}
	report, err := restore(context.Background(), "kit", restoreFixture(), f.ops())
	if err != nil {
		t.Fatal(err)
	}
	// The first window's create and its split carry empty cwds.
	if !strings.Contains(f.trace(), `new-session alpha -n serve -c "" -> @1`) {
		t.Errorf("missing cwd not dropped from session create:\n%s", f.trace())
	}
	if !strings.Contains(f.trace(), `split-window @1 -c ""`) {
		t.Errorf("missing cwd not dropped from split:\n%s", f.trace())
	}
	notes := strings.Join(report.Sessions[0].Windows[0].Notes, "\n")
	if !strings.Contains(notes, "/proj missing on disk") {
		t.Errorf("missing-cwd note absent: %q", notes)
	}
}

func TestRestoreFailedLayoutAndPaneDegrade(t *testing.T) {
	f := &fakeRestore{bornIndex: 1, failLayout: errors.New("pane count mismatch")}
	report, err := restore(context.Background(), "kit", restoreFixture(), f.ops())
	if err != nil {
		t.Fatal(err)
	}
	notes := strings.Join(report.Sessions[0].Windows[0].Notes, "\n")
	if !strings.Contains(notes, "layout not reapplied") {
		t.Errorf("layout failure note absent: %q", notes)
	}

	// A failed split is reported and the window still lands.
	f = &fakeRestore{bornIndex: 1, failSplit: errors.New("boom")}
	report, err = restore(context.Background(), "kit", restoreFixture(), f.ops())
	if err != nil {
		t.Fatal(err)
	}
	w0 := report.Sessions[0].Windows[0]
	if w0.Panes != 1 {
		t.Errorf("panes = %d, want 1 after failed split", w0.Panes)
	}
	if !strings.Contains(strings.Join(w0.Notes, "\n"), "pane 1 not recreated") {
		t.Errorf("split failure note absent: %+v", w0.Notes)
	}
	// Layout must not be attempted with a single pane, and the stored active
	// pane (position 1, whose split failed) must not be selected — there is no
	// pane id to target.
	if strings.Contains(f.trace(), "select-layout") {
		t.Errorf("layout applied despite missing pane:\n%s", f.trace())
	}
	if strings.Contains(f.trace(), "select-pane") {
		t.Errorf("active pane selected despite failed split:\n%s", f.trace())
	}
}

func TestRestoreRejectsServerMismatch(t *testing.T) {
	f := &fakeRestore{bornIndex: 1}
	// The fixture snapshot embeds Server "kit"; the caller-validated target is
	// a different server — the confused-deputy guard must refuse before any
	// tmux mutation.
	_, err := restore(context.Background(), "other", restoreFixture(), f.ops())
	if err == nil {
		t.Fatal("want server-mismatch refusal")
	}
	if !strings.Contains(err.Error(), `belongs to server "kit"`) {
		t.Errorf("mismatch message: %v", err)
	}
	if len(f.calls) != 0 {
		t.Errorf("mismatch refusal must touch nothing, got calls: %v", f.calls)
	}
}

func TestRestoreFailedWindowIsSkippedNotFatal(t *testing.T) {
	f := &fakeRestore{bornIndex: 1, failCreateAt: map[int]error{3: errors.New("index in use")}}
	report, err := restore(context.Background(), "kit", restoreFixture(), f.ops())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Skipped) != 1 || !strings.Contains(report.Skipped[0], `window 3 (agent)`) {
		t.Errorf("skips = %v", report.Skipped)
	}
	// The rest of the restore proceeded.
	if !strings.Contains(f.trace(), "new-session beta") {
		t.Errorf("beta not restored after alpha window skip:\n%s", f.trace())
	}
}

func TestRestoreEmptySnapshotErrors(t *testing.T) {
	if _, err := restore(context.Background(), "kit", nil, restoreOps{}); err == nil {
		t.Error("nil snapshot must error")
	}
	if _, err := restore(context.Background(), "kit", &Snapshot{Server: "kit"}, restoreOps{}); err == nil {
		t.Error("sessionless snapshot must error")
	}
}

// TestWindowOptionOpsWebFamily pins the restore mapping for the web-tab
// family: layout, dense slots with URL and root together, the active pointer
// only when > 0, and the code root.
func TestWindowOptionOpsWebFamily(t *testing.T) {
	win := Window{
		RkLayout:  "split-h:tty,web",
		WebTabs:   []string{"/proxy/1/", "/present/@9/2/a.html?server=s&v=1", "https://x/"},
		WebRoots:  []string{"/r1", "", "/r3"},
		WebActive: 2,
		CodeRoot:  "/w",
	}
	ops := WindowOptionOps(win)
	var got []string
	for _, op := range ops {
		got = append(got, op.Key+"="+*op.Value)
	}
	want := []string{
		"@rk_win_layout=split-h:tty,web",
		"@rk_win_web_1=/proxy/1/",
		"@rk_win_web_1_root=/r1",
		"@rk_win_web_2=/present/@9/2/a.html?server=s&v=1",
		"@rk_win_web_3=https://x/",
		"@rk_win_web_3_root=/r3",
		"@rk_win_web_active=2",
		"@rk_win_code_root=/w",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("ops = %v, want %v", got, want)
	}
}

// TestWindowOptionOpsSkipsEmptyFamily: no layout, no tabs, no active pointer,
// no code root → no web-family ops at all (the skip-when-empty rule).
func TestWindowOptionOpsSkipsEmptyFamily(t *testing.T) {
	win := Window{Color: "2"}
	for _, op := range WindowOptionOps(win) {
		if strings.HasPrefix(op.Key, "@rk_win_web") || op.Key == "@rk_win_layout" || op.Key == "@rk_win_code_root" {
			t.Errorf("unexpected web-family op %v for an empty family", op)
		}
	}
}

// TestOldFormatSnapshotDecodes: a snapshot JSON written by an older binary
// (carrying window keys this struct no longer declares) decodes without error
// — the retired keys are ignored, no on-disk migration — and restores without
// web state.
func TestOldFormatSnapshotDecodesAndNormalizesMarker(t *testing.T) {
	old := `{
		"server": "kit",
		"takenAt": "2026-01-01T00:00:00Z",
		"sessions": [{
			"name": "alpha", "createdAt": 100,
			"windows": [{
				"index": 1, "id": "@1", "name": "serve",
				"rkType": "iframe", "rkUrl": "http://x", "marker": "solid",
				"panes": [{"id": "%0", "index": 0, "cwd": "/proj"}]
			}]
		}]
	}`
	var snap Snapshot
	if err := json.Unmarshal([]byte(old), &snap); err != nil {
		t.Fatalf("old-format decode: %v", err)
	}
	win := snap.Sessions[0].Windows[0]
	if len(win.WebTabs) != 0 || win.RkLayout != "" || win.WebActive != 0 {
		t.Errorf("old-format window gained web state: %+v", win)
	}

	f := &fakeRestore{bornIndex: 1}
	report, err := restore(context.Background(), "kit", &snap, f.ops())
	if err != nil {
		t.Fatalf("restore old-format snapshot: %v", err)
	}
	if len(report.Sessions) != 1 {
		t.Fatalf("report = %+v", report)
	}
	// The @run_* option names restore nothing, while the flat marker value is
	// normalized before it is written.
	for _, op := range []string{"@rk_win_url", "@rk_win_lens", "@rk_win_web_"} {
		if strings.Contains(f.trace(), op) {
			t.Errorf("restore wrote a retired/web-family option %q:\n%s", op, f.trace())
		}
	}
	if !strings.Contains(f.trace(), "@rk_win_marker=manual:1") {
		t.Errorf("normalized marker not restored:\n%s", f.trace())
	}
}

// TestRestoreNeverStampsRunRole: a snapshot that holds an operator-run window
// (captured by an earlier binary, or hand-built) restores it without the role,
// so no restored window can read as a run in flight.
func TestRestoreNeverStampsRunRole(t *testing.T) {
	snap := &Snapshot{
		Server: "kit",
		Sessions: []Session{{
			Name: tmux.OperatorSessionName, CreatedAt: 100,
			Windows: []Window{{Index: 0, ID: "@1", Name: "run-ab12", Role: tmux.RoleOperatorRun, Color: "2",
				Panes: []Pane{{ID: "%0", Index: 0, Cwd: "/p", Command: "sh"}}}},
		}},
	}
	f := &fakeRestore{}
	if _, err := restore(context.Background(), "kit", snap, f.ops()); err != nil {
		t.Fatalf("restore: %v\ntrace:\n%s", err, f.trace())
	}
	if strings.Contains(f.trace(), tmux.RoleOption) || strings.Contains(f.trace(), tmux.RoleOperatorRun) {
		t.Errorf("restore re-stamped the run role:\n%s", f.trace())
	}
	if !strings.Contains(f.trace(), "@rk_win_color=2") {
		t.Errorf("other window options were dropped:\n%s", f.trace())
	}
}
