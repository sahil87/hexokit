package daemon

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rk/internal/codeserver"
	"rk/internal/selfpath"
	"rk/internal/testutil"
)

// withCodeServerSeams substitutes the session-exists, spawn, home-dir,
// job-spawn, and self-path seams for one test, returning recorders for the
// spawn argv and job argv plus the temp home the profile paths resolve under.
// Stubbing home here — for every test, not only the profile-focused ones —
// guarantees no test can ever write to the real ~/.rk. Restores via
// t.Cleanup.
func withCodeServerSeams(t *testing.T, sessionExists bool) (spawned *[][]string, jobs *[][]string, home string) {
	t.Helper()
	spawned = &[][]string{}
	jobs = &[][]string{}
	home = t.TempDir()

	origExists, origSpawn, origHome := codeServerSessionExists, codeServerSpawn, codeServerUserHomeDir
	origJob, origSelf, origInstallSelf := codeServerRunJob, codeServerSelfPath, codeServerInstallSelfPath
	t.Cleanup(func() {
		codeServerSessionExists, codeServerSpawn, codeServerUserHomeDir = origExists, origSpawn, origHome
		codeServerRunJob, codeServerSelfPath, codeServerInstallSelfPath = origJob, origSelf, origInstallSelf
	})

	codeServerSessionExists = func(context.Context) bool { return sessionExists }
	codeServerSpawn = func(_ context.Context, args ...string) error {
		*spawned = append(*spawned, args)
		return nil
	}
	codeServerUserHomeDir = func() (string, error) { return home, nil }
	codeServerRunJob = func(_ context.Context, window string, argv []string) (JobTarget, bool, error) {
		*jobs = append(*jobs, append([]string{window}, argv...))
		return JobTarget{Session: JobsSessionName, Window: window, WindowID: "@1"}, true, nil
	}
	codeServerSelfPath = func() (string, error) { return "/usr/local/bin/rk", nil }
	codeServerInstallSelfPath = func() (string, error) { return "/usr/local/bin/rk", nil }
	return spawned, jobs, home
}

// freeLoopbackPort returns a port that was just free on 127.0.0.1.
func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

// seededSettingsPath is the profile settings file under a test home.
func seededSettingsPath(home string) string {
	return filepath.Join(home, ".rk", "code-server-profile", "User", "settings.json")
}

func TestEnsureCodeServerSpawnsSiblingSession(t *testing.T) {
	stubDir := testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	port := freeLoopbackPort(t)
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(port))
	t.Setenv("XDG_DATA_HOME", "") // force the ~/.local/share fallback
	spawned, _, home := withCodeServerSeams(t, false)

	ensureCodeServer()

	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(*spawned))
	}
	got := strings.Join((*spawned)[0], " ")
	want := fmt.Sprintf(
		"new-session -d -s rk-code-server -n code-server env -u VSCODE_IPC_HOOK_CLI RK_BIN=/usr/local/bin/rk %s --bind-addr 127.0.0.1:%d --auth none --disable-telemetry --disable-update-check --disable-workspace-trust --disable-getting-started-override --app-name run-kit --user-data-dir %s --extensions-dir %s",
		filepath.Join(stubDir, "code-server"), // the ladder's PATH rung resolves absolute
		port,
		filepath.Join(home, ".rk", "code-server-profile"),
		filepath.Join(home, ".local", "share", "code-server", "extensions"),
	)
	if got != want {
		t.Errorf("spawn argv =\n%s\nwant:\n%s", got, want)
	}
}

// --- R3: RK_BIN in the spawn argv ---

func TestEnsureCodeServerSpawnCarriesRkBin(t *testing.T) {
	stubDir := testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	spawned, _, _ := withCodeServerSeams(t, false)
	codeServerSelfPath = func() (string, error) { return "/x/bin/rk", nil }

	ensureCodeServer()

	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(*spawned))
	}
	args := (*spawned)[0]
	// RK_BIN must sit immediately after `-u VSCODE_IPC_HOOK_CLI` and before the
	// code-server binary: env assignments precede the command they apply to.
	i := -1
	for j, a := range args {
		if a == "VSCODE_IPC_HOOK_CLI" {
			i = j
		}
	}
	if i < 0 || i+2 >= len(args) {
		t.Fatalf("spawn argv = %v, want `-u VSCODE_IPC_HOOK_CLI RK_BIN=… <binary>`", args)
	}
	if args[i+1] != "RK_BIN=/x/bin/rk" {
		t.Errorf("element after VSCODE_IPC_HOOK_CLI = %q, want RK_BIN=/x/bin/rk", args[i+1])
	}
	if want := filepath.Join(stubDir, "code-server"); args[i+2] != want {
		t.Errorf("element after RK_BIN = %q, want the code-server binary %q", args[i+2], want)
	}
}

