package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/sessions"
	"rk/internal/testutil"
	"rk/internal/tmux"
)

// stubOperatorStartRun swaps the exec + self-path seams for the duration of a
// handler test, returning a pointer to the recorded argv (nil until called).
func stubOperatorStartRun(t *testing.T, run func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error)) *[]string {
	t.Helper()
	var gotArgv []string
	prevRun, prevSelf := operatorStartRunFn, resolveSelfPathFn
	operatorStartRunFn = func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
		gotArgv = append([]string(nil), argv...)
		return run(ctx, argv, onExit)
	}
	resolveSelfPathFn = func() (string, error) { return "/fake/rk", nil }
	t.Cleanup(func() {
		operatorStartRunFn, resolveSelfPathFn = prevRun, prevSelf
	})
	return &gotArgv
}

func operatorStartRequest(server string) (*httptest.ResponseRecorder, *http.Request) {
	return operatorStartRequestBody(server, "{}")
}

// operatorStartRequestBody builds the POST with an explicit raw body; "" means
// a truly empty body (no reader).
func operatorStartRequestBody(server, body string) (*httptest.ResponseRecorder, *http.Request) {
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	return httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/operator/start?server="+server, rdr)
}

// stubOperatorStartMainRoot swaps the main-worktree collapse seam for the
// test's duration; roots maps a pane cwd to the served main root (an absent
// entry collapses to "" — not a repository).
func stubOperatorStartMainRoot(t *testing.T, roots map[string]string) {
	t.Helper()
	prev := operatorStartMainRootFn
	operatorStartMainRootFn = func(_ context.Context, dir string) string { return roots[dir] }
	t.Cleanup(func() { operatorStartMainRootFn = prev })
}

func decodeOperatorStartBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]string {
	t.Helper()
	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v (body %q)", err, rec.Body.String())
	}
	return body
}

func TestOperatorStart_CreatedReturns202WakesHub(t *testing.T) {
	server, tracker := newWakeSeamServer(t, &mockTmuxOps{})
	gotArgv := stubOperatorStartRun(t, func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
		return operatorStartReceipt{Window: "@7", Server: "default", Created: true}, "", nil
	})

	rec, req := operatorStartRequest("default")
	server.buildRouter().ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	if body := decodeOperatorStartBody(t, rec); body["windowId"] != "@7" || body["server"] != "default" {
		t.Errorf("body = %v, want {windowId:@7, server:default}", body)
	}
	if want := []string{"/fake/rk", "operator", "-L", "default", "--json"}; strings.Join(*gotArgv, " ") != strings.Join(want, " ") {
		t.Errorf("argv = %v, want %v", *gotArgv, want)
	}
	// Exactly one wake-driven pass: the pre-check already consumed one fetch
	// (synchronous inside ServeHTTP), so the wake adds exactly one more.
	afterPreCheck := tracker.count.Load()
	expectWake(t, tracker, afterPreCheck, "operator start")
	time.Sleep(300 * time.Millisecond)
	if got := tracker.count.Load(); got != afterPreCheck+1 {
		t.Errorf("FetchSessions count = %d, want %d (pre-check + exactly one wake-driven pass)", got, afterPreCheck+1)
	}
}

// An empty body keeps the pre-change shape: the exec argv carries no --dir.
func TestOperatorStart_EmptyBodyKeepsBareArgv(t *testing.T) {
	fetcher := &mockSessionFetcher{result: []sessions.ProjectSession{{Name: "s1"}}}
	router := NewTestRouter(slog.New(slog.NewTextHandler(io.Discard, nil)), fetcher, &mockTmuxOps{}, "test-host")
	gotArgv := stubOperatorStartRun(t, func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
		return operatorStartReceipt{Window: "@7", Server: "default", Created: true}, "", nil
	})

	rec, req := operatorStartRequestBody("default", "")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	if want := []string{"/fake/rk", "operator", "-L", "default", "--json"}; strings.Join(*gotArgv, " ") != strings.Join(want, " ") {
		t.Errorf("argv = %v, want %v", *gotArgv, want)
	}
}

