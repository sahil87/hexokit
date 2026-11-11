// Package shellq owns rk's single POSIX shell-quoting implementation, the
// interactive-shell launch wrap, and the agent-exit shell-fallback tail.
// Consumers are the composition points where a caller-supplied value becomes
// one word inside a shell-interpreted string (tmux's shell-command
// positional, pipe-pane's command): every such value goes through
// Quote/QuoteArgv so it reaches the shell as one literal word (constitution
// §I). Pure — no I/O.
package shellq

import (
	"fmt"
	"strings"
)

// Quote single-quotes s for a POSIX shell. An embedded single quote is
// rendered by closing the quote, emitting a backslash-escaped quote, and
// reopening the quote (the canonical four-character POSIX sequence). The
// result is exactly one shell word no matter what s contains. Pure.
func Quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// QuoteArgv renders argv as a space-joined sequence of Quote'd words — the
// composition for tmux's single shell-command positional, where each argv
// element must survive as one literal word through the window shell's parse.
// Empty argv yields "". Pure.
func QuoteArgv(argv []string) string {
	quoted := make([]string, 0, len(argv))
	for _, tok := range argv {
		quoted = append(quoted, Quote(tok))
	}
	return strings.Join(quoted, " ")
}

// Interactive wraps cmd for the user's interactive shell:
// `${SHELL:-/bin/sh} -i -c <Quote(cmd)>`. tmux runs a window's shell-command
// under a NON-interactive `default-shell -c`, which never sources the rc file
// (.zshrc/.bashrc) — so anything exported only there (auth tokens such as
// CLAUDE_CODE_OAUTH_TOKEN) is missing whenever the tmux server itself was not
// started from an interactive terminal. The -i re-reads the rc file on every
// launch. cmd is re-quoted as ONE word for -c, so its own quoting survives
// verbatim. Pure.
func Interactive(cmd string) string {
	return "${SHELL:-/bin/sh} -i -c " + Quote(cmd)
}

// WithShellFallback appends `; exec "${SHELL:-/bin/sh}"` to cmd so the pane
// drops into an interactive shell rather than closing when cmd exits.
// Empty/whitespace-only input yields just the bare `exec "${SHELL:-/bin/sh}"`
// (never a leading `;`). Pure.
func WithShellFallback(cmd string) string {
	if strings.TrimSpace(cmd) == "" {
		return `exec "${SHELL:-/bin/sh}"`
	}
	return fmt.Sprintf(`%s; exec "${SHELL:-/bin/sh}"`, cmd)
}
