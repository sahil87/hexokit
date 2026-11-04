package tmux

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"rk/internal/present"
)

// webHeld reads a web-family option on the test server's window (thin wrapper
// over legacyHeld's show-options -qv pattern).
func webHeld(t *testing.T, server, id, option string) (string, bool) {
	t.Helper()
	return legacyHeld(t, server, "-w", "-t", id, option)
}

func webMustHeld(t *testing.T, server, id, option, want string) {
	t.Helper()
	if v, ok := webHeld(t, server, id, option); !ok || v != want {
		t.Errorf("%s = %q (held=%v), want %q", option, v, ok, want)
	}
}

func webMustUnset(t *testing.T, server, id, option string) {
	t.Helper()
	if v, ok := webHeld(t, server, id, option); ok {
		t.Errorf("%s = %q, want unset", option, v)
	}
}

// pinWebNow swaps the webNowFn seam for the duration of a test.
func pinWebNow(t *testing.T, now int64) {
	t.Helper()
	orig := webNowFn
	webNowFn = func() int64 { return now }
	t.Cleanup(func() { webNowFn = orig })
}

// seedWebFamily writes a web family directly (setup for remove/select tests,
// which must not depend on WebAdd under test).
func seedWebFamily(t *testing.T, server, id string, tabs, roots []string, active int) {
	t.Helper()
	for i, tab := range tabs {
		legacyTmuxDo(t, server, "set-option", "-w", "-t", id, WebTabOption(i+1), tab)
	}
	for i, root := range roots {
		if root != "" {
			legacyTmuxDo(t, server, "set-option", "-w", "-t", id, WebTabRootOption(i+1), root)
		}
	}
	if active > 0 {
		legacyTmuxDo(t, server, "set-option", "-w", "-t", id, WebActiveOption, strconv.Itoa(active))
	}
}

func TestWebAddEmptyFamily(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	n, existed, err := WebAdd(context.Background(), id, server, "/proxy/3000/", "")
	if err != nil {
		t.Fatalf("WebAdd: %v", err)
	}
	if n != 1 || existed {
		t.Errorf("WebAdd = (%d, %v), want (1, false)", n, existed)
	}
	webMustHeld(t, server, id, WebTabOption(1), "/proxy/3000/")
	webMustHeld(t, server, id, WebActiveOption, "1")
}

// A window whose only web state is the retired @rk_win_url (never swept — the
// frontend polls it mid-session) surfaces as a one-tab family via the
// dual-read fallback, and WebRemove on that tab clears the retired source too
// — otherwise the emptied family would resurrect the URL on the next read.
func TestWebRemoveClearsLegacyURLDualRead(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, legacyWinURLOption, "http://localhost:8080/")

	fam, err := ReadWebTabFamily(context.Background(), id, server)
	if err != nil {
		t.Fatalf("ReadWebTabFamily: %v", err)
	}
	if len(fam.Tabs) != 1 || fam.Tabs[0] != "http://localhost:8080/" {
		t.Fatalf("family = %v, want one dual-read tab", fam.Tabs)
	}
	if fam.Active != 1 {
		t.Errorf("Active = %d, want 1 (defaulted for the dual-read tab)", fam.Active)
	}

	if err := WebRemove(context.Background(), id, server, 1); err != nil {
		t.Fatalf("WebRemove: %v", err)
	}
	webMustUnset(t, server, id, legacyWinURLOption)
	webMustUnset(t, server, id, WebTabOption(1))
	webMustUnset(t, server, id, WebActiveOption)
}

func TestWebAddSecondTabKeepsActive(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	if _, _, err := WebAdd(context.Background(), id, server, "/proxy/3000/", ""); err != nil {
		t.Fatalf("WebAdd 1: %v", err)
	}
	n, existed, err := WebAdd(context.Background(), id, server, "https://x/", "")
	if err != nil {
		t.Fatalf("WebAdd 2: %v", err)
	}
	if n != 2 || existed {
		t.Errorf("WebAdd = (%d, %v), want (2, false)", n, existed)
	}
	webMustHeld(t, server, id, WebTabOption(2), "https://x/")
	webMustHeld(t, server, id, WebActiveOption, "1") // add is not show
}