// Malformed JSON and a malformed window id are 400s before any exec.
func TestOperatorStart_BadBodyIs400(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"malformed JSON", "{"},
		{"malformed window id", `{"window":"7"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fetcher := &mockSessionFetcher{result: []sessions.ProjectSession{{Name: "s1"}}}
			router := NewTestRouter(slog.New(slog.NewTextHandler(io.Discard, nil)), fetcher, &mockTmuxOps{}, "test-host")
			stubOperatorStartRun(t, func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
				t.Error("exec seam called despite the invalid body")
				return operatorStartReceipt{}, "", nil
			})

			rec, req := operatorStartRequestBody("default", tc.body)
			router.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

// A viewed window's pane cwd collapses to its main-worktree root and rides
// the argv as --dir.
func TestOperatorStart_ViewedWindowDerivesDir(t *testing.T) {
	mainRoot := t.TempDir()
	worktreeCwd := filepath.Join(mainRoot+".worktrees", "feat-x")
	fetcher := &mockSessionFetcher{result: []sessions.ProjectSession{{
		Name:    "s1",
		Windows: []tmux.WindowInfo{{WindowID: "@1", WorktreePath: worktreeCwd}},
	}}}
	router := NewTestRouter(slog.New(slog.NewTextHandler(io.Discard, nil)), fetcher, &mockTmuxOps{}, "test-host")
	stubOperatorStartMainRoot(t, map[string]string{worktreeCwd: mainRoot})
	gotArgv := stubOperatorStartRun(t, func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
		return operatorStartReceipt{Window: "@9", Server: "default", Created: true}, "", nil
	})

	rec, req := operatorStartRequestBody("default", `{"window":"@1"}`)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	want := []string{"/fake/rk", "operator", "-L", "default", "--dir", mainRoot, "--json"}
	if strings.Join(*gotArgv, " ") != strings.Join(want, " ") {
		t.Errorf("argv = %v, want %v", *gotArgv, want)
	}
}

// A viewed window whose cwd is not inside a git repository passes the cwd
// verbatim (deterministic — it is where the user is).
func TestOperatorStart_ViewedWindowNonRepoUsesCwdVerbatim(t *testing.T) {
	cwd := t.TempDir()
	fetcher := &mockSessionFetcher{result: []sessions.ProjectSession{{
		Name:    "s1",
		Windows: []tmux.WindowInfo{{WindowID: "@1", WorktreePath: cwd}},
	}}}
	router := NewTestRouter(slog.New(slog.NewTextHandler(io.Discard, nil)), fetcher, &mockTmuxOps{}, "test-host")
	stubOperatorStartMainRoot(t, map[string]string{})
	gotArgv := stubOperatorStartRun(t, func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
		return operatorStartReceipt{Window: "@9", Server: "default", Created: true}, "", nil
	})

	rec, req := operatorStartRequestBody("default", `{"window":"@1"}`)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	want := []string{"/fake/rk", "operator", "-L", "default", "--dir", cwd, "--json"}
	if strings.Join(*gotArgv, " ") != strings.Join(want, " ") {
		t.Errorf("argv = %v, want %v", *gotArgv, want)
	}
}

// A well-formed window the server does not have (closed between the click and
// the request), a window with an empty pane cwd, or a derived directory that
// no longer exists all degrade to the no-window argv instead of failing the
// start.
func TestOperatorStart_UnresolvableWindowKeepsBareArgv(t *testing.T) {
	for _, tc := range []struct {
		name    string
		windows []tmux.WindowInfo
		body    string
	}{
		{"unknown window", []tmux.WindowInfo{{WindowID: "@1", WorktreePath: "/tmp/x"}}, `{"window":"@99"}`},
		{"empty pane cwd", []tmux.WindowInfo{{WindowID: "@1", WorktreePath: ""}}, `{"window":"@1"}`},
		{"derived dir gone", []tmux.WindowInfo{{WindowID: "@1", WorktreePath: "/nonexistent/rk-start-gone"}}, `{"window":"@1"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fetcher := &mockSessionFetcher{result: []sessions.ProjectSession{{Name: "s1", Windows: tc.windows}}}
			router := NewTestRouter(slog.New(slog.NewTextHandler(io.Discard, nil)), fetcher, &mockTmuxOps{}, "test-host")
			stubOperatorStartMainRoot(t, map[string]string{})
			gotArgv := stubOperatorStartRun(t, func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
				return operatorStartReceipt{Window: "@9", Server: "default", Created: true}, "", nil
			})

			rec, req := operatorStartRequestBody("default", tc.body)
			router.ServeHTTP(rec, req)

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
			}
			if want := []string{"/fake/rk", "operator", "-L", "default", "--json"}; strings.Join(*gotArgv, " ") != strings.Join(want, " ") {
				t.Errorf("argv = %v, want %v", *gotArgv, want)
			}
		})
	}
}

