package desktop

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
)

// linuxDesktopEntryName is the desktop-entry filename the installer writes;
// the shell's app.setDesktopName and the LauncherEntry badge key on it.
const linuxDesktopEntryName = "hexokit-desktop.desktop"

// linuxDesktopEntry renders the user-scope launcher entry. Exec is quoted —
// the install root may contain spaces.
func linuxDesktopEntry(appRun string) string {
	return "[Desktop Entry]\n" +
		"Name=HexoKit\n" +
		"Comment=HexoKit desktop viewer shell — loads an existing rk serve URL (client only, never spawns or supervises the daemon)\n" +
		"Exec=\"" + appRun + "\" %U\n" +
		"Terminal=false\n" +
		"Type=Application\n" +
		"Icon=hexokit-desktop\n" +
		"StartupWMClass=HexoKit\n" +
		"Categories=Development;\n"
}

// integrateLinux writes the user-scope desktop integration after a successful
// flip: the .desktop entry, the hicolor icon, and the ~/.local/bin symlink,
// plus a best-effort update-desktop-database refresh. Everything lives under
// the user's home and every failure is a Progress warning, never an install
// error — the app is already installed and launchable via current/AppRun.
func (ins *Installer) integrateLinux(ctx context.Context, root, iconSizeDir string) {
	appRun := filepath.Join(linuxCurrentPath(root), "AppRun")
	home, err := ins.UserHome()
	if err != nil {
		fmt.Fprintf(ins.Progress, "warning: desktop integration skipped (home unresolvable: %v) — launch the app from %s\n", err, appRun)
		return
	}

	appsDir := filepath.Join(home, ".local", "share", "applications")
	if err := os.MkdirAll(appsDir, 0o755); err != nil {
		fmt.Fprintf(ins.Progress, "warning: creating %s: %v\n", appsDir, err)
	} else if err := os.WriteFile(filepath.Join(appsDir, linuxDesktopEntryName), []byte(linuxDesktopEntry(appRun)), 0o644); err != nil {
		fmt.Fprintf(ins.Progress, "warning: writing the launcher entry: %v\n", err)
	}

	// The icon mirrors the size directory shipped in the tree (the AppImage
	// carries only 1024x1024); a differently-labelled dir would mislabel the
	// raster per the icon-theme spec. No gtk-update-icon-cache — hicolor user
	// icons need no cache.
	iconSrc := filepath.Join(linuxCurrentPath(root), "usr", "share", "icons", "hicolor", iconSizeDir, "apps", "hexokit-desktop.png")
	iconDst := filepath.Join(home, ".local", "share", "icons", "hicolor", iconSizeDir, "apps", "hexokit-desktop.png")
	if data, err := os.ReadFile(iconSrc); err != nil {
		fmt.Fprintf(ins.Progress, "warning: reading the bundled icon %s: %v\n", iconSrc, err)
	} else if err := os.MkdirAll(filepath.Dir(iconDst), 0o755); err != nil {
		fmt.Fprintf(ins.Progress, "warning: creating %s: %v\n", filepath.Dir(iconDst), err)
	} else if err := os.WriteFile(iconDst, data, 0o644); err != nil {
		fmt.Fprintf(ins.Progress, "warning: installing the icon to %s: %v\n", iconDst, err)
	}

	if _, err := exec.LookPath("update-desktop-database"); err == nil {
		dbCtx, cancel := context.WithTimeout(ctx, integrateTimeout)
		defer cancel()
		if _, err := ins.Run(dbCtx, "update-desktop-database", appsDir); err != nil {
			fmt.Fprintf(ins.Progress, "note: update-desktop-database failed: %v\n", err)
		}
	} else {
		fmt.Fprintf(ins.Progress, "note: update-desktop-database not found — skipping the desktop-entry index refresh\n")
	}

	// The PATH-adjacent symlink. ~/.local/bin being off PATH is the user's
	// shell's concern — no PATH editing.
	binDir := filepath.Join(home, ".local", "bin")
	link := filepath.Join(binDir, "hexokit-desktop")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		fmt.Fprintf(ins.Progress, "warning: creating %s: %v\n", binDir, err)
		return
	}
	tmp := link + ".tmp"
	if err := os.Remove(tmp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintf(ins.Progress, "warning: clearing stale temp symlink %s: %v\n", tmp, err)
		return
	}
	if err := os.Symlink(appRun, tmp); err != nil {
		fmt.Fprintf(ins.Progress, "warning: creating %s: %v\n", link, err)
		return
	}
	if err := os.Rename(tmp, link); err != nil {
		fmt.Fprintf(ins.Progress, "warning: installing the %s symlink: %v\n", link, err)
	}
}

