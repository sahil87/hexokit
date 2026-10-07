package codebridge

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// startFakeBridge serves the NDJSON bridge protocol on a fresh Unix socket:
// one request line in, respond(line) decides the one response line out (or
// stalls when it returns ok=false, simulating a hung host), then the
// connection closes.
func startFakeBridge(t *testing.T, respond func(line string) (string, bool)) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "bridge.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				line, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					return
				}
				out, ok := respond(string(line))
				if !ok {
					// Hung host: never respond; return when the client gives
					// up and closes its end.
					io.Copy(io.Discard, c)
					return
				}
				fmt.Fprintln(c, out)
			}(conn)
		}
	}()
	return sock
}

func TestCallSuccessRoundTrip(t *testing.T) {
	var gotRequest string
	sock := startFakeBridge(t, func(line string) (string, bool) {
		gotRequest = line
		return `{"id":"r1","ok":true,"result":{"answer":42},"ms":7}`, true
	})

	resp, err := Call(context.Background(), sock, Request{
		ID:      "r1",
		Command: "pr.checkoutByNumber",
		Args:    ParseArgs([]string{"2908", "bare"}),
	})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if !resp.OK || resp.ID != "r1" || resp.Ms != 7 {
		t.Errorf("response = %+v", resp)
	}
	if string(resp.Result) != `{"answer":42}` {
		t.Errorf("result = %s", resp.Result)
	}
	// Args cross the wire as raw JSON: number stays a number, bare word is a string.
	if !strings.Contains(gotRequest, `"args":[2908,"bare"]`) {
		t.Errorf("request args on the wire = %s", strings.TrimSpace(gotRequest))
	}
}

func TestCallErrorKinds(t *testing.T) {
	for _, kind := range []ErrorKind{ErrKindUnknownCommand, ErrKindThrew, ErrKindTimeout, ErrKindBadRequest} {
		sock := startFakeBridge(t, func(string) (string, bool) {
			return fmt.Sprintf(`{"id":"e","ok":false,"error":{"kind":%q,"message":"boom"}}`, kind), true
		})
		resp, err := Call(context.Background(), sock, Request{ID: "e", Command: "x"})
		if err != nil {
			t.Fatalf("Call(%s): %v", kind, err)
		}
		if resp.OK || resp.Error == nil || resp.Error.Kind != kind || resp.Error.Message != "boom" {
			t.Errorf("kind %s: response = %+v", kind, resp)
		}
	}
}

func TestCallTimeoutViaDeadline(t *testing.T) {
	sock := startFakeBridge(t, func(string) (string, bool) {
		return "", false // hung host
	})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := Call(ctx, sock, Request{ID: "t", Command: "x"}); err == nil {
		t.Fatal("Call against a hung host: want error, got nil")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("Call blocked %v past the 100ms ctx deadline", elapsed)
	}
}

func TestCallDialFailure(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope.sock")
	if _, err := Call(context.Background(), missing, Request{ID: "d", Command: "x"}); err == nil {
		t.Fatal("Call to a missing socket: want error, got nil")
	}
}

func TestPing(t *testing.T) {
	sock := startFakeBridge(t, func(line string) (string, bool) {
		var req Request
		if err := json.Unmarshal([]byte(line), &req); err != nil || req.Command != "__ping" {
			return `{"id":null,"ok":false,"error":{"kind":"bad-request","message":"nope"}}`, true
		}
		return fmt.Sprintf(`{"id":%q,"ok":true,"result":{"folder":"/repo","pid":123,"version":"3.19.0"},"ms":1}`, req.ID), true
	})
	info, err := Ping(context.Background(), sock)
	if err != nil {
		t.Fatalf("Ping: %v", err)
	}
	if info.Folder != "/repo" || info.PID != 123 || info.Version != "3.19.0" {
		t.Errorf("PingInfo = %+v", info)
	}
}

// deadPID returns a pid that is guaranteed not to exist on this machine.
func deadPID(t *testing.T) int {
	t.Helper()
	for pid := 1 << 20; ; pid++ {
		if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
			return pid
		}
	}
}

