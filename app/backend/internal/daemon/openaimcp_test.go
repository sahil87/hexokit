package daemon

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"rk/internal/openaimcp"
)

const testOpenAIKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"

type openAIMCPSeamRec struct {
	existsProbes int
	spawnArgs    [][]string
	killArgs     [][]string
	jobs         []struct {
		window string
		argv   []string
	}
	layout openaimcp.Layout
}

// withOpenAIMCPSeams substitutes the session, spawn, kill, look-path, job,
// self-path, and layout seams for one test. The layout is rooted in a temp
// dir; PATH lookups fail unless onPath names the binary.
func withOpenAIMCPSeams(t *testing.T, sessionExists bool, onPath string) *openAIMCPSeamRec {
	t.Helper()
	rec := &openAIMCPSeamRec{layout: openaimcp.Layout{Root: filepath.Join(t.TempDir(), "openai-mcp")}}
	origExists, origSpawn, origKill := openAIMCPSessionExists, openAIMCPSpawn, openAIMCPKillRun
	origLook, origJob, origSelf, origLayout := openAIMCPLookPath, openAIMCPRunJob, openAIMCPSelfPath, openAIMCPLayout
	origDaemonUp := jobDaemonRunning
	t.Cleanup(func() {
		openAIMCPSessionExists, openAIMCPSpawn, openAIMCPKillRun = origExists, origSpawn, origKill
		openAIMCPLookPath, openAIMCPRunJob, openAIMCPSelfPath, openAIMCPLayout = origLook, origJob, origSelf, origLayout
		jobDaemonRunning = origDaemonUp
	})
	jobDaemonRunning = func(context.Context) bool { return true }
	openAIMCPSessionExists = func(context.Context) bool { rec.existsProbes++; return sessionExists }
	openAIMCPSpawn = func(_ context.Context, args ...string) error {
		rec.spawnArgs = append(rec.spawnArgs, append([]string(nil), args...))
		return nil
	}
	openAIMCPKillRun = func(_ context.Context, args ...string) error {
		rec.killArgs = append(rec.killArgs, append([]string(nil), args...))
		return nil
	}
	openAIMCPLookPath = func(name string) (string, error) {
		if onPath != "" && name == openaimcp.BinaryName {
			return onPath, nil
		}
		return "", errors.New("not found")
	}
	openAIMCPRunJob = func(_ context.Context, window string, argv []string) (JobTarget, bool, error) {
		rec.jobs = append(rec.jobs, struct {
			window string
			argv   []string
		}{window, append([]string(nil), argv...)})
		return JobTarget{Window: window}, true, nil
	}
	openAIMCPSelfPath = func() (string, error) { return "/opt/rk dir/rk", nil }
	openAIMCPLayout = func() (openaimcp.Layout, error) { return rec.layout, nil }
	t.Setenv("RK_PORT", "6123")
	t.Setenv("RK_HOST", "127.0.0.1")
	return rec
}

