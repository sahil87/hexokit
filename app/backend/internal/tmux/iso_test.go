package tmux

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// showSessionOptionValue reads one session option's value (`show-options -v`).
func showSessionOptionValue(t *testing.T, server, session, option string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	lines, err := tmuxExecServer(ctx, server, "show-options", "-t", ExactSessionTarget(session), "-v", option)
	if err != nil {
		t.Fatalf("show-options %s on %q: %v", option, session, err)
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.TrimSpace(lines[0])
}

func TestEnsureIsoSession_CreatesLinkedSession(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	iso, ok := IsoSessionName(wid)
	if !ok {
		t.Fatalf("IsoSessionName(%q) not ok", wid)
	}

	got, err := EnsureIsoSession(ctx, server, wid)
	if err != nil {
		t.Fatalf("EnsureIsoSession: %v", err)
	}
	if got != iso {
		t.Errorf("EnsureIsoSession = %q, want %q", got, iso)
	}

	// The iso session holds exactly the linked window (no placeholder).
	isoWindows := windowsInSession(t, server, iso)
	if len(isoWindows) != 1 || isoWindows[0] != wid {
		t.Fatalf("iso session windows = %v, want [%s] (single window, no placeholder)", isoWindows, wid)
	}
	// Dual membership: the window STAYS in its home session (link, not move).
	inHome := false
	for _, id := range windowsInSession(t, server, "home") {
		if id == wid {
			inHome = true
		}
	}
	if !inHome {
		t.Errorf("window %s left its home session after EnsureIsoSession (should stay linked in home)", wid)
	}
	// destroy-unattached must NOT be set at creation — on tmux 3.7c setting it
	// on a never-attached session destroys the session immediately; the attach
	// argv chains it instead. An unset session-scope value reads empty.
	if v := showSessionOptionValue(t, server, iso, "destroy-unattached"); v == "on" {
		t.Errorf("destroy-unattached = %q at creation, want unset/off (off until the attach chains it)", v)
	}
}

func TestEnsureIsoSession_Idempotent(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")

	first, err := EnsureIsoSession(ctx, server, wid)
	if err != nil {
		t.Fatalf("EnsureIsoSession first: %v", err)
	}
	second, err := EnsureIsoSession(ctx, server, wid)
	if err != nil {
		t.Fatalf("EnsureIsoSession second (idempotent): %v", err)
	}
	if first != second {
		t.Errorf("idempotent ensure returned %q then %q", first, second)
	}
	if isoWindows := windowsInSession(t, server, first); len(isoWindows) != 1 || isoWindows[0] != wid {
		t.Errorf("idempotent re-ensure changed iso windows: %v", isoWindows)
	}
}

// A burst of concurrent ensures for the same window exercises the
// duplicate-session race tolerance: every caller must succeed and the session
// must end with exactly the one linked window, no matter which ensure won
// creation.
func TestEnsureIsoSession_ConcurrentEnsuresShareOneSession(t *testing.T) {
	server := withBoardTmux(t)
	wid := createHomeWindow(t, server, "home", "agent")
	iso, _ := IsoSessionName(wid)

	const n = 6
	var wg sync.WaitGroup
	errs := make([]error, n)
	names := make([]string, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			names[i], errs[i] = EnsureIsoSession(ctx, server, wid)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("ensure %d: %v", i, err)
		}
		if names[i] != iso {
			t.Errorf("ensure %d returned %q, want %q", i, names[i], iso)
		}
	}
	if isoWindows := windowsInSession(t, server, iso); len(isoWindows) != 1 || isoWindows[0] != wid {
		t.Errorf("iso session windows after concurrent ensures = %v, want [%s]", isoWindows, wid)
	}
}

