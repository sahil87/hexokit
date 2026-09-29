// Package desktop installs and updates the HexoKit desktop app (the Electron
// viewer shell, app/desktop) from GitHub release assets: the macOS DMG and
// the Linux AppImage.
//
// Why this exists: the desktop DMGs are ad-hoc signed (no notarization), so a
// browser download stamps com.apple.quarantine and Gatekeeper blocks the app
// on every install AND every update. Quarantine is applied by the DOWNLOADING
// application (via LSFileQuarantineEnabled) — browsers set it, plain
// command-line tools do not — so a Go program fetching over HTTPS produces a
// genuinely quarantine-free install. Because this code path deliberately
// bypasses Gatekeeper's own check, the installer performs the verification
// itself: SHA256 against the release digest (when the API supplies one) and
// `codesign --verify --deep --strict` on the mounted .app — both are hard
// gates that no flag can skip (see install.go). On Linux there is no codesign
// second gate, so the release digest is the ONLY verification and a missing
// digest refuses the install (see linux.go).
//
// The package is electron-free and fully seam-parameterized: an *http.Client
// for the GitHub API + asset download, and a Runner func for every subprocess
// (hdiutil, ditto, codesign, plutil, pgrep). Both are struct fields (not
// package vars) so parallel tests do not race — the same idiom as
// internal/updatecheck's checkFn. The whole flow unit-tests on Linux with an
// httptest server and a recorded runner; only the real end-to-end run needs a
// Mac.
package desktop

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const (
	// DefaultRepo is the GitHub repository the desktop DMGs are released from.
	DefaultRepo = "sahil87/hexokit"
	// AppBundleName is the installed bundle name (electron-builder's
	// productName "HexoKit" + .app).
	AppBundleName = "HexoKit.app"
	// legacyAppBundleName is the pre-rename bundle name. One release window:
	// status/install detect it so the rk-installed app upgrades in place
	// instead of leaving two Dock entries.
	legacyAppBundleName = "Run Kit.app"
	// assetPrefix is the leading segment of every desktop asset name
	// (hexokit-desktop-{version}-{arch}.{dmg,AppImage}, per the release CI's
	// artifactName convention).
	assetPrefix = "hexokit-desktop-"
	// legacyAssetPrefix covers releases published under the pre-rename
	// artifactName (run-kit-desktop-…); matched only when no assetPrefix
	// asset fits the host arch.
	legacyAssetPrefix = "run-kit-desktop-"
	// defaultAPIBase is the GitHub REST API origin.
	defaultAPIBase = "https://api.github.com"
)

// DefaultInstallDirFor returns the platform's default install root:
// /Applications on macOS, <home>/.rk/desktop on Linux. Overridable via the
// --path flag for managed-Mac / non-writable scenarios.
func DefaultInstallDirFor(goos, home string) string {
	if goos == "linux" {
		return filepath.Join(home, ".rk", "desktop")
	}
	return "/Applications"
}

// Subprocess and network bounds. Constitution § Process Execution requires a
// timeout on every exec.CommandContext; the constitution's named tiers are
// tmux (5-10s) and build ops (30s), and the intake sizes this flow "at the
// build-op tier or above": the DMG is ~110MB (downloadTimeout is
// network-transfer-sized), and codesign --deep --strict reads every file of an
// Electron bundle (~200MB unpacked), so the verify/copy bounds are generous
// rather than tight. All are upper bounds on failure, not expected durations.
const (
	apiTimeout       = 30 * time.Second
	downloadTimeout  = 15 * time.Minute
	attachTimeout    = 2 * time.Minute
	codesignTimeout  = 5 * time.Minute
	dittoTimeout     = 5 * time.Minute
	detachTimeout    = 1 * time.Minute
	probeTimeout     = 10 * time.Second
	extractTimeout   = 5 * time.Minute
	integrateTimeout = 30 * time.Second
)

// Runner executes an external command and returns its stdout. The default
// implementation (runCommand) uses exec.CommandContext with an explicit
// argument slice — never a shell string (Constitution I). Tests substitute a
// recorder so the whole install flow runs without macOS tools.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// DirRunner is Runner with an explicit working directory (cmd.Dir) — needed
// for commands whose output lands relative to the CWD, like the AppImage's
// --appimage-extract.
type DirRunner func(ctx context.Context, dir, name string, args ...string) ([]byte, error)

