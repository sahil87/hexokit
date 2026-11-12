package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"rk/internal/daemon"
	"rk/internal/daemon/autostart"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// fakeAutostart records the verb it served and returns canned outcomes, so
// the CLI is tested without any service manager.
type fakeAutostart struct {
	onOpts []autostart.OnOptions
	result autostart.Result
	status autostart.Status
	err    error
}

func (f *fakeAutostart) On(_ context.Context, o autostart.OnOptions) (autostart.Result, error) {
	f.onOpts = append(f.onOpts, o)
	return f.result, f.err
}
func (f *fakeAutostart) Off(context.Context) (autostart.Result, error)    { return f.result, f.err }
func (f *fakeAutostart) Status(context.Context) (autostart.Status, error) { return f.status, f.err }

func withFakeAutostart(t *testing.T, f *fakeAutostart) {
	t.Helper()
	orig := autostartBackendFn
	autostartBackendFn = func() (autostart.Backend, error) { return f, nil }
	t.Cleanup(func() { autostartBackendFn = orig })
}

// runAutostartRoot executes rootCmd with args, resetting the given commands'
// flags before the run and at cleanup, because cobra keeps parsed flag values
// on the shared command tree between Execute calls.
func runAutostartRoot(t *testing.T, reset []*cobra.Command, args ...string) (string, error) {
	t.Helper()
	resetFlags := func() {
		for _, c := range reset {
			c.Flags().VisitAll(func(f *pflag.Flag) { _ = f.Value.Set(f.DefValue); f.Changed = false })
		}
	}
	resetFlags()
	buf := new(bytes.Buffer)
	rootCmd.SetOut(buf)
	rootCmd.SetErr(new(bytes.Buffer))
	rootCmd.SetArgs(args)
	t.Cleanup(func() {
		rootCmd.SetArgs(nil)
		resetFlags()
	})
	err := rootCmd.Execute()
	return buf.String(), err
}

var autostartVerbCmds = []*cobra.Command{daemonAutostartOnCmd, daemonAutostartOffCmd, daemonAutostartStatusCmd}

func TestDaemonAutostartRegistered(t *testing.T) {
	dCmd := findChildCmd(rootCmd, "daemon")
	a := findChildCmd(dCmd, "autostart")
	if a == nil {
		t.Fatal("daemon has no 'autostart' subcommand")
	}
	for _, want := range []string{"on", "off", "status"} {
		c := findChildCmd(a, want)
		if c == nil {
			t.Errorf("autostart subcommand %q not registered", want)
			continue
		}
		if c.Flags().Lookup("json") == nil {
			t.Errorf("autostart %s has no --json flag", want)
		}
	}
	now := daemonAutostartOnCmd.Flags().Lookup("now")
	if now == nil || now.DefValue != "false" {
		t.Errorf("autostart on --now flag = %+v, want default false", now)
	}
}

func TestDaemonAutostartOn_PassesNow(t *testing.T) {
	f := &fakeAutostart{result: autostart.Result{Name: "lbl", Path: "/p", Changed: true, Started: true}}
	withFakeAutostart(t, f)

	out, err := runAutostartRoot(t, autostartVerbCmds, "daemon", "autostart", "on", "--now")
	if err != nil {
		t.Fatalf("autostart on --now: %v", err)
	}
	if len(f.onOpts) != 1 || !f.onOpts[0].Now {
		t.Errorf("On called with %+v, want one call with Now=true", f.onOpts)
	}
	if !strings.Contains(out, "Autostart on: lbl (/p)") || !strings.Contains(out, "Daemon start requested") {
		t.Errorf("text output = %q", out)
	}
}

func TestDaemonAutostartOn_DefaultIsRegisterOnly(t *testing.T) {
	f := &fakeAutostart{result: autostart.Result{Name: "lbl", Path: "/p"}}
	withFakeAutostart(t, f)

	out, err := runAutostartRoot(t, autostartVerbCmds, "daemon", "autostart", "on")
	if err != nil {
		t.Fatalf("autostart on: %v", err)
	}
	if len(f.onOpts) != 1 || f.onOpts[0].Now {
		t.Errorf("On called with %+v, want one call with Now=false", f.onOpts)
	}
	if !strings.Contains(out, "Autostart already on") {
		t.Errorf("unchanged result should read as already on, got %q", out)
	}
}

