package tmux

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestValidBoardName(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"main", true},
		{"deploy-1", true},
		{"a", true},
		{"abc_DEF-123", true},
		{strings.Repeat("a", 32), true},
		{"", false},
		{strings.Repeat("a", 33), false},
		{"foo,bar", false},
		{"foo:bar", false},
		{"foo bar", false},
		{"foo.bar", false},
		{"foo/bar", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ValidBoardName(tt.name)
			if got != tt.want {
				t.Errorf("ValidBoardName(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

func TestValidWindowID(t *testing.T) {
	tests := []struct {
		id   string
		want bool
	}{
		{"@1234", true},
		{"@0", true},
		{"@9999999", true},
		{"@", false},
		{"1234", false},
		{"@abc", false},
		{"@1234a", false},
		{"", false},
	}
	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			got := ValidWindowID(tt.id)
			if got != tt.want {
				t.Errorf("ValidWindowID(%q) = %v, want %v", tt.id, got, tt.want)
			}
		})
	}
}

func TestValidOrderKey(t *testing.T) {
	tests := []struct {
		key  string
		want bool
	}{
		{"a", true},
		{"abcdef", true},
		{strings.Repeat("a", 16), true},
		{"", false},
		{strings.Repeat("a", 17), false},
		{"A", false},
		{"a1", false},
		{"a-b", false},
	}
	for _, tt := range tests {
		t.Run(tt.key, func(t *testing.T) {
			got := ValidOrderKey(tt.key)
			if got != tt.want {
				t.Errorf("ValidOrderKey(%q) = %v, want %v", tt.key, got, tt.want)
			}
		})
	}
}

func TestComputeOrderKey(t *testing.T) {
	tests := []struct {
		name        string
		before      string
		after       string
		want        string
		wantBetween bool // if true, only require strict between, not exact
	}{
		{"prepend basic", "", "b", "a", false},
		{"append basic", "c", "", "d", false},
		{"insert between b c", "b", "c", "", true}, // strictly between
		{"insert between b bm", "b", "bm", "", true},
		{"empty empty", "", "", initialAppendKey, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ComputeOrderKey(tt.before, tt.after)
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if !ValidOrderKey(got) {
				t.Fatalf("got %q is not a valid order key", got)
			}
			if !tt.wantBetween {
				if got != tt.want {
					t.Errorf("got %q, want %q", got, tt.want)
				}
			}
			// Always verify ordering invariants.
			if tt.before != "" && !(tt.before < got) {
				t.Errorf("expected %q < %q", tt.before, got)
			}
			if tt.after != "" && !(got < tt.after) {
				t.Errorf("expected %q < %q", got, tt.after)
			}
		})
	}
}

func TestComputeOrderKey_RepeatedInsertBetween(t *testing.T) {
	// Repeatedly insert between b and c, alternating which neighbour shrinks.
	// Always shrink the LEFT side (move before forward) so we never approach
	// the lex-impossible "<X" zone for keys X starting with 'a' at any depth.
	before := "b"
	after := "c"
	for i := 0; i < 10; i++ {
		got, err := ComputeOrderKey(before, after)
		if err != nil {
			t.Fatalf("iter %d (before=%q, after=%q): %v", i, before, after, err)
		}
		if !ValidOrderKey(got) {
			t.Fatalf("iter %d: %q invalid", i, got)
		}
		if !(before < got && got < after) {
			t.Fatalf("iter %d: %q not strictly between %q and %q", i, got, before, after)
		}
		before = got
	}
}

func TestComputeOrderKey_InvalidInputs(t *testing.T) {
	tests := []struct {
		before, after string
	}{
		{"A", ""},  // uppercase
		{"", "A"},  // uppercase
		{"a1", ""}, // digit
		{"b", "b"}, // equal
		{"c", "b"}, // before > after
		{"", "a"},  // no key < "a" exists in [a-z]+
	}
	for _, tt := range tests {
		t.Run(tt.before+"_"+tt.after, func(t *testing.T) {
			_, err := ComputeOrderKey(tt.before, tt.after)
			if err == nil {
				t.Errorf("expected error for before=%q after=%q", tt.before, tt.after)
			}
		})
	}
}

