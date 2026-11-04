package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/selfpath"
)

// guiSeamRec records what the gui seams observed in one test.
type guiSeamRec struct {
	existsProbes int
	spawnArgs    [][]string
	killArgs     [][]string
	sockProbes   int
}

// withGUISeams substitutes the gui session-exists, spawn, kill, self-path,
// look-path, free-display, and socket-exists seams for one test (the
// withCodeServerSeams idiom). XDG_STATE_HOME is pointed at a temp dir so the
// state-dir/socket paths never touch the real $XDG_STATE_HOME. Restores via
// t.Cleanup.
func withGUISeams(t *testing.T, sessionExists bool) *guiSeamRec {
	t.Helper()
	rec := &guiSeamRec{}

	origExists, origSpawn, origKill := guiSessionExists, guiSpawn, guiKillRun
	origSelf, origLook, origFree, origSock := guiSelfPath, guiLookPath, guiFreeDisplay, guiSocketExists
	origGOOS := guiGOOS
	t.Cleanup(func() {
		guiSessionExists, guiSpawn, guiKillRun = origExists, origSpawn, origKill
		guiSelfPath, guiLookPath, guiFreeDisplay, guiSocketExists = origSelf, origLook, origFree, origSock
		guiGOOS = origGOOS
	})

	guiSessionExists = func(context.Context) bool { rec.existsProbes++; return sessionExists }
	guiSpawn = func(_ context.Context, args ...string) error {
		rec.spawnArgs = append(rec.spawnArgs, append([]string(nil), args...))
		return nil
	}
	guiKillRun = func(_ context.Context, args ...string) error {
		rec.killArgs = append(rec.killArgs, append([]string(nil), args...))
		return nil
	}
	guiSelfPath = func() (string, error) { return "/usr/local/bin/rk", nil }
	guiLookPath = func(name string) (string, error) { return "/usr/bin/" + name, nil }
	guiFreeDisplay = func(start int) (int, error) { return start, nil }
	guiSocketExists = func() bool { rec.sockProbes++; return false }
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	return rec
}

// withGUISetting isolates the settings root (RK_CONFIG_DIR) and, when
// enabled, writes the single `gui.enabled: true` line.
func withGUISetting(t *testing.T, enabled bool) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("RK_CONFIG_DIR", dir)
	if enabled {
		if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("gui.enabled: true\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEnsureGUIDisabledTouchesNothing(t *testing.T) {
	withGUISetting(t, false)
	rec := withGUISeams(t, false)

	outcome, err := ensureGUICore(false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != GUIEnsureDisabled {
		t.Errorf("outcome = %v, want GUIEnsureDisabled", outcome)
	}
	if rec.existsProbes != 0 {
		t.Errorf("session-exists probes = %d, want 0 — the disabled gate fires first", rec.existsProbes)
	}
	if len(rec.spawnArgs) != 0 {
		t.Errorf("spawn calls = %d, want 0", len(rec.spawnArgs))
	}
	if len(rec.killArgs) != 0 {
		t.Errorf("kill calls = %d, want 0", len(rec.killArgs))
	}
}

func TestEnsureGUISpawnsSuperviseSession(t *testing.T) {
	withGUISetting(t, true)
	rec := withGUISeams(t, false)

	outcome, err := ensureGUICore(false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != GUIEnsureStarted {
		t.Errorf("outcome = %v, want GUIEnsureStarted", outcome)
	}
	if len(rec.spawnArgs) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(rec.spawnArgs))
	}
	got := strings.Join(rec.spawnArgs[0], " ")
	// The spawn pins the daemon's XDG_STATE_HOME into the pane (the tmux
	// server-env fork would otherwise split the socket path between supervise
	// and the probe/relay).
	want := "new-session -d -e XDG_STATE_HOME=" + os.Getenv("XDG_STATE_HOME") + " -s rk-gui -n host /usr/local/bin/rk gui supervise host --display :10"
	if got != want {
		t.Errorf("spawn argv =\n%s\nwant:\n%s", got, want)
	}
}

func TestEnsureGUISpawnCarriesStableRkPathOnBrew(t *testing.T) {
	withGUISetting(t, true)
	rec := withGUISeams(t, false)
	guiSelfPath = func() (string, error) {
		return selfpath.StableFor("/opt/homebrew/Cellar/run-kit/1.2.3/bin/run-kit"), nil
	}

	if _, err := ensureGUICore(false); err != nil {
		t.Fatal(err)
	}
	if len(rec.spawnArgs) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(rec.spawnArgs))
	}
	args := rec.spawnArgs[0]
	i := -1
	for j, a := range args {
		if a == "gui" && j > 0 {
			i = j - 1
			break
		}
	}
	if i < 0 {
		t.Fatalf("spawn argv = %v, want `<rk-exe> gui supervise …`", args)
	}
	if args[i] != "/opt/homebrew/bin/run-kit" {
		t.Errorf("rk exe element = %q, want the brew-prefix symlink /opt/homebrew/bin/run-kit", args[i])
	}
	for _, a := range args {
		if strings.Contains(a, "/Cellar/") {
			t.Errorf("spawn argv = %v, want no version-pinned /Cellar/ element", args)
		}
	}
}

