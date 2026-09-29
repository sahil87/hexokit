// Package homemigrate performs the one-time run-kit → hexokit home
// migration. For each home (config, state) where the legacy dir exists and
// the new one does not, it copies the migrated set into a temp sibling and
// publishes with a single rename(2), so "new dir exists" is the migration
// marker — no marker file, and a crash mid-copy leaves at most a temp dir,
// never a half-formed home.
//
// Everything here is best-effort and non-fatal: any failure logs a warning,
// removes the temp dir, and leaves the legacy home authoritative (the
// apphome dual-read rule still resolves it). The legacy trees are left
// byte-unchanged so a downgrade keeps working. The migration runs at release
// daemon start only (the dev-build gate lives at the call site); it is
// skipped entirely under the RK_CONFIG_DIR test override — an isolated run
// must never write the real $HOME.
package homemigrate

import (
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"rk/internal/apphome"
	"rk/internal/gui"
	"rk/internal/portpolicy"
	"rk/internal/settings"
)

// tempPrefix names the staging sibling next to each publish target
// (<parent>/.hexokit-migrate-<rand>).
const tempPrefix = ".hexokit-migrate-"

// stateCopySet is the state home's allowlist of dirs copied wholesale: cron
// entries are user intent and snapshots are recovery backups, so both must
// move. The GUI's write-once seeded files (gui.WriteOnceSeedFiles — the
// user-editable icewm preferences and LXQt etc defaults) move too, one file
// at a time. Everything else in the legacy state home (prstatus.json, the
// regenerated gui/ files, sockets, CDP profiles, code/, cb/,
// opencode-export/) is a droppable cache or runtime rendezvous and
// cold-starts.
var stateCopySet = []string{"cron", "snapshots"}

// renameFn is the os.Rename seam for the race-loser test.
var renameFn = os.Rename

// Migrate runs both home migrations. A nil logger uses slog.Default.
func Migrate(logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	if settings.ConfigRootOverridden() {
		logger.Debug("home migration skipped: " + settings.ConfigDirEnv + " isolates the run")
		return
	}
	migrateConfigHome(logger, apphome.UnmigratedExistingInstall())
	migrateStateHome(logger)
}

// migrateConfigHome publishes the new config home from the legacy one (whole
// tree) plus the port pin. A state-only existing install (no legacy config
// dir) gets a config home holding just the pin, through the same
// temp + rename publish. The existing-install test is
// apphome.UnmigratedExistingInstall — the same predicate config's virtual pin
// uses, so the two pins can never disagree.
func migrateConfigHome(logger *slog.Logger, existing bool) {
	legacy, err := apphome.LegacyConfigDir()
	if err != nil {
		logger.Warn("config home migration skipped: legacy dir unresolvable", "err", err)
		return
	}
	newDir, err := apphome.NewConfigDir()
	if err != nil {
		logger.Warn("config home migration skipped: new dir unresolvable", "err", err)
		return
	}
	if exists(newDir) {
		return // migrated or fresh install already on the new home — never a pin
	}
	legacyPresent := isDir(legacy)
	if !legacyPresent && !existing {
		return // fresh install: nothing to copy, no pin
	}

	temp, err := stage(newDir)
	if err != nil {
		logger.Warn("config home migration failed; legacy home stays active", "err", err)
		return
	}
	if legacyPresent {
		if err := copyChildren(legacy, temp, legacy, logger); err != nil {
			abort(logger, temp, "config", err)
			return
		}
	}
	if err := applyPortPin(temp); err != nil {
		abort(logger, temp, "config", err)
		return
	}
	publish(logger, temp, newDir, "config")
}

// migrateStateHome publishes the new state home holding only the copy set
// (cron/, snapshots/, and the GUI's write-once seeded files).
func migrateStateHome(logger *slog.Logger) {
	legacy, err := apphome.LegacyStateDir()
	if err != nil {
		logger.Warn("state home migration skipped: legacy dir unresolvable", "err", err)
		return
	}
	newDir, err := apphome.NewStateDir()
	if err != nil {
		logger.Warn("state home migration skipped: new dir unresolvable", "err", err)
		return
	}
	if exists(newDir) || !isDir(legacy) {
		return
	}

	temp, err := stage(newDir)
	if err != nil {
		logger.Warn("state home migration failed; legacy home stays active", "err", err)
		return
	}
	for _, leaf := range stateCopySet {
		src := filepath.Join(legacy, leaf)
		fi, err := os.Lstat(src)
		if err != nil || !fi.IsDir() {
			continue // only dirs migrate; a file-shaped leaf cold-starts
		}
		dst := filepath.Join(temp, leaf)
		if err := os.Mkdir(dst, fi.Mode().Perm()); err != nil {
			abort(logger, temp, "state", err)
			return
		}
		if err := copyChildren(src, dst, src, logger); err != nil {
			abort(logger, temp, "state", err)
			return
		}
	}
	for _, rel := range gui.WriteOnceSeedFiles() {
		src := filepath.Join(legacy, "gui", rel)
		if _, err := os.Lstat(src); err != nil {
			continue // not seeded on this install — nothing to carry
		}
		if err := copySeedFile(src, filepath.Join(temp, "gui", rel)); err != nil {
			abort(logger, temp, "state", err)
			return
		}
	}
	publish(logger, temp, newDir, "state")
}

