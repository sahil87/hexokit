package homemigrate

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"

	"rk/internal/gui"
	"rk/internal/portpolicy"
	"rk/internal/settings"
)

// isolateHomes points HOME and XDG_STATE_HOME at a fresh temp root and
// returns the config/state roots the apphome resolvers derive from them.
// RK_CONFIG_DIR and RK_PORT start unset (empty string reads as unset).
func isolateHomes(t *testing.T) (configRoot, stateRoot string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", filepath.Join(home, "state"))
	t.Setenv(settings.ConfigDirEnv, "")
	t.Setenv("RK_PORT", "")
	return filepath.Join(home, ".config"), filepath.Join(home, "state")
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// treeSnapshot captures a dir tree as relPath → fingerprint (kind, mode,
// content hash or link target) so a test can prove the legacy tree is
// byte-unchanged.
func treeSnapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	if _, err := os.Lstat(root); err != nil {
		return out
	}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			out[rel] = "link:" + target
		case info.IsDir():
			out[rel] = fmt.Sprintf("dir:%o", info.Mode().Perm())
		default:
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			out[rel] = fmt.Sprintf("file:%o:%x", info.Mode().Perm(), sha256.Sum256(data))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot %s: %v", root, err)
	}
	return out
}

func assertTreeEqual(t *testing.T, label string, before, after map[string]string) {
	t.Helper()
	if len(before) != len(after) {
		t.Fatalf("%s: tree size changed: %d -> %d entries\nbefore: %v\nafter:  %v", label, len(before), len(after), sortedKeys(before), sortedKeys(after))
	}
	for k, v := range before {
		if after[k] != v {
			t.Errorf("%s: %s changed: %q -> %q", label, k, v, after[k])
		}
	}
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

// assertNoTempDirs proves no staged .hexokit-migrate-* sibling survives under
// either home's parent.
func assertNoTempDirs(t *testing.T, parents ...string) {
	t.Helper()
	for _, parent := range parents {
		matches, err := filepath.Glob(filepath.Join(parent, tempPrefix+"*"))
		if err != nil {
			t.Fatalf("glob %s: %v", parent, err)
		}
		if len(matches) > 0 {
			t.Errorf("leftover temp dirs under %s: %v", parent, matches)
		}
	}
}

func TestMigrateConfigHomeWholeTree(t *testing.T) {
	configRoot, stateRoot := isolateHomes(t)
	legacyCfg := filepath.Join(configRoot, "run-kit")
	legacyCfgYAML := "theme: dark\nriff_presets:\n  foo: /fab-discuss\n"
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), legacyCfgYAML, 0o644)
	writeFile(t, filepath.Join(legacyCfg, "tmux.conf"), "set -g mouse on\n", 0o644)
	writeFile(t, filepath.Join(legacyCfg, "tmux.d", "user.conf"), "set -g status off\n", 0o600)
	writeFile(t, filepath.Join(legacyCfg, "extra.txt"), "anything else rides along\n", 0o644)
	before := treeSnapshot(t, legacyCfg)

	Migrate(discardLogger())

	newCfg := filepath.Join(configRoot, "hexokit")
	if got := readFile(t, filepath.Join(newCfg, "tmux.conf")); got != "set -g mouse on\n" {
		t.Errorf("tmux.conf = %q, want copied bytes", got)
	}
	if got := readFile(t, filepath.Join(newCfg, "tmux.d", "user.conf")); got != "set -g status off\n" {
		t.Errorf("tmux.d/user.conf = %q, want copied bytes", got)
	}
	if got := readFile(t, filepath.Join(newCfg, "extra.txt")); got != "anything else rides along\n" {
		t.Errorf("extra.txt = %q, want copied bytes", got)
	}
	// The pin is appended to the original bytes — no re-serialize.
	wantCfg := legacyCfgYAML + settings.PortPinComment + "\nport: " + itoa(portpolicy.DaemonLegacy) + "\n"
	if got := readFile(t, filepath.Join(newCfg, "config.yaml")); got != wantCfg {
		t.Errorf("config.yaml = %q, want %q", got, wantCfg)
	}
	// And it parses back through the real settings loader.
	s := settings.Load()
	if s.Port != 3000 || !s.PortPinNote || s.Theme != "dark" || s.RiffPresets["foo"] != "/fab-discuss" {
		t.Errorf("settings.Load = port %d (pin %v), theme %q, presets %v — want 3000/true/dark/foo", s.Port, s.PortPinNote, s.Theme, s.RiffPresets)
	}
	assertTreeEqual(t, "legacy config home", before, treeSnapshot(t, legacyCfg))
	assertNoTempDirs(t, configRoot, stateRoot)
}

