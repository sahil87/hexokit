package desktop

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fakeDMGBytes = "fake-dmg-payload"

func fakeDMGDigest() string {
	sum := sha256.Sum256([]byte(fakeDMGBytes))
	return hex.EncodeToString(sum[:])
}

// assetServer serves the fake DMG payload for any path.
func assetServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(fakeDMGBytes))
	}))
	t.Cleanup(srv.Close)
	return srv
}

type cmdRecord struct {
	name string
	args []string
}

// runnerOpts configures the fake macOS tool sequence installRunner provides.
// The zero value is the happy path: attach materializes AppBundleName in the
// mountpoint, codesign passes, ditto creates its destination, pgrep reports
// not-running.
type runnerOpts struct {
	noApp        bool   // `hdiutil attach` creates no .app in the mountpoint
	appName      string // bundle name attach creates ("" → AppBundleName)
	failCodesign bool   // `codesign` fails verification
	failDitto    bool   // `ditto` fails mid-copy
	appRunning   bool   // `pgrep` reports a live app until an osascript quit is seen
	neverExits   bool   // with appRunning: pgrep stays live even after the quit
	failOpen     bool   // `open` (the relaunch) fails
}

// installRunner fakes the macOS tool sequence on Linux per opts. It is
// stateful: with opts.appRunning, pgrep reports a live app until the runner
// observes the osascript graceful quit (then not-running — the app "exited"),
// unless opts.neverExits pins it live to exercise the quit-timeout path.
func installRunner(t *testing.T, rec *[]cmdRecord, opts runnerOpts) Runner {
	t.Helper()
	appName := opts.appName
	if appName == "" {
		appName = AppBundleName
	}
	quitSeen := false
	return func(_ context.Context, name string, args ...string) ([]byte, error) {
		*rec = append(*rec, cmdRecord{name: name, args: args})
		switch {
		case name == "hdiutil" && len(args) > 4 && args[0] == "attach":
			if !opts.noApp {
				// args: attach -nobrowse -readonly -mountpoint <mount> <dmg>
				if err := os.MkdirAll(filepath.Join(args[4], appName), 0o755); err != nil {
					t.Fatal(err)
				}
			}
		case name == "codesign":
			if opts.failCodesign {
				return nil, errors.New("code object is not signed at all")
			}
		case name == "ditto":
			if opts.failDitto {
				return nil, errors.New("ditto: couldn't copy")
			}
			if err := os.MkdirAll(args[1], 0o755); err != nil {
				t.Fatal(err)
			}
		case name == "osascript":
			quitSeen = true
		case name == "open":
			if opts.failOpen {
				return nil, errors.New("open: unable to launch")
			}
		case name == "pgrep":
			if opts.appRunning && (opts.neverExits || !quitSeen) {
				return []byte("123\n"), nil
			}
			return nil, errors.New("exit status 1") // pgrep: no match
		}
		return nil, nil
	}
}

// makeExistingInstall creates <installDir>/<AppBundleName> with a marker file
// so tests can assert whether the pre-existing install survived.
func makeExistingInstall(t *testing.T, installDir string) (markerPath string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(installDir, AppBundleName), 0o755); err != nil {
		t.Fatal(err)
	}
	markerPath = filepath.Join(installDir, AppBundleName, "old-marker")
	if err := os.WriteFile(markerPath, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	return markerPath
}

// assertNoStagedResidue fails if installDir holds anything besides the (at
// most one) real bundle — i.e. a staged temp bundle survived a failure path.
func assertNoStagedResidue(t *testing.T, installDir string) {
	t.Helper()
	entries, err := os.ReadDir(installDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != AppBundleName {
			t.Errorf("unexpected residue in install dir: %q", e.Name())
		}
	}
}

func cmdNames(rec []cmdRecord) []string {
	names := make([]string, 0, len(rec))
	for _, c := range rec {
		names = append(names, c.name+" "+c.args[0])
	}
	return names
}

