package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/codebridge"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// --- seams + fixtures ---

// fakeCodeHost is an in-test code-bridge host: a Unix-socket NDJSON server
// (one request per connection, like the extension) plus a host record under a
// temp XDG_STATE_HOME. __ping and __commands are served from the struct
// fields; any other command goes to respond (default: ok with a null result).
type fakeCodeHost struct {
	hostID   string
	folder   string
	sock     string
	commands []string
	respond  func(req codebridge.Request) codebridge.Response

	ln   net.Listener
	mu   sync.Mutex
	reqs []codebridge.Request
}

// startFakeCodeHost serves a fake bridge host and writes its host record. The
// record's pid is the test process (always kill-0 alive), so LiveHosts gates
// only on the socket ping.
func startFakeCodeHost(t *testing.T, stateHome, hostID, folder, extVersion, startedAt string) *fakeCodeHost {
	t.Helper()
	return startFakeCodeHostRecord(t, stateHome, codebridge.HostRecord{
		HostID:     hostID,
		Folder:     folder,
		ExtVersion: extVersion,
		StartedAt:  startedAt,
	})
}

// startFakeCodeHostRecord is startFakeCodeHost with the full record, so tests
// can register hosts carrying a tab identity.
func startFakeCodeHostRecord(t *testing.T, stateHome string, rec codebridge.HostRecord) *fakeCodeHost {
	t.Helper()
	cbDir := filepath.Join(stateHome, "hexokit", "cb")
	if err := os.MkdirAll(filepath.Join(cbDir, "hosts"), 0o700); err != nil {
		t.Fatal(err)
	}
	h := &fakeCodeHost{hostID: rec.HostID, folder: rec.Folder, sock: filepath.Join(cbDir, rec.HostID+".sock")}
	ln, err := net.Listen("unix", h.sock)
	if err != nil {
		t.Fatalf("listen %s: %v", h.sock, err)
	}
	h.ln = ln
	go h.serve()
	t.Cleanup(func() { _ = ln.Close() })

	rec.PID = os.Getpid()
	rec.Sock = h.sock
	data, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cbDir, "hosts", rec.HostID+".json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *fakeCodeHost) serve() {
	for {
		conn, err := h.ln.Accept()
		if err != nil {
			return
		}
		go h.handle(conn)
	}
}

func (h *fakeCodeHost) handle(conn net.Conn) {
	defer conn.Close()
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return
	}
	var req codebridge.Request
	if err := json.Unmarshal(line, &req); err != nil {
		return
	}
	h.mu.Lock()
	h.reqs = append(h.reqs, req)
	h.mu.Unlock()

	resp := codebridge.Response{ID: req.ID, OK: true, Ms: 1}
	switch req.Command {
	case "__ping":
		resp.Result = json.RawMessage(fmt.Sprintf(`{"folder":%q,"pid":%d,"version":"test"}`, h.folder, os.Getpid()))
	case "__commands":
		ids := h.commands
		if ids == nil {
			ids = []string{}
		}
		b, _ := json.Marshal(ids)
		resp.Result = b
	default:
		if h.respond != nil {
			resp = h.respond(req)
			resp.ID = req.ID
		} else {
			resp.Result = json.RawMessage("null")
		}
	}
	b, _ := json.Marshal(resp)
	_, _ = conn.Write(append(b, '\n'))
}

// commandRequest returns the first recorded request for command (skipping the
// __ping liveness probes).
func (h *fakeCodeHost) commandRequest(command string) (codebridge.Request, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.reqs {
		if r.Command == command {
			return r, true
		}
	}
	return codebridge.Request{}, false
}

// installCodeBridgeEnv points the code-bridge state dir at a temp
// XDG_STATE_HOME and returns it.
func installCodeBridgeEnv(t *testing.T) string {
	t.Helper()
	stateHome := t.TempDir()
	t.Setenv("XDG_STATE_HOME", stateHome)
	return stateHome
}

// withCodeTargetFolder pins the default-folder resolution (the git-toplevel
// seam) so tests never depend on the repo the test binary runs in.
func withCodeTargetFolder(t *testing.T, folder string) {
	t.Helper()
	orig := codeTargetFolderFn
	t.Cleanup(func() { codeTargetFolderFn = orig })
	codeTargetFolderFn = func(context.Context) (string, error) { return folder, nil }
}

// withCodeEmbedded pins the bundled-version seam; ok=false models a dev build
// with an empty embed dir.
func withCodeEmbedded(t *testing.T, version string, ok bool) {
	t.Helper()
	orig := codeEmbeddedFn
	t.Cleanup(func() { codeEmbeddedFn = orig })
	codeEmbeddedFn = func() ([]byte, string, bool) { return []byte("vsix"), version, ok }
}