func TestPinSessionNameRoundTrip(t *testing.T) {
	tests := []struct {
		windowID string
		wantName string
		wantOK   bool
	}{
		{"@42", "_rk-pin-42", true},
		{"@0", "_rk-pin-0", true},
		{"@9999999", "_rk-pin-9999999", true},
		{"42", "", false},
		{"@abc", "", false},
		{"", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.windowID, func(t *testing.T) {
			name, ok := PinSessionName(tt.windowID)
			if ok != tt.wantOK || name != tt.wantName {
				t.Fatalf("PinSessionName(%q) = (%q, %v), want (%q, %v)", tt.windowID, name, ok, tt.wantName, tt.wantOK)
			}
			if !ok {
				return
			}
			id, rok := WindowIDFromPinSession(name)
			if !rok || id != tt.windowID {
				t.Errorf("WindowIDFromPinSession(%q) = (%q, %v), want (%q, true)", name, id, rok, tt.windowID)
			}
		})
	}
}

func TestWindowIDFromPinSession_Invalid(t *testing.T) {
	for _, name := range []string{"dev", "_rk-ctl", "_rk-pin-", "_rk-pin-abc", "rk-relay-x"} {
		if _, ok := WindowIDFromPinSession(name); ok {
			t.Errorf("WindowIDFromPinSession(%q) = ok, want not-ok", name)
		}
	}
}

func TestIsoSessionNameRoundTrip(t *testing.T) {
	tests := []struct {
		windowID string
		wantName string
		wantOK   bool
	}{
		{"@42", "_rk-iso-42", true},
		{"@0", "_rk-iso-0", true},
		{"@9999999", "_rk-iso-9999999", true},
		{"42", "", false},
		{"@abc", "", false},
		{"", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.windowID, func(t *testing.T) {
			name, ok := IsoSessionName(tt.windowID)
			if ok != tt.wantOK || name != tt.wantName {
				t.Fatalf("IsoSessionName(%q) = (%q, %v), want (%q, %v)", tt.windowID, name, ok, tt.wantName, tt.wantOK)
			}
			if !ok {
				return
			}
			id, rok := WindowIDFromIsoSession(name)
			if !rok || id != tt.windowID {
				t.Errorf("WindowIDFromIsoSession(%q) = (%q, %v), want (%q, true)", name, id, rok, tt.windowID)
			}
		})
	}
}

func TestWindowIDFromIsoSession_Invalid(t *testing.T) {
	for _, name := range []string{"dev", "_rk-ctl", "_rk-iso-", "_rk-iso-abc", "_rk-pin-42", "rk-relay-x"} {
		if _, ok := WindowIDFromIsoSession(name); ok {
			t.Errorf("WindowIDFromIsoSession(%q) = ok, want not-ok", name)
		}
	}
}

func TestIsHiddenLinkSession(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"_rk-pin-42", true},
		{"_rk-iso-42", true},
		{"_rk-ctl", false},
		{"_rk-operator", false},
		{"dev", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := IsHiddenLinkSession(tt.name); got != tt.want {
			t.Errorf("IsHiddenLinkSession(%q) = %v, want %v", tt.name, got, tt.want)
		}
	}
}

// withBoardTmux starts an ephemeral tmux server with a single home session
// ("home") for board integration tests. Reuses withSessionOrderTmux's
// bootstrap, then renames the boot session to "home" so window moves have a
// stable home target.
func withBoardTmux(t *testing.T) string {
	t.Helper()
	server := withSessionOrderTmux(t)
	if err := RenameSession("boot", "home", server); err != nil {
		t.Fatalf("rename boot->home: %v", err)
	}
	return server
}

