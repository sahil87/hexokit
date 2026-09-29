package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"rk/internal/ports"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// rk agent hook — the stable interface that agent-harness hooks invoke to report
// generic agent-lifecycle state into the @rk_agent_state pane option (see
// docs/specs/agent-state.md). It replaces the former self-contained shell
// one-liner: the harness config now carries only a thin
//
//	/bin/sh -c '[ -n "$TMUX_PANE" ] || exit 0; "<abs-rk>" agent hook --agent claude <state> 2>/dev/null || true'
//
// wrapper (installed by `run-kit agent setup`), and ALL logic — the
// comm-validated ancestor walk, the value formatting — lives here in Go where it
// is testable and tracks the binary on `brew upgrade hexokit`, with no settings
// churn and no agent session restarts. The @rk_agent_state VALUE SCHEMA is
// unchanged, so every reader (internal/tmux, internal/sessions, the frontend) is
// untouched.
//
// NEVER-FAIL CONTRACT: every path exits 0. Claude Code treats hook exit code 2 as
// blocking and other non-zero exits as warnings, so a broken hook must never
// produce either. main's execute() os.Exit(1)s on ANY error rootCmd.Execute()
// returns, so this command must swallow every error class ITSELF, before it can
// propagate: RunE always returns nil (runtime path), ArbitraryArgs disables
// arg-count validation, FParseErrWhitelist.UnknownFlags absorbs unknown flags,
// and SetFlagErrorFunc (in init) swallows KNOWN-flag parse errors (e.g. `--agent`
// with its value missing) — the one class the other three don't cover.
// SilenceErrors/SilenceUsage keep cobra from printing on any of these paths.

// agentHookCmdTimeout bounds every ps/tmux subprocess the hook spawns, per
// Constitution §I (Process Execution: 5-10s for short-lived helpers). A hung
// tmux or ps must never stall the agent's turn.
const agentHookCmdTimeout = 5 * time.Second

// agentHookAncestorHops is the ancestor-walk bound. Raised from the shell hook's
// 3 to 5: delegating through the binary adds a wrapper layer
// (claude → hook shell → sh -c → rk, and sh may or may not exec the final rk),
// so a few extra bounded hops are cheap and cover the deeper chain.
const agentHookAncestorHops = 5

// agentHookStampToken is the distinguished positional token of the SessionStart
// registry row. It stamps @rk_pane_agent_session (the pane→session mapping) on every fire
// that yields a session id, and — when the stdin payload parses and its source
// is NOT the provider's mid-turn compaction source (agentRuntime.compactSource)
// — additionally writes @rk_agent_state idle:<epoch>[:<pid>]: claude and codex
// SessionStart hooks fire on startup/resume/clear/compact, and source=compact
// fires MID-TURN, where an idle write would clobber a live `active` state, so
// that one source is excluded. The startup/resume/clear idle write is the
// boot-ready signal (state present ⇒ hooks fired ⇒ the TUI is up) and also
// clears a stale waiting/active left in the pane by a previous agent. An
// unparseable payload skips both writes: the idle write (fail-safe against the
// mid-turn clobber) and the agent-session stamp (no session id can be decoded).
// The three canonical agent states plus this token are the only tokens that
// write anything; any other is a silent no-op.
const agentHookStampToken = "stamp"

// hookStdinReadLimit bounds the stdin JSON read (~1 MiB). The hook payload is a
// small JSON object; the bound guards against a pathological/hung producer
// blocking the agent's turn while we read.
const hookStdinReadLimit = 1 << 20

// agentSessionOption is the @rk_pane_agent_session pane-option name, aliased from
// internal/tmux so the cross-repo convention has ONE source of truth per binary
// (A-021) — the writer and the reader (internal/tmux) never drift.
const agentSessionOption = tmux.AgentSessionOption

