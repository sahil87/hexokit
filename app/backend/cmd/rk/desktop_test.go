package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"rk/internal/desktop"

	"github.com/spf13/cobra"
)

// resetDesktopFlags restores the desktop subcommands' flag state after a test.
// Cobra retains flag values on the shared global commands between Execute()
// calls (the same footgun resetRootFlagState guards), so every test that
// passes desktop flags registers this cleanup.
func resetDesktopFlags(t *testing.T) {
	t.Helper()
	reset := func(cmd *cobra.Command, defs map[string]string) {
		for name, def := range defs {
			if f := cmd.Flags().Lookup(name); f != nil {
				_ = f.Value.Set(def)
				f.Changed = false
			}
		}
	}
	t.Cleanup(func() {
		reset(desktopInstallCmd, map[string]string{"version": "", "force": "false", "path": ""})
		reset(desktopUpdateCmd, map[string]string{"force": "false", "path": ""})
		reset(desktopStatusCmd, map[string]string{"path": ""})
		reset(desktopUninstallCmd, map[string]string{"path": ""})
		quiet = false
		if f := rootCmd.PersistentFlags().Lookup("quiet"); f != nil {
			_ = f.Value.Set("false")
			f.Changed = false
		}
	})
}

// execDesktop runs the shared rootCmd with the given argv, capturing stdout
// and stderr.
func execDesktop(t *testing.T, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	resetDesktopFlags(t)
	var out, errBuf bytes.Buffer
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&errBuf)
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
	})
	rootCmd.SetArgs(args)
	err = rootCmd.Execute()
	return out.String(), errBuf.String(), err
}

// desktopReleaseServer serves a canned latest-release document (per-arch DMG
// assets, no digest) plus the asset bytes, counting asset downloads.
func desktopReleaseServer(t *testing.T, version string, assetHits *int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/dl/") {
			*assetHits++
			w.Write([]byte("fake-dmg"))
			return
		}
		base := "http://" + r.Host
		fmt.Fprintf(w, `{"tag_name":"v%s","assets":[
			{"name":"hexokit-desktop-%s-arm64.dmg","browser_download_url":"%s/dl/arm64.dmg"},
			{"name":"hexokit-desktop-%s-x64.dmg","browser_download_url":"%s/dl/x64.dmg"}]}`,
			version, version, base, version, base)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// withDesktopStub forces the darwin gate open and swaps the installer factory
// for one wired to the given httptest server and runner (deterministic arm64).
func withDesktopStub(t *testing.T, srv *httptest.Server, run desktop.Runner) {
	t.Helper()
	origGOOS := desktopGOOS
	desktopGOOS = "darwin"
	origFactory := newDesktopInstallerFn
	newDesktopInstallerFn = func() *desktop.Installer {
		ins := desktop.New()
		ins.Client = srv.Client()
		ins.APIBase = srv.URL
		ins.Arch = "arm64"
		ins.Token = ""
		ins.Run = run
		return ins
	}
	t.Cleanup(func() {
		desktopGOOS = origGOOS
		newDesktopInstallerFn = origFactory
	})
}