func TestOperatorStart_OperatorExistsPreCheck(t *testing.T) {
	fetcher := &mockSessionFetcher{result: []sessions.ProjectSession{{
		Name:    "s1",
		Windows: []tmux.WindowInfo{{WindowID: "@3", Name: "operator", Role: "operator"}},
	}}}
	router := NewTestRouter(slog.New(slog.NewTextHandler(io.Discard, nil)), fetcher, &mockTmuxOps{}, "test-host")
	stubOperatorStartRun(t, func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
		t.Error("exec seam called despite an operator already present")
		return operatorStartReceipt{}, "", nil
	})

	rec, req := operatorStartRequest("default")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeOperatorStartBody(t, rec)
	if body["code"] != "operator_exists" || body["windowId"] != "@3" {
		t.Errorf("body = %v, want code=operator_exists with the incumbent windowId @3", body)
	}
}

func TestOperatorStart_FetchErrorIs500(t *testing.T) {
	fetcher := &mockSessionFetcher{err: errors.New("tmux down")}
	router := NewTestRouter(slog.New(slog.NewTextHandler(io.Discard, nil)), fetcher, &mockTmuxOps{}, "test-host")
	stubOperatorStartRun(t, func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
		t.Error("exec seam called despite the fetch failure")
		return operatorStartReceipt{}, "", nil
	})

	rec, req := operatorStartRequest("default")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

func TestOperatorStart_CreatedFalseIs409(t *testing.T) {
	fetcher := &mockSessionFetcher{result: []sessions.ProjectSession{{Name: "s1"}}}
	router := NewTestRouter(slog.New(slog.NewTextHandler(io.Discard, nil)), fetcher, &mockTmuxOps{}, "test-host")
	stubOperatorStartRun(t, func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
		// The singleton probe found one the pre-check missed.
		return operatorStartReceipt{Window: "@5", Server: "default", Created: false}, "", nil
	})

	rec, req := operatorStartRequest("default")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeOperatorStartBody(t, rec)
	if body["code"] != "operator_exists" || body["windowId"] != "@5" {
		t.Errorf("body = %v, want code=operator_exists with windowId @5", body)
	}
}

func TestOperatorStart_ExecFailureCarriesStderrLine(t *testing.T) {
	fetcher := &mockSessionFetcher{result: []sessions.ProjectSession{{Name: "s1"}}}
	router := NewTestRouter(slog.New(slog.NewTextHandler(io.Discard, nil)), fetcher, &mockTmuxOps{}, "test-host")
	stubOperatorStartRun(t, func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
		return operatorStartReceipt{}, "\nrun-kit operator: fab not found on PATH — install fab\nsecond line\n", errors.New("exit status 1")
	})

	rec, req := operatorStartRequest("default")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502; body=%s", rec.Code, rec.Body.String())
	}
	if body := decodeOperatorStartBody(t, rec); body["error"] != "run-kit operator: fab not found on PATH — install fab" {
		t.Errorf("error = %q, want the first non-empty stderr line", body["error"])
	}
}

func TestOperatorStart_ReceiptTimeoutIs504(t *testing.T) {
	fetcher := &mockSessionFetcher{result: []sessions.ProjectSession{{Name: "s1"}}}
	router := NewTestRouter(slog.New(slog.NewTextHandler(io.Discard, nil)), fetcher, &mockTmuxOps{}, "test-host")
	stubOperatorStartRun(t, func(ctx context.Context, argv []string, onExit operatorStartExitFn) (operatorStartReceipt, string, error) {
		return operatorStartReceipt{}, "", errOperatorStartTimeout
	})

	rec, req := operatorStartRequest("default")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want 504; body=%s", rec.Code, rec.Body.String())
	}
	if body := decodeOperatorStartBody(t, rec); body["error"] != "operator start timed out" {
		t.Errorf("error = %q, want %q", body["error"], "operator start timed out")
	}
}