func TestMigrateStateHomeCopySet(t *testing.T) {
	configRoot, stateRoot := isolateHomes(t)
	legacyState := filepath.Join(stateRoot, "run-kit")
	writeFile(t, filepath.Join(legacyState, "cron", "a.yaml"), "schedule: \"* * * * *\"\n", 0o600)
	writeFile(t, filepath.Join(legacyState, "snapshots", "s.json"), "{}\n", 0o644)
	// Not copied — droppable caches / runtime rendezvous cold-start.
	writeFile(t, filepath.Join(legacyState, "prstatus.json"), "{}\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "gui", "icewm", "x"), "x\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "code", "w.code-workspace"), "{}\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "cb", "hosts", "h.json"), "{}\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "opencode-export", "o.txt"), "o\n", 0o644)
	before := treeSnapshot(t, legacyState)

	Migrate(discardLogger())

	newState := filepath.Join(stateRoot, "hexokit")
	if got := readFile(t, filepath.Join(newState, "cron", "a.yaml")); got != "schedule: \"* * * * *\"\n" {
		t.Errorf("cron/a.yaml = %q, want copied bytes", got)
	}
	if got := readFile(t, filepath.Join(newState, "snapshots", "s.json")); got != "{}\n" {
		t.Errorf("snapshots/s.json = %q, want copied bytes", got)
	}
	for _, leaf := range []string{"prstatus.json", "gui", "code", "cb", "opencode-export"} {
		if _, err := os.Lstat(filepath.Join(newState, leaf)); !os.IsNotExist(err) {
			t.Errorf("%s must not be copied, but exists under the new state home", leaf)
		}
	}
	assertTreeEqual(t, "legacy state home", before, treeSnapshot(t, legacyState))
	assertNoTempDirs(t, configRoot, stateRoot)
}

func TestMigratePreservesModes(t *testing.T) {
	_, stateRoot := isolateHomes(t)
	legacyState := filepath.Join(stateRoot, "run-kit")
	cronDir := filepath.Join(legacyState, "cron")
	if err := os.MkdirAll(cronDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(cronDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(cronDir, "a.yaml"), "x\n", 0o600)
	sub := filepath.Join(legacyState, "snapshots", "srv")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(sub, "1.json"), "{}\n", 0o600)

	Migrate(discardLogger())

	newState := filepath.Join(stateRoot, "hexokit")
	for rel, want := range map[string]os.FileMode{
		"cron":                 0o700,
		"cron/a.yaml":          0o600,
		"snapshots/srv":        0o700,
		"snapshots/srv/1.json": 0o600,
	} {
		fi, err := os.Lstat(filepath.Join(newState, rel))
		if err != nil {
			t.Fatalf("stat %s: %v", rel, err)
		}
		if got := fi.Mode().Perm(); got != want {
			t.Errorf("%s mode = %o, want %o", rel, got, want)
		}
	}
}

func TestMigratePinExistingPortKept(t *testing.T) {
	configRoot, _ := isolateHomes(t)
	legacyCfg := filepath.Join(configRoot, "run-kit")
	content := "port: 4100\ntheme: dark\n"
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), content, 0o644)

	Migrate(discardLogger())

	got := readFile(t, filepath.Join(configRoot, "hexokit", "config.yaml"))
	if got != content {
		t.Errorf("config.yaml = %q, want byte-identical copy %q (user port kept, no pin comment)", got, content)
	}
	if strings.Contains(got, settings.PortPinComment) {
		t.Error("pin comment must not be added when the file already sets a port")
	}
}

