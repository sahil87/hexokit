package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rk/internal/daemon"
	"rk/internal/openaimcp"

	"github.com/spf13/cobra"
)

// withOpenAIMCPCLISeams points the CLI's layout/installer/start/restart seams
// at a temp layout and (optionally) an httptest release server.
func withOpenAIMCPCLISeams(t *testing.T, srv *httptest.Server) openaimcp.Layout {
	t.Helper()
	layout := openaimcp.Layout{Root: t.TempDir()}
	origLayout, origInstaller, origStart, origRestart := openAIMCPLayoutCLIFn, newOpenAIMCPInstallerFn, openAIMCPStartFn, openAIMCPRestartCLIFn
	t.Cleanup(func() {
		openAIMCPLayoutCLIFn, newOpenAIMCPInstallerFn, openAIMCPStartFn, openAIMCPRestartCLIFn = origLayout, origInstaller, origStart, origRestart
	})
	openAIMCPLayoutCLIFn = func() (openaimcp.Layout, error) { return layout, nil }
	openAIMCPStartFn = func() (daemon.OpenAIMCPEnsureOutcome, error) {
		t.Fatal("start seam not stubbed for this test")
		return 0, nil
	}
	openAIMCPRestartCLIFn = func() error {
		t.Fatal("restart seam not stubbed for this test")
		return nil
	}
	if srv != nil {
		newOpenAIMCPInstallerFn = func() *openaimcp.Installer {
			ins := openaimcp.NewInstaller()
			ins.Client = srv.Client()
			ins.APIBase = srv.URL
			ins.GOOS, ins.GOARCH = "linux", "amd64"
			return ins
		}
	}
	return layout
}

