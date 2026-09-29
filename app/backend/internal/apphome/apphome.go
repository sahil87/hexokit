// Package apphome owns the on-disk home directory names and their resolution:
// the config root ($HOME/.config/<name>) and the state root
// (${XDG_STATE_HOME:-$HOME/.local/state}/<name>). Every consumer resolves
// through this package so the rules can never drift apart.
//
// The config root is fixed under $HOME — never $XDG_CONFIG_HOME, never
// os.UserConfigDir: rk runs as daemon + CLI + agents-in-panes, and an
// env-dependent path would silently fork which file each context reads. The
// state root follows the XDG rule with the ~/.local/state fallback.
//
// Both homes apply the same dual-read rule for one release after the
// run-kit → hexokit rename: the new dir when it exists (migrated or fresh
// install), else the legacy dir when it exists (an existing install that has
// not migrated yet), else the new dir. Nothing but the migration's atomic
// publish may create the new dir while the legacy dir is the active one, so
// "new dir exists" needs no marker file.
package apphome

import (
	"os"
	"path/filepath"
)

const (
	// Name is the current home dir name.
	Name = "hexokit"
	// LegacyName is the pre-rename home dir name, dual-read for one release.
	LegacyName = "run-kit"
)

// ConfigDir resolves the active config home: $HOME/.config/<resolved> per the
// dual-read rule. Only $HOME moves the root.
func ConfigDir() (string, error) {
	root, err := configRoot()
	if err != nil {
		return "", err
	}
	return resolve(root), nil
}

// StateDir resolves the active state home:
// ${XDG_STATE_HOME:-$HOME/.local/state}/<resolved> per the dual-read rule.
func StateDir() (string, error) {
	root, err := stateRoot()
	if err != nil {
		return "", err
	}
	return resolve(root), nil
}

// UnmigratedExistingInstall reports whether this is a pre-rename install that
// has not migrated yet: the new config dir is absent AND (the legacy config
// dir OR the legacy state dir exists). This is the ONE existing-install test
// both port pins share — the home migration's pin decision and config's
// virtual pin — so the two can never disagree about whether an install keeps
// the legacy default port. (Keying on the config home alone would miss the
// state-only install, whose config home the migration creates with a pin.)
func UnmigratedExistingInstall() bool {
	if newCfg, err := NewConfigDir(); err != nil || isDir(newCfg) {
		return false
	}
	if legacyCfg, err := LegacyConfigDir(); err == nil && isDir(legacyCfg) {
		return true
	}
	if legacyState, err := LegacyStateDir(); err == nil && isDir(legacyState) {
		return true
	}
	return false
}

// NewConfigDir / LegacyConfigDir / NewStateDir / LegacyStateDir return the
// fixed per-name homes (no resolution) — the migration's copy sources and
// publish targets.
func NewConfigDir() (string, error) {
	root, err := configRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, Name), nil
}

func LegacyConfigDir() (string, error) {
	root, err := configRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, LegacyName), nil
}

func NewStateDir() (string, error) {
	root, err := stateRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, Name), nil
}

func LegacyStateDir() (string, error) {
	root, err := stateRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, LegacyName), nil
}

// configRoot is the fixed config parent: $HOME/.config (see the package doc —
// never $XDG_CONFIG_HOME).
func configRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config"), nil
}

// stateRoot is the XDG state parent: $XDG_STATE_HOME when set, else
// $HOME/.local/state.
func stateRoot() (string, error) {
	if v := os.Getenv("XDG_STATE_HOME"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "state"), nil
}

// resolve applies the dual-read rule under root: new when it exists, else
// legacy when it exists, else new.
func resolve(root string) string {
	newDir := filepath.Join(root, Name)
	if isDir(newDir) {
		return newDir
	}
	legacy := filepath.Join(root, LegacyName)
	if isDir(legacy) {
		return legacy
	}
	return newDir
}

// isDir reports whether path exists as a directory. Any stat failure —
// absence, a dangling symlink, an ENOTDIR under a file-shaped parent — reads
// as "not the home", so a regular file sitting at a home path never claims
// the name.
func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