func TestMigratePinNoTrailingNewline(t *testing.T) {
	configRoot, _ := isolateHomes(t)
	legacyCfg := filepath.Join(configRoot, "run-kit")
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "theme: dark", 0o644)

	Migrate(discardLogger())

	got := readFile(t, filepath.Join(configRoot, "hexokit", "config.yaml"))
	want := "theme: dark\n" + settings.PortPinComment + "\nport: 3000\n"
	if got != want {
		t.Errorf("config.yaml = %q, want %q (newline inserted before the pin)", got, want)
	}
	if s := settings.Load(); s.Port != 3000 || s.Theme != "dark" {
		t.Errorf("settings.Load = port %d theme %q, want 3000/dark", s.Port, s.Theme)
	}
}

func TestMigrateStateOnlyInstallGetsPin(t *testing.T) {
	configRoot, stateRoot := isolateHomes(t)
	// No legacy config dir at all; only the legacy state dir exists.
	writeFile(t, filepath.Join(stateRoot, "run-kit", "cron", "a.yaml"), "x\n", 0o600)

	Migrate(discardLogger())

	newCfgYAML := filepath.Join(configRoot, "hexokit", "config.yaml")
	want := settings.PortPinComment + "\nport: 3000\n"
	if got := readFile(t, newCfgYAML); got != want {
		t.Errorf("config.yaml = %q, want just the pin %q", got, want)
	}
	if s := settings.Load(); s.Port != 3000 || !s.PortPinNote {
		t.Errorf("settings.Load = port %d pin %v, want 3000/true", s.Port, s.PortPinNote)
	}
	if got := readFile(t, filepath.Join(stateRoot, "hexokit", "cron", "a.yaml")); got != "x\n" {
		t.Errorf("cron/a.yaml = %q, want copied bytes", got)
	}
}

func TestMigrateFreshInstallNoop(t *testing.T) {
	configRoot, stateRoot := isolateHomes(t)

	Migrate(discardLogger())

	for _, dir := range []string{
		filepath.Join(configRoot, "hexokit"),
		filepath.Join(stateRoot, "hexokit"),
	} {
		if _, err := os.Lstat(dir); !os.IsNotExist(err) {
			t.Errorf("fresh install: %s must not be created", dir)
		}
	}
}

func TestMigratePreExistingNewDirIsNoopNoPin(t *testing.T) {
	configRoot, stateRoot := isolateHomes(t)
	// Both homes already on the new name (migrated earlier or fresh install),
	// with legacy dirs still lying around.
	writeFile(t, filepath.Join(configRoot, "run-kit", "config.yaml"), "theme: dark\n", 0o644)
	writeFile(t, filepath.Join(configRoot, "hexokit", "config.yaml"), "port: 4200\n", 0o644)
	writeFile(t, filepath.Join(stateRoot, "run-kit", "cron", "a.yaml"), "x\n", 0o600)
	writeFile(t, filepath.Join(stateRoot, "hexokit", "marker.txt"), "keep me\n", 0o644)

	Migrate(discardLogger())

	if got := readFile(t, filepath.Join(configRoot, "hexokit", "config.yaml")); got != "port: 4200\n" {
		t.Errorf("pre-existing config home was touched: %q", got)
	}
	if got := readFile(t, filepath.Join(stateRoot, "hexokit", "marker.txt")); got != "keep me\n" {
		t.Errorf("pre-existing state home was touched: %q", got)
	}
	if _, err := os.Lstat(filepath.Join(stateRoot, "hexokit", "cron")); !os.IsNotExist(err) {
		t.Error("legacy cron must not be merged into a pre-existing state home")
	}
	assertNoTempDirs(t, configRoot, stateRoot)
}

