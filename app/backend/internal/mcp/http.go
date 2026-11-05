package mcp

import (
	"io"
	"log/slog"
	"net/http"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// HTTPRoutePath is the daemon path the streamable-HTTP transport is mounted at.
const HTTPRoutePath = "/mcp"

// HTTPHandler returns the streamable-HTTP transport for this server, wrapped
// in the Origin allowlist guard. Every request shares the one SDK server (and
// so the one policy table and executor). Stateless: no session ID is issued
// and nothing is held between requests, so each request is answered alone.
// MCP 2026-07-28 clients (ChatGPT through OpenAI's tunnel) send tools/call
// with no initialize, and the SDK accepts that version only in stateless
// mode; legacy clients' initialize handshake still works, just sessionless.
// GET and DELETE answer 405: they exist only for sessions, and the static
// tool table never pushes anything over a GET stream. originGuard is the only
// DNS-rebinding guard, so both SDK Host-keyed checks are off:
// CrossOriginProtection stays nil (deprecated, and its Origin == Host
// fail-open is the reference the spec forbids) and DisableLocalhostProtection
// is true — its loopback-arrival/non-loopback-Host 403 rejects every request
// behind a loopback-terminating reverse proxy (`tailscale serve` in front of a
// 127.0.0.1 bind), and Host is never a trustworthy reference anyway.
func (s *Server) HTTPHandler(policy OriginPolicy, logger *slog.Logger) http.Handler {
	h := mcpsdk.NewStreamableHTTPHandler(
		func(*http.Request) *mcpsdk.Server { return s.sdk },
		&mcpsdk.StreamableHTTPOptions{
			Stateless:                  true,
			Logger:                     logger,
			DisableLocalhostProtection: true,
		},
	)
	return originGuard(policy, logger, h)
}

// originGuard enforces the /mcp Origin allowlist on EVERY method — the SSE
// stream is a GET, which Go's cross-origin protection would exempt (one of
// the two reasons it is not reused). A request with no Origin header is not a
// browser request and passes; the request Host header is never consulted.
func originGuard(policy OriginPolicy, logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && !policy.Allows(origin) {
			logger.Warn("mcp: origin rejected", "origin", origin)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			io.WriteString(w, `{"error":"origin not allowed"}`)
			return
		}
		next.ServeHTTP(w, r)
	})
}