// createHomeWindow adds a window named `name` to the home session and returns
// its stable @N window id.
func createHomeWindow(t *testing.T, server, session, name string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := tmuxExecServer(ctx, server, "new-window", "-t", session, "-n", name, "-P", "-F", "#{window_id}"); err != nil {
		t.Fatalf("new-window %q: %v", name, err)
	}
	// Resolve the id by listing windows and matching the name (the -P output is
	// swallowed by tmuxExecServer line filtering in some shells; list is robust).
	windows, err := ListWindows(ctx, session, server)
	if err != nil {
		t.Fatalf("list windows: %v", err)
	}
	for _, w := range windows {
		if w.Name == name {
			return w.WindowID
		}
	}
	t.Fatalf("could not resolve window id for %q in %q", name, session)
	return ""
}

// windowsInSession returns the @N ids currently in a session (empty if the
// session does not exist).
func windowsInSession(t *testing.T, server, session string) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	windows, err := ListWindows(ctx, session, server)
	if err != nil {
		return nil
	}
	ids := make([]string, 0, len(windows))
	for _, w := range windows {
		ids = append(ids, w.WindowID)
	}
	return ids
}

func hasSession(t *testing.T, server, session string) bool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := tmuxExecRawServer(ctx, server, "has-session", "-t", session)
	return err == nil
}

func TestPin_LinksWindowAndStampsVars(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	pin, _ := PinSessionName(wid)

	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin: %v", err)
	}

	// Dual membership: the window STAYS in its home session (link, not move) so
	// the sidebar keeps showing it natively at its original position.
	inHome := false
	for _, id := range windowsInSession(t, server, "home") {
		if id == wid {
			inHome = true
		}
	}
	if !inHome {
		t.Errorf("window %s left its home session after Pin (should stay linked in home)", wid)
	}
	// The pin-session holds exactly the linked window (no placeholder).
	pinWindows := windowsInSession(t, server, pin)
	if len(pinWindows) != 1 || pinWindows[0] != wid {
		t.Fatalf("pin session windows = %v, want [%s] (single window, no placeholder)", pinWindows, wid)
	}
	// Membership vars are stamped.
	board, _ := showSessionOption(ctx, server, pin, BoardOption)
	home, _ := showSessionOption(ctx, server, pin, HomeOption)
	order, _ := showSessionOption(ctx, server, pin, BoardOrderOption)
	if board != "main" || home != "home" || !ValidOrderKey(order) {
		t.Errorf("vars: board=%q home=%q order=%q, want main/home/<valid key>", board, home, order)
	}

	// Derived entry matches.
	entries, err := ListBoardEntries(ctx, server)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].WindowID != wid || entries[0].Board != "main" {
		t.Fatalf("entries = %+v, want one main pin for %s", entries, wid)
	}
}

// Under dual membership, ResolveWindowSession must return the HOME (non-pin)
// session even though the pinned window is also a member of its `_rk-pin-*`
// session (tmux's naive pick across links is order-unspecified).
func TestResolveWindowSession_dualMembershipResolvesHome(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin: %v", err)
	}

	got, err := ResolveWindowSession(ctx, server, wid)
	if err != nil {
		t.Fatalf("ResolveWindowSession: %v", err)
	}
	if got != "home" {
		t.Errorf("ResolveWindowSession(%q) = %q, want %q (the non-pin home session)", wid, got, "home")
	}
}

// When the pin link is the window's ONLY link (home died while pinned), the
// window legitimately resolves to its pin-session.
func TestResolveWindowSession_lastLinkResolvesPinSession(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := CreateSession("temp", "", server); err != nil {
		t.Fatalf("create temp home: %v", err)
	}
	wid := createHomeWindow(t, server, "temp", "agent")
	pin, _ := PinSessionName(wid)
	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin: %v", err)
	}
	// Kill the home so the pin link is the window's only remaining link.
	if err := KillSession("temp", server); err != nil {
		t.Fatalf("kill home: %v", err)
	}

	got, err := ResolveWindowSession(ctx, server, wid)
	if err != nil {
		t.Fatalf("ResolveWindowSession: %v", err)
	}
	if got != pin {
		t.Errorf("ResolveWindowSession(%q) = %q, want %q (the pin-session is the sole link)", wid, got, pin)
	}
}