// runCodeCmd drives `rk code <args...>` through the real cobra Execute() seam
// (the present_test.go runPresentCmd pattern) so arg/flag validation and exit
// classification run exactly as in production. The code children's flags and
// the root persistent --quiet are reset before and after so no state bleeds.
func runCodeCmd(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	resetRootFlagState(t)
	resetCodeFlagState(t)
	var stdout, stderr bytes.Buffer
	rootCmd.SetOut(&stdout)
	rootCmd.SetErr(&stderr)
	rootCmd.SetArgs(append([]string{"code"}, args...))
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	err := rootCmd.Execute()
	return stdout.String(), stderr.String(), err
}

func resetCodeFlagState(t *testing.T) {
	t.Helper()
	reset := func() {
		for _, c := range []*cobra.Command{codeExecCmd, codeHostsCmd, codeCommandsCmd} {
			c.Flags().VisitAll(func(f *pflag.Flag) {
				_ = f.Value.Set(f.DefValue)
				f.Changed = false
			})
			c.SilenceErrors = false
		}
		codeExecFolderFlag, codeExecHostFlag, codeExecTabFlag = "", "", ""
		codeExecAllFlag, codeExecJSONFlag = false, false
		codeExecTimeoutFlag = codeDefaultTimeout
		codeHostsJSONFlag = false
		codeCmdsFolderFlag, codeCmdsHostFlag, codeCmdsTabFlag = "", "", ""
		if f := rootCmd.PersistentFlags().Lookup("quiet"); f != nil {
			_ = f.Value.Set("false")
			f.Changed = false
		}
		quiet = false
	}
	reset()
	t.Cleanup(reset)
}

func codeStartedAgo(d time.Duration) string {
	return time.Now().Add(-d).UTC().Format(time.RFC3339)
}

// --- exec ---

func TestCodeExecPrintsResultJSON(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	h := startFakeCodeHost(t, stateHome, "h1", "/repo", "3.19.0", codeStartedAgo(time.Minute))
	h.respond = func(codebridge.Request) codebridge.Response {
		return codebridge.Response{OK: true, Result: json.RawMessage(`{"opened":true}`), Ms: 7}
	}
	withCodeTargetFolder(t, "/repo")
	// A built VSIX in build/codebridge (post-`just build`) would fire the skew
	// note against the fake host's pinned extension version.
	withCodeEmbedded(t, "", false)

	stdout, stderr, err := runCodeCmd(t, "exec", "workbench.open", "2908")
	if err != nil {
		t.Fatalf("exec error: %v (stderr: %s)", err, stderr)
	}
	if want := "{\"opened\":true}\n"; stdout != want {
		t.Errorf("stdout = %q, want exactly the result JSON %q", stdout, want)
	}
	if stderr != "" {
		t.Errorf("stderr = %q, want empty (exact folder match: no notes)", stderr)
	}

	req, ok := h.commandRequest("workbench.open")
	if !ok {
		t.Fatal("host never received the workbench.open request")
	}
	if req.ID == "" {
		t.Error("request id is empty, want a fresh random id")
	}
	if len(req.Args) != 1 || string(req.Args[0]) != "2908" {
		t.Errorf("args = %s, want [2908] (a number, not a string)", rawArgs(req.Args))
	}
	if req.TimeoutMs != 30000 {
		t.Errorf("timeoutMs = %d, want 30000 (the 30s default)", req.TimeoutMs)
	}
}

func TestCodeExecNullResultPrintsNull(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "h1", "/repo", "3.19.0", codeStartedAgo(time.Minute))
	withCodeTargetFolder(t, "/repo")

	stdout, _, err := runCodeCmd(t, "exec", "some.voidCommand")
	if err != nil {
		t.Fatalf("exec error: %v", err)
	}
	if stdout != "null\n" {
		t.Errorf("stdout = %q, want %q for a null result", stdout, "null\n")
	}
}

func TestCodeExecJSONEnvelope(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	h := startFakeCodeHost(t, stateHome, "h1", "/repo", "3.19.0", codeStartedAgo(time.Minute))
	h.respond = func(codebridge.Request) codebridge.Response {
		return codebridge.Response{OK: true, Result: json.RawMessage(`{"opened":true}`), Ms: 7}
	}
	withCodeTargetFolder(t, "/repo")

	stdout, _, err := runCodeCmd(t, "exec", "workbench.open", "--json")
	if err != nil {
		t.Fatalf("exec --json error: %v, want exit 0", err)
	}
	// The bridge Response nests verbatim under the rk envelope's result (R9):
	// the outer ok is rk's, the inner the bridge's.
	var resp codebridge.Response
	unwrapEnvelopeResult(t, stdout, &resp)
	var opened struct {
		Opened bool `json:"opened"`
	}
	if jerr := json.Unmarshal(resp.Result, &opened); jerr != nil || !opened.Opened {
		t.Errorf("result = %s, want {\"opened\":true}", resp.Result)
	}
	if !resp.OK || resp.Ms != 7 || resp.ID == "" {
		t.Errorf("response = %+v, want ok:true ms:7 with a fresh id", resp)
	}
}

