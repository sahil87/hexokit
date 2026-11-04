package mcp

import (
	"context"
	"net"
	"reflect"
	"testing"

	"rk/internal/testutil"
)

// TestOriginPolicyAllows drives the allowlist: exact matches (case-folded,
// default-port-filled), the loopback exception at any port and either scheme,
// and every rejection shape — path/query/fragment/userinfo/non-http(s), and
// the DNS-rebinding shape (Origin equal to a crafted Host, neither
// allowlisted).
func TestOriginPolicyAllows(t *testing.T) {
	policy := NewOriginPolicy([]string{"http://box:3000"})
	cases := []struct {
		name   string
		origin string
		want   bool
	}{
		{"exact entry", "http://box:3000", true},
		{"case-folded host", "http://BOX:3000", true},
		{"default port fill (policy side)", "http://box:3000", true},
		{"loopback ip arbitrary port", "http://127.0.0.1:5173", true},
		{"loopback 127/8 non-.1", "http://127.34.0.9:8080", true},
		{"localhost no port", "http://localhost", true},
		{"localhost https", "https://localhost:8443", true},
		{"ipv6 loopback", "http://[::1]:9999", true},
		{"rebinding shape (origin == host, unlisted)", "http://evil.example:3000", false},
		{"unlisted host", "http://other:3000", false},
		{"unlisted port", "http://box:4000", false},
		{"scheme mismatch", "https://box:3000", false},
		{"path rejected", "http://box:3000/path", false},
		{"query rejected", "http://box:3000?x=1", false},
		{"fragment rejected", "http://box:3000#f", false},
		{"userinfo rejected", "http://user@box:3000", false},
		{"non-http scheme rejected", "ftp://box:3000", false},
		{"garbage rejected", "not an origin", false},
		{"empty rejected", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := policy.Allows(c.origin); got != c.want {
				t.Errorf("Allows(%q) = %v, want %v", c.origin, got, c.want)
			}
		})
	}
}

// TestOriginPolicyDefaultPortEquivalence: an entry listed without a port is
// the scheme-default port, so http://box and http://box:80 are one entry.
func TestOriginPolicyDefaultPortEquivalence(t *testing.T) {
	policy := NewOriginPolicy([]string{"http://box"})
	if !policy.Allows("http://box:80") {
		t.Error("http://box:80 must match the http://box entry (default-port fill)")
	}
	if policy.Allows("http://box:81") {
		t.Error("http://box:81 must not match the http://box entry")
	}
	if got, want := policy.Origins(), []string{"http://box:80"}; !reflect.DeepEqual(got, want) {
		t.Errorf("Origins() = %v, want %v", got, want)
	}
}

// TestOriginPolicyIPv6: IPv6 entries stay bracketed and match only bracketed
// IPv6 origins.
func TestOriginPolicyIPv6(t *testing.T) {
	policy := NewOriginPolicy([]string{"http://[fd7a:115c:a1e0::1]:3000"})
	if !policy.Allows("http://[fd7a:115c:a1e0::1]:3000") {
		t.Error("bracketed IPv6 origin must match")
	}
	if got, want := policy.Origins(), []string{"http://[fd7a:115c:a1e0::1]:3000"}; !reflect.DeepEqual(got, want) {
		t.Errorf("Origins() = %v, want %v", got, want)
	}
}

// TestDeriveAllowedOriginsFull is the R3 derivation scenario: an unspecified
// bind host contributes nothing, the qualified hostname yields FQDN + first
// label, loopback/link-local interface addresses are excluded, IPv6 is
// bracketed, and the tailnet identity folds in without duplicating.
func TestDeriveAllowedOriginsFull(t *testing.T) {
	addrs := []net.Addr{
		&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)},
		&net.IPNet{IP: net.ParseIP("100.64.1.2"), Mask: net.CIDRMask(32, 32)},
		&net.IPNet{IP: net.ParseIP("fe80::1"), Mask: net.CIDRMask(64, 128)},
		&net.IPNet{IP: net.ParseIP("fd7a:115c:a1e0::1"), Mask: net.CIDRMask(128, 128)},
		&net.IPAddr{IP: net.ParseIP("224.0.0.1")},
	}
	got := DeriveAllowedOrigins("0.0.0.0", 3000, "Box.tail1234.ts.net", addrs,
		TailnetIdentity{DNSName: "box.tail1234.ts.net.", IPs: []string{"100.64.1.2"}})
	want := []string{
		"http://100.64.1.2:3000",
		"http://[fd7a:115c:a1e0::1]:3000",
		"http://box.tail1234.ts.net:3000",
		"http://box:3000",
		"https://box.tail1234.ts.net:443",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DeriveAllowedOrigins = %v, want %v", got, want)
	}
	// The browser origin through `tailscale serve` carries no port.
	if !NewOriginPolicy(got).Allows("https://box.tail1234.ts.net") {
		t.Errorf("derived policy rejects https://box.tail1234.ts.net")
	}
}

// TestDeriveAllowedOriginsLoopbackBind: a loopback bind host is itself an
// entry; an unqualified hostname contributes no extra label; no addrs and a
// zero tailnet identity add nothing (no https entry either).
func TestDeriveAllowedOriginsLoopbackBind(t *testing.T) {
	got := DeriveAllowedOrigins("127.0.0.1", 3000, "box", nil, TailnetIdentity{})
	want := []string{"http://127.0.0.1:3000", "http://box:3000"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("DeriveAllowedOrigins = %v, want %v", got, want)
	}
}

// TestDeriveAllowedOriginsUnspecifiedBindHosts: every unspecified bind shape
// (empty, 0.0.0.0, ::, [::]) contributes no entry.
func TestDeriveAllowedOriginsUnspecifiedBindHosts(t *testing.T) {
	for _, bind := range []string{"", "0.0.0.0", "::", "[::]"} {
		got := DeriveAllowedOrigins(bind, 3000, "", nil, TailnetIdentity{})
		if len(got) != 0 {
			t.Errorf("bind %q: got %v, want no entries", bind, got)
		}
	}
}

// TestLiveTailnetIdentityMissingBinary: with no tailscale on PATH the probe
// returns the zero identity without error.
func TestLiveTailnetIdentityMissingBinary(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if got := LiveTailnetIdentity(context.Background()); !reflect.DeepEqual(got, TailnetIdentity{}) {
		t.Errorf("LiveTailnetIdentity = %+v, want zero", got)
	}
}

// TestLiveTailnetIdentityProbe: a stub tailscale answers the probe;
// unparseable output degrades to the zero identity.
func TestLiveTailnetIdentityProbe(t *testing.T) {
	dir := t.TempDir()
	testutil.WriteStub(t, dir, "tailscale", "#!/bin/sh\necho '{\"Self\":{\"DNSName\":\"box.tail1234.ts.net.\",\"TailscaleIPs\":[\"100.64.1.2\",\"fd7a:115c:a1e0::1\"]}}'\n")
	t.Setenv("PATH", dir)
	got := LiveTailnetIdentity(context.Background())
	want := TailnetIdentity{DNSName: "box.tail1234.ts.net.", IPs: []string{"100.64.1.2", "fd7a:115c:a1e0::1"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("LiveTailnetIdentity = %+v, want %+v", got, want)
	}

	testutil.WriteStub(t, dir, "tailscale", "#!/bin/sh\necho 'not json'\n")
	got = LiveTailnetIdentity(context.Background())
	if !reflect.DeepEqual(got, TailnetIdentity{}) {
		t.Errorf("unparseable output: LiveTailnetIdentity = %+v, want zero", got)
	}
}
