package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"rk/internal/inject"
	"rk/internal/tmux"

	"github.com/spf13/cobra"
)

// muxFake holds the installed mux-verb seams and their recordings. Defaults:
// server "default" (no $TMUX), pane %5 idle, window targets resolve to %7.
type muxFake struct {
	server      string
	states      map[string]string // pane → gate state ("" = unknown)
	paneExists  map[string]bool
	windowPanes map[string]string // window target → resolved pane

	engineCalls     []muxEngineCall
	engineErr       error
	engineRecovered bool
	keysSent        [][]string
	clearModeCalls  []string
	clearModeErr    error
	awaitRuns       []awaitParams
	awaitReports    []string // consumed one per awaitObserveFn call
	awaitErrs       []error  // per-call errors parallel to awaitReports (nil = awaitErr rides the last)
	awaitErr        error
	stdin           string
	bufferName      string

	captureContent map[string]string // pane → captured text (default: generic content)
	captureErr     error
	captureCalls   []muxCaptureCall
	facts          map[string]tmux.PaneFacts // pane → substrate facts (default: derived from states)
	factsErr       error
	killCalls      []string
	killErr        error
	guardedServers map[string]bool // server → protected (nil = none)
	panePIDs       map[string]int  // pane → shell pid (default: 1234)
	panePIDErr     error
	discoverTree   []processNode
	discoverErr    error
	nowUnix        int64 // 0 → fixed reference time (1_800_000_000)

	paneSessions    []tmux.SessionInfo // nil → the default one-session fixture
	paneSessionsSet bool               // true → honor paneSessions even when empty
	paneSessionsErr error
	paneWindows     map[string][]tmux.WindowInfo // session name → windows (nil → default)
	paneAliveErr    error

	sessionFacts    []tmux.SessionFacts // nil → the default mixed fixture
	sessionFactsSet bool                // true → honor sessionFacts even when empty
	sessionFactsErr error
	sessionAliveErr error
}

type muxCaptureCall struct {
	paneID string
	lines  int
	server string
}

type muxEngineCall struct {
	server, paneID, text string
	submit               bool
	buffer               string
}

