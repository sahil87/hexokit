package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"rk/internal/codeserver"
	"rk/internal/daemon"
	"rk/internal/selfpath"

	"github.com/spf13/cobra"
)

// Brew-mutation bounds (shll update standard, brew-handling safety clause):
// brew mutations are NOT interruptible without damage — a keg swap runs
// `brew unlink` then `brew link`, and a process killed between them leaves the
// tool half-installed. brew can also legitimately block for minutes on the
// network (Homebrew 6 makes an un-timed api.github.com call inside every
// tap-formula upgrade; observed 2026-07-19: a 120s hard kill landed mid-swap
// and corrupted the keg). So any bound on a mutating brew subcommand MUST be
// generous — sized for a network transfer, never a short hard cap — and
// terminate gracefully (SIGTERM + grace, see newBrewCmd), per the standard's
// "MUST NOT impose a short hard timeout on brew upgrade" / "MUST NOT send
// SIGKILL to a package-manager subprocess mid-transaction". Timeouts are kept
// at all (rather than unbounded) per Constitution § Process Execution.
const (
	// brewUpgradeTimeout bounds `brew upgrade` — the keg-swapping mutation.
	brewUpgradeTimeout = 30 * time.Minute
	// brewUpdateTimeout bounds `brew update` — also a network-bound
	// package-manager mutation with the same stall profile.
	brewUpdateTimeout = 10 * time.Minute
	// brewCancelGrace is the WaitDelay window a mutating brew subprocess gets
	// between SIGTERM (on context expiry) and the runtime's final kill —
	// enough for brew to unwind a keg swap cleanly.
	brewCancelGrace = 30 * time.Second
)

// skipBrewUpdate is bound to the --skip-brew-update flag (registered in init).
// When true, the update command skips ONLY the internal `brew update --quiet`
// tap-metadata refresh; all other behavior (version check, upgrade, daemon
// restart) is unchanged.
var skipBrewUpdate bool

// runBrewFn is the package-level seam for invoking `brew`. All three call sites
// (update, info, upgrade) route through it so tests can observe which brew
// subcommands ran without spawning a real `brew`. The default impl preserves
// today's exact stdout/stderr wiring per subcommand:
//   - update  → streams to os.Stderr only (returns no captured bytes)
//   - upgrade → streams to os.Stdout + os.Stderr (returns no captured bytes)
//   - info    → captures stdout via .Output() and returns the bytes
//
// Command construction goes through newBrewCmd, which configures graceful
// cancellation (SIGTERM + WaitDelay grace) for the mutating subcommands —
// see its doc comment. The seam itself only relocates the call behind a var,
// matching the daemon_status.go innerServePIDFn idiom.
//
// Per-subcommand stdout/stderr wiring is keyed on args[0]; a new brew
// subcommand not matched here inherits the default (Stderr-only) wiring.
//
// Quiet (Toolkit Principle 9): the streamed brew subprocess output is the
// definitional "raw brew output" chatter — under --quiet the streams are
// suppressed so nothing but data + errors survives. The default impl reads the
// package-level `quiet` var (set by cobra flag parsing via root.go's
// PersistentFlags BoolVar), keeping the seam signature unchanged so tests still
// observe calls without a real brew. The `info` path is unaffected — it captures
// stdout via .Output() rather than streaming, and its bytes are data (the
// version lookup), not chatter.
//
// Under --quiet the suppressed brew stderr is BUFFERED rather than discarded and,
// on a non-zero exit, its captured detail is wrapped into the returned error
// (R2's errors-always-survive rule): otherwise a failing `rk update --quiet`
// would surface only "exit status 1" with all diagnostics destroyed. Non-quiet
// runs keep streaming stderr live — the detail is already on the terminal, so
// the bare exit error suffices.
var runBrewFn = func(ctx context.Context, args ...string) ([]byte, error) {
	cmd := newBrewCmd(ctx, args...)
	if len(args) > 0 && args[0] == "info" {
		return cmd.Output()
	}
	stdout, stderr, errBuf := brewStreams(quiet)
	cmd.Stderr = stderr
	if len(args) > 0 && args[0] == "upgrade" {
		cmd.Stdout = stdout
	}
	err := cmd.Run()
	if err != nil && errBuf != nil {
		if detail := strings.TrimSpace(errBuf.String()); detail != "" {
			return nil, fmt.Errorf("%w: %s", err, detail)
		}
	}
	return nil, err
}

