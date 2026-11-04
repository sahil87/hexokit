package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"log/slog"

	"rk/internal/sessions"
	"rk/internal/tmux"
)

// --- Cross-tab layout verb tests (POST /api/layout/borrow, /api/layout/return) ---

func layoutFetcher(windows ...tmux.WindowInfo) *mockSessionFetcher {
	return &mockSessionFetcher{result: []sessions.ProjectSession{{Name: "s", Windows: windows}}}
}

func postLayoutVerb(t *testing.T, sf SessionFetcher, ops *mockTmuxOps, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	router := newTestRouter(sf, ops)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestLayoutBorrowUnheldWritesOnlyTarget(t *testing.T) {
	ops := &mockTmuxOps{}
	sf := layoutFetcher(
		tmux.WindowInfo{WindowID: "@3", Layout: "tty"},
		tmux.WindowInfo{WindowID: "@9", Layout: "tty"},
	)
	rec := postLayoutVerb(t, sf, ops, "/api/layout/borrow", `{"to":"@9","leaf":"@3/tty","tree":"h(tty,@3/tty)"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	want := []tmux.WindowLayoutWrite{{WindowID: "@9", Layout: "h(tty,@3/tty)"}}
	if fmt.Sprint(ops.setWindowLayoutsPairs) != fmt.Sprint(want) {
		t.Errorf("pairs = %+v, want %+v (no holder — only the target is written)", ops.setWindowLayoutsPairs, want)
	}
}

func TestLayoutBorrowFromHolderChainsBothWrites(t *testing.T) {
	ops := &mockTmuxOps{}
	sf := layoutFetcher(
		tmux.WindowInfo{WindowID: "@3", Layout: "tty"},
		tmux.WindowInfo{WindowID: "@7", Layout: "h(web,@3/tty)"},
		tmux.WindowInfo{WindowID: "@9", Layout: "tty"},
	)
	rec := postLayoutVerb(t, sf, ops, "/api/layout/borrow", `{"to":"@9","leaf":"@3/tty","tree":"h(tty,@3/tty)"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	// The holder's removal chains first, then the target's new tree.
	want := []tmux.WindowLayoutWrite{
		{WindowID: "@7", Layout: "web"},
		{WindowID: "@9", Layout: "h(tty,@3/tty)"},
	}
	if fmt.Sprint(ops.setWindowLayoutsPairs) != fmt.Sprint(want) {
		t.Errorf("pairs = %+v, want %+v", ops.setWindowLayoutsPairs, want)
	}
}

// A holder whose layout IS the leaf alone falls back to its own bare tty —
// a layout never empties.
func TestLayoutBorrowEmptyHolderTTYFallback(t *testing.T) {
	ops := &mockTmuxOps{}
	sf := layoutFetcher(
		tmux.WindowInfo{WindowID: "@3", Layout: "tty"},
		tmux.WindowInfo{WindowID: "@7", Layout: "@3/tty"},
		tmux.WindowInfo{WindowID: "@9", Layout: "tty"},
	)
	rec := postLayoutVerb(t, sf, ops, "/api/layout/borrow", `{"to":"@9","leaf":"@3/tty","tree":"h(tty,@3/tty)"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	want := []tmux.WindowLayoutWrite{
		{WindowID: "@7", Layout: "tty"},
		{WindowID: "@9", Layout: "h(tty,@3/tty)"},
	}
	if fmt.Sprint(ops.setWindowLayoutsPairs) != fmt.Sprint(want) {
		t.Errorf("pairs = %+v, want %+v", ops.setWindowLayoutsPairs, want)
	}
}

// A posted tree carrying a SECOND foreign leaf already held by a third window
// is a 409 — the /options gate's live-in-one-place rule; nothing is written.
// The borrowed leaf's own holder is the intended move source, so its held
// state never trips the check (TestLayoutBorrowFromHolderChainsBothWrites and
// TestLayoutBorrowEmptyHolderTTYFallback prove the exemption — both borrow a
// held leaf and succeed).
func TestLayoutBorrowSecondHeldLeaf409(t *testing.T) {
	ops := &mockTmuxOps{}
	sf := layoutFetcher(
		tmux.WindowInfo{WindowID: "@3", Layout: "tty"},
		tmux.WindowInfo{WindowID: "@5", Layout: "tty"},
		tmux.WindowInfo{WindowID: "@7", Layout: "h(web,@3/tty)"},
		tmux.WindowInfo{WindowID: "@8", Layout: "h(tty,@5/tty)"},
		tmux.WindowInfo{WindowID: "@9", Layout: "tty"},
	)
	rec := postLayoutVerb(t, sf, ops, "/api/layout/borrow", `{"to":"@9","leaf":"@3/tty","tree":"h(tty,@3/tty,@5/tty)"}`)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	if ops.setWindowLayoutsCalled {
		t.Error("a borrow stealing a second held leaf must write nothing")
	}
}

func TestLayoutBorrowValidation(t *testing.T) {
	windows := layoutFetcher(
		tmux.WindowInfo{WindowID: "@3", Layout: "tty"},
		tmux.WindowInfo{WindowID: "@9", Layout: "tty"},
	)
	cases := []struct {
		name string
		body string
		code int
	}{
		{"malformed JSON", "not json", http.StatusBadRequest},
		{"bad window id", `{"to":"abc","leaf":"@3/tty","tree":"h(tty,@3/tty)"}`, http.StatusBadRequest},
		{"bad leaf address", `{"to":"@9","leaf":"tty","tree":"h(tty,@3/tty)"}`, http.StatusBadRequest},
		{"bad tree", `{"to":"@9","leaf":"@3/tty","tree":"bogus"}`, http.StatusBadRequest},
		{"tree misses the leaf", `{"to":"@9","leaf":"@3/tty","tree":"h(tty,web)"}`, http.StatusBadRequest},
		{"self-naming leaf in tree", `{"to":"@9","leaf":"@9/tty","tree":"h(tty,@9/tty)"}`, http.StatusBadRequest},
		{"unknown target window", `{"to":"@99","leaf":"@3/tty","tree":"h(tty,@3/tty)"}`, http.StatusNotFound},
		{"unknown leaf home window", `{"to":"@9","leaf":"@99/tty","tree":"h(tty,@99/tty)"}`, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ops := &mockTmuxOps{}
			rec := postLayoutVerb(t, windows, ops, "/api/layout/borrow", tc.body)
			if rec.Code != tc.code {
				t.Errorf("status = %d, want %d; body=%s", rec.Code, tc.code, rec.Body.String())
			}
			if ops.setWindowLayoutsCalled {
				t.Error("a rejected borrow must not reach tmux")
			}
		})
	}
}

// Return with the home slot dismissed re-adds it via the add rule: @7's leaf
// removal and @3's re-add land in one chained write.
func TestLayoutReturnReaddsDismissedSlot(t *testing.T) {
	ops := &mockTmuxOps{}
	sf := layoutFetcher(
		tmux.WindowInfo{WindowID: "@3", Layout: "web"},
		tmux.WindowInfo{WindowID: "@7", Layout: "h(tty,@3/tty)"},
	)
	rec := postLayoutVerb(t, sf, ops, "/api/layout/return", `{"from":"@7","leaf":"@3/tty"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	want := []tmux.WindowLayoutWrite{
		{WindowID: "@7", Layout: "tty"},
		{WindowID: "@3", Layout: "h(web,tty)"},
	}
	if fmt.Sprint(ops.setWindowLayoutsPairs) != fmt.Sprint(want) {
		t.Errorf("pairs = %+v, want %+v", ops.setWindowLayoutsPairs, want)
	}
}

// Return when the home holds only a FOREIGN leaf of the same kind: the bare
// home slot still counts as dismissed, so the re-add lands alongside the
// foreign leaf and both writes chain.
func TestLayoutReturnReaddsSlotBesideForeignLeaf(t *testing.T) {
	ops := &mockTmuxOps{}
	sf := layoutFetcher(
		tmux.WindowInfo{WindowID: "@3", Layout: "h(web,@9/tty)"},
		tmux.WindowInfo{WindowID: "@7", Layout: "h(tty,@3/tty)"},
		tmux.WindowInfo{WindowID: "@9", Layout: "tty"},
	)
	rec := postLayoutVerb(t, sf, ops, "/api/layout/return", `{"from":"@7","leaf":"@3/tty"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	want := []tmux.WindowLayoutWrite{
		{WindowID: "@7", Layout: "tty"},
		{WindowID: "@3", Layout: "h(web,v(@9/tty,tty))"},
	}
	if fmt.Sprint(ops.setWindowLayoutsPairs) != fmt.Sprint(want) {
		t.Errorf("pairs = %+v, want %+v", ops.setWindowLayoutsPairs, want)
	}
}

// Return while the home window still carries its slot writes only the holder.
func TestLayoutReturnLiveSlotWritesOnlyHolder(t *testing.T) {
	ops := &mockTmuxOps{}
	sf := layoutFetcher(
		tmux.WindowInfo{WindowID: "@3", Layout: "h(web,tty)"},
		tmux.WindowInfo{WindowID: "@7", Layout: "h(tty,@3/tty)"},
	)
	rec := postLayoutVerb(t, sf, ops, "/api/layout/return", `{"from":"@7","leaf":"@3/tty"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	want := []tmux.WindowLayoutWrite{{WindowID: "@7", Layout: "tty"}}
	if fmt.Sprint(ops.setWindowLayoutsPairs) != fmt.Sprint(want) {
		t.Errorf("pairs = %+v, want %+v", ops.setWindowLayoutsPairs, want)
	}
}

// A dead home window: the leaf leaves the holder, nothing is written for the
// home.
func TestLayoutReturnDeadHome(t *testing.T) {
	ops := &mockTmuxOps{}
	sf := layoutFetcher(
		tmux.WindowInfo{WindowID: "@7", Layout: "h(tty,@3/tty)"},
	)
	rec := postLayoutVerb(t, sf, ops, "/api/layout/return", `{"from":"@7","leaf":"@3/tty"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	want := []tmux.WindowLayoutWrite{{WindowID: "@7", Layout: "tty"}}
	if fmt.Sprint(ops.setWindowLayoutsPairs) != fmt.Sprint(want) {
		t.Errorf("pairs = %+v, want %+v", ops.setWindowLayoutsPairs, want)
	}
}

// A stale self-naming leaf (home == holder) is simply removed — the home
// re-add never rewrites the same window and resurrects the leaf.
func TestLayoutReturnSelfNamingLeafRemovedOnly(t *testing.T) {
	ops := &mockTmuxOps{}
	sf := layoutFetcher(
		tmux.WindowInfo{WindowID: "@7", Layout: "h(tty,@7/tty)"},
	)
	rec := postLayoutVerb(t, sf, ops, "/api/layout/return", `{"from":"@7","leaf":"@7/tty"}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	want := []tmux.WindowLayoutWrite{{WindowID: "@7", Layout: "tty"}}
	if fmt.Sprint(ops.setWindowLayoutsPairs) != fmt.Sprint(want) {
		t.Errorf("pairs = %+v, want %+v (single write, no self re-add)", ops.setWindowLayoutsPairs, want)
	}
}

func TestLayoutReturnLeafNotHeld409(t *testing.T) {
	ops := &mockTmuxOps{}
	sf := layoutFetcher(
		tmux.WindowInfo{WindowID: "@3", Layout: "web"},
		tmux.WindowInfo{WindowID: "@7", Layout: "tty"},
	)
	rec := postLayoutVerb(t, sf, ops, "/api/layout/return", `{"from":"@7","leaf":"@3/tty"}`)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	if ops.setWindowLayoutsCalled {
		t.Error("a return of an unheld leaf must write nothing")
	}
}

func TestLayoutReturnValidation(t *testing.T) {
	windows := layoutFetcher(
		tmux.WindowInfo{WindowID: "@3", Layout: "web"},
		tmux.WindowInfo{WindowID: "@7", Layout: "h(tty,@3/tty)"},
	)
	cases := []struct {
		name string
		body string
		code int
	}{
		{"malformed JSON", "not json", http.StatusBadRequest},
		{"bad window id", `{"from":"abc","leaf":"@3/tty"}`, http.StatusBadRequest},
		{"bad leaf address", `{"from":"@7","leaf":"@3/x"}`, http.StatusBadRequest},
		{"unknown holder window", `{"from":"@99","leaf":"@3/tty"}`, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ops := &mockTmuxOps{}
			rec := postLayoutVerb(t, windows, ops, "/api/layout/return", tc.body)
			if rec.Code != tc.code {
				t.Errorf("status = %d, want %d; body=%s", rec.Code, tc.code, rec.Body.String())
			}
			if ops.setWindowLayoutsCalled {
				t.Error("a rejected return must not reach tmux")
			}
		})
	}
}

// ── private-server integration ─────────────────────────────────────────────

// withLayoutTmux starts an isolated tmux server whose boot session holds three
// windows and returns their live @N ids in creation order.
func withLayoutTmux(t *testing.T) (server string, ids [3]string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	server = testSocketName("layout")

	bootCtx, cancelBoot := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelBoot()
	if out, err := exec.CommandContext(bootCtx, "tmux", "-L", server, "new-session", "-d", "-s", "boot").CombinedOutput(); err != nil {
		t.Skipf("could not start isolated tmux server %q: %v\n%s", server, err, string(out))
	}
	t.Cleanup(func() {
		killCtx, cancelKill := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelKill()
		_ = exec.CommandContext(killCtx, "tmux", "-L", server, "kill-server").Run()
	})

	for _, name := range []string{"two", "three"} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, "tmux", "-L", server, "new-window", "-t", "boot", "-n", name).CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("new-window %s: %v\n%s", name, err, string(out))
		}
	}

	listCtx, cancelList := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelList()
	windows, err := tmux.ListWindows(listCtx, "boot", server)
	if err != nil {
		t.Fatalf("list windows: %v", err)
	}
	if len(windows) != 3 {
		t.Fatalf("windows = %+v, want 3", windows)
	}
	for i, win := range windows {
		ids[i] = win.WindowID
	}
	return server, ids
}

func setLayoutOption(t *testing.T, server, windowID, layout string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "tmux", "-L", server, "set-option", "-w", "-t", windowID, tmux.LayoutOption, layout).CombinedOutput(); err != nil {
		t.Fatalf("set-option %s %s: %v\n%s", windowID, layout, err, string(out))
	}
}

func readLayoutOption(t *testing.T, server, windowID string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tmux", "-L", server, "show-options", "-wqv", "-t", windowID, tmux.LayoutOption).CombinedOutput()
	if err != nil {
		t.Fatalf("show-options %s: %v\n%s", windowID, err, string(out))
	}
	return strings.TrimSpace(string(out))
}

// layoutServerWithProdTmux wires the router against the real tmux package and
// the real session fetcher, so the handler's fetch-and-chain runs for real
// against the isolated server.
func layoutRouterWithProdTmux(t *testing.T) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	return NewTestRouter(logger, &prodSessionFetcher{}, &prodTmuxOps{}, "test-host")
}

// The re-borrow chain, end to end on a private tmux server: the holder's tree
// minus the leaf and the target's new tree land in one invocation.
func TestLayoutBorrowChainedOnLiveServer(t *testing.T) {
	server, ids := withLayoutTmux(t)
	home, holder, target := ids[0], ids[1], ids[2]
	setLayoutOption(t, server, holder, "h(web,"+home+"/tty)")

	router := layoutRouterWithProdTmux(t)
	body := fmt.Sprintf(`{"to":%q,"leaf":%q,"tree":%q}`, target, home+"/tty", "h(tty,"+home+"/tty)")
	req := httptest.NewRequest(http.MethodPost, "/api/layout/borrow?server="+server, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := readLayoutOption(t, server, holder); got != "web" {
		t.Errorf("holder @rk_win_layout = %q, want web", got)
	}
	if got := readLayoutOption(t, server, target); got != "h(tty,"+home+"/tty)" {
		t.Errorf("target @rk_win_layout = %q, want h(tty,%s/tty)", got, home)
	}
}

// Return on a live server: the holder drops the leaf and the home window's
// dismissed slot is re-added by the add rule, in one invocation.
func TestLayoutReturnChainedOnLiveServer(t *testing.T) {
	server, ids := withLayoutTmux(t)
	home, holder := ids[0], ids[1]
	setLayoutOption(t, server, home, "web")
	setLayoutOption(t, server, holder, "h(tty,"+home+"/tty)")

	router := layoutRouterWithProdTmux(t)
	body := fmt.Sprintf(`{"from":%q,"leaf":%q}`, holder, home+"/tty")
	req := httptest.NewRequest(http.MethodPost, "/api/layout/return?server="+server, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := readLayoutOption(t, server, holder); got != "tty" {
		t.Errorf("holder @rk_win_layout = %q, want tty", got)
	}
	if got := readLayoutOption(t, server, home); got != "h(web,tty)" {
		t.Errorf("home @rk_win_layout = %q, want h(web,tty) (dismissed slot re-added)", got)
	}
}
