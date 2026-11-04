package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"rk/internal/config"
	"rk/internal/inject"
	"rk/internal/riff"

	"github.com/spf13/cobra"
)

// NOTE (tmux safety): these tests never start, attach to, or kill any tmux
// server. Every tmux invocation routes through the
// operatorRunFn/operatorRunOutputFn seams (plus the role.go write-path seams
// for the stamp), which the tests stub; the $TMUX seam
// (operatorOriginalTMUXFn) is stubbed likewise because the real
// tmux.OriginalTMUX is fixed at package-init time. The fab precondition routes
// through operatorLookPathFn and the kickoff delivery through
// operatorDeliverFn, both stubbed. The suite must also pass under `env -u TMUX
// -u TMUX_PANE go test ./cmd/rk/` (ambient-env false-green guard) — no test
// may read the ambient tmux env.

// operatorTestSocket is the fake $TMUX the seam serves so every test runs the
// inside-tmux path deterministically.
const operatorTestSocket = "/tmp/rk-test-sock,1234,0"

// operatorTestPane / operatorTestWindow are the ids the stubbed
// new-window/display-message print; the stamp and delivery must target them.
const (
	operatorTestPane   = "%42"
	operatorTestWindow = "@42"
)

// operatorCall is one recorded seam invocation: the tmux argv and the child
// env it ran with.
type operatorCall struct {
	args []string
	env  []string
}

// operatorStub owns the stubbed seam state for one test: recorded tmux calls,
// the list-windows probe output, the launcher-resolution inputs, the recorded
// role-stamp sequence, the recorded kickoff delivery, and the stored-root
// read/stamp state.
type operatorStub struct {
	calls       []operatorCall
	listOutput  string
	lookPathErr error

	repoRoot string
	tier     string
	// skillPrefix is the resolved agent's skill-invocation prefix the stub
	// serves ("/" unless a test overrides it).
	skillPrefix string

	// stampOps records the role write-path sequence in order
	// (clear/set/demote:<id>/move), so tests can pin the role.go sequence.
	stampOps       []string
	stampDisplaced []string

	deliverErr   error
	deliverCalls []operatorDelivery

	// getRoot/getRootErr feed the operatorGetRootFn stub (the stored rung);
	// getRootCalls counts its invocations. rootStamps records every
	// operatorStampRootFn invocation and stampErr is the failure it returns.
	getRoot      string
	getRootErr   error
	getRootCalls int
	rootStamps   []operatorRootStamp
	stampErr     error
}

// operatorRootStamp records one operatorStampRootFn invocation: the server
// label and the directory stamped on it.
type operatorRootStamp struct {
	server, dir string
}

// operatorDelivery records one operatorDeliverFn invocation, including the
// readiness opts the command threaded through (deadline + wall posture).
type operatorDelivery struct {
	server, paneID, text string
	opts                 inject.ReadyOpts
}

// stubOperatorSeams installs recording stubs for the precondition, tmux,
// launcher, role-stamp, and delivery seams.
func stubOperatorSeams(t *testing.T, listOutput string) *operatorStub {
	t.Helper()
	s := &operatorStub{listOutput: listOutput}

	origTMUX := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return operatorTestSocket }
	origLookPath := operatorLookPathFn
	operatorLookPathFn = func(file string) (string, error) {
		if s.lookPathErr != nil {
			return "", s.lookPathErr
		}
		return "/usr/local/bin/" + file, nil
	}
	origRun, origOut := operatorRunFn, operatorRunOutputFn
	operatorRunFn = func(_ context.Context, args, env []string) error {
		s.calls = append(s.calls, operatorCall{args: args, env: env})
		return nil
	}
	operatorRunOutputFn = func(_ context.Context, args, env []string) ([]byte, error) {
		s.calls = append(s.calls, operatorCall{args: args, env: env})
		// The -L/--server path prefixes every call with "-L <name>"; dispatch on
		// the verb past that prefix.
		verb := args[0]
		if verb == "-L" && len(args) > 2 {
			verb = args[2]
		}
		switch verb {
		case "list-windows":
			return []byte(s.listOutput), nil
		case "new-window":
			return []byte(operatorTestPane + "\n"), nil
		case "display-message":
			return []byte(operatorTestWindow + "\n"), nil
		}
		return nil, fmt.Errorf("unexpected RunOutput verb %q", args[0])
	}
	origResolve := operatorResolveAgentFn
	operatorResolveAgentFn = func(_ context.Context, rr, tr string) riff.ResolvedAgent {
		s.repoRoot = rr
		s.tier = tr
		prefix := s.skillPrefix
		if prefix == "" {
			prefix = "/"
		}
		return riff.ResolvedAgent{Launcher: riff.DefaultLauncher, SkillPrefix: prefix}
	}
	origDeliver := operatorDeliverFn
	operatorDeliverFn = func(_ context.Context, _ *inject.Engine, _ inject.Tmux, server, paneID, text string, opts inject.ReadyOpts) (inject.Readiness, error) {
		s.deliverCalls = append(s.deliverCalls, operatorDelivery{server: server, paneID: paneID, text: text, opts: opts})
		return inject.ReadyByEcho, s.deliverErr
	}
	origGetRoot := operatorGetRootFn
	operatorGetRootFn = func(_ context.Context, _ string) (string, error) {
		s.getRootCalls++
		return s.getRoot, s.getRootErr
	}
	origStampRoot := operatorStampRootFn
	operatorStampRootFn = func(_ context.Context, server, dir string) error {
		s.rootStamps = append(s.rootStamps, operatorRootStamp{server: server, dir: dir})
		return s.stampErr
	}

	origClear, origRoleRun := roleClearExceptFn, roleRunFn
	origDemote, origMoveIn := roleDemoteFn, roleMoveInFn
	roleClearExceptFn = func(_ context.Context, _ []string, _ string) ([]string, error) {
		s.stampOps = append(s.stampOps, "clear")
		return s.stampDisplaced, nil
	}
	roleRunFn = func(_ context.Context, args []string) error {
		s.stampOps = append(s.stampOps, "set "+strings.Join(args, " "))
		return nil
	}
	roleDemoteFn = func(_ context.Context, _ []string, windowID string) error {
		s.stampOps = append(s.stampOps, "demote "+windowID)
		return nil
	}
	roleMoveInFn = func(_ context.Context, _ []string, windowID string) error {
		s.stampOps = append(s.stampOps, "move "+windowID)
		return nil
	}

	t.Cleanup(func() {
		operatorOriginalTMUXFn = origTMUX
		operatorLookPathFn = origLookPath
		operatorRunFn, operatorRunOutputFn = origRun, origOut
		operatorResolveAgentFn = origResolve
		operatorDeliverFn = origDeliver
		operatorGetRootFn = origGetRoot
		operatorStampRootFn = origStampRoot
		roleClearExceptFn, roleRunFn = origClear, origRoleRun
		roleDemoteFn, roleMoveInFn = origDemote, origMoveIn
	})
	return s
}

