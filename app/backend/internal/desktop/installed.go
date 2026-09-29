package desktop

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// legacyAppPath returns the pre-rename bundle path (<root>/Run Kit.app) beside
// AppPath — darwin only (the Linux layout is versioned under one root and was
// never keyed on the product name). It resolves the root like AppPath does,
// so an empty InstallDir means the platform default, never the CWD.
func (ins *Installer) legacyAppPath() string {
	root, err := ins.effectiveInstallDir()
	if err != nil {
		root = DefaultInstallDirFor(ins.GOOS, "~")
	}
	return filepath.Join(root, legacyAppBundleName)
}

// installedBundlePath returns the bundle path status reads and process probes
// target: the current-name bundle when its Info.plist exists, else the legacy
// pre-rename bundle when only it exists, else the current-name path (so a
// not-installed read resolves to a clean NotExist on the canonical path). The
// legacy fallback exists for one release window — a pre-rename install is the
// same rk-installed app and must read as "installed (older version)", never as
// "not installed". Darwin only.
func (ins *Installer) installedBundlePath() string {
	newPath := ins.AppPath()
	if _, err := os.Stat(filepath.Join(newPath, "Contents", "Info.plist")); err == nil {
		return newPath
	}
	legacyPath := ins.legacyAppPath()
	if _, err := os.Stat(filepath.Join(legacyPath, "Contents", "Info.plist")); err == nil {
		return legacyPath
	}
	return newPath
}

// CurrentBundleInstalled reports whether the current-name bundle
// (HexoKit.app) is present. The install/update no-op short-circuits key on
// it: InstalledVersion alone falls back to the legacy pre-rename bundle, so a
// same-version legacy-only install would otherwise read as complete and never
// migrate. Linux has no legacy bundle concept — its versioned layout was
// never keyed on the product name — so it reports true.
func (ins *Installer) CurrentBundleInstalled() bool {
	if ins.GOOS == "linux" {
		return true
	}
	_, err := os.Stat(filepath.Join(ins.AppPath(), "Contents", "Info.plist"))
	return err == nil
}

// installedAppName is the installed application's name as osascript
// addresses it and messages show it — derived from the installed bundle path
// on darwin so the quit target can never drift from the bundle the installer
// manages (a legacy install is addressed by its own name). Linux has no
// bundle name; it reads the product name.
func (ins *Installer) installedAppName() string {
	if ins.GOOS == "linux" {
		return appName
	}
	return strings.TrimSuffix(filepath.Base(ins.installedBundlePath()), ".app")
}

// installedBundlePaths lists every installed bundle path (a bundle counts
// when its Info.plist exists), current name first, then legacy. During the
// rename window both can exist side by side, and process probes must cover
// both — probing only installedBundlePath would miss a live legacy process
// and the swap would delete the running app. When neither exists it returns
// the canonical current-name path so not-installed reads behave as before.
// Darwin only.
func (ins *Installer) installedBundlePaths() []string {
	paths := make([]string, 0, 2)
	newPath := ins.AppPath()
	if _, err := os.Stat(filepath.Join(newPath, "Contents", "Info.plist")); err == nil {
		paths = append(paths, newPath)
	}
	legacyPath := ins.legacyAppPath()
	if _, err := os.Stat(filepath.Join(legacyPath, "Contents", "Info.plist")); err == nil {
		paths = append(paths, legacyPath)
	}
	if len(paths) == 0 {
		return []string{newPath}
	}
	return paths
}

// runningBundlePath probes each installed bundle for a live process and
// returns the first hit ("" when nothing is running) — the darwin quit flow's
// target when both bundles exist and the legacy one is the live install.
func (ins *Installer) runningBundlePath(ctx context.Context) string {
	for _, path := range ins.installedBundlePaths() {
		probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
		_, err := ins.Run(probeCtx, "pgrep", "-f", filepath.Join(path, "Contents", "MacOS"))
		cancel()
		if err == nil {
			return path
		}
	}
	return ""
}

// runningAppName is the osascript quit target: the name of the bundle with a
// live process, falling back to installedAppName when nothing probes live
// (message-only contexts).
func (ins *Installer) runningAppName(ctx context.Context) string {
	if path := ins.runningBundlePath(ctx); path != "" {
		return strings.TrimSuffix(filepath.Base(path), ".app")
	}
	return ins.installedAppName()
}

// InstalledVersion derives the installed desktop app's version at check time.
// On darwin it reads <root>/HexoKit.app/Contents/Info.plist (or the legacy
// pre-rename bundle's, see installedBundlePath)
// (CFBundleShortVersionString, via `plutil -extract … raw` through the Runner
// seam — an argument slice, never a constructed shell string); on linux it
// reads the current symlink's target basename. It is never assumed equal to
// the rk CLI version: a CLI upgrade does not move the app (Constitution II —
// derive, no state file). Returns ("", nil) when the app is not installed.
func (ins *Installer) InstalledVersion(ctx context.Context) (string, error) {
	if ins.GOOS == "linux" {
		root, err := ins.effectiveInstallDir()
		if err != nil {
			return "", err
		}
		return installedVersionLinux(root)
	}
	plist := filepath.Join(ins.installedBundlePath(), "Contents", "Info.plist")
	if _, err := os.Stat(plist); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", fmt.Errorf("checking installed app: %w", err)
	}

	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, err := ins.Run(probeCtx, "plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist)
	if err != nil {
		return "", fmt.Errorf("reading installed app version from %s: %w", plist, err)
	}
	v := strings.TrimSpace(string(out))
	if v == "" {
		return "", fmt.Errorf("empty CFBundleShortVersionString in %s", plist)
	}
	return v, nil
}

// AppRunning reports whether the installed app has a live process. On darwin
// it is a `pgrep -f` against each installed bundle's Contents/MacOS path
// (which also matches Electron helper processes — any hit means the app is
// live); when both the current and legacy bundles exist, both are probed — a
// live legacy process must not read as "not running" or the swap would
// remove it while it runs. On linux it is `pgrep -f` against the installed
// version dir's ELF path (see linux.go). Detection is best-effort: pgrep
// exits 1 on no match, so any error reads as "not running" (a rare probe
// failure must not block an install that would otherwise succeed).
func (ins *Installer) AppRunning(ctx context.Context) bool {
	if ins.GOOS == "linux" {
		root, err := ins.effectiveInstallDir()
		if err != nil {
			return false
		}
		return ins.appRunningLinux(ctx, root)
	}
	return ins.runningBundlePath(ctx) != ""
}
