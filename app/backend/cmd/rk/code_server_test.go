package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"

	"strings"
	"testing"

	"rk/internal/codeserver"
	"rk/internal/daemon"

	"github.com/spf13/cobra"
)

// --- seams + fixtures ---

// bareCmd returns a cobra command with the given output buffers — the
// package's direct-RunE test idiom (newSink falls back to the package-level
// quiet var when the command carries no flag set).
func bareCmd(out, errOut *bytes.Buffer) *cobra.Command {
	cmd := &cobra.Command{}
	cmd.SetOut(out)
	cmd.SetErr(errOut)
	return cmd
}

// withCodeServerCLISeams points the CLI's home/installer/start/kill seams at a
// temp home and (optionally) an httptest release server, returning recorders
// for the kill/start calls. HOME and XDG_STATE_HOME are also redirected: the
// codeserver package resolves its layout from the environment (apphome), so
// the seam alone cannot keep the real state home untouched. Restores via
// t.Cleanup.
func withCodeServerCLISeams(t *testing.T, home string, srv *httptest.Server) (kills, starts *int) {
	t.Helper()
	kills, starts = new(int), new(int)
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "") // force the ~/.local/state fallback under the temp home

	origHome, origNew := codeServerUserHomeFn, newCodeServerInstallerFn
	origStart, origKill := codeServerStartFn, codeServerKillFn
	origRunning, origSession := codeServerDaemonRunningFn, codeServerSessionCommandFn
	origEmbedded, origBridgeInstall := codeBridgeEmbeddedFn, installBridgeExtensionFn
	t.Cleanup(func() {
		codeServerUserHomeFn, newCodeServerInstallerFn = origHome, origNew
		codeServerStartFn, codeServerKillFn = origStart, origKill
		codeServerDaemonRunningFn, codeServerSessionCommandFn = origRunning, origSession
		codeBridgeEmbeddedFn, installBridgeExtensionFn = origEmbedded, origBridgeInstall
	})

	// Hermetic defaults for the respawn seams: daemon up, no session — the
	// migration respawn is a strict no-op unless a test opts in. Never leave
	// the real probes wired (they would touch a live tmux socket).
	codeServerDaemonRunningFn = func() bool { return true }
	codeServerSessionCommandFn = func() (string, bool, error) { return "", false, nil }

	// Hermetic default for the bridge step: a dev build (no bundled VSIX), so
	// the extension install never runs unless a test opts in via
	// stubBridgeStep.
	codeBridgeEmbeddedFn = func() ([]byte, string, bool) { return nil, "", false }

	codeServerUserHomeFn = func() (string, error) { return home, nil }
	if srv != nil {
		newCodeServerInstallerFn = func() *codeserver.Installer {
			ins := codeserver.New()
			ins.APIBase = srv.URL
			ins.Client = srv.Client()
			ins.GOOS, ins.GOARCH = "linux", "amd64"
			return ins
		}
	}
	codeServerKillFn = func() (bool, error) { *kills++; return true, nil }
	codeServerStartFn = func() (daemon.EnsureOutcome, error) { *starts++; return daemon.EnsureStarted, nil }
	return kills, starts
}