func TestEnsureCodeServerSpawnCarriesLauncherRkBinOnBrew(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	spawned, _, _ := withCodeServerSeams(t, false)
	// The default seam is selfpath.LauncherOrStable; stub the launcher-half
	// derivation over a synthetic home so the assertion pins the rk-owned
	// launcher symlink.
	codeServerSelfPath = func() (string, error) {
		return selfpath.LauncherFor("/h"), nil
	}

	ensureCodeServer()

	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(*spawned))
	}
	args := (*spawned)[0]
	i := -1
	for j, a := range args {
		if a == "VSCODE_IPC_HOOK_CLI" {
			i = j
		}
	}
	if i < 0 || i+1 >= len(args) {
		t.Fatalf("spawn argv = %v, want `-u VSCODE_IPC_HOOK_CLI RK_BIN=… <binary>`", args)
	}
	if args[i+1] != "RK_BIN=/h/.local/share/rk/bin/run-kit" {
		t.Errorf("element after VSCODE_IPC_HOOK_CLI = %q, want RK_BIN=/h/.local/share/rk/bin/run-kit", args[i+1])
	}
	for _, a := range args {
		if strings.Contains(a, "/Cellar/") {
			t.Errorf("spawn argv = %v, want no version-pinned /Cellar/ element", args)
		}
	}
}

func TestEnsureCodeServerInstallJobCarriesStableRkPathOnBrew(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	_, jobs, _ := withCodeServerSeams(t, false)
	// The install chain resolves through its own stable-path seam — never the
	// launcher, which may not exist (setup is optional) and whose Cellar target
	// a mid-download brew upgrade can delete. The launcher stubbed on the
	// RK_BIN seam must NOT leak into the job argv.
	codeServerSelfPath = func() (string, error) {
		return selfpath.LauncherFor("/h"), nil
	}
	codeServerInstallSelfPath = func() (string, error) {
		return selfpath.StableFor("/opt/homebrew/Cellar/run-kit/1.2.3/bin/run-kit"), nil
	}

	ensureCodeServer()

	if len(*jobs) != 1 {
		t.Fatalf("job spawns = %d, want 1", len(*jobs))
	}
	want := `'/opt/homebrew/bin/run-kit' code-server install && '/opt/homebrew/bin/run-kit' code-server start`
	if got := (*jobs)[0][1]; got != want {
		t.Errorf("job argv = %q, want the stable-path chain %q", got, want)
	}
}

func TestEnsureCodeServerSpawnOmitsRkBinOnSelfPathError(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	spawned, _, _ := withCodeServerSeams(t, false)
	codeServerSelfPath = func() (string, error) { return "", fmt.Errorf("no self path") }

	ensureCodeServer()

	// The spawn still runs; only the RK_BIN element is dropped.
	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1 (self-path failure must not block the spawn)", len(*spawned))
	}
	for _, a := range (*spawned)[0] {
		if strings.HasPrefix(a, "RK_BIN=") {
			t.Errorf("spawn argv = %v, want no RK_BIN= element when self-path resolution fails", (*spawned)[0])
		}
	}
}

func TestEnsureCodeServerSeedsSettingsWhenAbsent(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	spawned, _, home := withCodeServerSeams(t, false)

	ensureCodeServer()

	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(*spawned))
	}
	got, err := os.ReadFile(seededSettingsPath(home))
	if err != nil {
		t.Fatalf("seeded settings.json unreadable: %v", err)
	}
	if string(got) != codeServerSeedSettings {
		t.Errorf("seeded settings.json =\n%s\nwant:\n%s", got, codeServerSeedSettings)
	}
	if !strings.Contains(string(got), `"rk.bridge.enabled": true`) {
		t.Errorf("seeded settings.json must enable the code bridge, got:\n%s", got)
	}
}

