package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/tmux"
)

// ── pickLandingSession (pure rung ladder, no tmux) ──────────────────────────

func tabNewUserFacts(name, path string, attached int) tmux.SessionFacts {
	return tmux.SessionFacts{Name: name, Role: tmux.SessionRoleUser, Path: path, Attached: attached}
}

func TestPickLandingSession(t *testing.T) {
	// identityRoot treats every path as its own main-worktree root.
	identityRoot := func(p string) string { return p }

	t.Run("sole user candidate wins outright", func(t *testing.T) {
		session, rung, err := pickLandingSession(
			[]tmux.SessionFacts{tabNewUserFacts("work", "/repo", 0)}, "/elsewhere", identityRoot)
		if err != nil || session != "work" || rung != sessionRungSoleUser {
			t.Errorf("= %q, %q, %v; want work, sole-user, nil", session, rung, err)
		}
	})

	t.Run("cwd main-root match beats attachment and row order", func(t *testing.T) {
		candidates := []tmux.SessionFacts{
			tabNewUserFacts("alpha", "/a", 9),
			tabNewUserFacts("run-kit", "/home/u/code/run-kit", 0),
		}
		session, rung, err := pickLandingSession(candidates, "/home/u/code/run-kit", identityRoot)
		if err != nil || session != "run-kit" || rung != sessionRungCwdRoot {
			t.Errorf("= %q, %q, %v; want run-kit, cwd-root, nil", session, rung, err)
		}
	})

	t.Run("a rootless candidate never matches", func(t *testing.T) {
		candidates := []tmux.SessionFacts{
			tabNewUserFacts("alpha", "/nonrepo", 0),
			tabNewUserFacts("work", "/repo", 0),
		}
		rootOf := func(p string) string {
			if p == "/nonrepo" {
				return ""
			}
			return p
		}
		session, rung, err := pickLandingSession(candidates, "/repo", rootOf)
		if err != nil || session != "work" || rung != sessionRungCwdRoot {
			t.Errorf("= %q, %q, %v; want work, cwd-root, nil", session, rung, err)
		}
	})

	t.Run("a path prefix of the cwd root from a different repo does not match", func(t *testing.T) {
		// /home/u/code/run is a literal prefix of /home/u/code/run-kit but a
		// different repository — rootOf resolves each to its own root.
		candidates := []tmux.SessionFacts{
			tabNewUserFacts("neighbor", "/home/u/code/run", 0),
			tabNewUserFacts("other", "/other", 0),
		}
		session, rung, err := pickLandingSession(candidates, "/home/u/code/run-kit", identityRoot)
		if err != nil || session != "neighbor" || rung != sessionRungMostAttached {
			t.Errorf("= %q, %q, %v; want neighbor via most-attached (all-zero ties → first row), nil", session, rung, err)
		}
	})

	t.Run("a non-repo cwd skips the root rung", func(t *testing.T) {
		candidates := []tmux.SessionFacts{
			tabNewUserFacts("alpha", "/a", 1),
			tabNewUserFacts("work", "/repo", 0),
		}
		session, rung, err := pickLandingSession(candidates, "", identityRoot)
		if err != nil || session != "alpha" || rung != sessionRungMostAttached {
			t.Errorf("= %q, %q, %v; want alpha, most-attached, nil", session, rung, err)
		}
	})

	t.Run("most-attached wins, ties break to the earliest row", func(t *testing.T) {
		candidates := []tmux.SessionFacts{
			tabNewUserFacts("a", "/a", 0),
			tabNewUserFacts("b", "/b", 2),
			tabNewUserFacts("c", "/c", 2),
		}
		session, rung, err := pickLandingSession(candidates, "/nowhere", identityRoot)
		if err != nil || session != "b" || rung != sessionRungMostAttached {
			t.Errorf("= %q, %q, %v; want b, most-attached, nil", session, rung, err)
		}
	})

	t.Run("all-zero attachment picks the first row", func(t *testing.T) {
		candidates := []tmux.SessionFacts{
			tabNewUserFacts("a", "/a", 0),
			tabNewUserFacts("b", "/b", 0),
		}
		session, rung, err := pickLandingSession(candidates, "/nowhere", identityRoot)
		if err != nil || session != "a" || rung != sessionRungMostAttached {
			t.Errorf("= %q, %q, %v; want a, most-attached, nil", session, rung, err)
		}
	})

	t.Run("zero candidates yield nowhere to spawn", func(t *testing.T) {
		session, rung, err := pickLandingSession(nil, "/repo", identityRoot)
		if !errors.Is(err, errNowhereToSpawn) || session != "" || rung != "" {
			t.Errorf("= %q, %q, %v; want empty + errNowhereToSpawn", session, rung, err)
		}
		if !strings.Contains(err.Error(), "nowhere to spawn") {
			t.Errorf("err = %v, want the nowhere-to-spawn phrase", err)
		}
	})
}