// installMuxFakes wires every mux-verb seam to the fake (the
// installPresentFakes pattern) and restores the production defaults on cleanup.
func installMuxFakes(t *testing.T, f *muxFake) {
	t.Helper()

	origTMUX, origFlag := muxOriginalTMUXFn, muxServerFlag
	origEngine, origKeys := muxSendEngineSendFn, muxSendKeysFn
	origClearMode, origFacts := muxSendClearModeFn, muxSendFactsFn
	origExists, origResolve := muxSendPaneExistsFn, muxSendResolveWindowFn
	origAwait, origAwaitDeps := muxAwaitObserveFn, muxAwaitDepsFn
	origStdin, origBuf := muxStdinFn, muxBufferNameFn
	origCapPane, origCapFacts, origCapNow := muxCapturePaneFn, muxCaptureFactsFn, muxCaptureNowFn
	origKillState, origKillExists, origKillPane := muxKillAgentStateFn, muxKillPaneExistsFn, muxKillPaneFn
	origKillGuarded := muxKillGuardedServerFn
	origProcPID, origProcFacts, origProcDiscover := muxProcessPanePIDFn, muxProcessFactsFn, muxProcessDiscoverFn
	origPanesSessions, origPanesWindows := muxPanesSessionsFn, muxPanesWindowsFn
	origPanesAlive, origPanesNow := muxPanesAliveFn, muxPanesNowFn
	origSessionsFacts, origSessionsAlive := muxSessionsFactsFn, muxSessionsAliveFn
	t.Cleanup(func() {
		muxOriginalTMUXFn, muxServerFlag = origTMUX, origFlag
		muxSendEngineSendFn, muxSendKeysFn = origEngine, origKeys
		muxSendClearModeFn, muxSendFactsFn = origClearMode, origFacts
		muxSendPaneExistsFn, muxSendResolveWindowFn = origExists, origResolve
		muxAwaitObserveFn, muxAwaitDepsFn = origAwait, origAwaitDeps
		muxStdinFn, muxBufferNameFn = origStdin, origBuf
		muxCapturePaneFn, muxCaptureFactsFn, muxCaptureNowFn = origCapPane, origCapFacts, origCapNow
		muxKillAgentStateFn, muxKillPaneExistsFn, muxKillPaneFn = origKillState, origKillExists, origKillPane
		muxKillGuardedServerFn = origKillGuarded
		muxProcessPanePIDFn, muxProcessFactsFn, muxProcessDiscoverFn = origProcPID, origProcFacts, origProcDiscover
		muxPanesSessionsFn, muxPanesWindowsFn = origPanesSessions, origPanesWindows
		muxPanesAliveFn, muxPanesNowFn = origPanesAlive, origPanesNow
		muxSessionsFactsFn, muxSessionsAliveFn = origSessionsFacts, origSessionsAlive
		resetMuxFlags()
	})

	if f.states == nil {
		f.states = map[string]string{"%5": tmux.AgentStateIdle}
	}
	if f.windowPanes == nil {
		f.windowPanes = map[string]string{"@3": "%7", "=work:editor": "%7"}
	}
	muxOriginalTMUXFn = func() string { return "" } // server resolves to "default"
	muxServerFlag = f.server

	muxSendPaneExistsFn = func(_ context.Context, paneID, _ string) (bool, error) {
		if f.paneExists == nil {
			return true, nil
		}
		return f.paneExists[paneID], nil
	}
	muxSendResolveWindowFn = func(_ context.Context, windowTarget, _ string) (string, error) {
		if p, ok := f.windowPanes[windowTarget]; ok {
			return p, nil
		}
		return "", errors.New("can't find window")
	}
	muxSendEngineSendFn = func(_ context.Context, engine *inject.Engine, adapter inject.Tmux, server, paneID, text string, submit bool) error {
		f.engineCalls = append(f.engineCalls, muxEngineCall{server, paneID, text, submit, engine.Buffer()})
		if f.engineRecovered && f.engineErr == nil {
			if cliAdapter, ok := adapter.(cliInjectTmux); ok && cliAdapter.recoveryAttempted != nil {
				*cliAdapter.recoveryAttempted = true
			}
		}
		return f.engineErr
	}
	muxSendKeysFn = func(_ context.Context, paneID, _ string, keys ...string) error {
		f.keysSent = append(f.keysSent, append([]string{paneID}, keys...))
		return nil
	}
	muxSendClearModeFn = func(_ context.Context, paneID, _ string) error {
		f.clearModeCalls = append(f.clearModeCalls, paneID)
		return f.clearModeErr
	}
	muxAwaitObserveFn = func(_ context.Context, _ awaitDeps, _ []string, p awaitParams) (string, string, error) {
		f.awaitRuns = append(f.awaitRuns, p)
		if len(f.awaitReports) > 0 {
			r := f.awaitReports[0]
			f.awaitReports = f.awaitReports[1:]
			var err error
			if len(f.awaitErrs) > 0 {
				err = f.awaitErrs[0]
				f.awaitErrs = f.awaitErrs[1:]
			} else if len(f.awaitReports) == 0 && f.awaitErr != nil {
				// awaitErr rides the LAST scripted report (a mid-composition
				// error would end the sequence before reaching it).
				err = f.awaitErr
			}
			return r, "", err
		}
		return "running", "", f.awaitErr
	}
	muxStdinFn = func() io.Reader { return strings.NewReader(f.stdin) }
	muxBufferNameFn = func() string { return "rk-send-4242" }

	// factsFor derives the default substrate facts from the gate-state map (a
	// state entry "idle" becomes an idle fact at the fixed reference epoch), so
	// capture/process tests that only care about state need no extra setup.
	factsFor := func(paneID string) tmux.PaneFacts {
		if f.facts != nil {
			return f.facts[paneID]
		}
		facts := tmux.PaneFacts{CWD: "/home/x/code/repo"}
		if state := f.states[paneID]; state != "" {
			facts.AgentState = state
			facts.AgentStateEpoch = 1_800_000_000
		}
		return facts
	}
	nowFn := func() time.Time {
		if f.nowUnix > 0 {
			return time.Unix(f.nowUnix, 0)
		}
		return time.Unix(1_800_000_300, 0) // 5m past the default fact epoch
	}

	muxCapturePaneFn = func(_ context.Context, paneID string, lines int, server string) (string, error) {
		f.captureCalls = append(f.captureCalls, muxCaptureCall{paneID, lines, server})
		if f.captureErr != nil {
			return "", f.captureErr
		}
		if f.captureContent != nil {
			return f.captureContent[paneID], nil
		}
		return "line one\nline two\n", nil
	}
	muxCaptureFactsFn = func(_ context.Context, paneID, _ string) (tmux.PaneFacts, error) {
		return factsFor(paneID), f.factsErr
	}
	muxCaptureNowFn = nowFn

	muxSendFactsFn = func(_ context.Context, paneID, _ string) (tmux.PaneFacts, error) {
		return factsFor(paneID), f.factsErr
	}

	muxKillAgentStateFn = func(_ context.Context, paneID, _ string) (string, error) {
		return f.states[paneID], nil
	}
	muxKillPaneExistsFn = func(_ context.Context, paneID, _ string) (bool, error) {
		if f.paneExists == nil {
			return true, nil
		}
		return f.paneExists[paneID], nil
	}
	muxKillPaneFn = func(_ context.Context, paneID, _ string) error {
		f.killCalls = append(f.killCalls, paneID)
		return f.killErr
	}
	muxKillGuardedServerFn = func(_ context.Context, server string) (bool, error) {
		return f.guardedServers[server], nil
	}

	muxProcessPanePIDFn = func(_ context.Context, paneID, _ string) (int, error) {
		if f.panePIDErr != nil {
			return 0, f.panePIDErr
		}
		if f.panePIDs != nil {
			return f.panePIDs[paneID], nil
		}
		return 1234, nil
	}
	muxProcessFactsFn = func(_ context.Context, paneID, _ string) (tmux.PaneFacts, error) {
		return factsFor(paneID), f.factsErr
	}
	muxProcessDiscoverFn = func(_ context.Context, pid int) ([]processNode, error) {
		if f.discoverErr != nil {
			return nil, f.discoverErr
		}
		if f.discoverTree != nil {
			return f.discoverTree, nil
		}
		return []processNode{{
			PID: pid, Comm: "zsh", Cmdline: "-zsh", Classification: "other",
			Children: []processNode{{
				PID: 1250, PPID: pid, Comm: "claude", Cmdline: "claude", Classification: "agent",
				Children: []processNode{},
			}},
		}}, nil
	}

	// panes enumeration seams. Default fixture: one session "work" ($3) whose
	// window @3 "editor" (index 0, active) carries an idle agent pane %5 (at
	// the fixed reference epoch) and an uninstrumented shell pane %6 with pane
	// pid 1234 — the default discover fixture above hangs a claude child under
	// that pid, so %6's liveness walk reads true.
	if !f.paneSessionsSet && f.paneSessions == nil {
		f.paneSessions = []tmux.SessionInfo{{Name: "work", ID: "$3"}}
	}
	muxPanesSessionsFn = func(_ context.Context, _ string) ([]tmux.SessionInfo, error) {
		return f.paneSessions, f.paneSessionsErr
	}
	muxPanesWindowsFn = func(_ context.Context, session, _ string) ([]tmux.WindowInfo, error) {
		if f.paneWindows != nil {
			return f.paneWindows[session], nil
		}
		return []tmux.WindowInfo{{
			Index: 0, WindowID: "@3", Name: "editor", IsActiveWindow: true,
			Panes: []tmux.PaneInfo{
				{PaneID: "%5", PaneIndex: 0, IsActive: true, Cwd: "/home/x/code/repo", Command: "node",
					AgentState: tmux.AgentStateIdle, AgentStateEpoch: 1_800_000_000},
				{PaneID: "%6", PaneIndex: 1, Cwd: "/home/x/code/repo", Command: "zsh", PanePID: 1234},
			},
		}}, nil
	}
	muxPanesAliveFn = func(_ context.Context, _ string) error { return f.paneAliveErr }
	muxPanesNowFn = nowFn
	muxSessionsFactsFn = func(_ context.Context, _ string) ([]tmux.SessionFacts, error) {
		if f.sessionFactsErr != nil {
			return nil, f.sessionFactsErr
		}
		if f.sessionFacts != nil || f.sessionFactsSet {
			return f.sessionFacts, nil
		}
		return defaultSessionFactsFixture(), nil
	}
	muxSessionsAliveFn = func(_ context.Context, _ string) error { return f.sessionAliveErr }
}

