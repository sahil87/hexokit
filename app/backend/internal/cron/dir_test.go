package cron

import (
	"os"
	"os/user"
	"path/filepath"
	"testing"
)

func TestDefaultDirXDGOverride(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_STATE_HOME", xdg)
	dir, err := DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(xdg, "hexokit", "cron"); dir != want {
		t.Errorf("dir = %q, want %q", dir, want)
	}

	// A pre-migration install (only the legacy home exists) still resolves
	// there — the dual-read window.
	if err := os.MkdirAll(filepath.Join(xdg, "run-kit"), 0o755); err != nil {
		t.Fatal(err)
	}
	dir, err = DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(xdg, "run-kit", "cron"); dir != want {
		t.Errorf("dir with only the legacy home = %q, want %q", dir, want)
	}
}

func TestDefaultDirFallback(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	dir, err := DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, ".local", "state", "hexokit", "cron"); dir != want {
		t.Errorf("dir = %q, want %q", dir, want)
	}
}

func TestValidSlug(t *testing.T) {
	for _, ok := range []string{"dev", "rk-test-1", "a_b-C9", "default"} {
		if !ValidSlug(ok) {
			t.Errorf("ValidSlug(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"", "a/b", "../x", "a.b", "a b", "a:b", ".", "..", `a\b`} {
		if ValidSlug(bad) {
			t.Errorf("ValidSlug(%q) = true, want false", bad)
		}
	}
}

func TestPathBuildersRejectBadSlugs(t *testing.T) {
	dir := t.TempDir()
	for _, slug := range []string{"../evil", "a.b", "a/b"} {
		for _, build := range []func(string, string) (string, error){EntriesPath, LogPath, CursorPath} {
			if _, err := build(dir, slug); err == nil {
				t.Errorf("path builder accepted slug %q", slug)
			}
		}
	}
	// FabOperatorStatePath's input is a fab slug derived from a socket path:
	// "." is legal (socket paths contain dots); only "" / "/" / NUL are not.
	for _, slug := range []string{"../evil", "a/b", ""} {
		if _, err := FabOperatorStatePath(slug); err == nil {
			t.Errorf("FabOperatorStatePath accepted slug %q", slug)
		}
	}
	if _, err := FabOperatorStatePath("tmp-tmux--1001.runKit"); err != nil {
		t.Errorf("FabOperatorStatePath rejected a dotted slug: %v", err)
	}
	// And nothing was created outside the state dir.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("state dir not empty after rejected path builds: %v", entries)
	}
}

func TestPathBuilders(t *testing.T) {
	dir := "/state/cron"
	checks := map[string]string{}
	for name, build := range map[string]func(string, string) (string, error){
		"entries": EntriesPath, "log": LogPath, "cursor": CursorPath,
	} {
		p, err := build(dir, "dev")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		checks[name] = p
	}
	if checks["entries"] != "/state/cron/dev.yaml" ||
		checks["log"] != "/state/cron/dev.log" ||
		checks["cursor"] != "/state/cron/dev.cursor.yaml" {
		t.Errorf("paths = %v", checks)
	}
	if got := LockPath(dir); got != "/state/cron/.lock" {
		t.Errorf("LockPath = %q", got)
	}
}

// TestFabOperatorSlug mirrors fab-kit's slugify rule cell by cell: the `-` →
// `--` escape happens before any other rewrite (a socket-dir dash and a
// path-join dash never collide), the leading `/` is stripped, remaining `/`
// become `-`, and the empty path slugs to "default".
func TestFabOperatorSlug(t *testing.T) {
	cases := []struct {
		socket, want string
	}{
		{"/tmp/tmux-1001/runKit", "tmp-tmux--1001-runKit"},
		{"/tmp/tmux/1000/default", "tmp-tmux-1000-default"},
		{"", "default"},
		{"/private/tmp/tmux-501/default", "private-tmp-tmux--501-default"},
		{"/run/user/1000/tmux.default", "run-user-1000-tmux.default"},
		{"relative.sock", "relative.sock"},
		{"/", "default"},
	}
	for _, tc := range cases {
		if got := FabOperatorSlug(tc.socket); got != tc.want {
			t.Errorf("FabOperatorSlug(%q) = %q, want %q", tc.socket, got, tc.want)
		}
	}
}

func TestFabOperatorStatePath(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", "/tmp/xdg-fab")
	p, err := FabOperatorStatePath("dev")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join("/tmp/xdg-fab", "fab", "operator", "dev.yaml"); p != want {
		t.Errorf("path = %q, want %q", p, want)
	}

	t.Setenv("XDG_STATE_HOME", "")
	u, err := user.Current()
	if err != nil || u.HomeDir == "" {
		t.Skip("no home dir")
	}
	p, err = FabOperatorStatePath("dev")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(u.HomeDir, ".local", "state", "fab", "operator", "dev.yaml"); p != want {
		t.Errorf("fallback path = %q, want %q", p, want)
	}
}

func TestEnsureDirMode(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cron")
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != dirMode {
		t.Errorf("dir mode = %o, want %o", st.Mode().Perm(), dirMode)
	}
	// Idempotent.
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
}