func writeRecord(t *testing.T, dir string, rec HostRecord) {
	t.Helper()
	data, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(recordPath(dir, rec.HostID), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestLiveHostsPruning: a record counts only after kill-0 AND __ping — a dead
// pid is pruned, a live pid whose socket is gone is pruned, and the file is
// deleted in both cases; the fully live record survives.
func TestLiveHostsPruning(t *testing.T) {
	dir := t.TempDir()
	sock := startFakeBridge(t, func(line string) (string, bool) {
		return `{"id":"__ping","ok":true,"result":{"folder":"/repo","pid":1,"version":"3.19.0"},"ms":1}`, true
	})

	dead := HostRecord{HostID: "dead", Folder: "/dead", PID: deadPID(t), Sock: sock}
	noSock := HostRecord{HostID: "nosock", Folder: "/nosock", PID: os.Getpid(), Sock: filepath.Join(dir, "gone.sock")}
	live := HostRecord{HostID: "live", Folder: "/repo", PID: os.Getpid(), Sock: sock}
	for _, rec := range []HostRecord{dead, noSock, live} {
		writeRecord(t, dir, rec)
	}

	gotLive, pruned, err := LiveHosts(context.Background(), dir)
	if err != nil {
		t.Fatalf("LiveHosts: %v", err)
	}
	if len(gotLive) != 1 || gotLive[0].HostID != "live" {
		t.Errorf("live = %+v, want only the live record", gotLive)
	}
	if len(pruned) != 2 {
		t.Errorf("pruned = %+v, want the dead and socket-less records", pruned)
	}
	for _, id := range []string{"dead", "nosock"} {
		if _, err := os.Stat(recordPath(dir, id)); !os.IsNotExist(err) {
			t.Errorf("pruned record %s still on disk: %v", id, err)
		}
	}
	if _, err := os.Stat(recordPath(dir, "live")); err != nil {
		t.Errorf("live record removed: %v", err)
	}
}

func TestLiveHostsMissingDir(t *testing.T) {
	live, pruned, err := LiveHosts(context.Background(), filepath.Join(t.TempDir(), "nope"))
	if err != nil || len(live) != 0 || len(pruned) != 0 {
		t.Errorf("LiveHosts on missing dir = (%v, %v, %v), want empty", live, pruned, err)
	}
}

// TestProbeLiveHostsNonPruning: the probe shares LiveHosts's liveness rule
// (kill-0 AND __ping) but removes nothing — a dead record stays on disk for
// ordinary discovery to prune.
func TestProbeLiveHostsNonPruning(t *testing.T) {
	dir := t.TempDir()
	sock := startFakeBridge(t, func(line string) (string, bool) {
		return `{"id":"__ping","ok":true,"result":{"folder":"/repo","pid":1,"version":"3.19.0"},"ms":1}`, true
	})

	dead := HostRecord{HostID: "dead", Folder: "/dead", PID: deadPID(t), Sock: sock}
	live := HostRecord{HostID: "live", Folder: "/repo", PID: os.Getpid(), Sock: sock}
	for _, rec := range []HostRecord{dead, live} {
		writeRecord(t, dir, rec)
	}

	got, err := ProbeLiveHosts(context.Background(), dir)
	if err != nil {
		t.Fatalf("ProbeLiveHosts: %v", err)
	}
	if len(got) != 1 || got[0].HostID != "live" {
		t.Errorf("live = %+v, want only the live record", got)
	}
	if _, err := os.Stat(recordPath(dir, "dead")); err != nil {
		t.Errorf("the probe must not prune the dead record: %v", err)
	}
}

// TestProbeLiveHostsStrict: a record file the probe cannot decode is an
// error, never a skipped entry — a deletion guard cannot prove the host
// behind an unreadable record is dead.
func TestProbeLiveHostsStrict(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(recordPath(dir, "bad"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := ProbeLiveHosts(context.Background(), dir)
	if err == nil {
		t.Errorf("ProbeLiveHosts with an undecodable record = (%v, nil), want an error", got)
	}
}

func TestProbeLiveHostsMissingDir(t *testing.T) {
	live, err := ProbeLiveHosts(context.Background(), filepath.Join(t.TempDir(), "nope"))
	if err != nil || len(live) != 0 {
		t.Errorf("ProbeLiveHosts on missing dir = (%v, %v), want empty", live, err)
	}
}
