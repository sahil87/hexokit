package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"
)

// shellInitBanner returns the leading comment block emitted at the top of
// `rk shell-init <shell>` output. It mirrors the pattern used by `tu`, `hop`,
// and `wt` — a one-line tagline, an install hint, and an explanatory note that
// the snippet is intended for `eval` (not for `$fpath` autoload).
//
// hexokit does NOT define a shell function wrapper (unlike hop/wt) because it
// has no bare-name dispatch, no tool-form sugar, and no verb dispatch — every
// subcommand is reached the regular way via `hexokit <subcommand>` (or the
// `rk`/`xk`/`run-kit` invocation names). The shell-init output is therefore
// completion-only.
func shellInitBanner(shell string) string {
	installRC := "~/.zshrc"
	if shell == "bash" {
		installRC = "~/.bashrc"
	}
	return fmt.Sprintf(`# hexokit(1) %[1]s completion
# Install:
#   echo 'eval "$(rk shell-init %[1]s)"' >> %[2]s
#
# This snippet is intended for `+"`eval`"+`, not for autoload via $fpath. It defines
# the cobra-generated _hexokit completion function and registers it with the shell's
# completion system, for the canonical `+"`hexokit`"+` command name and the installed
# invocation names `+"`rk`"+`, `+"`xk`"+`, and `+"`run-kit`"+`. hexokit has no shell function wrapper — every
# subcommand is reached via `+"`hexokit <subcommand>`"+` (or `+"`rk <subcommand>`"+`), so this snippet is completion-only.
`, shell, installRC)
}

// zshCompinitShim is prepended to the cobra-generated zsh completion so that
// `compdef` is available even when the user's rc file hasn't already run
// `compinit`. Without this, sourcing the eval'd output from a fresh shell
// (or before compinit fires) fails with `compdef: command not found` and the
// `_hexokit` function never registers.
const zshCompinitShim = `
# Lazy-load compinit if the user hasn't already initialised the completion
# system — ` + "`compdef`" + ` is provided by compinit and is required to register _hexokit
# against the ` + "`hexokit`" + ` command (and the ` + "`rk`" + ` / ` + "`xk`" + ` / ` + "`run-kit`" + ` invocation names) at eval time.
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit -i }

`

// zshAliasCompdef registers the cobra-generated _hexokit completion function
// against the installed invocation names `rk`, `xk`, and the legacy `run-kit`
// as well. Cobra's GenZshCompletion only emits `compdef _hexokit hexokit` for
// the root name, so without these lines the daily-typed names would silently
// lose tab completion — the binary answers to all four names (root dispatch
// is by argv[0]; the formula symlinks each name to the one binary), and
// completion must cover each.
const zshAliasCompdef = "\ncompdef _hexokit rk\ncompdef _hexokit xk\ncompdef _hexokit run-kit\n"

// bashAliasComplete registers the cobra-generated __start_hexokit completion
// function against the installed invocation names `rk`, `xk`, and the legacy
// `run-kit` as well. Cobra's GenBashCompletionV2 only emits a
// `complete ... hexokit` registration for the root name; this mirrors cobra's
// own compopt-conditional registration block verbatim (same `-o default` /
// `-o default -o nospace` flags, same `__start_hexokit` entry function) so
// `rk <TAB>`, `xk <TAB>`, and `run-kit <TAB>` behave identically to
// `hexokit <TAB>`.
const bashAliasComplete = `
if [[ $(type -t compopt) = "builtin" ]]; then
    complete -o default -F __start_hexokit rk
    complete -o default -F __start_hexokit xk
    complete -o default -F __start_hexokit run-kit
else
    complete -o default -o nospace -F __start_hexokit rk
    complete -o default -o nospace -F __start_hexokit xk
    complete -o default -o nospace -F __start_hexokit run-kit
fi
`

