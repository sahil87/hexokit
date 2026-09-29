// Package remote implements the SSH-only remote-host subsystem behind the
// `rk remote` command family: the remotes.yaml registration store, local-port
// assignment from the tunnel range reserved by internal/portpolicy/ports.env
// (portpolicy.Tunnel), ssh probe/bootstrap helpers, and the tunnel-in-tmux
// lifecycle (socket rk-daemon, sibling session rk-remotes, one window per
// remote).
//
// Posture (Constitution II): the store persists ONLY the genuinely
// underivable-when-disconnected state — name, verbatim ssh target, assigned
// local port. Everything else (tunnel up/down, remote daemon state, remote
// port, version skew) is derived at request time from tmux and ssh probes.
// No pid files, no supervisor, no auto-reconnect.
//
// Security (Constitution I): every subprocess call goes through
// exec.CommandContext with argument slices and timeouts; remote command
// strings are fixed literals (never interpolated); names and targets are
// validated via internal/validate on BOTH sides of the store — at add-time
// (the write path) and again in Load (the read path), because remotes.yaml
// is user-editable and stored values flow into ssh/tmux argv.
package remote

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"

	"rk/internal/fsatomic"
	"rk/internal/validate"
)

// SessionName is the tmux session holding tunnel windows — a sibling of the
// rk-daemon session on the same rk-daemon socket (daemon.ServerSocket), so it
// is invisible to the dashboard's user-session enumeration and independent of
// `kill-session =rk-daemon` (daemon stop never kills tunnels).
const SessionName = "rk-remotes"

// storeVersion is the remotes.yaml schema version this package reads/writes.
const storeVersion = 1

// Remote is one registered SSH-only remote host.
type Remote struct {
	// Name is the display name, tmux tunnel window name, and lookup key.
	Name string `yaml:"name"`
	// Target is the verbatim ssh argument — a ~/.ssh/config alias or a
	// user@host form. Never parsed for connection purposes.
	Target string `yaml:"target"`
	// LocalPort is the stable local tunnel port, assigned once at add-time
	// from the range reserved by internal/portpolicy/ports.env
	// (portpolicy.Tunnel) and immutable thereafter (a stable port keeps
	// per-origin browser state and the desktop shell's persistent view
	// identity across launches).
	LocalPort int `yaml:"local_port"`
}

// Origin returns the stable local origin the tunnel serves.
func (r Remote) Origin() string {
	return fmt.Sprintf("http://127.0.0.1:%d", r.LocalPort)
}

// File is the remotes.yaml document (schema version 1).
type File struct {
	Version int      `yaml:"version"`
	Remotes []Remote `yaml:"remotes"`
}

// emptyFile returns a fresh version-1 document.
func emptyFile() File {
	return File{Version: storeVersion}
}

// DefaultPath returns the canonical store path, ~/.config/rk/remotes.yaml.
func DefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return filepath.Join(home, ".config", "rk", "remotes.yaml"), nil
}

// Load reads the store at path. A missing file is an empty version-1 list;
// malformed YAML or an unknown schema version is an error (never silently
// rewritten — the file is user-visible state).
func Load(path string) (File, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return emptyFile(), nil
	}
	if err != nil {
		return File{}, fmt.Errorf("reading %s: %w", path, err)
	}
	var f File
	if err := yaml.Unmarshal(data, &f); err != nil {
		return File{}, fmt.Errorf("parsing %s: %w", path, err)
	}
	if f.Version != storeVersion {
		return File{}, fmt.Errorf("%s: unsupported version %d (this rk understands version %d)", path, f.Version, storeVersion)
	}
	if err := validateEntries(path, f); err != nil {
		return File{}, err
	}
	return f, nil
}

// validateEntries enforces Constitution I on the READ path: remotes.yaml is a
// user-editable input boundary, and every verb passes stored names into tmux
// argv and stored targets into ssh argv. Add-time validation alone would let
// a hand-edited entry (e.g. a `-oProxyCommand=…` target) reach a subprocess,
// so Load — the single seam every verb goes through — re-validates each entry
// and rejects the file before any stored value can be used.
func validateEntries(path string, f File) error {
	for _, r := range f.Remotes {
		if msg := validate.ValidateRemoteName(r.Name); msg != "" {
			return fmt.Errorf("%s: remote name %q is invalid (%s) — fix or remove the entry by hand", path, r.Name, msg)
		}
		if msg := validate.ValidateRemoteTarget(r.Target); msg != "" {
			return fmt.Errorf("%s: remote %q has an invalid target %q (%s) — fix or remove the entry by hand", path, r.Name, r.Target, msg)
		}
		if r.LocalPort < PortRangeStart || r.LocalPort > PortRangeEnd {
			return fmt.Errorf("%s: remote %q has local_port %d outside the reserved range %d-%d — fix or remove the entry by hand", path, r.Name, r.LocalPort, PortRangeStart, PortRangeEnd)
		}
	}
	return nil
}

// Save writes the store atomically (fsatomic.WriteFile: tmp file in the
// target directory + rename, atomic on POSIX). Creates the parent directory
// when absent.
func Save(path string, f File) error {
	f.Version = storeVersion
	data, err := yaml.Marshal(f)
	if err != nil {
		return fmt.Errorf("serializing remotes: %w", err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	if err := fsatomic.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

// FindByName returns the entry with the exact given name, or nil.
func (f File) FindByName(name string) *Remote {
	for i := range f.Remotes {
		if f.Remotes[i].Name == name {
			return &f.Remotes[i]
		}
	}
	return nil
}

// FindByTarget returns the entry with the exact verbatim target, or nil.
func (f File) FindByTarget(target string) *Remote {
	for i := range f.Remotes {
		if f.Remotes[i].Target == target {
			return &f.Remotes[i]
		}
	}
	return nil
}

// Find resolves a name-or-target reference: name match wins, then target
// match. Returns nil when neither matches.
func (f File) Find(nameOrTarget string) *Remote {
	if r := f.FindByName(nameOrTarget); r != nil {
		return r
	}
	return f.FindByTarget(nameOrTarget)
}

// Remove drops the named entry, returning the updated file and whether an
// entry was removed.
func (f File) Remove(name string) (File, bool) {
	out := File{Version: f.Version}
	removed := false
	for _, r := range f.Remotes {
		if r.Name == name {
			removed = true
			continue
		}
		out.Remotes = append(out.Remotes, r)
	}
	return out, removed
}
