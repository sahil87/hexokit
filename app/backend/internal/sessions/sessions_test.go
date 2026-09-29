package sessions

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"rk/internal/cron"
	"rk/internal/tmux"
)

func TestProjectRootDerivation(t *testing.T) {
	tests := []struct {
		name     string
		windows  []tmux.WindowInfo
		wantRoot string
	}{
		{
			name: "project root from first window",
			windows: []tmux.WindowInfo{
				{Index: 0, Name: "main", WorktreePath: "/home/user/project"},
				{Index: 1, Name: "build", WorktreePath: "/tmp/build"},
			},
			wantRoot: "/home/user/project",
		},
		{
			name:     "empty windows returns empty root",
			windows:  []tmux.WindowInfo{},
			wantRoot: "",
		},
		{
			name: "single window",
			windows: []tmux.WindowInfo{
				{Index: 0, Name: "dev", WorktreePath: "/home/user/code"},
			},
			wantRoot: "/home/user/code",
		},
		{
			name: "first window has empty path",
			windows: []tmux.WindowInfo{
				{Index: 0, Name: "main", WorktreePath: ""},
				{Index: 1, Name: "sub", WorktreePath: "/home/user/other"},
			},
			wantRoot: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			projectRoot := ""
			if len(tt.windows) > 0 {
				projectRoot = tt.windows[0].WorktreePath
			}
			if projectRoot != tt.wantRoot {
				t.Errorf("projectRoot = %q, want %q", projectRoot, tt.wantRoot)
			}
		})
	}
}

func TestProjectSessionStruct(t *testing.T) {
	ps := ProjectSession{
		Name: "my-project",
		Windows: []tmux.WindowInfo{
			{Index: 0, Name: "main", WorktreePath: "/home/user/project", Activity: "active", IsActiveWindow: true},
			{Index: 1, Name: "build", WorktreePath: "/tmp/build", Activity: "idle", IsActiveWindow: false},
		},
	}

	if ps.Name != "my-project" {
		t.Errorf("Name = %q, want %q", ps.Name, "my-project")
	}
	if len(ps.Windows) != 2 {
		t.Fatalf("Windows count = %d, want 2", len(ps.Windows))
	}
	if ps.Windows[0].IsActiveWindow != true {
		t.Error("Windows[0].IsActiveWindow should be true")
	}
	if ps.Windows[1].IsActiveWindow != false {
		t.Error("Windows[1].IsActiveWindow should be false")
	}
}

func TestProjectSessionNameFieldJSON(t *testing.T) {
	ps := ProjectSession{Name: "test"}
	data, err := json.Marshal(ps)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	var decoded ProjectSession
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}
	if decoded.Name != "test" {
		t.Errorf("round-trip Name = %q, want %q", decoded.Name, "test")
	}
}

func TestProjectSessionIDPathJSON(t *testing.T) {
	// sessionId/sessionPath ride the same ProjectSession marshal that serves
	// GET /api/sessions and the SSE sessions event.
	ps := ProjectSession{Name: "test", SessionID: "$4", SessionPath: "/home/user/code/x"}
	data, err := json.Marshal(ps)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}
	if raw["sessionId"] != "$4" {
		t.Errorf("sessionId = %v, want %q", raw["sessionId"], "$4")
	}
	if raw["sessionPath"] != "/home/user/code/x" {
		t.Errorf("sessionPath = %v, want %q", raw["sessionPath"], "/home/user/code/x")
	}

	// Empty values omit the keys (additive optional-field idiom).
	bare, err := json.Marshal(ProjectSession{Name: "test"})
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	var rawBare map[string]any
	if err := json.Unmarshal(bare, &rawBare); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}
	if _, ok := rawBare["sessionId"]; ok {
		t.Error("sessionId present on empty SessionID, want omitted")
	}
	if _, ok := rawBare["sessionPath"]; ok {
		t.Error("sessionPath present on empty SessionPath, want omitted")
	}
}

// TestWindowBranchRepo covers the branch/repo selection that feeds the
// PR-from-branch derivation (260705-dmex): the active pane's branch wins, else
// the first pane with a branch; no branch → ("", "").
func TestWindowBranchRepo(t *testing.T) {
	t.Run("active pane with a branch wins", func(t *testing.T) {
		w := tmux.WindowInfo{Panes: []tmux.PaneInfo{
			{Cwd: "/repo/a", GitBranch: "feat-a", IsActive: false},
			{Cwd: "/repo/b", GitBranch: "feat-b", IsActive: true},
		}}
		repo, branch := windowBranchRepo(&w)
		if repo != "/repo/b" || branch != "feat-b" {
			t.Errorf("got (%q, %q), want (/repo/b, feat-b)", repo, branch)
		}
	})

	t.Run("falls back to first pane with a branch when active has none", func(t *testing.T) {
		w := tmux.WindowInfo{Panes: []tmux.PaneInfo{
			{Cwd: "/repo/a", GitBranch: "", IsActive: true},
			{Cwd: "/repo/b", GitBranch: "feat-b", IsActive: false},
		}}
		repo, branch := windowBranchRepo(&w)
		if repo != "/repo/b" || branch != "feat-b" {
			t.Errorf("got (%q, %q), want (/repo/b, feat-b)", repo, branch)
		}
	})

	t.Run("no pane has a branch yields empty", func(t *testing.T) {
		w := tmux.WindowInfo{Panes: []tmux.PaneInfo{
			{Cwd: "/repo/a", GitBranch: "", IsActive: true},
			{Cwd: "/repo/b", GitBranch: ""},
		}}
		repo, branch := windowBranchRepo(&w)
		if repo != "" || branch != "" {
			t.Errorf("got (%q, %q), want empty", repo, branch)
		}
	})
}

func TestResolveCwdMissing(t *testing.T) {
	existing := t.TempDir()
	gone := filepath.Join(existing, "deleted-worktree")
	// `gone` is never created, so it is guaranteed not to exist.

	got := resolveCwdMissing([]string{existing, gone, ""})

	if _, ok := got[existing]; ok {
		t.Errorf("existing dir %q should not be flagged missing", existing)
	}
	if !got[gone] {
		t.Errorf("nonexistent dir %q should be flagged missing", gone)
	}
	if _, ok := got[""]; ok {
		t.Errorf("empty cwd should be skipped, not flagged")
	}
}