func TestMigrateRKPortDoesNotChangePin(t *testing.T) {
	configRoot, _ := isolateHomes(t)
	writeFile(t, filepath.Join(configRoot, "run-kit", "config.yaml"), "theme: dark\n", 0o644)
	t.Setenv("RK_PORT", "21001") // a transient env must never be pinned

	Migrate(discardLogger())

	got := readFile(t, filepath.Join(configRoot, "hexokit", "config.yaml"))
	if !strings.HasSuffix(got, settings.PortPinComment+"\nport: "+itoa(portpolicy.DaemonLegacy)+"\n") {
		t.Errorf("config.yaml = %q, want pin at DaemonLegacy %d regardless of RK_PORT", got, portpolicy.DaemonLegacy)
	}
	if strings.Contains(got, "21001") {
		t.Error("RK_PORT leaked into the pinned config.yaml")
	}
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }

func TestMigrateRaceLoser(t *testing.T) {
	configRoot, stateRoot := isolateHomes(t)
	legacyCfg := filepath.Join(configRoot, "run-kit")
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "theme: dark\n", 0o644)
	writeFile(t, filepath.Join(stateRoot, "run-kit", "cron", "a.yaml"), "x\n", 0o600)
	beforeCfg := treeSnapshot(t, legacyCfg)
	beforeState := treeSnapshot(t, filepath.Join(stateRoot, "run-kit"))

	// Simulate a concurrent migrator winning the publish race: the target
	// appears before our rename lands, which then fails.
	origRename := renameFn
	renameFn = func(oldpath, newpath string) error {
		if err := os.MkdirAll(newpath, 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(newpath, "winner.marker"), []byte("winner\n"), 0o644); err != nil {
			return err
		}
		return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: syscall.ENOTEMPTY}
	}
	t.Cleanup(func() { renameFn = origRename })

	Migrate(discardLogger())

	for _, dir := range []string{filepath.Join(configRoot, "hexokit"), filepath.Join(stateRoot, "hexokit")} {
		if got := readFile(t, filepath.Join(dir, "winner.marker")); got != "winner\n" {
			t.Errorf("%s: winner's content lost: %q", dir, got)
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("readdir %s: %v", dir, err)
		}
		if len(entries) != 1 {
			t.Errorf("%s holds %d entries, want only the winner's marker (our copy must not merge in)", dir, len(entries))
		}
	}
	assertTreeEqual(t, "legacy config home", beforeCfg, treeSnapshot(t, legacyCfg))
	assertTreeEqual(t, "legacy state home", beforeState, treeSnapshot(t, filepath.Join(stateRoot, "run-kit")))
	assertNoTempDirs(t, configRoot, stateRoot)
}

func TestMigrateCopyFailureLeavesLegacyAuthoritative(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads through 0000 modes")
	}
	configRoot, stateRoot := isolateHomes(t)
	legacyCfg := filepath.Join(configRoot, "run-kit")
	writeFile(t, filepath.Join(legacyCfg, "config.yaml"), "theme: dark\n", 0o644)
	writeFile(t, filepath.Join(legacyCfg, "unreadable.conf"), "secret\n", 0o644)
	before := treeSnapshot(t, legacyCfg)
	if err := os.Chmod(filepath.Join(legacyCfg, "unreadable.conf"), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(legacyCfg, "unreadable.conf"), 0o644) })

	var log bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&log, nil))
	Migrate(logger)

	if _, err := os.Lstat(filepath.Join(configRoot, "hexokit")); !os.IsNotExist(err) {
		t.Error("failed copy must leave no partial hexokit config home")
	}
	if !strings.Contains(log.String(), "legacy home stays active") {
		t.Errorf("expected a non-fatal warning, got log %q", log.String())
	}
	// The state home had no legacy dir: nothing published there either.
	if _, err := os.Lstat(filepath.Join(stateRoot, "hexokit")); !os.IsNotExist(err) {
		t.Error("state home must not appear in this scenario")
	}
	assertNoTempDirs(t, configRoot, stateRoot)
	// Restore readability before snapshotting the aftermath.
	if err := os.Chmod(filepath.Join(legacyCfg, "unreadable.conf"), 0o644); err != nil {
		t.Fatal(err)
	}
	assertTreeEqual(t, "legacy config home", before, treeSnapshot(t, legacyCfg))
}