func TestWebAddIdempotent(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	if _, _, err := WebAdd(context.Background(), id, server, "/proxy/3000/", ""); err != nil {
		t.Fatalf("WebAdd: %v", err)
	}
	n, existed, err := WebAdd(context.Background(), id, server, "/proxy/3000/", "")
	if err != nil {
		t.Fatalf("WebAdd re-add: %v", err)
	}
	if n != 1 || !existed {
		t.Errorf("WebAdd re-add = (%d, %v), want (1, true)", n, existed)
	}
	webMustUnset(t, server, id, WebTabOption(2)) // no duplicate append
}

func TestWebAddIdempotentPresentBumpsVersion(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	if _, _, err := WebAdd(context.Background(), id, server, "/proxy/1/", ""); err != nil {
		t.Fatalf("WebAdd 1: %v", err)
	}
	pinWebNow(t, 100)
	stored := "/present/@5/2/a.html?server=s&v=100"
	if _, _, err := WebAdd(context.Background(), id, server, stored, ""); err != nil {
		t.Fatalf("WebAdd 2: %v", err)
	}
	pinWebNow(t, 200)
	n, existed, err := WebAdd(context.Background(), id, server, stored, "")
	if err != nil {
		t.Fatalf("WebAdd re-add: %v", err)
	}
	if n != 2 || !existed {
		t.Errorf("WebAdd re-add = (%d, %v), want (2, true)", n, existed)
	}
	webMustHeld(t, server, id, WebTabOption(2), "/present/@5/2/a.html?server=s&v=200")
	webMustHeld(t, server, id, WebActiveOption, "1") // the bump never moves the pointer
}

func TestPresentTargetIdentityFailsClosed(t *testing.T) {
	for _, raw := range []string{
		"/present/runKit",             // no second segment at all
		"/present/runKit/",            // segmentless remainder — no usable hash
		"/present/runKit/?v=1",        // same, with plumbing query
		"/present/runKit//index.html", // empty hash segment
		"/board/runKit",               // not a /present/ URL
		"http://[::1]:namedport/x",    // unparseable
	} {
		if id, ok := presentTargetIdentity(raw); ok {
			t.Errorf("presentTargetIdentity(%q) = (%q, true), want ok=false", raw, id)
		}
	}
	if _, ok := presentTargetIdentity("/present/runKit/a1b2c3d4e5f6/report.html?v=1"); !ok {
		t.Error("presentTargetIdentity(valid new form) ok = false, want true")
	}
}

func TestWebAddIdempotentDegeneratePresentNoPanic(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	// A stored /present/ URL whose identity fails to parse (segmentless
	// remainder) re-added verbatim matches via the stored==incoming fast path;
	// the hit must bump in place, not panic on the empty identities.
	pinWebNow(t, 100)
	stored := "/present/runKit/?v=100"
	if _, _, err := WebAdd(context.Background(), id, server, stored, ""); err != nil {
		t.Fatalf("WebAdd: %v", err)
	}
	pinWebNow(t, 200)
	n, existed, err := WebAdd(context.Background(), id, server, stored, "")
	if err != nil {
		t.Fatalf("WebAdd re-add: %v", err)
	}
	if n != 1 || !existed {
		t.Errorf("WebAdd re-add = (%d, %v), want (1, true)", n, existed)
	}
	webMustHeld(t, server, id, WebTabOption(1), "/present/runKit/?v=200")
}

func TestWebAddRootWritten(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	if _, _, err := WebAdd(context.Background(), id, server, "/present/@5/1/a.html?server=s&v=1", "/tmp/root"); err != nil {
		t.Fatalf("WebAdd: %v", err)
	}
	webMustHeld(t, server, id, WebTabRootOption(1), "/tmp/root")
}