func TestInstallSuccessFlow(t *testing.T) {
	srv := assetServer(t)
	installDir := t.TempDir()

	// Pre-existing install: a marker that must be gone after the reinstall.
	oldMarker := makeExistingInstall(t, installDir)
	// A stale staged temp from a previously interrupted run: must be reclaimed.
	staleStaged := filepath.Join(installDir, "."+AppBundleName+".staging")
	if err := os.MkdirAll(staleStaged, 0o755); err != nil {
		t.Fatal(err)
	}

	var rec []cmdRecord
	var progress bytes.Buffer
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = installDir
	ins.Token = ""
	ins.Progress = &progress
	ins.Run = installRunner(t, &rec, runnerOpts{})

	rel := Release{
		Version:   "3.13.0",
		AssetName: "run-kit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl/run-kit-desktop-3.13.0-arm64.dmg",
		Digest:    fakeDMGDigest(),
	}
	res, err := ins.Install(context.Background(), rel)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if res.Version != "3.13.0" {
		t.Errorf("result version = %q, want 3.13.0", res.Version)
	}
	wantPath := filepath.Join(installDir, AppBundleName)
	if res.Path != wantPath {
		t.Errorf("result path = %q, want %q", res.Path, wantPath)
	}
	if res.Restarted {
		t.Error("result Restarted = true, want false when the app was not running")
	}

	names := cmdNames(rec)
	// The pgrep between ditto and detach is the pre-replace running-app
	// re-check; the replace itself (remove + rename) is not a subprocess.
	wantNames := []string{"hdiutil attach", "codesign --verify", "ditto", "pgrep -f", "hdiutil detach"}
	if len(names) != len(wantNames) {
		t.Fatalf("command sequence = %v, want %d commands %v", names, len(wantNames), wantNames)
	}
	for i, prefix := range wantNames {
		if !strings.HasPrefix(names[i], prefix) {
			t.Errorf("command[%d] = %q, want prefix %q", i, names[i], prefix)
		}
	}
	// ditto staged INTO the install dir (not the final path) — the staging
	// half of stage-then-atomic-replace.
	for _, c := range rec {
		if c.name == "ditto" {
			if got, want := c.args[1], staleStaged; got != want {
				t.Errorf("ditto destination = %q, want the staged path %q", got, want)
			}
		}
	}

	// The old bundle content was replaced by the rename.
	if _, err := os.Stat(oldMarker); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("old bundle marker still present after reinstall: %v", err)
	}
	// No staged temp (stale or fresh) left behind.
	assertNoStagedResidue(t, installDir)
	// The temp DMG (last attach arg) was cleaned up.
	dmgPath := rec[0].args[len(rec[0].args)-1]
	if _, err := os.Stat(dmgPath); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("temp DMG %s not cleaned up: %v", dmgPath, err)
	}
	if !strings.Contains(progress.String(), "Downloading run-kit-desktop-3.13.0-arm64.dmg") {
		t.Errorf("progress output missing download line: %q", progress.String())
	}
}

func TestInstallChecksumMismatchAbortsBeforeMount(t *testing.T) {
	srv := assetServer(t)

	var rec []cmdRecord
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = t.TempDir()
	ins.Token = ""
	ins.Run = installRunner(t, &rec, runnerOpts{})

	rel := Release{
		Version:   "3.13.0",
		AssetName: "run-kit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl",
		Digest:    "deadbeef", // wrong on purpose
	}
	_, err := ins.Install(context.Background(), rel)
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("error = %v, want a checksum-mismatch error", err)
	}
	if len(rec) != 0 {
		t.Errorf("subprocesses ran despite checksum failure: %v", cmdNames(rec))
	}
}

func TestInstallCodesignFailureAbortsAndDetaches(t *testing.T) {
	srv := assetServer(t)
	installDir := t.TempDir()

	// Pre-existing install that MUST survive a failed verification.
	oldMarker := makeExistingInstall(t, installDir)

	var rec []cmdRecord
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = installDir
	ins.Token = ""
	ins.Run = installRunner(t, &rec, runnerOpts{failCodesign: true})

	rel := Release{
		Version:   "3.13.0",
		AssetName: "run-kit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl",
		Digest:    fakeDMGDigest(),
	}
	_, err := ins.Install(context.Background(), rel)
	if err == nil || !strings.Contains(err.Error(), "signature verification failed") {
		t.Fatalf("error = %v, want a signature-verification error", err)
	}

	names := cmdNames(rec)
	for _, n := range names {
		if strings.HasPrefix(n, "ditto") {
			t.Errorf("ditto ran despite codesign failure: %v", names)
		}
	}
	if last := names[len(names)-1]; !strings.HasPrefix(last, "hdiutil detach") {
		t.Errorf("last command = %q, want the deferred hdiutil detach", last)
	}
	if _, err := os.Stat(oldMarker); err != nil {
		t.Errorf("existing install was touched despite failed verification: %v", err)
	}
	// Temp DMG cleaned up on the failure path too.
	dmgPath := rec[0].args[len(rec[0].args)-1]
	if _, err := os.Stat(dmgPath); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("temp DMG %s not cleaned up: %v", dmgPath, err)
	}
}