// TestMigrateSymlinkSafety is the R4 dotfiles scenario: every symlink is
// carried over as a link — a contained link verbatim (so it points into the
// new copy), an escaping link with an absolute target (relative rewritten to
// its absolute resolution). Nothing is dereferenced into a copy and nothing
// is dropped.
func TestMigrateSymlinkSafety(t *testing.T) {
	configRoot, _ := isolateHomes(t)
	legacyCfg := filepath.Join(configRoot, "run-kit")
	writeFile(t, filepath.Join(legacyCfg, "tmux.d", "user.conf"), "real\n", 0o644)
	dotfiles := t.TempDir()
	writeFile(t, filepath.Join(dotfiles, "rk.yaml"), "port: 4100\ntheme: dark\n", 0o644)
	writeFile(t, filepath.Join(dotfiles, "tmux.conf"), "dotfiles tmux\n", 0o644)
	writeFile(t, filepath.Join(configRoot, "outside.txt"), "outside\n", 0o644)

	// config.yaml is a dotfiles-managed symlink (stow/chezmoi) with a port
	// already set, so the copy stays byte-stable and the pin stays out.
	links := map[string]string{
		"config.yaml":        filepath.Join(dotfiles, "rk.yaml"),
		"contained":          filepath.Join("tmux.d", "user.conf"), // relative, stays in-tree
		"absolute-escape":    filepath.Join(configRoot, "outside.txt"),
		"relative-escape":    filepath.Join("..", "outside.txt"),
		"dotfiles-tmux.conf": filepath.Join(dotfiles, "tmux.conf"),
	}
	for name, target := range links {
		if err := os.Symlink(target, filepath.Join(legacyCfg, name)); err != nil {
			t.Fatalf("symlink %s: %v", name, err)
		}
	}
	before := treeSnapshot(t, legacyCfg)

	Migrate(discardLogger())

	newCfg := filepath.Join(configRoot, "hexokit")
	assertLink := func(name, wantTarget string) {
		t.Helper()
		p := filepath.Join(newCfg, name)
		fi, err := os.Lstat(p)
		if err != nil {
			t.Fatalf("%s missing from the migrated home: %v", name, err)
		}
		if fi.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("%s must be carried over as a symlink, not dereferenced into a copy", name)
		}
		target, err := os.Readlink(p)
		if err != nil {
			t.Fatalf("readlink %s: %v", name, err)
		}
		if target != wantTarget {
			t.Errorf("%s target = %q, want %q", name, target, wantTarget)
		}
		// The link must resolve to real content from the new home.
		if data, err := os.ReadFile(p); err != nil {
			t.Errorf("%s does not resolve from the new home: %v", name, err)
		} else if len(data) == 0 {
			t.Errorf("%s resolves to empty content", name)
		}
	}
	assertLink("contained", links["contained"]) // verbatim, still relative
	assertLink("absolute-escape", links["absolute-escape"])
	assertLink("relative-escape", filepath.Join(configRoot, "outside.txt")) // rewritten absolute
	assertLink("dotfiles-tmux.conf", links["dotfiles-tmux.conf"])
	// The symlinked config.yaml rides over as a link; its target already set a
	// port, so no pin was added to it.
	assertLink("config.yaml", links["config.yaml"])
	if got := readFile(t, filepath.Join(dotfiles, "rk.yaml")); got != "port: 4100\ntheme: dark\n" {
		t.Errorf("dotfiles config = %q, want unchanged (port already set)", got)
	}
	// No escaping link's content was dereferenced into a plain file.
	if _, err := os.Lstat(filepath.Join(newCfg, "outside.txt")); !os.IsNotExist(err) {
		t.Error("escaping link target must not be copied into the new home as a file")
	}
	assertTreeEqual(t, "legacy config home", before, treeSnapshot(t, legacyCfg))
}