func TestEnsureGUISkipsWhenSessionExists(t *testing.T) {
	withGUISetting(t, true)
	rec := withGUISeams(t, true)

	outcome, err := ensureGUICore(false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != GUIEnsureAlreadyRunning {
		t.Errorf("outcome = %v, want GUIEnsureAlreadyRunning", outcome)
	}
	if len(rec.spawnArgs) != 0 {
		t.Errorf("spawn calls = %d, want 0 (session already managed)", len(rec.spawnArgs))
	}
}

func TestEnsureGUINoBackendIsNotAnError(t *testing.T) {
	withGUISetting(t, true)
	rec := withGUISeams(t, false)
	guiLookPath = func(string) (string, error) { return "", fmt.Errorf("not found") }

	for _, cli := range []bool{false, true} {
		outcome, err := ensureGUICore(cli)
		if err != nil {
			t.Fatalf("cli=%v: err = %v, want nil — the outcome carries the install hint", cli, err)
		}
		if outcome != GUIEnsureNoBackend {
			t.Errorf("cli=%v: outcome = %v, want GUIEnsureNoBackend", cli, outcome)
		}
	}
	if len(rec.spawnArgs) != 0 {
		t.Errorf("spawn calls = %d, want 0 (no backend)", len(rec.spawnArgs))
	}
}

func TestEnsureGUIXvncFallbackResolves(t *testing.T) {
	withGUISetting(t, true)
	rec := withGUISeams(t, false)
	guiLookPath = func(name string) (string, error) {
		// Xtigervnc absent, Xvnc present ⇒ the fallback rung resolves.
		if name == "Xvnc" {
			return "/usr/bin/Xvnc", nil
		}
		return "", fmt.Errorf("not found")
	}

	outcome, err := ensureGUICore(false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != GUIEnsureStarted {
		t.Errorf("outcome = %v, want GUIEnsureStarted (Xvnc fallback resolves)", outcome)
	}
	if len(rec.spawnArgs) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(rec.spawnArgs))
	}
}

func TestEnsureGUIDarwinNeverProbesBackend(t *testing.T) {
	withGUISetting(t, true)
	rec := withGUISeams(t, false)
	guiGOOS = "darwin"
	lookPathCalls := 0
	guiLookPath = func(string) (string, error) { lookPathCalls++; return "", fmt.Errorf("not found") }

	outcome, err := ensureGUICore(false)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != GUIEnsureStarted {
		t.Errorf("outcome = %v, want GUIEnsureStarted (darwin spawns without a PATH probe)", outcome)
	}
	if lookPathCalls != 0 {
		t.Errorf("lookPath calls = %d, want 0 — darwin never hits the backend rung", lookPathCalls)
	}
	if len(rec.spawnArgs) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(rec.spawnArgs))
	}
}