func TestWebAddFull(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	for n := 1; n <= MaxWebTabs; n++ {
		if _, _, err := WebAdd(context.Background(), id, server, "/proxy/300"+strconv.Itoa(n)+"/", ""); err != nil {
			t.Fatalf("WebAdd %d: %v", n, err)
		}
	}
	_, _, err := WebAdd(context.Background(), id, server, "/proxy/9999/", "")
	if !errors.Is(err, ErrWebTabsFull) {
		t.Fatalf("WebAdd on a full family: err = %v, want ErrWebTabsFull", err)
	}
	// The family is untouched.
	webMustHeld(t, server, id, WebTabOption(MaxWebTabs), "/proxy/300"+strconv.Itoa(MaxWebTabs)+"/")
}

func TestWebRemoveMiddleShiftsURLAndRoot(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	// 3 tabs, roots on 1 and 3, active on the last tab.
	seedWebFamily(t, server, id,
		[]string{"/proxy/1/", "/proxy/2/", "/proxy/3/"},
		[]string{"/r1", "", "/r3"}, 3)

	if err := WebRemove(context.Background(), id, server, 2); err != nil {
		t.Fatalf("WebRemove: %v", err)
	}

	webMustHeld(t, server, id, WebTabOption(1), "/proxy/1/")
	webMustHeld(t, server, id, WebTabRootOption(1), "/r1")
	webMustHeld(t, server, id, WebTabOption(2), "/proxy/3/") // former slot 3 lands in slot 2
	webMustHeld(t, server, id, WebTabRootOption(2), "/r3")   // root moves with its URL
	webMustUnset(t, server, id, WebTabOption(3))
	webMustUnset(t, server, id, WebTabRootOption(3))
	webMustHeld(t, server, id, WebActiveOption, "2") // active was on the shifted tab
}

// TestWebRemoveRepointActive covers the three active-pointer relations on
// fresh windows: active < n stays, active == n becomes min(n, newLen),
// active > n steps down by one.
func TestWebRemoveRepointActive(t *testing.T) {
	server := withSessionOrderTmux(t)

	tests := []struct {
		name       string
		active     int
		remove     int
		wantActive string
	}{
		{"active before removed stays", 1, 2, "1"},
		{"active on removed middle stays at slot", 2, 2, "2"},
		{"active on removed last steps back", 3, 3, "2"},
		{"active after removed steps down", 3, 1, "2"},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			legacyTmuxDo(t, server, "new-window", "-d", "-t", "=boot:")
			id := windowID(t, server, "boot:"+strconv.Itoa(i+1))
			seedWebFamily(t, server, id,
				[]string{"/proxy/1/", "/proxy/2/", "/proxy/3/"}, nil, tt.active)

			if err := WebRemove(context.Background(), id, server, tt.remove); err != nil {
				t.Fatalf("WebRemove(%d): %v", tt.remove, err)
			}
			webMustHeld(t, server, id, WebActiveOption, tt.wantActive)
		})
	}
}

func TestWebRemoveLastUnsetsActive(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	seedWebFamily(t, server, id, []string{"/proxy/1/"}, nil, 1)

	if err := WebRemove(context.Background(), id, server, 1); err != nil {
		t.Fatalf("WebRemove: %v", err)
	}
	webMustUnset(t, server, id, WebTabOption(1))
	webMustUnset(t, server, id, WebActiveOption)
}

func TestWebRemoveRange(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	// Empty family: any n is out of range.
	if err := WebRemove(context.Background(), id, server, 1); !errors.Is(err, ErrWebTabRange) {
		t.Errorf("WebRemove on empty family: err = %v, want ErrWebTabRange", err)
	}
	seedWebFamily(t, server, id, []string{"/proxy/1/", "/proxy/2/"}, nil, 1)
	for _, n := range []int{0, 3, -1} {
		if err := WebRemove(context.Background(), id, server, n); !errors.Is(err, ErrWebTabRange) {
			t.Errorf("WebRemove(%d): err = %v, want ErrWebTabRange", n, err)
		}
	}
	// The failed removes wrote nothing.
	webMustHeld(t, server, id, WebTabOption(2), "/proxy/2/")
}

