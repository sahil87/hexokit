package desktop

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"

	"rk/internal/versionprune"
)

// Linux layout (the internal/codeserver layout idiom, Constitution II — the
// installed version is derived from the current symlink, never a state file):
//
//	<root>/<version>/    one extracted AppImage per version (the squashfs-root
//	                     contents: AppRun, hexokit-desktop, resources/app.asar,
//	                     hexokit-desktop.desktop, usr/…)
//	<root>/current       symlink → <version>; activation is an atomic flip
//	                     (temp symlink + os.Rename)
//	<root>/.staging-*    MkdirTemp staging dirs; the deterministic prefix lets
//	                     leftover dirs from interrupted runs be reclaimed
const (
	currentLinkName    = "current"
	linuxStagingPrefix = ".staging-"
)

// linuxVersionDir is the install dir of one release version (no leading "v").
func linuxVersionDir(root, version string) string {
	return filepath.Join(root, version)
}

// linuxCurrentPath is the activation symlink whose target names the active
// version.
func linuxCurrentPath(root string) string {
	return filepath.Join(root, currentLinkName)
}

// installedVersionLinux reads the active version from the current symlink's
// target basename. A missing symlink (nothing installed) yields ("", nil) —
// absence is a state, not an error; any other read failure is returned.
func installedVersionLinux(root string) (string, error) {
	target, err := os.Readlink(linuxCurrentPath(root))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return filepath.Base(target), nil
}

// linuxProbePattern is the pgrep -f match target for the running app: the
// version dir's Electron ELF path. AppRun execs that absolute path and
// Electron's zygote/renderer/GPU helpers carry it in their cmdline too, so
// any hit means live. The CURRENT symlink target is resolved at call time —
// before the swap flip, the running app lives in the OLD version dir.
func linuxProbePattern(root string) (string, bool) {
	version, err := installedVersionLinux(root)
	if err != nil || version == "" {
		return "", false
	}
	// pgrep -f takes an ERE; the path is a literal (a user --path may carry
	// regex metacharacters), so it is quoted.
	return regexp.QuoteMeta(filepath.Join(linuxVersionDir(root, version), "hexokit-desktop")), true
}

// appRunningLinux is the linux arm of AppRunning: a best-effort `pgrep -f`
// probe against the installed version dir's binary path (any error, incl.
// pgrep's exit 1, reads as not-running).
func (ins *Installer) appRunningLinux(ctx context.Context, root string) bool {
	pattern, ok := linuxProbePattern(root)
	if !ok {
		return false
	}
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	_, err := ins.Run(probeCtx, "pgrep", "-f", pattern)
	return err == nil
}