func TestEnsureCodeServerPreservesExistingSettings(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	spawned, _, home := withCodeServerSeams(t, false)

	const userContent = `{"workbench.startupEditor": "welcomePage"}`
	path := seededSettingsPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(userContent), 0o644); err != nil {
		t.Fatal(err)
	}

	ensureCodeServer()

	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(*spawned))
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != userContent {
		t.Errorf("existing settings.json modified:\n%s\nwant untouched:\n%s", got, userContent)
	}
}

func TestEnsureCodeServerExtensionsDirHonorsXDGDataHome(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	t.Setenv("XDG_DATA_HOME", "/custom/data")
	spawned, _, _ := withCodeServerSeams(t, false)

	ensureCodeServer()

	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(*spawned))
	}
	got := strings.Join((*spawned)[0], " ")
	want := "--extensions-dir " + filepath.Join("/custom/data", "code-server", "extensions")
	if !strings.Contains(got, want) {
		t.Errorf("spawn argv = %q, want it to contain %q", got, want)
	}
}

func TestEnsureCodeServerSeedFailureKeepsProfileFlags(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	t.Setenv("XDG_DATA_HOME", "") // deterministic extensions-dir fallback
	spawned, _, home := withCodeServerSeams(t, false)

	// A FILE at ~/.rk makes MkdirAll under it fail — the seed errors, but the
	// spawn must still carry both profile flags (code-server creates its own
	// user-data-dir; the only degradation is an unseeded profile).
	if err := os.WriteFile(filepath.Join(home, ".rk"), []byte("not a dir"), 0o644); err != nil {
		t.Fatal(err)
	}

	ensureCodeServer()

	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(*spawned))
	}
	got := strings.Join((*spawned)[0], " ")
	if !strings.Contains(got, "--user-data-dir "+filepath.Join(home, ".rk", "code-server-profile")) {
		t.Errorf("spawn argv = %q, want --user-data-dir despite the failed seed", got)
	}
	if !strings.Contains(got, "--extensions-dir "+filepath.Join(home, ".local", "share", "code-server", "extensions")) {
		t.Errorf("spawn argv = %q, want --extensions-dir despite the failed seed", got)
	}
}

func TestEnsureCodeServerHomeFailureDropsProfileFlags(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	spawned, _, _ := withCodeServerSeams(t, false)
	codeServerUserHomeDir = func() (string, error) { return "", fmt.Errorf("no home") }

	ensureCodeServer()

	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(*spawned))
	}
	got := strings.Join((*spawned)[0], " ")
	if strings.Contains(got, "--user-data-dir") || strings.Contains(got, "--extensions-dir") {
		t.Errorf("spawn argv = %q, want the pre-profile argv when home is unresolvable", got)
	}
	if !strings.HasSuffix(got, "--app-name run-kit") {
		t.Errorf("spawn argv = %q, want it to end at the curation flags", got)
	}
}

func TestEnsureCodeServerSkipsWhenSessionExists(t *testing.T) {
	spawned, jobs, _ := withCodeServerSeams(t, true)

	ensureCodeServer()

	if len(*spawned) != 0 {
		t.Errorf("spawn calls = %d, want 0 (session already managed)", len(*spawned))
	}
	if len(*jobs) != 0 {
		t.Errorf("job spawns = %d, want 0 (session already managed)", len(*jobs))
	}
}

func TestEnsureCodeServerSkipsWhenPortListening(t *testing.T) {
	// A REAL loopback listener drives the externally-managed-instance branch —
	// no seam needed for the port probe.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(ln.Addr().(*net.TCPAddr).Port))
	spawned, jobs, home := withCodeServerSeams(t, false)

	ensureCodeServer()

	if len(*spawned) != 0 {
		t.Errorf("spawn calls = %d, want 0 (port already serving)", len(*spawned))
	}
	if len(*jobs) != 0 {
		t.Errorf("job spawns = %d, want 0 (port already serving)", len(*jobs))
	}
	// The externally managed instance gets no seed either — the seed runs on
	// the spawn branch only.
	if _, err := os.Stat(seededSettingsPath(home)); err == nil {
		t.Error("settings.json seeded for an externally managed instance, want no write")
	}
}

