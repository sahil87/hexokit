package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"rk/internal/riff"
)

func TestRootCmdDefaultsToServe(t *testing.T) {
	// The root command's RunE should be set (delegating to serveCmd).
	if rootCmd.RunE == nil {
		t.Fatal("rootCmd.RunE should be set to delegate to serve")
	}
}

func TestRootCmdHasSubcommands(t *testing.T) {
	expected := map[string]bool{
		"serve":     false,
		"update":    false,
		"doctor":    false,
		"status":    false,
		"daemon":    false,
		"desktop":   false,
		"url":       false,
		"ports":     false,
		"skill":     false,
		"init-conf": false,
		"agent":     false,
	}

	for _, cmd := range rootCmd.Commands() {
		if _, ok := expected[cmd.Name()]; ok {
			expected[cmd.Name()] = true
		}
	}

	for name, found := range expected {
		if !found {
			t.Errorf("expected subcommand %q not found", name)
		}
	}

	// The old root forms survive as HIDDEN aliases (see agent.go / mux.go /
	// tmux_guard.go): agent-setup, reaper, snapshot, and init-conf are deprecated
	// but still run; agent-hook and tmux-guard are PERMANENT machine-invoked
	// contracts (never warn, never removed). Registered, hidden, never listed.
	for _, name := range []string{"agent-setup", "agent-hook", "tmux-guard", "reaper", "snapshot", "init-conf"} {
		cmd, _, err := rootCmd.Find([]string{name})
		if err != nil || cmd == nil || cmd.Name() != name {
			t.Errorf("hidden root alias %q not found (err=%v)", name, err)
			continue
		}
		if !cmd.Hidden {
			t.Errorf("root alias %q must be Hidden (excluded from -h and the help-dump)", name)
		}
	}

	// The agent family groups exactly the two instrumentation verbs.
	setup, _, err := rootCmd.Find([]string{"agent", "setup"})
	if err != nil || setup == nil || setup.Name() != "setup" {
		t.Errorf("agent family member %q not found (err=%v)", "setup", err)
	}
	hook, _, err := rootCmd.Find([]string{"agent", "hook"})
	if err != nil || hook == nil || hook.Name() != "hook" {
		t.Errorf("agent family member %q not found (err=%v)", "hook", err)
	}

	// The mux family groups the pane-scoped verbs plus the moved operator verbs.
	for _, path := range [][]string{
		{"mux", "send"},
		{"mux", "await"},
		{"mux", "capture"},
		{"mux", "kill"},
		{"mux", "process"},
		{"mux", "adopt"},
		{"mux", "reap"},
		{"mux", "init-conf"},
		{"mux", "guard"},
		{"mux", "snapshot", "list"},
		{"mux", "snapshot", "show"},
		{"mux", "snapshot", "restore"},
	} {
		cmd, _, err := rootCmd.Find(path)
		want := path[len(path)-1]
		if err != nil || cmd == nil || cmd.Name() != want {
			t.Errorf("mux family member %v not found (err=%v)", path, err)
		}
	}
}

