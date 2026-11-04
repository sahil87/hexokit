package tmux

import (
	"context"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// legacyTmuxDo runs a tmux command against the isolated test server, failing
// the test on error.
func legacyTmuxDo(t *testing.T, server string, args ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	full := append([]string{"-L", server}, args...)
	if out, err := exec.CommandContext(ctx, "tmux", full...).CombinedOutput(); err != nil {
		t.Fatalf("tmux %v: %v\n%s", args, err, string(out))
	}
}

// legacyHeld reads a user option at an exact scope via show-options -qv,
// returning ("", false) when unset (show -qv exits 0 with empty output for an
// unset option). showArgs select the scope, e.g. "-w", "-t", "@1", "@color".
func legacyHeld(t *testing.T, server string, showArgs ...string) (string, bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	full := append([]string{"-L", server, "show-options", "-qv"}, showArgs...)
	out, err := exec.CommandContext(ctx, "tmux", full...).CombinedOutput()
	if err != nil {
		return "", false
	}
	v := strings.TrimSpace(string(out))
	return v, v != ""
}

func TestMigrateLegacyOptions_rightScopeWindowMove(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, "@color", "5")

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}

	if v, ok := legacyHeld(t, server, "-w", "-t", id, ColorOption); !ok || v != "5" {
		t.Errorf("%s = %q (held=%v), want \"5\"", ColorOption, v, ok)
	}
	if v, ok := legacyHeld(t, server, "-w", "-t", id, "@color"); ok {
		t.Errorf("@color still held at window scope: %q", v)
	}
}

func TestMigrateLegacyOptions_rightScopeSessionMove(t *testing.T) {
	server := withSessionOrderTmux(t)
	legacyTmuxDo(t, server, "set-option", "-t", "=boot:", "@session_color", "4")

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}

	if v, ok := legacyHeld(t, server, "-t", "=boot:", SessionColorOption); !ok || v != "4" {
		t.Errorf("%s = %q (held=%v), want \"4\"", SessionColorOption, v, ok)
	}
	if v, ok := legacyHeld(t, server, "-t", "=boot:", "@session_color"); ok {
		t.Errorf("@session_color still held at session scope: %q", v)
	}
}

// The fabKit case: a session-scoped @color must be purged, never copied
// forward to the window scope.
func TestMigrateLegacyOptions_sessionScopeColorPurgedNoCopy(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-t", "=boot:", "@color", "slate")

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}

	if v, ok := legacyHeld(t, server, "-t", "=boot:", "@color"); ok {
		t.Errorf("@color still held at session scope: %q", v)
	}
	if v, ok := legacyHeld(t, server, "-w", "-t", id, ColorOption); ok {
		t.Errorf("window gained %s from a wrong-scope value: %q", ColorOption, v)
	}
}

func TestMigrateLegacyOptions_globalColorPurged(t *testing.T) {
	server := withSessionOrderTmux(t)
	legacyTmuxDo(t, server, "set-option", "-g", "@color", "3")

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}

	if v, ok := legacyHeld(t, server, "-g", "@color"); ok {
		t.Errorf("@color still held at global scope: %q", v)
	}
}

func TestMigrateLegacyOptions_newAlreadySetKeepsNew(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, "@color", "5")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, ColorOption, "7")

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}

	if v, ok := legacyHeld(t, server, "-w", "-t", id, ColorOption); !ok || v != "7" {
		t.Errorf("%s = %q (held=%v), want \"7\" (pre-existing value untouched)", ColorOption, v, ok)
	}
	if v, ok := legacyHeld(t, server, "-w", "-t", id, "@color"); ok {
		t.Errorf("@color still held at window scope: %q", v)
	}
}

func TestMigrateLegacyOptions_idempotent(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, "@color", "5")
	legacyTmuxDo(t, server, "set-option", "-t", "=boot:", "@session_color", "4")

	changed, err := sweepLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("first sweep: %v", err)
	}
	if !changed {
		t.Error("first sweep reported changed=false, want true")
	}

	changed, err = sweepLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if changed {
		t.Error("second sweep reported changed=true, want false (zero set-option calls)")
	}
}