func TestWebSelect(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	seedWebFamily(t, server, id, []string{"/proxy/1/", "/proxy/2/"}, nil, 1)

	if err := WebSelect(context.Background(), id, server, 2); err != nil {
		t.Fatalf("WebSelect(2): %v", err)
	}
	webMustHeld(t, server, id, WebActiveOption, "2")

	for _, n := range []int{0, 3} {
		if err := WebSelect(context.Background(), id, server, n); !errors.Is(err, ErrWebTabRange) {
			t.Errorf("WebSelect(%d): err = %v, want ErrWebTabRange", n, err)
		}
	}
	webMustHeld(t, server, id, WebActiveOption, "2") // failed selects wrote nothing
}

// Active follows the moved slot's identity: [A,B,C] with active on C, moving
// slot 1 (A) to position 3 yields [B,C,A] and the pointer lands on C's new
// slot 2. Roots move alongside their URLs.
func TestWebMoveActiveFollowsIdentity(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	seedWebFamily(t, server, id,
		[]string{"/proxy/1/", "/proxy/2/", "/proxy/3/"},
		[]string{"/r1", "", "/r3"}, 3)

	if err := WebMove(context.Background(), id, server, 1, 3); err != nil {
		t.Fatalf("WebMove: %v", err)
	}
	webMustHeld(t, server, id, WebTabOption(1), "/proxy/2/")
	webMustUnset(t, server, id, WebTabRootOption(1))
	webMustHeld(t, server, id, WebTabOption(2), "/proxy/3/")
	webMustHeld(t, server, id, WebTabRootOption(2), "/r3")
	webMustHeld(t, server, id, WebTabOption(3), "/proxy/1/")
	webMustHeld(t, server, id, WebTabRootOption(3), "/r1")
	webMustHeld(t, server, id, WebActiveOption, "2") // C, still the third URL
}

func TestWebMoveBackward(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	seedWebFamily(t, server, id,
		[]string{"/proxy/1/", "/proxy/2/", "/proxy/3/"}, nil, 1)

	if err := WebMove(context.Background(), id, server, 3, 1); err != nil {
		t.Fatalf("WebMove: %v", err)
	}
	webMustHeld(t, server, id, WebTabOption(1), "/proxy/3/")
	webMustHeld(t, server, id, WebTabOption(2), "/proxy/1/")
	webMustHeld(t, server, id, WebTabOption(3), "/proxy/2/")
	webMustHeld(t, server, id, WebActiveOption, "2") // A followed to slot 2
}

func TestWebMoveRange(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	seedWebFamily(t, server, id, []string{"/proxy/1/", "/proxy/2/"}, nil, 1)

	for _, mv := range [][2]int{{0, 1}, {3, 1}, {1, 0}, {1, 3}, {-1, 1}, {1, -1}} {
		if err := WebMove(context.Background(), id, server, mv[0], mv[1]); !errors.Is(err, ErrWebTabRange) {
			t.Errorf("WebMove(%d, %d): err = %v, want ErrWebTabRange", mv[0], mv[1], err)
		}
	}
	// The failed moves wrote nothing.
	webMustHeld(t, server, id, WebTabOption(2), "/proxy/2/")
	webMustHeld(t, server, id, WebActiveOption, "1")
}