func TestCodeExecArgSugar(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	h := startFakeCodeHost(t, stateHome, "h1", "/repo", "3.19.0", codeStartedAgo(time.Minute))
	withCodeTargetFolder(t, "/repo")

	// A literal -- ends flag parsing, so dash-prefixed tokens pass as args.
	_, _, err := runCodeCmd(t, "exec", "vscode.open", `{"$uri":"file:///tmp/a.ts"}`, "plain", "--", "-5", "-x")
	if err != nil {
		t.Fatalf("exec error: %v", err)
	}
	req, ok := h.commandRequest("vscode.open")
	if !ok {
		t.Fatal("host never received the vscode.open request")
	}
	want := []string{`{"$uri":"file:///tmp/a.ts"}`, `"plain"`, `-5`, `"-x"`}
	if len(req.Args) != len(want) {
		t.Fatalf("args = %s, want %d entries", rawArgs(req.Args), len(want))
	}
	for i, w := range want {
		if string(req.Args[i]) != w {
			t.Errorf("args[%d] = %s, want %s", i, req.Args[i], w)
		}
	}
}

func TestCodeExecTimeoutFlag(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	h := startFakeCodeHost(t, stateHome, "h1", "/repo", "3.19.0", codeStartedAgo(time.Minute))
	withCodeTargetFolder(t, "/repo")

	if _, _, err := runCodeCmd(t, "exec", "some.cmd", "--timeout", "5s"); err != nil {
		t.Fatalf("exec error: %v", err)
	}
	req, ok := h.commandRequest("some.cmd")
	if !ok {
		t.Fatal("host never received the request")
	}
	if req.TimeoutMs != 5000 {
		t.Errorf("timeoutMs = %d, want 5000 from --timeout 5s", req.TimeoutMs)
	}
}

func TestCodeExecUsageErrorsExitTwo(t *testing.T) {
	installCodeBridgeEnv(t)
	cases := []struct {
		name string
		args []string
	}{
		{"missing command", []string{"exec"}},
		{"--host with --folder", []string{"exec", "x", "--host", "h1", "--folder", "/f"}},
		{"unknown flag", []string{"exec", "x", "--bogus"}},
		{"hosts arg-count violation", []string{"hosts", "x"}},
		{"commands arg-count violation", []string{"commands", "x"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := runCodeCmd(t, tc.args...)
			if err == nil || exitCode(err) != exitUsage {
				t.Errorf("rk code %v: err = %v (code %d), want usage exit 2", tc.args, err, exitCode(err))
			}
		})
	}
}

func TestCodeExecUnknownCommandSuggests(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	h := startFakeCodeHost(t, stateHome, "h1", "/repo", "3.19.0", codeStartedAgo(time.Minute))
	h.commands = []string{"pr.refreshList", "pr.checkout", "workbench.action.files.openFile"}
	h.respond = func(codebridge.Request) codebridge.Response {
		return codebridge.Response{OK: false, Error: &codebridge.BridgeError{
			Kind:    codebridge.ErrKindUnknownCommand,
			Message: "command 'pr.refreshLis' not found",
		}}
	}
	withCodeTargetFolder(t, "/repo")

	stdout, stderr, err := runCodeCmd(t, "exec", "pr.refreshLis")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v (code %d), want operational exit 1", err, exitCode(err))
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty on failure", stdout)
	}
	errLine := "error: unknown-command: command 'pr.refreshLis' not found"
	if !strings.Contains(stderr, errLine) {
		t.Errorf("stderr = %q, want it to contain %q", stderr, errLine)
	}
	if !strings.Contains(stderr, "did you mean:") {
		t.Errorf("stderr = %q, want a did-you-mean list", stderr)
	}
	if !strings.Contains(stderr, "pr.refreshList") {
		t.Errorf("stderr = %q, want the closest match pr.refreshList", stderr)
	}
	if strings.Index(stderr, errLine) > strings.Index(stderr, "did you mean:") {
		t.Errorf("stderr = %q, want the error line before the did-you-mean list", stderr)
	}
}

func TestCodeExecNoHostHint(t *testing.T) {
	installCodeBridgeEnv(t)
	withCodeTargetFolder(t, "/nope")

	stdout, stderr, err := runCodeCmd(t, "exec", "some.cmd")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v (code %d), want operational exit 1", err, exitCode(err))
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty on failure", stdout)
	}
	want := "error: no code-bridge host — open the code lens on /nope (or check `rk doctor`)"
	if !strings.Contains(stderr, want) {
		t.Errorf("stderr = %q, want it to contain %q", stderr, want)
	}
}