// desktopFakeRunner fakes the macOS tool set: plutil reports the given
// installed version, pgrep reports the given running state, hdiutil attach
// materializes the .app in the mountpoint, ditto creates the destination.
// It is stateful for the auto-restart flow: after the osascript graceful
// quit, pgrep flips to not-running (the app "exited"), and `open` (the
// relaunch) succeeds silently.
func desktopFakeRunner(t *testing.T, installedVersion string, running bool) desktop.Runner {
	t.Helper()
	quitSeen := false
	return func(_ context.Context, name string, args ...string) ([]byte, error) {
		switch name {
		case "plutil":
			return []byte(installedVersion + "\n"), nil
		case "pgrep":
			if running && !quitSeen {
				return []byte("123\n"), nil
			}
			return nil, errors.New("exit status 1")
		case "osascript":
			quitSeen = true
			return nil, nil
		case "open":
			return nil, nil
		case "hdiutil":
			if len(args) > 4 && args[0] == "attach" {
				if err := os.MkdirAll(filepath.Join(args[4], desktop.AppBundleName), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			return nil, nil
		case "codesign":
			return nil, nil
		case "ditto":
			if err := os.MkdirAll(args[1], 0o755); err != nil {
				t.Fatal(err)
			}
			return nil, nil
		}
		t.Fatalf("unexpected command: %s %v", name, args)
		return nil, nil
	}
}

// writeDesktopBundle creates <dir>/HexoKit.app/Contents/Info.plist so the
// installed-version probe finds an installed app.
func writeDesktopBundle(t *testing.T, dir string) {
	t.Helper()
	contents := filepath.Join(dir, desktop.AppBundleName, "Contents")
	if err := os.MkdirAll(contents, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(contents, "Info.plist"), []byte("fake"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// writeDesktopLegacyBundle creates <dir>/Run Kit.app/Contents/Info.plist — a
// pre-rename install with no current-name bundle beside it.
func writeDesktopLegacyBundle(t *testing.T, dir string) {
	t.Helper()
	contents := filepath.Join(dir, "Run Kit.app", "Contents")
	if err := os.MkdirAll(contents, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(contents, "Info.plist"), []byte("fake"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopRegisteredWithChildrenAndFlags(t *testing.T) {
	var found *cobra.Command
	for _, c := range rootCmd.Commands() {
		if c.Name() == "desktop" {
			found = c
		}
	}
	if found == nil {
		t.Fatal("desktop command not registered on rootCmd")
	}
	children := map[string]bool{}
	for _, c := range found.Commands() {
		children[c.Name()] = true
	}
	for _, want := range []string{"install", "update", "status", "uninstall"} {
		if !children[want] {
			t.Errorf("desktop child %q not registered", want)
		}
	}
	for _, flag := range []string{"version", "force", "path"} {
		if desktopInstallCmd.Flags().Lookup(flag) == nil {
			t.Errorf("install missing --%s", flag)
		}
	}
	for _, flag := range []string{"force", "path"} {
		if desktopUpdateCmd.Flags().Lookup(flag) == nil {
			t.Errorf("update missing --%s", flag)
		}
	}
	for _, c := range []*cobra.Command{desktopStatusCmd, desktopUninstallCmd} {
		if c.Flags().Lookup("path") == nil {
			t.Errorf("%s missing --path", c.Name())
		}
	}
	// The --path cobra default is deliberately "" — a per-platform literal
	// would make the published help-dump reference platform-dependent.
	for _, c := range []*cobra.Command{desktopInstallCmd, desktopUpdateCmd, desktopStatusCmd, desktopUninstallCmd} {
		f := c.Flags().Lookup("path")
		if f.DefValue != "" {
			t.Errorf("%s --path default = %q, want empty (resolved per platform at runtime)", c.Name(), f.DefValue)
		}
		if !strings.Contains(f.Usage, "/Applications on macOS, ~/.local/state/hexokit/desktop on Linux") {
			t.Errorf("%s --path usage %q should name both platform defaults", c.Name(), f.Usage)
		}
	}
	// help-dump publishes UsageString, so the Long: help blocks are part of
	// the contract surface (the daemon-children pattern).
	if desktopCmd.Long == "" {
		t.Error("desktop parent missing a Long: help block")
	}
	for _, c := range []*cobra.Command{desktopInstallCmd, desktopUpdateCmd, desktopStatusCmd, desktopUninstallCmd} {
		if c.Long == "" {
			t.Errorf("desktop %s missing a Long: help block", c.Name())
		}
	}
	// The documented flag semantics the Long blocks exist to carry.
	if !strings.Contains(desktopUpdateCmd.Long, "no --version") {
		t.Error("update Long should state that update deliberately has no --version flag")
	}
	for _, c := range []*cobra.Command{desktopInstallCmd, desktopUpdateCmd} {
		if !strings.Contains(c.Long, "version state ONLY") {
			t.Errorf("%s Long should scope --force to version state", c.Name())
		}
		if !strings.Contains(c.Long, "quit gracefully") {
			t.Errorf("%s Long should describe the running-app auto-restart (quit gracefully → swap → relaunch)", c.Name())
		}
	}
	if desktopCmd.Short != "Install and update the HexoKit desktop app (macOS, Linux)" {
		t.Errorf("desktop Short = %q, want the macOS+Linux form", desktopCmd.Short)
	}
}

// TestDesktopEmptyPathUsageError: an explicitly-empty --path is a usage error
// (exit 2), not a silent fallback to /Applications.
func TestDesktopEmptyPathUsageError(t *testing.T) {
	orig := desktopGOOS
	desktopGOOS = "darwin"
	t.Cleanup(func() { desktopGOOS = orig })

	origFactory := newDesktopInstallerFn
	newDesktopInstallerFn = func() *desktop.Installer {
		t.Fatal("installer constructed despite the empty --path usage error")
		return nil
	}
	t.Cleanup(func() { newDesktopInstallerFn = origFactory })

	for _, sub := range []string{"install", "update", "status", "uninstall"} {
		t.Run(sub, func(t *testing.T) {
			_, _, err := execDesktop(t, "desktop", sub, "--path", "")
			if err == nil {
				t.Fatal("expected a usage error, got nil")
			}
			if !strings.Contains(err.Error(), "--path") {
				t.Errorf("error = %q, want it to name --path", err.Error())
			}
			if got := exitCode(err); got != exitUsage {
				t.Errorf("exitCode = %d, want %d (usage)", got, exitUsage)
			}
		})
	}
}

func TestDesktopPlatformGate(t *testing.T) {
	orig := desktopGOOS
	desktopGOOS = "windows"
	t.Cleanup(func() { desktopGOOS = orig })

	origFactory := newDesktopInstallerFn
	newDesktopInstallerFn = func() *desktop.Installer {
		t.Fatal("installer constructed despite the platform gate")
		return nil
	}
	t.Cleanup(func() { newDesktopInstallerFn = origFactory })

	for _, sub := range []string{"install", "update", "status", "uninstall"} {
		t.Run(sub, func(t *testing.T) {
			_, _, err := execDesktop(t, "desktop", sub)
			if err == nil {
				t.Fatal("expected the platform-gate error, got nil")
			}
			want := "rk desktop supports macOS and Linux (the shell is packaged as a macOS .app and a Linux AppImage)"
			if err.Error() != want {
				t.Errorf("error = %q, want %q", err.Error(), want)
			}
			if got := exitCode(err); got != 1 {
				t.Errorf("exitCode = %d, want 1 (operational)", got)
			}
		})
	}
}

func TestDesktopUsageErrorsExitTwo(t *testing.T) {
	cases := [][]string{
		{"desktop", "install", "extra-arg"},
		{"desktop", "update", "extra-arg"},
		{"desktop", "status", "extra-arg"},
		{"desktop", "install", "--nope"},
	}
	for _, argv := range cases {
		t.Run(strings.Join(argv, " "), func(t *testing.T) {
			_, _, err := execDesktop(t, argv...)
			if err == nil {
				t.Fatal("expected a usage error, got nil")
			}
			if got := exitCode(err); got != exitUsage {
				t.Errorf("exitCode = %d, want %d (usage)", got, exitUsage)
			}
		})
	}
}

func TestDesktopInstallAlreadyCurrent(t *testing.T) {
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "3.13.0", false))
	dir := t.TempDir()
	writeDesktopBundle(t, dir)

	stdout, _, err := execDesktop(t, "desktop", "install", "--path", dir)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if !strings.Contains(stdout, "already installed") || !strings.Contains(stdout, "--force") {
		t.Errorf("stdout = %q, want an already-installed outcome naming --force", stdout)
	}
	if assetHits != 0 {
		t.Errorf("asset downloaded %d times despite already-current short-circuit", assetHits)
	}
}

func TestDesktopInstallForceReinstalls(t *testing.T) {
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "3.13.0", false))
	dir := t.TempDir()
	writeDesktopBundle(t, dir)

	stdout, _, err := execDesktop(t, "desktop", "install", "--path", dir, "--force")
	if err != nil {
		t.Fatalf("install --force: %v", err)
	}
	if !strings.Contains(stdout, "Installed HexoKit v3.13.0") {
		t.Errorf("stdout = %q, want an installed outcome line", stdout)
	}
	if assetHits != 1 {
		t.Errorf("asset downloads = %d, want 1", assetHits)
	}
}

func TestDesktopInstallLegacyOnlySameVersionMigrates(t *testing.T) {
	// Only the pre-rename Run Kit.app exists, at the same version as the
	// release: the version equality must NOT short-circuit — the install runs
	// so HexoKit.app lands and the legacy bundle is removed.
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "3.13.0", false))
	dir := t.TempDir()
	writeDesktopLegacyBundle(t, dir)

	stdout, _, err := execDesktop(t, "desktop", "install", "--path", dir)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if !strings.Contains(stdout, "Installed HexoKit v3.13.0") {
		t.Errorf("stdout = %q, want an installed outcome line (no already-installed short-circuit)", stdout)
	}
	if assetHits != 1 {
		t.Errorf("asset downloads = %d, want 1", assetHits)
	}
	if _, err := os.Stat(filepath.Join(dir, desktop.AppBundleName)); err != nil {
		t.Errorf("HexoKit.app missing after migration install: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "Run Kit.app")); !os.IsNotExist(err) {
		t.Errorf("legacy Run Kit.app still present after migration install (err = %v)", err)
	}
}

func TestDesktopUpdateNotInstalled(t *testing.T) {
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "", false))
	dir := t.TempDir() // no bundle

	_, _, err := execDesktop(t, "desktop", "update", "--path", dir)
	if err == nil {
		t.Fatal("expected a not-installed error, got nil")
	}
	if !strings.Contains(err.Error(), "rk desktop install") {
		t.Errorf("error = %q, want a pointer at 'rk desktop install'", err.Error())
	}
	if got := exitCode(err); got != 1 {
		t.Errorf("exitCode = %d, want 1", got)
	}
}

func TestDesktopUpdateAlreadyUpToDate(t *testing.T) {
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "3.13.0", false))
	dir := t.TempDir()
	writeDesktopBundle(t, dir)

	stdout, _, err := execDesktop(t, "desktop", "update", "--path", dir)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !strings.Contains(stdout, "Already up to date (v3.13.0).") {
		t.Errorf("stdout = %q, want the up-to-date outcome line", stdout)
	}
	if assetHits != 0 {
		t.Errorf("asset downloaded %d times despite up-to-date", assetHits)
	}
}

