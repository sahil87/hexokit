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
// stub executor; Close issues the transport's DELETE cleanly.
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
		t.Errorf("Close (transport DELETE): %v", err)
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

// TestHTTPHandlerProxiedHostRoundTrip: a full client session (initialize,
// ListTools, DELETE) succeeds when every request reaches the loopback
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
		t.Errorf("Close (transport DELETE): %v", err)
	}
}

// TestHTTPHandlerOriginGuard: raw-request cases over the guard. An allowed,
// absent, or loopback Origin passes through to the SDK (observable as its
// session-less GET 400, never a 403); a disallowed Origin — including the
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
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400 (the SDK's session-less GET signature)", status)
		}
	})
	t.Run("case-folded allowed origin passes", func(t *testing.T) {
		status, _ := do(t, http.MethodGet, "http://BOX:3000", "")
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
	})
	t.Run("absent origin passes", func(t *testing.T) {
		status, _ := do(t, http.MethodGet, "", "")
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
	})
	t.Run("loopback origin at another port passes", func(t *testing.T) {
		status, _ := do(t, http.MethodGet, "http://127.0.0.1:5173", "")
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
	})
	t.Run("localhost origin passes", func(t *testing.T) {
		status, _ := do(t, http.MethodGet, "http://localhost", "")
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
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
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400 — a loopback arrival with a tailnet Host must not trip a Host check; body %q", status, body)
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