// withOpenAIMCPSetting isolates the settings root and writes the connector
// keys. An empty tunnelID leaves the key out.
func withOpenAIMCPSetting(t *testing.T, enabled bool, tunnelID string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("RK_CONFIG_DIR", dir)
	var b strings.Builder
	if enabled {
		b.WriteString("openai_mcp.enabled: true\n")
	}
	if tunnelID != "" {
		b.WriteString("openai_mcp.tunnel_id: \"" + tunnelID + "\"\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

func installManagedTunnelClient(t *testing.T, l openaimcp.Layout) string {
	t.Helper()
	dir := filepath.Join(l.BinDir(), "0.0.19")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, openaimcp.BinaryName), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("0.0.19", filepath.Join(l.BinDir(), "current")); err != nil {
		t.Fatal(err)
	}
	return l.CurrentBinary()
}

func TestEnsureOpenAIMCPDisabledTouchesNothing(t *testing.T) {
	withOpenAIMCPSetting(t, false, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, false, "/usr/bin/tunnel-client")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	outcome, err := ensureOpenAIMCPCore(openAIMCPDaemonStart)
	if err != nil || outcome != OpenAIMCPEnsureDisabled {
		t.Fatalf("ensure = %v, %v; want disabled, nil", outcome, err)
	}
	if rec.existsProbes != 0 || len(rec.spawnArgs) != 0 || len(rec.jobs) != 0 {
		t.Errorf("disabled ensure touched tmux: probes %d, spawns %d, jobs %d", rec.existsProbes, len(rec.spawnArgs), len(rec.jobs))
	}
}

func TestEnsureOpenAIMCPUnconfigured(t *testing.T) {
	t.Run("no tunnel ID", func(t *testing.T) {
		withOpenAIMCPSetting(t, true, "")
		rec := withOpenAIMCPSeams(t, false, "/usr/bin/tunnel-client")
		if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
			t.Fatal(err)
		}
		if outcome, err := ensureOpenAIMCPCore(openAIMCPDaemonStart); err != nil || outcome != OpenAIMCPEnsureUnconfigured {
			t.Fatalf("daemon ensure = %v, %v; want unconfigured, nil", outcome, err)
		}
		if _, err := ensureOpenAIMCPCore(openAIMCPFromCLI); err == nil || !strings.Contains(err.Error(), "tunnel ID") {
			t.Errorf("cli ensure err = %v, want one naming the tunnel ID", err)
		}
		if len(rec.spawnArgs) != 0 {
			t.Errorf("spawned while unconfigured: %v", rec.spawnArgs)
		}
	})
	t.Run("no key", func(t *testing.T) {
		withOpenAIMCPSetting(t, true, "tunnel_abc123")
		rec := withOpenAIMCPSeams(t, false, "/usr/bin/tunnel-client")
		if outcome, err := ensureOpenAIMCPCore(openAIMCPDaemonStart); err != nil || outcome != OpenAIMCPEnsureUnconfigured {
			t.Fatalf("daemon ensure = %v, %v; want unconfigured, nil", outcome, err)
		}
		if _, err := ensureOpenAIMCPCore(openAIMCPFromCLI); err == nil || !strings.Contains(err.Error(), "API key") {
			t.Errorf("cli ensure err = %v, want one naming the API key", err)
		}
		if len(rec.spawnArgs) != 0 {
			t.Errorf("spawned without a key: %v", rec.spawnArgs)
		}
	})
}

func TestEnsureOpenAIMCPAlreadyRunning(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, true, "/usr/bin/tunnel-client")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	// The running session's profile matches what ensure would derive.
	if _, err := rec.layout.WriteProfile(openaimcp.ProfileInput{TunnelID: "tunnel_abc123", MCPURL: "http://127.0.0.1:6123/mcp"}); err != nil {
		t.Fatal(err)
	}
	if outcome, err := ensureOpenAIMCPCore(openAIMCPDaemonStart); err != nil || outcome != OpenAIMCPEnsureAlreadyRunning {
		t.Fatalf("ensure = %v, %v; want already running", outcome, err)
	}
	if len(rec.spawnArgs) != 0 {
		t.Errorf("spawned over a live session: %v", rec.spawnArgs)
	}
}

func TestEnsureOpenAIMCPBinaryMissing(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, false, "")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}

	if _, err := ensureOpenAIMCPCore(openAIMCPFromCLI); !errors.Is(err, errOpenAIMCPMissing) {
		t.Fatalf("cli ensure err = %v, want errOpenAIMCPMissing", err)
	}
	if len(rec.jobs) != 0 {
		t.Fatalf("cli posture spawned an install job: %v", rec.jobs)
	}

	outcome, err := ensureOpenAIMCPCore(openAIMCPDaemonStart)
	if err != nil || outcome != OpenAIMCPEnsureInstallJobSpawned {
		t.Fatalf("daemon ensure = %v, %v; want install job spawned", outcome, err)
	}
	if len(rec.jobs) != 1 || rec.jobs[0].window != OpenAIMCPInstallJobWindow {
		t.Fatalf("jobs = %+v, want one %s window", rec.jobs, OpenAIMCPInstallJobWindow)
	}
	wantArgv := []string{`'/opt/rk dir/rk' openai-mcp install && '/opt/rk dir/rk' openai-mcp start`}
	if !reflect.DeepEqual(rec.jobs[0].argv, wantArgv) {
		t.Errorf("job argv = %q, want %q", rec.jobs[0].argv, wantArgv)
	}
	if len(rec.spawnArgs) != 0 {
		t.Errorf("spawned the session with no binary: %v", rec.spawnArgs)
	}
}