func TestShiftWebTabs(t *testing.T) {
	tests := []struct {
		name              string
		tabs, roots       []string
		n                 int
		wantTabs, wantRts []string
	}{
		{
			name: "middle of three", tabs: []string{"a", "b", "c"}, roots: []string{"r1", "", "r3"}, n: 2,
			wantTabs: []string{"a", "c"}, wantRts: []string{"r1", "r3"},
		},
		{
			name: "middle slot carries the root", tabs: []string{"a", "b", "c"}, roots: []string{"", "r2", ""}, n: 1,
			wantTabs: []string{"b", "c"}, wantRts: []string{"r2", ""},
		},
		{
			name: "first", tabs: []string{"a", "b"}, roots: nil, n: 1,
			wantTabs: []string{"b"}, wantRts: []string{""},
		},
		{
			name: "last", tabs: []string{"a", "b"}, roots: []string{"r1", "r2"}, n: 2,
			wantTabs: []string{"a"}, wantRts: []string{"r1"},
		},
		{
			name: "only tab", tabs: []string{"a"}, roots: []string{"r1"}, n: 1,
			wantTabs: []string{}, wantRts: []string{},
		},
		{
			name: "short roots tolerated", tabs: []string{"a", "b", "c"}, roots: []string{"r1"}, n: 1,
			wantTabs: []string{"b", "c"}, wantRts: []string{"", ""},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotTabs, gotRoots := shiftWebTabs(tt.tabs, tt.roots, tt.n)
			if strings.Join(gotTabs, ",") != strings.Join(tt.wantTabs, ",") {
				t.Errorf("tabs = %v, want %v", gotTabs, tt.wantTabs)
			}
			if strings.Join(gotRoots, ",") != strings.Join(tt.wantRts, ",") {
				t.Errorf("roots = %v, want %v", gotRoots, tt.wantRts)
			}
		})
	}
}

func TestRepointActive(t *testing.T) {
	tests := []struct {
		name              string
		active, n, newLen int
		want              int
	}{
		{"empty family unsets", 1, 1, 0, 0},
		{"active on removed middle keeps slot", 2, 2, 2, 2},
		{"active on removed last steps back", 3, 3, 2, 2},
		{"active after removed steps down", 3, 1, 2, 2},
		{"active before removed unchanged", 1, 2, 2, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := repointActive(tt.active, tt.n, tt.newLen); got != tt.want {
				t.Errorf("repointActive(%d, %d, %d) = %d, want %d", tt.active, tt.n, tt.newLen, got, tt.want)
			}
		})
	}
}

// A self-move succeeds without touching the family (no write at all).
func TestWebMoveNoOp(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	seedWebFamily(t, server, id, []string{"/proxy/1/", "/proxy/2/"}, nil, 1)

	if err := WebMove(context.Background(), id, server, 2, 2); err != nil {
		t.Fatalf("WebMove(2, 2): %v", err)
	}
	webMustHeld(t, server, id, WebTabOption(1), "/proxy/1/")
	webMustHeld(t, server, id, WebActiveOption, "1")
}

func TestMoveWebTabs(t *testing.T) {
	tests := []struct {
		name              string
		tabs, roots       []string
		n, to             int
		wantTabs, wantRts []string
	}{
		{
			name: "forward past both", tabs: []string{"a", "b", "c"}, roots: []string{"r1", "", "r3"}, n: 1, to: 3,
			wantTabs: []string{"b", "c", "a"}, wantRts: []string{"", "r3", "r1"},
		},
		{
			name: "one step forward", tabs: []string{"a", "b", "c"}, n: 1, to: 2,
			wantTabs: []string{"b", "a", "c"}, wantRts: []string{"", "", ""},
		},
		{
			name: "backward to first", tabs: []string{"a", "b", "c"}, n: 3, to: 1,
			wantTabs: []string{"c", "a", "b"}, wantRts: []string{"", "", ""},
		},
		{
			name: "root rides with its URL", tabs: []string{"a", "b", "c"}, roots: []string{"", "r2", ""}, n: 2, to: 3,
			wantTabs: []string{"a", "c", "b"}, wantRts: []string{"", "", "r2"},
		},
		{
			name: "short roots tolerated", tabs: []string{"a", "b", "c"}, roots: []string{"r1"}, n: 1, to: 3,
			wantTabs: []string{"b", "c", "a"}, wantRts: []string{"", "", "r1"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotTabs, gotRoots := moveWebTabs(tt.tabs, tt.roots, tt.n, tt.to)
			if strings.Join(gotTabs, ",") != strings.Join(tt.wantTabs, ",") {
				t.Errorf("tabs = %v, want %v", gotTabs, tt.wantTabs)
			}
			if strings.Join(gotRoots, ",") != strings.Join(tt.wantRts, ",") {
				t.Errorf("roots = %v, want %v", gotRoots, tt.wantRts)
			}
		})
	}
}