// TestDisplayVersion pins the release-shape path of displayVersion (the
// version standard's canonical first line is `hexokit version v{semver}`):
// a numeric ldflags version gains the "v" prefix — the shape shll parses in
// production — while an already-prefixed version and the "dev" sentinel pass
// through untouched (never "vdev").
func TestDisplayVersion(t *testing.T) {
	orig := version
	t.Cleanup(func() { version = orig })

	cases := []struct{ in, want string }{
		{"1.2.3", "v1.2.3"},
		{"v1.2.3", "v1.2.3"},
		{"dev", "dev"},
	}
	for _, c := range cases {
		version = c.in
		if got := displayVersion(); got != c.want {
			t.Errorf("displayVersion() with version=%q = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestVersionFlag(t *testing.T) {
	buf := new(bytes.Buffer)
	rootCmd.SetOut(buf)
	rootCmd.SetArgs([]string{"--version"})

	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("--version flag failed: %v", err)
	}

	got := strings.TrimSpace(buf.String())
	want := "hexokit version dev"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestShortVersionFlag(t *testing.T) {
	buf := new(bytes.Buffer)
	rootCmd.SetOut(buf)
	rootCmd.SetArgs([]string{"-v"})

	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("-v flag failed: %v", err)
	}

	got := strings.TrimSpace(buf.String())
	want := "hexokit version dev"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestVersionSubcommandRemoved(t *testing.T) {
	// Reset the shared rootCmd's --version bool flag. A prior test in this package
	// (TestVersionFlag/TestShortVersionFlag) runs `--version`, which cobra retains
	// as Changed=true on the shared flagset; since cobra's version-flag short-circuit
	// runs BEFORE arg validation, a leftover true value would print the version and
	// return nil instead of the expected unknown-command error. This reset is test
	// hygiene for the shared global command, not a behavior assertion — in a real
	// process, execute() runs once with a fresh flagset.
	if f := rootCmd.Flags().Lookup("version"); f != nil {
		_ = rootCmd.Flags().Set("version", "false")
		f.Changed = false
	}

	buf := new(bytes.Buffer)
	rootCmd.SetOut(buf)
	rootCmd.SetArgs([]string{"version"})

	err := rootCmd.Execute()
	if err == nil {
		t.Fatal("expected error for removed 'version' subcommand, got nil")
	}

	errMsg := err.Error()
	if !strings.Contains(errMsg, "unknown command") || !strings.Contains(errMsg, "version") {
		t.Fatalf("unexpected error for 'version' subcommand: %v", err)
	}

	// The unknown-command error is now usage-class (exit 2) — the whole point of
	// this change. Assert the carried classification, not just the message.
	if got := exitCode(err); got != exitUsage {
		t.Errorf("exitCode(unknown command) = %d, want %d (usage class)", got, exitUsage)
	}
}

// TestExitCodeClassification unit-tests the pure exitCode(err) seam directly — no
// os.Exit, no subprocess. This is the testable core execute() delegates to.
func TestExitCodeClassification(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"nil is success", nil, 0},
		{"plain operational error defaults to 1", errors.New("tmux is dead"), 1},
		{"wrapped operational error defaults to 1", fmt.Errorf("doctor: %w", errors.New("dep missing")), 1},
		{"usageError is 2", usageError(errors.New("unknown flag: --nope")), exitUsage},
		{"direct exitCodeError carries its code", &exitCodeError{code: 2, msg: "x"}, 2},
		{"wrapped exitCodeError is unwrapped via errors.As", fmt.Errorf("ctx: %w", &exitCodeError{code: 2, msg: "x"}), 2},
		{"plain error from riff engine (not an *ExitCodeError) defaults to 1", errors.New("wt failed"), 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := exitCode(tc.err); got != tc.want {
				t.Errorf("exitCode(%v) = %d, want %d", tc.err, got, tc.want)
			}
		})
	}
}

// TestUsageErrorPreservesMessage asserts the wrapper changes only the carried
// exit code, never the message text — so cobra's existing stderr output is
// untouched (no double-print, no rewrite).
func TestUsageErrorPreservesMessage(t *testing.T) {
	orig := errors.New("unknown command \"bogus\" for \"hexokit\"")
	wrapped := usageError(orig)
	if wrapped.Error() != orig.Error() {
		t.Errorf("usageError changed the message: got %q, want %q", wrapped.Error(), orig.Error())
	}
	if exitCode(wrapped) != exitUsage {
		t.Errorf("usageError carried code %d, want %d", exitCode(wrapped), exitUsage)
	}
}