func TestInstallNoDigestNotesAndProceeds(t *testing.T) {
	srv := assetServer(t)

	var rec []cmdRecord
	var progress bytes.Buffer
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = t.TempDir()
	ins.Token = ""
	ins.Progress = &progress
	ins.Run = installRunner(t, &rec, runnerOpts{})

	rel := Release{
		Version:   "3.13.0",
		AssetName: "run-kit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl",
		Digest:    "", // API supplied none
	}
	if _, err := ins.Install(context.Background(), rel); err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !strings.Contains(progress.String(), "no digest") {
		t.Errorf("progress output should note the missing digest: %q", progress.String())
	}
}

func TestInstallNoAppBundleInDMG(t *testing.T) {
	srv := assetServer(t)

	var rec []cmdRecord
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = t.TempDir()
	ins.Token = ""
	ins.Run = installRunner(t, &rec, runnerOpts{noApp: true}) // attach creates no .app

	rel := Release{
		Version:   "3.13.0",
		AssetName: "run-kit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl",
		Digest:    fakeDMGDigest(),
	}
	_, err := ins.Install(context.Background(), rel)
	if err == nil || !strings.Contains(err.Error(), "no .app bundle") {
		t.Fatalf("error = %v, want a no-app-bundle error", err)
	}
	if last := cmdNames(rec)[len(rec)-1]; !strings.HasPrefix(last, "hdiutil detach") {
		t.Errorf("last command = %q, want the deferred hdiutil detach", last)
	}
}

// TestInstallMidCopyFailurePreservesExistingInstall: the stage-then-replace
// ordering means a ditto failure aborts BEFORE the existing bundle is touched
// (R6) — and leaves no staged temp behind.
func TestInstallMidCopyFailurePreservesExistingInstall(t *testing.T) {
	srv := assetServer(t)
	installDir := t.TempDir()
	oldMarker := makeExistingInstall(t, installDir)

	var rec []cmdRecord
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = installDir
	ins.Token = ""
	ins.Run = installRunner(t, &rec, runnerOpts{failDitto: true})

	rel := Release{
		Version:   "3.13.0",
		AssetName: "run-kit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl",
		Digest:    fakeDMGDigest(),
	}
	_, err := ins.Install(context.Background(), rel)
	if err == nil || !strings.Contains(err.Error(), "copying app bundle") {
		t.Fatalf("error = %v, want a copy error", err)
	}
	if _, err := os.Stat(oldMarker); err != nil {
		t.Errorf("existing install destroyed by a mid-copy failure: %v", err)
	}
	assertNoStagedResidue(t, installDir)
	names := cmdNames(rec)
	if last := names[len(names)-1]; !strings.HasPrefix(last, "hdiutil detach") {
		t.Errorf("last command = %q, want the deferred hdiutil detach", last)
	}
}

// TestInstallRunningAppQuitSwapRelaunch: a running app at the swap boundary is
// gracefully quit (osascript), waited on (pgrep poll), swapped, and relaunched
// (`open -a` on the installed path) — in that order — and the result reports
// Restarted (R2, R5).
func TestInstallRunningAppQuitSwapRelaunch(t *testing.T) {
	srv := assetServer(t)
	installDir := t.TempDir()
	oldMarker := makeExistingInstall(t, installDir)

	var rec []cmdRecord
	var progress bytes.Buffer
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = installDir
	ins.Token = ""
	ins.Progress = &progress
	ins.Run = installRunner(t, &rec, runnerOpts{appRunning: true})

	rel := Release{
		Version:   "3.13.0",
		AssetName: "run-kit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl",
		Digest:    fakeDMGDigest(),
	}
	res, err := ins.Install(context.Background(), rel)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !res.Restarted {
		t.Error("result Restarted = false, want true after a completed quit → swap → relaunch")
	}

	names := cmdNames(rec)
	// The boundary pgrep sees the live app, osascript quits it, the poll pgrep
	// sees it gone, the (non-subprocess) rename swaps, then open relaunches.
	wantNames := []string{"hdiutil attach", "codesign --verify", "ditto", "pgrep -f", "osascript -e", "pgrep -f", "open -a", "hdiutil detach"}
	if len(names) != len(wantNames) {
		t.Fatalf("command sequence = %v, want %d commands %v", names, len(wantNames), wantNames)
	}
	for i, prefix := range wantNames {
		if !strings.HasPrefix(names[i], prefix) {
			t.Errorf("command[%d] = %q, want prefix %q", i, names[i], prefix)
		}
	}
	for _, c := range rec {
		switch c.name {
		case "osascript":
			if want := `tell application "HexoKit" to quit`; len(c.args) != 2 || c.args[1] != want {
				t.Errorf("osascript args = %v, want [-e %q]", c.args, want)
			}
		case "open":
			if want := filepath.Join(installDir, AppBundleName); len(c.args) != 2 || c.args[1] != want {
				t.Errorf("open args = %v, want [-a %q]", c.args, want)
			}
		}
	}

	// The swap really happened and left no residue.
	if _, err := os.Stat(oldMarker); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("old bundle marker still present after the auto-restart update: %v", err)
	}
	assertNoStagedResidue(t, installDir)
	for _, chatter := range []string{"quitting it for the update", "Relaunching"} {
		if !strings.Contains(progress.String(), chatter) {
			t.Errorf("progress output missing %q: %q", chatter, progress.String())
		}
	}
}