func TestCodeExecAmbiguousHostsListThem(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "aa01", "/a", "3.19.0", codeStartedAgo(time.Minute))
	startFakeCodeHost(t, stateHome, "bb02", "/b", "3.19.0", codeStartedAgo(time.Minute))
	withCodeTargetFolder(t, "/elsewhere")

	_, stderr, err := runCodeCmd(t, "exec", "some.cmd")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v (code %d), want operational exit 1", err, exitCode(err))
	}
	for _, want := range []string{"aa01  /a", "bb02  /b"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr = %q, want it to list %q", stderr, want)
		}
	}
}

func TestCodeExecSingleHostFallbackNote(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "h1", "/repo", "3.19.0", codeStartedAgo(time.Minute))
	withCodeTargetFolder(t, "/elsewhere")

	stdout, stderr, err := runCodeCmd(t, "exec", "some.cmd")
	if err != nil {
		t.Fatalf("exec error: %v (stderr: %s)", err, stderr)
	}
	if stdout != "null\n" {
		t.Errorf("stdout = %q, want the result", stdout)
	}
	if !strings.Contains(stderr, "using host h1 (/repo)") {
		t.Errorf("stderr = %q, want the using-host note", stderr)
	}
}

func TestCodeExecVersionSkewWarning(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "h1", "/repo", "3.18.0", codeStartedAgo(time.Minute))
	withCodeTargetFolder(t, "/repo")

	withCodeEmbedded(t, "3.19.0", true)
	_, stderr, err := runCodeCmd(t, "exec", "some.cmd")
	if err != nil {
		t.Fatalf("exec error: %v", err)
	}
	want := "code bridge extension v3.18.0 is older than the bundled v3.19.0 — run rk code-server update"
	if !strings.Contains(stderr, want) {
		t.Errorf("stderr = %q, want the skew warning %q", stderr, want)
	}

	// Equal versions are not "older" — no warning.
	withCodeEmbedded(t, "3.18.0", true)
	_, stderr, err = runCodeCmd(t, "exec", "some.cmd")
	if err != nil {
		t.Fatalf("exec error: %v", err)
	}
	if strings.Contains(stderr, "is older than the bundled") {
		t.Errorf("stderr = %q, want no skew warning for equal versions", stderr)
	}

	// A dev build without an embedded VSIX skips silently.
	withCodeEmbedded(t, "", false)
	_, stderr, err = runCodeCmd(t, "exec", "some.cmd")
	if err != nil {
		t.Fatalf("exec error: %v", err)
	}
	if strings.Contains(stderr, "is older than the bundled") {
		t.Errorf("stderr = %q, want no skew warning when nothing is bundled", stderr)
	}
}

// --- exec --all ---

func TestCodeExecAllFanOut(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	a := startFakeCodeHost(t, stateHome, "aa01", "/a", "3.19.0", codeStartedAgo(time.Minute))
	a.respond = func(codebridge.Request) codebridge.Response {
		return codebridge.Response{OK: true, Result: json.RawMessage(`{"host":"a"}`), Ms: 1}
	}
	b := startFakeCodeHost(t, stateHome, "bb02", "/b", "3.19.0", codeStartedAgo(time.Minute))
	b.respond = func(codebridge.Request) codebridge.Response {
		return codebridge.Response{OK: true, Result: json.RawMessage(`{"host":"b"}`), Ms: 1}
	}
	withCodeTargetFolder(t, "/elsewhere") // --all ignores folder resolution

	stdout, _, err := runCodeCmd(t, "exec", "--all", "some.cmd")
	if err != nil {
		t.Fatalf("exec --all error: %v", err)
	}
	want := "aa01\t{\"host\":\"a\"}\nbb02\t{\"host\":\"b\"}\n"
	if stdout != want {
		t.Errorf("stdout = %q, want %q (hostId TAB result rows, sorted by host id)", stdout, want)
	}
}

func TestCodeExecAllJSON(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "aa01", "/a", "3.19.0", codeStartedAgo(time.Minute))
	startFakeCodeHost(t, stateHome, "bb02", "/b", "3.19.0", codeStartedAgo(time.Minute))
	withCodeTargetFolder(t, "/elsewhere")

	stdout, _, err := runCodeCmd(t, "exec", "--all", "--json", "some.cmd")
	if err != nil {
		t.Fatalf("exec --all --json error: %v, want exit 0", err)
	}
	var results []codeAllResult
	unwrapEnvelopeResult(t, stdout, &results)
	if len(results) != 2 {
		t.Fatalf("results = %d entries, want 2", len(results))
	}
	for i, want := range []struct{ id, folder string }{{"aa01", "/a"}, {"bb02", "/b"}} {
		if results[i].HostID != want.id || results[i].Folder != want.folder {
			t.Errorf("results[%d] = {%s %s}, want {%s %s}", i, results[i].HostID, results[i].Folder, want.id, want.folder)
		}
		if !results[i].Response.OK {
			t.Errorf("results[%d].response.ok = false, want true", i)
		}
	}
}