// A failing carrier logs and the remaining carriers are still processed; the
// first error is returned.
func TestMigrateLegacyOptions_carrierFailureIsolates(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, "@color", "5")

	targets, err := enumerateScopeTargets(context.Background(), server)
	if err != nil {
		t.Fatalf("enumerate: %v", err)
	}
	// A window that no longer exists fails its show-options read.
	bogus := scopeTarget{scope: scopeWindow, target: "@99999"}
	targets = append([]scopeTarget{bogus}, targets...)

	changed, err := sweepLegacyTargets(context.Background(), server, targets)
	if err == nil {
		t.Fatal("sweep with a dead carrier returned nil error, want the first error")
	}
	if !changed {
		t.Error("sweep reported changed=false — the live carrier was not processed after the failure")
	}
	if v, ok := legacyHeld(t, server, "-w", "-t", id, ColorOption); !ok || v != "5" {
		t.Errorf("%s = %q (held=%v), want \"5\" — failure must not skip live carriers", ColorOption, v, ok)
	}
}

func TestMigrateLegacyOptions_deadServerErrors(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	if err := MigrateLegacyOptions(context.Background(), "rk-test-legacy-dead"); err == nil {
		t.Error("MigrateLegacyOptions on a dead server returned nil error")
	}
}

func TestMigrateLegacyOptionsOnce_runsBodyExactlyOnce(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, "@color", "5")

	ResetLegacyMigrationForTest()
	t.Cleanup(ResetLegacyMigrationForTest)

	const callers = 8
	var wg sync.WaitGroup
	changedVotes := make(chan bool, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			changed, err := MigrateLegacyOptionsOnce(context.Background(), server)
			if err != nil {
				t.Errorf("Once: %v", err)
			}
			changedVotes <- changed
		}()
	}
	wg.Wait()
	close(changedVotes)

	changedCount := 0
	for c := range changedVotes {
		if c {
			changedCount++
		}
	}
	if changedCount != 1 {
		t.Errorf("changed=true from %d callers, want exactly 1 (body runs once)", changedCount)
	}
	if v, ok := legacyHeld(t, server, "-w", "-t", id, ColorOption); !ok || v != "5" {
		t.Errorf("%s = %q (held=%v), want \"5\"", ColorOption, v, ok)
	}
}

// The guard marks on ATTEMPT: a server whose sweep failed is not retried on
// the next Once call.
func TestMigrateLegacyOptionsOnce_marksOnAttempt(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available — skipping integration test")
	}
	ResetLegacyMigrationForTest()
	t.Cleanup(ResetLegacyMigrationForTest)

	const dead = "rk-test-legacy-dead"
	if _, err := MigrateLegacyOptionsOnce(context.Background(), dead); err == nil {
		t.Fatal("first Once on a dead server returned nil error")
	}
	changed, err := MigrateLegacyOptionsOnce(context.Background(), dead)
	if err != nil {
		t.Errorf("second Once re-ran the sweep (err=%v) — guard must mark on attempt", err)
	}
	if changed {
		t.Error("second Once reported changed=true, want false")
	}
}

func TestCountLegacyOptions(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	n, err := CountLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("CountLegacyOptions: %v", err)
	}
	if n != 0 {
		t.Errorf("clean server count = %d, want 0", n)
	}

	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, "@color", "5")
	legacyTmuxDo(t, server, "set-option", "-t", "=boot:", "@color", "slate")
	legacyTmuxDo(t, server, "set-option", "-g", "@session_color", "2")

	n, err = CountLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("CountLegacyOptions: %v", err)
	}
	if n != 3 {
		t.Errorf("seeded count = %d, want 3 (window @color, session @color, global @session_color)", n)
	}

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}
	n, err = CountLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("CountLegacyOptions after sweep: %v", err)
	}
	if n != 0 {
		t.Errorf("post-sweep count = %d, want 0", n)
	}
}