// TestInstallQuitTimeoutAbortsWithoutSwap: the app never exits after the
// graceful quit — the install aborts without swapping, the existing install
// is untouched, no relaunch is attempted, and the error instructs a manual
// quit (R3). The staged bundle is deliberately left in place: its
// deterministic name is reclaimed at the next run's stage step.
func TestInstallQuitTimeoutAbortsWithoutSwap(t *testing.T) {
	srv := assetServer(t)
	installDir := t.TempDir()
	oldMarker := makeExistingInstall(t, installDir)

	var rec []cmdRecord
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = installDir
	ins.Token = ""
	ins.Run = installRunner(t, &rec, runnerOpts{appRunning: true, neverExits: true})
	ins.QuitWait = 30 * time.Millisecond
	ins.QuitPoll = 5 * time.Millisecond

	rel := Release{
		Version:   "3.13.0",
		AssetName: "run-kit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl",
		Digest:    fakeDMGDigest(),
	}
	_, err := ins.Install(context.Background(), rel)
	if err == nil || !strings.Contains(err.Error(), "quit the app manually") {
		t.Fatalf("error = %v, want the manual-quit timeout error", err)
	}
	if _, err := os.Stat(oldMarker); err != nil {
		t.Errorf("existing install touched despite the quit-timeout abort: %v", err)
	}
	staged := filepath.Join(installDir, "."+AppBundleName+".staging")
	if _, err := os.Stat(staged); err != nil {
		t.Errorf("staged bundle should be left in place on quit-timeout (self-heals next run): %v", err)
	}
	for _, n := range cmdNames(rec) {
		if strings.HasPrefix(n, "open") {
			t.Errorf("relaunch attempted despite the aborted swap: %v", cmdNames(rec))
		}
	}
}

// TestInstallRelaunchFailureNonFatal: a failed `open -a` after a successful
// swap does not fail the update — the result is nil-error with Restarted
// false, and the failure surfaces as a Progress warning (R4).
func TestInstallRelaunchFailureNonFatal(t *testing.T) {
	srv := assetServer(t)
	installDir := t.TempDir()
	oldMarker := makeExistingInstall(t, installDir)

	var rec []cmdRecord
	var progress bytes.Buffer
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = installDir
	ins.Token = ""
	ins.Progress = &progress
	ins.Run = installRunner(t, &rec, runnerOpts{appRunning: true, failOpen: true})

	rel := Release{
		Version:   "3.13.0",
		AssetName: "run-kit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl",
		Digest:    fakeDMGDigest(),
	}
	res, err := ins.Install(context.Background(), rel)
	if err != nil {
		t.Fatalf("Install must not fail on a relaunch error (the swap succeeded): %v", err)
	}
	if res.Restarted {
		t.Error("result Restarted = true, want false when the relaunch failed")
	}
	if _, err := os.Stat(oldMarker); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("swap did not happen despite the successful quit: %v", err)
	}
	if !strings.Contains(progress.String(), "warning:") || !strings.Contains(progress.String(), "open the app manually") {
		t.Errorf("progress output missing the relaunch warning: %q", progress.String())
	}
}