// ── resolveTabNewSession via stubbed seams (no tmux) ────────────────────────

// stubTabNewCaller points the caller-resolution seams at a fake socket whose
// display-message reads answer callerSession, so the resolver's inside-tmux
// branch runs without a server. Returns the server name the resolver derives
// from the fake socket.
func stubTabNewCaller(t *testing.T, callerSession string) string {
	t.Helper()
	t.Setenv("TMUX_PANE", "%1")
	origTMUX, origRun := ownTabOriginalTMUXFn, ownTabRunOutputFn
	ownTabOriginalTMUXFn = func() string { return "/tmp/rk-tabnew-fake,1,0" }
	ownTabRunOutputFn = func(context.Context, []string) ([]byte, error) {
		return []byte(callerSession + "\n"), nil
	}
	t.Cleanup(func() { ownTabOriginalTMUXFn, ownTabRunOutputFn = origTMUX, origRun })
	return "rk-tabnew-fake"
}

// stubTabNewLadder swaps the enumeration/root seams and reports whether the
// enumeration was consulted (it must stay untouched on the explicit, caller,
// and server rungs).
func stubTabNewLadder(t *testing.T, facts []tmux.SessionFacts, factsErr error, rootOf func(string) string) *bool {
	t.Helper()
	consulted := new(bool)
	origFacts, origRoot := tabNewSessionFactsFn, tabNewMainRootFn
	tabNewSessionFactsFn = func(context.Context, string) ([]tmux.SessionFacts, error) {
		*consulted = true
		return facts, factsErr
	}
	tabNewMainRootFn = func(_ context.Context, dir string) string { return rootOf(dir) }
	t.Cleanup(func() { tabNewSessionFactsFn, tabNewMainRootFn = origFacts, origRoot })
	return consulted
}

func TestResolveTabNewSessionExplicitWins(t *testing.T) {
	resetTabFlagState(t)
	tabNewSessionFlag = "=work"
	server := stubTabNewCaller(t, "_rk-operator")
	consulted := stubTabNewLadder(t, nil, fmt.Errorf("must not be consulted"), func(p string) string { return p })

	session, srv, rung, err := resolveTabNewSession(context.Background(), "", "/anywhere")
	if err != nil || session != "work" || rung != sessionRungExplicit || srv != server {
		t.Errorf("= %q, %q, %q, %v; want work, %s, explicit, nil", session, srv, rung, err, server)
	}
	if *consulted {
		t.Error("the ladder was consulted on the explicit rung")
	}
}

func TestResolveTabNewSessionUserCallerKeepsAmbientDefault(t *testing.T) {
	resetTabFlagState(t)
	server := stubTabNewCaller(t, "boot")
	consulted := stubTabNewLadder(t, nil, fmt.Errorf("must not be consulted"), func(p string) string { return p })

	session, srv, rung, err := resolveTabNewSession(context.Background(), "", "/anywhere")
	if err != nil || session != "boot" || rung != sessionRungCaller || srv != server {
		t.Errorf("= %q, %q, %q, %v; want boot, %s, caller, nil", session, srv, rung, err, server)
	}
	if *consulted {
		t.Error("the ladder was consulted for a user-role caller")
	}
}

