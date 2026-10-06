package desktop

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"
)

// linuxTreeOpts shapes the fake extracted AppImage tree a test wants — the
// zero value is the complete, valid tree (the v3.20.8 layout).
type linuxTreeOpts struct {
	version       string // X-AppImage-Version in the .desktop entry
	noAsar        bool
	noDesktop     bool
	noAppRun      bool
	badAppRun     bool // AppRun with a missing interpreter — the relaunch fails
	nonExecAppRun bool // AppRun present but not executable
	nonExecELF    bool
	escapeLink    bool // an absolute symlink pointing outside the tree
	iconSizeDir   string
}

// writeLinuxTree writes the squashfs-root fixture into dir — the job the real
// `--appimage-extract` performs. AppRun is a real shell script so the
// detached relaunch (startDetached) genuinely starts on any test host.
func writeLinuxTree(t *testing.T, dir string, o linuxTreeOpts) {
	t.Helper()
	if o.iconSizeDir == "" {
		o.iconSizeDir = "1024x1024"
	}
	mk := func(rel, content string, perm os.FileMode) {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), perm); err != nil {
			t.Fatal(err)
		}
	}
	if !o.noAppRun {
		appRun := "#!/bin/sh\nexit 0\n"
		if o.badAppRun {
			appRun = "#!/nonexistent/rk-sh\nexit 0\n"
		}
		appRunPerm := os.FileMode(0o755)
		if o.nonExecAppRun {
			appRunPerm = 0o644
		}
		mk("AppRun", appRun, appRunPerm)
	}
	elfPerm := os.FileMode(0o755)
	if o.nonExecELF {
		elfPerm = 0o644
	}
	mk("hexokit-desktop", "fake-elf", elfPerm)
	if !o.noAsar {
		mk(filepath.Join("resources", "app.asar"), "fake-asar", 0o644)
	}
	if !o.noDesktop {
		mk("hexokit-desktop.desktop",
			"[Desktop Entry]\nName=HexoKit\nExec=AppRun --no-sandbox %U\nX-AppImage-Version="+o.version+"\n", 0o644)
	}
	iconRel := filepath.Join("usr", "share", "icons", "hicolor", o.iconSizeDir, "apps", "hexokit-desktop.png")
	mk(iconRel, "fake-png", 0o644)
	// The shipped .DirIcon symlink — inside the tree, must pass containment.
	if err := os.Symlink(iconRel, filepath.Join(dir, ".DirIcon")); err != nil {
		t.Fatal(err)
	}
	if o.escapeLink {
		if err := os.Symlink("/etc/passwd", filepath.Join(dir, "escape")); err != nil {
			t.Fatal(err)
		}
	}
}

// linuxRig records the seams of a linux install: the fake extractor
// (RunInDir), the pgrep/update-desktop-database runner (Run), and the signal
// delivery (Signal).
type linuxRig struct {
	t *testing.T
	// running controls the pgrep probe; quitFlipsRunning makes the SIGTERM
	// seam simulate the app actually exiting.
	running          bool
	quitFlipsRunning bool
	oldestPID        string
	tree             linuxTreeOpts
	extractCalls     int
	pgrepArgs        [][]string
	desktopDBCalls   int
	signals          [][2]any // {pid, sig}
}

func (r *linuxRig) runner(_ context.Context, name string, args ...string) ([]byte, error) {
	switch name {
	case "pgrep":
		r.pgrepArgs = append(r.pgrepArgs, args)
		if r.running {
			return []byte(r.oldestPID + "\n"), nil
		}
		return nil, errors.New("exit status 1")
	case "update-desktop-database":
		r.desktopDBCalls++
		return nil, nil
	}
	r.t.Fatalf("unexpected subprocess: %s %v", name, args)
	return nil, nil
}

func (r *linuxRig) dirRunner(_ context.Context, dir, name string, args ...string) ([]byte, error) {
	r.extractCalls++
	if len(args) != 1 || args[0] != "--appimage-extract" {
		r.t.Fatalf("extractor args = %v, want [--appimage-extract]", args)
	}
	if !strings.HasSuffix(name, ".AppImage") {
		r.t.Fatalf("extractor name = %q, want the AppImage path", name)
	}
	// The AppImage runtime writes ./squashfs-root into the CWD.
	writeLinuxTree(r.t, filepath.Join(dir, "squashfs-root"), r.tree)
	return nil, nil
}