// TestMarkThenReportSweep_composes pins the production wiring of the two
// async hook seams (pre-attach reload, reload-config handler): the caller
// takes the once-guard synchronously via MarkLegacyMigrationAttempt, then
// runs the NON-re-marking MigrateLegacyOptionsReport off its goroutine. A
// re-marking entry would see the guard already burned and return without
// sweeping — the cycle-1 regression this test exists to catch.
func TestMarkThenReportSweep_composes(t *testing.T) {
	server := withSessionOrderTmux(t)
	legacyTmuxDo(t, server, "set-option", "-t", "=boot:", "@color", "slate")
	ResetLegacyMigrationForTest()
	t.Cleanup(ResetLegacyMigrationForTest)

	// First caller wins the mark; the report entry must still sweep (it does
	// not re-mark).
	if !MarkLegacyMigrationAttempt(server) {
		t.Fatal("first MarkLegacyMigrationAttempt = false, want the first caller to win the mark")
	}
	changed, err := MigrateLegacyOptionsReport(context.Background(), server)
	if err != nil {
		t.Fatalf("MigrateLegacyOptionsReport: %v", err)
	}
	if !changed {
		t.Error("MigrateLegacyOptionsReport changed = false after a taken mark — the sweep must still run (non-re-marking entry)")
	}
	if v, ok := legacyHeld(t, server, "-t", "=boot:", "@color"); ok {
		t.Errorf("session @color = %q after the sweep, want purged", v)
	}

	// A second caller loses the mark and sweeps nothing.
	if MarkLegacyMigrationAttempt(server) {
		t.Error("second MarkLegacyMigrationAttempt = true, want false — the guard is burned on attempt")
	}
}

// legacySeed is one seeded legacy option: the retired name, its scope-named
// successor ("" for the unset-only @rk_ctl_keepalive row), the value seeded
// under the OLD name, the value expected under the NEW name after the sweep
// (differs from oldVal for value-mapped rows like @rk_type=iframe →
// @rk_win_layout=web), and the show-options args selecting the scope it
// is legitimate at.
type legacySeed struct {
	old, oldVal, new, newVal string
	showArgs                 []string
}

