package homemigrate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/codebridge"
	"rk/internal/portpolicy"
	"rk/internal/settings"
)

// stubLegacyLiveHosts pins the live code-bridge host seam for a test and
// returns a setter that flips the stubbed liveness between boots.
func stubLegacyLiveHosts(t *testing.T) func(live bool) {
	t.Helper()
	orig := legacyLiveHostsFn
	isLive := false
	legacyLiveHostsFn = func(context.Context, string) ([]codebridge.HostRecord, error) {
		if isLive {
			return []codebridge.HostRecord{{HostID: "h1"}}, nil
		}
		return nil, nil
	}
	t.Cleanup(func() { legacyLiveHostsFn = orig })
	return func(live bool) { isLive = live }
}

// legacyHomesFixture isolates the homes and returns the four home paths in
// order: legacy config, new config, legacy state, new state.
func legacyHomesFixture(t *testing.T) (legacyCfg, newCfg, legacyState, newState string) {
	t.Helper()
	configRoot, stateRoot := isolateHomes(t)
	return filepath.Join(configRoot, "run-kit"), filepath.Join(configRoot, "hexokit"),
		filepath.Join(stateRoot, "run-kit"), filepath.Join(stateRoot, "hexokit")
}

func legacyHomeState(t *testing.T, label string) LegacyHomeState {
	t.Helper()
	for _, st := range LegacyHomes(context.Background()) {
		if st.Label == label {
			return st
		}
	}
	t.Fatalf("LegacyHomes returned no %s home", label)
	return LegacyHomeState{}
}

func TestDeleteLegacyHomesHappyPath(t *testing.T) {
	legacyCfg, newCfg, legacyState, newState := legacyHomesFixture(t)
	writeFile(t, filepath.Join(newCfg, "config.yaml"), "port: 3000\n", 0o644)
	writeFile(t, filepath.Join(newState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "port: 3000\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyState, "prstatus.json"), "{}", 0o644)

	DeleteLegacyHomes(discardLogger())

	for _, p := range []string{legacyCfg, legacyState} {
		if exists(p) {
			t.Errorf("legacy home %s must be gone", p)
		}
	}
	if got := readFile(t, filepath.Join(newCfg, "config.yaml")); got != "port: 3000\n" {
		t.Errorf("hexokit config.yaml = %q — the new home must be untouched", got)
	}
	if got := readFile(t, filepath.Join(newState, "cron", "a.json")); got != "{}" {
		t.Errorf("hexokit cron/a.json = %q — the new home must be untouched", got)
	}
}

func TestDeleteLegacyHomesMissingHexokitHome(t *testing.T) {
	legacyCfg, _, legacyState, newState := legacyHomesFixture(t)
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "port: 3000\n", 0o644)
	writeFile(t, filepath.Join(newState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyState, "cron", "a.json"), "{}", 0o600)

	DeleteLegacyHomes(discardLogger())

	if !exists(legacyCfg) {
		t.Error("the legacy config home must be held back while the hexokit config home is missing")
	}
	st := legacyHomeState(t, "config")
	if !strings.Contains(st.Hold, "hexokit") || !strings.Contains(st.Hold, "does not exist") {
		t.Errorf("config hold reason = %q, want it to name the missing hexokit home", st.Hold)
	}
	if exists(legacyState) {
		t.Error("the legacy state home is evaluated on its own guards and must be deleted")
	}
}

func TestDeleteLegacyHomesHexokitSymlinkIntoLegacy(t *testing.T) {
	for _, tc := range []struct{ name, target string }{
		{"absolute", ""},  // filled in below — the absolute legacy path
		{"relative", filepath.Join("..", "..", "run-kit", "tmux.d", "x.conf")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			legacyCfg, newCfg, _, _ := legacyHomesFixture(t)
			writeFile(t, filepath.Join(legacyCfg, "tmux.d", "x.conf"), "set x\n", 0o644)
			link := filepath.Join(newCfg, "tmux.d", "x.conf")
			target := tc.target
			if target == "" {
				target = filepath.Join(legacyCfg, "tmux.d", "x.conf")
			}
			if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, link); err != nil {
				t.Fatal(err)
			}

			st := legacyHomeState(t, "config")
			if st.Hold == "" {
				t.Fatalf("the legacy config home must be held back, got %+v", st)
			}
			if !strings.Contains(st.Hold, link) {
				t.Errorf("hold reason = %q, want it to name the link %s", st.Hold, link)
			}
			DeleteLegacyHomes(discardLogger())
			if !exists(legacyCfg) {
				t.Error("the legacy config home must survive while a hexokit-home symlink points into it")
			}
		})
	}
}

