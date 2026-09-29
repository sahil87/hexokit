package api

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

// proxyCache holds per-route ReverseProxy instances. Keyed by route prefix AND
// target port ("/proxy/{port}|{port}", "/code|{port}") — read-heavy,
// write-rare, single-digit entry count.
var proxyCache sync.Map

// rewritePattern matches localhost/127.0.0.1 URLs in HTML attributes.
// Captures: (http:|)(//localhost:{port}) or (http:|)(//127.0.0.1:{port})
var rewritePattern = regexp.MustCompile(
	`(https?:)?//(localhost|127\.0\.0\.1):(\d+)`,
)

// newPrefixProxy builds a ReverseProxy that forwards to 127.0.0.1:{port},
// stripping stripPrefix from the inbound path and rewriting localhost:{port}
// references in HTML responses via pathFor (so a /proxy/{port} route rewrites
// per matched port while the /code route rewrites everything to /code).
func newPrefixProxy(port int, stripPrefix string, pathFor func(matchedPort int) string) *httputil.ReverseProxy {
	target := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", port),
	}

	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			// Strip the route prefix from the path
			r.Out.URL.Path = strings.TrimPrefix(r.Out.URL.Path, stripPrefix)
			if r.Out.URL.Path == "" {
				r.Out.URL.Path = "/"
			}
			r.Out.URL.RawPath = ""
			r.Out.Host = target.Host
			// Set X-Forwarded-{For,Host,Proto} from the inbound request.
			// code-server's authenticateOrigin compares the browser's Origin
			// host against Forwarded → X-Forwarded-Host → Host; without this
			// it 403s every WebSocket handshake and POST (browsers omit Origin
			// on same-origin GETs, so the symptom is "loads, then sits
			// disconnected forever"). Proven by spike 2026-08-11.
			r.SetXForwarded()
		},
		ModifyResponse: makeModifyResponse(pathFor),
		Transport: &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			ResponseHeaderTimeout: 10 * time.Second,
			MaxIdleConnsPerHost:   10,
		},
	}
}

// cachedPrefixProxy returns a cached ReverseProxy for the given route prefix
// and target port, creating one on demand if absent. The port is part of the
// key because /code's prefix is FIXED while its target port is seeded once at
// startup: keying on the prefix alone would pin whichever port a process (or
// an earlier package test) seeded first for the rest of the process,
// misrouting every later request (and making package tests order-dependent).
// For /proxy/{port} the port is already in the prefix, so it only makes the
// key's contract explicit.
func cachedPrefixProxy(port int, stripPrefix string, pathFor func(matchedPort int) string) *httputil.ReverseProxy {
	key := fmt.Sprintf("%s|%d", stripPrefix, port)
	if cached, ok := proxyCache.Load(key); ok {
		return cached.(*httputil.ReverseProxy)
	}
	actual, _ := proxyCache.LoadOrStore(key, newPrefixProxy(port, stripPrefix, pathFor))
	return actual.(*httputil.ReverseProxy)
}

// proxyPathFor rewrites a matched localhost port reference to its /proxy path
// (keyed by the MATCHED port — the /proxy/{port} route's historical behavior).
func proxyPathFor(matchedPort int) string {
	return fmt.Sprintf("/proxy/%d", matchedPort)
}

// getOrCreateProxy returns a cached ReverseProxy for the given port, creating
// one on demand if absent.
func getOrCreateProxy(port int) *httputil.ReverseProxy {
	return cachedPrefixProxy(port, fmt.Sprintf("/proxy/%d", port), proxyPathFor)
}

// getOrCreateCodeProxy returns the cached ReverseProxy for the stable /code
// route (260811-a2bo): same machinery as /proxy/{port}, but the path prefix is
// fixed and every localhost reference rewrites to /code — the route is the
// code-server workspace-state identity, so the port never appears in a URL.
func getOrCreateCodeProxy(port int) *httputil.ReverseProxy {
	return cachedPrefixProxy(port, "/code", func(int) string { return "/code" })
}

