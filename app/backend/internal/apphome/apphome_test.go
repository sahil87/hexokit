package apphome

import (
	"os"
	"path/filepath"
	"testing"
)

// seedHomes materializes the named dirs under root ("hexokit", "run-kit").
func seedHomes(t *testing.T, root string, names ...string) {
	t.Helper()
	for _, name := range names {
		if err := os.MkdirAll(filepath.Join(root, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

// TestConfigDirResolution covers the dual-read rule for the config home:
// new-if-exists, else legacy-if-exists, else new. XDG_CONFIG_HOME must never
// move the root.
func TestConfigDirResolution(t *testing.T) {
	cases := []struct {
		name string
		seed []string
		want string // "hexokit" or "run-kit"
	}{
		{"fresh install (neither exists)", nil, Name},
		{"legacy only (pre-migration install)", []string{LegacyName}, LegacyName},
		{"new only (migrated or fresh-created)", []string{Name}, Name},
		{"both exist (new wins)", []string{Name, LegacyName}, Name},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			seedHomes(t, filepath.Join(home, ".config"), tc.seed...)

			dir, err := ConfigDir()
			if err != nil {
				t.Fatalf("ConfigDir: %v", err)
			}
			if want := filepath.Join(home, ".config", tc.want); dir != want {
				t.Errorf("ConfigDir() = %q, want %q", dir, want)
			}
		})
	}
}

// TestStateDirResolution covers the same rule for the state home, with and
// without XDG_STATE_HOME.
func TestStateDirResolution(t *testing.T) {
	cases := []struct {
		name string
		seed []string
		want string
	}{
		{"fresh install (neither exists)", nil, Name},
		{"legacy only (pre-migration install)", []string{LegacyName}, LegacyName},
		{"new only", []string{Name}, Name},
		{"both exist (new wins)", []string{Name, LegacyName}, Name},
	}
	for _, tc := range cases {
		t.Run("xdg set/"+tc.name, func(t *testing.T) {
			xdg := t.TempDir()
			t.Setenv("XDG_STATE_HOME", xdg)
			seedHomes(t, xdg, tc.seed...)

			dir, err := StateDir()
			if err != nil {
				t.Fatalf("StateDir: %v", err)
			}
			if want := filepath.Join(xdg, tc.want); dir != want {
				t.Errorf("StateDir() = %q, want %q", dir, want)
			}
		})
		t.Run("xdg unset/"+tc.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("XDG_STATE_HOME", "")
			seedHomes(t, filepath.Join(home, ".local", "state"), tc.seed...)

			dir, err := StateDir()
			if err != nil {
				t.Fatalf("StateDir: %v", err)
			}
			if want := filepath.Join(home, ".local", "state", tc.want); dir != want {
				t.Errorf("StateDir() = %q, want %q", dir, want)
			}
		})
	}
}

// TestFileAtHomePathIsNotTheHome: a regular file at the new home's path does
// not claim the name — resolution falls through to the legacy dir when it
// exists, else still reports the new path (the write fails loudly there,
// never silently in some other dir).
func TestFileAtHomePathIsNotTheHome(t *testing.T) {
	t.Run("file at new path, legacy dir present", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		root := filepath.Join(home, ".config")
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, Name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		seedHomes(t, root, LegacyName)

		dir, err := ConfigDir()
		if err != nil {
			t.Fatalf("ConfigDir: %v", err)
		}
		if want := filepath.Join(root, LegacyName); dir != want {
			t.Errorf("ConfigDir() = %q, want the legacy dir %q", dir, want)
		}
	})

	t.Run("file at legacy path counts as fresh", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		root := filepath.Join(home, ".config")
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, LegacyName), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}

		dir, err := ConfigDir()
		if err != nil {
			t.Fatalf("ConfigDir: %v", err)
		}
		if want := filepath.Join(root, Name); dir != want {
			t.Errorf("ConfigDir() = %q, want the new dir %q", dir, want)
		}
	})
}

// TestFixedHomes pins the unresolved per-name paths the migration copies from
// and publishes to.
func TestFixedHomes(t *testing.T) {
	home := t.TempDir()
	xdg := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", xdg)

	checks := []struct {
		name string
		fn   func() (string, error)
		want string
	}{
		{"NewConfigDir", NewConfigDir, filepath.Join(home, ".config", Name)},
		{"LegacyConfigDir", LegacyConfigDir, filepath.Join(home, ".config", LegacyName)},
		{"NewStateDir", NewStateDir, filepath.Join(xdg, Name)},
		{"LegacyStateDir", LegacyStateDir, filepath.Join(xdg, LegacyName)},
	}
	for _, c := range checks {
		got, err := c.fn()
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("%s() = %q, want %q", c.name, got, c.want)
		}
	}

	// The state root falls back to ~/.local/state when XDG_STATE_HOME is unset.
	t.Setenv("XDG_STATE_HOME", "")
	got, err := NewStateDir()
	if err != nil {
		t.Fatalf("NewStateDir (xdg unset): %v", err)
	}
	if want := filepath.Join(home, ".local", "state", Name); got != want {
		t.Errorf("NewStateDir() = %q, want %q", got, want)
	}
}

// TestUnmigratedExistingInstall covers the shared pin predicate: new config
// dir absent AND (legacy config OR legacy state present). Both port pins (the
// migration's and config's virtual pin) key on it, so the table pins every
// combination of the three dirs.
func TestUnmigratedExistingInstall(t *testing.T) {
	cases := []struct {
		name      string
		seedCfg   []string // under ~/.config
		seedState []string // under $XDG_STATE_HOME
		want      bool
	}{
		{"fresh install (nothing exists)", nil, nil, false},
		{"legacy config only", []string{LegacyName}, nil, true},
		{"legacy state only", nil, []string{LegacyName}, true},
		{"both legacy dirs", []string{LegacyName}, []string{LegacyName}, true},
		{"new config only (fresh-created or migrated)", []string{Name}, nil, false},
		{"new config + legacy state (migrated config)", []string{Name}, []string{LegacyName}, false},
		{"everything present (migrated, legacy left in place)", []string{Name, LegacyName}, []string{LegacyName}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			xdg := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("XDG_STATE_HOME", xdg)
			seedHomes(t, filepath.Join(home, ".config"), tc.seedCfg...)
			seedHomes(t, xdg, tc.seedState...)

			if got := UnmigratedExistingInstall(); got != tc.want {
				t.Errorf("UnmigratedExistingInstall() = %v, want %v", got, tc.want)
			}
		})
	}
}
