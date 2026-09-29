package main

import (
	"context"
	"fmt"
	"text/tabwriter"

	"rk/internal/ports"
	"rk/internal/remote"
	"rk/internal/validate"

	"github.com/spf13/cobra"
)

// remotesPathFn resolves the remotes.yaml store path — a package-level seam
// (the innerServePIDFn idiom) so tests target a temp store instead of
// ~/.config/rk.
var remotesPathFn = remote.DefaultPath

// liveTCPPortsFn enumerates the host's listening TCP ports for the add-time
// local-port collision check. Seam var for the same test reason.
var liveTCPPortsFn = func(ctx context.Context) []int {
	services := ports.ListeningNow(ctx)
	out := make([]int, len(services))
	for i, s := range services {
		out[i] = s.Port
	}
	return out
}

var remoteCmd = &cobra.Command{
	Use:   "remote",
	Short: "Use SSH-only machines as run-kit hosts (bootstrap, tunnel, connect)",
	Long: `Turn a machine you can only reach over SSH into a full run-kit host — the
VS Code Remote-SSH model: bootstrap rk on the box over your existing SSH
access, run its daemon there (inside tmux, so disconnects lose nothing), and
keep a local ssh -L tunnel so the dashboard is reachable at a stable local
origin (http://127.0.0.1:<port>).

Everything rides your existing SSH setup — ~/.ssh/config aliases, agent auth,
ProxyJump, ControlMaster. Auth is non-interactive (BatchMode): if a target
needs key setup or host-key trust, run 'ssh <target>' once from a terminal
first. This complements Tailscale rather than replacing it: the tunnel exists
only where the ssh client runs (no mobile access).

Tunnels live as windows in a dedicated tmux session (rk-remotes) on the
rk-daemon socket — visible via 'tmux -L rk-daemon attach -t rk-remotes',
independent of the local daemon's lifecycle. State is derived at request
time; the only persisted facts are name, target, and the assigned local port
(~/.config/rk/remotes.yaml).

There is no 'update' verb: 'connect' is idempotent and folds updates in — it
installs rk when missing, upgrades the remote when it is older than this rk
(never downgrades), starts the remote daemon, and (re)opens the tunnel.

Subcommands:
  add         Register a remote and assign its stable local port
  connect     Bootstrap if needed, start the remote daemon, open the tunnel
  list        All remotes with derived tunnel + remote daemon state
  status      Single-remote detail, including version skew
  disconnect  Close the tunnel window (the remote daemon keeps running)
  remove      Disconnect and drop the registration (remote install untouched)

See 'run-kit remote <subcommand> --help' for details.`,
}

var remoteAddLong = fmt.Sprintf(`Register an SSH target as a remote host. <target> is stored verbatim — a
~/.ssh/config alias or a user@host form — and never parsed for connecting.

The name defaults to the target's host token (dots become hyphens); override
with --name. A local tunnel port is assigned from the reserved %d-%d
range, checked against both registered remotes and live listeners, and is
then fixed for the remote's lifetime — a stable port keeps the local origin
(and everything keyed on it) stable across reconnects. --local-port picks a
specific port from the same range under the same checks.`, remote.PortRangeStart, remote.PortRangeEnd) + `

No SSH connection is made; add is pure registration. Re-adding an existing
target reprints its registration and changes nothing.

The stdout lines (Name:/Target:/Local:) are stable data the desktop shell
parses.`

var remoteAddCmd = &cobra.Command{
	Use:          "add <target>",
	Short:        "Register a remote and assign its stable local port",
	Long:         remoteAddLong,
	Args:         cobra.ExactArgs(1),
	SilenceUsage: true,
	RunE:         runRemoteAdd,
}

var remoteConnectCmd = &cobra.Command{
	Use:   "connect <name|target>",
	Short: "Bootstrap if needed, start the remote daemon, open the tunnel",
	Long: `Idempotent get-in flow for a registered remote: probe rk over SSH, install
it when missing (the standard 'curl -fsSL https://shll.ai/install' step),
upgrade it when older than this rk (never downgrade — a newer remote is left
alone), start the remote daemon, and open the local tunnel window. Prints the
stable local origin (http://127.0.0.1:<port>) on success.

Auth is strictly non-interactive (BatchMode). On an SSH failure the error
carries ssh's stderr tail and the fix is usually to run 'ssh <target>' once
from a terminal (keys, host trust), then retry.

If another process is squatting the remote's assigned local port, connect
fails with an explanation — it never reassigns the port.

Progress goes to stderr; only the origin is stdout data (--quiet keeps it).`,
	Args:         cobra.ExactArgs(1),
	SilenceUsage: true,
	RunE:         runRemoteConnect,
}

