package shellq

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"
)

// TestQuote pins the single-quote encoding: every token — spaces, $(),
// backticks, newlines, embedded quotes — comes out as one shell word, and an
// embedded quote becomes the close/escaped-quote/reopen sequence inside the
// surrounding quotes Quote adds.
func TestQuote(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty token", "", `''`},
		{"plain", "/fab-discuss", `'/fab-discuss'`},
		{"token with spaces", "run kit", `'run kit'`},
		{"one quote", "say 'hi'", `'say '\''hi'\'''`},
		{"multiple quotes", "'a'b'c'", `''\''a'\''b'\''c'\'''`},
		{"only a quote", "'", `''\'''`},
		{"mixed content", `it's a "test"`, `'it'\''s a "test"'`},
		{"command substitution stays literal", "$(echo pwned)", `'$(echo pwned)'`},
		{"backticks stay literal", "`id`", "'`id`'"},
		{"newline stays literal", "a\nb", "'a\nb'"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Quote(tc.in); got != tc.want {
				t.Errorf("Quote(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestQuoteArgv(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want string
	}{
		{"empty argv", nil, ""},
		{"one token", []string{"claude"}, "'claude'"},
		{
			"flags and a literal dollar token",
			[]string{"claude", "--dangerously-skip-permissions", "-n", "run kit", "$(echo pwned)"},
			`'claude' '--dangerously-skip-permissions' '-n' 'run kit' '$(echo pwned)'`,
		},
		{"tokens joined by single spaces", []string{"a", "b"}, "'a' 'b'"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := QuoteArgv(tc.argv); got != tc.want {
				t.Errorf("QuoteArgv(%q) = %q, want %q", tc.argv, got, tc.want)
			}
		})
	}
}

// TestWithShellFallback pins the fallback tail: a non-empty command gains the
// exec suffix after a semicolon; an empty or blank command yields the bare
// exec with no leading semicolon.
func TestWithShellFallback(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "empty input produces only the exec suffix",
			in:   "",
			want: `exec "${SHELL:-/bin/sh}"`,
		},
		{
			name: "whitespace-only input produces only the exec suffix",
			in:   "   \t  ",
			want: `exec "${SHELL:-/bin/sh}"`,
		},
		{
			name: "simple command",
			in:   "claude '/fab-discuss'",
			want: `claude '/fab-discuss'; exec "${SHELL:-/bin/sh}"`,
		},
		{
			name: "command with embedded single quotes",
			in:   `echo 'hello '\''world'\'''`,
			want: `echo 'hello '\''world'\'''; exec "${SHELL:-/bin/sh}"`,
		},
		{
			name: "command with embedded double quotes",
			in:   `echo "hello \"world\""`,
			want: `echo "hello \"world\""; exec "${SHELL:-/bin/sh}"`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := WithShellFallback(tc.in); got != tc.want {
				t.Errorf("WithShellFallback(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestInteractive pins the interactive wrap: the whole command is re-quoted as
// one -c word behind the fixed `${SHELL:-/bin/sh} -i -c ` literal, and it
// composes with the fallback tail.
func TestInteractive(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"bare launcher", "claude", `${SHELL:-/bin/sh} -i -c 'claude'`},
		{
			"QuoteArgv output re-quoted as one word",
			QuoteArgv([]string{"claude", "--model", "opus"}),
			`${SHELL:-/bin/sh} -i -c ''\''claude'\'' '\''--model'\'' '\''opus'\'''`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Interactive(tc.in); got != tc.want {
				t.Errorf("Interactive(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
	if got, want := WithShellFallback(Interactive("x")), `${SHELL:-/bin/sh} -i -c 'x'; exec "${SHELL:-/bin/sh}"`; got != want {
		t.Errorf("WithShellFallback(Interactive) = %q, want %q", got, want)
	}
}

// TestInteractiveRoundTripKeepsTokensLiteral runs the double-quoted
// composition through a real POSIX shell (SHELL=/bin/sh, empty ENV so no rc
// file runs) and checks every token reaches the process as one literal word.
func TestInteractiveRoundTripKeepsTokensLiteral(t *testing.T) {
	tokens := []string{"$(echo pwned)", "it's", "a b", "`id`", "x\ny"}
	argv := append([]string{"printf", "%s|"}, tokens...)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", Interactive(QuoteArgv(argv)))
	cmd.Env = append(os.Environ(), "SHELL=/bin/sh", "ENV=")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if want := "$(echo pwned)|it's|a b|`id`|x\ny|"; string(out) != want {
		t.Errorf("output = %q, want %q", string(out), want)
	}
}