// TestMigrateLegacyOptions_scopePrefixRename seeds ALL 16 scope-prefix legacy
// names at their correct scopes on a real test socket (7 window options on
// the boot window, 5 session options incl. the retired @rk_ctl_keepalive, 4
// server options via set-option -s) and asserts the sweep moves each onto its
// scope-named successor at the same scope — the lens/URL/root rows chaining
// onward into the indexed web-tab family in the same sweep — deletes the
// keepalive, and leaves no legacy name behind. A second sweep issues zero
// set/unset calls, and a legacy name at a WRONG scope is purged with no
// copy-forward.
func TestMigrateLegacyOptions_scopePrefixRename(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")

	windowSeeds := []legacySeed{
		// @rk_type=iframe chains to @rk_win_lens → @rk_win_layout=web in
		// one sweep (the lens has no live reader). @rk_url → @rk_win_url is a
		// terminal dual-read (never swept to web_1) — asserted separately below.
		{legacyTypeOption, "iframe", LayoutOption, "web", []string{"-w", "-t", id}},
		{legacyURLOption, "https://example.test/app", legacyWinURLOption, "https://example.test/app", []string{"-w", "-t", id}},
		{"@rk_present_root", "/srv/root", WebTabRootOption(1), "/srv/root", []string{"-w", "-t", id}},
		{"@rk_marker", "solid", MarkerOption, "solid", []string{"-w", "-t", id}},
		{"@rk_flair", "nyan", FlairOption, "nyan", []string{"-w", "-t", id}},
		// Spaced value: the copy must carry the raw text, not the quoted
		// enumeration form (`"1756036800:old note"`) tmux prints without -v.
		{legacyNoteOption, "1756036800:old note", NoteOption, "1756036800:old note", []string{"-w", "-t", id}},
		{"@rk_role", "operator", RoleOption, "operator", []string{"-w", "-t", id}},
	}
	sessionSeeds := []legacySeed{
		{"@rk_session_flair", "naruto", SessionFlairOption, "naruto", []string{"-t", "=boot:"}},
		{"@rk_board", "main", BoardOption, "main", []string{"-t", "=boot:"}},
		{"@rk_home", "boot", HomeOption, "boot", []string{"-t", "=boot:"}},
		{"@rk_board_order", "main,deploy", BoardOrderOption, "main,deploy", []string{"-t", "=boot:"}},
		// Retired with no successor: unset-only row.
		{"@rk_ctl_keepalive", "1", "", "", []string{"-t", "=boot:"}},
	}
	serverSeeds := []legacySeed{
		{"@rk_session_order", `["boot","extra"]`, SessionOrderOption, `["boot","extra"]`, []string{"-s"}},
		{"@rk_server_rank", "7", ServerRankOption, "7", []string{"-s"}},
		{"@rk_origin", "http://127.0.0.1:3001", OriginOption, "http://127.0.0.1:3001", []string{"-s"}},
		{"@rk_managed", "1", ManagedOption, "1", []string{"-s"}},
	}

	for _, s := range windowSeeds {
		legacyTmuxDo(t, server, "set-option", "-w", "-t", id, s.old, s.oldVal)
	}
	for _, s := range sessionSeeds {
		legacyTmuxDo(t, server, "set-option", "-t", "=boot:", s.old, s.oldVal)
	}
	for _, s := range serverSeeds {
		legacyTmuxDo(t, server, "set-option", "-s", s.old, s.oldVal)
	}
	// A window option name held on the SERVER table is a wrong-scope hold:
	// the sweep purges it and never copies the value forward.
	legacyTmuxDo(t, server, "set-option", "-s", "@rk_role", "contaminated")

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}

	seeds := append(append(append([]legacySeed{}, windowSeeds...), sessionSeeds...), serverSeeds...)
	for _, s := range seeds {
		if s.new != "" {
			if v, ok := legacyHeld(t, server, append(s.showArgs, s.new)...); !ok || v != s.newVal {
				t.Errorf("%s = %q (held=%v), want %q at the same scope", s.new, v, ok, s.newVal)
			}
		}
		if v, ok := legacyHeld(t, server, append(s.showArgs, s.old)...); ok {
			t.Errorf("legacy %s still held after the sweep: %q", s.old, v)
		}
	}
	// The chained intermediate names that DO converge are gone; @rk_win_url is
	// the terminal dual-read (held, asserted in the seed loop above) and is NOT
	// swept to web_1.
	for _, mid := range []string{legacyWinLensOption, LegacyWinPresentRootOption} {
		if v, ok := legacyHeld(t, server, "-w", "-t", id, mid); ok {
			t.Errorf("intermediate %s still held after the sweep: %q", mid, v)
		}
	}

	// Wrong-scope purge: gone from the server table, and the contaminated
	// value never reached the legitimate successor (the window-scope row
	// migrated its own value).
	if v, ok := legacyHeld(t, server, "-s", "@rk_role"); ok {
		t.Errorf("wrong-scope @rk_role still held at server scope: %q", v)
	}
	if v, ok := legacyHeld(t, server, "-w", "-t", id, RoleOption); !ok || v != "operator" {
		t.Errorf("window %s = %q (held=%v), want %q — the wrong-scope value must not copy forward", RoleOption, v, ok, "operator")
	}

	// No legacy name remains at any scope.
	if n, err := CountLegacyOptions(context.Background(), server); err != nil || n != 0 {
		t.Errorf("CountLegacyOptions after the sweep = %d (err=%v), want 0", n, err)
	}

	// Idempotent: a second sweep issues zero set/unset calls.
	changed, err := sweepLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if changed {
		t.Error("second sweep reported changed=true, want false (zero set-option calls)")
	}
}

// paneIDOf resolves a pane ID (%N) for a window on the test server.
func paneIDOf(t *testing.T, server, target string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	full := []string{"-L", server, "list-panes", "-t", target, "-F", "#{pane_id}"}
	out, err := exec.CommandContext(ctx, "tmux", full...).CombinedOutput()
	if err != nil {
		t.Fatalf("list-panes %q: %v\n%s", target, err, string(out))
	}
	id := strings.TrimSpace(string(out))
	if id == "" {
		t.Fatalf("no pane found for target %q", target)
	}
	return id
}

