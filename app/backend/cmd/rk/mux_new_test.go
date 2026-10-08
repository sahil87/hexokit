package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// muxNewFake holds the installed new-verb seams and their call recordings.
// aliveErr nil = a live server answers on the socket (collision); non-nil =
// dead/stale socket, creation proceeds (tmux's real probe errors).
type muxNewFake struct {
	aliveErr    error
	createErr   error
	markErr     error
	killErr     error
	createCalls []string // server names passed to CreateSession
	markCalls   []string
	killCalls   []string
}

// installMuxNewFakes wires the mux-new seams to the fake and restores the
// production defaults on cleanup (the installMuxFakes pattern).
func installMuxNewFakes(t *testing.T, f *muxNewFake) {
	t.Helper()
	origAlive, origCreate := muxNewServerAliveFn, muxNewCreateSessionFn
	origMark, origKill := muxNewMarkEphemeralFn, muxNewKillServerFn
	t.Cleanup(func() {
		muxNewServerAliveFn, muxNewCreateSessionFn = origAlive, origCreate
		muxNewMarkEphemeralFn, muxNewKillServerFn = origMark, origKill
	})

	muxNewServerAliveFn = func(_ context.Context, _ string) error { return f.aliveErr }
	muxNewCreateSessionFn = func(_, _, server string) error {
		f.createCalls = append(f.createCalls, server)
		return f.createErr
	}
	muxNewMarkEphemeralFn = func(_ context.Context, server string) error {
		f.markCalls = append(f.markCalls, server)
		return f.markErr
	}
	muxNewKillServerFn = func(server string) error {
		f.killCalls = append(f.killCalls, server)
		return f.killErr
	}
}

// deadSocket is the fake's probe-failure value: no live server on the socket,
// so creation proceeds.
var deadSocket = errors.New("no server running on /tmp/tmux-1000/scratch1")

// TestMuxNewCreate: probe → create → report; stdout carries exactly the one
// report line and --ephemeral stays untouched.
func TestMuxNewCreate(t *testing.T) {
	f := &muxNewFake{aliveErr: deadSocket}
	installMuxNewFakes(t, f)

	stdout, _, err := runMuxCmd(t, "new", "scratch1")
	if err != nil {
		t.Fatalf("err = %v, want success", err)
	}
	if stdout != "created scratch1\n" {
		t.Errorf("stdout = %q, want the single report line", stdout)
	}
	if len(f.createCalls) != 1 || f.createCalls[0] != "scratch1" {
		t.Errorf("create calls = %v, want one create of scratch1", f.createCalls)
	}
	if len(f.markCalls) != 0 || len(f.killCalls) != 0 {
		t.Errorf("mark/kill ran without --ephemeral: marks=%v kills=%v", f.markCalls, f.killCalls)
	}
}

// TestMuxNewEphemeral: probe → create → mark → report; the mark lands before
// the report, and the option write targets the just-created server.
func TestMuxNewEphemeral(t *testing.T) {
	f := &muxNewFake{aliveErr: deadSocket}
	installMuxNewFakes(t, f)

	stdout, _, err := runMuxCmd(t, "new", "scratch2", "--ephemeral")
	if err != nil {
		t.Fatalf("err = %v, want success", err)
	}
	if stdout != "created scratch2\n" {
		t.Errorf("stdout = %q, want the single report line", stdout)
	}
	if len(f.createCalls) != 1 || len(f.markCalls) != 1 || f.markCalls[0] != "scratch2" {
		t.Errorf("calls: creates=%v marks=%v, want create+mark of scratch2", f.createCalls, f.markCalls)
	}
	if len(f.killCalls) != 0 {
		t.Errorf("kill ran on a successful mark: %v", f.killCalls)
	}
}