func TestDesktopUpdateLegacyOnlySameVersionMigrates(t *testing.T) {
	// Only the pre-rename Run Kit.app exists, at the latest version: the
	// up-to-date check must NOT short-circuit — the update runs so HexoKit.app
	// lands and the legacy bundle is removed.
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "3.13.0", false))
	dir := t.TempDir()
	writeDesktopLegacyBundle(t, dir)

	stdout, _, err := execDesktop(t, "desktop", "update", "--path", dir)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if strings.Contains(stdout, "Already up to date") {
		t.Errorf("stdout = %q, want no up-to-date short-circuit for a legacy-only install", stdout)
	}
	if assetHits != 1 {
		t.Errorf("asset downloads = %d, want 1", assetHits)
	}
	if _, err := os.Stat(filepath.Join(dir, desktop.AppBundleName)); err != nil {
		t.Errorf("HexoKit.app missing after migration update: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "Run Kit.app")); !os.IsNotExist(err) {
		t.Errorf("legacy Run Kit.app still present after migration update (err = %v)", err)
	}
}

func TestDesktopUpdateInstallsNewer(t *testing.T) {
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "3.12.2", false))
	dir := t.TempDir()
	writeDesktopBundle(t, dir)

	stdout, _, err := execDesktop(t, "desktop", "update", "--path", dir)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !strings.Contains(stdout, "Updated HexoKit v3.12.2 -> v3.13.0") {
		t.Errorf("stdout = %q, want the updated outcome line", stdout)
	}
	if assetHits != 1 {
		t.Errorf("asset downloads = %d, want 1", assetHits)
	}
}

