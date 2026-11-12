package sessions

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"rk/internal/cron"
	"rk/internal/operator"
	"rk/internal/tmux"
)

// operatorstate_test.go — the rk-first / fab-fallback source selection. Every
// case runs against a t.TempDir() state home via XDG_STATE_HOME, never the
// real one.

const testSock = "/tmp/tmux-1001/runKit"

// writeOperatorFile writes body at path, creating parent directories.
func writeOperatorFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// stateFiles points the state home at a temp dir and returns the two candidate
// paths for testSock.
func stateFiles(t *testing.T) (rkPath, fabPath string) {
	t.Helper()
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	rk, err := operator.StatePath(testSock)
	if err != nil {
		t.Fatal(err)
	}
	fab, err := cron.FabOperatorStatePath(cron.FabOperatorSlug(testSock))
	if err != nil {
		t.Fatal(err)
	}
	return rk, fab
}

func itemIDs(state cron.OperatorState) []string {
	ids := []string{}
	for _, it := range state.Items {
		ids = append(ids, it.ID)
	}
	return ids
}

func TestResolveOperatorStatePath(t *testing.T) {
	const body = "tracked:\n  - {id: a, kind: task}\n"

	t.Run("rk file present wins over fab's", func(t *testing.T) {
		rk, fab := stateFiles(t)
		writeOperatorFile(t, rk, body)
		writeOperatorFile(t, fab, body)
		got, ok := resolveOperatorStatePath(testSock)
		if !ok || got != rk {
			t.Errorf("resolve = (%q, %v), want rk path %q", got, ok, rk)
		}
	})

	t.Run("rk absent falls back to fab's path, present or not", func(t *testing.T) {
		rk, fab := stateFiles(t)
		got, ok := resolveOperatorStatePath(testSock)
		if !ok || got != fab {
			t.Errorf("resolve with both absent = (%q, %v), want fab path %q", got, ok, fab)
		}
		writeOperatorFile(t, fab, body)
		got, _ = resolveOperatorStatePath(testSock)
		if got != fab {
			t.Errorf("resolve with only fab present = %q, want %q (rk %q absent)", got, fab, rk)
		}
	})

	t.Run("the rk candidate is operator.StatePath", func(t *testing.T) {
		rk, _ := stateFiles(t)
		writeOperatorFile(t, rk, "")
		for _, sock := range []string{testSock, ""} {
			want, err := operator.StatePath(sock)
			if err != nil {
				t.Fatal(err)
			}
			writeOperatorFile(t, want, "")
			got, ok := resolveOperatorStatePath(sock)
			if !ok || got != want {
				t.Errorf("resolve(%q) = (%q, %v), want %q", sock, got, ok, want)
			}
		}
	})
}

func TestReadOperatorStateSource(t *testing.T) {
	t.Run("rk present: only rk's file is read", func(t *testing.T) {
		rk, fab := stateFiles(t)
		writeOperatorFile(t, rk, "tracked:\n  - {id: from-rk, kind: pane}\n")
		writeOperatorFile(t, fab, "tracked:\n  - {id: from-fab, kind: fab-change}\n")
		state, present := ReadOperatorState(testSock)
		if !present || !reflect.DeepEqual(itemIDs(state), []string{"from-rk"}) {
			t.Errorf("state = %+v present=%v, want only the rk item", state, present)
		}
	})

	t.Run("rk absent: fab's file is read", func(t *testing.T) {
		_, fab := stateFiles(t)
		writeOperatorFile(t, fab, "last_tick_at: 1700000000\ntracked:\n  - {id: from-fab, kind: fab-change}\n")
		state, present := ReadOperatorState(testSock)
		if !present || !reflect.DeepEqual(itemIDs(state), []string{"from-fab"}) || state.LastTickAt != 1700000000 {
			t.Errorf("state = %+v present=%v, want the fab item and its tick", state, present)
		}
	})

	t.Run("both absent: not present", func(t *testing.T) {
		stateFiles(t)
		if _, present := ReadOperatorState(testSock); present {
			t.Error("present = true with no file at either path")
		}
	})

	t.Run("rk present but empty: present with no items, never fab's list", func(t *testing.T) {
		rk, fab := stateFiles(t)
		writeOperatorFile(t, fab, "tracked:\n  - {id: from-fab, kind: fab-change}\n")
		for _, body := range []string{"", "tracked: []\n"} {
			writeOperatorFile(t, rk, body)
			state, present := ReadOperatorState(testSock)
			if !present || len(state.Items) != 0 {
				t.Errorf("body %q: state = %+v present=%v, want present and empty", body, state, present)
			}
		}
	})

	t.Run("rk corrupt: not present, no fall back to fab's list", func(t *testing.T) {
		rk, fab := stateFiles(t)
		writeOperatorFile(t, rk, "tracked: [unterminated\n  - {")
		writeOperatorFile(t, fab, "tracked:\n  - {id: from-fab, kind: fab-change}\n")
		if state, present := ReadOperatorState(testSock); present {
			t.Errorf("state = %+v present=true, want a corrupt rk file to degrade to absent", state)
		}
	})

	t.Run("the read never creates a file", func(t *testing.T) {
		rk, fab := stateFiles(t)
		ReadOperatorState(testSock)
		for _, p := range []string{rk, fab} {
			if _, err := os.Stat(p); !os.IsNotExist(err) {
				t.Errorf("%s exists after a read (stat err %v)", p, err)
			}
		}
	})
}