// TestMuxNewMarkFailureKills: a failed --ephemeral mark best-effort kills the
// just-created server and exits 1 — no unmarked survivor, no report line.
func TestMuxNewMarkFailureKills(t *testing.T) {
	f := &muxNewFake{aliveErr: deadSocket, markErr: errors.New("set-option: boom")}
	installMuxNewFakes(t, f)

	stdout, _, err := runMuxCmd(t, "new", "scratch2", "--ephemeral")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit-1 mark failure", err)
	}
	if !strings.Contains(err.Error(), "ephemeral") {
		t.Errorf("err = %v, want the mark failure named", err)
	}
	if len(f.killCalls) != 1 || f.killCalls[0] != "scratch2" {
		t.Errorf("kill calls = %v, want one best-effort kill of scratch2", f.killCalls)
	}
	if stdout != "" {
		t.Errorf("stdout = %q on mark failure, want empty", stdout)
	}
}

// TestMuxNewCollision: a live server answering on the socket refuses exit 1,
// naming the server as already running, and performs no tmux mutation.
func TestMuxNewCollision(t *testing.T) {
	f := &muxNewFake{} // aliveErr nil: a live server answers
	installMuxNewFakes(t, f)

	stdout, _, err := runMuxCmd(t, "new", "busy")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit-1 collision refusal", err)
	}
	if !strings.Contains(err.Error(), "busy") || !strings.Contains(err.Error(), "already running") {
		t.Errorf("err = %v, want it naming busy as already running", err)
	}
	if len(f.createCalls) != 0 || len(f.markCalls) != 0 || len(f.killCalls) != 0 {
		t.Errorf("mutation ran on a collision: creates=%v marks=%v kills=%v",
			f.createCalls, f.markCalls, f.killCalls)
	}
	if stdout != "" {
		t.Errorf("stdout = %q on a collision, want empty", stdout)
	}
}

// TestMuxNewProbeErrorRefuses: a probe failure that is NOT the dead-socket
// sentinel (timeout, tmux error) refuses exit 1 without mutating — an
// unclassifiable socket is never created over on a guess.
func TestMuxNewProbeErrorRefuses(t *testing.T) {
	f := &muxNewFake{aliveErr: errors.New("context deadline exceeded")}
	installMuxNewFakes(t, f)

	stdout, _, err := runMuxCmd(t, "new", "murky")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit-1 probe failure", err)
	}
	if !strings.Contains(err.Error(), "probe server murky") {
		t.Errorf("err = %v, want the probe failure named", err)
	}
	if len(f.createCalls) != 0 || len(f.markCalls) != 0 || len(f.killCalls) != 0 {
		t.Errorf("mutation ran on a probe failure: creates=%v marks=%v kills=%v",
			f.createCalls, f.markCalls, f.killCalls)
	}
	if stdout != "" {
		t.Errorf("stdout = %q on a probe failure, want empty", stdout)
	}
}

// TestMuxNewMarkGetsFreshDeadline: the --ephemeral mark runs under its own
// bound derived from the parent, not the probe-consumed command context — a
// slow probe must not hand the mark an exhausted deadline.
func TestMuxNewMarkGetsFreshDeadline(t *testing.T) {
	f := &muxNewFake{aliveErr: deadSocket}
	installMuxNewFakes(t, f)

	var probeDeadline, markDeadline time.Time
	orig := muxNewServerAliveFn
	muxNewServerAliveFn = func(ctx context.Context, _ string) error {
		probeDeadline, _ = ctx.Deadline()
		time.Sleep(15 * time.Millisecond)
		return f.aliveErr
	}
	t.Cleanup(func() { muxNewServerAliveFn = orig })
	muxNewMarkEphemeralFn = func(ctx context.Context, server string) error {
		markDeadline, _ = ctx.Deadline()
		f.markCalls = append(f.markCalls, server)
		return nil
	}

	if _, _, err := runMuxCmd(t, "new", "scratch3", "--ephemeral"); err != nil {
		t.Fatalf("err = %v, want success", err)
	}
	if probeDeadline.IsZero() || markDeadline.IsZero() {
		t.Fatal("expected both seams to observe a context deadline")
	}
	if !markDeadline.After(probeDeadline) {
		t.Errorf("mark deadline %v not after probe deadline %v — mark reused the probe-consumed context",
			markDeadline, probeDeadline)
	}
}

