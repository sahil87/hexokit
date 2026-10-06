package homemigrate

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"rk/internal/settings"
)

// isolateRKMove isolates the homes, creates the new state home (as a
// successful migrateHomes would), and stubs every seam whose default would
// touch the developer's live machine (the tmux kill, the bundled VSIX, the
// VSIX install, the desktop integration). It returns the ~/.rk dir, the new
// state dir, and the recorded seam-call order.
func isolateRKMove(t *testing.T) (rkDir, newState string, calls *[]string) {
	t.Helper()
	configRoot, stateRoot := isolateHomes(t)
	home := filepath.Dir(configRoot)
	rkDir = filepath.Join(home, ".rk")
	newState = filepath.Join(stateRoot, "hexokit")
	if err := os.MkdirAll(newState, 0o755); err != nil {
		t.Fatalf("creating the new state home: %v", err)
	}

	var seq []string
	calls = &seq
	origKill, origEmbedded := killCodeServerFn, codeBridgeEmbeddedFn
	origInstall, origReintegrate := installBridgeExtensionFn, desktopReintegrateFn
	killCodeServerFn = func() (bool, error) {
		*calls = append(*calls, "kill")
		return false, nil
	}
	codeBridgeEmbeddedFn = func() ([]byte, string, bool) { return nil, "", false }
	installBridgeExtensionFn = func(context.Context, string, []byte, string, io.Writer) (bool, error) {
		*calls = append(*calls, "install")
		return false, nil
	}
	desktopReintegrateFn = func(_ context.Context, root string, _ io.Writer) {
		*calls = append(*calls, "integrate:"+filepath.Base(root))
	}
	t.Cleanup(func() {
		killCodeServerFn = origKill
		codeBridgeEmbeddedFn = origEmbedded
		installBridgeExtensionFn = origInstall
		desktopReintegrateFn = origReintegrate
	})
	return rkDir, newState, calls
}

// forceGOOS pins the platform seam for a test.
func forceGOOS(t *testing.T, goos string) {
	t.Helper()
	orig := rkHomeGOOS
	rkHomeGOOS = goos
	t.Cleanup(func() { rkHomeGOOS = orig })
}

