package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// pointOriginAt routes resolveOrigin's rung 1 (explicit RK_HOST/RK_PORT env)
// at the given host:port so wakeTabHub targets a test server.
func pointOriginAt(t *testing.T, host string, port int) {
	t.Helper()
	t.Setenv("RK_HOST", host)
	t.Setenv("RK_PORT", strconv.Itoa(port))
}

func TestWakeTabHub_PostsNameToWakeEndpoint(t *testing.T) {
	type wakeReq struct {
		path string
		body map[string]string
	}
	got := make(chan wakeReq, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]string
		_ = json.Unmarshal(raw, &body)
		got <- wakeReq{path: r.URL.Path, body: body}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)

	addr := ts.Listener.Addr().(*net.TCPAddr)
	pointOriginAt(t, "127.0.0.1", addr.Port)

	wakeTabHub(context.Background(), "srv-x")

	select {
	case req := <-got:
		if req.path != "/api/servers/wake" {
			t.Errorf("path = %q, want /api/servers/wake", req.path)
		}
		if req.body["name"] != "srv-x" {
			t.Errorf("body name = %q, want srv-x", req.body["name"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("wake POST never arrived")
	}
}

// TestTabMutation_FailSilentWakeModes drives a REAL wakeTabHub (not the
// recording stub) through a real mutating verb against the three named
// failure modes — non-2xx, hung daemon, down daemon — asserting the verb's
// stdout, stderr, and error are byte-identical to a healthy run in each.
func TestTabMutation_FailSilentWakeModes(t *testing.T) {
	env := withTabTestServer(t)
	// withTabTestServer installed the recording stub; this test wants the
	// real helper wired end-to-end.
	tabWakeFn = wakeTabHub
	t.Cleanup(func() { tabWakeFn = wakeTabHub })

	runLayoutSet := func(t *testing.T, value string) (string, string) {
		t.Helper()
		stdout, stderr, err := runTabCmd(t, "layout", env.bootID, value)
		if err != nil {
			t.Fatalf("layout set with a failing wake returned error: %v", err)
		}
		return stdout, stderr
	}

	t.Run("non-2xx response", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "boom", http.StatusInternalServerError)
		}))
		t.Cleanup(ts.Close)
		pointOriginAt(t, "127.0.0.1", ts.Listener.Addr().(*net.TCPAddr).Port)

		stdout, stderr := runLayoutSet(t, "split-h:tty,web")
		if stdout != "h(tty,web)\n" || stderr != "" {
			t.Errorf("output changed under a 500 wake: stdout=%q stderr=%q", stdout, stderr)
		}
	})

	t.Run("hung daemon bounded by tabWakeTimeout", func(t *testing.T) {
		origTimeout := tabWakeTimeout
		tabWakeTimeout = 50 * time.Millisecond
		t.Cleanup(func() { tabWakeTimeout = origTimeout })

		// The handler parks on an explicit release channel, not
		// r.Context().Done(): with an unread request body the server never
		// starts its background read, so a client disconnect would not cancel
		// the request context and ts.Close would wait on the parked handler
		// forever. Cleanups run LIFO — release closes before ts.Close waits.
		release := make(chan struct{})
		ts := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
			<-release // hang past the client's timeout
		}))
		t.Cleanup(ts.Close)
		t.Cleanup(func() { close(release) })
		pointOriginAt(t, "127.0.0.1", ts.Listener.Addr().(*net.TCPAddr).Port)

		start := time.Now()
		stdout, stderr := runLayoutSet(t, "single:tty")
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Errorf("verb took %v against a hung daemon, want the wake bounded at ~50ms", elapsed)
		}
		if stdout != "tty\n" || stderr != "" {
			t.Errorf("output changed under a hung wake: stdout=%q stderr=%q", stdout, stderr)
		}
	})

	t.Run("down daemon", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		port := ln.Addr().(*net.TCPAddr).Port
		_ = ln.Close()
		pointOriginAt(t, "127.0.0.1", port)

		stdout, stderr := runLayoutSet(t, "split-v:tty,web")
		if stdout != "v(tty,web)\n" || stderr != "" {
			t.Errorf("output changed under a refused wake: stdout=%q stderr=%q", stdout, stderr)
		}
	})
}

func TestWakeTabHub_FailSilentWhenDown(t *testing.T) {
	// A listener opened and immediately closed yields a port that refuses
	// connections — the "rk serve down" case.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	pointOriginAt(t, "127.0.0.1", port)

	start := time.Now()
	wakeTabHub(context.Background(), "srv-x") // must not panic or block
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("wake against a down daemon took %v, want a prompt refused-connection return", elapsed)
	}
}

