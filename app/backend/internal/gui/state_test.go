package gui

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestStateDir(t *testing.T) {
	t.Run("XDG_STATE_HOME wins", func(t *testing.T) {
		xdg := t.TempDir()
		t.Setenv("XDG_STATE_HOME", xdg)
		dir, err := StateDir()
		if err != nil {
			t.Fatalf("StateDir: %v", err)
		}
		if want := filepath.Join(xdg, "hexokit", "gui"); dir != want {
			t.Errorf("StateDir() = %q, want %q", dir, want)
		}
	})

	t.Run("falls back to ~/.local/state", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("XDG_STATE_HOME", "")
		t.Setenv("HOME", home)
		dir, err := StateDir()
		if err != nil {
			t.Fatalf("StateDir: %v", err)
		}
		if want := filepath.Join(home, ".local", "state", "hexokit", "gui"); dir != want {
			t.Errorf("StateDir() = %q, want %q", dir, want)
		}
	})
}

func TestSocketPath(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	p, err := SocketPath("host")
	if err != nil {
		t.Fatalf("SocketPath: %v", err)
	}
	dir, err := StateDir()
	if err != nil {
		t.Fatalf("StateDir: %v", err)
	}
	if want := filepath.Join(dir, "host.sock"); p != want {
		t.Errorf("SocketPath(host) = %q, want %q", p, want)
	}
}

func TestValidateSocketPath(t *testing.T) {
	if err := ValidateSocketPath(strings.Repeat("a", maxSocketPathBytes)); err != nil {
		t.Errorf("%d-byte path rejected, want valid: %v", maxSocketPathBytes, err)
	}
	if err := ValidateSocketPath(strings.Repeat("a", maxSocketPathBytes+1)); err == nil {
		t.Errorf("%d-byte path accepted, want the sun_path cap error", maxSocketPathBytes+1)
	}
}
