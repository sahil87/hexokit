package versionprune

import (
	"bytes"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// mkVersion creates <root>/<name>/ with one marker file so a wrongly deleted
// dir is distinguishable from a wrongly emptied one.
func mkVersion(t *testing.T, root, name string) {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "marker"), []byte(name), 0o644); err != nil {
		t.Fatalf("write marker in %s: %v", dir, err)
	}
}

// flip points <root>/current at version (a relative link, as both installers
// write it).
func flip(t *testing.T, root, version string) {
	t.Helper()
	if err := os.Symlink(version, filepath.Join(root, currentLinkName)); err != nil {
		t.Fatalf("symlink current -> %s: %v", version, err)
	}
}

// entries returns the sorted names directly under root.
func entries(t *testing.T, root string) []string {
	t.Helper()
	des, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("readdir %s: %v", root, err)
	}
	names := make([]string, 0, len(des))
	for _, e := range des {
		names = append(names, e.Name())
	}
	slices.Sort(names)
	return names
}

func TestPruneKeepsCurrentAndPassedPrevious(t *testing.T) {
	root := t.TempDir()
	for _, v := range []string{"4.134.0", "4.138.2", "4.139.1", "4.140.0"} {
		mkVersion(t, root, v)
	}
	flip(t, root, "4.140.0")

	Prune(root, "4.139.1", discardLogger())

	want := []string{"4.139.1", "4.140.0", "current"}
	if got := entries(t, root); !slices.Equal(got, want) {
		t.Errorf("entries = %v, want %v", got, want)
	}
}

func TestPruneSemverFallbackPicksHighestBelowCurrent(t *testing.T) {
	root := t.TempDir()
	// 4.138.10 > 4.138.2 numerically; a lexical sort would pick wrongly.
	for _, v := range []string{"4.134.0", "4.138.2", "4.138.10", "4.139.1"} {
		mkVersion(t, root, v)
	}
	flip(t, root, "4.139.1")

	Prune(root, "", discardLogger())

	want := []string{"4.138.10", "4.139.1", "current"}
	if got := entries(t, root); !slices.Equal(got, want) {
		t.Errorf("entries = %v, want %v", got, want)
	}
}

func TestPruneNeverDeletesCurrentTargetEvenWhenLowest(t *testing.T) {
	root := t.TempDir()
	for _, v := range []string{"4.134.0", "4.138.0", "4.139.1"} {
		mkVersion(t, root, v)
	}
	flip(t, root, "4.134.0")

	Prune(root, "", discardLogger())

	// No version sits below current, so the fallback previous is empty and
	// only the current target survives.
	want := []string{"4.134.0", "current"}
	if got := entries(t, root); !slices.Equal(got, want) {
		t.Errorf("entries = %v, want %v", got, want)
	}
	if _, err := os.Stat(filepath.Join(root, "4.134.0", "marker")); err != nil {
		t.Errorf("current target's contents missing: %v", err)
	}
}

func TestPruneLeavesNonVersionEntriesAlone(t *testing.T) {
	root := t.TempDir()
	mkVersion(t, root, "4.130.0")
	mkVersion(t, root, "4.134.0")
	mkVersion(t, root, "4.139.1")
	flip(t, root, "4.139.1")
	staging := filepath.Join(root, ".staging-1234")
	if err := os.Mkdir(staging, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "latest"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "notes.txt"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	Prune(root, "", discardLogger())

	// 4.130.0 is pruned; 4.134.0 survives as the fallback previous.
	want := []string{".staging-1234", "4.134.0", "4.139.1", "current", "latest", "notes.txt"}
	if got := entries(t, root); !slices.Equal(got, want) {
		t.Errorf("entries = %v, want %v", got, want)
	}
	target, err := os.Readlink(filepath.Join(root, "current"))
	if err != nil || target != "4.139.1" {
		t.Errorf("current symlink = %q, %v; want 4.139.1", target, err)
	}
}

func TestPruneLeavesSymlinkedVersionEntryInPlace(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	mkVersion(t, root, "4.139.1")
	flip(t, root, "4.139.1")
	if err := os.Symlink(outside, filepath.Join(root, "4.100.0")); err != nil {
		t.Fatal(err)
	}

	Prune(root, "", discardLogger())

	fi, err := os.Lstat(filepath.Join(root, "4.100.0"))
	if err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("symlinked version entry gone or not a symlink: %v", err)
	}
}

func TestPruneMissingRootIsNoOp(t *testing.T) {
	Prune(filepath.Join(t.TempDir(), "nope"), "", discardLogger())
}

func TestPruneEmptyRootIsNoOp(t *testing.T) {
	root := t.TempDir()
	Prune(root, "", discardLogger())
	if got := entries(t, root); len(got) != 0 {
		t.Errorf("entries = %v, want empty", got)
	}
}

func TestPruneWithoutCurrentSymlinkDeletesNothing(t *testing.T) {
	root := t.TempDir()
	mkVersion(t, root, "4.134.0")
	mkVersion(t, root, "4.139.1")

	Prune(root, "", discardLogger())

	want := []string{"4.134.0", "4.139.1"}
	if got := entries(t, root); !slices.Equal(got, want) {
		t.Errorf("entries = %v, want %v", got, want)
	}
}

func TestPrunePassedPreviousNeedNotExist(t *testing.T) {
	root := t.TempDir()
	mkVersion(t, root, "4.140.0")
	flip(t, root, "4.140.0")

	Prune(root, "4.139.1", discardLogger())

	want := []string{"4.140.0", "current"}
	if got := entries(t, root); !slices.Equal(got, want) {
		t.Errorf("entries = %v, want %v", got, want)
	}
}

// WriterLogger renders prune output as plain chatter lines on the writer (the
// install commands' Progress channel): no timestamps, warn lines prefixed.
func TestWriterLoggerRendersChatterLines(t *testing.T) {
	var buf bytes.Buffer
	logger := WriterLogger(&buf)
	logger.Info("version pruning: removed old version", "root", "/r", "version", "4.134.0")
	logger.Warn("version pruning: removing old version failed", "version", "4.135.0")

	got := buf.String()
	for _, want := range []string{
		"version pruning: removed old version root=/r version=4.134.0\n",
		"warning: version pruning: removing old version failed version=4.135.0\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("output = %q, want it to contain %q", got, want)
		}
	}
}