func TestResolveTabNewSessionInfraCallerLadder(t *testing.T) {
	resetTabFlagState(t)
	server := stubTabNewCaller(t, "_rk-operator")
	facts := []tmux.SessionFacts{
		{Name: "_rk-operator", Role: tmux.SessionRoleOperator, Path: "/infra"},
		tabNewUserFacts("alpha", "/a", 3),
		tabNewUserFacts("work", "/repo", 0),
	}

	t.Run("cwd root match", func(t *testing.T) {
		stubTabNewLadder(t, facts, nil, func(p string) string { return p })
		session, srv, rung, err := resolveTabNewSession(context.Background(), "", "/repo")
		if err != nil || session != "work" || rung != sessionRungCwdRoot || srv != server {
			t.Errorf("= %q, %q, %q, %v; want work, %s, cwd-root, nil", session, srv, rung, err, server)
		}
	})

	t.Run("no root match falls to most-attached", func(t *testing.T) {
		stubTabNewLadder(t, facts, nil, func(p string) string { return p })
		session, _, rung, err := resolveTabNewSession(context.Background(), "", "/nonrepo")
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		// "/nonrepo" is its own root under the identity stub and matches no
		// candidate, so attachment decides.
		if session != "alpha" || rung != sessionRungMostAttached {
			t.Errorf("= %q, %q; want alpha, most-attached", session, rung)
		}
	})

	t.Run("zero user sessions error nowhere to spawn", func(t *testing.T) {
		infra := facts[:1]
		stubTabNewLadder(t, infra, nil, func(p string) string { return p })
		_, _, _, err := resolveTabNewSession(context.Background(), "", "/repo")
		if err == nil || exitCode(err) != 1 {
			t.Fatalf("err = %v (code %d), want exit 1", err, exitCode(err))
		}
		for _, want := range []string{"nowhere to spawn", "_rk-operator", server, "--session =S"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("err = %v, want it to name %q", err, want)
			}
		}
	})

	t.Run("an enumeration failure is operational", func(t *testing.T) {
		stubTabNewLadder(t, nil, fmt.Errorf("boom"), func(p string) string { return p })
		_, _, _, err := resolveTabNewSession(context.Background(), "", "/repo")
		if err == nil || exitCode(err) != 1 {
			t.Fatalf("err = %v (code %d), want exit 1", err, exitCode(err))
		}
		if !strings.Contains(err.Error(), "resolve target session: list sessions: boom") {
			t.Errorf("err = %v, want the list-sessions wrap", err)
		}
	})
}

func TestResolveTabNewSessionEmptyEnumerationLivenessProbe(t *testing.T) {
	resetTabFlagState(t)
	stubTabNewCaller(t, "_rk-operator")

	stubAlive := func(t *testing.T, aliveErr error) *bool {
		t.Helper()
		probed := new(bool)
		origAlive := tabNewServerAliveFn
		tabNewServerAliveFn = func(context.Context, string) error {
			*probed = true
			return aliveErr
		}
		t.Cleanup(func() { tabNewServerAliveFn = origAlive })
		return probed
	}

	t.Run("dead server surfaces its own failure, not nowhere to spawn", func(t *testing.T) {
		stubTabNewLadder(t, nil, nil, func(p string) string { return p })
		probed := stubAlive(t, fmt.Errorf("no server listening"))
		_, _, _, err := resolveTabNewSession(context.Background(), "", "/repo")
		if err == nil || exitCode(err) != 1 {
			t.Fatalf("err = %v (code %d), want exit 1", err, exitCode(err))
		}
		if !strings.Contains(err.Error(), "resolve target session: list sessions: no server listening") {
			t.Errorf("err = %v, want the liveness-probe wrap", err)
		}
		if strings.Contains(err.Error(), "nowhere to spawn") {
			t.Errorf("err = %v, want the dead-server diagnostic, not the zero-candidate rung", err)
		}
		if !*probed {
			t.Error("the liveness probe was not consulted on an empty enumeration")
		}
	})

	t.Run("alive server with no sessions still yields nowhere to spawn", func(t *testing.T) {
		stubTabNewLadder(t, nil, nil, func(p string) string { return p })
		probed := stubAlive(t, nil)
		_, _, _, err := resolveTabNewSession(context.Background(), "", "/repo")
		if err == nil || !strings.Contains(err.Error(), "nowhere to spawn") {
			t.Errorf("err = %v, want the nowhere-to-spawn phrase", err)
		}
		if !*probed {
			t.Error("the liveness probe was not consulted on an empty enumeration")
		}
	})
}