func TestCodeExecAllPartialFailureExitsOne(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	a := startFakeCodeHost(t, stateHome, "aa01", "/a", "3.19.0", codeStartedAgo(time.Minute))
	a.respond = func(codebridge.Request) codebridge.Response {
		return codebridge.Response{OK: true, Result: json.RawMessage(`{"host":"a"}`), Ms: 1}
	}
	b := startFakeCodeHost(t, stateHome, "bb02", "/b", "3.19.0", codeStartedAgo(time.Minute))
	b.respond = func(codebridge.Request) codebridge.Response {
		return codebridge.Response{OK: false, Error: &codebridge.BridgeError{Kind: codebridge.ErrKindThrew, Message: "boom"}}
	}
	withCodeTargetFolder(t, "/elsewhere")

	stdout, stderr, err := runCodeCmd(t, "exec", "--all", "some.cmd")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v (code %d), want exit 1 when any host errors", err, exitCode(err))
	}
	if want := "aa01\t{\"host\":\"a\"}\n"; stdout != want {
		t.Errorf("stdout = %q, want only the successful host's row %q", stdout, want)
	}
	if !strings.Contains(stderr, "error: bb02: threw: boom") {
		t.Errorf("stderr = %q, want the failing host's error line", stderr)
	}

	// --json still carries one entry per live host under result, the failure as
	// a not-ok bridge envelope; the outer envelope is ok:false with the verdict.
	stdout, _, err = runCodeCmd(t, "exec", "--all", "--json", "some.cmd")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("--json: err = %v (code %d), want exit 1", err, exitCode(err))
	}
	var env struct {
		OK     bool            `json:"ok"`
		Result []codeAllResult `json:"result"`
		Error  *envelopeError  `json:"error"`
	}
	if jerr := json.Unmarshal([]byte(stdout), &env); jerr != nil {
		t.Fatalf("--all --json stdout: %v (%q)", jerr, stdout)
	}
	if env.OK {
		t.Errorf("ok = true, want false when a host failed (stdout %s)", stdout)
	}
	if env.Error == nil || env.Error.Message != "at least one host failed" {
		t.Errorf("error = %+v, want the %q verdict beside result", env.Error, "at least one host failed")
	}
	results := env.Result
	if len(results) != 2 || results[1].Response.OK || results[1].Response.Error == nil ||
		results[1].Response.Error.Kind != codebridge.ErrKindThrew {
		t.Errorf("results = %+v, want the failing host as a not-ok threw envelope", results)
	}
}

// --- hosts ---

func TestCodeHostsTable(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "aa01", "/repo", "3.19.0", codeStartedAgo(3*time.Minute))
	startFakeCodeHost(t, stateHome, "bb02", "/other", "3.18.0", codeStartedAgo(3*time.Minute))

	stdout, stderr, err := runCodeCmd(t, "hosts")
	if err != nil {
		t.Fatalf("hosts error: %v", err)
	}
	if stderr != "" {
		t.Errorf("stderr = %q, want empty (no prunes)", stderr)
	}
	for _, want := range []string{"ID", "FOLDER", "PID", "AGE", "EXT", "aa01", "/repo", "bb02", "/other", "3m", "3.19.0"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout = %q, want it to contain %q", stdout, want)
		}
	}

	// --quiet parity: data rows survive; only chatter would be dropped.
	quietStdout, _, err := runCodeCmd(t, "hosts", "--quiet")
	if err != nil {
		t.Fatalf("hosts --quiet error: %v", err)
	}
	if quietStdout != stdout {
		t.Errorf("--quiet stdout = %q, want the same rows as %q", quietStdout, stdout)
	}
}

func TestCodeHostsJSON(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "aa01", "/repo", "3.19.0", codeStartedAgo(time.Minute))
	startFakeCodeHost(t, stateHome, "bb02", "/other", "3.18.0", codeStartedAgo(time.Minute))

	stdout, _, err := runCodeCmd(t, "hosts", "--json")
	if err != nil {
		t.Fatalf("hosts --json error: %v, want exit 0", err)
	}
	var records []codebridge.HostRecord
	unwrapEnvelopeResult(t, stdout, &records)
	if len(records) != 2 || records[0].HostID != "aa01" || records[1].HostID != "bb02" {
		t.Errorf("records = %+v, want aa01 and bb02 sorted by host id", records)
	}
}

