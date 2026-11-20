package ghhooks

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestNextBackoffSchedule(t *testing.T) {
	var waits []time.Duration
	var prev time.Duration
	for range 9 {
		prev = NextBackoff(prev, time.Second)
		waits = append(waits, prev)
	}
	want := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second, 80 * time.Second,
		160 * time.Second, 300 * time.Second, 300 * time.Second, 300 * time.Second}
	if !reflect.DeepEqual(waits, want) {
		t.Errorf("waits = %v, want %v", waits, want)
	}
}

func TestNextBackoffResetsAfterAHealthyRun(t *testing.T) {
	if got := NextBackoff(160*time.Second, BackoffResetAfter); got != BackoffInitial {
		t.Errorf("after a %v run: %v, want %v", BackoffResetAfter, got, BackoffInitial)
	}
	if got := NextBackoff(160*time.Second, BackoffResetAfter-time.Second); got != 300*time.Second {
		t.Errorf("a run just under the reset window must keep climbing, got %v", got)
	}
	if got := NextBackoff(0, 15*time.Minute); got != BackoffInitial {
		t.Errorf("first exit: %v, want %v", got, BackoffInitial)
	}
}

func TestForwardArgs(t *testing.T) {
	got := ForwardArgs("o/r", 21900)
	want := []string{"webhook", "forward", "--repo", "o/r",
		"--events", "pull_request,pull_request_review,check_suite,workflow_run",
		"--url", "http://127.0.0.1:21900/hooks/github"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ForwardArgs = %v, want %v", got, want)
	}
	if strings.Contains(strings.Join(got, ","), "check_run") {
		t.Error("check_run must not be subscribed")
	}
}

// fakeClock advances only when the supervisor sleeps or a run "lasts".
type fakeClock struct {
	now    time.Time
	sleeps []time.Duration
}

func (c *fakeClock) Now() time.Time { return c.now }

func TestSuperviseRestartsWithBackoff(t *testing.T) {
	clock := &fakeClock{now: time.Unix(1_000_000, 0)}
	runs := []time.Duration{time.Second, time.Second, time.Second, 15 * time.Minute, time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	var attempts int
	var logs []string
	s := Supervise{
		Run: func(context.Context) error {
			clock.now = clock.now.Add(runs[attempts])
			attempts++
			return errors.New("unable to connect to webhooks server, forwarding stopped")
		},
		Now: clock.Now,
		Sleep: func(_ context.Context, d time.Duration) error {
			clock.sleeps = append(clock.sleeps, d)
			if attempts == len(runs) {
				cancel()
				return context.Canceled
			}
			return nil
		},
		Log: func(msg string, _ ...any) { logs = append(logs, msg) },
	}
	if err := s.Loop(ctx); err != nil {
		t.Fatalf("Loop: %v", err)
	}
	want := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 5 * time.Second, 10 * time.Second}
	if !reflect.DeepEqual(clock.sleeps, want) {
		t.Errorf("waits = %v, want %v (reset after the 15-minute run)", clock.sleeps, want)
	}
	if len(logs) != len(runs) {
		t.Errorf("logged %d exits, want %d", len(logs), len(runs))
	}
}

func TestSuperviseStopsWithoutRestartWhenContextEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var attempts int
	s := Supervise{
		Run: func(ctx context.Context) error {
			attempts++
			cancel()
			return errors.New("killed by the stop signal")
		},
		Now:   time.Now,
		Sleep: func(context.Context, time.Duration) error { t.Fatal("must not sleep after a stop"); return nil },
		Log:   func(string, ...any) { t.Fatal("a stop is not an exit to report") },
	}
	if err := s.Loop(ctx); err != nil || attempts != 1 {
		t.Errorf("err=%v attempts=%d, want a clean single run", err, attempts)
	}
}