func TestFormatAgentDuration(t *testing.T) {
	cases := []struct {
		elapsed int64
		want    string
	}{
		{-5, ""},
		{0, ""},
		{45, "45s"},
		{59, "59s"},
		{60, "1m"},
		{130, "2m"},
		{3599, "59m"},
		{3600, "1h"},
		{7300, "2h"},
	}
	for _, c := range cases {
		if got := FormatAgentDuration(c.elapsed); got != c.want {
			t.Errorf("FormatAgentDuration(%d) = %q, want %q", c.elapsed, got, c.want)
		}
	}
}

func TestRollupAgentState(t *testing.T) {
	const now int64 = 1_000_000

	t.Run("waiting wins over active", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{AgentState: tmux.AgentStateActive, AgentStateEpoch: now - 10},
			{AgentState: tmux.AgentStateWaiting, AgentStateEpoch: now - 130},
		}
		state, dur := rollupAgentState(panes, now)
		if state != tmux.AgentStateWaiting {
			t.Errorf("state = %q, want waiting", state)
		}
		if dur != "2m" {
			t.Errorf("waiting duration = %q, want 2m", dur)
		}
	})

	t.Run("active wins over idle", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{AgentState: tmux.AgentStateIdle, AgentStateEpoch: now - 300},
			{AgentState: tmux.AgentStateActive, AgentStateEpoch: now - 5},
		}
		state, dur := rollupAgentState(panes, now)
		if state != tmux.AgentStateActive {
			t.Errorf("state = %q, want active", state)
		}
		if dur != "5s" {
			t.Errorf("active duration = %q, want 5s (active carries a duration like any known state)", dur)
		}
	})

	t.Run("aged active duration formatted from epoch", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{AgentState: tmux.AgentStateActive, AgentStateEpoch: now - 720},
		}
		state, dur := rollupAgentState(panes, now)
		if state != tmux.AgentStateActive || dur != "12m" {
			t.Errorf("got (%q, %q), want (active, 12m)", state, dur)
		}
	})

	t.Run("idle duration formatted from epoch", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{AgentState: tmux.AgentStateIdle, AgentStateEpoch: now - 130},
		}
		state, dur := rollupAgentState(panes, now)
		if state != tmux.AgentStateIdle || dur != "2m" {
			t.Errorf("got (%q, %q), want (idle, 2m)", state, dur)
		}
	})

	t.Run("no agent panes yields empty", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{AgentState: "", AgentStateEpoch: 0},
			{Command: "zsh"},
		}
		state, dur := rollupAgentState(panes, now)
		if state != "" || dur != "" {
			t.Errorf("got (%q, %q), want empty", state, dur)
		}
	})

	t.Run("idle with zero epoch has no duration", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{AgentState: tmux.AgentStateIdle, AgentStateEpoch: 0},
		}
		state, dur := rollupAgentState(panes, now)
		if state != tmux.AgentStateIdle || dur != "" {
			t.Errorf("got (%q, %q), want (idle, empty)", state, dur)
		}
	})

	t.Run("tie-break prefers newest epoch at same precedence", func(t *testing.T) {
		// Two waiting panes: the older one is listed first. The rollup must
		// pick the newest epoch so the duration reflects the most-recently-
		// updated pane, not the arbitrary first one (which would inflate it).
		panes := []tmux.PaneInfo{
			{AgentState: tmux.AgentStateWaiting, AgentStateEpoch: now - 600},
			{AgentState: tmux.AgentStateWaiting, AgentStateEpoch: now - 60},
		}
		state, dur := rollupAgentState(panes, now)
		if state != tmux.AgentStateWaiting {
			t.Errorf("state = %q, want waiting", state)
		}
		if dur != "1m" {
			t.Errorf("tie-break duration = %q, want 1m (newest epoch), not 10m", dur)
		}
	})

	t.Run("tie-break is order-independent", func(t *testing.T) {
		// Same two panes with the newest listed first — result must be identical.
		panes := []tmux.PaneInfo{
			{AgentState: tmux.AgentStateWaiting, AgentStateEpoch: now - 60},
			{AgentState: tmux.AgentStateWaiting, AgentStateEpoch: now - 600},
		}
		state, dur := rollupAgentState(panes, now)
		if state != tmux.AgentStateWaiting || dur != "1m" {
			t.Errorf("got (%q, %q), want (waiting, 1m)", state, dur)
		}
	})
}