// newBrewCmd constructs the *exec.Cmd for a brew invocation. Mutating
// subcommands (update, upgrade) perform keg transactions that must never be
// SIGKILLed mid-swap (shll update standard: "MUST NOT send SIGKILL to a
// package-manager subprocess mid-transaction" — SIGKILL cannot be trapped, so
// brew gets no chance to finish or roll back the keg swap). For those, the
// command is configured for graceful cancellation: on context expiry brew
// receives SIGTERM (cmd.Cancel) and gets a brewCancelGrace window
// (cmd.WaitDelay) to unwind before the runtime's final kill. Read-only
// subcommands (info, list) keep Go's default cancel (immediate kill) — a
// killed query corrupts nothing, so fast-fail is correct there. Keyed on
// args[0], like runBrewFn's per-subcommand stream wiring: an unmatched brew
// subcommand inherits the read-only default.
//
// It is a standalone helper so the cancel configuration is unit-testable
// without spawning a real `brew` (tests assert on the returned Cmd's fields).
func newBrewCmd(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "brew", args...)
	if len(args) > 0 && (args[0] == "update" || args[0] == "upgrade") {
		cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
		cmd.WaitDelay = brewCancelGrace
	}
	return cmd
}

// brewStreams selects the stdout/stderr writers for the streamed brew
// subprocesses (update/upgrade). Under --quiet the streamed brew output is the
// definitional "raw brew output" chatter (Toolkit Principle 9), so stdout is
// discarded; stderr is captured into the returned *bytes.Buffer so a failing
// quiet run can wrap the diagnostic detail into its error (errBuf is non-nil
// ONLY under --quiet). Non-quiet runs stream to the process's real streams and
// return a nil errBuf (nothing to buffer — the detail is already live on the
// terminal). It is a standalone helper so the quiet-gating decision is
// unit-testable without spawning a real `brew`.
func brewStreams(q bool) (stdout, stderr io.Writer, errBuf *bytes.Buffer) {
	if q {
		buf := &bytes.Buffer{}
		return io.Discard, buf, buf
	}
	return os.Stdout, os.Stderr, nil
}

// restartDaemonFn is the package-level seam for the post-upgrade daemon
// restart. Defaults to the real daemon.Restart with the Binary option so tests
// can record the call without restarting a real daemon. Mirrors innerServePIDFn.
var restartDaemonFn = func(binPath string) error {
	return daemon.Restart(daemon.RestartOptions{Binary: binPath})
}

// resolveExeFn is the package-level seam for resolving this binary's on-disk
// path (used to detect a Homebrew install via selfpath.IsBrewInstalled).
// Defaults to the shared selfpath.Resolve (os.Executable + EvalSymlinks) — the
// same resolver api/update.go uses, so brew-install detection cannot drift
// between the two entry points; tests stub it to return a synthetic Cellar path
// so the upgrade/restart code path is reachable independent of the test binary's
// real location.
var resolveExeFn = selfpath.Resolve

func init() {
	updateCmd.Flags().BoolVar(&skipBrewUpdate, "skip-brew-update", false,
		"Skip the internal 'brew update' tap-metadata refresh (still runs brew info/upgrade and restarts the daemon)")
}

