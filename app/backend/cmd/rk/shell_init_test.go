package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

// runShellInitCaptured invokes runShellInit (the os.Exit-free core) against a
// fresh cobra command bound to rootCmd. This bypasses the RunE wrapper's
// os.Exit translation so tests can inspect the returned *exitCodeError
// directly.
func runShellInitCaptured(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	cmd := newShellInitCmd()
	// Attach to rootCmd so cmd.Root() resolves; not strictly required since
	// runShellInit uses the package-level rootCmd directly, but mirrors real
	// invocation shape.
	rootCmd.AddCommand(cmd)
	defer rootCmd.RemoveCommand(cmd)

	var stdout, stderr bytes.Buffer
	cmd.SetOut(&stdout)
	cmd.SetErr(&stderr)
	err := runShellInit(cmd, args)
	return stdout.String(), stderr.String(), err
}

func TestShellInitZshContainsBannerAndCompletion(t *testing.T) {
	out, _, err := runShellInitCaptured(t, "zsh")
	if err != nil {
		t.Fatalf("shell-init zsh: %v", err)
	}
	// Banner anchors.
	if !strings.Contains(out, "# hexokit(1) zsh completion") {
		t.Errorf("expected `# hexokit(1) zsh completion` banner, got:\n%s", out)
	}
	if !strings.Contains(out, `eval "$(rk shell-init zsh)"`) {
		t.Errorf("expected install hint with eval form, got:\n%s", out)
	}
	if !strings.Contains(out, "~/.zshrc") {
		t.Errorf("expected ~/.zshrc install location, got:\n%s", out)
	}
	if !strings.Contains(out, "intended for `eval`") {
		t.Errorf("expected eval-not-fpath note, got:\n%s", out)
	}
	// compinit lazy-load shim.
	if !strings.Contains(out, "$+functions[compdef]") {
		t.Errorf("expected lazy compinit shim, got:\n%s", out)
	}
	if !strings.Contains(out, "autoload -Uz compinit") {
		t.Errorf("expected `autoload -Uz compinit` in shim, got:\n%s", out)
	}
	// Cobra-generated compdef registration for the root name, PLUS the appended
	// registrations binding the same function to the installed invocation names
	// `rk`, `xk`, and the legacy `run-kit` — completion under all four names.
	if !strings.Contains(out, "compdef _hexokit hexokit") {
		t.Errorf("expected `compdef _hexokit hexokit` (cobra) registration, got:\n%s", out)
	}
	for _, name := range shellInitAliasNames {
		if !strings.Contains(out, "\ncompdef _hexokit "+name+"\n") {
			t.Errorf("expected appended `compdef _hexokit %s` registration, got:\n%s", name, out)
		}
	}
}

// shellInitAliasNames are the invocation names shell-init registers beside
// cobra's own root-name binding (D16: hexokit + rk + xk + legacy run-kit).
var shellInitAliasNames = []string{"rk", "xk", "run-kit"}

func TestShellInitZshDoesNotDefineShellFunctionWrapper(t *testing.T) {
	// hexokit has no bare-name dispatch or tool-form sugar, so the shell-init
	// output must NOT define a `hexokit()`, `rk()`, `xk()`, or `run-kit()` shell
	// function wrapper — only the cobra completion function. Guards against
	// accidentally copying the hop/wt wrapper pattern.
	out, _, err := runShellInitCaptured(t, "zsh")
	if err != nil {
		t.Fatalf("shell-init zsh: %v", err)
	}
	// A `hexokit()` / `rk()` / `xk()` / `run-kit()` followed by `{` would indicate a
	// function definition. The cobra-generated completion DOES define
	// `_hexokit()` (leading underscore) so we anchor on the bare-name forms
	// only.
	for _, line := range strings.Split(out, "\n") {
		trimmed := strings.TrimSpace(line)
		for _, name := range append([]string{"hexokit"}, shellInitAliasNames...) {
			if strings.HasPrefix(trimmed, name+"()") || strings.HasPrefix(trimmed, name+" ()") {
				t.Fatalf("expected NO `%s()` shell function wrapper, got line:\n%s", name, line)
			}
		}
	}
}