func TestRepointMoveActive(t *testing.T) {
	tests := []struct {
		name          string
		active, n, to int
		want          int
	}{
		{"moved tab lands at to", 1, 1, 3, 3},
		{"shifted down by a forward move", 3, 1, 3, 2},
		{"shifted up by a backward move", 1, 3, 1, 2},
		{"active outside the moved span stays", 4, 1, 3, 4},
		{"to boundary of the span shifts", 2, 3, 2, 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := repointMoveActive(tt.active, tt.n, tt.to); got != tt.want {
				t.Errorf("repointMoveActive(%d, %d, %d) = %d, want %d", tt.active, tt.n, tt.to, got, tt.want)
			}
		})
	}
}

// TestWebTabOptionRange pins the 1..MaxWebTabs programming contract: inside
// the range the names are the indexed family; outside it the functions panic
// (callers validate user input first).
func TestWebTabOptionRange(t *testing.T) {
	if got := WebTabOption(1); got != "@rk_win_web_1" {
		t.Errorf("WebTabOption(1) = %q", got)
	}
	if got := WebTabOption(MaxWebTabs); got != "@rk_win_web_"+strconv.Itoa(MaxWebTabs) {
		t.Errorf("WebTabOption(%d) = %q", MaxWebTabs, got)
	}
	if got := WebTabRootOption(3); got != "@rk_win_web_3_root" {
		t.Errorf("WebTabRootOption(3) = %q", got)
	}
	for _, n := range []int{0, -1, MaxWebTabs + 1} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("WebTabOption(%d) did not panic", n)
				}
			}()
			WebTabOption(n)
		}()
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("WebTabRootOption(%d) did not panic", n)
				}
			}()
			WebTabRootOption(n)
		}()
	}
}

// TestWebAddPresentIdentityAcrossSlotsAndVersions pins the re-present
// contract: a /present/ target computed fresh (different slot index, different
// v=) still hits the existing slot by target identity, and the hit bumps the
// STORED url's v= (keeping the slot's own index in the path).
func TestWebAddPresentIdentityAcrossSlotsAndVersions(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	seedWebFamily(t, server, id,
		[]string{"/proxy/1/", "/present/@5/2/a.html?server=s&v=100"},
		nil, 2)

	pinWebNow(t, 300)
	// The caller computes the URL for a FRESH slot (3) with a fresh v=.
	n, existed, err := WebAdd(context.Background(), id, server, "/present/@5/3/a.html?server=s&v=300", "")
	if err != nil {
		t.Fatalf("WebAdd: %v", err)
	}
	if n != 2 || !existed {
		t.Errorf("WebAdd = (%d, %v), want (2, true) — target identity must span slot and v=", n, existed)
	}
	webMustHeld(t, server, id, WebTabOption(2), "/present/@5/2/a.html?server=s&v=300")
	webMustUnset(t, server, id, WebTabOption(3)) // no duplicate append
	webMustHeld(t, server, id, WebActiveOption, "2")
}

// TestWebAddPresentDistinctTargetsNoFalseMatch: same window+name but a
// different server query is a different target (appends), and a /proxy/ URL
// never identity-matches a /present/ one.
func TestWebAddPresentDistinctTargetsNoFalseMatch(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	seedWebFamily(t, server, id, []string{"/present/@5/1/a.html?server=s&v=100"}, nil, 1)

	n, existed, err := WebAdd(context.Background(), id, server, "/present/@5/2/a.html?server=other&v=200", "")
	if err != nil {
		t.Fatalf("WebAdd: %v", err)
	}
	if n != 2 || existed {
		t.Errorf("WebAdd = (%d, %v), want (2, false) — a different server is a different target", n, existed)
	}
	webMustHeld(t, server, id, WebTabOption(1), "/present/@5/1/a.html?server=s&v=100")
}