func (r *linuxRig) signal(pid int, sig syscall.Signal) error {
	r.signals = append(r.signals, [2]any{pid, sig})
	if r.quitFlipsRunning {
		r.running = false
	}
	return nil
}

// linuxInstaller builds a linux-pinned Installer: temp root and home, the
// rig's seams. Pair it with the shared assetServer/fakeDMGDigest helpers for
// the download step.
func linuxInstaller(t *testing.T, rig *linuxRig) (ins *Installer, root, home string) {
	t.Helper()
	home = t.TempDir()
	root = filepath.Join(home, ".rk", "desktop")
	ins = New()
	ins.GOOS = "linux"
	ins.Arch = "amd64"
	ins.Token = ""
	ins.InstallDir = root
	ins.UserHome = func() (string, error) { return home, nil }
	ins.Run = rig.runner
	ins.RunInDir = rig.dirRunner
	ins.Signal = rig.signal
	ins.QuitWait = 300 * time.Millisecond
	ins.QuitPoll = 5 * time.Millisecond
	return ins, root, home
}

// linuxRelease builds the Release the flow consumes (asset bytes come from
// the shared assetServer, the digest from fakeDMGDigest).
func linuxRelease(srv *httptest.Server, version, digest string) Release {
	return Release{
		Version:   version,
		AssetName: fmt.Sprintf("hexokit-desktop-%s-x86_64.AppImage", version),
		AssetURL:  srv.URL + "/dl/app",
		Digest:    digest,
	}
}

func TestInstallLinuxHappyPath(t *testing.T) {
	rig := &linuxRig{t: t, oldestPID: "4242", tree: linuxTreeOpts{version: "3.21.0"}}
	ins, root, home := linuxInstaller(t, rig)
	srv := assetServer(t)
	digest := fakeDMGDigest()

	res, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", digest))
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if res.Version != "3.21.0" || res.Restarted {
		t.Errorf("result = %+v, want version 3.21.0, not restarted", res)
	}
	if res.Path != linuxVersionDir(root, "3.21.0") {
		t.Errorf("result path = %q, want %q", res.Path, linuxVersionDir(root, "3.21.0"))
	}

	// Layout: the version dir holds the tree, current points at it, the
	// staging dir and the AppImage file are gone.
	for _, rel := range []string{"AppRun", "hexokit-desktop", filepath.Join("resources", "app.asar"), "hexokit-desktop.desktop"} {
		if _, err := os.Stat(filepath.Join(root, "3.21.0", rel)); err != nil {
			t.Errorf("installed tree missing %s: %v", rel, err)
		}
	}
	target, err := os.Readlink(linuxCurrentPath(root))
	if err != nil || target != "3.21.0" {
		t.Errorf("current -> %q (%v), want 3.21.0", target, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), linuxStagingPrefix) || strings.HasSuffix(e.Name(), ".AppImage") {
			t.Errorf("root holds leftover %q after install", e.Name())
		}
	}

	// Integration: launcher entry (exact keys, quoted Exec), icon, bin symlink.
	entry, err := os.ReadFile(filepath.Join(home, ".local", "share", "applications", "hexokit-desktop.desktop"))
	if err != nil {
		t.Fatalf("launcher entry: %v", err)
	}
	for _, want := range []string{
		"Name=HexoKit\n",
		"Exec=\"" + filepath.Join(root, "current", "AppRun") + "\" %U\n",
		"Terminal=false\n",
		"Type=Application\n",
		"Icon=hexokit-desktop\n",
		"StartupWMClass=HexoKit\n",
		"Categories=Development;\n",
	} {
		if !strings.Contains(string(entry), want) {
			t.Errorf("launcher entry missing %q:\n%s", want, entry)
		}
	}
	icon := filepath.Join(home, ".local", "share", "icons", "hicolor", "1024x1024", "apps", "hexokit-desktop.png")
	if data, err := os.ReadFile(icon); err != nil || string(data) != "fake-png" {
		t.Errorf("icon at %s = %v, want the bundled copy", icon, err)
	}
	link := filepath.Join(home, ".local", "bin", "hexokit-desktop")
	if target, err := os.Readlink(link); err != nil || target != filepath.Join(root, "current", "AppRun") {
		t.Errorf("bin symlink -> %q (%v), want %s", target, err, filepath.Join(root, "current", "AppRun"))
	}
	if rig.extractCalls != 1 {
		t.Errorf("extractor ran %d times, want 1", rig.extractCalls)
	}
}