func operatorTestCmd() (*cobra.Command, *bytes.Buffer, *bytes.Buffer) {
	outBuf, errBuf := &bytes.Buffer{}, &bytes.Buffer{}
	cmd := &cobra.Command{}
	cmd.SetOut(outBuf)
	cmd.SetErr(errBuf)
	return cmd, outBuf, errBuf
}

// resetOperatorWorkers restores the --workers package var to its default after
// a test mutates it.
func resetOperatorWorkers(t *testing.T) {
	t.Helper()
	orig := operatorWorkersFlag
	t.Cleanup(func() { operatorWorkersFlag = orig })
}

// A --workers value outside the charset is a usage error (exit 2) and runs
// zero subprocesses — the value never reaches a shell string.
func TestOperatorInvalidWorkersUsageError(t *testing.T) {
	resetOperatorWorkers(t)
	for _, bad := range []string{"kimi; rm -rf /", "a b", "x'y", "$(id)", ""} {
		if bad == "" {
			continue // the empty value is the unset case, covered below
		}
		operatorWorkersFlag = bad
		s := stubOperatorSeams(t, "")
		cmd, _, _ := operatorTestCmd()
		err := runOperator(cmd)
		if err == nil {
			t.Fatalf("runOperator() with --workers %q = nil, want a usage error", bad)
		}
		if code := exitCode(err); code != exitUsage {
			t.Errorf("exitCode(--workers %q) = %d, want %d (usage)", bad, code, exitUsage)
		}
		if len(s.calls) != 0 {
			t.Errorf("tmux calls with --workers %q = %v, want none before validation passes", bad, s.calls)
		}
	}
	operatorWorkersFlag = ""
}

// Outside tmux the command fails as an operational error (exit 1) with
// guidance and runs zero tmux subprocesses.
func TestOperatorOutsideTmuxErrors(t *testing.T) {
	resetOperatorWorkers(t)
	s := stubOperatorSeams(t, "")
	origTMUX := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })

	cmd, _, _ := operatorTestCmd()
	err := runOperator(cmd)
	if err == nil {
		t.Fatal("runOperator() = nil, want a precondition error")
	}
	var ece *riff.ExitCodeError
	if !errors.As(err, &ece) {
		t.Fatalf("runOperator() error = %T %v, want *riff.ExitCodeError", err, err)
	}
	if ece.Code != riff.ExitPrecondition {
		t.Errorf("exit code = %d, want %d (operational/precondition)", ece.Code, riff.ExitPrecondition)
	}
	if !strings.Contains(ece.Msg, "$TMUX") {
		t.Errorf("message = %q, want guidance naming $TMUX", ece.Msg)
	}
	if len(s.calls) != 0 {
		t.Errorf("tmux calls = %v, want none before the precondition passes", s.calls)
	}
}

// A missing fab is a HARD refusal (exit 1) naming fab-kit — no default-launcher
// degrade — and zero tmux subprocesses run.
func TestOperatorFabMissingErrors(t *testing.T) {
	resetOperatorWorkers(t)
	s := stubOperatorSeams(t, "")
	s.lookPathErr = errors.New("executable file not found in $PATH")

	cmd, _, _ := operatorTestCmd()
	err := runOperator(cmd)
	var ece *riff.ExitCodeError
	if !errors.As(err, &ece) {
		t.Fatalf("runOperator() error = %T %v, want *riff.ExitCodeError", err, err)
	}
	if ece.Code != riff.ExitPrecondition {
		t.Errorf("exit code = %d, want %d (hard refusal, no degrade)", ece.Code, riff.ExitPrecondition)
	}
	if !strings.Contains(ece.Msg, "fab-kit") {
		t.Errorf("message = %q, want it naming fab-kit as the required companion tool", ece.Msg)
	}
	if len(s.calls) != 0 {
		t.Errorf("tmux calls = %v, want none before the preconditions pass", s.calls)
	}
}

// The singleton matcher: a role-option hit beats a name hit regardless of
// order; the name fallback exact-matches the LAST tab field — no
// prefix/substring hits, tab-containing names never match.
func TestFindOperatorWindowID(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"role hit", "@7\toperator\tmain", "@7"},
		{"role beats an earlier name hit", "@3\t\toperator\n@7\toperator\tmain", "@7"},
		{"role beats a later name hit", "@7\toperator\tmain\n@3\t\toperator", "@7"},
		{"name fallback", "@3\t\toperator", "@3"},
		{"first name hit wins", "@3\t\toperator\n@9\t\toperator", "@3"},
		{"no match", "@3\t\tother\n@4\t\tshell", ""},
		{"no prefix match", "@3\t\toperator-2", ""},
		{"no substring match", "@3\t\tmy operator", ""},
		{"tab-containing name never exact-matches", "@5\t\tmy\toperator", ""},
		{"role value must be exact; name fallback still applies", "@5\toperator-2\toperator", "@5"},
		{"other roles do not match", "@5\tsidekick\tmain", ""},
		{"empty output", "", ""},
		{"lines missing columns skipped", "garbage\n@2\t\toperator", "@2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := findOperatorWindowID(tc.in); got != tc.want {
				t.Errorf("findOperatorWindowID(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// A role-marked operator window — even in ANOTHER session — is selected by its
// @N id, switch-client is attempted, no new window is created, no delivery
// runs, and the switch is reported verbatim.
func TestOperatorSelectsExistingRoleWindow(t *testing.T) {
	resetOperatorWorkers(t)
	// A name-only 'operator' window appears FIRST; the role-marked one wins.
	s := stubOperatorSeams(t, "@3\t\toperator\n@7\toperator\tmain\n")
	cmd, outBuf, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}
	want := []operatorCall{
		{args: []string{"list-windows", "-a", "-F", operatorListFormat}},
		{args: []string{"select-window", "-t", "@7"}},
		{args: []string{"switch-client", "-t", "@7"}},
	}
	if len(s.calls) != len(want) {
		t.Fatalf("tmux calls = %v, want %v", s.calls, want)
	}
	for i, c := range s.calls {
		if strings.Join(c.args, " ") != strings.Join(want[i].args, " ") {
			t.Errorf("call %d argv = %v, want %v", i, c.args, want[i].args)
		}
		if !strings.Contains(strings.Join(c.env, "\n"), "TMUX="+operatorTestSocket) {
			t.Errorf("call %d env lacks restored TMUX=%s", i, operatorTestSocket)
		}
	}
	if len(s.stampOps) != 0 {
		t.Errorf("stamp ops = %v, want none when switching to an existing tab", s.stampOps)
	}
	if len(s.rootStamps) != 0 {
		t.Errorf("root stamps = %v, want none on a singleton hit (no launch happened)", s.rootStamps)
	}
	if len(s.deliverCalls) != 0 {
		t.Errorf("deliveries = %v, want none when returning to an existing tab", s.deliverCalls)
	}
	if got := outBuf.String(); got != "Switched to existing operator tab.\n" {
		t.Errorf("stdout = %q, want the exact switch report", got)
	}
}

// A failing switch-client is ignored — the window may live in another session
// and the singleton invariant is already preserved by select-window.
func TestOperatorSwitchClientFailureIgnored(t *testing.T) {
	resetOperatorWorkers(t)
	stubOperatorSeams(t, "@7\toperator\tmain\n")
	origRun := operatorRunFn
	operatorRunFn = func(ctx context.Context, args, env []string) error {
		if args[0] == "switch-client" {
			return errors.New("no current client")
		}
		return origRun(ctx, args, env)
	}
	t.Cleanup(func() { operatorRunFn = origRun })

	cmd, outBuf, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v, want nil (switch-client is best-effort)", err)
	}
	if got := outBuf.String(); got != "Switched to existing operator tab.\n" {
		t.Errorf("stdout = %q, want the switch report", got)
	}
}