// TestWebAddPresentDistinctRootsAppend: two directory targets share one URL
// identity (a dir URL has no name segment), so the serve root must split them
// into two tabs — and the first tab's root must survive untouched.
func TestWebAddPresentDistinctRootsAppend(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	pinWebNow(t, 100)
	if _, _, err := WebAdd(context.Background(), id, server, "/present/@5/1/?server=s&v=100", "/tmp/a"); err != nil {
		t.Fatalf("WebAdd a: %v", err)
	}
	pinWebNow(t, 200)
	n, existed, err := WebAdd(context.Background(), id, server, "/present/@5/2/?server=s&v=200", "/tmp/b")
	if err != nil {
		t.Fatalf("WebAdd b: %v", err)
	}
	if n != 2 || existed {
		t.Errorf("WebAdd b = (%d, %v), want (2, false) — a different root is a different target", n, existed)
	}
	webMustHeld(t, server, id, WebTabOption(1), "/present/@5/1/?server=s&v=100")
	webMustHeld(t, server, id, WebTabRootOption(1), "/tmp/a")
	webMustHeld(t, server, id, WebTabRootOption(2), "/tmp/b")

	// Re-presenting the first directory hits slot 1 (bump only), not slot 2.
	pinWebNow(t, 300)
	n, existed, err = WebAdd(context.Background(), id, server, "/present/@5/3/?server=s&v=300", "/tmp/a")
	if err != nil {
		t.Fatalf("WebAdd a again: %v", err)
	}
	if n != 1 || !existed {
		t.Errorf("WebAdd a again = (%d, %v), want (1, true)", n, existed)
	}
	webMustHeld(t, server, id, WebTabOption(1), "/present/@5/1/?server=s&v=300")
	webMustHeld(t, server, id, WebTabRootOption(2), "/tmp/b")
	webMustUnset(t, server, id, WebTabOption(3))
}

// TestWebAddPresentEmptyStoredRootAdopts: a slot with no root (the @rk_win_url
// dual-read path) still identity-matches by URL, and the hit writes the
// incoming root so the slot stops serving from nowhere.
func TestWebAddPresentEmptyStoredRootAdopts(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	seedWebFamily(t, server, id, []string{"/present/@5/1/a.html?server=s&v=100"}, nil, 1)

	pinWebNow(t, 200)
	n, existed, err := WebAdd(context.Background(), id, server, "/present/@5/2/a.html?server=s&v=200", "/tmp/root")
	if err != nil {
		t.Fatalf("WebAdd: %v", err)
	}
	if n != 1 || !existed {
		t.Errorf("WebAdd = (%d, %v), want (1, true)", n, existed)
	}
	webMustHeld(t, server, id, WebTabOption(1), "/present/@5/1/a.html?server=s&v=200")
	webMustHeld(t, server, id, WebTabRootOption(1), "/tmp/root")
}

// TestWebAddPresentUpgradeOnRePresent pins the upgrade-on-re-present path
// (R6): a slot stored in the LEGACY form identity-matches an incoming
// NEW-form URL by target identity, the hit is idempotent (same slot, no
// append), and the stored value is REWRITTEN to the incoming new-form URL
// with its fresh ?v= — no BumpVersion of the legacy shape.
func TestWebAddPresentUpgradeOnRePresent(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	seedWebFamily(t, server, id,
		[]string{"/proxy/1/", "/present/@5/2/report.html?server=s&v=100"},
		[]string{"", "/tmp/root"}, 2)

	// Re-present the same file under the same root — now composing the new
	// (server, roothash) form with a fresh buster.
	newURL := "/present/s/" + present.RootHash("/tmp/root") + "/report.html?v=300"
	n, existed, err := WebAdd(context.Background(), id, server, newURL, "/tmp/root")
	if err != nil {
		t.Fatalf("WebAdd: %v", err)
	}
	if n != 2 || !existed {
		t.Errorf("WebAdd = (%d, %v), want (2, true) — cross-form identity must hit the existing slot", n, existed)
	}
	webMustHeld(t, server, id, WebTabOption(2), newURL)
	webMustUnset(t, server, id, WebTabOption(3)) // no duplicate append
	webMustHeld(t, server, id, WebTabRootOption(2), "/tmp/root")
	webMustHeld(t, server, id, WebActiveOption, "2")
}

