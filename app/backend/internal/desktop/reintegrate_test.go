package desktop

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestReintegrateLinux: the wrapper re-points the launcher entry, the icon,
// and the ~/.local/bin symlink at root/current — the shape the ~/.rk move
// needs after the install root itself moved. PATH is emptied so a real
// update-desktop-database on the host is never run.
func TestReintegrateLinux(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir())

	root := t.TempDir()
	write := func(rel, content string, mode os.FileMode) {
		t.Helper()
		p := filepath.Join(root, "1.2.3", rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
	write("AppRun", "#!/bin/sh\n", 0o755)
	write(filepath.Join("usr", "share", "icons", "hicolor", "1024x1024", "apps", "hexokit-desktop.png"), "png", 0o644)
	if err := os.Symlink("1.2.3", filepath.Join(root, "current")); err != nil {
		t.Fatal(err)
	}

	ReintegrateLinux(context.Background(), root, io.Discard)

	appRun := filepath.Join(root, "current", "AppRun")
	entry, err := os.ReadFile(filepath.Join(home, ".local", "share", "applications", linuxDesktopEntryName))
	if err != nil {
		t.Fatalf("launcher entry missing: %v", err)
	}
	if !strings.Contains(string(entry), `Exec="`+appRun+`"`) {
		t.Errorf("launcher entry Exec= does not point at %s:\n%s", appRun, entry)
	}
	link := filepath.Join(home, ".local", "bin", "hexokit-desktop")
	target, err := os.Readlink(link)
	if err != nil {
		t.Fatalf("~/.local/bin symlink missing: %v", err)
	}
	if target != appRun {
		t.Errorf("~/.local/bin/hexokit-desktop -> %q, want %q", target, appRun)
	}
	icon, err := os.ReadFile(filepath.Join(home, ".local", "share", "icons", "hicolor", "1024x1024", "apps", "hexokit-desktop.png"))
	if err != nil || string(icon) != "png" {
		t.Errorf("icon not installed: %q, %v", icon, err)
	}
}