// resetRootFlagState clears shared rootCmd flag/arg state so a table row's
// Execute() is not polluted by a prior row (cobra retains flag state on the
// shared global command — the same footgun TestVersionSubcommandRemoved guards).
func resetRootFlagState(t *testing.T) {
	t.Helper()
	if f := rootCmd.Flags().Lookup("version"); f != nil {
		_ = rootCmd.Flags().Set("version", "false")
		f.Changed = false
	}
	// The mux parent's persistent -L is shared by every Execute() run too.
	if f := muxCmd.PersistentFlags().Lookup("server"); f != nil {
		_ = f.Value.Set(f.DefValue)
		f.Changed = false
	}
	muxServerFlag = ""
	rootCmd.SetOut(io.Discard)
	rootCmd.SetErr(io.Discard)
}

// TestUsageErrorsExitTwo drives real cobra Execute() over the full command tree
// and asserts every usage-class path (unknown command, each Args-validator shape,
// unknown flag, riff manual flag-parse) classifies to exit 2 via exitCode(err) —
// the exact wiring execute() runs. Paths that fail arg/flag validation never reach
// their RunE (so no network/tmux side effects), and the wraps preserve cobra's
// stderr text.
func TestUsageErrorsExitTwo(t *testing.T) {
	cases := []struct {
		name string
		argv []string
	}{
		{"unknown command", []string{"bogus"}},
		{"NoArgs violated (skill)", []string{"skill", "x"}},
		{"NoArgs violated (agent setup)", []string{"agent", "setup", "x"}},
		{"NoArgs violated (agent-setup alias)", []string{"agent-setup", "x"}},
		{"ExactArgs(1) too few (notify)", []string{"notify"}},
		{"ExactArgs(1) too many (notify)", []string{"notify", "a", "b"}},
		{"MaximumNArgs(1) exceeded (shell-init)", []string{"shell-init", "a", "b"}},
		{"MaximumNArgs(1) exceeded (help-dump)", []string{"help-dump", "a", "b"}},
		{"MaximumNArgs(1) exceeded (mux snapshot list)", []string{"mux", "snapshot", "list", "a", "b"}},
		{"ExactArgs(1) too few (mux snapshot show)", []string{"mux", "snapshot", "show"}},
		{"ExactArgs(1) too few (snapshot alias child)", []string{"snapshot", "show"}},
		// Reaching RunE is safe here: the -L guard fires before any engine or
		// filesystem work (reap's dry-run scan never starts).
		{"explicit -L rejected (mux reap)", []string{"mux", "-L", "zzz-nope", "reap"}},
		{"unknown flag (doctor)", []string{"doctor", "--nope"}},
		{"unknown flag (status)", []string{"status", "--nope"}},
		// NOTE: `riff --nope` is NOT in this in-process table — riff sets
		// DisableFlagParsing and self-manages its exit code by calling os.Exit
		// inside runRiffWithExitCode, which would terminate the test process. Its
		// flag-parse → exit-2 path is covered by TestRiffFlagParseExitsTwo below
		// (a re-exec subprocess test) plus TestRiffExitClassMapping (constants).
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetRootFlagState(t)
			rootCmd.SetArgs(tc.argv)
			err := rootCmd.Execute()
			if err == nil {
				t.Fatalf("rk %v: expected a usage error, got nil", tc.argv)
			}
			if got := exitCode(err); got != exitUsage {
				t.Errorf("rk %v: exitCode = %d, want %d (usage). err=%v", tc.argv, got, exitUsage, err)
			}
		})
	}
}

