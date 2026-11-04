package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// tailscaleProbeTimeout bounds the `tailscale status --json` probe at daemon
// start — a hung tailscaled must never stall serving (Process Execution).
const tailscaleProbeTimeout = 3 * time.Second

// OriginPolicy is the /mcp allowlist: exact scheme://host:port entries plus
// the loopback exception. A request with no Origin header is not a browser
// request and always passes; the request Host header is never consulted —
// under DNS rebinding it carries the attacker's name (docs/specs/mcp.md §
// Transports).
type OriginPolicy struct{ allowed map[string]struct{} }

// NewOriginPolicy normalizes each entry (lowercase scheme/host, explicit
// port); entries that are not bare http(s) origins are dropped.
func NewOriginPolicy(origins []string) OriginPolicy {
	p := OriginPolicy{allowed: make(map[string]struct{}, len(origins))}
	for _, raw := range origins {
		if norm, ok := normalizeOrigin(raw); ok {
			p.allowed[norm] = struct{}{}
		}
	}
	return p
}

// Allows reports whether an Origin header value is permitted: parse →
// normalize → loopback exception → exact match.
func (p OriginPolicy) Allows(origin string) bool {
	norm, ok := normalizeOrigin(origin)
	if !ok {
		return false
	}
	// norm is already a valid origin, so this parse cannot fail.
	u, _ := url.Parse(norm)
	// The loopback exception: DNS rebinding cannot manufacture a loopback
	// origin (the attacker's Origin carries the attacker's name), and same-box
	// clients legitimately run on other ports (the Vite dev rig, an `rk
	// remote` tunnel client) — any port and either scheme pass.
	if isLoopbackHost(u.Hostname()) {
		return true
	}
	_, ok = p.allowed[norm]
	return ok
}

// Origins returns the sorted allowlist — for logging and the doctor/test
// surface.
func (p OriginPolicy) Origins() []string {
	out := make([]string, 0, len(p.allowed))
	for o := range p.allowed {
		out = append(out, o)
	}
	sort.Strings(out)
	return out
}

// normalizeOrigin canonicalizes a raw origin to scheme://host:port: scheme and
// host lowercased, a missing port filled with the scheme default (so
// http://box and http://box:80 compare equal), IPv6 hosts bracketed. Anything
// with a path, query, fragment, or userinfo, or a scheme other than
// http/https, is not an origin (the validOrigin posture from cmd/rk/origin.go).
func normalizeOrigin(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	if u.Host == "" || u.User != nil {
		return "", false
	}
	if u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return scheme + "://" + net.JoinHostPort(host, port), true
}

// isLoopbackHost reports whether host is localhost, a 127.0.0.0/8 address, or
// ::1.
func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// TailnetIdentity is the best-effort Tailscale self-identity: DNSName is the
// MagicDNS FQDN without its trailing dot; IPs are the node's tailnet
// addresses. Zero when tailscale is absent or the probe failed.
type TailnetIdentity struct {
	DNSName string
	IPs     []string
}

// DeriveAllowedOrigins builds the allowlist for one daemon: http://<bindHost>:<port>
// (skipped when bindHost is unspecified — 0.0.0.0 / ::), http://<hostname>:<port>
// (and its first DNS label when hostname is qualified), http://<ip>:<port> for
// every non-loopback unicast interface address (IPv6 bracketed), and the
// tailnet DNSName / IPs at the same port. Scheme is http: the daemon serves
// plain HTTP. The one https entry is https://<tailnet DNSName>:443 — the
// origin a browser sends through `tailscale serve`, whose certificate is
// issued for exactly that name. The result is deduplicated and sorted.
func DeriveAllowedOrigins(bindHost string, port int, hostname string, addrs []net.Addr, tailnet TailnetIdentity) []string {
	seen := make(map[string]struct{})
	var out []string
	add := func(host string) {
		if host == "" {
			return
		}
		entry := "http://" + net.JoinHostPort(host, fmt.Sprint(port))
		if _, dup := seen[entry]; !dup {
			seen[entry] = struct{}{}
			out = append(out, entry)
		}
	}

	// An unspecified bind (0.0.0.0 / ::) names no origin — the interface
	// enumeration below covers every concrete address instead.
	if h := strings.Trim(bindHost, "[]"); h != "" && h != "0.0.0.0" && h != "::" {
		add(strings.ToLower(bindHost))
	}
	hostname = strings.ToLower(hostname)
	add(hostname)
	// MagicDNS resolves the short name via the tailnet search domain, so a
	// qualified hostname contributes its first label too.
	if label, _, ok := strings.Cut(hostname, "."); ok {
		add(label)
	}
	for _, addr := range addrs {
		var ip net.IP
		switch a := addr.(type) {
		case *net.IPNet:
			ip = a.IP
		case *net.IPAddr:
			ip = a.IP
		default:
			continue
		}
		// Global unicast only: loopback, link-local, multicast, and the
		// unspecified addresses are not request origins.
		if ip.IsGlobalUnicast() {
			add(ip.String())
		}
	}
	dnsName := strings.TrimSuffix(tailnet.DNSName, ".")
	add(dnsName)
	for _, ip := range tailnet.IPs {
		add(ip)
	}
	if dnsName != "" {
		out = append(out, "https://"+net.JoinHostPort(dnsName, "443"))
	}
	sort.Strings(out)
	return out
}

// LiveTailnetIdentity runs `tailscale status --json` under a bounded
// exec.CommandContext and reads Self.DNSName + Self.TailscaleIPs. A missing
// binary, non-zero exit, timeout, or unparseable output yields the zero
// identity — the route never depends on tailscale being installed, so the
// failure is logged at DEBUG only. This is the only subprocess /mcp adds to
// daemon start (Constitution I: argv slice, explicit timeout).
func LiveTailnetIdentity(ctx context.Context) TailnetIdentity {
	path, err := exec.LookPath("tailscale")
	if err != nil {
		slog.Debug("mcp: tailscale not on PATH; tailnet identity unknown", "err", err)
		return TailnetIdentity{}
	}
	ctx, cancel := context.WithTimeout(ctx, tailscaleProbeTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "status", "--json").Output()
	if err != nil {
		slog.Debug("mcp: tailscale status probe failed; tailnet identity unknown", "err", err)
		return TailnetIdentity{}
	}
	var status struct {
		Self struct {
			DNSName      string   `json:"DNSName"`
			TailscaleIPs []string `json:"TailscaleIPs"`
		} `json:"Self"`
	}
	if err := json.Unmarshal(out, &status); err != nil {
		slog.Debug("mcp: tailscale status output unparseable; tailnet identity unknown", "err", err)
		return TailnetIdentity{}
	}
	return TailnetIdentity{DNSName: status.Self.DNSName, IPs: status.Self.TailscaleIPs}
}
