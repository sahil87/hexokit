package main

import (
	"fmt"
	"path/filepath"
	"strings"

	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk mux — the tmux-substrate command family (docs/specs/cli-layering.md):
// operations that talk to tmux directly from the caller's context, with no
// daemon dependency. Thirteen members in two tiers, presented in three help
// groups (messaging / pane mechanics / server ops — the discoverability
// grouping docs/specs/agent-messaging.md settles). The pane-scoped tier takes the
// family's strict target grammar: `send` (deliver a message into an agent
// pane, gated on its @rk_agent_state) and `await` (block until a pane's agent
// state or a file signal fires) are the messaging pair; `capture` (scrollback
// capture with substrate-only enrichment), `kill` (agent-state-gated pane
// removal), and `process` (the pane's process tree with agent cross-check) are
// the substrate twins; `panes` and `sessions` are the server-wide enumeration
// queries — one row per pane / per session (with the name-derived role), no
// target. The operator tier: `new` creates a detached tmux
// server on a named socket, optionally marked @rk_ephemeral for the reap
// sweep; `adopt` converts an external server to rk-managed (stamp @rk_srv_managed,
// source the managed conf); `reap` is the operator-invoked janitor for leaked
// test servers; `snapshot` inspects and restores layout
// snapshots; `init-conf` scaffolds the tmux config; `guard` fronts the real
// tmux binary, refusing bare `kill-server` — the verb the installed PATH shim
// execs (tmux_guard.go). The old root-level forms (reaper, snapshot,
// init-conf) survive as hidden deprecation aliases at the root (reaper.go /
// snapshot.go / initconf.go); tmux-guard survives as a PERMANENT hidden alias
// (installed shims exec the literal name — see tmuxGuardAliasCmd).
//
// The family parent carries the shared persistent -L/--server flag (the
// `fab pane` pattern): every subcommand inherits it, but only the pane-scoped
// verbs and the `panes`/`sessions` enumerations consume it — the operator members reject
// an explicitly-set -L via
// muxRejectInheritedServerFlag rather than silently ignore it. `guard` is the
// exception: DisableFlagParsing means nothing is parsed and -L/-S flow
// verbatim into the tmux argv, where they are genuinely tmux's socket flags —
// so it does not call muxRejectInheritedServerFlag. Server resolution order:
// -L wins, else the caller's own server derived from the original $TMUX
// (socket basename — the same name ListServers and the -L primitives use),
// else the default server.

var muxServerFlag string

// The three rk mux help groups (docs/specs/agent-messaging.md § Surface and
// naming): messaging (send, await), pane mechanics (capture, kill, process,
// panes, sessions), server ops (new, adopt, reap, snapshot, init-conf, guard).
const (
	muxGroupMessaging = "messaging"
	muxGroupMechanics = "mechanics"
	muxGroupServerOps = "serverops"
)

var muxCmd = &cobra.Command{
	Use:   "mux",
	Short: "Tmux substrate operations (server create, messaging, pane capture/kill/process, pane/session enumeration, janitor, recovery, config scaffold, tmux guard)",
	Long: "Tmux substrate operations that talk to tmux directly from the caller's " +
		"context — no daemon dependency. `new` creates a detached tmux server on a " +
		"named socket, optionally marked ephemeral for the reap sweep; `send` " +
		"delivers a message into an agent's " +
		"pane gated on its "+tmux.AgentStateOption+", paste-probing before Enter and " +
		"detecting post-Enter non-submission; `await` " +
		"blocks until a pane's agent state (or a file signal) fires; `capture` " +
		"prints a pane's scrollback with substrate context (cwd, reconciled agent " +
		"state); `kill` removes a pane, refusing a pane whose agent is active or " +
		"waiting unless --force; `process` shows the process tree running in a " +
		"pane; `panes` enumerates every pane on the server, one row per pane, " +
		"with substrate facts (window, command, cwd, reconciled agent state); " +
		"`sessions` enumerates the server's sessions with their name-derived " +
		"roles (user, or run-kit infrastructure: pin/iso/control/operator/reserved). " +
		"`adopt` converts an external tmux server to rk-managed (stamp " +
		"@rk_srv_managed, source the managed config, roll back the stamp when the " +
		"reload fails). " +
		"`reap` reaps leaked test tmux servers and stale sockets by prefix; " +
		"`snapshot` inspects and restores layout snapshots; `init-conf` scaffolds " +
		"the default tmux.conf and tmux.d/ drop-in directory; `guard` fronts the " +
		"real tmux binary, refusing a bare `kill-server` (no explicit -L/-S) — " +
		"the verb the installed PATH shim execs.",
}

func init() {
	muxCmd.PersistentFlags().StringVarP(&muxServerFlag, "server", "L", "",
		"tmux server name (pane-scoped verbs: send/await/capture/kill/process, and the panes/sessions enumerations; default: the caller's own server from $TMUX, else the default server)")
	muxCmd.AddGroup(
		&cobra.Group{ID: muxGroupMessaging, Title: "Messaging:"},
		&cobra.Group{ID: muxGroupMechanics, Title: "Pane mechanics:"},
		&cobra.Group{ID: muxGroupServerOps, Title: "Server ops:"},
	)
	// GroupID is stamped here on the FAMILY instances only — never inside the
	// two-instance constructors (newReapCmd and kin): the hidden root aliases
	// those constructors also build are parented to rootCmd, which registers
	// none of these groups, and cobra panics at Execute on an undefined
	// GroupID. Every member must be grouped, or cobra renders the leftovers
	// under an "Additional Commands" bucket.
	for _, c := range []*cobra.Command{muxSendCmd, muxAwaitCmd} {
		c.GroupID = muxGroupMessaging
	}
	for _, c := range []*cobra.Command{muxCaptureCmd, muxKillCmd, muxProcessCmd, muxPanesCmd, muxSessionsCmd} {
		c.GroupID = muxGroupMechanics
	}
	for _, c := range []*cobra.Command{muxNewCmd, muxAdoptCmd, reapFamilyCmd, snapshotFamilyCmd, initConfFamilyCmd, muxGuardFamilyCmd} {
		c.GroupID = muxGroupServerOps
	}
	muxCmd.AddCommand(muxSendCmd)
	muxCmd.AddCommand(muxAwaitCmd)
	muxCmd.AddCommand(muxCaptureCmd)
	muxCmd.AddCommand(muxKillCmd)
	muxCmd.AddCommand(muxProcessCmd)
	muxCmd.AddCommand(muxPanesCmd)
	muxCmd.AddCommand(muxSessionsCmd)
	muxCmd.AddCommand(muxNewCmd)
	muxCmd.AddCommand(muxAdoptCmd)
	muxCmd.AddCommand(reapFamilyCmd)
	muxCmd.AddCommand(snapshotFamilyCmd)
	muxCmd.AddCommand(initConfFamilyCmd)
	muxCmd.AddCommand(muxGuardFamilyCmd)
}

// muxRejectInheritedServerFlag refuses an explicitly-set inherited -L/--server
// on a mux member that does not consume it: only the pane-scoped verbs
// (send/await/capture/kill/process) and the `panes` enumeration scope by
// server, so silently ignoring the
// flag on reap/snapshot/init-conf would read as a server-scoped run while
// operating globally. The check keys on the flag's Changed state (not its
// value) so an unset flag never fires. On the root aliases there is no
// inherited --server at all, so the lookup misses and the call is a no-op.
func muxRejectInheritedServerFlag(cmd *cobra.Command) error {
	f := cmd.InheritedFlags().Lookup("server")
	if f == nil || !f.Changed {
		return nil
	}
	return usageError(fmt.Errorf("--server (-L) does not apply to %q — it scopes only the pane-scoped verbs (send/await/capture/kill/process) and the panes enumeration", cmd.CommandPath()))
}

// muxOriginalTMUXFn is the $TMUX seam (the present.go pattern): internal/tmux's
// init() strips $TMUX from the process, so the captured OriginalTMUX is fixed
// at package-init time and cannot be varied with t.Setenv.
var muxOriginalTMUXFn = func() string { return tmux.OriginalTMUX }

// muxServer resolves the tmux server the mux verbs target: -L wins; else the
// caller's own server derived from the original $TMUX socket basename; else the
// default server. The $TMUX derivation (not -S socket prefixing) keeps every
// downstream call on the internal/tmux -L primitives, so CLI and daemon address
// servers by the same names.
func muxServer() string {
	if muxServerFlag != "" {
		return muxServerFlag
	}
	tmuxEnv := muxOriginalTMUXFn()
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