func TestInstallLinuxMissingDigestRefuses(t *testing.T) {
	rig := &linuxRig{t: t, tree: linuxTreeOpts{version: "3.21.0"}}
	ins, root, _ := linuxInstaller(t, rig)
	srv := assetServer(t)

	_, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", ""))
	if err == nil || !strings.Contains(err.Error(), "supplied no sha256 digest") || !strings.Contains(err.Error(), "refusing to install an unverified binary") {
		t.Fatalf("error = %v, want the missing-digest refusal", err)
	}
	if rig.extractCalls != 0 {
		t.Errorf("extractor ran %d times despite the digest refusal", rig.extractCalls)
	}
	if _, statErr := os.Stat(root); !os.IsNotExist(statErr) {
		t.Errorf("install root %s exists after the refusal", root)
	}
}

func TestInstallLinuxDigestMismatchDiscards(t *testing.T) {
	rig := &linuxRig{t: t, tree: linuxTreeOpts{version: "3.21.0"}}
	ins, root, _ := linuxInstaller(t, rig)
	srv := assetServer(t)

	_, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", "deadbeef"))
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("error = %v, want a checksum mismatch", err)
	}
	if rig.extractCalls != 0 {
		t.Errorf("extractor ran despite the digest mismatch")
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), linuxStagingPrefix) {
			t.Errorf("staging dir %q left behind after the mismatch", e.Name())
		}
	}
}

func TestInstallLinuxInvalidTreeRefused(t *testing.T) {
	cases := []struct {
		name string
		tree linuxTreeOpts
		want string
	}{
		{"missing asar", linuxTreeOpts{version: "3.21.0", noAsar: true}, "missing " + filepath.Join("resources", "app.asar")},
		{"missing desktop entry", linuxTreeOpts{version: "3.21.0", noDesktop: true}, "missing hexokit-desktop.desktop"},
		{"missing AppRun", linuxTreeOpts{version: "3.21.0", noAppRun: true}, "missing AppRun"},
		{"non-executable ELF", linuxTreeOpts{version: "3.21.0", nonExecELF: true}, "non-executable hexokit-desktop"},
		{"non-executable AppRun", linuxTreeOpts{version: "3.21.0", nonExecAppRun: true}, "non-executable AppRun"},
		{"version mismatch", linuxTreeOpts{version: "3.20.7"}, `mounted AppImage reports version "3.20.7", expected "3.21.0"`},
		{"escaping symlink", linuxTreeOpts{version: "3.21.0", escapeLink: true}, "refusing symlink escaping the install dir"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rig := &linuxRig{t: t, tree: tc.tree}
			ins, root, _ := linuxInstaller(t, rig)
			srv := assetServer(t)
			digest := fakeDMGDigest()

			_, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", digest))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want it to contain %q", err, tc.want)
			}
			// The install target is untouched: no version dir, no current, no
			// staging leftovers.
			entries, readErr := os.ReadDir(root)
			if readErr != nil {
				return // root never created is also untouched
			}
			for _, e := range entries {
				t.Errorf("root holds %q after the refusal", e.Name())
			}
		})
	}
}