// The launcher resolves with tier exactly "operator", rooted at the git root
// of the process cwd.
func TestOperatorTierPlumbing(t *testing.T) {
	resetOperatorWorkers(t)
	s := stubOperatorSeams(t, "@3\t\tother\n")
	cmd, _, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}
	if s.tier != operatorTier {
		t.Errorf("ResolveAgent tier = %q, want %q", s.tier, operatorTier)
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	if want := config.FindGitRoot(cwd); s.repoRoot != want {
		t.Errorf("ResolveAgent repoRoot = %q, want %q (FindGitRoot of cwd)", s.repoRoot, want)
	}
}

// With no operator window on the server, a new window named 'operator' opens
// at the git root running the BARE launcher, the pane id is captured, the role
// write-path stamps it IN ORDER (radio clear → option write → demote displaced
// → move in), and the kickoff is delivered through the inject composite
// targeting the new pane on the caller's server. No degrade note is printed on
// the happy path.
func TestOperatorCreatesStampsAndDelivers(t *testing.T) {
	resetOperatorWorkers(t)
	s := stubOperatorSeams(t, "@3\t\tother\n")
	s.stampDisplaced = []string{"@9"}
	cmd, outBuf, errBuf := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	windowDir := config.FindGitRoot(cwd)
	if windowDir == "" {
		windowDir = cwd
	}

	var newWindow []string
	for _, c := range s.calls {
		if c.args[0] == "new-window" {
			newWindow = c.args
		}
		if !strings.Contains(strings.Join(c.env, "\n"), "TMUX="+operatorTestSocket) {
			t.Errorf("call %v env lacks restored TMUX=%s", c.args, operatorTestSocket)
		}
	}
	wantNewWindow := []string{
		"new-window", "-P", "-F", "#{pane_id}", "-c", windowDir, "-n", "operator",
		`${SHELL:-/bin/sh} -i -c 'claude --dangerously-skip-permissions'; exec "${SHELL:-/bin/sh}"`,
	}
	if strings.Join(newWindow, " ") != strings.Join(wantNewWindow, " ") {
		t.Errorf("new-window argv =\n  %v\nwant\n  %v", newWindow, wantNewWindow)
	}

	// The stamp runs the full role write-path in order, targeting the new
	// window id, with the server socket prefix derived from $TMUX.
	if len(s.stampOps) != 4 {
		t.Fatalf("stamp ops = %v, want clear → set → demote → move", s.stampOps)
	}
	if s.stampOps[0] != "clear" {
		t.Errorf("stamp op 0 = %q, want the radio clear first", s.stampOps[0])
	}
	setOp := s.stampOps[1]
	for _, frag := range []string{"-S", "/tmp/rk-test-sock", "set-option", "-t", operatorTestWindow, "@rk_win_role", "operator"} {
		if !strings.Contains(setOp, frag) {
			t.Errorf("stamp op 1 = %q, want it to contain %q", setOp, frag)
		}
	}
	if s.stampOps[2] != "demote @9" {
		t.Errorf("stamp op 2 = %q, want the displaced carrier demoted before the move", s.stampOps[2])
	}
	if s.stampOps[3] != "move "+operatorTestWindow {
		t.Errorf("stamp op 3 = %q, want the promotion of the new window", s.stampOps[3])
	}

	if len(s.deliverCalls) != 1 {
		t.Fatalf("deliveries = %v, want exactly one", s.deliverCalls)
	}
	d := s.deliverCalls[0]
	if d.paneID != operatorTestPane || d.text != operatorKickoffPrompt {
		t.Errorf("delivery = (pane %q, text %q), want (%s, %q)", d.paneID, d.text, operatorTestPane, operatorKickoffPrompt)
	}
	if d.server != "rk-test-sock" {
		t.Errorf("delivery server = %q, want the $TMUX socket basename %q", d.server, "rk-test-sock")
	}

	if got := outBuf.String(); got != "Opened operator tab (window \"operator\").\n" {
		t.Errorf("stdout = %q, want the launch report", got)
	}
	if errBuf.Len() != 0 {
		t.Errorf("stderr = %q, want empty on a verified delivery", errBuf.String())
	}
}

// An empty or malformed window id from display-message fails (exit 3) BEFORE
// the role write-path runs — stampOperatorRole with keepWindowID "" would
// radio-clear @rk_win_role from every window on the server.
func TestOperatorInvalidWindowIDFailsBeforeStamp(t *testing.T) {
	for _, winOut := range []string{"\n", "42\n"} {
		t.Run(fmt.Sprintf("winOut=%q", winOut), func(t *testing.T) {
			resetOperatorWorkers(t)
			s := stubOperatorSeams(t, "@3\t\tother\n")
			origOut := operatorRunOutputFn
			operatorRunOutputFn = func(ctx context.Context, args, env []string) ([]byte, error) {
				if args[0] == "display-message" {
					return []byte(winOut), nil
				}
				return origOut(ctx, args, env)
			}
			t.Cleanup(func() { operatorRunOutputFn = origOut })

			cmd, _, _ := operatorTestCmd()
			err := runOperator(cmd)
			if err == nil {
				t.Fatalf("runOperator() with window id output %q = nil, want a subprocess error", winOut)
			}
			var ece *riff.ExitCodeError
			if !errors.As(err, &ece) {
				t.Fatalf("runOperator() error = %T %v, want *riff.ExitCodeError", err, err)
			}
			if ece.Code != riff.ExitSubprocess {
				t.Errorf("exit code = %d, want %d (subprocess)", ece.Code, riff.ExitSubprocess)
			}
			if len(s.stampOps) != 0 {
				t.Errorf("stamp ops = %v, want none — an invalid window id must never reach the role write-path", s.stampOps)
			}
			if len(s.deliverCalls) != 0 {
				t.Errorf("deliveries = %v, want none after a failed window-id resolve", s.deliverCalls)
			}
		})
	}
}