// TestDeriveGitRoot covers the code-lens availability derivation (260811-k3vp):
// the window's git toplevel from its active pane's cwd, with the
// first-pane-cwd → worktree-path fallbacks and the non-repo cwd fallback.
func TestDeriveGitRoot(t *testing.T) {
	// A temp "repo" (a dir containing .git is enough for FindGitRoot) with a
	// nested subdir, plus a plain non-repo dir.
	repo := t.TempDir()
	if err := os.Mkdir(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(repo, "app", "backend")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	plain := t.TempDir()

	t.Run("active pane cwd inside a repo resolves to the toplevel", func(t *testing.T) {
		w := &tmux.WindowInfo{
			Panes: []tmux.PaneInfo{
				{Cwd: plain},
				{IsActive: true, Cwd: sub},
			},
		}
		if got := deriveGitRoot(w); got != repo {
			t.Errorf("got %q, want %q", got, repo)
		}
	})

	t.Run("falls back to the first pane's cwd when the active pane's is empty", func(t *testing.T) {
		w := &tmux.WindowInfo{
			Panes: []tmux.PaneInfo{
				{Cwd: sub},
				{IsActive: true, Cwd: ""}, // active, but blank — must not clobber the seed
			},
		}
		if got := deriveGitRoot(w); got != repo {
			t.Errorf("got %q, want %q", got, repo)
		}
	})

	t.Run("falls back to the worktree path when there are no panes", func(t *testing.T) {
		w := &tmux.WindowInfo{WorktreePath: sub}
		if got := deriveGitRoot(w); got != repo {
			t.Errorf("got %q, want %q", got, repo)
		}
	})

	t.Run("non-repo cwd falls back to the cwd itself", func(t *testing.T) {
		w := &tmux.WindowInfo{
			Panes: []tmux.PaneInfo{{IsActive: true, Cwd: plain}},
		}
		if got := deriveGitRoot(w); got != plain {
			t.Errorf("got %q, want %q (cwd fallback for a non-repo cwd)", got, plain)
		}
	})

	t.Run("no cwd derivable yields empty", func(t *testing.T) {
		w := &tmux.WindowInfo{}
		if got := deriveGitRoot(w); got != "" {
			t.Errorf("got %q, want empty", got)
		}
	})
}

func TestRollupAgentSession(t *testing.T) {
	t.Run("active pane wins", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{AgentProvider: "claude", AgentSessionRef: "inactive-ref"},
			{IsActive: true, AgentProvider: "claude", AgentSessionRef: "active-ref"},
		}
		provider, ref := rollupAgentSession(panes)
		if provider != "claude" || ref != "active-ref" {
			t.Errorf("got (%q, %q), want (claude, active-ref)", provider, ref)
		}
	})

	t.Run("falls back to first pane carrying an agent session when active pane has none", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{IsActive: true}, // active pane has no agent session
			{AgentProvider: "claude", AgentSessionRef: "first-set"},
			{AgentProvider: "codex", AgentSessionRef: "later"},
		}
		provider, ref := rollupAgentSession(panes)
		if provider != "claude" || ref != "first-set" {
			t.Errorf("got (%q, %q), want (claude, first-set)", provider, ref)
		}
	})

	t.Run("no agent session on any pane yields empty", func(t *testing.T) {
		panes := []tmux.PaneInfo{{IsActive: true}, {Command: "zsh"}}
		provider, ref := rollupAgentSession(panes)
		if provider != "" || ref != "" {
			t.Errorf("got (%q, %q), want empty", provider, ref)
		}
	})

	t.Run("single agent pane (the common case)", func(t *testing.T) {
		panes := []tmux.PaneInfo{{IsActive: true, AgentProvider: "claude", AgentSessionRef: "solo"}}
		provider, ref := rollupAgentSession(panes)
		if provider != "claude" || ref != "solo" {
			t.Errorf("got (%q, %q), want (claude, solo)", provider, ref)
		}
	})
}

func TestRollupAltScreen(t *testing.T) {
	t.Run("active pane alt-screen yields true", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{AltScreen: false},
			{IsActive: true, AltScreen: true},
		}
		if !rollupAltScreen(panes) {
			t.Error("got false, want true")
		}
	})

	t.Run("non-active alt-screen pane alone yields false", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{IsActive: true, AltScreen: false},
			{AltScreen: true},
		}
		if rollupAltScreen(panes) {
			t.Error("got true, want false")
		}
	})

	t.Run("zero panes yields false", func(t *testing.T) {
		if rollupAltScreen(nil) {
			t.Error("got true, want false")
		}
	})
}

// TestResolveAgentPane covers the paneID surfaced alongside provider/ref — the
// agent-send injection target (a window target may route to the wrong pane in a
// split). The active-pane-first / else-first-agent-pane rule is shared with
// rollupAgentSession via delegation.
func TestResolveAgentPane(t *testing.T) {
	t.Run("active agent pane wins and its paneID is returned", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{PaneID: "%1", AgentProvider: "claude", AgentSessionRef: "inactive-ref"},
			{PaneID: "%2", IsActive: true, AgentProvider: "claude", AgentSessionRef: "active-ref"},
		}
		provider, ref, paneID := ResolveAgentPane(panes)
		if provider != "claude" || ref != "active-ref" || paneID != "%2" {
			t.Errorf("got (%q, %q, %q), want (claude, active-ref, %%2)", provider, ref, paneID)
		}
	})

	t.Run("active pane has no agent session — first agent pane's id is returned", func(t *testing.T) {
		panes := []tmux.PaneInfo{
			{PaneID: "%0", IsActive: true}, // active pane has no agent session
			{PaneID: "%1", AgentProvider: "claude", AgentSessionRef: "first-set"},
			{PaneID: "%2", AgentProvider: "codex", AgentSessionRef: "later"},
		}
		provider, ref, paneID := ResolveAgentPane(panes)
		if provider != "claude" || ref != "first-set" || paneID != "%1" {
			t.Errorf("got (%q, %q, %q), want (claude, first-set, %%1)", provider, ref, paneID)
		}
	})

	t.Run("no agent session on any pane yields empty paneID", func(t *testing.T) {
		panes := []tmux.PaneInfo{{PaneID: "%0", IsActive: true}, {PaneID: "%1", Command: "zsh"}}
		provider, ref, paneID := ResolveAgentPane(panes)
		if provider != "" || ref != "" || paneID != "" {
			t.Errorf("got (%q, %q, %q), want all empty", provider, ref, paneID)
		}
	})
}

// TestOperatorSessionHidden pins the content-conditional hidden rule: the
// operator session is hidden only while it holds ≥1 window AND every window
// carries role == "operator"; a mixed/stray population (any non-operator
// window, or any other session name) yields false so no window can ever become
// invisible.
func TestOperatorSessionHidden(t *testing.T) {
	op := tmux.WindowInfo{WindowID: "@1", Role: "operator"}
	plain := tmux.WindowInfo{WindowID: "@2"}
	tests := []struct {
		name    string
		session string
		windows []tmux.WindowInfo
		want    bool
	}{
		{"all-operator single window is hidden", tmux.OperatorSessionName, []tmux.WindowInfo{op}, true},
		{"all-operator multi window is hidden", tmux.OperatorSessionName, []tmux.WindowInfo{op, {WindowID: "@3", Role: "operator"}}, true},
		{"mixed population is visible", tmux.OperatorSessionName, []tmux.WindowInfo{op, plain}, false},
		{"lone non-operator window is visible", tmux.OperatorSessionName, []tmux.WindowInfo{plain}, false},
		{"empty operator session is not hidden", tmux.OperatorSessionName, nil, false},
		{"a non-operator session is never hidden", "work", []tmux.WindowInfo{op}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := operatorSessionHidden(tt.session, tt.windows); got != tt.want {
				t.Errorf("operatorSessionHidden(%q, %d windows) = %v, want %v", tt.session, len(tt.windows), got, tt.want)
			}
		})
	}
}