func TestDaemonAutostartOff_JSON(t *testing.T) {
	f := &fakeAutostart{result: autostart.Result{Name: "lbl", Path: "/p", Changed: true}}
	withFakeAutostart(t, f)

	out, err := runAutostartRoot(t, autostartVerbCmds, "daemon", "autostart", "off", "--json")
	if err != nil {
		t.Fatalf("autostart off --json: %v", err)
	}
	var got autostart.Result
	unwrapEnvelopeResult(t, out, &got)
	if got.Name != "lbl" || !got.Changed {
		t.Errorf("result = %+v", got)
	}
}

func TestDaemonAutostartStatus_JSONAndText(t *testing.T) {
	code := 0
	linger := false
	f := &fakeAutostart{status: autostart.Status{
		Platform: "linux", Manager: "systemd", Name: "u", Path: "/u",
		Registered: true, Enabled: true, StartsAt: autostart.StartsAtLogin,
		Linger: &linger, LastExitCode: &code, LastResult: "success",
		RKPath: "/bin/rk", Shell: "/bin/bash", Stale: true,
		Hints: []string{"first hint", "second hint"},
	}}
	withFakeAutostart(t, f)

	out, err := runAutostartRoot(t, autostartVerbCmds, "daemon", "autostart", "status", "--json")
	if err != nil {
		t.Fatalf("status --json: %v", err)
	}
	var raw map[string]any
	var doc struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if err := json.Unmarshal(doc.Result, &raw); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	for _, key := range []string{"starts_at", "last_exit_code", "rk_path", "shell", "stale", "linger"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("status JSON lacks snake_case key %q: %s", key, doc.Result)
		}
	}

	text, err := runAutostartRoot(t, autostartVerbCmds, "daemon", "autostart", "status")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	for _, want := range []string{"Autostart: on (login only — enable lingering for boot)", "(stale)", "Linger:  off", "exit 0 (success)", "Hint: first hint\n", "Hint: second hint\n"} {
		if !strings.Contains(text, want) {
			t.Errorf("status text lacks %q:\n%s", want, text)
		}
	}
}

func TestDaemonAutostartStatus_NilLingerPrintsNothing(t *testing.T) {
	withFakeAutostart(t, &fakeAutostart{status: autostart.Status{Manager: "launchd", Name: "l", Path: "/l"}})

	text, err := runAutostartRoot(t, autostartVerbCmds, "daemon", "autostart", "status")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if strings.Contains(text, "Linger") {
		t.Errorf("nil Linger rendered a line:\n%s", text)
	}
	if !strings.Contains(text, "Autostart: off") || !strings.Contains(text, "(absent)") {
		t.Errorf("unregistered status text = %q", text)
	}
}

func TestDaemonAutostart_UnsupportedPlatformErrors(t *testing.T) {
	orig := autostartGOOS
	autostartGOOS = "windows"
	t.Cleanup(func() { autostartGOOS = orig })

	out, err := runAutostartRoot(t, autostartVerbCmds, "daemon", "autostart", "status", "--json")
	if err == nil {
		t.Fatal("status on windows returned nil error")
	}
	if !strings.Contains(err.Error(), "not supported on windows") {
		t.Errorf("error = %q", err)
	}
	if !strings.Contains(out, `"ok": false`) {
		t.Errorf("--json failure did not write the error envelope: %s", out)
	}
}

func TestDaemonStart_IfNotRunning(t *testing.T) {
	reset := []*cobra.Command{daemonStartCmd}
	tests := []struct {
		name    string
		args    []string
		startEr error
		wantErr bool
		wantOut string
	}{
		{"already running is success", []string{"daemon", "start", "--if-not-running"}, daemon.ErrAlreadyRunning, false, "run-kit daemon already running"},
		{"other failure stays an error", []string{"daemon", "start", "--if-not-running"}, errors.New("tmux not found"), true, ""},
		{"without the flag already running is an error", []string{"daemon", "start"}, daemon.ErrAlreadyRunning, true, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			orig := daemonStartFn
			daemonStartFn = func() error { return tt.startEr }
			t.Cleanup(func() { daemonStartFn = orig })

			out, err := runAutostartRoot(t, reset, tt.args...)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if !strings.Contains(out, tt.wantOut) {
				t.Errorf("out = %q, want %q", out, tt.wantOut)
			}
		})
	}
}