// TestMuxNewUsage: name validation, stray/missing args, and the inherited -L
// rejection are usage errors (exit 2); nothing reaches the seams.
func TestMuxNewUsage(t *testing.T) {
	f := &muxNewFake{aliveErr: deadSocket}
	installMuxNewFakes(t, f)

	_, _, err := runMuxCmd(t, "new", "bad name!")
	if err == nil || exitCode(err) != exitUsage {
		t.Fatalf("invalid name: err = %v, want exit 2", err)
	}
	if !strings.Contains(err.Error(), "alphanumeric") {
		t.Errorf("err = %v, want the allowed character set named", err)
	}

	_, _, err = runMuxCmd(t, "new")
	if err == nil || exitCode(err) != exitUsage {
		t.Fatalf("missing arg: err = %v, want exit 2", err)
	}

	_, _, err = runMuxCmd(t, "new", "one", "two")
	if err == nil || exitCode(err) != exitUsage {
		t.Fatalf("stray arg: err = %v, want exit 2", err)
	}

	// The operator-tier member rejects an explicitly-set inherited -L.
	_, _, err = runMuxCmd(t, "-L", "foo", "new", "bar")
	if err == nil || exitCode(err) != exitUsage {
		t.Fatalf("inherited -L: err = %v, want exit 2", err)
	}
	if !strings.Contains(err.Error(), "--server") {
		t.Errorf("err = %v, want the rejection naming --server", err)
	}

	if len(f.createCalls) != 0 || len(f.markCalls) != 0 || len(f.killCalls) != 0 {
		t.Errorf("mutation ran on usage errors: creates=%v marks=%v kills=%v",
			f.createCalls, f.markCalls, f.killCalls)
	}
}

// TestMuxNewJSONReceipt: --json prints exactly one envelope document with the
// report word, the server name, and the --ephemeral echo; the human line is
// unchanged without the flag (pinned by TestMuxNewCreate).
func TestMuxNewJSONReceipt(t *testing.T) {
	f := &muxNewFake{aliveErr: deadSocket}
	installMuxNewFakes(t, f)

	stdout, _, err := runMuxCmd(t, "new", "scratch1", "--ephemeral", "--json")
	if err != nil {
		t.Fatalf("err = %v, want success", err)
	}
	assertEnvelopeResult(t, stdout, map[string]any{"report": "created", "server": "scratch1", "ephemeral": true})

	f2 := &muxNewFake{aliveErr: deadSocket}
	installMuxNewFakes(t, f2)
	stdout, _, err = runMuxCmd(t, "new", "scratch1", "--json")
	if err != nil {
		t.Fatalf("err = %v, want success", err)
	}
	assertEnvelopeResult(t, stdout, map[string]any{"report": "created", "server": "scratch1", "ephemeral": false})
}

// Dash-prefixed labels remain positional after the MCP end-of-flags separator.
func TestMuxNewDashPrefixedLabel(t *testing.T) {
	f := &muxNewFake{aliveErr: deadSocket}
	installMuxNewFakes(t, f)
	// The MCP row emits this exact end-of-flags form. Exercise Cobra too:
	// the label must not select the json flag or become a missing argument.
	stdout, _, err := runMuxCmd(t, "new", "--json", "--", "--json")
	if err != nil {
		t.Fatal(err)
	}
	assertEnvelopeResult(t, stdout, map[string]any{"report": "created", "server": "--json", "ephemeral": false})
	if len(f.createCalls) != 1 || f.createCalls[0] != "--json" {
		t.Fatalf("create calls = %v, want literal label --json", f.createCalls)
	}
}

// TestMuxNewJSONCollision: a live-server refusal under --json emits the
// operational error envelope on stdout with exit 1.
func TestMuxNewJSONCollision(t *testing.T) {
	f := &muxNewFake{aliveErr: nil} // a live server answers
	installMuxNewFakes(t, f)

	stdout, _, err := runMuxCmd(t, "new", "scratch1", "--json")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v, want exit-1 refusal", err)
	}
	if doc := parseFailureEnvelope(t, centralFailureEnvelope(t, stdout, err)); doc.Code != "operational" || doc.Message != "server scratch1 is already running" {
		t.Errorf("failure envelope = %+v, want %s: %s", doc, "operational", "server scratch1 is already running")
	}
	if len(f.createCalls) != 0 {
		t.Errorf("create ran on a collision: %v", f.createCalls)
	}
}