// TestDesktopUpdateRunningAppAutoRestarts: a running app no longer blocks the
// update — it is quit, swapped, and relaunched, and the restart announcement
// is a stdout data line alongside the updated outcome (R2, R5, R6).
func TestDesktopUpdateRunningAppAutoRestarts(t *testing.T) {
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "3.12.2", true))
	dir := t.TempDir()
	writeDesktopBundle(t, dir)

	stdout, _, err := execDesktop(t, "desktop", "update", "--path", dir)
	if err != nil {
		t.Fatalf("update with a running app must auto-restart, not refuse: %v", err)
	}
	if !strings.Contains(stdout, "Updated HexoKit v3.12.2 -> v3.13.0") {
		t.Errorf("stdout = %q, want the updated outcome line", stdout)
	}
	if !strings.Contains(stdout, "HexoKit was running — restarted on the new version.") {
		t.Errorf("stdout = %q, want the restart announcement data line", stdout)
	}
	if assetHits != 1 {
		t.Errorf("asset downloads = %d, want 1", assetHits)
	}
}

// TestDesktopInstallForceRunningAppAutoRestarts: --force stays scoped to
// version state; a running app is auto-restarted, never refused (R6).
func TestDesktopInstallForceRunningAppAutoRestarts(t *testing.T) {
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "3.13.0", true))
	dir := t.TempDir()
	writeDesktopBundle(t, dir)

	stdout, _, err := execDesktop(t, "desktop", "install", "--path", dir, "--force")
	if err != nil {
		t.Fatalf("install --force with a running app must auto-restart, not refuse: %v", err)
	}
	if !strings.Contains(stdout, "Installed HexoKit v3.13.0") {
		t.Errorf("stdout = %q, want the installed outcome line", stdout)
	}
	if !strings.Contains(stdout, "restarted on the new version") {
		t.Errorf("stdout = %q, want the restart announcement", stdout)
	}
}

