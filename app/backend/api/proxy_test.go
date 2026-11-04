package api

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"rk/internal/config"
	"rk/internal/settings"
)

func TestProxyInvalidPort(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	tests := []struct {
		name string
		path string
	}{
		{"non-numeric", "/proxy/abc/path"},
		{"zero", "/proxy/0/path"},
		{"too large", "/proxy/99999/path"},
		{"negative", "/proxy/-1/path"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
		})
	}
}

func TestRewriteHTML(t *testing.T) {
	tests := []struct {
		name  string
		input string
		port  int
		want  string
	}{
		{
			name:  "rewrite http://localhost",
			input: `<a href="http://localhost:8080/api">link</a>`,
			port:  8080,
			want:  `<a href="/proxy/8080/api">link</a>`,
		},
		{
			name:  "rewrite //localhost",
			input: `<script src="//localhost:3000/bundle.js"></script>`,
			port:  3000,
			want:  `<script src="/proxy/3000/bundle.js"></script>`,
		},
		{
			name:  "rewrite 127.0.0.1",
			input: `<img src="http://127.0.0.1:5000/logo.png">`,
			port:  5000,
			want:  `<img src="/proxy/5000/logo.png">`,
		},
		{
			name:  "multiple rewrites",
			input: `<a href="http://localhost:8080/a">a</a><a href="http://localhost:8080/b">b</a>`,
			port:  8080,
			want:  `<a href="/proxy/8080/a">a</a><a href="/proxy/8080/b">b</a>`,
		},
		{
			name:  "no match passthrough",
			input: `<a href="https://example.com/path">external</a>`,
			port:  8080,
			want:  `<a href="https://example.com/path">external</a>`,
		},
		{
			name:  "different port also rewritten",
			input: `<link href="http://localhost:3001/style.css">`,
			port:  8080, // proxy port doesn't restrict which ports get rewritten
			want:  `<link href="/proxy/3001/style.css">`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := string(rewriteHTML([]byte(tt.input), proxyPathFor))
			if got != tt.want {
				t.Errorf("rewriteHTML() =\n%s\nwant:\n%s", got, tt.want)
			}
		})
	}
}

func TestModifyResponseHTMLRewrite(t *testing.T) {
	fn := makeModifyResponse(proxyPathFor)

	body := `<a href="http://localhost:8080/docs">docs</a>`
	resp := &http.Response{
		Header: http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Body:   io.NopCloser(bytes.NewReader([]byte(body))),
	}

	if err := fn(resp); err != nil {
		t.Fatalf("ModifyResponse error: %v", err)
	}

	result, _ := io.ReadAll(resp.Body)
	want := `<a href="/proxy/8080/docs">docs</a>`
	if string(result) != want {
		t.Errorf("body = %q, want %q", string(result), want)
	}
	assertContentLength(t, resp, len(result))
}

// TestModifyResponseStaleContentLengthHeader is the regression test for the
// blank-iframe bug: the rewrite shrinks the body, and the original upstream
// Content-Length header must be overwritten to match the rewritten body —
// httputil.ReverseProxy copies the header map (not resp.ContentLength) to the
// client, so a stale header causes ERR_CONTENT_LENGTH_MISMATCH in browsers.
func TestModifyResponseStaleContentLengthHeader(t *testing.T) {
	fn := makeModifyResponse(proxyPathFor)

	body := `<img src="http://127.0.0.1:5000/logo.png">`
	resp := &http.Response{
		Header: http.Header{
			"Content-Type":   []string{"text/html; charset=utf-8"},
			"Content-Length": []string{strconv.Itoa(len(body))},
		},
		Body:          io.NopCloser(bytes.NewReader([]byte(body))),
		ContentLength: int64(len(body)),
	}

	if err := fn(resp); err != nil {
		t.Fatalf("ModifyResponse error: %v", err)
	}

	result, _ := io.ReadAll(resp.Body)
	want := `<img src="/proxy/5000/logo.png">`
	if string(result) != want {
		t.Errorf("body = %q, want %q", string(result), want)
	}
	if len(result) >= len(body) {
		t.Fatalf("rewrite did not shrink body: got %d, original %d", len(result), len(body))
	}
	assertContentLength(t, resp, len(result))
}

