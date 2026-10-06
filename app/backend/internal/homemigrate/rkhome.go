// MoveRKTenants is the one-shot ~/.rk → state-home move, run from
// cmd/rk/serve.go right after Migrate (inheriting its dev-build skip and
// port-busy deferral). Every ~/.rk tenant that rk manages — the VAPID
// keypair, push subscriptions, the code-server install and profile, job logs,
// the Linux desktop install — moves into apphome.NewStateDir(); user-owned
// files (a hand-edited tmux.conf, a not-yet-migrated settings.yaml) stay.
//
// The posture matches Migrate: best-effort and non-fatal, rename-first with a
// verified copy fallback on EXDEV, and never overwriting an existing
// destination (a conflict leaves the source in place and warns). The daemon
// always continues to start.
package homemigrate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"rk/internal/apphome"
	"rk/internal/codebridge"
	"rk/internal/codeserver"
	"rk/internal/daemon"
	"rk/internal/desktop"
	"rk/internal/portpolicy"
	"rk/internal/settings"
	"rk/internal/versionprune"
)

// The package-var seams below mirror cmd/rk/serve.go's migrateHomes idiom so
// tests drive the move without a live tmux server, a bundled VSIX, or a real
// desktop integration — the defaults would touch the developer's machine.

// killCodeServerFn stops the rk-code-server session before its install and
// profile move out from under it. An absent session is success.
var killCodeServerFn = daemon.KillCodeServerSession

// codeBridgeEmbeddedFn resolves the bundled rk-code-bridge VSIX; ok=false on
// dev builds without the extension step.
var codeBridgeEmbeddedFn = codebridge.Embedded

// installBridgeExtensionFn is the idempotent bridge-extension install run
// after the move so the extension comes up on the bundled version, which
// resolves the hexokit state home.
var installBridgeExtensionFn = codeserver.InstallBridgeExtension

// desktopReintegrateFn re-points the Linux .desktop entry and ~/.local/bin
// symlink at the moved install root (both hold absolute paths).
var desktopReintegrateFn = desktop.ReintegrateLinux

// rkHomeGOOS gates the Linux-only desktop leg. A seam var (not runtime.GOOS
// inline) so tests exercise both platforms deterministically — the desktopGOOS
// idiom in cmd/rk/desktop.go.
var rkHomeGOOS = runtime.GOOS

// RKTenant is one fixed-name ~/.rk entry the move relocates: Src is its name
// under ~/.rk, Dst its path relative to the state home.
type RKTenant struct {
	Src, Dst string
	// CodeServer marks the code-server install and profile, which move only
	// once the rk-code-server session is down.
	CodeServer bool
	// LinuxOnly marks the Linux desktop install root (macOS installs to
	// /Applications, never ~/.rk).
	LinuxOnly bool
}

// RKTenants lists the fixed-name ~/.rk tenants in move order; top-level *.log
// files move to logs/<name> separately. rk doctor's ~/.rk row reads the same
// table, so a tenant added here is reported there too.
var RKTenants = []RKTenant{
	{Src: "vapid.json", Dst: "vapid.json"},
	{Src: "push-subscriptions.json", Dst: "push-subscriptions.json"},
	{Src: "code-server-bin", Dst: filepath.Join("code-server", "bin"), CodeServer: true},
	{Src: "code-server-profile", Dst: filepath.Join("code-server", "profile"), CodeServer: true},
	// The pre-260813 profile path folds into the same destination — moved
	// only when code-server-profile is absent.
	{Src: legacyProfileName, Dst: filepath.Join("code-server", "profile"), CodeServer: true},
	{Src: "desktop", Dst: "desktop", LinuxOnly: true},
}

// legacyProfileName is the pre-260813 code-server profile dir under ~/.rk.
const legacyProfileName = "code-server"