// makeModifyResponse returns a ModifyResponse function that rewrites HTML
// responses, replacing localhost:{port} references with pathFor(matchedPort).
func makeModifyResponse(pathFor func(matchedPort int) string) func(*http.Response) error {
	return func(resp *http.Response) error {
		// HEAD responses have no body to rewrite; pass through so the upstream
		// Content-Length (the GET entity length) is preserved rather than
		// overwritten with 0 for the empty body.
		if resp.Request != nil && resp.Request.Method == http.MethodHead {
			return nil
		}

		ct := resp.Header.Get("Content-Type")
		if !strings.Contains(ct, "text/html") {
			return nil
		}

		var reader io.ReadCloser
		var isGzipped bool

		switch resp.Header.Get("Content-Encoding") {
		case "gzip":
			isGzipped = true
			var err error
			reader, err = gzip.NewReader(resp.Body)
			if err != nil {
				return nil // Can't decompress — pass through unchanged
			}
			defer reader.Close()
		default:
			reader = resp.Body
		}

		body, err := io.ReadAll(reader)
		if err != nil {
			return nil // Read error — pass through
		}

		rewritten := rewriteHTML(body, pathFor)

		if isGzipped {
			var buf bytes.Buffer
			gz := gzip.NewWriter(&buf)
			if _, err := gz.Write(rewritten); err != nil {
				gz.Close()
				// Fall back to uncompressed
				resp.Body = io.NopCloser(bytes.NewReader(rewritten))
				resp.ContentLength = int64(len(rewritten))
				resp.Header.Set("Content-Length", strconv.Itoa(len(rewritten)))
				resp.Header.Del("Content-Encoding")
				return nil
			}
			gz.Close()
			rewritten = buf.Bytes()
			resp.Body = io.NopCloser(bytes.NewReader(rewritten))
			resp.ContentLength = int64(len(rewritten))
			resp.Header.Set("Content-Length", strconv.Itoa(len(rewritten)))
		} else {
			resp.Body = io.NopCloser(bytes.NewReader(rewritten))
			resp.ContentLength = int64(len(rewritten))
			resp.Header.Set("Content-Length", strconv.Itoa(len(rewritten)))
		}

		return nil
	}
}

// rewriteHTML replaces localhost:{port} and 127.0.0.1:{port} references in HTML
// with pathFor(matchedPort) paths.
func rewriteHTML(body []byte, pathFor func(matchedPort int) string) []byte {
	return rewritePattern.ReplaceAllFunc(body, func(match []byte) []byte {
		submatch := rewritePattern.FindSubmatch(match)
		if len(submatch) < 4 {
			return match
		}
		matchedPort, err := strconv.Atoi(string(submatch[3]))
		if err != nil {
			return match
		}
		return []byte(pathFor(matchedPort))
	})
}

// handleProxy is the HTTP handler for /proxy/{port}/*
func (s *Server) handleProxy(w http.ResponseWriter, r *http.Request) {
	portStr := chi.URLParam(r, "port")
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		writeError(w, http.StatusBadRequest, "invalid port")
		return
	}

	// Redirect /proxy/{port} → /proxy/{port}/ (308, query preserved).
	// Relative-base apps (code-server) resolve "./x" against "/proxy/"
	// without the trailing slash; the redirect makes the proxy safe for any
	// client, not only ones that always append a path.
	if r.URL.Path == fmt.Sprintf("/proxy/%d", port) {
		target := r.URL.Path + "/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusPermanentRedirect)
		return
	}

	proxy := getOrCreateProxy(port)
	proxy.ServeHTTP(w, r)
}

// handleCode is the HTTP handler for /code/* — the stable code-server route
// (260811-a2bo). It reverse-proxies to 127.0.0.1:{startup-resolved
// code-server port} via the same machinery as /proxy/{port}, but the path is
// FIXED: code-server keys browser-side workspace state (tabs, layout,
// IndexedDB) by the proxy pathname, so the port is a private implementation
// detail and /code/ never changes. The target port is the Server's
// startup-seeded codeServerPort (the same one the SSE hub probes) — never
// re-resolved per request, so a mid-run config.yaml edit cannot move the
// proxy target away from the code-server the daemon ensured at startup.
func (s *Server) handleCode(w http.ResponseWriter, r *http.Request) {
	port := s.codeServerPort
	if port == 0 {
		writeError(w, http.StatusServiceUnavailable, "code-server port not resolvable")
		return
	}

	// Redirect /code → /code/ (308, query preserved) — the same relative-base
	// rule as /proxy/{port}: code-server resolves "./x" against "/code/".
	if r.URL.Path == "/code" {
		target := r.URL.Path + "/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusPermanentRedirect)
		return
	}

	proxy := getOrCreateCodeProxy(port)
	proxy.ServeHTTP(w, r)
}