// resetMuxFlags returns every mux flag (and the root --quiet) to its default so
// no state bleeds between tests (the resetPresentFlagState pattern).
func resetMuxFlags() {
	muxSendKeysFlag = nil
	muxSendAnswerFlag, muxSendForceFlag, muxSendNoEnterFlag = false, false, false
	muxSendAwaitFlag, muxSendTimeoutFlag = "", awaitDefaultTimeoutSec
	muxSendJSONFlag = false
	awaitUntilFlag, awaitFileFlag = tmux.AgentStateIdle, ""
	awaitAfterActiveFlag = false
	awaitTimeoutFlag = awaitDefaultTimeoutSec
	awaitNotifyFlag = ""
	awaitAnyFlag = false
	awaitReadyFlag = false
	awaitJSONFlag = false
	muxCaptureLinesFlag = 50
	muxCaptureJSONFlag, muxCaptureRawFlag, muxCaptureClassifyFlag = false, false, false
	muxKillForceFlag = false
	muxKillJSONFlag = false
	muxProcessJSONFlag = false
	muxPanesJSONFlag = false
	muxInventoryJSONFlag, muxInventoryAgentsOnlyFlag = false, false
	muxInventoryLimitFlag = 500
	muxSessionsJSONFlag, muxSessionsAllFlag = false, false
	muxNewEphemeralFlag = false
	muxNewJSONFlag = false
	resetFlagChanged(muxSendCmd, "key", "answer", "force", "no-enter", "await", "timeout", "json")
	resetFlagChanged(muxAwaitCmd, "until", "file", "after-active", "timeout", "notify", "ready", "json")
	resetFlagChanged(muxCaptureCmd, "lines", "json", "raw", "classify")
	resetFlagChanged(muxKillCmd, "force", "json")
	resetFlagChanged(muxNewCmd, "ephemeral", "json")
	resetFlagChanged(muxProcessCmd, "json")
	resetFlagChanged(muxPanesCmd, "json")
	resetFlagChanged(muxInventoryCmd, "json", "agents-only", "limit")
	resetFlagChanged(muxSessionsCmd, "json", "all")
	// The parent's persistent -L is shared by every mux invocation, so an
	// explicit `-L x` from one test would otherwise leak into the next.
	if f := muxCmd.PersistentFlags().Lookup("server"); f != nil {
		_ = f.Value.Set(f.DefValue)
		f.Changed = false
	}
	muxServerFlag = ""
	if f := rootCmd.PersistentFlags().Lookup("quiet"); f != nil {
		_ = rootCmd.PersistentFlags().Set("quiet", "false")
		f.Changed = false
	}
	quiet = false
}

// resetFlagChanged restores each named flag on cmd to its default VALUE and
// clears Changed. Slice flags (StringArray, e.g. --key) go through
// pflag.SliceValue.Replace — a plain Set(DefValue) would append the literal
// "[]" string instead of emptying the slice.
func resetFlagChanged(cmd *cobra.Command, names ...string) {
	for _, name := range names {
		f := cmd.Flags().Lookup(name)
		if f == nil {
			continue
		}
		if sv, ok := f.Value.(interface{ Replace([]string) error }); ok {
			_ = sv.Replace(nil)
		} else {
			_ = f.Value.Set(f.DefValue)
		}
		f.Changed = false
	}
}

// runMuxCmd drives `rk mux <args...>` through the real cobra Execute() seam
// (the runPresentCmd pattern) so flag parsing, mutual exclusion, and exit
// classification run exactly as in production.
func runMuxCmd(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	resetRootFlagState(t)
	resetMuxFlags()
	t.Cleanup(resetMuxFlags)
	var stdout, stderr bytes.Buffer
	rootCmd.SetOut(&stdout)
	rootCmd.SetErr(&stderr)
	rootCmd.SetArgs(append([]string{"mux"}, args...))
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	err := rootCmd.Execute()
	return stdout.String(), stderr.String(), err
}