// TestRunOperatorStartExec exercises the default seam against stub scripts
// standing in for the rk binary.
func TestRunOperatorStartExec(t *testing.T) {
	t.Run("chatter lines are skipped until the receipt parses", func(t *testing.T) {
		dir := t.TempDir()
		// The real envelope shape: outputSink.writeEnvelope renders one
		// two-space-indented multi-line document, not a compact line.
		testutil.WriteStub(t, dir, "rk", "#!/bin/sh\necho 'some chatter'\nprintf '%s\n' '{' '  \"ok\": true,' '  \"result\": {' '    \"window\": \"@7\",' '    \"server\": \"default\",' '    \"created\": true' '  }' '}'\n")
		receipt, stderr, err := runOperatorStartExec(context.Background(), []string{filepath.Join(dir, "rk"), "operator", "-L", "default", "--json"}, nil)
		if err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if stderr != "" {
			t.Errorf("stderr = %q, want empty", stderr)
		}
		if receipt.Window != "@7" || receipt.Server != "default" || !receipt.Created {
			t.Errorf("receipt = %+v, want {@7 default created:true}", receipt)
		}
	})

	t.Run("the indented envelope returns while the process keeps running", func(t *testing.T) {
		dir := t.TempDir()
		testutil.WriteStub(t, dir, "rk", "#!/bin/sh\nprintf '%s\n' '{' '  \"ok\": true,' '  \"result\": { \"window\": \"@9\", \"server\": \"default\", \"created\": true }' '}'\nsleep 2\n")
		start := time.Now()
		receipt, _, err := runOperatorStartExec(context.Background(), []string{filepath.Join(dir, "rk")}, nil)
		if err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if receipt.Window != "@9" {
			t.Errorf("receipt = %+v, want window @9", receipt)
		}
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Errorf("returned after %v, want the receipt-fast path well under the process's 2s kickoff", elapsed)
		}
	})

	t.Run("a non-zero exit without a receipt surfaces stderr", func(t *testing.T) {
		dir := t.TempDir()
		testutil.WriteStub(t, dir, "rk", "#!/bin/sh\necho 'run-kit operator: fab not found on PATH' >&2\nexit 1\n")
		_, stderr, err := runOperatorStartExec(context.Background(), []string{filepath.Join(dir, "rk")}, nil)
		if err == nil {
			t.Fatal("err = nil, want the non-zero exit")
		}
		if errors.Is(err, errOperatorStartTimeout) {
			t.Errorf("err = %v, must not be the timeout sentinel", err)
		}
		if !strings.Contains(stderr, "fab not found on PATH") {
			t.Errorf("stderr = %q, want the script's error line", stderr)
		}
	})

	t.Run("no receipt within the bound kills the process", func(t *testing.T) {
		prev := operatorStartReceiptTimeout
		operatorStartReceiptTimeout = 150 * time.Millisecond
		t.Cleanup(func() { operatorStartReceiptTimeout = prev })
		dir := t.TempDir()
		testutil.WriteStub(t, dir, "rk", "#!/bin/sh\nexec sleep 5\n")
		start := time.Now()
		_, _, err := runOperatorStartExec(context.Background(), []string{filepath.Join(dir, "rk")}, nil)
		if !errors.Is(err, errOperatorStartTimeout) {
			t.Fatalf("err = %v, want errOperatorStartTimeout", err)
		}
		if elapsed := time.Since(start); elapsed > 2*time.Second {
			t.Errorf("returned after %v, want the kill to land promptly after the 150ms bound", elapsed)
		}
	})

	t.Run("a failure envelope line does not count as a receipt", func(t *testing.T) {
		dir := t.TempDir()
		testutil.WriteStub(t, dir, "rk", "#!/bin/sh\necho '{\"ok\":false,\"error\":{\"code\":\"operational\",\"message\":\"boom\"}}'\necho 'run-kit operator: boom' >&2\nexit 1\n")
		_, stderr, err := runOperatorStartExec(context.Background(), []string{filepath.Join(dir, "rk")}, nil)
		if err == nil || errors.Is(err, errOperatorStartTimeout) {
			t.Fatalf("err = %v, want the non-zero exit (not a receipt, not a timeout)", err)
		}
		if !strings.Contains(stderr, "boom") {
			t.Errorf("stderr = %q, want the script's error line", stderr)
		}
	})

	t.Run("onExit fires after the exit with the receipt and full stderr", func(t *testing.T) {
		dir := t.TempDir()
		testutil.WriteStub(t, dir, "rk", "#!/bin/sh\nprintf '%s\n' '{' '  \"ok\": true,' '  \"result\": { \"window\": \"@7\", \"server\": \"default\", \"created\": true, \"dir\": \"/home/u/proj\", \"dir_rung\": \"stored\" }' '}'\necho 'kickoff: undelivered reason=parked prompt=\"/fab-operator\" dir=\"/home/u/proj\"' >&2\nexit 0\n")
		type exitCall struct {
			receipt operatorStartReceipt
			stderr  string
			err     error
		}
		fired := make(chan exitCall, 1)
		receipt, _, err := runOperatorStartExec(context.Background(), []string{filepath.Join(dir, "rk")}, func(r operatorStartReceipt, stderr string, exitErr error) {
			fired <- exitCall{r, stderr, exitErr}
		})
		if err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if receipt.Dir != "/home/u/proj" || receipt.DirRung != "stored" {
			t.Errorf("receipt = %+v, want the dir/dir_rung fields parsed", receipt)
		}
		select {
		case call := <-fired:
			if call.err != nil {
				t.Errorf("exit err = %v, want nil (clean exit)", call.err)
			}
			if call.receipt.Window != "@7" {
				t.Errorf("callback receipt = %+v, want window @7", call.receipt)
			}
			if !strings.Contains(call.stderr, "kickoff: undelivered reason=parked") {
				t.Errorf("callback stderr = %q, want the kickoff note", call.stderr)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("onExit did not fire after the process exited")
		}
	})
}

