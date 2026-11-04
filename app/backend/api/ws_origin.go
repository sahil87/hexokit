package api

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// WebSocket Origin policies. Browsers apply no CORS to WebSocket handshakes,
// so each upgrader enforces its own gate:
//
//   - checkTunnelWSOrigin (the `/ws/tunnel` upgrader): the strictest policy —
//     the tunnel's sole client is the desktop's main process (a non-browser
//     client sending neither header), so ANY `Origin` or `Sec-Fetch-Site`
//     header marks a browser page and is rejected. rk's own origin is
//     rejected too; the SPA never opens the tunnel.
//   - checkSharedWSOrigin (the shared upgrader for `/ws/state`,
//     `/ws/terminals`, `/ws/gui/{id}`): Fetch-Metadata-first same-origin. A
//     browser computes `Sec-Fetch-Site` against the URL IT connected to, so
//     `same-origin` is allowed even when a front end rewrites `Host`; any
//     other present value is a cross-site page and is rejected. With the
//     header absent (non-browser clients), a missing `Origin` is allowed and
//     a present one must match the host the client reached.

// checkTunnelWSOrigin admits only Origin-less, Sec-Fetch-Site-less requests.
func checkTunnelWSOrigin(r *http.Request) bool {
	return r.Header.Get("Origin") == "" && r.Header.Get("Sec-Fetch-Site") == ""
}

// checkSharedWSOrigin admits same-origin sockets per the policy above.
func checkSharedWSOrigin(r *http.Request) bool {
	if sfs := r.Header.Get("Sec-Fetch-Site"); sfs != "" {
		return strings.EqualFold(sfs, "same-origin")
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	// A reverse proxy rewrites Host to the upstream; the first
	// X-Forwarded-Host value carries the host the client actually connected
	// to. Trusting it is safe here: the browser WebSocket API cannot set
	// custom headers, so a cross-site page cannot forge it, and a
	// non-browser client can simply omit Origin.
	host := r.Host
	if xfh := r.Header.Get("X-Forwarded-Host"); xfh != "" {
		host = strings.TrimSpace(strings.Split(xfh, ",")[0])
	}
	return wsOriginHostMatches(u, host)
}

// wsOriginHostMatches reports whether the Origin's host[:port] equals the
// target host[:port], case-insensitively, with the scheme's default port
// (80 for http, 443 for https) normalized away. The scheme itself is not
// compared: a TLS front end terminates TLS, so `Origin: https://…` meets a
// plain-http hop.
func wsOriginHostMatches(origin *url.URL, target string) bool {
	oHost := origin.Hostname()
	oPort := origin.Port()
	if oPort == "" {
		switch strings.ToLower(origin.Scheme) {
		case "http":
			oPort = "80"
		case "https":
			oPort = "443"
		}
	}
	tHost, tPort, err := net.SplitHostPort(target)
	if err != nil {
		tHost = target
	}
	// url.URL.Hostname() strips IPv6 brackets; a bare target host keeps them
	// (SplitHostPort needs a port to parse "[::1]").
	tHost = strings.TrimPrefix(strings.TrimSuffix(tHost, "]"), "[")
	if !strings.EqualFold(oHost, tHost) {
		return false
	}
	if tPort == "" {
		return oPort == "80" || oPort == "443"
	}
	return oPort == tPort
}