// TestMuxSendGateMatrix drives the full gate matrix (R4) through the real
// cobra path: unknown warns+sends, idle sends, waiting refuses without
// --answer, active refuses even with --answer. Refusals name the state and
// carry exit 1 with NO delivery.
func TestMuxSendGateMatrix(t *testing.T) {
	cases := []struct {
		name        string
		state       string
		args        []string
		wantDeliver bool
		wantErr     bool
		wantInErr   string
		wantWarn    bool
	}{
		{"unknown warns and sends", "", []string{"%5", "hi"}, true, false, "", true},
		{"idle sends", tmux.AgentStateIdle, []string{"%5", "hi"}, true, false, "", false},
		{"waiting refuses plain", tmux.AgentStateWaiting, []string{"%5", "hi"}, false, true, "waiting", false},
		{"waiting sends with --answer", tmux.AgentStateWaiting, []string{"%5", "hi", "--answer"}, true, false, "", false},
		{"active refuses plain", tmux.AgentStateActive, []string{"%5", "hi"}, false, true, "active", false},
		{"active refuses --answer", tmux.AgentStateActive, []string{"%5", "hi", "--answer"}, false, true, "active", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &muxFake{states: map[string]string{"%5": tc.state}}
			installMuxFakes(t, f)

			stdout, stderr, err := runMuxCmd(t, append([]string{"send"}, tc.args...)...)

			if tc.wantErr {
				if err == nil || exitCode(err) != 1 {
					t.Fatalf("err = %v, want exit-1 refusal", err)
				}
				if !strings.Contains(err.Error(), tc.wantInErr) {
					t.Errorf("refusal %q does not name state %q", err.Error(), tc.wantInErr)
				}
			} else if err != nil {
				t.Fatalf("err = %v, want success", err)
			}
			if got := len(f.engineCalls) > 0; got != tc.wantDeliver {
				t.Errorf("delivered = %v, want %v", got, tc.wantDeliver)
			}
			if tc.wantDeliver {
				if stdout != "delivered %5\n" {
					t.Errorf("stdout = %q, want the single report line", stdout)
				}
				call := f.engineCalls[0]
				if call.paneID != "%5" || call.text != "hi" || !call.submit || call.buffer != "rk-send-4242" {
					t.Errorf("engine call = %+v, want pane %%5 text hi submit buffer rk-send-4242", call)
				}
			} else if tc.wantErr && stdout != "" {
				t.Errorf("stdout = %q on a refusal, want empty", stdout)
			}
			if tc.wantWarn && !strings.Contains(stderr, "no readable agent state") {
				t.Errorf("stderr = %q, want the unknown-state warning", stderr)
			}
		})
	}
}

// TestMuxSendPayloadValidation: zero payloads and mixed kinds are usage errors
// (exit 2); the gate/delivery never runs (R3).
func TestMuxSendPayloadValidation(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)

	for _, args := range [][]string{
		{"send", "%5"},                                // no payload
		{"send", "%5", "hi", "--key", "Enter"},        // message + key
		{"send", "%5", "hi", "--answer", "--force"},   // mutually exclusive
		{"send", "%5", "   "},                         // whitespace-only message
		{"send", "%5", "hi", "--await", "--no-enter"}, // nothing submitted to wait on
		{"send", "%5", "hi", "--timeout", "-5"},       // negative timeout
		{"send", "%5", "hi", "--await=busy"},          // unknown state
	} {
		stdout, _, err := runMuxCmd(t, args...)
		if err == nil || exitCode(err) != exitUsage {
			t.Errorf("args %v: err = %v (exit %d), want usage exit 2", args, err, exitCode(err))
		}
		if stdout != "" {
			t.Errorf("args %v: stdout = %q, want empty on usage error", args, stdout)
		}
	}
	if len(f.engineCalls) != 0 || len(f.keysSent) != 0 {
		t.Errorf("delivery ran on usage errors: engine=%v keys=%v", f.engineCalls, f.keysSent)
	}
}

// TestMuxSendTargetGrammar: bare session:window names are rejected as usage
// errors naming the three accepted forms (R2); window forms resolve to the
// agent pane.
func TestMuxSendTargetGrammar(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)

	_, _, err := runMuxCmd(t, "send", "mysession:win", "hi")
	if err == nil || exitCode(err) != exitUsage {
		t.Fatalf("bare name: err = %v, want exit 2", err)
	}
	for _, want := range []string{"%N", "@N", "=session:window"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q missing accepted form %q", err.Error(), want)
		}
	}
	if len(f.engineCalls) != 0 {
		t.Error("delivery ran for a rejected target")
	}

	for _, target := range []string{"@3", "=work:editor"} {
		stdout, _, err := runMuxCmd(t, "send", target, "hi")
		if err != nil {
			t.Fatalf("target %s: err = %v", target, err)
		}
		call := f.engineCalls[len(f.engineCalls)-1]
		if call.paneID != "%7" {
			t.Errorf("target %s resolved to pane %q, want the agent pane %%7", target, call.paneID)
		}
		if stdout != "delivered %7\n" {
			t.Errorf("target %s: stdout = %q, want delivered %%7", target, stdout)
		}
	}
}

// TestMuxSendStdinPayload: `-` reads the message from stdin; multi-line text
// arrives as ONE sanitized payload (R3).
func TestMuxSendStdinPayload(t *testing.T) {
	f := &muxFake{stdin: "line one\r\nline two\x1b[201~ tail"}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "-")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if stdout != "delivered %5\n" {
		t.Errorf("stdout = %q", stdout)
	}
	want := "line one\nline two[201~ tail" // CRLF normalized, ESC stripped
	if got := f.engineCalls[0].text; got != want {
		t.Errorf("stdin payload = %q, want sanitized %q", got, want)
	}
}

// TestMuxSendNoEnter: --no-enter stages the text (submit=false reaches the
// engine) and reports `staged %N` (R5/R7).
func TestMuxSendNoEnter(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "hi", "--no-enter")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if stdout != "staged %5\n" {
		t.Errorf("stdout = %q, want staged report", stdout)
	}
	if f.engineCalls[0].submit {
		t.Error("submit=true reached the engine under --no-enter")
	}
}

// TestMuxSendProbeFailure: a probe failure sends no Enter, carries the
// staged-text message on stderr, and exits 1 (R5 — the 409's CLI analog).
func TestMuxSendProbeFailure(t *testing.T) {
	f := &muxFake{engineErr: inject.ProbeFailure{}}
	installMuxFakes(t, f)

	stdout, stderr, err := runMuxCmd(t, "send", "%5", "hi")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit 1", err)
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want no report on probe failure", stdout)
	}
	if !strings.Contains(stderr, "Enter withheld") || !strings.Contains(stderr, "before retrying") {
		t.Errorf("stderr = %q, want the staged-text warning", stderr)
	}
}

