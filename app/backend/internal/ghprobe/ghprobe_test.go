package ghprobe

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// stubGh puts a fake `gh` on PATH for the rest of the test. It appends a line
// to a counter file on every run, because the probe shells out for real and
// counting invocations is the only way to prove the memo suppressed one.
func stubGh(t *testing.T, exitCode int) {
	t.Helper()
	dir := t.TempDir()
	script := "#!/bin/sh\necho x >> " + filepath.Join(dir, "runs") + "\nexit " + strconv.Itoa(exitCode) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// ghRuns counts how many times the stub on PATH has been executed.
func ghRuns(t *testing.T) int {
	t.Helper()
	path, err := exec.LookPath("gh")
	if err != nil {
		t.Fatalf("stub gh not on PATH: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(path), "runs"))
	if err != nil {
		return 0
	}
	return bytes.Count(data, []byte("\n"))
}

// freeze installs a controllable clock and resets the memo, so a TTL can be
// crossed without sleeping through it.
func freeze(t *testing.T) *time.Time {
	t.Helper()
	Reset()
	at := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	now = func() time.Time { return at }
	t.Cleanup(func() { now = time.Now; Reset() })
	return &at
}

// A successful probe is a network call — measured at 0.34-0.39 s, and twice at
// 30 s. Paying it on every cold document was both a fixed tax and, past the
// caller's 10 s timeout, a working tile reporting "gh is unavailable".
func TestASuccessfulProbeIsNotRepeatedInsideItsTTL(t *testing.T) {
	stubGh(t, 0)
	clock := freeze(t)

	for i := 0; i < 3; i++ {
		if !Available(context.Background(), time.Second) {
			t.Fatalf("call %d: want available", i)
		}
	}
	if runs := ghRuns(t); runs != 1 {
		t.Errorf("gh ran %d times inside the TTL, want 1", runs)
	}

	*clock = clock.Add(positiveTTL + time.Second)
	if !Available(context.Background(), time.Second) {
		t.Fatal("want available after the TTL")
	}
	if runs := ghRuns(t); runs != 2 {
		t.Errorf("gh ran %d times across the TTL boundary, want 2", runs)
	}
}

// The asymmetry is the point: "gh is broken" is a fact the user is actively
// fixing, so a 5-minute negative memo would hide their own `gh auth login` from
// them. 30 s is short enough to feel like a retry and long enough to stop a
// mounted tile from probing on every request.
func TestAFailedProbeIsRetriedSooner(t *testing.T) {
	stubGh(t, 1)
	clock := freeze(t)

	if Available(context.Background(), time.Second) {
		t.Fatal("want unavailable")
	}
	*clock = clock.Add(negativeTTL - time.Second)
	if Available(context.Background(), time.Second) {
		t.Fatal("want unavailable")
	}
	if runs := ghRuns(t); runs != 1 {
		t.Errorf("gh ran %d times inside the negative TTL, want 1", runs)
	}

	*clock = clock.Add(2 * time.Second) // now past negativeTTL
	Available(context.Background(), time.Second)
	if runs := ghRuns(t); runs != 2 {
		t.Errorf("gh ran %d times after the negative TTL, want 2", runs)
	}
	if positiveTTL <= negativeTTL {
		t.Errorf("positiveTTL (%s) must exceed negativeTTL (%s)", positiveTTL, negativeTTL)
	}
}

// LookPath stays outside the memo: caching it would mean a gh installed
// mid-session stays invisible until the TTL expires.
func TestAMissingBinaryIsNeverMemoized(t *testing.T) {
	freeze(t)
	t.Setenv("PATH", t.TempDir())
	if Available(context.Background(), time.Second) {
		t.Fatal("want unavailable with no gh on PATH")
	}

	stubGh(t, 0)
	if !Available(context.Background(), time.Second) {
		t.Fatal("a gh that appeared on PATH must be seen immediately")
	}
}
