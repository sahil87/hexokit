package mcp

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"rk/internal/testutil"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// discardLogger keeps the handler's log traffic out of test output.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// newHTTPTestServer builds a Server over the shell-stub executor (the
// server_test.go pattern) and mounts its HTTPHandler on an httptest server.
func newHTTPTestServer(t *testing.T, policy OriginPolicy, logger *slog.Logger) (*Server, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "rk-stub", "#!/bin/sh\necho '[{\"name\":\"boot\"}]'\n")
	s, err := New(Config{
		Root:    syntheticTree(),
		Exe:     dir + "/rk-stub",
		Version: "v0.0.0-test",
		Table:   syntheticRows(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(s.HTTPHandler(policy, logger))
	t.Cleanup(ts.Close)
	return s, ts
}

// TestHTTPHandlerRoundTrip: a real go-sdk client over the streamable-HTTP
// transport lists the table's tools and round-trips a CallTool through the
// stub executor; Close returns cleanly (no session was issued, so there is no
// DELETE to send).
func TestHTTPHandlerRoundTrip(t *testing.T) {
	srv, ts := newHTTPTestServer(t, NewOriginPolicy(nil), discardLogger())

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "mcp-http-test"}, nil)
	cs, err := client.Connect(ctx, &mcpsdk.StreamableClientTransport{Endpoint: ts.URL + HTTPRoutePath}, nil)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}

	tools, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	if !equalStrings(names, srv.Tools()) {
		t.Errorf("ListTools = %v, want %v", names, srv.Tools())
	}

	res, err := cs.CallTool(ctx, &mcpsdk.CallToolParams{
		Name:      "capture",
		Arguments: map[string]any{"target": "%3", "lines": 100},
	})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("capture call IsError: %v", res.Content)
	}
	if tc, ok := res.Content[0].(*mcpsdk.TextContent); !ok || tc.Text != `[{"name":"boot"}]` {
		t.Errorf("capture content = %v", res.Content)
	}

	if err := cs.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
}

// hostRewriter forwards every request with its Host header replaced — the
// shape a reverse proxy in front of a loopback bind produces.
type hostRewriter struct {
	host string
	next http.RoundTripper
}

func (h hostRewriter) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Host = h.host
	return h.next.RoundTrip(r)
}

// TestHTTPHandlerProxiedHostRoundTrip: a full client exchange (initialize,
// ListTools, Close) succeeds when every request reaches the loopback
// listener carrying a non-loopback Host, as behind `tailscale serve`.
func TestHTTPHandlerProxiedHostRoundTrip(t *testing.T) {
	_, ts := newHTTPTestServer(t, NewOriginPolicy(nil), discardLogger())

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	httpClient := &http.Client{Transport: hostRewriter{host: "box.tail1234.ts.net", next: ts.Client().Transport}}
	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "mcp-http-test"}, nil)
	cs, err := client.Connect(ctx, &mcpsdk.StreamableClientTransport{Endpoint: ts.URL + HTTPRoutePath, HTTPClient: httpClient}, nil)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if _, err := cs.ListTools(ctx, nil); err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if err := cs.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
}

// sdkPassThroughStatus is how a GET that got past originGuard shows up: the
// stateless SDK handler answers GET 405. Anything but the guard's own 403
// proves the request reached the SDK.
const sdkPassThroughStatus = http.StatusMethodNotAllowed

