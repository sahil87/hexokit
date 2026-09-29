package main

import (
	"context"
	"fmt"
	"runtime"

	"rk/internal/desktop"
	"rk/internal/updatecheck"

	"github.com/spf13/cobra"
)

// desktopGOOS is the platform the macOS/Linux gate checks. A seam var (not
// runtime.GOOS inline) so tests can exercise the gate and both platforms'
// flows deterministically on any host — the innerServePIDFn/runBrewFn idiom.
var desktopGOOS = runtime.GOOS

// newDesktopInstallerFn constructs the installer for the desktop subcommands.
// Package-level seam (mirrors runBrewFn/resolveExeFn in upgrade.go) so
// desktop_test.go can substitute an installer wired to an httptest server and
// a recorded runner without network or macOS tools.
var newDesktopInstallerFn = func() *desktop.Installer { return desktop.New() }

// errDesktopUnsupportedPlatform is the platform-gate refusal. The commands
// stay REGISTERED on every platform so the `rk help-dump` command tree is
// platform-stable (help-dump is a contract surface per the toolkit
// standards); only running them is gated. Operational failure — exit 1.
var errDesktopUnsupportedPlatform = fmt.Errorf("rk desktop supports macOS and Linux (the shell is packaged as a macOS .app and a Linux AppImage)")

// desktopRestartAnnouncement is the auto-restart outcome line — data (stdout,
// survives --quiet): a caller must be able to tell "updated in place" from
// "updated and the running app was restarted" (Toolkit Principle 9).
const desktopRestartAnnouncement = "HexoKit was running — restarted on the new version.\n"

var desktopCmd = &cobra.Command{
	Use:   "desktop",
	Short: "Install and update the HexoKit desktop app (macOS, Linux)",
	Long: `Install and update the HexoKit desktop app — the Electron shell that wraps an
rk serve dashboard (macOS and Linux).

On macOS the CLI path produces a quarantine-free install: a browser DMG
download stamps the app with com.apple.quarantine, so Gatekeeper blocks it on
every install and update, while command-line downloads carry no quarantine
attribute. The installer verifies the download itself before installing —
SHA256 against the release digest, plus codesign --verify --deep --strict on
the app bundle.

On Linux the AppImage is extracted once into ~/.rk/desktop/<version>/ with a
'current' symlink flipped atomically, the release digest is the hard
verification gate (a release without one is refused), and a launcher entry,
icon, and ~/.local/bin/hexokit-desktop symlink are written for desktop
integration.

A running app does not block install/update: the new version is downloaded,
verified, and staged while the app runs, then the app is asked to quit
gracefully, the swap happens atomically, and the app is relaunched on the
new version (the VSCode update pattern).

Subcommands:
  install    Fetch the latest release and install it
  update     Same, but a no-op when the installed app is already current
  status     Show installed version vs latest (read-only)
  uninstall  Remove the app and its desktop integration (Linux only)

See 'run-kit desktop <subcommand> --help' for flags on each.`,
	PersistentPreRunE: func(_ *cobra.Command, _ []string) error {
		if desktopGOOS != "darwin" && desktopGOOS != "linux" {
			return errDesktopUnsupportedPlatform
		}
		return nil
	},
}

var desktopInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Download and install the HexoKit desktop app",
	Long: `Download the latest desktop release (or a specific release via --version)
and install it.

The download is verified before anything is touched: SHA256 against the
release digest. On macOS the app bundle additionally passes
codesign --verify --deep --strict; on Linux the digest is the only gate and a
release without one is refused. On Linux the AppImage is extracted once into
~/.rk/desktop/<version>/ with an atomically-flipped 'current' symlink, plus a
launcher entry, icon, and ~/.local/bin/hexokit-desktop symlink. The new
version is staged next to the install target and swapped in atomically, so a
failed download or copy never destroys an existing install.

A running HexoKit app is handled automatically: it is asked to quit gracefully
just before the swap, then relaunched on the new version. If it does not quit
within the wait bound, the install aborts with the existing app untouched.

When the resolved version is already installed, the command is a no-op;
--force reinstalls anyway. --force overrides version state ONLY — it does not
change how a running app is handled (quit, swap, relaunch).

--path installs somewhere other than the default root (/Applications on macOS,
~/.rk/desktop on Linux) — e.g. ~/Applications on a managed Mac where
/Applications is not writable.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runDesktopInstall,
}

var desktopUpdateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update the HexoKit desktop app when a newer release exists",
	Long: `Update the HexoKit desktop app to the latest release. A no-op (exit 0) when
the installed app is already current; errors when no app is installed (run
'run-kit desktop install' first).