func TestMuxSendSubmitUnverifiedReportsAndSkipsAwait(t *testing.T) {
	f := &muxFake{engineErr: inject.SubmitUnverified{}}
	installMuxFakes(t, f)

	stdout, stderr, err := runMuxCmd(t, "send", "%5", "hi", "--await")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit 1", err)
	}
	if stdout != "unverified %5\n" {
		t.Fatalf("stdout = %q, want unverified report", stdout)
	}
	if !strings.Contains(stderr, "may or may not have been submitted") {
		t.Fatalf("stderr = %q, want the ambiguous-delivery guidance", stderr)
	}
	if len(f.awaitRuns) != 0 {
		t.Fatalf("await ran after an unverified submit: %v", f.awaitRuns)
	}
}

func TestMuxSendRetryStaysDelivered(t *testing.T) {
	t.Run("diagnostic", func(t *testing.T) {
		f := &muxFake{engineRecovered: true}
		installMuxFakes(t, f)

		stdout, stderr, err := runMuxCmd(t, "send", "%5", "hi")
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if stdout != "delivered %5\n" {
			t.Fatalf("stdout = %q, want delivered report", stdout)
		}
		if !strings.Contains(stderr, "delivery retried") {
			t.Fatalf("stderr = %q, want recovery diagnostic", stderr)
		}
	})

	t.Run("quiet", func(t *testing.T) {
		f := &muxFake{engineRecovered: true}
		installMuxFakes(t, f)

		stdout, stderr, err := runMuxCmd(t, "send", "%5", "hi", "--quiet")
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if stdout != "delivered %5\n" || stderr != "" {
			t.Fatalf("stdout = %q stderr = %q, want delivered with quiet chatter", stdout, stderr)
		}
	})
}

// TestMuxSendKeyArm: --key sends raw tmux key names post-gate — no paste, no
// probe, report `sent %N` (R5).
func TestMuxSendKeyArm(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "--key", "Enter", "--key", "C-c")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if stdout != "sent %5\n" {
		t.Errorf("stdout = %q, want sent report", stdout)
	}
	if len(f.keysSent) != 1 || strings.Join(f.keysSent[0], " ") != "%5 Enter C-c" {
		t.Errorf("keys = %v, want one send-keys of [Enter C-c] to %%5", f.keysSent)
	}
	if len(f.clearModeCalls) != 1 || f.clearModeCalls[0] != "%5" {
		t.Errorf("clear-mode calls = %v, want the pane-mode guard on %%5 before the keys", f.clearModeCalls)
	}
	if len(f.engineCalls) != 0 {
		t.Errorf("engine ran for a --key send: %v", f.engineCalls)
	}
}

// TestMuxSendKeyArmGuardFailure: a pane-mode guard failure aborts the key send
// before any send-keys — exit 1, no key delivered, no report (plain and
// --force alike: the guard is a delivery property, not a gate property).
func TestMuxSendKeyArmGuardFailure(t *testing.T) {
	for _, extra := range [][]string{nil, {"--force"}} {
		f := &muxFake{clearModeErr: errors.New("can't find pane")}
		installMuxFakes(t, f)

		args := append([]string{"send", "%5", "--key", "Enter"}, extra...)
		stdout, _, err := runMuxCmd(t, args...)
		if err == nil || exitCode(err) != 1 {
			t.Fatalf("args %v: err = %v, want exit 1", args, err)
		}
		if !strings.Contains(err.Error(), "clear pane mode") {
			t.Errorf("args %v: err = %v, want the wrapped guard error", args, err)
		}
		if len(f.keysSent) != 0 {
			t.Errorf("args %v: keys sent despite the guard failure: %v", args, f.keysSent)
		}
		if stdout != "" {
			t.Errorf("args %v: stdout = %q, want empty on a guard failure", args, stdout)
		}
	}
}

// TestMuxSendUnknownStateWarning: the unknown-state warning names a non-shell
// foreground command; a shell foreground (or an unreadable one) keeps the bare
// warning verbatim; an instrumented pane warns never. stderr-only — the stdout
// report contract is untouched.
func TestMuxSendUnknownStateWarning(t *testing.T) {
	cases := []struct {
		name     string
		facts    tmux.PaneFacts
		wantWarn string
	}{
		{"non-shell foreground named", tmux.PaneFacts{Command: "htop"},
			"warning: pane %5 has no readable agent state — foreground process `htop` running; sending ungated\n"},
		{"shell foreground keeps the bare warning", tmux.PaneFacts{Command: "zsh"},
			"warning: pane %5 has no readable agent state — sending ungated\n"},
		{"empty command keeps the bare warning", tmux.PaneFacts{},
			"warning: pane %5 has no readable agent state — sending ungated\n"},
		{"instrumented pane never warns", tmux.PaneFacts{Command: "htop", AgentState: tmux.AgentStateIdle, AgentStateEpoch: 1_800_000_000}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &muxFake{facts: map[string]tmux.PaneFacts{"%5": tc.facts}}
			installMuxFakes(t, f)

			stdout, stderr, err := runMuxCmd(t, "send", "%5", "hi")
			if err != nil {
				t.Fatalf("err = %v, want warn-and-send", err)
			}
			if stdout != "delivered %5\n" {
				t.Errorf("stdout = %q, want the single report line", stdout)
			}
			if stderr != tc.wantWarn {
				t.Errorf("stderr = %q, want %q", stderr, tc.wantWarn)
			}
		})
	}
}

// TestMuxSendForceSkipsGate: --force skips the gate (no state read) but still
// validates target existence (R4).
func TestMuxSendForceSkipsGate(t *testing.T) {
	f := &muxFake{
		states:     map[string]string{"%5": tmux.AgentStateActive}, // would refuse unforced
		paneExists: map[string]bool{"%5": true},
	}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "hi", "--force")
	if err != nil {
		t.Fatalf("err = %v (active state must be skipped under --force)", err)
	}
	if stdout != "delivered %5\n" {
		t.Errorf("stdout = %q", stdout)
	}

	// A missing pane under --force is an operational failure.
	f.paneExists["%5"] = false
	_, _, err = runMuxCmd(t, "send", "%5", "hi", "--force")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("missing pane under --force: err = %v, want exit 1", err)
	}
}