func TestEnsureOpenAIMCPStartsManagedBinary(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_0123456789abcdef0123456789abcdef")
	rec := withOpenAIMCPSeams(t, false, "/usr/bin/tunnel-client")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	bin := installManagedTunnelClient(t, rec.layout)
	if err := os.WriteFile(rec.layout.HealthURLPath(), []byte("http://127.0.0.1:1\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	outcome, err := ensureOpenAIMCPCore(openAIMCPDaemonStart)
	if err != nil || outcome != OpenAIMCPEnsureStarted {
		t.Fatalf("ensure = %v, %v; want started", outcome, err)
	}
	want := []string{
		"new-session", "-d", "-s", OpenAIMCPSessionName, "-n", OpenAIMCPWindowName,
		"env", "-u", "CONTROL_PLANE_API_KEY", "-u", "OPENAI_API_KEY",
		bin, "run", "--profile-dir", rec.layout.ProfileDir(), "--profile", openaimcp.ProfileName,
	}
	if len(rec.spawnArgs) != 1 || !reflect.DeepEqual(rec.spawnArgs[0], want) {
		t.Fatalf("spawn args = %q\nwant %q", rec.spawnArgs, want)
	}
	profile, err := os.ReadFile(rec.layout.ProfilePath())
	if err != nil {
		t.Fatalf("profile not written: %v", err)
	}
	for _, s := range []string{`tunnel_id: "tunnel_0123456789abcdef0123456789abcdef"`, `url: "http://127.0.0.1:6123/mcp"`} {
		if !strings.Contains(string(profile), s) {
			t.Errorf("profile missing %s:\n%s", s, profile)
		}
	}
	if _, err := os.Stat(rec.layout.HealthURLPath()); !os.IsNotExist(err) {
		t.Errorf("stale health.url survived the spawn (stat err %v)", err)
	}
	if strings.Contains(strings.Join(rec.spawnArgs[0], " "), testOpenAIKey) {
		t.Error("the key leaked into the spawn argv")
	}
}

func TestEnsureOpenAIMCPFallsBackToPath(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, false, "/home/linuxbrew/.linuxbrew/bin/tunnel-client")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	if _, err := ensureOpenAIMCPCore(openAIMCPDaemonStart); err != nil {
		t.Fatal(err)
	}
	if len(rec.spawnArgs) != 1 || !contains(rec.spawnArgs[0], "/home/linuxbrew/.linuxbrew/bin/tunnel-client") {
		t.Errorf("spawn args = %q, want the PATH binary", rec.spawnArgs)
	}
}

func TestEnsureOpenAIMCPMapsUnspecifiedBindToLoopback(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, false, "/usr/bin/tunnel-client")
	t.Setenv("RK_HOST", "0.0.0.0")
	t.Setenv("RK_PORT", "7001")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	if _, err := ensureOpenAIMCPCore(openAIMCPDaemonStart); err != nil {
		t.Fatal(err)
	}
	profile, _ := os.ReadFile(rec.layout.ProfilePath())
	if !strings.Contains(string(profile), `url: "http://127.0.0.1:7001/mcp"`) {
		t.Errorf("profile MCP URL not mapped to loopback:\n%s", profile)
	}
}