func TestDesktopStatusReport(t *testing.T) {
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "3.12.2", false))
	dir := t.TempDir()
	writeDesktopBundle(t, dir)

	stdout, _, err := execDesktop(t, "desktop", "status", "--path", dir)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	for _, want := range []string{"Installed: v3.12.2", "Latest:    v3.13.0", "Update available"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout = %q, want it to contain %q", stdout, want)
		}
	}
	if assetHits != 0 {
		t.Errorf("status downloaded the asset %d times — it must be read-only", assetHits)
	}
}

func TestDesktopStatusNotInstalled(t *testing.T) {
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "", false))
	dir := t.TempDir()

	stdout, _, err := execDesktop(t, "desktop", "status", "--path", dir)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	for _, want := range []string{"Installed: not installed", "Latest:    v3.13.0", "rk desktop install"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout = %q, want it to contain %q", stdout, want)
		}
	}
}

// TestDesktopQuietSplitsDataFromChatter: the outcome line is data (survives
// --quiet on stdout); the resolve/progress narration is chatter (stderr,
// dropped under --quiet) — Toolkit Principle 9.
func TestDesktopQuietSplitsDataFromChatter(t *testing.T) {
	var assetHits int
	srv := desktopReleaseServer(t, "3.13.0", &assetHits)
	withDesktopStub(t, srv, desktopFakeRunner(t, "3.13.0", false))
	dir := t.TempDir()
	writeDesktopBundle(t, dir)

	stdout, stderr, err := execDesktop(t, "desktop", "install", "--path", dir, "--quiet")
	if err != nil {
		t.Fatalf("install --quiet: %v", err)
	}
	if !strings.Contains(stdout, "already installed") {
		t.Errorf("stdout = %q, want the outcome line to survive --quiet", stdout)
	}
	if stderr != "" {
		t.Errorf("stderr = %q, want empty under --quiet", stderr)
	}
}

