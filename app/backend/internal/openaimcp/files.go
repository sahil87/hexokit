package openaimcp

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"rk/internal/apphome"
	"rk/internal/fsatomic"
)

// ProfileName is the tunnel-client profile the daemon writes and runs
// (`tunnel-client run --profile-dir <ProfileDir> --profile <ProfileName>`).
const ProfileName = "openai-mcp"

// BinaryName is the executable inside a tunnel-client release archive and
// the name looked up on PATH when no managed install exists.
const BinaryName = "tunnel-client"

// startupWaitTimeout bounds how long tunnel-client waits for /mcp before its
// first control-plane poll. Without the wait, a tunnel-client that starts
// while /mcp is unreachable logs "startup catalog failed; control-plane
// polling disabled" and never polls.
const startupWaitTimeout = "60s"

// Layout is the connector's file layout under one root, <state>/openai-mcp
// in production (DefaultLayout) and a temp dir in tests.
type Layout struct {
	Root string
}

// DefaultLayout resolves the layout under the state home.
func DefaultLayout() (Layout, error) {
	root, err := apphome.OpenAIMCPDir()
	if err != nil {
		return Layout{}, err
	}
	return Layout{Root: root}, nil
}

// KeyPath is the 0600 runtime API key file. No route ever reads it back.
func (l Layout) KeyPath() string { return filepath.Join(l.Root, "api-key") }

// BinDir holds one <version>/ dir per installed release plus `current`.
func (l Layout) BinDir() string { return filepath.Join(l.Root, "bin") }

// CurrentBinary is the managed install's executable through `current`.
func (l Layout) CurrentBinary() string {
	return filepath.Join(l.BinDir(), "current", BinaryName)
}

// ProfileDir is tunnel-client's --profile-dir.
func (l Layout) ProfileDir() string { return filepath.Join(l.Root, "profile") }

// ProfilePath is the derived profile, regenerated on every ensure.
func (l Layout) ProfilePath() string {
	return filepath.Join(l.ProfileDir(), ProfileName+".yaml")
}

// HealthURLPath is where tunnel-client writes its resolved health base URL
// (the health listener binds an ephemeral loopback port).
func (l Layout) HealthURLPath() string { return filepath.Join(l.Root, "health.url") }

// keyPattern is the shape of an OpenAI API key. The charset is closed so a
// key can never smuggle a newline or quote into the file tunnel-client reads.
var keyPattern = regexp.MustCompile(`^sk-[A-Za-z0-9_-]{20,}$`)

// ValidateKey returns "" for a well-formed API key, else a one-line reason.
func ValidateKey(key string) string {
	if !keyPattern.MatchString(key) {
		return "API key must look like sk-… (an OpenAI runtime key with Tunnels Read + Use)"
	}
	return ""
}

// WriteKey validates key, then writes it with a trailing newline to KeyPath
// (file 0600, root dir 0700). An invalid key never touches disk.
func (l Layout) WriteKey(key string) error {
	if msg := ValidateKey(key); msg != "" {
		return errors.New(msg)
	}
	if err := os.MkdirAll(l.Root, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", l.Root, err)
	}
	return fsatomic.WriteFile(l.KeyPath(), []byte(key+"\n"), 0o600)
}

// ClearKey removes the key file; a missing file is not an error.
func (l Layout) ClearKey() error {
	if err := os.Remove(l.KeyPath()); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// KeySet reports whether the key file exists with non-blank content. It is
// the only fact about the key any caller outside this package learns.
func (l Layout) KeySet() bool {
	data, err := os.ReadFile(l.KeyPath())
	return err == nil && strings.TrimSpace(string(data)) != ""
}

// MCPURL is the /mcp address tunnel-client forwards to: the daemon's bind
// host and port, with an unspecified bind (empty, 0.0.0.0, ::) mapped to
// loopback, which every bind serves.
func MCPURL(host string, port int) string {
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port)) + "/mcp"
}

// ProfileInput is everything the derived profile varies on.
type ProfileInput struct {
	TunnelID string
	MCPURL   string
}

// WriteProfile renders the tunnel-client profile for in and writes it to
// ProfilePath (file 0600, dirs 0700) when the content differs from the file
// on disk. changed reports whether it did, so a running tunnel-client can be
// restarted onto a new profile. The key is referenced by path, never
// embedded.
func (l Layout) WriteProfile(in ProfileInput) (changed bool, err error) {
	want := l.renderProfile(in)
	if have, err := os.ReadFile(l.ProfilePath()); err == nil && bytes.Equal(have, want) {
		return false, nil
	}
	if err := os.MkdirAll(l.ProfileDir(), 0o700); err != nil {
		return false, fmt.Errorf("create %s: %w", l.ProfileDir(), err)
	}
	if err := fsatomic.WriteFile(l.ProfilePath(), want, 0o600); err != nil {
		return false, err
	}
	return true, nil
}

func (l Layout) renderProfile(in ProfileInput) []byte {
	var b strings.Builder
	b.WriteString("config_version: 1\n")
	b.WriteString("control_plane:\n")
	b.WriteString("  base_url: \"https://api.openai.com\"\n")
	b.WriteString("  tunnel_id: " + strconv.Quote(in.TunnelID) + "\n")
	b.WriteString("  api_key: " + strconv.Quote("file:"+l.KeyPath()) + "\n")
	b.WriteString("health:\n")
	b.WriteString("  listen_addr: \"127.0.0.1:0\"\n")
	b.WriteString("  url_file: " + strconv.Quote(l.HealthURLPath()) + "\n")
	b.WriteString("admin_ui:\n")
	b.WriteString("  open_browser: false\n")
	b.WriteString("log:\n")
	b.WriteString("  level: info\n")
	b.WriteString("  format: json\n")
	b.WriteString("mcp:\n")
	b.WriteString("  startup_wait_timeout: " + strconv.Quote(startupWaitTimeout) + "\n")
	b.WriteString("  server_urls:\n")
	b.WriteString("    - channel: main\n")
	b.WriteString("      url: " + strconv.Quote(in.MCPURL) + "\n")
	return []byte(b.String())
}