// newAgentHookCmd builds one instance of the hook command. A cobra command
// object cannot have two parents, so the family member (`rk agent hook`) and the
// root alias (`rk agent-hook`) are two instances sharing the runAgentHook core;
// the --agent flag binds per-instance. BOTH instances carry the complete
// never-fail machinery — ArbitraryArgs, FParseErrWhitelist.UnknownFlags,
// SilenceErrors/SilenceUsage, and a per-command SetFlagErrorFunc(→ nil) that
// shadows root's usage-error func (see root.go) — because a hook-fire path must
// exit 0 with no output no matter which installed generation invoked it.
func newAgentHookCmd(use string) *cobra.Command {
	var agentFlag string
	c := &cobra.Command{
		Use:   use,
		Short: "Report an agent's lifecycle state to run-kit (invoked by installed hooks)",
		Long: "Write the " + tmux.AgentStateOption + " tmux pane option for the current pane so " +
			"run-kit can show this agent's active/waiting/idle state. This is the " +
			"stable interface installed by `run-kit agent setup` — the harness config " +
			"carries only a thin wrapper and all logic lives in the binary, so hook " +
			"behavior tracks `brew upgrade hexokit` with no settings changes or session " +
			"restarts. It no-ops outside tmux and always exits 0 (a hook must never " +
			"fail or block the agent).",
		// Args is deliberately ArbitraryArgs (not ExactArgs(1)): cobra's arg-count
		// validators run BEFORE RunE and return a non-zero error, which would exit the
		// process non-zero — Claude Code reads a non-zero hook exit as a warning (and 2
		// as blocking). The never-fail contract must hold for EVERY invocation, so arg
		// validation moves into RunE, which always returns nil. SilenceErrors/Usage
		// keep cobra from printing anything on the hot path.
		Args:          cobra.ArbitraryArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		// FParseErrWhitelist.UnknownFlags: an unknown flag on the hook-fire path must
		// not error out before RunE (cobra's flag-parse error exits non-zero, which the
		// harness reads as a warning). Whitelisting unknown flags lets them fall
		// through as (ignored) args so the never-fail contract holds for EVERY
		// invocation. The installed wrapper only ever passes known flags anyway.
		FParseErrWhitelist: cobra.FParseErrWhitelist{UnknownFlags: true},
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) != 1 {
				// Malformed invocation — no state to write. Silent no-op, exit 0.
				return nil
			}
			runAgentHook(cmd.Context(), agentFlag, args[0])
			return nil
		},
	}
	c.Flags().StringVar(&agentFlag, "agent", "claude", "Agent harness provider whose registry entry drives payload parsing and pid resolution (claude, codex, gemini, copilot, kimi, opencode, agy)")
	// KNOWN-flag parse errors (e.g. `--agent` present but its value missing) are
	// returned by pflag BEFORE RunE and are NOT covered by ArbitraryArgs (arg-count
	// only) or FParseErrWhitelist (unknown flags only). Swallowing them here is the
	// only seam that keeps such an invocation at exit 0 (never-fail contract) —
	// main's execute() os.Exit(1)s on any error Execute() returns. RunE then sees
	// an empty/partial args slice and no-ops without writing.
	c.SetFlagErrorFunc(func(*cobra.Command, error) error { return nil })
	return c
}

var (
	// agentHookFamilyCmd is the `rk agent hook` family member.
	agentHookFamilyCmd = newAgentHookCmd("hook <state>")
	// agentHookAliasCmd is the PERMANENT hidden root alias: installed
	// settings.json hook lines (and harness session snapshots) carry the literal
	// `agent-hook` invocation frozen at install time, so this form must resolve
	// — silently, with the full never-fail contract — FOREVER (cli-layering.md
	// delegation rule 3: machine-invoked entry points are contracts). It is NOT
	// deprecated and MUST NOT warn, and no cleanup sweep may remove it.
	agentHookAliasCmd = func() *cobra.Command {
		c := newAgentHookCmd("agent-hook <state>")
		c.Hidden = true
		return c
	}()
)