// TestProjectSessionHiddenJSON pins the wire shape: hidden is omitempty —
// present as true only on a hidden operator session, absent otherwise.
func TestProjectSessionHiddenJSON(t *testing.T) {
	hidden := ProjectSession{Name: tmux.OperatorSessionName, Hidden: true, Windows: []tmux.WindowInfo{}}
	b, err := json.Marshal(hidden)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"hidden":true`) {
		t.Errorf("hidden session JSON = %s, want hidden:true present", b)
	}
	visible := ProjectSession{Name: "work", Windows: []tmux.WindowInfo{}}
	b2, err := json.Marshal(visible)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b2), "hidden") {
		t.Errorf("visible session JSON = %s, want hidden omitted", b2)
	}
}

func TestWindowPRKey(t *testing.T) {
	repo := t.TempDir()
	if err := os.Mkdir(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(repo, "app", "backend")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	plain := t.TempDir()

	t.Run("subdirectory cwd keys on the git root", func(t *testing.T) {
		w := tmux.WindowInfo{Panes: []tmux.PaneInfo{
			{Cwd: sub, GitBranch: "feat-x", IsActive: true},
		}}
		repoDir, branch := windowPRKey(&w)
		if repoDir != repo || branch != "feat-x" {
			t.Errorf("got (%q, %q), want (%q, feat-x)", repoDir, branch, repo)
		}
	})

	t.Run("root follows the branch-supplying pane, not the active pane", func(t *testing.T) {
		w := tmux.WindowInfo{Panes: []tmux.PaneInfo{
			{Cwd: plain, GitBranch: "", IsActive: true},
			{Cwd: sub, GitBranch: "feat-x"},
		}}
		repoDir, branch := windowPRKey(&w)
		if repoDir != repo || branch != "feat-x" {
			t.Errorf("got (%q, %q), want (%q, feat-x)", repoDir, branch, repo)
		}
	})

	t.Run("non-repo cwd falls back to the raw cwd", func(t *testing.T) {
		w := tmux.WindowInfo{Panes: []tmux.PaneInfo{
			{Cwd: plain, GitBranch: "feat-x", IsActive: true},
		}}
		repoDir, branch := windowPRKey(&w)
		if repoDir != plain || branch != "feat-x" {
			t.Errorf("got (%q, %q), want (%q, feat-x)", repoDir, branch, plain)
		}
	})

	t.Run("no branch yields empty pair", func(t *testing.T) {
		w := tmux.WindowInfo{Panes: []tmux.PaneInfo{{Cwd: sub, IsActive: true}}}
		repoDir, branch := windowPRKey(&w)
		if repoDir != "" || branch != "" {
			t.Errorf("got (%q, %q), want empty", repoDir, branch)
		}
	})
}

// TestFoldViewers pins the viewer join: per-session bucketing by group key —
// a client attached via a derived group copy (devshell-82) counts against the
// leader row parseSessions keeps (devshell), ungrouped clients bucket by their
// own session name, and a client attached to a session outside the payload
// (e.g. a pin-session) simply lands on a key no ProjectSession reads. It also
// pins the identity join: a resolver hit yields kind "rk" with the relay's
// device/peer and the LastInbound closure's value; a miss, a nil resolver,
// and PID 0 all stay "tty" with tmux's own times.
func TestFoldViewers(t *testing.T) {
	rkResolver := func(pid int) (AttachMeta, bool) {
		if pid == 4242 {
			return AttachMeta{
				Peer:        "100.64.0.12",
				Device:      "phone",
				ConnectedAt: time.Unix(1757500000, 0),
				LastInbound: func() int64 { return 1757500310 },
			}, true
		}
		return AttachMeta{}, false
	}
	tests := []struct {
		name    string
		clients []tmux.ClientInfo
		resolve AttachResolver
		want    map[string][]Viewer
	}{
		{
			name:    "no clients yields nil",
			clients: nil,
			want:    nil,
		},
		{
			name: "ungrouped clients bucket by session name",
			clients: []tmux.ClientInfo{
				{Width: 144, Height: 91, SessionName: "runKit"},
				{Width: 116, Height: 37, SessionName: "runKit"},
			},
			want: map[string][]Viewer{
				"runKit": {{Width: 144, Height: 91, Kind: "tty"}, {Width: 116, Height: 37, Kind: "tty"}},
			},
		},
		{
			name: "group-copy attach counts against the leader",
			clients: []tmux.ClientInfo{
				{Width: 144, Height: 91, SessionName: "devshell", SessionGroup: "devshell", SessionGroupList: "devshell,devshell-82"},
				{Width: 116, Height: 37, SessionName: "devshell-82", SessionGroup: "devshell", SessionGroupList: "devshell,devshell-82"},
			},
			want: map[string][]Viewer{
				"devshell": {{Width: 144, Height: 91, Kind: "tty"}, {Width: 116, Height: 37, Kind: "tty"}},
			},
		},
		{
			// tmux 3.6a's opaque numeric #{session_group} id must still join
			// via the member-name list.
			name: "numeric group id joins via the member-name list",
			clients: []tmux.ClientInfo{
				{Width: 116, Height: 37, SessionName: "devshell-82", SessionGroup: "0", SessionGroupList: "devshell,devshell-82"},
			},
			want: map[string][]Viewer{
				"devshell": {{Width: 116, Height: 37, Kind: "tty"}},
			},
		},
		{
			name: "sessions stay separate",
			clients: []tmux.ClientInfo{
				{Width: 144, Height: 91, SessionName: "alpha"},
				{Width: 116, Height: 37, SessionName: "beta"},
			},
			want: map[string][]Viewer{
				"alpha": {{Width: 144, Height: 91, Kind: "tty"}},
				"beta":  {{Width: 116, Height: 37, Kind: "tty"}},
			},
		},
		{
			name: "resolver hit yields rk with the meta and the closure's lastInbound",
			clients: []tmux.ClientInfo{
				{Width: 116, Height: 37, SessionName: "runKit", PID: 4242, Created: time.Unix(1757500000, 0), Activity: time.Unix(1757500300, 0)},
				{Width: 144, Height: 91, SessionName: "runKit", PID: 5151, Created: time.Unix(1757490000, 0), Activity: time.Unix(1757500003, 0)},
			},
			resolve: rkResolver,
			want: map[string][]Viewer{
				"runKit": {
					{Width: 116, Height: 37, Kind: "rk", PID: 4242, Device: "phone", Peer: "100.64.0.12", CreatedAt: 1757500000, LastActiveAt: 1757500310},
					{Width: 144, Height: 91, Kind: "tty", PID: 5151, CreatedAt: 1757490000, LastActiveAt: 1757500003},
				},
			},
		},
		{
			name: "nil resolver leaves every viewer tty",
			clients: []tmux.ClientInfo{
				{Width: 116, Height: 37, SessionName: "runKit", PID: 4242, Created: time.Unix(1757500000, 0), Activity: time.Unix(1757500300, 0)},
			},
			want: map[string][]Viewer{
				"runKit": {{Width: 116, Height: 37, Kind: "tty", PID: 4242, CreatedAt: 1757500000, LastActiveAt: 1757500300}},
			},
		},
		{
			name: "PID 0 stays tty even when the resolver would match 0",
			clients: []tmux.ClientInfo{
				{Width: 116, Height: 37, SessionName: "runKit"},
			},
			resolve: func(pid int) (AttachMeta, bool) {
				return AttachMeta{Device: "phone"}, pid == 0
			},
			want: map[string][]Viewer{
				"runKit": {{Width: 116, Height: 37, Kind: "tty"}},
			},
		},
		{
			name: "nil LastInbound closure falls back to client_activity",
			clients: []tmux.ClientInfo{
				{Width: 116, Height: 37, SessionName: "runKit", PID: 4242, Activity: time.Unix(1757500300, 0)},
			},
			resolve: func(pid int) (AttachMeta, bool) {
				return AttachMeta{Device: "desktop"}, true
			},
			want: map[string][]Viewer{
				"runKit": {{Width: 116, Height: 37, Kind: "rk", PID: 4242, Device: "desktop", LastActiveAt: 1757500300}},
			},
		},
		{
			name: "zero LastInbound value falls back to client_activity",
			clients: []tmux.ClientInfo{
				{Width: 116, Height: 37, SessionName: "runKit", PID: 4242, Activity: time.Unix(1757500300, 0)},
			},
			resolve: func(pid int) (AttachMeta, bool) {
				return AttachMeta{Device: "desktop", LastInbound: func() int64 { return 0 }}, true
			},
			want: map[string][]Viewer{
				"runKit": {{Width: 116, Height: 37, Kind: "rk", PID: 4242, Device: "desktop", LastActiveAt: 1757500300}},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := foldViewers(tt.clients, tt.resolve)
			if len(got) != len(tt.want) {
				t.Fatalf("foldViewers() = %v, want %v", got, tt.want)
			}
			for key, wantViewers := range tt.want {
				gotViewers, ok := got[key]
				if !ok {
					t.Fatalf("foldViewers() missing key %q: %v", key, got)
				}
				if len(gotViewers) != len(wantViewers) {
					t.Fatalf("foldViewers()[%q] = %v, want %v", key, gotViewers, wantViewers)
				}
				for i := range wantViewers {
					if gotViewers[i] != wantViewers[i] {
						t.Errorf("foldViewers()[%q][%d] = %+v, want %+v", key, i, gotViewers[i], wantViewers[i])
					}
				}
			}
		})
	}
}

// TestProjectSessionViewersJSON pins the payload contract: viewers ride the
// ProjectSession marshal, the identity fields are additive omitempty (a
// zero-valued viewer marshals exactly {width,height}), an rk viewer emits all
// six keys, and a zero-viewer session omits the key entirely (the sidebar
// treats absent as "no indicator").
func TestProjectSessionViewersJSON(t *testing.T) {
	withViewers, err := json.Marshal(ProjectSession{
		Name:    "devshell",
		Windows: []tmux.WindowInfo{},
		Viewers: []Viewer{{Width: 144, Height: 91}, {Width: 116, Height: 37}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(withViewers), `"viewers":[{"width":144,"height":91},{"width":116,"height":37}]`) {
		t.Errorf("JSON missing viewers payload: %s", withViewers)
	}

	rkViewer, err := json.Marshal(Viewer{
		Width: 116, Height: 37, Kind: "rk", PID: 4242, Device: "phone", Peer: "100.64.0.12",
		CreatedAt: 1757500000, LastActiveAt: 1757500310,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantRK := `{"width":116,"height":37,"kind":"rk","pid":4242,"device":"phone","peer":"100.64.0.12","createdAt":1757500000,"lastActiveAt":1757500310}`
	if string(rkViewer) != wantRK {
		t.Errorf("rk viewer JSON = %s, want %s", rkViewer, wantRK)
	}

	without, err := json.Marshal(ProjectSession{Name: "solo", Windows: []tmux.WindowInfo{}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(without), `"viewers"`) {
		t.Errorf("zero-viewer session JSON must omit viewers: %s", without)
	}
}

// TestJoinWatchlist is the pane-ID join truth table (R7): a window whose pane
// matches a watchlist entry's pane carries Monitored plus the entry's fields;
// non-matching windows stay at zero values.
func TestJoinWatchlist(t *testing.T) {
	byPane := map[string]cron.WatchlistEntry{
		"%23": {ChangeID: "gmcp", Pane: "%23", Repo: "/r", Session: "s1", Stage: "active", Agent: "active", Branch: "feat/gmcp"},
	}
	windows := []tmux.WindowInfo{
		{Name: "hit", Panes: []tmux.PaneInfo{{PaneID: "%22"}, {PaneID: "%23"}}},
		{Name: "miss", Panes: []tmux.PaneInfo{{PaneID: "%24"}}},
		{Name: "no-panes"},
	}
	joinWatchlist(windows, byPane)

	hit := windows[0]
	if !hit.Monitored || hit.MonitoredChange != "gmcp" || hit.MonitoredStage != "active" ||
		hit.MonitoredRepo != "/r" || hit.MonitoredBranch != "feat/gmcp" || hit.MonitoredAgent != "active" {
		t.Errorf("hit window = %+v, want Monitored with the gmcp entry's fields", hit)
	}
	for _, w := range windows[1:] {
		if w.Monitored || w.MonitoredChange != "" || w.MonitoredStage != "" {
			t.Errorf("window %q = %+v, want zero values", w.Name, w)
		}
	}

	// A nil watchlist (absent operator-state file) is a no-op.
	joinWatchlist(windows, nil)
	if windows[0].MonitoredChange != "gmcp" {
		t.Error("nil watchlist mutated the windows")
	}
}

// TestOperatorStaleness pins the threshold rule (R8): stale past
// DefaultWatchlistStaleThreshold, fresh within it, never stale when absent.
func TestOperatorStaleness(t *testing.T) {
	now := time.Now().Unix()
	threshold := int64(cron.DefaultWatchlistStaleThreshold / time.Second)
	if !operatorStaleness(now-threshold-1, now) {
		t.Error("one second past the threshold should be stale")
	}
	if operatorStaleness(now-threshold+1, now) {
		t.Error("within the threshold should be fresh")
	}
	if operatorStaleness(now, now) {
		t.Error("a tick at now should be fresh")
	}
	if operatorStaleness(0, now) {
		t.Error("an absent stamp (0) is never stale — nothing to be stale about")
	}
}

// TestProjectSessionOperatorStalenessJSON pins the payload contract: the
// per-server staleness facts ride every ProjectSession marshal identically
// (omitempty keeps them off when the operator-state file is absent).
func TestProjectSessionOperatorStalenessJSON(t *testing.T) {
	stale, err := json.Marshal(ProjectSession{
		Name: "s1", Windows: []tmux.WindowInfo{},
		OperatorLastTickAt: 1700000000, OperatorStale: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(stale), `"operatorLastTickAt":1700000000`) || !strings.Contains(string(stale), `"operatorStale":true`) {
		t.Errorf("stale session JSON missing operator facts: %s", stale)
	}

	fresh, err := json.Marshal(ProjectSession{Name: "s2", Windows: []tmux.WindowInfo{}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(fresh), "operatorLastTickAt") || strings.Contains(string(fresh), "operatorStale") {
		t.Errorf("absent operator-state file must omit both keys: %s", fresh)
	}
}

// TestProjectTrackedItems pins the pane → windowId resolution and field
// mapping of the operatorTracked projection: a pane-bearing item on a live
// pane gets WindowID, a pane no window carries and a pane-less item get
// none, and every other field maps one-to-one in list order.
func TestProjectTrackedItems(t *testing.T) {
	data := []sessionData{
		{info: tmux.SessionInfo{Name: "main"}, windows: []tmux.WindowInfo{
			{WindowID: "@1", Name: "work", Panes: []tmux.PaneInfo{{PaneID: "%5", IsActive: true}}},
		}},
		{info: tmux.SessionInfo{Name: "ops"}, windows: []tmux.WindowInfo{
			{WindowID: "@9", Name: "operator", Panes: []tmux.PaneInfo{{PaneID: "%9", IsActive: true}}},
		}},
	}
	items := []cron.TrackedItem{
		{ID: "pa9n", Kind: "fab-change", Pane: "%5", Repo: "/r", Session: "s", Stage: "apply", Agent: "idle", Branch: "b", UpdatedAt: 1700000100},
		{ID: "gone", Kind: "fab-change", Pane: "%99", DoneAt: 1700000200},
		{ID: "n3", Kind: "note", Text: "archive once merged", Refs: []string{"bf1l"}, Paused: true, AddedAt: 1700000000},
	}
	got := projectTrackedItems(items, paneToWindowMap(data))
	want := []OperatorTrackedItem{
		{ID: "pa9n", Kind: "fab-change", Pane: "%5", WindowID: "@1", Repo: "/r", Session: "s", Stage: "apply", Agent: "idle", Branch: "b", UpdatedAt: 1700000100},
		{ID: "gone", Kind: "fab-change", Pane: "%99", DoneAt: 1700000200},
		{ID: "n3", Kind: "note", Text: "archive once merged", Refs: []string{"bf1l"}, Paused: true, AddedAt: 1700000000},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("projectTrackedItems() = %+v, want %+v", got, want)
	}
	// Never nil: the caller pointers the slice onto the payload, and an empty
	// tracked list must serialize as [] (present, empty), not vanish.
	if got := projectTrackedItems(nil, nil); got == nil || len(got) != 0 {
		t.Errorf("nil items must project to an empty non-nil slice, got %#v", got)
	}
}

// TestProjectSessionOperatorTrackedJSON pins the payload contract:
// operatorTracked marshals camelCase with omitempty on every field but id,
// and is omitted entirely when nil (absent operator-state file / older
// backend).
func TestProjectSessionOperatorTrackedJSON(t *testing.T) {
	tracked := []OperatorTrackedItem{
		{ID: "pa9n", Kind: "fab-change", Pane: "%5", WindowID: "@1", Stage: "apply", UpdatedAt: 1700000100},
		{ID: "n3", Kind: "note", Text: "archive once merged", Refs: []string{"bf1l"}, DoneAt: 1700000200},
	}
	with, err := json.Marshal(ProjectSession{Name: "s1", Windows: []tmux.WindowInfo{}, OperatorTracked: &tracked})
	if err != nil {
		t.Fatal(err)
	}
	s := string(with)
	for _, want := range []string{
		`"operatorTracked":[`,
		`{"id":"pa9n","kind":"fab-change","pane":"%5","windowId":"@1","stage":"apply","updatedAt":1700000100}`,
		`{"id":"n3","kind":"note","text":"archive once merged","refs":["bf1l"],"doneAt":1700000200}`,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("session JSON missing %s: %s", want, s)
		}
	}

	without, err := json.Marshal(ProjectSession{Name: "s2", Windows: []tmux.WindowInfo{}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(without), "operatorTracked") {
		t.Errorf("nil OperatorTracked must omit the key: %s", without)
	}

	// A present-but-empty tracked list (the state file exists, tracked: [])
	// must stay distinguishable from an absent file: the key is emitted as [].
	empty := []OperatorTrackedItem{}
	withEmpty, err := json.Marshal(ProjectSession{Name: "s3", Windows: []tmux.WindowInfo{}, OperatorTracked: &empty})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(withEmpty), `"operatorTracked":[]`) {
		t.Errorf("empty OperatorTracked must serialize as []: %s", withEmpty)
	}
}

// TestDeriveConversationAvailable: the capability is true only when the
// identity is present AND the provider has a transcript adapter AND the
// bounded resolution succeeds. Identity-only providers (copilot) and
// missing transcripts degrade to false.
func TestDeriveConversationAvailable(t *testing.T) {
	// Absent identity.
	if deriveConversationAvailable("", "") {
		t.Error("empty identity must be false")
	}
	// Identity-only provider: no adapter registered.
	if deriveConversationAvailable("copilot", "0dd0cf59-31dd-4565-9973-3b34f665b354") {
		t.Error("copilot (no transcript adapter) must be false")
	}

	// Claude with a resolvable transcript under an isolated config root.
	claudeRoot := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", claudeRoot)
	ref := "5d80479e-8f25-46cd-a0d4-e51435508a37"
	if deriveConversationAvailable("claude", ref) {
		t.Error("missing claude transcript must be false")
	}
	projDir := filepath.Join(claudeRoot, "projects", "someproj")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projDir, ref+".jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !deriveConversationAvailable("claude", ref) {
		t.Error("resolvable claude transcript must be true")
	}

	// Codex with a fixture rollout under an isolated CODEX_HOME.
	codexRoot := t.TempDir()
	t.Setenv("CODEX_HOME", codexRoot)
	codexRef := "01a06319-6a63-7791-84df-86736cd58e2e"
	dayDir := filepath.Join(codexRoot, "sessions", "2026", "09", "09")
	if err := os.MkdirAll(dayDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dayDir, "rollout-2026-09-09T10-00-00-"+codexRef+".jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !deriveConversationAvailable("codex", codexRef) {
		t.Error("resolvable codex rollout must be true")
	}
}

// TestFetchSessionsWatchlistSlug pins the watchlist-join file derivation: the
// fab operator state file is named by the SLUGIFIED SOCKET PATH (fab's naming
// rule), resolved per fetch via the SocketPath seam, with slug "default" as
// the degradation when the query fails. Driven end-to-end through
// FetchSessions against the fetch seams — no live tmux server.
func TestFetchSessionsWatchlistSlug(t *testing.T) {
	const (
		server    = "runKit"
		paneID    = "%5"
		changeKey = "260909-abcd-some-change"
		lastTick  = 1757400000
	)

	// stubFetchSeams points every fetch-path tmux seam at in-memory fakes: one
	// session "main" holding one window whose pane is the watchlist join key.
	stubFetchSeams := func(t *testing.T, socketPath string, socketErr error) {
		t.Helper()
		origSessions, origClients, origWindows, origSocket := listSessionsFn, listClientsFn, listWindowsFn, socketPathFn
		t.Cleanup(func() {
			listSessionsFn, listClientsFn, listWindowsFn, socketPathFn = origSessions, origClients, origWindows, origSocket
		})
		listSessionsFn = func(context.Context, string) ([]tmux.SessionInfo, error) {
			return []tmux.SessionInfo{{Name: "main", Windows: 1}}, nil
		}
		listClientsFn = func(context.Context, string) ([]tmux.ClientInfo, error) {
			return nil, nil
		}
		listWindowsFn = func(_ context.Context, session, _ string) ([]tmux.WindowInfo, error) {
			return []tmux.WindowInfo{{
				Index: 0, WindowID: "@1", Name: session,
				Panes: []tmux.PaneInfo{{PaneID: paneID, IsActive: true}},
			}}, nil
		}
		socketPathFn = func(context.Context, string) (string, error) {
			return socketPath, socketErr
		}
	}

	// writeFabState lays down $XDG_STATE_HOME/fab/operator/<slug>.yaml with the
	// tracked: list holding one pane-bearing change item (the join key) and one
	// pane-less note, plus a last_tick_at stamp.
	writeFabState := func(t *testing.T, xdg, slug string) {
		t.Helper()
		dir := filepath.Join(xdg, "fab", "operator")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		body := fmt.Sprintf("last_tick_at: %d\ntracked:\n  - id: %s\n    kind: fab-change\n    scope: {pane: %q, repo: /repo, stage: apply, agent: claude, branch: feat/x}\n    done_at: null\n  - id: n3\n    kind: note\n    text: archive once merged\n    scope: {refs: [bf1l]}\n    done_at: null\n",
			lastTick, changeKey, paneID)
		if err := os.WriteFile(filepath.Join(dir, slug+".yaml"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	fetch := func(t *testing.T) []ProjectSession {
		t.Helper()
		got, err := FetchSessions(context.Background(), server, nil, nil)
		if err != nil {
			t.Fatalf("FetchSessions() error: %v", err)
		}
		if len(got) != 1 || len(got[0].Windows) != 1 {
			t.Fatalf("FetchSessions() = %+v, want one session with one window", got)
		}
		return got
	}

	t.Run("socket-path slug finds the fab file", func(t *testing.T) {
		xdg := t.TempDir()
		t.Setenv("XDG_STATE_HOME", xdg)
		stubFetchSeams(t, "/tmp/tmux-1001/runKit", nil)
		writeFabState(t, xdg, "tmp-tmux--1001-runKit")

		got := fetch(t)
		w := got[0].Windows[0]
		if !w.Monitored || w.MonitoredChange != changeKey {
			t.Errorf("window = %+v, want monitored via the %q entry", w, changeKey)
		}
		if got[0].OperatorLastTickAt != lastTick {
			t.Errorf("OperatorLastTickAt = %d, want %d", got[0].OperatorLastTickAt, lastTick)
		}
		// The whole tracked list rides every session: the pane-bearing item
		// with its WindowID resolved, the pane-less note without one.
		wantTracked := []OperatorTrackedItem{
			{ID: changeKey, Kind: "fab-change", Pane: paneID, WindowID: "@1", Repo: "/repo", Stage: "apply", Agent: "claude", Branch: "feat/x"},
			{ID: "n3", Kind: "note", Text: "archive once merged", Refs: []string{"bf1l"}},
		}
		if got[0].OperatorTracked == nil || !reflect.DeepEqual(*got[0].OperatorTracked, wantTracked) {
			t.Errorf("OperatorTracked = %+v, want %+v", got[0].OperatorTracked, wantTracked)
		}
	})

	t.Run("a present file with an empty tracked list stamps an empty, non-nil list", func(t *testing.T) {
		xdg := t.TempDir()
		t.Setenv("XDG_STATE_HOME", xdg)
		stubFetchSeams(t, "/tmp/tmux-1001/runKit", nil)
		dir := filepath.Join(xdg, "fab", "operator")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "tmp-tmux--1001-runKit.yaml"), []byte("last_tick_at: 1700000000\ntracked: []\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		got := fetch(t)
		if got[0].OperatorTracked == nil || len(*got[0].OperatorTracked) != 0 {
			t.Errorf("OperatorTracked = %+v, want a present empty list", got[0].OperatorTracked)
		}
		if got[0].Windows[0].Monitored {
			t.Errorf("window = %+v, want unmonitored with an empty tracked list", got[0].Windows[0])
		}
	})

	t.Run("socket-path query failure falls back to the default slug", func(t *testing.T) {
		xdg := t.TempDir()
		t.Setenv("XDG_STATE_HOME", xdg)
		stubFetchSeams(t, "", fmt.Errorf("no server running"))
		writeFabState(t, xdg, "default")

		got := fetch(t)
		w := got[0].Windows[0]
		if !w.Monitored || w.MonitoredChange != changeKey {
			t.Errorf("window = %+v, want the default.yaml join on query failure", w)
		}
		if got[0].OperatorLastTickAt != lastTick {
			t.Errorf("OperatorLastTickAt = %d, want %d", got[0].OperatorLastTickAt, lastTick)
		}
	})

	t.Run("query failure with no default file degrades to an empty watchlist", func(t *testing.T) {
		xdg := t.TempDir()
		t.Setenv("XDG_STATE_HOME", xdg)
		stubFetchSeams(t, "", fmt.Errorf("no server running"))

		got := fetch(t)
		w := got[0].Windows[0]
		if w.Monitored || w.MonitoredChange != "" {
			t.Errorf("window = %+v, want unmonitored with no fab file", w)
		}
		if got[0].OperatorLastTickAt != 0 || got[0].OperatorStale {
			t.Errorf("session = %+v, want zero operator facts with no fab file", got[0])
		}
		if got[0].OperatorTracked != nil {
			t.Errorf("OperatorTracked = %+v, want nil with no fab file", got[0].OperatorTracked)
		}
	})

	t.Run("server name alone never finds the file", func(t *testing.T) {
		// The pre-slugify bug: a file named after the SERVER (<server>.yaml) must
		// stay unread — only the socket-path slug addresses it.
		xdg := t.TempDir()
		t.Setenv("XDG_STATE_HOME", xdg)
		stubFetchSeams(t, "/tmp/tmux-1001/runKit", nil)
		writeFabState(t, xdg, server)

		got := fetch(t)
		if got[0].Windows[0].Monitored {
			t.Error("a server-named fab file must not join — the slug is the socket path")
		}
	})
}

// TestFetchSessionsDerivesAwayIn drives the awayIn tier end-to-end through
// FetchSessions against the fetch seams: the derivation spans ALL sessions'
// windows in one pass (@N is unique per server), so a holder in one session
// marks the home window in another.
func TestFetchSessionsDerivesAwayIn(t *testing.T) {
	origSessions, origClients, origWindows, origSocket := listSessionsFn, listClientsFn, listWindowsFn, socketPathFn
	t.Cleanup(func() {
		listSessionsFn, listClientsFn, listWindowsFn, socketPathFn = origSessions, origClients, origWindows, origSocket
	})
	listSessionsFn = func(context.Context, string) ([]tmux.SessionInfo, error) {
		return []tmux.SessionInfo{{Name: "one", Windows: 2}, {Name: "two", Windows: 1}}, nil
	}
	listClientsFn = func(context.Context, string) ([]tmux.ClientInfo, error) {
		return nil, nil
	}
	listWindowsFn = func(_ context.Context, session, _ string) ([]tmux.WindowInfo, error) {
		switch session {
		case "one":
			return []tmux.WindowInfo{
				{Index: 0, WindowID: "@3", Name: "home", Layout: "tty"},
				{Index: 1, WindowID: "@7", Name: "holder", Layout: "h(tty,@3/tty)"},
			}, nil
		default:
			return []tmux.WindowInfo{
				{Index: 0, WindowID: "@9", Name: "dead-ref", Layout: "h(tty,@44/tty)"},
			}, nil
		}
	}
	socketPathFn = func(context.Context, string) (string, error) {
		return "", fmt.Errorf("no server running")
	}

	got, err := FetchSessions(context.Background(), "srv", nil, nil)
	if err != nil {
		t.Fatalf("FetchSessions() error: %v", err)
	}
	home := got[0].Windows[0]
	if home.AwayIn["tty"] != "@7" {
		t.Errorf("home window awayIn = %v, want tty held by @7 (cross-session)", home.AwayIn)
	}
	for _, w := range []tmux.WindowInfo{got[0].Windows[1], got[1].Windows[0]} {
		if w.AwayIn != nil {
			t.Errorf("window %s awayIn = %v, want empty", w.WindowID, w.AwayIn)
		}
	}
}