func TestDeleteLegacyHomesHexokitHomeSymlinkIntoLegacy(t *testing.T) {
	legacyCfg, newCfg, legacyState, newState := legacyHomesFixture(t)
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "port: 3000\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(newState, "cron", "a.json"), "{}", 0o600)
	if err := os.Symlink(legacyCfg, newCfg); err != nil {
		t.Fatal(err)
	}

	DeleteLegacyHomes(discardLogger())

	if !exists(legacyCfg) {
		t.Error("the legacy config home must survive while the hexokit config home resolves into it")
	}
	st := legacyHomeState(t, "config")
	if !strings.Contains(st.Hold, "resolves into the legacy tree") {
		t.Errorf("config hold reason = %q, want the real-path guard", st.Hold)
	}
	if exists(legacyState) {
		t.Error("the legacy state home is evaluated on its own guards and must be deleted")
	}
}

func TestDeleteLegacyHomesInnerSymlinkTargetSurvives(t *testing.T) {
	legacyCfg, newCfg, _, _ := legacyHomesFixture(t)
	home := filepath.Dir(filepath.Dir(newCfg))
	dotfiles := filepath.Join(home, "dotfiles", "config.yaml")
	writeFile(t, dotfiles, "theme: dark\n", 0o644)
	if err := os.MkdirAll(legacyCfg, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dotfiles, filepath.Join(legacyCfg, "config.yaml")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(newCfg, "config.yaml"), "port: 3000\n", 0o644)

	DeleteLegacyHomes(discardLogger())

	if exists(legacyCfg) {
		t.Error("the legacy config home must be deleted")
	}
	if got := readFile(t, dotfiles); got != "theme: dark\n" {
		t.Errorf("dotfiles config.yaml = %q — the symlink's target must survive", got)
	}
}

func TestDeleteLegacyHomesSymlinkedLegacyRoot(t *testing.T) {
	legacyCfg, newCfg, _, _ := legacyHomesFixture(t)
	writeFile(t, filepath.Join(newCfg, "config.yaml"), "port: 3000\n", 0o644)
	real := filepath.Join(filepath.Dir(legacyCfg), "real-run-kit")
	writeFile(t, filepath.Join(real, "config.yaml"), "port: 3000\n", 0o644)
	if err := os.Symlink(real, legacyCfg); err != nil {
		t.Fatal(err)
	}

	DeleteLegacyHomes(discardLogger())

	if exists(legacyCfg) {
		t.Error("the legacy config home symlink must be removed")
	}
	if got := readFile(t, filepath.Join(real, "config.yaml")); got != "port: 3000\n" {
		t.Errorf("link target config.yaml = %q — the directory the link pointed to must survive", got)
	}
}