func TestEnsureCodeServerConventionPort(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	// Convention resolution: no preset, RK_PORT+2 must be free — pick a free
	// port P and set RK_PORT=P-2.
	port := freeLoopbackPort(t)
	t.Setenv("RK_PORT", fmt.Sprint(port-2))
	t.Setenv("RK_CODE_SERVER_PORT", "")
	spawned, _, _ := withCodeServerSeams(t, false)

	ensureCodeServer()

	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(*spawned))
	}
	got := strings.Join((*spawned)[0], " ")
	if !strings.Contains(got, fmt.Sprintf("--bind-addr 127.0.0.1:%d", port)) {
		t.Errorf("spawn argv = %q, want bind to the convention port %d", got, port)
	}
}

func TestEnsureCodeServerSpawnFailureNeverPropagates(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	_, _, _ = withCodeServerSeams(t, false)
	codeServerSpawn = func(context.Context, ...string) error { return fmt.Errorf("tmux exploded") }

	ensureCodeServer() // must not panic; the error is logged and swallowed
}

// --- R6: the two-rung resolution ladder ---

// installManagedBinary materializes a managed install under the test home:
// <home>/.rk/code-server-bin/<version>/bin/code-server (executable) with the
// current symlink flipped to it. Returns the SPAWNED path — the ladder hands
// back the current-symlink path (a flipped symlink + respawn picks up the new
// version), not the version dir.
func installManagedBinary(t *testing.T, home, version string) string {
	t.Helper()
	bin := filepath.Join(codeserver.VersionDir(home, version), "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "code-server"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(version, codeserver.CurrentPath(home)); err != nil {
		t.Fatal(err)
	}
	return codeserver.BinaryPath(home)
}

func TestResolveCodeServerBinaryManagedWins(t *testing.T) {
	stubDir := testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	_, _, home := withCodeServerSeams(t, false)
	managed := installManagedBinary(t, home, "4.132.0")

	got := resolveCodeServerBinary(home)
	if got != managed {
		t.Errorf("resolveCodeServerBinary = %q, want the managed path %q (rung 1 wins over PATH %q)", got, managed, filepath.Join(stubDir, "code-server"))
	}
}

func TestResolveCodeServerBinaryPathFallback(t *testing.T) {
	stubDir := testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	_, _, home := withCodeServerSeams(t, false) // no managed install under home

	got := resolveCodeServerBinary(home)
	want := filepath.Join(stubDir, "code-server")
	if got != want {
		t.Errorf("resolveCodeServerBinary = %q, want the PATH rung %q", got, want)
	}
}

func TestResolveCodeServerBinaryMissing(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir) // PATH replacement — code-server must NOT resolve
	_, _, home := withCodeServerSeams(t, false)

	if got := resolveCodeServerBinary(home); got != "" {
		t.Errorf("resolveCodeServerBinary = %q, want \"\" (neither rung resolves)", got)
	}
}

func TestEnsureCodeServerSpawnsManagedAbsolutePath(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n") // PATH also has one — managed still wins
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	spawned, _, home := withCodeServerSeams(t, false)
	managed := installManagedBinary(t, home, "4.132.0")

	ensureCodeServer()

	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(*spawned))
	}
	got := strings.Join((*spawned)[0], " ")
	if !strings.Contains(got, " "+managed+" --bind-addr") {
		t.Errorf("spawn argv = %q, want the managed absolute path %q as the binary", got, managed)
	}
}

// --- R7: one-shot profile migration ---

