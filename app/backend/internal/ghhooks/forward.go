package ghhooks

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// Supervisor restart schedule. `gh webhook forward` exits when its relay
// websocket drops and exits 1 at once when the hook cannot be created, so the
// supervisor must survive both without spinning.
const (
	BackoffInitial = 5 * time.Second
	BackoffMax     = 5 * time.Minute
	// BackoffResetAfter is how long a run must last to count as healthy: the
	// next wait then starts over from BackoffInitial.
	BackoffResetAfter = 10 * time.Minute

	// stopGrace is how long the child gets after SIGTERM before the kill, so
	// the extension can remove the hook it created.
	stopGrace = 10 * time.Second
)

// NextBackoff is the wait before the next restart, given the wait before the
// previous one (0 for the first exit) and how long the run that just ended
// lasted: BackoffInitial, doubling to BackoffMax, reset to BackoffInitial
// after a run of at least BackoffResetAfter.
func NextBackoff(prev, ran time.Duration) time.Duration {
	if prev <= 0 || ran >= BackoffResetAfter {
		return BackoffInitial
	}
	return min(prev*2, BackoffMax)
}

// ForwardURL is the receiver URL the forwarder posts to.
func ForwardURL(port int) string {
	return fmt.Sprintf("http://127.0.0.1:%d%s", port, HookPath)
}

// ForwardArgs is the argv (after `gh`) of the forwarder for one repo.
func ForwardArgs(nwo string, port int) []string {
	return []string{
		"webhook", "forward",
		"--repo", nwo,
		"--events", strings.Join(Events, ","),
		"--url", ForwardURL(port),
	}
}

// Supervise runs the forwarder child until ctx ends, restarting it with
// NextBackoff waits. The seams make the schedule testable without a child or
// a clock.
type Supervise struct {
	// Run runs one child to completion and returns its exit error.
	Run func(ctx context.Context) error
	// Now is the clock.
	Now func() time.Time
	// Sleep waits d or until ctx ends, returning ctx's error then.
	Sleep func(ctx context.Context, d time.Duration) error
	// Log reports each exit and the wait before the restart.
	Log func(msg string, args ...any)
}

// Loop returns nil once ctx ends. It never returns for any other reason.
func (s Supervise) Loop(ctx context.Context) error {
	var wait time.Duration
	for ctx.Err() == nil {
		start := s.Now()
		err := s.Run(ctx)
		if ctx.Err() != nil {
			return nil
		}
		ran := s.Now().Sub(start)
		wait = NextBackoff(wait, ran)
		s.Log("gh webhook forward exited; restarting", "err", err, "ran", ran.Round(time.Second).String(), "wait", wait.String())
		if s.Sleep(ctx, wait) != nil {
			return nil
		}
	}
	return nil
}

// RunForwarder supervises `gh webhook forward` for nwo against the receiver on
// port until ctx ends. The child is deliberately not bound to a timeout: it is
// a long-lived relay, and ctx (a stop signal to this process) is its lifetime.
//
// `gh` runs the extension as a child and does not pass signals on: SIGTERM to
// `gh` alone orphans the extension, which keeps its repository hook alive.
// The child therefore gets its own process group, and cancellation sends
// SIGTERM to the whole group — the extension removes its hook on SIGTERM.
func RunForwarder(ctx context.Context, nwo string, port int, log func(msg string, args ...any)) error {
	return Supervise{
		Run: func(ctx context.Context) error {
			cmd := exec.CommandContext(ctx, "gh", ForwardArgs(nwo, port)...)
			cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
			cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
			cmd.WaitDelay = stopGrace
			return cmd.Run()
		},
		Now: time.Now,
		Sleep: func(ctx context.Context, d time.Duration) error {
			t := time.NewTimer(d)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.C:
				return nil
			}
		},
		Log: log,
	}.Loop(ctx)
}