// TestModifyResponseHEADPassthrough guards HTTP HEAD semantics: a HEAD
// response has an empty body while its Content-Length header advertises the
// GET entity length. The rewrite must pass HEAD through untouched — an
// unconditional header sync would overwrite the entity length with 0.
func TestModifyResponseHEADPassthrough(t *testing.T) {
	fn := makeModifyResponse(proxyPathFor)

	const entityLength = "1234"
	resp := &http.Response{
		Request: &http.Request{Method: http.MethodHead},
		Header: http.Header{
			"Content-Type":   []string{"text/html; charset=utf-8"},
			"Content-Length": []string{entityLength},
		},
		Body:          io.NopCloser(bytes.NewReader(nil)),
		ContentLength: 1234,
	}

	if err := fn(resp); err != nil {
		t.Fatalf("ModifyResponse error: %v", err)
	}

	if got := resp.Header.Get("Content-Length"); got != entityLength {
		t.Errorf("Content-Length header = %q, want %q (upstream entity length preserved)", got, entityLength)
	}
	if resp.ContentLength != 1234 {
		t.Errorf("ContentLength field = %d, want 1234 (untouched)", resp.ContentLength)
	}
	result, _ := io.ReadAll(resp.Body)
	if len(result) != 0 {
		t.Errorf("body length = %d, want 0 (HEAD body stays empty)", len(result))
	}
}

func TestModifyResponseNonHTMLPassthrough(t *testing.T) {
	fn := makeModifyResponse(proxyPathFor)

	body := `{"url": "http://localhost:8080/api"}`
	resp := &http.Response{
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   io.NopCloser(bytes.NewReader([]byte(body))),
	}

	if err := fn(resp); err != nil {
		t.Fatalf("ModifyResponse error: %v", err)
	}

	result, _ := io.ReadAll(resp.Body)
	if string(result) != body {
		t.Errorf("body = %q, want %q (unchanged)", string(result), body)
	}
}

func TestModifyResponseGzipHTML(t *testing.T) {
	fn := makeModifyResponse(proxyPathFor)

	html := `<a href="http://localhost:8080/docs">docs</a>`
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	gz.Write([]byte(html))
	gz.Close()

	resp := &http.Response{
		Header: http.Header{
			"Content-Type":     []string{"text/html"},
			"Content-Encoding": []string{"gzip"},
			"Content-Length":   []string{strconv.Itoa(buf.Len())},
		},
		Body:          io.NopCloser(bytes.NewReader(buf.Bytes())),
		ContentLength: int64(buf.Len()),
	}

	if err := fn(resp); err != nil {
		t.Fatalf("ModifyResponse error: %v", err)
	}

	// Content-Length must match the re-compressed wire bytes, not the
	// decompressed HTML — read the raw body before decoding.
	wire, _ := io.ReadAll(resp.Body)
	assertContentLength(t, resp, len(wire))

	// Result should be gzip-compressed
	gr, err := gzip.NewReader(bytes.NewReader(wire))
	if err != nil {
		t.Fatalf("gzip.NewReader error: %v", err)
	}
	result, _ := io.ReadAll(gr)
	gr.Close()

	want := `<a href="/proxy/8080/docs">docs</a>`
	if string(result) != want {
		t.Errorf("body = %q, want %q", string(result), want)
	}
}

// assertContentLength asserts that both the Content-Length header (what
// httputil.ReverseProxy copies to the client) and the ContentLength field
// equal the exact byte length of the final wire body.
func assertContentLength(t *testing.T, resp *http.Response, wireLen int) {
	t.Helper()
	if got, want := resp.Header.Get("Content-Length"), strconv.Itoa(wireLen); got != want {
		t.Errorf("Content-Length header = %q, want %q", got, want)
	}
	if resp.ContentLength != int64(wireLen) {
		t.Errorf("ContentLength field = %d, want %d", resp.ContentLength, wireLen)
	}
}

func TestGetOrCreateProxyCaching(t *testing.T) {
	p1 := getOrCreateProxy(9999)
	p2 := getOrCreateProxy(9999)
	if p1 != p2 {
		t.Error("expected same proxy instance for same port")
	}

	p3 := getOrCreateProxy(9998)
	if p1 == p3 {
		t.Error("expected different proxy instance for different port")
	}
}