// TestMigrateLegacyOptions_paneCopyOnlyKeepsOld covers the CopyOnly pane
// rows: the sweep copies @rk_agent_state forward to its scope-named successor
// but NEVER unsets the retired name at pane scope (the dual state is
// sanctioned — rk agent hook dual-writes both and fab-kit still reads the
// retired name). A second sweep is a no-op, and CountLegacyOptions excludes
// the sanctioned right-scope holds.
func TestMigrateLegacyOptions_paneCopyOnlyKeepsOld(t *testing.T) {
	server := withSessionOrderTmux(t)
	pane := paneIDOf(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-p", "-t", pane, LegacyAgentStateOption, "idle:1")
	legacyTmuxDo(t, server, "set-option", "-p", "-t", pane, "@rk_chat", "claude:abc123")

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}

	if v, ok := legacyHeld(t, server, "-p", "-t", pane, AgentStateOption); !ok || v != "idle:1" {
		t.Errorf("%s = %q (held=%v), want \"idle:1\" (copied forward)", AgentStateOption, v, ok)
	}
	if v, ok := legacyHeld(t, server, "-p", "-t", pane, LegacyAgentSessionOption); !ok || v != "claude:abc123" {
		t.Errorf("%s = %q (held=%v), want \"claude:abc123\" (copied forward)", LegacyAgentSessionOption, v, ok)
	}
	if v, ok := legacyHeld(t, server, "-p", "-t", pane, LegacyAgentStateOption); !ok || v != "idle:1" {
		t.Errorf("%s = %q (held=%v), want \"idle:1\" — CopyOnly must never unset the retired name", LegacyAgentStateOption, v, ok)
	}
	if v, ok := legacyHeld(t, server, "-p", "-t", pane, "@rk_chat"); !ok || v != "claude:abc123" {
		t.Errorf("@rk_chat = %q (held=%v), want \"claude:abc123\" — CopyOnly must never unset the retired name", v, ok)
	}

	// The sanctioned dual state is not counted, and a second sweep issues
	// nothing.
	if n, err := CountLegacyOptions(context.Background(), server); err != nil || n != 0 {
		t.Errorf("CountLegacyOptions with sanctioned pane holds = %d (err=%v), want 0", n, err)
	}
	changed, err := sweepLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if changed {
		t.Error("second sweep reported changed=true, want false (idempotent dual state)")
	}
}

// TestMigrateLegacyOptions_agentSessionChainConvergesInOneSweep pins the
// table-order chaining of the agent-session key's two retired generations: a
// pane holding ONLY "@rk_chat" gains @rk_pane_chat and then
// @rk_pane_agent_session in ONE sweep pass — all three names end held with the
// same value (both rows are CopyOnly, so nothing is unset) — and a second
// sweep issues zero set-option calls.
func TestMigrateLegacyOptions_agentSessionChainConvergesInOneSweep(t *testing.T) {
	server := withSessionOrderTmux(t)
	pane := paneIDOf(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-p", "-t", pane, "@rk_chat", "claude:6f0d9e2a-1c3b-4f7e-9a2d-8b5c4e1f0a37")

	changed, err := sweepLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("first sweep: %v", err)
	}
	if !changed {
		t.Error("first sweep reported changed=false, want true")
	}

	const want = "claude:6f0d9e2a-1c3b-4f7e-9a2d-8b5c4e1f0a37"
	for _, opt := range []string{"@rk_chat", LegacyAgentSessionOption, AgentSessionOption} {
		if v, ok := legacyHeld(t, server, "-p", "-t", pane, opt); !ok || v != want {
			t.Errorf("%s = %q (held=%v), want %q — all three generations held after ONE sweep", opt, v, ok, want)
		}
	}

	changed, err = sweepLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if changed {
		t.Error("second sweep reported changed=true, want false (zero set-option calls)")
	}
}

