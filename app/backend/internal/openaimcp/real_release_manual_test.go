package openaimcp

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestInstallRealReleaseManual installs the REAL latest tunnel-client release
// from GitHub into a temp layout and runs the installed binary, so the
// synthetic-archive tests cannot drift from the published asset layout.
// Network-bound; runs only when RK_REAL_TUNNEL_CLIENT=1.
func TestInstallRealReleaseManual(t *testing.T) {
	if os.Getenv("RK_REAL_TUNNEL_CLIENT") != "1" {
		t.Skip("RK_REAL_TUNNEL_CLIENT not set")
	}
	l := Layout{Root: t.TempDir()}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	res, err := NewInstaller().Install(ctx, l)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	out, err := exec.CommandContext(ctx, l.CurrentBinary(), "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("installed binary --version: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), res.Version) {
		t.Errorf("--version output %q does not name installed version %s", out, res.Version)
	}

	if err := l.WriteKey(testKey); err != nil {
		t.Fatal(err)
	}
	if _, err := l.WriteProfile(ProfileInput{TunnelID: "tunnel_0123456789abcdef0123456789abcdef", MCPURL: "http://127.0.0.1:9/mcp"}); err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, l.CurrentBinary(), "doctor", "--profile-dir", l.ProfileDir(), "--profile", ProfileName)
	cmd.Env = withoutKeyEnv(os.Environ())
	doc, _ := cmd.CombinedOutput()
	if !regexp.MustCompile(`(?m)^CHECK control_plane_api_key\s+PASS configured$`).Match(doc) {
		t.Errorf("installed binary rejected the rendered profile:\n%s", doc)
	}
}