// A valid --workers value prefixes the AGENT COMMAND ONLY, inside the shell
// string, before the interactive wrap.
func TestOperatorWorkersPrefixComposition(t *testing.T) {
	resetOperatorWorkers(t)
	operatorWorkersFlag = "kimi"
	s := stubOperatorSeams(t, "@3\t\tother\n")
	cmd, _, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}
	var newWindow []string
	for _, c := range s.calls {
		if c.args[0] == "new-window" {
			newWindow = c.args
		}
	}
	want := `${SHELL:-/bin/sh} -i -c 'FAB_AGENT_WORKERS=kimi claude --dangerously-skip-permissions'; exec "${SHELL:-/bin/sh}"`
	if got := newWindow[len(newWindow)-1]; got != want {
		t.Errorf("new-window shell string =\n  %q\nwant\n  %q", got, want)
	}
}

// The composition helper pins both forms byte-for-byte: unset --workers is the
// bare SkillPaneCommand composition; a valid value scopes the env prefix to
// layer 1.
func TestOperatorShellCommand(t *testing.T) {
	bare := operatorShellCommand(riff.DefaultLauncher, "")
	if want := riff.SkillPaneCommand(riff.DefaultLauncher, ""); bare != want {
		t.Errorf("operatorShellCommand(unset) =\n  %q\nwant byte-identical\n  %q", bare, want)
	}
	got := operatorShellCommand(riff.DefaultLauncher, "kimi")
	want := `${SHELL:-/bin/sh} -i -c 'FAB_AGENT_WORKERS=kimi claude --dangerously-skip-permissions'; exec "${SHELL:-/bin/sh}"`
	if got != want {
		t.Errorf("operatorShellCommand(kimi) =\n  %q\nwant\n  %q", got, want)
	}
	if strings.Contains(bare, "FAB_AGENT_WORKERS") || strings.Contains(bare, "fab-operator") {
		t.Errorf("bare composition %q must not embed the workers prefix or the kickoff prompt", bare)
	}
}

// When the delivery fails (readiness deadline, probe failure, …), the command
// still succeeds — the window exists — and stderr carries the
// paste-it-yourself note with the exact kickoff text.
func TestOperatorDeliveryDegradesToPasteNote(t *testing.T) {
	resetOperatorWorkers(t)
	s := stubOperatorSeams(t, "@3\t\tother\n")
	s.deliverErr = inject.ErrNotReady

	cmd, outBuf, errBuf := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v, want nil (delivery miss degrades, never errors)", err)
	}
	if !strings.Contains(outBuf.String(), "Opened operator tab") {
		t.Errorf("stdout = %q, want the launch report", outBuf.String())
	}
	if !strings.Contains(errBuf.String(), operatorKickoffPrompt) {
		t.Errorf("stderr = %q, want the paste-it-yourself note carrying the kickoff text", errBuf.String())
	}
}

// A codex-resolved operator tier (skill_prefix `$`) gets the kickoff rendered
// for its provider: the typed delivery and the paste-it-yourself degrade note
// both carry `$fab-operator`. The claude (slash) case is byte-identical to
// pre-change behavior — covered by TestOperatorCreatesStampsAndDelivers.
func TestOperatorCodexPrefixRendersKickoff(t *testing.T) {
	resetOperatorWorkers(t)
	s := stubOperatorSeams(t, "@3\t\tother\n")
	s.skillPrefix = "$"

	cmd, _, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}
	if len(s.deliverCalls) != 1 {
		t.Fatalf("deliveries = %v, want exactly one", s.deliverCalls)
	}
	if want := "$fab-operator"; s.deliverCalls[0].text != want {
		t.Errorf("delivered kickoff = %q, want the prefix-rendered %q", s.deliverCalls[0].text, want)
	}
}

// The degrade note on a codex-resolved tier shows the RENDERED kickoff, not
// the canonical slash constant.
func TestOperatorCodexPrefixDegradeNoteRendered(t *testing.T) {
	resetOperatorWorkers(t)
	s := stubOperatorSeams(t, "@3\t\tother\n")
	s.skillPrefix = "$"
	s.deliverErr = inject.ErrNotReady

	cmd, _, errBuf := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v, want nil (delivery miss degrades, never errors)", err)
	}
	if !strings.Contains(errBuf.String(), "$fab-operator") {
		t.Errorf("stderr = %q, want the paste-it-yourself note carrying the rendered kickoff $fab-operator", errBuf.String())
	}
	if strings.Contains(errBuf.String(), "/fab-operator") {
		t.Errorf("stderr = %q, must not carry the canonical slash form for a codex operator", errBuf.String())
	}
}

// A failing list-windows probe is a subprocess-class (exit 3) error.
func TestOperatorListWindowsFailure(t *testing.T) {
	resetOperatorWorkers(t)
	s := stubOperatorSeams(t, "")
	origOut := operatorRunOutputFn
	operatorRunOutputFn = func(_ context.Context, _, _ []string) ([]byte, error) {
		return nil, fmt.Errorf("boom")
	}
	t.Cleanup(func() { operatorRunOutputFn = origOut })

	cmd, _, _ := operatorTestCmd()
	err := runOperator(cmd)
	var ece *riff.ExitCodeError
	if !errors.As(err, &ece) || ece.Code != riff.ExitSubprocess {
		t.Errorf("runOperator() error = %v, want *riff.ExitCodeError code %d", err, riff.ExitSubprocess)
	}
	if len(s.calls) != 0 {
		// The failing call itself went through the replaced seam, not the recorder.
		t.Errorf("recorded calls = %v, want none past the failed probe", s.calls)
	}
}

// --- Launcher-only: no cron state access ---

