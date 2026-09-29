// Package present resolves `rk present` targets and derives the
// @rk_win_web_<n> slot value each target kind attaches to a tmux window. It is
// pure (no tmux, no HTTP): the only I/O is os.Stat for file/dir classification
// and a TCP dial for the reachability probe, so every rule is unit-testable
// without a live server.
//
// The target kinds:
//
//	file          existing regular file   → /present/<server>/<roothash>/<base>?v=<bust>
//	dir           existing directory      → /present/<server>/<roothash>/?v=<bust>
//	port          ":NNNN"                 → /proxy/<port>/
//	site-relative matching server URL      → /<path+query>
//	local URL     http://localhost…       → /proxy/<port>/<path+query>
//	external URL  any other http(s) URL   → attached verbatim
//
// File/dir targets also carry a serve Root (the file's parent dir / the dir
// itself) stored as the @rk_win_web_<n>_root window option; the
// /present/{server}/{roothash}/* route hashes the ABSOLUTE root directory
// into the content-keyed (server, roothash, path) form. The slot index
// falls out of the URL — it is the family position, not part of the
// content identity.
package present

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Kind classifies a parsed target.
type Kind int

const (
	KindFile         Kind = iota // existing regular file
	KindDir                      // existing directory
	KindPort                     // ":NNNN"
	KindSiteRelative             // absolute URL on the run-kit server's origin
	KindLocalURL                 // absolute http:// URL on a localhost host
	KindExternalURL              // any other absolute http(s):// URL
)

// String names the kind, for diagnostics.
func (k Kind) String() string {
	switch k {
	case KindFile:
		return "file"
	case KindDir:
		return "dir"
	case KindPort:
		return "port"
	case KindSiteRelative:
		return "site-relative"
	case KindLocalURL:
		return "local URL"
	case KindExternalURL:
		return "external URL"
	}
	return "unknown"
}

// portPattern is the ":NNNN" target form (colon + digits, nothing else).
var portPattern = regexp.MustCompile(`^:([0-9]+)$`)

// localhostHosts is the closed set of URL hosts whose targets rewrite to the
// relative /proxy/<port>/ form (Hostname() strips brackets, so "::1" covers
// the "[::1]" literal).
var localhostHosts = map[string]bool{
	"localhost": true,
	"127.0.0.1": true,
	"::1":       true,
}

// Target is a resolved `rk present` argument.
type Target struct {
	Kind Kind
	// Root is the absolute serve root — the file's parent directory or the
	// directory itself. Set for KindFile/KindDir only; stored as the
	// @rk_win_web_<n>_root window option beside the slot's URL.
	Root string
	// Name is the display basename for the target: the file/dir base name,
	// "port-<port>" for port/local-URL targets, the hostname for external
	// URLs. Window-name derivation sanitizes it at the command layer.
	Name string
	// Port is the TCP port for KindPort/KindLocalURL (default 80).
	Port int
	// PathQuery is the original path+query (leading "/") for
	// KindSiteRelative/KindLocalURL.
	PathQuery string
	// Verbatim is the original URL, attached unchanged, for KindExternalURL.
	Verbatim string
}

// ParseTarget resolves one CLI argument to a Target. cwd is the base for
// relative paths. A path that does not exist (and parses as neither a port
// nor an absolute URL) is an error.
func ParseTarget(arg, cwd string) (Target, error) {
	return ParseTargetWithOrigins(arg, cwd, nil)
}

// ParseTargetWithOrigins resolves one CLI argument and treats URLs matching
// any supplied server origin as site-relative frontend paths.
func ParseTargetWithOrigins(arg, cwd string, origins []string) (Target, error) {
	if m := portPattern.FindStringSubmatch(arg); m != nil {
		port, err := parsePort(m[1])
		if err != nil {
			return Target{}, fmt.Errorf("invalid port target %q: %w", arg, err)
		}
		return Target{Kind: KindPort, Port: port, Name: fmt.Sprintf("port-%d", port)}, nil
	}

	if strings.HasPrefix(arg, "http://") || strings.HasPrefix(arg, "https://") {
		u, err := url.Parse(arg)
		if err != nil || u.Host == "" {
			return Target{}, fmt.Errorf("invalid URL %q", arg)
		}
		if matchesOrigin(u, origins) {
			pathQuery := u.RequestURI()
			if pathQuery == "" || pathQuery[0] != '/' {
				pathQuery = "/" + pathQuery
			}
			name := "site"
			if first := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")[0]; first != "" {
				name = first
			}
			return Target{Kind: KindSiteRelative, PathQuery: pathQuery, Name: name}, nil
		}
		// Only plaintext http on a localhost host rewrites to the relative
		// proxy form; https (even to localhost) and any remote host attach
		// verbatim — the proxy targets local http services only.
		// Hostnames are case-insensitive; the frontend's WHATWG URL parser
		// lowercases them, so match lowercased here too (web-url.ts mirrors this set).
		if u.Scheme == "http" && localhostHosts[strings.ToLower(u.Hostname())] {
			port := 80
			if p := u.Port(); p != "" {
				n, err := parsePort(p)
				if err != nil {
					return Target{}, fmt.Errorf("invalid port in URL %q: %w", arg, err)
				}
				port = n
			}
			return Target{
				Kind:      KindLocalURL,
				Port:      port,
				PathQuery: u.RequestURI(),
				Name:      fmt.Sprintf("port-%d", port),
			}, nil
		}
		name := u.Hostname()
		if name == "" {
			name = "external"
		}
		return Target{Kind: KindExternalURL, Verbatim: arg, Name: name}, nil
	}

	path := arg
	if !filepath.IsAbs(path) {
		path = filepath.Join(cwd, path)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return Target{}, fmt.Errorf("resolve %q: %w", arg, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return Target{}, fmt.Errorf("target %q does not exist", arg)
	}
	if info.IsDir() {
		return Target{Kind: KindDir, Root: abs, Name: filepath.Base(abs)}, nil
	}
	if !info.Mode().IsRegular() {
		return Target{}, fmt.Errorf("target %q is not a regular file or directory", arg)
	}
	return Target{Kind: KindFile, Root: filepath.Dir(abs), Name: filepath.Base(abs)}, nil
}