func TestMigrateCodeServerProfileRenames(t *testing.T) {
	_, _, home := withCodeServerSeams(t, false)
	oldDir := codeServerLegacyProfileDir(home)
	marker := filepath.Join(oldDir, "User", "settings.json")
	if err := os.MkdirAll(filepath.Dir(marker), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := migrateCodeServerProfile(home); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(oldDir); !os.IsNotExist(err) {
		t.Error("legacy dir still present after migration")
	}
	if _, err := os.Stat(filepath.Join(codeServerProfileDir(home), "User", "settings.json")); err != nil {
		t.Errorf("settings.json did not survive the rename: %v", err)
	}
}

func TestMigrateCodeServerProfileBothExistLeavesBoth(t *testing.T) {
	_, _, home := withCodeServerSeams(t, false)
	for _, dir := range []string{codeServerLegacyProfileDir(home), codeServerProfileDir(home)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	if err := migrateCodeServerProfile(home); err != nil {
		t.Fatal(err)
	}

	// New wins; the legacy dir is left untouched (never destroyed).
	for _, dir := range []string{codeServerLegacyProfileDir(home), codeServerProfileDir(home)} {
		if _, err := os.Stat(dir); err != nil {
			t.Errorf("%s missing after the both-exist no-op: %v", dir, err)
		}
	}
}

func TestMigrateCodeServerProfileFreshHostNoOp(t *testing.T) {
	_, _, home := withCodeServerSeams(t, false)

	if err := migrateCodeServerProfile(home); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(codeServerProfileDir(home)); !os.IsNotExist(err) {
		t.Error("profile dir created by migration — the seed owns creation on a fresh host")
	}
}

// --- R8: missing binary spawns the install job ---

func TestEnsureCodeServerSpawnsInstallJobWhenBinaryMissing(t *testing.T) {
	// PATH replacement (not StubOnPath): code-server must NOT resolve.
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	spawned, jobs, _ := withCodeServerSeams(t, false)

	// Must not panic or error-propagate — the caller (startSession) still
	// brings up rk serve — and must return WITHOUT blocking on the download.
	ensureCodeServer()

	if len(*spawned) != 0 {
		t.Errorf("spawn calls = %d, want 0 (binary absent)", len(*spawned))
	}
	if len(*jobs) != 1 {
		t.Fatalf("job spawns = %d, want 1 (the install-then-start job)", len(*jobs))
	}
	job := (*jobs)[0]
	if job[0] != "code-server-install" {
		t.Errorf("job window = %q, want code-server-install", job[0])
	}
	want := `'/usr/local/bin/rk' code-server install && '/usr/local/bin/rk' code-server start`
	if len(job) != 2 || job[1] != want {
		t.Errorf("job argv = %q, want the single-element quoted chain %q", job[1:], want)
	}
}

func TestEnsureCodeServerInstallJobQuotesExePath(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	_, jobs, _ := withCodeServerSeams(t, false)
	codeServerInstallSelfPath = func() (string, error) { return "/Users/Jane Doe/bin/rk", nil }

	ensureCodeServer()

	if len(*jobs) != 1 {
		t.Fatalf("job spawns = %d, want 1", len(*jobs))
	}
	want := `'/Users/Jane Doe/bin/rk' code-server install && '/Users/Jane Doe/bin/rk' code-server start`
	if got := (*jobs)[0][1]; got != want {
		t.Errorf("job argv = %q, want the shell-quoted chain %q", got, want)
	}
}

func TestEnsureCodeServerInstallJobDedupLeavesLiveWindow(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	spawned, _, _ := withCodeServerSeams(t, false)
	codeServerRunJob = func(_ context.Context, window string, argv []string) (JobTarget, bool, error) {
		return JobTarget{Session: JobsSessionName, Window: window, WindowID: "@9"}, false, nil // live ⇒ in-flight
	}

	ensureCodeServer() // started=false must stay a quiet no-op, not a second spawn

	if len(*spawned) != 0 {
		t.Errorf("spawn calls = %d, want 0", len(*spawned))
	}
}

// --- R10: the exported CLI start path ---

// withDaemonGate substitutes the daemon-liveness seam (jobs.go's
// jobDaemonRunning) for one test. Restores via t.Cleanup.
func withDaemonGate(t *testing.T, running bool) {
	t.Helper()
	orig := jobDaemonRunning
	t.Cleanup(func() { jobDaemonRunning = orig })
	jobDaemonRunning = func(context.Context) bool { return running }
}

func TestStartCodeServerDaemonDown(t *testing.T) {
	withDaemonGate(t, false)

	_, err := StartCodeServer()
	if err == nil || !strings.Contains(err.Error(), "rk serve -d") {
		t.Errorf("err = %v, want an operational error naming `rk serve -d`", err)
	}
}

func TestStartCodeServerAlreadyRunning(t *testing.T) {
	withDaemonGate(t, true)
	spawned, _, _ := withCodeServerSeams(t, true)

	outcome, err := StartCodeServer()
	if err != nil {
		t.Fatal(err)
	}
	if outcome != EnsureAlreadyRunning {
		t.Errorf("outcome = %v, want EnsureAlreadyRunning", outcome)
	}
	if len(*spawned) != 0 {
		t.Errorf("spawn calls = %d, want 0 (session already managed)", len(*spawned))
	}
}

func TestStartCodeServerMissingBinaryIsOperationalError(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	withDaemonGate(t, true)
	_, jobs, _ := withCodeServerSeams(t, false)

	_, err := StartCodeServer()
	if err == nil || !strings.Contains(err.Error(), "rk code-server install") {
		t.Errorf("err = %v, want an operational error naming `rk code-server install`", err)
	}
	if len(*jobs) != 0 {
		t.Errorf("job spawns = %d, want 0 — the CLI posture never spawns the job", len(*jobs))
	}
}

func TestStartCodeServerSpawns(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	withDaemonGate(t, true)
	spawned, _, _ := withCodeServerSeams(t, false)

	outcome, err := StartCodeServer()
	if err != nil {
		t.Fatal(err)
	}
	if outcome != EnsureStarted {
		t.Errorf("outcome = %v, want EnsureStarted", outcome)
	}
	if len(*spawned) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(*spawned))
	}
}