// UninstallResult reports a completed uninstall.
type UninstallResult struct {
	// Version is the version that was active (the pre-removal current target).
	Version string
	// Root is the install root the version dirs were removed from.
	Root string
}

// Uninstall removes a Linux install: every version dir under the root and the
// current symlink (then the root itself when empty), the ~/.local/bin symlink
// (only when it points into the root), the launcher entry, and the icon(s).
// It refuses when nothing is installed and while the app is running (a
// destructive command does not quit the user's app for them). Electron user
// data under ~/.config/HexoKit is user data, not the install, and is
// never touched.
func (ins *Installer) Uninstall(ctx context.Context) (UninstallResult, error) {
	root, err := ins.effectiveInstallDir()
	if err != nil {
		return UninstallResult{}, err
	}
	version, err := installedVersionLinux(root)
	if err != nil {
		return UninstallResult{}, fmt.Errorf("checking the installed app: %w", err)
	}
	if version == "" {
		return UninstallResult{}, fmt.Errorf("HexoKit is not installed at %s", linuxCurrentPath(root))
	}
	if ins.AppRunning(ctx) {
		return UninstallResult{}, fmt.Errorf("HexoKit is running — quit it, then re-run this command")
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return UninstallResult{}, fmt.Errorf("reading %s: %w", root, err)
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(root, e.Name())); err != nil {
			return UninstallResult{}, fmt.Errorf("removing %s: %w", filepath.Join(root, e.Name()), err)
		}
	}
	// The root goes too when it now holds nothing; other content (not ours)
	// keeps it in place.
	if remaining, err := os.ReadDir(root); err == nil && len(remaining) == 0 {
		_ = os.Remove(root)
	}

	home, err := ins.UserHome()
	if err != nil {
		fmt.Fprintf(ins.Progress, "warning: integration cleanup skipped (home unresolvable: %v)\n", err)
		return UninstallResult{Version: version, Root: root}, nil
	}

	// The PATH symlink is removed only when it points INTO the root — a
	// foreign hexokit-desktop there is the user's, not this install's.
	link := filepath.Join(home, ".local", "bin", "hexokit-desktop")
	if target, err := os.Readlink(link); err == nil {
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(link), target)
		}
		if within(root, filepath.Clean(target)) {
			if err := os.Remove(link); err != nil {
				fmt.Fprintf(ins.Progress, "warning: removing %s: %v\n", link, err)
			}
		}
	}

	appsDir := filepath.Join(home, ".local", "share", "applications")
	if err := os.Remove(filepath.Join(appsDir, linuxDesktopEntryName)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintf(ins.Progress, "warning: removing the launcher entry: %v\n", err)
	}
	icons, _ := filepath.Glob(filepath.Join(home, ".local", "share", "icons", "hicolor", "*", "apps", "hexokit-desktop.png"))
	for _, icon := range icons {
		if err := os.Remove(icon); err != nil {
			fmt.Fprintf(ins.Progress, "warning: removing the icon %s: %v\n", icon, err)
		}
	}

	if _, err := exec.LookPath("update-desktop-database"); err == nil {
		dbCtx, cancel := context.WithTimeout(ctx, integrateTimeout)
		defer cancel()
		if _, err := ins.Run(dbCtx, "update-desktop-database", appsDir); err != nil {
			fmt.Fprintf(ins.Progress, "note: update-desktop-database failed: %v\n", err)
		}
	}

	return UninstallResult{Version: version, Root: root}, nil
}