// TestMigrateLegacyOptions_copyOnlyPreExistingNewIssuesNothing: a carrier
// already holding BOTH names (the steady state after dual-writing hooks fire)
// is a no-op — no copy, no unset.
func TestMigrateLegacyOptions_copyOnlyPreExistingNewIssuesNothing(t *testing.T) {
	server := withSessionOrderTmux(t)
	pane := paneIDOf(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-p", "-t", pane, LegacyAgentStateOption, "idle:1")
	legacyTmuxDo(t, server, "set-option", "-p", "-t", pane, AgentStateOption, "active:2:4242")

	changed, err := sweepLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if changed {
		t.Error("sweep reported changed=true on a pre-dual carrier, want false (both held issues nothing)")
	}
	if v, ok := legacyHeld(t, server, "-p", "-t", pane, AgentStateOption); !ok || v != "active:2:4242" {
		t.Errorf("%s = %q (held=%v), want the pre-existing value untouched", AgentStateOption, v, ok)
	}
	if v, ok := legacyHeld(t, server, "-p", "-t", pane, LegacyAgentStateOption); !ok || v != "idle:1" {
		t.Errorf("%s = %q (held=%v), want \"idle:1\" — CopyOnly must never unset the retired name", LegacyAgentStateOption, v, ok)
	}
}

// TestMigrateLegacyOptions_copyOnlyWrongScopePurgedAndCounted: a CopyOnly
// row's Old at a WRONG scope can only be a stray — it is purged like any
// other row and counted by CountLegacyOptions before the sweep.
func TestMigrateLegacyOptions_copyOnlyWrongScopePurgedAndCounted(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, LegacyAgentStateOption, "idle:1")

	if n, err := CountLegacyOptions(context.Background(), server); err != nil || n != 1 {
		t.Errorf("CountLegacyOptions with a wrong-scope CopyOnly hold = %d (err=%v), want 1", n, err)
	}

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}
	if v, ok := legacyHeld(t, server, "-w", "-t", id, LegacyAgentStateOption); ok {
		t.Errorf("%s still held at window scope: %q — wrong-scope strays are purged", LegacyAgentStateOption, v)
	}
	if n, err := CountLegacyOptions(context.Background(), server); err != nil || n != 0 {
		t.Errorf("CountLegacyOptions after the sweep = %d (err=%v), want 0", n, err)
	}
}

// TestMigrateLegacyOptions_serverRowsMoveFully: the server rows
// (@rk_ephemeral/@rk_protected) migrate like every other non-CopyOnly row —
// copy to the scope-named successor, then unset the retired name — because no
// cross-repo reader consumes them.
func TestMigrateLegacyOptions_serverRowsMoveFully(t *testing.T) {
	server := withSessionOrderTmux(t)
	legacyTmuxDo(t, server, "set-option", "-s", LegacyEphemeralOption, "1")
	legacyTmuxDo(t, server, "set-option", "-s", LegacyProtectedOption, "1")

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}

	if v, ok := legacyHeld(t, server, "-s", EphemeralOption); !ok || v != "1" {
		t.Errorf("%s = %q (held=%v), want \"1\" (moved)", EphemeralOption, v, ok)
	}
	if v, ok := legacyHeld(t, server, "-s", ProtectedOption); !ok || v != "1" {
		t.Errorf("%s = %q (held=%v), want \"1\" (moved)", ProtectedOption, v, ok)
	}
	if v, ok := legacyHeld(t, server, "-s", LegacyEphemeralOption); ok {
		t.Errorf("%s still held at server scope: %q", LegacyEphemeralOption, v)
	}
	if v, ok := legacyHeld(t, server, "-s", LegacyProtectedOption); ok {
		t.Errorf("%s still held at server scope: %q", LegacyProtectedOption, v)
	}
	if n, err := CountLegacyOptions(context.Background(), server); err != nil || n != 0 {
		t.Errorf("CountLegacyOptions after the sweep = %d (err=%v), want 0", n, err)
	}
	changed, err := sweepLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if changed {
		t.Error("second sweep reported changed=true, want false (idempotent)")
	}
}

// TestMigrateLegacyOptions_windowFamilyConverges: a window carrying the two
// retired web names with no live reader (@rk_win_present_root + @rk_win_lens)
// converges onto the indexed family in one sweep — web_1_root +
// layout=web (the Transform value map) — with the retired names gone
// and a second sweep issuing zero set/unset calls. @rk_win_url is NOT swept
// (dual-read, never unset — see the table comment); a pre-set web_1 proves the
// sweep leaves the family alone.
func TestMigrateLegacyOptions_windowFamilyConverges(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, legacyWinURLOption, "/proxy/1/")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, WebTabOption(1), "/proxy/1/")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, WebActiveOption, "1")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, LegacyWinPresentRootOption, "/tmp")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, legacyWinLensOption, "iframe")

	changed, err := sweepLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("first sweep: %v", err)
	}
	if !changed {
		t.Error("first sweep reported changed=false, want true")
	}

	for opt, want := range map[string]string{
		WebTabOption(1):     "/proxy/1/",
		WebTabRootOption(1): "/tmp",
		WebActiveOption:     "1",
		LayoutOption:        "web",
	} {
		if v, ok := legacyHeld(t, server, "-w", "-t", id, opt); !ok || v != want {
			t.Errorf("%s = %q (held=%v), want %q", opt, v, ok, want)
		}
	}
	// @rk_win_url is dual-read, never swept: it stays (the frontend polls it).
	if v, ok := legacyHeld(t, server, "-w", "-t", id, legacyWinURLOption); !ok || v != "/proxy/1/" {
		t.Errorf("%s = %q (held=%v), want \"/proxy/1/\" (dual-read, never swept)", legacyWinURLOption, v, ok)
	}
	for _, old := range []string{LegacyWinPresentRootOption, legacyWinLensOption} {
		if v, ok := legacyHeld(t, server, "-w", "-t", id, old); ok {
			t.Errorf("legacy %s still held after the sweep: %q", old, v)
		}
	}

	changed, err = sweepLegacyOptions(context.Background(), server)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if changed {
		t.Error("second sweep reported changed=true, want false (zero set-option calls)")
	}
}