The installed version is derived from the install at check time (the app
bundle's Info.plist on macOS, the 'current' symlink on Linux) — never assumed
equal to the CLI version. There is deliberately no --version flag: update
means "go to latest"; to pin a specific release use
'run-kit desktop install --version <tag>'.

A running HexoKit app is handled automatically: the new version is staged
while the app runs, then the app is quit gracefully, swapped, and relaunched.
If it does not quit within the wait bound, the update aborts with the existing
app untouched.

--force reinstalls even when already current. It overrides version state ONLY
— it does not change how a running app is handled (quit, swap, relaunch).

--path targets an install outside the default root (/Applications on macOS,
~/.rk/desktop on Linux) — e.g. ~/Applications on a managed Mac.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runDesktopUpdate,
}

var desktopStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show installed vs latest HexoKit desktop app version (read-only)",
	Long: `Show the installed HexoKit desktop app version against the latest GitHub
release, and whether an update is available. Read-only: nothing is downloaded
or modified. The report is the requested result (data), so --quiet changes
nothing.

--path points at an install outside the default root (/Applications on macOS,
~/.rk/desktop on Linux).`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runDesktopStatus,
}

var desktopUninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Remove the HexoKit desktop app and its desktop integration (Linux)",
	Long: `Remove the HexoKit desktop app from this machine (Linux only — on macOS drag
"HexoKit.app" to the Trash).

Refuses while the app is running (quit it first). Removes every installed
version under the install root, the 'current' symlink, the launcher entry, the
icon, and the ~/.local/bin/hexokit-desktop symlink. App settings and host
registrations (~/.config/HexoKit) are user data and are NOT removed.

--path targets an install outside the default root (~/.rk/desktop).`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runDesktopUninstall,
}

func init() {
	desktopInstallCmd.Flags().String("version", "", "install a specific release tag instead of the latest (e.g. v3.13.0)")
	desktopInstallCmd.Flags().Bool("force", false, "reinstall even when the requested version is already installed")
	desktopInstallCmd.Flags().String("path", "", "install directory (default: /Applications on macOS, ~/.rk/desktop on Linux)")
	desktopUpdateCmd.Flags().Bool("force", false, "reinstall even when already current")
	desktopUpdateCmd.Flags().String("path", "", "install directory (default: /Applications on macOS, ~/.rk/desktop on Linux)")
	desktopStatusCmd.Flags().String("path", "", "install directory (default: /Applications on macOS, ~/.rk/desktop on Linux)")
	desktopUninstallCmd.Flags().String("path", "", "install directory (default: /Applications on macOS, ~/.rk/desktop on Linux)")

	desktopCmd.AddCommand(desktopInstallCmd)
	desktopCmd.AddCommand(desktopUpdateCmd)
	desktopCmd.AddCommand(desktopStatusCmd)
	desktopCmd.AddCommand(desktopUninstallCmd)

	// Arg-count violations on the children are usage-class (exit 2). root.go's
	// central wrap loop covers only rootCmd's direct children, so nested
	// subcommands wrap their own validators here (same one-place idiom).
	for _, c := range desktopCmd.Commands() {
		if c.Args != nil {
			c.Args = usageArgs(c.Args)
		}
	}
}

// desktopInstaller builds the configured installer for a command invocation:
// the --path flag overrides the install root and download/verify progress is
// wired to the sink's chatter channel (dropped by --quiet; outcome lines stay
// data per Toolkit Principle 9). The flag's cobra default is deliberately ""
// — a per-platform literal default would make the published help-dump
// reference depend on the puller's platform — so an unchanged flag leaves
// InstallDir empty and the installer resolves the platform default at use
// time, while an explicitly-empty --path "" is a usage error (exit 2).
func desktopInstaller(cmd *cobra.Command, sink outputSink) (*desktop.Installer, error) {
	p, err := cmd.Flags().GetString("path")
	if err != nil {
		return nil, err
	}
	// Validate before constructing: the usage error must not require the
	// installer factory to run.
	if cmd.Flags().Changed("path") && p == "" {
		return nil, usageError(fmt.Errorf("--path requires a non-empty directory (omit the flag for the platform default install root: /Applications on macOS, ~/.rk/desktop on Linux)"))
	}
	ins := newDesktopInstallerFn()
	ins.GOOS = desktopGOOS
	if cmd.Flags().Changed("path") {
		ins.InstallDir = p
	}
	ins.Progress = sink.chatter
	return ins, nil
}

