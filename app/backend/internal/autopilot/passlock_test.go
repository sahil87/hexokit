package autopilot

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	lockHelperEnv = "AUTOPILOT_PASS_LOCK_HELPER"
	// lockHelperTimeout bounds the child: the context kills it, which also
	// ends the read of its stdout if it never announces the lock.
	lockHelperTimeout = 30 * time.Second
)

// TestPassLockHolderProcess is the child of TestPassLockIsReleasedOnProcessDeath:
// it takes the lock, announces it, and waits to be killed.
func TestPassLockHolderProcess(t *testing.T) {
	path := os.Getenv(lockHelperEnv)
	if path == "" {
		t.Skip("helper process only")
	}
	if _, busy, err := acquirePassLock(path); err != nil || busy {
		os.Exit(3)
	}
	os.Stdout.WriteString("locked\n")
	select {}
}

func holdPassLock(t *testing.T, h *harness) {
	t.Helper()
	release, busy, err := acquirePassLock(h.env.StatePath)
	if err != nil || busy {
		t.Fatalf("fixture lock: busy=%v err=%v", busy, err)
	}
	t.Cleanup(release)
}

func TestPassLockPathSitsBesideTheStateFile(t *testing.T) {
	if got := passLockPath("/state/operator/work.yaml"); got != "/state/operator/work.autopilot.lock" {
		t.Fatalf("lock path = %q", got)
	}
}

func TestBusyPassDoesNothing(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	h.shipped(1, "a")
	before, err := os.ReadFile(h.env.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	holdPassLock(t, h)
	h.run.reset()
	h.panes.panes = nil

	verbs := map[string]func() (*StepResult, error){
		"step":  func() (*StepResult, error) { return Step(context.Background(), h.env) },
		"merge": func() (*StepResult, error) { return StartMerge(context.Background(), h.env, MergeOptions{}) },
		"stop":  func() (*StepResult, error) { return Stop(context.Background(), h.env) },
	}
	for name, verb := range verbs {
		res, err := verb()
		if err != nil || res == nil || !res.Busy || len(res.Actions) != 0 || len(res.Escalations) != 0 {
			t.Fatalf("%s: res=%+v err=%v", name, res, err)
		}
	}
	after, err := os.ReadFile(h.env.StatePath)
	if err != nil || string(after) != string(before) {
		t.Fatalf("a busy pass wrote the state file (err %v)", err)
	}
	if len(h.run.calls) != 0 || len(h.spawn.reqs) != 0 {
		t.Fatalf("a busy pass ran subprocesses: %q %+v", h.run.calls, h.spawn.reqs)
	}
}

func TestPassLockIsReleasedWhenThePassReturns(t *testing.T) {
	h := newHarness(t)
	if res := h.step(); res.Busy {
		t.Fatal("first pass busy")
	}
	if res := h.step(); res.Busy {
		t.Fatal("the lock outlived the pass")
	}
	// An erroring pass releases it too.
	write(t, h.env.StatePath, "tracked: [broken")
	if _, err := Step(context.Background(), h.env); err == nil {
		t.Fatal("fixture: expected the pass to fail")
	}
	release, busy, err := acquirePassLock(h.env.StatePath)
	if err != nil || busy {
		t.Fatalf("lock held after a failed pass: busy=%v err=%v", busy, err)
	}
	release()
}

func TestPassLockIsPerServer(t *testing.T) {
	h := newHarness(t)
	holdPassLock(t, h)
	other := h.env
	other.StatePath = filepath.Join(t.TempDir(), "operator", "other.yaml")
	res, err := Step(context.Background(), other)
	if err != nil || res.Busy {
		t.Fatalf("another server's pass was busy: res=%+v err=%v", res, err)
	}
}

func TestDryRunAndReadsTakeNoPassLock(t *testing.T) {
	h := newHarness(t)
	foo := newRepo(t, "foo")
	h.queue("", Entry{ID: "a", Repo: foo.Dir, Task: "a"})
	holdPassLock(t, h)
	dry := h.env
	dry.DryRun = true
	if res, err := Step(context.Background(), dry); err != nil || res.Busy {
		t.Fatalf("dry-run step: res=%+v err=%v", res, err)
	}
	if _, err := Status(context.Background(), h.env); err != nil {
		t.Fatalf("status: %v", err)
	}
	if _, err := Enqueue(context.Background(), h.env, []Entry{{ID: "b", Repo: foo.Dir, Task: "b"}}, QueueOptions{}, ""); err != nil {
		t.Fatalf("queue: %v", err)
	}
	if !h.has("b") {
		t.Fatal("queue did not write while the pass lock was held")
	}
}

func TestPassLockIsReleasedOnProcessDeath(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "operator", "state.yaml")
	ctx, cancel := context.WithTimeout(context.Background(), lockHelperTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPassLockHolderProcess$")
	cmd.Env = append(os.Environ(), lockHelperEnv+"="+statePath)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil || !strings.HasPrefix(line, "locked") {
		t.Fatalf("helper did not take the lock: %q %v", line, err)
	}
	if _, busy, err := acquirePassLock(statePath); err != nil || !busy {
		t.Fatalf("a held lock was acquirable: busy=%v err=%v", busy, err)
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	release, busy, err := acquirePassLock(statePath)
	if err != nil || busy {
		t.Fatalf("the OS did not release the lock of a dead process: busy=%v err=%v", busy, err)
	}
	release()
}