func TestEnsureGUIStateDirFailureNamesThePath(t *testing.T) {
	withGUISetting(t, true)
	rec := withGUISeams(t, false)
	// A FILE as XDG_STATE_HOME makes MkdirAll(<file>/hexokit/gui) fail.
	blocker := filepath.Join(t.TempDir(), "state-home")
	if err := os.WriteFile(blocker, []byte("not a dir"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_STATE_HOME", blocker)

	outcome, err := ensureGUICore(true)
	if outcome != GUIEnsureStateDirFailed {
		t.Errorf("outcome = %v, want GUIEnsureStateDirFailed", outcome)
	}
	if err == nil || !strings.Contains(err.Error(), blocker) {
		t.Errorf("err = %v, want an operational error naming the state dir %q", err, blocker)
	}
	if len(rec.spawnArgs) != 0 {
		t.Errorf("spawn calls = %d, want 0", len(rec.spawnArgs))
	}
}

// --- KillGUISession (R4) ---

// shrinkSocketFreeWait shrinks the socket-free wait vars so the never-frees
// branch runs without burning wall-clock (the shrinkPortFreeWait idiom).
func shrinkSocketFreeWait(t *testing.T) {
	t.Helper()
	origTimeout, origPoll := guiSocketFreeTimeout, guiSocketFreePoll
	t.Cleanup(func() { guiSocketFreeTimeout, guiSocketFreePoll = origTimeout, origPoll })
	guiSocketFreeTimeout = 20 * time.Millisecond
	guiSocketFreePoll = time.Millisecond
}

// stubGUISocketExists swaps the socket-exists probe for the given scripted
// function and returns a probe counter (the stubCodeServerPortBusy idiom).
func stubGUISocketExists(t *testing.T, fn func(probes int) bool) *int {
	t.Helper()
	probes := new(int)
	orig := guiSocketExists
	t.Cleanup(func() { guiSocketExists = orig })
	guiSocketExists = func() bool { *probes++; return fn(*probes) }
	return probes
}

func TestKillGUISessionAbsentIsNoop(t *testing.T) {
	rec := withGUISeams(t, false)

	killed, err := KillGUISession()
	if err != nil {
		t.Fatalf("absent session must be a no-op, got %v", err)
	}
	if killed {
		t.Error("killed = true, want false — nothing existed to kill")
	}
	if len(rec.killArgs) != 0 {
		t.Errorf("kill calls = %d, want 0", len(rec.killArgs))
	}
	if rec.sockProbes != 0 {
		t.Errorf("socket probes = %d, want 0 — nothing died, nothing to wait for", rec.sockProbes)
	}
}

func TestKillGUISessionPresentKillsExactMatch(t *testing.T) {
	rec := withGUISeams(t, true)

	killed, err := KillGUISession()
	if err != nil {
		t.Fatal(err)
	}
	if !killed {
		t.Error("killed = false, want true — the session existed and the kill succeeded")
	}
	if len(rec.killArgs) != 1 {
		t.Fatalf("kill calls = %d, want 1", len(rec.killArgs))
	}
	want := []string{"kill-session", "-t", "=rk-gui"}
	if strings.Join(rec.killArgs[0], " ") != strings.Join(want, " ") {
		t.Errorf("kill argv = %v, want the exact-match %v", rec.killArgs[0], want)
	}
}

func TestKillGUISessionWaitsForSocketRelease(t *testing.T) {
	withGUISeams(t, true)
	probes := stubGUISocketExists(t, func(p int) bool { return p <= 2 }) // present, present, gone

	killed, err := KillGUISession()
	if err != nil || !killed {
		t.Fatalf("got (%v, %v), want (true, nil)", killed, err)
	}
	if *probes < 3 {
		t.Errorf("socket probes = %d, want the wait to poll past the present reports before returning", *probes)
	}
}

func TestKillGUISessionSocketNeverFreesBudgetExpires(t *testing.T) {
	withGUISeams(t, true)
	shrinkSocketFreeWait(t)
	probes := stubGUISocketExists(t, func(int) bool { return true })

	start := time.Now()
	killed, err := KillGUISession()
	if err != nil || !killed {
		t.Fatalf("got (%v, %v), want (true, nil) — budget expiry is non-fatal", killed, err)
	}
	if *probes < 2 {
		t.Errorf("socket probes = %d, want the wait to keep polling until the budget expired", *probes)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("wait outlasted its budget: %v", elapsed)
	}
}

func TestKillGUISessionKillErrorReportsNotKilled(t *testing.T) {
	withGUISeams(t, true)
	guiKillRun = func(context.Context, ...string) error { return fmt.Errorf("tmux exited 1") }
	probes := stubGUISocketExists(t, func(int) bool { return false })

	killed, err := KillGUISession()
	if err == nil {
		t.Fatal("err = nil, want the wrapped kill failure")
	}
	if killed {
		t.Error("killed = true, want false on a failed kill")
	}
	if *probes != 0 {
		t.Errorf("socket probes = %d, want 0 — the wait is gated on a successful kill", *probes)
	}
}

// --- EnsureGUI daemon-liveness gate ---

func TestEnsureGUIDaemonDown(t *testing.T) {
	withDaemonGate(t, false)
	rec := withGUISeams(t, false)

	_, err := EnsureGUI()
	if err == nil || !strings.Contains(err.Error(), "rk serve -d") {
		t.Errorf("err = %v, want an operational error naming `rk serve -d`", err)
	}
	if rec.existsProbes != 0 || len(rec.spawnArgs) != 0 {
		t.Errorf("seams touched (probes=%d spawns=%d) with the daemon down — the gate must fire first", rec.existsProbes, len(rec.spawnArgs))
	}
}

func TestEnsureGUIDaemonUpSpawns(t *testing.T) {
	withDaemonGate(t, true)
	withGUISetting(t, true)
	rec := withGUISeams(t, false)

	outcome, err := EnsureGUI()
	if err != nil {
		t.Fatal(err)
	}
	if outcome != GUIEnsureStarted {
		t.Errorf("outcome = %v, want GUIEnsureStarted", outcome)
	}
	if len(rec.spawnArgs) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(rec.spawnArgs))
	}
}