func runDesktopInstall(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	ins, err := desktopInstaller(cmd, sink)
	if err != nil {
		return err
	}
	ctx := cmd.Context()
	tag, _ := cmd.Flags().GetString("version")
	force, _ := cmd.Flags().GetBool("force")

	sink.Notef("Resolving release...\n")
	rel, err := ins.ResolveRelease(ctx, tag)
	if err != nil {
		return err
	}

	installed, err := ins.InstalledVersion(ctx)
	if err != nil {
		return err
	}
	if !force && installed == rel.Version && ins.CurrentBundleInstalled() {
		// A legacy-only install at the same version is NOT a no-op: fall
		// through so Install lands HexoKit.app and removes the old bundle.
		// Outcome line — data: silence would misreport the no-op.
		sink.Dataf("HexoKit v%s is already installed (%s). Use --force to reinstall.\n", installed, ins.AppPath())
		return nil
	}

	res, err := ins.Install(ctx, rel)
	if err != nil {
		return err
	}
	sink.Dataf("Installed HexoKit v%s to %s\n", res.Version, res.Path)
	if res.Restarted {
		sink.Dataf(desktopRestartAnnouncement)
	}
	return nil
}

func runDesktopUpdate(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	ins, err := desktopInstaller(cmd, sink)
	if err != nil {
		return err
	}
	ctx := cmd.Context()
	force, _ := cmd.Flags().GetBool("force")

	installed, err := ins.InstalledVersion(ctx)
	if err != nil {
		return err
	}
	if installed == "" {
		// An update of nothing is a user error, not a silent no-op.
		return fmt.Errorf("HexoKit is not installed at %s — run 'rk desktop install' first", ins.AppPath())
	}

	return desktopUpdateToLatest(ctx, ins, sink, installed, force)
}

// desktopUpdateToLatest updates an installed desktop app to the latest
// release: resolve → compare (updatecheck.AnyIncrease, unless force) →
// install (auto-restarting a running app) → outcome lines. Shared by
// `rk desktop update` and the umbrella `rk update` desktop leg so the two
// flows — and their data-line shapes — cannot drift. The caller has already
// established that an app is installed (installed != "").
func desktopUpdateToLatest(ctx context.Context, ins *desktop.Installer, sink outputSink, installed string, force bool) error {
	sink.Notef("Installed: v%s — checking the latest release...\n", installed)
	rel, err := ins.ResolveRelease(ctx, "")
	if err != nil {
		return err
	}
	if !force && !updatecheck.AnyIncrease(installed, rel.Version) && ins.CurrentBundleInstalled() {
		// A legacy-only install at the latest version still migrates: fall
		// through so Install lands HexoKit.app and removes the old bundle.
		// Outcome line — data (mirrors `rk update`'s already-up-to-date shape).
		sink.Dataf("Already up to date (v%s).\n", installed)
		return nil
	}

	res, err := ins.Install(ctx, rel)
	if err != nil {
		return err
	}
	sink.Dataf("Updated HexoKit v%s -> v%s (%s)\n", installed, res.Version, res.Path)
	if res.Restarted {
		sink.Dataf(desktopRestartAnnouncement)
	}
	return nil
}

func runDesktopUninstall(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	// Flag validation precedes the platform refusal: a usage error stays
	// exit 2 on every platform.
	ins, err := desktopInstaller(cmd, sink)
	if err != nil {
		return err
	}
	if desktopGOOS == "darwin" {
		return fmt.Errorf(`rk desktop uninstall is Linux-only — on macOS drag "HexoKit.app" to the Trash`)
	}
	res, err := ins.Uninstall(cmd.Context())
	if err != nil {
		return err
	}
	// Outcome line — data (survives --quiet).
	sink.Dataf("Uninstalled HexoKit from %s\n", res.Root)
	return nil
}

func runDesktopStatus(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	ins, err := desktopInstaller(cmd, sink)
	if err != nil {
		return err
	}
	ctx := cmd.Context()

	installed, err := ins.InstalledVersion(ctx)
	if err != nil {
		return err
	}
	rel, err := ins.ResolveRelease(ctx, "")
	if err != nil {
		return err
	}

	// Everything status prints is data — a read-only report is the requested
	// result, so --quiet legitimately changes nothing (the rk status / reaper
	// posture).
	if installed == "" {
		sink.Dataf("Installed: not installed\n")
		sink.Dataf("Latest:    v%s\n", rel.Version)
		sink.Dataf("Run 'rk desktop install' to install.\n")
		return nil
	}
	sink.Dataf("Installed: v%s\n", installed)
	sink.Dataf("Latest:    v%s\n", rel.Version)
	if updatecheck.AnyIncrease(installed, rel.Version) {
		sink.Dataf("Update available — run 'rk desktop update'.\n")
	} else {
		sink.Dataf("Up to date.\n")
	}
	return nil
}