func TestInstallLinuxRunningAppRestarts(t *testing.T) {
	rig := &linuxRig{t: t, running: true, quitFlipsRunning: true, oldestPID: "4242", tree: linuxTreeOpts{version: "3.21.0"}}
	ins, root, _ := linuxInstaller(t, rig)
	srv := assetServer(t)
	digest := fakeDMGDigest()

	// The app is running from the OLD version dir.
	old := linuxVersionDir(root, "3.20.9")
	if err := os.MkdirAll(old, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("3.20.9", linuxCurrentPath(root)); err != nil {
		t.Fatal(err)
	}

	res, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", digest))
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !res.Restarted {
		t.Error("Restarted = false, want true (quit → swap → relaunch completed)")
	}

	// SIGTERM went to the oldest matching PID through the signal seam.
	if len(rig.signals) != 1 || rig.signals[0][0] != 4242 || rig.signals[0][1] != syscall.SIGTERM {
		t.Errorf("signals = %v, want one SIGTERM to pid 4242", rig.signals)
	}
	// pgrep probed the OLD version dir's ELF path (pre-flip current target).
	oldPattern := regexp.QuoteMeta(filepath.Join(old, "hexokit-desktop"))
	if len(rig.pgrepArgs) == 0 || rig.pgrepArgs[0][len(rig.pgrepArgs[0])-1] != oldPattern {
		t.Errorf("pgrep args = %v, want probes against %s", rig.pgrepArgs, oldPattern)
	}
	// The quit probe used pgrep -o (oldest first).
	foundOldestProbe := false
	for _, args := range rig.pgrepArgs {
		if len(args) == 3 && args[0] == "-o" {
			foundOldestProbe = true
		}
	}
	if !foundOldestProbe {
		t.Errorf("pgrep calls = %v, want a pgrep -o -f probe for the quit target", rig.pgrepArgs)
	}
	// The pre-flip target survives as the rollback version; current points at
	// the new one.
	if _, err := os.Stat(old); err != nil {
		t.Errorf("old version dir pruned after the flip — it is the kept rollback: %v", err)
	}
	if target, _ := os.Readlink(linuxCurrentPath(root)); target != "3.21.0" {
		t.Errorf("current -> %q, want 3.21.0", target)
	}
}

func TestInstallLinuxQuitTimeoutAbortsBeforeSwap(t *testing.T) {
	// The app never exits: the signal seam records but does not flip the probe.
	rig := &linuxRig{t: t, running: true, quitFlipsRunning: false, oldestPID: "4242", tree: linuxTreeOpts{version: "3.21.0"}}
	ins, root, _ := linuxInstaller(t, rig)
	srv := assetServer(t)
	digest := fakeDMGDigest()

	old := linuxVersionDir(root, "3.20.9")
	if err := os.MkdirAll(old, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("3.20.9", linuxCurrentPath(root)); err != nil {
		t.Fatal(err)
	}

	_, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", digest))
	if err == nil || !strings.Contains(err.Error(), "did not exit within") {
		t.Fatalf("error = %v, want the quit-timeout abort", err)
	}
	if target, _ := os.Readlink(linuxCurrentPath(root)); target != "3.20.9" {
		t.Errorf("current -> %q after the abort, want 3.20.9 untouched", target)
	}
	if _, statErr := os.Stat(linuxVersionDir(root, "3.21.0")); !os.IsNotExist(statErr) {
		t.Error("new version dir exists after the abort — the swap must not have happened")
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), linuxStagingPrefix) {
			t.Errorf("staging dir %q left behind after the abort", e.Name())
		}
	}
}