func TestReadOperatorStateForServerSocketFallback(t *testing.T) {
	orig := socketPathFn
	t.Cleanup(func() { socketPathFn = orig })
	socketPathFn = func(context.Context, string) (string, error) { return "", fmt.Errorf("no server running") }
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	rk, err := operator.StatePath("")
	if err != nil {
		t.Fatal(err)
	}
	writeOperatorFile(t, rk, "tracked:\n  - {id: dflt, kind: pane}\n")

	state, present := ReadOperatorStateForServer(context.Background(), "ghost")
	if !present || !reflect.DeepEqual(itemIDs(state), []string{"dflt"}) {
		t.Errorf("state = %+v present=%v, want the default-slug rk file", state, present)
	}
}

// TestFetchSessionsOperatorSource pins the FetchSessions wiring of the source
// rule: rk's file feeds operatorTracked, the pane join and the tick facts
// alone, and a corrupt rk file leaves all three empty.
func TestFetchSessionsOperatorSource(t *testing.T) {
	const paneID = "%7"
	origSessions, origClients, origWindows, origSocket := listSessionsFn, listClientsFn, listWindowsFn, socketPathFn
	t.Cleanup(func() {
		listSessionsFn, listClientsFn, listWindowsFn, socketPathFn = origSessions, origClients, origWindows, origSocket
	})
	listSessionsFn = func(context.Context, string) ([]tmux.SessionInfo, error) {
		return []tmux.SessionInfo{{Name: "main", Windows: 1}}, nil
	}
	listClientsFn = func(context.Context, string) ([]tmux.ClientInfo, error) { return nil, nil }
	listWindowsFn = func(_ context.Context, session, _ string) ([]tmux.WindowInfo, error) {
		return []tmux.WindowInfo{{Index: 0, WindowID: "@1", Name: session, Panes: []tmux.PaneInfo{{PaneID: paneID, IsActive: true}}}}, nil
	}
	socketPathFn = func(context.Context, string) (string, error) { return testSock, nil }

	fetch := func(t *testing.T) ProjectSession {
		t.Helper()
		got, err := FetchSessions(context.Background(), "runKit", nil, nil)
		if err != nil || len(got) != 1 {
			t.Fatalf("FetchSessions() = %+v, %v", got, err)
		}
		return got[0]
	}
	rkBody := fmt.Sprintf("last_tick_at: 1700000000\ntracked:\n  - id: x\n    kind: pane\n    scope: {pane: %q, repo: /r}\n    done_at: null\n    notes:\n      - {at: 1700000100, by: user, text: one}\n      - {at: 1700000200, by: run, text: two}\n", paneID)

	t.Run("rk file feeds the payload, join and tick; fab's is ignored", func(t *testing.T) {
		rk, fab := stateFiles(t)
		writeOperatorFile(t, rk, rkBody)
		writeOperatorFile(t, fab, "last_tick_at: 5\ntracked:\n  - {id: from-fab, kind: fab-change}\n")
		s := fetch(t)
		if s.OperatorTracked == nil || len(*s.OperatorTracked) != 1 {
			t.Fatalf("OperatorTracked = %+v, want the single rk item", s.OperatorTracked)
		}
		got := (*s.OperatorTracked)[0]
		want := OperatorTrackedItem{
			ID: "x", Kind: "pane", Pane: paneID, WindowID: "@1", Repo: "/r",
			LatestNote: &OperatorNote{At: 1700000200, By: "run", Text: "two"}, NoteCount: 2,
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("item = %+v, want %+v", got, want)
		}
		if w := s.Windows[0]; !w.Monitored || w.MonitoredChange != "x" {
			t.Errorf("window = %+v, want monitored via the rk item", w)
		}
		if s.OperatorLastTickAt != 1700000000 {
			t.Errorf("OperatorLastTickAt = %d, want rk's 1700000000", s.OperatorLastTickAt)
		}
	})

	t.Run("an empty rk file yields a present empty list, not fab's", func(t *testing.T) {
		rk, fab := stateFiles(t)
		writeOperatorFile(t, rk, "")
		writeOperatorFile(t, fab, "tracked:\n  - {id: from-fab, kind: fab-change}\n")
		s := fetch(t)
		if s.OperatorTracked == nil || len(*s.OperatorTracked) != 0 {
			t.Errorf("OperatorTracked = %+v, want a present empty list", s.OperatorTracked)
		}
	})

	t.Run("a corrupt rk file omits the list and joins nothing", func(t *testing.T) {
		rk, fab := stateFiles(t)
		writeOperatorFile(t, rk, "tracked: [unterminated\n  - {")
		writeOperatorFile(t, fab, fmt.Sprintf("last_tick_at: 5\ntracked:\n  - {id: from-fab, kind: fab-change, scope: {pane: %q}}\n", paneID))
		s := fetch(t)
		if s.OperatorTracked != nil || s.Windows[0].Monitored || s.OperatorLastTickAt != 0 {
			t.Errorf("session = %+v, want no tracked list, join or tick", s)
		}
	})

	t.Run("no rk file: fab's file is read as before", func(t *testing.T) {
		_, fab := stateFiles(t)
		writeOperatorFile(t, fab, fmt.Sprintf("tracked:\n  - {id: from-fab, kind: fab-change, scope: {pane: %q}}\n", paneID))
		s := fetch(t)
		if w := s.Windows[0]; !w.Monitored || w.MonitoredChange != "from-fab" {
			t.Errorf("window = %+v, want monitored via fab's item", w)
		}
	})
}