// installLinux is the Linux AppImage flow:
//
//  1. Refuse when the release supplies no sha256 digest — on Linux the digest
//     is the ONLY verification gate (no codesign equivalent), matching
//     internal/codeserver's fail-closed posture.
//  2. Download the AppImage into a staging dir under the root (SHA256 while
//     streaming) and compare against the digest; a mismatch discards it.
//  3. Only after the digest passes, chmod 0700 and run the downloaded file's
//     own `--appimage-extract` with the staging dir as CWD (the AppImage
//     runtime writes ./squashfs-root into the CWD and has no target flag).
//     Extraction needs no FUSE, so libfuse2 is not a runtime dependency of
//     the installed app.
//  4. Validate the extracted tree (validateExtractedTree) — the Linux
//     analogue of the darwin "bundle is named HexoKit.app" check.
//  5. Swap boundary: probe the running state against the pre-flip current
//     target; when live, SIGTERM the main process and wait (bounded) for
//     exit — aborting without swapping when the bound expires.
//  6. Rename squashfs-root → <root>/<version>, flip current atomically, then
//     prune superseded version dirs (keep current + the pre-flip target; a
//     failed flip leaves the existing install untouched; the staging dir is
//     removed on every path).
//  7. Write the user-scope desktop integration (integrate.go) — failures
//     after a successful flip are warnings, not install errors.
//  8. Relaunch <root>/current/AppRun detached when the app was running —
//     AppRun (not the raw ELF) because it supplies the bundled usr/lib via
//     LD_LIBRARY_PATH and adds --no-sandbox only where unprivileged user
//     namespaces are unavailable. A relaunch failure is a non-fatal warning.
func (ins *Installer) installLinux(ctx context.Context, rel Release) (InstallResult, error) {
	root, err := ins.effectiveInstallDir()
	if err != nil {
		return InstallResult{}, err
	}

	if rel.Digest == "" {
		return InstallResult{}, fmt.Errorf("release %s supplied no sha256 digest for %s — refusing to install an unverified binary", rel.Version, rel.AssetName)
	}

	if err := os.MkdirAll(root, 0o755); err != nil {
		return InstallResult{}, fmt.Errorf("creating %s: %w", root, err)
	}
	staging, err := os.MkdirTemp(root, linuxStagingPrefix)
	if err != nil {
		return InstallResult{}, fmt.Errorf("creating staging dir under %s: %w", root, err)
	}
	// Best-effort cleanup: after a successful swap the renames have emptied
	// this path, so the deferred RemoveAll is a no-op.
	defer os.RemoveAll(staging)

	appImage := filepath.Join(staging, rel.AssetName)
	sum, err := ins.download(ctx, rel, appImage)
	if err != nil {
		return InstallResult{}, err
	}
	if !strings.EqualFold(sum, rel.Digest) {
		return InstallResult{}, fmt.Errorf("checksum mismatch for %s: downloaded sha256:%s, release digest sha256:%s — refusing to install an unverified binary", rel.AssetName, sum, rel.Digest)
	}

	// The downloaded file is executed only now — after the digest gate passed
	// (Constitution I ordering: never execute unverified bytes).
	if err := os.Chmod(appImage, 0o700); err != nil {
		return InstallResult{}, fmt.Errorf("marking %s executable: %w", appImage, err)
	}
	fmt.Fprintf(ins.Progress, "Extracting %s...\n", rel.AssetName)
	extractCtx, cancelExtract := context.WithTimeout(ctx, extractTimeout)
	defer cancelExtract()
	if _, err := ins.RunInDir(extractCtx, staging, appImage, "--appimage-extract"); err != nil {
		return InstallResult{}, fmt.Errorf("extracting %s: %w", rel.AssetName, err)
	}
	if err := os.Remove(appImage); err != nil {
		return InstallResult{}, fmt.Errorf("removing staged AppImage: %w", err)
	}

	tree := filepath.Join(staging, "squashfs-root")
	iconSizeDir, err := validateExtractedTree(tree, rel.Version)
	if err != nil {
		return InstallResult{}, err
	}

	// Swap-boundary running check (the TOCTOU probe): everything above runs
	// while the app may be live — only the swap needs it gone.
	wasRunning := ins.appRunningLinux(ctx, root)
	if wasRunning {
		fmt.Fprintf(ins.Progress, "%s is running — quitting it for the update...\n", appName)
		if err := ins.quitAppLinux(ctx, root); err != nil {
			return InstallResult{}, err
		}
		if err := ins.waitAppExit(ctx); err != nil {
			return InstallResult{}, err
		}
	}

	dest := linuxVersionDir(root, rel.Version)
	// A same-version reinstall (--force) swaps the LIVE tree: set it aside
	// inside staging (same filesystem, so the rename is atomic) so a failed
	// activation can put it back, instead of destroying it first. Any other
	// pre-existing dest is a leftover from a run that never flipped current.
	// previousVersion is the pre-flip current target — the rollback version the
	// post-flip prune keeps.
	previousVersion, _ := installedVersionLinux(root)
	setAside := ""
	if previousVersion == rel.Version {
		aside := filepath.Join(staging, "previous")
		switch err := os.Rename(dest, aside); {
		case err == nil:
			setAside = aside
		case errors.Is(err, fs.ErrNotExist):
			// current dangles at a missing dir — nothing live to preserve.
		default:
			return InstallResult{}, fmt.Errorf("setting aside the live version dir %s: %w", dest, err)
		}
	} else if err := os.RemoveAll(dest); err != nil {
		return InstallResult{}, fmt.Errorf("clearing leftover version dir %s: %w", dest, err)
	}
	if err := os.Rename(tree, dest); err != nil {
		restoreLinuxSwap(ins.Progress, dest, setAside)
		return InstallResult{}, fmt.Errorf("promoting extracted tree to %s: %w", dest, err)
	}

	// Atomic activation: a temp symlink inside staging (same filesystem),
	// renamed over current, so no observer ever sees a missing or partial
	// current — and a failed flip leaves no stray symlink, because staging is
	// removed on every path.
	tmp := filepath.Join(staging, currentLinkName)
	if err := os.Symlink(rel.Version, tmp); err != nil {
		restoreLinuxSwap(ins.Progress, dest, setAside)
		return InstallResult{}, fmt.Errorf("creating temp symlink: %w", err)
	}
	if err := os.Rename(tmp, linuxCurrentPath(root)); err != nil {
		restoreLinuxSwap(ins.Progress, dest, setAside)
		return InstallResult{}, fmt.Errorf("flipping the current symlink: %w", err)
	}

	// Post-flip bookkeeping — the app is installed and launchable from here
	// on, so failures are chatter warnings, not install errors.
	versionprune.Prune(root, previousVersion, versionprune.WriterLogger(ins.Progress))
	ins.integrateLinux(ctx, root, iconSizeDir)

	restarted := false
	if wasRunning {
		fmt.Fprintf(ins.Progress, "Relaunching %s...\n", appName)
		if err := startDetached([]string{filepath.Join(linuxCurrentPath(root), "AppRun")}); err != nil {
			// Non-fatal: the swap succeeded — failing here would misreport a
			// completed update. The user can open the app themselves.
			fmt.Fprintf(ins.Progress, "warning: %v — open the app manually\n", err)
		} else {
			restarted = true
		}
	}

	return InstallResult{Version: rel.Version, Path: dest, Restarted: restarted}, nil
}