// --- KillCodeServerSession (R11's respawn half) ---

func TestKillCodeServerSessionAbsentIsNoop(t *testing.T) {
	// Absence short-circuits before any tmux call, so no runTmux seam is
	// needed — a live tmux server would still see no kill-session.
	_, _, _ = withCodeServerSeams(t, false)
	killed, err := KillCodeServerSession()
	if err != nil {
		t.Fatalf("absent session must be a no-op, got %v", err)
	}
	if killed {
		t.Error("killed = true, want false — nothing existed to kill")
	}
}

func TestKillCodeServerSessionPresentKillsAndReports(t *testing.T) {
	withCodeServerSeams(t, true)
	origKill := codeServerKillRun
	t.Cleanup(func() { codeServerKillRun = origKill })
	var gotArgs []string
	codeServerKillRun = func(_ context.Context, args ...string) error {
		gotArgs = args
		return nil
	}

	killed, err := KillCodeServerSession()
	if err != nil {
		t.Fatal(err)
	}
	if !killed {
		t.Error("killed = false, want true — the session existed and the kill succeeded")
	}
	want := []string{"kill-session", "-t", "=" + CodeServerSessionName}
	if len(gotArgs) != len(want) {
		t.Fatalf("kill argv = %v, want %v", gotArgs, want)
	}
	for i := range want {
		if gotArgs[i] != want[i] {
			t.Fatalf("kill argv = %v, want the exact-match %v", gotArgs, want)
		}
	}
}

func TestKillCodeServerSessionKillErrorReportsNotKilled(t *testing.T) {
	withCodeServerSeams(t, true)
	origKill := codeServerKillRun
	t.Cleanup(func() { codeServerKillRun = origKill })
	codeServerKillRun = func(context.Context, ...string) error {
		return fmt.Errorf("tmux exited 1")
	}
	probed := false
	origBusy := codeServerPortBusy
	t.Cleanup(func() { codeServerPortBusy = origBusy })
	codeServerPortBusy = func() bool { probed = true; return false }

	killed, err := KillCodeServerSession()
	if err == nil {
		t.Fatal("err = nil, want the wrapped kill failure")
	}
	if killed {
		t.Error("killed = true, want false on a failed kill")
	}
	if probed {
		t.Error("port probed after a failed kill — the wait is gated on a successful kill")
	}
}

// --- the kill→rebind race window: the port-release wait lives in the kill ---

// shrinkPortFreeWait shrinks the port-free wait vars so the never-frees branch
// runs without burning wall-clock (the withStopTiming idiom).
func shrinkPortFreeWait(t *testing.T) {
	t.Helper()
	origTimeout, origPoll := codeServerPortFreeTimeout, codeServerPortFreePoll
	t.Cleanup(func() { codeServerPortFreeTimeout, codeServerPortFreePoll = origTimeout, origPoll })
	codeServerPortFreeTimeout = 20 * time.Millisecond
	codeServerPortFreePoll = time.Millisecond
}

// stubCodeServerPortBusy swaps the port probe for the given scripted function
// and returns a probe counter.
func stubCodeServerPortBusy(t *testing.T, fn func(probes int) bool) *int {
	t.Helper()
	probes := new(int)
	orig := codeServerPortBusy
	t.Cleanup(func() { codeServerPortBusy = orig })
	codeServerPortBusy = func() bool { *probes++; return fn(*probes) }
	return probes
}