// runAgentHook is the testable core: guard on $TMUX_PANE, validate the agent and
// token, and — depending on the token — write @rk_agent_state (with a
// comm-validated ancestor-walk pid) and/or stamp @rk_pane_agent_session from the
// hook stdin session id. Every failure is silent — it returns without error on
// every path so the caller always exits 0.
//
// Token dispatch:
//   - active|waiting|idle → write @rk_agent_state, AND stamp
//     @rk_pane_agent_session if the hook stdin carries a session id (every-fire
//     refresh: session ids rotate on /clear + /compact, and this also stamps
//     already-running agents on `brew upgrade rk` with zero settings churn).
//   - stamp → stamp @rk_pane_agent_session (session id permitting), AND write
//     @rk_agent_state idle when the parsed payload's source is not "compact"
//     (the mid-turn source — see agentHookStampToken). Used by the SessionStart
//     registry row; the idle write is the boot-ready signal and clears stale
//     state from the pane's previous agent.
//   - anything else → silent no-op.
func runAgentHook(parent context.Context, agent, token string) {
	if parent == nil {
		parent = context.Background()
	}

	// $TMUX_PANE guard (defense in depth — the shell wrapper also short-circuits
	// on this). No pane → not inside a tmux pane → nothing to write.
	pane := os.Getenv("TMUX_PANE")
	if pane == "" {
		return
	}

	// Validate the token: the three canonical agent states (aliased from
	// internal/tmux, A-021) write agent-state; the stamp token writes the
	// agent-session identity only. Any other token writes nothing.
	writeState := isAgentState(token)
	if !writeState && token != agentHookStampToken {
		return
	}

	// Resolve the provider's runtime descriptor from the shared registry
	// (agent_registry.go) — by provider token or comm literal. An unknown
	// --agent writes nothing (never-fail). The descriptor drives the comm
	// walk, the payload's session-id field shape, and the compact gate, with
	// NO dependence on any installer entry.
	rt, ok := agentRuntimeForName(agent)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(parent, agentHookCmdTimeout)
	defer cancel()

	// Read the hook stdin ONCE: the payload feeds the agent-session stamp (session
	// id) and the stamp token's boot-write gate (source). Every failure mode is
	// silent — ok=false skips the boot write and the agent-session stamp, while a
	// state fire's agent-state write below still proceeds.
	in, payloadOK := readHookInput(hookStdin())
	sessionID := rt.hookSessionID(in)

	// A provider whose loop-end event can fire with background tasks still
	// running (agy's Stop) accepts an idle write only when the payload proves
	// fullyIdle — anything less stays unknown rather than manufacturing an
	// at-rest signal. The identity stamp below still proceeds.
	if writeState && token == agentStateIdle && rt.idleRequiresFullyIdle &&
		(!payloadOK || in.FullyIdle == nil || !*in.FullyIdle) {
		writeState = false
	}

	// The stamp token's boot write fires on every SessionStart source EXCEPT the
	// provider's mid-turn compaction source. An unparseable payload withholds it —
	// fail-safe against clobbering a live active state.
	bootStamp := token == agentHookStampToken && payloadOK && !rt.isCompactSource(in.Source)
	if writeState || bootStamp {
		// Resolve the agent pid via the bounded, comm-validated ancestor walk. 0
		// means "could not validate an ancestor" → the pid segment is omitted (a
		// two-segment value that degrades to the reader's legacy shell-name
		// fallback), never a wrong pid.
		state := token
		if bootStamp {
			state = agentStateIdle
		}
		pid := resolveAgentPID(ctx, os.Getppid(), rt.comm)
		writeAgentState(ctx, pane, state, pid)
	}

	// Stamp @rk_pane_agent_session from the hook stdin session id, on EVERY fire
	// that yields one (states and the stamp token alike). Absent/malformed/
	// oversized stdin → no stamp; the agent-state write above still proceeded.
	// The stamped prefix is the canonical PROVIDER token (never the comm — kimi's
	// comm is kimi-code but its provider token is kimi).
	if payloadOK && isValidSessionID(sessionID) {
		writeAgentSession(ctx, pane, rt.provider, sessionID)
	}
}