func TestCodeHostsEmpty(t *testing.T) {
	installCodeBridgeEnv(t)

	stdout, _, err := runCodeCmd(t, "hosts")
	if err != nil {
		t.Fatalf("hosts error: %v", err)
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want nothing for zero hosts", stdout)
	}

	stdout, _, err = runCodeCmd(t, "hosts", "--json")
	if err != nil {
		t.Fatalf("hosts --json error: %v, want exit 0", err)
	}
	if want := "{\n  \"ok\": true,\n  \"result\": []\n}\n"; stdout != want {
		t.Errorf("stdout = %q, want %q for zero hosts under --json", stdout, want)
	}
}

// --- commands ---

func TestCodeCommandsSorted(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	h := startFakeCodeHost(t, stateHome, "h1", "/repo", "3.19.0", codeStartedAgo(time.Minute))
	h.commands = []string{"workbench.open", "pr.checkout", "git.fetch"}
	withCodeTargetFolder(t, "/repo")

	stdout, _, err := runCodeCmd(t, "commands")
	if err != nil {
		t.Fatalf("commands error: %v", err)
	}
	if want := "git.fetch\npr.checkout\nworkbench.open\n"; stdout != want {
		t.Errorf("stdout = %q, want sorted ids %q", stdout, want)
	}
}

func TestCodeCommandsByHostFlag(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "aa01", "/a", "3.19.0", codeStartedAgo(time.Minute))
	b := startFakeCodeHost(t, stateHome, "bb02", "/b", "3.19.0", codeStartedAgo(time.Minute))
	b.commands = []string{"only.on.b"}
	withCodeTargetFolder(t, "/a")

	stdout, _, err := runCodeCmd(t, "commands", "--host", "bb02")
	if err != nil {
		t.Fatalf("commands --host error: %v", err)
	}
	if stdout != "only.on.b\n" {
		t.Errorf("stdout = %q, want the --host-targeted command list", stdout)
	}
}

// rawArgs renders request args for test failure messages.
func rawArgs(args []json.RawMessage) string {
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = string(a)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// --- --tab ---

// withCodeTabSeams pins the --tab arm's tmux reads: the own-tab resolver and
// the @rk_win_code_root read. windowID is what the address resolves to;
// codeRoot is the option's value.
func withCodeTabSeams(t *testing.T, windowID, server, codeRoot string) {
	t.Helper()
	origTMUX := ownTabOriginalTMUXFn
	origRun := ownTabRunOutputFn
	origGet := codeGetWindowOptionFn
	ownTabOriginalTMUXFn = func() string { return "/tmp/tmux-1000/dev,123,0" }
	ownTabRunOutputFn = func(_ context.Context, args []string) ([]byte, error) {
		joined := strings.Join(args, " ")
		if strings.Contains(joined, "#{window_id}") {
			return []byte(windowID + "\n"), nil
		}
		return nil, fmt.Errorf("unexpected tmux read: %s", joined)
	}
	codeGetWindowOptionFn = func(_ context.Context, _, _, option string) (string, error) {
		if option != "@rk_win_code_root" {
			return "", fmt.Errorf("unexpected option read: %s", option)
		}
		return codeRoot, nil
	}
	t.Cleanup(func() {
		ownTabOriginalTMUXFn = origTMUX
		ownTabRunOutputFn = origRun
		codeGetWindowOptionFn = origGet
	})
	_ = server
}

func TestCodeExecTabCodeRootWinsOverCwd(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "aa01", "/w/proj", "3.19.0", codeStartedAgo(time.Minute))
	other := startFakeCodeHost(t, stateHome, "bb02", "/elsewhere", "3.19.0", codeStartedAgo(time.Minute))
	other.commands = []string{"x.other"}
	withCodeTargetFolder(t, "/elsewhere")
	withCodeTabSeams(t, "@9", "dev", "/w/proj")
	t.Setenv("TMUX_PANE", "%3")

	stdout, _, err := runCodeCmd(t, "exec", "--tab", "@9", "x.y")
	if err != nil {
		t.Fatalf("exec --tab: %v", err)
	}
	if stdout != "null\n" {
		t.Errorf("stdout = %q", stdout)
	}
	// The /w/proj host answered (its fake recorded the command).
	if _, ok := other.commandRequest("x.y"); ok {
		t.Errorf("the cwd host answered; want the @rk_win_code_root host")
	}
}