// restoreLinuxSwap undoes a promotion whose activation failed, so the
// install is exactly as it was: the promoted tree is removed and, for a
// same-version reinstall, the live tree set aside in staging is put back.
// Its own failures are reported rather than swallowed — a silent stray dir
// is precisely what the next run's leftover logic would misread.
func restoreLinuxSwap(progress io.Writer, dest, previous string) {
	if err := os.RemoveAll(dest); err != nil {
		fmt.Fprintf(progress, "warning: rolling back %s: %v\n", dest, err)
	}
	if previous == "" {
		return
	}
	if err := os.Rename(previous, dest); err != nil {
		fmt.Fprintf(progress, "warning: restoring the previous %s: %v\n", dest, err)
	}
}

// quitAppLinux asks the running app to quit gracefully: SIGTERM to the main
// process (the OLDEST PID matching the probe pattern) through the Signal
// seam. SIGTERM (not SIGKILL) matters twice over: Electron's SIGTERM handler
// runs the before-quit and window close handlers, so the shell captures
// lastPath exactly as the AppleScript quit does on macOS.
func (ins *Installer) quitAppLinux(ctx context.Context, root string) error {
	pattern, ok := linuxProbePattern(root)
	if !ok {
		return nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, err := ins.Run(probeCtx, "pgrep", "-o", "-f", pattern)
	if err != nil {
		return fmt.Errorf("finding the running %s process: %w", appName, err)
	}
	first, _, _ := strings.Cut(string(out), "\n")
	pid, err := strconv.Atoi(strings.TrimSpace(first))
	if err != nil {
		return fmt.Errorf("parsing the oldest %s PID from pgrep output %q: %w", appName, first, err)
	}
	if err := ins.Signal(pid, syscall.SIGTERM); err != nil {
		return fmt.Errorf("asking %s to quit: %w", appName, err)
	}
	return nil
}

// startDetached launches argv as a detached session leader with stdio on the
// null device (the internal/gui.StartDetached idiom). exec.Command rather
// than CommandContext BY DESIGN: the child must outlive the CLI process and
// its context (a context kill would murder the just-relaunched app when the
// CLI exits). The Start call itself is non-blocking, so no bound is needed;
// the async Wait reaps the child.
func startDetached(argv []string) error {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// validateExtractedTree checks the extracted squashfs-root before the install
// target is touched — the Linux analogue of the darwin "mounted bundle is
// named HexoKit.app" check. It returns the hicolor icon size directory found
// in the tree (e.g. "1024x1024") for the integration icon copy.
func validateExtractedTree(dir, version string) (string, error) {
	for _, req := range []struct {
		rel  string
		exec bool
	}{
		{"AppRun", true},
		{"hexokit-desktop", true},
		{filepath.Join("resources", "app.asar"), false},
		{"hexokit-desktop.desktop", false},
	} {
		info, err := os.Stat(filepath.Join(dir, req.rel))
		if err != nil || !info.Mode().IsRegular() {
			return "", fmt.Errorf("extracted AppImage tree at %s is missing %s — refusing to install an unexpected build", dir, req.rel)
		}
		if req.exec && info.Mode().Perm()&0o111 == 0 {
			return "", fmt.Errorf("extracted AppImage tree at %s has a non-executable %s — refusing to install an unexpected build", dir, req.rel)
		}
	}

	// The desktop entry's version stamp must equal the resolved release —
	// both derive from the release job's extraMetadata.version, so a mismatch
	// means the tree is not the build that was asked for.
	entry, err := os.ReadFile(filepath.Join(dir, "hexokit-desktop.desktop"))
	if err != nil {
		return "", err
	}
	reported := ""
	for _, line := range strings.Split(string(entry), "\n") {
		if v, ok := strings.CutPrefix(line, "X-AppImage-Version="); ok {
			reported = strings.TrimSpace(v)
		}
	}
	if reported != version {
		return "", fmt.Errorf("mounted AppImage reports version %q, expected %q — refusing to install an unexpected build", reported, version)
	}

	icons, err := filepath.Glob(filepath.Join(dir, "usr", "share", "icons", "hicolor", "*", "apps", "hexokit-desktop.png"))
	if err != nil || len(icons) == 0 {
		return "", fmt.Errorf("extracted AppImage tree at %s carries no hicolor hexokit-desktop icon — refusing to install an unexpected build", dir)
	}
	iconSizeDir := filepath.Base(filepath.Dir(filepath.Dir(icons[0])))

	// Containment (the internal/codeserver within/EvalSymlinks idiom): no
	// symlink inside the tree may resolve outside it. The tree is
	// digest-verified, but the guarantee is cheap; .DirIcon ->
	// usr/share/icons/... resolves inside and passes.
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink == 0 {
			return nil
		}
		target, err := os.Readlink(path)
		if err != nil {
			return err
		}
		if filepath.IsAbs(target) {
			return fmt.Errorf("refusing symlink escaping the install dir: %q -> %q", path, target)
		}
		if !within(realDir, filepath.Clean(filepath.Join(filepath.Dir(path), target))) {
			return fmt.Errorf("refusing symlink escaping the install dir: %q -> %q", path, target)
		}
		// A lexically tame target can still RESOLVE outside through earlier
		// symlinks — verify when it resolves; a dangling link is fine.
		if resolved, err := filepath.EvalSymlinks(path); err == nil && !within(realDir, resolved) {
			return fmt.Errorf("refusing symlink escaping the install dir: %q -> %q", path, target)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return iconSizeDir, nil
}

// within reports whether path is realDir itself or beneath it. Both arguments
// must already be symlink-resolved (the internal/codeserver idiom).
func within(realDir, path string) bool {
	return path == realDir || strings.HasPrefix(path, realDir+string(os.PathSeparator))
}