// A loser observing the winner's placeholder-only session (between the
// winner's new-session and link-window) must NOT return it as ready — it waits
// for the target window to link, then shares the completed session.
func TestEnsureIsoSession_WaitsForConcurrentLink(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	iso, _ := IsoSessionName(wid)

	// Simulate the winner mid-ensure: the session exists, placeholder only.
	if _, err := tmuxExecServer(ctx, server, "new-session", "-d", "-s", iso, "-c", ServerBirthDir()); err != nil {
		t.Fatalf("create placeholder-only iso: %v", err)
	}
	placeholder := windowsInSession(t, server, iso)
	if len(placeholder) != 1 {
		t.Fatalf("placeholder-only iso windows = %v, want exactly one", placeholder)
	}

	// The winner completes shortly after the loser's probe: link the window
	// in, kill the placeholder.
	go func() {
		time.Sleep(150 * time.Millisecond)
		if err := LinkWindowToSession(wid, iso, server); err != nil {
			return
		}
		gctx, gcancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer gcancel()
		_, _ = tmuxExecServer(gctx, server, "kill-window", "-t", placeholder[0])
	}()

	got, err := EnsureIsoSession(ctx, server, wid)
	if err != nil {
		t.Fatalf("EnsureIsoSession against an in-flight concurrent ensure: %v", err)
	}
	if got != iso {
		t.Errorf("EnsureIsoSession = %q, want %q", got, iso)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		isoWindows := windowsInSession(t, server, iso)
		if len(isoWindows) == 1 && isoWindows[0] == wid {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("iso session windows = %v, want [%s] (single window, no placeholder)", isoWindows, wid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A placeholder-only iso whose winner died mid-ensure (the window never links)
// must fail closed within the caller's ctx — never be handed to the relay as
// ready.
func TestEnsureIsoSession_StrandedPlaceholderFailsClosed(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	iso, _ := IsoSessionName(wid)
	if _, err := tmuxExecServer(ctx, server, "new-session", "-d", "-s", iso, "-c", ServerBirthDir()); err != nil {
		t.Fatalf("create placeholder-only iso: %v", err)
	}

	ensureCtx, ensureCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer ensureCancel()
	if _, err := EnsureIsoSession(ensureCtx, server, wid); err == nil {
		t.Error("EnsureIsoSession succeeded against a never-linked placeholder-only iso session — want a fail-closed error")
	}
}

// The race-tolerance string match keys on tmux's "duplicate session" stderr —
// pin that phrasing against the live tmux so a version that words it
// differently fails loudly here instead of silently losing race tolerance.
func TestEnsureIsoSession_DuplicateSessionErrorPhrasing(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := tmuxExecServer(ctx, server, "new-session", "-d", "-s", "dup-probe", "-c", ServerBirthDir()); err != nil {
		t.Fatalf("create dup-probe: %v", err)
	}
	if _, err := tmuxExecServer(ctx, server, "new-session", "-d", "-s", "dup-probe", "-c", ServerBirthDir()); err == nil {
		t.Fatal("second new-session with the same name succeeded — cannot verify duplicate phrasing")
	} else if !strings.Contains(err.Error(), "duplicate session") {
		t.Fatalf("duplicate new-session error = %q, want it to contain %q", err.Error(), "duplicate session")
	}
}

func TestEnsureIsoSession_LinkFailureRollsBack(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// A well-formed id that exists on no session: creation succeeds, the link
	// fails, and the rollback must leave no _rk-iso-* session behind.
	const missing = "@9999"
	if _, err := EnsureIsoSession(ctx, server, missing); err == nil {
		t.Fatal("EnsureIsoSession on a missing window succeeded, want error")
	}
	iso, _ := IsoSessionName(missing)
	if hasSession(t, server, iso) {
		t.Errorf("iso session %q survived a failed link — rollback must kill it", iso)
	}
}

func TestEnsureIsoSession_InvalidWindowID(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	for _, id := range []string{"", "42", "@abc", "not-a-window"} {
		if _, err := EnsureIsoSession(ctx, server, id); err == nil {
			t.Errorf("EnsureIsoSession(%q) succeeded, want invalid window id error", id)
		}
	}
}

// Under dual membership via an iso session, ResolveWindowSession must return
// the HOME (non-iso) session even though the isolated window is also a member
// of its `_rk-iso-*` session (tmux's naive pick across links is
// order-unspecified) — mirroring the pin dual-membership test.
func TestResolveWindowSession_isoDualMembershipResolvesHome(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	if _, err := EnsureIsoSession(ctx, server, wid); err != nil {
		t.Fatalf("EnsureIsoSession: %v", err)
	}

	got, err := ResolveWindowSession(ctx, server, wid)
	if err != nil {
		t.Fatalf("ResolveWindowSession: %v", err)
	}
	if got != "home" {
		t.Errorf("ResolveWindowSession(%q) = %q, want %q (the non-iso home session)", wid, got, "home")
	}
}

func TestSessionClientCount(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// A detached session has no attached clients.
	if n, err := SessionClientCount(ctx, server, "home"); err != nil || n != 0 {
		t.Errorf("SessionClientCount(home) = (%d, %v), want (0, nil)", n, err)
	}
	// A missing session reports zero clients (not an error) — the rollback
	// target may already be gone.
	if n, err := SessionClientCount(ctx, server, "_rk-iso-9999"); err != nil || n != 0 {
		t.Errorf("SessionClientCount(missing) = (%d, %v), want (0, nil)", n, err)
	}
}