// MoveRKTenants moves every remaining ~/.rk tenant into the hexokit state
// home. A nil logger uses slog.Default.
func MoveRKTenants(logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	if settings.ConfigRootOverridden() {
		logger.Debug("~/.rk move skipped: " + settings.ConfigDirEnv + " isolates the run")
		return
	}
	// The target is always the NEW state home, never the resolved one: moving
	// into a legacy run-kit dir would strand the tenants where change lwt6
	// deletes.
	newState, err := apphome.NewStateDir()
	if err != nil {
		logger.Warn("~/.rk move skipped: state home unresolvable", "err", err)
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		logger.Warn("~/.rk move skipped: home unresolvable", "err", err)
		return
	}
	rkDir := filepath.Join(home, ".rk")
	if !exists(rkDir) {
		return
	}
	if !isDir(newState) {
		// A legacy run-kit state home still standing means the state-home
		// migration did not run or failed — defer to it (only its atomic
		// publish may create the new dir while the legacy one is active).
		// With no legacy home there is nothing to defer for: the new consumers
		// resolve to the new dir either way and would seed fresh state (a new
		// VAPID keypair) that strands the ~/.rk tenants behind the
		// never-overwrite rule, so the move creates the home itself.
		if legacy, err := apphome.LegacyStateDir(); err == nil && isDir(legacy) {
			logger.Warn("~/.rk move skipped: the hexokit state home does not exist (the state-home migration did not run this boot)", "path", newState)
			return
		}
		if err := os.MkdirAll(newState, 0o700); err != nil {
			logger.Warn("~/.rk move skipped: creating the hexokit state home failed", "path", newState, "err", err)
			return
		}
	}
	progress := moveProgressWriter{logger: logger}

	// The rk-code-server session survives daemon restarts and keeps running
	// from the old paths, so it goes down before its install or profile moves.
	// If it cannot be stopped, the code-server tenants stay put this boot — a
	// live profile moved out from under code-server would split its writes.
	codeServerDown := true
	for _, t := range RKTenants {
		if t.CodeServer && exists(filepath.Join(rkDir, t.Src)) {
			if _, err := killCodeServerFn(); err != nil {
				logger.Warn("~/.rk move: stopping the code-server session failed; leaving the code-server install and profile in place this boot", "err", err)
				codeServerDown = false
			}
			break
		}
	}
	hasProfile := exists(filepath.Join(rkDir, "code-server-profile"))
	for _, t := range RKTenants {
		switch {
		case t.CodeServer && !codeServerDown,
			t.LinuxOnly && rkHomeGOOS != "linux",
			t.Src == legacyProfileName && hasProfile:
			continue
		}
		src, dst := filepath.Join(rkDir, t.Src), filepath.Join(newState, t.Dst)
		if !exists(src) {
			continue
		}
		moveTenant(logger, src, dst)
		// The desktop integration holds absolute paths into the install root,
		// so it is regenerated whenever the new root is there to point at.
		if t.LinuxOnly && isDir(dst) {
			desktopReintegrateFn(context.Background(), dst, progress)
		}
	}
	entries, err := os.ReadDir(rkDir)
	if err != nil {
		logger.Warn("~/.rk move: listing ~/.rk failed", "err", err)
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".log") {
			continue
		}
		moveTenant(logger, filepath.Join(rkDir, e.Name()), filepath.Join(newState, "logs", e.Name()))
	}
	// Breadcrumbs from the earlier ~/.rk → ~/.config/run-kit migration serve
	// no further purpose; everything else left in ~/.rk is the user's.
	for _, crumb := range []string{"settings.yaml.migrated", "tmux.d.migrated"} {
		p := filepath.Join(rkDir, crumb)
		if !exists(p) {
			continue
		}
		if err := os.RemoveAll(p); err != nil {
			logger.Warn("~/.rk move: removing the migration breadcrumb failed", "path", p, "err", err)
		}
	}

	// The bridge extension is reinstalled from the bundled VSIX against the
	// managed binary at its new path, so the extension comes up on a version
	// that resolves the hexokit state home. No respawn here — the daemon
	// start's ensureCodeServer respawns the session from the new paths.
	if codeserver.ManagedBinary(home) == "" {
		logger.Debug("~/.rk move: no managed code-server binary at the new path; skipping the bridge extension install")
	} else if vsix, version, ok := codeBridgeEmbeddedFn(); !ok {
		logger.Debug("~/.rk move: no bundled code-bridge VSIX; skipping the bridge extension install")
	} else if _, err := installBridgeExtensionFn(context.Background(), home, vsix, version, progress); err != nil {
		logger.Warn("~/.rk move: code-bridge extension install failed; the next code-server install/update retries", "err", err)
	}

	// One prune per managed-install root: no flip history exists here, so the
	// keep set is current + the highest version below it.
	versionprune.Prune(filepath.Join(newState, "code-server", "bin"), "", logger)
	if rkHomeGOOS == "linux" {
		if deskRoot := filepath.Join(newState, "desktop"); isDir(deskRoot) {
			versionprune.Prune(deskRoot, "", logger)
		}
	}

	entries, err = os.ReadDir(rkDir)
	if err != nil {
		logger.Warn("~/.rk move: listing ~/.rk failed", "err", err)
		return
	}
	if len(entries) == 0 {
		if err := os.Remove(rkDir); err != nil {
			logger.Warn("~/.rk move: removing the empty ~/.rk failed", "err", err)
		} else {
			logger.Info("~/.rk move: ~/.rk is empty after the move; removed")
		}
		return
	}
	writeMovedNote(logger, rkDir, newState)
}