// tcReleaseServer serves one tunnel-client release with a digest-correct zip.
func tcReleaseServer(t *testing.T, version string) *httptest.Server {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	h := &zip.FileHeader{Name: openaimcp.BinaryName}
	h.SetMode(0o755)
	w, _ := zw.CreateHeader(h)
	w.Write([]byte("#!/bin/sh\n"))
	zw.Close()
	body := buf.Bytes()
	sum := sha256.Sum256(body)
	asset := "tunnel-client-v" + version + "-linux-amd64.zip"
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/" + openaimcp.Repo + "/releases/latest":
			json.NewEncoder(w).Encode(map[string]any{
				"tag_name": "v" + version,
				"assets": []map[string]string{{
					"name": asset, "browser_download_url": srv.URL + "/dl", "digest": "sha256:" + hex.EncodeToString(sum[:]),
				}},
			})
		case "/dl":
			w.Write(body)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestOpenAIMCPTreeRegistered(t *testing.T) {
	var parent *cobra.Command
	for _, c := range rootCmd.Commands() {
		if c.Name() == "openai-mcp" {
			parent = c
		}
	}
	if parent == nil {
		t.Fatal("rk openai-mcp is not registered on rootCmd")
	}
	if parent.Long == "" {
		t.Error("parent command has no Long block")
	}
	want := map[string]bool{"install": false, "start": false, "restart": false}
	for _, c := range parent.Commands() {
		if _, ok := want[c.Name()]; ok {
			want[c.Name()] = true
			if c.Long == "" {
				t.Errorf("%s has no Long block", c.Name())
			}
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("subcommand %q not registered", name)
		}
	}
}

func TestOpenAIMCPArgValidationIsUsageClass(t *testing.T) {
	for _, c := range openAIMCPCmd.Commands() {
		if err := c.Args(c, []string{"extra"}); err == nil {
			t.Errorf("%s accepted a positional arg", c.Name())
		} else if code := exitCode(err); code != exitUsage {
			t.Errorf("%s arg violation exit code = %d, want %d (usage)", c.Name(), code, exitUsage)
		}
	}
}

func TestOpenAIMCPInstallOutcomeLines(t *testing.T) {
	srv := tcReleaseServer(t, "0.0.19")
	layout := withOpenAIMCPCLISeams(t, srv)

	var out bytes.Buffer
	if err := runOpenAIMCPInstall(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Installed tunnel-client v0.0.19") {
		t.Errorf("stdout = %q, want the installed line", out.String())
	}
	if v, _ := layout.InstalledVersion(); v != "0.0.19" {
		t.Errorf("installed version = %q", v)
	}

	out.Reset()
	if err := runOpenAIMCPInstall(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "already current") {
		t.Errorf("second install stdout = %q, want the already-current line", out.String())
	}
}

func TestOpenAIMCPStartOutcomeLines(t *testing.T) {
	cases := []struct {
		outcome daemon.OpenAIMCPEnsureOutcome
		want    string
	}{
		{daemon.OpenAIMCPEnsureStarted, "Started the ChatGPT connector"},
		{daemon.OpenAIMCPEnsureAlreadyRunning, "already running"},
		{daemon.OpenAIMCPEnsureDisabled, "is off"},
	}
	for _, c := range cases {
		withOpenAIMCPCLISeams(t, nil)
		openAIMCPStartFn = func() (daemon.OpenAIMCPEnsureOutcome, error) { return c.outcome, nil }
		var out bytes.Buffer
		if err := runOpenAIMCPStart(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
			t.Fatalf("outcome %v: %v", c.outcome, err)
		}
		if !strings.Contains(out.String(), c.want) {
			t.Errorf("outcome %v: stdout = %q, want containing %q", c.outcome, out.String(), c.want)
		}
	}
}

func TestOpenAIMCPStartAndRestartPropagateErrors(t *testing.T) {
	withOpenAIMCPCLISeams(t, nil)
	openAIMCPStartFn = func() (daemon.OpenAIMCPEnsureOutcome, error) {
		return daemon.OpenAIMCPEnsureUnconfigured, errors.New("no API key saved")
	}
	err := runOpenAIMCPStart(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil || !strings.Contains(err.Error(), "no API key saved") || exitCode(err) != 1 {
		t.Errorf("start err = %v (exit %d), want the cause as an operational error", err, exitCode(err))
	}

	openAIMCPRestartCLIFn = func() error { return errors.New("the ChatGPT connector is off") }
	err = runOpenAIMCPRestart(bareCmd(&bytes.Buffer{}, &bytes.Buffer{}), nil)
	if err == nil || exitCode(err) != 1 {
		t.Errorf("restart err = %v (exit %d), want an operational error", err, exitCode(err))
	}

	openAIMCPRestartCLIFn = func() error { return nil }
	var out bytes.Buffer
	if err := runOpenAIMCPRestart(bareCmd(&out, &bytes.Buffer{}), nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Restarted the ChatGPT connector") {
		t.Errorf("restart stdout = %q", out.String())
	}
}

func TestOpenAIMCPCheckNotes(t *testing.T) {
	cases := []struct {
		st   daemon.OpenAIMCPStatus
		want string
	}{
		{daemon.OpenAIMCPStatus{State: daemon.OpenAIMCPStateOff}, "off"},
		{daemon.OpenAIMCPStatus{Enabled: true, State: daemon.OpenAIMCPStateUnconfigured, Detail: "save an API key"}, "on: unconfigured, save an API key (Settings → ChatGPT connector)"},
		{daemon.OpenAIMCPStatus{Enabled: true, State: daemon.OpenAIMCPStateInstalling}, "on: installing tunnel-client (rk-jobs window openai-mcp-install)"},
		{daemon.OpenAIMCPStatus{Enabled: true, State: daemon.OpenAIMCPStateStopped}, "on: not running (rk openai-mcp start)"},
		{daemon.OpenAIMCPStatus{Enabled: true, State: daemon.OpenAIMCPStateStopped, Detail: "tunnel-client is not installed (rk openai-mcp install)"}, "on: not running, tunnel-client is not installed (rk openai-mcp install)"},
		{daemon.OpenAIMCPStatus{Enabled: true, State: daemon.OpenAIMCPStateStarting}, "on: starting"},
		{daemon.OpenAIMCPStatus{Enabled: true, State: daemon.OpenAIMCPStateReady}, "on: ready (rk-openai-mcp session)"},
		{daemon.OpenAIMCPStatus{Enabled: true, State: daemon.OpenAIMCPStateDegraded, Detail: "startup catalog pending"}, "on: degraded, startup catalog pending"},
	}
	for _, c := range cases {
		got := openAIMCPCheck(c.st)
		if got.Name != "openai-mcp" || !got.OK || got.Note != c.want {
			t.Errorf("openAIMCPCheck(%s) = %+v, want OK note %q", c.st.State, got, c.want)
		}
	}
}

func TestOpenAIMCPDoctorCheckGatesTmuxOnDaemon(t *testing.T) {
	t.Setenv("RK_CONFIG_DIR", t.TempDir())
	origUp, origProbe := openAIMCPDaemonRunningFn, openAIMCPProbeDoctorFn
	t.Cleanup(func() { openAIMCPDaemonRunningFn, openAIMCPProbeDoctorFn = origUp, origProbe })
	probes := 0
	openAIMCPProbeDoctorFn = func(context.Context) daemon.OpenAIMCPStatus {
		probes++
		return daemon.OpenAIMCPStatus{Enabled: true, State: daemon.OpenAIMCPStateReady}
	}

	openAIMCPDaemonRunningFn = func() bool { t.Fatal("daemon probed while the connector is off"); return false }
	if got := openAIMCPDoctorCheck(); got.Note != "off" || probes != 0 {
		t.Errorf("off: %+v, probes %d", got, probes)
	}

	writeOpenAIMCPSettings(t, "openai_mcp.enabled: true\n")
	openAIMCPDaemonRunningFn = func() bool { return false }
	if got := openAIMCPDoctorCheck(); !strings.Contains(got.Note, "rk serve -d") || probes != 0 {
		t.Errorf("daemon down: %+v, probes %d; want a daemon note and no tmux probe", got, probes)
	}

	openAIMCPDaemonRunningFn = func() bool { return true }
	if got := openAIMCPDoctorCheck(); got.Note != "on: ready (rk-openai-mcp session)" || probes != 1 {
		t.Errorf("daemon up: %+v, probes %d", got, probes)
	}
}

func writeOpenAIMCPSettings(t *testing.T, body string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("RK_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