func TestPin_Idempotent(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	pin, _ := PinSessionName(wid)

	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin first: %v", err)
	}
	order1, _ := showSessionOption(ctx, server, pin, BoardOrderOption)

	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin second (idempotent): %v", err)
	}
	order2, _ := showSessionOption(ctx, server, pin, BoardOrderOption)
	if order1 != order2 {
		t.Errorf("order key churned on idempotent re-pin: %q -> %q", order1, order2)
	}
	pinWindows := windowsInSession(t, server, pin)
	if len(pinWindows) != 1 {
		t.Errorf("idempotent re-pin changed pin window count: %v", pinWindows)
	}
}

func TestPin_RePinToDifferentBoardRestamps(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	pin, _ := PinSessionName(wid)

	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin to main: %v", err)
	}
	// Re-pin the already-pinned window to a DIFFERENT board. This must re-stamp
	// @rk_ses_pin_board (not silently no-op leaving it on "main"), and must not move the
	// window or churn its pin-session.
	if err := Pin(ctx, server, wid, "deploy"); err != nil {
		t.Fatalf("Pin to deploy (re-pin): %v", err)
	}
	got, _ := showSessionOption(ctx, server, pin, BoardOption)
	if got != "deploy" {
		t.Errorf("re-pin to different board did not re-stamp @rk_ses_pin_board: got %q, want %q", got, "deploy")
	}
	pinWindows := windowsInSession(t, server, pin)
	if len(pinWindows) != 1 {
		t.Errorf("re-pin to different board changed pin window count: %v", pinWindows)
	}
}

func TestPin_AppendsMonotonicWithinBoard(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	w1 := createHomeWindow(t, server, "home", "a1")
	w2 := createHomeWindow(t, server, "home", "a2")
	if err := Pin(ctx, server, w1, "main"); err != nil {
		t.Fatal(err)
	}
	if err := Pin(ctx, server, w2, "main"); err != nil {
		t.Fatal(err)
	}
	entries, err := GetBoard(ctx, "main")
	if err != nil {
		t.Fatal(err)
	}
	var k1, k2 string
	for _, e := range entries {
		switch e.WindowID {
		case w1:
			k1 = e.OrderKey
		case w2:
			k2 = e.OrderKey
		}
	}
	if k1 == "" || k2 == "" || !(k1 < k2) {
		t.Errorf("expected k1 < k2, got k1=%q k2=%q", k1, k2)
	}
}

func TestUnpin_LeavesWindowInLiveHome(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	pin, _ := PinSessionName(wid)

	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin: %v", err)
	}
	if err := Unpin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Unpin: %v", err)
	}
	// Pin-session is gone (kill-session dropped the pin link).
	if hasSession(t, server, pin) {
		t.Errorf("pin session %s survived Unpin", pin)
	}
	// The window never left home (it was linked, not moved), so it is still there
	// after Unpin — no move-back, no append, no index churn.
	found := false
	for _, id := range windowsInSession(t, server, "home") {
		if id == wid {
			found = true
		}
	}
	if !found {
		t.Errorf("window %s missing from home after Unpin (should have stayed linked in home)", wid)
	}
}

