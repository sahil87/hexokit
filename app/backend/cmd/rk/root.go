package main

import (
	"errors"
	"io"
	"os"
	"strings"

	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// version is set at build time via ldflags: -X main.version=...
var version = "dev"

// displayVersion prefixes a numeric version with "v" to match the shll toolkit
// standard (e.g. "hexokit version v1.5.3"). The "dev" sentinel used for
// non-ldflags builds is left untouched so we don't end up with "vdev".
func displayVersion() string {
	if version == "dev" || strings.HasPrefix(version, "v") {
		return version
	}
	return "v" + version
}

var rootCmd = &cobra.Command{
	Use:     "hexokit",
	Short:   "hexokit — tmux session manager with web UI",
	Version: displayVersion(),
	// No-args invocation defaults to serve (backwards compat).
	RunE: func(cmd *cobra.Command, args []string) error {
		return serveCmd.RunE(cmd, args)
	},
	// Args is left nil so cobra's native legacyArgs/Find path prints the
	// unknown-command error EXACTLY as before — the "unknown command %q for %q"
	// line, the Levenshtein "Did you mean this?" suggestions, and the trailing
	// "Run 'hexokit --help' for usage." hint. Unknown-command exit-code
	// classification happens centrally at the execute() seam (see exitCode's
	// unknownCommandPrefix check), which keeps user-facing stderr byte-identical
	// and fails safe (2→1) if cobra ever changes the message wording. A bare
	// `hexokit` (no positional args) still descends into the serve default.
	SilenceUsage: true,
}

func init() {
	// quiet is a single persistent flag on the root so every subcommand accepts
	// it uniformly and future commands inherit it with zero registration work
	// (Toolkit Principle 9). It is a no-op on commands not yet routed through the
	// output sink (see output.go) — deliberate incremental adoption. Bound to the
	// package-level `quiet` var; the sink reads that var via the cobra flag on the
	// invoked command so quiet-gating stays unit-testable.
	rootCmd.PersistentFlags().BoolVar(&quiet, "quiet", false,
		"Suppress progress/decoration/chatter (data and errors still print)")

	rootCmd.AddCommand(serveCmd)
	rootCmd.AddCommand(updateCmd)
	rootCmd.AddCommand(doctorCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(daemonCmd)
	rootCmd.AddCommand(desktopCmd)
	rootCmd.AddCommand(urlCmd)
	rootCmd.AddCommand(portsCmd)
	rootCmd.AddCommand(skillCmd)
	rootCmd.AddCommand(mcpCmd)
	rootCmd.AddCommand(notifyCmd)
	rootCmd.AddCommand(agentCmd)
	// Hidden root aliases for the agent family (see agent.go): agent-setup is
	// deprecated (warns on stderr, still runs); agent-hook is PERMANENT — the
	// machine-invoked contract installed hook lines depend on.
	rootCmd.AddCommand(agentSetupAliasCmd)
	rootCmd.AddCommand(agentHookAliasCmd)
	// tmux-guard joins agent-hook in the PERMANENT class (never warns, never
	// removed): installed PATH shims exec the literal name frozen at install
	// time, fronting every PATH-resolved tmux call — a machine-invoked
	// contract, not deprecation-grade (cli-layering.md delegation rule 3; see
	// tmuxGuardAliasCmd in tmux_guard.go).
	rootCmd.AddCommand(tmuxGuardAliasCmd)
	rootCmd.AddCommand(riffCmd)
	rootCmd.AddCommand(tutorialCmd)
	rootCmd.AddCommand(operatorCmd)
	rootCmd.AddCommand(remoteCmd)
	rootCmd.AddCommand(roleCmd)
	rootCmd.AddCommand(codeServerCmd)
	rootCmd.AddCommand(guiCmd)
	rootCmd.AddCommand(codeCmd)
	rootCmd.AddCommand(presentCmd)
	rootCmd.AddCommand(tabCmd)
	rootCmd.AddCommand(boardCmd)
	rootCmd.AddCommand(muxCmd)
	rootCmd.AddCommand(cronCmd)
	// Hidden root aliases for the mux family (see mux.go): these three are
	// deprecation-grade — they warn on stderr and still run, pointing at the
	// `rk mux` form, and are removable in a future release (unlike the
	// permanent agent-hook / tmux-guard contracts above).
	rootCmd.AddCommand(reapAliasCmd)
	rootCmd.AddCommand(snapshotAliasCmd)
	rootCmd.AddCommand(initConfAliasCmd)
	rootCmd.AddCommand(newShellInitCmd())
	rootCmd.AddCommand(helpDumpCmd)

	// Flag-parse errors on the root and any inheriting subcommand are usage-class
	// (exit 2). Cobra's FlagErrorFunc is inherited by children that do NOT set
	// their own, so this one func covers every subcommand except the two agent-hook
	// instances (the `agent hook` family member and the permanent `agent-hook`
	// root alias), which each set their own SetFlagErrorFunc(→ nil) to preserve
	// the NEVER-FAIL contract (Claude Code treats a hook exit 2 as *blocking*).
	// Own-wins inheritance keeps both hook instances shadowing this — do not
	// remove their funcs.
	rootCmd.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		return preRunError{usageError(err)}
	})

	// Arg-count validator errors (NoArgs / ExactArgs / MaximumNArgs on the
	// subcommands) are usage-class (exit 2). Wrap each subcommand's non-nil Args
	// validator centrally so a violation carries the usage sentinel. This loop
	// covers DIRECT children only — family members (mux send/await and
	// snapshot's children, agent setup) wrap their own Args at declaration. Commands with ArbitraryArgs (the
	// agent-hook alias, riff) never produce a validator error, so the wrap is
	// inert for them. This is deliberately a one-place root-cause fix rather than
	// editing each declaration site.
	for _, c := range rootCmd.Commands() {
		if c.Args != nil {
			c.Args = usageArgs(c.Args)
		}
	}
}

