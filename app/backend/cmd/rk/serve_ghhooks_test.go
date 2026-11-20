package main

import (
	"context"
	"testing"
	"time"
)

// A dev build's serve (just dev/air, the e2e rigs) shares the rk-daemon tmux
// socket with the box's live daemon, so it must never run the rk-gh-hooks
// watch: its empty operator.pr_hooks would kill the live session.
func TestStartGHHooksWatcherSkipsDevBuilds(t *testing.T) {
	prevVersion, prevWatch := version, ghHooksWatchFn
	t.Cleanup(func() { version, ghHooksWatchFn = prevVersion, prevWatch })

	for _, tc := range []struct {
		version string
		started bool
	}{{"dev", false}, {"1.2.3", true}} {
		version = tc.version
		started := make(chan struct{}, 1)
		ghHooksWatchFn = func(context.Context, time.Duration) { started <- struct{}{} }
		startGHHooksWatcher(context.Background())
		select {
		case <-started:
			if !tc.started {
				t.Errorf("version %q started the rk-gh-hooks watcher", tc.version)
			}
		case <-time.After(200 * time.Millisecond):
			if tc.started {
				t.Errorf("version %q did not start the rk-gh-hooks watcher", tc.version)
			}
		}
	}
}