// TestMigratePinThroughSymlinkedConfig: when the legacy config.yaml is a
// dotfiles-managed symlink with no port set, the pin is appended through the
// link into the dotfiles file — the user's one config file, shared by both
// homes after the publish — and settings.Load reads it back through the new
// home's link.
func TestMigratePinThroughSymlinkedConfig(t *testing.T) {
	configRoot, _ := isolateHomes(t)
	legacyCfg := filepath.Join(configRoot, "run-kit")
	if err := os.MkdirAll(legacyCfg, 0o755); err != nil {
		t.Fatal(err)
	}
	dotfiles := t.TempDir()
	writeFile(t, filepath.Join(dotfiles, "rk.yaml"), "theme: dark\n", 0o644)
	if err := os.Symlink(filepath.Join(dotfiles, "rk.yaml"), filepath.Join(legacyCfg, "config.yaml")); err != nil {
		t.Fatal(err)
	}

	Migrate(discardLogger())

	want := "theme: dark\n" + settings.PortPinComment + "\nport: " + itoa(portpolicy.DaemonLegacy) + "\n"
	if got := readFile(t, filepath.Join(dotfiles, "rk.yaml")); got != want {
		t.Errorf("dotfiles config = %q, want the pin appended through the link: %q", got, want)
	}
	// The staged config.yaml is a symlink, not a dereferenced copy.
	fi, err := os.Lstat(filepath.Join(configRoot, "hexokit", "config.yaml"))
	if err != nil {
		t.Fatalf("migrated config.yaml missing: %v", err)
	}
	if fi.Mode()&os.ModeSymlink == 0 {
		t.Error("migrated config.yaml must be a symlink, not a copy")
	}
	if s := settings.Load(); s.Port != portpolicy.DaemonLegacy || s.Theme != "dark" || !s.PortPinNote {
		t.Errorf("settings.Load = port %d theme %q pin %v, want %d/dark/true", s.Port, s.Theme, s.PortPinNote, portpolicy.DaemonLegacy)
	}
}

func TestMigrateSkippedUnderRKConfigDir(t *testing.T) {
	configRoot, stateRoot := isolateHomes(t)
	writeFile(t, filepath.Join(configRoot, "run-kit", "config.yaml"), "theme: dark\n", 0o644)
	writeFile(t, filepath.Join(stateRoot, "run-kit", "cron", "a.yaml"), "x\n", 0o600)
	t.Setenv(settings.ConfigDirEnv, t.TempDir())

	Migrate(discardLogger())

	for _, dir := range []string{
		filepath.Join(configRoot, "hexokit"),
		filepath.Join(stateRoot, "hexokit"),
	} {
		if _, err := os.Lstat(dir); !os.IsNotExist(err) {
			t.Errorf("RK_CONFIG_DIR run must never publish %s", dir)
		}
	}
}