// ── integration: real tmux server, infra-session caller ─────────────────────

// tabNewInfraCaller adds an _rk-operator session to the test server and points
// $TMUX_PANE at its pane, so tab new runs as an infrastructure caller.
func tabNewInfraCaller(t *testing.T, env *tabTestEnv) {
	t.Helper()
	pane := tabTmuxOut(t, env.server, "new-session", "-d", "-s", "_rk-operator", "-P", "-F", "#{pane_id}")
	t.Setenv("TMUX_PANE", pane)
}

// tabNewGitDo runs a git command with a throwaway identity, failing the test
// on error (the gitinfo_test.go gitDo idiom, kept package-local).
func tabNewGitDo(t *testing.T, dir string, args ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	full := append([]string{"-C", dir}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, string(out))
	}
}

func TestTabNewInfraCallerSoleUserSession(t *testing.T) {
	env := withTabTestServer(t)
	tabNewInfraCaller(t, env)

	stdout, _, err := runTabCmd(t, "new", "--json")
	if err != nil {
		t.Fatalf("tab new --json: %v", err)
	}
	var obj map[string]string
	unwrapEnvelopeResult(t, stdout, &obj)
	if obj["session"] != "boot" || obj["session_rung"] != sessionRungSoleUser {
		t.Errorf("result = %v, want session boot at rung sole-user — an infra caller never lands beside itself", obj)
	}
	if !strings.HasPrefix(obj["window_id"], "@") {
		t.Errorf("window_id = %q, want @N", obj["window_id"])
	}
	// The window really landed in boot.
	if got := tabTmuxOut(t, env.server, "display-message", "-pt", obj["window_id"], "#{session_name}"); got != "boot" {
		t.Errorf("window session = %q, want boot", got)
	}

	// The human path prints only @N on stdout and notes the rung on stderr.
	stdout, stderr, err := runTabCmd(t, "new")
	if err != nil {
		t.Fatalf("tab new: %v", err)
	}
	if id := strings.TrimSpace(stdout); !strings.HasPrefix(id, "@") || strings.Contains(stdout, "session") {
		t.Errorf("stdout = %q, want the bare @N datum only", stdout)
	}
	if !strings.Contains(stderr, "session: boot ("+sessionRungSoleUser+")") {
		t.Errorf("stderr = %q, want the session: boot (sole-user) note", stderr)
	}
}

func TestTabNewInfraCallerCwdRootWorktreeSibling(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available — skipping the worktree-sibling case")
	}
	env := withTabTestServer(t)
	tabNewInfraCaller(t, env)

	// A user session rooted at a repo's main checkout, and a --cwd inside the
	// sibling <repo>.worktrees/<name> linked worktree: no path prefix ties the
	// two, only git's common dir does.
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	tabNewGitDo(t, repo, "init")
	tabNewGitDo(t, repo, "commit", "--allow-empty", "-m", "init")
	wt := filepath.Join(filepath.Dir(repo), "repo.worktrees", "feat-x")
	tabNewGitDo(t, repo, "worktree", "add", wt)
	tabTmuxDo(t, env.server, "new-session", "-d", "-s", "work", "-c", repo)

	stdout, _, err := runTabCmd(t, "new", "--json", "--cwd", wt)
	if err != nil {
		t.Fatalf("tab new --json: %v", err)
	}
	var obj map[string]string
	unwrapEnvelopeResult(t, stdout, &obj)
	if obj["session"] != "work" || obj["session_rung"] != sessionRungCwdRoot {
		t.Errorf("result = %v, want session work at rung cwd-root", obj)
	}
	if got := tabTmuxOut(t, env.server, "display-message", "-pt", obj["window_id"], "#{session_name}"); got != "work" {
		t.Errorf("window session = %q, want work", got)
	}
}

func TestTabNewInfraCallerExplicitSessionWins(t *testing.T) {
	env := withTabTestServer(t)
	tabNewInfraCaller(t, env)

	stdout, _, err := runTabCmd(t, "new", "--session", "=boot", "--json")
	if err != nil {
		t.Fatalf("tab new --session =boot --json: %v", err)
	}
	var obj map[string]string
	unwrapEnvelopeResult(t, stdout, &obj)
	if obj["session"] != "boot" || obj["session_rung"] != sessionRungExplicit {
		t.Errorf("result = %v, want session boot at rung explicit", obj)
	}
}