func TestDeleteLegacyHomesLiveCBHostKeepsOnlyCB(t *testing.T) {
	setLive := stubLegacyLiveHosts(t)
	setLive(true)
	_, _, legacyState, newState := legacyHomesFixture(t)
	writeFile(t, filepath.Join(newState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(newState, "snapshots", "s.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyState, "snapshots", "s.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyState, "prstatus.json"), "{}", 0o644)
	writeFile(t, filepath.Join(legacyState, "cb", "hosts", "h1.json"), "{}", 0o600)

	DeleteLegacyHomes(discardLogger())

	entries, err := os.ReadDir(legacyState)
	if err != nil {
		t.Fatalf("the legacy state home must keep cb/: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "cb" {
		t.Errorf("legacy state home entries = %v, want only cb/", entries)
	}

	// A later boot whose check finds no live host removes the rest.
	setLive(false)
	DeleteLegacyHomes(discardLogger())
	if exists(legacyState) {
		t.Error("the legacy state home must be gone once no live host is registered")
	}
}

func TestDeleteLegacyHomesCBRegistryErrorKeepsCB(t *testing.T) {
	orig := legacyLiveHostsFn
	legacyLiveHostsFn = func(context.Context, string) ([]codebridge.HostRecord, error) {
		return nil, errors.New("registry unreadable")
	}
	t.Cleanup(func() { legacyLiveHostsFn = orig })
	_, _, legacyState, newState := legacyHomesFixture(t)
	writeFile(t, filepath.Join(newState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyState, "cron", "a.json"), "{}", 0o600)

	DeleteLegacyHomes(discardLogger())

	if !exists(legacyState) {
		t.Fatal("an unreadable cb registry counts as a live host — cb/ must be kept, never treated as no host")
	}
	if exists(filepath.Join(legacyState, "cron")) {
		t.Error("the rest of the legacy state home must still be deleted")
	}
}

func TestDeleteLegacyHomesSymlinkedStateRootWithLiveHost(t *testing.T) {
	setLive := stubLegacyLiveHosts(t)
	setLive(true)
	_, _, legacyState, newState := legacyHomesFixture(t)
	writeFile(t, filepath.Join(newState, "cron", "a.json"), "{}", 0o600)
	real := filepath.Join(filepath.Dir(legacyState), "real-run-kit")
	writeFile(t, filepath.Join(real, "cb", "hosts", "h1.json"), "{}", 0o600)
	writeFile(t, filepath.Join(real, "cron", "a.json"), "{}", 0o600)
	if err := os.Symlink(real, legacyState); err != nil {
		t.Fatal(err)
	}

	DeleteLegacyHomes(discardLogger())

	if !exists(legacyState) {
		t.Error("a symlinked legacy state root with a live host must be left whole")
	}
	if got := readFile(t, filepath.Join(real, "cron", "a.json")); got != "{}" {
		t.Errorf("link target cron/a.json = %q — the whole home must be left alone this boot", got)
	}
}

func TestDeleteLegacyHomesUnreadableHexokitTree(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores permission bits")
	}
	legacyCfg, newCfg, _, _ := legacyHomesFixture(t)
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "port: 3000\n", 0o644)
	denied := filepath.Join(newCfg, "tmux.d")
	writeFile(t, filepath.Join(denied, "x.conf"), "set x\n", 0o644)
	if err := os.Chmod(denied, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(denied, 0o755) })

	DeleteLegacyHomes(discardLogger())

	if !exists(legacyCfg) {
		t.Error("an unreadable hexokit tree must hold the legacy home back")
	}
}