func TestParseKickoffNote(t *testing.T) {
	for _, reason := range []string{"parked", "narrow", "gone", "timeout", "send-error"} {
		line := "kickoff: undelivered reason=" + reason + " prompt=\"/fab-operator\" dir=\"/home/u/proj\"\n"
		t.Run("reason "+reason, func(t *testing.T) {
			gotReason, gotPrompt, gotDir, ok := parseKickoffNote(line)
			if !ok || gotReason != reason || gotPrompt != "/fab-operator" || gotDir != "/home/u/proj" {
				t.Errorf("parseKickoffNote(%q) = %q, %q, %q, %v", line, gotReason, gotPrompt, gotDir, ok)
			}
		})
	}

	cases := []struct {
		name       string
		stderr     string
		wantReason string
		wantPrompt string
		wantDir    string
		wantOK     bool
	}{
		{
			name:       "extra fields after dir are tolerated",
			stderr:     "kickoff: undelivered reason=parked prompt=\"/fab-operator\" dir=\"/home/u/proj\" extra=1\n",
			wantReason: "parked",
			wantPrompt: "/fab-operator",
			wantDir:    "/home/u/proj",
			wantOK:     true,
		},
		{
			name:       "a prompt with spaces keeps dir intact",
			stderr:     "kickoff: undelivered reason=narrow prompt=\"run /fab-operator now\" dir=\"/home/u/proj\"\n",
			wantReason: "narrow",
			wantPrompt: "run /fab-operator now",
			wantDir:    "/home/u/proj",
			wantOK:     true,
		},
		{
			// The quoted framing is what makes spaces and a literal " dir="
			// inside the path safe — the two cases a space-delimited cut got
			// wrong.
			name:       "a dir with spaces and an embedded dir= survives whole",
			stderr:     "kickoff: undelivered reason=parked prompt=\"/fab-operator\" dir=\"/home/u/my project dir=x/repo\"\n",
			wantReason: "parked",
			wantPrompt: "/fab-operator",
			wantDir:    "/home/u/my project dir=x/repo",
			wantOK:     true,
		},
		{
			name:       "a provider-rendered prompt is carried verbatim",
			stderr:     "kickoff: undelivered reason=timeout prompt=\"$fab-operator\" dir=\"/home/u/proj\"\n",
			wantReason: "timeout",
			wantPrompt: "$fab-operator",
			wantDir:    "/home/u/proj",
			wantOK:     true,
		},
		{
			name:       "the note buried in multi-line stderr",
			stderr:     "spawning agent\nkickoff: undelivered reason=gone prompt=\"/fab-operator\" dir=\"/home/u/proj\"\nall done\n",
			wantReason: "gone",
			wantPrompt: "/fab-operator",
			wantDir:    "/home/u/proj",
			wantOK:     true,
		},
		{name: "no note", stderr: "agent up\nexit clean\n", wantOK: false},
		{name: "empty stderr", stderr: "", wantOK: false},
		{name: "missing prompt field", stderr: "kickoff: undelivered reason=parked dir=\"/home/u/proj\"\n", wantOK: false},
		{name: "missing dir field", stderr: "kickoff: undelivered reason=parked prompt=\"/fab-operator\"\n", wantOK: false},
		{name: "empty dir", stderr: "kickoff: undelivered reason=parked prompt=\"/fab-operator\" dir=\"\"\n", wantOK: false},
		{name: "unquoted legacy fields", stderr: "kickoff: undelivered reason=parked prompt=/fab-operator dir=/home/u/proj\n", wantOK: false},
		{name: "unterminated quote", stderr: "kickoff: undelivered reason=parked prompt=\"/fab-operator dir=\"/home/u/proj\"\n", wantOK: false},
		{name: "empty reason", stderr: "kickoff: undelivered reason= prompt=\"/fab-operator\" dir=\"/home/u/proj\"\n", wantOK: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotReason, gotPrompt, gotDir, ok := parseKickoffNote(tc.stderr)
			if ok != tc.wantOK || gotReason != tc.wantReason || gotPrompt != tc.wantPrompt || gotDir != tc.wantDir {
				t.Errorf("parseKickoffNote(%q) = %q, %q, %q, %v; want %q, %q, %q, %v",
					tc.stderr, gotReason, gotPrompt, gotDir, ok, tc.wantReason, tc.wantPrompt, tc.wantDir, tc.wantOK)
			}
		})
	}
}