// TestWebAddPresentSameFormNewBumps: a same-form (new → new) re-present keeps
// the BumpVersion path — the stored new-form URL's v= refreshes in place.
func TestWebAddPresentSameFormNewBumps(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	stored := "/present/s/" + present.RootHash("/tmp/root") + "/report.html?v=100"
	seedWebFamily(t, server, id, []string{stored}, []string{"/tmp/root"}, 1)

	pinWebNow(t, 200)
	n, existed, err := WebAdd(context.Background(), id, server, stored, "/tmp/root")
	if err != nil {
		t.Fatalf("WebAdd: %v", err)
	}
	if n != 1 || !existed {
		t.Errorf("WebAdd = (%d, %v), want (1, true)", n, existed)
	}
	webMustHeld(t, server, id, WebTabOption(1), "/present/s/"+present.RootHash("/tmp/root")+"/report.html?v=200")
	webMustUnset(t, server, id, WebTabOption(2))
}

// TestListDeclaredWebRoots pins the server-wide declared-root enumeration: a
// root declared by any window shows up once regardless of slot, duplicates
// across windows collapse, and empty slots never appear.
func TestListDeclaredWebRoots(t *testing.T) {
	server := withSessionOrderTmux(t)
	idA := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "new-window", "-d", "-t", "=boot:")
	legacyTmuxDo(t, server, "new-window", "-d", "-t", "=boot:")
	idB := windowID(t, server, "boot:1")
	idC := windowID(t, server, "boot:2")

	// idA declares /r1 in slots 1 and 2; idB re-declares /r1 and adds /r2;
	// idC declares nothing. Killing idB leaves idA's /r1 still live.
	legacyTmuxDo(t, server, "set-option", "-w", "-t", idA, WebTabRootOption(1), "/r1")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", idA, WebTabRootOption(2), "/r1")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", idB, WebTabRootOption(1), "/r1")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", idB, WebTabRootOption(2), "/r2")

	roots, err := ListDeclaredWebRoots(context.Background(), server)
	if err != nil {
		t.Fatalf("ListDeclaredWebRoots: %v", err)
	}
	if got, want := strings.Join(roots, ","), "/r1,/r2"; got != want {
		t.Errorf("roots = %v, want %v", roots, want)
	}
	_ = idC

	legacyTmuxDo(t, server, "kill-window", "-t", idB)
	roots, err = ListDeclaredWebRoots(context.Background(), server)
	if err != nil {
		t.Fatalf("ListDeclaredWebRoots after kill-window: %v", err)
	}
	if got, want := strings.Join(roots, ","), "/r1"; got != want {
		t.Errorf("roots = %v, want %v (the surviving window still declares /r1)", roots, want)
	}

	legacyTmuxDo(t, server, "kill-window", "-t", idA)
	roots, err = ListDeclaredWebRoots(context.Background(), server)
	if err != nil {
		t.Fatalf("ListDeclaredWebRoots after clearing all: %v", err)
	}
	if len(roots) != 0 {
		t.Errorf("roots = %v, want empty once no window declares anything", roots)
	}
}

func TestShowWindowOptions(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	// Nothing set: an empty (non-nil) map, not an error.
	opts, err := ShowWindowOptions(context.Background(), id, server)
	if err != nil {
		t.Fatalf("ShowWindowOptions on an unset window: %v", err)
	}
	if opts == nil || len(opts) != 0 {
		t.Errorf("ShowWindowOptions = %v, want empty", opts)
	}

	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, LayoutOption, "split-h:tty,web")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, WebTabOption(1), "/proxy/8080/")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, "@rk_ses_foreign", "x") // wrong scope token on a window option

	opts, err = ShowWindowOptions(context.Background(), id, server)
	if err != nil {
		t.Fatalf("ShowWindowOptions: %v", err)
	}
	if len(opts) != 2 {
		t.Fatalf("ShowWindowOptions = %v, want exactly the two @rk_win_ options", opts)
	}
	if opts[LayoutOption] != "split-h:tty,web" || opts[WebTabOption(1)] != "/proxy/8080/" {
		t.Errorf("ShowWindowOptions = %v", opts)
	}
}