// --- RestartGUI ---

func TestRestartGUIRefusesWhenDisabled(t *testing.T) {
	withGUISetting(t, false)
	rec := withGUISeams(t, false)

	err := RestartGUI()
	if err == nil || !strings.Contains(err.Error(), "gui is off — turn it on with 'rk gui on'") {
		t.Errorf("err = %v, want the off refusal", err)
	}
	if len(rec.killArgs) != 0 || len(rec.spawnArgs) != 0 {
		t.Errorf("kill/spawn calls = %d/%d, want 0/0 — the refusal fires first", len(rec.killArgs), len(rec.spawnArgs))
	}
}

func TestRestartGUIKillsThenSpawns(t *testing.T) {
	withGUISetting(t, true)
	rec := withGUISeams(t, true)
	// The session exists for the kill probe, then is gone for the ensure's
	// re-probe (the kill just removed it).
	existsCalls := 0
	guiSessionExists = func(context.Context) bool { existsCalls++; return existsCalls == 1 }
	var ops []string
	guiKillRun = func(_ context.Context, args ...string) error {
		ops = append(ops, "kill")
		rec.killArgs = append(rec.killArgs, append([]string(nil), args...))
		return nil
	}
	guiSpawn = func(_ context.Context, args ...string) error {
		ops = append(ops, "spawn")
		rec.spawnArgs = append(rec.spawnArgs, append([]string(nil), args...))
		return nil
	}

	if err := RestartGUI(); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ops, ","); got != "kill,spawn" {
		t.Errorf("op order = %q, want kill,spawn", got)
	}
	if len(rec.killArgs) != 1 || len(rec.spawnArgs) != 1 {
		t.Fatalf("kill/spawn calls = %d/%d, want 1/1", len(rec.killArgs), len(rec.spawnArgs))
	}
}