// TestMigrateLegacyOptions_lensTransformKeepsExistingLayout: @rk_win_lens=
// iframe never overwrites an existing @rk_win_layout — the copy is
// New-unset-only; the retired name is unset either way.
func TestMigrateLegacyOptions_lensTransformKeepsExistingLayout(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, legacyWinLensOption, "iframe")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, LayoutOption, "row:tty,code,web")

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}

	if v, ok := legacyHeld(t, server, "-w", "-t", id, LayoutOption); !ok || v != "row:tty,code,web" {
		t.Errorf("%s = %q (held=%v), want %q (pre-existing value untouched)", LayoutOption, v, ok, "row:tty,code,web")
	}
	if v, ok := legacyHeld(t, server, "-w", "-t", id, legacyWinLensOption); ok {
		t.Errorf("%s still held after the sweep: %q", legacyWinLensOption, v)
	}
}

// TestMigrateLegacyOptions_lensNonIframeDropped: a @rk_win_lens value other
// than iframe has no layout representation — no copy, but the retired name is
// still unset.
func TestMigrateLegacyOptions_lensNonIframeDropped(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, legacyWinLensOption, "terminal")

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}

	if v, ok := legacyHeld(t, server, "-w", "-t", id, LayoutOption); ok {
		t.Errorf("%s = %q, want unset (a non-iframe lens never copies)", LayoutOption, v)
	}
	if v, ok := legacyHeld(t, server, "-w", "-t", id, legacyWinLensOption); ok {
		t.Errorf("%s still held after the sweep: %q", legacyWinLensOption, v)
	}
}

// TestMigrateLegacyOptions_doublyLegacyConvergesInOneSweep: a window carrying
// the unscoped pre-rename names (@rk_url + @rk_type=iframe) converges in ONE
// sweep — @rk_url → @rk_win_url (dual-read by the frontend) and @rk_type →
// @rk_win_lens → @rk_win_layout=web (the lens has no live reader, so
// its sweep row converges it the same pass).
func TestMigrateLegacyOptions_doublyLegacyConvergesInOneSweep(t *testing.T) {
	server := withSessionOrderTmux(t)
	id := windowID(t, server, "boot:0")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, legacyURLOption, "/proxy/1/")
	legacyTmuxDo(t, server, "set-option", "-w", "-t", id, legacyTypeOption, "iframe")

	if err := MigrateLegacyOptions(context.Background(), server); err != nil {
		t.Fatalf("MigrateLegacyOptions: %v", err)
	}

	// @rk_url → @rk_win_url (the dual-read name the frontend polls).
	if v, ok := legacyHeld(t, server, "-w", "-t", id, legacyWinURLOption); !ok || v != "/proxy/1/" {
		t.Errorf("%s = %q (held=%v), want \"/proxy/1/\" after ONE sweep", legacyWinURLOption, v, ok)
	}
	// @rk_type → @rk_win_lens → @rk_win_layout in the same pass.
	if v, ok := legacyHeld(t, server, "-w", "-t", id, LayoutOption); !ok || v != "web" {
		t.Errorf("%s = %q (held=%v), want \"web\" after ONE sweep", LayoutOption, v, ok)
	}
	for _, old := range []string{legacyURLOption, legacyTypeOption, legacyWinLensOption} {
		if v, ok := legacyHeld(t, server, "-w", "-t", id, old); ok {
			t.Errorf("legacy %s still held after one sweep: %q", old, v)
		}
	}
}