// kickoffLogRecorder is a slog.Handler capturing records so the kickoff WARN
// (emitted via the package-level slog default) is assertable.
type kickoffLogRecorder struct {
	mu   sync.Mutex
	recs []capturedLogRecord
}

type capturedLogRecord struct {
	level slog.Level
	msg   string
	attrs map[string]string
}

func (h *kickoffLogRecorder) Enabled(context.Context, slog.Level) bool { return true }

func (h *kickoffLogRecorder) Handle(_ context.Context, r slog.Record) error {
	attrs := map[string]string{}
	r.Attrs(func(a slog.Attr) bool {
		attrs[a.Key] = a.Value.String()
		return true
	})
	h.mu.Lock()
	defer h.mu.Unlock()
	h.recs = append(h.recs, capturedLogRecord{level: r.Level, msg: r.Message, attrs: attrs})
	return nil
}

func (h *kickoffLogRecorder) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *kickoffLogRecorder) WithGroup(string) slog.Handler      { return h }

func (h *kickoffLogRecorder) kickoffWarns() []capturedLogRecord {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []capturedLogRecord
	for _, r := range h.recs {
		if r.msg == "operator kickoff undelivered" {
			out = append(out, r)
		}
	}
	return out
}

// installKickoffLogRecorder routes the package-level slog default through a
// recorder for the test's duration.
func installKickoffLogRecorder(t *testing.T) *kickoffLogRecorder {
	t.Helper()
	recorder := &kickoffLogRecorder{}
	prev := slog.Default()
	slog.SetDefault(slog.New(recorder))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return recorder
}

// newKickoffExitServer builds a Server with an SSE hub and one subscribed
// state client on "default", draining the bootstrap frames so only frames the
// callback drives remain. Mirrors newWakeSeamServer, minus the fetch tracker.
func newKickoffExitServer(t *testing.T) (*Server, *sseClient) {
	t.Helper()
	s := &Server{
		logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		sessions: &mockSessionFetcher{result: []sessions.ProjectSession{{Name: "s1"}}},
		tmux:     &mockTmuxOps{},
		hostname: "test-host",
	}
	s.initSSEHub()
	// A long safety interval so no timer-driven poll lands mid-assertion.
	s.sseHub.safetyInterval = 5 * time.Second
	client := s.sseHub.addTestClient(make(chan hubEvent, 16), "default")
	t.Cleanup(func() { s.sseHub.removeClient(client) })
	// Let the bootstrap poll pass complete before draining.
	time.Sleep(100 * time.Millisecond)
	drainConnEvents(client.ch)
	return s, client
}

