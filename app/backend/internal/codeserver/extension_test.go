package codeserver

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeBridgeFixture plants an installed rk-code-bridge extension of the
// given version under extensionsDir (code-server's <publisher>.<name>-<v>
// layout).
func writeBridgeFixture(t *testing.T, extensionsDir, version string) {
	t.Helper()
	pkgDir := filepath.Join(extensionsDir, "run-kit.rk-code-bridge-"+version)
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := fmt.Sprintf(`{"name":"rk-code-bridge","publisher":"run-kit","version":%q}`, version)
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fakeManagedCodeServer installs a fake managed code-server under home that
// appends its argv (one argument per line) to a record file, and returns the
// record file's path. exitCode lets failure-path tests script a non-zero
// exit.
func fakeManagedCodeServer(t *testing.T, home string, exitCode int) string {
	t.Helper()
	record := filepath.Join(t.TempDir(), "argv")
	binDir := filepath.Join(VersionDir(home, "4.132.0"), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$@\" >> '%s'\nexit %d\n", record, exitCode)
	if err := os.WriteFile(filepath.Join(binDir, "code-server"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("4.132.0", CurrentPath(home)); err != nil {
		t.Fatal(err)
	}
	return record
}

// readRecordedArgv returns the recorded argv lines, or nil when the fake
// binary never ran.
func readRecordedArgv(t *testing.T, record string) []string {
	t.Helper()
	data, err := os.ReadFile(record)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
}

func TestInstalledBridgeVersionAbsent(t *testing.T) {
	for _, dir := range []string{t.TempDir(), filepath.Join(t.TempDir(), "missing")} {
		got, err := InstalledBridgeVersion(dir)
		if err != nil || got != "" {
			t.Errorf("InstalledBridgeVersion(%q) = (%q, %v), want (\"\", nil)", dir, got, err)
		}
	}
}

func TestInstalledBridgeVersionScansManifest(t *testing.T) {
	dir := t.TempDir()
	writeBridgeFixture(t, dir, "1.2.3")
	got, err := InstalledBridgeVersion(dir)
	if err != nil || got != "1.2.3" {
		t.Errorf("InstalledBridgeVersion = (%q, %v), want (\"1.2.3\", nil)", got, err)
	}
}

// A partial upgrade can leave several version dirs behind — the numerically
// greatest version wins, not the lexicographically greatest dir name.
func TestInstalledBridgeVersionPicksNumericMax(t *testing.T) {
	dir := t.TempDir()
	writeBridgeFixture(t, dir, "1.9.0")
	writeBridgeFixture(t, dir, "1.10.0")
	got, err := InstalledBridgeVersion(dir)
	if err != nil || got != "1.10.0" {
		t.Errorf("InstalledBridgeVersion = (%q, %v), want (\"1.10.0\", nil)", got, err)
	}
}

func TestInstalledBridgeVersionMalformedManifest(t *testing.T) {
	dir := t.TempDir()
	pkgDir := filepath.Join(dir, "run-kit.rk-code-bridge-1.2.3")
	if err := os.MkdirAll(pkgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pkgDir, "package.json"), []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := InstalledBridgeVersion(dir); err == nil {
		t.Error("malformed package.json must be an error, got nil")
	}
}

func TestInstallBridgeExtensionInstallsWhenAbsent(t *testing.T) {
	home := isolateHome(t)
	t.Setenv("XDG_DATA_HOME", "") // force the ~/.local/share fallback
	record := fakeManagedCodeServer(t, home, 0)
	extDir := ExtensionsDir(home)

	var progress bytes.Buffer
	changed, err := InstallBridgeExtension(context.Background(), home, []byte("VSIX"), "1.2.3", &progress)
	if err != nil || !changed {
		t.Fatalf("InstallBridgeExtension = (%v, %v), want (true, nil)", changed, err)
	}

	argv := readRecordedArgv(t, record)
	want := []string{"--install-extension", argv[1], "--extensions-dir", extDir, "--force"}
	if len(argv) != len(want) {
		t.Fatalf("argv = %v, want %v", argv, want)
	}
	for i := range want {
		if argv[i] != want[i] {
			t.Fatalf("argv = %v, want %v", argv, want)
		}
	}
	vsixPath := argv[1]
	if !strings.HasPrefix(filepath.Base(vsixPath), "rk-code-bridge-") || !strings.HasSuffix(vsixPath, ".vsix") {
		t.Errorf("staged VSIX path = %q, want an rk-code-bridge-*.vsix name", vsixPath)
	}
	// The staged VSIX and its private temp dir are removed after the install.
	if _, err := os.Stat(vsixPath); !os.IsNotExist(err) {
		t.Errorf("staged VSIX still exists at %q", vsixPath)
	}
	if _, err := os.Stat(filepath.Dir(vsixPath)); !os.IsNotExist(err) {
		t.Errorf("staging dir still exists at %q", filepath.Dir(vsixPath))
	}
}

func TestInstallBridgeExtensionSkipsWhenSameVersion(t *testing.T) {
	home := isolateHome(t)
	xdg := t.TempDir()
	t.Setenv("XDG_DATA_HOME", xdg)
	record := fakeManagedCodeServer(t, home, 0)
	writeBridgeFixture(t, ExtensionsDir(home), "1.2.3")

	var progress bytes.Buffer
	changed, err := InstallBridgeExtension(context.Background(), home, []byte("VSIX"), "1.2.3", &progress)
	if err != nil || changed {
		t.Fatalf("InstallBridgeExtension = (%v, %v), want (false, nil)", changed, err)
	}
	if argv := readRecordedArgv(t, record); argv != nil {
		t.Errorf("code-server ran on the same-version skip: argv = %v", argv)
	}
	if !strings.Contains(progress.String(), "code bridge extension v1.2.3 already installed") {
		t.Errorf("progress = %q, want the already-installed skip note", progress.String())
	}
}

func TestInstallBridgeExtensionUpgradesWhenOlder(t *testing.T) {
	home := isolateHome(t)
	t.Setenv("XDG_DATA_HOME", "") // force the ~/.local/share fallback
	record := fakeManagedCodeServer(t, home, 0)
	writeBridgeFixture(t, ExtensionsDir(home), "1.2.3")

	var progress bytes.Buffer
	changed, err := InstallBridgeExtension(context.Background(), home, []byte("VSIX"), "1.3.0", &progress)
	if err != nil || !changed {
		t.Fatalf("InstallBridgeExtension = (%v, %v), want (true, nil)", changed, err)
	}
	argv := readRecordedArgv(t, record)
	if len(argv) != 5 || argv[0] != "--install-extension" || argv[2] != "--extensions-dir" || argv[4] != "--force" {
		t.Errorf("argv = %v, want --install-extension <vsix> --extensions-dir <dir> --force", argv)
	}
}

func TestInstallBridgeExtensionFailureIsReturned(t *testing.T) {
	home := isolateHome(t)
	t.Setenv("XDG_DATA_HOME", "")
	fakeManagedCodeServer(t, home, 1)

	changed, err := InstallBridgeExtension(context.Background(), home, []byte("VSIX"), "1.2.3", &bytes.Buffer{})
	if err == nil || changed {
		t.Fatalf("InstallBridgeExtension = (%v, %v), want (false, non-nil) on a subprocess failure", changed, err)
	}
	if !strings.Contains(err.Error(), "code-server --install-extension") {
		t.Errorf("err = %v, want it to name the failed step", err)
	}
}

func TestInstallBridgeExtensionNoManagedBinary(t *testing.T) {
	home := isolateHome(t) // no managed install at all
	t.Setenv("XDG_DATA_HOME", "")
	changed, err := InstallBridgeExtension(context.Background(), home, []byte("VSIX"), "1.2.3", &bytes.Buffer{})
	if err == nil || changed {
		t.Fatalf("InstallBridgeExtension = (%v, %v), want (false, non-nil) without a managed binary", changed, err)
	}
}