// TestTabMutations_WakeHub proves every mutating tab verb fires exactly one
// wake carrying the mutation's resolved target server (the recording stub is
// installed by withTabTestServer).
func TestTabMutations_WakeHub(t *testing.T) {
	env := withTabTestServer(t)

	wakesAfter := func(label string, run func()) {
		t.Helper()
		before := len(env.wakes)
		run()
		if got := len(env.wakes) - before; got != 1 {
			t.Fatalf("%s: fired %d wakes, want exactly 1", label, got)
		}
		if last := env.wakes[len(env.wakes)-1]; last != env.server {
			t.Errorf("%s: woke server %q, want %q", label, last, env.server)
		}
	}

	wakesAfter("layout set", func() {
		if _, _, err := runTabCmd(t, "layout", env.bootID, "split-h:tty,web"); err != nil {
			t.Fatalf("layout set: %v", err)
		}
	})
	wakesAfter("layout --rm", func() {
		if _, _, err := runTabCmd(t, "layout", env.bootID, "--rm", "web"); err != nil {
			t.Fatalf("layout --rm: %v", err)
		}
	})
	wakesAfter("code set", func() {
		if _, _, err := runTabCmd(t, "code", "set", env.bootID, t.TempDir()); err != nil {
			t.Fatalf("code set: %v", err)
		}
	})
	wakesAfter("web add", func() {
		if _, _, err := runTabCmd(t, "web", "add", env.bootID, "https://one.example.com"); err != nil {
			t.Fatalf("web add: %v", err)
		}
	})
	wakesAfter("web mv", func() {
		if _, _, err := runTabCmd(t, "web", "add", env.bootID, "https://two.example.com"); err != nil {
			t.Fatalf("web add 2: %v", err)
		}
		env.wakes = env.wakes[:len(env.wakes)-1] // count only the mv below
		if _, _, err := runTabCmd(t, "web", "mv", fmt.Sprintf("%s/web/2", env.bootID), "1"); err != nil {
			t.Fatalf("web mv: %v", err)
		}
	})
	wakesAfter("web select", func() {
		if _, _, err := runTabCmd(t, "web", "select", fmt.Sprintf("%s/web/2", env.bootID)); err != nil {
			t.Fatalf("web select: %v", err)
		}
	})
	wakesAfter("web rm", func() {
		if _, _, err := runTabCmd(t, "web", "rm", fmt.Sprintf("%s/web/2", env.bootID)); err != nil {
			t.Fatalf("web rm: %v", err)
		}
	})
	wakesAfter("new", func() {
		if _, _, err := runTabCmd(t, "new", "--session", "=boot"); err != nil {
			t.Fatalf("new: %v", err)
		}
	})
}

// TestTabReadsAndFailures_NoWake proves read-only verbs and failed mutations
// never wake the hub.
func TestTabReadsAndFailures_NoWake(t *testing.T) {
	env := withTabTestServer(t)

	noWake := func(label string, run func()) {
		t.Helper()
		before := len(env.wakes)
		run()
		if got := len(env.wakes) - before; got != 0 {
			t.Errorf("%s: fired %d wakes, want 0", label, got)
		}
	}

	noWake("show", func() {
		if _, _, err := runTabCmd(t, "show", env.bootID); err != nil {
			t.Fatalf("show: %v", err)
		}
	})
	noWake("layout read", func() {
		if _, _, err := runTabCmd(t, "layout", env.bootID); err != nil {
			t.Fatalf("layout read: %v", err)
		}
	})
	noWake("web ls", func() {
		if _, _, err := runTabCmd(t, "web", "ls", env.bootID); err != nil {
			t.Fatalf("web ls: %v", err)
		}
	})
	noWake("failed code set", func() {
		if _, _, err := runTabCmd(t, "code", "set", env.bootID, "/nonexistent-dir-for-wake-test"); err == nil {
			t.Fatal("code set on a missing dir succeeded, want error")
		}
	})
	noWake("failed layout", func() {
		if _, _, err := runTabCmd(t, "layout", env.bootID, "bogus:tty"); err == nil {
			t.Fatal("bogus layout succeeded, want error")
		}
	})
}

// TestPresent_WakesHub proves rk present (sugar over `tab web add --show`,
// sharing webAddShow) fires the wake too — both the attach arm and --window.
func TestPresent_WakesHub(t *testing.T) {
	f := installPresentFakes(t)
	t.Setenv("TMUX_PANE", "%3") // the attach arm resolves the caller's own tab

	if _, _, err := runPresentCmd(t, t.TempDir()); err != nil {
		t.Fatalf("present: %v", err)
	}
	if len(f.wakes) != 1 {
		t.Fatalf("present fired %d wakes, want 1: %v", len(f.wakes), f.wakes)
	}

	if _, _, err := runPresentCmd(t, t.TempDir(), "--window"); err != nil {
		t.Fatalf("present --window: %v", err)
	}
	if len(f.wakes) != 2 {
		t.Fatalf("present --window: total wakes %d, want 2: %v", len(f.wakes), f.wakes)
	}
	for i, s := range f.wakes {
		if strings.TrimSpace(s) == "" {
			t.Errorf("wake[%d] carries an empty server name", i)
		}
	}
}