// Installer holds the seams and configuration for the desktop-app install
// flow. Construct with New() and override fields as needed; all methods are
// safe for a zero-concurrency CLI use (no internal locking — one command, one
// installer).
type Installer struct {
	// Client performs the GitHub API request and the asset download.
	Client *http.Client
	// Run executes subprocesses (hdiutil, ditto, codesign, plutil, pgrep).
	Run Runner
	// RunInDir is the Runner variant with an explicit working directory. The
	// Linux flow needs it because the AppImage's --appimage-extract writes
	// ./squashfs-root into the CWD and has no target-directory flag.
	RunInDir DirRunner
	// Signal delivers a Unix signal to a PID (the Linux graceful quit); a
	// struct field so tests record the delivery instead of signaling real
	// processes.
	Signal func(pid int, sig syscall.Signal) error
	// UserHome resolves the user's home directory for the Linux default
	// install root (the codeServerUserHomeFn idiom; no env key — Constitution
	// IV restricts env to deployment-bootstrap keys).
	UserHome func() (string, error)
	// Repo is the {owner}/{repo} the releases are resolved from.
	Repo string
	// GOOS is the host operating system (runtime.GOOS shape) — it selects the
	// per-platform strategy (darwin: the DMG flow; linux: the AppImage flow).
	GOOS string
	// Arch is the host architecture (runtime.GOARCH shape: "arm64"/"amd64").
	Arch string
	// APIBase is the GitHub API origin (overridden by tests with httptest).
	APIBase string
	// Token, when non-empty, is sent as a Bearer token — purely for rate-limit
	// headroom on the public repo (see githubToken).
	Token string
	// InstallDir is the install root. Empty means the platform default
	// (DefaultInstallDirFor), resolved at use time via effectiveInstallDir.
	InstallDir string
	// Progress receives human progress/decoration output (the caller wires it
	// to the chatter channel, so --quiet suppresses it). Never nil after New().
	Progress io.Writer
	// QuitWait bounds how long the swap phase waits for a quit app's processes
	// to exit before aborting (see restart.go). A struct field (not a bare
	// const) so tests can shrink the bound instead of sleeping 30s wall-clock.
	QuitWait time.Duration
	// QuitPoll is the cadence of the AppRunning poll during that wait.
	QuitPoll time.Duration
}

// New returns an Installer with production defaults.
func New() *Installer {
	return &Installer{
		Client:   &http.Client{}, // per-call contexts carry the timeouts
		Run:      runCommand,
		RunInDir: runCommandInDir,
		Signal:   syscall.Kill,
		UserHome: os.UserHomeDir,
		Repo:     DefaultRepo,
		GOOS:     runtime.GOOS,
		Arch:     runtime.GOARCH,
		APIBase:  defaultAPIBase,
		Token:    githubToken(),
		Progress: io.Discard,
		QuitWait: quitWaitTimeout,
		QuitPoll: quitPollInterval,
	}
}

// githubToken resolves a token for rate-limit headroom, preferring the
// environment (GITHUB_TOKEN, then GH_TOKEN — the pair gh itself honours) and
// falling back to the gh CLI's stored credential. The fallback exists because
// an interactive `gh auth login` is the common way a Mac has GitHub
// credentials at all, and without it a plain `rk desktop install` shares the
// 60 req/hour-per-IP unauthenticated budget with every other tool on the
// network. Every outcome is optional: no gh, gh not logged in, or gh timing
// out all yield "" and the request simply goes out unauthenticated.
func githubToken() string {
	for _, env := range []string{"GITHUB_TOKEN", "GH_TOKEN"} {
		if v := os.Getenv(env); v != "" {
			return v
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "gh", "auth", "token").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// AppPath returns the display path of the installed app — <root>/HexoKit.app
// on macOS, <root>/current on Linux. It feeds messages and the not-installed
// error only; operations resolve the root through effectiveInstallDir and
// surface a home-resolution failure themselves, so here it degrades to the
// "~/"-prefixed spelling.
func (ins *Installer) AppPath() string {
	root, err := ins.effectiveInstallDir()
	if err != nil {
		root = DefaultInstallDirFor(ins.GOOS, "~")
	}
	if ins.GOOS == "linux" {
		return filepath.Join(root, currentLinkName)
	}
	return filepath.Join(root, AppBundleName)
}

// effectiveInstallDir resolves the install root: an explicit InstallDir
// (--path) wins; empty means the platform default (DefaultInstallDirFor),
// which on Linux needs the user's home via the UserHome seam.
func (ins *Installer) effectiveInstallDir() (string, error) {
	if ins.InstallDir != "" {
		// Absolute so the desktop entry, the PATH symlink, and the running-app
		// probe all name the same launchable path regardless of the CWD the
		// user typed a relative --path from.
		abs, err := filepath.Abs(ins.InstallDir)
		if err != nil {
			return "", fmt.Errorf("resolving install directory %q: %w", ins.InstallDir, err)
		}
		return abs, nil
	}
	if ins.GOOS != "linux" {
		return DefaultInstallDirFor(ins.GOOS, ""), nil
	}
	home, err := ins.UserHome()
	if err != nil {
		return "", fmt.Errorf("resolving the home directory for the default install root: %w", err)
	}
	return DefaultInstallDirFor(ins.GOOS, home), nil
}

// runCommand is the default Runner: exec.CommandContext with an argument
// slice, stdout captured, and stderr detail folded into a non-nil error so
// failures stay diagnosable.
func runCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	return runCommandInDir(ctx, "", name, args...)
}

// runCommandInDir is the default DirRunner: runCommand with the working
// directory pinned (an empty dir means inherit, as with os/exec).
func runCommandInDir(ctx context.Context, dir, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			if detail := bytes.TrimSpace(ee.Stderr); len(detail) > 0 {
				return out, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, detail)
			}
		}
		return out, fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return out, nil
}