func TestKillOpenAIMCPSession(t *testing.T) {
	t.Run("absent session is a no-op", func(t *testing.T) {
		rec := withOpenAIMCPSeams(t, false, "")
		killed, err := KillOpenAIMCPSession()
		if err != nil || killed || len(rec.killArgs) != 0 {
			t.Errorf("kill = %v, %v, args %v; want no-op", killed, err, rec.killArgs)
		}
	})
	t.Run("live session is killed by exact target", func(t *testing.T) {
		rec := withOpenAIMCPSeams(t, true, "")
		if err := os.MkdirAll(rec.layout.Root, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(rec.layout.HealthURLPath(), []byte("http://127.0.0.1:1\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		killed, err := KillOpenAIMCPSession()
		if err != nil || !killed {
			t.Fatalf("kill = %v, %v", killed, err)
		}
		want := []string{"kill-session", "-t", "=" + OpenAIMCPSessionName}
		if len(rec.killArgs) != 1 || !reflect.DeepEqual(rec.killArgs[0], want) {
			t.Errorf("kill args = %q, want %q", rec.killArgs, want)
		}
		if _, err := os.Stat(rec.layout.HealthURLPath()); !os.IsNotExist(err) {
			t.Errorf("health.url survived the kill (stat err %v)", err)
		}
	})
}

func TestRestartOpenAIMCP(t *testing.T) {
	t.Run("refuses while off", func(t *testing.T) {
		withOpenAIMCPSetting(t, false, "tunnel_abc123")
		rec := withOpenAIMCPSeams(t, true, "/usr/bin/tunnel-client")
		if err := RestartOpenAIMCP(); err == nil {
			t.Error("restart while off = nil error")
		}
		if len(rec.killArgs) != 0 || len(rec.spawnArgs) != 0 {
			t.Errorf("restart while off touched tmux: kills %v, spawns %v", rec.killArgs, rec.spawnArgs)
		}
	})
	t.Run("never spawns with the daemon down", func(t *testing.T) {
		withOpenAIMCPSetting(t, true, "tunnel_abc123")
		rec := withOpenAIMCPSeams(t, false, "/usr/bin/tunnel-client")
		if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
			t.Fatal(err)
		}
		jobDaemonRunning = func(context.Context) bool { return false }
		if err := RestartOpenAIMCP(); err == nil || !strings.Contains(err.Error(), "rk serve -d") {
			t.Errorf("restart with the daemon down = %v, want the daemon error", err)
		}
		if len(rec.spawnArgs) != 0 {
			t.Errorf("spawned with the daemon down: %v", rec.spawnArgs)
		}
	})
	t.Run("kills then spawns while on", func(t *testing.T) {
		withOpenAIMCPSetting(t, true, "tunnel_abc123")
		rec := withOpenAIMCPSeams(t, false, "/usr/bin/tunnel-client")
		if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
			t.Fatal(err)
		}
		live := true
		openAIMCPSessionExists = func(context.Context) bool { v := live; live = false; return v }
		if err := RestartOpenAIMCP(); err != nil {
			t.Fatalf("restart: %v", err)
		}
		if len(rec.killArgs) != 1 || len(rec.spawnArgs) != 1 {
			t.Errorf("restart = %d kills, %d spawns; want 1 each", len(rec.killArgs), len(rec.spawnArgs))
		}
	})
}

func TestClassifyOpenAIMCP(t *testing.T) {
	configured := openAIMCPProbe{enabled: true, tunnelIDSet: true, keySet: true}
	cases := []struct {
		name   string
		probe  openAIMCPProbe
		state  string
		detail string
	}{
		{"off", openAIMCPProbe{tunnelIDSet: true, keySet: true}, OpenAIMCPStateOff, ""},
		{"no tunnel", openAIMCPProbe{enabled: true, keySet: true}, OpenAIMCPStateUnconfigured, "tunnel ID"},
		{"no key", openAIMCPProbe{enabled: true, tunnelIDSet: true}, OpenAIMCPStateUnconfigured, "API key"},
		{"installing", with(configured, func(p *openAIMCPProbe) { p.installing = true }), OpenAIMCPStateInstalling, ""},
		{"stopped", configured, OpenAIMCPStateStopped, ""},
		{"stopped, not installed", with(configured, func(p *openAIMCPProbe) { p.binaryMissing = true }), OpenAIMCPStateStopped, "rk openai-mcp install"},
		{"starting, no health url", with(configured, func(p *openAIMCPProbe) { p.session = true }), OpenAIMCPStateStarting, ""},
		{"starting, health unreachable", with(configured, func(p *openAIMCPProbe) {
			p.session = true
			p.healthURL = "http://x"
			p.readyErr = errors.New("refused")
		}), OpenAIMCPStateStarting, ""},
		{"ready", with(configured, func(p *openAIMCPProbe) { p.session = true; p.healthURL = "http://x"; p.readyStatus = 200 }), OpenAIMCPStateReady, ""},
		{"degraded", with(configured, func(p *openAIMCPProbe) {
			p.session = true
			p.healthURL = "http://x"
			p.readyStatus = 503
			p.readyBody = "startup catalog pending\nmore"
		}), OpenAIMCPStateDegraded, "startup catalog pending"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := classifyOpenAIMCP(c.probe)
			if got.State != c.state {
				t.Errorf("state = %q, want %q", got.State, c.state)
			}
			if c.detail != "" && !strings.Contains(got.Detail, c.detail) {
				t.Errorf("detail = %q, want containing %q", got.Detail, c.detail)
			}
			if c.state == OpenAIMCPStateDegraded && strings.Contains(got.Detail, "more") {
				t.Errorf("detail = %q, want only the first line", got.Detail)
			}
			if got.Enabled != c.probe.enabled || got.TunnelIDSet != c.probe.tunnelIDSet || got.KeySet != c.probe.keySet {
				t.Errorf("flags = %+v, want those of the probe", got)
			}
		})
	}
}

