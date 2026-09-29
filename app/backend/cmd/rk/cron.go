package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"rk/internal/cron"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk cron — the scheduling-substrate command family (docs/specs/cron.md):
// durable per-server cron entries plus the invoker verb. The entry-file-scoped
// verbs (add, edit, list, rm, mute, pin) resolve one tmux server — the entry
// file's
// slug — via the family's persistent -L/--server flag; `tick` is the exception:
// cron.Tick sweeps every live server by design, so it rejects an explicitly-set
// -L rather than silently ignoring it (the muxRejectInheritedServerFlag
// posture). Server resolution order mirrors `rk mux`: -L wins, else the
// caller's own server derived from the original $TMUX socket basename, else the
// default server. The resolved name MUST pass cron.ValidSlug before any entry
// path is built — slugs are tmux socket names, and the closed alphabet is what
// keeps a crafted socket name from traversing the state dir.

var cronServerFlag string

var cronCmd = &cobra.Command{
	Use:   "cron",
	Short: "Scheduled agent prompts (add, edit, list, rm, mute, pin, tick)",
	Long: "Durable, server-scoped cron entries for agent panes: `add` records an " +
		"entry (a prompt plus a schedule — `--every`, `--idle-every`, `--backoff`, " +
		"or `--cron`) " +
		"in the resolved server's intent file, auto-capturing the caller's pane " +
		"as creator and default target. This is not a system cron: nothing is executed. The prompt is text for an agent — at fire time " +
		"rk types it into the target agent's chat through the injection engine " +
		"and presses Enter, exactly as if a person had typed it; it is never run " +
		"as a command — to run a command, ask the agent to run it. `list` prints " +
		"the entries and their last " +
		"delivery, derived from disk only (no tmux probes); `edit` changes one " +
		"entry's schedule or policies in place (target and creator are " +
		"immutable); `rm`, `mute`, and " +
		"`pin` mutate one entry by id; `tick` runs one evaluation sweep across " +
		"every live server — flock-guarded, idempotent, safe to invoke " +
		"repeatedly. Entry files live under $XDG_STATE_HOME/hexokit/cron/, keyed " +
		"by tmux server name: -L wins, else your own server (from $TMUX), else " +
		"the default server. Agent briefing: `run-kit skill cron`.",
}

func init() {
	cronCmd.PersistentFlags().StringVarP(&cronServerFlag, "server", "L", "",
		"tmux server name (entry-file-scoped verbs: add/edit/list/rm/mute/pin; default: the caller's own server from $TMUX, else the default server)")
	cronCmd.AddCommand(cronAddCmd)
	cronCmd.AddCommand(cronEditCmd)
	cronCmd.AddCommand(cronListCmd)
	cronCmd.AddCommand(cronRmCmd)
	cronCmd.AddCommand(cronMuteCmd)
	cronCmd.AddCommand(cronPinCmd)
	cronCmd.AddCommand(cronTickCmd)
}

// cronRejectInheritedServerFlag refuses an explicitly-set inherited -L/--server
// on `tick`: the sweep is all-live-servers by design, so silently ignoring the
// flag would read as a server-scoped run while operating globally. Keyed on
// the flag's Changed state so an unset flag never fires.
func cronRejectInheritedServerFlag(cmd *cobra.Command) error {
	f := cmd.InheritedFlags().Lookup("server")
	if f == nil || !f.Changed {
		return nil
	}
	return usageError(fmt.Errorf("--server (-L) does not apply to %q — tick sweeps every live server", cmd.CommandPath()))
}

// cronOriginalTMUXFn is the $TMUX seam (the mux.go pattern): internal/tmux's
// init() strips $TMUX from the process, so the captured OriginalTMUX is fixed
// at package-init time and cannot be varied with t.Setenv.
var cronOriginalTMUXFn = func() string { return tmux.OriginalTMUX }

// cronDirFn is the cron-state-dir seam; tests redirect it to a temp dir.
var cronDirFn = cron.DefaultDir

// cronServer resolves the tmux server whose entry file the verb targets: -L
// wins; else the caller's own server derived from the original $TMUX socket
// basename; else the default server.
func cronServer() string {
	if cronServerFlag != "" {
		return cronServerFlag
	}
	tmuxEnv := cronOriginalTMUXFn()
	if tmuxEnv == "" {
		return "default"
	}
	socket := tmuxEnv
	if i := strings.IndexByte(socket, ','); i >= 0 {
		socket = socket[:i]
	}
	if socket == "" {
		return "default"
	}
	return filepath.Base(socket)
}

// cronSlug resolves the server and validates it as a cron file slug before any
// path is built (a validated slug can never traverse the state dir).
func cronSlug() (string, error) {
	slug := cronServer()
	if !cron.ValidSlug(slug) {
		return "", fmt.Errorf("invalid server slug %q (slugs match ^[A-Za-z0-9_-]+$; pass -L with a tmux socket name)", slug)
	}
	return slug, nil
}

// cronDir resolves the cron state root through the seam.
func cronDir() (string, error) {
	return cronDirFn()
}

// cronScheduleSummary renders a schedule for the list table and add
// confirmation ("every 1h" / "backoff 1m→30m" / "cron <expr> (catch-up once)").
func cronScheduleSummary(s cron.Schedule) string {
	switch s.Kind {
	case cron.ScheduleEvery:
		return "every " + cronDurationShort(s.Interval.Duration)
	case cron.ScheduleBackoff:
		return fmt.Sprintf("backoff %s→%s", cronDurationShort(s.Min.Duration), cronDurationShort(s.Max.Duration))
	case cron.ScheduleCron:
		if s.CatchUp == cron.CatchUpOnce {
			return "cron " + s.Expr + " (catch-up once)"
		}
		return "cron " + s.Expr
	}
	return s.Kind
}

// cronDurationShort renders a duration compactly, dropping zero-valued
// components (1h, 30m, 1m30s, 90s) where time.Duration.String would print
// "1h0m0s".
func cronDurationShort(d time.Duration) string {
	if d == 0 {
		return "0s"
	}
	if d%time.Second != 0 {
		return d.String()
	}
	out := ""
	if h := d / time.Hour; h > 0 {
		out += fmt.Sprintf("%dh", h)
		d %= time.Hour
	}
	if m := d / time.Minute; m > 0 {
		out += fmt.Sprintf("%dm", m)
		d %= time.Minute
	}
	if s := d / time.Second; s > 0 {
		out += fmt.Sprintf("%ds", s)
	}
	return out
}

// cronTargetSummary renders a target for the list table and add confirmation
// ("role:operator" / "pane:%12" / "session:<id>").
func cronTargetSummary(t cron.Target) string {
	switch t.Kind {
	case cron.TargetRole:
		return "role:" + t.Role
	case cron.TargetSession:
		return "session:" + t.Session
	case cron.TargetPane:
		return "pane:" + t.Pane
	}
	return t.Kind
}