// (a) Killed session, port busy then freed: the kill returns only after the
// port probe reports free — a kill+start composition can no longer observe the
// dying instance.
func TestKillCodeServerSessionWaitsForPortToFree(t *testing.T) {
	withCodeServerSeams(t, true)
	origKill := codeServerKillRun
	t.Cleanup(func() { codeServerKillRun = origKill })
	codeServerKillRun = func(context.Context, ...string) error { return nil }
	probes := stubCodeServerPortBusy(t, func(p int) bool { return p <= 2 }) // busy, busy, free

	killed, err := KillCodeServerSession()
	if err != nil || !killed {
		t.Fatalf("got (%v, %v), want (true, nil)", killed, err)
	}
	if *probes < 3 {
		t.Errorf("port probes = %d, want the wait to poll past the busy reports before returning", *probes)
	}
}

// (b) Killed session, port never frees: the budget expires and the kill
// returns normally — the caller's externally-managed classification then fires
// exactly as without the wait; no new failure mode.
func TestKillCodeServerSessionPortNeverFreesBudgetExpires(t *testing.T) {
	withCodeServerSeams(t, true)
	shrinkPortFreeWait(t)
	origKill := codeServerKillRun
	t.Cleanup(func() { codeServerKillRun = origKill })
	codeServerKillRun = func(context.Context, ...string) error { return nil }
	probes := stubCodeServerPortBusy(t, func(int) bool { return true })

	start := time.Now()
	killed, err := KillCodeServerSession()
	if err != nil || !killed {
		t.Fatalf("got (%v, %v), want (true, nil) — budget expiry is non-fatal", killed, err)
	}
	if *probes < 2 {
		t.Errorf("port probes = %d, want the wait to keep polling until the budget expired", *probes)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("wait outlasted its budget: %v", elapsed)
	}
}

// (c) No session existed (killed=false): no wait — the port probe is never
// consulted. A busy port here belongs to a genuinely externally managed
// instance that will not release it.
func TestKillCodeServerSessionAbsentNeverProbesPort(t *testing.T) {
	withCodeServerSeams(t, false)
	probes := stubCodeServerPortBusy(t, func(int) bool { return true })

	killed, err := KillCodeServerSession()
	if err != nil || killed {
		t.Fatalf("got (%v, %v), want (false, nil)", killed, err)
	}
	if *probes != 0 {
		t.Errorf("port probes = %d, want 0 — nothing died, nothing to wait for", *probes)
	}
}

// --- CodeServerSessionCommand (260813-2s4u) ---

func TestCodeServerSessionCommandAbsent(t *testing.T) {
	withCodeServerSeams(t, false)
	cmd, exists, err := CodeServerSessionCommand()
	if cmd != "" || exists || err != nil {
		t.Fatalf("got (%q, %v, %v), want (\"\", false, nil) for an absent session", cmd, exists, err)
	}
}

func TestCodeServerSessionCommandReadsFirstLine(t *testing.T) {
	withCodeServerSeams(t, true)
	origPane := codeServerPaneCommand
	t.Cleanup(func() { codeServerPaneCommand = origPane })
	var gotTarget string
	codeServerPaneCommand = func(_ context.Context, target string) ([]byte, error) {
		gotTarget = target
		// Two lines: a manual split adds a second pane — the first line wins.
		return []byte("env -u VSCODE_IPC_HOOK_CLI /x/bin/code-server --auth none\nzsh\n"), nil
	}

	cmd, exists, err := CodeServerSessionCommand()
	if err != nil || !exists {
		t.Fatalf("got (exists=%v, err=%v), want an inspectable session", exists, err)
	}
	if want := "=" + CodeServerSessionName + ":=" + CodeServerWindowName; gotTarget != want {
		t.Errorf("target = %q, want the exact-match %q", gotTarget, want)
	}
	if want := "env -u VSCODE_IPC_HOOK_CLI /x/bin/code-server --auth none"; cmd != want {
		t.Errorf("cmd = %q, want the first line %q", cmd, want)
	}
}