// moveTenant moves one ~/.rk tenant to dst: rename first; on EXDEV a
// mode-preserving, symlink-verbatim copy that is verified before the source is
// removed. An existing destination wins (never overwrite): the source stays in
// place and the conflict is warned. Returns true when dst now holds the
// tenant.
func moveTenant(logger *slog.Logger, src, dst string) bool {
	if !exists(src) {
		return false
	}
	if exists(dst) {
		logger.Warn("~/.rk move: destination exists; leaving the source in place (never overwrite)", "src", src, "dst", dst)
		return false
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		logger.Warn("~/.rk move: creating the destination parent failed; leaving the source in place", "src", src, "dst", dst, "err", err)
		return false
	}
	err := renameFn(src, dst)
	if err == nil {
		logger.Info("~/.rk move: moved", "from", src, "to", dst)
		return true
	}
	if !errors.Is(err, syscall.EXDEV) {
		logger.Warn("~/.rk move: rename failed; leaving the source in place", "src", src, "dst", dst, "err", err)
		return false
	}
	// Cross-device ($XDG_STATE_HOME on another volume): copy, verify, remove.
	if err := copyTree(src, dst, logger); err != nil {
		_ = os.RemoveAll(dst)
		logger.Warn("~/.rk move: cross-device copy failed; leaving the source in place", "src", src, "dst", dst, "err", err)
		return false
	}
	if err := verifyTree(src, dst); err != nil {
		_ = os.RemoveAll(dst)
		logger.Warn("~/.rk move: cross-device copy did not verify; leaving the source in place", "src", src, "dst", dst, "err", err)
		return false
	}
	if err := os.RemoveAll(src); err != nil {
		logger.Warn("~/.rk move: copy verified but removing the source failed; both copies exist", "src", src, "err", err)
	}
	logger.Info("~/.rk move: moved (cross-device copy)", "from", src, "to", dst)
	return true
}

// copyTree copies the file, symlink, or dir at src to dst (which must not
// exist), preserving modes. Symlinks are recreated VERBATIM — never followed,
// never rewritten: the tree moves as a unit (code-server-bin's relative
// `current` link keeps pointing at its sibling version dir). Special files
// are skipped, matching copyChildren's posture.
func copyTree(src, dst string, logger *slog.Logger) error {
	fi, err := os.Lstat(src)
	if err != nil {
		return err
	}
	switch {
	case fi.Mode()&os.ModeSymlink != 0:
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(target, dst)
	case fi.IsDir():
		if err := os.Mkdir(dst, fi.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyTree(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name()), logger); err != nil {
				return err
			}
		}
		return nil
	case fi.Mode().IsRegular():
		data, err := os.ReadFile(src)
		if err != nil {
			return err
		}
		return os.WriteFile(dst, data, fi.Mode().Perm())
	default:
		logger.Debug("~/.rk move: skipping special file in cross-device copy", "path", src, "mode", fi.Mode().String())
		return nil
	}
}

// treeEntry is one indexed tree node for the copy verification: kind ("dir",
// "file", "link") plus the size for files and the verbatim target for links.
type treeEntry struct {
	kind   string
	size   int64
	target string
}