// TestMuxSendAwaitComposition: --await first watches the active flip under the
// grace, then awaits the requested state set; the await report word is stdout's
// single line (R6/R7).
func TestMuxSendAwaitComposition(t *testing.T) {
	f := &muxFake{awaitReports: []string{"active", "waiting"}}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "question", "--await")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if stdout != "waiting %5\n" {
		t.Errorf("stdout = %q, want the await report word", stdout)
	}
	if len(f.awaitRuns) != 2 {
		t.Fatalf("await runs = %d, want 2 (grace flip-watch + await)", len(f.awaitRuns))
	}
	grace, main := f.awaitRuns[0], f.awaitRuns[1]
	if len(grace.until) != 1 || grace.until[0] != tmux.AgentStateActive {
		t.Errorf("grace until = %v, want [active]", grace.until)
	}
	if grace.timeout != sendAwaitActiveGrace {
		t.Errorf("grace timeout = %v, want %v", grace.timeout, sendAwaitActiveGrace)
	}
	if strings.Join(main.until, ",") != "idle,waiting" {
		t.Errorf("await until = %v, want the default idle,waiting", main.until)
	}
	if main.timeout != awaitDefaultTimeoutSec*1e9 {
		t.Errorf("await timeout = %v, want the default 300s", main.timeout)
	}
}

// TestMuxSendAwaitGraceFallsThrough: a grace expiry (`running` from the
// flip-watch) still runs the await (hooks may lag), and its report is the
// final word (R6, plan decision).
func TestMuxSendAwaitGraceFallsThrough(t *testing.T) {
	f := &muxFake{awaitReports: []string{"running", "idle"}}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "q", "--await=idle", "--timeout", "120")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if stdout != "idle %5\n" {
		t.Errorf("stdout = %q", stdout)
	}
	if len(f.awaitRuns) != 2 {
		t.Fatalf("await runs = %d, want the await to follow the expired grace", len(f.awaitRuns))
	}
	if got := f.awaitRuns[1].until; len(got) != 1 || got[0] != "idle" {
		t.Errorf("await until = %v, want [idle] from --await=idle", got)
	}
	if f.awaitRuns[1].timeout != 120*1e9 {
		t.Errorf("await timeout = %v, want 120s", f.awaitRuns[1].timeout)
	}
}

// TestMuxSendAwaitPeerGone: the peer dying during the composition reports
// `gone` and exits 1 (the await contract's operational failure).
func TestMuxSendAwaitPeerGone(t *testing.T) {
	f := &muxFake{
		awaitReports: []string{"active", "gone"},
		awaitErr:     errors.New("pane %5 is gone"),
	}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "q", "--await")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit 1", err)
	}
	if stdout != "gone %5\n" {
		t.Errorf("stdout = %q, want the gone report", stdout)
	}
}

// TestMuxSendQuietKeepsReport: --quiet drops the unknown-state warning (chatter)
// but never the stdout report line (Toolkit Principle 9, R11).
func TestMuxSendQuietKeepsReport(t *testing.T) {
	f := &muxFake{states: map[string]string{"%5": ""}}
	installMuxFakes(t, f)

	stdout, stderr, err := runMuxCmd(t, "send", "%5", "hi", "--quiet")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if stdout != "delivered %5\n" {
		t.Errorf("stdout = %q, want the report even under --quiet", stdout)
	}
	if strings.Contains(stderr, "no readable agent state") {
		t.Errorf("stderr = %q, want the warning suppressed under --quiet", stderr)
	}
}

// TestMuxSendAwaitUninstrumentedFallsThrough: on an UNINSTRUMENTED pane the
// grace watch's nothing-observable verdict is a fall-through, not the end of
// the composition — the delivery stands, and the main await applies its own
// uninstrumented rule (here the pane gained state in the meantime, so the wait
// completes normally).
func TestMuxSendAwaitUninstrumentedFallsThrough(t *testing.T) {
	f := &muxFake{
		states:       map[string]string{"%5": ""}, // gate: unknown → warn + send
		awaitReports: []string{"", "idle"},
		awaitErrs:    []error{errUnobservable, nil},
	}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "q", "--await")
	if err != nil {
		t.Fatalf("err = %v, want the await to proceed past the grace verdict", err)
	}
	if stdout != "idle %5\n" {
		t.Errorf("stdout = %q, want the await report word", stdout)
	}
	if len(f.awaitRuns) != 2 {
		t.Fatalf("await runs = %d, want grace + main await", len(f.awaitRuns))
	}
}

// TestMuxSendAwaitUninstrumentedStillErrors: when the pane is STILL
// uninstrumented at the main await, the delivery report prints (the send
// succeeded) and the nothing-observable error exits 1.
func TestMuxSendAwaitUninstrumentedStillErrors(t *testing.T) {
	f := &muxFake{
		states:       map[string]string{"%5": ""},
		awaitReports: []string{"", ""},
		awaitErrs:    []error{errUnobservable, errUnobservable},
	}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "q", "--await")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit 1", err)
	}
	if !errors.Is(err, errUnobservable) {
		t.Errorf("err = %v, want the nothing-observable verdict", err)
	}
	if stdout != "delivered %5\n" {
		t.Errorf("stdout = %q, want the delivery report (the send succeeded)", stdout)
	}
}

// --- --json envelope (R1/R2/R3) ---------------------------------------------