func TestTabNewInfraCallerNowhereToSpawn(t *testing.T) {
	env := withTabTestServer(t)
	tabNewInfraCaller(t, env)
	tabTmuxDo(t, env.server, "kill-session", "-t", "boot")
	before := tabTmuxOut(t, env.server, "list-windows", "-a", "-F", "#{window_id}")

	stdout, _, err := runTabCmd(t, "new")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v (code %d), want exit 1", err, exitCode(err))
	}
	for _, want := range []string{"nowhere to spawn", "_rk-operator", env.server, "--session =S"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %v, want it to name %q", err, want)
		}
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty on the failure", stdout)
	}
	if after := tabTmuxOut(t, env.server, "list-windows", "-a", "-F", "#{window_id}"); after != before {
		t.Errorf("windows changed on a nowhere-to-spawn failure: %q → %q", before, after)
	}

	// Under --json the failure rides the central operational envelope.
	stdout, _, err = runTabCmd(t, "new", "--json")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("--json: err = %v (code %d), want exit 1", err, exitCode(err))
	}
	if e := parseFailureEnvelope(t, centralFailureEnvelope(t, stdout, err)); e.Code != envelopeCodeOperational ||
		!strings.Contains(e.Message, "nowhere to spawn") {
		t.Errorf("envelope error = %+v, want operational nowhere-to-spawn", e)
	}
}

// TestTabNewHelpDocumentsTheRule pins the help surface: the rung ladder, the
// nowhere-to-spawn error, the session_rung key, and the interactive-shell
// launch with its opt-out are all documented.
func TestTabNewHelpDocumentsTheRule(t *testing.T) {
	for _, want := range []string{"session_rung", "nowhere to spawn", "most-attached", "sole user",
		"${SHELL:-/bin/sh} -i -c", "not alias-expanded", "--no-shell-profile"} {
		if !strings.Contains(tabNewCmd.Long, want) {
			t.Errorf("tab new Long omits %q", want)
		}
	}
}

// TestTabNewCommandComposition pins the tmux shell-command positional for all
// four wrap/fallback flag combinations, tmux-free through the creation seam.
func TestTabNewCommandComposition(t *testing.T) {
	cases := []struct {
		name  string
		flags []string
		want  string
	}{
		{"default", nil,
			`${SHELL:-/bin/sh} -i -c ''\''claude'\'' '\''--model'\'' '\''opus'\'''; exec "${SHELL:-/bin/sh}"`},
		{"--no-shell-fallback", []string{"--no-shell-fallback"},
			`${SHELL:-/bin/sh} -i -c ''\''claude'\'' '\''--model'\'' '\''opus'\'''`},
		{"--no-shell-profile", []string{"--no-shell-profile"},
			`'claude' '--model' 'opus'; exec "${SHELL:-/bin/sh}"`},
		{"--no-shell-profile --no-shell-fallback", []string{"--no-shell-profile", "--no-shell-fallback"},
			`'claude' '--model' 'opus'`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got string
			origCreate, origWake := tabNewCreateWindowFn, tabWakeFn
			tabNewCreateWindowFn = func(session, _, _, _, shellCmd string, _ []tmux.WindowOptionOp) (tmux.WindowBirth, error) {
				got = shellCmd
				return tmux.WindowBirth{Session: session, WindowID: "@1", PaneID: "%1"}, nil
			}
			tabWakeFn = func(context.Context, string) {}
			t.Cleanup(func() { tabNewCreateWindowFn, tabWakeFn = origCreate, origWake })

			args := append([]string{"new", "--session", "=s", "--cwd", t.TempDir()}, tc.flags...)
			args = append(args, "--", "claude", "--model", "opus")
			if _, _, err := runTabCmd(t, args...); err != nil {
				t.Fatalf("tab new: %v", err)
			}
			if got != tc.want {
				t.Errorf("shellCmd = %q, want %q", got, tc.want)
			}
		})
	}
}