var remoteListCmd = &cobra.Command{
	Use:   "list",
	Short: "All remotes with derived tunnel + remote daemon state",
	Long: `List every registered remote with its verbatim target, stable local origin,
tunnel state (derived from the rk-remotes tmux session at request time), and
remote daemon state (derived via an SSH probe per remote — running, stopped,
no rk, or unreachable). Read-only; the report is the requested result, so
--quiet changes nothing.`,
	Args:         cobra.NoArgs,
	SilenceUsage: true,
	RunE:         runRemoteList,
}

var remoteStatusCmd = &cobra.Command{
	Use:   "status <name>",
	Short: "Single-remote detail, including version skew",
	Long: `Show one remote's full derived state: target, local origin, tunnel state,
remote daemon state, and the remote rk version against this rk — noting when
the remote is older (connect will upgrade it) or newer (left untouched;
connect never downgrades). Read-only.`,
	Args:         cobra.ExactArgs(1),
	SilenceUsage: true,
	RunE:         runRemoteStatus,
}

var remoteDisconnectCmd = &cobra.Command{
	Use:   "disconnect <name>",
	Short: "Close the tunnel window (the remote daemon keeps running)",
	Long: `Kill the remote's tunnel window in the rk-remotes tmux session. Nothing on
the remote is touched — its daemon and tmux sessions keep running, and the
next 'connect' reopens the tunnel. Already-disconnected is success.`,
	Args:         cobra.ExactArgs(1),
	SilenceUsage: true,
	RunE:         runRemoteDisconnect,
}

var remoteRemoveCmd = &cobra.Command{
	Use:   "remove <name>",
	Short: "Disconnect and drop the registration (remote install untouched)",
	Long: `Disconnect the tunnel and remove the entry from ~/.config/rk/remotes.yaml.
The remote installation is untouched — rk, its daemon, and any sessions on
the box stay exactly as they are.`,
	Args:         cobra.ExactArgs(1),
	SilenceUsage: true,
	RunE:         runRemoteRemove,
}

func init() {
	remoteAddCmd.Flags().String("name", "", "remote name (default: derived from the target's host token)")
	remoteAddCmd.Flags().Int("local-port", 0, fmt.Sprintf("local tunnel port from the reserved %d-%d range (default: lowest free)", remote.PortRangeStart, remote.PortRangeEnd))

	remoteCmd.AddCommand(remoteAddCmd)
	remoteCmd.AddCommand(remoteConnectCmd)
	remoteCmd.AddCommand(remoteListCmd)
	remoteCmd.AddCommand(remoteStatusCmd)
	remoteCmd.AddCommand(remoteDisconnectCmd)
	remoteCmd.AddCommand(remoteRemoveCmd)

	// Arg-count violations on the children are usage-class (exit 2). root.go's
	// central wrap loop covers only rootCmd's direct children, so nested
	// subcommands wrap their own validators here (the desktop.go idiom).
	for _, c := range remoteCmd.Commands() {
		if c.Args != nil {
			c.Args = usageArgs(c.Args)
		}
	}
}

// printRemoteEntry emits the stable labeled data lines the desktop shell
// parses (the `rk desktop status` labeled-line precedent).
func printRemoteEntry(sink outputSink, r remote.Remote) {
	sink.Dataf("Name:   %s\n", r.Name)
	sink.Dataf("Target: %s\n", r.Target)
	sink.Dataf("Local:  %s\n", r.Origin())
}

func runRemoteAdd(cmd *cobra.Command, args []string) error {
	sink := newSink(cmd)
	target := args[0]
	if msg := validate.ValidateRemoteTarget(target); msg != "" {
		return fmt.Errorf("invalid target: %s", msg)
	}
	nameFlag, _ := cmd.Flags().GetString("name")
	portFlag, _ := cmd.Flags().GetInt("local-port")

	path, err := remotesPathFn()
	if err != nil {
		return err
	}
	f, err := remote.Load(path)
	if err != nil {
		return err
	}

	// Idempotent re-add: the same target reprints its registration, but
	// conflicting overrides are an error, never a silent mutation (the local
	// port is immutable by design).
	if existing := f.FindByTarget(target); existing != nil {
		if nameFlag != "" && nameFlag != existing.Name {
			return fmt.Errorf("target %s is already registered as %q — remove it first to rename", target, existing.Name)
		}
		if portFlag != 0 && portFlag != existing.LocalPort {
			return fmt.Errorf("target %s already has local port %d — the port is fixed for the remote's lifetime", target, existing.LocalPort)
		}
		sink.Notef("Already registered.\n")
		printRemoteEntry(sink, *existing)
		return nil
	}

	name := nameFlag
	if name == "" {
		name, err = remote.DefaultName(target)
		if err != nil {
			return err
		}
	} else if msg := validate.ValidateRemoteName(name); msg != "" {
		return fmt.Errorf("invalid --name: %s", msg)
	}
	if f.FindByName(name) != nil {
		return fmt.Errorf("a remote named %q already exists — pick another with --name", name)
	}

	port, err := remote.AssignPort(f, liveTCPPortsFn(cmd.Context()), portFlag)
	if err != nil {
		return err
	}

	entry := remote.Remote{Name: name, Target: target, LocalPort: port}
	f.Remotes = append(f.Remotes, entry)
	if err := remote.Save(path, f); err != nil {
		return err
	}
	printRemoteEntry(sink, entry)
	sink.Notef("Next: rk remote connect %s\n", name)
	return nil
}