func with(p openAIMCPProbe, f func(*openAIMCPProbe)) openAIMCPProbe {
	f(&p)
	return p
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

// TestProbeOpenAIMCPReadsHealthURL drives the gathering path end to end over
// a real HTTP listener: the session exists, health.url names the listener,
// and /readyz decides ready versus degraded.
func TestProbeOpenAIMCPReadsHealthURL(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, true, "/usr/bin/tunnel-client")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	origJob := openAIMCPInstallJobLive
	t.Cleanup(func() { openAIMCPInstallJobLive = origJob })
	openAIMCPInstallJobLive = func(context.Context) bool { return false }

	ready := true
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/readyz" {
			http.NotFound(w, r)
			return
		}
		if ready {
			io.WriteString(w, "ready")
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		io.WriteString(w, "startup catalog pending")
	}))
	defer ts.Close()
	if err := os.WriteFile(rec.layout.HealthURLPath(), []byte(ts.URL+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := ProbeOpenAIMCP(context.Background()); got.State != OpenAIMCPStateReady {
		t.Errorf("state = %+v, want ready", got)
	}
	ready = false
	got := ProbeOpenAIMCP(context.Background())
	if got.State != OpenAIMCPStateDegraded || got.Detail != "startup catalog pending" {
		t.Errorf("state = %+v, want degraded with the readyz body", got)
	}
}

// TestProbeOpenAIMCPGatesTmuxOnDaemon: with the connector configured but no
// rk-daemon session (a foreground `rk serve`), the probe touches no tmux and
// says why the connector is not running.
func TestProbeOpenAIMCPGatesTmuxOnDaemon(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, true, "/usr/bin/tunnel-client")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	origUp, origJob := jobDaemonRunning, openAIMCPInstallJobLive
	t.Cleanup(func() { jobDaemonRunning, openAIMCPInstallJobLive = origUp, origJob })
	jobDaemonRunning = func(context.Context) bool { return false }
	jobProbes := 0
	openAIMCPInstallJobLive = func(context.Context) bool { jobProbes++; return false }

	got := ProbeOpenAIMCP(context.Background())
	if rec.existsProbes != 0 || jobProbes != 0 {
		t.Errorf("tmux probed with the daemon down: session probes %d, job probes %d", rec.existsProbes, jobProbes)
	}
	if got.State != OpenAIMCPStateStopped || !strings.Contains(got.Detail, "daemon") {
		t.Errorf("status = %+v, want stopped naming the daemon", got)
	}
}

func TestEnsureOpenAIMCPFromDaemonInstallsWhenMissing(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, false, "")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	outcome, err := EnsureOpenAIMCPFromDaemon()
	if err != nil || outcome != OpenAIMCPEnsureInstallJobSpawned {
		t.Fatalf("ensure from daemon = %v, %v; want the install job, no error", outcome, err)
	}
	if len(rec.jobs) != 1 || rec.jobs[0].window != OpenAIMCPInstallJobWindow {
		t.Errorf("jobs = %+v, want one install job", rec.jobs)
	}
	if _, err := EnsureOpenAIMCP(); !errors.Is(err, errOpenAIMCPMissing) {
		t.Errorf("CLI ensure err = %v, want errOpenAIMCPMissing (the CLI stays strict)", err)
	}
}

func TestRestartOpenAIMCPInstallsWhenMissing(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, false, "")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	if err := RestartOpenAIMCP(); err != nil {
		t.Fatalf("restart with no binary = %v, want the install job instead of an error", err)
	}
	if len(rec.jobs) != 1 {
		t.Errorf("jobs = %+v, want one install job", rec.jobs)
	}
}

func TestEnsureOpenAIMCPRestartsOnProfileChange(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, true, "/usr/bin/tunnel-client")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	if _, err := rec.layout.WriteProfile(openaimcp.ProfileInput{TunnelID: "tunnel_abc123", MCPURL: "http://127.0.0.1:6123/mcp"}); err != nil {
		t.Fatal(err)
	}

	if outcome, err := ensureOpenAIMCPCore(openAIMCPFromDaemon); err != nil || outcome != OpenAIMCPEnsureAlreadyRunning {
		t.Fatalf("unchanged profile = %v, %v; want already running", outcome, err)
	}
	if len(rec.killArgs) != 0 || len(rec.spawnArgs) != 0 {
		t.Fatalf("unchanged profile touched the session: kills %v spawns %v", rec.killArgs, rec.spawnArgs)
	}

	t.Setenv("RK_PORT", "7001")
	if outcome, err := ensureOpenAIMCPCore(openAIMCPFromCLI); err != nil || outcome != OpenAIMCPEnsureAlreadyRunning || len(rec.killArgs) != 0 {
		t.Fatalf("CLI posture with a changed port = %v, %v, kills %v; want it to leave the running session alone", outcome, err, rec.killArgs)
	}

	outcome, err := ensureOpenAIMCPCore(openAIMCPFromDaemon)
	if err != nil || outcome != OpenAIMCPEnsureStarted {
		t.Fatalf("changed profile = %v, %v; want restarted", outcome, err)
	}
	if len(rec.killArgs) != 1 || len(rec.spawnArgs) != 1 {
		t.Errorf("changed profile: kills %d, spawns %d; want 1 each", len(rec.killArgs), len(rec.spawnArgs))
	}
	profile, _ := os.ReadFile(rec.layout.ProfilePath())
	if !strings.Contains(string(profile), "127.0.0.1:7001/mcp") {
		t.Errorf("profile not rewritten to the new port:\n%s", profile)
	}
}