// TestHTTPHandlerOriginGuard: raw-request cases over the guard. An allowed,
// absent, or loopback Origin passes through to the SDK (observable as
// sdkPassThroughStatus, never a 403); a disallowed Origin — including the
// rebinding shape where Origin equals a crafted Host — is 403 with the JSON
// body; a PUT reaches the SDK and is answered 405.
func TestHTTPHandlerOriginGuard(t *testing.T) {
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))
	policy := NewOriginPolicy([]string{"http://box:3000"})
	_, ts := newHTTPTestServer(t, policy, logger)

	do := func(t *testing.T, method, origin, host string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+HTTPRoutePath, nil)
		if err != nil {
			t.Fatalf("NewRequest: %v", err)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if host != "" {
			req.Host = host
		}
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, origin, err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	t.Run("allowed origin passes to the SDK", func(t *testing.T) {
		status, _ := do(t, http.MethodGet, "http://box:3000", "")
		if status != sdkPassThroughStatus {
			t.Errorf("status = %d, want %d (the SDK's stateless GET signature)", status, sdkPassThroughStatus)
		}
	})
	t.Run("case-folded allowed origin passes", func(t *testing.T) {
		status, _ := do(t, http.MethodGet, "http://BOX:3000", "")
		if status != sdkPassThroughStatus {
			t.Errorf("status = %d, want %d", status, sdkPassThroughStatus)
		}
	})
	t.Run("absent origin passes", func(t *testing.T) {
		status, _ := do(t, http.MethodGet, "", "")
		if status != sdkPassThroughStatus {
			t.Errorf("status = %d, want %d", status, sdkPassThroughStatus)
		}
	})
	t.Run("loopback origin at another port passes", func(t *testing.T) {
		status, _ := do(t, http.MethodGet, "http://127.0.0.1:5173", "")
		if status != sdkPassThroughStatus {
			t.Errorf("status = %d, want %d", status, sdkPassThroughStatus)
		}
	})
	t.Run("localhost origin passes", func(t *testing.T) {
		status, _ := do(t, http.MethodGet, "http://localhost", "")
		if status != sdkPassThroughStatus {
			t.Errorf("status = %d, want %d", status, sdkPassThroughStatus)
		}
	})
	t.Run("disallowed origin is 403 JSON", func(t *testing.T) {
		status, body := do(t, http.MethodGet, "http://evil.example:3000", "")
		if status != http.StatusForbidden {
			t.Errorf("status = %d, want 403", status)
		}
		if body != `{"error":"origin not allowed"}` {
			t.Errorf("body = %q", body)
		}
	})
	t.Run("rebinding shape (origin == crafted host) is 403", func(t *testing.T) {
		status, body := do(t, http.MethodGet, "http://evil.example:3000", "evil.example:3000")
		if status != http.StatusForbidden {
			t.Errorf("status = %d, want 403 — the Host header is never the reference", status)
		}
		if body != `{"error":"origin not allowed"}` {
			t.Errorf("body = %q", body)
		}
	})
	t.Run("proxied non-loopback Host with no origin passes", func(t *testing.T) {
		// The tailscale-serve shape: the request arrives on the loopback
		// listener carrying the tailnet name as Host.
		status, body := do(t, http.MethodGet, "", "box.tail1234.ts.net")
		if status != sdkPassThroughStatus {
			t.Errorf("status = %d, want %d — a loopback arrival with a tailnet Host must not trip a Host check; body %q", status, sdkPassThroughStatus, body)
		}
	})
	t.Run("disallowed origin behind a proxied Host is 403 JSON", func(t *testing.T) {
		status, body := do(t, http.MethodGet, "http://evil.example:3000", "box.tail1234.ts.net")
		if status != http.StatusForbidden {
			t.Errorf("status = %d, want 403", status)
		}
		if body != `{"error":"origin not allowed"}` {
			t.Errorf("body = %q", body)
		}
	})
	t.Run("malformed origin is 403", func(t *testing.T) {
		for _, origin := range []string{"http://box:3000/path", "ftp://box:3000", "http://user@box:3000"} {
			if status, _ := do(t, http.MethodGet, origin, ""); status != http.StatusForbidden {
				t.Errorf("origin %q: status = %d, want 403", origin, status)
			}
		}
	})
	t.Run("PUT reaches the SDK and is 405", func(t *testing.T) {
		status, _ := do(t, http.MethodPut, "", "")
		if status != http.StatusMethodNotAllowed {
			t.Errorf("status = %d, want 405", status)
		}
	})

	// Exactly one WARN per rejection, each naming its origin: the rejection
	// cases above (disallowed, rebinding, proxied-Host disallowed, and the
	// three malformed).
	if got, want := strings.Count(logBuf.String(), "mcp: origin rejected"), 6; got != want {
		t.Errorf("WARN lines = %d, want %d; log:\n%s", got, want, logBuf.String())
	}
	if !strings.Contains(logBuf.String(), `origin=http://evil.example:3000`) {
		t.Errorf("WARN lines must name the rejected origin; log:\n%s", logBuf.String())
	}
}