// preRunError tags an error raised before the invoked command's RunE runs —
// flag-parse failures (the root FlagErrorFunc) and Args-validator failures
// (usageArgs). The --json envelope contract starts at RunE entry (spec §
// Envelope boundary): pre-RunE failures keep cobra's stderr error and exit 2
// with no stdout document, so jsonErrorEnvelope skips them. Unwrap keeps
// exitCode's errors.As reaching the carried *exitCodeError.
type preRunError struct{ err error }

func (e preRunError) Error() string { return e.err.Error() }
func (e preRunError) Unwrap() error { return e.err }

// usageArgs wraps a cobra positional-args validator so a non-nil validation error
// is re-tagged as usage-class (exit 2) while preserving the original message. A
// nil result (valid args) passes through unchanged.
func usageArgs(v cobra.PositionalArgs) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if err := v(cmd, args); err != nil {
			return preRunError{usageError(err)}
		}
		return nil
	}
}

func execute() {
	// Before any subcommand can fork: every tmux client rk spawns, and every
	// tmux server rk births (whose global env is a copy of rk's), must pass
	// tmux's UTF-8 rule or tmux ≥ 3.7 sanitizes the tab delimiter out of -F
	// output. GUI- and service-launched rk processes commonly carry no LANG.
	tmux.EnsureUTF8Locale()
	out := &writeTracker{w: os.Stdout}
	rootCmd.SetOut(out)
	execCmd, err := rootCmd.ExecuteC()
	if err != nil {
		if !out.wrote {
			jsonErrorEnvelope(execCmd, err)
		}
		os.Exit(exitCode(err))
	}
}

// writeTracker is the root's stdout for the process: it records whether any
// command wrote data, so execute() knows a failing --json verb that already
// emitted its own envelope (JSONError, or a verdict-bearing Envelope) needs no
// second document. Subcommands inherit it through cmd.OutOrStdout().
type writeTracker struct {
	w     io.Writer
	wrote bool
}

func (t *writeTracker) Write(p []byte) (int, error) {
	if len(p) > 0 {
		t.wrote = true
	}
	return t.w.Write(p)
}

// jsonErrorEnvelope is execute()'s central --json failure writer: it writes
// the {"ok":false,"error":{…}} envelope to the executed command's stdout iff
// the command opted into --json (a parsed `json` bool flag reading true), the
// failure happened at or after RunE entry (not a preRunError), and Envelope
// has not already written a document for this error (not an envelopedError);
// execute() adds the fourth guard — nothing written to stdout yet — for verbs
// that emit through JSONError and return a plain error.
// Verbs therefore change only their success-path encoder; every early
// `return err` inside RunE gets the envelope here. Pure — no os.Exit, no I/O
// beyond the envelope write — and reports whether it wrote so root_test.go
// can exercise it without execute().
func jsonErrorEnvelope(cmd *cobra.Command, err error) bool {
	if cmd == nil || err == nil {
		return false
	}
	var pre preRunError
	if errors.As(err, &pre) {
		return false
	}
	var env envelopedError
	if errors.As(err, &env) {
		return false
	}
	if cmd.Flags().Lookup("json") == nil {
		return false
	}
	if jsonOn, flagErr := cmd.Flags().GetBool("json"); flagErr != nil || !jsonOn {
		return false
	}
	sink := outputSink{data: cmd.OutOrStdout()}
	_ = sink.Envelope(nil, err)
	return true
}
