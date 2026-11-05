package openaimcp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789_-AB"

func TestValidateKey(t *testing.T) {
	if msg := ValidateKey(testKey); msg != "" {
		t.Errorf("ValidateKey(valid) = %q", msg)
	}
	for _, bad := range []string{"", "sk-short", "pk-abcdefghijklmnopqrstuvwxyz", "sk-abc def ghijklmnopqrstuvwxyz", "sk-abcdefghijklmnopqrstuvwxyz\n", "sk-abcdefghijklmnopqrstuv\"wxyz"} {
		if msg := ValidateKey(bad); msg == "" {
			t.Errorf("ValidateKey(%q) = valid, want rejection", bad)
		}
	}
}

func TestKeyFileLifecycle(t *testing.T) {
	l := Layout{Root: filepath.Join(t.TempDir(), "openai-mcp")}
	if l.KeySet() {
		t.Fatal("KeySet() before any write = true")
	}

	if err := l.WriteKey("sk-bad"); err == nil {
		t.Fatal("WriteKey(invalid) = nil error")
	}
	if _, err := os.Stat(l.KeyPath()); !os.IsNotExist(err) {
		t.Fatalf("invalid key touched disk: stat err %v", err)
	}

	if err := l.WriteKey(testKey); err != nil {
		t.Fatalf("WriteKey: %v", err)
	}
	info, err := os.Stat(l.KeyPath())
	if err != nil {
		t.Fatalf("stat key: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("key file mode = %o, want 600", mode)
	}
	dirInfo, err := os.Stat(l.Root)
	if err != nil {
		t.Fatalf("stat root: %v", err)
	}
	if mode := dirInfo.Mode().Perm(); mode != 0o700 {
		t.Errorf("root dir mode = %o, want 700", mode)
	}
	data, _ := os.ReadFile(l.KeyPath())
	if string(data) != testKey+"\n" {
		t.Errorf("key file = %q, want the key and a newline", data)
	}
	if !l.KeySet() {
		t.Error("KeySet() after write = false")
	}

	if err := l.ClearKey(); err != nil {
		t.Fatalf("ClearKey: %v", err)
	}
	if l.KeySet() {
		t.Error("KeySet() after clear = true")
	}
	if err := l.ClearKey(); err != nil {
		t.Errorf("ClearKey on a missing file = %v, want nil", err)
	}
}

func TestKeySetIgnoresBlankFile(t *testing.T) {
	l := Layout{Root: t.TempDir()}
	if err := os.WriteFile(l.KeyPath(), []byte(" \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if l.KeySet() {
		t.Error("KeySet() on a whitespace-only file = true")
	}
}

func TestMCPURL(t *testing.T) {
	cases := []struct {
		host string
		want string
	}{
		{"127.0.0.1", "http://127.0.0.1:6123/mcp"},
		{"", "http://127.0.0.1:6123/mcp"},
		{"0.0.0.0", "http://127.0.0.1:6123/mcp"},
		{"::", "http://127.0.0.1:6123/mcp"},
		{"100.64.0.1", "http://100.64.0.1:6123/mcp"},
		{"2001:db8::1", "http://[2001:db8::1]:6123/mcp"},
		{"localhost", "http://localhost:6123/mcp"},
	}
	for _, c := range cases {
		if got := MCPURL(c.host, 6123); got != c.want {
			t.Errorf("MCPURL(%q) = %q, want %q", c.host, got, c.want)
		}
	}
}

func TestWriteProfile(t *testing.T) {
	root := filepath.Join(t.TempDir(), "state dir", "openai-mcp")
	l := Layout{Root: root}
	in := ProfileInput{TunnelID: "tunnel_0123456789abcdef0123456789abcdef", MCPURL: "http://127.0.0.1:6123/mcp"}
	if _, err := l.WriteProfile(in); err != nil {
		t.Fatalf("WriteProfile: %v", err)
	}
	if got, want := l.ProfilePath(), filepath.Join(root, "profile", ProfileName+".yaml"); got != want {
		t.Errorf("ProfilePath() = %q, want %q", got, want)
	}
	info, err := os.Stat(l.ProfilePath())
	if err != nil {
		t.Fatalf("stat profile: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("profile mode = %o, want 600", mode)
	}
	data, _ := os.ReadFile(l.ProfilePath())
	want := `config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: "tunnel_0123456789abcdef0123456789abcdef"
  api_key: "file:` + root + `/api-key"
health:
  listen_addr: "127.0.0.1:0"
  url_file: "` + root + `/health.url"
admin_ui:
  open_browser: false
log:
  level: info
  format: json
mcp:
  startup_wait_timeout: "60s"
  server_urls:
    - channel: main
      url: "http://127.0.0.1:6123/mcp"
`
	if string(data) != want {
		t.Errorf("profile =\n%s\nwant\n%s", data, want)
	}
	if strings.Contains(string(data), "sk-") {
		t.Error("profile contains key material")
	}
}

func TestWriteProfileEscapesPaths(t *testing.T) {
	l := Layout{Root: filepath.Join(t.TempDir(), `we"ird`)}
	if _, err := l.WriteProfile(ProfileInput{TunnelID: "tunnel_a1", MCPURL: "http://127.0.0.1:1/mcp"}); err != nil {
		t.Fatalf("WriteProfile: %v", err)
	}
	data, _ := os.ReadFile(l.ProfilePath())
	if !strings.Contains(string(data), `we\"ird`) {
		t.Errorf("a quote in the path must be escaped inside the YAML string:\n%s", data)
	}
}

func TestWriteProfileReportsChange(t *testing.T) {
	l := Layout{Root: t.TempDir()}
	in := ProfileInput{TunnelID: "tunnel_a1", MCPURL: "http://127.0.0.1:6123/mcp"}
	if changed, err := l.WriteProfile(in); err != nil || !changed {
		t.Fatalf("first write = %v, %v; want changed", changed, err)
	}
	if changed, err := l.WriteProfile(in); err != nil || changed {
		t.Errorf("identical rewrite = %v, %v; want unchanged", changed, err)
	}
	in.MCPURL = "http://127.0.0.1:7001/mcp"
	if changed, err := l.WriteProfile(in); err != nil || !changed {
		t.Errorf("new port = %v, %v; want changed", changed, err)
	}
}
