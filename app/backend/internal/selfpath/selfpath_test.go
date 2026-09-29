package selfpath

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStableForMapsCellarPathToBrewPrefixSymlink(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"linuxbrew hexokit cellar", "/home/linuxbrew/.linuxbrew/Cellar/hexokit/3.20.22/bin/hexokit", "/home/linuxbrew/.linuxbrew/bin/hexokit"},
		{"macos hexokit cellar", "/opt/homebrew/Cellar/hexokit/3.20.22/bin/hexokit", "/opt/homebrew/bin/hexokit"},
		{"linuxbrew legacy run-kit cellar", "/home/linuxbrew/.linuxbrew/Cellar/run-kit/3.19.42/bin/run-kit", "/home/linuxbrew/.linuxbrew/bin/run-kit"},
		{"macos legacy run-kit cellar", "/opt/homebrew/Cellar/run-kit/0.5.3/bin/run-kit", "/opt/homebrew/bin/run-kit"},
		{"usr local rk", "/usr/local/bin/rk", "/usr/local/bin/rk"},
		{"go bin rk", "/home/u/go/bin/rk", "/home/u/go/bin/rk"},
		{"empty", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := StableFor(tc.in); got != tc.want {
				t.Errorf("StableFor(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestIsBrewInstalled(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"hexokit keg", "/opt/homebrew/Cellar/hexokit/3.20.22/bin/hexokit", true},
		{"linuxbrew hexokit keg", "/home/linuxbrew/.linuxbrew/Cellar/hexokit/3.20.22/bin/hexokit", true},
		{"legacy run-kit keg", "/opt/homebrew/Cellar/run-kit/3.20.21/bin/run-kit", true},
		{"retired rk keg", "/opt/homebrew/Cellar/rk/1.0.0/bin/rk", false},
		{"dev build", "/home/u/code/run-kit/app/backend/bin/rk", false},
		{"brew prefix symlink", "/opt/homebrew/bin/hexokit", false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsBrewInstalled(tc.in); got != tc.want {
				t.Errorf("IsBrewInstalled(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestStableComposesResolveAndStableFor(t *testing.T) {
	resolved, err := Resolve()
	if err != nil {
		t.Fatal(err)
	}
	got, err := Stable()
	if err != nil {
		t.Fatal(err)
	}
	if got == "" {
		t.Fatal("Stable() returned an empty path")
	}
	if want := StableFor(resolved); got != want {
		t.Errorf("Stable() = %q, want StableFor(Resolve()) = %q", got, want)
	}
}

func TestLauncherFor(t *testing.T) {
	if got := LauncherFor("/home/u"); got != "/home/u/.local/share/rk/bin/run-kit" {
		t.Errorf("LauncherFor = %q, want /home/u/.local/share/rk/bin/run-kit", got)
	}
}

func TestLauncherComposesUserHomeDir(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	got, err := Launcher()
	if err != nil {
		t.Fatal(err)
	}
	if want := LauncherFor(home); got != want {
		t.Errorf("Launcher() = %q, want LauncherFor(home) = %q", got, want)
	}
}

func TestLiveLauncherFor(t *testing.T) {
	newHome := func(t *testing.T) string {
		t.Helper()
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Dir(LauncherFor(home)), 0o755); err != nil {
			t.Fatal(err)
		}
		return home
	}
	target := filepath.Join(t.TempDir(), "run-kit")
	if err := os.WriteFile(target, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Run("live symlink accepted", func(t *testing.T) {
		home := newHome(t)
		if err := os.Symlink(target, LauncherFor(home)); err != nil {
			t.Fatal(err)
		}
		p, ok := LiveLauncherFor(home)
		if !ok || p != LauncherFor(home) {
			t.Errorf("LiveLauncherFor = (%q, %t), want (%q, true)", p, ok, LauncherFor(home))
		}
	})
	t.Run("absent rejected", func(t *testing.T) {
		if _, ok := LiveLauncherFor(newHome(t)); ok {
			t.Error("LiveLauncherFor accepted an absent launcher")
		}
	})
	t.Run("foreign regular file rejected", func(t *testing.T) {
		home := newHome(t)
		if err := os.WriteFile(LauncherFor(home), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		if _, ok := LiveLauncherFor(home); ok {
			t.Error("LiveLauncherFor accepted a regular file (foreign — never rk's)")
		}
	})
	t.Run("dangling symlink rejected", func(t *testing.T) {
		home := newHome(t)
		if err := os.Symlink(filepath.Join(home, "deleted-keg"), LauncherFor(home)); err != nil {
			t.Fatal(err)
		}
		if _, ok := LiveLauncherFor(home); ok {
			t.Error("LiveLauncherFor accepted a dangling symlink")
		}
	})
}

func TestReplaceSymlinkReplacesTargetAtomically(t *testing.T) {
	dir := t.TempDir()
	link := filepath.Join(dir, "run-kit")
	if err := os.Symlink("/target/a", link); err != nil {
		t.Fatal(err)
	}
	if err := ReplaceSymlink("/target/b", link); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("%s is not a symlink", link)
	}
	target, err := os.Readlink(link)
	if err != nil {
		t.Fatal(err)
	}
	if target != "/target/b" {
		t.Errorf("link target = %q, want /target/b", target)
	}
	if stale, _ := filepath.Glob(filepath.Join(dir, ".run-kit.tmp-*")); len(stale) != 0 {
		t.Errorf("temp entries left behind: %v", stale)
	}
}

func TestReplaceSymlinkSweepsStaleTemps(t *testing.T) {
	dir := t.TempDir()
	link := filepath.Join(dir, "run-kit")
	if err := os.Symlink("/target/a", link); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, ".run-kit.tmp-2147483000")
	if err := os.Symlink("/target/old", stale); err != nil {
		t.Fatal(err)
	}
	// A regular file under the temp pattern is not rk's and survives the sweep.
	foreign := filepath.Join(dir, ".run-kit.tmp-2")
	if err := os.WriteFile(foreign, []byte("user file"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ReplaceSymlink("/target/b", link); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(stale); !os.IsNotExist(err) {
		t.Errorf("stale temp symlink not swept: %v", err)
	}
	if _, err := os.Lstat(foreign); err != nil {
		t.Errorf("foreign temp file removed: %v", err)
	}
	target, err := os.Readlink(link)
	if err != nil {
		t.Fatal(err)
	}
	if target != "/target/b" {
		t.Errorf("link target = %q, want /target/b", target)
	}
}