// --- GUISessionOptions / GUISessionCreated ---

func TestGUISessionOptionsAbsentSession(t *testing.T) {
	withGUISeams(t, false)

	_, _, _, ok := GUISessionOptions(context.Background())
	if ok {
		t.Error("ok = true, want false for an absent session")
	}
}

func TestGUISessionOptionsReadsStamps(t *testing.T) {
	withGUISeams(t, true)
	orig := guiSessionOption
	t.Cleanup(func() { guiSessionOption = orig })
	guiSessionOption = func(_ context.Context, option string) (string, error) {
		switch option {
		case GUIOptionDisplay:
			return ":10", nil
		case GUIOptionBackend:
			return "Xtigervnc", nil
		case GUIOptionWM:
			return "icewm-session", nil
		}
		return "", fmt.Errorf("unknown option %q", option)
	}

	display, backend, wm, ok := GUISessionOptions(context.Background())
	if !ok || display != ":10" || backend != "Xtigervnc" || wm != "icewm-session" {
		t.Errorf("got (%q, %q, %q, %v), want (\":10\", \"Xtigervnc\", \"icewm-session\", true)", display, backend, wm, ok)
	}
}

func TestGUISessionOptionsUnsetWMReadsEmpty(t *testing.T) {
	withGUISeams(t, true)
	orig := guiSessionOption
	t.Cleanup(func() { guiSessionOption = orig })
	guiSessionOption = func(_ context.Context, option string) (string, error) {
		switch option {
		case GUIOptionDisplay:
			return ":10", nil
		case GUIOptionBackend:
			return "Xtigervnc", nil
		}
		return "", fmt.Errorf("invalid option") // the wm stamp is best-effort: an unset option must not flip ok
	}

	_, _, wm, ok := GUISessionOptions(context.Background())
	if !ok || wm != "" {
		t.Errorf("got (wm=%q, ok=%v), want (\"\", true) — an unset wm stamp reads empty", wm, ok)
	}
}

func TestGUISessionOptionsUnsetOptionIsAbsent(t *testing.T) {
	withGUISeams(t, true)
	orig := guiSessionOption
	t.Cleanup(func() { guiSessionOption = orig })
	guiSessionOption = func(context.Context, string) (string, error) {
		return "", fmt.Errorf("invalid option") // show-options -v hard-fails on an unset user option
	}

	_, _, _, ok := GUISessionOptions(context.Background())
	if ok {
		t.Error("ok = true, want false when the stamps are unset")
	}
}