// verifyTree checks a cross-device copy before the source is removed: both
// trees must hold the same set of relative paths (special files excluded,
// matching copyTree's skip), with equal file sizes and equal symlink targets.
func verifyTree(src, dst string) error {
	a, err := indexTree(src)
	if err != nil {
		return err
	}
	b, err := indexTree(dst)
	if err != nil {
		return err
	}
	if len(a) != len(b) {
		return fmt.Errorf("entry count differs: source %d, copy %d", len(a), len(b))
	}
	for rel, ea := range a {
		eb, ok := b[rel]
		if !ok {
			return fmt.Errorf("copy is missing %s", rel)
		}
		if ea != eb {
			return fmt.Errorf("copy of %s differs from the source", rel)
		}
	}
	return nil
}

func indexTree(root string) (map[string]treeEntry, error) {
	out := map[string]treeEntry{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
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
		case d.Type()&os.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			out[rel] = treeEntry{kind: "link", target: target}
		case d.IsDir():
			out[rel] = treeEntry{kind: "dir"}
		case d.Type().IsRegular():
			info, err := d.Info()
			if err != nil {
				return err
			}
			out[rel] = treeEntry{kind: "file", size: info.Size()}
		default:
			// Special file: copyTree skipped it too, so it indexes on neither side.
		}
		return nil
	})
	return out, err
}

// writeMovedNote leaves MOVED.md in a non-empty ~/.rk, skipping the rewrite
// when the identical note is already there (a second boot after the user kept
// the folder must not touch mtime).
func writeMovedNote(logger *slog.Logger, rkDir, newState string) {
	p := filepath.Join(rkDir, "MOVED.md")
	content := movedNote(newState)
	if data, err := os.ReadFile(p); err == nil && string(data) == content {
		return
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		logger.Warn("~/.rk move: writing MOVED.md failed", "path", p, "err", err)
	}
}

func movedNote(newState string) string {
	return fmt.Sprintf(`# This folder has moved

rk now keeps exactly two homes:

- **Config:** `+"`~/.config/hexokit/`"+` — config.yaml, tmux.conf, tmux.d/
- **State:** `+"`%s/`"+` — everything that used to live here

## What moved where

| Was | Now |
|---|---|
| `+"`~/.rk/vapid.json`"+` | `+"`%[1]s/vapid.json`"+` |
| `+"`~/.rk/push-subscriptions.json`"+` | `+"`%[1]s/push-subscriptions.json`"+` |
| `+"`~/.rk/code-server-bin/`"+` | `+"`%[1]s/code-server/bin/`"+` |
| `+"`~/.rk/code-server-profile/`"+` (and the older `+"`~/.rk/code-server/`"+`) | `+"`%[1]s/code-server/profile/`"+` |
| `+"`~/.rk/*.log`"+` | `+"`%[1]s/logs/`"+` |
| `+"`~/.rk/desktop/`"+` (Linux) | `+"`%[1]s/desktop/`"+` |

## The port pin

A `+"`port:`"+` line in `+"`~/.config/hexokit/config.yaml`"+` pins the daemon to the pre-rename
port %[2]d; fresh installs use the new default %[3]d. You may delete that line
to adopt %[3]d — but the port is part of the address, so everything tied to
`+"`http://127.0.0.1:%[2]d`"+` starts over or breaks:

- desktop `+"`hosts.json`"+` entries stored as `+"`http://127.0.0.1:%[2]d`"+`
- per-viewer `+"`localStorage`"+` preferences, PWA installs and Web Push
  subscriptions are scoped to the old address and start empty
- a `+"`tailscale serve`"+` or reverse proxy forwarding to `+"`:%[2]d`"+`
- bookmarks

## What remains here

Whatever is left in this folder is yours — e.g. a hand-edited `+"`tmux.conf`"+` or
a not-yet-migrated `+"`settings.yaml`"+` — and was deliberately left in place.
Once you have handled those files, this folder is safe to delete.
`, newState, portpolicy.DaemonLegacy, portpolicy.DaemonDefault)
}

// moveProgressWriter routes the desktop-integration and extension-install
// chatter into the daemon log: warnings stay warnings, notes go to debug.
type moveProgressWriter struct {
	logger *slog.Logger
}

func (w moveProgressWriter) Write(p []byte) (int, error) {
	msg := strings.TrimSpace(string(p))
	if msg == "" {
		return len(p), nil
	}
	if strings.HasPrefix(msg, "warning:") {
		w.logger.Warn("~/.rk move", "detail", msg)
	} else {
		w.logger.Debug("~/.rk move", "detail", msg)
	}
	return len(p), nil
}