func TestUnpin_RecreatesDeadHome(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Create a dedicated home, pin its window (dual membership: the window is now
	// linked into both "temp" and the pin-session), then kill "temp" so the pin
	// link becomes the window's LAST link — the recreate/last-link recovery path.
	if err := CreateSession("temp", "", server); err != nil {
		t.Fatalf("create temp home: %v", err)
	}
	wid := createHomeWindow(t, server, "temp", "agent")
	pin, _ := PinSessionName(wid)

	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin: %v", err)
	}
	// Kill the home session while the window is pinned. tmux keeps the window
	// alive because it is still linked in the pin-session — so the pin link is now
	// the window's only link (the last-link recovery case).
	if err := KillSession("temp", server); err != nil {
		t.Fatalf("kill home: %v", err)
	}
	if hasSession(t, server, "temp") {
		t.Fatalf("home session 'temp' still alive after kill")
	}

	if err := Unpin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Unpin (recreate home): %v", err)
	}
	// Home recreated with the linked window as its sole member; pin-session gone.
	if hasSession(t, server, pin) {
		t.Errorf("pin session %s survived Unpin recreate", pin)
	}
	if !hasSession(t, server, "temp") {
		t.Fatalf("home session 'temp' was not recreated")
	}
	ids := windowsInSession(t, server, "temp")
	if len(ids) != 1 || ids[0] != wid {
		t.Errorf("recreated home windows = %v, want [%s] (sole window, no placeholder)", ids, wid)
	}
	// The recreated home must not carry board membership vars.
	if b, _ := showSessionOption(ctx, server, "temp", BoardOption); b != "" {
		t.Errorf("recreated home retained @rk_ses_pin_board=%q", b)
	}
}

// unlinkWindowFromSession removes the window's link to a specific session
// (leaving its other links intact), simulating a legacy move-based pin where the
// window lives ONLY in the pin-session while its recorded home stays alive.
func unlinkWindowFromSession(t *testing.T, server, session, windowID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := tmuxExecRawServer(ctx, server, "unlink-window", "-t", exactWindowInSession(session, windowID)); err != nil {
		t.Fatalf("unlink %s from %s: %v", windowID, session, err)
	}
}

// A legacy move-based pin presents as the last-link case (the window is a member
// ONLY of its pin-session), but its recorded @rk_ses_pin_home may still be ALIVE. In that
// case Unpin must RESTORE the window into that live home (link it back, kill the
// pin-session) rather than stranding it in a stray `recovered<id>` session. Both
// other recovery tests kill the home first; this covers the untested live-home
// half of A-020.
func TestUnpin_LegacyPinLiveHomeRestoresIntoHome(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	pin, _ := PinSessionName(wid)

	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin: %v", err)
	}
	// Simulate a legacy move-based pin: strip the home link so the window lives
	// ONLY in the pin-session, while "home" stays alive (it keeps its boot window).
	// @rk_ses_pin_home still records "home".
	unlinkWindowFromSession(t, server, "home", wid)
	if home, ok, _ := resolveHomeSession(ctx, server, wid); ok {
		t.Fatalf("precondition: window still has a live non-pin home %q — expected last-link state", home)
	}
	if !hasSession(t, server, "home") {
		t.Fatalf("precondition: recorded home 'home' must still be alive")
	}

	if err := Unpin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Unpin (legacy pin, live home): %v", err)
	}
	// Pin-session gone.
	if hasSession(t, server, pin) {
		t.Errorf("pin session %s survived Unpin", pin)
	}
	// The window must land back in the LIVE home session — not a stray recovered<id>.
	found := false
	for _, id := range windowsInSession(t, server, "home") {
		if id == wid {
			found = true
		}
	}
	if !found {
		t.Errorf("window %s was not restored into its live home session after Unpin", wid)
	}
	recovered := "recovered" + strings.TrimPrefix(pin, PinSessionPrefix)
	if hasSession(t, server, recovered) {
		t.Errorf("Unpin created a stray recovered session %s instead of restoring into live home", recovered)
	}
}

func TestUnpin_BoardMismatchIsNoOp(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	pin, _ := PinSessionName(wid)

	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin to main: %v", err)
	}
	// Unpin with the WRONG board name must be a no-op success: the window stays
	// pinned to "main" and the pin-session survives (so the handler emits no
	// false board-changed event for "other").
	if err := Unpin(ctx, server, wid, "other"); err != nil {
		t.Fatalf("Unpin with mismatched board returned error, want no-op: %v", err)
	}
	if !hasSession(t, server, pin) {
		t.Errorf("mismatched-board Unpin removed the pin-session %s (should be a no-op)", pin)
	}
	if b, _ := showSessionOption(ctx, server, pin, BoardOption); b != "main" {
		t.Errorf("mismatched-board Unpin changed @rk_ses_pin_board to %q, want unchanged 'main'", b)
	}
	// The correct board name still unpins.
	if err := Unpin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Unpin with correct board: %v", err)
	}
	if hasSession(t, server, pin) {
		t.Errorf("pin-session %s survived a correct-board Unpin", pin)
	}
}