func notifyPayloads(t *testing.T, ch chan hubEvent) []notifyPayload {
	t.Helper()
	var out []notifyPayload
	for _, frame := range decodeEnvelopes(drainFrames(ch)) {
		if rawStr(frame, "type") != "notify" || rawStr(frame, "kind") != kindGlobal {
			continue
		}
		var payload notifyPayload
		if err := json.Unmarshal(frame["data"], &payload); err != nil {
			t.Fatalf("decode notify payload: %v", err)
		}
		out = append(out, payload)
	}
	return out
}

func TestOperatorKickoffExit(t *testing.T) {
	t.Run("a kickoff note warns once and broadcasts one tagged notify", func(t *testing.T) {
		recorder := installKickoffLogRecorder(t)
		s, client := newKickoffExitServer(t)

		s.operatorKickoffExit("default")(
			operatorStartReceipt{Window: "@7", Server: "default", Created: true, Dir: "/home/u/proj"},
			"agent up\nkickoff: undelivered reason=parked prompt=\"$fab-operator\" dir=\"/home/u/proj\"\n",
			nil,
		)

		warns := recorder.kickoffWarns()
		if len(warns) != 1 {
			t.Fatalf("kickoff WARN count = %d, want exactly 1", len(warns))
		}
		if warns[0].level != slog.LevelWarn {
			t.Errorf("level = %v, want WARN", warns[0].level)
		}
		for k, v := range map[string]string{"server": "default", "window": "@7", "reason": "parked", "dir": "/home/u/proj"} {
			if warns[0].attrs[k] != v {
				t.Errorf("attr %q = %q, want %q", k, warns[0].attrs[k], v)
			}
		}

		got := notifyPayloads(t, client.ch)
		if len(got) != 1 {
			t.Fatalf("notify frames = %d, want exactly 1", len(got))
		}
		if got[0].Tag != "operator-kickoff" {
			t.Errorf("tag = %q, want operator-kickoff", got[0].Tag)
		}
		if got[0].Title != "Operator kickoff not delivered" {
			t.Errorf("title = %q", got[0].Title)
		}
		// The body names the provider-rendered prompt from the note (a codex
		// operator's `$fab-operator`), never a hardcoded slash form.
		for _, want := range []string{"default", "/home/u/proj", "parked", "$fab-operator"} {
			if !strings.Contains(got[0].Body, want) {
				t.Errorf("body = %q, want it to carry %q", got[0].Body, want)
			}
		}
		if strings.Contains(got[0].Body, "/fab-operator") {
			t.Errorf("body = %q, must not hardcode the slash-form kickoff", got[0].Body)
		}
		if got[0].URL != "/default/7" {
			t.Errorf("url = %q, want /default/7 (the operator window's Terminal route)", got[0].URL)
		}
	})

	t.Run("a clean exit without the note stays silent", func(t *testing.T) {
		recorder := installKickoffLogRecorder(t)
		s, client := newKickoffExitServer(t)

		s.operatorKickoffExit("default")(
			operatorStartReceipt{Window: "@7", Server: "default", Created: true},
			"agent up\nall good\n",
			nil,
		)

		if warns := recorder.kickoffWarns(); len(warns) != 0 {
			t.Errorf("kickoff WARN count = %d, want 0", len(warns))
		}
		if got := notifyPayloads(t, client.ch); len(got) != 0 {
			t.Errorf("notify frames = %d, want 0", len(got))
		}
	})
}

func TestOperatorStartReceiptParsesKickoffFields(t *testing.T) {
	receipt, complete, ok := parseOperatorStartEnvelope([]byte(
		"{\n  \"ok\": true,\n  \"result\": {\n    \"window\": \"@7\",\n    \"server\": \"default\",\n    \"created\": true,\n    \"dir\": \"/home/u/proj\",\n    \"dir_rung\": \"stored\"\n  }\n}"))
	if !complete || !ok {
		t.Fatalf("complete, ok = %v, %v, want true, true", complete, ok)
	}
	if receipt.Dir != "/home/u/proj" || receipt.DirRung != "stored" {
		t.Errorf("receipt = %+v, want dir and dir_rung parsed", receipt)
	}
}