// TestOperatorTouchesNoCronState: the operator-tick cron entry is the
// consumer's (fab's clock reconcile seeds and tunes it), so rk operator neither
// reads nor writes the cron state directory and emits no seed warning — on the
// interactive path and the -L/--server path alike.
func TestOperatorTouchesNoCronState(t *testing.T) {
	for _, tc := range []struct {
		name   string
		server string
	}{{"interactive", ""}, {"server-mode", "runKit"}} {
		t.Run(tc.name, func(t *testing.T) {
			resetOperatorWorkers(t)
			resetOperatorServer(t)
			operatorServerFlag = tc.server
			stubOperatorSeams(t, "@3\t\tother\n")
			if tc.server != "" {
				origTMUX := operatorOriginalTMUXFn
				operatorOriginalTMUXFn = func() string { return "" }
				t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })
			}
			stateDir := t.TempDir()
			origDir := cronDirFn
			cronDirFn = func() (string, error) { return stateDir, nil }
			t.Cleanup(func() { cronDirFn = origDir })

			cmd, _, errBuf := operatorTestCmd()
			if err := runOperator(cmd); err != nil {
				t.Fatalf("runOperator() = %v", err)
			}
			files, err := os.ReadDir(stateDir)
			if err != nil {
				t.Fatal(err)
			}
			if len(files) != 0 {
				t.Errorf("cron state dir gained %d file(s), want none", len(files))
			}
			if strings.Contains(errBuf.String(), "seed") {
				t.Errorf("stderr = %q, want no seed warning", errBuf.String())
			}
		})
	}
}

// --- rk operator -L/--server (daemon-invocable) ---
//
// With -L the inside-tmux precondition is waived, every tmux call is addressed
// at -L <name> with no restored $TMUX, a singleton hit switches no client, and
// a created window's directory comes from the server's recorded operator root
// (@rk_srv_operator_root), falling back to the home directory when none is
// recorded or the record no longer validates. Without the flag every path is
// the interactive one above.

// resetOperatorServer restores the -L/--server package var after a test.
func resetOperatorServer(t *testing.T) {
	t.Helper()
	orig := operatorServerFlag
	operatorServerFlag = ""
	t.Cleanup(func() { operatorServerFlag = orig })
}

// TestOperatorServerFlagCreatesWithoutTMUX: $TMUX unset + -L runKit + no
// operator window ⇒ the probe and new-window run with a leading "-L runKit"
// and a nil env, the role is stamped, the kickoff is delivered addressed at
// runKit, and no select-window/switch-client is ever recorded. With no
// recorded operator root on the server (the stub serves none) the window
// falls back to the home directory, rung home, and agent resolution receives
// an empty root; the home directory is stamped as the server's operator root.
func TestOperatorServerFlagCreatesWithoutTMUX(t *testing.T) {
	resetOperatorWorkers(t)
	resetOperatorServer(t)
	operatorServerFlag = "runKit"
	s := stubOperatorSeams(t, "@3\t\tother\n")
	origTMUX := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })

	cmd, outBuf, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	var probe, newWindow []string
	for _, c := range s.calls {
		if len(c.env) != 0 {
			t.Errorf("call %v env = %v, want nil (nothing restored in server mode)", c.args, c.env)
		}
		if len(c.args) < 2 || c.args[0] != "-L" || c.args[1] != "runKit" {
			t.Errorf("call argv = %v, want a leading -L runKit", c.args)
		}
		switch {
		case len(c.args) > 2 && c.args[2] == "list-windows":
			probe = c.args
		case len(c.args) > 2 && c.args[2] == "new-window":
			newWindow = c.args
		case len(c.args) > 2 && (c.args[2] == "select-window" || c.args[2] == "switch-client"):
			t.Errorf("client-switching call %v must never run in server mode", c.args)
		}
	}
	if probe == nil {
		t.Error("no list-windows probe recorded")
	}
	wantNewWindow := []string{
		"-L", "runKit", "new-window", "-P", "-F", "#{pane_id}", "-c", home, "-n", "operator",
		`${SHELL:-/bin/sh} -i -c 'claude --dangerously-skip-permissions'; exec "${SHELL:-/bin/sh}"`,
	}
	if strings.Join(newWindow, " ") != strings.Join(wantNewWindow, " ") {
		t.Errorf("new-window argv =\n  %v\nwant\n  %v", newWindow, wantNewWindow)
	}
	if s.repoRoot != "" {
		t.Errorf("agent-resolution root = %q, want empty on the home fallback", s.repoRoot)
	}
	if len(s.rootStamps) != 1 || s.rootStamps[0] != (operatorRootStamp{server: "runKit", dir: home}) {
		t.Errorf("root stamps = %v, want one stamp of the home dir on runKit", s.rootStamps)
	}
	if len(s.stampOps) != 3 || s.stampOps[0] != "clear" || s.stampOps[2] != "move "+operatorTestWindow {
		t.Errorf("stamp ops = %v, want clear → set → move (no displaced carriers)", s.stampOps)
	} else if !strings.Contains(s.stampOps[1], "-L runKit") || !strings.Contains(s.stampOps[1], "@rk_win_role operator") {
		t.Errorf("stamp set op = %q, want it -L-addressed at runKit writing @rk_win_role=operator", s.stampOps[1])
	}
	if len(s.deliverCalls) != 1 || s.deliverCalls[0].server != "runKit" {
		t.Errorf("deliveries = %v, want one kickoff addressed at runKit", s.deliverCalls)
	}
	if got := outBuf.String(); got != "Opened operator tab (window \"operator\").\n" {
		t.Errorf("stdout = %q, want the launch report", got)
	}
}

// newWindowDirArg extracts the -c argument of the recorded new-window call.
func newWindowDirArg(t *testing.T, s *operatorStub) string {
	t.Helper()
	for _, c := range s.calls {
		for i, a := range c.args {
			if a == "new-window" {
				for j := i + 1; j+1 < len(c.args); j++ {
					if c.args[j] == "-c" {
						return c.args[j+1]
					}
				}
			}
		}
	}
	t.Fatal("no new-window call recorded")
	return ""
}

// TestOperatorServerFlagUsesStoredRoot: a recorded @rk_srv_operator_root that
// still validates decides the window directory (rung stored), the agent
// resolver receives the dir itself when it is not inside a git repository, and
// the --json receipt carries dir/dir_rung. The create re-stamps the same root.
func TestOperatorServerFlagUsesStoredRoot(t *testing.T) {
	resetOperatorWorkers(t)
	resetOperatorServer(t)
	resetOperatorJSON(t)
	operatorServerFlag = "runKit"
	operatorJSONFlag = true
	s := stubOperatorSeams(t, "@3\t\tother\n")
	origTMUX := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })

	stored := t.TempDir()
	s.getRoot = stored

	cmd, outBuf, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}
	if got := newWindowDirArg(t, s); got != stored {
		t.Errorf("new-window -c = %q, want the stored root %q", got, stored)
	}
	if s.repoRoot != stored {
		t.Errorf("agent-resolution root = %q, want the stored dir %q (no git root found)", s.repoRoot, stored)
	}
	assertEnvelopeResult(t, outBuf.String(), map[string]any{
		"window": "@42", "server": "runKit", "created": true, "dir": stored, "dir_rung": "stored",
	})
	if len(s.rootStamps) != 1 || s.rootStamps[0] != (operatorRootStamp{server: "runKit", dir: stored}) {
		t.Errorf("root stamps = %v, want one stamp of %q on runKit", s.rootStamps, stored)
	}
}