// TestRiffFlagParseExitsTwo verifies end-to-end that `run-kit riff --nope` exits
// 2 (usage class) AND that cobra prints the `Error: unknown flag: --nope` stderr
// line — byte-identical to the pre-change binary. riff sets DisableFlagParsing
// and manually parses; a parse failure is returned as a usageError, so the exit
// code is owned by the central execute() seam (os.Exit(exitCode(err))). This is
// observable only out of process — the test re-execs the test binary with a
// guard env var; the child runs the real execute() (which prints via cobra and
// exits with the classified code), and the parent asserts the status + stderr.
func TestRiffFlagParseExitsTwo(t *testing.T) {
	if os.Getenv("RK_RIFF_SUBPROC") == "1" {
		// Child: dispatch `riff --nope` through the real production seam. The
		// manual flag parse fails BEFORE any precondition/subprocess, so no
		// $TMUX/wt is needed; runRiffWithExitCode returns usageError(parseErr),
		// cobra prints `Error: unknown flag: --nope`, and execute() os.Exits with
		// exitCode(err) == 2.
		rootCmd.SetArgs([]string{"riff", "--nope"})
		execute()
		// Unreachable if execute()'s os.Exit fired; if it didn't (no error), exit
		// 0 so the parent's assertion fails loudly.
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run", "^TestRiffFlagParseExitsTwo$")
	cmd.Env = append(os.Environ(), "RK_RIFF_SUBPROC=1")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("expected the child to exit non-zero, got err=%v", err)
	}
	if got := ee.ExitCode(); got != exitUsage {
		t.Errorf("`run-kit riff --nope` exit code = %d, want %d (usage)", got, exitUsage)
	}
	if !strings.Contains(stderr.String(), "Error: unknown flag: --nope") {
		t.Errorf("`run-kit riff --nope` stderr = %q, want it to contain %q", stderr.String(), "Error: unknown flag: --nope")
	}
}

// TestRiffExitClassMapping locks the post-renumber riff exit classes to the
// toolkit convention: validation/usage → 2, precondition → 1, subprocess → 3.
// These flow through exitCode via the riff RunE wrapper's os.Exit in production;
// here we assert the constants and the error-to-code mapping the wrapper uses.
func TestRiffExitClassMapping(t *testing.T) {
	// The CLI RunE wrapper (runRiffWithExitCode) os.Exits with ece.Code for a
	// *riff.ExitCodeError; each class must carry the toolkit-convention code:
	// validation/usage → 2, precondition → 1 (operational), subprocess → 3.
	cases := []struct {
		name string
		got  int
		want int
	}{
		{"ExitValidation (usage)", riff.ExitValidation, 2},
		{"ExitPrecondition (operational)", riff.ExitPrecondition, 1},
		{"ExitSubprocess", riff.ExitSubprocess, 3},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("riff.%s = %d, want %d", tc.name, tc.got, tc.want)
		}
	}
}

// runFailingVerb builds a minimal root+verb pair and drives it through the
// exact wiring execute() runs — ExecuteC, then jsonErrorEnvelope on a non-nil
// error — without os.Exit, so the central --json failure writer is testable
// in-process. It returns the captured stdout and the ExecuteC error.
func runFailingVerb(t *testing.T, withJSONFlag bool, argv []string, runErr error) (string, error, bool) {
	t.Helper()
	root := &cobra.Command{Use: "rk", SilenceUsage: true, SilenceErrors: true}
	var out bytes.Buffer
	root.SetOut(&out)
	verb := &cobra.Command{
		Use:  "verb",
		RunE: func(*cobra.Command, []string) error { return runErr },
	}
	if withJSONFlag {
		verb.Flags().Bool("json", false, "")
	}
	root.AddCommand(verb)
	root.SetArgs(argv)
	execCmd, err := root.ExecuteC()
	if err == nil {
		t.Fatalf("rk %v: expected the RunE error, got nil", argv)
	}
	wrote := jsonErrorEnvelope(execCmd, err)
	return out.String(), err, wrote
}