// rawPost sends one JSON-RPC message to /mcp without an SDK client, so a
// test controls the exact protocol-version headers and _meta a given client
// generation sends.
func rawPost(t *testing.T, ts *httptest.Server, msg string, headers map[string]string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, ts.URL+HTTPRoutePath, strings.NewReader(msg))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

// TestHTTPHandlerModernStatelessCall: a 2026-07-28 client (ChatGPT through
// OpenAI's tunnel) sends tools/call with no initialize and no session, the
// version carried in headers and _meta. The handler answers it directly.
func TestHTTPHandlerModernStatelessCall(t *testing.T) {
	_, ts := newHTTPTestServer(t, NewOriginPolicy(nil), discardLogger())

	msg := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{` +
		`"name":"capture","arguments":{"target":"%3","lines":100},` +
		`"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",` +
		`"io.modelcontextprotocol/clientCapabilities":{},` +
		`"io.modelcontextprotocol/clientInfo":{"name":"modern-client","version":"0"}}}}`
	resp, body := rawPost(t, ts, msg, map[string]string{
		"Mcp-Protocol-Version": "2026-07-28",
		"Mcp-Method":           "tools/call",
		"Mcp-Name":             "capture",
	})

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %q", resp.StatusCode, body)
	}
	if !strings.Contains(body, `[{\"name\":\"boot\"}]`) {
		t.Errorf("body = %q, want the stub executor's output", body)
	}
}

// TestHTTPHandlerIssuesNoSessionID: a legacy 2025-06-18 initialize succeeds
// but gets no Mcp-Session-Id. No session is held between requests, so any
// request can be answered alone, whichever tunnel or proxy delivered it.
func TestHTTPHandlerIssuesNoSessionID(t *testing.T) {
	_, ts := newHTTPTestServer(t, NewOriginPolicy(nil), discardLogger())

	msg := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{` +
		`"protocolVersion":"2025-06-18","capabilities":{},` +
		`"clientInfo":{"name":"legacy-client","version":"0"}}}`
	resp, body := rawPost(t, ts, msg, map[string]string{"Mcp-Protocol-Version": "2025-06-18"})

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %q", resp.StatusCode, body)
	}
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		t.Errorf("Mcp-Session-Id = %q, want none", sid)
	}
}

// TestHTTPHandlerLegacyHandshake: a 2025-06-18 client's full handshake
// (initialize, initialized, tools/list, tools/call) works with no session
// header, which is how Claude Code and other pre-2026 clients call /mcp.
func TestHTTPHandlerLegacyHandshake(t *testing.T) {
	_, ts := newHTTPTestServer(t, NewOriginPolicy(nil), discardLogger())
	legacy := map[string]string{"Mcp-Protocol-Version": "2025-06-18"}

	steps := []struct {
		name string
		msg  string
		want int
	}{
		{"initialize", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"legacy-client","version":"0"}}}`, http.StatusOK},
		{"initialized", `{"jsonrpc":"2.0","method":"notifications/initialized"}`, http.StatusAccepted},
		{"tools/list", `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`, http.StatusOK},
		{"tools/call", `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"capture","arguments":{"target":"%3","lines":100}}}`, http.StatusOK},
	}
	for _, step := range steps {
		resp, body := rawPost(t, ts, step.msg, legacy)
		if resp.StatusCode != step.want {
			t.Fatalf("%s: status = %d, want %d; body %q", step.name, resp.StatusCode, step.want, body)
		}
		if strings.Contains(body, `"error"`) {
			t.Fatalf("%s: JSON-RPC error %q", step.name, body)
		}
		if step.name == "tools/call" && !strings.Contains(body, `[{\"name\":\"boot\"}]`) {
			t.Errorf("tools/call body = %q, want the stub executor's output", body)
		}
	}
}
