package desktop

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// writeFakeBundleNamed creates <dir>/<name>/Contents/Info.plist (content is
// irrelevant — the version read goes through the stubbed plutil runner).
func writeFakeBundleNamed(t *testing.T, dir, name string) string {
	t.Helper()
	contents := filepath.Join(dir, name, "Contents")
	if err := os.MkdirAll(contents, 0o755); err != nil {
		t.Fatal(err)
	}
	plist := filepath.Join(contents, "Info.plist")
	if err := os.WriteFile(plist, []byte("fake"), 0o644); err != nil {
		t.Fatal(err)
	}
	return plist
}

// writeFakeBundle creates the current-name (HexoKit.app) fixture.
func writeFakeBundle(t *testing.T, dir string) string {
	t.Helper()
	return writeFakeBundleNamed(t, dir, AppBundleName)
}

func TestInstalledVersionNotInstalled(t *testing.T) {
	ins := New()
	ins.GOOS = "darwin"
	ins.InstallDir = t.TempDir()
	ins.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		t.Fatalf("unexpected subprocess for a missing app: %s %v", name, args)
		return nil, nil
	}
	v, err := ins.InstalledVersion(context.Background())
	if err != nil {
		t.Fatalf("InstalledVersion: %v", err)
	}
	if v != "" {
		t.Errorf("version = %q, want empty (not installed)", v)
	}
}

func TestInstalledVersionReadsPlist(t *testing.T) {
	dir := t.TempDir()
	plist := writeFakeBundle(t, dir)

	ins := New()
	ins.GOOS = "darwin"
	ins.InstallDir = dir
	var gotName string
	var gotArgs []string
	ins.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		gotName, gotArgs = name, args
		return []byte("3.12.2\n"), nil
	}

	v, err := ins.InstalledVersion(context.Background())
	if err != nil {
		t.Fatalf("InstalledVersion: %v", err)
	}
	if v != "3.12.2" {
		t.Errorf("version = %q, want 3.12.2", v)
	}
	if gotName != "plutil" {
		t.Errorf("runner name = %q, want plutil", gotName)
	}
	wantArgs := []string{"-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Errorf("plutil args = %v, want %v", gotArgs, wantArgs)
	}
}

func TestInstalledVersionLegacyBundleFallback(t *testing.T) {
	// A pre-rename install (only Run Kit.app exists) must read as installed —
	// `rk desktop update` upgrades it rather than reporting "not installed".
	dir := t.TempDir()
	legacyPlist := writeFakeBundleNamed(t, dir, legacyAppBundleName)

	ins := New()
	ins.GOOS = "darwin"
	ins.InstallDir = dir
	var gotArgs []string
	ins.Run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		gotArgs = args
		return []byte("3.12.2\n"), nil
	}

	v, err := ins.InstalledVersion(context.Background())
	if err != nil {
		t.Fatalf("InstalledVersion: %v", err)
	}
	if v != "3.12.2" {
		t.Errorf("version = %q, want 3.12.2 (the legacy install)", v)
	}
	if got := gotArgs[len(gotArgs)-1]; got != legacyPlist {
		t.Errorf("plutil path = %q, want the legacy bundle's plist %q", got, legacyPlist)
	}
}

func TestInstalledVersionPrefersCurrentBundle(t *testing.T) {
	// Both bundles present: the current-name bundle wins.
	dir := t.TempDir()
	writeFakeBundleNamed(t, dir, legacyAppBundleName)
	newPlist := writeFakeBundle(t, dir)

	ins := New()
	ins.GOOS = "darwin"
	ins.InstallDir = dir
	var gotArgs []string
	ins.Run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		gotArgs = args
		return []byte("3.13.0\n"), nil
	}

	if _, err := ins.InstalledVersion(context.Background()); err != nil {
		t.Fatalf("InstalledVersion: %v", err)
	}
	if got := gotArgs[len(gotArgs)-1]; got != newPlist {
		t.Errorf("plutil path = %q, want the current bundle's plist %q", got, newPlist)
	}
}

func TestAppRunningLegacyBundleFallback(t *testing.T) {
	dir := t.TempDir()
	writeFakeBundleNamed(t, dir, legacyAppBundleName)

	ins := New()
	ins.GOOS = "darwin"
	ins.InstallDir = dir
	var gotArgs []string
	ins.Run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		gotArgs = args
		return []byte("123\n"), nil
	}
	if !ins.AppRunning(context.Background()) {
		t.Error("AppRunning = false with a matching pgrep on the legacy bundle, want true")
	}
	want := []string{"-f", filepath.Join(dir, legacyAppBundleName, "Contents", "MacOS")}
	if !reflect.DeepEqual(gotArgs, want) {
		t.Errorf("pgrep args = %v, want %v (legacy bundle path)", gotArgs, want)
	}
}