func matchesOrigin(target *url.URL, origins []string) bool {
	for _, raw := range origins {
		origin, err := url.Parse(raw)
		if err == nil && origin.Host != "" &&
			strings.EqualFold(target.Scheme, origin.Scheme) &&
			strings.EqualFold(target.Host, origin.Host) {
			return true
		}
	}
	return false
}

// parsePort validates a decimal port string.
func parsePort(s string) (int, error) {
	port, err := strconv.Atoi(s)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("port %q out of range 1-65535", s)
	}
	return port, nil
}

// RootHashLen bounds the composed root hash: PresentURL writes this many
// lowercase hex chars of the sha256 of the ABSOLUTE root directory path. The
// /present/ route accepts any 8–64 hex prefix (the sha256 is 64) matching
// exactly one declared root — an identifier, never a secret.
const RootHashLen = 12

// RootHash derives the content-keyed present address's root segment: the
// lowercase-hex sha256 of the absolute root directory path, prefix-composed
// at RootHashLen. PresentURL and the /present/ route both use it, so the
// stored value and the request-time match agree (the route matches its own
// full digest against incoming prefixes via strings.HasPrefix).
func RootHash(root string) string {
	sum := sha256.Sum256([]byte(root))
	return hex.EncodeToString(sum[:])[:RootHashLen]
}

// PresentURL composes the @rk_win_web_<n> slot value for a file/dir target —
// the content-keyed (server, roothash, path) form the /present/ route demands
// (Intake § 1). root is the absolute serve root (the file's parent dir or the
// dir itself) — hashed by RootHash into the segment. server is the tmux
// server name promoted from the removed ?server= param into the path (the
// ?v= cache-buster remains the only query param; any left on the request is
// inert slot plumbing the route ignores). The `?v=` buster (unix seconds,
// supplied by now) makes re-presenting the same target a refresh: the new
// slot value differs and an open web tile re-navigates. name is the file
// basename, or empty for a directory target (serves the root's index.html).
// The form is always relative — never an absolute origin.
func PresentURL(name, root, server string, now func() int64) string {
	path := fmt.Sprintf("/present/%s/%s/", server, RootHash(root))
	if name != "" {
		path += url.PathEscape(name)
	}
	return fmt.Sprintf("%s?v=%d", path, now())
}

// BumpVersion returns the /present/ URL with its `?v=` cache-buster replaced by
// now — the re-present-is-refresh contract applied to an already-stored slot
// value. Non-/present/ URLs (and unparseable ones) are returned verbatim.
func BumpVersion(raw string, now func() int64) string {
	u, err := url.Parse(raw)
	if err != nil || !strings.HasPrefix(u.Path, "/present/") {
		return raw
	}
	q := u.Query()
	q.Set("v", strconv.FormatInt(now(), 10))
	u.RawQuery = q.Encode()
	return u.String()
}

// URL derives the @rk_win_web_<n> slot value for this target. server names
// the tmux server the /present/ route scopes to — file/dir kinds embed it in
// the content-keyed form (with root hashed into the roothash segment); other
// kinds ignore it. now supplies the unix-seconds cache-buster for /present/
// URLs only; port/URL targets re-set verbatim with no buster.
func (t Target) URL(server, root string, now func() int64) string {
	switch t.Kind {
	case KindFile:
		return PresentURL(t.Name, root, server, now)
	case KindDir:
		return PresentURL("", root, server, now)
	case KindPort:
		return fmt.Sprintf("/proxy/%d/", t.Port)
	case KindSiteRelative:
		pq := t.PathQuery
		if pq == "" || pq[0] != '/' {
			pq = "/" + pq
		}
		return pq
	case KindLocalURL:
		pq := t.PathQuery
		if pq == "" || pq[0] != '/' {
			pq = "/" + pq
		}
		return fmt.Sprintf("/proxy/%d%s", t.Port, pq)
	default: // KindExternalURL
		return t.Verbatim
	}
}

// NeedsRoot reports whether the target carries a serve root
// (@rk_win_web_<n>_root) — file and directory targets only.
func (t Target) NeedsRoot() bool {
	return t.Kind == KindFile || t.Kind == KindDir
}

// NeedsProbe reports whether the target gets a best-effort TCP reachability
// probe — port and local-URL targets only; file/dir/external never probe.
func (t Target) NeedsProbe() bool {
	return t.Kind == KindPort || t.Kind == KindLocalURL
}

// ProbeTimeout bounds the TCP reachability probe for port/local-URL targets.
const ProbeTimeout = 1 * time.Second

// ProbePort dials 127.0.0.1:<port> with a short timeout. Connection refused
// or timeout is an operational failure naming the port.
func ProbePort(ctx context.Context, port int) error {
	d := net.Dialer{Timeout: ProbeTimeout}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return fmt.Errorf("nothing is listening on port %d (127.0.0.1): %w", port, err)
	}
	_ = conn.Close()
	return nil
}