// newShellInitCmd returns the `rk shell-init <shell>` cobra command. It emits
// shell-eval-safe content for the given shell, suitable for the user (or the
// `shll` meta-CLI) to drop into their rc file as:
//
//	eval "$(rk shell-init zsh)"
//
// Supported shells: zsh, bash, fish, powershell. zsh/bash are the documented
// targets; fish/powershell are included because the underlying cobra delegation
// is a single Gen*Completion call with no shell-specific wrapping required.
//
// Argument validation:
//   - missing shell    → stderr "run-kit shell-init: missing shell. Supported: zsh, bash" exit 2
//   - unsupported shell → stderr "run-kit shell-init: unsupported shell '<shell>'. Supported: zsh, bash" exit 2
//
// Exit-code translation is done locally (mirroring runRiffWithExitCode) so
// main.execute() — shared with every other subcommand — doesn't need touching.
func newShellInitCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "shell-init <shell>",
		Short: "emit shell integration (completion) for zsh or bash",
		// Hidden: sourced from shell rc at eval time (machine-invoked), never
		// typed by a human after installation — it stays fully functional but
		// drops out of `rk -h` and the help-dump.
		Hidden: true,
		Long: `Emit a shell-eval-safe completion script for the given shell.

The output is intended to be sourced via:

  eval "$(rk shell-init zsh)"

hexokit has no shell function wrapper — the snippet only registers the
cobra-generated completion function for the hexokit command and the rk, xk,
and run-kit invocation names. compinit is lazy-loaded for zsh so the snippet is
safe to eval from a shell that hasn't yet run compinit.`,
		Args:          cobra.MaximumNArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			err := runShellInit(cmd, args)
			if err == nil {
				return nil
			}
			var ece *exitCodeError
			if errors.As(err, &ece) {
				fmt.Fprintln(cmd.ErrOrStderr(), ece.msg)
				os.Exit(ece.code)
			}
			return err
		},
	}
}

// runShellInit is the core of `rk shell-init`. Split out from the cobra RunE
// so it's testable without the os.Exit side-effect that *exitCodeError
// triggers in the wrapper.
func runShellInit(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return &exitCodeError{code: 2, msg: "run-kit shell-init: missing shell. Supported: zsh, bash"}
	}
	shell := args[0]
	switch shell {
	case "zsh", "bash", "fish", "powershell":
		// supported
	default:
		return &exitCodeError{code: 2, msg: fmt.Sprintf("run-kit shell-init: unsupported shell '%s'. Supported: zsh, bash", shell)}
	}

	out := cmd.OutOrStdout()
	if _, err := io.WriteString(out, shellInitBanner(shell)); err != nil {
		return fmt.Errorf("run-kit shell-init: write banner: %w", err)
	}

	// Delegate the actual completion-script generation to cobra. The root
	// command's existing `completion` subcommand uses these same generators
	// internally — we call them directly so the shell-init output is
	// self-contained (the user evals one blob; no second `run-kit completion <shell>`
	// call needed).
	//
	// Cobra generates completion bound to the root name `hexokit` only. zsh and
	// bash additionally register the same generated completion function against
	// the installed invocation names `rk`, `xk`, and `run-kit` (formula
	// symlinks to the one binary) so every daily-typed name keeps tab
	// completion.
	// fish/powershell keep cobra's single-name binding (undocumented targets —
	// Assumption 9).
	switch shell {
	case "zsh":
		if _, err := io.WriteString(out, zshCompinitShim); err != nil {
			return fmt.Errorf("run-kit shell-init: write compinit shim: %w", err)
		}
		if err := rootCmd.GenZshCompletion(out); err != nil {
			return fmt.Errorf("run-kit shell-init: zsh completion: %w", err)
		}
		if _, err := io.WriteString(out, zshAliasCompdef); err != nil {
			return fmt.Errorf("run-kit shell-init: zsh alias compdef: %w", err)
		}
	case "bash":
		// V2 emits a richer script (with descriptions support); the second arg
		// enables completion descriptions.
		if err := rootCmd.GenBashCompletionV2(out, true); err != nil {
			return fmt.Errorf("run-kit shell-init: bash completion: %w", err)
		}
		if _, err := io.WriteString(out, bashAliasComplete); err != nil {
			return fmt.Errorf("run-kit shell-init: bash alias complete: %w", err)
		}
	case "fish":
		if err := rootCmd.GenFishCompletion(out, true); err != nil {
			return fmt.Errorf("run-kit shell-init: fish completion: %w", err)
		}
	case "powershell":
		if err := rootCmd.GenPowerShellCompletionWithDesc(out); err != nil {
			return fmt.Errorf("run-kit shell-init: powershell completion: %w", err)
		}
	}
	return nil
}