// --tab =session:window rides the same resolver as the rk tab family: the
// target reaches tmux verbatim as one display-message read (no tabaddr parse).
func TestCodeExecTabSessionWindowTarget(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "aa01", "/w/proj", "3.19.0", codeStartedAgo(time.Minute))
	withCodeTargetFolder(t, "/elsewhere")
	withCodeTabSeams(t, "@9", "dev", "/w/proj")
	inner := ownTabRunOutputFn
	var targets []string
	ownTabRunOutputFn = func(ctx context.Context, args []string) ([]byte, error) {
		for i, a := range args {
			if a == "-pt" && i+1 < len(args) {
				targets = append(targets, args[i+1])
			}
		}
		return inner(ctx, args)
	}
	t.Setenv("TMUX_PANE", "%3")

	stdout, _, err := runCodeCmd(t, "exec", "--tab==boot:0", "x.y")
	if err != nil {
		t.Fatalf("exec --tab =boot:0: %v", err)
	}
	if stdout != "null\n" {
		t.Errorf("stdout = %q", stdout)
	}
	if len(targets) != 1 || targets[0] != "=boot:0" {
		t.Errorf("display-message targets = %v, want [=boot:0]", targets)
	}
}

func TestCodeExecTabEmptyRootFallsThrough(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "aa01", "/elsewhere", "3.19.0", codeStartedAgo(time.Minute))
	withCodeTargetFolder(t, "/elsewhere")
	withCodeTabSeams(t, "@9", "dev", "")
	t.Setenv("TMUX_PANE", "%3")

	_, stderr, err := runCodeCmd(t, "exec", "--tab=@9", "x.y")
	if err != nil {
		t.Fatalf("exec --tab with an empty root: %v", err)
	}
	if !strings.Contains(stderr, "tab @9 has no @rk_win_code_root") {
		t.Errorf("stderr = %q, want the fall-through note", stderr)
	}
}

func TestCodeExecTabHostConflictExitsTwo(t *testing.T) {
	installCodeBridgeEnv(t)
	if _, _, err := runCodeCmd(t, "exec", "--tab", "--host", "aa01", "x.y"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("--tab --host: err = %v (code %d), want exit 2", err, exitCode(err))
	}
	if _, _, err := runCodeCmd(t, "exec", "--tab=@9", "--folder", "/x", "x.y"); err == nil || exitCode(err) != exitUsage {
		t.Errorf("--tab --folder: err = %v (code %d), want exit 2", err, exitCode(err))
	}
}

func TestCodeExecTabOutsideTmuxExitsOne(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHost(t, stateHome, "aa01", "/x", "3.19.0", codeStartedAgo(time.Minute))
	withCodeTargetFolder(t, "/x")
	withCodeTabSeams(t, "@9", "dev", "/x")
	t.Setenv("TMUX_PANE", "")

	_, _, err := runCodeCmd(t, "exec", "--tab", "x.y")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v (code %d), want exit 1", err, exitCode(err))
	}
}

func TestCodeCommandsTabArm(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	h := startFakeCodeHost(t, stateHome, "aa01", "/w/proj", "3.19.0", codeStartedAgo(time.Minute))
	h.commands = []string{"only.on.proj"}
	startFakeCodeHost(t, stateHome, "bb02", "/elsewhere", "3.19.0", codeStartedAgo(time.Minute))
	withCodeTargetFolder(t, "/elsewhere")
	withCodeTabSeams(t, "@9", "dev", "/w/proj")
	t.Setenv("TMUX_PANE", "%3")

	stdout, _, err := runCodeCmd(t, "commands", "--tab=@9")
	if err != nil {
		t.Fatalf("commands --tab: %v", err)
	}
	if stdout != "only.on.proj\n" {
		t.Errorf("stdout = %q, want the code-root host's commands", stdout)
	}
}

// --- tab identity ---

// Two hosts on one folder (two tabs on one worktree), caller's pane in @5:
// the no-flag default resolves the caller's own tab and picks the @5 host
// directly — no folder ambiguity, no using-host note.
func TestCodeExecOwnTabDefaultPicksCallerTab(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	aa := startFakeCodeHostRecord(t, stateHome, codebridge.HostRecord{
		HostID: "aa01", Folder: "/wt", Tab: "@3", Server: "dev",
		ExtVersion: "3.19.0", StartedAt: codeStartedAgo(time.Minute),
	})
	bb := startFakeCodeHostRecord(t, stateHome, codebridge.HostRecord{
		HostID: "bb02", Folder: "/wt", Tab: "@5", Server: "dev",
		ExtVersion: "3.19.0", StartedAt: codeStartedAgo(time.Minute),
	})
	withCodeTargetFolder(t, "/wt")
	withCodeTabSeams(t, "@5", "dev", "")
	t.Setenv("TMUX_PANE", "%3")

	stdout, stderr, err := runCodeCmd(t, "exec", "x.y")
	if err != nil {
		t.Fatalf("exec error: %v (stderr: %s)", err, stderr)
	}
	if stdout != "null\n" {
		t.Errorf("stdout = %q, want the result", stdout)
	}
	if _, ok := bb.commandRequest("x.y"); !ok {
		t.Error("the @5 host never received the command; want the caller's own tab picked")
	}
	if _, ok := aa.commandRequest("x.y"); ok {
		t.Error("the @3 host answered; want the caller's @5 host")
	}
	if strings.Contains(stderr, "using host") {
		t.Errorf("stderr = %q, want no using-host note (tab-direct is not the fallback)", stderr)
	}
}