func TestUnpin_HomelessPinRecoversWindow(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Dedicated home so we can kill it to make the pin link the window's last link.
	if err := CreateSession("temp", "", server); err != nil {
		t.Fatalf("create temp home: %v", err)
	}
	wid := createHomeWindow(t, server, "temp", "agent")
	pin, _ := PinSessionName(wid)

	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin: %v", err)
	}
	// Simulate a legacy/corrupt pin-session that lost @rk_ses_pin_home (stamp-before-link
	// makes this unreachable in practice, but Unpin must still never strand a
	// window). Clear @rk_ses_pin_home, THEN kill the home so the pin link is the window's
	// last link (a live home membership would take the normal kill-session path
	// instead of recovery). With no home membership AND no @rk_ses_pin_home to re-derive
	// from, Unpin RECOVERS the window by renaming the pin-session to a `recovered*`
	// session — the window resurfaces in SESSIONS rather than being lost.
	if _, err := tmuxExecRawServer(ctx, server, "set-option", "-t", pin, "-u", HomeOption); err != nil {
		t.Fatalf("clear @rk_ses_pin_home: %v", err)
	}
	if err := KillSession("temp", server); err != nil {
		t.Fatalf("kill home: %v", err)
	}
	if err := Unpin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Unpin of @rk_ses_pin_home-less pin returned error, want recovery: %v", err)
	}
	if hasSession(t, server, pin) {
		t.Errorf("pin-session %s survived recovery Unpin", pin)
	}
	recovered := "recovered" + strings.TrimPrefix(pin, PinSessionPrefix)
	if !hasSession(t, server, recovered) {
		t.Fatalf("recovery session %s was not created — window may be stranded", recovered)
	}
	ids := windowsInSession(t, server, recovered)
	if len(ids) != 1 || ids[0] != wid {
		t.Errorf("recovered session windows = %v, want [%s]", ids, wid)
	}
	// The recovered session must carry no board membership (it's a plain session).
	if b, _ := showSessionOption(ctx, server, recovered, BoardOption); b != "" {
		t.Errorf("recovered session retained @rk_ses_pin_board=%q", b)
	}
}

// A stale `recovered<id>` session (left by a prior recovery of the same window
// id) must NOT make the recovery rename error and strand the window in the
// invisible pin-session: Unpin falls back to a suffixed name so the window still
// resurfaces under a visible session.
func TestUnpin_RecoveryNameCollisionFallsBackToSuffix(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := CreateSession("temp", "", server); err != nil {
		t.Fatalf("create temp home: %v", err)
	}
	wid := createHomeWindow(t, server, "temp", "agent")
	pin, _ := PinSessionName(wid)

	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin: %v", err)
	}
	// Force the @rk_ses_pin_home-empty recovery branch and kill the live home so the pin
	// link is the last link.
	if _, err := tmuxExecRawServer(ctx, server, "set-option", "-t", pin, "-u", HomeOption); err != nil {
		t.Fatalf("clear @rk_ses_pin_home: %v", err)
	}
	if err := KillSession("temp", server); err != nil {
		t.Fatalf("kill home: %v", err)
	}
	// Occupy the deterministic `recovered<id>` name with an unrelated stale session
	// so the rename would collide without the suffix fallback.
	recovered := "recovered" + strings.TrimPrefix(pin, PinSessionPrefix)
	if err := CreateSession(recovered, "", server); err != nil {
		t.Fatalf("create stale %s: %v", recovered, err)
	}

	if err := Unpin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Unpin must recover past a name collision, got error: %v", err)
	}
	// The pin-session is gone and the window resurfaced under the suffixed name.
	if hasSession(t, server, pin) {
		t.Errorf("pin-session %s survived collision recovery", pin)
	}
	suffixed := recovered + "-2"
	if !hasSession(t, server, suffixed) {
		t.Fatalf("collision fallback session %s was not created — window may be stranded", suffixed)
	}
	ids := windowsInSession(t, server, suffixed)
	if len(ids) != 1 || ids[0] != wid {
		t.Errorf("collision-recovered session windows = %v, want [%s]", ids, wid)
	}
}