// TestMuxSendJSONSuccessReceipts: the success receipt carries the frozen
// report word, the resolved pane, the resolved server, and enter per the
// delivery path — and the human report line never prints under --json.
func TestMuxSendJSONSuccessReceipts(t *testing.T) {
	for _, tc := range []struct {
		name       string
		args       []string
		wantReport string
		wantEnter  bool
	}{
		{"delivered", []string{"send", "%5", "hi", "--json"}, "delivered", true},
		{"staged", []string{"send", "%5", "hi", "--no-enter", "--json"}, "staged", false},
		{"sent (key)", []string{"send", "%5", "--key", "Enter", "--json"}, "sent", false},
		{"answer message", []string{"send", "%5", "yes", "--answer", "--json"}, "delivered", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &muxFake{}
			if tc.name == "answer message" {
				f.states = map[string]string{"%5": tmux.AgentStateWaiting}
			}
			installMuxFakes(t, f)

			stdout, _, err := runMuxCmd(t, tc.args...)
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			result := envelopeResult(t, stdout)
			if result["report"] != tc.wantReport || result["target"] != "%5" || result["server"] != "default" {
				t.Errorf("result = %v, want %s on %%5 @ default", result, tc.wantReport)
			}
			if result["enter"] != tc.wantEnter {
				t.Errorf("enter = %v, want %v", result["enter"], tc.wantEnter)
			}
			if _, ok := result["await"]; ok {
				t.Errorf("await must be absent without --await: %v", result)
			}
		})
	}
}

// TestMuxSendJSONTargetAndServerResolution: a window target resolves to its
// agent pane before the receipt, and -L is the receipt's server.
func TestMuxSendJSONTargetAndServerResolution(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "@3", "hi", "-L", "work", "--json")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	result := envelopeResult(t, stdout)
	if result["target"] != "%7" || result["server"] != "work" {
		t.Errorf("result = %v, want the resolved pane %%7 on server work", result)
	}
}

// TestMuxSendJSONFailureReasons: the three engine sentinels map to the /send
// route's 409 codes with their hints; the unverified line is suppressed; the
// error still returns (exit 1, stderr unchanged).
func TestMuxSendJSONFailureReasons(t *testing.T) {
	for _, tc := range []struct {
		name       string
		engineErr  error
		wantReason string
		wantHint   string
	}{
		{"probe failure", inject.ProbeFailure{}, "probe_failure", "check the pane before resending"},
		{"staged send failure", inject.StagedSendFailure{}, "staged_send_failure", "press Enter in the pane"},
		{"submit unverified", inject.SubmitUnverified{}, "submit_unverified", "capture the pane before resending"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &muxFake{engineErr: tc.engineErr}
			installMuxFakes(t, f)

			stdout, stderr, err := runMuxCmd(t, "send", "%5", "hi", "--json")
			if err == nil || exitCode(err) != 1 {
				t.Fatalf("err = %v, want exit 1", err)
			}
			errObj := envelopeErrorDoc(t, stdout)
			if errObj["code"] != "operational" || errObj["reason"] != tc.wantReason {
				t.Errorf("error = %v, want operational + reason %s", errObj, tc.wantReason)
			}
			if hint, _ := errObj["hint"].(string); !strings.Contains(hint, tc.wantHint) {
				t.Errorf("hint = %v, want it to contain %q", errObj["hint"], tc.wantHint)
			}
			if errObj["message"] != tc.engineErr.Error() {
				t.Errorf("message = %v, want the error text %q", errObj["message"], tc.engineErr.Error())
			}
			if !strings.Contains(stderr, strings.Split(tc.engineErr.Error(), ".")[0]) {
				t.Errorf("stderr = %q, want the diagnostic unchanged", stderr)
			}
			if strings.Contains(stdout, "unverified") && tc.wantReason != "submit_unverified" {
				t.Errorf("stdout = %q unexpectedly carries the unverified line", stdout)
			}
		})
	}
}

// TestMuxSendJSONSubmitUnverifiedSuppressesLine: under --json the
// `unverified %N` stdout line is NOT printed — the fact travels as the reason.
func TestMuxSendJSONSubmitUnverifiedSuppressesLine(t *testing.T) {
	f := &muxFake{engineErr: inject.SubmitUnverified{}}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "hi", "--json")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit 1", err)
	}
	if strings.Contains(stdout, "unverified %5") {
		t.Errorf("stdout = %q, want no unverified line under --json", stdout)
	}
	if got := envelopeErrorDoc(t, stdout)["reason"]; got != "submit_unverified" {
		t.Errorf("reason = %v, want submit_unverified", got)
	}
}

// TestMuxSendJSONGateRefusals: a waiting refusal names --answer in the hint;
// an active refusal carries no hint; both are operational, exit 1.
func TestMuxSendJSONGateRefusals(t *testing.T) {
	t.Run("waiting refusal hints --answer", func(t *testing.T) {
		f := &muxFake{states: map[string]string{"%5": tmux.AgentStateWaiting}}
		installMuxFakes(t, f)

		stdout, _, err := runMuxCmd(t, "send", "%5", "hi", "--json")
		if err == nil || exitCode(err) != 1 {
			t.Fatalf("err = %v, want exit 1", err)
		}
		errObj := envelopeErrorDoc(t, stdout)
		if errObj["code"] != "operational" {
			t.Errorf("error = %v, want operational", errObj)
		}
		if hint, _ := errObj["hint"].(string); !strings.Contains(hint, "--answer") {
			t.Errorf("hint = %v, want it to name --answer", errObj["hint"])
		}
		if !strings.Contains(errObj["message"].(string), "waiting") {
			t.Errorf("message = %v, want the refusal naming the state", errObj["message"])
		}
	})

	t.Run("active refusal has no hint", func(t *testing.T) {
		f := &muxFake{states: map[string]string{"%5": tmux.AgentStateActive}}
		installMuxFakes(t, f)

		stdout, _, err := runMuxCmd(t, "send", "%5", "hi", "--json")
		if err == nil || exitCode(err) != 1 {
			t.Fatalf("err = %v, want exit 1", err)
		}
		errObj := envelopeErrorDoc(t, stdout)
		if errObj["code"] != "operational" {
			t.Errorf("error = %v, want operational", errObj)
		}
		if _, ok := errObj["hint"]; ok {
			t.Errorf("hint must be absent for an active refusal: %v", errObj)
		}
	})
}

