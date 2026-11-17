package cron

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

// TestRespawnArgv: {server} substitutes in EVERY element, the result is a
// fresh slice (the entry is never mutated), and elements without the
// placeholder pass through untouched.
func TestRespawnArgv(t *testing.T) {
	e := Entry{Respawn: []string{"rk", "operator", "-L", "{server}", "log-{server}.txt", "plain"}}

	argv := RespawnArgv(e, "runKit")
	want := []string{"rk", "operator", "-L", "runKit", "log-runKit.txt", "plain"}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %v, want %v", argv, want)
	}
	if !reflect.DeepEqual(e.Respawn, []string{"rk", "operator", "-L", "{server}", "log-{server}.txt", "plain"}) {
		t.Errorf("entry mutated: %v", e.Respawn)
	}
	// Mutating the result must not reach back into the entry.
	argv[0] = "clobbered"
	if e.Respawn[0] != "rk" {
		t.Errorf("entry aliased the returned slice: %v", e.Respawn)
	}
}

// TestRespawnDetail: the detail carries the error plus a bounded output tail —
// empty output leaves the bare error, long output is cut to its last 200 bytes.
func TestRespawnDetail(t *testing.T) {
	err := errors.New("exit status 1")

	if got := respawnDetail(err, nil); got != "exit status 1" {
		t.Errorf("no output: %q", got)
	}
	if got := respawnDetail(err, []byte("boom\n")); got != "exit status 1: boom" {
		t.Errorf("short output: %q", got)
	}

	long := strings.Repeat("x", respawnOutputTailBytes+50)
	got := respawnDetail(err, []byte(long))
	if !strings.HasPrefix(got, "exit status 1: …") {
		t.Errorf("truncated detail missing the ellipsis prefix: %.40q…", got)
	}
	if tail := got[len("exit status 1: …"):]; len(tail) != respawnOutputTailBytes {
		t.Errorf("tail = %d bytes, want %d", len(tail), respawnOutputTailBytes)
	}

	// A 2-byte rune straddling the cut: the truncation must not split it.
	split := "é" + strings.Repeat("x", respawnOutputTailBytes-1)
	got = respawnDetail(err, []byte(split))
	if !utf8.ValidString(got) {
		t.Errorf("truncated detail is not valid UTF-8: %q", got)
	}
}

// TestRespawnSuccessOutcome: an exit-0 respawn whose output carries a
// kickoff: undelivered line yields a reason-carrying outcome; anything else
// yields the bare "respawned". The outcome keeps the "respawned" prefix that
// resolvedOutcome (orphan GC) and countsTowardRate classify respawns on.
func TestRespawnSuccessOutcome(t *testing.T) {
	withKickoff := []byte("spawning agent\nkickoff: undelivered reason=parked prompt=\"/operator\" dir=\"/home/u\"\ndone\n")
	got := respawnSuccessOutcome(withKickoff)
	if want := "respawned (kickoff undelivered: parked)"; got != want {
		t.Errorf("kickoff line: got %q, want %q", got, want)
	}
	if !resolvedOutcome(got) {
		t.Errorf("resolvedOutcome(%q) = false, want true (orphan GC resolved-class)", got)
	}
	if !countsTowardRate(got) {
		t.Errorf("countsTowardRate(%q) = false, want true (respawn-class rate counting)", got)
	}

	if got := respawnSuccessOutcome([]byte("agent up, kickoff delivered\n")); got != "respawned" {
		t.Errorf("no kickoff line: got %q, want %q", got, "respawned")
	}
	if got := respawnSuccessOutcome(nil); got != "respawned" {
		t.Errorf("empty output: got %q, want %q", got, "respawned")
	}

	// reason= as the last token: the cut on the next space must not need one.
	if got := respawnSuccessOutcome([]byte("kickoff: undelivered reason=timeout")); got != "respawned (kickoff undelivered: timeout)" {
		t.Errorf("trailing reason: got %q, want %q", got, "respawned (kickoff undelivered: timeout)")
	}
}

// TestTickRespawnKickoffUndelivered: an exit-0 respawn whose output carries
// the kickoff: undelivered line logs the reason-carrying outcome, still
// respawn-classified (respawned prefix → resolved-class, rate-counted).
func TestTickRespawnKickoffUndelivered(t *testing.T) {
	dir := t.TempDir()
	T := backoffBase
	fk := absentRoleRespawnRig(t, dir, T)
	rr := &fakeRunRespawn{output: []byte("agent up\nkickoff: undelivered reason=parked prompt=\"/operator\" dir=\"/home/u\"\n")}

	tickOnceR(t, dir, T, fk, (&fakeNotifier{}).notify, rr.run)
	if len(rr.argvs) != 1 {
		t.Fatalf("RunRespawn calls = %d, want 1", len(rr.argvs))
	}
	lines := ReadLog(filepath.Join(dir, "live1.log"))
	if len(lines) != 1 {
		t.Fatalf("log = %+v, want one line", lines)
	}
	outcome := lines[0].Outcome
	if !strings.HasPrefix(outcome, "respawned") {
		t.Errorf("outcome = %q, want the respawned prefix (resolved-class)", outcome)
	}
	if !strings.Contains(outcome, "kickoff undelivered: parked") {
		t.Errorf("outcome = %q, want it to carry kickoff undelivered: parked", outcome)
	}
	if !resolvedOutcome(outcome) {
		t.Errorf("resolvedOutcome(%q) = false — the orphan GC would treat a revived entry as unresolved", outcome)
	}
}