// TestOperatorServerFlagStaleStoredRootFallsBackHome: a recorded root that no
// longer exists (deleted since the stamp) fails validation and degrades to the
// home fallback — the command still opens the window.
func TestOperatorServerFlagStaleStoredRootFallsBackHome(t *testing.T) {
	resetOperatorWorkers(t)
	resetOperatorServer(t)
	operatorServerFlag = "runKit"
	s := stubOperatorSeams(t, "@3\t\tother\n")
	s.getRoot = "/nonexistent/rk-operator-stale-root"
	origTMUX := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })

	cmd, _, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v, want the home fallback on a stale stored root", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	if got := newWindowDirArg(t, s); got != home {
		t.Errorf("new-window -c = %q, want the home fallback %q", got, home)
	}
	if s.repoRoot != "" {
		t.Errorf("agent-resolution root = %q, want empty on the home fallback", s.repoRoot)
	}
}

// TestOperatorServerFlagRootReadErrorFallsBackHome: a stored-root read error
// (the server unreachable) degrades to the home fallback — the command still
// opens the window.
func TestOperatorServerFlagRootReadErrorFallsBackHome(t *testing.T) {
	resetOperatorWorkers(t)
	resetOperatorServer(t)
	operatorServerFlag = "runKit"
	s := stubOperatorSeams(t, "@3\t\tother\n")
	s.getRootErr = errors.New("tmux unreachable")
	origTMUX := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })

	cmd, _, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v, want the home fallback on a read error", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	if got := newWindowDirArg(t, s); got != home {
		t.Errorf("new-window -c = %q, want the home fallback %q", got, home)
	}
	if s.repoRoot != "" {
		t.Errorf("agent-resolution root = %q, want empty on the home fallback", s.repoRoot)
	}
}

// TestOperatorStampsRootOnCreate: every successful create records the window
// directory on the server the window was created on — the caller's
// socket-basename label interactively (the cliServerLabel derivation), the -L
// value in server mode.
func TestOperatorStampsRootOnCreate(t *testing.T) {
	for _, tc := range []struct {
		name       string
		server     string
		wantServer string
	}{
		{"interactive stamps the caller's server label", "", "rk-test-sock"},
		{"server mode stamps the -L server", "runKit", "runKit"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetOperatorWorkers(t)
			resetOperatorServer(t)
			operatorServerFlag = tc.server
			s := stubOperatorSeams(t, "@3\t\tother\n")
			if tc.server != "" {
				origTMUX := operatorOriginalTMUXFn
				operatorOriginalTMUXFn = func() string { return "" }
				t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })
			}

			cmd, _, _ := operatorTestCmd()
			if err := runOperator(cmd); err != nil {
				t.Fatalf("runOperator() = %v", err)
			}
			if len(s.rootStamps) != 1 {
				t.Fatalf("root stamps = %v, want exactly one", s.rootStamps)
			}
			if s.rootStamps[0].server != tc.wantServer {
				t.Errorf("stamp server = %q, want %q", s.rootStamps[0].server, tc.wantServer)
			}
			if got, want := s.rootStamps[0].dir, newWindowDirArg(t, s); got != want {
				t.Errorf("stamp dir = %q, want the window's -c %q", got, want)
			}
		})
	}
}

// TestOperatorStampFailureIsBestEffort: a failed stamp never changes the exit
// code or the receipt — stderr gains a note and the command still succeeds.
func TestOperatorStampFailureIsBestEffort(t *testing.T) {
	resetOperatorWorkers(t)
	resetOperatorServer(t)
	resetOperatorJSON(t)
	operatorServerFlag = "runKit"
	operatorJSONFlag = true
	s := stubOperatorSeams(t, "@3\t\tother\n")
	s.stampErr = errors.New("tmux set-option failed")
	origTMUX := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })

	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	cmd, outBuf, errBuf := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v, want nil (a stamp failure degrades, never errors)", err)
	}
	assertEnvelopeResult(t, outBuf.String(), map[string]any{
		"window": "@42", "server": "runKit", "created": true, "dir": home, "dir_rung": "home",
	})
	if !strings.Contains(errBuf.String(), "could not record the launch directory") {
		t.Errorf("stderr = %q, want the stamp-failure note", errBuf.String())
	}
	if len(s.deliverCalls) != 1 {
		t.Errorf("deliveries = %v, want the kickoff delivery to still run", s.deliverCalls)
	}
}

// TestOperatorServerFlagSingletonHit: an operator window already present on the
// named server ⇒ exit 0 with "Operator tab already present." and no
// select-window/switch-client, stamp, or delivery.
func TestOperatorServerFlagSingletonHit(t *testing.T) {
	resetOperatorWorkers(t)
	resetOperatorServer(t)
	operatorServerFlag = "runKit"
	s := stubOperatorSeams(t, "@7\toperator\tmain\n")
	origTMUX := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })

	cmd, outBuf, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}
	if got := outBuf.String(); got != "Operator tab already present.\n" {
		t.Errorf("stdout = %q, want the already-present report (no switch happened)", got)
	}
	for _, c := range s.calls {
		for _, a := range c.args {
			if a == "select-window" || a == "switch-client" {
				t.Errorf("call %v must never run on a server-mode singleton hit", c.args)
			}
		}
	}
	if len(s.stampOps) != 0 || len(s.deliverCalls) != 0 {
		t.Errorf("stamp ops = %v, deliveries = %v, want none", s.stampOps, s.deliverCalls)
	}
	if len(s.rootStamps) != 0 {
		t.Errorf("root stamps = %v, want none on a singleton hit (no launch happened)", s.rootStamps)
	}
}

// TestOperatorServerPrefix: bare for ""/default, else -L <server>.
func TestOperatorServerPrefix(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"default", nil},
		{"runKit", []string{"-L", "runKit"}},
	} {
		if got := operatorServerPrefix(tc.in); strings.Join(got, " ") != strings.Join(tc.want, " ") {
			t.Errorf("operatorServerPrefix(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

// resetOperatorJSON restores the --json package var after a test mutates it
// (the resetOperatorWorkers pattern).
func resetOperatorJSON(t *testing.T) {
	t.Helper()
	orig := operatorJSONFlag
	operatorJSONFlag = false
	t.Cleanup(func() { operatorJSONFlag = orig })
}

// TestOperatorJSONServerModeSingletonHit: `rk operator -L runKit --json` with
// an existing operator window prints exactly one envelope with created:false
// and runs no select-window/switch-client (the R7 singleton-hit contract).
func TestOperatorJSONServerModeSingletonHit(t *testing.T) {
	resetOperatorWorkers(t)
	resetOperatorServer(t)
	resetOperatorJSON(t)
	operatorServerFlag = "runKit"
	operatorJSONFlag = true
	s := stubOperatorSeams(t, "@7\toperator\tmain\n")
	origTMUX := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })

	cmd, outBuf, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}
	assertEnvelopeResult(t, outBuf.String(), map[string]any{"window": "@7", "server": "runKit", "created": false})
	for _, c := range s.calls {
		for _, a := range c.args {
			if a == "select-window" || a == "switch-client" {
				t.Errorf("call %v must never run on a server-mode singleton hit", c.args)
			}
		}
	}
}

