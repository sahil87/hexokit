package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func originRequest(host string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "http://"+host+"/ws/x", nil)
	r.Host = host
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestCheckSharedWSOrigin(t *testing.T) {
	cases := []struct {
		name    string
		host    string
		headers map[string]string
		want    bool
	}{
		{"absent Origin, absent Sec-Fetch-Site (non-browser client)", "example.com", nil, true},
		{"Origin matching Host", "example.com", map[string]string{"Origin": "http://example.com"}, true},
		{"Origin matching Host with port", "example.com:3000", map[string]string{"Origin": "http://example.com:3000"}, true},
		{"Origin matching first X-Forwarded-Host with mismatched Host", "upstream.internal", map[string]string{
			"Origin":           "https://app.example.com",
			"X-Forwarded-Host": "app.example.com, internal.proxy",
		}, true},
		{"Sec-Fetch-Site same-origin with mismatched Host (Host-rewriting front end)", "upstream.internal", map[string]string{
			"Origin":         "https://app.example.com",
			"Sec-Fetch-Site": "same-origin",
		}, true},
		{"Sec-Fetch-Site cross-site rejected even with matching Origin", "example.com", map[string]string{
			"Origin":         "http://example.com",
			"Sec-Fetch-Site": "cross-site",
		}, false},
		{"Sec-Fetch-Site same-site rejected even with matching Origin", "example.com", map[string]string{
			"Origin":         "http://example.com",
			"Sec-Fetch-Site": "same-site",
		}, false},
		{"cross-site Origin mismatched", "example.com", map[string]string{"Origin": "https://evil.example.net"}, false},
		{"default http port normalized away", "example.com", map[string]string{"Origin": "http://example.com:80"}, true},
		{"default https port normalized away", "example.com", map[string]string{"Origin": "https://example.com:443"}, true},
		{"non-default Origin port against bare Host", "example.com", map[string]string{"Origin": "http://example.com:3000"}, false},
		{"scheme not compared", "example.com", map[string]string{"Origin": "https://example.com"}, true},
		{"IPv6 default http port", "[::1]", map[string]string{"Origin": "http://[::1]"}, true},
		{"IPv6 default https port", "[::1]", map[string]string{"Origin": "https://[::1]"}, true},
		{"IPv6 default port explicit", "[::1]", map[string]string{"Origin": "http://[::1]:80"}, true},
		{"IPv6 explicit port", "[::1]:8080", map[string]string{"Origin": "http://[::1]:8080"}, true},
		{"IPv6 non-default Origin port against bare Host", "[::1]", map[string]string{"Origin": "http://[::1]:3000"}, false},
		{"IPv6 mismatched host", "[::1]", map[string]string{"Origin": "http://[::2]"}, false},
		{"host case-insensitive", "Example.COM", map[string]string{"Origin": "http://example.com"}, true},
		{"malformed Origin", "example.com", map[string]string{"Origin": "not a url"}, false},
		{"null Origin (sandboxed frame)", "example.com", map[string]string{"Origin": "null"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := checkSharedWSOrigin(originRequest(tc.host, tc.headers)); got != tc.want {
				t.Errorf("checkSharedWSOrigin = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCheckTunnelWSOrigin(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		want    bool
	}{
		{"no headers (the desktop main-process client)", nil, true},
		{"any Origin rejected, even rk's own origin", map[string]string{"Origin": "http://127.0.0.1:3000"}, false},
		{"Sec-Fetch-Site same-origin rejected", map[string]string{"Sec-Fetch-Site": "same-origin"}, false},
		{"Sec-Fetch-Site cross-site rejected", map[string]string{"Sec-Fetch-Site": "cross-site"}, false},
		{"both headers rejected", map[string]string{"Origin": "http://example.com", "Sec-Fetch-Site": "same-origin"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := checkTunnelWSOrigin(originRequest("example.com", tc.headers)); got != tc.want {
				t.Errorf("checkTunnelWSOrigin = %v, want %v", got, tc.want)
			}
		})
	}
}