func runRemoteConnect(cmd *cobra.Command, args []string) error {
	sink := newSink(cmd)
	path, err := remotesPathFn()
	if err != nil {
		return err
	}
	res, err := remote.Connect(cmd.Context(), path, args[0], displayVersion(), func(format string, a ...any) {
		sink.Notef(format+"\n", a...)
	})
	if err != nil {
		return err
	}
	if res.Installed {
		sink.Notef("installed rk v%s on %s\n", res.RemoteVersion, res.Remote.Name)
	}
	if res.Updated {
		sink.Notef("updated rk on %s to v%s\n", res.Remote.Name, res.RemoteVersion)
	}
	// The origin is the machine-consumable result — the final stdout line.
	sink.Dataf("%s\n", res.Origin)
	return nil
}

func runRemoteList(cmd *cobra.Command, _ []string) error {
	sink := newSink(cmd)
	path, err := remotesPathFn()
	if err != nil {
		return err
	}
	f, err := remote.Load(path)
	if err != nil {
		return err
	}
	if len(f.Remotes) == 0 {
		sink.Dataf("No remotes registered. Add one: rk remote add <target>\n")
		return nil
	}

	tunnels := remote.ListTunnels(cmd.Context())
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 2, 8, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tTARGET\tLOCAL\tTUNNEL\tREMOTE DAEMON")
	for _, r := range f.Remotes {
		st := remote.Inspect(cmd.Context(), r, tunnels)
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			r.Name, r.Target, r.Origin(), tunnelWord(st.TunnelUp), st.Daemon)
	}
	return w.Flush()
}

func tunnelWord(up bool) string {
	if up {
		return "up"
	}
	return "down"
}

func runRemoteStatus(cmd *cobra.Command, args []string) error {
	sink := newSink(cmd)
	path, err := remotesPathFn()
	if err != nil {
		return err
	}
	f, err := remote.Load(path)
	if err != nil {
		return err
	}
	r := f.FindByName(args[0])
	if r == nil {
		return fmt.Errorf("no remote named %q", args[0])
	}

	st := remote.Inspect(cmd.Context(), *r, remote.ListTunnels(cmd.Context()))
	sink.Dataf("Name:          %s\n", r.Name)
	sink.Dataf("Target:        %s\n", r.Target)
	sink.Dataf("Local:         %s\n", r.Origin())
	sink.Dataf("Tunnel:        %s\n", tunnelWord(st.TunnelUp))
	sink.Dataf("Remote daemon: %s\n", st.Daemon)
	if st.RemoteVersion != "" {
		sink.Dataf("Remote rk:     v%s\n", st.RemoteVersion)
	}
	sink.Dataf("Local rk:      %s\n", displayVersion())
	switch {
	case remote.VersionOlder(st.RemoteVersion, displayVersion()):
		sink.Dataf("Skew:          remote is older — 'rk remote connect %s' will update it\n", r.Name)
	case remote.VersionNewer(st.RemoteVersion, displayVersion()):
		sink.Dataf("Skew:          remote is newer — left untouched (connect never downgrades)\n")
	}
	return nil
}

func runRemoteDisconnect(cmd *cobra.Command, args []string) error {
	sink := newSink(cmd)
	path, err := remotesPathFn()
	if err != nil {
		return err
	}
	r, err := remote.Disconnect(cmd.Context(), path, args[0])
	if err != nil {
		return err
	}
	sink.Dataf("Disconnected %s (tunnel closed; the remote daemon keeps running)\n", r.Name)
	return nil
}

func runRemoteRemove(cmd *cobra.Command, args []string) error {
	sink := newSink(cmd)
	path, err := remotesPathFn()
	if err != nil {
		return err
	}
	r, err := remote.RemoveRemote(cmd.Context(), path, args[0])
	if err != nil {
		return err
	}
	sink.Dataf("Removed %s (the remote installation is untouched)\n", r.Name)
	return nil
}