// TestProxySetsXForwardedHost proves the Rewrite hook sets X-Forwarded-Host
// (and X-Forwarded-Proto) from the INBOUND request — code-server's
// authenticateOrigin compares the browser's Origin host against
// Forwarded → X-Forwarded-Host → Host and 403s every WS handshake / POST
// without it (spiked 2026-08-11; the upgrade path shares this Rewrite hook).
func TestProxySetsXForwardedHost(t *testing.T) {
	var gotHost, gotProto string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Header.Get("X-Forwarded-Host")
		gotProto = r.Header.Get("X-Forwarded-Proto")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	// Point the (cached) proxy at the upstream's real port.
	portStr := strings.TrimPrefix(upstream.URL, "http://127.0.0.1:")

	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
	req := httptest.NewRequest(http.MethodGet, "/proxy/"+portStr+"/stable", nil)
	req.Host = "rk.example:3000"
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if gotHost != "rk.example:3000" {
		t.Errorf("X-Forwarded-Host = %q, want %q (the inbound Host)", gotHost, "rk.example:3000")
	}
	if gotProto != "http" {
		t.Errorf("X-Forwarded-Proto = %q, want %q", gotProto, "http")
	}
}

// TestProxyTrailingSlashRedirect proves /proxy/{port} (no trailing slash)
// redirects to /proxy/{port}/ with the query string preserved, so
// relative-base apps (code-server) resolve "./x" against the right base for
// any client — and that the slashed path proxies without a redirect.
func TestProxyTrailingSlashRedirect(t *testing.T) {
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	// No trailing slash → 308 with Location preserving the query.
	req := httptest.NewRequest(http.MethodGet, "/proxy/8080?folder=/repo", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusPermanentRedirect {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusPermanentRedirect)
	}
	if loc := rec.Header().Get("Location"); loc != "/proxy/8080/?folder=/repo" {
		t.Errorf("Location = %q, want %q", loc, "/proxy/8080/?folder=/repo")
	}

	// No query → bare trailing-slash Location.
	req = httptest.NewRequest(http.MethodGet, "/proxy/8080", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusPermanentRedirect {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusPermanentRedirect)
	}
	if loc := rec.Header().Get("Location"); loc != "/proxy/8080/" {
		t.Errorf("Location = %q, want %q", loc, "/proxy/8080/")
	}

	// The slashed path is proxied, never redirected (no loop). Nothing listens
	// on 8080, so a proxy attempt surfaces as 502 Bad Gateway — anything but a
	// redirect proves the branch was skipped.
	req = httptest.NewRequest(http.MethodGet, "/proxy/8080/", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code == http.StatusPermanentRedirect || rec.Code == http.StatusMovedPermanently {
		t.Errorf("slashed path redirected (loop risk): status = %d", rec.Code)
	}
}

// TestCodeRouteForwards proves the stable /code route (260811-a2bo): it
// proxies to the resolved code-server port with the /code prefix stripped,
// sets X-Forwarded-Host from the inbound Host (the WS-handshake origin-check
// requirement), and rewrites localhost:{port} references in HTML to /code.
func TestCodeRouteForwards(t *testing.T) {
	var gotPath, gotRawQuery, gotHost string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotRawQuery = r.URL.RawQuery
		gotHost = r.Header.Get("X-Forwarded-Host")
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<a href="http://127.0.0.1:%s/x">x</a>`, strings.TrimPrefix(upstreamURL(r), "http://127.0.0.1:"))
	}))
	defer upstream.Close()
	portStr := strings.TrimPrefix(upstream.URL, "http://127.0.0.1:")

	t.Setenv("RK_CODE_SERVER_PORT", portStr)
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodGet, "/code/?folder=/repo", nil)
	req.Host = "rk.example:3000"
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if gotPath != "/" {
		t.Errorf("upstream path = %q, want %q (/code prefix stripped)", gotPath, "/")
	}
	if gotRawQuery != "folder=/repo" {
		t.Errorf("upstream query = %q, want %q", gotRawQuery, "folder=/repo")
	}
	if gotHost != "rk.example:3000" {
		t.Errorf("X-Forwarded-Host = %q, want %q (the inbound Host)", gotHost, "rk.example:3000")
	}
	// The HTML rewrite targets /code — the route is the identity, the port
	// never appears in a rewritten reference.
	body, _ := io.ReadAll(rec.Result().Body)
	want := `<a href="/code/x">x</a>`
	if string(body) != want {
		t.Errorf("body = %q, want %q", string(body), want)
	}

	// A nested path strips only the /code prefix.
	req = httptest.NewRequest(http.MethodGet, "/code/static/out/main.js", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if gotPath != "/static/out/main.js" {
		t.Errorf("upstream path = %q, want %q", gotPath, "/static/out/main.js")
	}
}

// upstreamURL reports the test server's own URL from its handler (for building
// self-referencing HTML that the proxy must rewrite).
func upstreamURL(r *http.Request) string {
	return "http://" + r.Host
}

// TestCodeRouteTrailingSlashRedirect proves /code (no trailing slash) 308-
// redirects to /code/ with the query preserved — and that /code/ proxies
// directly (no loop). Nothing listens on the resolved port for the slashed
// probe, so a proxy attempt surfaces as 502 — anything but a redirect proves
// the branch was skipped.
func TestCodeRouteTrailingSlashRedirect(t *testing.T) {
	t.Setenv("RK_CODE_SERVER_PORT", "3939")
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodGet, "/code?folder=/repo", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusPermanentRedirect {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusPermanentRedirect)
	}
	if loc := rec.Header().Get("Location"); loc != "/code/?folder=/repo" {
		t.Errorf("Location = %q, want %q", loc, "/code/?folder=/repo")
	}

	// No query → bare trailing-slash Location.
	req = httptest.NewRequest(http.MethodGet, "/code", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusPermanentRedirect {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusPermanentRedirect)
	}
	if loc := rec.Header().Get("Location"); loc != "/code/" {
		t.Errorf("Location = %q, want %q", loc, "/code/")
	}

	req = httptest.NewRequest(http.MethodGet, "/code/", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code == http.StatusPermanentRedirect || rec.Code == http.StatusMovedPermanently {
		t.Errorf("slashed path redirected (loop risk): status = %d", rec.Code)
	}
}

// TestCodeRouteConventionPort proves the route resolves the RK_PORT+2
// convention when RK_CODE_SERVER_PORT is unset (R1): the proxy target is the
// convention port, so a listener there is what answers.
func TestCodeRouteConventionPort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	t.Setenv("RK_PORT", strconv.Itoa(port-2))
	t.Setenv("RK_CODE_SERVER_PORT", "")
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	// Nothing serves the listener's socket at the HTTP layer, but a bare
	// accept is enough: the proxy dials 127.0.0.1:RK_PORT+2 and the request
	// fails differently (EOF/503-ish) than a connection-refused 502 would on
	// an unserved port. The assertion that matters: NOT a redirect, NOT a 503
	// from the unresolvable branch.
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			conn.Close()
		}
	}()
	req := httptest.NewRequest(http.MethodGet, "/code/", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code == http.StatusServiceUnavailable {
		t.Errorf("status = 503 — convention port not resolved")
	}
}

// TestCodeRouteUnresolvablePort proves the degenerate-config branch: an
// RK_PORT whose +2 falls outside 1-65535 resolves to 0 and the route answers
// 503 rather than proxying nowhere.
func TestCodeRouteUnresolvablePort(t *testing.T) {
	t.Setenv("RK_PORT", "65535")
	t.Setenv("RK_CODE_SERVER_PORT", "")
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	req := httptest.NewRequest(http.MethodGet, "/code/", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

// TestCodeRouteFollowsResolvedPort proves the proxy cache is keyed by target
// port, not by the /code prefix alone: /code's prefix is fixed while its port
// is seeded per server at startup, so a prefix-only key would pin whichever
// port a first server resolved and route a later server's requests to the
// wrong upstream.
func TestCodeRouteFollowsResolvedPort(t *testing.T) {
	newUpstream := func(marker string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, marker)
		}))
	}
	first, second := newUpstream("FIRST"), newUpstream("SECOND")
	defer first.Close()
	defer second.Close()

	get := func(t *testing.T, upstream *httptest.Server) string {
		t.Helper()
		t.Setenv("RK_CODE_SERVER_PORT", strings.TrimPrefix(upstream.URL, "http://127.0.0.1:"))
		router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/code/", nil))
		body, _ := io.ReadAll(rec.Result().Body)
		return string(body)
	}

	if got := get(t, first); got != "FIRST" {
		t.Fatalf("first request body = %q, want %q", got, "FIRST")
	}
	if got := get(t, second); got != "SECOND" {
		t.Errorf("body after the resolved port changed = %q, want %q (stale cached proxy)", got, "SECOND")
	}
}

// TestPortsStableAcrossMidRunConfigEdit proves the startup-resolution
// contract: a config.yaml `port:` edit made AFTER the server is up moves
// neither the `/code/` proxy target nor the `/api/health` tunnel
// advertisement — both follow the listener the process actually bound, and
// the edit applies on the next daemon restart.
func TestPortsStableAcrossMidRunConfigEdit(t *testing.T) {
	// Upstream stands in for code-server on the startup-resolved port.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "CODE-UPSTREAM")
	}))
	defer upstream.Close()
	codePort, err := strconv.Atoi(strings.TrimPrefix(upstream.URL, "http://127.0.0.1:"))
	if err != nil {
		t.Fatalf("parsing upstream port: %v", err)
	}
	listenPort := codePort - 2 // the +2 convention lands the code port on the upstream

	// Startup: an isolated config root pins the listen port.
	dir := t.TempDir()
	configFile := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configFile, []byte(fmt.Sprintf("port: %d\n", listenPort)), 0o644); err != nil {
		t.Fatalf("writing config.yaml: %v", err)
	}
	t.Setenv(settings.ConfigDirEnv, dir)
	// Set-but-empty reads as unset: the config.yaml rung decides.
	t.Setenv(config.PortEnvVar, "")
	t.Setenv(config.CodeServerPortEnvVar, "")
	router := newTestRouter(&mockSessionFetcher{}, &mockTmuxOps{})

	get := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}
	tunnelPort := func(t *testing.T) float64 {
		t.Helper()
		var body map[string]any
		if err := json.NewDecoder(get("/api/health").Body).Decode(&body); err != nil {
			t.Fatalf("decode health: %v", err)
		}
		port, ok := body["tunnel"].(float64)
		if !ok {
			t.Fatalf("body.tunnel = %v (%T), want a JSON number", body["tunnel"], body["tunnel"])
		}
		return port
	}

	// Baseline: /code proxies to the startup-resolved port; health advertises
	// the startup listen port.
	if rec := get("/code/"); rec.Code != http.StatusOK {
		t.Fatalf("baseline /code/ status = %d, want %d", rec.Code, http.StatusOK)
	} else if body, _ := io.ReadAll(rec.Result().Body); string(body) != "CODE-UPSTREAM" {
		t.Fatalf("baseline /code/ body = %q, want CODE-UPSTREAM", body)
	}
	if got := tunnelPort(t); int(got) != listenPort {
		t.Fatalf("baseline tunnel = %v, want %d", got, listenPort)
	}

	// Mid-run edit: config.yaml moves to a different port.
	if err := os.WriteFile(configFile, []byte("port: 5000\n"), 0o644); err != nil {
		t.Fatalf("rewriting config.yaml: %v", err)
	}

	// Neither surface moves mid-run.
	if rec := get("/code/"); rec.Code != http.StatusOK {
		t.Fatalf("post-edit /code/ status = %d, want %d (the proxy target must not move)", rec.Code, http.StatusOK)
	} else if body, _ := io.ReadAll(rec.Result().Body); string(body) != "CODE-UPSTREAM" {
		t.Errorf("post-edit /code/ body = %q, want CODE-UPSTREAM (still the startup port)", body)
	}
	if got := tunnelPort(t); int(got) != listenPort {
		t.Errorf("post-edit tunnel = %v, want %d (still the bound listen port)", got, listenPort)
	}
}