func TestSetGUILockArgv(t *testing.T) {
	withGUISeams(t, true)
	var calls [][]string
	orig := guiSetLockRun
	t.Cleanup(func() { guiSetLockRun = orig })
	guiSetLockRun = func(_ context.Context, args ...string) error {
		calls = append(calls, append([]string(nil), args...))
		return nil
	}

	if err := SetGUILock(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := SetGUILock(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 {
		t.Fatalf("set-option calls = %v, want 2", calls)
	}
	if got, want := strings.Join(calls[0], " "), "set-option -t =rk-gui: @rk_gui_lock 1"; got != want {
		t.Errorf("lock argv = %q, want %q (session-scoped exact target)", got, want)
	}
	if got, want := strings.Join(calls[1], " "), "set-option -u -t =rk-gui: @rk_gui_lock"; got != want {
		t.Errorf("unlock argv = %q, want %q", got, want)
	}
}

func TestGUILockedReadsThePin(t *testing.T) {
	withGUISeams(t, true)
	orig := guiSessionOption
	t.Cleanup(func() { guiSessionOption = orig })

	guiSessionOption = func(_ context.Context, option string) (string, error) {
		if option == GUIOptionLock {
			return "1", nil
		}
		return "", fmt.Errorf("invalid option")
	}
	if !GUILocked(context.Background()) {
		t.Error("GUILocked = false with the pin set to 1")
	}

	// An unset option hard-fails show-options -v, which reads as unlocked.
	guiSessionOption = func(context.Context, string) (string, error) {
		return "", fmt.Errorf("invalid option")
	}
	if GUILocked(context.Background()) {
		t.Error("GUILocked = true with the pin unset")
	}
}

func TestGUILockedAbsentSession(t *testing.T) {
	rec := withGUISeams(t, false)
	if GUILocked(context.Background()) {
		t.Error("GUILocked = true with no rk-gui session")
	}
	if rec.existsProbes != 1 {
		t.Errorf("exists probes = %d, want 1 (gated before the option read)", rec.existsProbes)
	}
}

func TestGUISessionCreatedAbsent(t *testing.T) {
	withGUISeams(t, false)

	if _, ok := GUISessionCreated(context.Background()); ok {
		t.Error("ok = true, want false for an absent session")
	}
}

func TestGUISessionCreatedParsesUnixSeconds(t *testing.T) {
	withGUISeams(t, true)
	orig := guiSessionCreated
	t.Cleanup(func() { guiSessionCreated = orig })
	guiSessionCreated = func(context.Context) (string, error) { return "1757376000", nil }

	created, ok := GUISessionCreated(context.Background())
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if want := time.Unix(1757376000, 0); !created.Equal(want) {
		t.Errorf("created = %v, want %v", created, want)
	}
}

func TestGUISessionCreatedGarbageIsAbsent(t *testing.T) {
	withGUISeams(t, true)
	orig := guiSessionCreated
	t.Cleanup(func() { guiSessionCreated = orig })
	guiSessionCreated = func(context.Context) (string, error) { return "not-a-timestamp", nil }

	if _, ok := GUISessionCreated(context.Background()); ok {
		t.Error("ok = true, want false for an unparsable stamp")
	}
}

// --- GUIPanePids ---

func TestGUIPanePidsAbsentSession(t *testing.T) {
	withGUISeams(t, false)
	orig := guiPanePID
	t.Cleanup(func() { guiPanePID = orig })
	guiPanePID = func(context.Context) (string, error) {
		t.Error("pane_pid probed for an absent session — the exists gate must fire first")
		return "", nil
	}

	if got := GUIPanePids(context.Background()); got != nil {
		t.Errorf("GUIPanePids = %v, want nil for an absent session", got)
	}
}

func TestGUIPanePidsCoversThePaneRoot(t *testing.T) {
	withGUISeams(t, true)
	orig := guiPanePID
	t.Cleanup(func() { guiPanePID = orig })
	// A pid that cannot exist on the real /proc: the set still contains the
	// root itself (descendants just do not resolve).
	guiPanePID = func(context.Context) (string, error) { return "4194303", nil }

	got := GUIPanePids(context.Background())
	if !got[4194303] {
		t.Errorf("GUIPanePids = %v, want the pane root pid included", got)
	}
}

func TestGUIPanePidsUnavailableIsNil(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
		err  error
	}{
		{"tmux error", "", fmt.Errorf("no server")},
		{"unparsable pid", "not-a-pid", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withGUISeams(t, true)
			orig := guiPanePID
			t.Cleanup(func() { guiPanePID = orig })
			guiPanePID = func(context.Context) (string, error) { return tc.raw, tc.err }

			if got := GUIPanePids(context.Background()); got != nil {
				t.Errorf("GUIPanePids = %v, want nil so callers exclude nothing", got)
			}
		})
	}
}
