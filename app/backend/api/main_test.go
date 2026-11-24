package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"rk/internal/fabsysconfig"
)

// TestMain post-sweeps dead-PID test sockets AFTER all tests run, self-healing
// residue this run leaked when a test was SIGKILLed / panicked / OOMed before
// its t.Cleanup(kill-server) could fire. The pre-sweep was dropped: the manual
// `rk mux reap` is the only by-hand cleanup for cross-run SIGKILL residue.
//
// The sweep is PID-scoped: a socket is reaped only when its embedded PID parses
// AND is dead, so a concurrently running `go test ./...` package (a separate
// live process) is never killed.
//
// The sweep logic is duplicated from internal/tmux/main_test.go: Go _test.go
// symbols are package-private and cannot be shared across packages, and the spec
// directs a small duplicated helper over exporting test-only logic from
// production code.
func TestMain(m *testing.M) {
	// Hermetic default: no test may reach the developer's real fab for the
	// preset list; tests that need a table stub listAgentPresets themselves.
	listAgentPresets = func(context.Context, string) ([]fabsysconfig.AgentPreset, error) {
		return nil, fabsysconfig.ErrPresetsUnsupported
	}
	code := m.Run()
	sweepDeadTestSockets()
	os.Exit(code)
}

// testSocketName builds a unified test socket name: rk-test-<role>-<pid>-<ns>.
// Duplicated from internal/tmux/main_test.go (cross-package test privacy).
func testSocketName(role string) string {
	return fmt.Sprintf("rk-test-%s-%d-%d", role, os.Getpid(), time.Now().UnixNano())
}

// testSocketPrefix is the single umbrella prefix every test socket carries.
const testSocketPrefix = "rk-test-"

// testSocketE2EPrefix anchors the Playwright e2e socket family, which owns its
// own teardown chain (scripts/test-e2e.sh's EXIT trap, global-teardown.ts,
// `rk mux reap`). A secondary's embedded pid is the Playwright WORKER pid, and
// a worker respawn (retries: 1) leaves a still-in-use server owned by a dead
// pid, so the PID rule alone would reap it mid-run.
const testSocketE2EPrefix = "rk-test-e2e-"

// parseTestSocketPID extracts the embedded PID from a unified test socket name
// of the form rk-test-<role>-<pid>-<ns>, where <role> MAY contain hyphens. The
// PID is the SECOND-TO-LAST hyphen field. Returns ok=false for a missing
// prefix, too few fields, or a non-numeric PID field.
func parseTestSocketPID(name string) (int, bool) {
	if !strings.HasPrefix(name, testSocketPrefix) {
		return 0, false
	}
	fields := strings.Split(name, "-")
	if len(fields) < 5 {
		return 0, false
	}
	pid, err := strconv.Atoi(fields[len(fields)-2])
	if err != nil {
		return 0, false
	}
	return pid, true
}

// testPIDAlive mirrors cmd/rk/serve_sweep.go:pidAlive — biased toward "alive" on
// any non-ESRCH ambiguity so the post-sweep leaks rather than reaps a socket
// whose owner may still be running. A non-positive pid is treated as dead: a
// real socket embeds os.Getpid() (≥ 1), and syscall.Kill(0, 0) / negative pids
// target a process group (not a single process) and would otherwise be misread
// as a live owner.
func testPIDAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	return !errors.Is(err, syscall.ESRCH)
}

// sweepDeadTestSockets enumerates /tmp/tmux-<uid>/ and reaps (kill-server + file removal) every
// rk-test-* socket this run should reap at TestMain exit: sockets embedding OUR
// OWN pid (os.Getpid() — we are exiting, so they are residue, even though our
// pid is still "alive" during the post-sweep) and sockets embedding a DEAD pid.
// A socket owned by a DIFFERENT live process (a concurrent `go test ./...`
// package) is spared, as is the whole rk-test-e2e- family
// (testSocketE2EPrefix). PID-scoped, never a blanket rk-test-* wipe.
// Best-effort: enumeration, kill, or removal failures ignored.
func sweepDeadTestSockets() {
	self := os.Getpid()
	socketDir := "/tmp/tmux-" + strconv.Itoa(os.Getuid())
	entries, err := os.ReadDir(socketDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		// Checked BEFORE the PID parse: an e2e secondary's embedded pid can be a
		// dead respawned worker while its server is still in use.
		if strings.HasPrefix(name, testSocketE2EPrefix) {
			continue
		}
		pid, ok := parseTestSocketPID(name)
		if !ok {
			continue
		}
		// Spare only OTHER live processes' sockets; reap our own (we are exiting).
		if pid != self && testPIDAlive(pid) {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = exec.CommandContext(ctx, "tmux", "-L", name, "kill-server").Run()
		cancel()
		// tmux does not unlink a killed (or already-dead) server's socket, so
		// remove the file too — leaked files accumulate in /tmp/tmux-<uid>/ and
		// /api/servers probes every one of them per request.
		_ = os.Remove(filepath.Join(socketDir, name))
	}
}