func TestDeleteLegacyHomesConfigDirOverrideSkips(t *testing.T) {
	legacyCfg, newCfg, legacyState, newState := legacyHomesFixture(t)
	writeFile(t, filepath.Join(newCfg, "config.yaml"), "port: 3000\n", 0o644)
	writeFile(t, filepath.Join(newState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "port: 3000\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "cron", "a.json"), "{}", 0o600)
	before := treeSnapshot(t, filepath.Dir(legacyCfg))
	t.Setenv(settings.ConfigDirEnv, t.TempDir())

	DeleteLegacyHomes(discardLogger())

	assertTreeEqual(t, "config root", before, treeSnapshot(t, filepath.Dir(legacyCfg)))
	if !exists(legacyState) {
		t.Error("RK_CONFIG_DIR must skip the deletion entirely — nothing on disk changes")
	}
}

func TestDeleteLegacyHomesSkipReleasePath(t *testing.T) {
	legacyCfg, newCfg, legacyState, newState := legacyHomesFixture(t)
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "theme: dark\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "cron", "a.json"), "{\"every\":\"1h\"}", 0o600)

	Migrate(discardLogger())
	DeleteLegacyHomes(discardLogger())

	wantCfg := "theme: dark\n" + settings.PortPinComment + "\nport: " + itoa(portpolicy.DaemonLegacy) + "\n"
	if got := readFile(t, filepath.Join(newCfg, "config.yaml")); got != wantCfg {
		t.Errorf("hexokit config.yaml = %q, want %q (the migrated config plus the port pin)", got, wantCfg)
	}
	if got := readFile(t, filepath.Join(newState, "cron", "a.json")); got != "{\"every\":\"1h\"}" {
		t.Errorf("hexokit cron/a.json = %q — the migration must carry the cron entries", got)
	}
	for _, p := range []string{legacyCfg, legacyState} {
		if exists(p) {
			t.Errorf("legacy home %s must be gone after the same-boot deletion", p)
		}
	}
}

func TestDeleteLegacyHomesCorruptCBRecordKeepsCB(t *testing.T) {
	// No stub: the real codebridge.ProbeLiveHosts reads the registry. A
	// record file it cannot decode is unknown, never "no hosts", so cb/ is
	// retained even alongside a cleanly dead record.
	_, _, legacyState, newState := legacyHomesFixture(t)
	writeFile(t, filepath.Join(newState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyState, "cb", "hosts", "dead.json"), `{"hostId":"dead","pid":0}`, 0o600)
	writeFile(t, filepath.Join(legacyState, "cb", "hosts", "bad.json"), "{not json", 0o600)

	DeleteLegacyHomes(discardLogger())

	entries, err := os.ReadDir(legacyState)
	if err != nil {
		t.Fatalf("an undecodable cb record counts as unknown — cb/ must be kept: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "cb" {
		t.Errorf("legacy state home entries = %v, want only cb/", entries)
	}
	if !exists(filepath.Join(legacyState, "cb", "hosts", "dead.json")) {
		t.Error("the guard probe must not prune the dead record — pruning is discovery's job")
	}
}

func TestDeleteLegacyHomesCBGuardDoesNotPrune(t *testing.T) {
	// No stub: the real probe evaluates a dead record (pid 0 fails kill-0,
	// so no socket is ever dialed). The guard path must not remove the
	// record file the way LiveHosts's pruning sweep would.
	_, _, legacyState, newState := legacyHomesFixture(t)
	writeFile(t, filepath.Join(newState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyState, "cron", "a.json"), "{}", 0o600)
	rec := filepath.Join(legacyState, "cb", "hosts", "dead.json")
	writeFile(t, rec, `{"hostId":"dead","pid":0}`, 0o600)

	st := legacyHomeState(t, "state")
	if st.Hold != "" || st.KeepCB {
		t.Errorf("a dead record is no live host, got %+v", st)
	}
	if !exists(rec) {
		t.Error("the guard evaluation must not prune the dead record from the registry")
	}

	DeleteLegacyHomes(discardLogger())
	if exists(legacyState) {
		t.Error("the legacy state home must be deleted once no live host is registered")
	}
}

func TestDeleteLegacyHomesExtensionCreatedStateHome(t *testing.T) {
	// The extension can create <state>/hexokit/cb before the state migration
	// runs; migrateStateHome then skips the copy, so the legacy home holds
	// the only copies of cron/, snapshots/, and the seeded GUI data.
	// Directory existence is no longer proof of migration — the home is held
	// until the migrated entries are present in the hexokit home.
	_, _, legacyState, newState := legacyHomesFixture(t)
	if err := os.MkdirAll(filepath.Join(newState, "cb"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(legacyState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyState, "snapshots", "s.json"), "{}", 0o600)
	writeFile(t, filepath.Join(legacyState, "gui", "icewm", "preferences"), "Theme=fx\n", 0o600)

	st := legacyHomeState(t, "state")
	if st.Hold == "" {
		t.Fatalf("the legacy state home must be held back, got %+v", st)
	}
	if !strings.Contains(st.Hold, "cron") {
		t.Errorf("state hold reason = %q, want it to name the missing migrated cron/ dir", st.Hold)
	}
	DeleteLegacyHomes(discardLogger())
	if !exists(legacyState) {
		t.Error("the legacy state home must survive while the hexokit home lacks the migrated data")
	}

	// Once the migrated entries exist in the hexokit home, the guard
	// releases and the legacy home is deletable.
	writeFile(t, filepath.Join(newState, "cron", "a.json"), "{}", 0o600)
	writeFile(t, filepath.Join(newState, "snapshots", "s.json"), "{}", 0o600)
	writeFile(t, filepath.Join(newState, "gui", "icewm", "preferences"), "Theme=fx\n", 0o600)
	DeleteLegacyHomes(discardLogger())
	if exists(legacyState) {
		t.Error("the legacy state home must be deleted once the migrated data is present in the hexokit home")
	}
}

func TestDeleteLegacyHomesSymlinkedHexokitRootInnerLink(t *testing.T) {
	// WalkDir does not descend a symlinked root: the hexokit home links out
	// to a dotfiles dir whose own symlink points into the legacy tree. The
	// real-path guard passes (the dotfiles dir is outside the legacy home),
	// so the walk must run against the resolved root to see the inner link.
	for _, tc := range []struct{ name, target string }{
		{"absolute", ""}, // filled in below — the absolute legacy path
		{"relative", filepath.Join("..", "run-kit", "config.yaml")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			legacyCfg, newCfg, _, _ := legacyHomesFixture(t)
			writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "port: 3000\n", 0o644)
			external := filepath.Join(filepath.Dir(newCfg), "dotfiles")
			writeFile(t, filepath.Join(external, "config.yaml"), "port: 3000\n", 0o644)
			target := tc.target
			if target == "" {
				target = filepath.Join(legacyCfg, "config.yaml")
			}
			if err := os.Symlink(target, filepath.Join(external, "legacy-conf")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(external, newCfg); err != nil {
				t.Fatal(err)
			}

			st := legacyHomeState(t, "config")
			if st.Hold == "" {
				t.Fatalf("the legacy config home must be held back, got %+v", st)
			}
			externalReal, err := filepath.EvalSymlinks(external)
			if err != nil {
				t.Fatal(err)
			}
			if want := filepath.Join(externalReal, "legacy-conf"); !strings.Contains(st.Hold, want) {
				t.Errorf("hold reason = %q, want it to name the resolved inner link %s", st.Hold, want)
			}
			DeleteLegacyHomes(discardLogger())
			if !exists(legacyCfg) {
				t.Error("the legacy config home must survive while an inner symlink points into it")
			}
		})
	}
}

func TestDeleteLegacyHomesTmuxConfIntoLegacy(t *testing.T) {
	for _, tc := range []struct {
		name   string
		env    bool   // set RK_TMUX_CONF instead of the tmux_conf key
		target string // "" = a file inside the legacy config home
	}{
		{"tmux_conf key", false, ""},
		{"RK_TMUX_CONF env", true, ""},
		{"tmux_conf outside the legacy home", false, "outside"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			legacyCfg, newCfg, _, _ := legacyHomesFixture(t)
			conf := filepath.Join(legacyCfg, "custom-tmux.conf")
			if tc.target == "outside" {
				conf = filepath.Join(filepath.Dir(filepath.Dir(legacyCfg)), "custom-tmux.conf")
			}
			writeFile(t, conf, "set x\n", 0o644)
			writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "port: 3000\n", 0o644)
			if tc.env {
				t.Setenv("RK_TMUX_CONF", conf)
				writeFile(t, filepath.Join(newCfg, "config.yaml"), "port: 3000\n", 0o644)
			} else {
				writeFile(t, filepath.Join(newCfg, "config.yaml"), "tmux_conf: "+conf+"\n", 0o644)
			}

			st := legacyHomeState(t, "config")
			DeleteLegacyHomes(discardLogger())
			if tc.target == "outside" {
				if st.Hold != "" {
					t.Errorf("a tmux conf outside the legacy home must not hold it, got hold %q", st.Hold)
				}
				if exists(legacyCfg) {
					t.Error("the legacy config home must be deleted")
				}
				return
			}
			if st.Hold == "" {
				t.Fatalf("the legacy config home must be held back, got %+v", st)
			}
			if !strings.Contains(st.Hold, conf) {
				t.Errorf("hold reason = %q, want it to name the tmux conf path %s", st.Hold, conf)
			}
			if !exists(legacyCfg) {
				t.Error("the legacy config home must survive while the effective tmux conf points into it")
			}
			if got := readFile(t, conf); got != "set x\n" {
				t.Errorf("custom tmux conf = %q — the file new tmux servers load must survive", got)
			}
		})
	}
}

func TestDeleteLegacyHomesTmuxConfUpgradePath(t *testing.T) {
	// The migration copies the tmux_conf key unchanged and tmux leaves a
	// user-owned path untouched, so after a real migrate the new tmux servers
	// still load the file inside the legacy config home — which must then
	// survive the same-boot deletion.
	legacyCfg, _, legacyState, _ := legacyHomesFixture(t)
	conf := filepath.Join(legacyCfg, "custom-tmux.conf")
	writeFile(t, conf, "set x\n", 0o644)
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "tmux_conf: "+conf+"\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "cron", "a.json"), "{}", 0o600)

	Migrate(discardLogger())
	DeleteLegacyHomes(discardLogger())

	if !exists(legacyCfg) {
		t.Error("the legacy config home must survive while the migrated tmux_conf still points into it")
	}
	if got := readFile(t, conf); got != "set x\n" {
		t.Errorf("custom tmux conf = %q — the file new tmux servers load must survive", got)
	}
	if exists(legacyState) {
		t.Error("the legacy state home is evaluated on its own guards and must be deleted")
	}
}