// hookInput is the subset of the agent-harness hook stdin JSON the writer reads.
// Every supported harness carries the session identity on all hook events;
// claude, codex, gemini, and kimi use snake_case `session_id`, copilot's
// camelCase event format uses `sessionId`, and agy's protojson payloads use
// `conversationId` (the provider's registry descriptor picks the authoritative
// field). SessionStart events additionally carry source, which gates the stamp
// token's boot write against the provider's mid-turn compaction source. agy's
// Stop carries fullyIdle, gating its idle write (background tasks may still be
// running at loop termination). Every other field is ignored. Unknown JSON
// keys are tolerated by encoding/json.
type hookInput struct {
	SessionID      string `json:"session_id"`
	SessionIDCamel string `json:"sessionId"`
	ConversationID string `json:"conversationId"`
	Source         string `json:"source"`
	FullyIdle      *bool  `json:"fullyIdle"`
}

// hookStdinFn is a package-level seam so runAgentHook can be tested with an
// injected reader instead of the process's real stdin.
var hookStdinFn = func() io.Reader { return os.Stdin }

func hookStdin() io.Reader { return hookStdinFn() }

// readHookInput reads the hook payload from r. It is deliberately conservative:
//
//   - TTY guard: if r is os.Stdin attached to a terminal (os.ModeCharDevice), it
//     is NOT read — a manual `rk agent hook` invocation in a terminal must never
//     block waiting for stdin.
//   - Bounded: reads through an io.LimitReader (~1 MiB) so a hung/pathological
//     producer can't stall the agent's turn.
//   - Single object: json.Decoder.Decode returns after ONE complete JSON object,
//     so it does not depend on stdin EOF (which the harness docs don't guarantee).
//
// Every failure path returns ok=false — never an error, preserving the
// never-fail contract.
func readHookInput(r io.Reader) (hookInput, bool) {
	if r == nil {
		return hookInput{}, false
	}
	// TTY guard: skip a terminal stdin outright (manual invocation).
	if f, ok := r.(*os.File); ok {
		info, err := f.Stat()
		if err != nil {
			return hookInput{}, false
		}
		if info.Mode()&os.ModeCharDevice != 0 {
			return hookInput{}, false
		}
	}
	dec := json.NewDecoder(io.LimitReader(r, hookStdinReadLimit))
	var in hookInput
	if err := dec.Decode(&in); err != nil {
		return hookInput{}, false
	}
	return in, true
}

// isValidSessionID mirrors internal/tmux's agent-session-ref validation
// (non-empty, no whitespace or control chars) so the writer never stamps a value
// the reader would reject. Kept in this binary (the reader's isAgentSessionRef
// is unexported); the rule is small and stable.
func isValidSessionID(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c <= ' ' || c == 0x7f {
			return false
		}
	}
	return true
}

// isAgentState reports whether s is one of the three canonical agent states.
// Mirrors internal/tmux's own (unexported) validator against the same aliased
// constants — the reader and writer share one convention (A-021).
func isAgentState(s string) bool {
	return s == agentStateActive || s == agentStateWaiting || s == agentStateIdle
}

// resolveAgentPID walks up the process ancestry from startPPID, comparing each
// ancestor's comm against the agent literal, bounded to agentHookAncestorHops.
// It returns the pid of the first ancestor (including startPPID itself) whose
// comm equals comm, or 0 if none matches within the bound.
//
// Harnesses spawn hook commands through an EPHEMERAL intermediate shell that
// exits the moment the hook finishes, so a raw $PPID records that dead wrapper
// (the reader's PID-liveness check would then suppress every value). The walk
// climbs to the real agent pid instead; returning 0 (→ omit the pid segment) is
// always preferred over recording a wrong pid.
func resolveAgentPID(ctx context.Context, startPPID int, comm string) int {
	p := startPPID
	for i := 0; i < agentHookAncestorHops; i++ {
		if p <= 0 {
			return 0
		}
		if processComm(ctx, p) == comm {
			return p
		}
		p = processPPID(ctx, p)
	}
	return 0
}

// processCommFn / processPPIDFn are package-level seams so the walk is unit
// testable without spawning a real ancestor chain (mirrors agentProcessAlive /
// findPortOwnerFn elsewhere in this package).
var (
	processCommFn = processCommImpl
	processPPIDFn = processPPIDImpl
)

