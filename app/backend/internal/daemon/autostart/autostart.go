// Package autostart registers the rk daemon with the OS's per-user service
// manager so it starts once at boot or login — never supervised, never
// restarted (fab/plans/sahil/26-11-11-rk-daemon-autostart.md).
//
// This file is the platform-neutral surface shared by every backend. Each
// backend lives in its own file and self-registers from init() through
// Register, so this file never names a backend symbol and each one compiles
// and tests on any host (no build tags; backends gate on the GOOS the CLI
// passes to For, not on the build target).
package autostart

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"rk/internal/selfpath"
	"rk/internal/shellq"
)

// ManagedMarker is written as a comment into every file a backend generates.
// Off refuses to delete a file at the backend's path that lacks it, so a
// hand-written unit or plist with the same name is never removed.
const ManagedMarker = "Managed by rk daemon autostart"

// Starts-at values for Status.StartsAt.
const (
	StartsAtBoot  = "boot"
	StartsAtLogin = "login"
)

// Summary strings returned by Status.Summary; the CLI status text, `rk
// doctor` and the Host page's system card print them verbatim.
const (
	SummaryOnBoot    = "on (boot)"
	SummaryOnLogin   = "on (login)"
	SummaryLoginOnly = "on (login only — enable lingering for boot)"
	SummaryDisabled  = "registered but disabled"
	SummaryOff       = "off"
)

// OnOptions carries the flags of `rk daemon autostart on`.
type OnOptions struct {
	// Now also starts the daemon through the service manager right away.
	// Without it, On only registers; the daemon starts at the next boot or
	// login. Starting is idempotent because the start command runs
	// `rk daemon start --if-not-running`.
	Now bool
}

// Result reports what On or Off did.
type Result struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// Changed is false when the registration was already in the requested
	// state — how an idempotent re-run says "already on" / "already off".
	Changed bool `json:"changed"`
	// Started is true when On --now asked the service manager to run the job.
	Started bool     `json:"started"`
	Hints   []string `json:"hints,omitempty"`
}

// Status is the report of `rk daemon autostart status`.
type Status struct {
	Platform   string `json:"platform"`
	Manager    string `json:"manager"`
	Name       string `json:"name"`
	Path       string `json:"path"`
	Registered bool   `json:"registered"`
	Enabled    bool   `json:"enabled"`
	// StartsAt is StartsAtBoot or StartsAtLogin when registered, else "".
	StartsAt string `json:"starts_at"`
	// Linger is the systemd lingering state; nil on platforms without it.
	Linger *bool `json:"linger,omitempty"`
	// LastExitCode is nil when the job has never run or the manager cannot
	// tell.
	LastExitCode *int   `json:"last_exit_code"`
	LastResult   string `json:"last_result,omitempty"`
	// RKPath and Shell are what On would write now.
	RKPath string `json:"rk_path"`
	Shell  string `json:"shell"`
	// Stale is true when the registered file differs from what On would write
	// now (the rk path moved, the login shell changed); re-running On fixes it.
	Stale bool     `json:"stale"`
	Hints []string `json:"hints,omitempty"`
}

// Summary is the one-line autostart state. It reads only Status fields, never
// the platform: the lingering advice keys off Linger being known and off, so a
// backend without lingering (Linger nil) reads plain "on (login)".
func (s Status) Summary() string {
	switch {
	case s.Registered && s.Enabled && s.StartsAt == StartsAtBoot:
		return SummaryOnBoot
	case s.Registered && s.Enabled && s.StartsAt == StartsAtLogin && s.Linger != nil && !*s.Linger:
		return SummaryLoginOnly
	case s.Registered && s.Enabled:
		return SummaryOnLogin
	case s.Registered:
		return SummaryDisabled
	default:
		return SummaryOff
	}
}

// Backend is one OS service manager's implementation of the three verbs.
// Every method is idempotent; Off never stops a running daemon.
type Backend interface {
	On(ctx context.Context, opts OnOptions) (Result, error)
	Off(ctx context.Context) (Result, error)
	Status(ctx context.Context) (Status, error)
}

var registry = map[string]func() Backend{}

// Register installs the backend constructor for a GOOS value. Backends call
// it from init(); a second registration for the same GOOS panics.
func Register(goos string, ctor func() Backend) {
	if _, dup := registry[goos]; dup {
		panic("autostart: duplicate backend for " + goos)
	}
	registry[goos] = ctor
}

// For returns a fresh backend for goos, or an error naming the platform when
// none is registered.
func For(goos string) (Backend, error) {
	ctor, ok := registry[goos]
	if !ok {
		return nil, fmt.Errorf("daemon autostart is not supported on %s (supported: %s)", goos, strings.Join(supported(), ", "))
	}
	return ctor(), nil
}

func supported() []string {
	out := make([]string, 0, len(registry))
	for goos := range registry {
		out = append(out, goos)
	}
	sort.Strings(out)
	return out
}

// RKPath is the absolute rk path a registration should run: the path that
// survives `brew upgrade` (the brew-prefix symlink, never the Cellar keg).
func RKPath() (string, error) {
	return selfpath.Stable()
}

// StartScript renders the command a backend hands to the user's login shell
// (`<shell> -lc <script>`). It execs `rk daemon start --if-not-running`, so a
// daemon that is already up reads as success and every other failure stays
// visible as the job's exit status. unsetEnv names variables the service
// manager injects that must not leak into the daemon's tmux server (and so
// into every agent); the `env -u` prefix is omitted when it is empty. Only
// the variable names and the path are quoted — `exec` stays a bare word so
// fish still parses it as its exec builtin — and the POSIX quoting shellq
// emits is also valid in fish, so bash, zsh and fish all accept the script.
func StartScript(rkPath string, unsetEnv []string) string {
	var b strings.Builder
	b.WriteString("exec ")
	if len(unsetEnv) > 0 {
		b.WriteString("env ")
		for _, v := range unsetEnv {
			b.WriteString("-u " + shellq.Quote(v) + " ")
		}
	}
	b.WriteString(shellq.Quote(rkPath) + " daemon start --if-not-running")
	return b.String()
}