// TestOperatorJSONInteractiveSingletonHit: the interactive singleton hit
// prints the same created:false receipt with the caller's socket-basename
// server label (select/switch still run — that branch is a real switch).
func TestOperatorJSONInteractiveSingletonHit(t *testing.T) {
	resetOperatorWorkers(t)
	resetOperatorJSON(t)
	operatorJSONFlag = true
	stubOperatorSeams(t, "@7\toperator\tmain\n")

	cmd, outBuf, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}
	assertEnvelopeResult(t, outBuf.String(), map[string]any{"window": "@7", "server": "rk-test-sock", "created": false})
}

// TestOperatorJSONCreatedReceipt: the create branch resolves the new window's
// @N via display-message through the tmux seam and prints created:true; the
// human line and the kickoff delivery are unchanged in shape.
func TestOperatorJSONCreatedReceipt(t *testing.T) {
	resetOperatorWorkers(t)
	resetOperatorJSON(t)
	operatorJSONFlag = true
	s := stubOperatorSeams(t, "")

	cmd, outBuf, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}
	assertEnvelopeResult(t, outBuf.String(), map[string]any{"window": "@42", "server": "rk-test-sock", "created": true})
	displayCalls := 0
	for _, c := range s.calls {
		if len(c.args) > 0 && c.args[0] == "display-message" {
			displayCalls++
		}
	}
	if displayCalls != 2 {
		t.Errorf("display-message calls = %d, want 2 (the create path's resolve + the receipt's)", displayCalls)
	}
	if len(s.deliverCalls) != 1 {
		t.Errorf("deliveries = %v, want the kickoff delivery to still run", s.deliverCalls)
	}
}

// TestOperatorJSONPreconditionEnvelope: a riff.ExitCodeError under --json
// writes the error envelope to stdout BEFORE the wrapper's os.Exit — observed
// out of process (the RK_RIFF_SUBPROC re-exec pattern): the child runs
// `rk operator --json` with $TMUX unset, which fails the precondition (exit 1)
// before any tmux/fab dependency matters.
func TestOperatorJSONPreconditionEnvelope(t *testing.T) {
	if os.Getenv("RK_OPERATOR_SUBPROC") == "1" {
		rootCmd.SetArgs([]string{"operator", "--json"})
		execute()
		os.Exit(0) // unreachable when the precondition fired
	}
	cmd := exec.Command(os.Args[0], "-test.run", "^TestOperatorJSONPreconditionEnvelope$")
	env := []string{"RK_OPERATOR_SUBPROC=1"}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "TMUX=") || strings.HasPrefix(kv, "TMUX_PANE=") {
			continue
		}
		env = append(env, kv)
	}
	cmd.Env = env
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("expected the child to exit non-zero, got err=%v", err)
	}
	if got := ee.ExitCode(); got != 1 {
		t.Errorf("exit code = %d, want 1 (precondition)", got)
	}
	var doc struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if jsonErr := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &doc); jsonErr != nil {
		t.Fatalf("child stdout is not one JSON document: %v (%q)", jsonErr, stdout.String())
	}
	if doc.OK || doc.Error.Code != "operational" || !strings.Contains(doc.Error.Message, "not inside a tmux session") {
		t.Errorf("envelope = %q, want ok:false operational naming the precondition", stdout.String())
	}
}

// --- --dir override, kickoff visibility, server-mode delivery opts ---

// resetOperatorDir restores the --dir package var after a test (the
// resetOperatorServer pattern).
func resetOperatorDir(t *testing.T) {
	t.Helper()
	orig := operatorDirFlag
	operatorDirFlag = ""
	t.Cleanup(func() { operatorDirFlag = orig })
}

// A --dir value that is not an absolute path to an existing directory is a
// usage error (exit 2) before ANY subprocess — the value never reaches tmux.
func TestOperatorDirUsageErrors(t *testing.T) {
	resetOperatorDir(t)
	file, err := os.CreateTemp(t.TempDir(), "not-a-dir")
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		dir     string
		wantMsg string
	}{
		{"relative path", "relative/path", "absolute"},
		{"nonexistent path", "/nonexistent/rk-operator-dir-test", "does not exist"},
		{"a file, not a directory", file.Name(), "not a directory"},
		// --dir= / --dir "": explicitly supplied but empty is rejected, never
		// silently treated as unset (the flag's Changed state carries it).
		{"explicit empty value", "", "absolute"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			operatorDirFlag = tc.dir
			s := stubOperatorSeams(t, "")
			cmd, _, _ := operatorTestCmd()
			cmd.Flags().StringVar(&operatorDirFlag, "dir", "", "")
			if err := cmd.Flags().Set("dir", tc.dir); err != nil {
				t.Fatal(err)
			}
			err := runOperator(cmd)
			if err == nil {
				t.Fatalf("runOperator() with --dir %q = nil, want a usage error", tc.dir)
			}
			if code := exitCode(err); code != exitUsage {
				t.Errorf("exitCode(--dir %q) = %d, want %d (usage)", tc.dir, code, exitUsage)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("error = %q, want it naming the failed check (%q)", err, tc.wantMsg)
			}
			if len(s.calls) != 0 {
				t.Errorf("tmux calls = %v, want none before validation passes", s.calls)
			}
		})
	}
}

