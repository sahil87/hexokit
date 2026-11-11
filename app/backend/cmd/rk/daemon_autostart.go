package main

import (
	"context"
	"fmt"
	"io"
	"runtime"

	"rk/internal/daemon/autostart"

	"github.com/spf13/cobra"
)

// autostartGOOS is the runtime.GOOS seam (the desktopGOOS/guiGOOS idiom): it
// picks the backend, so tests drive every platform's backend from any host.
var autostartGOOS = runtime.GOOS

// autostartBackendFn resolves the backend for autostartGOOS; tests replace it
// with a fake so no verb ever reaches a real service manager.
var autostartBackendFn = func() (autostart.Backend, error) {
	return autostart.For(autostartGOOS)
}

var daemonAutostartCmd = &cobra.Command{
	Use:   "autostart",
	Short: "Start the daemon once at boot or login (systemd user unit / LaunchAgent)",
	Long: `Register the run-kit daemon with the OS's per-user service manager so it
starts once at boot (Linux, with lingering) or login (Linux without
lingering, macOS). The OS starts it once and never restarts it: a crashed
daemon stays down until 'run-kit daemon start', as without autostart.

The daemon is started through your login shell, so it gets the environment
your login profile sets (.profile / .zprofile) — not what only an
interactive rc file (.bashrc / .zshrc) sets.

Subcommands:
  on      Register autostart (--now also starts the daemon now)
  off     Remove the registration; never stops a running daemon
  status  Show whether autostart is registered, enabled, and its last result

Off by default.`,
}

var daemonAutostartOnCmd = &cobra.Command{
	Use:   "on",
	Short: "Register the daemon to start at boot or login",
	Long: `Write the per-user service registration (a systemd user unit on Linux, a
LaunchAgent on macOS) and enable it. Idempotent. Without --now the daemon
starts at the next boot or login; with --now it is also started now through
the service manager (a no-op when it is already running).`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		now, _ := cmd.Flags().GetBool("now")
		return runAutostartVerb(cmd, func(ctx context.Context, b autostart.Backend) (autostart.Result, error) {
			return b.On(ctx, autostart.OnOptions{Now: now})
		}, writeAutostartOnText)
	},
}

var daemonAutostartOffCmd = &cobra.Command{
	Use:   "off",
	Short: "Remove the autostart registration (the running daemon keeps running)",
	Long: `Unregister and delete the per-user service registration. Idempotent. Never
stops a running daemon — use 'run-kit daemon stop' for that. Refuses to
delete a file at the registration path that rk did not write.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runAutostartVerb(cmd, func(ctx context.Context, b autostart.Backend) (autostart.Result, error) {
			return b.Off(ctx)
		}, writeAutostartOffText)
	},
}

var daemonAutostartStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show the daemon autostart registration",
	Long: `Show whether daemon autostart is registered and enabled, whether it starts
at boot or only at login, the last start's result, and any advice (for
example a stale registration, or what a login shell does not read).
Read-only.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runAutostartVerb(cmd, func(ctx context.Context, b autostart.Backend) (autostart.Status, error) {
			return b.Status(ctx)
		}, writeAutostartStatusText)
	},
}

func init() {
	daemonAutostartOnCmd.Flags().Bool("now", false, "Also start the daemon now through the service manager")
	for _, c := range []*cobra.Command{daemonAutostartOnCmd, daemonAutostartOffCmd, daemonAutostartStatusCmd} {
		c.Flags().Bool("json", false, "Emit a machine-readable JSON object inside the {\"ok\",\"result\"} envelope")
		daemonAutostartCmd.AddCommand(c)
	}
}

// runAutostartVerb resolves the backend, runs one verb, and renders its
// outcome as the --json envelope or as text.
func runAutostartVerb[T any](cmd *cobra.Command, verb func(context.Context, autostart.Backend) (T, error), text func(io.Writer, T)) error {
	jsonOut, _ := cmd.Flags().GetBool("json")
	sink := newSink(cmd)

	b, err := autostartBackendFn()
	if err == nil {
		var out T
		out, err = verb(cmd.Context(), b)
		if err == nil {
			if jsonOut {
				return sink.Envelope(out, nil)
			}
			text(cmd.OutOrStdout(), out)
			return nil
		}
	}
	if jsonOut {
		return sink.Envelope(nil, err)
	}
	return err
}

func writeAutostartOnText(out io.Writer, r autostart.Result) {
	if r.Changed {
		fmt.Fprintf(out, "Autostart on: %s (%s)\n", r.Name, r.Path)
	} else {
		fmt.Fprintf(out, "Autostart already on: %s (%s)\n", r.Name, r.Path)
	}
	if r.Started {
		fmt.Fprintln(out, "Daemon start requested through the service manager.")
	}
	writeAutostartHints(out, r.Hints)
}

func writeAutostartOffText(out io.Writer, r autostart.Result) {
	if r.Changed {
		fmt.Fprintf(out, "Autostart off: removed %s (%s)\n", r.Name, r.Path)
	} else {
		fmt.Fprintf(out, "Autostart already off: %s\n", r.Name)
	}
	fmt.Fprintln(out, "A running daemon is left running.")
	writeAutostartHints(out, r.Hints)
}

func writeAutostartStatusText(out io.Writer, s autostart.Status) {
	state := "off"
	switch {
	case s.Registered && s.Enabled:
		state = "on (" + s.StartsAt + ")"
	case s.Registered:
		state = "registered but disabled"
	}
	fmt.Fprintf(out, "Autostart: %s\n", state)
	fmt.Fprintf(out, "  Manager: %s (%s)\n", s.Manager, s.Name)
	file := s.Path
	if !s.Registered {
		file += " (absent)"
	} else if s.Stale {
		file += " (stale)"
	}
	fmt.Fprintf(out, "  File:    %s\n", file)
	if s.Linger != nil {
		linger := "off"
		if *s.Linger {
			linger = "on"
		}
		fmt.Fprintf(out, "  Linger:  %s\n", linger)
	}
	if s.Registered {
		last := s.LastResult
		if s.LastExitCode != nil {
			last = fmt.Sprintf("exit %d", *s.LastExitCode)
			if s.LastResult != "" {
				last += " (" + s.LastResult + ")"
			}
		}
		if last == "" {
			last = "unknown"
		}
		fmt.Fprintf(out, "  Last:    %s\n", last)
	}
	fmt.Fprintf(out, "  Runs:    %s -lc '… %s daemon start --if-not-running'\n", s.Shell, s.RKPath)
	writeAutostartHints(out, s.Hints)
}

func writeAutostartHints(out io.Writer, hints []string) {
	for _, h := range hints {
		fmt.Fprintf(out, "Hint: %s\n", h)
	}
}