func TestUnpin_Idempotent(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Unpin a window that was never pinned — no pin-session, silent success.
	if err := Unpin(ctx, server, "@9999", "main"); err != nil {
		t.Fatalf("unpin of never-pinned window: %v", err)
	}
}

func TestReorder_RewritesOnlyOneVar(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	w1 := createHomeWindow(t, server, "home", "a1")
	w2 := createHomeWindow(t, server, "home", "a2")
	if err := Pin(ctx, server, w1, "main"); err != nil {
		t.Fatal(err)
	}
	if err := Pin(ctx, server, w2, "main"); err != nil {
		t.Fatal(err)
	}
	pin2, _ := PinSessionName(w2)
	before2, _ := showSessionOption(ctx, server, pin2, BoardOrderOption)

	if err := Reorder(ctx, server, w1, "main", "z"); err != nil {
		t.Fatalf("Reorder: %v", err)
	}
	pin1, _ := PinSessionName(w1)
	after1, _ := showSessionOption(ctx, server, pin1, BoardOrderOption)
	after2, _ := showSessionOption(ctx, server, pin2, BoardOrderOption)
	if after1 != "z" {
		t.Errorf("reordered window key = %q, want z", after1)
	}
	if after2 != before2 {
		t.Errorf("sibling key changed: %q -> %q (no renumber expected)", before2, after2)
	}
}

func TestReorder_NotFound(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := Reorder(ctx, server, "@9999", "main", "a"); err == nil {
		t.Error("expected error for missing pin-session")
	}
}

func TestListBoardEntries_NoPinsReturnsEmpty(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	got, err := ListBoardEntries(ctx, server)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %v, want empty", got)
	}
}

func TestEmptyBoardVanishesOnLastUnpin(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "only")
	if err := Pin(ctx, server, wid, "deploy"); err != nil {
		t.Fatal(err)
	}
	// Board exists while the pin exists (filter to our server's entries).
	entries, err := ListBoardEntries(ctx, server)
	if err != nil {
		t.Fatal(err)
	}
	foundDeploy := false
	for _, e := range entries {
		if e.Board == "deploy" {
			foundDeploy = true
		}
	}
	if !foundDeploy {
		t.Fatalf("board 'deploy' not derived while pin exists")
	}

	if err := Unpin(ctx, server, wid, "deploy"); err != nil {
		t.Fatal(err)
	}
	// After the last unpin, no pin carries @rk_ses_pin_board=deploy on this server.
	entries2, err := ListBoardEntries(ctx, server)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries2 {
		if e.Board == "deploy" {
			t.Errorf("board 'deploy' still derived after last unpin: %+v", e)
		}
	}
}

// TestPin_PinSessionPathIsHome proves the pin-session session_path hygiene
// (change 260720-ji0k): the `_rk-pin-*` session is created with
// `-c ServerBirthDir()`, so its session_path is the operator's home — not the
// live tmux SERVER's own CWD (the board test server is birthed from the
// package dir, so a missing -c fails the assertion).
func TestPin_PinSessionPathIsHome(t *testing.T) {
	server := withBoardTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	wid := createHomeWindow(t, server, "home", "agent")
	pin, _ := PinSessionName(wid)

	if err := Pin(ctx, server, wid, "main"); err != nil {
		t.Fatalf("Pin: %v", err)
	}

	got := mustEvalSymlinks(t, sessionPathOf(t, server, pin))
	want := mustEvalSymlinks(t, ServerBirthDir())
	if got != want {
		t.Errorf("pin session_path = %q, want %q (must never dangle)", got, want)
	}
}