// TestJSONErrorEnvelope pins the central failure-writer contract (R3): a
// --json command's RunE error gets exactly one {"ok":false,"error":{…}}
// document on its stdout with code derived from exitCode; already-enveloped,
// pre-RunE-tagged, and non-json-flagged failures get nothing; and the write
// never changes the exit-code classification of the error.
func TestJSONErrorEnvelope(t *testing.T) {
	cases := []struct {
		name         string
		withJSONFlag bool
		argv         []string
		runErr       error
		wantWrote    bool
		wantCode     string
		wantExit     int
	}{
		{"operational RunE error under --json → envelope", true, []string{"verb", "--json"}, errors.New("tmux is dead"), true, "operational", 1},
		{"usage RunE error under --json → code usage", true, []string{"verb", "--json"}, usageError(errors.New("accepts 1 arg(s), received 0")), true, "usage", exitUsage},
		{"already-enveloped error → no second write", true, []string{"verb", "--json"}, envelopedError{errors.New("boom")}, false, "", 1},
		{"pre-RunE tagged error → no write", true, []string{"verb", "--json"}, preRunError{usageError(errors.New("unknown flag: --bogus"))}, false, "", exitUsage},
		{"json flag registered but not set → no write", true, []string{"verb"}, errors.New("boom"), false, "", 1},
		{"no json flag at all → no write", false, []string{"verb"}, errors.New("boom"), false, "", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stdout, err, wrote := runFailingVerb(t, tc.withJSONFlag, tc.argv, tc.runErr)

			if wrote != tc.wantWrote {
				t.Errorf("jsonErrorEnvelope wrote = %v, want %v (stdout: %q)", wrote, tc.wantWrote, stdout)
			}
			if got := exitCode(err); got != tc.wantExit {
				t.Errorf("exitCode(%v) = %d, want %d — the envelope write must not change exit codes", err, got, tc.wantExit)
			}
			if !tc.wantWrote {
				if stdout != "" {
					t.Errorf("stdout = %q, want empty", stdout)
				}
				return
			}
			var doc map[string]any
			if uErr := json.Unmarshal([]byte(stdout), &doc); uErr != nil {
				t.Fatalf("stdout must be one JSON document: %v\ngot %q", uErr, stdout)
			}
			if doc["ok"] != false {
				t.Errorf("ok = %v, want false", doc["ok"])
			}
			if _, hasResult := doc["result"]; hasResult {
				t.Errorf("central writer carries no result: %v", doc)
			}
			envErr, ok := doc["error"].(map[string]any)
			if !ok {
				t.Fatalf("error key missing or wrong type: %v", doc)
			}
			if envErr["code"] != tc.wantCode {
				t.Errorf("error.code = %v, want %q", envErr["code"], tc.wantCode)
			}
			if envErr["message"] != tc.runErr.Error() {
				t.Errorf("error.message = %v, want %q", envErr["message"], tc.runErr.Error())
			}
		})
	}
}

// TestJSONErrorEnvelope_FlagParseFailureStaysBare pins the R4 boundary
// end-to-end through real cobra machinery: `verb --json --bogus` fails flag
// parsing AFTER pflag has already applied --json (pflag parses sequentially),
// so the parsed json flag reads true — yet stdout must stay empty because the
// root FlagErrorFunc tags the failure preRunError and RunE never ran. Exit
// stays 2.
func TestJSONErrorEnvelope_FlagParseFailureStaysBare(t *testing.T) {
	root := &cobra.Command{Use: "rk", SilenceUsage: true, SilenceErrors: true}
	var out bytes.Buffer
	root.SetOut(&out)
	verb := &cobra.Command{
		Use: "verb",
		RunE: func(*cobra.Command, []string) error {
			t.Error("RunE must not run on a flag-parse failure")
			return nil
		},
	}
	verb.Flags().Bool("json", false, "")
	root.AddCommand(verb)
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		return preRunError{usageError(err)}
	})
	root.SetArgs([]string{"verb", "--json", "--bogus"})

	execCmd, err := root.ExecuteC()
	if err == nil {
		t.Fatal("expected a flag-parse error, got nil")
	}
	if jsonErrorEnvelope(execCmd, err) {
		t.Error("pre-RunE flag-parse failure must not emit an envelope")
	}
	if got := out.String(); got != "" {
		t.Errorf("stdout = %q, want empty (R4: no envelope before RunE)", got)
	}
	if got := exitCode(err); got != exitUsage {
		t.Errorf("exitCode = %d, want %d (usage)", got, exitUsage)
	}
}