func TestAppRunningProbesBothBundles(t *testing.T) {
	// Both bundles exist but only the legacy one has a live process — the
	// probe must not stop at the current-name bundle, or the swap would skip
	// the graceful quit and delete the running legacy app mid-install.
	dir := t.TempDir()
	writeFakeBundleNamed(t, dir, legacyAppBundleName)
	writeFakeBundle(t, dir)

	ins := New()
	ins.GOOS = "darwin"
	ins.InstallDir = dir
	var probed []string
	ins.Run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		probed = append(probed, args[len(args)-1])
		if strings.Contains(args[len(args)-1], legacyAppBundleName) {
			return []byte("123\n"), nil
		}
		return nil, errors.New("exit status 1")
	}
	if !ins.AppRunning(context.Background()) {
		t.Error("AppRunning = false with a live legacy process beside the current bundle, want true")
	}
	if len(probed) != 2 {
		t.Fatalf("probed %d path(s) %v, want 2 (current then legacy)", len(probed), probed)
	}
	if !strings.Contains(probed[0], AppBundleName) || !strings.Contains(probed[1], legacyAppBundleName) {
		t.Errorf("probe order = %v, want current bundle first, legacy second", probed)
	}
}

func TestQuitAppTargetsRunningBundle(t *testing.T) {
	// With both bundles installed and the legacy one live, the graceful quit
	// must address "Run Kit" — quitting "HexoKit" would leave the legacy
	// process running and the swap would remove it from under the user.
	dir := t.TempDir()
	writeFakeBundleNamed(t, dir, legacyAppBundleName)
	writeFakeBundle(t, dir)

	ins := New()
	ins.GOOS = "darwin"
	ins.InstallDir = dir
	var osascriptArgs []string
	ins.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		switch name {
		case "pgrep":
			if strings.Contains(args[len(args)-1], legacyAppBundleName) {
				return []byte("123\n"), nil
			}
			return nil, errors.New("exit status 1")
		case "osascript":
			osascriptArgs = args
		}
		return nil, nil
	}
	if err := ins.quitApp(context.Background(), ins.runningAppName(context.Background())); err != nil {
		t.Fatalf("quitApp: %v", err)
	}
	want := `tell application "Run Kit" to quit`
	if len(osascriptArgs) != 2 || osascriptArgs[1] != want {
		t.Errorf("osascript args = %v, want [-e %q]", osascriptArgs, want)
	}
}

func TestInstalledVersionProbeFailure(t *testing.T) {
	dir := t.TempDir()
	writeFakeBundle(t, dir)

	ins := New()
	ins.GOOS = "darwin"
	ins.InstallDir = dir
	ins.Run = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return nil, errors.New("plutil exploded")
	}
	if _, err := ins.InstalledVersion(context.Background()); err == nil {
		t.Error("expected an error from a failing plist probe, got nil")
	}
}

func TestAppRunning(t *testing.T) {
	ins := New()
	ins.GOOS = "darwin"
	ins.InstallDir = "/Applications"

	var gotName string
	var gotArgs []string
	ins.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		gotName, gotArgs = name, args
		return []byte("123\n"), nil
	}
	if !ins.AppRunning(context.Background()) {
		t.Error("AppRunning = false with a matching pgrep, want true")
	}
	if gotName != "pgrep" {
		t.Errorf("runner name = %q, want pgrep", gotName)
	}
	wantArgs := []string{"-f", filepath.Join("/Applications", AppBundleName, "Contents", "MacOS")}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Errorf("pgrep args = %v, want %v", gotArgs, wantArgs)
	}

	// pgrep exiting non-zero (no match, or a rare probe failure) reads as
	// not-running — best-effort detection must not block an install.
	ins.Run = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return nil, errors.New("exit status 1")
	}
	if ins.AppRunning(context.Background()) {
		t.Error("AppRunning = true with a failing pgrep, want false")
	}
}

func TestCurrentBundleInstalled(t *testing.T) {
	// Legacy-only: the current-name bundle is absent even though a pre-rename
	// install exists — the version no-op short-circuits must not treat this as
	// complete.
	dir := t.TempDir()
	writeFakeBundleNamed(t, dir, legacyAppBundleName)

	ins := New()
	ins.GOOS = "darwin"
	ins.InstallDir = dir
	if ins.CurrentBundleInstalled() {
		t.Error("CurrentBundleInstalled = true with only the legacy bundle, want false")
	}

	writeFakeBundle(t, dir)
	if !ins.CurrentBundleInstalled() {
		t.Error("CurrentBundleInstalled = false with HexoKit.app present, want true")
	}

	// Linux never had a name-keyed bundle — no legacy-only state exists.
	ins.GOOS = "linux"
	if !ins.CurrentBundleInstalled() {
		t.Error("CurrentBundleInstalled = false on linux, want true")
	}
}