func TestInstallLinuxPruneKeepsCurrentAndPrevious(t *testing.T) {
	rig := &linuxRig{t: t, tree: linuxTreeOpts{version: "3.21.0"}}
	ins, root, _ := linuxInstaller(t, rig)
	srv := assetServer(t)
	digest := fakeDMGDigest()

	for _, v := range []string{"3.20.8", "3.20.9"} {
		if err := os.MkdirAll(linuxVersionDir(root, v), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("3.20.9", linuxCurrentPath(root)); err != nil {
		t.Fatal(err)
	}
	// A staging leftover from an interrupted run must survive the prune (it is
	// reclaimed by name, not treated as a version).
	if err := os.MkdirAll(filepath.Join(root, linuxStagingPrefix+"stale"), 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", digest)); err != nil {
		t.Fatalf("Install: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, e := range entries {
		got[e.Name()] = true
	}
	if got["3.20.8"] {
		t.Errorf("superseded version dir survived the flip: %v", got)
	}
	if !got["3.20.9"] || !got["3.21.0"] || !got["current"] || !got[linuxStagingPrefix+"stale"] {
		t.Errorf("root after install = %v, want current 3.21.0 + previous 3.20.9 (+ staging leftover)", got)
	}
}

func TestInstallLinuxRelaunchFailureNonFatal(t *testing.T) {
	// AppRun with a missing interpreter: validation passes (a regular
	// executable file), but the detached start fails — non-fatal, Restarted
	// stays false, the swap stands.
	rig := &linuxRig{t: t, running: true, quitFlipsRunning: true, oldestPID: "4242", tree: linuxTreeOpts{version: "3.21.0", badAppRun: true}}
	ins, root, _ := linuxInstaller(t, rig)
	srv := assetServer(t)
	digest := fakeDMGDigest()

	old := linuxVersionDir(root, "3.20.9")
	if err := os.MkdirAll(old, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("3.20.9", linuxCurrentPath(root)); err != nil {
		t.Fatal(err)
	}

	res, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", digest))
	if err != nil {
		t.Fatalf("Install must not fail on a relaunch error (the swap succeeded): %v", err)
	}
	if res.Restarted {
		t.Error("Restarted = true despite the failed relaunch")
	}
	if target, _ := os.Readlink(linuxCurrentPath(root)); target != "3.21.0" {
		t.Errorf("current -> %q, want 3.21.0 (the swap stands)", target)
	}
}

func TestStartDetachedBadPath(t *testing.T) {
	if err := startDetached([]string{filepath.Join(t.TempDir(), "does-not-exist")}); err == nil {
		t.Error("startDetached of a missing binary returned nil error")
	}
	// A successful start returns nil and the child is reaped asynchronously.
	if err := startDetached([]string{"/bin/sh", "-c", "exit 0"}); err != nil {
		t.Errorf("startDetached /bin/sh: %v", err)
	}
}

func TestInstalledVersionLinux(t *testing.T) {
	ins := New()
	ins.GOOS = "linux"
	ins.InstallDir = t.TempDir()

	v, err := ins.InstalledVersion(context.Background())
	if err != nil || v != "" {
		t.Errorf("InstalledVersion = %q, %v — want empty, nil (nothing installed)", v, err)
	}
	if err := os.Symlink("3.20.8", linuxCurrentPath(ins.InstallDir)); err != nil {
		t.Fatal(err)
	}
	v, err = ins.InstalledVersion(context.Background())
	if err != nil || v != "3.20.8" {
		t.Errorf("InstalledVersion = %q, %v — want 3.20.8, nil", v, err)
	}
}

func TestAppRunningLinux(t *testing.T) {
	rig := &linuxRig{t: t, running: true, oldestPID: "4242"}
	ins, root, _ := linuxInstaller(t, rig)

	// Nothing installed → not running, no probe at all.
	if ins.AppRunning(context.Background()) {
		t.Error("AppRunning = true with nothing installed")
	}
	if len(rig.pgrepArgs) != 0 {
		t.Errorf("pgrep ran with nothing installed: %v", rig.pgrepArgs)
	}

	if err := os.MkdirAll(linuxVersionDir(root, "3.20.8"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("3.20.8", linuxCurrentPath(root)); err != nil {
		t.Fatal(err)
	}
	if !ins.AppRunning(context.Background()) {
		t.Error("AppRunning = false with a matching pgrep")
	}
	want := regexp.QuoteMeta(filepath.Join(linuxVersionDir(root, "3.20.8"), "hexokit-desktop"))
	if got := rig.pgrepArgs[0]; len(got) != 2 || got[0] != "-f" || got[1] != want {
		t.Errorf("pgrep args = %v, want [-f %s]", got, want)
	}

	rig.running = false
	if ins.AppRunning(context.Background()) {
		t.Error("AppRunning = true with pgrep exit 1, want false")
	}
}

func TestUninstallLinuxHappyPath(t *testing.T) {
	rig := &linuxRig{t: t, tree: linuxTreeOpts{version: "3.21.0"}}
	ins, root, home := linuxInstaller(t, rig)
	srv := assetServer(t)
	digest := fakeDMGDigest()
	if _, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", digest)); err != nil {
		t.Fatalf("Install: %v", err)
	}

	res, err := ins.Uninstall(context.Background())
	if err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	if res.Version != "3.21.0" || res.Root != root {
		t.Errorf("result = %+v, want version 3.21.0 root %s", res, root)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Errorf("install root still present after uninstall")
	}
	for _, p := range []string{
		filepath.Join(home, ".local", "bin", "hexokit-desktop"),
		filepath.Join(home, ".local", "share", "applications", "hexokit-desktop.desktop"),
		filepath.Join(home, ".local", "share", "icons", "hicolor", "1024x1024", "apps", "hexokit-desktop.png"),
	} {
		if _, err := os.Lstat(p); !os.IsNotExist(err) {
			t.Errorf("%s still present after uninstall", p)
		}
	}
}

func TestUninstallLinuxNotInstalled(t *testing.T) {
	rig := &linuxRig{t: t}
	ins, root, _ := linuxInstaller(t, rig)
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := ins.Uninstall(context.Background())
	want := "HexoKit is not installed at " + linuxCurrentPath(root)
	if err == nil || err.Error() != want {
		t.Errorf("error = %v, want %q", err, want)
	}
}

func TestUninstallLinuxRunningRefuses(t *testing.T) {
	rig := &linuxRig{t: t, running: true, oldestPID: "4242"}
	ins, root, _ := linuxInstaller(t, rig)
	if err := os.MkdirAll(linuxVersionDir(root, "3.20.8"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("3.20.8", linuxCurrentPath(root)); err != nil {
		t.Fatal(err)
	}
	_, err := ins.Uninstall(context.Background())
	if err == nil || !strings.Contains(err.Error(), "HexoKit is running — quit it") {
		t.Fatalf("error = %v, want the running refusal", err)
	}
	if _, statErr := os.Stat(linuxVersionDir(root, "3.20.8")); statErr != nil {
		t.Error("version dir removed despite the running refusal")
	}
	if _, lstatErr := os.Lstat(linuxCurrentPath(root)); lstatErr != nil {
		t.Error("current symlink removed despite the running refusal")
	}
}

func TestUninstallLinuxForeignSymlinkLeftAlone(t *testing.T) {
	rig := &linuxRig{t: t, tree: linuxTreeOpts{version: "3.21.0"}}
	ins, _, home := linuxInstaller(t, rig)
	srv := assetServer(t)
	digest := fakeDMGDigest()
	if _, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", digest)); err != nil {
		t.Fatalf("Install: %v", err)
	}
	// A foreign hexokit-desktop — points OUTSIDE the root; uninstall must not
	// touch it.
	link := filepath.Join(home, ".local", "bin", "hexokit-desktop")
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/usr/local/bin/other-hexokit-desktop", link); err != nil {
		t.Fatal(err)
	}
	if _, err := ins.Uninstall(context.Background()); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
	if target, err := os.Readlink(link); err != nil || target != "/usr/local/bin/other-hexokit-desktop" {
		t.Errorf("foreign symlink = %q (%v), want left alone", target, err)
	}
}

func TestValidateExtractedTreeIconSize(t *testing.T) {
	dir := t.TempDir()
	writeLinuxTree(t, dir, linuxTreeOpts{version: "3.21.0", iconSizeDir: "256x256"})
	size, err := validateExtractedTree(dir, "3.21.0")
	if err != nil {
		t.Fatalf("validateExtractedTree: %v", err)
	}
	if size != "256x256" {
		t.Errorf("icon size dir = %q, want 256x256", size)
	}
}

func TestDefaultInstallDirFor(t *testing.T) {
	if got, err := DefaultInstallDirFor("darwin"); err != nil || got != "/Applications" {
		t.Errorf("darwin default = %q, %v — want /Applications, nil", got, err)
	}

	// XDG_STATE_HOME wins when set.
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	if got, err := DefaultInstallDirFor("linux"); err != nil || got != filepath.Join(state, "hexokit", "desktop") {
		t.Errorf("linux default = %q, %v — want <XDG_STATE_HOME>/hexokit/desktop", got, err)
	}

	// The XDG fallback: no XDG_STATE_HOME → ~/.local/state/hexokit/desktop.
	home := t.TempDir()
	t.Setenv("XDG_STATE_HOME", "")
	t.Setenv("HOME", home)
	if got, err := DefaultInstallDirFor("linux"); err != nil || got != filepath.Join(home, ".local", "state", "hexokit", "desktop") {
		t.Errorf("linux default = %q, %v — want ~/.local/state/hexokit/desktop", got, err)
	}
}

func TestEffectiveInstallDirLinuxDefault(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	ins := New()
	ins.GOOS = "linux"
	root, err := ins.effectiveInstallDir()
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(state, "hexokit", "desktop")
	if root != want {
		t.Errorf("root = %q, want <XDG_STATE_HOME>/hexokit/desktop", root)
	}
	if got := ins.AppPath(); got != filepath.Join(want, "current") {
		t.Errorf("AppPath = %q, want <root>/current", got)
	}

	// With neither XDG_STATE_HOME nor HOME resolvable, the default root fails
	// and AppPath degrades to the display spelling.
	t.Setenv("XDG_STATE_HOME", "")
	t.Setenv("HOME", "")
	if _, err := ins.effectiveInstallDir(); err == nil {
		t.Error("expected a home-resolution error, got nil")
	}
	if got, want := ins.AppPath(), filepath.Join("~", ".local", "state", "hexokit", "desktop", "current"); got != want {
		t.Errorf("AppPath = %q, want the degraded spelling %q", got, want)
	}
}

func TestEffectiveInstallDirRelativePathIsAbsolute(t *testing.T) {
	ins := New()
	ins.GOOS = "linux"
	ins.InstallDir = filepath.Join("rel", "desktop-root")
	root, err := ins.effectiveInstallDir()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(root) {
		t.Fatalf("root = %q, want an absolute path", root)
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(cwd, "rel", "desktop-root"); root != want {
		t.Errorf("root = %q, want %q", root, want)
	}
	if got := ins.AppPath(); got != filepath.Join(root, "current") {
		t.Errorf("AppPath = %q, want %q", got, filepath.Join(root, "current"))
	}
}

// A failed activation flip must leave no promoted version dir and no temp
// symlink behind — the previous install is exactly as it was. A directory at
// the current path (rename(2) fails with EISDIR) stands in for every flip
// failure the CLI can meet (EACCES, ENOSPC): the rollback path is the same.
func TestInstallLinuxFlipFailureLeavesNothingBehind(t *testing.T) {
	rig := &linuxRig{t: t, tree: linuxTreeOpts{version: "3.21.0"}}
	ins, root, _ := linuxInstaller(t, rig)
	if err := os.MkdirAll(filepath.Join(root, "current", "occupied"), 0o755); err != nil {
		t.Fatal(err)
	}
	srv := assetServer(t)

	_, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", fakeDMGDigest()))
	if err == nil || !strings.Contains(err.Error(), "flipping the current symlink") {
		t.Fatalf("error = %v, want a flip failure", err)
	}
	if _, statErr := os.Stat(filepath.Join(root, "3.21.0")); !os.IsNotExist(statErr) {
		t.Errorf("promoted version dir survived the failed flip (stat err = %v)", statErr)
	}
	if _, statErr := os.Lstat(filepath.Join(root, "current.tmp")); !os.IsNotExist(statErr) {
		t.Errorf("temp symlink survived the failed flip (lstat err = %v)", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(root, "current", "occupied")); statErr != nil {
		t.Errorf("the pre-existing current path was disturbed: %v", statErr)
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if e.Name() != "current" {
			t.Errorf("root holds unexpected %q after the failed flip", e.Name())
		}
	}
}

// A same-version reinstall (--force) never destroys the live tree before the
// swap can be undone: the tree is set aside, and a failed activation puts it
// back byte-for-byte.
func TestRestoreLinuxSwapPutsThePreviousTreeBack(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(root, "3.21.0")
	previous := filepath.Join(root, ".staging-x", "previous")
	for _, d := range []string{dest, previous} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dest, "marker"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(previous, "marker"), []byte("live"), 0o644); err != nil {
		t.Fatal(err)
	}
	var warnings bytes.Buffer
	restoreLinuxSwap(&warnings, dest, previous)
	got, err := os.ReadFile(filepath.Join(dest, "marker"))
	if err != nil || string(got) != "live" {
		t.Fatalf("dest marker = %q, %v — want the live tree restored", got, err)
	}
	if _, err := os.Stat(previous); !os.IsNotExist(err) {
		t.Errorf("previous still present after restore (err = %v)", err)
	}
	if warnings.Len() != 0 {
		t.Errorf("unexpected warnings: %s", warnings.String())
	}
	// Without a previous tree (a fresh or cross-version install), only the
	// promoted dir goes.
	restoreLinuxSwap(&warnings, dest, "")
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Errorf("dest still present after rollback (err = %v)", err)
	}
}

// The same-version path is taken only when current resolves to the release
// being installed: the live tree is moved aside into staging and, on success,
// replaced by the fresh extraction (staging is then gone).
func TestInstallLinuxSameVersionForceReplacesLiveTree(t *testing.T) {
	rig := &linuxRig{t: t, tree: linuxTreeOpts{version: "3.21.0"}}
	ins, root, _ := linuxInstaller(t, rig)
	srv := assetServer(t)
	if _, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", fakeDMGDigest())); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "3.21.0", "stale-marker")
	if err := os.WriteFile(marker, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ins.Install(context.Background(), linuxRelease(srv, "3.21.0", fakeDMGDigest())); err != nil {
		t.Fatalf("force reinstall: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Errorf("stale marker survived the reinstall (err = %v)", err)
	}
	if v, _ := installedVersionLinux(root); v != "3.21.0" {
		t.Errorf("current -> %q, want 3.21.0", v)
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if e.Name() != "3.21.0" && e.Name() != currentLinkName {
			t.Errorf("root holds unexpected %q after the reinstall", e.Name())
		}
	}
}
