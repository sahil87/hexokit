package tmux

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestListWindowsStrict(t *testing.T) {
	server, session := withRealSessionTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	windows, err := ListWindowsStrict(ctx, session, server)
	if err != nil || len(windows) != 2 {
		t.Fatalf("windows=%v err=%v", windows, err)
	}
	for _, w := range windows {
		if len(w.Panes) != 1 {
			t.Fatalf("missing panes: %+v", w)
		}
	}
	if _, err := ListWindowsStrict(ctx, "missing", server); err == nil {
		t.Fatal("strict read hid a disappeared session")
	}
	if _, err := ListWindows(ctx, "missing", server); err != nil {
		t.Fatalf("dashboard tolerance changed: %v", err)
	}
}

func TestListWindowsStrictPaneFailure(t *testing.T) {
	// The fake executable lets list-windows succeed but denies list-panes:
	// the dashboard reader tolerates this, while inventory must report it.
	dir := t.TempDir()
	script := "#!/bin/sh\ncase \"$*\" in\n *list-windows*) printf '@1\\t0\\twork\\t/tmp\\t0\\t1\\tzsh\\n';;\n *list-panes*) echo 'pane query denied' >&2; exit 1;;\n *) exit 1;;\nesac\n"
	if err := os.WriteFile(filepath.Join(dir, "tmux"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := ListWindowsStrict(ctx, "work", "rk-test-inventory"); err == nil || !strings.Contains(err.Error(), "pane query denied") {
		t.Fatalf("pane error: %v", err)
	}
	if _, err := ListWindows(ctx, "work", "rk-test-inventory"); err != nil {
		t.Fatalf("dashboard tolerance: %v", err)
	}
}

func TestListServersStrictCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ListServersStrict(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled discovery: %v", err)
	}
}

func TestListServersStrictMissingTmux(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if _, err := ListServersStrict(context.Background()); err == nil || !strings.Contains(err.Error(), "tmux") {
		t.Fatalf("missing tmux: %v", err)
	}
}
