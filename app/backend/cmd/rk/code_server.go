package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"

	"rk/internal/codebridge"
	"rk/internal/codeserver"
	"rk/internal/daemon"

	"github.com/spf13/cobra"
)

// codeServerUserHomeFn resolves the user's home for the managed-install
// paths. A package seam (mirroring resolveExeFn) so tests point the managed
// dir at a temp dir and never touch the real ~/.rk.
var codeServerUserHomeFn = os.UserHomeDir

// newCodeServerInstallerFn constructs the installer for the code-server
// subcommands. Package-level seam (mirrors newDesktopInstallerFn) so tests
// substitute an installer wired to an httptest server.
var newCodeServerInstallerFn = func() *codeserver.Installer { return codeserver.New() }

// codeServerStartFn / codeServerKillFn are the package seams over the daemon
// package's exported start/kill entries (StartCodeServer carries the
// daemon-running gate; KillCodeServerSession no-ops on an absent session), so
// tests drive the update respawn without a live tmux server.
var codeServerStartFn = daemon.StartCodeServer
var codeServerKillFn = daemon.KillCodeServerSession
var codeServerRestartFn = daemon.RestartCodeServer

// codeServerDaemonRunningFn / codeServerSessionCommandFn are the package seams
// over the daemon-liveness probe and the session start-command reader, so
// tests drive the respawn gate and the foreign-session classification without
// a live tmux server. The liveness gate fires BEFORE any tmux command — even
// KillCodeServerSession's has-session probe would birth a server on a dead
// socket.
var codeServerDaemonRunningFn = daemon.IsRunning
var codeServerSessionCommandFn = daemon.CodeServerSessionCommand

// codeBridgeEmbeddedFn is the package seam over codebridge.Embedded — the
// embed dir is empty in test binaries, so tests substitute it to drive the
// bundled/dev-build branches of the extension install step.
var codeBridgeEmbeddedFn = codebridge.Embedded

// installBridgeExtensionFn is the package seam over the installer package's
// extension step so tests capture calls without a managed code-server binary.
var installBridgeExtensionFn = codeserver.InstallBridgeExtension

var codeServerCmd = &cobra.Command{
	Use:   "code-server",
	Short: "Manage the rk-owned code-server install (the /code lens editor)",
	Long: `Manage the rk-owned code-server install — the editor behind the dashboard's
/code lens.

run-kit installs code-server itself: the official standalone release tarball
(SHA256-verified against the GitHub release digest) lands under
~/.rk/code-server-bin/<version>/, activated by an atomic 'current' symlink
flip. The daemon installs it automatically on first start (a code-server-install
window in the rk-jobs session) when neither the managed install nor a
code-server on PATH resolves; these subcommands are the manual surface for the
same paths — and the only ones a remote host without Homebrew needs.

A code-server you installed yourself on PATH is always respected and never
touched: 'update' acts only when ~/.rk/code-server-bin exists.

Subcommands:
  install  Download the latest release and activate it (idempotent)
  start    Start the daemon-managed code-server session now
  update   Install the latest release and respawn the session to apply it

See 'run-kit code-server <subcommand> --help' for details.`,
}

var codeServerInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Download the latest code-server release and activate it",
	Long: `Download the latest standalone code-server release tarball for this host
(linux/macos, amd64/arm64) from the official GitHub releases, verify its
SHA256 against the release digest, and activate it under
~/.rk/code-server-bin/<version>/ via an atomic 'current' symlink flip.

Idempotent: when the managed install already matches the latest release,
nothing is downloaded and the command prints the already-current outcome. A
missing or mismatched digest fails closed — no unverified binary is ever
activated, and a failed run leaves the previous install untouched.

Migration: when the rk-code-server session is running a NON-managed binary (a
brew- or PATH-installed code-server from before rk owned the install), install
respawns the session onto the managed binary — an explicit install is the
signal to move over. Requires the daemon to be running; a managed-binary
session is never restarted by install (that is update's job, on a version
change).

There is deliberately no version-pin flag: install means "go to latest".`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runCodeServerInstall,
}

var codeServerStartCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the daemon-managed code-server session now",
	Long: `Start the daemon-managed code-server session (rk-code-server, a sibling of
rk-daemon on the same tmux socket) — the same ensure path 'rk daemon start'
runs, exposed as a subcommand so the rk-jobs install chain and manual recovery
share one implementation.

Gated on the daemon running: any tmux command on a dead socket would silently
birth a server, so a down daemon is an operational error — start it with
'rk serve -d' first.

Idempotent: an existing session or an already-serving port (an externally
managed instance) is a skip, not an error. A missing binary IS an error here
(unlike the daemon's warn-and-continue posture): install it first with
'rk code-server install'.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runCodeServerStart,
}

var codeServerRestartCmd = &cobra.Command{
	Use:   "restart",
	Short: "Kill and respawn the daemon-managed code-server session",
	Long: `Kill the rk-code-server session (if any) and re-run the start path from
scratch: the binary (managed install, then PATH) and RK_BIN are re-resolved,
so a hung instance or one spawned from a since-removed binary path (e.g. after
'brew upgrade') recovers. Waits up to 15s for the port to serve and errors if
it never does. A missing binary spawns the install-then-start job in rk-jobs.
The same action as the /code lens's "Restart code-server" button.

Gated on the daemon running — start it with 'rk serve -d' first.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runCodeServerRestart,
}

var codeServerUpdateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update the managed code-server to the latest release",
	Long: `Update the rk-managed code-server install to the latest release and make it
take effect: the rk-code-server session is killed and respawned on the new
binary (code-server's hot exit preserves unsaved buffers; the /code lens
reconnects briefly). The respawn requires the daemon to be running — with it
down, nothing is killed and the command prints the manual recovery instead.

Ownership posture: with no ~/.rk/code-server-bin, the command is a skip (exit
0 with a data line) — a code-server you installed yourself on PATH is never
touched. When the managed install is already current, nothing is downloaded
and the session is NOT restarted.

'rk update' runs this leg automatically (best-effort) after upgrading the CLI.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runCodeServerUpdate,
}

func init() {
	codeServerCmd.AddCommand(codeServerInstallCmd)
	codeServerCmd.AddCommand(codeServerStartCmd)
	codeServerCmd.AddCommand(codeServerRestartCmd)
	codeServerCmd.AddCommand(codeServerUpdateCmd)

	// Arg-count violations on the children are usage-class (exit 2). root.go's
	// central wrap loop covers only rootCmd's direct children, so nested
	// subcommands wrap their own validators here (same one-place idiom as
	// desktop.go).
	for _, c := range codeServerCmd.Commands() {
		if c.Args != nil {
			c.Args = usageArgs(c.Args)
		}
	}
}

// codeServerHome resolves the home directory for the managed-install paths.
func codeServerHome() (string, error) {
	home, err := codeServerUserHomeFn()
	if err != nil {
		return "", fmt.Errorf("resolving home directory: %w", err)
	}
	return home, nil
}

// codeServerInstallToLatest runs the shared install path and prints the
// outcome lines. Returns (result, changed, err): changed=false is the
// already-current skip (callers — update — key the session respawn on it).
func codeServerInstallToLatest(cmd *cobra.Command, sink outputSink, home string) (codeserver.InstallResult, bool, error) {
	ins := newCodeServerInstallerFn()
	ins.Progress = sink.chatter
	sink.Notef("Resolving the latest code-server release...\n")
	// cmd.Context() is set by Execute(); direct RunE invocations (the
	// package's test idiom) leave it nil, so fall back explicitly.
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	res, err := ins.Install(ctx, home)
	if err != nil {
		return codeserver.InstallResult{}, false, err
	}
	if res.AlreadyCurrent {
		// Outcome line — data: silence would misreport the no-op.
		sink.Dataf("code-server v%s is already current (%s).\n", res.Version, res.Path)
		return res, false, nil
	}
	return res, true, nil
}

// installBridgeExtension runs the bridge-extension step after a successful
// binary install. Best-effort by contract: a dev build without a bundled VSIX
// skips with a note, and any install failure is a warning, never the verb's
// exit code — the code-server binary itself is already installed. Returns
// whether the installed extension changed: update keys its respawn on it
// because a newly installed extension only loads on a code-server restart.
func installBridgeExtension(cmd *cobra.Command, sink outputSink, home string) bool {
	vsix, version, ok := codeBridgeEmbeddedFn()
	if !ok {
		sink.Notef("No bundled code bridge extension in this build — skipping the extension install.\n")
		return false
	}
	// cmd.Context() is set by Execute(); direct RunE invocations (the
	// package's test idiom) leave it nil, so fall back explicitly (mirrors
	// codeServerInstallToLatest).
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	changed, err := installBridgeExtensionFn(ctx, home, vsix, version, sink.chatter)
	if err != nil {
		sink.Notef("Code bridge extension install failed: %v — the code-server binary itself is installed; retry the extension with `rk code-server update`.\n", err)
		return false
	}
	if changed {
		sink.Dataf("Installed code bridge extension v%s.\n", version)
	}
	return changed
}

func runCodeServerInstall(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	home, err := codeServerHome()
	if err != nil {
		return err
	}
	res, changed, err := codeServerInstallToLatest(cmd, sink, home)
	if err != nil {
		return err
	}
	if changed {
		sink.Dataf("Installed code-server v%s (%s).\n", res.Version, res.Path)
	}
	// The bridge step never gates the migration respawn: install's respawn
	// rule stays migration-only.
	installBridgeExtension(cmd, sink, home)
	return migrateForeignCodeServerSession(sink, home, res.Version)
}

// respawnOutcome classifies how respawnCodeServerSession ended so each caller
// can print its own daemon-down recovery (the truthful guidance differs by
// verb — see migrateForeignCodeServerSession vs runCodeServerUpdateFlow).
type respawnOutcome int

const (
	// respawnFailed is the deliberate zero value: it accompanies a non-nil
	// error and carries no meaning on its own, so a forgotten assignment can
	// never read as a successful respawn.
	respawnFailed respawnOutcome = iota
	// respawnDone: the session was killed and respawned on the managed binary.
	respawnDone
	// respawnDaemonDown: the daemon is not running — nothing was touched
	// (no kill, no tmux probe). The helper prints nothing; the caller owns
	// the recovery line.
	respawnDaemonDown
	// respawnExternallyManaged: the start path declined to respawn because
	// the port is already serving an externally managed instance.
	respawnExternallyManaged
)

// respawnCodeServerSession kills and restarts the rk-code-server session so
// the managed binary takes effect. The daemon gate fires FIRST, before any
// tmux command — a kill (or even KillCodeServerSession's has-session probe) on
// a dead socket would birth a stray tmux server, and with the daemon down the
// gated start could never bring the session back anyway (the #582 review
// should-fix). Shared by the update flow's version-changed respawn and
// install's foreign-session migration.
func respawnCodeServerSession(sink outputSink, version string) (respawnOutcome, error) {
	if !codeServerDaemonRunningFn() {
		return respawnDaemonDown, nil
	}
	sink.Notef("Restarting the code-server session on v%s...\n", version)
	if _, err := codeServerKillFn(); err != nil {
		return respawnFailed, err
	}
	// The kill is release-synchronous: when it killed our own session, the
	// port is already free (or the release budget expired), so the start below
	// cannot misread the dying instance as externally managed. A genuinely
	// foreign instance was never killed (killed is false), so the carve-out
	// still fires unchanged.
	outcome, err := codeServerStartFn()
	if err != nil {
		return respawnFailed, fmt.Errorf("respawning code-server (the new version IS installed — start it with `rk code-server start`): %w", err)
	}
	if outcome == daemon.EnsureExternallyManaged {
		// StartCodeServer legitimately declines to respawn when the port is
		// already serving — say so, or the "Restarting" line above misleads.
		sink.Notef("Port already serving — respecting the externally managed code-server; the updated binary was not respawned.\n")
		return respawnExternallyManaged, nil
	}
	return respawnDone, nil
}

// migrateForeignCodeServerSession is install's migration respawn: an explicit
// `rk code-server install` is unambiguous intent to move the running editor
// onto the managed binary, so a session running anything else (the brew-era
// world, or any PATH install) is killed and respawned. Detection is state-free
// — the session's live pane_start_command either contains the managed current
// binary path or it does not — so a re-run converges, which is exactly the
// daemon-down recovery. It fires on BOTH install outcomes (version-changed and
// already-current): the migration case is about who spawned the session, not
// whether this run downloaded anything. A missing session is a strict no-op,
// which keeps the rk-jobs `install && start` chain unchanged at the install
// step.
func migrateForeignCodeServerSession(sink outputSink, home, version string) error {
	if !codeServerDaemonRunningFn() {
		// A foreign session (if any) persists across daemon restarts — the
		// daemon's ensure path skips on session-exists — so it does NOT
		// self-heal. The state-free detection makes a re-run converge.
		sink.Dataf("Daemon not running — skipped checking the running code-server session; run `rk code-server install` again once the daemon is up (`rk serve -d`).\n")
		return nil
	}
	startCmd, exists, err := codeServerSessionCommandFn()
	if err != nil {
		// Uncertain evidence — never kill on it.
		sink.Notef("Could not inspect the running code-server session (%v) — leaving it untouched.\n", err)
		return nil
	}
	if !exists {
		return nil
	}
	managed := codeserver.ManagedBinary(home)
	if managed == "" {
		// Should not happen right after a successful install (the flip just
		// activated a verified-executable binary) — but "no anchor" is NOT
		// "managed", so say why the migration is not running rather than
		// silently classifying the session as ours.
		sink.Notef("Managed code-server binary not resolvable after the install — skipping the session migration check.\n")
		return nil
	}
	if strings.Contains(startCmd, managed) {
		return nil // ours — no respawn
	}
	out, err := respawnCodeServerSession(sink, version)
	if err != nil {
		return err
	}
	if out == respawnDone {
		sink.Dataf("Respawned code-server onto the managed v%s (was running a non-managed binary).\n", version)
	}
	return nil
}

func runCodeServerStart(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	outcome, err := codeServerStartFn()
	if err != nil {
		return err
	}
	switch outcome {
	case daemon.EnsureAlreadyRunning:
		sink.Dataf("code-server is already running (%s session).\n", daemon.CodeServerSessionName)
	case daemon.EnsureExternallyManaged:
		sink.Dataf("code-server port already serving; respecting the externally managed instance.\n")
	case daemon.EnsureStarted:
		sink.Dataf("Started code-server (%s session).\n", daemon.CodeServerSessionName)
	}
	return nil
}

func runCodeServerRestart(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	outcome, err := codeServerRestartFn()
	if err != nil {
		return err
	}
	switch outcome {
	case daemon.EnsureExternallyManaged:
		sink.Dataf("code-server port already serving; respecting the externally managed instance.\n")
	case daemon.EnsureInstallJobSpawned:
		sink.Dataf("code-server binary not found; spawned the %s job in rk-jobs.\n", daemon.CodeServerInstallJobWindow)
	default:
		sink.Dataf("Restarted code-server (%s session).\n", daemon.CodeServerSessionName)
	}
	return nil
}

// runCodeServerUpdateFlow is the R11 update semantics as a plain function so
// both `rk code-server update` and the `rk update` code-server leg share one
// implementation (the leg wraps the error instead of returning it). The
// returned error is operational; the not-managed skip and the already-current
// skip are nil-error outcomes.
func runCodeServerUpdateFlow(cmd *cobra.Command, sink outputSink) error {
	home, err := codeServerHome()
	if err != nil {
		return err
	}
	if _, err := os.Stat(codeserver.BinDir(home)); errors.Is(err, fs.ErrNotExist) {
		// Only touch what rk owns — a user-managed PATH install is never
		// shadowed as a side effect of an update verb.
		sink.Dataf("No rk-managed code-server install (%s absent) — leaving any PATH install untouched.\n", codeserver.BinDir(home))
		return nil
	} else if err != nil {
		return fmt.Errorf("checking %s: %w", codeserver.BinDir(home), err)
	}

	before, err := codeserver.InstalledVersion(home)
	if err != nil {
		return fmt.Errorf("reading the active code-server version: %w", err)
	}
	res, binaryChanged, err := codeServerInstallToLatest(cmd, sink, home)
	if err != nil {
		return err
	}
	extensionChanged := installBridgeExtension(cmd, sink, home)
	if !binaryChanged && !extensionChanged {
		return nil // already current — no restart either
	}

	// Take effect: kill + respawn via the daemon-gated helper — no tmux is
	// touched when the daemon is down. The respawn fires on EITHER change: a
	// newly installed extension only loads on a code-server restart.
	out, err := respawnCodeServerSession(sink, res.Version)
	if err != nil {
		return err
	}
	if out == respawnDaemonDown {
		// The flip already happened, so afterwards no rk verb can tell a
		// surviving old-binary session apart from a fresh one (its start
		// command names the same `current` path) — the manual chain is the
		// honest recovery, exact-match and socket-scoped like the helper's own
		// kill.
		sink.Dataf("Daemon not running — the session was not respawned. v%s is installed; after `rk serve -d`, apply it with: tmux -L rk-daemon kill-session -t '=rk-code-server' && rk code-server start\n", res.Version)
	}
	if binaryChanged {
		if before == "" {
			sink.Dataf("Installed code-server v%s (%s).\n", res.Version, res.Path)
		} else {
			sink.Dataf("Updated code-server v%s -> v%s (%s).\n", before, res.Version, res.Path)
		}
	}
	return nil
}

func runCodeServerUpdate(cmd *cobra.Command, _ []string) error {
	return runCodeServerUpdateFlow(cmd, newSink(cmd))
}