func TestShellInitBashContainsBannerAndCompletion(t *testing.T) {
	out, _, err := runShellInitCaptured(t, "bash")
	if err != nil {
		t.Fatalf("shell-init bash: %v", err)
	}
	if !strings.Contains(out, "# hexokit(1) bash completion") {
		t.Errorf("expected `# hexokit(1) bash completion` banner, got:\n%s", out)
	}
	if !strings.Contains(out, `eval "$(rk shell-init bash)"`) {
		t.Errorf("expected install hint for bash, got:\n%s", out)
	}
	if !strings.Contains(out, "~/.bashrc") {
		t.Errorf("expected ~/.bashrc install location, got:\n%s", out)
	}
	// cobra V2 bash completion uses __start_hexokit as the entry function.
	if !strings.Contains(out, "__start_hexokit") {
		t.Errorf("expected cobra `__start_hexokit` completion fn, got:\n%s", out)
	}
	// The cobra-generated script registers `hexokit`; we additionally append
	// `complete ...` registrations binding the same entry function to the
	// installed invocation names `rk`, `xk`, and `run-kit`, in both compopt
	// branches.
	if !strings.Contains(out, "-F __start_hexokit hexokit") {
		t.Errorf("expected cobra `complete ... hexokit` registration, got:\n%s", out)
	}
	for _, name := range shellInitAliasNames {
		if !strings.Contains(out, "complete -o default -F __start_hexokit "+name+"\n") {
			t.Errorf("expected appended `complete ... %s` registration, got:\n%s", name, out)
		}
		if !strings.Contains(out, "complete -o default -o nospace -F __start_hexokit "+name+"\n") {
			t.Errorf("expected nospace-branch `complete ... %s` registration, got:\n%s", name, out)
		}
	}
}

func TestShellInitMissingShell(t *testing.T) {
	_, _, err := runShellInitCaptured(t)
	if err == nil {
		t.Fatal("expected error when no shell arg")
	}
	var ece *exitCodeError
	if !errors.As(err, &ece) {
		t.Fatalf("expected *exitCodeError, got %T: %v", err, err)
	}
	if ece.code != 2 {
		t.Errorf("expected exit code 2, got %d", ece.code)
	}
	if !strings.Contains(ece.msg, "missing shell") {
		t.Errorf("expected `missing shell` in message, got: %q", ece.msg)
	}
	if !strings.Contains(ece.msg, "zsh") || !strings.Contains(ece.msg, "bash") {
		t.Errorf("expected message to mention both zsh and bash, got: %q", ece.msg)
	}
}

func TestShellInitUnsupportedShell(t *testing.T) {
	_, _, err := runShellInitCaptured(t, "wsh")
	if err == nil {
		t.Fatal("expected error for unsupported shell")
	}
	var ece *exitCodeError
	if !errors.As(err, &ece) {
		t.Fatalf("expected *exitCodeError, got %T: %v", err, err)
	}
	if ece.code != 2 {
		t.Errorf("expected exit code 2, got %d", ece.code)
	}
	if !strings.Contains(ece.msg, "unsupported shell 'wsh'") {
		t.Errorf("expected `unsupported shell 'wsh'` in message, got: %q", ece.msg)
	}
}

func TestShellInitHiddenButRegistered(t *testing.T) {
	// shell-init is sourced from shell rc (machine-invoked, never typed after
	// installation), so it is hidden from `rk -h` and the help-dump — while
	// staying fully functional (the runShellInitCaptured tests above prove the
	// execution paths).
	var found bool
	for _, sub := range rootCmd.Commands() {
		if sub.Name() == "shell-init" {
			found = true
			if !sub.Hidden {
				t.Error("shell-init must be Hidden (excluded from -h and the help-dump)")
			}
		}
	}
	if !found {
		t.Fatal("expected `shell-init` subcommand registered on rootCmd")
	}
}

func TestShellInitRegisteredOnRoot(t *testing.T) {
	// Ensure rootCmd.AddCommand wired shell-init alongside the auto-generated
	// `completion` subcommand. Both must coexist.
	//
	// Note: cobra registers the auto-generated `completion` subcommand lazily
	// during Execute() (via initDefaultCompletionCmd), so it isn't visible on
	// rootCmd.Commands() until then. We invoke `rk completion --help` against
	// a fresh buffer to trigger registration, then assert both subcommands are
	// present.
	rootCmd.SetArgs([]string{"completion", "--help"})
	rootCmd.SetOut(new(bytes.Buffer))
	rootCmd.SetErr(new(bytes.Buffer))
	// Restore args after the test so it doesn't leak into other tests.
	t.Cleanup(func() { rootCmd.SetArgs(nil) })
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("rk completion --help: %v", err)
	}

	var hasShellInit, hasCompletion bool
	for _, sub := range rootCmd.Commands() {
		switch sub.Name() {
		case "shell-init":
			hasShellInit = true
		case "completion":
			hasCompletion = true
		}
	}
	if !hasShellInit {
		t.Error("expected `shell-init` subcommand registered on rootCmd")
	}
	if !hasCompletion {
		t.Error("expected auto-generated `completion` subcommand still present on rootCmd after Execute")
	}
}