// copySeedFile copies one write-once seeded file (regular file or symlink) to
// dst, creating parents at 0700 — the seeders' own dir mode, never wider than
// the source. A symlink is carried over as a link with an absolute target: a
// relative target is rewritten to its absolute resolution because the file's
// neighborhood is not copied, so a verbatim relative link could dangle in the
// new home. Special files (a socket squatting at the path) are skipped.
func copySeedFile(src, dst string) error {
	fi, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		if !filepath.IsAbs(target) {
			target = filepath.Clean(filepath.Join(filepath.Dir(src), target))
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return err
		}
		return os.Symlink(target, dst)
	}
	if !fi.Mode().IsRegular() {
		return nil
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	return os.WriteFile(dst, data, fi.Mode().Perm())
}

// stage creates the temp sibling the copy is staged in. The parent is
// created first: a state-only install may have no $HOME/.config at all.
func stage(target string) (string, error) {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	return os.MkdirTemp(filepath.Dir(target), tempPrefix)
}

// abort discards a staged copy after a failure; the legacy home stays
// authoritative.
func abort(logger *slog.Logger, temp, home string, err error) {
	_ = os.RemoveAll(temp)
	logger.Warn("home migration failed; legacy home stays active", "home", home, "err", err)
}

// publish atomically renames the staged temp dir onto target. A target that
// appeared during the copy (a concurrent migrator won the race) wins: the
// temp copy is discarded and the existing target stays authoritative.
func publish(logger *slog.Logger, temp, target, home string) {
	if err := renameFn(temp, target); err != nil {
		_ = os.RemoveAll(temp)
		if exists(target) {
			logger.Info("home migration: concurrent publish won; existing target kept", "home", home, "target", target)
			return
		}
		logger.Warn("home migration publish failed; legacy home stays active", "home", home, "target", target, "err", err)
		return
	}
	logger.Info("home migration published", "home", home, "from", temp, "to", target)
}

// applyPortPin appends the rename pin (PortPinComment + `port:
// <DaemonLegacy>`) to the staged config.yaml unless the file already sets a
// port. The append is byte-preserving — no re-serialize, so the user's
// comments and ordering survive — and the value is always the legacy default,
// never RK_PORT (a transient env would be pinned permanently) and never
// DaemonDefault (it moves in the same release). A missing file gets the pin
// as its only content.
//
// When the staged config.yaml is a symlink (a dotfiles-managed config), the
// read and the append both go THROUGH the link into its target. That target
// is the user's one config file, shared by both homes after the publish; the
// pin is safe there because the still-running old binary reads `port: 3000`
// as its own default.
func applyPortPin(temp string) error {
	p := filepath.Join(temp, "config.yaml")
	data, err := os.ReadFile(p)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		data = nil
	}
	if settings.ParseBytes(data).Port != 0 {
		return nil // the user pinned a port already — leave the file untouched
	}
	if len(data) > 0 && data[len(data)-1] != '\n' {
		data = append(data, '\n')
	}
	data = append(data, settings.PortPinComment+"\nport: "+strconv.Itoa(portpolicy.DaemonLegacy)+"\n"...)
	return os.WriteFile(p, data, 0o644)
}

// copyChildren recursively copies the entries of src into the existing dst,
// preserving file modes and creating dirs no wider than the source (the
// 0700 cron/snapshot modes survive). Every symlink is carried over AS a link
// — never dereferenced into a copy, never dropped: a contained link (target
// resolves inside the legacy tree root) is recreated verbatim so it points
// into the new copy; an escaping link (a dotfiles-managed config.yaml or
// tmux.d/*.conf, per stow/chezmoi) is recreated pointing at the same
// absolute target, a relative target rewritten to its absolute resolution.
// Dropping such a link would silently lose the user's config — the exact
// regression this migration exists to prevent. Special files (sockets,
// fifos, devices) are skipped.
func copyChildren(src, dst, root string, logger *slog.Logger) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		fi, err := os.Lstat(s)
		if err != nil {
			return err
		}
		switch {
		case fi.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(s)
			if err != nil {
				return err
			}
			if !filepath.IsAbs(target) && !linkStaysInside(root, s, target) {
				// Escaping relative target: rewrite to its absolute resolution
				// (against the link's own directory) so the recreated link
				// still points at the same file from the new home.
				target = filepath.Clean(filepath.Join(filepath.Dir(s), target))
			}
			if err := os.Symlink(target, d); err != nil {
				return err
			}
		case fi.IsDir():
			if err := os.Mkdir(d, fi.Mode().Perm()); err != nil {
				return err
			}
			if err := copyChildren(s, d, root, logger); err != nil {
				return err
			}
		case fi.Mode().IsRegular():
			data, err := os.ReadFile(s)
			if err != nil {
				return err
			}
			if err := os.WriteFile(d, data, fi.Mode().Perm()); err != nil {
				return err
			}
		default:
			logger.Debug("home migration: skipping special file", "path", s, "mode", fi.Mode().String())
		}
	}
	return nil
}

// linkStaysInside reports whether a symlink target resolves to a path inside
// root (relative targets resolve against the link's own dir).
func linkStaysInside(root, linkPath, target string) bool {
	resolved := target
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(filepath.Dir(linkPath), target)
	}
	abs, err := filepath.Abs(resolved)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(root), abs)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// exists reports whether anything (any file type) sits at path.
func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// isDir reports whether path exists as a directory (symlinks to dirs count —
// the same posture as apphome's own resolution).
func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