// ─── Linux flows ─────────────────────────────────────────────────────────────

// writeLinuxFixtureTree writes a minimal valid squashfs-root fixture into dir
// (the fake --appimage-extract's job). AppRun is a real shell script so the
// detached relaunch genuinely starts on the test host.
func writeLinuxFixtureTree(t *testing.T, dir, version string) {
	t.Helper()
	mk := func(rel, content string, perm os.FileMode) {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), perm); err != nil {
			t.Fatal(err)
		}
	}
	mk("AppRun", "#!/bin/sh\nexit 0\n", 0o755)
	mk("hexokit-desktop", "fake-elf", 0o755)
	mk(filepath.Join("resources", "app.asar"), "fake-asar", 0o644)
	mk("hexokit-desktop.desktop",
		"[Desktop Entry]\nName=HexoKit\nExec=AppRun --no-sandbox %U\nX-AppImage-Version="+version+"\n", 0o644)
	mk(filepath.Join("usr", "share", "icons", "hicolor", "1024x1024", "apps", "hexokit-desktop.png"), "fake-png", 0o644)
}

// linuxDesktopReleaseServer serves a latest-release document with
// x86_64/arm64 AppImage assets carrying the real sha256 of the served bytes.
// The version rides a pointer so a test can bump it mid-scenario (install,
// then a newer latest for update).
func linuxDesktopReleaseServer(t *testing.T, version *string, assetHits *int) *httptest.Server {
	t.Helper()
	const payload = "fake-appimage-payload"
	sum := sha256.Sum256([]byte(payload))
	digest := hex.EncodeToString(sum[:])
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/dl/") {
			*assetHits++
			w.Write([]byte(payload))
			return
		}
		base := "http://" + r.Host
		fmt.Fprintf(w, `{"tag_name":"v%s","assets":[
			{"name":"hexokit-desktop-%s-arm64.AppImage","browser_download_url":"%s/dl/arm64.AppImage","digest":"sha256:%s"},
			{"name":"hexokit-desktop-%s-x86_64.AppImage","browser_download_url":"%s/dl/x86_64.AppImage","digest":"sha256:%s"}]}`,
			*version, *version, base, digest, *version, base, digest)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// linuxDesktopDefaultRoot is the path the platform default install root
// resolves to under a stub-pinned home: <state>/hexokit/desktop per apphome
// (with XDG_STATE_HOME pinned to <home>/.local/state).
func linuxDesktopDefaultRoot(home string) string {
	return filepath.Join(home, ".local", "state", "hexokit", "desktop")
}

// withLinuxDesktopStub pins the gate to linux and wires the factory: HOME and
// XDG_STATE_HOME point at the given temp home so the platform default root
// resolves through apphome (InstallDir is left EMPTY), the UserHome seam
// points at the same home for the integration paths, RunInDir is the fake
// extractor, Run records pgrep and answers update-desktop-database, Signal is
// recorded.
func withLinuxDesktopStub(t *testing.T, srv *httptest.Server, home string, version *string, running *bool) {
	t.Helper()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", filepath.Join(home, ".local", "state"))
	origGOOS := desktopGOOS
	desktopGOOS = "linux"
	origFactory := newDesktopInstallerFn
	newDesktopInstallerFn = func() *desktop.Installer {
		ins := desktop.New()
		ins.Client = srv.Client()
		ins.APIBase = srv.URL
		ins.Arch = "amd64"
		ins.Token = ""
		ins.UserHome = func() (string, error) { return home, nil }
		ins.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
			switch name {
			case "pgrep":
				if *running {
					return []byte("4242\n"), nil
				}
				return nil, errors.New("exit status 1")
			case "update-desktop-database":
				return nil, nil
			}
			t.Fatalf("unexpected subprocess: %s %v", name, args)
			return nil, nil
		}
		ins.RunInDir = func(_ context.Context, dir, name string, args ...string) ([]byte, error) {
			if len(args) != 1 || args[0] != "--appimage-extract" {
				t.Fatalf("extractor args = %v, want [--appimage-extract]", args)
			}
			writeLinuxFixtureTree(t, filepath.Join(dir, "squashfs-root"), *version)
			return nil, nil
		}
		ins.Signal = func(pid int, sig syscall.Signal) error {
			*running = false // the SIGTERM worked
			return nil
		}
		return ins
	}
	t.Cleanup(func() {
		desktopGOOS = origGOOS
		newDesktopInstallerFn = origFactory
	})
}

