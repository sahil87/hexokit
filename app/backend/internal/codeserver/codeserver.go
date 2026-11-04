// Package codeserver owns the rk-managed code-server install: the versioned
// directory layout under <state>/code-server/bin (the apphome state home,
// ${XDG_STATE_HOME:-~/.local/state}/hexokit), GitHub release resolution, and
// the download-verify-extract-flip install flow. It has zero tmux coupling —
// the daemon (internal/daemon) and the CLI (cmd/rk) both consume it, mirroring
// the desktop-installer precedent (install engine as a library, callers stay
// thin).
//
// Layout (user-decided):
//
//	<state>/code-server/bin/<version>/   one extracted release per version
//	                                     dir, top-level tarball directory
//	                                     stripped, so the binary is
//	                                     <version>/bin/code-server
//	<state>/code-server/bin/current      symlink → <version>; activation is an
//	                                     atomic symlink flip (temp symlink +
//	                                     os.Rename), never a remove+recreate
//
// The layout is derived from the filesystem at call time (Constitution II) —
// InstalledVersion reads the current symlink's target; there is no registry.
package codeserver

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"rk/internal/apphome"
)

// currentLinkName is the symlink beside the version dirs pointing at the
// active version.
const currentLinkName = "current"

// BinDir is the managed-install root: <state>/code-server/bin, resolved
// through apphome. Its existence is the ownership signal — a host without it
// has a user-managed (or no) code-server, which rk never touches.
//
// home backstops only the degenerate case where the state home itself is
// unresolvable (XDG_STATE_HOME unset and $HOME missing — callers resolved home
// from that same environment, so the apphome path otherwise always wins); it
// keeps the result absolute rather than CWD-relative.
func BinDir(home string) string {
	if dir, err := apphome.CodeServerBinDir(); err == nil {
		return dir
	}
	return filepath.Join(home, ".local", "state", apphome.Name, "code-server", "bin")
}

// VersionDir is the install dir for one release version (no leading "v").
func VersionDir(home, version string) string {
	return filepath.Join(BinDir(home), version)
}

// CurrentPath is the activation symlink whose target names the active version.
func CurrentPath(home string) string {
	return filepath.Join(BinDir(home), currentLinkName)
}

// BinaryPath is the code-server entry script of the active managed install.
func BinaryPath(home string) string {
	return filepath.Join(CurrentPath(home), "bin", "code-server")
}

// InstalledVersion reads the active version from the current symlink's target
// basename. A missing symlink (nothing managed) yields ("", nil) — absence is
// a state, not an error; any other read failure is returned.
func InstalledVersion(home string) (string, error) {
	target, err := os.Readlink(CurrentPath(home))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return filepath.Base(target), nil
}

// ManagedBinary is the daemon's rung-1 resolution: the absolute binary path of
// the active managed install, verified to exist and be executable, or "" when
// no managed install is usable (the ladder then falls through to PATH).
func ManagedBinary(home string) string {
	path := BinaryPath(home)
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return ""
	}
	return path
}