// csTarball builds a minimal code-server-shaped release tarball in memory.
func csTarball(t *testing.T, version string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	top := "code-server-" + version + "-linux-amd64"
	entry := "#!/bin/sh\n"
	for _, hdr := range []*tar.Header{
		{Name: top + "/", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: top + "/bin", Typeflag: tar.TypeDir, Mode: 0o755},
		{Name: top + "/bin/code-server", Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(entry))},
	} {
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			if _, err := tw.Write([]byte(entry)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// csReleaseServer serves the release listing and tarball for one version.
func csReleaseServer(t *testing.T, version string) *httptest.Server {
	t.Helper()
	payload := csTarball(t, version)
	sum := sha256.Sum256(payload)
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/coder/code-server/releases/latest":
			fmt.Fprintf(w, `{"tag_name":"v%s","assets":[{"name":"code-server-%s-linux-amd64.tar.gz","browser_download_url":%q,"digest":"sha256:%s"}]}`,
				version, version, srv.URL+"/dl/tarball", hex.EncodeToString(sum[:]))
		case "/dl/tarball":
			w.Write(payload)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// --- R9: registration + output convention ---

func TestCodeServerTreeRegistered(t *testing.T) {
	var parent *cobra.Command
	for _, c := range rootCmd.Commands() {
		if c.Name() == "code-server" {
			parent = c
		}
	}
	if parent == nil {
		t.Fatal("rk code-server is not registered on rootCmd")
	}
	if parent.Long == "" {
		t.Error("parent command has no Long block")
	}
	want := map[string]bool{"install": false, "start": false, "update": false}
	for _, c := range parent.Commands() {
		if _, ok := want[c.Name()]; ok {
			want[c.Name()] = true
			if c.Long == "" {
				t.Errorf("%s has no Long block", c.Name())
			}
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("subcommand %q not registered", name)
		}
	}
}

func TestCodeServerArgValidationIsUsageClass(t *testing.T) {
	for _, c := range codeServerCmd.Commands() {
		if err := c.Args(c, []string{"extra"}); err == nil {
			t.Errorf("%s accepted a positional arg", c.Name())
		} else if code := exitCode(err); code != exitUsage {
			t.Errorf("%s arg violation exit code = %d, want %d (usage)", c.Name(), code, exitUsage)
		}
	}
}

func TestCodeServerInstallOutcomeLines(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	withCodeServerCLISeams(t, home, srv)

	var out, errOut bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatal(err)
	}
	wantPath := codeserver.VersionDir(home, "4.132.0")
	if got, want := out.String(), fmt.Sprintf("Installed code-server v4.132.0 (%s).\n", wantPath); got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}

func TestCodeServerInstallAlreadyCurrentQuiet(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	withCodeServerCLISeams(t, home, srv)

	var out bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}

	// Second run under --quiet: stdout carries EXACTLY the outcome line and
	// stderr is empty (R9's GIVEN/WHEN/THEN).
	origQuiet := quiet
	quiet = true
	t.Cleanup(func() { quiet = origQuiet })
	out.Reset()
	var errOut bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("code-server v4.132.0 is already current (%s).\n", codeserver.VersionDir(home, "4.132.0"))
	if out.String() != want {
		t.Errorf("stdout = %q, want exactly %q", out.String(), want)
	}
	if errOut.Len() != 0 {
		t.Errorf("stderr = %q, want empty under --quiet", errOut.String())
	}
}

// --- R10: start ---

func TestCodeServerStartAlreadyRunning(t *testing.T) {
	withCodeServerCLISeams(t, t.TempDir(), nil)
	codeServerStartFn = func() (daemon.EnsureOutcome, error) { return daemon.EnsureAlreadyRunning, nil }

	var out bytes.Buffer
	if err := runCodeServerStart(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "already running") {
		t.Errorf("stdout = %q, want the already-running data line", out.String())
	}
}

func TestCodeServerStartDaemonDownPropagates(t *testing.T) {
	withCodeServerCLISeams(t, t.TempDir(), nil)
	codeServerStartFn = func() (daemon.EnsureOutcome, error) {
		return daemon.EnsureAlreadyRunning, fmt.Errorf("rk daemon is not running — start it with `rk serve -d`")
	}

	err := runCodeServerStart(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil || !strings.Contains(err.Error(), "rk serve -d") {
		t.Errorf("err = %v, want the daemon-down error naming `rk serve -d`", err)
	}
	if code := exitCode(err); code != 1 {
		t.Errorf("exit code = %d, want 1 (operational)", code)
	}
}

// --- R11: update ---

func TestCodeServerUpdateNotManagedSkips(t *testing.T) {
	home := t.TempDir() // no managed install (~/.local/state/hexokit/code-server/bin)
	kills, starts := withCodeServerCLISeams(t, home, nil)
	installerBuilt := false
	newCodeServerInstallerFn = func() *codeserver.Installer {
		installerBuilt = true
		return codeserver.New()
	}

	var out bytes.Buffer
	if err := runCodeServerUpdate(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "No rk-managed code-server install") {
		t.Errorf("stdout = %q, want the not-managed skip line", out.String())
	}
	if installerBuilt {
		t.Error("installer constructed despite the not-managed skip")
	}
	if *kills != 0 || *starts != 0 {
		t.Errorf("kills=%d starts=%d, want 0/0 — a PATH install is never touched", *kills, *starts)
	}
}

func TestCodeServerUpdateAlreadyCurrentNoRestart(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	kills, starts := withCodeServerCLISeams(t, home, srv)

	// Establish the managed install at the latest version.
	if err := runCodeServerInstall(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	if err := runCodeServerUpdate(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "already current") {
		t.Errorf("stdout = %q, want the already-current line", out.String())
	}
	if *kills != 0 || *starts != 0 {
		t.Errorf("kills=%d starts=%d, want 0/0 — already-current short-circuits the restart", *kills, *starts)
	}
}

func TestCodeServerUpdateChangedVersionRespawns(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	kills, starts := withCodeServerCLISeams(t, home, srv)
	if err := runCodeServerInstall(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}

	// Upstream moves to 4.133.0.
	srv2 := csReleaseServer(t, "4.133.0")
	origNew := newCodeServerInstallerFn
	newCodeServerInstallerFn = func() *codeserver.Installer {
		ins := codeserver.New()
		ins.APIBase = srv2.URL
		ins.Client = srv2.Client()
		ins.GOOS, ins.GOARCH = "linux", "amd64"
		return ins
	}
	t.Cleanup(func() { newCodeServerInstallerFn = origNew })

	var out bytes.Buffer
	if err := runCodeServerUpdate(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if *kills != 1 || *starts != 1 {
		t.Errorf("kills=%d starts=%d, want 1/1 — a version change respawns the session", *kills, *starts)
	}
	want := fmt.Sprintf("Updated code-server v4.132.0 -> v4.133.0 (%s).\n", codeserver.VersionDir(home, "4.133.0"))
	if !strings.Contains(out.String(), want) {
		t.Errorf("stdout = %q, want it to contain %q", out.String(), want)
	}
}

// The update flow prints "Restarting..." before the start call, but
// StartCodeServer can legitimately decline to respawn when the port is
// already externally served — the flow must then say so.
func TestCodeServerUpdateExternallyManagedNotesNoRespawn(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	withCodeServerCLISeams(t, home, srv)
	if err := runCodeServerInstall(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}

	// Upstream moves to 4.133.0, and the start seam reports the port as
	// externally managed instead of respawning.
	srv2 := csReleaseServer(t, "4.133.0")
	origNew := newCodeServerInstallerFn
	newCodeServerInstallerFn = func() *codeserver.Installer {
		ins := codeserver.New()
		ins.APIBase = srv2.URL
		ins.Client = srv2.Client()
		ins.GOOS, ins.GOARCH = "linux", "amd64"
		return ins
	}
	t.Cleanup(func() { newCodeServerInstallerFn = origNew })
	codeServerStartFn = func() (daemon.EnsureOutcome, error) { return daemon.EnsureExternallyManaged, nil }

	var out, errOut bytes.Buffer
	if err := runCodeServerUpdate(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errOut.String(), "externally managed code-server; the updated binary was not respawned") {
		t.Errorf("stderr = %q, want the externally-managed note", errOut.String())
	}
}

// --- R1/R4: the daemon gate on the respawn ---

// With the daemon down, an update that flipped versions must touch no tmux at
// all (no kill, no start — even the has-session probe would birth a server on
// a dead socket) and print the manual recovery chain.
func TestCodeServerUpdateDaemonDownNoKillNamesManualChain(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	kills, starts := withCodeServerCLISeams(t, home, srv)
	if err := runCodeServerInstall(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}

	srv2 := csReleaseServer(t, "4.133.0")
	origNew := newCodeServerInstallerFn
	newCodeServerInstallerFn = func() *codeserver.Installer {
		ins := codeserver.New()
		ins.APIBase = srv2.URL
		ins.Client = srv2.Client()
		ins.GOOS, ins.GOARCH = "linux", "amd64"
		return ins
	}
	t.Cleanup(func() { newCodeServerInstallerFn = origNew })
	codeServerDaemonRunningFn = func() bool { return false }

	var out bytes.Buffer
	if err := runCodeServerUpdate(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if *kills != 0 || *starts != 0 {
		t.Errorf("kills=%d starts=%d, want 0/0 — the gate fires before any tmux command", *kills, *starts)
	}
	if !strings.Contains(out.String(), "tmux -L rk-daemon kill-session -t '=rk-code-server' && rk code-server start") {
		t.Errorf("stdout = %q, want the manual recovery chain", out.String())
	}
	if !strings.Contains(out.String(), "Updated code-server v4.132.0 -> v4.133.0") {
		t.Errorf("stdout = %q, want the install outcome line — the flip itself succeeded", out.String())
	}
}

// --- the respawn kill→probe race window ---
// The port-release wait now lives inside daemon.KillCodeServerSession itself
// (release-synchronous kill primitive); its race-window behavior tests live in
// internal/daemon against the primitive. What stays CLI-owned here: the kill
// failure short-circuit and the externally-managed outcome classification.

// A kill failure still short-circuits before any start.
func TestRespawnKillErrorNoStart(t *testing.T) {
	withCodeServerCLISeams(t, t.TempDir(), nil)
	codeServerKillFn = func() (bool, error) { return false, fmt.Errorf("kill failed") }
	started := false
	codeServerStartFn = func() (daemon.EnsureOutcome, error) { started = true; return daemon.EnsureStarted, nil }

	out, err := respawnCodeServerSession(newSink(bareCmd(&bytes.Buffer{}, &bytes.Buffer{})), "4.133.0")
	if err == nil || out != respawnFailed {
		t.Fatalf("got (%v, %v), want (respawnFailed, non-nil)", out, err)
	}
	if started {
		t.Error("start ran after a kill error")
	}
}

// --- R2/R3: install's migration respawn ---

// installedAt establishes the managed install at the given version and returns
// the managed binary path (the classification anchor).
func installedAt(t *testing.T, home string) string {
	t.Helper()
	if err := runCodeServerInstall(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	managed := codeserver.ManagedBinary(home)
	if managed == "" {
		t.Fatal("managed binary not resolvable after install")
	}
	return managed
}

func TestCodeServerInstallMigratesForeignSession(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	kills, starts := withCodeServerCLISeams(t, home, srv)
	installedAt(t, home) // seed the managed install; the migration check runs on the re-run below

	// A brew-era session: its start command names a PATH binary, not the
	// managed current path.
	codeServerSessionCommandFn = func() (string, bool, error) {
		return "env -u VSCODE_IPC_HOOK_CLI code-server --bind-addr 127.0.0.1:3002 --auth none", true, nil
	}

	var out bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if *kills != 1 || *starts != 1 {
		t.Errorf("kills=%d starts=%d, want 1/1 — a foreign session is respawned", *kills, *starts)
	}
	if !strings.Contains(out.String(), "Respawned code-server onto the managed v4.132.0") {
		t.Errorf("stdout = %q, want the migration respawn data line", out.String())
	}
}

// The migration fires on the already-current outcome too — a re-run after a
// daemon-down skip must converge. (The test above IS the already-current case:
// the install was seeded first. This one pins the managed-session negative.)
func TestCodeServerInstallManagedSessionNoRespawn(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	kills, starts := withCodeServerCLISeams(t, home, srv)
	managed := installedAt(t, home)

	codeServerSessionCommandFn = func() (string, bool, error) {
		return "env -u VSCODE_IPC_HOOK_CLI " + managed + " --bind-addr 127.0.0.1:3002 --auth none", true, nil
	}

	var out bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if *kills != 0 || *starts != 0 {
		t.Errorf("kills=%d starts=%d, want 0/0 — a managed-rung session is never respawned by install", *kills, *starts)
	}
}

// No session ⇒ install's respawn step is a strict no-op — the rk-jobs
// `install && start` chain invariant (the job fires only when nothing was
// spawned, and start owns the spawn).
func TestCodeServerInstallNoSessionNoOp(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	kills, starts := withCodeServerCLISeams(t, home, srv)

	var out bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if *kills != 0 || *starts != 0 {
		t.Errorf("kills=%d starts=%d, want 0/0 — no session means nothing to migrate", *kills, *starts)
	}
	if strings.Contains(out.String(), "Respawned") {
		t.Errorf("stdout = %q, want no respawn line", out.String())
	}
}

func TestCodeServerInstallDaemonDownSkipsMigrationCheck(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	kills, starts := withCodeServerCLISeams(t, home, srv)
	codeServerDaemonRunningFn = func() bool { return false }
	sessionQueried := false
	codeServerSessionCommandFn = func() (string, bool, error) {
		sessionQueried = true
		return "", false, nil
	}

	var out bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if sessionQueried {
		t.Error("session inspected with the daemon down — the gate must fire before any tmux command")
	}
	if *kills != 0 || *starts != 0 {
		t.Errorf("kills=%d starts=%d, want 0/0", *kills, *starts)
	}
	if !strings.Contains(out.String(), "run `rk code-server install` again once the daemon is up") {
		t.Errorf("stdout = %q, want the re-run recovery line", out.String())
	}
}

// A query error on an existing session is uncertain evidence — note it, never
// kill on it.
func TestCodeServerInstallSessionQueryErrorSkips(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	kills, _ := withCodeServerCLISeams(t, home, srv)
	codeServerSessionCommandFn = func() (string, bool, error) {
		return "", true, fmt.Errorf("tmux query failed")
	}

	var out, errOut bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatal(err)
	}
	if *kills != 0 {
		t.Errorf("kills=%d, want 0 — never kill on uncertain evidence", *kills)
	}
	if !strings.Contains(errOut.String(), "leaving it untouched") {
		t.Errorf("stderr = %q, want the inspection-failure note", errOut.String())
	}
}

// The migration respawn respects the externally-managed outcome: the kill
// happened, the start declined, and the flow must not claim a respawn.
func TestCodeServerInstallMigrationExternallyManagedNoClaim(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	withCodeServerCLISeams(t, home, srv)
	installedAt(t, home)
	codeServerSessionCommandFn = func() (string, bool, error) {
		return "code-server --bind-addr 127.0.0.1:3002", true, nil
	}
	codeServerStartFn = func() (daemon.EnsureOutcome, error) { return daemon.EnsureExternallyManaged, nil }

	var out, errOut bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "Respawned code-server onto the managed") {
		t.Errorf("stdout = %q, want no respawn claim when the start declined", out.String())
	}
	if !strings.Contains(errOut.String(), "externally managed") {
		t.Errorf("stderr = %q, want the externally-managed note", errOut.String())
	}
}

// Guard the managed-dir gate against a stat error surfacing as a skip.
func TestCodeServerUpdateHomeErrorIsOperational(t *testing.T) {
	withCodeServerCLISeams(t, t.TempDir(), nil)
	codeServerUserHomeFn = func() (string, error) { return "", fmt.Errorf("no home") }

	err := runCodeServerUpdate(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil {
		t.Error("err = nil, want an operational error when home is unresolvable")
	}
}

// --- R7: the bridge-extension install step ---

// stubBridgeStep makes the extension seams report a bundled VSIX of the given
// version and scripts the install step's (changed, err) outcome, returning a
// call counter.
func stubBridgeStep(t *testing.T, version string, changed bool, stepErr error) (calls *int) {
	t.Helper()
	calls = new(int)
	codeBridgeEmbeddedFn = func() ([]byte, string, bool) { return []byte("VSIX"), version, true }
	installBridgeExtensionFn = func(context.Context, string, []byte, string, io.Writer) (bool, error) {
		*calls++
		return changed, stepErr
	}
	return calls
}

// A dev build (no bundled VSIX) skips the extension step with a note and
// never spawns the installer.
func TestCodeServerInstallDevBuildSkipsBridgeStep(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	withCodeServerCLISeams(t, home, srv)
	installRan := false
	installBridgeExtensionFn = func(context.Context, string, []byte, string, io.Writer) (bool, error) {
		installRan = true
		return false, nil
	}

	var out, errOut bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatal(err)
	}
	if installRan {
		t.Error("extension install ran without a bundled VSIX")
	}
	if !strings.Contains(errOut.String(), "skipping the extension install") {
		t.Errorf("stderr = %q, want the dev-build skip note", errOut.String())
	}
	if !strings.Contains(out.String(), "Installed code-server v4.132.0") {
		t.Errorf("stdout = %q, want the binary outcome line", out.String())
	}
}

// An extension install failure is a stderr warning, never the verb's exit
// code — the binary install already succeeded.
func TestCodeServerInstallBridgeFailureWarnsOnly(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	withCodeServerCLISeams(t, home, srv)
	calls := stubBridgeStep(t, "1.2.3", false, fmt.Errorf("code-server --install-extension: exit status 1"))

	var out, errOut bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &errOut), nil); err != nil {
		t.Fatalf("extension failure must not fail the verb, got %v", err)
	}
	if *calls != 1 {
		t.Errorf("extension step calls = %d, want 1", *calls)
	}
	if !strings.Contains(errOut.String(), "Code bridge extension install failed") {
		t.Errorf("stderr = %q, want the warning naming the failure", errOut.String())
	}
	if !strings.Contains(out.String(), "Installed code-server v4.132.0") {
		t.Errorf("stdout = %q, want the binary outcome line", out.String())
	}
}

// A changed extension prints its own stdout data line on install.
func TestCodeServerInstallBridgeChangedPrintsDataLine(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	withCodeServerCLISeams(t, home, srv)
	stubBridgeStep(t, "1.2.3", true, nil)

	var out bytes.Buffer
	if err := runCodeServerInstall(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Installed code bridge extension v1.2.3.\n") {
		t.Errorf("stdout = %q, want the extension outcome line", out.String())
	}
}

// An extension-only change (binary already current) still respawns the
// session — a newly installed extension only loads on a code-server restart.
func TestCodeServerUpdateBridgeOnlyChangeRespawns(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	kills, starts := withCodeServerCLISeams(t, home, srv)
	if err := runCodeServerInstall(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}

	stubBridgeStep(t, "1.2.3", true, nil)

	var out bytes.Buffer
	if err := runCodeServerUpdate(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if *kills != 1 || *starts != 1 {
		t.Errorf("kills=%d starts=%d, want 1/1 — an extension-only change respawns the session", *kills, *starts)
	}
	if !strings.Contains(out.String(), "Installed code bridge extension v1.2.3.") {
		t.Errorf("stdout = %q, want the extension outcome line", out.String())
	}
	if strings.Contains(out.String(), "Updated code-server") {
		t.Errorf("stdout = %q, want no binary update line — the binary did not change", out.String())
	}
}

// The extension step runs even when the binary is already current (a pending
// extension upgrade is caught up), and an unchanged extension keeps the
// no-restart rule.
func TestCodeServerUpdateAlreadyCurrentBridgeUnchangedNoRespawn(t *testing.T) {
	home := t.TempDir()
	srv := csReleaseServer(t, "4.132.0")
	kills, starts := withCodeServerCLISeams(t, home, srv)
	if err := runCodeServerInstall(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}

	calls := stubBridgeStep(t, "1.2.3", false, nil)

	var out bytes.Buffer
	if err := runCodeServerUpdate(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if *calls != 1 {
		t.Errorf("extension step calls = %d, want 1 — the step runs on the already-current path", *calls)
	}
	if *kills != 0 || *starts != 0 {
		t.Errorf("kills=%d starts=%d, want 0/0 — nothing changed", *kills, *starts)
	}
	if !strings.Contains(out.String(), "already current") {
		t.Errorf("stdout = %q, want the already-current line", out.String())
	}
}