// seedCodeServerBin creates <rkDir>/code-server-bin/<version>/bin/code-server
// (executable) plus the relative current symlink — the managed-install layout.
func seedCodeServerBin(t *testing.T, binRoot, version string, withBinary bool) {
	t.Helper()
	if withBinary {
		writeFile(t, filepath.Join(binRoot, version, "bin", "code-server"), "#!/bin/sh\n", 0o755)
	} else if err := os.MkdirAll(filepath.Join(binRoot, version), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(version, filepath.Join(binRoot, "current")); err != nil {
		t.Fatalf("symlink current: %v", err)
	}
}

func TestMoveRKTenantsMovesEveryTenant(t *testing.T) {
	rkDir, newState, calls := isolateRKMove(t)
	forceGOOS(t, "linux")
	writeFile(t, filepath.Join(rkDir, "vapid.json"), `{"priv":"x"}`, 0o600)
	writeFile(t, filepath.Join(rkDir, "push-subscriptions.json"), `[]`, 0o644)
	seedCodeServerBin(t, filepath.Join(rkDir, "code-server-bin"), "4.139.1", true)
	writeFile(t, filepath.Join(rkDir, "code-server-profile", "User", "settings.json"), "{}", 0o644)
	writeFile(t, filepath.Join(rkDir, "update.log"), "log\n", 0o644)
	writeFile(t, filepath.Join(rkDir, "restart.log"), "log\n", 0o644)
	writeFile(t, filepath.Join(rkDir, "settings.yaml.migrated"), "x", 0o644)
	writeFile(t, filepath.Join(rkDir, "tmux.d.migrated", "a.conf"), "x", 0o644)

	MoveRKTenants(discardLogger())

	fi, err := os.Lstat(filepath.Join(newState, "vapid.json"))
	if err != nil {
		t.Fatalf("vapid.json missing at the state home: %v", err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Errorf("vapid.json mode = %o, want 600", got)
	}
	if got := readFile(t, filepath.Join(newState, "push-subscriptions.json")); got != `[]` {
		t.Errorf("push-subscriptions.json = %q", got)
	}
	current := filepath.Join(newState, "code-server", "bin", "current")
	if target, err := os.Readlink(current); err != nil || target != "4.139.1" {
		t.Errorf("current target = %q, %v — want the verbatim relative link", target, err)
	}
	if _, err := os.Stat(filepath.Join(current, "bin", "code-server")); err != nil {
		t.Errorf("current does not resolve to the moved binary: %v", err)
	}
	if got := readFile(t, filepath.Join(newState, "code-server", "profile", "User", "settings.json")); got != "{}" {
		t.Errorf("profile settings.json = %q", got)
	}
	for _, name := range []string{"update.log", "restart.log"} {
		if got := readFile(t, filepath.Join(newState, "logs", name)); got != "log\n" {
			t.Errorf("logs/%s = %q", name, got)
		}
	}
	for _, crumb := range []string{"settings.yaml.migrated", "tmux.d.migrated"} {
		if exists(filepath.Join(rkDir, crumb)) {
			t.Errorf("breadcrumb %s must be deleted", crumb)
		}
	}
	if exists(rkDir) {
		entries, _ := os.ReadDir(rkDir)
		t.Errorf("~/.rk must be removed when empty; remaining: %v", entries)
	}
	if got := *calls; len(got) != 1 || got[0] != "kill" {
		t.Errorf("seam calls = %v, want [kill] (no VSIX embedded, nothing to install; no desktop dir)", got)
	}
}

func TestMoveRKTenantsPre260813Profile(t *testing.T) {
	rkDir, newState, calls := isolateRKMove(t)
	writeFile(t, filepath.Join(rkDir, "code-server", "User", "settings.json"), "{}", 0o644)

	MoveRKTenants(discardLogger())

	if got := readFile(t, filepath.Join(newState, "code-server", "profile", "User", "settings.json")); got != "{}" {
		t.Errorf("pre-260813 profile settings.json = %q, want moved to code-server/profile", got)
	}
	if exists(filepath.Join(rkDir, "code-server")) {
		t.Error("~/.rk/code-server must be gone after the move")
	}
	if exists(rkDir) {
		t.Error("~/.rk must be removed when empty")
	}
	if got := *calls; len(got) != 1 || got[0] != "kill" {
		t.Errorf("seam calls = %v, want [kill]", got)
	}
}

// TestMoveRKTenantsNewerProfileWins: with both profile sources present, the
// pre-260813 ~/.rk/code-server/ stays put (the newer profile owns the
// destination) and ~/.rk gets a MOVED.md.
func TestMoveRKTenantsNewerProfileWins(t *testing.T) {
	rkDir, newState, _ := isolateRKMove(t)
	writeFile(t, filepath.Join(rkDir, "code-server-profile", "User", "settings.json"), `{"new":1}`, 0o644)
	writeFile(t, filepath.Join(rkDir, "code-server", "User", "settings.json"), `{"old":1}`, 0o644)

	MoveRKTenants(discardLogger())

	if got := readFile(t, filepath.Join(newState, "code-server", "profile", "User", "settings.json")); got != `{"new":1}` {
		t.Errorf("profile = %q, want the code-server-profile content", got)
	}
	if got := readFile(t, filepath.Join(rkDir, "code-server", "User", "settings.json")); got != `{"old":1}` {
		t.Errorf("~/.rk/code-server must be left in place untouched, got %q", got)
	}
	if !exists(filepath.Join(rkDir, "MOVED.md")) {
		t.Error("MOVED.md must be written for the remaining files")
	}
}

func TestMoveRKTenantsNeverOverwritesDestination(t *testing.T) {
	rkDir, newState, _ := isolateRKMove(t)
	writeFile(t, filepath.Join(rkDir, "vapid.json"), "old", 0o600)
	writeFile(t, filepath.Join(newState, "vapid.json"), "new", 0o600)

	var log bytes.Buffer
	MoveRKTenants(slog.New(slog.NewTextHandler(&log, nil)))

	if got := readFile(t, filepath.Join(newState, "vapid.json")); got != "new" {
		t.Errorf("destination vapid.json = %q, want unchanged", got)
	}
	if got := readFile(t, filepath.Join(rkDir, "vapid.json")); got != "old" {
		t.Errorf("source vapid.json = %q, want left in place", got)
	}
	if !strings.Contains(log.String(), "never overwrite") {
		t.Errorf("expected a conflict warning, got log %q", log.String())
	}
	if !exists(filepath.Join(rkDir, "MOVED.md")) {
		t.Error("MOVED.md must be written while ~/.rk is non-empty")
	}
}

// TestMoveRKTenantsEXDEVFallback drives the cross-device path through the
// rename seam: the tree is copied (modes preserved, symlinks verbatim),
// verified, and the source removed.
func TestMoveRKTenantsEXDEVFallback(t *testing.T) {
	rkDir, newState, _ := isolateRKMove(t)
	writeFile(t, filepath.Join(rkDir, "vapid.json"), `{"priv":"x"}`, 0o600)
	binRoot := filepath.Join(rkDir, "code-server-bin")
	writeFile(t, filepath.Join(binRoot, "4.139.1", "bin", "code-server"), "#!/bin/sh\n", 0o755)
	writeFile(t, filepath.Join(binRoot, "4.139.1", "data.txt"), "data\n", 0o640)
	if err := os.MkdirAll(filepath.Join(binRoot, "4.139.1", "private"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("4.139.1", filepath.Join(binRoot, "current")); err != nil {
		t.Fatal(err)
	}

	origRename := renameFn
	renameFn = func(oldpath, newpath string) error {
		return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: syscall.EXDEV}
	}
	t.Cleanup(func() { renameFn = origRename })

	MoveRKTenants(discardLogger())

	fi, err := os.Lstat(filepath.Join(newState, "vapid.json"))
	if err != nil {
		t.Fatalf("vapid.json missing after the EXDEV copy: %v", err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Errorf("vapid.json mode = %o, want 600 through the copy", got)
	}
	newBin := filepath.Join(newState, "code-server", "bin")
	for rel, want := range map[string]os.FileMode{
		filepath.Join("4.139.1", "bin", "code-server"): 0o755,
		filepath.Join("4.139.1", "data.txt"):           0o640,
		filepath.Join("4.139.1", "private"):            0o700,
	} {
		fi, err := os.Lstat(filepath.Join(newBin, rel))
		if err != nil {
			t.Fatalf("stat %s: %v", rel, err)
		}
		if got := fi.Mode().Perm(); got != want {
			t.Errorf("%s mode = %o, want %o", rel, got, want)
		}
	}
	if target, err := os.Readlink(filepath.Join(newBin, "current")); err != nil || target != "4.139.1" {
		t.Errorf("current target = %q, %v — want the verbatim relative link", target, err)
	}
	if _, err := os.Stat(filepath.Join(newBin, "current", "bin", "code-server")); err != nil {
		t.Errorf("current does not resolve after the copy: %v", err)
	}
	if exists(rkDir) {
		entries, _ := os.ReadDir(rkDir)
		t.Errorf("sources must be removed after a verified copy; remaining: %v", entries)
	}
}

// TestMoveRKTenantsSkipsWhenStateHomeMissing: with the new state home absent
// and a legacy run-kit state home still standing, the state-home migration
// owns the publish — the move defers to it and skips.
func TestMoveRKTenantsSkipsWhenStateHomeMissing(t *testing.T) {
	rkDir, newState, calls := isolateRKMove(t)
	if err := os.RemoveAll(newState); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(filepath.Dir(newState), "run-kit"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(rkDir, "vapid.json"), "x", 0o600)

	var log bytes.Buffer
	MoveRKTenants(slog.New(slog.NewTextHandler(&log, nil)))

	if got := readFile(t, filepath.Join(rkDir, "vapid.json")); got != "x" {
		t.Errorf("source vapid.json = %q, want untouched", got)
	}
	if !strings.Contains(log.String(), "state home does not exist") {
		t.Errorf("expected a missing-state-home warning, got log %q", log.String())
	}
	if exists(filepath.Join(rkDir, "MOVED.md")) {
		t.Error("a skipped step must not write MOVED.md")
	}
	if len(*calls) != 0 {
		t.Errorf("seam calls = %v, want none", *calls)
	}
}

// TestMoveRKTenantsCreatesStateHomeWithoutLegacy: with neither state home
// present there is no migration to defer to — the move creates the new home
// itself, or the consumers would seed fresh state and strand the tenants.
func TestMoveRKTenantsCreatesStateHomeWithoutLegacy(t *testing.T) {
	rkDir, newState, calls := isolateRKMove(t)
	if err := os.RemoveAll(newState); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(rkDir, "vapid.json"), `{"priv":"x"}`, 0o600)

	MoveRKTenants(discardLogger())

	fi, err := os.Lstat(filepath.Join(newState, "vapid.json"))
	if err != nil {
		t.Fatalf("vapid.json missing at the created state home: %v", err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Errorf("vapid.json mode = %o, want 600", got)
	}
	if exists(rkDir) {
		t.Error("~/.rk must be removed when empty after the move")
	}
	if len(*calls) != 0 {
		t.Errorf("seam calls = %v, want none (no code-server tenants)", *calls)
	}
}

func TestMoveRKTenantsSkipsUnderRKConfigDir(t *testing.T) {
	rkDir, newState, calls := isolateRKMove(t)
	t.Setenv(settings.ConfigDirEnv, t.TempDir())
	writeFile(t, filepath.Join(rkDir, "vapid.json"), "x", 0o600)

	MoveRKTenants(discardLogger())

	if got := readFile(t, filepath.Join(rkDir, "vapid.json")); got != "x" {
		t.Errorf("source vapid.json = %q, want untouched", got)
	}
	if exists(filepath.Join(newState, "vapid.json")) {
		t.Error("an RK_CONFIG_DIR run must never move tenants")
	}
	if len(*calls) != 0 {
		t.Errorf("seam calls = %v, want none", *calls)
	}
}

func TestMoveRKTenantsNoopWithoutRKDir(t *testing.T) {
	_, newState, calls := isolateRKMove(t)

	MoveRKTenants(discardLogger())

	if len(*calls) != 0 {
		t.Errorf("seam calls = %v, want none", *calls)
	}
	entries, err := os.ReadDir(newState)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("the state home must stay untouched, got %v", entries)
	}
}

// TestMoveRKTenantsWritesMOVEDmd: user-owned leftovers keep ~/.rk alive and
// get the note; an identical note is not rewritten on the next boot.
func TestMoveRKTenantsWritesMOVEDmd(t *testing.T) {
	rkDir, newState, _ := isolateRKMove(t)
	writeFile(t, filepath.Join(rkDir, "tmux.conf"), "set -g mouse on\n", 0o644)
	writeFile(t, filepath.Join(rkDir, "vapid.json"), "x", 0o600)

	MoveRKTenants(discardLogger())

	if got := readFile(t, filepath.Join(rkDir, "tmux.conf")); got != "set -g mouse on\n" {
		t.Errorf("hand-edited tmux.conf = %q, want untouched", got)
	}
	note := readFile(t, filepath.Join(rkDir, "MOVED.md"))
	for _, want := range []string{
		"~/.config/hexokit/", newState,
		"vapid.json", "code-server/bin/", "code-server/profile/", "logs/", "desktop/",
		"port:", "3000", "6123", "hosts.json", "localStorage", "tailscale", "bookmarks",
		"safe to delete",
	} {
		if !strings.Contains(note, want) {
			t.Errorf("MOVED.md does not mention %q:\n%s", want, note)
		}
	}

	// A second boot with the identical note must not rewrite it.
	movedPath := filepath.Join(rkDir, "MOVED.md")
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(movedPath, old, old); err != nil {
		t.Fatal(err)
	}
	MoveRKTenants(discardLogger())
	fi, err := os.Stat(movedPath)
	if err != nil {
		t.Fatal(err)
	}
	if !fi.ModTime().Equal(old) {
		t.Errorf("MOVED.md was rewritten although identical (mtime %v, want %v)", fi.ModTime(), old)
	}
}

// TestMoveRKTenantsKillMoveInstallOrdering: the session is killed before the
// code-server tenants move, and the bundled-VSIX install runs after, against
// the managed binary at its new path.
func TestMoveRKTenantsKillMoveInstallOrdering(t *testing.T) {
	rkDir, newState, calls := isolateRKMove(t)
	forceGOOS(t, "darwin") // keep the desktop leg out of this ordering check
	seedCodeServerBin(t, filepath.Join(rkDir, "code-server-bin"), "4.139.1", true)
	writeFile(t, filepath.Join(rkDir, "code-server-profile", "User", "settings.json"), "{}", 0o644)

	killCodeServerFn = func() (bool, error) {
		if !exists(filepath.Join(rkDir, "code-server-bin")) {
			t.Error("kill ran after code-server-bin moved — want kill before the move")
		}
		*calls = append(*calls, "kill")
		return true, nil
	}
	codeBridgeEmbeddedFn = func() ([]byte, string, bool) { return []byte("vsix"), "1.2.3", true }
	installBridgeExtensionFn = func(_ context.Context, _ string, vsix []byte, version string, _ io.Writer) (bool, error) {
		if exists(filepath.Join(rkDir, "code-server-bin")) {
			t.Error("install ran before code-server-bin moved")
		}
		if !exists(filepath.Join(newState, "code-server", "bin", "current", "bin", "code-server")) {
			t.Error("install ran without a managed binary at the new path")
		}
		if string(vsix) != "vsix" || version != "1.2.3" {
			t.Errorf("install got vsix %q version %q", vsix, version)
		}
		*calls = append(*calls, "install")
		return true, nil
	}

	MoveRKTenants(discardLogger())

	if got := *calls; len(got) != 2 || got[0] != "kill" || got[1] != "install" {
		t.Errorf("seam calls = %v, want [kill install]", got)
	}
}

// TestMoveRKTenantsKeepsCodeServerWhenKillFails: a session that cannot be
// stopped keeps its install and profile in ~/.rk (a live profile moved out from
// under code-server would split its writes); the other tenants still move, and
// a failed VSIX install never stops the step.
func TestMoveRKTenantsKeepsCodeServerWhenKillFails(t *testing.T) {
	rkDir, newState, _ := isolateRKMove(t)
	forceGOOS(t, "darwin")
	seedCodeServerBin(t, filepath.Join(rkDir, "code-server-bin"), "4.139.1", true)
	writeFile(t, filepath.Join(rkDir, "code-server-profile", "User", "settings.json"), "{}", 0o644)
	writeFile(t, filepath.Join(rkDir, "vapid.json"), "x", 0o600)
	killCodeServerFn = func() (bool, error) { return false, errors.New("tmux wedged") }
	codeBridgeEmbeddedFn = func() ([]byte, string, bool) { return []byte("vsix"), "1.2.3", true }
	installBridgeExtensionFn = func(context.Context, string, []byte, string, io.Writer) (bool, error) {
		return false, errors.New("install failed")
	}

	MoveRKTenants(discardLogger())

	for _, name := range []string{"code-server-bin", "code-server-profile"} {
		if !exists(filepath.Join(rkDir, name)) {
			t.Errorf("~/.rk/%s moved although the code-server session could not be stopped", name)
		}
	}
	if exists(filepath.Join(newState, "code-server")) {
		t.Error("<state>/code-server created although the code-server session could not be stopped")
	}
	if !exists(filepath.Join(newState, "vapid.json")) {
		t.Error("vapid.json must still move when the code-server kill fails")
	}
	if !exists(filepath.Join(rkDir, "MOVED.md")) {
		t.Error("MOVED.md must be written when code-server tenants stay behind")
	}
}

func TestMoveRKTenantsSkipsKillAndInstallWithoutCodeServer(t *testing.T) {
	rkDir, _, calls := isolateRKMove(t)
	writeFile(t, filepath.Join(rkDir, "vapid.json"), "x", 0o600)

	MoveRKTenants(discardLogger())

	if len(*calls) != 0 {
		t.Errorf("seam calls = %v, want none (no code-server tenants, no managed binary)", *calls)
	}
	if exists(rkDir) {
		t.Error("~/.rk must be removed when empty")
	}
}

// TestMoveRKTenantsPrunesBothRoots: the one-shot prune keeps current + the
// highest version below it on both managed-install roots.
func TestMoveRKTenantsPrunesBothRoots(t *testing.T) {
	rkDir, newState, calls := isolateRKMove(t)
	forceGOOS(t, "linux")
	binRoot := filepath.Join(rkDir, "code-server-bin")
	for _, v := range []string{"4.134.0", "4.135.0", "4.136.0", "4.139.1"} {
		if err := os.MkdirAll(filepath.Join(binRoot, v), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("4.139.1", filepath.Join(binRoot, "current")); err != nil {
		t.Fatal(err)
	}
	deskRoot := filepath.Join(rkDir, "desktop")
	for _, v := range []string{"1.1.0", "1.2.0", "1.3.0"} {
		if err := os.MkdirAll(filepath.Join(deskRoot, v), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("1.3.0", filepath.Join(deskRoot, "current")); err != nil {
		t.Fatal(err)
	}

	MoveRKTenants(discardLogger())

	newBin := filepath.Join(newState, "code-server", "bin")
	for _, v := range []string{"4.139.1", "4.136.0"} {
		if !isDir(filepath.Join(newBin, v)) {
			t.Errorf("code-server/bin/%s must be kept", v)
		}
	}
	for _, v := range []string{"4.134.0", "4.135.0"} {
		if exists(filepath.Join(newBin, v)) {
			t.Errorf("code-server/bin/%s must be pruned", v)
		}
	}
	newDesk := filepath.Join(newState, "desktop")
	for _, v := range []string{"1.3.0", "1.2.0"} {
		if !isDir(filepath.Join(newDesk, v)) {
			t.Errorf("desktop/%s must be kept", v)
		}
	}
	if exists(filepath.Join(newDesk, "1.1.0")) {
		t.Error("desktop/1.1.0 must be pruned")
	}
	if got := *calls; len(got) != 2 || got[0] != "kill" || got[1] != "integrate:desktop" {
		t.Errorf("seam calls = %v, want [kill integrate:desktop] (no managed binary, so no install)", got)
	}
}

// TestMoveRKTenantsLeavesDesktopOnDarwin: the desktop tenant is Linux-only;
// on darwin it stays in ~/.rk and the note covers it.
func TestMoveRKTenantsLeavesDesktopOnDarwin(t *testing.T) {
	rkDir, newState, calls := isolateRKMove(t)
	forceGOOS(t, "darwin")
	writeFile(t, filepath.Join(rkDir, "desktop", "1.2.3", "AppRun"), "#!/bin/sh\n", 0o755)
	writeFile(t, filepath.Join(rkDir, "vapid.json"), "x", 0o600)

	MoveRKTenants(discardLogger())

	if !exists(filepath.Join(rkDir, "desktop", "1.2.3", "AppRun")) {
		t.Error("~/.rk/desktop must stay in place on darwin")
	}
	if exists(filepath.Join(newState, "desktop")) {
		t.Error("the state-home desktop root must not appear on darwin")
	}
	if !exists(filepath.Join(rkDir, "MOVED.md")) {
		t.Error("MOVED.md must be written for the remaining desktop tree")
	}
	for _, c := range *calls {
		if strings.HasPrefix(c, "integrate:") {
			t.Errorf("no desktop reintegration on darwin, got calls %v", *calls)
		}
	}
}