// A valid --dir is used verbatim as the window directory (rung explicit) in
// server mode, the stored-root read does not run, and the agent resolver
// receives the dir itself when it is not inside a git repository. The create
// stamps the explicit dir as the server's operator root.
func TestOperatorDirExplicitOverride(t *testing.T) {
	resetOperatorWorkers(t)
	resetOperatorServer(t)
	resetOperatorDir(t)
	resetOperatorJSON(t)
	operatorServerFlag = "runKit"
	operatorJSONFlag = true
	dir := t.TempDir()
	operatorDirFlag = dir
	s := stubOperatorSeams(t, "@3\t\tother\n")
	origTMUX := operatorOriginalTMUXFn
	operatorOriginalTMUXFn = func() string { return "" }
	t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })

	cmd, outBuf, _ := operatorTestCmd()
	if err := runOperator(cmd); err != nil {
		t.Fatalf("runOperator() = %v", err)
	}
	if got := newWindowDirArg(t, s); got != dir {
		t.Errorf("new-window -c = %q, want --dir verbatim %q", got, dir)
	}
	if s.getRootCalls != 0 {
		t.Errorf("stored-root reads = %d, want none — an explicit --dir skips the read", s.getRootCalls)
	}
	if s.repoRoot != dir {
		t.Errorf("agent-resolution root = %q, want the --dir value %q (no git root found)", s.repoRoot, dir)
	}
	assertEnvelopeResult(t, outBuf.String(), map[string]any{
		"window": "@42", "server": "runKit", "created": true, "dir": dir, "dir_rung": "explicit",
	})
	if len(s.rootStamps) != 1 || s.rootStamps[0] != (operatorRootStamp{server: "runKit", dir: dir}) {
		t.Errorf("root stamps = %v, want one stamp of the explicit dir on runKit", s.rootStamps)
	}
}

// kickoffReason maps the delivery failure taxonomy onto the closed reason
// token set of the kickoff: stderr line.
func TestKickoffReason(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{&inject.ParkedError{Snippet: "trust?"}, "parked"},
		{&inject.NarrowError{Width: 40, Height: 5}, "narrow"},
		{fmt.Errorf("wrap: %w", inject.ErrGone), "gone"},
		{inject.ErrNotReady, "timeout"},
		{context.DeadlineExceeded, "timeout"},
		{errors.New("buffer exploded"), "send-error"},
	} {
		if got := kickoffReason(tc.err); got != tc.want {
			t.Errorf("kickoffReason(%v) = %q, want %q", tc.err, got, tc.want)
		}
	}
}

// An undelivered kickoff adds exactly one machine-readable
// `kickoff: undelivered reason=… prompt=<quoted> dir=<quoted>` line to stderr
// in EVERY mode (the cron respawn argv runs without --json and reads it from
// the combined-output tail); under --json stdout stays the single receipt
// document. prompt and dir are Go-quoted so a path with spaces stays one
// field.
func TestOperatorKickoffStderrLine(t *testing.T) {
	for _, tc := range []struct {
		name       string
		json       bool
		deliverErr error
		wantReason string
	}{
		{"json parked", true, &inject.ParkedError{Snippet: "trust?"}, "parked"},
		{"json narrow", true, &inject.NarrowError{Width: 40, Height: 5}, "narrow"},
		{"json gone", true, inject.ErrGone, "gone"},
		{"json timeout", true, inject.ErrNotReady, "timeout"},
		{"json send-error", true, errors.New("buffer exploded"), "send-error"},
		{"no json still emits the line", false, inject.ErrNotReady, "timeout"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetOperatorWorkers(t)
			resetOperatorJSON(t)
			operatorJSONFlag = tc.json
			s := stubOperatorSeams(t, "@3\t\tother\n")
			s.deliverErr = tc.deliverErr

			cmd, outBuf, errBuf := operatorTestCmd()
			if err := runOperator(cmd); err != nil {
				t.Fatalf("runOperator() = %v, want nil (delivery miss degrades)", err)
			}
			if !strings.Contains(errBuf.String(), "paste this into the operator agent yourself") {
				t.Errorf("stderr = %q, want the prose paste-it-yourself note", errBuf.String())
			}
			want := fmt.Sprintf("kickoff: undelivered reason=%s prompt=%q dir=\"", tc.wantReason, operatorKickoffPrompt)
			if !strings.Contains(errBuf.String(), want) {
				t.Errorf("stderr = %q, want it to contain %q", errBuf.String(), want)
			}
			if strings.Count(errBuf.String(), "kickoff: undelivered") != 1 {
				t.Errorf("stderr = %q, want exactly one kickoff: line", errBuf.String())
			}
			if !tc.json {
				if strings.TrimSpace(outBuf.String()) == "" || strings.HasPrefix(strings.TrimSpace(outBuf.String()), "{") {
					t.Errorf("stdout = %q, want the human launch report without --json", outBuf.String())
				}
				return
			}
			// stdout keeps the exactly-one-JSON-document contract.
			var doc struct {
				OK bool `json:"ok"`
			}
			if err := json.Unmarshal(bytes.TrimSpace(outBuf.Bytes()), &doc); err != nil || !doc.OK {
				t.Errorf("stdout = %q, want exactly one ok JSON document", outBuf.String())
			}
		})
	}
}

// The delivery opts are mode-decided: server mode (-L) rides out walls under
// the 60s server deadline; the interactive path stays fail-fast at 25s.
func TestOperatorDeliveryOptsByMode(t *testing.T) {
	for _, tc := range []struct {
		name           string
		server         string
		wantWalls      bool
		wantDeadline   time.Duration
		wantDeadlineIs *time.Duration
	}{
		{"server mode waits through walls", "runKit", true, 60 * time.Second, &operatorServerDeliverDeadline},
		{"interactive stays fail-fast", "", false, 25 * time.Second, &operatorDeliverDeadline},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetOperatorWorkers(t)
			resetOperatorServer(t)
			operatorServerFlag = tc.server
			s := stubOperatorSeams(t, "@3\t\tother\n")
			if tc.server != "" {
				origTMUX := operatorOriginalTMUXFn
				operatorOriginalTMUXFn = func() string { return "" }
				t.Cleanup(func() { operatorOriginalTMUXFn = origTMUX })
			}

			cmd, _, _ := operatorTestCmd()
			if err := runOperator(cmd); err != nil {
				t.Fatalf("runOperator() = %v", err)
			}
			if len(s.deliverCalls) != 1 {
				t.Fatalf("deliveries = %v, want exactly one", s.deliverCalls)
			}
			opts := s.deliverCalls[0].opts
			if opts.WaitThroughWalls != tc.wantWalls {
				t.Errorf("WaitThroughWalls = %v, want %v", opts.WaitThroughWalls, tc.wantWalls)
			}
			if opts.Deadline != tc.wantDeadline || opts.Deadline != *tc.wantDeadlineIs {
				t.Errorf("Deadline = %v, want %v (the %s package var)", opts.Deadline, tc.wantDeadline, tc.name)
			}
			// A pane that dies mid-wait must end the wait promptly in both
			// modes, so the gone predicate rides every delivery.
			if opts.IsGone == nil {
				t.Fatal("IsGone = nil, want the can't-find-pane predicate")
			}
			if !opts.IsGone(errors.New("can't find pane %9")) || opts.IsGone(errors.New("something else")) {
				t.Error("IsGone must match exactly tmux's can't find pane diagnostic")
			}
		})
	}
}