// TestInstallRemovesLegacyBundle: a pre-rename Run Kit.app beside the install
// target is removed once the new bundle lands — it is the same rk-installed
// app under its old name, and leaving both yields two Dock entries.
func TestInstallRemovesLegacyBundle(t *testing.T) {
	srv := assetServer(t)
	installDir := t.TempDir()

	legacyDir := filepath.Join(installDir, legacyAppBundleName)
	if err := os.MkdirAll(legacyDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacyDir, "old-marker"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	var rec []cmdRecord
	var progress bytes.Buffer
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = installDir
	ins.Token = ""
	ins.Progress = &progress
	ins.Run = installRunner(t, &rec, runnerOpts{})

	rel := Release{
		Version:   "3.13.0",
		AssetName: "hexokit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl",
		Digest:    fakeDMGDigest(),
	}
	res, err := ins.Install(context.Background(), rel)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if res.Path != filepath.Join(installDir, AppBundleName) {
		t.Errorf("installed path = %q, want %q", res.Path, filepath.Join(installDir, AppBundleName))
	}
	if _, err := os.Stat(legacyDir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("legacy bundle still present after the install: %v", err)
	}
	if _, err := os.Stat(res.Path); err != nil {
		t.Errorf("new bundle missing after the install: %v", err)
	}
	if !strings.Contains(progress.String(), "Removed legacy") {
		t.Errorf("progress output missing the legacy-removal line: %q", progress.String())
	}
	assertNoStagedResidue(t, installDir)
}

// TestInstallLegacyBundleRenamed: a legacy-prefix DMG carries the pre-rename
// bundle — it must install (ResolveRelease's fallback resolves it), landing
// under the current name via the staged ditto copy.
func TestInstallLegacyBundleRenamed(t *testing.T) {
	srv := assetServer(t)
	installDir := t.TempDir()

	var rec []cmdRecord
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = installDir
	ins.Token = ""
	ins.Run = installRunner(t, &rec, runnerOpts{appName: legacyAppBundleName})

	rel := Release{
		Version:   "3.13.0",
		AssetName: "run-kit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl",
		Digest:    fakeDMGDigest(),
	}
	res, err := ins.Install(context.Background(), rel)
	if err != nil {
		t.Fatalf("Install of a legacy-named bundle: %v", err)
	}
	if want := filepath.Join(installDir, AppBundleName); res.Path != want {
		t.Errorf("installed path = %q, want %q (renamed to the current bundle)", res.Path, want)
	}
	if _, err := os.Stat(res.Path); err != nil {
		t.Errorf("current-name bundle missing after installing the legacy DMG: %v", err)
	}
	assertNoStagedResidue(t, installDir)
}

// TestInstallBundleNameMismatch: a mounted bundle named neither AppBundleName
// nor the pre-rename legacy name is
// refused before verification/copy — the install target is derived from the
// constant, never from the DMG's contents.
func TestInstallBundleNameMismatch(t *testing.T) {
	srv := assetServer(t)
	installDir := t.TempDir()

	var rec []cmdRecord
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = installDir
	ins.Token = ""
	ins.Run = installRunner(t, &rec, runnerOpts{appName: "Evil.app"})

	rel := Release{
		Version:   "3.13.0",
		AssetName: "run-kit-desktop-3.13.0-arm64.dmg",
		AssetURL:  srv.URL + "/dl",
		Digest:    fakeDMGDigest(),
	}
	_, err := ins.Install(context.Background(), rel)
	if err == nil || !strings.Contains(err.Error(), `expected "HexoKit.app"`) {
		t.Fatalf("error = %v, want a bundle-name-mismatch error naming the expected bundle", err)
	}
	names := cmdNames(rec)
	for _, n := range names {
		if strings.HasPrefix(n, "codesign") || strings.HasPrefix(n, "ditto") {
			t.Errorf("%s ran despite the bundle-name mismatch: %v", n, names)
		}
	}
	if last := names[len(names)-1]; !strings.HasPrefix(last, "hdiutil detach") {
		t.Errorf("last command = %q, want the deferred hdiutil detach", last)
	}
	assertNoStagedResidue(t, installDir)
}

func TestInstallDownloadHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	var rec []cmdRecord
	ins := New()
	ins.GOOS = "darwin"
	ins.Client = srv.Client()
	ins.InstallDir = t.TempDir()
	ins.Token = ""
	ins.Run = installRunner(t, &rec, runnerOpts{})

	rel := Release{Version: "3.13.0", AssetName: "x.dmg", AssetURL: srv.URL + "/dl"}
	_, err := ins.Install(context.Background(), rel)
	if err == nil || !strings.Contains(err.Error(), "HTTP 404") {
		t.Fatalf("error = %v, want an HTTP 404 download error", err)
	}
	if len(rec) != 0 {
		t.Errorf("subprocesses ran despite download failure: %v", cmdNames(rec))
	}
}