func TestCodeServerSessionCommandQueryErrorIsUncertain(t *testing.T) {
	withCodeServerSeams(t, true)
	origPane := codeServerPaneCommand
	t.Cleanup(func() { codeServerPaneCommand = origPane })
	codeServerPaneCommand = func(context.Context, string) ([]byte, error) {
		return nil, fmt.Errorf("no such window")
	}

	_, exists, err := CodeServerSessionCommand()
	if !exists || err == nil {
		t.Fatalf("got (exists=%v, err=%v), want (true, non-nil) — existing but uninspectable is uncertain evidence", exists, err)
	}
}

// --- RestartCodeServer (the lens empty state's restart action) ---

func TestRestartCodeServerMissingBinarySpawnsInstallJob(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	withDaemonGate(t, true)
	_, jobs, _ := withCodeServerSeams(t, false)

	outcome, err := RestartCodeServer()
	if err != nil || outcome != EnsureInstallJobSpawned {
		t.Fatalf("got (%v, %v), want (EnsureInstallJobSpawned, nil)", outcome, err)
	}
	if len(*jobs) != 1 {
		t.Errorf("job spawns = %d, want 1", len(*jobs))
	}
}

func TestRestartCodeServerWaitsForPortUp(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	withDaemonGate(t, true)
	spawned, _, _ := withCodeServerSeams(t, false)
	shrinkPortFreeWait(t)
	probes := stubCodeServerPortBusy(t, func(p int) bool { return p >= 3 }) // down, down, up

	outcome, err := RestartCodeServer()
	if err != nil || outcome != EnsureStarted {
		t.Fatalf("got (%v, %v), want (EnsureStarted, nil)", outcome, err)
	}
	if len(*spawned) != 1 || *probes < 3 {
		t.Errorf("spawns = %d, probes = %d; want 1 spawn and a wait past the down reports", len(*spawned), *probes)
	}
}

func TestRestartCodeServerNeverComesUpIsError(t *testing.T) {
	testutil.StubOnPath(t, "code-server", "#!/bin/sh\nexit 0\n")
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	withDaemonGate(t, true)
	withCodeServerSeams(t, false)
	shrinkPortFreeWait(t)
	orig := codeServerPortUpTimeout
	t.Cleanup(func() { codeServerPortUpTimeout = orig })
	codeServerPortUpTimeout = 20 * time.Millisecond
	stubCodeServerPortBusy(t, func(int) bool { return false })

	if _, err := RestartCodeServer(); err == nil || !strings.Contains(err.Error(), "did not come up") {
		t.Errorf("err = %v, want a did-not-come-up error", err)
	}
}

// A kill that spends most of the shared cmdTimeout (a hung session's
// port-free wait) must not starve the install-job spawn that follows.
func TestRestartCodeServerInstallJobGetsFreshBudget(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	withDaemonGate(t, true)
	withCodeServerSeams(t, false)
	exists := 0
	codeServerSessionExists = func(context.Context) bool { exists++; return exists == 1 } // live for the kill only
	origKill := codeServerKillRun
	t.Cleanup(func() { codeServerKillRun = origKill })
	codeServerKillRun = func(context.Context, ...string) error { time.Sleep(1500 * time.Millisecond); return nil }
	stubCodeServerPortBusy(t, func(int) bool { return false })
	var remaining time.Duration
	codeServerRunJob = func(ctx context.Context, window string, _ []string) (JobTarget, bool, error) {
		dl, _ := ctx.Deadline()
		remaining = time.Until(dl)
		return JobTarget{Window: window}, true, nil
	}

	if outcome, err := RestartCodeServer(); err != nil || outcome != EnsureInstallJobSpawned {
		t.Fatalf("got (%v, %v), want (EnsureInstallJobSpawned, nil)", outcome, err)
	}
	if remaining < cmdTimeout-time.Second {
		t.Errorf("install job ctx had %v left, want a fresh ~%v budget", remaining, cmdTimeout)
	}
}

func TestRestartCodeServerInstallJobFailureIsError(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("RK_CODE_SERVER_PORT", fmt.Sprint(freeLoopbackPort(t)))
	withDaemonGate(t, true)
	withCodeServerSeams(t, false)
	codeServerRunJob = func(context.Context, string, []string) (JobTarget, bool, error) {
		return JobTarget{}, false, context.DeadlineExceeded
	}

	if _, err := RestartCodeServer(); err == nil || !strings.Contains(err.Error(), "install job failed to start") {
		t.Errorf("err = %v, want the install-job failure surfaced", err)
	}
}