// processComm returns the comm (executable basename) of the given pid, or "" on
// failure. Indirects through the test seam.
func processComm(ctx context.Context, pid int) string { return processCommFn(ctx, pid) }

// processPPID returns the parent pid of the given pid, or 0 on failure. Indirects
// through the test seam.
func processPPID(ctx context.Context, pid int) int { return processPPIDFn(ctx, pid) }

// processCommImpl reads a pid's comm (executable basename) by delegating to
// ports.ResolveCommand: Linux reads /proc/<pid>/comm with no subprocess;
// elsewhere it shells out to `ps -o comm=` via exec.CommandContext with a
// timeout. Reused rather than re-implemented so the two comm-resolution sites
// cannot drift.
func processCommImpl(ctx context.Context, pid int) string {
	if pid <= 0 {
		return ""
	}
	return ports.ResolveCommand(ctx, pid)
}

// processPPIDImpl returns a pid's parent pid, or 0 on failure. On Linux it reads
// the "PPid:" line of /proc/<pid>/status with no subprocess — unlike
// /proc/<pid>/stat, the status file is line-keyed, so the stat file's
// comm-with-spaces/parens field-indexing hazard does not apply. Elsewhere it
// shells out to `ps -o ppid= -p` via exec.CommandContext with a timeout. The
// fast path matters: the walk makes up to ~4 ppid lookups per hook fire, and
// hooks fire on every agent lifecycle event.
func processPPIDImpl(ctx context.Context, pid int) int {
	if pid <= 0 {
		return 0
	}
	if runtime.GOOS == "linux" {
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
		if err != nil {
			return 0
		}
		return parseProcStatusPPID(string(data))
	}
	cctx, cancel := context.WithTimeout(ctx, agentHookCmdTimeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, "ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	ppid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || ppid <= 0 {
		return 0
	}
	return ppid
}

// parseProcStatusPPID extracts the PPid value from /proc/<pid>/status content
// (a line of the form "PPid:\t<pid>"). Returns 0 when the line is absent or
// malformed, and for the kernel's own PPid 0 (pid 1 / kernel threads) — which
// correctly terminates the ancestor walk.
func parseProcStatusPPID(content string) int {
	for _, line := range strings.Split(content, "\n") {
		if !strings.HasPrefix(line, "PPid:") {
			continue
		}
		ppid, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "PPid:")))
		if err != nil || ppid <= 0 {
			return 0
		}
		return ppid
	}
	return 0
}

// writeAgentStateFn is a package-level seam so runAgentHook can be tested without
// spawning tmux; the default writes via exec.CommandContext.
var writeAgentStateFn = writeAgentStateImpl

// writeAgentState writes the pane option with the UNCHANGED value schema
// "<state>:<epoch>[:<pid>]" — the pid segment is included only when pid > 0.
// Indirects through the test seam.
func writeAgentState(ctx context.Context, pane, state string, pid int) {
	writeAgentStateFn(ctx, pane, state, pid)
}

// agentHookTmuxRun is a package-level seam for the dual-write tmux invocation
// so tests can capture the argv without spawning tmux.
var agentHookTmuxRun = func(ctx context.Context, args []string) error {
	return tmux.Run(ctx, args, tmux.RunOpts{})
}

