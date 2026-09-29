// Package selfpath resolves the running binary's own on-disk executable path and
// detects a Homebrew ("brew") install via its Cellar keg path. Both the CLI
// upgrade command (cmd/rk/upgrade.go) and the web update handler (api/update.go)
// share these so the brew-install detection cannot drift between the two entry
// points into the same self-upgrade behavior.
//
// Three resolvers, three audiences. Resolve names the binary that is actually
// running — the input brew detection needs (the Cellar keg) and the path the
// daemon's own respawn wants. Stable names the path that survives a
// `brew upgrade` as a whole: on a Homebrew install the old keg is deleted, so
// any process spawned to outlive this binary's version (a tmux session's argv,
// an RK_BIN env element, a shell chain) must carry the brew-prefix symlink
// instead. Launcher names the rk-owned symlink in the per-machine launcher
// directory; its target is the Cellar binary, which Homebrew deletes only in
// cleanup, AFTER the new keg is linked — so the launcher is live exactly during
// the unlink→install→link window in which the stable symlink dangles. Callers
// that must keep working mid-upgrade (the installed hook wrapper, code-server's
// RK_BIN) exec the launcher first and the stable path as fallback;
// LauncherOrStable codifies that ladder for single-path consumers.
package selfpath

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// BrewKegs are the Homebrew keg names a brew-installed binary can live under,
// primary first: the `hexokit` formula, then the pre-rename `run-kit` keg a
// binary may still occupy if brew's formula-rename migration left it in place.
// Each keg installs a brew-prefix symlink named after itself, which is what
// StableFor maps to. A daemon not installed via brew cannot self-upgrade
// through `brew upgrade`.
var BrewKegs = []string{"hexokit", "run-kit"}

// BrewFormula is the fully qualified formula `rk update` queries and upgrades,
// and the one install guidance names. Qualified because the shll toolkit
// always installs from the tap, never homebrew-core.
const BrewFormula = "sahil87/tap/hexokit"

// cellarKeg returns the index of the "/Cellar/<keg>/" segment in resolved and
// the matched keg, or -1 when resolved is not under any BrewKegs keg.
func cellarKeg(resolved string) (int, string) {
	for _, keg := range BrewKegs {
		if idx := strings.Index(resolved, "/Cellar/"+keg+"/"); idx != -1 {
			return idx, keg
		}
	}
	return -1, ""
}

// Resolve returns this binary's on-disk executable path, following symlinks. It
// is the default behind both upgrade.go's resolveExeFn and update.go's
// resolveSelfPathFn seams. When the symlink cannot be resolved it falls back to
// the raw os.Executable path rather than erroring.
func Resolve() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(exePath)
	if err != nil {
		resolved = exePath
	}
	return resolved, nil
}

// IsBrewInstalled reports whether the given resolved executable path is a
// Homebrew install (lives under a BrewKegs Cellar keg).
func IsBrewInstalled(resolvedPath string) bool {
	idx, _ := cellarKeg(resolvedPath)
	return idx != -1
}

// StableFor maps a resolved executable path to the path that survives a
// Homebrew upgrade. A Cellar path (…/Cellar/<keg>/<version>/bin/<name>) becomes
// the keg's own brew-prefix symlink <prefix>/bin/<keg>, which brew repoints on
// every upgrade; any other path is returned unchanged. Pure string derivation —
// it never stats the result, because during `brew upgrade` the stable symlink
// dangles for a moment and a stat-then-fallback would re-pin the Cellar path.
func StableFor(resolved string) string {
	idx, keg := cellarKeg(resolved)
	if idx == -1 {
		return resolved
	}
	return resolved[:idx] + "/bin/" + keg
}

// Stable is Resolve followed by StableFor: the path to hand to processes that
// outlive this binary's version (spawn argv, env such as RK_BIN, shell chains).
// Callers that need the real on-disk binary (brew detection, the daemon's own
// respawn) keep using Resolve.
func Stable() (string, error) {
	resolved, err := Resolve()
	if err != nil {
		return "", err
	}
	return StableFor(resolved), nil
}

// LauncherRelDir is the per-machine launcher directory relative to $HOME. It
// MUST stay off PATH: callers resolve the stable path with
// exec.LookPath("run-kit") first, so a launcher on PATH would resolve to itself
// on the next re-run and the link would loop.
const LauncherRelDir = ".local/share/rk/bin"

// LauncherFor returns the rk-owned launcher symlink path for a given home.
func LauncherFor(home string) string {
	return filepath.Join(home, filepath.FromSlash(LauncherRelDir), "run-kit")
}

// Launcher is LauncherFor(os.UserHomeDir()).
func Launcher() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return LauncherFor(home), nil
}

// LiveLauncherFor returns the launcher path for home when it is a live
// rk-owned pointer — a symlink (rk only ever places symlinks there; a regular
// file is the user's and never rk's) whose target currently resolves. An
// absent, foreign, or dangling launcher reports ok=false: `rk agent setup` is
// optional, and Homebrew's post-link cleanup deletes the old Cellar target, so
// neither presence nor liveness can be assumed.
func LiveLauncherFor(home string) (path string, ok bool) {
	p := LauncherFor(home)
	info, err := os.Lstat(p)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return "", false
	}
	if _, err := os.Stat(p); err != nil {
		return "", false
	}
	return p, true
}

// LauncherOrStable resolves the rk path for a long-lived consumer handed a
// single path (code-server's RK_BIN): the launcher when LiveLauncherFor
// accepts it, Stable otherwise. The launcher wins when live because its
// Cellar target survives the mid-upgrade window in which the stable symlink
// dangles; a missing/foreign/dangling launcher must not be exported, so the
// version-stable path is the floor.
func LauncherOrStable() (string, error) {
	if home, err := os.UserHomeDir(); err == nil {
		if p, ok := LiveLauncherFor(home); ok {
			return p, nil
		}
	}
	return Stable()
}

// ReplaceSymlink atomically points linkPath at target: the new symlink is
// created under a temporary name in the same directory and renamed over the
// old one, so no reader ever observes the path missing. Rename replaces an
// existing symlink in place on every platform rk runs on. The temp entry is
// removed on any failure, and temp SYMLINKS left by an earlier run that
// crashed between Symlink and Rename are swept first (only symlinks — a
// regular file under the temp pattern is not rk's).
func ReplaceSymlink(target, linkPath string) error {
	// Sweep temps left by a crashed earlier run — but only those whose owner
	// pid (the name suffix) is gone. Setup and the daemon's start-time re-point
	// can overlap, and removing a live process's fresh temp would fail its
	// Rename with ENOENT.
	prefix := "." + filepath.Base(linkPath) + ".tmp-"
	pattern := filepath.Join(filepath.Dir(linkPath), prefix+"*")
	if stale, _ := filepath.Glob(pattern); len(stale) > 0 {
		for _, p := range stale {
			fi, err := os.Lstat(p)
			if err != nil || fi.Mode()&os.ModeSymlink == 0 {
				continue
			}
			if owner, err := strconv.Atoi(strings.TrimPrefix(filepath.Base(p), prefix)); err == nil && owner != os.Getpid() && processAlive(owner) {
				continue
			}
			_ = os.Remove(p)
		}
	}
	tmp := filepath.Join(filepath.Dir(linkPath), fmt.Sprintf("%s%d", prefix, os.Getpid()))
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, linkPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// processAlive is the kill(pid, 0) liveness probe: no signal is sent. EPERM
// means the process exists but is not ours, which still counts as alive.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