// The same two hosts from outside tmux with an explicit --folder: no tab hit,
// two exact folder matches — ambiguous, and the listing carries each tab.
func TestCodeExecFolderSameFolderHostsAmbiguousListsTabs(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHostRecord(t, stateHome, codebridge.HostRecord{
		HostID: "aa01", Folder: "/wt", Tab: "@3", Server: "dev",
		ExtVersion: "3.19.0", StartedAt: codeStartedAgo(time.Minute),
	})
	startFakeCodeHostRecord(t, stateHome, codebridge.HostRecord{
		HostID: "bb02", Folder: "/wt", Tab: "@5", Server: "dev",
		ExtVersion: "3.19.0", StartedAt: codeStartedAgo(time.Minute),
	})
	t.Setenv("TMUX_PANE", "")

	_, stderr, err := runCodeCmd(t, "exec", "__ping", "--folder", "/wt")
	if err == nil || exitCode(err) != 1 {
		t.Fatalf("err = %v (code %d), want operational exit 1", err, exitCode(err))
	}
	for _, want := range []string{"aa01  /wt  @3", "bb02  /wt  @5"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr = %q, want it to list %q", stderr, want)
		}
	}
}

// An explicit --folder skips the own-tab step: the caller's pane is in @5 and
// a host carries that tab on /other, yet --folder /wt must select the /wt
// host, not the tab's.
func TestCodeExecFolderFlagSkipsOwnTab(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	aa := startFakeCodeHost(t, stateHome, "aa01", "/wt", "3.19.0", codeStartedAgo(time.Minute))
	bb := startFakeCodeHostRecord(t, stateHome, codebridge.HostRecord{
		HostID: "bb02", Folder: "/other", Tab: "@5", Server: "dev",
		ExtVersion: "3.19.0", StartedAt: codeStartedAgo(time.Minute),
	})
	withCodeTabSeams(t, "@5", "dev", "")
	t.Setenv("TMUX_PANE", "%3")

	_, _, err := runCodeCmd(t, "exec", "x.y", "--folder", "/wt")
	if err != nil {
		t.Fatalf("exec --folder error: %v", err)
	}
	if _, ok := aa.commandRequest("x.y"); !ok {
		t.Error("the /wt host never received the command; want --folder to decide")
	}
	if _, ok := bb.commandRequest("x.y"); ok {
		t.Error("the own-tab host answered; --folder must skip the own-tab step")
	}
}

func TestCodeHostsTableTabColumns(t *testing.T) {
	stateHome := installCodeBridgeEnv(t)
	startFakeCodeHostRecord(t, stateHome, codebridge.HostRecord{
		HostID: "aa01", Folder: "/repo", Tab: "@3", Server: "dev",
		ExtVersion: "3.19.0", StartedAt: codeStartedAgo(3 * time.Minute),
	})
	startFakeCodeHost(t, stateHome, "bb02", "/other", "3.19.0", codeStartedAgo(3*time.Minute))

	stdout, _, err := runCodeCmd(t, "hosts")
	if err != nil {
		t.Fatalf("hosts error: %v", err)
	}
	for _, col := range []string{"TAB", "SERVER"} {
		if !strings.Contains(stdout, col) {
			t.Errorf("stdout = %q, want a %s column", stdout, col)
		}
	}
	fieldsOf := func(id string) []string {
		t.Helper()
		for _, line := range strings.Split(stdout, "\n") {
			if strings.HasPrefix(line, id+" ") || strings.HasPrefix(line, id+"\t") {
				return strings.Fields(line)
			}
		}
		t.Fatalf("no row for host %s in %q", id, stdout)
		return nil
	}
	if f := fieldsOf("aa01"); len(f) < 4 || f[2] != "@3" || f[3] != "dev" {
		t.Errorf("aa01 row = %v, want tab @3 server dev", f)
	}
	if f := fieldsOf("bb02"); len(f) < 4 || f[2] != "-" || f[3] != "-" {
		t.Errorf("bb02 row = %v, want the - placeholders for a tab-less host", f)
	}

	// --json carries the fields (omitempty on the record: absent when unset).
	stdout, _, err = runCodeCmd(t, "hosts", "--json")
	if err != nil {
		t.Fatalf("hosts --json error: %v, want exit 0", err)
	}
	var records []codebridge.HostRecord
	unwrapEnvelopeResult(t, stdout, &records)
	if len(records) != 2 || records[0].Tab != "@3" || records[0].Server != "dev" ||
		records[1].Tab != "" || records[1].Server != "" {
		t.Errorf("records = %+v, want aa01 with tab/server and bb02 without", records)
	}
}
