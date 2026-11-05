package openaimcp

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestRenderedProfileAcceptedByTunnelClient runs the real tunnel-client's
// offline doctor over a rendered key + profile: the profile must load, the
// tunnel ID must parse, and the key must resolve through the profile's file:
// reference with both env-var overrides stripped (the daemon's spawn shape).
// The MCP target is a closed port, so the overall verdict is not asserted.
func TestRenderedProfileAcceptedByTunnelClient(t *testing.T) {
	bin, err := exec.LookPath(BinaryName)
	if err != nil {
		t.Skip("tunnel-client not on PATH; the profile contract needs the real binary")
	}
	l := Layout{Root: filepath.Join(t.TempDir(), "openai-mcp")}
	if err := l.WriteKey(testKey); err != nil {
		t.Fatalf("WriteKey: %v", err)
	}
	if _, err := l.WriteProfile(ProfileInput{TunnelID: "tunnel_0123456789abcdef0123456789abcdef", MCPURL: "http://127.0.0.1:9/mcp"}); err != nil {
		t.Fatalf("WriteProfile: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "doctor", "--profile-dir", l.ProfileDir(), "--profile", ProfileName)
	cmd.Env = withoutKeyEnv(os.Environ())
	out, _ := cmd.CombinedOutput()

	for _, want := range []*regexp.Regexp{
		regexp.MustCompile(`(?m)^CHECK profile_load\s+PASS`),
		regexp.MustCompile(`(?m)^CHECK tunnel_id\s+PASS tunnel_0123456789abcdef0123456789abcdef`),
		regexp.MustCompile(`(?m)^CHECK control_plane_api_key\s+PASS configured$`),
	} {
		if !want.Match(out) {
			t.Errorf("doctor output missing %s:\n%s", want, out)
		}
	}
	if strings.Contains(string(out), testKey) {
		t.Error("doctor output echoed the key")
	}
}

// withoutKeyEnv drops the env vars tunnel-client prefers over the profile key.
func withoutKeyEnv(env []string) []string {
	kept := env[:0:0]
	for _, kv := range env {
		if strings.HasPrefix(kv, "CONTROL_PLANE_API_KEY=") || strings.HasPrefix(kv, "OPENAI_API_KEY=") {
			continue
		}
		kept = append(kept, kv)
	}
	return kept
}