// TestMuxSendJSONMissingPane: a resolution/existence failure is operational
// with no reason or hint.
func TestMuxSendJSONMissingPane(t *testing.T) {
	f := &muxFake{paneExists: map[string]bool{"%5": false}}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "hi", "--force", "--json")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit 1", err)
	}
	errObj := envelopeErrorDoc(t, stdout)
	if errObj["code"] != "operational" {
		t.Errorf("error = %v, want operational", errObj)
	}
	if _, ok := errObj["reason"]; ok {
		t.Errorf("reason must be absent: %v", errObj)
	}
	if !strings.Contains(errObj["message"].(string), "%5") {
		t.Errorf("message = %v, want it to name the pane", errObj["message"])
	}
}

// TestMuxSendJSONUsageErrors: in-RunE usage errors are code "usage", exit 2,
// and stderr still carries the message.
func TestMuxSendJSONUsageErrors(t *testing.T) {
	f := &muxFake{}
	installMuxFakes(t, f)
	for _, args := range [][]string{
		{"send", "%5", "--json"},                                // no payload
		{"send", "%5", "hi", "--key", "Enter", "--json"},        // mixed payloads
		{"send", "%5", "hi", "--await", "--no-enter", "--json"}, // nothing to wait on
		{"send", "%5", "hi", "--timeout", "-5", "--json"},       // negative timeout
		{"send", "%5", "hi", "--await=busy", "--json"},          // unknown state
	} {
		stdout, stderr, err := runMuxCmd(t, args...)
		if err == nil || exitCode(err) != exitUsage {
			t.Errorf("args %v: err = %v (exit %d), want usage exit 2", args, err, exitCode(err))
			continue
		}
		errObj := envelopeErrorDoc(t, stdout)
		if errObj["code"] != "usage" {
			t.Errorf("args %v: error = %v, want code usage", args, errObj)
		}
		if stderr == "" {
			t.Errorf("args %v: stderr empty, want the message unchanged", args)
		}
	}
}

// TestMuxSendJSONAwaitNesting: --json --await keeps the delivery receipt and
// nests the await phase's receipt (elapsed covers the grace watch + observer).
func TestMuxSendJSONAwaitNesting(t *testing.T) {
	f := &muxFake{awaitReports: []string{"active", "idle"}}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "q", "--await", "--json")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	result := envelopeResult(t, stdout)
	if result["report"] != "delivered" || result["enter"] != true {
		t.Errorf("delivery = %v, want delivered with enter true", result)
	}
	nested, ok := result["await"].(map[string]any)
	if !ok {
		t.Fatalf("await receipt missing: %v", result)
	}
	if nested["report"] != "idle" || nested["target"] != "%5" {
		t.Errorf("await = %v, want idle on %%5", nested)
	}
	if ms, ok := nested["elapsed_ms"].(float64); !ok || ms < 0 {
		t.Errorf("elapsed_ms = %v, want a non-negative number", nested["elapsed_ms"])
	}
	if strings.Contains(stdout, "delivered %5") || strings.Contains(stdout, "idle %5") {
		t.Errorf("stdout = %q, want no human report lines under --json", stdout)
	}
}

// TestMuxSendJSONAwaitGone: the peer dying after delivery is ok:false with
// reason "gone" and the delivered fact in the hint, exit 1.
func TestMuxSendJSONAwaitGone(t *testing.T) {
	f := &muxFake{
		awaitReports: []string{"active", "gone"},
		awaitErr:     errors.New("pane %5 is gone"),
	}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "q", "--await", "--json")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit 1", err)
	}
	errObj := envelopeErrorDoc(t, stdout)
	if errObj["code"] != "operational" || errObj["reason"] != "gone" {
		t.Errorf("error = %v, want operational + reason gone", errObj)
	}
	if errObj["hint"] != "the message was delivered before the pane died" {
		t.Errorf("hint = %v, want the delivered fact", errObj["hint"])
	}
	if !strings.Contains(errObj["message"].(string), "%5") {
		t.Errorf("message = %v, want the gone diagnostic", errObj["message"])
	}
}

// TestMuxSendJSONAwaitCannotStart: the await failing without a report (a still
// uninstrumented pane) is ok:false, message the await error, the delivered
// fact in the hint, exit 1.
func TestMuxSendJSONAwaitCannotStart(t *testing.T) {
	f := &muxFake{
		states:       map[string]string{"%5": ""},
		awaitReports: []string{"", ""},
		awaitErrs:    []error{errUnobservable, errUnobservable},
	}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "q", "--await", "--json")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit 1", err)
	}
	errObj := envelopeErrorDoc(t, stdout)
	if errObj["code"] != "operational" {
		t.Errorf("error = %v, want operational", errObj)
	}
	if !strings.Contains(errObj["message"].(string), "nothing observable") {
		t.Errorf("message = %v, want the await error", errObj["message"])
	}
	if errObj["hint"] != "delivered; the wait could not start" {
		t.Errorf("hint = %v, want the delivered fact", errObj["hint"])
	}
	if strings.Contains(stdout, "delivered %5") {
		t.Errorf("stdout = %q, want no delivery report line under --json", stdout)
	}
}

// TestMuxSendJSONAwaitRunningNestsCallAgain: a timeout in the await phase is
// still a success — the nested receipt reports running with the call-again
// hint and no target.
func TestMuxSendJSONAwaitRunningNestsCallAgain(t *testing.T) {
	f := &muxFake{awaitReports: []string{"active", "running"}}
	installMuxFakes(t, f)

	stdout, _, err := runMuxCmd(t, "send", "%5", "q", "--await", "--json")
	if err != nil {
		t.Fatalf("err = %v, want exit 0 (running is a report)", err)
	}
	nested, ok := envelopeResult(t, stdout)["await"].(map[string]any)
	if !ok {
		t.Fatalf("await receipt missing: %q", stdout)
	}
	if nested["report"] != "running" || nested["hint"] != "call again" {
		t.Errorf("await = %v, want running + call again", nested)
	}
	if _, ok := nested["target"]; ok {
		t.Errorf("target must be omitted for running: %v", nested)
	}
}