// TestDesktopLinuxInstallUpdateStatus runs the whole linux lifecycle through
// the default install root (no --path anywhere).
func TestDesktopLinuxInstallUpdateStatus(t *testing.T) {
	version := "3.21.0"
	var assetHits int
	srv := linuxDesktopReleaseServer(t, &version, &assetHits)
	home := t.TempDir()
	running := false
	withLinuxDesktopStub(t, srv, home, &version, &running)
	root := linuxDesktopDefaultRoot(home)

	// status before install: read-only report off the default root.
	stdout, _, err := execDesktop(t, "desktop", "status")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(stdout, "Installed: not installed") || !strings.Contains(stdout, "Latest:    v3.21.0") {
		t.Errorf("status stdout = %q, want the not-installed report", stdout)
	}

	stdout, _, err = execDesktop(t, "desktop", "install")
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if !strings.Contains(stdout, "Installed HexoKit v3.21.0 to "+filepath.Join(root, "3.21.0")) {
		t.Errorf("install stdout = %q, want the installed outcome line with the default root", stdout)
	}
	if target, err := os.Readlink(filepath.Join(root, "current")); err != nil || target != "3.21.0" {
		t.Errorf("current -> %q (%v), want 3.21.0", target, err)
	}
	// Desktop integration landed under the pinned home.
	if _, err := os.Stat(filepath.Join(home, ".local", "share", "applications", "hexokit-desktop.desktop")); err != nil {
		t.Errorf("launcher entry missing: %v", err)
	}

	stdout, _, err = execDesktop(t, "desktop", "update")
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !strings.Contains(stdout, "Already up to date (v3.21.0).") {
		t.Errorf("update stdout = %q, want the up-to-date outcome line", stdout)
	}

	// A newer release appears; update installs it (the app not running).
	version = "3.22.0"
	stdout, _, err = execDesktop(t, "desktop", "update")
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	want := "Updated HexoKit v3.21.0 -> v3.22.0 (" + filepath.Join(root, "3.22.0") + ")"
	if !strings.Contains(stdout, want) {
		t.Errorf("update stdout = %q, want %q", stdout, want)
	}
	// The pre-flip version survives as the rollback; the next update prunes it.
	if _, err := os.Stat(filepath.Join(root, "3.21.0")); err != nil {
		t.Errorf("previous version dir pruned after the flip — it is the kept rollback: %v", err)
	}
	version = "3.23.0"
	if _, _, err := execDesktop(t, "desktop", "update"); err != nil {
		t.Fatalf("second update: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "3.21.0")); !os.IsNotExist(err) {
		t.Error("the pre-previous version dir survived the second flip")
	}
	if _, err := os.Stat(filepath.Join(root, "3.22.0")); err != nil {
		t.Errorf("previous version dir missing after the second flip: %v", err)
	}
}

// TestDesktopLinuxUpdateRestartsRunningApp: the SIGTERM seam flips the probe
// to not-running, so the update quits, swaps, relaunches, and announces the
// restart as a data line.
func TestDesktopLinuxUpdateRestartsRunningApp(t *testing.T) {
	version := "3.21.0"
	var assetHits int
	srv := linuxDesktopReleaseServer(t, &version, &assetHits)
	home := t.TempDir()
	running := false
	withLinuxDesktopStub(t, srv, home, &version, &running)
	root := linuxDesktopDefaultRoot(home)

	if _, _, err := execDesktop(t, "desktop", "install"); err != nil {
		t.Fatalf("install: %v", err)
	}
	version = "3.22.0"
	running = true

	stdout, _, err := execDesktop(t, "desktop", "update")
	if err != nil {
		t.Fatalf("update with a running app must auto-restart, not refuse: %v", err)
	}
	if !strings.Contains(stdout, "Updated HexoKit v3.21.0 -> v3.22.0") {
		t.Errorf("stdout = %q, want the updated outcome line", stdout)
	}
	if !strings.Contains(stdout, "HexoKit was running — restarted on the new version.") {
		t.Errorf("stdout = %q, want the restart announcement data line", stdout)
	}
	if target, _ := os.Readlink(filepath.Join(root, "current")); target != "3.22.0" {
		t.Errorf("current -> %q, want 3.22.0", target)
	}
}

func TestDesktopLinuxUninstall(t *testing.T) {
	version := "3.21.0"
	var assetHits int
	srv := linuxDesktopReleaseServer(t, &version, &assetHits)
	home := t.TempDir()
	running := false
	withLinuxDesktopStub(t, srv, home, &version, &running)
	root := linuxDesktopDefaultRoot(home)

	if _, _, err := execDesktop(t, "desktop", "install"); err != nil {
		t.Fatalf("install: %v", err)
	}
	stdout, _, err := execDesktop(t, "desktop", "uninstall")
	if err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if !strings.Contains(stdout, "Uninstalled HexoKit from "+root) {
		t.Errorf("stdout = %q, want the uninstalled outcome line naming the root", stdout)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Error("install root still present after uninstall")
	}
	if _, err := os.Lstat(filepath.Join(home, ".local", "bin", "hexokit-desktop")); !os.IsNotExist(err) {
		t.Error("bin symlink still present after uninstall")
	}
}

func TestDesktopLinuxUninstallNotInstalled(t *testing.T) {
	version := "3.21.0"
	var assetHits int
	srv := linuxDesktopReleaseServer(t, &version, &assetHits)
	home := t.TempDir()
	running := false
	withLinuxDesktopStub(t, srv, home, &version, &running)

	_, _, err := execDesktop(t, "desktop", "uninstall")
	if err == nil || !strings.Contains(err.Error(), "HexoKit is not installed at ") {
		t.Fatalf("error = %v, want the not-installed refusal", err)
	}
	if got := exitCode(err); got != 1 {
		t.Errorf("exitCode = %d, want 1", got)
	}
}

func TestDesktopUninstallDarwinRefusal(t *testing.T) {
	orig := desktopGOOS
	desktopGOOS = "darwin"
	t.Cleanup(func() { desktopGOOS = orig })
	origFactory := newDesktopInstallerFn
	newDesktopInstallerFn = func() *desktop.Installer { return desktop.New() }
	t.Cleanup(func() { newDesktopInstallerFn = origFactory })

	_, _, err := execDesktop(t, "desktop", "uninstall")
	want := `rk desktop uninstall is Linux-only — on macOS drag "HexoKit.app" to the Trash`
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
	if got := exitCode(err); got != 1 {
		t.Errorf("exitCode = %d, want 1 (operational)", got)
	}
}

// TestDesktopLinuxDefaultPathResolution: with no --path, the linux default
// root resolves through apphome (the pinned HOME/XDG_STATE_HOME) — a
// pre-existing install under <state>/hexokit/desktop is what status reports.
func TestDesktopLinuxDefaultPathResolution(t *testing.T) {
	version := "3.21.0"
	var assetHits int
	srv := linuxDesktopReleaseServer(t, &version, &assetHits)
	home := t.TempDir()
	running := false
	withLinuxDesktopStub(t, srv, home, &version, &running)

	root := linuxDesktopDefaultRoot(home)
	if err := os.MkdirAll(filepath.Join(root, "3.20.7"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("3.20.7", filepath.Join(root, "current")); err != nil {
		t.Fatal(err)
	}
	stdout, _, err := execDesktop(t, "desktop", "status")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(stdout, "Installed: v3.20.7") {
		t.Errorf("status stdout = %q, want the install under <state>/hexokit/desktop reported", stdout)
	}
}