var updateCmd = &cobra.Command{
	Use:     "update",
	Aliases: []string{"upgrade"},
	Short:   "Update the run-kit CLI and desktop app to the latest version",
	Long: `Update everything run-kit that is installed on this machine, in two
independent legs:

  CLI leg      When this binary is a Homebrew install: brew update (skippable
               via --skip-brew-update), brew upgrade, then a daemon restart so
               the server picks up the new binary. A non-brew install prints
               manual-update guidance instead and moves on.
  Desktop leg  (macOS, Linux) When the HexoKit desktop app is installed at
               the platform's default install root (/Applications on macOS,
               ~/.rk/desktop on Linux): update it to the latest release,
               auto-restarting a running app (staged download, graceful quit,
               atomic swap, relaunch). Skipped silently when no app is
               installed.
  Code-server  When an rk-managed code-server install exists
  leg          (~/.rk/code-server-bin): update it to the latest release and
               respawn the session so the new binary takes effect.
               Best-effort — a failure warns but never fails the command
               (the daemon's install job retries later). Skipped silently
               when nothing is rk-managed; a PATH install is never touched.

Each leg is skipped when its target is not installed; skips exit 0. The exit
code is non-zero only when a leg genuinely fails, and one leg's failure does
not stop the other.

The desktop leg only looks at the platform's default install root
(/Applications on macOS, ~/.rk/desktop on Linux) — an app installed elsewhere
is invisible to this command; keep using 'run-kit desktop update --path <dir>'
for custom locations.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		// stdout carries data (outcome lines + the not-brew guidance), stderr
		// carries chatter (progress/decoration + streamed brew output) which
		// --quiet drops (Toolkit Principle 9). Adopting the convention re-routes
		// update's former stdout progress lines onto stderr on non-quiet runs —
		// intentional per "decide the stdout-vs-stderr convention once".
		sink := newSink(cmd)

		// Two independent, fail-independent legs — CLI first ("update the
		// tool, then its artifacts"), desktop second. A leg failure never
		// stops the other leg; the joined error reports every failing leg
		// (leg-labelled) and yields the non-zero exit.
		cliErr := runUpdateCLILeg(sink)
		if cliErr != nil {
			cliErr = fmt.Errorf("CLI update: %w", cliErr)
		}
		// cmd.Context() is set by Execute(); direct RunE invocations (the
		// package's test idiom) leave it nil, so fall back explicitly.
		ctx := cmd.Context()
		if ctx == nil {
			ctx = context.Background()
		}
		desktopErr := runUpdateDesktopLeg(ctx, sink)
		if desktopErr != nil {
			desktopErr = fmt.Errorf("desktop update: %w", desktopErr)
		}
		// Third leg, best-effort: warnings only, NEVER joined into the exit
		// code (see runUpdateCodeServerLeg).
		runUpdateCodeServerLeg(cmd, sink)
		return errors.Join(cliErr, desktopErr)
	},
}

// runUpdateCLILeg updates the run-kit CLI via Homebrew (the pre-umbrella
// `rk update` body, unchanged in behavior): brew update (skippable) → brew
// info → brew upgrade → daemon restart. A non-brew install prints the manual
// guidance and returns nil — a skip, not a failure — so the desktop leg still
// runs.
func runUpdateCLILeg(sink outputSink) error {
	resolved, err := resolveExeFn()
	if err != nil {
		return fmt.Errorf("could not determine executable path: %w", err)
	}

	if !selfpath.IsBrewInstalled(resolved) {
		// The not-a-brew-install guidance is data: it explains why nothing
		// happened, and silence there would misreport a no-op as success.
		sink.Dataf("hexokit v%s was not installed via Homebrew.\n", version)
		sink.Dataf("Update manually (git pull && just build), or reinstall with:\n")
		sink.Dataf("  brew install %s\n", selfpath.BrewFormula)
		return nil
	}

	sink.Notef("Current version: v%s\n", version)

	// Refresh tap metadata (skippable via --skip-brew-update).
	if !skipBrewUpdate {
		updateCtx, updateCancel := context.WithTimeout(context.Background(), brewUpdateTimeout)
		defer updateCancel()

		if _, err := runBrewFn(updateCtx, "update", "--quiet"); err != nil {
			return fmt.Errorf("could not check for updates (brew update failed): %w", err)
		}
	}

	// Get latest version from Homebrew
	infoCtx, infoCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer infoCancel()

	infoOut, err := runBrewFn(infoCtx, "info", "--json=v2", selfpath.BrewFormula)
	if err != nil {
		return fmt.Errorf("could not determine latest version: %w", err)
	}

	latest, err := parseBrewVersion(infoOut)
	if err != nil {
		return fmt.Errorf("could not determine latest version: %w", err)
	}

	if latest == version {
		// Outcome line — data: full silence would make "updated" vs
		// "already current" indistinguishable to a caller.
		sink.Dataf("Already up to date (v%s).\n", version)
		return nil
	}

	sink.Notef("Updating v%s → v%s...\n", version, latest)

	upgradeCtx, upgradeCancel := context.WithTimeout(context.Background(), brewUpgradeTimeout)
	defer upgradeCancel()

	if _, err := runBrewFn(upgradeCtx, "upgrade", selfpath.BrewFormula); err != nil {
		return fmt.Errorf("brew upgrade failed: %w", err)
	}

	// Outcome line — data (survives --quiet).
	sink.Dataf("Updated to v%s.\n", latest)

	// Restart via the stable Homebrew bin symlink (<prefix>/bin/<keg>), not
	// the Cellar path: brew has just deleted the keg this process ran from.
	brewBinPath := selfpath.StableFor(resolved)

	// Restart daemon so it picks up the new binary.
	// Idempotent: if no daemon is running, this starts one.
	sink.Notef("Restarting run-kit daemon...\n")
	if err := restartDaemonFn(brewBinPath); err != nil {
		return fmt.Errorf("restarting daemon after upgrade: %w", err)
	}
	sink.Notef("run-kit daemon started (%s/%s/%s)\n",
		daemon.ServerSocket, daemon.SessionName, daemon.WindowName)

	return nil
}

// runUpdateCodeServerLeg runs the code-server leg of the umbrella update —
// the shll update standard's "post-upgrade side effects" clause (the
// standard's own cited example is a tool restarting its daemon). Semantics
// are exactly `rk code-server update` (shared via runCodeServerUpdateFlow)
// under the agreed constraints: it runs ONLY when ~/.rk/code-server-bin
// exists (a user-managed PATH install is never touched — the standard's
// self-update-only-when-brew-installed mirror), it is best-effort (any
// failure is a chatter warning and NEVER joins the command's exit code —
// deliberately not taking the standard's failed-post-upgrade-step allowance:
// the rk upgrade itself succeeded, the daemon's install job retries
// acquisition later, and a false red row in `shll update`'s summary is worse
// than a warning), the download bound is generous (R5's 15m context —
// in-process HTTP needs no SIGTERM discipline; the atomic symlink flip makes
// the swap corruption-proof), and the session respawn is part of the shared
// flow (the daemon restart deliberately never touches sibling sessions, so
// this leg owns the code-server one).
func runUpdateCodeServerLeg(cmd *cobra.Command, sink outputSink) {
	home, err := codeServerUserHomeFn()
	if err != nil {
		sink.Notef("warning: code-server leg skipped (home unresolvable: %v) — run `rk code-server update` manually\n", err)
		return
	}
	if _, err := os.Stat(codeserver.BinDir(home)); errors.Is(err, fs.ErrNotExist) {
		return // not managed ⇒ silent skip (only touch what rk owns)
	} else if err != nil {
		// A real Stat failure (permissions, a corrupted path) is NOT proof of
		// non-ownership — warn instead of silently skipping, still exit-0.
		sink.Notef("warning: code-server leg skipped (checking %s: %v) — run `rk code-server update` manually\n", codeserver.BinDir(home), err)
		return
	}
	if err := runCodeServerUpdateFlow(cmd, sink); err != nil {
		sink.Notef("warning: code-server update failed (%v) — the daemon's install job retries on the next start, or run `rk code-server update`\n", err)
	}
}

// runUpdateDesktopLeg updates the HexoKit desktop app when one is installed
// at the platform's default install root (/Applications on macOS,
// ~/.rk/desktop on Linux) — the umbrella's "whichever is installed" desktop
// half. macOS/Linux only (desktopGOOS); another platform and a missing app
// are both silent exit-0 skips (absence is a valid state here, unlike
// standalone `rk desktop update`, which errors so an explicit update of
// nothing stays a user error). Custom --path installs are deliberately
// invisible: there is no state store to remember an install location
// (Constitution II), so those keep `rk desktop update --path`.
// A stale install runs the shared desktopUpdateToLatest flow, auto-restart
// included.
func runUpdateDesktopLeg(ctx context.Context, sink outputSink) error {
	if desktopGOOS != "darwin" && desktopGOOS != "linux" {
		return nil
	}
	ins := newDesktopInstallerFn()
	ins.GOOS = desktopGOOS
	ins.Progress = sink.chatter

	installed, err := ins.InstalledVersion(ctx)
	if err != nil {
		return err
	}
	if installed == "" {
		return nil
	}
	return desktopUpdateToLatest(ctx, ins, sink, installed, false)
}

// parseBrewVersion extracts the stable version from brew info --json=v2 output.
func parseBrewVersion(data []byte) (string, error) {
	var result struct {
		Formulae []struct {
			Versions struct {
				Stable string `json:"stable"`
			} `json:"versions"`
		} `json:"formulae"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return "", err
	}
	if len(result.Formulae) == 0 || result.Formulae[0].Versions.Stable == "" {
		return "", fmt.Errorf("no stable version found")
	}
	return result.Formulae[0].Versions.Stable, nil
}
