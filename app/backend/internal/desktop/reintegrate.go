package desktop

import (
	"context"
	"io"
	"os"
	"path/filepath"
)

// ReintegrateLinux rewrites the user-scope Linux desktop integration — the
// .desktop launcher entry, the hicolor icon, and the ~/.local/bin symlink —
// against an already-installed root, so the absolute Exec= and link target
// follow the root after it moves (the ~/.rk → state-home move). No download or
// release state is involved, so the Installer is built bare (only Run,
// UserHome and Progress are read by the integration). Same posture as the
// install-time integration: every failure is a Progress warning, never an
// error.
func ReintegrateLinux(ctx context.Context, root string, progress io.Writer) {
	if progress == nil {
		progress = io.Discard
	}
	ins := &Installer{
		Run:      runCommand,
		UserHome: os.UserHomeDir,
		Progress: progress,
	}
	ins.integrateLinux(ctx, root, reintegrateIconSizeDir(root))
}

// reintegrateIconSizeDir rediscovers the hicolor size directory shipped in
// the installed tree. The fallback is the size the AppImage is known to
// carry; a missing icon then surfaces as integrateLinux's usual warning.
func reintegrateIconSizeDir(root string) string {
	matches, _ := filepath.Glob(filepath.Join(linuxCurrentPath(root), "usr", "share", "icons", "hicolor", "*", "apps", "hexokit-desktop.png"))
	if len(matches) == 0 {
		return "1024x1024"
	}
	return filepath.Base(filepath.Dir(filepath.Dir(matches[0])))
}