// TestMigrateStateHomeGUISeeds covers R4a: the GUI's write-once seeded files
// (user-editable, edits persist) migrate byte-identical with modes preserved,
// while everything else under gui/ — the per-start regenerated icewm
// toolbar/menu, sockets, CDP profiles, any other drop-in — cold-starts.
func TestMigrateStateHomeGUISeeds(t *testing.T) {
	_, stateRoot := isolateHomes(t)
	legacyState := filepath.Join(stateRoot, "run-kit")
	seeds := gui.WriteOnceSeedFiles()
	for _, rel := range seeds {
		writeFile(t, filepath.Join(legacyState, "gui", rel), "user edit: "+rel+"\n", 0o600)
	}
	// Not copied: regenerated files, sockets, CDP profiles, anything else.
	writeFile(t, filepath.Join(legacyState, "gui", "icewm", "toolbar"), "generated\n", 0o600)
	writeFile(t, filepath.Join(legacyState, "gui", "icewm", "menu"), "generated\n", 0o600)
	writeFile(t, filepath.Join(legacyState, "gui", "icewm", "themes", "custom"), "x\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "gui", "cdp", "profile", "x"), "x\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "gui", "rfb-1.sock"), "x\n", 0o644)
	writeFile(t, filepath.Join(legacyState, "gui", "stray.txt"), "x\n", 0o644)
	before := treeSnapshot(t, legacyState)

	Migrate(discardLogger())

	newGui := filepath.Join(stateRoot, "hexokit", "gui")
	for _, rel := range seeds {
		p := filepath.Join(newGui, rel)
		if got, want := readFile(t, p), "user edit: "+rel+"\n"; got != want {
			t.Errorf("%s = %q, want byte-identical user edit %q", rel, got, want)
		}
		fi, err := os.Lstat(p)
		if err != nil {
			t.Fatalf("stat %s: %v", rel, err)
		}
		if got := fi.Mode().Perm(); got != 0o600 {
			t.Errorf("%s mode = %o, want 600", rel, got)
		}
	}
	for _, rel := range []string{
		filepath.Join("icewm", "toolbar"),
		filepath.Join("icewm", "menu"),
		filepath.Join("icewm", "themes"),
		"cdp",
		"rfb-1.sock",
		"stray.txt",
	} {
		if _, err := os.Lstat(filepath.Join(newGui, rel)); !os.IsNotExist(err) {
			t.Errorf("gui/%s must cold-start, but exists under the new state home", rel)
		}
	}
	// The new gui/ tree holds exactly the seed files — no extras.
	var gotFiles []string
	err := filepath.Walk(newGui, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			rel, err := filepath.Rel(newGui, path)
			if err != nil {
				return err
			}
			gotFiles = append(gotFiles, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", newGui, err)
	}
	if len(gotFiles) != len(seeds) {
		t.Errorf("new gui/ holds %d files %v, want exactly the %d write-once seeds", len(gotFiles), gotFiles, len(seeds))
	}
	// Seed-dir modes match the seeders' 0700 boundary.
	for _, rel := range []string{"icewm", filepath.Join("lxqt", "etc", "lxqt")} {
		fi, err := os.Lstat(filepath.Join(newGui, rel))
		if err != nil {
			t.Fatalf("stat dir %s: %v", rel, err)
		}
		if got := fi.Mode().Perm(); got != 0o700 {
			t.Errorf("dir gui/%s mode = %o, want 700", rel, got)
		}
	}
	assertTreeEqual(t, "legacy state home", before, treeSnapshot(t, legacyState))
}

// TestMigrateStateHomeGUISeedSymlink: a dotfiles-managed write-once seed
// (preferences as a symlink) is carried over as a link pointing at the same
// absolute target — never dereferenced into a copy, never dropped.
func TestMigrateStateHomeGUISeedSymlink(t *testing.T) {
	_, stateRoot := isolateHomes(t)
	legacyState := filepath.Join(stateRoot, "run-kit")
	dotfiles := t.TempDir()
	writeFile(t, filepath.Join(dotfiles, "icewm-preferences"), "dotfiles prefs\n", 0o600)
	if err := os.MkdirAll(filepath.Join(legacyState, "gui", "icewm"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dotfiles, "icewm-preferences"), filepath.Join(legacyState, "gui", "icewm", "preferences")); err != nil {
		t.Fatal(err)
	}

	Migrate(discardLogger())

	p := filepath.Join(stateRoot, "hexokit", "gui", "icewm", "preferences")
	fi, err := os.Lstat(p)
	if err != nil {
		t.Fatalf("migrated preferences missing: %v", err)
	}
	if fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("migrated preferences must be a symlink, not a dereferenced copy")
	}
	if target, _ := os.Readlink(p); target != filepath.Join(dotfiles, "icewm-preferences") {
		t.Errorf("link target = %q, want the dotfiles file", target)
	}
	if got := readFile(t, p); got != "dotfiles prefs\n" {
		t.Errorf("preferences resolves to %q, want the dotfiles content", got)
	}
}