func TestRestartOpenAIMCPGatesBeforeTouchingTmux(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, true, "/usr/bin/tunnel-client")
	jobDaemonRunning = func(context.Context) bool { return false }
	if err := RestartOpenAIMCP(); err == nil {
		t.Error("restart with the daemon down = nil error")
	}
	if rec.existsProbes != 0 || len(rec.killArgs) != 0 {
		t.Errorf("tmux touched before the gate: probes %d, kills %v", rec.existsProbes, rec.killArgs)
	}
}

func TestReconcileOpenAIMCP(t *testing.T) {
	t.Run("kills a session the settings turned off", func(t *testing.T) {
		withOpenAIMCPSetting(t, false, "tunnel_abc123")
		rec := withOpenAIMCPSeams(t, true, "")
		if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
			t.Fatal(err)
		}
		killed, err := ReconcileOpenAIMCP()
		if err != nil || !killed || len(rec.killArgs) != 1 {
			t.Errorf("reconcile = %v, %v, kills %v; want the stray session killed", killed, err, rec.killArgs)
		}
	})
	t.Run("kills a session whose key was removed", func(t *testing.T) {
		withOpenAIMCPSetting(t, true, "tunnel_abc123")
		rec := withOpenAIMCPSeams(t, true, "")
		if killed, _ := ReconcileOpenAIMCP(); !killed || len(rec.killArgs) != 1 {
			t.Errorf("reconcile with no key: killed %v, kills %v", killed, rec.killArgs)
		}
	})
	t.Run("leaves an allowed session alone", func(t *testing.T) {
		withOpenAIMCPSetting(t, true, "tunnel_abc123")
		rec := withOpenAIMCPSeams(t, true, "")
		if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
			t.Fatal(err)
		}
		if killed, _ := ReconcileOpenAIMCP(); killed || rec.existsProbes != 0 || len(rec.killArgs) != 0 {
			t.Errorf("allowed: killed %v, probes %d, kills %v; want no tmux at all", killed, rec.existsProbes, rec.killArgs)
		}
	})
	t.Run("touches no tmux with the daemon down", func(t *testing.T) {
		withOpenAIMCPSetting(t, false, "")
		rec := withOpenAIMCPSeams(t, true, "")
		jobDaemonRunning = func(context.Context) bool { return false }
		if killed, _ := ReconcileOpenAIMCP(); killed || rec.existsProbes != 0 {
			t.Errorf("daemon down: killed %v, probes %d", killed, rec.existsProbes)
		}
	})
}

// TestWatchOpenAIMCPSettingsReconcilesHandEdit: with no UI connected (the hub
// idle), a hand edit that turns the connector off still stops the running
// tunnel-client within one watch interval.
func TestWatchOpenAIMCPSettingsReconcilesHandEdit(t *testing.T) {
	withOpenAIMCPSetting(t, true, "tunnel_abc123")
	rec := withOpenAIMCPSeams(t, true, "")
	if err := rec.layout.WriteKey(testOpenAIKey); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	kills := 0
	openAIMCPKillRun = func(_ context.Context, args ...string) error {
		mu.Lock()
		kills++
		mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { WatchOpenAIMCPSettings(ctx, 20*time.Millisecond); close(done) }()

	time.Sleep(80 * time.Millisecond)
	mu.Lock()
	if kills != 0 {
		t.Fatalf("killed %d times with the settings unchanged", kills)
	}
	mu.Unlock()

	path := filepath.Join(os.Getenv("RK_CONFIG_DIR"), "config.yaml")
	if err := os.WriteFile(path, []byte("openai_mcp.tunnel_id: \"tunnel_abc123\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := kills
		mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("kills = %d after the hand edit, want 1", n)
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
}