// dualWritePaneOption runs ONE tmux invocation that writes value to both the
// current pane option name and its retired previous-generation sibling:
//
//	tmux [-S <socket>] set-option -pt <pane> <new> <value> ; set-option -pt <pane> <old> <value>
//
// The `;` is a discrete argv element — tmux command chaining, no shell
// (Constitution §I), and one subprocess per hook fire instead of two. The
// legacy write is the deprecation-window contract: readers on older installs
// (and fab-kit) still read the retired name, so the write must land under both
// until the follow-up removal change drops the second command. Any error is
// swallowed — the hook must never fail the agent.
//
// The server is targeted via `-S <socket>` derived from the ORIGINAL $TMUX
// (tmux.OriginalTMUX), NOT os.Getenv("TMUX"): internal/tmux's init() strips
// $TMUX from the process so the daemon's bare tmux calls hit the default socket,
// and importing that package here triggers that strip. OriginalTMUX captures the
// value in a package-level var initializer that runs before init(), so it holds
// the caller's real socket — the pane's own server. Deriving -S from it (rather
// than relying on the child re-exporting $TMUX) also survives hook contexts like
// `tmux run-shell` that set $TMUX_PANE but not $TMUX. When it is empty we fall
// back to a bare invocation (best effort — the wrapper's `|| true` still holds).
func dualWritePaneOption(ctx context.Context, pane, option, legacyOption, value string) {
	args := tmuxSocketArgs(tmux.OriginalTMUX)
	args = append(args,
		"set-option", "-pt", pane, option, value,
		";",
		"set-option", "-pt", pane, legacyOption, value,
	)
	cctx, cancel := context.WithTimeout(ctx, agentHookCmdTimeout)
	defer cancel()
	// Errors are intentionally ignored (never-fail contract).
	_ = agentHookTmuxRun(cctx, args)
}

// writeAgentStateImpl writes the agent-state pane option under both names
// (dual-write — see dualWritePaneOption). Nothing user-provided is
// interpolated into a shell: state is a fixed registry literal, pane and
// socket are passed as discrete argv elements, and pid is an integer.
func writeAgentStateImpl(ctx context.Context, pane, state string, pid int) {
	value := formatAgentStateValue(state, time.Now().Unix(), pid)
	dualWritePaneOption(ctx, pane, tmux.AgentStateOption, tmux.LegacyAgentStateOption, value)
}

// writeAgentSessionFn is a package-level seam so runAgentHook can be tested
// without spawning tmux; the default writes via exec.CommandContext.
var writeAgentSessionFn = writeAgentSessionImpl

// writeAgentSession writes the @rk_pane_agent_session pane option with value
// "<provider>:<sessionID>". Indirects through the test seam.
func writeAgentSession(ctx context.Context, pane, provider, sessionID string) {
	writeAgentSessionFn(ctx, pane, provider, sessionID)
}

// writeAgentSessionImpl writes the agent-session pane option under both names
// (dual-write — see dualWritePaneOption). Nothing user-provided is interpolated
// into a shell: provider is a fixed registry comm literal, sessionID is a
// pre-validated argv element (isValidSessionID rejects whitespace/control),
// and pane/socket are discrete argv elements.
func writeAgentSessionImpl(ctx context.Context, pane, provider, sessionID string) {
	value := fmt.Sprintf("%s:%s", provider, sessionID)
	dualWritePaneOption(ctx, pane, agentSessionOption, tmux.LegacyAgentSessionOption, value)
}

// formatAgentStateValue formats the cross-repo @rk_agent_state value
// (docs/specs/agent-state.md § The Option): "<state>:<epoch_seconds>" when no
// pid was resolved (pid <= 0 — the two-segment legacy form readers fall back
// on), "<state>:<epoch_seconds>:<pid>" when one was. Pure — epoch is a
// parameter — so the byte-level contract is a testable unit; the schema is
// UNCHANGED by the agent hook indirection and readers (parseAgentState, the
// reconciler) are untouched.
func formatAgentStateValue(state string, epoch int64, pid int) string {
	if pid > 0 {
		return fmt.Sprintf("%s:%d:%d", state, epoch, pid)
	}
	return fmt.Sprintf("%s:%d", state, epoch)
}

// tmuxSocketArgs derives the `-S <socket>` server-targeting prefix from a $TMUX
// value, whose format is "<socket_path>,<server_pid>,<session_id>". The socket
// path is the first comma-separated field. Returns an empty slice when the value
// is unset or malformed (bare-tmux fallback to the default socket).
func tmuxSocketArgs(tmuxEnv string) []string {
	if tmuxEnv == "" {
		return nil
	}
	socket := tmuxEnv
	if i := strings.IndexByte(socket, ','); i >= 0 {
		socket = socket[:i]
	}
	if socket == "" {
		return nil
	}
	return []string{"-S", socket}
}
